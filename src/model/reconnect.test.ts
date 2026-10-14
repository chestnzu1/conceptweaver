import { withDatatype } from './domains';
import { beforeEach, describe, expect, it } from 'vitest';
import { withAnchor } from './graphStyle';
import { withIris } from './iri';
import { restrictionSpecs } from './props';
import { toTurtle } from './rdf';
import { fixedBecause, meaningOf, reconnect, reconnection, type End } from './reconnect';
import { skosSample } from './sample';
import { stable } from './stable';
import { useStore } from './store';
import { newProp, emptyModel, newRelation, newTerm, type Model, type Relation } from './types';

/**
 * A small ontology with one relationship of every kind an ontology has: a superclass, a use of an
 * object property between two classes, a class that has a data property, a class membership, a
 * fact between two individuals and a sub-property.
 */
const studio = (): Model => {
  const m = emptyModel('Studio');
  m.baseIri = 'http://example.org/s#';
  m.terms = [
    newTerm({ id: 'film', name: 'Film' }),
    newTerm({ id: 'work', name: 'Work' }),
    newTerm({ id: 'award', name: 'Award' }),
    newTerm({ id: 'person', name: 'Person' }),
    newTerm({ id: 'title', name: 'title', type: 'property', ranges: withDatatype({}, 'xsd:string') }),
    newTerm({ id: 'label', name: 'label', type: 'property' }),
    newTerm({ id: 'parasite', name: 'Parasite', type: 'instance' }),
    newTerm({ id: 'bong', name: 'Bong', type: 'instance' }),
  ];
  m.props = [newProp({ name: 'directed by', description: 'Who directed it.', chars: [] })];
  m.relations = [
    newRelation({ id: 'isa', from: 'film', to: 'work', kind: 'generalization' }),
    newRelation({ id: 'uses', from: 'film', to: 'person', label: 'directed by', restriction: 'only', more: [{ restriction: 'min', restrictionN: 1 }] }),
    newRelation({ id: 'has', from: 'film', to: 'title', kind: 'property' }),
    newRelation({ id: 'type', from: 'parasite', to: 'film', kind: 'generalization' }),
    newRelation({ id: 'fact', from: 'parasite', to: 'bong', label: 'directed by' }),
    newRelation({ id: 'sub', from: 'title', to: 'label', kind: 'generalization' }),
  ];
  return withIris(m);
};

const rel = (m: Model, id: string): Relation => m.relations.find((r) => r.id === id)!;
/** The terms an end can be put on, other than the one it is on. */
const takers = (m: Model, id: string, end: End) => {
  const plan = reconnection(m, id, end)!;
  return m.terms.filter((t) => t.id !== plan.moving && plan.refusal(t.id) === undefined).map((t) => t.id);
};
const st = useStore.getState;

describe('which terms can take an end', () => {
  it('follows what each kind of relationship joins', () => {
    const m = studio();
    // Is a: a class and a class.
    expect(takers(m, 'isa', 'to')).toEqual(['award', 'person']);
    expect(takers(m, 'isa', 'from')).toEqual(['award', 'person']);
    // Is an instance of: from an individual to a class.
    expect(takers(m, 'type', 'from')).toEqual(['bong']);
    expect(takers(m, 'type', 'to')).toEqual(['work', 'award', 'person']);
    // Has data property: from a class to a data property.
    expect(takers(m, 'has', 'from')).toEqual(['work', 'award', 'person']);
    expect(takers(m, 'has', 'to')).toEqual(['label']);
    // A use of an object property between two classes stays between two classes; itself included, as a loop.
    expect(takers(m, 'uses', 'to')).toEqual(['film', 'work', 'award']);
    expect(takers(m, 'uses', 'from')).toEqual(['work', 'award', 'person']);
    // A fact between two individuals stays between two individuals.
    expect(takers(m, 'fact', 'to')).toEqual(['parasite']);
    // A sub-property stays between two data properties, and with two there is nowhere for it to go.
    expect(takers(m, 'sub', 'to')).toEqual([]);
  });

  it('says in words why a term cannot take an end', () => {
    const m = studio();
    expect(reconnection(m, 'isa', 'to')!.refusal('parasite')).toBe('“is a” needs a class at this end: “Parasite” is an individual.');
    expect(reconnection(m, 'isa', 'to')!.refusal('title')).toBe('“is a” needs a class at this end: “title” is a data property.');
    expect(reconnection(m, 'type', 'to')!.refusal('bong')).toBe('“is an instance of” needs a class at this end: “Bong” is an individual.');
    expect(reconnection(m, 'type', 'from')!.refusal('work')).toBe('“is an instance of” needs an individual at this end: “Work” is a class.');
    expect(reconnection(m, 'has', 'to')!.refusal('work')).toBe('“has data property” needs a data property at this end: “Work” is a class.');
    expect(reconnection(m, 'uses', 'to')!.refusal('bong')).toBe('The object property “directed by” needs a class at this end: “Bong” is an individual.');
    expect(reconnection(m, 'fact', 'to')!.refusal('person')).toBe('The object property “directed by” needs an individual at this end: “Person” is a class.');
    expect(reconnection(m, 'isa', 'to')!.refusal('film')).toBe('“Film” cannot be a kind of itself.');
    expect(reconnection(m, 'isa', 'to')!.refusal('gone')).toBe('That term no longer exists.');
    // The term it is on can always keep it.
    expect(reconnection(m, 'isa', 'to')!.refusal('work')).toBeUndefined();
    expect(reconnection(m, 'gone', 'to')).toBeUndefined();
  });

  it('answers the same when the end is let go as while it was dragged, for every end and every term', () => {
    const m = studio();
    for (const r of m.relations) {
      for (const end of ['from', 'to'] as const) {
        const plan = reconnection(m, r.id, end)!;
        for (const t of m.terms) {
          const result = reconnect(m, r.id, end, t.id);
          expect(result.error === undefined, `${r.id} ${end} → ${t.id}`).toBe(plan.refusal(t.id) === undefined);
          if (result.error !== undefined) {
            expect(result.model).toBeUndefined();
            continue;
          }
          // What the relationship is has not changed, whatever it now joins.
          expect(meaningOf(result.model, rel(result.model, r.id))).toEqual(meaningOf(m, r));
          expect(rel(result.model, r.id)[end]).toBe(t.id);
        }
      }
    }
  });
});

describe('moving an end', () => {
  it('changes the one statement, and nothing else of the model', () => {
    const m = studio();
    const out = reconnect(m, 'isa', 'to', 'award');
    expect(out.error).toBeUndefined();
    const next = out.model!;
    expect(rel(next, 'isa')).toEqual({ ...rel(m, 'isa'), to: 'award' });
    // No term, no property and no other relationship was made, removed or rewritten.
    expect(next.terms).toBe(m.terms);
    expect(next.props).toBe(m.props);
    expect(next.relations.filter((r) => r.id !== 'isa')).toEqual(m.relations.filter((r) => r.id !== 'isa'));
    expect(next.relations.map((r) => r.id)).toEqual(m.relations.map((r) => r.id));
    // The model that was asked about is as it was.
    expect(rel(m, 'isa').to).toBe('work');
    const ttl = toTurtle(next);
    expect(ttl).toContain(':Film a owl:Class');
    expect(ttl).toMatch(/:Film a owl:Class[^.]*rdfs:subClassOf :Award/s);
    expect(ttl).not.toMatch(/rdfs:subClassOf :Work\b/);
  });

  it('never makes the relationship another kind to fit where it was dropped', () => {
    const m = studio();
    // Between a class and a data property a line says "has data property". An "is a" is not turned into one.
    const onProperty = reconnect(m, 'isa', 'to', 'title');
    expect(onProperty.error).toMatch(/“is a” needs a class at this end/);
    expect(onProperty.model).toBeUndefined();
    // Nor into a class membership, by being started from an individual.
    expect(reconnect(m, 'isa', 'from', 'parasite').error).toMatch(/needs a class/);
    // Nor a membership into a superclass, by being started from a class.
    expect(reconnect(m, 'type', 'from', 'work').error).toMatch(/needs an individual/);
    // Nor a use of an object property into a membership.
    expect(reconnect(m, 'uses', 'to', 'parasite').error).toMatch(/needs a class/);
  });

  it('keeps the restrictions, the name and the id of the relationship', () => {
    const m = studio();
    const next = reconnect(m, 'uses', 'to', 'award').model!;
    const moved = rel(next, 'uses');
    expect(moved).toEqual({ ...rel(m, 'uses'), to: 'award' });
    expect(restrictionSpecs(moved)).toEqual([{ restriction: 'only' }, { restriction: 'min', restrictionN: 1 }]);
    const ttl = toTurtle(next);
    expect(ttl).toMatch(/owl:onProperty :directedBy ;\s*owl:allValuesFrom :Award/);
    expect(ttl).toMatch(/owl:minQualifiedCardinality "1"\^\^xsd:nonNegativeInteger ;\s*owl:onClass :Award/);
    expect(ttl).not.toMatch(/owl:allValuesFrom :Person/);
    // From its other end the restriction moves to another class: Film is no longer restricted.
    const from = reconnect(m, 'uses', 'from', 'work').model!;
    expect(toTurtle(from)).toMatch(/:Work a owl:Class[^.]*owl:onProperty :directedBy/s);
    expect(toTurtle(from)).not.toMatch(/:Film a owl:Class[^.]*owl:onProperty :directedBy/s);
  });

  it('does not state the same thing twice', () => {
    let m = studio();
    m = { ...m, relations: [...m.relations, newRelation({ id: 'isa2', from: 'film', to: 'award', kind: 'generalization' }), newRelation({ id: 'type2', from: 'bong', to: 'person', kind: 'generalization' }), newRelation({ id: 'has2', from: 'work', to: 'title', kind: 'property' })] };
    expect(reconnect(m, 'isa2', 'to', 'work').error).toBe('It is already stated that “Film” is a kind of “Work”.');
    expect(reconnect(m, 'type2', 'to', 'film').error).toBeUndefined();
    expect(reconnect(m, 'type2', 'from', 'parasite').error).toBeUndefined();
    const twice = { ...m, relations: [...m.relations, newRelation({ id: 'type3', from: 'bong', to: 'film', kind: 'generalization' })] };
    expect(reconnect(twice, 'type2', 'to', 'film').error).toBe('It is already stated that “Bong” is an instance of “Film”.');
    expect(reconnect(m, 'has2', 'to', 'label').error).toBeUndefined();
    expect(reconnect(m, 'has2', 'from', 'film').error).toBe('It is already stated that “Film” has the data property “title”.');
    // The same property between the same two classes with another restriction says something else.
    const some = { ...m, relations: [...m.relations, newRelation({ id: 'uses2', from: 'film', to: 'award', label: 'directed by' })] };
    expect(reconnect(some, 'uses2', 'to', 'person').error).toBeUndefined();
    const same = { ...m, relations: [...m.relations, newRelation({ id: 'uses2', from: 'film', to: 'award', label: 'directed by', restriction: 'only', more: [{ restriction: 'min', restrictionN: 1 }] })] };
    expect(reconnect(same, 'uses2', 'to', 'person').error).toBe('It is already stated that “Film” directed by “Person”.');
  });

  it('allows a circular hierarchy as adding a superclass does, and says so', () => {
    let m = studio();
    m = { ...m, relations: [...m.relations, newRelation({ id: 'up', from: 'work', to: 'award', kind: 'generalization' })] };
    const out = reconnect(m, 'up', 'to', 'film');
    expect(out.error).toBeUndefined();
    expect(out.note).toMatch(/Validation lists this as a circular hierarchy/);
  });

  it('leaves the term it is on alone when it is let go there', () => {
    const m = studio();
    expect(reconnect(m, 'isa', 'to', 'work').model).toBe(m);
  });

  it('holds a standard property to what it is meant to connect, and to what cannot hold with it', () => {
    let m = studio();
    m = { ...m, vocab: { enabled: true, map: {} }, relations: [...m.relations, newRelation({ id: 'apart', from: 'film', to: 'award', predicate: 'owl:disjointWith' }), newRelation({ id: 'same', from: 'film', to: 'work', predicate: 'owl:equivalentClass' }), newRelation({ id: 'apart2', from: 'person', to: 'film', predicate: 'owl:disjointWith' })] };
    expect(meaningOf(m, rel(m, 'apart'))).toEqual({ meaning: 'standard', predicate: 'owl:disjointWith' });
    const plan = reconnection(m, 'apart', 'to')!;
    expect(plan.refusal('parasite')).toBe('“owl:disjointWith” needs a class at this end: “Parasite” is an individual.');
    expect(plan.refusal('film')).toBe('“Film” cannot be disjoint with itself.');
    // Stated the other way round already: it holds both ways.
    expect(plan.refusal('person')).toBe('It is already stated that “Film” is disjoint with “Person”.');
    expect(plan.refusal('work')).toBe('“Film” is stated to be equivalent to “Work”. Both cannot hold; remove that statement first.');
    expect(reconnect(m, 'apart', 'to', 'work').error).toMatch(/Both cannot hold/);
    const moved = reconnect(m, 'apart', 'from', 'work').model!;
    expect(rel(moved, 'apart')).toEqual({ ...rel(m, 'apart'), from: 'work' });
    expect(toTurtle(moved)).toMatch(/:Work a owl:Class[^.]*owl:disjointWith :Award/s);
  });

  it('gives a relationship of a kind the ontology no longer has a kind first', () => {
    let m = studio();
    // A relationship from before ontologies stopped having plain ones: its name is no object property.
    m = { ...m, relations: [...m.relations, newRelation({ id: 'old', from: 'film', to: 'award', label: 'wins' })] };
    expect(meaningOf(m, rel(m, 'old')).meaning).toBe('plain');
    expect(reconnect(m, 'old', 'to', 'work').error).toMatch(/An OWL ontology has no relationships of this kind\. Choose what this one is first/);
  });

  it('leaves what another ontology says, and what is kept as a mapping, where it is', () => {
    let m = studio();
    m = {
      ...m,
      terms: [...m.terms, newTerm({ id: 'agent', name: 'Agent', iri: 'http://example.org/org#Agent', external: 'org' }), newTerm({ id: 'member', name: 'Member', iri: 'http://example.org/org#Member', external: 'org' })],
      relations: [...m.relations, newRelation({ id: 'theirs', from: 'member', to: 'agent', kind: 'generalization' }), newRelation({ id: 'map', from: 'person', to: 'agent', kind: 'generalization' }), newRelation({ id: 'reuse', from: 'film', to: 'agent', label: 'directed by' })],
    };
    expect(fixedBecause(m, 'theirs')).toMatch(/both belong to other ontologies/);
    expect(fixedBecause(m, 'map')).toMatch(/^This is a mapping to another ontology \(Person rdfs:subClassOf Agent\)\. Mappings are kept under Align/);
    expect(reconnect(m, 'map', 'to', 'work').error).toMatch(/Mappings are kept under Align/);
    expect(reconnect(m, 'theirs', 'from', 'person').error).toMatch(/said there/);
    expect(takers(m, 'map', 'from')).toEqual([]);
    // A class of this ontology restricted to a class of another is this ontology's statement.
    expect(fixedBecause(m, 'reuse')).toBeUndefined();
    expect(reconnect(m, 'reuse', 'to', 'person').error).toBeUndefined();
    expect(fixedBecause(m, 'isa')).toBeUndefined();
  });

  it('puts the end that moved where the layout puts it, and leaves the other where it was dragged to', () => {
    let m = studio();
    m = { ...m, style: withAnchor(withAnchor(m.style, 'isa', 'from', { side: 'left', at: 0.2 }), 'isa', 'to', { side: 'top', at: 0.8 }) };
    const next = reconnect(m, 'isa', 'to', 'award').model!;
    expect(next.style.anchors.isa).toEqual({ from: { side: 'left', at: 0.2 } });
    // Refused, nothing of the picture changes either.
    expect(reconnect(m, 'isa', 'to', 'title').model).toBeUndefined();
    expect(m.style.anchors.isa).toEqual({ from: { side: 'left', at: 0.2 }, to: { side: 'top', at: 0.8 } });
  });

  it('works in a vocabulary, where every term is a concept', () => {
    const m = skosSample();
    const broader = m.relations.find((r) => r.kind === 'generalization')!;
    const plan = reconnection(m, broader.id, 'to')!;
    expect(plan.meaning).toBe('generalization');
    expect(plan.refusal(broader.from)).toMatch(/cannot be a kind of itself/);
    const free = m.terms.find((t) => t.id !== broader.from && t.id !== broader.to && plan.refusal(t.id) === undefined)!;
    const next = reconnect(m, broader.id, 'to', free.id).model!;
    expect(rel(next, broader.id)).toEqual({ ...broader, to: free.id });
    // A plain relationship asserts nothing: there may be two between the same concepts.
    const [a, b, c] = m.terms;
    const lines = { ...m, relations: [...m.relations, newRelation({ id: 'p1', from: a.id, to: b.id, label: 'near' }), newRelation({ id: 'p2', from: a.id, to: c.id, label: 'near' })] };
    expect(meaningOf(lines, rel(lines, 'p2')).meaning).toBe('plain');
    expect(reconnect(lines, 'p2', 'to', b.id).error).toBeUndefined();
  });
});

describe('reconnecting from the editor', () => {
  beforeEach(() => {
    st().replaceModel(studio());
    useStore.setState({ toast: null });
  });

  it('is one step, which undo takes back and redo makes again', () => {
    st().setAnchor('isa', 'to', { side: 'top', at: 0.25 });
    const before = st().model;
    const steps = st().past.length;
    expect(st().reconnectRelation('isa', 'to', 'award')).toBe(true);
    expect(st().past.length).toBe(steps + 1);
    expect(rel(st().model, 'isa').to).toBe('award');
    expect(st().model.style.anchors.isa).toBeUndefined();
    st().undo();
    expect(st().model).toBe(before);
    expect(rel(st().model, 'isa').to).toBe('work');
    expect(st().model.style.anchors.isa).toEqual({ to: { side: 'top', at: 0.25 } });
    st().redo();
    expect(rel(st().model, 'isa').to).toBe('award');
  });

  it('changes nothing where it is refused, and says why', () => {
    const before = st().model;
    const steps = st().past.length;
    expect(st().reconnectRelation('isa', 'to', 'parasite')).toBe(false);
    expect(st().model).toBe(before);
    expect(st().past.length).toBe(steps);
    expect(st().toast).toBe('“is a” needs a class at this end: “Parasite” is an individual.');
    // Nothing to undo: the step before is still the last one.
    expect(st().reconnectRelation('gone', 'to', 'work')).toBe(false);
    expect(st().model).toBe(before);
  });

  it('keeps where a line meets its term apart from what the model says', () => {
    const before = st().model;
    const said = stable(before);
    const ttl = toTurtle(before);
    st().setAnchor('isa', 'from', { side: 'bottom', at: 0.3 });
    expect(st().model.style.anchors).toEqual({ isa: { from: { side: 'bottom', at: 0.3 } } });
    // The statements are the very same: nothing is reasoned or validated again for it, and it exports the same.
    expect(st().model.relations).toBe(before.relations);
    expect(stable(st().model)).toBe(said);
    expect(toTurtle(st().model)).toBe(ttl);
    // It is undone like any other change to the picture.
    st().undo();
    expect(st().model.style.anchors).toEqual({});
    st().redo();
    st().setAnchor('isa', 'to', { side: 'left', at: 0.5 });
    st().resetAnchors(['isa']);
    expect(st().model.style.anchors).toEqual({});
    st().setAnchor('gone', 'to', { side: 'left', at: 0.5 });
    expect(st().model.style.anchors).toEqual({});
  });
});
