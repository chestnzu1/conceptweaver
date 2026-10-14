import { describe, expect, it } from 'vitest';
import { inferredRestrictions } from './inferred';
import { newProp, emptyModel, newRelation, newTerm, type Model, type Quantifier } from './types';

/** "Actor < Person" for is-a, "Person -hasPart some-> Body" for a restriction, "Person has Name:xsd:string" for a data property. */
function build(lines: string[], patch: (m: Model, id: Record<string, string>) => void = () => {}) {
  const m = emptyModel('Test');
  m.vocab.enabled = true;
  const id: Record<string, string> = {};
  const term = (name: string, type: 'concept' | 'property' = 'concept', range?: string) => {
    if (!id[name]) {
      const t = newTerm({ name, type, ...(range ? { range } : {}) });
      id[name] = t.id;
      m.terms.push(t);
    }
    return id[name];
  };
  for (const line of lines) {
    let x;
    if ((x = line.match(/^(.+) < (.+)$/))) m.relations.push(newRelation({ from: term(x[1]), to: term(x[2]), kind: 'generalization' }));
    else if ((x = line.match(/^(.+) = (.+)$/))) m.relations.push(newRelation({ from: term(x[1]), to: term(x[2]), predicate: 'owl:equivalentClass' }));
    else if ((x = line.match(/^(.+) -(\S+) (\w+)(?: (\d+))?-> (.+)$/))) {
      if (!m.props.some((p) => p.name === x![2])) m.props.push(newProp({ name: x[2], description: '', chars: [] }));
      m.relations.push(newRelation({ from: term(x[1]), to: term(x[5]), label: x[2], ...(x[3] !== 'some' ? { restriction: x[3] as Quantifier } : {}), ...(x[4] ? { restrictionN: Number(x[4]) } : {}) }));
    } else if ((x = line.match(/^(.+) has ([^:]+):(.+)$/))) m.relations.push(newRelation({ from: term(x[1]), to: term(x[2], 'property', x[3]), kind: 'property' }));
    else term(line);
  }
  patch(m, id);
  return { m, id };
}
const show = (m: Model, classId: string) => inferredRestrictions(m, classId).restrictions.map((r) => `${r.restriction.text} ← ${r.sources.map((s) => s.name + (s.equivalent ? ' (equivalent)' : '')).join(', ')}`);

describe('inferred restrictions', () => {
  it('shows a subclass the restrictions of its superclass, on data and object properties', () => {
    const { m, id } = build(['Person has hasName:xsd:string', 'Person -livesIn some-> Place', 'Actor < Person']);
    expect(show(m, id.Actor)).toEqual(['hasName some xsd:string ← Person', 'livesIn some Place ← Person']);
    // The class they are stated on has them as asserted, not as inferred.
    expect(show(m, id.Person)).toEqual([]);
    expect(inferredRestrictions(m, id.Actor).status).toBe('ok');
    // Nothing was added to the model.
    expect(m.relations).toHaveLength(3);
  });

  it('goes up several levels, keeping each kind of restriction as stated', () => {
    const { m, id } = build(['LivingThing has hasStatus:xsd:string', 'Person < LivingThing', 'Actor < Person', 'Actress < Actor', 'Person -hasParent exactly 2-> Person', 'Actor -actsIn only-> Film', 'Person -owns max 3-> Film']);
    expect(show(m, id.Actress)).toEqual(['actsIn only Film ← Actor', 'hasParent exactly 2 Person ← Person', 'owns max 3 Film ← Person', 'hasStatus some xsd:string ← LivingThing']);
    // The reasoner's own justification comes with each source.
    const status = inferredRestrictions(m, id.Actress).restrictions.find((r) => r.restriction.property === 'hasStatus')!;
    expect(status.sources[0]).toMatchObject({ name: 'LivingThing', asserted: false });
    expect(status.sources[0].because).toBe('“Actress” is a kind of “Actor”; “Actor” is a kind of “Person”; “Person” is a kind of “LivingThing”.');
    expect(status.sources[0].rels).toHaveLength(3);
  });

  it('lists a restriction once when it arrives by several routes, naming every source', () => {
    const { m, id } = build(['Actor < Person', 'Employee < Person', 'WorkingActor < Actor', 'WorkingActor < Employee', 'Person has hasName:xsd:string', 'Actor -actsIn some-> Film', 'Employee -actsIn some-> Film', 'Employee -worksFor some-> Company']);
    expect(show(m, id.WorkingActor)).toEqual(['actsIn some Film ← Actor, Employee', 'worksFor some Company ← Employee', 'hasName some xsd:string ← Person']);
  });

  it('leaves out what the class asserts itself, but keeps a different restriction on the same property', () => {
    const { m, id } = build(['Actor < Person', 'Person -knows some-> Person', 'Actor -knows some-> Person', 'Actor -knows only-> Person', 'Person -knows min 2-> Person']);
    expect(show(m, id.Actor)).toEqual(['knows min 2 Person ← Person']);
  });

  it('uses superclasses the reasoner infers: equivalent classes, in both directions', () => {
    const { m, id } = build(['Performer = Actor', 'Actor -actsIn some-> Film', 'Actor < Person', 'Person has hasName:xsd:string', 'Performer -hasAgent some-> Person']);
    // Performer is equivalent to Actor, so it has Actor's restriction, and Person's through Actor.
    expect(show(m, id.Performer).sort()).toEqual(['actsIn some Film ← Actor (equivalent)', 'hasName some xsd:string ← Person']);
    expect(show(m, id.Actor).sort()).toEqual(['hasAgent some Person ← Performer (equivalent)', 'hasName some xsd:string ← Person']);
    expect(inferredRestrictions(m, id.Performer).restrictions.find((r) => r.restriction.property === 'hasName')!.sources[0].because).toContain('is equivalent to');
    // With RDFS & OWL properties switched off the equivalence means nothing, so nothing is inherited through it.
    expect(show({ ...m, vocab: { ...m.vocab, enabled: false } }, id.Performer)).toEqual([]);
  });

  it('follows the model: adding or removing a superclass changes what is inferred', () => {
    const { m, id } = build(['Person has hasName:xsd:string', 'Actor', 'Film']);
    expect(show(m, id.Actor)).toEqual([]);
    const linked = { ...m, relations: [...m.relations, newRelation({ from: id.Actor, to: id.Person, kind: 'generalization' })] };
    expect(show(linked, id.Actor)).toEqual(['hasName some xsd:string ← Person']);
    // Changing the restriction at its source changes it for the subclass.
    const stricter = { ...linked, relations: linked.relations.map((r) => (r.kind === 'property' ? { ...r, restriction: 'exactly' as const, restrictionN: 1 } : r)) };
    expect(show(stricter, id.Actor)).toEqual(['hasName exactly 1 xsd:string ← Person']);
    const unlinked = { ...linked, relations: linked.relations.filter((r) => r.kind !== 'generalization') };
    expect(show(unlinked, id.Actor)).toEqual([]);
  });

  it('inherits class expressions kept as text, without interpreting them', () => {
    const union = '[ a owl:Class ; owl:unionOf ( <http://x.org/A> <http://x.org/B> ) ]';
    const { m, id } = build(['Actor < Person'], (model, ids) => {
      model.terms.find((t) => t.id === ids.Person)!.axioms = [`rdfs:subClassOf ${union}`, 'owl:equivalentClass [ a owl:Restriction ; owl:onProperty <http://x.org/p> ; owl:hasValue <http://x.org/v> ]'];
    });
    const got = inferredRestrictions(m, id.Actor);
    expect(got.expressions.map((e) => `${e.text} ← ${e.sources.map((s) => s.name)}`)).toEqual([`${union} ← Person`, '[ a owl:Restriction ; owl:onProperty <http://x.org/p> ; owl:hasValue <http://x.org/v> ] ← Person']);
    expect(inferredRestrictions(m, id.Person).expressions).toEqual([]);
  });

  it('says so instead of listing anything when the ontology is inconsistent, and flags an unsatisfiable class', () => {
    const { m, id } = build(['Person -knows some-> Person', 'Actor < Person', 'Robot'], (model, ids) => {
      const rex = newTerm({ name: 'Rex', type: 'instance' });
      model.terms.push(rex);
      model.relations.push(newRelation({ from: ids.Person, to: ids.Robot, predicate: 'owl:disjointWith' }), newRelation({ from: rex.id, to: ids.Person, kind: 'generalization' }), newRelation({ from: rex.id, to: ids.Robot, kind: 'generalization' }));
    });
    expect(inferredRestrictions(m, id.Actor)).toEqual({ status: 'inconsistent', restrictions: [], expressions: [] });
    const unsat = build(['Person -knows some-> Person', 'Robot', 'Cyborg < Person', 'Cyborg < Robot'], (model, ids) => {
      model.relations.push(newRelation({ from: ids.Person, to: ids.Robot, predicate: 'owl:disjointWith' }));
    });
    expect(inferredRestrictions(unsat.m, unsat.id.Cyborg).status).toBe('unsatisfiable');
    expect(show(unsat.m, unsat.id.Cyborg)).toEqual(['knows some Person ← Person']);
  });

  it('has nothing to say about individuals, properties, or a SKOS concept scheme', () => {
    const { m, id } = build(['Person has hasName:xsd:string', 'Actor < Person']);
    expect(inferredRestrictions(m, id.hasName).status).toBe('none');
    expect(inferredRestrictions({ ...m, mode: 'skos' }, id.Actor).status).toBe('none');
    expect(inferredRestrictions(m, 'no-such-id').status).toBe('none');
  });
});
