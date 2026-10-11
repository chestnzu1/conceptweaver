import { PROP_LINKS, type ExtraField, type Model, type ObjProp, type PropLink, type Quantifier, type Relation, type Term } from './types';
import { labelKey, resolveModel } from './vocab';

/** The characteristics an object property can have, as in OWL. */
export const CHARACTERISTICS: { id: string; owl: string; label: string; about: string }[] = [
  { id: 'functional', owl: 'owl:FunctionalProperty', label: 'Functional', about: 'Each thing has at most one value.' },
  { id: 'inverseFunctional', owl: 'owl:InverseFunctionalProperty', label: 'Inverse functional', about: 'Each value belongs to at most one thing.' },
  { id: 'transitive', owl: 'owl:TransitiveProperty', label: 'Transitive', about: 'If A relates to B and B to C, then A relates to C.' },
  { id: 'symmetric', owl: 'owl:SymmetricProperty', label: 'Symmetric', about: 'If A relates to B, then B relates to A.' },
  { id: 'asymmetric', owl: 'owl:AsymmetricProperty', label: 'Asymmetric', about: 'If A relates to B, then B never relates to A.' },
  { id: 'reflexive', owl: 'owl:ReflexiveProperty', label: 'Reflexive', about: 'Everything relates to itself.' },
  { id: 'irreflexive', owl: 'owl:IrreflexiveProperty', label: 'Irreflexive', about: 'Nothing relates to itself.' },
];

/** Name used for an unlabelled relationship. */
export const DEFAULT_PROP = 'related to';

/** The key a property or relationship label is known by: its name, ignoring case and outer spaces. */
export const propKey = (name: string) => labelKey(name) || DEFAULT_PROP;

/** An object property as it stands: what is declared about it, and how it is used. */
export interface PropView {
  key: string;
  name: string;
  description: string;
  /** Term ids. When not set by hand these follow the classes the property is used between. */
  domain: string[];
  range: string[];
  domainAuto: boolean;
  rangeAuto: boolean;
  chars: string[];
  /** Keys of other properties, as declared on this one (see `propLinks` for both directions). */
  parents: string[];
  inverses: string[];
  equivalents: string[];
  disjoints: string[];
  fields: ExtraField[];
  iri?: string;
  /** Defined in another ontology (see ObjProp.external). */
  external?: string;
  /** The relationships that use it. */
  rels: Relation[];
}

interface Analysis {
  props: PropView[];
  /** Relationship labels that are not (yet) an object property. */
  plain: { key: string; name: string; rels: Relation[] }[];
  /** Whether a term is, or is a kind / an instance of, one of the allowed terms. */
  fits: (id: string, allowed: string[]) => boolean;
  restrictions: Map<string, Restriction[]>;
  byRelation: Map<string, Restriction>;
  /** For each term: the terms it is directly stated to be a kind (or an instance) of, each once. */
  supers: Map<string, string[]>;
}

const cache = new WeakMap<Model, Analysis>();

function analyse(model: Model): Analysis {
  const hit = cache.get(model);
  if (hit) return hit;
  const m = resolveModel(model);
  const types = new Map(m.terms.map((t) => [t.id, t.type]));
  const props = new Map<string, PropView>();
  for (const p of m.props) {
    props.set(propKey(p.name), {
      key: propKey(p.name),
      name: p.name,
      description: p.description,
      chars: p.chars,
      domain: p.domain?.filter((id) => types.has(id)) ?? [],
      range: p.range?.filter((id) => types.has(id)) ?? [],
      domainAuto: !p.domain,
      rangeAuto: !p.range,
      parents: p.parents ?? [],
      inverses: p.inverses ?? [],
      equivalents: p.equivalents ?? [],
      disjoints: p.disjoints ?? [],
      fields: p.fields ?? [],
      ...(p.iri ? { iri: p.iri } : {}),
      ...(p.external !== undefined ? { external: p.external } : {}),
      rels: [],
    });
  }
  const plain = new Map<string, { key: string; name: string; rels: Relation[] }>();
  const parents = new Map<string, string[]>();
  for (const r of m.relations) {
    if (!types.has(r.from) || !types.has(r.to)) continue;
    if (r.kind === 'generalization' && r.from !== r.to && !parents.get(r.from)?.includes(r.to)) parents.set(r.from, [...(parents.get(r.from) ?? []), r.to]);
    // "is a", "has property" and relations given a standard RDFS/OWL/SKOS meaning are neither.
    if (r.kind !== 'association' || r.predicate) continue;
    const key = propKey(r.label);
    const v = r.plain ? undefined : props.get(key);
    if (!v) {
      (plain.get(key) ?? plain.set(key, { key, name: r.label.trim() || DEFAULT_PROP, rels: [] }).get(key)!).rels.push(r);
      continue;
    }
    v.rels.push(r);
    if (types.get(r.from) !== 'concept' || types.get(r.to) !== 'concept') continue;
    if (v.domainAuto && !v.domain.includes(r.from)) v.domain.push(r.from);
    if (v.rangeAuto && !v.range.includes(r.to)) v.range.push(r.to);
  }
  const fits = (id: string, allowed: string[]) => {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const v = queue.pop()!;
      if (allowed.includes(v)) return true;
      if (seen.has(v)) continue;
      seen.add(v);
      queue.push(...(parents.get(v) ?? []));
    }
    return false;
  };
  const restrictions = allRestrictions(m, new Map([...props.values()].map((p) => [p.key, p.name])));
  const out: Analysis = {
    props: [...props.values()].sort((a, b) => a.name.localeCompare(b.name)),
    plain: [...plain.values()].sort((a, b) => a.name.localeCompare(b.name)),
    fits,
    supers: parents,
    restrictions,
    byRelation: new Map([...restrictions.values()].flat().map((r) => [r.rel.id, r])),
  };
  cache.set(model, out);
  return out;
}

/**
 * The object properties of an ontology: the ones that have been declared. A relationship whose
 * label is the name of one is a use of it; any other labelled relationship is just that, a
 * relationship, until someone decides it is an object property.
 */
export const objectProperties = (model: Model): PropView[] => analyse(model).props;
export const plainRelationships = (model: Model) => analyse(model).plain;
export const fitsIn = (model: Model, id: string, allowed: string[]) => analyse(model).fits(id, allowed);
export const findProp = (model: Model, key: string) => analyse(model).props.find((p) => p.key === key);

/** The declared entry for an object property. */
export function declaredProp(model: Model, key: string): ObjProp {
  return model.props.find((p) => propKey(p.name) === key) ?? { name: key, description: '', chars: [] };
}

/**
 * The properties an object property is linked to in one way. Being a sub-property has a
 * direction; inverse, equivalent and disjoint hold both ways, so a statement made on either
 * property counts for both.
 */
export function propLinks(model: Model, key: string, link: PropLink): string[] {
  const all = analyse(model).props;
  const own = all.find((p) => p.key === key)?.[link] ?? [];
  if (link === 'parents') return own;
  return [...new Set([...own, ...all.filter((p) => p.key !== key && p[link].includes(key)).map((p) => p.key)])];
}
export { PROP_LINKS };

/** The classes that can have a data property: set by hand, or else the terms it is attached to. */
export function dataDomain(model: Model, t: Term): { ids: string[]; auto: boolean } {
  const known = new Set(model.terms.map((x) => x.id));
  if (t.domain) return { ids: t.domain.filter((id) => known.has(id)), auto: false };
  return { ids: [...new Set(model.relations.filter((r) => r.kind === 'property' && r.to === t.id && known.has(r.from)).map((r) => r.from))], auto: true };
}

/** What a relationship is, as offered where its kind is chosen. */
export type RelChoice = 'object' | 'plain' | 'generalization' | 'property';
export const REL_CHOICES: { value: RelChoice; label: string }[] = [
  { value: 'plain', label: 'Relationship (plain)' },
  { value: 'object', label: 'Object property' },
  { value: 'generalization', label: 'Is a (generalization)' },
  { value: 'property', label: 'Has data property' },
];

export function relChoice(model: Model, r: Relation): RelChoice {
  if (r.kind !== 'association') return r.kind;
  return !r.predicate && !r.plain && model.props.some((p) => propKey(p.name) === propKey(r.label)) ? 'object' : 'plain';
}

/**
 * The superclasses a class is explicitly stated to have: one per "is a" relation, each once,
 * in the order stated. Nothing inferred: if Actress is an Actor and Actor is a Person, Person is
 * not listed for Actress unless that is stated too.
 */
export const assertedSuperclasses = (model: Model, id: string): string[] => analyse(model).supers.get(id) ?? [];

/** Whether making `id` a kind of `superId` would make the two each other's ancestors. */
export const wouldCycle = (model: Model, id: string, superId: string): boolean => id === superId || analyse(model).fits(superId, [id]);

export const quantifierOf = (r: Relation): Quantifier => r.restriction ?? 'some';

/** One line of a class description: "directs some Film", "release date some xsd:date". */
export interface Restriction {
  rel: Relation;
  /** On a data property (the value is a literal) rather than an object property. */
  data: boolean;
  property: string;
  quantifier: Quantifier;
  n?: number;
  /** The class or datatype the values belong to. */
  filler: string;
  text: string;
}

/**
 * How a class is restricted by its relationships: one restriction for each object property it
 * uses towards another class, and one for each data property it has.
 */
export const restrictionsOf = (model: Model, classId: string): Restriction[] => analyse(model).restrictions.get(classId) ?? [];

/** Every restriction in the model, by the relationship that states it. */
export const restrictionByRelation = (model: Model): Map<string, Restriction> => analyse(model).byRelation;

function allRestrictions(m: Model, declared: Map<string, string>): Map<string, Restriction[]> {
  const out = new Map<string, Restriction[]>();
  if (m.mode === 'skos') return out;
  const byId = new Map(m.terms.map((t) => [t.id, t]));
  for (const r of m.relations) {
    const from = byId.get(r.from);
    const to = byId.get(r.to);
    if (from?.type !== 'concept' || !to || r.predicate) continue;
    let line: Pick<Restriction, 'data' | 'property' | 'filler'> | undefined;
    if (r.kind === 'property' && to.type === 'property') {
      line = { data: true, property: to.name || 'Unnamed', filler: to.range ?? 'rdfs:Literal' };
    } else if (r.kind === 'association' && !r.plain && to.type === 'concept' && declared.has(propKey(r.label))) {
      line = { data: false, property: declared.get(propKey(r.label))!, filler: to.name || 'Unnamed' };
    }
    if (!line) continue;
    const quantifier = quantifierOf(r);
    const n = quantifier === 'min' || quantifier === 'max' || quantifier === 'exactly' ? (r.restrictionN ?? 1) : undefined;
    const item: Restriction = { rel: r, ...line, quantifier, ...(n !== undefined ? { n } : {}), text: `${line.property} ${quantifier}${n !== undefined ? ' ' + n : ''} ${line.filler}` };
    (out.get(r.from) ?? out.set(r.from, []).get(r.from)!).push(item);
  }
  return out;
}
