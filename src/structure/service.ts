import { analyzeHierarchy, branchMembers, type Analysis } from './analyze';
import { compareClasses } from './compare';
import {
  StructureError,
  type AnalysisOptions,
  type AnalysisQuery,
  type BranchesQuery,
  type CallOptions,
  type ClassAxiom,
  type ClassComparison,
  type ClassSearchQuery,
  type ClassSearchResult,
  type ClassSetItem,
  type ClassSetPage,
  type ClassSetQuery,
  type ClassSummary,
  type ComparisonQuery,
  type ExplanationQuery,
  type HierarchyMode,
  type HierarchyPage,
  type HierarchyPosition,
  type HierarchyQuery,
  type Iri,
  type OntologyRef,
  type PathQuery,
  type PathResult,
  type Provenance,
  type PropertyBranchesQuery,
  type PropertyHierarchyPage,
  type PropertyHierarchyQuery,
  type PropertyPathQuery,
  type PropertyPathResult,
  type PropertySummary,
  type PropertySummaryQuery,
  type StructureAnalysis,
  type StructureService,
  type SubclassExplanation,
  type SummaryQuery,
} from './contracts';
import { ancestorsOf, buildHierarchy, buildInferredHierarchy, byRef, chainBetween, depthsOf, descendantsOf, entryOf, narrow, nodeOf, pathsTo, searchClasses, type ClassGraphInput, type EntailedInput, type Hierarchy, type Narrowed } from './graph';
import { buildPropertyHierarchy, byPropRef, narrowProperties, propertyDescendantsOf, propertyEntryOf, propertyNodeOf, propertyPathsTo, type PropertyGraphInput, type PropertyHierarchy, type NarrowedProperties } from './propertyGraph';

/**
 * The Structure Explorer's questions, answered from the classes and subclass links of an
 * ontology held in memory. Whatever can give those (the model in the editor, today) gets every
 * answer from here; a service that asks a backend instead takes the place of all of this.
 */

/**
 * What a reasoner has to say about the classes. `entailed` is there only when its answer is of
 * the revision in hand (`provenance.status` is "current"); otherwise the provenance says why
 * there is none, and nothing is made up in its place.
 */
export interface InferredInput {
  provenance: Provenance;
  entailed?: EntailedInput;
  /**
   * The reasoner's own grounds for one class being a subclass of another: the asserted
   * statements it rests on, in words. Null where it has none to give, which is then said.
   */
  explain?: (sub: Iri, sup: Iri) => string[] | null;
}

/** The ontology as it is now: which revision, and its classes when they are wanted. */
export interface GraphSource extends OntologyRef {
  /**
   * The language the classes are named in (FR-M1-5), where the source can name them in more than
   * one. Not part of the revision: the same classes, in other words.
   */
  lang?: string;
  /** Asked for once for each revision and language; what it gives must not be changed afterwards. */
  graph(): ClassGraphInput;
  /**
   * The object and data properties, and the rdfs:subPropertyOf links stated between them. There
   * is no inferred property hierarchy: a reasoner does not draw one, so only what is stated is
   * known. Left out by a source without properties (a concept scheme, say).
   */
  properties?(): PropertyGraphInput;
  /**
   * What the reasoner in use entails, when the inferred hierarchy is asked for. The same object
   * for as long as nothing about it has changed: the hierarchy built from it is kept by it.
   * Left out by a source that has no reasoner.
   */
  inferred?(): InferredInput;
  /**
   * What is asserted of each of these classes beyond its named superclasses: its restrictions,
   * and the class expressions kept as they were written. Asked for a few classes at a time, the
   * ones a comparison is about. Left out by a source that has none to give.
   */
  axioms?(iris: Iri[]): ReadonlyMap<Iri, ClassAxiom[]>;
  /**
   * How many statements each class takes part in, of any kind: as a superclass or a subclass,
   * in a restriction, as the class of an individual. Left out by a source that does not know.
   */
  connections?(): ReadonlyMap<Iri, number>;
}

/** How many subclasses a page holds unless asked otherwise, and the most it ever holds. */
export const PAGE = 200;
export const MAX_PAGE = 1000;
/** How many classes one question may ask the subclasses of. */
export const MAX_BRANCHES = 500;
/** How many ways down to a class are given unless asked otherwise, and at most. */
const PATHS = 10;
const MAX_PATHS = 100;
/** How many classes a search gives unless asked otherwise, and at most. */
const FOUND = 12;
const MAX_FOUND = 200;

/** The hierarchies and narrowings kept for asking again: an edit makes a new revision, and undo goes back to the one before. */
const KEPT_REVISIONS = 3;
const KEPT_FILTERS = 8;

const clamp = (n: number | undefined, fallback: number, max: number) => (n === undefined || !Number.isFinite(n) ? fallback : Math.max(1, Math.min(max, Math.floor(n))));

/** Puts a value in a small cache, dropping the one that has gone unused the longest. */
function keep<K, V>(cache: Map<K, V>, key: K, value: V, size: number): V {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > size) cache.delete(cache.keys().next().value as K);
  return value;
}

/** What is asserted is read off as it stands: no reasoner has a part in it, and none of it is missing. */
const asserted = (revisionId: string): Provenance => ({ engine: null, revisionId, status: 'current', completeness: 'complete', notes: [] });

/** One hierarchy to answer from, or none, with where it comes from either way. */
interface Answering {
  hierarchy: Hierarchy | null;
  provenance: Provenance;
}

export function createGraphService(source: () => GraphSource): StructureService {
  const built = new Map<string, { input: ClassGraphInput; asserted: Hierarchy }>();
  // The property hierarchy of a revision and language, built once and kept like the classes' one.
  const builtProps = new Map<string, { input: PropertyGraphInput; hierarchy: PropertyHierarchy }>();
  // An inferred hierarchy belongs to the reasoner's answer it was built from, and goes when that does.
  const inferred = new WeakMap<InferredInput, Hierarchy>();
  const narrowings = new WeakMap<Hierarchy, Map<string, Narrowed>>();
  const narrowingsProps = new WeakMap<PropertyHierarchy, Map<string, NarrowedProperties>>();
  // A hierarchy is measured once. The unsatisfiable classes in it are the reasoner's, so it is measured again when the reasoner's answer is another.
  const analyses = new WeakMap<Hierarchy, { reasoned: Hierarchy | null; analysis: Analysis; sorted: Map<string, ClassSetItem[]> }>();

  /** The ontology the question is about, or the reason it cannot be answered. */
  const at = (query: OntologyRef, options?: CallOptions) => {
    if (options?.signal?.aborted) throw new StructureError('aborted', 'The question was given up.');
    const now = source();
    if (query.ontologyId !== now.ontologyId || query.revisionId !== now.revisionId) throw new StructureError('stale-revision', 'The ontology has changed since this was asked about.');
    // The same revision in another language is another set of labels, and another hierarchy to read them from.
    const key = `${now.ontologyId}\n${now.revisionId}\n${now.lang ?? ''}`;
    let revision = built.get(key);
    if (!revision) {
      const input = now.graph();
      revision = { input, asserted: buildHierarchy(input) };
    }
    return { now, revision: keep(built, key, revision, KEPT_REVISIONS) };
  };
  /** The inferred hierarchy of the ontology as it is, where the reasoner in use has a current answer. */
  const entailedBy = (now: GraphSource, input: ClassGraphInput): Answering => {
    if (!now.inferred) throw new StructureError('unsupported', 'There is no reasoner to ask for an inferred hierarchy.');
    const answer = now.inferred();
    if (answer.provenance.status !== 'current' || !answer.entailed) return { hierarchy: null, provenance: answer.provenance };
    let hierarchy = inferred.get(answer);
    if (!hierarchy) inferred.set(answer, (hierarchy = buildInferredHierarchy(input, answer.entailed)));
    return { hierarchy, provenance: answer.provenance };
  };
  /** The same for a question that is not about the inferred hierarchy as such: a source without a reasoner has nothing to add, and says so. */
  const reasoned = (now: GraphSource, input: ClassGraphInput, revisionId: string): Answering => (now.inferred ? entailedBy(now, input) : { hierarchy: null, provenance: { engine: null, revisionId, status: 'unavailable', completeness: 'incomplete', notes: [] } });
  const answering = (query: OntologyRef & { mode: HierarchyMode }, options?: CallOptions): Answering => {
    const { now, revision } = at(query, options);
    return query.mode === 'asserted' ? { hierarchy: revision.asserted, provenance: asserted(query.revisionId) } : entailedBy(now, revision.input);
  };
  const narrowed = (hierarchy: Hierarchy, filter: string | undefined) => {
    const text = filter?.trim().toLowerCase();
    if (!text) return undefined;
    const kept = narrowings.get(hierarchy) ?? narrowings.set(hierarchy, new Map()).get(hierarchy)!;
    return keep(kept, text, kept.get(text) ?? narrow(hierarchy, text), KEPT_FILTERS);
  };
  /** The ontology the question is about with its property hierarchy, or the reason it cannot be answered. */
  const atProps = (query: OntologyRef, options?: CallOptions) => {
    if (options?.signal?.aborted) throw new StructureError('aborted', 'The question was given up.');
    const now = source();
    if (query.ontologyId !== now.ontologyId || query.revisionId !== now.revisionId) throw new StructureError('stale-revision', 'The ontology has changed since this was asked about.');
    if (!now.properties) throw new StructureError('unsupported', 'There is no property hierarchy to read in this ontology.');
    // As with the classes: the same revision in another language is another hierarchy to read from.
    const key = `${now.ontologyId}\n${now.revisionId}\n${now.lang ?? ''}`;
    let revision = builtProps.get(key);
    if (!revision) {
      const input = now.properties();
      revision = { input, hierarchy: buildPropertyHierarchy(input) };
    }
    return { now, revision: keep(builtProps, key, revision, KEPT_REVISIONS) };
  };
  const propertiesNarrowed = (hierarchy: PropertyHierarchy, filter: string | undefined) => {
    const text = filter?.trim().toLowerCase();
    if (!text) return undefined;
    const kept = narrowingsProps.get(hierarchy) ?? narrowingsProps.set(hierarchy, new Map()).get(hierarchy)!;
    return keep(kept, text, kept.get(text) ?? narrowProperties(hierarchy, text), KEPT_FILTERS);
  };
  const ref = (q: OntologyRef) => ({ ontologyId: q.ontologyId, revisionId: q.revisionId });
  /** The hierarchy of a mode measured, from what was kept if it was measured before. None, where there is no such hierarchy. */
  const measured = async (query: AnalysisQuery, options?: AnalysisOptions) => {
    const { now, revision } = at(query, options);
    const entailed = reasoned(now, revision.input, query.revisionId);
    const provenance = query.mode === 'asserted' ? asserted(query.revisionId) : entailed.provenance;
    if (query.mode === 'inferred' && !now.inferred) throw new StructureError('unsupported', 'There is no reasoner to ask for an inferred hierarchy.');
    const hierarchy = query.mode === 'asserted' ? revision.asserted : entailed.hierarchy;
    if (!hierarchy) return { hierarchy, provenance, reasoning: entailed.provenance, kept: undefined };
    let kept = analyses.get(hierarchy);
    if (!kept || kept.reasoned !== entailed.hierarchy) {
      const analysis = await analyzeHierarchy({ hierarchy, asserted: revision.asserted, reasoned: entailed.hierarchy, connections: now.connections?.(), signal: options?.signal, onProgress: options?.onProgress });
      // Only a finished measuring is kept: one that was given up is started again when it is next asked for.
      analyses.set(hierarchy, (kept = { reasoned: entailed.hierarchy, analysis, sorted: new Map() }));
    } else options?.onProgress?.(1);
    return { hierarchy, provenance, reasoning: entailed.provenance, kept };
  };
  /** One page of the subclasses of a class, or of the classes at the top. */
  const pageOf = (query: OntologyRef & { mode: HierarchyMode }, { hierarchy, provenance }: Answering, asked: Pick<HierarchyQuery, 'parentIri' | 'limit' | 'cursor' | 'through' | 'filter'>): HierarchyPage => {
    const head = { ...ref(query), mode: query.mode, ...(asked.parentIri !== undefined ? { parentIri: asked.parentIri } : {}) };
    // No hierarchy to read from: nothing is listed, and the provenance says why.
    if (!hierarchy) return { ...head, nodes: [], offset: 0, total: 0, provenance };
    const parent = asked.parentIri === undefined ? undefined : entryOf(hierarchy, asked.parentIri);
    const all = parent ? parent.children : hierarchy.top;
    const found = narrowed(hierarchy, asked.filter);
    const list = found ? all.filter((iri) => found.kept.has(iri)) : all;
    const limit = clamp(asked.limit, PAGE, MAX_PAGE);
    // Where the page starts: where the one before ended, or at the page the wanted subclass is on, or at the beginning.
    const wanted = asked.cursor === undefined && asked.through !== undefined ? list.indexOf(hierarchy.alias.get(asked.through) ?? asked.through) : -1;
    const from = wanted < 0 ? offsetOf(asked.cursor) : Math.floor(wanted / limit) * limit;
    const to = from + limit;
    return {
      ...head,
      nodes: list.slice(from, to).map((iri: Iri) => nodeOf(hierarchy, iri, found, parent?.ref.iri)),
      offset: from,
      total: list.length,
      ...(to < list.length ? { nextCursor: `at:${to}` } : {}),
      ...(found ? { matched: found.matches.size } : {}),
      provenance,
    };
  };
  /** One page of the subproperties of a property, or of the properties at the top. */
  const propertyPageOf = (query: OntologyRef, hierarchy: PropertyHierarchy, asked: Pick<PropertyHierarchyQuery, 'parentIri' | 'limit' | 'cursor' | 'through' | 'filter'>): PropertyHierarchyPage => {
    const head = { ...ref(query), ...(asked.parentIri !== undefined ? { parentIri: asked.parentIri } : {}) };
    const parent = asked.parentIri === undefined ? undefined : propertyEntryOf(hierarchy, asked.parentIri);
    const all = parent ? parent.children : hierarchy.top;
    const found = propertiesNarrowed(hierarchy, asked.filter);
    const list = found ? all.filter((iri) => found.kept.has(iri)) : all;
    const limit = clamp(asked.limit, PAGE, MAX_PAGE);
    const wanted = asked.cursor === undefined && asked.through !== undefined ? list.indexOf(asked.through) : -1;
    const from = wanted < 0 ? offsetOf(asked.cursor) : Math.floor(wanted / limit) * limit;
    const to = from + limit;
    return {
      ...head,
      nodes: list.slice(from, to).map((iri: Iri) => propertyNodeOf(hierarchy, iri, found)),
      offset: from,
      total: list.length,
      ...(to < list.length ? { nextCursor: `at:${to}` } : {}),
      ...(found ? { matched: found.matches.size } : {}),
      provenance: asserted(query.revisionId),
    };
  };
  const positionOf = (hierarchy: Hierarchy, iri: Iri, mode: HierarchyMode, provenance: Provenance): HierarchyPosition => {
    const e = entryOf(hierarchy, iri);
    return { mode, superclasses: e.parents.length, subclasses: e.children.length, descendants: descendantsOf(hierarchy, iri), depth: depthsOf(hierarchy).get(e.ref.iri)!, ancestors: ancestorsOf(hierarchy, iri), inCycle: e.inCycle, provenance };
  };

  return {
    async children(query: HierarchyQuery, options?: CallOptions): Promise<HierarchyPage> {
      return pageOf(query, answering(query, options), query);
    },

    async branches(query: BranchesQuery, options?: CallOptions): Promise<HierarchyPage[]> {
      if (query.parents.length > MAX_BRANCHES) throw new StructureError('invalid', `No more than ${MAX_BRANCHES} classes can be asked about at once.`);
      const from = answering(query, options);
      return query.parents.map((parent) => pageOf(query, from, { ...parent, filter: query.filter }));
    },

    async paths(query: PathQuery, options?: CallOptions): Promise<PathResult> {
      const { hierarchy, provenance } = answering(query, options);
      const found = hierarchy ? pathsTo(hierarchy, query.classIri, clamp(query.limit, PATHS, MAX_PATHS)) : { paths: [], truncated: false };
      return { ...ref(query), mode: query.mode, ...found, provenance };
    },

    async summary(query: SummaryQuery, options?: CallOptions): Promise<ClassSummary> {
      const { now, revision } = at(query, options);
      const stated = entryOf(revision.asserted, query.classIri);
      const entailed = reasoned(now, revision.input, query.revisionId);
      const inferredPart: ClassSummary['inferred'] = { provenance: entailed.provenance };
      if (entailed.hierarchy) {
        const h = entailed.hierarchy;
        const e = entryOf(h, query.classIri);
        // The classes that share its place, other than itself.
        inferredPart.equivalents = [e.ref, ...e.equivalents].filter((c) => c.iri !== query.classIri && !e.unsatisfiable);
        inferredPart.unsatisfiable = e.unsatisfiable;
        inferredPart.superclasses = e.unsatisfiable ? [] : e.parents.map((up) => ({ class: h.entries.get(up)!.ref, stated: !h.entailedOnly.has(`${e.ref.iri}\n${up}`) })).sort((a, b) => byRef(a.class, b.class));
      }
      const hierarchy = query.mode === 'asserted' ? revision.asserted : entailed.hierarchy;
      return {
        ...ref(query),
        class: stated.ref,
        asserted: { superclasses: stated.parents.map((up) => revision.asserted.entries.get(up)!.ref).sort(byRef), anonymousSuperclasses: stated.anonymousSuperclasses, equivalents: stated.equivalents },
        inferred: inferredPart,
        ...(hierarchy ? { position: positionOf(hierarchy, query.classIri, query.mode, query.mode === 'asserted' ? asserted(query.revisionId) : entailed.provenance) } : {}),
      };
    },

    async search(query: ClassSearchQuery, options?: CallOptions): Promise<ClassSearchResult> {
      const { revision } = at(query, options);
      return { ...ref(query), ...searchClasses(revision.asserted, query.text, clamp(query.limit, FOUND, MAX_FOUND)) };
    },

    async compare(query: ComparisonQuery, options?: CallOptions): Promise<ClassComparison> {
      const { now, revision } = at(query, options);
      const entailed = reasoned(now, revision.input, query.revisionId);
      return compareClasses({ asserted: revision.asserted, inferred: entailed.hierarchy, reasoning: entailed.provenance, axioms: (iris) => now.axioms?.(iris) ?? new Map() }, ref(query), query.classAIri, query.classBIri);
    },

    async explain(query: ExplanationQuery, options?: CallOptions): Promise<SubclassExplanation> {
      const { now, revision } = at(query, options);
      const [sub, sup] = [entryOf(revision.asserted, query.subClassIri).ref, entryOf(revision.asserted, query.superClassIri).ref];
      const head = { ...ref(query), sub, sup };
      // Stated links that lead from the one to the other are their own explanation.
      const chain = chainBetween(revision.asserted, sub.iri, sup.iri);
      if (chain) {
        const statements = chain.slice(1).map((lower, i) => `${lower.label} SubClassOf ${chain[i].label}`).reverse();
        return { ...head, available: true, basis: chain.length === 2 ? 'asserted' : 'asserted-chain', statements, provenance: asserted(query.revisionId) };
      }
      const entailed = reasoned(now, revision.input, query.revisionId);
      const none = (reason: string): SubclassExplanation => ({ ...head, available: false, statements: [], reason, provenance: entailed.provenance });
      if (!entailed.hierarchy) return none('No reasoner’s answer is to be had for the ontology as it is, so nothing is known beyond what is stated, and that does not make the one a subclass of the other.');
      const place = entryOf(entailed.hierarchy, sub.iri);
      const up = entryOf(entailed.hierarchy, sup.iri).ref.iri;
      if (place.ref.iri !== up && !ancestorsOf(entailed.hierarchy, sub.iri).includes(up)) return none('It is not entailed: the reasoner does not find the one to be a subclass of the other.');
      // Only what the reasoner itself gives as its grounds is passed on. Where it gives none, none is made up.
      const grounds = now.inferred?.().explain?.(sub.iri, sup.iri);
      if (!grounds?.length) return none('The reasoner entails it and gives no justification for it here.');
      return { ...head, available: true, basis: 'entailed', statements: grounds, provenance: entailed.provenance };
    },

    async analyze(query: AnalysisQuery, options?: AnalysisOptions): Promise<StructureAnalysis> {
      const { provenance, reasoning, kept } = await measured(query, options);
      const head = { ...ref(query), mode: query.mode, provenance, reasoning };
      // No hierarchy to measure: every number is unknown, which is not the same as nought.
      if (!kept) {
        const unknown = { classes: null, top: null, leaves: null, maxDepth: null, averageDepth: null, multipleInheritance: null, noStatedSuperclass: null, equivalenceGroups: null, unsatisfiable: null, inCycles: null };
        return { ...head, metrics: unknown, sets: {}, depth: [], subclasses: [], superclasses: [], branches: { largest: [], others: null }, findings: [], deepest: [], warnings: [] };
      }
      return { ...head, ...kept.analysis.result };
    },

    async members(query: ClassSetQuery, options?: CallOptions): Promise<ClassSetPage> {
      const { hierarchy, kept } = await measured(query, options);
      const head = { ...ref(query), mode: query.mode, set: query.set };
      if (!hierarchy || !kept) return { ...head, items: [], offset: 0, total: 0 };
      let items = kept.sorted.get(query.set);
      if (!items) {
        // A branch is gone through when it is asked for; the other sets were made by the measuring.
        const found = query.set.startsWith('branch:') ? branchMembers(hierarchy, query.set.slice('branch:'.length)) : kept.analysis.sets.get(query.set);
        if (!found) throw new StructureError('not-found', 'There is no such set of classes in this analysis.');
        // The classes with the largest number first, where they have one; otherwise by label.
        items = [...found].sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || byRef(a.class, b.class));
        kept.sorted.set(query.set, items);
      }
      const limit = clamp(query.limit, PAGE, MAX_PAGE);
      const from = offsetOf(query.cursor);
      return { ...head, items: items.slice(from, from + limit), offset: from, total: items.length, ...(from + limit < items.length ? { nextCursor: `at:${from + limit}` } : {}) };
    },

    async propertyChildren(query: PropertyHierarchyQuery, options?: CallOptions): Promise<PropertyHierarchyPage> {
      return propertyPageOf(query, atProps(query, options).revision.hierarchy, query);
    },

    async propertyBranches(query: PropertyBranchesQuery, options?: CallOptions): Promise<PropertyHierarchyPage[]> {
      if (query.parents.length > MAX_BRANCHES) throw new StructureError('invalid', `No more than ${MAX_BRANCHES} properties can be asked about at once.`);
      const { hierarchy } = atProps(query, options).revision;
      return query.parents.map((parent) => propertyPageOf(query, hierarchy, { ...parent, filter: query.filter }));
    },

    async propertyPaths(query: PropertyPathQuery, options?: CallOptions): Promise<PropertyPathResult> {
      const { hierarchy } = atProps(query, options).revision;
      return { ...ref(query), ...propertyPathsTo(hierarchy, query.propertyIri, clamp(query.limit, PATHS, MAX_PATHS)), provenance: asserted(query.revisionId) };
    },

    async propertySummary(query: PropertySummaryQuery, options?: CallOptions): Promise<PropertySummary> {
      const { hierarchy } = atProps(query, options).revision;
      const e = propertyEntryOf(hierarchy, query.propertyIri);
      return {
        ...ref(query),
        property: e.ref,
        superproperties: e.parents.map((iri) => hierarchy.entries.get(iri)!.ref).sort(byPropRef),
        subpropertyCount: e.children.length,
        descendantCount: propertyDescendantsOf(hierarchy, query.propertyIri),
        inCycle: e.inCycle,
        provenance: asserted(query.revisionId),
      };
    },
  };
}

/** A cursor is this service's own business: where in the list the next page starts. */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const m = /^at:(\d+)$/.exec(cursor);
  if (!m) throw new StructureError('invalid', 'That is not a place in this list to go on from.');
  return Number(m[1]);
}
