import { useMemo, useState } from 'react';
import {
  addCustomField,
  checkValue,
  fieldKey,
  fieldsFor,
  KIND_LABEL,
  KIND_SHORT,
  keyIri,
  metaEntities,
  metaText,
  overrideField,
  registry,
  removeCustomField,
  TYPE_LABEL,
  updateCustomField,
  valuesOf,
  DEFAULT_FIELDS,
  type MetaEntity,
  type MetaValue,
} from '../model/governance';
import { standardAnnotation } from '../model/annotations';
import { localName } from '../model/iri';
import { compactIri, isAbsoluteIri } from '../model/prefixes';
import { isStale, type Finding } from '../model/validation';
import { useStore } from '../model/store';
import { DATATYPES, ENTITY_KINDS, ENUM_RANGE, META_GROUPS, VALUE_TYPES, type EntityKind, type MetaField, type MetaGroup, type Model, type ValueType } from '../model/types';
import { EntityPicker, type Choice } from './EntityPicker';
import { CommitInput, CommitTextarea } from './fields';
import { IriCell } from './Iri';
import { Metadata } from './Metadata';

const PAGE = 150;
const st = useStore.getState;

/** The RDF property a field is stated with, as it is written in the export. */
function propertyOf(model: Model, f: Pick<MetaField, 'property' | 'label' | 'measure' | 'bind'>): string {
  if (f.bind === 'validation') return '';
  if (f.bind === 'name') return model.mode === 'skos' ? 'skos:prefLabel' : 'rdfs:label';
  const key = fieldKey(f);
  const own = standardAnnotation(key) ?? (keyIri(model, key) ? (compactIri(model, keyIri(model, key)!) ?? key) : ':' + localName(key, true));
  return f.measure ? `dqv:value of ${own}` : own;
}

/** A box that adds one value to a list when it is confirmed, and empties itself if the value was taken. */
function AddInput({ type, label, onAdd }: { type: ValueType; label: string; onAdd: (v: string) => string | undefined }) {
  const [text, setText] = useState('');
  const add = () => {
    if (text.trim() && !onAdd(text.trim())) setText('');
  };
  return (
    <input
      className="gov-add"
      type={type === 'date' ? 'date' : type === 'dateTime' ? 'datetime-local' : 'text'}
      inputMode={type === 'number' ? 'decimal' : type === 'integer' ? 'numeric' : undefined}
      aria-label={label}
      placeholder="Add…"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={add}
      onKeyDown={(e) => {
        if (e.key === 'Enter') add();
        if (e.key === 'Escape') {
          setText('');
          e.stopPropagation();
        }
      }}
    />
  );
}

/**
 * What the last validation run found about an entity: OWL, SHACL and quality findings alike.
 * It reads the run rather than checking the model again, which on a large model takes too long
 * to do after every edit.
 */
function Findings({ entity }: { entity: MetaEntity }) {
  const model = useStore((s) => s.model);
  const { run, data } = useStore((s) => s.validation);
  const about = (f: Finding) => ('term' in entity.owner ? f.terms.includes(entity.owner.term) || (f.entity?.kind === 'term' && f.entity.id === entity.owner.term) : f.entity?.kind === 'prop' && f.entity.id === entity.owner.prop);
  const found = run ? run.findings.filter(about) : [];
  const worst = (['error', 'warning'] as const).find((l) => found.some((f) => f.severity === l));
  return (
    <span className="gov-ro">
      {!run ? (
        'Not validated yet. '
      ) : (
        <>
          <span className={worst ? 'bad' : found.length ? '' : 'good'}>{found.length ? `${found.length} finding${found.length === 1 ? '' : 's'}` : '✓ No findings'}</span> in the last validation run{isStale(run, model, data) ? ', which was before the latest changes' : ''}.{' '}
        </>
      )}
      <button className="link" onClick={() => st().setView('checks')}>
        Open validation
      </button>
    </span>
  );
}

/** The control for one field of one entity: what it shows and how it is edited follows the field's value type. */
function FieldControl({ model, entity, field, values, names }: { model: Model; entity: MetaEntity; field: MetaField; values: MetaValue[]; names: Map<string, string> }) {
  const [error, setError] = useState<string | undefined>();
  const locked = entity.external;
  const label = `${field.label} of ${entity.name || 'Unnamed'}`;
  const commit = (next: MetaValue[]) => {
    const refused = st().setMeta(entity.owner, field.id, next);
    setError(refused);
    return refused;
  };
  const one = (v: string) => commit(v.trim() ? [{ value: v, ...(values[0]?.lang ? { lang: values[0].lang } : {}) }] : []);
  // A value that was imported, or typed into the annotations, and is not what the field takes.
  const stale = field.bind ? undefined : values.map((v) => checkValue(field, v)).find(Boolean);
  const first = values[0]?.value ?? '';

  let control;
  if (field.bind === 'type') {
    control = <span className="gov-ro">{first}</span>;
  } else if (field.bind === 'validation') {
    control = <Findings entity={entity} />;
  } else if (field.type === 'entity') {
    const all = () =>
      metaEntities(model)
        .filter((e) => e.iri && e.id !== entity.id)
        .map((e): Choice => ({ id: 'iri:' + e.iri, name: e.name || 'Unnamed', iri: e.iri }));
    const chosen = values.map((v): Choice => (v.iri ? { id: 'iri:' + v.value, name: names.get(v.value) ?? compactIri(model, v.value) ?? v.value, iri: v.value } : { id: 'text:' + v.value, name: v.value }));
    const parse = (id: string): MetaValue => (id.startsWith('iri:') ? { value: id.slice(4), iri: true } : { value: id.slice(5) });
    control = (
      <EntityPicker
        values={locked ? chosen.map((c) => ({ ...c, locked: 'Belongs to another ontology' })) : chosen}
        options={all}
        noun={field.label.toLowerCase()}
        of={entity.name}
        addLabel={`Add ${field.label.toLowerCase()}`}
        searchLabel={`Search for ${field.label.toLowerCase()}`}
        max={locked ? 0 : field.multiple ? undefined : 1}
        // Anything typed can be a value: a link if it is one, and otherwise a name as text.
        custom={(text) => (/^(https?:\/\/|urn:)/i.test(text) && isAbsoluteIri(text) ? { id: 'iri:' + text, name: text, iri: text } : { id: 'text:' + text, name: text, tag: 'use as text' })}
        onAdd={(id) => commit([...values, parse(id)])}
        onRemove={(id) => void commit(values.filter((v) => (v.iri ? 'iri:' : 'text:') + v.value !== id))}
        onOpen={(id) => {
          const iri = id.startsWith('iri:') ? id.slice(4) : '';
          const term = model.terms.find((t) => iri && t.iri === iri);
          const prop = model.props.find((p) => iri && p.iri === iri);
          if (term) st().select([term.id]);
          else if (prop) st().selectProp(prop.name.trim().toLowerCase());
        }}
      />
    );
  } else if (field.multiple) {
    const options = field.type === 'choice' ? (field.options ?? []).filter((o) => !values.some((v) => v.value.toLowerCase() === o.toLowerCase())) : [];
    const add = (v: string) => commit([...values, { value: field.type === 'dateTime' && v.length === 16 ? v + ':00' : v }]);
    control = (
      <div className="gov-multi">
        <div className="chips-inline">
          {values.map((v, i) => (
            <span key={i} className="chip-x">
              <span>
                {v.value}
                {v.lang && <span className="lang">@{v.lang}</span>}
              </span>
              {!locked && (
                <button aria-label={`Remove ${v.value} from ${label}`} title="Remove this value" onClick={() => void commit(values.filter((_, j) => j !== i))}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {!locked &&
          (field.type === 'choice' ? (
            <select className="gov-add" aria-label={`Add to ${label}`} value="" onChange={(e) => e.target.value && add(e.target.value)}>
              <option value="">Add…</option>
              {options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <AddInput type={field.type} label={`Add to ${label}`} onAdd={add} />
          ))}
      </div>
    );
  } else if (field.bind === 'range' || field.type === 'choice' || field.type === 'boolean') {
    const options: { id: string; label: string }[] =
      field.bind === 'range' ? [...DATATYPES.map((d) => ({ id: d.id, label: `${d.label} (${d.id})` })), ...model.datatypes.map((d) => ({ id: ENUM_RANGE + d.id, label: `${d.name} (enumerated)` }))] : field.type === 'boolean' ? [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }] : (field.options ?? []).map((o) => ({ id: o, label: o }));
    const current = options.find((o) => o.id.toLowerCase() === first.toLowerCase())?.id ?? first;
    control = (
      <select aria-label={label} value={current} disabled={locked} aria-invalid={!!stale} onChange={(e) => one(e.target.value)}>
        <option value="">—</option>
        {first && !options.some((o) => o.id === current) && <option value={first}>{first} (not in the list)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'longtext') {
    control = <CommitTextarea aria-label={label} rows={3} value={first} disabled={locked} onCommit={(v) => void one(v)} />;
  } else if (field.type === 'date' || field.type === 'dateTime') {
    const local = field.type === 'date';
    // The picker speaks the same form the value is stored in; a value it cannot show is left for the text box.
    const shown = local ? first.slice(0, 10) : first.slice(0, 16);
    control = stale ? (
      <CommitInput aria-label={label} aria-invalid value={first} disabled={locked} onCommit={(v) => void one(v)} />
    ) : (
      <input type={local ? 'date' : 'datetime-local'} aria-label={label} value={shown} disabled={locked} onChange={(e) => one(!local && e.target.value.length === 16 ? e.target.value + ':00' : e.target.value)} />
    );
  } else {
    control = (
      <CommitInput
        aria-label={label}
        aria-invalid={!!(error || stale)}
        inputMode={field.type === 'number' ? 'decimal' : field.type === 'integer' ? 'numeric' : field.type === 'iri' ? 'url' : undefined}
        placeholder={field.type === 'iri' ? 'https://…' : field.min !== undefined && field.max !== undefined ? `${field.min} to ${field.max}` : undefined}
        value={first}
        disabled={locked}
        onCommit={(v) => void one(v)}
      />
    );
  }

  const property = propertyOf(model, field);
  const empty = !values.length && field.bind !== 'validation';
  return (
    <div className={'field gov-field' + (field.required && empty ? ' missing' : '')} data-field={field.id}>
      <span>
        <span title={field.about || undefined}>{field.label}</span>
        {field.required && (
          <abbr className="gov-req" title="Required for this kind of entity. Set under Configure fields.">
            required
          </abbr>
        )}
        {property && (
          <code className="gov-prop" title={`Stored as ${property}`}>
            {property}
          </code>
        )}
      </span>
      {control}
      {(error || stale) && (
        <small className="bad" role="alert">
          {error ?? stale}
        </small>
      )}
    </div>
  );
}

/** Everything the registry has for one entity, grouped, with the entity's other annotations below. */
function MetaForm({ model, entity, names }: { model: Model; entity: MetaEntity; names: Map<string, string> }) {
  const fields = useMemo(() => fieldsFor(model, entity.kind), [model, entity.kind]);
  const term = 'term' in entity.owner ? entity.owner.term : undefined;
  const profiles: EntityKind[] = [entity.structural, 'businessAsset', 'technicalAsset'];
  // Annotations no field of this kind of entity shows: they are listed at the end, so that nothing is hidden.
  const covered = fields.filter((f) => !f.bind).map((f) => fieldKey(f).toLowerCase());
  const others = entity.fields.filter((f) => !covered.includes((standardAnnotation(f.key) ?? f.key.trim()).toLowerCase())).length;
  return (
    <div className="gov-form" aria-label={`Metadata of ${entity.name || 'Unnamed'}`}>
      <div className="gov-form-head">
        <h3>{entity.name || 'Unnamed'}</h3>
        <IriCell iri={entity.iri} of={entity.name} />
        {term && !entity.external && (
          <label className="gov-profile" title="Which set of metadata fields this entity has. A data asset is still the class, property or individual it is in the model; the profile is recorded as its dcterms:type.">
            <span>Metadata profile</span>
            <select aria-label="Metadata profile" value={entity.kind} onChange={(e) => st().setProfile(term, e.target.value as EntityKind)}>
              {profiles.map((k) => (
                <option key={k} value={k}>
                  {model.mode === 'skos' && k === 'class' ? 'Concept' : KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {entity.external && <p className="muted note">This entity belongs to another ontology. Its metadata is that ontology’s to state, so it is shown here but not edited.</p>}
      {META_GROUPS.map((group) => {
        const own = fields.filter((f) => f.group === group);
        if (!own.length) return null;
        const filled = own.filter((f) => f.bind !== 'validation' && valuesOf(model, entity, f).length).length;
        return (
          <details key={group} className="gov-group" open>
            <summary>
              {group === 'Custom' ? 'Custom' : `${group} metadata`}{' '}
              {own.some((f) => f.bind !== 'validation') && (
                <span className="muted">
                  {filled} of {own.filter((f) => f.bind !== 'validation').length} filled in
                </span>
              )}
            </summary>
            <div className="gov-fields">
              {own.map((f) => (
                <FieldControl key={entity.id + '|' + f.id} model={model} entity={entity} field={f} values={valuesOf(model, entity, f)} names={names} />
              ))}
            </div>
          </details>
        );
      })}
      {!entity.external && (
        <details className="gov-group">
          <summary>
            All annotations <span className="muted">{entity.fields.length} stored{others ? `, ${others} not shown above` : ''}</span>
          </summary>
          <div className="gov-fields one">
            <p className="muted note">The same values as above, as they are kept on the entity. Changing one here changes it there, and the other way round.</p>
            <Metadata title="Annotations" fields={entity.fields} onChange={(next) => ('term' in entity.owner ? st().updateTerm(entity.owner.term, { fields: next }) : st().updateProp(entity.owner.prop, { fields: next }))} />
          </div>
        </details>
      )}
    </div>
  );
}

const blank = { label: '', property: '', type: 'text' as ValueType, group: 'Custom' as MetaGroup, options: '' };

/** The field registry: which fields there are, what each is stored as, and which kinds of entity it applies to. */
function RegistryEditor({ model }: { model: Model }) {
  const fields = registry(model);
  const [draft, setDraft] = useState(blank);
  const [error, setError] = useState<string | undefined>();
  const run = (fn: (m: Model) => ReturnType<typeof addCustomField>) => {
    const refused = st().edit(fn);
    setError(refused);
    return !refused;
  };
  const list = (text: string) => [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))];
  const change = (f: MetaField, patch: Partial<MetaField>) => run((m) => (f.custom ? updateCustomField(m, f.id, patch) : overrideField(m, f.id, patch)));
  const toggle = (f: MetaField, k: EntityKind) => change(f, { appliesTo: ENTITY_KINDS.filter((x) => (x === k ? !f.appliesTo.includes(k) : f.appliesTo.includes(x))) });
  const add = () => {
    if (run((m) => addCustomField(m, { label: draft.label, property: draft.property, type: draft.type, group: draft.group, ...(draft.type === 'choice' ? { options: list(draft.options) } : {}) }))) setDraft(blank);
  };
  return (
    <div className="gov-config">
      <p className="muted note">
        Every metadata field is an entry here: its name, the RDF property its values are stored as, the kind of value it takes, and the kinds of entity it applies to. Standard fields keep their property and value type; you decide where they apply and whether they are required. A required
        field is a rule of this model, reported under Validation; it is not an OWL constraint.
      </p>
      {error && (
        <p className="bad gov-error" role="alert">
          {error}{' '}
          <button className="link" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </p>
      )}
      <div className="gov-new" role="group" aria-label="New field">
        <label>
          <span>New field</span>
          <input aria-label="Name of the new field" placeholder="Name, e.g. Retention period" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
        </label>
        <label>
          <span>RDF property</span>
          <input aria-label="RDF property of the new field" placeholder="dcterms:… or empty for your own" value={draft.property} onChange={(e) => setDraft({ ...draft, property: e.target.value })} />
        </label>
        <label>
          <span>Value type</span>
          <select aria-label="Value type of the new field" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as ValueType })}>
            {VALUE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {draft.type === 'choice' && (
          <label>
            <span>Values to choose from</span>
            <input aria-label="Values of the new field" placeholder="Low, Medium, High" value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} />
          </label>
        )}
        <label>
          <span>Group</span>
          <select aria-label="Group of the new field" value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value as MetaGroup })}>
            {META_GROUPS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={!draft.label.trim()} onClick={add}>
          Add field
        </button>
      </div>
      <table className="gov-registry">
        <thead>
          <tr>
            <th style={{ width: '17%' }}>Field</th>
            <th style={{ width: '17%' }}>RDF property</th>
            <th style={{ width: '11%' }}>Group</th>
            <th style={{ width: '15%' }}>Value type</th>
            {ENTITY_KINDS.map((k) => (
              <th key={k} className="gov-kind" title={`Applies to: ${KIND_LABEL[k]}`}>
                {KIND_SHORT[k]}
              </th>
            ))}
            <th className="gov-kind">Required</th>
            <th className="gov-kind">Several</th>
            <th style={{ width: 70 }} />
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => {
            const fixed = f.bind === 'type' || f.bind === 'validation';
            const changed = !f.custom && !!model.governance.overrides[f.id];
            return (
              <tr key={f.id} data-field={f.id} className={f.custom ? 'custom' : ''}>
                <td title={f.about || undefined}>
                  {f.custom ? <CommitInput aria-label={`Name of ${f.label}`} value={f.label} onCommit={(v) => change(f, { label: v })} /> : f.label}
                  {f.custom && <span className="tag auto">custom</span>}
                </td>
                <td className={f.custom ? '' : 'ro'}>
                  {f.custom ? (
                    <CommitInput aria-label={`RDF property of ${f.label}`} placeholder={':' + localName(f.label, true)} value={f.property} onCommit={(v) => change(f, { property: v })} />
                  ) : (
                    <code>{propertyOf(model, f) || '—'}</code>
                  )}
                </td>
                <td className={f.custom ? '' : 'ro'}>
                  {f.custom ? (
                    <select aria-label={`Group of ${f.label}`} value={f.group} onChange={(e) => change(f, { group: e.target.value as MetaGroup })}>
                      {META_GROUPS.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  ) : (
                    f.group
                  )}
                </td>
                <td className={f.custom ? '' : 'ro'}>
                  {f.custom ? (
                    <>
                      <select aria-label={`Value type of ${f.label}`} value={f.type} onChange={(e) => change(f, { type: e.target.value as ValueType, ...(e.target.value === 'choice' && !f.options?.length ? { options: ['Yes', 'No'] } : {}) })}>
                        {VALUE_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {TYPE_LABEL[t]}
                          </option>
                        ))}
                      </select>
                      {f.type === 'choice' && <CommitInput aria-label={`Values of ${f.label}`} title="The values to choose from, separated by commas" value={(f.options ?? []).join(', ')} onCommit={(v) => change(f, { options: list(v) })} />}
                    </>
                  ) : (
                    <span title={f.options?.join(', ')}>
                      {f.bind && f.bind !== 'range' ? 'From the entity' : TYPE_LABEL[f.type]}
                      {f.options && !f.bind ? `: ${f.options.join(', ')}` : ''}
                    </span>
                  )}
                </td>
                {ENTITY_KINDS.map((k) => (
                  <td key={k} className="gov-kind">
                    <input type="checkbox" aria-label={`${f.label} applies to ${KIND_LABEL[k]}`} checked={f.appliesTo.includes(k)} disabled={(f.bind === 'synonyms' && k === 'objectProperty') || (f.bind === 'range' && k !== 'dataProperty')} onChange={() => toggle(f, k)} />
                  </td>
                ))}
                <td className="gov-kind">
                  <input type="checkbox" aria-label={`${f.label} is required`} checked={f.required} disabled={fixed} onChange={() => change(f, { required: !f.required })} />
                </td>
                <td className="gov-kind">
                  {f.custom ? <input type="checkbox" aria-label={`${f.label} can have several values`} checked={f.multiple} onChange={() => change(f, { multiple: !f.multiple })} /> : f.multiple ? '✓' : ''}
                </td>
                <td className="row-actions">
                  {f.custom && (
                    <button className="btn icon ghost" title="Remove this field. Values entities have for it are kept as annotations." aria-label={`Remove the field ${f.label}`} onClick={() => run((m) => removeCustomField(m, f.id))}>
                      ×
                    </button>
                  )}
                  {changed && (
                    <button className="link" title="Back to how this standard field is set up by default" onClick={() => run((m) => overrideField(m, f.id, { appliesTo: DEFAULT_FIELDS.find((x) => x.id === f.id)!.appliesTo, required: false }))}>
                      reset
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Governance & Metadata: every entity of the model with who owns it and where it stands, and
 * for the selected one all the metadata that applies to its kind. The values are the entity's
 * annotations, so they travel with it through export, import and saving like any other.
 */
export function GovernanceView({ configuring }: { configuring: boolean }) {
  const model = useStore((s) => s.model);
  const sel = useStore((s) => s.sel);
  const selProp = useStore((s) => s.selProp);
  const filter = useStore((s) => s.filter);
  const [limit, setLimit] = useState(PAGE);
  const entities = useMemo(() => metaEntities(model), [model]);
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const names = useMemo(() => new Map(entities.filter((e) => e.iri).map((e) => [e.iri!, e.name || 'Unnamed'])), [entities]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entities;
    return entities.filter((e) => `${e.name}\n${e.description}\n${e.synonyms}\n${e.iri ?? ''}\n${KIND_LABEL[e.kind]}\n${metaText(e, (iri) => names.get(iri))}`.toLowerCase().includes(q));
  }, [entities, names, filter]);
  const fields = useMemo(() => registry(model), [model]);
  const current = selProp ? byId.get('prop:' + selProp) : sel.terms.length === 1 ? byId.get(sel.terms[0]) : undefined;
  const status = fields.find((f) => f.id === 'status');
  const owner = fields.find((f) => f.id === 'owner');
  const nameOf = (v: MetaValue) => (v.iri ? (names.get(v.value) ?? compactIri(model, v.value) ?? v.value) : v.value);
  const cell = (e: MetaEntity, f?: MetaField) => (f && f.appliesTo.includes(e.kind) ? valuesOf(model, e, f).map(nameOf).join(', ') || '—' : '');
  const required = (e: MetaEntity) => fieldsFor(model, e.kind).filter((f) => f.required && f.bind !== 'type' && f.bind !== 'validation');

  if (configuring) return <div className="table-wrap"><RegistryEditor model={model} /></div>;
  return (
    <div className="gov">
      <div className="gov-list table-wrap">
        <table>
          <thead>
            <tr>
              <th>Entity</th>
              <th style={{ width: '22%' }}>Kind</th>
              <th style={{ width: '20%' }}>Status</th>
              <th style={{ width: '22%' }}>Data owner</th>
              <th style={{ width: 84 }}>Required</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((e) => {
              const need = required(e);
              const missing = need.filter((f) => !valuesOf(model, e, f).length).length;
              return (
                <tr key={e.id} className={'readonly' + (current?.id === e.id ? ' sel' : '')} tabIndex={0} aria-selected={current?.id === e.id} onClick={() => ('term' in e.owner ? st().select([e.owner.term]) : st().selectProp(e.owner.prop))} onKeyDown={(ev) => ev.key === 'Enter' && ('term' in e.owner ? st().select([e.owner.term]) : st().selectProp(e.owner.prop))}>
                  <td>{e.name || 'Unnamed'}</td>
                  <td>{model.mode === 'skos' && e.kind === 'class' ? 'Concept' : KIND_LABEL[e.kind]}</td>
                  <td>{cell(e, status)}</td>
                  <td>{cell(e, owner)}</td>
                  <td>{e.external ? '' : !need.length ? '—' : missing ? <span className="bad">{missing} missing</span> : <span className="good">✓ complete</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && <p className="muted pad">{filter.trim() ? `Nothing matches “${filter.trim()}”.` : 'Nothing here yet.'}</p>}
        {shown.length > limit && (
          <p className="pager">
            Showing {limit} of {shown.length}.
            <button className="btn small" onClick={() => setLimit(limit + PAGE * 2)}>
              Show more
            </button>
          </p>
        )}
      </div>
      <div className="gov-detail">{current ? <MetaForm model={model} entity={current} names={names} /> : <p className="muted pad">Select an entity, here or in the list on the left, to see and edit its metadata.</p>}</div>
    </div>
  );
}
