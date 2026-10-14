import { CHARACTERISTICS, assertedSuperclasses, dataDomain, findProp, isInstanceOf, objectProperties, propLinks, wouldCycle } from './props';
import { propDatatype, propDatatypes, unionClasses, withUnionClasses } from './domains';
import { namedClasses, type ClassAxiom } from './expressions';
import { reason } from './reasoner';
import { outsideEnumeration } from './datatypes';
import { validateLiteral } from './literals';
import { DATATYPES, INSTANCE_OF, isLang, newRelation, newTerm, type DataValue, type Model, type PropLink, type Term, type TermType } from './types';
import { resolveModel } from './vocab';

/**
 * The asserted OWL axioms the entity editor reads and writes, beyond what a line on the canvas
 * says by itself. Everything here is a pure function of the model: a question about it, or an
 * edit that gives back a new model or the reason it was refused. Nothing is ever inferred into
 * the model, and no edit removes a statement other than the one it names.
 */

/** The outcome of an edit: the new model (perhaps with something worth telling the user), or why not. */
export type Edit = { model: Model; note?: string; error?: undefined } | { error: string; model?: undefined; note?: undefined };

const refuse = (error: string): Edit => ({ error });
const nameOf = (m: Model, id: string) => m.terms.find((t) => t.id === id)?.name || 'Unnamed';
const q = (s: string) => `“${s}”`;

// ---------------------------------------------------------------- statements between two terms

/** Statements that hold both ways between two terms of the same kind, each a standard OWL property. */
export type LinkKind = 'equivalentClass' | 'disjointWith' | 'equivalentProperty' | 'propertyDisjointWith' | 'sameAs' | 'differentFrom';

export const LINKS: Record<LinkKind, { predicate: string; type: TermType; phrase: string; opposite?: LinkKind }> = {
  equivalentClass: { predicate: 'owl:equivalentClass', type: 'concept', phrase: 'equivalent to', opposite: 'disjointWith' },
  disjointWith: { predicate: 'owl:disjointWith', type: 'concept', phrase: 'disjoint with', opposite: 'equivalentClass' },
  equivalentProperty: { predicate: 'owl:equivalentProperty', type: 'property', phrase: 'equivalent to', opposite: 'propertyDisjointWith' },
  propertyDisjointWith: { predicate: 'owl:propertyDisjointWith', type: 'property', phrase: 'disjoint with', opposite: 'equivalentProperty' },
  sameAs: { predicate: 'owl:sameAs', type: 'instance', phrase: 'the same as', opposite: 'differentFrom' },
  differentFrom: { predicate: 'owl:differentFrom', type: 'instance', phrase: 'different from', opposite: 'sameAs' },
};

const KIND_NOUN: Record<TermType, string> = { concept: 'class', property: 'data property', instance: 'individual' };

/**
 * The terms a term is stated to be linked to in this way, whichever of the two the statement
 * was written on, with the relations that state it. Only what is asserted: nothing that follows
 * from other statements.
 */
export function linkedTerms(model: Model, id: string, kind: LinkKind): { id: string; rels: string[] }[] {
  const { predicate } = LINKS[kind];
  const out = new Map<string, string[]>();
  for (const r of resolveModel(model).relations) {
    if (r.predicate !== predicate || r.from === r.to || (r.from !== id && r.to !== id)) continue;
    const other = r.from === id ? r.to : r.from;
    out.set(other, [...(out.get(other) ?? []), r.id]);
  }
  return [...out].map(([other, rels]) => ({ id: other, rels }));
}

export function addLink(model: Model, id: string, other: string, kind: LinkKind): Edit {
  const { predicate, type, phrase, opposite } = LINKS[kind];
  const a = model.terms.find((t) => t.id === id);
  const b = model.terms.find((t) => t.id === other);
  if (!a || !b) return refuse('That entity no longer exists.');
  const noun = KIND_NOUN[type];
  if (id === other) return refuse(`${q(a.name)} cannot be ${phrase} itself.`);
  if (a.type !== type || b.type !== type) return refuse(`Only a ${noun} can be ${phrase} a ${noun}; ${q(b.type === type ? a.name : b.name)} is not one.`);
  // Read with the standard properties in force, as they will be once this is stated.
  const on = model.vocab.enabled ? model : { ...model, vocab: { ...model.vocab, enabled: true } };
  if (linkedTerms(on, id, kind).some((x) => x.id === other)) return refuse(`${q(a.name)} is already stated to be ${phrase} ${q(b.name)}.`);
  if (opposite && linkedTerms(on, id, opposite).some((x) => x.id === other)) {
    return refuse(`${q(a.name)} is stated to be ${LINKS[opposite].phrase} ${q(b.name)}. Both cannot hold; remove that statement first.`);
  }
  // Two members of an enumeration whose members are declared all different are different, each from the other.
  const apart = kind === 'sameAs' ? model.terms.find((t) => isEnumeration(t) && t.allDifferent && t.oneOf!.includes(id) && t.oneOf!.includes(other)) : undefined;
  if (apart) return refuse(`${q(a.name)} and ${q(b.name)} are members of ${q(apart.name)}, whose members are declared all different. Both cannot hold; take that declaration off the class first.`);
  let note: string | undefined;
  if (kind === 'disjointWith' && (wouldCycle(on, id, other) || wouldCycle(on, other, id))) {
    note = `${q(a.name)} and ${q(b.name)} are a kind of one another, so the more specific one can now have no members. Validation will list it.`;
  }
  if (!model.vocab.enabled) note = [note, '“Use RDFS & OWL properties” was switched on, which this kind of statement needs.'].filter(Boolean).join(' ');
  return { model: { ...on, relations: [...on.relations, newRelation({ from: id, to: other, predicate })] }, note };
}

/** Withdraws the statement, in whichever direction (or directions) it was written; nothing else. */
export function removeLink(model: Model, id: string, other: string, kind: LinkKind): Model {
  const rels = new Set(linkedTerms(model, id, kind).find((x) => x.id === other)?.rels ?? []);
  return rels.size ? { ...model, relations: model.relations.filter((r) => !rels.has(r.id)) } : model;
}

// ---------------------------------------------------------------- is a: superclass, type, superproperty

/** What "is a" means between two terms, or undefined if OWL has no such statement. */
export function isAMeaning(from: Term, to: Term): { predicate: string; noun: string } | undefined {
  if (from.type === 'concept' && to.type === 'concept') return { predicate: 'rdfs:subClassOf', noun: 'superclass' };
  if (from.type === 'instance' && to.type === 'concept') return { predicate: 'rdf:type', noun: 'type' };
  if (from.type === 'property' && to.type === 'property') return { predicate: 'rdfs:subPropertyOf', noun: 'superproperty' };
  return undefined;
}

/**
 * States that one term is a kind of (or an instance of) another. Several such statements can
 * stand side by side: a class may have any number of asserted superclasses.
 */
export function addIsA(model: Model, id: string, superId: string): Edit {
  const a = model.terms.find((t) => t.id === id);
  const b = model.terms.find((t) => t.id === superId);
  if (!a || !b) return refuse('That entity no longer exists.');
  const meaning = model.mode === 'skos' ? { predicate: 'skos:broader', noun: 'broader concept' } : isAMeaning(a, b);
  if (!meaning) return refuse(`${a.type === 'instance' ? 'An' : 'A'} ${KIND_NOUN[a.type]} cannot be a kind of ${b.type === 'instance' ? 'an' : 'a'} ${KIND_NOUN[b.type]}.`);
  if (id === superId) return refuse(`${q(a.name)} cannot be its own ${meaning.noun}.`);
  if (assertedSuperclasses(model, id).includes(superId)) return refuse(`${q(b.name)} is already an asserted ${meaning.noun} of ${q(a.name)}.`);
  const cycle = a.type === b.type && wouldCycle(model, id, superId);
  return {
    model: { ...model, relations: [...model.relations, newRelation({ from: id, to: superId, kind: 'generalization' })] },
    // Allowed, since OWL allows it (the two become equivalent), but rarely what was meant.
    ...(cycle ? { note: `${q(b.name)} is already a kind of ${q(a.name)}, so the two are now each other's ${meaning.noun}. Validation lists this as a circular hierarchy.` } : {}),
  };
}

/** Withdraws every statement that `id` is a kind of `superId` (a duplicate would otherwise keep it alive), and nothing else. */
export function removeIsA(model: Model, id: string, superId: string): Model {
  const stated = new Set(resolveModel(model).relations.filter((r) => r.kind === 'generalization' && r.from === id && r.to === superId).map((r) => r.id));
  return stated.size ? { ...model, relations: model.relations.filter((r) => !stated.has(r.id)) } : model;
}

/**
 * Makes a drawn relationship say that an individual is an instance of a class (rdf:type). It has
 * to join an individual and a class, and is pointed from the individual to the class whichever
 * way it was drawn. A membership that is already stated is not stated twice.
 */
export function makeInstanceOf(model: Model, relId: string): Edit {
  const rel = model.relations.find((r) => r.id === relId);
  const a = model.terms.find((t) => t.id === rel?.from);
  const b = model.terms.find((t) => t.id === rel?.to);
  if (!rel || !a || !b) return refuse('That relationship no longer exists.');
  if (model.mode === 'skos') return refuse(`A concept scheme has no individuals, so nothing in it can be “${INSTANCE_OF}”.`);
  const [ind, cls] = a.type === 'instance' && b.type === 'concept' ? [a, b] : a.type === 'concept' && b.type === 'instance' ? [b, a] : [];
  if (!ind || !cls) return refuse(`“${INSTANCE_OF}” joins an individual and a class. ${q(a.name || 'Unnamed')} is ${a.type === 'instance' ? 'an' : 'a'} ${KIND_NOUN[a.type]} and ${q(b.name || 'Unnamed')} is ${b.type === 'instance' ? 'an' : 'a'} ${KIND_NOUN[b.type]}.`);
  if (model.relations.some((r) => r.id !== rel.id && r.from === ind.id && r.to === cls.id && isInstanceOf(model, r))) {
    return refuse(`${q(ind.name || 'Unnamed')} is already stated to be an instance of ${q(cls.name || 'Unnamed')}.`);
  }
  const reversed = rel.from !== ind.id;
  // Nothing of what it was before applies to a membership: no name, no standard property, no quantifier, no cardinalities.
  const { plain: _plain, predicate: _predicate, restriction: _restriction, restrictionN: _n, more: _more, ...base } = rel;
  const next = { ...base, from: ind.id, to: cls.id, label: '', kind: 'generalization' as const, fromCard: '', toCard: '' };
  return {
    model: { ...model, relations: model.relations.map((r) => (r.id === rel.id ? next : r)) },
    ...(reversed ? { note: `“${INSTANCE_OF}” always points from the individual to the class, so the relationship was turned around: ${q(ind.name || 'Unnamed')} → ${q(cls.name || 'Unnamed')}.` } : {}),
  };
}

// ---------------------------------------------------------------- object properties

const LINK_PHRASE: Record<PropLink, string> = { parents: 'a sub-property of', inverses: 'the inverse of', equivalents: 'equivalent to', disjoints: 'disjoint with' };

/** States that one object property (by id) is a sub-property of, inverse to, equivalent to or disjoint with another. */
export function addPropLink(model: Model, key: string, other: string, link: PropLink): Edit {
  const a = findProp(model, key);
  const b = findProp(model, other);
  if (!a || !b) return refuse('That object property no longer exists.');
  if (key === other) {
    return refuse(link === 'inverses' ? `A property that is its own inverse is a symmetric property: tick “Symmetric” for ${q(a.name)} instead.` : `${q(a.name)} cannot be ${LINK_PHRASE[link]} itself.`);
  }
  if (propLinks(model, key, link).includes(other)) return refuse(`${q(a.name)} is already stated to be ${LINK_PHRASE[link]} ${q(b.name)}.`);
  const clash: PropLink | undefined = link === 'equivalents' ? 'disjoints' : link === 'disjoints' ? 'equivalents' : undefined;
  if (clash && propLinks(model, key, clash).includes(other)) return refuse(`${q(a.name)} is stated to be ${LINK_PHRASE[clash]} ${q(b.name)}. Both cannot hold; remove that statement first.`);
  let note: string | undefined;
  if (link === 'parents') {
    // Following the stated superproperties upwards from the new one: does it lead back here?
    const seen = new Set<string>();
    const queue = [other];
    while (queue.length) {
      const k = queue.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(...propLinks(model, k, 'parents'));
    }
    if (seen.has(key)) note = `${q(b.name)} is already a sub-property of ${q(a.name)}, so the two now mean the same.`;
    else if (propLinks(model, key, 'disjoints').includes(other)) note = `${q(a.name)} is also stated to be disjoint with ${q(b.name)}, so it can now never hold between two things.`;
  }
  return { model: { ...model, props: model.props.map((p) => (p.id === key ? { ...p, [link]: [...(p[link] ?? []), other] } : p)) }, note };
}

/** Withdraws the statement from whichever of the two properties carries it. */
export function removePropLink(model: Model, key: string, other: string, link: PropLink): Model {
  const strip = (owner: string, target: string, m: Model): Model =>
    m.props.some((p) => p.id === owner && p[link]?.includes(target))
      ? {
          ...m,
          props: m.props.map((p) => {
            if (p.id !== owner || !p[link]) return p;
            const { [link]: list, ...rest } = p;
            const left = list!.filter((k) => k !== target);
            return left.length ? { ...rest, [link]: left } : rest;
          }),
        }
      : m;
  const once = strip(key, other, model);
  return link === 'parents' ? once : strip(other, key, once);
}

/** Combinations of characteristics that contradict each other or that OWL 2 DL does not allow. */
export function characteristicIssues(chars: string[]): string[] {
  const has = (c: string) => chars.includes(c);
  const label = (c: string) => CHARACTERISTICS.find((x) => x.id === c)!.label;
  const out: string[] = [];
  const clash = (a: string, b: string, why: string) => has(a) && has(b) && out.push(`${label(a)} and ${label(b).toLowerCase()} together: ${why}`);
  clash('symmetric', 'asymmetric', 'only a property that never holds can be both.');
  clash('reflexive', 'irreflexive', 'only possible if there are no individuals at all.');
  clash('reflexive', 'asymmetric', 'a thing related to itself is related both ways.');
  // OWL 2 DL keeps these apart so that reasoning stays decidable.
  for (const c of ['functional', 'inverseFunctional', 'asymmetric', 'irreflexive']) clash('transitive', c, 'not allowed in OWL 2 DL (a transitive property is not “simple”). Reasoners may reject the ontology.');
  return out;
}

// ---------------------------------------------------------------- a class and the properties declared for it

export interface ClassProperty {
  /** Key of an object property, or id of a data property term. */
  ref: string;
  data: boolean;
  name: string;
  iri?: string;
  /** The domain only follows where the property is used; it was not set by hand. */
  auto: boolean;
}

/**
 * The properties whose domain names the class. A domain says what anything that has the
 * property is; it does not say that members of the class must have it.
 */
export function propertiesOfClass(model: Model, classId: string): ClassProperty[] {
  const out: ClassProperty[] = [];
  const iri = model.terms.find((t) => t.id === classId)?.iri;
  // A domain stated as axioms names a class that it is, or is a union or an intersection of.
  const names = (axioms: ClassAxiom[]) => !!iri && axioms.some((a) => namedClasses(a.expression).includes(iri));
  for (const p of objectProperties(model)) if (p.domainAuto ? p.usedFrom.includes(classId) : names(p.domains)) out.push({ ref: p.id, data: false, name: p.name, iri: p.iri, auto: p.domainAuto });
  for (const t of model.terms) {
    if (t.type !== 'property') continue;
    const d = dataDomain(model, t);
    if (d.auto ? d.attached.includes(classId) : names(d.axioms)) out.push({ ref: t.id, data: true, name: t.name || 'Unnamed', iri: t.iri, auto: d.auto });
  }
  return out.sort((a, b) => Number(a.data) - Number(b.data) || a.name.localeCompare(b.name));
}

/** The same for the classes the reasoner entails the class to be a kind of: these apply to it too. */
export function inheritedPropertiesOfClass(model: Model, classId: string): (ClassProperty & { via: string; viaName: string })[] {
  if (model.mode === 'skos') return [];
  const reasoning = reason(model);
  if (!reasoning.consistent) return [];
  const own = new Set(propertiesOfClass(model, classId).map((p) => `${p.data}|${p.ref}`));
  const out: (ClassProperty & { via: string; viaName: string })[] = [];
  for (const link of reasoning.superclasses(classId)) {
    for (const p of propertiesOfClass(model, link.id)) {
      const k = `${p.data}|${p.ref}`;
      if (own.has(k)) continue;
      own.add(k);
      out.push({ ...p, via: link.id, viaName: nameOf(model, link.id) });
    }
  }
  return out;
}

/**
 * Adds the class to a property's domain: the domain becomes "any of" the classes it was and this
 * one. A domain that so far only followed use becomes one set by hand, with the same classes and
 * this one. A domain stated otherwise (two axioms, which hold together, or an expression that is
 * not a union of classes) is not changed here: what adding a class means for it is a choice to
 * make on the property, where all of it is shown.
 */
export function addToDomain(model: Model, classId: string, p: { ref: string; data: boolean }): Edit {
  const cls = model.terms.find((t) => t.id === classId);
  if (cls?.type !== 'concept' || !cls.iri) return refuse('Only a class can be in a domain.');
  const iriOf = (ids: string[]) => ids.map((id) => model.terms.find((t) => t.id === id)?.iri).filter((x): x is string => !!x);
  const add = (name: string, axioms: ClassAxiom[], auto: boolean, used: string[]): ClassAxiom[] | string => {
    const list = auto ? iriOf(used) : unionClasses(axioms);
    if (!list) return `The domain of ${q(name)} is stated as ${axioms.length > 1 ? `${axioms.length} axioms, which all hold` : 'an expression that is not a list of classes'}. Change it on the property, where all of it is shown.`;
    if (list.includes(cls.iri!)) return `${q(nameOf(model, classId))} is already in the domain of ${q(name)}.`;
    return withUnionClasses(auto ? [] : axioms, [...list, cls.iri!]);
  };
  if (p.data) {
    const t = model.terms.find((x) => x.id === p.ref && x.type === 'property');
    if (!t) return refuse('That data property no longer exists.');
    const d = dataDomain(model, t);
    const domains = add(t.name, d.axioms, d.auto, d.attached);
    if (typeof domains === 'string') return refuse(domains);
    return { model: { ...model, terms: model.terms.map((x) => (x.id === t.id ? { ...x, domains } : x)) } };
  }
  const v = findProp(model, p.ref);
  if (!v) return refuse('That object property no longer exists.');
  const domains = add(v.name, v.domains, v.domainAuto, v.usedFrom);
  if (typeof domains === 'string') return refuse(domains);
  return { model: { ...model, props: model.props.map((x) => (x.id === v.id ? { ...x, domains } : x)) } };
}

/**
 * Takes the class out of a domain that was set by hand: out of the classes it is "any of", or the
 * axiom that is that class alone. One that follows use changes only by changing the use.
 */
export function removeFromDomain(model: Model, classId: string, p: { ref: string; data: boolean }): Edit {
  const iri = model.terms.find((t) => t.id === classId)?.iri;
  const take = (axioms: ClassAxiom[]): ClassAxiom[] | string => {
    const list = unionClasses(axioms);
    if (list && iri && list.includes(iri)) return withUnionClasses(axioms, list.filter((x) => x !== iri));
    const alone = axioms.filter((a) => a.expression.type === 'Class' && a.expression.iri === iri);
    if (alone.length) return axioms.filter((a) => !alone.includes(a));
    return 'The class is part of an expression in this domain. Change it on the property, where all of it is shown.';
  };
  if (p.data) {
    const t = model.terms.find((x) => x.id === p.ref);
    if (!t?.domains) return refuse('This domain follows the classes the property is attached to. Remove the restriction that attaches it instead.');
    const domains = take(t.domains);
    if (typeof domains === 'string') return refuse(domains);
    return { model: { ...model, terms: model.terms.map((x) => (x.id === t.id ? { ...x, domains } : x)) } };
  }
  const entry = model.props.find((x) => x.id === p.ref);
  if (!entry?.domains) return refuse('This domain follows the classes the property is used between. Remove the restriction that uses it instead.');
  const domains = take(entry.domains);
  if (typeof domains === 'string') return refuse(domains);
  return { model: { ...model, props: model.props.map((x) => (x === entry ? { ...x, domains } : x)) } };
}

// ---------------------------------------------------------------- individuals

export { validateLiteral } from './literals';

/** The datatype a value is written with: its own if it has one, or else the range of its property. */
export const datatypeOf = (model: Model, v: DataValue): string | undefined => {
  const prop = model.terms.find((t) => t.id === v.prop);
  return v.dt ?? (prop && propDatatype(prop));
};

const sameValue = (a: DataValue, b: DataValue) => a.prop === b.prop && a.value === b.value && (a.lang ?? '') === (b.lang ?? '');

/** States that an individual has a literal value for a data property. */
export function addValue(model: Model, id: string, draft: { prop: string; value: string; lang?: string }): Edit {
  const ind = model.terms.find((t) => t.id === id);
  if (ind?.type !== 'instance') return refuse('Only an individual has property values.');
  const prop = model.terms.find((t) => t.id === draft.prop);
  if (prop?.type !== 'property') return refuse('Choose a data property.');
  const value = draft.value.trim();
  const lang = draft.lang?.trim().toLowerCase() || undefined;
  // Every datatype the range names holds for the value; facets, unions and the like are not checked here.
  const datatypes = propDatatypes(prop);
  for (const range of datatypes) {
    const bad = validateLiteral(value, range);
    if (bad) return refuse(bad);
  }
  if (lang && !isLang(lang)) return refuse(`${q(lang)} is not a language code. Use one like en, nl or zh.`);
  const notText = datatypes.find((range) => range !== 'rdf:langString' && range !== 'xsd:string');
  if (lang && notText) return refuse(`A language only goes with text. ${q(prop.name)} holds ${DATATYPES.find((d) => d.id === notText)?.label ?? notText} values.`);
  // Where the property's values are an enumerated datatype, the value has to be one it lists.
  for (const range of datatypes) {
    const outside = outsideEnumeration(model, range, { value, lang });
    if (outside) return refuse(outside);
  }
  const next: DataValue = { prop: prop.id, value, ...(lang ? { lang } : {}) };
  const have = ind.values ?? [];
  if (have.some((v) => sameValue(v, next))) return refuse(`${q(ind.name)} already has that value for ${q(prop.name)}.`);
  const note = prop.functional && have.some((v) => v.prop === prop.id) ? `${q(prop.name)} is functional: a thing has at most one value. Two different values make the ontology inconsistent, and Validation will say so.` : undefined;
  return { model: { ...model, terms: model.terms.map((t) => (t.id === id ? { ...t, values: [...have, next] } : t)) }, note };
}

export function removeValue(model: Model, id: string, index: number): Model {
  return {
    ...model,
    terms: model.terms.map((t) => {
      if (t.id !== id || !t.values?.[index]) return t;
      const { values, ...rest } = t;
      const left = values.filter((_, i) => i !== index);
      return left.length ? { ...rest, values: left } : rest;
    }),
  };
}

/** States a fact: one individual is related to another by an object property (by id). */
export function addFact(model: Model, id: string, key: string, other: string): Edit {
  const a = model.terms.find((t) => t.id === id);
  const b = model.terms.find((t) => t.id === other);
  const prop = findProp(model, key);
  if (a?.type !== 'instance') return refuse('Only an individual has property values.');
  if (!prop) return refuse('Choose an object property.');
  if (b?.type !== 'instance') return refuse('The value of an object property is another individual.');
  if (prop.rels.some((r) => r.from === id && r.to === other)) return refuse(`${q(a.name)} ${prop.name} ${q(b.name)} is already stated.`);
  const self = id === other && prop.chars.includes('irreflexive') ? `${q(prop.name)} is irreflexive, so nothing can be related to itself by it. Validation will list this.` : undefined;
  return { model: { ...model, relations: [...model.relations, newRelation({ from: id, to: other, label: prop.name, prop: prop.id })] }, note: self };
}

// ---------------------------------------------------------------- enumeration classes

/**
 * An enumeration is a class defined by listing its members: TrafficLightColor is exactly
 * { Red, Yellow, Green } (owl:equivalentClass with owl:oneOf). It is a class like any other,
 * with this one more thing said about it. The members are individuals of the model, by reference:
 * one individual can be a member of several enumerations.
 */
export const isEnumeration = (t: Pick<Term, 'type' | 'oneOf'>): boolean => t.type === 'concept' && t.oneOf !== undefined;

/** Makes a class an enumeration (with no members yet), or an ordinary class again. Nothing else about it changes. */
export function setEnumeration(model: Model, classId: string, on: boolean): Edit {
  const c = model.terms.find((t) => t.id === classId);
  if (!c || c.type !== 'concept') return { error: 'Only a class can be defined as an enumeration.' };
  if (c.external !== undefined) return { error: 'This class belongs to another ontology, so how it is defined is not this model’s to say.' };
  if (on === (c.oneOf !== undefined)) return { model };
  const { oneOf: members, allDifferent: _, ...rest } = c;
  return {
    model: { ...model, terms: model.terms.map((t) => (t.id === classId ? (on ? { ...c, oneOf: [] } : rest) : t)) },
    ...(!on && members?.length ? { note: `“${c.name}” is an ordinary class again. Its ${members.length} former member${members.length === 1 ? ' is' : 's are'} still in the model, as individuals.` } : {}),
  };
}

/** Lists an individual as a member of an enumeration. Refused, with the reason, if it is not an individual or is listed already. */
export function addEnumMember(model: Model, classId: string, memberId: string): Edit {
  const c = model.terms.find((t) => t.id === classId);
  const member = model.terms.find((t) => t.id === memberId);
  if (!c || !member) return { error: 'That class or individual no longer exists.' };
  if (!isEnumeration(c)) return { error: `“${c.name}” is not defined as an enumeration.` };
  if (member.type !== 'instance') return { error: `“${member.name || 'Unnamed'}” is a ${member.type === 'concept' ? 'class' : 'data property'}. An enumeration lists individuals.` };
  if (c.oneOf!.includes(memberId)) return { error: `“${member.name || 'Unnamed'}” is already a member of “${c.name}”.` };
  // Two members with one IRI would be one individual listed twice.
  const twin = member.iri && c.oneOf!.map((id) => model.terms.find((t) => t.id === id)).find((t) => t?.iri === member.iri);
  if (twin) return { error: `“${twin.name}” is already a member and has the same IRI <${member.iri}>.` };
  const same = c.allDifferent ? linkedTerms(model, memberId, 'sameAs').find((x) => c.oneOf!.includes(x.id)) : undefined;
  if (same) return { error: `“${member.name || 'Unnamed'}” is stated to be the same as “${model.terms.find((t) => t.id === same.id)?.name}”, a member already, and the members of “${c.name}” are declared all different.` };
  return { model: { ...model, terms: model.terms.map((t) => (t.id === classId ? { ...c, oneOf: [...c.oneOf!, memberId] } : t)) } };
}

/** Takes an individual off the list of an enumeration. The individual itself stays in the model. */
export function removeEnumMember(model: Model, classId: string, memberId: string): Model {
  return { ...model, terms: model.terms.map((t) => (t.id === classId && t.oneOf?.includes(memberId) ? { ...t, oneOf: t.oneOf.filter((id) => id !== memberId) } : t)) };
}

/** Makes a new individual and lists it as a member, in one step. It is placed beside the class on the canvas. */
export function createEnumMember(model: Model, classId: string, name: string): Edit & { id?: string } {
  const c = model.terms.find((t) => t.id === classId);
  const clean = name.trim();
  if (!c || !isEnumeration(c)) return { error: 'That class is not defined as an enumeration.' };
  if (!clean) return { error: 'The new individual needs a name.' };
  const same = model.terms.find((t) => t.type === 'instance' && t.name.trim().toLowerCase() === clean.toLowerCase());
  if (same) return c.oneOf!.includes(same.id) ? { error: `“${same.name}” is already a member of “${c.name}”.` } : { ...addEnumMember(model, classId, same.id), id: same.id };
  const n = c.oneOf!.length;
  const member = newTerm({ name: clean, type: 'instance', x: c.x + (n % 4) * 150 - 225, y: c.y + 110 + Math.floor(n / 4) * 70 });
  return { model: { ...model, terms: [...model.terms.map((t) => (t.id === classId ? { ...c, oneOf: [...c.oneOf!, member.id] } : t)), member] }, id: member.id };
}

/** States, or stops stating, that the members of an enumeration are all different individuals (owl:AllDifferent). */
export function setAllDifferent(model: Model, classId: string, on: boolean): Model {
  return {
    ...model,
    terms: model.terms.map((t) => {
      if (t.id !== classId || !isEnumeration(t) || !!t.allDifferent === on) return t;
      const { allDifferent: _, ...rest } = t;
      return on ? { ...t, allDifferent: true } : rest;
    }),
  };
}

/** The same from the editor: refused, with the reason, while two of the members are stated to be one and the same individual. */
export function declareAllDifferent(model: Model, classId: string, on: boolean): Edit {
  const c = model.terms.find((t) => t.id === classId);
  for (const id of on ? (c?.oneOf ?? []) : []) {
    const same = linkedTerms(model, id, 'sameAs').find((x) => c!.oneOf!.includes(x.id));
    const name = (x: string) => `“${model.terms.find((t) => t.id === x)?.name || 'Unnamed'}”`;
    if (same) return { error: `${name(id)} and ${name(same.id)} are stated to be the same individual, so the members of “${c!.name}” cannot all be different. Remove that statement first.` };
  }
  return { model: setAllDifferent(model, classId, on) };
}

/** The members of an enumeration that are in the model, in the order listed. */
export const enumMembers = (model: Model, c: Pick<Term, 'oneOf'>): Term[] => (c.oneOf ?? []).map((id) => model.terms.find((t) => t.id === id)).filter((t): t is Term => !!t);

/** The class expression an enumeration stands for, in Manchester syntax: { Red, Yellow, Green }. */
export const enumerationExpression = (model: Model, c: Pick<Term, 'oneOf'>): string => {
  const names = enumMembers(model, c).map((t) => t.name || 'Unnamed');
  return names.length ? `{ ${names.join(', ')} }` : '{ }';
};
