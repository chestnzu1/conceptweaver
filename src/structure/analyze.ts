import { StructureError, type AnalysisBranch, type AnalysisBucket, type AnalysisFinding, type ClassRef, type ClassSetItem, type Iri, type StructureAnalysis, type StructureMetric } from './contracts';
import { byRef, depthsOf, type Hierarchy } from './graph';

/**
 * The hierarchy as a whole, in numbers: how many classes, how deep, how wide, and what about its
 * shape is worth a look. It goes through every class, so for a large ontology it takes a while:
 * it works in short stretches, gives the page its turn in between, says how far it has got, and
 * stops when it is told to.
 *
 * What is "unusual" is judged against the ontology itself: a class has unusually many
 * subclasses when it has far more than the other classes of this ontology that have any. None
 * of that is an error. Only an unsatisfiable class is a reasoner's finding, and it is counted
 * only where a reasoner's answer is in hand.
 */

/** A measured hierarchy: the numbers that are handed out, and the classes behind each of them. */
export interface Analysis {
  result: Pick<StructureAnalysis, 'metrics' | 'sets' | 'depth' | 'subclasses' | 'superclasses' | 'branches' | 'findings' | 'deepest' | 'warnings'>;
  sets: Map<string, ClassSetItem[]>;
}

export interface AnalyzeInput {
  /** The hierarchy to measure. */
  hierarchy: Hierarchy;
  /** The asserted hierarchy of the same ontology: itself, when that is the one being measured. */
  asserted: Hierarchy;
  /** The reasoner's hierarchy, where it has a current answer: for the classes it finds unsatisfiable. */
  reasoned: Hierarchy | null;
  /** How many statements each class takes part in, where the source knows. Without it, a class's superclasses and subclasses are counted. */
  connections?: ReadonlyMap<Iri, number>;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** How many of the largest branches are given one by one; the rest are summed up. */
const BRANCHES = 12;
/** How many levels are given one by one before they are put in ranges. */
const LEVELS = 12;
/** The ranges classes are counted in by how many direct subclasses they have. */
const SUBCLASS_RANGES: [number, number | null][] = [[0, 0], [1, 1], [2, 2], [3, 5], [6, 10], [11, 20], [21, 50], [51, null]];
const SUPERCLASS_RANGES: [number, number | null][] = [[0, 0], [1, 1], [2, 2], [3, 3], [4, null]];
/** A class has to have at least this many subclasses, levels or connections before it can be called unusual at all. */
const WIDE_AT_LEAST = 8;
const DEEP_AT_LEAST = 6;
const CONNECTED_AT_LEAST = 10;
const EXAMPLES = 5;
const CHAINS = 5;

/** The value above which a number is far out, by Tukey's fences: the upper quartile and so many times the spread of the middle half. */
function fence(values: number[], times: number): number {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i);
    return sorted[lo] + (sorted[Math.min(sorted.length - 1, lo + 1)] - sorted[lo]) * (i - lo);
  };
  return at(0.75) + times * (at(0.75) - at(0.25));
}

export async function analyzeHierarchy(input: AnalyzeInput): Promise<Analysis> {
  const { hierarchy: h, asserted, reasoned } = input;
  const inferred = h !== asserted;
  // Works for a stretch, then lets the page have its turn; stops for good when the answer is no longer wanted.
  let since = performance.now();
  const pause = async (fraction: number) => {
    if (input.signal?.aborted) throw new StructureError('aborted', 'The measuring was given up.');
    if (performance.now() - since < 12) return;
    input.onProgress?.(fraction);
    await new Promise((done) => setTimeout(done, 0));
    since = performance.now();
    if (input.signal?.aborted) throw new StructureError('aborted', 'The measuring was given up.');
  };

  const sets = new Map<string, ClassSetItem[]>();
  const put = (set: string, item: ClassSetItem) => (sets.get(set) ?? sets.set(set, []).get(set)!).push(item);
  const depths = depthsOf(h);
  // The classes that have a place of their own in the hierarchy: not owl:Nothing, and not what is listed under it.
  const placed = [...h.entries.values()].filter((e) => !e.ref.builtin && !e.unsatisfiable);
  const total = placed.length || 1;

  // ---- one pass over the classes
  let placedClasses = 0;
  let depthSum = 0;
  let maxDepth = 0;
  const levelOf = new Map<Iri, number>();
  const subclassCounts: number[] = [];
  const leafDepths: number[] = [];
  const linkCounts: number[] = [];
  for (const [n, e] of placed.entries()) {
    if (n % 512 === 0) await pause((0.45 * n) / total);
    const level = depths.get(e.ref.iri)!.max;
    levelOf.set(e.ref.iri, level);
    placedClasses += e.size;
    depthSum += level * e.size;
    maxDepth = Math.max(maxDepth, level);
    if (!e.children.length) {
      put('leaves', { class: e.ref, value: level });
      leafDepths.push(level);
    } else subclassCounts.push(e.children.length);
    if (e.parents.length > 1) put('multipleInheritance', { class: e.ref, value: e.parents.length, related: e.parents.map((p) => h.entries.get(p)!.ref).sort(byRef) });
    if (inferred && e.size > 1) put('equivalent', { class: e.ref, related: e.equivalents });
    linkCounts.push(input.connections?.get(e.ref.iri) ?? e.parents.length + e.children.length);
  }

  // ---- classes by level, by number of subclasses and by number of superclasses
  const width = Math.max(1, Math.ceil(maxDepth / LEVELS));
  const depthRanges: [number, number | null][] = [];
  for (let from = 1; from <= maxDepth; from += width) depthRanges.push([from, Math.min(maxDepth, from + width - 1)]);
  const buckets = (name: string, ranges: [number, number | null][], valueOf: (iri: Iri) => number): AnalysisBucket[] => {
    const made = ranges.map(([from, to]) => ({ from, to, count: 0, set: `${name}:${from}${to === null ? '+' : to === from ? '' : '-' + to}` }));
    for (const e of placed) {
      const value = valueOf(e.ref.iri);
      const bucket = made.find((b) => value >= b.from && (b.to === null || value <= b.to));
      if (!bucket) continue;
      bucket.count += 1;
      put(bucket.set, { class: e.ref, value });
    }
    return made;
  };
  const depth = buckets('depth', depthRanges, (iri) => levelOf.get(iri)!);
  const subclasses = buckets('subclasses', SUBCLASS_RANGES, (iri) => h.entries.get(iri)!.children.length);
  const superclasses = buckets('superclasses', SUPERCLASS_RANGES, (iri) => h.entries.get(iri)!.parents.length);
  await pause(0.5);

  // ---- what is stated, whichever hierarchy is being measured
  for (const e of asserted.entries.values()) if (!e.parents.length) put('noStatedSuperclass', { class: e.ref });
  for (const ring of asserted.cycles) {
    const members = ring.map((iri) => asserted.entries.get(iri)!.ref).sort(byRef);
    for (const c of members) put('inCycles', { class: c, related: members.filter((x) => x !== c) });
  }
  let groups = sets.get('equivalent')?.length ?? 0;
  if (!inferred) {
    // The groups that stated equivalence makes: each class with the ones it is stated, directly or through another, to be equivalent to.
    const leader = new Map<Iri, Iri>();
    const find = (x: Iri): Iri => {
      let root = x;
      while (leader.has(root)) root = leader.get(root)!;
      return root;
    };
    for (const e of asserted.entries.values()) {
      for (const other of e.equivalents) {
        const [a, b] = [find(e.ref.iri), find(other.iri)];
        if (a !== b) leader.set(a, b);
      }
    }
    const found = new Set<Iri>();
    for (const e of asserted.entries.values()) {
      if (!e.equivalents.length) continue;
      found.add(find(e.ref.iri));
      put('equivalent', { class: e.ref, related: e.equivalents });
    }
    groups = found.size;
  }
  if (reasoned) for (const e of reasoned.entries.values()) if (e.unsatisfiable) put('unsatisfiable', { class: e.ref });

  // ---- stated superclasses that are stated twice over
  // A superclass that is stated outright and is also reached through another stated superclass. Taking
  // the statement away changes nothing that follows, which is what redundant means. A stated superclass
  // that a reasoner merely does not put directly above the class is another matter and is not counted:
  // the reasoner may have needed that very statement to find the class in between.
  let redundant = 0;
  const many = [...asserted.entries.values()].filter((e) => e.parents.length > 1);
  for (const [n, e] of many.entries()) {
    if (n % 128 === 0) await pause(0.5 + (0.3 * n) / (many.length || 1));
    // Everything above its superclasses. One of them is in there only if another one leads to it.
    const beyond = new Set<Iri>();
    const todo = e.parents.flatMap((p) => asserted.entries.get(p)!.parents);
    while (todo.length) {
      const up = todo.pop()!;
      if (beyond.has(up) || up === e.ref.iri) continue;
      beyond.add(up);
      todo.push(...asserted.entries.get(up)!.parents);
    }
    for (const p of e.parents) {
      if (!beyond.has(p)) continue;
      redundant += 1;
      put('redundant', { class: e.ref, related: [asserted.entries.get(p)!.ref] });
    }
  }

  // ---- the branches, largest first
  const sized: AnalysisBranch[] = [];
  const tops = h.top.filter((iri) => !h.entries.get(iri)!.ref.builtin);
  for (const [n, root] of tops.entries()) {
    await pause(0.8 + (0.18 * n) / (tops.length || 1));
    put('top', { class: h.entries.get(root)!.ref });
    const seen = new Set<Iri>([root]);
    const todo = [root];
    let count = 0;
    let deepest = 1;
    while (todo.length) {
      const e = h.entries.get(todo.pop()!)!;
      count += e.size;
      deepest = Math.max(deepest, levelOf.get(e.ref.iri) ?? 1);
      for (const c of e.children) {
        if (seen.has(c)) continue;
        seen.add(c);
        todo.push(c);
      }
    }
    sized.push({ class: h.entries.get(root)!.ref, classes: count, depth: deepest - 1, set: `branch:${root}` });
  }
  sized.sort((a, b) => b.classes - a.classes || byRef(a.class, b.class));
  const rest = sized.slice(BRANCHES);

  // ---- what stands out
  const findings: AnalysisFinding[] = [];
  const finding = (kind: AnalysisFinding['kind'], set: string, count?: number, above?: number) => {
    const items = sets.get(set) ?? [];
    if (!items.length) return;
    findings.push({ kind, count: count ?? items.length, ...(above !== undefined ? { above } : {}), examples: [...new Set(items.map((x) => x.class))].sort(byRef).slice(0, EXAMPLES), set });
  };
  const far = (name: string, values: number[], atLeast: number, times: number, valueOf: (iri: Iri) => number | undefined) => {
    // With only a handful to compare there is no "usual" to be far from: then the least that counts at all decides.
    const above = values.length < 4 ? atLeast - 1 : Math.max(atLeast - 1, Math.floor(fence(values, times)));
    for (const e of placed) {
      const value = valueOf(e.ref.iri);
      if (value !== undefined && value > above) put(name, { class: e.ref, value });
    }
    return above;
  };
  const wideAbove = far('wide', subclassCounts, WIDE_AT_LEAST, 3, (iri) => h.entries.get(iri)!.children.length || undefined);
  const deepAbove = far('deep', leafDepths, DEEP_AT_LEAST, 1.5, (iri) => (h.entries.get(iri)!.children.length ? undefined : levelOf.get(iri)));
  const linksOf = new Map(placed.map((e, i) => [e.ref.iri, linkCounts[i]]));
  const connectedAbove = far('connected', linkCounts, CONNECTED_AT_LEAST, 3, (iri) => linksOf.get(iri));
  finding('unsatisfiable', 'unsatisfiable');
  finding('cycle', 'inCycles', asserted.cycles.length);
  finding('redundant-superclass', 'redundant', redundant);
  finding('multiple-inheritance', 'multipleInheritance');
  finding('wide', 'wide', undefined, wideAbove);
  finding('deep', 'deep', undefined, deepAbove);
  finding('connected', 'connected', undefined, connectedAbove);

  // ---- the longest ways down: from each of the deepest leaves, up by the superclass that is itself deepest
  const deepestLeaves = (sets.get('leaves') ?? []).slice().sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || byRef(a.class, b.class)).slice(0, CHAINS);
  const deepest: ClassRef[][] = [];
  for (const leaf of deepestLeaves) {
    const chain: ClassRef[] = [];
    const passed = new Set<Iri>();
    let at: Iri | undefined = leaf.class.iri;
    while (at !== undefined && !passed.has(at)) {
      passed.add(at);
      chain.push(h.entries.get(at)!.ref);
      const above: Iri[] = h.entries.get(at)!.parents;
      at = [...above].sort((x, y) => (levelOf.get(y) ?? 0) - (levelOf.get(x) ?? 0))[0];
    }
    deepest.push(chain.reverse());
  }
  input.onProgress?.(1);

  const count = (set: string) => sets.get(set)?.length ?? 0;
  const metrics: Record<StructureMetric, number | null> = {
    classes: asserted.entries.size,
    top: count('top'),
    leaves: count('leaves'),
    maxDepth,
    averageDepth: placedClasses ? Math.round((depthSum / placedClasses) * 100) / 100 : 0,
    multipleInheritance: count('multipleInheritance'),
    noStatedSuperclass: count('noStatedSuperclass'),
    equivalenceGroups: groups,
    // Without a reasoner's answer nothing is known about this: that is not the same as none.
    unsatisfiable: reasoned ? count('unsatisfiable') : null,
    inCycles: count('inCycles'),
  };
  const named: Partial<Record<StructureMetric, string>> = { top: 'top', leaves: 'leaves', multipleInheritance: 'multipleInheritance', noStatedSuperclass: 'noStatedSuperclass', equivalenceGroups: 'equivalent', unsatisfiable: 'unsatisfiable', inCycles: 'inCycles' };
  const warnings: string[] = [];
  if (inferred && h.entries.has('http://www.w3.org/2002/07/owl#Nothing')) warnings.push('The classes that can have no instance are counted among the classes and as unsatisfiable. They have no level and no place of their own, so they are left out of every other number.');
  return {
    result: {
      metrics,
      sets: Object.fromEntries(Object.entries(named).filter(([, set]) => count(set!) > 0)),
      depth,
      subclasses,
      superclasses,
      branches: { largest: sized.slice(0, BRANCHES), others: rest.length ? { branches: rest.length, classes: rest.reduce((n, b) => n + b.classes, 0) } : null },
      findings,
      deepest,
      warnings,
    },
    sets,
  };
}

/** The classes of one branch: its top class and everything below it, each with the level it is on. Worked out when it is asked for. */
export function branchMembers(h: Hierarchy, root: Iri): ClassSetItem[] {
  const depths = depthsOf(h);
  const seen = new Set<Iri>([root]);
  const todo = [root];
  const out: ClassSetItem[] = [];
  while (todo.length) {
    const e = h.entries.get(todo.pop()!);
    if (!e) continue;
    out.push({ class: e.ref, value: depths.get(e.ref.iri)?.max });
    for (const c of e.children) {
      if (seen.has(c)) continue;
      seen.add(c);
      todo.push(c);
    }
  }
  return out;
}
