import { useEffect, useMemo, useRef, useState, type ReactNode, type ThHTMLAttributes } from 'react';
import type { EntityMatch, ListKind, MatchField } from '../entities/contracts';
import { inferredRestrictions } from '../model/inferred';
import { CHARACTERISTICS, dataDomain, fitsIn, hasCardinality, objectProperties, isInstanceOf, plainRelationships, propKey, propLinks, offeredChoices, relChoice, restrictionsOf, type RelChoice } from '../model/props';
import { endsForNew } from '../model/relating';
import { compactIri } from '../model/prefixes';
import { useStore } from '../model/store';
import { iriCut, setIriSuffix } from '../model/iri';
import { configOf, type EntityColumn } from '../model/modelTypes';
import { type Model, type Term, type TermType } from '../model/types';
import { EntityToolbar, filtersOn } from './EntityToolbar';
import { useEntityList } from './entityQuery';
import { CommitInput, useLazyOptions } from './fields';
import { RangeSelect } from './Datatypes';
import { GovernanceView } from './Governance';
import { Marked, MarkedField, type Ranges } from './Highlight';
import { IriCell, SuperclassEditor } from './Iri';
import { TermChips } from './TermChips';

type Tab = 'concept' | 'object' | 'property' | 'instance' | 'relations' | 'governance';

/** Remembered while the app is open. */
let lastTab: Tab = 'concept';

/** The entity to have in sight the next time the view is shown. */
let pointed: string | null = null;

/**
 * Has the Entities view open on this section the next time it is shown: for coming to an entity
 * from elsewhere. Given the entity (a term by its id, an object property by its key), its row is
 * listed and in sight there, whatever the section is searched for, filtered by or sorted by.
 */
export const openEntityTab = (tab: Tab, key?: string) => {
  lastTab = tab;
  pointed = key ?? null;
};

/** The list each tab is, as the entity queries know it. The governance tab is no list of theirs. */
const LIST: Partial<Record<Tab, ListKind>> = { concept: 'class', object: 'objectProperty', property: 'dataProperty', instance: 'individual', relations: 'relationship' };

/** Rows shown at a time; a table of thousands of editable rows is slow to draw and no use to read. */
const PAGE = 150;

const NO_MATCHES: EntityMatch[] = [];

/** Where a search found its words, for the cases a row does not show the text itself. */
const WHERE: Partial<Record<MatchField, string>> = { iri: 'IRI', description: 'definition', label: 'label' };

/** A class's inferred restrictions for the table: each with the class it comes from. */
function InferredCell({ model, id }: { model: Model; id: string }) {
  const inferred = useMemo(() => inferredRestrictions(model, id), [model, id]);
  if (inferred.status === 'inconsistent') return <span className="muted">ontology inconsistent</span>;
  return (
    <>
      {inferred.restrictions.map(({ key, restriction: r, sources }) => (
        <div key={key} title={sources.map((x) => x.because).join('\n')}>
          {r.property} <em>{r.quantifier}{r.n !== undefined ? ' ' + r.n : ''}</em> {r.filler} <span className="from">← {sources.map((x) => x.name).join(', ')}</span>
        </div>
      ))}
      {inferred.expressions.length > 0 && (
        <div className="muted" title={inferred.expressions.map((e) => e.text).join('\n')}>
          + {inferred.expressions.length} inherited expression{inferred.expressions.length === 1 ? '' : 's'}
        </div>
      )}
    </>
  );
}

/** A dropdown of every term that only builds its options when it is about to be used. */
function TermSelect({ value, current, onChange, label, sorted }: { value: string; current: string; onChange: (id: string) => void; label: string; sorted: Term[] }) {
  const { ready, lazy } = useLazyOptions();
  return (
    <select aria-label={label} value={value} {...lazy} onChange={(e) => onChange(e.target.value)}>
      {ready ? (
        sorted.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name || 'Unnamed'}
          </option>
        ))
      ) : (
        <option value={value}>{current}</option>
      )}
    </select>
  );
}

/**
 * Everything in the model by kind, the way an ontology editor lists it: classes, object
 * properties, data properties and individuals, each in its own tab. The side panel edits
 * whichever row is selected.
 */
export function EntitiesView() {
  const model = useStore((s) => s.model);
  const sel = useStore((s) => s.sel);
  const selProp = useStore((s) => s.selProp);
  const st = useStore.getState;
  const skos = model.mode === 'skos';
  const [tabState, setTabState] = useState<Tab>(lastTab);
  // The sections the type of model has; one it does not have is never the one shown.
  const config = configOf(model);
  const tab: Tab = config.entityTabs.includes(tabState) ? tabState : config.entityTabs[0];
  const [configuring, setConfiguring] = useState(false);
  const setTab = (t: Tab) => setTabState((lastTab = t));

  const props = useMemo(() => objectProperties(model), [model]);
  const plain = useMemo(() => new Set(skos ? [] : plainRelationships(model).flatMap((p) => p.rels.map((r) => r.id))), [model, skos]);
  const declared = useMemo(() => new Set(props.map((p) => p.key)), [props]);
  const name = useMemo(() => new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed'])), [model.terms]);
  const names = (ids: string[]) => ids.map((id) => name.get(id)).join(', ');
  const type = useMemo(() => new Map(model.terms.map((t) => [t.id, t.type])), [model.terms]);
  // Where there is one kind of term, every term is of it.
  const of = (type: TermType) => model.terms.filter((t) => config.termTypes.length < 2 || t.type === type);
  const sorted = useMemo(() => [...model.terms].sort((a, b) => a.name.localeCompare(b.name)), [model.terms]);
  // What each term is a kind of (or an instance of), and which terms have each data property.
  const { owners, degree } = useMemo(() => {
    const owners = new Map<string, string[]>();
    const degree = new Map<string, number>();
    for (const r of model.relations) {
      degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
      if (r.to !== r.from) degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
      if (r.kind === 'property') owners.set(r.to, [...(owners.get(r.to) ?? []), r.from]);
    }
    return { owners, degree };
  }, [model.relations]);

  const tabInfo: Record<Tab, { label: string; count: number }> = {
    concept: { label: config.termType.concept.plural, count: of('concept').length },
    object: { label: 'Object properties', count: props.length },
    property: { label: 'Data properties', count: of('property').length },
    instance: { label: 'Individuals', count: of('instance').length },
    relations: { label: 'Relationships', count: model.relations.length },
    governance: { label: 'Governance & Metadata', count: -1 },
  };
  const tabs = config.entityTabs.map((id) => ({ id, ...tabInfo[id] }));

  const addTerm = (type: TermType, label: string) => {
    const id = st().addTerm({ type, name: label });
    st().select([id]);
    justAdded(id);
  };
  // The list that is open, as the entity queries answer it: what is searched for, the order and
  // the filters are the list's own, and stay as they were when another tab is looked at.
  const kind = LIST[tab] ?? null;
  const views = useStore((s) => s.entityViews);
  const filtersOpen = useStore((s) => s.entityFiltersOpen);
  const view = views[kind ?? 'class'];
  const setView = (patch: Parameters<ReturnType<typeof st>['setEntityView']>[1]) => kind && st().setEntityView(kind, patch);
  const [limits, setLimits] = useState<Record<string, number>>({});
  // What the list is narrowed to and ordered by: a longer list is asked for under each of these afresh.
  const asked = `${kind}|${view.search.trim().toLowerCase()}|${view.sort ? view.sort.by + ' ' + view.sort.dir : ''}|${JSON.stringify(view.filters)}`;
  const limit = limits[asked] ?? PAGE;
  const entities = useEntityList(kind, view, limit);
  const { page } = entities;
  const narrowed = !!view.search.trim() || filtersOn(view.filters) > 0;

  // An entity that was just added is listed even where the search, the filters or the length of
  // the list would leave it out: a long table is not drawn in full for the sake of one row, and
  // what was asked for a moment ago is not thrown away to show it.
  const [pinned, setPinned] = useState<{ asked: string; key: string; why: 'added' | 'opened' } | null>(null);
  const extra = pinned && pinned.asked === asked && !entities.rows.some((r) => r.key === pinned.key) ? pinned.key : null;
  // The answer on show is the answer to what is asked now, of the model as it is now.
  const { settled } = entities;
  // Its row, until it has been brought into view, and whether the keyboard goes there too.
  const added = useRef<{ key: string; focus: boolean } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Not before the list has caught up with the model: until then the row may yet move.
    if (!added.current || !settled) return;
    const row = wrap.current?.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(added.current.key)}"]`);
    if (!row) return;
    const { focus } = added.current;
    added.current = null;
    // Of one just added, what it is called, or between what it stands, is what is set next: that is
    // where the keyboard goes, with the name it was given selected so that typing replaces it.
    const first = focus ? row.querySelector<HTMLElement>('input, select') : null;
    first?.focus({ preventScroll: true });
    if (first instanceof HTMLInputElement) first.select();
    row.scrollIntoView({ block: 'nearest' });
  });
  const justAdded = (key: string) => {
    setPinned({ asked, key, why: 'added' });
    added.current = { key, focus: true };
  };
  // Come to from elsewhere for one entity: that entity is listed and in sight, as one just added is.
  useEffect(() => {
    if (!pointed) return;
    setPinned({ asked, key: pointed, why: 'opened' });
    added.current = { key: pointed, focus: false };
    pointed = null;
    // Once, when the view is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A new order keeps the selected row in sight; a new search or filter starts at the top of what it found.
  const ordered = `${kind}|${view.sort ? view.sort.by + ' ' + view.sort.dir : ''}`;
  const narrowedTo = `${kind}|${view.search.trim().toLowerCase()}|${JSON.stringify(view.filters)}`;
  const seen = useRef({ ordered, narrowedTo });
  useEffect(() => {
    if (!settled) return;
    const was = seen.current;
    seen.current = { ordered, narrowedTo };
    if (!wrap.current || (was.ordered === ordered && was.narrowedTo === narrowedTo)) return;
    const row = was.narrowedTo === narrowedTo ? wrap.current.querySelector('tr.sel') : null;
    if (row) row.scrollIntoView({ block: 'nearest' });
    else wrap.current.scrollTop = 0;
  }, [settled, ordered, narrowedTo]);

  const add: Record<Tab, { label: string; run: () => void; disabled?: boolean; title?: string }> = {
    concept: { label: `Add ${config.termType.concept.label.toLowerCase()}`, run: () => addTerm('concept', `New ${config.termType.concept.label.toLowerCase()}`) },
    object: { label: 'Add object property', run: () => justAdded(st().addProp()) },
    property: { label: 'Add data property', run: () => addTerm('property', 'New data property') },
    instance: { label: 'Add individual', run: () => addTerm('instance', 'New individual') },
    relations: {
      label: 'Add relationship',
      title: 'Adds a relationship between the terms that are selected, or else between the first two that can be related. Its ends and its name are then set in its row.',
      run: () => {
        // Not simply the first two terms by name: in an ontology not every two terms can be related.
        const ends = endsForNew(model, sel.terms);
        if (ends.error !== undefined) return st().notify(ends.error);
        const id = st().addRelation(ends);
        if (!id) return;
        st().select([], [id]);
        justAdded(id);
      },
      disabled: !model.terms.length,
    },
    governance: { label: configuring ? 'Back to the entities' : 'Configure fields', run: () => setConfiguring(!configuring) },
  };
  const hint: Record<Tab, string> = {
    concept: skos ? 'Every concept of the vocabulary, by its name and its IRI. Its labels, definition and ownership are under Governance & Metadata; what it is broader or narrower than is under Structure.' : 'The classes of the ontology, each with the restrictions its properties place on it. Click a row to edit it in the side panel.',
    object: 'Object properties link two terms. Each is declared once here and reused wherever its name is used. A domain or range marked “from use” follows where the property is used; choose a class in the cell to set it yourself.',
    property: 'Data properties hold a value such as a date or a number. Attach one to a class with a “has property” relation.',
    instance: 'Individuals are particular things. Give one a type by making it “is a” of a class.',
    relations: skos
      ? 'Every relationship between two concepts.'
      : 'Every line drawn between two terms. One that uses an object property is a restriction or a fact; the others are plain relationships until you make their label an object property.',
    governance: configuring
      ? 'The metadata field registry of this model.'
      : 'Who owns each entity, where it stands, and where its data lives. Select an entity to see the metadata that applies to its kind. Every value is an annotation on the entity, stored with a standard RDF property where one exists; none of it changes what a class means.',
  };

  const termSelect = (value: string, onChange: (id: string) => void, label: string) => <TermSelect value={value} onChange={onChange} label={label} sorted={sorted} current={name.get(value) ?? 'Unnamed'} />;
  const rowProps = (t: Term) => ({
    'data-key': t.id,
    className: rowClass(t.id, sel.terms.includes(t.id)),
    title: t.id === extra ? pinnedTitle : undefined,
    onFocusCapture: () => !sel.terms.includes(t.id) && st().select([t.id]),
    onClick: () => !sel.terms.includes(t.id) && st().select([t.id]),
  });
  const actions = (t: Term) => (
    <td className="row-actions">
      <button className="btn small ghost" title="Show on the canvas" onClick={() => st().focusTerm(t.id)}>
        Show
      </button>
      <button className="btn icon ghost" title="Delete" aria-label={`Delete ${t.name}`} onClick={() => st().remove([t.id], [])}>
        ×
      </button>
    </td>
  );
  // Where the search found its words, row by row: the service says where, and here it is marked.
  const matches = useMemo(() => new Map(entities.rows.map((r) => [r.key, r.matches ?? NO_MATCHES])), [entities.rows]);
  /** The marks for a text a row shows, if that very text is one the words were found in. */
  const marksIn = (key: string, field: MatchField, shown: string): Ranges | undefined => matches.get(key)?.find((m) => m.field === field && m.text === shown)?.ranges;
  /** The same for the box of synonyms, which holds several labels one after the other. */
  const synonymMarks = (t: Term): Ranges | undefined => {
    const out: Ranges = [];
    for (const m of matches.get(t.id) ?? NO_MATCHES) {
      const at = m.field === 'label' && m.property === 'skos:altLabel' ? t.synonyms.indexOf(m.text) : -1;
      if (at >= 0) out.push(...m.ranges.map(([a, b]): [number, number] => [a + at, b + at]));
    }
    return out.length ? out.sort((a, b) => a[0] - b[0]) : undefined;
  };
  /** The class of a cell whose text the words were found in, where the text itself cannot be marked. */
  const found = (key: string, field: MatchField) => (matches.get(key)?.some((m) => m.field === field) ? 'hit' : undefined);
  const iriMarks = (key: string) => (shown: string) => matches.get(key)?.find((m) => (m.field === 'curie' || m.field === 'iri') && m.text === shown)?.ranges;
  /**
   * What the words were found in that the row has no place for: a label in another language,
   * the full IRI where the prefixed one is shown, a definition the table has no column for.
   */
  const foundElsewhere = (key: string, e: { iri?: string; synonyms?: string }, shows: { description: boolean; synonyms: boolean }) => {
    const hits = matches.get(key);
    if (!hits?.length) return null;
    const names = shows.synonyms ? (e.synonyms ?? '').split(',').map((x) => x.trim()) : [];
    const hidden = hits.filter((m) => (m.field === 'iri' ? !!e.iri && !!compactIri(model, e.iri) : m.field === 'description' ? !shows.description : m.field === 'label' ? !(m.property === 'skos:altLabel' && names.includes(m.text)) : false));
    if (!hidden.length) return null;
    return (
      <div className="hl-note">
        {hidden.map((m, i) => (
          <span key={i} title={m.text}>
            <span className="hl-where">{m.property ?? WHERE[m.field]}</span> <Marked text={m.text} ranges={m.ranges} />
          </span>
        ))}
      </div>
    );
  };
  const text = (t: Term, field: 'name' | 'description' | 'synonyms', label: string) => (
    <MarkedField text={t[field]} ranges={field === 'synonyms' ? synonymMarks(t) : marksIn(t.id, field, t[field])}>
      <CommitInput aria-label={label} value={t[field]} onCommit={(v) => st().updateTerm(t.id, { [field]: field === 'name' ? v.trim() : v })} />
    </MarkedField>
  );
  // A column that the list can be put in order by has a button for a heading: once for one way, again for the other, a third time for the model's own order.
  const sortHead = (label: ReactNode, sortId?: string, { key, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { key?: string } = {}) => {
    const spec = sortId ? entities.description?.sorts.find((x) => x.id === sortId) : undefined;
    if (!spec)
      return (
        <th key={key} {...props}>
          {label}
        </th>
      );
    const dir = view.sort?.by === spec.id ? view.sort.dir : null;
    const first = spec.numeric ? 'desc' : 'asc';
    const next = dir === null ? { by: spec.id, dir: first } : dir === first ? { by: spec.id, dir: first === 'asc' ? 'desc' : 'asc' } : null;
    return (
      <th key={key} {...props} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
        <button className={'th-sort' + (dir ? ' on ' + dir : '')} title={`${props.title ? props.title + '\n' : ''}Sort by ${spec.label.toLowerCase()}${dir ? (next ? ', the other way round' : ': back to the order of the model') : ''}`} onClick={() => setView({ sort: next as typeof view.sort })}>
          {label}
        </button>
      </th>
    );
  };
  // Every column the table of classes or concepts can have. Which of them it has is the type of model's to say.
  const columns: Record<EntityColumn, { head: string; width: string | number; title?: string; cls?: string; sort?: string; cell: (t: Term) => ReactNode }> = {
    name: {
      head: 'Name',
      width: '15%',
      sort: 'name',
      cell: (t) => (
        <>
          {text(t, 'name', 'Name')}
          {foundElsewhere(t.id, t, { description: config.entityColumns.includes('description'), synonyms: config.entityColumns.includes('synonyms') })}
        </>
      ),
    },
    iri: { head: 'IRI', width: '19%', cls: 'ro', sort: 'iri', cell: (t) => <IriCell iri={t.iri} of={t.name} marks={iriMarks(t.id)} /> },
    suffix: {
      head: 'IRI suffix',
      width: '18%',
      title: 'The last part of the IRI. It is the entity’s identifier, apart from its name: renaming the entity does not change it.',
      cell: (t) => (
        <CommitInput
          aria-label="IRI suffix"
          disabled={t.external !== undefined}
          value={t.iri ? t.iri.slice(iriCut(t.iri)) : ''}
          placeholder="made from the name"
          onCommit={(v) => {
            const refused = st().edit((m) => setIriSuffix(m, { term: t.id }, v));
            if (refused) st().notify(refused);
          }}
        />
      ),
    },
    type: {
      head: 'Type',
      width: '18%',
      cls: 'ro',
      cell: (t) => (
        <>
          {config.termType[t.type].label} <code className="pred">{config.termType[t.type].rdf}</code>
        </>
      ),
    },
    hierarchy: { head: 'Asserted Superclasses', width: '17%', sort: 'superclasses', title: 'The superclasses explicitly stated for each class (rdfs:subClassOf). Superclasses that only follow from these are not listed.', cls: 'cell-edit', cell: (t) => <SuperclassEditor term={t} /> },
    restrictions: {
      head: 'Asserted Restrictions',
      width: '17%',
      sort: 'restrictions',
      title: 'Stated on the class itself: what its properties require of it',
      cls: 'ro restrictions-cell',
      cell: (t) => (
        <>
          {restrictionsOf(model, t.id).map((r) => (
            <div key={`${r.rel.id}:${r.index}`}>
              {r.property} <em>{r.quantifier}{r.n !== undefined ? ' ' + r.n : ''}</em> {r.filler}
            </div>
          ))}
          {t.axioms?.length ? (
            <div className="muted" title={t.axioms.join('\n')}>
              + {t.axioms.length} other asserted expression{t.axioms.length === 1 ? '' : 's'}
            </div>
          ) : null}
        </>
      ),
    },
    inferred: { head: 'Inferred Restrictions', width: '19%', title: 'Not stated on the class, but entailed by the reasoner: inherited from its superclasses and equivalent classes. Read-only.', cls: 'ro restrictions-cell inferred', cell: (t) => <InferredCell model={model} id={t.id} /> },
    description: { head: 'Description', width: '13%', cell: (t) => text(t, 'description', 'Description') },
    synonyms: { head: 'Synonyms', width: '9%', cell: (t) => text(t, 'synonyms', 'Synonyms') },
    relations: { head: 'Relations', width: 80, cls: 'num', sort: 'relations', cell: (t) => degree.get(t.id) ?? 0 },
  };
  // The rows of the list are keys in an order; what each row shows and edits is the entity itself.
  const termById = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);
  const propByKey = useMemo(() => new Map(props.map((p) => [p.key, p])), [props]);
  const relById = useMemo(() => new Map(model.relations.map((r) => [r.id, r])), [model.relations]);
  const keys = extra ? [...entities.rows.map((r) => r.key), extra] : entities.rows.map((r) => r.key);
  const present = <T,>(found: (T | undefined)[]): T[] => found.filter((x): x is T => x !== undefined);
  const list = kind === 'class' || kind === 'dataProperty' || kind === 'individual' ? present(keys.map((k) => termById.get(k))) : [];
  const shownProps = kind === 'objectProperty' ? present(keys.map((k) => propByKey.get(k))) : [];
  const shownRelations = kind === 'relationship' ? present(keys.map((k) => relById.get(k))) : [];
  /** What a filter names by its key: a term, or an object property. */
  const resolve = (key: string) => {
    const t = termById.get(key);
    if (t) return { name: t.name || 'Unnamed', iri: t.iri };
    const p = propByKey.get(key);
    return p ? { name: p.name, iri: p.iri } : undefined;
  };
  const noun: Record<ListKind, { one: string; many: string }> = {
    class: { one: config.termType.concept.label.toLowerCase(), many: config.termType.concept.plural.toLowerCase() },
    objectProperty: { one: 'object property', many: 'object properties' },
    dataProperty: { one: 'data property', many: 'data properties' },
    individual: { one: 'individual', many: 'individuals' },
    relationship: { one: 'relationship', many: 'relationships' },
  };
  /** The row of an entity that is listed only because it was just added. */
  const rowClass = (key: string, selected: boolean) => (selected ? 'sel' : '') + (key === extra ? ' pinned' : '');
  const pinnedTitle = (pinned?.why === 'opened' ? 'The one that was opened. ' : 'Just added. ') + (narrowed ? 'It is listed here although the search or the filters would leave it out.' : 'Its place in this order is further down the list.');

  return (
    <div className="view">
      <div className="view-head">
        <div className="tabs" role="tablist" aria-label="Kind of entity">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}{t.count >= 0 ? ` (${t.count})` : ''}
            </button>
          ))}
        </div>
      </div>
      {/* Search, order and filters of the list that is open, directly under the tabs, with its one action at the end of the bar. */}
      {kind && (
        <EntityToolbar kind={kind} noun={noun[kind]} view={view} list={entities} set={setView} open={filtersOpen} setOpen={st().setEntityFiltersOpen} resolve={resolve}>
          <button className="btn primary" disabled={add[tab].disabled} title={add[tab].title} onClick={add[tab].run}>
            {add[tab].label}
          </button>
        </EntityToolbar>
      )}
      {/* What the tab is for. */}
      <div className={'view-sub' + (kind ? ' hint-only' : '')}>
        <p className="muted">{hint[tab]}</p>
        {!kind && (
          <button className="btn primary" disabled={add[tab].disabled} title={add[tab].title} onClick={add[tab].run}>
            {add[tab].label}
          </button>
        )}
      </div>
      {tab === 'governance' && <GovernanceView configuring={configuring} />}
      <div className="table-wrap" ref={wrap} hidden={tab === 'governance'} aria-busy={!!kind && !settled}>
        {tab === 'concept' && (
          <table className={config.entityColumns.length > 5 ? 'wide' : ''}>
            <thead>
              <tr>
                {config.entityColumns.map((c) => sortHead(columns[c].head, columns[c].sort, { key: c, style: { width: columns[c].width }, className: c === 'relations' ? 'num' : undefined, title: columns[c].title }))}
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} {...rowProps(t)}>
                  {config.entityColumns.map((c) => (
                    <td key={c} className={columns[c].cls}>
                      {columns[c].cell(t)}
                    </td>
                  ))}
                  {actions(t)}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'object' && (
          <table>
            <thead>
              <tr>
                {sortHead('Name', 'name', { style: { width: '14%' } })}
                {sortHead('IRI', 'iri', { style: { width: '17%' } })}
                <th>Domain</th>
                <th>Range</th>
                <th style={{ width: '17%' }}>Characteristics</th>
                <th style={{ width: '13%' }}>Inverse of</th>
                {sortHead('Uses', 'relations', { style: { width: 78 }, className: 'num', title: 'How many relationships use the property' })}
                <th style={{ width: 50 }} />
              </tr>
            </thead>
            <tbody>
              {shownProps.map((p) => (
                <tr
                  key={p.key}
                  data-key={p.key}
                  className={rowClass(p.key, selProp === p.key)}
                  title={p.key === extra ? pinnedTitle : undefined}
                  onFocusCapture={() => selProp !== p.key && st().selectProp(p.key)}
                  onClick={() => selProp !== p.key && st().selectProp(p.key)}
                >
                  <td>
                    <MarkedField text={p.name} ranges={marksIn(p.key, 'name', p.name)}>
                      <CommitInput aria-label="Property name" value={p.name} onCommit={(v) => st().renameProp(p.key, v)} />
                    </MarkedField>
                    {foundElsewhere(p.key, p, { description: false, synonyms: false })}
                  </td>
                  <td className="ro">
                    <IriCell iri={p.iri} of={p.name} marks={iriMarks(p.key)} />
                  </td>
                  {(['domain', 'range'] as const).map((side) => {
                    const ids = p[side];
                    const auto = side === 'domain' ? p.domainAuto : p.rangeAuto;
                    // Uses between classes that a hand-set domain or range does not cover.
                    const outside = auto
                      ? 0
                      : p.rels.filter((r) => type.get(r.from) === 'concept' && type.get(r.to) === 'concept' && ids.length > 0 && !fitsIn(model, side === 'domain' ? r.from : r.to, ids)).length;
                    return (
                      <td key={side} className="cell-edit">
                        <TermChips
                          ids={ids}
                          placeholder={`Add a class to the ${side}`}
                          of={p.name}
                          empty="anything"
                          add={(id) => st().updateProp(p.key, { [side]: [...ids, id] })}
                          remove={(id) => st().updateProp(p.key, { [side]: ids.filter((x) => x !== id) })}
                        />
                        {auto && ids.length > 0 && <span className="tag auto">from use</span>}
                        {!auto && (
                          <button className="link reset" title="Let it follow where the property is used again" onClick={() => st().updateProp(p.key, { [side]: undefined })}>
                            reset
                          </button>
                        )}
                        {outside > 0 && (
                          <span className="bad" title="Open the property to see which">
                            ✗ {outside} use{outside === 1 ? '' : 's'} outside
                          </span>
                        )}
                        {!auto && ids.length > 0 && p.rels.length > 0 && outside === 0 && <span className="good">✓ uses fit</span>}
                      </td>
                    );
                  })}
                  <td className="ro">{CHARACTERISTICS.filter((c) => p.chars.includes(c.id)).map((c) => c.label).join(', ') || '—'}</td>
                  <td className="ro">{propLinks(model, p.key, 'inverses').map((k) => props.find((x) => x.key === k)?.name ?? k).join(', ') || '—'}</td>
                  <td className="num">{p.rels.length}</td>
                  <td className="row-actions">
                    <button className="btn icon ghost" title="Delete the property and the relationships that use it" aria-label={`Delete ${p.name}`} onClick={() => st().deleteProp(p.key)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'property' && (
          <table>
            <thead>
              <tr>
                {sortHead('Name', 'name', { style: { width: '16%' } })}
                {sortHead('IRI', 'iri', { style: { width: '18%' } })}
                <th style={{ width: '18%' }}>Domain</th>
                <th style={{ width: '16%' }}>Attached to</th>
                {sortHead('Range (datatype)', 'range', { style: { width: 220 } })}
                <th style={{ width: 90 }} title="Each thing has at most one value (owl:FunctionalProperty)">
                  Functional
                </th>
                <th>Description</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} {...rowProps(t)}>
                  <td>
                    {text(t, 'name', 'Name')}
                    {foundElsewhere(t.id, t, { description: true, synonyms: false })}
                  </td>
                  <td className="ro">
                    <IriCell iri={t.iri} of={t.name} marks={iriMarks(t.id)} />
                  </td>
                  <td className="cell-edit">
                    {(() => {
                      const d = dataDomain(model, t);
                      return (
                        <>
                          <TermChips
                            ids={d.ids}
                            placeholder="Add a class to the domain"
                            of={t.name}
                            empty="not set"
                            add={(id) => st().updateTerm(t.id, { domain: [...d.ids, id] })}
                            remove={(id) => st().updateTerm(t.id, { domain: d.ids.filter((x) => x !== id) })}
                          />
                          {d.auto ? (
                            d.ids.length > 0 && <span className="tag auto">from use</span>
                          ) : (
                            <button className="link reset" title="Let it follow the classes it is attached to again" onClick={() => st().updateTerm(t.id, { domain: undefined })}>
                              reset
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </td>
                  <td className="ro">{names(owners.get(t.id) ?? []) || '—'}</td>
                  <td>
                    <RangeSelect term={t} />
                  </td>
                  <td className="num">
                    <input type="checkbox" aria-label={`${t.name} is functional`} checked={!!t.functional} onChange={(e) => st().updateTerm(t.id, { functional: e.target.checked || undefined })} />
                  </td>
                  <td>{text(t, 'description', 'Description')}</td>
                  {actions(t)}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'instance' && (
          <table>
            <thead>
              <tr>
                {sortHead('Name', 'name', { style: { width: '18%' } })}
                {sortHead('IRI', 'iri', { style: { width: '22%' } })}
                {sortHead('Type', 'type', { style: { width: '18%' }, title: 'The classes the individual is stated to be an instance of' })}
                <th>Description</th>
                {sortHead('Relations', 'relations', { style: { width: 96 }, className: 'num' })}
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} {...rowProps(t)}>
                  <td>
                    {text(t, 'name', 'Name')}
                    {foundElsewhere(t.id, t, { description: true, synonyms: false })}
                  </td>
                  <td className="ro">
                    <IriCell iri={t.iri} of={t.name} marks={iriMarks(t.id)} />
                  </td>
                  <td className="cell-edit">
                    <SuperclassEditor term={t} />
                  </td>
                  <td>{text(t, 'description', 'Description')}</td>
                  <td className="num">{degree.get(t.id) ?? 0}</td>
                  {actions(t)}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'relations' && (
          <table>
            <thead>
              <tr>
                {sortHead('From', 'from', { style: { width: '20%' } })}
                {sortHead(skos ? 'Label' : 'Property / label', 'label', { style: { width: '18%' } })}
                {sortHead('To', 'to', { style: { width: '20%' } })}
                {sortHead('Kind', 'kind', { style: { width: 230 } })}
                {!skos && <th style={{ width: 190 }}>Meaning</th>}
                <th style={{ width: 90 }}>From card.</th>
                <th style={{ width: 90 }}>To card.</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {shownRelations.map((r) => (
                <tr
                  key={r.id}
                  data-key={r.id}
                  className={rowClass(r.id, sel.rels.includes(r.id))}
                  title={r.id === extra ? pinnedTitle : undefined}
                  onFocusCapture={() => !sel.rels.includes(r.id) && st().select([], [r.id])}
                  onClick={() => !sel.rels.includes(r.id) && st().select([], [r.id])}
                >
                  {/* A dropdown cannot mark part of its text: the cell says that the words were found in it. */}
                  <td className={found(r.id, 'from')}>{termSelect(r.from, (from) => st().updateRelation(r.id, { from }), 'From')}</td>
                  <td>
                    <MarkedField text={r.label} ranges={marksIn(r.id, 'name', r.label)}>
                      <CommitInput aria-label="Label" list={skos ? undefined : 'object-props'} value={r.label} onCommit={(v) => st().updateRelation(r.id, { label: v.trim() })} />
                    </MarkedField>
                  </td>
                  <td className={found(r.id, 'to')}>{termSelect(r.to, (to) => st().updateRelation(r.id, { to }), 'To')}</td>
                  <td className={found(r.id, 'kind')}>
                    <select aria-label="Kind" value={relChoice(model, r)} onChange={(e) => st().setRelChoice(r.id, e.target.value as RelChoice)}>
                      {offeredChoices(model, r).map((k) => (
                        <option key={k.value} value={k.value} disabled={!!k.disabled} title={k.disabled}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  {!skos && (
                    <td className="ro">
                      {r.kind !== 'association' || r.predicate ? (
                        <span className="muted">{isInstanceOf(model, r) ? 'class membership (rdf:type)' : (r.predicate ?? (r.kind === 'generalization' ? 'hierarchy' : 'data property'))}</span>
                      ) : declared.has(propKey(r.label)) && !plain.has(r.id) ? (
                        <button className="link" title="Open the object property" onClick={() => st().selectProp(propKey(r.label))}>
                          object property
                        </button>
                      ) : plain.has(r.id) ? (
                        <button
                          className="btn small"
                          title={declared.has(propKey(r.label)) ? 'Make this relationship a use of the object property with this name' : 'Declare this label as an object property; every relationship carrying it becomes a use of it'}
                          onClick={() => (declared.has(propKey(r.label)) ? st().setRelChoice(r.id, 'object') : st().declareProp(r.label))}
                        >
                          Make object property
                        </button>
                      ) : null}
                    </td>
                  )}
                  {/* Only a plain relationship has cardinalities; the other kinds say "how many" with restrictions, or not at all. */}
                  {hasCardinality(model, r) ? (
                    <>
                      <td>
                        <CommitInput aria-label="From cardinality" value={r.fromCard} onCommit={(v) => st().updateRelation(r.id, { fromCard: v.trim() })} />
                      </td>
                      <td>
                        <CommitInput aria-label="To cardinality" value={r.toCard} onCommit={(v) => st().updateRelation(r.id, { toCard: v.trim() })} />
                      </td>
                    </>
                  ) : (
                    <td colSpan={2} className="ro muted" title="Cardinalities are for plain relationships">
                      —
                    </td>
                  )}
                  <td className="row-actions">
                    <button className="btn small ghost" title="Show on the canvas" onClick={() => st().focusRelation(r.id)}>
                      Show
                    </button>
                    <button className="btn icon ghost" title="Delete relationship" aria-label="Delete relationship" onClick={() => st().remove([], [r.id])}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {kind && entities.error && (
          <p className="muted pad" role="alert">
            The list could not be worked out: {entities.error}
          </p>
        )}
        {kind && page && page.total === 0 && <p className="muted pad">Nothing here yet.</p>}
        {/* Nothing is left: what it was narrowed by is said, with the way back from each. */}
        {kind && page && page.total > 0 && page.matched === 0 && !extra && (
          <div className="empty-result" role="status">
            <strong>
              No {noun[kind].one} matches{view.search.trim() ? ` “${view.search.trim()}”` : ''}
              {filtersOn(view.filters) ? `${view.search.trim() ? ' with' : ''} the ${filtersOn(view.filters) === 1 ? 'filter' : `${filtersOn(view.filters)} filters`} that ${filtersOn(view.filters) === 1 ? 'is' : 'are'} on` : ''}.
            </strong>
            <span className="muted">
              There {page.total === 1 ? `is 1 ${noun[kind].one}` : `are ${page.total.toLocaleString('en')} ${noun[kind].many}`} in all.
              {view.search.trim() ? (kind === 'relationship' ? ' Every word of the search has to be found in its name, in the name of one of its two ends, or in its kind.' : ' Every word of the search has to be found in the name, another label, the IRI or the definition.') : ''}
            </span>
            <span className="row">
              {view.search.trim() && (
                <button className="btn small" onClick={() => setView({ search: '' })}>
                  Clear the search
                </button>
              )}
              {filtersOn(view.filters) > 0 && (
                <button className="btn small" onClick={() => setView({ filters: {} })}>
                  Clear all filters
                </button>
              )}
            </span>
          </div>
        )}
        {kind && page && page.matched > entities.rows.length && (
          <p className="pager">
            Showing {entities.rows.length.toLocaleString('en')} of {page.matched.toLocaleString('en')}.
            <button className="btn small" onClick={() => setLimits({ ...limits, [asked]: limit + PAGE * 2 })}>
              Show {Math.min(PAGE * 2, page.matched - entities.rows.length)} more
            </button>
            <button className="btn small" onClick={() => setLimits({ ...limits, [asked]: page.matched })}>
              Show all
            </button>
            <span className="muted">Search or filter above to narrow the list.</span>
          </p>
        )}
      </div>
      <datalist id="object-props">
        {props.map((p) => (
          <option key={p.key} value={p.name} />
        ))}
      </datalist>
    </div>
  );
}
