import type { Route } from '../layout/types';
import { propDatatype } from './domains';
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

/**
 * What the graph style says about a node that changes its geometry: its shape, a size set by
 * hand, the size and weight of its label, and words other than its name.
 */
export interface NodeLook {
  shape?: 'rounded' | 'rectangle' | 'ellipse' | 'circle' | 'diamond' | 'hexagon';
  width?: number;
  height?: number;
  fontSize?: number;
  fontWeight?: number;
  /** The words to draw in place of the name, such as the IRI. */
  text?: string;
  /** For a data property whose values are an enumerated datatype: what that datatype is called. */
  datatype?: string;
}

type Sized = Pick<Term, 'name' | 'type' | 'ranges'>;
let lookOf: (t: Sized) => NodeLook | undefined = () => undefined;

/**
 * Tells the geometry how the nodes of the graph on screen are drawn. There is one graph on
 * screen, and everything that measures a node (edges, layout, fitting, the picture export) has to
 * agree with what is drawn, so the canvas sets this once and they all read it. Without it a
 * node is the standard box.
 */
export function setNodeLook(fn: ((t: Sized) => NodeLook | undefined) | null): void {
  lookOf = fn ?? (() => undefined);
}

const fontOf = (look: NodeLook | undefined) => (look?.fontSize || look?.fontWeight ? `${look.fontWeight ?? 500} ${look.fontSize ?? 14}px system-ui, sans-serif` : NODE_FONT);

/** Text drawn on a node: the name, and for a data property its datatype ("Release date : date"). */
export function nodeLabel(t: Sized): string {
  const look = lookOf(t);
  // "date" for xsd:date; an enumerated datatype by its name, and a range that is an expression as
  // written, which only the model knows.
  const key = t.type === 'property' ? propDatatype(t) : undefined;
  const range = t.type === 'property' && t.ranges?.length ? (look?.datatype ?? (!key ? 'data range' : key.startsWith('enum:') ? 'enumeration' : (key.split(':')[1] ?? key))) : '';
  return (look?.text ?? (t.name || '')) + (range ? ` : ${range}` : '');
}

export function nodeSize(t: Sized): { w: number; h: number } {
  const look = lookOf(t);
  const text = Math.ceil(textWidth(nodeLabel(t) || 'New term', fontOf(look)));
  const line = Math.max(NODE_H, Math.round((look?.fontSize ?? 14) * 2.6));
  // Room for the words inside each shape: a diamond or an ellipse is much narrower away from its middle.
  let w = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, text + 32));
  let h = line;
  if (look?.shape === 'ellipse') [w, h] = [Math.round(w * 1.18) + 8, Math.round(line * 1.25)];
  else if (look?.shape === 'circle') w = h = Math.min(150, Math.max(58, text + 26));
  else if (look?.shape === 'diamond') [w, h] = [Math.min(NODE_MAX_W + 80, Math.round(text * 1.45) + 56), Math.round(line * 1.6)];
  else if (look?.shape === 'hexagon') w = Math.min(NODE_MAX_W + 40, Math.max(NODE_MIN_W + 16, text + 58));
  // A size set by hand wins; a circle stays round.
  if (look?.width) w = look.width;
  if (look?.height) h = look.height;
  if (look?.shape === 'circle' && (look.width || look.height)) w = h = look.width ?? look.height!;
  return { w, h };
}

/** How far in from its sides a hexagon's top and bottom edges start. */
export const hexInset = (w: number, h: number) => Math.min(h * 0.32, w * 0.25);

/** The width there is for words inside a node of this size and shape. */
function innerWidth(look: NodeLook | undefined, w: number, h: number): number {
  switch (look?.shape) {
    case 'ellipse':
      return w * 0.8;
    case 'circle':
      return w - 14;
    case 'diamond':
      return w * 0.62;
    case 'hexagon':
      return w - 2 * hexInset(w, h) - 6;
    default:
      return w - 28;
  }
}

/** Name as drawn on the node: truncated with an ellipsis when it would overflow. */
export function displayName(name: string, t?: Sized): string {
  const look = t && lookOf(t);
  const size = t && nodeSize(t);
  const max = size ? Math.max(24, innerWidth(look, size.w, size.h)) : NODE_MAX_W - 28;
  const font = fontOf(look);
  if (textWidth(name, font) <= max) return name;
  let lo = 0;
  let hi = name.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(name.slice(0, mid) + '…', font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return name.slice(0, lo).trimEnd() + '…';
}

/** Point where the ray from the node's centre towards (tx, ty) leaves its outline, whatever its shape. */
function boxExit(t: Term, tx: number, ty: number, gap = 3): Pt {
  const { w, h } = nodeSize(t);
  const dx = tx - t.x;
  const dy = ty - t.y;
  if (dx === 0 && dy === 0) return { x: t.x, y: t.y };
  const [a, b] = [w / 2 + gap, h / 2 + gap];
  const [ax, ay] = [Math.abs(dx), Math.abs(dy)];
  const box = Math.min(dx === 0 ? Infinity : a / ax, dy === 0 ? Infinity : b / ay);
  let s = box;
  switch (lookOf(t)?.shape) {
    case 'ellipse':
    case 'circle':
      s = 1 / Math.hypot(dx / a, dy / b);
      break;
    case 'diamond':
      s = 1 / (ax / a + ay / b);
      break;
    case 'hexagon':
      // Flat on top and below, pointed at the sides: the nearer of the flat edge and the slanted one.
      s = Math.min(box, a / (ax + (hexInset(w, h) / (h / 2)) * ay));
      break;
  }
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
  /** The curve a straight or bent edge follows: its start, its control point and its end. A loop has none. */
  curve?: [Pt, Pt, Pt];
  /** Where the line leaves its first term and where it arrives at its second: where its ends can be taken hold of. */
  ends: [Pt, Pt];
}

export const SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type Side = (typeof SIDES)[number];

/**
 * Where a line meets a term when that was set by hand: a side of the term and how far along it,
 * from 0 (its left or upper end) to 1. Kept this way it stays where it was put when the term is
 * moved, and in the same proportion when the term grows or shrinks with its name.
 */
export interface Anchor {
  side: Side;
  at: number;
}

/** The ends of one line that were set by hand. An end that is not here is placed automatically. */
export interface EdgeAnchors {
  from?: Anchor;
  to?: Anchor;
}

const norm = (x: number, y: number): Pt => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};
const f = (n: number) => Math.round(n * 10) / 10;

/** How an edge ends: a filled head, a hollow one (as "is a" has by default), two open strokes, or nothing. */
export type ArrowHead = 'filled' | 'hollow' | 'open' | 'none';

function arrowHead(tip: Pt, d: Pt, head: ArrowHead): { points: string; inset: number } {
  const big = head === 'hollow' || head === 'open';
  const len = big ? 13 : 9;
  const half = big ? 6.5 : 4;
  const bx = tip.x - d.x * len;
  const by = tip.y - d.y * len;
  const points = `${f(tip.x)},${f(tip.y)} ${f(bx - d.y * half)},${f(by + d.x * half)} ${f(bx + d.y * half)},${f(by - d.x * half)}`;
  // The line stops at the back of a hollow head, and runs to the tip where there is nothing to run into.
  return { points, inset: head === 'hollow' ? len : head === 'filled' ? len - 3 : 0 };
}

/**
 * Geometry of a relation drawn from `a` to `b`. `offset` bends the edge sideways so that
 * several relations between the same two terms don't overlap. The arrowhead follows the kind of
 * relation ("is a" has a hollow one) unless one is asked for. `route` is how the layout wants its
 * lines drawn; without it, or where two terms are too close for anything else, a line runs
 * straight from one to the other. `anchors` are the ends that were set by hand: each is where it
 * was put on its term's outline, and the rest of the line follows from there.
 */
export function edgeGeom(a: Term, b: Term, offset: number, kind: RelKind, arrow?: ArrowHead, route?: Route, hint?: RouteHint, anchors?: EdgeAnchors): EdgeGeom {
  const how: ArrowHead = arrow ?? (kind === 'generalization' ? 'hollow' : 'filled');
  if (a.id === b.id) {
    const { w, h } = nodeSize(a);
    const size = 34 + Math.abs(offset) * 0.45;
    const p0 = { x: a.x + w / 2 - 26, y: a.y - h / 2 - 3 };
    const p1 = { x: a.x + w / 2 + 3, y: a.y - h / 2 + 12 };
    const head = arrowHead(p1, { x: -1, y: 0 }, how);
    const end = { x: p1.x + head.inset, y: p1.y };
    return {
      path: `M${f(p0.x)},${f(p0.y)} C${f(p0.x)},${f(p0.y - size)} ${f(end.x + size)},${f(end.y)} ${f(end.x)},${f(end.y)}`,
      arrow: head.points,
      label: { x: a.x + w / 2 + size * 0.35, y: a.y - h / 2 - size * 0.62 },
      fromCard: { x: p0.x - 10, y: p0.y - 10 },
      toCard: { x: p1.x + 14, y: p1.y + 14 },
      ends: [p0, p1],
    };
  }
  const pinned = anchors?.from || anchors?.to ? anchors : undefined;
  if (route && route.how !== 'direct') {
    const routed = pinned ? pinnedRoute(a, b, how, route, pinned) : routedGeom(a, b, offset, how, route, hint);
    if (routed) return routed;
  }
  // An end set by hand is where it was put; the other is where the line, drawn towards it, leaves its term.
  const pa = pinned?.from && anchorPoint(a, pinned.from);
  const pb = pinned?.to && anchorPoint(b, pinned.to);
  const [ra, rb] = [pa ?? a, pb ?? b];
  // An end put on a side that faces away from the other term would have a straight line run through
  // its own term to reach it. Such a line leaves square to its side instead, and bows round.
  const away = (anchor: Anchor | undefined, at: Pt | undefined, toward: Pt) => !!anchor && !!at && NORMAL[anchor.side].x * (toward.x - at.x) + NORMAL[anchor.side].y * (toward.y - at.y) < 8;
  if (pinned && (away(pinned.from, pa, rb) || away(pinned.to, pb, ra))) return pinnedRoute(a, b, how, { how: 'curved', dir: route?.dir ?? 'TB' }, pinned);
  // The bend direction is defined in a frame that doesn't depend on which way the relation points.
  const flip = a.id > b.id ? -1 : 1;
  const dir = norm(rb.x - ra.x, rb.y - ra.y);
  const n = { x: -dir.y * flip, y: dir.x * flip };
  const c = { x: (ra.x + rb.x) / 2 + n.x * offset, y: (ra.y + rb.y) / 2 + n.y * offset };
  const p0 = pa ?? boxExit(a, c.x, c.y);
  const p1 = pb ?? boxExit(b, c.x, c.y);
  const dEnd = norm(p1.x - c.x, p1.y - c.y);
  const dStart = norm(c.x - p0.x, c.y - p0.y);
  const head = arrowHead(p1, dEnd, how);
  const end = { x: p1.x - dEnd.x * head.inset, y: p1.y - dEnd.y * head.inset };
  const side = { x: -dEnd.y, y: dEnd.x };
  return {
    path: `M${f(p0.x)},${f(p0.y)} Q${f(c.x)},${f(c.y)} ${f(end.x)},${f(end.y)}`,
    arrow: head.points,
    label: { x: 0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y },
    fromCard: { x: p0.x + dStart.x * 16 - dStart.y * 11, y: p0.y + dStart.y * 16 + dStart.x * 11 },
    toCard: { x: p1.x - dEnd.x * 24 + side.x * 11, y: p1.y - dEnd.y * 24 + side.y * 11 },
    curve: [p0, c, p1],
    ends: [p0, p1],
  };
}

// ---------------------------------------------------------------- ends set by hand

/** The point of a term's outline that an anchor names, whatever the term's shape and size. */
export function anchorPoint(t: Term, anchor: Anchor, gap = 3): Pt {
  const { w, h } = nodeSize(t);
  const along = anchor.side === 'top' || anchor.side === 'bottom' ? w : h;
  return sideExit(t, anchor.side, (Math.max(0, Math.min(1, anchor.at)) - 0.5) * along, gap, 1);
}

/**
 * The anchor nearest to a point: the side of the term the point is at, and how far along it. Near
 * the middle of a side it is the middle, which is where most ends are wanted.
 */
export function anchorAt(t: Term, p: Pt): Anchor {
  const { w, h } = nodeSize(t);
  const [dx, dy] = [p.x - t.x, p.y - t.y];
  const upright = Math.abs(dy) / (h / 2) >= Math.abs(dx) / (w / 2);
  const side: Side = upright ? (dy < 0 ? 'top' : 'bottom') : dx < 0 ? 'left' : 'right';
  const raw = Math.max(0, Math.min(1, 0.5 + (upright ? dx / w : dy / h)));
  return { side, at: Math.abs(raw - 0.5) < 0.06 ? 0.5 : Math.round(raw * 100) / 100 };
}

/** Whether a point is on a term or within `margin` of it: near enough to be about that term's outline. */
export function nearNode(t: Term, p: Pt, margin: number): boolean {
  const { w, h } = nodeSize(t);
  return Math.abs(p.x - t.x) <= w / 2 + margin && Math.abs(p.y - t.y) <= h / 2 + margin;
}

/** Where a line drawn from a term's centre towards a point leaves the term's outline. */
export const outlineToward = (t: Term, toward: Pt): Pt => boxExit(t, toward.x, toward.y);

const NORMAL: Record<Side, Pt> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** The side of a term that faces a point. */
function facing(t: Term, p: Pt): Side {
  const { w, h } = nodeSize(t);
  const [dx, dy] = [p.x - t.x, p.y - t.y];
  return Math.abs(dy) / (h / 2) >= Math.abs(dx) / (w / 2) ? (dy < 0 ? 'top' : 'bottom') : dx < 0 ? 'left' : 'right';
}

/**
 * A curved or right-angled line of which at least one end was set by hand. It leaves each term
 * square to the side it is on: an end set by hand on its side, the other on the side that faces
 * it. With right angles it goes out a little from each term and turns as often as it takes to
 * meet without doubling back or passing through either of its own terms; curved, it bows out
 * from each side. Other terms that happen to lie in its way are not gone round.
 */
function pinnedRoute(a: Term, b: Term, head: ArrowHead, route: Route, anchors: EdgeAnchors): EdgeGeom {
  const sideA = anchors.from?.side ?? facing(a, anchors.to ? anchorPoint(b, anchors.to) : b);
  const p0 = anchors.from ? anchorPoint(a, anchors.from) : sideExit(a, sideA, 0);
  const sideB = anchors.to?.side ?? facing(b, p0);
  const p1 = anchors.to ? anchorPoint(b, anchors.to) : sideExit(b, sideB, 0);
  const [n0, n1] = [NORMAL[sideA], NORMAL[sideB]];
  // The line arrives against the way its side faces.
  const tip = arrowHead(p1, { x: -n1.x, y: -n1.y }, head);
  const end = { x: p1.x + n1.x * tip.inset, y: p1.y + n1.y * tip.inset };
  const cards = { fromCard: { x: p0.x + n0.x * 14 - n0.y * 12, y: p0.y + n0.y * 14 + n0.x * 12 }, toCard: { x: p1.x + n1.x * 22 + n1.y * 12, y: p1.y + n1.y * 22 - n1.x * 12 } };
  const seg = (p: Pt) => `${f(p.x)},${f(p.y)}`;
  if (route.how === 'curved') {
    const reach = Math.max(28, Math.min(170, Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.45));
    const c0 = { x: p0.x + n0.x * reach, y: p0.y + n0.y * reach };
    const c1 = { x: p1.x + n1.x * reach, y: p1.y + n1.y * reach };
    const label = { x: (p0.x + 3 * c0.x + 3 * c1.x + p1.x) / 8, y: (p0.y + 3 * c0.y + 3 * c1.y + p1.y) / 8 };
    return { path: `M${seg(p0)} C${seg(c0)} ${seg(c1)} ${seg(end)}`, arrow: tip.points, label, ...cards, curve: [p0, label, p1], ends: [p0, p1] };
  }
  // Out a little from each term, square to its side, and then across by the fewest turns that neither
  // double back on the way out nor come in through the term the line arrives at.
  const STUB = 18;
  const dot = (p: Pt, q: Pt) => p.x * q.x + p.y * q.y;
  const go = (from: Pt, way: Pt, far: number): Pt => ({ x: from.x + way.x * far, y: from.y + way.y * far });
  const s0 = go(p0, n0, STUB);
  const s1 = go(p1, n1, STUB);
  const d = { x: s1.x - s0.x, y: s1.y - s0.y };
  // How far ahead the second of those points is, the way the line leaves; and the way across that.
  const ahead = dot(d, n0);
  const across = { x: -n0.y, y: n0.x };
  const between: Pt[] = [];
  if (dot(n0, n1) === 0) {
    // The two sides are square to each other. One turn does where the line can go on as it left and
    // still arrive from outside; where it cannot, it turns at once and comes in from the side.
    between.push(ahead >= 0 && dot(d, n1) <= 0 ? go(s0, n0, ahead) : go(s0, n1, dot(d, n1)));
  } else if (dot(n0, n1) < 0 && ahead >= 0) {
    // They face each other: across halfway.
    const half = go(s0, n0, ahead / 2);
    between.push(half, go(half, across, dot(d, across)));
  } else if (dot(n0, n1) > 0) {
    // They face the same way: out beyond both, and across there.
    const out = go(s0, n0, Math.max(0, ahead));
    between.push(out, go(out, across, dot(d, across)));
  } else {
    // Back to back: round both terms, on the side that is the shorter way.
    const half = (t: Term) => (across.x !== 0 ? nodeSize(t).w : nodeSize(t).h) / 2;
    const over = Math.max(dot(a, across) + half(a), dot(b, across) + half(b)) + STUB;
    const under = Math.min(dot(a, across) - half(a), dot(b, across) - half(b)) - STUB;
    const [u0, u1] = [dot(s0, across), dot(s1, across)];
    const clear = Math.abs(over - u0) + Math.abs(over - u1) <= Math.abs(under - u0) + Math.abs(under - u1) ? over : under;
    const beside = go(s0, across, clear - u0);
    between.push(beside, go(beside, n0, ahead));
  }
  // Points that repeat, or lie on a straight stretch that goes on the same way, are no turns.
  const turns: Pt[] = [];
  for (const p of [p0, s0, ...between, s1, end]) {
    const last = turns[turns.length - 1];
    const before = turns[turns.length - 2];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    if (last && before) {
      const [was, now] = [{ x: last.x - before.x, y: last.y - before.y }, { x: p.x - last.x, y: p.y - last.y }];
      if (Math.abs(was.x * now.y - was.y * now.x) < 0.5 && dot(was, now) > 0) turns.pop();
    }
    turns.push(p);
  }
  let path = `M${seg(turns[0])}`;
  let longest = { a: turns[0], b: turns[1] ?? turns[0], length: -1 };
  for (let i = 1; i < turns.length; i++) {
    const [from, at, to] = [turns[i - 1], turns[i], turns[i + 1]];
    const length = Math.hypot(at.x - from.x, at.y - from.y);
    if (length > longest.length) longest = { a: from, b: at, length };
    if (!to) {
      path += ` L${seg(at)}`;
      break;
    }
    // A corner is rounded, by no more than half of either stretch that meets in it.
    const r = Math.min(6, length / 2, Math.hypot(to.x - at.x, to.y - at.y) / 2);
    const back = norm(from.x - at.x, from.y - at.y);
    const on = norm(to.x - at.x, to.y - at.y);
    path += r < 0.5 ? ` L${seg(at)}` : ` L${seg({ x: at.x + back.x * r, y: at.y + back.y * r })} Q${seg(at)} ${seg({ x: at.x + on.x * r, y: at.y + on.y * r })}`;
  }
  const label = { x: (longest.a.x + longest.b.x) / 2, y: (longest.a.y + longest.b.y) / 2 };
  return { path, arrow: tip.points, label, ...cards, curve: [longest.a, label, longest.b], ends: [p0, p1] };
}

/** What a routed line is told about the other lines at its two terms. */
export interface RouteHint {
  /** How far from the middle of the side it arrives at the term further down the layers, among the others that arrive there. */
  port: number;
  /** Its words go next to the term further up: more lines arrive at the lower one than leave the upper. */
  labelUp: boolean;
}
const NO_HINT: RouteHint = { port: 0, labelUp: false };
const hints = new Map<string, RouteHint>();
const hintOf = (port: number, labelUp: boolean): RouteHint => {
  const key = port + (labelUp ? 'u' : 'd');
  if (hints.size > 5000) hints.clear();
  return hints.get(key) ?? hints.set(key, { port, labelUp }).get(key)!;
};

/**
 * For lines that are routed: where each arrives at its lower term, so that several arriving at
 * one term do so side by side in the order they come from, and at which end its words go. The
 * same answer is the same object, so a line is drawn again only when its own answer changed.
 */
export function routeHints(relations: Pick<Relation, 'id' | 'from' | 'to'>[], byId: Map<string, Pick<Term, 'id' | 'x' | 'y' | 'name' | 'type' | 'ranges'>>, route: Route): Map<string, RouteHint> {
  const out = new Map<string, RouteHint>();
  if (route.how === 'direct') return out;
  const down = route.dir === 'TB' || route.dir === 'BT';
  const sign = route.dir === 'TB' || route.dir === 'LR' ? 1 : -1;
  const arriving = new Map<string, { id: string; upper: string; across: number }[]>();
  const leaving = new Map<string, number>();
  for (const r of relations) {
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    if (!a || !b || a === b) continue;
    const along = ((down ? b.y - a.y : b.x - a.x) || 1) * sign;
    const [upper, lower] = along > 0 ? [a, b] : [b, a];
    const list = arriving.get(lower.id) ?? arriving.set(lower.id, []).get(lower.id)!;
    list.push({ id: r.id, upper: upper.id, across: down ? upper.x : upper.y });
    leaving.set(upper.id, (leaving.get(upper.id) ?? 0) + 1);
  }
  for (const [lower, list] of arriving) {
    list.sort((p, q) => p.across - q.across || (p.id < q.id ? -1 : 1));
    const t = byId.get(lower)!;
    const size = nodeSize(t);
    const step = list.length > 1 ? Math.min(16, ((down ? size.w : size.h) * 0.6) / (list.length - 1)) : 0;
    list.forEach((e, i) => out.set(e.id, hintOf(Math.round((i - (list.length - 1) / 2) * step * 10) / 10, list.length > (leaving.get(e.upper) ?? 0))));
  }
  return out;
}

/** The point on one side of a node's outline, `shift` along that side from its middle, whatever its shape. */
function sideExit(t: Term, side: Side, shift: number, gap = 3, limit = 0.7): Pt {
  const { w, h } = nodeSize(t);
  const upright = side === 'top' || side === 'bottom';
  // Along the side, and out from the centre to it.
  const [half, out] = upright ? [w / 2, h / 2] : [h / 2, w / 2];
  // A line placed automatically keeps clear of the corners; one set by hand can be anywhere along the side.
  const s = Math.max(-half * limit, Math.min(half * limit, shift));
  let reach = out;
  switch (lookOf(t)?.shape) {
    case 'ellipse':
    case 'circle':
      reach = out * Math.sqrt(1 - (s / half) ** 2);
      break;
    case 'diamond':
      reach = out * (1 - Math.abs(s) / half);
      break;
    case 'hexagon': {
      // Flat on top and below, pointed at the sides.
      const inset = hexInset(w, h);
      reach = upright ? (Math.abs(s) <= half - inset ? out : (out * (half - Math.abs(s))) / inset) : out - (inset * Math.abs(s)) / half;
      break;
    }
  }
  const sign = side === 'bottom' || side === 'right' ? 1 : -1;
  return upright ? { x: t.x + s, y: t.y + sign * (reach + gap) } : { x: t.x + sign * (reach + gap), y: t.y + s };
}

/** The least room between two terms for a line to leave one and turn before it reaches the other. */
const TURN_ROOM = 18;

/**
 * A line that leaves its terms square to their sides: with right angles, or as an S-shaped
 * curve. It runs along the layers of the layout where the two terms are apart that way, across
 * them where they are side by side, and not at all (null) where they overlap or nearly touch.
 */
function routedGeom(a: Term, b: Term, offset: number, head: ArrowHead, route: Route, hint: RouteHint = NO_HINT): EdgeGeom | null {
  const [sa, sb] = [nodeSize(a), nodeSize(b)];
  const roomV = Math.abs(b.y - a.y) - (sa.h + sb.h) / 2;
  const roomH = Math.abs(b.x - a.x) - (sa.w + sb.w) / 2;
  const layersDown = route.dir === 'TB' || route.dir === 'BT';
  const upright = layersDown ? roomV >= TURN_ROOM || roomH < TURN_ROOM : !(roomH >= TURN_ROOM || roomV < TURN_ROOM);
  if ((upright ? roomV : roomH) < TURN_ROOM) return null;

  // From here on `u` runs along the line's way (down the layers) and `v` across it.
  const at = (u: number, v: number): Pt => (upright ? { x: v, y: u } : { x: u, y: v });
  const uOf = (p: Pt) => (upright ? p.y : p.x);
  const vOf = (p: Pt) => (upright ? p.x : p.y);
  const su = Math.sign(uOf(b) - uOf(a)) || 1;
  // Several lines between the same two terms run side by side; which is which does not depend on which way each points.
  const shift = offset * (a.id > b.id ? -1 : 1) * 0.3;
  // Which of the two is further down the layers: there the line has a place of its own among those that arrive.
  const forward = route.dir === 'TB' || route.dir === 'LR' ? su > 0 : su < 0;
  const p0 = sideExit(a, upright ? (su > 0 ? 'bottom' : 'top') : su > 0 ? 'right' : 'left', shift + (forward ? 0 : hint.port));
  const p1 = sideExit(b, upright ? (su > 0 ? 'top' : 'bottom') : su > 0 ? 'left' : 'right', shift + (forward ? hint.port : 0));
  const [u0, u1, v0, v1] = [uOf(p0), uOf(p1), vOf(p0), vOf(p1)];
  const sv = Math.sign(v1 - v0);
  // Where the line crosses over. Of two side by side the outer one turns first, so that they do not cross.
  const lo = Math.min(u0, u1) + 7;
  const hi = Math.max(u0, u1) - 7;
  const mid = Math.max(lo, Math.min(hi, (u0 + u1) / 2 - shift * sv * su * 0.6));
  const tip = arrowHead(p1, at(su, 0), head);
  const end = at(u1 - su * tip.inset, v1);
  // The words go on the stretch the line has most to itself: next to the term further down the
  // layers, as of a term and the many under it, unless more lines arrive there than leave the other.
  const atEnd = forward !== hint.labelUp;
  const [ua, ub, vl] = atEnd ? [mid, u1, v1] : [u0, mid, v0];

  let path: string;
  let label: Pt;
  let curve: [Pt, Pt, Pt];
  if (route.how === 'curved') {
    const c0 = at((u0 + u1) / 2, v0);
    const c1 = at((u0 + u1) / 2, v1);
    path = `M${f(p0.x)},${f(p0.y)} C${f(c0.x)},${f(c0.y)} ${f(c1.x)},${f(c1.y)} ${f(end.x)},${f(end.y)}`;
    label = at((u0 + u1) / 2, (v0 + v1) / 2);
    curve = [p0, label, p1];
  } else {
    const r = Math.min(6, Math.abs(v1 - v0) / 2, Math.abs(mid - u0), Math.abs(u1 - mid));
    const seg = (p: Pt) => `${f(p.x)},${f(p.y)}`;
    path =
      r < 0.5
        ? `M${seg(p0)} L${seg(at(mid, v0))} L${seg(at(mid, v1))} L${seg(end)}`
        : `M${seg(p0)} L${seg(at(mid - su * r, v0))} Q${seg(at(mid, v0))} ${seg(at(mid, v0 + sv * r))} L${seg(at(mid, v1 - sv * r))} Q${seg(at(mid, v1))} ${seg(at(mid + su * r, v1))} L${seg(end)}`;
    label = at((ua + ub) / 2, vl);
    curve = [at(ua, vl), label, at(ub, vl)];
  }
  // The cardinalities sit beside the ends, on the side the line does not turn to.
  const beside = sv || 1;
  return { path, arrow: tip.points, label, fromCard: at(u0 + su * 14, v0 - beside * 12), toCard: at(u1 - su * 22, v1 + beside * 12), curve, ends: [p0, p1] };
}

export const LABEL_H = 18;
/** How far along its edge a label is tried: the middle first, then a little to either side, then further. */
const ALONG = [0.5, 0.36, 0.64, 0.25, 0.75];
/** Above this many labels they all stay in the middle: on a model that size nobody reads them at once. */
const MAX_PLACED = 1500;

export interface LabelSpec {
  id: string;
  geom: EdgeGeom;
  /** Width of the label's box. */
  w: number;
  /** The two terms the edge joins: the label keeps off their boxes. */
  ends: Term[];
}

/**
 * Where each edge label goes. A label sits at the middle of its edge unless that puts it on top
 * of another label, as happens where several edges run into one term. Then it moves along its own
 * edge to where there is room, or failing that to where it covers least. `taken` is what else is
 * written beside the edges and does not move: the cardinalities at their ends. The same layout
 * always gives the same places.
 */
export function placeLabels(specs: LabelSpec[], taken: { x: number; y: number; w: number; h: number }[] = []): Map<string, Pt> {
  const at = specs.map((l) => l.geom.label);
  const out = () => new Map(specs.map((l, i) => [l.id, at[i]]));
  if (specs.length + taken.length < 2 || specs.length > MAX_PLACED) return out();

  const CELL = 96;
  const PAD = 2;
  const grid = new Map<string, Set<number>>();
  const cells = (p: Pt, w: number) => {
    const keys: string[] = [];
    for (let cx = Math.floor((p.x - w / 2 - PAD) / CELL); cx <= Math.floor((p.x + w / 2 + PAD) / CELL); cx++) {
      for (let cy = Math.floor((p.y - LABEL_H / 2 - PAD) / CELL); cy <= Math.floor((p.y + LABEL_H / 2 + PAD) / CELL); cy++) keys.push(cx + ',' + cy);
    }
    return keys;
  };
  const put = (i: number) => cells(at[i], specs[i].w).forEach((k) => (grid.get(k) ?? grid.set(k, new Set()).get(k)!).add(i));
  const take = (i: number) => cells(at[i], specs[i].w).forEach((k) => grid.get(k)?.delete(i));
  const covered = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) =>
    Math.max(0, Math.min(ax + aw / 2, bx + bw / 2) - Math.max(ax - aw / 2, bx - bw / 2)) * Math.max(0, Math.min(ay + ah / 2, by + bh / 2) - Math.max(ay - ah / 2, by - bh / 2));
  /** How much of label i, put at p, would lie on other labels and on the terms at its ends. */
  const cost = (i: number, p: Pt): number => {
    const w = specs[i].w + PAD * 2;
    const h = LABEL_H + PAD * 2;
    let sum = 0;
    const seen = new Set<number>();
    for (const k of cells(p, specs[i].w)) {
      for (const j of grid.get(k) ?? []) {
        if (j === i || seen.has(j)) continue;
        seen.add(j);
        sum += covered(p.x, p.y, w, h, at[j].x, at[j].y, specs[j].w, LABEL_H);
      }
    }
    for (const b of taken) sum += covered(p.x, p.y, w, h, b.x, b.y, b.w, b.h);
    // A label on a term hides the term's name, which is worse than two labels touching.
    for (const t of specs[i].ends) {
      const size = nodeSize(t);
      sum += 3 * covered(p.x, p.y, w, h, t.x, t.y, size.w, size.h);
    }
    return sum;
  };

  specs.forEach((_, i) => put(i));
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (let i = 0; i < specs.length; i++) {
      const curve = specs[i].geom.curve;
      if (!curve || cost(i, at[i]) === 0) continue;
      let best = at[i];
      let least = Infinity;
      for (const t of ALONG) {
        const u = 1 - t;
        const p = { x: u * u * curve[0].x + 2 * u * t * curve[1].x + t * t * curve[2].x, y: u * u * curve[0].y + 2 * u * t * curve[1].y + t * t * curve[2].y };
        const c = cost(i, p);
        // The first place that is as good as any wins, so a label leaves the middle only for something better.
        if (c < least - 0.5) {
          least = c;
          best = p;
        }
      }
      if (best.x !== at[i].x || best.y !== at[i].y) {
        take(i);
        at[i] = best;
        put(i);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out();
}

/** Sideways offset per relation, fanning out relations that share the same pair of terms. */
export function edgeOffsets(relations: Pick<Relation, 'id' | 'from' | 'to'>[]): Map<string, number> {
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
