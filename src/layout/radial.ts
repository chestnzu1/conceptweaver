import { dagOf, eachPart } from './shared';
import type { LayoutGraph, LayoutRequest, Positions } from './types';

/**
 * Radial tree: one term in the middle, the others on rings around it by how many steps away
 * they are, whichever way the lines between them point. Each term gets a slice of the circle as
 * wide as what lies beyond it needs. Each part of the graph that hangs together gets a tree of
 * its own; `root` is the middle of the part it is in.
 */
export function radialLayout(g: LayoutGraph, o: Pick<LayoutRequest['options'], 'nodeSpacing' | 'layerSpacing' | 'root'>): Positions {
  return eachPart(g, o.nodeSpacing, (part) => radialOf(part, o));
}

/** The term a part is drawn around when none was chosen: its one top, or else a term in the middle of it. */
export function middleOf(g: LayoutGraph): string {
  const d = dagOf(g, true);
  const tops = d.ids.filter((id) => !d.up.get(id)!.length);
  if (tops.length === 1) return tops[0];
  // Two sweeps find a longest way through the part; halfway along it is as near to everything as a quick look can tell.
  const next = neighbours(g);
  const far = (from: string) => {
    const via = new Map<string, string | null>([[from, null]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) for (const v of next.get(queue[i])!) if (!via.has(v)) queue.push((via.set(v, queue[i]), v));
    return { end: queue[queue.length - 1], via };
  };
  const a = far(g.nodes[0].id).end;
  const { end, via } = far(a);
  const path: string[] = [];
  for (let v: string | null | undefined = end; v; v = via.get(v)) path.push(v);
  return path[path.length >> 1];
}

function neighbours(g: LayoutGraph): Map<string, string[]> {
  const next = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) {
    if (e.from === e.to || !next.has(e.from) || !next.has(e.to)) continue;
    if (!next.get(e.from)!.includes(e.to)) next.get(e.from)!.push(e.to);
    if (!next.get(e.to)!.includes(e.from)) next.get(e.to)!.push(e.from);
  }
  return next;
}

function radialOf(g: LayoutGraph, o: Pick<LayoutRequest['options'], 'nodeSpacing' | 'layerSpacing' | 'root'>): Positions {
  const node = new Map(g.nodes.map((n) => [n.id, n]));
  const root = node.has(o.root) ? o.root : middleOf(g);
  const next = neighbours(g);

  // The tree: every term under the one it was first reached from.
  const depth = new Map<string, number>([[root, 0]]);
  const kids = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  const order = [root];
  for (let i = 0; i < order.length; i++) {
    for (const v of next.get(order[i])!) {
      if (depth.has(v)) continue;
      depth.set(v, depth.get(order[i])! + 1);
      kids.get(order[i])!.push(v);
      order.push(v);
    }
  }
  // A slice is shared out by how many ends there are beyond each term.
  const leaves = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const below = kids.get(order[i])!;
    leaves.set(order[i], below.length ? below.reduce((s, c) => s + leaves.get(c)!, 0) : 1);
  }
  const angle = new Map<string, number>();
  const slice = new Map<string, number>([[root, Math.PI * 2]]);
  const from = new Map<string, number>([[root, -Math.PI / 2]]);
  for (const id of order) {
    const [a0, wide] = [from.get(id)!, slice.get(id)!];
    angle.set(id, a0 + wide / 2);
    let a = a0;
    for (const c of kids.get(id)!) {
      const w = (wide * leaves.get(c)!) / leaves.get(id)!;
      from.set(c, a);
      slice.set(c, w);
      a += w;
    }
  }

  // Each ring is far enough out for its terms to fit in their slices, and clear of the ring inside it.
  const rings = Math.max(...depth.values());
  const need = new Array<number>(rings + 1).fill(0);
  const thick = new Array<number>(rings + 1).fill(0);
  for (const id of order) {
    const n = node.get(id)!;
    const [c, s] = [Math.abs(Math.cos(angle.get(id)!)), Math.abs(Math.sin(angle.get(id)!))];
    const k = depth.get(id)!;
    // How much of the ring the box takes up along it, and how much across it.
    const across = n.w * s + n.h * c;
    thick[k] = Math.max(thick[k], n.w * c + n.h * s);
    // A slice of more than half the circle is no wider for the term than half is.
    if (k) need[k] = Math.max(need[k], (across + o.nodeSpacing) / Math.min(slice.get(id)!, Math.PI));
  }
  const radius = [0];
  for (let k = 1; k <= rings; k++) radius[k] = Math.max(need[k], radius[k - 1] + thick[k - 1] / 2 + o.layerSpacing + thick[k] / 2);

  const pos: Positions = new Map();
  for (const id of order) {
    const r = radius[depth.get(id)!];
    pos.set(id, { x: Math.round(Math.cos(angle.get(id)!) * r), y: Math.round(Math.sin(angle.get(id)!) * r) });
  }
  return pos;
}
