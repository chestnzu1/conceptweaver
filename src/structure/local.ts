import { enumerationExpression, isEnumeration } from '../model/axioms';
import { configOf, supports } from '../model/modelTypes';
import { classText, namingFor } from '../model/manchester';
import { compactIri } from '../model/prefixes';
import { assertedSuperclasses, findProp, restrictionsOf } from '../model/props';
import { reason } from '../model/reasoner';
import type { EngineId, ReasoningResult } from '../model/reasoning';
import { stable } from '../model/stable';
import type { Model, Term } from '../model/types';
import { owlFindings, type ValidationRun } from '../model/validation';
import { resolveModel } from '../model/vocab';
import type { ClassAxiom, Iri, OntologyRef, ReasonerRef, StructureService } from './contracts';
import type { ClassGraphInput } from './graph';
import { createGraphService, type InferredInput } from './service';

/**
 * The Structure Explorer's source today: the model in the editor. This is the one place where
 * the explorer's services meet the app's own model, and the only file here that knows it. It
 * reads the model and never changes it.
 *
 * The model names its terms by an id of its own; everything the explorer is told names them by
 * IRI. What is read here is what is asserted: a class is under the named classes it is stated
 * to be a subclass of. An individual's class and a class's data properties are not part of the
 * hierarchy, and a superclass that is an anonymous class expression is not a class in it.
 */

/** What a class that has no IRI yet (one without a name) is known by here. It is never written anywhere. */
const UNNAMED = 'urn:conceptweaver:term:';

/** The annotations that are further labels of an entity. */
const LABELS = new Set(['rdfs:label', 'skos:prefLabel', 'skos:altLabel', 'skos:hiddenLabel']);

interface LocalIndex {
  iriOf: Map<string, Iri>;
  termOf: Map<Iri, string>;
  graph: ClassGraphInput;
  /** How many relationships of the model each class is at one end of. */
  connections: Map<Iri, number>;
}

const cache = new WeakMap<Model, LocalIndex>();

function indexOf(given: Model): LocalIndex {
  const model = stable(given);
  const hit = cache.get(model);
  if (hit) return hit;
  // In a concept scheme everything is a concept, whatever kind a term had in a model it came from.
  const every = configOf(model).termTypes.length < 2;
  const iriOf = new Map<string, Iri>();
  const termOf = new Map<Iri, string>();
  const graph: ClassGraphInput = { classes: [], subClassOf: [], equivalent: [], disjoint: [] };
  const listed: Term[] = [];
  for (const t of model.terms) {
    if (!every && t.type !== 'concept') continue;
    const iri = t.iri || UNNAMED + t.id;
    iriOf.set(t.id, iri);
    listed.push(t);
    // Two terms with one IRI are one entity in RDF, and one here: the first of them speaks for it.
    if (termOf.has(iri)) continue;
    termOf.set(iri, t.id);
    const curie = t.iri ? compactIri(model, t.iri) : undefined;
    const labels = [...t.synonyms.split(','), ...t.fields.filter((f) => LABELS.has(f.key)).map((f) => f.value)].map((s) => s.trim()).filter(Boolean);
    // Superclasses that are class expressions without a name are axioms of the class. They are counted, and are not classes here.
    const anonymous = t.classAxioms?.filter((a) => a.kind === 'SubClassOf' && a.expression.type !== 'Class').length ?? 0;
    graph.classes.push({ iri, label: t.name || 'Unnamed', search: curie ? [...labels, curie] : labels, ...(t.external !== undefined ? { external: true } : {}), ...(anonymous ? { anonymousSuperclasses: anonymous } : {}) });
  }
  for (const t of listed) {
    for (const up of assertedSuperclasses(model, t.id)) {
      const sup = iriOf.get(up);
      if (sup !== undefined) graph.subClassOf.push({ sub: iriOf.get(t.id)!, sup });
    }
  }
  // Stated equivalence and disjointness, read as the entity editor reads them: standard properties that are in force.
  for (const r of resolveModel(model).relations) {
    const [a, b] = [iriOf.get(r.from), iriOf.get(r.to)];
    if (a === undefined || b === undefined) continue;
    if (r.predicate === 'owl:equivalentClass') graph.equivalent.push({ a, b });
    else if (r.predicate === 'owl:disjointWith') graph.disjoint!.push({ a, b });
  }
  // Every line drawn to or from a class is a statement it takes part in: a superclass, a restriction, a class membership.
  const connections = new Map<Iri, number>();
  for (const r of model.relations) {
    for (const end of r.from === r.to ? [r.from] : [r.from, r.to]) {
      const iri = iriOf.get(end);
      if (iri !== undefined) connections.set(iri, (connections.get(iri) ?? 0) + 1);
    }
  }
  const out = { iriOf, termOf, graph, connections };
  cache.set(model, out);
  return out;
}

/** The IRI a class of the model is known by in the explorer, and the other way round. Neither is there for a term that is not a class. */
export const classIriOf = (model: Model, termId: string): Iri | undefined => indexOf(model).iriOf.get(termId);
export const termOfClass = (model: Model, iri: Iri): string | undefined => indexOf(model).termOf.get(iri);

/** What the model in the editor is called while it is not one of the saved models. */
export const WORKING_COPY = 'working-copy';

let made = 0;
const revisions = new WeakMap<Model, string>();

/**
 * Which revision a model is. Two models that differ only in where their terms sit on the canvas
 * are the same revision; any other change makes a new one, and going back to an earlier model
 * (by undo) is going back to its revision.
 */
export function revisionOf(model: Model): string {
  return revisionAt(stable(model));
}

/** The same for a model that is known to stand for its revision already, such as the one a reasoner was asked about. */
function revisionAt(m: Model): string {
  let id = revisions.get(m);
  if (!id) revisions.set(m, (id = `local-${++made}`));
  return id;
}

export const ontologyRef = (model: Model, docId: string | null): OntologyRef => ({ ontologyId: docId ?? WORKING_COPY, revisionId: revisionOf(model) });

// ---------------------------------------------------------------- what is asserted of a class

/** What a property that has no IRI yet is known by here. */
const UNNAMED_PROPERTY = 'urn:conceptweaver:property:';

/**
 * What is asserted of some classes beyond their named superclasses, for comparing them. A
 * restriction is the use of a property by the class: every member has some, only, or so many
 * values of it. That is not the property's domain, which says what anything having the property
 * is and is no statement about the class; domains are left out here. A class expression kept as
 * it was written, and the list of an enumeration, are given as text.
 */
function axiomsOf(given: Model, iris: Iri[]): Map<Iri, ClassAxiom[]> {
  const model = stable(given);
  const naming = namingFor(model);
  const index = indexOf(model);
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const out = new Map<Iri, ClassAxiom[]>();
  for (const iri of iris) {
    const term = byId.get(index.termOf.get(iri) ?? '');
    if (!term) continue;
    const axioms: ClassAxiom[] = [];
    for (const r of restrictionsOf(model, term.id)) {
      const to = byId.get(r.rel.to);
      const property = r.data ? { iri: to?.iri || UNNAMED + r.rel.to, label: r.property, type: 'data' as const } : { iri: (r.rel.prop !== undefined ? findProp(model, r.rel.prop)?.iri : undefined) || UNNAMED_PROPERTY + r.rel.prop, label: r.property, type: 'object' as const };
      const filler = r.data ? { label: r.filler, kind: 'datatype' as const } : { iri: index.iriOf.get(r.rel.to) ?? UNNAMED + r.rel.to, label: r.filler, kind: 'class' as const };
      // A restriction is the same restriction wherever it is asserted: by its property, how many, and of what.
      axioms.push({ kind: 'restriction', key: `r|${property.iri}|${r.quantifier}|${r.n ?? ''}|${filler.iri ?? filler.label}`, property, quantifier: r.quantifier, ...(r.n !== undefined ? { n: r.n } : {}), filler, text: r.text });
    }
    for (const axiom of term.classAxioms ?? []) {
      const relation = axiom.kind === 'EquivalentClasses' ? 'equivalentClass' : axiom.kind === 'SubClassOf' ? 'subClassOf' : 'disjointWith';
      // The same expression is the same axiom wherever it is stated: it is keyed by its structure, and shown in Manchester syntax.
      axioms.push({ kind: 'expression', key: `x|${relation}|${JSON.stringify(axiom.expression)}`, relation, text: classText(axiom.expression, naming) });
    }
    // An enumeration is defined as exactly its members. One that lists none yet says nothing.
    if (isEnumeration(term) && term.oneOf?.length) {
      const text = enumerationExpression(model, term);
      axioms.push({ kind: 'expression', key: `x|equivalentClass|${text}`, relation: 'equivalentClass', text });
    }
    out.set(iri, axioms);
  }
  return out;
}

// ---------------------------------------------------------------- what the reasoners entail

/**
 * The reasoner whose answer the explorer is to use, and the last answer the OWL 2 DL reasoner
 * gave. One reasoner is asked, the one that is chosen, and what it says is never topped up
 * with what the other one finds.
 */
export interface LocalReasoning {
  engine: EngineId;
  /** The last run of the validation workbench, which is where the OWL 2 DL reasoner's answer is kept. */
  run: Pick<ValidationRun, 'model' | 'dl'> | null;
}

const FAST: ReasonerRef = { id: 'fast', name: 'Fast reasoner (RDFS / partial OWL RL)' };
const FAST_LIMITS = 'It applies rules and is not a complete OWL 2 DL reasoner: what it finds holds, and there may be more that it does not find.';

/**
 * The app's own rule reasoner. It is asked about the model as it is, at once, so its answer is
 * always current; it is never complete. It gives every entailed superclass of each class, from
 * which the direct ones are worked out.
 */
function fastAnswer(model: Model, index: LocalIndex): InferredInput {
  const reasoning = reason(model);
  const notes = [FAST_LIMITS, ...(reasoning.truncated ? ['It stopped early, because the ontology gave it more facts than it keeps: some of what follows is missing.'] : [])];
  const provenance = { engine: FAST, revisionId: revisionOf(model), completeness: 'incomplete' as const, notes };
  // From a contradiction everything follows, so there is no hierarchy to speak of.
  if (!reasoning.consistent) return { provenance: { ...provenance, status: 'inconsistent' } };
  const subClassOf: { sub: Iri; sup: Iri }[] = [];
  const equivalent: Iri[][] = [];
  for (const [id, sub] of index.iriOf) {
    for (const link of reasoning.superclasses(id)) {
      const sup = index.iriOf.get(link.id);
      if (sup === undefined) continue;
      subClassOf.push({ sub, sup });
      if (link.equivalent) equivalent.push([sub, sup]);
    }
  }
  // The classes Validation lists as unsatisfiable for this reasoner: under two disjoint classes, or with restrictions that cannot hold together.
  const unsatisfiable = owlFindings(model).summary.unsatisfiable.map((id) => index.iriOf.get(id)).filter((iri): iri is Iri => iri !== undefined);
  return {
    provenance: { ...provenance, status: 'current' },
    entailed: { subClassOf, links: 'all', equivalent, unsatisfiable },
    // Its grounds for a subclass link are the stated facts it derived it from, in its own words.
    explain: (sub, sup) => {
      const [from, to] = [index.termOf.get(sub), index.termOf.get(sup)];
      const link = from === undefined ? undefined : reasoning.superclasses(from).find((l) => l.id === to);
      return link ? link.because.replace(/\.$/, '').split('; ') : null;
    },
  };
}

/**
 * The OWL 2 DL reasoner, by its last answer. That answer is of the ontology it was asked about:
 * once the ontology has changed it is stale and nothing is taken from it. Where it gave none,
 * that is said, and the other reasoner's is not put in its place.
 */
function dlAnswer(model: Model, index: LocalIndex, run: LocalReasoning['run']): InferredInput {
  const result: ReasoningResult | undefined = run?.dl?.result;
  const engine: ReasonerRef = { id: 'dl', name: result?.engine.name ?? 'HermiT', ...(result?.engine.version ? { version: result.engine.version } : {}) };
  const none = (status: 'unavailable' | 'stale' | 'failed' | 'inconsistent', revisionId: string, notes: string[]): InferredInput => ({ provenance: { engine, revisionId, status, completeness: 'incomplete', notes } });
  if (!run || !result) return none('unavailable', revisionOf(model), ['The OWL 2 DL reasoner has not been asked about this ontology.']);
  if (run.model !== stable(model)) return none('stale', revisionAt(run.model), ['Its answer is of the ontology as it was before it was last changed.']);
  if (result.status === 'failed' || result.consistency === 'unknown') return none('failed', revisionOf(model), result.errors);
  if (result.consistency === 'inconsistent') return none('inconsistent', revisionOf(model), []);
  const iri = (id: string) => index.iriOf.get(id);
  const subClassOf: { sub: Iri; sup: Iri }[] = [];
  for (const link of result.subclasses) {
    const [sub, sup] = [iri(link.subclass), iri(link.superclass)];
    if (link.direct && sub !== undefined && sup !== undefined) subClassOf.push({ sub, sup });
  }
  const iris = (ids: string[]) => ids.map(iri).filter((x): x is Iri => x !== undefined);
  return {
    provenance: { engine, revisionId: revisionOf(model), status: 'current', completeness: result.status === 'complete' ? 'complete' : 'incomplete', notes: result.warnings },
    entailed: { subClassOf, links: 'direct', equivalent: result.equivalentClasses.map(iris), unsatisfiable: iris(result.unsatisfiableClasses) },
  };
}

const answers = new WeakMap<Model, { engine: EngineId; run: LocalReasoning['run']; answer: InferredInput }>();

/** What the chosen reasoner entails of the model as it is: the same object until the model, the choice or the answer changes. */
function inferredOf(given: Model, reasoning: LocalReasoning): InferredInput {
  const model = stable(given);
  const hit = answers.get(model);
  // The fast reasoner's answer follows from the model alone; the other one's is whatever it last said.
  if (hit && hit.engine === reasoning.engine && (reasoning.engine === 'fast' || hit.run === reasoning.run)) return hit.answer;
  const answer = reasoning.engine === 'fast' ? fastAnswer(model, indexOf(model)) : dlAnswer(model, indexOf(model), reasoning.run);
  answers.set(model, { engine: reasoning.engine, run: reasoning.run, answer });
  return answer;
}

/**
 * A structure service that answers from the model `current` gives: whichever one is in the
 * editor when it is asked. With `reasoning`, and for a type of model that is reasoned over, it
 * has an inferred hierarchy as well.
 */
export function createLocalStructureService(current: () => { model: Model; docId: string | null; reasoning?: LocalReasoning }): StructureService {
  return createGraphService(() => {
    const { model, docId, reasoning } = current();
    return { ...ontologyRef(model, docId), graph: () => indexOf(model).graph, axioms: (iris) => axiomsOf(model, iris), connections: () => indexOf(model).connections, ...(reasoning && supports(model, 'reasoning') ? { inferred: () => inferredOf(model, reasoning) } : {}) };
  });
}
