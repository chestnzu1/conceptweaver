import { propKey, restrictionsOf, type Restriction } from './props';
import { reason, type SuperLink } from './reasoner';
import type { Model } from './types';
import { resolveModel } from './vocab';

/**
 * Restrictions that hold for a class without being stated on it.
 *
 * They are taken from the reasoner in one way only: the reasoner says which classes a class is
 * entailed to be a kind of (stated superclasses, superclasses further up, and equivalent
 * classes), and whatever is asserted of such a class holds for the class too. That step is
 * sound in OWL: from C ⊑ D and D ⊑ R it follows that C ⊑ R.
 */

export interface RestrictionSource extends SuperLink {
  name: string;
}

export interface InferredRestriction {
  key: string;
  /** The restriction as asserted where it comes from. */
  restriction: Restriction;
  /** Every entailed superclass it is asserted on, nearest (directly stated) first. */
  sources: RestrictionSource[];
}

/** A class expression kept as text (see Term.axioms) that is inherited in the same way. */
export interface InferredExpression {
  key: string;
  text: string;
  sources: RestrictionSource[];
}

export interface InferredRestrictions {
  /**
   * ok: the lists are what the reasoner entails. partial: the reasoner stopped early, so there
   * may be more. inconsistent: the ontology contradicts itself, so nothing reliable can be said.
   * unsatisfiable: this class cannot have members, so everything trivially holds of it.
   * none: not a class of an ontology.
   */
  status: 'ok' | 'partial' | 'inconsistent' | 'unsatisfiable' | 'none';
  restrictions: InferredRestriction[];
  expressions: InferredExpression[];
}

/** What makes two restrictions the same restriction: property, kind, number and filler. */
export function restrictionKey(r: Restriction): string {
  return r.data ? `d|${r.rel.to}|${r.quantifier}|${r.n ?? ''}` : `o|${propKey(r.rel.label)}|${r.quantifier}|${r.n ?? ''}|${r.rel.to}`;
}

/** The class expression of a kept axiom, whether it was stated as a superclass or as an equivalent class. */
const expressionOf = (axiom: string) => axiom.replace(/^(rdfs:subClassOf|owl:equivalentClass)\s+/, '');

const EMPTY = { restrictions: [], expressions: [] };

export function inferredRestrictions(model: Model, classId: string): InferredRestrictions {
  const m = resolveModel(model);
  const byId = new Map(m.terms.map((t) => [t.id, t]));
  const self = byId.get(classId);
  if (m.mode === 'skos' || self?.type !== 'concept') return { status: 'none', ...EMPTY };
  const reasoning = reason(model);
  // From a contradiction anything follows, so nothing is worth listing.
  if (!reasoning.consistent) return { status: 'inconsistent', ...EMPTY };

  const own = new Set(restrictionsOf(model, classId).map(restrictionKey));
  const ownText = new Set((self.axioms ?? []).map(expressionOf));
  const restrictions = new Map<string, InferredRestriction>();
  const expressions = new Map<string, InferredExpression>();
  // Directly stated superclasses first, so that the nearest source is named first.
  const supers = [...reasoning.superclasses(classId)].sort((a, b) => Number(b.asserted) - Number(a.asserted));
  for (const link of supers) {
    const source: RestrictionSource = { ...link, name: byId.get(link.id)?.name || 'Unnamed' };
    for (const r of restrictionsOf(model, link.id)) {
      const key = restrictionKey(r);
      if (own.has(key)) continue;
      const hit = restrictions.get(key);
      if (hit) hit.sources.push(source);
      else restrictions.set(key, { key, restriction: r, sources: [source] });
    }
    for (const axiom of byId.get(link.id)?.axioms ?? []) {
      const text = expressionOf(axiom);
      if (ownText.has(text)) continue;
      const hit = expressions.get(text);
      if (hit) hit.sources.push(source);
      else expressions.set(text, { key: text, text, sources: [source] });
    }
  }
  return {
    status: reasoning.unsatisfiable.has(classId) ? 'unsatisfiable' : reasoning.truncated ? 'partial' : 'ok',
    restrictions: [...restrictions.values()],
    expressions: [...expressions.values()],
  };
}

/** What the reasoner does not work out, so that an empty or short list is not read as "nothing else follows". */
export const NOT_INFERRED = [
  'Weaker forms of a restriction: “exactly 2” also implies “min 2”, “max 2” and “some”, and “directs some Documentary” implies “directs some Film”. Only the restriction as stated is shown.',
  'Restrictions through the property hierarchy: one on a sub-property or an inverse property is not turned into one on the related property.',
  'Class membership that follows from a restriction, such as a property’s domain making a restricted class a kind of that domain.',
  'Anything that needs the inside of a kept class expression (unions, intersections, nested restrictions): those are inherited as text, not interpreted.',
];
