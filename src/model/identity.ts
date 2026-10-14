import { allowsKind } from './modelTypes';
import { PROP_LINKS, type Model, type ObjProp, type Relation } from './types';
import { labelKey, resolveModel } from './vocab';

/**
 * How relationships and object properties are joined: by id (model format 2). A relationship
 * that uses an object property names it in `Relation.prop`, and its label is that property's
 * name, as it was written (in another case, or left empty for "related to"). Renaming the
 * property renames the label of its uses, and of nothing else, however many other properties or
 * relationships share the old name.
 *
 * Where a relationship is given a label and no property (drawn on the canvas, added in bulk,
 * read from a file, or a model of format 1), the label decides once, as it always did: a label
 * that is the name of an object property makes the relationship a use of it.
 */

/** Name used for an unlabelled relationship. */
export const DEFAULT_PROP = 'related to';

/** How a name is matched against the name of a property: ignoring case and outer spaces; no name is "related to". */
export const nameKey = (name: string) => labelKey(name) || DEFAULT_PROP;

/**
 * The object property a label names. Should two properties have that name, the model's own comes
 * before one from another ontology, and then the first.
 */
export function propNamed(m: Pick<Model, 'props'>, label: string): ObjProp | undefined {
  const k = nameKey(label);
  let found: ObjProp | undefined;
  for (const p of m.props) if (nameKey(p.name) === k && (!found || (found.external !== undefined && p.external === undefined))) found = p;
  return found;
}

/**
 * The property a relationship is a use of, read from the relationship alone: the one it names,
 * or, where it names none and is not kept plain, the one its label names. Nothing for a
 * relationship that is not an association or stands for a standard property of its own.
 */
export function propOf(m: Pick<Model, 'props'>, r: Pick<Relation, 'kind' | 'predicate' | 'plain' | 'prop' | 'label'>): ObjProp | undefined {
  if (r.kind !== 'association' || r.predicate || r.plain) return undefined;
  return r.prop !== undefined ? m.props.find((p) => p.id === r.prop) : propNamed(m, r.label);
}

const cache = new WeakMap<Model, Model>();

/**
 * The model with every relationship joined to the property it uses, by id. Gives the model
 * itself back when nothing needed doing. What it does:
 *
 * - a relationship that names a property, and whose label is not that property's name in any
 *   case, is given the name (it was renamed);
 * - one that names a property that is gone, is kept plain, is no longer an association, or
 *   stands for a standard property (its own, or by the mapping of its label) names none;
 * - one that names none, and is none of those, becomes a use of the property its label names;
 * - a property's links (sub-property, inverse, equivalent, disjoint) to one that is gone go.
 */
export function linkProps(m: Model): Model {
  const hit = cache.get(m);
  if (hit) return hit;
  // A type of model without object properties has nothing to join.
  if (!allowsKind(m, 'object')) {
    cache.set(m, m);
    return m;
  }
  const byId = new Map(m.props.map((p) => [p.id, p]));
  // Each list is replaced only where something in it changed, so that what depends on the other stays as it is.
  let propsChanged = false;
  let relationsChanged = false;
  const props = m.props.map((p) => {
    let out = p;
    for (const link of PROP_LINKS) {
      if (!p[link]?.some((id) => !byId.has(id) || id === p.id)) continue;
      const { [link]: list, ...rest } = out;
      const left = list!.filter((id) => byId.has(id) && id !== p.id);
      out = left.length ? { ...rest, [link]: left } : rest;
    }
    if (out !== p) propsChanged = true;
    return out;
  });
  // What each relationship stands for once the vocabulary's label mapping is applied (same order).
  const meant = resolveModel(m).relations;
  const relations = m.relations.map((r, i): Relation => {
    const usable = meant[i].kind === 'association' && !meant[i].predicate && !r.plain;
    if (r.prop !== undefined) {
      const p = usable ? byId.get(r.prop) : undefined;
      if (p && nameKey(r.label) === nameKey(p.name)) return r;
      relationsChanged = true;
      if (p) return { ...r, label: p.name };
      const { prop: _gone, ...rest } = r;
      return rest;
    }
    const p = usable ? propNamed(m, r.label) : undefined;
    if (!p) return r;
    relationsChanged = true;
    return { ...r, prop: p.id };
  });
  const out = propsChanged || relationsChanged ? { ...m, ...(propsChanged ? { props } : {}), ...(relationsChanged ? { relations } : {}) } : m;
  cache.set(m, out);
  cache.set(out, out);
  return out;
}
