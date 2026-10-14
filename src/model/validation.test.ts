import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { addIsA, addLink, addValue } from './axioms';
import { withIris } from './iri';
import { loadModel, saveModel } from './library';
import { QUALITY_RULES, setRule } from './quality';
import { fromTurtle, toTurtle } from './rdf';
import { importShapes, newPropertyShape, newShape, shapesToTurtle } from './shapes';
import { emptyModel, newProp, newRelation, newTerm, normalizeModel, type Model, type Term, type TermType } from './types';
import { isStale, MODEL_DATA, owlFindings, qualityFindings, reportJson, reportTurtle, shaclFindings, validate, type DataGraph } from './validation';

function build() {
  let m: Model = { ...emptyModel('People'), baseIri: 'http://example.org/p#', lang: 'en' };
  const id: Record<string, string> = {};
  const term = (name: string, type: TermType = 'concept', extra: Partial<Term> = {}) => {
    const t = newTerm({ name, type, description: `About ${name}.`, ...extra });
    id[name] = t.id;
    m = { ...m, terms: [...m.terms, t] };
  };
  for (const c of ['Agent', 'Person', 'Employee', 'Actor', 'Organisation']) term(c);
  term('has name', 'property', { range: 'xsd:string' });
  term('has age', 'property', { range: 'xsd:integer' });
  for (const i of ['Ann', 'Bob', 'Acme']) term(i, 'instance');
  const rel = (from: string, to: string, p: Partial<ReturnType<typeof newRelation>> = {}) => (m = { ...m, relations: [...m.relations, newRelation({ from: id[from], to: id[to], ...p })] });
  m = { ...m, props: [newProp({ name: 'works for', description: 'Is employed by.', chars: [] })] };
  rel('Person', 'Agent', { kind: 'generalization' });
  rel('Employee', 'Person', { kind: 'generalization' });
  rel('Actor', 'Person', { kind: 'generalization' });
  rel('Organisation', 'Agent', { kind: 'generalization' });
  rel('Ann', 'Employee', { kind: 'generalization' });
  rel('Bob', 'Person', { kind: 'generalization' });
  rel('Acme', 'Organisation', { kind: 'generalization' });
  rel('Employee', 'Organisation', { label: 'works for' });
  rel('Ann', 'Acme', { label: 'works for' });
  m = withIris(m);
  const iri = (name: string) => m.terms.find((t) => t.name === name)!.iri!;
  return { m, id, iri };
}
const edit = (e: { model?: Model; error?: string }) => {
  expect(e.error).toBeUndefined();
  return e.model!;
};
/** A Person shape: exactly one name that is text, and an age that is a whole number of at least 0. */
function withPersonShape(m: Model, iri: (n: string) => string): Model {
  const shape = newShape(m, 'Person', iri('Person'));
  shape.properties = [
    { ...newPropertyShape(iri('has name')), datatype: 'xsd:string', minCount: 1, maxCount: 1 },
    { ...newPropertyShape(iri('has age')), datatype: 'xsd:integer', minInclusive: { v: '0', dt: 'xsd:integer' } },
  ];
  return { ...m, shapes: { nodes: [shape], extra: '' } };
}

describe('OWL logical consistency', () => {
  it('reports a consistent ontology as consistent, with the reasoner’s profile', () => {
    const { m } = build();
    const { summary, findings } = owlFindings(m);
    expect(summary).toMatchObject({ status: 'consistent', contradictions: 0, unsatisfiable: [], partial: false });
    expect(summary.profile).toMatch(/OWL 2 RL/);
    expect(findings).toEqual([]);
  });

  it('reports an inconsistent ontology, with the facts the reasoner derives it from', () => {
    const { m, id } = build();
    // Ann is an Employee, so a Person; and an Organisation; and the two are disjoint.
    let n = edit(addLink(m, id.Person, id.Organisation, 'disjointWith'));
    n = edit(addIsA(n, id.Ann, id.Organisation));
    const { summary, findings } = owlFindings(n);
    expect(summary.status).toBe('inconsistent');
    expect(summary.contradictions).toBe(1);
    const f = findings.find((x) => x.ruleId === 'owl-inconsistent')!;
    expect(f).toMatchObject({ category: 'owl', severity: 'error', rule: 'Inconsistent ontology', entity: { name: 'Ann', type: 'individual' } });
    expect(f.message).toBe('“Ann” is an instance of both “Organisation” and “Person”, which cannot share members.');
    // The justification is the reasoner's: exactly the stated facts, nothing added.
    expect(f.explanation).toContain('“Ann” is an instance of “Employee”');
    expect(f.explanation).toContain('“Employee” is a kind of “Person”');
    expect(f.explanation).toContain('“Person” is disjoint with “Organisation”');
    expect(f.rels.length).toBe(4);
  });

  it('tells an unsatisfiable class from an inconsistent ontology', () => {
    const { m, id } = build();
    let n = edit(addLink(m, id.Person, id.Organisation, 'disjointWith'));
    // A class under both: it can exist, it just can never have a member.
    n = edit(addIsA(n, id.Actor, id.Organisation));
    const { summary, findings } = owlFindings(n);
    expect(summary.status).toBe('consistent');
    expect(summary.unsatisfiable).toEqual([id.Actor]);
    expect(findings.map((f) => [f.rule, f.entity?.name, f.severity])).toEqual([['Unsatisfiable class', 'Actor', 'error']]);
    // Only once something is said to be an Actor does the ontology contradict itself.
    const worse = edit(addIsA(n, id.Bob, id.Actor));
    expect(owlFindings(worse).summary.status).toBe('inconsistent');
  });

  it('finds restrictions that cannot hold together, own or inherited', () => {
    const { m, id } = build();
    const rels = [...m.relations, newRelation({ from: id.Person, to: id['has name'], kind: 'property', restriction: 'max', restrictionN: 1 }), newRelation({ from: id.Employee, to: id['has name'], kind: 'property', restriction: 'min', restrictionN: 2 })];
    const { summary, findings } = owlFindings({ ...m, relations: rels });
    expect(summary.status).toBe('consistent');
    expect(summary.unsatisfiable).toEqual([id.Employee]);
    const f = findings.find((x) => x.ruleId === 'owl-restrictions')!;
    expect(f.message).toBe('“Employee” can never have instances: it needs at least 2 and at most 1 values of “has name” in “xsd:string”.');
    expect(f.explanation).toBe('Both are asserted: “has name min 2 xsd:string”; and “has name max 1 xsd:string”, inherited from “Person”.');
    // Compatible restrictions are no finding.
    expect(owlFindings({ ...m, relations: [...m.relations, newRelation({ from: id.Person, to: id['has name'], kind: 'property', restriction: 'exactly', restrictionN: 1 }), newRelation({ from: id.Employee, to: id['has name'], kind: 'property' })] }).findings).toEqual([]);
  });

  it('reports conflicting property characteristics as a warning, not as an inconsistency', () => {
    const { m } = build();
    const n = { ...m, props: m.props.map((p) => ({ ...p, chars: ['symmetric', 'asymmetric'] })) };
    const { summary, findings } = owlFindings(n);
    expect(findings.find((f) => f.ruleId === 'owl-characteristics')).toMatchObject({ severity: 'warning', entity: { name: 'works for', type: 'object property' } });
    // It is the use that makes it a contradiction: Ann works for Acme, so by symmetry Acme works for Ann.
    expect(summary.status).toBe('inconsistent');
    expect(owlFindings({ ...n, relations: n.relations.filter((r) => r.label !== 'works for') }).summary.status).toBe('consistent');
  });

  it('does not call something missing an inconsistency: OWL is open-world', () => {
    const { m, id } = build();
    // Every Person has a name, and Bob has none stated. That is unknown, not wrong.
    const n = { ...m, relations: [...m.relations, newRelation({ from: id.Person, to: id['has name'], kind: 'property', restriction: 'min', restrictionN: 1 })] };
    expect(owlFindings(n)).toMatchObject({ summary: { status: 'consistent', unsatisfiable: [] }, findings: [] });
  });

  it('says a concept scheme has no OWL consistency to check', () => {
    const { m } = build();
    expect(owlFindings({ ...m, mode: 'skos' }).summary.status).toBe('not-applicable');
  });
});

describe('SHACL validation', () => {
  it('skips when there are no shapes, and conforms when the data fits', async () => {
    const { m, id, iri } = build();
    expect((await shaclFindings(m)).summary.status).toBe('skipped');
    let n = withPersonShape(m, iri);
    for (const who of ['Ann', 'Bob']) n = edit(addValue(n, id[who], { prop: id['has name'], value: who }));
    const { summary, findings } = await shaclFindings(n);
    expect(summary).toMatchObject({ status: 'conforms', violations: 0, shapes: 1, includesOntology: true, dataSource: 'This model' });
    expect(findings).toEqual([]);
  });

  it('reports cardinality violations with the standard result fields', async () => {
    const { m, id, iri } = build();
    let n = withPersonShape(m, iri);
    n = edit(addValue(n, id.Bob, { prop: id['has name'], value: 'Bob' }));
    n = edit(addValue(n, id.Bob, { prop: id['has name'], value: 'Robert' }));
    const { summary, findings } = await shaclFindings(n);
    expect(summary).toMatchObject({ status: 'violations', violations: 2 });
    // Ann is an Employee: the target class reaches her through rdfs:subClassOf in the data graph.
    const ann = findings.find((f) => f.entity?.name === 'Ann')!;
    expect(ann).toMatchObject({ category: 'shacl', severity: 'error', rule: 'MinCount', property: ':hasName', entity: { kind: 'term', id: id.Ann, type: 'individual' }, shapeId: n.shapes.nodes[0].id });
    expect(ann.shacl).toMatchObject({ focusNode: ':Ann', resultPath: ':hasName', sourceShape: 'a property shape of :PersonShape', sourceConstraintComponent: 'sh:MinCountConstraintComponent', resultSeverity: 'sh:Violation' });
    // A missing value has no sh:value, and none is invented.
    expect(ann.shacl).not.toHaveProperty('value');
    expect(findings.find((f) => f.entity?.name === 'Bob')).toMatchObject({ rule: 'MaxCount', shacl: { sourceConstraintComponent: 'sh:MaxCountConstraintComponent' } });
    // Acme is no Person: not a focus node.
    expect(findings.some((f) => f.entity?.name === 'Acme')).toBe(false);
  });

  it('reports datatype and range violations, and severities other than Violation', async () => {
    const { m, id, iri } = build();
    let n = withPersonShape(m, iri);
    n = { ...n, shapes: { ...n.shapes, nodes: n.shapes.nodes.map((s) => ({ ...s, properties: s.properties.map((p, i) => (i === 1 ? { ...p, severity: 'Warning' as const, message: 'An age is a whole number, 0 or more.' } : { ...p, minCount: undefined })) })) } };
    // The property says integer, but the value states its own datatype: the data is what is validated.
    n = { ...n, terms: n.terms.map((t) => (t.id === id.Ann ? { ...t, values: [{ prop: id['has age'], value: '-3' }] } : t.id === id.Bob ? { ...t, values: [{ prop: id['has age'], value: '41.5', dt: 'xsd:decimal' }] } : t)) };
    const { summary, findings } = await shaclFindings(n);
    expect(summary).toMatchObject({ status: 'violations', violations: 0, warnings: 2 });
    expect(findings.find((f) => f.entity?.name === 'Ann')).toMatchObject({ severity: 'warning', rule: 'MinInclusive', message: 'An age is a whole number, 0 or more.', shacl: { value: '"-3"', resultSeverity: 'sh:Warning' } });
    expect(findings.find((f) => f.entity?.name === 'Bob')).toMatchObject({ rule: 'Datatype', shacl: { value: '"41.5"', sourceConstraintComponent: 'sh:DatatypeConstraintComponent' } });
  });

  it('validates imported data, with or without the ontology’s triples, and keeps the graphs apart', async () => {
    const { m, iri } = build();
    const n = withPersonShape(m, iri);
    const text = `@prefix : <http://example.org/p#> . @prefix x: <http://data.example/> .\nx:carol a :Employee .\nx:dan a :Person ; :hasName "Dan" .`;
    const withOntology: DataGraph = { source: 'imported', name: 'staff.ttl', text, includeOntology: true };
    const a = await shaclFindings(n, withOntology);
    // The model's own individuals are in the ontology's triples, so they are validated as well.
    expect(a.findings.map((f) => f.shacl!.focusNode).sort()).toEqual([':Ann', ':Bob', '<http://data.example/carol>']);
    expect(a.findings.find((f) => f.shacl!.focusNode.includes('carol'))!.entity).toMatchObject({ kind: 'external', type: 'data' });
    // Without them carol is an Employee of an unknown class: nothing says an Employee is a Person.
    const b = await shaclFindings(n, { ...withOntology, includeOntology: false });
    expect(b.summary).toMatchObject({ status: 'conforms', includesOntology: false, dataSource: 'staff.ttl' });
    // Neither the shapes nor the imported data ever reach the ontology's own RDF.
    expect(toTurtle(n)).not.toMatch(/sh:|shacl|carol/);
    expect((await shaclFindings(n, { source: 'imported', text: 'this is not turtle', includeOntology: false })).summary).toMatchObject({ status: 'failed' });
  });

  it('writes the editor’s shapes as SHACL and reads them back unchanged', () => {
    const { m, iri } = build();
    const n = withPersonShape(m, iri);
    const shape = n.shapes.nodes[0];
    shape.properties.push({ ...newPropertyShape(iri('has name')), inverse: true, nodeKind: 'IRI', pattern: '^[A-Z]', flags: 'i', in: [{ v: 'a' }, { v: iri('Ann'), iri: true }, { v: '3', dt: 'xsd:integer' }], severity: 'Info', class: iri('Person'), languageIn: ['en', 'nl'], uniqueLang: true, minLength: 1, maxLength: 80, hasValue: { v: 'x', lang: 'en' } });
    shape.targetNode = [iri('Ann')];
    shape.targetSubjectsOf = [iri('has age')];
    shape.closed = true;
    const ttl = shapesToTurtle(n);
    expect(ttl).toContain(':PersonShape a sh:NodeShape');
    expect(ttl).toContain('sh:targetClass :Person');
    expect(ttl).toMatch(/sh:property \[\n\s+sh:path :hasName ;\n\s+sh:datatype xsd:string ;\n\s+sh:minCount 1 ;\n\s+sh:maxCount 1\n\s+\]/);
    expect(ttl).toContain('sh:minInclusive "0"^^xsd:integer');
    expect(ttl).toContain('sh:path [ sh:inversePath :hasName ]');
    expect(ttl).toContain('sh:in ( "a" :Ann "3"^^xsd:integer )');
    const back = importShapes(m, ttl, { nodes: [], extra: '' });
    expect(back).toMatchObject({ editable: 1, kept: 0 });
    const strip = (s: unknown) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'id' ? undefined : v)));
    expect(strip(back.shapes.nodes)).toEqual(strip(n.shapes.nodes));
    expect(shapesToTurtle({ ...m, shapes: back.shapes })).toBe(ttl);
  });

  it('keeps an imported shape it has no fields for as written, and still validates with it', async () => {
    const { m } = build();
    const ttl = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix : <http://example.org/p#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:SimpleShape a sh:NodeShape ; sh:targetClass :Organisation ; sh:property [ sh:path :hasName ; sh:minCount 1 ] .
:EitherShape a sh:NodeShape ; sh:targetClass :Person ; sh:or ( [ sh:path :hasName ; sh:minCount 1 ] [ sh:path :hasAge ; sh:minCount 1 ] ) .`;
    const got = importShapes(m, ttl);
    expect(got).toMatchObject({ editable: 1, kept: 1 });
    expect(got.reasons[0]).toBe(':EitherShape: uses sh:or on a node shape');
    expect(got.shapes.nodes.map((s) => s.name)).toEqual(['SimpleShape']);
    expect(got.shapes.extra).toContain('sh:or');
    expect(got.shapes.extra).not.toContain('SimpleShape');
    const n = { ...m, shapes: got.shapes };
    const { findings, summary } = await shaclFindings(n);
    expect(summary.shapes).toBe(2);
    expect(findings.map((f) => `${f.entity?.name}:${f.rule}`).sort()).toEqual(['Acme:MinCount', 'Ann:Or', 'Bob:Or']);
    // Importing the same file again changes nothing.
    const again = importShapes(n, ttl);
    expect(again.shapes.nodes.length).toBe(1);
    expect((again.shapes.extra.match(/sh:or/g) ?? []).length).toBe(1);
  });

  it('does not turn OWL restrictions into shapes', async () => {
    const { m, id } = build();
    const n = { ...m, relations: [...m.relations, newRelation({ from: id.Person, to: id['has name'], kind: 'property', restriction: 'min', restrictionN: 1 })] };
    expect(shapesToTurtle(n)).toBe('');
    expect((await shaclFindings(n)).summary.status).toBe('skipped');
  });
});

describe('ontology quality', () => {
  const rules = (m: Model) => qualityFindings(m).findings.map((f) => f.ruleId);

  it('reports missing annotations as suggestions, never as errors', () => {
    const { m, id } = build();
    const n = { ...m, terms: m.terms.map((t) => (t.id === id.Actor ? { ...t, description: '' } : t.id === id.Bob ? { ...t, name: '' } : t)) };
    const f = qualityFindings(n).findings;
    expect(f.find((x) => x.ruleId === 'missing-definition')).toMatchObject({ category: 'quality', severity: 'info', rule: 'Missing definition', entity: { name: 'Actor', type: 'class' } });
    const unnamed = f.find((x) => x.ruleId === 'missing-label')!;
    expect(unnamed).toMatchObject({ severity: 'warning', entity: { type: 'individual' } });
    // A quick fix says what it will do, and does only that.
    expect(unnamed.fix!.preview).toBe('Sets the label (rdfs:label) to “Bob”, taken from the last part of its IRI <http://example.org/p#Bob>. The IRI is not changed.');
    const fixed = unnamed.fix!.apply(n);
    expect(fixed.terms.find((t) => t.id === id.Bob)).toMatchObject({ name: 'Bob', iri: 'http://example.org/p#Bob' });
    expect(fixed.relations).toBe(n.relations);
    expect(owlFindings(n).findings).toEqual([]);
  });

  it('offers to tag untagged annotations with the model’s language', () => {
    const { m, id } = build();
    const n = { ...m, terms: m.terms.map((t) => (t.id === id.Actor ? { ...t, fields: [{ key: 'skos:scopeNote', value: 'Stage and screen.' }, { key: 'skos:notation', value: 'A1' }] } : t)) };
    const f = qualityFindings(n).findings.find((x) => x.ruleId === 'missing-language')!;
    expect(f.message).toBe('“Actor” has 1 annotation without a language: skos:scopeNote.');
    // A code is not text in a language and is left alone.
    expect(f.fix!.apply(n).terms.find((t) => t.id === id.Actor)!.fields).toEqual([{ key: 'skos:scopeNote', value: 'Stage and screen.', lang: 'en' }, { key: 'skos:notation', value: 'A1' }]);
  });

  it('treats multiple inheritance as valid: off by default, reported only when asked for', () => {
    const { m, id } = build();
    const n = edit(addIsA(m, id.Actor, id.Employee));
    expect(rules(n)).not.toContain('multiple-inheritance');
    expect(owlFindings(n).findings).toEqual([]);
    const asked = { ...n, quality: setRule(n.quality, 'multiple-inheritance', true) };
    expect(qualityFindings(asked).findings.find((f) => f.ruleId === 'multiple-inheritance')).toMatchObject({ severity: 'info', entity: { name: 'Actor' }, message: '“Actor” has 2 parents: Person, Employee.' });
  });

  it('lets each rule be switched off and on, keeping only what differs from the default', () => {
    const { m, id } = build();
    const n = { ...m, terms: m.terms.map((t) => (t.id === id.Actor ? { ...t, description: '' } : t)) };
    expect(rules(n)).toContain('missing-definition');
    const off = { ...n, quality: setRule(n.quality, 'missing-definition', false) };
    expect(off.quality).toEqual({ off: ['missing-definition'], on: [] });
    expect(rules(off)).not.toContain('missing-definition');
    expect(setRule(off.quality, 'missing-definition', true)).toEqual({ off: [], on: [] });
    expect(rules(n)).not.toContain('root-class');
    expect(rules({ ...n, quality: setRule(n.quality, 'root-class', true) })).toContain('root-class');
    const s = qualityFindings(off).summary;
    // The one switched off here, and those that are off until asked for.
    expect(s.rulesOn).toBe(s.rulesTotal - 1 - QUALITY_RULES.filter((r) => !r.default).length);
  });

  it('finds redundant superclasses, duplicate statements and questionable IRIs, and removes nothing by itself', () => {
    const { m, id } = build();
    let n = edit(addIsA(m, id.Employee, id.Agent));
    n = { ...n, relations: [...n.relations, newRelation({ from: id.Ann, to: id.Acme, label: 'works for' })], terms: n.terms.map((t) => (t.id === id.Acme ? { ...t, iri: 'not an iri' } : t.id === id.Bob ? { ...t, iri: 'http://elsewhere.org/Bob' } : t)) };
    const f = qualityFindings(n).findings;
    const redundant = f.find((x) => x.ruleId === 'redundant-subclass')!;
    expect(redundant).toMatchObject({ severity: 'info', entity: { name: 'Employee' } });
    // Logically redundant is not wrong: there is advice, and no button that deletes it.
    expect(redundant.fix).toBeUndefined();
    const dup = f.find((x) => x.ruleId === 'duplicate-axiom')!;
    expect(dup.fix!.preview).toMatch(/Removes the later of the two identical relationships “Ann” → “Acme”/);
    expect(dup.fix!.apply(n).relations.length).toBe(n.relations.length - 1);
    expect(f.find((x) => x.ruleId === 'malformed-iri')).toMatchObject({ entity: { name: 'Acme' }, severity: 'warning' });
    expect(f.find((x) => x.ruleId === 'namespace-usage')!.message).toMatch(/1 entity is in the namespace <http:\/\/elsewhere.org\/>, which has no prefix: Bob/);
  });

  it('points out a shape that refers to something not in the ontology', () => {
    const { m, iri } = build();
    const n = withPersonShape(m, iri);
    expect(rules(n)).not.toContain('unresolved-reference');
    n.shapes.nodes[0].targetClass = ['http://example.org/p#Persn'];
    expect(qualityFindings(n).findings.find((f) => f.ruleId === 'unresolved-reference')).toMatchObject({ severity: 'info', entity: { kind: 'shape', name: 'Person' } });
  });
});

describe('validation runs and their synchronisation with the model', () => {
  it('runs all three, keeps them apart by category, and knows when it has gone stale', async () => {
    const { m, id, iri } = build();
    let n = withPersonShape(m, iri);
    n = { ...n, terms: n.terms.map((t) => (t.id === id.Actor ? { ...t, description: '' } : t)) };
    const phases: string[] = [];
    const run = await validate(n, MODEL_DATA, 'all', null, async (p) => void phases.push(p));
    expect(phases.filter(Boolean)).toEqual(['Reasoning…', 'Checking quality rules…', 'Validating against the shapes…']);
    expect(run.owl!.status).toBe('consistent');
    expect(run.shacl!.violations).toBe(2);
    expect(run.quality!.suggestions).toBeGreaterThan(0);
    expect(new Set(run.findings.map((f) => f.category))).toEqual(new Set(['shacl', 'quality']));
    expect(run.findings[0].severity).toBe('error');
    expect(run.revision).toMatch(/^[0-9a-f]{8}$/);
    expect(isStale(run, n, MODEL_DATA)).toBe(false);

    // Moving a term is not a change to what was validated.
    const moved = { ...n, terms: n.terms.map((t) => (t.id === id.Ann ? { ...t, x: t.x + 40 } : t)) };
    expect(isStale(run, moved, MODEL_DATA)).toBe(false);
    // Giving Ann a name is: the results are stale, and are not silently kept.
    const fixed = edit(addValue(moved, id.Ann, { prop: id['has name'], value: 'Ann' }));
    expect(isStale(run, fixed, MODEL_DATA)).toBe(true);
    const next = await validate(fixed, MODEL_DATA, 'shacl', run);
    expect(next.shacl!.violations).toBe(1);
    // Only SHACL was rerun, on a changed model: the other categories are absent, not shown as if current.
    expect(next.owl).toBeUndefined();
    expect(next.quality).toBeUndefined();
    expect(next.findings.every((f) => f.category === 'shacl')).toBe(true);
    expect(next.revision).not.toBe(run.revision);
    // The same content has the same revision, whenever it is validated.
    expect((await validate(n, MODEL_DATA, 'all', null)).revision).toBe(run.revision);
    // Rerunning one category on an unchanged model keeps the others.
    const partial = await validate(n, MODEL_DATA, 'quality', run);
    expect(partial.shacl).toBe(run.shacl);
    expect(partial.findings.filter((f) => f.category === 'shacl').length).toBe(2);
    // Another data graph is another thing validated.
    expect(isStale(run, n, { source: 'imported', text: '', includeOntology: true })).toBe(true);
  });

  it('exports the report as JSON and as RDF', async () => {
    const { m, iri } = build();
    const n = withPersonShape(m, iri);
    const run = await validate(n, MODEL_DATA, 'all', null);
    const json = JSON.parse(reportJson(run, n));
    expect(json).toMatchObject({ ontology: { name: 'People', iri: 'http://example.org/p' }, revision: run.revision, owl: { status: 'consistent' }, shacl: { status: 'violations', violations: 2 }, dataGraph: { source: 'model', includesOntologyTriples: true } });
    expect(json.findings.find((f: { category: string }) => f.category === 'SHACL').shacl.sourceConstraintComponent).toBe('sh:MinCountConstraintComponent');
    expect(json.model).toBeUndefined();
    const ttl = reportTurtle(run, n);
    expect(ttl).toContain('a cw:ValidationRun');
    expect(ttl).toMatch(/sh:ValidationReport/);
    expect(ttl).toMatch(/sh:conforms false/);
    // Both parts are RDF that parses.
    expect(() => fromTurtle(ttl)).not.toThrow();
  });
});

describe('persistence of shapes and rule settings', () => {
  it('keeps them through the app’s own file format, a model without them, and My Models', async () => {
    const { m, iri } = build();
    const n = { ...withPersonShape(m, iri), quality: { off: ['missing-definition'], on: ['root-class'] } };
    n.shapes.extra = '@prefix sh: <http://www.w3.org/ns/shacl#> .\n<http://example.org/p#X> a sh:NodeShape .\n';
    expect(normalizeModel(JSON.parse(JSON.stringify(n)))).toEqual(n);
    // A model saved before there were shapes opens with none.
    const { shapes: _s, quality: _q, ...old } = JSON.parse(JSON.stringify(n));
    expect(normalizeModel(old)).toMatchObject({ shapes: { nodes: [], extra: '' }, quality: { off: [], on: [] } });
    const info = await saveModel(n);
    const back = (await loadModel(info.id))!.model;
    expect(back.shapes).toEqual(n.shapes);
    expect(back.quality).toEqual(n.quality);
    expect(shapesToTurtle(back)).toBe(shapesToTurtle(n));
  });
});
