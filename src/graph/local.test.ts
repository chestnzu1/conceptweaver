import { describe, expect, it } from 'vitest';
import { sampleModel } from '../model/sample';
import { ontologyRef } from '../structure/local';
import type { Model } from '../model/types';
import { createLocalGraphService } from './local';

const service = (model: () => Model, docId: string | null = null) => createLocalGraphService(() => ({ model: model(), docId }));

describe('the graph service over the model in the editor', () => {
  it('answers for the revision it was asked about, and nothing else', async () => {
    const m = sampleModel();
    const ref = ontologyRef(m, null);
    const s = service(() => m);
    const answer = await s.neighbourhood({ ...ref, roots: [m.terms[0].id], depth: 0, direction: 'both' });
    expect(answer.ontologyId).toBe('working-copy');
    expect(answer.revisionId).toBe(ref.revisionId);
    // A saved model is known by its own id.
    expect((await service(() => m, 'saved-1').kinds(ontologyRef(m, 'saved-1'))).ontologyId).toBe('saved-1');
    // Another name is another revision.
    const changed = { ...m, terms: m.terms.map((t, i) => (i ? t : { ...t, name: 'Someone' })) };
    const moved = service(() => changed);
    await expect(moved.kinds(ref)).rejects.toMatchObject({ code: 'stale-revision' });
  });

  it('walks out from the chosen terms and gives the answer as plain data', async () => {
    const m = sampleModel();
    const ref = ontologyRef(m, null);
    const film = m.terms.find((t) => t.name === 'Film')!.id;
    const parasite = m.terms.find((t) => t.name === 'Parasite')!.id;
    const answer = await service(() => m).neighbourhood({ ...ref, roots: [film, parasite], depth: 1, direction: 'both' });
    expect(answer.terms.slice(0, 2)).toEqual([film, parasite]);
    expect(answer.terms).toContain(m.terms.find((t) => t.name === 'Documentary')!.id);
    expect(answer.rels.length).toBeGreaterThan(0);
    // A map does not travel as JSON; the answer has plain objects.
    expect(answer.via).not.toBeInstanceOf(Map);
    expect(answer.more).not.toBeInstanceOf(Map);
    expect(Object.keys(answer.via).length).toBeGreaterThan(0);
    expect(Object.values(answer.via).every((id) => answer.terms.includes(id))).toBe(true);
    // Terms already shown are reached from where they were first met.
    expect(answer.via[parasite]).toBeUndefined();
  });

  it('shows the roots alone at depth 0, and cuts off at the limit', async () => {
    const m = sampleModel();
    const ref = ontologyRef(m, null);
    const film = m.terms.find((t) => t.name === 'Film')!.id;
    const s = service(() => m);
    expect((await s.neighbourhood({ ...ref, roots: [film], depth: 0, direction: 'both' })).terms).toEqual([film]);
    const cut = await s.neighbourhood({ ...ref, roots: [film], depth: 2, direction: 'both', maxNodes: 3 });
    expect(cut.terms).toHaveLength(3);
    expect(cut.truncated).toBe(true);
    // Nothing asked for shows the default number at most.
    expect(await s.neighbourhood({ ...ref, roots: [film], depth: 1, direction: 'both' })).toMatchObject({ truncated: false });
  });

  it('finds terms to start from by name, keeping out those already chosen', async () => {
    const m = sampleModel();
    const ref = ontologyRef(m, null);
    const found = await service(() => m).search({ ...ref, text: 'par', limit: 8 });
    expect(found.matches.map((x) => x.name)).toEqual(['Parasite']);
    expect(found.matches[0]).toMatchObject({ type: 'instance' });
    expect((await service(() => m).search({ ...ref, text: '   ' })).matches).toEqual([]);
  });

  it('lists the kinds of relationship there are to follow', async () => {
    const m = sampleModel();
    const kinds = (await service(() => m).kinds(ontologyRef(m, null))).kinds;
    expect(kinds.map((k) => k.key)).toEqual(expect.arrayContaining(['rdfs:subClassOf', 'rdf:type']));
    expect(kinds.find((k) => k.key === 'rdfs:subClassOf')!.count).toBeGreaterThan(0);
    expect(kinds.every((k) => k.count > 0 && k.label)).toBe(true);
  });
});
