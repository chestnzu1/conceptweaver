import { functionalSyntax, namedProperty, type ClassAxiom, type ClassExpression, type ClassExpressionAxiom, type DataRange, type DataRangeAxiom } from '../model/expressions';
import { baseIriOf, localName } from '../model/iri';
import { statementsOf } from '../model/unmapped';
import type { EnumDatatype, Model, ObjProp, Term } from '../model/types';
import type { BaseType, BaseTypeName, ElementRef, Key, LogicalAttribute, LogicalChange, LogicalDomain, LogicalElement, LogicalEntity, LogicalModel, LogicalType, Relationship, RelationshipEnd, SemanticMapping, TransformationConfig } from '../logical/contracts';
import { newId } from '../logical/rules';
import type { ProposalSource, SkippedSource, TransformationProposal, TransformationResult } from './contracts';

/**
 * The pure proposal engine of the ontology-to-LDM transformation (roadmap LM-3; FR-M18-1 to
 * FR-M18-6, ADR-024, NFR-18). It reads the ontology's model and the target LDM as plain data and
 * works out proposals; it changes neither. Structure is proposed for acceptance; constraints
 * (mandatory, maximum, key, rule) are candidates, never chosen to begin with.
 *
 * One proposal carries the logical changes it would make, including the semantic mapping those
 * changes imply. The changes are worked out in proposal order against a copy of the LDM, so that
 * accepted proposals apply as one change set; `requires` says which other proposals must go with
 * one.
 */

const OWL = 'http://www.w3.org/2002/07/owl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** The logical type each standard datatype is given, before the LDM's own table says otherwise. */
export const DEFAULT_DATATYPES: Record<string, BaseTypeName> = {
  [XSD + 'string']: 'text',
  [XSD + 'normalizedString']: 'text',
  [XSD + 'token']: 'text',
  [XSD + 'language']: 'text',
  [XSD + 'Name']: 'text',
  [XSD + 'NCName']: 'text',
  [XSD + 'anyURI']: 'text',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString': 'text',
  [XSD + 'integer']: 'integer',
  [XSD + 'int']: 'integer',
  [XSD + 'long']: 'integer',
  [XSD + 'short']: 'integer',
  [XSD + 'byte']: 'integer',
  [XSD + 'nonNegativeInteger']: 'integer',
  [XSD + 'positiveInteger']: 'integer',
  [XSD + 'nonPositiveInteger']: 'integer',
  [XSD + 'negativeInteger']: 'integer',
  [XSD + 'unsignedLong']: 'integer',
  [XSD + 'unsignedInt']: 'integer',
  [XSD + 'unsignedShort']: 'integer',
  [XSD + 'unsignedByte']: 'integer',
  [XSD + 'decimal']: 'decimal',
  [XSD + 'float']: 'decimal',
  [XSD + 'double']: 'decimal',
  [XSD + 'boolean']: 'boolean',
  [XSD + 'date']: 'date',
  [XSD + 'time']: 'time',
  [XSD + 'dateTime']: 'dateTime',
  [XSD + 'dateTimeStamp']: 'dateTime',
  [XSD + 'duration']: 'duration',
  [XSD + 'base64Binary']: 'binary',
  [XSD + 'hexBinary']: 'binary',
};

/** The configuration a first derivation starts with: every class, the ontology's labels as written. */
export function defaultTransformationConfig(): TransformationConfig {
  return {
    scope: { kind: 'all', classes: [], withImports: false },
    naming: { from: 'label', case: 'asis', separator: ' ', singular: true },
    datatypes: {},
    hierarchy: 'specialization',
    objectProperties: 'relationship',
    definitions: true,
  };
}

// ---------------------------------------------------------------- names

const wordsOf = (raw: string): string[] =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const capitalize = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);

/** A word made singular, in the simple English way names need ("Films" → "Film", "Categories" → "Category"). */
export function singularWord(w: string): string {
  if (w.length > 3 && /ies$/i.test(w)) return w.slice(0, -3) + (w.endsWith('IES') ? 'Y' : 'y');
  if (w.length > 3 && /(ses|xes|zes|ches|shes)$/i.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /s$/i.test(w) && !/ss$/i.test(w)) return w.slice(0, -1);
  return w;
}

const localPart = (iri: string) => {
  const at = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return at >= 0 ? iri.slice(at + 1) : iri;
};

/**
 * What a thing is called in the LDM: from its label or its IRI's local name, then cased and
 * joined as the configuration says, and made singular where the thing is one entity.
 */
export function nameFor(raw: string, iri: string | undefined, naming: TransformationConfig['naming'], singular: boolean): string {
  const source = naming.from === 'localName' && iri ? localPart(iri) : raw;
  if (naming.case === 'asis') {
    let s = source.trim().replace(/\s+/g, naming.separator === ' ' ? ' ' : naming.separator);
    if (singular) {
      const m = s.match(/^(.*?)([\p{L}\p{N}]+)$/u);
      if (m) s = m[1] + singularWord(m[2]);
    }
    return s || 'Untitled';
  }
  const parts = wordsOf(source);
  if (!parts.length) return 'Untitled';
  if (singular) parts[parts.length - 1] = singularWord(parts[parts.length - 1]);
  if (naming.case === 'lower') return parts.map((p) => p.toLowerCase()).join(naming.separator);
  if (naming.case === 'upper') return parts.map((p) => p.toUpperCase()).join(naming.separator);
  if (naming.case === 'pascal') return parts.map(capitalize).join('');
  return parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : capitalize(p))).join('');
}

function freeName(base: string, used: Set<string>): string {
  const clean = base.trim() || 'Untitled';
  if (!used.has(clean.toLowerCase())) {
    used.add(clean.toLowerCase());
    return clean;
  }
  for (let n = 2; ; n++) {
    const candidate = `${clean} ${n}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

// ---------------------------------------------------------------- the engine's state

interface Context {
  model: Model;
  config: TransformationConfig;
  origin: TransformationResult['origin'];
  at: number;
  working: LogicalModel;
  proposals: TransformationProposal[];
  skipped: SkippedSource[];
  /** The class or enumerated datatype IRI each LDM entity was made from. */
  entityByClass: Map<string, string>;
  /** The proposal that made each entity, where one in this result did. */
  entityProposal: Map<string, string>;
  /** The enumerated datatype id or the enumerated class IRI each domain was made from. */
  domainByEnum: Map<string, string>;
  /** The object property IRI each relationship was made from. */
  relationshipByProp: Map<string, string>;
  relationshipProposal: Map<string, string>;
  /** `${property IRI}|${entity id}` → the attribute made from it there. */
  attributeByProp: Map<string, string>;
  attributeProposal: Map<string, string>;
  entityNames: Set<string>;
  domainNames: Set<string>;
  sourceMapped: Map<string, ElementRef[]>;
}

const termIri = (m: Model, t: Pick<Term, 'iri' | 'name' | 'type'>) => t.iri ?? baseIriOf(m) + localName(t.name, t.type === 'property');
const propIriOf = (m: Model, p: Pick<ObjProp, 'iri' | 'name'>) => p.iri ?? baseIriOf(m) + localName(p.name, true);
const enumIriOf = (m: Model, d: Pick<EnumDatatype, 'iri' | 'name'>) => d.iri ?? baseIriOf(m) + localName(d.name, false);

export { enumIriOf, propIriOf, termIri };

const keyOfRef = (r: ElementRef) => Object.keys(r)[0] as keyof ElementRef;
const idOfRef = (r: ElementRef) => (r as Record<string, string>)[keyOfRef(r)];

const clone = <T>(x: T): T => (typeof structuredClone === 'function' ? structuredClone(x) : (JSON.parse(JSON.stringify(x)) as T));

function refExists(m: LogicalModel, ref: ElementRef): boolean {
  const id = idOfRef(ref);
  switch (keyOfRef(ref)) {
    case 'entity':
      return m.entities.some((e) => e.id === id);
    case 'attribute':
      return m.entities.some((e) => e.attributes.some((a) => a.id === id));
    case 'key':
      return m.entities.some((e) => e.keys.some((k) => k.id === id));
    case 'relationship':
      return m.relationships.some((r) => r.id === id);
    case 'generalization':
      return m.generalizations.some((g) => g.id === id);
    case 'rule':
      return m.rules.some((r) => r.id === id);
    case 'domain':
      return m.domains.some((d) => d.id === id);
    case 'mapping':
      return m.mappings.some((x) => x.id === id);
    case 'diagram':
      return m.diagrams.some((d) => d.id === id);
  }
  return false;
}

function addElement(m: LogicalModel, e: LogicalElement): void {
  switch (e.kind) {
    case 'entity':
      m.entities.push(e.entity);
      return;
    case 'attribute': {
      const entity = m.entities.find((x) => x.id === e.entity);
      entity?.attributes.push(e.attribute);
      return;
    }
    case 'key': {
      const entity = m.entities.find((x) => x.id === e.entity);
      entity?.keys.push(e.key);
      return;
    }
    case 'relationship':
      m.relationships.push(e.relationship);
      return;
    case 'generalization':
      m.generalizations.push(e.generalization);
      return;
    case 'rule':
      m.rules.push(e.rule);
      return;
    case 'domain':
      m.domains.push(e.domain);
      return;
    case 'mapping':
      m.mappings.push(e.mapping);
      return;
    case 'diagram':
      m.diagrams.push(e.diagram);
      return;
  }
}

/** The changes a proposal carries, worked into the copy at once so later proposals see them. */
function takeChanges(ctx: Context, changes: LogicalChange[]): void {
  for (const c of changes) {
    // The copy gets elements of its own: a later proposal may add an attribute to the entity a
    // proposal added, and must not thereby change the change that added it.
    if (c.op === 'add') addElement(ctx.working, clone(c.element));
    else if (c.op === 'update' && !('model' in c.target)) {
      const id = idOfRef(c.target);
      const apply = <T>(x: T): T => {
        const next = { ...x } as Record<string, unknown>;
        for (const [k, v] of Object.entries(c.after)) {
          if (v === undefined) delete next[k];
          else next[k] = v;
        }
        return next as T;
      };
      switch (keyOfRef(c.target)) {
        case 'entity':
          ctx.working.entities = ctx.working.entities.map((e) => (e.id === id ? apply(e) : e));
          break;
        case 'attribute':
          ctx.working.entities = ctx.working.entities.map((e) => (e.attributes.some((a) => a.id === id) ? { ...e, attributes: e.attributes.map((a) => (a.id === id ? apply(a) : a)) } : e));
          break;
        case 'relationship':
          ctx.working.relationships = ctx.working.relationships.map((r) => (r.id === id ? apply(r) : r));
          break;
        case 'domain':
          ctx.working.domains = ctx.working.domains.map((d) => (d.id === id ? apply(d) : d));
          break;
        default:
          break;
      }
    }
  }
}

function propose(ctx: Context, p: Omit<TransformationProposal, 'id'>): TransformationProposal {
  const proposal: TransformationProposal = { id: newId('p'), ...p };
  ctx.proposals.push(proposal);
  takeChanges(ctx, proposal.changes);
  return proposal;
}

function mapping(ctx: Context, sources: ProposalSource[], targets: ElementRef[], strategy: string, rationale: string, baseline: Record<string, unknown>): SemanticMapping {
  // A copy, not the element itself: the mapping remembers what it made, and the element moves on.
  return { id: newId('m'), sources, targets, strategy, rationale, origin: ctx.origin, baseline: JSON.parse(JSON.stringify(baseline)), made: { by: 'transformation', at: ctx.at } };
}

// ---------------------------------------------------------------- reading the ontology

/** What reading a model needs, for the functions that only read it. */
interface ModelContext {
  model: Model;
}

/** The OWL 2 functional syntax of an expression, or the Turtle it was kept as when it is not structured. */
function syntaxOf(ctx: ModelContext, e: ClassExpression | DataRange): string {
  if ((e as { type: string }).type === 'Unparsed') return (e as { turtle?: string }).turtle ?? '';
  const enumAs = (id: string): DataRange | undefined => {
    const d = ctx.model.datatypes.find((x) => x.id === id);
    return d ? { type: 'Datatype', iri: enumIriOf(ctx.model, d) } : undefined;
  };
  try {
    return functionalSyntax(e, enumAs);
  } catch {
    return '';
  }
}

const classAxiomText = (ctx: ModelContext, iri: string, a: Pick<ClassExpressionAxiom, 'kind' | 'expression'>): string => `${a.kind}(<${iri}> ${syntaxOf(ctx, a.expression)})`;

function dataRangeAxioms(ctx: ModelContext, t: Term): { domains: string[]; ranges: string[] } {
  const iri = termIri(ctx.model, t);
  return {
    domains: (t.domains ?? []).map((a: ClassAxiom) => `DataPropertyDomain(<${iri}> ${syntaxOf(ctx, a.expression)})`),
    ranges: (t.ranges ?? []).map((a: DataRangeAxiom) => `DataPropertyRange(<${iri}> ${syntaxOf(ctx, a.range)})`),
  };
}

function objectAxioms(ctx: ModelContext, p: ObjProp): string[] {
  const iri = propIriOf(ctx.model, p);
  const out = [`Declaration(ObjectProperty(<${iri}>))`];
  for (const a of p.domains ?? []) out.push(`ObjectPropertyDomain(<${iri}> ${syntaxOf(ctx, a.expression)})`);
  for (const a of p.ranges ?? []) out.push(`ObjectPropertyRange(<${iri}> ${syntaxOf(ctx, a.expression)})`);
  for (const inverse of p.inverses ?? []) {
    const other = ctx.model.props.find((q) => q.id === inverse);
    if (other) out.push(`InverseObjectProperties(<${iri}> <${propIriOf(ctx.model, other)}>)`);
  }
  if (p.chars.includes('functional')) out.push(`FunctionalObjectProperty(<${iri}>)`);
  return out;
}

/** Every named class an expression names as its filler, where it is one. */
const classOf = (e: ClassExpression | undefined): string | undefined => (e?.type === 'Class' ? e.iri : undefined);

// ---------------------------------------------------------------- scope and its edges

function chosenClasses(model: Model, config: TransformationConfig): string[] {
  const classes = model.terms.filter((t) => t.type === 'concept' && (!t.external || config.scope.withImports));
  const byIri = new Map(classes.map((t) => [termIri(model, t), t]));
  const below = new Map<string, string[]>();
  const add = (sub: string, sup: string) => {
    if (!byIri.has(sub) || !byIri.has(sup) || sub === sup) return;
    const list = below.get(sup) ?? [];
    if (!list.includes(sub)) list.push(sub);
    below.set(sup, list);
  };
  for (const t of classes) {
    const iri = termIri(model, t);
    for (const a of t.classAxioms ?? []) if (a.kind === 'SubClassOf' && a.expression.type === 'Class') add(iri, a.expression.iri);
  }
  for (const r of model.relations) {
    if (r.kind !== 'generalization') continue;
    const sub = model.terms.find((t) => t.id === r.from);
    const sup = model.terms.find((t) => t.id === r.to);
    if (sub && sup) add(termIri(model, sub), termIri(model, sup));
  }
  if (config.scope.kind === 'all') return [...byIri.keys()].sort();
  const roots = config.scope.classes.filter((iri) => byIri.has(iri));
  if (config.scope.kind === 'classes') return [...new Set(roots)].sort();
  const out = new Set<string>();
  const todo = [...roots];
  while (todo.length) {
    const iri = todo.shift()!;
    if (out.has(iri)) continue;
    out.add(iri);
    todo.push(...(below.get(iri) ?? []));
  }
  return [...out].sort();
}

interface Hierarchy {
  /** The class IRI each class directly specialises, where it is in scope. */
  supers: Map<string, string[]>;
  /** The direct subclasses of each class, in scope. */
  subs: Map<string, string[]>;
}

function hierarchyOf(ctx: ModelContext, scope: Set<string>): Hierarchy {
  const supers = new Map<string, string[]>();
  const subs = new Map<string, string[]>();
  const add = (sub: string, sup: string) => {
    if (sub === sup || !scope.has(sub) || !scope.has(sup)) return;
    const s = supers.get(sub) ?? [];
    if (!s.includes(sup)) s.push(sup);
    supers.set(sub, s);
    const b = subs.get(sup) ?? [];
    if (!b.includes(sub)) b.push(sub);
    subs.set(sup, b);
  };
  for (const iri of scope) {
    const t = ctx.model.terms.find((x) => termIri(ctx.model, x) === iri);
    for (const a of t?.classAxioms ?? []) if (a.kind === 'SubClassOf' && a.expression.type === 'Class') add(iri, a.expression.iri);
  }
  for (const r of ctx.model.relations) {
    if (r.kind !== 'generalization') continue;
    const sub = ctx.model.terms.find((t) => t.id === r.from);
    const sup = ctx.model.terms.find((t) => t.id === r.to);
    if (sub && sup) add(termIri(ctx.model, sub), termIri(ctx.model, sup));
  }
  return { supers, subs };
}

/** The topmost class an entity is rolled up into: itself when it specialises nothing in scope. */
function topOf(iri: string, supers: Map<string, string[]>): string {
  const seen = new Set<string>();
  let current = iri;
  while (!seen.has(current)) {
    seen.add(current);
    const next = supers.get(current)?.[0];
    if (!next) return current;
    current = next;
  }
  return iri;
}

// ---------------------------------------------------------------- types

/** The full IRI of a datatype written with the standard prefixes, as enumerated datatypes keep theirs. */
const expandTypeIri = (dt: string): string => {
  if (dt.startsWith('xsd:')) return XSD + dt.slice(4);
  if (dt.startsWith('rdf:')) return 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' + dt.slice(4);
  return dt;
};

/** What reading a type needs: the configuration, and the domains enumerated datatypes were made into. */
interface TypeContext {
  config: TransformationConfig;
  domainByEnum: Map<string, string>;
}

function baseTypeOf(ctx: Pick<TypeContext, 'config'>, iri: string): { base: BaseType; note?: string } {
  const full = expandTypeIri(iri);
  const chosen = ctx.config.datatypes[iri] ?? ctx.config.datatypes[full] ?? DEFAULT_DATATYPES[full];
  if (chosen) return { base: chosen === 'text' ? { base: 'text' } : { base: chosen as Exclude<BaseTypeName, 'text'> } };
  return { base: { base: 'text' }, note: `no logical type is known for <${full}>; text is proposed` };
}

/** The logical type of a data property's range, and what to say where the mapping is not exact. */
function logicalTypeOf(ctx: TypeContext, range: DataRange | undefined): { type: LogicalType; note?: string } {
  if (!range) return { type: { base: 'text' }, note: 'it has no range; text is proposed' };
  switch (range.type) {
    case 'Datatype': {
      const { base, note } = baseTypeOf(ctx, range.iri);
      return { type: base, ...(note ? { note } : {}) };
    }
    case 'Enumeration': {
      const domain = ctx.domainByEnum.get('id:' + range.datatype);
      return domain ? { type: { domain } } : { type: { base: 'text' }, note: 'its enumerated datatype is not in the LDM; text is proposed' };
    }
    case 'DataOneOf': {
      const dts = [...new Set(range.literals.map((l) => l.datatype).filter((x): x is string => !!x))];
      if (dts.length === 1) return { type: baseTypeOf(ctx, dts[0]).base };
      return { type: { base: 'text' }, note: 'it lists its values; an LDM domain would state them' };
    }
    case 'DatatypeRestriction': {
      const { base } = baseTypeOf(ctx, range.datatype);
      const length = range.facets.find((f) => f.facet === XSD + 'maxLength');
      const maxLength = length ? Number(length.value.value) : undefined;
      if (base.base === 'text' && Number.isInteger(maxLength) && maxLength! > 0) return { type: { base: 'text', maxLength }, note: 'a maximum length in OWL becomes a length on the attribute' };
      return { type: base, note: 'the facets of the datatype are not an LDM constraint; a rule could state them' };
    }
    case 'DataIntersectionOf':
    case 'DataUnionOf':
    case 'DataComplementOf':
      return { type: { base: 'text' }, note: 'a compound data range has no exact LDM type; text is proposed' };
    case 'Unparsed':
      return { type: { base: 'text' }, note: 'the range was kept as Turtle and is not read; text is proposed' };
  }
}

// ---------------------------------------------------------------- object property ends

interface Ends {
  domains: string[];
  ranges: string[];
}

function namedClasses(axioms: ClassAxiom[] | undefined): string[] {
  return [...new Set((axioms ?? []).flatMap((a) => (a.expression.type === 'Class' ? [a.expression.iri] : [])))];
}

function objectEnds(ctx: ModelContext, p: ObjProp): Ends {
  let domains = namedClasses(p.domains);
  let ranges = namedClasses(p.ranges);
  const uses = ctx.model.relations.filter((r) => r.kind === 'association' && (r.prop === p.id || (!r.prop && r.label === p.name)));
  if (!domains.length) domains = [...new Set(uses.flatMap((r) => (ctx.model.terms.find((t) => t.id === r.from) ? [termIri(ctx.model, ctx.model.terms.find((t) => t.id === r.from)!)] : [])))];
  if (!ranges.length) ranges = [...new Set(uses.flatMap((r) => (ctx.model.terms.find((t) => t.id === r.to) ? [termIri(ctx.model, ctx.model.terms.find((t) => t.id === r.to)!)] : [])))];
  return { domains, ranges };
}

// ---------------------------------------------------------------- candidate constraints

interface Restriction {
  classIri: string;
  propIri: string;
  otherIri?: string;
  quantifier: 'some' | 'only' | 'min' | 'max' | 'exactly';
  n?: number;
  axiom: string;
  sourceIri: string;
}

function restrictionOf(ctx: Context, classIri: string, a: ClassExpressionAxiom): Restriction | undefined {
  const e = a.expression;
  const axiom = classAxiomText(ctx, classIri, a);
  if (e.type === 'ObjectSomeValuesFrom' || e.type === 'ObjectAllValuesFrom') {
    return { classIri, propIri: namedProperty(e.property), otherIri: classOf(e.filler), quantifier: e.type === 'ObjectSomeValuesFrom' ? 'some' : 'only', axiom, sourceIri: classIri };
  }
  if (e.type === 'ObjectMinCardinality' || e.type === 'ObjectMaxCardinality' || e.type === 'ObjectExactCardinality') {
    return { classIri, propIri: namedProperty(e.property), ...(e.filler ? { otherIri: classOf(e.filler) } : {}), quantifier: e.type === 'ObjectMinCardinality' ? 'min' : e.type === 'ObjectMaxCardinality' ? 'max' : 'exactly', n: e.n, axiom, sourceIri: classIri };
  }
  if (e.type === 'DataSomeValuesFrom' || e.type === 'DataAllValuesFrom') {
    return { classIri, propIri: e.property.iri, quantifier: e.type === 'DataSomeValuesFrom' ? 'some' : 'only', axiom, sourceIri: classIri };
  }
  if (e.type === 'DataMinCardinality' || e.type === 'DataMaxCardinality' || e.type === 'DataExactCardinality') {
    return { classIri, propIri: e.property.iri, quantifier: e.type === 'DataMinCardinality' ? 'min' : e.type === 'DataMaxCardinality' ? 'max' : 'exactly', n: e.n, axiom, sourceIri: classIri };
  }
  return undefined;
}

/** Restrictions drawn as relationships (a relation's quantifier), which are axioms too. */
function drawnRestrictions(ctx: Context, scope: Set<string>): Restriction[] {
  const out: Restriction[] = [];
  for (const r of ctx.model.relations) {
    if (r.kind === 'property' || r.kind === 'generalization') continue;
    const from = ctx.model.terms.find((t) => t.id === r.from);
    const to = ctx.model.terms.find((t) => t.id === r.to);
    if (!from || !to) continue;
    const classIri = termIri(ctx.model, from);
    if (!scope.has(classIri)) continue;
    const prop = r.prop ? ctx.model.props.find((p) => p.id === r.prop) : ctx.model.props.find((p) => p.name === r.label);
    if (!prop) continue;
    const propIri = propIriOf(ctx.model, prop);
    const otherIri = termIri(ctx.model, to);
    const specs = [...(r.restriction ? [{ restriction: r.restriction, ...(r.restrictionN !== undefined ? { restrictionN: r.restrictionN } : {}) }] : []), ...(r.more ?? [])];
    for (const spec of specs) {
      const quantifier: Restriction['quantifier'] = spec.restriction === 'only' ? 'only' : spec.restriction === 'min' ? 'min' : spec.restriction === 'max' ? 'max' : spec.restriction === 'exactly' ? 'exactly' : 'some';
      const fn = quantifier === 'some' ? 'ObjectSomeValuesFrom' : quantifier === 'only' ? 'ObjectAllValuesFrom' : quantifier === 'min' ? 'ObjectMinCardinality' : quantifier === 'max' ? 'ObjectMaxCardinality' : 'ObjectExactCardinality';
      const n = spec.restrictionN;
      const axiom = `SubClassOf(<${classIri}> ${fn}(<${propIri}>${n !== undefined ? ` ${n}` : ''} <${otherIri}>))`;
      out.push({ classIri, propIri, otherIri, quantifier, ...(n !== undefined ? { n } : {}), axiom, sourceIri: classIri });
    }
  }
  return out;
}

interface HasKeyStatement {
  classIri: string;
  properties: string[];
  axiom: string;
}

/** The owl:hasKey statements the reader kept as they were (Model.unmapped), read as keys. */
export function hasKeyStatements(model: Model): HasKeyStatement[] {
  if (!model.unmapped) return [];
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  let statements;
  try {
    statements = statementsOf(model.unmapped);
  } catch {
    return [];
  }
  const out: HasKeyStatement[] = [];
  for (const statement of statements) {
    const hasKey = statement.quads.find((q) => q.predicate.value === OWL + 'hasKey' && q.subject.termType === 'NamedNode');
    if (!hasKey) continue;
    const firsts = new Map<string, string>();
    const rests = new Map<string, string>();
    for (const q of statement.quads) {
      if (q.subject.termType !== 'BlankNode') continue;
      if (q.predicate.value === RDF + 'first' && q.object.termType === 'NamedNode') firsts.set(q.subject.value, q.object.value);
      if (q.predicate.value === RDF + 'rest' && (q.object.termType === 'BlankNode' || q.object.value === RDF + 'nil')) rests.set(q.subject.value, q.object.value === RDF + 'nil' ? '' : q.object.value);
    }
    if (hasKey.object.termType !== 'BlankNode') continue;
    const properties: string[] = [];
    for (let cell: string | undefined = hasKey.object.value; cell; ) {
      const first = firsts.get(cell);
      if (!first) break;
      properties.push(first);
      cell = rests.get(cell);
    }
    if (!properties.length) continue;
    out.push({ classIri: hasKey.subject.value, properties, axiom: `HasKey(<${hasKey.subject.value}> (${properties.map((p) => `<${p}>`).join(' ')}))` });
  }
  return out;
}

// ---------------------------------------------------------------- the engine

export interface ProposalInput {
  model: Model;
  target: LogicalModel;
  config: TransformationConfig;
  origin: TransformationResult['origin'];
}

export function proposalsFor(input: ProposalInput): TransformationResult {
  const { model, target, config, origin } = input;
  const classList = chosenClasses(model, config);
  const scope = new Set(classList);
  const ctx: Context = {
    model,
    config,
    origin,
    at: Date.now(),
    working: clone(target),
    proposals: [],
    skipped: [],
    entityByClass: new Map(),
    entityProposal: new Map(),
    domainByEnum: new Map(),
    relationshipByProp: new Map(),
    relationshipProposal: new Map(),
    attributeByProp: new Map(),
    attributeProposal: new Map(),
    entityNames: new Set(target.entities.map((e) => e.name.toLowerCase())),
    domainNames: new Set(target.domains.map((d) => d.name.toLowerCase())),
    sourceMapped: sourceMap(target),
  };

  const classByIri = new Map(model.terms.filter((t) => t.type === 'concept').map((t) => [termIri(model, t), t]));
  const name = (raw: string, iri: string | undefined, singular: boolean) => nameFor(raw, iri, config.naming, singular);

  // What the LDM already has from earlier derivations, by source IRI: those are not proposed again.
  for (const [iri, targets] of ctx.sourceMapped) {
    for (const ref of targets) {
      if (!refExists(ctx.working, ref)) continue;
      if (keyOfRef(ref) === 'entity') {
        const t = model.terms.find((x) => termIri(model, x) === iri);
        if (t?.type === 'concept') ctx.entityByClass.set(iri, idOfRef(ref));
      } else if (keyOfRef(ref) === 'domain') {
        const d = model.datatypes.find((x) => enumIriOf(model, x) === iri);
        if (d) ctx.domainByEnum.set('id:' + d.id, idOfRef(ref));
        if (classByIri.get(iri)?.oneOf) ctx.domainByEnum.set(iri, idOfRef(ref));
      } else if (keyOfRef(ref) === 'relationship') {
        const p = model.props.find((x) => propIriOf(model, x) === iri);
        if (p) ctx.relationshipByProp.set(iri, idOfRef(ref));
      } else if (keyOfRef(ref) === 'attribute') {
        // Attributes are matched by the property they came from and the entity they sit on.
        const owner = ctx.working.entities.find((e) => e.attributes.some((a) => a.id === idOfRef(ref)));
        if (owner) ctx.attributeByProp.set(`${iri}|${owner.id}`, idOfRef(ref));
      } else if (keyOfRef(ref) === 'generalization') {
        // Generalizations are matched by their supertype below.
      }
    }
  }

  const hierarchy = hierarchyOf(ctx, scope);

  // ------------------------------------------------------------ domains: enumerations
  for (const d of model.datatypes) {
    const iri = enumIriOf(model, d);
    const mapped = ctx.domainByEnum.get('id:' + d.id);
    if (mapped && refExists(ctx.working, { domain: mapped })) {
      ctx.skipped.push({ iri, name: d.name, reason: 'already represented by a domain' });
      continue;
    }
    const baseName = d.values.map((v) => v.dt).find((x): x is string => !!x);
    const { base } = baseName ? baseTypeOf(ctx, baseName) : { base: { base: 'text' } as BaseType };
    const domain: LogicalDomain = {
      id: newId('d'),
      name: freeName(name(d.name, iri, true), ctx.domainNames),
      definition: config.definitions ? d.description : '',
      base,
      constraints: d.values.length ? { values: d.values.map((v) => ({ code: v.value, label: v.value })) } : {},
    };
    const range: DataRange = { type: 'DataOneOf', literals: d.values.map((v) => ({ value: v.value, ...(v.dt ? { datatype: expandTypeIri(v.dt) } : {}), ...(v.lang ? { lang: v.lang } : {}) })) };
    const sources = [{ iri, label: d.name, axioms: [`Declaration(Datatype(<${iri}>))`, `DatatypeDefinition(<${iri}> ${syntaxOf(ctx, range)})`] }];
    const strategy = 'enumerated datatype → domain';
    const rationale = `The ontology defines ${d.name || iri} by listing its values; an LDM domain holds that list for every attribute typed by it.`;
    const difference = 'A datatype in OWL is a set of literals; an LDM domain is a named, reusable type for attributes. The values are proposed as the domain’s list, which the user may change.';
    const m = mapping(ctx, sources, [{ domain: domain.id }], strategy, rationale, { domain });
    propose(ctx, { kind: 'domain', title: `Domain from the enumerated datatype ${d.name || localPart(iri)}`, sources, elements: [`Domain ${domain.name}`], changes: [{ op: 'add', element: { kind: 'domain', domain } }, { op: 'add', element: { kind: 'mapping', mapping: m } }], strategy, rationale, difference, requires: [], candidate: false });
    ctx.domainByEnum.set('id:' + d.id, domain.id);
    ctx.domainByEnum.set(iri, domain.id);
  }

  for (const iri of [...scope].sort()) {
    const t = classByIri.get(iri);
    if (!t?.oneOf) continue;
    const mapped = ctx.domainByEnum.get(iri);
    if (mapped && refExists(ctx.working, { domain: mapped })) {
      ctx.skipped.push({ iri, name: t.name, reason: 'already represented by a domain' });
      continue;
    }
    const values = t.oneOf.map((id) => model.terms.find((x) => x.id === id)?.name || id);
    const domain: LogicalDomain = {
      id: newId('d'),
      name: freeName(name(t.name, iri, true), ctx.domainNames),
      definition: config.definitions ? t.description : '',
      base: { base: 'text' },
      constraints: { values: values.map((v) => ({ code: v, label: v })) },
    };
    const individuals = t.oneOf.map((member) => {
      const x = model.terms.find((y) => y.id === member);
      return x ? termIri(model, x) : member;
    });
    const sources = [{ iri, label: t.name, axioms: [`Declaration(Class(<${iri}>))`, `EquivalentClasses(<${iri}> ObjectOneOf(${individuals.map((i) => `<${i}>`).join(' ')}))`] }];
    const strategy = 'enumerated class → domain';
    const rationale = `The ontology defines ${t.name || iri} by listing its members; the LDM keeps the list as a domain of values.`;
    const difference = 'Members of an OWL class are individuals, each with an identity; the values of an LDM domain are codes. The members become codes, which the user may rename.';
    const m = mapping(ctx, sources, [{ domain: domain.id }], strategy, rationale, { domain });
    propose(ctx, { kind: 'domain', title: `Domain from the enumerated class ${t.name || localPart(iri)}`, sources, elements: [`Domain ${domain.name}`], changes: [{ op: 'add', element: { kind: 'domain', domain } }, { op: 'add', element: { kind: 'mapping', mapping: m } }], strategy, rationale, difference, requires: [], candidate: false });
    ctx.domainByEnum.set(iri, domain.id);
  }

  // ------------------------------------------------------------ entities
  const rolled = new Map<string, string[]>(); // top class IRI → classes rolled into it
  if (config.hierarchy === 'rollup') {
    for (const iri of [...scope].sort()) {
      if (classByIri.get(iri)?.oneOf) continue;
      const top = topOf(iri, hierarchy.supers);
      const list = rolled.get(top) ?? [];
      list.push(iri);
      rolled.set(top, list);
    }
  }
  const entityGroups = config.hierarchy === 'rollup' ? [...rolled.entries()].sort(([a], [b]) => a.localeCompare(b)) : [...scope].sort().map((iri) => [iri, [iri]] as [string, string[]]);
  for (const [top, members] of entityGroups) {
    const lead = classByIri.get(top);
    if (!lead || lead.oneOf) continue;
    const existing = ctx.entityByClass.get(top);
    if (existing && refExists(ctx.working, { entity: existing })) {
      for (const member of members) ctx.entityByClass.set(member, existing);
      ctx.skipped.push({ iri: top, name: lead.name, reason: 'already represented by an entity' });
      continue;
    }
    const entity: LogicalEntity = {
      id: newId('e'),
      name: freeName(name(lead.name, top, true), ctx.entityNames),
      definition: config.definitions ? lead.description : '',
      attributes: [],
      keys: [],
    };
    const sources: ProposalSource[] = [];
    for (const member of members) {
      const t = classByIri.get(member)!;
      const memberIri = termIri(model, t);
      sources.push({ iri: memberIri, label: t.name, axioms: [`Declaration(Class(<${memberIri}>))`, ...(t.classAxioms ?? []).map((a) => classAxiomText(ctx, memberIri, a))] });
    }
    const strategy = config.hierarchy === 'rollup' && members.length > 1 ? 'subclass hierarchy rolled up into one entity' : 'class → entity';
    const rationale = members.length > 1 ? `${members.map((m) => classByIri.get(m)?.name || localPart(m)).join(', ')} are all kinds of ${lead.name || localPart(top)}; rolling them up keeps one entity, as the configuration asks.` : `The class ${lead.name || localPart(top)} is in scope and no entity in this LDM was made from it.`;
    const difference = 'An OWL class is a set of individuals under the open world, and may overlap others; an LDM entity is a table of rows with an identity of its own. Making one entity does not say that no other entity may hold the same things.';
    const changes: LogicalChange[] = [];
    let discriminator: LogicalAttribute | undefined;
    if (members.length > 1) {
      const used = new Set(entity.attributes.map((a) => a.name.toLowerCase()));
      discriminator = { id: newId('a'), name: freeName('type', used), definition: `Which kind of ${entity.name}.`, type: { base: 'text' }, optional: true };
      entity.attributes.push(discriminator);
    }
    changes.push({ op: 'add', element: { kind: 'entity', entity } });
    const m = mapping(ctx, sources, [{ entity: entity.id }], strategy, rationale, { entity });
    changes.push({ op: 'add', element: { kind: 'mapping', mapping: m } });
    const proposal = propose(ctx, { kind: 'entity', title: members.length > 1 ? `Entity from the rolled-up hierarchy of ${lead.name || localPart(top)}` : `Entity from the class ${lead.name || localPart(top)}`, sources, elements: [`Entity ${entity.name}`], changes, strategy, rationale, difference, requires: [], candidate: false });
    for (const member of members) {
      ctx.entityByClass.set(member, entity.id);
      ctx.entityProposal.set(member, proposal.id);
    }
  }

  // ------------------------------------------------------------ attributes from data properties
  const dataProps = model.terms.filter((t) => t.type === 'property' && (!t.external || config.scope.withImports));
  for (const t of dataProps) {
    const iri = termIri(model, t);
    const domains = (t.domains ?? []).flatMap((a) => (a.expression.type === 'Class' ? [a.expression.iri] : []));
    const attached = domains.length ? domains : model.relations.filter((r) => r.kind === 'property' && r.to === t.id).map((r) => model.terms.find((x) => x.id === r.from)).filter((x): x is Term => !!x).map((x) => termIri(model, x));
    const inScope = [...new Set(attached)].filter((d) => scope.has(d) && ctx.entityByClass.has(d));
    if (!attached.length) {
      ctx.skipped.push({ iri, name: t.name, reason: 'it is attached to no class, so there is no entity to put an attribute on' });
      continue;
    }
    if (!inScope.length) {
      ctx.skipped.push({ iri, name: t.name, reason: 'its class is not in scope' });
      continue;
    }
    const mapped = ctx.sourceMapped.get(iri)?.find((r) => keyOfRef(r) === 'attribute' && refExists(ctx.working, r));
    const { type, note } = logicalTypeOf(ctx, t.ranges?.[0]?.range);
    const axioms = [`Declaration(DataProperty(<${iri}>))`, ...dataRangeAxioms(ctx, t).domains, ...dataRangeAxioms(ctx, t).ranges];
    const sources = [{ iri, label: t.name, axioms }];
    for (const domainIri of inScope) {
      const entityId = ctx.entityByClass.get(domainIri)!;
      if (mapped) {
        ctx.skipped.push({ iri, name: t.name, reason: 'already represented by an attribute' });
        break;
      }
      const entity = ctx.working.entities.find((e) => e.id === entityId)!;
      const attribute: LogicalAttribute = { id: newId('a'), name: freeName(name(t.name, iri, false), attributeNames(ctx, entityId)), definition: config.definitions ? t.description : '', type, optional: true };
      const strategy = 'data property → attribute';
      const rationale = `The ontology gives ${classByIri.get(domainIri)?.name || localPart(domainIri)} the data property ${t.name || localPart(iri)}${note ? `; ${note}` : ''}.`;
      const difference = 'A datatype property may have no value, or several, in OWL; an LDM attribute holds one value and is optional until the user makes it mandatory (NFR-18).';
      const m = mapping(ctx, sources, [{ attribute: attribute.id }], strategy, rationale, { attribute });
      const proposal = propose(ctx, {
        kind: 'attribute',
        title: `Attribute ${attribute.name} on ${entity.name}`,
        sources,
        elements: [`Attribute ${entity.name}.${attribute.name}`],
        changes: [{ op: 'add', element: { kind: 'attribute', entity: entityId, attribute } }, { op: 'add', element: { kind: 'mapping', mapping: m } }],
        strategy,
        rationale,
        difference,
        requires: ctx.entityProposal.has(domainIri) ? [ctx.entityProposal.get(domainIri)!] : [],
        candidate: false,
      });
      ctx.attributeByProp.set(`${iri}|${entityId}`, attribute.id);
      ctx.attributeProposal.set(attribute.id, proposal.id);
    }
  }

  // ------------------------------------------------------------ relationships from object properties
  const handled = new Set<string>();
  for (const p of model.props) {
    if (p.external && !config.scope.withImports) continue;
    if (handled.has(p.id)) continue;
    const iri = propIriOf(model, p);
    let inverse = p.inverses?.map((id) => model.props.find((q) => q.id === id)).find((q): q is ObjProp => !!q && !q.external);
    if (inverse?.id === p.id) inverse = undefined;
    handled.add(p.id);
    if (inverse) handled.add(inverse.id);
    const mappedRel = ctx.relationshipByProp.get(iri) ?? (inverse ? ctx.relationshipByProp.get(propIriOf(model, inverse)) : undefined);
    if (mappedRel && refExists(ctx.working, { relationship: mappedRel })) {
      ctx.skipped.push({ iri, name: p.name, reason: 'already represented by a relationship' });
      continue;
    }
    let ends = objectEnds(ctx, p);
    if ((!ends.domains.length || !ends.ranges.length) && inverse) {
      const back = objectEnds(ctx, inverse);
      if (!ends.domains.length) ends = { ...ends, domains: back.ranges };
      if (!ends.ranges.length) ends = { ...ends, ranges: back.domains };
    }
    if (!ends.domains.length || !ends.ranges.length) {
      ctx.skipped.push({ iri, name: p.name, reason: 'no class is stated at one of its ends' });
      continue;
    }
    const pairs = ends.domains.flatMap((d) => ends.ranges.map((r) => [d, r] as const)).filter(([d, r]) => ctx.entityByClass.has(d) && ctx.entityByClass.has(r));
    if (!pairs.length) {
      ctx.skipped.push({ iri, name: p.name, reason: 'the classes at its ends are not in scope' });
      continue;
    }
    const sources = [{ iri, label: p.name, axioms: objectAxioms(ctx, p) }, ...(inverse ? [{ iri: propIriOf(model, inverse), label: inverse.name, axioms: objectAxioms(ctx, inverse) }] : [])];
    const verb = inverse ? `the inverse pair ${p.name} / ${inverse.name}` : `the object property ${p.name || localPart(iri)}`;
    for (const [domainIri, rangeIri] of pairs) {
      const domainId = ctx.entityByClass.get(domainIri)!;
      const rangeId = ctx.entityByClass.get(rangeIri)!;
      const domainName = ctx.working.entities.find((e) => e.id === domainId)!.name;
      const rangeName = ctx.working.entities.find((e) => e.id === rangeId)!.name;
      const functional = p.chars.includes('functional');
      const inverseFunctional = !!inverse?.chars.includes('functional');
      const endsMade: [RelationshipEnd, RelationshipEnd] = [
        { entity: domainId, role: inverse?.name ?? '', min: 0, max: inverseFunctional ? 1 : 'many' },
        { entity: rangeId, role: p.name, min: 0, max: functional ? 1 : 'many' },
      ];
      const bothMany = endsMade[0].max === 'many' && endsMade[1].max === 'many';
      const requires = [domainIri, rangeIri].filter((x) => ctx.entityProposal.has(x)).map((x) => ctx.entityProposal.get(x)!);
      if (config.objectProperties === 'associative' && bothMany) {
        const entityName = freeName(name(p.name, iri, true), ctx.entityNames);
        const entityId = newId('e');
        const firstId = newId('r');
        const secondId = newId('r');
        const key: Key = { id: newId('k'), kind: 'primary', name: 'Primary key', members: [{ end: { relationship: firstId, end: 1 } }, { end: { relationship: secondId, end: 1 } }] };
        const entity: LogicalEntity = { id: entityId, name: entityName, definition: config.definitions ? p.description : '', attributes: [], keys: [key] };
        const first: Relationship = { id: firstId, name: freeName(`${entityName} of ${domainName}`, relationshipNames(ctx)), definition: '', ends: [{ entity: entityId, role: '', min: 0, max: 'many' }, { entity: domainId, role: endsMade[0].role, min: 1, max: 1 }], identifying: true };
        const second: Relationship = { id: secondId, name: freeName(`${entityName} of ${rangeName}`, relationshipNames(ctx, first.name)), definition: '', ends: [{ entity: entityId, role: '', min: 0, max: 'many' }, { entity: rangeId, role: endsMade[1].role, min: 1, max: 1 }], identifying: true };
        const strategy = 'object property → associative entity (many at both ends)';
        const rationale = `${verb} may relate many ${domainName} to many ${rangeName}; the configuration resolves that with an entity of its own.`;
        const difference = 'OWL says nothing that forbids many-to-many; an associative entity is an LDM decision, and its identifying relationships require both ends, which an ontology assertion does not.';
        const m = mapping(ctx, sources, [{ entity: entityId }], strategy, rationale, { entity });
        const proposal = propose(ctx, {
          kind: 'relationship',
          title: `Associative entity ${entityName} from ${verb}`,
          sources,
          elements: [`Entity ${entityName}`, `Relationship ${first.name}`, `Relationship ${second.name}`],
          changes: [
            { op: 'add', element: { kind: 'entity', entity } },
            { op: 'add', element: { kind: 'relationship', relationship: first } },
            { op: 'add', element: { kind: 'relationship', relationship: second } },
            { op: 'add', element: { kind: 'mapping', mapping: m } },
          ],
          strategy,
          rationale,
          difference,
          requires,
          candidate: false,
        });
        ctx.relationshipByProp.set(iri, entityId);
        ctx.relationshipProposal.set(first.id, proposal.id);
        ctx.relationshipProposal.set(second.id, proposal.id);
        continue;
      }
      const relationship: Relationship = { id: newId('r'), name: freeName(inverse ? `${p.name} / ${inverse.name}` : p.name, relationshipNames(ctx)), definition: config.definitions ? p.description : '', ends: endsMade, identifying: false };
      const functionalNote = functional ? ' It is functional, so at most one value is proposed at its end.' : inverseFunctional ? ' Its inverse is functional, so at most one is proposed at the other end.' : '';
      const strategy = inverse ? 'inverse property pair → one relationship with two roles' : 'object property → relationship';
      const rationale = `${verb} relates ${domainName} and ${rangeName}.${functionalNote}`;
      const difference = 'An object property asserts a link under the open world, with no unique names and no required end; an LDM relationship states what rows may be linked, with both ends optional until the user chooses otherwise (NFR-18).';
      const m = mapping(ctx, sources, [{ relationship: relationship.id }], strategy, rationale, { relationship });
      const proposal = propose(ctx, {
        kind: 'relationship',
        title: `Relationship ${relationship.name} between ${domainName} and ${rangeName}`,
        sources,
        elements: [`Relationship ${relationship.name}`],
        changes: [{ op: 'add', element: { kind: 'relationship', relationship } }, { op: 'add', element: { kind: 'mapping', mapping: m } }],
        strategy,
        rationale,
        difference,
        requires,
        candidate: false,
      });
      ctx.relationshipByProp.set(iri, relationship.id);
      if (inverse) ctx.relationshipByProp.set(propIriOf(model, inverse), relationship.id);
      ctx.relationshipProposal.set(relationship.id, proposal.id);
    }
  }

  // ------------------------------------------------------------ specializations, or rolled down attributes
  if (config.hierarchy === 'specialization') {
    for (const [superIri, subs] of [...hierarchy.subs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const superId = ctx.entityByClass.get(superIri);
      const subIds = subs.map((s) => ctx.entityByClass.get(s)).filter((x): x is string => !!x);
      if (!superId || subIds.length !== subs.length) continue;
      if (ctx.working.generalizations.some((g) => g.supertype === superId)) {
        ctx.skipped.push({ iri: superIri, name: classByIri.get(superIri)?.name ?? '', reason: 'a specialization of it is already in the LDM' });
        continue;
      }
      const generalization = { id: newId('g'), supertype: superId, subtypes: [...new Set(subIds)], complete: false, exclusive: false };
      const superName = ctx.working.entities.find((e) => e.id === superId)!.name;
      const subNames = generalization.subtypes.map((id) => ctx.working.entities.find((e) => e.id === id)!.name);
      const sources = [{ iri: superIri, label: classByIri.get(superIri)?.name ?? '', axioms: [`Declaration(Class(<${superIri}>))`, ...subs.map((s) => `SubClassOf(<${s}> <${superIri}>)`)] }];
      const strategy = 'subclass hierarchy → specialization';
      const rationale = `${subNames.join(', ')} ${subNames.length === 1 ? 'is' : 'are'} stated to be a kind of ${superName}; a generalization keeps that, neither complete nor exclusive, until the user says so.`;
      const difference = 'OWL subsumption is open and may have several superclasses; an LDM specialization is a structural choice, and the flags for complete and exclusive are left off because the ontology does not say either.';
      const m = mapping(ctx, sources, [{ generalization: generalization.id }], strategy, rationale, { generalization });
      const requires = [superIri, ...subs].filter((x) => ctx.entityProposal.has(x)).map((x) => ctx.entityProposal.get(x)!);
      propose(ctx, { kind: 'specialization', title: `Specialization of ${superName}: ${subNames.join(', ')}`, sources, elements: [`Generalization of ${superName}`], changes: [{ op: 'add', element: { kind: 'generalization', generalization } }, { op: 'add', element: { kind: 'mapping', mapping: m } }], strategy, rationale, difference, requires, candidate: false });
    }
  } else if (config.hierarchy === 'rolldown') {
    // Each subclass keeps its own entity, with the attributes it would inherit copied into it.
    for (const [subIri, supers] of [...hierarchy.supers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const entityId = ctx.entityByClass.get(subIri);
      if (!entityId) continue;
      for (const superIri of supers) {
        const superId = ctx.entityByClass.get(superIri);
        const parent = superId ? ctx.working.entities.find((e) => e.id === superId) : undefined;
        if (!parent) continue;
        for (const source of parent.attributes) {
          const entity = ctx.working.entities.find((e) => e.id === entityId);
          if (!entity) continue;
          const used = attributeNames(ctx, entityId);
          const attribute: LogicalAttribute = { ...source, id: newId('a'), name: freeName(source.name, used) };
          const sources = [{ iri: subIri, label: classByIri.get(subIri)?.name ?? '', axioms: [`SubClassOf(<${subIri}> <${superIri}>)`] }];
          const strategy = 'inherited attribute rolled down to the subtype';
          const rationale = `The configuration keeps every class an entity of its own, so what ${parent.name} has is copied into ${entity.name} rather than inherited.`;
          const difference = 'In OWL the subtype would have the property by inference; rolling down copies it, so the two attributes are separate and may drift apart.';
          const m = mapping(ctx, sources, [{ attribute: attribute.id }], strategy, rationale, { attribute });
          propose(ctx, { kind: 'attribute', title: `Attribute ${attribute.name} rolled down to ${entity.name}`, sources, elements: [`Attribute ${entity.name}.${attribute.name}`], changes: [{ op: 'add', element: { kind: 'attribute', entity: entityId, attribute } }, { op: 'add', element: { kind: 'mapping', mapping: m } }], strategy, rationale, difference, requires: ctx.entityProposal.has(subIri) ? [ctx.entityProposal.get(subIri)!] : [], candidate: false });
          // The copy is not the source property's own attribute, so it is not remembered for data restrictions.
        }
      }
    }
  }

  // ------------------------------------------------------------ candidate constraints
  const restrictions: Restriction[] = [];
  for (const iri of [...scope].sort()) {
    const t = classByIri.get(iri);
    for (const a of t?.classAxioms ?? []) {
      if (a.kind === 'DisjointClasses') continue;
      const r = restrictionOf(ctx, iri, a);
      if (r) restrictions.push(r);
    }
  }
  restrictions.push(...drawnRestrictions(ctx, scope));

  const proposedConstraint = new Set<string>();
  const constraint = (key: string, p: Omit<TransformationProposal, 'id' | 'kind' | 'candidate'>) => {
    if (proposedConstraint.has(key)) return;
    proposedConstraint.add(key);
    propose(ctx, { ...p, kind: 'constraint', candidate: true });
  };

  for (const r of restrictions) {
    const entityId = ctx.entityByClass.get(r.classIri);
    if (!entityId) continue;
    const isData = model.terms.some((t) => t.type === 'property' && termIri(model, t) === r.propIri);
    if (isData) {
      const attributeId = ctx.attributeByProp.get(`${r.propIri}|${entityId}`);
      const entity = ctx.working.entities.find((e) => e.id === entityId);
      const attribute = attributeId ? entity?.attributes.find((a) => a.id === attributeId) : undefined;
      if (!attribute || !attributeId) {
        ctx.skipped.push({ iri: r.propIri, name: localPart(r.propIri), reason: 'a restriction on it has no attribute to constrain' });
        continue;
      }
      const requires = ctx.attributeProposal.has(attributeId) ? [ctx.attributeProposal.get(attributeId)!] : [];
      const sources = [{ iri: r.sourceIri, label: classByIri.get(r.sourceIri)?.name ?? '', axioms: [r.axiom] }];
      if (r.quantifier === 'some' || r.quantifier === 'min' || r.quantifier === 'exactly') {
        const atLeast = r.quantifier === 'some' ? 1 : (r.n ?? 1);
        if (atLeast >= 1 && attribute.optional) {
          const strategy = 'restriction → candidate mandatory attribute';
          const rationale = `The ontology says every ${classByIri.get(r.classIri)?.name || localPart(r.classIri)} has at least ${atLeast} value of ${localPart(r.propIri)}.`;
          const difference = 'Under the open world that is an inference about every instance, not a requirement a store enforces. Making the attribute mandatory is a closed-world decision the user has to take; in OWL a value may exist without being written in any data.';
          constraint(`mandatory:${attributeId}`, {
            title: `Make the attribute ${attribute.name} of ${entity!.name} mandatory`,
            sources,
            elements: [`Attribute ${entity!.name}.${attribute.name}`],
            changes: [{ op: 'update', target: { attribute: attributeId }, before: { optional: attribute.optional }, after: { optional: false } }],
            strategy,
            rationale,
            difference,
            requires,
          });
        }
        if (r.quantifier === 'exactly' && (r.n ?? 0) > 1) {
          const rule = { id: newId('b'), name: `${localPart(r.propIri)} is stated ${r.n} times`, statement: `Every ${classByIri.get(r.classIri)?.name || localPart(r.classIri)} is stated to have exactly ${r.n} values of ${localPart(r.propIri)}. An LDM attribute holds one.`, kind: 'constraint' as const, appliesTo: [{ attribute: attributeId }], status: 'proposed' as const };
          const strategy = 'restriction → candidate rule';
          const rationale = 'The LDM has one value per attribute, so the count is stated as a rule for the application to enforce.';
          const difference = 'The count in OWL constrains every interpretation; a business rule in an LDM is a statement for people and the application, not something the model enforces.';
          const m = mapping(ctx, sources, [{ rule: rule.id }], strategy, rationale, { rule });
          constraint(`rule:${attributeId}:${r.axiom}`, { title: `Rule: exactly ${r.n} values of ${localPart(r.propIri)} on ${entity!.name}`, sources, elements: [`Rule ${rule.name}`], changes: [{ op: 'add', element: { kind: 'rule', rule } }, { op: 'add', element: { kind: 'mapping', mapping: m } }], strategy, rationale, difference, requires });
        }
        continue;
      }
      // "only", "max" and compound data ranges are not an LDM constraint: a rule can state them.
      const rule = { id: newId('b'), name: `${localPart(r.propIri)} restrictions`, statement: `${r.axiom}.`, kind: 'constraint' as const, appliesTo: [{ attribute: attributeId }], status: 'proposed' as const };
      const strategy = 'restriction → candidate rule';
      const rationale = `The ontology restricts ${localPart(r.propIri)} in a way an attribute cannot express on its own.`;
      const difference = 'OWL restricts every interpretation; an LDM business rule states the restriction in words for the application to enforce, and is not checked by the model.';
      const m = mapping(ctx, sources, [{ rule: rule.id }], strategy, rationale, { rule });
      constraint(`rule:${attributeId}:${r.axiom}`, { title: `Rule from a restriction on ${localPart(r.propIri)}`, sources, elements: [`Rule ${rule.name}`], changes: [{ op: 'add', element: { kind: 'rule', rule } }, { op: 'add', element: { kind: 'mapping', mapping: m } }], strategy, rationale, difference, requires });
      continue;
    }

    // An object property's restriction: a candidate on the relationship's other end.
    const relationshipId = ctx.relationshipByProp.get(r.propIri);
    const relationship = relationshipId ? ctx.working.relationships.find((x) => x.id === relationshipId) : undefined;
    const otherId = r.otherIri ? ctx.entityByClass.get(r.otherIri) : undefined;
    if (!relationship || !otherId) {
      ctx.skipped.push({ iri: r.propIri, name: localPart(r.propIri), reason: 'a restriction on it has no relationship to constrain' });
      continue;
    }
    const at = relationship.ends.findIndex((e) => e.entity === otherId);
    const mine = relationship.ends.findIndex((e) => e.entity === entityId);
    if (at < 0 || mine < 0) {
      ctx.skipped.push({ iri: r.propIri, name: localPart(r.propIri), reason: 'its relationship does not join the classes the restriction names' });
      continue;
    }
    const requires = ctx.relationshipProposal.has(relationship.id) ? [ctx.relationshipProposal.get(relationship.id)!] : [];
    const sources = [{ iri: r.sourceIri, label: classByIri.get(r.sourceIri)?.name ?? '', axioms: [r.axiom] }];
    const otherName = ctx.working.entities.find((e) => e.id === otherId)!.name;
    const className = ctx.working.entities.find((e) => e.id === entityId)!.name;
    const relName = relationship.name;
    if (r.quantifier === 'only') {
      const rule = { id: newId('b'), name: `${relName} only ${otherName}`, statement: `Every ${className} may be related by ${relName} only to a ${otherName}.`, kind: 'constraint' as const, appliesTo: [{ relationship: relationship.id }], status: 'proposed' as const };
      const strategy = 'restriction → candidate rule';
      const rationale = `The ontology allows only ${otherName} at the other end of ${relName}.`;
      const difference = 'OWL restricts what may be inferred, not what rows a store may hold; the rule states it for the application and the model does not enforce it.';
      const m = mapping(ctx, sources, [{ rule: rule.id }], strategy, rationale, { rule });
      constraint(`rule:${relationship.id}:${r.axiom}`, { title: `Rule: ${relName} only ${otherName}`, sources, elements: [`Rule ${rule.name}`], changes: [{ op: 'add', element: { kind: 'rule', rule } }, { op: 'add', element: { kind: 'mapping', mapping: m } }], strategy, rationale, difference, requires });
      continue;
    }
    const wanted = (() => {
      const ends = relationship.ends.map((e) => ({ ...e }));
      const end = ends[at];
      if (r.quantifier === 'some') end.min = Math.max(end.min, 1);
      else if (r.quantifier === 'min') end.min = Math.max(end.min, r.n ?? end.min);
      else if (r.quantifier === 'max') end.max = Math.max(end.min, r.n ?? 1);
      else {
        end.min = Math.max(end.min, r.n ?? 1);
        end.max = Math.max(end.min, r.n ?? 1);
      }
      return ends;
    })();
    if (JSON.stringify(wanted) === JSON.stringify(relationship.ends)) continue;
    const what = r.quantifier === 'some' || r.quantifier === 'min' ? 'mandatory' : r.quantifier === 'exactly' ? `exactly ${r.n}` : `at most ${r.n ?? 1}`;
    const strategy = `restriction → candidate ${r.quantifier === 'some' ? 'mandatory' : 'cardinality'} on ${relName}`;
    const rationale = `The ontology states ${r.axiom}. On the ${otherName} end of ${relName} that would be ${what}.`;
    const difference = 'In OWL this is a statement about every interpretation, under the open world, and it does not require a value to be stored. In an LDM a minimum makes the end mandatory for every row, so it is only ever a candidate the user decides on; a maximum is a closed-world limit.';
    constraint(`${r.quantifier}:${relationship.id}:${at}:${r.n ?? ''}`, {
      title: `Make the ${otherName} end of ${relName} ${what}`,
      sources,
      elements: [`Relationship ${relName}`],
      changes: [{ op: 'update', target: { relationship: relationship.id }, before: { ends: relationship.ends }, after: { ends: wanted } }],
      strategy,
      rationale,
      difference,
      requires,
    });
  }

  for (const key of hasKeyStatements(model)) {
    const entityId = ctx.entityByClass.get(key.classIri);
    if (!entityId) {
      ctx.skipped.push({ iri: key.classIri, name: localPart(key.classIri), reason: 'it has a key, but no entity was made from it' });
      continue;
    }
    const members = key.properties.map((p) => ctx.attributeByProp.get(`${p}|${entityId}`)).filter((x): x is string => !!x);
    if (members.length !== key.properties.length) {
      ctx.skipped.push({ iri: key.classIri, name: localPart(key.classIri), reason: 'its key names properties that are not attributes of the entity' });
      continue;
    }
    const entity = ctx.working.entities.find((e) => e.id === entityId)!;
    if (entity.keys.some((k) => k.members.length === members.length && members.every((id) => k.members.some((m) => 'attribute' in m && m.attribute === id)))) {
      ctx.skipped.push({ iri: key.classIri, name: localPart(key.classIri), reason: 'a key of those attributes is already in the LDM' });
      continue;
    }
    const used = new Set(entity.keys.map((k) => k.name.toLowerCase()));
    const made: Key = { id: newId('k'), kind: 'candidate', name: freeName('Candidate key', used), members: members.map((attribute) => ({ attribute })) };
    const sources = [{ iri: key.classIri, label: classByIri.get(key.classIri)?.name ?? '', axioms: [key.axiom] }];
    const strategy = 'owl:hasKey → candidate key';
    const rationale = `The ontology states ${key.axiom}. The LDM offers it as a candidate key, never chosen to begin with.`;
    const difference = 'owl:hasKey says those properties identify an individual, but OWL has no unique names, so two different IRIs may still be one thing; an LDM key forbids two rows with the same values. Choosing it is a closed-world decision.';
    constraint(`key:${entityId}:${members.join(',')}`, {
      title: `Candidate key on ${entity.name}: ${members.map((id) => entity.attributes.find((a) => a.id === id)?.name).join(', ')}`,
      sources,
      elements: [`Key ${made.name} of ${entity.name}`],
      changes: [{ op: 'add', element: { kind: 'key', entity: entityId, key: made } }],
      strategy,
      rationale,
      difference,
      requires: members.map((id) => ctx.attributeProposal.get(id)).filter((x): x is string => !!x),
    });
  }

  return {
    model: target.id,
    baseRevision: target.revision,
    config,
    origin,
    scope: { classes: classList },
    proposals: ctx.proposals,
    skipped: ctx.skipped,
    at: ctx.at,
  };
}

/** What the LDM's mappings already say came from which source IRI. */
function sourceMap(m: LogicalModel): Map<string, ElementRef[]> {
  const out = new Map<string, ElementRef[]>();
  for (const map of m.mappings) {
    for (const source of map.sources) out.set(source.iri, [...(out.get(source.iri) ?? []), ...map.targets]);
  }
  return out;
}

/** The attribute names an entity has, its own and what it inherits. */
function attributeNames(ctx: Context, entityId: string): Set<string> {
  const names = new Set<string>();
  const entity = ctx.working.entities.find((e) => e.id === entityId);
  for (const a of entity?.attributes ?? []) names.add(a.name.toLowerCase());
  const seen = new Set<string>([entityId]);
  const todo = ctx.working.generalizations.filter((g) => g.subtypes.includes(entityId)).map((g) => g.supertype);
  while (todo.length) {
    const id = todo.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const parent = ctx.working.entities.find((e) => e.id === id);
    for (const a of parent?.attributes ?? []) names.add(a.name.toLowerCase());
    todo.push(...ctx.working.generalizations.filter((g) => g.subtypes.includes(id)).map((g) => g.supertype));
  }
  return names;
}

function relationshipNames(ctx: Context, extra = ''): Set<string> {
  return new Set([...ctx.working.relationships.map((r) => r.name.toLowerCase()), ...(extra ? [extra.toLowerCase()] : [])]);
}

/** Whether a proposal is one a first run offers chosen to begin with: all structure, no candidate. */
export const chosenByDefault = (p: TransformationProposal): boolean => !p.candidate && p.kind !== 'constraint';

// ---------------------------------------------------------------- reading the ontology again (stage LM-4)

/** The classes a configuration reads, as the transformation does. */
export const scopeClasses = (model: Model, config: TransformationConfig): string[] => chosenClasses(model, config);

/** The direct subclass edges of the classes a configuration reads. */
export const hierarchyFor = (model: Model, config: TransformationConfig): Hierarchy => hierarchyOf({ model }, new Set(chosenClasses(model, config)));

/** The axioms a mapping made from an ontology entity now would record, by its IRI. Undefined when the ontology has no such entity. */
export function sourceAxiomsOf(model: Model, iri: string): string[] | undefined {
  const datatype = model.datatypes.find((d) => enumIriOf(model, d) === iri);
  if (datatype) {
    const range: DataRange = {
      type: 'DataOneOf',
      literals: datatype.values.map((v) => ({ value: v.value, ...(v.dt ? { datatype: expandTypeIri(v.dt) } : {}), ...(v.lang ? { lang: v.lang } : {}) })),
    };
    return [`Declaration(Datatype(<${iri}>))`, `DatatypeDefinition(<${iri}> ${syntaxOf({ model }, range)})`];
  }
  const term = model.terms.find((t) => termIri(model, t) === iri);
  if (term) {
    if (term.type === 'property') return [`Declaration(DataProperty(<${iri}>))`, ...dataRangeAxioms({ model }, term).domains, ...dataRangeAxioms({ model }, term).ranges];
    if (term.type !== 'concept') return undefined;
    if (term.oneOf) {
      const individuals = term.oneOf.map((member) => {
        const x = model.terms.find((y) => y.id === member);
        return x ? termIri(model, x) : member;
      });
      return [`Declaration(Class(<${iri}>))`, `EquivalentClasses(<${iri}> ObjectOneOf(${individuals.map((i) => `<${i}>`).join(' ')}))`];
    }
    return [`Declaration(Class(<${iri}>))`, ...(term.classAxioms ?? []).map((a) => classAxiomText({ model }, iri, a))];
  }
  const prop = model.props.find((p) => propIriOf(model, p) === iri);
  if (prop) return objectAxioms({ model }, prop);
  return undefined;
}

/** What an ontology entity is called now: its label, and what kind of entity it is; nothing when it is gone. */
export function sourceNow(model: Model, iri: string): { name: string; kind: 'class' | 'data property' | 'object property' | 'datatype' } | undefined {
  const datatype = model.datatypes.find((d) => enumIriOf(model, d) === iri);
  if (datatype) return { name: datatype.name, kind: 'datatype' };
  const term = model.terms.find((t) => termIri(model, t) === iri);
  if (term) {
    if (term.type === 'property') return { name: term.name, kind: 'data property' };
    if (term.type === 'concept') return { name: term.name, kind: 'class' };
    return undefined;
  }
  const prop = model.props.find((p) => propIriOf(model, p) === iri);
  if (prop) return { name: prop.name, kind: 'object property' };
  return undefined;
}

/**
 * The type an attribute made from a data property would have now, under the LDM's configuration,
 * with the enumerated datatypes its domains were made from.
 */
export function typeForDataProperty(model: Model, target: LogicalModel, iri: string, config: TransformationConfig): { type: LogicalType; note?: string } | undefined {
  const term = model.terms.find((t) => t.type === 'property' && termIri(model, t) === iri);
  if (!term) return undefined;
  const domainByEnum = new Map<string, string>();
  for (const map of target.mappings) {
    const domain = map.targets.find((r): r is { domain: string } => 'domain' in r);
    if (!domain) continue;
    for (const source of map.sources) {
      const d = model.datatypes.find((x) => enumIriOf(model, x) === source.iri);
      if (d) domainByEnum.set('id:' + d.id, domain.domain);
      const c = model.terms.find((x) => termIri(model, x) === source.iri && x.oneOf);
      if (c) domainByEnum.set(source.iri, domain.domain);
    }
  }
  return logicalTypeOf({ config, domainByEnum }, term.ranges?.[0]?.range);
}
