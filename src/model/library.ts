import { ontologyIriOf } from './prefixes';
import { normalizeModel, type Model } from './types';

/**
 * The local model library: ontology models saved in this browser's IndexedDB, so that they can
 * be reopened in a later session. Storage only: nothing here knows about the editor.
 *
 * Two object stores share the model's id as key. "models" holds what the list shows (name,
 * dates, counts), "data" holds the model itself, so that listing never has to load every model.
 */

/** What the list shows about a saved model. */
export interface SavedInfo {
  /** Internal id. Names are for people and may repeat; this never does. */
  id: string;
  name: string;
  created: number;
  modified: number;
  ontologyIri: string;
  /** Classes, properties and individuals. */
  entities: number;
  relations: number;
  /** Version of this record's layout, for upgrades by later versions of the app. */
  schema: number;
}

const DB_NAME = 'conceptweaver';
/** Version of the database layout (which stores exist). */
const DB_VERSION = 6;
/** Version of a record's layout (which fields it has). */
const RECORD_SCHEMA = 1;

let factory: IDBFactory | undefined;
/** Uses another IndexedDB implementation; the tests supply an in-memory one. */
export function useIndexedDb(f: IDBFactory | undefined) {
  factory = f;
}

const idb = () => {
  const f = factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  if (!f) throw new Error('This browser does not offer local storage for models (IndexedDB is unavailable).');
  return f;
};

/** A storage failure in words a person can act on. */
function explain(e: unknown): Error {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') return new Error('The browser has no storage space left for this site. Delete models you no longer need, or export this one to a file.');
  if (name === 'InvalidStateError' || name === 'SecurityError') return new Error('The browser is not allowing this site to store data (private browsing can do this). Export the model to a file instead.');
  return e instanceof Error ? e : new Error('The browser could not store the model.');
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(explain(req.error));
  });

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb().open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(explain(e));
      return;
    }
    // Each step brings the layout from one version to the next, so that a database made by any
    // earlier version of the app is brought up to date without losing what is in it.
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (ev.oldVersion < 1) {
        db.createObjectStore('models', { keyPath: 'id' });
        db.createObjectStore('data', { keyPath: 'id' });
      }
      // Version 2: the content of external ontologies, cached so that it is there in a later session.
      if (ev.oldVersion < 2) db.createObjectStore('externals', { keyPath: 'id' });
      // Version 3: the working copy, what is in the editor, kept as it is edited (it was one string in localStorage).
      if (ev.oldVersion < 3) db.createObjectStore('working', { keyPath: 'id' });
      // Version 4: the content of data graphs, which a model names (Model.dataGraphs) and SHACL validates.
      if (ev.oldVersion < 4) db.createObjectStore('datagraphs', { keyPath: 'id' });
      // Version 5: the named versions of the models in My Models, by the model they are of.
      if (ev.oldVersion < 5) db.createObjectStore('versions', { keyPath: 'id' }).createIndex('project', 'project');
      // Version 6: the assistant's conversation and proposals about each ontology, by the ontology's IRI.
      if (ev.oldVersion < 6) db.createObjectStore('assistant', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(explain(req.error));
    req.onblocked = () => reject(new Error('Another tab is using an older version of the app. Close it and try again.'));
  });
}

/** Runs one transaction over both stores and waits until it is safely written. */
async function tx<T>(mode: IDBTransactionMode, work: (models: IDBObjectStore, data: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    const t = db.transaction(['models', 'data'], mode);
    const finished = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(explain(t.error));
      t.onabort = () => reject(explain(t.error));
    });
    const result = await work(t.objectStore('models'), t.objectStore('data'));
    await finished;
    return result;
  } finally {
    db.close();
  }
}

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

function describe(model: Model): Pick<SavedInfo, 'ontologyIri' | 'entities' | 'relations'> {
  return { ontologyIri: ontologyIriOf(model), entities: model.terms.length + model.props.length, relations: model.relations.length };
}

/**
 * Brings a record written by an earlier version of the app up to the current layout. Returns
 * the same object when there is nothing to do.
 */
function upgrade(info: Partial<SavedInfo> & { id: string }, model: Model | undefined): SavedInfo {
  if (info.schema === RECORD_SCHEMA) return info as SavedInfo;
  const modified = info.modified ?? Date.now();
  return {
    id: info.id,
    name: info.name || model?.name || 'Untitled model',
    created: info.created ?? modified,
    modified,
    ...(model ? describe(model) : { ontologyIri: info.ontologyIri ?? '', entities: info.entities ?? 0, relations: info.relations ?? 0 }),
    schema: RECORD_SCHEMA,
  };
}

/** Every saved model, most recently modified first. */
export async function listModels(): Promise<SavedInfo[]> {
  // Read first; records in an older layout are then upgraded and written back.
  const raw = await tx('readonly', (models) => done(models.getAll() as IDBRequest<(Partial<SavedInfo> & { id: string })[]>));
  const stale = raw.filter((r) => r.schema !== RECORD_SCHEMA);
  if (stale.length) {
    await tx('readwrite', async (models, data) => {
      for (const r of stale) {
        const stored = (await done(data.get(r.id))) as { model?: unknown } | undefined;
        let model: Model | undefined;
        try {
          model = stored?.model ? normalizeModel(stored.model) : undefined;
        } catch {
          model = undefined;
        }
        Object.assign(r, upgrade(r, model));
        models.put(r);
      }
    });
  }
  return (raw as SavedInfo[]).sort((a, b) => b.modified - a.modified);
}

/**
 * Saves a model. With an `id` the stored model is replaced and keeps its creation date; without
 * one a new entry is made. The model's own name is the entry's name.
 */
export async function saveModel(model: Model, id?: string): Promise<SavedInfo> {
  const now = Date.now();
  return tx('readwrite', async (models, data) => {
    const before = id ? ((await done(models.get(id))) as SavedInfo | undefined) : undefined;
    const info: SavedInfo = { id: before?.id ?? id ?? newId(), name: model.name.trim() || 'Untitled model', created: before?.created ?? now, modified: now, ...describe(model), schema: RECORD_SCHEMA };
    models.put(info);
    data.put({ id: info.id, model });
    return info;
  });
}

/** The saved model, checked and brought up to the current model format; undefined if there is none with that id. */
export async function loadModel(id: string): Promise<{ info: SavedInfo; model: Model } | undefined> {
  const found = await tx('readonly', async (models, data) => ({ info: (await done(models.get(id))) as (Partial<SavedInfo> & { id: string }) | undefined, stored: (await done(data.get(id))) as { model?: unknown } | undefined }));
  if (!found.info || !found.stored?.model) return undefined;
  const model = normalizeModel(found.stored.model);
  return { info: upgrade(found.info, model), model };
}

/** Changes a saved model's name, in the list and in the model itself. */
export async function renameModel(id: string, name: string): Promise<SavedInfo | undefined> {
  const clean = name.trim();
  if (!clean) throw new Error('A model needs a name.');
  return tx('readwrite', async (models, data) => {
    const info = (await done(models.get(id))) as SavedInfo | undefined;
    const stored = (await done(data.get(id))) as { id: string; model: Model } | undefined;
    if (!info || !stored) return undefined;
    const next = { ...info, name: clean, modified: Date.now() };
    models.put(next);
    data.put({ id, model: { ...stored.model, name: clean } });
    return next;
  });
}

/** Makes an independent copy, named "… copy" (or "… copy 2" and so on if that is taken). */
export async function duplicateModel(id: string): Promise<SavedInfo | undefined> {
  const now = Date.now();
  return tx('readwrite', async (models, data) => {
    const info = (await done(models.get(id))) as SavedInfo | undefined;
    const stored = (await done(data.get(id))) as { id: string; model: Model } | undefined;
    if (!info || !stored) return undefined;
    const names = new Set(((await done(models.getAll())) as SavedInfo[]).map((m) => m.name));
    let name = `${info.name} copy`;
    for (let i = 2; names.has(name); i++) name = `${info.name} copy ${i}`;
    const copy: SavedInfo = { ...info, id: newId(), name, created: now, modified: now };
    models.put(copy);
    data.put({ id: copy.id, model: { ...stored.model, name } });
    return copy;
  });
}

/** Deletes a saved model, and its versions with it. */
export async function deleteModel(id: string): Promise<void> {
  await tx('readwrite', async (models, data) => {
    models.delete(id);
    data.delete(id);
  });
  await deleteVersions(id);
}

// ---------------------------------------------------------------- external ontologies

/** The cached content of an external ontology: the Turtle it was read from, under the id its reference has in a model. */
export interface CachedOntology {
  id: string;
  iri: string;
  text: string;
  cached: number;
}

/** Runs one transaction over one store and waits until it is safely written. */
async function single<T>(name: 'externals' | 'working' | 'datagraphs' | 'versions' | 'assistant', mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    const t = db.transaction([name], mode);
    const finished = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(explain(t.error));
      t.onabort = () => reject(explain(t.error));
    });
    const result = await work(t.objectStore(name));
    await finished;
    return result;
  } finally {
    db.close();
  }
}

const externals = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>) => single('externals', mode, work);

export const cacheOntology = (id: string, iri: string, text: string) => externals('readwrite', async (store) => void store.put({ id, iri, text, cached: Date.now() } satisfies CachedOntology));
export const cachedOntology = (id: string) => externals('readonly', (store) => done(store.get(id) as IDBRequest<CachedOntology | undefined>));
/** One cached under another id but with the same ontology IRI: the same ontology, added to another model. */
export const cachedOntologyByIri = (iri: string) => externals('readonly', async (store) => ((await done(store.getAll())) as CachedOntology[]).find((c) => c.iri === iri && !!iri));
export const uncacheOntology = (id: string) => externals('readwrite', async (store) => void store.delete(id));

// ---------------------------------------------------------------- data graphs

/**
 * The content of a data graph, as Turtle, under the id its reference has in a model. It is kept
 * when the reference goes, so that an undo finds it again, and so that a model saved before with
 * the same graph still has it.
 */
export interface KeptDataGraph {
  id: string;
  text: string;
  kept: number;
}

export const keepDataGraph = (id: string, text: string) => single('datagraphs', 'readwrite', async (store) => void store.put({ id, text, kept: Date.now() } satisfies KeptDataGraph));
export const keptDataGraph = (id: string) => single('datagraphs', 'readonly', async (store) => ((await done(store.get(id))) as KeptDataGraph | undefined)?.text);
/** Which of these data graphs have their content in this browser. */
export const dataGraphsKept = (ids: string[]) => single('datagraphs', 'readonly', async (store) => new Set(((await done(store.getAllKeys())) as string[]).filter((id) => ids.includes(id))));

// ---------------------------------------------------------------- versions

/**
 * A named version of a model in My Models: what it was called and why, when, a fingerprint of
 * what it states, and the model itself, compressed where the browser can (`packed`). Versions
 * are only ever added: restoring one adds another.
 */
export interface StoredVersion {
  id: string;
  /** The saved model it is a version of. */
  project: string;
  /** 1, 2, 3, … for that model. */
  seq: number;
  name: string;
  summary: string;
  created: number;
  /** A fingerprint of what the ontology and the shapes state: equal fingerprints, equal content. */
  hash: string;
  entities: number;
  /** The model, as gzip-compressed JSON or as JSON. */
  packed: 'gzip' | 'json';
  data: ArrayBuffer | string;
}

export const putVersion = (v: StoredVersion) => single('versions', 'readwrite', async (store) => void store.put(v));
export const storedVersion = (id: string) => single('versions', 'readonly', (store) => done(store.get(id) as IDBRequest<StoredVersion | undefined>));
/** The versions of a model, oldest first. */
export const storedVersions = (project: string) => single('versions', 'readonly', async (store) => ((await done(store.index('project').getAll(project))) as StoredVersion[]).sort((a, b) => a.seq - b.seq));
export const deleteVersions = (project: string) =>
  single('versions', 'readwrite', async (store) => {
    for (const key of (await done(store.index('project').getAllKeys(project))) as string[]) store.delete(key);
  });

// ---------------------------------------------------------------- the assistant

/**
 * The assistant's conversation about one ontology, and the proposals made in it, by the ontology's
 * IRI: what was asked and answered, and what was looked up. Never a key: the assistant's settings
 * are not kept here, and its key nowhere.
 */
export interface StoredConversation {
  id: string;
  messages: unknown[];
  turns: unknown[];
  proposals: unknown[];
  kept: number;
}

export const putConversation = (c: Omit<StoredConversation, 'kept'>) => single('assistant', 'readwrite', async (store) => void store.put({ ...c, kept: Date.now() }));
export const storedConversation = (id: string) => single('assistant', 'readonly', (store) => done(store.get(id) as IDBRequest<StoredConversation | undefined>));
export const deleteConversation = (id: string) => single('assistant', 'readwrite', async (store) => void store.delete(id));

// ---------------------------------------------------------------- the working copy

/**
 * What is in the editor, kept in this browser as it is edited, saved to My Models or not, so that
 * a reload or a crash loses nothing: the model, which saved model it is, and whether it has
 * changes that are not saved there. Kept as the model itself, with no limit on its size but the
 * browser's space for the site.
 */
export interface WorkingCopy {
  model: Model;
  doc: { id: string | null; dirty: boolean };
  /** When it was kept. */
  kept: number;
}

const CURRENT = 'current';

export const writeWorkingCopy = (copy: Omit<WorkingCopy, 'kept'>): Promise<void> => single('working', 'readwrite', async (store) => void store.put({ id: CURRENT, ...copy, kept: Date.now() }));

/** The working copy kept in this browser, if there is one. Its model is as it was kept: it is brought up to date where it is opened. */
export const readWorkingCopy = (): Promise<WorkingCopy | undefined> =>
  single('working', 'readonly', async (store) => {
    const r = (await done(store.get(CURRENT))) as (WorkingCopy & { id: string }) | undefined;
    return r ? { model: r.model, doc: { id: r.doc?.id ?? null, dirty: r.doc?.dirty === true }, kept: r.kept ?? 0 } : undefined;
  });

/**
 * Asks the browser to keep this site's data even when space runs low, which it may otherwise
 * clear: the working copy, My Models, the ontologies kept for alignment. Resolves to whether it
 * does; nothing where the browser does not say.
 */
export async function keepStorage(): Promise<boolean | undefined> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage?.persist) return undefined;
  try {
    return (await storage.persisted?.()) || (await storage.persist());
  } catch {
    return undefined;
  }
}

/** How much the site keeps in this browser, how much it may, and whether the browser keeps it when space runs low. */
export async function storageUse(): Promise<{ usage?: number; quota?: number; persisted?: boolean }> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  try {
    const [estimate, persisted] = await Promise.all([storage?.estimate?.(), storage?.persisted?.()]);
    return { usage: estimate?.usage, quota: estimate?.quota, persisted };
  } catch {
    return {};
  }
}
