import { describe, expect, it } from 'vitest';
import { withIris } from '../model/iri';
import { sampleModel } from '../model/sample';
import { emptyModel, newProp, newRelation, newTerm, type Model } from '../model/types';
import type { LogicalAttribute, LogicalModel, TransformationConfig } from '../logical/contracts';
import { createLocalLogicalServices } from '../logical/local';
import { applied, emptyLogicalModel, logicalModelFrom, transformationConfigFrom } from '../logical/rules';
import { isStrategyId, strategyForText } from '../logical/strategies';
import { createLocalTransformationService, onThePage } from './local';
import type { TransformationProposal } from './contracts';
import { chosenByDefault, defaultTransformationConfig, hasKeyStatements, proposalsFor } from './transform';

const origin = { ontology: 'film', revision: 'rev-1' };
const ontology = () => withIris(sampleModel());
const ldm = () => emptyLogicalModel({ name: 'Film LDM', purpose: 'Cinema catalogue' });

const propose = (model: Model, target: LogicalModel, config: TransformationConfig = defaultTransformationConfig()) => proposalsFor({ model, target, config, origin });

const iriOf = (m: Model, name: string) => m.terms.find((t) => t.name === name)!.iri!;
const propIriOf = (m: Model, name: string) => m.props.find((p) => p.name === name)!.iri!;

/** The generalization a specialization proposal adds. */
function generalizationOf(p: TransformationProposal) {
  const add = p.changes.find((c) => c.op === 'add' && c.element.kind === 'generalization');
  if (!add || add.op !== 'add' || add.element.kind !== 'generalization') throw new Error('no generalization in the proposal');
  return add.element.generalization;
}

/** The attribute a proposal adds and the entity it is added to. */
function addedAttribute(p: TransformationProposal): { entity: string; attribute: LogicalAttribute } {
  const add = p.changes.find((c) => c.op === 'add' && c.element.kind === 'attribute');
  if (!add || add.op !== 'add' || add.element.kind !== 'attribute') throw new Error('no attribute in the proposal');
  return { entity: add.element.entity, attribute: add.element.attribute };
}

/**
 * The example ontology with an enumerated class and an object property that links Film to it:
 * from Film to the class (forward), from the class to Film (reversed), or a pair of both.
 */
function enumerationModel(kind: 'forward' | 'reversed' | 'pair' = 'forward') {
  const m = ontology();
  const red = newTerm({ name: 'Red', type: 'instance' });
  const green = newTerm({ name: 'Green', type: 'instance' });
  const signalIri = 'http://example.org/film#SignalColour';
  m.terms.push(red, green, newTerm({ name: 'Signal colour', oneOf: [red.id, green.id], iri: signalIri }));
  const filmIri = iriOf(m, 'Film');
  const forward = newProp({ name: 'has colour', description: '', chars: [] });
  forward.domains = [{ id: 'd-film', expression: { type: 'Class', iri: filmIri } }];
  forward.ranges = [{ id: 'r-signal', expression: { type: 'Class', iri: signalIri } }];
  const backward = newProp({ name: 'is colour of', description: '', chars: [] });
  backward.domains = [{ id: 'd-signal', expression: { type: 'Class', iri: signalIri } }];
  backward.ranges = [{ id: 'r-film', expression: { type: 'Class', iri: filmIri } }];
  if (kind === 'forward') m.props.push(forward);
  else if (kind === 'reversed') m.props.push(backward);
  else {
    forward.inverses = [backward.id];
    backward.inverses = [forward.id];
    m.props.push(forward, backward);
  }
  const model = withIris(m);
  const iriOfProp = (p: typeof forward) => model.props.find((x) => x.id === p.id)?.iri ?? '';
  return { model, filmIri, signalIri, forwardIri: iriOfProp(forward), backwardIri: iriOfProp(backward) };
}

/** What applying every structural proposal (the acceptance's "accept all") gives. */
function acceptStructure(model: Model, target: LogicalModel, config: TransformationConfig = defaultTransformationConfig()): { result: LogicalModel; proposals: number } {
  const proposed = propose(model, target, config);
  const accepted = proposed.proposals.filter(chosenByDefault);
  const changed = applied(target, accepted.flatMap((p) => p.changes));
  if (!changed.next) throw new Error(changed.refusals.map((r) => r.message).join('\n'));
  return { result: changed.next, proposals: accepted.length };
}

describe('the transformation proposals for the example ontology', () => {
  it('offers a structure proposal for every class, datatype property, object property and subclass edge', () => {
    const result = propose(ontology(), ldm());
    const count = (kind: string) => result.proposals.filter((p) => p.kind === kind).length;
    expect({ entity: count('entity'), attribute: count('attribute'), relationship: count('relationship'), specialization: count('specialization'), domain: count('domain'), constraint: count('constraint') }).toEqual({ entity: 8, attribute: 2, relationship: 5, specialization: 2, domain: 0, constraint: 0 });
    expect(result.proposals.every((p) => !p.candidate)).toBe(true);
    expect(result.scope.classes).toHaveLength(8);
    expect(result.skipped).toEqual([]);
  });

  it('accepting all of it makes an entity per class, an attribute per datatype property and a relationship per object property, with nothing mandatory', () => {
    const model = ontology();
    const target = ldm();
    const { result } = acceptStructure(model, target);
    expect(result.entities.map((e) => e.name).sort()).toEqual(['Actor', 'Award', 'Director', 'Documentary', 'Film', 'Genre', 'Person', 'Studio']);
    expect(result.entities.flatMap((e) => e.attributes.map((a) => `${e.name}.${a.name}`)).sort()).toEqual(['Film.Release date', 'Film.Running time']);
    expect(result.entities.flatMap((e) => e.attributes).every((a) => a.optional)).toBe(true);
    expect(result.entities.flatMap((e) => e.keys)).toEqual([]);
    expect(result.rules).toEqual([]);
    expect(result.relationships).toHaveLength(5);
    for (const r of result.relationships) {
      expect(r.ends.map((e) => e.min)).toEqual([0, 0]);
      expect(r.ends.map((e) => e.max)).toEqual(['many', 'many']);
    }
    expect(result.generalizations.map((g) => g.subtypes.length).sort()).toEqual([1, 2]);
    expect(result.generalizations.every((g) => !g.complete && !g.exclusive)).toBe(true);
    // Every element made is in a mapping that says where it came from.
    const targets = new Set(result.mappings.flatMap((m) => m.targets.flatMap((t) => Object.values(t))));
    for (const e of result.entities) expect(targets.has(e.id)).toBe(true);
    for (const a of result.entities.flatMap((e) => e.attributes)) expect(targets.has(a.id)).toBe(true);
    for (const r of result.relationships) expect(targets.has(r.id)).toBe(true);
  });

  it('changes neither the LDM nor the ontology when nothing is accepted, and the ontology when it is', () => {
    const model = ontology();
    const target = ldm();
    const beforeModel = JSON.parse(JSON.stringify(model));
    const beforeTarget = JSON.parse(JSON.stringify(target));
    const result = propose(model, target);
    expect(target).toEqual(beforeTarget);
    expect(model).toEqual(beforeModel);
    const ids = result.proposals.filter(chosenByDefault).map((p) => p.id);
    acceptStructure(model, target);
    expect(model).toEqual(beforeModel);
    expect(ids.length).toBe(17);
  });

  it('proposes nothing over what the user has changed since', () => {
    const model = ontology();
    const target = ldm();
    const first = acceptStructure(model, target).result;
    const film = first.entities.find((e) => e.name === 'Film')!;
    film.name = 'Movie';
    film.attributes.find((a) => a.name === 'Release date')!.optional = false;
    const again = propose(model, first);
    expect(again.proposals).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
    expect(again.skipped.map((s) => s.reason)).toContain('already represented by an entity');
  });

  it('gives an inverse pair one relationship with the two roles', () => {
    const model = ontology();
    const acts = model.props.find((p) => p.name === 'acts in')!;
    const directs = model.props.find((p) => p.name === 'directs')!;
    acts.inverses = [directs.id];
    directs.inverses = [acts.id];
    const proposed = propose(model, ldm());
    const relationships = proposed.proposals.filter((p) => p.kind === 'relationship');
    expect(relationships).toHaveLength(4);
    const pair = relationships.find((p) => p.strategy.includes('inverse'));
    expect(pair?.strategy).toBe('inverse property pair → one relationship with two roles');
    expect(pair?.sources.map((s) => s.iri).sort()).toEqual([propIriOf(model, 'acts in'), propIriOf(model, 'directs')].sort());
    const relationship = pair!.changes.find((c) => c.op === 'add' && c.element.kind === 'relationship');
    if (!relationship || relationship.op !== 'add' || relationship.element.kind !== 'relationship') throw new Error('no relationship in the proposal');
    expect(relationship.element.relationship.ends.map((e) => e.role).sort()).toEqual(['acts in', 'directs']);
  });

  it('rolls a hierarchy up into one entity with a discriminator, or down into copied attributes', () => {
    const model = ontology();
    const up = acceptStructure(model, ldm(), { ...defaultTransformationConfig(), hierarchy: 'rollup' }).result;
    expect(up.entities.map((e) => e.name).sort()).toEqual(['Award', 'Film', 'Genre', 'Person', 'Studio']);
    expect(up.generalizations).toEqual([]);
    expect(up.entities.find((e) => e.name === 'Person')!.attributes.map((a) => a.name)).toEqual(['type']);
    expect(up.entities.find((e) => e.name === 'Film')!.attributes.map((a) => a.name).sort()).toEqual(['Release date', 'Running time', 'type']);

    const down = acceptStructure(model, ldm(), { ...defaultTransformationConfig(), hierarchy: 'rolldown' }).result;
    expect(down.entities).toHaveLength(8);
    expect(down.generalizations).toEqual([]);
    expect(down.entities.find((e) => e.name === 'Documentary')!.attributes.map((a) => a.name).sort()).toEqual(['Release date', 'Running time']);
  });

  it('resolves a many-to-many object property into an associative entity when the configuration says so', () => {
    const model = ontology();
    const config: TransformationConfig = { ...defaultTransformationConfig(), objectProperties: 'associative' };
    const proposed = propose(model, ldm(), config);
    const associative = proposed.proposals.filter((p) => p.strategy.includes('associative entity'));
    expect(associative).toHaveLength(5);
    const { result } = acceptStructure(model, ldm(), config);
    expect(result.entities).toHaveLength(13);
    expect(result.relationships.filter((r) => r.identifying)).toHaveLength(10);
    for (const entity of result.entities.filter((e) => e.keys.length)) expect(entity.keys[0].kind).toBe('primary');
  });

  it('offers a functional object property with at most one at its end, and says why', () => {
    const model = ontology();
    model.props.find((p) => p.name === 'acts in')!.chars = ['functional'];
    const proposed = propose(model, ldm());
    const p = proposed.proposals.find((x) => x.kind === 'relationship' && x.title.includes('acts in'))!;
    expect(p.rationale).toContain('functional');
    const add = p.changes.find((c) => c.op === 'add' && c.element.kind === 'relationship');
    if (!add || add.op !== 'add' || add.element.kind !== 'relationship') throw new Error('no relationship in the proposal');
    expect(add.element.relationship.ends[1].max).toBe(1);
  });

  it('offers restrictions and owl:hasKey as candidate constraints only', () => {
    const model = ontology();
    const film = iriOf(model, 'Film');
    const directs = propIriOf(model, 'directs');
    const running = iriOf(model, 'Running time');
    model.terms.find((t) => t.name === 'Director')!.classAxioms = [{ id: 'ax-1', kind: 'SubClassOf', expression: { type: 'ObjectSomeValuesFrom', property: { type: 'ObjectProperty', iri: directs }, filler: { type: 'Class', iri: film } } }];
    model.terms.find((t) => t.name === 'Film')!.classAxioms = [{ id: 'ax-2', kind: 'SubClassOf', expression: { type: 'DataSomeValuesFrom', property: { type: 'DataProperty', iri: running }, filler: { type: 'Datatype', iri: 'http://www.w3.org/2001/XMLSchema#integer' } } }];
    const release = iriOf(model, 'Release date');
    const releaseTerm = model.terms.find((t) => t.name === 'Release date')!;
    const runningTerm = model.terms.find((t) => t.name === 'Running time')!;
    model.terms.find((t) => t.name === 'Film')!.keys = [{ id: 'key-1', properties: [{ data: releaseTerm.id }, { data: runningTerm.id }] }];

    expect(hasKeyStatements(model)).toEqual([{ classIri: film, properties: [release, running], axiom: `HasKey(<${film}> (<${release}> <${running}>))` }]);
    const proposed = propose(model, ldm());
    const constraints = proposed.proposals.filter((p) => p.kind === 'constraint');
    expect(constraints).toHaveLength(3);
    expect(constraints.every((p) => p.candidate)).toBe(true);
    expect(constraints.map((p) => p.strategy)).toEqual(expect.arrayContaining(['restriction → candidate mandatory attribute', 'restriction → candidate mandatory on directs', 'owl:hasKey → candidate key']));

    // Only when the user takes them: the candidate key is on all the attributes it names, the end is mandatory.
    const structural = proposed.proposals.filter(chosenByDefault);
    const chosen = [...structural, ...constraints];
    const changed = applied(ldm(), chosen.flatMap((p) => p.changes));
    expect(changed.refusals).toEqual([]);
    const result = changed.next!;
    const filmEntity = result.entities.find((e) => e.name === 'Film')!;
    expect(filmEntity.attributes.find((a) => a.name === 'Running time')!.optional).toBe(false);
    expect(filmEntity.keys[0].kind).toBe('candidate');
    expect(filmEntity.keys[0].members).toHaveLength(2);
    const directsRelationship = result.relationships.find((r) => r.name === 'directs')!;
    expect(directsRelationship.ends.find((e) => e.entity === result.entities.find((x) => x.name === 'Film')!.id)!.min).toBe(1);
  });

  it('states a specialization complete and exclusive when the ontology says the subtypes are a disjoint union', () => {
    const model = ontology();
    const person = iriOf(model, 'Person');
    const actor = iriOf(model, 'Actor');
    const director = iriOf(model, 'Director');
    // Actor and Director have no member in common: the subtypes are exclusive, not exhaustive.
    model.terms.find((t) => t.name === 'Actor')!.classAxioms = [{ id: 'ax-disjoint', kind: 'DisjointClasses', expression: { type: 'Class', iri: director } }];
    const pairwise = propose(model, ldm()).proposals.find((p) => p.kind === 'specialization' && p.title.includes('Person'))!;
    expect(generalizationOf(pairwise)).toMatchObject({ complete: false, exclusive: true });
    expect(pairwise.rationale).toBe('Actor, Director are stated to be a kind of Person; the ontology states that they are exclusive.');
    expect(pairwise.sources[0].axioms).toContain(`DisjointClasses(<${actor}> <${director}>)`);

    // A disjoint union of exactly the subtypes adds completeness.
    model.terms.find((t) => t.name === 'Person')!.disjointUnions = [{ id: 'u-1', classes: [{ type: 'Class', iri: actor }, { type: 'Class', iri: director }] }];
    const union = propose(model, ldm()).proposals.find((p) => p.kind === 'specialization' && p.title.includes('Person'))!;
    expect(generalizationOf(union)).toMatchObject({ complete: true, exclusive: true });
    expect(union.rationale).toBe('Actor, Director are stated to be a kind of Person; the ontology states that they are complete and exclusive.');
    expect(union.sources[0].axioms).toContain(`DisjointUnion(<${person}> <${actor}> <${director}>)`);
  });

  it('puts a data property stated at a class and its subtype once, on the supertype the subtype inherits it from', () => {
    const model = ontology();
    const release = model.terms.find((t) => t.name === 'Release date')!;
    release.domains = [
      { id: 'd-person', expression: { type: 'Class', iri: iriOf(model, 'Person') } },
      { id: 'd-actor', expression: { type: 'Class', iri: iriOf(model, 'Actor') } },
    ];
    const { result } = acceptStructure(model, ldm());
    expect(result.entities.find((e) => e.name === 'Person')!.attributes.map((a) => a.name)).toEqual(['Release date']);
    expect(result.entities.find((e) => e.name === 'Actor')!.attributes).toEqual([]);
  });

  it('puts an object property stated at a class and its subtype once, on the supertype the subtype inherits it from', () => {
    const model = ontology();
    const directs = model.props.find((p) => p.name === 'directs')!;
    directs.domains = [
      { id: 'd-person', expression: { type: 'Class', iri: iriOf(model, 'Person') } },
      { id: 'd-actor', expression: { type: 'Class', iri: iriOf(model, 'Actor') } },
    ];
    directs.ranges = [{ id: 'r-film', expression: { type: 'Class', iri: iriOf(model, 'Film') } }];
    const { result } = acceptStructure(model, ldm());
    const named = result.relationships.filter((r) => r.name === 'directs');
    expect(named).toHaveLength(1);
    expect(result.entities.find((e) => e.id === named[0].ends[0].entity)!.name).toBe('Person');
  });

  it('offers a subclass’s owl:hasKey over properties it inherits', () => {
    const model = ontology();
    const release = model.terms.find((t) => t.name === 'Release date')!;
    release.domains = [{ id: 'd-person', expression: { type: 'Class', iri: iriOf(model, 'Person') } }];
    model.terms.find((t) => t.name === 'Actor')!.keys = [{ id: 'key-1', properties: [{ data: release.id }] }];
    const proposed = propose(model, ldm());
    const keyProposal = proposed.proposals.find((p) => p.strategy === 'owl:hasKey → candidate key')!;
    expect(keyProposal.title).toBe('Candidate key on Actor: Release date');
    expect(proposed.skipped.some((s) => s.reason.includes('not attributes'))).toBe(false);
    const changed = applied(ldm(), [...proposed.proposals.filter(chosenByDefault), ...proposed.proposals.filter((p) => p.kind === 'constraint')].flatMap((p) => p.changes));
    expect(changed.refusals).toEqual([]);
    const actor = changed.next!.entities.find((e) => e.name === 'Actor')!;
    expect(actor.keys).toHaveLength(1);
    expect(actor.keys[0].members).toHaveLength(1);
    expect('attribute' in actor.keys[0].members[0]).toBe(true);
  });

  it('turns an enumerated datatype into a domain and types the attribute with it', () => {
    const model = ontology();
    const running = model.terms.find((t) => t.name === 'Running time')!;
    model.datatypes.push({ id: 'dt-1', name: 'Length band', description: 'Short, feature.', values: [{ value: 'short', dt: 'xsd:string' }, { value: 'feature' }] });
    const withDatatype = withIris(model);
    withDatatype.terms.find((t) => t.id === running.id)!.ranges = [{ id: 'r-1', range: { type: 'Enumeration', datatype: 'dt-1' } }];
    const proposed = propose(withDatatype, ldm());
    const domain = proposed.proposals.find((p) => p.kind === 'domain')!;
    expect(domain.strategy).toBe('enumerated datatype → domain');
    expect(domain.elements).toEqual(['Domain Length band']);
    const { result } = acceptStructure(withDatatype, ldm());
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0].constraints.values?.map((v) => v.code)).toEqual(['short', 'feature']);
    expect(result.domains[0].base).toEqual({ base: 'text' });
    expect(result.entities.find((e) => e.name === 'Film')!.attributes.find((a) => a.name === 'Running time')!.type).toEqual({ domain: result.domains[0].id });
  });

  it('gives an entity an attribute typed by the domain when an object property reaches an enumerated class', () => {
    const { model, forwardIri } = enumerationModel();
    const proposed = propose(model, ldm());
    const [attributeProposal] = proposed.proposals.filter((p) => p.strategy === 'object property to an enumerated class → attribute typed by its domain');
    expect(attributeProposal).toBeTruthy();
    const { attribute } = addedAttribute(attributeProposal);
    expect(attribute.name).toBe('has colour');
    expect(attribute.optional).toBe(true);
    expect('domain' in attribute.type).toBe(true);
    // The enumerated class is a domain, not a second entity: no relationship is proposed for the property.
    expect(proposed.proposals.filter((p) => p.kind === 'relationship' && p.sources.some((s) => s.iri === forwardIri))).toEqual([]);
    expect(proposed.skipped.some((s) => s.iri === forwardIri)).toBe(false);
    // The attribute stays only when the domain and the entity it types are accepted.
    const domainProposal = proposed.proposals.find((p) => p.kind === 'domain')!;
    const entityProposal = proposed.proposals.find((p) => p.kind === 'entity' && p.elements.includes('Entity Film'))!;
    expect(attributeProposal.requires).toEqual(expect.arrayContaining([domainProposal.id, entityProposal.id]));

    const { result } = acceptStructure(model, ldm());
    const film = result.entities.find((e) => e.name === 'Film')!;
    const made = film.attributes.find((a) => a.name === 'has colour')!;
    expect(made.type).toEqual({ domain: result.domains[0].id });
    expect(made.optional).toBe(true);
    expect(result.relationships).toHaveLength(5);
    const mapping = result.mappings.find((m) => m.targets.some((t) => 'attribute' in t && t.attribute === made.id))!;
    expect(mapping.sources.map((s) => s.iri)).toContain(forwardIri);

    // A later run finds the attribute and says so, rather than claiming the class is out of scope.
    const again = propose(model, result);
    expect(again.proposals.filter((p) => p.strategy === 'object property to an enumerated class → attribute typed by its domain')).toEqual([]);
    expect(again.skipped.find((s) => s.iri === forwardIri)?.reason).toBe('already represented by an attribute');
  });

  it('reads an object property stated from the enumerated class towards the entity as the entity’s attribute', () => {
    const { model, backwardIri } = enumerationModel('reversed');
    const proposed = propose(model, ldm());
    const attributes = proposed.proposals.filter((p) => p.strategy === 'object property to an enumerated class → attribute typed by its domain');
    expect(attributes).toHaveLength(1);
    expect(addedAttribute(attributes[0]).attribute.name).toBe('is colour of');
    expect(attributes[0].rationale).toContain('read from Film');
    expect(proposed.proposals.filter((p) => p.kind === 'relationship' && p.sources.some((s) => s.iri === backwardIri))).toEqual([]);
  });

  it('names the attribute after the direction that starts at the entity when both directions are stated', () => {
    const { model, forwardIri, backwardIri } = enumerationModel('pair');
    const proposed = propose(model, ldm());
    const attributes = proposed.proposals.filter((p) => p.strategy === 'object property to an enumerated class → attribute typed by its domain');
    expect(attributes).toHaveLength(1);
    expect(addedAttribute(attributes[0]).attribute.name).toBe('has colour');
    expect(attributes[0].sources.map((s) => s.iri).sort()).toEqual([forwardIri, backwardIri].sort());
  });

  it('puts an object property to an enumerated class once, on the topmost entity it is stated at', () => {
    const { model, filmIri } = enumerationModel();
    const has = model.props.find((p) => p.name === 'has colour')!;
    has.domains = [{ id: 'd-film', expression: { type: 'Class', iri: filmIri } }, { id: 'd-documentary', expression: { type: 'Class', iri: iriOf(model, 'Documentary') } }];
    const { result } = acceptStructure(model, ldm());
    expect(result.entities.find((e) => e.name === 'Film')!.attributes.map((a) => a.name)).toContain('has colour');
    expect(result.entities.find((e) => e.name === 'Documentary')!.attributes).toEqual([]);
  });

  it('turns a restriction on a property to an enumerated class into a candidate on that attribute', () => {
    const { model, signalIri } = enumerationModel();
    const has = model.props.find((p) => p.name === 'has colour')!;
    model.terms.find((t) => t.name === 'Film')!.classAxioms = [{
      id: 'ax-1',
      kind: 'SubClassOf',
      expression: { type: 'ObjectSomeValuesFrom', property: { type: 'ObjectProperty', iri: has.iri! }, filler: { type: 'Class', iri: signalIri } },
    }];
    const proposed = propose(model, ldm());
    const candidate = proposed.proposals.find((p) => p.strategy === 'restriction → candidate mandatory attribute');
    expect(candidate?.title).toBe('Make the attribute has colour of Film mandatory');
    expect(proposed.skipped.some((s) => s.reason === 'a restriction on it has no relationship to constrain')).toBe(false);
  });

  it('takes a branch or chosen classes as its scope', () => {
    const model = ontology();
    const person = iriOf(model, 'Person');
    const branch = propose(model, ldm(), { ...defaultTransformationConfig(), scope: { kind: 'branch', classes: [person], withImports: false } });
    expect(new Set(branch.scope.classes)).toEqual(new Set([person, iriOf(model, 'Actor'), iriOf(model, 'Director')]));
    expect(branch.proposals.filter((p) => p.kind === 'entity')).toHaveLength(3);
    const chosen = propose(model, ldm(), { ...defaultTransformationConfig(), scope: { kind: 'classes', classes: [iriOf(model, 'Film')], withImports: false } });
    expect(chosen.proposals.filter((p) => p.kind === 'entity')).toHaveLength(1);
    expect(chosen.proposals.filter((p) => p.kind === 'attribute')).toHaveLength(2);
    expect(chosen.proposals.filter((p) => p.kind === 'relationship')).toHaveLength(0);
  });

  it('keeps names under the naming configuration', () => {
    const model = ontology();
    const config: TransformationConfig = { ...defaultTransformationConfig(), naming: { from: 'label', case: 'pascal', separator: '', singular: true } };
    const { result } = acceptStructure(model, ldm(), config);
    expect(result.entities.map((e) => e.name)).toContain('Documentary');
    expect(result.entities.find((e) => e.name === 'Film')!.attributes.map((a) => a.name).sort()).toEqual(['ReleaseDate', 'RunningTime']);
    const lower = acceptStructure(model, ldm(), { ...config, naming: { from: 'localName', case: 'lower', separator: '_', singular: true } }).result;
    expect(lower.entities.find((e) => e.name === 'film')).toBeTruthy();
    expect(lower.entities.find((e) => e.name === 'film')!.attributes.map((a) => a.name).sort()).toEqual(['release_date', 'running_time']);
  });

  it('saves and reads its configuration with the LDM', () => {
    const config: TransformationConfig = { ...defaultTransformationConfig(), hierarchy: 'rollup', objectProperties: 'associative', datatypes: { 'http://www.w3.org/2001/XMLSchema#integer': 'decimal' }, naming: { from: 'localName', case: 'upper', separator: '_', singular: false } };
    const raw = JSON.parse(JSON.stringify({ ...ldm(), derivation: config }));
    expect(logicalModelFrom(raw)?.derivation).toEqual(config);
    expect(transformationConfigFrom({ ...config, hierarchy: 'none' })).toBeUndefined();
  });

  it('gives every mapping it makes a catalogue strategy id, with the words it has always recorded', () => {
    const configs: TransformationConfig[] = [
      defaultTransformationConfig(),
      { ...defaultTransformationConfig(), hierarchy: 'rollup' },
      { ...defaultTransformationConfig(), hierarchy: 'rolldown' },
      { ...defaultTransformationConfig(), objectProperties: 'associative' },
    ];
    for (const config of configs) {
      const { result } = acceptStructure(ontology(), ldm(), config);
      expect(result.mappings.length).toBeGreaterThan(0);
      for (const m of result.mappings) {
        expect(isStrategyId(m.strategyId)).toBe(true);
        expect(strategyForText(m.strategy)?.id).toBe(m.strategyId);
      }
    }
  });
});

describe('reading mappings saved before strategies had ids', () => {
  const base = { sources: [{ iri: 'http://example.org/Genre', axioms: [] }], targets: [{ domain: 'd' }], rationale: '', origin, baseline: {}, made: { by: 'transformation', at: 1 } };
  const read = (mappings: unknown[]) => logicalModelFrom(JSON.parse(JSON.stringify({ ...ldm(), mappings })))!;

  it('keeps a stored id, reads the words it knows, and leaves words it does not know unclassified', () => {
    const parsed = read([
      { ...base, id: 'map-1', strategy: 'class → entity', strategyId: 'OWL_CLASSES_TO_LDM_ENTITY' },
      { ...base, id: 'map-2', strategy: 'enumerated class → domain' },
      { ...base, id: 'map-3', strategy: 'restriction → candidate mandatory on “Studio”' },
      { ...base, id: 'map-4', strategy: 'made by hand, in another tool' },
    ]);
    expect(parsed.mappings.map((m) => m.strategyId ?? 'unclassified')).toEqual(['OWL_CLASSES_TO_LDM_ENTITY', 'OWL_ENUMERATION_TO_LDM_DOMAIN', 'OWL_RESTRICTION_TO_LDM_MANDATORY_END', 'unclassified']);
    // The words are the mapping's own, whether or not the catalogue knows them.
    expect(parsed.mappings.map((m) => m.strategy)).toEqual(['class → entity', 'enumerated class → domain', 'restriction → candidate mandatory on “Studio”', 'made by hand, in another tool']);
  });

  it('keeps a recorded conversion, and drops one it cannot read', () => {
    const parsed = read([
      { ...base, id: 'map-1', strategy: 'enumerated class → reference entity', converted: { from: 'OWL_ENUMERATION_TO_LDM_DOMAIN', to: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY', at: 5 } },
      { ...base, id: 'map-2', strategy: 'class → entity', converted: { from: 'OWL_NOPE', to: 'not-an-id', at: 5 } },
      { ...base, id: 'map-3', strategy: 'class → entity', converted: 'yesterday' },
    ]);
    expect(parsed.mappings[0].converted).toEqual({ from: 'OWL_ENUMERATION_TO_LDM_DOMAIN', to: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY', at: 5 });
    expect(parsed.mappings[1].converted).toBeUndefined();
    expect(parsed.mappings[2].converted).toBeUndefined();
  });
});

describe('the transformation service', () => {
  const host = () => {
    let state = { model: ontology() };
    let commits = 0;
    const { edit } = createLocalLogicalServices({
      current: () => ({ model: state.model }),
      commit: (next) => {
        commits++;
        state.model = next;
      },
    });
    const service = createLocalTransformationService(
      {
        current: () => ({ model: state.model, ontologyId: 'film', revisionId: 'rev-1' }),
        withImports: () => undefined,
        edit,
      },
      onThePage,
    );
    return {
      service,
      edit,
      current: () => state.model,
      commits: () => commits,
    };
  };

  it('applies accepted proposals as one change set, with the configuration, and leaves the ontology as it was', async () => {
    const h = host();
    const before = h.current();
    const made = await h.edit.create({ name: 'Film LDM' });
    const result = await h.service.propose({ model: made.model, config: defaultTransformationConfig() });
    const accepted = result.proposals.filter(chosenByDefault).map((p) => p.id);
    const after = await h.service.apply({ result, accepted });
    expect(after.applied).toBe(17);
    const next = h.current();
    const ldmAfter = next.logicalModels.find((m) => m.id === made.model)!;
    expect(ldmAfter.entities).toHaveLength(8);
    expect(ldmAfter.revision).toBe(after.revision);
    expect(ldmAfter.derivation).toEqual(defaultTransformationConfig());
    expect(h.commits()).toBe(2);
    // Nothing of the ontology changed, not even its revision.
    expect({ terms: next.terms, props: next.props, relations: next.relations, datatypes: next.datatypes, unmapped: next.unmapped }).toEqual({ terms: before.terms, props: before.props, relations: before.relations, datatypes: before.datatypes, unmapped: before.unmapped });

    // Run again over what was accepted and edited by hand: it proposes nothing over either.
    const edited = next.logicalModels[0];
    edited.entities.find((e) => e.name === 'Actor')!.name = 'Performer';
    edited.entities.find((e) => e.name === 'Film')!.attributes[0].optional = false;
    const again = await h.service.propose({ model: made.model, config: defaultTransformationConfig() });
    expect(again.proposals).toEqual([]);
  });

  it('makes no change when nothing is accepted, and refuses a proposal whose requirement is not accepted', async () => {
    const h = host();
    const made = await h.edit.create({ name: 'Film LDM' });
    const result = await h.service.propose({ model: made.model, config: defaultTransformationConfig() });
    const before = h.current().logicalModels[0].revision;
    const none = await h.service.apply({ result, accepted: [] });
    expect(none.applied).toBe(0);
    expect(h.current().logicalModels[0].revision).toBe(before);
    expect(h.commits()).toBe(1);

    const attribute = result.proposals.find((p) => p.kind === 'attribute')!;
    await expect(h.service.apply({ result, accepted: [attribute.id] })).rejects.toMatchObject({ code: 'refused' });
  });

  it('refuses proposals worked out against an LDM that has moved on', async () => {
    const h = host();
    const made = await h.edit.create({ name: 'Film LDM' });
    const result = await h.service.propose({ model: made.model, config: defaultTransformationConfig() });
    const entity = result.proposals.find((p) => p.kind === 'entity')!;
    await h.service.apply({ result, accepted: [entity.id] });
    await expect(h.service.apply({ result, accepted: result.proposals.filter(chosenByDefault).map((p) => p.id) })).rejects.toMatchObject({ code: 'stale-revision' });
  });
});

// ---------------------------------------------------------------- the reference-data pattern

describe('the reference-data hierarchy pattern', () => {
  const reference = (): TransformationConfig => ({ ...defaultTransformationConfig(), hierarchy: 'reference' });

  /** A hierarchy of Vehicle with two kinds, a class of its own, and a data property on either level. */
  function referenceModel() {
    const m = emptyModel('Reference');
    const vehicle = newTerm({ name: 'Vehicle' });
    const car = newTerm({ name: 'Car' });
    const bike = newTerm({ name: 'Bike' });
    const garage = newTerm({ name: 'Garage' });
    m.terms.push(vehicle, car, bike, garage);
    m.relations.push(newRelation({ from: car.id, to: vehicle.id, kind: 'generalization' }), newRelation({ from: bike.id, to: vehicle.id, kind: 'generalization' }));
    const mid = withIris(m);
    const registration = newTerm({ name: 'Registration', type: 'property' });
    const doors = newTerm({ name: 'Doors', type: 'property' });
    mid.terms.push(registration, doors);
    const ready = withIris(mid);
    const vehicleIri = ready.terms.find((t) => t.name === 'Vehicle')!.iri!;
    const carIri = ready.terms.find((t) => t.name === 'Car')!.iri!;
    ready.terms.find((t) => t.name === 'Registration')!.domains = [{ id: 'd1', expression: { type: 'Class', iri: vehicleIri } }];
    ready.terms.find((t) => t.name === 'Doors')!.domains = [{ id: 'd2', expression: { type: 'Class', iri: carIri } }];
    return ready;
  }

  it('turns a class and its subclasses into a reference entity of the subclasses and an entity for the instances', () => {
    const model = referenceModel();
    const result = propose(model, ldm(), reference());
    const entities = result.proposals.filter((p) => p.kind === 'entity');
    expect(entities.map((p) => p.title)).toEqual(['Entity from the class Garage', 'Entity and reference entity from the hierarchy of Vehicle']);
    const pattern = entities[1];
    expect(pattern.strategy).toBe('subclass hierarchy → reference entity and instances entity');
    expect(pattern.elements).toEqual(['Entity Vehicle', 'Reference entity Vehicle type', 'Relationship type']);
    const adds = pattern.changes.filter((c) => c.op === 'add').map((c) => c.element);
    const madeEntities = adds.filter((e): e is Extract<(typeof adds)[number], { kind: 'entity' }> => e.kind === 'entity');
    const instanceEntity = madeEntities.find((e) => !e.entity.reference)!.entity;
    const referenceEntity = madeEntities.find((e) => e.entity.reference)!.entity;
    expect(instanceEntity.name).toBe('Vehicle');
    expect(instanceEntity.reference).toBeUndefined();
    expect(referenceEntity.name).toBe('Vehicle type');
    expect(referenceEntity.reference).toBe(true);
    // A reference entity is a concrete list of codes: a mandatory code, a label, and the code as its primary key.
    expect(referenceEntity.attributes.map((a) => a.name)).toEqual(['code', 'label']);
    expect(referenceEntity.attributes[0]).toMatchObject({ type: { base: 'identifier' }, optional: false });
    expect(referenceEntity.attributes[1]).toMatchObject({ type: { base: 'text' }, optional: true });
    expect(referenceEntity.keys).toHaveLength(1);
    expect(referenceEntity.keys[0]).toMatchObject({ kind: 'primary', members: [{ attribute: referenceEntity.attributes[0].id }] });
    // The instances point at their kind through a relationship, optional until the user says otherwise.
    const relationship = adds.find((e): e is Extract<(typeof adds)[number], { kind: 'relationship' }> => e.kind === 'relationship')!.relationship;
    expect(relationship.name).toBe('type');
    expect(relationship.ends).toEqual([
      { entity: instanceEntity.id, role: 'has type', min: 0, max: 'many' },
      { entity: referenceEntity.id, role: 'type of', min: 0, max: 1 },
    ]);
    // The mappings say where each element came from: the whole hierarchy names the reference entity's values.
    const mappings = pattern.changes.flatMap((c) => (c.op === 'add' && c.element.kind === 'mapping' ? [c.element.mapping] : []));
    expect(mappings.map((m) => m.strategyId)).toEqual(['OWL_CLASS_TO_LDM_ENTITY', 'OWL_SUBCLASS_HIERARCHY_TO_LDM_REFERENCE_ENTITY']);
    const referenceMapping = mappings.find((m) => m.strategyId === 'OWL_SUBCLASS_HIERARCHY_TO_LDM_REFERENCE_ENTITY')!;
    expect(referenceMapping.sources.map((s) => s.label)).toEqual(['Bike', 'Car', 'Vehicle']);
    expect(referenceMapping.targets).toEqual([{ entity: referenceEntity.id }]);
    // The subclasses are the values of the pattern, not entities of their own: no specialization is proposed.
    expect(result.proposals.filter((p) => p.kind === 'specialization')).toEqual([]);
  });

  it('puts a data property of a subclass on the instances entity, and accepts the pattern as one change set', () => {
    const model = referenceModel();
    const { result } = acceptStructure(model, ldm(), reference());
    const vehicle = result.entities.find((e) => e.name === 'Vehicle')!;
    expect(vehicle.attributes.map((a) => a.name).sort()).toEqual(['Doors', 'Registration']);
    const types = result.entities.find((e) => e.name === 'Vehicle type')!;
    expect(types.reference).toBe(true);
    expect(result.entities.find((e) => e.name === 'Garage')!.attributes).toEqual([]);
    expect(result.generalizations).toEqual([]);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].ends.map((e) => e.entity).sort()).toEqual([types.id, vehicle.id].sort());
  });

  it('runs again over its own result and proposes nothing, and the configuration round-trips', () => {
    const model = referenceModel();
    const first = acceptStructure(model, ldm(), reference()).result;
    const again = propose(model, first, reference());
    expect(again.proposals).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining(['already represented by the reference-data pattern', 'already represented by an entity']));
    expect(transformationConfigFrom({ ...defaultTransformationConfig(), hierarchy: 'reference' })?.hierarchy).toBe('reference');
  });
});
