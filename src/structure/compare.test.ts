import { describe, expect, it } from 'vitest';
import { compareClasses, type CompareContext } from './compare';
import type { ClassAxiom, ClassComparison, ComparedAxiom, Iri, Provenance, Quantifier } from './contracts';
import { graphOf, NS } from './fixtures';
import { buildHierarchy, buildInferredHierarchy, type EntailedInput } from './graph';
import { createGraphService, type InferredInput } from './service';

const REF = { ontologyId: 'onto', revisionId: 'r1' };
const NONE: Provenance = { engine: null, revisionId: 'r1', status: 'unavailable', completeness: 'incomplete', notes: [] };
const REASONED: Provenance = { engine: { id: 'test', name: 'Test reasoner' }, revisionId: 'r1', status: 'current', completeness: 'complete', notes: [] };

/** "hasLocalProfile some PartyLocalProfile", "globalIdentifier max 1 xsd:string": a restriction, on an object property unless its filler is a datatype. */
function restriction(text: string): ClassAxiom {
  const [property, quantifier, ...rest] = text.split(' ');
  const n = /^\d+$/.test(rest[0]) ? Number(rest.shift()) : undefined;
  const data = rest[0].startsWith('xsd:');
  const filler = data ? { label: rest[0], kind: 'datatype' as const } : { iri: NS + rest[0], label: rest[0], kind: 'class' as const };
  return { kind: 'restriction', key: `r|${NS}${property}|${quantifier}|${n ?? ''}|${filler.iri ?? filler.label}`, property: { iri: NS + property, label: property, type: data ? 'data' : 'object' }, quantifier: quantifier as Quantifier, ...(n !== undefined ? { n } : {}), filler, text };
}
const expression = (text: string, relation: 'subClassOf' | 'equivalentClass' = 'subClassOf'): ClassAxiom => ({ kind: 'expression', key: `x|${relation}|${text}`, relation, text });

/** Two classes compared in a small ontology: `stated` is the hierarchy, `axioms` what is asserted of each class, `entails` what a reasoner adds. */
function compare(stated: string, axioms: Record<string, (string | ClassAxiom)[]>, a: string, b: string, entails?: Partial<Pick<EntailedInput, 'equivalent' | 'unsatisfiable'>> & { links?: string }) {
  const input = graphOf(stated);
  const asked: Iri[][] = [];
  const of = new Map(Object.entries(axioms).map(([name, list]) => [NS + name, list.map((x) => (typeof x === 'string' ? restriction(x) : x))]));
  const ctx: CompareContext = {
    asserted: buildHierarchy(input),
    inferred: entails ? buildInferredHierarchy(input, { subClassOf: graphOf(entails.links ?? stated).subClassOf, links: 'direct', equivalent: entails.equivalent ?? [], unsatisfiable: entails.unsatisfiable ?? [] }) : null,
    reasoning: entails ? REASONED : NONE,
    axioms: (iris) => {
      asked.push(iris);
      return new Map(iris.filter((iri) => of.has(iri)).map((iri) => [iri, of.get(iri)!]));
    },
  };
  return { result: compareClasses(ctx, REF, NS + a, NS + b), asked };
}
const rowOf = (c: ClassComparison, text: string): ComparedAxiom => c.axioms.find((r) => r.axiom.text === text)!;
const table = (c: ClassComparison) => c.axioms.map((r) => `${r.axiom.text}: ${r.a.state} / ${r.b.state}`);
const sources = (r: ComparedAxiom, side: 'a' | 'b') => (r[side].from ?? []).map((x) => `${x.class.label} (${x.basis})`);
const stronger = (c: ClassComparison, text: string) => rowOf(c, text).relations.map((x) => `${x.kind} than ${c.axioms.find((r) => r.axiom.key === x.than)!.axiom.text}${x.evidence.map((e) => ` [${e.sub.label} < ${e.sup.label}, ${e.basis}]`).join('')}`);

const PARTY = 'Party; Organisation < Party; PartyLocalProfile; OrganisationLocalProfile < PartyLocalProfile';
const PARTY_AXIOMS = {
  Party: ['hasLocalProfile some PartyLocalProfile', 'globalIdentifier max 1 xsd:string'],
  Organisation: ['hasLocalProfile some OrganisationLocalProfile'],
};

describe('comparing a class with its subclass', () => {
  const { result: c } = compare(PARTY, PARTY_AXIOMS, 'Party', 'Organisation');

  it('says how the two stand to each other, and how that is known', () => {
    expect(c.a.label).toBe('Party');
    expect(c.b.label).toBe('Organisation');
    expect(c.relationship).toMatchObject({ kind: 'b-below-a', basis: 'asserted', verified: false });
    expect(c.relationship.chain!.map((x) => x.label)).toEqual(['Party', 'Organisation']);
    expect(c.disjointness).toBeUndefined();
    expect(c.reasoning.status).toBe('unavailable');
  });

  it('tells what each asserts from what the subclass inherits, and names where it inherits it from', () => {
    expect(table(c)).toEqual(['globalIdentifier max 1 xsd:string: own / inherited', 'hasLocalProfile some PartyLocalProfile: own / inherited', 'hasLocalProfile some OrganisationLocalProfile: absent / own']);
    expect(sources(rowOf(c, 'globalIdentifier max 1 xsd:string'), 'b')).toEqual(['Party (asserted)']);
    expect(sources(rowOf(c, 'hasLocalProfile some PartyLocalProfile'), 'b')).toEqual(['Party (asserted)']);
    expect(rowOf(c, 'hasLocalProfile some OrganisationLocalProfile').b).toEqual({ state: 'own' });
    expect(c.counts).toEqual({ shared: 2, onlyA: 0, onlyB: 1, ownA: 2, ownB: 1, inheritedA: 0, inheritedB: 2 });
  });

  it('calls the subclass’s restriction stronger because its filler is a subclass of the other’s, and gives that as the evidence', () => {
    expect(stronger(c, 'hasLocalProfile some OrganisationLocalProfile')).toEqual(['stronger than hasLocalProfile some PartyLocalProfile [OrganisationLocalProfile < PartyLocalProfile, asserted]']);
    expect(rowOf(c, 'hasLocalProfile some PartyLocalProfile').relations).toEqual([]);
    expect(rowOf(c, 'globalIdentifier max 1 xsd:string').relations).toEqual([]);
  });

  it('does not call it stronger when nothing makes the one filler a subclass of the other', () => {
    // The same two restrictions, with the two profile classes unrelated.
    const flat = 'Party; Organisation < Party; PartyLocalProfile; OrganisationLocalProfile';
    const unchecked = compare(flat, PARTY_AXIOMS, 'Party', 'Organisation').result;
    const row = rowOf(unchecked, 'hasLocalProfile some OrganisationLocalProfile');
    expect(row.relations).toEqual([]);
    // No reasoner was asked: whether one implies the other is not known, and that is what is said.
    expect(row.unverified).toEqual([rowOf(unchecked, 'hasLocalProfile some PartyLocalProfile').axiom.key]);
    expect(unchecked.relationship.verified).toBe(false);
    // A reasoner was asked and does not make them related: they are two different restrictions, and nothing is left open.
    const checked = compare(flat, PARTY_AXIOMS, 'Party', 'Organisation', {}).result;
    expect(rowOf(checked, 'hasLocalProfile some OrganisationLocalProfile')).toMatchObject({ relations: [], unverified: [] });
    expect(checked.relationship.verified).toBe(true);
  });

  it('takes the filler’s subclass relationship from the reasoner where it is only entailed, and says so', () => {
    const flat = 'Party; Organisation < Party; PartyLocalProfile; OrganisationLocalProfile';
    const entailed = compare(flat, PARTY_AXIOMS, 'Party', 'Organisation', { links: 'Organisation < Party; OrganisationLocalProfile < PartyLocalProfile' }).result;
    expect(stronger(entailed, 'hasLocalProfile some OrganisationLocalProfile')).toEqual(['stronger than hasLocalProfile some PartyLocalProfile [OrganisationLocalProfile < PartyLocalProfile, entailed]']);
    expect(entailed.reasoning.engine?.name).toBe('Test reasoner');
  });

  it('looks at the two classes and what is above them, and at nothing else', () => {
    const { asked } = compare(PARTY + '; Unrelated; Other < Unrelated; Agent; Party < Agent', PARTY_AXIOMS, 'Party', 'Organisation');
    expect(asked).toHaveLength(1);
    expect(asked[0].map((iri) => iri.slice(NS.length)).sort()).toEqual(['Agent', 'Organisation', 'Party']);
  });
});

describe('when one restriction implies another', () => {
  const HIERARCHY = 'C; D < C; A; B < A';
  const related = (own: string, inherited: string, stated = HIERARCHY) => {
    const { result } = compare(stated, { A: [inherited], B: [own] }, 'A', 'B');
    return { forward: stronger(result, own), back: stronger(result, inherited) };
  };

  it('needs the numbers to allow it and the fillers to be related the right way round', () => {
    // At least: more of a narrower class gives fewer of a wider one.
    expect(related('p min 2 D', 'p min 1 C').forward).toEqual(['stronger than p min 1 C [D < C, asserted]']);
    expect(related('p min 2 D', 'p some C').forward).toEqual(['stronger than p some C [D < C, asserted]']);
    expect(related('p min 1 D', 'p min 2 C')).toEqual({ forward: [], back: [] });
    expect(related('p some C', 'p some D').forward).toEqual([]);
    // At most: fewer of a wider class gives fewer of a narrower one. The filler goes the other way.
    expect(related('p max 1 C', 'p max 2 D').forward).toEqual(['stronger than p max 2 D [D < C, asserted]']);
    expect(related('p max 1 D', 'p max 2 C')).toEqual({ forward: [], back: [] });
    // Only.
    expect(related('p only D', 'p only C').forward).toEqual(['stronger than p only C [D < C, asserted]']);
    expect(related('p only C', 'p only D').forward).toEqual([]);
    // Exactly is at least and at most together.
    expect(related('p exactly 2 D', 'p some C').forward).toEqual(['stronger than p some C [D < C, asserted]']);
    expect(related('p exactly 2 C', 'p max 3 D').forward).toEqual(['stronger than p max 3 D [D < C, asserted]']);
    expect(related('p exactly 2 D', 'p exactly 2 C')).toEqual({ forward: [], back: [] });
  });

  it('rests on the numbers alone where the fillers are the same, and finds two ways of saying one thing equivalent', () => {
    expect(related('p min 3 C', 'p min 1 C').forward).toEqual(['stronger than p min 1 C']);
    expect(related('p exactly 2 C', 'p max 2 C').forward).toEqual(['stronger than p max 2 C']);
    expect(related('p some C', 'p min 1 C')).toEqual({ forward: ['equivalent than p min 1 C'], back: ['equivalent than p some C'] });
  });

  it('never relates restrictions of different kinds or on different properties, however alike they read', () => {
    expect(related('p some D', 'q some C')).toEqual({ forward: [], back: [] });
    expect(related('p some D', 'p only C')).toEqual({ forward: [], back: [] });
    expect(related('p max 1 C', 'p min 1 C')).toEqual({ forward: [], back: [] });
    // Datatypes are not compared with each other; the same datatype is.
    expect(related('age max 1 xsd:integer', 'age max 2 xsd:decimal')).toEqual({ forward: [], back: [] });
    expect(related('age max 1 xsd:integer', 'age max 2 xsd:integer').forward).toEqual(['stronger than age max 2 xsd:integer']);
  });

  it('compares a kept class expression as text and never calls one stronger', () => {
    const text = '[ owl:intersectionOf ( :C :D ) ]';
    const { result } = compare(HIERARCHY, { A: [expression(text), expression('[ owl:unionOf ( :C :D ) ]')], B: [expression(text), 'p some D'] }, 'A', 'B');
    expect(table(result)).toEqual(['[ owl:intersectionOf ( :C :D ) ]: own / own', '[ owl:unionOf ( :C :D ) ]: own / inherited', 'p some D: absent / own']);
    expect(result.axioms.every((r) => r.axiom.kind !== 'expression' || (r.relations.length === 0 && r.unverified.length === 0))).toBe(true);
    expect(result.notes.join(' ')).toMatch(/compared as text/);
  });
});

describe('what a class inherits, and from where', () => {
  it('names every class an axiom comes from, and how the class is under each', () => {
    // Clerk is stated to be a Person and an Employee; a reasoner adds that it is a Worker.
    const { result } = compare('Agent; Person < Agent; Employee; Clerk < Person, Employee; Worker; Manager < Employee', { Agent: ['name some xsd:string'], Person: ['knows some Person'], Employee: ['knows some Person', 'worksFor some Agent'], Worker: ['paidBy some Agent'], Clerk: ['worksFor some Agent'] }, 'Clerk', 'Manager', {
      links: 'Person < Agent; Clerk < Worker; Worker < Person, Employee; Manager < Employee',
    });
    expect(sources(rowOf(result, 'knows some Person'), 'a')).toEqual(['Employee (asserted)', 'Person (asserted)']);
    expect(sources(rowOf(result, 'name some xsd:string'), 'a')).toEqual(['Agent (asserted-chain)']);
    // Worker is above Clerk only according to the reasoner.
    expect(sources(rowOf(result, 'paidBy some Agent'), 'a')).toEqual(['Worker (entailed)']);
    // What a class asserts itself is its own, whatever it would inherit as well.
    expect(rowOf(result, 'worksFor some Agent').a).toEqual({ state: 'own' });
    expect(sources(rowOf(result, 'worksFor some Agent'), 'b')).toEqual(['Employee (asserted)']);
    expect(rowOf(result, 'paidBy some Agent').b.state).toBe('absent');
    expect(rowOf(result, 'name some xsd:string').b.state).toBe('absent');
  });

  it('gives a class what is asserted of a class it is equivalent to', () => {
    const { result } = compare('Organisation; Org; Party', { Org: ['hasName some xsd:string'] }, 'Organisation', 'Party', { links: '', equivalent: [[NS + 'Organisation', NS + 'Org']] });
    expect(sources(rowOf(result, 'hasName some xsd:string'), 'a')).toEqual(['Org (entailed)']);
    expect(result.superclasses.map((s) => `${s.class.label}: ${s.a} / ${s.b}`)).toEqual(['Org: entailed / absent']);
  });

  it('lists the classes above the two, the common ones first, with how each is above each', () => {
    const { result } = compare('Agent; Party < Agent; Organisation < Party; LegalEntity; Person < Party', {}, 'Organisation', 'Person', { links: 'Party < Agent; Organisation < Party, LegalEntity; Person < Party' });
    expect(result.superclasses.map((s) => `${s.class.label}: ${s.a} / ${s.b}`)).toEqual(['Agent: asserted-chain / asserted-chain', 'Party: asserted / asserted', 'LegalEntity: entailed / absent']);
    // One of the two can be above the other: then it is itself, on its own side.
    const nested = compare('Agent; Party < Agent; Organisation < Party', {}, 'Organisation', 'Party').result;
    expect(nested.superclasses.map((s) => `${s.class.label}: ${s.a} / ${s.b}`)).toEqual(['Agent: asserted-chain / asserted', 'Party: asserted / self']);
  });

  it('reads only what is stated of a class the reasoner finds unsatisfiable', () => {
    const { result } = compare('Person; Robot; Android < Person', { Robot: ['runs some Person'], Person: ['knows some Person'] }, 'Android', 'Person', { links: 'Android < Person, Robot', unsatisfiable: [NS + 'Android'] });
    expect(result.unsatisfiable).toEqual({ a: true, b: false });
    expect(table(result)).toEqual(['knows some Person: inherited / own']);
    expect(result.notes.join(' ')).toMatch(/“Android” can never have an instance/);
  });
});

describe('how two classes stand to each other', () => {
  const kind = (stated: string, a: string, b: string, entails?: Parameters<typeof compare>[4]) => {
    const r = compare(stated, {}, a, b, entails).result.relationship;
    return `${r.kind}${r.basis ? ' (' + r.basis + ')' : ''}${r.chain ? ' ' + r.chain.map((c) => c.label).join(' > ') : ''}${r.shared.length ? ' [' + r.shared.map((c) => c.label).join(', ') + ']' : ''}`;
  };

  it('finds one under the other: stated, through stated links, or only according to the reasoner', () => {
    expect(kind('B < A', 'B', 'A')).toBe('a-below-b (asserted) A > B');
    expect(kind('B < A', 'A', 'B')).toBe('b-below-a (asserted) A > B');
    expect(kind('C < B; B < A', 'C', 'A')).toBe('a-below-b (asserted-chain) A > B > C');
    expect(kind('A; C', 'C', 'A', { links: 'C < A' })).toBe('a-below-b (entailed)');
    expect(kind('A; A', 'A', 'A')).toBe('same');
  });

  it('finds them equivalent: stated, by being each other’s superclasses, or according to the reasoner', () => {
    expect(kind('A; B; A = B', 'A', 'B')).toBe('equivalent (asserted)');
    expect(kind('A < B; B < A', 'A', 'B')).toBe('equivalent (asserted-chain)');
    expect(kind('A; B', 'A', 'B', { links: '', equivalent: [[NS + 'A', NS + 'B']] })).toBe('equivalent (entailed)');
  });

  it('otherwise says what they share: a direct superclass, or the nearest classes above both', () => {
    expect(kind('P; A < P; B < P', 'A', 'B')).toBe('siblings [P]');
    expect(kind('Top; P < Top; Q < Top; A < P; B < Q', 'A', 'B')).toBe('unrelated [Top]');
    // The nearest ones only: Top is above Mid, which is above both.
    expect(kind('Top; Mid < Top; P < Mid; Q < Mid; A < P; B < Q', 'A', 'B')).toBe('unrelated [Mid]');
    expect(kind('A; B', 'A', 'B')).toBe('unrelated');
    // Siblings by what the reasoner puts directly above them.
    expect(kind('P; A; B', 'A', 'B', { links: 'A < P; B < P' })).toBe('siblings [P]');
  });

  it('says whether a reasoner was consulted, since without one more may hold than is stated', () => {
    expect(compare('A; B', {}, 'A', 'B').result.relationship.verified).toBe(false);
    expect(compare('A; B', {}, 'A', 'B', {}).result.relationship.verified).toBe(true);
  });

  it('finds them disjoint where that is stated of them, or of a class above each', () => {
    const input = (stated: string, pairs: [string, string][]) => {
      const g = graphOf(stated);
      g.disjoint = pairs.map(([a, b]) => ({ a: NS + a, b: NS + b }));
      return g;
    };
    const run = (stated: string, pairs: [string, string][], a: string, b: string) => compareClasses({ asserted: buildHierarchy(input(stated, pairs)), inferred: null, reasoning: NONE, axioms: () => new Map() }, REF, NS + a, NS + b);
    expect(run('Film; Person', [['Film', 'Person']], 'Person', 'Film').disjointness).toEqual({ basis: 'asserted', between: { a: { iri: NS + 'Person', label: 'Person' }, b: { iri: NS + 'Film', label: 'Film' } } });
    const below = run('Film; Person; Actor < Person; Stuntman < Actor; Documentary < Film', [['Film', 'Person']], 'Stuntman', 'Documentary');
    expect(below.disjointness).toMatchObject({ basis: 'follows', between: { a: { label: 'Person' }, b: { label: 'Film' } }, aBasis: 'asserted-chain', bBasis: 'asserted' });
    expect(below.relationship.kind).toBe('unrelated');
    expect(run('Film; Person; Actor < Person', [['Film', 'Person']], 'Actor', 'Person').disjointness).toBeUndefined();
    const stated = run('Film; Person', [['Film', 'Person']], 'Person', 'Film').stated;
    expect(stated.a.disjoints.map((c) => c.label)).toEqual(['Film']);
    expect(stated.b.disjoints.map((c) => c.label)).toEqual(['Person']);
  });
});

describe('the structure service: search, comparison and explanation', () => {
  const input = graphOf('Party; Organisation < Party; Person < Party; PartyLocalProfile; OrganisationLocalProfile < PartyLocalProfile; Org; Clerk < Person');
  input.classes.find((c) => c.label === 'Org')!.search = ['Organisation (short)'];
  const axioms = new Map<Iri, ClassAxiom[]>([
    [NS + 'Party', [restriction('hasLocalProfile some PartyLocalProfile')]],
    [NS + 'Organisation', [restriction('hasLocalProfile some OrganisationLocalProfile')]],
  ]);
  const answer: InferredInput = {
    provenance: REASONED,
    entailed: { subClassOf: [...input.subClassOf, { sub: NS + 'Clerk', sup: NS + 'Organisation' }], links: 'direct', equivalent: [], unsatisfiable: [] },
    explain: (sub, sup) => (sub === NS + 'Clerk' && sup === NS + 'Organisation' ? ['“Clerk” is defined as employed by an “Organisation”'] : null),
  };
  const serve = (reasoner?: InferredInput) => createGraphService(() => ({ ...REF, graph: () => input, axioms: (iris) => new Map(iris.filter((i) => axioms.has(i)).map((i) => [i, axioms.get(i)!])), ...(reasoner ? { inferred: () => reasoner } : {}) }));

  it('finds classes by text, the best match first', async () => {
    const service = serve();
    const found = await service.search({ ...REF, text: 'organisation' });
    // The label that is the text, then the ones that start with it or hold it, then one found by another label.
    expect(found.matches.map((c) => c.label)).toEqual(['Organisation', 'OrganisationLocalProfile', 'Org']);
    expect(found.total).toBe(3);
    expect((await service.search({ ...REF, text: 'p', limit: 2 })).matches).toHaveLength(2);
    expect((await service.search({ ...REF, text: 'p', limit: 2 })).total).toBeGreaterThan(2);
    expect((await service.search({ ...REF, text: '   ' })).matches).toEqual([]);
    expect((await service.search({ ...REF, text: 'example.org/o#Person' })).matches.map((c) => c.label)).toEqual(['Person']);
    await expect(service.search({ ...REF, revisionId: 'r0', text: 'p' })).rejects.toMatchObject({ code: 'stale-revision' });
  });

  it('compares two classes of the ontology as it is', async () => {
    const c = await serve().compare({ ...REF, classAIri: NS + 'Party', classBIri: NS + 'Organisation' });
    expect(c.relationship.kind).toBe('b-below-a');
    expect(table(c)).toEqual(['hasLocalProfile some PartyLocalProfile: own / inherited', 'hasLocalProfile some OrganisationLocalProfile: absent / own']);
    expect(stronger(c, 'hasLocalProfile some OrganisationLocalProfile')).toHaveLength(1);
    expect(c.reasoning.status).toBe('unavailable');
    expect((await serve(answer).compare({ ...REF, classAIri: NS + 'Clerk', classBIri: NS + 'Organisation' })).relationship).toMatchObject({ kind: 'a-below-b', basis: 'entailed', verified: true });
    await expect(serve().compare({ ...REF, classAIri: NS + 'Party', classBIri: NS + 'Nobody' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('explains a subclass relationship by the stated links it follows from', async () => {
    const service = serve(answer);
    const direct = await service.explain({ ...REF, subClassIri: NS + 'Person', superClassIri: NS + 'Party' });
    expect(direct).toMatchObject({ available: true, basis: 'asserted', statements: ['Person SubClassOf Party'], provenance: { engine: null } });
    const chain = await service.explain({ ...REF, subClassIri: NS + 'Clerk', superClassIri: NS + 'Party' });
    expect(chain).toMatchObject({ available: true, basis: 'asserted-chain', statements: ['Clerk SubClassOf Person', 'Person SubClassOf Party'] });
  });

  it('passes on the reasoner’s own grounds for what is only entailed, and makes none up where it gives none', async () => {
    const service = serve(answer);
    const grounded = await service.explain({ ...REF, subClassIri: NS + 'Clerk', superClassIri: NS + 'Organisation' });
    expect(grounded).toMatchObject({ available: true, basis: 'entailed', statements: ['“Clerk” is defined as employed by an “Organisation”'], provenance: { engine: { name: 'Test reasoner' } } });
    // The same entailment from a reasoner that gives no justification.
    const silent = await serve({ ...answer, explain: undefined }).explain({ ...REF, subClassIri: NS + 'Clerk', superClassIri: NS + 'Organisation' });
    expect(silent).toMatchObject({ available: false, statements: [] });
    expect(silent.reason).toMatch(/gives no justification/);
    // Not entailed at all, and no reasoner to ask.
    expect((await service.explain({ ...REF, subClassIri: NS + 'Party', superClassIri: NS + 'Clerk' })).reason).toMatch(/not entailed/);
    const none = await serve().explain({ ...REF, subClassIri: NS + 'Clerk', superClassIri: NS + 'Organisation' });
    expect(none).toMatchObject({ available: false, provenance: { status: 'unavailable' } });
  });
});
