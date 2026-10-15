import { describe, expect, it } from 'vitest';
import { runChecks } from './checks';
import { removeDatatype } from './datatypes';
import { propDatatype, unionClasses, withDatatype, withUnionClasses } from './domains';
import { objectProperty, OWL, XSD, type ClassAxiom, type ClassExpression, type DataRange, type DataRangeAxiom } from './expressions';
import { setIriSuffix } from './iri';
import { classText, dataText, hasUnparsed, namingFor, parseClass, parseDataRange, ParseError } from './manchester';
import { loadOxigraph } from './oxigraph';
import { dataDomain, objectProperties } from './props';
import { fromTurtle, toJsonLd, toTurtle } from './rdf';
import { reason } from './reasoner';
import { useStore } from './store';
import { MODEL_VERSION, normalizeModel, type Model } from './types';
import { statementsOf } from './unmapped';

/**
 * Domains and ranges as axioms (model format 3): each rdfs:domain or rdfs:range statement is one
 * axiom with a structured expression, several hold together, and none is merged into another.
 */

const P = `@prefix : <http://example.org/d#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/d> a owl:Ontology .
`;
const D = 'http://example.org/d#';
const cls = (local: string): ClassExpression => ({ type: 'Class', iri: D + local });
const union = (...locals: string[]): ClassExpression => ({ type: 'ObjectUnionOf', operands: locals.map(cls) });
const expressions = (axioms: ClassAxiom[] | undefined) => axioms?.map((a) => a.expression);
const ranges = (axioms: DataRangeAxiom[] | undefined) => axioms?.map((a) => a.range);
const prop = (m: Model, local: string) => m.props.find((p) => p.iri === D + local)!;
const term = (m: Model, local: string) => m.terms.find((t) => t.iri === D + local)!;
/** The statements of a document, each as canonical text, in order: two documents that say the same have the same. */
const statements = (ttl: string) => statementsOf(ttl).map((s) => s.text).sort();
/** The domain and range statements of a document. */
const domainsAndRanges = (ttl: string) => statements(ttl).filter((s) => /^<[^>]*> <http:\/\/www\.w3\.org\/2000\/01\/rdf-schema#(domain|range)> /.test(s));

// The case that started it: PROV-O states two domains of prov:hadActivity on purpose, one for
// OWL-RL and one more specific, and both hold. Merged into one union they said something else.
const PROV = `@prefix : <http://www.w3.org/ns/prov#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://www.w3.org/ns/prov-o#> a owl:Ontology .
:Influence a owl:Class .
:Delegation a owl:Class ; rdfs:subClassOf :Influence .
:Derivation a owl:Class ; rdfs:subClassOf :Influence .
:End a owl:Class ; rdfs:subClassOf :Influence .
:Start a owl:Class ; rdfs:subClassOf :Influence .
:Activity a owl:Class .
:hadActivity a owl:ObjectProperty ;
    rdfs:domain :Influence , [ a owl:Class ; owl:unionOf ( :Delegation :Derivation :End :Start ) ] ;
    rdfs:range :Activity .
`;
const PROV_NS = 'http://www.w3.org/ns/prov#';

describe('PROV-O: prov:hadActivity has two domains, and keeps both', () => {
  const m = fromTurtle(PROV);
  const hadActivity = m.props.find((p) => p.iri === PROV_NS + 'hadActivity')!;
  const c = (local: string): ClassExpression => ({ type: 'Class', iri: PROV_NS + local });

  it('reads each rdfs:domain as an axiom of its own: the class, and the union, not one union of all five', () => {
    expect(expressions(hadActivity.domains)).toEqual([c('Influence'), { type: 'ObjectUnionOf', operands: ['Delegation', 'Derivation', 'End', 'Start'].map(c) }]);
    expect(expressions(hadActivity.ranges)).toEqual([c('Activity')]);
    expect(new Set(hadActivity.domains!.map((a) => a.id)).size).toBe(2);
    // Nothing of it is left over as a statement kept as text: both are the model's, and editable.
    expect(m.unmapped ?? '').not.toContain('hadActivity');
  });

  it('shows them as two axioms that both hold', () => {
    expect(hadActivity.domains!.map((a) => classText(a.expression, namingFor(m)))).toEqual(['Influence', 'Delegation or Derivation or End or Start']);
  });

  it('writes them back as the two statements they were, and reads back the same', () => {
    const ttl = toTurtle(m);
    expect(ttl).toContain('rdfs:domain :Influence , [ a owl:Class ; owl:unionOf ( :Delegation :Derivation :End :Start ) ]');
    expect(ttl).not.toMatch(/unionOf \([^)]*:Influence/);
    expect(domainsAndRanges(ttl)).toEqual(domainsAndRanges(PROV));
    const back = fromTurtle(ttl);
    expect(expressions(back.props[0].domains)).toEqual(expressions(hadActivity.domains));
    expect(toTurtle(back)).toBe(ttl);
  });

  it('is in JSON-LD the same statements as in Turtle', async () => {
    const ox = await loadOxigraph();
    const triples = (text: string, format: string) => {
      const store = new ox.Store();
      store.load(text, { format });
      return statements(store.dump({ format: 'application/n-triples', from_graph_name: ox.defaultGraph() }));
    };
    expect(triples(toJsonLd(m), 'application/ld+json')).toEqual(triples(toTurtle(m), 'text/turtle'));
  });
});

describe('several axioms hold together; a union is one axiom', () => {
  const SOURCE = `${P}
:A a owl:Class . :B a owl:Class . :C a owl:Class . :X a owl:Class . :Y a owl:Class . :Z a owl:Class .
:p a owl:ObjectProperty ; rdfs:domain :A , :B ; rdfs:range :X , [ a owl:Class ; owl:unionOf ( :Y :Z ) ] .
:q a owl:ObjectProperty ; rdfs:domain [ a owl:Class ; owl:intersectionOf ( :A [ a owl:Class ; owl:unionOf ( :B :C ) ] ) ] .
:r a owl:ObjectProperty ; rdfs:domain [ a owl:Class ; owl:unionOf ( :A [ a owl:Class ; owl:intersectionOf ( :B [ a owl:Class ; owl:complementOf :C ] ) ] ) ] .
:d a owl:DatatypeProperty ; rdfs:domain :A , :C ; rdfs:range xsd:integer , [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:minInclusive 0 ] [ xsd:maxExclusive 150 ] ) ] .
:e a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:unionOf ( xsd:date [ a rdfs:Datatype ; owl:oneOf ( "unknown" "open"@en ) ] ) ] , [ a rdfs:Datatype ; owl:datatypeComplementOf xsd:string ] .
`;
  const m = fromTurtle(SOURCE);
  const naming = namingFor(m);

  it('reads multiple named domains as two axioms, not a union', () => {
    expect(expressions(prop(m, 'p').domains)).toEqual([cls('A'), cls('B')]);
    expect(unionClasses(prop(m, 'p').domains!)).toBeUndefined();
  });

  it('reads multiple object property ranges, one of them a union', () => {
    expect(expressions(prop(m, 'p').ranges)).toEqual([cls('X'), union('Y', 'Z')]);
  });

  it('reads nested unions, intersections and complements as the structures they are', () => {
    expect(expressions(prop(m, 'q').domains)).toEqual([{ type: 'ObjectIntersectionOf', operands: [cls('A'), union('B', 'C')] }]);
    expect(expressions(prop(m, 'r').domains)).toEqual([{ type: 'ObjectUnionOf', operands: [cls('A'), { type: 'ObjectIntersectionOf', operands: [cls('B'), { type: 'ObjectComplementOf', operand: cls('C') }] }] }]);
    expect(classText(prop(m, 'q').domains![0].expression, naming)).toBe('A and (B or C)');
    expect(classText(prop(m, 'r').domains![0].expression, naming)).toBe('A or (B and not C)');
  });

  it('reads multiple datatype property domains, and its ranges as data ranges', () => {
    expect(expressions(term(m, 'd').domains)).toEqual([cls('A'), cls('C')]);
    expect(ranges(term(m, 'd').ranges)).toEqual([
      { type: 'Datatype', iri: XSD + 'integer' },
      {
        type: 'DatatypeRestriction',
        datatype: XSD + 'integer',
        facets: [
          { facet: XSD + 'minInclusive', value: { value: '0', datatype: XSD + 'integer' } },
          { facet: XSD + 'maxExclusive', value: { value: '150', datatype: XSD + 'integer' } },
        ],
      },
    ]);
    // The datatype values are entered in is the one stated on its own; the facets hold beside it.
    expect(propDatatype(term(m, 'd'))).toBe('xsd:integer');
    expect(ranges(term(m, 'e').ranges)).toEqual([
      { type: 'DataUnionOf', operands: [{ type: 'Datatype', iri: XSD + 'date' }, { type: 'DataOneOf', literals: [{ value: 'unknown' }, { value: 'open', lang: 'en' }] }] },
      { type: 'DataComplementOf', operand: { type: 'Datatype', iri: XSD + 'string' } },
    ]);
    expect(term(m, 'e').ranges!.map((a) => dataText(a.range, naming))).toEqual(['xsd:date or {"unknown", "open"@en}', 'not xsd:string']);
  });

  it('takes every statement into the model, and writes back the same statements: import, export, import', () => {
    expect(m.unmapped).toBeUndefined();
    const ttl = toTurtle(m);
    // Every domain and range statement, as it was: none merged, none lost, none added.
    expect(domainsAndRanges(ttl)).toEqual(domainsAndRanges(SOURCE));
    expect(domainsAndRanges(ttl)).toHaveLength(12);
    const back = fromTurtle(ttl);
    for (const local of ['p', 'q', 'r']) expect([expressions(prop(back, local).domains), expressions(prop(back, local).ranges)]).toEqual([expressions(prop(m, local).domains), expressions(prop(m, local).ranges)]);
    for (const local of ['d', 'e']) expect([expressions(term(back, local).domains), ranges(term(back, local).ranges)]).toEqual([expressions(term(m, local).domains), ranges(term(m, local).ranges)]);
    expect(toTurtle(back)).toBe(ttl);
  });

  it('says a use is outside a domain of two axioms where it is outside either one', () => {
    const uses = (extra: string) =>
      fromTurtle(`${P}
:A a owl:Class . :B a owl:Class . :X a owl:Class .
:p a owl:ObjectProperty ; rdfs:domain :A , :B .
:OnlyA a owl:Class ; rdfs:subClassOf :A , [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom :X ] .
${extra}`);
    const outside = (model: Model) => runChecks(model).filter((i) => i.rule === 'Outside domain').map((i) => i.message);
    expect(outside(uses(''))).toEqual(['"Only A" uses "p", but is not B or a kind of it.']);
    expect(outside(uses(':OnlyA rdfs:subClassOf :B .'))).toEqual([]);
  });

  it('infers each class a domain of two axioms names: whatever has the property is both', () => {
    const r = reason(fromTurtle(`${P}
:A a owl:Class . :B a owl:Class .
:p a owl:ObjectProperty ; rdfs:domain :A , :B .
:i a owl:NamedIndividual ; :p :j . :j a owl:NamedIndividual .`));
    const texts = r.inferences.map((i) => i.text);
    expect(texts).toContain('“i” is an instance of “A”');
    expect(texts).toContain('“i” is an instance of “B”');
  });

  it('infers no single class from a union: “either” is not a type', () => {
    const r = reason(fromTurtle(`${P}
:A a owl:Class . :B a owl:Class .
:p a owl:ObjectProperty ; rdfs:domain [ a owl:Class ; owl:unionOf ( :A :B ) ] .
:i a owl:NamedIndividual ; :p :j . :j a owl:NamedIndividual .`));
    expect(r.inferences.map((i) => i.text).filter((t) => t.startsWith('“i” is an instance'))).toEqual([]);
  });
});

describe('a domain that only repeats the uses', () => {
  it('follows the uses again when it is one axiom naming exactly the classes used, and is stated when it is more', () => {
    const m = fromTurtle(`${P}
:A a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom :A ] , [ a owl:Restriction ; owl:onProperty :q ; owl:someValuesFrom :A ] .
:p a owl:ObjectProperty ; rdfs:domain :A .
:q a owl:ObjectProperty ; rdfs:domain :A , :A2 .
:A2 a owl:Class .`);
    expect(prop(m, 'p').domains).toBeUndefined();
    expect(expressions(prop(m, 'q').domains)).toEqual([cls('A'), cls('A2')]);
  });
});

describe('an expression the editor has no structure for', () => {
  // A restriction with two quantifiers on one node is no class expression OWL has.
  const SOURCE = `${P}
:A a owl:Class . :p a owl:ObjectProperty . :q a owl:ObjectProperty .
:s a owl:ObjectProperty ; rdfs:domain [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom :A ; owl:allValuesFrom :A ] , :A .`;
  const m = fromTurtle(SOURCE);
  const s = prop(m, 's');

  it('is kept as it was read, beside the axioms that are structured, and is written back the same', () => {
    expect(s.domains![0].expression.type).toBe('Unparsed');
    expect(hasUnparsed(s.domains![0].expression)).toBe(true);
    expect(s.domains![1].expression).toEqual(cls('A'));
    expect(m.unmapped).toBeUndefined();
    expect(domainsAndRanges(toTurtle(m))).toEqual(domainsAndRanges(SOURCE));
    expect(domainsAndRanges(toTurtle(fromTurtle(toTurtle(m))))).toEqual(domainsAndRanges(SOURCE));
    expect(statements(toTurtle(m)).filter((x) => x.startsWith(`<${D}s> <http://www.w3.org/2000/01/rdf-schema#domain>`))).toEqual([
      `<${D}s> <http://www.w3.org/2000/01/rdf-schema#domain> <${D}A> .`,
      `<${D}s> <http://www.w3.org/2000/01/rdf-schema#domain> [ <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Restriction> ; <http://www.w3.org/2002/07/owl#allValuesFrom> <${D}A> ; <http://www.w3.org/2002/07/owl#onProperty> <${D}p> ; <http://www.w3.org/2002/07/owl#someValuesFrom> <${D}A> ] .`,
    ]);
  });

  it('follows its entities when their IRIs change, as text', () => {
    const moved = setIriSuffix(m, { prop: prop(m, 'p').id }, 'pee').model!;
    expect((moved.props.find((p) => p.iri === D + 's')!.domains![0].expression as { turtle: string }).turtle).toContain(`<${D}pee>`);
  });
});

describe('editing domains and ranges, one axiom at a time', () => {
  const st = useStore.getState;
  const open = () => {
    st().replaceModel(fromTurtle(PROV));
    return st().model.props[0].id;
  };
  const domains = () => expressions(st().model.props[0].domains);
  const c = (local: string): ClassExpression => ({ type: 'Class', iri: PROV_NS + local });

  it('adds, changes and removes one axiom, leaving the others as they are, and undo takes each back', () => {
    const id = open();
    const naming = namingFor(st().model);
    const [influence, either] = st().model.props[0].domains!;
    // Changing one: it keeps its id, the other is untouched.
    st().updateProp(id, { domains: [{ ...influence, expression: parseClass('Influence and not End', naming) }, either] });
    expect(domains()).toEqual([{ type: 'ObjectIntersectionOf', operands: [c('Influence'), { type: 'ObjectComplementOf', operand: c('End') }] }, either.expression]);
    expect(st().model.props[0].domains![0].id).toBe(influence.id);
    // Removing one.
    st().updateProp(id, { domains: st().model.props[0].domains!.filter((a) => a.id !== either.id) });
    expect(domains()).toHaveLength(1);
    expect(toTurtle(st().model)).not.toContain('owl:unionOf');
    // Adding one.
    st().updateProp(id, { domains: [...st().model.props[0].domains!, { id: 'new', expression: parseClass('Start', naming) }] });
    expect(domains()).toEqual([expect.objectContaining({ type: 'ObjectIntersectionOf' }), c('Start')]);
    st().undo();
    st().undo();
    st().undo();
    expect(domains()).toEqual([influence.expression, either.expression]);
  });

  it('takes a class that is deleted out of the axioms that name it, and undo puts it back', () => {
    open();
    const end = st().model.terms.find((t) => t.iri === PROV_NS + 'End')!;
    st().remove([end.id], []);
    expect(domains()).toEqual([c('Influence'), { type: 'ObjectUnionOf', operands: ['Delegation', 'Derivation', 'Start'].map(c) }]);
    const influence = st().model.terms.find((t) => t.iri === PROV_NS + 'Influence')!;
    st().remove([influence.id], []);
    expect(domains()).toEqual([{ type: 'ObjectUnionOf', operands: ['Delegation', 'Derivation', 'Start'].map(c) }]);
    st().undo();
    st().undo();
    expect(domains()).toEqual([c('Influence'), { type: 'ObjectUnionOf', operands: ['Delegation', 'Derivation', 'End', 'Start'].map(c) }]);
  });

  it('follows a class whose IRI is changed', () => {
    open();
    const start = st().model.terms.find((t) => t.iri === PROV_NS + 'Start')!;
    const moved = setIriSuffix(st().model, { term: start.id }, 'Beginning').model!;
    expect(JSON.stringify(moved.props[0].domains)).toContain(PROV_NS + 'Beginning');
    expect(JSON.stringify(moved.props[0].domains)).not.toContain(PROV_NS + 'Start"');
  });

  it('edits a domain that is a list of classes as that list: “any of” them, one axiom', () => {
    open();
    const either = st().model.props[0].domains!.slice(1);
    expect(unionClasses(either)).toEqual(['Delegation', 'Derivation', 'End', 'Start'].map((x) => PROV_NS + x));
    const fewer = withUnionClasses(either, [PROV_NS + 'Delegation']);
    expect(fewer).toEqual([{ id: either[0].id, expression: c('Delegation') }]);
    expect(withUnionClasses(fewer, [])).toEqual([]);
  });

  it('sets a data property’s datatype without touching the rest of its range', () => {
    const m = fromTurtle(`${P}:d a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:length 4 ] ) ] , xsd:string .`);
    const d = term(m, 'd');
    const next = withDatatype(d, 'xsd:token');
    expect(next!.map((a) => a.range)).toEqual([d.ranges![0].range, { type: 'Datatype', iri: XSD + 'token' }]);
    expect(next![1].id).toBe(d.ranges![1].id);
    expect(withDatatype(d, undefined)!.map((a) => a.range)).toEqual([d.ranges![0].range]);
  });

  it('takes an enumerated datatype that is deleted out of the ranges that name it', () => {
    const m = fromTurtle(`${P}
:Size a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( "S" "L" ) ] .
:d a owl:DatatypeProperty ; rdfs:range :Size .
:e a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:unionOf ( xsd:integer :Size ) ] .`);
    const after = removeDatatype(m, m.datatypes[0].id).model!;
    expect(term(after, 'd').ranges).toBeUndefined();
    expect(ranges(term(after, 'e').ranges)).toEqual([{ type: 'Datatype', iri: XSD + 'integer' }]);
  });
});

describe('saved in format 3', () => {
  it('keeps every axiom with its id, and nothing else, through saving and opening', () => {
    const m = fromTurtle(PROV);
    const back = normalizeModel(JSON.parse(JSON.stringify(m)));
    expect(back.version).toBe(MODEL_VERSION);
    expect(back.props[0].domains).toEqual(m.props[0].domains);
    expect(back.props[0].ranges).toEqual(m.props[0].ranges);
  });

  it('drops what is not well formed, and keeps a stated “none” apart from “follows the uses”', () => {
    const raw = JSON.parse(JSON.stringify(fromTurtle(`${P}:A a owl:Class . :p a owl:ObjectProperty ; rdfs:domain :A . :q a owl:ObjectProperty . :d a owl:DatatypeProperty ; rdfs:range xsd:date .`)));
    raw.props[0].domains.push({ id: 'bad', expression: { type: 'ObjectUnionOf', operands: [{ type: 'Class', iri: D + 'A' }] } }, { id: 'worse', expression: { type: 'Nonsense' } });
    raw.props[1].domains = [];
    raw.terms.find((t: { name: string }) => t.name === 'd').ranges.push({ id: 'gone', range: { type: 'Enumeration', datatype: 'no-such-datatype' } });
    const back = normalizeModel(raw);
    expect(expressions(back.props[0].domains)).toEqual([cls('A')]);
    expect(back.props[1].domains).toEqual([]);
    expect(objectProperties(back).find((p) => p.name === 'q')).toMatchObject({ domainAuto: false, domains: [] });
    expect(ranges(back.terms.find((t) => t.name === 'd')!.ranges)).toEqual([{ type: 'Datatype', iri: XSD + 'date' }]);
  });

  it('gives a data property’s domain stated by hand, and one that follows its classes, apart', () => {
    const m = fromTurtle(`${P}:A a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :d ; owl:someValuesFrom xsd:string ] . :d a owl:DatatypeProperty ; rdfs:domain :B ; rdfs:range xsd:string . :B a owl:Class .`);
    expect(dataDomain(m, term(m, 'd'))).toMatchObject({ auto: false, axioms: [{ expression: cls('B') }], attached: [term(m, 'A').id] });
  });
});

describe('Manchester syntax', () => {
  const m = fromTurtle(`${P}
:Person a owl:Class ; rdfs:label "Person" . :Organisation a owl:Class ; rdfs:label "Organisation" . :Event a owl:Class ; rdfs:label "Event" .
:tookPartIn a owl:ObjectProperty ; rdfs:label "took part in" .
:age a owl:DatatypeProperty ; rdfs:label "age" .
:ann a owl:NamedIndividual ; rdfs:label "Ann" . :bob a owl:NamedIndividual ; rdfs:label "Bob" .
:Size a rdfs:Datatype ; rdfs:label "Size" ; owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( "S" "L" ) ] .`);
  const n = namingFor(m);

  it('reads back what it writes, for every construct', () => {
    const texts = [
      'Person',
      'Person or Organisation',
      'Person and not Organisation',
      'Person or (Organisation and Event)',
      '(Person or Organisation) and Event',
      "'took part in' some Event",
      "'took part in' only (Person or Event)",
      "'took part in' value Ann",
      "'took part in' Self",
      "'took part in' min 2 Event",
      "'took part in' max 1",
      "'took part in' exactly 3 (Event and not Person)",
      '{Ann, Bob}',
      'age some xsd:integer[>= 18, < 130]',
      'age value 42',
      'age exactly 1 xsd:integer',
      'owl:Thing',
      ':Person and <http://elsewhere.org/X>',
    ];
    for (const text of texts) {
      const e = parseClass(text, n);
      expect(parseClass(classText(e, n), n)).toEqual(e);
    }
    expect(classText(parseClass(':Person and <http://elsewhere.org/X>', n), n)).toBe('Person and <http://elsewhere.org/X>');
    expect(parseClass('Thing', n)).toEqual({ type: 'Class', iri: OWL + 'Thing' });
    const ranges = ['xsd:integer', 'xsd:integer or xsd:decimal', 'not xsd:string', '{"a", "b"@en, 3}', 'xsd:string[length 4]', 'xsd:string[pattern "[A-Z]+"]', 'Size', 'Size or xsd:boolean', '{"5"^^xsd:short}'];
    for (const text of ranges) {
      const r = parseDataRange(text, n);
      expect(parseDataRange(dataText(r, n), n)).toEqual(r);
    }
    expect(parseDataRange('Size', n)).toEqual({ type: 'Enumeration', datatype: m.datatypes[0].id });
  });

  it('says what is wrong, and where', () => {
    const fails = (text: string, data = false): ParseError => {
      try {
        if (data) parseDataRange(text, n);
        else parseClass(text, n);
      } catch (e) {
        return e as ParseError;
      }
      throw new Error(`“${text}” was read`);
    };
    expect(fails('Person or Nobody')).toMatchObject({ message: 'There is no class called “Nobody”.', at: 10 });
    expect(fails('Person or')).toMatchObject({ message: 'The expression stops short: a class is missing at the end.' });
    expect(fails('(Person or Event')).toMatchObject({ message: 'A closing ) is missing at the end.' });
    expect(fails('age some Person and')).toMatchObject({ message: expect.stringMatching(/datatype/) });
    expect(fails("'took part in' min Event").message).toBe('A whole number is expected after min.');
    expect(fails('xsd:string[size 4]', true).message).toMatch(/is not a facet/);
    expect(fails('', true).message).toMatch(/Write a datatype/);
  });

  it('writes a name with a space, or one that is a keyword, in quotes', () => {
    expect(classText({ type: 'ObjectSomeValuesFrom', property: objectProperty(D + 'tookPartIn'), filler: { type: 'Class', iri: D + 'Event' } }, n)).toBe("'took part in' some Event");
  });
});

describe('unknown and missing parts of a data range', () => {
  it('names a datatype it does not offer by its IRI, and writes it back', () => {
    const m = fromTurtle(`${P}:d a owl:DatatypeProperty ; rdfs:range xsd:nonNegativeInteger , <http://example.org/types#Money> .`);
    expect(term(m, 'd').ranges!.map((a) => a.range as DataRange)).toEqual([
      { type: 'Datatype', iri: XSD + 'nonNegativeInteger' },
      { type: 'Datatype', iri: 'http://example.org/types#Money' },
    ]);
    expect(m.unmapped).toBeUndefined();
    expect(toTurtle(m)).toContain('rdfs:range xsd:nonNegativeInteger , <http://example.org/types#Money>');
  });
});
