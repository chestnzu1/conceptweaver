import { useStore } from '../model/store';
import { useState } from 'react';
import { baseIriOf } from '../model/iri';
import { DATATYPES, QUANTIFIERS, type Quantifier, isLang, kindLabel, REL_KINDS, relLabel, TYPE_CHOICES, typeChoice, type Relation, type ModelMode, type RelKind, type Term } from '../model/types';
import { REL_CHOICES, relChoice, type RelChoice, CHARACTERISTICS, dataDomain, findProp, fitsIn, objectProperties, propKey, quantifierOf, restrictionsOf, type PropView } from '../model/props';
import { activeProps, automaticMeaning, resolveModel } from '../model/vocab';
import { Swatches } from './ContextMenu';
import { CommitInput, CommitTextarea } from './fields';
import { IriCell, SuperclassEditor } from './Iri';
import { Metadata } from './Metadata';
import { TermChips } from './TermChips';

export function Inspector() {
  const model = useStore((s) => s.model);
  const sel = useStore((s) => s.sel);
  const terms = model.terms.filter((t) => sel.terms.includes(t.id));
  const rels = model.relations.filter((r) => sel.rels.includes(r.id));
  const selProp = useStore((s) => s.selProp);
  const prop = selProp && model.mode !== 'skos' ? findProp(model, selProp) : undefined;

  let body;
  if (prop && !terms.length && !rels.length) body = <ObjectPropertyPanel key={prop.key} prop={prop} />;
  else if (terms.length === 1 && !rels.length) body = <TermPanel key={terms[0].id} term={terms[0]} />;
  else if (rels.length === 1 && !terms.length) body = <RelationPanel key={rels[0].id} rel={rels[0]} />;
  else if (terms.length + rels.length > 1) body = <MultiPanel terms={terms} rels={rels} />;
  else body = <ModelPanel />;
  return <aside className="panel inspector">{body}</aside>;
}

function ModelPanel() {
  const model = useStore((s) => s.model);
  const apply = useStore((s) => s.apply);
  return (
    <>
      <h2>Model</h2>
      <label className="field">
        <span>Name</span>
        <CommitInput value={model.name} onCommit={(name) => apply((m) => ({ ...m, name: name.trim() || 'Untitled model' }))} />
      </label>
      <label className="field">
        <span>Description</span>
        <CommitTextarea rows={4} value={model.description} onCommit={(description) => apply((m) => ({ ...m, description }))} />
      </label>
      <div className="field">
        <span>Default namespace</span>
        <code className="ns-summary" title="New entities get their IRI in this namespace">
          {baseIriOf(model)}
        </code>
        <button className="btn small" onClick={() => useStore.getState().setDialog('settings')}>
          Ontology IRI and prefixes…
        </button>
      </div>
      <div className="field two">
        <label>
          <span>Model type</span>
          <select value={model.mode} onChange={(e) => useStore.getState().convertTo(e.target.value as ModelMode)}>
            <option value="skos">Concept scheme (SKOS)</option>
            <option value="ontology">Ontology (OWL)</option>
          </select>
        </label>
        <label style={{ flex: '0 0 84px' }}>
          <span>Language</span>
          <CommitInput
            value={model.lang}
            placeholder="e.g. en"
            title="Language of the names, descriptions and synonyms. Labels in other languages go in a term's metadata."
            onCommit={(v) => {
              const lang = v.trim().toLowerCase();
              if (lang && !isLang(lang)) return useStore.getState().notify(`“${v}” is not a language code. Use one like en, nl or zh.`);
              apply((m) => ({ ...m, lang }));
            }}
          />
        </label>
      </div>
      {model.mode === 'ontology' && (
        <label className="check">
          <input type="checkbox" checked={model.vocab.enabled} onChange={(e) => useStore.getState().setVocabEnabled(e.target.checked)} />
          <span>Use RDFS &amp; OWL properties</span>
        </label>
      )}
      <button className="btn small" onClick={() => useStore.getState().setView('vocab')}>
        {model.mode === 'skos' ? 'SKOS relations and conversion…' : 'Map relationships and convert…'}
      </button>
      <p className="stat">
        {model.terms.length} terms · {model.relations.length} relations
      </p>
      <h3>On the canvas</h3>
      <dl className="keys">
        <dt>Double-click</dt>
        <dd>Add a term, or rename one</dd>
        <dt>Drag the ⊕ handle</dt>
        <dd>Relate two terms</dd>
        <dt>Right-click</dt>
        <dd>Menu for anything</dd>
        <dt>Ctrl + drag</dt>
        <dd>Box-select</dd>
        <dt>Shift + click</dt>
        <dd>Add to selection</dd>
        <dt>Del</dt>
        <dd>Delete the selection</dd>
        <dt>Ctrl + Z / Y</dt>
        <dd>Undo / redo</dd>
      </dl>
    </>
  );
}

function TermPanel({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.updateTerm);
  const st = useStore.getState;
  const skos = model.mode === 'skos';
  const name = new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed']));
  const related = resolveModel(model).relations.filter((r) => r.from === term.id || r.to === term.id);

  return (
    <>
      <h2>Term</h2>
      <label className="field">
        <span>{skos ? 'Preferred label' : 'Name'}</span>
        <CommitInput value={term.name} onCommit={(v) => update(term.id, { name: v.trim() })} />
      </label>
      <div className="field">
        <span title="The identifier of this entity. It was made once and does not change when the name does.">IRI</span>
        <IriCell iri={term.iri} of={term.name} full />
      </div>
      {/* A concept scheme only has concepts; the choice shows up just to fix a term that isn't one. */}
      {(!skos || term.type !== 'concept') && (
        <label className="field">
          <span>Type</span>
          <select value={typeChoice(term)} onChange={(e) => update(term.id, TYPE_CHOICES.find((c) => c.value === e.target.value)!.patch)}>
            {TYPE_CHOICES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {term.type === 'property' && !skos && <PropertyFields term={term} />}
      {term.type === 'concept' && (
        <div className="field">
          <span title={skos ? undefined : 'Explicitly stated superclasses (rdfs:subClassOf). Ones that only follow from these are not listed.'}>{skos ? 'Broader concepts' : 'Asserted superclasses'}</span>
          <SuperclassEditor term={term} />
        </div>
      )}
      {term.type === 'concept' && !skos && <ClassRestrictions term={term} />}
      {term.axioms?.length ? (
        <>
          <h3>Other asserted expressions ({term.axioms.length})</h3>
          <p className="muted">Class expressions from the imported ontology that the canvas has no drawing for. They are kept exactly as written and exported with the class.</p>
          <ul className="axioms">
            {term.axioms.map((a, i) => (
              <li key={i}>
                <code>{a}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="field">
        <span>Colour</span>
        <Swatches value={term.color} onPick={(color) => update(term.id, { color })} />
      </div>
      <label className="field">
        <span>{skos ? 'Definition' : 'Description'}</span>
        <CommitTextarea rows={5} value={term.description} placeholder="What does this term mean?" onCommit={(description) => update(term.id, { description })} />
      </label>
      <label className="field">
        <span>{skos ? 'Alternative labels' : 'Synonyms'}</span>
        <CommitInput value={term.synonyms} placeholder="Comma-separated" onCommit={(synonyms) => update(term.id, { synonyms })} />
      </label>

      <Metadata term={term} />

      <h3>Relations ({related.length})</h3>
      {related.length > 0 && (
        <div className="row wrap">
          <span className="muted">Highlight</span>
          <button className="btn small" title="Terms with a relation pointing to this one" onClick={() => st().showNeighbours([term.id], 'in')}>
            Incoming
          </button>
          <button className="btn small" title="Terms this one has a relation pointing to" onClick={() => st().showNeighbours([term.id], 'out')}>
            Outgoing
          </button>
          <button className="btn small" onClick={() => st().showNeighbours([term.id], 'both')}>
            Both
          </button>
        </div>
      )}
      {related.length === 0 && <p className="muted">None yet. Drag the ⊕ handle on the term to another term.</p>}
      <ul className="rel-list">
        {related.map((r) => (
          <li key={r.id}>
            <button onClick={() => st().select([], [r.id])} title="Open this relation">
              {r.from === term.id ? (
                <>
                  <em>{relLabel(r, skos) || (skos ? 'related' : '→')}</em> {name.get(r.to)}
                </>
              ) : (
                <>
                  {name.get(r.from)} <em>{relLabel(r, skos) || (skos ? 'related' : '→')}</em> this
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      <button className="btn danger" onClick={() => st().remove([term.id], [])}>
        Delete term
      </button>
    </>
  );
}

/** A data property: the classes that have it, its domain, and the type of its values. */
function PropertyFields({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const attached = model.relations.filter((r) => r.kind === 'property' && r.to === term.id);
  const domain = dataDomain(model, term);
  const name = (id: string) => model.terms.find((t) => t.id === id)?.name || 'Unnamed';
  const outside = domain.auto ? [] : attached.filter((r) => model.terms.find((t) => t.id === r.from)?.type === 'concept' && !fitsIn(model, r.from, domain.ids));
  return (
    <>
      <div className="field">
        <span>Attached to: the classes that have it</span>
        <TermChips
          ids={attached.map((r) => r.from)}
          placeholder={attached.length ? 'Attach to another…' : 'Choose a class…'}
          add={(id) => st().addRelation({ from: id, to: term.id, kind: 'property' })}
          remove={(id) => st().remove([], attached.filter((r) => r.from === id).map((r) => r.id))}
        />
      </div>
      <div className="field">
        <span>Domain</span>
        <TermChips
          ids={domain.ids}
          placeholder={domain.ids.length ? 'Add another…' : 'Choose a class…'}
          add={(id) => st().updateTerm(term.id, { domain: [...domain.ids, id] })}
          remove={(id) => st().updateTerm(term.id, { domain: domain.ids.filter((x) => x !== id) })}
        />
        {domain.auto ? (
          <small>Follows the classes it is attached to. Choose a class, for example a more general one, to set it yourself.</small>
        ) : (
          <small>
            Set by you.{' '}
            <button className="link" onClick={() => st().updateTerm(term.id, { domain: undefined })}>
              Follow the attached classes again
            </button>
          </small>
        )}
        {outside.map((r) => (
          <small key={r.id} className="bad">
            ✗ {name(r.from)} has this property but is not {domain.ids.map(name).join(' or ')} or a kind of it.
          </small>
        ))}
        {!domain.auto && attached.length > 0 && !outside.length && <small className="good">✓ Every class that has it is inside the domain.</small>}
      </div>
      <label className="field">
        <span>Range: the type of its values</span>
        <select aria-label="Datatype" value={term.range ?? ''} onChange={(e) => st().updateTerm(term.id, { range: e.target.value || undefined })}>
          <option value="">Not set</option>
          {DATATYPES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id} ({d.label})
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/** Quantifier of a restriction, with its number where one is needed. */
function QuantifierSelect({ rel }: { rel: Relation }) {
  const update = useStore((s) => s.updateRelation);
  const q = quantifierOf(rel);
  const counted = q === 'min' || q === 'max' || q === 'exactly';
  return (
    <span className="quant">
      <select
        aria-label="Quantifier"
        value={q}
        onChange={(e) => {
          const next = e.target.value as Quantifier;
          const n = next === 'min' || next === 'max' || next === 'exactly';
          update(rel.id, { restriction: next === 'some' ? undefined : next, restrictionN: n ? (rel.restrictionN ?? 1) : undefined });
        }}
      >
        {QUANTIFIERS.map((x) => (
          <option key={x.id} value={x.id} title={x.about}>
            {x.id}
          </option>
        ))}
      </select>
      {counted && (
        <input
          type="number"
          min={0}
          aria-label="Number"
          value={rel.restrictionN ?? 1}
          onChange={(e) => update(rel.id, { restrictionN: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
        />
      )}
    </span>
  );
}

/** A class described the OWL way: how its object and data properties restrict it. */
function ClassRestrictions({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const restrictions = restrictionsOf(model, term.id);
  const objProps = objectProperties(model);
  const dataProps = model.terms.filter((t) => t.type === 'property').sort((a, b) => a.name.localeCompare(b.name));
  const classes = model.terms.filter((t) => t.type === 'concept').sort((a, b) => a.name.localeCompare(b.name));
  const [prop, setProp] = useState('');
  const [target, setTarget] = useState('');
  const isData = prop.startsWith('d:');
  const add = () => {
    if (isData) st().addRelation({ from: term.id, to: prop.slice(2), kind: 'property' });
    else st().addRelation({ from: term.id, to: target, label: objProps.find((p) => p.key === prop.slice(2))!.name });
    setProp('');
    setTarget('');
  };
  return (
    <>
      <h3>Restrictions ({restrictions.length})</h3>
      {restrictions.length === 0 && <p className="muted">None. A restriction says what every member of this class has: “directs some Film”, “release date some date”.</p>}
      <ul className="restrictions">
        {restrictions.map((r) => (
          <li key={r.rel.id}>
            <button className="link" title="Show on the canvas" onClick={() => st().focusRelation(r.rel.id)}>
              {r.property}
            </button>
            <QuantifierSelect rel={r.rel} />
            <span className={r.data ? 'datatype' : ''}>{r.filler}</span>
            <button className="btn icon ghost" title="Remove this restriction" aria-label={`Remove ${r.text}`} onClick={() => st().remove([], [r.rel.id])}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="restriction-add">
        <select aria-label="Property to restrict by" value={prop} onChange={(e) => setProp(e.target.value)}>
          <option value="">Add: choose a property…</option>
          <optgroup label="Object properties">
            {objProps.map((p) => (
              <option key={p.key} value={'o:' + p.key}>
                {p.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Data properties">
            {dataProps
              .filter((p) => !restrictions.some((r) => r.rel.to === p.id))
              .map((p) => (
                <option key={p.id} value={'d:' + p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        </select>
        {prop && !isData && (
          <select aria-label="Class it points to" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">some… choose a class</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || 'Unnamed'}
              </option>
            ))}
          </select>
        )}
        {prop && (
          <button className="btn small primary" disabled={!isData && !target} onClick={add}>
            Add
          </button>
        )}
      </div>
    </>
  );
}

/** An object property: declared once, used by every relationship that carries its name. */
function ObjectPropertyPanel({ prop }: { prop: PropView }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const others = objectProperties(model).filter((p) => p.key !== prop.key);
  const type = (id: string) => model.terms.find((t) => t.id === id)?.type;
  const name = new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed']));
  const set = (patch: Parameters<ReturnType<typeof useStore.getState>['updateProp']>[1]) => st().updateProp(prop.key, patch);
  const side = (which: 'domain' | 'range') => {
    const ids = prop[which];
    const auto = which === 'domain' ? prop.domainAuto : prop.rangeAuto;
    return (
      <div className="field">
        <span>{which === 'domain' ? 'Domain: what can have it' : 'Range: what it points to'}</span>
        <TermChips ids={ids} placeholder={ids.length ? 'Add another…' : 'Choose a term…'} add={(id) => set({ [which]: [...ids, id] })} remove={(id) => set({ [which]: ids.filter((x) => x !== id) })} />
        {auto ? (
          <small>{ids.length ? 'Follows the classes it is used between. Choose a class, for example a more general one, to set it yourself.' : 'Not set: anything. Choose a class to set it.'}</small>
        ) : (
          <small>
            Set by you.{' '}
            <button className="link" onClick={() => set({ [which]: undefined })}>
              Follow the relationships again
            </button>
          </small>
        )}
      </div>
    );
  };
  const pick = (label: string, value: string | undefined, onChange: (key: string | undefined) => void) => (
    <label className="field">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">None</option>
        {value && !others.some((p) => p.key === value) && <option value={value}>{value}</option>}
        {others.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <h2>Object property</h2>
      <label className="field">
        <span>Name</span>
        <CommitInput value={prop.name} onCommit={(v) => st().renameProp(prop.key, v)} />
        <small>Renaming it renames every relationship that uses it.</small>
      </label>
      <div className="field">
        <span title="The identifier of this property. It does not change when the name does.">IRI</span>
        <IriCell iri={prop.iri} of={prop.name} full />
      </div>
      <label className="field">
        <span>Description</span>
        <CommitTextarea rows={3} value={prop.description} placeholder="What does this property mean?" onCommit={(description) => set({ description })} />
      </label>
      {side('domain')}
      {side('range')}
      <fieldset className="field checks">
        <legend>Characteristics</legend>
        {CHARACTERISTICS.map((c) => (
          <label key={c.id} className="check" title={c.about}>
            <input
              type="checkbox"
              checked={prop.chars.includes(c.id)}
              onChange={(e) => set({ chars: e.target.checked ? [...prop.chars, c.id] : prop.chars.filter((x) => x !== c.id) })}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </fieldset>
      {pick('Inverse of', prop.inverseOf, (inverseOf) => set({ inverseOf }))}
      {pick('Sub-property of', prop.parent, (parent) => set({ parent }))}

      <h3>Used by ({prop.rels.length})</h3>
      {prop.rels.length === 0 && <p className="muted">Nothing uses it yet. Add a restriction to a class, or on the canvas drag from one term to another and pick this name as the label.</p>}
      <ul className="rel-list">
        {prop.rels.map((r) => {
          // A class is held to a domain or range set by hand: it has to be one of those classes or a kind of one.
          const classLevel = type(r.from) === 'concept' && type(r.to) === 'concept';
          const badFrom = classLevel && !prop.domainAuto && prop.domain.length > 0 && !fitsIn(model, r.from, prop.domain);
          const badTo = classLevel && !prop.rangeAuto && prop.range.length > 0 && !fitsIn(model, r.to, prop.range);
          const judged = classLevel && (!prop.domainAuto || !prop.rangeAuto);
          return (
            <li key={r.id}>
              <button onClick={() => st().focusRelation(r.id)} title="Show on the canvas">
                {judged && <span className={badFrom || badTo ? 'bad' : 'good'}>{badFrom || badTo ? '✗ ' : '✓ '}</span>}
                {name.get(r.from)} <em>{classLevel ? quantifierOf(r) : '→'}</em> {name.get(r.to)}
                {badFrom && <small className="bad"> {name.get(r.from)} is not a kind of {prop.domain.map((id) => name.get(id)).join(' or ')}</small>}
                {badTo && <small className="bad"> {name.get(r.to)} is not a kind of {prop.range.map((id) => name.get(id)).join(' or ')}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      {prop.rels.length > 0 && (
        <button
          className="btn small"
          onClick={() => {
            st().setHighlight([...prop.rels.map((r) => r.id), ...prop.rels.flatMap((r) => [r.from, r.to])], `Uses of “${prop.name}” (${prop.rels.length})`);
            st().setView('graph');
          }}
        >
          Highlight on the canvas
        </button>
      )}
      <button className="btn danger" onClick={() => st().deleteProp(prop.key)}>
        {prop.rels.length ? `Delete property and its ${prop.rels.length} relationship${prop.rels.length === 1 ? '' : 's'}` : 'Delete property'}
      </button>
    </>
  );
}

function RelationPanel({ rel }: { rel: Relation }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.updateRelation);
  const st = useStore.getState;
  const sorted = [...model.terms].sort((a, b) => a.name.localeCompare(b.name));
  const skos = model.mode === 'skos';
  const props = activeProps(model);
  const own = props.some((p) => p.id === rel.predicate) ? rel.predicate! : '';
  // In an ontology a relationship between two terms is a use of an object property.
  // In an ontology a relationship either uses a declared object property or is still just a relationship.
  const usesProp = !skos && rel.kind === 'association' && !own && !model.vocab.map[rel.label.trim().toLowerCase()];
  const objProps = usesProp ? objectProperties(model) : [];
  const prop = usesProp ? objProps.find((p) => p.key === propKey(rel.label)) : undefined;
  const restriction = !skos ? restrictionsOf(model, rel.from).find((r) => r.rel.id === rel.id) : undefined;

  const names = (ids: string[]) => ids.map((id) => model.terms.find((t) => t.id === id)?.name).join(', ') || 'anything';
  const endpoint = (side: 'from' | 'to') => (
    <label className="field">
      <span>{side === 'from' ? 'From' : 'To'}</span>
      <select value={rel[side]} onChange={(e) => update(rel.id, { [side]: e.target.value })}>
        {sorted.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name || 'Unnamed'}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <h2>{restriction ? 'Restriction' : usesProp ? 'Relationship' : 'Relation'}</h2>
      {endpoint('from')}
      <label className="field">
        <span>{prop ? 'Object property' : usesProp ? 'Label, or an object property' : 'Label'}</span>
        <CommitInput
          list={usesProp ? 'panel-object-props' : undefined}
          value={rel.label}
          placeholder={rel.kind === 'association' ? (skos ? 'empty means related' : 'pick one or type a new name') : relLabel({ ...rel, label: '' }, skos)}
          onCommit={(v) => update(rel.id, { label: v.trim() })}
        />
        {usesProp && (
          <datalist id="panel-object-props">
            {objProps.map((p) => (
              <option key={p.key} value={p.name} />
            ))}
          </datalist>
        )}
        {prop && (
          <small>
            Domain: {names(prop.domain)}. Range: {names(prop.range)}.{' '}
            <button className="link" onClick={() => st().selectProp(prop.key)}>
              Edit the property
            </button>
          </small>
        )}
        {usesProp && !prop && (
          <small>
            A plain relationship: not an object property.{' '}
            <button className="link" onClick={() => st().setRelChoice(rel.id, 'object')}>
              Make it a use of the object property “{rel.label.trim() || 'related to'}”
            </button>
          </small>
        )}
      </label>
      {endpoint('to')}
      <button className="btn small" onClick={() => st().reverseRelation(rel.id)}>
        Reverse direction
      </button>
      <label className="field">
        <span>Kind</span>
        {skos ? (
          <select value={rel.kind} onChange={(e) => update(rel.id, { kind: e.target.value as RelKind })}>
            {REL_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {kindLabel(k.value, skos)}
              </option>
            ))}
          </select>
        ) : (
          <select value={relChoice(model, rel)} onChange={(e) => st().setRelChoice(rel.id, e.target.value as RelChoice)}>
            {REL_CHOICES.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        )}
      </label>
      {props.length > 0 && (
        <label className="field">
          <span>Standard property</span>
          <select value={own} onChange={(e) => update(rel.id, { predicate: e.target.value || undefined })}>
            <option value="">Automatic</option>
            {props.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
          <small>
            {own
              ? `Exports as ${own}; the kind above is ignored.`
              : `Exports as ${automaticMeaning(model, rel)}.`}
          </small>
        </label>
      )}
      {restriction && (
        <div className="field">
          <span>Restriction on {names([rel.from])}</span>
          <div className="row">
            <QuantifierSelect rel={rel} />
          </div>
          <small>
            Every {names([rel.from])}: <strong>{restriction.text}</strong>.
          </small>
        </div>
      )}

      <div className="field two">
        <label>
          <span>From cardinality</span>
          <CommitInput value={rel.fromCard} placeholder="1..*" onCommit={(v) => update(rel.id, { fromCard: v.trim() })} />
        </label>
        <label>
          <span>To cardinality</span>
          <CommitInput value={rel.toCard} placeholder="0..1" onCommit={(v) => update(rel.id, { toCard: v.trim() })} />
        </label>
      </div>
      <label className="field">
        <span>Description</span>
        <CommitTextarea rows={4} value={rel.description} onCommit={(description) => update(rel.id, { description })} />
      </label>
      <button className="btn danger" onClick={() => st().remove([], [rel.id])}>
        Delete relation
      </button>
    </>
  );
}

function MultiPanel({ terms, rels }: { terms: Term[]; rels: Relation[] }) {
  const st = useStore.getState;
  const ids = terms.map((t) => t.id);
  return (
    <>
      <h2>Selection</h2>
      <p className="stat">
        {terms.length} terms · {rels.length} relations
      </p>
      {terms.length > 0 && (
        <>
          <label className="field">
            <span>Set type</span>
            <select value="" onChange={(e) => e.target.value && st().updateTerms(ids, TYPE_CHOICES.find((c) => c.value === e.target.value)!.patch)}>
              <option value="">Choose…</option>
              {TYPE_CHOICES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Set colour</span>
            <Swatches onPick={(color) => st().updateTerms(ids, { color })} />
          </div>
        </>
      )}
      {terms.length > 0 && (
        <div className="row wrap">
          <span className="muted">Highlight</span>
          <button className="btn small" onClick={() => st().showNeighbours(ids, 'in')}>
            Incoming
          </button>
          <button className="btn small" onClick={() => st().showNeighbours(ids, 'out')}>
            Outgoing
          </button>
          <button className="btn small" onClick={() => st().showNeighbours(ids, 'both')}>
            Both
          </button>
        </div>
      )}
      {terms.length === 2 && (
        <button className="btn" onClick={() => st().showPath(ids[0], ids[1])}>
          Find path between them
        </button>
      )}
      <button className="btn danger" onClick={() => st().deleteSelection()}>
        Delete selection
      </button>
    </>
  );
}
