import { describe, expect, it } from 'vitest';
import { patchEdges, patchNodeType } from './graphStyle';
import { htmlPage, LIGHT_TOKENS, viewerData } from './htmlExport';
import { withIris } from './iri';
import { toTurtle } from './rdf';
import { sampleModel, skosSample } from './sample';
import { normalizeModel, type Model } from './types';

const sample = (): Model => withIris(normalizeModel(JSON.parse(JSON.stringify(sampleModel()))));
const at = new Date('2026-10-12T09:00:00Z');

describe('the model as an interactive page', () => {
  it('boils the model down to what the page shows', () => {
    const m = sample();
    const film = m.terms.find((t) => t.name === 'Film')!;
    const studio = m.terms.find((t) => t.name === 'Studio')!;
    film.synonyms = 'Movie, Motion picture';
    film.fields = [
      { key: 'adms:status', value: 'Approved' },
      { key: 'dcterms:rightsHolder', value: studio.iri!, iri: true },
      { key: 'rdfs:seeAlso', value: 'https://example.org/films', iri: true },
      { key: 'Internal code', value: 'F-01' },
    ];
    const d = viewerData(m, at);
    expect(d.model).toMatchObject({ name: 'Film knowledge graph', type: 'OWL ontology', exported: '2026-10-12T09:00:00.000Z', partial: false });
    expect(d.terms).toHaveLength(m.terms.length);
    const f = d.terms.find((t) => t.name === 'Film')!;
    expect(f).toMatchObject({ kind: 'Class', type: 'concept', iri: film.iri, curie: ':Film', synonyms: ['Movie', 'Motion picture'] });
    // Its metadata by the names the registry gives it; an owner that is a term of the model is a link to it.
    expect(f.meta).toEqual([
      { label: 'Data owner', values: [{ text: 'Studio', ref: studio.id }] },
      { label: 'Lifecycle status', values: [{ text: 'Approved' }] },
      { label: 'rdfs:seeAlso', values: [{ text: 'https://example.org/films', href: 'https://example.org/films' }] },
      { label: 'Internal code', values: [{ text: 'F-01' }] },
    ]);
    // Relationships read as on the canvas, and say what kind of statement each is.
    const rel = (from: string, to: string) => d.rels.find((r) => r.from === m.terms.find((t) => t.name === from)!.id && r.to === m.terms.find((t) => t.name === to)!.id)!;
    expect(rel('Director', 'Film')).toMatchObject({ label: 'directs some', kind: 'restriction' });
    expect(rel('Actor', 'Person')).toMatchObject({ label: 'is a', kind: 'is a (rdfs:subClassOf)', hier: 'isa' });
    expect(rel('Parasite', 'Film')).toMatchObject({ label: 'Is Instance Of', hier: 'type' });
    expect(rel('Film', 'Award')).toMatchObject({ label: 'wins some', kind: 'restriction' });
    // A plain relationship, which a model from before can still hold, reads as one, with its cardinalities.
    const old = { ...m, props: m.props.filter((p) => p.name !== 'wins'), relations: m.relations.map((r) => (r.label === 'wins' ? { ...r, fromCard: '*', toCard: '0..*' } : r)) };
    expect(viewerData(old).rels.find((r) => r.label === 'wins')).toMatchObject({ kind: 'relationship', cards: '* to 0..*' });
    // What the page needs to draw a line again when a term is moved: the size and outline of each
    // term, and for each line how far it bows and how it ends.
    expect(f).toMatchObject({ w: 84, h: 40, shape: 'rect' });
    expect(rel('Director', 'Film')).toMatchObject({ bend: 0, head: 'filled' });
    expect(rel('Actor', 'Person')).toMatchObject({ bend: 0, head: 'hollow' });
    // The hierarchy is of the classes; individuals and data properties are listed apart.
    const name = (id: string) => d.terms.find((t) => t.id === id)!.name;
    expect(d.tree.roots.map(name)).toEqual(['Award', 'Film', 'Genre', 'Person', 'Studio']);
    expect(d.tree.children[m.terms.find((t) => t.name === 'Person')!.id].map(name)).toEqual(['Actor', 'Director']);
    expect(d.props.map((p) => p.name).sort()).toEqual(['acts in', 'belongs to', 'directs', 'produces', 'wins']);
    expect(d.props.find((p) => p.name === 'directs')).toMatchObject({ domain: ['Director'], range: ['Film'] });
    expect(d.props.find((p) => p.name === 'directs')!.uses).toHaveLength(1);
  });

  it('puts every term of a ring of classes in the hierarchy all the same', () => {
    const m = sample();
    const id = (n: string) => m.terms.find((t) => t.name === n)!.id;
    m.relations.push({ id: 'loop', from: id('Person'), to: id('Actor'), label: '', kind: 'generalization', description: '', fromCard: '', toCard: '' });
    const d = viewerData(m, at);
    const listed = new Set<string>();
    const walk = (x: string) => {
      if (listed.has(x)) return;
      listed.add(x);
      (d.tree.children[x] ?? []).forEach(walk);
    };
    d.tree.roots.forEach(walk);
    expect(listed.size).toBe(m.terms.filter((t) => t.type === 'concept').length);
  });

  it('speaks of a vocabulary in its own terms', () => {
    const d = viewerData(withIris(skosSample()), at);
    expect(d.model.type).toBe('SKOS-like vocabulary');
    expect(d.words).toMatchObject({ terms: 'Concepts', parent: 'broader concept', child: 'narrower concept' });
    expect(d.props).toEqual([]);
    expect(new Set(d.terms.map((t) => t.kind))).toEqual(new Set(['Concept']));
    expect(d.rels.some((r) => r.kind === 'is a (skos:broader)')).toBe(true);
  });

  it('is one file that fetches nothing, with the model in it as data and not as markup', () => {
    const m = sample();
    m.name = 'Films <b>&</b> "people"';
    m.description = 'Closes the script early? </script><script>window.pwned = 1</script>';
    m.terms[0].name = '<img src=x onerror=alert(1)>';
    const html = htmlPage(viewerData(m, at), '<svg viewBox="0 0 10 10"></svg>');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Films &lt;b&gt;&amp;&lt;/b&gt; &quot;people&quot;</title>');
    // Nothing of the model is in the page as a tag: within the data every "<" is written as an escape.
    const data = /<script type="application\/json" id="model-data">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(data).not.toContain('<');
    expect(JSON.parse(data).model.description).toBe(m.description);
    expect(JSON.parse(data).terms[0].name).toBe('<img src=x onerror=alert(1)>');
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).not.toMatch(/<img\b|onerror=alert\(1\)>\s*</);
    // No stylesheet, script, font or image from anywhere else.
    expect(html).not.toMatch(/<link\b|<script\b[^>]*\bsrc=|@import|url\(/i);
    expect(html).toContain('<svg viewBox="0 0 10 10"></svg>');
    expect(html).toContain(`--accent:${LIGHT_TOKENS.accent}`);
    // Without a picture it says so instead.
    expect(htmlPage(viewerData(m, at), '')).toContain('There is no picture of this model');
  });

  it('says how each line is drawn, as the style and the canvas have it', () => {
    const m = sample();
    const id = (n: string) => m.terms.find((t) => t.name === n)!.id;
    // A second line between the same two terms: the two fan out to either side.
    m.relations.push({ id: 'twin', from: id('Director'), to: id('Film'), label: 'admires', kind: 'association', description: '', fromCard: '', toCard: '', plain: true });
    const first = m.relations.find((r) => r.from === id('Director') && r.to === id('Film') && r.id !== 'twin')!;
    m.style = patchEdges(patchNodeType(m.style, 'individual', { shape: 'circle' }), [first.id], { curve: 30, arrow: 'open' });
    const d = viewerData(m, at, { inferred: [{ id: 'inferred:x', from: id('Parasite'), to: id('Award'), because: 'for the test' }] });
    const rel = (rid: string) => d.rels.find((r) => r.id === rid)!;
    expect(rel(first.id)).toMatchObject({ bend: -28 + 30, head: 'open' });
    expect(rel('twin')).toMatchObject({ bend: 28, head: 'filled' });
    expect(d.terms.find((t) => t.name === 'Parasite')!.shape).toBe('ellipse');
    // A class membership the reasoner worked out is listed when the picture has it, and marked as inferred.
    expect(rel('inferred:x')).toMatchObject({ label: 'Is Instance Of (inferred)', kind: 'inferred class membership', head: 'hollow', description: 'for the test' });
  });

  it('takes nothing from the model and adds nothing to it', () => {
    const m = { ...sample() };
    m.style = patchNodeType(m.style, 'class', { shape: 'hexagon' });
    const before = JSON.stringify(m);
    const ttl = toTurtle(m);
    htmlPage(viewerData(m, at, { shown: new Set([m.terms[0].id]) }), '');
    expect(JSON.stringify(m)).toBe(before);
    expect(toTurtle(m)).toBe(ttl);
    expect(viewerData(m, at, { shown: new Set([m.terms[0].id]) }).model.partial).toBe(true);
  });
});
