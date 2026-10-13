import { dagOf, eachPart } from './shared';
import type { LayoutGraph, LayoutRequest, Positions } from './types';

/**
 * Every term on a circle. They go round in the order a walk down the hierarchy meets them, so
 * that a term sits beside what is under it and lines between relatives stay short. Each part of
 * the graph that hangs together gets a circle of its own.
 */
export function circularLayout(g: LayoutGraph, o: Pick<LayoutRequest['options'], 'nodeSpacing'>): Positions {
  return eachPart(g, o.nodeSpacing, (part) => circleOf(part, o.nodeSpacing));
}

function circleOf(g: LayoutGraph, gap: number): Positions {
  const d = dagOf(g, true);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const top of d.ids) {
    if (d.up.get(top)!.length || seen.has(top)) continue;
    const stack = [top];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      const below = d.down.get(id)!;
      for (let i = below.length - 1; i >= 0; i--) if (!seen.has(below[i])) stack.push(below[i]);
    }
  }
  const n = order.length;
  const pos: Positions = new Map();
  if (n === 1) return pos.set(order[0], { x: 0, y: 0 });

  // A box takes more of the circle where the circle runs along its long side: at the top and the bottom.
  let angles = order.map((_, i) => -Math.PI / 2 + (i / n) * Math.PI * 2);
  let radius = 0;
  for (let round = 0; round < 3; round++) {
    const arcs = order.map((id, i) => {
      const t = d.node.get(id)!;
      return t.w * Math.abs(Math.sin(angles[i])) + t.h * Math.abs(Math.cos(angles[i])) + gap;
    });
    const around = arcs.reduce((s, a) => s + a, 0);
    // Never so small that terms on opposite sides meet in the middle.
    const reach = Math.max(...order.map((id, i) => (d.node.get(id)!.w * Math.abs(Math.cos(angles[i])) + d.node.get(id)!.h * Math.abs(Math.sin(angles[i]))) / 2)) + gap / 2;
    radius = Math.max(around / (Math.PI * 2), reach);
    let at = -Math.PI / 2 - (arcs[0] / around) * Math.PI;
    angles = arcs.map((a) => {
      const mid = at + (a / around) * Math.PI;
      at += (a / around) * Math.PI * 2;
      return mid;
    });
  }
  order.forEach((id, i) => pos.set(id, { x: Math.round(Math.cos(angles[i]) * radius), y: Math.round(Math.sin(angles[i]) * radius) }));
  return pos;
}
