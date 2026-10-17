import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../model/store';
import type { Difference, StateRef, VersionInfo } from '../projects/contracts';
import { nothingChanged } from '../projects/difference';
import { createLocalProjectService } from '../projects/local';

/**
 * The versions of the model open (roadmap task 2.3, FR-M10-1 to FR-M10-3): saved with a name and
 * a line about them, listed newest first, compared with each other or with the model as it is
 * now, entity by entity, and restored as a new version, so that none is ever taken away.
 * Versions are kept for a model in My Models, in this browser.
 */

const projects = createLocalProjectService({
  current: () => useStore.getState().model,
  // A version restored is one edit of the model, which undo takes back.
  replace: (model) => useStore.getState().apply(() => model),
});

const SHOWN = 200;

export function VersionsDialog() {
  const project = useStore((s) => s.doc.id);
  const name = useStore((s) => s.model.name);
  const st = useStore.getState;
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('current');
  const [result, setResult] = useState<{ d: Difference; from: string; to: string } | 'working' | null>(null);
  const close = () => st().setDialog(null);
  // Only the most recently begun read may set the list: a read begun when the dialog opened can
  // answer after the one that follows a save, and would put back the versions as they were then.
  const loads = useRef(0);
  const load = useCallback(async () => {
    if (!project) return;
    const begun = ++loads.current;
    try {
      const list = await projects.versions(project);
      if (begun !== loads.current) return;
      setVersions(list);
      setFrom((f) => f || list[0]?.id || '');
    } catch (e) {
      if (begun !== loads.current) return;
      st().notify(`The versions could not be read: ${e instanceof Error ? e.message : ''}`);
      setVersions([]);
    }
  }, [project, st]);
  useEffect(() => void load(), [load]);

  const label = (ref: string) => (ref === 'current' ? 'the model now' : `version ${versions?.find((v) => v.id === ref)?.seq ?? '?'}`);
  const ref = (id: string): StateRef => (id === 'current' ? 'current' : { version: id });
  const compare = async (a: string, b: string) => {
    if (!project || !a || a === b) return;
    setFrom(a);
    setTo(b);
    setResult('working');
    try {
      setResult({ d: await projects.diff(project, ref(a), ref(b)), from: a, to: b });
    } catch (e) {
      setResult(null);
      st().notify(`Could not compare them: ${e instanceof Error ? e.message : ''}`);
    }
  };
  const save = async () => {
    if (!project || !title.trim()) return;
    try {
      const v = await projects.saveVersion(project, title, summary);
      setTitle('');
      setSummary('');
      await load();
      st().notify(`Saved as version ${v.seq}, “${v.name}”.`);
    } catch (e) {
      st().notify(`Not saved: ${e instanceof Error ? e.message : ''}`);
    }
  };
  const restore = async (v: VersionInfo) => {
    if (!project || !window.confirm(`Restore version ${v.seq}, “${v.name}”? The model becomes what it was then, which undo takes back, and that is saved as a new version. No version is taken away.`)) return;
    try {
      const made = await projects.restore(project, v.id);
      setResult(null);
      await load();
      st().notify(`Version ${v.seq} restored, and saved as version ${made.seq}.`);
    } catch (e) {
      st().notify(`Not restored: ${e instanceof Error ? e.message : ''}`);
    }
  };

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog versions" role="dialog" aria-modal="true" aria-labelledby="versions-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="versions-title">Versions of “{name}”</h2>
        {!project ? (
          <>
            <p>Versions are kept for a model in My Models, in this browser. Save this model there first.</p>
            <div className="dialog-actions">
              <span className="spacer" />
              <button className="btn" onClick={close}>
                Close
              </button>
              <button className="btn primary" onClick={() => st().setDialog('saveas')}>
                Save to My Models…
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="version-save">
              <label className="field">
                <span>Name</span>
                <input aria-label="Name of the version" value={title} placeholder="Before restructuring Person" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
              </label>
              <label className="field grow">
                <span>What it is</span>
                <input aria-label="What the version is" value={summary} placeholder="In a line, for whoever looks back" onChange={(e) => setSummary(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
              </label>
              <button className="btn primary" disabled={!title.trim()} onClick={() => void save()}>
                Save a version
              </button>
            </div>
            <div className="version-list" aria-label="Versions">
              {versions === null && <p className="muted">Reading the versions…</p>}
              {versions?.length === 0 && <p className="muted">No versions yet. A version keeps the model as it is now, with what its shape sets and data graphs are, to compare with and come back to.</p>}
              {versions?.map((v) => (
                <div key={v.id} className={'version' + (result !== null && result !== 'working' && (result.from === v.id || result.to === v.id) ? ' on' : '')} data-version={v.seq}>
                  <span className="seq">{v.seq}</span>
                  <span className="what">
                    <strong>{v.name}</strong>
                    <span className="muted">
                      {new Date(v.created).toLocaleString()} · {v.entities} entities{v.summary ? ` · ${v.summary}` : ''}
                    </span>
                  </span>
                  <button className="btn small" onClick={() => void compare(v.id, 'current')}>
                    Compare with now
                  </button>
                  <button className="btn small" onClick={() => void restore(v)}>
                    Restore…
                  </button>
                </div>
              ))}
            </div>
            {!!versions?.length && (
              <div className="version-compare">
                <span>Compare</span>
                <select aria-label="Compare from" value={from} onChange={(e) => setFrom(e.target.value)}>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      Version {v.seq}: {v.name}
                    </option>
                  ))}
                  <option value="current">The model now</option>
                </select>
                <span>with</span>
                <select aria-label="Compare with" value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="current">The model now</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      Version {v.seq}: {v.name}
                    </option>
                  ))}
                </select>
                <button className="btn small" disabled={from === to} onClick={() => void compare(from, to)}>
                  Compare
                </button>
              </div>
            )}
            {result === 'working' && (
              <p className="muted" role="status">
                Comparing…
              </p>
            )}
            {result !== null && result !== 'working' && <DifferenceView d={result.d} title={`From ${label(result.from)} to ${label(result.to)}`} />}
            <div className="dialog-actions">
              <span className="spacer" />
              <button className="btn" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** What differs, entity by entity, then the shape sets, the data graphs and the rest. */
function DifferenceView({ d, title }: { d: Difference; title: string }) {
  const st = useStore.getState;
  const model = useStore((s) => s.model);
  const [all, setAll] = useState(false);
  const count = (s: string) => d.entities.filter((e) => e.status === s).length;
  const byIri = useMemo(() => new Map<string, { term: string } | { prop: string }>([...model.terms.filter((t) => t.iri).map((t): [string, { term: string }] => [t.iri!, { term: t.id }]), ...model.props.filter((p) => p.iri).map((p): [string, { prop: string }] => [p.iri!, { prop: p.id }])]), [model]);
  const open = (iri: string) => {
    const at = byIri.get(iri);
    if (at && 'term' in at) st().select([at.term]);
    else if (at) st().selectProp(at.prop);
  };
  const sign = (op: 'add' | 'remove') => (op === 'add' ? '+' : '−');
  return (
    <section className="difference" aria-label="Difference">
      <h3>{title}</h3>
      {nothingChanged(d) ? (
        <p className="nothing">No changes to the ontology{d.drawing ? '. Only where terms sit, or how the graph is drawn, changed.' : '.'}</p>
      ) : (
        <p className="muted">
          {[count('changed') && `${count('changed')} entit${count('changed') === 1 ? 'y' : 'ies'} changed`, count('added') && `${count('added')} added`, count('removed') && `${count('removed')} removed`].filter(Boolean).join(', ') || 'No entity changed'} · {d.axioms.added} axiom{d.axioms.added === 1 ? '' : 's'} added, {d.axioms.removed} removed
          {d.shapeSets.length ? ` · ${d.shapeSets.length} shape set${d.shapeSets.length === 1 ? '' : 's'}` : ''}
          {d.logicalModels.length ? ` · ${d.logicalModels.length} logical model${d.logicalModels.length === 1 ? '' : 's'}` : ''}
          {d.drawing ? ' · and the drawing' : ''}
        </p>
      )}
      <ul className="diff-entities">
        {d.entities.slice(0, all ? undefined : SHOWN).map((e) => (
          <li key={e.iri || e.kind} data-entity={e.iri}>
            <div className="diff-head">
              {e.iri && byIri.has(e.iri) ? (
                <button className="link" title="Open it in the editor" onClick={() => open(e.iri)}>
                  {e.name}
                </button>
              ) : (
                <strong>{e.name}</strong>
              )}
              <span className="muted">{e.kind}</span>
              <span className={'tag ' + e.status}>{e.status}</span>
            </div>
            <ul>
              {e.changes.map((l, i) => (
                <li key={i} className={l.op}>
                  <code>
                    {sign(l.op)} {l.text}
                  </code>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {d.entities.length > SHOWN && !all && (
        <button className="btn small" onClick={() => setAll(true)}>
          Show all {d.entities.length}
        </button>
      )}
      {d.shapeSets.length > 0 && (
        <>
          <h4>Shape sets</h4>
          <ul className="diff-entities">
            {d.shapeSets.map((s) => (
              <li key={s.id}>
                <div className="diff-head">
                  <strong>{s.name}</strong>
                  <span className={'tag ' + s.status}>{s.status}</span>
                  {s.renamed && <span className="muted">{s.renamed}</span>}
                </div>
                <ul>
                  {s.changes.map((l, i) => (
                    <li key={i} className={l.op}>
                      <code>
                        {sign(l.op)} {l.text}
                      </code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.logicalModels.length > 0 && (
        <>
          <h4>Logical models</h4>
          <ul className="diff-entities diff-logical">
            {d.logicalModels.map((l) => (
              <li key={l.id} data-ldm={l.id}>
                <div className="diff-head">
                  <strong>{l.name}</strong>
                  <span className="muted">logical model</span>
                  <span className={'tag ' + l.status}>{l.status}</span>
                </div>
                <ul>
                  {l.changes.map((c, i) => (
                    <li key={i} className={c.op === 'update' ? 'update' : c.op}>
                      <code>
                        {c.op === 'add' ? '+' : c.op === 'remove' ? '−' : '~'} {c.kind === 'model' ? 'the model' : `${c.kind} ${c.name}`}
                        {c.fields ? `: ${c.fields.map((f) => `${f.field} ${f.before} → ${f.after}`).join('; ')}` : ''}
                      </code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.dataGraphs.length > 0 && (
        <>
          <h4>Data graphs</h4>
          <ul className="diff-plain">
            {d.dataGraphs.map((g) => (
              <li key={g.id}>
                {g.name} <span className={'tag ' + g.status}>{g.status === 'replaced' ? 'read from another file' : g.status}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.settings.length > 0 && <p className="muted">Also changed, and no part of the ontology: {d.settings.join(', ')}.</p>}
    </section>
  );
}
