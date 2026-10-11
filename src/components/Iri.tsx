import { useMemo, useState } from 'react';
import { compactIri } from '../model/prefixes';
import { assertedSuperclasses } from '../model/props';
import { useStore } from '../model/store';
import { searchTerms } from '../model/subgraph';
import type { Term } from '../model/types';

/**
 * An entity's full IRI, read-only. The namespace gives way when space is short so that the
 * distinguishing last part stays visible; the whole IRI is in the tooltip and one click copies it.
 */
export function IriCell({ iri, of, full = false }: { iri?: string; of: string; full?: boolean }) {
  const notify = useStore((s) => s.notify);
  // Written with a prefix where the ontology has one for it (ex:Actor); the full IRI is always the tooltip and what Copy gives.
  const curie = useStore((s) => (iri && !full ? compactIri(s.model, iri) : undefined));
  if (!iri) {
    return (
      <span className="muted iri-none" title="An IRI is made from the name, in the model's base namespace, as soon as the entity is given one.">
        assigned when named
      </span>
    );
  }
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(iri);
      notify('IRI copied.');
    } catch {
      notify(`Could not copy. The IRI is ${iri}`);
    }
  };
  return (
    <span className="iri-cell" title={iri}>
      {curie ? (
        <>
          <span className="iri-prefix">{curie.slice(0, curie.indexOf(':') + 1)}</span>
          <span className="iri-local">{curie.slice(curie.indexOf(':') + 1)}</span>
        </>
      ) : (
        <>
          <span className="iri-ns">{iri.slice(0, cut)}</span>
          <span className="iri-local">{iri.slice(cut)}</span>
        </>
      )}
      <button className="btn icon ghost iri-copy" title="Copy the full IRI" aria-label={`Copy the IRI of ${of}`} onClick={copy}>
        ⧉
      </button>
    </span>
  );
}

/**
 * The superclasses a class is explicitly stated to have, as removable chips, and a search to add
 * another. Each chip is one "is a" statement: removing it removes that statement and no other.
 */
export function SuperclassEditor({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const [query, setQuery] = useState<string | null>(null);
  const supers = assertedSuperclasses(model, term.id);
  const byId = useMemo(() => new Map(supers.map((id) => [id, model.terms.find((t) => t.id === id)] as const)), [supers, model.terms]);
  const skos = model.mode === 'skos';
  // Classes (in a concept scheme: any concept) matching the text by name or IRI.
  const found = useMemo(
    () =>
      query === null
        ? []
        : searchTerms(model, query, 40)
            .filter((t) => t.id !== term.id && !supers.includes(t.id) && (skos || t.type === 'concept'))
            .slice(0, 8),
    [model, query, supers, term.id, skos],
  );
  const iriOf = (id: string) => model.terms.find((t) => t.id === id)?.iri;
  return (
    <div className="supers">
      <div className="chips-inline">
        {supers.map((id) => (
          <span key={id} className="chip-x" title={byId.get(id)?.iri}>
            <button className="link" title={`${byId.get(id)?.iri ?? ''}\nShow on the canvas`} onClick={() => st().focusTerm(id)}>
              {byId.get(id)?.name || 'Unnamed'}
            </button>
            <button aria-label={`Remove superclass ${byId.get(id)?.name}`} title="Remove this superclass statement" onClick={() => st().removeSuperclass(term.id, id)}>
              ×
            </button>
          </span>
        ))}
        {!supers.length && query === null && <span className="missing">{skos ? 'top concept' : '—'}</span>}
        {query === null && (
          <button className="chip-add" title={skos ? 'Add a broader concept' : 'Add an asserted superclass'} aria-label={`Add ${skos ? 'a broader concept' : 'a superclass'} to ${term.name}`} onClick={() => setQuery('')}>
            +
          </button>
        )}
      </div>
      {query !== null && (
        <div className="supers-add">
          <input
            autoFocus
            type="search"
            value={query}
            placeholder="Search by name or IRI…"
            aria-label={skos ? 'Search for a broader concept' : 'Search for a superclass'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setQuery(null);
              if (e.key === 'Enter' && found.length === 1) {
                st().addSuperclass(term.id, found[0].id);
                setQuery(null);
              }
            }}
            // Leaving the box closes it; a result is picked on pointer-down, before that happens.
            onBlur={() => setQuery(null)}
          />
          {query.trim() !== '' && (
            <ul className="subgraph-found">
              {found.map((t) => (
                <li key={t.id}>
                  <button
                    title={iriOf(t.id)}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      st().addSuperclass(term.id, t.id);
                      setQuery(null);
                    }}
                  >
                    {t.name} <span className="muted">{(iriOf(t.id) && compactIri(model, iriOf(t.id)!)) ?? iriOf(t.id)}</span>
                  </button>
                </li>
              ))}
              {!found.length && <li className="muted">No other class matches.</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
