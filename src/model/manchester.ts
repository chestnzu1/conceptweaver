import { individual, namedProperty, objectProperty, dataProperty, OWL, RDF, RDFS, XSD, type ClassExpression, type DataRange, type Literal, type ObjectPropertyExpression } from './expressions';
import { compactIri, expandIri } from './prefixes';
import type { Model } from './types';

/**
 * Class expressions and data ranges as text, in the Manchester OWL syntax that Protégé shows them
 * in: "Person or Organisation", "Agent and not Person", "hasPart some Wheel",
 * "inverse hasMember some Organisation", "xsd:integer[>= 0]". Entities are written by their names
 * (quoted where a name has a space: 'took part in'), and otherwise by prefixed name or IRI.
 * Reading the text back gives the same expression (src/model/expressions.ts).
 *
 * What is read is the grammar of the W3C Manchester syntax for descriptions (class expressions)
 * and data ranges (https://www.w3.org/TR/owl2-manchester-syntax/, sections 2.4 and 2.5): and,
 * or, not, that, some, only, value, Self, min, max, exactly, inverse, one-of lists, datatype
 * restrictions with facets, literals. Not frames (Class:, SubClassOf:…), annotations or
 * property chains: those are not expressions. Conformance is checked against the OWL API's own
 * Manchester parser (manchesterConformance.test.ts).
 */

export type EntityKind = 'class' | 'object' | 'data' | 'individual' | 'datatype';

/** How entities are named and found, for printing, parsing and completing. */
export interface Naming {
  /** What to write for an entity: its name, or a prefixed name or <IRI>. */
  name(iri: string, kind: EntityKind): string;
  /** What to write for an enumerated datatype of the model. */
  enumName(id: string): string;
  /** The entities a name stands for (a name as written, without quotes). */
  find(name: string): { iri: string; kind: EntityKind }[];
  /** The enumerated datatype a name stands for, by id. */
  findEnum(name: string): string | undefined;
  /** The IRI a prefixed name stands for. */
  expand(curie: string): string | undefined;
  /** Every entity of a kind, each as it is written: for completing a name. */
  entities(kind: EntityKind): { text: string; iri: string }[];
  /** Every enumerated datatype, as it is written. */
  enums(): { text: string; id: string }[];
  /** What the model has an IRI as: nothing for one it does not know. */
  kindsOf(iri: string): EntityKind[];
}

const KEYWORDS = new Set(['and', 'or', 'not', 'some', 'only', 'value', 'Self', 'min', 'max', 'exactly', 'that', 'inverse', 'true', 'false', 'length', 'minLength', 'maxLength', 'pattern', 'langRange']);
const BARE = /^[\p{L}_][\p{L}\p{N}_\-.]*$/u;
const CURIE = /^[A-Za-z][\w-]*:[\p{L}\p{N}_][\p{L}\p{N}_\-.]*$/u;

/** A name as it is written: bare where it can be, quoted where it has spaces or is a keyword. */
export const quoted = (name: string) => (BARE.test(name) && !KEYWORDS.has(name) && !name.endsWith('.') ? name : `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

/** The standard datatypes offered by name, and the ones of OWL and RDF. */
const STANDARD_DATATYPES: Record<string, string> = Object.fromEntries([
  ...['string', 'boolean', 'decimal', 'integer', 'double', 'float', 'date', 'dateTime', 'dateTimeStamp', 'time', 'gYear', 'gYearMonth', 'gMonth', 'gMonthDay', 'gDay', 'duration', 'anyURI', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger', 'nonPositiveInteger', 'long', 'int', 'short', 'byte', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte', 'normalizedString', 'token', 'language', 'Name', 'NCName', 'NMTOKEN', 'hexBinary', 'base64Binary'].map((x) => ['xsd:' + x, XSD + x]),
  ['rdfs:Literal', RDFS + 'Literal'],
  ['rdf:langString', RDF + 'langString'],
  ['rdf:PlainLiteral', RDF + 'PlainLiteral'],
  ['owl:real', OWL + 'real'],
  ['owl:rational', OWL + 'rational'],
]);
const STANDARD_CLASSES: Record<string, string> = { 'owl:Thing': OWL + 'Thing', 'owl:Nothing': OWL + 'Nothing', Thing: OWL + 'Thing', Nothing: OWL + 'Nothing' };

/** The names of a model's entities. A name that two entities of one kind share, or none has, is written as its prefixed name or IRI. */
export function namingFor(m: Model): Naming {
  const entries: { name: string; iri: string; kind: EntityKind }[] = [];
  for (const t of m.terms) if (t.iri) entries.push({ name: t.name, iri: t.iri, kind: t.type === 'concept' ? 'class' : t.type === 'property' ? 'data' : 'individual' });
  for (const p of m.props) if (p.iri) entries.push({ name: p.name, iri: p.iri, kind: 'object' });
  for (const d of m.datatypes) if (d.iri && !d.anonymous) entries.push({ name: d.name, iri: d.iri, kind: 'datatype' });
  const byName = new Map<string, typeof entries>();
  for (const e of entries) {
    const k = e.name.trim();
    if (k) byName.set(k, [...(byName.get(k) ?? []), e]);
  }
  const byIri = new Map(entries.map((e) => [e.iri + '|' + e.kind, e]));
  const short = (iri: string) => {
    const c = compactIri(m, iri);
    return c && CURIE.test(c) ? c : c?.startsWith(':') && BARE.test(c.slice(1)) ? c : `<${iri}>`;
  };
  // Where a name is read, it is looked for among the entities that can stand there: classes,
  // properties (object or data), individuals or datatypes. Within those it has to be one entity's.
  const group = (kind: EntityKind) => (kind === 'data' ? 'object' : kind);
  const name = (iri: string, kind: EntityKind) => {
    const e = byIri.get(iri + '|' + kind) ?? entries.find((x) => x.iri === iri);
    const n = e?.name.trim();
    if (e && n && byName.get(n)!.filter((x) => group(x.kind) === group(e.kind)).length === 1) return quoted(n);
    return short(iri);
  };
  return {
    name,
    enumName: (id) => {
      const d = m.datatypes.find((x) => x.id === id);
      return d ? quoted(d.name.trim() || 'Datatype') : `'${id}'`;
    },
    find: (n) => byName.get(n.trim()) ?? [...byName].filter(([k]) => k.toLowerCase() === n.trim().toLowerCase()).flatMap(([, v]) => v),
    findEnum: (n) => {
      const exact = m.datatypes.filter((d) => d.name.trim() === n.trim());
      const loose = exact.length ? exact : m.datatypes.filter((d) => d.name.trim().toLowerCase() === n.trim().toLowerCase());
      return loose.length === 1 ? loose[0].id : undefined;
    },
    expand: (curie) => expandIri(m, curie),
    entities: (kind) => [
      ...entries.filter((e) => e.kind === kind).map((e) => ({ text: name(e.iri, kind), iri: e.iri })),
      ...(kind === 'class' ? [{ text: 'owl:Thing', iri: OWL + 'Thing' }, { text: 'owl:Nothing', iri: OWL + 'Nothing' }] : []),
      ...(kind === 'datatype' ? Object.entries(STANDARD_DATATYPES).map(([text, iri]) => ({ text, iri })) : []),
    ],
    enums: () => m.datatypes.map((d) => ({ text: quoted(d.name.trim() || 'Datatype'), id: d.id })),
    kindsOf: (iri) => entries.filter((e) => e.iri === iri).map((e) => e.kind),
  };
}

// ---------------------------------------------------------------- printing

/** Several axioms as one text: all of them hold, so they are joined by "and", any union in brackets. */
export const allOf = (texts: string[]): string => (texts.length > 1 ? texts.map((t) => (/ or /.test(t) ? `(${t})` : t)).join(' and ') : (texts[0] ?? ''));

const FACET_SYMBOL: Record<string, string> = { [XSD + 'minInclusive']: '>=', [XSD + 'minExclusive']: '>', [XSD + 'maxInclusive']: '<=', [XSD + 'maxExclusive']: '<', [XSD + 'length']: 'length', [XSD + 'minLength']: 'minLength', [XSD + 'maxLength']: 'maxLength', [XSD + 'pattern']: 'pattern', [RDF + 'langRange']: 'langRange' };
const SYMBOL_FACET = Object.fromEntries(Object.entries(FACET_SYMBOL).map(([k, v]) => [v, k]));
/** The facets, as they are written. */
export const FACETS = Object.keys(SYMBOL_FACET);
/** A facet's IRI from how it is written, and the other way round. */
export const facetIri = (written: string): string | undefined => SYMBOL_FACET[written];
export const facetText = (iri: string): string => FACET_SYMBOL[iri] ?? iri;

export function literalText(l: Literal, n: Naming): string {
  if (l.lang) return JSON.stringify(l.value) + '@' + l.lang;
  if (!l.datatype) return JSON.stringify(l.value);
  if (l.datatype === XSD + 'integer' && /^[-+]?\d+$/.test(l.value)) return l.value;
  if (l.datatype === XSD + 'decimal' && /^[-+]?\d*\.\d+$/.test(l.value)) return l.value;
  if (l.datatype === XSD + 'boolean' && /^(true|false)$/.test(l.value)) return l.value;
  return `${JSON.stringify(l.value)}^^${n.name(l.datatype, 'datatype')}`;
}

/** Whether an expression holds anything kept as it was read: such an expression is shown, not edited. */
export const hasUnparsed = (e: ClassExpression | DataRange): boolean => JSON.stringify(e).includes('"type":"Unparsed"');

const objectText = (p: ObjectPropertyExpression, n: Naming) => (p.type === 'ObjectInverseOf' ? `inverse ${n.name(p.property.iri, 'object')}` : n.name(p.iri, 'object'));
const nary = (x: { type: string }) => x.type === 'ObjectUnionOf' || x.type === 'ObjectIntersectionOf' || x.type === 'DataUnionOf' || x.type === 'DataIntersectionOf';
/** A restriction, which is written in brackets where it is an operand or a filler, as Protégé writes it. */
const restricts = (x: { type: string }) => /^(Object|Data)(Some|All|Has|Min|Max|Exact)/.test(x.type);
const grouped = (x: { type: string }) => nary(x) || restricts(x);

/** A class expression as Manchester syntax, on one line. */
export function classText(e: ClassExpression, n: Naming): string {
  const inner = (x: ClassExpression) => (grouped(x) ? `(${classText(x, n)})` : classText(x, n));
  // A filler is bracketed when it is a complement too: hasChild exactly 2 (not Student).
  const filler = (x: ClassExpression) => (grouped(x) || x.type === 'ObjectComplementOf' ? `(${classText(x, n)})` : classText(x, n));
  const dataInner = (x: DataRange) => (nary(x) ? `(${dataText(x, n)})` : dataText(x, n));
  switch (e.type) {
    case 'Class':
      return e.iri === OWL + 'Thing' ? 'owl:Thing' : e.iri === OWL + 'Nothing' ? 'owl:Nothing' : n.name(e.iri, 'class');
    case 'ObjectUnionOf':
      return e.operands.map(inner).join(' or ');
    case 'ObjectIntersectionOf':
      return e.operands.map(inner).join(' and ');
    case 'ObjectComplementOf':
      return `not ${inner(e.operand)}`;
    case 'ObjectOneOf':
      return `{${e.individuals.map((i) => n.name(i.iri, 'individual')).join(', ')}}`;
    case 'ObjectSomeValuesFrom':
      return `${objectText(e.property, n)} some ${filler(e.filler)}`;
    case 'ObjectAllValuesFrom':
      return `${objectText(e.property, n)} only ${filler(e.filler)}`;
    case 'ObjectHasValue':
      return `${objectText(e.property, n)} value ${n.name(e.individual.iri, 'individual')}`;
    case 'ObjectHasSelf':
      return `${objectText(e.property, n)} Self`;
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality':
      return `${objectText(e.property, n)} ${e.type === 'ObjectMinCardinality' ? 'min' : e.type === 'ObjectMaxCardinality' ? 'max' : 'exactly'} ${e.n}${e.filler ? ' ' + filler(e.filler) : ''}`;
    case 'DataSomeValuesFrom':
      return `${n.name(e.property.iri, 'data')} some ${dataInner(e.filler)}`;
    case 'DataAllValuesFrom':
      return `${n.name(e.property.iri, 'data')} only ${dataInner(e.filler)}`;
    case 'DataHasValue':
      return `${n.name(e.property.iri, 'data')} value ${literalText(e.value, n)}`;
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality':
      return `${n.name(e.property.iri, 'data')} ${e.type === 'DataMinCardinality' ? 'min' : e.type === 'DataMaxCardinality' ? 'max' : 'exactly'} ${e.n}${e.filler ? ' ' + dataInner(e.filler) : ''}`;
    case 'Unparsed':
      return `[kept as read: ${e.turtle}]`;
  }
}

/** A data range as Manchester syntax, on one line. */
export function dataText(r: DataRange, n: Naming): string {
  const inner = (x: DataRange) => (nary(x) ? `(${dataText(x, n)})` : dataText(x, n));
  switch (r.type) {
    case 'Datatype':
      return n.name(r.iri, 'datatype');
    case 'Enumeration':
      return n.enumName(r.datatype);
    case 'DataUnionOf':
      return r.operands.map(inner).join(' or ');
    case 'DataIntersectionOf':
      return r.operands.map(inner).join(' and ');
    case 'DataComplementOf':
      return `not ${inner(r.operand)}`;
    case 'DataOneOf':
      return `{${r.literals.map((l) => literalText(l, n)).join(', ')}}`;
    case 'DatatypeRestriction':
      return `${n.name(r.datatype, 'datatype')}[${r.facets.map((f) => `${FACET_SYMBOL[f.facet] ?? n.name(f.facet, 'datatype')} ${literalText(f.value, n)}`).join(', ')}]`;
    case 'Unparsed':
      return `[kept as read: ${r.turtle}]`;
  }
}

const INDENT = '    ';

/**
 * A class expression as Manchester syntax laid out over lines: what fits in `width` stays on one
 * line; a longer intersection or union has one operand to a line, each after "and" or "or"; a
 * longer restriction has its filler on the next line, indented. It reads back as the same
 * expression as `classText`.
 */
export function formatClass(e: ClassExpression, n: Naming, width = 72, indent = ''): string {
  const flat = classText(e, n);
  if (indent.length + flat.length <= width) return flat;
  const deeper = indent + INDENT;
  // A group in brackets is laid out one column in, under its opening bracket.
  const inner = (x: ClassExpression, at: string) => (grouped(x) ? `(${formatClass(x, n, width, at + ' ')})` : formatClass(x, n, width, at));
  const filler = (x: ClassExpression, at: string) => (grouped(x) || x.type === 'ObjectComplementOf' ? `(${formatClass(x, n, width, at + ' ')})` : formatClass(x, n, width, at));
  switch (e.type) {
    case 'ObjectUnionOf':
    case 'ObjectIntersectionOf': {
      const word = e.type === 'ObjectUnionOf' ? 'or' : 'and';
      return e.operands.map((x, i) => (i === 0 ? inner(x, indent) : `\n${indent}${word} ${inner(x, indent + ' '.repeat(word.length + 1))}`)).join('');
    }
    case 'ObjectComplementOf':
      return `not ${inner(e.operand, indent + '    ')}`;
    case 'ObjectSomeValuesFrom':
    case 'ObjectAllValuesFrom':
      return `${objectText(e.property, n)} ${e.type === 'ObjectSomeValuesFrom' ? 'some' : 'only'}\n${deeper}${filler(e.filler, deeper)}`;
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality':
      return e.filler ? `${objectText(e.property, n)} ${e.type === 'ObjectMinCardinality' ? 'min' : e.type === 'ObjectMaxCardinality' ? 'max' : 'exactly'} ${e.n}\n${deeper}${filler(e.filler, deeper)}` : flat;
    default:
      return flat;
  }
}

// ---------------------------------------------------------------- reading

/** What can stand at a place in the text: for completing it. */
export type Expected = EntityKind | 'enum' | 'keyword:class' | 'keyword:restriction' | 'keyword:data-restriction' | 'keyword:connective' | 'facet' | 'literal';

/** What is wrong with a text, where (an offset into it), and, at the end of it, what could come next. */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly at: number,
    readonly expected: Expected[] = [],
  ) {
    super(message);
  }
}

/** A piece of the text, with what it is: for highlighting it. */
export interface Token {
  from: number;
  to: number;
  kind: 'keyword' | 'name' | 'iri' | 'string' | 'number' | 'punct' | 'end';
  /** The text, without quotes for a quoted name or a literal. */
  text: string;
  lang?: string;
  dt?: string;
}

/** The text as tokens. Throws a ParseError where it cannot be split into any. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if ('(){}[],'.includes(c)) {
      out.push({ from: at, to: at + 1, kind: 'punct', text: c });
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      const iri = c === '<' ? /^<([^<>\s"{}|\\^`]*)>/.exec(text.slice(i)) : null;
      if (iri && iri[1].includes(':')) {
        out.push({ from: at, to: at + iri[0].length, kind: 'iri', text: iri[1] });
        i += iri[0].length;
        continue;
      }
      const op = text[i + 1] === '=' ? c + '=' : c;
      out.push({ from: at, to: at + op.length, kind: 'punct', text: op });
      i += op.length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < text.length && text[j] !== c; j++) {
        if (text[j] === '\\' && j + 1 < text.length) j++;
        v += text[j];
      }
      if (j >= text.length) throw new ParseError(`The ${c === '"' ? 'text' : 'name'} that starts here has no closing ${c}.`, at);
      i = j + 1;
      if (c === "'") {
        out.push({ from: at, to: i, kind: 'name', text: v });
        continue;
      }
      const tok: Token = { from: at, to: i, kind: 'string', text: v };
      const lang = /^@([A-Za-z]+(-[A-Za-z0-9]+)*)/.exec(text.slice(i));
      if (lang) {
        tok.lang = lang[1].toLowerCase();
        i += lang[0].length;
      } else if (text.startsWith('^^', i)) {
        const rest = /^\^\^(<[^<>\s]*>|[^\s,()[\]{}]+)/.exec(text.slice(i));
        if (!rest) throw new ParseError('A datatype is missing after ^^.', i);
        tok.dt = rest[1];
        i += rest[0].length;
      }
      tok.to = i;
      out.push(tok);
      continue;
    }
    const num = /^[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)[fF]?(?![\p{L}_:])/u.exec(text.slice(i));
    if (num && (c !== '-' && c !== '+' ? true : /\d|\./.test(text[i + 1] ?? ''))) {
      out.push({ from: at, to: at + num[0].length, kind: 'number', text: num[0] });
      i += num[0].length;
      continue;
    }
    const word = /^[\p{L}\p{N}_:\-.]+/u.exec(text.slice(i));
    if (c === '?') throw new ParseError('Something is still to be chosen here (?): write it in its place.', at);
    if (!word) throw new ParseError(`“${c}” cannot be part of an expression.`, at);
    // A full stop ends a name only where nothing follows it.
    const w = word[0].replace(/\.+$/, '') || word[0];
    out.push({ from: at, to: at + w.length, kind: KEYWORDS.has(w) ? 'keyword' : 'name', text: w });
    i += w.length;
  }
  out.push({ from: text.length, to: text.length, kind: 'end', text: '' });
  return out;
}

const numberLiteral = (v: string): Literal => {
  if (/[fF]$/.test(v)) return { value: v.slice(0, -1), datatype: XSD + 'float' };
  if (/[eE]/.test(v)) return { value: v, datatype: XSD + 'double' };
  if (v.includes('.')) return { value: v, datatype: XSD + 'decimal' };
  return { value: v, datatype: XSD + 'integer' };
};

const RESTRICTION_WORDS = ['some', 'only', 'value', 'Self', 'min', 'max', 'exactly'];
const STARTS_CLASS: Expected[] = ['class', 'object', 'data', 'keyword:class'];
const STARTS_DATA: Expected[] = ['datatype', 'enum', 'keyword:class'];
const KIND_WORD: Record<EntityKind, string> = { class: 'a class', object: 'an object property', data: 'a data property', individual: 'an individual', datatype: 'a datatype' };

/** What a name read at a place turned out to be, for highlighting it. */
export interface Resolved {
  from: number;
  to: number;
  kind: EntityKind | 'enum' | 'unknown';
}

class Reader {
  private i = 0;
  /** The names read, with what each is. */
  readonly resolved: Resolved[] = [];
  constructor(
    private toks: Token[],
    private n: Naming,
  ) {}
  private get peek() {
    return this.toks[this.i];
  }
  private next() {
    return this.toks[this.i++];
  }
  private is(v: string) {
    const p = this.peek;
    return (p.kind === 'keyword' || p.kind === 'punct') && p.text === v;
  }
  private fail(message: string, tok: Token, expected: Expected[] = []): never {
    throw new ParseError(message, tok.from, tok.kind === 'end' ? expected : []);
  }
  private expect(v: string, what: string, expected: Expected[] = []) {
    if (!this.is(v)) this.fail(this.peek.kind === 'end' ? `${what[0].toUpperCase() + what.slice(1)} is missing at the end.` : `Expected ${what} here, not “${this.peek.text}”.`, this.peek, expected);
    this.i++;
  }
  done() {
    if (this.peek.kind !== 'end') this.fail(`Nothing more was expected here: “${this.peek.text}”. Join two expressions with “and” or “or”.`, this.peek);
  }

  /** The entity a name stands for, of one of the kinds asked for. */
  private entity(tok: Token, kinds: EntityKind[]): { iri: string; kind: EntityKind } | undefined {
    let found: { iri: string; kind: EntityKind } | undefined;
    // An IRI is what the model has it as, where that is one of the kinds wanted; one it does not know is taken to be what is wanted.
    if (tok.kind === 'iri') found = { iri: tok.text, kind: this.n.kindsOf(tok.text).find((k) => kinds.includes(k)) ?? kinds[0] };
    else if (tok.kind === 'name') {
      const all = this.n.find(tok.text).filter((e) => kinds.includes(e.kind));
      if (all.length > 1) {
        // Two of one kind, or an object and a data property: which is meant cannot be told from the name.
        const what = all.every((e) => e.kind === all[0].kind) ? `More than one ${KIND_WORD[all[0].kind].replace(/^an? /, '')} is` : `${[...new Set(all.map((e) => KIND_WORD[e.kind]))].join(' and ').replace(/^a/, 'A')} are both`;
        this.fail(`${what} called “${tok.text}”: write its prefixed name or IRI instead.`, tok);
      }
      found = all[0];
      if (!found && tok.text.includes(':')) {
        const iri = this.n.expand(tok.text);
        if (iri) found = { iri, kind: kinds[0] };
      }
    }
    if (found) this.resolved.push({ from: tok.from, to: tok.to, kind: found.kind });
    return found;
  }
  /** Why a name is not what is wanted here: what it is instead, or that nothing is called so. */
  private wrong(tok: Token, wanted: EntityKind | 'property', context = ''): never {
    const is = tok.kind === 'name' ? this.n.find(tok.text) : [];
    const what = wanted === 'property' ? 'an object or data property' : KIND_WORD[wanted];
    if (tok.kind === 'name' && !is.length && this.n.findEnum(tok.text)) this.fail(`“${tok.text}” is a datatype, not ${what}${context}.`, tok);
    if (is.length) this.fail(`“${tok.text}” is ${KIND_WORD[is[0].kind]}, not ${what}${context}.`, tok);
    this.fail(`There is no ${what.replace(/^an? /, '')} called “${tok.text}”${context}.`, tok);
  }

  classExpression(): ClassExpression {
    const first = this.conjunction();
    if (!this.is('or')) return first;
    const operands = [first];
    while (this.is('or')) {
      this.i++;
      operands.push(this.conjunction());
    }
    return { type: 'ObjectUnionOf', operands };
  }
  private conjunction(): ClassExpression {
    const first = this.unary();
    if (!this.is('and') && !this.is('that')) return first;
    const operands = [first];
    while (this.is('and') || this.is('that')) {
      this.i++;
      operands.push(this.unary());
    }
    return { type: 'ObjectIntersectionOf', operands };
  }
  private unary(): ClassExpression {
    if (this.is('not')) {
      this.i++;
      return { type: 'ObjectComplementOf', operand: this.unary() };
    }
    return this.primary();
  }
  private primary(): ClassExpression {
    const tok = this.peek;
    if (this.is('(')) {
      this.i++;
      const e = this.classExpression();
      this.expect(')', 'a closing )', ['keyword:connective']);
      return e;
    }
    if (this.is('{')) {
      this.i++;
      const individuals: { type: 'NamedIndividual'; iri: string }[] = [];
      do {
        const t = this.next();
        if (t.kind === 'end') this.fail('An individual is missing here.', t, ['individual']);
        const e = this.entity(t, ['individual']);
        if (!e) this.wrong(t, 'individual', ' to list');
        individuals.push(individual(e.iri));
      } while (this.is(',') && this.i++ >= 0);
      this.expect('}', 'a closing }');
      return { type: 'ObjectOneOf', individuals };
    }
    if (this.is('inverse')) {
      this.i++;
      const paren = this.is('(');
      if (paren) this.i++;
      const t = this.next();
      if (t.kind === 'end') this.fail('A property is missing after “inverse”.', t, ['object']);
      const p = this.entity(t, ['object']);
      if (!p) this.wrong(t, 'object', ': only an object property has an inverse');
      if (paren) this.expect(')', 'a closing )');
      return this.restriction({ type: 'ObjectInverseOf', property: objectProperty(p.iri) }, false);
    }
    if (tok.kind === 'end') this.fail('The expression stops short: a class is missing at the end.', tok, STARTS_CLASS);
    if (tok.kind !== 'name' && tok.kind !== 'iri') this.fail(`A class was expected here, not “${tok.text}”.`, tok);
    this.i++;
    const after = this.peek;
    if (after.kind === 'keyword' && RESTRICTION_WORDS.includes(after.text)) {
      const p = this.entity(tok, ['object', 'data']);
      if (!p) this.wrong(tok, 'property', ` to restrict by “${after.text}”`);
      return p.kind === 'data' ? this.restriction(dataProperty(p.iri), true) : this.restriction(objectProperty(p.iri), false);
    }
    if (tok.kind === 'name' && STANDARD_CLASSES[tok.text]) return { type: 'Class', iri: STANDARD_CLASSES[tok.text] };
    const c = this.entity(tok, ['class']);
    if (c) return { type: 'Class', iri: c.iri };
    const other = tok.kind === 'name' ? this.n.find(tok.text) : [];
    // A property that is not followed by what restricts it: say what can.
    if (other.some((e) => e.kind === 'object' || e.kind === 'data')) {
      const data = other.every((e) => e.kind !== 'object');
      this.resolved.push({ from: tok.from, to: tok.to, kind: data ? 'data' : 'object' });
      this.fail(
        after.kind === 'end' ? `“${tok.text}” is a property: say how it restricts, with some, only, value, min, max or exactly.` : `“${tok.text}” is a property: it is followed by some, only, value, min, max or exactly, not “${after.text}”.`,
        after,
        [data ? 'keyword:data-restriction' : 'keyword:restriction'],
      );
    }
    return this.wrong(tok, 'class');
  }

  /** What follows a property: the restriction it makes. */
  private restriction(property: ObjectPropertyExpression | { type: 'DataProperty'; iri: string }, data: boolean): ClassExpression {
    const word = this.next();
    if (word.kind !== 'keyword' || !RESTRICTION_WORDS.includes(word.text)) this.fail(word.kind === 'end' ? 'How the property restricts is missing: some, only, value, min, max or exactly.' : `Expected some, only, value, min, max or exactly here, not “${word.text}”.`, word, [data ? 'keyword:data-restriction' : 'keyword:restriction']);
    if (data) {
      const dp = property as { type: 'DataProperty'; iri: string };
      const context = ` for the data property ${this.n.name(dp.iri, 'data')}`;
      switch (word.text) {
        case 'some':
        case 'only':
          return { type: word.text === 'some' ? 'DataSomeValuesFrom' : 'DataAllValuesFrom', property: dp, filler: this.dataUnary(context) };
        case 'value':
          return { type: 'DataHasValue', property: dp, value: this.literal(this.next()) };
        case 'Self':
          return this.fail('Only an object property can relate a thing to itself (Self).', word);
        default: {
          const n = this.count(word.text);
          const filled = this.startsFiller();
          return { type: `Data${n.kind}Cardinality`, n: n.n, property: dp, ...(filled ? { filler: this.dataUnary(context) } : {}) } as ClassExpression;
        }
      }
    }
    const op = property as ObjectPropertyExpression;
    switch (word.text) {
      case 'some':
      case 'only':
        return { type: word.text === 'some' ? 'ObjectSomeValuesFrom' : 'ObjectAllValuesFrom', property: op, filler: this.filler(op) };
      case 'value': {
        const v = this.next();
        if (v.kind === 'end') this.fail('An individual is missing after “value”.', v, ['individual']);
        if (v.kind === 'string' || v.kind === 'number') this.fail(`${this.n.name(namedProperty(op), 'object')} is an object property: its value is an individual, not a literal.`, v);
        const e = this.entity(v, ['individual']);
        if (!e) this.wrong(v, 'individual');
        return { type: 'ObjectHasValue', property: op, individual: individual(e.iri) };
      }
      case 'Self':
        return { type: 'ObjectHasSelf', property: op };
      default: {
        const n = this.count(word.text);
        const filled = this.startsFiller();
        return { type: `Object${n.kind}Cardinality`, n: n.n, property: op, ...(filled ? { filler: this.filler(op) } : {}) } as ClassExpression;
      }
    }
  }
  /** The class after an object property, with what is wrong said in its terms. */
  private filler(op: ObjectPropertyExpression): ClassExpression {
    const t = this.peek;
    const isDatatype = t.kind === 'name' && !this.n.find(t.text).some((e) => e.kind !== 'datatype') && (!!STANDARD_DATATYPES[t.text] || !!this.n.findEnum(t.text) || this.n.find(t.text).some((e) => e.kind === 'datatype'));
    if (isDatatype) this.fail(`“${t.text}” is a datatype; ${this.n.name(namedProperty(op), 'object')} is an object property, whose values are individuals of a class.`, t);
    if (t.kind === 'string' || t.kind === 'number') this.fail(`${this.n.name(namedProperty(op), 'object')} is an object property: its values are individuals of a class, not literals.`, t);
    return this.unary();
  }
  private count(word: string): { n: number; kind: 'Min' | 'Max' | 'Exact' } {
    const t = this.next();
    if (t.kind !== 'number' || !/^\d+$/.test(t.text)) this.fail(`A whole number is expected after ${word}.`, t);
    return { n: Number(t.text), kind: word === 'min' ? 'Min' : word === 'max' ? 'Max' : 'Exact' };
  }
  /** Whether a filler follows a number: anything but "and", "or", "that", a closing bracket, a comma or the end. */
  private startsFiller(): boolean {
    const t = this.peek;
    if (t.kind === 'end') return false;
    if (t.kind === 'keyword') return t.text === 'not' || t.text === 'inverse';
    if (t.kind === 'punct') return t.text === '(' || t.text === '{';
    return t.kind === 'name' || t.kind === 'iri';
  }

  private literal(t: Token): Literal {
    if (t.kind === 'number') return numberLiteral(t.text);
    if (t.kind === 'keyword' && (t.text === 'true' || t.text === 'false')) return { value: t.text, datatype: XSD + 'boolean' };
    if (t.kind !== 'string') return this.fail(t.kind === 'end' ? 'A value is missing at the end.' : `A value (a number, true or false, or text in double quotes) was expected here, not “${t.text}”.`, t, ['literal']);
    if (t.lang) return { value: t.text, lang: t.lang };
    if (!t.dt) return { value: t.text };
    const dt = t.dt.startsWith('<') ? t.dt.slice(1, -1) : (STANDARD_DATATYPES[t.dt] ?? this.n.expand(t.dt));
    if (!dt) this.fail(`The datatype “${t.dt}” is not known: use a prefixed name such as xsd:date.`, t);
    return dt === XSD + 'string' ? { value: t.text } : { value: t.text, datatype: dt };
  }

  dataRange(): DataRange {
    const first = this.dataConjunction();
    if (!this.is('or')) return first;
    const operands = [first];
    while (this.is('or')) {
      this.i++;
      operands.push(this.dataConjunction());
    }
    return { type: 'DataUnionOf', operands };
  }
  private dataConjunction(): DataRange {
    const first = this.dataUnary();
    if (!this.is('and')) return first;
    const operands = [first];
    while (this.is('and')) {
      this.i++;
      operands.push(this.dataUnary());
    }
    return { type: 'DataIntersectionOf', operands };
  }
  private dataUnary(context = ''): DataRange {
    if (this.is('not')) {
      this.i++;
      return { type: 'DataComplementOf', operand: this.dataUnary(context) };
    }
    const tok = this.peek;
    if (this.is('(')) {
      this.i++;
      const r = this.dataRange();
      this.expect(')', 'a closing )');
      return r;
    }
    if (this.is('{')) {
      this.i++;
      const literals: Literal[] = [];
      do literals.push(this.literal(this.next()));
      while (this.is(',') && this.i++ >= 0);
      this.expect('}', 'a closing }');
      return { type: 'DataOneOf', literals };
    }
    if (tok.kind === 'end') this.fail('A datatype is missing at the end.', tok, STARTS_DATA);
    if (tok.kind !== 'name' && tok.kind !== 'iri') this.fail(`A datatype was expected here, not “${tok.text}”.`, tok);
    this.i++;
    const named = tok.kind === 'name' ? this.n.findEnum(tok.text) : undefined;
    if (named && !this.is('[')) {
      this.resolved.push({ from: tok.from, to: tok.to, kind: 'enum' });
      return { type: 'Enumeration', datatype: named };
    }
    let dt: string | undefined = tok.kind === 'iri' ? tok.text : STANDARD_DATATYPES[tok.text];
    if (dt) this.resolved.push({ from: tok.from, to: tok.to, kind: 'datatype' });
    else dt = this.entity(tok, ['datatype'])?.iri;
    if (!dt) {
      const is = tok.kind === 'name' ? this.n.find(tok.text) : [];
      if (is.some((e) => e.kind === 'class')) this.fail(`“${tok.text}” is a class, not a datatype${context}: a data property has literals as its values.`, tok);
      if (is.length) this.wrong(tok, 'datatype', context);
      this.fail(`There is no datatype called “${tok.text}”: use a prefixed name such as xsd:integer, or the name of an enumerated datatype.`, tok);
    }
    if (!this.is('[')) return { type: 'Datatype', iri: dt };
    this.i++;
    const facets: { facet: string; value: Literal }[] = [];
    do {
      const f = this.next();
      const facet = f.kind === 'string' ? undefined : SYMBOL_FACET[f.text];
      if (!facet) this.fail(f.kind === 'end' ? 'A facet is missing here.' : `“${f.text}” is not a facet: use length, minLength, maxLength, pattern, langRange, <, <=, > or >=.`, f, ['facet']);
      facets.push({ facet, value: this.literal(this.next()) });
    } while (this.is(',') && this.i++ >= 0);
    this.expect(']', 'a closing ]', ['facet']);
    return { type: 'DatatypeRestriction', datatype: dt, facets };
  }
}

/** A literal from Manchester syntax: 18, 1.5, true, "text", "text"@en, "2026-10-14"^^xsd:date. Throws a ParseError. */
export function parseLiteral(text: string, n: Naming): Literal {
  const r = parseDataRange(`{${text}}`, n);
  if (r.type !== 'DataOneOf' || r.literals.length !== 1) throw new ParseError('Write one value.', 0);
  return r.literals[0];
}

/** A class expression from Manchester syntax. Throws a ParseError that says what is wrong, and where. */
export function parseClass(text: string, n: Naming): ClassExpression {
  if (!text.trim()) throw new ParseError('Write a class, or an expression of classes.', 0, STARTS_CLASS);
  const r = new Reader(tokenize(text), n);
  const e = r.classExpression();
  r.done();
  return e;
}

/** A data range from Manchester syntax. Throws a ParseError that says what is wrong, and where. */
export function parseDataRange(text: string, n: Naming): DataRange {
  if (!text.trim()) throw new ParseError('Write a datatype, or an expression of datatypes.', 0, STARTS_DATA);
  const r = new Reader(tokenize(text), n);
  const e = r.dataRange();
  r.done();
  return e;
}

// ---------------------------------------------------------------- for an editor of the text

/** The text as it reads: each token, names with what they turned out to be, and the first problem. */
export interface Reading {
  tokens: (Token & { entity?: Resolved['kind'] })[];
  error?: ParseError;
}

/** Reads a text for an editor: what to highlight, and what is wrong, without throwing. */
export function readText(text: string, n: Naming, as: 'class' | 'data'): Reading {
  let toks: Token[];
  try {
    toks = tokenize(text);
  } catch (e) {
    return { tokens: [], error: e as ParseError };
  }
  const r = new Reader(toks, n);
  let error: ParseError | undefined;
  try {
    if (!text.trim()) throw new ParseError(as === 'class' ? 'Write a class, or an expression of classes.' : 'Write a datatype, or an expression of datatypes.', 0);
    if (as === 'class') r.classExpression();
    else r.dataRange();
    r.done();
  } catch (e) {
    error = e as ParseError;
  }
  const kinds = new Map(r.resolved.map((x) => [x.from, x.kind]));
  return { tokens: toks.filter((t) => t.kind !== 'end').map((t) => (t.kind === 'name' || t.kind === 'iri' ? { ...t, entity: kinds.get(t.from) ?? 'unknown' } : t)), ...(error ? { error } : {}) };
}

/** A suggestion for completing the text: what to write, and what it is. */
export interface Completion {
  text: string;
  kind: Expected;
  detail: string;
}

const KEYWORD_OPTIONS: Partial<Record<Expected, { text: string; detail: string }[]>> = {
  'keyword:class': [
    { text: 'not', detail: 'complement' },
    { text: 'inverse', detail: 'inverse of an object property' },
  ],
  'keyword:restriction': ['some', 'only', 'value', 'min', 'max', 'exactly', 'Self'].map((t) => ({ text: t, detail: 'restriction' })),
  'keyword:data-restriction': ['some', 'only', 'value', 'min', 'max', 'exactly'].map((t) => ({ text: t, detail: 'restriction' })),
  'keyword:connective': [
    { text: 'and', detail: 'intersection' },
    { text: 'or', detail: 'union' },
  ],
  facet: FACETS.map((t) => ({ text: t, detail: 'facet' })),
};
const ENTITY_DETAIL: Record<EntityKind, string> = { class: 'class', object: 'object property', data: 'data property', individual: 'individual', datatype: 'datatype' };

/**
 * What can be written at a place in the text (`at`, an offset), for completing it: from where the
 * word being written starts, the suggestions that fit what the grammar expects there. The word
 * written so far narrows them.
 */
export function completionsAt(text: string, at: number, n: Naming, as: 'class' | 'data'): { from: number; options: Completion[] } {
  const before = text.slice(0, at);
  // The word being written: a name (perhaps quoted, perhaps prefixed) or a keyword.
  const word = /(?:'[^']*|[\p{L}\p{N}_:\-.]*)$/u.exec(before)![0];
  const from = at - word.length;
  let expected: Expected[];
  try {
    const r = new Reader(tokenize(before.slice(0, from)), n);
    if (as === 'class') r.classExpression();
    else r.dataRange();
    r.done();
    // A whole expression so far: it goes on with "and" or "or".
    expected = ['keyword:connective'];
  } catch (e) {
    expected = e instanceof ParseError ? e.expected : [];
  }
  const typed = word.replace(/^'/, '').toLowerCase();
  const options: Completion[] = [];
  for (const kind of expected) {
    if (kind === 'class' || kind === 'object' || kind === 'data' || kind === 'individual' || kind === 'datatype') for (const e of n.entities(kind)) options.push({ text: e.text, kind, detail: ENTITY_DETAIL[kind] });
    else if (kind === 'enum') for (const e of n.enums()) options.push({ text: e.text, kind, detail: 'enumerated datatype' });
    else for (const k of KEYWORD_OPTIONS[kind] ?? []) options.push({ text: k.text, kind, detail: k.detail });
  }
  const seen = new Set<string>();
  return {
    from,
    options: options.filter((o) => {
      const k = o.text + '|' + o.kind;
      if (seen.has(k)) return false;
      seen.add(k);
      return !typed || o.text.replace(/^'/, '').toLowerCase().includes(typed);
    }),
  };
}
