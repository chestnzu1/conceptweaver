import { useEffect, useMemo, useState, type InputHTMLAttributes } from 'react';
import { BASE_TYPES, LogicalError, type BaseType, type BusinessRule, type ElementRef, type Generalization, type Key, type KeyMember, type LogicalAttribute, type LogicalChange, type LogicalDomain, type LogicalEntity, type LogicalModel, type LogicalType, type Relationship, type RelationshipEnd } from '../logical/contracts';
import { attributeAdded, attributesOfEntity, diagramChange, domainAdded, endChanged, entityAdded, freeName, generalizationAdded, hasPrimaryKey, inheritedKeysOf, keyAdded, refOfTarget, relationshipAdded, resolveManyToMany, ruleAdded, ruleTargets, typeFromSetting, typeSetting, updatedChange, wouldCycle } from '../logical/edits';
import { removalOf } from '../logical/rules';
import { baseText, cardinalityText, memberText, typeText } from '../logical/text';
import { useStore } from '../model/store';
import type { LdmViewState } from '../model/state/session';
import { CommitInput, CommitTextarea } from './fields';
import { LdmDiagram } from './LdmDiagram';
import { TraceabilityPanel } from './Traceability';

/**
 * The LDM workspace (roadmap LM-2, FR-M17-11 and FR-M17-12): the project's logical data models,
 * read and edited apart from the ontology. A list of the model's entities with a search, and
 * editors for entities (attributes, types and domains, optionality, keys, specialization, rules),
 * relationships (the two ends, cardinality, optionality, identifying; a many-to-many resolved into
 * an associative entity), domains and rules; and the ER diagram, whose positions are kept apart
 * from what the model means. Every edit goes through the logical edit service, one step of the
 * history each, and a step changes nothing of the ontology (NFR-17).
 */

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const said = (e: unknown) => (e instanceof LogicalError || e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const SECTIONS: { id: LdmViewState['section']; label: string }[] = [
  { id: 'entities', label: 'Entities' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'domains', label: 'Domains' },
  { id: 'rules', label: 'Rules' },
  { id: 'diagram', label: 'Diagram' },
  { id: 'traceability', label: 'Traceability' },
];

/** The entity an element of the LDM belongs to, where one does. */
function ownerOf(m: LogicalModel, element: ElementRef): string | null {
  if ('entity' in element) return element.entity;
  if ('attribute' in element) return m.entities.find((e) => e.attributes.some((a) => a.id === element.attribute))?.id ?? null;
  if ('key' in element) return m.entities.find((e) => e.keys.some((k) => k.id === element.key))?.id ?? null;
  if ('generalization' in element) return m.generalizations.find((g) => g.id === element.generalization)?.supertype ?? null;
  return null;
}

type Apply = (changes: LogicalChange[], summary: string, done?: () => void) => void;

/** A change set applied to the model as it is when the action is taken, whichever render made the action. */
function appliedTo(m: LogicalModel | null, changes: LogicalChange[], summary: string, done?: () => void) {
  if (!m || !changes.length) return;
  void useStore
    .getState()
    .logicalEdit.apply({ model: m.id, baseRevision: m.revision, changes, summary })
    .then(() => done?.())
    .catch((e) => useStore.getState().notify(said(e)));
}

export function LdmView() {
  const models = useStore((s) => s.model.logicalModels);
  const view = useStore((s) => s.ldmView);
  const st = useStore.getState;
  const model = models.find((m) => m.id === view.model) ?? models[0] ?? null;
  const set = (patch: Partial<LdmViewState>) => st().setLdmView(patch);

  // An element another view asked to open decides the lists and the section, once; after that the
  // choices are the view's own.
  const wanted = view.element;
  const entityId = useMemo(() => {
    if (view.entity) return view.entity;
    if (wanted) return ownerOf(model ?? ({ entities: [] } as unknown as LogicalModel), wanted);
    return null;
  }, [view.entity, wanted, model]);
  const relationshipId = view.relationship ?? (wanted && 'relationship' in wanted ? wanted.relationship : null);
  const domainId = view.domain ?? (wanted && 'domain' in wanted ? wanted.domain : null);
  const ruleId = view.rule ?? (wanted && 'rule' in wanted ? wanted.rule : null);
  const entity = model && (entityId ? model.entities.find((e) => e.id === entityId) : model.entities[0]) || null;
  const relationship = model && (relationshipId ? model.relationships.find((r) => r.id === relationshipId) : model.relationships[0]) || null;
  const domain = model && (domainId ? model.domains.find((d) => d.id === domainId) : model.domains[0]) || null;
  const rule = model && (ruleId ? model.rules.find((r) => r.id === ruleId) : model.rules[0]) || null;

  const apply: Apply = (changes, summary, done) => appliedTo(model, changes, summary, done);

  // Keyboard: the list, and the two things done most. Every other action is a button or a field.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const m = s.model.logicalModels.find((x) => x.id === s.ldmView.model) ?? s.model.logicalModels[0];
      if (s.view !== 'ldm' || s.dialog || !m || isTyping(e.target)) return;
      if (s.ldmView.section !== 'entities') return;
      const search = s.ldmView.search.trim().toLowerCase();
      const listed = m.entities.filter((x) => !search || `${x.name}\n${x.definition}`.toLowerCase().includes(search)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const at = listed.findIndex((x) => x.id === (s.ldmView.entity ?? listed[0]?.id));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!listed.length) return;
        e.preventDefault();
        const next = listed[Math.min(listed.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
        s.setLdmView({ entity: next.id, element: null });
      } else if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const made = entityAdded(m);
        appliedTo(m, [made.change], 'Made an entity', () => s.setLdmView({ section: 'entities', entity: made.id, element: null }));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && at >= 0) {
        e.preventDefault();
        const target = listed[at];
        if (!window.confirm(`Delete the entity “${target.name}”, with what is only its own? Undo takes it back.`)) return;
        appliedTo(m, removalOf(m, { entity: target.id }), `Deleted the entity “${target.name}”`, () => s.setLdmView({ entity: null, element: null }));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
    // The actions are made from the store as it is when a key is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!model) {
    return (
      <div className="view ldm-view">
        <div className="ldm-empty">
          <h2>Logical data models</h2>
          <p className="muted">How applications organise this project’s data: entities, attributes, relationships, keys and rules, apart from the ontology and never written into it. A project can have several.</p>
          <button className="btn primary" onClick={() => st().setDialog('logical')}>
            Make a logical model…
          </button>
        </div>
      </div>
    );
  }

  const counts = { entities: model.entities.length, relationships: model.relationships.length, domains: model.domains.length, rules: model.rules.length };
  return (
    <div className="view ldm-view">
      <div className="view-head ldm-head">
        <div className="row wrap">
          <h2>LDM</h2>
          {models.length > 1 ? (
            <select aria-label="Logical model" value={model.id} onChange={(e) => set({ model: e.target.value, entity: null, relationship: null, domain: null, rule: null, element: null, search: '' })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{model.name}</strong>
          )}
          <span className="muted">
            {plural(counts.entities, 'entity', 'entities')} · {plural(counts.relationships, 'relationship')} · {plural(counts.domains, 'domain')} · {plural(counts.rules, 'rule')}
          </span>
        </div>
        <div className="row">
          <button className="btn small" title="Propose entities, attributes and relationships for this model from the ontology" onClick={() => st().setDialog('transform')}>
            Derive from the ontology…
          </button>
          <button className="btn small" title="Make, rename, duplicate, import, export or delete a logical model" onClick={() => st().setDialog('logical')}>
            Logical models…
          </button>
        </div>
      </div>
      <div className="tabs sub" role="tablist" aria-label="Part of the logical model">
        {SECTIONS.map((s) => (
          <button key={s.id} role="tab" aria-selected={view.section === s.id} className={view.section === s.id ? 'on' : ''} onClick={() => set({ section: s.id })}>
            {s.label}
            {(s.id === 'entities' || s.id === 'relationships' || s.id === 'domains' || s.id === 'rules') && counts[s.id] > 0 && <span className="muted"> {counts[s.id]}</span>}
          </button>
        ))}
      </div>
      {view.section === 'entities' && (
        <div className="ldm-body">
          <EntityList m={model} search={view.search} selected={entity?.id ?? null} set={set} apply={apply} />
          {entity ? <EntityEditor m={model} entity={entity} apply={apply} set={set} /> : <p className="muted pad">No entity yet. Make one to begin.</p>}
        </div>
      )}
      {view.section === 'relationships' && (
        <div className="ldm-body">
          <RelationshipList m={model} selected={relationship?.id ?? null} set={set} apply={apply} />
          {relationship ? <RelationshipEditor m={model} relationship={relationship} apply={apply} set={set} /> : <p className="muted pad">No relationship yet. Make one to begin.</p>}
        </div>
      )}
      {view.section === 'domains' && (
        <div className="ldm-body">
          <DomainList m={model} selected={domain?.id ?? null} set={set} apply={apply} />
          {domain ? <DomainEditor m={model} domain={domain} apply={apply} /> : <p className="muted pad">No domain yet. A domain is a base type narrowed by a length, a range, a pattern or a list of values; an enumeration is a domain with its values.</p>}
        </div>
      )}
      {view.section === 'rules' && (
        <div className="ldm-body">
          <RuleList m={model} selected={rule?.id ?? null} set={set} apply={apply} />
          {rule ? <RuleEditor m={model} rule={rule} apply={apply} /> : <p className="muted pad">No business rule yet. Rules are stated in words, and the rest of the model is not held to them.</p>}
        </div>
      )}
      {view.section === 'traceability' && <TraceabilityPanel m={model} focus={view.element && !('mapping' in view.element) ? view.element : null} selected={view.element && 'mapping' in view.element ? view.element.mapping : null} set={set} />}
      {view.section === 'diagram' && (
        <div className="ldm-diagram-wrap">
          <LdmDiagram
            m={model}
            selected={entity?.id ?? null}
            onSelect={(id) => set({ section: 'entities', entity: id, element: null })}
            onPositions={(positions) => apply([diagramChange(model, positions)], 'Moved the entities in the ER diagram')}
            onNewEntity={() => {
              const made = entityAdded(model);
              apply([made.change], 'Made an entity', () => set({ section: 'entities', entity: made.id, element: null }));
            }}
            onNewRelationship={() => {
              const made = relationshipAdded(model);
              if (made) apply([made.change], 'Made a relationship', () => set({ section: 'relationships', relationship: made.id, element: null }));
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- entities

function EntityList({ m, search, selected, set, apply }: { m: LogicalModel; search: string; selected: string | null; set: (p: Partial<LdmViewState>) => void; apply: Apply }) {
  const found = m.entities.filter((e) => !search.trim() || `${e.name}\n${e.definition}`.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const add = () => {
    const made = entityAdded(m);
    apply([made.change], 'Made an entity', () => set({ section: 'entities', entity: made.id, element: null, search: '' }));
  };
  return (
    <aside className="ldm-list" aria-label="Entities">
      <div className="ldm-list-tools">
        <input type="search" aria-label="Search entities" placeholder="Search entities" value={search} onChange={(e) => set({ search: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && set({ search: '' })} />
        <button className="btn small primary" title="Make an entity (n)" onClick={add}>
          New entity
        </button>
      </div>
      {!found.length && <p className="muted">{m.entities.length ? 'No entity matches.' : 'No entities yet.'}</p>}
      <ul>
        {found.map((e) => (
          <li key={e.id}>
            <button className={selected === e.id ? 'on' : ''} onClick={() => set({ entity: e.id, element: null })}>
              <span>{e.name || 'Unnamed entity'}</span>
              <small className="muted">
                {plural(e.attributes.length, 'attribute')} · {hasPrimaryKey(m, e.id) ? 'primary key' : 'no primary key'}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function EntityEditor({ m, entity, apply, set }: { m: LogicalModel; entity: LogicalEntity; apply: Apply; set: (p: Partial<LdmViewState>) => void }) {
  const update = (after: Record<string, unknown>, summary: string) => apply([updatedChange({ entity: entity.id }, entity, after)], summary);
  const inherited = attributesOfEntity(m, entity.id).filter((a) => !entity.attributes.some((x) => x.id === a.id));
  const removeEntity = () => {
    if (!window.confirm(`Delete the entity “${entity.name}”, with what is only its own? Undo takes it back.`)) return;
    apply(removalOf(m, { entity: entity.id }), `Deleted the entity “${entity.name}”`, () => set({ entity: null, element: null }));
  };
  const rules = m.rules.filter((r) => r.appliesTo.some((x) => 'entity' in x && x.entity === entity.id));
  return (
    <section className="ldm-editor" aria-label={`Entity ${entity.name}`}>
      <div className="ldm-title">
        <label className="field grow">
          <span>Name</span>
          <CommitInput aria-label="Entity name" value={entity.name} spellCheck={false} onCommit={(name) => update({ name: name.trim() || 'Entity' }, 'Renamed an entity')} />
        </label>
        <label className="check">
          <input type="checkbox" checked={entity.abstract === true} onChange={(e) => update({ abstract: e.target.checked || undefined }, e.target.checked ? 'Made an entity abstract' : 'Made an entity concrete')} />
          <span>Abstract</span>
        </label>
        <button className="btn small danger" onClick={removeEntity}>
          Delete entity…
        </button>
      </div>
      <label className="field">
        <span>Definition</span>
        <CommitTextarea aria-label="Entity definition" rows={2} value={entity.definition} onCommit={(definition) => update({ definition }, 'Changed an entity’s definition')} />
      </label>

      <div className="ldm-block">
        <div className="ldm-block-head">
          <h3>Attributes</h3>
          <button
            className="btn small"
            onClick={() => {
              const made = attributeAdded(m, entity.id);
              if (made) apply([made.change], 'Added an attribute');
            }}
          >
            Add attribute
          </button>
        </div>
        {!entity.attributes.length && !inherited.length && <p className="muted">No attribute yet.</p>}
        {entity.attributes.map((a) => (
          <AttributeRow key={a.id} m={m} attribute={a} apply={apply} />
        ))}
        {inherited.map((a) => (
          <p key={a.id} className="ldm-inherited muted">
            {a.name} · {typeText(a.type, m)} — inherited
          </p>
        ))}
      </div>

      <KeysBlock m={m} entity={entity} apply={apply} />

      <SpecializationBlock m={m} entity={entity} apply={apply} />

      <div className="ldm-block">
        <div className="ldm-block-head">
          <h3>Rules</h3>
          <button className="btn small" onClick={() => set({ section: 'rules', rule: null, element: null })}>
            Go to rules
          </button>
        </div>
        {rules.length ? (
          <ul className="ldm-plain-list">
            {rules.map((r) => (
              <li key={r.id}>
                <button className="link" onClick={() => set({ section: 'rules', rule: r.id, element: { rule: r.id } })}>
                  {r.name}
                </button>{' '}
                <span className="muted">{r.statement}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No rule is about this entity.</p>
        )}
      </div>
    </section>
  );
}

function AttributeRow({ m, attribute, apply }: { m: LogicalModel; attribute: LogicalAttribute; apply: Apply }) {
  const update = (after: Record<string, unknown>) => apply([updatedChange({ attribute: attribute.id }, attribute, after)], 'Changed an attribute');
  const remove = () => apply(removalOf(m, { attribute: attribute.id }), `Deleted the attribute “${attribute.name}”`);
  return (
    <div className="ldm-attribute">
      <div className="ldm-attribute-line">
        <CommitInput className="name" aria-label={`Name of the attribute ${attribute.name}`} value={attribute.name} spellCheck={false} onCommit={(name) => update({ name: name.trim() || 'Attribute' })} />
        <TypeEditor m={m} type={attribute.type} onChange={(type) => update({ type })} />
        <label className="check" title="An optional attribute may be missing from an instance">
          <input type="checkbox" checked={attribute.optional} onChange={(e) => update({ optional: e.target.checked })} />
          <span>Optional</span>
        </label>
        <label className="check" title="A derived attribute is worked out from others">
          <input type="checkbox" checked={attribute.derived === true} onChange={(e) => update({ derived: e.target.checked || undefined })} />
          <span>Derived</span>
        </label>
        <button className="btn small danger" aria-label={`Delete the attribute ${attribute.name}`} onClick={remove}>
          Delete
        </button>
      </div>
      <CommitInput className="definition" aria-label={`Definition of the attribute ${attribute.name}`} placeholder="Definition" value={attribute.definition} onCommit={(definition) => update({ definition })} />
    </div>
  );
}

function TypeEditor({ m, type, onChange }: { m: LogicalModel; type: LogicalType; onChange: (t: LogicalType) => void }) {
  const setting = typeSetting(type);
  const base = 'base' in type ? type : undefined;
  return (
    <span className="ldm-type">
      <select aria-label="Attribute type" value={setting} onChange={(e) => onChange(typeFromSetting(e.target.value, m))}>
        <optgroup label="Logical types">
          {BASE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </optgroup>
        {m.domains.length > 0 && (
          <optgroup label="Domains">
            {m.domains.map((d) => (
              <option key={d.id} value={`domain:${d.id}`}>
                {d.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {base?.base === 'text' && (
        <label className="ldm-param" title="The longest text this value may be">
          at most
          <NumField aria-label="Maximum length" value={base.maxLength} onCommit={(n) => onChange({ base: 'text', ...(n !== undefined ? { maxLength: n } : {}) })} />
        </label>
      )}
      {base?.base === 'decimal' && (
        <span className="ldm-param">
          <label>
            precision
            <NumField aria-label="Decimal precision" value={base.precision} onCommit={(n) => onChange({ base: 'decimal', ...(n !== undefined ? { precision: n } : {}), ...(base.scale !== undefined ? { scale: base.scale } : {}) })} />
          </label>
          <label>
            scale
            <NumField aria-label="Decimal scale" value={base.scale} onCommit={(n) => onChange({ base: 'decimal', ...(base.precision !== undefined ? { precision: base.precision } : {}), ...(n !== undefined ? { scale: n } : {}) })} />
          </label>
        </span>
      )}
    </span>
  );
}

function KeysBlock({ m, entity, apply }: { m: LogicalModel; entity: LogicalEntity; apply: Apply }) {
  const inherited = inheritedKeysOf(m, entity.id);
  const identified = hasPrimaryKey(m, entity.id);
  const ownPrimary = entity.keys.some((k) => k.kind === 'primary');
  const add = (kind: Key['kind']) => {
    const made = keyAdded(m, entity.id, kind);
    if (made) apply([made.change], kind === 'primary' ? 'Added a primary key' : 'Added a candidate key');
    else useStore.getState().notify(attributesOfEntity(m, entity.id).length ? 'A key needs an attribute or an identity borrowed from an identifying relationship.' : 'Add an attribute first: a key needs a member.');
  };
  return (
    <div className="ldm-block">
      <div className="ldm-block-head">
        <h3>Keys</h3>
        <span className="row">
          <button
            className="btn small"
            disabled={identified}
            title={ownPrimary ? 'The entity has a primary key already' : identified ? 'The entity is identified by the primary key it inherits' : 'A key nothing may repeat or leave out'}
            onClick={() => add('primary')}
          >
            Add primary key
          </button>
          <button className="btn small" onClick={() => add('candidate')}>
            Add candidate key
          </button>
        </span>
      </div>
      {!entity.keys.length && !inherited.length && <p className="muted">No key. Nothing identifies an instance.</p>}
      {entity.keys.map((k) => (
        <KeyEditor key={k.id} m={m} entity={entity} k={k} apply={apply} />
      ))}
      {inherited.map(({ key, from }) => {
        const owner = m.entities.find((x) => x.id === from)?.name ?? from;
        return (
          <div key={key.id} className="ldm-key ldm-key-inherited" title={`Inherited from ${owner}: a subtype is identified as its supertype is`}>
            <div className="ldm-key-head">
              <span className="tag">{key.kind === 'primary' ? 'Primary' : 'Candidate'}</span>
              <strong>{key.name || (key.kind === 'primary' ? 'Primary key' : 'Candidate key')}</strong>
              <span className="muted grow">
                {key.members.length ? key.members.map((x) => memberText(x, m)).join(', ') : 'No member'} — inherited from {owner}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KeyEditor({ m, entity, k, apply }: { m: LogicalModel; entity: LogicalEntity; k: Key; apply: Apply }) {
  const update = (after: Record<string, unknown>) => apply([updatedChange({ key: k.id }, k, after)], 'Changed a key');
  const usable = attributesOfEntity(m, entity.id);
  const borrows = m.relationships.filter((r) => r.identifying && r.ends[0].entity === entity.id);
  const has = (x: KeyMember) => k.members.some((y) => ('attribute' in x ? 'attribute' in y && y.attribute === x.attribute : !('attribute' in y) && y.end.relationship === x.end.relationship && y.end.end === x.end.end));
  const toggle = (x: KeyMember, on: boolean) => update({ members: on ? [...k.members, x] : k.members.filter((y) => ('attribute' in x ? !('attribute' in y) || y.attribute !== x.attribute : 'attribute' in y || y.end.relationship !== x.end.relationship || y.end.end !== x.end.end)) });
  return (
    <div className="ldm-key">
      <div className="ldm-key-head">
        <select aria-label={`Kind of the key ${k.name}`} value={k.kind} onChange={(e) => update({ kind: e.target.value as Key['kind'] })}>
          <option value="primary" disabled={k.kind !== 'primary' && hasPrimaryKey(m, entity.id)}>
            Primary
          </option>
          <option value="candidate">Candidate</option>
        </select>
        <CommitInput aria-label={`Name of the key ${k.name}`} value={k.name} placeholder="Key name" onCommit={(name) => update({ name: name.trim() })} />
        <span className="muted grow">{k.members.length ? k.members.map((x) => memberText(x, m)).join(', ') : 'No member'}</span>
        <button className="btn small danger" aria-label={`Delete the key ${k.name}`} onClick={() => apply(removalOf(m, { key: k.id }), 'Deleted a key')}>
          Delete
        </button>
      </div>
      <div className="ldm-members">
        {usable.map((a) => {
          const member: KeyMember = { attribute: a.id };
          return (
            <label key={a.id} className="check">
              <input type="checkbox" checked={has(member)} onChange={(e) => toggle(member, e.target.checked)} />
              <span>{a.name}</span>
            </label>
          );
        })}
        {borrows.map((r) => {
          const at = r.ends[1].entity;
          const member: KeyMember = { end: { relationship: r.id, end: 1 } };
          return (
            <label key={r.id} className="check" title="The identity borrowed from the parent of an identifying relationship">
              <input type="checkbox" checked={has(member)} onChange={(e) => toggle(member, e.target.checked)} />
              <span>identity of {m.entities.find((x) => x.id === at)?.name ?? at}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function SpecializationBlock({ m, entity, apply }: { m: LogicalModel; entity: LogicalEntity; apply: Apply }) {
  const supers = m.generalizations.filter((g) => g.subtypes.includes(entity.id));
  const below = m.generalizations.find((g) => g.supertype === entity.id);
  const addSuper = (id: string) => {
    if (!id) return;
    const exists = m.generalizations.find((g) => g.supertype === id);
    const changes: LogicalChange[] = exists ? [updatedChange({ generalization: exists.id }, exists, { subtypes: [...exists.subtypes, entity.id] })] : (() => {
      const made = generalizationAdded(m, id, entity.id);
      return made ? [made.change] : [];
    })();
    apply(changes, 'Made an entity a kind of another');
  };
  const removeSuper = (g: Generalization) => {
    const subtypes = g.subtypes.filter((s) => s !== entity.id);
    apply([subtypes.length ? updatedChange({ generalization: g.id }, g, { subtypes }) : { op: 'remove', element: { kind: 'generalization', generalization: g } }], 'Took an entity out of a generalization');
  };
  const addSub = (id: string) => {
    if (!id) return;
    if (below) apply([updatedChange({ generalization: below.id }, below, { subtypes: [...below.subtypes, id] })], 'Added a subtype');
    else {
      const made = generalizationAdded(m, entity.id, id);
      if (made) apply([made.change], 'Added a subtype');
    }
  };
  const setBelow = (after: Record<string, unknown>) => below && apply([updatedChange({ generalization: below.id }, below, after)], 'Changed a generalization');
  return (
    <div className="ldm-block">
      <div className="ldm-block-head">
        <h3>Specialization</h3>
      </div>
      <div className="ldm-block-row">
        <span className="ldm-label">A kind of</span>
        {supers.length ? (
          <span className="row wrap">
            {supers.map((g) => (
              <span key={g.id} className="tag">
                {m.entities.find((x) => x.id === g.supertype)?.name ?? g.supertype}{' '}
                <button className="link" aria-label={`Remove the supertype ${m.entities.find((x) => x.id === g.supertype)?.name ?? ''}`} onClick={() => removeSuper(g)}>
                  ×
                </button>
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">Nothing</span>
        )}
        <select aria-label="Add a supertype" value="" onChange={(e) => addSuper(e.target.value)}>
          <option value="">Add a supertype…</option>
          {m.entities
            .filter((x) => x.id !== entity.id && !supers.some((g) => g.supertype === x.id) && !wouldCycle(m, x.id, entity.id))
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </div>
      <div className="ldm-block-row">
        <span className="ldm-label">Subtypes</span>
        {below?.subtypes.length ? (
          <span className="row wrap">
            {below.subtypes.map((id) => (
              <span key={id} className="tag">
                {m.entities.find((x) => x.id === id)?.name ?? id}{' '}
                <button className="link" aria-label={`Remove the subtype ${m.entities.find((x) => x.id === id)?.name ?? ''}`} onClick={() => setBelow({ subtypes: below.subtypes.filter((s) => s !== id) })}>
                  ×
                </button>
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">Nothing</span>
        )}
        <select aria-label="Add a subtype" value="" onChange={(e) => addSub(e.target.value)}>
          <option value="">Add a subtype…</option>
          {m.entities
            .filter((x) => x.id !== entity.id && !(below?.subtypes ?? []).includes(x.id) && !wouldCycle(m, entity.id, x.id))
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </div>
      {below && (
        <div className="ldm-block-row">
          <span className="ldm-label">Every instance</span>
          <label className="check" title="Every instance of the supertype is an instance of a subtype">
            <input type="checkbox" checked={below.complete} onChange={(e) => setBelow({ complete: e.target.checked })} />
            <span>is a subtype</span>
          </label>
          <label className="check" title="No instance is of two subtypes at once">
            <input type="checkbox" checked={below.exclusive} onChange={(e) => setBelow({ exclusive: e.target.checked })} />
            <span>is of one subtype only</span>
          </label>
          <label className="ldm-param">
            Discriminator
            <select value={below.discriminator ?? ''} onChange={(e) => setBelow({ discriminator: e.target.value || undefined })}>
              <option value="">none</option>
              {attributesOfEntity(m, entity.id).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- relationships

function RelationshipList({ m, selected, set, apply }: { m: LogicalModel; selected: string | null; set: (p: Partial<LdmViewState>) => void; apply: Apply }) {
  const add = () => {
    const made = relationshipAdded(m);
    if (made) apply([made.change], 'Made a relationship', () => set({ section: 'relationships', relationship: made.id, element: null }));
  };
  return (
    <aside className="ldm-list" aria-label="Relationships">
      <div className="ldm-list-tools">
        <button className="btn small primary" disabled={!m.entities.length} title={m.entities.length ? 'Make a relationship between two entities' : 'Make an entity first'} onClick={add}>
          New relationship
        </button>
      </div>
      {!m.relationships.length && <p className="muted">No relationship yet.</p>}
      <ul>
        {m.relationships.map((r) => (
          <li key={r.id}>
            <button className={selected === r.id ? 'on' : ''} onClick={() => set({ relationship: r.id, element: null })}>
              <span>{r.name || 'Unnamed relationship'}</span>
              <small className="muted">
                {m.entities.find((e) => e.id === r.ends[0].entity)?.name ?? '?'} {cardinalityText(r.ends[0])} · {m.entities.find((e) => e.id === r.ends[1].entity)?.name ?? '?'} {cardinalityText(r.ends[1])}
                {r.identifying ? ' · identifying' : ''}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function RelationshipEditor({ m, relationship, apply, set }: { m: LogicalModel; relationship: Relationship; apply: Apply; set: (p: Partial<LdmViewState>) => void }) {
  const update = (after: Record<string, unknown>, summary = 'Changed a relationship') => apply([updatedChange({ relationship: relationship.id }, relationship, after)], summary);
  const setEnd = (i: 0 | 1, end: RelationshipEnd) => {
    const ends: [RelationshipEnd, RelationshipEnd] = i === 0 ? [end, relationship.ends[1]] : [relationship.ends[0], end];
    update({ ends }, 'Changed a relationship end');
  };
  const resolve = () => {
    const result = resolveManyToMany(m, relationship.id);
    if ('error' in result) return useStore.getState().notify(result.error);
    apply(result.changes, 'Resolved a many-to-many relationship into an associative entity', () => set({ section: 'entities', entity: result.entity, element: null, relationship: null }));
  };
  const many = relationship.ends[0].max === 'many' && relationship.ends[1].max === 'many';
  return (
    <section className="ldm-editor" aria-label={`Relationship ${relationship.name}`}>
      <div className="ldm-title">
        <label className="field grow">
          <span>Name</span>
          <CommitInput aria-label="Relationship name" value={relationship.name} spellCheck={false} onCommit={(name) => update({ name: name.trim() })} />
        </label>
        <label className="check" title="The child’s identity includes the parent’s: ends[0] is the child">
          <input type="checkbox" checked={relationship.identifying} onChange={(e) => update({ identifying: e.target.checked })} />
          <span>Identifying</span>
        </label>
        <button className="btn small danger" onClick={() => apply(removalOf(m, { relationship: relationship.id }), 'Deleted a relationship', () => set({ relationship: null, element: null }))}>
          Delete relationship…
        </button>
      </div>
      <label className="field">
        <span>Definition</span>
        <CommitTextarea aria-label="Relationship definition" rows={2} value={relationship.definition} onCommit={(definition) => update({ definition })} />
      </label>
      {([0, 1] as const).map((i) => (
        <EndEditor key={i} m={m} end={relationship.ends[i]} label={i === 0 ? 'End 1 (the child when identifying)' : 'End 2 (the parent when identifying)'} onChange={(end) => setEnd(i, end)} />
      ))}
      {many && (
        <p className="ldm-note">
          This relationship is many-to-many, which a relational design cannot state directly.{' '}
          <button className="btn small" onClick={resolve}>
            Make an associative entity
          </button>{' '}
          The new entity takes the relationship’s name, and its primary key is the identity borrowed from both ends.
        </p>
      )}
    </section>
  );
}

function EndEditor({ m, end, label, onChange }: { m: LogicalModel; end: RelationshipEnd; label: string; onChange: (e: RelationshipEnd) => void }) {
  return (
    <fieldset className="ldm-end">
      <legend>{label}</legend>
      <label className="field">
        <span>Entity</span>
        <select aria-label={`${label}: entity`} value={end.entity} onChange={(e) => onChange(endChanged(end, { entity: e.target.value }))}>
          {m.entities.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Role</span>
        <CommitInput aria-label={`${label}: role`} value={end.role} placeholder="how the other end calls it" onCommit={(role) => onChange(endChanged(end, { role }))} />
      </label>
      <label className="field">
        <span>Minimum</span>
        <NumField aria-label={`${label}: minimum`} value={end.min} onCommit={(n) => onChange(endChanged(end, { min: n ?? 0 }))} />
      </label>
      <span className="field">
        <span>Maximum</span>
        <span className="row">
          <NumField aria-label={`${label}: maximum`} value={end.max === 'many' ? undefined : end.max} disabled={end.max === 'many'} onCommit={(n) => onChange(endChanged(end, { max: n ?? 1 }))} />
          <label className="check">
            <input type="checkbox" checked={end.max === 'many'} onChange={(e) => onChange(endChanged(end, { max: e.target.checked ? 'many' : Math.max(1, end.min) }))} />
            <span>many</span>
          </label>
        </span>
      </span>
    </fieldset>
  );
}

// ---------------------------------------------------------------- domains

function DomainList({ m, selected, set, apply }: { m: LogicalModel; selected: string | null; set: (p: Partial<LdmViewState>) => void; apply: Apply }) {
  const add = () => {
    const made = domainAdded(m);
    apply([made.change], 'Made a domain', () => set({ section: 'domains', domain: made.id, element: null }));
  };
  return (
    <aside className="ldm-list" aria-label="Domains">
      <div className="ldm-list-tools">
        <button className="btn small primary" onClick={add}>
          New domain
        </button>
      </div>
      {!m.domains.length && <p className="muted">No domain yet.</p>}
      <ul>
        {m.domains.map((d) => (
          <li key={d.id}>
            <button className={selected === d.id ? 'on' : ''} onClick={() => set({ domain: d.id, element: null })}>
              <span>{d.name}</span>
              <small className="muted">{baseText(d.base)}</small>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function DomainEditor({ m, domain, apply }: { m: LogicalModel; domain: LogicalDomain; apply: Apply }) {
  const update = (after: Record<string, unknown>, summary = 'Changed a domain') => apply([updatedChange({ domain: domain.id }, domain, after)], summary);
  const used = m.entities.flatMap((e) => e.attributes.filter((a) => 'domain' in a.type && a.type.domain === domain.id).map((a) => `${e.name}.${a.name}`));
  return (
    <section className="ldm-editor" aria-label={`Domain ${domain.name}`}>
      <div className="ldm-title">
        <label className="field grow">
          <span>Name</span>
          <CommitInput aria-label="Domain name" value={domain.name} spellCheck={false} onCommit={(name) => update({ name: name.trim() || 'Domain' })} />
        </label>
        <button className="btn small danger" disabled={used.length > 0} title={used.length ? `Used by ${used.join(', ')}` : 'Delete this domain'} onClick={() => apply(removalOf(m, { domain: domain.id }), 'Deleted a domain', () => undefined)}>
          Delete domain…
        </button>
      </div>
      <label className="field">
        <span>Definition</span>
        <CommitTextarea aria-label="Domain definition" rows={2} value={domain.definition} onCommit={(definition) => update({ definition })} />
      </label>
      <div className="ldm-block-row">
        <span className="ldm-label">Base type</span>
        <select aria-label="Domain base type" value={domain.base.base} onChange={(e) => update({ base: baseFromSetting(e.target.value), constraints: {} }, 'Changed the base type of a domain')}>
          {BASE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {domain.base.base === 'text' && (
          <label className="ldm-param">
            at most
            <NumField aria-label="Domain maximum length" value={domain.base.maxLength} onCommit={(n) => update({ base: { base: 'text', ...(n !== undefined ? { maxLength: n } : {}) } }, 'Changed the length of a domain')} />
          </label>
        )}
        {domain.base.base === 'decimal' && (
          <>
            <label className="ldm-param">
              precision
              <NumField aria-label="Domain precision" value={domain.base.precision} onCommit={(n) => update({ base: { base: 'decimal', ...(n !== undefined ? { precision: n } : {}), ...(domain.base.base === 'decimal' && domain.base.scale !== undefined ? { scale: domain.base.scale } : {}) } }, 'Changed the precision of a domain')} />
            </label>
            <label className="ldm-param">
              scale
              <NumField aria-label="Domain scale" value={domain.base.scale} onCommit={(n) => update({ base: { base: 'decimal', ...(domain.base.base === 'decimal' && domain.base.precision !== undefined ? { precision: domain.base.precision } : {}), ...(n !== undefined ? { scale: n } : {}) } }, 'Changed the scale of a domain')} />
            </label>
          </>
        )}
      </div>
      <div className="ldm-block">
        <div className="ldm-block-head">
          <h3>Constraints</h3>
        </div>
        <div className="ldm-grid">
          <label className="ldm-param">
            Minimum length
            <NumField aria-label="Domain minimum length" value={domain.constraints.minLength} onCommit={(n) => update({ constraints: { ...domain.constraints, minLength: n } })} />
          </label>
          <label className="ldm-param">
            Maximum length
            <NumField aria-label="Domain constraint maximum length" value={domain.constraints.maxLength} onCommit={(n) => update({ constraints: { ...domain.constraints, maxLength: n } })} />
          </label>
          <label className="ldm-param">
            Pattern
            <CommitInput aria-label="Domain pattern" value={domain.constraints.pattern ?? ''} placeholder="regular expression" onCommit={(pattern) => update({ constraints: { ...domain.constraints, pattern: pattern || undefined } })} />
          </label>
          <label className="ldm-param">
            Smallest
            <CommitInput aria-label="Domain smallest value" value={domain.constraints.min ?? ''} onCommit={(min) => update({ constraints: { ...domain.constraints, min: min || undefined } })} />
          </label>
          <label className="ldm-param">
            Largest
            <CommitInput aria-label="Domain largest value" value={domain.constraints.max ?? ''} onCommit={(max) => update({ constraints: { ...domain.constraints, max: max || undefined } })} />
          </label>
        </div>
        <div className="ldm-block-head">
          <h3>Values</h3>
          <button
            className="btn small"
            onClick={() => {
              const values = domain.constraints.values ?? [];
              // A value is made with a code, since a value with none cannot be stored; the code is a name to change.
              update({ constraints: { ...domain.constraints, values: [...values, { code: freeName(values.map((v) => v.code), 'Value'), label: '' }] } }, 'Added a value to a domain');
            }}
          >
            Add value
          </button>
        </div>
        {(domain.constraints.values ?? []).map((v, i) => (
          <div key={i} className="row">
            <CommitInput aria-label={`Code of value ${i + 1}`} placeholder="code" value={v.code} onCommit={(code) => update({ constraints: { ...domain.constraints, values: (domain.constraints.values ?? []).map((x, j) => (j === i ? { ...x, code } : x)) } })} />
            <CommitInput aria-label={`Label of value ${i + 1}`} placeholder="label" value={v.label} onCommit={(label) => update({ constraints: { ...domain.constraints, values: (domain.constraints.values ?? []).map((x, j) => (j === i ? { ...x, label } : x)) } })} />
            <button className="btn small danger" aria-label={`Delete value ${i + 1}`} onClick={() => update({ constraints: { ...domain.constraints, values: (domain.constraints.values ?? []).filter((_, j) => j !== i) } })}>
              Delete
            </button>
          </div>
        ))}
        {used.length > 0 && <p className="muted">Used by {used.join(', ')}.</p>}
      </div>
    </section>
  );
}

function baseFromSetting(setting: string): BaseType {
  if (setting === 'text' || setting === 'decimal') return { base: setting };
  // The dropdown only offers BASE_TYPES; anything else is text.
  return { base: (BASE_TYPES as readonly string[]).includes(setting) ? setting : 'text' } as BaseType;
}

// ---------------------------------------------------------------- rules

function RuleList({ m, selected, set, apply }: { m: LogicalModel; selected: string | null; set: (p: Partial<LdmViewState>) => void; apply: Apply }) {
  const [name, setName] = useState('');
  const [statement, setStatement] = useState('');
  const add = () => {
    const made = ruleAdded(m, { name, statement });
    if (!made) return useStore.getState().notify('A rule needs a name and a statement in words.');
    apply([made.change], 'Made a business rule', () => {
      setName('');
      setStatement('');
      set({ section: 'rules', rule: made.id, element: null });
    });
  };
  return (
    <aside className="ldm-list" aria-label="Business rules">
      <div className="ldm-rule-new">
        <label className="field">
          <span>Name</span>
          <input aria-label="Name of the new rule" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Statement</span>
          <textarea aria-label="Statement of the new rule" rows={3} value={statement} onChange={(e) => setStatement(e.target.value)} />
        </label>
        <button className="btn small primary" disabled={!name.trim() || !statement.trim()} onClick={add}>
          Add rule
        </button>
      </div>
      {!m.rules.length && <p className="muted">No rule yet.</p>}
      <ul>
        {m.rules.map((r) => (
          <li key={r.id}>
            <button className={selected === r.id ? 'on' : ''} onClick={() => set({ rule: r.id, element: null })}>
              <span>{r.name}</span>
              <small className="muted">
                {r.kind} · {r.status}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function RuleEditor({ m, rule, apply }: { m: LogicalModel; rule: BusinessRule; apply: Apply }) {
  const update = (after: Record<string, unknown>, summary = 'Changed a business rule') => apply([updatedChange({ rule: rule.id }, rule, after)], summary);
  const targets = useMemo(() => ruleTargets(m), [m]);
  const chosen = new Set(rule.appliesTo.map((r) => `${Object.keys(r)[0]}:${Object.values(r)[0]}`));
  const setChosen = (values: string[]) => {
    const appliesTo = targets.filter((t) => values.includes(`${t.kind}:${t.id}`)).map(refOfTarget);
    update({ appliesTo });
  };
  return (
    <section className="ldm-editor" aria-label={`Business rule ${rule.name}`}>
      <div className="ldm-title">
        <label className="field grow">
          <span>Name</span>
          <CommitInput aria-label="Rule name" value={rule.name} spellCheck={false} onCommit={(name) => update({ name: name.trim() || 'Rule' })} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select aria-label="Rule kind" value={rule.kind} onChange={(e) => update({ kind: e.target.value as BusinessRule['kind'] })}>
            <option value="constraint">Constraint</option>
            <option value="derivation">Derivation</option>
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select aria-label="Rule status" value={rule.status} onChange={(e) => update({ status: e.target.value as BusinessRule['status'] })}>
            <option value="accepted">Accepted</option>
            <option value="proposed">Proposed</option>
          </select>
        </label>
        <button className="btn small danger" onClick={() => apply(removalOf(m, { rule: rule.id }), 'Deleted a business rule', () => undefined)}>
          Delete rule…
        </button>
      </div>
      <label className="field">
        <span>Statement, in words</span>
        <CommitTextarea aria-label="Rule statement" rows={3} value={rule.statement} onCommit={(statement) => update({ statement }, 'Changed what a rule says')} />
      </label>
      <div className="ldm-block">
        <div className="ldm-block-head">
          <h3>Applies to</h3>
        </div>
        <select multiple className="ldm-targets" aria-label="What the rule applies to" value={[...chosen]} onChange={(e) => setChosen([...e.target.selectedOptions].map((o) => o.value))}>
          {targets.map((t) => (
            <option key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>
              {t.name} ({t.kind})
            </option>
          ))}
        </select>
        <p className="muted">Hold Ctrl or Cmd to choose more than one.</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- numbers

/** A whole number, reported once it is complete: on blur, or on Enter. */
function NumField({ value, onCommit, disabled, ...rest }: { value: number | undefined; onCommit: (n: number | undefined) => void; disabled?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'>) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    const text = draft.trim();
    if (!text) {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const n = Number(text);
    if (Number.isInteger(n) && n >= 0) onCommit(n);
    else setDraft(value === undefined ? '' : String(value));
  };
  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      disabled={disabled}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value === undefined ? '' : String(value));
          e.stopPropagation();
        }
      }}
    />
  );
}
