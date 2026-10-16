import type { Model, Term } from './types';

const SAME: (keyof Term)[] = ['id', 'name', 'description', 'type', 'color', 'synonyms', 'fields', 'iri', 'ranges', 'domains', 'classAxioms', 'functional', 'values', 'external', 'oneOf', 'allDifferent'];

/**
 * How many earlier models are remembered. Undo and redo come back to one of them (the edit
 * service puts back the very parts an edit replaced), and what was worked out for it holds again.
 */
const KEPT = 16;

let recent: Model[] = [];
/** The answer given for each model so far: models are never changed, so it stays the answer. */
const given = new WeakMap<Model, Model>();

/** Whether two models say the same, apart from where terms sit on the canvas. */
function sameMeaning(prev: Model, model: Model): boolean {
  return (
    prev.relations === model.relations &&
    prev.props === model.props &&
    prev.vocab === model.vocab &&
    prev.mode === model.mode &&
    prev.lang === model.lang &&
    prev.name === model.name &&
    prev.description === model.description &&
    prev.baseIri === model.baseIri &&
    prev.ontologyIri === model.ontologyIri &&
    prev.prefixes === model.prefixes &&
    prev.shapeSets === model.shapeSets &&
    prev.dataGraphs === model.dataGraphs &&
    prev.quality === model.quality &&
    prev.governance === model.governance &&
    prev.datatypes === model.datatypes &&
    prev.externals === model.externals &&
    prev.mappings === model.mappings &&
    prev.rejected === model.rejected &&
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
