import { dagOf, eachPart, layersOf, sized, turned } from './shared';
import type { LayoutGraph, LayoutRequest, Positions } from './types';

/**
 * A tidy tree, as an organisation chart is drawn: each term is centred over what is under it,
 * so that lines turning at right angles run clear of the terms. A term with several terms above
 * it hangs under the lowest of them; its lines to the others cross the rows in between. The
 * work grows with the size of the graph and no faster.
 */
export function treeLayout(g: LayoutGraph, o: Pick<LayoutRequest['options'], 'direction' | 'nodeSpacing' | 'layerSpacing'>): Positions {
  return eachPart(g, o.nodeSpacing, (part) => treeOf(part, o));
}

function treeOf(g: LayoutGraph, o: Pick<LayoutRequest['options'], 'direction' | 'nodeSpacing' | 'layerSpacing'>): Positions {
  const d = dagOf(g, true);
  const { layer, order } = layersOf(d);
  const size = (id: string) => sized(o.direction, d.node.get(id)!);

  // The one term each hangs under: of those above it, the one furthest down.
  const kids = new Map<string, string[]>();
  const tops: string[] = [];
  for (const id of d.ids) kids.set(id, []);
  const under = new Map<string, string>();
  for (const id of d.ids) {
    let best: string | undefined;
    for (const p of d.up.get(id)!) if (best === undefined || layer.get(p)! > layer.get(best)!) best = p;
    if (best !== undefined) under.set(id, best);
  }
  // In the order the graph gives them, so that the same graph always makes the same picture.
  for (const id of d.ids) if (!under.has(id)) tops.push(id);
  for (const p of d.ids) for (const c of d.down.get(p)!) if (under.get(c) === p) kids.get(p)!.push(c);

  // How wide each term is with everything under it, from the bottom up.
  const extent = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const below = kids.get(id)!;
    const sum = below.reduce((s, c) => s + extent.get(c)!, 0) + o.nodeSpacing * Math.max(0, below.length - 1);
    extent.set(id, Math.max(size(id).across, sum));
  }

  // How far down each layer is: a layer is as deep as its deepest term.
  const deep: number[] = [];
  for (const id of d.ids) deep[layer.get(id)!] = Math.max(deep[layer.get(id)!] ?? 0, size(id).along);
  const along: number[] = [];
  for (let i = 0; i < deep.length; i++) along[i] = i ? along[i - 1] + (deep[i - 1] ?? 0) / 2 + o.layerSpacing + (deep[i] ?? 0) / 2 : 0;

  const pos: Positions = new Map();
  const stack: { id: string; start: number }[] = [];
  let at = 0;
  for (const id of tops) {
    stack.push({ id, start: at });
    at += extent.get(id)! + o.nodeSpacing;
  }
  while (stack.length) {
    const { id, start } = stack.pop()!;
    const wide = extent.get(id)!;
    const p = turned(o.direction, start + wide / 2, along[layer.get(id)!]);
    pos.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
    const below = kids.get(id)!;
    const sum = below.reduce((s, c) => s + extent.get(c)!, 0) + o.nodeSpacing * Math.max(0, below.length - 1);
    let x = start + (wide - sum) / 2;
    for (const c of below) {
      stack.push({ id: c, start: x });
      x += extent.get(c)! + o.nodeSpacing;
    }
  }
  return pos;
}
