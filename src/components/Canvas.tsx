import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayName, edgeGeom, edgeOffsets, LABEL_FONT, nodeLabel, nodeSize, pointInNode, textWidth, type EdgeGeom, type Pt } from '../model/geometry';
import { stable } from '../model/stable';
import { useStore, viewOf, type SubgraphState } from '../model/store';
import { kindLabel, newRelation, REL_KINDS, relLabel, TYPE_CHOICES, typeChoice, type Model, type Relation, type RelKind, type Term } from '../model/types';
import { objectProperties, plainRelationships, REL_CHOICES, relChoice, restrictionByRelation } from '../model/props';
import { activeProps, resolveModel, suggestFor } from '../model/vocab';
import { SubgraphPanel } from './SubgraphPanel';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';

/** Follows the pointer until it is released. */
function track(onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void) {
  const up = (e: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onUp(e);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

export function Canvas() {
  // What is drawn: the whole model, or in subgraph mode the visible part of it with its own layout.
  const model = useStore(viewOf);
  const full = useStore((s) => s.model);
  const subgraph = useStore((s) => s.subgraph);
  const sel = useStore((s) => s.sel);
  const vp = useStore((s) => s.vp);
  const editing = useStore((s) => s.editing);
  const highlight = useStore((s) => s.highlight);
  const highlightLabel = useStore((s) => s.highlightLabel);
  const filter = useStore((s) => s.filter);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [connect, setConnect] = useState<{ from: string; to: Pt } | null>(null);
  const [box, setBox] = useState<{ a: Pt; b: Pt } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const st = useStore.getState;

  const byId = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);
  const skos = model.mode === 'skos';

  const toWorld = (clientX: number, clientY: number): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    const v = st().vp;
    return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k };
  };

  // Track the canvas size and fit the model the first time it is known.
  useEffect(() => {
    const el = wrapRef.current!;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) return;
      st().setCanvasSize(el.clientWidth, el.clientHeight);
      if (first) st().fit();
      first = false;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [st]);

  // Wheel zooms around the cursor. Registered natively because React's listener is passive.
  useEffect(() => {
    const el = wrapRef.current!;
    const wheel = (e: WheelEvent) => {
      // Scrolling inside the subgraph settings scrolls them, not the canvas.
      if ((e.target as Element).closest?.('.subgraph')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      st().zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [st]);

  const createTermAt = (p: Pt) => {
    const id = st().addTerm({ x: Math.round(p.x), y: Math.round(p.y) });
    st().select([id]);
    st().setEditing({ kind: 'term', id, isNew: true });
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const vp0 = st().vp;
    const boxMode = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const origin = toWorld(e.clientX, e.clientY);
    let moved = false;
    track(
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        moved = true;
        if (boxMode) setBox({ a: origin, b: toWorld(ev.clientX, ev.clientY) });
        else st().setVp({ ...vp0, x: vp0.x + ev.clientX - start.x, y: vp0.y + ev.clientY - start.y });
      },
      (ev) => {
        setBox(null);
        if (!moved) {
          if (shift) createTermAt(origin);
          else {
            st().select([]);
            st().setHighlight([]);
          }
          return;
        }
        if (boxMode) {
          const end = toWorld(ev.clientX, ev.clientY);
          const [x0, x1] = [Math.min(origin.x, end.x), Math.max(origin.x, end.x)];
          const [y0, y1] = [Math.min(origin.y, end.y), Math.max(origin.y, end.y)];
          st().select(viewOf(st()).terms.filter((t) => t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1).map((t) => t.id));
        }
      },
    );
  };

  const onNodeDown = (e: React.PointerEvent, t: Term) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      st().toggleTerm(t.id);
      return;
    }
    if (!st().sel.terms.includes(t.id)) st().select([t.id]);
    let last = toWorld(e.clientX, e.clientY);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    track(
      (ev) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
          moved = true;
          st().checkpoint();
        }
        const p = toWorld(ev.clientX, ev.clientY);
        st().moveTerms(st().sel.terms, p.x - last.x, p.y - last.y);
        last = p;
      },
      () => {
        // A plain click on one of several selected terms narrows the selection to it.
        if (!moved && st().sel.terms.length > 1) st().select([t.id]);
      },
    );
  };

  const onHandleDown = (e: React.PointerEvent, t: Term) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    setConnect({ from: t.id, to: toWorld(e.clientX, e.clientY) });
    track(
      (ev) => setConnect({ from: t.id, to: toWorld(ev.clientX, ev.clientY) }),
      (ev) => {
        setConnect(null);
        const p = toWorld(ev.clientX, ev.clientY);
        const terms = viewOf(st()).terms;
        const target = [...terms].reverse().find((x) => pointInNode(x, p));
        if (target && target.id !== t.id) {
          // Drawing a term onto a data property attaches it: the term becomes (part of) its domain.
          let kind: RelKind = 'association';
          if (st().model.mode !== 'skos') {
            if (target.type === 'property' && t.type !== 'property') kind = 'property';
          }
          const id = st().addRelation({ from: t.id, to: target.id, kind });
          st().select([], [id]);
          st().setEditing({ kind: 'rel', id, isNew: true });
        } else if (!target && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 40) {
          // Dropped on empty canvas: create the other term right there.
          // The relation joins the term's history entry so one undo removes both.
          const id = st().addTerm({ x: Math.round(p.x), y: Math.round(p.y) });
          st().apply((m) => ({ ...m, relations: [...m.relations, newRelation({ from: t.id, to: id })] }), false);
          st().select([id]);
          st().setEditing({ kind: 'term', id, isNew: true });
        }
      },
    );
  };

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    openMenu(e, [
      { label: 'Add term here', onClick: () => createTermAt(p), hint: 'Double-click' },
      { label: 'Bulk add…', onClick: () => st().setDialog('bulk') },
      'sep',
      { label: 'Arrange as hierarchy', onClick: () => st().arrange('hierarchy') },
      { label: 'Arrange as network', onClick: () => st().arrange('force') },
      { label: 'Fit to screen', onClick: () => st().fit(), hint: 'F' },
      'sep',
      { label: 'Select all', onClick: () => st().selectAll(), hint: 'Ctrl+A' },
    ]);
  };

  const termMenu = (e: React.MouseEvent, t: Term) => {
    if (!st().sel.terms.includes(t.id)) st().select([t.id]);
    const ids = st().sel.terms;
    const many = ids.length > 1;
    openMenu(e, [
      { label: 'Rename', onClick: () => st().setEditing({ kind: 'term', id: t.id }), hint: 'F2', disabled: many },
      { heading: 'Type' },
      ...TYPE_CHOICES.map((tt) => ({
        label: tt.label,
        checked: !many && typeChoice(t) === tt.value,
        onClick: () => st().updateTerms(ids, tt.patch),
      })),
      { heading: 'Colour' },
      { swatches: (color) => st().updateTerms(ids, { color }), current: many ? undefined : t.color },
      { heading: 'Highlight' },
      { label: 'Incoming terms', onClick: () => st().showNeighbours(ids, 'in') },
      { label: 'Outgoing terms', onClick: () => st().showNeighbours(ids, 'out') },
      { label: 'Both directions', onClick: () => st().showNeighbours(ids, 'both') },
      'sep',
      { label: 'Find path between the two', onClick: () => st().showPath(ids[0], ids[1]), disabled: ids.length !== 2 },
      ...subgraphItems(ids, t),
      { label: many ? `Delete ${ids.length} terms` : 'Delete', onClick: () => st().deleteSelection(), danger: true, hint: 'Del' },
    ]);
  };

  /** What a term can do in, or for, the subgraph. */
  const subgraphItems = (ids: string[], t: Term): MenuItem[] => {
    const sg = st().subgraph;
    if (!sg.active) {
      return [
        {
          label: ids.length > 1 ? `Show these ${ids.length} as a subgraph` : 'Show as a subgraph',
          onClick: () => {
            st().setSubgraph({ roots: ids });
            st().visualizeSubgraph();
          },
        },
        'sep',
      ];
    }
    const isRoot = sg.roots.includes(t.id);
    const more = sg.result?.more.get(t.id) ?? 0;
    return [
      { heading: 'Subgraph' },
      ...(sg.expanded.includes(t.id)
        ? [{ label: 'Collapse its neighbours', onClick: () => st().toggleExpand(t.id) }]
        : [{ label: more ? `Expand ${more} more neighbour${more === 1 ? '' : 's'}` : 'Expand neighbours', onClick: () => st().toggleExpand(t.id), disabled: !more }]),
      isRoot
        ? { label: 'No longer start from it', onClick: () => st().setSubgraph({ roots: sg.roots.filter((x) => x !== t.id) }) }
        : { label: 'Also start from it', onClick: () => st().setSubgraph({ roots: [...sg.roots, ...ids.filter((x) => !sg.roots.includes(x))] }) },
      { label: ids.length > 1 ? `Hide these ${ids.length} from the subgraph` : 'Hide from the subgraph', onClick: () => st().setSubgraph({ hidden: [...sg.hidden, ...ids], roots: sg.roots.filter((x) => !ids.includes(x)) }) },
      'sep',
    ];
  };

  const relMenu = (e: React.MouseEvent, r: Relation) => {
    st().select([], [r.id]);
    openMenu(e, [
      { label: 'Edit label', onClick: () => st().setEditing({ kind: 'rel', id: r.id }), hint: 'F2' },
      { label: 'Reverse direction', onClick: () => st().reverseRelation(r.id) },
      { heading: 'Kind' },
      ...(skos
        ? REL_KINDS.map((k) => ({ label: kindLabel(k.value, skos), checked: r.kind === k.value, onClick: () => st().updateRelation(r.id, { kind: k.value }) }))
        : REL_CHOICES.map((k) => ({ label: k.label, checked: relChoice(st().model, r) === k.value, onClick: () => st().setRelChoice(r.id, k.value) }))),
      'sep',
      { label: 'Delete', onClick: () => st().remove([], [r.id]), danger: true, hint: 'Del' },
    ]);
  };

  const connectFrom = connect && byId.get(connect.from);
  // The term a new relation would land on if the pointer were released now.
  const targetId = connect ? [...model.terms].reverse().find((t) => t.id !== connect.from && pointInNode(t, connect.to))?.id : undefined;
  // The scene gets one set of callbacks that never changes, so that it is not redrawn for nothing;
  // they reach the current handlers through a ref.
  const handlers = useRef({ onNodeDown, onHandleDown, termMenu, relMenu });
  handlers.current = { onNodeDown, onHandleDown, termMenu, relMenu };
  const actions = useMemo<SceneActions>(
    () => ({
      nodeDown: (e, t) => handlers.current.onNodeDown(e, t),
      expand: (e, t) => {
        e.stopPropagation();
        useStore.getState().toggleExpand(t.id);
      },
      handleDown: (e, t) => handlers.current.onHandleDown(e, t),
      termMenu: (e, t) => handlers.current.termMenu(e, t),
      relMenu: (e, r) => handlers.current.relMenu(e, r),
    }),
    [],
  );

  return (
    <div
      ref={wrapRef}
      className="canvas"
      style={{ backgroundSize: `${24 * vp.k}px ${24 * vp.k}px`, backgroundPosition: `${vp.x}px ${vp.y}px` }}
    >
      <svg
        id="graph-svg"
        // Zoomed far out, relation labels are too small to read and only slow drawing down.
        className={'graph' + (vp.k < 0.3 ? ' far' : '')}
        onPointerDown={onBackgroundDown}
        onDoubleClick={(e) => createTermAt(toWorld(e.clientX, e.clientY))}
        onContextMenu={backgroundMenu}
      >
        <g data-world transform={`translate(${vp.x},${vp.y}) scale(${vp.k})`}>
          <Scene model={model} sel={sel} highlight={highlight} filter={filter} editing={editing} targetId={targetId} actions={actions} sub={subgraph.active ? subgraph : undefined} />
          {connectFrom && <line data-noexport className="connect-line" x1={connectFrom.x} y1={connectFrom.y} x2={connect.to.x} y2={connect.to.y} />}

          {box && (
            <rect
              data-noexport
              className="select-box"
              x={Math.min(box.a.x, box.b.x)}
              y={Math.min(box.a.y, box.b.y)}
              width={Math.abs(box.a.x - box.b.x)}
              height={Math.abs(box.a.y - box.b.y)}
            />
          )}
        </g>
      </svg>

      {editing && <InlineEditor key={editing.kind + editing.id} byId={byId} />}

      {!full.terms.length && (
        <div className="empty-hint">
          <strong>Nothing here yet</strong>
          <span>Double-click anywhere to add your first term, or use Bulk add to paste a list.</span>
        </div>
      )}

      <SubgraphPanel />
      {subgraph.active && full.terms.length > 0 && model.terms.length === 0 && (
        <div className="empty-hint">
          <strong>Nothing in this subgraph</strong>
          <span>Open Settings and choose a term to start from, or go back to the full graph.</span>
        </div>
      )}

      {highlight.length > 0 && (
        <div className="canvas-banner">
          {highlightLabel || 'Spotlight'}
          <button className="btn small" onClick={() => st().setHighlight([])}>
            Clear
          </button>
        </div>
      )}

      <div className="zoom">
        <button className="btn icon" title="Zoom out" aria-label="Zoom out" onClick={() => st().zoomBy(1 / 1.25)}>
          −
        </button>
        <button className="btn zoom-level" title="Reset zoom to 100%" onClick={() => st().zoomBy(1 / vp.k)}>
          {Math.round(vp.k * 100)}%
        </button>
        <button className="btn icon" title="Zoom in" aria-label="Zoom in" onClick={() => st().zoomBy(1.25)}>
          +
        </button>
        <button className="btn" title="Fit the whole model on screen (F)" onClick={() => st().fit()}>
          Fit
        </button>
      </div>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </div>
  );
}

interface SceneActions {
  nodeDown: (e: React.PointerEvent, t: Term) => void;
  expand: (e: React.PointerEvent, t: Term) => void;
  handleDown: (e: React.PointerEvent, t: Term) => void;
  termMenu: (e: React.MouseEvent, t: Term) => void;
  relMenu: (e: React.MouseEvent, r: Relation) => void;
}

interface SceneProps {
  model: Model;
  sel: { terms: string[]; rels: string[] };
  highlight: string[];
  filter: string;
  editing: { kind: 'term' | 'rel'; id: string } | null;
  targetId: string | undefined;
  actions: SceneActions;
  /** Set in subgraph mode: which terms are starting points, which are expanded, and which have more to show. */
  sub?: SubgraphState;
}

/**
 * Every term and relation of the model. Memoised at three levels so that a large model stays
 * responsive: the scene itself does not change while the view is panned or zoomed, and within it
 * a term or relation is redrawn only when something about it changed.
 */
const Scene = memo(function Scene({ model, sel, highlight, filter, editing, targetId, actions, sub }: SceneProps) {
  const rootSet = useMemo(() => new Set(sub?.roots), [sub?.roots]);
  const expandedSet = useMemo(() => new Set(sub?.expanded), [sub?.expanded]);
  const byId = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);
  // Relations as they should be read: with the RDFS/OWL layer on, a mapped relation takes the
  // kind and label of its standard property.
  const meaning = stable(model);
  const relations = useMemo(() => resolveModel(meaning).relations, [meaning]);
  const offsets = useMemo(() => edgeOffsets(relations), [relations]);
  // Geometry is kept per relation and reused while its two ends stay where they are.
  const cache = useRef(new Map<string, { a: Term; b: Term; offset: number; kind: Relation['kind']; geom: EdgeGeom }>());
  const geoms = useMemo(() => {
    const next = new Map<string, { a: Term; b: Term; offset: number; kind: Relation['kind']; geom: EdgeGeom }>();
    for (const r of relations) {
      const a = byId.get(r.from);
      const b = byId.get(r.to);
      if (!a || !b) continue;
      const offset = offsets.get(r.id) ?? 0;
      const old = cache.current.get(r.id);
      // Only position and size matter, and size follows from the label.
      const same = old && old.offset === offset && old.kind === r.kind && old.a.x === a.x && old.a.y === a.y && old.b.x === b.x && old.b.y === b.y && nodeLabel(old.a) === nodeLabel(a) && nodeLabel(old.b) === nodeLabel(b);
      next.set(r.id, same ? { ...old, a, b } : { a, b, offset, kind: r.kind, geom: edgeGeom(a, b, offset, r.kind) });
    }
    cache.current = next;
    return next;
  }, [relations, offsets, byId]);

  const skos = model.mode === 'skos';
  const { restrictions, plain } = useMemo(() => {
    const plain = new Set<string>();
    if (meaning.mode !== 'skos') for (const p of plainRelationships(meaning)) for (const r of p.rels) plain.add(r.id);
    return { restrictions: restrictionByRelation(meaning), plain };
  }, [meaning]);
  const selTerms = useMemo(() => new Set(sel.terms), [sel.terms]);
  const selRels = useMemo(() => new Set(sel.rels), [sel.rels]);
  const spot = useMemo(() => new Set(highlight), [highlight]);
  const query = filter.trim().toLowerCase();
  const matches = (t: Term) => !query || `${t.name}\n${t.description}\n${t.synonyms}`.toLowerCase().includes(query);
  const termDim = (t: Term) => (spot.size ? !spot.has(t.id) : !matches(t));
  const relDim = (r: Relation) => {
    if (spot.size) return !spot.has(r.id);
    if (!query) return false;
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    return !(a && b && matches(a) && matches(b));
  };

  return (
    <>
      {relations.map((r) => {
        const g = geoms.get(r.id);
        if (!g) return null;
        // A restriction reads "directs some Film"; a relationship nobody has classified is drawn fainter.
        const restriction = restrictions.get(r.id);
        const label = restriction ? `${restriction.data ? 'has' : restriction.property} ${restriction.quantifier}${restriction.n !== undefined ? ' ' + restriction.n : ''}` : relLabel(r, skos);
        const cls = `edge ${r.kind}${r.predicate ? ' std' : ''}${plain.has(r.id) ? ' plain' : ''}${selRels.has(r.id) ? ' selected' : ''}${relDim(r) ? ' dim' : ''}${spot.has(r.id) ? ' spot' : ''}`;
        return <EdgeView key={r.id} r={r} geom={g.geom} label={editing?.kind === 'rel' && editing.id === r.id ? '' : label} cls={cls} actions={actions} />;
      })}
      {model.terms.map((t) => {
        const cls = `node ${t.type}${t.external !== undefined ? ' external' : ''}${selTerms.has(t.id) ? ' selected' : ''}${termDim(t) ? ' dim' : ''}${targetId === t.id ? ' target' : ''}`;
        const more = sub?.result?.more.get(t.id) ?? 0;
        return (
          <NodeView
            key={t.id}
            t={t}
            cls={cls + (rootSet.has(t.id) ? ' root' : '')}
            hideText={editing?.kind === 'term' && editing.id === t.id}
            actions={actions}
            // In a subgraph: how many neighbours are out of sight (click to show), or that they were shown by hand (click to fold).
            badge={!sub ? '' : expandedSet.has(t.id) ? '−' : more ? `+${more}` : ''}
          />
        );
      })}
    </>
  );
});

const EdgeView = memo(function EdgeView({ r, geom: g, label, cls, actions }: { r: Relation; geom: EdgeGeom; label: string; cls: string; actions: SceneActions }) {
  const lw = label ? textWidth(label, LABEL_FONT) + 10 : 0;
  return (
    <g
      className={cls}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        useStore.getState().select([], [r.id]);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        useStore.getState().setEditing({ kind: 'rel', id: r.id });
      }}
      onContextMenu={(e) => actions.relMenu(e, r)}
    >
      <path data-noexport className="edge-hit" d={g.path} />
      <path className="edge-line" d={g.path} />
      <polygon className="edge-arrow" points={g.arrow} />
      {label && (
        <>
          <rect className="edge-label-bg" x={g.label.x - lw / 2} y={g.label.y - 9} width={lw} height={18} rx={4} />
          <text className="edge-label" x={g.label.x} y={g.label.y}>
            {label}
          </text>
        </>
      )}
      {r.fromCard && (
        <text className="edge-card" x={g.fromCard.x} y={g.fromCard.y}>
          {r.fromCard}
        </text>
      )}
      {r.toCard && (
        <text className="edge-card" x={g.toCard.x} y={g.toCard.y}>
          {r.toCard}
        </text>
      )}
    </g>
  );
});

const NodeView = memo(function NodeView({ t, cls, hideText, actions, badge }: { t: Term; cls: string; hideText: boolean; actions: SceneActions; badge: string }) {
  const { w, h } = nodeSize(t);
  const color = t.color || 'default';
  return (
    <g
      className={cls}
      transform={`translate(${t.x - w / 2},${t.y - h / 2})`}
      onPointerDown={(e) => actions.nodeDown(e, t)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        useStore.getState().setEditing({ kind: 'term', id: t.id });
      }}
      onContextMenu={(e) => actions.termMenu(e, t)}
    >
      <rect className="node-box" width={w} height={h} rx={t.type === 'property' ? h / 2 : t.type === 'instance' ? 2 : 9} style={{ fill: `var(--nc-${color}-fill)`, stroke: `var(--nc-${color}-stroke)` }} />
      {!hideText && (
        <text className="node-text" x={w / 2} y={h / 2}>
          {t.name ? displayName(nodeLabel(t)) : 'Unnamed'}
        </text>
      )}
      {badge && (
        <g data-noexport className="expand" transform={`translate(${w / 2},${h + 2})`} onPointerDown={(e) => e.button === 0 && actions.expand(e, t)} onDoubleClick={(e) => e.stopPropagation()}>
          <title>{badge === '−' ? 'Fold its neighbours away again' : `${badge.slice(1)} more neighbour${badge === '+1' ? '' : 's'}: click to show`}</title>
          <rect x={-(badge.length * 4 + 8)} y={-2} width={badge.length * 8 + 16} height={17} rx={8.5} />
          <text y={7}>{badge}</text>
        </g>
      )}
      <g data-noexport className="handle" transform={`translate(${w},${h / 2})`} onPointerDown={(e) => actions.handleDown(e, t)}>
        <title>Drag to another term to relate them</title>
        <circle className="handle-hit" r={13} />
        <circle className="handle-dot" r={7} />
        <path className="handle-plus" d="M-3.5,0H3.5M0,-3.5V3.5" />
      </g>
    </g>
  );
});

/** Text box placed over the term or relation label being renamed. */
function InlineEditor({ byId }: { byId: Map<string, Term> }) {
  const editing = useStore((s) => s.editing)!;
  const vp = useStore((s) => s.vp);
  const model = useStore((s) => s.model);
  const view = useStore(viewOf);
  const st = useStore.getState;
  const term = editing.kind === 'term' ? byId.get(editing.id) : undefined;
  const rel = editing.kind === 'rel' ? model.relations.find((r) => r.id === editing.id) : undefined;
  const [value, setValue] = useState(term?.name ?? rel?.label ?? '');
  const done = useRef(false);
  const props = activeProps(model);
  let at: Pt | undefined = term;
  if (rel) {
    const a = byId.get(rel.from);
    const b = byId.get(rel.to);
    const resolved = resolveModel(view).relations;
    if (a && b) at = edgeGeom(a, b, edgeOffsets(resolved).get(rel.id) ?? 0, resolved.find((r) => r.id === rel.id)?.kind ?? rel.kind).label;
  }
  if (!at || (!term && !rel)) return null;

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const text = value.trim();
    // Typing a standard property's name picks that property. In a concept scheme the everyday
    // words do too: "broader", "related", "exact match".
    const exact = props.find((p) => p.id.toLowerCase() === text.toLowerCase());
    const std = exact ?? (model.mode === 'skos' ? suggestFor(model, text) : undefined);
    st().setEditing(null);
    if (term) {
      if (editing.isNew && (!save || !text)) st().discardLast();
      else if (save && text !== term.name) st().updateTerm(term.id, { name: text }, !editing.isNew);
    } else if (rel) {
      if (editing.isNew && !save) st().discardLast();
      else if (save && std?.hierarchical && !exact) st().updateRelation(rel.id, { label: '', kind: 'generalization', predicate: undefined }, !editing.isNew);
      else if (save && std) st().updateRelation(rel.id, { label: '', predicate: std.id }, !editing.isNew);
      else if (save && text !== rel.label) st().updateRelation(rel.id, { label: text }, !editing.isNew);
    }
  };

  const own = model.mode === 'skos' ? [] : objectProperties(model);
  const suggest = !term && props.length + own.length > 0;
  return (
    <>
      {suggest && (
        <datalist id="std-props">
          {/* The object properties already in the model come first: reusing one is the common case. */}
          {own.map((p) => (
            <option key={p.key} value={p.name} />
          ))}
          {props.map((p) => (
            <option key={p.id} value={p.id} />
          ))}
        </datalist>
      )}
      <input
      list={suggest ? 'std-props' : undefined}
      className={'inline-editor' + (term ? '' : ' for-rel')}
      autoFocus
      value={value}
      placeholder={term ? 'Term name' : 'Relation label'}
      aria-label={term ? 'Term name' : 'Relation label'}
      style={{ left: at.x * vp.k + vp.x, top: at.y * vp.k + vp.y, width: Math.max(term ? 120 : 110, textWidth(value) + 36) }}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      />
    </>
  );
}
