import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { compactIri } from '../model/prefixes';
import { stable } from '../model/stable';
import { useStore } from '../model/store';
import { ancestorsOf, classTree, defaultOpen, matchingClasses, ROOT, treeRows } from '../model/tree';
import type { Term, TermType } from '../model/types';
import { Disclosure, Icon } from './Icon';
import { configOf } from '../model/modelTypes';

/** Which classes are expanded. Kept outside the component so that it survives switching views. */
let remembered: { seq: number; open: Set<string> } | undefined;

/**
 * The left sidebar: the class hierarchy as a collapsible tree under owl:Thing, with search, and
 * plain lists of the data properties and individuals behind the other two tabs.
 */
export function TermList() {
  // Names, colours and the hierarchy do not change while terms are dragged about, so neither does this.
  const model = stable(useStore((s) => s.model));
  const selected = useStore((s) => s.sel.terms);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const docSeq = useStore((s) => s.docSeq);
  const config = configOf(model);
  const [wanted, setType] = useState<TermType>('concept');
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
  const matches = useMemo(() => matchingClasses(model, filter), [model, filter]);
  const searching = filter.trim() !== '';
  const rows = useMemo(() => treeRows(tree, open, searching ? new Set([...matches, ...ancestorsOf(tree, matches)]) : undefined), [tree, open, searching, matches]);
  const byId = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);
  const selectedSet = useMemo(() => new Set(selected), [selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return model.terms.filter((t) => t.type === type && (!q || `${t.name}\n${t.description}\n${t.synonyms}\n${t.iri ?? ''}`.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
  }, [model.terms, filter, type]);

  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  };
  const tabs: [TermType, string][] = config.termTypes.map((t) => [t, config.termType[t].plural]);

  return (
    <aside className="panel term-list">
      <div className="search">
        <input type="search" value={filter} placeholder={type === 'concept' ? 'Search by name or IRI' : 'Search'} aria-label="Search terms" onChange={(e) => setFilter(e.target.value)} />
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
                term={byId.get(r.id)}
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
                <button className={selectedSet.has(t.id) ? 'on' : ''} onClick={() => choose(t.id)} title={t.iri ? `${t.name}\n${t.iri}` : t.name}>
                  <span className={'dot ' + t.type} style={{ background: `var(--nc-${t.color || 'default'}-fill)`, borderColor: `var(--nc-${t.color || 'default'}-stroke)` }} />
                  <span className="name">{t.name || 'Unnamed'}</span>
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
  term: Term | undefined;
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
  function TreeRowView({ id, depth, hasChildren, open, cycle, term, rootLabel, selected, match, frozen, iri, onToggle }: RowProps) {
    const root = id === ROOT;
    const name = root ? rootLabel : term?.name || 'Unnamed';
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
          <button className="label" title={`${name}${iri ? '\n' + iri : ''}${cycle ? '\nThis class is one of its own superclasses.' : ''}`} onClick={() => choose(id)}>
            <span className="dot concept" style={{ background: `var(--nc-${color}-fill)`, borderColor: `var(--nc-${color}-stroke)` }} />
            <span className="name">{name}</span>
            {term?.external !== undefined && <span className="tag auto" title="An entity of another ontology, referred to here under its own IRI">ext</span>}
            {cycle && <span className="tag warn">cycle</span>}
          </button>
        )}
      </li>
    );
  },
  // `onToggle` is a new function each time but always does the same thing.
  (a, b) => a.id === b.id && a.depth === b.depth && a.hasChildren === b.hasChildren && a.open === b.open && a.cycle === b.cycle && a.term === b.term && a.rootLabel === b.rootLabel && a.selected === b.selected && a.match === b.match && a.frozen === b.frozen && a.iri === b.iri,
);
