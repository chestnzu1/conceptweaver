import { edgeTypeOf, type EdgeType } from './graphStyle';
import { isInstanceOf, plainRelationships, restrictionByRelation } from './props';
import { relLabel, type Model } from './types';
import { resolveModel } from './vocab';

const cache = new WeakMap<Model, Map<string, EdgeType>>();

/**
 * What kind of edge each relationship of a model is drawn as, by relationship id: "is a", class
 * membership, a restriction, a fact, a plain relationship and so on. It follows from what the
 * relationship means, so it is worked out from the model as it is read (see resolveModel) and
 * remembered for as long as that model is.
 */
export function edgeTypesOf(meaning: Model): Map<string, EdgeType> {
  const hit = cache.get(meaning);
  if (hit) return hit;
  const type = new Map(meaning.terms.map((t) => [t.id, t.type]));
  const plain = new Set<string>();
  if (meaning.mode !== 'skos') for (const p of plainRelationships(meaning)) for (const r of p.rels) plain.add(r.id);
  const restrictions = restrictionByRelation(meaning);
  const out = new Map<string, EdgeType>();
  for (const r of resolveModel(meaning).relations) {
    out.set(r.id, edgeTypeOf(r, { instanceOf: isInstanceOf(meaning, r), plain: plain.has(r.id), restriction: restrictions.has(r.id), betweenProperties: type.get(r.from) === 'property' && type.get(r.to) === 'property' }));
  }
  cache.set(meaning, out);
  return out;
}

const labels = new WeakMap<Model, Map<string, string>>();

/**
 * The words on each relationship's line, by relationship id: its label, or what its kind is
 * called where it has none. A restriction reads "directs some", and several on one line
 * "directs some, only". The canvas draws these and the exported page lists them.
 */
export function edgeLabelsOf(meaning: Model): Map<string, string> {
  const hit = labels.get(meaning);
  if (hit) return hit;
  const skos = meaning.mode === 'skos';
  const restrictions = restrictionByRelation(meaning);
  const out = new Map<string, string>();
  for (const r of resolveModel(meaning).relations) {
    const stated = restrictions.get(r.id);
    out.set(r.id, stated ? `${stated[0].data ? 'has' : stated[0].property} ${stated.map((x) => x.quantifier + (x.n !== undefined ? ' ' + x.n : '')).join(', ')}` : relLabel(r, skos, isInstanceOf(meaning, r)));
  }
  labels.set(meaning, out);
  return out;
}
