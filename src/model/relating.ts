import { makeInstanceOf, type Edit } from './axioms';
import { baseIriOf, localName } from './iri';
import { supports } from './modelTypes';
import { DEFAULT_PROP, nameKey, propNamed, propOf } from './identity';
import { kindsBetween } from './props';
import { INSTANCE_OF, newProp, newRelation, PROP_LINKS, type Model, type ObjProp, type Relation, type Term, type TermType } from './types';
import { resolveModel } from './vocab';

/**
 * What a relationship is, in a type of model where that follows from what it joins and what it
 * is called (an OWL ontology; see the feature "typedRelationships"). Nobody has to choose a kind:
 *
 *   two classes               "is a" makes the first a subclass of the second (rdfs:subClassOf);
 *                             any other name is the object property of that name, which the first
 *                             class is then restricted by. The property is declared if it is new.
 *   a class, a data property  the class has the data property, whichever way the line was drawn.
 *   an individual, a class    the individual is an instance of the class (rdf:type).
 *   two individuals           a fact that uses the object property of that name.
 *   two data properties       the first is a sub-property of the second.
 *   an individual, a data property   nothing. What an individual has for a data property is a
 *                             value, given in its editor; a line between the two says nothing in OWL.
 *
 * Everything that adds a relationship or changes its name or its ends goes through here, so that
 * what is refused in the editor is refused in the model as well.
 */

/** The words that make a line between two classes a statement that one is a kind of the other. */
export const IS_A = /^is[- ]an?$/i;

const q = (t: Term | undefined) => `“${t?.name || 'Unnamed'}”`;
const noun = (t: Term) => (t.type === 'concept' ? 'a class' : t.type === 'property' ? 'a data property' : 'an individual');

/** Whether the type of model works relationships out this way. */
export const typed = (model: Model): boolean => supports(model, 'typedRelationships');

/** Why two terms cannot be joined by a line at all, in words; nothing when they can. */
export function cannotRelate(model: Model, fromId: string, toId: string): string | undefined {
  if (!typed(model)) return undefined;
  const a = model.terms.find((t) => t.id === fromId);
  const b = model.terms.find((t) => t.id === toId);
  if (!a || !b || kindsBetween(model, { from: fromId, to: toId }).length) return undefined;
  const [individual, property] = a.type === 'instance' ? [a, b] : [b, a];
  if (individual.type === 'instance' && property.type === 'property') {
    return `${q(individual)} is an individual and ${q(property)} is a data property: the two are not joined by a line. An individual has a value for a data property. Open ${q(individual)} and add it under Data property assertions.`;
  }
  return `${q(a)} is ${noun(a)} and ${q(b)} is ${noun(b)}: there is nothing in OWL that a line between the two could say.`;
}

/** A property that exists in name only: nothing was said about it, and nothing refers to it. */
function pristine(model: Model, p: ObjProp): boolean {
  if (p.description.trim() || p.chars.length || p.domains || p.ranges || p.fields?.length || p.external !== undefined) return false;
  if (PROP_LINKS.some((l) => p[l]?.length)) return false;
  if (model.props.some((other) => other !== p && PROP_LINKS.some((l) => other[l]?.includes(p.id)))) return false;
  // An IRI of its own choosing would be something said about it; the one made from its name is not.
  return !p.iri || p.iri.toLowerCase().startsWith((baseIriOf(model) + localName(p.name, true)).toLowerCase());
}

const uses = (model: Model, id: string) => model.relations.some((r) => propOf(model, r)?.id === id);

/**
 * Gives a relationship the kind that follows from its ends and its name, once it has been added
 * or one of those has changed. `model` holds the relationship as it was left; `before` is the
 * model from before the change, when there was one.
 *
 * The answer is the model with the relationship settled: its kind set, its direction turned
 * where the kind has one, the object property declared if the name is new. Or the reason the
 * two cannot be related, in which case nothing is to change. A type of model that does not work
 * this way, and a relationship that stands for a standard property, are left as they are.
 */
export function settleRelation(model: Model, id: string, before?: Model): Edit {
  if (!typed(model)) return { model };
  const rel = model.relations.find((r) => r.id === id);
  const a = model.terms.find((t) => t.id === rel?.from);
  const b = model.terms.find((t) => t.id === rel?.to);
  if (!rel || !a || !b) return { model };
  // A relationship that stands for owl:disjointWith or the like means what that property means.
  if (resolveModel(model).relations.find((r) => r.id === id)?.predicate) return { model };
  const refused = cannotRelate(model, rel.from, rel.to);
  if (refused) return { error: refused };

  const allowed = kindsBetween(model, rel);
  const name = rel.label.trim();
  // Between two classes there are two things a line can say, and its name tells them apart. Without
  // a name it stays what it was: a superclass stays one, anything else is a use of a property.
  const choice = allowed.length === 1 ? allowed[0] : IS_A.test(name) || (!name && rel.kind === 'generalization') ? 'generalization' : 'object';
  // A name typed on a line whose meaning leaves no room for one is not kept, and that is said.
  const unnamed = (what: string) => (name && !IS_A.test(name) && !/^((is )?(an? )?instance of|has)$/i.test(name) ? { note: `${what}, so it has no name of its own: “${name}” was not kept.` } : {});
  const put = (m: Model, next: Relation): Model => ({ ...m, relations: m.relations.map((r) => (r.id === id ? next : r)) });
  const { plain: _plain, predicate: _predicate, prop: _prop, ...kept } = rel;
  const bare = (() => {
    const { restriction: _restriction, restrictionN: _n, more: _more, ...rest } = kept;
    return { ...rest, fromCard: '', toCard: '' };
  })();

  let out: Edit;
  if (choice === 'instanceOf') {
    const made = makeInstanceOf(model, id);
    out = made.error !== undefined ? made : { ...made, ...(made.note ? {} : unnamed(`A line between an individual and a class says “${INSTANCE_OF}”`)) };
  } else if (choice === 'property') {
    // "Has data property" points from the class to the property, whichever way the line was drawn.
    const [cls, prop] = a.type === 'concept' ? [a, b] : [b, a];
    out = { model: put(model, { ...kept, from: cls.id, to: prop.id, label: '', kind: 'property', fromCard: '', toCard: '' }), ...unnamed(`${q(cls)} has the data property ${q(prop)}`) };
  } else if (choice === 'generalization') {
    const what = a.type === 'property' ? `${q(a)} is a sub-property of ${q(b)}` : `${q(a)} is a kind of ${q(b)}`;
    out = { model: put(model, { ...bare, label: '', kind: 'generalization' }), ...unnamed(what) };
  } else {
    // A use of an object property: the one of that name, declared here if there is none yet. The
    // one it used already, while the name is still its name, before another of the same name.
    const current = rel.prop !== undefined ? model.props.find((p) => p.id === rel.prop) : undefined;
    const declared = current && nameKey(current.name) === nameKey(name) ? current : propNamed(model, name);
    const used = declared ?? newProp({ name: name || DEFAULT_PROP });
    const key = nameKey(used.name);
    out = {
      model: {
        ...model,
        props: declared ? model.props : [...model.props, used],
        relations: model.relations.map((r) =>
          r.id === id
            ? { ...kept, kind: 'association', label: used.name, prop: used.id, fromCard: '', toCard: '' }
            : // Relationships from before that merely share the name do not become uses of the property behind anyone's back.
              !declared && r.kind === 'association' && !r.predicate && !r.plain && r.prop === undefined && nameKey(r.label) === key
              ? { ...r, plain: true }
              : r,
        ),
      },
    };
  }
  if (out.error !== undefined || !out.model) return out;

  // The property the relationship used before, if it existed for this relationship alone and nothing
  // was ever said about it, goes with the name: a name typed and then corrected leaves nothing behind.
  const was = before?.relations.find((r) => r.id === id);
  const old = was && before ? propOf(before, was) : undefined;
  if (old) {
    const entry = out.model.props.find((p) => p.id === old.id);
    if (entry && !uses(out.model, entry.id) && pristine(out.model, entry)) out = { ...out, model: { ...out.model, props: out.model.props.filter((p) => p !== entry) } };
  }
  return out;
}

/** How many terms of one kind are tried as the other end before that kind is given up on. */
const GIVE_UP = 4;
/** How many terms are tried as the first end. */
const MAX_STARTS = 25;

/**
 * The two terms a relationship starts between when it is added without saying which, as from
 * the table of relationships, where it is given its ends afterwards. The first two terms by name
 * will not always do: in an ontology an individual and a data property are not joined at all,
 * and an individual is not stated to be an instance of the same class twice. So: the two terms
 * that are selected, where a relationship can be added between them; else from a selected term,
 * or the first by name, to the first by name it can be related to, one it is not related to yet
 * before one it is. The ends are given the way
 * the relationship will run, which for a membership or a "has data property" is not always the
 * way they were found. `error` is why nothing can be added, in the rare model where that is so.
 */
export function endsForNew(model: Model, selected: string[] = []): { from: string; to: string; error?: undefined } | { error: string } {
  const byName = [...model.terms].sort((a, b) => a.name.localeCompare(b.name));
  if (!byName.length) return { error: 'There are no terms to relate yet.' };
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const chosen = [...new Set(selected)].map((id) => byId.get(id)).filter((t): t is Term => !!t);
  let why: string | undefined;
  // Whether two kinds of term can be joined at all is the same for every pair of those kinds.
  const kinds = new Map<string, boolean>();
  const joinable = (a: Term, b: Term): boolean => {
    const key = a.type + '|' + b.type;
    let can = kinds.get(key);
    if (can === undefined) {
      const refused = cannotRelate(model, a.id, b.id);
      why ??= refused;
      kinds.set(key, (can = refused === undefined));
    }
    return can;
  };
  /** The ends a relationship between the two would have once added, or nothing where it is refused. */
  const between = (a: Term, b: Term): { from: string; to: string } | undefined => {
    const probe = newRelation({ from: a.id, to: b.id });
    const settled = settleRelation({ ...model, relations: [...model.relations, probe] }, probe.id);
    if (settled.error !== undefined) {
      why ??= settled.error;
      return undefined;
    }
    const made = settled.model?.relations.find((r) => r.id === probe.id) ?? probe;
    return { from: made.from, to: made.to };
  };

  if (chosen.length > 1 && joinable(chosen[0], chosen[1])) {
    const ends = between(chosen[0], chosen[1]);
    if (ends) return ends;
  }
  // Two terms that are related already are taken last: the same statement twice says nothing more,
  // and pressed again and again this gives one relationship after another, not the same one.
  const pair = (x: string, y: string) => (x < y ? x + '|' + y : y + '|' + x);
  const related = new Set(model.relations.map((r) => pair(r.from, r.to)));
  for (const a of [...new Set([...chosen, ...byName])].slice(0, MAX_STARTS)) {
    // What is refused is mostly refused for a whole kind of term (every class the individual is an
    // instance of already), so a kind that keeps being refused is passed over: a large model costs no more.
    const failed: Partial<Record<TermType, number>> = {};
    for (const fresh of [true, false]) {
      for (const b of byName) {
        if (b === a || (failed[b.type] ?? 0) >= GIVE_UP || related.has(pair(a.id, b.id)) === fresh) continue;
        if (!joinable(a, b)) {
          failed[b.type] = GIVE_UP;
          continue;
        }
        const ends = between(a, b);
        if (ends) return ends;
        failed[b.type] = (failed[b.type] ?? 0) + 1;
      }
    }
  }
  // A single term can only be related to itself.
  if (byName.length === 1) {
    const ends = between(byName[0], byName[0]);
    if (ends) return ends;
  }
  return { error: why ?? 'No two terms of this model can be related.' };
}
