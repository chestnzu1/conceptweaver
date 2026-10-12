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

/**
 * A line on the canvas that is no relationship of the model: it is drawn from something else the
 * model says. Either a class membership the reasoner worked out, or an individual that a class
 * lists as one of its members.
 */
export interface DerivedEdge {
  id: string;
  from: string;
  to: string;
  /** inferred: a class membership. fact: a relationship between two individuals. Both worked out by a reasoner. */
  kind: 'inferred' | 'oneOf' | 'fact';
  /** What it rests on, in words. */
  because: string;
  /** For a relationship between individuals: the name of the object property. */
  name?: string;
}

/**
 * Enumeration membership: for each class that is defined as a list of individuals, a line from
 * the class to each one it lists. It is a picture of the owl:oneOf class expression and nothing
 * more: no such triple is in the model, and it does not say the individual has the class as its type.
 */
export function enumerationEdges(model: Model): DerivedEdge[] {
  const ids = new Set(model.terms.map((t) => t.id));
  const out: DerivedEdge[] = [];
  for (const c of model.terms) {
    if (c.type !== 'concept' || !c.oneOf) continue;
    for (const m of c.oneOf) if (ids.has(m) && m !== c.id) out.push({ id: `oneof:${c.id}|${m}`, from: c.id, to: m, kind: 'oneOf', because: `“${c.name || 'Unnamed'}” is defined as an enumeration that lists it (owl:oneOf).` });
  }
  return out;
}

export const ONE_OF_LABEL = 'one of';

/**
 * The inferred class memberships that say something the lines of the enumerations do not. What a
 * class lists are its instances, so the reasoner gives each member as one; where the line of the
 * enumeration is drawn already, a second line between the same two would only repeat it.
 */
export function beyondEnumerations<T extends { from: string; to: string }>(inferred: T[], listed: DerivedEdge[]): T[] {
  if (!inferred.length || !listed.length) return inferred;
  const drawn = new Set(listed.map((e) => `${e.to}|${e.from}`));
  return inferred.filter((x) => !drawn.has(`${x.from}|${x.to}`));
}
