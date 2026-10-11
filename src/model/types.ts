export type TermType = 'concept' | 'property' | 'instance';
export type RelKind = 'association' | 'generalization' | 'property';

export const TERM_TYPES: { value: TermType; label: string }[] = [
  { value: 'concept', label: 'Concept' },
  { value: 'property', label: 'Property' },
  { value: 'instance', label: 'Instance' },
];

export const REL_KINDS: { value: RelKind; label: string }[] = [
  { value: 'association', label: 'Relationship' },
  { value: 'generalization', label: 'Is a (generalization)' },
  { value: 'property', label: 'Has property (domain)' },
];

/** Datatypes offered as the range of a data property. */
export const DATATYPES: { id: string; label: string }[] = [
  { id: 'xsd:string', label: 'text' },
  { id: 'rdf:langString', label: 'text with a language' },
  { id: 'xsd:integer', label: 'whole number' },
  { id: 'xsd:decimal', label: 'decimal number' },
  { id: 'xsd:double', label: 'floating-point number' },
  { id: 'xsd:boolean', label: 'true / false' },
  { id: 'xsd:date', label: 'date' },
  { id: 'xsd:dateTime', label: 'date and time' },
  { id: 'xsd:time', label: 'time' },
  { id: 'xsd:gYear', label: 'year' },
  { id: 'xsd:duration', label: 'duration' },
  { id: 'xsd:anyURI', label: 'link (URI)' },
];

/**
 * The kinds of term. A property term is a data property: its values are literals such as text
 * or dates. Object properties, which link two terms, are the relationships (see ObjProp).
 */
export const TYPE_CHOICES: { value: TermType; label: string; patch: Pick<Term, 'type'> }[] = [
  { value: 'concept', label: 'Class / concept', patch: { type: 'concept' } },
  { value: 'property', label: 'Data property', patch: { type: 'property' } },
  { value: 'instance', label: 'Individual', patch: { type: 'instance' } },
];

export const typeChoice = (t: Pick<Term, 'type'>): TermType => t.type;

/**
 * An object property of an ontology: a named, reusable kind of relationship. Relationships on
 * the canvas use it by carrying its name as their label.
 */
export interface ObjProp {
  name: string;
  description: string;
  /** Term ids. Left out, the domain (or range) follows the relationships that use the property. */
  domain?: string[];
  range?: string[];
  /** Ids from CHARACTERISTICS, e.g. "transitive". */
  chars: string[];
  /** Key (lower-cased name) of its inverse and of the property it specialises. */
  inverseOf?: string;
  parent?: string;
  /** Full IRI: kept from an import, or made once from the name. */
  iri?: string;
}

export const COLORS = ['', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'] as const;

export interface ExtraField {
  key: string;
  value: string;
  /** Language tag of the value, e.g. "nl". */
  lang?: string;
}

/** What the model is: an OWL ontology, or a SKOS concept scheme (thesaurus, taxonomy, glossary). */
export type ModelMode = 'ontology' | 'skos';

export interface Term {
  id: string;
  name: string;
  description: string;
  type: TermType;
  color: string;
  x: number;
  y: number;
  synonyms: string;
  fields: ExtraField[];
  /** Full IRI, kept when the term came from an RDF import. */
  iri?: string;
  /** For a data property: the datatype of its values, e.g. "xsd:date". */
  range?: string;
  /** For a data property: the classes that can have it, when set by hand. Otherwise the classes it is attached to. */
  domain?: string[];
  /**
   * Asserted axioms about a class that have no drawing of their own, kept word for word: a
   * predicate and a class expression in Turtle, such as
   * "rdfs:subClassOf [ owl:intersectionOf ( … ) ]". They come from imported ontologies.
   */
  axioms?: string[];
}

export interface Relation {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: RelKind;
  description: string;
  fromCard: string;
  toCard: string;
  /** Standard RDFS/OWL property this relation stands for, e.g. "owl:sameAs". */
  predicate?: string;
  /**
   * How a class is restricted by this relationship, when it uses an object property or has a
   * data property: every member has some / only / at least, at most or exactly N values of the
   * target class or datatype. "some" when not set.
   */
  restriction?: Quantifier;
  /** The number for min, max and exactly. */
  restrictionN?: number;
  /** Kept as a plain relationship even though its label is the name of an object property. */
  plain?: boolean;
}

export type Quantifier = 'some' | 'only' | 'min' | 'max' | 'exactly';
export const QUANTIFIERS: { id: Quantifier; about: string }[] = [
  { id: 'some', about: 'at least one such value' },
  { id: 'only', about: 'no values of any other kind' },
  { id: 'min', about: 'at least N such values' },
  { id: 'max', about: 'at most N such values' },
  { id: 'exactly', about: 'exactly N such values' },
];

/** A namespace prefix: "ex" for http://example.org/ns#, so that an IRI can be written ex:Actor. */
export interface Prefix {
  prefix: string;
  iri: string;
}

export interface Model {
  format: 'conceptweaver';
  version: 1;
  name: string;
  description: string;
  /** The default namespace: where the IRIs of new entities are made. */
  baseIri: string;
  /** The IRI of the ontology itself. Empty: the default namespace without its final # or /. */
  ontologyIri: string;
  /** The model's own namespace prefixes, beside the default namespace and the standard ones. */
  prefixes: Prefix[];
  mode: ModelMode;
  /** Language of the names, descriptions and synonyms, e.g. "en"; empty for untagged. */
  lang: string;
  /** Optional RDFS/OWL layer: whether it is on, and which relation labels map to which standard property. */
  vocab: { enabled: boolean; map: Record<string, string> };
  /** Declared object properties. Relationship labels in use that have no entry here are properties too. */
  props: ObjProp[];
  terms: Term[];
  relations: Relation[];
}

export const MAX_TERMS = 50_000;
export const MAX_RELATIONS = 100_000;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
}

export function emptyModel(name = 'Untitled model'): Model {
  return { format: 'conceptweaver', version: 1, name, description: '', baseIri: '', ontologyIri: '', prefixes: [], mode: 'ontology', lang: '', vocab: { enabled: false, map: {} }, props: [], terms: [], relations: [] };
}

export function newTerm(p: Partial<Term> = {}): Term {
  return {
    id: uid(),
    name: '',
    description: '',
    type: 'concept',
    color: '',
    x: 0,
    y: 0,
    synonyms: '',
    fields: [],
    ...p,
  };
}

export function newRelation(p: Partial<Relation> & { from: string; to: string }): Relation {
  return {
    id: uid(),
    label: '',
    kind: 'association',
    description: '',
    fromCard: '',
    toCard: '',
    ...p,
  };
}

/** Text shown on the canvas for a relation. */
export function relLabel(r: Relation, skos = false): string {
  if (r.label) return r.label;
  if (r.predicate) return r.predicate;
  if (r.kind === 'generalization') return skos ? 'broader' : 'is a';
  if (r.kind === 'property') return 'has';
  return '';
}

const STD = /^(rdfs?|owl|skos):[A-Za-z]+$/;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Validates untrusted JSON and returns a well-formed model. Throws on anything unusable. */
export function normalizeModel(raw: unknown): Model {
  if (!raw || typeof raw !== 'object') throw new Error('Not a model file.');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.terms) || !Array.isArray(o.relations)) {
    throw new Error('Not a ConceptWeaver model: expected "terms" and "relations" arrays.');
  }
  if (o.terms.length > MAX_TERMS || o.relations.length > MAX_RELATIONS) {
    throw new Error('Model is too large.');
  }
  const ids = new Set<string>();
  const terms: Term[] = [];
  for (const t of o.terms as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object') continue;
    const id = str(t.id) || uid();
    if (ids.has(id)) continue;
    ids.add(id);
    const type = str(t.type);
    const color = str(t.color);
    terms.push({
      id,
      name: str(t.name),
      description: str(t.description),
      type: type === 'property' || type === 'instance' ? type : 'concept',
      color: (COLORS as readonly string[]).includes(color) ? color : '',
      x: num(t.x),
      y: num(t.y),
      synonyms: str(t.synonyms),
      fields: Array.isArray(t.fields)
        ? (t.fields as Record<string, unknown>[])
            .filter((f) => f && typeof f === 'object')
            .map((f) => ({ key: str(f.key), value: str(f.value), ...(LANG.test(str(f.lang)) ? { lang: str(f.lang).toLowerCase() } : {}) }))
        : [],
      ...(str(t.iri) ? { iri: str(t.iri) } : {}),
      ...(DATATYPES.some((d) => d.id === str(t.range)) ? { range: str(t.range) } : {}),
      ...(Array.isArray(t.axioms) && t.axioms.length ? { axioms: t.axioms.map((a) => str(a)).filter(Boolean) } : {}),
    });
  }
  // A data property's hand-set domain can only name terms that exist.
  for (const [i, t] of (o.terms as Record<string, unknown>[]).entries()) {
    const term = t && typeof t === 'object' ? terms.find((x) => x.id === str(t.id)) : undefined;
    if (term && Array.isArray(t.domain) && i >= 0) term.domain = [...new Set(t.domain.map((x) => str(x)).filter((id) => ids.has(id)))];
  }
  const relIds = new Set<string>();
  const relations: Relation[] = [];
  for (const r of o.relations as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const from = str(r.from);
    const to = str(r.to);
    if (!ids.has(from) || !ids.has(to)) continue;
    let id = str(r.id) || uid();
    if (relIds.has(id)) id = uid();
    relIds.add(id);
    const kind = str(r.kind);
    relations.push({
      id,
      from,
      to,
      label: str(r.label),
      kind: kind === 'generalization' || kind === 'property' ? kind : 'association',
      ...(QUANTIFIERS.some((q) => q.id === r.restriction) ? { restriction: r.restriction as Quantifier } : {}),
      ...(typeof r.restrictionN === 'number' && r.restrictionN >= 0 ? { restrictionN: Math.floor(r.restrictionN) } : {}),
      ...(r.plain === true ? { plain: true } : {}),
      description: str(r.description),
      fromCard: str(r.fromCard),
      toCard: str(r.toCard),
      ...(STD.test(str(r.predicate)) ? { predicate: str(r.predicate) } : {}),
    });
  }
  const v = (o.vocab && typeof o.vocab === 'object' ? o.vocab : {}) as Record<string, unknown>;
  const map: Record<string, string> = {};
  if (v.map && typeof v.map === 'object') {
    for (const [k, p] of Object.entries(v.map as Record<string, unknown>)) if (STD.test(str(p))) map[k.trim().toLowerCase()] = str(p);
  }
  const props: ObjProp[] = [];
  const key = (name: string) => name.trim().toLowerCase();
  const idList = (v: unknown) => (Array.isArray(v) ? { list: [...new Set(v.map((x) => str(x)).filter((id) => ids.has(id)))] } : undefined);
  for (const p of (Array.isArray(o.props) ? o.props : []) as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object' || !str(p.name).trim() || props.some((x) => key(x.name) === key(str(p.name)))) continue;
    const domain = idList(p.domain);
    const range = idList(p.range);
    props.push({
      name: str(p.name).trim(),
      description: str(p.description),
      chars: Array.isArray(p.chars) ? [...new Set(p.chars.map((c) => str(c)).filter(Boolean))] : [],
      ...(domain ? { domain: domain.list } : {}),
      ...(range ? { range: range.list } : {}),
      ...(str(p.inverseOf) ? { inverseOf: key(str(p.inverseOf)) } : {}),
      ...(str(p.parent) ? { parent: key(str(p.parent)) } : {}),
      ...(str(p.iri) ? { iri: str(p.iri) } : {}),
    });
  }
  // Models from the short-lived version that drew an object property as a term of its own:
  // each becomes a declared property, used between every domain and range term it had.
  const rawTerms = new Map((o.terms as Record<string, unknown>[]).filter((t) => t && typeof t === 'object').map((t) => [str(t.id), t]));
  for (const t of [...terms]) {
    if (t.type !== 'property' || rawTerms.get(t.id)?.propKind !== 'object') continue;
    const domain = relations.filter((r) => r.kind === 'property' && r.to === t.id).map((r) => r.from);
    const range = (o.relations as Record<string, unknown>[]).filter((r) => r && r.kind === 'range' && r.from === t.id && ids.has(str(r.to))).map((r) => str(r.to));
    if (!props.some((x) => key(x.name) === key(t.name)) && t.name.trim()) {
      props.push({ name: t.name.trim(), description: t.description, chars: [], ...(domain.length ? { domain } : {}), ...(range.length ? { range } : {}) });
    }
    terms.splice(terms.indexOf(t), 1);
    ids.delete(t.id);
    for (let i = relations.length - 1; i >= 0; i--) if (relations[i].from === t.id || relations[i].to === t.id) relations.splice(i, 1);
    for (const d of domain) for (const r of range) relations.push(newRelation({ from: d, to: r, label: t.name.trim() }));
  }
  return {
    format: 'conceptweaver',
    version: 1,
    name: str(o.name, 'Untitled model') || 'Untitled model',
    description: str(o.description),
    baseIri: str(o.baseIri),
    ontologyIri: str(o.ontologyIri),
    prefixes: (Array.isArray(o.prefixes) ? (o.prefixes as Record<string, unknown>[]) : [])
      .filter((p) => p && typeof p === 'object' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(str(p.prefix)) && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(str(p.iri)))
      .map((p) => ({ prefix: str(p.prefix), iri: str(p.iri) })),
    mode: o.mode === 'skos' ? 'skos' : 'ontology',
    lang: LANG.test(str(o.lang)) ? str(o.lang).toLowerCase() : '',
    vocab: { enabled: v.enabled === true, map },
    props,
    terms,
    relations,
  };
}

/** Name of a relation kind as shown in menus; SKOS calls a generalization "broader". */
export function kindLabel(kind: RelKind, skos: boolean): string {
  if (skos) return kind === 'generalization' ? 'Broader' : kind === 'property' ? 'Has property (not SKOS)' : 'Association';
  return REL_KINDS.find((k) => k.value === kind)!.label;
}

export const isLang = (s: string) => LANG.test(s);
