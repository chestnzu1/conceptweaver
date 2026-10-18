import { describe, expect, it } from 'vitest';
import type { SemanticMapping } from '../logical/contracts';
import { applied, emptyLogicalModel } from '../logical/rules';
import { conversionPlan, elementNameIn } from './conversions';

/**
 * Changing a mapping's strategy and the target element together (roadmap LM-4): the planner
 * expresses each conversion as the change operations the LDM already has, with its conflicts in
 * words; where it cannot make the conversion exactly, it refuses rather than approximating, and
 * nothing here writes anything.
 */

const mapping = (over: Partial<SemanticMapping> = {}): SemanticMapping => ({
  id: 'map-1',
  sources: [{ iri: 'http://example.org/Genre', label: 'Genre', axioms: ['Declaration(Class(<http://example.org/Genre>))'] }],
  targets: [{ domain: 'd-genre' }],
  strategy: 'enumerated class → domain',
  strategyId: 'OWL_ENUMERATION_TO_LDM_DOMAIN',
  rationale: 'Genre is a list of categories.',
  origin: { ontology: 'film', revision: 'rev-1' },
  baseline: {},
  made: { by: 'transformation', at: 0 },
  ...over,
});

/** A domain with two members, an entity attribute typed by it, and a rule applying to it. */
function domainModel() {
  const m = emptyLogicalModel({ id: 'ldm', name: 'Test' });
  m.domains.push({ id: 'd-genre', name: 'Genre', definition: 'A category of films.', base: { base: 'text' }, constraints: { values: [{ code: 'Drama', label: 'Drama' }, { code: 'Comedy', label: 'Comedy' }] } });
  m.entities.push({
    id: 'e-film',
    name: 'Film',
    definition: '',
    attributes: [
      { id: 'a-genre', name: 'Genre', definition: '', type: { domain: 'd-genre' }, optional: true },
      { id: 'a-title', name: 'Title', definition: '', type: { base: 'text' }, optional: true },
    ],
    keys: [],
  });
  m.rules.push({ id: 'r-genre', name: 'Genre rule', statement: 'A film has a genre.', kind: 'constraint', appliesTo: [{ domain: 'd-genre' }], status: 'accepted' });
  const map = mapping();
  m.mappings.push(map);
  return { m, map };
}

/** An entity that is exactly a value list: one base-typed attribute, its primary key, nothing else. */
function valueEntityModel() {
  const m = emptyLogicalModel({ id: 'ldm', name: 'Test' });
  m.entities.push({
    id: 'e-genre',
    name: 'Genre',
    definition: 'A category of films.',
    attributes: [{ id: 'a-code', name: 'Code', definition: '', type: { base: 'text' }, optional: false }],
    keys: [{ id: 'k-code', kind: 'primary', name: 'Primary key', members: [{ attribute: 'a-code' }] }],
  });
  const map = mapping({
    targets: [{ entity: 'e-genre' }],
    strategy: 'enumerated class → reference entity',
    strategyId: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY',
    sources: [
      {
        iri: 'http://example.org/Genre',
        label: 'Genre',
        axioms: ['Declaration(Class(<http://example.org/Genre>))', 'EquivalentClasses(<http://example.org/Genre> ObjectOneOf(<http://example.org/Drama> <http://example.org/Comedy>))'],
      },
    ],
  });
  m.mappings.push(map);
  return { m, map };
}

/** Two entities joined by a many-to-many relationship, with a mapping targeting the relationship. */
function relationshipModel() {
  const m = emptyLogicalModel({ id: 'ldm', name: 'Test' });
  m.entities.push(
    { id: 'e-customer', name: 'Customer', definition: '', attributes: [], keys: [] },
    { id: 'e-product', name: 'Product', definition: '', attributes: [], keys: [] },
  );
  m.relationships.push({ id: 'r-buys', name: 'buys', definition: '', ends: [{ entity: 'e-customer', role: '', min: 0, max: 'many' }, { entity: 'e-product', role: '', min: 0, max: 'many' }], identifying: false });
  const map = mapping({
    targets: [{ relationship: 'r-buys' }],
    strategy: 'object property → relationship',
    strategyId: 'OWL_OBJECT_PROPERTY_TO_LDM_RELATIONSHIP',
    sources: [{ iri: 'http://example.org/buys', label: 'buys', axioms: ['Declaration(ObjectProperty(<http://example.org/buys>))'] }],
  });
  m.mappings.push(map);
  return { m, map };
}

const added = (preview: ReturnType<typeof conversionPlan>) => {
  const change = preview.changes.find((c) => c.op === 'add' && c.element.kind === 'entity');
  if (!change || change.op !== 'add' || change.element.kind !== 'entity') throw new Error('no entity was added');
  return change.element.entity;
};

describe('a domain that becomes a reference entity', () => {
  it('makes the entity, keeps every attribute id, retargets the rule, and removes the domain exactly', () => {
    const { m, map } = domainModel();
    const preview = conversionPlan({ model: m, mapping: map, to: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' });

    expect(preview.conflicts).toEqual([]);
    expect(preview.from).toMatchObject({ strategyId: 'OWL_ENUMERATION_TO_LDM_DOMAIN', ref: { domain: 'd-genre' }, kind: 'domain', name: 'Genre' });
    expect(preview.to).toMatchObject({ strategyId: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY', kind: 'entity', name: 'Genre' });
    expect(preview.baseRevision).toBe(m.revision);

    const entity = added(preview);
    expect(entity.name).toBe('Genre');
    expect(entity.definition).toBe('A category of films.');
    expect(entity.attributes.map((a) => [a.name, a.optional, a.type])).toEqual([
      ['code', false, { base: 'text' }],
      ['label', true, { base: 'text' }],
    ]);
    expect(entity.keys).toHaveLength(1);
    expect(entity.keys[0]).toMatchObject({ kind: 'primary', members: [{ attribute: entity.attributes[0].id }] });

    // The attribute typed by the domain takes the base type directly, keeping its id.
    const retyped = preview.changes.find((c) => c.op === 'update' && 'attribute' in c.target);
    expect(retyped).toBeDefined();
    expect(preview.changes).toContainEqual(
      expect.objectContaining({ op: 'update', target: { attribute: 'a-genre' }, before: { type: { domain: 'd-genre' } }, after: { type: { base: 'text' } } }),
    );
    // The rule follows the element it was about.
    expect(preview.changes).toContainEqual(expect.objectContaining({ op: 'update', target: { rule: 'r-genre' }, after: { appliesTo: [{ entity: entity.id }] } }));
    // The domain goes as itself, not by cascade: another mapping's targets never move silently.
    expect(preview.changes).toContainEqual({ op: 'remove', element: { kind: 'domain', domain: m.domains[0] } });
    expect(preview.removes).toEqual(['Domain “Genre”']);

    expect(preview.decisions).toEqual([{ name: 'values', label: 'How the members are kept', choices: [{ value: 'labels as codes', label: 'Each member becomes a row, its name the code' }], chosen: 'labels as codes' }]);
    expect(preview.constraints.some((c) => c.includes('Drama') && c.includes('Comedy'))).toBe(true);
    expect(preview.keys.some((k) => k.includes('keep their ids'))).toBe(true);

    expect(preview.mappingAfter).toMatchObject({
      targets: [{ entity: entity.id }],
      strategyId: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY',
      strategy: 'enumerated class → reference entity',
      baseline: { entity: { id: entity.id, name: 'Genre', definition: 'A category of films.' } },
      rationale: 'Genre is a list of categories.',
    });
  });

  it('offers a valid representation other than a domain, and says so when the strategy changes nothing', () => {
    const { m, map } = domainModel();
    // An enumerated class may equally become a plain entity: the choice is the user's.
    const plain = conversionPlan({ model: m, mapping: map, to: 'OWL_CLASS_TO_LDM_REFERENCE_ENTITY' });
    expect(plain.conflicts).toEqual([]);
    expect(added(plain).attributes.map((a) => a.name)).toEqual(['code', 'label']);
    const same = conversionPlan({ model: m, mapping: map, to: 'OWL_ENUMERATION_TO_LDM_DOMAIN' });
    expect(same.changes).toEqual([]);
    expect(same.conflicts).toEqual([]);
    expect(same.warnings[0]).toContain('already is');
  });

  it('refuses while another mapping still targets the domain, changing nothing', () => {
    const { m, map } = domainModel();
    m.mappings.push(mapping({ id: 'map-2', strategy: 'class → entity', strategyId: 'OWL_CLASS_TO_LDM_ENTITY' }));
    const preview = conversionPlan({ model: m, mapping: map, to: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' });
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0]).toContain('Another mapping');
    expect(preview.changes).toEqual([]);
    expect(preview.mappingAfter.targets).toEqual(map.targets);
  });

  it('refuses several targets, several sources, or an element that is no longer there', () => {
    const { m, map } = domainModel();
    const several = conversionPlan({ model: m, mapping: { ...map, targets: [{ domain: 'd-genre' }, { domain: 'd-other' }] }, to: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' });
    expect(several.conflicts[0]).toContain('one element at a time');
    const manySources = conversionPlan({ model: m, mapping: { ...map, sources: [{ iri: 'http://example.org/A', axioms: [] }, { iri: 'http://example.org/B', axioms: [] }] }, to: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' });
    expect(manySources.conflicts[0]).toContain('reads one source; this mapping records 2');
    const gone = conversionPlan({ model: m, mapping: { ...map, targets: [{ domain: 'd-gone' }] }, to: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' });
    expect(gone.conflicts[0]).toContain('no longer in the logical model');
  });

  it('does not guess at a strategy outside the catalogue', () => {
    const { m, map } = domainModel();
    const preview = conversionPlan({ model: m, mapping: map, to: 'OWL_MAGIC' as never });
    expect(preview.conflicts).toEqual(['“OWL_MAGIC” is not a strategy this editor knows.']);
    expect(preview.changes).toEqual([]);
  });
});

describe('an entity that becomes a domain', () => {
  it('takes its values from what the mapping recorded, and leaves the mapping update to the service', () => {
    const { m, map } = valueEntityModel();
    const preview = conversionPlan({ model: m, mapping: map, to: 'OWL_ENUMERATION_TO_LDM_DOMAIN' });
    expect(preview.conflicts).toEqual([]);
    const domainAdd = preview.changes.find((c) => c.op === 'add' && c.element.kind === 'domain');
    expect(domainAdd).toBeDefined();
    if (!domainAdd || domainAdd.op !== 'add' || domainAdd.element.kind !== 'domain') return;
    const domain = domainAdd.element.domain;
    expect(domain).toMatchObject({ name: 'Genre', definition: 'A category of films.', base: { base: 'text' }, constraints: { values: [{ code: 'Drama', label: 'Drama' }, { code: 'Comedy', label: 'Comedy' }] } });
    expect(preview.removes).toEqual(['Entity “Genre”', 'Attribute “Genre.Code”', 'Primary key on it']);
    expect(preview.changes).toContainEqual({ op: 'remove', element: { kind: 'entity', entity: m.entities[0] } });
    // The mapping's own retarget is added by the service as the last change of the set.
    expect(preview.changes.some((c) => c.op === 'update' && 'mapping' in c.target)).toBe(false);
    expect(preview.mappingAfter).toMatchObject({ targets: [{ domain: domain.id }], strategyId: 'OWL_ENUMERATION_TO_LDM_DOMAIN', strategy: 'enumerated class → domain', baseline: { domain } });
    expect(preview.warnings).toEqual([]);
  });

  it('warns rather than inventing values when no member was recorded', () => {
    const { m, map } = valueEntityModel();
    const preview = conversionPlan({ model: m, mapping: { ...map, sources: [{ iri: 'http://example.org/Genre', axioms: ['Declaration(Class(<http://example.org/Genre>))'] }] }, to: 'OWL_ENUMERATION_TO_LDM_DOMAIN' });
    expect(preview.conflicts).toEqual([]);
    expect(preview.warnings[0]).toContain('no list of members');
    const domainAdd = preview.changes.find((c) => c.op === 'add' && c.element.kind === 'domain');
    if (domainAdd && domainAdd.op === 'add' && domainAdd.element.kind === 'domain') expect(domainAdd.element.domain.constraints).toEqual({});
  });

  it('refuses anything that is more than a value list', () => {
    const { m, map } = valueEntityModel();
    m.entities[0].attributes.push({ id: 'a-label', name: 'Label', definition: '', type: { base: 'text' }, optional: true });
    let preview = conversionPlan({ model: m, mapping: map, to: 'OWL_ENUMERATION_TO_LDM_DOMAIN' });
    expect(preview.conflicts.join(' ')).toContain('attributes besides its one value');
    expect(preview.changes).toEqual([]);

    const relationship = valueEntityModel();
    relationship.m.relationships.push({ id: 'r-x', name: 'x', definition: '', ends: [{ entity: 'e-genre', role: '', min: 0, max: 1 }, { entity: 'e-genre', role: '', min: 0, max: 1 }], identifying: false });
    preview = conversionPlan({ model: relationship.m, mapping: relationship.map, to: 'OWL_ENUMERATION_TO_LDM_DOMAIN' });
    expect(preview.conflicts.join(' ')).toContain('relationship has an end at it');

    const decided = valueEntityModel();
    decided.m.rules.push({ id: 'r-1', name: 'One code', statement: 'Each genre has one code.', kind: 'constraint', appliesTo: [{ attribute: 'a-code' }], status: 'accepted' });
    preview = conversionPlan({ model: decided.m, mapping: decided.map, to: 'OWL_ENUMERATION_TO_LDM_DOMAIN' });
    expect(preview.conflicts.join(' ')).toContain('rule “One code” applies to it');

    const other = valueEntityModel();
    other.m.mappings.push(mapping({ id: 'map-2', targets: [{ entity: 'e-genre' }] }));
    preview = conversionPlan({ model: other.m, mapping: other.map, to: 'OWL_ENUMERATION_TO_LDM_DOMAIN' });
    expect(preview.conflicts.join(' ')).toContain('Another mapping');
  });
});

describe('a relationship that becomes an associative entity', () => {
  it('resolves it the way the LDM workspace does, adding the mapping update itself', () => {
    const { m, map } = relationshipModel();
    const preview = conversionPlan({ model: m, mapping: map, to: 'OWL_OBJECT_PROPERTY_TO_LDM_ASSOCIATION' });
    expect(preview.conflicts).toEqual([]);
    expect(preview.to.kind).toBe('entity');
    expect(preview.to.name).toBe('buys');
    const entity = added(preview);
    expect(entity.name).toBe('buys');
    expect(entity.keys[0].members).toHaveLength(2);
    expect(entity.keys[0].members.every((x) => 'end' in x)).toBe(true);
    expect(preview.changes.filter((c) => c.op === 'add' && c.element.kind === 'relationship')).toHaveLength(2);
    expect(preview.changes).toContainEqual({ op: 'remove', element: { kind: 'relationship', relationship: m.relationships[0] } });
    expect(preview.changes.some((c) => c.op === 'update' && 'mapping' in c.target)).toBe(false);
    expect(preview.creates).toContain('Entity “buys”');
    expect(preview.creates.filter((x) => x.startsWith('Identifying relationship'))).toHaveLength(2);
    expect(preview.keys[0]).toContain('borrows the identity');
    expect(preview.constraints[0]).toContain('mandatory');
    expect(preview.mappingAfter).toMatchObject({ targets: [{ entity: entity.id }], strategyId: 'OWL_OBJECT_PROPERTY_TO_LDM_ASSOCIATION', strategy: 'object property → associative entity (many at both ends)', baseline: { entity: { id: entity.id, name: 'buys', definition: '' } } });
  });

  it('refuses a relationship that is not many at both ends, and one another mapping names', () => {
    const { m, map } = relationshipModel();
    m.relationships[0].ends = [{ ...m.relationships[0].ends[0], max: 'many' }, { ...m.relationships[0].ends[1], max: 1 }];
    let preview = conversionPlan({ model: m, mapping: map, to: 'OWL_OBJECT_PROPERTY_TO_LDM_ASSOCIATION' });
    expect(preview.conflicts.length).toBeGreaterThan(0);
    expect(preview.changes).toEqual([]);

    const shared = relationshipModel();
    shared.m.mappings.push(mapping({ id: 'map-2', targets: [{ relationship: 'r-buys' }], strategy: 'object property → relationship', strategyId: 'OWL_OBJECT_PROPERTY_TO_LDM_RELATIONSHIP' }));
    preview = conversionPlan({ model: shared.m, mapping: shared.map, to: 'OWL_OBJECT_PROPERTY_TO_LDM_ASSOCIATION' });
    expect(preview.conflicts[0]).toContain('Another mapping');
    expect(preview.changes).toEqual([]);
  });

  it('refuses a conversion the LDM has no exact change for, saying which kinds it is about', () => {
    const { m, map } = domainModel();
    const preview = conversionPlan({ model: m, mapping: map, to: 'OWL_SUBCLASS_TO_LDM_SPECIALIZATION' });
    expect(preview.conflicts).toEqual(['A domain cannot become a generalization by changing a mapping’s strategy.']);
    expect(preview.changes).toEqual([]);
  });
});

describe('reading an element by ref', () => {
  it('names an element of every kind, and says when one is gone', () => {
    const { m } = domainModel();
    expect(elementNameIn(m, { domain: 'd-genre' })).toBe('Genre');
    expect(elementNameIn(m, { entity: 'e-film' })).toBe('Film');
    expect(elementNameIn(m, { attribute: 'a-genre' })).toBe('Film.Genre');
    expect(elementNameIn(m, { rule: 'r-genre' })).toBe('Genre rule');
    expect(elementNameIn(m, { domain: 'd-gone' })).toBe('domain d-gone');
  });
});

describe('a mapping update the change set accepts', () => {
  it('writes the strategy id and the conversion as fields of the mapping', () => {
    const { m, map } = domainModel();
    const update = {
      op: 'update' as const,
      target: { mapping: map.id },
      before: { strategyId: map.strategyId },
      after: { strategyId: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' as const, converted: { from: 'OWL_ENUMERATION_TO_LDM_DOMAIN' as const, to: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' as const, at: 5 } },
    };
    const result = applied(m, [update]);
    expect(result.refusals).toEqual([]);
    expect(result.next!.mappings[0]).toMatchObject(update.after);
  });
});
