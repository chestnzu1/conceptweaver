import { compute } from './compute';
import type { LayoutRequest, LayoutResult } from './types';

/** A layout that was stopped before it finished, by asking for another or by cancelling. */
export class LayoutCancelled extends Error {
  constructor() {
    super('The layout was cancelled.');
    this.name = 'LayoutCancelled';
  }
}

/**
 * Whether a layout is worth sending to a worker. A small graph is arranged sooner than a worker
 * starts; Dagre and the network layout grow fastest with the size of the graph.
 */
export function heavy(req: LayoutRequest): boolean {
  const n = req.graph.nodes.length;
  return req.kind === 'layered' ? n + req.graph.edges.length > 300 : req.kind === 'force' ? n > 400 : n > 3000;
}

/**
 * Arranges a graph. An expensive layout runs in a worker, which `signal` can stop; without
 * workers (or where one cannot be started) it runs here, after the page has had a chance to
 * show that it is busy.
 */
export function runLayout(req: LayoutRequest, signal?: AbortSignal): Promise<LayoutResult> {
  if (signal?.aborted) return Promise.reject(new LayoutCancelled());
  if (!heavy(req) || typeof Worker === 'undefined') return compute(req);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return compute(req);
  }
  return new Promise<LayoutResult>((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(new LayoutCancelled());
    };
    signal?.addEventListener('abort', stop, { once: true });
    const end = () => {
      signal?.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ result?: LayoutResult; error?: string }>) => {
      end();
      if (e.data.result) resolve(e.data.result);
      else reject(new Error(e.data.error || 'The layout failed.'));
    };
    worker.onerror = (e) => {
      end();
      // A worker that cannot be loaded is no reason to refuse the layout.
      e.preventDefault?.();
      compute(req).then(resolve, reject);
    };
    worker.postMessage(req);
  });
}
