import { beforeEach, describe, expect, it } from 'vitest';
import { allowsView, configOf, MODEL_TYPE_LIST, MODEL_TYPES, supports, termTypeFor, viewFor } from './modelTypes';
import { offeredChoices, relChoice, relChoices } from './props';
import { fromTurtle, toTurtle } from './rdf';
import { createModel, useStore } from './store';
import { emptyModel, newRelation, newTerm, normalizeModel, type Model } from './types';

const vocabulary = (): Model => {
  const m = emptyModel('Glossary');
  m.mode = 'skos';
  m.baseIri = 'http://example.org/glossary#';
  m.terms = [newTerm({ id: 'a', name: 'Animal', iri: m.baseIri + 'Animal' }), newTerm({ id: 'd', name: 'Dog', iri: m.baseIri + 'Dog' }), newTerm({ id: 'b', name: 'Bone', iri: m.baseIri + 'Bone' })];
  m.relations = [newRelation({ id: 'r1', from: 'd', to: 'a', kind: 'generalization' }), newRelation({ id: 'r2', from: 'd', to: 'b', label: 'chews' })];
  return m;
};
const st = useStore.getState;

describe('types of model', () => {
  it('says in one place what each type of model has', () => {
    expect(MODEL_TYPE_LIST.map((t) => t.id)).toEqual(['ontology', 'skos']);
    const owl = MODEL_TYPES.ontology;
    const skos = MODEL_TYPES.skos;
    expect(owl.views).toEqual(['graph', 'table', 'hierarchy', 'checks', 'align', 'rdf', 'sparql', 'vocab']);
    expect(skos.views).toEqual(['graph', 'table', 'hierarchy']);
    expect(skos.entityTabs).toEqual(['concept', 'relations', 'governance']);
    expect(skos.entityColumns).toEqual(['name', 'iri', 'suffix', 'type']);
    expect(skos.editorSections).toEqual([]);
    expect(skos.termTypes).toEqual(['concept']);
    expect(skos.termType.concept.rdf).toBe('skos:Concept');
    expect(skos.relationKinds.map((k) => k.id)).toEqual(['plain', 'generalization']);
    expect(skos.hierarchy.predicate).toBe('skos:broader');
    expect(owl.hierarchy.predicate).toBe('rdfs:subClassOf');
    expect(skos.features).toEqual([]);
    // An ontology has no plain relationships: what a line is follows from what it joins and its name.
    expect(owl.relationKinds.map((k) => k.id)).toEqual(['object', 'generalization', 'instanceOf', 'property']);
    expect(owl.features).toContain('typedRelationships');
  });

  it('answers for a model by its type, and takes a model without one for an ontology', () => {
    const m = vocabulary();
    expect(configOf(m).label).toBe('SKOS-like vocabulary');
    expect(allowsView(m, 'checks')).toBe(false);
    expect(viewFor(m, 'rdf')).toBe('graph');
    expect(viewFor(m, 'hierarchy')).toBe('hierarchy');
    expect(supports(m, 'reasoning')).toBe(false);
    expect(termTypeFor(m, 'instance')).toBe('concept');
    // A model saved before there were types of model is an OWL ontology.
    const { mode: _, ...old } = JSON.parse(JSON.stringify(emptyModel('Old')));
    expect(normalizeModel(old).mode).toBe('ontology');
    expect(supports(normalizeModel(old), 'reasoning')).toBe(true);
    expect(termTypeFor(normalizeModel(old), 'instance')).toBe('instance');
  });

  it('offers a vocabulary plain relationships and “is a”, and nothing of OWL', () => {
    const m = vocabulary();
    expect(relChoices(m, m.relations[0]).map((c) => c.label)).toEqual(['Relationship (plain)', 'Is a (broader)']);
    expect(relChoice(m, m.relations[0])).toBe('generalization');
    expect(relChoice(m, m.relations[1])).toBe('plain');
    // Even where a property of that name is declared, as it can be in a model that was converted.
    const withProp = { ...m, props: [{ name: 'chews', description: '', chars: [] }] };
    expect(relChoice(withProp, m.relations[1])).toBe('plain');
    expect(offeredChoices(withProp, m.relations[1]).map((c) => c.value)).toEqual(['plain', 'generalization']);
  });

  describe('in the store', () => {
    beforeEach(() => st().replaceModel(vocabulary()));

    it('does not open a function the type of model does not have', () => {
      st().setView('hierarchy');
      expect(st().view).toBe('hierarchy');
      for (const view of ['checks', 'align', 'rdf', 'sparql', 'vocab'] as const) {
        st().setView(view);
        expect(st().view).toBe('hierarchy');
      }
    });

    it('leaves a view the next model does not have', () => {
      createModel({ name: 'Onto', mode: 'ontology' });
      st().setView('checks');
      expect(st().view).toBe('checks');
      st().replaceModel(vocabulary());
      expect(st().view).toBe('graph');
    });

    it('does not reason about, validate or restrict a vocabulary, whoever asks', async () => {
      st().setShowInferred(true);
      expect(st().showInferred).toBe(false);
      await st().runValidation('all');
      expect(st().validation.run).toBeNull();
      st().updateRelation('r2', { restriction: 'only', restrictionN: 2, kind: 'property', description: 'gnaws' });
      const r2 = st().model.relations.find((r) => r.id === 'r2')!;
      expect(r2).toMatchObject({ kind: 'association', description: 'gnaws' });
      expect(r2.restriction).toBeUndefined();
      expect(st().setRelChoice('r2', 'object')).toBe(false);
      expect(st().setRelChoice('r2', 'instanceOf')).toBe(false);
      expect(st().addProp()).toBe('');
      expect(st().model.props).toEqual([]);
      expect(st().setRelChoice('r2', 'generalization')).toBe(true);
      expect(st().model.relations.find((r) => r.id === 'r2')!.kind).toBe('generalization');
    });

    it('makes every new term a concept and keeps it one', () => {
      const id = st().addTerm({ name: 'Rex', type: 'instance' });
      expect(st().model.terms.find((t) => t.id === id)!.type).toBe('concept');
      st().updateTerm(id, { type: 'property', name: 'Rex the dog' });
      expect(st().model.terms.find((t) => t.id === id)).toMatchObject({ type: 'concept', name: 'Rex the dog' });
      st().updateTerms([id], { type: 'instance' });
      expect(st().model.terms.find((t) => t.id === id)!.type).toBe('concept');
    });

    it('creates a model of the type that was chosen, in the namespace that was given', () => {
      createModel({ name: 'Products', mode: 'skos', baseIri: 'http://example.org/products#', ontologyIri: 'http://example.org/products' });
      expect(st().model).toMatchObject({ name: 'Products', mode: 'skos', baseIri: 'http://example.org/products#', ontologyIri: 'http://example.org/products', terms: [] });
      const id = st().addTerm({ name: 'Garden hose' });
      expect(st().model.terms.find((t) => t.id === id)!.iri).toBe('http://example.org/products#GardenHose');
      // The name is a label; the IRI is the identity, and stays when the name changes.
      st().updateTerm(id, { name: 'Hose' });
      expect(st().model.terms.find((t) => t.id === id)!.iri).toBe('http://example.org/products#GardenHose');
    });
  });

  it('writes each type of model in its own vocabulary and reads it back as that type', () => {
    const skos = vocabulary();
    const ttl = toTurtle(skos);
    expect(ttl).toContain(':Dog a skos:Concept');
    expect(ttl).toContain('skos:prefLabel "Dog"');
    expect(ttl).toContain('skos:broader :Animal');
    expect(ttl).toContain('a skos:ConceptScheme');
    expect(ttl).toContain('skos:topConceptOf');
    expect(ttl).not.toMatch(/owl:Class|rdfs:subClassOf/);
    const back = fromTurtle(ttl);
    expect(back.mode).toBe('skos');
    expect(back.terms.map((t) => t.iri).sort()).toEqual(skos.terms.map((t) => t.iri).sort());
    expect(back.relations.filter((r) => r.kind === 'generalization')).toHaveLength(1);
    expect(toTurtle(back)).toBe(ttl);

    const owl = { ...vocabulary(), mode: 'ontology' as const };
    const owlTtl = toTurtle(owl);
    expect(owlTtl).toContain(':Dog a owl:Class');
    expect(owlTtl).toContain('rdfs:subClassOf :Animal');
    expect(owlTtl).not.toContain('skos:broader');
    expect(fromTurtle(owlTtl).mode).toBe('ontology');
  });
});
