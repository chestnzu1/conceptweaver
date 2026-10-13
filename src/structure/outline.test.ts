import { describe, expect, it } from 'vitest';
import type { HierarchyQuery, Iri, StructureService } from './contracts';
import { graphOf, NS, wide } from './fixtures';
import type { ClassGraphInput } from './graph';
import { fetchedOf, holds, openWide, Places, ROOT, rowsOf, TOP, wanting, withPage, type Branch, type OutlineRow } from './outline';
import { createGraphService, PAGE } from './service';

/** A reader of a hierarchy: what it has fetched, and how it fetches more. `asked` counts the questions put to the service. */
function reading(input: ClassGraphInput) {
  const service: StructureService = createGraphService(() => ({ ontologyId: 'onto', revisionId: 'r1', graph: () => input }));
  const branches = new Map<string, Branch>();
  const places = new Places();
  const counter = { asked: 0 };
  const ask = async (parent: Iri, extra: Partial<HierarchyQuery> = {}) => {
    counter.asked++;
    const page = await service.children({ ontologyId: 'onto', revisionId: 'r1', mode: 'asserted', ...(parent === TOP ? {} : { parentIri: parent }), ...extra });
    branches.set(parent, withPage(branches.get(parent), page));
    return branches.get(parent)!;
  };
  /** The same for several classes in one question, which is how a whole level is fetched. */
  const askMany = async (parents: Iri[]) => {
    counter.asked++;
    const pages = await service.branches({ ontologyId: 'onto', revisionId: 'r1', mode: 'asserted', parents: parents.map((p) => (p === TOP ? {} : { parentIri: p })) });
    parents.forEach((p, n) => branches.set(p, withPage(branches.get(p), pages[n])));
  };
  /** Fetches whatever the open places still wait for, as a view does after each change. */
  const settle = async (open: ReadonlySet<number>) => {
    for (let need = wanting(branches, places, open); need.length; need = wanting(branches, places, open)) await Promise.all(need.map((p) => ask(p)));
  };
  const place = (...names: string[]) => names.reduce((at, name) => places.at(at, NS + name), ROOT);
  return { branches, places, ask, askMany, settle, place, counter };
}

const outline = (rows: OutlineRow[]) =>
  rows
    .map((r) => (r.kind === 'more' ? `${'  '.repeat(r.depth)}… ${r.hidden} more` : `${'  '.repeat(r.depth)}${r.expandable ? (r.open ? '▼ ' : '▶ ') : '  '}${r.node.class.label}${r.repeat ? ' (again)' : ''}${r.loading ? ' (waiting)' : ''}`))
    .join('\n');

const CAST = 'Person; Actor < Person; Employee < Person; WorkingActor < Actor, Employee; Stand-in < WorkingActor; Film';

describe('the hierarchy as it is read', () => {
  it('draws what is open and fetched, and nothing below a closed class', async () => {
    const r = reading(graphOf(CAST));
    expect(wanting(r.branches, r.places, new Set())).toEqual([TOP]);
    await r.settle(new Set());
    expect(outline(rowsOf(r.branches, r.places, new Set()))).toBe(['  Film', '▶ Person'].join('\n'));
    // Only the top has been asked for: what is under a closed class is not fetched.
    expect(r.counter.asked).toBe(1);

    const open = new Set([r.place('Person')]);
    expect(outline(rowsOf(r.branches, r.places, open))).toBe(['  Film', '▼ Person (waiting)'].join('\n'));
    expect(wanting(r.branches, r.places, open)).toEqual([NS + 'Person']);
    await r.settle(open);
    expect(outline(rowsOf(r.branches, r.places, open))).toBe(['  Film', '▼ Person', '  ▶ Actor', '  ▶ Employee'].join('\n'));
    expect(r.counter.asked).toBe(2);
  });

  it('shows a class with two superclasses in two places that open apart, fetched once', async () => {
    const r = reading(graphOf(CAST));
    const open = new Set([r.place('Person'), r.place('Person', 'Actor'), r.place('Person', 'Employee'), r.place('Person', 'Actor', 'WorkingActor')]);
    await r.settle(open);
    const rows = rowsOf(r.branches, r.places, open);
    expect(outline(rows)).toBe(['  Film', '▼ Person', '  ▼ Actor', '    ▼ WorkingActor', '        Stand-in', '  ▼ Employee', '    ▶ WorkingActor'].join('\n'));
    const twice = rows.filter((x) => x.kind === 'class' && x.node.class.label === 'WorkingActor');
    expect(twice).toHaveLength(2);
    // One class, by its IRI, in two places.
    expect(new Set(twice.map((x) => (x.kind === 'class' ? x.node.class.iri : ''))).size).toBe(1);
    expect(new Set(twice.map((x) => x.place)).size).toBe(2);
    expect(twice.every((x) => x.kind === 'class' && x.node.parentCount === 2)).toBe(true);
    // Top, Person, Actor, Employee and WorkingActor: the second place of WorkingActor needed no question.
    expect(r.counter.asked).toBe(5);
    expect(r.branches.size).toBe(5);
  });

  it('follows a ring of classes once and marks where it comes round', async () => {
    const r = reading(graphOf('Animal; Cat < Feline; Feline < Cat; Lion < Cat'));
    // Every place there could be is open: the ring still ends.
    const wide = await openWide(r.branches, r.places, r.askMany, 1000);
    const rows = rowsOf(r.branches, r.places, wide.open);
    expect(outline(rows)).toBe(['  Animal', '▼ Cat', '  ▼ Feline', '      Cat (again)', '    Lion'].join('\n'));
    expect(wide.cut).toBe(false);
    expect(rows.filter((x) => x.kind === 'class' && x.node.inCycle)).toHaveLength(3);
  });

  it('keeps a place its number: the same class under the same place is the same place', () => {
    const places = new Places();
    const a = places.at(ROOT, NS + 'Person');
    expect(places.at(ROOT, NS + 'Person')).toBe(a);
    expect(places.at(a, NS + 'Person')).not.toBe(a);
    expect(places.at(ROOT, NS + 'Film')).not.toBe(a);
  });
});

describe('a long list of subclasses', () => {
  it('is fetched a page at a time, with a line for what has not been', async () => {
    const r = reading(wide(450));
    const open = new Set([r.place('Top')]);
    await r.settle(open);
    let rows = rowsOf(r.branches, r.places, open);
    expect(rows).toHaveLength(1 + PAGE + 1);
    const more = rows[rows.length - 1];
    expect(more).toMatchObject({ kind: 'more', parent: NS + 'Top', offset: PAGE, hidden: 250, total: 450, depth: 1 });

    await r.ask(NS + 'Top', { cursor: more.kind === 'more' ? more.cursor : '' });
    rows = rowsOf(r.branches, r.places, open);
    expect(rows).toHaveLength(1 + 400 + 1);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'more', offset: 400, hidden: 50 });
    expect(r.branches.get(NS + 'Top')!.parts).toHaveLength(1);
  });

  it('reaches a class far down it by the page it is on, leaving out what is between', async () => {
    const r = reading(wide(5000));
    const open = new Set([r.place('Top')]);
    await r.settle(open);
    const wanted = `${NS}K003417`;
    expect(holds(r.branches.get(NS + 'Top'), wanted)).toBe(false);
    await r.ask(NS + 'Top', { through: wanted });
    const branch = r.branches.get(NS + 'Top')!;
    expect(holds(branch, wanted)).toBe(true);
    expect(branch.parts.map((p) => [p.offset, p.nodes.length])).toEqual([[0, PAGE], [3400, PAGE]]);
    expect(fetchedOf(branch)).toBe(2 * PAGE);
    const rows = rowsOf(r.branches, r.places, open);
    // The class, 400 subclasses, and a line for each of the two stretches that were not fetched.
    expect(rows).toHaveLength(1 + 2 * PAGE + 2);
    expect(rows.filter((x) => x.kind === 'more').map((x) => (x.kind === 'more' ? [x.offset, x.hidden] : []))).toEqual([[PAGE, 3200], [3600, 1400]]);
  });

  it('joins pages that meet, and never lists a class twice', () => {
    const page = (offset: number, n: number, next?: string) => ({ offset, total: 10, nodes: Array.from({ length: n }, (_, i) => ({ class: { iri: `${NS}N${offset + i}`, label: `N${offset + i}` }, equivalents: [], childCount: 0, parentCount: 1 })), ...(next ? { nextCursor: next } : {}) });
    let branch = withPage(undefined, page(0, 3, 'c3'));
    branch = withPage(branch, page(6, 2, 'c8'));
    expect(branch.parts.map((p) => [p.offset, p.nodes.length, p.nextCursor])).toEqual([[0, 3, 'c3'], [6, 2, 'c8']]);
    // The page between them closes the gap: one run, going on from where the last one ended.
    branch = withPage(branch, page(3, 3, 'c6'));
    expect(branch.parts.map((p) => [p.offset, p.nodes.length, p.nextCursor])).toEqual([[0, 8, 'c8']]);
    // A page that was fetched before adds nothing.
    branch = withPage(branch, page(2, 4, 'c6'));
    expect(branch.parts.map((p) => [p.offset, p.nodes.length, p.nextCursor])).toEqual([[0, 8, 'c8']]);
    branch = withPage(branch, page(8, 2));
    expect(branch.parts).toHaveLength(1);
    expect(branch.parts[0].nodes.map((n) => n.class.label)).toEqual(['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9']);
    expect(branch.parts[0].nextCursor).toBeUndefined();
  });
});

describe('opening the hierarchy wide', () => {
  /** A class with ten subclasses, each with ten, each of those with ten: 1,111 classes. */
  const bushy = () => {
    const lines = ['R'];
    for (let a = 0; a < 10; a++) {
      lines.push(`A${a} < R`);
      for (let b = 0; b < 10; b++) {
        lines.push(`B${a}${b} < A${a}`);
        for (let c = 0; c < 10; c++) lines.push(`C${a}${b}${c} < B${a}${b}`);
      }
    }
    return graphOf(lines.join(';'));
  };

  it('opens level by level and stops at about the number of lines it was given', async () => {
    const r = reading(bushy());
    const some = await openWide(r.branches, r.places, r.askMany, 60);
    const rows = rowsOf(r.branches, r.places, some.open);
    expect(some.cut).toBe(true);
    // R and its ten, then whole branches of ten until sixty lines are reached.
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(rows.length).toBeLessThan(80);
    expect(rows.some((x) => x.kind === 'class' && x.loading)).toBe(false);
    // One question for each level that was opened, and nothing below a closed branch was fetched.
    expect(r.counter.asked).toBe(3);
    expect(r.branches.size).toBe(7);
  });

  it('opens everything when there is room for it', async () => {
    const r = reading(bushy());
    const all = await openWide(r.branches, r.places, r.askMany, 5000);
    expect(all.cut).toBe(false);
    expect(rowsOf(r.branches, r.places, all.open)).toHaveLength(1111);
  });

  it('draws a small part of a large hierarchy: what is closed or not fetched is not a line', async () => {
    const input = wide(20_000);
    const r = reading(input);
    const some = await openWide(r.branches, r.places, r.askMany, 200);
    const rows = rowsOf(r.branches, r.places, some.open);
    expect(input.classes).toHaveLength(20_001);
    expect(rows).toHaveLength(1 + PAGE + 1);
    expect(r.counter.asked).toBe(2);
  });

  it('walks a hierarchy thousands of levels deep, all of it open, without running out of stack', async () => {
    const depth = 6000;
    const input: ClassGraphInput = { classes: [], subClassOf: [], equivalent: [] };
    for (let i = 0; i < depth; i++) {
      input.classes.push({ iri: `${NS}C${i}`, label: `C${i}` });
      if (i) input.subClassOf.push({ sub: `${NS}C${i}`, sup: `${NS}C${i - 1}` });
    }
    const r = reading(input);
    const all = await openWide(r.branches, r.places, r.askMany, depth + 10);
    const rows = rowsOf(r.branches, r.places, all.open);
    expect(rows).toHaveLength(depth);
    expect(rows[depth - 1]).toMatchObject({ kind: 'class', depth: depth - 1, expandable: false });
    // A question for each level, of which a chain has as many as it has classes.
    expect(r.counter.asked).toBe(depth);
  });
});
