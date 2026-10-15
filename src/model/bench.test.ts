import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { changesBetween, committed, opened, undone } from '../editing/local';
import { runChecks } from './checks';
import { forceLayout } from '../layout/force';
import { graphOf, hierarchyOf } from '../layout/graph';
import { noLayout } from '../layout/types';
import { objectProperties, restrictionsOf } from './props';
import { fromTurtle, toJsonLd, toTriples, toTurtle } from './rdf';
import { reason } from './reasoner';
import { runSparql } from './sparql';
import { stressModel } from './stress';
import { normalizeModel } from './types';

const OUT = process.env.BENCH_OUT;

it.skipIf(!OUT)('times the model layer on large models', async () => {
  const lines: string[] = [];
  for (const n of [350, 650, 1300, 2600]) {
    const time = <T>(label: string, fn: () => T): T => {
      const t0 = performance.now();
      const out = fn();
      lines.push(`${String(n).padStart(5)} classes  ${label.padEnd(34)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`);
      return out;
    };
    const m = time('generate + hierarchy layout', () => stressModel(n));
    lines.push(`${String(n).padStart(5)} classes  = ${m.terms.length} terms, ${m.relations.length} relationships, ${m.props.length} object properties`);
    const fresh = () => ({ ...m });
    time('object properties (analysis)', () => objectProperties(fresh()));
    time('restrictions of every class', () => {
      const x = fresh();
      return x.terms.filter((t) => t.type === 'concept').map((t) => restrictionsOf(x, t.id));
    });
    const issues = time('model checks', () => runChecks(fresh()));
    const r = time('reasoner', () => reason(fresh(), true));
    lines.push(`${String(n).padStart(5)} classes  = ${issues.length} check results; reasoner: ${r.asserted} stated, ${r.inferred} inferred, ${r.inferences.length} shown, ${r.conflicts.length} conflicts${r.truncated ? ', TRUNCATED' : ''}`);
    for (const c of r.conflicts.slice(0, 4)) lines.push(`      conflict: ${c.rule}: ${c.message} | ${c.because.slice(0, 160)}`);
    time('hierarchy layout', () => hierarchyOf(fresh()));
    time('network layout', () => forceLayout(graphOf(fresh()), noLayout()));
    const ttl = time('export Turtle', () => toTurtle(fresh()));
    lines.push(`${String(n).padStart(5)} classes  = Turtle: ${ttl.split('\n').length} lines, ${(ttl.length / 1024).toFixed(0)} KB`);
    time('export JSON-LD', () => toJsonLd(fresh()));
    time('triples table', () => toTriples(fresh()));
    const back = time('import Turtle', () => fromTurtle(ttl));
    lines.push(`${String(n).padStart(5)} classes  = re-imported: ${back.terms.length} terms, ${back.relations.length} relationships`);
    const json = time('JSON save', () => JSON.stringify(m));
    writeFileSync(`${OUT}.${n}.json`, json);
    lines.push(`${String(n).padStart(5)} classes  = JSON: ${(json.length / 1024).toFixed(0)} KB`);
    time('JSON open', () => normalizeModel(JSON.parse(json)));
    // An edit as the edit service records it (a step: the parts it replaced, and the revision it
    // makes), and the same edit as axioms, which is worked out only when it is asked for.
    const doc = opened(m);
    const renamed = { ...m, terms: m.terms.map((t, i) => (i === 0 ? { ...t, name: t.name + ' renamed' } : t)) };
    time('edit: record the step', () => committed(doc, renamed));
    time('edit: undo the step', () => undone(committed(doc, renamed)));
    time('edit: as axioms (when asked)', () => changesBetween(m, renamed));

    const queries: [string, string][] = [
      ['all classes with labels', 'SELECT ?c ?l WHERE { ?c a owl:Class ; rdfs:label ?l } ORDER BY ?l'],
      ['transitive ancestors (path +)', 'SELECT ?c ?a WHERE { ?c rdfs:subClassOf+ ?a . FILTER(isIRI(?a)) }'],
      ['count descendants per class', 'SELECT ?a (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c rdfs:subClassOf+ ?a . FILTER(isIRI(?a)) } GROUP BY ?a ORDER BY DESC(?n) LIMIT 20'],
      [
        'restrictions inherited through the hierarchy',
        'SELECT ?c ?p ?filler WHERE { ?c rdfs:subClassOf* ?super . ?super rdfs:subClassOf ?r . ?r a owl:Restriction ; owl:onProperty ?p ; ?q ?filler . FILTER(?q IN (owl:someValuesFrom, owl:allValuesFrom, owl:onClass)) }',
      ],
      [
        'individuals by inferred type (path)',
        'SELECT ?type (COUNT(DISTINCT ?i) AS ?n) WHERE { ?i a owl:NamedIndividual ; a/rdfs:subClassOf* ?type . ?type a owl:Class } GROUP BY ?type ORDER BY DESC(?n) LIMIT 20',
      ],
      [
        'classes with no restriction (NOT EXISTS)',
        'SELECT ?c WHERE { ?c a owl:Class . FILTER NOT EXISTS { ?c rdfs:subClassOf ?r . ?r a owl:Restriction } }',
      ],
      [
        'two-hop facts between individuals',
        'SELECT ?a ?b ?c WHERE { ?a a owl:NamedIndividual . ?a ?p ?b . ?b ?q ?c . ?p a owl:ObjectProperty . ?q a owl:ObjectProperty . FILTER(?a != ?c) } LIMIT 5000',
      ],
      [
        'union + optional + aggregate',
        'SELECT ?p (COUNT(?x) AS ?uses) (SAMPLE(?d) AS ?domain) WHERE { ?p a owl:ObjectProperty . OPTIONAL { ?p rdfs:domain ?d } { ?x rdfs:subClassOf [ owl:onProperty ?p ] } UNION { ?x ?p ?y } } GROUP BY ?p ORDER BY DESC(?uses)',
      ],
      ['construct the whole hierarchy', 'CONSTRUCT { ?c rdfs:subClassOf ?a } WHERE { ?c rdfs:subClassOf ?a . FILTER(isIRI(?a)) }'],
    ];
    await runSparql(m, 'ASK { ?s ?p ?o }');
    for (const [label, q] of queries) {
      const t0 = performance.now();
      const res = await runSparql(m, q);
      lines.push(`${String(n).padStart(5)} classes  SPARQL ${label.padEnd(44)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms  ${res.type === 'ask' ? '' : res.rows.length + ' rows'}`);
    }
    lines.push('');
  }
  writeFileSync(OUT!, lines.join('\n'));
}, 600_000);
