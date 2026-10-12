import { Parser, Writer } from 'n3';
import { characteristicIssues } from './axioms';
import { inferredRestrictions } from './inferred';
import { compactIri, ontologyIriOf } from './prefixes';
import { objectProperties, propKey, restrictionsOf, type Restriction } from './props';
import { QUALITY_RULES, qualityDiagnostics, ruleById, ruleEnabled, type QuickFix } from './quality';
import { termIris, toTurtle } from './rdf';
import { reason } from './reasoner';
import { SH, shapesToTurtle } from './shapes';
import { stable } from './stable';
import type { Model } from './types';

/**
 * The validation workbench's model: three kinds of check that answer three different questions
 * and are never mixed up.
 *
 *   owl      Does the ontology contradict itself? Answered by the app's reasoner, with its
 *            justifications. Open world: something not stated is unknown, not wrong.
 *   shacl    Does the data have the shape it is required to have? Answered by a SHACL engine
 *            over a data graph and the shapes graph. Closed world: something missing is a violation.
 *   quality  Is the ontology well made? Rules of thumb, each of which can be switched off.
 *
 * Results live beside the model, never in it.
 */

export type Category = 'owl' | 'shacl' | 'quality';
export type Level = 'error' | 'warning' | 'info';
export type EntityType = 'class' | 'object property' | 'data property' | 'individual' | 'relationship' | 'shape' | 'ontology' | 'data';

export interface EntityRef {
  kind: 'term' | 'prop' | 'rel' | 'shape' | 'model' | 'external';
  /** Term id, property key, relation id, shape id, or for something outside the model its IRI. */
  id: string;
  name: string;
  type: EntityType;
  iri?: string;
}

/** A SHACL validation result as the standard reports it. A field the engine did not give is absent. */
export interface ShaclDetail {
  focusNode: string;
  resultPath?: string;
  value?: string;
  sourceShape: string;
  sourceConstraintComponent: string;
  resultSeverity: string;
  resultMessage: string[];
}

export interface Finding {
  id: string;
  category: Category;
  severity: Level;
  /** The rule, constraint or kind of contradiction, in words. */
  rule: string;
  ruleId: string;
  message: string;
  /** For OWL: the reasoner's own justification. For the rest: why it matters. Absent when there is none. */
  explanation?: string;
  suggestion?: string;
  entity?: EntityRef;
  /** The property or axiom concerned, as text. */
  property?: string;
  /** Terms and relationships to spotlight on the canvas. */
  terms: string[];
  rels: string[];
  shacl?: ShaclDetail;
  /** The editable shape a SHACL result comes from, when it is one. */
  shapeId?: string;
  fix?: QuickFix;
}

export interface OwlSummary {
  /** not-applicable: a SKOS concept scheme has no OWL semantics to contradict. */
  status: 'consistent' | 'inconsistent' | 'not-applicable';
  contradictions: number;
  unsatisfiable: string[];
  asserted: number;
  inferred: number;
  /** The reasoner stopped early, so "consistent" means "no contradiction found so far". */
  partial: boolean;
  profile: string;
  ms: number;
}

export interface ShaclSummary {
  /** skipped: there were no shapes. failed: the shapes or data could not be read, or the engine gave up. */
  status: 'conforms' | 'violations' | 'skipped' | 'failed';
  error?: string;
  violations: number;
  warnings: number;
  infos: number;
  shapes: number;
  dataTriples: number;
  dataSource: string;
  includesOntology: boolean;
  /** The standard validation report, as Turtle. */
  report?: string;
  ms: number;
}

export interface QualitySummary {
  errors: number;
  warnings: number;
  suggestions: number;
  rulesOn: number;
  rulesTotal: number;
  ms: number;
}

export interface ValidationRun {
  at: number;
  /** A fingerprint of what was validated: the ontology as RDF, the shapes and the rule settings. */
  revision: string;
  /** The model that was validated; results are stale once the editor holds another. */
  model: Model;
  data: DataGraph;
  entities: number;
  owl?: OwlSummary;
  shacl?: ShaclSummary;
  quality?: QualitySummary;
  findings: Finding[];
}

/** What SHACL validates: the model's own RDF, or RDF brought in for the purpose. */
export interface DataGraph {
  source: 'model' | 'imported';
  /** For imported data: its file name and Turtle. It is not part of the model and is not saved with it. */
  name?: string;
  text?: string;
  /** For imported data: also give the engine the ontology's triples, so that subclasses count. */
  includeOntology: boolean;
}

export const MODEL_DATA: DataGraph = { source: 'model', includeOntology: true };

const q = (s: string) => `“${s}”`;

/** A short fingerprint of text (FNV-1a), to tell revisions apart at a glance. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- entities

function entityIndex(model: Model) {
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const typeOf = (t: { type: string }): EntityType => (t.type === 'concept' ? 'class' : t.type === 'property' ? 'data property' : 'individual');
  const term = (id: string): EntityRef | undefined => {
    const t = byId.get(id);
    return t ? { kind: 'term', id, name: t.name || 'Unnamed', type: typeOf(t), iri: t.iri } : undefined;
  };
  const prop = (key: string): EntityRef | undefined => {
    const p = model.props.find((x) => propKey(x.name) === key);
    return p ? { kind: 'prop', id: key, name: p.name, type: 'object property', iri: p.iri } : undefined;
  };
  const rel = (id: string): EntityRef | undefined => {
    const r = model.relations.find((x) => x.id === id);
    return r ? { kind: 'rel', id, name: `${byId.get(r.from)?.name || 'Unnamed'} → ${byId.get(r.to)?.name || 'Unnamed'}`, type: 'relationship' } : undefined;
  };
  const shape = (id: string): EntityRef | undefined => {
    const s = model.shapes.nodes.find((x) => x.id === id);
    return s ? { kind: 'shape', id, name: s.name || 'Shape', type: 'shape', iri: s.iri } : undefined;
  };
  const ontology: EntityRef = { kind: 'model', id: 'model', name: model.name, type: 'ontology', iri: ontologyIriOf(model) };
  return { term, prop, rel, shape, ontology, byId };
}

// ---------------------------------------------------------------- OWL

/** The rules the app's reasoner applies, for saying honestly what a "consistent" covers. */
export const REASONER_PROFILE = 'RDFS and a subset of OWL 2 RL: class and property hierarchies, equivalence, disjointness and complements, domains and ranges, inverse, symmetric, transitive, functional and inverse-functional properties, sameAs and differentFrom';
export const REASONER_LIMITS = [
  'It is a rule reasoner, not a complete OWL 2 DL reasoner: it finds the contradictions its rules reach, so “consistent” means none of those was found.',
  'Class expressions kept as text (unions, intersections, complements written as expressions, nested restrictions) are not interpreted.',
  'Restrictions are compared only when they are on the same property and the same class or datatype; a clash that needs the fillers’ hierarchy is not found.',
  'Literal values are compared as written: "1" and "01" count as two values.',
];

/**
 * Logical findings. Contradictions and unsatisfiable classes come from the reasoner, each with
 * the stated facts it rests on. Two further checks read what is asserted directly: restrictions
 * that cannot hold together, and property characteristics that exclude each other.
 */
export function owlFindings(model: Model, fresh = false): { summary: OwlSummary; findings: Finding[] } {
  const t0 = performance.now();
  const findings: Finding[] = [];
  const ix = entityIndex(model);
  if (model.mode === 'skos') {
    return { summary: { status: 'not-applicable', contradictions: 0, unsatisfiable: [], asserted: 0, inferred: 0, partial: false, profile: REASONER_PROFILE, ms: 0 }, findings };
  }
  const reasoning = reason(model, fresh);
  const unsatisfiable = new Set(reasoning.unsatisfiable);
  reasoning.conflicts.forEach((c, n) => {
    const inconsistent = c.severity === 'error';
    findings.push({
      id: `owl:${n}`,
      category: 'owl',
      severity: 'error',
      rule: inconsistent ? 'Inconsistent ontology' : 'Unsatisfiable class',
      ruleId: inconsistent ? 'owl-inconsistent' : 'owl-unsatisfiable',
      message: c.message,
      explanation: `The reasoner derives this from: ${c.because}`,
      entity: c.terms.map(ix.term).find(Boolean),
      terms: c.terms.filter((id) => ix.byId.has(id)),
      rels: c.rels,
      suggestion: inconsistent ? 'One of the statements it rests on has to go; which one is a modelling decision.' : 'The class can exist but can never have a member. Remove one of the statements it rests on, unless that is intended.',
    });
  });

  // Restrictions that cannot hold together make a class unsatisfiable. From a contradiction
  // anything follows, so this is only worth saying of a consistent ontology.
  if (reasoning.consistent) {
    for (const t of model.terms) {
      if (t.type !== 'concept') continue;
      const own = restrictionsOf(model, t.id).map((r) => ({ r, from: t.name || 'Unnamed' }));
      const inherited = own.length || reasoning.superclasses(t.id).length ? inferredRestrictions(model, t.id).restrictions.map((x) => ({ r: x.restriction, from: x.sources[0]?.name ?? '' })) : [];
      const groups = new Map<string, { r: Restriction; from: string }[]>();
      for (const x of [...own, ...inherited]) {
        const k = `${x.r.data}|${x.r.data ? x.r.rel.to : propKey(x.r.rel.label)}|${x.r.rel.to}`;
        groups.set(k, [...(groups.get(k) ?? []), x]);
      }
      for (const list of groups.values()) {
        let low: { n: number; x: (typeof list)[number] } | undefined;
        let high: { n: number; x: (typeof list)[number] } | undefined;
        for (const x of list) {
          const { quantifier, n } = x.r;
          const atLeast = quantifier === 'some' ? 1 : quantifier === 'min' || quantifier === 'exactly' ? n : undefined;
          const atMost = quantifier === 'max' || quantifier === 'exactly' ? n : undefined;
          if (atLeast !== undefined && (!low || atLeast > low.n)) low = { n: atLeast, x };
          if (atMost !== undefined && (!high || atMost < high.n)) high = { n: atMost, x };
        }
        if (!low || !high || low.n <= high.n) continue;
        unsatisfiable.add(t.id);
        const say = (x: (typeof list)[number]) => `${q(x.r.text)}${x.from === (t.name || 'Unnamed') ? '' : `, inherited from ${q(x.from)}`}`;
        findings.push({
          id: `owl:r:${t.id}:${low.x.r.rel.id}:${high.x.r.rel.id}`,
          category: 'owl',
          severity: 'error',
          rule: 'Incompatible restrictions',
          ruleId: 'owl-restrictions',
          message: `${q(t.name)} can never have instances: it needs at least ${low.n} and at most ${high.n} values of ${q(low.x.r.property)} in ${q(low.x.r.filler)}.`,
          explanation: `Both are asserted: ${say(low.x)}; and ${say(high.x)}.`,
          entity: ix.term(t.id),
          property: low.x.r.property,
          terms: [t.id],
          rels: [...new Set([low.x.r.rel.id, high.x.r.rel.id])],
          suggestion: 'Change one of the two restrictions. Which one is a modelling decision.',
        });
      }
    }
  }

  for (const p of objectProperties(model)) {
    characteristicIssues(p.chars).forEach((issue, n) => {
      const profile = issue.includes('OWL 2 DL');
      findings.push({
        id: `owl:c:${p.key}:${n}`,
        category: 'owl',
        severity: 'warning',
        rule: profile ? 'Outside OWL 2 DL' : 'Conflicting property characteristics',
        ruleId: profile ? 'owl-profile' : 'owl-characteristics',
        message: `${q(p.name)}: ${issue}`,
        explanation: profile ? 'This does not make the ontology inconsistent; it puts it outside the OWL 2 DL profile.' : 'This is not a contradiction by itself: it becomes one as soon as the property is used in a way the characteristics exclude.',
        entity: ix.prop(p.key),
        property: p.name,
        terms: [],
        rels: p.rels.map((r) => r.id).slice(0, 50),
      });
    });
  }

  const contradictions = reasoning.conflicts.filter((c) => c.severity === 'error').length;
  return {
    summary: {
      status: reasoning.consistent ? 'consistent' : 'inconsistent',
      contradictions,
      unsatisfiable: [...unsatisfiable],
      asserted: reasoning.asserted,
      inferred: reasoning.inferred,
      partial: reasoning.truncated,
      profile: REASONER_PROFILE,
      ms: Math.round(performance.now() - t0),
    },
    findings,
  };
}

// ---------------------------------------------------------------- quality

export function qualityFindings(model: Model): { summary: QualitySummary; findings: Finding[] } {
  const t0 = performance.now();
  const ix = entityIndex(model);
  const findings = qualityDiagnostics(model).map((d, n): Finding => {
    const rule = ruleById(d.rule)!;
    const entity = (d.shape ? ix.shape(d.shape) : undefined) ?? d.terms.map(ix.term).find(Boolean) ?? (d.prop ? ix.prop(d.prop) : undefined) ?? d.rels.map(ix.rel).find(Boolean) ?? (d.model ? ix.ontology : undefined);
    return {
      id: `quality:${d.rule}:${n}`,
      category: 'quality',
      severity: d.severity,
      rule: rule.label,
      ruleId: rule.id,
      message: d.message,
      explanation: d.explanation ?? rule.about,
      suggestion: d.suggestion,
      entity,
      terms: d.terms,
      rels: d.rels,
      shapeId: d.shape,
      fix: d.fix,
    };
  });
  const count = (s: Level) => findings.filter((f) => f.severity === s).length;
  return {
    summary: { errors: count('error'), warnings: count('warning'), suggestions: count('info'), rulesOn: QUALITY_RULES.filter((r) => ruleEnabled(model.quality, r)).length, rulesTotal: QUALITY_RULES.length, ms: Math.round(performance.now() - t0) },
    findings,
  };
}

// ---------------------------------------------------------------- SHACL

interface RdfTerm {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

/** What the SHACL engine supports, said as it is. */
export const SHACL_ENGINE = {
  name: 'rdf-validate-shacl',
  supports: 'SHACL Core: every Core target, property path and constraint component',
  not: ['SHACL-SPARQL constraints and SPARQL targets (sh:sparql, sh:SPARQLTarget): shapes using them are read but those parts are not checked.', 'SHACL Advanced Features (rules, functions, node expressions).', 'Entailment regimes (sh:entailment): the data graph is validated as given. The only inference is the one SHACL itself prescribes, rdfs:subClassOf for class targets and sh:class.'],
};

const SEVERITY: Record<string, Level> = { Violation: 'error', Warning: 'warning', Info: 'info' };

/**
 * Validates a data graph against the model's shapes with a SHACL Core engine. The ontology
 * graph, the shapes graph and the data graph are three things: the shapes graph is the model's
 * shapes and nothing else; the data graph is what `data` names.
 */
export async function shaclFindings(model: Model, data: DataGraph = MODEL_DATA): Promise<{ summary: ShaclSummary; findings: Finding[] }> {
  const t0 = performance.now();
  const ix = entityIndex(model);
  const dataSource = data.source === 'model' ? 'This model' : (data.name ?? 'Imported data');
  const includesOntology = data.source === 'model' || data.includeOntology;
  const base: ShaclSummary = { status: 'skipped', violations: 0, warnings: 0, infos: 0, shapes: 0, dataTriples: 0, dataSource, includesOntology, ms: 0 };
  const done = (s: Partial<ShaclSummary>, findings: Finding[] = []) => ({ summary: { ...base, ...s, ms: Math.round(performance.now() - t0) }, findings });

  const shapesTtl = shapesToTurtle(model);
  if (!shapesTtl.trim()) return done({ status: 'skipped' });
  let shapeQuads: unknown[];
  let dataQuads: unknown[];
  try {
    shapeQuads = new Parser().parse(shapesTtl);
  } catch (e) {
    return done({ status: 'failed', error: `The shapes could not be read: ${e instanceof Error ? e.message : 'not valid Turtle'}` });
  }
  try {
    const ontology = includesOntology ? new Parser().parse(toTurtle(model)) : [];
    const own = data.source === 'imported' ? new Parser().parse(data.text ?? '') : [];
    dataQuads = [...ontology, ...own];
  } catch (e) {
    return done({ status: 'failed', error: `The data could not be read: ${e instanceof Error ? e.message : 'not valid Turtle'}` });
  }
  const shapeSubjects = new Set((shapeQuads as { subject: RdfTerm; predicate: RdfTerm; object: RdfTerm }[]).filter((x) => x.predicate.value.endsWith('#type') && x.object.value === SH + 'NodeShape').map((x) => x.subject.value));

  try {
    // Loaded when first needed: the engine is not part of the page until someone validates with SHACL.
    const { rdf, SHACLValidator } = await import('./shaclEngine');
    const shapes = rdf.dataset(shapeQuads as never);
    const validator = new SHACLValidator(shapes, { factory: rdf });
    const report = await validator.validate(rdf.dataset(dataQuads as never));

    const iriToTerm = termIris(model);
    const iriToProp = new Map(model.props.filter((p) => p.iri).map((p) => [p.iri!, propKey(p.name)]));
    const shapeByIri = new Map(model.shapes.nodes.map((s) => [s.iri, s]));
    // A property shape is usually a blank node; the node shape that holds it says where it is from.
    const parent = new Map<string, string>();
    for (const x of shapeQuads as { subject: RdfTerm; predicate: RdfTerm; object: RdfTerm }[]) if (x.predicate.value === SH + 'property') parent.set(x.object.value, x.subject.value);
    const short = (iri: string) => compactIri(model, iri) ?? (iri.startsWith(SH) ? 'sh:' + iri.slice(SH.length) : `<${iri}>`);
    const show = (t: RdfTerm) => (t.termType === 'Literal' ? JSON.stringify(t.value) + (t.language ? '@' + t.language : '') : t.termType === 'BlankNode' ? '_:' + t.value : short(t.value));

    const findings: Finding[] = (report.results as unknown as { focusNode?: RdfTerm; path?: RdfTerm; value?: RdfTerm; sourceShape?: RdfTerm; sourceConstraintComponent?: RdfTerm; severity?: RdfTerm; message: RdfTerm[] }[]).map((r, n): Finding => {
      const focus = r.focusNode;
      const focusIri = focus?.termType === 'NamedNode' ? focus.value : undefined;
      const termId = focusIri ? iriToTerm.get(focusIri) : undefined;
      const propKeyOf = focusIri ? iriToProp.get(focusIri) : undefined;
      const entity: EntityRef | undefined = termId ? ix.term(termId) : propKeyOf ? ix.prop(propKeyOf) : focus ? { kind: 'external', id: focus.value, name: show(focus), type: 'data', iri: focusIri } : undefined;
      const level = SEVERITY[r.severity?.value.slice(SH.length) ?? 'Violation'] ?? 'error';
      const component = r.sourceConstraintComponent?.value ?? '';
      const source = r.sourceShape;
      const owner = source ? (source.termType === 'BlankNode' ? parent.get(source.value) : source.value) : undefined;
      const shape = owner ? shapeByIri.get(owner) : undefined;
      const path = r.path?.termType === 'NamedNode' ? r.path.value : undefined;
      const messages = r.message.map((m) => m.value);
      return {
        id: `shacl:${n}`,
        category: 'shacl',
        severity: level,
        rule: component.startsWith(SH) ? component.slice(SH.length).replace(/ConstraintComponent$/, '') : component,
        ruleId: component,
        // The engine's own message, or the shape's; nothing is made up when there is none.
        message: messages.join(' ') || `Does not conform to ${short(component)}.`,
        entity,
        property: path ? short(path) : r.path ? 'a property path' : undefined,
        terms: termId ? [termId] : [],
        rels: [],
        shapeId: shape?.id,
        shacl: {
          focusNode: focus ? show(focus) : '',
          ...(r.path ? { resultPath: path ? short(path) : '(a path that is not a single property)' } : {}),
          ...(r.value ? { value: show(r.value) } : {}),
          sourceShape: source ? (source.termType === 'BlankNode' ? `a property shape${owner ? ` of ${short(owner)}` : ''}` : short(source.value)) : '',
          sourceConstraintComponent: component ? short(component) : '',
          resultSeverity: r.severity ? short(r.severity.value) : '',
          resultMessage: messages,
        },
      };
    });

    let reportTtl = '';
    const writer = new Writer({ prefixes: { sh: SH, xsd: 'http://www.w3.org/2001/XMLSchema#', '': model.baseIri || undefined } as never });
    writer.addQuads([...report.dataset] as never);
    writer.end((_e: unknown, result: string) => (reportTtl = result));
    const count = (l: Level) => findings.filter((f) => f.severity === l).length;
    return done({ status: report.conforms ? 'conforms' : 'violations', violations: count('error'), warnings: count('warning'), infos: count('info'), shapes: shapeSubjects.size, dataTriples: dataQuads.length, report: reportTtl }, findings);
  } catch (e) {
    return done({ status: 'failed', error: `The SHACL engine stopped: ${e instanceof Error ? e.message : 'unknown error'}`, shapes: shapeSubjects.size, dataTriples: dataQuads.length });
  }
}

// ---------------------------------------------------------------- running and reporting

export type Scope = 'all' | Category;

/** What a run covers, as a fingerprint: the same content always gives the same one. */
export function revisionOf(model: Model, data: DataGraph): string {
  return fingerprint(toTurtle(model) + '\n' + shapesToTurtle(model) + '\n' + JSON.stringify(model.quality) + '\n' + JSON.stringify(model.governance) + '\n' + (data.source === 'imported' ? (data.text ?? '') + data.includeOntology : ''));
}

/** Whether results no longer describe what is in the editor. Moving terms on the canvas does not count. */
export function isStale(run: ValidationRun | null, model: Model, data: DataGraph): boolean {
  return !!run && (run.model !== stable(model) || run.data !== data);
}

/**
 * Runs the checks in `scope` and gives a run. Parts outside the scope are carried over from
 * `previous` when that was of the very same model and data; otherwise they are left out rather
 * than shown as if they were current. `tick` is awaited between parts so the page can redraw.
 */
export async function validate(model: Model, data: DataGraph, scope: Scope, previous: ValidationRun | null, tick: (phase: string) => Promise<void> = async () => {}, withImports?: Model): Promise<ValidationRun> {
  const subject = stable(model);
  const keep = previous && previous.model === subject && previous.data === data ? previous : null;
  const run: ValidationRun = { at: Date.now(), revision: '', model: subject, data, entities: model.terms.length + model.props.length, owl: keep?.owl, shacl: keep?.shacl, quality: keep?.quality, findings: keep ? keep.findings.filter((f) => scope !== 'all' && f.category !== scope) : [] };
  const wants = (c: Category) => scope === 'all' || scope === c;
  if (wants('owl')) {
    await tick('Reasoning…');
    // An ontology that imports others is consistent only together with them, so they are reasoned over as one.
    const r = owlFindings(withImports ?? model, true);
    run.owl = r.summary;
    run.findings.push(...r.findings);
  }
  if (wants('quality')) {
    await tick('Checking quality rules…');
    const r = qualityFindings(model);
    run.quality = r.summary;
    run.findings.push(...r.findings);
  }
  if (wants('shacl')) {
    await tick('Validating against the shapes…');
    const r = await shaclFindings(model, data);
    run.shacl = r.summary;
    run.findings.push(...r.findings);
  }
  await tick('');
  run.revision = revisionOf(model, data);
  const rank: Record<Level, number> = { error: 0, warning: 1, info: 2 };
  const order: Record<Category, number> = { owl: 0, shacl: 1, quality: 2 };
  run.findings.sort((a, b) => rank[a.severity] - rank[b.severity] || order[a.category] - order[b.category]);
  return run;
}

const CATEGORY_LABEL: Record<Category, string> = { owl: 'OWL', shacl: 'SHACL', quality: 'Quality' };
export const categoryLabel = (c: Category) => CATEGORY_LABEL[c];

/** The run as JSON: everything shown, without the model itself. */
export function reportJson(run: ValidationRun, model: Model): string {
  const { model: _m, data, findings, shacl, ...rest } = run;
  return JSON.stringify(
    {
      ontology: { name: model.name, iri: ontologyIriOf(model) },
      validatedAt: new Date(run.at).toISOString(),
      ...rest,
      at: undefined,
      shacl: shacl ? { ...shacl, report: undefined } : undefined,
      dataGraph: { source: data.source, name: data.name, includesOntologyTriples: data.source === 'model' || data.includeOntology },
      findings: findings.map(({ fix, id: _id, ...f }) => ({ ...f, category: CATEGORY_LABEL[f.category], ...(fix ? { quickFix: fix.label } : {}) })),
    },
    null,
    2,
  );
}

/**
 * The run as RDF. SHACL results are the engine's own sh:ValidationReport, untouched. OWL and
 * quality findings are not SHACL results and are not dressed up as them: they are written with
 * a small vocabulary of the app's own.
 */
export function reportTurtle(run: ValidationRun, model: Model): string {
  const CW = 'https://conceptweaver.app/validation#';
  const lit = (s: string) => JSON.stringify(s);
  const node = (f: Finding) => (f.entity?.iri ? `<${f.entity.iri}>` : undefined);
  const own = run.findings.filter((f) => f.category !== 'shacl');
  const lines = [
    `@prefix cw: <${CW}> .`,
    '@prefix dcterms: <http://purl.org/dc/terms/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    '[] a cw:ValidationRun ;',
    `    cw:ontology <${ontologyIriOf(model)}> ;`,
    `    dcterms:created "${new Date(run.at).toISOString()}"^^xsd:dateTime ;`,
    `    cw:revision ${lit(run.revision)}${run.owl ? ` ;\n    cw:owlStatus ${lit(run.owl.status)} ;\n    cw:unsatisfiableClasses ${run.owl.unsatisfiable.length}` : ''}${own.length ? ' ;\n    cw:finding' : ' .'}`,
    ...own.map(
      (f, i) =>
        `        [ a cw:Finding ; cw:category ${lit(CATEGORY_LABEL[f.category])} ; cw:severity ${lit(f.severity)} ; cw:rule ${lit(f.rule)} ; cw:message ${lit(f.message)}${f.explanation ? ` ; cw:explanation ${lit(f.explanation)}` : ''}${node(f) ? ` ; cw:entity ${node(f)}` : ''} ]${i === own.length - 1 ? ' .' : ' ,'}`,
    ),
  ];
  return lines.join('\n') + '\n' + (run.shacl?.report ? '\n# ---- SHACL validation report, as the engine produced it\n\n' + run.shacl.report : '');
}
