import { BASE_TYPES, type BaseType, type BusinessRule, type ElementRef, type Generalization, type Key, type KeyMember, type LogicalChange, type LogicalDiagram, type LogicalDomain, type LogicalElement, type LogicalEntity, type LogicalModel, type LogicalRefusal, type LogicalType, type Relationship, type RelationshipEnd, type SemanticMapping, type UpdateTarget } from './contracts';

/**
 * Logical data models as data: read safely from what was stored, changed by logical change sets,
 * and held to their rules (SYSTEM_ARCHITECTURE.md §13.3). Pure functions over plain data; nothing
 * here knows the ontology, the store or a view.
 */

let made = 0;
const random = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
/** A new id for an LDM or an element: unique, never reused. */
export const newId = (prefix: string): string => `${prefix}-${random()}`;
/** A new revision of an LDM. */
export const newRevision = (): string => `r-${(++made).toString(36)}-${random().slice(0, 8)}`;

export function emptyLogicalModel(input: { id?: string; name: string; description?: string; purpose?: string }): LogicalModel {
  return { id: input.id ?? newId('ldm'), name: input.name.trim(), description: input.description?.trim() ?? '', purpose: input.purpose?.trim() ?? '', revision: newRevision(), domains: [], entities: [], relationships: [], generalizations: [], rules: [], mappings: [], diagrams: [] };
}

// ---------------------------------------------------------------- reading what was stored

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : []);

function baseTypeFrom(v: unknown): BaseType | undefined {
  const o = obj(v);
  const base = str(o?.base);
  if (!o || !(BASE_TYPES as readonly string[]).includes(base)) return undefined;
  if (base === 'text') return { base, ...(int(o.maxLength) !== undefined ? { maxLength: int(o.maxLength)! } : {}) };
  if (base === 'decimal') return { base, ...(int(o.precision) !== undefined ? { precision: int(o.precision)! } : {}), ...(int(o.scale) !== undefined ? { scale: int(o.scale)! } : {}) };
  return { base: base as Exclude<BaseType['base'], 'text' | 'decimal'> };
}
const typeFrom = (v: unknown): LogicalType | undefined => (str(obj(v)?.domain) ? { domain: str(obj(v)!.domain) } : baseTypeFrom(v));

const ELEMENT_KINDS = ['entity', 'attribute', 'key', 'relationship', 'generalization', 'rule', 'domain', 'mapping', 'diagram'] as const;
function refFrom(v: unknown): ElementRef | undefined {
  const o = obj(v);
  if (!o) return undefined;
  for (const k of ELEMENT_KINDS) if (str(o[k])) return { [k]: str(o[k]) } as ElementRef;
  return undefined;
}

function memberFrom(v: unknown): KeyMember | undefined {
  const o = obj(v);
  if (str(o?.attribute)) return { attribute: str(o!.attribute) };
  const end = obj(o?.end);
  if (end && str(end.relationship) && (end.end === 0 || end.end === 1)) return { end: { relationship: str(end.relationship), end: end.end } };
  return undefined;
}

function endFrom(v: unknown): RelationshipEnd | undefined {
  const o = obj(v);
  if (!o || !str(o.entity)) return undefined;
  return { entity: str(o.entity), role: str(o.role), min: int(o.min) ?? 0, max: o.max === 'many' ? 'many' : (int(o.max) ?? 'many') };
}

/** One LDM as it was stored, read with what does not read left out; nothing about it is taken on trust. */
export function logicalModelFrom(v: unknown): LogicalModel | undefined {
  const o = obj(v);
  if (!o || !str(o.id)) return undefined;
  const entities: LogicalEntity[] = list(o.entities)
    .filter((e) => str(e.id))
    .map((e) => ({
      id: str(e.id),
      name: str(e.name),
      definition: str(e.definition),
      ...(e.abstract === true ? { abstract: true } : {}),
      attributes: list(e.attributes)
        .filter((a) => str(a.id) && typeFrom(a.type))
        .map((a) => ({ id: str(a.id), name: str(a.name), definition: str(a.definition), type: typeFrom(a.type)!, optional: a.optional !== false, ...(a.derived === true ? { derived: true } : {}) })),
      keys: list(e.keys)
        .filter((k) => str(k.id))
        .map((k): Key => ({ id: str(k.id), kind: k.kind === 'primary' ? 'primary' : 'candidate', name: str(k.name), members: (Array.isArray(k.members) ? k.members : []).map(memberFrom).filter((m): m is KeyMember => !!m) })),
    }));
  const relationships: Relationship[] = list(o.relationships)
    .map((r) => {
      const ends = Array.isArray(r.ends) ? r.ends.map(endFrom) : [];
      return str(r.id) && ends.length === 2 && ends[0] && ends[1] ? { id: str(r.id), name: str(r.name), definition: str(r.definition), ends: [ends[0], ends[1]] as [RelationshipEnd, RelationshipEnd], identifying: r.identifying === true } : undefined;
    })
    .filter((r): r is Relationship => !!r);
  const generalizations: Generalization[] = list(o.generalizations)
    .filter((g) => str(g.id) && str(g.supertype))
    .map((g) => ({ id: str(g.id), supertype: str(g.supertype), subtypes: (Array.isArray(g.subtypes) ? g.subtypes : []).map(str).filter(Boolean), complete: g.complete === true, exclusive: g.exclusive === true, ...(str(g.discriminator) ? { discriminator: str(g.discriminator) } : {}) }));
  const rules: BusinessRule[] = list(o.rules)
    .filter((r) => str(r.id))
    .map((r) => ({ id: str(r.id), name: str(r.name), statement: str(r.statement), kind: r.kind === 'derivation' ? 'derivation' : 'constraint', appliesTo: (Array.isArray(r.appliesTo) ? r.appliesTo : []).map(refFrom).filter((x): x is ElementRef => !!x), ...(str(r.expression) ? { expression: str(r.expression) } : {}), status: r.status === 'accepted' ? 'accepted' : 'proposed' }));
  const domains: LogicalDomain[] = list(o.domains)
    .filter((d) => str(d.id) && baseTypeFrom(d.base))
    .map((d) => {
      const c = obj(d.constraints) ?? {};
      const values = list(c.values).map((x) => ({ code: str(x.code), label: str(x.label) }));
      return {
        id: str(d.id),
        name: str(d.name),
        definition: str(d.definition),
        base: baseTypeFrom(d.base)!,
        constraints: {
          ...(int(c.minLength) !== undefined ? { minLength: int(c.minLength)! } : {}),
          ...(int(c.maxLength) !== undefined ? { maxLength: int(c.maxLength)! } : {}),
          ...(str(c.pattern) ? { pattern: str(c.pattern) } : {}),
          ...(str(c.min) ? { min: str(c.min) } : {}),
          ...(str(c.max) ? { max: str(c.max) } : {}),
          ...(Array.isArray(c.values) ? { values } : {}),
        },
      };
    });
  const mappings: SemanticMapping[] = list(o.mappings)
    .filter((m) => str(m.id))
    .map((m) => {
      const origin = obj(m.origin) ?? {};
      const madeBy = obj(m.made) ?? {};
      const by = str(madeBy.by);
      return {
        id: str(m.id),
        sources: list(m.sources).map((s) => ({ iri: str(s.iri), axioms: (Array.isArray(s.axioms) ? s.axioms : []).map(str).filter(Boolean) })).filter((s) => s.iri),
        targets: (Array.isArray(m.targets) ? m.targets : []).map(refFrom).filter((x): x is ElementRef => !!x),
        strategy: str(m.strategy),
        rationale: str(m.rationale),
        origin: { ontology: str(origin.ontology), revision: str(origin.revision), ...(str(origin.version) ? { version: str(origin.version) } : {}) },
        baseline: obj(m.baseline) ?? {},
        made: { by: by === 'transformation' || by === 'synchronization' || by === 'assistant' ? by : 'hand', at: typeof madeBy.at === 'number' ? madeBy.at : 0, ...(str(madeBy.author) ? { author: str(madeBy.author) } : {}) },
      };
    });
  const diagrams: LogicalDiagram[] = list(o.diagrams)
    .filter((d) => str(d.id))
    .map((d) => {
      const positions: LogicalDiagram['positions'] = {};
      for (const [k, p] of Object.entries(obj(d.positions) ?? {})) {
        const q = obj(p);
        if (q && typeof q.x === 'number' && typeof q.y === 'number' && Number.isFinite(q.x) && Number.isFinite(q.y)) positions[k] = { x: q.x, y: q.y };
      }
      return { id: str(d.id), name: str(d.name), positions };
    });
  return { id: str(o.id), name: str(o.name), description: str(o.description), purpose: str(o.purpose), revision: str(o.revision) || newRevision(), domains, entities, relationships, generalizations, rules, mappings, diagrams };
}

/** The LDMs of a model as they were stored: each read safely, the first of any two with one id kept. */
export function logicalModelsFrom(v: unknown): LogicalModel[] {
  const out: LogicalModel[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const m = logicalModelFrom(raw);
    if (m && !out.some((x) => x.id === m.id)) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------- finding elements

const keyOf = (r: ElementRef) => Object.keys(r)[0] as keyof ElementRef & string;
const idOf = (r: ElementRef) => (r as Record<string, string>)[keyOf(r)];

/** The reference to what an element of a change is. */
export function refOf(e: LogicalElement): ElementRef {
  switch (e.kind) {
    case 'entity':
      return { entity: e.entity.id };
    case 'attribute':
      return { attribute: e.attribute.id };
    case 'key':
      return { key: e.key.id };
    case 'relationship':
      return { relationship: e.relationship.id };
    case 'generalization':
      return { generalization: e.generalization.id };
    case 'rule':
      return { rule: e.rule.id };
    case 'domain':
      return { domain: e.domain.id };
    case 'mapping':
      return { mapping: e.mapping.id };
    case 'diagram':
      return { diagram: e.diagram.id };
  }
}

/** Every id in an LDM, of every kind of element. */
export function idsOf(m: LogicalModel): Set<string> {
  const ids = new Set<string>();
  for (const e of m.entities) {
    ids.add(e.id);
    for (const a of e.attributes) ids.add(a.id);
    for (const k of e.keys) ids.add(k.id);
  }
  for (const xs of [m.relationships, m.generalizations, m.rules, m.domains, m.mappings, m.diagrams]) for (const x of xs) ids.add(x.id);
  return ids;
}

/** An element of an LDM by reference, as a change would name it; nothing where there is none. */
export function elementOf(m: LogicalModel, ref: ElementRef): LogicalElement | undefined {
  const id = idOf(ref);
  switch (keyOf(ref)) {
    case 'entity': {
      const entity = m.entities.find((e) => e.id === id);
      return entity && { kind: 'entity', entity };
    }
    case 'attribute':
      for (const e of m.entities) for (const attribute of e.attributes) if (attribute.id === id) return { kind: 'attribute', entity: e.id, attribute };
      return undefined;
    case 'key':
      for (const e of m.entities) for (const key of e.keys) if (key.id === id) return { kind: 'key', entity: e.id, key };
      return undefined;
    case 'relationship': {
      const relationship = m.relationships.find((x) => x.id === id);
      return relationship && { kind: 'relationship', relationship };
    }
    case 'generalization': {
      const generalization = m.generalizations.find((x) => x.id === id);
      return generalization && { kind: 'generalization', generalization };
    }
    case 'rule': {
      const rule = m.rules.find((x) => x.id === id);
      return rule && { kind: 'rule', rule };
    }
    case 'domain': {
      const domain = m.domains.find((x) => x.id === id);
      return domain && { kind: 'domain', domain };
    }
    case 'mapping': {
      const mapping = m.mappings.find((x) => x.id === id);
      return mapping && { kind: 'mapping', mapping };
    }
    case 'diagram': {
      const diagram = m.diagrams.find((x) => x.id === id);
      return diagram && { kind: 'diagram', diagram };
    }
  }
  return undefined;
}

/** Whether two plain values are the same: by content, in any order of their fields. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const kx = Object.keys(x).filter((k) => x[k] !== undefined);
  const ky = Object.keys(y).filter((k) => y[k] !== undefined);
  return kx.length === ky.length && kx.every((k) => same(x[k], y[k]));
}

/** The supertypes of each entity, nearest first, each once; a cycle is followed no further. */
export function supertypesOf(m: LogicalModel): Map<string, string[]> {
  const direct = new Map<string, string[]>();
  for (const g of m.generalizations) for (const s of g.subtypes) direct.set(s, [...(direct.get(s) ?? []), g.supertype]);
  const out = new Map<string, string[]>();
  for (const e of m.entities) {
    const seen: string[] = [];
    const todo = [...(direct.get(e.id) ?? [])];
    while (todo.length) {
      const s = todo.shift()!;
      if (s === e.id || seen.includes(s)) continue;
      seen.push(s);
      todo.push(...(direct.get(s) ?? []));
    }
    out.set(e.id, seen);
  }
  return out;
}

// ---------------------------------------------------------------- the rules

const norm = (s: string) => s.trim().toLowerCase();
const isCount = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

function typeProblem(t: LogicalType | BaseType, domains: Set<string>): string | undefined {
  if ('domain' in t) return domains.has(t.domain) ? undefined : 'its domain is not in the model';
  if (!(BASE_TYPES as readonly string[]).includes(t.base)) return `“${String(t.base)}” is not a logical type`;
  if (t.base === 'text' && t.maxLength !== undefined && !(isCount(t.maxLength) && t.maxLength > 0)) return 'its maximum length has to be a whole number above 0';
  if (t.base === 'decimal') {
    if (t.precision !== undefined && !(isCount(t.precision) && t.precision > 0)) return 'its precision has to be a whole number above 0';
    if (t.scale !== undefined && !isCount(t.scale)) return 'its scale has to be a whole number, 0 or more';
    if (t.precision !== undefined && t.scale !== undefined && t.scale > t.precision) return 'its scale cannot be larger than its precision';
  }
  return undefined;
}

/**
 * What in an LDM breaks its rules, each in words with the element it is about. An LDM that breaks
 * none is one the edit service may keep; a change set that would leave one breaking any is refused.
 */
export function problemsOf(m: LogicalModel): LogicalRefusal[] {
  const out: LogicalRefusal[] = [];
  const refuse = (message: string, element?: ElementRef | { model: true }) => out.push({ code: 'refused', message, ...(element ? { element } : {}) });
  const invalid = (message: string, element?: ElementRef | { model: true }) => out.push({ code: 'invalid', message, ...(element ? { element } : {}) });
  if (!m.name.trim()) invalid('A logical model needs a name.', { model: true });

  // Every id once, whatever the kind of element.
  const seen = new Set<string>();
  const once = (id: string, element: ElementRef) => {
    if (!id) invalid('An element has no id.', element);
    else if (seen.has(id)) invalid(`The id “${id}” is given to two elements.`, element);
    seen.add(id);
  };
  for (const e of m.entities) {
    once(e.id, { entity: e.id });
    for (const a of e.attributes) once(a.id, { attribute: a.id });
    for (const k of e.keys) once(k.id, { key: k.id });
  }
  for (const r of m.relationships) once(r.id, { relationship: r.id });
  for (const g of m.generalizations) once(g.id, { generalization: g.id });
  for (const r of m.rules) once(r.id, { rule: r.id });
  for (const d of m.domains) once(d.id, { domain: d.id });
  for (const x of m.mappings) once(x.id, { mapping: x.id });
  for (const d of m.diagrams) once(d.id, { diagram: d.id });

  const entities = new Map(m.entities.map((e) => [e.id, e]));
  const name = (id: string) => `“${entities.get(id)?.name || id}”`;
  const domainIds = new Set(m.domains.map((d) => d.id));
  const relationships = new Map(m.relationships.map((r) => [r.id, r]));
  const supers = supertypesOf(m);
  const inheritedOf = (id: string) => (supers.get(id) ?? []).flatMap((s) => entities.get(s)?.attributes ?? []);

  const names = new Map<string, string>();
  for (const d of m.domains) {
    if (!d.name.trim()) invalid('A domain needs a name.', { domain: d.id });
    else if (names.has('d ' + norm(d.name))) refuse(`Two domains are called “${d.name.trim()}”.`, { domain: d.id });
    names.set('d ' + norm(d.name), d.id);
    const p = typeProblem(d.base, domainIds);
    if (p) invalid(`The domain “${d.name}”: ${p}.`, { domain: d.id });
    const c = d.constraints;
    if (c.minLength !== undefined && c.maxLength !== undefined && c.minLength > c.maxLength) refuse(`The domain “${d.name}”: its minimum length is above its maximum.`, { domain: d.id });
    const codes = new Set<string>();
    for (const v of c.values ?? []) {
      if (!v.code.trim()) invalid(`The domain “${d.name}” has a value with no code.`, { domain: d.id });
      else if (codes.has(v.code)) refuse(`The domain “${d.name}” lists the code “${v.code}” twice.`, { domain: d.id });
      codes.add(v.code);
    }
  }

  for (const e of m.entities) {
    if (!e.name.trim()) invalid('An entity needs a name.', { entity: e.id });
    else if (names.has('e ' + norm(e.name))) refuse(`Two entities are called “${e.name.trim()}”.`, { entity: e.id });
    names.set('e ' + norm(e.name), e.id);
    const inherited = new Map(inheritedOf(e.id).map((a) => [norm(a.name), a]));
    const own = new Set<string>();
    for (const a of e.attributes) {
      if (!a.name.trim()) invalid(`An attribute of ${name(e.id)} needs a name.`, { attribute: a.id });
      else if (own.has(norm(a.name))) refuse(`${name(e.id)} has two attributes called “${a.name.trim()}”.`, { attribute: a.id });
      else if (inherited.has(norm(a.name))) refuse(`${name(e.id)} inherits an attribute called “${a.name.trim()}” already.`, { attribute: a.id });
      own.add(norm(a.name));
      const p = typeProblem(a.type, domainIds);
      if (p) invalid(`The attribute “${a.name}” of ${name(e.id)}: ${p}.`, { attribute: a.id });
    }
    const usable = new Set([...e.attributes, ...inheritedOf(e.id)].map((a) => a.id));
    const keyNames = new Set<string>();
    if (e.keys.filter((k) => k.kind === 'primary').length > 1) refuse(`${name(e.id)} has more than one primary key.`, { entity: e.id });
    for (const k of e.keys) {
      if (k.name.trim() && keyNames.has(norm(k.name))) refuse(`${name(e.id)} has two keys called “${k.name.trim()}”.`, { key: k.id });
      keyNames.add(norm(k.name));
      if (!k.members.length) invalid(`A key of ${name(e.id)} has no members.`, { key: k.id });
      for (const member of k.members) {
        if ('attribute' in member) {
          if (!usable.has(member.attribute)) refuse(`A key of ${name(e.id)} names an attribute it does not have.`, { key: k.id });
        } else {
          const r = relationships.get(member.end.relationship);
          if (!r) refuse(`A key of ${name(e.id)} names a relationship that is not in the model.`, { key: k.id });
          else if (!r.identifying || r.ends[0].entity !== e.id || member.end.end !== 1) refuse(`A key of ${name(e.id)} can take in only the parent end of an identifying relationship of which ${name(e.id)} is the child.`, { key: k.id });
        }
      }
    }
  }

  for (const r of m.relationships) {
    for (const end of r.ends) {
      if (!entities.has(end.entity)) refuse(`The relationship “${r.name || r.id}” has an end at an entity that is not in the model.`, { relationship: r.id });
      if (!isCount(end.min)) invalid(`The relationship “${r.name || r.id}”: a minimum has to be a whole number, 0 or more.`, { relationship: r.id });
      else if (end.max !== 'many' && !(isCount(end.max) && end.max >= 1 && end.max >= end.min)) invalid(`The relationship “${r.name || r.id}”: a maximum has to be “many”, or a whole number of at least 1 and at least the minimum.`, { relationship: r.id });
    }
  }

  // Generalizations: what they name is there, a subtype is not its own supertype, and no entity is above itself.
  for (const g of m.generalizations) {
    if (!entities.has(g.supertype)) refuse('A generalization names a supertype that is not in the model.', { generalization: g.id });
    if (!g.subtypes.length) invalid(`The generalization of ${name(g.supertype)} has no subtypes.`, { generalization: g.id });
    if (new Set(g.subtypes).size !== g.subtypes.length) invalid(`The generalization of ${name(g.supertype)} names a subtype twice.`, { generalization: g.id });
    for (const s of g.subtypes) if (!entities.has(s)) refuse(`The generalization of ${name(g.supertype)} names a subtype that is not in the model.`, { generalization: g.id });
    if (g.subtypes.includes(g.supertype)) refuse(`${name(g.supertype)} cannot be a subtype of itself.`, { generalization: g.id });
    if (g.discriminator && !(entities.get(g.supertype)?.attributes ?? []).concat(inheritedOf(g.supertype)).some((a) => a.id === g.discriminator)) refuse(`The discriminator of the generalization of ${name(g.supertype)} is not an attribute of it.`, { generalization: g.id });
  }
  const below = new Map<string, string[]>();
  for (const g of m.generalizations) for (const s of g.subtypes) below.set(g.supertype, [...(below.get(g.supertype) ?? []), s]);
  const state = new Map<string, 'open' | 'done'>();
  const cyclic = (id: string): boolean => {
    if (state.get(id) === 'open') return true;
    if (state.get(id) === 'done') return false;
    state.set(id, 'open');
    const found = (below.get(id) ?? []).some(cyclic);
    state.set(id, 'done');
    return found;
  };
  for (const id of below.keys())
    if (cyclic(id)) {
      refuse(`The generalizations go round in a circle through ${name(id)}: no entity can be above itself.`, { entity: id });
      break;
    }

  const all = idsOf(m);
  for (const r of m.rules) {
    if (!r.name.trim()) invalid('A business rule needs a name.', { rule: r.id });
    if (!r.statement.trim()) invalid(`The business rule “${r.name}” needs a statement in words.`, { rule: r.id });
    for (const ref of r.appliesTo) if (!all.has(idOf(ref))) refuse(`The business rule “${r.name}” applies to an element that is not in the model.`, { rule: r.id });
  }
  for (const x of m.mappings) for (const ref of x.targets) if (!all.has(idOf(ref))) refuse('A semantic mapping names an element that is not in the model.', { mapping: x.id });
  for (const d of m.diagrams) for (const id of Object.keys(d.positions)) if (!entities.has(id)) refuse(`The diagram “${d.name}” places an entity that is not in the model.`, { diagram: d.id });
  return out;
}

// ---------------------------------------------------------------- applying changes

/** The fields an update may change, for each kind of target: never an id, never what belongs to other elements. */
const UPDATABLE: Record<string, readonly string[]> = {
  model: ['name', 'description', 'purpose'],
  entity: ['name', 'definition', 'abstract'],
  attribute: ['name', 'definition', 'type', 'optional', 'derived'],
  key: ['kind', 'name', 'members'],
  relationship: ['name', 'definition', 'ends', 'identifying'],
  generalization: ['supertype', 'subtypes', 'complete', 'exclusive', 'discriminator'],
  rule: ['name', 'statement', 'kind', 'appliesTo', 'expression', 'status'],
  domain: ['name', 'definition', 'base', 'constraints'],
  mapping: ['sources', 'targets', 'strategy', 'rationale', 'origin', 'baseline', 'made'],
  diagram: ['name', 'positions'],
};

const nameOfElement = (e: LogicalElement): string => {
  switch (e.kind) {
    case 'entity':
      return `the entity “${e.entity.name}”`;
    case 'attribute':
      return `the attribute “${e.attribute.name}”`;
    case 'key':
      return `the key “${e.key.name || e.key.id}”`;
    case 'relationship':
      return `the relationship “${e.relationship.name || e.relationship.id}”`;
    case 'generalization':
      return 'a generalization';
    case 'rule':
      return `the business rule “${e.rule.name}”`;
    case 'domain':
      return `the domain “${e.domain.name}”`;
    case 'mapping':
      return 'a semantic mapping';
    case 'diagram':
      return `the diagram “${e.diagram.name}”`;
  }
};

/** An element added to an LDM, or taken out of it. */
function withElement(m: LogicalModel, e: LogicalElement, add: boolean): LogicalModel {
  const put = <T extends { id: string }>(xs: T[], x: T) => (add ? [...xs, x] : xs.filter((y) => y.id !== x.id));
  switch (e.kind) {
    case 'entity':
      return { ...m, entities: put(m.entities, e.entity) };
    case 'attribute':
      return { ...m, entities: m.entities.map((x) => (x.id === e.entity ? { ...x, attributes: put(x.attributes, e.attribute) } : x)) };
    case 'key':
      return { ...m, entities: m.entities.map((x) => (x.id === e.entity ? { ...x, keys: put(x.keys, e.key) } : x)) };
    case 'relationship':
      return { ...m, relationships: put(m.relationships, e.relationship) };
    case 'generalization':
      return { ...m, generalizations: put(m.generalizations, e.generalization) };
    case 'rule':
      return { ...m, rules: put(m.rules, e.rule) };
    case 'domain':
      return { ...m, domains: put(m.domains, e.domain) };
    case 'mapping':
      return { ...m, mappings: put(m.mappings, e.mapping) };
    case 'diagram':
      return { ...m, diagrams: put(m.diagrams, e.diagram) };
  }
}

/** An element with some of its fields replaced. */
function updated(m: LogicalModel, target: UpdateTarget, after: Record<string, unknown>): LogicalModel {
  const apply = <T>(x: T): T => {
    const next = { ...x } as Record<string, unknown>;
    for (const [k, v] of Object.entries(after)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    return next as T;
  };
  if ('model' in target) return apply(m);
  const id = idOf(target);
  switch (keyOf(target)) {
    case 'entity':
      return { ...m, entities: m.entities.map((x) => (x.id === id ? apply(x) : x)) };
    case 'attribute':
      return { ...m, entities: m.entities.map((x) => (x.attributes.some((a) => a.id === id) ? { ...x, attributes: x.attributes.map((a) => (a.id === id ? apply(a) : a)) } : x)) };
    case 'key':
      return { ...m, entities: m.entities.map((x) => (x.keys.some((k) => k.id === id) ? { ...x, keys: x.keys.map((k) => (k.id === id ? apply(k) : k)) } : x)) };
    case 'relationship':
      return { ...m, relationships: m.relationships.map((x) => (x.id === id ? apply(x) : x)) };
    case 'generalization':
      return { ...m, generalizations: m.generalizations.map((x) => (x.id === id ? apply(x) : x)) };
    case 'rule':
      return { ...m, rules: m.rules.map((x) => (x.id === id ? apply(x) : x)) };
    case 'domain':
      return { ...m, domains: m.domains.map((x) => (x.id === id ? apply(x) : x)) };
    case 'mapping':
      return { ...m, mappings: m.mappings.map((x) => (x.id === id ? apply(x) : x)) };
    case 'diagram':
      return { ...m, diagrams: m.diagrams.map((x) => (x.id === id ? apply(x) : x)) };
  }
  return m;
}

/**
 * An LDM with a change set's changes applied in order, and held to its rules: the next LDM, or why
 * not. Each change is checked against the LDM as the changes before it left it: an add of an id
 * the LDM has is refused, a remove of an element that is not exactly as the change says, and an
 * update of fields that are not as its `before` says.
 */
export function applied(m: LogicalModel, changes: LogicalChange[]): { next: LogicalModel; refusals: [] } | { next?: undefined; refusals: LogicalRefusal[] } {
  let next = m;
  let ids = idsOf(m);
  for (const [n, c] of changes.entries()) {
    const at = `Change ${n + 1}`;
    if (c.op === 'add' || c.op === 'remove') {
      if (!c.element || !(['entity', 'attribute', 'key', 'relationship', 'generalization', 'rule', 'domain', 'mapping', 'diagram'] as const).includes(c.element.kind)) return { refusals: [{ code: 'invalid', message: `${at} names no element.` }] };
      const ref = refOf(c.element);
      if (c.op === 'add') {
        if (ids.has(idOf(ref))) return { refusals: [{ code: 'refused', message: `${at}: the model has an element with the id “${idOf(ref)}” already.`, element: ref }] };
        if ((c.element.kind === 'attribute' || c.element.kind === 'key') && !next.entities.some((e) => e.id === (c.element as { entity: string }).entity)) return { refusals: [{ code: 'refused', message: `${at}: ${nameOfElement(c.element)} is for an entity that is not in the model.`, element: ref }] };
        if (c.element.kind === 'entity') for (const x of [...c.element.entity.attributes, ...c.element.entity.keys]) if (ids.has(x.id)) return { refusals: [{ code: 'refused', message: `${at}: the model has an element with the id “${x.id}” already.`, element: ref }] };
        next = withElement(next, c.element, true);
      } else {
        const there = elementOf(next, ref);
        if (!there) return { refusals: [{ code: 'refused', message: `${at}: ${nameOfElement(c.element)} is not in the model.`, element: ref }] };
        if (!same(there, c.element)) return { refusals: [{ code: 'refused', message: `${at}: ${nameOfElement(c.element)} is not as the change says: it has been changed since.`, element: ref }] };
        next = withElement(next, c.element, false);
      }
      ids = idsOf(next);
      continue;
    }
    if (c.op !== 'update' || !c.target) return { refusals: [{ code: 'invalid', message: `${at} is not an addition, a removal or an update.` }] };
    const kind = 'model' in c.target ? 'model' : keyOf(c.target);
    const allowed = UPDATABLE[kind];
    const fields = [...Object.keys(c.before ?? {}), ...Object.keys(c.after ?? {})];
    const wrong = fields.find((f) => !allowed?.includes(f));
    if (wrong) return { refusals: [{ code: 'invalid', message: `${at}: “${wrong}” is not a field that can be changed here.`, element: c.target }] };
    const current: Record<string, unknown> | undefined = 'model' in c.target ? (next as unknown as Record<string, unknown>) : (() => {
      const e = elementOf(next, c.target as ElementRef);
      if (!e) return undefined;
      return (e as unknown as Record<string, unknown>)[e.kind] as Record<string, unknown>;
    })();
    if (!current) return { refusals: [{ code: 'refused', message: `${at}: what it changes is not in the model.`, element: c.target }] };
    for (const [k, v] of Object.entries(c.before ?? {})) if (!same(current[k], v)) return { refusals: [{ code: 'refused', message: `${at}: “${k}” is not as the change says: it has been changed since.`, element: c.target }] };
    next = updated(next, c.target, c.after ?? {});
  }
  const problems = problemsOf(next);
  return problems.length ? { refusals: problems } : { next, refusals: [] };
}

/**
 * The changes that take an element out of an LDM with everything that would otherwise name what is
 * no longer there: for an entity, its relationships, the generalizations it is in (or it alone is
 * taken out of), the keys of other entities that borrow its identity, the rules and mappings that
 * name it, and its place on the diagrams; for an attribute, the keys and discriminators it is in.
 * Each removal is of the element as it is, so that applying the changes is checked like any other.
 */
export function removalOf(m: LogicalModel, ref: ElementRef): LogicalChange[] {
  const element = elementOf(m, ref);
  if (!element) return [];
  const changes: LogicalChange[] = [];
  const gone = new Set<string>([idOf(ref)]);
  if (element.kind === 'entity') for (const x of [...element.entity.attributes, ...element.entity.keys]) gone.add(x.id);
  const relationships = element.kind === 'entity' ? m.relationships.filter((r) => r.ends.some((e) => e.entity === element.entity.id)) : element.kind === 'relationship' ? [element.relationship] : [];
  for (const r of relationships) gone.add(r.id);
  // Keys elsewhere that name what goes: taken out, or (for a key with other members) left with the rest.
  for (const e of m.entities) {
    if (element.kind === 'entity' && e.id === element.entity.id) continue;
    for (const k of e.keys) {
      const left = k.members.filter((x) => ('attribute' in x ? !gone.has(x.attribute) : !gone.has(x.end.relationship)));
      if (left.length === k.members.length) continue;
      if (left.length) changes.push({ op: 'update', target: { key: k.id }, before: { members: k.members }, after: { members: left } });
      else changes.push({ op: 'remove', element: { kind: 'key', entity: e.id, key: k } });
      gone.add(k.id);
    }
  }
  if (element.kind !== 'relationship') for (const r of relationships) changes.push({ op: 'remove', element: { kind: 'relationship', relationship: r } });
  for (const g of m.generalizations) {
    if (element.kind === 'entity' && (g.supertype === element.entity.id || (g.subtypes.includes(element.entity.id) && g.subtypes.length === 1))) {
      changes.push({ op: 'remove', element: { kind: 'generalization', generalization: g } });
      gone.add(g.id);
    } else if (element.kind === 'entity' && g.subtypes.includes(element.entity.id)) {
      changes.push({ op: 'update', target: { generalization: g.id }, before: { subtypes: g.subtypes }, after: { subtypes: g.subtypes.filter((s) => s !== element.entity.id) } });
    } else if (element.kind === 'attribute' && g.discriminator === element.attribute.id) {
      changes.push({ op: 'update', target: { generalization: g.id }, before: { discriminator: g.discriminator }, after: { discriminator: undefined } });
    }
  }
  for (const r of m.rules) {
    const left = r.appliesTo.filter((x) => !gone.has(idOf(x)));
    if (left.length !== r.appliesTo.length) changes.push({ op: 'update', target: { rule: r.id }, before: { appliesTo: r.appliesTo }, after: { appliesTo: left } });
  }
  for (const x of m.mappings) {
    const left = x.targets.filter((t) => !gone.has(idOf(t)));
    if (left.length !== x.targets.length) changes.push({ op: 'update', target: { mapping: x.id }, before: { targets: x.targets }, after: { targets: left } });
  }
  if (element.kind === 'entity')
    for (const d of m.diagrams)
      if (element.entity.id in d.positions) {
        const { [element.entity.id]: _gone, ...positions } = d.positions;
        changes.push({ op: 'update', target: { diagram: d.id }, before: { positions: d.positions }, after: { positions } });
      }
  // Keys of the entity that name an attribute that goes are the attribute's own business.
  if (element.kind === 'attribute') {
    const owner = m.entities.find((e) => e.attributes.some((a) => a.id === element.attribute.id))!;
    for (const k of owner.keys) {
      const left = k.members.filter((x) => !('attribute' in x && x.attribute === element.attribute.id));
      if (left.length === k.members.length) continue;
      changes.push(left.length ? { op: 'update', target: { key: k.id }, before: { members: k.members }, after: { members: left } } : { op: 'remove', element: { kind: 'key', entity: owner.id, key: k } });
    }
  }
  changes.push({ op: 'remove', element });
  return changes;
}

/** An LDM copied with new ids throughout, every reference following: independent of the original. */
export function copied(m: LogicalModel, name: string): LogicalModel {
  const fresh = new Map<string, string>();
  const to = (id: string, prefix: string) => {
    if (!fresh.has(id)) fresh.set(id, newId(prefix));
    return fresh.get(id)!;
  };
  for (const e of m.entities) {
    to(e.id, 'e');
    for (const a of e.attributes) to(a.id, 'a');
    for (const k of e.keys) to(k.id, 'k');
  }
  for (const r of m.relationships) to(r.id, 'r');
  for (const g of m.generalizations) to(g.id, 'g');
  for (const r of m.rules) to(r.id, 'b');
  for (const d of m.domains) to(d.id, 'd');
  for (const x of m.mappings) to(x.id, 'm');
  for (const d of m.diagrams) to(d.id, 'v');
  const id = (x: string) => fresh.get(x) ?? x;
  const ref = (r: ElementRef): ElementRef => ({ [keyOf(r)]: id(idOf(r)) }) as ElementRef;
  const type = (t: LogicalType): LogicalType => ('domain' in t ? { domain: id(t.domain) } : t);
  return {
    ...m,
    id: newId('ldm'),
    name,
    revision: newRevision(),
    domains: m.domains.map((d) => ({ ...d, id: id(d.id) })),
    entities: m.entities.map((e) => ({
      ...e,
      id: id(e.id),
      attributes: e.attributes.map((a) => ({ ...a, id: id(a.id), type: type(a.type) })),
      keys: e.keys.map((k) => ({ ...k, id: id(k.id), members: k.members.map((x): KeyMember => ('attribute' in x ? { attribute: id(x.attribute) } : { end: { relationship: id(x.end.relationship), end: x.end.end } })) })),
    })),
    relationships: m.relationships.map((r) => ({ ...r, id: id(r.id), ends: [{ ...r.ends[0], entity: id(r.ends[0].entity) }, { ...r.ends[1], entity: id(r.ends[1].entity) }] })),
    generalizations: m.generalizations.map((g) => ({ ...g, id: id(g.id), supertype: id(g.supertype), subtypes: g.subtypes.map(id), ...(g.discriminator ? { discriminator: id(g.discriminator) } : {}) })),
    rules: m.rules.map((r) => ({ ...r, id: id(r.id), appliesTo: r.appliesTo.map(ref) })),
    mappings: m.mappings.map((x) => ({ ...x, id: id(x.id), targets: x.targets.map(ref) })),
    diagrams: m.diagrams.map((d) => ({ ...d, id: id(d.id), positions: Object.fromEntries(Object.entries(d.positions).map(([k, p]) => [id(k), p])) })),
  };
}

/** How much is in an LDM. */
export const countsOf = (m: LogicalModel) => ({
  entities: m.entities.length,
  attributes: m.entities.reduce((n, e) => n + e.attributes.length, 0),
  relationships: m.relationships.length,
  keys: m.entities.reduce((n, e) => n + e.keys.length, 0),
  generalizations: m.generalizations.length,
  rules: m.rules.length,
  domains: m.domains.length,
});
