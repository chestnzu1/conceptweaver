import { describe, expect, it } from 'vitest';
import { STRATEGY_IDS, type StrategyId } from './contracts';
import { convertibleFrom, expectedKindOf, isApplicable, isStrategyId, reasonsNotApplicable, STRATEGIES, strategyById, strategyForText, strategyText } from './strategies';

/**
 * The strategy catalogue (roadmap LM-4): every correspondence the transformation writes has a
 * stable id and the words it records; old words read back as their id, and words the catalogue
 * does not know are never guessed at.
 */

describe('the catalogue', () => {
  it('has one entry per id, with unique labels and a target kind', () => {
    expect(new Set(STRATEGY_IDS).size).toBe(STRATEGY_IDS.length);
    expect(STRATEGIES.map((e) => e.id).sort()).toEqual([...STRATEGY_IDS].sort());
    expect(new Set(STRATEGIES.map((e) => e.label)).size).toBe(STRATEGIES.length);
    for (const entry of STRATEGIES) {
      expect(entry.sourceKinds.length).toBeGreaterThan(0);
      expect(entry.target).toBeTruthy();
      expect(entry.description.length).toBeGreaterThan(0);
      expect(isStrategyId(entry.id)).toBe(true);
      expect(strategyById(entry.id)).toBe(entry);
      expect(expectedKindOf(entry.id)).toBe(entry.target);
    }
  });
});

describe('reading a strategy back from its words', () => {
  it('round-trips every fixed label, collapsed whitespace included', () => {
    for (const entry of STRATEGIES.filter((e) => !e.textPrefix)) {
      expect(strategyForText(entry.label)?.id).toBe(entry.id);
      expect(strategyForText(`  ${entry.label.replace(/ /g, '  ')}  `)?.id).toBe(entry.id);
    }
  });

  it('reads the dynamic labels by their prefix, whatever names the element', () => {
    expect(strategyForText('restriction → candidate mandatory on the end “Studio”')?.id).toBe('OWL_RESTRICTION_TO_LDM_MANDATORY_END');
    expect(strategyForText('restriction → candidate cardinality on “Film” → “Studio”')?.id).toBe('OWL_RESTRICTION_TO_LDM_CARDINALITY_END');
  });

  it('never maps words it does not know to the nearest strategy', () => {
    expect(strategyForText('')).toBeUndefined();
    expect(strategyForText('class -> entity')).toBeUndefined();
    expect(strategyForText('class to entity')).toBeUndefined();
    expect(strategyForText('two classes → one entity, somehow')).toBeUndefined();
    expect(strategyForText('restriction → candidate mandatory')).toBeUndefined();
  });

  it('writes the words a strategy records, naming the element where its label does', () => {
    const fixed = strategyById('OWL_CLASS_TO_LDM_ENTITY')!;
    expect(strategyText(fixed)).toBe('class → entity');
    const dynamic = strategyById('OWL_RESTRICTION_TO_LDM_MANDATORY_END')!;
    expect(strategyText(dynamic, 'the end “Studio”')).toBe('restriction → candidate mandatory on the end “Studio”');
    expect(strategyText(dynamic)).toBe('restriction → candidate mandatory on a relationship');
  });
});

describe('whether a strategy applies', () => {
  const classesToEntity = strategyById('OWL_CLASSES_TO_LDM_ENTITY')!;
  const enumerationToDomain = strategyById('OWL_ENUMERATION_TO_LDM_DOMAIN')!;
  const dataToAttribute = strategyById('OWL_DATA_PROPERTY_TO_LDM_ATTRIBUTE')!;

  it('says when the target is the wrong kind', () => {
    expect(reasonsNotApplicable(enumerationToDomain, { sourceKinds: ['class'], targetKind: 'entity' })).toContain('makes a domain, not an entity');
    expect(isApplicable(enumerationToDomain, { sourceKinds: ['class'], targetKind: 'domain' })).toBe(true);
  });

  it('says when a source is the wrong kind', () => {
    const reason = reasonsNotApplicable(dataToAttribute, { sourceKinds: ['object property'], targetKind: 'attribute' });
    expect(reason).toContain('reads data properties');
    expect(reason).toContain('these sources are an object property');
  });

  it('holds the number of sources the strategy reads', () => {
    expect(reasonsNotApplicable(classesToEntity, { sourceKinds: ['class'], targetKind: 'entity' })).toBe('It needs at least 2 sources.');
    expect(isApplicable(classesToEntity, { sourceKinds: ['class', 'class'], targetKind: 'entity' })).toBe(true);
    expect(reasonsNotApplicable(enumerationToDomain, { sourceKinds: ['class', 'class'], targetKind: 'domain' })).toBe('It reads one source.');
    expect(reasonsNotApplicable(enumerationToDomain, { sourceKinds: [], targetKind: 'domain' })).toBe('The mapping has no source yet.');
  });

  it('offers only the conversions the planner can make exactly', () => {
    expect(convertibleFrom('domain')).toEqual(['entity']);
    expect(convertibleFrom('entity')).toEqual(['domain']);
    expect(convertibleFrom('relationship')).toEqual(['entity']);
    expect(convertibleFrom('attribute')).toEqual([]);
  });

  it('knows ids, and nothing else', () => {
    expect(isStrategyId('OWL_CLASS_TO_LDM_ENTITY')).toBe(true);
    expect(isStrategyId('OWL_CLASS_TO_ENTITY')).toBe(false);
    expect(isStrategyId(undefined)).toBe(false);
    expect(strategyById('OWL_CLASS_TO_ENTITY' as StrategyId)).toBeUndefined();
    expect(expectedKindOf(undefined)).toBeUndefined();
  });
});
