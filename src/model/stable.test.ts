import { describe, expect, it } from 'vitest';
import { revisionOf } from '../structure/local';
import { emptyLogicalModel } from '../logical/rules';
import { withIris } from './iri';
import { sampleModel } from './sample';
import { emptyModel, MODEL_PARTS, type Model } from './types';

/**
 * What the ontology's revision follows (TD-20): every field of a model is said to be the
 * ontology's, the picture's, a logical model's or the file's (MODEL_PARTS), and the revision moves
 * with the ontology's and nothing else.
 */
describe('the ontology’s revision', () => {
  const m = withIris(sampleModel());

  it('follows every field of a model that is said to be the ontology’s, and no other', () => {
    // The optional fields too: the compiler holds MODEL_PARTS to every field of Model.
    for (const k of [...Object.keys(emptyModel()), ...Object.keys(m)]) expect(MODEL_PARTS, k).toHaveProperty(k);
    expect(Object.keys(MODEL_PARTS).filter((k) => MODEL_PARTS[k as keyof Model] !== 'revision').sort()).toEqual(['diagram', 'diagrams', 'format', 'layout', 'logicalModels', 'style', 'version']);
  });

  it('moves with a statement the editor keeps as it was written', () => {
    const next: Model = { ...m, unmapped: `${m.unmapped}\n<http://example.org/a> <http://example.org/b> <http://example.org/c> .` };
    expect(revisionOf(next)).not.toBe(revisionOf(m));
  });

  it('stays where it is when a logical model, the picture or a term’s place changes', () => {
    const before = revisionOf(m);
    expect(revisionOf({ ...m, logicalModels: [emptyLogicalModel({ name: 'A' })] })).toBe(before);
    expect(revisionOf({ ...m, style: { ...m.style, nodes: { [m.terms[0].id]: { shape: 'hexagon' } } } })).toBe(before);
    expect(revisionOf({ ...m, layout: { ...m.layout } })).toBe(before);
    expect(revisionOf({ ...m, diagrams: [{ ...m.diagrams[0], name: 'Another', hidden: [m.terms[0].id] }] })).toBe(before);
    expect(revisionOf({ ...m, diagram: 'another' })).toBe(before);
    expect(revisionOf({ ...m, terms: m.terms.map((t, i) => (i ? t : { ...t, x: t.x + 40 })) })).toBe(before);
  });
});
