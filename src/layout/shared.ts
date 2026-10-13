import type { LayoutDirection, LayoutEdge, LayoutGraph, LayoutNode, Positions } from './types';

/** What several layouts need of a graph: who is under whom, what hangs together, and where to put the parts. */

export interface Dag {
  ids: string[];
  node: Map<string, LayoutNode>;
  /** Under each term, the terms below it; over each, the ones above. No rings: an edge that would close one is left out. */
  down: Map<string, string[]>;
  up: Map<string, string[]>;
}

/**
 * The graph as layers can be made of it. Parents sit above children: for "is a" the general
 * term is the parent, for everything else the source is (and, where `members` is set, a class
 * is the parent of its individuals). Rings are broken by dropping the edge that closes each.
 */
export function dagOf(g: LayoutGraph, members = false): Dag {
  const node = new Map(g.nodes.map((n) => [n.id, n]));
  const ids = g.nodes.map((n) => n.id);
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const id of ids) {
    down.set(id, []);
    up.set(id, []);
  }
  for (const e of g.edges) {
    if (e.from === e.to || !node.has(e.from) || !node.has(e.to)) continue;
    const [p, c] = e.up || (members && e.member) ? [e.to, e.from] : [e.from, e.to];
    if (!down.get(p)!.includes(c)) down.get(p)!.push(c);
  }

  // Drop back edges so the rest is a DAG.
  const state = new Map<string, number>();
  for (const root of ids) {
    if (state.get(root)) continue;
    const stack: [string, number][] = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const kids = down.get(top[0])!;
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
  for (const [p, kids] of down) for (const c of kids) up.get(c)!.push(p);
  return { ids, node, down, up };
}

/**
 * The layer of each term: as far below the top as its longest way down, then pulled down next
 * to its nearest child, so that a term with nothing above it does not sit rows away from what
 * it belongs to. `order` is the terms from the top down.
 */
export function layersOf(d: Dag): { layer: Map<string, number>; order: string[] } {
  const layer = new Map<string, number>();
  const pending = new Map<string, number>();
  const order: string[] = [];
  for (const id of d.ids) {
    pending.set(id, d.up.get(id)!.length);
    if (!d.up.get(id)!.length) {
      order.push(id);
      layer.set(id, 0);
    }
  }
  for (let i = 0; i < order.length; i++) {
    const u = order[i];
    for (const v of d.down.get(u)!) {
      layer.set(v, Math.max(layer.get(v) ?? 0, layer.get(u)! + 1));
      pending.set(v, pending.get(v)! - 1);
      if (pending.get(v) === 0) order.push(v);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const kids = d.down.get(order[i])!;
    if (kids.length) layer.set(order[i], Math.min(...kids.map((c) => layer.get(c)!)) - 1);
  }
  return { layer, order };
}

/** The parts of the graph that hang together, each in the order its terms came in; the largest first. */
export function componentsOf(g: LayoutGraph): string[][] {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  const next: number[][] = g.nodes.map(() => []);
  for (const e of g.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    next[a].push(b);
    next[b].push(a);
  }
  const seen = new Uint8Array(g.nodes.length);
  const out: number[][] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    if (seen[i]) continue;
    const part = [i];
    seen[i] = 1;
    for (let k = 0; k < part.length; k++) {
      for (const j of next[part[k]]) {
        if (seen[j]) continue;
        seen[j] = 1;
        part.push(j);
      }
    }
    out.push(part.sort((a, b) => a - b));
  }
  // Stable: parts of one size stay in the order they were met.
  return out.sort((a, b) => b.length - a.length).map((part) => part.map((i) => g.nodes[i].id));
}

/** The part of a graph that these terms and the lines among them make. */
export function partOf(g: LayoutGraph, ids: string[]): LayoutGraph {
  const keep = new Set(ids);
  const node = new Map(g.nodes.map((n) => [n.id, n]));
  return { nodes: ids.map((id) => node.get(id)!), edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boxOf(pos: Positions, node: Map<string, LayoutNode>): Box {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [id, p] of pos) {
    const n = node.get(id);
    const [w, h] = [n?.w ?? 0, n?.h ?? 0];
    b.x0 = Math.min(b.x0, p.x - w / 2);
    b.y0 = Math.min(b.y0, p.y - h / 2);
    b.x1 = Math.max(b.x1, p.x + w / 2);
    b.y1 = Math.max(b.y1, p.y + h / 2);
  }
  return b;
}

/**
 * Lays each part of the graph out on its own and sets the parts beside each other: the largest
 * first, in rows about as wide as the whole is high, so that a graph in many pieces fills the
 * screen rather than a single line. Terms joined to nothing are gathered in a block at the end.
 */
export function eachPart(g: LayoutGraph, gap: number, layout: (part: LayoutGraph) => Positions): Positions {
  const node = new Map(g.nodes.map((n) => [n.id, n]));
  const parts = componentsOf(g);
  const lone = parts.filter((p) => p.length === 1).map((p) => p[0]);
  const laid: { pos: Positions; box: Box }[] = [];
  for (const ids of parts) {
    if (ids.length === 1) continue;
    const pos = layout(partOf(g, ids));
    laid.push({ pos, box: boxOf(pos, node) });
  }
  if (lone.length) {
    const pos = gridOf(lone.map((id) => node.get(id)!), gap);
    laid.push({ pos, box: boxOf(pos, node) });
  }
  const out: Positions = new Map();
  if (!laid.length) return out;
  if (laid.length === 1) {
    for (const [id, p] of laid[0].pos) out.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
    return out;
  }
  const between = Math.max(60, gap * 2);
  const area = laid.reduce((s, l) => s + (l.box.x1 - l.box.x0 + between) * (l.box.y1 - l.box.y0 + between), 0);
  // No row narrower than the widest part; otherwise a little wider than high, as a screen is.
  const limit = Math.max(Math.sqrt(area * 1.6), ...laid.map((l) => l.box.x1 - l.box.x0));
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const { pos, box } of laid) {
    const [w, h] = [box.x1 - box.x0, box.y1 - box.y0];
    if (x > 0 && x + w > limit) {
      x = 0;
      y += rowH + between;
      rowH = 0;
    }
    for (const [id, p] of pos) out.set(id, { x: Math.round(p.x - box.x0 + x), y: Math.round(p.y - box.y0 + y) });
    x += w + between;
    rowH = Math.max(rowH, h);
  }
  return out;
}

/** Terms in rows, a few to a row: where terms go that are joined to nothing. */
export function gridOf(nodes: LayoutNode[], gap: number): Positions {
  const pos: Positions = new Map();
  const perRow = Math.max(4, Math.ceil(Math.sqrt(nodes.length * 2)));
  let y = 0;
  for (let i = 0; i < nodes.length; i += perRow) {
    const row = nodes.slice(i, i + perRow);
    const h = Math.max(...row.map((n) => n.h));
    let x = 0;
    for (const n of row) {
      pos.set(n.id, { x: x + n.w / 2, y: y + h / 2 });
      x += n.w + gap;
    }
    y += h + Math.max(24, gap * 0.66);
  }
  return pos;
}

/**
 * Turns an arrangement made top to bottom into one that runs another way. `across` is where a
 * term is in its layer and `along` how far down the layers it is.
 */
export const turned = (direction: LayoutDirection, across: number, along: number): { x: number; y: number } =>
  direction === 'TB' ? { x: across, y: along } : direction === 'BT' ? { x: across, y: -along } : direction === 'LR' ? { x: along, y: across } : { x: -along, y: across };

/** The size of a term across its layer and along the layers, for a direction. */
export const sized = (direction: LayoutDirection, n: LayoutNode): { across: number; along: number } => (direction === 'TB' || direction === 'BT' ? { across: n.w, along: n.h } : { across: n.h, along: n.w });

/** Lines without a direction, each pair once: what a layout that only asks what is joined to what goes by. */
export function linksOf(g: LayoutGraph): [number, number][] {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  const out: [number, number][] = [];
  for (const e of g.edges as LayoutEdge[]) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) out.push([a, b]);
  }
  return out;
}
