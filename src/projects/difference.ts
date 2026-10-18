import type { Axiom, ClassExpression, DataRange } from '../editing/contracts';
import { changesBetween } from '../editing/local';
import { namedClasses, type ClassExpression as ModelClassExpression, type DataRange as ModelDataRange } from '../model/expressions';
import { classText, dataText, literalText, namingFor, type Naming } from '../model/manchester';
import { setTurtle, shapeNaming } from '../model/shapes';
import type { Model } from '../model/types';
import { statementsOf } from '../model/unmapped';
import type { LogicalElement, LogicalModel } from '../logical/contracts';
import { same } from '../logical/rules';
import { fieldText } from '../logical/text';
import type { AxiomLine, DataGraphDifference, Difference, EntityDifference, EntityKind, LogicalElementDifference, LogicalModelDifference, ShapeSetDifference } from './contracts';

/**
 * What differs between two states of a project (roadmap task 2.3, FR-M10-2): the axioms one
 * states and the other does not (`changesBetween`, which compares what each states, statement by
 * statement, so that the order of a file or where a term sits is never a change), told by the
 * entity each is about; the shape sets' statements, set by set; the data graphs; the settings
 * that are no part of the ontology; and whether the drawing alone changed.
 *
 * A name given another value is told as one rename rather than as a label removed and another
 * added, and a class put under another superclass as one move rather than as two subclass
 * statements — each only where exactly one line went and one came, so that nothing is guessed.
 * The paired lines are taken out of the entity's changes; the counts in `axioms` still include them.
 */
export function difference(before: Model, after: Model): Difference {
  const was = namingFor(before);
  const now = namingFor(after);
  const changes = changesBetween(before, after);
  const byEntity = new Map<string, EntityDifference>();
  const kinds = new Map<string, EntityKind>();
  for (const m of [before, after]) {
    for (const t of m.terms) if (t.iri) kinds.set(t.iri, t.type === 'concept' ? 'class' : t.type === 'instance' ? 'individual' : 'data property');
    for (const p of m.props) if (p.iri) kinds.set(p.iri, 'object property');
    for (const d of m.datatypes) if (d.iri) kinds.set(d.iri, 'datatype');
  }
  const nameOf = (iri: string) => after.terms.find((t) => t.iri === iri)?.name || after.props.find((p) => p.iri === iri)?.name || before.terms.find((t) => t.iri === iri)?.name || before.props.find((p) => p.iri === iri)?.name || now.name(iri, 'class');
  for (const c of changes) {
    const about = aboutOf(c.axiom);
    const key = about.iri || about.kind;
    const e = byEntity.get(key) ?? { iri: about.iri, name: about.iri ? nameOf(about.iri) : about.kind === 'ontology' ? 'The ontology' : 'Statements about no entity', kind: about.iri ? (kinds.get(about.iri) ?? declaredKind(c.axiom) ?? 'other') : about.kind, status: 'changed' as const, changes: [] };
    e.changes.push({ op: c.op, text: axiomText(c.axiom, c.op === 'add' ? now : was), axiom: c.axiom });
    byEntity.set(key, e);
  }
  for (const e of byEntity.values()) {
    const declared = (op: 'add' | 'remove') => e.changes.some((c) => c.op === op && c.axiom.type === 'Declaration');
    e.status = declared('add') && !declared('remove') ? 'added' : declared('remove') && !declared('add') ? 'removed' : 'changed';
    // What is added first, then what is removed, each in the order the editor writes them.
    e.changes.sort((a, b) => (a.op === b.op ? a.text.localeCompare(b.text) : a.op === 'add' ? -1 : 1));
    const names = new Set([RDFS_LABEL, SKOS_PREF_LABEL]);
    // The ontology's own name is written with the property the model says it is.
    if (e.kind === 'ontology') for (const [m, n] of [[before, was], [after, now]] as const) {
      const property = m.namedBy ? n.expand(m.namedBy) : undefined;
      if (property) names.add(property);
    }
    pair(e, names, nameOf);
  }
  const order: Record<EntityDifference['status'], number> = { changed: 0, added: 1, removed: 2 };
  const entities = [...byEntity.values()].sort((a, b) => Number(b.kind === 'ontology') - Number(a.kind === 'ontology') || order[a.status] - order[b.status] || a.name.localeCompare(b.name));

  // The shape sets, set by set: their statements, and what each is called.
  const shapeSets: ShapeSetDifference[] = [];
  for (const id of new Set([...before.shapeSets, ...after.shapeSets].map((s) => s.id))) {
    const a = before.shapeSets.find((s) => s.id === id);
    const b = after.shapeSets.find((s) => s.id === id);
    const texts = (m: Model, set: typeof a) => (set ? statementsOf(setTurtle(m, set)).map((x) => x.text) : []);
    const ta = new Set(texts(before, a));
    const tb = new Set(texts(after, b));
    const naming = shapeNaming(after, b ?? a);
    const short = (t: string) => t.replace(/<([^>]*)>/g, (m, iri: string) => (/^_:/.test(iri) ? m : naming.name(iri))).replace(/"(-?\d+)"\^\^xsd:integer/g, '$1');
    const lines = [...[...tb].filter((t) => !ta.has(t)).map((t) => ({ op: 'add' as const, text: short(t) })), ...[...ta].filter((t) => !tb.has(t)).map((t) => ({ op: 'remove' as const, text: short(t) }))];
    const renamed = a && b && (a.name !== b.name || a.description !== b.description || a.namespace !== b.namespace) ? (a.name !== b.name ? `renamed from “${a.name}”` : 'its purpose or namespace changed') : undefined;
    if (!a || !b || lines.length || renamed) shapeSets.push({ id, name: (b ?? a)!.name || 'Shapes', status: !a ? 'added' : !b ? 'removed' : 'changed', changes: lines, ...(renamed ? { renamed } : {}) });
  }

  // The data graphs the project names: their content is in the browser, and is told apart by its fingerprint.
  const dataGraphs: DataGraphDifference[] = [];
  for (const id of new Set([...before.dataGraphs, ...after.dataGraphs].map((g) => g.id))) {
    const a = before.dataGraphs.find((g) => g.id === id);
    const b = after.dataGraphs.find((g) => g.id === id);
    const status = !a ? 'added' : !b ? 'removed' : a.fingerprint !== b.fingerprint ? 'replaced' : a.name !== b.name || a.includeOntology !== b.includeOntology ? 'changed' : undefined;
    if (status) dataGraphs.push({ id, name: (b ?? a)!.name, status });
  }

  const same = (x: unknown, y: unknown) => x === y || JSON.stringify(x) === JSON.stringify(y);
  const settings = (
    [
      ['quality', 'the quality rules'],
      ['governance', 'the metadata fields'],
      ['mappings', 'the mappings'],
      ['rejected', 'the mappings turned down'],
      ['externals', 'the other ontologies'],
      ['vocab', 'the standard properties'],
      ['prefixes', 'the prefixes'],
    ] as const
  )
    .filter(([k]) => !same(before[k], after[k]))
    .map(([, label]) => label);
  const logical = logicalDifference(before.logicalModels, after.logicalModels);
  const drawing = !same(before.style, after.style) || !same(before.layout, after.layout) || !same(positions(before), positions(after)) || logical.diagrams;
  return { entities, shapeSets, dataGraphs, logicalModels: logical.models, settings, drawing, axioms: { added: changes.filter((c) => c.op === 'add').length, removed: changes.filter((c) => c.op === 'remove').length } };
}

/** The properties an entity's name is written with: the two the editor reads names from, and the ontology's own where it says. */
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_PREF_LABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel';

/** The value of a name line of the entity, where it is one. */
function nameLine(c: AxiomLine, entity: EntityDifference, names: ReadonlySet<string>): string | undefined {
  const a = c.axiom;
  if (a.type === 'AnnotationAssertion') {
    if (a.subject !== entity.iri || !names.has(a.property) || !('value' in a.value)) return undefined;
    return a.value.value;
  }
  // The ontology's own name is said of the ontology, not of an entity that happens to share its IRI.
  if (a.type === 'OntologyAnnotation' && entity.kind === 'ontology' && names.has(a.property) && 'value' in a.value) return a.value.value;
  return undefined;
}

/** The named superclass of a `SubClassOf` that puts this class under it, where that is what the line says. */
function superOf(c: AxiomLine, entity: EntityDifference): string | undefined {
  const a = c.axiom;
  // Not an anonymous superclass, nor an expression around the class: only a class put under a named class.
  return a.type === 'SubClassOf' && a.sub.type === 'Class' && a.sub.iri === entity.iri && a.sup.type === 'Class' ? a.sup.iri : undefined;
}

/**
 * Tells a renamed entity and a moved class as one change each, where exactly one line went and
 * one came. A name in two languages, or a class both given a superclass and moved, stays as the
 * lines it is: nothing is guessed.
 */
function pair(e: EntityDifference, names: ReadonlySet<string>, nameOf: (iri: string) => string): void {
  const gone = e.changes.filter((c) => c.op === 'remove');
  const came = e.changes.filter((c) => c.op === 'add');
  const drop = (...lines: AxiomLine[]) => {
    e.changes = e.changes.filter((c) => !lines.includes(c));
  };
  const namesGone = gone.filter((c) => nameLine(c, e, names) !== undefined);
  const namesCame = came.filter((c) => nameLine(c, e, names) !== undefined);
  if (namesGone.length === 1 && namesCame.length === 1) {
    e.renamed = { from: nameLine(namesGone[0], e, names)!, to: nameLine(namesCame[0], e, names)! };
    drop(namesGone[0], namesCame[0]);
  }
  if (e.kind !== 'class') return;
  const movesGone = gone.filter((c) => superOf(c, e) !== undefined);
  const movesCame = came.filter((c) => superOf(c, e) !== undefined);
  if (movesGone.length === 1 && movesCame.length === 1) {
    e.moved = { from: nameOf(superOf(movesGone[0], e)!), to: nameOf(superOf(movesCame[0], e)!) };
    drop(movesGone[0], movesCame[0]);
  }
}

/** The elements of an LDM by id, each as a change would name it; a diagram is the picture and is not among them. */
function elementsOf(m: LogicalModel): Map<string, LogicalElement> {
  const out = new Map<string, LogicalElement>();
  for (const entity of m.entities) {
    out.set(entity.id, { kind: 'entity', entity });
    for (const attribute of entity.attributes) out.set(attribute.id, { kind: 'attribute', entity: entity.id, attribute });
    for (const key of entity.keys) out.set(key.id, { kind: 'key', entity: entity.id, key });
  }
  for (const relationship of m.relationships) out.set(relationship.id, { kind: 'relationship', relationship });
  for (const generalization of m.generalizations) out.set(generalization.id, { kind: 'generalization', generalization });
  for (const rule of m.rules) out.set(rule.id, { kind: 'rule', rule });
  for (const domain of m.domains) out.set(domain.id, { kind: 'domain', domain });
  for (const mapping of m.mappings) out.set(mapping.id, { kind: 'mapping', mapping });
  return out;
}

/** An element's own fields: for an entity, not its attributes and keys, which are elements of their own. */
function fieldsOf(e: LogicalElement): Record<string, unknown> {
  const { id: _id, ...rest } = (e as unknown as Record<string, Record<string, unknown>>)[e.kind];
  if (e.kind === 'entity') {
    const { attributes: _a, keys: _k, ...own } = rest;
    return own;
  }
  return rest;
}

function elementName(e: LogicalElement, m: LogicalModel): string {
  const owner = (id: string) => m.entities.find((x) => x.id === id)?.name ?? id;
  switch (e.kind) {
    case 'entity':
      return e.entity.name;
    case 'attribute':
      return `${owner(e.entity)}.${e.attribute.name}`;
    case 'key':
      return `${e.key.name || e.key.kind} of ${owner(e.entity)}`;
    case 'relationship':
      return e.relationship.name || `${owner(e.relationship.ends[0].entity)} to ${owner(e.relationship.ends[1].entity)}`;
    case 'generalization':
      return `the subtypes of ${owner(e.generalization.supertype)}`;
    case 'rule':
      return e.rule.name;
    case 'domain':
      return e.domain.name;
    default:
      return e.kind;
  }
}

/**
 * What differs between two lists of LDMs: each LDM added, removed or changed, and in a changed one
 * each element added, removed or changed, with the fields that changed. Revisions are no change;
 * where entities sit on a diagram is the drawing.
 */
function logicalDifference(before: LogicalModel[], after: LogicalModel[]): { models: LogicalModelDifference[]; diagrams: boolean } {
  const models: LogicalModelDifference[] = [];
  let diagrams = false;
  const ORDER = ['model', 'entity', 'attribute', 'key', 'relationship', 'generalization', 'domain', 'rule', 'mapping'];
  for (const id of new Set([...before, ...after].map((m) => m.id))) {
    const a = before.find((m) => m.id === id);
    const b = after.find((m) => m.id === id);
    if (!a || !b) {
      models.push({ id, name: (b ?? a)!.name, status: !a ? 'added' : 'removed', changes: [] });
      continue;
    }
    if (!same(a.diagrams, b.diagrams)) diagrams = true;
    const changes: LogicalElementDifference[] = [];
    const header = (['name', 'description', 'purpose'] as const).filter((k) => a[k] !== b[k]);
    if (header.length) changes.push({ op: 'update', kind: 'model', name: b.name, fields: header.map((k) => ({ field: k, before: a[k] || '(empty)', after: b[k] || '(empty)' })) });
    const ea = elementsOf(a);
    const eb = elementsOf(b);
    for (const [eid, x] of eb) if (!ea.has(eid)) changes.push({ op: 'add', kind: x.kind, name: elementName(x, b) });
    for (const [eid, x] of ea) if (!eb.has(eid)) changes.push({ op: 'remove', kind: x.kind, name: elementName(x, a) });
    for (const [eid, y] of eb) {
      const x = ea.get(eid);
      if (!x) continue;
      const fa = fieldsOf(x);
      const fb = fieldsOf(y);
      const fields = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => !same(fa[k], fb[k])).map((k) => ({ field: k, before: fieldText(k, fa[k], a), after: fieldText(k, fb[k], b) }));
      if (fields.length) changes.push({ op: 'update', kind: y.kind, name: elementName(y, b), fields });
    }
    changes.sort((p, q) => ORDER.indexOf(p.kind) - ORDER.indexOf(q.kind) || p.name.localeCompare(q.name));
    if (changes.length) models.push({ id, name: b.name, status: 'changed', changes });
  }
  return { models, diagrams };
}

const positions = (m: Model) => m.terms.map((t) => `${t.id} ${Math.round(t.x)} ${Math.round(t.y)}`).join('\n');

/** Whether a difference has anything to tell but the drawing. */
export const nothingChanged = (d: Difference): boolean => !d.entities.length && !d.shapeSets.length && !d.dataGraphs.length && !d.logicalModels.length && !d.settings.length;

const DECLARED: Record<string, EntityKind> = { Class: 'class', ObjectProperty: 'object property', DataProperty: 'data property', AnnotationProperty: 'annotation property', NamedIndividual: 'individual', Datatype: 'datatype' };
const declaredKind = (a: Axiom): EntityKind | undefined => (a.type === 'Declaration' ? DECLARED[a.entity] : undefined);

/** The entity an axiom is about, the one it is told under: its subject, as a frame of Manchester syntax has it. */
function aboutOf(a: Axiom): { iri: string; kind: EntityKind } {
  const first = (e: ClassExpression) => (e.type === 'Class' ? e.iri : namedClasses(e as ModelClassExpression)[0]);
  const of = (iri: string | undefined) => (iri ? { iri, kind: 'other' as const } : { iri: '', kind: 'other' as const });
  switch (a.type) {
    case 'Declaration':
      return of(a.iri);
    case 'SubClassOf':
      return of(first(a.sub) ?? first(a.sup));
    case 'EquivalentClasses':
    case 'DisjointClasses':
      return of(a.classes.map(first).find(Boolean));
    case 'ClassAssertion':
      return of(a.individual);
    case 'ObjectPropertyAssertion':
    case 'DataPropertyAssertion':
      return of(a.source);
    case 'SameIndividual':
    case 'DifferentIndividuals':
      return of(a.individuals[0]);
    case 'SubObjectPropertyOf':
    case 'SubDataPropertyOf':
    case 'SubAnnotationPropertyOf':
      return of(a.sub);
    case 'SubPropertyChainOf':
      return of(a.sup);
    case 'HasKey':
    case 'DisjointUnion':
      return of(a.class);
    case 'NegativeObjectPropertyAssertion':
    case 'NegativeDataPropertyAssertion':
      return of(a.source);
    case 'EquivalentObjectProperties':
    case 'DisjointObjectProperties':
    case 'EquivalentDataProperties':
    case 'DisjointDataProperties':
      return of(a.properties[0]);
    case 'InverseObjectProperties':
      return of(a.first);
    case 'DatatypeDefinition':
      return of(a.datatype);
    case 'AnnotationAssertion':
      return of(a.subject);
    case 'Ontology':
    case 'OntologyAnnotation':
    case 'Import':
      return { iri: '', kind: 'ontology' };
    case 'Unmapped':
      return of(/^<([^>]+)>/.exec(a.turtle)?.[1]);
    default:
      return of('property' in a ? a.property : undefined);
  }
}

/** An axiom as the editor writes it: Manchester syntax, its entities by name. */
export function axiomText(a: Axiom, n: Naming): string {
  const c = (e: ClassExpression) => classText(e as ModelClassExpression, n);
  const d = (r: DataRange) => dataText(r as ModelDataRange, n);
  const obj = (iri: string) => n.name(iri, 'object');
  const dat = (iri: string) => n.name(iri, 'data');
  const ind = (iri: string) => n.name(iri, 'individual');
  const any = (iri: string) => {
    const kinds = n.kindsOf(iri);
    return n.name(iri, kinds[0] ?? 'class');
  };
  const value = (v: { iri: string } | { value: string; lang?: string; datatype?: string }) => ('iri' in v ? any(v.iri) : literalText(v, n));
  switch (a.type) {
    case 'Declaration':
      return `${a.entity === 'NamedIndividual' ? 'Individual' : a.entity}: ${n.name(a.iri, a.entity === 'Class' ? 'class' : a.entity === 'ObjectProperty' ? 'object' : a.entity === 'DataProperty' ? 'data' : a.entity === 'NamedIndividual' ? 'individual' : a.entity === 'Datatype' ? 'datatype' : 'object')}`;
    case 'SubClassOf':
      return `${c(a.sub)} SubClassOf ${c(a.sup)}`;
    case 'EquivalentClasses':
      return a.classes.length === 2 ? `${c(a.classes[0])} EquivalentTo ${c(a.classes[1])}` : `EquivalentClasses: ${a.classes.map(c).join(', ')}`;
    case 'DisjointClasses':
      return a.classes.length === 2 ? `${c(a.classes[0])} DisjointWith ${c(a.classes[1])}` : `DisjointClasses: ${a.classes.map(c).join(', ')}`;
    case 'ClassAssertion':
      return `${ind(a.individual)} Type ${c(a.class)}`;
    case 'ObjectPropertyAssertion':
      return `${ind(a.source)} ${obj(a.property)} ${ind(a.target)}`;
    case 'DataPropertyAssertion':
      return `${ind(a.source)} ${dat(a.property)} ${literalText(a.value, n)}`;
    case 'SameIndividual':
      return `SameIndividual: ${a.individuals.map(ind).join(', ')}`;
    case 'DifferentIndividuals':
      return `DifferentIndividuals: ${a.individuals.map(ind).join(', ')}`;
    case 'SubObjectPropertyOf':
      return `${obj(a.sub)} SubPropertyOf ${obj(a.sup)}`;
    case 'SubDataPropertyOf':
      return `${dat(a.sub)} SubPropertyOf ${dat(a.sup)}`;
    case 'SubAnnotationPropertyOf':
      return `${any(a.sub)} SubPropertyOf ${any(a.sup)}`;
    case 'SubPropertyChainOf':
      return `${a.chain.map((p) => (p.type === 'ObjectInverseOf' ? `inverse ${obj(p.property.iri)}` : obj(p.iri))).join(' o ')} SubPropertyOf ${obj(a.sup)}`;
    case 'HasKey':
      return `${c({ type: 'Class', iri: a.class })} HasKey: ${a.properties.map((p) => (p.type === 'ObjectProperty' ? obj(p.iri) : dat(p.iri))).join(', ')}`;
    case 'DisjointUnion':
      return `${c({ type: 'Class', iri: a.class })} DisjointUnionOf: ${a.classes.map(c).join(', ')}`;
    case 'NegativeObjectPropertyAssertion':
      return `${ind(a.source)} not ${obj(a.property)} ${ind(a.target)}`;
    case 'NegativeDataPropertyAssertion':
      return `${ind(a.source)} not ${dat(a.property)} ${literalText(a.value, n)}`;
    case 'EquivalentObjectProperties':
    case 'DisjointObjectProperties':
      return `${a.type.startsWith('Equivalent') ? 'EquivalentProperties' : 'DisjointProperties'}: ${a.properties.map(obj).join(', ')}`;
    case 'EquivalentDataProperties':
    case 'DisjointDataProperties':
      return `${a.type.startsWith('Equivalent') ? 'EquivalentProperties' : 'DisjointProperties'}: ${a.properties.map(dat).join(', ')}`;
    case 'InverseObjectProperties':
      return `${obj(a.first)} InverseOf ${obj(a.second)}`;
    case 'ObjectPropertyDomain':
      return `${obj(a.property)} Domain ${c(a.domain)}`;
    case 'DataPropertyDomain':
      return `${dat(a.property)} Domain ${c(a.domain)}`;
    case 'ObjectPropertyRange':
      return `${obj(a.property)} Range ${c(a.range)}`;
    case 'DataPropertyRange':
      return `${dat(a.property)} Range ${d(a.range)}`;
    case 'FunctionalDataProperty':
      return `${dat(a.property)} Characteristics: Functional`;
    case 'DatatypeDefinition':
      return `Datatype: ${n.name(a.datatype, 'datatype')} EquivalentTo ${d(a.range)}`;
    case 'AnnotationAssertion':
      return `${any(a.subject)} ${n.name(a.property, 'object')} ${value(a.value)}`;
    case 'Ontology':
      return `Ontology: <${a.iri}>`;
    case 'OntologyAnnotation':
      return `Ontology annotation: ${n.name(a.property, 'object')} ${value(a.value)}`;
    case 'Import':
      return `Import: <${a.iri}>`;
    case 'Unmapped':
      return a.turtle.replace(/<([^>]*)>/g, (_m, iri: string) => any(iri));
    default:
      return `${obj(a.property)} Characteristics: ${a.type.replace(/ObjectProperty$/, '')}`;
  }
}

/**
 * The lines of a difference that are about one entity, by its IRI: for telling where an edit
 * went. A rename or a move is said by the entity's `renamed` or `moved`, not among these lines.
 */
export const changesOf = (d: Difference, iri: string): AxiomLine[] => d.entities.find((e) => e.iri === iri)?.changes ?? [];
