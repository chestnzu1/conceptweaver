import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../model/store';
import { StructureError, type Iri, type PropertyHierarchyNode, type PropertyHierarchyPage, type PropertyRef, type PropertySummary, type Provenance } from '../structure/contracts';
import { holds, openWide, Places, ROOT, rowsOf, TOP, wanting, withPage, type Branch, type OutlineRow } from '../structure/outline';
import { Disclosure } from './Icon';
import { IriCell } from './Iri';
import type { StructureHost } from './Structure';

/**
 * How many lines the hierarchy opens to by itself, and at one press of Expand all. They bound
 * what one action fetches, not what an ontology may hold: further branches open one at a time.
 */
const OPENS_TO = 200;
const EXPANDS_TO = 10_000;
/** How many branches are asked for in one question. A level with more is asked for in several. */
const BATCH = 200;
/** The height of a line. Every line is this high, which is what lets only the ones in view be drawn. */
const ROW = 30;
/** Lines drawn beyond each edge of what is in view, so that scrolling does not show a gap. */
const BEYOND = 12;
/** The deepest a line is indented. Further down the level is still said, to a screen reader, by its number. */
const INDENT_LEVELS = 30;

/** Which places are open in the property hierarchy, for the model in the editor. Kept outside the component so that it survives switching views. */
let remembered: { seq: number; places: Places; open: Set<number> | null } | undefined;

/** What has been fetched of the hierarchy: `base` says which revision, search and language it is of. */
interface Fetched {
  base: string;
  branches: Map<string, Branch<PropertyHierarchyNode>>;
  /** Goes up with every change, so that what is on show is only replaced when there is something new. */
  version: number;
  /** With a search: how many properties it finds. */
  matched?: number;
  /** Where the hierarchy comes from, as the service said with the properties at the top. */
  provenance?: Provenance;
}

/** A line of the list: the top, a property in one of its places, a stretch of a list that is not fetched, or a branch that is being fetched. */
type Line = { kind: 'root' } | OutlineRow<PropertyHierarchyNode> | { kind: 'wait'; place: number; depth: number };
const keyOf = (line: Line) => (line.kind === 'root' ? 'root' : line.kind === 'class' ? `c${line.place}` : line.kind === 'more' ? `m${line.place}-${line.offset}` : `w${line.place}`);

/** What the outline needs of a property node. */
const readProps = (n: PropertyHierarchyNode) => ({ iri: n.property.iri, childCount: n.childCount, inCycle: n.inCycle });

/**
 * The hierarchy of the object and data properties: each under every property it is stated to be
 * a subproperty of, and nothing else. No reasoner draws a property hierarchy, so this one is the
 * stated one throughout. Branches are fetched as they are opened and only the lines in view are
 * drawn. A property is brought into focus by choosing it; that selects nothing, and what is then
 * said of it beside the hierarchy leads on to where it is edited.
 */
export function StructurePropertyExplore({ host }: { host: StructureHost }) {
  const { service, ontology } = host;
  const docSeq = useStore((s) => s.docSeq);
  const focus = useStore((s) => s.structure.focus);
  const pointed = useStore((s) => s.structure.pointed);
  const search = useStore((s) => s.structure.search);
  const st = useStore.getState;

  // The search is asked a moment after the typing stops: each one is a question to the service.
  const [filter, setFilter] = useState(search.trim());
  useEffect(() => {
    const id = setTimeout(() => setFilter(search.trim()), search.trim() ? 160 : 0);
    return () => clearTimeout(id);
  }, [search]);

  const kept = useMemo(() => {
    if (remembered?.seq !== docSeq) remembered = { seq: docSeq, places: new Places(), open: null };
    return remembered;
  }, [docSeq]);
  const places = kept.places;
  const [ownOpen, setOwnOpen] = useState<Set<number>>(() => kept.open ?? new Set());
  // A search opens what it finds, and leaves what was open before as it was for when it is over.
  const [found, setFound] = useState<{ base: string; open: Set<number> }>({ base: '', open: new Set() });
  const open = filter ? found.open : ownOpen;
  const setOpen = (next: Set<number>) => {
    if (filter) return setFound((f) => ({ ...f, open: next }));
    kept.open = next;
    setOwnOpen(next);
  };

  // The hierarchy is the same in every language except in the words it is read in; a new revision is read again.
  const base = `${ontology.ontologyId}\n${ontology.revisionId}\n${filter}\n${host.displayLang}`;
  // `pool` fills as answers come in; `shown` is what is drawn, and stays until what replaces it is all there.
  const pool = useRef<Fetched>({ base: '', branches: new Map(), version: 0 });
  const [shown, setShown] = useState<Fetched>(pool.current);
  const [error, setError] = useState<string>();
  /** Expand all, or a search, stopped at its number of lines with branches still closed. */
  const [cut, setCut] = useState(false);
  /** Lists that were made longer with Show more, so that an edit elsewhere does not shorten them again. */
  const grown = useRef(new Map<Iri, number>());
  /** A property to be brought into view: one in focus when arriving here, by the way down it came by. */
  const toReveal = useRef<{ iri: Iri; way?: PropertyRef[] } | null>(focus && !search.trim() ? { iri: focus } : null);
  const [asked, setAsked] = useState(0);
  const scrollTo = useRef<number | null>(null);
  /** The line the keyboard is on. */
  const [cursor, setCursor] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const ask = useCallback(
    (parent: Iri, extra: { cursor?: string; through?: Iri; limit?: number } = {}, signal?: AbortSignal) =>
      service.propertyChildren({ ...ontology, ...(parent === TOP ? {} : { parentIri: parent }), ...(filter ? { filter } : {}), ...extra }, { signal }),
    [service, ontology, filter],
  );
  /** The first page of the subproperties of several properties, asked for together: one question for a level, not one for each branch. */
  const askMany = useCallback(
    async (parents: { iri: Iri; through?: Iri; limit?: number }[], signal?: AbortSignal): Promise<PropertyHierarchyPage[]> => {
      const pages: PropertyHierarchyPage[] = [];
      for (let i = 0; i < parents.length; i += BATCH) {
        const some = parents.slice(i, i + BATCH).map(({ iri, ...rest }) => ({ ...(iri === TOP ? {} : { parentIri: iri }), ...rest }));
        pages.push(...(await service.propertyBranches({ ...ontology, ...(filter ? { filter } : {}), parents: some }, { signal })));
      }
      return pages;
    },
    [service, ontology, filter],
  );
  const put = (to: Fetched, parent: Iri, page: PropertyHierarchyPage) => {
    to.branches.set(parent, withPage(to.branches.get(parent), page));
    if (parent === TOP) {
      to.matched = page.matched;
      to.provenance = page.provenance;
    }
    to.version++;
  };
  const show = (from: Fetched) => setShown((now) => (now.base === from.base && now.version === from.version ? now : { ...from, branches: new Map(from.branches) }));
  const failed = (e: unknown) => {
    // The ontology moved on while it was being asked about: the question is asked again for what it is now.
    if (e instanceof StructureError && (e.code === 'stale-revision' || e.code === 'aborted')) return;
    setError(e instanceof Error ? e.message : 'The property hierarchy could not be read.');
  };

  const firstPointed = useRef(pointed);
  useEffect(() => {
    if (firstPointed.current === pointed) return;
    firstPointed.current = pointed;
    const iri = st().structure.focus;
    toReveal.current = iri ? { iri } : null;
    // Pointing at something from elsewhere asks to see it, whatever was being searched for.
    if (st().structure.search) st().setStructure({ search: '' });
  }, [pointed, st]);

  // Brings what is fetched up to what is to be drawn: the top, and the subproperties of every open place.
  useEffect(() => {
    const abort = new AbortController();
    const signal = abort.signal;
    if (pool.current.base !== base) pool.current = { base, branches: new Map(), version: 0 };
    const mine = pool.current;
    const fetch = async (parents: Iri[]) => {
      const pages = await askMany(parents.map((iri) => ({ iri, ...(!filter && grown.current.has(iri) ? { limit: grown.current.get(iri) } : {}) })), signal);
      parents.forEach((iri, n) => !mine.branches.has(iri) && put(mine, iri, pages[n]));
    };
    void (async () => {
      try {
        let wanted = open;
        if (filter && found.base !== base) {
          const wide = await openWide(mine.branches, places, fetch, EXPANDS_TO, readProps);
          if (signal.aborted) return;
          wanted = wide.open;
          setFound({ base, open: wide.open });
          setCut(wide.cut);
        } else if (!filter && kept.open === null) {
          const wide = await openWide(mine.branches, places, fetch, OPENS_TO, readProps);
          if (signal.aborted) return;
          kept.open = wide.open;
          wanted = wide.open;
          setOwnOpen(wide.open);
        }
        if (!filter && toReveal.current) {
          const want = toReveal.current;
          try {
            const way = want.way ?? (await service.propertyPaths({ ...ontology, propertyIri: want.iri, limit: 1 }, { signal })).paths[0] ?? [];
            if (signal.aborted) return;
            const next = new Set(wanted);
            let place = ROOT;
            // Of a long list, the page the property is on is fetched, not all that comes before it; and the whole way in one question.
            const steps = way.map((step, i) => ({ iri: i ? way[i - 1].iri : TOP, through: step.iri }));
            const missing = steps.filter((x) => !holds(mine.branches.get(x.iri), x.through, readProps));
            const pages = missing.length ? await askMany(missing, signal) : [];
            if (signal.aborted) return;
            missing.forEach((x, n) => put(mine, x.iri, pages[n]));
            for (const [i, step] of way.entries()) {
              place = places.at(place, step.iri);
              if (i < way.length - 1) next.add(place);
            }
            toReveal.current = null;
            if (way.length) {
              scrollTo.current = place;
              setCursor(`c${place}`);
            }
            if (next.size !== wanted.size) {
              wanted = kept.open = next;
              setOwnOpen(next);
            }
          } catch (e) {
            if (signal.aborted) return;
            if (!(e instanceof StructureError && e.code === 'not-found')) throw e;
            // The property that was to be shown is not in the ontology any more. The hierarchy is shown all the same, without one in focus.
            toReveal.current = null;
            st().setStructure({ focus: null });
          }
        }
        for (;;) {
          const need = wanting(mine.branches, places, wanted, readProps);
          if (!need.length) break;
          await fetch(need);
          if (signal.aborted) return;
        }
        if (signal.aborted) return;
        setError(undefined);
        show(mine);
      } catch (e) {
        if (signal.aborted) return;
        failed(e);
      }
    })();
    return () => abort.abort();
    // `found` and `kept` are read as they are when the hierarchy to draw changes; they do not change it themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, open, pointed, asked, askMany, service, ontology, places]);

  // What there is to say of the property in focus, asked again whenever the ontology changes.
  const [about, setAbout] = useState<{ iri: Iri; summary: PropertySummary; ways: PropertyRef[][] } | null>(null);
  useEffect(() => {
    if (!focus) return setAbout(null);
    const abort = new AbortController();
    void (async () => {
      try {
        const [summary, ways] = await Promise.all([service.propertySummary({ ...ontology, propertyIri: focus }, { signal: abort.signal }), service.propertyPaths({ ...ontology, propertyIri: focus, limit: 12 }, { signal: abort.signal })]);
        if (!abort.signal.aborted) setAbout({ iri: focus, summary, ways: ways.paths });
      } catch (e) {
        if (abort.signal.aborted) return;
        // The property in focus was deleted, or its adding undone. Nothing is kept in focus that is not there.
        if (e instanceof StructureError && e.code === 'not-found') st().setStructure({ focus: null });
        else failed(e);
      }
    })();
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, service, ontology]);
  const current = about && about.iri === focus ? about : null;

  const rows = useMemo(() => rowsOf(shown.branches, places, open, readProps), [shown, places, open]);
  const inFocus = useCallback((node: PropertyHierarchyNode) => !!focus && node.property.iri === focus, [focus]);
  const lines = useMemo(() => {
    const out: Line[] = [{ kind: 'root' }];
    for (const row of rows) {
      out.push(row);
      if (row.kind === 'class' && row.loading) out.push({ kind: 'wait', place: row.place, depth: row.depth + 1 });
    }
    return out;
  }, [rows]);
  const top: Branch<PropertyHierarchyNode> | undefined = shown.branches.get(TOP);
  const stale = shown.base !== base;

  // Only the lines in view are drawn, with a few beyond each edge.
  const [view, setView] = useState({ first: 0, count: 40 });
  const measure = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const first = Math.floor(el.scrollTop / ROW);
    const count = Math.ceil(el.clientHeight / ROW) + 1;
    setView((v) => (v.first === first && v.count === count ? v : { first, count }));
  }, []);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    measure();
    const sized = new ResizeObserver(measure);
    sized.observe(el);
    return () => sized.disconnect();
  }, [measure]);
  const from = Math.max(0, Math.min(view.first, lines.length) - BEYOND);
  const to = Math.min(lines.length, view.first + view.count + BEYOND);
  /** Scrolls a line into view, to the middle when it was out of sight. */
  const reach = useCallback((index: number) => {
    const el = wrap.current;
    if (!el || index < 0) return;
    const y = index * ROW;
    if (y < el.scrollTop || y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, y - el.clientHeight / 2 + ROW / 2);
  }, []);
  // A property that was brought into view is scrolled to once its line is there.
  useLayoutEffect(() => {
    if (scrollTo.current === null) return;
    const index = lines.findIndex((l) => l.kind === 'class' && l.place === scrollTo.current);
    if (index < 0) return;
    scrollTo.current = null;
    reach(index);
  });

  // Read as they are when a line is pressed, so that the lines need not be drawn again each time one opens.
  const latest = useRef({ open, setOpen });
  latest.current = { open, setOpen };
  const toggle = useCallback((place: number) => {
    const next = new Set(latest.current.open);
    if (!next.delete(place)) next.add(place);
    setCut(false);
    latest.current.setOpen(next);
  }, []);
  const choose = useCallback(
    (iri: Iri, place: number) => {
      setCursor(`c${place}`);
      st().setStructure({ focus: iri });
    },
    [st],
  );
  /** Brings a property into focus and into view, from what is said beside the hierarchy: by one way down, where one is given. */
  const go = (iri: Iri, way?: PropertyRef[]) => {
    toReveal.current = { iri, ...(way ? { way } : {}) };
    if (search) st().setStructure({ search: '', focus: iri });
    else st().setStructure({ focus: iri });
    setAsked((n) => n + 1);
  };
  const expandAll = async () => {
    const mine = pool.current;
    try {
      const wide = await openWide(
        mine.branches,
        places,
        async (parents) => {
          const pages = await askMany(parents.map((iri) => ({ iri })));
          parents.forEach((iri, n) => put(mine, iri, pages[n]));
        },
        EXPANDS_TO,
        readProps,
      );
      if (pool.current !== mine) return;
      show(mine);
      setOpen(wide.open);
      setCut(wide.cut);
    } catch (e) {
      failed(e);
    }
  };
  const more = async (parent: Iri, cursor: string) => {
    const mine = pool.current;
    try {
      const page = await ask(parent, { cursor });
      if (pool.current !== mine || !mine.branches.has(parent)) return;
      put(mine, parent, page);
      // A list read further from its start is read as far again after an edit elsewhere.
      const first = mine.branches.get(parent)!.parts[0];
      if (!filter && first.offset === 0) grown.current.set(parent, first.nodes.length);
      show(mine);
    } catch (e) {
      failed(e);
    }
  };

  // The arrow keys move through the lines; the property the keyboard is on is the property in focus.
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const stops = lines.map((line, index) => ({ line, index })).filter((x) => x.line.kind === 'class' || x.line.kind === 'more');
    if (!stops.length) return;
    const at = stops.findIndex((x) => keyOf(x.line) === cursor);
    const here = at < 0 ? undefined : stops[at].line;
    const pressed = (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget;
    let next = at;
    if (e.key === 'ArrowDown') next = Math.min(stops.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = stops.length - 1;
    else if (e.key === 'ArrowRight' && here?.kind === 'class') {
      if (here.expandable && !here.open) toggle(here.place);
      else if (here.open) next = Math.min(stops.length - 1, at + 1);
    } else if (e.key === 'ArrowLeft' && here?.kind === 'class') {
      if (here.open) toggle(here.place);
      else {
        // To the property this one is under here: the nearest line above that is less deep.
        for (let i = at - 1; i >= 0; i--) {
          const up = stops[i].line;
          if (up.kind !== 'class' || up.depth >= here.depth) continue;
          next = i;
          break;
        }
      }
    } else if (pressed && here?.kind === 'more') void more(here.parent, here.cursor);
    else if (!pressed) return;
    e.preventDefault();
    const stop = stops[Math.max(0, next)];
    setCursor(keyOf(stop.line));
    reach(stop.index);
    if (stop.line.kind === 'class') st().setStructure({ focus: stop.line.node.property.iri });
  };

  const indent = (depth: number) => 4 + Math.min(depth, INDENT_LEVELS) * 18;
  const onShow = cursor && lines.slice(from, to).some((l) => keyOf(l) === cursor) ? `st-line-${cursor}` : undefined;
  return (
    <>
      <div className="st-bar">
        <input type="search" value={search} placeholder="Search by name, label or IRI" aria-label="Search the properties" onChange={(e) => st().setStructure({ search: e.target.value })} />
        <p className="muted st-status" role="status">
          {filter && !stale && shown.matched !== undefined
            ? `${shown.matched} ${shown.matched === 1 ? 'property matches' : 'properties match'} “${filter}”, shown with the ${shown.matched === 1 ? 'property it is' : 'properties they are'} under.`
            : 'Every property under each superproperty stated for it. Nothing here changes the ontology.'}
          {cut && ` Opened as far as ${EXPANDS_TO.toLocaleString('en')} lines; open further branches one at a time${filter ? ', or search for less' : ''}.`}
        </p>
        <button className="btn small" onClick={() => void expandAll()}>
          Expand all
        </button>
        <button
          className="btn small"
          onClick={() => {
            setCut(false);
            setOpen(new Set());
          }}
        >
          Collapse all
        </button>
      </div>

      {error && (
        <p className="bad pad" role="alert">
          The property hierarchy could not be read: {error}
        </p>
      )}
      <div className="st-body">
        <div className="tree-wrap" ref={wrap} onScroll={measure}>
          <ul
            className="tree"
            role="tree"
            tabIndex={0}
            aria-label="Property hierarchy"
            aria-busy={stale}
            aria-activedescendant={onShow}
            data-lines={top ? lines.length : 0}
            onKeyDown={onKey}
            onFocus={(e) => {
              // Arriving by the keyboard, it starts on the property in focus, or else at the top.
              if (e.target !== e.currentTarget || cursor) return;
              const start = lines.find((l) => l.kind === 'class' && inFocus(l.node)) ?? lines.find((l) => l.kind === 'class');
              if (start) setCursor(keyOf(start));
            }}
          >
            {top && from > 0 && <li role="none" style={{ height: from * ROW }} />}
            {top &&
              lines.slice(from, to).map((line) =>
                line.kind === 'root' ? (
                  <li key="root" className="tree-row st-root" role="treeitem" aria-level={1} aria-expanded={true} aria-selected={false}>
                    <span className="st-root-name" title="The top of the property hierarchy: every property with no stated superproperty is directly below it">
                      Properties
                    </span>
                    <span className="count" title={`${top.total} directly below it`}>
                      {top.total}
                    </span>
                  </li>
                ) : line.kind === 'class' ? (
                  <Row
                    key={keyOf(line)}
                    id={`st-line-${keyOf(line)}`}
                    place={line.place}
                    node={line.node}
                    depth={line.depth}
                    pad={indent(line.depth)}
                    expandable={line.expandable}
                    open={line.open}
                    repeat={line.repeat}
                    focused={inFocus(line.node)}
                    cursor={keyOf(line) === cursor}
                    onToggle={toggle}
                    onChoose={choose}
                  />
                ) : line.kind === 'more' ? (
                  <li key={keyOf(line)} id={`st-line-${keyOf(line)}`} className={'st-more' + (keyOf(line) === cursor ? ' cursor' : '')} role="none" style={{ paddingLeft: indent(line.depth) + 30 }}>
                    <button className="btn small" tabIndex={-1} onClick={() => void more(line.parent, line.cursor)}>
                      Show more
                    </button>
                    <span className="muted">
                      {line.hidden.toLocaleString('en')} of {line.total.toLocaleString('en')} not shown here
                    </span>
                  </li>
                ) : (
                  <li key={keyOf(line)} className="st-wait" role="none" style={{ paddingLeft: indent(line.depth) + 30 }}>
                    <span>Loading…</span>
                  </li>
                ),
              )}
            {top && to < lines.length && <li role="none" style={{ height: (lines.length - to) * ROW }} />}
          </ul>
          {top && !top.total && !stale && <p className="muted pad">{filter ? `Nothing in the hierarchy matches “${filter}”.` : 'No properties yet.'}</p>}
        </div>
        <PropertySummaryAside host={host} focus={focus} about={current} onGo={go} onWay={(way) => go(way[way.length - 1].iri, way)} />
      </div>
    </>
  );
}

interface RowProps {
  id: string;
  place: number;
  node: PropertyHierarchyNode;
  depth: number;
  pad: number;
  expandable: boolean;
  open: boolean;
  repeat: boolean;
  focused: boolean;
  /** The keyboard is on this line. */
  cursor: boolean;
  onToggle: (place: number) => void;
  onChoose: (iri: Iri, place: number) => void;
}

/** One line of the hierarchy: a property in one of its places. Memoised, so choosing a property redraws the lines it changes, not all of them. */
const Row = memo(function Row({ id, place, node, depth, pad, expandable, open, repeat, focused, cursor, onToggle, onChoose }: RowProps) {
  const { iri, label, type, external } = node.property;
  const classes = ['tree-row', focused && 'on', cursor && 'cursor'].filter(Boolean).join(' ');
  return (
    <li id={id} role="treeitem" aria-level={depth + 2} aria-expanded={expandable ? open : undefined} aria-selected={focused} className={classes} style={{ paddingLeft: pad }} data-place={place}>
      {expandable ? (
        <button className="twisty" tabIndex={-1} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`} onClick={() => onToggle(place)}>
          <Disclosure open={open} />
        </button>
      ) : (
        <span className="twisty" />
      )}
      <button className={'tree-name' + (node.match ? ' match' : '')} tabIndex={-1} title={iri} onClick={() => onChoose(iri, place)}>
        <span className={'dot property ' + type} />
        {label}
      </button>
      <span className="tag kind" data-kind={type} title={type === 'object' ? 'An object property: its values are individuals' : 'A data property: its values are literals'}>
        {type}
      </span>
      {node.parentCount > 1 && (
        <span className="tag" title={`It is under ${node.parentCount} stated superproperties and is listed under each of them. It is one property, shown in ${node.parentCount} places.`}>
          {node.parentCount} superproperties
        </span>
      )}
      {node.inCycle && (
        <span className="tag warn" title={repeat ? 'It is one of its own superproperties here. The branch is not followed a second time.' : 'It is one of a group of properties that are each other’s superproperties.'}>
          cycle
        </span>
      )}
      {external && (
        <span className="tag auto" title="A property of another ontology, referred to here under its own IRI">
          ext
        </span>
      )}
      {node.childCount > 0 && (
        <span className="count" title={`${node.childCount} direct subproperties`}>
          {node.childCount}
        </span>
      )}
    </li>
  );
});

interface AsideProps {
  host: StructureHost;
  focus: Iri | null;
  /** What the service said of the property in focus. Not there yet for a property that has only just been chosen. */
  about: { iri: Iri; summary: PropertySummary; ways: PropertyRef[][] } | null;
  /** Brings another property into focus and into view. */
  onGo: (iri: Iri) => void;
  /** Brings one of the places of the property in focus into view: the one this way down leads to. */
  onWay: (way: PropertyRef[]) => void;
}

/** Where the property in focus stands in the stated hierarchy, at a glance. Nothing here is edited. */
function PropertySummaryAside({ host, focus, about, onGo, onWay }: AsideProps) {
  if (!focus) {
    return (
      <aside className="st-summary" aria-label="The property in focus">
        <p className="st-focus muted">Choose a property to see where it stands and to open it in Entities. Choosing one here does not select it.</p>
      </aside>
    );
  }
  if (!about) {
    return (
      <aside className="st-summary" aria-label="The property in focus">
        <p className="muted">Reading the property…</p>
      </aside>
    );
  }
  const { property, superproperties, subpropertyCount, descendantCount, inCycle } = about.summary;
  return (
    <aside className="st-summary" aria-label="The property in focus">
      <div className="st-focus">
        <span className={'dot property ' + property.type} />
        <strong className="name">{property.label}</strong>
        <IriCell iri={property.iri} of={property.label} />
        <div className="row">
          <button className="btn small" title="Open it in Entities, where it is edited" onClick={() => host.openInEntities(property.iri)}>
            Open in Entities
          </button>
        </div>
      </div>

      <section>
        <h3>Superproperties</h3>
        <dl className="st-facts">
          <dt>Stated</dt>
          <dd>
            {superproperties.length ? (
              superproperties.map((p, i) => (
                <Fragment key={p.iri}>
                  {i > 0 && ', '}
                  <button className="link" title={p.iri} onClick={() => onGo(p.iri)}>
                    {p.label}
                  </button>
                </Fragment>
              ))
            ) : (
              <span className="muted">none: directly under Properties</span>
            )}
          </dd>
          <dt>Kind</dt>
          <dd>
            {property.type === 'object' ? 'Object property: its values are individuals' : 'Data property: its values are literals'}
            {property.external && <small>Defined in another ontology and referred to here under its own IRI.</small>}
          </dd>
        </dl>
      </section>

      <section>
        <h3>Subproperties</h3>
        <dl className="st-facts">
          <dt>Direct</dt>
          <dd>{subpropertyCount.toLocaleString('en')}</dd>
          <dt>Below it</dt>
          <dd>{descendantCount.toLocaleString('en')} at any depth</dd>
          {inCycle && (
            <>
              <dt>Cycle</dt>
              <dd>One of a group of properties that are each other’s superproperties.</dd>
            </>
          )}
        </dl>
        {about.ways.length > 0 && (
          <>
            <h4>
              {about.ways.length === 1 ? 'The way' : `${about.ways.length} ways`} down to it from Properties
            </h4>
            <ul className="st-ways">
              {about.ways.map((way) => (
                <li key={way.map((p) => p.iri).join(' ')}>
                  <button title="Show this place in the hierarchy" onClick={() => onWay(way)}>
                    {way.map((p, i) => (
                      <Fragment key={p.iri}>
                        {i > 0 && <span aria-hidden="true"> › </span>}
                        <span className={i === way.length - 1 ? 'last' : ''}>{p.label}</span>
                      </Fragment>
                    ))}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </aside>
  );
}
