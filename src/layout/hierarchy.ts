import { dagOf, layersOf, sized, turned } from './shared';
import type { LayoutGraph, LayoutRequest, Positions } from './types';

/**
 * Layered layout. Parents sit above children: for "is a" relations the general term is the
 * parent, for everything else the source is. Each layer is centred, and ordered to keep lines
 * from crossing. Terms joined to nothing are gathered in a block after the last layer.
 */
export function hierarchyLayout(g: LayoutGraph, o: Pick<LayoutRequest['options'], 'direction' | 'nodeSpacing' | 'layerSpacing'>): Positions {
  const d = dagOf(g);
  const { layer } = layersOf(d);

  const layers: string[][] = [];
  const isolated: string[] = [];
  for (const n of g.nodes) {
    if (!d.down.get(n.id)!.length && !d.up.get(n.id)!.length) isolated.push(n.id);
    else (layers[layer.get(n.id) ?? 0] ??= []).push(n.id);
  }
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];

  // Barycentre sweeps to reduce crossings.
  const order = new Map<string, number>();
  layers.forEach((l) => l.forEach((id, i) => order.set(id, i)));
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
    for (let i = 1; i < layers.length; i++) sortBy(layers[i], d.up);
    for (let i = layers.length - 2; i >= 0; i--) sortBy(layers[i], d.down);
  }

  const size = (id: string) => sized(o.direction, d.node.get(id)!);
  const pos: Positions = new Map();
  const placeRow = (row: string[], along: number) => {
    const ws = row.map((id) => size(id).across);
    let across = -(ws.reduce((s, w) => s + w, 0) + o.nodeSpacing * (row.length - 1)) / 2;
    row.forEach((id, i) => {
      const p = turned(o.direction, across + ws[i] / 2, along);
      pos.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
      across += ws[i] + o.nodeSpacing;
    });
  };
  // A layer is as deep as its deepest term, so that terms made large by their style do not run into the next one.
  const depth = (row: string[]) => (row.length ? Math.max(...row.map((id) => size(id).along)) : 0);
  let along = 0;
  let last = 0;
  layers.forEach((l, i) => {
    const deep = depth(l);
    if (i) along += last / 2 + o.layerSpacing + deep / 2;
    last = deep;
    placeRow(l, along);
  });
  const perRow = Math.max(4, Math.ceil(Math.sqrt(isolated.length * 2)));
  let at = layers.length ? along + last / 2 + o.layerSpacing + 30 : 30;
  for (let i = 0; i < isolated.length; i += perRow) {
    const row = isolated.slice(i, i + perRow);
    const deep = depth(row);
    placeRow(row, layers.length ? at + deep / 2 : at);
    at += deep + 24;
  }
  return pos;
}
