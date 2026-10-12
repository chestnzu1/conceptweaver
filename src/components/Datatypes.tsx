import { useState } from 'react';
import { addDatatype, addEnumValue, datatypeTurtle, enumOf, enumRange, literalText, removeDatatype, removeEnumValue, updateDatatype, usersOf } from '../model/datatypes';
import { useStore } from '../model/store';
import { DATATYPES, type EnumDatatype, type Term } from '../model/types';
import { CommitInput } from './fields';
import { IriCell } from './Iri';

const NEW = '__new';

/**
 * The range of a data property: one of the standard datatypes, or an enumerated datatype of the
 * model, which can also be made here. An enumerated datatype is a datatype, listed with the
 * datatypes; it never appears among the classes or the individuals.
 */
export function RangeSelect({ term, label = 'Datatype' }: { term: Term; label?: string }) {
  const datatypes = useStore((s) => s.model.datatypes);
  const st = useStore.getState;
  const choose = (value: string) => {
    if (value !== NEW) return st().updateTerm(term.id, { range: value || undefined });
    // A new one becomes the range in the same step. It gets its IRI from the name it is then given, not from this one.
    let name = 'New datatype';
    for (let i = 2; datatypes.some((d) => d.name.trim().toLowerCase() === name.toLowerCase()); i++) name = `New datatype ${i}`;
    st().apply((m) => {
      const made = addDatatype(m, name);
      return made.model && made.id ? { ...made.model, terms: made.model.terms.map((t) => (t.id === term.id ? { ...t, range: enumRange(made.id!) } : t)) } : m;
    });
  };
  return (
    <select aria-label={label} value={term.range ?? ''} onChange={(e) => choose(e.target.value)}>
      <option value="">Not set</option>
      <optgroup label="Standard datatypes">
        {DATATYPES.map((d) => (
          <option key={d.id} value={d.id}>
            {d.id} ({d.label})
          </option>
        ))}
      </optgroup>
      <optgroup label="Enumerated datatypes">
        {datatypes.map((d) => (
          <option key={d.id} value={enumRange(d.id)}>
            {d.name || 'Unnamed'} ({d.values.length} value{d.values.length === 1 ? '' : 's'})
          </option>
        ))}
        <option value={NEW}>New enumerated datatype…</option>
      </optgroup>
    </select>
  );
}

/** The editor of one enumerated datatype: its name, the literals it lists, and how it is written to RDF. */
export function EnumDatatypeEditor({ datatype: d }: { datatype: EnumDatatype }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const [draft, setDraft] = useState({ value: '', dt: '', lang: '' });
  const [error, setError] = useState<string | undefined>();
  const users = usersOf(model, d.id);
  const say = (refused: string | undefined) => (refused ? st().notify(refused) : undefined);
  const add = () => {
    const refused = st().edit((m) => addEnumValue(m, d.id, draft));
    setError(refused);
    if (!refused) setDraft({ ...draft, value: '' });
  };
  return (
    <div className="enum-datatype" data-datatype={d.id} role="group" aria-label={`Enumerated datatype ${d.name}`}>
      <label className="field">
        <span>
          Enumerated datatype <code className="pred">rdfs:Datatype</code>
        </span>
        <CommitInput aria-label="Name of the datatype" value={d.name} onCommit={(name) => say(st().edit((m) => updateDatatype(m, d.id, { name })))} />
      </label>
      {d.anonymous ? <small>Written in place as the range of the property, with no IRI of its own, as it was in the file it came from.</small> : <IriCell iri={d.iri} of={d.name} />}
      <div className="field">
        <span>
          Values <code className="pred">owl:oneOf</code>
        </span>
        {d.values.length > 0 && (
          <ul className="enum-members" aria-label={`Values of ${d.name}`}>
            {d.values.map((v, i) => (
              <li key={i}>
                <code className="literal">{literalText(v)}</code>
                <button className="btn icon ghost" title="Remove this value" aria-label={`Remove the value ${v.value}`} onClick={() => st().apply((m) => removeEnumValue(m, d.id, i))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {!d.values.length && <small>No values yet. Until it has one, nothing is written for it but its name.</small>}
        <div className="enum-add">
          <input
            aria-label="New value"
            aria-invalid={!!error}
            placeholder="Value"
            value={draft.value}
            onChange={(e) => {
              setDraft({ ...draft, value: e.target.value });
              setError(undefined);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') add();
            }}
          />
          <select aria-label="Datatype of the new value" title="What kind of literal the value is" value={draft.dt} onChange={(e) => setDraft({ ...draft, dt: e.target.value, lang: e.target.value ? '' : draft.lang })}>
            <option value="">text</option>
            {DATATYPES.filter((x) => x.id !== 'xsd:string' && x.id !== 'rdf:langString').map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <input className="meta-lang" aria-label="Language of the new value" placeholder="lang" title={draft.dt ? 'Only text has a language' : 'Language of the value, e.g. nl. Leave empty if it has none.'} disabled={!!draft.dt} value={draft.lang} onChange={(e) => setDraft({ ...draft, lang: e.target.value })} />
          <button className="btn small" disabled={!draft.value.trim()} onClick={add}>
            Add value
          </button>
        </div>
        {error && (
          <small className="bad" role="alert">
            {error}
          </small>
        )}
      </div>
      <div className="field">
        <span>RDF</span>
        <code className="expression pre">{datatypeTurtle(model, d)}</code>
      </div>
      <small>
        A datatype, not a class: its values are literals. Range of {users.map((t) => t.name || 'Unnamed').join(', ') || 'no property yet'}.{' '}
        <button className="link" title="Takes the datatype out of the model. A property that had it as its range is left without one." onClick={() => say(st().edit((m) => removeDatatype(m, d.id)))}>
          Delete this datatype
        </button>
      </small>
    </div>
  );
}

/** The enumerated datatype a data property has as its range, with its editor, if it has one. */
export function RangeEnumeration({ term }: { term: Term }) {
  const d = useStore((s) => enumOf(s.model, term.range));
  return d ? <EnumDatatypeEditor key={d.id} datatype={d} /> : null;
}
