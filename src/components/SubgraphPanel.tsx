import { useMemo, useState, type ReactNode } from 'react';
import { nameIn } from '../model/labels';
import { stable } from '../model/stable';
import { useStore, type GraphScope } from '../model/store';
import { edgeTypes, MAX_DEPTH, searchTerms, type Direction } from '../model/subgraph';
import { LayoutBar, LayoutOptions } from './LayoutControls';

/**
 * The switch between the full graph and a subgraph, and the settings of the subgraph: the terms
 * it starts from, how far to go, in which direction, and through which kinds of relationship.
 */
/** `tools` are further buttons of the canvas, shown in the same bar: what it draws besides the model itself. */
export function SubgraphPanel({ tools }: { tools?: ReactNode }) {
  const model = stable(useStore((s) => s.model));
  const displayLang = useStore((s) => s.displayLang);
  const sub = useStore((s) => s.subgraph);
  const stylePanel = useStore((s) => s.stylePanel);
  const selected = useStore((s) => s.sel.terms);
  const st = useStore.getState;
  // One set of settings is open at a time: the bar is over the graph, and should cover little of it.
  const [panel, setPanel] = useState<'subgraph' | 'layout' | null>(null);
  const open = panel === 'subgraph';
  const setOpen = (on: boolean) => setPanel(on ? 'subgraph' : null);
  const [query, setQuery] = useState('');
  const name = useMemo(() => new Map(model.terms.map((t) => [t.id, nameIn(t, model.lang, displayLang) || 'Unnamed'])), [model.terms, model.lang, displayLang]);
  const types = useMemo(() => edgeTypes(model), [model]);
  const found = useMemo(() => searchTerms(model, query, 8, displayLang).filter((t) => !sub.roots.includes(t.id)), [model, query, sub.roots, displayLang]);
  const roots = sub.roots.filter((id) => name.has(id));
  const scope = useStore((s) => s.graphScope);
  const hasExternal = model.terms.some((t) => t.external !== undefined);
  const addRoots = (ids: string[]) => st().setSubgraph({ roots: [...new Set([...sub.roots, ...ids])] });
  const toAdd = selected.filter((id) => !sub.roots.includes(id));
  const shown = sub.active && sub.result ? sub.result : null;

  return (
    <div className={'subgraph' + (panel === 'layout' ? ' narrow' : '')} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="row">
        <div className="tabs" role="group" aria-label="Visualization mode">
          <button className={sub.active ? '' : 'on'} aria-pressed={!sub.active} onClick={() => st().showFullGraph()}>
            Full graph
          </button>
          <button
            className={sub.active ? 'on' : ''}
            aria-pressed={sub.active}
            onClick={() => {
              setOpen(true);
              if (sub.active) return;
              // Straight in when there is something to show: the subgraph as it was left, or else the current selection.
              if (sub.roots.length && Object.keys(sub.pos).length) return st().resumeSubgraph();
              if (!sub.roots.length && selected.length) addRoots(selected);
              if (sub.roots.length || selected.length) st().visualizeSubgraph();
            }}
          >
            Subgraph
          </button>
        </div>
        {!sub.active && hasExternal && (
          <select aria-label="What the graph shows" title="What the full graph shows" value={scope} onChange={(e) => st().setGraphScope(e.target.value as GraphScope)}>
            <option value="all">Everything</option>
            <option value="local">This ontology only</option>
            <option value="alignment">Mappings only</option>
          </select>
        )}
        <button className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide settings' : 'Settings'}
        </button>
        <button className="btn small" aria-pressed={stylePanel} title="How terms and relationships are drawn: shapes, colours, lines, themes" onClick={() => st().setStylePanel(!stylePanel)}>
          Style
        </button>
        <LayoutBar open={panel === 'layout'} onToggle={() => setPanel(panel === 'layout' ? null : 'layout')} />
        {tools}
        {shown && (
          <span className="subgraph-count" role="status">
            {shown.terms.length} of {model.terms.length} terms
          </span>
        )}
      </div>

      {panel === 'layout' && <LayoutOptions />}
      {open && (
        <div className="subgraph-body">
          <label className="field">
            <span>Start from</span>
            <input type="search" value={query} placeholder="Search by name or IRI…" aria-label="Search for a term to start from" onChange={(e) => setQuery(e.target.value)} />
          </label>
          {query.trim() && (
            <ul className="subgraph-found">
              {found.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => {
                      addRoots([t.id]);
                      setQuery('');
                    }}
                  >
                    {t.name} <span className="muted">{t.type === 'concept' ? '' : t.type === 'property' ? 'data property' : 'individual'}</span>
                  </button>
                </li>
              ))}
              {!found.length && <li className="muted">No other term matches.</li>}
            </ul>
          )}
          {toAdd.length > 0 && (
            <button className="btn small" onClick={() => addRoots(toAdd)}>
              Add the {toAdd.length === 1 ? `selected term “${name.get(toAdd[0])}”` : `${toAdd.length} selected terms`}
            </button>
          )}
          <div className="chips-inline">
            {roots.map((id) => (
              <span key={id} className="chip-x">
                <button className="link" title="Show on the canvas" onClick={() => sub.active && st().focusTerm(id)}>
                  {name.get(id)}
                </button>
                <button aria-label={`Remove ${name.get(id)}`} title="Remove" onClick={() => st().setSubgraph({ roots: sub.roots.filter((x) => x !== id) })}>
                  ×
                </button>
              </span>
            ))}
          </div>
          {!roots.length && <p className="muted">No terms chosen yet. Search above, or select terms on the canvas and add them.</p>}

          <div className="field two">
            <label>
              <span>Depth</span>
              <select aria-label="Depth" value={sub.depth} onChange={(e) => st().setSubgraph({ depth: Number(e.target.value) })}>
                {Array.from({ length: MAX_DEPTH + 1 }, (_, d) => (
                  <option key={d} value={d}>
                    {d === 0 ? '0: chosen terms only' : d === 1 ? '1: direct neighbours' : `${d} steps`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Direction</span>
              <select aria-label="Direction" value={sub.direction} onChange={(e) => st().setSubgraph({ direction: e.target.value as Direction })}>
                <option value="both">Both</option>
                <option value="out">Outgoing</option>
                <option value="in">Incoming</option>
              </select>
            </label>
          </div>

          <fieldset className="field subgraph-types">
            <legend>Relationships to follow</legend>
            {types.map((t) => (
              <label key={t.key} className="check">
                <input
                  type="checkbox"
                  checked={!sub.off.includes(t.key)}
                  onChange={(e) => st().setSubgraph({ off: e.target.checked ? sub.off.filter((k) => k !== t.key) : [...sub.off, t.key] })}
                />
                <span>
                  {t.label} <span className="muted">{t.count}</span>
                </span>
              </label>
            ))}
            {!types.length && <span className="muted">The model has no relationships yet.</span>}
          </fieldset>

          <label className="field">
            <span>Show at most</span>
            <select aria-label="Maximum number of terms" value={sub.maxNodes} onChange={(e) => st().setSubgraph({ maxNodes: Number(e.target.value) })}>
              {[50, 100, 250, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n} terms
                </option>
              ))}
            </select>
          </label>

          {shown?.truncated && (
            <p className="subgraph-warning" role="alert">
              Cut off at {sub.maxNodes} terms. Lower the depth, switch off some relationships, or raise the limit.
            </p>
          )}
          {sub.active && sub.hidden.length > 0 && (
            <button className="btn small" onClick={() => st().setSubgraph({ hidden: [] })}>
              Bring back {sub.hidden.length} hidden {sub.hidden.length === 1 ? 'term' : 'terms'}
            </button>
          )}

          <div className="row">
            <button className="btn primary small" disabled={!roots.length} onClick={() => st().visualizeSubgraph()}>
              {sub.active ? 'Redraw subgraph' : 'Visualize subgraph'}
            </button>
            <button
              className="btn small"
              disabled={!sub.roots.length && !sub.active}
              onClick={() => {
                st().setSubgraph({ roots: [], expanded: [], hidden: [] });
                st().showFullGraph();
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
