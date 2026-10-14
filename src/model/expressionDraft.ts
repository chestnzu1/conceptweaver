import { dataProperty, individual, objectProperty, type ClassExpression, type DataRange, type Literal, type ObjectPropertyExpression } from './expressions';
import { classText, dataText, facetText, literalText, type Naming } from './manchester';
import { uid } from './types';

/**
 * An expression while it is being built in the visual editor: a tree of blocks that may be
 * unfinished (a hole where nothing is chosen yet, a restriction with no property), where every
 * block keeps all it has been given. Changing a block's operator keeps the rest: some becomes
 * only with the same property and filler, and becomes or with the same operands, and back again
 * whatever was set before is there. Only a draft without problems becomes an expression
 * (`fromDraft`); one is never stored, saved or written as a draft.
 */

/** What a block is. Class expressions and data ranges share the connectives; which it is follows from where it stands. */
export type DraftKind =
  // either
  | 'hole'
  | 'and'
  | 'or'
  | 'not'
  // class expressions
  | 'class'
  | 'oneOf'
  | 'some'
  | 'only'
  | 'value'
  | 'self'
  | 'min'
  | 'max'
  | 'exactly'
  // data ranges
  | 'datatype'
  | 'enum'
  | 'literals'
  | 'facets'
  // kept as it was read: shown, not edited
  | 'unparsed';

export type Sort = 'class' | 'data';

export interface DraftFacet {
  /** The facet's IRI (xsd:minInclusive and so on). */
  facet: string;
  value?: Literal;
}

export interface DraftNode {
  /** A key that stays the same while the block is edited. */
  key: string;
  kind: DraftKind;
  /** A class or a datatype. */
  iri?: string;
  /** The property of a restriction: object or data, and for an object one whether it is the inverse. */
  property?: { iri: string; kind: 'object' | 'data'; inverse?: boolean };
  /** How many, for min, max and exactly. */
  n?: number;
  /** The operands of and, or and not (not has one), and the filler of a restriction (one, or none). */
  children: DraftNode[];
  /** The individuals of a one-of list, or the one of an object value restriction. */
  individuals?: string[];
  /** The literal of a data value restriction. */
  literal?: Literal;
  /** The literals of a list of data values. */
  literals?: Literal[];
  facets?: DraftFacet[];
  /** An enumerated datatype of the model, by id. */
  enumId?: string;
  /** What a block kept as it was read stands for. */
  kept?: ClassExpression | DataRange;
}

/** Something to put right before a draft is an expression, at a block. */
export interface Problem {
  key: string;
  message: string;
}

export const hole = (): DraftNode => ({ key: uid(), kind: 'hole', children: [] });
const node = (kind: DraftKind, rest: Partial<DraftNode> = {}): DraftNode => ({ key: uid(), kind, children: [], ...rest });

const RESTRICTIONS: DraftKind[] = ['some', 'only', 'value', 'self', 'min', 'max', 'exactly'];
export const isRestriction = (k: DraftKind) => RESTRICTIONS.includes(k);
export const isCounted = (k: DraftKind) => k === 'min' || k === 'max' || k === 'exactly';
/** Whether a block has a filler under it: some, only, and a counted restriction (which may go without one). */
export const hasFiller = (k: DraftKind) => k === 'some' || k === 'only' || isCounted(k);

const propertyOf = (p: ObjectPropertyExpression): DraftNode['property'] => (p.type === 'ObjectInverseOf' ? { iri: p.property.iri, kind: 'object', inverse: true } : { iri: p.iri, kind: 'object' });

/** A draft of an expression: every block finished. */
export function toDraft(e: ClassExpression | DataRange): DraftNode {
  switch (e.type) {
    case 'Class':
      return node('class', { iri: e.iri });
    case 'ObjectIntersectionOf':
    case 'ObjectUnionOf':
      return node(e.type === 'ObjectIntersectionOf' ? 'and' : 'or', { children: e.operands.map(toDraft) });
    case 'DataIntersectionOf':
    case 'DataUnionOf':
      return node(e.type === 'DataIntersectionOf' ? 'and' : 'or', { children: e.operands.map(toDraft) });
    case 'ObjectComplementOf':
    case 'DataComplementOf':
      return node('not', { children: [toDraft(e.operand)] });
    case 'ObjectOneOf':
      return node('oneOf', { individuals: e.individuals.map((i) => i.iri) });
    case 'ObjectSomeValuesFrom':
    case 'ObjectAllValuesFrom':
      return node(e.type === 'ObjectSomeValuesFrom' ? 'some' : 'only', { property: propertyOf(e.property), children: [toDraft(e.filler)] });
    case 'DataSomeValuesFrom':
    case 'DataAllValuesFrom':
      return node(e.type === 'DataSomeValuesFrom' ? 'some' : 'only', { property: { iri: e.property.iri, kind: 'data' }, children: [toDraft(e.filler)] });
    case 'ObjectHasValue':
      return node('value', { property: propertyOf(e.property), individuals: [e.individual.iri] });
    case 'DataHasValue':
      return node('value', { property: { iri: e.property.iri, kind: 'data' }, literal: e.value });
    case 'ObjectHasSelf':
      return node('self', { property: propertyOf(e.property) });
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality':
      return node(e.type === 'ObjectMinCardinality' ? 'min' : e.type === 'ObjectMaxCardinality' ? 'max' : 'exactly', { property: propertyOf(e.property), n: e.n, children: e.filler ? [toDraft(e.filler)] : [] });
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality':
      return node(e.type === 'DataMinCardinality' ? 'min' : e.type === 'DataMaxCardinality' ? 'max' : 'exactly', { property: { iri: e.property.iri, kind: 'data' }, n: e.n, children: e.filler ? [toDraft(e.filler)] : [] });
    case 'Datatype':
      return node('datatype', { iri: e.iri });
    case 'Enumeration':
      return node('enum', { enumId: e.datatype });
    case 'DataOneOf':
      return node('literals', { literals: e.literals });
    case 'DatatypeRestriction':
      return node('facets', { iri: e.datatype, facets: e.facets });
    case 'Unparsed':
      return node('unparsed', { kept: e });
  }
}

const KIND_NAME: Partial<Record<DraftKind, string>> = { and: 'An intersection (and)', or: 'A union (or)' };

/**
 * The expression a draft stands for, or what is to be put right first. `sort` is what stands
 * at its top: a class expression, or a data range.
 */
export function fromDraft(d: DraftNode, sort: 'class'): { value?: ClassExpression; problems: Problem[] };
export function fromDraft(d: DraftNode, sort: 'data'): { value?: DataRange; problems: Problem[] };
export function fromDraft(d: DraftNode, sort: Sort): { value?: ClassExpression | DataRange; problems: Problem[] } {
  const problems: Problem[] = [];
  const say = (n: DraftNode, message: string) => {
    problems.push({ key: n.key, message });
    return undefined;
  };
  const cls = (n: DraftNode): ClassExpression | undefined => {
    switch (n.kind) {
      case 'hole':
        return say(n, 'Choose what goes here: a class, a restriction, or an expression of them.');
      case 'class':
        return n.iri ? { type: 'Class', iri: n.iri } : say(n, 'Choose a class.');
      case 'and':
      case 'or': {
        const operands = n.children.map(cls);
        if (n.children.length < 2) return say(n, `${KIND_NAME[n.kind]} needs two expressions or more.`);
        return operands.every((x) => x) ? { type: n.kind === 'and' ? 'ObjectIntersectionOf' : 'ObjectUnionOf', operands: operands as ClassExpression[] } : undefined;
      }
      case 'not': {
        if (!n.children.length) return say(n, 'Choose what this is the complement of.');
        const operand = cls(n.children[0]);
        return operand && { type: 'ObjectComplementOf', operand };
      }
      case 'oneOf':
        return n.individuals?.length ? { type: 'ObjectOneOf', individuals: n.individuals.map(individual) } : say(n, 'List one individual or more.');
      case 'unparsed':
        return n.kept && 'type' in n.kept && isClass(n.kept) ? n.kept : say(n, 'This was kept as it was read as a data range, and cannot stand for a class.');
      case 'datatype':
      case 'enum':
      case 'literals':
      case 'facets':
        return say(n, 'A datatype cannot stand here: this is a class expression.');
      default:
        return restriction(n);
    }
  };
  const restriction = (n: DraftNode): ClassExpression | undefined => {
    const p = n.property;
    if (!p?.iri) return say(n, 'Choose the property it restricts.');
    const filler = n.children[0];
    if (p.kind === 'data') {
      const dp = dataProperty(p.iri);
      switch (n.kind) {
        case 'some':
        case 'only': {
          if (!filler) return say(n, 'Choose the datatype of the values.');
          const range = data(filler);
          return range && { type: n.kind === 'some' ? 'DataSomeValuesFrom' : 'DataAllValuesFrom', property: dp, filler: range };
        }
        case 'value':
          return n.literal ? { type: 'DataHasValue', property: dp, value: n.literal } : say(n, 'Give the value.');
        case 'self':
          return say(n, 'Only an object property can relate a thing to itself (Self).');
        default: {
          if (n.n === undefined || n.n < 0 || !Number.isInteger(n.n)) return say(n, 'Give a whole number.');
          const range = filler ? data(filler) : undefined;
          if (filler && !range) return undefined;
          const type = n.kind === 'min' ? 'DataMinCardinality' : n.kind === 'max' ? 'DataMaxCardinality' : 'DataExactCardinality';
          return { type, n: n.n, property: dp, ...(range ? { filler: range } : {}) };
        }
      }
    }
    const op: ObjectPropertyExpression = p.inverse ? { type: 'ObjectInverseOf', property: objectProperty(p.iri) } : objectProperty(p.iri);
    switch (n.kind) {
      case 'some':
      case 'only': {
        if (!filler) return say(n, 'Choose the class of the values.');
        const c = cls(filler);
        return c && { type: n.kind === 'some' ? 'ObjectSomeValuesFrom' : 'ObjectAllValuesFrom', property: op, filler: c };
      }
      case 'value':
        return n.individuals?.[0] ? { type: 'ObjectHasValue', property: op, individual: individual(n.individuals[0]) } : say(n, 'Choose the individual.');
      case 'self':
        return { type: 'ObjectHasSelf', property: op };
      default: {
        if (n.n === undefined || n.n < 0 || !Number.isInteger(n.n)) return say(n, 'Give a whole number.');
        const c = filler ? cls(filler) : undefined;
        if (filler && !c) return undefined;
        const type = n.kind === 'min' ? 'ObjectMinCardinality' : n.kind === 'max' ? 'ObjectMaxCardinality' : 'ObjectExactCardinality';
        return { type, n: n.n, property: op, ...(c ? { filler: c } : {}) };
      }
    }
  };
  const data = (n: DraftNode): DataRange | undefined => {
    switch (n.kind) {
      case 'hole':
        return say(n, 'Choose a datatype, or an expression of datatypes.');
      case 'datatype':
        return n.iri ? { type: 'Datatype', iri: n.iri } : say(n, 'Choose a datatype.');
      case 'enum':
        return n.enumId ? { type: 'Enumeration', datatype: n.enumId } : say(n, 'Choose an enumerated datatype.');
      case 'and':
      case 'or': {
        const operands = n.children.map(data);
        if (n.children.length < 2) return say(n, `${KIND_NAME[n.kind]} needs two data ranges or more.`);
        return operands.every((x) => x) ? { type: n.kind === 'and' ? 'DataIntersectionOf' : 'DataUnionOf', operands: operands as DataRange[] } : undefined;
      }
      case 'not': {
        if (!n.children.length) return say(n, 'Choose what this is the complement of.');
        const operand = data(n.children[0]);
        return operand && { type: 'DataComplementOf', operand };
      }
      case 'literals':
        return n.literals?.length ? { type: 'DataOneOf', literals: n.literals } : say(n, 'List one value or more.');
      case 'facets': {
        if (!n.iri) return say(n, 'Choose the datatype the facets narrow.');
        if (!n.facets?.length) return say(n, 'Add a facet, such as >= 0.');
        const missing = n.facets.find((f) => !f.value);
        if (missing) return say(n, 'Give each facet its value.');
        return { type: 'DatatypeRestriction', datatype: n.iri, facets: n.facets.map((f) => ({ facet: f.facet, value: f.value! })) };
      }
      case 'unparsed':
        return n.kept && !isClass(n.kept) ? (n.kept as DataRange) : say(n, 'This was kept as it was read as a class expression, and cannot stand for a datatype.');
      default:
        return say(n, 'A class expression cannot stand here: the values of a data property are literals of a datatype.');
    }
  };
  const value = sort === 'class' ? cls(d) : data(d);
  return problems.length ? { problems } : { value, problems };
}

const isClass = (e: ClassExpression | DataRange): e is ClassExpression => !['Datatype', 'DataIntersectionOf', 'DataUnionOf', 'DataComplementOf', 'DataOneOf', 'DatatypeRestriction', 'Enumeration'].includes(e.type) && !(e.type === 'Unparsed' && /rdf-schema#Datatype/.test(e.turtle));

// ---------------------------------------------------------------- editing a draft

/** The draft with one block changed (found by key); the same draft when there is no such block. */
export function updateNode(d: DraftNode, key: string, change: (n: DraftNode) => DraftNode): DraftNode {
  if (d.key === key) return change(d);
  let changed = false;
  const children = d.children.map((c) => {
    const next = updateNode(c, key, change);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...d, children } : d;
}

/** The block with a key, and the block it is under. */
export function findNode(d: DraftNode, key: string, parent?: DraftNode): { node: DraftNode; parent?: DraftNode } | undefined {
  if (d.key === key) return { node: d, parent };
  for (const c of d.children) {
    const hit = findNode(c, key, d);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A block given another operator, keeping everything else it has: its property, number, filler,
 * operands and choices stay with it, and are used again where the new operator has a place for
 * them. What a new operator needs and the block does not have yet is left to be chosen.
 */
export function withKind(n: DraftNode, kind: DraftKind, sort: Sort): DraftNode {
  const next: DraftNode = { ...n, kind };
  if (isCounted(kind) && next.n === undefined) next.n = 1;
  // Connectives need operands to show; a restriction needs a filler where it takes one.
  if ((kind === 'and' || kind === 'or') && next.children.length < 2) next.children = [...next.children, ...Array.from({ length: 2 - next.children.length }, hole)];
  if (kind === 'not' && !next.children.length) next.children = [hole()];
  if ((kind === 'some' || kind === 'only') && !next.children.length) next.children = [hole()];
  // A restriction in a data range, or a datatype in a class expression, has no place: the sort decides.
  if (sort === 'data' && (kind === 'class' || kind === 'oneOf' || isRestriction(kind))) return n;
  if (sort === 'class' && (kind === 'datatype' || kind === 'enum' || kind === 'literals' || kind === 'facets')) return n;
  return next;
}

/** The property of a restriction set: object or data. A filler that cannot follow the new property is put aside for a hole. */
export function withProperty(n: DraftNode, property: DraftNode['property']): DraftNode {
  const kindChanged = n.property?.kind !== property?.kind;
  return { ...n, property, ...(kindChanged && n.children.length ? { children: [hole()] } : {}), ...(property?.kind === 'data' && n.kind === 'self' ? { kind: 'some', children: [hole()] } : {}) };
}

/** A block put inside a new and, or or not, as its first operand. */
export function wrapNode(d: DraftNode, key: string, kind: 'and' | 'or' | 'not'): DraftNode {
  return updateNode(d, key, (n) => node(kind, { children: kind === 'not' ? [n] : [n, hole()] }));
}

/** An and, or or not replaced by its first operand. */
export function unwrapNode(d: DraftNode, key: string): DraftNode {
  return updateNode(d, key, (n) => (n.children[0] && (n.kind === 'and' || n.kind === 'or' || n.kind === 'not') ? n.children[0] : n));
}

/** A block taken out: an operand of and or or goes; anything else becomes a hole to fill again. */
export function removeNode(d: DraftNode, key: string): DraftNode {
  if (d.key === key) return hole();
  const at = findNode(d, key);
  if (!at?.parent) return d;
  const p = at.parent;
  if ((p.kind === 'and' || p.kind === 'or') && p.children.length > 2) return updateNode(d, p.key, (x) => ({ ...x, children: x.children.filter((c) => c.key !== key) }));
  if (isCounted(p.kind)) return updateNode(d, p.key, (x) => ({ ...x, children: x.children.filter((c) => c.key !== key) }));
  return updateNode(d, key, () => hole());
}

/** A new hole added to an and or an or, at the end. */
export function addOperand(d: DraftNode, key: string): DraftNode {
  return updateNode(d, key, (n) => (n.kind === 'and' || n.kind === 'or' ? { ...n, children: [...n.children, hole()] } : n));
}

/** How deep a draft goes, for laying it out: a block alone is 1. */
export const depthOf = (d: DraftNode): number => 1 + Math.max(0, ...d.children.map(depthOf));

/**
 * A draft as Manchester syntax, with a ? for whatever is still to be chosen: what the text editor
 * shows of a draft that is not finished. A finished draft reads as its expression does.
 */
export function draftText(d: DraftNode, n: Naming, sort: Sort): string {
  const finished = fromDraft(d, sort as 'class');
  if (finished.value) return sort === 'class' ? classText(finished.value as ClassExpression, n) : dataText(finished.value as unknown as DataRange, n);
  const inner = (x: DraftNode, s: Sort) => (x.kind === 'and' || x.kind === 'or' || isRestriction(x.kind) ? `(${draftText(x, n, s)})` : draftText(x, n, s));
  const filler = (x: DraftNode, s: Sort) => (s === 'class' && x.kind === 'not' ? `(${draftText(x, n, s)})` : inner(x, s));
  const prop = d.property?.iri ? (d.property.inverse ? 'inverse ' : '') + n.name(d.property.iri, d.property.kind) : '?';
  const fillerSort: Sort = d.property?.kind === 'data' ? 'data' : 'class';
  const lit = (l?: Literal) => (l ? literalText(l, n) : '?');
  switch (d.kind) {
    case 'hole':
      return '?';
    case 'class':
      return d.iri ? n.name(d.iri, 'class') : '?';
    case 'datatype':
      return d.iri ? n.name(d.iri, 'datatype') : '?';
    case 'enum':
      return d.enumId ? n.enumName(d.enumId) : '?';
    case 'and':
    case 'or':
      return d.children.length ? d.children.map((c) => inner(c, sort)).join(` ${d.kind} `) : `? ${d.kind} ?`;
    case 'not':
      return `not ${d.children[0] ? inner(d.children[0], sort) : '?'}`;
    case 'oneOf':
      return `{${d.individuals?.length ? d.individuals.map((i) => n.name(i, 'individual')).join(', ') : '?'}}`;
    case 'literals':
      return `{${d.literals?.length ? d.literals.map(lit).join(', ') : '?'}}`;
    case 'facets':
      return `${d.iri ? n.name(d.iri, 'datatype') : '?'}[${d.facets?.length ? d.facets.map((f) => `${facetText(f.facet)} ${lit(f.value)}`).join(', ') : '?'}]`;
    case 'some':
    case 'only':
      return `${prop} ${d.kind} ${d.children[0] ? filler(d.children[0], fillerSort) : '?'}`;
    case 'value':
      return `${prop} value ${d.property?.kind === 'data' ? lit(d.literal) : d.individuals?.[0] ? n.name(d.individuals[0], 'individual') : '?'}`;
    case 'self':
      return `${prop} Self`;
    case 'min':
    case 'max':
    case 'exactly':
      return `${prop} ${d.kind} ${d.n ?? '?'}${d.children[0] ? ' ' + filler(d.children[0], fillerSort) : ''}`;
    case 'unparsed':
      return d.kept ? (sort === 'class' ? classText(d.kept as ClassExpression, n) : dataText(d.kept as DataRange, n)) : '?';
  }
}
