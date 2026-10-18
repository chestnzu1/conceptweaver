import type { HierarchyNode, HierarchyPage, Iri } from './contracts';

/**
 * The hierarchy as someone reading it keeps it: the branches that have been fetched so far, the
 * ones that are open, and from those the lines to draw. Whoever shows the hierarchy uses this;
 * it knows nothing of how it is drawn, and nothing of where the branches come from.
 *
 * A class with several superclasses is in several places. Each place has a number of its own,
 * so that one of them can be opened without the others, while the class and what was fetched
 * for it are the same in all of them.
 */

/** A run of the subclasses of one class, as one or more pages gave it. */
export interface Part<N = HierarchyNode> {
  /** Where in the whole list the run starts. */
  offset: number;
  nodes: N[];
  /** What to ask for what follows the run, when something does. */
  nextCursor?: string;
}

/**
 * What has been fetched of the subclasses of one class: all of a short list, and of a long one
 * the runs that were asked for, in order and apart from each other. A class far down a long
 * list is fetched with the page it is on, not with everything before it.
 */
export interface Branch<N = HierarchyNode> {
  total: number;
  parts: Part<N>[];
}

/** The branch with one more page in it. Pages that meet become one run. */
export function withPage<N = HierarchyNode>(branch: Branch<N> | undefined, page: Pick<HierarchyPage, 'offset' | 'total' | 'nextCursor'> & { nodes: N[] }): Branch<N> {
  const added: Part<N> = { offset: page.offset, nodes: page.nodes, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  const parts: Part<N>[] = [];
  for (const part of [...(branch?.parts ?? []), added].sort((a, b) => a.offset - b.offset)) {
    const last = parts[parts.length - 1];
    const end = last ? last.offset + last.nodes.length : -1;
    if (!last || part.offset > end) {
      parts.push(part);
      continue;
    }
    // It starts inside the run before it, or where that one ends: whatever it has beyond it is added on.
    const beyond = part.nodes.slice(end - part.offset);
    if (!beyond.length) continue;
    const { nextCursor: _, ...rest } = last;
    parts[parts.length - 1] = { ...rest, nodes: [...last.nodes, ...beyond], ...(part.nextCursor ? { nextCursor: part.nextCursor } : {}) };
  }
  return { total: page.total, parts };
}

/** What the outline needs of a node, whichever hierarchy it is of: a class, or a property. */
export interface NodeRead {
  iri: Iri;
  childCount: number;
  inCycle?: boolean;
}

/** A class node, read as the outline needs it. The default for the class hierarchy, whose nodes are `HierarchyNode`s. */
const classRead = (n: HierarchyNode): NodeRead => ({ iri: n.class.iri, childCount: n.childCount, inCycle: n.inCycle });

/** Whether a subclass is among what has been fetched of a branch. */
export const holds = <N = HierarchyNode>(branch: Branch<N> | undefined, iri: Iri, read: (n: N) => NodeRead = classRead as (n: N) => NodeRead): boolean => !!branch?.parts.some((p) => p.nodes.some((n) => read(n).iri === iri));

/** How many of its subclasses have been fetched. */
export const fetchedOf = <N = HierarchyNode>(branch: Branch<N>): number => branch.parts.reduce((n, p) => n + p.nodes.length, 0);

/** The key the classes at the top are kept under, where a class is kept under its IRI. */
export const TOP = '';
/** The place everything is under. */
export const ROOT = 0;

/** The places classes are shown in: a class under the place of its parent. */
export class Places {
  private ids = new Map<string, number>();
  private count = ROOT;

  /** The number of the place a class has under a parent place. The same question always has the same answer. */
  at(parent: number, iri: Iri): number {
    const key = `${parent}\n${iri}`;
    let id = this.ids.get(key);
    if (id === undefined) this.ids.set(key, (id = ++this.count));
    return id;
  }
}

export type OutlineRow<N = HierarchyNode> =
  | {
      kind: 'class';
      place: number;
      depth: number;
      node: N;
      /** It has subclasses to show and is not a class met again on the way down. */
      expandable: boolean;
      open: boolean;
      /** Open, with its subclasses not fetched yet. */
      loading: boolean;
      /** The class is one of its own superclasses here: the branch is not followed a second time. */
      repeat: boolean;
    }
  | {
      /** A stretch of a list that has not been fetched: after a run, up to the next run or the end. */
      kind: 'more';
      /** The place whose list it is, and the class that is there (or TOP). */
      place: number;
      parent: Iri;
      depth: number;
      /** Where the stretch starts, and how many it leaves out. */
      offset: number;
      hidden: number;
      total: number;
      /** What to ask for its first page. */
      cursor: string;
    };

/**
 * The lines to draw: the hierarchy walked from the top, going into a class only where its place
 * is open and its subclasses have been fetched. Where a list has more than was fetched, a line
 * says so.
 */
export function rowsOf<N = HierarchyNode>(branches: ReadonlyMap<string, Branch<N>>, places: Places, open: ReadonlySet<number>, read: (n: N) => NodeRead = classRead as (n: N) => NodeRead): OutlineRow<N>[] {
  const rows: OutlineRow<N>[] = [];
  // The classes in a ring that the walk is under at the moment. Only they can be met again.
  const above = new Set<Iri>();
  const stack: { place: number; key: string; depth: number; part: number; next: number; ring?: Iri }[] = [{ place: ROOT, key: TOP, depth: 0, part: 0, next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const branch = branches.get(frame.key);
    const part = branch?.parts[frame.part];
    if (!branch || !part) {
      if (frame.ring !== undefined) above.delete(frame.ring);
      stack.pop();
      continue;
    }
    if (frame.next >= part.nodes.length) {
      const end = part.offset + part.nodes.length;
      const until = branch.parts[frame.part + 1]?.offset ?? branch.total;
      if (part.nextCursor && until > end) rows.push({ kind: 'more', place: frame.place, parent: frame.key, depth: frame.depth, offset: end, hidden: until - end, total: branch.total, cursor: part.nextCursor });
      frame.part++;
      frame.next = 0;
      continue;
    }
    const node = part.nodes[frame.next++];
    const r = read(node);
    const iri = r.iri;
    const place = places.at(frame.place, iri);
    const repeat = !!r.inCycle && above.has(iri);
    const expandable = r.childCount > 0 && !repeat;
    const isOpen = expandable && open.has(place);
    const fetched = branches.has(iri);
    rows.push({ kind: 'class', place, depth: frame.depth, node, expandable, open: isOpen, loading: isOpen && !fetched, repeat });
    if (!isOpen || !fetched) continue;
    if (r.inCycle) above.add(iri);
    stack.push({ place, key: iri, depth: frame.depth + 1, part: 0, next: 0, ...(r.inCycle ? { ring: iri } : {}) });
  }
  return rows;
}

/** The classes whose subclasses the lines need and that have not been fetched: the top, if it has not, and every open class that waits. */
export function wanting<N = HierarchyNode>(branches: ReadonlyMap<string, Branch<N>>, places: Places, open: ReadonlySet<number>, read: (n: N) => NodeRead = classRead as (n: N) => NodeRead): Iri[] {
  if (!branches.has(TOP)) return [TOP];
  const out = new Set<Iri>();
  for (const row of rowsOf(branches, places, open, read)) if (row.kind === 'class' && row.loading) out.add(read(row.node).iri);
  return [...out];
}

/**
 * Opens the hierarchy level by level from the top, fetching as it goes, until about `budget`
 * lines are on show. `cut` says that it stopped there with branches still closed. `fetch` puts
 * the branches of the classes it is given into `branches`; it is asked once for each level, for
 * all the classes of that level together, so that a deep hierarchy costs as many exchanges as
 * it has levels and not as many as it has branches.
 */
export async function openWide<N = HierarchyNode>(branches: ReadonlyMap<string, Branch<N>>, places: Places, fetch: (parents: Iri[]) => Promise<void>, budget: number, read: (n: N) => NodeRead = classRead as (n: N) => NodeRead): Promise<{ open: Set<number>; cut: boolean }> {
  const open = new Set<number>();
  if (!branches.has(TOP)) await fetch([TOP]);
  let lines = fetchedOf(branches.get(TOP) ?? { total: 0, parts: [] });
  let cut = false;
  let level: { place: number; key: string; above: ReadonlySet<Iri> }[] = [{ place: ROOT, key: TOP, above: new Set() }];
  while (level.length) {
    // The classes of this level to open, in order, for as long as there is room: a class is taken to bring all its subclasses.
    const opening: { place: number; iri: Iri; above: ReadonlySet<Iri> }[] = [];
    let expected = lines;
    for (const at of level) {
      for (const node of branches.get(at.key)?.parts.flatMap((p) => p.nodes) ?? []) {
        const r = read(node);
        const iri = r.iri;
        if (!r.childCount || (r.inCycle && at.above.has(iri))) continue;
        if (expected >= budget) {
          cut = true;
          continue;
        }
        expected += r.childCount;
        opening.push({ place: places.at(at.place, iri), iri, above: r.inCycle ? new Set([...at.above, iri]) : at.above });
      }
    }
    const missing = [...new Set(opening.map((x) => x.iri))].filter((iri) => !branches.has(iri));
    if (missing.length) await fetch(missing);
    level = [];
    for (const x of opening) {
      const branch = branches.get(x.iri);
      if (!branch) continue;
      lines += fetchedOf(branch);
      open.add(x.place);
      level.push({ place: x.place, key: x.iri, above: x.above });
    }
  }
  return { open, cut };
}
