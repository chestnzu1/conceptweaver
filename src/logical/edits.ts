import { BASE_TYPES, type BaseType, type BusinessRule, type ElementRef, type Generalization, type Key, type KeyMember, type LogicalAttribute, type LogicalChange, type LogicalDomain, type LogicalEntity, type LogicalModel, type LogicalType, type Relationship, type RelationshipEnd, type UpdateTarget } from './contracts';
import { newId, supertypesOf } from './rules';

/**
 * The changes an editor makes (roadmap LM-2): each small enough to be one step of the history and
 * expressed as a logical change set, so that nothing here writes an LDM directly. Pure functions
 * over plain data: what is made is valid to begin with, and the edit service holds it to the
 * rules like any other change.
 */

const norm = (s: string) => s.trim().toLowerCase();

/** A name none of `taken` has, whatever its case: the name itself, or the first of “(2)”, “(3)”, … */
export function freeName(taken: Iterable<string>, base: string): string {
  const have = new Set([...taken].map(norm));
  const clean = base.trim() || 'Untitled';
  if (!have.has(norm(clean))) return clean;
  for (let n = 2; ; n++) if (!have.has(norm(`${clean} ${n}`))) return `${clean} ${n}`;
}

/** An update of the fields of one element, its `before` being the element as it now is. */
export function updatedChange(target: UpdateTarget, current: object, after: Record<string, unknown>): LogicalChange {
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(after)) before[key] = (current as Record<string, unknown>)[key];
  return { op: 'update', target, before, after };
}

export interface Added {
  id: string;
  change: LogicalChange;
}

const entityOf = (m: LogicalModel, id: string) => m.entities.find((e) => e.id === id);

/** The attributes an entity has, its own and the ones it inherits. */
export function attributesOfEntity(m: LogicalModel, id: string): LogicalAttribute[] {
  const byId = new Map(m.entities.map((e) => [e.id, e]));
  return [...(entityOf(m, id)?.attributes ?? []), ...(supertypesOf(m).get(id) ?? []).flatMap((s) => byId.get(s)?.attributes ?? [])];
}

export interface InheritedKey {
  key: Key;
  /** The supertype the key is from. */
  from: string;
}

/** The keys an entity has of its own, and the ones it inherits: a subtype is identified as its supertype is (FR-M17-7). */
export function keysOfEntity(m: LogicalModel, id: string): Key[] {
  return [...(entityOf(m, id)?.keys ?? []), ...inheritedKeysOf(m, id).map((x) => x.key)];
}

/** The keys an entity inherits from its supertypes, nearest first, with the supertype each is from. */
export function inheritedKeysOf(m: LogicalModel, id: string): InheritedKey[] {
  const byId = new Map(m.entities.map((e) => [e.id, e]));
  return (supertypesOf(m).get(id) ?? []).flatMap((s) => (byId.get(s)?.keys ?? []).map((key) => ({ key, from: s })));
}

/** Whether an entity is identified, by a primary key of its own or by one it inherits. */
export function hasPrimaryKey(m: LogicalModel, id: string): boolean {
  return keysOfEntity(m, id).some((k) => k.kind === 'primary');
}

/** The attributes a key of this entity may name: its own, and the ones it inherits. */
const usableByKey = (m: LogicalModel, entity: LogicalEntity) => attributesOfEntity(m, entity.id);

/** The parent ends of the identifying relationships whose child this entity is. */
function identifyingEnds(m: LogicalModel, entityId: string): KeyMember[] {
  return m.relationships
    .filter((r) => r.identifying && r.ends[0].entity === entityId)
    .map((r) => ({ end: { relationship: r.id, end: 1 as const } }));
}

export function entityAdded(m: LogicalModel, name = 'Entity'): Added {
  const id = newId('e');
  const entity: LogicalEntity = { id, name: freeName(m.entities.map((e) => e.name), name), definition: '', attributes: [], keys: [] };
  return { id, change: { op: 'add', element: { kind: 'entity', entity } } };
}

export function attributeAdded(m: LogicalModel, entityId: string, name = 'Attribute'): Added | undefined {
  const entity = entityOf(m, entityId);
  if (!entity) return undefined;
  const id = newId('a');
  const attribute: LogicalAttribute = { id, name: freeName(usableByKey(m, entity).map((a) => a.name), name), definition: '', type: { base: 'text' }, optional: true };
  return { id, change: { op: 'add', element: { kind: 'attribute', entity: entityId, attribute } } };
}

/** A key with its first member: the first attribute it may name, or else the identity it borrows. */
export function keyAdded(m: LogicalModel, entityId: string, kind: Key['kind'] = 'candidate'): Added | undefined {
  const entity = entityOf(m, entityId);
  if (!entity) return undefined;
  if (kind === 'primary' && keysOfEntity(m, entityId).some((k) => k.kind === 'primary')) return undefined;
  const attribute = usableByKey(m, entity)[0];
  const borrow = attribute ? undefined : identifyingEnds(m, entityId)[0];
  const member: KeyMember | undefined = attribute ? { attribute: attribute.id } : borrow;
  if (!member) return undefined;
  const id = newId('k');
  const key: Key = { id, kind, name: freeName(keysOfEntity(m, entityId).map((k) => k.name), kind === 'primary' ? 'Primary key' : 'Candidate key'), members: [member] };
  return { id, change: { op: 'add', element: { kind: 'key', entity: entityId, key } } };
}

export function relationshipAdded(m: LogicalModel): Added | undefined {
  const [a, b] = m.entities;
  if (!a) return undefined;
  const other = b ?? a;
  const id = newId('r');
  const relationship: Relationship = {
    id,
    name: freeName(m.relationships.map((r) => r.name), 'Relationship'),
    definition: '',
    ends: [
      { entity: a.id, role: '', min: 0, max: 'many' },
      { entity: other.id, role: '', min: 0, max: 1 },
    ],
    identifying: false,
  };
  return { id, change: { op: 'add', element: { kind: 'relationship', relationship } } };
}

/** Whether making `subtype` a kind of `supertype` would put an entity above itself. */
export function wouldCycle(m: LogicalModel, supertype: string, subtype: string): boolean {
  // The subtype is already above the supertype: the new edge would close a circle.
  return supertype === subtype || (supertypesOf(m).get(supertype) ?? []).includes(subtype);
}

export function generalizationAdded(m: LogicalModel, supertype: string, subtype: string): Added | undefined {
  if (!entityOf(m, supertype) || !entityOf(m, subtype) || wouldCycle(m, supertype, subtype)) return undefined;
  if (m.generalizations.some((g) => g.supertype === supertype && g.subtypes.includes(subtype))) return undefined;
  const id = newId('g');
  const generalization: Generalization = { id, supertype, subtypes: [subtype], complete: false, exclusive: false };
  return { id, change: { op: 'add', element: { kind: 'generalization', generalization } } };
}

export function domainAdded(m: LogicalModel, name = 'Domain'): Added {
  const id = newId('d');
  const domain: LogicalDomain = { id, name: freeName(m.domains.map((d) => d.name), name), definition: '', base: { base: 'text' }, constraints: {} };
  return { id, change: { op: 'add', element: { kind: 'domain', domain } } };
}

export interface RuleInput {
  name: string;
  statement: string;
  kind?: BusinessRule['kind'];
  appliesTo?: BusinessRule['appliesTo'];
}

/** A rule, made only when it says what it is and what it says: a rule with no statement is refused. */
export function ruleAdded(m: LogicalModel, input: RuleInput): Added | undefined {
  const name = input.name.trim();
  const statement = input.statement.trim();
  if (!name || !statement) return undefined;
  const id = newId('b');
  const rule: BusinessRule = { id, name: freeName(m.rules.map((r) => r.name), name), statement, kind: input.kind ?? 'constraint', appliesTo: input.appliesTo ?? [], status: 'accepted' };
  return { id, change: { op: 'add', element: { kind: 'rule', rule } } };
}

/** Where the entities sit on the ER diagram: the first diagram, or a new one, keeping the picture apart from the meaning. */
export function diagramChange(m: LogicalModel, positions: Record<string, { x: number; y: number }>, name = 'ER diagram'): LogicalChange {
  const diagram = m.diagrams[0];
  if (diagram) return updatedChange({ diagram: diagram.id }, diagram, { positions });
  return { op: 'add', element: { kind: 'diagram', diagram: { id: newId('v'), name, positions } } };
}

/** The type a dropdown shows: a base type's name, or a domain by its id. */
export const typeSetting = (t: LogicalType): string => ('domain' in t ? `domain:${t.domain}` : t.base);

/** The type a dropdown's value means. A domain that is no longer there leaves text. */
export function typeFromSetting(setting: string, m: LogicalModel): LogicalType {
  if (setting.startsWith('domain:')) {
    const id = setting.slice('domain:'.length);
    return m.domains.some((d) => d.id === id) ? { domain: id } : { base: 'text' };
  }
  return (BASE_TYPES as readonly string[]).includes(setting) ? ({ base: setting } as BaseType) : { base: 'text' };
}

/** The end as a change writes it, with a minimum and a maximum that make sense together. */
export function endChanged(end: RelationshipEnd, patch: Partial<RelationshipEnd>): RelationshipEnd {
  const next = { ...end, ...patch };
  const min = Number.isInteger(next.min) && next.min >= 0 ? next.min : 0;
  const max = next.max === 'many' ? 'many' : Number.isInteger(next.max) && next.max >= 1 ? Math.max(next.max, min) : 'many';
  return { ...next, min, max };
}

export interface Resolved {
  changes: LogicalChange[];
  /** The associative entity made. */
  entity: string;
}

/**
 * A many-to-many relationship resolved into an associative entity (FR-M17-12): the entity takes
 * the relationship's name and definition, its primary key is the identity borrowed from both
 * ends, and two identifying relationships join it to them. The original relationship goes, and
 * rules and mappings that named it name the entity. Nothing is resolved where the relationship is
 * not many at both ends, or is already there.
 */
export function resolveManyToMany(m: LogicalModel, relationshipId: string): Resolved | { error: string } {
  const rel = m.relationships.find((r) => r.id === relationshipId);
  if (!rel) return { error: 'That relationship is no longer in the model.' };
  if (rel.ends[0].max !== 'many' || rel.ends[1].max !== 'many') return { error: 'Only a relationship that is many at both ends can become an associative entity.' };
  const entityName = entityOf(m, rel.ends[0].entity)?.name;
  const otherName = entityOf(m, rel.ends[1].entity)?.name;
  if (!entityName || !otherName) return { error: 'A relationship end names an entity that is not in the model.' };

  const entityId = newId('e');
  const firstId = newId('r');
  const secondId = newId('r');
  const name = freeName(m.entities.map((e) => e.name), rel.name.trim() || `${entityName} ${otherName}`);
  const [a, b] = rel.ends;
  const ends = (parent: RelationshipEnd, parentId: string, childMax: RelationshipEnd['max'], childMin: number): [RelationshipEnd, RelationshipEnd] => [
    { entity: entityId, role: '', min: childMin, max: childMax },
    { entity: parentId, role: parent.role, min: 1, max: 1 },
  ];
  const first: Relationship = { id: firstId, name: freeName(m.relationships.map((r) => r.name), `${name} of ${entityName}`), definition: '', ends: ends(a, a.entity, a.max, a.min), identifying: true };
  const second: Relationship = { id: secondId, name: freeName([...m.relationships.map((r) => r.name), first.name], `${name} of ${otherName}`), definition: '', ends: ends(b, b.entity, b.max, b.min), identifying: true };
  const key: Key = {
    id: newId('k'),
    kind: 'primary',
    name: 'Primary key',
    members: [
      { end: { relationship: firstId, end: 1 } },
      { end: { relationship: secondId, end: 1 } },
    ],
  };
  const entity: LogicalEntity = { id: entityId, name, definition: rel.definition, attributes: [], keys: [key] };
  const changes: LogicalChange[] = [
    { op: 'add', element: { kind: 'entity', entity } },
    { op: 'add', element: { kind: 'relationship', relationship: first } },
    { op: 'add', element: { kind: 'relationship', relationship: second } },
  ];
  // What named the relationship now names what took its place.
  for (const rule of m.rules) {
    if (!rule.appliesTo.some((x) => 'relationship' in x && x.relationship === rel.id)) continue;
    const appliesTo = rule.appliesTo.map((x) => ('relationship' in x && x.relationship === rel.id ? { entity: entityId } : x));
    changes.push(updatedChange({ rule: rule.id }, rule, { appliesTo }));
  }
  for (const mapping of m.mappings) {
    if (!mapping.targets.some((x) => 'relationship' in x && x.relationship === rel.id)) continue;
    const targets = mapping.targets.map((x) => ('relationship' in x && x.relationship === rel.id ? { entity: entityId } : x));
    changes.push(updatedChange({ mapping: mapping.id }, mapping, { targets }));
  }
  changes.push({ op: 'remove', element: { kind: 'relationship', relationship: rel } });
  return { changes, entity: entityId };
}

/** Every element of an LDM that a rule can be about, by kind, with the name it is known by. */
export function ruleTargets(m: LogicalModel): { kind: 'entity' | 'attribute' | 'key' | 'relationship' | 'generalization' | 'domain'; id: string; name: string; owner?: string }[] {
  const out: { kind: 'entity' | 'attribute' | 'key' | 'relationship' | 'generalization' | 'domain'; id: string; name: string; owner?: string }[] = [];
  for (const e of m.entities) {
    out.push({ kind: 'entity', id: e.id, name: e.name });
    for (const a of e.attributes) out.push({ kind: 'attribute', id: a.id, name: `${e.name}.${a.name}`, owner: e.id });
    for (const k of e.keys) out.push({ kind: 'key', id: k.id, name: `${e.name}.${k.name || 'key'}`, owner: e.id });
  }
  for (const r of m.relationships) out.push({ kind: 'relationship', id: r.id, name: r.name || 'Relationship' });
  for (const g of m.generalizations) out.push({ kind: 'generalization', id: g.id, name: `generalization of ${entityOf(m, g.supertype)?.name ?? g.supertype}` });
  for (const d of m.domains) out.push({ kind: 'domain', id: d.id, name: d.name });
  return out;
}

/** The reference a rule target is written as. */
export const refOfTarget = (t: { kind: string; id: string }): ElementRef => ({ [t.kind]: t.id }) as ElementRef;
