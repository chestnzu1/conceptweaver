import { listMappings } from './alignment';
import { addIsA, addLink, LINKS, linkedTerms, makeInstanceOf, type Edit, type LinkKind } from './axioms';
import { withAnchor } from './graphStyle';
import { configOf } from './modelTypes';
import { propOf } from './identity';
import { isInstanceOf, kindsBetween, relChoice, restrictionSpecs, type RelChoice } from './props';
import type { Model, Relation, Term, TermType } from './types';
import { resolveModel, stdProp } from './vocab';

/**
 * Moving one end of a relationship from the term it is on to another.
 *
 * That is an edit of the ontology, unlike moving where a line meets its term (the anchors of the
 * graph style, which say nothing). The statement the relationship made is withdrawn and the same
 * kind of statement is made about the new pair of terms, in one step. What the relationship is
 * never changes to make that possible: an "is a" stays an "is a", a use of an object property
 * stays a use of that property. Where the new pair cannot be related in that way the end cannot
 * be put there, and the reason is given in words.
 *
 * The rules are the ones the rest of the app relates terms by: what each pair of kinds of term
 * can be joined by (props.ts), what a standard property is meant to connect (vocab.ts), and what
 * is not stated twice or cannot hold together (axioms.ts). Nothing here draws anything. The
 * canvas asks which terms can take an end while it is dragged; the same answer decides when the
 * end is let go, and would decide for a server that kept the ontology.
 */

export type End = 'from' | 'to';

/** What a relationship is: one of the kinds the type of model has, or a property of a standard vocabulary. */
export type Meaning = RelChoice | 'standard';

export interface Reconnection {
  rel: Relation;
  end: End;
  /** The term the end is on. */
  moving: string;
  /** The term at the other end, which stays. */
  staying: string;
  meaning: Meaning;
  /** The standard property it stands for, when it stands for one. */
  predicate?: string;
  /** What the relationship is, in words: “is a”, the object property “directs”. */
  what: string;
  /** Why neither of its ends can be moved, when that is so: what it says is another ontology's to say, or is kept as a mapping. */
  fixed?: string;
  /** Why the end cannot be put on this term; nothing when it can. */
  refusal: (termId: string) => string | undefined;
}

const q = (t: Term | undefined) => `“${t?.name || 'Unnamed'}”`;
const article = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

/** What a relationship is, as the model is read: with the standard properties in force where they are. */
export function meaningOf(model: Model, rel: Relation): { meaning: Meaning; predicate?: string } {
  const predicate = resolveModel(model).relations.find((r) => r.id === rel.id)?.predicate;
  return predicate ? { meaning: 'standard', predicate } : { meaning: relChoice(model, rel) };
}

/** The statement between two terms of the same kind a standard property makes, where the app keeps rules for it. */
const linkOf = (predicate: string | undefined, type: TermType | undefined): LinkKind | undefined => (Object.keys(LINKS) as LinkKind[]).find((k) => LINKS[k].predicate === predicate && LINKS[k].type === type);

/**
 * What a relationship states, apart from which two terms it is about: two relationships that
 * agree in this and in their ends say one thing twice. A plain relationship asserts nothing, so
 * there may be any number of them.
 */
function statement(model: Model, r: Relation): string | undefined {
  if (isInstanceOf(model, r)) return 'type';
  if (r.kind === 'generalization' && (!r.predicate || stdProp(r.predicate)?.hierarchical)) return 'is a';
  if (r.predicate) return 'std ' + r.predicate.toLowerCase();
  if (r.kind === 'property') return 'has ' + JSON.stringify(restrictionSpecs(r));
  return relChoice(model, r) === 'object' ? `uses ${propOf(model, r)?.id} ${JSON.stringify(restrictionSpecs(r))}` : undefined;
}

/**
 * Why a relationship is not this model's to reconnect: both its ends belong to other ontologies,
 * so what it says is said there, or it is a mapping, which is kept with its status and notes
 * under Align. Where it meets its terms on the canvas can still be changed: that says nothing.
 */
export function fixedBecause(model: Model, relId: string): string | undefined {
  const rel = model.relations.find((r) => r.id === relId);
  if (!rel) return 'That relationship no longer exists.';
  const a = model.terms.find((t) => t.id === rel.from);
  const b = model.terms.find((t) => t.id === rel.to);
  if (a?.external === undefined && b?.external === undefined) return undefined;
  if (a?.external !== undefined && b?.external !== undefined) return `${q(a)} and ${q(b)} both belong to other ontologies: what is said between them is said there, so its ends stay where they are.`;
  const mapping = listMappings(model).find((m) => m.rels.includes(relId));
  return mapping ? `This is a mapping to another ontology (${mapping.source.name} ${mapping.predicate} ${mapping.target.name}). Mappings are kept under Align, with their status and notes: change it there.` : undefined;
}

/**
 * What moving one end of a relationship would take: what the relationship is, and for any term
 * whether the end can be put on it. Worked out once for the whole model, so that every term can
 * be asked while the end is dragged: asking costs nothing that grows with the model.
 */
export function reconnection(model: Model, relId: string, end: End): Reconnection | undefined {
  const rel = model.relations.find((r) => r.id === relId);
  if (!rel) return undefined;
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const moving = rel[end];
  const staying = end === 'from' ? rel.to : rel.from;
  const other = byId.get(staying);
  const { meaning, predicate } = meaningOf(model, rel);
  const config = configOf(model);
  const noun = (type: TermType) => article(config.termType[type].label.toLowerCase());
  const read = resolveModel(model);
  const std = stdProp(predicate);
  const link = linkOf(predicate, other?.type);
  const hierarchy = meaning === 'generalization' || !!std?.hierarchical;

  const what =
    meaning === 'standard'
      ? `“${predicate}”`
      : meaning === 'instanceOf'
        ? '“is an instance of”'
        : meaning === 'generalization'
          ? '“is a”'
          : meaning === 'property'
            ? '“has data property”'
            : meaning === 'object'
              ? `The object property “${rel.label.trim()}”`
              : rel.label.trim()
                ? `“${rel.label.trim()}”`
                : 'This relationship';
  /** The statement the relationship would make between two terms, as a sentence without its full stop. */
  const sentence = (from: Term | undefined, to: Term | undefined) => {
    const verb =
      meaning === 'standard' ? (link ? `is ${LINKS[link].phrase}` : predicate!) : meaning === 'instanceOf' ? 'is an instance of' : meaning === 'generalization' ? 'is a kind of' : meaning === 'property' ? 'has the data property' : rel.label.trim() || 'is related to';
    return `${q(from)} ${verb} ${q(to)}`;
  };
  const ends = (id: string) => (end === 'from' ? { from: id, to: rel.to } : { from: rel.from, to: id });

  // Whether a kind of term can take the end is the same for every term of that kind.
  const fits = (t: Term): boolean => {
    if (meaning !== 'standard') return kindsBetween(model, ends(t.id)).includes(meaning);
    const meant = (end === 'from' ? std?.from : std?.to) ?? [];
    return !meant.length || meant.includes(t.type);
  };
  const byType = new Map<TermType, boolean>();
  for (const t of model.terms) if (!byType.has(t.type)) byType.set(t.type, fits(t));
  const wanted = config.termTypes.filter((type) => byType.get(type));
  const needs = wanted.map(noun).join(' or ');
  // A kind of relationship the type of model no longer has (a plain one, in an ontology) is given a kind before it is moved.
  const offered = meaning === 'standard' || config.relationKinds.some((k) => k.id === meaning);

  // The terms the end cannot go to because that is stated already, by another relationship that
  // shares the end which stays; and those something stated rules out.
  const stated = new Set<string>();
  const ruledOut = new Map<string, string>();
  const says = statement(model, read.relations.find((r) => r.id === relId) ?? rel);
  if (says !== undefined) {
    for (const r of read.relations) {
      if (r.id === relId || (r.from !== staying && r.to !== staying)) continue;
      if (statement(model, r) !== says) continue;
      if (end === 'from' ? r.to === staying : r.from === staying) stated.add(end === 'from' ? r.from : r.to);
      else if (std?.symmetric) stated.add(r.from === staying ? r.to : r.from);
    }
  }
  const opposite = link && LINKS[link].opposite;
  if (opposite) for (const x of linkedTerms(model, staying, opposite)) ruledOut.set(x.id, LINKS[opposite].phrase);

  const fixed = fixedBecause(model, relId);
  const refusal = (id: string): string | undefined => {
    if (fixed) return fixed;
    if (id === moving) return undefined;
    const t = byId.get(id);
    if (!t) return 'That term no longer exists.';
    if (!offered) return `${config.label === 'OWL ontology' ? 'An OWL ontology' : 'This type of model'} has no relationships of this kind. Choose what this one is first (right-click it, Kind); then its ends can be moved.`;
    if (!byType.get(t.type)) return needs ? `${what} needs ${needs} at this end: ${q(t)} is ${noun(t.type)}.` : `${what} has no other term in this model it could join at this end.`;
    if (id === staying && (hierarchy || meaning === 'instanceOf' || std?.symmetric)) return `${q(t)} cannot be ${hierarchy ? 'a kind of' : link ? LINKS[link].phrase : predicate} itself.`;
    const [from, to] = end === 'from' ? [t, other] : [other, t];
    if (stated.has(id)) return `It is already stated that ${sentence(from, to)}.`;
    const against = ruledOut.get(id);
    if (against) return `${q(from)} is stated to be ${against} ${q(to)}. Both cannot hold; remove that statement first.`;
    return undefined;
  };
  return { rel, end, moving, staying, meaning, ...(predicate ? { predicate } : {}), what, ...(fixed ? { fixed } : {}), refusal };
}

/**
 * The model with one end of a relationship moved to another term, or the reason it cannot be:
 * then nothing changes. The relationship stays the one it was, with its id, its name, its
 * restrictions, its cardinalities and its style; only the end is another term, and that end is
 * drawn where the layout puts it again, since where it was dragged to was a place on the term it
 * left. Nothing else is touched: no class or property is made, and no other statement rewritten.
 */
export function reconnect(model: Model, relId: string, end: End, termId: string): Edit {
  const plan = reconnection(model, relId, end);
  if (!plan) return { error: 'That relationship no longer exists.' };
  if (termId === plan.moving) return { model };
  const refused = plan.refusal(termId);
  if (refused) return { error: refused };

  const moved: Relation = { ...plan.rel, [end]: termId };
  const next: Model = { ...model, relations: model.relations.map((r) => (r.id === relId ? moved : r)), style: withAnchor(model.style, relId, end, undefined) };
  // The rules a new statement of its kind is held to are asked about the statement it now makes,
  // in the model as it is without it. They have the last word, and may have something to say.
  const without: Model = { ...model, relations: model.relations.filter((r) => r.id !== relId) };
  const type = (id: string) => model.terms.find((t) => t.id === id)?.type;
  const link = linkOf(plan.predicate, type(moved.from));
  let note: string | undefined;
  if (link) {
    const asked = addLink(without, moved.from, moved.to, link);
    if (asked.error !== undefined) return asked;
    note = asked.note;
  } else if (plan.meaning === 'instanceOf') {
    const asked = makeInstanceOf(next, relId);
    if (asked.error !== undefined) return asked;
  } else if (plan.meaning === 'generalization' || stdProp(plan.predicate)?.hierarchical) {
    const asked = addIsA(without, moved.from, moved.to);
    if (asked.error !== undefined) return asked;
    note = asked.note;
  }
  // Whatever the rules above allow, an end that would make the relationship something else stays.
  const now = meaningOf(next, moved);
  if (now.meaning !== plan.meaning || now.predicate !== plan.predicate) return { error: `Moving this end would make ${plan.what.replace(/^The /, 'the ')} another kind of relationship, so it stays where it is.` };
  return { model: next, ...(note ? { note } : {}) };
}
