import { ELEMENT_TYPES, ELEMENT_TYPE_DESCRIPTIONS, ELEMENT_TYPE_LABELS, LogicalError, elementTypeWords, type CallOptions, type ElementKind, type ElementRef, type ElementType, type LogicalChange, type LogicalModel, type LogicalModelEditService, type SemanticMapping } from '../logical/contracts';
import type { Model } from '../model/types';
import { elementOf, newId, removalOf } from '../logical/rules';
import { expectedElementTypeOf, strategyById, strategyText, type StrategyEntry } from '../logical/strategies';
import type { AcceptRequest, ApplySynchronizationRequest, ConversionPreview, ConversionQuery, ElementTypeChangeQuery, ElementTypeChoice, ElementTypePreview, ElementTypeQuery, ImpactAnswer, ImpactJob, ImpactReport, ImpactRequest, MappingEdit, MappingInput, ProposeRequest, ProposalJob, SynchronizeRequest, SynchronizationResult, TraceQuery, TraceResult, TraceabilityReport, TraceabilityService, TransformationResult, TransformationService } from './contracts';
import { conversionPlan, elementNameIn, elementTypePlan } from './conversions';
import { baselineFor, impactFor, madeSources, reportFor, synchronizeFor, traceIn } from './impact';
import { proposalsFor, sourceNow } from './transform';

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

const refKind = (ref: ElementRef): ElementKind => Object.keys(ref)[0] as ElementKind;
const refKey = (ref: ElementRef): string => `${refKind(ref)}:${Object.values(ref)[0]}`;

/** What an element is, where the Entities workspace edits it: an entity, a reference entity or a domain. */
const elementTypeOf = (target: LogicalModel, ref: ElementRef): ElementType | undefined => {
  if ('entity' in ref) {
    const entity = target.entities.find((e) => e.id === ref.entity);
    return entity ? (entity.reference === true ? 'reference' : 'entity') : undefined;
  }
  if ('domain' in ref && target.domains.some((d) => d.id === ref.domain)) return 'domain';
  return undefined;
};

const KIND_WORDS: Record<ElementKind, string> = {
  entity: 'an entity',
  attribute: 'an attribute',
  key: 'a key',
  relationship: 'a relationship',
  generalization: 'a generalization',
  rule: 'a business rule',
  domain: 'a domain',
  mapping: 'a mapping',
  diagram: 'a diagram',
};

const unknownStrategy = (id: string) => new LogicalError('invalid', `“${id}” is not a mapping strategy this editor knows.`, [{ code: 'invalid', message: `“${id}” is not a mapping strategy this editor knows.` }]);

/** Holds a mapping's sources to what its strategy reads. */
function sourcesChecked(now: Model, entry: StrategyEntry, iris: string[]): void {
  const min = entry.sources?.min ?? 1;
  const max = entry.sources?.max;
  if (iris.length < min) {
    const message = min === 1 ? 'A mapping needs at least one source.' : `The strategy “${entry.label}” needs at least ${min} sources.`;
    throw new LogicalError('invalid', message, [{ code: 'invalid', message }]);
  }
  if (max !== undefined && iris.length > max) {
    const message = max === 1 ? `The strategy “${entry.label}” reads one source.` : `The strategy “${entry.label}” reads at most ${max} sources.`;
    throw new LogicalError('invalid', message, [{ code: 'invalid', message }]);
  }
  for (const iri of iris) {
    const found = sourceNow(now, iri);
    if (!found || entry.sourceKinds.includes(found.kind)) continue;
    const message = `The strategy “${entry.label}” reads ${entry.sourceKinds.join(' and ')}, but “${found.name || iri}” is ${found.kind === 'class' ? 'a class' : `a ${found.kind}`}.`;
    throw new LogicalError('invalid', message, [{ code: 'invalid', message }]);
  }
}

/**
 * Holds a mapping's targets to what its strategy makes. Changing the strategy of an element that
 * is already mapped to the other kind is not a metadata edit: it has to go through a reviewed
 * conversion, so the element and the mapping change together.
 */
function targetsChecked(target: LogicalModel, entry: StrategyEntry, refs: ElementRef[], before?: SemanticMapping): void {
  const wrong = refs.find((ref) => refKind(ref) !== entry.target);
  if (wrong) {
    const name = elementNameIn(target, wrong);
    const message = `The strategy “${entry.label}” makes ${KIND_WORDS[entry.target]}, but “${name}” is ${KIND_WORDS[refKind(wrong)]}.`;
    if (before?.targets.some((ref) => refKey(ref) === refKey(wrong))) {
      throw new LogicalError('conversion-required', `${message} Review the transformation, so the element and the mapping change together.`, [{ code: 'refused', message }]);
    }
    throw new LogicalError('invalid', `${message} Choose a strategy that makes ${KIND_WORDS[refKind(wrong)]}.`, [{ code: 'invalid', message }]);
  }
  // An entity and a reference entity are the same kind but not the same element type: a strategy
  // that makes one does not, as it stands, make the other.
  const expected = expectedElementTypeOf(entry.id);
  if (!expected || expected === 'domain') return;
  const mistyped = refs.find((ref) => {
    if (!('entity' in ref)) return false;
    const entity = target.entities.find((e) => e.id === ref.entity);
    return !!entity && (entity.reference === true ? 'reference' : 'entity') !== expected;
  });
  if (!mistyped || !('entity' in mistyped)) return;
  const entity = target.entities.find((e) => e.id === mistyped.entity)!;
  const actual: ElementType = entity.reference === true ? 'reference' : 'entity';
  const message = `The strategy “${entry.label}” makes ${elementTypeWords(expected)}, but “${entity.name}” is ${elementTypeWords(actual)}.`;
  if (before?.targets.some((ref) => refKey(ref) === refKey(mistyped))) {
    throw new LogicalError('conversion-required', `${message} Choose a strategy that makes ${elementTypeWords(actual)}, or change the element’s type in the Entities workspace.`, [{ code: 'refused', message }]);
  }
  throw new LogicalError('invalid', `${message} Choose a strategy that makes ${elementTypeWords(actual)}.`, [{ code: 'invalid', message }]);
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
      const entry = strategyById(input.strategyId);
      if (!entry) throw unknownStrategy(input.strategyId);
      const sources = madeSources(now.model, input.sources.map((s) => s.iri));
      const missing = input.sources.find((s) => !sources.some((x) => x.iri === s.iri));
      if (missing) throw new LogicalError('invalid', `The ontology has nothing at ${missing.iri}.`, [{ code: 'invalid', message: `The ontology has nothing at ${missing.iri}.` }]);
      sourcesChecked(now.model, entry, input.sources.map((s) => s.iri));
      targetsChecked(target, entry, input.targets);
      const mapping = {
        id: newId('map'),
        sources,
        targets: input.targets,
        strategy: strategyText(entry, input.targets.length === 1 ? elementNameIn(target, input.targets[0]) : undefined),
        strategyId: entry.id,
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
      const entry = strategyById(input.strategyId);
      if (!entry) throw unknownStrategy(input.strategyId);
      const sources = madeSources(now.model, input.sources.map((s) => s.iri));
      const missing = input.sources.find((s) => !sources.some((x) => x.iri === s.iri));
      if (missing) throw new LogicalError('invalid', `The ontology has nothing at ${missing.iri}.`, [{ code: 'invalid', message: `The ontology has nothing at ${missing.iri}.` }]);
      sourcesChecked(now.model, entry, input.sources.map((s) => s.iri));
      targetsChecked(target, entry, input.targets, before);
      const after = {
        sources,
        targets: input.targets,
        strategy: strategyText(entry, input.targets.length === 1 ? elementNameIn(target, input.targets[0]) : undefined),
        strategyId: entry.id,
        rationale: input.rationale,
        origin: originOf(now),
        baseline: baselineFor(target, input.targets),
        made: { by: 'hand' as const, at: Date.now() },
      };
      const applied = await host.edit.apply(
        { model: target.id, baseRevision: target.revision, changes: [{ op: 'update', target: { mapping: before.id }, before: { sources: before.sources, targets: before.targets, strategy: before.strategy, strategyId: before.strategyId, rationale: before.rationale, origin: before.origin, baseline: before.baseline, made: before.made }, after }], summary: `Edited the mapping of ${input.targets.length === 1 ? 'an element' : `${input.targets.length} elements`} by hand.` },
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

    async previewConversion(query: ConversionQuery, options): Promise<ConversionPreview> {
      given(options);
      const { now, target } = modelIn(query.model);
      const mapping = target.mappings.find((m) => m.id === query.mapping);
      if (!mapping) throw new LogicalError('not-found', `There is no mapping ${query.mapping} in “${target.name}”.`);
      const entry = strategyById(query.to);
      if (!entry) throw unknownStrategy(query.to);
      let sources = mapping.sources;
      if (query.sources !== undefined) {
        if (!query.sources.length) throw new LogicalError('invalid', 'A mapping needs at least one source.', [{ code: 'invalid', message: 'A mapping needs at least one source.' }]);
        const made = madeSources(now.model, query.sources.map((s) => s.iri));
        const missing = query.sources.find((s) => !made.some((x) => x.iri === s.iri));
        if (missing) throw new LogicalError('invalid', `The ontology has nothing at ${missing.iri}.`, [{ code: 'invalid', message: `The ontology has nothing at ${missing.iri}.` }]);
        sourcesChecked(now.model, entry, query.sources.map((s) => s.iri));
        sources = made;
      }
      return conversionPlan({ model: target, mapping, to: query.to, ...(query.decisions ? { decisions: query.decisions } : {}), sources, ...(query.rationale !== undefined ? { rationale: query.rationale } : {}) });
    },

    async applyConversion(preview: ConversionPreview, options): Promise<{ model: string; revision: string }> {
      given(options);
      const { now, target } = modelIn(preview.model);
      if (target.revision !== preview.baseRevision) {
        throw new LogicalError('stale-revision', `The logical model “${target.name}” has moved on from revision ${preview.baseRevision}; review the transformation again.`);
      }
      const mapping = target.mappings.find((m) => m.id === preview.mapping);
      if (!mapping) throw new LogicalError('not-found', `There is no mapping ${preview.mapping} in “${target.name}”.`);
      const ref = mapping.targets.length === 1 ? mapping.targets[0] : undefined;
      if ((mapping.strategyId ?? null) !== (preview.from.strategyId ?? null) || !ref || refKey(ref) !== refKey(preview.from.ref)) {
        throw new LogicalError('stale-revision', `The mapping has changed since the transformation was reviewed; review it again.`);
      }
      const decisions = Object.fromEntries(preview.decisions.map((d) => [d.name, d.chosen]));
      // A preview crosses the service boundary: its sources are checked against the ontology as it
      // is now, not taken on trust, and the axioms the mapping will record are made afresh.
      const asked = preview.mappingAfter.sources;
      if (!asked.length) throw new LogicalError('invalid', 'A mapping needs at least one source.', [{ code: 'invalid', message: 'A mapping needs at least one source.' }]);
      const sources = madeSources(now.model, asked.map((s) => s.iri));
      const missing = asked.find((s) => !sources.some((x) => x.iri === s.iri));
      if (missing) throw new LogicalError('invalid', `The ontology has nothing at ${missing.iri}.`, [{ code: 'invalid', message: `The ontology has nothing at ${missing.iri}.` }]);
      const entry = strategyById(preview.to.strategyId);
      if (entry) sourcesChecked(now.model, entry, asked.map((s) => s.iri));
      const fresh = conversionPlan({ model: target, mapping, to: preview.to.strategyId, decisions, sources, rationale: preview.mappingAfter.rationale });
      if (fresh.conflicts.length) {
        const message = fresh.conflicts.join(' ');
        throw new LogicalError('refused', message, fresh.conflicts.map((text) => ({ code: 'refused' as const, message: text })));
      }
      if (!fresh.changes.length) throw new LogicalError('refused', 'The transformation would not change the model; save the mapping instead.', [{ code: 'refused', message: 'The transformation would not change the model; save the mapping instead.' }]);
      const at = Date.now();
      const before: Record<string, unknown> = { sources: mapping.sources, targets: mapping.targets, strategy: mapping.strategy, strategyId: mapping.strategyId, rationale: mapping.rationale, origin: mapping.origin, baseline: mapping.baseline, made: mapping.made };
      if (mapping.converted) before.converted = mapping.converted;
      const after = {
        sources: fresh.mappingAfter.sources,
        targets: fresh.mappingAfter.targets,
        strategy: fresh.mappingAfter.strategy,
        strategyId: fresh.mappingAfter.strategyId,
        rationale: fresh.mappingAfter.rationale,
        origin: originOf(now),
        baseline: fresh.mappingAfter.baseline,
        made: { by: 'hand' as const, at },
        converted: { ...(mapping.strategyId ? { from: mapping.strategyId } : {}), to: preview.to.strategyId, at },
      };
      const applied = await host.edit.apply(
        {
          model: target.id,
          baseRevision: target.revision,
          changes: [...fresh.changes, { op: 'update', target: { mapping: mapping.id }, before, after }],
          summary: `Converted “${preview.from.name}” from ${KIND_WORDS[preview.from.kind]} into ${KIND_WORDS[preview.to.kind]} by changing the mapping’s strategy.`,
        },
        options,
      );
      return { model: applied.model, revision: applied.revision };
    },

    async elementTypes(query: ElementTypeChangeQuery, options): Promise<ElementTypeChoice[]> {
      given(options);
      const { target } = modelIn(query.model);
      const current = elementTypeOf(target, query.element);
      if (!current) throw new LogicalError('not-found', 'The logical model has no such entity or domain.');
      return ELEMENT_TYPES.map((type): ElementTypeChoice => {
        const words = { type, label: ELEMENT_TYPE_LABELS[type], description: ELEMENT_TYPE_DESCRIPTIONS[type] };
        if (type === current) return { ...words, available: true };
        const plan = elementTypePlan({ model: target, element: query.element, to: type });
        return plan.conflicts.length ? { ...words, available: false, reason: plan.conflicts[0] } : { ...words, available: true };
      });
    },

    async previewElementTypeChange(query: ElementTypeQuery, options): Promise<ElementTypePreview> {
      given(options);
      const { target } = modelIn(query.model);
      if (!elementTypeOf(target, query.element)) throw new LogicalError('not-found', 'The logical model has no such entity or domain.');
      if (!(ELEMENT_TYPES as readonly string[]).includes(query.to)) {
        throw new LogicalError('invalid', `“${query.to}” is not an element type this editor knows.`, [{ code: 'invalid', message: `“${query.to}” is not an element type this editor knows.` }]);
      }
      return elementTypePlan({ model: target, element: query.element, to: query.to, ...(query.decisions ? { decisions: query.decisions } : {}) });
    },

    async applyElementTypeChange(preview: ElementTypePreview, options): Promise<{ model: string; revision: string; element: ElementRef }> {
      given(options);
      const { target } = modelIn(preview.model);
      if (target.revision !== preview.baseRevision) {
        throw new LogicalError('stale-revision', `The logical model “${target.name}” has moved on from revision ${preview.baseRevision}; review the change of type again.`);
      }
      const current = elementTypeOf(target, preview.element);
      if (!current) throw new LogicalError('not-found', 'The logical model has no such entity or domain.');
      if (current !== preview.from.type) {
        throw new LogicalError('stale-revision', `“${preview.from.name}” has changed type since the change was reviewed; review it again.`);
      }
      if (!(ELEMENT_TYPES as readonly string[]).includes(preview.to.type)) {
        throw new LogicalError('invalid', `“${preview.to.type}” is not an element type this editor knows.`, [{ code: 'invalid', message: `“${preview.to.type}” is not an element type this editor knows.` }]);
      }
      const decisions = Object.fromEntries(preview.decisions.map((d) => [d.name, d.chosen]));
      const fresh = elementTypePlan({ model: target, element: preview.element, to: preview.to.type, decisions });
      if (fresh.conflicts.length) {
        throw new LogicalError('refused', fresh.conflicts.join(' '), fresh.conflicts.map((text) => ({ code: 'refused' as const, message: text })));
      }
      if (!fresh.changes.length) {
        throw new LogicalError('refused', 'The change of type would not change the model.', [{ code: 'refused', message: 'The change of type would not change the model.' }]);
      }
      const applied = await host.edit.apply(
        { model: target.id, baseRevision: target.revision, changes: fresh.changes, summary: `Changed “${preview.from.name}” from ${elementTypeWords(preview.from.type)} into ${elementTypeWords(fresh.to.type)}.` },
        options,
      );
      return { model: applied.model, revision: applied.revision, element: fresh.to.ref };
    },
  };
}
