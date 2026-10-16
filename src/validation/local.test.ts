import { describe, expect, it } from 'vitest';
import { withIris } from '../model/iri';
import { emptyModel, newRelation, newTerm, type Model } from '../model/types';
import { validate } from '../model/validation';
import type { DlReport } from '../reasoning/contracts';
import { MODEL_DATA, ValidationError, type ValidationJob } from './contracts';
import { createLocalValidationService, fixOf, onThePage, optionsOf, type Runner, type ValidationHost, type WorkerInput } from './local';

/** Two disjoint classes, a class under both (stated twice), and no definitions: something for each kind of check to find, and a quick fix. */
const people = (): Model => {
  const m = emptyModel('People');
  m.baseIri = 'http://example.org/p#';
  m.terms = [newTerm({ id: 'person', name: 'Person' }), newTerm({ id: 'org', name: 'Organisation' }), newTerm({ id: 'odd', name: 'odd one' })];
  m.relations = [newRelation({ from: 'person', to: 'org', predicate: 'owl:disjointWith' }), newRelation({ from: 'odd', to: 'person', kind: 'generalization' }), newRelation({ from: 'odd', to: 'org', kind: 'generalization' }), newRelation({ from: 'odd', to: 'org', kind: 'generalization' })];
  m.vocab = { ...m.vocab, enabled: true };
  return withIris(m);
};

const REPORT: DlReport = { engine: 'HermiT', engineVersion: '1.4', status: 'complete', consistency: 'consistent', ms: 3, unsatisfiable: [], errors: [], warnings: [] };
const ref = { ontologyId: 'working-copy', revisionId: 'r1' };

const serviceOver = (model: Model, run: Runner = onThePage, host: Partial<ValidationHost> = {}) => {
  const seen: ValidationJob[] = [];
  const service = createLocalValidationService({ current: () => ({ model, ...ref }), withImports: () => undefined, askDl: async () => REPORT, changed: (job) => seen.push({ ...job }), ...host }, run);
  return { service, seen };
};

describe('the checks as a job', () => {
  it('report what the checks find about the revision, as plain data, the same as checking on the page', async () => {
    const model = people();
    const { service } = serviceOver(model);
    const job = await service.start({ ...ref, categories: ['owl', 'quality', 'shacl'], data: MODEL_DATA, engine: 'fast' });
    const report = await service.report(job.job);
    expect(report).toMatchObject({ ...ref, data: MODEL_DATA });
    const here = await validate(model, MODEL_DATA, 'all', null);
    expect(report.findings.map((f) => f.id)).toEqual(here.findings.map((f) => f.id));
    expect(report.owl?.unsatisfiable).toEqual(['odd']);
    // A report travels: a quick fix in it is what it does, in words.
    expect(structuredClone(report)).toEqual(report);
    const fixable = report.findings.find((f) => f.fix);
    expect(fixable?.fix && Object.keys(fixable.fix).sort()).toEqual(['label', 'preview']);
  });

  it('says what it is doing as it goes, and when it is done', async () => {
    const { service, seen } = serviceOver(people());
    const job = await service.start({ ...ref, categories: ['owl', 'quality'], data: MODEL_DATA, engine: 'fast' });
    await service.report(job.job);
    expect(seen.map((j) => j.phase)).toEqual(expect.arrayContaining(['Starting…', 'Reasoning…', 'Checking quality rules…']));
    expect(seen.at(-1)).toMatchObject({ state: 'done', phase: '' });
    expect((await service.status(job.job)).state).toBe('done');
  });

  it('can be stopped, and then has no report', async () => {
    const forever: Runner = (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ValidationError('cancelled', 'Stopped.'))));
    const { service } = serviceOver(people(), forever);
    const job = await service.start({ ...ref, categories: ['owl'], data: MODEL_DATA, engine: 'fast' });
    const waiting = service.report(job.job);
    expect((await service.cancel(job.job)).state).toBe('cancelled');
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('is refused for a revision the ontology has moved on from, or another ontology', async () => {
    const { service } = serviceOver(people());
    await expect(service.start({ ...ref, revisionId: 'r0', categories: ['owl'], data: MODEL_DATA, engine: 'fast' })).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(service.start({ ...ref, ontologyId: 'another', categories: ['owl'], data: MODEL_DATA, engine: 'fast' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('asks the OWL 2 DL reasoner first when that is the one chosen, and stops when it gives no answer', async () => {
    const asked: AbortSignal[] = [];
    const { service } = serviceOver(people(), onThePage, { askDl: async (signal) => (asked.push(signal), REPORT) });
    const job = await service.start({ ...ref, categories: ['owl'], data: MODEL_DATA, engine: 'dl' });
    const report = await service.report(job.job);
    expect(asked).toHaveLength(1);
    expect(report.dl).toEqual({ report: REPORT });
    expect(report.owl?.engine).toBe('dl');
    const silent = serviceOver(people(), onThePage, { askDl: async () => undefined }).service;
    const stopped = await silent.start({ ...ref, categories: ['owl'], data: MODEL_DATA, engine: 'dl' });
    await expect(silent.report(stopped.job)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reasons over what the ontology imports when asked to', async () => {
    const model = people();
    let given: Model | undefined;
    const closure = { ...model, name: 'with imports' };
    const look: Runner = async (input, signal, progress) => {
      given = input.withImports;
      return onThePage(input, signal, progress);
    };
    const { service } = serviceOver(model, look, { withImports: () => closure });
    await service.report((await service.start({ ...ref, categories: ['owl'], data: MODEL_DATA, engine: 'fast', imports: true })).job);
    expect(given).toBe(closure);
    await service.report((await service.start({ ...ref, categories: ['owl'], data: MODEL_DATA, engine: 'fast' })).job);
    expect(given).toBeUndefined();
  });
});

describe('a quick fix', () => {
  it('is found again in the model the finding is of, and applied there', async () => {
    const model = people();
    const { service } = serviceOver(model);
    const report = await service.report((await service.start({ ...ref, categories: ['quality'], data: MODEL_DATA, engine: 'fast' })).job);
    const finding = report.findings.find((f) => f.fix)!;
    const fix = fixOf(model, finding)!;
    expect(fix.label).toBe(finding.fix!.label);
    expect(fix.apply(model)).not.toBe(model);
    // Of another model, or with another fix, it is not found.
    expect(fixOf(emptyModel('Other'), finding)).toBeUndefined();
    expect(fixOf(model, { ...finding, fix: { label: 'Something else', preview: '' } })).toBeUndefined();
  });

  it('tells the checks the same of a job, in a worker or on the page: the shape set chosen among it', async () => {
    // The runner is given what the service was asked: a shape set, a data graph and its content.
    let given: WorkerInput | undefined;
    const runner: Runner = async (input, signal, progress) => ((given = input), onThePage(input, signal, progress));
    const { service } = serviceOver(people(), runner);
    const data = { source: 'graph' as const, id: 'g', name: 'g', fingerprint: 'f', text: '', includeOntology: true };
    const report = await service.report((await service.start({ ...ref, categories: ['shacl'], data, shapeSet: 'set-1', engine: 'fast' })).job);
    expect(given).toMatchObject({ shapeSet: 'set-1', data });
    expect(optionsOf(given!, async () => {})).toMatchObject({ shapeSet: 'set-1', ref });
    // The set is not in the model: SHACL says so, rather than validating with every set; the report has no content of the data.
    expect(report.shacl).toMatchObject({ status: 'failed', error: expect.stringContaining('no longer in the model') });
    expect(report.data).not.toHaveProperty('text');
    expect(report.shapeSet).toBe('set-1');
  });
});
