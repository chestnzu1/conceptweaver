import { derive } from '../model/reasoner';
import type { Model } from '../model/types';

/** The fast reasoner, off the page: a model in, what follows from it out, so that the page stays usable while it works. */
self.onmessage = (e: MessageEvent<{ model: Model }>) => {
  try {
    self.postMessage({ derivation: derive(e.data.model) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
