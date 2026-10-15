import { reason } from './reasoner';
import { beforeEach, describe, expect, it } from 'vitest';
import { enumerationEdges } from './edgeKinds';
import { viewerData } from './htmlExport';
import { entailed, inferredFacts } from './inferred';
import { withIris } from './iri';
import { objectProperties } from './props';
import { fromTurtle, toTurtle, toTurtleWithInferred } from './rdf';
import { dlResult, type DlReport } from './reasoning';
import { currentDl, useStore } from './store';
import { emptyModel, newProp, newRelation, newTerm, PROP_LINKS, type Model, type ObjProp } from './types';
import { dlFindings } from './validation';

/**
 * Relationships between individuals that follow from what an object property is: its inverse,
 * that it is symmetric or transitive, its parent, a property equivalent to it. Both reasoners
 * entail them; these are about the app's own, and about how what either finds is shown and written.
 */

const N = 'http://example.org/test#';
/** John is a member of Company A; "has member" is the inverse of "is member of". The example the fix was asked for. */
const EXAMPLE = `
  @prefix : <${N}> .
  @prefix owl: <http://www.w3.org/2002/07/owl#> .
  :hasMember a owl:ObjectProperty .
  :isMemberOf a owl:ObjectProperty ; owl:inverseOf :hasMember .
  :John a owl:NamedIndividual ; :isMemberOf :CompanyA .
  :CompanyA a owl:NamedIndividual .`;

/**
 * Individuals a, b, c, d and the object properties given, with facts as [from, property, to].
 * The properties link to each other by name here, for reading; in the model by id.
 */
const world = (props: ObjProp[], facts: [string, string, string][]): Model => {
  const m = emptyModel('World');
  m.baseIri = N;
  m.terms = ['a', 'b', 'c', 'd'].map((id) => newTerm({ id, name: id.toUpperCase(), type: 'instance' }));
  const idOf = (name: string) => props.find((x) => x.name === name)!.id;
  m.props = props.map((x) => ({ ...x, ...Object.fromEntries(PROP_LINKS.filter((l) => x[l]).map((l) => [l, x[l]!.map(idOf)])) }));
  m.relations = facts.map(([from, label, to]) => newRelation({ from, to, label }));
  return withIris(m);
};
const p = (name: string, more: Partial<ObjProp> = {}): ObjProp => newProp({ name, ...more });
const said = (m: Model) => inferredFacts(m, reason(m)).facts.map((f) => `${f.from} ${f.name} ${f.to}`).sort();
const report = (over: Partial<DlReport> = {}): DlReport => ({ engine: 'HermiT', engineVersion: '1.4.5.456', status: 'complete', consistency: 'consistent', ms: 1, errors: [], warnings: [], ...over });

describe('the example: an inverse property', () => {
  it('is read and written with the inverse and the assertion in place', () => {
    const m = fromTurtle(EXAMPLE);
    const hasMember = m.props.find((x) => x.name === 'has member')!.id;
    expect(objectProperties(m).find((x) => x.name === 'is member of')!.inverses).toEqual([hasMember]);
    const ttl = toTurtle(m);
    expect(ttl).toContain('owl:inverseOf :hasMember');
    expect(ttl).toContain(':isMemberOf :CompanyA');
    // The export is of what is asserted: the inverse relationship is not in it.
    expect(ttl).not.toContain(':hasMember :John');
  });

  it('entails that the company has John as a member, by the app’s own reasoner', () => {
    const m = fromTurtle(EXAMPLE);
    const name = (id: string) => m.terms.find((t) => t.id === id)!.name;
    const facts = inferredFacts(m, reason(m)).facts;
    expect(facts.map((f) => `${name(f.from)} ${f.name} ${name(f.to)}`)).toEqual(['Company A has member John']);
    expect(facts[0].because).toContain('is the inverse of');
    // Known by the property's id, which does not change when the property is renamed.
    expect(facts[0].id).toBe(`fact:${facts[0].from}|${m.props.find((x) => x.name === 'has member')!.id}|${facts[0].to}`);
  });
});

describe('what the app’s own reasoner entails between individuals', () => {
  it('a symmetric property holds both ways', () => {
    expect(said(world([p('knows', { chars: ['symmetric'] })], [['a', 'knows', 'b']]))).toEqual(['b knows a']);
  });

  it('a transitive property holds along a chain', () => {
    expect(said(world([p('part of', { chars: ['transitive'] })], [['a', 'part of', 'b'], ['b', 'part of', 'c'], ['c', 'part of', 'd']]))).toEqual(['a part of c', 'a part of d', 'b part of d']);
  });

  it('equivalent properties hold of the same pairs', () => {
    expect(said(world([p('employs'), p('has staff', { equivalents: ['employs'] })], [['a', 'employs', 'b'], ['c', 'has staff', 'd']]))).toEqual(['a has staff b', 'c employs d']);
  });

  it('what a sub-property relates, the property above it relates too', () => {
    expect(said(world([p('related to'), p('parent of', { parents: ['related to'] }), p('mother of', { parents: ['parent of'] })], [['a', 'mother of', 'b']]))).toEqual(['a parent of b', 'a related to b']);
  });

  it('several individuals and several assertions, each inferred once and none that is stated', () => {
    const m = world(
      [p('has member'), p('is member of', { inverses: ['has member'] }), p('knows', { chars: ['symmetric'] })],
      [['a', 'is member of', 'd'], ['b', 'is member of', 'd'], ['c', 'is member of', 'd'], ['d', 'has member', 'c'], ['a', 'knows', 'b'], ['b', 'knows', 'a'], ['b', 'knows', 'c']],
    );
    // d has member c is stated, and a and b know each other both ways already: none of those is given as inferred.
    expect(said(m)).toEqual(['c knows b', 'd has member a', 'd has member b']);
    expect(new Set(inferredFacts(m, reason(m)).facts.map((f) => f.id)).size).toBe(3);
  });

  it('a relationship kept plain has no meaning to follow from, and nothing is inferred from an inconsistent ontology', () => {
    const plain = world([p('knows', { chars: ['symmetric'] })], [['a', 'knows', 'b']]);
    plain.relations[0].plain = true;
    expect(said(plain)).toEqual([]);
    const broken = world([p('above', { chars: ['asymmetric', 'symmetric'] })], [['a', 'above', 'b']]);
    expect(inferredFacts(broken, reason(broken))).toMatchObject({ consistent: false, facts: [] });
    expect(entailed(broken, reason(broken))).toMatchObject({ consistent: false, memberships: [], facts: [] });
  });
});

describe('one account of what is entailed, whichever reasoner found it', () => {
  const m = fromTurtle(EXAMPLE);
  const [john, company] = [m.terms.find((t) => t.name === 'John')!.id, m.terms.find((t) => t.name === 'Company A')!.id];
  const [isMemberOf, hasMember] = ['is member of', 'has member'].map((name) => m.props.find((x) => x.name === name)!.id);
  const answer = report({
    relations: [
      { subject: N + 'John', property: N + 'isMemberOf', object: N + 'CompanyA' },
      { subject: N + 'CompanyA', property: N + 'hasMember', object: N + 'John' },
      { subject: N + 'CompanyA', property: 'http://elsewhere.org/unknown', object: N + 'John' },
    ],
  });

  it('takes the relationships out of the OWL 2 DL reasoner’s answer, and tells the stated from the inferred', () => {
    const result = dlResult(m, answer);
    expect(result.relations).toEqual([
      { subject: john, property: isMemberOf, object: company, asserted: true },
      { subject: company, property: hasMember, object: john, asserted: false },
    ]);
    // In a validation run they are part of what counts as inferred.
    expect(dlFindings(m, answer).summary.inferred).toBe(1);
  });

  it('gives each inferred relationship once, credited to whoever found it', () => {
    const fast = entailed(m, reason(m));
    expect(fast).toMatchObject({ consistent: true, partial: false, by: 'the fast reasoner (RDFS / partial OWL RL)' });
    expect(fast.facts.map((f) => [f.from, f.name, f.to])).toEqual([[company, 'has member', john]]);
    // Both reasoners find it: it is still there once, and what is stated is not there at all.
    const both = entailed(m, reason(m), dlResult(m, answer));
    expect(both.by).toBe('HermiT 1.4.5.456 (OWL 2 DL)');
    expect(both.facts.map((f) => [f.from, f.name, f.to])).toEqual([[company, 'has member', john]]);
    // What only the OWL 2 DL reasoner finds is there too, and says whose it is.
    const more = entailed(m, reason(m), dlResult(m, report({ relations: [{ subject: N + 'John', property: N + 'hasMember', object: N + 'John' }] })));
    expect(more.facts.map((f) => [f.from, f.name, f.to, f.because])).toEqual([
      [company, 'has member', john, expect.stringContaining('is the inverse of')],
      [john, 'has member', john, 'Entailed, according to HermiT 1.4.5.456 (OWL 2 DL).'],
    ]);
    // Reasoned over only in part, or inconsistent: said, and in the second case nothing is inferred.
    expect(entailed(m, reason(m), dlResult(m, report({ status: 'partial' }))).partial).toBe(true);
    expect(entailed(m, reason(m), dlResult(m, report({ consistency: 'inconsistent' })))).toMatchObject({ consistent: false, facts: [], memberships: [] });
  });

  it('is what the exported page lists, as inferred', () => {
    const { facts } = entailed(m, reason(m));
    const rels = viewerData(m, new Date(), { facts }).rels;
    expect(rels.find((r) => r.id === facts[0].id)).toMatchObject({ from: company, to: john, label: 'has member (inferred)', kind: 'inferred relationship', head: 'filled' });
    expect(enumerationEdges(m)).toEqual([]);
  });
});

describe('switching reasoners', () => {
  const st = useStore.getState;
  beforeEach(() => st().replaceModel(fromTurtle(EXAMPLE)));

  it('shows the OWL 2 DL reasoner’s result only while that reasoner is the one chosen, and the model the one it was asked about', () => {
    const m = st().model;
    const answer = report({ relations: [{ subject: N + 'CompanyA', property: N + 'hasMember', object: N + 'John' }] });
    const run = dlFindings(m, answer);
    // An answer of the OWL 2 DL reasoner about the model as it is now.
    useStore.setState((s) => ({ validation: { ...s.validation, engine: 'dl' }, reasoning: { ...s.reasoning, dl: { revisionId: s.version.revision, report: answer, result: run.result } } }));
    expect(currentDl(st())?.relations).toHaveLength(1);
    // The other engine chosen: its answer is not used any longer, though the run is still on the page until the next one.
    st().setValidation({ engine: 'fast' });
    expect(currentDl(st())).toBeUndefined();
    expect(entailed(st().model, reason(st().model), currentDl(st())).by).toBe('the fast reasoner (RDFS / partial OWL RL)');
    // Chosen again, with the model unchanged, it holds again.
    st().setValidation({ engine: 'dl' });
    expect(currentDl(st())?.relations).toHaveLength(1);
    // After an edit it is of another model.
    st().addTerm({ name: 'New' });
    expect(currentDl(st())).toBeUndefined();
  });
});

describe('RDF with and without inferred assertions', () => {
  const m = (() => {
    const base = fromTurtle(`${EXAMPLE}
      :Member a owl:Class . :Person a owl:Class . :Member <http://www.w3.org/2000/01/rdf-schema#subClassOf> :Person .
      :John a :Member .`);
    return base;
  })();
  const found = entailed(m, reason(m));
  const materialized = { types: found.memberships.map((x) => ({ individual: x.from, class: x.to })), facts: found.facts.map((x) => ({ from: x.from, prop: x.prop, to: x.to })), by: found.by, at: new Date('2026-10-12T00:00:00Z') };

  it('by default writes what is asserted, and nothing else', () => {
    const ttl = toTurtle(m);
    expect(ttl).toContain(':John a owl:NamedIndividual , :Member');
    expect(ttl).not.toContain(':hasMember :John');
    expect(ttl).not.toMatch(/:John a [^.]*:Person/);
    expect(ttl).not.toContain('Inferred');
  });

  it('when asked, writes the inferred assertions after the ontology, under a heading that says what they are', () => {
    const ttl = toTurtleWithInferred(m, materialized);
    // The asserted ontology is exactly what the ordinary export writes.
    expect(ttl.startsWith(toTurtle(m).trimEnd())).toBe(true);
    const tail = ttl.slice(toTurtle(m).trimEnd().length).trim().split('\n');
    expect(tail).toEqual([
      '# --------------------------------------------------------------------------------------',
      '# Inferred assertions, materialized on export: 1 class membership and 1 relationship',
      '# between individuals.',
      '# They follow from the ontology above and are not asserted in the model it was',
      '# exported from. Worked out by the fast reasoner (RDFS / partial OWL RL) on',
      '# 2026-10-12.',
      '# --------------------------------------------------------------------------------------',
      '',
      ':John a :Person .',
      ':CompanyA :hasMember :John .',
    ]);
    // The same triple is not written twice, and what is stated is not repeated as inferred.
    const twice = toTurtleWithInferred(m, { ...materialized, facts: [...materialized.facts, ...materialized.facts] });
    expect(twice.match(/:CompanyA :hasMember :John \./g)).toHaveLength(1);
    expect(toTurtleWithInferred(m, { types: [], facts: [], by: 'x' })).toContain('# Nothing follows beyond what is asserted.');
  });

  it('reads back as an ontology in which they are assertions, with nothing doubled', () => {
    const back = fromTurtle(toTurtleWithInferred(m, materialized));
    const name = (id: string) => back.terms.find((t) => t.id === id)!.name;
    // RDF cannot tell an inferred triple from an asserted one: read back, both are stated.
    expect(back.relations.filter((r) => r.label).map((r) => `${name(r.from)} ${r.label} ${name(r.to)}`).sort()).toEqual(['Company A has member John', 'John is member of Company A']);
    expect(toTurtle(back)).toContain(':CompanyA a owl:NamedIndividual ;');
    expect(toTurtle(back)).toMatch(/:John a owl:NamedIndividual , :Member , :Person|:John a owl:NamedIndividual , :Person , :Member/);
    // So nothing is left to infer from them, and nothing is there twice.
    expect(entailed(back, reason(back))).toMatchObject({ consistent: true, facts: [], memberships: [] });
    expect(back.terms).toHaveLength(m.terms.length);
    expect(back.props.map((x) => x.name).sort()).toEqual(['has member', 'is member of']);
    // Written out again without asking for inferences, they are in it, as the assertions they now are.
    expect(toTurtle(back)).toContain(':hasMember :John');
    expect(toTurtle(fromTurtle(toTurtle(back)))).toBe(toTurtle(back));
  });
});
