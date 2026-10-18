import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { addIsA } from '../model/axioms';
import { withIris } from '../model/iri';
import { deleteModel, saveModel, storedVersions, useIndexedDb } from '../model/library';
import { fromTurtle } from '../model/rdf';
import { sampleModel } from '../model/sample';
import { importIntoSet, newSetFor } from '../model/shapes';
import type { Model } from '../model/types';
import { changesOf, nothingChanged } from './difference';
import { contentHash, createLocalProjectService } from './local';

/** Named versions and what changed between them (roadmap task 2.3, FR-M10-1 to FR-M10-3), kept in this browser. */

beforeEach(() => useIndexedDb(new IDBFactory()));

/** A service over a model that can be changed, as the editor's is. */
function editor(start: Model) {
  let model = start;
  const service = createLocalProjectService({ current: () => model, replace: (m) => (model = m) });
  return { service, set: (m: Model) => (model = m), get: () => model };
}

const T = `@prefix : <http://example.org/w#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/w> a owl:Ontology .
:Work a owl:Class . :Person a owl:Class .
:Film a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :by ; owl:someValuesFrom :Person ] .
:by a owl:ObjectProperty .`;

describe('versions of a project', () => {
  it('are saved with a name and a summary, listed newest first, and kept in the browser', async () => {
    const m = withIris(sampleModel());
    const { service } = editor(m);
    const a = await service.saveVersion('p1', 'First', 'As it began');
    const b = await service.saveVersion('p1', '  Second  ', '');
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b).toMatchObject({ project: 'p1', name: 'Second', summary: '', entities: m.terms.length + m.props.length, hash: contentHash(m) });
    // Another service over the same database, as a later session: the same versions, newest first.
    const later = createLocalProjectService({ current: () => m, replace: () => {} });
    expect((await later.versions('p1')).map((v) => v.name)).toEqual(['Second', 'First']);
    expect(await later.versions('another')).toEqual([]);
    // The model comes back as it was saved.
    expect(await later.version('p1', a.id)).toEqual(m);
    await expect(service.saveVersion('p1', ' ', '')).rejects.toMatchObject({ code: 'invalid' });
    await expect(service.version('p2', a.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('says there is no change to the ontology when only terms were moved on the canvas', async () => {
    const m = withIris(sampleModel());
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before moving', '');
    ed.set({ ...m, terms: m.terms.map((t) => ({ ...t, x: t.x + 120, y: t.y - 40 })) });
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    expect(nothingChanged(d)).toBe(true);
    expect(d.drawing).toBe(true);
    expect(d.axioms).toEqual({ added: 0, removed: 0 });
  });

  it('shows one superclass added and one restriction removed as exactly two changes, under the class', async () => {
    const m = withIris(fromTurtle(T));
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    const film = m.terms.find((t) => t.name === 'Film')!;
    const work = m.terms.find((t) => t.name === 'Work')!;
    let next = addIsA(m, film.id, work.id).model!;
    // The restriction is the relationship from Film drawn with "by".
    next = { ...next, relations: next.relations.filter((r) => !(r.from === film.id && r.label === 'by')) };
    ed.set(next);
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    const lines = changesOf(d, film.iri!).map((l) => `${l.op === 'add' ? '+' : '-'} ${l.text}`);
    expect(lines).toEqual(['+ Film SubClassOf Work', '- Film SubClassOf by some Person']);
    expect(d.entities.find((e) => e.iri === film.iri)).toMatchObject({ name: 'Film', kind: 'class', status: 'changed' });
  });

  it('tells entities added and removed, the shape sets and the data graphs', async () => {
    const m = withIris(fromTurtle(T));
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    const set = importIntoSet(newSetFor('Catalogue'), '@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix : <http://example.org/w#> . :FilmShape sh:targetClass :Film ; sh:property [ sh:path :by ; sh:minCount 1 ] .').set;
    const person = m.terms.find((t) => t.name === 'Person')!;
    ed.set({ ...m, terms: m.terms.filter((t) => t.id !== person.id), relations: m.relations.filter((r) => r.from !== person.id && r.to !== person.id), shapeSets: [set], dataGraphs: [{ id: 'g', name: 'films', file: 'films.ttl', format: 'turtle', triples: 3, fingerprint: 'f', includeOntology: true, read: 1 }] });
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    expect(d.entities.find((e) => e.iri === person.iri)).toMatchObject({ status: 'removed', kind: 'class' });
    expect(d.shapeSets).toEqual([expect.objectContaining({ name: 'Catalogue', status: 'added' })]);
    expect(d.shapeSets[0].changes.map((c) => `${c.op} ${c.text}`).sort()).toEqual(['add :FilmShape sh:property [ sh:minCount 1 ; sh:path :by ] .', 'add :FilmShape sh:targetClass :Film .']);
    expect(d.dataGraphs).toEqual([{ id: 'g', name: 'films', status: 'added' }]);
    // And the other way, everything the other way round.
    const back = await ed.service.diff('p', 'current', { version: v.id });
    expect(back.entities.find((e) => e.iri === person.iri)!.status).toBe('added');
    expect(back.shapeSets[0].status).toBe('removed');
  });

  it('restores a version as a new one, never by deleting history: of five, the sixth is the third', async () => {
    let m = withIris(fromTurtle(T));
    const ed = editor(m);
    const film = m.terms.find((t) => t.name === 'Film')!;
    const saved = [];
    for (let i = 1; i <= 5; i++) {
      m = { ...m, terms: m.terms.map((t) => (t.id === film.id ? { ...t, description: `Edit ${i}` } : t)) };
      ed.set(m);
      saved.push(await ed.service.saveVersion('p', `Version ${i}`, ''));
    }
    const restored = await ed.service.restore('p', saved[2].id);
    const all = await ed.service.versions('p');
    expect(all).toHaveLength(6);
    expect(restored).toMatchObject({ seq: 6, name: 'Restored version 3', hash: saved[2].hash });
    expect(ed.get().terms.find((t) => t.id === film.id)!.description).toBe('Edit 3');
    expect(nothingChanged(await ed.service.diff('p', { version: saved[2].id }, { version: restored.id }))).toBe(true);
    expect(nothingChanged(await ed.service.diff('p', { version: saved[4].id }, { version: restored.id }))).toBe(false);
  });

  it('go when the model is deleted from My Models', async () => {
    const m = withIris(sampleModel());
    const info = await saveModel(m);
    const { service } = editor(m);
    await service.saveVersion(info.id, 'One', '');
    await deleteModel(info.id);
    expect(await storedVersions(info.id)).toEqual([]);
  });
});

const CLASSES = `@prefix : <http://example.org/w#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/w> a owl:Ontology .
:Work a owl:Class . :Person a owl:Class . :Film a owl:Class . :Studio a owl:Class .`;

describe('a rename and a move, told as one change each', () => {
  it('tells a class given another name as a rename, not a label removed and another added', async () => {
    const m = withIris(fromTurtle(CLASSES));
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    const work = m.terms.find((t) => t.name === 'Work')!;
    ed.set({ ...m, terms: m.terms.map((t) => (t.id === work.id ? { ...t, name: 'Opus' } : t)) });
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    expect(d.entities.find((e) => e.iri === work.iri)).toMatchObject({ name: 'Opus', kind: 'class', status: 'changed', renamed: { from: 'Work', to: 'Opus' }, changes: [] });
    // The statement counts still say what changed in the ontology.
    expect(d.axioms).toEqual({ added: 1, removed: 1 });
    const back = await ed.service.diff('p', 'current', { version: v.id });
    expect(back.entities.find((e) => e.iri === work.iri)).toMatchObject({ renamed: { from: 'Opus', to: 'Work' }, changes: [] });
  });

  it('keeps the other lines of an entity that was also renamed', async () => {
    const m = withIris(fromTurtle(CLASSES));
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    const work = m.terms.find((t) => t.name === 'Work')!;
    ed.set({ ...m, terms: m.terms.map((t) => (t.id === work.id ? { ...t, name: 'Opus', description: 'A body of work.' } : t)) });
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    const e = d.entities.find((x) => x.iri === work.iri)!;
    expect(e.renamed).toEqual({ from: 'Work', to: 'Opus' });
    expect(e.changes).toHaveLength(1);
    expect(e.changes[0]).toMatchObject({ op: 'add' });
    expect(e.changes[0].text).toContain('skos:definition');
  });

  it('tells a class put under another superclass as a move, not as two subclass statements', async () => {
    const m = withIris(fromTurtle(`${CLASSES}\n:Film rdfs:subClassOf :Work .`));
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    const [film, work, person] = ['Film', 'Work', 'Person'].map((name) => m.terms.find((t) => t.name === name)!);
    let next = addIsA(m, film.id, person.id).model!;
    next = { ...next, relations: next.relations.filter((r) => !(r.from === film.id && r.to === work.id && r.kind === 'generalization')) };
    ed.set(next);
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    expect(d.entities.find((e) => e.iri === film.iri)).toMatchObject({ kind: 'class', moved: { from: 'Work', to: 'Person' }, changes: [] });
    expect(d.axioms).toEqual({ added: 1, removed: 1 });
    const back = await ed.service.diff('p', 'current', { version: v.id });
    expect(back.entities.find((e) => e.iri === film.iri)).toMatchObject({ moved: { from: 'Person', to: 'Work' } });
  });

  it('never pairs when more than one line went or came', async () => {
    const m = withIris(fromTurtle(`${CLASSES}\n:Film rdfs:subClassOf :Work, :Person .`));
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    const [film, work, person, studio] = ['Film', 'Work', 'Person', 'Studio'].map((name) => m.terms.find((t) => t.name === name)!);
    let next = addIsA(m, film.id, studio.id).model!;
    next = { ...next, relations: next.relations.filter((r) => !(r.from === film.id && (r.to === work.id || r.to === person.id) && r.kind === 'generalization')) };
    ed.set(next);
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    const e = d.entities.find((x) => x.iri === film.iri)!;
    // Two superclasses went and one came: a move cannot tell which was the move, so the lines stay.
    expect(e.moved).toBeUndefined();
    expect(e.changes).toHaveLength(3);
    expect(d.axioms).toEqual({ added: 1, removed: 2 });
    // A label in two languages renamed in one, and another removed: again the lines stay.
    const base = withIris(fromTurtle(CLASSES));
    const labelled = { ...base, terms: base.terms.map((t) => (t.name === 'Work' ? { ...t, fields: [{ key: 'rdfs:label', value: 'Travail', lang: 'fr' }] } : t)) };
    const ed2 = editor(labelled);
    const v2 = await ed2.service.saveVersion('p', 'Before', '');
    const work2 = labelled.terms.find((t) => t.name === 'Work')!;
    ed2.set({ ...labelled, terms: labelled.terms.map((t) => (t.id === work2.id ? { ...t, name: 'Opus', fields: [] } : t)) });
    const d2 = await ed2.service.diff('p', { version: v2.id }, 'current');
    const e2 = d2.entities.find((x) => x.iri === work2.iri)!;
    expect(e2.renamed).toBeUndefined();
    expect(e2.changes).toHaveLength(3);
  });

  it('tells a renamed ontology by the property its name is written with', async () => {
    const base = withIris(fromTurtle(CLASSES));
    const m: Model = { ...base, namedBy: 'dcterms:title' };
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    ed.set({ ...m, name: 'Renamed ontology' });
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    expect(d.entities.find((e) => e.kind === 'ontology')).toMatchObject({ renamed: { from: m.name, to: 'Renamed ontology' }, changes: [] });
  });

  it('compares two models saved in My Models, the same way as two versions', async () => {
    const a = await saveModel(withIris(fromTurtle(CLASSES)));
    const base = withIris(fromTurtle(CLASSES));
    const work = base.terms.find((t) => t.name === 'Work')!;
    const b = await saveModel({ ...base, terms: base.terms.map((t) => (t.id === work.id ? { ...t, name: 'Opus' } : t)) });
    const { service } = editor(withIris(fromTurtle(CLASSES)));
    const d = await service.diff('p', { model: a.id }, { model: b.id });
    expect(d.entities.find((e) => e.iri === work.iri)).toMatchObject({ renamed: { from: 'Work', to: 'Opus' } });
    await expect(service.diff('p', { model: 'nobody' }, 'current')).rejects.toMatchObject({ code: 'not-found' });
  });
});
