import { propDatatype, termOfIri } from './domains';
import { fits as fitsExpression, type ClassAxiom, type ClassExpression } from './expressions';
import { DEFAULT_PROP, linkProps, nameKey, propOf } from './identity';
import { allowsKind, configOf, type RelKindId } from './modelTypes';
import { ENUM_RANGE, PROP_LINKS, QUANTIFIERS, type DescriptionProperty, type ExtraField, type Model, type ObjProp, type PropLink, type Quantifier, type Relation, type RestrictionSpec, type Term } from './types';
import { resolveModel } from './vocab';

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

export { DEFAULT_PROP };

/** An object property as it stands: what is declared about it, and how it is used. */
export interface PropView {
  /** The property's id (ObjProp.id). */
  id: string;
  name: string;
  description: string;
  describedBy?: DescriptionProperty;
  nameLang?: string;
  descriptionLang?: string;
  /**
   * The domain and range stated: an axiom for each rdfs:domain (rdfs:range) statement, all of
   * which hold at once. Empty where none is stated, and where they follow the uses (`domainAuto`).
   */
  domains: ClassAxiom[];
  ranges: ClassAxiom[];
  /** Not stated by hand: the domain (range) follows the classes the uses start from (point to). */
  domainAuto: boolean;
  rangeAuto: boolean;
  /** The classes, by term id, that the uses between classes start from and point to. */
  usedFrom: string[];
  usedTo: string[];
  chars: string[];
  /** Ids of other properties, as declared on this one (see `propLinks` for both directions). */
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
  /** Relationship labels that are not (yet) an object property, by the label's key (nameKey). */
  plain: { key: string; name: string; rels: Relation[] }[];
  /** Whether a term is, or is a kind / an instance of, one of the allowed terms. */
  fits: (id: string, allowed: string[]) => boolean;
  restrictions: Map<string, Restriction[]>;
  byRelation: Map<string, Restriction[]>;
  /** For each term: the terms it is directly stated to be a kind (or an instance) of, each once. */
  supers: Map<string, string[]>;
  /** The relations that state a class membership: an individual is an instance of a class (rdf:type). */
  memberships: Set<string>;
}

const cache = new WeakMap<Model, Analysis>();

function analyse(model: Model): Analysis {
  const hit = cache.get(model);
  if (hit) return hit;
  // Each relationship joined to the property it uses (identity.ts), then read with the standard properties in force.
  const m = resolveModel(linkProps(model));
  const types = new Map(m.terms.map((t) => [t.id, t.type]));
  const props = new Map<string, PropView>();
  for (const p of m.props) {
    props.set(p.id, {
      id: p.id,
      name: p.name,
      description: p.description,
      ...(p.describedBy ? { describedBy: p.describedBy } : {}),
      ...(p.nameLang !== undefined ? { nameLang: p.nameLang } : {}),
      ...(p.descriptionLang !== undefined ? { descriptionLang: p.descriptionLang } : {}),
      chars: p.chars,
      domains: p.domains ?? [],
      ranges: p.ranges ?? [],
      domainAuto: !p.domains,
      rangeAuto: !p.ranges,
      usedFrom: [],
      usedTo: [],
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
  const memberships = new Set<string>();
  for (const r of m.relations) {
    if (!types.has(r.from) || !types.has(r.to)) continue;
    // "Is a" from an individual to a class is its membership of the class, unless a standard property says otherwise.
    if (m.mode !== 'skos' && r.kind === 'generalization' && (!r.predicate || r.predicate === 'rdf:type') && types.get(r.from) === 'instance' && types.get(r.to) === 'concept') memberships.add(r.id);
    if (r.kind === 'generalization' && r.from !== r.to && !parents.get(r.from)?.includes(r.to)) parents.set(r.from, [...(parents.get(r.from) ?? []), r.to]);
    // "is a", "has property" and relations given a standard RDFS/OWL/SKOS meaning are neither.
    if (r.kind !== 'association' || r.predicate) continue;
    const v = r.prop !== undefined ? props.get(r.prop) : undefined;
    if (!v) {
      const key = nameKey(r.label);
      (plain.get(key) ?? plain.set(key, { key, name: r.label.trim() || DEFAULT_PROP, rels: [] }).get(key)!).rels.push(r);
      continue;
    }
    v.rels.push(r);
    if (types.get(r.from) !== 'concept' || types.get(r.to) !== 'concept') continue;
    if (!v.usedFrom.includes(r.from)) v.usedFrom.push(r.from);
    if (!v.usedTo.includes(r.to)) v.usedTo.push(r.to);
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
  const restrictions = allRestrictions(m, new Map([...props.values()].map((p) => [p.id, p.name])));
  const out: Analysis = {
    props: [...props.values()].sort((a, b) => a.name.localeCompare(b.name)),
    plain: [...plain.values()].sort((a, b) => a.name.localeCompare(b.name)),
    fits,
    supers: parents,
    memberships,
    restrictions,
    byRelation: [...restrictions.values()].flat().reduce((map, r) => map.set(r.rel.id, [...(map.get(r.rel.id) ?? []), r]), new Map<string, Restriction[]>()),
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
export const findProp = (model: Model, id: string) => analyse(model).props.find((p) => p.id === id);

/** The declared entry for an object property, by id. */
export const declaredProp = (model: Model, id: string): ObjProp | undefined => model.props.find((p) => p.id === id);

/**
 * The properties an object property is linked to in one way. Being a sub-property has a
 * direction; inverse, equivalent and disjoint hold both ways, so a statement made on either
 * property counts for both.
 */
export function propLinks(model: Model, id: string, link: PropLink): string[] {
  const all = analyse(model).props;
  const own = all.find((p) => p.id === id)?.[link] ?? [];
  if (link === 'parents') return own;
  return [...new Set([...own, ...all.filter((p) => p.id !== id && p[link].includes(id)).map((p) => p.id)])];
}
export { PROP_LINKS };

/**
 * A data property's domain: the axioms stated by hand (`auto` false), or else none, and it
 * follows the classes it is attached to (`attached`, by term id, whichever it is).
 */
export function dataDomain(model: Model, t: Term): { axioms: ClassAxiom[]; auto: boolean; attached: string[] } {
  return { axioms: t.domains ?? [], auto: !t.domains, attached: [...(attachedClasses(model).get(t.id) ?? [])] };
}

const attachments = new WeakMap<Model['relations'], { terms: Model['terms']; byProp: Map<string, string[]> }>();

/**
 * For each data property, the classes a "has data property" relationship attaches to it, in the
 * order of the relationships: worked out in one pass for a model's terms and relationships, so
 * that asking it of every data property costs no more than asking it of one.
 */
function attachedClasses(model: Model): Map<string, string[]> {
  const hit = attachments.get(model.relations);
  if (hit && hit.terms === model.terms) return hit.byProp;
  const known = new Set(model.terms.filter((x) => x.type === 'concept').map((x) => x.id));
  const byProp = new Map<string, string[]>();
  for (const r of model.relations) {
    if (r.kind !== 'property' || !known.has(r.from)) continue;
    const list = byProp.get(r.to) ?? byProp.set(r.to, []).get(r.to)!;
    if (!list.includes(r.from)) list.push(r.from);
  }
  attachments.set(model.relations, { terms: model.terms, byProp });
  return byProp;
}

/**
 * A domain or range as the expressions it is: the axioms stated, or where it follows the uses
 * (`auto`), the class the uses start from (point to), or the union of those. None: it has none.
 */
export function expressionsOf(model: Model, axioms: ClassAxiom[], auto: boolean, used: string[]): ClassExpression[] {
  if (!auto) return axioms.map((a) => a.expression);
  const iris = used.map((id) => model.terms.find((t) => t.id === id)?.iri).filter((x): x is string => !!x);
  if (!iris.length) return [];
  return [iris.length === 1 ? { type: 'Class', iri: iris[0] } : { type: 'ObjectUnionOf', operands: iris.map((iri) => ({ type: 'Class', iri })) }];
}

/**
 * Whether a term is in a domain or range stated as axioms: in every one of them, since all of
 * them hold. False, with the first axiom it is shown not to be in; true where it is shown to be in
 * all; undefined where some cannot be told (an expression this editor does not judge).
 */
export function fitsAxioms(model: Model, id: string, axioms: ClassAxiom[]): { fits: boolean | undefined; outside?: ClassAxiom } {
  const isA = (iri: string) => {
    const t = termOfIri(model, iri);
    return !!t && analyse(model).fits(id, [t.id]);
  };
  let unknown = false;
  for (const a of axioms) {
    const ok = fitsExpression(a.expression, isA);
    if (ok === false) return { fits: false, outside: a };
    if (ok === undefined) unknown = true;
  }
  return { fits: unknown ? undefined : true };
}

/** What a relationship is, as offered where its kind is chosen. Which kinds there are depends on the type of model. */
export type RelChoice = RelKindId;

/**
 * Whether a relation states a class membership: it points from an individual to a class and
 * means rdf:type. It is an "is a" relation like a superclass is, told apart by what it connects.
 */
export const isInstanceOf = (model: Model, r: Pick<Relation, 'id'>): boolean => analyse(model).memberships.has(r.id);

export function relChoice(model: Model, r: Relation): RelChoice {
  if (isInstanceOf(model, r)) return 'instanceOf';
  if (r.kind !== 'association') return r.kind;
  // Where the type of model has no object properties, a label is only ever a label.
  return allowsKind(model, 'object') && propOf(model, r) ? 'object' : 'plain';
}

/**
 * What each pair of kinds of term can be related by, besides a plain relationship where the type
 * of model has those. Two classes: an object property (a restriction on the first class) or
 * "is a". An individual and a class: a class membership and nothing else. A class and a data
 * property: the class has the property. Two individuals: a fact that uses an object property.
 * Two data properties: one is a sub-property of the other. An individual and a data property:
 * nothing at all, since what an individual has for a data property is a value, not a line.
 */
const KINDS_BETWEEN: Record<string, { kinds: RelChoice[]; between: string }> = {
  'concept|concept': { kinds: ['object', 'generalization'], between: 'two classes' },
  'concept|instance': { kinds: ['instanceOf'], between: 'an individual and a class' },
  'concept|property': { kinds: ['property'], between: 'a class and a data property' },
  'instance|instance': { kinds: ['object'], between: 'two individuals' },
  'property|property': { kinds: ['generalization'], between: 'two data properties' },
  'instance|property': { kinds: [], between: 'an individual and a data property' },
};

/** What a relationship is called where the type of model no longer offers its kind. */
const FORMER_KIND: Partial<Record<RelChoice, string>> = { plain: 'Relationship (plain)' };

/**
 * The kinds a relationship can be given, each with the reason it is not on offer, if it is not.
 * What it joins decides (see KINDS_BETWEEN); a plain relationship can join anything, in a type of
 * model that has them.
 */
export function relChoices(model: Model, r: Pick<Relation, 'from' | 'to'>): { value: RelChoice; label: string; disabled?: string }[] {
  const config = configOf(model);
  const kinds = config.relationKinds.map((k) => ({ value: k.id, label: k.label }));
  // With one kind of term there is nothing for the two ends to differ in.
  if (config.termTypes.length < 2) return kinds;
  const type = (id: string) => model.terms.find((t) => t.id === id)?.type;
  const rule = KINDS_BETWEEN[[type(r.from), type(r.to)].sort().join('|')];
  return kinds.map((c) => (!rule || c.value === 'plain' || rule.kinds.includes(c.value) ? c : { ...c, disabled: `Not between ${rule.between}` }));
}

/** The kinds a relationship between these two can be given: none, where the two cannot be related at all. */
export const kindsBetween = (model: Model, r: Pick<Relation, 'from' | 'to'>): RelChoice[] => relChoices(model, r).filter((c) => !c.disabled).map((c) => c.value);

/**
 * The kinds to list for a relationship: the ones it can be given, and the one it is, should that
 * not be among them. A relationship from before the type of model stopped offering its kind (a
 * plain one in an ontology) keeps it until it is given another; one that stands for a standard
 * property has no kind of its own.
 */
export function offeredChoices(model: Model, r: Relation): { value: RelChoice; label: string; disabled?: string }[] {
  const now = relChoice(model, r);
  const list = relChoices(model, r).filter((c) => !c.disabled || c.value === now);
  if (list.some((c) => c.value === now)) return list;
  const standard = resolveModel(model).relations.find((x) => x.id === r.id)?.predicate;
  return [{ value: now, label: standard ? `Standard property (${standard})` : (FORMER_KIND[now] ?? now), disabled: standard ? 'What it means is set by the standard property' : `${configOf(model).label === 'OWL ontology' ? 'An OWL ontology' : 'This type of model'} has no relationships of this kind. Choose what this one is.` }, ...list];
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

const counted = (q: Quantifier) => q === 'min' || q === 'max' || q === 'exactly';
const sameSpec = (a: RestrictionSpec, b: RestrictionSpec) => a.restriction === b.restriction && a.restrictionN === b.restrictionN;

/**
 * Every restriction a relationship states, in order: the first ("some" unless set otherwise)
 * and any further ones. A quantifier that counts always has its number.
 */
export function restrictionSpecs(r: Pick<Relation, 'restriction' | 'restrictionN' | 'more'>): RestrictionSpec[] {
  const all = [{ restriction: r.restriction ?? 'some', restrictionN: r.restrictionN }, ...(r.more ?? [])];
  return all.map((s) => (counted(s.restriction) ? { restriction: s.restriction, restrictionN: s.restrictionN ?? 1 } : { restriction: s.restriction }));
}

/** The change to a relationship that makes it state exactly these restrictions, each once. At least one is kept. */
export function specsPatch(specs: RestrictionSpec[]): Pick<Relation, 'restriction' | 'restrictionN' | 'more'> {
  const list = restrictionSpecs({ restriction: specs[0]?.restriction, restrictionN: specs[0]?.restrictionN, more: specs.slice(1) });
  const [first, ...rest] = list.filter((s, i) => list.findIndex((x) => sameSpec(x, s)) === i);
  return { restriction: first.restriction === 'some' ? undefined : first.restriction, restrictionN: first.restrictionN, more: rest.length ? rest : undefined };
}

/** A restriction the relationship does not state yet, to start a further one from; undefined when it has one of every kind. */
export function nextSpec(r: Pick<Relation, 'restriction' | 'restrictionN' | 'more'>): RestrictionSpec | undefined {
  const used = new Set(restrictionSpecs(r).map((s) => s.restriction));
  const q = QUANTIFIERS.find((x) => !used.has(x.id))?.id;
  return q ? (counted(q) ? { restriction: q, restrictionN: 1 } : { restriction: q }) : undefined;
}

/**
 * Whether a relationship carries cardinalities at its ends. They are a diagram's way of saying
 * "how many" and belong to a plain relationship; an object or data property says it with
 * restrictions, and "is a" and "is instance of" do not say it at all.
 */
export const hasCardinality = (model: Model, r: Relation): boolean => (model.mode === 'skos' ? r.kind === 'association' : !r.predicate && relChoice(model, r) === 'plain');

/** One line of a class description: "directs some Film", "release date some xsd:date". */
export interface Restriction {
  rel: Relation;
  /** Which of the relationship's restrictions this is (see restrictionSpecs). */
  index: number;
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
export const restrictionByRelation = (model: Model): Map<string, Restriction[]> => analyse(model).byRelation;

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
      // The values it has to have: a standard datatype by its name, an enumerated one by the name it was given.
      const range = propDatatype(to);
      const listed = range?.startsWith(ENUM_RANGE) ? m.datatypes.find((d) => d.id === range.slice(ENUM_RANGE.length))?.name : undefined;
      line = { data: true, property: to.name || 'Unnamed', filler: listed ?? (range?.startsWith(ENUM_RANGE) ? undefined : range) ?? 'rdfs:Literal' };
    } else if (r.kind === 'association' && r.prop !== undefined && to.type === 'concept' && declared.has(r.prop)) {
      line = { data: false, property: declared.get(r.prop)!, filler: to.name || 'Unnamed' };
    }
    if (!line) continue;
    for (const [index, spec] of restrictionSpecs(r).entries()) {
      const quantifier = spec.restriction;
      const n = spec.restrictionN;
      const item: Restriction = { rel: r, index, ...line, quantifier, ...(n !== undefined ? { n } : {}), text: `${line.property} ${quantifier}${n !== undefined ? ' ' + n : ''} ${line.filler}` };
      (out.get(r.from) ?? out.set(r.from, []).get(r.from)!).push(item);
    }
  }
  return out;
}
