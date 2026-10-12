import { describe, expect, it } from 'vitest';
import { sampleModel } from './sample';
import { universitySample } from './sampleUniversity';
import { stressModel } from './stress';
import { DEFAULT_MAX_NODES, edgeTypes, extractSubgraph, searchTerms, type SubgraphOptions } from './subgraph';
import { emptyModel, newRelation, newTerm, type Model } from './types';

const film = sampleModel();
const id = (m: Model, name: string) => m.terms.find((t) => t.name === name)!.id;
const names = (m: Model, ids: Iterable<string>) => [...ids].map((x) => m.terms.find((t) => t.id === x)!.name).sort();
const opts = (m: Model, roots: string[], patch: Partial<SubgraphOptions> = {}): SubgraphOptions => ({
  roots: roots.map((n) => id(m, n)),
  depth: 1,
  direction: 'both',
  off: [],
  expanded: [],
  hidden: [],
  maxNodes: DEFAULT_MAX_NODES,
  ...patch,
});
const edges = (m: Model, rels: string[]) =>
  rels
    .map((rid) => m.relations.find((r) => r.id === rid)!)
    .map((r) => `${m.terms.find((t) => t.id === r.from)!.name}>${m.terms.find((t) => t.id === r.to)!.name}`)
    .sort();

describe('subgraph extraction', () => {
  it('shows only the roots at depth 0, with the relationships between them', () => {
    const one = extractSubgraph(film, opts(film, ['Film'], { depth: 0 }));
    expect(names(film, one.terms)).toEqual(['Film']);
    expect(one.rels).toEqual([]);
    expect(one.more.get(id(film, 'Film'))).toBe(9);
    const two = extractSubgraph(film, opts(film, ['Film', 'Genre'], { depth: 0 }));
    expect(names(film, two.terms)).toEqual(['Film', 'Genre']);
    expect(edges(film, two.rels)).toEqual(['Film>Genre']);
  });

  it('adds direct neighbours at depth 1 and theirs at depth 2', () => {
    const d1 = extractSubgraph(film, opts(film, ['Actor']));
    expect(names(film, d1.terms)).toEqual(['Actor', 'Film', 'Person']);
    expect(edges(film, d1.rels)).toEqual(['Actor>Film', 'Actor>Person']);
    expect(d1.via.get(id(film, 'Film'))).toBe(id(film, 'Actor'));
    const d2 = extractSubgraph(film, opts(film, ['Actor'], { depth: 2 }));
    expect(d2.terms).toHaveLength(11);
    // Edges between neighbours are included too, not only the ones that were walked.
    expect(edges(film, d2.rels)).toContain('Director>Film');
    expect(edges(film, d2.rels)).toContain('Director>Person');
    expect(d2.more.size).toBe(0);
  });

  it('keeps the roots first and each term once when neighbourhoods overlap', () => {
    const s = extractSubgraph(film, opts(film, ['Actor', 'Director']));
    expect(s.terms.slice(0, 2)).toEqual([id(film, 'Actor'), id(film, 'Director')]);
    expect(names(film, s.terms)).toEqual(['Actor', 'Director', 'Film', 'Person']);
    expect(new Set(s.rels).size).toBe(s.rels.length);
    expect(edges(film, s.rels)).toEqual(['Actor>Film', 'Actor>Person', 'Director>Film', 'Director>Person']);
  });

  it('follows the chosen direction only', () => {
    expect(names(film, extractSubgraph(film, opts(film, ['Film'], { direction: 'out' })).terms)).toEqual(['Award', 'Film', 'Genre', 'Release date', 'Running time']);
    expect(names(film, extractSubgraph(film, opts(film, ['Film'], { direction: 'in' })).terms)).toEqual(['Actor', 'Director', 'Documentary', 'Film', 'Parasite', 'Studio']);
    // Depth 2 outgoing from Actor: Actor -> Person, Actor -> Film -> (Genre, Award, data properties); never back up to Director.
    expect(names(film, extractSubgraph(film, opts(film, ['Actor'], { depth: 2, direction: 'out' })).terms)).not.toContain('Director');
  });

  it('names the relationship types of an ontology and filters by them', () => {
    expect(edgeTypes(film).map((t) => `${t.key}:${t.count}`)).toEqual(['rdfs:subClassOf:3', 'rdf:type:1', 'restriction:5', 'data:2']);
    const hierarchy = extractSubgraph(film, opts(film, ['Film'], { off: ['restriction', 'data', 'plain'] }));
    expect(names(film, hierarchy.terms)).toEqual(['Documentary', 'Film', 'Parasite']);
    const noData = extractSubgraph(film, opts(film, ['Film'], { off: ['data'] }));
    expect(names(film, noData.terms)).not.toContain('Release date');
    // A filtered-out type is not drawn even between terms that are both visible.
    const both = extractSubgraph(film, opts(film, ['Film', 'Genre'], { depth: 0, off: ['restriction'] }));
    expect(both.rels).toEqual([]);
    // Standard properties are types of their own.
    const uni = universitySample();
    expect(edgeTypes(uni).map((t) => t.key)).toEqual(['rdfs:subClassOf', 'rdf:type', 'restriction', 'data', 'fact', 'plain', 'owl:disjointWith']);
    const disjoint = extractSubgraph(uni, opts(uni, ['Person'], { off: edgeTypes(uni).map((t) => t.key).filter((k) => k !== 'owl:disjointWith') }));
    expect(names(uni, disjoint.terms)).toEqual(['Organisation', 'Person']);
  });

  it('terminates on cycles and self-relations', () => {
    const m = emptyModel();
    const [a, b, c] = ['A', 'B', 'C'].map((name) => newTerm({ name }));
    m.terms.push(a, b, c);
    m.relations.push(
      newRelation({ from: a.id, to: b.id, kind: 'generalization' }),
      newRelation({ from: b.id, to: c.id, kind: 'generalization' }),
      newRelation({ from: c.id, to: a.id, kind: 'generalization' }),
      newRelation({ from: a.id, to: a.id, label: 'self' }),
    );
    const s = extractSubgraph(m, opts(m, ['A'], { depth: 6 }));
    expect(names(m, s.terms)).toEqual(['A', 'B', 'C']);
    expect(s.rels).toHaveLength(4);
    expect(extractSubgraph(m, opts(m, ['A'], { depth: 99 })).terms).toHaveLength(3);
  });

  it('expands and collapses single terms without disturbing the rest', () => {
    const base = extractSubgraph(film, opts(film, ['Actor']));
    expect(base.more.get(id(film, 'Film'))).toBe(8);
    const grown = extractSubgraph(film, opts(film, ['Actor'], { expanded: [id(film, 'Film')] }));
    expect(grown.terms).toHaveLength(11);
    expect(grown.via.get(id(film, 'Genre'))).toBe(id(film, 'Film'));
    // The neighbours brought in by expanding are leaves: Person's other child stays out until asked for.
    const person = extractSubgraph(film, opts(film, ['Documentary'], { depth: 0, expanded: [id(film, 'Documentary')] }));
    expect(names(film, person.terms)).toEqual(['Documentary', 'Film']);
    expect(person.more.get(id(film, 'Film'))).toBe(8);
    const chain = extractSubgraph(film, opts(film, ['Documentary'], { depth: 0, expanded: [id(film, 'Documentary'), id(film, 'Film')] }));
    expect(chain.terms).toHaveLength(10);
    // Collapsing Film again removes only what nothing else needs: Person stays because of the root Actor.
    const two = extractSubgraph(film, opts(film, ['Actor', 'Documentary'], { expanded: [] }));
    expect(names(film, two.terms)).toEqual(['Actor', 'Documentary', 'Film', 'Person']);
  });

  it('leaves out hidden terms and does not walk through them', () => {
    const s = extractSubgraph(film, opts(film, ['Actor'], { depth: 2, hidden: [id(film, 'Film')] }));
    expect(names(film, s.terms)).toEqual(['Actor', 'Director', 'Person']);
    expect(s.more.get(id(film, 'Actor'))).toBeUndefined();
  });

  it('stops at the limit and says so', () => {
    const s = extractSubgraph(film, opts(film, ['Film'], { depth: 2, maxNodes: 4 }));
    expect(s.terms).toHaveLength(4);
    expect(s.truncated).toBe(true);
    expect(extractSubgraph(film, opts(film, ['Film'], { depth: 2 })).truncated).toBe(false);
    // Every relationship returned joins two visible terms.
    const visible = new Set(s.terms);
    expect(s.rels.every((rid) => visible.has(film.relations.find((r) => r.id === rid)!.from) && visible.has(film.relations.find((r) => r.id === rid)!.to))).toBe(true);
  });

  it('ignores roots that no longer exist and never changes the model', () => {
    const before = JSON.stringify(film);
    const s = extractSubgraph(film, { ...opts(film, ['Film']), roots: ['gone', id(film, 'Film'), id(film, 'Film')] });
    expect(s.terms[0]).toBe(id(film, 'Film'));
    expect(s.terms.filter((x) => x === id(film, 'Film'))).toHaveLength(1);
    expect(JSON.stringify(film)).toBe(before);
  });

  it('finds terms by name, synonym or IRI', () => {
    const m = structuredClone(film);
    m.terms.find((t) => t.name === 'Film')!.synonyms = 'Movie, Motion picture';
    m.terms.find((t) => t.name === 'Genre')!.iri = 'http://example.org/vocab#Category';
    expect(searchTerms(m, 'film').map((t) => t.name)).toEqual(['Film']);
    expect(searchTerms(m, 'movie').map((t) => t.name)).toEqual(['Film']);
    expect(searchTerms(m, 'vocab#cat').map((t) => t.name)).toEqual(['Genre']);
    expect(searchTerms(m, 'r').map((t) => t.name).slice(0, 3)).toEqual(['Release date', 'Running time', 'Actor']);
    expect(searchTerms(m, '  ')).toEqual([]);
  });

  it('stays fast on a large model', () => {
    const big = stressModel(1300);
    const roots = big.terms.slice(0, 5).map((t) => t.id);
    extractSubgraph(big, { roots, depth: 1, direction: 'both', off: [], expanded: [], hidden: [], maxNodes: 250 });
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      const s = extractSubgraph(big, { roots, depth: 2 + (i % 3), direction: 'both', off: [], expanded: [], hidden: [], maxNodes: 250 });
      expect(s.terms.length).toBeLessThanOrEqual(250);
    }
    // 50 extractions on 1,920 terms and 5,106 relationships.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
