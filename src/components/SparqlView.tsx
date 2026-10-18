import { useEffect, useMemo, useRef, useState } from 'react';
import { download } from '../model/files';
import { termIris } from '../model/rdf';
import { examplesFor } from '../model/sparql';
import { currentDl, useStore } from '../model/store';
import type { Model } from '../model/types';
import { ontologyRef } from '../structure/local';
import { DEFAULT_GRAPH, GRAPHS, SparqlError, type SparqlAnswer, type SparqlCell, type SparqlGraph } from '../sparql/contracts';
import { createLocalSparqlService } from '../sparql/local';

const QUERY_KEY = 'conceptweaver:sparql';
const GRAPH_KEY = 'conceptweaver:sparql:graph';
const ROWS = 500;

/** How each graph is offered, and what the header says the answer was read from. */
const GRAPH_LABEL: Record<SparqlGraph, string> = { asserted: 'Asserted', imports: 'Asserted with imports', inferred: 'Inferred' };
const GRAPH_READ: Record<SparqlGraph, string> = {
  asserted: 'read from the asserted graph',
  imports: 'read from the asserted graph with imports',
  inferred: 'read from the graph with inferred statements',
};

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Just not remembered.
  }
}

/** The last query run for this type of model; SKOS and OWL queries don't carry over to each other. */
function savedQuery(mode: Model['mode']): string {
  return remembered(`${QUERY_KEY}:${mode}`) || examplesFor(mode)[0].query;
}

/** The graph last chosen for this type of model. */
function savedGraph(mode: Model['mode']): SparqlGraph {
  const kept = remembered(`${GRAPH_KEY}:${mode}`);
  return GRAPHS.includes(kept as SparqlGraph) ? (kept as SparqlGraph) : DEFAULT_GRAPH;
}

/** The graph is read where the ontology is, by whichever service is in place; the view asks the same way of both. */
const SERVICE = createLocalSparqlService({
  current: () => {
    const s = useStore.getState();
    return { model: s.model, docId: s.doc.id, dl: currentDl(s) };
  },
  imports: () => {
    const s = useStore.getState();
    return s.alignmentService.contents(s.model, s.ext.loaded);
  },
});

type Run = { state: 'idle' } | { state: 'running' } | { state: 'error'; message: string } | { state: 'done'; answer: SparqlAnswer; ms: number };

const csvCell = (c: SparqlCell | null) => {
  const v = c ? (c.kind === 'literal' ? c.value : c.text) : '';
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function SparqlView() {
  const model = useStore((s) => s.model);
  const docId = useStore((s) => s.doc.id);
  const focusTerm = useStore((s) => s.focusTerm);
  const examples = examplesFor(model.mode);
  const [query, setQuery] = useState(() => savedQuery(model.mode));
  const [graph, setGraph] = useState<SparqlGraph>(() => savedGraph(model.mode));
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const token = useRef(0);
  // A query can return tens of thousands of rows; drawing them all at once freezes the page.
  const [shown, setShown] = useState(ROWS);
  const iris = useMemo(() => termIris(model), [model]);

  const execute = async (text = query, choice = graph) => {
    const mine = ++token.current;
    setShown(ROWS);
    setRun({ state: 'running' });
    const mode = useStore.getState().model.mode;
    remember(`${QUERY_KEY}:${mode}`, text);
    remember(`${GRAPH_KEY}:${mode}`, choice);
    try {
      let now = useStore.getState();
      // The OWL 2 DL reasoner is asked here, as the owl-inferred export asks it, when the inferred graph is wanted from it.
      if (choice === 'inferred' && now.validation.engine === 'dl' && !currentDl(now)) {
        await now.runValidation('owl');
        if (mine !== token.current) return;
        now = useStore.getState();
      }
      const t0 = performance.now();
      const answer = await SERVICE.query({ ...ontologyRef(now.model, now.doc.id), text, graph: choice });
      if (mine === token.current) setRun({ state: 'done', answer, ms: Math.max(1, Math.round(performance.now() - t0)) });
    } catch (e) {
      if (mine !== token.current) return;
      if (e instanceof SparqlError) {
        if (e.code === 'aborted') return;
        // The ontology was edited while the query was out: ask about it as it is now.
        if (e.code === 'stale-revision') return void execute(text, choice);
      }
      setRun({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Show something straight away: run the remembered query when the view opens.
  useEffect(() => {
    void execute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result = run.state === 'done' ? run.answer.result : undefined;
  const current = ontologyRef(model, docId);
  const stale = run.state === 'done' && (run.answer.ontologyId !== current.ontologyId || run.answer.revisionId !== current.revisionId);
  const summary =
    run.state === 'running'
      ? 'Running…'
      : run.state === 'done'
        ? `${result!.type === 'ask' ? 'Answered' : `${result!.rows.length} ${result!.type === 'graph' ? 'triples' : result!.rows.length === 1 ? 'row' : 'rows'}`} in ${run.ms} ms · ${GRAPH_READ[run.answer.graph]}`
        : '';

  const saveCsv = () => {
    if (!result || result.type === 'ask') return;
    download('query-results.csv', '﻿' + [result.vars.join(','), ...result.rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n', 'text/csv');
  };

  return (
    <div className="view">
      <div className="sparql-editor">
        <div className="row">
          <select
            aria-label="Example queries"
            value=""
            onChange={(e) => {
              const ex = e.target.value === '' ? undefined : examples[+e.target.value];
              if (!ex) return;
              setQuery(ex.query);
              void execute(ex.query);
            }}
          >
            <option value="">Examples…</option>
            {examples.map((ex, i) => (
              <option key={ex.name} value={i}>
                {ex.name}
              </option>
            ))}
          </select>
          <span className="muted">
            Prefixes <code>:</code> <code>owl:</code> <code>rdf:</code> <code>rdfs:</code> <code>skos:</code> <code>xsd:</code> are declared for you.
          </span>
          <span className="spacer" />
          <label className="field">
            <span>Read from</span>
            <select
              aria-label="What the query reads"
              title="What the query reads: the ontology as stated, together with what it imports, or with what a reasoner infers"
              value={graph}
              onChange={(e) => {
                const choice = e.target.value as SparqlGraph;
                setGraph(choice);
                void execute(query, choice);
              }}
            >
              {GRAPHS.map((g) => (
                <option key={g} value={g}>
                  {GRAPH_LABEL[g]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          value={query}
          spellCheck={false}
          aria-label="SPARQL query"
          rows={9}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void execute();
            }
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              const el = e.currentTarget;
              el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
              setQuery(el.value);
            }
          }}
        />
        <div className="row">
          <button className="btn primary" disabled={run.state === 'running' || !query.trim()} onClick={() => void execute()} title="Ctrl+Enter">
            Run query
          </button>
          <span className="muted" role="status">
            {summary}
            {stale && ' · the model has changed since; run again to refresh.'}
          </span>
          <span className="spacer" />
          {result && result.type !== 'ask' && result.rows.length > 0 && (
            <button className="btn" onClick={saveCsv}>
              Download CSV
            </button>
          )}
        </div>
      </div>

      <div className="table-wrap">
        {run.state === 'done' && run.answer.notes.length > 0 && <p className="muted pad">{run.answer.notes.join(' ')}</p>}
        {run.state === 'error' && <pre className="sparql-error">{run.message}</pre>}
        {result?.type === 'ask' && <div className="ask">{result.value ? 'Yes (true)' : 'No (false)'}</div>}
        {result && result.type !== 'ask' && (
          <>
            <table className="results">
              <thead>
                <tr>
                  {result.vars.map((v) => (
                    <th key={v}>{result.type === 'select' ? '?' + v : v}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, shown).map((row, i) => (
                  <tr key={i}>
                    {row.map((c, j) => {
                      const termId = c?.kind === 'iri' ? iris.get(c.value) : undefined;
                      return (
                        <td key={j} className={c ? c.kind + (c.text.startsWith(':') ? ' own' : '') : 'unbound'} title={c?.kind === 'iri' ? c.value : undefined}>
                          {!c ? (
                            '—'
                          ) : termId ? (
                            <button className="link" title={`${c.value}\nShow on the canvas`} onClick={() => focusTerm(termId)}>
                              {c.text}
                            </button>
                          ) : (
                            c.text
                          )}
                          {c?.lang && <span className="lang">@{c.lang}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {!result.rows.length && <p className="muted pad">The query ran, but nothing matched.</p>}
            {result.rows.length > shown && (
              <p className="pager">
                Showing the first {shown} of {result.rows.length} rows.
                <button className="btn small" onClick={() => setShown(shown + 2000)}>
                  Show 2000 more
                </button>
                <span className="muted">Download CSV has all of them.</span>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
