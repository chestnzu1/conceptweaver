import { describe, expect, it } from 'vitest';
import { classAxiomInWords, classInWords, dataRangeInWords, domainInWords, rangeInWords } from './inWords';
import { namingFor, parseClass, parseDataRange } from './manchester';
import { fromTurtle } from './rdf';

const M = 'http://example.org/m#';
const model = fromTurtle(`@prefix : <${M}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/m> a owl:Ontology .
:Person a owl:Class ; rdfs:label "Person" . :Student a owl:Class ; rdfs:label "Student" . :Organization a owl:Class ; rdfs:label "Organization" .
:Pizza a owl:Class ; rdfs:label "Pizza" . :MeatTopping a owl:Class ; rdfs:label "MeatTopping" . :Adult a owl:Class ; rdfs:label "Adult" .
:hasChild a owl:ObjectProperty ; rdfs:label "hasChild" . :hasMember a owl:ObjectProperty ; rdfs:label "hasMember" .
:hasTopping a owl:ObjectProperty ; rdfs:label "has topping" . :knows a owl:ObjectProperty ; rdfs:label "knows" .
:hasAge a owl:DatatypeProperty ; rdfs:label "hasAge" . :hasName a owl:DatatypeProperty ; rdfs:label "hasName" .
:Red a owl:NamedIndividual ; rdfs:label "Red" . :Yellow a owl:NamedIndividual ; rdfs:label "Yellow" . :Green a owl:NamedIndividual ; rdfs:label "Green" .
:Size a rdfs:Datatype ; rdfs:label "Size" ; owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( "S" "L" ) ] .`);
const n = namingFor(model);
const words = (text: string) => classInWords(parseClass(text, n), n);

describe('a class expression in words', () => {
  it('says each construct as what OWL means by it', () => {
    expect(words('Person')).toBe('a “Person”');
    expect(words('Organization')).toBe('an “Organization”');
    expect(words('owl:Thing')).toBe('anything');
    expect(words("Pizza and ('has topping' some MeatTopping)")).toBe('a “Pizza” that is related by “has topping” to at least one “MeatTopping”');
    expect(words('hasChild some Student')).toBe('something that is related by “hasChild” to at least one “Student”');
    // "Only" holds of what has none at all, which is what people get wrong; it is said.
    expect(words('hasChild only Student')).toBe('something that is related by “hasChild” only to members of “Student” (or to nothing)');
    expect(words('hasChild min 2 Student')).toBe('something that is related by “hasChild” to at least 2 members of “Student”');
    expect(words('hasChild max 1 Student')).toBe('something that is related by “hasChild” to at most one “Student”');
    expect(words('hasChild max 0')).toBe('something that is not related by “hasChild” to anything');
    expect(words('hasChild max 0 Student')).toBe('something that is not related by “hasChild” to any “Student”');
    expect(words('hasChild exactly 3')).toBe('something that is related by “hasChild” to exactly 3 things');
    expect(words('hasChild exactly 0 Student')).toBe(words('hasChild max 0 Student'));
    expect(words('hasAge exactly 0')).toBe('something that has no “hasAge” value');
    expect(words('hasChild value Red')).toBe('something that is related by “hasChild” to “Red”');
    expect(words('knows Self')).toBe('something that is related by “knows” to itself');
    expect(words('inverse hasMember some Organization')).toBe('something that is related by the inverse of “hasMember” to at least one “Organization”');
    expect(words('not Student')).toBe('something that is not a “Student”');
    expect(words('Pizza and not (\'has topping\' some MeatTopping)')).toBe('a “Pizza” that is not related by “has topping” to any “MeatTopping”');
    expect(words('not (inverse hasChild some owl:Thing)')).toBe('something that is not related by the inverse of “hasChild” to anything');
    expect(words('not (hasAge some xsd:integer)')).toBe('something that has no “hasAge” value that is a whole number');
    expect(words('not (hasChild only Student)')).toBe('something that is related by “hasChild” to at least one thing that is not a “Student”');
    expect(words('not (hasChild min 2 Student)')).toBe('something that is related by “hasChild” to at most one “Student”');
    expect(words('not (hasChild max 1)')).toBe('something that is related by “hasChild” to at least 2 things');
    expect(words('not (hasChild exactly 1)')).toBe('something that is not something that is related by “hasChild” to exactly one thing');
    expect(words('{Red, Yellow, Green}')).toBe('something that is one of “Red”, “Yellow” or “Green”');
    expect(words('Person or Organization')).toBe('something that is either a “Person” or an “Organization”');
  });

  it('says data restrictions with the values they allow', () => {
    expect(words('hasAge some xsd:integer[>= 18]')).toBe('something that has at least one “hasAge” value that is a whole number that is at least 18');
    expect(words('hasAge some xsd:integer[>= 18, < 65]')).toBe('something that has at least one “hasAge” value that is a whole number that is at least 18 and is less than 65');
    expect(words('hasName some rdfs:Literal')).toBe('something that has at least one “hasName” value');
    expect(words('hasName only xsd:string[maxLength 20]')).toBe('something that has only “hasName” values that are text that are at most 20 characters long (or none)');
    expect(words('hasName value "Ann"@en')).toBe('something that has the “hasName” value “Ann” (en)');
    expect(words('hasAge exactly 1')).toBe('something that has exactly one “hasAge” value');
    expect(words('hasAge some Size')).toBe('something that has at least one “hasAge” value that is one of the values of “Size”');
    expect(dataRangeInWords(parseDataRange('xsd:integer or xsd:decimal', n), n)).toBe('a value that is either a whole number or a decimal number');
    expect(dataRangeInWords(parseDataRange('{1, 2, 3}', n), n)).toBe('a value that is one of 1, 2 or 3');
    expect(dataRangeInWords(parseDataRange('xsd:string[pattern "[A-Z]+"]', n), n)).toBe('text that matches the pattern “[A-Z]+”');
  });

  it('nests, and makes clear where each part ends', () => {
    expect(words('hasChild some (Person and (hasChild some Student))')).toBe('something that is related by “hasChild” to at least one “Person” that is related by “hasChild” to at least one “Student”');
    expect(words('hasChild only (Person or Organization)')).toBe('something that is related by “hasChild” only to members of either “Person” or “Organization” (or to nothing)');
    // An "and" with an "or" in it: the class first, the "or" last and opened by "either"; a verb the alternatives share is said once.
    expect(words('(Person or Organization) and (hasChild some Student) and Adult')).toBe('an “Adult” that is related by “hasChild” to at least one “Student” and is either a “Person” or an “Organization”');
    // A long part that is not the last is set apart with a semicolon: where it ends would not be clear otherwise.
    expect(words('(hasChild some (Person and Student)) and (hasMember some (Person or Organization)) and Adult')).toBe(
      'an “Adult” that is related by “hasChild” to at least one “Person” that is a “Student”; and is related by “hasMember” to at least one thing that is either a “Person” or an “Organization”',
    );
    // An "or" of two "and"s: each begins with "both".
    expect(words('(Person and Adult) or (Organization and (hasMember some Person))')).toBe('something that either both is a “Person” and is an “Adult”; or both is an “Organization” and is related by “hasMember” to at least one “Person”');
  });
});

describe('an axiom in words', () => {
  it('is a sentence about its class, saying what kind of axiom it is', () => {
    const e = parseClass("Pizza and ('has topping' some MeatTopping)", n);
    expect(classAxiomInWords('SubClassOf', 'MeatyPizza', e, n)).toBe('Every “MeatyPizza” is a “Pizza” and is related by “has topping” to at least one “MeatTopping”.');
    expect(classAxiomInWords('EquivalentClasses', 'MeatyPizza', e, n)).toBe('Something is a “MeatyPizza” exactly when it is a “Pizza” and is related by “has topping” to at least one “MeatTopping”.');
    expect(classAxiomInWords('DisjointClasses', 'Organization', parseClass('Person', n), n)).toBe('No “Organization” is a “Person”.');
    // The README's example.
    expect(classAxiomInWords('EquivalentClasses', 'Parent', parseClass('Person and (hasChild some Student)', n), n)).toBe('Something is a “Parent” exactly when it is a “Person” and is related by “hasChild” to at least one “Student”.');
  });

  it('says what a domain and a range are of', () => {
    expect(domainInWords('hasChild', false, parseClass('Person', n), n)).toBe('Anything that is related by “hasChild” to something is a “Person”.');
    expect(domainInWords('hasAge', true, parseClass('Person or Organization', n), n)).toBe('Anything that has a “hasAge” value is either a “Person” or an “Organization”.');
    expect(rangeInWords('hasChild', { class: parseClass('Person', n) }, n)).toBe('Anything something is related to by “hasChild” is a “Person”.');
    expect(rangeInWords('hasAge', { data: parseDataRange('xsd:integer[>= 0]', n) }, n)).toBe('Every “hasAge” value is a whole number that is at least 0.');
  });
});
