import { useRef, useState } from 'react';
import { ANNOTATION_PROPS, annotationAbout, standardAnnotation } from '../model/annotations';
import { useStore } from '../model/store';
import { isLang, type ExtraField } from '../model/types';

interface Draft {
  /** Position of the field being changed, or null for a new one. */
  index: number | null;
  key: string;
  value: string;
  lang: string;
}

/**
 * A term's metadata as property / value pairs. A field is written into the model only when it
 * is confirmed, and is read-only from then on: changing it means pressing Edit and confirming again.
 */
export function Metadata({ fields, onChange, title = 'Metadata' }: { fields: ExtraField[]; onChange: (fields: ExtraField[]) => void; title?: string }) {
  const notify = useStore((s) => s.notify);
  const [draft, setDraft] = useState<Draft | null>(null);

  const [picking, setPicking] = useState(false);
  const valueRef = useRef<HTMLTextAreaElement>(null);
  // Standard properties matching what has been typed, by name or by description.
  const q = draft?.key.trim().toLowerCase() ?? '';
  const options = ANNOTATION_PROPS.filter((p) => !q || p.id.toLowerCase().includes(q) || p.about.toLowerCase().includes(q));
  const pick = (id: string) => {
    if (draft) setDraft({ ...draft, key: id });
    setPicking(false);
    valueRef.current?.focus();
  };

  const langOk = !draft?.lang.trim() || isLang(draft.lang.trim());
  const ready = !!draft && !!draft.key.trim() && !!draft.value.trim() && langOk;
  const confirm = () => {
    if (!draft || !ready) return;
    const lang = draft.lang.trim().toLowerCase();
    // What kind of value it is (a date, a number, a reference) stays as it was when only its text is changed.
    const key = standardAnnotation(draft.key) ?? draft.key.trim();
    const { dt, iri, measure } = draft.index === null || fields[draft.index].key !== key ? ({} as Partial<ExtraField>) : fields[draft.index];
    const field: ExtraField = { key, value: draft.value.trim(), ...(lang && !dt && !iri ? { lang } : {}), ...(dt ? { dt } : {}), ...(iri ? { iri } : {}), ...(measure ? { measure } : {}) };
    // The same property can be given several times, once for each language or value; only an exact repeat is refused.
    if (fields.some((f, i) => i !== draft.index && f.key === field.key && f.value === field.value && (f.lang ?? '') === (field.lang ?? ''))) {
      notify(`This ${field.key} value is already there${field.lang ? ` in ${field.lang}` : ''}.`);
      return;
    }
    onChange(draft.index === null ? [...fields, field] : fields.map((f, i) => (i === draft.index ? field : f)));
    setDraft(null);
  };
  const remove = (index: number) => {
    onChange(fields.filter((_, i) => i !== index));
    setDraft(null);
  };

  const editor = draft && (
    <div className="meta-editor">
      <input
        autoFocus
        role="combobox"
        aria-expanded={picking}
        aria-controls="annotation-props"
        aria-label="Property"
        placeholder="Property: pick one or type your own"
        value={draft.key}
        onChange={(e) => {
          setDraft({ ...draft, key: e.target.value });
          setPicking(true);
        }}
        onFocus={() => setPicking(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            if (picking) setPicking(false);
            else setDraft(null);
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (picking && options.length === 1) pick(options[0].id);
            else valueRef.current?.focus();
          }
        }}
      />
      {picking && (
        <ul id="annotation-props" className="meta-options" role="listbox" aria-label="Standard properties">
          {options.map((p) => (
            <li key={p.id} role="option" aria-selected={standardAnnotation(draft.key) === p.id}>
              {/* preventDefault keeps focus in the box, so choosing doesn't close the list first */}
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p.id)}>
                <span className="meta-key std">{p.id}</span>
                <span className="meta-about">{p.about}</span>
              </button>
            </li>
          ))}
          {!options.length && <li className="meta-none">No standard property matches. “{draft.key.trim()}” will be a field of your own.</li>}
        </ul>
      )}
      {!picking && annotationAbout(draft.key) && <small>{annotationAbout(draft.key)}</small>}
      <textarea
        ref={valueRef}
        rows={2}
        onFocus={() => setPicking(false)}
        aria-label="Value"
        placeholder="Value"
        value={draft.value}
        onChange={(e) => setDraft({ ...draft, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            confirm();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
      <div className="row">
        <input
          className="meta-lang"
          aria-label="Language"
          aria-invalid={!langOk}
          placeholder="lang"
          title="Language of the value, e.g. nl. Leave empty if it has none."
          value={draft.lang}
          onChange={(e) => setDraft({ ...draft, lang: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && confirm()}
        />
        <button className="btn small primary" disabled={!ready} onClick={confirm}>
          Confirm
        </button>
        <button className="btn small" onClick={() => setDraft(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <>
      <h3>
        {title} ({fields.length})
      </h3>
      {fields.length > 0 && (
        <ul className="meta-list">
          {fields.map((f, i) =>
            draft?.index === i ? (
              <li key={i}>{editor}</li>
            ) : (
              <li key={i} className="meta-row">
                <div className="meta-text">
                  <span className={'meta-key' + (standardAnnotation(f.key) ? ' std' : '')} title={annotationAbout(f.key)}>
                    {f.key || '(no property)'}
                  </span>
                  <span className="meta-value">
                    {f.value}
                    {f.lang && <span className="lang">@{f.lang}</span>}
                  </span>
                </div>
                <button className="btn small ghost" title="Change this field" aria-label={`Edit ${f.key}`} onClick={() => setDraft({ index: i, key: f.key, value: f.value, lang: f.lang ?? '' })}>
                  Edit
                </button>
                <button className="btn icon ghost" title="Remove this field" aria-label={`Remove ${f.key}`} onClick={() => remove(i)}>
                  ×
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      {draft?.index === null && editor}
      {!draft && (
        <button className="btn small" onClick={() => setDraft({ index: null, key: '', value: '', lang: '' })}>
          Add field
        </button>
      )}
    </>
  );
}
