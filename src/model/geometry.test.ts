import { describe, expect, it } from 'vitest';
import { edgeGeom, LABEL_H, placeLabels, textWidth, LABEL_FONT, nodeSize, type LabelSpec } from './geometry';
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
