import { nodeSize } from './geometry';
import type { Model } from './types';
import { resolveModel } from './vocab';

export type Positions = Map<string, { x: number; y: number }>;

const LAYER_GAP = 110;
const NODE_GAP = 36;

/**
 * Layered top-down layout. Parents sit above children: for "is a" relations the general
 * term is the parent, for everything else the source is.
 */
export function hierarchyLayout(model: Model): Positions {
  const m = resolveModel(model);
  const ids = new Set(m.terms.map((t) => t.id));
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inn.set(id, []);
  }
  for (const r of m.relations) {
    if (r.from === r.to || !ids.has(r.from) || !ids.has(r.to)) continue;
    const [p, c] = r.kind === 'generalization' ? [r.to, r.from] : [r.from, r.to];
    if (!out.get(p)!.includes(c)) out.get(p)!.push(c);
  }

  // Drop back edges so the rest is a DAG.
  const state = new Map<string, number>();
  for (const root of ids) {
    if (state.get(root)) continue;
    const stack: [string, number][] = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const kids = out.get(top[0])!;
      if (top[1] >= kids.length) {
        state.set(top[0], 2);
        stack.pop();
        continue;
      }
      const v = kids[top[1]];
      const s = state.get(v) ?? 0;
      if (s === 1) {
        kids.splice(top[1], 1);
        continue;
      }
      top[1]++;
      if (s === 0) {
        state.set(v, 1);
        stack.push([v, 0]);
      }
    }
  }
  for (const [p, kids] of out) for (const c of kids) inn.get(c)!.push(p);

  // Longest-path layering.
  const layer = new Map<string, number>();
  const pending = new Map<string, number>();
  const queue: string[] = [];
  for (const id of ids) {
    pending.set(id, inn.get(id)!.length);
    if (!inn.get(id)!.length) {
      queue.push(id);
      layer.set(id, 0);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    for (const v of out.get(u)!) {
      layer.set(v, Math.max(layer.get(v) ?? 0, layer.get(u)! + 1));
      pending.set(v, pending.get(v)! - 1);
      if (pending.get(v) === 0) queue.push(v);
    }
  }

  // Longest-path puts every root on the top row; pull each term down next to its nearest
  // child instead, so relations don't have to cut across the rows in between.
  for (let i = queue.length - 1; i >= 0; i--) {
    const kids = out.get(queue[i])!;
    if (kids.length) layer.set(queue[i], Math.min(...kids.map((c) => layer.get(c)!)) - 1);
  }

  const layers: string[][] = [];
  const isolated: string[] = [];
  for (const t of m.terms) {
    if (!out.get(t.id)!.length && !inn.get(t.id)!.length) isolated.push(t.id);
    else (layers[layer.get(t.id) ?? 0] ??= []).push(t.id);
  }

  // Barycentre sweeps to reduce crossings.
  const order = new Map<string, number>();
  const reindex = () => layers.forEach((l) => l.forEach((id, i) => order.set(id, i)));
  reindex();
  const sortBy = (l: string[], nbrs: Map<string, string[]>) => {
    const key = new Map<string, number>();
    for (const id of l) {
      const ns = nbrs.get(id)!;
      key.set(id, ns.length ? ns.reduce((s, n) => s + order.get(n)!, 0) / ns.length : order.get(id)!);
    }
    l.sort((a, b) => key.get(a)! - key.get(b)!);
    l.forEach((id, i) => order.set(id, i));
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let i = 1; i < layers.length; i++) sortBy(layers[i], inn);
    for (let i = layers.length - 2; i >= 0; i--) sortBy(layers[i], out);
  }

  const byId = new Map(m.terms.map((t) => [t.id, t]));
  const pos: Positions = new Map();
  const placeRow = (row: string[], y: number) => {
    const ws = row.map((id) => nodeSize(byId.get(id)!).w);
    let x = -(ws.reduce((s, w) => s + w, 0) + NODE_GAP * (row.length - 1)) / 2;
    row.forEach((id, i) => {
      pos.set(id, { x: Math.round(x + ws[i] / 2), y });
      x += ws[i] + NODE_GAP;
    });
  };
  layers.forEach((l, i) => placeRow(l, i * LAYER_GAP));
  const perRow = Math.max(4, Math.ceil(Math.sqrt(isolated.length * 2)));
  for (let i = 0; i < isolated.length; i += perRow) {
    placeRow(isolated.slice(i, i + perRow), layers.length * LAYER_GAP + 30 + (i / perRow) * 64);
  }
  return pos;
}

/** Force-directed layout (Fruchterman–Reingold), seeded so the result is repeatable. */
export function forceLayout(m: Model): Positions {
  const n = m.terms.length;
  const pos: Positions = new Map();
  if (!n) return pos;
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const k = 190;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const index = new Map(m.terms.map((t, i) => [t.id, i]));
  const radius = k * Math.sqrt(n) * 0.5;
  m.terms.forEach((_, i) => {
    const a = (i / n) * Math.PI * 2;
    xs[i] = Math.cos(a) * radius + (rand() - 0.5) * 20;
    ys[i] = Math.sin(a) * radius + (rand() - 0.5) * 20;
  });
  const edges: [number, number][] = [];
  for (const r of m.relations) {
    const a = index.get(r.from);
    const b = index.get(r.to);
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b]);
  }
  const iterations = n > 800 ? 80 : 300;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = xs[i] - xs[j];
        let vy = ys[i] - ys[j];
        let d2 = vx * vx + vy * vy;
        if (d2 < 0.01) {
          vx = rand() - 0.5;
          vy = rand() - 0.5;
          d2 = vx * vx + vy * vy;
        }
        // Wider horizontally: nodes are wide boxes.
        const fr = (k * k) / d2;
        dx[i] += vx * fr * 1.5;
        dy[i] += vy * fr;
        dx[j] -= vx * fr * 1.5;
        dy[j] -= vy * fr;
      }
      dx[i] -= xs[i] * 0.02;
      dy[i] -= ys[i] * 0.02;
    }
    for (const [a, b] of edges) {
      const vx = xs[a] - xs[b];
      const vy = ys[a] - ys[b];
      const d = Math.hypot(vx, vy) || 1;
      const fa = d / k;
      dx[a] -= vx * fa;
      dy[a] -= vy * fa;
      dx[b] += vx * fa;
      dy[b] += vy * fa;
    }
    const temp = 120 * (1 - it / iterations) + 1;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(dx[i], dy[i]) || 1;
      const step = Math.min(d, temp);
      xs[i] += (dx[i] / d) * step;
      ys[i] += (dy[i] / d) * step;
    }
  }
  m.terms.forEach((t, i) => pos.set(t.id, { x: Math.round(xs[i]), y: Math.round(ys[i]) }));
  return pos;
}
