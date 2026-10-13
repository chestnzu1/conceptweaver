import { compute } from './compute';
import type { LayoutRequest } from './types';

/** A layout worked out off the page, so that the page stays usable while a large graph is arranged. */
self.onmessage = (e: MessageEvent<LayoutRequest>) => {
  compute(e.data).then(
    (result) => self.postMessage({ result }),
    (error: unknown) => self.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
};
