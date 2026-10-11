import { useEffect, useMemo, useRef, useState } from 'react';
import { download } from '../model/files';
import { termIris } from '../model/rdf';
import { examplesFor, runSparql, type Cell, type SparqlResult } from '../model/sparql';
import { useStore } from '../model/store';
import type { Model } from '../model/types';

const QUERY_KEY = 'conceptweaver:sparql';
const ROWS = 500;

/** The last query run for this type of model; SKOS and OWL queries don't carry over to each other. */
function savedQuery(mode: Model['mode']): string {
  try {
    return localStorage.getItem(`${QUERY_KEY}:${mode}`) || examplesFor(mode)[0].query;
  } catch {
    return examplesFor(mode)[0].query;
  }
}

type Run = { state: 'idle' } | { state: 'running' } | { state: 'error'; message: string } | { state: 'done'; result: SparqlResult; ms: number; model: Model };

const csvCell = (c: Cell | null) => {
  const v = c ? (c.kind === 'literal' ? c.value : c.text) : '';
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function SparqlView() {
  const model = useStore((s) => s.model);
  const focusTerm = useStore((s) => s.focusTerm);
  const examples = examplesFor(model.mode);
  const [query, setQuery] = useState(() => savedQuery(model.mode));
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const token = useRef(0);
  // A query can return tens of thousands of rows; drawing them all at once freezes the page.
  const [shown, setShown] = useState(ROWS);
  const iris = useMemo(() => termIris(model), [model]);

  const execute = async (text = query) => {
    const mine = ++token.current;
    setShown(ROWS);
    setRun({ state: 'running' });
    try {
      localStorage.setItem(`${QUERY_KEY}:${useStore.getState().model.mode}`, text);
    } catch {
      // The query just isn't remembered.
    }
    const current = useStore.getState().model;
    const t0 = performance.now();
    try {
      const result = await runSparql(current, text);
      if (mine === token.current) setRun({ state: 'done', result, ms: Math.max(1, Math.round(performance.now() - t0)), model: current });
    } catch (e) {
      if (mine === token.current) setRun({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Show something straight away: run the remembered query when the view opens.
  useEffect(() => {
    void execute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result = run.state === 'done' ? run.result : undefined;
  const stale = run.state === 'done' && run.model !== model;
  const summary =
    run.state === 'running'
      ? 'Running…'
      : run.state === 'done'
        ? `${result!.type === 'ask' ? 'Answered' : `${result!.rows.length} ${result!.type === 'graph' ? 'triples' : result!.rows.length === 1 ? 'row' : 'rows'}`} in ${run.ms} ms`
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
