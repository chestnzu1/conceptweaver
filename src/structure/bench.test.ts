import { reason } from '../model/reasoner';
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { withIris } from '../model/iri';
import { stressModel } from '../model/stress';
import type { HierarchyQuery, Iri } from './contracts';
import { generated, NS } from './fixtures';
import { buildHierarchy } from './graph';
import { createLocalStructureService, ontologyRef } from './local';
import { openWide, Places, rowsOf, TOP, withPage, type Branch } from './outline';
import { createGraphService, type InferredInput } from './service';

/**
 * Times the structure services on large hierarchies. Not part of the test run:
 *   BENCH_OUT=/tmp/structure-bench.txt pnpm exec vitest run src/structure/bench.test.ts
 */
const OUT = process.env.BENCH_OUT;

it.skipIf(!OUT)('times the structure services on large hierarchies', async () => {
  const lines: string[] = [];
  const say = (n: number, what: string, ms: number, note = '') => lines.push(`${String(n).padStart(7)} classes  ${what.padEnd(52)} ${ms.toFixed(ms < 10 ? 1 : 0).padStart(7)} ms  ${note}`);
  const timed = async <T>(n: number, what: string, fn: () => T | Promise<T>, note: (out: T) => string = () => ''): Promise<T> => {
    const t0 = performance.now();
    const out = await fn();
    say(n, what, performance.now() - t0, note(out));
    return out;
  };

  // ---- the services, over hierarchies that are only classes and links
  for (const n of [10_000, 50_000, 200_000]) {
    const input = await timed(n, 'generate', () => generated(n));
    const ref = { ontologyId: 'bench', revisionId: 'r1' };
    // A reasoner that entails exactly what is stated, given as direct links, as HermiT gives them.
    const answer: InferredInput = { provenance: { engine: { id: 'bench', name: 'Bench' }, revisionId: 'r1', status: 'current', completeness: 'complete', notes: [] }, entailed: { subClassOf: input.subClassOf, links: 'direct', equivalent: [], unsatisfiable: [] } };
    const service = createGraphService(() => ({ ...ref, graph: () => input, inferred: () => answer }));
    const ask = (extra: Partial<HierarchyQuery> = {}): HierarchyQuery => ({ ...ref, mode: 'asserted', ...extra });
    const top = await timed(n, 'first question: build the hierarchy, list the top', () => service.children(ask()), (p) => `${p.total} at the top`);
    const deep = `${NS}G${n - 1}`;
    await timed(n, 'subclasses of a class', () => service.children(ask({ parentIri: top.nodes[0].class.iri })), (p) => `${p.total} subclasses`);
    await timed(n, 'narrow to a search, first time', () => service.children(ask({ filter: 'class 77' })), (p) => `${p.matched} found`);
    await timed(n, 'narrow to the same search again', () => service.children(ask({ filter: 'class 77' })));
    await timed(n, 'find classes by text', () => service.search({ ...ref, text: 'class 123' }), (r) => `${r.total} found`);
    await timed(n, 'ways down to a deep class (12)', () => service.paths({ ...ref, mode: 'asserted', classIri: deep, limit: 12 }), (r) => `${r.paths.length} ways, the first ${r.paths[0]?.length} long`);
    await timed(n, 'inferred hierarchy from direct links: build, list the top', () => service.children(ask({ mode: 'inferred' })));
    await timed(n, 'sum up a class at the top (first: works out depths)', () => service.summary({ ...ref, mode: 'asserted', classIri: top.nodes[0].class.iri }), (s) => `${s.position?.descendants} below it`);
    await timed(n, 'sum up a deep class', () => service.summary({ ...ref, mode: 'asserted', classIri: deep }), (s) => `levels ${s.position?.depth.min} to ${s.position?.depth.max}`);
    await timed(n, 'compare two deep classes', () => service.compare({ ...ref, classAIri: deep, classBIri: `${NS}G${n - 2}` }), (c) => `${c.superclasses.length} superclasses between them`);
    let stretches = 0;
    await timed(n, 'measure the hierarchy', () => service.analyze({ ...ref, mode: 'asserted' }, { onProgress: () => stretches++ }), (a) => `deepest level ${a.metrics.maxDepth}, in ${stretches} stretches`);
    await timed(n, 'measure it again (kept)', () => service.analyze({ ...ref, mode: 'asserted' }));
    await timed(n, 'the classes behind a number', async () => service.members({ ...ref, mode: 'asserted', set: 'leaves' }), (p) => `${p.total} leaves`);

    // What a reader of the hierarchy keeps: opened wide to ten thousand lines, then drawn.
    const branches = new Map<string, Branch>();
    const places = new Places();
    let asked = 0;
    const fetch = async (parents: Iri[]) => {
      // As a view asks: a level at a time, two hundred branches to a question.
      for (let i = 0; i < parents.length; i += 200) {
        asked++;
        const some = parents.slice(i, i + 200);
        const pages = await service.branches({ ...ref, mode: 'asserted', parents: some.map((p) => (p === TOP ? {} : { parentIri: p })) });
        some.forEach((p, k) => branches.set(p, withPage(branches.get(p), pages[k])));
      }
    };
    const wide = await timed(n, 'open the hierarchy wide, to 10,000 lines', () => openWide(branches, places, fetch, 10_000), (w) => `${w.open.size} branches open, ${asked} questions`);
    await timed(n, 'the lines to draw for that', () => rowsOf(branches, places, wide.open), (rows) => `${rows.length} lines`);
    lines.push('');
  }

  // ---- every link a reasoner entails, reduced to the direct ones
  for (const n of [10_000, 30_000]) {
    const input = generated(n);
    const h = buildHierarchy(input);
    const all: { sub: Iri; sup: Iri }[] = [];
    for (const iri of h.entries.keys()) {
      const seen = new Set<Iri>();
      const todo = [...h.entries.get(iri)!.parents];
      while (todo.length) {
        const up = todo.pop()!;
        if (seen.has(up)) continue;
        seen.add(up);
        all.push({ sub: iri, sup: up });
        todo.push(...h.entries.get(up)!.parents);
      }
    }
    const answer: InferredInput = { provenance: { engine: { id: 'bench', name: 'Bench' }, revisionId: 'r1', status: 'current', completeness: 'complete', notes: [] }, entailed: { subClassOf: all, links: 'all', equivalent: [], unsatisfiable: [] } };
    const service = createGraphService(() => ({ ontologyId: 'bench', revisionId: 'r1', graph: () => input, inferred: () => answer }));
    await service.children({ ontologyId: 'bench', revisionId: 'r1', mode: 'asserted' });
    await timed(n, `inferred hierarchy from every entailed link`, () => service.children({ ontologyId: 'bench', revisionId: 'r1', mode: 'inferred' }), () => `${all.length} links given`);
    lines.push('');
  }

  // ---- the same through the model in the editor, with the app's own reasoner
  for (const n of [650, 2600, 5200]) {
    const m = await timed(n, 'generate a model (with its layout)', () => withIris(stressModel(n)), (x) => `${x.terms.length} terms, ${x.relations.length} relationships`);
    const service = createLocalStructureService(() => ({ model: m, docId: null, reasoning: { engine: 'fast', fast: reason(m) } }));
    const ref = ontologyRef(m, null);
    const top = await timed(n, 'first question: read the model, build the hierarchy', () => service.children({ ...ref, mode: 'asserted' }));
    await timed(n, 'measure the asserted hierarchy (asks the fast reasoner)', () => service.analyze({ ...ref, mode: 'asserted' }), (a) => `reasoner: ${a.reasoning.status}`);
    await timed(n, 'inferred hierarchy, list the top', () => service.children({ ...ref, mode: 'inferred' }), (p) => `${p.provenance.status}, ${p.total} at the top`);
    await timed(n, 'sum up a class (asserted and inferred parts)', () => service.summary({ ...ref, mode: 'asserted', classIri: top.nodes[0].class.iri }));
    lines.push('');
  }
  writeFileSync(OUT!, lines.join('\n'));
}, 900_000);
