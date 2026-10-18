import { StructureError, type Iri, type PropertyHierarchyNode, type PropertyRef } from './contracts';

/**
 * The hierarchy of object and data properties, and the questions asked of it. It is built the
 * way the class hierarchy is (graph.ts) and with the same care: nothing here knows where the
 * properties come from, every walk is iterative so that a deep hierarchy cannot exhaust the
 * stack, and a ring of properties that are each other's superproperties is allowed for.
 *
 * There is one hierarchy here, the stated one. No reasoner draws a property hierarchy, so none
 * is made up: what is not stated with rdfs:subPropertyOf is not in it.
 */

/** A property as the hierarchy is built from it. */
export interface PropertyInput {
  ref: PropertyRef;
  /** Other text a search should find it by: its other labels, its IRI written with a prefix. */
  search?: string[];
}

/** What a hierarchy is built from. Links naming a property that is not listed are left out. */
export interface PropertyGraphInput {
  properties: PropertyInput[];
  /** rdfs:subPropertyOf links between named properties, from the subproperty to the superproperty. */
  subPropertyOf: { sub: Iri; sup: Iri }[];
}

interface PEntry {
  ref: PropertyRef;
  /** Everything a search looks through, in lower case. */
  text: string;
  parents: Iri[];
  /** In order of label. */
  children: Iri[];
  inCycle: boolean;
}

export interface PropertyHierarchy {
  entries: Map<Iri, PEntry>;
  /** The properties at the top, in order of label. */
  top: Iri[];
  /** The groups of properties that are each other's superproperties. */
  cycles: Iri[][];
}

const collator = new Intl.Collator();
const textOf = (p: PropertyInput): string => [p.ref.label, p.ref.iri, ...(p.search ?? [])].join('\n').toLowerCase();
const entry = (p: PropertyInput): PEntry => ({ ref: p.ref, text: textOf(p), parents: [], children: [], inCycle: false });
const sorter = (entries: Map<Iri, PEntry>) => (x: Iri, y: Iri) => collator.compare(entries.get(x)!.ref.label, entries.get(y)!.ref.label) || (x < y ? -1 : x > y ? 1 : 0);

/** In order of label, and of IRI where two have the same label. */
export const byPropRef = (a: PropertyRef, b: PropertyRef) => collator.compare(a.label, b.label) || (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0);

export function buildPropertyHierarchy(input: PropertyGraphInput): PropertyHierarchy {
  const entries = new Map<Iri, PEntry>();
  // An IRI is one property, however often it is listed.
  for (const p of input.properties) if (!entries.has(p.ref.iri)) entries.set(p.ref.iri, entry(p));
  for (const { sub, sup } of input.subPropertyOf) {
    const a = entries.get(sub);
    const b = entries.get(sup);
    // A property is not listed under itself, and a link stated twice is one link.
    if (!a || !b || sub === sup || a.parents.includes(sup)) continue;
    a.parents.push(sup);
    b.children.push(sub);
  }
  const byLabel = sorter(entries);
  for (const e of entries.values()) e.children.sort(byLabel);

  const cycles = rings(entries);
  const top: Iri[] = [];
  for (const [iri, e] of entries) if (!e.parents.length) top.push(iri);
  for (const ring of cycles) {
    const inside = new Set(ring);
    for (const iri of ring) entries.get(iri)!.inCycle = true;
    // Properties that are only each other's superproperties have nothing above them to be
    // reached from. One of them is listed at the top, so that every property is somewhere.
    if (ring.every((iri) => entries.get(iri)!.parents.every((p) => inside.has(p)))) top.push([...ring].sort(byLabel)[0]);
  }
  top.sort(byLabel);
  return { entries, top, cycles };
}

/** The groups of properties that are each other's superproperties: Tarjan's algorithm, with a stack of its own. */
function rings(entries: Map<Iri, Pick<PEntry, 'parents' | 'children'>>): Iri[][] {
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
    // A property in a ring has both a superproperty and a subproperty.
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

export function propertyEntryOf(h: PropertyHierarchy, iri: Iri): PEntry {
  const e = h.entries.get(iri);
  if (!e) throw new StructureError('not-found', `There is no property <${iri}> in this ontology.`);
  return e;
}

/** What a filter leaves of the hierarchy: the properties it finds, and with them the properties that lead down to one. */
export interface NarrowedProperties {
  matches: Set<Iri>;
  kept: Set<Iri>;
}

export function narrowProperties(h: PropertyHierarchy, text: string): NarrowedProperties {
  const q = text.trim().toLowerCase();
  const matches = new Set<Iri>();
  for (const [iri, e] of h.entries) if (e.text.includes(q)) matches.add(iri);
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

/** A property as it is listed. */
export function propertyNodeOf(h: PropertyHierarchy, iri: Iri, narrowed?: NarrowedProperties): PropertyHierarchyNode {
  const e = propertyEntryOf(h, iri);
  return {
    property: e.ref,
    childCount: narrowed ? e.children.filter((c) => narrowed.kept.has(c)).length : e.children.length,
    parentCount: e.parents.length,
    ...(e.inCycle ? { inCycle: true } : {}),
    ...(narrowed?.matches.has(e.ref.iri) ? { match: true } : {}),
  };
}

/** How many steps upward a search for ways down may take before it gives what it has. */
const PATH_WORK = 50_000;

interface Step {
  iri: Iri;
  /** The step this one was taken from: the property directly below it on this way. */
  below: Step | null;
}

/**
 * The ways down the hierarchy to a property, each from one at the top, shortest first. A way
 * never passes the same property twice, so a ring is gone round at most once.
 */
export function propertyPathsTo(h: PropertyHierarchy, iri: Iri, limit: number): { paths: PropertyRef[][]; truncated: boolean } {
  const start = propertyEntryOf(h, iri).ref.iri;
  const top = new Set(h.top);
  const passes = (step: Step, x: Iri) => {
    for (let s: Step | null = step; s; s = s.below) if (s.iri === x) return true;
    return false;
  };
  const paths: PropertyRef[][] = [];
  let work = 0;
  let level: Step[] = [{ iri: start, below: null }];
  while (level.length) {
    const next: Step[] = [];
    for (const [n, step] of level.entries()) {
      if (top.has(step.iri)) {
        const path: PropertyRef[] = [];
        for (let s: Step | null = step; s; s = s.below) path.push(h.entries.get(s.iri)!.ref);
        paths.push(path);
        if (paths.length >= limit) return { paths, truncated: n + 1 < level.length || next.length > 0 };
        continue;
      }
      for (const up of h.entries.get(step.iri)!.parents) {
        // Only a property in a ring can come round again.
        if (h.entries.get(up)!.inCycle && passes(step, up)) continue;
        if (++work > PATH_WORK) return { paths, truncated: true };
        next.push({ iri: up, below: step });
      }
    }
    level = next;
  }
  return { paths, truncated: false };
}

/** How many properties are below a property, by any way down, each counted once. */
export function propertyDescendantsOf(h: PropertyHierarchy, iri: Iri): number {
  const start = propertyEntryOf(h, iri).ref.iri;
  const seen = new Set<Iri>([start]);
  const todo = [start];
  let count = 0;
  while (todo.length) {
    for (const c of h.entries.get(todo.pop()!)!.children) {
      if (seen.has(c)) continue;
      seen.add(c);
      count++;
      todo.push(c);
    }
  }
  return count;
}
