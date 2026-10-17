import { reason } from './reasoner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { entailed } from './inferred';
import { fromTurtle, toTurtle, toTurtleWithInferred } from './rdf';
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

  describe('ELK, and the reasoner chosen by the ontology\'s profile (task 2.6)', () => {
    const askWith = (ontology: string, reasoner: 'auto' | 'hermit' | 'elk'): Promise<DlReport> =>
      askReasoner(service.url, { ontology: ontology.includes('@prefix') ? ontology : PREFIXES + ontology, imports: [], timeoutMs: 60_000, explanations: { perSubject: 0, max: 0, timeoutMs: 0 }, reasoner });
    const pairs = (r: DlReport) => (r.subclasses ?? []).map((p) => `${local(p.sub)} < ${local(p.sup)}`).sort();

    /**
     * An OWL 2 EL ontology generated for the test: a tree of 500 classes, a transitive part-of
     * property, existential restrictions on every tenth class, and defined classes that classify
     * what has a part of a kind; one class under two disjoint ones.
     */
    const generatedEl = () => {
      const lines = [':partOf a owl:ObjectProperty , owl:TransitiveProperty .', ':hasPart a owl:ObjectProperty .'];
      for (let i = 0; i < 500; i++) {
        lines.push(`:C${i} a owl:Class${i ? ` ; rdfs:subClassOf :C${Math.floor((i - 1) / 4)}` : ''} .`);
        if (i % 10 === 5) lines.push(`:C${i} rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :partOf ; owl:someValuesFrom :C${i - 5} ] .`);
      }
      for (let k = 0; k < 20; k++) lines.push(`:WithPart${k} a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( :C1 [ a owl:Restriction ; owl:onProperty :partOf ; owl:someValuesFrom :C${k} ] ) ] .`);
      lines.push(':Odd a owl:Class ; rdfs:subClassOf :C2 , :C3 .', ':C2 owl:disjointWith :C3 .', ':x a owl:NamedIndividual , :C45 .');
      return PREFIXES + lines.join('\n');
    };

    it('says which reasoners the service has', () => {
      expect(service.health).toMatchObject({ reasoners: [{ engine: 'HermiT', covers: 'OWL 2 DL' }, { engine: 'ELK', engineVersion: '0.6.0', covers: 'OWL 2 EL' }] });
    });

    it('chooses ELK for an ontology in OWL 2 EL, says why, and classifies it as HermiT does', async () => {
      const el = generatedEl();
      const byElk = await askWith(el, 'auto');
      expect(byElk).toMatchObject({ engine: 'ELK', engineVersion: '0.6.0', status: 'complete', consistency: 'consistent', choice: { requested: 'auto', reasoner: 'ELK', why: expect.stringMatching(/the ontology is in OWL 2 EL/) }, profile: { owl2el: true, elViolationCount: 0 } });
      const byHermit = await askWith(el, 'hermit');
      expect(byHermit).toMatchObject({ engine: 'HermiT', status: 'complete', choice: { requested: 'hermit', reasoner: 'HermiT' } });
      // Both complete for OWL 2 EL: the same hierarchy, the same unsatisfiable class, the same memberships.
      expect(pairs(byElk).length).toBeGreaterThan(500);
      expect(pairs(byElk)).toEqual(pairs(byHermit));
      expect(locals(byElk.unsatisfiable)).toEqual(['Odd']);
      expect(locals(byElk.unsatisfiable)).toEqual(locals(byHermit.unsatisfiable));
      expect((byElk.types ?? []).map((t) => local(t.class))).toEqual((byHermit.types ?? []).map((t) => local(t.class)));
    }, 120_000);

    it('chooses HermiT for an ontology outside OWL 2 EL, and says which axiom puts it outside', async () => {
      const r = await askWith(PARTY, 'auto');
      expect(r).toMatchObject({ engine: 'HermiT', status: 'complete', choice: { reasoner: 'HermiT', why: expect.stringMatching(/not in OWL 2 EL \(1 axiom outside it, first: .*only/) }, profile: { owl2el: false } });
      expect(locals(r.unsatisfiable)).toEqual(['OrganisationLocalProfile', 'PartyLocalProfile']);
    });

    it('asked of ELK directly, an ontology outside OWL 2 EL is answered as partial, with what ELK left out', async () => {
      const r = await askWith(PARTY, 'elk');
      expect(r).toMatchObject({ engine: 'ELK', status: 'partial', consistency: 'consistent' });
      expect(r.warnings[0]).toMatch(/^ELK covers OWL 2 EL and left out what it does not support/);
      expect(r.warnings.join(' ')).toMatch(/ObjectAllValuesFrom/);
      // What it left out is exactly why it misses what HermiT finds.
      expect(r.unsatisfiable).toEqual([]);
    });

    it('finds a contradiction in OWL 2 EL, and says that a justification is HermiT\'s', async () => {
      const r = await askWith(':A a owl:Class . :B a owl:Class . :A owl:disjointWith :B . :x a owl:NamedIndividual , :A , :B .', 'auto');
      expect(r).toMatchObject({ engine: 'ELK', status: 'complete', consistency: 'inconsistent' });
      expect(r.warnings).toContain('ELK found a contradiction, and gives no justification for it: ask HermiT to see why.');
    });

    it('refuses a reasoner it does not have', async () => {
      const r = await askWith(PARTY, 'fact' as 'elk');
      expect(r).toMatchObject({ status: 'failed', errors: ['There is no reasoner "fact": ask for hermit, elk or auto.'] });
    });

    it('is credited, through the app, to ELK and OWL 2 EL, with why it was chosen', async () => {
      const model = fromTurtle(generatedEl());
      const report = await askReasoner(service.url, dlRequest(model, [], { reasoner: 'auto', justifications: 0 }));
      const { summary, result } = dlFindings(model, report);
      expect(result.engine).toMatchObject({ name: 'ELK', version: '0.6.0', covers: 'OWL 2 EL', chosen: expect.stringMatching(/^Chosen automatically/) });
      expect(summary).toMatchObject({ engineName: 'ELK 0.6.0', proved: true, profile: expect.stringMatching(/^OWL 2 EL, by ELK/), chosen: expect.stringMatching(/^Chosen automatically/) });
      const sub = model.terms.find((t) => t.name === 'C45' || t.iri?.endsWith('#C45'))!;
      expect(entailed(model, reason(model), result)).toBeTruthy();
      expect(result.subclasses.some((x) => x.subclass === sub.id)).toBe(true);
      const { creditOf } = await import('./reasoning');
      expect(creditOf(result)).toBe('Entailed, according to ELK 0.6.0 (OWL 2 EL).');
    }, 120_000);
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

  describe('relationships between individuals', () => {
    const N = 'http://example.org/test#';
    /** The example the missing inferences were reported with, as it was given. */
    const EXAMPLE = `
      @prefix : <${N}> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      :hasMember a owl:ObjectProperty .
      :isMemberOf a owl:ObjectProperty ; owl:inverseOf :hasMember .
      :John a owl:NamedIndividual ; :isMemberOf :CompanyA .
      :CompanyA a owl:NamedIndividual .`;
    const triples = (r: DlReport) => r.relations!.map((x) => `${local(x.subject)} ${local(x.property)} ${local(x.object)}`).sort();
    /** The same through the app: what it reads, writes, sends, and makes of the answer. */
    const through = async (turtle: string) => {
      const model = fromTurtle(turtle.includes('@prefix') ? turtle : PREFIXES + turtle);
      const result = dlResult(model, await askReasoner(service.url, dlRequest(model)));
      const name = (id: string) => model.terms.find((t) => t.id === id)!.name;
      // A relationship names its property by id, as the model knows it.
      const prop = (id: string) => model.props.find((p) => p.id === id)?.name ?? id;
      const said = (asserted: boolean) => result.relations.filter((x) => x.asserted === asserted).map((x) => `${name(x.subject)} ${prop(x.property)} ${name(x.object)}`).sort();
      return { model, result, stated: said(true), inferred: said(false) };
    };

    it('the example, put to HermiT as it is: the inverse relationship is entailed', async () => {
      const r = await askReasoner(service.url, { ontology: EXAMPLE, imports: [], timeoutMs: 30_000, explanations: { perSubject: 0, max: 0, timeoutMs: 0 } });
      expect(r).toMatchObject({ status: 'complete', consistency: 'consistent', errors: [] });
      expect(triples(r)).toEqual(['CompanyA hasMember John', 'John isMemberOf CompanyA']);
    });

    it('the example, through the app: the stated relationship is told apart from the one that follows', async () => {
      const { model, result, stated, inferred } = await through(EXAMPLE);
      expect(stated).toEqual(['John is member of Company A']);
      expect(inferred).toEqual(['Company A has member John']);
      // The one account both reasoners feed: there once, though both find it, and not what is stated.
      const fast = entailed(model, reason(model));
      const both = entailed(model, reason(model), result);
      expect(fast.facts.map((f) => f.id)).toEqual(both.facts.map((f) => f.id));
      expect(both.facts).toHaveLength(1);
      expect(both.by).toBe('HermiT 1.4.5.456 (OWL 2 DL)');
      expect(dlFindings(model, await askReasoner(service.url, dlRequest(model))).summary.inferred).toBe(1);
    });

    it('symmetric and transitive properties', async () => {
      const r = await through(`
        :knows a owl:ObjectProperty , owl:SymmetricProperty . :partOf a owl:ObjectProperty , owl:TransitiveProperty .
        :a a owl:NamedIndividual ; :knows :b ; :partOf :b . :b a owl:NamedIndividual ; :partOf :c . :c a owl:NamedIndividual ; :partOf :d . :d a owl:NamedIndividual .`);
      expect(r.inferred).toEqual(['a part of c', 'a part of d', 'b knows a', 'b part of d']);
      expect(r.stated).toEqual(['a knows b', 'a part of b', 'b part of c', 'c part of d']);
    });

    it('equivalent properties and sub-properties', async () => {
      const r = await through(`
        :employs a owl:ObjectProperty . :hasStaff a owl:ObjectProperty ; owl:equivalentProperty :employs .
        :relatedTo a owl:ObjectProperty . :parentOf a owl:ObjectProperty ; rdfs:subPropertyOf :relatedTo . :motherOf a owl:ObjectProperty ; rdfs:subPropertyOf :parentOf .
        :a a owl:NamedIndividual ; :employs :b ; :motherOf :c . :b a owl:NamedIndividual . :c a owl:NamedIndividual ; :hasStaff :d . :d a owl:NamedIndividual .`);
      expect(r.inferred).toEqual(['a has staff b', 'a parent of c', 'a related to c', 'c employs d']);
    });

    it('several individuals and assertions: each inferred relationship once, none that is stated', async () => {
      const r = await through(`
        :hasMember a owl:ObjectProperty . :isMemberOf a owl:ObjectProperty ; owl:inverseOf :hasMember . :knows a owl:ObjectProperty , owl:SymmetricProperty .
        :a a owl:NamedIndividual ; :isMemberOf :d ; :knows :b . :b a owl:NamedIndividual ; :isMemberOf :d ; :knows :a , :c . :c a owl:NamedIndividual ; :isMemberOf :d . :d a owl:NamedIndividual ; :hasMember :c .`);
      expect(r.inferred).toEqual(['c knows b', 'd has member a', 'd has member b']);
      expect(new Set(r.result.relations.map((x) => `${x.subject}|${x.property}|${x.object}`)).size).toBe(r.result.relations.length);
      // The app's own reasoner agrees on every one of them.
      expect(entailed(r.model, reason(r.model)).facts.map((f) => f.id).sort()).toEqual(entailed(r.model, reason(r.model), r.result).facts.map((f) => f.id).sort());
    });

    it('finds what the app’s own rules cannot: a relationship that follows from a class', async () => {
      // Every member of the staff works for Acme. Ann is one, so she does: that needs the restriction to be read.
      const r = await through(`
        :worksFor a owl:ObjectProperty . :acme a owl:NamedIndividual .
        :Staff a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :worksFor ; owl:hasValue :acme ] .
        :ann a owl:NamedIndividual , :Staff .`);
      expect(r.inferred).toEqual(['ann works for acme']);
      expect(entailed(r.model, reason(r.model)).facts).toEqual([]);
      const found = entailed(r.model, reason(r.model), r.result).facts;
      expect(found.map((f) => [f.name, f.because])).toEqual([['works for', 'Entailed, according to HermiT 1.4.5.456 (OWL 2 DL).']]);
    });

    it('written out with the inferred assertions, and read back, HermiT has nothing left to add', async () => {
      const { model, result } = await through(EXAMPLE);
      const found = entailed(model, reason(model), result);
      const ttl = toTurtleWithInferred(model, { types: found.memberships.map((x) => ({ individual: x.from, class: x.to })), facts: found.facts.map((x) => ({ from: x.from, prop: x.prop, to: x.to })), by: found.by });
      expect(ttl).toContain('# exported from. Worked out by HermiT 1.4.5.456 (OWL 2 DL) on');
      expect(ttl).toContain(':CompanyA :hasMember :John .');
      // The file is an ontology HermiT reads, in which the materialized triple is an assertion like the other.
      const again = await askReasoner(service.url, { ontology: ttl, imports: [], timeoutMs: 30_000, explanations: { perSubject: 0, max: 0, timeoutMs: 0 } });
      expect(again).toMatchObject({ status: 'complete', consistency: 'consistent' });
      expect(triples(again)).toEqual(['CompanyA hasMember John', 'John isMemberOf CompanyA']);
      const back = fromTurtle(ttl);
      const reread = dlResult(back, await askReasoner(service.url, dlRequest(back)));
      expect(reread.relations.map((x) => x.asserted)).toEqual([true, true]);
      expect(entailed(back, reason(back), reread).facts).toEqual([]);
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
