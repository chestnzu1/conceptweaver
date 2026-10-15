import { OWL, RDF, RDFS, XSD, type ClassAxiomKind, type ClassExpression, type DataRange, type Literal, type ObjectPropertyExpression } from './expressions';
import type { EntityKind, Naming } from './manchester';
import { quoted } from './words';

/**
 * Class expressions and data ranges read out in words, for whoever does not read Manchester
 * syntax: "Pizza and (hasTopping some MeatTopping)" is "a “Pizza” that is related by “hasTopping”
 * to at least one “MeatTopping”". An axiom is a sentence: "Every “Margherita” is …",
 * "Something is a “MeatyPizza” exactly when it …", "No “Pizza” is …".
 *
 * The wording is the same for every property, whatever it is called: a property is a relation by
 * which one thing is related to another ("is related by “p” to"), and a data property has values
 * ("has a “p” value"). The quantifiers say what OWL means by them: "some" is at least one, "only"
 * allows none at all, a number counts different things. Where parts of an "and" or an "or" are
 * themselves long, they are set apart with semicolons, and a nested "or" begins with "either",
 * so that it is clear where each part ends. The Manchester syntax beside it stays the exact form.
 */

/** A name as it is said: the entity's own name where it has one, else its prefixed name or IRI, in quotes. */
function said(n: Naming, iri: string, kind: EntityKind): string {
  const written = n.name(iri, kind);
  const plain = written.startsWith("'") && written.endsWith("'") && written.length > 1 ? written.slice(1, -1).replace(/\\(.)/g, '$1') : written.replace(/^<(.*)>$/, '$1');
  return quoted(plain);
}

/** "a" or "an", by the first letter of the name it comes before. */
const article = (name: string) => (/^“?[aeiou]/i.test(name) ? 'an' : 'a');

/**
 * Items joined as a list: "a, b and c". With semicolons where an item before the last is long,
 * since a long item does not show where it ends; the last one ends with the list.
 */
function list(items: string[], word: 'and' | 'or', long: boolean): string {
  if (items.length < 2) return items[0] ?? '';
  const sep = long ? '; ' : ', ';
  return items.slice(0, -1).join(sep) + (long ? `; ${word} ` : ` ${word} `) + items[items.length - 1];
}

/**
 * Clauses as alternatives: "is either a “Person” or an “Organization”", "are members of either
 * “Cheese” or “Fruit”": the words they all begin with said once.
 */
function either(clauses: string[], long: boolean): string {
  const shared = /^(?:(?:is|are) (?:members of )?)/.exec(clauses[0] ?? '')?.[0] ?? '';
  const common = [shared, shared.replace(/members of $/, '')].find((w) => w && clauses.every((c) => c.startsWith(w))) ?? '';
  return common + 'either ' + list(clauses.map((c) => c.slice(common.length)), 'or', long);
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function literal(l: Literal, n: Naming): string {
  if (l.lang) return `${quoted(l.value)} (${l.lang})`;
  if (!l.datatype || l.datatype === XSD + 'string') return quoted(l.value);
  if ([XSD + 'integer', XSD + 'decimal', XSD + 'double', XSD + 'float', XSD + 'int', XSD + 'long', XSD + 'nonNegativeInteger', XSD + 'positiveInteger'].includes(l.datatype) && NUMBER.test(l.value)) return l.value;
  if (l.datatype === XSD + 'boolean' && /^(true|false)$/.test(l.value)) return l.value;
  return `${quoted(l.value)} (${n.name(l.datatype, 'datatype')})`;
}

const literals = (ls: Literal[], n: Naming) => list(ls.map((l) => literal(l, n)), 'or', false);

/** The datatypes said in words, one and many; the others by name. */
const DATATYPE_WORDS: Record<string, [string, string]> = {
  [XSD + 'string']: ['text', 'text'],
  [RDF + 'PlainLiteral']: ['text', 'text'],
  [RDF + 'langString']: ['text with a language', 'text with a language'],
  [XSD + 'integer']: ['a whole number', 'whole numbers'],
  [XSD + 'nonNegativeInteger']: ['a whole number not below 0', 'whole numbers not below 0'],
  [XSD + 'positiveInteger']: ['a whole number above 0', 'whole numbers above 0'],
  [XSD + 'negativeInteger']: ['a whole number below 0', 'whole numbers below 0'],
  [XSD + 'nonPositiveInteger']: ['a whole number not above 0', 'whole numbers not above 0'],
  [XSD + 'decimal']: ['a decimal number', 'decimal numbers'],
  [XSD + 'double']: ['a floating-point number', 'floating-point numbers'],
  [XSD + 'float']: ['a floating-point number', 'floating-point numbers'],
  [OWL + 'real']: ['a real number', 'real numbers'],
  [OWL + 'rational']: ['a rational number', 'rational numbers'],
  [XSD + 'boolean']: ['true or false', 'true or false'],
  [XSD + 'date']: ['a date', 'dates'],
  [XSD + 'dateTime']: ['a date and time', 'dates and times'],
  [XSD + 'dateTimeStamp']: ['a date and time with a time zone', 'dates and times with a time zone'],
  [XSD + 'time']: ['a time of day', 'times of day'],
  [XSD + 'gYear']: ['a year', 'years'],
  [XSD + 'gYearMonth']: ['a year and month', 'years and months'],
  [XSD + 'gMonth']: ['a month', 'months'],
  [XSD + 'gMonthDay']: ['a month and day', 'months and days'],
  [XSD + 'gDay']: ['a day of the month', 'days of the month'],
  [XSD + 'duration']: ['a duration', 'durations'],
  [XSD + 'anyURI']: ['a link (URI)', 'links (URIs)'],
  [RDFS + 'Literal']: ['a value', 'values'],
};

function datatypeWords(iri: string, n: Naming, many: boolean): string {
  const known = DATATYPE_WORDS[iri];
  if (known) return known[many ? 1 : 0];
  return `${many ? 'values' : 'a value'} of ${said(n, iri, 'datatype')}`;
}

/** What a facet asks of a value, as a clause: "is at least 18", "matches the pattern “[A-Z]+”". */
function facetClause(facet: string, value: Literal, n: Naming, many: boolean): string {
  const be = many ? 'are' : 'is';
  const v = literal(value, n);
  switch (facet) {
    case XSD + 'minInclusive':
      return `${be} at least ${v}`;
    case XSD + 'minExclusive':
      return `${be} more than ${v}`;
    case XSD + 'maxInclusive':
      return `${be} at most ${v}`;
    case XSD + 'maxExclusive':
      return `${be} less than ${v}`;
    case XSD + 'length':
      return `${be} ${value.value} characters long`;
    case XSD + 'minLength':
      return `${be} at least ${value.value} characters long`;
    case XSD + 'maxLength':
      return `${be} at most ${value.value} characters long`;
    case XSD + 'pattern':
      return `${many ? 'match' : 'matches'} the pattern ${quoted(value.value)}`;
    case RDF + 'langRange':
      return `${many ? 'have' : 'has'} a language tag matching ${quoted(value.value)}`;
    default:
      return `${many ? 'have' : 'has'} the facet ${said(n, facet, 'datatype')} ${v}`;
  }
}

/** What a value in a data range is, as a clause about it (or about them): "is a whole number that is at least 18". */
export function dataClause(r: DataRange, n: Naming, many = false): string {
  const be = many ? 'are' : 'is';
  switch (r.type) {
    case 'Datatype':
      return `${be} ${datatypeWords(r.iri, n, many)}`;
    case 'Enumeration':
      return `${be} one of the values of ${quoted(n.enumName(r.datatype).replace(/^'(.*)'$/, '$1'))}`;
    case 'DataUnionOf':
      return either(r.operands.map((x) => dataClause(x, n, many)), r.operands.slice(0, -1).some(longData));
    case 'DataIntersectionOf':
      return list(r.operands.map((x) => dataClause(x, n, many)), 'and', r.operands.slice(0, -1).some(longData));
    case 'DataComplementOf':
      return r.operand.type === 'Datatype' ? `${be} not ${datatypeWords(r.operand.iri, n, many)}` : `${be} not ${many ? 'values' : 'a value'} that ${dataClause(r.operand, n, many)}`;
    case 'DataOneOf':
      return r.literals.length === 1 ? `${be} ${literal(r.literals[0], n)}` : `${be} ${many ? 'each ' : ''}one of ${literals(r.literals, n)}`;
    case 'DatatypeRestriction':
      return `${be} ${datatypeWords(r.datatype, n, many)} that ${list(r.facets.map((f) => facetClause(f.facet, f.value, n, many)), 'and', false)}`;
    case 'Unparsed':
      return `${be} as the file says, in a form kept as it was read`;
  }
}

/** Whether a data range takes a clause of its own to say: then it is set apart in a list. */
const longData = (r: DataRange) => r.type !== 'Datatype' && r.type !== 'Enumeration' && !(r.type === 'DataOneOf' && r.literals.length === 1);

const THING = OWL + 'Thing';
const NOTHING = OWL + 'Nothing';

const property = (p: ObjectPropertyExpression, n: Naming) => (p.type === 'ObjectInverseOf' ? `the inverse of ${said(n, p.property.iri, 'object')}` : said(n, p.iri, 'object'));

/** Whether a class expression takes clauses of its own to say: then it is set apart where it is part of a list. */
function long(e: ClassExpression): boolean {
  switch (e.type) {
    case 'ObjectIntersectionOf':
    case 'ObjectUnionOf':
      return true;
    case 'ObjectComplementOf':
      return long(e.operand) || !['Class', 'ObjectSomeValuesFrom', 'ObjectAllValuesFrom', 'ObjectHasValue', 'ObjectOneOf', 'ObjectMinCardinality', 'ObjectMaxCardinality', 'DataSomeValuesFrom', 'DataAllValuesFrom', 'DataMinCardinality', 'DataMaxCardinality'].includes(e.operand.type);
    case 'ObjectSomeValuesFrom':
    case 'ObjectAllValuesFrom':
      return e.filler.type !== 'Class';
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality':
      return !!e.filler && e.filler.type !== 'Class';
    case 'DataSomeValuesFrom':
    case 'DataAllValuesFrom':
      return longData(e.filler);
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality':
      return !!e.filler;
    default:
      return false;
  }
}

/**
 * An intersection that names a class, said with that class first: "a “Pizza” that …" rather than
 * "something that is a “Pizza” and …". The class it is headed by, and the rest.
 */
function headed(e: ClassExpression): { head: string; rest: ClassExpression | undefined } | undefined {
  if (e.type === 'Class' && e.iri !== THING && e.iri !== NOTHING) return { head: e.iri, rest: undefined };
  if (e.type !== 'ObjectIntersectionOf') return undefined;
  const at = e.operands.findIndex((x) => x.type === 'Class' && x.iri !== THING && x.iri !== NOTHING);
  if (at < 0) return undefined;
  const rest = e.operands.filter((_, i) => i !== at);
  return { head: (e.operands[at] as { iri: string }).iri, rest: rest.length === 1 ? rest[0] : { type: 'ObjectIntersectionOf', operands: rest } };
}

/** One thing of a kind, after "at least one", "exactly one": "“Student”", "thing that is …", "“Pizza” that …". */
function one(e: ClassExpression, n: Naming): string {
  if (e.type === 'Class' && e.iri === THING) return 'thing';
  const h = headed(e);
  if (h) return said(n, h.head, 'class') + (h.rest ? ` that ${clause(h.rest, n)}` : '');
  return `thing that ${clause(e, n)}`;
}

/** Many things of a kind: "members of “Student”", "things that are …". */
function many(e: ClassExpression, n: Naming): string {
  if (e.type === 'Class' && e.iri === THING) return 'things';
  const h = headed(e);
  if (h) return `members of ${said(n, h.head, 'class')}` + (h.rest ? ` that ${clause(h.rest, n, true)}` : '');
  const c = clause(e, n, true);
  // Classes as alternatives: "members of either “A” or “B”".
  return c.startsWith('are members of ') ? c.slice('are '.length) : `things that ${c}`;
}

/** So many things of a kind: "one “Student”", "2 members of “Student”", "3 things". */
function count(k: number, e: ClassExpression | undefined, n: Naming): string {
  if (!e) return k === 1 ? 'one thing' : `${k} things`;
  return k === 1 ? `one ${one(e, n)}` : `${k} ${many(e, n)}`;
}

/**
 * What a class expression says of a thing (or of things, `plural`), as the clause that follows
 * "something that": "is a “Pizza” and is related by “hasTopping” to at least one “MeatTopping”".
 */
export function clause(e: ClassExpression, n: Naming, plural = false): string {
  const be = plural ? 'are' : 'is';
  const have = plural ? 'have' : 'has';
  const related = `${be} related by`;
  switch (e.type) {
    case 'Class': {
      if (e.iri === THING) return `${be} anything at all`;
      if (e.iri === NOTHING) return `${be} in “owl:Nothing”, which nothing is`;
      const c = said(n, e.iri, 'class');
      return plural ? `are members of ${c}` : `is ${article(c)} ${c}`;
    }
    case 'ObjectIntersectionOf': {
      // A named class first, as it is said most naturally; long parts after the short, and an "or" last, where "either" opens it.
      const ops = [...e.operands].sort((a, b) => rank(a) - rank(b));
      return list(ops.map((x) => clause(x, n, plural)), 'and', ops.slice(0, -1).some(long));
    }
    case 'ObjectUnionOf': {
      const parts = e.operands.map((x) => (x.type === 'ObjectIntersectionOf' && x.operands.length === 2 ? 'both ' + clause(x, n, plural) : clause(x, n, plural)));
      return either(parts, e.operands.slice(0, -1).some(long));
    }
    case 'ObjectComplementOf':
      return negated(e.operand, n, plural) ?? `${be} not ${plural ? 'things' : 'something'} that ${clause(e.operand, n, plural)}`;
    case 'ObjectOneOf': {
      const names = e.individuals.map((i) => said(n, i.iri, 'individual'));
      return names.length === 1 ? `${be} ${names[0]}` : `${be} ${plural ? 'each ' : ''}one of ${list(names, 'or', false)}`;
    }
    case 'ObjectSomeValuesFrom':
      return `${related} ${property(e.property, n)} to at least one ${one(e.filler, n)}`;
    case 'ObjectAllValuesFrom':
      return `${related} ${property(e.property, n)} only to ${many(e.filler, n)} (or to nothing)`;
    case 'ObjectHasValue':
      return `${related} ${property(e.property, n)} to ${said(n, e.individual.iri, 'individual')}`;
    case 'ObjectHasSelf':
      return `${related} ${property(e.property, n)} to ${plural ? 'themselves' : 'itself'}`;
    case 'ObjectMinCardinality':
      return `${related} ${property(e.property, n)} to at least ${count(e.n, e.filler, n)}`;
    case 'ObjectMaxCardinality':
      return e.n === 0
        ? `${be} not related by ${property(e.property, n)} to ${e.filler && !(e.filler.type === 'Class' && e.filler.iri === THING) ? 'any ' + one(e.filler, n) : 'anything'}`
        : `${related} ${property(e.property, n)} to at most ${count(e.n, e.filler, n)}`;
    case 'ObjectExactCardinality':
      if (e.n === 0) return clause({ ...e, type: 'ObjectMaxCardinality' }, n, plural);
      return `${related} ${property(e.property, n)} to exactly ${count(e.n, e.filler, n)}`;
    case 'DataSomeValuesFrom': {
      const p = said(n, e.property.iri, 'data');
      return e.filler.type === 'Datatype' && e.filler.iri === RDFS + 'Literal' ? `${have} at least one ${p} value` : `${have} at least one ${p} value that ${dataClause(e.filler, n)}`;
    }
    case 'DataAllValuesFrom':
      return `${have} only ${said(n, e.property.iri, 'data')} values that ${dataClause(e.filler, n, true)} (or none)`;
    case 'DataHasValue':
      return `${have} the ${said(n, e.property.iri, 'data')} value ${literal(e.value, n)}`;
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality': {
      const p = said(n, e.property.iri, 'data');
      const how = e.type === 'DataMinCardinality' ? 'at least' : e.type === 'DataMaxCardinality' ? 'at most' : 'exactly';
      if (e.type !== 'DataMinCardinality' && e.n === 0) return `${have} no ${p} value${e.filler ? ` that ${dataClause(e.filler, n)}` : ''}`;
      const values = e.n === 1 ? `one ${p} value` : `${e.n} ${p} values`;
      return `${have} ${how} ${values}${e.filler ? ` that ${dataClause(e.filler, n, e.n !== 1)}` : ''}`;
    }
    case 'Unparsed':
      return `${be} as the file says, in a form kept as it was read`;
  }
}

/**
 * What is not so, said directly where English has a way to: "is not a “Student”", "is not
 * related by “p” to any “MeatTopping”" (not some), "has no “p” value". Nothing for the rest.
 */
function negated(x: ClassExpression, n: Naming, plural: boolean): string | undefined {
  const be = plural ? 'are' : 'is';
  switch (x.type) {
    case 'Class': {
      if (x.iri === THING || x.iri === NOTHING) return undefined;
      const c = said(n, x.iri, 'class');
      return plural ? `are not members of ${c}` : `is not ${article(c)} ${c}`;
    }
    case 'ObjectSomeValuesFrom':
      return clause({ type: 'ObjectMaxCardinality', n: 0, property: x.property, filler: x.filler }, n, plural);
    case 'ObjectHasValue':
      return `${be} not related by ${property(x.property, n)} to ${said(n, x.individual.iri, 'individual')}`;
    case 'ObjectOneOf':
      return `${be} not ${x.individuals.length === 1 ? '' : 'one of '}${list(x.individuals.map((i) => said(n, i.iri, 'individual')), 'or', false)}`;
    case 'DataSomeValuesFrom':
      return clause({ type: 'DataMaxCardinality', n: 0, property: x.property, filler: x.filler.type === 'Datatype' && x.filler.iri === RDFS + 'Literal' ? undefined : x.filler }, n, plural);
    // What OWL takes them to mean, said the way round that reads: not only C is some that is not C, not at least n is at most n − 1.
    case 'ObjectAllValuesFrom':
      return clause({ type: 'ObjectSomeValuesFrom', property: x.property, filler: { type: 'ObjectComplementOf', operand: x.filler } }, n, plural);
    case 'DataAllValuesFrom':
      return clause({ type: 'DataSomeValuesFrom', property: x.property, filler: { type: 'DataComplementOf', operand: x.filler } }, n, plural);
    case 'ObjectMinCardinality':
      return x.n > 0 ? clause({ ...x, type: 'ObjectMaxCardinality', n: x.n - 1 }, n, plural) : undefined;
    case 'ObjectMaxCardinality':
      return clause({ ...x, type: 'ObjectMinCardinality', n: x.n + 1 }, n, plural);
    case 'DataMinCardinality':
      return x.n > 0 ? clause({ ...x, type: 'DataMaxCardinality', n: x.n - 1 }, n, plural) : undefined;
    case 'DataMaxCardinality':
      return clause({ ...x, type: 'DataMinCardinality', n: x.n + 1 }, n, plural);
    default:
      return undefined;
  }
}

/** The order the parts of an "and" are said in: classes, then short parts, long ones, and an "or" last. */
const rank = (e: ClassExpression) => (e.type === 'Class' ? 0 : e.type === 'ObjectUnionOf' ? 3 : long(e) ? 2 : 1);

/** A class expression as a phrase: "a “Pizza” that …", "something that …", "anything". */
export function classInWords(e: ClassExpression, n: Naming): string {
  if (e.type === 'Class' && e.iri === THING) return 'anything';
  if (e.type === 'Class' && e.iri === NOTHING) return 'nothing';
  const h = headed(e);
  if (h) {
    const c = said(n, h.head, 'class');
    return `${article(c)} ${c}` + (h.rest ? ` that ${clause(h.rest, n)}` : '');
  }
  return `something that ${clause(e, n)}`;
}

/** A data range as a phrase: "a whole number that is at least 18", "a value that is either …". */
export function dataRangeInWords(r: DataRange, n: Naming): string {
  if (r.type === 'Datatype') return datatypeWords(r.iri, n, false);
  if (r.type === 'DatatypeRestriction') return `${datatypeWords(r.datatype, n, false)} that ${list(r.facets.map((f) => facetClause(f.facet, f.value, n, false)), 'and', false)}`;
  return `a value that ${dataClause(r, n)}`;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1) + '.';

/** A class axiom as a sentence about its class: "Every “Margherita” is …", "No “Pizza” is …". */
export function classAxiomInWords(kind: ClassAxiomKind, className: string, e: ClassExpression, n: Naming): string {
  const c = quoted(className || 'Unnamed');
  switch (kind) {
    case 'SubClassOf':
      return sentence(`every ${c} ${clause(e, n)}`);
    case 'EquivalentClasses':
      return sentence(`something is ${article(c)} ${c} exactly when it ${clause(e, n)}`);
    case 'DisjointClasses':
      return sentence(`no ${c} ${clause(e, n)}`);
  }
}

/** A domain axiom as a sentence: "Anything that is related by “p” to something is a “Person”". */
export function domainInWords(propertyName: string, data: boolean, e: ClassExpression, n: Naming): string {
  const p = quoted(propertyName || 'Unnamed');
  return sentence(`${data ? `anything that has a ${p} value` : `anything that is related by ${p} to something`} ${clause(e, n)}`);
}

/** A range axiom as a sentence: "Anything something is related to by “p” is a “Topping”", "Every “age” value is a whole number". */
export function rangeInWords(propertyName: string, range: { class: ClassExpression } | { data: DataRange }, n: Naming): string {
  const p = quoted(propertyName || 'Unnamed');
  return 'class' in range ? sentence(`anything something is related to by ${p} ${clause(range.class, n)}`) : sentence(`every ${p} value ${dataClause(range.data, n)}`);
}
