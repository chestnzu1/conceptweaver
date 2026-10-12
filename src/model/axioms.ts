import { CHARACTERISTICS, assertedSuperclasses, dataDomain, findProp, isInstanceOf, objectProperties, propKey, propLinks, wouldCycle } from './props';
import { reason } from './reasoner';
import { DATATYPES, INSTANCE_OF, isLang, newRelation, type DataValue, type Model, type PropLink, type Term, type TermType } from './types';
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
  const declared = model.props.some((p) => propKey(p.name) === key);
  const entry = model.props.find((p) => propKey(p.name) === key) ?? { name: a.name, description: '', chars: [] };
  const next = { ...entry, [link]: [...(entry[link] ?? []), other] };
  return { model: { ...model, props: declared ? model.props.map((p) => (propKey(p.name) === key ? next : p)) : [...model.props, next] }, note };
}

/** Withdraws the statement from whichever of the two properties carries it. */
export function removePropLink(model: Model, key: string, other: string, link: PropLink): Model {
  const strip = (owner: string, target: string, m: Model): Model =>
    m.props.some((p) => propKey(p.name) === owner && p[link]?.includes(target))
      ? {
          ...m,
          props: m.props.map((p) => {
            if (propKey(p.name) !== owner || !p[link]) return p;
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
  for (const p of objectProperties(model)) if (p.domain.includes(classId)) out.push({ ref: p.key, data: false, name: p.name, iri: p.iri, auto: p.domainAuto });
  for (const t of model.terms) {
    if (t.type !== 'property') continue;
    const d = dataDomain(model, t);
    if (d.ids.includes(classId)) out.push({ ref: t.id, data: true, name: t.name || 'Unnamed', iri: t.iri, auto: d.auto });
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

/** Adds the class to a property's domain. A domain that so far only followed use becomes one set by hand, with the same classes. */
export function addToDomain(model: Model, classId: string, p: { ref: string; data: boolean }): Edit {
  if (model.terms.find((t) => t.id === classId)?.type !== 'concept') return refuse('Only a class can be in a domain.');
  if (p.data) {
    const t = model.terms.find((x) => x.id === p.ref && x.type === 'property');
    if (!t) return refuse('That data property no longer exists.');
    const d = dataDomain(model, t);
    if (d.ids.includes(classId)) return refuse(`${q(nameOf(model, classId))} is already in the domain of ${q(t.name)}.`);
    return { model: { ...model, terms: model.terms.map((x) => (x.id === t.id ? { ...x, domain: [...d.ids, classId] } : x)) } };
  }
  const v = findProp(model, p.ref);
  if (!v) return refuse('That object property no longer exists.');
  if (v.domain.includes(classId)) return refuse(`${q(nameOf(model, classId))} is already in the domain of ${q(v.name)}.`);
  return { model: { ...model, props: model.props.map((x) => (propKey(x.name) === v.key ? { ...x, domain: [...v.domain, classId] } : x)) } };
}

/** Takes the class out of a domain that was set by hand. One that follows use changes only by changing the use. */
export function removeFromDomain(model: Model, classId: string, p: { ref: string; data: boolean }): Edit {
  if (p.data) {
    const t = model.terms.find((x) => x.id === p.ref);
    if (!t?.domain) return refuse('This domain follows the classes the property is attached to. Remove the restriction that attaches it instead.');
    return { model: { ...model, terms: model.terms.map((x) => (x.id === t.id ? { ...x, domain: t.domain!.filter((id) => id !== classId) } : x)) } };
  }
  const entry = model.props.find((x) => propKey(x.name) === p.ref);
  if (!entry?.domain) return refuse('This domain follows the classes the property is used between. Remove the restriction that uses it instead.');
  return { model: { ...model, props: model.props.map((x) => (x === entry ? { ...x, domain: entry.domain!.filter((id) => id !== classId) } : x)) } };
}

// ---------------------------------------------------------------- individuals

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const DOUBLE = /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/;
const ZONE = '(Z|[+-]\\d{2}:\\d{2})?';
const DATE = '-?\\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])';
const TIME = '([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?';
const SHAPES: Record<string, { test: RegExp; example: string; what: string }> = {
  'xsd:integer': { test: INTEGER, example: '42', what: 'a whole number' },
  'xsd:decimal': { test: DECIMAL, example: '3.14', what: 'a decimal number' },
  'xsd:double': { test: DOUBLE, example: '6.02e23', what: 'a number' },
  'xsd:boolean': { test: /^(true|false|1|0)$/, example: 'true', what: 'true or false' },
  'xsd:date': { test: new RegExp(`^${DATE}${ZONE}$`), example: '2024-05-17', what: 'a date' },
  'xsd:dateTime': { test: new RegExp(`^${DATE}T${TIME}${ZONE}$`), example: '2024-05-17T09:30:00', what: 'a date and time' },
  'xsd:time': { test: new RegExp(`^${TIME}${ZONE}$`), example: '09:30:00', what: 'a time' },
  'xsd:gYear': { test: new RegExp(`^-?\\d{4,}${ZONE}$`), example: '1999', what: 'a year' },
  'xsd:duration': { test: /^-?P(?=.)(\d+Y)?(\d+M)?(\d+D)?(T(?=.)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/, example: 'PT2H30M', what: 'a duration' },
  'xsd:anyURI': { test: /^[^\s<>"{}|\\^`]+$/, example: 'https://example.org/page', what: 'a link without spaces' },
};

/** What is wrong with a value as a literal of the datatype, in words; undefined when it is fine. */
export function validateLiteral(value: string, datatype?: string): string | undefined {
  if (!value.trim()) return 'Enter a value.';
  const shape = datatype ? SHAPES[datatype] : undefined;
  if (shape && !shape.test.test(value.trim())) return `${q(value.trim())} is not ${shape.what} (${datatype}). It should look like ${shape.example}.`;
  return undefined;
}

/** The datatype a value is written with: its own if it has one, or else the range of its property. */
export const datatypeOf = (model: Model, v: DataValue): string | undefined => v.dt ?? model.terms.find((t) => t.id === v.prop)?.range;

const sameValue = (a: DataValue, b: DataValue) => a.prop === b.prop && a.value === b.value && (a.lang ?? '') === (b.lang ?? '');

/** States that an individual has a literal value for a data property. */
export function addValue(model: Model, id: string, draft: { prop: string; value: string; lang?: string }): Edit {
  const ind = model.terms.find((t) => t.id === id);
  if (ind?.type !== 'instance') return refuse('Only an individual has property values.');
  const prop = model.terms.find((t) => t.id === draft.prop);
  if (prop?.type !== 'property') return refuse('Choose a data property.');
  const value = draft.value.trim();
  const lang = draft.lang?.trim().toLowerCase() || undefined;
  const bad = validateLiteral(value, prop.range);
  if (bad) return refuse(bad);
  if (lang && !isLang(lang)) return refuse(`${q(lang)} is not a language code. Use one like en, nl or zh.`);
  if (lang && prop.range && prop.range !== 'rdf:langString' && prop.range !== 'xsd:string') return refuse(`A language only goes with text. ${q(prop.name)} holds ${DATATYPES.find((d) => d.id === prop.range)?.label ?? prop.range} values.`);
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

/** States a fact: one individual is related to another by an object property. */
export function addFact(model: Model, id: string, key: string, other: string): Edit {
  const a = model.terms.find((t) => t.id === id);
  const b = model.terms.find((t) => t.id === other);
  const prop = findProp(model, key);
  if (a?.type !== 'instance') return refuse('Only an individual has property values.');
  if (!prop) return refuse('Choose an object property.');
  if (b?.type !== 'instance') return refuse('The value of an object property is another individual.');
  if (prop.rels.some((r) => r.from === id && r.to === other)) return refuse(`${q(a.name)} ${prop.name} ${q(b.name)} is already stated.`);
  const self = id === other && prop.chars.includes('irreflexive') ? `${q(prop.name)} is irreflexive, so nothing can be related to itself by it. Validation will list this.` : undefined;
  return { model: { ...model, relations: [...model.relations, newRelation({ from: id, to: other, label: prop.name })] }, note: self };
}
