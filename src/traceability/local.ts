import { LogicalError, type CallOptions, type ElementRef, type LogicalChange, type LogicalModel, type LogicalModelEditService } from '../logical/contracts';
import type { Model } from '../model/types';
import { elementOf, newId, removalOf } from '../logical/rules';
import type { AcceptRequest, ApplySynchronizationRequest, ImpactAnswer, ImpactJob, ImpactReport, ImpactRequest, MappingEdit, MappingInput, ProposeRequest, ProposalJob, SynchronizeRequest, SynchronizationResult, TraceQuery, TraceResult, TraceabilityReport, TraceabilityService, TransformationResult, TransformationService } from './contracts';
import { baselineFor, impactFor, madeSources, reportFor, synchronizeFor, traceIn } from './impact';
import { proposalsFor } from './transform';

/**
 * The transformation service of the editor (roadmap LM-3): proposals from the ontology in the
 * editor into one of its logical models, worked out off the page, and their application as one
 * change set of that model. It reads the ontology as it is and never writes it (NFR-17); what it
 * proposes is in memory only until proposals are accepted.
 */

/** What a proposal run is given: the ontology and LDM as plain data, worked on wherever it runs. */
export type Runner = (job: ProposalJob, signal: AbortSignal) => Promise<TransformationResult>;

const cancelled = () => new LogicalError('aborted', 'The proposals were given up.');

/** Proposals worked out on the page itself, yielding to it first: for tests, or where no worker can start. */
export const onThePage: Runner = async (job, signal) => {
  await new Promise((r) => setTimeout(r, 0));
  if (signal.aborted) throw cancelled();
  const result = proposalsFor({ model: job.ontology, target: job.target, config: job.config, origin: job.origin });
  if (signal.aborted) throw cancelled();
  return result;
};

/** Proposals in a worker of their own, which is stopped when the run is given up. */
export const inAWorker: Runner = (job, signal) => {
  if (typeof Worker === 'undefined') return onThePage(job, signal);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return onThePage(job, signal);
  }
  return new Promise<TransformationResult>((resolve, reject) => {
    let done = false;
    const stop = () => {
      done = true;
      worker.terminate();
      reject(cancelled());
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    const end = () => {
      done = true;
      signal.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ result?: TransformationResult; error?: string }>) => {
      end();
      if (e.data.result) resolve(e.data.result);
      else reject(new LogicalError('refused', e.data.error || 'The proposals stopped.'));
    };
    worker.onerror = (e) => {
      if (done) return;
      end();
      // A worker that cannot be loaded is no reason to propose nothing.
      e.preventDefault?.();
      onThePage(job, signal).then(resolve, reject);
    };
    worker.postMessage(job);
  });
};

/** What the transformation service is given of the editor. */
export interface TransformationHost {
  /** The ontology and its LDMs as they are now. */
  current(): { model: Model; ontologyId: string; revisionId: string };
  /** The ontology together with the ones it imports, as far as they are in this browser; nothing where it imports none. */
  withImports(model: Model): Model | undefined;
  /** Changes to the LDMs, each one step of the history. */
  edit: LogicalModelEditService;
}

export function createLocalTransformationService(host: TransformationHost, run: Runner = inAWorker): TransformationService {
  const given = (options?: CallOptions) => {
    if (options?.signal?.aborted) throw cancelled();
  };

  return {
    async propose(request: ProposeRequest, options): Promise<TransformationResult> {
      given(options);
      const now = host.current();
      const target = now.model.logicalModels.find((m) => m.id === request.model);
      if (!target) throw new LogicalError('not-found', `There is no logical model “${request.model}” in the project.`);
      const ontology = request.config.scope.withImports ? (host.withImports(now.model) ?? now.model) : now.model;
      const job: ProposalJob = {
        ontology,
        origin: { ontology: now.ontologyId, revision: now.revisionId },
        target,
        config: request.config,
      };
      const result = await run(job, options?.signal ?? new AbortController().signal);
      return result;
    },

    async apply(request: AcceptRequest, options): Promise<{ model: string; revision: string; applied: number }> {
      given(options);
      const now = host.current();
      const target = now.model.logicalModels.find((m) => m.id === request.result.model);
      if (!target) throw new LogicalError('not-found', `There is no logical model “${request.result.model}” in the project.`);
      if (target.revision !== request.result.baseRevision) {
        throw new LogicalError('stale-revision', `The logical model “${target.name}” has moved on from revision ${request.result.baseRevision}; propose again.`);
      }
      const known = new Set(request.result.proposals.map((p) => p.id));
      const unknown = request.accepted.find((id) => !known.has(id));
      if (unknown !== undefined) throw new LogicalError('invalid', `There is no proposal ${unknown} in this result.`, [{ code: 'invalid', message: `There is no proposal ${unknown} in this result.` }]);
      const wanted = new Set(request.accepted);
      for (const p of request.result.proposals) {
        if (!wanted.has(p.id)) continue;
        const missing = p.requires.find((r) => !wanted.has(r));
        if (missing !== undefined) {
          const other = request.result.proposals.find((x) => x.id === missing);
          const message = `The proposal “${p.title}” has to be applied with “${other?.title ?? missing}”.`;
          throw new LogicalError('refused', message, [{ code: 'refused', message }]);
        }
      }
      const chosen = request.result.proposals.filter((p) => wanted.has(p.id));
      if (!chosen.length) return { model: request.result.model, revision: target.revision, applied: 0 };
      const changes: LogicalChange[] = chosen.flatMap((p) => p.changes);
      // The configuration is saved with the LDM, in the same change set, so that one undo takes both back.
      changes.push({ op: 'update', target: { model: true }, before: { derivation: target.derivation }, after: { derivation: request.result.config } });
      const applied = await host.edit.apply(
        {
          model: request.result.model,
          baseRevision: request.result.baseRevision,
          changes,
          summary: chosen.length === 1 ? `Derived “${chosen[0].title}” from the ontology.` : `Derived ${chosen.length} elements from the ontology.`,
        },
        options,
      );
      return { model: applied.model, revision: applied.revision, applied: chosen.length };
    },
  };
}

// ---------------------------------------------------------------- traceability and impact (LM-4)

/** What one impact or synchronization run is given: the ontology and LDM as plain data, worked on wherever it runs. */
export type ImpactRunner = (job: ImpactJob, signal: AbortSignal) => Promise<ImpactAnswer>;

/** Impact worked out on the page itself, yielding to it first: for tests, or where no worker can start. */
export const impactOnThePage: ImpactRunner = async (job, signal) => {
  await new Promise((r) => setTimeout(r, 0));
  if (signal.aborted) throw cancelled();
  const base = { ontology: job.ontology, origin: job.origin, target: job.target, ...(job.before ? { before: job.before } : {}) };
  let answer: ImpactAnswer;
  if (job.synchronize) {
    const result = synchronizeFor({ ...base, ...(job.dismissed ? { dismissed: job.dismissed } : {}) });
    answer = { report: result.report, proposals: result.proposals };
  } else {
    answer = { report: impactFor(base), proposals: [] };
  }
  if (signal.aborted) throw cancelled();
  return answer;
};

/** Impact in a worker of its own, which is stopped when the run is given up. */
export const impactInAWorker: ImpactRunner = (job, signal) => {
  if (typeof Worker === 'undefined') return impactOnThePage(job, signal);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./impactWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    return impactOnThePage(job, signal);
  }
  return new Promise<ImpactAnswer>((resolve, reject) => {
    let done = false;
    const stop = () => {
      done = true;
      worker.terminate();
      reject(cancelled());
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    const end = () => {
      done = true;
      signal.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ answer?: ImpactAnswer; error?: string }>) => {
      end();
      if (e.data.answer) resolve(e.data.answer);
      else reject(new LogicalError('refused', e.data.error || 'The impact report stopped.'));
    };
    worker.onerror = (e) => {
      if (done) return;
      end();
      // A worker that cannot be loaded is no reason to report nothing.
      e.preventDefault?.();
      impactOnThePage(job, signal).then(resolve, reject);
    };
    worker.postMessage(job);
  });
};

/** What the traceability service is given of the editor. */
export interface TraceabilityHost {
  /** The ontology and its LDMs as they are now. */
  current(): { model: Model; ontologyId: string; revisionId: string };
  withImports(model: Model): Model | undefined;
  /** A saved version of this project, by id, for a report between versions. */
  savedVersion(version: string): Promise<{ model: Model; name: string } | undefined>;
  edit: LogicalModelEditService;
}

export function createLocalTraceabilityService(host: TraceabilityHost, run: ImpactRunner = impactInAWorker): TraceabilityService {
  const given = (options?: CallOptions) => {
    if (options?.signal?.aborted) throw cancelled();
  };
  const modelIn = (model: string) => {
    const now = host.current();
    const target = now.model.logicalModels.find((m) => m.id === model);
    if (!target) throw new LogicalError('not-found', `There is no logical model “${model}” in the project.`);
    return { now, target };
  };
  const originOf = (now: { ontologyId: string; revisionId: string }) => ({ ontology: now.ontologyId, revision: now.revisionId });
  const report = (target: LogicalModel, now: { model: Model; ontologyId: string; revisionId: string }): TraceabilityReport =>
    reportFor({ ontology: now.model, origin: originOf(now), target });

  const bound = (refs: ElementRef[], target: LogicalModel) => {
    const missing = refs.find((ref) => !elementOf(target, ref));
    if (missing) throw new LogicalError('invalid', 'A mapping target is not in the logical model.', [{ code: 'invalid', message: 'A mapping target is not in the logical model.', element: missing }]);
    if (!refs.length) throw new LogicalError('invalid', 'A mapping needs at least one target.', [{ code: 'invalid', message: 'A mapping needs at least one target.' }]);
  };

  return {
    async report(query, options): Promise<TraceabilityReport> {
      given(options);
      const { now, target } = modelIn(query.model);
      return report(target, now);
    },

    async impact(query: ImpactRequest, options): Promise<ImpactReport> {
      given(options);
      const { now, target } = modelIn(query.model);
      let ontology = now.model;
      let before: Model | undefined;
      let compared: { from: string; to: string } | undefined;
      if (query.between) {
        const from = await host.savedVersion(query.between.from.version);
        if (!from) throw new LogicalError('not-found', 'That version is not kept in this browser any more.');
        const to = query.between.to;
        const later = to === 'current' ? { model: now.model, name: 'the current model' } : await host.savedVersion(to.version);
        if (!later) throw new LogicalError('not-found', 'That version is not kept in this browser any more.');
        before = from.model;
        ontology = later.model;
        compared = { from: from.name, to: later.name };
      }
      const job: ImpactJob = {
        kind: 'impact',
        ontology,
        origin: originOf(now),
        target,
        synchronize: false,
        ...(before ? { before } : {}),
      };
      const answer = await run(job, options?.signal ?? new AbortController().signal);
      return compared ? { ...answer.report, compared } : answer.report;
    },

    async synchronize(query: SynchronizeRequest, options): Promise<SynchronizationResult> {
      given(options);
      const { now, target } = modelIn(query.model);
      const job: ImpactJob = {
        kind: 'impact',
        ontology: now.model,
        origin: originOf(now),
        target,
        synchronize: true,
        ...(query.dismissed ? { dismissed: query.dismissed } : {}),
      };
      const answer = await run(job, options?.signal ?? new AbortController().signal);
      return { model: answer.report.model, baseRevision: answer.report.baseRevision, ontology: answer.report.ontology, report: answer.report, proposals: answer.proposals, at: answer.report.at };
    },

    async apply(request: ApplySynchronizationRequest, options): Promise<{ model: string; revision: string; applied: number }> {
      given(options);
      const { target } = modelIn(request.result.model);
      if (target.revision !== request.result.baseRevision) {
        throw new LogicalError('stale-revision', `The logical model “${target.name}” has moved on from revision ${request.result.baseRevision}; work the synchronization out again.`);
      }
      const known = new Set(request.result.proposals.map((p) => p.id));
      const unknown = request.accepted.find((id) => !known.has(id));
      if (unknown !== undefined) throw new LogicalError('invalid', `There is no proposal ${unknown} in this result.`, [{ code: 'invalid', message: `There is no proposal ${unknown} in this result.` }]);
      const wanted = new Set(request.accepted);
      for (const p of request.result.proposals) {
        if (!wanted.has(p.id)) continue;
        const missing = p.requires.find((r) => !wanted.has(r));
        if (missing !== undefined) {
          const other = request.result.proposals.find((x) => x.id === missing);
          const message = `The proposal “${p.title}” has to be applied with “${other?.title ?? missing}”.`;
          throw new LogicalError('refused', message, [{ code: 'refused', message }]);
        }
        const clash = p.excludes.find((x) => wanted.has(x));
        if (clash !== undefined) {
          const other = request.result.proposals.find((x) => x.id === clash);
          const message = `The proposal “${p.title}” cannot be applied with “${other?.title ?? clash}”: they change the same elements.`;
          throw new LogicalError('refused', message, [{ code: 'refused', message }]);
        }
      }
      const chosen = request.result.proposals.filter((p) => wanted.has(p.id));
      if (!chosen.length) return { model: request.result.model, revision: target.revision, applied: 0 };
      const applied = await host.edit.apply(
        {
          model: request.result.model,
          baseRevision: request.result.baseRevision,
          changes: chosen.flatMap((p) => p.changes),
          summary: chosen.length === 1 ? `Synchronized “${chosen[0].title}” with the ontology.` : `Synchronized ${chosen.length} changes with the ontology.`,
        },
        options,
      );
      return { model: applied.model, revision: applied.revision, applied: chosen.length };
    },

    async trace(query: TraceQuery, options): Promise<TraceResult> {
      given(options);
      const now = host.current();
      if (!query.element && !query.iri) throw new LogicalError('invalid', 'Trace something: an element of an LDM, or an ontology entity by IRI.');
      if (query.iri && !query.element && !now.model.terms.some((t) => (t.iri ?? '') === query.iri) && !now.model.props.some((p) => (p.iri ?? '') === query.iri) && !now.model.datatypes.some((d) => (d.iri ?? '') === query.iri)) {
        // An IRI the ontology no longer declares may still be a mapping's source: trace that rather than refuse.
        const known = now.model.logicalModels.some((m) => m.mappings.some((mp) => mp.sources.some((s) => s.iri === query.iri)));
        if (!known) throw new LogicalError('not-found', `The ontology has nothing at ${query.iri}.`);
      }
      const models = query.model ? [modelIn(query.model).target] : now.model.logicalModels;
      if (query.element && !query.model) throw new LogicalError('invalid', 'Tracing an element needs the logical model it is in.');
      if (query.element) bound([query.element], models[0]);
      return traceIn({ models, ontology: now.model, ...(query.model ? { model: models[0] } : {}), ...(query.element ? { element: query.element } : {}), ...(query.iri ? { iri: query.iri } : {}) });
    },

    async addMapping(input: MappingInput, options): Promise<{ model: string; revision: string; mapping: string }> {
      given(options);
      const { now, target } = modelIn(input.model);
      bound(input.targets, target);
      if (!input.sources.length) throw new LogicalError('invalid', 'A mapping needs at least one source.', [{ code: 'invalid', message: 'A mapping needs at least one source.' }]);
      const sources = madeSources(now.model, input.sources.map((s) => s.iri));
      const missing = input.sources.find((s) => !sources.some((x) => x.iri === s.iri));
      if (missing) throw new LogicalError('invalid', `The ontology has nothing at ${missing.iri}.`, [{ code: 'invalid', message: `The ontology has nothing at ${missing.iri}.` }]);
      const mapping = {
        id: newId('map'),
        sources,
        targets: input.targets,
        strategy: input.strategy,
        rationale: input.rationale,
        origin: originOf(now),
        baseline: baselineFor(target, input.targets),
        made: { by: 'hand' as const, at: Date.now() },
      };
      const applied = await host.edit.apply(
        { model: target.id, baseRevision: target.revision, changes: [{ op: 'add', element: { kind: 'mapping', mapping } }], summary: `Mapped ${input.targets.length === 1 ? 'an element' : `${input.targets.length} elements`} to ${sources.map((s) => s.label || s.iri).join(', ')} by hand.` },
        options,
      );
      return { model: applied.model, revision: applied.revision, mapping: mapping.id };
    },

    async editMapping(input: MappingEdit, options): Promise<{ model: string; revision: string }> {
      given(options);
      const { now, target } = modelIn(input.model);
      const before = target.mappings.find((m) => m.id === input.mapping);
      if (!before) throw new LogicalError('not-found', `There is no mapping ${input.mapping} in “${target.name}”.`);
      bound(input.targets, target);
      if (!input.sources.length) throw new LogicalError('invalid', 'A mapping needs at least one source.', [{ code: 'invalid', message: 'A mapping needs at least one source.' }]);
      const sources = madeSources(now.model, input.sources.map((s) => s.iri));
      const missing = input.sources.find((s) => !sources.some((x) => x.iri === s.iri));
      if (missing) throw new LogicalError('invalid', `The ontology has nothing at ${missing.iri}.`, [{ code: 'invalid', message: `The ontology has nothing at ${missing.iri}.` }]);
      const after = { sources, targets: input.targets, strategy: input.strategy, rationale: input.rationale, origin: originOf(now), baseline: baselineFor(target, input.targets), made: { by: 'hand' as const, at: Date.now() } };
      const applied = await host.edit.apply(
        { model: target.id, baseRevision: target.revision, changes: [{ op: 'update', target: { mapping: before.id }, before: { sources: before.sources, targets: before.targets, strategy: before.strategy, rationale: before.rationale, origin: before.origin, baseline: before.baseline, made: before.made }, after }], summary: `Edited the mapping of ${input.targets.length === 1 ? 'an element' : `${input.targets.length} elements`} by hand.` },
        options,
      );
      return { model: applied.model, revision: applied.revision };
    },

    async removeMapping(input: { model: string; mapping: string }, options): Promise<{ model: string; revision: string }> {
      given(options);
      const { target } = modelIn(input.model);
      const mapping = target.mappings.find((m) => m.id === input.mapping);
      if (!mapping) throw new LogicalError('not-found', `There is no mapping ${input.mapping} in “${target.name}”.`);
      const applied = await host.edit.apply(
        { model: target.id, baseRevision: target.revision, changes: removalOf(target, { mapping: mapping.id }), summary: 'Removed a mapping by hand. The elements it mapped stay.' },
        options,
      );
      return { model: applied.model, revision: applied.revision };
    },
  };
}
