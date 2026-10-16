import fs from 'node:fs';
import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';
import { shaclBase, shaclFile, shaclFiles, shaclTests } from '../../corpus/shacl.mjs';
import { readShapes } from './shacl';
import { emptyModel } from './types';
import { shaclFindings } from './validation';

/**
 * The W3C SHACL 1.0 Core test suite as the conformance suite of validation (roadmap stage SH-2,
 * FR-M4-14): each test's shapes graph is read into a shape set, as the Shapes view holds it, and
 * its data validated against that set the way the workbench does; the report has to be the one the
 * test expects. Reports are compared as the suite asks: whether the data conforms, and the results,
 * each by its focus node, path, value, source shape, constraint component and severity, not by its
 * message. A blank node is any blank node, except in a path, which is compared as the path it is.
 * The tests that do not give their report are in corpus/expected/shacl-core.txt, each with what
 * differs: a fix shows there as a test no longer listed.
 */

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';
const SHT = 'http://www.w3.org/ns/shacl-test#';
const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';

interface T {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}
interface Q {
  subject: T;
  predicate: T;
  object: T;
}

const parse = (text: string, base: string) => new Parser({ baseIRI: base }).parse(text) as unknown as Q[];

/** A graph as a lookup: the objects of a subject and predicate. */
function graph(quads: Q[]) {
  const key = (t: T) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value);
  const by = new Map<string, T[]>();
  for (const q of quads) {
    const k = key(q.subject) + ' ' + q.predicate.value;
    (by.get(k) ?? by.set(k, []).get(k)!).push(q.object);
  }
  const all = (s: T, p: string) => by.get(key(s) + ' ' + p) ?? [];
  const one = (s: T, p: string) => all(s, p)[0];
  const list = (t: T): T[] => (t.termType === 'NamedNode' && t.value === RDF + 'nil' ? [] : [one(t, RDF + 'first'), ...list(one(t, RDF + 'rest'))]);
  /** A term as compared: a blank node is any blank node, a literal its value with its language or datatype. */
  const term = (t: T | undefined): string => (!t ? '' : t.termType === 'BlankNode' ? '_' : t.termType === 'Literal' ? `"${t.value}"${t.language ? '@' + t.language : t.datatype && t.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string' ? '^^' + t.datatype.value : ''}` : `<${t.value}>`);
  /** A path as the path it is, whichever blank nodes it is made of. */
  const path = (t: T | undefined): string => {
    if (!t) return '';
    if (t.termType !== 'BlankNode') return term(t);
    if (one(t, RDF + 'first')) return `(${list(t).map(path).join(' / ')})`;
    for (const [p, op] of [['inversePath', '^'], ['zeroOrMorePath', '*'], ['oneOrMorePath', '+'], ['zeroOrOnePath', '?']] as const) {
      const x = one(t, SH + p);
      if (x) return op === '^' ? `^${path(x)}` : `${path(x)}${op}`;
    }
    const alt = one(t, SH + 'alternativePath');
    return alt ? `(${list(alt).map(path).join(' | ')})` : '[?]';
  };
  return { all, one, term, path };
}

/** A validation report as compared: whether the data conforms, and its results, sorted. */
function reportOf(quads: Q[], root: T) {
  const g = graph(quads);
  const conforms = g.one(root, SH + 'conforms')?.value === 'true';
  const results = g
    .all(root, SH + 'result')
    .map((r) => [g.term(g.one(r, SH + 'focusNode')), g.path(g.one(r, SH + 'resultPath')), g.term(g.one(r, SH + 'value')), g.term(g.one(r, SH + 'sourceShape')), g.term(g.one(r, SH + 'sourceConstraintComponent')), g.term(g.one(r, SH + 'resultSeverity'))].join(' | '))
    .sort();
  return { conforms, results };
}

/** Each test of the suite: its name, its file, the files of its data and shapes graphs, and the report it expects. */
function tests() {
  const out: { name: string; file: string; data: string; shapes: string; expected: ReturnType<typeof reportOf> }[] = [];
  for (const file of shaclTests()) {
    const base = shaclBase(file);
    const quads = parse(fs.readFileSync(shaclFile(file), 'utf8'), base);
    const g = graph(quads);
    for (const q of quads) {
      if (q.predicate.value !== RDF + 'type' || q.object.value !== SHT + 'Validate') continue;
      const action = g.one(q.subject, MF + 'action');
      const relative = (t: T) => file.replace(/[^/]*$/, '') + t.value.slice(base.replace(/[^/]*$/, '').length);
      out.push({ name: q.subject.value.slice(base.replace(/[^/]*$/, '').length), file, data: relative(g.one(action, SHT + 'dataGraph')), shapes: relative(g.one(action, SHT + 'shapesGraph')), expected: reportOf(quads, g.one(q.subject, MF + 'result')) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

describe.skipIf(!shaclFiles().length)('the W3C SHACL 1.0 Core test suite, validated as the workbench validates', () => {
  it('gives each test the report it expects, but for the tests listed as not doing so', async () => {
    const all = tests();
    expect(all.length).toBe(98);
    // What is compared is there: the suite expects 200-odd results, of every constraint component of Core.
    expect(all.reduce((n, t) => n + t.expected.results.length, 0)).toBeGreaterThan(200);
    expect(new Set(all.flatMap((t) => t.expected.results.map((r) => r.split(' | ')[4]))).size).toBeGreaterThan(25);
    const differ: string[] = [];
    for (const t of all) {
      // The shapes as the Shapes view holds them: read into a set, and written from it.
      const set = { ...readShapes(fs.readFileSync(shaclFile(t.shapes), 'utf8'), shaclBase(t.shapes)), id: 'suite', name: t.name, description: '', namespace: '' };
      const model = { ...emptyModel(t.name), shapeSets: [set] };
      const text = `@base <${shaclBase(t.data)}> .\n${fs.readFileSync(shaclFile(t.data), 'utf8')}`;
      const { summary } = await shaclFindings(model, { source: 'graph', id: t.data, name: t.data, text, includeOntology: false });
      const where = `${t.file.replace(/\.ttl$/, '')}${t.name === t.file.replace(/^.*\/|\.ttl$/g, '') ? '' : ' (' + t.name + ')'}`;
      if (summary.status === 'failed' || summary.status === 'skipped') {
        differ.push(`${where}: no report: ${summary.error ?? summary.status}`);
        continue;
      }
      const report = parse(summary.report ?? '', shaclBase(t.data));
      const actual = reportOf(report, report.find((q) => q.predicate.value === RDF + 'type' && q.object.value === SH + 'ValidationReport')!.subject);
      const missing = t.expected.results.filter((r, i, a) => a.slice(0, i + 1).filter((x) => x === r).length > actual.results.filter((x) => x === r).length);
      const extra = actual.results.filter((r, i, a) => a.slice(0, i + 1).filter((x) => x === r).length > t.expected.results.filter((x) => x === r).length);
      if (actual.conforms !== t.expected.conforms || missing.length || extra.length)
        differ.push([`${where}:${actual.conforms !== t.expected.conforms ? ` conforms ${actual.conforms}, expected ${t.expected.conforms};` : ''} ${missing.length} result${missing.length === 1 ? '' : 's'} missing, ${extra.length} not expected`, ...missing.map((r) => `  - ${r}`), ...extra.map((r) => `  + ${r}`)].join('\n'));
    }
    const text = `# The W3C SHACL 1.0 Core tests whose report is not the one expected (${differ.length} of ${all.length}).\n# - a result expected and not given; + a result given and not expected.\n${differ.join('\n')}\n`;
    await expect(text).toMatchFileSnapshot('../../corpus/expected/shacl-core.txt');
  }, 120_000);
});
