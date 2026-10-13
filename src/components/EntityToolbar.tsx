import { useEffect, useState, type ReactNode } from 'react';
import { ON, type EntityFilterSpec, type FilterOption, type FilterValues, type ListKind, type OntologyRef } from '../entities/contracts';
import type { EntityViewState } from '../model/store';
import { entityService, type EntityList } from './entityQuery';

/** An entity a filter names by its key, as the page knows it: its name, and its IRI to tell it from another of that name. */
export type Resolve = (key: string) => { name: string; iri?: string } | undefined;

/** How many filters are on. */
export const filtersOn = (filters: FilterValues): number => Object.values(filters).filter((v) => v.length).length;

/** The filters with one option of one filter switched: on if it was off, off if it was on. A filter with nothing chosen is left out. */
function switched(filters: FilterValues, spec: EntityFilterSpec, value: string): FilterValues {
  const now = filters[spec.id] ?? [];
  const next = now.includes(value) ? now.filter((v) => v !== value) : spec.type === 'flag' || spec.type === 'one' ? [value] : [...now, value];
  const { [spec.id]: _, ...rest } = filters;
  return next.length ? { ...rest, [spec.id]: next } : rest;
}

interface Props {
  kind: ListKind;
  /** What the things of the list are called: "class", "classes". */
  noun: { one: string; many: string };
  view: EntityViewState;
  list: EntityList;
  set: (patch: Partial<EntityViewState>) => void;
  /** Whether the filters are open, which is the page's to say: open, they stay open from tab to tab. */
  open: boolean;
  setOpen: (open: boolean) => void;
  resolve: Resolve;
  /** What else belongs in the bar: the button that adds one. */
  children?: ReactNode;
}

/**
 * The bar under the tabs of the Entities page: a search, an order and the filters of the list
 * that is open, each of which can be put back on its own. What there is to sort and to filter by
 * is what the service says there is; what is searched, sorted and filtered is its answer. None
 * of it changes the ontology.
 */
export function EntityToolbar({ kind, noun, view, list, set, open, setOpen, resolve, children }: Props) {
  const { description, page } = list;
  const on = filtersOn(view.filters);
  const narrowed = !!view.search.trim() || on > 0;
  const sorts = description?.sorts ?? [];
  const sort = view.sort && sorts.some((s) => s.id === view.sort!.by) ? view.sort : null;
  const count = !page ? '' : narrowed ? `${page.matched.toLocaleString('en')} of ${page.total.toLocaleString('en')} ${page.total === 1 ? noun.one : noun.many}` : `${page.total.toLocaleString('en')} ${page.total === 1 ? noun.one : noun.many}`;
  // Every option that is chosen, for the row of what is on.
  const chosen = (description?.filters ?? []).flatMap((spec) =>
    (view.filters[spec.id] ?? []).map((value) => {
      const what = spec.type === 'flag' ? '' : spec.entities ? (resolve(value)?.name ?? 'an entity that is gone') : (spec.options.find((o) => o.value === value)?.label ?? value);
      return { spec, value, text: what ? `${spec.label}: ${what}` : spec.label };
    }),
  );
  return (
    <div className="entity-tools">
      <div className="et-row">
        <div className="et-search">
          <input
            type="text"
            role="searchbox"
            aria-label={`Search ${noun.many}`}
            placeholder={`Search ${noun.many}…`}
            title={kind === 'relationship' ? 'By its name, the names of its two ends, or its kind. Every word has to be found.' : 'By name, another label, the IRI with a prefix or in full, or the definition. Every word has to be found.'}
            value={view.search}
            onChange={(e) => set({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !view.search) return;
              e.stopPropagation();
              set({ search: '' });
            }}
          />
          {view.search && (
            <button className="btn icon ghost et-clear" title="Clear the search (Esc)" aria-label="Clear the search" onClick={() => set({ search: '' })}>
              ×
            </button>
          )}
        </div>
        <label className="et-sort">
          <span>Sort</span>
          <select
            aria-label={`Sort ${noun.many} by`}
            value={sort?.by ?? ''}
            onChange={(e) => {
              const spec = sorts.find((s) => s.id === e.target.value);
              // What counts something starts with the most; a name starts at A.
              set({ sort: spec ? { by: spec.id, dir: spec.numeric ? 'desc' : 'asc' } : null });
            }}
          >
            <option value="">Model order</option>
            {sorts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn icon et-dir"
          disabled={!sort}
          title={!sort ? 'Choose what to sort by first' : sort.dir === 'asc' ? 'Ascending: A to Z, fewest first. Click for the other way round.' : 'Descending: Z to A, most first. Click for the other way round.'}
          aria-label={!sort ? 'Sort direction' : sort.dir === 'asc' ? 'Ascending. Sort descending' : 'Descending. Sort ascending'}
          onClick={() => sort && set({ sort: { by: sort.by, dir: sort.dir === 'asc' ? 'desc' : 'asc' } })}
        >
          <span aria-hidden="true">{sort?.dir === 'desc' ? '↓' : '↑'}</span>
        </button>
        <button className={'btn et-filter' + (on ? ' on' : '')} aria-expanded={open} title="Narrow the list by what is said about each entity" onClick={() => setOpen(!open)}>
          Filters{on ? ` (${on})` : ''}
        </button>
        <span className={'et-count' + (list.settled || !page ? '' : ' pending')} role="status" aria-live="polite">
          {count}
        </span>
        <span className="et-end">{children}</span>
      </div>

      {open && (
        <div className="et-filters" role="group" aria-label={`Filters for ${noun.many}`}>
          {(description?.filters ?? []).map((spec) => (
            <FilterControl key={spec.id} kind={kind} spec={spec} values={view.filters[spec.id] ?? []} ontology={list.ontology} resolve={resolve} flip={(value) => set({ filters: switched(view.filters, spec, value) })} />
          ))}
          {description && !description.filters.length && <span className="muted">There are no filters for {noun.many}.</span>}
        </div>
      )}

      {(chosen.length > 0 || (page?.notes.length ?? 0) > 0) && (
        <div className="et-active">
          {chosen.length > 0 && <span className="et-active-label">Filtered by</span>}
          {chosen.map(({ spec, value, text }) => (
            <span key={spec.id + '|' + value} className={'chip-x' + (spec.unavailable ? ' locked' : '')} title={spec.unavailable ? `Not applied: ${spec.unavailable}` : spec.about}>
              <span className="et-chip">{text}</span>
              <button aria-label={`Remove the filter ${text}`} title="Remove this filter" onClick={() => set({ filters: switched(view.filters, spec, value) })}>
                ×
              </button>
            </span>
          ))}
          {chosen.length > 0 && (
            <button className="link" onClick={() => set({ filters: {} })}>
              Clear all filters
            </button>
          )}
          {page?.notes.map((note) => (
            <span key={note} className="et-note">
              {note}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterControl({ kind, spec, values, ontology, resolve, flip }: { kind: ListKind; spec: EntityFilterSpec; values: string[]; ontology: OntologyRef; resolve: Resolve; flip: (value: string) => void }) {
  const off = !!spec.unavailable;
  const why = off ? `Not available: ${spec.unavailable}` : spec.about;
  const option = (o: FilterOption, label = o.label) => (
    <button key={o.value} type="button" className={'ef-opt' + (values.includes(o.value) ? ' on' : '')} aria-pressed={values.includes(o.value)} disabled={off && !values.includes(o.value)} title={why} onClick={() => flip(o.value)}>
      {label}
      {o.count !== undefined && <span className="ef-n">{o.count}</span>}
    </button>
  );
  if (spec.type === 'flag') {
    return (
      <div className={'ef' + (off ? ' off' : '')}>
        {option(spec.options[0] ?? { value: ON, label: spec.label }, spec.label)}
        {off && <span className="ef-why" title={why}>not available</span>}
      </div>
    );
  }
  return (
    <div className={'ef' + (off ? ' off' : '')} role="group" aria-label={spec.label}>
      <span className="ef-label" title={why}>
        {spec.label}
      </span>
      {spec.entities ? <EntityChoice kind={kind} spec={spec} values={values} ontology={ontology} resolve={resolve} flip={flip} /> : spec.options.map((o) => option(o))}
      {!spec.entities && !spec.options.length && <span className="muted">nothing to choose from</span>}
      {off && <span className="ef-why" title={why}>not available</span>}
    </div>
  );
}

/**
 * The entities chosen for a filter, and a search to choose another. There may be thousands to
 * choose from, so they are not listed: the service is asked for the ones that fit what is typed.
 */
function EntityChoice({ kind, spec, values, ontology, resolve, flip }: { kind: ListKind; spec: EntityFilterSpec; values: string[]; ontology: OntologyRef; resolve: Resolve; flip: (value: string) => void }) {
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<FilterOption[]>([]);
  const { ontologyId, revisionId } = ontology;
  const taken = values.join('\n');
  useEffect(() => {
    if (query === null) return;
    const gone = new AbortController();
    entityService.options({ ontologyId, revisionId, kind, filter: spec.id, search: query, limit: 8 + values.length }, { signal: gone.signal }).then(
      (page) => !gone.signal.aborted && setFound(page.options.filter((o) => !values.includes(o.value)).slice(0, 8)),
      () => undefined,
    );
    return () => gone.abort();
    // `taken` stands for the values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ontologyId, revisionId, kind, spec.id, taken]);
  const close = () => {
    setQuery(null);
    setFound([]);
  };
  const what = spec.label.toLowerCase();
  return (
    <div className="supers picker ef-entities">
      <div className="chips-inline">
        {values.map((v) => {
          const e = resolve(v);
          return (
            <span key={v} className="chip-x" title={e?.iri}>
              <span className="et-chip">{e?.name ?? 'an entity that is gone'}</span>
              <button aria-label={`Remove ${e?.name ?? 'it'} from ${spec.label}`} title="Remove it from the filter" onClick={() => flip(v)}>
                ×
              </button>
            </span>
          );
        })}
        {query === null && (
          <button className="chip-add" disabled={!!spec.unavailable} title={spec.unavailable ? `Not available: ${spec.unavailable}` : `Choose ${values.length ? 'another' : 'an'} entity for “${spec.label}”`} aria-label={`Choose an entity for the filter ${what}`} onClick={() => setQuery('')}>
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
            aria-label={`Search for an entity for the filter ${what}`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') close();
              if (e.key === 'Enter' && found.length) {
                flip(found[0].value);
                close();
              }
            }}
            // Leaving the box closes it; a result is picked on pointer-down, before that happens.
            onBlur={close}
          />
          <ul className="subgraph-found" role="listbox">
            {found.map((o) => (
              <li key={o.value} role="option" aria-selected="false">
                <button
                  title={resolve(o.value)?.iri}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    flip(o.value);
                    close();
                  }}
                >
                  {o.label} {o.count !== undefined && <span className="muted">{o.count}</span>}
                </button>
              </li>
            ))}
            {!found.length && <li className="muted">{query.trim() ? 'Nothing matches.' : 'Nothing to choose from.'}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
