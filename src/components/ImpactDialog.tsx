import { useEffect, useMemo, useState } from 'react';
import type { ElementRef } from '../logical/contracts';
import { useStore } from '../model/store';
import type { VersionInfo } from '../projects/contracts';
import { createLocalProjectService } from '../projects/local';
import type { ImpactItem, ImpactKind, ImpactReport, SynchronizationProposal, SynchronizationResult } from '../traceability/contracts';

/**
 * Impact of the ontology on a logical model, and reviewed synchronization (roadmap LM-4;
 * FR-M18-10 to FR-M18-13, ADR-025). The report reads the ontology now against each mapping’s
 * origin, or two saved versions against each other; synchronization offers additions, updates,
 * records and removals for review. Nothing is chosen for the user, an element they changed is
 * never chosen to begin with, and applying is one change set of the LDM — the ontology is never
 * written, and the LDM never moves by itself.
 */

const KIND_TITLE: Record<ImpactKind, string> = {
  'not-represented': 'Not represented',
  'source-removed': 'Source gone',
  'target-removed': 'Element deleted',
  'type-changed': 'Type changed',
  'cardinality-changed': 'Cardinality changed',
  'hierarchy-changed': 'Hierarchy changed',
  'restriction-changed': 'Restriction changed',
  renamed: 'Renamed',
  'axiom-changed': 'Axiom changed',
};
const KIND_ORDER = Object.keys(KIND_TITLE) as ImpactKind[];
const SYNC_TITLE = { add: 'Additions', update: 'Updates', remove: 'Removals', record: 'Recorded, changing nothing' } as const;
const SYNC_ORDER = ['add', 'update', 'record', 'remove'] as const;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dismissedKey = (project: string | null, model: string) => `cw.impact.dismissed.${project ?? 'working'}.${model}`;

const projects = createLocalProjectService({ current: () => useStore.getState().model, replace: () => undefined });

/** A proposal and everything it requires, transitively. */
function withRequires(result: SynchronizationResult, id: string): string[] {
  const ids = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const next = todo.pop()!;
    if (ids.has(next)) continue;
    ids.add(next);
    todo.push(...(result.proposals.find((p) => p.id === next)?.requires ?? []));
  }
  return [...ids];
}

/** What is chosen to begin with: everything not about an element the user changed, and no two that touch one element. */
function initiallyChosen(result: SynchronizationResult): Set<string> {
  const chosen = new Set<string>();
  for (const p of result.proposals) {
    if (p.customised) continue;
    if (p.excludes.some((x) => chosen.has(x))) continue;
    for (const id of withRequires(result, p.id)) chosen.add(id);
  }
  return chosen;
}

export function ImpactDialog() {
  const view = useStore((s) => s.ldmView);
  const ontology = useStore((s) => s.model);
  const project = useStore((s) => s.doc.id);
  const st = useStore.getState;
  const target = ontology.logicalModels.find((m) => m.id === view.model) ?? ontology.logicalModels[0] ?? null;
  const close = () => st().setDialog(null);

  const [mode, setMode] = useState<'now' | 'versions'>('now');
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState<'current' | string>('current');
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [sync, setSync] = useState<SynchronizationResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [running, setRunning] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const key = dismissedKey(project, target?.id ?? '');

  useEffect(() => {
    if (!project) return;
    projects
      .versions(project)
      .then((list) => {
        setVersions(list);
        setFrom((was) => was || list[0]?.id || '');
      })
      .catch(() => setVersions([]));
  }, [project]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setDismissed(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setDismissed([]);
    }
  }, [key]);

  const saveDismissed = (next: string[]) => {
    setDismissed(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // The dismissal just isn't remembered past this visit.
    }
  };

  const revision = target?.revision;
  useEffect(() => {
    if (!target) return;
    let live = true;
    setRunning(true);
    setError('');
    setSync(null);
    setChosen(new Set());
    if (mode === 'versions' && !versions?.length) {
      // Versions are still loading, or there are none: the controls say which.
      setReport(null);
      setRunning(false);
      return;
    }
    if (mode === 'versions' && (!from || (to !== 'current' && to === from))) {
      setReport(null);
      setRunning(false);
      setError('Choose two different versions, or the model now.');
      return;
    }
    const query =
      mode === 'versions'
        ? { model: target.id, between: { from: { version: from }, to: to === 'current' ? ('current' as const) : { version: to } } }
        : { model: target.id };
    useStore
      .getState()
      .traceabilityService.impact(query)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(said(e)))
      .finally(() => live && setRunning(false));
    return () => {
      live = false;
    };
  }, [target?.id, revision, mode, from, to, versions, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const out = new Map<ImpactKind, ImpactItem[]>();
    for (const kind of KIND_ORDER) {
      const here = report?.items.filter((i) => i.kind === kind) ?? [];
      if (here.length) out.set(kind, here);
    }
    return out;
  }, [report]);

  const synchronize = async () => {
    if (!target) return;
    setSync(null);
    setSyncing(true);
    setError('');
    setNote('');
    try {
      const result = await useStore.getState().traceabilityService.synchronize({ model: target.id, ...(dismissed.length ? { dismissed } : {}) });
      setSync(result);
      setChosen(initiallyChosen(result));
      if (!result.proposals.length) setNote('Nothing is offered: no mapping needs a change, or what was offered was turned down.');
    } catch (e) {
      setError(said(e));
    } finally {
      setSyncing(false);
    }
  };

  const toggle = (proposal: SynchronizationProposal, on: boolean) => {
    if (!sync) return;
    setChosen((was) => {
      const next = new Set(was);
      if (on) {
        for (const id of withRequires(sync, proposal.id)) next.add(id);
        for (const x of proposal.excludes) next.delete(x);
      } else {
        next.delete(proposal.id);
        // A proposal that requires this one cannot stay chosen without it.
        let shrank = true;
        while (shrank) {
          shrank = false;
          for (const p of sync.proposals) {
            if (next.has(p.id) && p.requires.some((r) => !next.has(r))) {
              next.delete(p.id);
              shrank = true;
            }
          }
        }
      }
      return next;
    });
  };

  const apply = async () => {
    if (!sync) return;
    setRunning(true);
    setError('');
    try {
      const applied = await useStore.getState().traceabilityService.apply({ result: sync, accepted: [...chosen] });
      useStore.getState().notify(`Synchronized ${plural(applied.applied, 'proposal')}; undo takes it back.`);
      setNote(`Applied ${plural(applied.applied, 'proposal')}. The mappings now remember what the ontology says.`);
      setSync(null);
      setChosen(new Set());
    } catch (e) {
      setError(said(e));
    } finally {
      setRunning(false);
    }
  };

  const open = (ref: ElementRef | undefined) => {
    if (!ref || !target) return;
    close();
    useStore.getState().openLogical(target.id, ref);
  };

  if (!target) {
    return (
      <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="impact-title">
          <h2 id="impact-title">Impact</h2>
          <p className="muted">Make a logical model first.</p>
          <div className="dialog-actions">
            <button className="btn" onClick={close}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const chosenCount = sync ? sync.proposals.filter((p) => chosen.has(p.id)).length : 0;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog impact-dialog" role="dialog" aria-modal="true" aria-labelledby="impact-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="impact-title">Impact on “{target.name}”</h2>
        <p className="muted">What the ontology means for this model, and what it could do about it. Nothing is changed until you say so, and the ontology is never written.</p>

        <div className="impact-controls">
          <label className="field">
            <span>Compare</span>
            <select aria-label="What to compare the ontology with" value={mode} onChange={(e) => setMode(e.target.value as 'now' | 'versions')}>
              <option value="now">The ontology now, with each mapping’s origin</option>
              <option value="versions">Two saved versions</option>
            </select>
          </label>
          {mode === 'versions' && (
            <>
              <label className="field">
                <span>From</span>
                <select aria-label="The earlier version" value={from} onChange={(e) => setFrom(e.target.value)}>
                  {(versions ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.seq}. {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>To</span>
                <select aria-label="The later version" value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="current">The model now</option>
                  {(versions ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.seq}. {v.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {mode === 'versions' && !versions?.length && <p className="muted">No saved versions yet. Save one in Versions first, or compare with the ontology now.</p>}
          <button className="btn small" disabled={running} onClick={() => setNonce((n) => n + 1)}>
            Refresh
          </button>
        </div>

        {running && <p className="muted">Reading the ontology…</p>}
        {error && <p className="warn">{error}</p>}
        {report && !running && (
          <>
            <p className="muted impact-compared">
              Compared: {report.compared.from} → {report.compared.to}. {plural(report.items.length, 'impact')}, {report.coverage.counts.sourced} of {report.coverage.counts.elements} elements sourced.
            </p>
            {!report.items.length ? (
              <p className="muted">Nothing in the ontology has moved since these mappings were made.</p>
            ) : (
              <div className="impact-items">
                {[...groups.entries()].map(([kind, items]) => (
                  <section key={kind} className="impact-group" data-kind={kind}>
                    <h3>
                      {KIND_TITLE[kind]} ({items.length})
                    </h3>
                    {items.map((item) => (
                      <article key={item.id} className={'impact-item' + (item.customised ? ' customised' : '')}>
                        <div>
                          <strong>{item.title}</strong>
                          {item.customised && <span className="tag">You changed this element</span>}
                        </div>
                        <p className="muted">{item.detail}</p>
                        {item.changed && !!item.changed.removed.length && (
                          <details>
                            <summary>No longer stated ({item.changed.removed.length})</summary>
                            <code className="axiom">{item.changed.removed.join('\n')}</code>
                          </details>
                        )}
                        {item.changed && !!item.changed.added.length && (
                          <details>
                            <summary>Newly stated ({item.changed.added.length})</summary>
                            <code className="axiom">{item.changed.added.join('\n')}</code>
                          </details>
                        )}
                        {item.target && (
                          <button className="link" onClick={() => open(item.target)}>
                            Open it
                          </button>
                        )}
                      </article>
                    ))}
                  </section>
                ))}
              </div>
            )}
          </>
        )}

        {mode === 'now' && (
          <div className="impact-sync-actions">
            <button className="btn primary" disabled={running || syncing} onClick={() => void synchronize()}>
              {syncing ? 'Working out the synchronization…' : 'Synchronize…'}
            </button>
            <span className="muted">Proposals only: you choose what, if anything, is applied.</span>
          </div>
        )}
        {note && <p className="muted">{note}</p>}

        {sync && (
          <div className="impact-proposals" aria-label="Synchronization proposals">
            {!sync.proposals.length && <p className="muted">Nothing to synchronize. Dismissed proposals come back once the ontology says something new about their sources.</p>}
            {SYNC_ORDER.map((kind) => {
              const here = sync.proposals.filter((p) => p.kind === kind);
              if (!here.length) return null;
              return (
                <section key={kind} className="proposal-group" data-kind={kind}>
                  <header>
                    <h3>
                      {SYNC_TITLE[kind]} ({here.length})
                    </h3>
                  </header>
                  {here.map((p) => (
                    <article key={p.id} className={'proposal' + (chosen.has(p.id) ? ' on' : '') + (p.customised ? ' customised' : '')} data-proposal={p.id}>
                      <label className="check">
                        <input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => toggle(p, e.target.checked)} aria-label={`Choose ${p.title}`} />
                        <strong>{p.title}</strong>
                        {p.customised && <span className="tag">Not chosen to begin with: you changed this element</span>}
                      </label>
                      {p.customised && <p className="muted">Accepting this would replace what you changed. It is offered, never chosen for you.</p>}
                      <p className="muted">{p.elements.join(' · ')}</p>
                      <dl>
                        <dt>Strategy</dt>
                        <dd>{p.strategy}</dd>
                        <dt>Why</dt>
                        <dd>{p.rationale}</dd>
                        <dt>Differs</dt>
                        <dd>{p.difference}</dd>
                      </dl>
                      {p.sources.some((s) => s.axioms.length) && (
                        <details>
                          <summary>What the ontology says of its sources now</summary>
                          {p.sources.map((s) => (
                            <code key={s.iri} className="axiom" title={s.iri}>
                              {s.axioms.join('\n')}
                            </code>
                          ))}
                        </details>
                      )}
                      {p.excludes.length > 0 && <p className="muted">Cannot be applied with another chosen proposal: they change the same elements.</p>}
                      <button
                        className="link"
                        onClick={async () => {
                          saveDismissed([...new Set([...dismissed, p.fingerprint])]);
                          setSync({ ...sync, proposals: sync.proposals.filter((x) => x.id !== p.id) });
                          setChosen((was) => {
                            const next = new Set(was);
                            next.delete(p.id);
                            return next;
                          });
                        }}
                      >
                        Turn this down
                      </button>
                    </article>
                  ))}
                </section>
              );
            })}
            {dismissed.length > 0 && (
              <button className="link" onClick={() => saveDismissed([])}>
                Bring back the {plural(dismissed.length, 'proposal')} turned down before
              </button>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <span className="muted">{sync ? (chosenCount ? `${chosenCount} chosen` : 'Nothing chosen') : ''}</span>
          <button className="btn" onClick={close}>
            Close
          </button>
          {sync && (
            <button className="btn primary" disabled={!chosenCount || running} onClick={() => void apply()}>
              Apply the chosen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
