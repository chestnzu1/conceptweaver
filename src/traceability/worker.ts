import type { ProposalJob } from './contracts';
import { proposalsFor } from './transform';

/**
 * The transformation off the page (roadmap LM-3): the ontology and a logical model in, proposals
 * out. Nothing is written here; the accepted proposals are applied where the LDM lives.
 */
self.onmessage = (e: MessageEvent<ProposalJob>) => {
  try {
    self.postMessage({ result: proposalsFor({ model: e.data.ontology, target: e.data.target, config: e.data.config, origin: e.data.origin }) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
