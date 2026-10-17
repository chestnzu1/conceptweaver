import type { ImpactAnswer, ImpactJob } from './contracts';
import { impactFor, synchronizeFor } from './impact';

/**
 * Impact and synchronization off the page (roadmap LM-4): the ontology and a logical model in, a
 * report and — where asked — reviewed proposals out. Nothing is written here; what is accepted is
 * applied where the LDM lives (ADR-025).
 */
self.onmessage = (e: MessageEvent<ImpactJob>) => {
  try {
    const job = e.data;
    const base = { ontology: job.ontology, origin: job.origin, target: job.target, ...(job.before ? { before: job.before } : {}) };
    let answer: ImpactAnswer;
    if (job.synchronize) {
      const result = synchronizeFor({ ...base, ...(job.dismissed ? { dismissed: job.dismissed } : {}) });
      answer = { report: result.report, proposals: result.proposals };
    } else {
      answer = { report: impactFor(base), proposals: [] };
    }
    self.postMessage({ answer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
