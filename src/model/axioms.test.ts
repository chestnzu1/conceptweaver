import { propDatatype, withDatatype } from './domains';
import { describe, expect, it } from 'vitest';
import { addFact, addIsA, addLink, addPropLink, addToDomain, addValue, characteristicIssues, inheritedPropertiesOfClass, linkedTerms, propertiesOfClass, removeFromDomain, removeIsA, removeLink, removePropLink, removeValue, validateLiteral, type Edit } from './axioms';
import { inferredRestrictions } from './inferred';
import { withIris } from './iri';
import { assertedSuperclasses, objectProperties, propLinks, restrictionsOf } from './props';
import { fromTurtle, toTurtle } from './rdf';
import { reason } from './reasoner';
import { newProp, emptyModel, newRelation, newTerm, normalizeModel, type Model, type Term, type TermType } from './types';

/** A small ontology: classes, object and data properties, individuals. Every edit below gives a new model. */
function build() {
  let m: Model = { ...emptyModel('Films'), baseIri: 'http://example.org/films#', lang: 'en' };
  const id: Record<string, string> = {};
  const term = (name: string, type: TermType = 'concept', extra: Partial<Term> = {}) => {
    const t = newTerm({ name, type, ...extra });
    id[name] = t.id;
    m = { ...m, terms: [...m.terms, t] };
  };
  for (const c of ['Work', 'Film', 'Documentary', 'Person', 'Actor', 'Employee', 'Working actor', 'Studio']) term(c);
  term('Release date', 'property', { ranges: withDatatype({}, 'xsd:date') });
  term('Title', 'property', { ranges: withDatatype({}, 'xsd:string') });
  term('Running time', 'property', { ranges: withDatatype({}, 'xsd:integer') });
  for (const i of ['Parasite', 'Bong', 'Song']) term(i, 'instance');
  const rel = (from: string, to: string, p: Parameters<typeof newRelation>[0] extends infer R ? Partial<R> : never = {}) => {
    m = { ...m, relations: [...m.relations, newRelation({ from: id[from], to: id[to], ...p })] };
  };
  // Each property's id is its name, for reading: an id is any string the model does not use twice.
  m = { ...m, props: ['directs', 'directed by', 'makes', 'acts in'].map((name) => newProp({ id: name, name })) };
  rel('Film', 'Work', { kind: 'generalization' });
  rel('Documentary', 'Film', { kind: 'generalization' });
  rel('Actor', 'Person', { kind: 'generalization' });
  rel('Employee', 'Person', { kind: 'generalization' });
  rel('Parasite', 'Film', { kind: 'generalization' });
  rel('Bong', 'Person', { kind: 'generalization' });
  rel('Film', 'Release date', { kind: 'property' });
  rel('Actor', 'Film', { label: 'acts in' });
  return { m: withIris(m), id };
}

/** The model after an edit that must be accepted. */
const ok = (e: Edit): Model => {
  expect(e.error).toBeUndefined();
  return e.model!;
};
const names = (m: Model, ids: string[]) => ids.map((x) => m.terms.find((t) => t.id === x)!.name);
const block = (ttl: string, subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';

describe('multiple inheritance', () => {
  it('lets a class have several asserted superclasses, each its own statement', () => {
    const { m, id } = build();
    const two = ok(addIsA(ok(addIsA(m, id['Working actor'], id.Actor)), id['Working actor'], id.Employee));
    expect(names(two, assertedSuperclasses(two, id['Working actor']))).toEqual(['Actor', 'Employee']);
    expect(block(toTurtle(two), ':WorkingActor')).toContain('rdfs:subClassOf :Actor , :Employee');
    // Removing one leaves the other, and nothing else, as it was.
    const one = removeIsA(two, id['Working actor'], id.Actor);
    expect(names(one, assertedSuperclasses(one, id['Working actor']))).toEqual(['Employee']);
    expect(one.relations.length).toBe(two.relations.length - 1);
  });

  it('survives export and import, and only what is stated is asserted', () => {
    const { m, id } = build();
    const two = ok(addIsA(ok(addIsA(m, id['Working actor'], id.Actor)), id['Working actor'], id.Employee));
    const back = fromTurtle(toTurtle(two));
    const wa = back.terms.find((t) => t.name === 'Working actor')!.id;
    expect(names(back, assertedSuperclasses(back, wa)).sort()).toEqual(['Actor', 'Employee']);
    // Person follows from both, but is inferred, never asserted.
    expect(names(back, assertedSuperclasses(back, wa))).not.toContain('Person');
    expect(reason(back).superclasses(wa).filter((l) => !l.asserted).map((l) => back.terms.find((t) => t.id === l.id)!.name)).toEqual(['Person']);
  });

  it('refuses what cannot be stated and says why', () => {
    const { m, id } = build();
    expect(addIsA(m, id.Film, id.Film).error).toBe('“Film” cannot be its own superclass.');
    expect(addIsA(m, id.Film, id.Work).error).toBe('“Work” is already an asserted superclass of “Film”.');
    expect(addIsA(m, id.Film, id.Parasite).error).toBe('A class cannot be a kind of an individual.');
    // An individual has types, a data property has superproperties.
    expect(names(ok(addIsA(m, id.Parasite, id.Work)), assertedSuperclasses(ok(addIsA(m, id.Parasite, id.Work)), id.Parasite))).toEqual(['Film', 'Work']);
    expect(block(toTurtle(ok(addIsA(m, id.Title, id['Release date']))), ':title')).toContain('rdfs:subPropertyOf :releaseDate');
    // A cycle is allowed, as in OWL, but is pointed out.
    expect(addIsA(m, id.Work, id.Documentary).note).toMatch(/each other's superclass/);
  });
});

describe('class axioms', () => {
  it('states equivalent and disjoint classes, read from either side', () => {
    const { m, id } = build();
    const eq = addLink(m, id.Film, id.Work, 'equivalentClass');
    // These statements need the RDFS & OWL properties, which are switched on for the user and said so.
    expect(eq.note).toMatch(/switched on/);
    let n = ok(eq);
    expect(n.vocab.enabled).toBe(true);
    n = ok(addLink(n, id.Film, id.Studio, 'disjointWith'));
    expect(names(n, linkedTerms(n, id.Work, 'equivalentClass').map((x) => x.id))).toEqual(['Film']);
    expect(names(n, linkedTerms(n, id.Studio, 'disjointWith').map((x) => x.id))).toEqual(['Film']);
    const ttl = toTurtle(n);
    expect(block(ttl, ':Film')).toContain('owl:equivalentClass :Work');
    expect(block(ttl, ':Film')).toContain('owl:disjointWith :Studio');
    const back = fromTurtle(ttl);
    const film = back.terms.find((t) => t.name === 'Film')!.id;
    expect(names(back, linkedTerms(back, film, 'disjointWith').map((x) => x.id))).toEqual(['Studio']);
    expect(names(back, linkedTerms(back, film, 'equivalentClass').map((x) => x.id))).toEqual(['Work']);
    // Removing from the other side removes that statement and nothing else.
    const gone = removeLink(n, id.Studio, id.Film, 'disjointWith');
    expect(linkedTerms(gone, id.Film, 'disjointWith')).toEqual([]);
    expect(linkedTerms(gone, id.Film, 'equivalentClass').length).toBe(1);
    expect(gone.relations.length).toBe(n.relations.length - 1);
  });

  it('refuses contradictions and repeats', () => {
    const { m, id } = build();
    const n = ok(addLink(m, id.Film, id.Studio, 'disjointWith'));
    expect(addLink(n, id.Studio, id.Film, 'disjointWith').error).toBe('“Studio” is already stated to be disjoint with “Film”.');
    expect(addLink(n, id.Film, id.Studio, 'equivalentClass').error).toMatch(/stated to be disjoint with “Studio”. Both cannot hold/);
    expect(addLink(n, id.Film, id.Film, 'disjointWith').error).toBe('“Film” cannot be disjoint with itself.');
    expect(addLink(n, id.Film, id.Parasite, 'disjointWith').error).toMatch(/Only a class can be disjoint with a class/);
    expect(addLink(n, id.Documentary, id.Film, 'disjointWith').note).toMatch(/can now have no members/);
  });

  it('keeps class expressions as axioms of their own, apart from named classes', () => {
    const ttl = `@prefix : <http://example.org/x#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:A a owl:Class ; rdfs:subClassOf :B , [ a owl:Class ; owl:unionOf ( :B :C ) ] ; owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( :B :C ) ] .
:B a owl:Class . :C a owl:Class .`;
    const m = fromTurtle(ttl);
    const a = m.terms.find((t) => t.name === 'A')!;
    expect(names(m, assertedSuperclasses(m, a.id))).toEqual(['B']);
    expect(a.classAxioms!.map((x) => x.kind).sort()).toEqual(['EquivalentClasses', 'SubClassOf']);
    // Editing named classes leaves the expressions alone, and they are written back as they came.
    const edited = removeIsA(ok(addIsA(m, a.id, m.terms.find((t) => t.name === 'C')!.id)), a.id, m.terms.find((t) => t.name === 'B')!.id);
    expect(edited.terms.find((t) => t.id === a.id)!.classAxioms).toEqual(a.classAxioms);
    const out = block(toTurtle(edited), ':A');
    expect(out).toContain('owl:unionOf');
    expect(out).toContain('owl:intersectionOf');
    expect(out).toMatch(/rdfs:subClassOf :C , \[/);
  });

  it('lists properties by their domain without making them requirements', () => {
    const { m, id } = build();
    // From use: Film has "Release date" attached, Actor uses "acts in".
    expect(propertiesOfClass(m, id.Film).map((p) => [p.name, p.data, p.auto])).toEqual([['Release date', true, true]]);
    expect(propertiesOfClass(m, id.Actor).map((p) => [p.name, p.auto])).toEqual([['acts in', true]]);
    let n = ok(addToDomain(m, id.Work, { ref: id.Title, data: true }));
    n = ok(addToDomain(n, id.Work, { ref: 'directed by', data: false }));
    expect(propertiesOfClass(n, id.Work).map((p) => [p.name, p.auto])).toEqual([['directed by', false], ['Title', false]]);
    // A domain is not a restriction: nothing is required of the class.
    expect(restrictionsOf(n, id.Work)).toEqual([]);
    expect(block(toTurtle(n), ':Work')).not.toContain('owl:Restriction');
    expect(block(toTurtle(n), ':title')).toContain('rdfs:domain :Work');
    // Subclasses get them by inference only.
    expect(propertiesOfClass(n, id.Documentary)).toEqual([]);
    expect(inheritedPropertiesOfClass(n, id.Documentary).map((p) => `${p.name} via ${p.viaName}`).sort()).toEqual(['Release date via Film', 'Title via Work', 'directed by via Work']);
    expect(removeFromDomain(n, id.Film, { ref: id['Release date'], data: true }).error).toMatch(/follows the classes the property is attached to/);
    expect(propertiesOfClass(ok(removeFromDomain(n, id.Work, { ref: id.Title, data: true })), id.Work).map((p) => p.name)).toEqual(['directed by']);
  });
});

describe('property characteristics and relations', () => {
  it('writes every characteristic of an object property and reads it back', () => {
    const { m } = build();
    const all = ['functional', 'inverseFunctional', 'transitive', 'symmetric', 'asymmetric', 'reflexive', 'irreflexive'];
    const n = { ...m, props: m.props.map((p) => (p.name === 'directs' ? { ...p, chars: all } : p)) };
    const ttl = block(toTurtle(n), ':directs');
    for (const owl of ['FunctionalProperty', 'InverseFunctionalProperty', 'TransitiveProperty', 'SymmetricProperty', 'AsymmetricProperty', 'ReflexiveProperty', 'IrreflexiveProperty']) expect(ttl).toContain('owl:' + owl);
    expect(fromTurtle(toTurtle(n)).props.find((p) => p.name === 'directs')!.chars.sort()).toEqual([...all].sort());
  });

  it('warns about characteristics that do not go together', () => {
    expect(characteristicIssues(['functional', 'symmetric'])).toEqual([]);
    expect(characteristicIssues(['symmetric', 'asymmetric'])[0]).toMatch(/^Symmetric and asymmetric together/);
    expect(characteristicIssues(['reflexive', 'irreflexive']).length).toBe(1);
    expect(characteristicIssues(['transitive', 'functional'])[0]).toMatch(/OWL 2 DL/);
  });

  it('gives an object property several superproperties, inverses, equivalent and disjoint properties', () => {
    const { m } = build();
    let n = ok(addPropLink(m, 'directs', 'makes', 'parents'));
    n = ok(addPropLink(n, 'directs', 'acts in', 'parents'));
    n = ok(addPropLink(n, 'directs', 'directed by', 'inverses'));
    n = ok(addPropLink(n, 'makes', 'acts in', 'disjoints'));
    expect(propLinks(n, 'directs', 'parents')).toEqual(['makes', 'acts in']);
    // Inverse and disjoint hold both ways, whichever property they were stated on.
    expect(propLinks(n, 'directed by', 'inverses')).toEqual(['directs']);
    expect(propLinks(n, 'acts in', 'disjoints')).toEqual(['makes']);
    const ttl = toTurtle(n);
    expect(block(ttl, ':directs')).toContain('rdfs:subPropertyOf :makes , :actsIn');
    expect(block(ttl, ':directs')).toContain('owl:inverseOf :directedBy');
    expect(block(ttl, ':makes')).toContain('owl:propertyDisjointWith :actsIn');
    // Read back, the properties have ids of their own: they are looked up, and their links shown, by name.
    const back = fromTurtle(ttl);
    const named = (name: string) => back.props.find((p) => p.name === name)!.id;
    const names = (ids: string[]) => ids.map((x) => back.props.find((p) => p.id === x)!.name);
    expect(names(propLinks(back, named('directs'), 'parents')).sort()).toEqual(['acts in', 'makes']);
    expect(names(propLinks(back, named('acts in'), 'disjoints'))).toEqual(['makes']);
    expect(addPropLink(n, 'acts in', 'makes', 'equivalents').error).toMatch(/Both cannot hold/);
    expect(addPropLink(n, 'directs', 'directs', 'inverses').error).toMatch(/Symmetric/);
    expect(addPropLink(n, 'directed by', 'directs', 'inverses').error).toMatch(/already stated/);
    // Removed from the other side: gone for both, and the rest untouched.
    const gone = removePropLink(n, 'directed by', 'directs', 'inverses');
    expect(propLinks(gone, 'directs', 'inverses')).toEqual([]);
    expect(propLinks(gone, 'directs', 'parents')).toEqual(['makes', 'acts in']);
  });

  it('reads a model saved when a property had one parent and one inverse', () => {
    const old = { format: 'conceptweaver', version: 1, terms: [], relations: [], props: [{ name: 'has part', chars: [], parent: 'Relates', inverseOf: 'part of' }, { name: 'part of', chars: [] }, { name: 'relates', chars: [] }] };
    const read = normalizeModel(old);
    const idOf = (name: string) => read.props.find((p) => p.name === name)!.id;
    expect(read.props[0]).toMatchObject({ parents: [idOf('relates')], inverses: [idOf('part of')] });
  });

  it('reasons with them: sub-properties, equivalence, and disjoint properties as a contradiction', () => {
    const { m, id } = build();
    let n = ok(addPropLink(m, 'directs', 'makes', 'parents'));
    n = { ...n, relations: [...n.relations, newRelation({ from: id.Bong, to: id.Parasite, label: 'directs' })] };
    expect(reason(n).inferences.map((i) => i.text)).toContain('“Bong” makes “Parasite”');
    const clash = ok(addPropLink(n, 'makes', 'directs', 'disjoints'));
    const r = reason(clash);
    expect(r.consistent).toBe(false);
    expect(r.conflicts[0].message).toMatch(/disjoint properties, but both hold for “Bong” and “Parasite”/);
  });

  it('makes a data property functional, with superproperties, equivalent and disjoint properties', () => {
    const { m, id } = build();
    let n: Model = { ...m, terms: m.terms.map((t) => (t.id === id['Release date'] ? { ...t, functional: true } : t)) };
    n = ok(addIsA(n, id['Release date'], id.Title));
    n = ok(addLink(n, id['Release date'], id['Running time'], 'propertyDisjointWith'));
    n = ok(addLink(n, id.Title, id['Running time'], 'equivalentProperty'));
    const ttl = toTurtle(n);
    expect(block(ttl, ':releaseDate')).toMatch(/^:releaseDate a owl:DatatypeProperty , owl:FunctionalProperty ;/);
    expect(block(ttl, ':releaseDate')).toContain('owl:propertyDisjointWith :runningTime');
    expect(block(ttl, ':title')).toContain('owl:equivalentProperty :runningTime');
    const back = fromTurtle(ttl);
    const date = back.terms.find((t) => t.name === 'Release date')!;
    expect(date).toMatchObject({ type: 'property', functional: true });
    expect(propDatatype(date)).toBe('xsd:date');
    expect(names(back, assertedSuperclasses(back, date.id))).toEqual(['Title']);
    expect(names(back, linkedTerms(back, date.id, 'propertyDisjointWith').map((x) => x.id))).toEqual(['Running time']);
    expect(back.terms.find((t) => t.name === 'Title')!.functional).toBeUndefined();
  });
});

describe('individuals', () => {
  it('states types, facts, values, sameness and difference', () => {
    const { m, id } = build();
    let n = ok(addFact(m, id.Bong, 'directs', id.Parasite));
    n = ok(addValue(n, id.Parasite, { prop: id['Release date'], value: '2019-05-30' }));
    n = ok(addValue(n, id.Parasite, { prop: id.Title, value: '기생충', lang: 'ko' }));
    n = ok(addValue(n, id.Parasite, { prop: id.Title, value: 'Parasite', lang: 'en' }));
    n = ok(addValue(n, id.Parasite, { prop: id['Running time'], value: '132' }));
    n = ok(addLink(n, id.Bong, id.Song, 'differentFrom'));
    const ttl = toTurtle(n);
    expect(block(ttl, ':Bong')).toContain(':directs :Parasite');
    expect(block(ttl, ':Bong')).toContain('owl:differentFrom :Song');
    expect(block(ttl, ':Parasite')).toContain(':releaseDate "2019-05-30"^^xsd:date');
    expect(block(ttl, ':Parasite')).toContain(':title "기생충"@ko , "Parasite"@en');
    expect(block(ttl, ':Parasite')).toContain(':runningTime "132"^^xsd:integer');
    const back = fromTurtle(ttl);
    const parasite = back.terms.find((t) => t.name === 'Parasite')!;
    const prop = (v: { prop: string }) => back.terms.find((t) => t.id === v.prop)!.name;
    expect(parasite.values!.map((v) => `${prop(v)}=${v.value}${v.lang ? '@' + v.lang : ''}`).sort()).toEqual(['Release date=2019-05-30', 'Running time=132', 'Title=Parasite@en', 'Title=기생충@ko']);
    expect(toTurtle(back).split('\n\n').sort()).toEqual(ttl.split('\n\n').sort());
    // Values are literals of a datatype property: they never become annotations, or the reverse.
    expect(parasite.fields).toEqual([]);
    expect(removeValue(n, id.Parasite, 0).terms.find((t) => t.id === id.Parasite)!.values!.length).toBe(3);
  });

  it('checks a value against the datatype of its property', () => {
    const { m, id } = build();
    expect(addValue(m, id.Parasite, { prop: id['Release date'], value: 'May 2019' }).error).toBe('“May 2019” is not a date (xsd:date). It should look like 2024-05-17.');
    expect(addValue(m, id.Parasite, { prop: id['Running time'], value: '2h' }).error).toMatch(/not a whole number/);
    expect(addValue(m, id.Parasite, { prop: id['Running time'], value: '132', lang: 'en' }).error).toMatch(/A language only goes with text/);
    expect(addValue(m, id.Parasite, { prop: id.Title, value: 'x', lang: 'english!' }).error).toMatch(/not a language code/);
    expect(addValue(m, id.Film, { prop: id.Title, value: 'x' }).error).toBe('Only an individual has property values.');
    expect(validateLiteral('true', 'xsd:boolean')).toBeUndefined();
    expect(validateLiteral('2024-02-30T25:00:00', 'xsd:dateTime')).toMatch(/not a date and time/);
    expect(validateLiteral('anything', undefined)).toBeUndefined();
    const once = ok(addValue(m, id.Parasite, { prop: id.Title, value: 'Parasite' }));
    expect(addValue(once, id.Parasite, { prop: id.Title, value: 'Parasite' }).error).toMatch(/already has that value/);
    expect(addFact(m, id.Bong, 'directs', id.Film).error).toBe('The value of an object property is another individual.');
  });

  it('does not treat a domain as a requirement: a value outside it is accepted, and its consequence is only inferred', () => {
    const { m, id } = build();
    // "Release date" has the domain Film (from use). Bong is a Person; giving him one is allowed.
    const n = ok(addValue(m, id.Bong, { prop: id['Release date'], value: '1969-09-14' }));
    expect(names(n, assertedSuperclasses(n, id.Bong))).toEqual(['Person']);
    const types = reason(n).types(id.Bong);
    expect(types.filter((t) => t.asserted).map((t) => names(n, [t.id])[0])).toEqual(['Person']);
    expect(types.filter((t) => !t.asserted).map((t) => names(n, [t.id])[0]).sort()).toEqual(['Film', 'Work']);
    // And an individual of the class without a value is no error either.
    expect(reason(m).consistent).toBe(true);
  });

  it('finds two values of a functional data property inconsistent', () => {
    const { m, id } = build();
    let n: Model = { ...m, terms: m.terms.map((t) => (t.id === id['Release date'] ? { ...t, functional: true } : t)) };
    n = ok(addValue(n, id.Parasite, { prop: id['Release date'], value: '2019-05-30' }));
    expect(reason(n).consistent).toBe(true);
    const second = addValue(n, id.Parasite, { prop: id['Release date'], value: '2019-05-21' });
    expect(second.note).toMatch(/functional/);
    const r = reason(ok(second));
    expect(r.consistent).toBe(false);
    expect(r.conflicts[0].message).toBe('“Release date” is functional, but “Parasite” has two different values for it: "2019-05-30" and "2019-05-21".');
  });

  it('reads "all different" and "all disjoint" lists as the pairs they stand for', () => {
    const ttl = `@prefix : <http://example.org/x#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
:A a owl:Class . :B a owl:Class . :C a owl:Class .
:x a owl:NamedIndividual , :A . :y a owl:NamedIndividual , :A . :z a owl:NamedIndividual , :A .
[] a owl:AllDisjointClasses ; owl:members ( :A :B :C ) .
[] a owl:AllDifferent ; owl:distinctMembers ( :x :y :z ) .`;
    const m = fromTurtle(ttl);
    const t = (name: string) => m.terms.find((x) => x.iri!.endsWith('#' + name))!.id;
    expect(linkedTerms(m, t('B'), 'disjointWith').map((x) => x.id).sort()).toEqual([t('A'), t('C')].sort());
    expect(linkedTerms(m, t('x'), 'differentFrom').length).toBe(2);
  });
});

describe('annotations', () => {
  it('keeps several values of one annotation, each in its own language, through export and import', () => {
    const { m, id } = build();
    const fields = [
      { key: 'rdfs:label', value: 'Film', lang: 'nl' },
      { key: 'rdfs:label', value: '电影', lang: 'zh' },
      { key: 'skos:definition', value: 'Een werk van bewegend beeld.', lang: 'nl' },
      { key: 'skos:altLabel', value: 'rolprent', lang: 'nl' },
      { key: 'Review status', value: 'approved' },
    ];
    const n: Model = { ...m, terms: m.terms.map((t) => (t.id === id.Film ? { ...t, description: 'A moving-image work.', synonyms: 'Movie, Motion picture', fields } : t)) };
    const ttl = toTurtle(n);
    const film = block(ttl, ':Film');
    expect(film).toContain('rdfs:label "Film"@en , "Film"@nl , "电影"@zh');
    expect(film).toContain('skos:definition "A moving-image work."@en , "Een werk van bewegend beeld."@nl');
    expect(film).toContain('skos:altLabel "Movie"@en , "Motion picture"@en , "rolprent"@nl');
    const back = fromTurtle(ttl).terms.find((t) => t.iri === 'http://example.org/films#Film')!;
    expect(back).toMatchObject({ name: 'Film', description: 'A moving-image work.', synonyms: 'Movie, Motion picture' });
    expect(back.fields.map((f) => `${f.key}=${f.value}${f.lang ? '@' + f.lang : ''}`).sort()).toEqual(['Review status=approved', 'rdfs:label=Film@nl', 'rdfs:label=电影@zh', 'skos:altLabel=rolprent@nl', 'skos:definition=Een werk van bewegend beeld.@nl'].sort());
  });

  it('keeps annotation properties distinct from datatype properties', () => {
    const { m, id } = build();
    const n: Model = { ...m, terms: m.terms.map((t) => (t.id === id.Film ? { ...t, fields: [{ key: 'Review status', value: 'approved' }] } : t)) };
    const ttl = toTurtle(n);
    expect(block(ttl, ':reviewStatus')).toContain('a owl:AnnotationProperty');
    expect(block(ttl, ':title')).toContain('a owl:DatatypeProperty');
    const back = fromTurtle(ttl);
    // The annotation property does not become a data property term, and no data property becomes a field.
    expect(back.terms.filter((t) => t.type === 'property').map((t) => t.name).sort()).toEqual(['Release date', 'Running time', 'Title']);
    expect(back.terms.some((t) => t.name.toLowerCase() === 'review status')).toBe(false);
    // An annotation on a class is no restriction on it and no fact about its members.
    expect(restrictionsOf(back, back.terms.find((t) => t.name === 'Film')!.id).map((r) => r.text)).toEqual(['Release date some xsd:date']);
  });

  it('annotates object properties too, and keeps what an imported one carries', () => {
    const { m } = build();
    const n: Model = { ...m, props: m.props.map((p) => (p.name === 'directs' ? { ...p, description: 'Is the director of.', fields: [{ key: 'rdfs:label', value: 'regisseert', lang: 'nl' }, { key: 'skos:example', value: 'Bong directs Parasite.' }] } : p)) };
    const ttl = toTurtle(n);
    expect(block(ttl, ':directs')).toContain('rdfs:label "directs"@en , "regisseert"@nl');
    expect(block(ttl, ':directs')).toContain('skos:example "Bong directs Parasite."');
    const back = objectProperties(fromTurtle(ttl)).find((p) => p.name === 'directs')!;
    expect(back.description).toBe('Is the director of.');
    expect(back.fields).toEqual([{ key: 'rdfs:label', value: 'regisseert', lang: 'nl' }, { key: 'skos:example', value: 'Bong directs Parasite.' }]);
  });
});

describe('inferred and asserted information stay apart', () => {
  it('never writes what the reasoner works out into the model or its export', () => {
    const { m, id } = build();
    const before = JSON.stringify(m);
    const r = reason(m);
    const inferred = inferredRestrictions(m, id.Documentary);
    expect(inferred.restrictions.map((x) => x.restriction.text)).toEqual(['Release date some xsd:date']);
    expect(r.superclasses(id.Documentary).map((l) => [names(m, [l.id])[0], l.asserted])).toEqual([['Film', true], ['Work', false]]);
    expect(r.types(id.Parasite).map((l) => [names(m, [l.id])[0], l.asserted])).toEqual([['Film', true], ['Work', false]]);
    // Asking changed nothing, and the export holds only what was stated.
    expect(JSON.stringify(m)).toBe(before);
    const ttl = toTurtle(m);
    expect(block(ttl, ':Documentary')).toBe(':Documentary a owl:Class ;\n    rdfs:label "Documentary"@en ;\n    rdfs:subClassOf :Film .');
    expect(block(ttl, ':Parasite')).not.toContain(':Work');
    expect(restrictionsOf(m, id.Documentary)).toEqual([]);
  });

  it('turns an inferred superclass into an asserted one only when it is stated', () => {
    const { m, id } = build();
    const stated = ok(addIsA(m, id.Documentary, id.Work));
    expect(reason(stated).superclasses(id.Documentary).map((l) => l.asserted)).toEqual([true, true]);
    expect(block(toTurtle(stated), ':Documentary')).toContain('rdfs:subClassOf :Film , :Work');
  });
});

describe('serialization of a whole edited ontology', () => {
  it('comes back from Turtle saying the same thing, and from JSON identical', () => {
    const { m, id } = build();
    let n = ok(addIsA(ok(addIsA(m, id['Working actor'], id.Actor)), id['Working actor'], id.Employee));
    n = ok(addLink(n, id.Film, id.Studio, 'disjointWith'));
    n = ok(addLink(n, id.Actor, id.Employee, 'equivalentClass'));
    n = ok(addPropLink(n, 'directs', 'makes', 'parents'));
    n = ok(addPropLink(n, 'directs', 'directed by', 'inverses'));
    n = ok(addPropLink(n, 'makes', 'acts in', 'disjoints'));
    n = ok(addPropLink(n, 'makes', 'directed by', 'equivalents'));
    n = { ...n, props: n.props.map((p) => (p.name === 'directs' ? { ...p, chars: ['functional', 'irreflexive'], fields: [{ key: 'rdfs:label', value: 'regisseert', lang: 'nl' }] } : p)) };
    n = ok(addToDomain(n, id.Person, { ref: 'directs', data: false }));
    n = { ...n, terms: n.terms.map((t) => (t.id === id['Release date'] ? { ...t, functional: true } : t)) };
    n = ok(addFact(n, id.Bong, 'directs', id.Parasite));
    n = ok(addValue(n, id.Parasite, { prop: id['Release date'], value: '2019-05-30' }));
    n = ok(addLink(n, id.Bong, id.Song, 'differentFrom'));
    expect(reason(n).consistent).toBe(true);
    const ttl = toTurtle(n);
    const back = withIris(fromTurtle(ttl));
    expect(toTurtle(back).split('\n\n').sort()).toEqual(ttl.split('\n\n').sort());
    // The app's own format keeps everything exactly, positions included.
    expect(normalizeModel(JSON.parse(JSON.stringify(n)))).toEqual(n);
  });
});
