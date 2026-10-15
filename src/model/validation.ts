import { Parser, Writer } from 'n3';
import { characteristicIssues } from './axioms';
import { inferredRestrictions } from './inferred';
import { compactIri, ontologyIriOf } from './prefixes';
import { nameKey } from './identity';
import { objectProperties, restrictionsOf, type Restriction } from './props';
import { QUALITY_RULES, qualityDiagnostics, ruleById, ruleEnabled, type QuickFix } from './quality';
import { termIris, toTurtle } from './rdf';
import { reason, type Reasoning } from './reasoner';
import { dlResult, entityLinks, readable, type DlReport, type EntityLink, type ReasoningResult } from './reasoning';
import { MODEL_DATA, type Category, type DataGraph, type EntityRef, type EntityType, type Finding, type JustifiedEntity, type Level, type OntologyRef, type OwlSummary, type QualitySummary, type Scope, type ShaclSummary, type ValidationReport } from '../validation/contracts';
import { SH, shapesToTurtle } from './shapes';
import type { Model } from './types';
import { quoted, quotedName } from './words';

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

export type { Category, DataGraph, EntityRef, EntityType, Finding, JustifiedEntity, Level, OwlSummary, QualitySummary, ShaclDetail, ShaclSummary, ValidationReport } from '../validation/contracts';
export { MODEL_DATA } from '../validation/contracts';

/** A run of the checks: what a validation job reports. */
export type ValidationRun = ValidationReport;


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
  const prop = (id: string): EntityRef | undefined => {
    const p = model.props.find((x) => x.id === id);
    return p ? { kind: 'prop', id, name: p.name, type: 'object property', iri: p.iri } : undefined;
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

export const FAST_ENGINE_NAME = 'Fast reasoner';

/** The rules the app's reasoner applies, for saying honestly what a "consistent" covers. */
export const REASONER_PROFILE = 'RDFS and a subset of OWL 2 RL: class and property hierarchies, equivalence, disjointness and complements, domains and ranges, inverse, symmetric, transitive, functional and inverse-functional properties, sameAs and differentFrom, enumerations (owl:oneOf) and owl:AllDifferent';

/**
 * Logical findings. Contradictions and unsatisfiable classes come from the reasoner, each with
 * the stated facts it rests on. Two further checks read what is asserted directly: restrictions
 * that cannot hold together, and property characteristics that exclude each other.
 */
export function owlFindings(model: Model, fresh = false, given?: Reasoning): { summary: OwlSummary; findings: Finding[] } {
  // The count in the header, the Structure Explorer and anything else that asks about the model as it
  // is are given the one answer. A run of the workbench asks afresh. Given the reasoner's answer
  // (from its job), it is not asked again.
  const kept = fresh ? undefined : owlFound.get(model);
  if (kept && (!given || kept.reasoning === given)) return kept.result;
  const reasoning = given ?? reason(model, fresh);
  const result = findOwl(model, reasoning);
  owlFound.set(model, { reasoning, result });
  return result;
}

const owlFound = new WeakMap<Model, { reasoning: Reasoning; result: { summary: OwlSummary; findings: Finding[] } }>();

function findOwl(model: Model, reasoning: Reasoning): { summary: OwlSummary; findings: Finding[] } {
  const t0 = performance.now();
  const findings: Finding[] = [];
  const ix = entityIndex(model);
  if (model.mode === 'skos') {
    return { summary: { engine: 'fast', engineName: FAST_ENGINE_NAME, status: 'not-applicable', proved: false, contradictions: 0, unsatisfiable: [], asserted: 0, inferred: 0, partial: false, profile: REASONER_PROFILE, ms: 0 }, findings };
  }
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
      const inherited = own.length || reasoning.superclasses(t.id).length ? inferredRestrictions(model, reasoning, t.id).restrictions.map((x) => ({ r: x.restriction, from: x.sources[0]?.name ?? '' })) : [];
      const groups = new Map<string, { r: Restriction; from: string }[]>();
      for (const x of [...own, ...inherited]) {
        const k = `${x.r.data}|${x.r.data ? x.r.rel.to : (x.r.rel.prop ?? nameKey(x.r.rel.label))}|${x.r.rel.to}`;
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
        const say = (x: (typeof list)[number]) => `${quoted(x.r.text)}${x.from === (t.name || 'Unnamed') ? '' : `, inherited from ${quoted(x.from)}`}`;
        findings.push({
          id: `owl:r:${t.id}:${low.x.r.rel.id}:${high.x.r.rel.id}`,
          category: 'owl',
          severity: 'error',
          rule: 'Incompatible restrictions',
          ruleId: 'owl-restrictions',
          message: `${quoted(t.name)} can never have instances: it needs at least ${low.n} and at most ${high.n} values of ${quoted(low.x.r.property)} in ${quoted(low.x.r.filler)}.`,
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
        id: `owl:c:${p.id}:${n}`,
        category: 'owl',
        severity: 'warning',
        rule: profile ? 'Outside OWL 2 DL' : 'Conflicting property characteristics',
        ruleId: profile ? 'owl-profile' : 'owl-characteristics',
        message: `${quoted(p.name)}: ${issue}`,
        explanation: profile ? 'This does not make the ontology inconsistent; it puts it outside the OWL 2 DL profile.' : 'This is not a contradiction by itself: it becomes one as soon as the property is used in a way the characteristics exclude.',
        entity: ix.prop(p.id),
        property: p.name,
        terms: [],
        rels: p.rels.map((r) => r.id).slice(0, 50),
      });
    });
  }

  const contradictions = reasoning.conflicts.filter((c) => c.severity === 'error').length;
  return {
    summary: {
      engine: 'fast',
      engineName: FAST_ENGINE_NAME,
      status: reasoning.consistent ? 'consistent' : 'inconsistent',
      // A rule reasoner that finds nothing has not proved there is nothing.
      proved: false,
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

// ---------------------------------------------------------------- OWL 2 DL


export const DL_PROFILE = 'OWL 2 DL, by a complete reasoner: every class expression and restriction the ontology states, property characteristics and hierarchies, individuals, and the datatypes of the OWL 2 datatype map';

const ROLE: Record<string, EntityType> = { Class: 'class', ObjectProperty: 'object property', DataProperty: 'data property', NamedIndividual: 'individual' };

/**
 * The findings of the OWL 2 DL reasoner. Everything here is what the reasoner answered: the
 * verdict on consistency, the classes it found unsatisfiable, and for each the justification it
 * gave. Where it gave no answer, the status is "unknown" and nothing is reported as consistent.
 */
export function dlFindings(model: Model, report: DlReport): { summary: OwlSummary; findings: Finding[]; result: ReasoningResult } {
  const ix = entityIndex(model);
  const result = dlResult(model, report);
  const link = entityLinks(model);
  const engineName = `${report.engine || 'HermiT'}${report.engineVersion ? ' ' + report.engineVersion : ''}`;
  const findings: Finding[] = [];
  const say = (text: string) => readable(model, text);
  const ref = (e: EntityLink): JustifiedEntity => ({
    ...((e.kind === 'term' ? ix.term(e.id) : e.kind === 'prop' ? ix.prop(e.id) : undefined) ?? { kind: 'external', id: e.id, name: e.name, type: ROLE[e.role ?? ''] ?? 'data', iri: e.iri }),
    ...(e.token ? { token: e.token } : {}),
  });
  const termsOf = (list: { entities: EntityRef[] }[]) => [...new Set(list.flatMap((a) => a.entities.filter((e) => e.kind === 'term').map((e) => e.id)))];
  const justified = (x: { justifications: { text: string; entities: EntityLink[] }[][]; note?: string } | undefined) => {
    const justifications = (x?.justifications ?? []).map((j) => j.map((a) => ({ text: a.text, entities: a.entities.map(ref) })));
    return {
      justifications,
      ...(justifications.length ? {} : { justificationNote: x?.note ?? 'The reasoner was not asked for a justification of this.' }),
      // In words, for the report and for searching: the axioms of the first justification.
      ...(justifications.length ? { explanation: `${engineName} derives this from ${justifications[0].length === 1 ? 'one asserted axiom' : `${justifications[0].length} asserted axioms`}: ${justifications[0].map((a) => a.text).join('; ')}.` } : {}),
    };
  };

  if (report.status === 'failed') {
    report.errors.forEach((e, n) =>
      findings.push({ id: `owl:dl:failed:${n}`, category: 'owl', severity: 'warning', rule: 'Reasoning did not finish', ruleId: 'dl-failed', message: say(e), entity: ix.ontology, terms: [], rels: [], engine: engineName, suggestion: report.unreachable ? undefined : 'Until this is resolved the OWL 2 DL reasoner has no answer for this ontology. The fast reasoner can still be run, for what its rules reach.' }),
    );
  }
  if (report.consistency === 'inconsistent') {
    const x = result.explanations.find((e) => e.kind === 'inconsistent');
    const j = justified(x);
    findings.push({
      id: 'owl:dl:inconsistent',
      category: 'owl',
      severity: 'error',
      rule: 'Inconsistent ontology',
      ruleId: 'owl-inconsistent',
      message: 'The ontology is inconsistent: what it states cannot all be true at once. From a contradiction everything follows, so no hierarchy or class membership is inferred from it.',
      entity: j.justifications[0]?.flatMap((a) => a.entities).find((e) => e.type === 'individual') ?? ix.ontology,
      terms: termsOf(j.justifications[0] ?? []),
      rels: [],
      engine: engineName,
      suggestion: 'One of the axioms it rests on has to go; which one is a modelling decision.',
      ...j,
    });
  }
  for (const id of result.unsatisfiableClasses) {
    const t = ix.byId.get(id)!;
    const x = result.explanations.find((e) => e.kind === 'unsatisfiable' && e.subject?.kind === 'term' && e.subject.id === id);
    const j = justified(x);
    findings.push({
      id: `owl:dl:unsat:${id}`,
      category: 'owl',
      severity: 'error',
      rule: 'Unsatisfiable class',
      ruleId: 'owl-unsatisfiable',
      message: `${quotedName(t)} can never have an instance: it is a subclass of owl:Nothing.`,
      entity: ix.term(id),
      terms: [...new Set([id, ...termsOf(j.justifications[0] ?? [])])],
      rels: [],
      engine: engineName,
      suggestion: 'The class can exist, and the ontology is still consistent as long as nothing is stated to be an instance of it. Change one of the axioms it rests on, unless this is intended.',
      ...j,
    });
  }
  // What puts the ontology outside OWL 2 DL: the reasoner's answer is then not guaranteed, or not given at all.
  (report.profile?.violations ?? []).forEach((v, n) => {
    const entities = v.entities.map((e) => ref(link(e)));
    findings.push({
      id: `owl:dl:profile:${n}`,
      category: 'owl',
      severity: 'warning',
      rule: 'Outside OWL 2 DL',
      ruleId: 'owl-profile',
      message: `${v.rule}${v.text ? `: ${v.text}` : ''}.`,
      explanation: 'OWL 2 DL does not allow this, because with it reasoning is no longer decidable. A reasoner may refuse the ontology or answer incompletely.',
      entity: entities.find((e) => e.kind !== 'external') ?? ix.ontology,
      terms: entities.filter((e) => e.kind === 'term').map((e) => e.id),
      rels: [],
      engine: engineName,
    });
  });

  const notes = report.warnings.map(say);
  const undeclared = report.profile?.undeclaredCount ?? 0;
  if (undeclared) notes.push(`${undeclared} ${undeclared === 1 ? 'entity is' : 'entities are'} used without being declared (${(report.profile?.undeclared ?? []).slice(0, 4).join(', ')}${undeclared > 4 ? '…' : ''}). Each was read as what its use implies, which changes no axiom.`);
  const inferred = result.subclasses.filter((x) => !x.asserted).length + result.types.filter((x) => !x.asserted).length + result.relations.filter((x) => !x.asserted).length;
  return {
    summary: {
      engine: 'dl',
      engineName,
      status: report.consistency,
      proved: result.proves && report.consistency === 'consistent',
      contradictions: report.consistency === 'inconsistent' ? 1 : 0,
      unsatisfiable: result.unsatisfiableClasses,
      asserted: report.logicalAxioms ?? 0,
      inferred,
      partial: report.status === 'partial',
      profile: DL_PROFILE,
      ms: report.roundTripMs ?? report.ms,
      ...(report.status === 'failed' ? { errors: report.errors.map(say) } : {}),
      ...(notes.length ? { notes } : {}),
    },
    findings,
    result,
  };
}

// ---------------------------------------------------------------- quality

/** A finding as the checks give it where they run: a quick fix can be applied there, to the model it was found in. */
export type FixableFinding = Finding & { fix?: QuickFix };

export function qualityFindings(model: Model): { summary: QualitySummary; findings: FixableFinding[] } {
  const t0 = performance.now();
  const ix = entityIndex(model);
  const findings = qualityDiagnostics(model).map((d, n): FixableFinding => {
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
    const iriToProp = new Map(model.props.filter((p) => p.iri).map((p) => [p.iri!, p.id]));
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
      const propId = focusIri ? iriToProp.get(focusIri) : undefined;
      const entity: EntityRef | undefined = termId ? ix.term(termId) : propId ? ix.prop(propId) : focus ? { kind: 'external', id: focus.value, name: show(focus), type: 'data', iri: focusIri } : undefined;
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

export type { Scope } from '../validation/contracts';

/** What a run covers, as a fingerprint: the same content always gives the same one. */
export function fingerprintOf(model: Model, data: DataGraph): string {
  return fingerprint(toTurtle(model) + '\n' + shapesToTurtle(model) + '\n' + JSON.stringify(model.quality) + '\n' + JSON.stringify(model.governance) + '\n' + (data.source === 'imported' ? (data.text ?? '') + data.includeOntology : ''));
}

/** Whether two data graphs are the same one. */
export const sameData = (a: DataGraph, b: DataGraph): boolean => a === b || (a.source === b.source && a.name === b.name && a.text === b.text && a.includeOntology === b.includeOntology);

/**
 * Runs the checks of `scope` (one category, all, or a list) and reports what they find, as a
 * report of `ref`. Categories it does not run are carried over from `previous` when that was of
 * the very same ontology and data; otherwise they are left out rather than shown as if they were
 * current. `tick` is awaited between parts, so that whoever waits can show how it goes.
 */
export interface ValidateOptions {
  /** Awaited between parts, with what comes next in words. */
  tick?: (phase: string) => Promise<void>;
  /** The ontology together with the ones it imports: what the OWL checks reason over, where it imports anything. */
  withImports?: Model;
  /** Asks the OWL 2 DL reasoner, when that is the engine chosen. Without it the app's own reasoner answers. */
  askDl?: () => Promise<DlReport>;
  /** The app's own reasoner's answer about the model, where it has one already: it is not asked again. */
  reasoning?: Reasoning;
  /** The revision the report is of. */
  ref?: OntologyRef;
}

export async function validate(model: Model, data: DataGraph, scope: Scope | Category[], previous: ValidationReport | null, options: ValidateOptions = {}): Promise<ValidationReport> {
  const { tick = async () => {}, withImports, askDl, reasoning, ref = { ontologyId: '', revisionId: '' } } = options;
  const categories: Category[] = Array.isArray(scope) ? scope : scope === 'all' ? ['owl', 'shacl', 'quality'] : [scope];
  const print = fingerprintOf(model, data);
  const keep = previous && previous.fingerprint === print && sameData(previous.data, data) ? previous : null;
  const run: ValidationReport = { ...ref, at: Date.now(), fingerprint: print, data, entities: model.terms.length + model.props.length, owl: keep?.owl, dl: keep?.dl, shacl: keep?.shacl, quality: keep?.quality, findings: keep ? keep.findings.filter((f) => !categories.includes(f.category)) : [] };
  const wants = (c: Category) => categories.includes(c);
  if (wants('owl') && askDl && model.mode !== 'skos') {
    await tick('Reasoning with the OWL 2 DL reasoner…');
    const report = await askDl();
    const r = dlFindings(model, report);
    run.owl = r.summary;
    run.dl = { report };
    run.findings.push(...r.findings);
  } else if (wants('owl')) {
    await tick('Reasoning…');
    // An ontology that imports others is consistent only together with them, so they are reasoned over as one.
    const r = withImports ? owlFindings(withImports, true) : owlFindings(model, !reasoning, reasoning);
    run.owl = r.summary;
    run.dl = undefined;
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
  const rank: Record<Level, number> = { error: 0, warning: 1, info: 2 };
  const order: Record<Category, number> = { owl: 0, shacl: 1, quality: 2 };
  run.findings.sort((a, b) => rank[a.severity] - rank[b.severity] || order[a.category] - order[b.category]);
  return run;
}
