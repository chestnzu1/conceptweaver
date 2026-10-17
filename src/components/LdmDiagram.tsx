import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { builtIn } from '../layout/compute';
import type { LayoutGraph } from '../layout/types';
import type { LogicalEntity, LogicalModel, RelationshipEnd } from '../logical/contracts';
import { typeText } from '../logical/text';

/**
 * The ER diagram of an LDM (roadmap LM-2, FR-M17-12), in Information Engineering (crow’s-foot)
 * notation. A view of the same model the forms edit: choosing an entity opens its editor, and
 * dragging changes only where the picture puts it, never what the model says. Where entities sit
 * is kept in the model’s diagrams, beside its meaning and as one undoable step; an LDM that has
 * not been arranged yet is laid out for the picture without that being stored.
 */

const HEAD = 30;
const ROW = 17;
const MAX_ROWS = 9;
const PAD = 220;
const MIN_W = 176;
const MAX_W = 300;

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

const boxOf = (e: LogicalEntity, p: P): Box => ({ x: p.x, y: p.y, w: widthOf(e), h: heightOf(e) });
const centerOf = (b: Box): P => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

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
    // The child (ends[0]) of an identifying relationship is below its parent, as a key is below what it identifies.
    edges: m.relationships.map((r) => ({ from: r.ends[0].entity, to: r.ends[1].entity, up: r.identifying })),
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

export function LdmDiagram({ m, selected, onSelect, onPositions, onNewEntity, onNewRelationship }: { m: LogicalModel; selected: string | null; onSelect: (id: string) => void; onPositions: (positions: Record<string, P>) => void; onNewEntity: () => void; onNewRelationship: () => void }) {
  // The layout is recomputed when entities or lines change, not when a name or an attribute does.
  const shape = `${m.entities.map((e) => e.id).join(',')}|${m.relationships.map((r) => `${r.id}:${r.ends[0].entity}>${r.ends[1].entity}`).join(',')}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const arranged = useMemo(() => layoutOf(m), [shape]);
  const [moved, setMoved] = useState<Record<string, P>>({});
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; startX: number; startY: number; origin: P; at: P; moved: boolean } | null>(null);
  const justDragged = useRef(0);
  const stored = m.diagrams[0]?.positions;

  // The places kept with the model are the truth: a drag that was committed, an undo of it, or
  // an Arrange all take over from what the pointer last showed.
  useEffect(() => {
    setMoved({});
  }, [stored]);

  const positions = { ...arranged, ...(stored ?? {}), ...moved };
  const boxes = new Map<string, Box>(m.entities.map((e) => [e.id, boxOf(e, positions[e.id] ?? { x: 0, y: 0 })]));
  const all = [...boxes.values()];
  const minX = all.length ? Math.min(...all.map((b) => b.x)) - PAD : 0;
  const minY = all.length ? Math.min(...all.map((b) => b.y)) - PAD : 0;
  const maxX = all.length ? Math.max(...all.map((b) => b.x + b.w)) + PAD : 800;
  const maxY = all.length ? Math.max(...all.map((b) => b.y + b.h)) + PAD : 600;
  const worldW = maxX - minX;
  const worldH = maxY - minY;

  const commit = (next: Record<string, P>) => {
    onPositions(next);
  };

  const arrange = () => commit(layoutOf(m));

  const fit = () => {
    const el = scroller.current;
    if (!el || !worldW || !worldH) return;
    const next = Math.min(1.5, Math.max(0.2, Math.min((el.clientWidth - 24) / worldW, (el.clientHeight - 24) / worldH)));
    setZoom(Number(next.toFixed(2)));
    el.scrollTo(0, 0);
  };

  const pointerDown = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = positions[id];
    drag.current = { id, startX: e.clientX, startY: e.clientY, origin: p, at: p, moved: false };
  };
  const pointerMove = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    const d = drag.current;
    if (!d || d.id !== id) return;
    const dx = (e.clientX - d.startX) / zoom;
    const dy = (e.clientY - d.startY) / zoom;
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
    if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(2, Number((z + 0.15).toFixed(2))));
    else if (e.key === '-') setZoom((z) => Math.max(0.2, Number((z - 0.15).toFixed(2))));
    else if (e.key === '0') fit();
  };

  if (!m.entities.length) {
    return (
      <div className="ldm-diagram">
        <p className="muted pad">The diagram is drawn from the entities. Make one in the Entities section first.</p>
      </div>
    );
  }

  return (
    <div className="ldm-diagram">
      <div className="ldm-diagram-tools">
        <span className="muted">
          Solid: identifying · dashed: other · a foot: many · a ring: optional
        </span>
        <span className="row">
          <button className="btn small" title="Make an entity here, as the Entities section does" onClick={onNewEntity}>
            New entity
          </button>
          <button className="btn small" disabled={!m.entities.length} title={m.entities.length ? 'Make a relationship here, as the Relationships section does' : 'Make an entity first'} onClick={onNewRelationship}>
            New relationship
          </button>
          <button className="btn small" title="Lay every entity out afresh; positions are kept with the model" onClick={arrange}>
            Arrange
          </button>
          <button className="btn small" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(2, Number((z + 0.15).toFixed(2))))}>
            +
          </button>
          <button className="btn small" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.2, Number((z - 0.15).toFixed(2))))}>
            −
          </button>
          <button className="btn small" title="Fit the whole diagram in the view (0)" onClick={fit}>
            Fit
          </button>
        </span>
      </div>
      <div ref={scroller} className="ldm-canvas" tabIndex={0} role="group" aria-label="Entity relationship diagram. Tab to an entity, Enter opens it, arrow keys move it." onKeyDown={keyCanvas}>
        <svg width={Math.round(worldW * zoom)} height={Math.round(worldH * zoom)} viewBox={`${minX} ${minY} ${worldW} ${worldH}`} role="img" aria-label={`${m.name} entity relationship diagram`}>
          <g>
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
            {m.entities.map((e) => {
              const box = boxes.get(e.id);
              if (!box) return null;
              const pks = new Set(e.keys.filter((k) => k.kind === 'primary').flatMap((k) => k.members.flatMap((x) => ('attribute' in x ? [x.attribute] : []))));
              const rows = e.attributes.slice(0, MAX_ROWS);
              return (
                <g
                  key={e.id}
                  className={`ldm-node${selected === e.id ? ' on' : ''}`}
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
                  <rect className="ldm-node-box" width={box.w} height={box.h} rx={5} />
                  <text className="ldm-node-name" x={12} y={20}>
                    {e.name}
                  </text>
                  <line className="ldm-node-rule" x1={0} y1={HEAD - 4} x2={box.w} y2={HEAD - 4} />
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
      </div>
    </div>
  );
}
