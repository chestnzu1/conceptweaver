import { addFact, addIsA, addLink, addPropLink, addValue, makeInstanceOf, type Edit, type LinkKind } from '../model/axioms';
import { termOfIri } from '../model/domains';
import type { ClassAxiom, ClassExpressionAxiom, DataRangeAxiom } from '../model/expressions';
import type { PropLink } from '../model/types';
import { fromTurtle, toTurtle } from '../model/rdf';
import { stable } from '../model/stable';
import { newRelation, type EnumDatatype, type ExternalRef, type Model, type ObjProp, type Relation, type Term } from '../model/types';
import { statementsOf, type Statement } from '../model/unmapped';
import { revisionOf } from '../structure/local';
import { axiomOf, brief, kindsOf, statementOf, type Kinds } from './axioms';
import { EditError, type Axiom, type AxiomChange, type CallOptions, type ChangeSet, type OntologyEditService, type Refusal } from './contracts';

/**
 * The edit service over the model in the editor.
 *
 * Every edit of the document is a change set. One made in the editor is applied as what it is to
 * the model: the parts of the model it replaced, and what they were before (a `Step`), so that it
 * is applied at once and exactly, and undo applies it backwards. What it is as axioms is worked
 * out when that is asked for (`changesBetween`), at the boundary of the document, not on every
 * keystroke: for a large model that costs as much as an export.
 *
 * A change set made anywhere else is applied through the contract (`createLocalEditService`):
 * against the revision it names, held to the editor's rules (the rule functions of
 * src/model/axioms.ts), and applied to the ontology's statements, which are then read back into
 * a model, with everything that is not a statement (where terms sit, how they are drawn, the
 * ids that the drawing and the shapes refer to) carried over from the model it was applied to.
 * It is applied only if the model read back states exactly what was asked for; it is then one
 * step of the history like any other.
 */

// ---------------------------------------------------------------- the ontology of a model

interface Ontology {
  statements: Statement[];
  texts: Set<string>;
  kinds: Kinds;
  /** The prefixes it is written with, which a statement read back is read with too. */
  prefixes: string;
}

const ontologies = new WeakMap<Model, Ontology>();

/** What a model states, statement by statement: worked out once for each revision. */
export function ontologyOf(model: Model): Ontology {
  const m = stable(model);
  let o = ontologies.get(m);
  if (!o) {
    const turtle = toTurtle(m);
    const statements = statementsOf(turtle);
    const prefixes = turtle
      .split('\n')
      .filter((l) => l.startsWith('@prefix '))
      .join('\n');
    o = { statements, texts: new Set(statements.map((s) => s.text)), kinds: kindsOf(statements), prefixes };
    ontologies.set(m, o);
  }
  return o;
}

/** The axioms one model states and another does not: those of the first removed, those of the second added. */
export function changesBetween(before: Model, after: Model): AxiomChange[] {
  const a = ontologyOf(before);
  const b = ontologyOf(after);
  if (a === b) return [];
  return [
    ...a.statements.filter((s) => !b.texts.has(s.text)).map((s): AxiomChange => ({ op: 'remove', axiom: axiomOf(s, a.kinds) })),
    ...b.statements.filter((s) => !a.texts.has(s.text)).map((s): AxiomChange => ({ op: 'add', axiom: axiomOf(s, b.kinds) })),
  ];
}

/** The axioms about one entity: the statements it is the subject of, and those of no subject of their own that name it. */
export function entityAxioms(model: Model, iri: string): Axiom[] {
  const o = ontologyOf(model);
  return o.statements
    .filter((s) => s.quads.some((q) => q.subject.termType === 'NamedNode' && q.subject.value === iri) || (s.quads.every((q) => q.subject.termType === 'BlankNode') && s.quads.some((q) => q.object.value === iri)))
    .map((s) => axiomOf(s, o.kinds));
}

// ---------------------------------------------------------------- the history of a document

/** Where a document is: a number for each state it has been in, and the revision of the ontology it is. */
export interface Version {
  state: number;
  revision: string;
}

type Fields = Partial<Record<keyof Model, unknown>>;

/** The parts of a model a change replaced: what they were, and what they became. A part that is absent is undefined. */
export interface Patch {
  before: Fields;
  after: Fields;
}

/** A change set made in the editor, as it is applied to the model. */
export interface Step {
  base: Version;
  result: Version;
  patch: Patch;
}

export interface DocumentState {
  model: Model;
  version: Version;
  /** The steps that undo takes back, the last one first. */
  past: Step[];
  /** The steps that redo makes again, the first one first. */
  future: Step[];
}

/** How many steps are kept to undo. */
export const HISTORY = 100;

let states = 0;
const versionOf = (model: Model, state = ++states): Version => ({ state, revision: revisionOf(model) });
const isEmpty = (p: Patch) => !Object.keys(p.after).length;
const NOTHING: Patch = { before: {}, after: {} };

/** The parts in which two models differ. */
export function patchOf(a: Model, b: Model): Patch {
  const before: Fields = {};
  const after: Fields = {};
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)]) as Set<keyof Model>) {
    if (x[k] === y[k]) continue;
    before[k] = x[k];
    after[k] = y[k];
  }
  return { before, after };
}

/**
 * The model with the parts `from` names replaced by those of `to`, where those parts are exactly
 * `from`; otherwise nothing, because the change was made to something else.
 */
export function patched(model: Model, from: Fields, to: Fields): Model | undefined {
  const m = model as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(from)) if (m[k] !== v) return undefined;
  const next = { ...m };
  for (const [k, v] of Object.entries(to)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as unknown as Model;
}

/** One change and then another, as one. */
function composed(p: Patch, q: Patch): Patch {
  const before: Fields = { ...q.before, ...p.before };
  const after: Fields = { ...p.after, ...q.after };
  for (const k of Object.keys(after) as (keyof Model)[]) {
    if (before[k] !== after[k]) continue;
    delete before[k];
    delete after[k];
  }
  return { before, after };
}

/** A document opened afresh: a model with no history. */
export const opened = (model: Model): DocumentState => ({ model, version: versionOf(model), past: [], future: [] });

/**
 * The document with an edit made to it: `next` is the model the edit gives. Recorded, it is a step
 * of its own; otherwise it joins the last step, and one undo takes both back. Either way what was
 * undone can no longer be redone.
 */
export function committed(d: DocumentState, next: Model, record = true): DocumentState {
  const patch = patchOf(d.model, next);
  if (isEmpty(patch)) return d;
  const version = versionOf(next);
  if (record) return { model: next, version, past: [...d.past, { base: d.version, result: version, patch }].slice(-HISTORY), future: [] };
  const last = d.past.at(-1);
  if (!last) return { model: next, version, past: d.past, future: [] };
  return { model: next, version, past: [...d.past.slice(0, -1), { base: last.base, result: version, patch: composed(last.patch, patch) }], future: [] };
}

/** The document with an empty step begun, which the edits that follow unrecorded (a drag) join. */
export const checkpointed = (d: DocumentState): DocumentState => ({ ...d, past: [...d.past, { base: d.version, result: d.version, patch: NOTHING }].slice(-HISTORY), future: [] });

/** The model a step leads back to, or forward to; nothing where the model is no longer the one it led to. */
function stepped(model: Model, step: Step, back: boolean): Model | undefined {
  if (isEmpty(step.patch)) return model;
  return back ? patched(model, step.patch.after, step.patch.before) : patched(model, step.patch.before, step.patch.after);
}

/** The document with its last step applied backwards (undo), or nothing to undo. */
export function undone(d: DocumentState): DocumentState | undefined {
  const step = d.past.at(-1);
  const model = step && stepped(d.model, step, true);
  if (!step || !model) return undefined;
  return { model, version: versionOf(model, step.base.state), past: d.past.slice(0, -1), future: [step, ...d.future] };
}

/** The document with the step that was undone last made again (redo), or nothing to redo. */
export function redone(d: DocumentState): DocumentState | undefined {
  const step = d.future[0];
  const model = step && stepped(d.model, step, false);
  if (!step || !model) return undefined;
  return { model, version: versionOf(model, step.result.state), past: [...d.past, step].slice(-HISTORY), future: d.future.slice(1) };
}

/** The document with its last step taken back and forgotten: an edit given up before it was finished. */
export function discarded(d: DocumentState): DocumentState | undefined {
  const back = undone(d);
  return back && { ...back, future: d.future };
}

/**
 * One step of the history (`index` into `past`) as the contract has it: what it added and
 * removed. The models it went between are found by applying the steps after it backwards; what
 * they state is then worked out, which for a large model costs as much as an export, so this is
 * asked of one step at a time. Nothing where the history does not lead back.
 */
export function stepChangeSet(d: DocumentState, index: number, ontologyId: string): ChangeSet | undefined {
  const step = d.past[index];
  if (!step) return undefined;
  let after: Model | undefined = d.model;
  for (let i = d.past.length - 1; i > index && after; i--) after = stepped(after, d.past[i], true);
  const before = after && stepped(after, step, true);
  if (!after || !before) return undefined;
  return { ontologyId, baseRevision: step.base.revision, changes: changesBetween(before, after), summary: summaryOf(step.patch) };
}

// ---------------------------------------------------------------- what a step did, in words

const PARTS: Partial<Record<keyof Model, string>> = {
  style: 'how the graph is drawn',
  layout: 'the layout',
  shapeSets: 'the SHACL shapes',
  quality: 'the quality rules',
  governance: 'the metadata fields',
  vocab: 'the standard properties',
  externals: 'the other ontologies',
  mappings: 'the mappings',
  rejected: 'the mappings',
  unmapped: 'the statements kept as they were read',
  prefixes: 'the prefixes',
};

/** What a step did, in a line: which terms it added, removed or changed, and what else it touched. */
export function summaryOf(p: Patch): string {
  if (isEmpty(p)) return 'Nothing';
  const parts: string[] = [];
  const named = (xs: { name: string }[]) => (xs.length === 1 ? `“${xs[0].name || 'Unnamed'}”` : `${xs.length} terms`);
  if ('terms' in p.after) {
    const before = new Map(((p.before.terms as Term[] | undefined) ?? []).map((t) => [t.id, t]));
    const after = (p.after.terms as Term[] | undefined) ?? [];
    const ids = new Set(after.map((t) => t.id));
    const added = after.filter((t) => !before.has(t.id));
    const removed = [...before.values()].filter((t) => !ids.has(t.id));
    const changed = after.filter((t) => before.has(t.id) && before.get(t.id) !== t);
    const moved = changed.filter((t) => {
      const was = before.get(t.id)!;
      return (Object.keys(t) as (keyof Term)[]).every((k) => k === 'x' || k === 'y' || t[k] === was[k]);
    });
    if (added.length) parts.push(`added ${named(added)}`);
    if (removed.length) parts.push(`removed ${named(removed)}`);
    if (changed.length > moved.length) parts.push(`changed ${named(changed.filter((t) => !moved.includes(t)))}`);
    if (moved.length) parts.push(`moved ${named(moved)}`);
  }
  const counted = (key: 'relations' | 'props' | 'datatypes', one: string, many: string) => {
    if (!(key in p.after)) return;
    const before = new Map(((p.before[key] as { id: string }[] | undefined) ?? []).map((x) => [x.id, x]));
    const after = (p.after[key] as { id: string }[] | undefined) ?? [];
    const ids = new Set(after.map((x) => x.id));
    const n = (k: number) => (k === 1 ? `a ${one}` : `${k} ${many}`);
    const added = after.filter((x) => !before.has(x.id)).length;
    const removed = [...before.keys()].filter((id) => !ids.has(id)).length;
    const changed = after.filter((x) => before.has(x.id) && before.get(x.id) !== x).length;
    if (added) parts.push(`added ${n(added)}`);
    if (removed) parts.push(`removed ${n(removed)}`);
    if (changed) parts.push(`changed ${n(changed)}`);
  };
  counted('relations', 'relationship', 'relationships');
  counted('props', 'object property', 'object properties');
  counted('datatypes', 'datatype', 'datatypes');
  const settings = (['name', 'description', 'baseIri', 'ontologyIri', 'mode', 'lang'] as (keyof Model)[]).some((k) => k in p.after);
  if (settings) parts.push('changed the ontology’s settings');
  for (const part of [...new Set(Object.keys(p.after).flatMap((k) => PARTS[k as keyof Model] ?? []))]) parts.push(`changed ${part}`);
  const line = parts.length ? parts.join('; ') : 'changed the model';
  return line[0].toUpperCase() + line.slice(1);
}

// ---------------------------------------------------------------- change sets from elsewhere

/** Whether two values are the same plain data, whatever order their keys are in. An absent key and an undefined one are the same. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (!equal(x[k], y[k])) return false;
  return true;
}

/** Axioms read back with the ids of the axioms they were before, where they are the same: an editor that has one open keeps it. */
function withIdsOf<T extends ClassAxiom | DataRangeAxiom | ClassExpressionAxiom>(read: T[] | undefined, old: T[] | undefined): T[] | undefined {
  if (!read || !old?.length) return read;
  const free = [...old];
  return read.map((a) => {
    const i = free.findIndex((o) => equal({ ...o, id: '' }, { ...a, id: '' }));
    return i < 0 ? a : { ...a, id: free.splice(i, 1)[0].id };
  });
}

/** An expression, or anything holding expressions, with the model's own enumerated datatypes named by other ids. */
function withEnums<T>(x: T, id: (datatype: string) => string): T {
  if (Array.isArray(x)) return x.map((v) => withEnums(v, id)) as T;
  if (!x || typeof x !== 'object') return x;
  const o = x as Record<string, unknown>;
  if (o.type === 'Enumeration' && typeof o.datatype === 'string') return { ...o, datatype: id(o.datatype) } as T;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, withEnums(v, id)])) as T;
}

const pick = <T>(map: Record<string, T>, keep: Set<string>): Record<string, T> => Object.fromEntries(Object.entries(map).filter(([k]) => keep.has(k)));

/**
 * A model read back from statements, given what the model it was read in place of had and the
 * statements do not say: the ids of its entities, relationships and axioms (which the drawing,
 * the shapes and the mappings refer to), where its terms sit and their colours, and its settings.
 * What is the same as before is the very object it was before.
 */
function carriedOver(old: Model, read: Model): Model {
  const byIri = <T extends { iri?: string }>(xs: T[]) => new Map(xs.filter((x) => x.iri).map((x) => [x.iri!, x]));
  const oldTerms = byIri(old.terms);
  const oldProps = byIri(old.props);
  const oldTypes = byIri(old.datatypes.filter((d) => !d.anonymous));
  const ids = (xs: { id: string; iri?: string }[], olds: Map<string, { id: string }>) => new Map(xs.flatMap((x) => (x.iri && olds.has(x.iri) ? [[x.id, olds.get(x.iri)!.id] as const] : [])));
  const termIds = ids(read.terms, oldTerms);
  const propIds = ids(read.props, oldProps);
  const typeIds = ids(read.datatypes, oldTypes);
  const term = (id: string) => termIds.get(id) ?? id;
  const prop = (id: string) => propIds.get(id) ?? id;
  const datatype = (id: string) => typeIds.get(id) ?? id;
  const external = new Map(read.externals.map((e) => [e.id, old.externals.find((o) => o.iri === e.iri)?.id ?? e.id]));
  const same = <T>(was: T | undefined, now: T): T => (was && equal(was, now) ? was : now);

  const datatypes = read.datatypes.map((d): EnumDatatype => {
    const was = d.iri ? oldTypes.get(d.iri) : undefined;
    return same(was, { ...d, id: datatype(d.id) });
  });
  const props = read.props.map((p): ObjProp => {
    const was = p.iri ? oldProps.get(p.iri) : undefined;
    const links = Object.fromEntries((['parents', 'inverses', 'equivalents', 'disjoints'] as PropLink[]).filter((l) => p[l]).map((l) => [l, p[l]!.map(prop)]));
    const now: ObjProp = { ...p, ...links, id: prop(p.id), domains: withIdsOf(withEnums(p.domains, datatype), was?.domains), ranges: withIdsOf(withEnums(p.ranges, datatype), was?.ranges) };
    if (now.domains === undefined) delete now.domains;
    if (now.ranges === undefined) delete now.ranges;
    if (was?.external !== undefined) now.external = was.external;
    else if (p.external !== undefined) now.external = external.get(p.external) ?? p.external;
    return same(was, now);
  });
  const terms = read.terms.map((t): Term => {
    const was = t.iri ? oldTerms.get(t.iri) : undefined;
    const now: Term = { ...t, id: term(t.id) };
    if (t.oneOf) now.oneOf = t.oneOf.map(term);
    if (t.values) now.values = t.values.map((v) => ({ ...v, prop: term(v.prop) }));
    if (t.ranges) now.ranges = withIdsOf(withEnums(t.ranges, datatype), was?.ranges);
    if (t.domains) now.domains = withIdsOf(withEnums(t.domains, datatype), was?.domains);
    if (t.classAxioms) now.classAxioms = withIdsOf(withEnums(t.classAxioms, datatype), was?.classAxioms);
    if (was) {
      now.x = was.x;
      now.y = was.y;
      now.color = was.color;
      if (was.external !== undefined) now.external = was.external;
      else delete now.external;
    } else if (t.external !== undefined) now.external = external.get(t.external) ?? t.external;
    return same(was, now);
  });

  // A relationship that is the same statement as one before is that one, with its id, its
  // description and its cardinalities; one between the same terms by the same property keeps the id.
  const sig = (r: Relation) => JSON.stringify([r.from, r.to, r.kind, r.prop ?? '', r.predicate ?? '']);
  const free = [...old.relations];
  const relations = read.relations.map((r): Relation => {
    const now: Relation = { ...r, from: term(r.from), to: term(r.to), ...(r.prop !== undefined ? { prop: prop(r.prop) } : {}) };
    let i = free.findIndex((o) => equal({ ...o, id: '', description: '', fromCard: '', toCard: '' }, { ...now, id: '', description: '', fromCard: '', toCard: '' }));
    if (i >= 0) return free.splice(i, 1)[0];
    i = free.findIndex((o) => sig(o) === sig(now));
    return i < 0 ? now : { ...now, id: free.splice(i, 1)[0].id };
  });

  const termSet = new Set(terms.map((t) => t.id));
  const relSet = new Set(relations.map((r) => r.id));
  const imported = new Set(read.externals.filter((e) => e.imports).map((e) => e.iri));
  const externals: ExternalRef[] = [...old.externals.map((e) => (e.imports === imported.has(e.iri) ? e : { ...e, imports: imported.has(e.iri) })), ...read.externals.filter((e) => !old.externals.some((o) => o.iri === e.iri))];
  return {
    ...read,
    terms,
    props,
    relations,
    datatypes,
    externals: equal(externals, old.externals) ? old.externals : externals,
    prefixes: old.prefixes,
    // The settings are the model's, but statements of the RDFS and OWL properties need those properties in force.
    vocab: read.vocab.enabled && !old.vocab.enabled ? { ...old.vocab, enabled: true } : old.vocab,
    style: { ...old.style, nodes: pick(old.style.nodes, termSet), edges: pick(old.style.edges, relSet), anchors: pick(old.style.anchors, relSet) },
    layout: old.layout,
    shapeSets: old.shapeSets,
    quality: old.quality,
    governance: old.governance,
    mappings: old.mappings,
    rejected: old.rejected,
  };
}

/** A model that states these statements, read in place of `old`; nothing where they cannot be read. */
function readBack(old: Model, texts: string[]): Model | string {
  try {
    return carriedOver(old, fromTurtle(ontologyOf(old).prefixes + '\n' + texts.join('\n'), old.name));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** What the editor's rules say of an axiom being added to a model: why not, or what is worth knowing. Nothing where no rule is about it. */
function ruled(model: Model, a: Axiom): { error?: string; note?: string } {
  const term = (iri: string) => termOfIri(model, iri);
  const objectProperty = (iri: string) => model.props.find((p) => p.iri === iri);
  const asked = (e: Edit) => (e.error !== undefined ? { error: e.error } : e.note ? { note: e.note } : {});
  const pair = (iris: string[], kind: LinkKind) => {
    const [x, y] = iris.map(term);
    return iris.length === 2 && x && y ? asked(addLink(model, x.id, y.id, kind)) : {};
  };
  const props = (first: string, second: string, link: PropLink) => {
    const [x, y] = [first, second].map(objectProperty);
    return x && y ? asked(addPropLink(model, x.id, y.id, link)) : {};
  };
  const named = (e: { type: string; iri?: string }) => (e.type === 'Class' && e.iri ? e.iri : undefined);
  switch (a.type) {
    case 'SubClassOf': {
      const [x, y] = [named(a.sub), named(a.sup)].map((iri) => (iri ? term(iri) : undefined));
      return x && y ? asked(addIsA(model, x.id, y.id)) : {};
    }
    case 'EquivalentClasses':
    case 'DisjointClasses': {
      const iris = a.classes.map(named);
      return iris.every((x) => x) ? pair(iris as string[], a.type === 'EquivalentClasses' ? 'equivalentClass' : 'disjointWith') : {};
    }
    case 'SameIndividual':
      return pair(a.individuals, 'sameAs');
    case 'DifferentIndividuals':
      return pair(a.individuals, 'differentFrom');
    case 'EquivalentDataProperties':
      return pair(a.properties, 'equivalentProperty');
    case 'DisjointDataProperties':
      return pair(a.properties, 'propertyDisjointWith');
    case 'ClassAssertion': {
      const cls = named(a.class);
      const [x, y] = [term(a.individual), cls ? term(cls) : undefined];
      if (!x || !y) return {};
      const probe = newRelation({ from: x.id, to: y.id });
      return asked(makeInstanceOf({ ...model, relations: [...model.relations, probe] }, probe.id));
    }
    case 'ObjectPropertyAssertion': {
      const [x, y, p] = [term(a.source), term(a.target), objectProperty(a.property)];
      return x && y && p ? asked(addFact(model, x.id, p.id, y.id)) : {};
    }
    case 'DataPropertyAssertion': {
      const [x, p] = [term(a.source), term(a.property)];
      return x && p ? asked(addValue(model, x.id, { prop: p.id, value: a.value.value, ...(a.value.lang ? { lang: a.value.lang } : {}) })) : {};
    }
    case 'SubObjectPropertyOf':
      return props(a.sub, a.sup, 'parents');
    case 'InverseObjectProperties':
      return props(a.first, a.second, 'inverses');
    case 'EquivalentObjectProperties':
    case 'DisjointObjectProperties':
      return a.properties.length === 2 ? props(a.properties[0], a.properties[1], a.type === 'EquivalentObjectProperties' ? 'equivalents' : 'disjoints') : {};
    default:
      return {};
  }
}

interface Plan {
  next?: Model;
  refusals: Refusal[];
  notes: string[];
}

/** What applying a change set to a model would give: the model, or why it cannot be applied. */
function planned(model: Model, cs: ChangeSet): Plan {
  const o = ontologyOf(model);
  const refusals: Refusal[] = [];
  const removed = new Set<string>();
  const added: { text: string; axiom: Axiom }[] = [];
  const seen = new Set<string>();
  for (const c of cs.changes) {
    const text = statementOf(c.axiom);
    if (!text) refusals.push({ code: 'invalid', message: `${brief(c.axiom)} is not one statement that can be read and written.` });
    else if (seen.has(text)) refusals.push({ code: 'invalid', message: `${brief(c.axiom)} is changed twice by one change set.` });
    else if (c.op === 'remove' && !o.texts.has(text)) refusals.push({ code: 'invalid', message: `${brief(c.axiom)} is not stated, so it cannot be removed.` });
    else if (c.op === 'add' && o.texts.has(text)) refusals.push({ code: 'invalid', message: `${brief(c.axiom)} is stated already.` });
    else if (c.op === 'remove') removed.add(text);
    else added.push({ text, axiom: c.axiom });
    if (text) seen.add(text);
  }
  if (refusals.length) return { refusals, notes: [] };
  if (!removed.size && !added.length) return { next: model, refusals, notes: [] };

  // What is added is held to the rules an edit in the editor is, in the model as it is once the
  // removals are made: what a change set takes away does not stand in the way of what it adds.
  const kept = o.statements.map((s) => s.text).filter((t) => !removed.has(t));
  const base = removed.size ? readBack(model, kept) : model;
  if (typeof base === 'string') return { refusals: [{ code: 'unsupported', message: `What is left once the removals are made could not be read: ${base}` }], notes: [] };
  const notes: string[] = [];
  for (const { axiom } of added) {
    const said = ruled(base, axiom);
    if (said.error) refusals.push({ code: 'refused', message: said.error });
    else if (said.note) notes.push(said.note);
  }
  if (refusals.length) return { refusals, notes };

  const wanted = [...kept, ...added.map((a) => a.text)];
  const next = readBack(model, wanted);
  if (typeof next === 'string') return { refusals: [{ code: 'unsupported', message: `The result could not be read: ${next}` }], notes };
  // Only a model that states exactly what was asked for is taken: nothing lost, nothing added.
  const held = ontologyOf(next).texts;
  const want = new Set(wanted);
  const lost = wanted.filter((t) => !held.has(t));
  const extra = [...held].filter((t) => !want.has(t));
  if (lost.length || extra.length) {
    const example = (lost[0] ?? extra[0]).slice(0, 160);
    return { refusals: [{ code: 'unsupported', message: `The editor would not hold the result as it was asked for: ${lost.length} statement(s) would be lost and ${extra.length} added, such as ${example}` }], notes };
  }
  return { next, refusals, notes };
}

// ---------------------------------------------------------------- the service

/** What the edit service is given of the editor: the model being edited, and a way to make the next one. */
export interface EditHost {
  current(): { model: Model; ontologyId: string };
  /** Makes a model the next one, as an edit made in the editor: one step to undo. */
  commit(next: Model): void;
}

const aborted = (options?: CallOptions) => {
  if (options?.signal?.aborted) throw new EditError('aborted', 'The question was given up.');
};

/** The edit service over the model in the editor, which `host` gives and takes. */
export function createLocalEditService(host: EditHost): OntologyEditService {
  /** The model, if the change set or question is about the one being edited, as it is now. */
  const against = (ontologyId: string, revisionId: string): Model => {
    const { model, ontologyId: open } = host.current();
    if (ontologyId !== open) throw new EditError('not-found', `The ontology “${ontologyId}” is not the one being edited.`);
    if (revisionId !== revisionOf(model)) throw new EditError('stale-revision', `The ontology has moved on from revision ${revisionId}.`);
    return model;
  };
  return {
    async validate(changeSet, options) {
      aborted(options);
      const plan = planned(against(changeSet.ontologyId, changeSet.baseRevision), changeSet);
      return { ok: !plan.refusals.length, refusals: plan.refusals, notes: plan.notes };
    },
    async apply(changeSet, options) {
      aborted(options);
      const plan = planned(against(changeSet.ontologyId, changeSet.baseRevision), changeSet);
      if (plan.refusals.length || !plan.next) throw new EditError('refused', plan.refusals[0]?.message ?? 'The change set was not applied.', plan.refusals);
      host.commit(plan.next);
      const now = host.current();
      return { ontologyId: now.ontologyId, revisionId: revisionOf(now.model), notes: plan.notes };
    },
    async entity(query, options) {
      aborted(options);
      const model = against(query.ontologyId, query.revisionId);
      return { ontologyId: query.ontologyId, revisionId: query.revisionId, iri: query.iri, axioms: entityAxioms(model, query.iri) };
    },
  };
}
