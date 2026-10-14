import { withDatatype } from './domains';
import { describe, expect, it } from 'vitest';
import { runChecks } from './checks';
import { hasCardinality, nextSpec, restrictionByRelation, restrictionSpecs, restrictionsOf, specsPatch } from './props';
import { fromTurtle, toTurtle } from './rdf';
import { newProp, emptyModel, newRelation, newTerm, normalizeModel, type Model } from './types';

/** Director -directs-> Film (an object property), Film has Running time (a data property), Film -wins-> Award (plain). */
function films() {
  const m = emptyModel('Films');
  m.baseIri = 'http://example.org/films#';
  const [director, film, award] = ['Director', 'Film', 'Award'].map((name) => newTerm({ name }));
  const time = newTerm({ name: 'Running time', type: 'property', ranges: withDatatype({}, 'xsd:integer') });
  m.terms.push(director, film, award, time);
  m.props.push(newProp({ name: 'directs', description: '', chars: [] }));
  const directs = newRelation({ from: director.id, to: film.id, label: 'directs' });
  const has = newRelation({ from: film.id, to: time.id, kind: 'property' });
  const wins = newRelation({ from: film.id, to: award.id, label: 'wins' });
  const isA = newRelation({ from: award.id, to: film.id, kind: 'generalization' });
  m.relations.push(directs, has, wins, isA);
  return { m, director, film, directs, has, wins, isA };
}
const patch = (m: Model, id: string, p: object): Model => ({ ...m, relations: m.relations.map((r) => (r.id === id ? { ...r, ...p } : r)) });
const block = (ttl: string, subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';

describe('several restrictions on one relationship', () => {
  it('states each of them, on an object property and on a data property', () => {
    const { m, director, film, directs, has } = films();
    let model = patch(m, directs.id, specsPatch([{ restriction: 'some' }, { restriction: 'only' }, { restriction: 'max', restrictionN: 3 }]));
    model = patch(model, has.id, specsPatch([{ restriction: 'min', restrictionN: 1 }, { restriction: 'max', restrictionN: 2 }]));
    expect(model.relations).toHaveLength(4);
    expect(restrictionsOf(model, director.id).map((r) => r.text)).toEqual(['directs some Film', 'directs only Film', 'directs max 3 Film']);
    expect(restrictionsOf(model, film.id).map((r) => r.text)).toEqual(['Running time min 1 xsd:integer', 'Running time max 2 xsd:integer']);
    expect(restrictionByRelation(model).get(directs.id)!.map((r) => r.index)).toEqual([0, 1, 2]);
    const ttl = toTurtle(model);
    expect(block(ttl, ':Director')).toContain(
      'rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :directs ; owl:someValuesFrom :Film ] , [ a owl:Restriction ; owl:onProperty :directs ; owl:allValuesFrom :Film ] , [ a owl:Restriction ; owl:onProperty :directs ; owl:maxQualifiedCardinality "3"^^xsd:nonNegativeInteger ; owl:onClass :Film ]',
    );
    expect(block(ttl, ':Film')).toContain('owl:minQualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:integer ] , [ a owl:Restriction ; owl:onProperty :runningTime ; owl:maxQualifiedCardinality "2"');
  });

  it('comes back from RDF as one relationship, and from a saved model as it was', () => {
    const { m, directs, has } = films();
    let model = patch(m, directs.id, specsPatch([{ restriction: 'some' }, { restriction: 'only' }]));
    model = patch(model, has.id, specsPatch([{ restriction: 'min', restrictionN: 1 }, { restriction: 'max', restrictionN: 2 }]));
    const back = fromTurtle(toTurtle(model));
    const name = new Map(back.terms.map((t) => [t.id, t.name]));
    expect(back.relations.map((r) => `${name.get(r.from)} ${r.label || r.kind} ${name.get(r.to)}: ${restrictionSpecs(r).map((s) => s.restriction + (s.restrictionN ?? '')).join('+')}`).sort()).toEqual([
      'Award generalization Film: some',
      'Director directs Film: some+only',
      'Film property Running time: min1+max2',
      'Film wins Award: some',
    ]);
    expect(toTurtle(back)).toBe(toTurtle(model));
    const reopened = normalizeModel(JSON.parse(JSON.stringify(model)));
    expect(reopened.relations).toEqual(JSON.parse(JSON.stringify(model.relations)));
  });

  it('keeps each restriction once, always at least one, and offers a kind not stated yet', () => {
    expect(specsPatch([{ restriction: 'only' }, { restriction: 'only' }, { restriction: 'min', restrictionN: 2 }, { restriction: 'min', restrictionN: 2 }])).toEqual({ restriction: 'only', restrictionN: undefined, more: [{ restriction: 'min', restrictionN: 2 }] });
    expect(specsPatch([])).toEqual({ restriction: undefined, restrictionN: undefined, more: undefined });
    expect(restrictionSpecs({ restriction: 'min' })).toEqual([{ restriction: 'min', restrictionN: 1 }]);
    expect(nextSpec({})).toEqual({ restriction: 'only' });
    expect(nextSpec({ more: [{ restriction: 'only' }] })).toEqual({ restriction: 'min', restrictionN: 1 });
    expect(nextSpec({ more: [{ restriction: 'only' }, { restriction: 'min' }, { restriction: 'max' }, { restriction: 'exactly' }] })).toBeUndefined();
  });
});

describe('cardinalities', () => {
  it('belong to plain relationships only', () => {
    const { m, directs, has, wins, isA } = films();
    const by = (id: string) => m.relations.find((r) => r.id === id)!;
    expect(hasCardinality(m, by(wins.id))).toBe(true);
    expect(hasCardinality(m, by(directs.id))).toBe(false);
    expect(hasCardinality(m, by(has.id))).toBe(false);
    expect(hasCardinality(m, by(isA.id))).toBe(false);
    // Kept plain although an object property has its name: still a plain relationship.
    expect(hasCardinality(patch(m, directs.id, { plain: true }), { ...by(directs.id), plain: true })).toBe(true);
    // In a concept scheme every association is one.
    expect(hasCardinality({ ...m, mode: 'skos' }, by(directs.id))).toBe(true);
    // One left over on another kind is not reported as malformed: there is nowhere to see or fix it.
    const leftover = patch(patch(m, directs.id, { fromCard: 'many' }), wins.id, { toCard: 'lots' });
    expect(runChecks(leftover).filter((i) => i.rule === 'Invalid cardinality').map((i) => i.message)).toEqual([expect.stringContaining('"lots"')]);
  });
});
