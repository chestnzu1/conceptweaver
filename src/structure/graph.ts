import { OWL_NOTHING, StructureError, type ClassRef, type HierarchyNode, type Iri } from './contracts';

/**
 * The class hierarchy as a graph, and the questions that are asked of it. Nothing here knows
 * where the classes come from: it is given their IRIs and the subclass links between them.
 *
 * A hierarchy is not a tree. A class may have several superclasses, and classes may be each
 * other's superclasses; both are valid OWL. Every walk here keeps count of where it has been
 * and none of them calls itself, so a ring of classes cannot make one run on and a hierarchy
 * thousands of levels deep cannot exhaust the stack.
 *
 * There are two hierarchies, built from the same classes. The asserted one has a place for each
 * class and the links that are stated, rings and all. The inferred one has a place for each
 * group of classes a reasoner entails to be equivalent, under the groups directly above it, and
 * so has no rings; the classes that can have no instance are set apart under owl:Nothing.
 */

export interface ClassInput {
  iri: Iri;
  label: string;
  /** Other text a search should find the class by: its other labels, its IRI written with a prefix. */
  search?: string[];
  external?: boolean;
  /** How many class expressions without a name it is stated to be a subclass of. */
  anonymousSuperclasses?: number;
}

/** What a hierarchy is built from. Links that name a class that is not listed are left out. */
export interface ClassGraphInput {
  classes: ClassInput[];
  /** Subclass links between named classes. A superclass that is an anonymous class expression is not a class and has no place here. */
  subClassOf: { sub: Iri; sup: Iri }[];
  /** Pairs of named classes that are equivalent. */
  equivalent: { a: Iri; b: Iri }[];
  /** Pairs of named classes that are stated to be disjoint. */
  disjoint?: { a: Iri; b: Iri }[];
}

/** What a reasoner entails about the classes, for the inferred hierarchy to be built from. */
export interface EntailedInput {
  /** Entailed subclass links between named classes. */
  subClassOf: { sub: Iri; sup: Iri }[];
  /** direct: each class with the classes directly above it. all: every link that is entailed, of which the direct ones are worked out here. */
  links: 'direct' | 'all';
  /** Groups of classes that are entailed to be equivalent. */
  equivalent: Iri[][];
  /** Classes that can never have an instance. */
  unsatisfiable: Iri[];
}

interface Entry {
  ref: ClassRef;
  /** Everything a search looks through, in lower case. */
  text: string;
  parents: Iri[];
  /** In order of label. */
  children: Iri[];
  /** In the asserted hierarchy, classes with a place of their own; in the inferred one, the classes that share this place. */
  equivalents: ClassRef[];
  /** In the asserted hierarchy: the classes it is stated to be disjoint with. */
  disjoints: ClassRef[];
  /** How many named classes have this place: one, and in the inferred hierarchy the equivalent ones as well. */
  size: number;
  inCycle: boolean;
  unsatisfiable: boolean;
  anonymousSuperclasses: number;
}

export interface Hierarchy {
  entries: Map<Iri, Entry>;
  /** The classes at the top, in order of label. */
  top: Iri[];
  /** The groups of classes that are each other's superclasses. None in the inferred hierarchy. */
  cycles: Iri[][];
  /** In the inferred hierarchy: each class that shares a place, with the class that speaks for the place. */
  alias: Map<Iri, Iri>;
  /** In the inferred hierarchy: the links that are entailed and nowhere stated, as "sub\nsup". */
  entailedOnly: Set<string>;
  /** Worked out when first asked for. */
  depths?: Map<Iri, { min: number; max: number }>;
}

const collator = new Intl.Collator();
const refOf = (c: ClassInput): ClassRef => ({ iri: c.iri, label: c.label, ...(c.external ? { external: true } : {}) });
const textOf = (c: ClassInput): string => [c.label, c.iri, ...(c.search ?? [])].join('\n').toLowerCase();
const entry = (c: ClassInput): Entry => ({
  ref: refOf(c),
  text: textOf(c),
  parents: [],
  children: [],
  equivalents: [],
  disjoints: [],
  size: 1,
  inCycle: false,
  unsatisfiable: false,
  anonymousSuperclasses: c.anonymousSuperclasses ?? 0,
});
const sorter = (entries: Map<Iri, Entry>) => (x: Iri, y: Iri) => collator.compare(entries.get(x)!.ref.label, entries.get(y)!.ref.label) || (x < y ? -1 : x > y ? 1 : 0);
/** In order of label, and of IRI where two have the same label. */
export const byRef = (a: ClassRef, b: ClassRef) => collator.compare(a.label, b.label) || (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0);

export function buildHierarchy(input: ClassGraphInput): Hierarchy {
  const entries = new Map<Iri, Entry>();
  // An IRI is one class, however often it is listed.
  for (const c of input.classes) if (!entries.has(c.iri)) entries.set(c.iri, entry(c));
  for (const { sub, sup } of input.subClassOf) {
    const a = entries.get(sub);
    const b = entries.get(sup);
    // A class is not listed under itself, and a link stated twice is one link.
    if (!a || !b || sub === sup || a.parents.includes(sup)) continue;
    a.parents.push(sup);
    b.children.push(sub);
  }
  for (const { a, b } of input.equivalent) {
    const x = entries.get(a);
    const y = entries.get(b);
    if (!x || !y || a === b || x.equivalents.some((e) => e.iri === b)) continue;
    x.equivalents.push(y.ref);
    y.equivalents.push(x.ref);
  }
  for (const { a, b } of input.disjoint ?? []) {
    const x = entries.get(a);
    const y = entries.get(b);
    if (!x || !y || x.disjoints.some((e) => e.iri === b)) continue;
    x.disjoints.push(y.ref);
    if (a !== b) y.disjoints.push(x.ref);
  }
  const byLabel = sorter(entries);
  for (const e of entries.values()) {
    e.children.sort(byLabel);
    e.equivalents.sort(byRef);
    e.disjoints.sort(byRef);
  }

  const cycles = rings(entries);
  const top: Iri[] = [];
  for (const [iri, e] of entries) if (!e.parents.length) top.push(iri);
  for (const ring of cycles) {
    const inside = new Set(ring);
    for (const iri of ring) entries.get(iri)!.inCycle = true;
    // Classes that are only each other's superclasses have nothing above them to be reached
    // from. One of them is listed at the top, so that every class is somewhere in the hierarchy.
    if (ring.every((iri) => entries.get(iri)!.parents.every((p) => inside.has(p)))) top.push([...ring].sort(byLabel)[0]);
  }
  top.sort(byLabel);
  return { entries, top, cycles, alias: new Map(), entailedOnly: new Set() };
}

/**
 * The hierarchy a reasoner entails. Classes that are entailed to be equivalent share one place,
 * under the name of one of them; that includes classes that are entailed to be each other's
 * superclasses, which is what equivalent means. Each place is under the places directly above
 * it and no others. A class that can have no instance, and with it every class below it, is
 * listed under owl:Nothing and nowhere else.
 */
export function buildInferredHierarchy(input: ClassGraphInput, entailed: EntailedInput): Hierarchy {
  const classes = new Map<Iri, ClassInput>();
  for (const c of input.classes) if (!classes.has(c.iri)) classes.set(c.iri, c);
  const links = entailed.subClassOf.filter((l) => l.sub !== l.sup && classes.has(l.sub) && classes.has(l.sup));

  // What is below a class without instances has none either.
  const empty = new Set(entailed.unsatisfiable.filter((iri) => classes.has(iri)));
  if (empty.size) {
    const below = new Map<Iri, Iri[]>();
    for (const l of links) (below.get(l.sup) ?? below.set(l.sup, []).get(l.sup)!).push(l.sub);
    const todo = [...empty];
    while (todo.length) {
      for (const sub of below.get(todo.pop()!) ?? []) {
        if (empty.has(sub)) continue;
        empty.add(sub);
        todo.push(sub);
      }
    }
  }

  // The classes that share a place: the groups the reasoner names, and any that its links make each other's superclasses.
  const leader = new Map<Iri, Iri>();
  const find = (x: Iri): Iri => {
    let root = x;
    while (leader.get(root) !== undefined && leader.get(root) !== root) root = leader.get(root)!;
    for (let at = x; at !== root; ) {
      const next = leader.get(at)!;
      leader.set(at, root);
      at = next;
    }
    return root;
  };
  const join = (a: Iri, b: Iri) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) leader.set(x, y);
  };
  for (const group of entailed.equivalent) {
    const members = group.filter((iri) => classes.has(iri) && !empty.has(iri));
    for (const m of members.slice(1)) join(members[0], m);
  }
  const live = empty.size ? links.filter((l) => !empty.has(l.sub) && !empty.has(l.sup)) : links;
  {
    // Only what the search for rings needs of each group: what is above it and what is below. A link given twice does no harm there.
    const up = new Map<Iri, { parents: Iri[]; children: Iri[] }>();
    const at = (iri: Iri) => up.get(iri) ?? up.set(iri, { parents: [], children: [] }).get(iri)!;
    for (const l of live) {
      const [a, b] = [find(l.sub), find(l.sup)];
      if (a === b) continue;
      at(a).parents.push(b);
      at(b).children.push(a);
    }
    for (const ring of rings(up)) for (const iri of ring.slice(1)) join(ring[0], iri);
  }

  // Each group under the name of the first of its classes by label.
  const groups = new Map<Iri, ClassInput[]>();
  for (const c of classes.values()) {
    if (empty.has(c.iri)) continue;
    const key = find(c.iri);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  const entries = new Map<Iri, Entry>();
  const alias = new Map<Iri, Iri>();
  const speaker = new Map<Iri, Iri>();
  for (const [key, members] of groups) {
    // Nearly every class has a place to itself: only the ones that share one need sorting out.
    if (members.length > 1) members.sort((a, b) => collator.compare(a.label, b.label) || (a.iri < b.iri ? -1 : 1));
    const [first, ...rest] = members;
    const e = entry(first);
    if (rest.length) {
      e.equivalents = rest.map(refOf);
      e.text = members.map(textOf).join('\n');
      e.size = members.length;
      for (const c of rest) alias.set(c.iri, first.iri);
    }
    entries.set(first.iri, e);
    speaker.set(key, first.iri);
  }
  const placeOf = (iri: Iri) => speaker.get(find(iri))!;

  // Every place above each place, as far as the links say; then the ones directly above it.
  const above = new Map<Iri, Set<Iri>>();
  for (const l of live) {
    const [a, b] = [placeOf(l.sub), placeOf(l.sup)];
    if (a !== b) (above.get(a) ?? above.set(a, new Set()).get(a)!).add(b);
  }
  for (const [iri, ups] of above) {
    let direct = [...ups];
    if (entailed.links === 'all') {
      // Given every link, the place with the most above it is the nearest, and whatever is above
      // a nearer place is not directly above this one.
      const reach = (x: Iri) => above.get(x)?.size ?? 0;
      const covered = new Set<Iri>();
      direct = [];
      for (const up of [...ups].sort((x, y) => reach(y) - reach(x))) {
        if (covered.has(up)) continue;
        direct.push(up);
        for (const further of above.get(up) ?? []) covered.add(further);
      }
    }
    entries.get(iri)!.parents = direct;
    for (const up of direct) entries.get(up)!.children.push(iri);
  }

  // A link is stated where any class of the lower place is stated to be a subclass of any class of the upper one.
  const stated = new Set<string>();
  for (const l of input.subClassOf) {
    if (!classes.has(l.sub) || !classes.has(l.sup) || empty.has(l.sub) || empty.has(l.sup)) continue;
    stated.add(`${placeOf(l.sub)}\n${placeOf(l.sup)}`);
  }
  const entailedOnly = new Set<string>();
  for (const [iri, e] of entries) for (const up of e.parents) if (!stated.has(`${iri}\n${up}`)) entailedOnly.add(`${iri}\n${up}`);

  const top: Iri[] = [];
  for (const [iri, e] of entries) if (!e.parents.length) top.push(iri);
  if (empty.size) {
    const nothing = entry({ iri: OWL_NOTHING, label: 'owl:Nothing' });
    nothing.ref.builtin = true;
    nothing.size = 0;
    entries.set(OWL_NOTHING, nothing);
    for (const iri of empty) {
      const e = entry(classes.get(iri)!);
      e.unsatisfiable = true;
      e.parents = [OWL_NOTHING];
      entries.set(iri, e);
      nothing.children.push(iri);
      entailedOnly.add(`${iri}\n${OWL_NOTHING}`);
    }
  }
  const byLabel = sorter(entries);
  for (const e of entries.values()) e.children.sort(byLabel);
  top.sort(byLabel);
  // owl:Nothing is the bottom of the hierarchy. It is listed last, after everything that can have instances.
  if (empty.size) top.push(OWL_NOTHING);
  return { entries, top, cycles: [], alias, entailedOnly };
}

/** The groups of classes that are each other's superclasses: Tarjan's algorithm, with a stack of its own. */
function rings(entries: Map<Iri, Pick<Entry, 'parents' | 'children'>>): Iri[][] {
  const index = new Map<Iri, number>();
  const low = new Map<Iri, number>();
  const waiting: Iri[] = [];
  const isWaiting = new Set<Iri>();
  const out: Iri[][] = [];
  let counter = 0;
  const enter = (v: Iri) => {
    index.set(v, counter);
    low.set(v, counter++);
    waiting.push(v);
    isWaiting.add(v);
  };
  for (const [start, e] of entries) {
    // A class in a ring has both a superclass and a subclass.
    if (index.has(start) || !e.parents.length || !e.children.length) continue;
    enter(start);
    const work: { v: Iri; next: number }[] = [{ v: start, next: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const parents = entries.get(frame.v)!.parents;
      if (frame.next < parents.length) {
        const w = parents[frame.next++];
        if (!index.has(w)) {
          enter(w);
          work.push({ v: w, next: 0 });
        } else if (isWaiting.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const below = work[work.length - 1];
      if (below) low.set(below.v, Math.min(low.get(below.v)!, low.get(frame.v)!));
      if (low.get(frame.v) !== index.get(frame.v)) continue;
      const ring: Iri[] = [];
      for (;;) {
        const w = waiting.pop()!;
        isWaiting.delete(w);
        ring.push(w);
        if (w === frame.v) break;
      }
      if (ring.length > 1) out.push(ring);
    }
  }
  return out;
}

/** The place of a class: its own, or in the inferred hierarchy the one it shares. */
export const placeIn = (h: Hierarchy, iri: Iri): Iri => h.alias.get(iri) ?? iri;

export function entryOf(h: Hierarchy, iri: Iri): Entry {
  const e = h.entries.get(placeIn(h, iri));
  if (!e) throw new StructureError('not-found', `There is no class <${iri}> in this ontology.`);
  return e;
}

/** What a filter leaves of the hierarchy: the classes it finds, and with them the classes that lead down to one. */
export interface Narrowed {
  matches: Set<Iri>;
  kept: Set<Iri>;
}

export function narrow(h: Hierarchy, text: string): Narrowed {
  const q = text.trim().toLowerCase();
  const matches = new Set<Iri>();
  for (const [iri, e] of h.entries) if (!e.ref.builtin && e.text.includes(q)) matches.add(iri);
  const kept = new Set(matches);
  const todo = [...matches];
  while (todo.length) {
    for (const p of h.entries.get(todo.pop()!)!.parents) {
      if (kept.has(p)) continue;
      kept.add(p);
      todo.push(p);
    }
  }
  return { matches, kept };
}

/** A class as it is listed: under `parent`, when that is given, which says whether its place there is stated. */
export function nodeOf(h: Hierarchy, iri: Iri, narrowed?: Narrowed, parent?: Iri): HierarchyNode {
  const e = entryOf(h, iri);
  return {
    class: e.ref,
    equivalents: e.equivalents,
    childCount: narrowed ? e.children.filter((c) => narrowed.kept.has(c)).length : e.children.length,
    parentCount: e.parents.length,
    ...(e.inCycle ? { inCycle: true } : {}),
    ...(narrowed?.matches.has(e.ref.iri) ? { match: true } : {}),
    ...(parent !== undefined && h.entailedOnly.has(`${e.ref.iri}\n${parent}`) ? { entailedOnly: true } : {}),
    ...(e.unsatisfiable ? { unsatisfiable: true } : {}),
  };
}

/** How many steps upward a search for ways down may take before it gives what it has. */
const PATH_WORK = 50_000;

interface Step {
  iri: Iri;
  /** The step this one was taken from: the class directly below it on this way. */
  below: Step | null;
}

/**
 * The ways down the hierarchy to a class, each from a class at the top, shortest first. A way
 * never passes the same class twice, so a ring of classes is gone round at most once.
 */
export function pathsTo(h: Hierarchy, iri: Iri, limit: number): { paths: ClassRef[][]; truncated: boolean } {
  const start = entryOf(h, iri).ref.iri;
  const top = new Set(h.top);
  const passes = (step: Step, x: Iri) => {
    for (let s: Step | null = step; s; s = s.below) if (s.iri === x) return true;
    return false;
  };
  const paths: ClassRef[][] = [];
  let work = 0;
  let level: Step[] = [{ iri: start, below: null }];
  while (level.length) {
    const next: Step[] = [];
    for (const [n, step] of level.entries()) {
      if (top.has(step.iri)) {
        const path: ClassRef[] = [];
        for (let s: Step | null = step; s; s = s.below) path.push(h.entries.get(s.iri)!.ref);
        paths.push(path);
        if (paths.length >= limit) return { paths, truncated: n + 1 < level.length || next.length > 0 };
        continue;
      }
      for (const up of h.entries.get(step.iri)!.parents) {
        // Only a class in a ring can come round again.
        if (h.entries.get(up)!.inCycle && passes(step, up)) continue;
        if (++work > PATH_WORK) return { paths, truncated: true };
        next.push({ iri: up, below: step });
      }
    }
    level = next;
  }
  return { paths, truncated: false };
}

/**
 * How many levels each class is below owl:Thing, at the least and at the most. The classes of a
 * ring are on one level: none of them is further down than another.
 */
export function depthsOf(h: Hierarchy): Map<Iri, { min: number; max: number }> {
  if (h.depths) return h.depths;
  // Each ring taken as one: the first of its classes stands for it, and every other class for itself.
  const ring = new Map<Iri, Iri>();
  const members = new Map<Iri, Iri[]>();
  for (const cycle of h.cycles) {
    members.set(cycle[0], cycle);
    for (const iri of cycle) ring.set(iri, cycle[0]);
  }
  const plain = !h.cycles.length;
  const unit = plain ? (iri: Iri) => iri : (iri: Iri) => ring.get(iri) ?? iri;
  /** What is directly below a class or a ring, outside it. Without rings that is simply its subclasses. */
  const belowOf = plain ? (u: Iri) => h.entries.get(u)!.children : (u: Iri) => (members.get(u) ?? [u]).flatMap((iri) => h.entries.get(iri)!.children.map(unit)).filter((v) => v !== u);

  // The least: level by level from the top, each at the level it is first met on.
  const min = new Map<Iri, number>();
  let level: Iri[] = [];
  for (const iri of h.top) {
    if (min.has(unit(iri))) continue;
    min.set(unit(iri), 1);
    level.push(unit(iri));
  }
  for (let depth = 2; level.length; depth++) {
    const next: Iri[] = [];
    for (const u of level) {
      for (const v of belowOf(u)) {
        if (min.has(v)) continue;
        min.set(v, depth);
        next.push(v);
      }
    }
    level = next;
  }

  // The most: the longest way down, which is known once everything above has been gone through.
  const waits = new Map<Iri, number>();
  const max = new Map<Iri, number>();
  for (const [iri, e] of h.entries) {
    const u = unit(iri);
    waits.set(u, (waits.get(u) ?? 0) + (plain ? e.parents.length : e.parents.filter((p) => unit(p) !== u).length));
  }
  const ready: Iri[] = [];
  for (const [u, n] of waits) {
    if (n) continue;
    max.set(u, 1);
    ready.push(u);
  }
  while (ready.length) {
    const u = ready.pop()!;
    for (const v of belowOf(u)) {
      max.set(v, Math.max(max.get(v) ?? 0, max.get(u)! + 1));
      waits.set(v, waits.get(v)! - 1);
      if (!waits.get(v)) ready.push(v);
    }
  }
  const depths = new Map<Iri, { min: number; max: number }>();
  for (const iri of h.entries.keys()) depths.set(iri, { min: min.get(unit(iri)) ?? 1, max: max.get(unit(iri)) ?? 1 });
  h.depths = depths;
  return depths;
}

/** Every class above a class, by any way up. */
export function ancestorsOf(h: Hierarchy, iri: Iri): Iri[] {
  const start = entryOf(h, iri).ref.iri;
  const seen = new Set<Iri>([start]);
  const todo = [start];
  while (todo.length) {
    for (const p of h.entries.get(todo.pop()!)!.parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      todo.push(p);
    }
  }
  seen.delete(start);
  return [...seen];
}

/** How many named classes are below a class, by any way down, each counted once. */
export function descendantsOf(h: Hierarchy, iri: Iri): number {
  const start = entryOf(h, iri).ref.iri;
  const seen = new Set<Iri>([start]);
  const todo = [start];
  let count = 0;
  while (todo.length) {
    for (const c of h.entries.get(todo.pop()!)!.children) {
      if (seen.has(c)) continue;
      seen.add(c);
      count += h.entries.get(c)!.size;
      todo.push(c);
    }
  }
  return count;
}

/**
 * The shortest way from one class up to another through the links of a hierarchy: the classes
 * from the upper one down to the lower one. None, where the lower is not under the upper.
 */
export function chainBetween(h: Hierarchy, lower: Iri, upper: Iri): ClassRef[] | null {
  const from = entryOf(h, lower).ref.iri;
  const to = entryOf(h, upper).ref.iri;
  const reached = new Map<Iri, Iri | null>([[from, null]]);
  let level = [from];
  while (level.length && !reached.has(to)) {
    const next: Iri[] = [];
    for (const iri of level) {
      for (const p of h.entries.get(iri)!.parents) {
        if (reached.has(p)) continue;
        reached.set(p, iri);
        next.push(p);
      }
    }
    level = next;
  }
  if (from === to || !reached.has(to)) return null;
  const chain: ClassRef[] = [];
  for (let at: Iri | null = to; at !== null; at = reached.get(at) ?? null) chain.push(h.entries.get(at)!.ref);
  return chain;
}

/** The classes a text finds: by label first (the same, then starting with it, then holding it), then by anything else they are searched by. */
export function searchClasses(h: Hierarchy, text: string, limit: number): { matches: ClassRef[]; total: number } {
  const q = text.trim().toLowerCase();
  if (!q) return { matches: [], total: 0 };
  const found: { ref: ClassRef; score: number }[] = [];
  for (const e of h.entries.values()) {
    if (e.ref.builtin || !e.text.includes(q)) continue;
    const label = e.ref.label.toLowerCase();
    found.push({ ref: e.ref, score: label === q ? 0 : label.startsWith(q) ? 1 : label.includes(q) ? 2 : 3 });
  }
  found.sort((x, y) => x.score - y.score || x.ref.label.length - y.ref.label.length || byRef(x.ref, y.ref));
  return { matches: found.slice(0, limit).map((x) => x.ref), total: found.length };
}
