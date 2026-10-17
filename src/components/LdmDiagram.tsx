import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { builtIn } from '../layout/compute';
import type { LayoutGraph } from '../layout/types';
import type { Generalization, LogicalEntity, LogicalModel, RelationshipEnd } from '../logical/contracts';
import { typeText } from '../logical/text';

/**
 * The ER diagram of an LDM (roadmap LM-2, FR-M17-12), in Information Engineering (crow’s-foot)
 * notation. A view of the same model the forms edit: choosing an entity opens its editor, and
 * dragging changes only where the picture puts it, never what the model says. Where entities sit
 * is kept in the model’s diagrams, beside its meaning and as one undoable step; an LDM that has
 * not been arranged yet is laid out for the picture without that being stored.
 *
 * The view behaves as the ontology’s canvas does: dragging the background moves it, the wheel
 * zooms around the pointer, and the diagram is fitted when it is opened or arranged. Zooming and
 * panning change only this view, never the model or where its entities sit.
 */

const HEAD = 30;
const ROW = 17;
const MAX_ROWS = 9;
const PAD = 160;
const MIN_W = 176;
const MAX_W = 300;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;

const widthOf = (e: LogicalEntity): number => {
  const longest = Math.max(e.name.length + 2, ...e.attributes.map((a) => a.name.length + 4));
  return Math.min(MAX_W, Math.max(MIN_W, 28 + longest * 7.4));
};
const rowsOf = (e: LogicalEntity) => Math.min(e.attributes.length, MAX_ROWS) + (e.attributes.length > MAX_ROWS ? 1 : 0);
const heightOf = (e: LogicalEntity) => HEAD + rowsOf(e) * ROW + 8;

interface P {
  x: number;
  y: number;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Where the viewport is: screen = world × k + (x, y). */
interface Viewport {
  x: number;
  y: number;
  k: number;
}

const boxOf = (e: LogicalEntity, p: P): Box => ({ x: p.x, y: p.y, w: widthOf(e), h: heightOf(e) });
const centerOf = (b: Box): P => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
const roundZoom = (k: number) => Math.round(k * 100) / 100;

/** Where the line from this box to `toward` leaves the box. */
function edgePoint(b: Box, toward: P): P {
  const c = centerOf(b);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const sx = Math.abs(dx) > 1e-9 ? b.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const sy = Math.abs(dy) > 1e-9 ? b.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** The layout the picture starts from, for an LDM whose entities have no places yet. */
function layoutOf(m: LogicalModel): Record<string, P> {
  const graph: LayoutGraph = {
    nodes: m.entities.map((e) => ({ id: e.id, w: widthOf(e), h: heightOf(e) })),
    edges: [
      // The child (ends[0]) of an identifying relationship is below its parent, as a key is below what it identifies.
      ...m.relationships.map((r) => ({ from: r.ends[0].entity, to: r.ends[1].entity, up: r.identifying })),
      // A subtype is below the supertype it specialises, as a kind of it is.
      ...m.generalizations.flatMap((g) => g.subtypes.map((s) => ({ from: g.supertype, to: s }))),
    ],
  };
  const places = builtIn({ kind: 'hierarchy', graph, options: { direction: 'TB', nodeSpacing: 60, layerSpacing: 90, repulsion: 1, root: '' } });
  const out: Record<string, P> = {};
  for (const e of m.entities) {
    const c = places.get(e.id);
    if (c) out[e.id] = { x: Math.round(c.x - widthOf(e) / 2), y: Math.round(c.y - heightOf(e) / 2) };
  }
  return out;
}

/** What is written at a line’s end: the foot for many, a ring for optional, a stroke for mandatory. */
function EndMark({ at, into, end }: { at: P; into: P; end: RelationshipEnd }) {
  const len = Math.hypot(into.x, into.y) || 1;
  const dx = into.x / len;
  const dy = into.y / len;
  const px = -dy;
  const py = dx;
  const spot = (back: number, side: number): P => ({ x: at.x - dx * back + px * side, y: at.y - dy * back + py * side });
  const lines: [P, P][] = [];
  if (end.max === 'many') {
    const base = spot(14, 0);
    for (const side of [-6, 0, 6]) lines.push([base, spot(0, side)]);
  }
  if (end.max !== 'many') {
    // Exactly one: one stroke across the line, as Information Engineering draws it.
    lines.push([spot(16, -7), spot(16, 7)]);
  }
  const open = end.min === 0;
  const ring = spot(open ? 25 : 0, 0);
  return (
    <g className="ldm-mark">
      <title>{`${end.min} to ${end.max === 'many' ? 'many' : end.max}`}</title>
      {lines.map(([a, b], i) => (
        <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      ))}
      {open && <circle cx={ring.x} cy={ring.y} r={4.5} />}
    </g>
  );
}

function SelfLoop({ box }: { box: Box }) {
  const x = box.x;
  const y = box.y;
  return <path className="ldm-rel" d={`M ${x + box.w * 0.66} ${y} C ${x + box.w + 90} ${y - 80}, ${x + box.w + 90} ${y + box.h + 70}, ${x + box.w * 0.5} ${y + box.h}`} fill="none" />;
}

/**
 * A subtype relationship, as Information Engineering draws it: a line from the supertype to a
 * subtype symbol, and from there one line to each subtype. The discriminator, completeness and
 * exclusivity are written beside the symbol (the subtype relationship of the reference rules).
 */
function SubtypeLink({ g, superBox, kids, superName, names, discriminator }: { g: Generalization; superBox: Box; kids: { id: string; box: Box }[]; superName: string; names: Map<string, string>; discriminator?: string }) {
  const c = centerOf(superBox);
  const hits = kids.map((k) => centerOf(k.box));
  const middle = { x: hits.reduce((n, p) => n + p.x, 0) / hits.length, y: hits.reduce((n, p) => n + p.y, 0) / hits.length };
  const dx = middle.x - c.x;
  const dy = middle.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  const from = edgePoint(superBox, middle);
  // A little way out of the supertype, so that the symbol is not on its edge.
  const junction = { x: from.x + (dx / len) * 34, y: from.y + (dy / len) * 34 };
  const subNames = kids.map((k) => names.get(k.id) ?? k.id).join(', ');
  const flags = [g.complete ? 'complete' : '', g.exclusive ? 'exclusive' : ''].filter(Boolean).join(', ');
  const label = [discriminator ?? 'subtype', flags].filter(Boolean).join(' · ');
  const title = `Subtypes of ${superName}: ${subNames}. ${g.complete ? 'Every instance is one of them. ' : 'Not stated complete. '}${g.exclusive ? 'No instance is of two. ' : 'Not stated exclusive. '}${discriminator ? `Discriminator: ${discriminator}.` : ''}`;
  return (
    <g className="ldm-gen-group" aria-label={title}>
      <title>{title}</title>
      <line className="ldm-gen" x1={from.x} y1={from.y} x2={junction.x} y2={junction.y} />
      {kids.map((k) => {
        const at = edgePoint(k.box, junction);
        return <line key={k.id} className="ldm-gen" x1={junction.x} y1={junction.y} x2={at.x} y2={at.y} />;
      })}
      <circle className="ldm-gen-symbol" cx={junction.x} cy={junction.y} r={7} />
      <text className="ldm-gen-label" x={junction.x} y={junction.y - 13}>
        {label}
      </text>
    </g>
  );
}

/** The four marks of the notation, drawn small beside the toolbar’s words. */
function Legend() {
  return (
    <span className="ldm-legend" aria-hidden="true">
      <span>
        <svg width="24" height="10" aria-hidden="true">
          <line className="ldm-legend-line" x1="1" y1="5" x2="23" y2="5" />
        </svg>
        identifying
      </span>
      <span>
        <svg width="24" height="10" aria-hidden="true">
          <line className="ldm-legend-line" x1="1" y1="5" x2="23" y2="5" strokeDasharray="5 3" />
        </svg>
        other
      </span>
      <span>
        <svg width="16" height="12" aria-hidden="true">
          <g className="ldm-mark">
            <line x1="14" y1="1" x2="2" y2="6" />
            <line x1="14" y1="11" x2="2" y2="6" />
            <line x1="14" y1="1" x2="14" y2="11" />
          </g>
        </svg>
        many
      </span>
      <span>
        <svg width="14" height="12" aria-hidden="true">
          <circle className="ldm-mark-ring" cx="7" cy="6" r="3.5" />
        </svg>
        optional
      </span>
      <span>
        <svg width="20" height="14" aria-hidden="true">
          <line className="ldm-gen" x1="10" y1="0" x2="10" y2="5" />
          <circle className="ldm-gen-symbol" cx="10" cy="8" r="3" />
          <line className="ldm-gen" x1="10" y1="11" x2="6" y2="14" />
          <line className="ldm-gen" x1="10" y1="11" x2="14" y2="14" />
        </svg>
        subtype
      </span>
    </span>
  );
}

export function LdmDiagram({ m, selected, onSelect, onPositions, onNewEntity, onNewRelationship }: { m: LogicalModel; selected: string | null; onSelect: (id: string) => void; onPositions: (positions: Record<string, P>) => void; onNewEntity: () => void; onNewRelationship: () => void }) {
  // The layout is recomputed when entities or lines change, not when a name or an attribute does.
  const shape = `${m.entities.map((e) => e.id).join(',')}|${m.relationships.map((r) => `${r.id}:${r.ends[0].entity}>${r.ends[1].entity}`).join(',')}|${m.generalizations.map((g) => `${g.id}:${g.supertype}>${g.subtypes.join('+')}`).join(',')}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const arranged = useMemo(() => layoutOf(m), [shape]);
  const [moved, setMoved] = useState<Record<string, P>>({});
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; startX: number; startY: number; origin: P; at: P; moved: boolean } | null>(null);
  const pan = useRef<{ pointer: number; startX: number; startY: number; from: Viewport } | null>(null);
  const justDragged = useRef(0);
  const stored = m.diagrams[0]?.positions;

  // The places kept with the model are the truth: a drag that was committed, an undo of it, or
  // an Arrange all take over from what the pointer last showed.
  const fitAfter = useRef(false);
  const fitNow = useRef<() => void>(() => {});
  useEffect(() => {
    setMoved({});
    if (fitAfter.current) {
      fitAfter.current = false;
      fitNow.current();
    }
  }, [stored]);

  const positions = { ...arranged, ...(stored ?? {}), ...moved };
  const boxes = new Map<string, Box>(m.entities.map((e) => [e.id, boxOf(e, positions[e.id] ?? { x: 0, y: 0 })]));
  const entityNames = new Map(m.entities.map((e) => [e.id, e.name]));
  const all = [...boxes.values()];
  const contentMinX = all.length ? Math.min(...all.map((b) => b.x)) : 0;
  const contentMinY = all.length ? Math.min(...all.map((b) => b.y)) : 0;
  const contentMaxX = all.length ? Math.max(...all.map((b) => b.x + b.w)) : 0;
  const contentMaxY = all.length ? Math.max(...all.map((b) => b.y + b.h)) : 0;
  const contentW = contentMaxX - contentMinX;
  const contentH = contentMaxY - contentMinY;
  const minX = contentMinX - PAD;
  const minY = contentMinY - PAD;
  const worldW = contentW + PAD * 2;
  const worldH = contentH + PAD * 2;

  // The viewport is the room the canvas gives; fitting works from what it really is.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = () => {
    const el = scroller.current;
    if (!el || !contentW || !contentH) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const k = roundZoom(clampZoom(Math.min((w - 72) / contentW, (h - 72) / contentH, 1.2)));
    setView({ k, x: Math.round((w - contentW * k) / 2 - contentMinX * k), y: Math.round((h - contentH * k) / 2 - contentMinY * k) });
  };
  fitNow.current = fit;

  // Fit once when the diagram is opened for a model, and once when entities first appear.
  const fittedFor = useRef<string>('');
  useLayoutEffect(() => {
    if (!size.w || !size.h || !contentW || fittedFor.current === m.id) return;
    fittedFor.current = m.id;
    fit();
    // fit is rebuilt with the positions of this render; only these say when to fit again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, size.w, size.h, contentW]);

  /** Zoom around a point of the canvas, in its own pixels. */
  const zoomAt = (px: number, py: number, factor: number) => {
    setView((v) => {
      const k = roundZoom(clampZoom(v.k * factor));
      const wx = (px - v.x) / v.k;
      const wy = (py - v.y) / v.k;
      return { k, x: Math.round(px - wx * k), y: Math.round(py - wy * k) };
    });
  };

  // The wheel zooms around the pointer. Registered natively because React’s listener is passive.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
    // zoomAt works from the view as it is when the wheel turns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (next: Record<string, P>) => {
    onPositions(next);
  };

  const arrange = () => {
    fitAfter.current = true;
    commit(layoutOf(m));
  };

  // Dragging the background moves the view, as the ontology’s canvas does. A node stops the
  // pointer on its way down, so dragging one moves the entity and not the picture.
  const startPan = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pan.current = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, from: view };
  };
  const movePan = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = pan.current;
    if (!p || p.pointer !== e.pointerId) return;
    setView((v) => ({ ...v, x: Math.round(p.from.x + e.clientX - p.startX), y: Math.round(p.from.y + e.clientY - p.startY) }));
  };
  const endPan = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = pan.current;
    if (!p || p.pointer !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    pan.current = null;
  };

  const pointerDown = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = positions[id];
    drag.current = { id, startX: e.clientX, startY: e.clientY, origin: p, at: p, moved: false };
  };
  const pointerMove = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    const d = drag.current;
    if (!d || d.id !== id) return;
    const dx = (e.clientX - d.startX) / view.k;
    const dy = (e.clientY - d.startY) / view.k;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    d.at = { x: Math.round(d.origin.x + dx), y: Math.round(d.origin.y + dy) };
    setMoved((was) => ({ ...was, [id]: d.at }));
  };
  const pointerUp = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    const d = drag.current;
    if (!d || d.id !== id) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
    if (!d.moved) return;
    justDragged.current = Date.now();
    commit({ ...positions, [id]: d.at });
  };

  const keyNode = (e: ReactKeyboardEvent<SVGGElement>, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
      return;
    }
    const step = e.shiftKey ? 40 : 12;
    const d = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : e.key === 'ArrowDown' ? [0, step] : null;
    if (!d) return;
    e.preventDefault();
    const p = positions[id];
    if (!p) return;
    onPositions({ ...positions, [id]: { x: p.x + d[0], y: p.y + d[1] } });
  };

  const keyCanvas = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === '+' || e.key === '=') zoomAt(size.w / 2, size.h / 2, 1.15);
    else if (e.key === '-' || e.key === '_') zoomAt(size.w / 2, size.h / 2, 1 / 1.15);
    else if (e.key === '0') fit();
  };

  if (!m.entities.length) {
    return (
      <div className="ldm-diagram">
        <p className="muted pad">The diagram is drawn from the entities. Make one in the Entities section first.</p>
      </div>
    );
  }

  const pct = Math.round(view.k * 100);
  return (
    <div className="ldm-diagram">
      <div className="ldm-diagram-tools">
        <Legend />
        <span className="row wrap">
          <button className="btn small" title="Make an entity here, as the Entities section does" onClick={onNewEntity}>
            New entity
          </button>
          <button className="btn small" disabled={!m.entities.length} title={m.entities.length ? 'Make a relationship here, as the Relationships section does' : 'Make an entity first'} onClick={onNewRelationship}>
            New relationship
          </button>
          <button className="btn small" title="Lay every entity out afresh; positions are kept with the model" onClick={arrange}>
            Arrange
          </button>
          <span className="ldm-zoom" role="group" aria-label="Zoom">
            <button className="btn small ghost" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.15)}>
              −
            </button>
            <span className="ldm-zoom-value" title="The diagram’s scale">
              {pct}%
            </span>
            <button className="btn small ghost" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.15)}>
              +
            </button>
          </span>
          <button className="btn small" title="Fit the whole diagram in the view (0)" onClick={fit}>
            Fit
          </button>
        </span>
      </div>
      <div ref={scroller} className="ldm-canvas" tabIndex={0} role="group" aria-label="Entity relationship diagram. Drag the background to move it, scroll to zoom. Tab to an entity, Enter opens it, arrow keys move it." onKeyDown={keyCanvas}>
        <svg width="100%" height="100%" role="img" aria-label={`${m.name} entity relationship diagram`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
          <defs>
            <pattern id="ldm-grid" width={22} height={22} patternUnits="userSpaceOnUse">
              <circle className="ldm-grid-dot" cx={1} cy={1} r={1} />
            </pattern>
          </defs>
          <g className="ldm-viewport" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            <rect className="ldm-paper" x={minX} y={minY} width={worldW} height={worldH} fill="url(#ldm-grid)" />
            {m.relationships.map((r) => {
              const a = boxes.get(r.ends[0].entity);
              const b = boxes.get(r.ends[1].entity);
              if (!a || !b) return null;
              if (r.ends[0].entity === r.ends[1].entity) {
                const mid = { x: a.x + a.w + 70, y: a.y + a.h / 2 };
                return (
                  <g key={r.id} className="ldm-rel-group">
                    <SelfLoop box={a} />
                    <text className="ldm-rel-label" x={mid.x} y={mid.y}>
                      {r.name}
                    </text>
                  </g>
                );
              }
              const ca = centerOf(a);
              const cb = centerOf(b);
              const pa = edgePoint(a, cb);
              const pb = edgePoint(b, ca);
              return (
                <g key={r.id} className="ldm-rel-group">
                  <line className="ldm-rel" x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} strokeDasharray={r.identifying ? undefined : '6 4'} />
                  <EndMark at={pa} into={{ x: cb.x - ca.x, y: cb.y - ca.y }} end={r.ends[0]} />
                  <EndMark at={pb} into={{ x: ca.x - cb.x, y: ca.y - cb.y }} end={r.ends[1]} />
                  <text className="ldm-rel-label" x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2 - 6}>
                    {r.name}
                  </text>
                </g>
              );
            })}
            {m.generalizations.map((g) => {
              const superBox = boxes.get(g.supertype);
              if (!superBox) return null;
              const kids = g.subtypes.flatMap((id) => {
                const box = boxes.get(id);
                return box ? [{ id, box }] : [];
              });
              if (!kids.length) return null;
              const discriminator = g.discriminator ? m.entities.flatMap((e) => e.attributes).find((a) => a.id === g.discriminator)?.name : undefined;
              return <SubtypeLink key={g.id} g={g} superBox={superBox} kids={kids} superName={entityNames.get(g.supertype) ?? g.supertype} names={entityNames} discriminator={discriminator} />;
            })}
            {m.entities.map((e) => {
              const box = boxes.get(e.id);
              if (!box) return null;
              const pks = new Set(e.keys.filter((k) => k.kind === 'primary').flatMap((k) => k.members.flatMap((x) => ('attribute' in x ? [x.attribute] : []))));
              const rows = e.attributes.slice(0, MAX_ROWS);
              const r = 6;
              const headPath = `M 0 ${HEAD} L 0 ${r} Q 0 0 ${r} 0 L ${box.w - r} 0 Q ${box.w} 0 ${box.w} ${r} L ${box.w} ${HEAD} Z`;
              return (
                <g
                  key={e.id}
                  className={`ldm-node${selected === e.id ? ' on' : ''}${e.abstract ? ' abstract' : ''}`}
                  transform={`translate(${box.x},${box.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${e.name}${e.abstract ? ', abstract' : ''}. ${e.attributes.length} attributes.`}
                  onPointerDown={(ev) => pointerDown(ev, e.id)}
                  onPointerMove={(ev) => pointerMove(ev, e.id)}
                  onPointerUp={(ev) => pointerUp(ev, e.id)}
                  onClick={() => {
                    if (Date.now() - justDragged.current < 300) return;
                    onSelect(e.id);
                  }}
                  onKeyDown={(ev) => keyNode(ev, e.id)}
                >
                  <rect className="ldm-node-box" width={box.w} height={box.h} rx={r} />
                  <path className="ldm-node-head" d={headPath} />
                  <line className="ldm-node-rule" x1={0} y1={HEAD} x2={box.w} y2={HEAD} />
                  <text className="ldm-node-name" x={12} y={20}>
                    {e.name}
                  </text>
                  {rows.map((a, i) => (
                    <text key={a.id} className="ldm-node-attr" x={12} y={HEAD + 13 + i * ROW}>
                      <tspan className={pks.has(a.id) ? 'ldm-pk' : 'ldm-attr-mark'}>{pks.has(a.id) ? 'PK ' : a.optional ? '○ ' : '• '}</tspan>
                      {a.name}
                      <tspan className="ldm-node-type"> : {typeText(a.type, m)}</tspan>
                    </text>
                  ))}
                  {e.attributes.length > MAX_ROWS && (
                    <text className="ldm-node-attr muted" x={12} y={HEAD + 13 + MAX_ROWS * ROW}>
                      {e.attributes.length - MAX_ROWS} more…
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="ldm-canvas-hint" aria-hidden="true">
          Drag to move · Scroll to zoom · 0 fits
        </div>
      </div>
    </div>
  );
}
