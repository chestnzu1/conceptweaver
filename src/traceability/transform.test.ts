import { describe, expect, it } from 'vitest';
import { withIris } from '../model/iri';
import { sampleModel } from '../model/sample';
import type { Model } from '../model/types';
import type { LogicalModel, TransformationConfig } from '../logical/contracts';
import { createLocalLogicalServices } from '../logical/local';
import { applied, emptyLogicalModel, logicalModelFrom, transformationConfigFrom } from '../logical/rules';
import { createLocalTransformationService, onThePage } from './local';
import { chosenByDefault, defaultTransformationConfig, hasKeyStatements, proposalsFor } from './transform';

const origin = { ontology: 'film', revision: 'rev-1' };
const ontology = () => withIris(sampleModel());
const ldm = () => emptyLogicalModel({ name: 'Film LDM', purpose: 'Cinema catalogue' });

const propose = (model: Model, target: LogicalModel, config: TransformationConfig = defaultTransformationConfig()) => proposalsFor({ model, target, config, origin });

const iriOf = (m: Model, name: string) => m.terms.find((t) => t.name === name)!.iri!;
const propIriOf = (m: Model, name: string) => m.props.find((p) => p.name === name)!.iri!;

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
