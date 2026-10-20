import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { artifactsOf, summaryOf } from '../editing/local';
import { withIris } from '../model/iri';
import { sampleModel } from '../model/sample';
import { useStore } from '../model/store';
import { normalizeModel, type Model } from '../model/types';
import { difference } from '../projects/difference';
import { createLocalProjectService } from '../projects/local';
import { revisionOf, WORKING_COPY } from '../structure/local';
import { LogicalError, type LogicalChange, type LogicalChangeSet, type LogicalModel } from './contracts';
import { exportLogicalModel, importLogicalModel } from './exchange';
import { createLocalLogicalServices } from './local';
import { removalOf } from './rules';

/**
 * Logical data models (roadmap LM-1): an LDM with every kind of element made through the edit
 * service and read back through the query service; kept with the project, its versions and its
 * file; refused where it would break its rules; undone and redone; and apart from the ontology.
 */

const st = useStore.getState;

/** Every kind of element: a domain, an attribute of each type, three kinds of relationship, both kinds of key, a specialization, two rules. */
const CONTENT: Omit<LogicalModel, 'id' | 'name' | 'description' | 'purpose' | 'revision'> = {
  domains: [{ id: 'd-rating', name: 'rating', definition: 'An age rating.', base: { base: 'text', maxLength: 5 }, constraints: { values: [{ code: 'PG', label: 'Parental guidance' }, { code: '18', label: 'Adults only' }] } }],
  entities: [
    {
      id: 'e-work',
      name: 'work',
      definition: 'Something made to be watched.',
      abstract: true,
      attributes: [
        { id: 'a-title', name: 'title', definition: '', type: { base: 'text', maxLength: 200 }, optional: false },
        { id: 'a-released', name: 'released', definition: '', type: { base: 'date' }, optional: true },
        { id: 'a-kind', name: 'kind', definition: 'Film or series.', type: { base: 'text', maxLength: 10 }, optional: false },
      ],
      keys: [],
    },
    {
      id: 'e-film',
      name: 'film',
      definition: 'A story recorded as moving images.',
      attributes: [
        { id: 'a-code', name: 'code', definition: '', type: { base: 'identifier' }, optional: false },
        { id: 'a-running', name: 'running time', definition: 'In minutes.', type: { base: 'integer' }, optional: true, derived: true },
        { id: 'a-budget', name: 'budget', definition: '', type: { base: 'decimal', precision: 12, scale: 2 }, optional: true },
        { id: 'a-rating', name: 'rating', definition: '', type: { domain: 'd-rating' }, optional: true },
        { id: 'a-colour', name: 'in colour', definition: '', type: { base: 'boolean' }, optional: true },
        { id: 'a-restored', name: 'restored at', definition: '', type: { base: 'dateTime' }, optional: true },
        { id: 'a-clip', name: 'trailer', definition: '', type: { base: 'binary' }, optional: true },
        { id: 'a-length', name: 'length', definition: '', type: { base: 'duration' }, optional: true },
        { id: 'a-start', name: 'first showing', definition: '', type: { base: 'time' }, optional: true },
      ],
      keys: [
        { id: 'k-film', kind: 'primary', name: 'film key', members: [{ attribute: 'a-code' }] },
        { id: 'k-film-title', kind: 'candidate', name: 'title and release', members: [{ attribute: 'a-title' }, { attribute: 'a-released' }] },
      ],
    },
    { id: 'e-series', name: 'series', definition: '', attributes: [{ id: 'a-seasons', name: 'seasons', definition: '', type: { base: 'integer' }, optional: true }], keys: [] },
    { id: 'e-person', name: 'person', definition: '', attributes: [{ id: 'a-person', name: 'person id', definition: '', type: { base: 'identifier' }, optional: false }], keys: [{ id: 'k-person', kind: 'primary', name: 'person key', members: [{ attribute: 'a-person' }] }] },
    {
      id: 'e-credit',
      name: 'credit',
      definition: 'Who did what on a film.',
      attributes: [{ id: 'a-role', name: 'role', definition: '', type: { base: 'text' }, optional: false }],
      keys: [{ id: 'k-credit', kind: 'primary', name: 'credit key', members: [{ end: { relationship: 'r-credit-film', end: 1 } }, { end: { relationship: 'r-credit-person', end: 1 } }, { attribute: 'a-role' }] }],
    },
  ],
  relationships: [
    { id: 'r-directed', name: 'directed by', definition: '', identifying: false, ends: [{ entity: 'e-film', role: 'film', min: 0, max: 'many' }, { entity: 'e-person', role: 'director', min: 0, max: 1 }] },
    { id: 'r-acts', name: 'acts in', definition: '', identifying: false, ends: [{ entity: 'e-person', role: 'actor', min: 0, max: 'many' }, { entity: 'e-film', role: 'film', min: 0, max: 'many' }] },
    { id: 'r-credit-film', name: 'credit of', definition: '', identifying: true, ends: [{ entity: 'e-credit', role: 'credit', min: 0, max: 'many' }, { entity: 'e-film', role: 'film', min: 1, max: 1 }] },
    { id: 'r-credit-person', name: 'credit to', definition: '', identifying: true, ends: [{ entity: 'e-credit', role: 'credit', min: 0, max: 'many' }, { entity: 'e-person', role: 'person', min: 1, max: 1 }] },
  ],
  generalizations: [{ id: 'g-work', supertype: 'e-work', subtypes: ['e-film', 'e-series'], complete: true, exclusive: true, discriminator: 'a-kind' }],
  rules: [
    { id: 'b-release', name: 'released after 1888', statement: 'A work is not released before 1888.', kind: 'constraint', appliesTo: [{ attribute: 'a-released' }], status: 'accepted' },
    { id: 'b-running', name: 'running time from length', statement: 'The running time is the length in minutes.', kind: 'derivation', appliesTo: [{ attribute: 'a-running' }, { attribute: 'a-length' }], status: 'proposed' },
  ],
  mappings: [],
  diagrams: [],
};

/** The changes that add all of CONTENT, in an order the rules do not care about: they are checked once all are made. */
const additions = (): LogicalChange[] => [
  ...CONTENT.domains.map((domain): LogicalChange => ({ op: 'add', element: { kind: 'domain', domain } })),
  ...CONTENT.entities.map((entity): LogicalChange => ({ op: 'add', element: { kind: 'entity', entity } })),
  ...CONTENT.relationships.map((relationship): LogicalChange => ({ op: 'add', element: { kind: 'relationship', relationship } })),
  ...CONTENT.generalizations.map((generalization): LogicalChange => ({ op: 'add', element: { kind: 'generalization', generalization } })),
  ...CONTENT.rules.map((rule): LogicalChange => ({ op: 'add', element: { kind: 'rule', rule } })),
];

/** A project of its own, in memory, for the services. */
function project(model: Model = withIris(sampleModel())) {
  let current = model;
  const services = createLocalLogicalServices({ current: () => ({ model: current }), commit: (next) => (current = next) });
  return { ...services, get model() {
    return current;
  } };
}

async function filled(p = project()) {
  const made = await p.edit.create({ name: 'Film catalogue', purpose: 'The catalogue application' });
  const after = await p.edit.apply({ model: made.model, baseRevision: made.revision, changes: additions(), summary: 'Filled in' });
  return { p, id: made.model, revision: after.revision };
}

beforeEach(() => st().replaceModel(withIris(sampleModel())));

describe('an LDM with every kind of element', () => {
  it('is made through the edit service and read back through the query service, element for element', async () => {
    const { p, id, revision } = await filled();
    const m = await p.query.model({ model: id, revision });
    expect(m).toEqual({ id, name: 'Film catalogue', description: '', purpose: 'The catalogue application', revision, ...CONTENT });
    expect(await p.query.models()).toEqual([{ id, name: 'Film catalogue', description: '', purpose: 'The catalogue application', revision, counts: { entities: 5, attributes: 15, relationships: 4, keys: 4, generalizations: 1, rules: 2, domains: 1 } }]);
    // By name or by definition, in the order of their names.
    const page = await p.query.entities({ model: id, search: 'film', limit: 10 });
    expect(page.items.map((e) => e.name)).toEqual(['credit', 'film']);
    expect(page.items[1]).toMatchObject({ attributes: 9, hasPrimaryKey: true, supertypes: ['e-work'] });
    const film = await p.query.describe({ model: id, element: { entity: 'e-film' } });
    expect(film.description).toMatchObject({ kind: 'entity', supertypes: ['e-work'], subtypes: [] });
    if (film.description.kind !== 'entity') throw new Error();
    expect(film.description.inherited.map((x) => x.attribute.name)).toEqual(['title', 'released', 'kind']);
    expect(film.description.relationships.map((r) => r.id).sort()).toEqual(['r-acts', 'r-credit-film', 'r-directed']);
    const rating = await p.query.describe({ model: id, element: { domain: 'd-rating' } });
    expect(rating.description).toMatchObject({ kind: 'domain', usedBy: [{ entity: 'e-film', attribute: 'a-rating' }] });
    expect((await p.query.relationships({ model: id, entity: 'e-person' })).items.map((r) => r.id).sort()).toEqual(['r-acts', 'r-credit-person', 'r-directed']);
  });

  it('gives a subtype the keys of the entity it inherits from', async () => {
    const { p, id, revision } = await filled();
    const m = await p.query.model({ model: id });
    const filmPrimary = m.entities.find((e) => e.id === 'e-film')!.keys.find((k) => k.kind === 'primary')!;
    const after = await p.edit.apply({
      model: id,
      baseRevision: revision,
      changes: [
        { op: 'remove', element: { kind: 'key', entity: 'e-film', key: filmPrimary } },
        { op: 'add', element: { kind: 'key', entity: 'e-work', key: { id: 'k-work', kind: 'primary', name: 'work key', members: [{ attribute: 'a-title' }] } } },
      ],
      summary: 'Identify works',
    });
    const series = await p.query.describe({ model: id, revision: after.revision, element: { entity: 'e-series' } });
    expect(series.description).toMatchObject({ kind: 'entity', inheritedKeys: [{ from: 'e-work', key: { id: 'k-work' } }] });
    const page = await p.query.entities({ model: id, search: 'series', limit: 10 });
    expect(page.items[0]).toMatchObject({ name: 'series', hasPrimaryKey: true });
  });

  it('is written to its own file and read back the same', async () => {
    const { p, id } = await filled();
    const m = await p.query.model({ model: id });
    const text = exportLogicalModel(m);
    expect(JSON.parse(text)).toMatchObject({ format: 'conceptweaver-ldm', version: 2, model: { id } });
    expect(importLogicalModel(text)).toEqual(m);
    // Into another project: the same, under the same id, at a revision of its own there.
    const q = project();
    const made = await q.edit.import({ document: text });
    expect(made).toMatchObject({ model: id, name: 'Film catalogue' });
    expect({ ...(await q.query.model({ model: id })), revision: m.revision }).toEqual(m);
    // Into the same project again: a new id, a name of its own.
    const again = await p.edit.import({ document: text });
    expect(again.model).not.toBe(id);
    expect(again.name).toBe('Film catalogue (2)');
    expect(importLogicalModel('{"format":"something else"}')).toMatchObject({ error: expect.stringMatching(/not a logical data model/) });
    await expect(q.edit.import({ document: '{"format":"conceptweaver-ldm","version":9,"model":{}}' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/version 9/) });
  });

  it('writes a reference entity and reads it back, and still reads a file of the format before it', async () => {
    const { p, id } = await filled();
    const m = await p.query.model({ model: id });
    const entities = m.entities.map((e, i) => (i === 0 ? { ...e, reference: true } : e));
    const withReference = { ...m, entities };
    const text = exportLogicalModel(withReference);
    const file = JSON.parse(text) as { version: number; model: { entities: Array<Record<string, unknown>> } };
    expect(file.version).toBe(2);
    const read = importLogicalModel(text);
    if ('error' in read) throw new Error(read.error);
    expect(read.entities[0].reference).toBe(true);
    expect(read).toEqual(withReference);
    // A reader accepts version 1, where no entity was a reference entity.
    file.version = 1;
    delete file.model.entities[0].reference;
    const older = importLogicalModel(JSON.stringify(file));
    if ('error' in older) throw new Error(older.error);
    expect(older.entities[0].reference).toBeUndefined();
  });

  it('is kept in the project’s own file, in My Models and in its versions, and comes back the same', async () => {
    const made = await st().logicalEdit.create({ name: 'Film catalogue' });
    await st().logicalEdit.apply({ model: made.model, baseRevision: made.revision, changes: additions(), summary: 'Filled in' });
    const ldm = st().model.logicalModels[0];
    // The project file, as it is saved and read.
    expect(normalizeModel(JSON.parse(JSON.stringify(st().model))).logicalModels).toEqual([ldm]);
    // My Models, and a version restored.
    expect(await st().saveToLibrary({ name: 'With an LDM', quiet: true })).toBe(true);
    const projects = createLocalProjectService({ current: () => st().model, replace: (m) => st().apply(() => m) });
    const v = await projects.saveVersion(st().doc.id!, 'Filled in', '');
    await st().logicalEdit.remove({ model: ldm.id });
    expect(st().model.logicalModels).toEqual([]);
    await projects.restore(st().doc.id!, v.id);
    expect(st().model.logicalModels).toEqual([ldm]);
    expect(await st().openFromLibrary(st().doc.id!)).toBe(true);
    expect(st().model.logicalModels).toEqual([ldm]);
  });
});

describe('a change that breaks the rules', () => {
  const refused = async (changes: (m: LogicalModel) => LogicalChange[], message: RegExp, base?: string) => {
    const { p, id, revision } = await filled();
    const m = await p.query.model({ model: id });
    const cs: LogicalChangeSet = { model: id, baseRevision: base ?? revision, changes: changes(m), summary: 'x' };
    const before = p.model;
    const error = await p.edit.apply(cs).catch((e) => e);
    expect(error).toBeInstanceOf(LogicalError);
    expect(error.message).toMatch(message);
    // Nothing changed: the same project, the same revision.
    expect(p.model).toBe(before);
    return error as LogicalError;
  };

  it('is refused with its reason, and nothing changes', async () => {
    await refused(() => [{ op: 'add', element: { kind: 'entity', entity: { id: 'e-new', name: 'Film', definition: '', attributes: [], keys: [] } } }], /Two entities are called “Film”/);
    await refused(() => [{ op: 'add', element: { kind: 'key', entity: 'e-person', key: { id: 'k-x', kind: 'candidate', name: 'x', members: [{ attribute: 'a-code' }] } } }], /names an attribute it does not have/);
    await refused((m) => [{ op: 'remove', element: { kind: 'entity', entity: m.entities.find((e) => e.id === 'e-person')! } }], /end at an entity that is not in the model/);
    await refused(() => [{ op: 'add', element: { kind: 'generalization', generalization: { id: 'g-loop', supertype: 'e-film', subtypes: ['e-work'], complete: false, exclusive: false } } }], /go round in a circle/);
    await refused(() => [{ op: 'add', element: { kind: 'key', entity: 'e-film', key: { id: 'k-second', kind: 'primary', name: 'second', members: [{ attribute: 'a-start' }] } } }], /more than one primary key/);
    await refused(() => [{ op: 'add', element: { kind: 'key', entity: 'e-work', key: { id: 'k-work', kind: 'primary', name: 'work key', members: [{ attribute: 'a-title' }] } } }], /more than one primary key, counting what it inherits/);
    await refused(
      (m) => [
        { op: 'remove', element: { kind: 'key', entity: 'e-film', key: m.entities.find((e) => e.id === 'e-film')!.keys.find((k) => k.kind === 'primary')! } },
        { op: 'add', element: { kind: 'key', entity: 'e-work', key: { id: 'k-work', kind: 'primary', name: 'work key', members: [{ attribute: 'a-title' }] } } },
        { op: 'add', element: { kind: 'key', entity: 'e-series', key: { id: 'k-series', kind: 'candidate', name: 'work key', members: [{ attribute: 'a-seasons' }] } } },
      ],
      /two keys called “work key”, counting what it inherits/,
    );
    await refused(() => [{ op: 'add', element: { kind: 'attribute', entity: 'e-film', attribute: { id: 'a-title2', name: 'Title', definition: '', type: { base: 'text' }, optional: true } } }], /inherits an attribute called “Title”/);
    await refused(() => [{ op: 'update', target: { relationship: 'r-directed' }, before: { name: 'directed by' }, after: { ends: [{ entity: 'e-film', role: 'film', min: 2, max: 1 }, { entity: 'e-person', role: 'director', min: 0, max: 1 }] } }], /a maximum has to be/);
    await refused(() => [{ op: 'update', target: { entity: 'e-film' }, before: { name: 'movie' }, after: { name: 'picture' } }], /“name” is not as the change says/);
    await refused(() => [{ op: 'update', target: { entity: 'e-film' }, before: {}, after: { id: 'e-other' } }], /“id” is not a field that can be changed/);
    await refused(() => [{ op: 'add', element: { kind: 'rule', rule: { id: 'a-code', name: 'x', statement: 'x', kind: 'constraint', appliesTo: [], status: 'proposed' } } }], /has an element with the id “a-code” already/);
    const stale = await refused(() => [{ op: 'update', target: { model: true }, before: { name: 'Film catalogue' }, after: { name: 'Films' } }], /moved on from revision/, 'r-old');
    expect(stale.code).toBe('stale-revision');
    const { p, id, revision } = await filled();
    await expect(p.edit.apply({ model: id, baseRevision: revision, changes: [], summary: '' })).rejects.toMatchObject({ code: 'invalid', message: 'The change set changes nothing.' });
    await expect(p.edit.create({ name: 'film catalogue' })).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/called “film catalogue” already/) });
    expect(await p.edit.validate({ model: id, baseRevision: revision, changes: [{ op: 'update', target: { model: true }, before: {}, after: { name: '' } }], summary: '' })).toEqual({ ok: false, refusals: [{ code: 'invalid', message: 'A logical model needs a name.', element: { model: true } }] });
  });

  it('can be made one that does not: an entity taken out with everything that names it', async () => {
    const { p, id, revision } = await filled();
    const m = await p.query.model({ model: id });
    const changes = removalOf(m, { entity: 'e-person' });
    await p.edit.apply({ model: id, baseRevision: revision, changes, summary: 'No more people' });
    const next = await p.query.model({ model: id });
    expect(next.entities.map((e) => e.id)).toEqual(['e-work', 'e-film', 'e-series', 'e-credit']);
    expect(next.relationships.map((r) => r.id)).toEqual(['r-credit-film']);
    // The credit's key keeps what it has left: the film's identity and the role.
    expect(next.entities.find((e) => e.id === 'e-credit')!.keys[0].members).toEqual([{ end: { relationship: 'r-credit-film', end: 1 } }, { attribute: 'a-role' }]);
    // An attribute that is a discriminator and in a key: taken out of both.
    const kind = removalOf(next, { attribute: 'a-kind' });
    const after = await p.edit.apply({ model: id, baseRevision: next.revision, changes: kind, summary: 'No kind' });
    expect((await p.query.model({ model: id, revision: after.revision })).generalizations[0].discriminator).toBeUndefined();
  });
});

describe('in the editor', () => {
  it('each change is one step of the history, undone and redone exactly, named for the LDM it changed', async () => {
    const steps = st().past.length;
    const made = await st().logicalEdit.create({ name: 'Film catalogue' });
    const created = st().model.logicalModels;
    await st().logicalEdit.apply({ model: made.model, baseRevision: made.revision, changes: additions(), summary: 'Filled in' });
    const filledIn = st().model.logicalModels;
    const copy = await st().logicalEdit.duplicate({ model: made.model });
    expect(st().past.length).toBe(steps + 3);
    expect(summaryOf(st().past.at(-1)!.patch)).toBe('Added the logical model “Film catalogue (copy)”');
    expect(summaryOf(st().past.at(-2)!.patch)).toBe('Changed the logical model “Film catalogue”');
    expect(artifactsOf(st().past.at(-2)!.patch)).toEqual([`ldm:${made.model}`]);
    // The copy is independent: new ids throughout, every reference following.
    const c = st().model.logicalModels.find((x) => x.id === copy.model)!;
    expect(c.entities.map((e) => e.name)).toEqual(filledIn[0].entities.map((e) => e.name));
    expect(c.entities.some((e) => filledIn[0].entities.some((f) => f.id === e.id))).toBe(false);
    expect(c.entities.find((e) => e.name === 'credit')!.keys[0].members[0]).toEqual({ end: { relationship: c.relationships.find((r) => r.name === 'credit of')!.id, end: 1 } });
    st().undo();
    expect(st().model.logicalModels).toBe(filledIn);
    st().undo();
    expect(st().model.logicalModels).toBe(created);
    st().redo();
    expect(st().model.logicalModels).toBe(filledIn);
    // A change set made before the undo, against the revision it was undone back to, applies again.
    await st().logicalEdit.remove({ model: made.model });
    expect(st().model.logicalModels).toEqual([]);
    st().undo();
    expect(st().model.logicalModels).toBe(filledIn);
  });

  it('names the artifacts each step changed: the ontology, its shapes, its data, the picture or an LDM (TD-19)', async () => {
    const m = st().model;
    const t = m.terms[0];
    expect(artifactsOf({ before: { terms: m.terms }, after: { terms: m.terms.map((x) => (x === t ? { ...t, x: t.x + 10 } : x)) } })).toEqual(['picture']);
    expect(artifactsOf({ before: { terms: m.terms }, after: { terms: m.terms.map((x) => (x === t ? { ...t, description: 'Changed.' } : x)) } })).toEqual(['ontology']);
    expect(artifactsOf({ before: { shapeSets: m.shapeSets, style: m.style }, after: { shapeSets: [], style: { ...m.style } } }).sort()).toEqual(['picture', 'shapes']);
    expect(artifactsOf({ before: { dataGraphs: m.dataGraphs }, after: { dataGraphs: [] } })).toEqual(['dataGraphs']);
    const a = await st().logicalEdit.create({ name: 'A' });
    const b = await st().logicalEdit.create({ name: 'B' });
    expect(artifactsOf(st().past.at(-1)!.patch)).toEqual([`ldm:${b.model}`]);
    await st().logicalEdit.remove({ model: a.model });
    expect(artifactsOf(st().past.at(-1)!.patch)).toEqual([`ldm:${a.model}`]);
  });

  it('never moves the ontology’s revision, nor the ontology an LDM’s, nor one LDM another’s (NFR-17)', async () => {
    const a = await st().logicalEdit.create({ name: 'A' });
    const b = await st().logicalEdit.create({ name: 'B' });
    const ontology = revisionOf(st().model);
    const version = st().version.revision;
    // A change of the ontology made against this revision, as a pending proposal of the assistant would be.
    const { review } = await import('../ai/proposals');
    const proposal = await review(st().model, { summary: 'Short films', operations: [{ action: 'add', type: 'declare', entityKind: 'class', name: 'Short film' }] }, st().doc.id ?? WORKING_COPY);
    await st().logicalEdit.apply({ model: a.model, baseRevision: a.revision, changes: additions(), summary: 'Filled in' });
    expect(revisionOf(st().model)).toBe(ontology);
    expect(st().version.revision).toBe(version);
    expect(st().model.logicalModels.find((x) => x.id === b.model)!.revision).toBe(b.revision);
    // The proposal made before the LDM was changed is still current, and applies.
    await st().editService.apply(proposal.changeSet!);
    expect(st().model.terms.some((t) => t.name === 'Short film')).toBe(true);
    expect(revisionOf(st().model)).not.toBe(ontology);
    // The ontology changed: every LDM is at the revision it was.
    expect(st().model.logicalModels.map((x) => x.revision)).toEqual([st().model.logicalModels[0].revision, b.revision]);
    const ldmRevision = st().model.logicalModels[0].revision;
    st().updateTerm(st().model.terms[0].id, { description: 'Changed.' });
    expect(st().model.logicalModels[0].revision).toBe(ldmRevision);
  });

  it('is told apart, between two versions, element by element, from the ontology’s changes', async () => {
    const made = await st().logicalEdit.create({ name: 'Film catalogue' });
    const after = await st().logicalEdit.apply({ model: made.model, baseRevision: made.revision, changes: additions(), summary: 'Filled in' });
    const before = st().model;
    const m = before.logicalModels[0];
    const film = m.entities.find((e) => e.id === 'e-film')!;
    const key = film.keys.find((k) => k.id === 'k-film-title')!;
    const directed = m.relationships.find((r) => r.id === 'r-directed')!;
    await st().logicalEdit.apply({
      model: made.model,
      baseRevision: after.revision,
      changes: [
        { op: 'update', target: { attribute: 'a-released' }, before: { type: { base: 'date' } }, after: { type: { base: 'dateTime' } } },
        { op: 'update', target: { relationship: 'r-directed' }, before: { ends: directed.ends }, after: { ends: [directed.ends[0], { ...directed.ends[1], max: 'many' }] } },
        { op: 'remove', element: { kind: 'key', entity: 'e-film', key } },
      ],
      summary: 'Three changes',
    });
    const d = difference(before, st().model);
    expect(d.entities).toEqual([]);
    expect(d.axioms).toEqual({ added: 0, removed: 0 });
    expect(d.logicalModels).toEqual([
      {
        id: made.model,
        name: 'Film catalogue',
        status: 'changed',
        changes: [
          { op: 'update', kind: 'attribute', name: 'work.released', fields: [{ field: 'type', before: 'date', after: 'dateTime' }] },
          { op: 'remove', kind: 'key', name: 'title and release of film' },
          { op: 'update', kind: 'relationship', name: 'directed by', fields: [{ field: 'ends', before: 'film as film 0..* to person as director 0..1', after: 'film as film 0..* to person as director 0..*' }] },
        ],
      },
    ]);
  });

  it('says every question, answer and refusal in plain data, the same once it has been through JSON', async () => {
    const { p, id, revision } = await filled();
    const through = <T>(x: T): T => JSON.parse(JSON.stringify(x));
    const ref = { model: id, revision };
    const search = { model: id, search: 'film', offset: 0, limit: 2 };
    const element = { model: id, element: { attribute: 'a-title' } };
    const entity = { model: id, entity: 'e-film' };
    for (const q of [ref, search, element, entity]) expect(through(q)).toEqual(q);
    const answers = [
      await p.query.models(),
      await p.query.model(ref),
      await p.query.entities(search),
      await p.query.describe(element),
      ...(await Promise.all((['e-film', 'e-work'] as const).map((entity) => p.query.describe({ model: id, element: { entity } })))),
      await p.query.describe({ model: id, element: { key: 'k-credit' } }),
      await p.query.describe({ model: id, element: { generalization: 'g-work' } }),
      await p.query.relationships(entity),
    ];
    for (const a of answers) expect(through(a)).toEqual(a);
    const sets: LogicalChangeSet[] = [{ model: id, baseRevision: revision, changes: [...additions().slice(0, 2), { op: 'update', target: { model: true }, before: { name: 'Film catalogue' }, after: { name: 'Films' } }], summary: 'x' }];
    for (const cs of sets) expect(through(cs)).toEqual(cs);
    const refusals = [
      await p.edit.validate({ model: id, baseRevision: revision, changes: additions().slice(0, 1), summary: '' }),
      await p.edit.apply({ model: id, baseRevision: 'r-old', changes: additions().slice(0, 1), summary: '' }).catch((e: LogicalError) => ({ code: e.code, message: e.message, refusals: e.refusals })),
      await p.query.describe({ model: id, element: { entity: 'e-none' } }).catch((e: LogicalError) => ({ code: e.code, message: e.message, refusals: e.refusals })),
    ];
    expect(refusals[0]).toMatchObject({ ok: false, refusals: [{ code: 'refused', element: { domain: 'd-rating' } }] });
    expect(refusals.slice(1).map((r) => (r as { code: string }).code)).toEqual(['stale-revision', 'not-found']);
    for (const r of refusals) expect(through(r)).toEqual(r);
  });

  it('keeps an edit of a 2,000-entity LDM under 100 ms on the page (NFR-19)', async () => {
    const big: LogicalModel = {
      id: 'ldm-big',
      name: 'Big',
      description: '',
      purpose: '',
      revision: 'r-1',
      domains: [],
      entities: Array.from({ length: 2000 }, (_, i) => ({ id: `e${i}`, name: `entity ${i}`, definition: '', attributes: Array.from({ length: 15 }, (_x, j) => ({ id: `e${i}a${j}`, name: `attribute ${j}`, definition: '', type: { base: 'text' as const }, optional: true })), keys: [{ id: `e${i}k`, kind: 'primary' as const, name: 'key', members: [{ attribute: `e${i}a0` }] }] })),
      relationships: Array.from({ length: 1999 }, (_, i) => ({ id: `r${i}`, name: 'next', definition: '', identifying: false, ends: [{ entity: `e${i}`, role: '', min: 0, max: 'many' as const }, { entity: `e${i + 1}`, role: '', min: 0, max: 1 }] as LogicalModel['relationships'][number]['ends'] })),
      generalizations: [],
      rules: [],
      mappings: [],
      diagrams: [],
    };
    st().apply((m) => ({ ...m, logicalModels: [big] }));
    let revision = 'r-1';
    const times: number[] = [];
    for (let n = 0; n < 5; n++) {
      const t0 = performance.now();
      revision = (await st().logicalEdit.apply({ model: 'ldm-big', baseRevision: revision, changes: [{ op: 'add', element: { kind: 'attribute', entity: `e${n}`, attribute: { id: `new${n}`, name: 'added', definition: '', type: { base: 'integer' }, optional: true } } }], summary: 'Added' })).revision;
      times.push(performance.now() - t0);
    }
    expect(Math.min(...times)).toBeLessThan(100);
  });
});
