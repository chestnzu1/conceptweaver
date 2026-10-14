import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { linkProps } from './identity';
import { withIris } from './iri';
import { objectProperties, plainRelationships, relChoice } from './props';
import { toTurtle } from './rdf';
import { MODEL_VERSION, normalizeModel, type Model } from './types';

/**
 * Models saved in format 1, before object properties had ids (fixtures/v1, written by the code of
 * that format and not since), opened by the code of today. Beside each is what the code of format
 * 1 made of it: its Turtle, and its reading (what every relationship is, every property with its
 * links and uses, and the labels that were no property). A model saved then has to open as the
 * same model: the same ontology, the same relationships, the same properties, the same picture.
 */
const dir = new URL('./fixtures/v1/', import.meta.url).pathname;
const read = (file: string) => fs.readFileSync(dir + file, 'utf8');
// As the editor opens a model: read, every named entity given its IRI, every relationship joined to its property.
const open = (raw: unknown): Model => linkProps(withIris(normalizeModel(raw)));

/** What format 1's code wrote down of a model, worked out by today's: links and uses are by id now, and shown by name. */
function reading(m: Model) {
  const props = objectProperties(m);
  const name = (id: string) => props.find((p) => p.id === id)?.name ?? `(${id})`;
  return {
    relations: Object.fromEntries(m.relations.map((r) => [r.id, relChoice(m, r)])),
    props: props.map((p) => ({ name: p.name, iri: p.iri, chars: p.chars, domain: p.domain, range: p.range, parents: p.parents.map(name), inverses: p.inverses.map(name), equivalents: p.equivalents.map(name), disjoints: p.disjoints.map(name), uses: p.rels.map((r) => r.id).sort() })),
    plain: plainRelationships(m).map((p) => ({ name: p.name, uses: p.rels.map((r) => r.id).sort() })),
  };
}

describe('a model saved in format 1', () => {
  for (const name of ['sample', 'university', 'edge-cases']) {
    describe(name, () => {
      const raw = JSON.parse(read(`${name}.json`));
      const m = open(raw);

      it('was saved in format 1, and opens in the format of today, every object property with an id of its own', () => {
        expect(raw.version).toBe(1);
        expect(raw.props.every((p: Record<string, unknown>) => p.id === undefined)).toBe(true);
        expect(m.version).toBe(MODEL_VERSION);
        expect(new Set(m.props.map((p) => p.id)).size).toBe(m.props.length);
        expect(m.props.map((p) => p.name)).toEqual(raw.props.map((p: { name: string }) => p.name));
      });

      it('says the same thing: its Turtle is what format 1 wrote', () => {
        expect(toTurtle(m)).toBe(read(`${name}.ttl`));
      });

      it('reads the same: every relationship is what it was, every property has the same links and uses', () => {
        expect(reading(m)).toEqual(JSON.parse(read(`${name}.reading.json`)));
      });

      it('looks the same: positions, colours, labels, styles and layout are untouched', () => {
        const before = normalizeModel(raw);
        expect(m.terms.map((t) => [t.id, t.name, t.x, t.y, t.color])).toEqual(raw.terms.map((t: Model['terms'][number]) => [t.id, t.name, t.x, t.y, t.color]));
        expect(m.relations.map((r) => [r.id, r.from, r.to, r.label])).toEqual(raw.relations.map((r: Model['relations'][number]) => [r.id, r.from, r.to, r.label]));
        expect(m.style).toEqual(before.style);
        expect(m.layout).toEqual(before.layout);
      });

      it('is saved in the format of today, and opens from that unchanged', () => {
        const saved = JSON.parse(JSON.stringify(m));
        expect(saved.version).toBe(MODEL_VERSION);
        // Every use of a property names it by id, so that a rename cannot detach it.
        const used = new Set(m.relations.filter((r) => relChoice(m, r) === 'object').map((r) => r.id));
        expect(m.relations.filter((r) => used.has(r.id)).every((r) => m.props.some((p) => p.id === r.prop))).toBe(true);
        expect(open(saved)).toEqual(m);
      });
    });
  }
});
