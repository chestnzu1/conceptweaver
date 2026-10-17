import { describe, expect, it } from 'vitest';
import { annotationUses, childAnnotationProps, descendsFrom, fieldAnnProp } from './annotationProps';
import { emptyModel, newAnnotationProp, newProp, newTerm, type Model } from './types';

const BASE = 'http://example.org/ann#';

/** Annotation properties over one another, one of them from another vocabulary, and fields that use them. */
function notes(): Model {
  const m = emptyModel('Annotations');
  m.baseIri = BASE;
  m.prefixes = [{ prefix: 'ann', iri: BASE }];
  m.annProps = [
    // Declared elsewhere, under a name a property of this model has too.
    newAnnotationProp({ id: 'outer', name: 'owner', iri: 'http://purl.org/dc/terms/owner', external: 'dc' }),
    newAnnotationProp({ id: 'inner', name: 'owner', iri: BASE + 'owner' }),
    newAnnotationProp({ id: 'note', name: 'Note', iri: BASE + 'note', description: 'A note on an entity.' }),
    newAnnotationProp({ id: 'review', name: 'review note', iri: BASE + 'reviewNote', parents: ['note'] }),
    newAnnotationProp({ id: 'deep', name: 'deep note', iri: BASE + 'deepNote', parents: ['review'] }),
    newAnnotationProp({ id: 'sibling', name: 'sibling note', iri: BASE + 'siblingNote', parents: ['note'] }),
  ];
  m.terms = [
    newTerm({
      id: 'invoice',
      name: 'Invoice',
      fields: [
        { key: 'Note', value: 'by its name' },
        { key: '<' + BASE + 'note>', value: 'by the IRI in angle brackets' },
        { key: BASE + 'note', value: 'by the IRI in full' },
        { key: 'rdfs:label', value: 'A standard annotation, not an entity' },
        { key: 'owner', value: 'by a name two properties have' },
      ],
    }),
  ];
  m.props = [newProp({ id: 'hasNote', name: 'has note', fields: [{ key: 'review note', value: 'on an object property' }] })];
  m.annProps[2].fields = [{ key: 'ann:reviewNote', value: 'on an annotation property' }];
  return m;
}

const byId = (m: Model, id: string) => m.annProps.find((p) => p.id === id)!;
const values = (m: Model, id: string) => annotationUses(m, byId(m, id)).map((u) => u.field.value);

describe('the annotation property a field is an annotation with', () => {
  it('is found by its name, its IRI in full or with a prefix, in whatever case it is written', () => {
    const m = notes();
    const note = byId(m, 'note');
    expect(fieldAnnProp(m, 'Note')).toBe(note);
    expect(fieldAnnProp(m, ' note ')).toBe(note);
    // By its name, though the name has a capital the field has not.
    expect(fieldAnnProp(m, 'note')).toBe(note);
    expect(fieldAnnProp(m, URL_SAFE)).toBeUndefined();
    expect(fieldAnnProp(m, BASE + 'note')).toBe(note);
    expect(fieldAnnProp(m, '<' + BASE + 'note>')).toBe(note);
    expect(fieldAnnProp(m, 'ann:note')).toBe(note);
    expect(fieldAnnProp(m, 'dcterms:owner')).toBe(byId(m, 'outer'));
    expect(fieldAnnProp(m, 'NOTE')).toBe(note);
    expect(fieldAnnProp(m, '')).toBeUndefined();
    // A standard annotation is not declared as an entity: it is no annotation property of the model.
    expect(fieldAnnProp(m, 'rdfs:label')).toBeUndefined();
    expect(fieldAnnProp(m, 'skos:prefLabel')).toBeUndefined();
    // A field of an entity with no such property is no annotation with one.
    expect(fieldAnnProp(m, 'retention')).toBeUndefined();
  });

  it('is the property of this model when another vocabulary has one of the same name', () => {
    const m = notes();
    expect(fieldAnnProp(m, 'owner')).toBe(byId(m, 'inner'));
    expect(fieldAnnProp(m, 'OWNER')).toBe(byId(m, 'inner'));
    // Its IRI still finds the external one.
    expect(fieldAnnProp(m, 'http://purl.org/dc/terms/owner')).toBe(byId(m, 'outer'));
  });
});

describe('where an annotation property is used', () => {
  it('is every field of every entity that names it, whether it is a term, a property or another annotation property', () => {
    const m = notes();
    expect(values(m, 'note')).toEqual(['by its name', 'by the IRI in angle brackets', 'by the IRI in full']);
    expect(values(m, 'review')).toEqual(['on an object property', 'on an annotation property']);
    expect(values(m, 'inner')).toEqual(['by a name two properties have']);
    // The external property of the same name annotates nothing.
    expect(values(m, 'outer')).toEqual([]);
    // The entity is there to be opened, not only its text.
    const [first] = annotationUses(m, byId(m, 'note'));
    expect(first.entity).toBe(m.terms[0]);
    expect(first.field).toBe(m.terms[0].fields![0]);
  });
});

describe('the annotation properties under another', () => {
  it('are the ones naming it, directly, and all it stands above, however far', () => {
    const m = notes();
    expect(childAnnotationProps(m, byId(m, 'note')).map((p) => p.name)).toEqual(['review note', 'sibling note']);
    expect(childAnnotationProps(m, byId(m, 'review')).map((p) => p.name)).toEqual(['deep note']);
    expect(childAnnotationProps(m, byId(m, 'deep'))).toEqual([]);
    expect(descendsFrom(m, byId(m, 'note'), byId(m, 'note'))).toBe(true);
    expect(descendsFrom(m, byId(m, 'review'), byId(m, 'note'))).toBe(true);
    expect(descendsFrom(m, byId(m, 'deep'), byId(m, 'note'))).toBe(true);
    expect(descendsFrom(m, byId(m, 'deep'), byId(m, 'review'))).toBe(true);
    expect(descendsFrom(m, byId(m, 'note'), byId(m, 'deep'))).toBe(false);
    expect(descendsFrom(m, byId(m, 'sibling'), byId(m, 'review'))).toBe(false);
    expect(descendsFrom(m, byId(m, 'review'), byId(m, 'sibling'))).toBe(false);
  });

  it('stops at a cycle already in the model rather than following it forever', () => {
    const m = notes();
    m.annProps.push(newAnnotationProp({ id: 'a', name: 'a', parents: ['b'] }), newAnnotationProp({ id: 'b', name: 'b', parents: ['a'] }));
    m.annProps.push(newAnnotationProp({ id: 'other', name: 'other' }));
    expect(descendsFrom(m, byId(m, 'a'), byId(m, 'other'))).toBe(false);
    expect(descendsFrom(m, byId(m, 'a'), byId(m, 'b'))).toBe(true);
  });
});

const URL_SAFE = 'example.org/ann#note';
