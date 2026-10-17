import type { BaseType, ElementRef, KeyMember, LogicalModel, LogicalType, RelationshipEnd } from './contracts';

/**
 * Elements of a logical data model in words, for the history, a difference between versions, and
 * the editor: "text (at most 80)", "film 0..* to person 0..1".
 */

export const baseText = (t: BaseType): string =>
  t.base === 'text' && t.maxLength !== undefined ? `text (at most ${t.maxLength})` : t.base === 'decimal' && t.precision !== undefined ? `decimal (${t.precision}${t.scale !== undefined ? `, ${t.scale}` : ''})` : t.base;

export const typeText = (t: LogicalType, m: LogicalModel): string => ('domain' in t ? `“${m.domains.find((d) => d.id === t.domain)?.name ?? t.domain}”` : baseText(t));

const entityName = (m: LogicalModel, id: string) => m.entities.find((e) => e.id === id)?.name ?? id;
export const cardinalityText = (e: RelationshipEnd): string => `${e.min}..${e.max === 'many' ? '*' : e.max}`;
export const endText = (e: RelationshipEnd, m: LogicalModel): string => `${entityName(m, e.entity)}${e.role ? ` as ${e.role}` : ''} ${cardinalityText(e)}`;

export function memberText(x: KeyMember, m: LogicalModel): string {
  if ('attribute' in x) return m.entities.flatMap((e) => e.attributes).find((a) => a.id === x.attribute)?.name ?? x.attribute;
  const r = m.relationships.find((y) => y.id === x.end.relationship);
  return r ? `the identity of ${entityName(m, r.ends[x.end.end].entity)}` : x.end.relationship;
}

/** What an element is called, for saying which it is. */
export function refText(r: ElementRef, m: LogicalModel): string {
  const [kind, id] = Object.entries(r)[0] as [string, string];
  const attribute = m.entities.flatMap((e) => e.attributes.map((a) => ({ e, a }))).find((x) => x.a.id === id);
  switch (kind) {
    case 'entity':
      return `the entity “${entityName(m, id)}”`;
    case 'attribute':
      return attribute ? `the attribute “${attribute.a.name}” of “${attribute.e.name}”` : 'an attribute';
    case 'relationship':
      return `the relationship “${m.relationships.find((x) => x.id === id)?.name || id}”`;
    case 'domain':
      return `the domain “${m.domains.find((x) => x.id === id)?.name ?? id}”`;
    default:
      return `the ${kind} ${id}`;
  }
}

/** A field's value in words, by what the field is. */
export function fieldText(field: string, v: unknown, m: LogicalModel): string {
  if (v === undefined) return 'none';
  if (field === 'type' || field === 'base') return typeText(v as LogicalType, m);
  if (field === 'ends') return (v as RelationshipEnd[]).map((e) => endText(e, m)).join(' to ');
  if (field === 'members') return (v as KeyMember[]).map((x) => memberText(x, m)).join(', ');
  if (field === 'supertype') return entityName(m, v as string);
  if (field === 'subtypes') return (v as string[]).map((id) => entityName(m, id)).join(', ');
  if (field === 'appliesTo' || field === 'targets') return (v as ElementRef[]).map((r) => refText(r, m)).join(', ') || 'nothing';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' || typeof v === 'number') return String(v) || '(empty)';
  return JSON.stringify(v);
}
