import { describe, expect, it } from 'vitest';
import { checkExpression } from './expressionCheck';
import { addOperand, draftText, fromDraft, hole, removeNode, toDraft, unwrapNode, withKind, withProperty, wrapNode, type DraftNode } from './expressionDraft';
import { dataProperty, functionalSyntax, individual, objectProperty, OWL, XSD, type ClassExpression } from './expressions';
import { classText, completionsAt, dataText, formatClass, namingFor, parseClass, parseDataRange, parseLiteral, ParseError, readText } from './manchester';
import { fromTurtle } from './rdf';

const M = 'http://example.org/m#';
const model = fromTurtle(`@prefix : <${M}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/m> a owl:Ontology .
:Person a owl:Class ; rdfs:label "Person" . :Student a owl:Class ; rdfs:label "Student" . :Organization a owl:Class ; rdfs:label "Organization" .
:PhysicalAddress a owl:Class ; rdfs:label "PhysicalAddress" . :Country a owl:Class ; rdfs:label "Country" .
:hasChild a owl:ObjectProperty ; rdfs:label "hasChild" . :hasParent a owl:ObjectProperty ; rdfs:label "hasParent" .
:hasMember a owl:ObjectProperty ; rdfs:label "hasMember" . :locatedIn a owl:ObjectProperty ; rdfs:label "locatedIn" .
:tookPartIn a owl:ObjectProperty ; rdfs:label "took part in" .
:hasAge a owl:DatatypeProperty ; rdfs:label "hasAge" . :hasName a owl:DatatypeProperty ; rdfs:label "hasName" .
:Red a owl:NamedIndividual ; rdfs:label "Red" . :Yellow a owl:NamedIndividual ; rdfs:label "Yellow" . :Green a owl:NamedIndividual ; rdfs:label "Green" .
:Size a rdfs:Datatype ; rdfs:label "Size" ; owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( "S" "L" ) ] .`);
const n = namingFor(model);
const c = (local: string): ClassExpression => ({ type: 'Class', iri: M + local });

describe('Manchester syntax: reading and writing', () => {
  it('reads the examples of the request into the expressions they are', () => {
    expect(parseClass('Person and\n(hasChild some (Person and Student))', n)).toEqual({ type: 'ObjectIntersectionOf', operands: [c('Person'), { type: 'ObjectSomeValuesFrom', property: objectProperty(M + 'hasChild'), filler: { type: 'ObjectIntersectionOf', operands: [c('Person'), c('Student')] } }] });
    expect(parseClass('hasChild only (Person or Organization)', n)).toMatchObject({ type: 'ObjectAllValuesFrom', filler: { type: 'ObjectUnionOf' } });
    expect(parseClass('hasChild exactly 2 Person', n)).toEqual({ type: 'ObjectExactCardinality', n: 2, property: objectProperty(M + 'hasChild'), filler: c('Person') });
    expect(parseClass('hasParent some (\n    Person and (hasAge some xsd:integer)\n)', n)).toMatchObject({ filler: { operands: [c('Person'), { type: 'DataSomeValuesFrom', property: dataProperty(M + 'hasAge'), filler: { type: 'Datatype', iri: XSD + 'integer' } }] } });
    expect(parseClass('inverse hasMember some Organization', n)).toEqual({ type: 'ObjectSomeValuesFrom', property: { type: 'ObjectInverseOf', property: objectProperty(M + 'hasMember') }, filler: c('Organization') });
    expect(parseClass('inverse (hasMember) some Organization', n)).toEqual(parseClass('inverse hasMember some Organization', n));
    expect(parseClass('hasAge some xsd:integer[>= 18]', n)).toEqual({ type: 'DataSomeValuesFrom', property: dataProperty(M + 'hasAge'), filler: { type: 'DatatypeRestriction', datatype: XSD + 'integer', facets: [{ facet: XSD + 'minInclusive', value: { value: '18', datatype: XSD + 'integer' } }] } });
    expect(parseClass('{Red, Yellow, Green}', n)).toEqual({ type: 'ObjectOneOf', individuals: ['Red', 'Yellow', 'Green'].map((x) => individual(M + x)) });
    expect(parseDataRange('{"a", "b"@en, 3, true}', n)).toMatchObject({ type: 'DataOneOf', literals: [{ value: 'a' }, { value: 'b', lang: 'en' }, { value: '3', datatype: XSD + 'integer' }, { value: 'true', datatype: XSD + 'boolean' }] });
    expect(parseClass('PhysicalAddress and (locatedIn some Country)', n)).toMatchObject({ type: 'ObjectIntersectionOf' });
  });

  it('writes what it reads, and reads what it writes, for every construct', () => {
    const texts = [
      'Person',
      'Person and Student',
      'Person or Organization',
      'not Person',
      'Person and not (Student or Organization)',
      '{Red, Yellow, Green}',
      'hasChild some Person',
      'hasChild only (Person or Organization)',
      'hasChild value Red',
      'hasChild Self',
      'hasChild min 1',
      'hasChild max 3 Person',
      'hasChild exactly 2 (Person and not Student)',
      'inverse hasMember some Organization',
      'inverse hasMember only Person',
      'inverse hasMember Self',
      'hasAge some xsd:integer[>= 18, < 130]',
      'hasAge only (xsd:integer or xsd:decimal)',
      'hasAge value 42',
      'hasName value "Ann"@en',
      'hasAge exactly 1 xsd:integer',
      'hasAge min 1',
      "'took part in' some (Person and (hasChild some (Person and Student)))",
      'owl:Thing and not owl:Nothing',
      'hasName some Size',
    ];
    for (const text of texts) {
      const e = parseClass(text, n);
      expect(classText(e, n)).toBe(text);
      expect(parseClass(classText(e, n), n)).toEqual(e);
      // Laid out over lines, it reads the same.
      expect(parseClass(formatClass(e, n, 20), n)).toEqual(e);
    }
  });

  it('lays a long expression out over lines, one operand to a line, nested ones indented', () => {
    const e = parseClass('Person and (hasChild some (Person and (hasAge some xsd:integer[>= 18]) and (hasChild some Student)))', n);
    const text = formatClass(e, n, 40);
    expect(text.split('\n').length).toBeGreaterThan(2);
    expect(text).toMatch(/^Person\nand \(hasChild some\n/);
    expect(parseClass(text, n)).toEqual(e);
  });

  it('agrees with OWL functional-style syntax, the form the OWL API reads', () => {
    expect(functionalSyntax(parseClass('inverse hasMember some (Organization and not Person)', n))).toBe(`ObjectSomeValuesFrom(ObjectInverseOf(<${M}hasMember>) ObjectIntersectionOf(<${M}Organization> ObjectComplementOf(<${M}Person>)))`);
    expect(functionalSyntax(parseClass('hasAge some xsd:integer[>= 18]', n))).toBe(`DataSomeValuesFrom(<${M}hasAge> DatatypeRestriction(<${XSD}integer> <${XSD}minInclusive> "18"^^<${XSD}integer>))`);
    expect(functionalSyntax(parseClass('hasChild exactly 2 Person', n))).toBe(`ObjectExactCardinality(2 <${M}hasChild> <${M}Person>)`);
    expect(() => functionalSyntax({ type: 'Unparsed', turtle: '[]' })).toThrow();
  });

  it('reads a literal on its own', () => {
    expect(parseLiteral('"2026-10-14"^^xsd:date', n)).toEqual({ value: '2026-10-14', datatype: XSD + 'date' });
    expect(parseLiteral('1.5', n)).toEqual({ value: '1.5', datatype: XSD + 'decimal' });
    expect(() => parseLiteral('Person', n)).toThrow(ParseError);
  });
});

describe('Manchester syntax: what is wrong, said in the terms of the ontology', () => {
  const error = (text: string, data = false) => {
    try {
      if (data) parseDataRange(text, n);
      else parseClass(text, n);
    } catch (e) {
      return e as ParseError;
    }
    throw new Error(`“${text}” was read`);
  };

  it('tells a syntax error from a name that does not exist, and says where', () => {
    expect(error('Person and (Student')).toMatchObject({ message: 'A closing ) is missing at the end.', at: 19 });
    expect(error('Person Student')).toMatchObject({ message: expect.stringMatching(/^Nothing more was expected here: “Student”/), at: 7 });
    expect(error('Person and Nobody')).toMatchObject({ message: 'There is no class called “Nobody”.', at: 11 });
    expect(error('Person and ?')).toMatchObject({ message: expect.stringMatching(/still to be chosen/), at: 11 });
  });

  it('tells which kind of entity stands where another is wanted', () => {
    expect(error('hasAge some Person').message).toBe('“Person” is a class, not a datatype for the data property hasAge: a data property has literals as its values.');
    expect(error('hasChild some xsd:integer').message).toBe('“xsd:integer” is a datatype; hasChild is an object property, whose values are individuals of a class.');
    expect(error('hasChild value 3').message).toBe('hasChild is an object property: its value is an individual, not a literal.');
    expect(error('inverse hasAge some Person').message).toBe('“hasAge” is a data property, not an object property: only an object property has an inverse.');
    expect(error('hasAge Self').message).toBe('Only an object property can relate a thing to itself (Self).');
    expect(error('hasChild').message).toBe('“hasChild” is a property: say how it restricts, with some, only, value, min, max or exactly.');
    expect(error('Red and Person').message).toBe('“Red” is an individual, not a class.');
    expect(error('xsd:integer[length 3, size 4]', true).message).toMatch(/“size” is not a facet/);
  });

  it('finds, in an expression that reads, what OWL 2 DL does not allow of its entities', () => {
    const iri = (s: string) => s;
    expect(checkExpression({ type: 'DataSomeValuesFrom', property: dataProperty(M + 'hasChild'), filler: { type: 'Datatype', iri: XSD + 'integer' } }, n)).toEqual([{ severity: 'error', message: 'hasChild is an object property: its values are individuals, not literals.' }]);
    expect(checkExpression(parseClass('hasAge some xsd:integer[length 3]', n), n)).toEqual([{ severity: 'error', message: 'xsd:integer has no facet xsd:length: it has xsd:minInclusive, xsd:minExclusive, xsd:maxInclusive, xsd:maxExclusive.' }]);
    expect(checkExpression(parseClass('hasAge value "abc"^^xsd:integer', n), n)[0]).toMatchObject({ severity: 'error', message: expect.stringMatching(/^The value of hasAge: “abc” is not/) });
    expect(checkExpression({ type: 'Class', iri: iri(M + 'Red') }, n)).toEqual([{ severity: 'warning', message: 'Red is an individual in this model, not a class. OWL allows one IRI for both, but check it is meant.' }]);
    expect(checkExpression(parseClass('Person and (hasChild some (Person and Student))', n), n)).toEqual([]);
  });
});

describe('Manchester syntax: for the text editor', () => {
  const options = (text: string, at = text.length, as: 'class' | 'data' = 'class') => completionsAt(text, at, n, as).options.map((o) => o.text);

  it('offers what the grammar takes where the cursor is', () => {
    expect(options('')).toEqual(expect.arrayContaining(['Person', 'hasChild', 'hasAge', 'not', 'inverse']));
    expect(options('hasChild ')).toEqual(['some', 'only', 'value', 'min', 'max', 'exactly', 'Self']);
    expect(options('hasAge ')).toEqual(['some', 'only', 'value', 'min', 'max', 'exactly']);
    expect(options('hasChild some ')).toEqual(expect.arrayContaining(['Person', 'Student', 'not']));
    expect(options('hasChild some ')).not.toContain('xsd:integer');
    expect(options('hasAge some ')).toEqual(expect.arrayContaining(['xsd:integer', 'Size']));
    expect(options('hasAge some ')).not.toContain('Person');
    expect(options('hasChild value ')).toEqual(['Red', 'Yellow', 'Green']);
    expect(options('Person ')).toEqual(['and', 'or']);
    expect(options('Person and Stu')).toEqual(['Student']);
    expect(options("'took p")).toEqual(["'took part in'"]);
    expect(options('hasAge some xsd:integer[')).toEqual(expect.arrayContaining(['>=', 'length', 'pattern']));
    expect(completionsAt('Person and Stu', 14, n, 'class').from).toBe(11);
  });

  it('reads the text for highlighting: each name as what it is, and the first problem', () => {
    const r = readText('hasChild some (Person and Nobody)', n, 'class');
    expect(r.tokens.map((t) => [t.text, t.kind, t.entity ?? ''])).toEqual([
      ['hasChild', 'name', 'object'],
      ['some', 'keyword', ''],
      ['(', 'punct', ''],
      ['Person', 'name', 'class'],
      ['and', 'keyword', ''],
      ['Nobody', 'name', 'unknown'],
      [')', 'punct', ''],
    ]);
    expect(r.error).toMatchObject({ message: 'There is no class called “Nobody”.', at: 26 });
    expect(readText('hasAge some Size', n, 'class').tokens.map((t) => t.entity ?? '')).toEqual(['data', '', 'enum']);
  });
});

describe('the visual editor’s draft', () => {
  const d = (text: string) => toDraft(parseClass(text, n));
  const value = (x: DraftNode) => fromDraft(x, 'class').value;

  it('is the expression it was made from, through and back', () => {
    for (const text of ['Person and (hasChild some (Person and Student))', 'inverse hasMember some Organization', 'hasAge some xsd:integer[>= 18]', '{Red, Yellow, Green}', 'hasChild exactly 2 Person', 'hasName value "Ann"@en', 'hasAge only (xsd:integer or {1, 2})']) {
      expect(value(d(text))).toEqual(parseClass(text, n));
      expect(draftText(d(text), n, 'class')).toBe(text);
    }
  });

  it('keeps what a block has when its operator changes, and gives it back', () => {
    const some = d('hasChild some Person');
    const min = withKind(some, 'min', 'class');
    expect(value(min)).toEqual(parseClass('hasChild min 1 Person', n));
    const only = withKind(min, 'only', 'class');
    expect(value(only)).toEqual(parseClass('hasChild only Person', n));
    const and = d('Person and Student and Organization');
    expect(value(withKind(and, 'or', 'class'))).toEqual(parseClass('Person or Student or Organization', n));
    // A class picked earlier comes back when the block is a class again.
    const cls = d('Person');
    expect(value(withKind(withKind(cls, 'some', 'class'), 'class', 'class'))).toEqual(c('Person'));
  });

  it('wraps, unwraps, adds and takes away blocks', () => {
    const p = d('Person');
    const wrapped = wrapNode(p, p.key, 'and');
    expect(fromDraft(wrapped, 'class').problems.map((x) => x.message)).toEqual(['Choose what goes here: a class, a restriction, or an expression of them.']);
    const filled = { ...wrapped, children: [wrapped.children[0], d('Student')] };
    expect(value(filled)).toEqual(parseClass('Person and Student', n));
    const three = addOperand(filled, filled.key);
    expect(three.children).toHaveLength(3);
    expect(removeNode(three, three.children[2].key).children).toHaveLength(2);
    expect(value(unwrapNode(filled, filled.key))).toEqual(c('Person'));
    expect(value(wrapNode(p, p.key, 'not'))).toEqual(parseClass('not Person', n));
  });

  it('says what is still to be done, at the block, and never makes an expression of an unfinished draft', () => {
    const r = fromDraft({ ...hole(), kind: 'some', children: [hole()] }, 'class');
    expect(r.value).toBeUndefined();
    expect(r.problems.map((x) => x.message)).toEqual(['Choose the property it restricts.']);
    const and = withKind(hole(), 'and', 'class');
    expect(fromDraft(and, 'class').problems).toHaveLength(2);
    expect(draftText(and, n, 'class')).toBe('? and ?');
    expect(fromDraft({ ...hole(), kind: 'datatype', iri: XSD + 'integer' }, 'class').problems[0].message).toBe('A datatype cannot stand here: this is a class expression.');
  });

  it('puts a filler aside for a hole when the property changes from object to data', () => {
    const some = d('hasChild some Person');
    const data = withProperty(some, { iri: M + 'hasAge', kind: 'data' });
    expect(data.children[0].kind).toBe('hole');
    expect(fromDraft(data, 'class').problems[0].message).toBe('Choose a datatype, or an expression of datatypes.');
    expect(value(withProperty(some, { iri: M + 'hasParent', kind: 'object' }))).toEqual(parseClass('hasParent some Person', n));
  });

  it('reads owl:Thing', () => {
    expect(value(d('owl:Thing'))).toEqual({ type: 'Class', iri: OWL + 'Thing' });
    expect(dataText(parseDataRange('Size', n), n)).toBe('Size');
  });
});
