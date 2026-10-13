import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayName, edgeGeom, edgeOffsets, hexInset, LABEL_FONT, LABEL_H, nodeLabel, nodeSize, placeLabels, pointInNode, routeHints, setNodeLook, textWidth, type EdgeGeom, type LabelSpec, type Pt, type RouteHint } from '../model/geometry';
import { beyondEnumerations, edgeLabelsOf, edgeTypesOf, enumerationEdges, ONE_OF_LABEL, type DerivedEdge } from '../model/edgeKinds';
import { dashOf, isHex, nodeLookFor, nodeTypeOf, paint, readableOn, resolveEdge, resolveNode, type EdgeStyle, type NodeStyle } from '../model/graphStyle';
import { stable } from '../model/stable';
import { currentDl, layoutOf, useStore, viewOf, type SubgraphState } from '../model/store';
import { LAYOUT_KINDS, LAYOUTS, routeOf, type Route } from '../layout/types';
import { typed } from '../model/relating';
import { allowsKind, configOf, supports } from '../model/modelTypes';
import { INSTANCE_OF, TYPE_CHOICES, typeChoice, type Model, type Relation, type RelKind, type Term } from '../model/types';
import { isInstanceOf, kindsBetween, objectProperties, offeredChoices, plainRelationships, relChoice, relChoices } from '../model/props';
import { entailed as entailedBy, type InferredMembership } from '../model/inferred';
import { activeProps, resolveModel, suggestFor } from '../model/vocab';
import { StylePanel } from './StylePanel';
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
  const settled = useStore(viewOf);
  const tween = useStore((s) => s.tween);
  // After a layout the terms glide to their new places: until they arrive, each is drawn part of the way there.
  const model = useMemo(() => {
    if (!tween) return settled;
    const { from, p } = tween;
    return { ...settled, terms: settled.terms.map((t) => (from[t.id] ? { ...t, x: from[t.id].x + (t.x - from[t.id].x) * p, y: from[t.id].y + (t.y - from[t.id].y) * p } : t)) };
  }, [settled, tween]);
  const full = useStore((s) => s.model);
  const layout = useStore(layoutOf);
  const route = routeOf(layout);
  const subgraph = useStore((s) => s.subgraph);
  const sel = useStore((s) => s.sel);
  const vp = useStore((s) => s.vp);
  const editing = useStore((s) => s.editing);
  const highlight = useStore((s) => s.highlight);
  const highlightLabel = useStore((s) => s.highlightLabel);
  const filter = useStore((s) => s.filter);
  const showInferred = useStore((s) => s.showInferred);
  const showEnumerations = useStore((s) => s.showEnumerations);
  const stylePanel = useStore((s) => s.stylePanel);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [connect, setConnect] = useState<{ from: string; to: Pt } | null>(null);
  const [box, setBox] = useState<{ a: Pt; b: Pt } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const st = useStore.getState;

  const byId = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);

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
      st().endTween();
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
    st().endTween();
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
    st().endTween();
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
          if (allowsKind(st().model, 'property') && target.type === 'property' && t.type !== 'property') kind = 'property';
          // In an ontology the two ends decide what the line is, or that there can be none: then nothing is added.
          const id = st().addRelation({ from: t.id, to: target.id, kind });
          if (!id) return;
          st().select([], [id]);
          // A name is asked for where the line has one: a relationship of a vocabulary, the object
          // property between two classes or two individuals. A membership or "has data property" has none.
          const made = st().model.relations.find((r) => r.id === id);
          if (!typed(st().model) || (made && relChoice(st().model, made) === 'object')) st().setEditing({ kind: 'rel', id, isNew: true });
        } else if (!target && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 40) {
          // Dropped on empty canvas: create the other term right there.
          // The relation joins the term's history entry so one undo removes both.
          const id = st().addTerm({ x: Math.round(p.x), y: Math.round(p.y) });
          st().addRelation({ from: t.id, to: id }, false);
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
      { heading: 'Layout' },
      ...LAYOUT_KINDS.map((k) => ({ label: LAYOUTS[k].label, checked: layoutOf(st()).kind === k, onClick: () => st().arrange(k) })),
      'sep' as const,
      { label: 'Rearrange', onClick: () => st().rearrange(), disabled: layoutOf(st()).kind === 'manual' },
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
      // The kinds of term the type of model has; with only one there is nothing to choose.
      ...(configOf(st().model).termTypes.length > 1
        ? [
            { heading: 'Type' },
            ...TYPE_CHOICES.filter((tt) => configOf(st().model).termTypes.includes(tt.value)).map((tt) => ({
              label: tt.label,
              checked: !many && typeChoice(t) === tt.value,
              onClick: () => st().updateTerms(ids, tt.patch),
            })),
          ]
        : []),
      { heading: 'Colour' },
      { swatches: (color) => st().updateTerms(ids, { color }), current: many ? undefined : t.color },
      { heading: 'Highlight' },
      { label: 'Incoming terms', onClick: () => st().showNeighbours(ids, 'in') },
      { label: 'Outgoing terms', onClick: () => st().showNeighbours(ids, 'out') },
      { label: 'Both directions', onClick: () => st().showNeighbours(ids, 'both') },
      'sep',
      { label: 'Find path between the two', onClick: () => st().showPath(ids[0], ids[1]), disabled: ids.length !== 2 },
      { label: 'Arrange as a radial tree around it', onClick: () => st().setLayout({ kind: 'radial', root: t.id }), disabled: many },
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
      // A class membership has one direction only: from the individual to the class.
      { label: 'Reverse direction', onClick: () => st().reverseRelation(r.id), disabled: isInstanceOf(st().model, r) },
      { heading: 'Kind' },
      // The kinds the type of model has, of those the ones that fit what the line connects.
      ...offeredChoices(st().model, r).map((k) => ({ label: k.label, checked: relChoice(st().model, r) === k.value, disabled: !!k.disabled, onClick: () => st().setRelChoice(r.id, k.value) })),
      'sep',
      { label: 'Delete', onClick: () => st().remove([], [r.id]), danger: true, hint: 'Del' },
    ]);
  };

  // Class memberships the reasoner works out, when asked for: drawn beside the asserted ones, never stored.
  const meaning = stable(full);
  // What is entailed beyond what is stated, from the app's own reasoner and, when it was asked about
  // the model as it is now, the OWL 2 DL reasoner: class memberships and relationships between individuals.
  const dl = useStore(currentDl);
  const entailed = useMemo(() => (showInferred && supports(meaning, 'reasoning') ? entailedBy(meaning, dl) : undefined), [showInferred, meaning, dl]);
  const inferred = useMemo(() => entailed?.memberships.filter((x) => byId.has(x.from) && byId.has(x.to)) ?? NONE, [entailed, byId]);
  const facts = useMemo(() => (entailed?.facts ?? []).filter((x) => byId.has(x.from) && byId.has(x.to)).map((x): DerivedEdge => ({ id: x.id, from: x.from, to: x.to, kind: 'fact', because: x.because, name: x.name })), [entailed, byId]);
  // What each enumeration class lists, as a line to each member: a picture of its definition, not a
  // relationship. Drawn unless switched off; in a subgraph, where its filters let the line through.
  const hasEnumerations = useMemo(() => full.terms.some((t) => t.type === 'concept' && t.oneOf?.length), [full.terms]);
  const listed = useMemo(() => {
    if (!showEnumerations || !hasEnumerations) return NO_DERIVED;
    const through = subgraph.active && subgraph.result ? new Set(subgraph.result.rels) : undefined;
    return enumerationEdges(model).filter((e) => byId.has(e.from) && byId.has(e.to) && (!through || through.has(e.id)));
  }, [showEnumerations, hasEnumerations, model, byId, subgraph]);
  // A member of an enumeration is an instance of it, which its line says already: that membership is not drawn a second time.
  const dotted = useMemo(() => beyondEnumerations(inferred, listed), [inferred, listed]);
  const derived = useMemo(() => (dotted.length || listed.length || facts.length ? [...dotted.map((x): DerivedEdge => ({ ...x, kind: 'inferred' })), ...facts, ...listed] : NO_DERIVED), [dotted, listed, facts]);

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
          <Scene model={model} route={route} sel={sel} highlight={highlight} filter={filter} editing={editing} targetId={targetId} actions={actions} sub={subgraph.active ? subgraph : undefined} derived={derived} />
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

      <SubgraphPanel
        tools={
          // What the reasoner works out is drawn when asked for, here, where what the graph shows is chosen.
          supports(model, 'reasoning') && (
            <button
              className={'btn small inferred-toggle' + (showInferred ? ' on' : '')}
              aria-pressed={showInferred}
              title={
                !showInferred
                  ? 'Also draw what the reasoner works out, dotted, beside what is asserted: class memberships, and relationships between individuals. Nothing is added to the model.'
                  : !entailed?.consistent
                    ? 'The reasoner finds the ontology inconsistent, so nothing reliable can be inferred. See the Validation tab.'
                    : `${dotted.length} inferred class membership${dotted.length === 1 ? '' : 's'} and ${facts.length} inferred relationship${facts.length === 1 ? '' : 's'} between individuals are drawn dotted, by ${entailed.by}${entailed.partial ? '; the reasoning was partial, so there may be more' : ''}. They are not part of the model. Click to hide them.`
              }
              onClick={() => st().setShowInferred(!showInferred)}
            >
              Inferred facts{showInferred ? (entailed?.consistent ? ` (${dotted.length + facts.length})` : ' (inconsistent)') : ''}
            </button>
          )
        }
      />
      {stylePanel && <StylePanel />}
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
        {/* Only where there is an enumeration to draw: the bar stays as short as it can. */}
        {hasEnumerations && (
          <button
            className={'btn' + (showEnumerations ? ' on' : '')}
            aria-pressed={showEnumerations}
            title={showEnumerations ? 'Each enumeration class is joined to the individuals it lists (owl:oneOf). Click to hide those lines.' : 'Draw a line from each enumeration class to the individuals it lists (owl:oneOf)'}
            onClick={() => st().setShowEnumerations(!showEnumerations)}
          >
            Enumerations
          </button>
        )}
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
  /** How the layout wants lines drawn: straight, curved or with right angles. */
  route: Route;
  sel: { terms: string[]; rels: string[] };
  highlight: string[];
  filter: string;
  editing: { kind: 'term' | 'rel'; id: string } | null;
  targetId: string | undefined;
  actions: SceneActions;
  /** Set in subgraph mode: which terms are starting points, which are expanded, and which have more to show. */
  sub?: SubgraphState;
  /** Lines that are worked out rather than stored: inferred class memberships when asked for, and what enumerations list. */
  derived: DerivedEdge[];
}

const NONE: InferredMembership[] = [];
const NO_DERIVED: DerivedEdge[] = [];

const INFERRED_LABEL = `${INSTANCE_OF} (inferred)`;
/** The words on a line that is worked out rather than stored. */
const derivedLabel = (x: DerivedEdge) => (x.kind === 'oneOf' ? ONE_OF_LABEL : x.kind === 'fact' ? `${x.name} (inferred)` : INFERRED_LABEL);
/** Where the scene last put each edge label, for the editor that opens on one. */
let labelSpots = new Map<string, Pt>();

/**
 * Every term and relation of the model. Memoised at three levels so that a large model stays
 * responsive: the scene itself does not change while the view is panned or zoomed, and within it
 * a term or relation is redrawn only when something about it changed.
 */
const Scene = memo(function Scene({ model, route, sel, highlight, filter, editing, targetId, actions, sub, derived }: SceneProps) {
  const rootSet = useMemo(() => new Set(sub?.roots), [sub?.roots]);
  const expandedSet = useMemo(() => new Set(sub?.expanded), [sub?.expanded]);
  const byId = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);
  // How the nodes are drawn decides how big they are and where edges meet them, so the geometry
  // is told before anything is measured. Layout, fitting and the picture export read the same.
  const style = model.style;
  useMemo(() => setNodeLook(nodeLookFor(model)), [style, model.mode, model.prefixes, model.baseIri, model.datatypes]); // eslint-disable-line react-hooks/exhaustive-deps
  // Relations as they should be read: with the RDFS/OWL layer on, a mapped relation takes the
  // kind and label of its standard property.
  const meaning = stable(model);
  const relations = useMemo(() => resolveModel(meaning).relations, [meaning]);
  const skos = model.mode === 'skos';
  const plain = useMemo(() => {
    const plain = new Set<string>();
    if (meaning.mode !== 'skos') for (const p of plainRelationships(meaning)) for (const r of p.rels) plain.add(r.id);
    return plain;
  }, [meaning]);
  // The style of each edge: that of its kind of relationship, with its own on top.
  const edgeStyles = useMemo(() => {
    const types = edgeTypesOf(meaning);
    const out = new Map<string, EdgeStyle>();
    for (const r of relations) out.set(r.id, resolveEdge(style, types.get(r.id) ?? 'plain', r.id));
    return out;
  }, [relations, meaning, style]);
  const inferredStyle = resolveEdge(style, 'inferred', '');
  const oneOfStyle = resolveEdge(style, 'oneOf', '');
  // A derived line takes its place among the relations between the same two terms.
  const offsets = useMemo(() => edgeOffsets(derived.length ? [...relations, ...derived] : relations), [relations, derived]);
  // Geometry is kept per relation and reused while its two ends stay where they are.
  const cache = useRef(new Map<string, { a: Term; b: Term; offset: number; kind: Relation['kind']; es: EdgeStyle; route: Route; hint: RouteHint | undefined; geom: EdgeGeom }>());
  // Routed lines are told of the others at their terms: where to arrive among them, and where their words fit.
  const routeHint = useMemo(() => routeHints(derived.length ? [...relations, ...derived] : relations, byId, route), [relations, derived, byId, route]);
  const geoms = useMemo(() => {
    const next = new Map<string, { a: Term; b: Term; offset: number; kind: Relation['kind']; es: EdgeStyle; route: Route; hint: RouteHint | undefined; geom: EdgeGeom }>();
    for (const r of relations) {
      const a = byId.get(r.from);
      const b = byId.get(r.to);
      if (!a || !b) continue;
      const es = edgeStyles.get(r.id) ?? NO_EDGE_STYLE;
      // The style can bow the line further, on top of what keeps parallel edges apart.
      const offset = (offsets.get(r.id) ?? 0) + (es.curve ?? 0);
      const old = cache.current.get(r.id);
      // Only position and size matter, and size follows from the label. Any change of style is a new style object.
      const hint = routeHint.get(r.id);
      const same = old && old.es === es && old.route === route && old.hint === hint && old.offset === offset && old.kind === r.kind && old.a.x === a.x && old.a.y === a.y && old.b.x === b.x && old.b.y === b.y && nodeLabel(old.a) === nodeLabel(a) && nodeLabel(old.b) === nodeLabel(b);
      next.set(r.id, same ? { ...old, a, b } : { a, b, offset, kind: r.kind, es, route, hint, geom: edgeGeom(a, b, offset, r.kind, es.arrow, route, hint) });
    }
    cache.current = next;
    return next;
    // The style object stands for everything about the nodes' sizes and shapes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relations, offsets, byId, edgeStyles, style, route, routeHint]);
  // What each edge says. A restriction reads "directs some Film", and several on one line "directs some, only".
  const labels = useMemo(() => edgeLabelsOf(meaning), [meaning]);
  const labelOf = useCallback((r: Relation) => labels.get(r.id) ?? '', [labels]);
  const derivedGeoms = useMemo(() => {
    const out = new Map<string, { a: Term; b: Term; es: EdgeStyle; geom: EdgeGeom }>();
    for (const x of derived) {
      const a = byId.get(x.from);
      const b = byId.get(x.to);
      const es = x.kind === 'oneOf' ? oneOfStyle : inferredStyle;
      // An inferred membership ends like the asserted ones, hollow; an enumeration's line and a relationship between individuals have a plain head.
      if (a && b) out.set(x.id, { a, b, es, geom: edgeGeom(a, b, (offsets.get(x.id) ?? 0) + (es.curve ?? 0), x.kind === 'inferred' ? 'generalization' : 'association', es.arrow, route, routeHint.get(x.id)) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, byId, offsets, inferredStyle, oneOfStyle, style, route, routeHint]);
  // Where each label goes: in the middle of its edge, or along it where the middle is taken.
  const spots = useMemo(() => {
    const specs: LabelSpec[] = [];
    for (const r of relations) {
      const g = geoms.get(r.id);
      const label = g && g.es.labels !== false && labelOf(r);
      if (g && label) specs.push({ id: r.id, geom: g.geom, w: textWidth(label, labelFont(g.es)) + 10, ends: [g.a, g.b] });
    }
    for (const x of derived) {
      const g = derivedGeoms.get(x.id);
      if (g && g.es.labels !== false) specs.push({ id: x.id, geom: g.geom, w: textWidth(derivedLabel(x), labelFont(g.es)) + 10, ends: [g.a, g.b] });
    }
    // The cardinalities written at the ends of plain relationships stay where they are; labels keep off them.
    const cards: { x: number; y: number; w: number; h: number }[] = [];
    for (const r of relations) {
      const g = geoms.get(r.id);
      if (!g || !(skos ? r.kind === 'association' : plain.has(r.id))) continue;
      if (r.fromCard) cards.push({ ...g.geom.fromCard, w: textWidth(r.fromCard, LABEL_FONT) + 4, h: 14 });
      if (r.toCard) cards.push({ ...g.geom.toCard, w: textWidth(r.toCard, LABEL_FONT) + 4, h: 14 });
    }
    return (labelSpots = placeLabels(specs, cards));
  }, [relations, geoms, derived, derivedGeoms, labelOf, skos, plain]);
  const selTerms = useMemo(() => new Set(sel.terms), [sel.terms]);
  const selRels = useMemo(() => new Set(sel.rels), [sel.rels]);
  const spot = useMemo(() => new Set(highlight), [highlight]);
  const query = filter.trim().toLowerCase();
  const matches = (t: Term) => !query || `${t.name}\n${t.description}\n${t.synonyms}`.toLowerCase().includes(query);
  const termDim = (t: Term) => (spot.size ? !spot.has(t.id) : !matches(t));
  const relDim = (r: Pick<Relation, 'id' | 'from' | 'to'>) => {
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
        // A relationship nobody has classified is drawn fainter.
        const instanceOf = isInstanceOf(meaning, r);
        const label = labelOf(r);
        const at = spots.get(r.id) ?? g.geom.label;
        // Cardinalities are drawn for plain relationships only.
        const cards = skos ? r.kind === 'association' : plain.has(r.id);
        const cls = `edge ${r.kind}${instanceOf ? ' instance-of' : r.predicate ? ' std' : ''}${plain.has(r.id) ? ' plain' : ''}${selRels.has(r.id) ? ' selected' : ''}${relDim(r) ? ' dim' : ''}${spot.has(r.id) ? ' spot' : ''}`;
        return <EdgeView key={r.id} r={r} geom={g.geom} es={g.es} lx={at.x} ly={at.y} label={(editing?.kind === 'rel' && editing.id === r.id) || g.es.labels === false ? '' : label} cls={cls} cards={cards} actions={actions} />;
      })}
      {derived.map((x) => {
        const g = derivedGeoms.get(x.id);
        if (!g) return null;
        const at = spots.get(x.id) ?? g.geom.label;
        return <DerivedView key={x.id} x={x} geom={g.geom} es={g.es} lx={at.x} ly={at.y} dim={relDim(x)} />;
      })}
      {model.terms.map((t) => {
        const cls = `node ${t.type}${t.external !== undefined ? ' external' : ''}${selTerms.has(t.id) ? ' selected' : ''}${termDim(t) ? ' dim' : ''}${targetId === t.id ? ' target' : ''}`;
        const more = sub?.result?.more.get(t.id) ?? 0;
        return (
          <NodeView
            key={t.id}
            t={t}
            ns={resolveNode(style, nodeTypeOf(model.mode, t.type), t)}
            label={nodeLabel(t)}
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

const NO_EDGE_STYLE: EdgeStyle = {};
const labelFont = (es: EdgeStyle) => (es.labelSize ? `400 ${es.labelSize}px system-ui, sans-serif` : LABEL_FONT);
const labelHeight = (es: EdgeStyle) => Math.max(LABEL_H, (es.labelSize ?? 12) + 6);

/**
 * An edge's style as the stylesheet takes it: custom properties that the rules for lines, arrows
 * and labels read, falling back to the theme where one is not set. Being selected or
 * spotlighted is said by rules of their own, which still win.
 */
function edgeLook(es: EdgeStyle): { cls: string; vars: React.CSSProperties | undefined } {
  if (es === NO_EDGE_STYLE || !Object.keys(es).length) return { cls: '', vars: undefined };
  const vars: Record<string, string | number> = {};
  const color = paint(es.color, 'line');
  if (color) vars['--e-color'] = color;
  if (es.width) vars['--e-width'] = es.width;
  const dash = dashOf(es.line, es.width);
  if (dash) vars['--e-dash'] = dash;
  const label = paint(es.labelColor, 'line');
  if (label) vars['--e-label'] = label;
  if (es.labelSize) vars['--e-label-size'] = es.labelSize + 'px';
  return { cls: (es.arrow ? ` arrow-${es.arrow}` : '') + (es.line === 'dotted' ? ' line-dotted' : ''), vars: vars as React.CSSProperties };
}

/** The end of an edge: a closed head, for the open kind two strokes that meet at the tip, or nothing at all. */
function Arrow({ points, head }: { points: string; head: EdgeStyle['arrow'] }) {
  // Left out rather than hidden, so that a picture exported from the canvas has none either.
  if (head === 'none') return null;
  if (head !== 'open') return <polygon className="edge-arrow" data-part="head" points={points} />;
  const [tip, a, b] = points.split(' ');
  return <polyline className="edge-arrow" data-part="head" points={`${a} ${tip} ${b}`} />;
}

const EdgeView = memo(function EdgeView({ r, geom: g, es, lx, ly, label, cls, cards, actions }: { r: Relation; geom: EdgeGeom; es: EdgeStyle; lx: number; ly: number; label: string; cls: string; cards: boolean; actions: SceneActions }) {
  const lw = label ? textWidth(label, labelFont(es)) + 10 : 0;
  const lh = labelHeight(es);
  const look = edgeLook(es);
  return (
    <g
      className={cls + look.cls}
      data-rel={r.id}
      style={look.vars}
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
      <path className="edge-line" data-part="line" d={g.path} />
      <Arrow points={g.arrow} head={es.arrow} />
      {label && (
        <>
          <rect className="edge-label-bg" data-part="label-bg" x={lx - lw / 2} y={ly - lh / 2} width={lw} height={lh} rx={4} />
          <text className="edge-label" data-part="label" x={lx} y={ly}>
            {label}
          </text>
        </>
      )}
      {cards && r.fromCard && (
        <text className="edge-card" data-part="from-card" x={g.fromCard.x} y={g.fromCard.y}>
          {r.fromCard}
        </text>
      )}
      {cards && r.toCard && (
        <text className="edge-card" data-part="to-card" x={g.toCard.x} y={g.toCard.y}>
          {r.toCard}
        </text>
      )}
    </g>
  );
});

/**
 * A line that is worked out rather than stored, so nothing about it can be edited here. A class
 * membership the reasoner entails is dotted and labelled as inferred. What an enumeration lists
 * is a line of its own kind from the class to the member, and clicking it opens the class, where
 * the list is.
 */
function DerivedView({ x, geom: g, es, lx, ly, dim }: { x: DerivedEdge; geom: EdgeGeom; es: EdgeStyle; lx: number; ly: number; dim: boolean }) {
  const oneOf = x.kind === 'oneOf';
  const label = es.labels === false ? '' : derivedLabel(x);
  const lw = textWidth(label, labelFont(es)) + 10;
  const lh = labelHeight(es);
  const look = edgeLook(es);
  return (
    <g
      className={(oneOf ? 'edge one-of' : x.kind === 'fact' ? 'edge association inferred inferred-fact' : 'edge generalization instance-of inferred') + (dim ? ' dim' : '') + look.cls}
      data-rel={x.id}
      style={look.vars}
      onPointerDown={
        oneOf
          ? (e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              useStore.getState().select([x.from]);
            }
          : undefined
      }
    >
      <title>{oneOf ? `Enumeration membership (owl:oneOf): part of how the class is defined, not a relationship of its own. ${x.because}` : `Inferred, not asserted. ${x.because}`}</title>
      <path data-noexport className="edge-hit" d={g.path} />
      <path className="edge-line" data-part="line" d={g.path} />
      <Arrow points={g.arrow} head={es.arrow} />
      {label && (
        <>
          <rect className="edge-label-bg" data-part="label-bg" x={lx - lw / 2} y={ly - lh / 2} width={lw} height={lh} rx={4} />
          <text className="edge-label" data-part="label" x={lx} y={ly}>
            {label}
          </text>
        </>
      )}
    </g>
  );
}

/** The outline of a node: the standard box of its kind, or the shape its style asks for. */
function NodeShape({ t, ns, w, h, paintStyle }: { t: Term; ns: NodeStyle; w: number; h: number; paintStyle: React.CSSProperties }) {
  switch (ns.shape) {
    case 'ellipse':
    case 'circle':
      return <ellipse className="node-box" cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} style={paintStyle} />;
    case 'diamond':
      return <polygon className="node-box" points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} style={paintStyle} />;
    case 'hexagon': {
      const c = hexInset(w, h);
      return <polygon className="node-box" points={`${c},0 ${w - c},0 ${w},${h / 2} ${w - c},${h} ${c},${h} 0,${h / 2}`} style={paintStyle} />;
    }
    default:
      return <rect className="node-box" width={w} height={h} rx={ns.shape === 'rectangle' ? 0 : ns.shape === 'rounded' ? 9 : t.type === 'property' ? h / 2 : t.type === 'instance' ? 2 : 9} style={paintStyle} />;
  }
}

// `label` is what nodeLabel(t) gives now: it is a prop so that the node is drawn again when the words change though the term did not.
const NodeView = memo(function NodeView({ t, ns, label, cls, hideText, actions, badge }: { t: Term; ns: NodeStyle; label: string; cls: string; hideText: boolean; actions: SceneActions; badge: string }) {
  const { w, h } = nodeSize(t);
  const color = t.color || 'default';
  // A colour of the node's own, then the colour it was given on the canvas, then the theme's.
  const fill = paint(ns.fill, 'fill') ?? `var(--nc-${color}-fill)`;
  const stroke = paint(ns.stroke, 'line') ?? (ns.fill && !isHex(ns.fill) ? paint(ns.fill, 'line')! : `var(--nc-${color}-stroke)`);
  const vars: Record<string, string | number> = {};
  if (ns.strokeWidth !== undefined) vars['--n-sw'] = ns.strokeWidth;
  // On a freely picked fill the words are black or white, whichever reads, unless a colour was chosen for them.
  const ink = paint(ns.labelColor, 'line') ?? (isHex(ns.fill) ? readableOn(ns.fill) : undefined);
  if (ink) vars['--n-ink'] = ink;
  if (ns.fontSize) vars['--n-fs'] = ns.fontSize + 'px';
  if (ns.fontWeight) vars['--n-fw'] = ns.fontWeight;
  if (ns.opacity !== undefined) vars['--n-op'] = ns.opacity;
  return (
    <g
      className={cls}
      data-term={t.id}
      style={vars as React.CSSProperties}
      transform={`translate(${t.x - w / 2},${t.y - h / 2})`}
      onPointerDown={(e) => actions.nodeDown(e, t)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        useStore.getState().setEditing({ kind: 'term', id: t.id });
      }}
      onContextMenu={(e) => actions.termMenu(e, t)}
    >
      <NodeShape t={t} ns={ns} w={w} h={h} paintStyle={{ fill, stroke }} />
      {!hideText && (
        <text className="node-text" x={w / 2} y={h / 2}>
          {t.name ? displayName(label, t) : 'Unnamed'}
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

/** Labels that mean class membership when typed on a line between an individual and a class. */
const INSTANCE_OF_WORDS = /^(is )?(an? )?instance of$/i;

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
    // Where its label is drawn, so that the box opens on the words it replaces.
    if (a && b) at = labelSpots.get(rel.id) ?? edgeGeom(a, b, edgeOffsets(resolved).get(rel.id) ?? 0, resolved.find((r) => r.id === rel.id)?.kind ?? rel.kind).label;
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
    // In an ontology, naming a line from an individual to a class "is instance of" makes it one.
    const membership = !!rel && save && model.mode !== 'skos' && !exact && INSTANCE_OF_WORDS.test(text) && !relChoices(model, rel).find((c) => c.value === 'instanceOf')!.disabled;
    st().setEditing(null);
    if (term) {
      if (editing.isNew && (!save || !text)) st().discardLast();
      else if (save && text !== term.name) st().updateTerm(term.id, { name: text }, !editing.isNew);
    } else if (rel) {
      if (editing.isNew && !save) st().discardLast();
      else if (membership) {
        // Refused (it is already stated): a line just drawn for it goes again.
        if (!st().setRelChoice(rel.id, 'instanceOf', !editing.isNew) && editing.isNew) st().discardLast();
      } else if (save && std?.hierarchical && !exact) st().updateRelation(rel.id, { label: '', kind: 'generalization', predicate: undefined }, !editing.isNew);
      else if (save && std) st().updateRelation(rel.id, { label: '', predicate: std.id }, !editing.isNew);
      else if (save && text !== rel.label) st().updateRelation(rel.id, { label: text }, !editing.isNew);
    }
  };

  const own = model.mode === 'skos' ? [] : objectProperties(model);
  const canBeInstanceOf = !!rel && model.mode !== 'skos' && !relChoices(model, rel).find((c) => c.value === 'instanceOf')!.disabled;
  // Between two classes of an ontology "is a" is the other thing the line can say.
  const canBeIsA = !!rel && typed(model) && kindsBetween(model, rel).includes('object') && kindsBetween(model, rel).includes('generalization');
  const suggest = !term && props.length + own.length + Number(canBeInstanceOf) + Number(canBeIsA) > 0;
  return (
    <>
      {suggest && (
        <datalist id="std-props">
          {canBeInstanceOf && <option value={INSTANCE_OF} />}
          {canBeIsA && <option value="is a" />}
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
