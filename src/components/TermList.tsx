import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { definedClasses } from '../model/axioms';
import { nameIn } from '../model/labels';
import { compactIri } from '../model/prefixes';
import { stable } from '../model/stable';
import { SIDEBAR_WIDTH, useStore } from '../model/store';
import { ancestorsOf, classTree, defaultOpen, matchingClasses, ROOT, treeRows } from '../model/tree';
import type { Term, TermType } from '../model/types';
import { Disclosure, Icon } from './Icon';
import { configOf } from '../model/modelTypes';

/** Which classes are expanded. Kept outside the component so that it survives switching views. */
let remembered: { seq: number; open: Set<string> } | undefined;
/** Which of its lists the sidebar shows. Kept here for the same reason: folded away and opened again, it is where it was. */
let rememberedType: TermType = 'concept';

/**
 * The left sidebar, or the strip that is left of it when it is folded away to make room for the
 * canvas or a table. Folded away it does no work at all: the hierarchy is not built until it is opened.
 */
export function TermList() {
  const hidden = useStore((s) => s.sidebarHidden);
  const aside = useRef<HTMLElement>(null);
  if (hidden) return <SidebarRail />;
  return (
    <>
      <TermListOpen asideRef={aside} />
      <SidebarResizer asideRef={aside} />
    </>
  );
}

/**
 * Makes a change that moves the left edge of the canvas, and keeps the graph where it is on the
 * screen meanwhile: room the sidebar gives up or takes is room at that edge, not a push sideways.
 */
function holdingGraph(change: () => void) {
  const stage = document.querySelector('.stage');
  const before = stage?.getBoundingClientRect().left;
  change();
  const after = stage?.getBoundingClientRect().left;
  if (before === undefined || after === undefined || before === after) return;
  const { vp, setVp } = useStore.getState();
  setVp({ ...vp, x: vp.x + before - after });
}

/** Folds the sidebar away, or opens it. */
const showSidebar = (shown: boolean) => holdingGraph(() => flushSync(() => useStore.getState().setSidebarHidden(!shown)));

/** The widest the sidebar can be in this window: it never takes more than half of it. */
const widest = () => Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.round(window.innerWidth / 2)));

/**
 * The edge between the sidebar and the rest. Dragged, it makes the sidebar wider or narrower;
 * double-clicked, as wide as its longest name. With the keyboard: the arrow keys, Home and End, and Enter to fit.
 */
function SidebarResizer({ asideRef }: { asideRef: RefObject<HTMLElement | null> }) {
  const width = useStore((s) => s.sidebarWidth);
  const [dragging, setDragging] = useState(false);
  const from = useRef<{ x: number; width: number } | null>(null);
  // While the edge is dragged the width is put on the element itself. The store is told when it is
  // let go, so the lists are drawn again once and not at every step.
  const show = (to: number): number => {
    const w = Math.round(Math.min(widest(), Math.max(SIDEBAR_WIDTH.min, to)));
    const el = asideRef.current;
    if (el) holdingGraph(() => (el.style.width = `${w}px`));
    return w;
  };
  const set = (to: number) => useStore.getState().setSidebarWidth(show(to));
  const now = () => asideRef.current?.getBoundingClientRect().width ?? width;
  const fit = () => {
    const el = asideRef.current;
    if (!el) return;
    const left = el.getBoundingClientRect().left;
    let need = 0;
    // A name that is cut short still knows how long it is.
    for (const name of el.querySelectorAll<HTMLElement>('li .name')) {
      const tags = [...(name.parentElement?.querySelectorAll<HTMLElement>('.tag') ?? [])].reduce((sum, t) => sum + t.offsetWidth + 8, 0);
      need = Math.max(need, name.getBoundingClientRect().left - left + name.scrollWidth + tags);
    }
    // The top of the tree fills its line, so it is its words that are measured.
    for (const root of el.querySelectorAll<HTMLElement>('li .label.root')) {
      const words = document.createRange();
      words.selectNodeContents(root);
      need = Math.max(need, words.getBoundingClientRect().right - left);
    }
    const list = el.querySelector('ul');
    if (need) set(Math.ceil(need) + 18 + (list ? list.offsetWidth - list.clientWidth : 0));
  };
  return (
    <div
      className={'sidebar-resizer' + (dragging ? ' dragging' : '')}
      role="separator"
      aria-orientation="vertical"
      aria-label="Width of the sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0}
      title="Drag to make the sidebar wider or narrower. Double-click to fit it to the names."
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        from.current = { x: e.clientX, width: now() };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (from.current) show(from.current.width + e.clientX - from.current.x);
      }}
      onPointerUp={(e) => {
        if (!from.current) return;
        set(from.current.width + e.clientX - from.current.x);
        from.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        if (!from.current) return;
        set(now());
        from.current = null;
        setDragging(false);
      }}
      onDoubleClick={fit}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') set(now() - step);
        else if (e.key === 'ArrowRight') set(now() + step);
        else if (e.key === 'Home') set(SIDEBAR_WIDTH.min);
        else if (e.key === 'End') set(SIDEBAR_WIDTH.max);
        else if (e.key === 'Enter') fit();
        else return;
        e.preventDefault();
      }}
    />
  );
}

function SidebarRail() {
  const skos = useStore((s) => s.model.mode === 'skos');
  // A search goes on dimming the canvas while the box it was typed in is out of sight; the strip says so.
  const filter = useStore((s) => s.filter.trim());
  const title = `Show the sidebar: the hierarchy and the lists of ${skos ? 'concepts' : 'entities'}` + (filter ? `. A search is on: “${filter}”` : '');
  return (
    <aside className="panel term-list rail">
      <button className="rail-open" title={title} aria-label="Show the sidebar" aria-expanded={false} onClick={() => showSidebar(true)}>
        <Icon name="sidebarOpen" />
        <span aria-hidden="true">{skos ? 'Concepts' : 'Entities'}</span>
        {filter && <span className="rail-mark" role="img" aria-label="A search is on" />}
      </button>
    </aside>
  );
}

/**
 * The sidebar itself: the class hierarchy as a collapsible tree under owl:Thing, with search, and
 * plain lists of the data properties and individuals behind the other two tabs.
 */
function TermListOpen({ asideRef }: { asideRef: RefObject<HTMLElement | null> }) {
  const width = useStore((s) => s.sidebarWidth);
  // Names, colours and the hierarchy do not change while terms are dragged about, so neither does this.
  const model = stable(useStore((s) => s.model));
  const displayLang = useStore((s) => s.displayLang);
  const selected = useStore((s) => s.sel.terms);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const docSeq = useStore((s) => s.docSeq);
  const config = configOf(model);
  const [wanted, setWanted] = useState<TermType>(rememberedType);
  const setType = (t: TermType) => {
    rememberedType = t;
    setWanted(t);
  };
  // The kinds of term the type of model has; where it has one kind, every term is of it.
  const type = config.termTypes.includes(wanted) ? wanted : config.termTypes[0];
  const skos = model.mode === 'skos';
  const count = (t: TermType) => model.terms.filter((x) => config.termTypes.length < 2 || x.type === t).length;

  const tree = useMemo(() => classTree(model), [model]);
  // Expansion belongs to the model in the editor: another model starts from the default, an edit keeps what is open.
  const [open, setOpenState] = useState<Set<string>>(() => (remembered?.seq === docSeq ? remembered.open : defaultOpen(tree)));
  const setOpen = (next: Set<string>) => {
    remembered = { seq: docSeq, open: next };
    setOpenState(next);
  };
  const seq = useRef(docSeq);
  useEffect(() => {
    if (seq.current === docSeq) return;
    seq.current = docSeq;
    setOpen(defaultOpen(tree));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docSeq]);

  // A class selected elsewhere (on the canvas, in a table) is brought into view by opening what is above it.
  const selectedKey = selected.join(' ');
  useEffect(() => {
    if (!selected.length) return;
    const above = ancestorsOf(tree, selected);
    if ([...above].every((id) => open.has(id)) && open.has(ROOT)) return;
    setOpen(new Set([...open, ROOT, ...above]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Searching narrows the tree to the matches and the classes leading to them, all opened up.
  const matches = useMemo(() => matchingClasses(model, filter, displayLang), [model, filter, displayLang]);
  const searching = filter.trim() !== '';
  const rows = useMemo(() => treeRows(tree, open, searching ? new Set([...matches, ...ancestorsOf(tree, matches)]) : undefined), [tree, open, searching, matches]);
  const byId = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);
  const defined = useMemo(() => definedClasses(model), [model]);
  const selectedSet = useMemo(() => new Set(selected), [selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return model.terms
      .filter((t) => t.type === type && (!q || `${nameIn(t, model.lang, displayLang)}\n${t.name}\n${t.description}\n${t.synonyms}\n${t.iri ?? ''}`.toLowerCase().includes(q)))
      .sort((a, b) => nameIn(a, model.lang, displayLang).localeCompare(nameIn(b, model.lang, displayLang)));
  }, [model.terms, model.lang, displayLang, filter, type]);

  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  };
  const tabs: [TermType, string][] = config.termTypes.map((t) => [t, config.termType[t].plural]);

  return (
    <aside ref={asideRef} className="panel term-list" style={{ width }}>
      <div className="search">
        <input type="search" value={filter} placeholder={type === 'concept' ? 'Search by name or IRI' : 'Search'} aria-label="Search terms" onChange={(e) => setFilter(e.target.value)} />
        <button className="btn icon ghost" title="Hide the sidebar, to make room. A strip stays at the edge to bring it back." aria-label="Hide the sidebar" aria-expanded={true} onClick={() => showSidebar(false)}>
          <Icon name="sidebarClose" />
        </button>
      </div>
      <div className="chips" role="tablist" aria-label="Kind of term">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={type === t} className={'chip' + (type === t ? ' on' : '')} onClick={() => setType(t)}>
            {label} {count(t)}
          </button>
        ))}
      </div>

      {type === 'concept' ? (
        <>
          <div className="list-count">
            <span>{searching ? `${matches.size} of ${tree.size} match` : `${tree.size} ${skos ? 'concepts' : 'classes'}`}</span>
            <span className="spacer" />
            <button className="mini" title="Expand all" aria-label="Expand all" disabled={searching} onClick={() => setOpen(new Set([ROOT, ...tree.children.keys()]))}>
              <Icon name="expandAll" size={14} />
            </button>
            <button className="mini" title="Collapse all" aria-label="Collapse all" disabled={searching} onClick={() => setOpen(new Set([ROOT]))}>
              <Icon name="collapseAll" size={14} />
            </button>
          </div>
          <ul className="class-tree" role="tree" aria-label={skos ? 'Concept hierarchy' : 'Class hierarchy'}>
            {rows.map((r) => (
              <TreeRowView
                key={r.key}
                id={r.id}
                depth={r.depth}
                hasChildren={r.hasChildren}
                open={r.open}
                cycle={r.cycle}
                defined={defined.has(r.id)}
                term={byId.get(r.id)}
                name={r.id === ROOT ? (skos ? 'Concept scheme' : 'owl:Thing') : (byId.get(r.id) && nameIn(byId.get(r.id)!, model.lang, displayLang)) || 'Unnamed'}
                rootLabel={skos ? 'Concept scheme' : 'owl:Thing'}
                selected={selectedSet.has(r.id)}
                match={searching && matches.has(r.id)}
                frozen={searching}
                iri={r.id === ROOT ? undefined : byId.get(r.id)?.iri && (compactIri(model, byId.get(r.id)!.iri!) ?? byId.get(r.id)!.iri)}
                onToggle={toggle}
              />
            ))}
          </ul>
          {searching && !matches.size && <p className="muted pad">No {skos ? 'concept' : 'class'} matches.</p>}
          {!tree.size && !searching && <p className="muted pad">No {skos ? 'concepts' : 'classes'} yet.</p>}
        </>
      ) : (
        <>
          <div className="list-count">{flat.length === count(type) ? `${flat.length} ${type === 'property' ? 'data properties' : 'individuals'}` : `${flat.length} of ${count(type)} match`}</div>
          <ul>
            {flat.map((t) => (
              <li key={t.id}>
                <button className={selectedSet.has(t.id) ? 'on' : ''} onClick={() => choose(t.id)} title={t.iri ? `${nameIn(t, model.lang, displayLang)}\n${t.iri}` : nameIn(t, model.lang, displayLang)}>
                  <span className={'dot ' + t.type} style={{ background: `var(--nc-${t.color || 'default'}-fill)`, borderColor: `var(--nc-${t.color || 'default'}-stroke)` }} />
                  <span className="name">{nameIn(t, model.lang, displayLang) || 'Unnamed'}</span>
                  {t.external !== undefined && <span className="tag auto" title="An entity of another ontology">ext</span>}
                </button>
              </li>
            ))}
          </ul>
          {!flat.length && <p className="muted pad">{count(type) ? 'Nothing matches.' : type === 'property' ? 'No data properties yet.' : 'No individuals yet.'}</p>}
        </>
      )}
    </aside>
  );
}

/**
 * Selects a term so that its details show in the side panel. On the full graph the canvas also
 * moves to it; in a subgraph or in another view nothing else changes, so browsing the hierarchy
 * never disturbs what is on screen.
 */
function choose(id: string) {
  const s = useStore.getState();
  if (s.view === 'graph' && !s.subgraph.active) s.focusTerm(id);
  else s.select([id]);
}

interface RowProps {
  id: string;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  cycle: boolean;
  /** A defined class: it is equivalent to something (see definedClasses). */
  defined: boolean;
  term: Term | undefined;
  /** Its name in the display language, or the label of the root. */
  name: string;
  rootLabel: string;
  selected: boolean;
  match: boolean;
  /** While searching, the tree is opened for the search and cannot be folded. */
  frozen: boolean;
  iri: string | undefined;
  onToggle: (id: string) => void;
}

/** One line of the tree. Memoised, so selecting a class redraws two lines, not the whole tree. */
const TreeRowView = memo(
  function TreeRowView({ id, depth, hasChildren, open, cycle, defined, term, name, selected, match, frozen, iri, onToggle }: RowProps) {
    const root = id === ROOT;
    const color = term?.color || 'default';
    return (
      <li role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-selected={selected} aria-level={depth + 1} className={'tree-line' + (selected ? ' on' : '') + (match ? ' match' : '')} style={{ paddingLeft: 4 + depth * 12 }}>
        {hasChildren ? (
          <button className="chev" aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} disabled={frozen} onClick={() => onToggle(id)}>
            <Disclosure open={open} />
          </button>
        ) : (
          <span className="chev" />
        )}
        {root ? (
          <span className="label root" title="The top of the hierarchy: every class without a stated superclass is directly below it">
            {name}
          </span>
        ) : (
          <button className="label" title={`${name}${iri ? '\n' + iri : ''}${defined ? '\nA defined class.' : ''}${cycle ? '\nThis class is one of its own superclasses.' : ''}`} onClick={() => choose(id)}>
            <span className="dot concept" style={{ background: `var(--nc-${color}-fill)`, borderColor: `var(--nc-${color}-stroke)` }} />
            <span className="name">{name}</span>
            {/* Said in the line's title, so that the class's name stays its name. */}
            {defined && (
              <span className="tag defined" aria-hidden="true" title="A defined class: it is equivalent to something, so being that is enough to be one of these, and a reasoner classifies by it">
                ≡
              </span>
            )}
            {term?.external !== undefined && <span className="tag auto" title="An entity of another ontology, referred to here under its own IRI">ext</span>}
            {cycle && <span className="tag warn">cycle</span>}
          </button>
        )}
      </li>
    );
  },
  // `onToggle` is a new function each time but always does the same thing.
  (a, b) => a.id === b.id && a.depth === b.depth && a.hasChildren === b.hasChildren && a.open === b.open && a.cycle === b.cycle && a.defined === b.defined && a.term === b.term && a.name === b.name && a.rootLabel === b.rootLabel && a.selected === b.selected && a.match === b.match && a.frozen === b.frozen && a.iri === b.iri,
);
