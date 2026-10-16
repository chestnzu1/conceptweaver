import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { MODEL_DATA } from '../validation/contracts';
import { currentData, currentShapeSet, dataOf, graphsHere, graphText, keepGraphText, readDataGraph } from './dataGraphs';
import { subjectLines } from './dataLines';
import { keepDataGraph, keptDataGraph, useIndexedDb } from './library';
import { newShapeSet } from './shacl';
import { emptyModel, normalizeModel } from './types';

/** Data graphs (roadmap stage SH-2): kept with the model by what they are, their content in this browser, and where in their file a node is. */

beforeEach(() => useIndexedDb(new IDBFactory()));

describe('where in a file of data a node is', () => {
  const X = 'http://data.example/';
  const lines = (text: string, ...names: string[]) => Object.fromEntries([...subjectLines(text, new Set(names.map((n) => X + n)))].map(([k, v]) => [k.slice(X.length), v]));

  it('is the line its statements begin on, whatever prefixes, base or layout the file has', () => {
    const text = `@prefix x: <${X}> .
PREFIX y: <${X}>
x:a a x:Thing .

<${X}b>
  x:p "x:c is not a node here" ;
  x:q [ x:r x:c ] .
@base <${X}> .
<d> x:p y:e .
y:e x:p x:a .`;
    expect(lines(text, 'a', 'b', 'c', 'd', 'e')).toEqual({ a: 3, b: 5, d: 9, e: 10, c: 7 });
  });

  it('is where it is first named when nothing is said of it, and nothing for what the file does not name', () => {
    expect(lines(`@prefix x: <${X}> .\nx:a x:p\n  x:b .`, 'b', 'z')).toEqual({ b: 3 });
    expect(lines('this is { not turtle', 'a')).toEqual({});
  });
});

describe('a data graph of the model', () => {
  const ttl = `@prefix x: <http://data.example/> .\nx:a a x:Thing ; x:p "1" .\nx:b a x:Thing .`;

  it('is read from a file: what the model keeps of it, and its content apart', async () => {
    const { ref, turtle } = await readDataGraph(ttl, 'staff.ttl', '');
    expect(ref).toMatchObject({ name: 'staff', file: 'staff.ttl', format: 'turtle', triples: 3, includeOntology: true });
    expect(ref.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(turtle).toBe(ttl);
    // The same file read again in place of it is the same graph, with the same content.
    const again = await readDataGraph(ttl, 'staff-2.ttl', '', ref.id);
    expect(again.ref).toMatchObject({ id: ref.id, fingerprint: ref.fingerprint });
  });

  it('keeps its content in this browser, there in a later session, and says which graphs are here', async () => {
    const db = new IDBFactory();
    useIndexedDb(db);
    expect(await keepGraphText('g1', ttl)).toBe(true);
    expect(await graphText('g1')).toBe(ttl);
    // In the database itself, not only in this session: and one kept there by an earlier session is found.
    expect(await keptDataGraph('g1')).toBe(ttl);
    await keepDataGraph('g3', ttl);
    expect(await graphText('g3')).toBe(ttl);
    expect(await graphsHere(['g1', 'g2', 'g3'])).toEqual(new Set(['g1', 'g3']));
    expect(await graphText('g2')).toBeUndefined();
  });

  it('is saved with the model, by what it is, and its choice follows the model', async () => {
    const { ref } = await readDataGraph(ttl, 'staff.ttl', '');
    const m = normalizeModel(JSON.parse(JSON.stringify({ ...emptyModel('M'), dataGraphs: [ref, { name: 'no id' }] })));
    expect(m.dataGraphs).toEqual([ref]);
    expect(normalizeModel(JSON.parse(JSON.stringify(emptyModel('M')))).dataGraphs).toEqual([]);
    // Chosen, it is validated as it now is in the model; gone from the model, the model's own data is.
    expect(currentData(m, dataOf(ref))).toEqual({ source: 'graph', id: ref.id, name: 'staff', fingerprint: ref.fingerprint, includeOntology: true, lines: true });
    expect(currentData({ ...m, dataGraphs: [{ ...ref, name: 'renamed', includeOntology: false }] }, dataOf(ref))).toMatchObject({ name: 'renamed', includeOntology: false });
    expect(currentData({ ...m, dataGraphs: [] }, dataOf(ref))).toBe(MODEL_DATA);
    // Read from another syntax, its Turtle is not the file's: no lines are given.
    expect(dataOf({ ...ref, format: 'rdfxml' }).lines).toBeUndefined();
    const set = newShapeSet('Catalogue');
    expect(currentShapeSet({ ...m, shapeSets: [set] }, set.id)).toBe(set.id);
    expect(currentShapeSet(m, set.id)).toBeUndefined();
  });
});
