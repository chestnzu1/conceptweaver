import { describe, expect, it } from 'vitest';
import { addIsA, makeInstanceOf, removeIsA } from './axioms';
import { inferredMemberships } from './inferred';
import { isInstanceOf, offeredChoices, relChoice, relChoices } from './props';
import { fromTurtle, toJsonLd, toTurtle } from './rdf';
import { reason } from './reasoner';
import { emptyModel, INSTANCE_OF, newRelation, newTerm, normalizeModel, relLabel, type Model } from './types';

/** John and Mary (individuals), Person ⊒ Employee (classes), and a data property. */
function people() {
  const m = emptyModel('People');
  m.baseIri = 'http://example.org/people#';
  const john = newTerm({ name: 'John', type: 'instance' });
  const mary = newTerm({ name: 'Mary', type: 'instance' });
  const person = newTerm({ name: 'Person' });
  const employee = newTerm({ name: 'Employee' });
  const age = newTerm({ name: 'age', type: 'property' });
  m.terms.push(john, mary, person, employee, age);
  m.relations.push(newRelation({ from: employee.id, to: person.id, kind: 'generalization' }));
  return { m, john, mary, person, employee, age };
}

const block = (ttl: string, subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';
const draw = (m: Model, from: string, to: string, p: Partial<ReturnType<typeof newRelation>> = {}) => {
  const r = newRelation({ from, to, ...p });
  return { model: { ...m, relations: [...m.relations, r] }, id: r.id };
};

describe('is instance of', () => {
  it('turns a line from an individual to a class into a class membership', () => {
    const { m, john, person } = people();
    const drawn = draw(m, john.id, person.id, { label: 'belongs to', plain: true, restriction: 'only' });
    const edit = makeInstanceOf(drawn.model, drawn.id);
    expect(edit.error).toBeUndefined();
    const rel = edit.model!.relations.find((r) => r.id === drawn.id)!;
    expect(rel).toMatchObject({ from: john.id, to: person.id, kind: 'generalization', label: '' });
    expect(rel.plain).toBeUndefined();
    expect(rel.restriction).toBeUndefined();
    expect(isInstanceOf(edit.model!, rel)).toBe(true);
    expect(relChoice(edit.model!, rel)).toBe('instanceOf');
    expect(relLabel(rel, false, true)).toBe(INSTANCE_OF);
  });

  it('points it from the individual to the class when it was drawn the other way', () => {
    const { m, john, person } = people();
    const drawn = draw(m, person.id, john.id, { fromCard: '1', toCard: '*' });
    const edit = makeInstanceOf(drawn.model, drawn.id);
    const rel = edit.model!.relations.find((r) => r.id === drawn.id)!;
    // Cardinalities belong to a plain relationship; a membership has none.
    expect(rel).toMatchObject({ from: john.id, to: person.id, fromCard: '', toCard: '' });
    expect(edit.note).toContain('turned around');
    expect(toTurtle(edit.model!)).toContain(':John a owl:NamedIndividual , :Person');
  });

  it('is refused between anything but an individual and a class', () => {
    const { m, john, mary, person, employee, age } = people();
    for (const [from, to] of [
      [person.id, employee.id],
      [john.id, mary.id],
      [person.id, age.id],
      [john.id, age.id],
    ]) {
      const drawn = draw(m, from, to);
      const edit = makeInstanceOf(drawn.model, drawn.id);
      expect(edit.error).toContain('joins an individual and a class');
      expect(edit.model).toBeUndefined();
    }
    expect(makeInstanceOf({ ...draw(m, john.id, person.id).model, mode: 'skos' }, m.relations[0].id).error).toBeTruthy();
  });

  it('offers each pair of terms only the kinds that fit it', () => {
    const { m, john, mary, person, employee, age } = people();
    const offered = (from: string, to: string) => relChoices(m, { from, to }).filter((c) => !c.disabled).map((c) => c.value);
    // An individual and a class, either way round.
    expect(offered(john.id, person.id)).toEqual(['plain', 'instanceOf']);
    expect(offered(person.id, john.id)).toEqual(['plain', 'instanceOf']);
    // Two classes.
    expect(offered(person.id, employee.id)).toEqual(['plain', 'object', 'generalization']);
    // A class and a data property, either way round.
    expect(offered(person.id, age.id)).toEqual(['plain', 'property']);
    expect(offered(age.id, person.id)).toEqual(['plain', 'property']);
    // Anything else: never "Is Instance Of".
    expect(offered(john.id, mary.id)).not.toContain('instanceOf');
    expect(offered(john.id, age.id)).not.toContain('instanceOf');
    // A relationship of a kind its ends no longer allow still shows what it is.
    const odd = newRelation({ from: john.id, to: person.id, label: 'knows' });
    const model = { ...m, props: [{ name: 'knows', description: '', chars: [] }], relations: [...m.relations, odd] };
    expect(relChoice(model, odd)).toBe('object');
    expect(offeredChoices(model, odd).map((c) => `${c.value}${c.disabled ? ' (not allowed)' : ''}`)).toEqual(['plain', 'object (not allowed)', 'instanceOf']);
  });

  it('does not state the same membership twice', () => {
    const { m, john, person } = people();
    const once = addIsA(m, john.id, person.id).model!;
    expect(addIsA(once, john.id, person.id).error).toContain('already');
    // Neither drawn the same way round nor the other.
    for (const [from, to] of [
      [john.id, person.id],
      [person.id, john.id],
    ]) {
      const drawn = draw(once, from, to);
      expect(makeInstanceOf(drawn.model, drawn.id).error).toContain('already stated to be an instance of');
    }
    // Making a membership a membership again changes nothing and is not a duplicate of itself.
    const again = makeInstanceOf(once, once.relations[once.relations.length - 1].id);
    expect(again.error).toBeUndefined();
    // A duplicate that got into a model some other way is still one triple.
    const twice = draw(once, john.id, person.id, { kind: 'generalization' }).model;
    expect(block(toTurtle(twice), ':John')).toBe(':John a owl:NamedIndividual , :Person ;\n    rdfs:label "John" .');
  });

  it('exports rdf:type and no predicate of its own', () => {
    const { m, john, person } = people();
    const ttl = toTurtle(addIsA(m, john.id, person.id).model!);
    expect(block(ttl, ':John')).toBe(':John a owl:NamedIndividual , :Person ;\n    rdfs:label "John" .');
    expect(ttl).not.toMatch(/instance\s*of/i);
    const node = JSON.parse(toJsonLd(addIsA(m, john.id, person.id).model!))['@graph'].find((n: { '@id': string }) => n['@id'].endsWith('#John'));
    expect(node['@type']).toEqual(['owl:NamedIndividual', 'http://example.org/people#Person']);
  });

  it('supports several memberships, and removing one removes only that one', () => {
    const { m, john, mary, person, employee } = people();
    let model = addIsA(m, john.id, person.id).model!;
    model = addIsA(model, john.id, employee.id).model!;
    model = addIsA(model, mary.id, person.id).model!;
    expect(block(toTurtle(model), ':John')).toContain(':John a owl:NamedIndividual , :Person , :Employee');
    const before = toTurtle(model);
    const after = toTurtle(removeIsA(model, john.id, person.id));
    expect(block(after, ':John')).toContain(':John a owl:NamedIndividual , :Employee ;');
    // The individual, the class and everything else stated are untouched.
    const changed = before.split('\n\n').filter((b) => !after.includes(b));
    expect(changed).toHaveLength(1);
    expect(changed[0].startsWith(':John ')).toBe(true);
    expect(block(after, ':Person')).toBe(block(before, ':Person'));
    expect(block(after, ':Mary')).toContain(':Person');
    // Deleting the drawn relation does the same.
    const rel = model.relations.find((r) => r.from === john.id && r.to === person.id)!;
    expect(toTurtle({ ...model, relations: model.relations.filter((r) => r !== rel) })).toBe(after);
  });

  it('reads memberships from RDF, and declarations as declarations', () => {
    const m = fromTurtle(`
      @prefix : <http://example.org/people#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      :Person rdf:type owl:Class .
      :Employee a owl:Class ; rdfs:subClassOf :Person .
      :knows a owl:ObjectProperty .
      :John rdf:type :Person .
      :John a :Employee .
      :Mary a owl:NamedIndividual , :Person , :Volunteer .
      :Rex a owl:NamedIndividual .
    `);
    const name = new Map(m.terms.map((t) => [t.id, t.name]));
    const memberships = m.relations.filter((r) => isInstanceOf(m, r)).map((r) => `${name.get(r.from)} → ${name.get(r.to)}`).sort();
    expect(memberships).toEqual(['John → Employee', 'John → Person', 'Mary → Person', 'Mary → Volunteer']);
    // owl:Class, owl:NamedIndividual and owl:ObjectProperty are what the entities are, not classes they belong to.
    expect(m.terms.map((t) => `${t.name}:${t.type}`).sort()).toEqual(['Employee:concept', 'John:instance', 'Mary:instance', 'Person:concept', 'Rex:instance', 'Volunteer:concept']);
    expect(m.relations.filter((r) => !isInstanceOf(m, r)).map((r) => `${name.get(r.from)} ${r.kind} ${name.get(r.to)}`)).toEqual(['Employee generalization Person']);
    expect(m.relations.every((r) => r.label === '' && !r.predicate)).toBe(true);
  });

  it('survives export and import, and being saved and reopened', () => {
    const { m, john, mary, person, employee } = people();
    let model = addIsA(m, john.id, person.id).model!;
    model = addIsA(model, john.id, employee.id).model!;
    model = addIsA(model, mary.id, employee.id).model!;
    const pairs = (x: Model) => {
      const name = new Map(x.terms.map((t) => [t.id, t.name]));
      return x.relations.filter((r) => isInstanceOf(x, r)).map((r) => `${name.get(r.from)} → ${name.get(r.to)}`).sort();
    };
    const expected = ['John → Employee', 'John → Person', 'Mary → Employee'];
    expect(pairs(model)).toEqual(expected);
    expect(pairs(fromTurtle(toTurtle(model)))).toEqual(expected);
    expect(toTurtle(fromTurtle(toTurtle(model)))).toBe(toTurtle(model));
    const reopened = normalizeModel(JSON.parse(JSON.stringify(model)));
    expect(pairs(reopened)).toEqual(expected);
    expect(reopened.relations).toEqual(model.relations);
  });

  it('is a class membership only in an ontology, and not under another standard property', () => {
    const { m, john, person } = people();
    const model = addIsA(m, john.id, person.id).model!;
    const rel = model.relations[model.relations.length - 1];
    expect(isInstanceOf({ ...model, mode: 'skos' }, rel)).toBe(false);
    const on = { ...model, vocab: { ...model.vocab, enabled: true } };
    expect(isInstanceOf({ ...on, relations: on.relations.map((r) => (r === rel ? { ...r, predicate: 'rdf:type' } : r)) }, rel)).toBe(true);
    expect(isInstanceOf({ ...on, relations: on.relations.map((r) => (r === rel ? { ...r, predicate: 'rdfs:subClassOf' } : r)) }, rel)).toBe(false);
  });

  it('tells asserted memberships from the ones the reasoner infers', () => {
    const { m, john, mary, person, employee } = people();
    let model = addIsA(m, john.id, employee.id).model!;
    const name = new Map(model.terms.map((t) => [t.id, t.name]));
    const inferred = (x: Model) => inferredMemberships(x).memberships.map((i) => `${name.get(i.from)} → ${name.get(i.to)}`).sort();
    // John is an Employee (asserted), so a Person (inferred): only the second is listed.
    expect(inferred(model)).toEqual(['John → Person']);
    expect(inferredMemberships(model).memberships[0].because).toBeTruthy();
    expect(reason(model).types(john.id).map((t) => `${name.get(t.id)}:${t.asserted}`).sort()).toEqual(['Employee:true', 'Person:false']);
    // Stated outright, it is asserted and no longer listed as inferred.
    model = addIsA(model, john.id, person.id).model!;
    expect(inferred(model)).toEqual([]);
    // Withdrawing the membership it followed from withdraws it at once.
    model = removeIsA(removeIsA(model, john.id, person.id), john.id, employee.id);
    expect(inferred(model)).toEqual([]);
    expect(inferred(addIsA(model, mary.id, employee.id).model!)).toEqual(['Mary → Person']);
    // Nothing inferred is ever put in the model or the export.
    expect(toTurtle(addIsA(model, mary.id, employee.id).model!)).toContain(':Mary a owl:NamedIndividual , :Employee ;');
  });
});
