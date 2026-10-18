import { beforeEach, describe, expect, it } from 'vitest';
import { edgeGeom, nodeSize, routeHints } from '../model/geometry';
import { toTurtle } from '../model/rdf';
import { sampleModel, skosSample } from '../model/sample';
import { universitySample } from '../model/sampleUniversity';
import { stressModel } from '../model/stress';
import { layoutOf, useStore, viewOf } from '../model/store';
import { emptyModel, newRelation, newTerm, normalizeModel, type Model } from '../model/types';
import { builtIn, compute, DAGRE_LIMIT, dagreWeight } from './compute';
import { graphOf } from './graph';
import { middleOf } from './radial';
import { heavy, LayoutCancelled, runLayout } from './run';
import { componentsOf } from './shared';
import { DIRECTIONS, LAYOUT_KINDS, noLayout, normalizeLayout, routeOf, routingOf, type LayoutGraph, type LayoutKind, type LayoutRequest, type Places } from './types';

const AUTO = LAYOUT_KINDS.filter((k): k is LayoutRequest['kind'] => k !== 'manual');
const usual = noLayout();
const ask = (kind: LayoutRequest['kind'], graph: LayoutGraph, options: Partial<LayoutRequest['options']> = {}): LayoutRequest => ({ kind, graph, options: { ...usual, ...options } });
const places = async (kind: LayoutRequest['kind'], graph: LayoutGraph, options: Partial<LayoutRequest['options']> = {}): Promise<Places> => (await compute(ask(kind, graph, options))).places;

/** A graph of boxes of the usual size: `a>b` is a line from a to b, `a^b` says b is the more general. */
function graph(spec: string, lone: string[] = []): LayoutGraph {
  const ids = new Set<string>(lone);
  const edges = spec
    .split(/\s+/)
    .filter(Boolean)
    .map((e) => {
      const up = e.includes('^');
      const [from, to] = e.split(up ? '^' : '>');
      ids.add(from).add(to);
      return { from, to, ...(up ? { up: true } : {}) };
    });
  return { nodes: [...ids].map((id) => ({ id, w: 100, h: 40 })), edges };
}

/** The pairs of terms whose boxes lie on each other. */
function overlaps(g: LayoutGraph, at: Places): string[] {
  const out: string[] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    for (let j = i + 1; j < g.nodes.length; j++) {
      const [a, b] = [g.nodes[i], g.nodes[j]];
      if (Math.abs(at[a.id].x - at[b.id].x) < (a.w + b.w) / 2 - 1 && Math.abs(at[a.id].y - at[b.id].y) < (a.h + b.h) / 2 - 1) out.push(`${a.id}+${b.id}`);
    }
  }
  return out;
}

const tree = graph('b^a c^a d^b e^b f^c g^c h^d');
const tangle = graph('b^a c^a d^b d^c e^d a>e e>a f>f x^y y^x', ['lone1', 'lone2']);

describe('every layout', () => {
  it('places every term, once, whatever the graph holds: several superclasses, rings, loops, separate parts', async () => {
    for (const g of [tree, tangle, graphOf(sampleModel()), graphOf(skosSample()), graphOf(universitySample())]) {
      for (const kind of AUTO) {
        const at = await places(kind, g);
        expect(Object.keys(at).sort(), kind).toEqual(g.nodes.map((n) => n.id).sort());
        for (const p of Object.values(at)) expect(Number.isFinite(p.x) && Number.isFinite(p.y), kind).toBe(true);
        expect(new Set(Object.values(at).map((p) => `${p.x},${p.y}`)).size, kind).toBe(g.nodes.length);
      }
    }
  });

  it('keeps the boxes of the terms off each other, at the size each is drawn', async () => {
    const uni = graphOf(universitySample());
    // The network layout settles where the forces leave it, and promises no more than distinct places.
    for (const kind of AUTO.filter((k) => k !== 'force')) {
      for (const g of [tree, tangle, uni]) expect(overlaps(g, await places(kind, g)), kind).toEqual([]);
    }
    // A term made large by its style takes the room it needs.
    const big = { ...tree, nodes: tree.nodes.map((n) => (n.id === 'b' ? { ...n, w: 320, h: 160 } : n)) };
    for (const kind of AUTO.filter((k) => k !== 'force')) expect(overlaps(big, await places(kind, big)), kind).toEqual([]);
  });

  it('gives the same places every time it is asked', async () => {
    const g = graphOf(universitySample());
    for (const kind of AUTO) expect(await places(kind, g), kind).toEqual(await places(kind, g));
  });

  it('answers for nothing and for one term', async () => {
    for (const kind of AUTO) {
      expect(await places(kind, { nodes: [], edges: [] })).toEqual({});
      expect(Object.keys(await places(kind, graph('', ['only'])))).toEqual(['only']);
    }
  });
});

describe('layouts with layers', () => {
  it('put the general above the specific, or before it in whichever direction is asked for', async () => {
    for (const kind of ['hierarchy', 'layered', 'orthogonal'] as const) {
      for (const direction of DIRECTIONS) {
        const at = await places(kind, tree, { direction });
        const along = (id: string) => (direction === 'TB' ? at[id].y : direction === 'BT' ? -at[id].y : direction === 'LR' ? at[id].x : -at[id].x);
        for (const e of tree.edges) expect(along(e.to), `${kind} ${direction} ${e.to} over ${e.from}`).toBeLessThan(along(e.from));
        // Terms of one layer are in a line.
        expect(along('b'), `${kind} ${direction}`).toBe(along('c'));
      }
    }
  });

  it('follow the spacing asked for', async () => {
    for (const kind of ['hierarchy', 'layered', 'orthogonal'] as const) {
      const [near, far] = [await places(kind, tree, { nodeSpacing: 20, layerSpacing: 40 }), await places(kind, tree, { nodeSpacing: 120, layerSpacing: 200 })];
      expect(far.d.y - far.a.y, kind).toBeGreaterThan(near.d.y - near.a.y + 200);
      expect(Math.abs(far.b.x - far.c.x), kind).toBeGreaterThan(Math.abs(near.b.x - near.c.x) + 50);
    }
    // The room is between the boxes, so a layer of tall terms pushes the next one down.
    const tall = { ...tree, nodes: tree.nodes.map((n) => (n.id === 'b' ? { ...n, h: 200 } : n)) };
    const [plain, pushed] = [await places('hierarchy', tree), await places('hierarchy', tall)];
    expect(pushed.d.y - pushed.a.y).toBe(plain.d.y - plain.a.y + 160);
  });

  it('centre a term over what is under it, in the orthogonal tree', async () => {
    const at = await places('orthogonal', tree);
    expect(at.a.x).toBeCloseTo((at.b.x + at.c.x) / 2, 0);
    expect(at.b.x).toBeCloseTo((at.d.x + at.e.x) / 2, 0);
    // A term with two above it hangs under one of them and stays below both.
    const two = await places('orthogonal', graph('b^a c^a d^b d^c'));
    expect(two.d.y).toBeGreaterThan(Math.max(two.b.y, two.c.y));
  });

  it('put a class above its individuals', () => {
    const m = sampleModel();
    const g = graphOf(m);
    const [parasite, film] = ['Parasite', 'Film'].map((n) => m.terms.find((t) => t.name === n)!.id);
    const membership = g.edges.find((e) => e.from === parasite && e.to === film)!;
    expect(membership.up || membership.member).toBe(true);
    for (const kind of ['hierarchy', 'orthogonal'] as const) {
      const at = Object.fromEntries(builtIn(ask(kind, g)));
      expect(at[film].y, kind).toBeLessThan(at[parasite].y);
    }
  });
});

describe('radial tree', () => {
  it('is drawn around the term asked for, with the others further out the more steps away they are', async () => {
    for (const root of ['a', 'd']) {
      const at = await places('radial', tree, { root });
      const from = (id: string) => Math.hypot(at[id].x - at[root].x, at[id].y - at[root].y);
      const steps = root === 'a' ? { b: 1, c: 1, d: 2, e: 2, h: 3 } : { b: 1, h: 1, a: 2, e: 2, c: 3, f: 4 };
      const ids = Object.keys(steps) as (keyof typeof steps)[];
      for (const p of ids) for (const q of ids) if (steps[p]! < steps[q]!) expect(from(p), `${root}: ${p} nearer than ${q}`).toBeLessThan(from(q));
      for (const p of ids) for (const q of ids) if (steps[p] === steps[q]) expect(from(p)).toBeCloseTo(from(q), -1);
    }
  });

  it('chooses a middle by itself: the one top of a hierarchy, or a term halfway along the longest way through', async () => {
    expect(middleOf(tree)).toBe('a');
    expect(middleOf(graph('a>b c>b c>d e>d'))).toBe('c');
    // Each part that hangs together gets a tree of its own.
    const two = graph('b^a c^a y^x z^x');
    const at = await places('radial', two, { root: 'b' });
    expect(Math.hypot(at.x.x - at.y.x, at.x.y - at.y.y)).toBeCloseTo(Math.hypot(at.x.x - at.z.x, at.x.y - at.z.y), -1);
    expect(overlaps(two, at)).toEqual([]);
  });

  it('gives the rings the room asked for', async () => {
    const [near, far] = [await places('radial', tree, { root: 'a', layerSpacing: 40 }), await places('radial', tree, { root: 'a', layerSpacing: 240 })];
    expect(Math.hypot(far.h.x, far.h.y)).toBeGreaterThan(Math.hypot(near.h.x, near.h.y) + 300);
  });
});

describe('circular and network', () => {
  it('puts the terms of a part on one circle, a term beside what is under it', async () => {
    const at = await places('circular', tree);
    const ids = tree.nodes.map((n) => n.id);
    const cx = ids.reduce((s, id) => s + at[id].x, 0) / ids.length;
    const cy = ids.reduce((s, id) => s + at[id].y, 0) / ids.length;
    const radii = ids.map((id) => Math.hypot(at[id].x - cx, at[id].y - cy));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(Math.max(...radii) * 0.2);
    // Round the circle in the order of a walk down the hierarchy: a b d h e c f g.
    const angle = (id: string) => (Math.atan2(at[id].y, at[id].x) + Math.PI * 2.5) % (Math.PI * 2);
    expect([...ids].sort((p, q) => angle(p) - angle(q)).join('')).toBe('abdhecfg');
    const wide = await places('circular', tree, { nodeSpacing: 160 });
    expect(Math.hypot(wide.a.x, wide.a.y)).toBeGreaterThan(Math.hypot(at.a.x, at.a.y) + 100);
  });

  it('spreads a network further with more room and with more repulsion', async () => {
    const g = graphOf(sampleModel());
    const spread = (at: Places) => Math.max(...Object.values(at).map((p) => p.x)) - Math.min(...Object.values(at).map((p) => p.x));
    const base = spread(await places('force', g));
    expect(spread(await places('force', g, { nodeSpacing: 160 }))).toBeGreaterThan(base * 1.2);
    expect(spread(await places('force', g, { repulsion: 3 }))).toBeGreaterThan(base * 1.2);
    expect(spread(await places('force', g, { repulsion: 0.25 }))).toBeLessThan(base);
  });

  it('lays a large graph out by what is near, in a time that does not grow with its square', () => {
    const n = 4000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: 'n' + i, w: 110, h: 40 }));
    const edges = nodes.slice(1).map((x, i) => ({ from: x.id, to: 'n' + (i >> 2), up: true }));
    const t = performance.now();
    const at = builtIn(ask('force', { nodes, edges }));
    expect(at.size).toBe(n);
    expect(performance.now() - t).toBeLessThan(8000);
    for (const kind of ['hierarchy', 'orthogonal', 'radial', 'circular'] as const) {
      const t0 = performance.now();
      expect(builtIn(ask(kind, { nodes, edges })).size).toBe(n);
      expect(performance.now() - t0, kind).toBeLessThan(3000);
    }
  });
});

describe('running a layout', () => {
  it('lays the parts of a graph out apart from each other', async () => {
    const parts = graph('b^a c^a y^x z^x q>r', ['s', 't']);
    expect(componentsOf(parts).map((p) => p.join(''))).toEqual(['bac', 'yxz', 'qr', 's', 't']);
    for (const kind of ['layered', 'orthogonal', 'radial', 'circular'] as const) expect(overlaps(parts, await places(kind, parts)), kind).toEqual([]);
  });

  it('sends only what is expensive to a worker, and lets Dagre be only where it finishes in reasonable time', async () => {
    const sized = (n: number): LayoutGraph => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: 'n' + i, w: 100, h: 40 })), edges: [] });
    expect(heavy(ask('hierarchy', sized(1000)))).toBe(false);
    expect(heavy(ask('layered', sized(301)))).toBe(true);
    expect(heavy(ask('force', sized(401)))).toBe(true);
    expect(heavy(ask('circular', sized(3001)))).toBe(true);
    const over = await compute(ask('layered', sized(DAGRE_LIMIT + 1)));
    expect(over.note).toMatch(/built-in hierarchical layout was used/);
    expect(Object.keys(over.places)).toHaveLength(DAGRE_LIMIT + 1);
    expect((await compute(ask('layered', tree))).note).toBeUndefined();
    // Lines weigh more than terms: the stress model is past what Dagre is given, the large example well within it.
    expect(dagreWeight(graphOf(stressModel()))).toBeGreaterThan(DAGRE_LIMIT);
    expect(dagreWeight(graphOf(universitySample()))).toBeLessThan(DAGRE_LIMIT / 2);
  });

  it('can be cancelled before it starts, and runs here where there are no workers', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(runLayout(ask('force', graphOf(stressModel())), stop.signal)).rejects.toBeInstanceOf(LayoutCancelled);
    expect(Object.keys((await runLayout(ask('layered', graphOf(universitySample())))).places)).toHaveLength(universitySample().terms.length);
  });
});

describe('what is kept of a layout', () => {
  it('is read back from a file as it was written, and made well-formed where it is not', () => {
    const ids = new Set(['a', 'b']);
    expect(normalizeLayout(undefined, ids)).toEqual(noLayout());
    expect(normalizeLayout({ kind: 'spiral', direction: 'up', nodeSpacing: 9999, layerSpacing: 'x', repulsion: -1, routing: 'zigzag', root: 'gone', saved: { a: { x: 1, y: 2 }, gone: { x: 0, y: 0 }, b: { x: 'no' } } }, ids)).toEqual({ ...noLayout(), nodeSpacing: 200, repulsion: 0.25, saved: { a: { x: 1, y: 2 } } });
    const kept = { ...noLayout('radial'), direction: 'LR' as const, nodeSpacing: 60, layerSpacing: 120, repulsion: 2, routing: 'curved' as const, root: 'a', saved: { b: { x: 5, y: 6 } } };
    expect(normalizeLayout(JSON.parse(JSON.stringify(kept)), ids)).toEqual(kept);
  });

  it('routes lines as the layout suggests unless told otherwise', () => {
    expect(routingOf(noLayout('orthogonal'))).toBe('orthogonal');
    expect(routingOf(noLayout('hierarchy'))).toBe('direct');
    expect(routingOf({ kind: 'force', routing: 'curved' })).toBe('curved');
    // The same answer is the same object: nothing is drawn again for asking twice.
    expect(routeOf({ ...noLayout('orthogonal'), direction: 'LR' })).toBe(routeOf({ ...noLayout('layered'), direction: 'LR', routing: 'orthogonal' }));
    expect(routeOf({ ...noLayout('radial'), direction: 'LR' }).dir).toBe('TB');
  });
});

describe('routed lines', () => {
  const at = (id: string, x: number, y: number) => ({ ...newTerm({ name: id }), id, x, y });
  const points = (path: string) => [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  const ortho = { how: 'orthogonal', dir: 'TB' } as const;

  it('leave a term below and arrive above, with nothing but right angles between', () => {
    const [a, b] = [at('a', 0, 0), at('b', 300, 200)];
    const g = edgeGeom(a, b, 0, 'association', undefined, ortho);
    const ps = points(g.path);
    expect(ps[0]).toEqual({ x: 0, y: nodeSize(a).h / 2 + 3 });
    expect(ps[ps.length - 1].x).toBe(300);
    expect(ps[ps.length - 1].y).toBeLessThan(200 - nodeSize(b).h / 2);
    // Every stretch is upright or level, but for the short rounded corners.
    for (let i = 1; i < ps.length; i++) expect(Math.min(Math.abs(ps[i].x - ps[i - 1].x), Math.abs(ps[i].y - ps[i - 1].y))).toBeLessThanOrEqual(6);
    // The arrow points straight down into the term.
    const [tip, l, r] = points(g.arrow);
    expect(tip).toEqual({ x: 300, y: 200 - nodeSize(b).h / 2 - 3 });
    expect(l.y).toBe(r.y);
    expect(l.y).toBeLessThan(tip.y);
  });

  it('run across the layers where two terms are side by side, straight where they are too close, and along columns in a layout of columns', () => {
    const [a, beside, near] = [at('a', 0, 0), at('b', 300, 10), at('c', 60, 30)];
    const side = points(edgeGeom(a, beside, 0, 'association', undefined, ortho).path);
    expect(side[0]).toEqual({ x: nodeSize(a).w / 2 + 3, y: 0 });
    expect(edgeGeom(a, near, 0, 'association', undefined, ortho).path).toBe(edgeGeom(a, near, 0, 'association').path);
    const columns = points(edgeGeom(a, at('d', 300, 200), 0, 'association', undefined, { how: 'orthogonal', dir: 'LR' }).path);
    expect(columns[0]).toEqual({ x: nodeSize(a).w / 2 + 3, y: 0 });
    // A loop from a term to itself is drawn as it always was.
    expect(edgeGeom(a, a, 0, 'association', undefined, ortho).path).toBe(edgeGeom(a, a, 0, 'association').path);
  });

  it('curve from side to side when asked, and stay as they were when not', () => {
    const [a, b] = [at('a', 0, 0), at('b', 300, 200)];
    expect(edgeGeom(a, b, 0, 'association', undefined, { how: 'curved', dir: 'TB' }).path).toMatch(/^M0,23 C0,[\d.]+ 300,[\d.]+ 300,/);
    expect(edgeGeom(a, b, 0, 'association', undefined, { how: 'direct', dir: 'TB' })).toEqual(edgeGeom(a, b, 0, 'association'));
  });

  it('arrive side by side where several come to one term, in the order they come from, with the words where there is room', () => {
    const [p, q, r, low, kid] = [at('p', -300, 0), at('q', 0, 0), at('r', 300, 0), at('low', 0, 200), at('kid', 300, 200)];
    const byId = new Map([p, q, r, low, kid].map((t) => [t.id, t]));
    const rels = [
      { id: 'e1', from: 'r', to: 'low' },
      { id: 'e2', from: 'p', to: 'low' },
      { id: 'e3', from: 'q', to: 'low' },
      { id: 'e4', from: 'kid', to: 'r' },
    ];
    const hints = routeHints(rels, byId, ortho);
    expect([hints.get('e2')!.port, hints.get('e3')!.port, hints.get('e1')!.port]).toEqual([-16, 0, 16]);
    // Three arrive at `low` and one leaves each of the terms above: the words go by the term each line leaves.
    expect(hints.get('e2')!.labelUp).toBe(true);
    // Two lines are at `r` on its lower side, one at `kid`: the words stay by `kid`.
    expect(hints.get('e4')).toEqual({ port: 0, labelUp: false });
    const g = edgeGeom(p, low, 0, 'association', undefined, ortho, hints.get('e2'));
    expect(points(g.path).at(-1)!.x).toBe(-16);
    expect(g.label.x).toBe(-300);
    expect(routeHints(rels, byId, { how: 'direct', dir: 'TB' }).size).toBe(0);
    expect(routeHints(rels, byId, ortho).get('e1')).toBe(hints.get('e1'));
  });
});

describe('arranging a model', () => {
  const st = useStore.getState;
  const meaning = (m: Model) => JSON.stringify({ ...m, layout: undefined, style: undefined, terms: m.terms.map((t) => ({ ...t, x: 0, y: 0 })) });
  const spots = () => Object.fromEntries(viewOf(st()).terms.map((t) => [t.id, `${t.x},${t.y}`]));
  const settled = async (kind: LayoutKind | null = null) => {
    for (let i = 0; i < 200 && st().layoutBusy !== kind; i++) await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 2000 && st().layoutBusy; i++) await new Promise((r) => setTimeout(r, 5));
  };
  const arrange = async (kind: LayoutKind) => {
    st().arrange(kind);
    await settled();
  };

  beforeEach(() => {
    st().replaceModel(sampleModel());
  });

  it('moves terms and changes nothing the ontology says, whichever layout it is', async () => {
    const before = st().model;
    const [said, turtle] = [meaning(before), toTurtle(before)];
    expect(before.layout.kind).toBe('hierarchy');
    for (const kind of AUTO) {
      const was = spots();
      await arrange(kind);
      expect(layoutOf(st()).kind).toBe(kind);
      if (kind !== 'hierarchy') expect(spots(), kind).not.toEqual(was);
      expect(meaning(st().model), kind).toBe(said);
      expect(toTurtle(st().model), kind).toBe(turtle);
      expect(st().model.relations, kind).toBe(before.relations);
    }
    st().setLayout({ routing: 'orthogonal', direction: 'LR', nodeSpacing: 80 });
    await settled();
    expect(toTurtle(st().model)).toBe(turtle);
    expect(toTurtle(st().model)).not.toMatch(/layout|nodeSpacing|orthogonal/i);
  });

  it('keeps the selection and the styles, and is one step to undo', async () => {
    const [film, genre] = st().model.terms;
    st().setStyle((s) => ({ ...s, nodes: { [film.id]: { shape: 'diamond' } } }));
    st().select([film.id, genre.id]);
    const was = spots();
    const steps = st().past.length;
    await arrange('circular');
    expect(st().sel.terms).toEqual([film.id, genre.id]);
    expect(st().model.style.nodes[film.id]).toEqual({ shape: 'diamond' });
    expect(st().past.length).toBe(steps + 1);
    st().undo();
    expect(spots()).toEqual(was);
    expect(st().model.layout.kind).toBe('hierarchy');
    st().redo();
    expect(st().model.layout.kind).toBe('circular');
  });

  it('runs a layout again when a setting that moves terms changes, and not for how lines run', async () => {
    await arrange('orthogonal');
    const was = spots();
    const steps = st().past.length;
    st().setLayout({ routing: 'curved' });
    await settled();
    expect(spots()).toEqual(was);
    expect(st().model.layout.routing).toBe('curved');
    expect(st().past.length).toBe(steps);
    // Repulsion is no setting of the tree: it is kept for the network layout and moves nothing now.
    st().setLayout({ repulsion: 2 });
    await settled();
    expect(spots()).toEqual(was);
    st().setLayout({ direction: 'LR' });
    await settled();
    expect(spots()).not.toEqual(was);
    const [person, actor] = ['Person', 'Actor'].map((n) => st().model.terms.find((t) => t.name === n)!);
    expect(person.x).toBeLessThan(actor.x);
  });

  it('remembers the arrangement made by hand when another layout is chosen, and brings it back', async () => {
    await arrange('manual');
    const film = st().model.terms[0];
    st().moveTerms([film.id], 500, 300);
    const mine = spots();
    await arrange('circular');
    expect(spots()).not.toEqual(mine);
    expect(st().model.layout.saved![film.id]).toEqual({ x: film.x + 500, y: film.y + 300 });
    await arrange('force');
    // Still the one made by hand: an automatic arrangement does not replace it.
    expect(st().model.layout.saved![film.id]).toEqual({ x: film.x + 500, y: film.y + 300 });
    await arrange('manual');
    expect(spots()).toEqual(mine);
    // It is in the file, and read back from it.
    const reread = normalizeModel(JSON.parse(JSON.stringify(st().model)));
    expect(reread.layout).toEqual(st().model.layout);
    // Rearranging does nothing to a manual arrangement.
    st().rearrange();
    await settled();
    expect(spots()).toEqual(mine);
  });

  it('saves and restores positions on request, and takes an automatic arrangement over as manual', async () => {
    await arrange('radial');
    const radial = spots();
    st().keepAsManual();
    expect(st().model.layout.kind).toBe('manual');
    expect(spots()).toEqual(radial);
    st().moveTerms([st().model.terms[0].id], 40, 40);
    st().restorePositions();
    expect(spots()).toEqual(radial);
    st().moveTerms([st().model.terms[0].id], 40, 40);
    const moved = spots();
    st().savePositions();
    st().moveTerms([st().model.terms[1].id], -90, 0);
    st().restorePositions();
    expect(spots()).toEqual(moved);
  });

  it('draws a radial tree around the selected term, or the one chosen for it', async () => {
    const [film, person] = ['Film', 'Person'].map((n) => st().model.terms.find((t) => t.name === n)!);
    const centre = () => {
      const ts = viewOf(st()).terms;
      const far = (id: string) => Math.max(...ts.map((t) => Math.hypot(t.x - ts.find((x) => x.id === id)!.x, t.y - ts.find((x) => x.id === id)!.y)));
      return ts.map((t) => t.id).sort((a, b) => far(a) - far(b))[0];
    };
    st().select([person.id]);
    await arrange('radial');
    expect(centre()).toBe(person.id);
    st().setLayout({ root: film.id });
    await settled();
    expect(centre()).toBe(film.id);
    expect(st().model.layout.root).toBe(film.id);
  });

  it('arranges a subgraph by a layout of its own, leaving the model and the full graph alone', async () => {
    const film = st().model.terms.find((t) => t.name === 'Film')!;
    await arrange('circular');
    const model = st().model;
    st().setSubgraph({ roots: [film.id], depth: 1 });
    await st().visualizeSubgraph();
    expect(layoutOf(st()).kind).toBe('hierarchy');
    const shown = viewOf(st()).terms.length;
    expect(shown).toBeGreaterThan(3);
    expect(shown).toBeLessThan(model.terms.length);
    for (const kind of AUTO) {
      const was = spots();
      await arrange(kind);
      expect(layoutOf(st()).kind).toBe(kind);
      if (kind !== 'hierarchy') expect(spots(), kind).not.toEqual(was);
      expect(Object.keys(spots())).toHaveLength(shown);
    }
    // Nothing of it reached the model: not its places, not its layout, not its history.
    expect(st().model).toBe(model);
    expect(st().model.layout.kind).toBe('circular');
    // The subgraph's manual arrangement is its own too.
    await arrange('manual');
    st().moveTerms([film.id], 70, 0);
    const mine = spots();
    await arrange('radial');
    await arrange('manual');
    expect(spots()).toEqual(mine);
    st().showFullGraph();
    expect(layoutOf(st()).kind).toBe('circular');
    // A subgraph is laid out by its own layout when it is drawn afresh.
    await st().visualizeSubgraph();
    expect(layoutOf(st()).kind).toBe('manual');
  });

  it('lays a new model out as a hierarchy and says so, and leaves one from an older file as it was arranged', () => {
    expect(sampleModel().layout.kind).toBe('hierarchy');
    expect(emptyModel().layout.kind).toBe('manual');
    const old = JSON.parse(JSON.stringify(sampleModel())) as Record<string, unknown>;
    delete old.layout;
    const read = normalizeModel(old);
    expect(read.layout).toEqual(noLayout());
    expect(read.terms.map((t) => [t.x, t.y])).toEqual(sampleModel().terms.map((t) => [t.x, t.y]));
    const m = emptyModel();
    const [a, b] = [newTerm({ name: 'A' }), newTerm({ name: 'B' })];
    m.terms.push(a, b);
    m.relations.push(newRelation({ from: a.id, to: b.id, kind: 'generalization' }));
    const g = graphOf(m);
    expect(g.edges).toEqual([{ from: a.id, to: b.id, up: true }]);
    expect(g.nodes[0]).toEqual({ id: a.id, ...nodeSize(a) });
  });
});
