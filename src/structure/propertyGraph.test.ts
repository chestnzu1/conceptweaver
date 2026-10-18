import { describe, expect, it } from 'vitest';
import { StructureError, type PropertyRef } from './contracts';
import {
  buildPropertyHierarchy,
  byPropRef,
  narrowProperties,
  propertyDescendantsOf,
  propertyEntryOf,
  propertyNodeOf,
  propertyPathsTo,
  type PropertyInput,
} from './propertyGraph';

const NS = 'http://example.org/p#';

const at = (name: string, type: 'object' | 'data' = 'object', extra: Partial<PropertyRef> = {}): PropertyInput => ({ ref: { iri: NS + name, label: name, type, ...extra } });
const built = (properties: PropertyInput[], links: [string, string][]) => buildPropertyHierarchy({ properties, subPropertyOf: links.map(([sub, sup]) => ({ sub: NS + sub, sup: NS + sup })) });
const names = (refs: PropertyRef[]) => refs.map((r) => r.label);
const ways = (h: PropertyHierarchyInput, name: string, limit = 10) => propertyPathsTo(h, NS + name, limit);

type PropertyHierarchyInput = ReturnType<typeof built>;

describe('the hierarchy of the properties', () => {
  it('lists each property under its stated superproperties, and those with none at the top, in order of label', () => {
    const h = built([at('works for'), at('employed by'), at('age', 'data'), at('related to')], [
      ['employed by', 'works for'],
      ['works for', 'related to'],
    ]);
    expect(names(h.top.map((iri) => h.entries.get(iri)!.ref))).toEqual(['age', 'related to']);
    expect(names(propertyEntryOf(h, NS + 'related to').children.map((iri) => h.entries.get(iri)!.ref))).toEqual(['works for']);
    expect(propertyEntryOf(h, NS + 'employed by').parents).toEqual([NS + 'works for']);
    expect(propertyEntryOf(h, NS + 'employed by').inCycle).toBe(false);
  });

  it('takes an IRI as one property however often it is listed, and drops a link that goes nowhere or to itself', () => {
    const h = buildPropertyHierarchy({
      properties: [at('works for', 'object'), at('works for', 'data', { external: true })],
      subPropertyOf: [
        { sub: NS + 'works for', sup: NS + 'works for' },
        { sub: NS + 'works for', sup: NS + 'Nobody' },
        { sub: NS + 'Nobody', sup: NS + 'works for' },
      ],
    });
    expect(h.entries.size).toBe(1);
    const e = propertyEntryOf(h, NS + 'works for');
    // The first listing speaks for it: an object property, not external.
    expect(e.ref).toEqual({ iri: NS + 'works for', label: 'works for', type: 'object' });
    expect(h.top).toEqual([NS + 'works for']);
    expect(e.parents).toEqual([]);
    expect(e.children).toEqual([]);
  });

  it('states a link twice as one link, from the subproperty to the superproperty', () => {
    const h = built([at('a'), at('b')], [
      ['a', 'b'],
      ['a', 'b'],
    ]);
    expect(propertyEntryOf(h, NS + 'a').parents).toEqual([NS + 'b']);
    expect(propertyEntryOf(h, NS + 'b').children).toEqual([NS + 'a']);
  });

  it('allows for a ring of properties that are each other’s superproperties, and lists one of them at the top', () => {
    // "a" and "b" are each other's superproperties, and both are below "c".
    const h = built([at('a'), at('b'), at('c'), at('top')], [
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'c'],
      ['c', 'top'],
    ]);
    expect(h.cycles.map((ring) => names(ring.map((iri) => h.entries.get(iri)!.ref)).sort())).toEqual([['a', 'b']]);
    expect(propertyEntryOf(h, NS + 'a').inCycle).toBe(true);
    expect(propertyEntryOf(h, NS + 'b').inCycle).toBe(true);
    expect(propertyEntryOf(h, NS + 'c').inCycle).toBe(false);
    // The ring is reached from the top, so no member of it is listed there as well.
    expect(names(h.top.map((iri) => h.entries.get(iri)!.ref))).toEqual(['top']);
  });

  it('surfaces one member of a ring that has nothing above it, so that every property is somewhere', () => {
    const h = built([at('beta'), at('alpha')], [
      ['beta', 'alpha'],
      ['alpha', 'beta'],
    ]);
    expect(names(h.top.map((iri) => h.entries.get(iri)!.ref))).toEqual(['alpha']);
    expect(h.cycles).toHaveLength(1);
  });

  it('narrows to what a filter finds, with the properties leading down to them, and counts what it found', () => {
    const h = built([at('related to'), at('works for'), at('employed by'), at('age', 'data')], [
      ['works for', 'related to'],
      ['employed by', 'works for'],
    ]);
    const found = narrowProperties(h, 'EMPLOY');
    expect(names([...found.matches].map((iri) => h.entries.get(iri)!.ref))).toEqual(['employed by']);
    expect([...found.kept].sort()).toEqual([NS + 'employed by', NS + 'related to', NS + 'works for'].sort());
    // A property that is only on the way keeps its place, but is not a match; its counted children are the kept ones.
    const node = propertyNodeOf(h, NS + 'works for', found);
    expect(node).toMatchObject({ childCount: 1 });
    expect(node.match).toBeUndefined();
    expect(propertyNodeOf(h, NS + 'employed by', found)).toMatchObject({ childCount: 0, match: true });
    expect(propertyNodeOf(h, NS + 'age', found).match).toBeUndefined();
    expect(narrowProperties(h, 'zebra').matches.size).toBe(0);
  });

  it('gives the ways down to a property, shortest first, from the properties at the top', () => {
    const h = built([at('top'), at('left'), at('right'), at('leaf')], [
      ['left', 'top'],
      ['right', 'top'],
      ['leaf', 'left'],
      ['leaf', 'right'],
      ['leaf', 'top'],
    ]);
    const all = ways(h, 'leaf');
    expect(all.paths.map(names)).toEqual([['top', 'leaf'], ['top', 'left', 'leaf'], ['top', 'right', 'leaf']]);
    expect(all.truncated).toBe(false);
    expect(ways(h, 'leaf', 1).truncated).toBe(true);
    // A way is made of the refs as they are listed, by IRI, so that it can be followed down the hierarchy.
    expect(all.paths[0][0]).toEqual({ iri: NS + 'top', label: 'top', type: 'object' });
  });

  it('goes round a ring at most once on the way down', () => {
    const h = built([at('top'), at('a'), at('b'), at('leaf')], [
      ['a', 'top'],
      ['b', 'a'],
      ['a', 'b'],
      ['leaf', 'b'],
    ]);
    const all = ways(h, 'leaf');
    expect(all.paths.map(names)).toEqual([['top', 'a', 'b', 'leaf']]);
  });

  it('counts what is below a property, each once, ring or no ring', () => {
    const h = built([at('top'), at('a'), at('b')], [
      ['a', 'top'],
      ['b', 'top'],
      ['b', 'a'],
    ]);
    expect(propertyDescendantsOf(h, NS + 'top')).toBe(2);
    expect(propertyDescendantsOf(h, NS + 'a')).toBe(1);
    const ring = built([at('x'), at('y'), at('top')], [
      ['x', 'y'],
      ['y', 'x'],
      ['x', 'top'],
    ]);
    expect(propertyDescendantsOf(ring, NS + 'top')).toBe(2);
    expect(propertyDescendantsOf(ring, NS + 'x')).toBe(1);
  });

  it('refuses a property that is not in the hierarchy, and orders by label and then by IRI', () => {
    const h = built([at('b')], []);
    expect(() => propertyEntryOf(h, NS + 'Nobody')).toThrow(StructureError);
    try {
      propertyEntryOf(h, NS + 'Nobody');
    } catch (e) {
      expect(e).toMatchObject({ code: 'not-found' });
    }
    const order = [at('same', 'object', { iri: NS + 'z' }), at('same', 'object', { iri: NS + 'a' }), at('alpha')].map((x) => x.ref);
    expect(names(order.sort(byPropRef))).toEqual(['alpha', 'same', 'same']);
    expect(order.map((r) => r.iri)).toEqual([NS + 'alpha', NS + 'a', NS + 'z']);
  });
});
