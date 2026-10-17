import type { ShapeSet } from '../shacl';
import { hierarchyOf } from '../../layout/graph';
import { makeInstanceOf, statedMember, type Edit } from '../axioms';
import type { BulkRelation, BulkTerm, Outline } from '../bulk';
import type { Plan } from '../../mapping/contracts';
import { applyPlan } from '../../mapping/plan';
import { convertModel } from '../convert';
import { propDatatype, withDatatype } from '../domains';
import { bounds, type Anchor } from '../geometry';
import { checkValues, metaEntity, registry, withProfile, writeValues, type MetaOwner, type MetaValue } from '../governance';
import { PALETTE, patchNodes, resetOwn, withAnchor, withoutAnchors, type GraphStyle } from '../graphStyle';
import { DEFAULT_PROP, linkProps, nameKey, propNamed } from '../identity';
import { annotationUses, descendsFrom, fieldAnnProp } from '../annotationProps';
import { baseIriOf, moveNamespace } from '../iri';
import { allowsKind, configOf, supports, termTypeFor, viewFor } from '../modelTypes';
import type { SettingsDraft } from '../prefixes';
import { declaredProp, isInstanceOf, relChoices, type RelChoice } from '../props';
import { reconnect, type End } from '../reconnect';
import { cannotRelate, settleRelation, typed } from '../relating';
import { INSTANCE_OF, newAnnotationProp, newProp, newRelation, newTerm, PROP_LINKS, type AnnotationProp, type AxiomAnnotation, type DataGraphRef, type EntityKind, type ExtraField, type Model, type ModelMode, type ObjProp, type Relation, type Term, type TermType } from '../types';
import { labelKey, suggestFor } from '../vocab';
import { prune } from './document';
import type { Slice } from './types';

/** The edits of the document: each a change to the model, made through `apply` (document.ts), so that it can be undone. */

/** The last change to the graph style: a drag on a slider or in a colour picker is one step to undo, not fifty. */
let lastStyleEdit = { key: '', at: 0 };

/** What `updateRelation` changes of a relationship: anything but its id and its ends. */
export type RelationPatch = Partial<Omit<Relation, 'id' | 'from' | 'to'>>;

/**
 * A relationship with a change made to it. A new label that is not the name of the property the
 * relationship used leaves that property: the label decides again (see settleRelation).
 */
function retitled(m: Model, r: Relation, patch: RelationPatch): Relation {
  const next = { ...r, ...patch };
  if (!('label' in patch) || 'prop' in patch || next.prop === undefined) return next;
  const used = m.props.find((p) => p.id === next.prop);
  if (used && nameKey(used.name) === nameKey(next.label)) return next;
  const { prop: _left, ...rest } = next;
  return rest;
}

export interface EditsSlice {
  /**
   * Changes how the graph is drawn. Nothing about the ontology changes. Changes that share a
   * `gesture` and follow each other closely are undone together.
   */
  setStyle: (fn: (s: GraphStyle) => GraphStyle, gesture?: string) => void;
  /**
   * Gives single terms a fill of their own, or takes it away. One of the canvas colours is kept
   * as the term's colour, exactly as the canvas menu sets it; any other is kept in the style.
   */
  setOwnFill: (ids: string[], fill: string | undefined) => void;
  /** Takes away the look single terms and relationships were given: their own style, and a term's canvas colour. */
  resetOwnStyle: (terms: string[] | 'all', rels: string[] | 'all') => void;
  /** Changes the SHACL shape sets: an edit like any other, one step of the history, saved with the model. */
  setShapeSets: (fn: (sets: ShapeSet[]) => ShapeSet[]) => void;
  /** Changes the data graphs the model names (not their content, which is kept apart: dataGraphs.ts): one step of the history. */
  setDataGraphs: (fn: (graphs: DataGraphRef[]) => DataGraphRef[]) => void;
  /** Changes the annotations on axioms, each kept with the statement it annotates: one step of the history. */
  setAxiomAnnotations: (fn: (list: AxiomAnnotation[] | undefined) => AxiomAnnotation[] | undefined) => void;

  addTerm: (p?: Partial<Term>) => string;
  updateTerm: (id: string, patch: Partial<Term>, history?: boolean) => void;
  updateTerms: (ids: string[], patch: Partial<Term>) => void;
  moveTerms: (ids: string[], dx: number, dy: number) => void;
  /**
   * Adds a relationship and gives its id. In an ontology what it is follows from what it joins
   * and what it is called (see relating.ts); two terms that cannot be related are not, the reason
   * is shown, and the id is empty.
   */
  addRelation: (p: Partial<Relation> & { from: string; to: string }, history?: boolean) => string;
  /**
   * Changes a relationship: its name, restrictions, cardinalities, description, standard property.
   * In an ontology a new name can make it something else (see relating.ts). Not its ends: those
   * are moved with `reconnectRelation`, whichever control moves them.
   */
  updateRelation: (id: string, patch: RelationPatch, history?: boolean) => void;
  reverseRelation: (id: string) => void;
  /**
   * Moves one end of a relationship to another term, as one step that undo takes back: from the
   * canvas, the side panel and the table alike. What the relationship is stays what it was (see
   * reconnect.ts), and changing that is a command of its own (`setRelChoice`). Where the two
   * cannot be related in that way nothing changes, the reason is shown, and the answer is false.
   */
  reconnectRelation: (id: string, end: End, termId: string) => boolean;
  /**
   * Puts one end of a relationship at a place on the outline of its term, or lets it be placed
   * automatically again. It is part of how the graph is drawn: the ontology says nothing else for it.
   */
  setAnchor: (id: string, end: End, anchor: Anchor | undefined, gesture?: string) => void;
  /** Lets both ends of these relationships, or of every relationship, be placed automatically again. */
  resetAnchors: (ids: string[] | 'all') => void;
  remove: (terms: string[], rels: string[]) => void;
  deleteSelection: () => void;
  /** Adds new terms and fills in metadata on ones that already exist (matched by name). */
  bulkAddTerms: (items: BulkTerm[]) => { added: number; updated: number };
  /** Adds relationships between terms named in the input; unknown names are created or the line is skipped. */
  bulkAddRelations: (items: BulkRelation[], createMissing: boolean) => { added: number; created: number; skipped: number };
  /** Adds an indented hierarchy: its terms (reusing existing ones by name) and the links between them. */
  bulkAddOutline: (outline: Outline) => { terms: number; rels: number };
  /** Makes what an import of a table plans (src/mapping/plan.ts), as one edit that one undo takes back. */
  importPlan: (plan: Plan) => { added: number };
  /** Turns the model into the other type, translating what its relations mean. */
  convertTo: (mode: ModelMode) => void;
  /** Declares a new object property and opens it. */
  addProp: () => string;
  /** Makes a relationship label an object property: every relationship carrying it becomes a use. */
  declareProp: (name: string) => void;
  /**
   * Changes what one relationship is: a use of an object property, a plain relationship, "is a",
   * "is instance of" or "has property". Says whether it did: a kind the two terms cannot have is
   * refused, with a notice saying why.
   */
  setRelChoice: (id: string, choice: RelChoice, history?: boolean) => boolean;
  /** Changes what is declared about an object property, by id. */
  updateProp: (id: string, patch: Partial<Omit<ObjProp, 'id'>>) => void;
  /** Renames an object property (by id), and with it the label of the relationships that use it: no others, whatever their label. */
  renameProp: (id: string, name: string) => boolean;
  /** Removes an object property (by id) together with the relationships that use it. */
  deleteProp: (id: string) => void;
  /** Declares a new annotation property and opens it. */
  addAnnotationProp: () => string;
  /** Changes what is declared about an annotation property, by id. */
  updateAnnotationProp: (id: string, patch: Partial<Omit<AnnotationProp, 'id'>>) => void;
  /** Renames an annotation property (by id), and the annotations made with it by name. */
  renameAnnotationProp: (id: string, name: string) => boolean;
  /** Removes an annotation property (by id) together with the annotations that use it. */
  deleteAnnotationProp: (id: string) => void;
  /**
   * Saves the ontology IRI, default namespace and prefixes. Existing IRIs are left exactly as they
   * are, except that the entities of each namespace in `moveFrom` are moved into the default namespace.
   */
  setOntologySettings: (d: SettingsDraft, moveFrom?: string[]) => void;
  /** Sets what an entity has for one metadata field. Returns the reason if the values were refused. */
  setMeta: (owner: MetaOwner, fieldId: string, values: MetaValue[]) => string | undefined;
  /** Gives a term a metadata profile (business or technical data asset), or takes it away again. */
  setProfile: (termId: string, kind: EntityKind) => void;
  /**
   * Makes one of the edits of the entity editor (see axioms.ts). A refused edit changes nothing
   * and its reason is returned, for the editor to show where the edit was tried; anything worth
   * knowing about an accepted one is shown as a notice.
   */
  edit: (fn: (m: Model) => Edit) => string | undefined;
  setVocabEnabled: (on: boolean) => void;
  /** Maps every relation with this label to a standard property; an empty property removes the mapping. */
  mapLabel: (label: string, predicate: string) => void;

}

export const editsSlice: Slice<EditsSlice> = (set, get) => ({
  setStyle: (fn, gesture = '') => {
    const now = Date.now();
    const same = !!gesture && gesture === lastStyleEdit.key && now - lastStyleEdit.at < 1200;
    lastStyleEdit = { key: gesture, at: now };
    get().apply((m) => {
      const style = fn(m.style);
      return style === m.style ? m : { ...m, style };
    }, !same);
  },
  setOwnFill: (ids, fill) => {
    const swatch = (PALETTE as readonly string[]).includes(fill ?? '') ? fill! : '';
    const set_ = new Set(ids);
    get().apply((m) => ({ ...m, terms: m.terms.map((t) => (set_.has(t.id) && t.color !== swatch ? { ...t, color: swatch } : t)), style: patchNodes(m.style, ids, { fill: swatch ? undefined : fill }) }));
  },
  resetOwnStyle: (terms, rels) =>
    get().apply((m) => {
      const termIds = terms === 'all' ? m.terms.map((t) => t.id) : terms;
      const relIds = rels === 'all' ? m.relations.map((r) => r.id) : rels;
      const set_ = new Set(termIds);
      return { ...m, terms: m.terms.map((t) => (set_.has(t.id) && t.color ? { ...t, color: '' } : t)), style: resetOwn(m.style, termIds, relIds) };
    }),
  setShapeSets: (fn) => get().apply((m) => ({ ...m, shapeSets: fn(m.shapeSets) })),
  setDataGraphs: (fn) => get().apply((m) => ({ ...m, dataGraphs: fn(m.dataGraphs) })),
  setAxiomAnnotations: (fn) =>
    get().apply((m) => {
      const { axiomAnnotations: _was, ...rest } = m;
      const list = fn(m.axiomAnnotations);
      return list?.length ? { ...rest, axiomAnnotations: list } : rest;
    }),

  addTerm: (p = {}) => {
    // A term is of a kind the type of model has: in a vocabulary everything new is a concept.
    const t = newTerm({ ...p, type: termTypeFor(get().model, p.type) });
    // Created while looking at a subgraph: it has to be part of that subgraph to be seen.
    if (get().subgraph.active) set((s) => ({ subgraph: { ...s.subgraph, roots: [...s.subgraph.roots, t.id], pos: { ...s.subgraph.pos, [t.id]: { x: t.x, y: t.y } } } }));
    get().apply((m) => ({ ...m, terms: [...m.terms, t] }));
    return t.id;
  },
  updateTerm: (id, patch, history = true) => {
    // A kind of term the type of model does not have cannot be given to one.
    const { type, ...rest } = patch;
    const allowed = type === undefined || configOf(get().model).termTypes.includes(type) ? patch : rest;
    get().apply((m) => (m.terms.some((t) => t.id === id) ? { ...m, terms: m.terms.map((t) => (t.id === id ? { ...t, ...allowed } : t)) } : m), history);
  },
  updateTerms: (ids, given) => {
    const { type, ...rest } = given;
    const patch = type === undefined || configOf(get().model).termTypes.includes(type) ? given : rest;
    const set_ = new Set(ids);
    get().apply((m) => ({ ...m, terms: m.terms.map((t) => (set_.has(t.id) ? { ...t, ...patch } : t)) }));
  },
  moveTerms: (ids, dx, dy) => {
    if (get().subgraph.active) {
      set((s) => {
        const pos = { ...s.subgraph.pos };
        for (const id of ids) if (pos[id]) pos[id] = { x: pos[id].x + dx, y: pos[id].y + dy };
        return { subgraph: { ...s.subgraph, pos } };
      });
      return;
    }
    const set_ = new Set(ids);
    get().apply((m) => ({ ...m, terms: m.terms.map((t) => (set_.has(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t)) }), false);
  },
  addRelation: (p, history = true) => {
    const r = newRelation(p);
    const m = get().model;
    const settled = settleRelation({ ...m, relations: [...m.relations, r] }, r.id);
    if (settled.error !== undefined) {
      get().notify(settled.error);
      return '';
    }
    get().apply(() => settled.model!, history);
    if (settled.note) get().notify(settled.note);
    return r.id;
  },
  updateRelation: (id, given, history = true) => {
    const m = get().model;
    if (!m.relations.some((r) => r.id === id)) return;
    // What the type of model does not have is not set, whoever asks: no restrictions, no data properties.
    const patch = { ...given };
    if (!supports(m, 'restrictions')) for (const k of ['restriction', 'restrictionN', 'more'] as const) delete patch[k];
    if (patch.kind === 'property' && !allowsKind(m, 'property')) delete patch.kind;
    let next = { ...m, relations: m.relations.map((r) => (r.id === id ? retitled(m, r, patch) : r)) };
    // In an ontology a new name can make it something else: "is a" between two classes is a
    // superclass, another name an object property.
    let note: string | undefined;
    if (typed(m) && ('label' in patch || 'kind' in patch) && !patch.predicate) {
      const settled = settleRelation(next, id, m);
      if (settled.error !== undefined) return get().notify(settled.error);
      next = settled.model!;
      note = settled.note;
    }
    // A new kind or standard property must not state a class membership a second time.
    const now = next.relations.find((r) => r.id === id)!;
    const twice = ('kind' in patch || 'predicate' in patch) && isInstanceOf(next, now) ? statedMember(next, now.from, now.to, id) : undefined;
    if (twice) return get().notify(twice);
    get().apply(() => next, history);
    if (note) get().notify(note);
  },
  reverseRelation: (id) => {
    const rel = get().model.relations.find((r) => r.id === id);
    if (rel && isInstanceOf(get().model, rel)) return get().notify(`“${INSTANCE_OF}” always points from the individual to the class.`);
    if (rel && typed(get().model) && rel.kind === 'property' && !rel.predicate) return get().notify('“Has data property” always points from the class to the data property.');
    get().apply((m) => ({
      ...m,
      relations: m.relations.map((r) => (r.id === id ? { ...r, from: r.to, to: r.from, fromCard: r.toCard, toCard: r.fromCard } : r)),
    }));
  },
  reconnectRelation: (id, end, termId) => {
    const result = reconnect(get().model, id, end, termId);
    if (result.error !== undefined) {
      get().notify(result.error);
      return false;
    }
    get().apply(() => result.model);
    if (result.note) get().notify(result.note);
    return true;
  },
  setAnchor: (id, end, anchor, gesture = '') => {
    if (!get().model.relations.some((r) => r.id === id)) return;
    get().setStyle((s) => withAnchor(s, id, end, anchor), gesture);
  },
  resetAnchors: (ids) => get().setStyle((s) => withoutAnchors(s, ids === 'all' ? Object.keys(s.anchors) : ids)),
  remove: (terms, rels) => {
    if (!terms.length && !rels.length) return;
    const t = new Set(terms);
    const r = new Set(rels);
    get().apply((m) => ({
      ...m,
      // What the domains and ranges say of a term that is gone goes with it (see prepared).
      terms: m.terms
        .filter((x) => !t.has(x.id))
        // A value goes with the data property it is a value of.
        .map((x) => (x.values?.some((v) => t.has(v.prop)) ? { ...x, values: x.values.filter((v) => !t.has(v.prop)) } : x))
        // An individual that is gone is no longer listed by the enumerations it was a member of.
        .map((x) => (x.oneOf?.some((id) => t.has(id)) ? { ...x, oneOf: x.oneOf.filter((id) => !t.has(id)) } : x)),
      relations: m.relations.filter((x) => !r.has(x.id) && !t.has(x.from) && !t.has(x.to)),
    }));
    set((s) => ({ sel: prune(s.sel, s.model), highlight: [] }));
  },
  deleteSelection: () => get().remove(get().sel.terms, get().sel.rels),
  bulkAddTerms: (items) => {
    const { model, vp, canvasSize } = get();
    const byName = new Map(model.terms.map((t) => [t.name.trim().toLowerCase(), t]));
    const b = bounds(model.terms);
    const origin = b ? { x: b.x0 + 60, y: b.y1 + 90 } : { x: (canvasSize.w / 2 - vp.x) / vp.k - 380, y: (canvasSize.h / 2 - vp.y) / vp.k - 100 };
    const added: Term[] = [];
    const patches = new Map<string, Partial<Term>>();
    for (const p of items) {
      const existing = byName.get(p.name.toLowerCase());
      if (!existing) {
        added.push(
          newTerm({
            name: p.name,
            type: p.type ?? (p.range ? 'property' : 'concept'),
            ...(p.range ? { ranges: withDatatype({}, p.range) } : {}),
            description: p.description,
            synonyms: p.synonyms,
            color: p.color ?? '',
            fields: p.fields,
            x: origin.x + (added.length % 5) * 190,
            y: origin.y + Math.floor(added.length / 5) * 70,
          }),
        );
        continue;
      }
      // Metadata given for a term that already exists fills in or replaces what is there.
      const patch: Partial<Term> = {};
      if (p.type && p.type !== existing.type) patch.type = p.type;
      if (p.range && p.range !== propDatatype(existing)) patch.ranges = withDatatype(existing, p.range);
      if (p.description && p.description !== existing.description) patch.description = p.description;
      if (p.synonyms && p.synonyms !== existing.synonyms) patch.synonyms = p.synonyms;
      if (p.color !== undefined && p.color !== existing.color) patch.color = p.color;
      if (p.fields.length) {
        const keys = new Set(p.fields.map((f) => f.key.toLowerCase()));
        patch.fields = [...existing.fields.filter((f) => !keys.has(f.key.toLowerCase())), ...p.fields];
      }
      if (Object.keys(patch).length) patches.set(existing.id, patch);
    }
    if (!added.length && !patches.size) return { added: 0, updated: 0 };
    get().apply((m) => ({ ...m, terms: [...m.terms.map((t) => (patches.has(t.id) ? { ...t, ...patches.get(t.id) } : t)), ...added] }));
    set({ sel: { terms: [...added.map((t) => t.id), ...patches.keys()], rels: [] } });
    if (added.length) get().fit();
    return { added: added.length, updated: patches.size };
  },
  bulkAddRelations: (items, createMissing) => {
    const { model, vp, canvasSize } = get();
    const wasEmpty = !model.terms.length;
    const byName = new Map(model.terms.map((t) => [t.name.trim().toLowerCase(), t]));
    const b = bounds(model.terms);
    const origin = b ? { x: b.x0 + 60, y: b.y1 + 90 } : { x: (canvasSize.w / 2 - vp.x) / vp.k, y: (canvasSize.h / 2 - vp.y) / vp.k };
    const created: Term[] = [];
    const rels: Relation[] = [];
    const existing = new Set(model.relations.map((r) => `${r.from}|${r.to}|${r.kind}|${r.label.trim().toLowerCase()}`));
    let skipped = 0;
    const resolve = (name: string, type?: TermType) => {
      let t = byName.get(name.toLowerCase());
      if (!t && createMissing) {
        t = newTerm({ name, ...(type ? { type } : {}), x: origin.x + (created.length % 5) * 190, y: origin.y + Math.floor(created.length / 5) * 70 });
        byName.set(name.toLowerCase(), t);
        created.push(t);
      }
      return t;
    };
    for (const r of items) {
      // Look both ends up before creating either, so a skipped line leaves nothing behind.
      if (!createMissing && (!byName.has(r.from.toLowerCase()) || !byName.has(r.to.toLowerCase()))) {
        skipped++;
        continue;
      }
      const from = resolve(r.from)!;
      // What a class "has property" is a data property, so a new term at that end is made one.
      const to = resolve(r.to, r.kind === 'property' && typed(model) ? 'property' : undefined)!;
      const key = `${from.id}|${to.id}|${r.kind}|${r.label.trim().toLowerCase()}`;
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      existing.add(key);
      // In a concept scheme, labels such as "related" or "exact match" mean the SKOS property itself.
      const std = model.mode === 'skos' && r.kind === 'association' ? suggestFor(model, r.label) : undefined;
      if (std?.hierarchical) rels.push(newRelation({ from: from.id, to: to.id, kind: 'generalization' }));
      else if (std) rels.push(newRelation({ from: from.id, to: to.id, predicate: std.id }));
      else rels.push(newRelation({ from: from.id, to: to.id, label: r.label, kind: r.kind }));
    }
    if (!rels.length) return { added: 0, created: 0, skipped };
    // In an ontology each line becomes what its ends and its name make it: "is a", a use of an object
    // property (declared if it is new), "has data property". A line between two terms that cannot
    // be related is left out and counted as skipped.
    let work: Model = { ...model, terms: [...model.terms, ...created] };
    const kept: Relation[] = [];
    for (const r of rels) {
      const settled = settleRelation({ ...work, relations: [...work.relations, r] }, r.id);
      if (settled.error !== undefined) {
        skipped++;
        continue;
      }
      work = settled.model!;
      kept.push(r);
    }
    rels.length = 0;
    rels.push(...kept);
    if (!rels.length) return { added: 0, created: 0, skipped };
    // A term made for a line that was then left out is not kept either.
    const ends = new Set(work.relations.flatMap((r) => [r.from, r.to]));
    const orphans = new Set(created.filter((t) => !ends.has(t.id)).map((t) => t.id));
    if (orphans.size) {
      work = { ...work, terms: work.terms.filter((t) => !orphans.has(t.id)) };
      created.splice(0, created.length, ...created.filter((t) => !orphans.has(t.id)));
    }
    get().apply(() => work);
    if (wasEmpty) {
      const pos = hierarchyOf(get().model);
      get().apply((m) => ({ ...m, terms: m.terms.map((t) => ({ ...t, ...pos.get(t.id) })) }), false);
    }
    set({ sel: { terms: created.map((t) => t.id), rels: rels.map((r) => r.id) } });
    get().fit();
    return { added: rels.length, created: created.length, skipped };
  },
  importPlan: (plan) => {
    const { model, terms } = applyPlan(get().model, plan);
    if (!terms.length) return { added: 0 };
    get().apply(() => model);
    // What was made is selected, unless there is too much of it to show as a selection.
    set({ sel: { terms: terms.length <= 500 ? terms : [], rels: [] }, highlight: [] });
    get().fit();
    return { added: terms.length };
  },
  bulkAddOutline: (outline) => {
    const { model } = get();
    const byName = new Map(model.terms.map((t) => [t.name.trim().toLowerCase(), t]));
    const created: Term[] = [];
    for (const name of outline.terms) {
      if (byName.has(name.toLowerCase())) continue;
      const t = newTerm({ name });
      byName.set(name.toLowerCase(), t);
      created.push(t);
    }
    const existing = new Set(model.relations.filter((r) => r.kind === 'generalization').map((r) => `${r.from}|${r.to}`));
    const rels: Relation[] = [];
    for (const r of outline.rels) {
      const from = byName.get(r.from.toLowerCase())!;
      const to = byName.get(r.to.toLowerCase())!;
      if (existing.has(`${from.id}|${to.id}`)) continue;
      existing.add(`${from.id}|${to.id}`);
      rels.push(newRelation({ from: from.id, to: to.id, kind: 'generalization' }));
    }
    if (!created.length && !rels.length) return { terms: 0, rels: 0 };
    // Lay the new terms out as a tree of their own, below whatever is already on the canvas.
    const fresh = new Set(created.map((t) => t.id));
    const pos = hierarchyOf({ ...model, terms: created, relations: rels.filter((r) => fresh.has(r.from) && fresh.has(r.to)) });
    const b = bounds(model.terms);
    const xs = [...pos.values()].map((p) => p.x);
    const dx = b ? (b.x0 + b.x1) / 2 - (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
    const dy = b ? b.y1 + 130 : 0;
    for (const t of created) Object.assign(t, { x: pos.get(t.id)!.x + dx, y: pos.get(t.id)!.y + dy });
    get().apply((m) => ({ ...m, terms: [...m.terms, ...created], relations: [...m.relations, ...rels] }));
    set({ sel: { terms: created.map((t) => t.id), rels: [] } });
    get().fit();
    return { terms: created.length, rels: rels.length };
  },
  convertTo: (mode) => {
    const before = get().model;
    if (before.mode === mode) return;
    get().apply((m) => convertModel(m, mode));
    // The other type may not have the view this was done from.
    set({ view: viewFor(get().model, get().view), showInferred: get().showInferred && supports(get().model, 'reasoning') });
  },
  addProp: () => {
    if (!supports(get().model, 'objectProperties')) return '';
    const taken = new Set(get().model.props.map((p) => nameKey(p.name)));
    let name = 'new property';
    for (let i = 2; taken.has(nameKey(name)); i++) name = `new property ${i}`;
    const p = newProp({ name });
    get().apply((m) => ({ ...m, props: [...m.props, p] }));
    set({ selProp: p.id, sel: { terms: [], rels: [] } });
    return p.id;
  },
  declareProp: (name) => {
    const clean = name.trim() || DEFAULT_PROP;
    if (propNamed(get().model, clean)) return;
    const p = newProp({ name: clean });
    get().apply((m) => ({
      ...m,
      props: [...m.props, p],
      // Every relationship with the label becomes a use, one kept plain included. An unlabelled one
      // gets the name, which is what it stood for.
      relations: m.relations.map((r) => {
        if (r.kind !== 'association' || r.predicate || r.prop !== undefined || nameKey(r.label) !== nameKey(clean)) return r;
        const { plain: _plain, ...rest } = r;
        return { ...rest, label: r.label.trim() || clean, prop: p.id };
      }),
    }));
  },
  setRelChoice: (id, choice, history = true) => {
    if (!allowsKind(get().model, choice)) {
      const label = configOf(get().model).label;
      get().notify(`${/^[aeiou]/i.test(label) ? 'An' : 'A'} ${label} has no relationships of that kind.`);
      return false;
    }
    // In an ontology the two ends decide what a relationship can be.
    const wanted = get().model.relations.find((r) => r.id === id);
    const offer = wanted && typed(get().model) ? relChoices(get().model, wanted).find((c) => c.value === choice) : undefined;
    if (wanted && offer?.disabled) {
      get().notify(cannotRelate(get().model, wanted.from, wanted.to) ?? `${offer.label}: ${offer.disabled.toLowerCase()}.`);
      return false;
    }
    if (choice === 'instanceOf') {
      const result = makeInstanceOf(get().model, id);
      if (result.error !== undefined) {
        get().notify(result.error);
        return false;
      }
      get().apply(() => result.model, history);
      if (result.note) get().notify(result.note);
      return true;
    }
    get().apply((m) => {
      const rel = m.relations.find((r) => r.id === id);
      if (!rel) return m;
      const { plain: _plain, predicate: _predicate, prop: _prop, ...kept } = rel;
      // Only a plain relationship has cardinalities at its ends.
      const base = choice === 'plain' ? kept : { ...kept, fromCard: '', toCard: '' };
      if (choice === 'property') {
        // "Has data property" points from the class to the property, whichever way the line was drawn.
        const type = (x: string) => m.terms.find((t) => t.id === x)?.type;
        const ends = type(rel.from) === 'property' && type(rel.to) === 'concept' ? { from: rel.to, to: rel.from } : {};
        return { ...m, relations: m.relations.map((r) => (r.id === id ? { ...base, ...ends, kind: choice } : r)) };
      }
      if (choice === 'generalization') {
        // "Is a" restricts nothing, so a quantifier left over from before goes.
        const { restriction: _restriction, restrictionN: _n, more: _more, ...bare } = base;
        // Where the name decides the kind, a superclass has none: any other name would make it an object property again.
        return { ...m, relations: m.relations.map((r) => (r.id === id ? { ...bare, kind: choice, ...(typed(m) ? { label: '' } : {}) } : r)) };
      }
      const named = propNamed(m, rel.label);
      if (choice === 'plain') {
        // The flag is only needed where the label would otherwise make it a use of a property.
        return { ...m, relations: m.relations.map((r) => (r.id === id ? { ...base, kind: 'association', ...(named ? { plain: true } : {}) } : r)) };
      }
      // The property it used already, or the one its label names: declared on the spot if there is none.
      const declared = (rel.prop !== undefined ? m.props.find((p) => p.id === rel.prop) : undefined) ?? named;
      const used = declared ?? newProp({ name: rel.label.trim() || DEFAULT_PROP });
      const key = nameKey(used.name);
      return {
        ...m,
        props: declared ? m.props : [...m.props, used],
        // Other relationships that merely share the label stay plain.
        relations: m.relations.map((r) =>
          r.id === id
            ? { ...base, kind: 'association', label: rel.label.trim() || used.name, prop: used.id }
            : !declared && r.kind === 'association' && !r.predicate && r.prop === undefined && nameKey(r.label) === key
              ? { ...r, plain: true }
              : r,
        ),
      };
    }, history);
    return true;
  },
  updateProp: (id, patch) =>
    get().apply((m) => {
      const entry = declaredProp(m, id);
      if (!entry) return m;
      const next: ObjProp = { ...entry, ...patch, id };
      // An emptied optional field means "not set", so it isn't stored.
      // Domains and ranges are the exception: empty, they say there is none; left out, they follow the uses.
      for (const k of ['domains', 'ranges', 'fields', ...PROP_LINKS] as const) if (next[k] === undefined || (k !== 'domains' && k !== 'ranges' && !next[k]!.length)) delete next[k];
      return { ...m, props: m.props.map((p) => (p.id === id ? next : p)) };
    }),
  renameProp: (id, name) => {
    const clean = name.trim();
    const entry = declaredProp(get().model, id);
    if (!clean || !entry) return false;
    // Two properties of this model's own with one name would be easy to mix up; one may share its
    // name with a property of another ontology, from which it is told apart by its IRI.
    const twin = get().model.props.find((p) => p.id !== id && nameKey(p.name) === nameKey(clean) && p.external === undefined);
    if (twin && entry.external === undefined) {
      get().notify(`There is already a property called “${clean}”.`);
      return false;
    }
    // The property and its uses, and nothing else: references to it are by id, and so is every use.
    get().apply((m) => ({
      ...m,
      props: m.props.map((p) => (p.id === id ? { ...p, name: clean } : p)),
      relations: m.relations.map((r) => (r.prop === id ? { ...r, label: clean } : r)),
    }));
    return true;
  },
  deleteProp: (id) => {
    get().apply((m) => {
      const linked = linkProps(m);
      return {
        ...linked,
        props: linked.props
          .filter((p) => p.id !== id)
          .map((p) => {
            let out = p;
            for (const link of PROP_LINKS) {
              if (!p[link]?.includes(id)) continue;
              const { [link]: list, ...rest } = out;
              const left = list!.filter((k) => k !== id);
              out = left.length ? { ...rest, [link]: left } : rest;
            }
            return out;
          }),
        relations: linked.relations.filter((r) => r.prop !== id),
      };
    });
    set((s) => ({ selProp: s.selProp === id ? null : s.selProp, sel: prune(s.sel, s.model), highlight: [] }));
  },
  addAnnotationProp: () => {
    if (!supports(get().model, 'annotationProperties')) return '';
    const taken = new Set(get().model.annProps.map((p) => nameKey(p.name)));
    let name = 'new annotation property';
    for (let i = 2; taken.has(nameKey(name)); i++) name = `new annotation property ${i}`;
    const p = newAnnotationProp({ name });
    get().apply((m) => ({ ...m, annProps: [...m.annProps, p] }));
    set({ selProp: p.id, sel: { terms: [], rels: [] } });
    return p.id;
  },
  updateAnnotationProp: (id, patch) =>
    get().apply((m) => {
      const entry = m.annProps.find((p) => p.id === id);
      if (!entry) return m;
      const next: AnnotationProp = { ...entry, ...patch, id };
      // A property cannot be filed under itself, nor under one of its own children: that is a ring.
      if (patch.parents) next.parents = [...new Set(patch.parents)].filter((pid) => {
        const parent = m.annProps.find((x) => x.id === pid);
        return !!parent && parent.id !== id && !descendsFrom(m, parent, entry);
      });
      for (const k of ['domains', 'ranges', 'fields', 'parents'] as const) if (next[k] === undefined || !next[k]!.length) delete next[k];
      return { ...m, annProps: m.annProps.map((p) => (p.id === id ? next : p)) };
    }),
  renameAnnotationProp: (id, name) => {
    const clean = name.trim();
    const m = get().model;
    const entry = m.annProps.find((p) => p.id === id);
    if (!clean || !entry) return false;
    const twin = m.annProps.find((p) => p.id !== id && nameKey(p.name) === nameKey(clean) && p.external === undefined);
    if (twin && entry.external === undefined) {
      get().notify(`There is already an annotation property called “${clean}”.`);
      return false;
    }
    // Fields keyed by the old name keep naming the property; those keyed by its IRI need no change.
    const old = nameKey(entry.name);
    const rename = <T extends { fields?: ExtraField[] }>(x: T): T => {
      if (!x.fields?.some((f) => nameKey(f.key) === old && fieldAnnProp(m, f.key)?.id === id)) return x;
      return { ...x, fields: x.fields.map((f) => (nameKey(f.key) === old && fieldAnnProp(m, f.key)?.id === id ? { ...f, key: clean } : f)) };
    };
    get().apply((mm) => ({
      ...mm,
      annProps: mm.annProps.map((p) => (p.id === id ? { ...p, name: clean } : rename(p))),
      props: mm.props.map(rename),
      terms: mm.terms.map(rename),
    }));
    return true;
  },
  deleteAnnotationProp: (id) => {
    const m = get().model;
    const entry = m.annProps.find((p) => p.id === id);
    if (!entry) return;
    const uses = annotationUses(m, entry).length;
    const drop = <T extends { fields?: ExtraField[] }>(x: T): T =>
      !x.fields?.some((f) => fieldAnnProp(m, f.key)?.id === id) ? x : { ...x, fields: x.fields.filter((f) => fieldAnnProp(m, f.key)?.id !== id) };
    get().apply((mm) => ({
      ...mm,
      annProps: mm.annProps
        .filter((p) => p.id !== id)
        .map((p) => {
          const out = drop(p);
          if (!p.parents?.includes(id)) return out;
          const parents = p.parents.filter((x) => x !== id);
          const { parents: _was, ...rest } = out;
          return parents.length ? { ...rest, parents } : rest;
        }),
      props: mm.props.map(drop),
      terms: mm.terms.map(drop),
    }));
    set((s) => ({ selProp: s.selProp === id ? null : s.selProp }));
    get().notify(`Deleted the annotation property “${entry.name}”${uses ? ` and ${uses} annotation${uses === 1 ? '' : 's'} made with it` : ''}.`);
  },
  setOntologySettings: (d, moveFrom = []) =>
    get().apply((m) => {
      const next = { ...m, ontologyIri: d.ontologyIri, baseIri: d.baseIri, prefixes: d.prefixes };
      return moveFrom.reduce((acc, from) => moveNamespace(acc, from, baseIriOf(next)), next);
    }),
  setMeta: (owner, fieldId, values) => {
    const { model } = get();
    const f = registry(model).find((x) => x.id === fieldId);
    const e = metaEntity(model, owner);
    if (!f || !e) return 'That field or entity no longer exists.';
    if (e.external) return 'This entity belongs to another ontology; what is said about it is said there.';
    const refused = checkValues(f, values);
    if (refused) return refused;
    const first = values[0]?.value.trim() ?? '';
    if ('term' in owner) {
      const patch: Partial<Term> =
        f.bind === 'name' ? { name: first } : f.bind === 'description' ? { description: first } : f.bind === 'synonyms' ? { synonyms: values.map((v) => v.value.trim()).filter(Boolean).join(', ') } : f.bind === 'range' ? { ranges: withDatatype(model.terms.find((t) => t.id === owner.term) ?? {}, first || undefined) } : { fields: writeValues(e.fields, f, values) };
      get().updateTerm(owner.term, patch);
    } else if (f.bind === 'name') {
      if (!get().renameProp(owner.prop, first)) return 'That name could not be given to the property.';
    } else if (f.bind === 'description') get().updateProp(owner.prop, { description: first });
    else if (!f.bind) get().updateProp(owner.prop, { fields: writeValues(e.fields, f, values) });
    return undefined;
  },
  setProfile: (termId, kind) =>
    get().apply((m) => {
      const t = m.terms.find((x) => x.id === termId);
      return t ? { ...m, terms: m.terms.map((x) => (x === t ? { ...x, fields: withProfile(m, x, kind) } : x)) } : m;
    }),
  edit: (fn) => {
    const result = fn(get().model);
    if (result.error !== undefined) return result.error;
    get().apply(() => result.model);
    if (result.note) get().notify(result.note);
    return undefined;
  },
  setVocabEnabled: (enabled) => get().apply((m) => ({ ...m, vocab: { ...m.vocab, enabled } })),
  mapLabel: (label, predicate) =>
    get().apply((m) => {
      const { [labelKey(label)]: _old, ...rest } = m.vocab.map;
      return { ...m, vocab: { ...m.vocab, map: predicate ? { ...rest, [labelKey(label)]: predicate } : rest } };
    }),

});
