import type { ClassExpressionAxiom } from './expressions';
import { nameKey } from './identity';
import { classText, namingFor } from './manchester';
import { objectProperties, restrictionsOf, type Restriction } from './props';
import type { Reasoning, SuperLink } from './reasoner';
import { creditOf, type ReasoningResult } from './reasoning';
import type { Model, Relation } from './types';
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

/** A class expression stated of a superclass (see Term.classAxioms) that is inherited in the same way, as Manchester syntax. */
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
   * none: not a class of an ontology. working: the reasoner has not answered yet.
   */
  status: 'ok' | 'partial' | 'inconsistent' | 'unsatisfiable' | 'none' | 'working';
  restrictions: InferredRestriction[];
  expressions: InferredExpression[];
}

/** What makes two restrictions the same restriction: property, kind, number and filler. */
export function restrictionKey(r: Restriction): string {
  return r.data ? `d|${r.rel.to}|${r.quantifier}|${r.n ?? ''}` : `o|${r.rel.prop ?? nameKey(r.rel.label)}|${r.quantifier}|${r.n ?? ''}|${r.rel.to}`;
}

/**
 * The class expression a class axiom makes a superclass of the class, as a key that is the same
 * for the same expression: a superclass, or an equivalent class (which is one both ways). A
 * disjoint class is not one: undefined.
 */
export const expressionOf = (a: ClassExpressionAxiom): string | undefined => (a.kind === 'DisjointClasses' ? undefined : JSON.stringify(a.expression));

const EMPTY = { restrictions: [], expressions: [] };

/**
 * `reasoning` is the app's own reasoner's answer about the model, or nothing while it works.
 * `more` is what another reasoner (the OWL 2 DL one) entails beyond it: further superclasses to
 * inherit from in the same way, and whether the class is unsatisfiable.
 */
export function inferredRestrictions(model: Model, reasoning: Reasoning | undefined, classId: string, more?: { supers: SuperLink[]; unsatisfiable: boolean }): InferredRestrictions {
  const m = resolveModel(model);
  const byId = new Map(m.terms.map((t) => [t.id, t]));
  const self = byId.get(classId);
  if (m.mode === 'skos' || self?.type !== 'concept') return { status: 'none', ...EMPTY };
  if (!reasoning) return { status: 'working', ...EMPTY };
  // From a contradiction anything follows, so nothing is worth listing.
  if (!reasoning.consistent) return { status: 'inconsistent', ...EMPTY };

  const own = new Set(restrictionsOf(model, classId).map(restrictionKey));
  const ownText = new Set((self.classAxioms ?? []).map(expressionOf));
  const naming = namingFor(model);
  const restrictions = new Map<string, InferredRestriction>();
  const expressions = new Map<string, InferredExpression>();
  // Directly stated superclasses first, so that the nearest source is named first.
  const own_ = reasoning.superclasses(classId);
  const known = new Set(own_.map((l) => l.id));
  const supers = [...own_, ...(more?.supers ?? []).filter((l) => l.id !== classId && !known.has(l.id) && byId.get(l.id)?.type === 'concept')].sort((a, b) => Number(b.asserted) - Number(a.asserted));
  for (const link of supers) {
    const source: RestrictionSource = { ...link, name: byId.get(link.id)?.name || 'Unnamed' };
    for (const r of restrictionsOf(model, link.id)) {
      const key = restrictionKey(r);
      if (own.has(key)) continue;
      const hit = restrictions.get(key);
      if (hit) hit.sources.push(source);
      else restrictions.set(key, { key, restriction: r, sources: [source] });
    }
    for (const axiom of byId.get(link.id)?.classAxioms ?? []) {
      const key = expressionOf(axiom);
      if (key === undefined || ownText.has(key)) continue;
      const hit = expressions.get(key);
      if (hit) hit.sources.push(source);
      else expressions.set(key, { key, text: classText(axiom.expression, naming), sources: [source] });
    }
  }
  return {
    status: reasoning.unsatisfiable.has(classId) || more?.unsatisfiable ? 'unsatisfiable' : reasoning.truncated ? 'partial' : 'ok',
    restrictions: [...restrictions.values()],
    expressions: [...expressions.values()],
  };
}

/** What the reasoner does not work out, so that an empty or short list is not read as "nothing else follows". */
export const NOT_INFERRED = [
  'Weaker forms of a restriction: “exactly 2” also implies “min 2”, “max 2” and “some”, and “directs some Documentary” implies “directs some Film”. Only the restriction as stated is shown.',
  'Restrictions through the property hierarchy: one on a sub-property or an inverse property is not turned into one on the related property.',
  'Class membership that follows from a restriction, such as a property’s domain making a restricted class a kind of that domain.',
  'Anything that needs the inside of a class expression stated as an axiom (unions, intersections, nested restrictions): those are inherited as they are stated, not interpreted. The OWL 2 DL reasoner (HermiT) interprets them.',
  'What follows from an enumeration by trying each member in turn: a restriction that every member of { A, B } meets is not concluded for the class.',
];

/** A class membership that is entailed but not stated, shaped like the relation that would state it. */
export interface InferredMembership extends Pick<Relation, 'id' | 'from' | 'to'> {
  /** What it follows from, in words. */
  because: string;
}

/**
 * The class memberships the reasoner works out beyond the asserted ones: an instance of a class
 * is an instance of its superclasses, a property's domain and range say what its subject and
 * value are, and so on. Nothing here is in the model. An inconsistent ontology entails anything,
 * so it gives none.
 */
export function inferredMemberships(model: Model, reasoning: Reasoning): { consistent: boolean; truncated: boolean; memberships: InferredMembership[] } {
  const m = resolveModel(model);
  if (m.mode === 'skos') return { consistent: true, truncated: false, memberships: [] };
  if (!reasoning.consistent) return { consistent: false, truncated: reasoning.truncated, memberships: [] };
  const memberships: InferredMembership[] = [];
  for (const t of m.terms) {
    if (t.type !== 'instance') continue;
    for (const link of reasoning.types(t.id)) {
      if (!link.asserted) memberships.push({ id: `inferred:${t.id}|${link.id}`, from: t.id, to: link.id, because: link.because });
    }
  }
  return { consistent: true, truncated: reasoning.truncated, memberships };
}

/**
 * A relationship between two individuals that is entailed but not stated: through an inverse
 * property, a symmetric or transitive one, a sub-property or an equivalent property. Shaped like
 * the relation that would state it; nothing here is in the model.
 */
export interface InferredFact extends Pick<Relation, 'id' | 'from' | 'to'> {
  /** Key of the object property. */
  prop: string;
  /** Its name, as the line is labelled. */
  name: string;
  because: string;
}

/** The relationships between individuals that the app's own reasoner works out beyond the stated ones. */
export function inferredFacts(model: Model, reasoning: Reasoning): { consistent: boolean; truncated: boolean; facts: InferredFact[] } {
  const m = resolveModel(model);
  if (m.mode === 'skos') return { consistent: true, truncated: false, facts: [] };
  if (!reasoning.consistent) return { consistent: false, truncated: reasoning.truncated, facts: [] };
  const individuals = new Set(m.terms.filter((t) => t.type === 'instance').map((t) => t.id));
  const names = new Map(objectProperties(model).map((p) => [p.id, p.name]));
  const facts: InferredFact[] = [];
  for (const i of reasoning.inferences) {
    const [a, b] = [i.key.indexOf('|'), i.key.lastIndexOf('|')];
    const [from, pred, to] = [i.key.slice(0, a), i.key.slice(a + 1, b), i.key.slice(b + 1)];
    // A use of a declared object property between two individuals; a relationship kept plain has no meaning to follow from.
    if (!pred.startsWith('p:') || pred.startsWith('p:~') || !individuals.has(from) || !individuals.has(to) || !names.has(pred.slice(2))) continue;
    facts.push({ id: `fact:${from}|${pred.slice(2)}|${to}`, from, to, prop: pred.slice(2), name: names.get(pred.slice(2))!, because: i.because });
  }
  return { consistent: true, truncated: reasoning.truncated, facts };
}

/** What is entailed beyond what is stated, in the one shape everything that shows it reads. */
export interface Entailed {
  /** False when a reasoner finds the ontology inconsistent: then nothing is given as inferred. */
  consistent: boolean;
  /** A reasoner stopped early or left something out, so there may be more. */
  partial: boolean;
  /** Which reasoner, or reasoners, this is from, for saying so. */
  by: string;
  memberships: InferredMembership[];
  facts: InferredFact[];
  /** The app's own reasoner has not answered yet: what is here is the other one's alone, if anything. */
  working?: boolean;
}

export const FAST_CREDIT = 'the fast reasoner (RDFS / partial OWL RL)';

/**
 * Inferred class memberships and inferred relationships between individuals, from the app's own
 * reasoner and, when it was asked about the model as it is now, from the OWL 2 DL reasoner as
 * well. Both are sound, so what either finds holds; each is there once, and never if it is
 * stated. From an inconsistent ontology nothing is inferred.
 */
export function entailed(model: Model, reasoning: Reasoning | undefined, dl?: ReasoningResult): Entailed {
  const own = reasoning ? inferredMemberships(model, reasoning) : { consistent: true, truncated: false, memberships: [] };
  const facts = reasoning ? inferredFacts(model, reasoning) : { facts: [] };
  const by = dl ? `${dl.engine.name}${dl.engine.version ? ' ' + dl.engine.version : ''} (OWL 2 DL)` : FAST_CREDIT;
  if (!own.consistent || (dl && dl.consistency !== 'consistent')) return { consistent: false, partial: false, by, memberships: [], facts: [] };
  const out: Entailed = { consistent: true, partial: own.truncated || (!!dl && dl.status !== 'complete'), by, memberships: [...own.memberships], facts: [...facts.facts], ...(reasoning ? {} : { working: true }) };
  if (!dl) return out;
  const credit = creditOf(dl);
  const haveTypes = new Set(out.memberships.map((x) => `${x.from}|${x.to}`));
  for (const x of dl.types) if (!x.asserted && !haveTypes.has(`${x.individual}|${x.class}`)) out.memberships.push({ id: `inferred:${x.individual}|${x.class}`, from: x.individual, to: x.class, because: credit });
  const haveFacts = new Set(out.facts.map((x) => x.id));
  const names = new Map(objectProperties(model).map((p) => [p.id, p.name]));
  for (const x of dl.relations) {
    const id = `fact:${x.subject}|${x.property}|${x.object}`;
    if (x.asserted || haveFacts.has(id) || !names.has(x.property)) continue;
    out.facts.push({ id, from: x.subject, to: x.object, prop: x.property, name: names.get(x.property)!, because: credit });
  }
  return out;
}
