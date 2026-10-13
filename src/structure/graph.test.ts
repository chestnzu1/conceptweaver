import { describe, expect, it } from 'vitest';
import { StructureError } from './contracts';
import { graphOf, NS } from './fixtures';
import { buildHierarchy, narrow, nodeOf, pathsTo, type ClassGraphInput } from './graph';

const CAST = 'Person; Actor < Person; Employee < Person; WorkingActor < Actor, Employee; Director < Person; Film; Documentary < Film; Organization';
const short = (iris: Iterable<string>) => [...iris].map((x) => x.slice(NS.length));
const way = (path: { label: string }[]) => path.map((c) => c.label).join(' > ');
const children = (h: ReturnType<typeof buildHierarchy>, name: string) => short(h.entries.get(NS + name)!.children);

describe('the class hierarchy as a graph', () => {
  it('puts each class under every superclass stated for it, in order of label', () => {
    const h = buildHierarchy(graphOf(CAST));
    expect(short(h.top)).toEqual(['Film', 'Organization', 'Person']);
    expect(children(h, 'Person')).toEqual(['Actor', 'Director', 'Employee']);
    expect(children(h, 'Film')).toEqual(['Documentary']);
    expect(h.cycles).toEqual([]);
  });

  it('keeps a class with several superclasses as one class in several places', () => {
    const h = buildHierarchy(graphOf(CAST));
    expect(children(h, 'Actor')).toEqual(['WorkingActor']);
    expect(children(h, 'Employee')).toEqual(['WorkingActor']);
    // One entry, whichever superclass it is come to from.
    expect([...h.entries.keys()].filter((iri) => iri.endsWith('WorkingActor'))).toHaveLength(1);
    const node = nodeOf(h, NS + 'WorkingActor');
    expect(node.parentCount).toBe(2);
    expect(node.childCount).toBe(0);
    expect(nodeOf(h, NS + 'Actor').parentCount).toBe(1);
  });

  it('names classes by IRI: two with one label are two, one listed twice is one', () => {
    const input = graphOf('Person');
    input.classes.push({ iri: NS + 'Person2', label: 'Person' }, { iri: NS + 'Person', label: 'Listed again' });
    const h = buildHierarchy(input);
    expect(h.entries.size).toBe(2);
    expect(short(h.top)).toEqual(['Person', 'Person2']);
    expect(h.entries.get(NS + 'Person')!.ref.label).toBe('Person');
  });

  it('leaves out links to something that is not a class, links of a class to itself, and a link stated twice', () => {
    const input = graphOf('Actor < Person');
    input.subClassOf.push({ sub: NS + 'Actor', sup: NS + 'Person' }, { sub: NS + 'Actor', sup: NS + 'Actor' }, { sub: NS + 'Actor', sup: '_:anonymous' }, { sub: NS + 'Nobody', sup: NS + 'Person' });
    const h = buildHierarchy(input);
    expect(nodeOf(h, NS + 'Actor').parentCount).toBe(1);
    expect(children(h, 'Person')).toEqual(['Actor']);
    expect(children(h, 'Actor')).toEqual([]);
    expect(h.cycles).toEqual([]);
  });

  it('finds the classes that are each other’s superclasses, and lists one of a ring with nothing above it at the top', () => {
    // Cat and Feline are only each other's superclasses; Lion is under them.
    const h = buildHierarchy(graphOf('Animal; Cat < Feline; Feline < Cat; Lion < Cat'));
    expect(h.cycles.map((ring) => short(ring).sort())).toEqual([['Cat', 'Feline']]);
    expect(short(h.top)).toEqual(['Animal', 'Cat']);
    expect(nodeOf(h, NS + 'Cat').inCycle).toBe(true);
    expect(nodeOf(h, NS + 'Feline').inCycle).toBe(true);
    expect(nodeOf(h, NS + 'Lion').inCycle).toBeUndefined();
    expect(nodeOf(h, NS + 'Animal').inCycle).toBeUndefined();
  });

  it('does not put a ring at the top when something above it leads to it', () => {
    const h = buildHierarchy(graphOf('Animal; Cat < Feline, Animal; Feline < Cat'));
    expect(short(h.top)).toEqual(['Animal']);
    expect(h.cycles).toHaveLength(1);
  });

  it('can reach every class from the top, whatever rings there are', () => {
    const h = buildHierarchy(graphOf('A < B; B < C; C < A; D < A; E < F; F < E; G < E, D; H'));
    const reached = new Set<string>();
    const todo = [...h.top];
    while (todo.length) {
      const iri = todo.pop()!;
      if (reached.has(iri)) continue;
      reached.add(iri);
      todo.push(...h.entries.get(iri)!.children);
    }
    expect(reached.size).toBe(h.entries.size);
    expect(h.cycles.map((r) => r.length).sort()).toEqual([2, 3]);
  });

  it('shows stated equivalence both ways without merging the classes', () => {
    const h = buildHierarchy(graphOf('Organisation < Party; Org < Party; Organisation = Org'));
    expect(children(h, 'Party')).toEqual(['Org', 'Organisation']);
    expect(nodeOf(h, NS + 'Org').equivalents.map((c) => c.label)).toEqual(['Organisation']);
    expect(nodeOf(h, NS + 'Organisation').equivalents.map((c) => c.label)).toEqual(['Org']);
    // Stated equivalence is not a subclass cycle: nothing was stated to be a subclass of the other.
    expect(h.cycles).toEqual([]);
  });

  it('handles a hierarchy tens of thousands of levels deep without running out of stack', () => {
    const depth = 30_000;
    const input: ClassGraphInput = { classes: [], subClassOf: [], equivalent: [] };
    for (let i = 0; i < depth; i++) {
      input.classes.push({ iri: `${NS}C${i}`, label: `C${i}` });
      if (i) input.subClassOf.push({ sub: `${NS}C${i}`, sup: `${NS}C${i - 1}` });
    }
    const h = buildHierarchy(input);
    expect(short(h.top)).toEqual(['C0']);
    const { paths, truncated } = pathsTo(h, `${NS}C${depth - 1}`, 5);
    expect(truncated).toBe(false);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveLength(depth);
    expect(paths[0][0]).toEqual({ iri: `${NS}C0`, label: 'C0' });
    // And the same chain closed into one great ring.
    input.subClassOf.push({ sub: `${NS}C0`, sup: `${NS}C${depth - 1}` });
    const ring = buildHierarchy(input);
    expect(ring.cycles).toHaveLength(1);
    expect(ring.cycles[0]).toHaveLength(depth);
    expect(ring.top).toHaveLength(1);
  });
});

describe('the ways down to a class', () => {
  it('gives each way from the top, the shortest first', () => {
    const h = buildHierarchy(graphOf(CAST + '; Agent; Person < Agent; WorkingActor < Agent'));
    const { paths, truncated } = pathsTo(h, NS + 'WorkingActor', 10);
    expect(paths.map(way)).toEqual(['Agent > WorkingActor', 'Agent > Person > Actor > WorkingActor', 'Agent > Person > Employee > WorkingActor']);
    expect(truncated).toBe(false);
    expect(pathsTo(h, NS + 'Agent', 10).paths).toEqual([[{ iri: NS + 'Agent', label: 'Agent' }]]);
  });

  it('says when there are more ways than were asked for', () => {
    const h = buildHierarchy(graphOf(CAST));
    const one = pathsTo(h, NS + 'WorkingActor', 1);
    expect(one.paths).toHaveLength(1);
    expect(one.truncated).toBe(true);
    expect(pathsTo(h, NS + 'WorkingActor', 2).truncated).toBe(false);
  });

  it('goes round a ring at most once', () => {
    const h = buildHierarchy(graphOf('Animal; Cat < Feline, Animal; Feline < Cat; Lion < Feline'));
    expect(pathsTo(h, NS + 'Lion', 10).paths.map(way)).toEqual(['Animal > Cat > Feline > Lion']);
    // A ring with nothing above it is entered at the class that stands for it at the top.
    const loose = buildHierarchy(graphOf('Cat < Feline; Feline < Cat; Lion < Feline'));
    expect(pathsTo(loose, NS + 'Lion', 10).paths.map(way)).toEqual(['Cat > Feline > Lion']);
    expect(pathsTo(loose, NS + 'Cat', 10).paths.map(way)).toEqual(['Cat']);
  });

  it('refuses a class that is not there', () => {
    const h = buildHierarchy(graphOf(CAST));
    expect(() => pathsTo(h, NS + 'Nobody', 1)).toThrow(StructureError);
  });
});

describe('narrowing the hierarchy to a search', () => {
  const input = graphOf(CAST);
  input.classes.find((c) => c.label === 'Documentary')!.search = ['Non-fiction film', 'ex:Documentary'];
  const h = buildHierarchy(input);

  it('finds by label, by another label and by IRI, whatever the case', () => {
    expect(short(narrow(h, 'ACTOR').matches)).toEqual(['Actor', 'WorkingActor']);
    expect(short(narrow(h, 'non-fiction').matches)).toEqual(['Documentary']);
    expect(short(narrow(h, 'ex:doc').matches)).toEqual(['Documentary']);
    expect(short(narrow(h, 'example.org/o#Org').matches)).toEqual(['Organization']);
  });

  it('keeps what leads down to a match, by every way there is', () => {
    const found = narrow(h, 'working');
    expect(short(found.matches)).toEqual(['WorkingActor']);
    expect(short(found.kept).sort()).toEqual(['Actor', 'Employee', 'Person', 'WorkingActor']);
    expect(nodeOf(h, NS + 'Person', found).childCount).toBe(2);
    expect(nodeOf(h, NS + 'Person', found).match).toBeUndefined();
    expect(nodeOf(h, NS + 'WorkingActor', found).match).toBe(true);
    expect(narrow(h, 'nothing like it').kept.size).toBe(0);
  });
});
