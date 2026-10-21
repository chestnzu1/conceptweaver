import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { fromTurtle, toTurtle } from '../model/rdf';
import type { Model } from '../model/types';
import { EditError, type Axiom, type ChangeSet, type Refusal } from './contracts';
import { createHttpEditService } from './http';
import { createLocalEditService } from './local';
import { revisionOf } from '../structure/local';

/**
 * The conformance suite of change sets (roadmap 3.5, AR-01): every fixture change set is run
 * through the local implementation and the companion over the same ontology, and the two agree —
 * the same acceptance, the same refusals in the same words, and, where applied, the same result
 * as axioms, compared by the companion's own /compare, which the frontend's suites already hold
 * to. One contract for edits, held to by both (src/editing/contracts.ts).
 *
 * These need the companion built and Java 21; set CONCEPTWEAVER_COMPANION_JAR to its jar to run
 * them, as reasoner/run.mjs starts it.
 */
const noCompanion = process.env.CONCEPTWEAVER_COMPANION_JAR ? unavailable() : 'The companion service is not built: set CONCEPTWEAVER_COMPANION_JAR to companion/target/companion-0.1.0-SNAPSHOT.jar.';

const S = 'http://example.org/edit#';
const cls = (name: string) => ({ type: 'Class' as const, iri: S + name });
const objProp = (name: string) => ({ type: 'ObjectProperty' as const, iri: S + name });
const dataProp = (name: string) => ({ type: 'DataProperty' as const, iri: S + name });
const ind = (name: string) => S + name;
const add = (axiom: Axiom) => ({ op: 'add' as const, axiom });
const remove = (axiom: Axiom) => ({ op: 'remove' as const, axiom });

/** The ontology every fixture change set is applied to. */
const DOCUMENT = `@prefix : <http://example.org/edit#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/edit> a owl:Ontology ; rdfs:label "Edit fixture" .
:Person a owl:Class ; rdfs:label "Person" .
:Organisation a owl:Class ; rdfs:label "Organisation" .
:Clerk a owl:Class ; rdfs:label "Clerk" ; rdfs:subClassOf :Person .
:Party a owl:Class ; rdfs:label "Party" .
:Person rdfs:subClassOf :Party .
:PartyLocalProfile a owl:Class ; rdfs:label "PartyLocalProfile" .
:hasLocalProfile a owl:ObjectProperty ; rdfs:label "hasLocalProfile" .
:worksFor a owl:ObjectProperty ; rdfs:label "worksFor" .
:employedBy a owl:ObjectProperty ; rdfs:label "employedBy" ; rdfs:subPropertyOf :worksFor .
:age a owl:DatatypeProperty ; rdfs:label "age" .
:alice a owl:NamedIndividual ; rdfs:label "Alice" ; a :Clerk .
:bob a owl:NamedIndividual ; rdfs:label "Bob" .
`;

/** Every fixture: a change set and the acceptance both implementations must agree on. */
const FIXTURES: { name: string; changes: ChangeSet['changes'] }[] = [
  { name: 'a class is declared', changes: [add({ type: 'Declaration', entity: 'Class', iri: S + 'NewClass' })] },
  { name: 'a subclass is added', changes: [add({ type: 'SubClassOf', sub: cls('Organisation'), sup: cls('Party') })] },
  { name: 'what is stated is not stated twice', changes: [add({ type: 'SubClassOf', sub: cls('Clerk'), sup: cls('Person') })] },
  { name: 'what is not stated cannot be removed', changes: [remove({ type: 'SubClassOf', sub: cls('Organisation'), sup: cls('Person') })] },
  { name: 'one change set does not change a statement twice', changes: [add({ type: 'SubClassOf', sub: cls('Organisation'), sup: cls('Party') }), add({ type: 'SubClassOf', sub: cls('Organisation'), sup: cls('Party') })] },
  { name: 'a class cannot be its own superclass', changes: [add({ type: 'SubClassOf', sub: cls('Person'), sup: cls('Person') })] },
  { name: 'a circular hierarchy is applied, and noted', changes: [add({ type: 'SubClassOf', sub: cls('Party'), sup: cls('Person') })] },
  { name: 'a subclass is removed', changes: [remove({ type: 'SubClassOf', sub: cls('Clerk'), sup: cls('Person') })] },
  { name: 'a restriction is added', changes: [add({ type: 'SubClassOf', sub: cls('Party'), sup: { type: 'ObjectSomeValuesFrom', property: objProp('hasLocalProfile'), filler: cls('PartyLocalProfile') } })] },
  { name: 'two classes are made disjoint', changes: [add({ type: 'DisjointClasses', classes: [cls('Person'), cls('Organisation')] })] },
  { name: 'a class cannot be disjoint with itself', changes: [add({ type: 'DisjointClasses', classes: [cls('Person'), cls('Person')] })] },
  { name: 'what a change set adds together is applied together', changes: [add({ type: 'DisjointClasses', classes: [cls('Person'), cls('Organisation')] }), add({ type: 'EquivalentClasses', classes: [cls('Person'), cls('Organisation')] })] },
  { name: 'an individual is made an instance', changes: [add({ type: 'ClassAssertion', class: cls('Party'), individual: ind('alice') })] },
  { name: 'a membership that is stated is not stated twice', changes: [add({ type: 'ClassAssertion', class: cls('Clerk'), individual: ind('alice') })] },
  { name: 'a fact is stated', changes: [add({ type: 'ObjectPropertyAssertion', property: S + 'worksFor', source: ind('alice'), target: ind('bob') })] },
  { name: 'a value is stated', changes: [add({ type: 'DataPropertyAssertion', property: S + 'age', source: ind('alice'), value: { value: '30' } })] },
  { name: 'a property is made a sub-property', changes: [add({ type: 'SubObjectPropertyOf', sub: S + 'employedBy', sup: S + 'hasLocalProfile' })] },
  { name: 'a property cannot be its own sub-property', changes: [add({ type: 'SubObjectPropertyOf', sub: S + 'worksFor', sup: S + 'worksFor' })] },
  { name: 'a property is made the inverse of another', changes: [add({ type: 'InverseObjectProperties', first: S + 'worksFor', second: S + 'employedBy' })] },
  { name: 'a property cannot be its own inverse', changes: [add({ type: 'InverseObjectProperties', first: S + 'worksFor', second: S + 'worksFor' })] },
  { name: 'two object properties are made equivalent', changes: [add({ type: 'EquivalentObjectProperties', properties: [S + 'worksFor', S + 'employedBy'] })] },
  { name: 'a characteristic is stated', changes: [add({ type: 'TransitiveObjectProperty', property: S + 'worksFor' })] },
  { name: 'a key is stated', changes: [add({ type: 'HasKey', class: S + 'Person', properties: [dataProp('age')] })] },
  { name: 'a range is stated', changes: [add({ type: 'DataPropertyRange', property: S + 'age', range: { type: 'Datatype', iri: 'http://www.w3.org/2001/XMLSchema#string' } })] },
  { name: 'an annotation is stated', changes: [add({ type: 'AnnotationAssertion', property: 'http://www.w3.org/2000/01/rdf-schema#comment', subject: S + 'Clerk', value: { value: 'A person who works.' } })] },
  { name: 'a declaration is taken away', changes: [remove({ type: 'Declaration', entity: 'Class', iri: S + 'PartyLocalProfile' })] },
  { name: 'a rename is a removal and an addition', changes: [remove({ type: 'AnnotationAssertion', property: 'http://www.w3.org/2000/01/rdf-schema#label', subject: S + 'Clerk', value: { value: 'Clerk' } }), add({ type: 'AnnotationAssertion', property: 'http://www.w3.org/2000/01/rdf-schema#label', subject: S + 'Clerk', value: { value: 'Office clerk' } })] },
];

/** What one side says of applying a fixture: the applied model, or the refusals. */
type Outcome = { ok: true; model: Model; notes: string[] } | { ok: false; refusals: Refusal[] };

describe.skipIf(!!noCompanion)('change sets against the companion', () => {
  let service: Awaited<ReturnType<typeof startReasoner>>;
  let ref: { ontologyId: string; revisionId: string };

  beforeAll(async () => {
    service = await startReasoner({ port: 5195, quiet: true, log: () => {} });
    expect(service.health).toMatchObject({ service: 'conceptweaver-reasoner', edits: true });
    ref = (await (await fetch(service.url + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: DOCUMENT }) })).json()) as { ontologyId: string; revisionId: string };
  }, 120_000);

  afterAll(async () => {
    await service?.stop();
  });

  /** Applies a fixture through the local implementation over a fresh model. */
  const locally = async (changes: ChangeSet['changes']): Promise<Outcome> => {
    const model = fromTurtle(DOCUMENT);
    let current = model;
    const local = createLocalEditService({ current: () => ({ model: current, ontologyId: ref.ontologyId }), commit: (next) => (current = next) });
    const cs: ChangeSet = { ontologyId: ref.ontologyId, baseRevision: revisionOf(model), changes, summary: 'From the conformance suite.' };
    try {
      const applied = await local.apply(cs);
      return { ok: true, model: current, notes: applied.notes };
    } catch (e) {
      if (e instanceof EditError) return { ok: false, refusals: e.refusals.length ? e.refusals : [{ code: 'invalid', message: e.message }] };
      throw e;
    }
  };

  /** Applies the same fixture through the companion, and answers with the new document where applied. */
  const remotely = async (changes: ChangeSet['changes']): Promise<{ ok: true; document: string; notes: string[] } | { ok: false; refusals: Refusal[] }> => {
    const remote = createHttpEditService(service.url + '/');
    const cs: ChangeSet = { ontologyId: ref.ontologyId, baseRevision: ref.revisionId, changes, summary: 'From the conformance suite.' };
    try {
      const applied = (await remote.apply(cs)) as unknown as { document: string; notes: string[] };
      return { ok: true, document: applied.document, notes: applied.notes };
    } catch (e) {
      if (e instanceof EditError) return { ok: false, refusals: e.refusals.length ? e.refusals : [{ code: 'invalid', message: e.message }] };
      throw e;
    }
  };

  it('accepts and refuses every fixture change set as the local implementation does, in the same words', async () => {
    for (const fixture of FIXTURES) {
      const [here, there] = [await locally(fixture.changes), await remotely(fixture.changes)];
      expect(there.ok, fixture.name).toBe(here.ok);
      if (!here.ok) {
        expect(there.ok, fixture.name).toBe(false);
        expect(there.ok ? [] : there.refusals, fixture.name).toEqual(here.refusals);
      }
      if (here.ok) expect(there.ok ? there.notes : [], fixture.name).toEqual(here.notes);
      if (here.ok) {
        expect(there.ok, fixture.name).toBe(true);
        // The result is the same axioms: the two documents are compared by the service's own /compare.
        const compared = (await (await fetch(service.url + '/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ original: toTurtle(here.model), exported: there.ok ? there.document : '' }) })).json()) as { removed: unknown[]; added: unknown[] };
        expect(compared.removed, fixture.name).toEqual([]);
        expect(compared.added, fixture.name).toEqual([]);
      }
    }
  });

  it('refuses a change set made against a revision it does not hold, and validates without changing anything', async () => {
    const remote = createHttpEditService(service.url + '/');
    const cs: ChangeSet = { ontologyId: ref.ontologyId, baseRevision: 'r0', changes: [add({ type: 'SubClassOf', sub: cls('Organisation'), sup: cls('Party') })], summary: '' };
    await expect(remote.apply(cs)).rejects.toMatchObject({ code: 'stale-revision', message: 'The ontology has moved on from revision r0.' });
    // Validation says what applying would do, and changes nothing: the same change set then applies.
    const verdict = await remote.validate({ ontologyId: ref.ontologyId, baseRevision: ref.revisionId, changes: [add({ type: 'SubClassOf', sub: cls('Organisation'), sup: cls('Party') })], summary: '' });
    expect(verdict.ok).toBe(true);
    expect((await remote.apply({ ontologyId: ref.ontologyId, baseRevision: ref.revisionId, changes: [add({ type: 'SubClassOf', sub: cls('Organisation'), sup: cls('Party') })], summary: '' })).revisionId).not.toBe(ref.revisionId);
    // What the service does not answer is said so.
    await expect(remote.entity({ ontologyId: ref.ontologyId, revisionId: ref.revisionId, iri: S + 'Clerk' })).rejects.toMatchObject({ code: 'unsupported' });
  });
});
