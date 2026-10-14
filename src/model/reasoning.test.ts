import { describe, expect, it } from 'vitest';
import { withIris } from './iri';
import { askReasoner, DEFAULT_REASONER_URL, dlRequest, dlResult, ENGINES, readable, type DlReport } from './reasoning';
import { newProp, emptyModel, newRelation, newTerm, type Model } from './types';
import { dlFindings, MODEL_DATA, validate } from './validation';

/** An animal, a dog that is one, a puppy, and Rex. */
const kennel = (): Model => {
  const m = emptyModel('Kennel');
  m.baseIri = 'http://example.org/k#';
  m.terms = [
    newTerm({ id: 'animal', name: 'Animal' }),
    newTerm({ id: 'dog', name: 'Dog' }),
    newTerm({ id: 'puppy', name: 'Puppy' }),
    newTerm({ id: 'hound', name: 'Hound' }),
    newTerm({ id: 'rex', name: 'Rex', type: 'instance' }),
  ];
  m.relations = [newRelation({ id: 'r1', from: 'dog', to: 'animal', kind: 'generalization' }), newRelation({ id: 'r2', from: 'rex', to: 'puppy', kind: 'generalization' })];
  m.props = [newProp({ name: 'chases', description: '', chars: [] })];
  return withIris(m);
};
const K = 'http://example.org/k#';
const report = (over: Partial<DlReport> = {}): DlReport => ({ engine: 'HermiT', engineVersion: '1.4.5.456', status: 'complete', consistency: 'consistent', ms: 12, logicalAxioms: 4, errors: [], warnings: [], ...over });
const request = { ontology: '', imports: [], timeoutMs: 1000, explanations: { perSubject: 1, max: 5, timeoutMs: 1000 } };

describe('the two reasoning engines', () => {
  it('are told apart by what they can promise', () => {
    expect(ENGINES.map((e) => [e.id, e.label])).toEqual([
      ['fast', 'Fast reasoner (RDFS / partial OWL RL)'],
      ['dl', 'Advanced reasoner (OWL 2 DL)'],
    ]);
    expect(ENGINES[0].about).toContain('does not prove the ontology consistent');
    expect(DEFAULT_REASONER_URL).toBe('http://localhost:5190');
  });

  it('puts the ontology to the reasoner as it is exported, with what it imports beside it', () => {
    const r = dlRequest(kennel(), [{ iri: 'http://example.org/other', text: '# other' }]);
    expect(r.ontology).toContain(':Dog a owl:Class');
    expect(r.ontology).toContain('rdfs:subClassOf :Animal');
    expect(r.imports).toEqual([{ iri: 'http://example.org/other', text: '# other' }]);
    expect(r).toMatchObject({ timeoutMs: 60_000, explanations: { perSubject: 1 } });
  });
});

describe('asking the reasoning service', () => {
  it('reports a service that is not there as a failure, with how to start it, and never as a result', async () => {
    const r = await askReasoner('http://127.0.0.1:5190/', request, {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(r).toMatchObject({ status: 'failed', consistency: 'unknown', unreachable: true, url: 'http://127.0.0.1:5190' });
    expect(r.errors[0]).toBe('The reasoning service did not answer at http://127.0.0.1:5190. It is a Java program that runs beside the app: start it with “pnpm reasoner” (it needs Java 11 or later) and run the reasoning again.');
    expect(r.unsatisfiable).toBeUndefined();
  });

  it('does not take any other answer for a result', async () => {
    const page = await askReasoner(DEFAULT_REASONER_URL, request, { fetch: async () => new Response('<html>not found</html>', { status: 404 }) });
    expect(page).toMatchObject({ status: 'failed', consistency: 'unknown', unreachable: false });
    expect(page.errors[0]).toBe('What answered at http://localhost:5190 is not the reasoning service (HTTP 404).');
    const other = await askReasoner(DEFAULT_REASONER_URL, request, { fetch: async () => new Response(JSON.stringify({ ok: true })) });
    expect(other).toMatchObject({ status: 'failed', consistency: 'unknown' });
  });

  it('passes on what the service says, with how long the round trip took', async () => {
    let sent: { url: string; body: string; type: string } | undefined;
    const r = await askReasoner(DEFAULT_REASONER_URL, request, {
      fetch: async (url, init) => {
        sent = { url: String(url), body: String(init?.body), type: new Headers(init?.headers).get('Content-Type') ?? '' };
        return new Response(JSON.stringify(report({ unsatisfiable: [K + 'Puppy'] })));
      },
    });
    expect(sent).toMatchObject({ url: 'http://localhost:5190/reason', type: 'text/plain;charset=UTF-8' });
    expect(JSON.parse(sent!.body)).toEqual(request);
    expect(r).toMatchObject({ status: 'complete', consistency: 'consistent', unsatisfiable: [K + 'Puppy'], url: 'http://localhost:5190' });
    expect(r.roundTripMs).toBeGreaterThanOrEqual(0);
  });
});

describe('a result in the terms of the model', () => {
  it('finds classes and individuals again by their IRI, and keeps what is stated apart from what is inferred', () => {
    const m = kennel();
    const r = dlResult(
      m,
      report({
        unsatisfiable: [K + 'Hound', 'http://elsewhere.org/Unknown'],
        subclasses: [
          { sub: K + 'Dog', sup: K + 'Animal' },
          { sub: K + 'Puppy', sup: K + 'Dog' },
          { sub: K + 'Puppy', sup: 'http://elsewhere.org/Unknown' },
        ],
        types: [{ individual: K + 'Rex', class: K + 'Puppy' }],
      }),
    );
    expect(r).toMatchObject({ engine: { id: 'dl', name: 'HermiT', version: '1.4.5.456' }, status: 'complete', consistency: 'consistent', proves: true });
    expect(r.unsatisfiableClasses).toEqual(['hound']);
    // Every step up, with which of them were stated and which are directly above.
    expect(r.subclasses).toEqual([
      { subclass: 'dog', superclass: 'animal', asserted: true, direct: true },
      { subclass: 'puppy', superclass: 'dog', asserted: false, direct: true },
      { subclass: 'puppy', superclass: 'animal', asserted: false, direct: false },
    ]);
    expect(r.types).toEqual([
      { individual: 'rex', class: 'puppy', asserted: true, direct: true },
      { individual: 'rex', class: 'dog', asserted: false, direct: false },
      { individual: 'rex', class: 'animal', asserted: false, direct: false },
    ]);
  });

  it('takes equivalent classes as each other’s superclasses', () => {
    const r = dlResult(kennel(), report({ equivalents: [[K + 'Dog', K + 'Hound']], subclasses: [{ sub: K + 'Dog', sup: K + 'Animal' }, { sub: K + 'Hound', sup: K + 'Animal' }] }));
    expect(r.equivalentClasses).toEqual([['dog', 'hound']]);
    expect(r.subclasses.filter((x) => x.subclass === 'hound').map((x) => x.superclass).sort()).toEqual(['animal', 'dog']);
  });

  it('gives nothing as inferred when the ontology is inconsistent or the reasoning failed', () => {
    const m = kennel();
    const broken = dlResult(m, report({ consistency: 'inconsistent', subclasses: [{ sub: K + 'Puppy', sup: K + 'Dog' }], unsatisfiable: [K + 'Hound'] }));
    expect(broken).toMatchObject({ consistency: 'inconsistent', unsatisfiableClasses: [], types: [] });
    expect(broken.subclasses.filter((x) => !x.asserted)).toEqual([]);
    expect(dlResult(m, report({ status: 'failed', consistency: 'unknown', errors: ['boom'] }))).toMatchObject({ status: 'failed', proves: false, unsatisfiableClasses: [], errors: ['boom'] });
    // Partial: reasoned, but not proved for all of the ontology.
    expect(dlResult(m, report({ status: 'partial' })).proves).toBe(false);
  });

  it('names what a message of the reasoner refers to by IRI', () => {
    const m = kennel();
    expect(readable(m, `Non-simple property '<${K}chases>' or its inverse appears in <${K}Dog> and <http://elsewhere.org/x>.`)).toBe('Non-simple property “chases” or its inverse appears in “Dog” and <http://elsewhere.org/x>.');
  });
});

describe('the OWL 2 DL reasoner in a validation run', () => {
  it('reports its findings as OWL findings, with its justifications and under its own name', async () => {
    const m = kennel();
    const answer = report({
      unsatisfiable: [K + 'Hound'],
      explanations: [{ kind: 'unsatisfiable', subject: K + 'Hound', justifications: [{ axioms: [{ text: 'Hound SubClassOf Dog and (not (Dog))', entities: [{ iri: K + 'Hound', kind: 'Class', name: 'Hound' }, { iri: K + 'Dog', kind: 'Class', name: 'Dog' }] }] }] }],
      profile: { owl2dl: true, violations: [], violationCount: 0, undeclared: ['skos:definition'], undeclaredCount: 1 },
    });
    const run = await validate(m, MODEL_DATA, 'owl', null, async () => {}, undefined, async () => answer);
    expect(run.owl).toMatchObject({ engine: 'dl', engineName: 'HermiT 1.4.5.456', status: 'consistent', proved: true, unsatisfiable: ['hound'], asserted: 4 });
    expect(run.owl!.notes).toEqual(['1 entity is used without being declared (skos:definition). Each was read as what its use implies, which changes no axiom.']);
    expect(run.dl!.report).toBe(answer);
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]).toMatchObject({ category: 'owl', severity: 'error', ruleId: 'owl-unsatisfiable', engine: 'HermiT 1.4.5.456', entity: { kind: 'term', id: 'hound', type: 'class' }, terms: ['hound', 'dog'] });
    expect(run.findings[0].justifications).toEqual([[{ text: 'Hound SubClassOf Dog and (not (Dog))', entities: [expect.objectContaining({ kind: 'term', id: 'hound' }), expect.objectContaining({ kind: 'term', id: 'dog' })] }]]);
    expect(run.findings[0].explanation).toBe('HermiT 1.4.5.456 derives this from one asserted axiom: Hound SubClassOf Dog and (not (Dog)).');
    // The app's own reasoner again: its answer replaces the other, and says whose it is.
    const fast = await validate(m, MODEL_DATA, 'owl', run);
    expect(fast.owl).toMatchObject({ engine: 'fast', engineName: 'Fast reasoner', status: 'consistent', proved: false });
    expect(fast.dl).toBeUndefined();
  });

  it('says there is no justification rather than making one up', () => {
    const m = kennel();
    const none = dlFindings(m, report({ unsatisfiable: [K + 'Hound'], explanations: [{ kind: 'unsatisfiable', subject: K + 'Hound', justifications: [], note: 'No justification was worked out in the time allowed for explanations.' }] })).findings[0];
    expect(none.justifications).toEqual([]);
    expect(none.justificationNote).toBe('No justification was worked out in the time allowed for explanations.');
    expect(none.explanation).toBeUndefined();
    expect(dlFindings(m, report({ unsatisfiable: [K + 'Hound'] })).findings[0].justificationNote).toBe('The reasoner was not asked for a justification of this.');
  });

  it('never reports a reasoning that failed as consistent', () => {
    const m = kennel();
    const down = dlFindings(m, { ...report({ status: 'failed', consistency: 'unknown', errors: ['The reasoning service did not answer at http://127.0.0.1:5190.'] }), unreachable: true });
    expect(down.summary).toMatchObject({ engine: 'dl', status: 'unknown', proved: false, unsatisfiable: [], errors: ['The reasoning service did not answer at http://127.0.0.1:5190.'] });
    expect(down.findings.map((f) => [f.rule, f.severity, f.entity?.type])).toEqual([['Reasoning did not finish', 'warning', 'ontology']]);
    // Outside OWL 2 DL: each violation is a finding on the entity it is about.
    const outside = dlFindings(m, report({ status: 'failed', consistency: 'unknown', errors: [`HermiT cannot reason over this ontology: Non-simple property '<${K}chases>' appears in a restriction.`], profile: { owl2dl: false, violationCount: 1, undeclared: [], undeclaredCount: 0, violations: [{ rule: 'Use of non-simple property in a restriction', text: 'Dog SubClassOf chases max 1 owl:Thing', entities: [{ iri: K + 'Dog', kind: 'Class', name: 'Dog' }, { iri: K + 'chases', kind: 'ObjectProperty', name: 'chases' }] }] } }));
    expect(outside.summary.status).toBe('unknown');
    expect(outside.summary.errors).toEqual(['HermiT cannot reason over this ontology: Non-simple property “chases” appears in a restriction.']);
    expect(outside.findings.map((f) => [f.ruleId, f.severity, f.entity?.name, f.message])).toEqual([
      ['dl-failed', 'warning', 'Kennel', 'HermiT cannot reason over this ontology: Non-simple property “chases” appears in a restriction.'],
      ['owl-profile', 'warning', 'Dog', 'Use of non-simple property in a restriction: Dog SubClassOf chases max 1 owl:Thing.'],
    ]);
  });
});
