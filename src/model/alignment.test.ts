import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { addMapping, importMappings, listMappings, mappingIssues, mappingsToTurtle, removeMapping, setMappingMeta } from './alignment';
import { addIsA } from './axioms';
import { addExternal, collisions, copyEntities, externalUse, importsClosure, readExternal, removeExternal, reuseEntity } from './external';
import { withIris } from './iri';
import { cachedOntology, cachedOntologyByIri, cacheOntology, loadModel, saveModel, uncacheOntology } from './library';
import { suggestMappings } from './matcher';
import { assertedSuperclasses, objectProperties, restrictionsOf } from './props';
import { fromTurtle, toTurtle } from './rdf';
import { reason } from './reasoner';
import { emptyModel, newRelation, newTerm, normalizeModel, type Model, type TermType } from './types';
import { owlFindings } from './validation';

const ORG = `@prefix org: <http://example.org/org#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<http://example.org/org> a owl:Ontology ; rdfs:label "Organization Ontology" ; owl:versionIRI <http://example.org/org/1.0> .
org:Agent a owl:Class ; rdfs:label "Agent" .
org:Person a owl:Class ; rdfs:label "Person" ; rdfs:subClassOf org:Agent ; skos:definition "A human being." .
org:Organization a owl:Class ; rdfs:label "Organization" ; rdfs:subClassOf org:Agent ; owl:disjointWith org:Person ; skos:definition "A company or other body that people work for." .
org:Member a owl:Class ; rdfs:label "Member" ; skos:altLabel "Employee" ; skos:notation "M1" ;
    rdfs:subClassOf org:Person , [ a owl:Restriction ; owl:onProperty org:memberOf ; owl:someValuesFrom org:Organization ] .
org:memberOf a owl:ObjectProperty ; rdfs:label "member of" ; rdfs:domain org:Member ; rdfs:range org:Organization .
org:name a owl:DatatypeProperty ; rdfs:label "name" ; rdfs:range xsd:string .
org:acme a owl:NamedIndividual , org:Organization ; rdfs:label "Acme" .
`;

function build() {
  let m: Model = { ...emptyModel('Studio'), baseIri: 'http://example.org/studio#', lang: 'en' };
  const id: Record<string, string> = {};
  const term = (name: string, type: TermType = 'concept', description = '') => {
    const t = newTerm({ name, type, description });
    id[name] = t.id;
    m = { ...m, terms: [...m.terms, t] };
  };
  term('Person', 'concept', 'A human being involved in making films.');
  term('Employee');
  term('Company', 'concept', 'A company that people work for.');
  term('Film');
  term('Freelancer');
  term('title', 'property');
  term('Pat', 'instance');
  m = { ...m, props: [{ name: 'works for', description: '', chars: [] }] };
  m = { ...m, relations: [newRelation({ from: id.Employee, to: id.Person, kind: 'generalization' }), newRelation({ from: id.Employee, to: id.Company, label: 'works for' })] };
  m = withIris(m);
  const org = readExternal(ORG, 'org.ttl', 'file');
  return { m, id, org };
}
const ok = (e: { model?: Model; error?: string }) => {
  expect(e.error).toBeUndefined();
  return e.model!;
};
/** The model with the Organization ontology in its library, and a function that makes one of its entities usable. */
function withOrg(imports = false) {
  const { m, id, org } = build();
  const added = addExternal(m, org, imports, 1000);
  let model = added.model;
  const use = (name: string) => {
    const t = org.model.terms.find((x) => x.name === name);
    const r = reuseEntity(model, added.ref, org.model, t ? { term: t.id } : { prop: name });
    model = r.model;
    return r.entity;
  };
  return { id, org, ref: added.ref, use, get: () => model, set: (x: Model) => (model = x), local: (name: string) => ({ kind: 'term' as const, id: id[name] }) };
}
/** Asserts a mapping on the model as it is once both ends have been made usable. */
const mp = (w: { get: () => Model }, a: Parameters<typeof addMapping>[1], p: string, b: Parameters<typeof addMapping>[3], meta?: Parameters<typeof addMapping>[4]) => addMapping(w.get(), a, p, b, meta);
const block = (ttl: string, subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';
const says = (m: Model) => listMappings(m).map((x) => `${x.source.name} ${x.predicate} ${x.target.name}`);

describe('phase 1: external ontologies', () => {
  it('reads one as a thing of its own, with its IRIs and its numbers', () => {
    const { m, org } = build();
    const before = JSON.stringify(m);
    expect(org.ref).toMatchObject({ name: 'Organization Ontology', iri: 'http://example.org/org', versionIri: 'http://example.org/org/1.0', namespace: 'http://example.org/org#', source: 'org.ttl', classes: 4, objectProperties: 1, dataProperties: 1, individuals: 1 });
    expect(org.model.terms.find((t) => t.name === 'Member')).toMatchObject({ iri: 'http://example.org/org#Member', synonyms: 'Employee', fields: [{ key: 'skos:notation', value: 'M1' }] });
    expect(restrictionsOf(org.model, org.model.terms.find((t) => t.name === 'Member')!.id).map((r) => r.text)).toEqual(['member of some Organization']);
    // Reading it does nothing to the active model.
    expect(JSON.stringify(m)).toBe(before);
  });

  it('says plainly what it cannot read', () => {
    // Another syntax is made Turtle before it gets here (see rdfFormats.ts); what arrives unconverted is refused, saying what it is.
    expect(() => readExternal('<?xml version="1.0"?><rdf:RDF/>', 'x.owl', 'file')).toThrow('This is RDF/XML, which has to be converted to Turtle before it is read here.');
    expect(() => readExternal('{"@context": {}}', 'x.jsonld', 'file')).toThrow(/JSON-LD/);
    expect(() => readExternal('@prefix : <http://x/> .', 'x.ttl', 'file')).toThrow(/No classes, properties or individuals/);
  });

  it('finds IRIs the model already defines, and whether the definitions differ', () => {
    const { m, id, org } = build();
    expect(collisions(m, org.model)).toEqual([]);
    const clash = { ...m, terms: m.terms.map((t) => (t.id === id.Person ? { ...t, iri: 'http://example.org/org#Person' } : t.id === id.Film ? { ...t, iri: 'http://example.org/org#Agent' } : t.id === id.Pat ? { ...t, iri: 'http://example.org/org#Member' } : t)) };
    expect(collisions(clash, org.model)).toEqual([
      { iri: 'http://example.org/org#Agent', name: 'Agent', conflict: 'called “Film” here, “Agent” there' },
      { iri: 'http://example.org/org#Person', name: 'Person' },
      { iri: 'http://example.org/org#Member', name: 'Member', conflict: 'a individual here, a class there'.replace('a individual', 'a individual') },
    ]);
  });

  it('adds it to the library without merging anything into the ontology', () => {
    const w = withOrg();
    expect(w.get().externals).toEqual([{ ...w.org.ref, id: w.ref.id, addedAt: 1000, imports: false }]);
    expect(w.get().terms.length).toBe(7);
    expect(w.get().props.length).toBe(1);
    expect(w.get().prefixes).toEqual([{ prefix: 'org', iri: 'http://example.org/org#' }]);
    // In the library only: the ontology's RDF does not mention it.
    expect(toTurtle(w.get()).split('\n\n').slice(1).join('\n')).not.toMatch(/org:|\/org/);
  });

  it('as a dependency it is imported by IRI, and its content still is not written here', () => {
    const w = withOrg(true);
    const ttl = toTurtle(w.get());
    expect(block(ttl, '<http://example.org/studio>')).toContain('owl:imports <http://example.org/org>');
    expect(ttl.split('\n\n').slice(2).join('\n')).not.toContain('org:');
    // Reading the file back, the dependency is known by its IRI, and nothing was made up about it.
    const back = fromTurtle(ttl);
    expect(back.externals).toMatchObject([{ iri: 'http://example.org/org', imports: true, sourceKind: 'unknown', classes: 0 }]);
    // Supplying the ontology again fills in the same entry rather than adding a second.
    const again = addExternal(back, w.org, false);
    expect(again.model.externals).toMatchObject([{ id: back.externals[0].id, name: 'Organization Ontology', classes: 4, imports: true }]);
  });

  it('is removed only when nothing refers to it', () => {
    const w = withOrg();
    const organization = w.use('Organization');
    w.use('Agent');
    w.set(ok(addIsA(w.get(), w.id.Company, organization.id)));
    expect(externalUse(w.get(), w.ref.id)).toEqual({ entities: 2, statements: 1 });
    expect(removeExternal(w.get(), w.ref.id).error).toBe('1 statement in this ontology still refer to entities of “Organization Ontology”. Remove those first (the Mappings tab lists them).');
    const freed = { ...w.get(), relations: w.get().relations.filter((r) => r.to !== organization.id) };
    const gone = ok(removeExternal(freed, w.ref.id));
    expect(gone.externals).toEqual([]);
    // The references nobody used go with it; the model's own entities stay.
    expect(gone.terms.map((t) => t.name)).toEqual(['Person', 'Employee', 'Company', 'Film', 'Freelancer', 'title', 'Pat']);
  });
});

describe('phase 2: reusing external entities', () => {
  it('refers to an external class under its own IRI, without copying or redefining it', () => {
    const w = withOrg();
    const organization = w.use('Organization');
    const stub = w.get().terms.find((t) => t.id === organization.id)!;
    expect(stub).toMatchObject({ name: 'Organization', iri: 'http://example.org/org#Organization', external: w.ref.id, type: 'concept' });
    // Not a second class in the local namespace, and asking again gives the same one.
    expect(w.get().terms.filter((t) => t.name === 'Organization').length).toBe(1);
    expect(w.use('Organization')).toEqual(organization);
    expect(w.get().terms.filter((t) => t.name === 'Organization').length).toBe(1);

    w.set(ok(addIsA(w.get(), w.id.Company, organization.id)));
    expect(assertedSuperclasses(w.get(), w.id.Company)).toEqual([organization.id]);
    const ttl = toTurtle(w.get());
    expect(block(ttl, ':Company')).toContain('rdfs:subClassOf org:Organization');
    // Only declared: its label, definition and axioms are the other ontology's to state.
    expect(block(ttl, 'org:Organization')).toBe('org:Organization a owl:Class .');
    expect(ttl).not.toContain('org:Agent');
    expect(ttl).not.toContain('owl:imports');
  });

  it('can be a restriction filler, a domain and a range, and an external property can be used', () => {
    const w = withOrg();
    const organization = w.use('Organization');
    const memberOf = w.use('member of');
    expect(objectProperties(w.get()).find((p) => p.key === memberOf.id)).toMatchObject({ iri: 'http://example.org/org#memberOf', external: w.ref.id });
    let n = { ...w.get(), relations: [...w.get().relations, newRelation({ from: w.id.Employee, to: organization.id, label: 'member of' }), newRelation({ from: w.id.Freelancer, to: organization.id, label: 'works for' })] };
    n = { ...n, props: n.props.map((p) => (p.name === 'works for' ? { ...p, range: [organization.id] } : p)) };
    const ttl = toTurtle(n);
    expect(block(ttl, ':Employee')).toContain('rdfs:subClassOf :Person , [ a owl:Restriction ; owl:onProperty :worksFor ; owl:someValuesFrom :Company ] , [ a owl:Restriction ; owl:onProperty org:memberOf ; owl:someValuesFrom org:Organization ]');
    expect(block(ttl, ':worksFor')).toContain('rdfs:range org:Organization');
    // Using an external property says nothing about its domain or range.
    expect(block(ttl, 'org:memberOf')).toBe('org:memberOf a owl:ObjectProperty .');
  });

  it('keeps the references through export and import', () => {
    const w = withOrg(true);
    const organization = w.use('Organization');
    w.set(ok(addIsA(w.get(), w.id.Company, organization.id)));
    const ttl = toTurtle(w.get());
    const back = fromTurtle(ttl);
    const org = back.terms.find((t) => t.iri === 'http://example.org/org#Organization')!;
    // Still external, and tied to the imported ontology it belongs to; the local class is local.
    expect(org.external).toBe(back.externals[0].id);
    expect(back.terms.find((t) => t.name === 'Company')!.external).toBeUndefined();
    expect(toTurtle(back).split('\n\n').sort()).toEqual(ttl.split('\n\n').sort());
  });

  it('copies chosen entities with their definitions, as the model’s own from then on', () => {
    const w = withOrg();
    const member = w.org.model.terms.find((t) => t.name === 'Member')!;
    const result = copyEntities(w.get(), w.ref, w.org.model, { terms: [member.id], props: [] });
    expect(result).toMatchObject({ copied: 1, skipped: [], referenced: 3 });
    const copy = result.model.terms.find((t) => t.name === 'Member')!;
    // Its own IRI, its annotations, and not marked external: it is maintained here now.
    expect(copy).toMatchObject({ iri: 'http://example.org/org#Member', synonyms: 'Employee', fields: [{ key: 'skos:notation', value: 'M1' }] });
    expect(copy.external).toBeUndefined();
    expect(restrictionsOf(result.model, copy.id).map((r) => r.text)).toEqual(['member of some Organization']);
    // What it refers to but was not chosen is referred to, not copied.
    const person = result.model.terms.find((t) => t.iri === 'http://example.org/org#Person')!;
    expect(person.external).toBe(w.ref.id);
    expect(assertedSuperclasses(result.model, copy.id)).toEqual([person.id]);
    expect(result.model.props.find((p) => p.iri === 'http://example.org/org#memberOf')!.external).toBe(w.ref.id);
    const ttl = toTurtle(result.model);
    expect(block(ttl, 'org:Member')).toContain('rdfs:label "Member"@en');
    expect(block(ttl, 'org:Person')).toBe('org:Person a owl:Class .');
    // The model's own Person is another class and is left exactly as it was.
    expect(result.model.terms.find((t) => t.id === w.id.Person)).toBe(w.get().terms.find((t) => t.id === w.id.Person));
    // Copying again changes nothing.
    expect(copyEntities(result.model, w.ref, w.org.model, { terms: [member.id], props: [] })).toMatchObject({ copied: 0, skipped: ['http://example.org/org#Member'], model: result.model });
  });
});

describe('phase 3: mappings', () => {
  it('asserts a mapping as an ordinary axiom, in the direction given', () => {
    const w = withOrg();
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Person'), { now: 5000 })));
    w.set(ok(mp(w, w.local('Employee'), 'rdfs:subClassOf', w.use('Member'), { now: 5000 })));
    // The other way round is another statement: Organization is a kind of Company.
    w.set(ok(mp(w, w.use('Organization'), 'rdfs:subClassOf', w.local('Company'), { now: 5000 })));
    expect(says(w.get())).toEqual(['Person owl:equivalentClass Person', 'Employee rdfs:subClassOf Member', 'Organization rdfs:subClassOf Company']);
    const ttl = toTurtle(w.get());
    expect(block(ttl, ':Person')).toContain('owl:equivalentClass org:Person');
    expect(block(ttl, ':Employee')).toMatch(/rdfs:subClassOf :Person , .* , org:Member/);
    expect(block(ttl, 'org:Organization')).toBe('org:Organization a owl:Class ;\n    rdfs:subClassOf :Company .');
    expect(listMappings(w.get())[0].meta).toEqual({ source: 'http://example.org/studio#Person', predicate: 'owl:equivalentClass', target: 'http://example.org/org#Person', created: 5000, method: 'manual', status: 'proposed' });
  });

  it('allows several mappings for one entity and refuses repeats, in either direction when the predicate is symmetric', () => {
    const w = withOrg();
    const person = w.use('Person');
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', person)));
    w.set(ok(mp(w, w.local('Person'), 'rdfs:subClassOf', w.use('Agent'))));
    w.set(ok(mp(w, w.local('Person'), 'skos:closeMatch', w.use('Member'))));
    expect(says(w.get()).length).toBe(3);
    expect(mp(w, w.local('Person'), 'owl:equivalentClass', person).error).toBe('“Person” equivalent class “Person” is already stated.');
    expect(mp(w, person, 'owl:equivalentClass', w.local('Person')).error).toMatch(/already stated/);
    expect(mp(w, w.use('Member'), 'skos:closeMatch', w.local('Person')).error).toMatch(/already stated/);
    // A directed predicate the other way round is not a repeat.
    expect(mp(w, w.use('Agent'), 'rdfs:subClassOf', w.local('Person')).error).toBeUndefined();
    expect(says(w.get()).length).toBe(3);
  });

  it('only uses a predicate between kinds it is meant for, and says which would fit', () => {
    const w = withOrg();
    expect(mp(w, w.local('Person'), 'owl:sameAs', w.use('Person')).error).toBe('owl:sameAs is for individuals, not for classes. For classes use owl:equivalentClass, rdfs:subClassOf, owl:disjointWith, skos:exactMatch, skos:closeMatch, skos:broadMatch, skos:narrowMatch, skos:relatedMatch.');
    expect(mp(w, w.local('Pat'), 'owl:equivalentClass', w.use('Acme')).error).toMatch(/owl:equivalentClass is for classes, not for individuals/);
    expect(mp(w, w.local('Pat'), 'owl:sameAs', w.use('Person')).error).toBe('“Pat” is an individual and “Person” is a class. owl:sameAs relates two entities of the same kind.');
    expect(mp(w, w.local('Person'), 'owl:equivalentClass', w.local('Employee')).error).toMatch(/both entities of this ontology/);
    expect(mp(w, w.local('Person'), '', w.use('Person')).error).toBe('Choose how the two are related.');
    // Individuals and properties have their own.
    w.set(ok(mp(w, w.local('Pat'), 'owl:differentFrom', w.use('Acme'))));
    w.set(ok(mp(w, { kind: 'prop', id: 'works for' }, 'rdfs:subPropertyOf', w.use('member of'))));
    w.set(ok(mp(w, w.local('title'), 'owl:equivalentProperty', w.use('name'))));
    const ttl = toTurtle(w.get());
    expect(block(ttl, ':Pat')).toContain('owl:differentFrom org:acme');
    expect(block(ttl, ':worksFor')).toContain('rdfs:subPropertyOf org:memberOf');
    expect(block(ttl, ':title')).toContain('owl:equivalentProperty org:name');
    expect(mp(w, w.local('title'), 'owl:inverseOf', w.use('member of')).error).toBe('“title” is a data property and “member of” is an object property. owl:inverseOf relates two entities of the same kind.');
  });

  it('keeps OWL equivalence, sameAs and SKOS matches apart: only the OWL ones are reasoned with', () => {
    const w = withOrg();
    const base = w.get();
    const person = w.use('Person');
    const withStub = w.get();
    const pat = { ...withStub, relations: [...withStub.relations, newRelation({ from: w.id.Pat, to: w.id.Person, kind: 'generalization' })] };
    const equivalent = ok(addMapping(pat, w.local('Person'), 'owl:equivalentClass', person));
    const exact = ok(addMapping(pat, w.local('Person'), 'skos:exactMatch', person));
    const infers = (m: Model) => reason(m).inferences.map((i) => i.text);
    // Equivalent classes share their members: Pat is inferred to be an org:Person.
    expect(infers(equivalent)).toContain('“Pat” is an instance of “Person”');
    // An exact match is a statement about two concepts; nothing follows from it.
    expect(infers(exact)).toEqual(infers(pat));
    expect(block(toTurtle(exact), ':Person')).toContain('skos:exactMatch org:Person');
    expect(block(toTurtle(exact), ':Person')).not.toContain('owl:equivalentClass');
    expect(base.vocab.enabled).toBe(false);
    expect(exact.vocab.enabled).toBe(true);
    // In a concept scheme the OWL predicates mean nothing and are not offered.
    const scheme = { ...withStub, mode: 'skos' as const };
    expect(addMapping(scheme, w.local('Person'), 'owl:equivalentClass', person).error).toMatch(/This is a SKOS concept scheme/);
    const matched = ok(addMapping(scheme, w.local('Person'), 'skos:exactMatch', person));
    expect(toTurtle(matched)).toContain('skos:exactMatch org:Person');
    // The foreign concept is not put into this scheme.
    expect(block(toTurtle(matched), 'org:Person').trim()).toBe('org:Person a skos:Concept .');
  });

  it('changes what is recorded about a mapping without touching the mapping, and removes exactly one', () => {
    const w = withOrg();
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Person'), { now: 1 })));
    w.set(ok(mp(w, w.local('Person'), 'rdfs:subClassOf', w.use('Agent'), { now: 1 })));
    const before = w.get();
    const reviewed = setMappingMeta(before, listMappings(before)[0], { status: 'approved', comment: 'Both classes represent persons.', author: 'yc' });
    expect(reviewed.relations).toBe(before.relations);
    expect(toTurtle(reviewed)).toBe(toTurtle(before));
    expect(listMappings(reviewed)[0].meta).toMatchObject({ status: 'approved', comment: 'Both classes represent persons.', author: 'yc', method: 'manual', created: 1 });
    const one = removeMapping(reviewed, listMappings(reviewed)[0]);
    expect(says(one)).toEqual(['Person rdfs:subClassOf Agent']);
    expect(one.mappings.length).toBe(1);
    // The external entity is still referred to; only the statement is gone.
    expect(one.terms.some((t) => t.iri === 'http://example.org/org#Person')).toBe(true);
  });

  it('exports the mappings alone, and reads them back without duplicates', () => {
    const w = withOrg();
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Person'), { now: Date.UTC(2026, 9, 11), comment: 'Both classes represent persons.', status: 'approved' })));
    w.set(ok(mp(w, w.use('Organization'), 'rdfs:subClassOf', w.local('Company'), { now: Date.UTC(2026, 9, 11) })));
    w.set(ok(mp(w, w.local('Employee'), 'skos:closeMatch', w.use('Member'), { now: Date.UTC(2026, 9, 11), method: 'suggested', score: 0.85 })));
    expect(mappingsToTurtle(w.get())).toBe(`@prefix : <http://example.org/studio#> .
@prefix org: <http://example.org/org#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .

:Person owl:equivalentClass org:Person .
org:Organization rdfs:subClassOf :Company .
:Employee skos:closeMatch org:Member .
`);
    const rich = mappingsToTurtle(w.get(), { metadata: true });
    expect(rich).toContain('owl:annotatedSource :Person ;\n    owl:annotatedProperty owl:equivalentClass ;\n    owl:annotatedTarget org:Person');
    expect(rich).toContain('rdfs:comment "Both classes represent persons."');
    expect(rich).toContain('cw:similarity 0.85');

    // Into a model that has the ontology in its library but none of the mappings.
    const fresh = withOrg();
    const lookup = (iri: string) => {
      const t = fresh.org.model.terms.find((x) => x.iri === iri);
      return t ? { name: t.name, type: t.type } : undefined;
    };
    const got = importMappings(fresh.get(), rich, lookup, 99);
    expect(got).toMatchObject({ added: 3, duplicates: 0, refused: [] });
    expect(says(got.model)).toEqual(says(w.get()));
    const meta = listMappings(got.model).map((m) => m.meta);
    expect(meta[0]).toMatchObject({ method: 'imported', status: 'approved', comment: 'Both classes represent persons.', created: Date.UTC(2026, 9, 11) });
    expect(meta[2]).toMatchObject({ score: 0.85 });
    expect(got.model.terms.find((t) => t.iri === 'http://example.org/org#Member')).toMatchObject({ name: 'Member', external: fresh.ref.id });
    expect(mappingsToTurtle(got.model)).toBe(mappingsToTurtle(w.get()));
    // Importing the same file again adds nothing.
    expect(importMappings(got.model, rich, lookup)).toMatchObject({ added: 0, duplicates: 3, model: got.model });
    // An IRI from an ontology that is not in the library is kept as a reference to an unknown one, never dropped.
    const foaf = importMappings(fresh.get(), '<http://example.org/studio#Person> <http://www.w3.org/2002/07/owl#equivalentClass> <http://xmlns.com/foaf/0.1/Person> .\n<http://a/x> <http://www.w3.org/2002/07/owl#sameAs> <http://b/y> .');
    expect(foaf).toMatchObject({ added: 1, refused: ['<http://a/x> owl:sameAs <http://b/y>: neither is an entity of this ontology'] });
    expect(foaf.model.terms.find((t) => t.iri === 'http://xmlns.com/foaf/0.1/Person')).toMatchObject({ external: '', type: 'concept', name: 'Person' });
    expect(mappingIssues(foaf.model).map((i) => i.message)).toEqual(['“Person” <http://xmlns.com/foaf/0.1/Person> belongs to an ontology that is not in the library, so the mapping cannot be checked against its definition.']);
  });
});

describe('phase 4: suggestions, validation and provenance', () => {
  it('suggests look-alikes with the reasons, and asserts nothing', () => {
    const w = withOrg();
    const before = w.get();
    const found = suggestMappings(before, w.org.model);
    expect(before).toBe(w.get());
    expect(listMappings(before)).toEqual([]);
    const line = (s: (typeof found)[number]) => `${s.local.name} ~ ${s.external.name} ${s.score}`;
    expect(found.map(line)).toEqual(['Person ~ Person 0.98', 'Employee ~ Member 0.89']);
    expect(found[0].features.map((f) => f.label)).toEqual(['same label “Person”', 'definitions share 40% of their words']);
    expect(found[1].features.map((f) => f.label)).toEqual(['“Employee” is an alternative label of one and the label of the other', 'both are directly under “Person”']);
    // Company and Organization have different names: no suggestion, and no objection either.
    expect(found.some((s) => s.local.name === 'Company')).toBe(false);
    // Kinds are respected: the data property "title" is not offered a class.
    expect(found.every((s) => s.local.kind === s.external.kind)).toBe(true);
  });

  it('leaves out what was turned down or is already mapped, and records where an accepted one came from', () => {
    const w = withOrg();
    const [first, second] = suggestMappings(w.get(), w.org.model);
    const rejected = { ...w.get(), rejected: [second.key] };
    expect(suggestMappings(rejected, w.org.model).map((s) => s.key)).toEqual([first.key]);
    const accepted = ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Person'), { method: 'suggested', score: first.score }));
    expect(listMappings(accepted)[0].meta).toMatchObject({ method: 'suggested', score: 0.98, status: 'proposed' });
    const mapped = new Set(listMappings(accepted).flatMap((m) => [`${m.source.iri}|${m.target.iri}`, `${m.target.iri}|${m.source.iri}`]));
    expect(suggestMappings(accepted, w.org.model, { mapped }).map((s) => s.local.name)).toEqual(['Employee']);
  });

  it('checks mappings with the reasoner, over the ontologies that are imported', () => {
    const w = withOrg(true);
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Person'))));
    w.set(ok(mp(w, w.local('Company'), 'owl:equivalentClass', w.use('Organization'))));
    // Different names, consistent logic: no objection of any kind.
    expect(mappingIssues(w.get())).toEqual([]);
    const loaded = new Map([[w.ref.id, w.org.model]]);
    expect(owlFindings(importsClosure(w.get(), loaded).model).summary).toMatchObject({ status: 'consistent', unsatisfiable: [] });
    // A Freelancer is both a Person and a Company. Here that is fine; the imported ontology says the two are disjoint.
    let n = ok(addIsA(ok(addIsA(w.get(), w.id.Freelancer, w.id.Person)), w.id.Freelancer, w.id.Company));
    expect(owlFindings(n).summary.unsatisfiable).toEqual([]);
    const closure = importsClosure(n, loaded);
    expect(closure.missing).toEqual([]);
    const found = owlFindings(closure.model);
    expect(found.summary).toMatchObject({ status: 'consistent', unsatisfiable: [w.id.Freelancer] });
    expect(found.findings[0].message).toMatch(/“Freelancer” can never have instances/);
    expect(found.findings[0].explanation).toContain('“Organization” is disjoint with “Person”');
    // Once something is a Freelancer the ontologies together are inconsistent.
    n = ok(addIsA(n, w.id.Pat, w.id.Freelancer));
    expect(owlFindings(importsClosure(n, loaded).model).summary.status).toBe('inconsistent');
    // The closure is worked out, never stored: the model itself has none of the other ontology's axioms.
    expect(n.terms.some((t) => t.name === 'Agent')).toBe(false);
    expect(toTurtle(n)).not.toContain('owl:disjointWith');
    // An import whose content is not at hand is named, not silently skipped.
    expect(importsClosure(n, new Map()).missing.map((e) => e.name)).toEqual(['Organization Ontology']);
    // Not imported: its axioms do not hold here, so nothing is concluded from them.
    const notImported = { ...n, externals: n.externals.map((e) => ({ ...e, imports: false })) };
    expect(owlFindings(importsClosure(notImported, loaded).model).summary.status).toBe('consistent');
  });

  it('points out mapping patterns worth a second look', () => {
    const w = withOrg();
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Person'))));
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Agent'))));
    w.set(ok(mp(w, w.local('Person'), 'rdfs:subClassOf', w.use('Agent'))));
    w.set(ok(mp(w, w.local('Person'), 'skos:exactMatch', w.use('Person'))));
    expect(mappingIssues(w.get()).map((i) => `${i.severity}: ${i.message}`)).toEqual([
      'warning: “Person” is stated to be equivalent class of “Person” and “Agent”, which are entities of one ontology. That makes them the same as each other, which that ontology may not intend.',
      'info: “Person” is stated to be both equivalent to and a subclass of “Agent”. The second follows from the first.',
      'info: “Person” and “Person” are mapped with both skos:exactMatch and owl:equivalentClass. These say different things: one is about concepts in a catalogue, the other is a logical statement a reasoner acts on.',
    ]);
  });
});

describe('persistence', () => {
  it('keeps references, mappings and their records in the file format and in My Models', async () => {
    const w = withOrg(true);
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Person'), { now: 7, comment: 'checked' })));
    const n = { ...w.get(), rejected: ['a|b'] };
    expect(normalizeModel(JSON.parse(JSON.stringify(n)))).toEqual(n);
    const { externals: _e, mappings: _m, rejected: _r, ...old } = JSON.parse(JSON.stringify(n));
    expect(normalizeModel(old)).toMatchObject({ externals: [], mappings: [], rejected: [] });
    const info = await saveModel(n);
    const back = (await loadModel(info.id))!.model;
    expect(back.externals).toEqual(n.externals);
    expect(says(back)).toEqual(['Person owl:equivalentClass Person']);
    expect(listMappings(back)[0].meta).toMatchObject({ comment: 'checked', created: 7 });
  });

  it('caches an external ontology’s content in the browser, and a missing cache loses no mapping', async () => {
    const w = withOrg();
    w.set(ok(mp(w, w.local('Person'), 'owl:equivalentClass', w.use('Person'))));
    await cacheOntology(w.ref.id, w.ref.iri, ORG);
    expect((await cachedOntology(w.ref.id))!.text).toBe(ORG);
    expect(readExternal((await cachedOntology(w.ref.id))!.text, 'org.ttl', 'file').ref.classes).toBe(4);
    expect((await cachedOntologyByIri('http://example.org/org'))!.id).toBe(w.ref.id);
    await uncacheOntology(w.ref.id);
    expect(await cachedOntology(w.ref.id)).toBeUndefined();
    // The content is gone from this browser; the reference and the mapping are in the model and stay.
    expect(w.get().externals.length).toBe(1);
    expect(says(w.get())).toEqual(['Person owl:equivalentClass Person']);
  });
});
