import { beforeEach, describe, expect, it } from 'vitest';
import { linkProps, propNamed } from './identity';
import { objectProperties, relChoice } from './props';
import { fromTurtle, toTurtle } from './rdf';
import { useStore } from './store';
import { newProp, newRelation } from './types';

/**
 * An object property is known by an id of its own, not by its name (FR-M1-3): two may share a
 * name, and renaming one changes its uses and nothing else.
 */

// Two ontologies' "has part", told apart only by IRI, each used by a restriction.
const TWO = `@prefix : <http://example.org/parts#> .
@prefix bio: <http://example.org/bio#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/parts> a owl:Ontology .
:hasPart a owl:ObjectProperty ; rdfs:label "has part" .
bio:hasPart a owl:ObjectProperty ; rdfs:label "has part" .
:Car a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasPart ; owl:someValuesFrom :Wheel ] .
:Cell a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty bio:hasPart ; owl:someValuesFrom :Nucleus ] .
:Wheel a owl:Class .
:Nucleus a owl:Class .
`;
const block = (ttl: string, subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';

describe('two object properties with one name', () => {
  const st = useStore.getState;
  beforeEach(() => st().replaceModel(fromTurtle(TWO)));
  const ids = () => {
    const m = st().model;
    const term = (name: string) => m.terms.find((t) => t.name === name)!.id;
    const prop = (iri: string) => m.props.find((p) => p.iri === iri)!;
    const use = (from: string) => m.relations.find((r) => r.from === term(from))!;
    return { m, prop, use, parts: prop('http://example.org/parts#hasPart'), bio: prop('http://example.org/bio#hasPart') };
  };

  it('are read as two, each with its own uses', () => {
    const { m, use, parts, bio } = ids();
    expect(m.props.map((p) => p.name)).toEqual(['has part', 'has part']);
    expect(parts.id).not.toBe(bio.id);
    expect(use('Car')).toMatchObject({ prop: parts.id, label: 'has part' });
    expect(use('Cell')).toMatchObject({ prop: bio.id, label: 'has part' });
    expect(objectProperties(m).map((p) => p.rels.length)).toEqual([1, 1]);
  });

  it('are written back as two, each restriction on its own property', () => {
    const ttl = toTurtle(ids().m);
    expect(block(ttl, ':Car')).toContain('owl:onProperty :hasPart ; owl:someValuesFrom :Wheel');
    expect(block(ttl, ':Cell')).toContain('owl:onProperty bio:hasPart ; owl:someValuesFrom :Nucleus');
  });

  it('renaming one renames its uses and leaves the other, and its uses, as they were', () => {
    const { bio, parts } = ids();
    expect(st().renameProp(bio.id, 'has component')).toBe(true);
    const after = ids();
    expect(after.bio).toMatchObject({ id: bio.id, name: 'has component', iri: bio.iri });
    expect(after.parts).toEqual(parts);
    expect(after.use('Cell')).toMatchObject({ prop: bio.id, label: 'has component' });
    expect(after.use('Car')).toMatchObject({ prop: parts.id, label: 'has part' });
    const ttl = toTurtle(after.m);
    expect(block(ttl, 'bio:hasPart')).toContain('rdfs:label "has component"');
    expect(block(ttl, ':hasPart')).toContain('rdfs:label "has part"');
    expect(block(ttl, ':Cell')).toContain('owl:onProperty bio:hasPart');
  });

  it('deleting one takes its uses with it, and nothing of the other', () => {
    const { bio, parts } = ids();
    st().deleteProp(bio.id);
    const after = st().model;
    expect(after.props.map((p) => p.id)).toEqual([parts.id]);
    expect(after.relations.filter((r) => r.kind === 'association').map((r) => r.prop)).toEqual([parts.id]);
  });

  it('a name typed for a new relationship is the model’s own property of that name, before one of another ontology', () => {
    const m = fromTurtle(TWO);
    const marked = { ...m, props: m.props.map((p) => (p.iri?.startsWith('http://example.org/bio#') ? { ...p, external: 'bio' } : p)) };
    expect(propNamed(marked, 'Has Part')?.iri).toBe('http://example.org/parts#hasPart');
  });
});

describe('a relationship and the property it uses', () => {
  const st = useStore.getState;
  const setup = () => {
    st().replaceModel(fromTurtle(TWO));
    const m = st().model;
    return { car: m.terms.find((t) => t.name === 'Car')!.id, wheel: m.terms.find((t) => t.name === 'Wheel')!.id, use: () => st().model.relations.find((r) => r.from === m.terms.find((t) => t.name === 'Car')!.id)! };
  };

  it('keeps the property while the label is its name, in whatever case; another label is another property', () => {
    const { use } = setup();
    const was = use().prop;
    st().updateRelation(use().id, { label: 'HAS PART' });
    expect(use()).toMatchObject({ prop: was });
    st().updateRelation(use().id, { label: 'carries' });
    const carries = st().model.props.find((p) => p.name === 'carries');
    expect(carries && use().prop).toBe(carries!.id);
    expect(relChoice(st().model, use())).toBe('object');
  });

  it('joins a relationship drawn with only a label to the property of that name, once', () => {
    const p = newProp({ name: 'drives' });
    const m = { ...fromTurtle(TWO), props: [newProp({ name: 'steers' }), p] };
    const [a, b] = m.terms;
    const drawn = { ...m, relations: [...m.relations, newRelation({ from: a.id, to: b.id, label: 'Drives' })] };
    const linked = linkProps(drawn);
    expect(linked.relations.at(-1)).toMatchObject({ prop: p.id, label: 'Drives' });
    expect(linkProps(linked)).toBe(linked);
  });

  it('is left plain when it was kept so, though its label names a property', () => {
    const p = newProp({ name: 'drives' });
    const m = { ...fromTurtle(TWO), props: [p] };
    const [a, b] = m.terms;
    const kept = newRelation({ from: a.id, to: b.id, label: 'drives', plain: true });
    const linked = linkProps({ ...m, relations: [kept] });
    expect(linked.relations[0].prop).toBeUndefined();
    expect(relChoice(linked, linked.relations[0])).toBe('plain');
    // And one that names a property but is kept plain names none.
    expect(linkProps({ ...m, relations: [{ ...kept, prop: p.id }] }).relations[0].prop).toBeUndefined();
  });
});
