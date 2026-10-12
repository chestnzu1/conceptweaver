import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { withIris } from './iri';
import { deleteModel, duplicateModel, listModels, loadModel, renameModel, saveModel, useIndexedDb } from './library';
import { toTurtle } from './rdf';
import { sampleModel } from './sample';
import { universitySample } from './sampleUniversity';
import { emptyModel, newTerm, normalizeModel } from './types';

let db: IDBFactory;
beforeEach(() => {
  // A fresh, empty database for every test.
  db = new IDBFactory();
  useIndexedDb(db);
});

const named = (name: string) => withIris({ ...sampleModel(), name });
const tick = () => new Promise((r) => setTimeout(r, 3));

describe('local model library', () => {
  it('saves a model and lists it with its details', async () => {
    const m = withIris({ ...sampleModel(), name: 'Films', ontologyIri: 'http://example.org/films' });
    const info = await saveModel(m);
    expect(info).toMatchObject({ name: 'Films', ontologyIri: 'http://example.org/films', entities: 16, relations: 11, schema: 1 });
    expect(info.id).toBeTruthy();
    expect(info.created).toBe(info.modified);
    expect(await listModels()).toEqual([info]);
  });

  it('keeps models across sessions (a new connection sees them)', async () => {
    const info = await saveModel(named('Kept'));
    // Nothing is held in memory by the library: every call opens the database afresh.
    useIndexedDb(undefined);
    useIndexedDb(db);
    expect((await listModels()).map((m) => m.name)).toEqual(['Kept']);
    expect((await loadModel(info.id))!.model.name).toBe('Kept');
  });

  it('updates a saved model in place, keeping its id and creation date', async () => {
    const first = await saveModel(named('Draft'));
    await tick();
    const edited = { ...named('Draft'), terms: [...named('Draft').terms, newTerm({ name: 'Trailer' })] };
    const second = await saveModel(withIris(edited), first.id);
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(first.created);
    expect(second.modified).toBeGreaterThan(first.modified);
    expect(second.entities).toBe(first.entities + 1);
    expect(await listModels()).toHaveLength(1);
    expect((await loadModel(first.id))!.model.terms.map((t) => t.name)).toContain('Trailer');
  });

  it('stores models independently, even under the same name', async () => {
    const a = await saveModel(named('Same name'));
    await tick();
    const b = await saveModel({ ...named('Same name'), terms: [] });
    expect(a.id).not.toBe(b.id);
    const list = await listModels();
    expect(list.map((m) => m.name)).toEqual(['Same name', 'Same name']);
    // Most recently modified first.
    expect(list.map((m) => m.id)).toEqual([b.id, a.id]);
    expect((await loadModel(a.id))!.model.terms).toHaveLength(11);
    expect((await loadModel(b.id))!.model.terms).toHaveLength(0);
  });

  it('renames, in the list and in the model', async () => {
    const info = await saveModel(named('Old'));
    const renamed = await renameModel(info.id, '  New name ');
    expect(renamed).toMatchObject({ id: info.id, name: 'New name', created: info.created });
    expect((await loadModel(info.id))!.model.name).toBe('New name');
    await expect(renameModel(info.id, '  ')).rejects.toThrow(/needs a name/);
    expect(await renameModel('no-such-id', 'X')).toBeUndefined();
  });

  it('duplicates into an independent copy', async () => {
    const info = await saveModel(named('Films'));
    const copy = (await duplicateModel(info.id))!;
    const copy2 = (await duplicateModel(info.id))!;
    expect([copy.name, copy2.name]).toEqual(['Films copy', 'Films copy 2']);
    expect(new Set([info.id, copy.id, copy2.id]).size).toBe(3);
    // Changing the copy leaves the original as it was.
    await saveModel({ ...(await loadModel(copy.id))!.model, terms: [] }, copy.id);
    expect((await loadModel(info.id))!.model.terms).toHaveLength(11);
    expect((await loadModel(copy.id))!.model.terms).toHaveLength(0);
  });

  it('deletes one model and only that one', async () => {
    const a = await saveModel(named('A'));
    const b = await saveModel(named('B'));
    await deleteModel(a.id);
    expect((await listModels()).map((m) => m.id)).toEqual([b.id]);
    expect(await loadModel(a.id)).toBeUndefined();
    expect(await loadModel(b.id)).toBeDefined();
    // Deleting what is not there is not an error.
    await deleteModel(a.id);
  });

  it('gives back exactly what was saved: entities, axioms, IRIs, prefixes, restrictions', async () => {
    const m = withIris({
      ...universitySample(),
      ontologyIri: 'http://uni.example.org/ontology/1.0',
      baseIri: 'http://uni.example.org/ontology#',
      prefixes: [{ prefix: 'foaf', iri: 'http://xmlns.com/foaf/0.1/' }],
    });
    m.terms[0] = { ...m.terms[0], axioms: ['rdfs:subClassOf [ a owl:Class ; owl:unionOf ( <http://a.org/X> <http://a.org/Y> ) ]'], fields: [{ key: 'skos:prefLabel', value: 'Agent', lang: 'nl' }] };
    const info = await saveModel(m);
    const back = (await loadModel(info.id))!.model;
    // The same model, field for field…
    expect(back).toEqual(normalizeModel(JSON.parse(JSON.stringify(m))));
    expect(back).toEqual(m);
    // …and so the same ontology.
    expect(toTurtle(back)).toBe(toTurtle(m));
    expect(back.props.find((p) => p.name === 'part of')).toMatchObject({ chars: ['transitive'], inverses: ['has part'] });
    expect(back.relations.filter((r) => r.restriction).length).toBe(m.relations.filter((r) => r.restriction).length);
  });

  it('upgrades records and models written by an earlier version', async () => {
    // A record as an earlier build might have left it: no dates, counts or schema number, and a
    // model in the old shape (no prefixes or object properties; an object property drawn as a term).
    const old = {
      terms: [{ id: 'f', name: 'Film' }, { id: 's', name: 'Studio' }, { id: 'p', name: 'Distributed by', type: 'property', propKind: 'object' }],
      relations: [{ from: 'f', to: 'p', kind: 'property' }, { from: 'p', to: 's', kind: 'range' }],
      name: 'Legacy',
    };
    await new Promise<void>((resolve, reject) => {
      const req = db.open('conceptweaver', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('models', { keyPath: 'id' });
        req.result.createObjectStore('data', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const t = req.result.transaction(['models', 'data'], 'readwrite');
        t.objectStore('models').put({ id: 'legacy-1', name: 'Legacy', modified: 1700000000000 });
        t.objectStore('data').put({ id: 'legacy-1', model: old });
        t.oncomplete = () => {
          req.result.close();
          resolve();
        };
      };
      req.onerror = () => reject(req.error);
    });
    const [info] = await listModels();
    expect(info).toEqual({ id: 'legacy-1', name: 'Legacy', created: 1700000000000, modified: 1700000000000, ontologyIri: 'http://example.org/legacy', entities: 3, relations: 1, schema: 1 });
    // The upgrade was written back, so it happens once.
    expect((await listModels())[0]).toEqual(info);
    const { model } = (await loadModel('legacy-1'))!;
    expect(model.terms.map((t) => t.name)).toEqual(['Film', 'Studio']);
    expect(model.props).toMatchObject([{ name: 'Distributed by', domain: ['f'], range: ['s'] }]);
    expect(model).toMatchObject({ prefixes: [], ontologyIri: '', mode: 'ontology' });
  });

  it('says so plainly when the browser has no IndexedDB', async () => {
    useIndexedDb(undefined);
    await expect(saveModel(emptyModel())).rejects.toThrow(/IndexedDB is unavailable/);
  });
});
