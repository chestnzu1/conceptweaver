import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { entityAxioms } from '../editing/local';
import { withIris } from '../model/iri';
import { toTurtle } from '../model/rdf';
import { reason } from '../model/reasoner';
import { sampleModel } from '../model/sample';
import { useStore } from '../model/store';
import type { Model } from '../model/types';
import { revisionOf, WORKING_COPY } from '../structure/local';
import { compile, proposalInput, review, type Operation } from './proposals';
import { runReadTool, TOOL_BUDGET, type OntologyContext } from './tools';

/**
 * What the assistant reads of the ontology, and what it may propose: the tools over the example
 * model, and proposals compiled, checked and applied through the edit service.
 */

const NS = 'http://example.org/film-knowledge-graph#';
const film = () => withIris(sampleModel());
const ctx = (model: Model, more: Partial<OntologyContext> = {}): OntologyContext => ({ model, loadedImports: [], ...more });
const call = (c: OntologyContext, name: string, args: unknown = {}) => JSON.parse(runReadTool(name, args, c));

describe('the tools', () => {
  it('summarise the ontology without serialising it', () => {
    const s = call(ctx(film()), 'getOntologySummary');
    expect(s).toMatchObject({ name: 'Film knowledge graph', kind: 'OWL ontology', counts: { classes: 8, objectProperties: 5, individuals: 1 }, reasoning: 'not worked out for the ontology as it is now', validation: 'not run' });
    expect(s.topClasses.items.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['Film', 'Person', 'Genre']));
  });

  it('find entities, and give an entity’s details, what is stated apart from what is inferred', () => {
    const m = film();
    // The name first; then what says it in its description.
    const found = call(ctx(m), 'searchEntities', { query: 'film' }).results;
    expect(found[0]).toEqual({ name: 'Film', iri: NS + 'Film', kind: 'class' });
    expect(found).toContainEqual({ name: 'Documentary', iri: NS + 'Documentary', kind: 'class' });
    const d = call(ctx(m), 'getEntityDetails', { iri: NS + 'Film' });
    expect(d).toMatchObject({ iri: NS + 'Film', name: 'Film', kind: 'class', prefixedName: ':Film' });
    expect(d.asserted.axioms.items).toContain("Film SubClassOf 'belongs to' some Genre");
    expect(d.asserted.names).toContainEqual({ name: 'Genre', iri: NS + 'Genre' });
    expect(d.superclasses.inferred).toBe('not worked out yet');
    expect(d.subclasses.items).toEqual([{ name: 'Documentary', iri: NS + 'Documentary' }]);
    // With the reasoner's answer, what follows is told apart, with what it rests on.
    const r = reason(m, true);
    const actor = call(ctx(m, { reasoning: r }), 'getEntityDetails', { iri: ':Actor' });
    expect(actor.superclasses.asserted).toEqual([{ name: 'Person', iri: NS + 'Person' }]);
    expect(Array.isArray(actor.superclasses.inferred.items)).toBe(true);
  });

  it('never make up an entity, and say what is wrong with what they are asked', () => {
    const c = ctx(film());
    expect(call(c, 'getEntityDetails', { iri: NS + 'Spaceship' }).error).toMatch(/^There is no entity .* Use searchEntities/);
    expect(call(c, 'getEntityDetails', {}).error).toBe('“iri” is required.');
    expect(call(c, 'searchEntities', { query: 'x', colour: 'red' }).error).toBe('There is no argument “colour”.');
    expect(call(c, 'getClassHierarchy', { iri: NS + 'directs' }).error).toMatch(/not a class/);
    expect(call(c, 'teleport').error).toBe('There is no tool “teleport”.');
  });

  it('give the selection, a hierarchy, a property’s axioms, restrictions, imports and validation', () => {
    const m = film();
    expect(call(ctx(m), 'getSelectedEntity')).toMatchObject({ selected: null });
    expect(call(ctx(m, { selected: NS + 'Actor' }), 'getSelectedEntity').selected).toMatchObject({ name: 'Actor', kind: 'class' });
    const h = call(ctx(m), 'getClassHierarchy', { iri: NS + 'Person', depth: 2 });
    expect(h.asserted.descendants.subclasses.map((x: { name: string }) => x.name).sort()).toEqual(['Actor', 'Director']);
    expect(call(ctx(m), 'getPropertyAxioms', { iri: NS + 'directs' }).asserted.axioms.items).toEqual(expect.arrayContaining(['directs Domain Director', 'directs Range Film']));
    expect(call(ctx(m), 'getRestrictions', { iri: NS + 'Film' })).toMatchObject({ asserted: { items: expect.arrayContaining(["Film SubClassOf 'belongs to' some Genre"]) }, inherited: 'not worked out yet' });
    expect(call(ctx(m), 'getImports').imports).toEqual([]);
    expect(call(ctx(m), 'getValidationResults').status).toMatch(/has not been run/);
  });

  it('answer within their budget on a large ontology', () => {
    const m = film();
    const many: Model = { ...m, terms: [...m.terms, ...Array.from({ length: 3000 }, (_x, i) => ({ ...m.terms[0], id: `x${i}`, name: `Film kind ${i}`, iri: `${NS}FilmKind${i}` }))] };
    for (const [name, args] of [['getOntologySummary', {}], ['searchEntities', { query: 'film', limit: 25 }], ['getClassHierarchy', { iri: NS + 'Film', depth: 3 }]] as const) {
      expect(runReadTool(name, args, ctx(many)).length).toBeLessThanOrEqual(TOOL_BUDGET);
    }
    expect(call(ctx(many), 'searchEntities', { query: 'film', limit: 25 }).total).toBeGreaterThan(3000);
  });
});

describe('a proposal', () => {
  const ops = (...o: Operation[]) => o;
  it('is compiled into axioms by IRI, with what it declares named, and intersections kept intersections', () => {
    const m = film();
    const { changes, errors, declared } = compile(
      m,
      ops(
        { action: 'add', type: 'declare', entityKind: 'class', name: 'Short film' },
        { action: 'add', type: 'subClassOf', subject: "'Short film'", expression: 'Film' },
        { action: 'add', type: 'equivalentClasses', subject: "'Short film'", expression: "Film and ('Running time' some xsd:integer[< 40])" },
        { action: 'add', type: 'domain', property: 'wins', expression: 'Film' },
        { action: 'add', type: 'domain', property: 'wins', expression: 'Person' },
      ),
    );
    expect(errors).toEqual([]);
    expect(declared).toEqual([{ name: 'Short film', iri: NS + 'ShortFilm', kind: 'class' }]);
    expect(changes.map((c) => c.axiom.type)).toEqual(['Declaration', 'AnnotationAssertion', 'SubClassOf', 'EquivalentClasses', 'ObjectPropertyDomain', 'ObjectPropertyDomain']);
    const eq = changes[3].axiom as { classes: { type: string }[] };
    expect(eq.classes[1].type).toBe('ObjectIntersectionOf');
  });

  it('says, operation by operation, what does not read: names that are not there, kinds that do not fit', () => {
    const { errors, changes } = compile(film(), ops({ action: 'add', type: 'subClassOf', subject: 'Spaceship', expression: 'Film' }, { action: 'add', type: 'domain', property: 'Film', expression: 'Person' }, { action: 'add', type: 'subClassOf', subject: 'Film', expression: 'Person and' }));
    expect(changes).toEqual([]);
    expect(errors[0]).toMatch(/^Operation 1 \(add subClassOf\): the subclass, “Spaceship”, does not read: /);
    expect(errors[1]).toBe('Operation 2 (add domain): Film is a class, not a property.');
    expect(errors[2]).toMatch(/^Operation 3 .* does not read/);
    expect(proposalInput({ summary: 'x', operations: [{ action: 'add', type: 'teleport' }] })).toBe('Operation 1: there is no type “teleport”.');
    expect(proposalInput({ summary: 'x', operations: [{ action: 'add', type: 'declare', colour: 'red' }] })).toBe('Operation 1 has a field “colour” that operations do not have.');
  });

  it('is reviewed: what it adds and removes, before and after, and what the reasoner then finds', async () => {
    const m = film();
    const r = await review(m, { summary: 'Documentaries are not films', operations: ops({ action: 'add', type: 'disjointClasses', subject: 'Documentary', expression: 'Film' }) });
    expect(r.errors).toEqual([]);
    expect(r.refusals).toEqual([]);
    expect(r.lines).toEqual([{ op: 'add', text: 'Documentary DisjointWith Film', about: { name: 'Documentary', iri: NS + 'Documentary' } }]);
    expect(r.affected[0].after).toContain('Documentary DisjointWith Film');
    expect(r.affected[0].before).not.toContain('Documentary DisjointWith Film');
    // A Documentary is a Film: disjoint from it, it can have no member.
    expect(r.logical).toMatchObject({ inconsistentAfter: false, newlyUnsatisfiable: [{ name: 'Documentary', iri: NS + 'Documentary' }] });
    expect(r.changeSet).toMatchObject({ ontologyId: WORKING_COPY, baseRevision: revisionOf(m) });
  });

  it('is refused when it removes what is not stated, and changes nothing until it is accepted', async () => {
    const m = film();
    const before = toTurtle(m);
    const r = await review(m, { summary: 'x', operations: ops({ action: 'remove', type: 'subClassOf', subject: 'Film', expression: 'Person' }) });
    expect(r.refusals).toEqual([{ kind: 'invalid', message: expect.stringMatching(/is not stated, so it cannot be removed/) }]);
    expect(r.changeSet).toBeUndefined();
    expect(toTurtle(m)).toBe(before);
  });

  it('takes an entity away with everything that names it', async () => {
    const m = film();
    const r = await review(m, { summary: 'No more awards', operations: ops({ action: 'remove', type: 'declare', subject: 'Award' }) });
    expect(r.refusals).toEqual([]);
    expect(r.lines.every((l) => l.op === 'remove')).toBe(true);
    expect(r.lines.map((l) => l.text)).toEqual(expect.arrayContaining(['Film SubClassOf wins some Award', 'wins Range Award']));
  });
});

describe('a proposal accepted', () => {
  const st = useStore.getState;
  beforeEach(() => st().replaceModel(film()));

  it('is applied as one edit, undone and redone, and refused once the ontology has moved on', async () => {
    const r = await review(st().model, { summary: 'Short films', operations: [{ action: 'add', type: 'declare', entityKind: 'class', name: 'Short film' }, { action: 'add', type: 'subClassOf', subject: "'Short film'", expression: 'Film' }] }, st().doc.id ?? WORKING_COPY);
    const stale = { ...r.changeSet! };
    await st().editService.apply(r.changeSet!);
    const short = st().model.terms.find((t) => t.name === 'Short film')!;
    expect(short.iri).toBe(NS + 'ShortFilm');
    expect(entityAxioms(st().model, NS + 'ShortFilm').map((a) => a.type)).toEqual(expect.arrayContaining(['Declaration', 'SubClassOf']));
    st().undo();
    expect(st().model.terms.some((t) => t.name === 'Short film')).toBe(false);
    st().redo();
    expect(st().model.terms.some((t) => t.name === 'Short film')).toBe(true);
    // Made for a revision the ontology has left: refused, not applied on top of what changed.
    await expect(st().editService.apply(stale)).rejects.toMatchObject({ code: 'stale-revision' });
  });
});
