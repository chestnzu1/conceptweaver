import type { Model, Term } from './types';

const SAME: (keyof Term)[] = ['id', 'name', 'description', 'type', 'color', 'synonyms', 'fields', 'iri', 'range', 'domain', 'axioms', 'functional', 'values', 'external', 'oneOf', 'allDifferent'];

let last: Model | undefined;

/**
 * The model, or an earlier copy of it that differs only in where terms sit on the canvas.
 * Dragging produces a new model on every frame; anything that depends on what the model means
 * rather than how it is laid out can use this to keep its cached results.
 */
export function stable(model: Model): Model {
  const prev = last;
  if (prev === model) return prev;
  if (
    prev &&
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
    prev.shapes === model.shapes &&
    prev.quality === model.quality &&
    prev.governance === model.governance &&
    prev.datatypes === model.datatypes &&
    prev.externals === model.externals &&
    prev.mappings === model.mappings &&
    prev.rejected === model.rejected &&
    prev.terms.length === model.terms.length &&
    model.terms.every((t, i) => t === prev.terms[i] || SAME.every((k) => t[k] === prev.terms[i][k]))
  ) {
    return prev;
  }
  last = model;
  return model;
}
