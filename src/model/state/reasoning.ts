import { ReasoningError, type DlReport, type EngineId, type ReasoningJob, type ReasoningService } from '../../reasoning/contracts';
import { createLocalReasoningService } from '../../reasoning/local';
import { WORKING_COPY } from '../../structure/local';
import { cachedOntology } from '../library';
import { adopt, type Inference, type Reasoning } from '../reasoner';
import { askReasoner, dlRequest, dlResult, type ReasoningResult } from '../reasoning';
import type { Slice, State } from './types';
import type { Model } from '../types';

export type { Inference, Reasoning };

/**
 * A job: reasoning about the model in the editor (src/reasoning). Its answers are each of one
 * revision, kept here beside the model and never saved or undone with it.
 *
 * The fast reasoner is asked only when something on show wants its answer (`requestReasoning`,
 * through `useReasoning` in the components), in a worker, and a job about a revision the model
 * has moved on from is stopped. The OWL 2 DL reasoner is asked when a validation run wants it.
 */

/** How many answers of the fast reasoner are kept, so that an undo finds its revision's answer there. */
const KEPT = 8;

export interface ReasoningSlice {
  reasoning: {
    /** The fast reasoner's answer, and the revision it is of. */
    fast: { revisionId: string; reasoning: Reasoning } | null;
    /** The OWL 2 DL reasoner's last answer, and the revision it is of: its report, and the same in the terms of the model. */
    dl: { revisionId: string; report: DlReport; result: ReasoningResult } | null;
    /** The jobs under way. */
    jobs: ReasoningJob[];
    /** Why the fast reasoner could not answer about a revision, when it could not. */
    failed: { revisionId: string; error: string } | null;
  };
  /** Reasoning as a service: jobs, started, followed and stopped (src/reasoning/contracts.ts). */
  reasoningService: ReasoningService;
  /** Asks the fast reasoner about the model as it is, unless it has answered or is at work on that already. */
  requestReasoning: () => void;
  /** Asks the OWL 2 DL reasoner about the model as it is: its report, or nothing when the job was stopped. */
  reasonWithDl: () => Promise<DlReport | undefined>;
  /** Stops the jobs under way, of one engine or of both. */
  cancelReasoning: (engine?: EngineId) => void;
}

/** The fast reasoner's answer about the model as it is, once there is one. */
export const currentReasoning = (s: Pick<State, 'version' | 'reasoning'>): Reasoning | undefined => (s.reasoning.fast?.revisionId === s.version.revision ? s.reasoning.fast.reasoning : undefined);

export const NO_REASONING: ReasoningSlice['reasoning'] = { fast: null, dl: null, jobs: [], failed: null };

/** The ontologies a model imports, as they were read (the Turtle kept in this browser): they go with it to the DL reasoner. */
export async function importsOf(model: Model): Promise<{ iri: string; text: string }[]> {
  const imports: { iri: string; text: string }[] = [];
  for (const ref of model.externals) {
    if (!ref.imports || !ref.iri) continue;
    const hit = await cachedOntology(ref.id).catch(() => undefined);
    if (hit) imports.push({ iri: ref.iri, text: hit.text });
  }
  return imports;
}

export const reasoningSlice: Slice<ReasoningSlice> = (set, get) => {
  const kept = new Map<string, Reasoning>();
  /** The revision a fast job has been asked for and has not answered yet. */
  let asked = '';
  const service = createLocalReasoningService({
    current: () => ({ model: get().model, ontologyId: get().doc.id ?? WORKING_COPY, revisionId: get().version.revision }),
    askDl: async (model, signal) => askReasoner(get().validation.reasonerUrl, dlRequest(model, await importsOf(model)), { signal }),
    changed: (job) =>
      set((s) => {
        const others = s.reasoning.jobs.filter((j) => j.job !== job.job);
        return { reasoning: { ...s.reasoning, jobs: job.state === 'running' || job.state === 'queued' ? [...others, job] : others } };
      }),
  });
  const ref = () => ({ ontologyId: get().doc.id ?? WORKING_COPY, revisionId: get().version.revision });

  return {
    reasoning: NO_REASONING,
    reasoningService: service,
    requestReasoning: () => {
      const s = get();
      const revisionId = s.version.revision;
      if (s.reasoning.fast?.revisionId === revisionId || asked === revisionId) return;
      const known = kept.get(revisionId);
      if (known) return set((x) => ({ reasoning: { ...x.reasoning, fast: { revisionId, reasoning: known } } }));
      asked = revisionId;
      // What was asked about earlier revisions is not wanted any more.
      for (const j of s.reasoning.jobs) if (j.engine === 'fast') void service.cancel(j.job);
      void (async () => {
        try {
          const job = await service.start({ ...ref(), engine: 'fast' });
          const answer = await service.result(job.job);
          const now = get();
          if (answer.engine !== 'fast' || now.version.revision !== answer.revisionId) return;
          // Taken as the reasoner's answer about the model, so that whatever asks it directly has it too.
          const reasoning = adopt(now.model, answer.derivation);
          kept.set(revisionId, reasoning);
          for (const old of [...kept.keys()].slice(0, Math.max(0, kept.size - KEPT))) kept.delete(old);
          set((x) => ({ reasoning: { ...x.reasoning, fast: { revisionId, reasoning }, failed: null } }));
        } catch (e) {
          // Stopped, or asked about a revision that was gone by then: it is asked again when it is wanted.
          if (e instanceof ReasoningError && (e.code === 'cancelled' || e.code === 'stale-revision')) return;
          if (get().version.revision === revisionId) set((x) => ({ reasoning: { ...x.reasoning, failed: { revisionId, error: e instanceof Error ? e.message : String(e) } } }));
        } finally {
          if (asked === revisionId) asked = '';
        }
      })();
    },
    reasonWithDl: async () => {
      const model = get().model;
      for (const j of get().reasoning.jobs) if (j.engine === 'dl') await service.cancel(j.job);
      try {
        const job = await service.start({ ...ref(), engine: 'dl' });
        const answer = await service.result(job.job);
        if (answer.engine !== 'dl') return undefined;
        set((x) => ({ reasoning: { ...x.reasoning, dl: { revisionId: answer.revisionId, report: answer.report, result: dlResult(model, answer.report) } } }));
        return answer.report;
      } catch {
        return undefined;
      }
    },
    cancelReasoning: (engine) => {
      for (const j of get().reasoning.jobs) if (!engine || j.engine === engine) void service.cancel(j.job);
    },
  };
};
