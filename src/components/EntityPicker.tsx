import { useMemo, useState, type ReactNode } from 'react';
import { compactIri } from '../model/prefixes';
import { useStore } from '../model/store';

/** Something that can be chosen: a term or an object property, by id, known to people by name and to the ontology by IRI. */
export interface Choice {
  id: string;
  name: string;
  iri?: string;
  /** A short remark shown on its chip, such as "from use". */
  tag?: string;
  /** Shown but not removable here; the text says why. */
  locked?: string;
}

interface Props {
  /** What is chosen now. */
  values: Choice[];
  /** Everything that could be chosen. Only asked for once the search is open. */
  options: () => Choice[];
  /** Adds one. Returns the reason if it was refused, which is then shown beside the search. */
  onAdd: (id: string) => string | undefined | void;
  onRemove: (id: string) => void;
  /** Opens a chosen entity. */
  onOpen?: (id: string) => void;
  /** What one value is, for the labels: "superclass", "disjoint class". */
  noun: string;
  /** Whose values these are, for the labels. */
  of: string;
  addLabel?: string;
  searchLabel?: string;
  /** Shown when nothing is chosen. */
  empty?: ReactNode;
  /** No more than this many can be chosen; the add button goes when it is reached. */
  max?: number;
  /** Turns typed text into a choice that is not among the options (an IRI from elsewhere), if it can be one. */
  custom?: (text: string) => Choice | undefined;
}

/**
 * The entities chosen for one kind of statement, as removable chips, and a search to add another.
 * The search matches names and IRIs (in full or with a prefix) and shows each candidate's IRI, so
 * that two entities with the same name can be told apart.
 */
export function EntityPicker({ values, options, onAdd, onRemove, onOpen, noun, of, addLabel, searchLabel, empty = '—', max, custom }: Props) {
  const model = useStore((s) => s.model);
  const [query, setQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const short = (iri?: string) => (iri ? (compactIri(model, iri) ?? iri) : '');
  const found = useMemo(() => {
    if (query === null) return [];
    const q = query.trim().toLowerCase();
    const chosen = new Set(values.map((v) => v.id));
    const scored: (Choice & { score: number })[] = [];
    for (const o of options()) {
      if (chosen.has(o.id)) continue;
      const name = o.name.toLowerCase();
      const iri = o.iri ? `${o.iri}\n${short(o.iri)}`.toLowerCase() : '';
      const score = !q ? 2 : name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : iri.includes(q) ? 3 : -1;
      if (score >= 0) scored.push({ ...o, score });
    }
    const top: Choice[] = scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, 8);
    const typed = q ? custom?.(query.trim()) : undefined;
    if (typed && !chosen.has(typed.id) && !top.some((o) => o.id === typed.id)) top.push({ tag: 'use this IRI', ...typed });
    return top;
    // `options` and `short` read the model, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, values, model]);
  const choose = (id: string) => {
    const refused = onAdd(id);
    setError(refused || undefined);
    if (!refused) setQuery(null);
  };
  const close = () => {
    setQuery(null);
    setError(undefined);
  };
  const full = max !== undefined && values.length >= max;
  return (
    <div className="supers picker">
      <div className="chips-inline">
        {values.map((v) => (
          <span key={v.id} className={'chip-x' + (v.locked ? ' locked' : '')} title={v.iri}>
            <button className="link" title={`${v.iri ?? 'No IRI yet'}${onOpen ? '\nOpen it' : ''}`} onClick={() => onOpen?.(v.id)}>
              {v.name || 'Unnamed'}
            </button>
            {v.tag && <span className="tag auto">{v.tag}</span>}
            {v.locked ? (
              <span className="chip-lock" title={v.locked} aria-label={v.locked}>
                ·
              </span>
            ) : (
              <button aria-label={`Remove ${noun} ${v.name}`} title={`Remove this ${noun}. Nothing else is changed.`} onClick={() => onRemove(v.id)}>
                ×
              </button>
            )}
          </span>
        ))}
        {!values.length && query === null && <span className="missing">{empty}</span>}
        {query === null && !full && (
          <button className="chip-add" title={addLabel ?? `Add a ${noun}`} aria-label={`${addLabel ?? `Add a ${noun}`}${of ? ` to ${of}` : ''}`} onClick={() => setQuery('')}>
            +
          </button>
        )}
      </div>
      {query !== null && (
        <div className="supers-add">
          <input
            autoFocus
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            value={query}
            placeholder="Search by name or IRI…"
            aria-label={searchLabel ?? `Search for a ${noun}`}
            aria-invalid={!!error}
            onChange={(e) => {
              setQuery(e.target.value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') close();
              if (e.key === 'Enter' && found.length) choose(found[0].id);
            }}
            // Leaving the box closes it; a result is picked on pointer-down, before that happens.
            onBlur={() => !error && close()}
          />
          <ul className="subgraph-found" role="listbox">
            {found.map((o) => (
              <li key={o.id} role="option" aria-selected="false">
                <button
                  title={o.iri}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    choose(o.id);
                  }}
                >
                  {o.name || 'Unnamed'} <span className="muted">{short(o.iri)}</span>{' '}
                  {o.tag && <span className="tag auto">{o.tag}</span>}
                </button>
              </li>
            ))}
            {!found.length && <li className="muted">{query.trim() ? 'Nothing else matches.' : 'Nothing else to choose.'}</li>}
          </ul>
        </div>
      )}
      {error && (
        <small className="bad" role="alert">
          {error}{' '}
          <button className="link" onClick={close}>
            Dismiss
          </button>
        </small>
      )}
    </div>
  );
}
