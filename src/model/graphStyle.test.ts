import { describe, expect, it } from 'vitest';
import { edgeTypesOf } from './edgeKinds';
import { edgeGeom, nodeSize, setNodeLook } from './geometry';
import { dashOf, nodeLookFor, noStyle, normalizeGraphStyle, paint, patchEdges, patchEdgeType, patchNodes, patchNodeType, readableOn, resetOwn, resolveEdge, resolveNode, THEMES, withTheme, type GraphStyle } from './graphStyle';
import { toTurtle } from './rdf';
import { sampleModel } from './sample';
import { stable } from './stable';
import { newTerm, normalizeModel, type Model } from './types';

const sample = (): Model => normalizeModel(JSON.parse(JSON.stringify(sampleModel())));
const term = (m: Model, name: string) => m.terms.find((t) => t.name === name)!;

describe('graph style', () => {
  it('resolves a look from the theme, the kind and the term, the later over the earlier', () => {
    const m = sample();
    const award = { ...term(m, 'Award'), color: '' };
    let s = noStyle();
    // Nothing set: the stylesheet draws it, and the same empty style is handed out each time.
    expect(resolveNode(s, 'class', award)).toEqual({});
    expect(resolveNode(s, 'class', award)).toBe(resolveNode(s, 'class', award));
    s = patchNodeType(s, 'class', { shape: 'hexagon', fill: 'blue', strokeWidth: 2 });
    expect(resolveNode(s, 'class', award)).toEqual({ shape: 'hexagon', fill: 'blue', strokeWidth: 2 });
    expect(resolveNode(s, 'individual', award)).toEqual({});
    s = patchNodes(s, [award.id], { shape: 'diamond', opacity: 0.5 });
    expect(resolveNode(s, 'class', award)).toEqual({ shape: 'diamond', fill: 'blue', strokeWidth: 2, opacity: 0.5 });
    // The same style gives the same object, so a node is not drawn again for nothing.
    expect(resolveNode(s, 'class', award)).toBe(resolveNode(s, 'class', award));
    // A term given a colour on the canvas keeps it over its kind's fill, but not over a fill of its own.
    const film = term(m, 'Film');
    expect(film.color).toBe('amber');
    expect(resolveNode(s, 'class', film)).toEqual({ shape: 'hexagon', strokeWidth: 2 });
    expect(resolveNode(patchNodes(s, [film.id], { fill: '#102a43' }), 'class', film).fill).toBe('#102a43');
    // Taking a term's own style away puts it back on its kind's; setting a property to nothing removes just that.
    expect(resolveNode(resetOwn(s, [award.id], []), 'class', award)).toEqual({ shape: 'hexagon', fill: 'blue', strokeWidth: 2 });
    expect(patchNodes(s, [award.id], { shape: undefined, opacity: undefined }).nodes).toEqual({});
    expect(patchNodeType(s, 'class', { fill: undefined }).nodeTypes.class).toEqual({ shape: 'hexagon', strokeWidth: 2 });
  });

  it('does the same for edges', () => {
    let s = patchEdgeType(noStyle(), 'subClassOf', { color: 'red', width: 3, line: 'dashed' });
    s = patchEdges(s, ['r1'], { color: '#00aa55', curve: 40 });
    expect(resolveEdge(s, 'subClassOf', 'r1')).toEqual({ color: '#00aa55', width: 3, line: 'dashed', curve: 40 });
    expect(resolveEdge(s, 'subClassOf', 'r2')).toEqual({ color: 'red', width: 3, line: 'dashed' });
    expect(resolveEdge(s, 'type', 'r2')).toEqual({});
    expect(dashOf('solid')).toBe('none');
    expect(dashOf('dashed', 2)).not.toBe(dashOf('dotted', 2));
    expect(dashOf(undefined)).toBeUndefined();
  });

  it('knows what kind of edge each relationship of the sample is', () => {
    const m = sample();
    const types = edgeTypesOf(stable(m));
    const of = (from: string, to: string) => types.get(m.relations.find((r) => r.from === term(m, from).id && r.to === term(m, to).id)!.id);
    expect(of('Actor', 'Person')).toBe('subClassOf');
    expect(of('Parasite', 'Film')).toBe('type');
    expect(of('Director', 'Film')).toBe('restriction');
    expect(of('Film', 'Release date')).toBe('dataProperty');
    expect(of('Film', 'Award')).toBe('restriction');
    // A relationship from before, that nobody made an object property, is still drawn as a plain one.
    const old = { ...m, props: m.props.filter((p) => p.name !== 'wins') };
    expect(edgeTypesOf(stable(old)).get(old.relations.find((r) => r.label === 'wins')!.id)).toBe('plain');
  });

  it('names colours that follow the theme, and takes any other as it is', () => {
    expect(paint('blue', 'fill')).toBe('var(--nc-blue-fill)');
    expect(paint('blue', 'line')).toBe('var(--nc-blue-stroke)');
    expect(paint('ink', 'line')).toBe('var(--ink)');
    expect(paint('#AABBCC', 'fill')).toBe('#AABBCC');
    expect(paint(undefined, 'fill')).toBeUndefined();
    expect(paint('javascript:alert(1)', 'fill')).toBeUndefined();
    expect(readableOn('#102a43')).toBe('#ffffff');
    expect(readableOn('#fde68a')).toBe('#14171a');
  });

  it('is kept with the model and never reaches the ontology', () => {
    const m = sample();
    const before = toTurtle(m);
    let style: GraphStyle = withTheme(m.style, THEMES.find((t) => t.id === 'colorful')!);
    style = patchNodes(style, [term(m, 'Film').id], { shape: 'diamond', fill: '#102a43' });
    style = patchEdges(style, [m.relations[0].id], { color: 'red', arrow: 'none' });
    const styled = { ...m, style };
    expect(toTurtle(styled)).toBe(before);
    // A change of style alone is not a change of what the model means: reasoning and validation keep their results.
    stable(m);
    expect(stable(styled)).toBe(m);
    // Saved and opened again, it is the same style.
    const back = normalizeModel(JSON.parse(JSON.stringify(styled)));
    expect(back.style).toEqual(style);
    // A model from before there were styles opens with the standard look.
    const { style: _, ...old } = m;
    expect(normalizeModel(JSON.parse(JSON.stringify(old))).style).toEqual(noStyle());
  });

  it('reads back only what a style can be', () => {
    const s = normalizeGraphStyle(
      {
        theme: 'colorful',
        nodeTypes: { class: { shape: 'star', fill: 'url(#x)', strokeWidth: 99, fontSize: 2, label: 'iri', opacity: -3 }, widget: { shape: 'circle' } },
        edgeTypes: { subClassOf: { color: '#12345', width: 'thick', line: 'wavy', arrow: 'open', curve: 9999, labels: 'no' } },
        nodes: { t1: { shape: 'circle' }, gone: { shape: 'circle' } },
        edges: { r1: { color: 'teal' }, gone: { color: 'teal' } },
      },
      new Set(['t1']),
      new Set(['r1']),
    );
    expect(s).toEqual({ theme: 'colorful', nodeTypes: { class: { strokeWidth: 8, fontSize: 10, label: 'iri', opacity: 0.1 } }, edgeTypes: { subClassOf: { arrow: 'open', curve: 160 } }, nodes: { t1: { shape: 'circle' } }, edges: { r1: { color: 'teal' } } });
  });

  it('measures a node by its shape and meets its outline with its edges', () => {
    const m = sample();
    const a = newTerm({ id: 'a', name: 'Alpha', x: 0, y: 0 });
    const b = newTerm({ id: 'b', name: 'Beta', x: 300, y: 0 });
    const box = nodeSize(a);
    const style = patchNodes(patchNodeType(noStyle(), 'class', { shape: 'circle' }), ['b'], { shape: 'diamond', width: 120, height: 80 });
    setNodeLook(nodeLookFor({ ...m, style }));
    try {
      const circle = nodeSize(a);
      expect(circle.w).toBe(circle.h);
      expect(nodeSize(b)).toEqual({ w: 120, h: 80 });
      // An edge straight across leaves the circle at its radius and reaches the diamond at its point.
      const g = edgeGeom(a, b, 0, 'association');
      expect(g.curve![0].x).toBeCloseTo(circle.w / 2 + 3, 0);
      expect(g.curve![2].x).toBeCloseTo(300 - 60 - 3, 0);
      // Up and to the side, a diamond's outline is nearer its centre than its bounding box is.
      const up = edgeGeom(b, { ...a, x: 400, y: -100 }, 0, 'association');
      expect(Math.hypot(up.curve![0].x - 300, up.curve![0].y)).toBeLessThan(Math.hypot(60, 40) - 10);
      // An arrowhead that was asked for is drawn whatever the kind of relationship.
      expect(edgeGeom(a, b, 0, 'association', 'hollow').arrow).not.toBe(g.arrow);
    } finally {
      setNodeLook(null);
    }
    expect(nodeSize(a)).toEqual(box);
  });
});
