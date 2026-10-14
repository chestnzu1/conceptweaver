import { beforeEach, describe, expect, it } from 'vitest';
import { addValue } from './axioms';
import { parseRelations } from './bulk';
import { withIris } from './iri';
import { allowsKind, MODEL_TYPES } from './modelTypes';
import { isInstanceOf, kindsBetween, objectProperties, offeredChoices, plainRelationships, relChoice } from './props';
import { qualityDiagnostics } from './quality';
import { fromTurtle, toTurtle } from './rdf';
import { cannotRelate, endsForNew, IS_A, settleRelation } from './relating';
import { skosSample } from './sample';
import { useStore } from './store';
import { newProp, emptyModel, newRelation, newTerm, type Model, type Relation } from './types';

/** Classes, a data property and two individuals, and one object property that is there already. */
const studio = (): Model => {
  const m = emptyModel('Studio');
  m.baseIri = 'http://example.org/s#';
  m.terms = [
    newTerm({ id: 'film', name: 'Film' }),
    newTerm({ id: 'work', name: 'Work' }),
    newTerm({ id: 'award', name: 'Award' }),
    newTerm({ id: 'title', name: 'title', type: 'property', range: 'xsd:string' }),
    newTerm({ id: 'label', name: 'label', type: 'property' }),
    newTerm({ id: 'parasite', name: 'Parasite', type: 'instance' }),
    newTerm({ id: 'bong', name: 'Bong', type: 'instance' }),
  ];
  m.props = [newProp({ name: 'directed by', description: 'Who directed it.', chars: [] })];
  return withIris(m);
};
const st = useStore.getState;
const rel = (id: string): Relation => st().model.relations.find((r) => r.id === id)!;
const kind = (id: string) => relChoice(st().model, rel(id));
const props = () => st().model.props.map((p) => p.name).sort();
const block = (ttl: string, subject: string) => (ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '').replace(/\s+/g, ' ');
/** Draws a line the way the canvas does, and then names it as the label editor does. */
const draw = (from: string, to: string, name?: string): string => {
  const id = st().addRelation({ from, to });
  if (id && name !== undefined) st().updateRelation(id, { label: name }, false);
  return id;
};

beforeEach(() => {
  st().replaceModel(studio());
  useStore.setState({ toast: null });
});

describe('the kinds of relationship an ontology has', () => {
  it('has no plain relationship, and a vocabulary still has', () => {
    expect(MODEL_TYPES.ontology.relationKinds.map((k) => k.label)).toEqual(['Object property', 'Is a (generalization)', 'Is Instance Of', 'Has data property']);
    expect(allowsKind(studio(), 'plain')).toBe(false);
    expect(MODEL_TYPES.skos.relationKinds.map((k) => k.label)).toEqual(['Relationship (plain)', 'Is a (broader)']);
    expect(allowsKind(skosSample(), 'plain')).toBe(true);
  });

  it('offers for each pair of terms what a line between them can be', () => {
    const m = studio();
    const between = (from: string, to: string) => kindsBetween(m, { from, to });
    expect(between('film', 'work')).toEqual(['object', 'generalization']);
    expect(between('film', 'title')).toEqual(['property']);
    expect(between('title', 'film')).toEqual(['property']);
    expect(between('parasite', 'film')).toEqual(['instanceOf']);
    expect(between('parasite', 'bong')).toEqual(['object']);
    expect(between('title', 'label')).toEqual(['generalization']);
    expect(between('parasite', 'title')).toEqual([]);
  });

  it('refuses a plain relationship from whoever asks', () => {
    const id = draw('film', 'award', 'wins');
    expect(st().setRelChoice(id, 'plain')).toBe(false);
    expect(st().toast).toBe('An OWL ontology has no relationships of that kind.');
    expect(kind(id)).toBe('object');
  });
});

describe('a line between two classes', () => {
  it('is “is a” when it is called that, whatever the capitals', () => {
    for (const name of ['is a', 'Is A', 'IS AN', 'is-a']) {
      expect(IS_A.test(name)).toBe(true);
      st().replaceModel(studio());
      const id = draw('film', 'work', name);
      expect([name, kind(id), rel(id).kind, rel(id).label]).toEqual([name, 'generalization', 'generalization', '']);
      // The subclass is where the line starts, the superclass where it ends.
      expect(block(toTurtle(st().model), ':Film')).toContain('rdfs:subClassOf :Work');
      // Nothing was made of the name: no property called "is a".
      expect(props()).toEqual(['directed by']);
    }
  });

  it('uses the object property of any other name, declaring it if it is new', () => {
    const id = draw('film', 'award', 'wins');
    expect(kind(id)).toBe('object');
    expect(props()).toEqual(['directed by', 'wins']);
    expect(objectProperties(st().model).find((p) => p.name === 'wins')).toMatchObject({ domain: ['film'], range: ['award'] });
    const ttl = toTurtle(st().model);
    // As OWL has it: a property that is declared, and a class restricted by it. Not a triple from one class to the other.
    expect(block(ttl, ':wins')).toContain(':wins a owl:ObjectProperty');
    expect(block(ttl, ':Film')).toContain('rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :wins ; owl:someValuesFrom :Award ]');
    expect(ttl).not.toMatch(/:Film[^.]*\n?\s*:wins :Award/);
    expect(ttl).not.toContain('rdf:Property');
    expect(plainRelationships(st().model)).toEqual([]);
  });

  it('reuses the property that has the name already, as it is written there', () => {
    const id = draw('film', 'work', 'Directed By');
    expect(rel(id).label).toBe('directed by');
    expect(props()).toEqual(['directed by']);
    expect(objectProperties(st().model)[0].rels.map((r) => r.id)).toEqual([id]);
  });

  it('is a use of “related to” until it is given a name', () => {
    const id = st().addRelation({ from: 'film', to: 'award' });
    expect([kind(id), rel(id).label]).toEqual(['object', 'related to']);
    expect(props()).toEqual(['directed by', 'related to']);
    // Named, the property made for it goes with the name it had.
    st().updateRelation(id, { label: 'wins' });
    expect(props()).toEqual(['directed by', 'wins']);
  });

  it('follows its name when that is changed', () => {
    const id = draw('film', 'award', 'wins');
    // Another name: another property. The one made for the old name, of which nothing was said, is not left behind.
    st().updateRelation(id, { label: 'has won' });
    expect([kind(id), rel(id).label, props()]).toEqual(['object', 'has won', ['directed by', 'has won']]);
    // "is a": the first class is now a kind of the second, and what restricted it is gone.
    st().updateRelation(id, { restriction: 'only' });
    st().updateRelation(id, { label: 'is a' });
    expect([kind(id), rel(id).label, rel(id).restriction, props()]).toEqual(['generalization', '', undefined, ['directed by']]);
    // And back: a name on a superclass makes it an object property again.
    st().updateRelation(id, { label: 'honoured by' });
    expect([kind(id), rel(id).kind, rel(id).label, props()]).toEqual(['object', 'association', 'honoured by', ['directed by', 'honoured by']]);
    // A superclass whose name is taken away stays a superclass.
    st().updateRelation(id, { label: 'is a' });
    st().updateRelation(id, { label: '' });
    expect(kind(id)).toBe('generalization');
  });

  it('keeps a property that something was said about, or that another line uses', () => {
    const first = draw('film', 'work', 'directed by');
    st().updateRelation(first, { label: 'made by' });
    // It has a description: it was not made for this line alone.
    expect(props()).toEqual(['directed by', 'made by']);
    const second = draw('award', 'work', 'made by');
    st().updateRelation(first, { label: 'created by' });
    expect(props()).toEqual(['created by', 'directed by', 'made by']);
    expect(objectProperties(st().model).find((p) => p.name === 'made by')!.rels.map((r) => r.id)).toEqual([second]);
  });

  it('is settled the same way where its kind is chosen by hand', () => {
    const id = draw('film', 'award', 'wins');
    expect(st().setRelChoice(id, 'generalization')).toBe(true);
    expect([kind(id), rel(id).label]).toEqual(['generalization', '']);
    expect(st().setRelChoice(id, 'object')).toBe(true);
    expect([kind(id), rel(id).label]).toEqual(['object', 'related to']);
    for (const not of ['property', 'instanceOf'] as const) {
      expect(st().setRelChoice(id, not)).toBe(false);
      expect(kind(id)).toBe('object');
    }
    expect(offeredChoices(st().model, rel(id)).map((c) => c.label)).toEqual(['Object property', 'Is a (generalization)']);
  });
});

describe('a line between a class and a data property', () => {
  it('says the class has the property, whichever way it was drawn and whatever it was called', () => {
    for (const [from, to] of [['film', 'title'], ['title', 'film']]) {
      st().replaceModel(studio());
      const id = draw(from, to, 'whatever');
      expect([kind(id), rel(id).from, rel(id).to, rel(id).label]).toEqual(['property', 'film', 'title', '']);
      expect(st().toast).toBe('“Film” has the data property “title”, so it has no name of its own: “whatever” was not kept.');
      expect(offeredChoices(st().model, rel(id)).map((c) => c.label)).toEqual(['Has data property']);
      const ttl = toTurtle(st().model);
      // As the app has always written it: the class restricted by the property, and in its domain. No predicate of the app's own.
      expect(block(ttl, ':Film')).toContain('[ a owl:Restriction ; owl:onProperty :title ; owl:someValuesFrom xsd:string ]');
      expect(block(ttl, ':title')).toContain('rdfs:domain :Film');
      expect(ttl).not.toMatch(/hasDataProperty|has data property|rdf:Property/i);
    }
  });

  it('cannot be anything else, nor be turned around', () => {
    const id = draw('film', 'title');
    for (const not of ['object', 'generalization', 'instanceOf', 'plain'] as const) expect(st().setRelChoice(id, not)).toBe(false);
    st().reverseRelation(id);
    expect([rel(id).from, rel(id).to]).toEqual(['film', 'title']);
    expect(st().toast).toBe('“Has data property” always points from the class to the data property.');
  });
});

describe('an individual and a data property', () => {
  const WHY = '“Parasite” is an individual and “title” is a data property: the two are not joined by a line. An individual has a value for a data property. Open “Parasite” and add it under Data property assertions.';

  it('are not joined by a line, either way, and the reason is given', () => {
    expect(cannotRelate(studio(), 'parasite', 'title')).toBe(WHY);
    expect(cannotRelate(studio(), 'title', 'parasite')).toBe(WHY);
    for (const [from, to] of [['parasite', 'title'], ['title', 'parasite']]) {
      useStore.setState({ toast: null });
      expect(st().addRelation({ from, to })).toBe('');
      expect(st().addRelation({ from, to, kind: 'property' })).toBe('');
      expect(st().toast).toBe(WHY);
      expect(st().model.relations).toEqual([]);
    }
  });

  it('cannot be reached by moving an end of another line, or by a change of kind', () => {
    const id = draw('film', 'title');
    st().updateRelation(id, { from: 'parasite' });
    expect([rel(id).from, rel(id).to]).toEqual(['film', 'title']);
    expect(st().toast).toBe(WHY);
    // A model that has such a line from before: it is not made a "has data property" either.
    const old = { ...studio(), relations: [newRelation({ id: 'old', from: 'parasite', to: 'title', label: 'has' })] };
    st().replaceModel(old);
    expect(st().setRelChoice('old', 'property')).toBe(false);
    expect(st().toast).toBe(WHY);
    expect(settleRelation(old, 'old').error).toBe(WHY);
  });

  it('still go together as a value, given in the editor of the individual', () => {
    const edit = addValue(st().model, 'parasite', { prop: 'title', value: 'Gisaengchung', lang: 'ko' });
    expect(edit.error).toBeUndefined();
    expect(block(toTurtle(edit.model!), ':Parasite')).toContain(':title "Gisaengchung"@ko');
  });

  it('are pointed out where a model from before has such a line, with a way to take it out', () => {
    const old = { ...studio(), relations: [newRelation({ id: 'old', from: 'title', to: 'parasite', label: 'has' })] };
    const found = qualityDiagnostics(old).filter((d) => d.rule === 'property-kind');
    expect(found.map((d) => d.message)).toEqual(['“Parasite” is joined to the data property “title” by a line. In OWL an individual has a value for a data property; a line between the two says nothing.']);
    expect(found[0].fix!.apply(old).relations).toEqual([]);
  });
});

describe('the other pairs', () => {
  it('an individual and a class: the individual is an instance of the class, whichever way the line was drawn', () => {
    const id = draw('film', 'parasite');
    expect([kind(id), rel(id).from, rel(id).to, isInstanceOf(st().model, rel(id))]).toEqual(['instanceOf', 'parasite', 'film', true]);
    expect(block(toTurtle(st().model), ':Parasite')).toContain(':Parasite a owl:NamedIndividual , :Film');
    // Not twice.
    expect(st().addRelation({ from: 'parasite', to: 'film' })).toBe('');
    expect(st().toast).toBe('“Parasite” is already stated to be an instance of “Film”.');
  });

  it('two individuals: a fact that uses the object property of that name', () => {
    const id = draw('parasite', 'bong', 'directed by');
    expect(kind(id)).toBe('object');
    expect(block(toTurtle(st().model), ':Parasite')).toContain(':directedBy :Bong');
    const other = draw('bong', 'parasite', 'made');
    expect([kind(other), props()]).toEqual(['object', ['directed by', 'made']]);
  });

  it('two data properties: the first is a sub-property of the second', () => {
    const id = draw('title', 'label', 'narrower');
    expect([kind(id), rel(id).label]).toEqual(['generalization', '']);
    expect(block(toTurtle(st().model), ':title')).toContain('rdfs:subPropertyOf :label');
  });

  it('a line whose end is moved becomes what its new ends make it', () => {
    const id = draw('parasite', 'film');
    // From the individual to another class: still a membership. From a class to a class: a superclass.
    st().updateRelation(id, { to: 'work' });
    expect(kind(id)).toBe('instanceOf');
    st().updateRelation(id, { from: 'film' });
    expect([kind(id), rel(id).from, rel(id).to]).toEqual(['generalization', 'film', 'work']);
    // Onto a data property: the class has it.
    st().updateRelation(id, { to: 'title' });
    expect(kind(id)).toBe('property');
  });
});

describe('what the rules leave alone', () => {
  it('a relationship that stands for a standard property', () => {
    st().setVocabEnabled(true);
    const id = st().addRelation({ from: 'film', to: 'award', predicate: 'owl:disjointWith' });
    expect(rel(id)).toMatchObject({ kind: 'association', predicate: 'owl:disjointWith', label: '' });
    expect(props()).toEqual(['directed by']);
    expect(block(toTurtle(st().model), ':Film')).toContain('owl:disjointWith :Award');
    // It has no kind of its own to show, and can be given one.
    expect(offeredChoices(st().model, rel(id)).map((c) => `${c.label}${c.disabled ? ' (as it is)' : ''}`)).toEqual(['Standard property (owl:disjointWith) (as it is)', 'Object property', 'Is a (generalization)']);
  });

  it('a plain relationship that a model has from before, until it is given a kind', () => {
    const old = fromTurtle(`
      @prefix : <http://example.org/s#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      :Film a owl:Class ; :wins :Award . :Award a owl:Class . :wins a rdf:Property ; rdfs:label "wins" .`);
    st().replaceModel(old);
    const r = st().model.relations[0];
    expect([relChoice(st().model, r), plainRelationships(st().model).map((p) => p.name)]).toEqual(['plain', ['wins']]);
    // Shown as what it is, but not on offer: the kinds to choose from are the ontology's.
    expect(offeredChoices(st().model, r).map((c) => `${c.label}${c.disabled ? ' (as it is)' : ''}`)).toEqual(['Relationship (plain) (as it is)', 'Object property', 'Is a (generalization)']);
    expect(toTurtle(st().model)).toContain(':wins :Award');
    expect(st().setRelChoice(r.id, 'object')).toBe(true);
    expect(relChoice(st().model, rel(r.id))).toBe('object');
    expect(block(toTurtle(st().model), ':Film')).toContain('owl:onProperty :wins ; owl:someValuesFrom :Award');
  });

  it('a vocabulary: its relationships are what they were', () => {
    st().replaceModel(skosSample());
    const [a, b] = st().model.terms;
    const id = st().addRelation({ from: a.id, to: b.id });
    st().updateRelation(id, { label: 'is a' });
    expect(rel(id)).toMatchObject({ kind: 'association', label: 'is a' });
    expect(relChoice(st().model, rel(id))).toBe('plain');
    expect(st().model.props).toEqual([]);
    expect(st().setRelChoice(id, 'plain')).toBe(true);
    expect(cannotRelate(st().model, a.id, b.id)).toBeUndefined();
  });

  it('what is written is read back as the same thing', () => {
    draw('film', 'work', 'is a');
    draw('film', 'award', 'wins');
    draw('title', 'film');
    draw('parasite', 'film');
    draw('parasite', 'bong', 'directed by');
    const ttl = toTurtle(st().model);
    const back = fromTurtle(ttl);
    expect(toTurtle(back)).toBe(ttl);
    expect(back.relations.map((r) => relChoice(back, r)).sort()).toEqual(['generalization', 'instanceOf', 'object', 'object', 'property']);
    expect(plainRelationships(back)).toEqual([]);
  });
});

describe('relationships added in bulk', () => {
  it('become what their ends and names make them, and a line that cannot be is left out', () => {
    const { items } = parseRelations(['Film | is a | Work', 'Film | wins | Award', 'Film | has property | running time', 'Parasite | title', 'Documentary | Is A | Film'].join('\n'));
    const result = st().bulkAddRelations(items, true);
    expect(result).toEqual({ added: 4, created: 2, skipped: 1 });
    const m = st().model;
    const by = (from: string, to: string) => m.relations.find((r) => m.terms.find((t) => t.id === r.from)!.name === from && m.terms.find((t) => t.id === r.to)!.name === to)!;
    expect(relChoice(m, by('Film', 'Work'))).toBe('generalization');
    expect(relChoice(m, by('Documentary', 'Film'))).toBe('generalization');
    expect(relChoice(m, by('Film', 'Award'))).toBe('object');
    // What a class "has property" is made a data property, not another class.
    expect(m.terms.find((t) => t.name === 'running time')!.type).toBe('property');
    expect(relChoice(m, by('Film', 'running time'))).toBe('property');
    expect(props()).toEqual(['directed by', 'wins']);
    expect(plainRelationships(m)).toEqual([]);
  });
});

describe('a relationship added without saying between what', () => {
  /** The model that showed the fault: by name its first two terms are an individual and a data property. */
  const customers = (): Model => {
    const m = emptyModel('Customers');
    m.baseIri = 'http://example.org/c#';
    m.terms = [
      newTerm({ id: 'customer', name: 'Customer' }),
      newTerm({ id: 'person', name: 'Person' }),
      newTerm({ id: 'age', name: 'age', type: 'property', range: 'xsd:integer' }),
      newTerm({ id: 'active', name: 'Active', type: 'instance' }),
      newTerm({ id: 'blocked', name: 'Blocked', type: 'instance' }),
    ];
    return withIris(m);
  };
  const add = (selected: string[] = []) => {
    const ends = endsForNew(st().model, selected);
    return ends.error === undefined ? st().addRelation(ends) : '';
  };

  it('starts between two terms that can be joined, not simply the first two by name', () => {
    st().replaceModel(customers());
    // What the table of relationships used to ask for, and was refused every time.
    expect(cannotRelate(st().model, 'active', 'age')).toMatch(/not joined by a line/);
    useStore.setState({ toast: null });
    const id = add();
    expect(id).not.toBe('');
    expect(st().toast).toBeNull();
    // From the first term by name, to the first it can be joined to.
    expect([rel(id).from, rel(id).to, kind(id)]).toEqual(['active', 'blocked', 'object']);
    // Pressed again it is another relationship, not the same one twice; only when nothing else is left is a pair taken again.
    const next = add();
    expect([rel(next).from, rel(next).to, kind(next)]).toEqual(['active', 'customer', 'instanceOf']);
    expect(add()).not.toBe('');
    const again = add();
    expect([rel(again).from, rel(again).to, kind(again)]).toEqual(['active', 'blocked', 'object']);
    expect(st().toast).toBeNull();
  });

  it('passes over what is already stated, so that it can be pressed again and again', () => {
    st().replaceModel({ ...customers(), terms: customers().terms.filter((t) => t.id !== 'blocked') });
    const first = add();
    expect([rel(first).from, rel(first).to, kind(first)]).toEqual(['active', 'customer', 'instanceOf']);
    // “Active” is an instance of “Customer” now, and is not stated to be one twice.
    const second = add();
    expect([rel(second).from, rel(second).to, kind(second)]).toEqual(['active', 'person', 'instanceOf']);
    // Nothing is left for “Active”: the next one starts from the next term.
    useStore.setState({ toast: null });
    const third = add();
    expect([rel(third).from, rel(third).to, kind(third)]).toEqual(['customer', 'age', 'property']);
    expect(st().toast).toBeNull();
    expect(st().model.relations).toHaveLength(3);
  });

  it('starts from what is selected, where that can be joined to something', () => {
    st().replaceModel(customers());
    expect(endsForNew(st().model, ['person', 'customer'])).toEqual({ from: 'person', to: 'customer' });
    // The ends are given the way the line will run: a membership points from the individual to the class.
    expect(endsForNew(st().model, ['person'])).toEqual({ from: 'active', to: 'person' });
    useStore.setState({ toast: null });
    expect(add(['person'])).not.toBe('');
    expect(st().toast).toBeNull();
    st().undo();
    // Two that cannot be joined: from the first of them to something else, and "has data property" points from the class.
    expect(endsForNew(st().model, ['age', 'active'])).toEqual({ from: 'customer', to: 'age' });
    expect(endsForNew(st().model, ['active', 'age'])).toEqual({ from: 'active', to: 'blocked' });
    // A term that is gone is no selection at all.
    expect(endsForNew(st().model, ['gone'])).toEqual({ from: 'active', to: 'blocked' });
  });

  it('says why, where no two terms of the model can be joined', () => {
    const two = { ...customers(), terms: customers().terms.filter((t) => t.id === 'active' || t.id === 'age') };
    expect(endsForNew(two)).toEqual({ error: cannotRelate(two, 'active', 'age') });
    expect(endsForNew(emptyModel('Nothing'))).toEqual({ error: 'There are no terms to relate yet.' });
    // One term alone can only be related to itself, as before.
    const one = { ...customers(), terms: customers().terms.filter((t) => t.id === 'person') };
    expect(endsForNew(one)).toEqual({ from: 'person', to: 'person' });
  });

  it('is the first two terms by name in a model whose relationships are what they are called', () => {
    st().replaceModel(skosSample());
    const byName = [...st().model.terms].sort((a, b) => a.name.localeCompare(b.name));
    expect(endsForNew(st().model)).toEqual({ from: byName[0].id, to: byName[1].id });
  });

  it('does not take long on a large model in which most pairs are refused', () => {
    const m = emptyModel('Large');
    m.baseIri = 'http://example.org/l#';
    // One individual, already an instance of every class, and a great many data properties after it by name.
    m.terms = [newTerm({ id: 'i', name: 'A', type: 'instance' }), ...Array.from({ length: 400 }, (_, k) => newTerm({ id: 'c' + k, name: 'B' + String(k).padStart(4, '0') })), ...Array.from({ length: 3000 }, (_, k) => newTerm({ id: 'p' + k, name: 'C' + String(k).padStart(4, '0'), type: 'property' }))];
    m.relations = Array.from({ length: 400 }, (_, k) => newRelation({ id: 'r' + k, from: 'i', to: 'c' + k, kind: 'generalization' }));
    const large = withIris(m);
    const t = performance.now();
    const ends = endsForNew(large);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(ends).toEqual({ from: 'c0', to: 'c1' });
  });
});
