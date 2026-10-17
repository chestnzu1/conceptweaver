import { describe, expect, it } from 'vitest';
import type { LogicalModel } from './contracts';
import { emptyLogicalModel } from './rules';
import { ldmProblems } from './findings';

/** A model with two entities, neither identified, joined both ways by one relationship. */
function shop(): LogicalModel {
  return {
    ...emptyLogicalModel({ name: 'Shop', id: 'ldm-shop' }),
    entities: [
      { id: 'e-customer', name: 'Customer', definition: '', attributes: [], keys: [] },
      { id: 'e-order', name: 'Order', definition: '', attributes: [], keys: [] },
    ],
    relationships: [{ id: 'r-places', name: 'places', definition: '', ends: [{ entity: 'e-customer', role: '', min: 0, max: 'many' }, { entity: 'e-order', role: '', min: 0, max: 'many' }], identifying: false }],
  };
}

describe('what the validation view says of the logical models', () => {
  it('finds an entity nothing identifies and a many-to-many worth resolving', () => {
    const found = ldmProblems([shop()]);
    expect(found.map((p) => p.ruleId)).toEqual(['ldm-no-primary-key', 'ldm-no-primary-key', 'ldm-many-to-many']);
    expect(found.every((p) => p.model === 'ldm-shop' && p.modelName === 'Shop')).toBe(true);
    expect(found[0]).toMatchObject({ severity: 'warning', element: { entity: 'e-customer' }, elementName: 'Customer' });
    expect(found[2]).toMatchObject({ severity: 'info', element: { relationship: 'r-places' } });
    expect(found[2].message).toMatch(/many-to-many/);
  });

  it('does not say an entity nothing identifies when the entity it inherits from identifies it', () => {
    const m: LogicalModel = {
      ...shop(),
      entities: [
        { id: 'e-customer', name: 'Customer', definition: '', attributes: [{ id: 'a-id', name: 'id', definition: '', type: { base: 'identifier' }, optional: false }], keys: [{ id: 'k-customer', kind: 'primary', name: 'Primary key', members: [{ attribute: 'a-id' }] }] },
        { id: 'e-order', name: 'Order', definition: '', attributes: [], keys: [] },
      ],
      generalizations: [{ id: 'g-order', supertype: 'e-customer', subtypes: ['e-order'], complete: false, exclusive: false }],
    };
    expect(ldmProblems([m]).filter((p) => p.ruleId === 'ldm-no-primary-key')).toEqual([]);
  });

  it('names the model itself, where the problem is the model’s', () => {
    const m = { ...shop(), name: '' };
    const found = ldmProblems([m]);
    const at = found.find((p) => p.ruleId === 'ldm-rule' && !p.element)!;
    expect(at.elementName).toBe('');
    expect(at.severity).toBe('error');
  });

  it('says what breaks the rules of an LDM that was read from elsewhere', () => {
    const m = shop();
    m.entities[1].name = 'customer'; // two entities with one name, whatever the case
    const found = ldmProblems([m]);
    const broken = found.filter((p) => p.ruleId === 'ldm-rule');
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ severity: 'warning', element: { entity: 'e-order' } });
    expect(broken[0].message).toMatch(/Two entities are called/);
  });

  it('gives each finding its own id, the same one for the same model', () => {
    const model = shop();
    model.entities[0].name = '';
    model.entities[0].attributes = [{ id: 'a-x', name: '', definition: '', type: { base: 'text' }, optional: true }];
    const first = ldmProblems([model]);
    expect(new Set(first.map((p) => p.id)).size).toBe(first.length);
    expect(ldmProblems([model]).map((p) => p.id)).toEqual(first.map((p) => p.id));
  });
});
