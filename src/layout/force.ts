import { linksOf } from './shared';
import type { LayoutGraph, LayoutRequest, Positions } from './types';

/** Above this many terms, a term is pushed away only by the ones near it: the work no longer grows with the square of the size. */
const NEAR_ONLY = 1500;

/**
 * Force-directed layout (Fruchterman–Reingold), seeded so the result is repeatable. Terms that
 * are joined pull together, all terms push apart. `nodeSpacing` sets how long a line wants to
 * be and `repulsion` how hard terms push.
 */
export function forceLayout(g: LayoutGraph, o: Pick<LayoutRequest['options'], 'nodeSpacing' | 'repulsion'>): Positions {
  const n = g.nodes.length;
  const pos: Positions = new Map();
  if (!n) return pos;
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  // The length a line settles at: 190 at the usual spacing.
  const k = 154 + o.nodeSpacing;
  const push = k * k * o.repulsion;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const radius = k * Math.sqrt(n) * 0.5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    xs[i] = Math.cos(a) * radius + (rand() - 0.5) * 20;
    ys[i] = Math.sin(a) * radius + (rand() - 0.5) * 20;
  }
  const edges = linksOf(g);
  const iterations = n > 800 ? 80 : 300;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const repel = (i: number, j: number) => {
    let vx = xs[i] - xs[j];
    let vy = ys[i] - ys[j];
    let d2 = vx * vx + vy * vy;
    if (d2 < 0.01) {
      vx = rand() - 0.5;
      vy = rand() - 0.5;
      d2 = vx * vx + vy * vy;
    }
    // Wider horizontally: nodes are wide boxes.
    const fr = push / d2;
    dx[i] += vx * fr * 1.5;
    dy[i] += vy * fr;
    dx[j] -= vx * fr * 1.5;
    dy[j] -= vy * fr;
  };
  // For a large graph: the terms sorted into squares, each pushed by those in its own square and the ones around it.
  const cell = k * 2.5;
  const head = new Map<number, number>();
  const nextIn = new Int32Array(n);
  const cx = new Int32Array(n);
  const cy = new Int32Array(n);
  const keyOf = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768);
  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    if (n <= NEAR_ONLY) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) repel(i, j);
    } else {
      head.clear();
      for (let i = 0; i < n; i++) {
        cx[i] = Math.floor(xs[i] / cell);
        cy[i] = Math.floor(ys[i] / cell);
        const key = keyOf(cx[i], cy[i]);
        nextIn[i] = head.get(key) ?? -1;
        head.set(key, i);
      }
      for (let i = 0; i < n; i++) {
        for (let gx = cx[i] - 1; gx <= cx[i] + 1; gx++) {
          for (let gy = cy[i] - 1; gy <= cy[i] + 1; gy++) {
            for (let j = head.get(keyOf(gx, gy)) ?? -1; j >= 0; j = nextIn[j]) if (j > i) repel(i, j);
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
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
  g.nodes.forEach((t, i) => pos.set(t.id, { x: Math.round(xs[i]), y: Math.round(ys[i]) }));
  return pos;
}
