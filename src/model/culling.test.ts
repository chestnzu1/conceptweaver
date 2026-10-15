import { describe, expect, it } from 'vitest';
import { cutPath, detailAt, drawnArea, drawnWhole, GRAPH_LIMIT, lineIn, MARGIN, piecesOf, seen, termIn, type Area } from './culling';

const size = { w: 1000, h: 600 };

describe('the drawn area', () => {
  it('is the view and a margin around it, kept while the view stays inside it', () => {
    const vp = { x: 0, y: 0, k: 1 };
    const a = drawnArea(undefined, vp, size);
    expect(Object.values(seen(vp, size)).map((v) => v + 0)).toEqual([0, 0, 1000, 600]);
    expect(a).toEqual({ x0: -1000 * MARGIN, y0: -600 * MARGIN, x1: 1000 * (1 + MARGIN), y1: 600 * (1 + MARGIN) });
    // A little panning: the same area, the very object, so nothing is drawn again.
    expect(drawnArea(a, { x: -200, y: 100, k: 1 }, size)).toBe(a);
    // Out of it: another, around the view where it is now.
    const b = drawnArea(a, { x: -600, y: 0, k: 1 }, size);
    expect(b).not.toBe(a);
    expect(b.x0).toBe(600 - 1000 * MARGIN);
  });

  it('is made again when zoomed out past it, or zoomed in so far that most of it is out of view', () => {
    const a = drawnArea(undefined, { x: 0, y: 0, k: 1 }, size);
    expect(drawnArea(a, { x: 0, y: 0, k: 0.5 }, size)).not.toBe(a);
    expect(drawnArea(a, { x: 0, y: 0, k: 1.5 }, size)).toBe(a);
    const closer = drawnArea(a, { x: 0, y: 0, k: 4 }, size);
    expect(closer.x1 - closer.x0).toBeCloseTo((1000 / 4) * (1 + 2 * MARGIN));
  });

  it('takes the terms whose boxes may reach into it, and the lines that may cross it', () => {
    const a: Area = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
    expect(termIn(a, 500, 500)).toBe(true);
    expect(termIn(a, -100, 500)).toBe(true);
    expect(termIn(a, -1000, 500)).toBe(false);
    // Both ends far away, the line across the middle.
    expect(lineIn(a, { x: -50_000, y: 500 }, { x: 50_000, y: 500 })).toBe(true);
    expect(lineIn(a, { x: -50_000, y: 5000 }, { x: 50_000, y: 5000 })).toBe(false);
    // A line that bows far enough may reach it.
    expect(lineIn(a, { x: -50_000, y: 1500 }, { x: 50_000, y: 1500 }, -400)).toBe(true);
  });
});

describe('how much is drawn at a zoom', () => {
  it('leaves out the words on the lines below 30 %, and the words and handles of the terms below 20 %', () => {
    expect([1, 0.3, 0.29, 0.2, 0.19, 0.03].map(detailAt)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('draws a graph whole up to a limit, and around chosen terms above it', () => {
    expect(drawnWhole({ terms: new Array(GRAPH_LIMIT) })).toBe(true);
    expect(drawnWhole({ terms: new Array(GRAPH_LIMIT + 1) })).toBe(false);
  });
});

/** Points along a piece of a path, for comparing curves. */
function along(p: { x: number; y: number }[], n = 400): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = 1 - t;
    if (p.length === 2) out.push({ x: s * p[0].x + t * p[1].x, y: s * p[0].y + t * p[1].y });
    else if (p.length === 3) out.push({ x: s * s * p[0].x + 2 * s * t * p[1].x + t * t * p[2].x, y: s * s * p[0].y + 2 * s * t * p[1].y + t * t * p[2].y });
    else out.push({ x: s ** 3 * p[0].x + 3 * s * s * t * p[1].x + 3 * s * t * t * p[2].x + t ** 3 * p[3].x, y: s ** 3 * p[0].y + 3 * s * s * t * p[1].y + 3 * s * t * t * p[2].y + t ** 3 * p[3].y });
  }
  return out;
}

describe('a line cut to the area', () => {
  const a: Area = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
  const inside = (p: { x: number; y: number }) => p.x >= a.x0 && p.x <= a.x1 && p.y >= a.y0 && p.y <= a.y1;

  it('reads the paths the geometry writes', () => {
    expect(piecesOf('M1,2 L3,4')).toEqual([[{ x: 1, y: 2 }, { x: 3, y: 4 }]]);
    expect(piecesOf('M1,2 Q3,4 5,6')).toEqual([[{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]]);
    expect(piecesOf('M-1.5,2 C3,4 5,6 7,-8.25')).toEqual([[{ x: -1.5, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: -8.25 }]]);
    expect(piecesOf('M0,0 L0,10 Q0,16 6,16 L20,16')).toHaveLength(3);
  });

  it('is the line itself where all of it is near the area, and nothing where none of it is in it', () => {
    expect(cutPath('M100,100 L900,900', a)).toEqual({ d: 'M100,100 L900,900', offset: 0 });
    expect(cutPath('M-5000,5000 L5000,5000', a)).toBeUndefined();
  });

  it('keeps of a line far longer than the area only what may be seen, the same line, and where its dashes start', () => {
    const cut = cutPath('M-100000,500 L100000,500', a)!;
    const kept = piecesOf(cut.d);
    const xs = kept.flatMap((p) => p.map((q) => q.x));
    // Within the area and a quarter of it around.
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-250);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1250);
    expect(kept.every((p) => p.every((q) => q.y === 500))).toBe(true);
    // The dashes are as on the whole line: what is kept starts as far along it as it is from its start.
    expect(cut.offset).toBeCloseTo(kept[0][0].x + 100000, 0);
    // A curve drawn straight (its control point on the line, as a line between two terms is) is cut the same way.
    const q = cutPath('M-100000,500 Q0,500 100000,500', a)!;
    expect(piecesOf(q.d)).toEqual([[{ x: -250, y: 500 }, { x: 1250, y: 500 }]]);
    expect(q.offset).toBe(99750);
  });

  it('keeps a curve the curve it was, where it crosses the area', () => {
    // A curve that bends in the area, one that runs through it from far on both sides, and a line with a corner in it.
    for (const path of ['M-5000,-3000 Q500,4000 6000,-3000', 'M-30000,500 C-10000,-4000 12000,6000 40000,700', 'M-20000,200 L300,200 Q320,200 320,220 L320,90000']) {
      const cut = cutPath(path, a);
      expect(cut, path).toBeDefined();
      if (!cut) continue;
      const was = piecesOf(path).flatMap((p) => along(p, 20000)).filter(inside);
      const now = piecesOf(cut.d).flatMap((p) => along(p, 400));
      expect(was.length).toBeGreaterThan(0);
      // Every point of the line in the area is on what is drawn, to half a pixel: on one of its short stretches.
      const toSegment = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
        const l = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l)) : 0;
        return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
      };
      const off = Math.max(...was.map((p) => Math.min(...now.slice(1).map((q, i) => toSegment(p, now[i], q)))));
      expect(off).toBeLessThan(0.5);
      // And what is drawn is the line, not more of it than around the area.
      expect(now.every((q) => q.x > -260 && q.x < 1260 && q.y > -260 && q.y < 1260)).toBe(true);
    }
  });
});
