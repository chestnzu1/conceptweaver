import type { Model } from '../model/types';
import type { BaseType, ElementRef, LogicalChange, LogicalEntity, LogicalModel, LogicalType, MappingSource, Relationship, SemanticMapping, TransformationConfig } from '../logical/contracts';
import { elementOf, newId, removalOf } from '../logical/rules';
import { expectedKindOf } from '../logical/strategies';
import type { Coverage, ImpactItem, ImpactKind, ImpactReport, MappingChange, MappingDescription, MappingStatus, ProposalSource, SynchronizationProposal, SynchronizationResult, TargetDescription, TraceResult } from './contracts';
import { enumIriOf, hierarchyFor, nameFor, propIriOf, proposalsFor, scopeClasses, sourceAxiomsOf, sourceNow, termIri, typeForDataProperty } from './transform';

/**
 * Traceability and change impact (roadmap stage LM-4; SYSTEM_ARCHITECTURE.md §13.7 to §13.9;
 * FR-M18-8 to FR-M18-14, ADR-025). It reads the ontology and an LDM as plain data and works out
 * where every mapping stands: whether the ontology still states what it was made from, what
 * changed since, what covers the LDM and what does not, and — where asked — what the LDM could
 * do about it. Nothing is written, and no synchronization is applied here: the proposals go back
 * to the service to be accepted or turned down.
 */

const refKind = (ref: ElementRef): keyof ElementRef => Object.keys(ref)[0] as keyof ElementRef;
const refId = (ref: ElementRef): string => (ref as Record<string, string>)[refKind(ref)];
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** A value compared by what it holds, not by the order its keys were written in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A short, stable fingerprint of what a proposal answers: equal while its sources say the same. */
export function fingerprintOf(kind: string, parts: unknown[]): string {
  const text = JSON.stringify([kind, ...parts]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${kind}:${h.toString(16)}:${text.length.toString(16)}`;
}

// ---------------------------------------------------------------- what an element is called now

function elementName(target: LogicalModel, ref: ElementRef): { name: string; exists: boolean } {
  const id = refId(ref);
  switch (refKind(ref)) {
    case 'entity': {
      const e = target.entities.find((x) => x.id === id);
      return e ? { name: e.name, exists: true } : { name: `entity ${id}`, exists: false };
    }
    case 'attribute': {
      for (const e of target.entities) {
        const a = e.attributes.find((x) => x.id === id);
        if (a) return { name: `${e.name}.${a.name}`, exists: true };
      }
      return { name: `attribute ${id}`, exists: false };
    }
    case 'key': {
      for (const e of target.entities) {
        const k = e.keys.find((x) => x.id === id);
        if (k) return { name: `${k.name || k.kind} of ${e.name}`, exists: true };
      }
      return { name: `key ${id}`, exists: false };
    }
    case 'relationship': {
      const r = target.relationships.find((x) => x.id === id);
      if (!r) return { name: `relationship ${id}`, exists: false };
      const ends = r.ends.map((x) => target.entities.find((e) => e.id === x.entity)?.name ?? '?');
      return { name: r.name || `${ends[0]} to ${ends[1]}`, exists: true };
    }
    case 'generalization': {
      const g = target.generalizations.find((x) => x.id === id);
      const superName = g ? (target.entities.find((e) => e.id === g.supertype)?.name ?? '?') : '?';
      return { name: `the subtypes of ${superName}`, exists: !!g };
    }
    case 'rule': {
      const r = target.rules.find((x) => x.id === id);
      return r ? { name: r.name, exists: true } : { name: `rule ${id}`, exists: false };
    }
    case 'domain': {
      const d = target.domains.find((x) => x.id === id);
      return d ? { name: d.name, exists: true } : { name: `domain ${id}`, exists: false };
    }
    case 'mapping': {
      const m = target.mappings.find((x) => x.id === id);
      return m ? { name: m.strategy || 'a mapping', exists: true } : { name: `mapping ${id}`, exists: false };
    }
    case 'diagram': {
      const d = target.diagrams.find((x) => x.id === id);
      return d ? { name: d.name, exists: true } : { name: `diagram ${id}`, exists: false };
    }
  }
  return { name: id, exists: false };
}

/** The element's own object, by reference: an entity without its attributes and keys, as mappings remember it. */
function plainElement(target: LogicalModel, ref: ElementRef): Record<string, unknown> | undefined {
  const element = elementOf(target, ref);
  if (!element) return undefined;
  if (element.kind === 'entity') {
    const { attributes: _a, keys: _k, ...own } = element.entity;
    return own;
  }
  return (element as unknown as Record<string, Record<string, unknown>>)[element.kind];
}

/** What a mapping last made of an element, where it remembers it. */
function baselineOf(baseline: Record<string, unknown>, ref: ElementRef): Record<string, unknown> | undefined {
  const id = refId(ref);
  const kind = refKind(ref);
  const direct = baseline[kind];
  if (isRecord(direct) && direct.id === id) return direct;
  const entries = baseline.elements;
  if (Array.isArray(entries)) {
    const found = entries.find((x) => isRecord(x) && x.id === id);
    if (found) return found as Record<string, unknown>;
  }
  for (const value of Object.values(baseline)) {
    if (isRecord(value) && value.id === id) return value;
    if (Array.isArray(value)) {
      const found = value.find((x) => isRecord(x) && x.id === id);
      if (found) return found as Record<string, unknown>;
    }
  }
  return undefined;
}

/** A baseline with what a synchronization made of one target, leaving every other target as it was. */
function baselineWith(baseline: Record<string, unknown>, ref: ElementRef, made: Record<string, unknown>): Record<string, unknown> {
  const id = refId(ref);
  const kind = refKind(ref);
  const copy = JSON.parse(JSON.stringify(made));
  if (isRecord(baseline[kind]) && baseline[kind].id === id) return { ...baseline, [kind]: copy };
  if (Array.isArray(baseline.elements)) return { ...baseline, elements: baseline.elements.map((x) => (isRecord(x) && x.id === id ? copy : x)) };
  return { ...baseline, elements: [...(Array.isArray(baseline.elements) ? baseline.elements : []), copy] };
}

/**
 * Whether the user has changed an element since the mapping made it. An entity is compared by its
 * own fields: its attributes and keys are elements of their own, each with its own mapping.
 */
function customisedAgainst(baseline: Record<string, unknown>, plain: Record<string, unknown>, ref: ElementRef): boolean {
  if (refKind(ref) !== 'entity') return stable(baseline) !== stable(plain);
  return ['id', 'name', 'definition', 'abstract'].some((field) => stable(baseline[field] ?? null) !== stable(plain[field] ?? null));
}

// ---------------------------------------------------------------- the ontology as it is

interface Reader {
  axioms(iri: string): string[] | undefined;
  /** What this mapping's source states now: a specialization tracks the subclass edges, a rule its one restriction. */
  axiomsFor(mapping: SemanticMapping, iri: string): string[] | undefined;
  now(iri: string): { name: string; kind: 'class' | 'data property' | 'object property' | 'datatype' } | undefined;
}

/** Reads an ontology entity by IRI, remembering what it found: one walk of the model, not one per mapping. */
function readerFor(model: Model, config?: TransformationConfig): Reader {
  const axioms = new Map<string, string[] | undefined>();
  const now = new Map<string, { name: string; kind: 'class' | 'data property' | 'object property' | 'datatype' } | undefined>();
  const forMapping = new Map<string, string[] | undefined>();
  let hierarchy: ReturnType<typeof hierarchyFor> | undefined;
  const read = (iri: string) => {
    if (!axioms.has(iri)) axioms.set(iri, sourceAxiomsOf(model, iri));
    return axioms.get(iri);
  };
  return {
    axioms: read,
    axiomsFor(mapping, iri) {
      const key = `${mapping.id}\u0000${iri}`;
      if (forMapping.has(key)) return forMapping.get(key);
      const all = read(iri);
      let result = all;
      if (all) {
        const ref = mapping.targets[0];
        const kind = ref ? refKind(ref) : undefined;
        if (kind === 'rule') {
          const recorded = mapping.sources.find((s) => s.iri === iri)?.axioms ?? [];
          result = recorded.filter((a) => all.includes(a));
        } else if (config && kind === 'generalization') {
          hierarchy ??= hierarchyFor(model, config);
          result = [`Declaration(Class(<${iri}>))`, ...(hierarchy.subs.get(iri) ?? []).map((s) => `SubClassOf(<${s}> <${iri}>)`)];
        } else if (config && (mapping.strategyId === 'OWL_SUBCLASS_TO_LDM_ROLLDOWN' || mapping.strategy === 'inherited attribute rolled down to the subtype')) {
          hierarchy ??= hierarchyFor(model, config);
          result = (hierarchy.supers.get(iri) ?? []).map((s) => `SubClassOf(<${iri}> <${s}>)`);
        }
      }
      forMapping.set(key, result);
      return result;
    },
    now(iri) {
      if (!now.has(iri)) now.set(iri, sourceNow(model, iri));
      return now.get(iri);
    },
  };
}

// ---------------------------------------------------------------- status and customisation

interface StateOptions {
  ontology: Model;
  target: LogicalModel;
  /** An earlier ontology, for a report between two versions; absent: each mapping's recorded origin. */
  before?: Model;
}

function statusOf(mapping: SemanticMapping, options: StateOptions, reader: Reader, beforeReader?: Reader): { status: MappingStatus; changes: MappingChange[]; targets: TargetDescription[]; customised: boolean } {
  const changes: MappingChange[] = [];
  const targets: TargetDescription[] = [];
  let customised = false;
  let broken = false;
  for (const ref of mapping.targets) {
    const at = elementName(options.target, ref);
    const baseline = baselineOf(mapping.baseline, ref);
    const plain = at.exists ? plainElement(options.target, ref) : undefined;
    const differs = !!baseline && !!plain && customisedAgainst(baseline, plain, ref);
    customised = customised || differs;
    targets.push({ ref, name: at.name, exists: at.exists, customised: differs });
    if (!at.exists) {
      broken = true;
      changes.push({ kind: 'target-removed', target: ref, removed: [], added: [], text: `${at.name} is no longer in the logical model.` });
    }
  }
  let stale = false;
  for (const source of mapping.sources) {
    const nowAxioms = reader.axiomsFor(mapping, source.iri);
    const oldAxioms = beforeReader ? beforeReader.axiomsFor(mapping, source.iri) : source.axioms;
    if (nowAxioms === undefined) {
      broken = true;
      changes.push({ kind: 'source-removed', source: source.iri, removed: oldAxioms ?? source.axioms, added: [], text: `${source.label || source.iri} is no longer in the ontology.` });
      continue;
    }
    if (oldAxioms === undefined) {
      stale = true;
      changes.push({ kind: 'source-added', source: source.iri, removed: [], added: nowAxioms, text: `${reader.now(source.iri)?.name || source.iri} is now in the ontology.` });
      continue;
    }
    const removed = oldAxioms.filter((a) => !nowAxioms.includes(a));
    const added = nowAxioms.filter((a) => !(oldAxioms as string[]).includes(a));
    if (!removed.length && !added.length) continue;
    stale = true;
    changes.push({
      kind: 'source-changed',
      source: source.iri,
      removed,
      added,
      text: `What the ontology says of ${source.label || source.iri} has changed.`,
    });
  }
  // A typed strategy says what kind of element the mapping makes. Where its target is of another
  // kind, the mapping contradicts the model it is in: the structure was changed without the
  // strategy, or the strategy without the structure. Only an explicit conversion reconciles them.
  const expected = expectedKindOf(mapping.strategyId);
  const mismatched = !!expected && mapping.targets.some((ref) => refKind(ref) !== expected);
  const status: MappingStatus = broken ? 'broken' : mismatched ? 'mismatched' : stale ? 'stale' : 'current';
  return { status, changes, targets, customised };
}

function describeMapping(mapping: SemanticMapping, options: StateOptions, reader: Reader, beforeReader?: Reader): MappingDescription {
  const state = statusOf(mapping, options, reader, beforeReader);
  return {
    mapping,
    status: state.status,
    customised: state.customised,
    changes: state.changes,
    targets: state.targets,
    sources: mapping.sources.map((s) => {
      const now = reader.now(s.iri);
      return { iri: s.iri, ...(s.label !== undefined ? { label: s.label } : {}), ...(now ? { name: now.name } : {}), exists: !!now };
    }),
  };
}

// ---------------------------------------------------------------- coverage (FR-M18-9)

const TRACKED = (target: LogicalModel): { ref: ElementRef; name: string }[] => {
  const out: { ref: ElementRef; name: string }[] = [];
  for (const e of target.entities) {
    out.push({ ref: { entity: e.id }, name: e.name });
    for (const a of e.attributes) out.push({ ref: { attribute: a.id }, name: `${e.name}.${a.name}` });
  }
  for (const r of target.relationships) out.push({ ref: { relationship: r.id }, name: elementName(target, { relationship: r.id }).name });
  for (const g of target.generalizations) out.push({ ref: { generalization: g.id }, name: elementName(target, { generalization: g.id }).name });
  for (const r of target.rules) out.push({ ref: { rule: r.id }, name: r.name });
  for (const d of target.domains) out.push({ ref: { domain: d.id }, name: d.name });
  return out;
};

export function coverageOf(target: LogicalModel, ontology: Model): Coverage {
  const mapped = new Set(target.mappings.flatMap((m) => m.targets.map(refId)));
  const elements = TRACKED(target);
  const sourced = elements.filter((e) => mapped.has(refId(e.ref))).length;
  const named = new Set(target.mappings.flatMap((m) => m.sources.map((s) => s.iri)));
  const config = target.derivation;
  const scope = config ? scopeClasses(ontology, config) : null;
  return {
    model: target.id,
    scope: scope?.length ?? null,
    unrepresented: (scope ?? []).filter((iri) => !named.has(iri)).map((iri) => ({ iri, name: sourceNow(ontology, iri)?.name || iri })),
    unsourced: elements.filter((e) => !mapped.has(refId(e.ref))),
    counts: { elements: elements.length, sourced },
  };
}

// ---------------------------------------------------------------- the report

export interface TraceInput {
  models: LogicalModel[];
  ontology: Model;
  model?: LogicalModel;
  element?: ElementRef;
  iri?: string;
}

/** Traceability both ways: from an element to its mappings and sources, or from an ontology entity to every target. */
export function traceIn(input: TraceInput): TraceResult {
  const mappings: TraceResult['mappings'] = [];
  const sources: MappingSource[] = [];
  const models = input.model ? [input.model] : input.models;
  for (const target of models) {
    const reader = readerFor(input.ontology, target.derivation);
    for (const mapping of target.mappings) {
      const fromElement = !!input.element && mapping.targets.some((r) => refId(r) === refId(input.element!));
      const fromSource = !!input.iri && mapping.sources.some((s) => s.iri === input.iri);
      if (!fromElement && !fromSource) continue;
      const state = statusOf(mapping, { ontology: input.ontology, target }, reader);
      mappings.push({ model: target.id, modelName: target.name, mapping, status: state.status, customised: state.customised, targets: state.targets.map(({ ref, name, exists }) => ({ ref, name, exists })) });
      if (fromElement) for (const s of mapping.sources) sources.push(s);
    }
  }
  return {
    ...(input.element ? { element: { ref: input.element, name: input.model ? elementName(input.model, input.element).name : 'the element' } } : {}),
    ...(input.iri ? { iri: input.iri } : {}),
    mappings,
    sources,
  };
}

export function reportFor(input: { ontology: Model; origin: ImpactReport['ontology']; target: LogicalModel; at?: number }): ImpactReport {
  const reader = readerFor(input.ontology, input.target.derivation);
  const options = { ontology: input.ontology, target: input.target };
  const mappings = input.target.mappings.map((m) => describeMapping(m, options, reader));
  return {
    model: input.target.id,
    baseRevision: input.target.revision,
    ontology: input.origin,
    compared: { from: 'each mapping’s origin', to: 'the ontology now' },
    mappings,
    coverage: coverageOf(input.target, input.ontology),
    items: impactItems(input.ontology, input.target, mappings, reader),
    at: input.at ?? Date.now(),
  };
}

// ---------------------------------------------------------------- impact (FR-M18-11)

function kindOfChange(changed: string[]): ImpactKind {
  if (changed.some((a) => /^(DataPropertyRange|DataPropertyDomain|ObjectPropertyRange|ObjectPropertyDomain)\(/.test(a))) return 'type-changed';
  if (changed.some((a) => /^Functional(Object|Data)Property\(/.test(a))) return 'cardinality-changed';
  if (changed.some((a) => /(SomeValuesFrom|AllValuesFrom|MinCardinality|MaxCardinality|ExactCardinality)\(/.test(a))) return 'restriction-changed';
  if (changed.some((a) => /^(SubClassOf|EquivalentClasses)\(/.test(a))) return 'hierarchy-changed';
  return 'axiom-changed';
}

const KNOWN = new Set(['not-represented', 'source-removed', 'target-removed', 'type-changed', 'cardinality-changed', 'hierarchy-changed', 'restriction-changed', 'renamed', 'axiom-changed']);

/** The naming configuration an LDM was derived under, where it records one. */
const configOf = (target: LogicalModel): TransformationConfig | undefined => target.derivation;

/** The name an element would be given now, from its source's current label. */
function expectedName(target: LogicalModel, mapping: SemanticMapping, ref: ElementRef, ontology: Model): string | undefined {
  const config = configOf(target);
  const source = mapping.sources[0];
  if (!config || !source) return undefined;
  const now = sourceNow(ontology, source.iri);
  if (!now) return undefined;
  switch (refKind(ref)) {
    case 'entity':
    case 'domain':
      return nameFor(now.name, source.iri, config.naming, true);
    case 'attribute':
      return nameFor(now.name, source.iri, config.naming, false);
    case 'relationship': {
      if (mapping.sources.length > 1) {
        const other = sourceNow(ontology, mapping.sources[1].iri);
        if (!other) return undefined;
        return `${now.name} / ${other.name}`;
      }
      return now.name;
    }
    default:
      return undefined;
  }
}

interface Rename {
  sources: { iri: string; from: string; to: string }[];
  targets: { ref: ElementRef; expected: string; current: string }[];
}

/** What the ontology now calls the sources, where that has changed since the mapping remembered it. */
function renameOf(mapping: SemanticMapping, options: StateOptions, reader: Reader): Rename | undefined {
  const sources: Rename['sources'] = [];
  for (const source of mapping.sources) {
    if (source.label === undefined) continue;
    const now = reader.now(source.iri);
    if (now && now.name !== source.label) sources.push({ iri: source.iri, from: source.label, to: now.name });
  }
  if (!sources.length) return undefined;
  const targets: Rename['targets'] = [];
  for (const ref of mapping.targets) {
    const at = elementName(options.target, ref);
    if (!at.exists) continue;
    const expected = expectedName(options.target, mapping, ref, options.ontology);
    if (expected && expected !== at.name) targets.push({ ref, expected, current: at.name });
  }
  return { sources, targets };
}

function impactItems(ontology: Model, target: LogicalModel, mappings: MappingDescription[], reader: Reader): ImpactItem[] {
  const items: ImpactItem[] = [];
  const options = { ontology, target };
  for (const described of mappings) {
    const mapping = described.mapping;
    for (const change of described.changes) {
      if (change.kind === 'target-removed') {
        items.push({
          id: newId('i'),
          kind: 'target-removed',
          mapping: mapping.id,
          ...(change.target ? { target: change.target } : {}),
          sources: [],
          title: `${elementName(target, change.target!).name} was deleted from the logical model`,
          detail: `Its mapping from ${mapping.sources.map((s) => s.label || s.iri).join(', ') || 'the ontology'} no longer has a target.`,
          customised: false,
        });
      } else if (change.kind === 'source-removed') {
        items.push({
          id: newId('i'),
          kind: 'source-removed',
          mapping: mapping.id,
          ...(mapping.targets[0] ? { target: mapping.targets[0] } : {}),
          sources: change.source ? [change.source] : [],
          title: `${change.source ? reader.now(change.source)?.name || mapping.sources.find((s) => s.iri === change.source)?.label || change.source : 'A source'} is gone from the ontology`,
          detail: `${described.targets.filter((t) => t.exists).map((t) => t.name).join(', ') || 'The elements'} still name it as their source.`,
          customised: described.customised,
          changed: { removed: change.removed, added: [] },
        });
      } else if (change.kind === 'source-added') {
        items.push({
          id: newId('i'),
          kind: 'not-represented',
          mapping: mapping.id,
          ...(mapping.targets[0] ? { target: mapping.targets[0] } : {}),
          sources: change.source ? [change.source] : [],
          title: `${change.source ? reader.now(change.source)?.name || change.source : 'A source'} is new in the ontology`,
          detail: 'The mapping named it before it was declared.',
          customised: described.customised,
          changed: { removed: [], added: change.added },
        });
      } else {
        const changed = [...change.removed, ...change.added];
        const kind = kindOfChange(changed);
        const names = described.targets.filter((t) => t.exists).map((t) => t.name);
        items.push({
          id: newId('i'),
          kind: KNOWN.has(kind) ? kind : 'axiom-changed',
          mapping: mapping.id,
          ...(mapping.targets[0] ? { target: mapping.targets[0] } : {}),
          sources: change.source ? [change.source] : [],
          title: `${names.join(', ') || 'The mapping'} is affected by a change in ${change.source ? reader.now(change.source)?.name || mapping.sources.find((s) => s.iri === change.source)?.label || change.source : 'the ontology'}`,
          detail: `${change.removed.length} axiom${change.removed.length === 1 ? '' : 's'} no longer stated, ${change.added.length} new.`,
          customised: described.customised,
          changed: { removed: change.removed, added: change.added },
        });
      }
    }
    const rename = renameOf(mapping, options, reader);
    if (rename) {
      for (const t of rename.targets) {
        items.push({
          id: newId('i'),
          kind: 'renamed',
          mapping: mapping.id,
          target: t.ref,
          sources: rename.sources.map((s) => s.iri),
          title: `${t.current} is called “${t.expected}” in the ontology now`,
          detail: rename.sources.map((s) => `“${s.from}” became “${s.to}”.`).join(' '),
          customised: described.customised,
        });
      }
    }
  }
  const covered = new Set(mappings.flatMap((m) => m.mapping.sources.map((s) => s.iri)));
  const config = configOf(target);
  if (config) {
    for (const iri of scopeClasses(ontology, config)) {
      if (covered.has(iri)) continue;
      const now = reader.now(iri);
      if (!now) continue;
      items.push({
        id: newId('i'),
        kind: 'not-represented',
        sources: [iri],
        title: `${now.name} is in scope but has no element in the logical model`,
        detail: 'The class is read by the recorded derivation, but no mapping names it.',
        customised: false,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------- impact between versions

export interface ImpactInput {
  ontology: Model;
  origin: ImpactReport['ontology'];
  target: LogicalModel;
  /** An earlier ontology to compare with: a report between two saved versions. */
  before?: Model;
  compared?: { from: string; to: string };
  at?: number;
}

export function impactFor(input: ImpactInput): ImpactReport {
  const reader = readerFor(input.ontology, input.target.derivation);
  const beforeReader = input.before ? readerFor(input.before, input.target.derivation) : undefined;
  const options = { ontology: input.ontology, target: input.target, ...(input.before ? { before: input.before } : {}) };
  const mappings = input.target.mappings.map((m) => describeMapping(m, options, reader, beforeReader));
  return {
    model: input.target.id,
    baseRevision: input.target.revision,
    ontology: input.origin,
    compared: input.compared ?? (input.before ? { from: 'the earlier ontology', to: 'the later ontology' } : { from: 'each mapping’s origin', to: 'the ontology now' }),
    mappings,
    coverage: coverageOf(input.target, input.ontology),
    items: impactItems(input.ontology, input.target, mappings, reader),
    at: input.at ?? Date.now(),
  };
}

// ---------------------------------------------------------------- synchronization (FR-M18-12)

export interface SynchronizeInput extends ImpactInput {
  dismissed?: string[];
}

interface Ctx {
  ontology: Model;
  target: LogicalModel;
  origin: ImpactReport['ontology'];
  reader: Reader;
  at: number;
  config?: TransformationConfig;
}

function sourceOf(ctx: Ctx, mapping: SemanticMapping, iri: string): ProposalSource {
  const recorded = mapping.sources.find((s) => s.iri === iri) ?? ctx.target.mappings.flatMap((m) => m.sources).find((s) => s.iri === iri);
  const now = ctx.reader.now(iri);
  const axioms = ctx.reader.axiomsFor(mapping, iri);
  return {
    iri,
    ...(now ? { label: now.name } : recorded?.label !== undefined ? { label: recorded.label } : {}),
    axioms: axioms ?? recorded?.axioms ?? [],
  };
}


/** The one update that records what the ontology now says, and what the synchronization made, of a mapping. */
function mappingUpdate(ctx: Ctx, mapping: SemanticMapping, elements: Record<string, Record<string, unknown>>): LogicalChange | undefined {
  let baseline = mapping.baseline;
  for (const [id, made] of Object.entries(elements)) {
    const ref = mapping.targets.find((r) => refId(r) === id);
    if (ref) baseline = baselineWith(baseline, ref, made);
  }
  const sources = mapping.sources.map((s) => {
    const axioms = ctx.reader.axiomsFor(mapping, s.iri);
    const now = ctx.reader.now(s.iri);
    if (axioms === undefined) return s;
    return { ...s, axioms, ...(now ? { label: now.name } : {}) };
  });
  const made = { by: 'synchronization' as const, at: ctx.at };
  const after = { sources, origin: { ontology: ctx.origin.ontology, revision: ctx.origin.revision, ...(ctx.origin.version ? { version: ctx.origin.version } : {}) }, baseline, made };
  if (stable(after) === stable({ sources: mapping.sources, origin: mapping.origin, baseline: mapping.baseline, made: mapping.made })) return undefined;
  return { op: 'update', target: { mapping: mapping.id }, before: { sources: mapping.sources, origin: mapping.origin, baseline: mapping.baseline, made: mapping.made }, after };
}

function endsWith(relationship: Relationship, source: MappingSource, ontology: Model, inverse?: MappingSource): LogicalChange | undefined {
  const prop = ontology.props.find((p) => propIriOf(ontology, p) === source.iri);
  if (!prop) return undefined;
  const at = relationship.ends.findIndex((e) => e.role === (source.label ?? prop.name));
  const index = at >= 0 ? at : 1;
  const ends = relationship.ends.map((e) => ({ ...e })) as [import('../logical/contracts').RelationshipEnd, import('../logical/contracts').RelationshipEnd];
  ends[index].max = prop.chars.includes('functional') ? 1 : 'many';
  const inverseProp = inverse ? ontology.props.find((p) => propIriOf(ontology, p) === inverse.iri) : undefined;
  if (inverse && inverseProp) {
    const inverseName = inverse.label ?? inverseProp.name;
    const other = ends.findIndex((e) => e.role === inverseName);
    const otherIndex = other >= 0 ? other : 1 - index;
    ends[otherIndex].max = inverseProp.chars.includes('functional') ? 1 : 'many';
  }
  if (stable(ends) === stable(relationship.ends)) return undefined;
  return { op: 'update', target: { relationship: relationship.id }, before: { ends: relationship.ends }, after: { ends } };
}

function valuesOf(ctx: Ctx, iri: string): { code: string; label: string }[] | undefined {
  const datatype = ctx.ontology.datatypes.find((d) => enumIriOf(ctx.ontology, d) === iri);
  if (datatype) return datatype.values.map((v) => ({ code: v.value, label: v.value }));
  const term = ctx.ontology.terms.find((t) => termIri(ctx.ontology, t) === iri && t.oneOf);
  if (!term?.oneOf) return undefined;
  return term.oneOf.map((id) => {
    const member = ctx.ontology.terms.find((t) => t.id === id);
    const code = member?.name || id;
    return { code, label: code };
  });
}

/** The direct subtypes of a class that have entities in the LDM, by the mappings' own sources. */
function expectedSubtypes(ctx: Ctx, superIri: string): string[] | undefined {
  if (!ctx.config) return undefined;
  const subs = hierarchyFor(ctx.ontology, ctx.config).subs.get(superIri);
  if (!subs) return [];
  const entityByClass = new Map<string, string>();
  for (const m of ctx.target.mappings) for (const s of m.sources) for (const r of m.targets) if ('entity' in r) entityByClass.set(s.iri, r.entity);
  return [...new Set(subs.map((s) => entityByClass.get(s)).filter((x): x is string => !!x))];
}

/** What one mapping's synchronization would change, if anything. */
interface Plan {
  mapping: SemanticMapping;
  kind: SynchronizationProposal['kind'];
  title: string;
  changes: LogicalChange[];
  elements: string[];
  elementRefs: string[];
  madeByRef: Record<string, Record<string, unknown>>;
  strategy: string;
  rationale: string;
  difference: string;
  customised: boolean;
  sources: ProposalSource[];
}

function planFor(ctx: Ctx, described: MappingDescription, rename: Rename | undefined): Plan | undefined {
  const mapping = described.mapping;
  const existing = described.targets.filter((t) => t.exists);
  if (!existing.length) return undefined;
  // Nothing to propose over a mapping that still holds, unless the ontology has renamed its source.
  if (described.status === 'current' && !rename?.sources.length) return undefined;
  const gone = described.changes.filter((c) => c.kind === 'source-removed');
  if (gone.length) {
    const changes: LogicalChange[] = [];
    for (const t of existing) changes.push(...removalOf(ctx.target, t.ref));
    const names = existing.map((t) => t.name).join(', ');
    return {
      mapping,
      kind: 'remove',
      title: existing.length === 1 ? `Remove ${names}` : `Remove ${existing.length} elements: ${names}`,
      changes,
      elements: existing.map((t) => t.name),
      elementRefs: existing.map((t) => refId(t.ref)),
      madeByRef: {},
      strategy: 'the ontology no longer states its source → the element goes',
      rationale: `${gone.map((c) => c.text).join(' ')} The element made from it would have no source.`,
      difference: 'An ontology change never removes anything from an LDM by itself (ADR-025). Removing it is a decision the user takes here, and undo takes it back.',
      customised: described.customised,
      sources: mapping.sources.map((s) => sourceOf(ctx, mapping, s.iri)),
    };
  }
  const changes: LogicalChange[] = [];
  const madeByRef: Record<string, Record<string, unknown>> = {};
  const elements: string[] = [];
  const elementRefs: string[] = [];
  for (const t of existing) {
    const ref = t.ref;
    const plain = plainElement(ctx.target, ref);
    if (!plain) continue;
    const after: Record<string, unknown> = {};
    if (refKind(ref) === 'attribute') {
      const attr = plain as unknown as import('../logical/contracts').LogicalAttribute;
      const source = mapping.sources[0];
      if (source && ctx.config) {
        const type = typeForDataProperty(ctx.ontology, ctx.target, source.iri, ctx.config)?.type;
        if (type && stable(type) !== stable(attr.type)) after.type = type;
      }
      if (rename) {
        const wanted = rename.targets.find((x) => refId(x.ref) === refId(ref));
        if (wanted && wanted.expected !== attr.name) after.name = wanted.expected;
      }
    } else if (refKind(ref) === 'entity') {
      const entity = plain as unknown as LogicalEntity;
      if (rename) {
        const wanted = rename.targets.find((x) => refId(x.ref) === refId(ref));
        if (wanted && wanted.expected !== entity.name) after.name = wanted.expected;
      }
    } else if (refKind(ref) === 'relationship') {
      const relationship = ctx.target.relationships.find((r) => r.id === refId(ref))!;
      const ends = endsWith(relationship, mapping.sources[0], ctx.ontology, mapping.sources[1]);
      if (ends && ends.op === 'update') changes.push(ends);
      if (rename) {
        const wanted = rename.targets.find((x) => refId(x.ref) === refId(ref));
        if (wanted && wanted.expected !== relationship.name) after.name = wanted.expected;
      }
    } else if (refKind(ref) === 'domain') {
      const domain = ctx.target.domains.find((d) => d.id === refId(ref))!;
      const values = mapping.sources[0] ? valuesOf(ctx, mapping.sources[0].iri) : undefined;
      if (values && stable(values) !== stable(domain.constraints.values ?? [])) after.constraints = { ...domain.constraints, values };
      if (rename) {
        const wanted = rename.targets.find((x) => refId(x.ref) === refId(ref));
        if (wanted && wanted.expected !== domain.name) after.name = wanted.expected;
      }
    } else if (refKind(ref) === 'generalization') {
      const generalization = ctx.target.generalizations.find((g) => g.id === refId(ref))!;
      const source = mapping.sources[0];
      const subtypes = source ? expectedSubtypes(ctx, source.iri) : undefined;
      if (subtypes && stable(subtypes) !== stable(generalization.subtypes)) after.subtypes = subtypes;
    }
    if (Object.keys(after).length) {
      changes.push({ op: 'update', target: ref, before: Object.fromEntries(Object.keys(after).map((k) => [k, (plain as Record<string, unknown>)[k]])), after });
      madeByRef[refId(ref)] = { ...plain, ...after };
      elements.push(elementName(ctx.target, ref).name);
      elementRefs.push(refId(ref));
    }
  }
  const update = mappingUpdate(ctx, mapping, madeByRef);
  if (update) changes.push(update);
  if (!changes.length) return undefined;
  const recordOnly = elements.length === 0;
  const renamed = rename?.targets.length ? ` What the ontology now calls ${rename.sources.map((s) => `“${s.to}”`).join(', ')} is reflected in the name.` : '';
  return {
    mapping,
    kind: recordOnly ? 'record' : 'update',
    title: recordOnly
      ? `Record what the ontology now says about ${existing.map((t) => t.name).join(', ')}, keeping the element as it is`
      : existing.length === 1
        ? `Bring ${existing[0].name} up to date with the ontology`
        : `Bring ${existing.length} elements up to date with the ontology`,
    changes,
    elements: elements.length ? elements : existing.map((t) => t.name),
    elementRefs: elements.length ? elementRefs : existing.map((t) => refId(t.ref)),
    madeByRef,
    strategy: recordOnly ? 'record the ontology change → keep the element' : 'the ontology change → the element as it would be derived now',
    rationale: `${described.changes.map((c) => c.text).join(' ')}${renamed}${recordOnly ? ' No form in this LDM follows from it directly, so the element is kept and the mapping records the new statement.' : ''}`.trim(),
    difference: 'An ontology change never changes an LDM by itself (ADR-025); this is offered. An element the user changed is offered too, but never chosen to begin with.',
    customised: described.customised,
    sources: mapping.sources.map((s) => sourceOf(ctx, mapping, s.iri)),
  };
}

function proposalOf(ctx: Ctx, plan: Plan, item?: string): SynchronizationProposal {
  return {
    id: newId('s'),
    kind: plan.kind,
    title: plan.title,
    ...(item ? { item } : {}),
    mappings: [],
    sources: plan.sources,
    elements: plan.elements,
    changes: plan.changes,
    strategy: plan.strategy,
    rationale: plan.rationale,
    difference: plan.difference,
    requires: [],
    excludes: [],
    customised: plan.customised,
    fingerprint: fingerprintOf('mapping', [plan.mapping.id, plan.kind, plan.sources.map((s) => [s.iri, s.label ?? null, ctx.reader.axiomsFor(plan.mapping, s.iri) ?? 'gone', ctx.reader.now(s.iri)?.name ?? null]), plan.elementRefs.sort(), ctx.config ? stable(ctx.config.naming) : null]),
  };
}

function mappingIdsIn(changes: LogicalChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if ('target' in c && !('model' in c.target) && 'mapping' in c.target) out.push(c.target.mapping);
    if (c.op === 'add' && c.element.kind === 'mapping') out.push(c.element.mapping.id);
    if (c.op === 'remove' && c.element.kind === 'mapping') out.push(c.element.mapping.id);
  }
  return out;
}

/** The additions a derivation would now propose for classes in scope that no mapping names. */
function additionProposals(ctx: Ctx, report: ImpactReport): SynchronizationProposal[] {
  if (!ctx.config) return [];
  const missing = new Set(report.coverage.unrepresented.map((x) => x.iri));
  if (!missing.size) return [];
  const result = proposalsFor({ model: ctx.ontology, target: ctx.target, config: ctx.config, origin: { ontology: ctx.origin.ontology, revision: ctx.origin.revision, ...(ctx.origin.version ? { version: ctx.origin.version } : {}) } });
  const structural = result.proposals.filter((p) => !p.candidate);
  const seed = new Set(structural.filter((p) => p.kind === 'entity' && p.sources.some((s) => missing.has(s.iri))).map((p) => p.id));
  if (!seed.size) return [];
  // Everything that needs one of them comes too: the attributes on a new entity, its relationships, its specialization.
  const chosen = new Set(seed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of structural) {
      if (chosen.has(p.id)) continue;
      if (p.requires.some((r) => chosen.has(r))) {
        chosen.add(p.id);
        grew = true;
      }
    }
  }
  const ids = new Map([...chosen].map((id) => [id, newId('s')]));
  return structural
    .filter((p) => chosen.has(p.id))
    .map((p) => ({
      id: ids.get(p.id)!,
      kind: 'add' as const,
      title: p.title,
      mappings: mappingIdsIn(p.changes),
      sources: p.sources,
      elements: p.elements,
      changes: p.changes,
      strategy: p.strategy,
      rationale: p.rationale,
      difference: p.difference,
      requires: p.requires.map((r) => ids.get(r)).filter((x): x is string => !!x),
      excludes: [],
      customised: false,
      fingerprint: fingerprintOf('add', [p.sources.map((s) => [s.iri, s.label ?? null, ctx.reader.axioms(s.iri) ?? 'gone', ctx.reader.now(s.iri)?.name ?? null]), p.kind, ctx.config ? stable(ctx.config) : null]),
    }));
}

/** Which elements each proposal would add, change or remove: two that touch one cannot both be applied. */
function changedIds(p: SynchronizationProposal): Set<string> {
  const ids = new Set<string>();
  for (const c of p.changes) {
    if (c.op === 'add' || c.op === 'remove') {
      const element = c.element;
      if (element.kind === 'entity') {
        ids.add(element.entity.id);
        for (const a of element.entity.attributes) ids.add(a.id);
        for (const k of element.entity.keys) ids.add(k.id);
      } else if (element.kind === 'attribute') ids.add(element.attribute.id);
      else if (element.kind === 'key') ids.add(element.key.id);
      else if (element.kind === 'relationship') ids.add(element.relationship.id);
      else if (element.kind === 'generalization') ids.add(element.generalization.id);
      else if (element.kind === 'rule') ids.add(element.rule.id);
      else if (element.kind === 'domain') ids.add(element.domain.id);
      else if (element.kind === 'mapping') ids.add(element.mapping.id);
      else if (element.kind === 'diagram') ids.add(element.diagram.id);
    } else if ('model' in c.target) {
      ids.add('model');
    } else {
      ids.add(refId(c.target));
    }
  }
  return ids;
}

function markExclusions(proposals: SynchronizationProposal[]): void {
  const sets = proposals.map(changedIds);
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      if ([...sets[i]].some((id) => sets[j].has(id))) {
        proposals[i].excludes.push(proposals[j].id);
        proposals[j].excludes.push(proposals[i].id);
      }
    }
  }
}

export function synchronizeFor(input: SynchronizeInput): SynchronizationResult {
  const report = impactFor(input);
  const ctx: Ctx = { ontology: input.ontology, target: input.target, origin: input.origin, reader: readerFor(input.ontology, input.target.derivation), at: input.at ?? Date.now(), ...(input.target.derivation ? { config: input.target.derivation } : {}) };
  const proposals: SynchronizationProposal[] = [];
  for (const described of report.mappings) {
    const rename = renameOf(described.mapping, { ontology: input.ontology, target: input.target }, ctx.reader);
    const plan = planFor(ctx, described, rename);
    if (!plan) continue;
    const proposal = proposalOf(ctx, plan);
    proposal.mappings = [...new Set([described.mapping.id, ...mappingIdsIn(proposal.changes)])];
    proposals.push(proposal);
  }
  proposals.push(...additionProposals(ctx, report));
  markExclusions(proposals);
  const dismissed = new Set(input.dismissed ?? []);
  return { model: input.target.id, baseRevision: input.target.revision, ontology: input.origin, report, proposals: proposals.filter((p) => !dismissed.has(p.fingerprint)), at: ctx.at };
}

// ---------------------------------------------------------------- what a hand mapping is made of

/** The sources of a hand-made mapping, as the ontology states them now. */
export function madeSources(ontology: Model, iris: string[]): MappingSource[] {
  return [...new Set(iris)].flatMap((iri) => {
    const now = sourceNow(ontology, iri);
    const axioms = sourceAxiomsOf(ontology, iri);
    if (!now || axioms === undefined) return [];
    return [{ iri, axioms, label: now.name }];
  });
}

/** What a mapping made of each of its targets, now: its baseline. A copy, so that the element may move on. */
export function baselineFor(target: LogicalModel, refs: ElementRef[]): Record<string, unknown> {
  const elements = refs.map((ref) => plainElement(target, ref)).filter((x): x is Record<string, unknown> => !!x);
  return elements.length ? { elements: JSON.parse(JSON.stringify(elements)) } : {};
}

/** A type as the impact reader names it, for tests and for saying what changed. */
export const typeText = (type: LogicalType): string => ('domain' in type ? 'domain' : (type as BaseType).base);
