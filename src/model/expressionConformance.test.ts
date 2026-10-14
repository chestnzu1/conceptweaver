import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { CLASS_AXIOM_KINDS, type ClassAxiomKind } from './expressions';
import { localName } from './iri';
import { namingFor, parseClass } from './manchester';
import { fromTurtle, toJsonLd, toTurtle } from './rdf';
import { askReasoner, dlRequest } from './reasoning';
import { loadOxigraph } from './oxigraph';
import { newTerm, uid, type Model } from './types';
import { statementsOf } from './unmapped';

/**
 * The app's class expressions measured against the OWL API, in the local OWL service (which runs
 * HermiT as well). What the app reads of a Manchester-syntax text, and writes as Turtle, has to be
 * what the OWL API's own Manchester parser makes of the same text: the same axioms, structure for
 * structure. And HermiT has to take what is written, and find in it what OWL entails. Needs Java
 * and the service's libraries; skipped, saying so, without.
 */
const why = unavailable();
if (why) console.warn(`Class expression conformance tests skipped: ${why}`);

const M = 'http://example.org/m#';
// Each entity's label is its local name, so that a name reads the same to the app (by label)
// and to the OWL API's parser (by the default namespace).
const ENTITIES = {
  Class: ['Person', 'Student', 'Organization', 'Country', 'PhysicalAddress', 'Adult', 'Minor'],
  ObjectProperty: ['hasChild', 'hasParent', 'hasMember', 'locatedIn'],
  DataProperty: ['hasAge', 'hasName'],
  Individual: ['Red', 'Yellow', 'Green', 'ann'],
};
const TURTLE = `@prefix : <${M}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/m> a owl:Ontology .
${ENTITIES.Class.map((c) => `:${c} a owl:Class ; rdfs:label "${c}" .`).join('\n')}
${ENTITIES.ObjectProperty.map((p) => `:${p} a owl:ObjectProperty ; rdfs:label "${p}" .`).join('\n')}
${ENTITIES.DataProperty.map((p) => `:${p} a owl:DatatypeProperty ; rdfs:label "${p}" .`).join('\n')}
${ENTITIES.Individual.map((i) => `:${i} a owl:NamedIndividual ; rdfs:label "${i}" .`).join('\n')}
`;

/** Every construct, nested: as the request lists them, and more. */
const CASES = [
  'Person and (hasChild some (Person and Student))',
  'Person or Organization',
  'not Person',
  'Person and not (Student or Organization)',
  'hasChild some Person',
  'hasChild only (Person or Organization)',
  'hasChild value Red',
  'hasChild Self',
  'hasChild min 1',
  'hasChild max 3 Person',
  'hasChild exactly 2 Person',
  'hasChild exactly 2 (Person and not Student)',
  'hasParent some (Person and (hasAge some xsd:integer))',
  'inverse hasMember some Organization',
  'inverse hasMember only (Person or Organization)',
  'hasAge some xsd:integer[>= 18]',
  'hasAge some xsd:integer[>= 18, < 65]',
  'hasName some xsd:string[length 4]',
  'hasName some xsd:string[pattern "[A-Z]+"]',
  'hasAge only (xsd:integer or xsd:decimal)',
  'hasAge some not xsd:integer',
  'hasAge value 42',
  'hasName value "Ann"@en',
  'hasName value "Ann"',
  'hasAge exactly 1 xsd:integer',
  'hasAge max 1',
  'hasName some {"S", "M", "L"}',
  '{Red, Yellow, Green}',
  'PhysicalAddress and (locatedIn some Country)',
  'Person and (hasChild some (Person and (hasAge some xsd:integer[>= 18]) and (hasChild some Student)))',
  'owl:Thing and not owl:Nothing',
];

/** The same entities, declared as a Manchester-syntax ontology document, with a class for each case. */
function manchesterDocument(axioms: { cls: string; kind: ClassAxiomKind; text: string }[]): string {
  const keyword: Record<ClassAxiomKind, string> = { SubClassOf: 'SubClassOf:', EquivalentClasses: 'EquivalentTo:', DisjointClasses: 'DisjointWith:' };
  return [
    `Prefix: : <${M}>`,
    'Prefix: owl: <http://www.w3.org/2002/07/owl#>',
    'Prefix: xsd: <http://www.w3.org/2001/XMLSchema#>',
    'Ontology: <http://example.org/m>',
    ...ENTITIES.ObjectProperty.map((p) => `ObjectProperty: ${p}`),
    ...ENTITIES.DataProperty.map((p) => `DataProperty: ${p}`),
    ...ENTITIES.Individual.map((i) => `Individual: ${i}`),
    ...ENTITIES.Class.map((c) => `Class: ${c}`),
    ...axioms.map((a) => `Class: ${a.cls}\n    ${keyword[a.kind]} ${a.text}`),
  ].join('\n');
}

/** The model with a class for each axiom, stated as the app's editor states it: read from the text, kept as the structure it is. */
function modelWith(axioms: { cls: string; kind: ClassAxiomKind; text: string }[]): Model {
  const m = fromTurtle(TURTLE);
  const n = namingFor(m);
  for (const a of axioms) m.terms.push(newTerm({ name: a.cls, iri: M + localName(a.cls, false), classAxioms: [{ id: uid(), kind: a.kind, expression: parseClass(a.text, n) }] }));
  return m;
}

interface Comparison {
  errors: string[];
  removed: string[];
  added: string[];
}

describe.skipIf(!!why)('class expressions, measured against the OWL API and HermiT', () => {
  let service: Awaited<ReturnType<typeof startReasoner>>;
  beforeAll(async () => {
    service = await startReasoner({ port: 5194, quiet: true, log: () => {} });
  }, 120_000);
  afterAll(async () => {
    await service?.stop();
  });
  const compare = async (original: string, exported: string): Promise<Comparison> => {
    const r = await fetch(`${service.url}/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ original, exported }) });
    return (await r.json()) as Comparison;
  };
  /** The class axioms one document has that the other has not, by structure. */
  const classAxiomsApart = (c: Comparison) => [...c.removed, ...c.added].filter((s) => /^(SubClassOf|EquivalentClasses|DisjointClasses)\(/.test(s));

  it('reads each text as the OWL API’s Manchester parser does, and writes in Turtle the axiom the OWL API reads from it', async () => {
    const axioms = CASES.map((text, i) => ({ cls: `Case${i + 1}`, kind: 'SubClassOf' as const, text }));
    const c = await compare(manchesterDocument(axioms), toTurtle(modelWith(axioms)));
    expect(c.errors).toEqual([]);
    // One difference, and it is the OWL API's: it gives the value of a facet the datatype it
    // restricts ("4"^^xsd:string in xsd:string[length 4]), where the W3C grammar makes 4 an integer
    // literal, and OWL 2 wants the value of a length to be a non-negative integer. The app reads
    // it as the grammar says. (For xsd:integer[>= 18] the two agree.)
    const length = CASES.indexOf('hasName some xsd:string[length 4]') + 1;
    expect(classAxiomsApart(c).sort()).toEqual([
      `SubClassOf(:Case${length} DataSomeValuesFrom(:hasName DatatypeRestriction(xsd:string facetRestriction(length "4"^^xsd:integer))))`,
      `SubClassOf(:Case${length} DataSomeValuesFrom(:hasName DatatypeRestriction(xsd:string facetRestriction(length "4"^^xsd:string))))`,
    ]);
    const rest = axioms.filter((a) => a.cls !== `Case${length}`);
    expect(classAxiomsApart(await compare(manchesterDocument(rest), toTurtle(modelWith(rest))))).toEqual([]);
    // The comparison does tell expressions apart: one that differs (and for or) is found.
    const other = modelWith([{ cls: 'Case1', kind: 'SubClassOf', text: 'Person or (hasChild some (Person and Student))' }, ...rest.slice(1)]);
    expect(classAxiomsApart(await compare(manchesterDocument(rest), toTurtle(other)))).toHaveLength(2);
  });

  it('keeps the three kinds of class axiom apart, as the OWL API does', async () => {
    const axioms = CLASS_AXIOM_KINDS.flatMap((kind, k) => ['Person and (hasAge some xsd:integer[>= 18])', 'hasChild some Student', 'inverse hasMember some Organization'].map((text, i) => ({ cls: `K${k}x${i}`, kind, text })));
    const c = await compare(manchesterDocument(axioms), toTurtle(modelWith(axioms)));
    expect(c.errors).toEqual([]);
    expect(classAxiomsApart(c)).toEqual([]);
  });

  it('writes the same in JSON-LD as in Turtle', async () => {
    // The OWL API reads no JSON-LD; the RDF engine of the app does, and compares statement by statement.
    const axioms = CASES.map((text, i) => ({ cls: `Case${i + 1}`, kind: 'SubClassOf' as const, text }));
    const m = modelWith(axioms);
    const ox = await loadOxigraph();
    const triples = (text: string, format: string) => {
      const store = new ox.Store();
      store.load(text, { format });
      return statementsOf(store.dump({ format: 'application/n-triples', from_graph_name: ox.defaultGraph() })).map((s) => s.text).sort();
    };
    expect(triples(toJsonLd(m), 'application/ld+json')).toEqual(triples(toTurtle(m), 'text/turtle'));
  });

  it('gives HermiT what it needs to find a class that can have no members, and to classify by a definition', async () => {
    const m = modelWith([
      { cls: 'Impossible', kind: 'EquivalentClasses', text: 'Person and Organization' },
      { cls: 'Orphan', kind: 'SubClassOf', text: 'hasParent some (Person and not Person)' },
      { cls: 'Grown', kind: 'EquivalentClasses', text: 'Person and (hasAge some xsd:integer[>= 18])' },
      { cls: 'Young', kind: 'EquivalentClasses', text: 'Person and (hasAge some xsd:integer[< 18])' },
      { cls: 'Lonely', kind: 'DisjointClasses', text: 'hasChild some owl:Thing' },
    ]);
    const n = namingFor(m);
    // Person and Organization disjoint, as a class axiom of Person; ann a Person of 30, with a child.
    const person = m.terms.find((t) => t.name === 'Person')!;
    person.classAxioms = [{ id: uid(), kind: 'DisjointClasses', expression: parseClass('Organization', n) }];
    const ask = (facts: string) => askReasoner(service.url, { ...dlRequest(m), ontology: `${toTurtle(m)}\n${facts}\n`, timeoutMs: 30_000 });
    // A Person of 30: consistent; two classes that can have no members; ann classified by the definition, Grown and not Young.
    const fine = await ask(`<${M}ann> a <${M}Person> ; <${M}hasAge> 30 .`);
    expect(fine).toMatchObject({ status: 'complete', consistency: 'consistent', errors: [] });
    expect(fine.profile).toMatchObject({ owl2dl: true, violationCount: 0 });
    expect((fine.unsatisfiable ?? []).map((iri) => iri.slice(M.length)).sort()).toEqual(['Impossible', 'Orphan']);
    const types = (fine.types ?? []).filter((t) => t.individual === M + 'ann').map((t) => t.class.slice(M.length));
    expect(types).toContain('Grown');
    expect(types).not.toContain('Young');
    // ann Lonely (disjoint with having a child) and with a child: a contradiction, which is a logical problem of the ontology, not of how an expression is written.
    const wrong = await ask(`<${M}ann> a <${M}Person> , <${M}Lonely> ; <${M}hasChild> <${M}Red> .`);
    expect(wrong.consistency).toBe('inconsistent');
  }, 60_000);
});
