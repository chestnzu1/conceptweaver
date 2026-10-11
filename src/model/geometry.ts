import type { Relation, RelKind, Term } from './types';

export const NODE_H = 40;
export const NODE_MIN_W = 84;
export const NODE_MAX_W = 240;
export const NODE_FONT = '500 14px system-ui, sans-serif';
export const LABEL_FONT = '400 12px system-ui, sans-serif';

export interface Pt {
  x: number;
  y: number;
}

let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

export function textWidth(s: string, font = NODE_FONT): number {
  const key = font + '\n' + s;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) {
    ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  let w: number;
  if (ctx) {
    ctx.font = font;
    w = ctx.measureText(s).width;
  } else {
    w = s.length * 7.5;
  }
  if (widths.size > 20_000) widths.clear();
  widths.set(key, w);
  return w;
}

/** Text drawn on a node: the name, and for a data property its datatype ("Release date : date"). */
export function nodeLabel(t: Pick<Term, 'name' | 'type' | 'range'>): string {
  const datatype = t.type === 'property' && t.range ? ` : ${t.range.split(':')[1]}` : '';
  return (t.name || '') + datatype;
}

export function nodeSize(t: Pick<Term, 'name' | 'type' | 'range'>): { w: number; h: number } {
  const w = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(textWidth(nodeLabel(t) || 'New term')) + 32));
  return { w, h: NODE_H };
}

/** Name as drawn on the node: truncated with an ellipsis when it would overflow. */
export function displayName(name: string): string {
  const max = NODE_MAX_W - 28;
  if (textWidth(name) <= max) return name;
  let lo = 0;
  let hi = name.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(name.slice(0, mid) + '…') <= max) lo = mid;
    else hi = mid - 1;
  }
  return name.slice(0, lo).trimEnd() + '…';
}

/** Point where the ray from the node's centre towards (tx, ty) leaves its box. */
function boxExit(t: Term, tx: number, ty: number, gap = 3): Pt {
  const { w, h } = nodeSize(t);
  const dx = tx - t.x;
  const dy = ty - t.y;
  if (dx === 0 && dy === 0) return { x: t.x, y: t.y };
  const s = Math.min(dx === 0 ? Infinity : (w / 2 + gap) / Math.abs(dx), dy === 0 ? Infinity : (h / 2 + gap) / Math.abs(dy));
  return { x: t.x + dx * s, y: t.y + dy * s };
}

export function pointInNode(t: Term, p: Pt): boolean {
  const { w, h } = nodeSize(t);
  return Math.abs(p.x - t.x) <= w / 2 && Math.abs(p.y - t.y) <= h / 2;
}

export interface EdgeGeom {
  path: string;
  /** Arrowhead polygon points. */
  arrow: string;
  label: Pt;
  fromCard: Pt;
  toCard: Pt;
}

const norm = (x: number, y: number): Pt => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};
const f = (n: number) => Math.round(n * 10) / 10;

function arrowHead(tip: Pt, d: Pt, kind: RelKind): { points: string; inset: number } {
  const len = kind === 'generalization' ? 13 : 9;
  const half = kind === 'generalization' ? 6.5 : 4;
  const bx = tip.x - d.x * len;
  const by = tip.y - d.y * len;
  const points = `${f(tip.x)},${f(tip.y)} ${f(bx - d.y * half)},${f(by + d.x * half)} ${f(bx + d.y * half)},${f(by - d.x * half)}`;
  return { points, inset: kind === 'generalization' ? len : len - 3 };
}

/**
 * Geometry of a relation drawn from `a` to `b`. `offset` bends the edge sideways so that
 * several relations between the same two terms don't overlap.
 */
export function edgeGeom(a: Term, b: Term, offset: number, kind: RelKind): EdgeGeom {
  if (a.id === b.id) {
    const { w, h } = nodeSize(a);
    const size = 34 + Math.abs(offset) * 0.45;
    const p0 = { x: a.x + w / 2 - 26, y: a.y - h / 2 - 3 };
    const p1 = { x: a.x + w / 2 + 3, y: a.y - h / 2 + 12 };
    const head = arrowHead(p1, { x: -1, y: 0 }, kind);
    const end = { x: p1.x + head.inset, y: p1.y };
    return {
      path: `M${f(p0.x)},${f(p0.y)} C${f(p0.x)},${f(p0.y - size)} ${f(end.x + size)},${f(end.y)} ${f(end.x)},${f(end.y)}`,
      arrow: head.points,
      label: { x: a.x + w / 2 + size * 0.35, y: a.y - h / 2 - size * 0.62 },
      fromCard: { x: p0.x - 10, y: p0.y - 10 },
      toCard: { x: p1.x + 14, y: p1.y + 14 },
    };
  }
  // The bend direction is defined in a frame that doesn't depend on which way the relation points.
  const flip = a.id > b.id ? -1 : 1;
  const dir = norm(b.x - a.x, b.y - a.y);
  const n = { x: -dir.y * flip, y: dir.x * flip };
  const c = { x: (a.x + b.x) / 2 + n.x * offset, y: (a.y + b.y) / 2 + n.y * offset };
  const p0 = boxExit(a, c.x, c.y);
  const p1 = boxExit(b, c.x, c.y);
  const dEnd = norm(p1.x - c.x, p1.y - c.y);
  const dStart = norm(c.x - p0.x, c.y - p0.y);
  const head = arrowHead(p1, dEnd, kind);
  const end = { x: p1.x - dEnd.x * head.inset, y: p1.y - dEnd.y * head.inset };
  const side = { x: -dEnd.y, y: dEnd.x };
  return {
    path: `M${f(p0.x)},${f(p0.y)} Q${f(c.x)},${f(c.y)} ${f(end.x)},${f(end.y)}`,
    arrow: head.points,
    label: { x: 0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y },
    fromCard: { x: p0.x + dStart.x * 16 - dStart.y * 11, y: p0.y + dStart.y * 16 + dStart.x * 11 },
    toCard: { x: p1.x - dEnd.x * 24 + side.x * 11, y: p1.y - dEnd.y * 24 + side.y * 11 },
  };
}

/** Sideways offset per relation, fanning out relations that share the same pair of terms. */
export function edgeOffsets(relations: Relation[]): Map<string, number> {
  const groups = new Map<string, string[]>();
  for (const r of relations) {
    const key = r.from < r.to ? `${r.from}|${r.to}` : `${r.to}|${r.from}`;
    const g = groups.get(key);
    if (g) g.push(r.id);
    else groups.set(key, [r.id]);
  }
  const out = new Map<string, number>();
  for (const ids of groups.values()) {
    ids.forEach((id, i) => out.set(id, (i - (ids.length - 1) / 2) * 56));
  }
  return out;
}

export function bounds(terms: Term[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!terms.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of terms) {
    const { w, h } = nodeSize(t);
    x0 = Math.min(x0, t.x - w / 2);
    y0 = Math.min(y0, t.y - h / 2);
    x1 = Math.max(x1, t.x + w / 2);
    y1 = Math.max(y1, t.y + h / 2);
  }
  return { x0, y0, x1, y1 };
}
