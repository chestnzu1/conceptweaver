import { describe, expect, it } from 'vitest';
import { anchorAt, anchorPoint, edgeGeom, LABEL_H, nearNode, placeLabels, setNodeLook, SIDES, textWidth, LABEL_FONT, nodeSize, type Anchor, type LabelSpec } from './geometry';
import { newTerm, type Term } from './types';

const term = (id: string, x: number, y: number): Term => newTerm({ id, name: id, x, y });
const spec = (id: string, a: Term, b: Term, label: string): LabelSpec => ({ id, geom: edgeGeom(a, b, 0, 'association'), w: textWidth(label, LABEL_FONT) + 10, ends: [a, b] });
const overlap = (a: { x: number; y: number; w: number }, b: { x: number; y: number; w: number }) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < LABEL_H;

describe('edge labels', () => {
  it('leaves a label in the middle of its edge when nothing is in its way', () => {
    const [a, b, c, d] = [term('a', 0, 0), term('b', 400, 0), term('c', 0, 300), term('d', 400, 300)];
    const specs = [spec('ab', a, b, 'directs some'), spec('cd', c, d, 'acts in some')];
    const at = placeLabels(specs);
    expect(at.get('ab')).toEqual(specs[0].geom.label);
    expect(at.get('cd')).toEqual(specs[1].geom.label);
  });

  it('moves labels apart where edges run into one term side by side', () => {
    // Three classes in a row, each with an edge down to the one below the middle: their midpoints are 52px apart.
    const film = term('Film', 0, 95);
    const from = [term('Actor', -105, 0), term('Director', 0, 0), term('Studio', 105, 0)];
    const specs = from.map((t, i) => spec(t.id, t, film, ['acts in some', 'directs some', 'produces some'][i]));
    const middle = specs.map((s) => ({ ...s.geom.label, w: s.w }));
    expect(overlap(middle[0], middle[1]) && overlap(middle[1], middle[2])).toBe(true);

    const at = placeLabels(specs);
    const placed = specs.map((s) => ({ ...at.get(s.id)!, w: s.w }));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
    // Each is still on its own edge, and clear of the terms at its ends.
    for (const [i, p] of placed.entries()) {
      for (const t of [from[i], film]) {
        const size = nodeSize(t);
        expect(Math.abs(p.x - t.x) < (p.w + size.w) / 2 && Math.abs(p.y - t.y) < (LABEL_H + size.h) / 2).toBe(false);
      }
    }
    // The same layout gives the same places.
    expect(placeLabels(specs)).toEqual(at);
  });
});

describe('ends of a line set by hand', () => {
  const a = term('alpha', 0, 0);
  const b = term('beta', 400, 60);
  const { w, h } = nodeSize(a);
  /** The numbers of a path, to see that it is one. */
  const numbers = (path: string) => (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

  it('names a point on any side of a term, anywhere along it', () => {
    expect(anchorPoint(a, { side: 'top', at: 0.5 })).toEqual({ x: 0, y: -h / 2 - 3 });
    expect(anchorPoint(a, { side: 'bottom', at: 0 })).toEqual({ x: -w / 2, y: h / 2 + 3 });
    expect(anchorPoint(a, { side: 'left', at: 1 })).toEqual({ x: -w / 2 - 3, y: h / 2 });
    expect(anchorPoint(a, { side: 'right', at: 0.25 })).toEqual({ x: w / 2 + 3, y: -h / 4 });
    // Whatever was kept, it is on the side.
    expect(anchorPoint(a, { side: 'top', at: 7 })).toEqual(anchorPoint(a, { side: 'top', at: 1 }));
  });

  it('finds the side and the place a point is nearest to, and the middle of a side when near it', () => {
    expect(anchorAt(a, { x: 0, y: -200 })).toEqual({ side: 'top', at: 0.5 });
    expect(anchorAt(a, { x: w / 2 + 40, y: 1 })).toEqual({ side: 'right', at: 0.5 });
    expect(anchorAt(a, { x: -w / 4, y: h })).toEqual({ side: 'bottom', at: 0.25 });
    expect(anchorAt(a, { x: -w, y: -h / 4 })).toEqual({ side: 'left', at: 0.25 });
    // A place that was kept is found again from the point it names.
    for (const side of SIDES) {
      for (const at of [0, 0.2, 0.5, 0.85, 1]) {
        const back = anchorAt(a, anchorPoint(a, { side, at }, 0));
        if (at > 0 && at < 1) expect(back).toEqual({ side, at });
      }
    }
    expect(nearNode(a, { x: w / 2 + 10, y: 0 }, 12)).toBe(true);
    expect(nearNode(a, { x: w / 2 + 14, y: 0 }, 12)).toBe(false);
  });

  it('stays on its term when the term moves, and in proportion when the term changes size', () => {
    const pin: Anchor = { side: 'right', at: 0.8 };
    const p = anchorPoint(a, pin);
    const moved = anchorPoint({ ...a, x: a.x + 130, y: a.y - 70 }, pin);
    expect(moved).toEqual({ x: p.x + 130, y: p.y - 70 });
    const longer = { ...a, name: 'a much longer name than before' };
    const size = nodeSize(longer);
    expect(size.w).toBeGreaterThan(w);
    expect(anchorPoint(longer, { side: 'top', at: 0.8 })).toEqual({ x: (0.8 - 0.5) * size.w, y: -size.h / 2 - 3 });
    expect(anchorPoint(longer, pin).x).toBe(size.w / 2 + 3);
  });

  it('draws the line from where an end was put, and the other end as before', () => {
    const plain = edgeGeom(a, b, 0, 'association');
    const pin: Anchor = { side: 'bottom', at: 0.7 };
    const g = edgeGeom(a, b, 0, 'association', undefined, undefined, undefined, { from: pin });
    expect(g.ends[0]).toEqual(anchorPoint(a, pin));
    expect(numbers(g.path)[0]).toBeCloseTo(g.ends[0].x, 0);
    expect(numbers(g.path)[1]).toBeCloseTo(g.ends[0].y, 0);
    // The end that was not set still meets its term on the side that faces the line.
    expect(g.ends[1].x).toBeLessThan(b.x);
    expect(Math.abs(g.ends[1].x - plain.ends[1].x)).toBeLessThan(12);
    // With nothing set, nothing changes.
    expect(edgeGeom(a, b, 0, 'association', undefined, undefined, undefined, {})).toEqual(plain);
    expect(edgeGeom(a, b, 0, 'association', undefined, undefined, undefined, undefined)).toEqual(plain);
    // Both ends set.
    const both = edgeGeom(a, b, 0, 'association', undefined, undefined, undefined, { from: pin, to: { side: 'top', at: 0.5 } });
    expect(both.ends).toEqual([anchorPoint(a, pin), anchorPoint(b, { side: 'top', at: 0.5 })]);
  });

  it('bows round its own term rather than through it when an end faces away', () => {
    // Beta is to the right of Alpha; the end on Alpha is put on its left side.
    const g = edgeGeom(a, b, 0, 'association', undefined, undefined, undefined, { from: { side: 'left', at: 0.5 } });
    expect(g.path).toMatch(/^M-?[\d.]+,-?[\d.]+ C/);
    expect(g.ends[0]).toEqual(anchorPoint(a, { side: 'left', at: 0.5 }));
    // It leaves to the left before it turns.
    const [, , c0x] = numbers(g.path);
    expect(c0x).toBeLessThan(g.ends[0].x);
    // Facing the other term it is the straight line it would be anyway.
    expect(edgeGeom(a, b, 0, 'association', undefined, undefined, undefined, { from: { side: 'right', at: 0.5 } }).path).toMatch(/ Q/);
  });

  it('keeps to the kind of line the layout draws', () => {
    const pins = { from: { side: 'bottom', at: 0.3 } as Anchor, to: { side: 'left', at: 0.6 } as Anchor };
    for (const how of ['curved', 'orthogonal'] as const) {
      for (const anchors of [pins, { from: pins.from }, { to: pins.to }, { from: { side: 'top', at: 0 } as Anchor, to: { side: 'top', at: 1 } as Anchor }]) {
        const g = edgeGeom(a, b, 0, 'association', undefined, { how, dir: 'TB' }, undefined, anchors);
        if (anchors.from) expect(g.ends[0]).toEqual(anchorPoint(a, anchors.from));
        if (anchors.to) expect(g.ends[1]).toEqual(anchorPoint(b, anchors.to));
        expect(numbers(g.path).every(Number.isFinite)).toBe(true);
        expect(numbers(g.arrow)).toHaveLength(6);
        expect(Number.isFinite(g.label.x) && Number.isFinite(g.label.y)).toBe(true);
        expect(g.path).toMatch(how === 'curved' ? / C/ : / L/);
        // A line of right angles has only upright and level stretches between its rounded corners.
        if (how === 'orthogonal') expect(g.path).not.toMatch(/ C/);
      }
    }
  });

  it('leaves and arrives square to the sides with right angles, and never doubles back, wherever the ends are put', () => {
    /** The corners of a path of straight stretches with rounded corners, from its start to its end. */
    const corners = (path: string) => {
      const out: { x: number; y: number }[] = [];
      for (const [, cmd, rest] of path.matchAll(/([MLQ])([^MLQ]*)/g)) {
        const n = numbers(rest);
        if (cmd === 'Q') out[out.length - 1] = { x: n[0], y: n[1] };
        else out.push({ x: n[0], y: n[1] });
      }
      return out;
    };
    const way = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
    const unit = (p: { x: number; y: number }, q: { x: number; y: number }) => {
      const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      return { x: Math.round((q.x - p.x) / l), y: Math.round((q.y - p.y) / l) };
    };
    let lines = 0;
    for (const at of [{ x: 400, y: 60 }, { x: -380, y: 40 }, { x: 30, y: 300 }, { x: -20, y: -260 }, { x: 260, y: -220 }, { x: -300, y: 280 }]) {
      const other = { ...b, ...at };
      for (const from of SIDES) {
        for (const to of SIDES) {
          const g = edgeGeom(a, other, 0, 'association', 'none', { how: 'orthogonal', dir: 'TB' }, undefined, { from: { side: from, at: 0.5 }, to: { side: to, at: 0.5 } });
          const c = corners(g.path);
          const steps = c.slice(1).map((p, i) => unit(c[i], p));
          const where = `${from} → ${to}, the other term at ${at.x},${at.y}: ${g.path}`;
          // Every stretch is upright or level.
          expect(steps.every((s) => Math.abs(s.x) + Math.abs(s.y) === 1), where).toBe(true);
          // It leaves the way its side faces, and arrives against the way the other side faces.
          expect(steps[0], where).toEqual(way[from]);
          expect(steps[steps.length - 1], where).toEqual({ x: -way[to].x || 0, y: -way[to].y || 0 });
          // No stretch goes back along the one before it.
          expect(steps.slice(1).every((s, i) => s.x * steps[i].x + s.y * steps[i].y === 0), where).toBe(true);
          expect(c.length, where).toBeLessThanOrEqual(6);
          lines++;
        }
      }
    }
    expect(lines).toBe(96);
  });

  it('follows the outline of a term that is not a box, and leaves a loop as it is', () => {
    setNodeLook(() => ({ shape: 'circle' }));
    try {
      const r = nodeSize(a).w / 2;
      for (const side of SIDES) {
        for (const at of [0.2, 0.5, 0.8]) {
          const p = anchorPoint(a, { side, at }, 0);
          expect(Math.hypot(p.x - a.x, p.y - a.y)).toBeCloseTo(r, 5);
        }
      }
    } finally {
      setNodeLook(null);
    }
    const loop = edgeGeom(a, a, 0, 'association');
    expect(edgeGeom(a, a, 0, 'association', undefined, undefined, undefined, { from: { side: 'bottom', at: 0.5 } })).toEqual(loop);
    expect(loop.ends).toHaveLength(2);
  });
});
