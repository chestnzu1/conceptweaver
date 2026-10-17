import { importIntoSet, newSetFor } from './shapes';
import { describe, expect, it } from 'vitest';
import { setIriSuffix, withIris } from './iri';
import { fromTurtle, toTurtle } from './rdf';
import { newAnnotationProp, newProp, emptyModel, newRelation, newTerm, normalizeModel, type Model } from './types';

function films() {
  const m = emptyModel('Films');
  m.baseIri = 'http://example.org/films#';
  const film = newTerm({ name: 'Film' });
  const award = newTerm({ name: 'Award' });
  m.terms.push(film, award);
  m.props.push(newProp({ name: 'wins', description: '', chars: [] }));
  m.relations.push(newRelation({ from: film.id, to: award.id, label: 'wins' }));
  return { m: withIris(m), film, award };
}

describe('IRI suffix', () => {
  it('is changed without touching the label, and the label without touching it', () => {
    const { m, film } = films();
    const edit = setIriSuffix(m, { term: film.id }, 'C0001');
    expect(edit.error).toBeUndefined();
    const t = edit.model!.terms.find((x) => x.id === film.id)!;
    expect(t).toMatchObject({ name: 'Film', iri: 'http://example.org/films#C0001' });
    const ttl = toTurtle(edit.model!);
    expect(ttl).toContain(':C0001 a owl:Class ;\n    rdfs:label "Film"');
    expect(ttl).toContain('owl:someValuesFrom :Award');
    expect(ttl).not.toContain(':Film ');
    // Renaming afterwards changes the label only.
    const renamed = withIris({ ...edit.model!, terms: edit.model!.terms.map((x) => (x.id === film.id ? { ...x, name: 'Motion picture' } : x)) });
    expect(toTurtle(renamed)).toContain(':C0001 a owl:Class ;\n    rdfs:label "Motion picture"');
    // And both survive export, import and being saved.
    const back = fromTurtle(toTurtle(renamed)).terms.find((x) => x.iri === t.iri)!;
    expect(back.name).toBe('Motion picture');
    expect(normalizeModel(JSON.parse(JSON.stringify(renamed))).terms.find((x) => x.id === film.id)).toMatchObject({ name: 'Motion picture', iri: t.iri });
  });

  it('works for an object property', () => {
    const { m } = films();
    const edit = setIriSuffix(m, { prop: m.props.find((p) => p.name === 'wins')!.id }, 'P12');
    expect(edit.model!.props[0]).toMatchObject({ name: 'wins', iri: 'http://example.org/films#P12' });
    expect(toTurtle(edit.model!)).toContain(':P12 a owl:ObjectProperty ;\n    rdfs:label "wins"');
  });

  it('refuses what cannot be an IRI, or is taken', () => {
    const { m, film, award } = films();
    expect(setIriSuffix(m, { term: film.id }, '  ').error).toContain('cannot be empty');
    expect(setIriSuffix(m, { term: film.id }, 'my film').error).toContain('A space');
    expect(setIriSuffix(m, { term: film.id }, 'a/b').error).toContain('namespace');
    expect(setIriSuffix(m, { term: film.id }, 'a<b').error).toContain('cannot be part of an IRI');
    expect(setIriSuffix(m, { term: film.id }, 'award').error).toContain('“Award” already has the IRI');
    expect(setIriSuffix(m, { term: film.id }, 'wins').error).toContain('“wins” already has the IRI');
    expect(setIriSuffix(m, { term: film.id }, 'Film').model).toBe(m);
    const external = { ...m, terms: m.terms.map((t) => (t.id === award.id ? { ...t, external: '' } : t)) };
    expect(setIriSuffix(external, { term: award.id }, 'Prize').error).toContain('another ontology');
  });

  it('keeps the namespace the entity is in', () => {
    const { m, film } = films();
    const elsewhere = { ...m, terms: m.terms.map((t) => (t.id === film.id ? { ...t, iri: 'http://other.org/v/Film' } : t)) };
    expect(setIriSuffix(elsewhere, { term: film.id }, 'Movie').model!.terms.find((t) => t.id === film.id)!.iri).toBe('http://other.org/v/Movie');
  });

  it('takes along whatever names the entity by IRI', () => {
    const { m, film, award } = films();
    const old = 'http://example.org/films#Film';
    const model = {
      ...m,
      terms: m.terms.map((t) => (t.id === award.id ? { ...t, classAxioms: [{ id: 'x', kind: 'SubClassOf' as const, expression: { type: 'ObjectComplementOf' as const, operand: { type: 'Class' as const, iri: old } } }] } : t)),
      shapeSets: [
        importIntoSet(
          newSetFor('Shapes'),
          `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/s#FilmShape> a sh:NodeShape ; rdfs:label "Film shape" ; sh:targetClass <${old}> ;
  sh:property [ sh:path <http://example.org/films#wins> ; sh:class <${old}> ; sh:in ( <${old}> "${old}" ) ] .
<http://example.org/s#Group> a sh:PropertyGroup ; rdfs:seeAlso <${old}> .`,
        ).set,
      ],
      mappings: [{ source: old, predicate: 'skos:exactMatch', target: 'http://schema.org/Movie', created: 0, method: 'manual' as const, status: 'approved' as const }],
      rejected: [`${old}|http://schema.org/Film`],
    };
    const next = setIriSuffix(model, { term: film.id }, 'Movie').model!;
    const iri = 'http://example.org/films#Movie';
    expect(next.terms.find((t) => t.id === award.id)!.classAxioms![0].expression).toEqual({ type: 'ObjectComplementOf', operand: { type: 'Class', iri } });
    // In what is kept as written too.
    expect(next.shapeSets[0].extra).toContain(iri);
    expect(next.shapeSets[0].extra).not.toContain(old);
    const [shape, property] = next.shapeSets[0].shapes;
    expect(shape).toMatchObject({ iri: 'http://example.org/s#FilmShape' });
    expect(shape.props.find((x) => x.p.endsWith('#targetClass'))!.v).toEqual({ iri });
    // A literal that happens to read like the IRI is a literal, and stays.
    expect(property.props.find((x) => x.p.endsWith('#class'))!.v).toEqual({ iri });
    expect(property.props.find((x) => x.p.endsWith('#in'))!.v).toEqual({ list: [{ iri }, { lit: old }] });
    expect(next.mappings[0]).toMatchObject({ source: iri, target: 'http://schema.org/Movie' });
    expect(next.rejected).toEqual([`${iri}|http://schema.org/Film`]);
  });
});

describe('an IRI from the moment an entity exists', () => {
  const base = () => {
    const m = emptyModel('Films');
    m.baseIri = 'http://example.org/films#';
    const t = newTerm({ name: 'New class' });
    m.terms.push(t);
    return { m: withIris(m), id: t.id };
  };
  const named = (m: Model, id: string, name: string) => withIris({ ...m, terms: m.terms.map((x) => (x.id === id ? { ...x, name } : x)) });

  it('stands in until the entity is named, and is then made from the name, once', () => {
    const { m, id } = base();
    expect(m.terms[0]).toMatchObject({ iri: 'http://example.org/films#NewClass', pendingIri: true });
    const n = named(m, id, 'Documentary');
    expect(n.terms[0].iri).toBe('http://example.org/films#Documentary');
    expect(n.terms[0].pendingIri).toBeUndefined();
    // A later rename changes the label, not the IRI.
    expect(named(n, id, 'Docu-drama').terms[0].iri).toBe('http://example.org/films#Documentary');
  });

  it('takes what referred to the stand-in along when it is replaced', () => {
    const { m, id } = base();
    const shaped: Model = { ...m, shapeSets: [importIntoSet(newSetFor('Shapes'), '<http://example.org/films#Shape> <http://www.w3.org/ns/shacl#targetClass> <http://example.org/films#NewClass> .').set] };
    const n = named(shaped, id, 'Documentary');
    expect(n.shapeSets[0].shapes[0].props[0].v).toEqual({ iri: 'http://example.org/films#Documentary' });
  });

  it('is no longer a stand-in once it is set by hand', () => {
    const { m, id } = base();
    const set = setIriSuffix(m, { term: id }, 'F12').model!;
    expect(set.terms[0]).toMatchObject({ iri: 'http://example.org/films#F12' });
    expect(set.terms[0].pendingIri).toBeUndefined();
    expect(named(set, id, 'Documentary').terms[0].iri).toBe('http://example.org/films#F12');
  });

  it('stands in for the numbered name a second new entity is given, too', () => {
    const m = emptyModel('Films');
    m.baseIri = 'http://example.org/films#';
    m.annProps = [newAnnotationProp({ name: 'new annotation property 2' })];
    const first = withIris(m);
    expect(first.annProps[0]).toMatchObject({ iri: 'http://example.org/films#newAnnotationProperty2', pendingIri: true });
    const renamed = withIris({ ...first, annProps: first.annProps.map((p) => ({ ...p, name: 'source note' })) });
    expect(renamed.annProps[0]).toMatchObject({ iri: 'http://example.org/films#sourceNote' });
    expect(renamed.annProps[0].pendingIri).toBeUndefined();
  });
});
