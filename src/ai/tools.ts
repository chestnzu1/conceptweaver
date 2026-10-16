import type { Axiom } from '../editing/contracts';
import { entityAxioms } from '../editing/local';
import { inferredRestrictions } from '../model/inferred';
import { namingFor } from '../model/manchester';
import { ontologyIriOf, compactIri, expandIri } from '../model/prefixes';
import { assertedSuperclasses, objectProperties, restrictionsOf } from '../model/props';
import type { Reasoning } from '../model/reasoner';
import type { Model, Term } from '../model/types';
import { axiomText } from '../projects/difference';
import type { ValidationReport } from '../validation/contracts';
import type { JsonSchema, ToolSpec } from './providers/contracts';

/**
 * What the assistant may look up in the ontology (spec §3): read-only tools over the model as the
 * editor holds it, each answering about a few entities, never the whole ontology, and within a
 * bounded size. What is stated (asserted) is kept apart from what a reasoner entails (inferred),
 * and each says where it comes from. Names, labels and annotations are the ontology's data: the
 * model is told so, and they are never read as instructions (see the system prompt).
 *
 * The tools are given an OntologyContext rather than the store, so that a backend can answer
 * them the same way later.
 */

/** What the tools read: the model, what is selected, and what reasoning and validation found about it. */
export interface OntologyContext {
  model: Model;
  /** The entity selected in the editor, by IRI. */
  selected?: string;
  /** The fast reasoner's answer about this very model, if there is one. */
  reasoning?: Reasoning;
  /** The last validation run, and whether the model has changed since. */
  validation?: { run: ValidationReport; stale: boolean };
  /** The ontologies the model imports whose content is in this browser, by IRI. */
  loadedImports: string[];
}

/** The most a tool answers with, in characters, and the most items of a list. */
export const TOOL_BUDGET = 12_000;
const LIST = 40;

type Kind = 'class' | 'object property' | 'data property' | 'individual' | 'datatype';
interface Found {
  iri: string;
  name: string;
  kind: Kind;
  term?: Term;
  propId?: string;
}

const kindOf = (t: Term): Kind => (t.type === 'concept' ? 'class' : t.type === 'instance' ? 'individual' : 'data property');

/** An entity by its IRI, prefixed name, <IRI>, or (where only one has it) its name. */
export function findEntity(model: Model, ref: string): Found | undefined {
  const text = ref.trim();
  const iri = text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
  const byIri = (x: string): Found | undefined => {
    const t = model.terms.find((y) => y.iri === x);
    if (t) return { iri: x, name: t.name || 'Unnamed', kind: kindOf(t), term: t };
    const p = model.props.find((y) => y.iri === x);
    if (p) return { iri: x, name: p.name, kind: 'object property', propId: p.id };
    const d = model.datatypes.find((y) => y.iri === x);
    return d ? { iri: x, name: d.name, kind: 'datatype' } : undefined;
  };
  const direct = byIri(iri) ?? (expandIri(model, iri) ? byIri(expandIri(model, iri)!) : undefined);
  if (direct) return direct;
  const named = [...model.terms.filter((t) => t.iri && t.name.trim().toLowerCase() === iri.toLowerCase()).map((t) => byIri(t.iri!)), ...model.props.filter((p) => p.iri && p.name.trim().toLowerCase() === iri.toLowerCase()).map((p) => byIri(p.iri!))].filter((x): x is Found => !!x);
  return named.length === 1 ? named[0] : undefined;
}

const short = (model: Model, iri: string) => compactIri(model, iri) ?? `<${iri}>`;
const ref = (model: Model, iri: string) => {
  const f = findEntity(model, iri);
  return { name: f?.name ?? short(model, iri), iri };
};
const capped = <T>(list: T[], n = LIST) => ({ items: list.slice(0, n), ...(list.length > n ? { more: list.length - n } : {}) });

/** The IRIs an axiom names, for saying which entity each name in its text is. */
function irisIn(a: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(a)) a.forEach((x) => irisIn(x, out));
  else if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) (k === 'iri' || k === 'property' || k === 'subject' || k === 'source' || k === 'target' || k === 'individual' || k === 'sub' || k === 'sup' || k === 'first' || k === 'second' || k === 'datatype') && typeof v === 'string' ? out.add(v) : irisIn(v, out);
  return out;
}

/** The axioms the model states about an entity, as the editor writes them, with the entities they name. */
function assertedAbout(model: Model, iri: string) {
  const naming = namingFor(model);
  const axioms: Axiom[] = entityAxioms(model, iri);
  const mentioned = new Set<string>();
  const texts = axioms.map((a) => {
    irisIn(a, mentioned);
    return axiomText(a, naming);
  });
  return {
    axioms: capped(texts, 60),
    names: [...mentioned]
      .filter((x) => x !== iri && findEntity(model, x))
      .slice(0, 60)
      .map((x) => ref(model, x)),
  };
}

const annotationsOf = (t: Term | undefined) =>
  t
    ? {
        ...(t.description ? { description: t.description } : {}),
        ...(t.synonyms ? { synonyms: t.synonyms } : {}),
        ...(t.fields.length ? { other: capped(t.fields.map((f) => ({ property: f.key, value: f.value.slice(0, 500), ...(f.lang ? { lang: f.lang } : {}) })), 20) } : {}),
      }
    : {};

// ---------------------------------------------------------------- the tools

function summary(c: OntologyContext) {
  const m = c.model;
  const classes = m.terms.filter((t) => t.type === 'concept');
  const tops = classes.filter((t) => !assertedSuperclasses(m, t.id).length);
  return {
    name: m.name,
    iri: ontologyIriOf(m),
    kind: m.mode === 'skos' ? 'SKOS-like vocabulary' : 'OWL ontology',
    defaultNamespace: m.baseIri,
    counts: { classes: classes.length, objectProperties: m.props.length, dataProperties: m.terms.filter((t) => t.type === 'property').length, individuals: m.terms.filter((t) => t.type === 'instance').length, datatypes: m.datatypes.length, shapeSets: m.shapeSets.length },
    topClasses: capped(tops.filter((t) => t.iri).map((t) => ({ name: t.name, iri: t.iri! })), 30),
    imports: m.externals.filter((e) => e.imports).map((e) => e.iri),
    reasoning: c.reasoning ? { consistent: c.reasoning.consistent, unsatisfiableClasses: c.reasoning.unsatisfiable.size, partial: c.reasoning.truncated, by: 'the app’s fast reasoner (RDFS and part of OWL 2 RL); “consistent” is not a proof' } : 'not worked out for the ontology as it is now',
    validation: c.validation ? { stale: c.validation.stale, findings: c.validation.run.findings.length } : 'not run',
  };
}

function search(c: OntologyContext, query: string, kind?: string, limit = 15) {
  const q = query.trim().toLowerCase();
  const m = c.model;
  const all: Found[] = [...m.terms.filter((t) => t.iri).map((t) => ({ iri: t.iri!, name: t.name || 'Unnamed', kind: kindOf(t), term: t })), ...m.props.filter((p) => p.iri).map((p) => ({ iri: p.iri!, name: p.name, kind: 'object property' as Kind }))];
  const score = (f: Found) => {
    const n = f.name.toLowerCase();
    const local = f.iri.replace(/^.*[#/]/, '').toLowerCase();
    if (n === q || local === q) return 0;
    if (n.startsWith(q) || local.startsWith(q)) return 1;
    if (n.includes(q) || local.includes(q)) return 2;
    // The whole IRI only for a query that looks like one: every IRI of a namespace has its words in it.
    if (f.term?.synonyms.toLowerCase().includes(q) || (/[:/#]/.test(q) && f.iri.toLowerCase().includes(q))) return 3;
    if (f.term?.description.toLowerCase().includes(q)) return 4;
    return 9;
  };
  const found = all
    .filter((f) => !kind || f.kind === kind)
    .map((f) => ({ f, s: score(f) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.f.name.localeCompare(b.f.name));
  return { results: found.slice(0, Math.min(25, Math.max(1, limit))).map(({ f }) => ({ name: f.name, iri: f.iri, kind: f.kind })), total: found.length };
}

function details(c: OntologyContext, e: Found) {
  const m = c.model;
  const base = { iri: e.iri, name: e.name, kind: e.kind, prefixedName: short(m, e.iri), annotations: annotationsOf(e.term), asserted: assertedAbout(m, e.iri) };
  if (e.kind === 'class' && e.term) {
    const id = e.term.id;
    const supers = c.reasoning?.superclasses(id) ?? [];
    return {
      ...base,
      superclasses: { asserted: assertedSuperclasses(m, id).map((s) => ref(m, m.terms.find((t) => t.id === s)?.iri ?? s)), inferred: c.reasoning ? capped(supers.filter((s) => !s.asserted).map((s) => ({ ...ref(m, m.terms.find((t) => t.id === s.id)?.iri ?? s.id), because: s.because.slice(0, 300), ...(s.equivalent ? { equivalent: true } : {}) })), 20) : 'not worked out yet' },
      subclasses: capped(m.terms.filter((t) => t.type === 'concept' && assertedSuperclasses(m, t.id).includes(id) && t.iri).map((t) => ref(m, t.iri!)), 30),
      instances: capped(m.terms.filter((t) => t.type === 'instance' && assertedSuperclasses(m, t.id).includes(id) && t.iri).map((t) => ref(m, t.iri!)), 20),
      ...(c.reasoning?.unsatisfiable.has(id) ? { unsatisfiable: 'The fast reasoner finds this class can have no members: see getValidationResults for why.' } : {}),
    };
  }
  if (e.kind === 'individual' && e.term) {
    const types = c.reasoning?.types(e.term.id) ?? [];
    return { ...base, types: { inferred: c.reasoning ? capped(types.filter((s) => !s.asserted).map((s) => ({ ...ref(m, m.terms.find((t) => t.id === s.id)?.iri ?? s.id), because: s.because.slice(0, 300) })), 20) : 'not worked out yet' } };
  }
  if (e.kind === 'object property' && e.propId) {
    const view = objectProperties(m).find((p) => p.id === e.propId);
    return { ...base, characteristics: view?.chars ?? [], uses: view?.rels.length ?? 0 };
  }
  return base;
}

function hierarchy(c: OntologyContext, e: Found, depth: number) {
  const m = c.model;
  if (e.kind !== 'class' || !e.term) return { error: `${e.name} is a ${e.kind}, not a class.` };
  const byId = new Map(m.terms.map((t) => [t.id, t]));
  const name = (id: string) => ({ name: byId.get(id)?.name || 'Unnamed', iri: byId.get(id)?.iri ?? '' });
  // Up: every chain of stated superclasses, as far as they go.
  const ancestors: { name: string; iri: string; via: string }[] = [];
  const seen = new Set<string>([e.term.id]);
  let frontier = [e.term.id];
  for (let level = 0; level < 12 && frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const s of assertedSuperclasses(m, id)) {
        if (seen.has(s)) continue;
        seen.add(s);
        ancestors.push({ ...name(s), via: name(id).name });
        next.push(s);
      }
    frontier = next;
  }
  // Down, as a tree, a few levels.
  const children = new Map<string, string[]>();
  for (const t of m.terms) if (t.type === 'concept') for (const s of assertedSuperclasses(m, t.id)) children.set(s, [...(children.get(s) ?? []), t.id]);
  let budget = 80;
  const tree = (id: string, d: number): unknown => {
    const kids = children.get(id) ?? [];
    budget--;
    return { ...name(id), ...(kids.length ? (d < depth && budget > 0 ? { subclasses: kids.slice(0, 20).map((k) => tree(k, d + 1)), ...(kids.length > 20 ? { more: kids.length - 20 } : {}) } : { subclassesNotShown: kids.length }) : {}) };
  };
  return {
    class: ref(m, e.iri),
    asserted: { ancestors: capped(ancestors, 40), descendants: tree(e.term.id, 0) },
    inferred: c.reasoning ? capped(c.reasoning.superclasses(e.term.id).filter((s) => !s.asserted).map((s) => ({ ...name(s.id), because: s.because.slice(0, 300) })), 20) : 'The inferred hierarchy has not been worked out for the ontology as it is now.',
  };
}

function propertyAxioms(c: OntologyContext, e: Found) {
  if (e.kind !== 'object property' && e.kind !== 'data property') return { error: `${e.name} is a ${e.kind}, not a property.` };
  return details(c, e);
}

function restrictions(c: OntologyContext, e: Found) {
  const m = c.model;
  if (e.kind !== 'class' || !e.term) return { error: `${e.name} is a ${e.kind}, not a class.` };
  const naming = namingFor(m);
  const stated = entityAxioms(m, e.iri)
    .filter((a) => (a.type === 'SubClassOf' && a.sub.type === 'Class' && a.sub.iri === e.iri && a.sup.type !== 'Class') || (a.type === 'EquivalentClasses' && a.classes.some((x) => x.type !== 'Class')))
    .map((a) => axiomText(a, naming));
  const inherited = inferredRestrictions(m, c.reasoning, e.term.id);
  return {
    class: ref(m, e.iri),
    asserted: capped(stated, 40),
    drawnOnTheCanvas: capped(restrictionsOf(m, e.term.id).map((r) => r.text), 40),
    inherited:
      inherited.status === 'working'
        ? 'not worked out yet'
        : { status: inherited.status, restrictions: capped([...inherited.restrictions.map((r) => ({ restriction: r.restriction.text, from: r.sources.map((s) => s.name) })), ...inherited.expressions.map((x) => ({ restriction: x.text, from: x.sources.map((s) => s.name) }))], 30) },
  };
}

function imports(c: OntologyContext) {
  return {
    imports: c.model.externals.map((e) => ({ iri: e.iri, name: e.name, imported: e.imports, contentInThisBrowser: c.loadedImports.includes(e.iri), classes: e.classes, objectProperties: e.objectProperties, dataProperties: e.dataProperties })),
    note: 'An ontology added under Align is either imported (owl:imports: its axioms count when reasoning) or only reused (its entities referred to).',
  };
}

function validationResults(c: OntologyContext, category?: string, limit = 25) {
  if (!c.validation) return { status: 'Validation has not been run for this ontology in this session. The user can run it under Validation.' };
  const { run, stale } = c.validation;
  const found = run.findings.filter((f) => !category || f.category === category);
  return {
    stale: stale ? 'The ontology has changed since this run: these results may no longer hold.' : false,
    at: new Date(run.at).toISOString(),
    owl: run.owl ? { reasoner: run.owl.engineName, status: run.owl.status, proved: run.owl.proved, unsatisfiable: run.owl.unsatisfiable.map((id) => ref(c.model, c.model.terms.find((t) => t.id === id)?.iri ?? id)) } : 'not run',
    shacl: run.shacl ? { status: run.shacl.status, violations: run.shacl.violations, warnings: run.shacl.warnings } : 'not run',
    quality: run.quality ? { warnings: run.quality.warnings, suggestions: run.quality.suggestions } : 'not run',
    findings: capped(
      found.map((f) => ({
        category: f.category,
        severity: f.severity,
        rule: f.rule,
        message: f.message.slice(0, 400),
        ...(f.entity ? { entity: { name: f.entity.name, ...(f.entity.iri ? { iri: f.entity.iri } : {}) } } : {}),
        ...(f.explanation ? { explanation: f.explanation.slice(0, 600) } : {}),
        ...(f.justifications?.length ? { justification: f.justifications[0].map((a) => a.text).slice(0, 12) } : {}),
      })),
      Math.min(60, Math.max(1, limit)),
    ),
  };
}

// ---------------------------------------------------------------- specs and running them

const str = (description: string): JsonSchema => ({ type: 'string', description });
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required });
const IRI = str('The entity: its full IRI as a tool gave it (or its prefixed name).');

export const READ_TOOLS: ToolSpec[] = [
  { name: 'getOntologySummary', description: 'What the ontology is: its IRI, how many classes, properties and individuals it has, its top classes, imports, and whether reasoning and validation have been done.', parameters: object({}) },
  { name: 'searchEntities', description: 'Finds entities by name, IRI, synonym or description. Use it to find the IRI of anything the user names before saying anything about it.', parameters: object({ query: str('What to look for.'), kind: { type: 'string', enum: ['class', 'object property', 'data property', 'individual'], description: 'Only entities of this kind.' }, limit: { type: 'integer', description: 'At most this many (25 at most).' } }, ['query']) },
  { name: 'getEntityDetails', description: 'An entity: its kind, annotations, the axioms the ontology states about it (asserted), and for a class its superclasses (asserted and inferred), subclasses and instances.', parameters: object({ iri: IRI }, ['iri']) },
  { name: 'getClassHierarchy', description: 'A class’s place in the hierarchy: the chains of stated superclasses above it, the subclasses below it (a few levels), and the superclasses only inferred.', parameters: object({ iri: IRI, depth: { type: 'integer', description: 'How many levels below (1 to 3).' } }, ['iri']) },
  { name: 'getPropertyAxioms', description: 'A property’s axioms: domains, ranges, characteristics, super- and subproperties, inverse; and how often it is used.', parameters: object({ iri: IRI }, ['iri']) },
  { name: 'getSelectedEntity', description: 'The entity the user has selected in the editor, if any, with its details.', parameters: object({}) },
  { name: 'getRestrictions', description: 'The restrictions and class expressions a class has: those it states, and those it inherits from its superclasses by reasoning.', parameters: object({ iri: IRI }, ['iri']) },
  { name: 'getImports', description: 'The other ontologies this one imports or reuses, and whether their content is at hand.', parameters: object({}) },
  { name: 'getValidationResults', description: 'What the last validation run found: OWL consistency and unsatisfiable classes (with justifications where the reasoner gave them), SHACL and quality findings, and whether the results are out of date.', parameters: object({ category: { type: 'string', enum: ['owl', 'shacl', 'quality'], description: 'Only findings of this kind.' }, limit: { type: 'integer', description: 'At most this many findings (60 at most).' } }) },
];

/** Strict checks of a tool's arguments: an object, with these fields of these types and nothing else. */
function checked(args: unknown, fields: Record<string, 'string' | 'integer'>, required: string[] = []): Record<string, string | number> | string {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return 'The arguments have to be a JSON object.';
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const want = fields[k];
    if (!want) return `There is no argument “${k}”.`;
    if (want === 'string' && (typeof v !== 'string' || v.length > 2000)) return `“${k}” has to be text (2,000 characters at most).`;
    if (want === 'integer' && (typeof v !== 'number' || !Number.isInteger(v))) return `“${k}” has to be a whole number.`;
    out[k] = v as string | number;
  }
  for (const k of required) if (out[k] === undefined || out[k] === '') return `“${k}” is required.`;
  return out;
}

/** A tool's answer as the text the model is given: JSON, within the budget. */
export function answer(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= TOOL_BUDGET) return text;
  return JSON.stringify({ truncated: `The answer was ${text.length} characters, more than can be given at once; ask for less (a narrower search, fewer levels).`, start: text.slice(0, TOOL_BUDGET - 300) });
}

/** Runs a read-only tool. Unknown tools, wrong arguments and entities that are not there are answered as errors the model can act on. */
export function runReadTool(name: string, args: unknown, c: OntologyContext): string {
  const need = (fields: Record<string, 'string' | 'integer'>, required: string[] = []) => checked(args, fields, required);
  const entity = (a: Record<string, string | number>) => {
    const e = findEntity(c.model, String(a.iri));
    return e ?? `There is no entity “${a.iri}” in the ontology. Use searchEntities to find it; never refer to an entity that is not there.`;
  };
  const run = (): unknown => {
    switch (name) {
      case 'getOntologySummary': {
        const a = need({});
        return typeof a === 'string' ? { error: a } : summary(c);
      }
      case 'searchEntities': {
        const a = need({ query: 'string', kind: 'string', limit: 'integer' }, ['query']);
        return typeof a === 'string' ? { error: a } : search(c, String(a.query), a.kind as string | undefined, a.limit as number | undefined);
      }
      case 'getEntityDetails':
      case 'getPropertyAxioms':
      case 'getRestrictions': {
        const a = need({ iri: 'string' }, ['iri']);
        if (typeof a === 'string') return { error: a };
        const e = entity(a);
        if (typeof e === 'string') return { error: e };
        return name === 'getEntityDetails' ? details(c, e) : name === 'getPropertyAxioms' ? propertyAxioms(c, e) : restrictions(c, e);
      }
      case 'getClassHierarchy': {
        const a = need({ iri: 'string', depth: 'integer' }, ['iri']);
        if (typeof a === 'string') return { error: a };
        const e = entity(a);
        return typeof e === 'string' ? { error: e } : hierarchy(c, e, Math.min(3, Math.max(1, Number(a.depth ?? 2))));
      }
      case 'getSelectedEntity': {
        const a = need({});
        if (typeof a === 'string') return { error: a };
        const e = c.selected ? findEntity(c.model, c.selected) : undefined;
        return e ? { selected: details(c, e) } : { selected: null, note: 'Nothing is selected in the editor.' };
      }
      case 'getImports': {
        const a = need({});
        return typeof a === 'string' ? { error: a } : imports(c);
      }
      case 'getValidationResults': {
        const a = need({ category: 'string', limit: 'integer' });
        return typeof a === 'string' ? { error: a } : validationResults(c, a.category as string | undefined, a.limit as number | undefined);
      }
      default:
        return { error: `There is no tool “${name}”.` };
    }
  };
  return answer(run());
}
