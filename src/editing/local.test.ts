import { beforeEach, describe, expect, it } from 'vitest';
import { withDatatype } from '../model/domains';
import { withIris } from '../model/iri';
import { toTurtle } from '../model/rdf';
import { isDirty, useStore } from '../model/store';
import { newProp, newRelation, newTerm, emptyModel, type Model } from '../model/types';
import { statementsOf } from '../model/unmapped';
import { ontologyRef, revisionOf, WORKING_COPY } from '../structure/local';
import { statementOf } from './axioms';
import { EditError, type Axiom, type ChangeSet } from './contracts';
import { changesBetween, checkpointed, committed, opened, redone, summaryOf, undone } from './local';

const S = 'http://example.org/s#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

/** Classes, a data property, two individuals and an object property. */
const studio = (): Model => {
  const m = emptyModel('Studio');
  m.baseIri = S;
  m.terms = [
    newTerm({ id: 'film', name: 'Film', x: 10, y: 20 }),
    newTerm({ id: 'work', name: 'Work', x: 30, y: 40 }),
    newTerm({ id: 'award', name: 'Award' }),
    newTerm({ id: 'title', name: 'title', type: 'property', ranges: withDatatype({}, 'xsd:string') }),
    newTerm({ id: 'year', name: 'year', type: 'property', ranges: withDatatype({}, 'xsd:integer') }),
    newTerm({ id: 'parasite', name: 'Parasite', type: 'instance' }),
    newTerm({ id: 'bong', name: 'Bong', type: 'instance' }),
  ];
  m.props = [newProp({ id: 'dir', name: 'directed by', description: 'Who directed it.', chars: [] })];
  m.relations = [newRelation({ id: 'isa', from: 'film', to: 'work', kind: 'generalization' }), newRelation({ id: 'type', from: 'parasite', to: 'film', kind: 'generalization' })];
  return withIris(m);
};

const st = useStore.getState;
const texts = (m: Model) => new Set(statementsOf(toTurtle(m)).map((s) => s.text));
const cls = (name: string) => ({ type: 'Class' as const, iri: S + name });
const changeSet = (changes: ChangeSet['changes'], summary = 'From elsewhere'): ChangeSet => ({ ontologyId: WORKING_COPY, baseRevision: revisionOf(st().model), changes, summary });
const add = (axiom: Axiom) => ({ op: 'add' as const, axiom });
const remove = (axiom: Axiom) => ({ op: 'remove' as const, axiom });
const refusalOf = async (cs: ChangeSet) => {
  try {
    await st().editService.apply(cs);
  } catch (e) {
    return e as EditError;
  }
  throw new Error('It was applied.');
};

beforeEach(() => {
  st().replaceModel(studio());
  useStore.setState({ toast: null });
});

describe('the history of the document', () => {
  it('is a step for each edit, which undo applies backwards and redo forwards', () => {
    const d0 = opened(studio());
    const renamed = { ...d0.model, terms: d0.model.terms.map((t) => (t.id === 'film' ? { ...t, name: 'Movie' } : t)) };
    const d1 = committed(d0, renamed);
    expect(d1.past).toHaveLength(1);
    expect(Object.keys(d1.past[0].patch.after)).toEqual(['terms']);
    const back = undone(d1)!;
    // Only what the step replaced is put back: every other part is the very part it was.
    expect(back.model.terms).toBe(d0.model.terms);
    expect(back.model.relations).toBe(d0.model.relations);
    expect(back.version).toEqual(d0.version);
    expect(redone(back)!.model.terms).toBe(renamed.terms);
    expect(redone(back)!.version.state).toBe(d1.version.state);
  });

  it('lets an edit that is not recorded join the last step, and forget what was undone', () => {
    const d0 = opened(studio());
    const moved = (m: Model, dx: number) => ({ ...m, terms: m.terms.map((t) => (t.id === 'film' ? { ...t, x: t.x + dx } : t)) });
    // A drag: a step begun, then every frame joins it.
    let d = checkpointed(d0);
    d = committed(d, moved(d.model, 5), false);
    d = committed(d, moved(d.model, 5), false);
    expect(d.past).toHaveLength(1);
    expect(d.model.terms.find((t) => t.id === 'film')!.x).toBe(20);
    expect(summaryOf(d.past[0].patch)).toBe('Moved “Film”');
    const back = undone(d)!;
    expect(back.model.terms).toBe(d0.model.terms);
    // An edit after an undo, recorded or not, means the step undone is not made again.
    expect(committed(back, moved(back.model, 1), false).future).toEqual([]);
  });

  it('does not undo a step onto a model it was not made to', () => {
    const d0 = opened(studio());
    const d1 = committed(d0, { ...d0.model, name: 'Other' });
    expect(undone({ ...d1, model: { ...d1.model, name: 'Changed behind its back' } })).toBeUndefined();
  });

  it('is clean again when undone back to what was saved, and the same revision as before', () => {
    const ref = ontologyRef(st().model, null);
    expect(isDirty(st())).toBe(false);
    st().updateTerm('film', { name: 'Movie' });
    expect(isDirty(st())).toBe(true);
    expect(ontologyRef(st().model, null).revisionId).not.toBe(ref.revisionId);
    st().undo();
    expect(isDirty(st())).toBe(false);
    // What was worked out for that revision holds again.
    expect(ontologyRef(st().model, null)).toEqual(ref);
    expect(st().version.revision).toBe(ref.revisionId);
    // Moving a term is a change to save, but not a new revision of the ontology.
    st().checkpoint();
    st().moveTerms(['film'], 10, 0);
    expect(isDirty(st())).toBe(true);
    expect(st().version.revision).toBe(ref.revisionId);
    st().undo();
    expect(isDirty(st())).toBe(false);
  });

  it('gives each step as a change set of axioms when asked', () => {
    const base = st().version.revision;
    st().edit((m) => ({ model: { ...m, terms: m.terms.map((t) => (t.id === 'film' ? { ...t, description: 'Moving pictures.' } : t)) } }));
    st().updateTerm('work', { name: 'Opus' });
    const sets = [0, 1].map((i) => st().changeSetOf(i)!);
    expect(st().changeSetOf(2)).toBeUndefined();
    expect(sets[0].summary).toBe('Changed “Film”');
    expect(sets[0].changes).toEqual([add({ type: 'AnnotationAssertion', property: 'http://www.w3.org/2004/02/skos/core#definition', subject: S + 'Film', value: { value: 'Moving pictures.' } })]);
    // A rename changes the label, and nothing else: the IRI stays.
    expect(sets[1].changes).toEqual([remove({ type: 'AnnotationAssertion', property: RDFS + 'label', subject: S + 'Work', value: { value: 'Work' } }), add({ type: 'AnnotationAssertion', property: RDFS + 'label', subject: S + 'Work', value: { value: 'Opus' } })]);
    // Each is made against the revision before it.
    expect(sets.map((c) => c.baseRevision)).toEqual([base, st().past[1].base.revision]);
    expect(sets[1].baseRevision).not.toBe(base);
  });
});

describe('a change set made elsewhere', () => {
  it('is the same edit as the one it describes: applied to the model before, it states what the model after does', async () => {
    const edits: [string, () => void][] = [
      ['a superclass', () => st().addRelation({ from: 'award', to: 'work', kind: 'generalization' })],
      ['a rename', () => st().updateTerm('film', { name: 'Movie' })],
      ['a class', () => st().addTerm({ name: 'Studio' })],
      ['a class removed', () => st().remove(['award'], [])],
      ['a membership', () => st().addRelation({ from: 'bong', to: 'work' })],
      ['a fact', () => st().addRelation({ from: 'parasite', to: 'bong', label: 'directed by' })],
      ['a restriction', () => st().addRelation({ from: 'film', to: 'award', label: 'won' })],
      ['a value', () => st().edit((m) => ({ model: { ...m, terms: m.terms.map((t) => (t.id === 'parasite' ? { ...t, values: [{ prop: 'year', value: '2019' }] } : t)) } }))],
    ];
    for (const [what, edit] of edits) {
      st().replaceModel(studio());
      const before = st().model;
      edit();
      const after = st().model;
      const changes = changesBetween(before, after);
      expect(changes.length, what).toBeGreaterThan(0);
      st().replaceModel(before);
      await st().editService.apply(changeSet(changes, what));
      expect(texts(st().model), what).toEqual(texts(after));
      // What the statements do not say is as it was: where the terms sit, and their ids.
      const film = st().model.terms.find((t) => t.iri === S + 'Film');
      if (film) expect([film.id, film.x, film.y], what).toEqual(['film', 10, 20]);
    }
  });

  it('is one step of the history, which undo takes back', async () => {
    const before = st().model;
    const steps = st().past.length;
    const applied = await st().editService.apply(changeSet([add({ type: 'SubClassOf', sub: cls('Award'), sup: cls('Work') })], 'Award is a kind of Work'));
    expect(st().past.length).toBe(steps + 1);
    expect(applied.revisionId).toBe(revisionOf(st().model));
    expect(applied.revisionId).not.toBe(revisionOf(before));
    // The terms that were there are the very terms they were.
    expect(st().model.terms.find((t) => t.id === 'film')).toBe(before.terms.find((t) => t.id === 'film'));
    st().undo();
    expect(texts(st().model)).toEqual(texts(before));
    expect(revisionOf(st().model)).toBe(revisionOf(before));
  });

  it('is refused whole when one of its changes makes no sense, and nothing changes', async () => {
    const before = st().model;
    const e = await refusalOf(
      changeSet([
        add({ type: 'SubClassOf', sub: cls('Award'), sup: cls('Work') }),
        remove({ type: 'SubClassOf', sub: cls('Award'), sup: cls('Film') }),
        add({ type: 'SubClassOf', sub: cls('Film'), sup: cls('Work') }),
      ]),
    );
    expect(e.code).toBe('refused');
    expect(e.refusals).toEqual([
      { code: 'invalid', message: 'SubClassOf(Award Film) is not stated, so it cannot be removed.' },
      { code: 'invalid', message: 'SubClassOf(Film Work) is stated already.' },
    ]);
    expect(st().model).toBe(before);
  });

  it('is held to the rules an edit in the editor is', async () => {
    const v = await st().editService.validate(changeSet([add({ type: 'SubClassOf', sub: cls('Award'), sup: cls('Award') }), add({ type: 'DataPropertyAssertion', property: S + 'year', source: S + 'Parasite', value: { value: 'last year' } })]));
    expect(v.ok).toBe(false);
    expect(v.refusals.map((r) => r.code)).toEqual(['refused', 'refused']);
    expect(v.refusals[0].message).toBe('“Award” cannot be its own superclass.');
    expect(v.refusals[1].message).toMatch(/last year/);
    // What a rule allows but has something to say about, it says.
    const cycle = await st().editService.apply(changeSet([add({ type: 'SubClassOf', sub: cls('Work'), sup: cls('Film') })]));
    expect(cycle.notes).toEqual(['“Film” is already a kind of “Work”, so the two are now each other\'s superclass. Validation lists this as a circular hierarchy.']);
  });

  it('is held to them once what it removes is gone', async () => {
    // Film is a Work; the change set takes that back and says the opposite, which is no cycle.
    const applied = await st().editService.apply(changeSet([remove({ type: 'SubClassOf', sub: cls('Film'), sup: cls('Work') }), add({ type: 'SubClassOf', sub: cls('Work'), sup: cls('Film') })]));
    expect(applied.notes).toEqual([]);
    expect(st().model.relations.find((r) => r.kind === 'generalization' && r.from === 'work')?.to).toBe('film');
  });

  it('is refused when the editor would not hold its result as it was asked for', async () => {
    // A class of the ontology's own is given a name by the editor, which it then states.
    const unnamed = await refusalOf(changeSet([add({ type: 'Declaration', entity: 'Class', iri: S + 'Unnamed' })]));
    expect(unnamed.refusals[0].code).toBe('unsupported');
    expect(unnamed.refusals[0].message).toMatch(/0 statement\(s\) would be lost and 1 added/);
    // The model holds disjointness two classes at a time.
    const three = await refusalOf(changeSet([add({ type: 'DisjointClasses', classes: [cls('Film'), cls('Award'), cls('Work')] })]));
    expect(three.refusals[0].code).toBe('unsupported');
    // With its name it is held.
    await st().editService.apply(changeSet([add({ type: 'Declaration', entity: 'Class', iri: S + 'Genre' }), add({ type: 'AnnotationAssertion', property: RDFS + 'label', subject: S + 'Genre', value: { value: 'Genre' } })]));
    expect(st().model.terms.map((t) => t.name)).toContain('Genre');
  });

  it('is refused against a revision that is no longer the one being edited, or another ontology', async () => {
    const old = changeSet([add({ type: 'SubClassOf', sub: cls('Award'), sup: cls('Work') })]);
    st().updateTerm('film', { name: 'Movie' });
    await expect(st().editService.apply(old)).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(st().editService.validate({ ...changeSet([]), ontologyId: 'another' })).rejects.toMatchObject({ code: 'not-found' });
    const gone = new AbortController();
    gone.abort();
    await expect(st().editService.apply(changeSet([]), { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('cannot name an axiom that is not one statement', async () => {
    const e = await refusalOf(changeSet([add({ type: 'Unmapped', turtle: '<urn:a> <urn:p> <urn:b> . <urn:c> <urn:p> <urn:d> .' })]));
    expect(e.refusals[0]).toMatchObject({ code: 'invalid' });
  });
});

describe('what is stated about an entity', () => {
  it('is its axioms as the contract has them', async () => {
    const ref = ontologyRef(st().model, null);
    const film = await st().editService.entity({ ...ref, iri: S + 'Film' });
    expect(film.axioms).toEqual(
      expect.arrayContaining([
        { type: 'Declaration', entity: 'Class', iri: S + 'Film' },
        { type: 'AnnotationAssertion', property: RDFS + 'label', subject: S + 'Film', value: { value: 'Film' } },
        { type: 'SubClassOf', sub: cls('Film'), sup: cls('Work') },
      ]),
    );
    for (const a of film.axioms) expect(statementOf(a)).toBeTruthy();
    st().updateTerm('film', { name: 'Movie' });
    await expect(st().editService.entity({ ...ref, iri: S + 'Film' })).rejects.toBeInstanceOf(EditError);
  });
});
