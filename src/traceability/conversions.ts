import type { BaseType, ElementKind, ElementRef, LogicalChange, LogicalDomain, LogicalEntity, LogicalModel, LogicalType, MappingSource, SemanticMapping, StrategyId } from '../logical/contracts';
import { freeName, resolveManyToMany, updatedChange } from '../logical/edits';
import { elementOf, newId, removalOf } from '../logical/rules';
import { strategyById, strategyText, type StrategyEntry } from '../logical/strategies';
import type { ConversionDecision, ConversionPreview } from './contracts';

/**
 * Conversions of an LDM element when a mapping's strategy changes (roadmap LM-4;
 * SYSTEM_ARCHITECTURE.md §13.7). Pure planning over the LDM: each conversion is expressed as the
 * change operations the LDM already has, and the service applies them with the mapping's own
 * update as one logical change set. Where a conversion cannot be made exactly — several targets,
 * another mapping still naming the element, a relationship that is not many at both ends — it is
 * refused with its conflicts, never approximated and never applied in part. The ontology is not
 * read here, and nothing physical is modelled.
 */

const refKind = (ref: ElementRef): ElementKind => Object.keys(ref)[0] as ElementKind;
const refId = (ref: ElementRef): string => (ref as Record<string, string>)[refKind(ref)];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const list = (values: string[]): string => values.map((v) => `“${v}”`).join(', ');

/** What an element is called, for the words of a preview. */
export function elementNameIn(model: LogicalModel, ref: ElementRef): string {
  const id = refId(ref);
  switch (refKind(ref)) {
    case 'entity':
      return model.entities.find((e) => e.id === id)?.name ?? `entity ${id}`;
    case 'attribute':
      for (const e of model.entities) {
        const a = e.attributes.find((x) => x.id === id);
        if (a) return `${e.name}.${a.name}`;
      }
      return `attribute ${id}`;
    case 'key':
      return model.entities.flatMap((e) => e.keys).find((k) => k.id === id)?.name ?? `key ${id}`;
    case 'relationship':
      return model.relationships.find((r) => r.id === id)?.name || `relationship ${id}`;
    case 'generalization': {
      const g = model.generalizations.find((x) => x.id === id);
      return g ? `the subtypes of ${model.entities.find((e) => e.id === g.supertype)?.name ?? '?'}` : `generalization ${id}`;
    }
    case 'rule':
      return model.rules.find((r) => r.id === id)?.name ?? `rule ${id}`;
    case 'domain':
      return model.domains.find((d) => d.id === id)?.name ?? `domain ${id}`;
    case 'mapping':
      return 'a mapping';
    case 'diagram':
      return model.diagrams.find((d) => d.id === id)?.name ?? `diagram ${id}`;
  }
}

const KIND_WORDS: Record<ElementKind, string> = {
  entity: 'an entity',
  attribute: 'an attribute',
  key: 'a key',
  relationship: 'a relationship',
  generalization: 'a generalization',
  rule: 'a business rule',
  domain: 'a domain',
  mapping: 'a mapping',
  diagram: 'a diagram',
};

/** The member IRIs of the ObjectOneOf axioms a mapping recorded, by their local name. */
function recordedMembers(sources: MappingSource[]): string[] {
  const out = new Set<string>();
  for (const source of sources) {
    for (const axiom of source.axioms) {
      const oneOf = axiom.match(/ObjectOneOf\(([^)]*)\)/);
      if (!oneOf) continue;
      for (const match of oneOf[1].matchAll(/<([^>]+)>/g)) {
        const local = match[1].replace(/[#/]$/, '').split(/[#/]/).pop();
        if (local) out.add(local);
      }
    }
  }
  return [...out];
}

interface Built {
  changes: LogicalChange[];
  creates: string[];
  modifies: string[];
  removes: string[];
  keys: string[];
  constraints: string[];
  decisions: ConversionDecision[];
  warnings: string[];
  conflicts: string[];
  target: ElementRef;
  targetKind: ElementKind;
  targetName: string;
  baseline: Record<string, unknown>;
}

const empty = (target: ElementRef, targetKind: ElementKind, targetName: string, baseline: Record<string, unknown>): Built => ({
  changes: [],
  creates: [],
  modifies: [],
  removes: [],
  keys: [],
  constraints: [],
  decisions: [],
  warnings: [],
  conflicts: [],
  target,
  targetKind,
  targetName,
  baseline,
});

/** Whether an attribute is typed by a domain, and by this one. */
const typedBy = (type: LogicalType, domain: string): boolean => 'domain' in type && type.domain === domain;

const baseOf = (type: BaseType): BaseType => clone(type);

function domainConstraints(domain: LogicalDomain): string[] {
  const out: string[] = [];
  const c = domain.constraints;
  if (c.minLength !== undefined) out.push(`at least ${c.minLength} characters`);
  if (c.maxLength !== undefined) out.push(`at most ${c.maxLength} characters`);
  if (c.pattern) out.push(`the pattern ${c.pattern}`);
  if (c.min !== undefined) out.push(`no less than ${c.min}`);
  if (c.max !== undefined) out.push(`no more than ${c.max}`);
  if (c.values?.length) out.push(`${c.values.length} values`);
  return out;
}

// ---------------------------------------------------------------- domain → entity

function domainToEntity(model: LogicalModel, mapping: SemanticMapping, domain: LogicalDomain, entry: StrategyEntry, decisions: Record<string, string>, sources: MappingSource[]): Built {
  const name = freeName(model.entities.map((e) => e.name), domain.name);
  const target: ElementRef = { entity: '' };
  const built = empty(target, 'entity', name, {});
  const references = entry.id === 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' || entry.id === 'OWL_CLASS_TO_LDM_REFERENCE_ENTITY';
  const values = domain.constraints.values?.map((v) => v.code).filter(Boolean) ?? [];
  const codes = values.length ? values : recordedMembers(sources);
  if (references) {
    built.decisions.push({
      name: 'values',
      label: 'How the members are kept',
      choices: [{ value: 'labels as codes', label: 'Each member becomes a row, its name the code' }],
      chosen: decisions.values ?? 'labels as codes',
    });
    if (!codes.length) built.warnings.push(`Neither the domain nor the mapping records its members; the entity starts with no value to judge against. The values, if there are any, stay in the ontology.`);
    else built.constraints.push(`The value list stays in the ontology; ${codes.length === 1 ? 'the member' : 'the members'} ${list(codes)} ${codes.length === 1 ? 'becomes' : 'become'} ${codes.length === 1 ? 'a row' : 'rows'} of the entity, one each.`);
  }

  const other = model.mappings.find((x) => x.id !== mapping.id && x.targets.some((t) => 'domain' in t && t.domain === domain.id));
  if (other) built.conflicts.push(`Another mapping (${other.strategy || other.id}) still targets the domain “${domain.name}”. Change or remove that mapping first.`);
  const losses = domainConstraints(domain);
  if (losses.length) built.constraints.push(`The domain’s constraints (${losses.join(', ')}) have no place on an entity attribute and are not carried over.`);
  if (built.conflicts.length) return built;

  const entityId = newId('e');
  const code: LogicalEntity['attributes'][number] = { id: newId('a'), name: 'code', definition: `The code that identifies one value of ${domain.name}.`, type: baseOf(domain.base), optional: false };
  const attributes = [code];
  const creates = [`Entity “${name}”`, `Attribute “${name}.code”, mandatory, of the domain’s base type`];
  if (references) {
    attributes.push({ id: newId('a'), name: 'label', definition: `What the value is called, for a reader.`, type: { base: 'text' }, optional: true });
    creates.push(`Attribute “${name}.label”`);
  }
  const key: LogicalEntity['keys'][number] = { id: newId('k'), kind: 'primary', name: 'Primary key', members: [{ attribute: code.id }] };
  const entity: LogicalEntity = { id: entityId, name, definition: domain.definition, attributes, keys: [key] };
  creates.push(`Primary key on “${name}.code”`);
  built.target = { entity: entityId };
  built.targetName = name;
  built.baseline = { entity: { id: entityId, name, definition: domain.definition } };
  built.creates = creates;
  built.keys = [`The entity gets a primary key on “code”: one row for each value.`];

  built.changes = [{ op: 'add', element: { kind: 'entity', entity } }];
  const base = baseOf(domain.base);
  for (const owner of model.entities) {
    for (const attribute of owner.attributes) {
      if (!typedBy(attribute.type, domain.id)) continue;
      built.changes.push(updatedChange({ attribute: attribute.id }, attribute, { type: base }));
      built.modifies.push(`Attribute “${owner.name}.${attribute.name}” is typed by “${domain.name}” now; it keeps the base type directly.`);
    }
  }
  for (const rule of model.rules) {
    if (!rule.appliesTo.some((x) => 'domain' in x && x.domain === domain.id)) continue;
    built.changes.push(updatedChange({ rule: rule.id }, rule, { appliesTo: rule.appliesTo.map((x) => ('domain' in x && x.domain === domain.id ? { entity: entityId } : x)) }));
    built.modifies.push(`Rule “${rule.name}” now applies to the entity “${name}”.`);
  }
  built.changes.push({ op: 'remove', element: { kind: 'domain', domain } });
  built.removes.push(`Domain “${domain.name}”`);
  built.keys.push('The attributes typed by the domain keep their ids, so keys that name them still hold.');
  return built;
}

// ---------------------------------------------------------------- entity → domain

const ONE_ATTRIBUTE = 'It has attributes besides its one value: a domain holds a list of values, not rows.';

function entityToDomain(model: LogicalModel, mapping: SemanticMapping, entity: LogicalEntity, sources: MappingSource[]): Built {
  const name = freeName(model.domains.map((d) => d.name), entity.name);
  const built = empty({ domain: '' }, 'domain', name, {});
  built.target = { domain: newId('d') };
  built.targetName = name;
  const conflicts = built.conflicts;
  if (entity.abstract) conflicts.push('An abstract entity is not a value list.');
  const attribute = entity.attributes.length === 1 ? entity.attributes[0] : undefined;
  if (!attribute) conflicts.push(entity.attributes.length ? ONE_ATTRIBUTE : 'It has no attribute to hold the values.');
  const key = entity.keys.length === 1 ? entity.keys[0] : undefined;
  if (entity.keys.length !== 1) conflicts.push(entity.keys.length ? 'It has more than one key; a value list is identified by its one attribute.' : 'It has no primary key to identify its values.');
  else if (key && key.kind !== 'primary') conflicts.push('Its key is not primary.');
  else if (key && !(key.members.length === 1 && 'attribute' in key.members[0] && attribute && key.members[0].attribute === attribute.id)) conflicts.push('Its primary key is not the one attribute.');
  if (attribute && !('base' in attribute.type)) conflicts.push('Its attribute is typed by a domain, not by a base type.');
  if (model.relationships.some((r) => r.ends.some((e) => e.entity === entity.id))) conflicts.push('A relationship has an end at it; an entity with relationships is not a value list.');
  if (model.generalizations.some((g) => g.supertype === entity.id || g.subtypes.includes(entity.id))) conflicts.push('It is in a generalization; a value list is not a subtype.');
  const named = (ref: ElementRef): boolean => refId(ref) === entity.id || (attribute !== undefined && refId(ref) === attribute.id) || (key !== undefined && refId(ref) === key.id);
  const decidedByRule = model.rules.find((r) => r.appliesTo.some(named));
  if (decidedByRule) conflicts.push(`The rule “${decidedByRule.name}” applies to it.`);
  const other = model.mappings.find((x) => x.id !== mapping.id && x.targets.some(named));
  if (other) conflicts.push(`Another mapping (${other.strategy || other.id}) still targets it or its attribute.`);
  if (conflicts.length || !attribute || !key || !('base' in attribute.type)) {
    built.changes = [];
    built.keys = [];
    return built;
  }

  const members = recordedMembers(sources);
  const values = members.map((code) => ({ code, label: code }));
  const domain: LogicalDomain = { id: refId(built.target), name, definition: entity.definition, base: baseOf(attribute.type), constraints: values.length ? { values } : {} };
  built.target = { domain: domain.id };
  built.targetName = name;
  built.baseline = { domain: clone(domain) };
  built.creates = [`Domain “${name}”, of the base type the attribute had`];
  built.removes = [`Entity “${entity.name}”`, `Attribute “${entity.name}.${attribute.name}”`, `Primary key on it`];
  built.keys = ['The primary key is not carried into the domain: a domain’s values are their own identity.'];
  if (values.length) built.constraints.push(`The domain holds the values the mapping records: ${list(members)}.`);
  else built.warnings.push('The mapping records no list of members; the domain starts with no values, and the ontology still has them.');
  // The mapping's own retarget is the service's, appended last; every other change removalOf
  // makes is part of this conversion.
  built.changes = removalOf(model, { entity: entity.id }).filter((c) => !(c.op === 'update' && 'mapping' in c.target && c.target.mapping === mapping.id));
  built.changes.push({ op: 'add', element: { kind: 'domain', domain } });
  return built;
}

// ---------------------------------------------------------------- relationship → associative entity

function relationshipToEntity(model: LogicalModel, mapping: SemanticMapping, relationshipId: string): Built {
  const relationship = model.relationships.find((r) => r.id === relationshipId);
  const built = empty({ entity: '' }, 'entity', relationship?.name ?? relationshipId, {});
  if (!relationship) {
    built.conflicts.push('That relationship is no longer in the model.');
    return built;
  }
  const other = model.mappings.find((x) => x.id !== mapping.id && x.targets.some((t) => 'relationship' in t && t.relationship === relationshipId));
  if (other) built.conflicts.push(`Another mapping (${other.strategy || other.id}) still targets the relationship “${relationship.name}”. Change or remove that mapping first.`);
  const resolved = resolveManyToMany(model, relationshipId);
  if ('error' in resolved) {
    built.conflicts.push(resolved.error);
    return built;
  }
  if (built.conflicts.length) return built;

  const added = resolved.changes.find((c) => c.op === 'add' && c.element.kind === 'entity');
  const entity = added && added.op === 'add' && added.element.kind === 'entity' ? added.element.entity : undefined;
  if (!entity) {
    built.conflicts.push('The conversion made no entity to map to.');
    return built;
  }
  built.target = { entity: entity.id };
  built.targetName = entity.name;
  built.baseline = { entity: { id: entity.id, name: entity.name, definition: entity.definition } };
  built.creates = [`Entity “${entity.name}”`];
  for (const c of resolved.changes) {
    if (c.op === 'add' && c.element.kind === 'relationship') built.creates.push(`Identifying relationship “${c.element.relationship.name}”`);
  }
  built.removes = [`Relationship “${relationship.name}”`];
  built.keys = [`The entity’s primary key borrows the identity of both ends, as its identifying relationships require.`];
  built.constraints = ['Both identifying relationships make their ends mandatory: a row needs the two things it relates.'];
  for (const c of resolved.changes) {
    if (c.op !== 'update') continue;
    const target = c.target;
    if (!('rule' in target)) continue;
    const rule = model.rules.find((r) => r.id === target.rule);
    if (rule) built.modifies.push(`Rule “${rule.name}” now applies to the entity “${entity.name}”.`);
  }
  // A rule's or another mapping's retarget is part of the conversion; the mapping's own update is
  // added by the service as the last change of the set.
  built.changes = resolved.changes.filter((c) => !(c.op === 'update' && 'mapping' in c.target && c.target.mapping === mapping.id));
  return built;
}

// ---------------------------------------------------------------- the plan

export interface ConversionPlanInput {
  model: LogicalModel;
  mapping: SemanticMapping;
  to: StrategyId;
  decisions?: Record<string, string>;
  /** The sources and rationale as the form has them, kept with the mapping if applied. */
  sources?: MappingSource[];
  rationale?: string;
}

/**
 * What changing a mapping's strategy would make of its target element: the change operations and
 * the words of a review, with the conflicts that stop it. Pure: it reads the LDM and writes
 * nothing.
 */
export function conversionPlan(input: ConversionPlanInput): ConversionPreview {
  const { model, mapping, to } = input;
  const entry = strategyById(to);
  const at = Date.now();
  const target = mapping.targets[0];
  const targetKind = target ? refKind(target) : 'entity';
  const targetName = target ? elementNameIn(model, target) : mapping.strategy;
  const sources = input.sources ?? mapping.sources;
  const rationale = input.rationale ?? mapping.rationale;
  const finish = (built: Built): ConversionPreview => ({
    model: model.id,
    mapping: mapping.id,
    baseRevision: model.revision,
    from: { ...(mapping.strategyId ? { strategyId: mapping.strategyId } : {}), ref: target ?? { entity: '' }, kind: targetKind, name: targetName },
    to: { strategyId: to, kind: entry?.target ?? built.targetKind, name: built.targetName },
    creates: built.creates,
    modifies: built.modifies,
    removes: built.removes,
    keys: built.keys,
    constraints: built.constraints,
    decisions: built.decisions,
    warnings: built.warnings,
    conflicts: built.conflicts,
    changes: built.conflicts.length ? [] : built.changes,
    mappingAfter: {
      sources,
      targets: built.conflicts.length ? mapping.targets : [built.target],
      strategyId: to,
      strategy: entry ? strategyText(entry, built.targetName) : mapping.strategy,
      baseline: built.baseline,
      rationale,
    },
    at,
  });

  if (!entry) {
    const built = empty(target ?? { entity: '' }, targetKind, targetName, mapping.baseline);
    built.conflicts.push(`“${to}” is not a strategy this editor knows.`);
    return finish(built);
  }
  if (mapping.targets.length !== 1 || !target) {
    const built = empty(target ?? { entity: '' }, targetKind, targetName, mapping.baseline);
    built.conflicts.push(mapping.targets.length ? 'A conversion changes one element at a time; this mapping targets several.' : 'The mapping targets no element.');
    return finish(built);
  }
  const element = elementOf(model, target);
  if (!element) {
    const built = empty(target, targetKind, targetName, mapping.baseline);
    built.conflicts.push(`“${targetName}” is no longer in the logical model.`);
    return finish(built);
  }
  if (targetKind === entry.target) {
    const built = empty(target, targetKind, targetName, mapping.baseline);
    built.warnings.push(`The strategy makes ${KIND_WORDS[entry.target]}, which is what “${targetName}” already is: saving the mapping changes what it says, not the model.`);
    return finish(built);
  }
  const min = entry.sources?.min ?? 1;
  const max = entry.sources?.max;
  if (sources.length < min || (max !== undefined && sources.length > max)) {
    const built = empty(target, targetKind, targetName, mapping.baseline);
    const reads = max === 1 ? 'one source' : max !== undefined ? `at most ${max} sources` : `at least ${min} sources`;
    built.conflicts.push(`The strategy “${entry.label}” reads ${reads}; this mapping records ${sources.length}.`);
    return finish(built);
  }
  if (targetKind === 'domain' && entry.target === 'entity' && element.kind === 'domain') return finish(domainToEntity(model, mapping, element.domain, entry, input.decisions ?? {}, sources));
  if (targetKind === 'entity' && entry.target === 'domain' && element.kind === 'entity') return finish(entityToDomain(model, mapping, element.entity, sources));
  if (targetKind === 'relationship' && entry.target === 'entity' && element.kind === 'relationship') return finish(relationshipToEntity(model, mapping, element.relationship.id));
  const built = empty(target, targetKind, targetName, mapping.baseline);
  built.conflicts.push(`${KIND_WORDS[targetKind][0].toUpperCase()}${KIND_WORDS[targetKind].slice(1)} cannot become ${KIND_WORDS[entry.target]} by changing a mapping’s strategy.`);
  return finish(built);
}
