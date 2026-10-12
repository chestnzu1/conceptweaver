import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { fromTurtle, toTurtle } from './rdf';
import { askReasoner, dlRequest, dlResult, type DlReport } from './reasoning';
import { newRelation, newTerm, type Model } from './types';
import { dlFindings, owlFindings } from './validation';

/**
 * The OWL 2 DL reasoner, asked for real: these start the reasoning service (HermiT) and put
 * ontologies to it. They need Java and the reasoner's libraries, and are skipped, saying so,
 * on a machine that has neither.
 */
const why = unavailable();
if (why) console.warn(`OWL 2 DL reasoning tests skipped: ${why}`);

const PREFIXES = `
  @prefix : <http://example.org/t#> .
  @prefix owl: <http://www.w3.org/2002/07/owl#> .
  @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
  <http://example.org/t> a owl:Ontology .`;

/** The case the app's own reasoner cannot see: a universal and an existential restriction that clash through a disjointness. */
const PARTY = `${PREFIXES}
  :PartyLocalProfile a owl:Class ;
      rdfs:subClassOf
          [ a owl:Restriction ; owl:onProperty :hasPreferredAddress ; owl:allValuesFrom :PhysicalAddress ] ,
          [ a owl:Restriction ; owl:onProperty :hasPreferredAddress ; owl:someValuesFrom :OrganisationLocalProfile ] .
  :OrganisationLocalProfile a owl:Class ;
      rdfs:subClassOf :PartyLocalProfile ;
      owl:disjointWith :PhysicalAddress .
  :PhysicalAddress a owl:Class .
  :hasPreferredAddress a owl:ObjectProperty .`;

const local = (iri: string) => iri.slice(iri.indexOf('#') + 1);
const locals = (iris: string[] = []) => iris.map(local).sort();

describe.skipIf(!!why)('OWL 2 DL reasoning with HermiT', () => {
  let service: Awaited<ReturnType<typeof startReasoner>>;
  beforeAll(async () => {
    service = await startReasoner({ port: 5197, quiet: true, log: () => {} });
  }, 120_000);
  afterAll(async () => {
    await service?.stop();
  });
  const ask = (ontology: string, imports: { iri: string; text: string }[] = []): Promise<DlReport> =>
    askReasoner(service.url, { ontology: ontology.includes('@prefix') ? ontology : PREFIXES + ontology, imports, timeoutMs: 30_000, explanations: { perSubject: 1, max: 25, timeoutMs: 15_000 } });
  const axioms = (r: DlReport, subject?: string) => r.explanations!.find((e) => (subject ? local(e.subject ?? '') === subject : !e.subject))!.justifications[0].axioms.map((a) => a.text);

  it('says which reasoner it is', () => {
    expect(service.health).toMatchObject({ engine: 'HermiT', engineVersion: '1.4.5.456', owlapi: '4.5.29' });
  });

  describe('the PartyLocalProfile case', () => {
    it('finds both classes unsatisfiable in an ontology that is still consistent', async () => {
      const r = await ask(PARTY);
      expect(r).toMatchObject({ engine: 'HermiT', status: 'complete', consistency: 'consistent', errors: [], warnings: [] });
      expect(r.profile).toMatchObject({ owl2dl: true, violationCount: 0, undeclaredCount: 0 });
      expect(locals(r.unsatisfiable)).toEqual(['OrganisationLocalProfile', 'PartyLocalProfile']);
      // An unsatisfiable class is a subclass of owl:Nothing; it has no place in the hierarchy of the classes that can have members.
      expect(r.subclasses).toEqual([]);
      // Why, as the reasoner's own justification: three asserted axioms, in Manchester syntax.
      expect(axioms(r, 'PartyLocalProfile')).toEqual([
        'OrganisationLocalProfile DisjointWith PhysicalAddress',
        'PartyLocalProfile SubClassOf hasPreferredAddress only PhysicalAddress',
        'PartyLocalProfile SubClassOf hasPreferredAddress some OrganisationLocalProfile',
      ]);
      expect(axioms(r, 'OrganisationLocalProfile')).toContain('OrganisationLocalProfile SubClassOf PartyLocalProfile');
      expect(r.explanations![0].justifications[0].axioms[0].entities.map((e) => [local(e.iri), e.kind])).toEqual([
        ['OrganisationLocalProfile', 'Class'],
        ['PhysicalAddress', 'Class'],
      ]);
    });

    it('is inconsistent as soon as something is an instance of the class', async () => {
      const r = await ask(PARTY + '\n:acme a owl:NamedIndividual , :PartyLocalProfile .');
      expect(r).toMatchObject({ status: 'complete', consistency: 'inconsistent' });
      // From a contradiction everything follows, so nothing is given as inferred.
      expect(r.unsatisfiable).toBeUndefined();
      expect(r.subclasses).toBeUndefined();
      expect(r.types).toBeUndefined();
      expect(axioms(r)).toEqual([
        'OrganisationLocalProfile DisjointWith PhysicalAddress',
        'PartyLocalProfile SubClassOf hasPreferredAddress only PhysicalAddress',
        'PartyLocalProfile SubClassOf hasPreferredAddress some OrganisationLocalProfile',
        'acme Type PartyLocalProfile',
      ]);
    });

    it('is found through the app: read from Turtle, written back, reasoned over, and pointed out on its entities', async () => {
      const model = fromTurtle(PARTY);
      const names = (ids: string[]) => ids.map((id) => model.terms.find((t) => t.id === id)!.name).sort();
      // The app's own reasoner does not see it, and does not claim to have proved anything.
      const fast = owlFindings(model, true);
      expect(fast.summary).toMatchObject({ engine: 'fast', status: 'consistent', proved: false, unsatisfiable: [] });

      const report = await askReasoner(service.url, dlRequest(model));
      const dl = dlFindings(model, report);
      expect(dl.summary).toMatchObject({ engine: 'dl', engineName: 'HermiT 1.4.5.456', status: 'consistent', proved: true, partial: false, contradictions: 0 });
      expect(names(dl.summary.unsatisfiable)).toEqual(['Organisation Local Profile', 'Party Local Profile']);
      expect(names(dl.result.unsatisfiableClasses)).toEqual(['Organisation Local Profile', 'Party Local Profile']);
      const found = dl.findings.filter((f) => f.ruleId === 'owl-unsatisfiable');
      expect(found.map((f) => [f.category, f.severity, f.entity?.name, f.engine])).toEqual([
        ['owl', 'error', 'Organisation Local Profile', 'HermiT 1.4.5.456'],
        ['owl', 'error', 'Party Local Profile', 'HermiT 1.4.5.456'],
      ]);
      const party = found.find((f) => f.entity?.name === 'Party Local Profile')!;
      expect(party.message).toBe('“Party Local Profile” can never have an instance: it is a subclass of owl:Nothing.');
      expect(party.justifications![0].map((a) => a.text)).toEqual([
        "'Organisation Local Profile' DisjointWith 'Physical Address'",
        "'Party Local Profile' SubClassOf 'has preferred address' only 'Physical Address'",
        "'Party Local Profile' SubClassOf 'has preferred address' some 'Organisation Local Profile'",
      ]);
      // Each axiom names entities of the model: classes as terms, the property as an object property.
      expect(party.justifications![0][1].entities.map((e) => [e.kind, e.name, e.type])).toEqual([
        ['term', 'Party Local Profile', 'class'],
        ['term', 'Physical Address', 'class'],
        ['prop', 'has preferred address', 'object property'],
      ]);
      expect(names(party.terms)).toEqual(['Organisation Local Profile', 'Party Local Profile', 'Physical Address']);

      // With an instance of the class the ontology is inconsistent, and nothing is inferred from it.
      const acme = newTerm({ name: 'Acme', type: 'instance' });
      const withInstance: Model = { ...model, terms: [...model.terms, acme], relations: [...model.relations, newRelation({ from: acme.id, to: model.terms.find((t) => t.name === 'Party Local Profile')!.id, kind: 'generalization' })] };
      const broken = dlFindings(withInstance, await askReasoner(service.url, dlRequest(withInstance)));
      expect(broken.summary).toMatchObject({ status: 'inconsistent', proved: false, contradictions: 1, unsatisfiable: [] });
      expect(broken.result).toMatchObject({ consistency: 'inconsistent', subclasses: [], types: [] });
      const clash = broken.findings.find((f) => f.ruleId === 'owl-inconsistent')!;
      expect(clash.entity).toMatchObject({ name: 'Acme', type: 'individual' });
      expect(clash.justifications![0].map((a) => a.text)).toContain("Acme Type 'Party Local Profile'");
    });
  });

  describe('class expressions and restrictions', () => {
    it('disjointness: a class under two disjoint classes has no members', async () => {
      const r = await ask(`
        :A a owl:Class ; owl:disjointWith :B . :B a owl:Class .
        :C a owl:Class ; rdfs:subClassOf :A , :B . :D a owl:Class ; rdfs:subClassOf :C .`);
      expect(r.consistency).toBe('consistent');
      expect(locals(r.unsatisfiable)).toEqual(['C', 'D']);
      expect((await ask(':A a owl:Class ; owl:disjointWith :B . :B a owl:Class . :x a owl:NamedIndividual , :A , :B .')).consistency).toBe('inconsistent');
    });

    it('existential and universal restrictions, and a range that the filler cannot meet', async () => {
      const r = await ask(`
        :p a owl:ObjectProperty ; rdfs:range :D .
        :B a owl:Class ; owl:disjointWith :D . :D a owl:Class .
        :A a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom :B ] .
        :E a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:allValuesFrom :B ] .`);
      // Some value in B is impossible; "only values in B" is not, as long as there is no value.
      expect(locals(r.unsatisfiable)).toEqual(['A']);
    });

    it('intersections: a class is what it is defined as, both ways', async () => {
      const r = await ask(`
        :Person a owl:Class . :Employed a owl:Class . :Retired a owl:Class ; owl:disjointWith :Employed .
        :Worker a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( :Person :Employed ) ] .
        :Odd a owl:Class ; rdfs:subClassOf [ a owl:Class ; owl:intersectionOf ( :Employed :Retired ) ] .
        :ann a owl:NamedIndividual , :Person , :Employed .`);
      expect(locals(r.unsatisfiable)).toEqual(['Odd']);
      expect(r.subclasses!.map((x) => `${local(x.sub)} < ${local(x.sup)}`).sort()).toEqual(['Worker < Employed', 'Worker < Person']);
      // Ann is a person and employed, so she is a worker, though nobody said so.
      expect(r.types!.map((x) => `${local(x.individual)}: ${local(x.class)}`)).toEqual(['ann: Worker']);
    });

    it('equivalent classes: a definition classifies what meets it', async () => {
      const r = await ask(`
        :hasChild a owl:ObjectProperty . :Person a owl:Class .
        :Parent a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( :Person [ a owl:Restriction ; owl:onProperty :hasChild ; owl:someValuesFrom :Person ] ) ] .
        :Mother a owl:Class ; rdfs:subClassOf :Person , [ a owl:Restriction ; owl:onProperty :hasChild ; owl:someValuesFrom :Person ] .
        :Human a owl:Class ; owl:equivalentClass :Person .`);
      expect(r.subclasses!.map((x) => `${local(x.sub)} < ${local(x.sup)}`).sort()).toContain('Mother < Parent');
      expect(r.equivalents!.map((g) => locals(g))).toEqual([['Human', 'Person']]);
    });

    it('unions and complements', async () => {
      const r = await ask(`
        :A a owl:Class . :B a owl:Class . :NotA a owl:Class ; owl:complementOf :A .
        :AorB a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:unionOf ( :A :B ) ] .
        :Neither a owl:Class ; rdfs:subClassOf :AorB , :NotA , [ a owl:Class ; owl:complementOf :B ] .
        :x a owl:NamedIndividual , :AorB , :NotA .`);
      expect(locals(r.unsatisfiable)).toEqual(['Neither']);
      // In A or B, and not in A: so in B. That needs the two cases.
      expect(r.types!.map((x) => `${local(x.individual)}: ${local(x.class)}`).sort()).toEqual(['x: B', 'x: NotA']);
    });

    it('cardinality restrictions that cannot hold together, and what a maximum makes the same', async () => {
      const r = await ask(`
        :p a owl:ObjectProperty . :B a owl:Class .
        :A a owl:Class ; rdfs:subClassOf
          [ a owl:Restriction ; owl:onProperty :p ; owl:minQualifiedCardinality "2"^^xsd:nonNegativeInteger ; owl:onClass :B ] ,
          [ a owl:Restriction ; owl:onProperty :p ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .
        :One a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .
        :x a owl:NamedIndividual , :One ; :p :y , :z . :y a owl:NamedIndividual . :z a owl:NamedIndividual .`);
      expect(locals(r.unsatisfiable)).toEqual(['A']);
      expect(r.same!.map((g) => locals(g))).toEqual([['y', 'z']]);
      const clash = await ask(`
        :p a owl:ObjectProperty , owl:FunctionalProperty .
        :x a owl:NamedIndividual ; :p :y , :z . :y a owl:NamedIndividual ; owl:differentFrom :z . :z a owl:NamedIndividual .`);
      expect(clash.consistency).toBe('inconsistent');
    });

    it('enumerations: counting the members, and trying each in turn', async () => {
      const r = await ask(`
        :p a owl:ObjectProperty . :Signal a owl:Class .
        :Color a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf ( :red :green ) ] .
        :red a owl:NamedIndividual , :Signal . :green a owl:NamedIndividual , :Signal .
        [] a owl:AllDifferent ; owl:distinctMembers ( :red :green ) .
        :Three a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:minQualifiedCardinality "3"^^xsd:nonNegativeInteger ; owl:onClass :Color ] .
        :lamp a owl:NamedIndividual , :Color ; owl:differentFrom :red .`);
      // Three different values out of an enumeration of two: the app's own reasoner does not count, this one does.
      expect(locals(r.unsatisfiable)).toEqual(['Three']);
      expect(r.subclasses!.map((x) => `${local(x.sub)} < ${local(x.sup)}`)).toContain('Color < Signal');
      expect(r.same!.map((g) => locals(g))).toEqual([['green', 'lamp']]);
      expect((await ask(':Color a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf ( :red ) ] . :red a owl:NamedIndividual . :x a owl:NamedIndividual , :Color ; owl:differentFrom :red .')).consistency).toBe('inconsistent');
    });

    it('hasValue and data ranges', async () => {
      const r = await ask(`
        :p a owl:ObjectProperty . :age a owl:DatatypeProperty , owl:FunctionalProperty ; rdfs:range xsd:integer .
        :status a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:oneOf ( "on" "off" ) ] .
        :Friend a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty :p ; owl:hasValue :bob ] .
        :Adult a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty :age ; owl:someValuesFrom [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:minInclusive 18 ] ) ] ] .
        :bob a owl:NamedIndividual ; :age 40 . :ann a owl:NamedIndividual ; :p :bob ; :age 12 .`);
      expect(r).toMatchObject({ status: 'complete', consistency: 'consistent' });
      expect(r.types!.map((x) => `${local(x.individual)}: ${local(x.class)}`).sort()).toEqual(['ann: Friend', 'bob: Adult']);
      expect((await ask(':status a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:oneOf ( "on" "off" ) ] . :lamp a owl:NamedIndividual ; :status "blinking" .')).consistency).toBe('inconsistent');
    });
  });

  describe('properties and individuals', () => {
    it('inverse, symmetric and transitive properties, sub-properties, domain and range', async () => {
      const r = await ask(`
        :Person a owl:Class . :Place a owl:Class .
        :hasChild a owl:ObjectProperty ; owl:inverseOf :hasParent ; rdfs:subPropertyOf :relatedTo ; rdfs:domain :Person .
        :hasParent a owl:ObjectProperty . :relatedTo a owl:ObjectProperty , owl:SymmetricProperty .
        :partOf a owl:ObjectProperty , owl:TransitiveProperty ; rdfs:range :Place .
        :ann a owl:NamedIndividual ; :hasChild :bob . :bob a owl:NamedIndividual .
        :room a owl:NamedIndividual ; :partOf :floor . :floor a owl:NamedIndividual ; :partOf :building . :building a owl:NamedIndividual .`);
      const facts = r.relations!.map((x) => `${local(x.subject)} ${local(x.property)} ${local(x.object)}`);
      expect(facts).toEqual(expect.arrayContaining(['bob hasParent ann', 'ann relatedTo bob', 'bob relatedTo ann', 'room partOf building']));
      expect(r.types!.map((x) => `${local(x.individual)}: ${local(x.class)}`).sort()).toEqual(['ann: Person', 'building: Place', 'floor: Place']);
    });

    it('individuals that contradict a class, a restriction, or each other', async () => {
      const cases = [
        ':A a owl:Class . :NotA a owl:Class ; owl:complementOf :A . :x a owl:NamedIndividual , :A , :NotA .',
        ':x a owl:NamedIndividual ; owl:sameAs :y ; owl:differentFrom :y . :y a owl:NamedIndividual .',
        ':p a owl:ObjectProperty . :B a owl:Class . :C a owl:Class ; owl:disjointWith :B . :A a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:allValuesFrom :B ] . :x a owl:NamedIndividual , :A ; :p :y . :y a owl:NamedIndividual , :C .',
        ':p a owl:ObjectProperty , owl:IrreflexiveProperty . :x a owl:NamedIndividual ; :p :x .',
      ];
      for (const c of cases) expect([c, (await ask(c)).consistency]).toEqual([c, 'inconsistent']);
      expect((await ask(':A a owl:Class . :x a owl:NamedIndividual , :A .')).consistency).toBe('consistent');
    });
  });

  describe('what it cannot or was not given to reason over', () => {
    it('refuses an ontology outside OWL 2 DL, and says where it is outside', async () => {
      const r = await ask(`
        :partOf a owl:ObjectProperty , owl:TransitiveProperty . :Whole a owl:Class .
        :Part a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :partOf ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .`);
      expect(r).toMatchObject({ status: 'failed', consistency: 'unknown' });
      expect(r.errors[0]).toMatch(/^HermiT cannot reason over this ontology: Non-simple property/);
      expect(r.profile).toMatchObject({ owl2dl: false, violationCount: 1 });
      expect(r.profile!.violations[0]).toMatchObject({ rule: 'Use of non-simple property in a restriction', text: 'Part SubClassOf partOf max 1 owl:Thing' });
      // No verdict, and nothing passed off as inferred.
      expect(r.unsatisfiable).toBeUndefined();
      expect(r.subclasses).toBeUndefined();
    });

    it('reasons past a datatype outside the OWL 2 datatype map, and says the result is partial', async () => {
      const r = await ask(':born a owl:DatatypeProperty ; rdfs:range xsd:date . :A a owl:Class ; owl:disjointWith :B . :B a owl:Class . :C a owl:Class ; rdfs:subClassOf :A , :B . :x a owl:NamedIndividual ; :born "2020-01-31"^^xsd:date .');
      expect(r).toMatchObject({ status: 'partial', consistency: 'consistent' });
      expect(r.warnings[0]).toMatch(/^xsd:date is not in the OWL 2 datatype map/);
      expect(locals(r.unsatisfiable)).toEqual(['C']);
    });

    it('takes the ontologies it imports from what it is given, and never fetches one', async () => {
      const main = `${PREFIXES.replace('a owl:Ontology .', 'a owl:Ontology ; owl:imports <http://example.org/other> .')}
        :C a owl:Class ; rdfs:subClassOf <http://example.org/other#A> , <http://example.org/other#B> .`;
      const other = '@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix o: <http://example.org/other#> . <http://example.org/other> a owl:Ontology . o:A a owl:Class ; owl:disjointWith o:B . o:B a owl:Class .';
      const withIt = await ask(main, [{ iri: 'http://example.org/other', text: other }]);
      expect(withIt).toMatchObject({ status: 'complete', consistency: 'consistent', imports: { resolved: ['http://example.org/other'], missing: [] } });
      expect(locals(withIt.unsatisfiable)).toEqual(['C']);
      const without = await ask(main);
      expect(without).toMatchObject({ status: 'partial', consistency: 'consistent', imports: { resolved: [], missing: ['http://example.org/other'] } });
      expect(without.unsatisfiable).toEqual([]);
      expect(without.warnings[0]).toBe('The imported ontology <http://example.org/other> was not available, so its axioms are not part of this result.');
    });

    it('says so when what it is given is not an ontology it can read', async () => {
      const r = await askReasoner(service.url, { ontology: ':A a owl:Class ; ;; nonsense', imports: [], timeoutMs: 10_000, explanations: { perSubject: 1, max: 5, timeoutMs: 5000 } });
      expect(r).toMatchObject({ status: 'failed', consistency: 'unknown' });
      expect(r.errors[0]).toMatch(/could not be read as OWL/);
    });

    it('answers only pages of this machine, unless told of another', async () => {
      const post = (origin: string) => fetch(service.url + '/reason', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: JSON.stringify({ ontology: PARTY }) });
      const here = await post('http://localhost:5180');
      expect([here.status, here.headers.get('access-control-allow-origin')]).toEqual([200, 'http://localhost:5180']);
      const elsewhere = await post('https://example.org');
      expect([elsewhere.status, elsewhere.headers.get('access-control-allow-origin')]).toEqual([403, null]);
    });
  });

  describe('the app’s own models', () => {
    it('writes an ontology the reasoner reads as it was meant: restrictions, lists and all', async () => {
      // Read by the app, written by the app, and the reasoner still finds what was in it.
      const source = `${PREFIXES}
        :p a owl:ObjectProperty . :B a owl:Class . :D a owl:Class ; owl:disjointWith :B .
        :Color a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf ( :red :green ) ] .
        :red a owl:NamedIndividual . :green a owl:NamedIndividual .
        :U a owl:Class ; rdfs:subClassOf [ a owl:Class ; owl:intersectionOf ( :B :D ) ] .
        :N a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom [ a owl:Class ; owl:intersectionOf ( :B :D ) ] ] .
        :K a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:minQualifiedCardinality "2"^^xsd:nonNegativeInteger ; owl:onClass :B ] , [ a owl:Restriction ; owl:onProperty :p ; owl:maxQualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onClass :B ] .`;
      const direct = await ask(source);
      const model = fromTurtle(source);
      const through = await askReasoner(service.url, dlRequest(model));
      expect(locals(direct.unsatisfiable)).toEqual(['K', 'N', 'U']);
      expect(locals(through.unsatisfiable)).toEqual(locals(direct.unsatisfiable));
      expect(through.consistency).toBe('consistent');
      // And once more through the app: nothing is lost on a second round either.
      expect(locals((await askReasoner(service.url, dlRequest(fromTurtle(toTurtle(model))))).unsatisfiable)).toEqual(['K', 'N', 'U']);
      const result = dlResult(model, through);
      expect(result.types.map((x) => [model.terms.find((t) => t.id === x.individual)!.name, model.terms.find((t) => t.id === x.class)!.name, x.asserted]).sort()).toEqual([
        ['green', 'Color', false],
        ['red', 'Color', false],
      ]);
    });
  });
});
