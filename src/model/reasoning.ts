import { assertedSuperclasses, objectProperties } from './props';
import { entityIris, toTurtle } from './rdf';
import type { Model } from './types';
import { resolveModel } from './vocab';

/**
 * Reasoning engines. The app has two, and they answer differently on purpose.
 *
 *   fast  The app's own rule reasoner (reasoner.ts): RDFS and part of OWL 2 RL, in the page, at
 *         once. It finds the contradictions its rules reach, so finding none proves nothing.
 *   dl    HermiT, a complete OWL 2 DL reasoner. It is a Java program, so it runs in a service
 *         beside the app (reasoner/ReasonerService.java) that is given the ontology as RDF and
 *         answers with what follows from it. When it says "consistent", that is proved.
 *
 * Whatever engine it comes from, a result is said in the terms below, so that what shows results
 * does not have to know which engine made them. Results are never written into the model.
 */

export type EngineId = 'fast' | 'dl';

export interface EngineInfo {
  id: EngineId;
  label: string;
  about: string;
}

export const ENGINES: EngineInfo[] = [
  { id: 'fast', label: 'Fast reasoner (RDFS / partial OWL RL)', about: 'The app’s own rules, in the page, at once. Incomplete: it finds the contradictions its rules reach, and finding none does not prove the ontology consistent.' },
  { id: 'dl', label: 'Advanced reasoner (OWL 2 DL)', about: 'HermiT, a complete OWL 2 DL reasoner, run by the reasoning service on this machine. It works out consistency, unsatisfiable classes, the inferred hierarchy and class memberships, with justifications.' },
];

/** Where the reasoning service is, unless told otherwise. Started with `pnpm reasoner`. */
export const DEFAULT_REASONER_URL = 'http://localhost:5190';

// ---------------------------------------------------------------- what the service says

/** An entity that an axiom mentions, as the service names it. */
export interface AxiomEntity {
  iri: string;
  /** Class, ObjectProperty, DataProperty, NamedIndividual, Datatype, AnnotationProperty. */
  kind: string;
  name: string;
}

/** An asserted axiom, in Manchester syntax, with what it is about. */
export interface AxiomText {
  text: string;
  type?: string;
  entities: AxiomEntity[];
}

/** One smallest set of asserted axioms from which the conclusion follows. */
export interface Justification {
  axioms: AxiomText[];
}

export interface DlExplanation {
  kind: 'unsatisfiable' | 'inconsistent';
  /** IRI of the class, for an unsatisfiable one. */
  subject?: string;
  justifications: Justification[];
  /** Why there is no justification, when there is none. */
  note?: string;
}

export interface DlViolation {
  rule: string;
  text: string;
  entities: AxiomEntity[];
}

/** The answer of the reasoning service, as it sends it: IRIs throughout. */
export interface DlReport {
  engine: string;
  engineVersion: string;
  owlapi?: string;
  /** complete: reasoned as OWL 2 DL. partial: reasoned, with something left out or taken loosely. failed: no result. */
  status: 'complete' | 'partial' | 'failed';
  consistency: 'consistent' | 'inconsistent' | 'unknown';
  /** How long the service worked. */
  ms: number;
  axioms?: number;
  logicalAxioms?: number;
  profile?: { owl2dl: boolean; violations: DlViolation[]; violationCount: number; undeclared: string[]; undeclaredCount: number };
  imports?: { resolved: string[]; missing: string[] };
  unsatisfiable?: string[];
  /** Each class with the classes directly above it in the inferred hierarchy. */
  subclasses?: { sub: string; sup: string }[];
  equivalents?: string[][];
  /** Each individual with the most specific classes it is entailed to be an instance of. */
  types?: { individual: string; class: string }[];
  same?: string[][];
  relations?: { subject: string; property: string; object: string }[];
  explanations?: DlExplanation[];
  errors: string[];
  warnings: string[];
  /** Added here, not by the service: where it was asked, how long the round trip took, and whether it answered at all. */
  url?: string;
  roundTripMs?: number;
  unreachable?: boolean;
}

export interface DlRequest {
  ontology: string;
  imports: { iri: string; text: string }[];
  timeoutMs: number;
  explanations: { perSubject: number; max: number; timeoutMs: number };
}

export interface DlOptions {
  /** How long the reasoner may take before it is stopped. */
  timeoutMs?: number;
  /** Justifications for each unsatisfiable class or for the inconsistency; 0 asks for none. */
  justifications?: number;
  fetch?: typeof fetch;
}

/**
 * What is put to the reasoner: the ontology exactly as the app exports it, so that the answer is
 * about the same RDF another tool would be given, and the ontologies it imports as they were
 * read, each a document of its own. Nothing is simplified on the way.
 */
export function dlRequest(model: Model, imports: { iri: string; text: string }[] = [], options: DlOptions = {}): DlRequest {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return { ontology: toTurtle(model), imports, timeoutMs, explanations: { perSubject: options.justifications ?? 1, max: 25, timeoutMs: Math.min(20_000, timeoutMs) } };
}

const failed = (url: string, message: string, unreachable: boolean, t0: number): DlReport => ({
  engine: 'HermiT',
  engineVersion: '',
  status: 'failed',
  consistency: 'unknown',
  ms: 0,
  errors: [message],
  warnings: [],
  url,
  roundTripMs: Math.round(performance.now() - t0),
  unreachable,
});

/** Says how to get the service going, where it could not be reached. */
export const startHint = (url: string) => `The reasoning service did not answer at ${url}. It is a Java program that runs beside the app: start it with “pnpm reasoner” (it needs Java 11 or later) and run the reasoning again.`;

/**
 * Asks the reasoning service. It always gives a report: one that says the reasoning failed, and
 * why, when the service is not running, does not answer in time, or answers with something that
 * is not a result. A failure is never turned into "consistent".
 */
export async function askReasoner(url: string, request: DlRequest, options: DlOptions = {}): Promise<DlReport> {
  const t0 = performance.now();
  const base = url.replace(/\/+$/, '');
  const ask = options.fetch ?? fetch;
  const abort = new AbortController();
  // The service stops the reasoner itself after `timeoutMs`; this is for a service that has stopped answering.
  const timer = setTimeout(() => abort.abort(), request.timeoutMs + 15_000);
  try {
    // Sent as text so that the browser does not first have to ask whether it may: the service reads JSON either way.
    const response = await ask(base + '/reason', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(request), signal: abort.signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failed(base, `What answered at ${base} is not the reasoning service (HTTP ${response.status}).`, false, t0);
    }
    const report = body as Partial<DlReport>;
    if (!report || typeof report !== 'object' || !Array.isArray(report.errors) || !report.status || !report.consistency) return failed(base, `What answered at ${base} is not the reasoning service (HTTP ${response.status}).`, false, t0);
    return { ...(report as DlReport), warnings: report.warnings ?? [], url: base, roundTripMs: Math.round(performance.now() - t0) };
  } catch (e) {
    if (abort.signal.aborted) return failed(base, `The reasoning service at ${base} did not answer within ${Math.round((request.timeoutMs + 15_000) / 1000)} seconds.`, false, t0);
    return failed(base, startHint(base) + (e instanceof Error && e.message && !/fetch|network|load failed/i.test(e.message) ? ` (${e.message})` : ''), true, t0);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the service is there, and which reasoner it is. */
export async function reasonerHealth(url: string, ask: typeof fetch = fetch): Promise<{ ok: true; engine: string; engineVersion: string; owlapi?: string } | { ok: false; error: string }> {
  const base = url.replace(/\/+$/, '');
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 4000);
    const health = (await (await ask(base + '/health', { signal: abort.signal })).json()) as { service?: string; engine?: string; engineVersion?: string; owlapi?: string };
    clearTimeout(timer);
    if (health?.service !== 'conceptweaver-reasoner') return { ok: false, error: `What answered at ${base} is not the reasoning service.` };
    return { ok: true, engine: health.engine ?? 'HermiT', engineVersion: health.engineVersion ?? '', owlapi: health.owlapi };
  } catch {
    return { ok: false, error: startHint(base) };
  }
}

// ---------------------------------------------------------------- a result, whatever the engine

/** Something a result points to: a term or an object property of the model, or something outside it. */
export interface EntityLink {
  kind: 'term' | 'prop' | 'external';
  /** Term id, property key, or for something outside the model its IRI. */
  id: string;
  name: string;
  iri?: string;
  /** What kind of entity the reasoner took it for. */
  role?: string;
  /** How it is written in the axioms the reasoner gave: its label, in quotes when that is more than one word. */
  token?: string;
}

export interface ExplainedAxiom {
  /** The axiom in Manchester syntax. */
  text: string;
  entities: EntityLink[];
}

export interface ReasoningExplanation {
  kind: 'unsatisfiable' | 'inconsistent';
  /** The unsatisfiable class, as a term id, when it is one of the model. */
  subject?: EntityLink;
  /** Each a smallest set of asserted axioms from which the conclusion follows. */
  justifications: ExplainedAxiom[][];
  /** Why there is none, when there is none. Never a made-up explanation. */
  note?: string;
}

/** What a reasoning engine found, in the terms of the model: ids of its terms. */
export interface ReasoningResult {
  engine: { id: EngineId; name: string; version?: string };
  /** complete: the engine finished over all of the ontology. partial: with something left out. failed: no result. */
  status: 'complete' | 'partial' | 'failed';
  consistency: 'consistent' | 'inconsistent' | 'unknown';
  /** Whether "consistent" is proved (a complete reasoner that finished) or means only that nothing was found. */
  proves: boolean;
  /** Named classes that can never have a member. */
  unsatisfiableClasses: string[];
  /** Entailed "is a kind of" between named classes, every step of the way up. */
  subclasses: { subclass: string; superclass: string; asserted: boolean; direct: boolean }[];
  equivalentClasses: string[][];
  /** Entailed class memberships of individuals, every class of the way up. */
  types: { individual: string; class: string; asserted: boolean; direct: boolean }[];
  sameIndividuals: string[][];
  explanations: ReasoningExplanation[];
  errors: string[];
  warnings: string[];
  ms: number;
}

/** Finds in the model what the reasoner names by IRI. */
export function entityLinks(model: Model): (e: AxiomEntity) => EntityLink {
  const { terms, props } = entityIris(model);
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const byKey = new Map(objectProperties(model).map((p) => [p.key, p]));
  return (e) => {
    const term = terms.get(e.iri);
    if (term !== undefined && byId.has(term)) return { kind: 'term', id: term, name: byId.get(term)!.name || 'Unnamed', iri: e.iri, role: e.kind, token: e.name };
    const key = props.get(e.iri);
    if (key !== undefined && byKey.has(key)) return { kind: 'prop', id: key, name: byKey.get(key)!.name, iri: e.iri, role: e.kind, token: e.name };
    return { kind: 'external', id: e.iri, name: e.name.replace(/^'|'$/g, ''), iri: e.iri, role: e.kind, token: e.name };
  };
}

/** Reads the service's report in the terms of the model. What it says of entities that are not in the model is left out. */
export function dlResult(model: Model, report: DlReport): ReasoningResult {
  const { terms } = entityIris(model);
  const link = entityLinks(model);
  const id = (iri: string) => terms.get(iri);
  const classes = new Set(model.terms.filter((t) => t.type === 'concept').map((t) => t.id));
  const individuals = new Set(model.terms.filter((t) => t.type === 'instance').map((t) => t.id));
  const ok = report.status !== 'failed' && report.consistency === 'consistent';

  // The classes directly above each class, and from them every class above it.
  const above = new Map<string, Set<string>>();
  const equivalentClasses: string[][] = [];
  const put = (a: string, b: string) => (above.get(a) ?? above.set(a, new Set()).get(a)!).add(b);
  if (ok) {
    for (const p of report.subclasses ?? []) {
      const [a, b] = [id(p.sub), id(p.sup)];
      if (a && b && classes.has(a) && classes.has(b)) put(a, b);
    }
    for (const group of report.equivalents ?? []) {
      const ids = group.map(id).filter((x): x is string => !!x && classes.has(x));
      if (ids.length > 1) equivalentClasses.push(ids);
    }
  }
  const sameAs = new Map<string, string[]>();
  for (const group of equivalentClasses) for (const c of group) sameAs.set(c, group.filter((x) => x !== c));
  const ancestors = (start: string): Map<string, boolean> => {
    const out = new Map<string, boolean>();
    const todo: [string, boolean][] = [...(above.get(start) ?? [])].map((x): [string, boolean] => [x, true]);
    for (const e of sameAs.get(start) ?? []) todo.push([e, true]);
    while (todo.length) {
      const [c, direct] = todo.pop()!;
      if (c === start || (out.has(c) && (out.get(c) || !direct))) continue;
      out.set(c, direct || out.get(c) === true);
      for (const up of above.get(c) ?? []) todo.push([up, false]);
      for (const e of sameAs.get(c) ?? []) todo.push([e, direct]);
    }
    return out;
  };
  const subclasses: ReasoningResult['subclasses'] = [];
  for (const c of classes) {
    const stated = new Set(assertedSuperclasses(model, c));
    for (const [up, direct] of ancestors(c)) subclasses.push({ subclass: c, superclass: up, asserted: stated.has(up), direct });
  }

  const statedTypes = new Set(resolveModel(model).relations.filter((r) => r.kind === 'generalization' && individuals.has(r.from) && classes.has(r.to)).map((r) => `${r.from}|${r.to}`));
  const types: ReasoningResult['types'] = [];
  if (ok) {
    const direct = new Map<string, Set<string>>();
    for (const t of report.types ?? []) {
      const [i, c] = [id(t.individual), id(t.class)];
      if (i && c && individuals.has(i) && classes.has(c)) (direct.get(i) ?? direct.set(i, new Set()).get(i)!).add(c);
    }
    for (const [i, own] of direct) {
      const all = new Map<string, boolean>();
      for (const c of own) {
        all.set(c, true);
        for (const up of ancestors(c).keys()) if (!all.has(up)) all.set(up, false);
      }
      for (const [c, isDirect] of all) types.push({ individual: i, class: c, asserted: statedTypes.has(`${i}|${c}`), direct: isDirect });
    }
  }

  const explanations: ReasoningExplanation[] = (report.explanations ?? []).map((e) => {
    const subject = e.subject ? link({ iri: e.subject, kind: 'Class', name: e.subject }) : undefined;
    return { kind: e.kind, ...(subject ? { subject } : {}), justifications: e.justifications.map((j) => j.axioms.map((a) => ({ text: a.text, entities: a.entities.map(link) }))), ...(e.note ? { note: e.note } : {}) };
  });

  return {
    engine: { id: 'dl', name: report.engine || 'HermiT', ...(report.engineVersion ? { version: report.engineVersion } : {}) },
    status: report.status,
    consistency: report.consistency,
    // Proved only when HermiT finished over an ontology that is OWL 2 DL, all of it.
    proves: report.status === 'complete',
    unsatisfiableClasses: ok ? (report.unsatisfiable ?? []).map(id).filter((x): x is string => !!x && classes.has(x)) : [],
    subclasses,
    equivalentClasses,
    types,
    sameIndividuals: ok ? (report.same ?? []).map((g) => g.map(id).filter((x): x is string => !!x && individuals.has(x))).filter((g) => g.length > 1) : [],
    explanations,
    errors: report.errors,
    warnings: report.warnings,
    ms: report.roundTripMs ?? report.ms,
  };
}

/** What a result says of one class or individual, for showing with it. */
export function entailmentsOf(result: ReasoningResult, id: string) {
  return {
    unsatisfiable: result.unsatisfiableClasses.includes(id),
    superclasses: result.subclasses.filter((x) => x.subclass === id),
    subclasses: result.subclasses.filter((x) => x.superclass === id),
    instances: result.types.filter((x) => x.class === id),
    types: result.types.filter((x) => x.individual === id),
    equivalents: result.equivalentClasses.find((g) => g.includes(id))?.filter((x) => x !== id) ?? [],
    same: result.sameIndividuals.find((g) => g.includes(id))?.filter((x) => x !== id) ?? [],
  };
}

/** How an entailment of a reasoner other than the app's own is credited where it is shown. */
export const creditOf = (result: ReasoningResult) => `Entailed, according to ${result.engine.name}${result.engine.version ? ' ' + result.engine.version : ''} (OWL 2 DL).`;

/** Names instead of IRIs in a message of the reasoner, where the IRI is of something in the model. */
export function readable(model: Model, message: string): string {
  const { terms, props } = entityIris(model);
  const byId = new Map(model.terms.map((t) => [t.id, t.name]));
  const byKey = new Map(objectProperties(model).map((p) => [p.key, p.name]));
  return message.replace(/'?<([^<>\s]+)>'?/g, (whole, iri: string) => {
    const name = terms.has(iri) ? byId.get(terms.get(iri)!) : props.has(iri) ? byKey.get(props.get(iri)!) : undefined;
    return name ? `“${name}”` : whole;
  });
}
