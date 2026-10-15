import type { Viewport } from './state/session';

/**
 * What the canvas draws of a large graph (TD-10, FR-M5-4): the terms and lines in view and a
 * margin around them, not the whole graph, and less detail the further out it is zoomed. The
 * browser repaints every element of the picture as it is panned, so what is drawn, not what the
 * model holds, decides how smoothly it moves.
 *
 * The drawn area is the view and a margin around it, in the graph's own coordinates. It is kept
 * while the view stays inside it, so that panning a little draws nothing new; when the view
 * reaches its edge, or is zoomed in far enough that most of it is out of view, it is made again
 * around the view.
 */

/** A rectangle of the graph, in its own coordinates. */
export interface Area {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Above this many terms the graph is never drawn whole (FR-M5-5): the Graph view draws a subgraph
 * around a class that is chosen, and the model opens on the Structure Explorer. Drawn whole, a
 * graph is worked out anew, line by line, at every edit: at 10,000 terms that is some 200 ms.
 */
export const GRAPH_LIMIT = 12_000;

/** Whether the graph of a model may be drawn whole. */
export const drawnWhole = (m: { terms: readonly unknown[] }): boolean => m.terms.length <= GRAPH_LIMIT;

/**
 * Up to this many terms the graph is drawn whole and in full, as it always was: drawing it all is
 * quick, and only a larger one gains by drawing less.
 */
export const CULL_FROM = 500;

/** How much is drawn around the view, as a share of its width and height on each side. */
export const MARGIN = 0.4;

/** Room around a term's centre for its box, which is never wider or taller than this. */
export const TERM_REACH = 160;

/** The part of the graph in view. */
export function seen(vp: Viewport, size: { w: number; h: number }): Area {
  return { x0: -vp.x / vp.k, y0: -vp.y / vp.k, x1: (size.w - vp.x) / vp.k, y1: (size.h - vp.y) / vp.k };
}

/** The area to draw: the one drawn before while the view is still well inside it, else a new one around the view. */
export function drawnArea(before: Area | undefined, vp: Viewport, size: { w: number; h: number }): Area {
  const v = seen(vp, size);
  const w = v.x1 - v.x0;
  const h = v.y1 - v.y0;
  // Zoomed in far enough that the area is much larger than the view, it is drawn again around the view only.
  const kept = before && v.x0 >= before.x0 && v.y0 >= before.y0 && v.x1 <= before.x1 && v.y1 <= before.y1 && before.x1 - before.x0 <= w * (1 + 2 * MARGIN) * 2;
  if (kept) return before;
  return { x0: v.x0 - w * MARGIN, y0: v.y0 - h * MARGIN, x1: v.x1 + w * MARGIN, y1: v.y1 + h * MARGIN };
}

/** Whether a term centred here may show in the area. */
export const termIn = (a: Area, x: number, y: number): boolean => x >= a.x0 - TERM_REACH && x <= a.x1 + TERM_REACH && y >= a.y0 - TERM_REACH && y <= a.y1 + TERM_REACH;

/**
 * Whether a line between two terms may cross the area: the box around its two ends, widened by
 * how far the line bows (`bow`) and by the terms' own size. A line between two terms out of view
 * that crosses the view is drawn.
 */
export function lineIn(a: Area, from: { x: number; y: number }, to: { x: number; y: number }, bow = 0): boolean {
  const pad = TERM_REACH + Math.abs(bow);
  return Math.max(from.x, to.x) + pad >= a.x0 && Math.min(from.x, to.x) - pad <= a.x1 && Math.max(from.y, to.y) + pad >= a.y0 && Math.min(from.y, to.y) - pad <= a.y1;
}

/**
 * How much of each thing is drawn at a zoom: everything (0); no words on the lines (1), too small
 * to read below 30 %; and below 20 % no words in the terms and no handles to draw a line from
 * them either (2), only the shapes and the lines.
 */
export type Detail = 0 | 1 | 2;
export const LINE_WORDS_FROM = 0.3;
export const TERM_WORDS_FROM = 0.2;
export const detailAt = (k: number): Detail => (k >= LINE_WORDS_FROM ? 0 : k >= TERM_WORDS_FROM ? 1 : 2);

// ---------------------------------------------------------------- lines cut to the area

type P = { x: number; y: number };
/** A piece of a line: a straight stretch (two points), or a quadratic (three) or cubic (four) Bézier curve. */
type Piece = P[];

/** The pieces of an SVG path as the geometry writes it: absolute M, L, Q and C, numbers apart by spaces or commas. */
export function piecesOf(path: string): Piece[] {
  const out: Piece[] = [];
  let at: P | undefined;
  for (const m of path.matchAll(/([MLQC])([^MLQC]*)/g)) {
    const n = (m[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    const pts: P[] = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
    if (m[1] === 'M') at = pts[0];
    else if (at && pts.length === { L: 1, Q: 2, C: 3 }[m[1]]) {
      out.push([at, ...pts]);
      at = pts[pts.length - 1];
    }
  }
  return out;
}

const half = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** A piece split in two at its middle (de Casteljau): the same line, in two. */
function split(p: Piece): [Piece, Piece] {
  if (p.length === 2) {
    const m = half(p[0], p[1]);
    return [[p[0], m], [m, p[1]]];
  }
  if (p.length === 3) {
    const a = half(p[0], p[1]);
    const b = half(p[1], p[2]);
    const m = half(a, b);
    return [[p[0], a, m], [m, b, p[2]]];
  }
  const a = half(p[0], p[1]);
  const b = half(p[1], p[2]);
  const c = half(p[2], p[3]);
  const d = half(a, b);
  const e = half(b, c);
  const m = half(d, e);
  return [[p[0], a, d, m], [m, e, c, p[3]]];
}
const box = (p: Piece): Area => ({ x0: Math.min(...p.map((q) => q.x)), y0: Math.min(...p.map((q) => q.y)), x1: Math.max(...p.map((q) => q.x)), y1: Math.max(...p.map((q) => q.y)) });
const meets = (a: Area, b: Area) => a.x1 >= b.x0 && a.x0 <= b.x1 && a.y1 >= b.y0 && a.y0 <= b.y1;
const within = (a: Area, b: Area) => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
const dist = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y);
/** A piece's length: between its chord and its control polygon, which bound it; for the long, nearly straight pieces cut away, as good as exact. */
function length(p: Piece): number {
  let poly = 0;
  for (let i = 1; i < p.length; i++) poly += dist(p[i - 1], p[i]);
  return (poly + dist(p[0], p[p.length - 1])) / 2;
}
/**
 * The two ends of a piece that is a straight line: a straight stretch, or a curve whose control
 * points lie within a quarter of a pixel of the line between its ends (the curve then strays
 * from it by less than that). Nothing for a curve that bends.
 */
function straight(p: Piece): [P, P] | undefined {
  const [a, b] = [p[0], p[p.length - 1]];
  if (p.length === 2) return [a, b];
  const l = dist(a, b);
  if (!l) return undefined;
  for (const c of p.slice(1, -1)) if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / l > 0.25) return undefined;
  // And between them, not beyond either end.
  for (const c of p.slice(1, -1)) {
    const t = ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / (l * l);
    if (t < 0 || t > 1) return undefined;
  }
  return [a, b];
}

/** Where on the straight line from `a` to `b` (0 at a, 1 at b) it is inside the area (Liang–Barsky); nothing where it is not. */
function clip(a: P, b: P, r: Area): [number, number] | undefined {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - r.x0],
    [dx, r.x1 - a.x],
    [-dy, a.y - r.y0],
    [dy, r.y1 - a.y],
  ]) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return undefined;
  }
  return [t0, t1];
}

const num = (v: number) => String(Math.round(v * 10) / 10);
const command = (p: Piece) => (p.length === 2 ? 'L' : p.length === 3 ? 'Q' : 'C') + p.slice(1).map((q) => `${num(q.x)},${num(q.y)}`).join(' ');

/**
 * A line cut to the drawn area: only what may be seen of it, as the same curves, so that a line
 * hundreds of thousands of pixels long that crosses the view is not drawn, and dashed, all the
 * way. Each piece of it is halved until a half misses the area, and is left out, or lies within
 * the area and a margin around it, and is kept as it is. `offset` is how far along the line what
 * is kept begins, for its dashes to fall where they would on the whole line. Nothing where none
 * of it is in the area; the line as it is where all of it is.
 */
export function cutPath(path: string, area: Area): { d: string; offset: number } | undefined {
  const pieces = piecesOf(path);
  if (!pieces.length) return { d: path, offset: 0 };
  const w = area.x1 - area.x0;
  const h = area.y1 - area.y0;
  const outer = { x0: area.x0 - w / 4, y0: area.y0 - h / 4, x1: area.x1 + w / 4, y1: area.y1 + h / 4 };
  if (pieces.every((p) => within(box(p), outer))) return { d: path, offset: 0 };
  const kept: Piece[][] = [];
  let run: Piece[] | undefined;
  let before = 0;
  let offset: number | undefined;
  const visit = (p: Piece, depth: number) => {
    // A straight piece, which most are, is cut where it crosses the margin, at once.
    const s = depth === 0 ? straight(p) : undefined;
    if (s) {
      const seenPart = clip(s[0], s[1], area);
      const part = seenPart && clip(s[0], s[1], outer);
      if (!part) {
        if (offset === undefined) before += dist(s[0], s[1]);
        run = undefined;
        return;
      }
      const [t0, t1] = part;
      const at = (t: number) => ({ x: s[0].x + (s[1].x - s[0].x) * t, y: s[0].y + (s[1].y - s[0].y) * t });
      if (t0 > 0) run = undefined;
      if (offset === undefined) offset = before + dist(s[0], s[1]) * t0;
      if (!run) kept.push((run = []));
      run.push([at(t0), at(t1)]);
      if (t1 < 1) run = undefined;
      return;
    }
    const b = box(p);
    if (!meets(b, area)) {
      if (offset === undefined) before += length(p);
      run = undefined;
      return;
    }
    if (within(b, outer) || depth > 40) {
      if (offset === undefined) offset = before;
      if (!run) kept.push((run = []));
      run.push(p);
      return;
    }
    const [l, r] = split(p);
    visit(l, depth + 1);
    visit(r, depth + 1);
  };
  for (const p of pieces) visit(p, 0);
  if (!kept.length) return undefined;
  return { d: kept.map((r) => `M${num(r[0][0].x)},${num(r[0][0].y)} ${r.map(command).join(' ')}`).join(' '), offset: offset ?? 0 };
}
