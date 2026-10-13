import type { AxiomRelation, AxiomStanding, Basis, ClassAxiom, ClassComparison, ClassRef, ClassRelationship, ComparedAxiom, ComparedSuperclass, Disjointness, Iri, OntologyRef, Provenance } from './contracts';
import { ancestorsOf, byRef, chainBetween, entryOf, type Hierarchy } from './graph';

/**
 * Two classes side by side: how they stand to each other, and what is asserted of and inherited
 * by each. Only the two classes and what is above them are looked at; the rest of the ontology
 * is not gone through.
 *
 * Four things are kept apart, and each is said under its own name:
 *
 *   asserted    stated of the class itself.
 *   inherited   stated of a class above it (or equivalent to it), and so true of it. That it is
 *               above it is either read off the stated subclass links or taken from a reasoner,
 *               and which of the two is said.
 *   entailed    established by the reasoner whose answer is in hand, and by no stated chain.
 *   unverified  not checked, because no reasoner's answer is to be had. It is never passed off
 *               as holding, and never as not holding.
 *
 * That one restriction is stronger than another is said only on evidence: the two are on the
 * same property, the numbers allow it, and the filler of the one is known to be a subclass of
 * the filler of the other. Two restrictions that merely read alike are two restrictions.
 */

export interface CompareContext {
  asserted: Hierarchy;
  /** The inferred hierarchy, where the reasoner in use has a current answer. */
  inferred: Hierarchy | null;
  reasoning: Provenance;
  /** What is asserted of each of these classes beyond its named superclasses. Asked for the two classes and what is above them, and no others. */
  axioms: (iris: Iri[]) => ReadonlyMap<Iri, ClassAxiom[]>;
}

/** The classes above one class, with how each comes to be above it. */
interface Lineage {
  self: ClassRef;
  /** Above it by stated links: the ones stated outright, and the ones reached through them. */
  direct: Set<Iri>;
  chain: Set<Iri>;
  /** Above it, or equivalent to it, according to the reasoner. None without its answer, or for a class it finds unsatisfiable. */
  entailed: Set<Iri> | null;
  unsatisfiable: boolean;
}

export function compareClasses(ctx: CompareContext, ref: OntologyRef, aIri: Iri, bIri: Iri): ClassComparison {
  const { asserted, inferred } = ctx;
  const refOf = (iri: Iri): ClassRef => asserted.entries.get(iri)?.ref ?? { iri, label: iri };
  const lineages = new Map<Iri, Lineage>();
  const lineage = (iri: Iri): Lineage => {
    const hit = lineages.get(iri);
    if (hit) return hit;
    const e = entryOf(asserted, iri);
    let entailed: Set<Iri> | null = null;
    let unsatisfiable = false;
    if (inferred) {
      const place = entryOf(inferred, iri);
      unsatisfiable = place.unsatisfiable;
      // Everything is true of a class that can have no instance, so what is above it says nothing: only what is stated is read.
      if (!unsatisfiable) {
        entailed = new Set();
        for (const at of [place.ref.iri, ...ancestorsOf(inferred, iri)]) {
          const p = inferred.entries.get(at)!;
          if (p.ref.builtin) continue;
          entailed.add(p.ref.iri);
          for (const same of p.equivalents) entailed.add(same.iri);
        }
        entailed.delete(iri);
      }
    }
    const made: Lineage = { self: e.ref, direct: new Set(e.parents), chain: new Set(ancestorsOf(asserted, iri)), entailed, unsatisfiable };
    lineages.set(iri, made);
    return made;
  };
  /** How `lower` is known to be under `upper`, if it is. */
  const below = (lower: Iri, upper: Iri): Basis | null => {
    if (lower === upper || !asserted.entries.has(lower) || !asserted.entries.has(upper)) return null;
    const l = lineage(lower);
    return l.direct.has(upper) ? 'asserted' : l.chain.has(upper) ? 'asserted-chain' : l.entailed?.has(upper) ? 'entailed' : null;
  };

  const A = lineage(aIri);
  const B = lineage(bIri);
  const verified = ctx.reasoning.status === 'current' && !!inferred;

  // ---- how the two stand to each other
  const up = (l: Lineage) => new Set([...l.chain, ...(l.entailed ?? [])]);
  const [upA, upB] = [up(A), up(B)];
  const relationship = ((): ClassRelationship => {
    const none = { shared: [] as ClassRef[], verified };
    if (aIri === bIri) return { kind: 'same', ...none };
    const [ab, ba] = [below(aIri, bIri), below(bIri, aIri)];
    const statedSame = entryOf(asserted, aIri).equivalents.some((e) => e.iri === bIri);
    if (statedSame) return { kind: 'equivalent', basis: 'asserted', ...none };
    if (ab && ba) return { kind: 'equivalent', basis: ab === 'entailed' || ba === 'entailed' ? 'entailed' : 'asserted-chain', ...none };
    if (ab) return { kind: 'a-below-b', basis: ab, ...(ab === 'entailed' ? {} : { chain: chainBetween(asserted, aIri, bIri) ?? [] }), ...none };
    if (ba) return { kind: 'b-below-a', basis: ba, ...(ba === 'entailed' ? {} : { chain: chainBetween(asserted, bIri, aIri) ?? [] }), ...none };
    // Neither is under the other. What they have directly above them in common makes them siblings.
    const directOf = (l: Lineage, iri: Iri) => new Set([...l.direct, ...(inferred && l.entailed ? entryOf(inferred, iri).parents.flatMap((p) => [p, ...inferred.entries.get(p)!.equivalents.map((e) => e.iri)]) : [])]);
    const [directA, directB] = [directOf(A, aIri), directOf(B, bIri)];
    const parents = [...directA].filter((iri) => directB.has(iri) && asserted.entries.has(iri));
    if (parents.length) return { kind: 'siblings', shared: parents.map(refOf).sort(byRef), verified };
    // Otherwise the nearest classes above both: the common ones that are not above another common one.
    const common = [...upA].filter((iri) => upB.has(iri));
    const further = new Set<Iri>();
    for (const iri of common) for (const above of up(lineage(iri))) further.add(above);
    return { kind: 'unrelated', shared: common.filter((iri) => !further.has(iri)).map(refOf).sort(byRef), verified };
  })();

  // ---- whether they can share an instance at all
  const disjointness = ((): Disjointness | undefined => {
    if (aIri === bIri) return undefined;
    for (const x of [aIri, ...upA]) {
      for (const stated of asserted.entries.get(x)?.disjoints ?? []) {
        const y = stated.iri;
        if (y !== bIri && !upB.has(y)) continue;
        if (x === aIri && y === bIri) return { basis: 'asserted', between: { a: A.self, b: B.self } };
        return { basis: 'follows', between: { a: refOf(x), b: refOf(y) }, ...(x === aIri ? {} : { aBasis: below(aIri, x)! }), ...(y === bIri ? {} : { bBasis: below(bIri, y)! }) };
      }
    }
    return undefined;
  })();

  // ---- the classes above them
  const standing = (iri: Iri, one: Iri): Basis | 'self' | 'absent' => (iri === one ? 'self' : (below(one, iri) ?? 'absent'));
  const superclasses: ComparedSuperclass[] = [...new Set([...upA, ...upB])]
    .filter((iri) => asserted.entries.has(iri))
    .map((iri) => ({ class: refOf(iri), a: standing(iri, aIri), b: standing(iri, bIri) }))
    .sort((x, y) => Number(x.a === 'absent' || x.b === 'absent') - Number(y.a === 'absent' || y.b === 'absent') || Number(x.a === 'absent') - Number(y.a === 'absent') || byRef(x.class, y.class));

  // ---- what is asserted of each, and what each inherits
  // The nearest first: the stated superclasses, then what is reached through them, then what only the reasoner puts above it. Each by label.
  const inOrder = (iris: Iri[]) => iris.map(refOf).sort(byRef).map((c) => c.iri);
  const sources = (l: Lineage, iri: Iri): { iri: Iri; basis: Basis }[] => [
    ...inOrder([...l.direct]).map((x) => ({ iri: x, basis: 'asserted' as const })),
    ...inOrder([...l.chain].filter((x) => !l.direct.has(x) && x !== iri)).map((x) => ({ iri: x, basis: 'asserted-chain' as const })),
    ...inOrder([...(l.entailed ?? [])].filter((x) => !l.chain.has(x) && x !== iri)).map((x) => ({ iri: x, basis: 'entailed' as const })),
  ];
  const [fromA, fromB] = [sources(A, aIri), sources(B, bIri)];
  const stated = ctx.axioms([...new Set([aIri, bIri, ...fromA.map((x) => x.iri), ...fromB.map((x) => x.iri)])]);
  const rows = new Map<string, ComparedAxiom>();
  const row = (axiom: ClassAxiom) => rows.get(axiom.key) ?? rows.set(axiom.key, { axiom, a: { state: 'absent' }, b: { state: 'absent' }, relations: [], unverified: [] }).get(axiom.key)!;
  const place = (side: 'a' | 'b', iri: Iri, from: { iri: Iri; basis: Basis }[]) => {
    for (const axiom of stated.get(iri) ?? []) row(axiom)[side] = { state: 'own' };
    for (const source of from) {
      for (const axiom of stated.get(source.iri) ?? []) {
        const at: AxiomStanding = row(axiom)[side];
        if (at.state === 'own') continue;
        row(axiom)[side] = { state: 'inherited', from: [...(at.from ?? []), { class: refOf(source.iri), basis: source.basis }] };
      }
    }
  };
  place('a', aIri, fromA);
  if (bIri !== aIri) place('b', bIri, fromB);
  else for (const r of rows.values()) r.b = r.a;

  // ---- which of those axioms imply which, on evidence
  const byProperty = new Map<Iri, ComparedAxiom[]>();
  for (const r of rows.values()) if (r.axiom.kind === 'restriction') (byProperty.get(r.axiom.property.iri) ?? byProperty.set(r.axiom.property.iri, []).get(r.axiom.property.iri)!).push(r);
  for (const group of byProperty.values()) {
    for (const x of group) {
      for (const y of group) {
        if (x === y) continue;
        const forward = implies(x.axiom, y.axiom, below, refOf);
        if (forward === 'unknown') {
          // It would hold if the fillers were related. Without a reasoner's answer that is not known either way.
          if (!verified) x.unverified.push(y.axiom.key);
          continue;
        }
        if (!forward) continue;
        const back = implies(y.axiom, x.axiom, below, refOf);
        x.relations.push({ kind: back && back !== 'unknown' ? 'equivalent' : 'stronger', than: y.axiom.key, evidence: forward });
      }
    }
  }

  const axioms = [...rows.values()].sort((x, y) => rank(x) - rank(y) || x.axiom.text.localeCompare(y.axiom.text));
  const has = (s: AxiomStanding) => s.state !== 'absent';
  const count = (test: (r: ComparedAxiom) => boolean) => axioms.filter(test).length;
  const notes: string[] = [];
  if (axioms.some((r) => r.axiom.kind === 'expression')) notes.push('Class expressions kept as they were written (intersections, unions, nested restrictions, enumerations) are compared as text. What they mean is not worked out, so one is never said to be stronger than another.');
  if (byProperty.size > 1) notes.push('Restrictions are compared only where they are on the same property. A restriction on a sub-property is not set against one on the property above it.');
  if (axioms.some((r) => r.axiom.kind === 'restriction' && r.axiom.filler.kind === 'datatype')) notes.push('Datatypes are not compared with each other: restrictions on a data property are related only where they name the same datatype.');
  for (const l of [A, B]) if (l.unsatisfiable) notes.push(`“${l.self.label}” can never have an instance, according to the reasoner. Everything is true of such a class, so only what is stated of it and above it is shown as inherited.`);

  return {
    ...ref,
    a: A.self,
    b: B.self,
    relationship,
    ...(disjointness ? { disjointness } : {}),
    ...(inferred ? { unsatisfiable: { a: A.unsatisfiable, b: B.unsatisfiable } } : {}),
    superclasses,
    stated: { a: { equivalents: entryOf(asserted, aIri).equivalents, disjoints: entryOf(asserted, aIri).disjoints }, b: { equivalents: entryOf(asserted, bIri).equivalents, disjoints: entryOf(asserted, bIri).disjoints } },
    axioms,
    counts: {
      shared: count((r) => has(r.a) && has(r.b)),
      onlyA: count((r) => has(r.a) && !has(r.b)),
      onlyB: count((r) => !has(r.a) && has(r.b)),
      ownA: count((r) => r.a.state === 'own'),
      ownB: count((r) => r.b.state === 'own'),
      inheritedA: count((r) => r.a.state === 'inherited'),
      inheritedB: count((r) => r.b.state === 'inherited'),
    },
    reasoning: ctx.reasoning,
    notes,
  };
}

/** What both have first, then what only the first has, then what only the second has. */
const rank = (r: ComparedAxiom) => (r.a.state !== 'absent' && r.b.state !== 'absent' ? 0 : r.a.state !== 'absent' ? 1 : 2);

/** What a restriction asks for: at least so many, at most so many, or values of no other kind. */
function demands(axiom: Extract<ClassAxiom, { kind: 'restriction' }>): { atLeast?: number; atMost?: number; only?: boolean } {
  const n = axiom.n ?? 1;
  if (axiom.quantifier === 'some') return { atLeast: 1 };
  if (axiom.quantifier === 'min') return { atLeast: n };
  if (axiom.quantifier === 'max') return { atMost: n };
  if (axiom.quantifier === 'exactly') return { atLeast: n, atMost: n };
  return { only: true };
}

/**
 * Whether whatever meets `strong` meets `weak`: the evidence it rests on, false where the two
 * are not so related, and "unknown" where it would be so if one filler were a subclass of the
 * other and that is not known.
 *
 * At least n of D gives at least m of C when n ≥ m and D is under C. At most n of D gives at
 * most m of C when n ≤ m and C is under D: the wider class has fewer, so the narrower has too.
 * Only D gives only C when D is under C. A restriction that asks for two of these (exactly n)
 * has to be given both.
 */
function implies(strong: ClassAxiom, weak: ClassAxiom, below: (lower: Iri, upper: Iri) => Basis | null, refOf: (iri: Iri) => ClassRef): AxiomRelation['evidence'] | false | 'unknown' {
  if (strong.kind !== 'restriction' || weak.kind !== 'restriction' || strong.property.iri !== weak.property.iri) return false;
  const [has, wants] = [demands(strong), demands(weak)];
  const evidence: AxiomRelation['evidence'] = [];
  let unknown = false;
  /** Whether the filler of one is the filler of the other, or under it. */
  const under = (lower: typeof strong.filler, upper: typeof strong.filler) => {
    if (lower.kind !== upper.kind) return false;
    if (lower.iri === undefined || upper.iri === undefined) return lower.label === upper.label;
    if (lower.iri === upper.iri) return true;
    const basis = below(lower.iri, upper.iri);
    if (!basis) return (unknown = true), false;
    if (!evidence.some((e) => e.sub.iri === lower.iri && e.sup.iri === upper.iri)) evidence.push({ sub: refOf(lower.iri), sup: refOf(upper.iri), basis });
    return true;
  };
  // "At least none" asks nothing, and anything gives it.
  if (wants.atLeast !== undefined && wants.atLeast > 0 && !(has.atLeast !== undefined && has.atLeast >= wants.atLeast && under(strong.filler, weak.filler))) return unknown && has.atLeast !== undefined && has.atLeast >= wants.atLeast ? 'unknown' : false;
  if (wants.atMost !== undefined && !(has.atMost !== undefined && has.atMost <= wants.atMost && under(weak.filler, strong.filler))) return unknown && has.atMost !== undefined && has.atMost <= wants.atMost ? 'unknown' : false;
  if (wants.only && !(has.only && under(strong.filler, weak.filler))) return unknown && has.only ? 'unknown' : false;
  return evidence;
}
