import { describe, expect, it } from 'vitest';
import { setIriSuffix, withIris } from './iri';
import { fromTurtle, toTurtle } from './rdf';
import { emptyModel, newRelation, newTerm, normalizeModel } from './types';

function films() {
  const m = emptyModel('Films');
  m.baseIri = 'http://example.org/films#';
  const film = newTerm({ name: 'Film' });
  const award = newTerm({ name: 'Award' });
  m.terms.push(film, award);
  m.props.push({ name: 'wins', description: '', chars: [] });
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
    const edit = setIriSuffix(m, { prop: 'wins' }, 'P12');
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
      terms: m.terms.map((t) => (t.id === award.id ? { ...t, axioms: [`rdfs:subClassOf [ a owl:Class ; owl:complementOf <${old}> ]`] } : t)),
      shapes: {
        extra: `<http://example.org/s#X> <http://www.w3.org/ns/shacl#targetClass> <${old}> .`,
        nodes: [{ id: 's1', iri: 'http://example.org/s#FilmShape', name: 'Film shape', targetClass: [old], targetNode: [], targetSubjectsOf: [], targetObjectsOf: [], properties: [{ id: 'p1', path: 'http://example.org/films#wins', class: old, in: [{ v: old, iri: true }, { v: old }] }] }],
      },
      mappings: [{ source: old, predicate: 'skos:exactMatch', target: 'http://schema.org/Movie', created: 0, method: 'manual' as const, status: 'approved' as const }],
      rejected: [`${old}|http://schema.org/Film`],
    };
    const next = setIriSuffix(model, { term: film.id }, 'Movie').model!;
    const iri = 'http://example.org/films#Movie';
    expect(next.terms.find((t) => t.id === award.id)!.axioms![0]).toContain(`<${iri}>`);
    expect(next.shapes.extra).toContain(`<${iri}>`);
    expect(next.shapes.nodes[0]).toMatchObject({ iri: 'http://example.org/s#FilmShape', targetClass: [iri] });
    // A literal that happens to read like the IRI is a literal, and stays.
    expect(next.shapes.nodes[0].properties[0]).toMatchObject({ path: 'http://example.org/films#wins', class: iri, in: [{ v: iri, iri: true }, { v: old }] });
    expect(next.mappings[0]).toMatchObject({ source: iri, target: 'http://schema.org/Movie' });
    expect(next.rejected).toEqual([`${iri}|http://schema.org/Film`]);
  });
});
