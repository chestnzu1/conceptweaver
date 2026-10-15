import { validate } from '../model/validation';
import { plain, type WorkerInput } from './local';

/**
 * The checks, off the page: a model in, what they find out, with what they are doing on the way.
 * A quick fix goes out as what it does, in words: it is applied where the model is.
 */
self.onmessage = async (e: MessageEvent<WorkerInput>) => {
  const { model, data, categories, previous, withImports, dl, ref } = e.data;
  try {
    const report = await validate(model, data, categories, previous ?? null, { tick: async (phase) => self.postMessage({ phase }), withImports, askDl: dl ? async () => dl : undefined, ref });
    self.postMessage({ report: plain(report) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
