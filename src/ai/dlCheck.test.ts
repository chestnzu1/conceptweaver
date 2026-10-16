import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { withIris } from '../model/iri';
import { askReasoner, dlRequest } from '../model/reasoning';
import { sampleModel } from '../model/sample';
import { dlCheck, review } from './proposals';

/**
 * A proposal checked by the OWL 2 DL reasoner (HermiT, through the local service), where the fast
 * reasoner cannot follow it: a cardinality that leaves nothing for an existential to be. Needs
 * Java and the service's libraries; skipped, saying so, without.
 */

const why = unavailable();
if (why) console.warn(`DL checks of proposals skipped: ${why}`);
const NS = 'http://example.org/film-knowledge-graph#';

describe.skipIf(!!why)('a proposal checked by HermiT', () => {
  let service: Awaited<ReturnType<typeof startReasoner>>;
  beforeAll(async () => {
    service = await startReasoner({ port: 5175, quiet: true, log: () => {} });
  }, 120_000);
  afterAll(async () => {
    await service?.stop();
  });
  const ask = (url: string) => (m: Parameters<typeof dlRequest>[0]) => askReasoner(url, dlRequest(m, [], { justifications: 0 }));

  it('finds what the fast reasoner cannot: a cardinality that leaves a class nothing to be', async () => {
    const m = withIris(sampleModel());
    // Documentaries are films, and every film wins some award: one that wins none cannot be.
    const r = await review(m, { summary: 'Documentaries win nothing', operations: [{ action: 'add', type: 'subClassOf', subject: 'Documentary', expression: 'wins max 0 Award' }] });
    expect(r.refusals).toEqual([]);
    // The fast reasoner does not follow a maximum cardinality against an existential.
    expect(r.logical).toMatchObject({ inconsistentAfter: false, newlyUnsatisfiable: [] });
    const dl = await dlCheck(m, r.changeSet!, ask(service.url));
    // Partial: the example's release dates are xsd:date, which is not in OWL 2's datatype map; the reasoner says so.
    expect(dl).toMatchObject({ status: 'partial', before: 'consistent', after: 'consistent', engine: expect.stringMatching(/^HermiT/), warnings: [expect.stringMatching(/^xsd:date is not in the OWL 2 datatype map/)] });
    expect(dl.newlyUnsatisfiable).toEqual([{ name: 'Documentary', iri: NS + 'Documentary' }]);
    expect(dl.noLongerUnsatisfiable).toEqual([]);
  }, 60_000);

  it('finds the ontology made inconsistent where an individual is of the class it empties', async () => {
    const m = withIris(sampleModel());
    // Parasite is a film: films that win nothing contradict films that win something.
    const r = await review(m, { summary: 'Films win nothing', operations: [{ action: 'add', type: 'subClassOf', subject: 'Film', expression: 'wins max 0 Award' }] });
    expect(r.logical).toMatchObject({ inconsistentAfter: false });
    expect(await dlCheck(m, r.changeSet!, ask(service.url))).toMatchObject({ before: 'consistent', after: 'inconsistent' });
  }, 60_000);

  it('says it could not ask, rather than that all is well, when the service is not there', async () => {
    const m = withIris(sampleModel());
    const r = await review(m, { summary: 'x', operations: [{ action: 'add', type: 'subClassOf', subject: 'Genre', expression: 'Award' }] });
    const dl = await dlCheck(m, r.changeSet!, ask('http://127.0.0.1:5174'));
    expect(dl).toMatchObject({ status: 'failed', after: 'unknown', newlyUnsatisfiable: [], errors: [expect.stringMatching(/did not answer at http:\/\/127\.0\.0\.1:5174/)] });
  }, 60_000);
});
