import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { configOf } from '../model/modelTypes';
import { useStore } from '../model/store';
import { StructureError, type ClassRef, type HierarchyMode, type HierarchyNode, type HierarchyPage, type Iri, type Provenance } from '../structure/contracts';
import { holds, openWide, Places, ROOT, rowsOf, TOP, wanting, withPage, type Branch, type OutlineRow } from '../structure/outline';
import { Disclosure } from './Icon';
import type { StructureHost } from './Structure';
import { noAnswer, plural, reasonerName, StructureSummary, type About } from './StructureSummary';

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

/** Which places are open in each hierarchy, for the model in the editor. Kept outside the component so that it survives switching views. */
let remembered: { seq: number; places: Places; open: Record<HierarchyMode, Set<number> | null> } | undefined;

/** What has been fetched of one hierarchy: `base` says which revision, hierarchy, search and reasoner's answer it is of. */
interface Fetched {
  base: string;
  branches: Map<string, Branch>;
  /** Goes up with every change, so that what is on show is only replaced when there is something new. */
  version: number;
  /** With a search: how many classes it finds. */
  matched?: number;
  /** Where the hierarchy comes from, as the service said with the classes at the top. */
  provenance?: Provenance;
}

/** A line of the list: the top, a class in one of its places, a stretch of a list that is not fetched, or a branch that is being fetched. */
type Line = { kind: 'root' } | OutlineRow | { kind: 'wait'; place: number; depth: number };
const keyOf = (line: Line) => (line.kind === 'root' ? 'root' : line.kind === 'class' ? `c${line.place}` : line.kind === 'more' ? `m${line.place}-${line.offset}` : `w${line.place}`);

/**
 * The hierarchy to look through: the asserted one, or the one a reasoner entails. Branches are
 * fetched as they are opened and only the lines in view are drawn. A class is brought into
 * focus by choosing it; that selects nothing, and what is then said of it beside the hierarchy
 * leads on to where it is edited and where it is drawn.
 */
export function StructureExplore({ host, mode }: { host: StructureHost; mode: HierarchyMode }) {
  const { service, ontology } = host;
  const config = useStore((s) => configOf(s.model));
  const docSeq = useStore((s) => s.docSeq);
  const focus = useStore((s) => s.structure.focus);
  const pointed = useStore((s) => s.structure.pointed);
  const search = useStore((s) => s.structure.search);
  const marking = useStore((s) => s.structure.markInferred);
  const st = useStore.getState;
  const one = config.termType.concept.label.toLowerCase();
  const many = config.termType.concept.plural.toLowerCase();
  const inferred = mode === 'inferred';
  const reasoningKey = inferred ? (host.reasoning?.key ?? '') : '';

  // The search is asked a moment after the typing stops: each one is a question to the service.
  const [filter, setFilter] = useState(search.trim());
  useEffect(() => {
    const id = setTimeout(() => setFilter(search.trim()), search.trim() ? 160 : 0);
    return () => clearTimeout(id);
  }, [search]);

  const kept = useMemo(() => {
    if (remembered?.seq !== docSeq) remembered = { seq: docSeq, places: new Places(), open: { asserted: null, inferred: null } };
    return remembered;
  }, [docSeq]);
  const places = kept.places;
  const [ownOpen, setOwnOpen] = useState<Set<number>>(() => kept.open[mode] ?? new Set());
  // A search opens what it finds, and leaves what was open before as it was for when it is over.
  const [found, setFound] = useState<{ base: string; open: Set<number> }>({ base: '', open: new Set() });
  const open = filter ? found.open : ownOpen;
  const setOpen = (next: Set<number>) => {
    if (filter) return setFound((f) => ({ ...f, open: next }));
    kept.open[mode] = next;
    setOwnOpen(next);
  };

  const base = `${ontology.ontologyId}\n${ontology.revisionId}\n${mode}\n${filter}\n${reasoningKey}`;
  // `pool` fills as answers come in; `shown` is what is drawn, and stays until what replaces it is all there.
  const pool = useRef<Fetched>({ base: '', branches: new Map(), version: 0 });
  const [shown, setShown] = useState<Fetched>(pool.current);
  const [error, setError] = useState<string>();
  /** Expand all, or a search, stopped at its number of lines with branches still closed. */
  const [cut, setCut] = useState(false);
  /** Lists that were made longer with Show more, so that an edit elsewhere does not shorten them again. */
  const grown = useRef(new Map<Iri, number>());
  /** A class to be brought into view: one pointed at from outside or, on arriving here, the one in focus. With a way down, by that way. */
  const toReveal = useRef<{ iri: Iri; way?: ClassRef[] } | null>(focus && !search.trim() ? { iri: focus } : null);
  const [asked, setAsked] = useState(0);
  const scrollTo = useRef<number | null>(null);
  /** The line the keyboard is on. */
  const [cursor, setCursor] = useState<string | null>(null);
  /** Whether what the reasoner left out or took loosely is spelled out under its name. */
  const [why, setWhy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const ask = useCallback(
    (parent: Iri, extra: { cursor?: string; through?: Iri; limit?: number } = {}, signal?: AbortSignal) =>
      service.children({ ...ontology, mode, ...(parent === TOP ? {} : { parentIri: parent }), ...(filter ? { filter } : {}), ...extra }, { signal }),
    [service, ontology, mode, filter],
  );
  /** The first page of the subclasses of several classes, asked for together: one question for a level, not one for each branch. */
  const askMany = useCallback(
    async (parents: { iri: Iri; through?: Iri; limit?: number }[], signal?: AbortSignal): Promise<HierarchyPage[]> => {
      const pages: HierarchyPage[] = [];
      for (let i = 0; i < parents.length; i += BATCH) {
        const some = parents.slice(i, i + BATCH).map(({ iri, ...rest }) => ({ ...(iri === TOP ? {} : { parentIri: iri }), ...rest }));
        pages.push(...(await service.branches({ ...ontology, mode, ...(filter ? { filter } : {}), parents: some }, { signal })));
      }
      return pages;
    },
    [service, ontology, mode, filter],
  );
  const put = (to: Fetched, parent: Iri, page: HierarchyPage) => {
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
    setError(e instanceof Error ? e.message : 'The hierarchy could not be read.');
  };

  const firstPointed = useRef(pointed);
  useEffect(() => {
    if (firstPointed.current === pointed) return;
    firstPointed.current = pointed;
    const iri = st().structure.focus;
    toReveal.current = iri ? { iri } : null;
    // Pointing at a class from elsewhere asks to see that class, whatever was being searched for.
    if (st().structure.search) st().setStructure({ search: '' });
  }, [pointed, st]);

  // Brings what is fetched up to what is to be drawn: the top, and the subclasses of every open place.
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
          const wide = await openWide(mine.branches, places, fetch, EXPANDS_TO);
          if (signal.aborted) return;
          wanted = wide.open;
          setFound({ base, open: wide.open });
          setCut(wide.cut);
        } else if (!filter && kept.open[mode] === null) {
          const wide = await openWide(mine.branches, places, fetch, OPENS_TO);
          if (signal.aborted) return;
          // A hierarchy that is not to be had (a reasoner without an answer) is not taken for one with nothing open.
          if (mine.provenance?.status === 'current') kept.open[mode] = wide.open;
          wanted = wide.open;
          setOwnOpen(wide.open);
        }
        if (!filter && toReveal.current) {
          const want = toReveal.current;
          try {
            const way = want.way ?? (await service.paths({ ...ontology, mode, classIri: want.iri, limit: 1 }, { signal })).paths[0] ?? [];
            if (signal.aborted) return;
            const next = new Set(wanted);
            let place = ROOT;
            // Of a long list, the page the class is on is fetched, not all that comes before it; and the whole way in one question.
            const steps = way.map((step, i) => ({ iri: i ? way[i - 1].iri : TOP, through: step.iri }));
            const missing = steps.filter((x) => !holds(mine.branches.get(x.iri), x.through));
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
              wanted = kept.open[mode] = next;
              setOwnOpen(next);
            }
          } catch (e) {
            if (signal.aborted) return;
            if (!(e instanceof StructureError && e.code === 'not-found')) throw e;
            // The class that was to be shown is not in the ontology any more (it was deleted, or its
            // adding undone). The hierarchy is shown all the same, without a class in focus.
            toReveal.current = null;
            st().setStructure({ focus: null });
          }
        }
        for (;;) {
          const need = wanting(mine.branches, places, wanted);
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

  const seen = focus ? host.look(focus) : null;
  // The class in focus was deleted, or given another IRI, which makes it another entity.
  useEffect(() => {
    if (focus && !seen) st().setStructure({ focus: null });
  }, [focus, seen, st]);

  // What there is to say of the class in focus, asked again whenever the ontology or the reasoner's answer changes.
  const [about, setAbout] = useState<About | null>(null);
  const aboutKey = host.reasoning?.key ?? '';
  useEffect(() => {
    if (!focus) return setAbout(null);
    const abort = new AbortController();
    void (async () => {
      try {
        const [summary, ways] = await Promise.all([service.summary({ ...ontology, classIri: focus, mode }, { signal: abort.signal }), service.paths({ ...ontology, mode, classIri: focus, limit: 12 }, { signal: abort.signal })]);
        if (!abort.signal.aborted) setAbout({ iri: focus, summary, ways });
      } catch (e) {
        if (!abort.signal.aborted && !(e instanceof StructureError && e.code === 'not-found')) failed(e);
      }
    })();
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, service, ontology, mode, aboutKey]);
  const current = about && about.iri === focus ? about : null;

  const rows = useMemo(() => rowsOf(shown.branches, places, open), [shown, places, open]);
  // The class in focus is one class in every place it has; in the inferred hierarchy it may share its place with others.
  const inFocus = useCallback((node: HierarchyNode) => !!focus && (node.class.iri === focus || (inferred && node.equivalents.some((e) => e.iri === focus))), [focus, inferred]);
  const above = useMemo(() => new Set(current?.summary.position?.mode === mode ? current.summary.position.ancestors : []), [current, mode]);
  // The lines, and with them the classes that are on show below the class in focus, in whichever of their places.
  const { lines, below } = useMemo(() => {
    const lines: Line[] = [{ kind: 'root' }];
    const below = new Set<Iri>();
    let under: number | null = null;
    for (const row of rows) {
      if (under !== null && row.depth <= under) under = null;
      if (row.kind === 'class') {
        if (under !== null) below.add(row.node.class.iri);
        else if (inFocus(row.node)) under = row.depth;
      }
      lines.push(row);
      if (row.kind === 'class' && row.loading) lines.push({ kind: 'wait', place: row.place, depth: row.depth + 1 });
    }
    return { lines, below };
  }, [rows, inFocus]);
  const top: Branch | undefined = shown.branches.get(TOP);
  const stale = shown.base !== base;
  const provenance = shown.provenance;
  // The inferred hierarchy, when the reasoner in use has no answer to build it from.
  const none = inferred && !stale && provenance && provenance.status !== 'current' ? provenance : null;

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
  // A class that was brought into view is scrolled to once its line is there.
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
  /** Brings a class into focus and into view, from what is said beside the hierarchy: by one way down, where one is given. */
  const go = (iri: Iri, way?: ClassRef[]) => {
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

  // The arrow keys move through the lines; the class the keyboard is on is the class in focus.
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
        // To the class this one is under here: the nearest line above that is less deep.
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
    if (stop.line.kind === 'class' && !stop.line.node.class.builtin) st().setStructure({ focus: stop.line.node.class.iri });
  };

  const indent = (depth: number) => 4 + Math.min(depth, INDENT_LEVELS) * 18;
  const parents = plural(config.hierarchy.parent);
  const children = plural(config.hierarchy.child);
  const onShow = cursor && lines.slice(from, to).some((l) => keyOf(l) === cursor) ? `st-line-${cursor}` : undefined;
  return (
    <>
      <div className="st-bar">
        <input type="search" value={search} placeholder="Search by name, label or IRI" aria-label="Search the hierarchy" onChange={(e) => st().setStructure({ search: e.target.value })} />
        <p className="muted st-status" role="status">
          {filter && !stale && shown.matched !== undefined
            ? `${shown.matched} ${shown.matched === 1 ? `${one} matches` : `${many} match`} “${filter}”, shown with what ${shown.matched === 1 ? 'it is' : 'they are'} under.`
            : inferred
              ? `Every ${one} under the ${many} directly above it, as the reasoner entails it. Nothing here changes the ontology.`
              : `Every ${one} under each ${config.hierarchy.parent} stated for it. Nothing here changes the ${config.id === 'skos' ? 'vocabulary' : 'ontology'}.`}
          {cut && ` Opened as far as ${EXPANDS_TO.toLocaleString('en')} lines; open further branches one at a time${filter ? ', or search for less' : ''}.`}
        </p>
        <button className="btn small" disabled={!!none} onClick={() => void expandAll()}>
          Expand all
        </button>
        <button
          className="btn small"
          disabled={!!none}
          onClick={() => {
            setCut(false);
            setOpen(new Set());
          }}
        >
          Collapse all
        </button>
      </div>

      {inferred && host.reasoning && (
        <div className="st-reasoner">
          <label>
            <span>Reasoner</span>
            <select aria-label="Reasoner" value={host.reasoning.engine} disabled={host.reasoning.running} title={host.reasoning.engines.find((x) => x.id === host.reasoning!.engine)?.about} onChange={(e) => host.chooseReasoner(e.target.value)}>
              {host.reasoning.engines.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <span className={'st-prov ' + (provenance?.status ?? '')} role="status" title={provenance?.notes.join('\n')}>
            {host.reasoning.running
              ? host.reasoning.phase || 'Reasoning…'
              : !provenance || stale
                ? ''
                : provenance.status === 'current'
                  ? `${reasonerName(provenance)} · ${provenance.completeness === 'complete' ? 'complete' : 'may be incomplete'} · of the ontology as it is now`
                  : provenance.status === 'stale'
                    ? `${reasonerName(provenance)} · its answer is out of date`
                    : provenance.status === 'inconsistent'
                      ? `${reasonerName(provenance)} · the ontology is inconsistent`
                      : provenance.status === 'failed'
                        ? `${reasonerName(provenance)} · no answer`
                        : `${reasonerName(provenance)} · not asked yet`}
            {!host.reasoning.running && !stale && provenance && provenance.notes.length > 0 && (
              <>
                {' '}
                <button className="link" aria-expanded={why} onClick={() => setWhy(!why)}>
                  {why ? 'hide why' : 'why'}
                </button>
              </>
            )}
          </span>
          {host.reasoning.asked && (
            <button className="btn small" disabled={host.reasoning.running} onClick={host.runReasoning}>
              Run reasoning
            </button>
          )}
          <label className="check" title="Marks each place that is entailed and nowhere stated: a class under a superclass the reasoner worked out.">
            <input type="checkbox" checked={marking} onChange={(e) => st().setStructure({ markInferred: e.target.checked })} />
            <span>Mark what is only inferred</span>
          </label>
          {why && !stale && provenance && provenance.notes.length > 0 && (
            <ul className="st-notes">
              {provenance.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p className="bad pad" role="alert">
          The hierarchy could not be read: {error}
        </p>
      )}
      <div className="st-body">
        <div className="tree-wrap" ref={wrap} onScroll={measure}>
          {none ? (
            <div className="st-none" role="status">
              <p>
                <strong>There is no inferred hierarchy to show.</strong> {noAnswer(none)}
              </p>
              {none.notes.length > 0 && none.status === 'failed' && <p className="muted">{none.notes.join(' ')}</p>}
              <p className="muted">Nothing is put in its place: the asserted hierarchy is not shown as if it were the inferred one, and one reasoner’s answer is not filled in with another’s.</p>
              <div className="row wrap">
                {none.status !== 'inconsistent' && host.reasoning?.asked && (
                  <button className="btn small primary" disabled={host.reasoning.running} onClick={host.runReasoning}>
                    {host.reasoning.running ? 'Reasoning…' : 'Run reasoning'}
                  </button>
                )}
                {(none.status === 'inconsistent' || none.status === 'failed') && (
                  <button className="btn small" onClick={() => host.openValidation()}>
                    Open Validation
                  </button>
                )}
                <button className="btn small" onClick={() => st().setStructure({ hierarchy: 'asserted' })}>
                  Show the asserted hierarchy
                </button>
              </div>
            </div>
          ) : (
            <>
              <ul
                className={'tree' + (inferred && marking ? ' marking' : '')}
                role="tree"
                tabIndex={0}
                aria-label={`${config.termType.concept.label} hierarchy, ${mode}`}
                aria-busy={stale}
                aria-activedescendant={onShow}
                data-lines={top ? lines.length : 0}
                onKeyDown={onKey}
                onFocus={(e) => {
                  // Arriving by the keyboard, it starts on the class in focus, or else at the top.
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
                        <span className="st-root-name" title={`The top of the hierarchy: every ${one} with no ${config.hierarchy.parent} is directly below it`}>
                          {config.hierarchy.root}
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
                        way={above.has(line.node.class.iri) ? 'above' : below.has(line.node.class.iri) ? 'below' : ''}
                        color={host.look(line.node.class.iri)?.color ?? 'default'}
                        inferred={inferred}
                        above={parents}
                        below={children}
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
              {top && !top.total && !stale && <p className="muted pad">{filter ? `Nothing in the hierarchy matches “${filter}”.` : `No ${many} yet.`}</p>}
            </>
          )}
        </div>
        <StructureSummary host={host} config={config} mode={mode} focus={focus} about={current} onGo={(iri) => go(iri)}
          onWay={(way) => go(way[way.length - 1].iri, way)}
          onCompare={(iri) => {
            // It takes the first place; whatever was in the second stays, unless that is the same class.
            const other = st().structure.compare.b;
            st().setStructure({ mode: 'compare', compare: { a: iri, b: other === iri ? null : other } });
          }}
        />
      </div>
    </>
  );
}

interface RowProps {
  id: string;
  place: number;
  node: HierarchyNode;
  depth: number;
  pad: number;
  expandable: boolean;
  open: boolean;
  repeat: boolean;
  focused: boolean;
  /** The keyboard is on this line. */
  cursor: boolean;
  /** Where it stands to the class in focus: above it, below it, or neither. */
  way: 'above' | 'below' | '';
  color: string;
  /** The line is of the inferred hierarchy, where what it says is entailed rather than stated. */
  inferred: boolean;
  /** What the classes above and below a class are called in this type of model: superclasses and subclasses, or broader and narrower concepts. */
  above: string;
  below: string;
  onToggle: (place: number) => void;
  onChoose: (iri: Iri, place: number) => void;
}

/** One line of the hierarchy: a class in one of its places. Memoised, so choosing a class redraws the lines it changes, not all of them. */
const Row = memo(function Row({ id, place, node, depth, pad, expandable, open, repeat, focused, cursor, way, color, inferred, above, below, onToggle, onChoose }: RowProps) {
  const { iri, label, external, builtin } = node.class;
  const classes = ['tree-row', focused && 'on', cursor && 'cursor', way, node.entailedOnly && 'entailed', node.unsatisfiable && 'unsat'].filter(Boolean).join(' ');
  return (
    <li id={id} role="treeitem" aria-level={depth + 2} aria-expanded={expandable ? open : undefined} aria-selected={focused} className={classes} style={{ paddingLeft: pad }} data-place={place}>
      {expandable ? (
        <button className="twisty" tabIndex={-1} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`} onClick={() => onToggle(place)}>
          <Disclosure open={open} />
        </button>
      ) : (
        <span className="twisty" />
      )}
      {builtin ? (
        <span className="st-root-name" title="The class that has no instances. The classes below it can have none either: each is equivalent to it.">
          {label}
        </span>
      ) : (
        <button className={'tree-name' + (node.match ? ' match' : '')} tabIndex={-1} title={iri} onClick={() => onChoose(iri, place)}>
          <span className="dot concept" style={{ background: `var(--nc-${color}-fill)`, borderColor: `var(--nc-${color}-stroke)` }} />
          {label}
        </button>
      )}
      {node.equivalents.length > 0 && (
        <span className="tag" title={inferred ? 'Entailed to be equivalent. They are one place in the inferred hierarchy.' : 'Stated to be equivalent (owl:equivalentClass). Each is listed in its own place.'}>
          ≡ {node.equivalents.map((e) => e.label).join(', ')}
        </span>
      )}
      {node.unsatisfiable && (
        <span className="tag warn" title="It can never have an instance: it is equivalent to owl:Nothing.">
          unsatisfiable
        </span>
      )}
      {node.entailedOnly && !node.unsatisfiable && (
        <span className="tag inferred" title={`Its place here is entailed and nowhere stated: the reasoner worked out that it is under this one of its ${above}.`}>
          inferred
        </span>
      )}
      {node.parentCount > 1 && (
        <span className="tag" title={`It has ${node.parentCount} ${inferred ? 'direct' : 'stated'} ${above} and is listed under each of them. It is one entity, shown in ${node.parentCount} places.`}>
          {node.parentCount} {above}
        </span>
      )}
      {node.inCycle && (
        <span className="tag warn" title={repeat ? `It is one of its own ${above} here. The branch is not followed a second time.` : `It is one of a group that are each other’s ${above}.`}>
          cycle
        </span>
      )}
      {external && (
        <span className="tag auto" title="An entity of another ontology, referred to here under its own IRI">
          ext
        </span>
      )}
      {node.childCount > 0 && (
        <span className="count" title={`${node.childCount} direct ${below}`}>
          {node.childCount}
        </span>
      )}
    </li>
  );
});
