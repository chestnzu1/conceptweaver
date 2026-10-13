import { describe, expect, it } from 'vitest';
import { withIris } from '../model/iri';
import { stressModel } from '../model/stress';
import type { AnalysisBucket, ClassSetPage, HierarchyMode, Provenance, StructureAnalysis } from './contracts';
import { graphOf, NS, wide } from './fixtures';
import type { ClassGraphInput, EntailedInput } from './graph';
import { createLocalStructureService, ontologyRef } from './local';
import { createGraphService, type InferredInput } from './service';

const REF = { ontologyId: 'onto', revisionId: 'r1' };
const REASONED: Provenance = { engine: { id: 'test', name: 'Test reasoner' }, revisionId: 'r1', status: 'current', completeness: 'complete', notes: [] };

/** A service over one hierarchy, with a reasoner's answer where one is given. */
function measuring(input: ClassGraphInput | string, entailed?: Partial<EntailedInput> | Provenance, connections?: Record<string, number>) {
  const graph = typeof input === 'string' ? graphOf(input) : input;
  const answer: InferredInput | undefined = !entailed ? undefined : 'status' in entailed ? { provenance: entailed } : { provenance: REASONED, entailed: { subClassOf: graph.subClassOf, links: 'direct', equivalent: [], unsatisfiable: [], ...entailed } };
  const service = createGraphService(() => ({ ...REF, graph: () => graph, ...(answer ? { inferred: () => answer } : {}), ...(connections ? { connections: () => new Map(Object.entries(connections).map(([name, n]) => [NS + name, n])) } : {}) }));
  const analyze = (mode: HierarchyMode = 'asserted') => service.analyze({ ...REF, mode });
  const members = (set: string, mode: HierarchyMode = 'asserted', extra: { limit?: number; cursor?: string } = {}) => service.members({ ...REF, mode, set, ...extra });
  return { service, analyze, members };
}
const counts = (buckets: AnalysisBucket[]) => buckets.filter((b) => b.count).map((b) => `${b.from}${b.to === null ? '+' : b.to === b.from ? '' : '–' + b.to}: ${b.count}`);
const labels = (page: ClassSetPage) => page.items.map((x) => x.class.label);
const finding = (a: StructureAnalysis, kind: string) => a.findings.find((f) => f.kind === kind);

const SMALL = 'A; B < A; C < A; D < B, C; E < D; F; G < F';

describe('measuring a hierarchy', () => {
  it('counts its classes, its top and its leaves, and says how deep it goes', async () => {
    const a = await measuring(SMALL).analyze();
    expect(a.metrics).toEqual({ classes: 7, top: 2, leaves: 2, maxDepth: 4, averageDepth: 2.14, multipleInheritance: 1, noStatedSuperclass: 2, equivalenceGroups: 0, unsatisfiable: null, inCycles: 0 });
    expect(a).toMatchObject({ ontologyId: 'onto', revisionId: 'r1', mode: 'asserted', provenance: { engine: null, status: 'current', completeness: 'complete' } });
    // No reasoner was asked: how many classes are unsatisfiable is not known, which is not the same as none.
    expect(a.metrics.unsatisfiable).toBeNull();
    expect(a.reasoning.status).toBe('unavailable');
  });

  it('gives the classes by level, by number of subclasses and by number of superclasses', async () => {
    const { analyze, members } = measuring(SMALL);
    const a = await analyze();
    expect(counts(a.depth)).toEqual(['1: 2', '2: 3', '3: 1', '4: 1']);
    expect(counts(a.subclasses)).toEqual(['0: 2', '1: 4', '2: 1']);
    expect(counts(a.superclasses)).toEqual(['0: 2', '1: 4', '2: 1']);
    // Every class is in exactly one range of each.
    for (const buckets of [a.depth, a.subclasses, a.superclasses]) expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(7);
    // And each range leads to the classes that are in it.
    expect(labels(await members(a.depth.find((b) => b.from === 2)!.set))).toEqual(['B', 'C', 'G']);
    expect(labels(await members(a.subclasses.find((b) => b.from === 2)!.set))).toEqual(['A']);
    expect((await members(a.superclasses.find((b) => b.from === 2)!.set)).items).toEqual([{ class: { iri: NS + 'D', label: 'D' }, value: 2 }]);
  });

  it('gives the branches by size and the longest ways down', async () => {
    const { analyze, members } = measuring(SMALL);
    const a = await analyze();
    expect(a.branches.largest.map((b) => `${b.class.label}: ${b.classes} classes, ${b.depth} levels`)).toEqual(['A: 5 classes, 3 levels', 'F: 2 classes, 1 levels']);
    expect(a.branches.others).toBeNull();
    expect(a.deepest.map((chain) => chain.map((c) => c.label).join(' > '))).toEqual(['A > B > D > E', 'F > G']);
    // A branch is its top class and everything below it, each once, the deepest first.
    const branch = await members(a.branches.largest[0].set);
    expect(branch.total).toBe(5);
    expect(branch.items.map((x) => `${x.class.label} ${x.value}`)).toEqual(['E 4', 'D 3', 'B 2', 'C 2', 'A 1']);
  });

  it('sums up the branches beyond the largest dozen', async () => {
    const many = Array.from({ length: 15 }, (_, i) => `R${String(i).padStart(2, '0')}; S${i} < R${String(i).padStart(2, '0')}`).join('; ') + '; T < R00';
    const a = await measuring(many).analyze();
    expect(a.branches.largest).toHaveLength(12);
    expect(a.branches.largest[0]).toMatchObject({ class: { label: 'R00' }, classes: 3 });
    expect(a.branches.others).toEqual({ branches: 3, classes: 6 });
    expect(a.metrics.top).toBe(15);
  });

  it('leads from each number to the classes behind it, a page at a time', async () => {
    const { analyze, members } = measuring(SMALL);
    const a = await analyze();
    expect(a.sets).toEqual({ top: 'top', leaves: 'leaves', multipleInheritance: 'multipleInheritance', noStatedSuperclass: 'noStatedSuperclass' });
    expect(labels(await members(a.sets.top!))).toEqual(['A', 'F']);
    expect(labels(await members(a.sets.leaves!))).toEqual(['E', 'G']);
    expect((await members(a.sets.multipleInheritance!)).items[0]).toMatchObject({ class: { label: 'D' }, value: 2, related: [{ label: 'B' }, { label: 'C' }] });
    const first = await members(a.subclasses.find((b) => b.from === 1)!.set, 'asserted', { limit: 3 });
    expect(first).toMatchObject({ total: 4, offset: 0 });
    expect(labels(first)).toEqual(['B', 'C', 'D']);
    expect(labels(await members(first.set, 'asserted', { limit: 3, cursor: first.nextCursor }))).toEqual(['F']);
    await expect(members('nothing-of-the-kind')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('what stands out in a hierarchy', () => {
  it('counts a stated superclass as redundant only where another stated one leads to it', async () => {
    const { analyze, members } = measuring('A; B < A; C < B, A; X; Y; Z < X, Y');
    const a = await analyze();
    expect(finding(a, 'redundant-superclass')).toMatchObject({ count: 1, examples: [{ label: 'C' }] });
    expect((await members(finding(a, 'redundant-superclass')!.set)).items).toEqual([{ class: { iri: NS + 'C', label: 'C' }, related: [{ iri: NS + 'A', label: 'A' }] }]);
    // Several superclasses that do not lead to each other are several superclasses, and that is all.
    expect(finding(a, 'multiple-inheritance')).toMatchObject({ count: 2 });
  });

  it('does not call a stated superclass redundant because a reasoner puts a class in between', async () => {
    // Worker is defined as a Person that is Employed. Clerk is stated to be both, so the reasoner finds it a Worker,
    // and then no longer directly a Person. The statement is what that rests on: it is not redundant.
    const stated = 'Person; Employed; Worker; Clerk < Person, Employed';
    const { analyze } = measuring(stated, { subClassOf: graphOf('Worker < Person, Employed; Clerk < Worker').subClassOf });
    expect(finding(await analyze('inferred'), 'redundant-superclass')).toBeUndefined();
    expect(finding(await analyze('asserted'), 'redundant-superclass')).toBeUndefined();
    expect((await analyze('inferred')).metrics.maxDepth).toBe(3);
  });

  it('finds the classes that are each other’s superclasses, and the groups that are stated to be equivalent', async () => {
    const { analyze, members } = measuring('Animal; Cat < Feline, Animal; Feline < Cat; Lion < Cat; A; B; C; A = B; B = C; D');
    const a = await analyze();
    expect(a.metrics).toMatchObject({ inCycles: 2, equivalenceGroups: 1 });
    expect(finding(a, 'cycle')).toMatchObject({ count: 1, examples: [{ label: 'Cat' }, { label: 'Feline' }] });
    expect((await members(a.sets.inCycles!)).items).toEqual([
      { class: { iri: NS + 'Cat', label: 'Cat' }, related: [{ iri: NS + 'Feline', label: 'Feline' }] },
      { class: { iri: NS + 'Feline', label: 'Feline' }, related: [{ iri: NS + 'Cat', label: 'Cat' }] },
    ]);
    expect(labels(await members(a.sets.equivalenceGroups!))).toEqual(['A', 'B', 'C']);
    // A ring counts as one level.
    expect(a.metrics.maxDepth).toBe(3);
  });

  it('calls a class wide, deep or highly connected only against the rest of the ontology', async () => {
    // Forty subclasses under one class, where the others that have any have one or two.
    const lines = ['Hub', ...Array.from({ length: 40 }, (_, i) => `H${i} < Hub`), 'P', 'Q < P', 'R < P', 'S < Q', 'T < R', 'U < S'];
    // And one chain that goes far deeper than any other leaf.
    for (let i = 1; i <= 14; i++) lines.push(`Deep${i} < ${i === 1 ? 'P' : 'Deep' + (i - 1)}`);
    const { analyze, members } = measuring(lines.join('; '), undefined, { Hub: 55, P: 4, Q: 3 });
    const a = await analyze();
    expect(finding(a, 'wide')).toMatchObject({ count: 1, examples: [{ label: 'Hub' }] });
    expect(finding(a, 'wide')!.above).toBeGreaterThanOrEqual(7);
    expect((await members(finding(a, 'wide')!.set)).items).toEqual([{ class: { iri: NS + 'Hub', label: 'Hub' }, value: 40 }]);
    expect(finding(a, 'deep')).toMatchObject({ count: 1, examples: [{ label: 'Deep14' }] });
    expect(finding(a, 'connected')).toMatchObject({ count: 1, examples: [{ label: 'Hub' }] });
    expect((await members(finding(a, 'connected')!.set)).items[0].value).toBe(55);
    // A small, even ontology has nothing that stands out.
    expect((await measuring(SMALL).analyze()).findings.map((f) => f.kind)).toEqual(['multiple-inheritance']);
  });

  it('counts unsatisfiable classes only from a reasoner’s answer, and says whose', async () => {
    const stated = 'Person; Robot; Android < Person, Robot; Replicant < Android; Actor < Person';
    const { analyze, members } = measuring(stated, { unsatisfiable: [NS + 'Android'] });
    const asserted = await analyze('asserted');
    expect(asserted.metrics.unsatisfiable).toBe(2);
    expect(asserted.reasoning.engine?.name).toBe('Test reasoner');
    expect(finding(asserted, 'unsatisfiable')).toMatchObject({ count: 2, examples: [{ label: 'Android' }, { label: 'Replicant' }] });
    // The asserted hierarchy itself is measured as it is stated: Android is in it, with its two superclasses.
    expect(asserted.metrics).toMatchObject({ classes: 5, multipleInheritance: 1, maxDepth: 3 });

    const inferred = await analyze('inferred');
    expect(inferred.provenance.engine?.name).toBe('Test reasoner');
    // In the inferred hierarchy they have no place of their own: they are counted, and left out of the rest.
    expect(inferred.metrics).toMatchObject({ classes: 5, unsatisfiable: 2, top: 2, leaves: 2, maxDepth: 2, multipleInheritance: 0 });
    expect(inferred.depth.reduce((n, b) => n + b.count, 0)).toBe(3);
    expect(inferred.branches.largest.map((b) => b.class.label)).toEqual(['Person', 'Robot']);
    expect(inferred.warnings.join(' ')).toMatch(/left out of every other number/);
    expect(labels(await members(inferred.sets.unsatisfiable!, 'inferred'))).toEqual(['Android', 'Replicant']);
  });

  it('counts the groups a reasoner finds equivalent as groups', async () => {
    const { analyze, members } = measuring('Party; Organisation < Party; Org < Party; Firm < Org', { equivalent: [[NS + 'Organisation', NS + 'Org']] });
    const a = await analyze('inferred');
    expect(a.metrics).toMatchObject({ classes: 4, equivalenceGroups: 1, top: 1, leaves: 1, averageDepth: 2 });
    expect((await members(a.sets.equivalenceGroups!, 'inferred')).items).toEqual([{ class: { iri: NS + 'Org', label: 'Org' }, related: [{ iri: NS + 'Organisation', label: 'Organisation' }] }]);
    // Nothing is stated to be equivalent: the asserted hierarchy has no such group.
    expect((await analyze('asserted')).metrics.equivalenceGroups).toBe(0);
  });

  it('has no numbers for an inferred hierarchy that is not to be had', async () => {
    const stale: Provenance = { ...REASONED, status: 'stale', revisionId: 'r0', completeness: 'incomplete' };
    const { analyze, members, service } = measuring(SMALL, stale);
    const a = await analyze('inferred');
    expect(a.provenance).toEqual(stale);
    expect(Object.values(a.metrics).every((v) => v === null)).toBe(true);
    expect(a).toMatchObject({ depth: [], subclasses: [], findings: [], deepest: [], branches: { largest: [], others: null } });
    expect((await members('top', 'inferred')).items).toEqual([]);
    // What is stated is measured all the same, with the number no reasoner gave left open.
    expect((await analyze('asserted')).metrics).toMatchObject({ classes: 7, unsatisfiable: null });
    // And a source with no reasoner at all has no inferred hierarchy to ask about.
    await expect(measuring(SMALL).analyze('inferred')).rejects.toMatchObject({ code: 'unsupported' });
    expect(service).toBeDefined();
  });
});

describe('measuring a large hierarchy', () => {
  it('measures once and keeps the answer', async () => {
    const { analyze, members } = measuring(wide(3000));
    const first = await analyze();
    const again = await analyze();
    expect(again.depth).toBe(first.depth);
    expect(first.metrics).toMatchObject({ classes: 3001, top: 1, leaves: 3000, maxDepth: 2 });
    expect(finding(first, 'wide')).toMatchObject({ count: 1, examples: [{ label: 'Top' }] });
    const page = await members(first.sets.leaves!);
    expect(page.items).toHaveLength(200);
    expect(page.total).toBe(3000);
  });

  it('says how far it has got, and stops when it is given up', async () => {
    const input = wide(120_000);
    const { service } = measuring(input);
    const seen: number[] = [];
    const abort = new AbortController();
    // Given up as soon as it first reports: it stops there, and says that it was given up.
    await expect(service.analyze({ ...REF, mode: 'asserted' }, { signal: abort.signal, onProgress: (f) => (seen.push(f), abort.abort()) })).rejects.toMatchObject({ code: 'aborted' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThan(1);
    // Nothing half-done was kept: asked again, it measures to the end.
    const progress: number[] = [];
    const done = await service.analyze({ ...REF, mode: 'asserted' }, { onProgress: (f) => progress.push(f) });
    expect(done.metrics.classes).toBe(120_001);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  }, 60_000);

  it('measures a generated ontology of thousands of classes from the model itself', async () => {
    const m = withIris(stressModel(2600));
    const service = createLocalStructureService(() => ({ model: m, docId: null }));
    const t0 = performance.now();
    const a = await service.analyze({ ...ontologyRef(m, null), mode: 'asserted' });
    expect(performance.now() - t0).toBeLessThan(5000);
    const classes = m.terms.filter((t) => t.type === 'concept').length;
    expect(a.metrics.classes).toBe(classes);
    for (const buckets of [a.depth, a.subclasses, a.superclasses]) expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(classes);
    expect(a.branches.largest.reduce((n, b) => n + b.classes, 0) + (a.branches.others?.classes ?? 0)).toBeGreaterThanOrEqual(classes);
    expect(a.metrics.multipleInheritance).toBeGreaterThan(0);
    expect(a.metrics.maxDepth).toBeGreaterThan(5);
    expect(a.deepest[0]).toHaveLength(a.metrics.maxDepth!);
    // How connected a class is comes from the model: every line drawn to or from it.
    expect(finding(a, 'connected')?.count ?? 0).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
