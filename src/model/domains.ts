import { classesOfUnion, keyOfRange, rangeOfKey, without, type ClassAxiom, type ClassExpression, type ClassExpressionAxiom, type DataRange, type DataRangeAxiom } from './expressions';
import { uid, type Model, type Term } from './types';

/**
 * Domains and ranges as the model holds them (model format 3): a list of axioms, each one
 * rdfs:domain or rdfs:range statement, all of which hold at once. These are the edits made to
 * them, and the ways of reading them that the rest of the app needs, apart from any component.
 */

export const classAxiom = (expression: ClassExpression): ClassAxiom => ({ id: uid(), expression });
export const rangeAxiom = (range: DataRange): DataRangeAxiom => ({ id: uid(), range });

const byIri = new WeakMap<Model['terms'], Map<string, Term>>();
/** The term an IRI names, if the model has one. */
export function termOfIri(model: Pick<Model, 'terms'>, iri: string): Term | undefined {
  let map = byIri.get(model.terms);
  if (!map) {
    map = new Map();
    for (const t of model.terms) if (t.iri && !map.has(t.iri)) map.set(t.iri, t);
    byIri.set(model.terms, map);
  }
  return map.get(iri);
}

/**
 * The named classes a domain or range is "any of", where it is that and nothing more: no axiom
 * (none), or one that is a class or a union of classes. That much can be edited as a list of
 * classes. Undefined for anything else: two axioms, or one that is another kind of expression.
 */
export function unionClasses(axioms: ClassAxiom[]): string[] | undefined {
  if (!axioms.length) return [];
  return axioms.length === 1 ? classesOfUnion(axioms[0].expression) : undefined;
}

/** The axioms that say "any of these classes": one axiom (keeping its id), or none for no class. */
export function withUnionClasses(axioms: ClassAxiom[], iris: string[]): ClassAxiom[] {
  const list = [...new Set(iris)];
  if (!list.length) return [];
  const expression: ClassExpression = list.length === 1 ? { type: 'Class', iri: list[0] } : { type: 'ObjectUnionOf', operands: list.map((iri) => ({ type: 'Class', iri })) };
  return [{ id: axioms.length === 1 ? axioms[0].id : uid(), expression }];
}

/**
 * The axioms without what names any of the entities (by IRI) or enumerated datatypes (by id)
 * that are deleted: see `without` for what goes. The same list when none of them is named.
 */
export function prunedAxioms(axioms: ClassAxiom[], iris: Set<string>, enums?: Set<string>): ClassAxiom[];
export function prunedAxioms(axioms: DataRangeAxiom[], iris: Set<string>, enums?: Set<string>): DataRangeAxiom[];
export function prunedAxioms(axioms: (ClassAxiom | DataRangeAxiom)[], iris: Set<string>, enums = new Set<string>()): (ClassAxiom | DataRangeAxiom)[] {
  let changed = false;
  const out: (ClassAxiom | DataRangeAxiom)[] = [];
  for (const a of axioms) {
    if ('expression' in a) {
      const e = without(a.expression, iris, enums);
      if (e !== a.expression) changed = true;
      if (e) out.push(e === a.expression ? a : { ...a, expression: e });
    } else {
      const r = without(a.range, iris, enums);
      if (r !== a.range) changed = true;
      if (r) out.push(r === a.range ? a : { ...a, range: r });
    }
  }
  return changed ? out : axioms;
}

/**
 * A data property's datatype: the one range axiom that is a datatype (a standard one, or an
 * enumerated datatype of the model), by the name it is chosen by ("xsd:date", "enum:" and an id).
 * Undefined where there is none, or more than one. Other axioms (a datatype narrowed by facets,
 * a union) may hold beside it: they are listed with the range, and checked where they can be.
 */
export function propDatatype(t: Pick<Term, 'ranges'>): string | undefined {
  const all = propDatatypes(t);
  return all.length === 1 ? all[0] : undefined;
}

/** Every datatype the range axioms name on their own (by the name each is chosen by): each holds for every value. */
export const propDatatypes = (t: Pick<Term, 'ranges'>): string[] => (t.ranges ?? []).map((a) => (a.range.type === 'Datatype' || a.range.type === 'Enumeration' ? keyOfRange(a.range) : undefined)).filter((k): k is string => !!k);

/** The datatype axiom a range's datatype is chosen in: the first that names one on its own (see withDatatype). */
export const datatypeAxiom = (t: Pick<Term, 'ranges'>): DataRangeAxiom | undefined => t.ranges?.find((a) => a.range.type === 'Datatype' || a.range.type === 'Enumeration');

/**
 * The range with its datatype set (by the name it is chosen by) or, for none, taken away: the
 * datatype axiom is replaced, keeping its id, and every other axiom stays as it is.
 */
export function withDatatype(t: Pick<Term, 'ranges'>, key: string | undefined): DataRangeAxiom[] | undefined {
  const all = t.ranges ?? [];
  const at = all.findIndex((a) => a.range.type === 'Datatype' || a.range.type === 'Enumeration');
  const range = key ? rangeOfKey(key) : undefined;
  const out = [...all];
  if (at >= 0 && range) out[at] = { ...all[at], range };
  else if (at >= 0) out.splice(at, 1);
  else if (range) out.push(rangeAxiom(range));
  return out.length ? out : undefined;
}

/**
 * The model without what its domains and ranges say of entities that are deleted (by IRI) and
 * of enumerated datatypes that are (by id): see `prunedAxioms`. The same model when none is named.
 * Axioms that name a deleted entity by id go too: a property chain with a step gone, a key one of
 * whose properties is gone, a negative assertion of an entity or property gone, and an annotation
 * on an axiom whose statement is about one gone.
 */
export function withoutEntities(m: Model, iris: Set<string>, enums: Set<string> = new Set()): Model {
  if (!iris.size && !enums.size) return m;
  const propIds = new Set(m.props.map((p) => p.id));
  const termIds = new Set(m.terms.map((t) => t.id));
  /** The list without what `prune` takes away: the list itself when it takes nothing. */
  const prunedList = <T>(list: T[] | undefined, prune: (x: T) => T | undefined): T[] | undefined => {
    if (!list) return undefined;
    const out = list.map(prune).filter((x): x is T => x !== undefined);
    return out.length === list.length && out.every((x, i) => x === list[i]) ? list : out;
  };
  let termsChanged = false;
  let propsChanged = false;
  let annotationsChanged = false;
  const terms = m.terms.map((t) => {
    if (!t.domains && !t.ranges && !t.classAxioms && !t.keys && !t.disjointUnions && !t.negativeAssertions) return t;
    const domains = t.domains && prunedAxioms(t.domains, iris, enums);
    const ranges = t.ranges && prunedAxioms(t.ranges, iris, enums);
    const stated = t.classAxioms && (prunedAxioms(t.classAxioms, iris, enums) as ClassExpressionAxiom[]);
    const keys = prunedList(t.keys, (k) => (k.properties.every((x) => ('prop' in x ? propIds.has(x.prop) : termIds.has(x.data))) ? k : undefined));
    const unions = prunedList(t.disjointUnions, (u) => {
      const classes = u.classes.map((c) => without(c, iris, enums)).filter((c): c is ClassExpression => c !== undefined);
      // A disjoint union of fewer than two classes says nothing.
      if (classes.length < 2) return undefined;
      return classes.every((c, i) => c === u.classes[i]) ? u : { ...u, classes };
    });
    const negatives = prunedList(t.negativeAssertions, (n) => ((n.kind === 'object' ? propIds.has(n.prop) && termIds.has(n.target) : termIds.has(n.prop)) ? n : undefined));
    if (domains === t.domains && ranges === t.ranges && stated === t.classAxioms && keys === t.keys && unions === t.disjointUnions && negatives === t.negativeAssertions) return t;
    termsChanged = true;
    const { ranges: _was, classAxioms: _had, keys: _keys, disjointUnions: _unions, negativeAssertions: _negatives, ...rest } = t;
    return {
      ...rest,
      ...(domains ? { domains } : {}),
      ...(ranges?.length ? { ranges } : {}),
      ...(stated?.length ? { classAxioms: stated } : {}),
      ...(keys?.length ? { keys } : {}),
      ...(unions?.length ? { disjointUnions: unions } : {}),
      ...(negatives?.length ? { negativeAssertions: negatives } : {}),
    };
  });
  const props = m.props.map((p) => {
    if (!p.domains && !p.ranges && !p.chains) return p;
    const domains = p.domains && prunedAxioms(p.domains, iris, enums);
    const ranges = p.ranges && prunedAxioms(p.ranges, iris, enums);
    // A chain missing a step is no chain.
    const chains = prunedList(p.chains, (c) => (c.properties.every((s) => propIds.has(s.prop)) ? c : undefined));
    if (domains === p.domains && ranges === p.ranges && chains === p.chains) return p;
    propsChanged = true;
    const { domains: _wasDomains, ranges: _wereRanges, chains: _wereChains, ...rest } = p;
    return { ...rest, ...(domains ? { domains } : {}), ...(ranges ? { ranges } : {}), ...(chains?.length ? { chains } : {}) };
  });
  // An annotation on a statement about an entity that is gone goes with it, as the statement would.
  const mentions = (text: string) => [...iris].some((iri) => text.includes(`<${iri}>`));
  const annotations = m.axiomAnnotations?.filter((a) => !iris.has(a.subject) && !iris.has(a.property) && !mentions(a.target) && !a.fields.some((f) => f.iri && iris.has(f.value)));
  if (annotations && annotations.length !== m.axiomAnnotations!.length) annotationsChanged = true;
  if (!termsChanged && !propsChanged && !annotationsChanged) return m;
  const out: Model = { ...m, ...(termsChanged ? { terms } : {}), ...(propsChanged ? { props } : {}) };
  if (annotationsChanged) {
    if (annotations?.length) out.axiomAnnotations = annotations;
    else delete out.axiomAnnotations;
  }
  return out;
}
