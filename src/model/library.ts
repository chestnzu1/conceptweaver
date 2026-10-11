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
const DB_VERSION = 1;
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

export async function deleteModel(id: string): Promise<void> {
  await tx('readwrite', async (models, data) => {
    models.delete(id);
    data.delete(id);
  });
}
