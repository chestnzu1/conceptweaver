import { describe, expect, it } from 'vitest';
import type { LogicalChange, LogicalModel } from './contracts';
import { applied, emptyLogicalModel, removalOf } from './rules';
import { attributeAdded, attributesOfEntity, diagramChange, domainAdded, endChanged, entityAdded, freeName, generalizationAdded, hasPrimaryKey, inheritedKeysOf, keyAdded, keysOfEntity, relationshipAdded, resolveManyToMany, ruleAdded, typeFromSetting, typeSetting, updatedChange, wouldCycle } from './edits';

/**
 * The changes the LDM workspace makes (roadmap LM-2): each is a change set the edit service can
 * apply, valid to begin with, and names do not collide whatever their case.
 */

const next = (m: LogicalModel, ...changes: LogicalChange[]): LogicalModel => {
  const r = applied(m, changes);
  if (!r.next) throw new Error(r.refusals.map((x) => x.message).join('\n'));
  return r.next;
};

function withEntities(names: string[]): { m: LogicalModel; ids: string[] } {
  let m = emptyLogicalModel({ name: 'Test' });
  const ids: string[] = [];
  for (const name of names) {
    const made = entityAdded(m, name);
    m = next(m, made.change);
    ids.push(made.id);
  }
  return { m, ids };
}

describe('names made by the workspace', () => {
  it('are free whichever their case, and say so when they are not', () => {
    expect(freeName(['Film'], 'film')).toBe('film 2');
    expect(freeName(['Film', 'Film 2'], 'Film')).toBe('Film 3');
    expect(freeName([], ' Film ')).toBe('Film');
    expect(freeName([], '  ')).toBe('Untitled');
  });
});

describe('entities and their parts', () => {
  it('makes entities with names nothing else has', () => {
    const { m } = withEntities(['Customer', 'customer']);
    expect(m.entities.map((e) => e.name)).toEqual(['Customer', 'customer 2']);
  });

  it('adds an attribute as text and optional unless asked otherwise', () => {
    const { m, ids } = withEntities(['Customer']);
    const made = attributeAdded(m, ids[0])!;
    const after = next(m, made.change);
    expect(after.entities[0].attributes[0]).toMatchObject({ name: 'Attribute', type: { base: 'text' }, optional: true });
    expect(attributesOfEntity(after, ids[0]).map((a) => a.id)).toEqual([made.id]);
  });

  it('makes a key from what the entity has, and only one primary', () => {
    const { m, ids } = withEntities(['Customer']);
    const attribute = attributeAdded(m, ids[0])!;
    let after = next(m, attribute.change);
    const key = keyAdded(after, ids[0], 'primary')!;
    after = next(after, key.change);
    expect(after.entities[0].keys[0]).toMatchObject({ kind: 'primary', members: [{ attribute: attribute.id }] });
    expect(keyAdded(after, ids[0], 'primary')).toBeUndefined();
    expect(keyAdded(after, ids[0], 'candidate')).toBeDefined();
  });

  it('lets no key be made of nothing', () => {
    const { m, ids } = withEntities(['Customer']);
    expect(keyAdded(m, ids[0], 'primary')).toBeUndefined();
  });

  it('gives a domain a base type and attributes may take it', () => {
    const made = domainAdded(emptyLogicalModel({ name: 'Test' }), 'Rating');
    const after = next(emptyLogicalModel({ name: 'Test' }), made.change);
    expect(after.domains[0]).toMatchObject({ name: 'Rating', base: { base: 'text' }, constraints: {} });
    expect(typeSetting({ domain: made.id })).toBe(`domain:${made.id}`);
    expect(typeFromSetting(`domain:${made.id}`, after)).toEqual({ domain: made.id });
    expect(typeFromSetting('domain:gone', after)).toEqual({ base: 'text' });
  });
});

describe('relationships', () => {
  it('starts from two entities, one end many and the other at most one', () => {
    const { m, ids } = withEntities(['Customer', 'Order']);
    const made = relationshipAdded(m)!;
    const after = next(m, made.change);
    expect(after.relationships[0].ends).toEqual([
      { entity: ids[0], role: '', min: 0, max: 'many' },
      { entity: ids[1], role: '', min: 0, max: 1 },
    ]);
  });

  it('keeps a minimum and a maximum that make sense together', () => {
    const end = { entity: 'e', role: '', min: 0, max: 1 as const };
    expect(endChanged(end, { min: 3 })).toMatchObject({ min: 3, max: 3 });
    expect(endChanged(end, { max: 'many' })).toMatchObject({ min: 0, max: 'many' });
    expect(endChanged(end, { min: 2, max: 'many' })).toMatchObject({ min: 2, max: 'many' });
  });

  it('resolves a many-to-many into an associative entity, its key borrowed from both ends', () => {
    const { m, ids } = withEntities(['Customer', 'Product']);
    const made = relationshipAdded(m)!;
    let after = next(m, made.change);
    const rel = after.relationships[0];
    const both = updatedChange({ relationship: rel.id }, rel, {
      name: 'buys',
      ends: [
        { ...rel.ends[0], min: 0, max: 'many' },
        { ...rel.ends[1], min: 0, max: 'many' },
      ],
    });
    after = next(after, both);
    const rule = ruleAdded(after, { name: 'One purchase', statement: 'A customer buys many products.', appliesTo: [{ relationship: rel.id }] })!;
    after = next(after, rule.change);

    const resolved = resolveManyToMany(after, rel.id);
    expect('changes' in resolved).toBe(true);
    if (!('changes' in resolved)) return;
    const done = next(after, ...resolved.changes);

    expect(done.relationships.find((r) => r.id === rel.id)).toBeUndefined();
    const entity = done.entities.find((e) => e.id === resolved.entity)!;
    expect(entity.name).toBe('buys');
    expect(entity.keys[0].members).toHaveLength(2);
    expect(entity.keys[0].members.every((x) => 'end' in x)).toBe(true);
    const identifying = done.relationships.filter((r) => r.identifying && r.ends[0].entity === entity.id);
    expect(identifying).toHaveLength(2);
    expect(identifying.map((r) => r.ends[1].entity).sort()).toEqual([...ids].sort());
    // What named the relationship names what took its place.
    expect(done.rules.find((r) => r.id === rule.id)!.appliesTo).toEqual([{ entity: resolved.entity }]);
  });

  it('resolves nothing that is not many at both ends', () => {
    const { m } = withEntities(['Customer', 'Order']);
    const made = relationshipAdded(m)!;
    const after = next(m, made.change);
    const result = resolveManyToMany(after, made.id);
    expect('error' in result && result.error).toMatch(/many at both ends/);
  });
});

describe('specialization', () => {
  it('adds a supertype, and refuses the edge that would make a circle', () => {
    const { m, ids } = withEntities(['A', 'B', 'C']);
    const ab = generalizationAdded(m, ids[0], ids[1])!;
    let after = next(m, ab.change);
    const bc = generalizationAdded(after, ids[1], ids[2])!;
    after = next(after, bc.change);
    expect(wouldCycle(after, ids[2], ids[0])).toBe(true);
    expect(generalizationAdded(after, ids[2], ids[0])).toBeUndefined();
    expect(wouldCycle(after, ids[0], ids[2])).toBe(false);
  });

  it('identifies a subtype as its supertype is: its key is inherited, and it may not have a second primary', () => {
    const { m, ids } = withEntities(['Work', 'Film']);
    const attribute = attributeAdded(m, ids[0])!;
    let after = next(m, attribute.change);
    const key = keyAdded(after, ids[0], 'primary')!;
    after = next(after, key.change);
    after = next(after, generalizationAdded(after, ids[0], ids[1])!.change);
    const inherited = after.entities[0].keys[0];
    expect(hasPrimaryKey(after, ids[1])).toBe(true);
    expect(inheritedKeysOf(after, ids[1])).toEqual([{ key: inherited, from: ids[0] }]);
    expect(keysOfEntity(after, ids[1])).toEqual([inherited]);
    expect(keyAdded(after, ids[1], 'primary')).toBeUndefined();
    // A candidate key of the subtype gets a name of its own, inherited names included.
    expect(keyAdded(after, ids[1], 'candidate')!.change).toMatchObject({ element: { key: { name: 'Candidate key' } } });
  });
});

describe('rules and diagrams', () => {
  it('will not make a rule that says nothing', () => {
    const m = emptyLogicalModel({ name: 'Test' });
    expect(ruleAdded(m, { name: '', statement: 'Something.' })).toBeUndefined();
    expect(ruleAdded(m, { name: 'Something', statement: '  ' })).toBeUndefined();
    expect(ruleAdded(m, { name: 'Something', statement: 'Something is true.' })).toBeDefined();
  });

  it('keeps one diagram of where the entities sit, adding it the first time', () => {
    const { m, ids } = withEntities(['A', 'B']);
    const first = diagramChange(m, { [ids[0]]: { x: 10, y: 20 }, [ids[1]]: { x: 30, y: 40 } });
    expect(first.op).toBe('add');
    const after = next(m, first);
    expect(after.diagrams).toHaveLength(1);
    const second = diagramChange(after, { [ids[0]]: { x: 50, y: 60 } });
    expect(second.op).toBe('update');
    const moved = next(after, second);
    expect(moved.diagrams).toHaveLength(1);
    expect(moved.diagrams[0].positions).toEqual({ [ids[0]]: { x: 50, y: 60 } });
  });

  it('takes an entity out with everything that would name what is gone', () => {
    const { m, ids } = withEntities(['A', 'B']);
    const rel = relationshipAdded(m)!;
    let after = next(m, rel.change);
    const rule = ruleAdded(after, { name: 'About A', statement: 'Every A is a B.', appliesTo: [{ entity: ids[0] }] })!;
    after = next(after, rule.change);
    const diagram = diagramChange(after, { [ids[0]]: { x: 1, y: 2 }, [ids[1]]: { x: 3, y: 4 } });
    after = next(after, diagram);
    const trimmed = next(after, ...removalOf(after, { entity: ids[0] }));
    expect(trimmed.entities.map((e) => e.id)).toEqual([ids[1]]);
    expect(trimmed.relationships).toEqual([]);
    expect(trimmed.rules[0].appliesTo).toEqual([]);
    expect(trimmed.diagrams[0].positions[ids[0]]).toBeUndefined();
  });
});
