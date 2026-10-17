import type { AnnotationProp, ExtraField, Model, ObjProp, Term } from './types';
import { compactIri } from './prefixes';

/** Names and IRIs of a model's annotation properties, by what a field key may be written as. */
interface AnnIndex {
  byName: Map<string, AnnotationProp[]>;
  byIri: Map<string, AnnotationProp>;
}
const indexes = new WeakMap<Model, AnnIndex>();
function indexOf(m: Model): AnnIndex {
  const hit = indexes.get(m);
  if (hit) return hit;
  const byName = new Map<string, AnnotationProp[]>();
  const byIri = new Map<string, AnnotationProp>();
  for (const p of m.annProps) {
    byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
    if (!p.iri) continue;
    byIri.set(p.iri, p);
    const curie = compactIri(m, p.iri);
    if (curie) byIri.set(curie, p);
  }
  const made = { byName, byIri };
  indexes.set(m, made);
  return made;
}

/**
 * The annotation property a metadata field is an annotation with, if any: by its name, or by its
 * IRI (written in full or with a prefix). Standard annotations (rdfs:label and the like) are not
 * declared entities and are left to standardAnnotation.
 */
export function fieldAnnProp(m: Model, key: string): AnnotationProp | undefined {
  const k = key.trim();
  if (!k) return undefined;
  const index = indexOf(m);
  const named = index.byName.get(k);
  const pick = (list: AnnotationProp[]) => list.find((p) => !p.external) ?? list[0];
  if (named?.length) return pick(named);
  const iri = k.startsWith('<') && k.endsWith('>') ? k.slice(1, -1) : k;
  const byIri = index.byIri.get(iri);
  if (byIri) return byIri;
  // A key typed in another case still names the property, unless two differ only in case.
  const folded = m.annProps.filter((p) => p.name.toLowerCase() === k.toLowerCase());
  return folded.length ? pick(folded) : undefined;
}

/** Every annotation with the property, across the entities of the model. */
export function annotationUses(m: Model, p: AnnotationProp): { entity: Term | ObjProp | AnnotationProp; field: ExtraField }[] {
  const out: { entity: Term | ObjProp | AnnotationProp; field: ExtraField }[] = [];
  const entities: (Term | ObjProp | AnnotationProp)[] = [...m.terms, ...m.props, ...m.annProps];
  for (const e of entities) {
    for (const f of e.fields ?? []) if (fieldAnnProp(m, f.key)?.id === p.id) out.push({ entity: e, field: f });
  }
  return out;
}

/** The annotation properties stated as p's own superproperties (its children are those naming it). */
export const childAnnotationProps = (m: Model, p: AnnotationProp): AnnotationProp[] =>
  m.annProps.filter((x) => x.parents?.includes(p.id));

/**
 * Whether p is q or specialises it, directly or through others. A property cannot be made a
 * child of one of its own children: that would be a cycle.
 */
export function descendsFrom(m: Model, p: AnnotationProp, ancestor: AnnotationProp): boolean {
  const seen = new Set<string>();
  const walk = (ids: string[] | undefined): boolean => {
    for (const id of ids ?? []) {
      if (id === ancestor.id) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      if (walk(m.annProps.find((x) => x.id === id)?.parents)) return true;
    }
    return false;
  };
  return p.id === ancestor.id || walk(p.parents);
}
