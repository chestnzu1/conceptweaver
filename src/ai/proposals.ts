import { EditError, type Axiom, type AxiomChange, type ChangeSet, type ClassExpression, type DataRange, type Literal, type ObjectPropertyCharacteristic } from '../editing/contracts';
import { axiomOf } from '../editing/axioms';
import { createLocalEditService, entityAxioms, ontologyOf } from '../editing/local';
import { propDatatype } from '../model/domains';
import { baseIriOf, localName } from '../model/iri';
import { namingFor, parseClass, parseDataRange, parseLiteral, type EntityKind, type Naming } from '../model/manchester';
import { expandIri } from '../model/prefixes';
import { reason } from '../model/reasoner';
import type { Model } from '../model/types';
import { axiomText } from '../projects/difference';
import { revisionOf, WORKING_COPY } from '../structure/local';
import type { JsonSchema, ToolSpec } from './providers/contracts';
import { findEntity } from './tools';

/**
 * Changes the assistant proposes (spec §4, §5): never made by it. The model describes a change as
 * typed operations, each an axiom to add or remove (or an entity to declare or take away), with
 * class expressions in Manchester syntax, which the editor's own parser reads, so that every name
 * in them is an entity of the ontology or of the proposal, and an intersection stays an
 * intersection. A proposal is compiled into a change set of OWL axioms by IRI (editing/contracts.ts),
 * checked against the editor's rules and the revision it was made for, tried on a copy of the
 * model to see what it would do (consistency and unsatisfiable classes, by the fast reasoner), and
 * applied, when the user accepts it, as one edit through the edit service: undone and redone like
 * any other, kept with the model, and refused if the ontology has moved on since.
 */

export const OPERATION_TYPES = ['declare', 'subClassOf', 'equivalentClasses', 'disjointClasses', 'domain', 'range', 'characteristic', 'subPropertyOf', 'inverseOf', 'classAssertion', 'objectPropertyAssertion', 'dataPropertyAssertion', 'annotation'] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];
export const CHARACTERISTICS = ['Functional', 'InverseFunctional', 'Transitive', 'Symmetric', 'Asymmetric', 'Reflexive', 'Irreflexive'] as const;

/** One operation of a proposal: what it adds or removes, by its type, with the fields that type takes. */
export interface Operation {
  action: 'add' | 'remove';
  type: OperationType;
  /** declare: what is declared, its name, and its IRI if it is to have a given one. */
  entityKind?: 'class' | 'objectProperty' | 'dataProperty' | 'individual';
  name?: string;
  iri?: string;
  /** The entity an axiom is about: a class (or class expression), property or individual, by name, prefixed name or <IRI>. */
  subject?: string;
  /** A class expression in Manchester syntax; for a data property's range, a data range. */
  expression?: string;
  /** More class expressions, for equivalentClasses and disjointClasses. */
  expressions?: string[];
  property?: string;
  characteristic?: (typeof CHARACTERISTICS)[number];
  /** An individual, for objectPropertyAssertion; an IRI value, for annotation. */
  object?: string;
  /** A literal, for dataPropertyAssertion and annotation. */
  value?: string;
  datatype?: string;
  lang?: string;
}

/** What the model proposes: the operations, and what it says of them. */
export interface ProposalInput {
  summary: string;
  explanation: string;
  impact: string;
  concerns: string[];
  operations: Operation[];
}

/** An entity a proposal declares, which its other operations may name. */
interface Declared {
  name: string;
  iri: string;
  kind: EntityKind;
}

/** A name for the parser: the ontology's entities, and those the proposal declares. */
function namingWith(base: Naming, declared: Declared[]): Naming {
  return {
    ...base,
    name: (iri, kind) => declared.find((d) => d.iri === iri)?.name.replace(/^(.*\s.*)$/, "'$1'") ?? base.name(iri, kind),
    find: (n) => [...base.find(n), ...declared.filter((d) => d.name.trim().toLowerCase() === n.trim().toLowerCase())],
    kindsOf: (iri) => [...base.kindsOf(iri), ...declared.filter((d) => d.iri === iri).map((d) => d.kind)],
    entities: (kind) => [...base.entities(kind), ...declared.filter((d) => d.kind === kind).map((d) => ({ text: d.name, iri: d.iri }))],
  };
}

const KIND: Record<NonNullable<Operation['entityKind']>, { entity: 'Class' | 'ObjectProperty' | 'DataProperty' | 'NamedIndividual'; kind: EntityKind; camel: boolean }> = {
  class: { entity: 'Class', kind: 'class', camel: false },
  objectProperty: { entity: 'ObjectProperty', kind: 'object', camel: true },
  dataProperty: { entity: 'DataProperty', kind: 'data', camel: true },
  individual: { entity: 'NamedIndividual', kind: 'individual', camel: false },
};
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_PREF = 'http://www.w3.org/2004/02/skos/core#prefLabel';

export interface Compiled {
  changes: AxiomChange[];
  /** What does not read, operation by operation (1-based). */
  errors: string[];
  declared: Declared[];
}

/** The operations as a change set of axioms by IRI; what does not read is said, operation by operation. */
export function compile(model: Model, operations: Operation[]): Compiled {
  const errors: string[] = [];
  const changes: AxiomChange[] = [];
  const declared: Declared[] = [];
  const used = new Set([...model.terms, ...model.props].map((x) => x.iri?.toLowerCase()).filter(Boolean));
  const ns = baseIriOf(model);

  // Declarations first, so that every other operation may name what the proposal declares.
  operations.forEach((op, i) => {
    if (op.type !== 'declare' || op.action !== 'add') return;
    const k = op.entityKind && KIND[op.entityKind];
    const name = op.name?.trim();
    if (!k || !name) return errors.push(`Operation ${i + 1}: a declaration needs entityKind (class, objectProperty, dataProperty or individual) and a name.`);
    let iri = op.iri?.trim().replace(/^<|>$/g, '');
    if (iri && !/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(iri)) return errors.push(`Operation ${i + 1}: ${iri} is not an IRI.`);
    if (!iri) {
      const local = localName(name, k.camel);
      iri = ns + local;
      for (let n = 2; used.has(iri.toLowerCase()); n++) iri = `${ns}${local}_${n}`;
    }
    if (used.has(iri.toLowerCase())) return errors.push(`Operation ${i + 1}: the ontology has ${iri} already: refer to it rather than declaring it.`);
    used.add(iri.toLowerCase());
    declared.push({ name, iri, kind: k.kind });
  });
  const naming = namingWith(namingFor(model), declared);
  const entity = (ref: string | undefined, want: EntityKind[], what: string): string => {
    const text = (ref ?? '').trim();
    if (!text) throw new Error(`it needs ${what}`);
    const d = declared.find((x) => x.name.toLowerCase() === text.toLowerCase() || x.iri === text.replace(/^<|>$/g, ''));
    if (d) {
      if (!want.includes(d.kind)) throw new Error(`${text} is declared as ${d.kind === 'object' ? 'an object property' : d.kind === 'data' ? 'a data property' : `a ${d.kind}`}, not as ${what}`);
      return d.iri;
    }
    const f = findEntity(model, text.replace(/^'(.*)'$/, '$1'));
    if (!f) throw new Error(`there is no entity “${text}” in the ontology or the proposal`);
    const as: EntityKind = f.kind === 'class' ? 'class' : f.kind === 'individual' ? 'individual' : f.kind === 'object property' ? 'object' : f.kind === 'data property' ? 'data' : 'datatype';
    if (!want.includes(as)) throw new Error(`${f.name} is ${f.kind === 'individual' ? 'an individual' : `a ${f.kind}`}, not ${what}`);
    return f.iri;
  };
  const kindOfProperty = (iri: string): 'object' | 'data' => (declared.find((d) => d.iri === iri)?.kind ?? (model.props.some((p) => p.iri === iri) ? 'object' : 'data')) as 'object' | 'data';
  const cls = (text: string | undefined, what: string): ClassExpression => {
    if (!text?.trim()) throw new Error(`it needs ${what}`);
    try {
      return parseClass(text, naming) as ClassExpression;
    } catch (e) {
      throw new Error(`${what}, “${text}”, does not read: ${e instanceof Error ? e.message : ''}`);
    }
  };
  const data = (text: string | undefined): DataRange => {
    if (!text?.trim()) throw new Error('it needs a data range, such as xsd:string');
    let r;
    try {
      r = parseDataRange(text, naming);
    } catch (e) {
      throw new Error(`the data range “${text}” does not read: ${e instanceof Error ? e.message : ''}`);
    }
    // An enumerated datatype of the model is named by its IRI.
    const out = JSON.parse(JSON.stringify(r), (_k, v) => {
      if (v && typeof v === 'object' && v.type === 'Enumeration') {
        const d = model.datatypes.find((x) => x.id === v.datatype);
        if (!d?.iri) throw new Error(`the enumerated datatype in “${text}” has no IRI to name it by`);
        return { type: 'Datatype', iri: d.iri };
      }
      return v;
    });
    return out as DataRange;
  };
  const literal = (op: Operation, property?: string): Literal => {
    const v = op.value ?? '';
    if (op.lang) return { value: v, lang: op.lang };
    const dt = op.datatype?.trim() || (property ? propDatatype(model.terms.find((t) => t.iri === property) ?? { ranges: [] }) : undefined);
    if (!dt || dt === 'xsd:string') return { value: v };
    const iri = dt.startsWith('xsd:') ? 'http://www.w3.org/2001/XMLSchema#' + dt.slice(4) : (expandIri(model, dt) ?? dt.replace(/^<|>$/g, ''));
    try {
      // Read as the editor reads a value, so that "42" is an integer where the datatype says so.
      const read = parseLiteral(`"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"^^<${iri}>`, naming);
      return { value: read.value, ...(read.datatype ? { datatype: read.datatype } : {}) };
    } catch {
      return { value: v, datatype: iri };
    }
  };
  const annotationProperty = (p: string | undefined) => {
    const t = (p ?? '').trim();
    if (!t) throw new Error('it needs an annotation property, such as rdfs:comment');
    const iri = t.startsWith('<') ? t.slice(1, -1) : (expandIri(model, t) ?? (/^[a-z][\w+.-]*:\/\//i.test(t) ? t : undefined));
    if (!iri) throw new Error(`“${t}” is not an annotation property this ontology knows: use a prefixed name such as rdfs:comment or skos:definition, or a full <IRI>`);
    return iri;
  };

  operations.forEach((op, i) => {
    try {
      const add = (axiom: Axiom) => changes.push({ op: op.action === 'remove' ? 'remove' : 'add', axiom });
      if (op.action !== 'add' && op.action !== 'remove') throw new Error('its action has to be add or remove');
      switch (op.type) {
        case 'declare': {
          if (op.action === 'add') {
            const d = declared.find((x) => x.name === op.name?.trim());
            if (!d) return;
            const k = KIND[op.entityKind!];
            changes.push({ op: 'add', axiom: { type: 'Declaration', entity: k.entity, iri: d.iri } });
            changes.push({ op: 'add', axiom: { type: 'AnnotationAssertion', property: model.mode === 'skos' ? SKOS_PREF : RDFS_LABEL, subject: d.iri, value: { value: d.name, ...(model.lang ? { lang: model.lang } : {}) } } });
            return;
          }
          // Taking an entity away takes away everything that names it, so that nothing is left pointing at it.
          const iri = entity(op.subject ?? op.iri ?? op.name, ['class', 'object', 'data', 'individual'], 'the entity to take away');
          const o = ontologyOf(model);
          for (const s of o.statements) if (s.quads.some((q) => q.subject.value === iri || q.object.value === iri || q.predicate.value === iri)) changes.push({ op: 'remove', axiom: axiomOf(s, o.kinds) });
          return;
        }
        case 'subClassOf':
          return add({ type: 'SubClassOf', sub: cls(op.subject, 'the subclass'), sup: cls(op.expression, 'the superclass') });
        case 'equivalentClasses':
        case 'disjointClasses': {
          const all = [...(op.subject ? [op.subject] : []), ...(op.expression ? [op.expression] : []), ...(op.expressions ?? [])];
          if (all.length < 2) throw new Error('it needs at least two classes');
          return add({ type: op.type === 'equivalentClasses' ? 'EquivalentClasses' : 'DisjointClasses', classes: all.map((x, n) => cls(x, `class ${n + 1}`)) });
        }
        case 'domain': {
          const p = entity(op.property ?? op.subject, ['object', 'data'], 'a property');
          return add({ type: kindOfProperty(p) === 'object' ? 'ObjectPropertyDomain' : 'DataPropertyDomain', property: p, domain: cls(op.expression, 'the domain') });
        }
        case 'range': {
          const p = entity(op.property ?? op.subject, ['object', 'data'], 'a property');
          return add(kindOfProperty(p) === 'object' ? { type: 'ObjectPropertyRange', property: p, range: cls(op.expression, 'the range') } : { type: 'DataPropertyRange', property: p, range: data(op.expression) });
        }
        case 'characteristic': {
          const p = entity(op.property ?? op.subject, ['object', 'data'], 'a property');
          const c = op.characteristic;
          if (!c || !CHARACTERISTICS.includes(c)) throw new Error(`its characteristic has to be one of ${CHARACTERISTICS.join(', ')}`);
          if (kindOfProperty(p) === 'data') {
            if (c !== 'Functional') throw new Error('a data property can only be functional');
            return add({ type: 'FunctionalDataProperty', property: p });
          }
          return add({ type: `${c}ObjectProperty` as ObjectPropertyCharacteristic, property: p });
        }
        case 'subPropertyOf': {
          const sub = entity(op.subject, ['object', 'data'], 'the subproperty');
          const sup = entity(op.property ?? op.object, ['object', 'data'], 'the superproperty');
          if (kindOfProperty(sub) !== kindOfProperty(sup)) throw new Error('an object property and a data property cannot be one the other’s subproperty');
          return add({ type: kindOfProperty(sub) === 'object' ? 'SubObjectPropertyOf' : 'SubDataPropertyOf', sub, sup });
        }
        case 'inverseOf':
          return add({ type: 'InverseObjectProperties', first: entity(op.subject, ['object'], 'an object property'), second: entity(op.property ?? op.object, ['object'], 'an object property') });
        case 'classAssertion':
          return add({ type: 'ClassAssertion', individual: entity(op.subject, ['individual'], 'an individual'), class: cls(op.expression, 'the class') });
        case 'objectPropertyAssertion':
          return add({ type: 'ObjectPropertyAssertion', source: entity(op.subject, ['individual'], 'an individual'), property: entity(op.property, ['object'], 'an object property'), target: entity(op.object, ['individual'], 'an individual as its value') });
        case 'dataPropertyAssertion': {
          const property = entity(op.property, ['data'], 'a data property');
          if (op.value === undefined) throw new Error('it needs a value');
          return add({ type: 'DataPropertyAssertion', source: entity(op.subject, ['individual'], 'an individual'), property, value: literal(op, property) });
        }
        case 'annotation': {
          const subject = entity(op.subject, ['class', 'object', 'data', 'individual'], 'the entity it annotates');
          const property = annotationProperty(op.property);
          if (op.object) return add({ type: 'AnnotationAssertion', property, subject, value: { iri: op.object.replace(/^<|>$/g, '') } });
          if (op.value === undefined) throw new Error('it needs a value');
          return add({ type: 'AnnotationAssertion', property, subject, value: literal(op) });
        }
        default:
          throw new Error(`there is no operation type “${String((op as { type?: unknown }).type)}”`);
      }
    } catch (e) {
      errors.push(`Operation ${i + 1} (${op.action} ${op.type}): ${(e instanceof Error ? e.message : String(e)).replace(/\.$/, '')}.`);
    }
  });
  return { changes, errors, declared };
}

// ---------------------------------------------------------------- reviewing a proposal

/** What a proposal would do, and what stands in its way, by kind (spec §5). */
export interface Review {
  /** The proposal does not read: names that are not there, expressions that do not parse. */
  errors: string[];
  /** The editor's rules refuse it (structural), or cannot hold what it states (unsupported). */
  refusals: { kind: 'structural' | 'unsupported' | 'invalid'; message: string }[];
  notes: string[];
  /** Each axiom added or removed, as the editor writes it, under the entity it is about. */
  lines: { op: 'add' | 'remove'; text: string; about: { name: string; iri: string } }[];
  /** The entities it touches, with what is stated about each before and after (as far as it can be shown). */
  affected: { name: string; iri: string; before: string[]; after: string[] }[];
  /** What the fast reasoner finds before and after, where it was asked. */
  logical?: { inconsistentBefore: boolean; inconsistentAfter: boolean; newlyUnsatisfiable: { name: string; iri: string }[]; noLongerUnsatisfiable: { name: string; iri: string }[] } | { skipped: string };
  /** The change set to apply, made for the revision it was checked against. */
  changeSet?: ChangeSet;
}

const LOGIC_UP_TO = 4000;

/** Checks a proposal against the model as it is now: compiles it, holds it to the editor's rules on a copy, and reasons over the copy. */
export async function review(model: Model, input: Pick<ProposalInput, 'summary' | 'operations'>, ontologyId: string = WORKING_COPY): Promise<Review> {
  const compiled = compile(model, input.operations);
  const naming = namingWith(namingFor(model), compiled.declared);
  const nameOf = (iri: string) => compiled.declared.find((d) => d.iri === iri)?.name ?? findEntity(model, iri)?.name ?? iri;
  const lines = compiled.changes.map((c) => {
    const about = aboutIri(c.axiom);
    return { op: c.op, text: axiomText(c.axiom, naming), about: { name: about ? nameOf(about) : 'the ontology', iri: about ?? '' } };
  });
  const base: Review = { errors: compiled.errors, refusals: [], notes: [], lines, affected: [] };
  if (compiled.errors.length) return base;
  if (!compiled.changes.length) return { ...base, errors: ['It changes nothing.'] };
  const changeSet: ChangeSet = { ontologyId, baseRevision: revisionOf(model), changes: compiled.changes, summary: `Assistant: ${input.summary || 'a proposed change'}`.slice(0, 200) };
  // Tried on a copy, through the same service that would apply it: what it refuses is what would be refused.
  let after = model;
  const scratch = createLocalEditService({ current: () => ({ model: after, ontologyId }), commit: (next) => (after = next) });
  try {
    const done = await scratch.apply(changeSet);
    base.notes.push(...done.notes);
  } catch (e) {
    const refusals = e instanceof EditError && e.refusals.length ? e.refusals : [{ code: 'refused', message: e instanceof Error ? e.message : String(e) }];
    return { ...base, refusals: refusals.map((r) => ({ kind: r.code === 'unsupported' ? 'unsupported' : r.code === 'invalid' ? 'invalid' : 'structural', message: r.message })) };
  }
  // Before and after, for the named entities it touches (a few).
  const touched = [...new Set(lines.map((l) => l.about.iri).filter(Boolean))].slice(0, 8);
  const n2 = namingFor(after);
  const n1 = namingFor(model);
  base.affected = touched.map((iri) => ({ name: nameOf(iri), iri, before: entityAxioms(model, iri).map((a) => axiomText(a, n1)).slice(0, 40), after: entityAxioms(after, iri).map((a) => axiomText(a, n2)).slice(0, 40) }));
  if (model.terms.length > LOGIC_UP_TO) base.logical = { skipped: `The ontology has more than ${LOGIC_UP_TO} terms: what the change does to consistency is checked once it is applied, under Validation.` };
  else {
    const was = reason(model, true);
    const now = reason(after, true);
    const iriOf = (m: Model, id: string) => m.terms.find((t) => t.id === id)?.iri ?? '';
    const named = (m: Model, ids: string[]) => ids.map((id) => ({ name: m.terms.find((t) => t.id === id)?.name ?? id, iri: iriOf(m, id) }));
    const wasIris = new Set([...was.unsatisfiable].map((id) => iriOf(model, id)));
    const nowIris = new Set([...now.unsatisfiable].map((id) => iriOf(after, id)));
    base.logical = {
      inconsistentBefore: !was.consistent,
      inconsistentAfter: !now.consistent,
      newlyUnsatisfiable: named(after, [...now.unsatisfiable].filter((id) => !wasIris.has(iriOf(after, id)))),
      noLongerUnsatisfiable: named(model, [...was.unsatisfiable].filter((id) => !nowIris.has(iriOf(model, id)))),
    };
  }
  return { ...base, changeSet };
}

/** The entity an axiom is told under: its subject, as a frame of Manchester syntax has it. */
function aboutIri(a: Axiom): string | undefined {
  const named = (e: ClassExpression): string | undefined => (e.type === 'Class' ? e.iri : undefined);
  switch (a.type) {
    case 'Declaration':
      return a.iri;
    case 'SubClassOf':
      return named(a.sub) ?? named(a.sup);
    case 'EquivalentClasses':
    case 'DisjointClasses':
      return a.classes.map(named).find(Boolean);
    case 'ClassAssertion':
      return a.individual;
    case 'ObjectPropertyAssertion':
    case 'DataPropertyAssertion':
      return a.source;
    case 'AnnotationAssertion':
      return a.subject;
    case 'SubObjectPropertyOf':
    case 'SubDataPropertyOf':
      return a.sub;
    case 'InverseObjectProperties':
      return a.first;
    default:
      return 'property' in a ? a.property : undefined;
  }
}

// ---------------------------------------------------------------- the tool the model proposes with

const s = (description: string): JsonSchema => ({ type: 'string', description });
const OPERATION: JsonSchema = {
  type: 'object',
  description: 'One axiom to add or remove, or an entity to declare (or take away with everything that names it).',
  properties: {
    action: { type: 'string', enum: ['add', 'remove'], description: 'add, or remove an axiom the ontology states (exactly as it states it).' },
    type: { type: 'string', enum: [...OPERATION_TYPES], description: 'What kind of axiom.' },
    entityKind: { type: 'string', enum: ['class', 'objectProperty', 'dataProperty', 'individual'], description: 'declare: what is declared.' },
    name: s('declare: the new entity’s name (label). Its IRI is made from it unless iri is given.'),
    iri: s('declare: the IRI the new entity is to have (optional).'),
    subject: s('The entity the axiom is about: a class (or, for subClassOf, a class expression), a property or an individual: its name, prefixed name or <IRI>.'),
    expression: s('A class expression in Manchester syntax ("Film and (hasDirector some Director)", "hasPart min 2 Wheel", "not Pizza"); for a data property range, a data range ("xsd:integer[>= 0]"). Quote names with spaces: \'Release date\'.'),
    expressions: { type: 'array', items: s('A class expression in Manchester syntax.'), description: 'equivalentClasses, disjointClasses: the other classes.' },
    property: s('domain, range, characteristic, objectPropertyAssertion, dataPropertyAssertion: the property. subPropertyOf: the superproperty. inverseOf: the inverse. annotation: the annotation property (rdfs:comment, skos:definition, …).'),
    characteristic: { type: 'string', enum: [...CHARACTERISTICS], description: 'characteristic: which.' },
    object: s('objectPropertyAssertion: the individual that is the value. annotation: an IRI value.'),
    value: s('dataPropertyAssertion, annotation: the literal value.'),
    datatype: s('dataPropertyAssertion: the value’s datatype (xsd:integer, …), when it is not the property’s range.'),
    lang: s('annotation, dataPropertyAssertion: the value’s language tag.'),
  },
  required: ['action', 'type'],
};

export const PROPOSE_TOOL: ToolSpec = {
  name: 'proposeChanges',
  description:
    'Proposes changes to the ontology for the user to review. Nothing is changed until the user accepts. Each operation is one axiom to add or remove; declare new entities in the same proposal before naming them. Keep OWL semantics exactly: several domains are several axioms (each holds); an intersection is not a union; restrictions are anonymous class expressions. The answer says whether the proposal reads and what the editor and the reasoner make of it: fix what it reports and propose again if needed.',
  parameters: {
    type: 'object',
    properties: {
      summary: s('In one line, what the change does.'),
      explanation: s('Why: the modelling reasoning, in a few sentences.'),
      impact: s('What it changes semantically: what follows from it, what a reasoner will now conclude, what data it constrains.'),
      concerns: { type: 'array', items: s('A concern: something to check, a risk, an assumption.'), description: 'What the user should check before accepting.' },
      operations: { type: 'array', items: OPERATION, description: 'The operations, in order.' },
    },
    required: ['summary', 'explanation', 'impact', 'operations'],
  },
};

/** The model's proposal, checked for its shape: an error the model can act on where it is not one. */
export function proposalInput(args: unknown): ProposalInput | string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'The arguments have to be a JSON object.';
  const a = args as Record<string, unknown>;
  const text = (k: string, max = 4000) => (typeof a[k] === 'string' ? (a[k] as string).slice(0, max) : '');
  if (!Array.isArray(a.operations) || !a.operations.length) return '“operations” has to be a list of at least one operation.';
  if (a.operations.length > 200) return 'A proposal has at most 200 operations: propose in parts.';
  const ops: Operation[] = [];
  const fields = new Set(Object.keys(OPERATION.properties!));
  for (const [i, o] of (a.operations as unknown[]).entries()) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return `Operation ${i + 1} is not an object.`;
    for (const [k, v] of Object.entries(o)) {
      if (!fields.has(k)) return `Operation ${i + 1} has a field “${k}” that operations do not have.`;
      if (k === 'expressions' ? !Array.isArray(v) || v.some((x) => typeof x !== 'string') : typeof v !== 'string') return `Operation ${i + 1}: “${k}” has the wrong type.`;
    }
    const op = o as Operation;
    if (!OPERATION_TYPES.includes(op.type)) return `Operation ${i + 1}: there is no type “${String(op.type)}”.`;
    if (op.action !== 'add' && op.action !== 'remove') return `Operation ${i + 1}: action has to be add or remove.`;
    ops.push(op);
  }
  return { summary: text('summary', 300), explanation: text('explanation'), impact: text('impact'), concerns: Array.isArray(a.concerns) ? (a.concerns as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20) : [], operations: ops };
}
