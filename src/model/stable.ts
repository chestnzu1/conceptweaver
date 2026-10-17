import { MODEL_PARTS, type Model, type Term } from './types';

const SAME: (keyof Term)[] = ['id', 'name', 'description', 'type', 'color', 'synonyms', 'fields', 'iri', 'ranges', 'domains', 'classAxioms', 'functional', 'values', 'external', 'oneOf', 'allDifferent'];

/**
 * How many earlier models are remembered. Undo and redo come back to one of them (the edit
 * service puts back the very parts an edit replaced), and what was worked out for it holds again.
 */
const KEPT = 16;

let recent: Model[] = [];
/** The answer given for each model so far: models are never changed, so it stays the answer. */
const given = new WeakMap<Model, Model>();

/** The fields of a model the ontology's revision follows, apart from the terms, which are compared field by field. */
const FOLLOWED = (Object.keys(MODEL_PARTS) as (keyof Model)[]).filter((k) => MODEL_PARTS[k] === 'revision' && k !== 'terms');

/**
 * Whether two models say the same, apart from where terms sit on the canvas, how the graph is
 * drawn, and the logical data models, which have revisions of their own (MODEL_PARTS).
 */
function sameMeaning(prev: Model, model: Model): boolean {
  return (
    FOLLOWED.every((k) => prev[k] === model[k]) &&
    prev.terms.length === model.terms.length &&
    model.terms.every((t, i) => t === prev.terms[i] || SAME.every((k) => t[k] === prev.terms[i][k]))
  );
}

/**
 * The model, or an earlier copy of it that differs only in where terms sit on the canvas.
 * Dragging produces a new model on every frame; anything that depends on what the model means
 * rather than how it is laid out can use this to keep its cached results. Of the last few models
 * the most recent that means the same is the one given, so that an undo comes back to it.
 */
export function stable(model: Model): Model {
  const known = given.get(model);
  if (known && recent[0] === known) return known;
  const kept = known ?? recent.find((prev) => sameMeaning(prev, model)) ?? model;
  given.set(model, kept);
  recent = [kept, ...recent.filter((m) => m !== kept)].slice(0, KEPT);
  return kept;
}
