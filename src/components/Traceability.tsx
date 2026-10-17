import { useEffect, useMemo, useState } from 'react';
import type { ElementRef, LogicalModel } from '../logical/contracts';
import { useStore } from '../model/store';
import type { LdmViewState } from '../model/state/session';
import type { MappingDescription, TraceabilityReport, TraceResult } from '../traceability/contracts';

/**
 * Traceability of a logical model with the ontology (roadmap LM-4; FR-M18-8 to FR-M18-10): where
 * every element came from, how its mapping stands against the ontology now, what the model covers
 * both ways, a trace from an element or from an ontology entity, and mappings made and edited by
 * hand. Reading only: impact and synchronization are reviewed in the impact dialog, and the
 * ontology is never written (ADR-025).
 */

const STATUS: Record<MappingDescription['status'], string> = {
  current: 'current',
  stale: 'stale',
  broken: 'broken',
};

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function elementLabel(m: LogicalModel, ref: ElementRef): string {
  const id = Object.values(ref)[0];
  if ('entity' in ref) return m.entities.find((e) => e.id === id)?.name ?? `entity ${id}`;
  if ('attribute' in ref) {
    for (const e of m.entities) {
      const a = e.attributes.find((x) => x.id === id);
      if (a) return `${e.name}.${a.name}`;
    }
    return `attribute ${id}`;
  }
  if ('key' in ref) return m.entities.flatMap((e) => e.keys).find((k) => k.id === id)?.name ?? `key ${id}`;
  if ('relationship' in ref) {
    const r = m.relationships.find((x) => x.id === id);
    if (!r) return `relationship ${id}`;
    return r.name || `relationship ${id}`;
  }
  if ('generalization' in ref) {
    const g = m.generalizations.find((x) => x.id === id);
    return g ? `the subtypes of ${m.entities.find((e) => e.id === g.supertype)?.name ?? '?'}` : `generalization ${id}`;
  }
  if ('rule' in ref) return m.rules.find((r) => r.id === id)?.name ?? `rule ${id}`;
  if ('domain' in ref) return m.domains.find((d) => d.id === id)?.name ?? `domain ${id}`;
  if ('mapping' in ref) return 'a mapping';
  return `diagram ${id}`;
}

const refKey = (ref: ElementRef): string => `${Object.keys(ref)[0]}:${Object.values(ref)[0]}`;
const keyRef = (key: string): ElementRef => {
  const [kind, id] = key.split(':');
  return { [kind]: id } as ElementRef;
};

/** Everything in the LDM that a hand mapping may target. */
function targetable(m: LogicalModel): { ref: ElementRef; label: string }[] {
  const out: { ref: ElementRef; label: string }[] = [];
  for (const e of [...m.entities].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push({ ref: { entity: e.id }, label: e.name });
    for (const a of e.attributes) out.push({ ref: { attribute: a.id }, label: `${e.name}.${a.name}` });
  }
  for (const r of m.relationships) out.push({ ref: { relationship: r.id }, label: elementLabel(m, { relationship: r.id }) });
  for (const g of m.generalizations) out.push({ ref: { generalization: g.id }, label: elementLabel(m, { generalization: g.id }) });
  for (const r of m.rules) out.push({ ref: { rule: r.id }, label: `Rule ${r.name}` });
  for (const d of m.domains) out.push({ ref: { domain: d.id }, label: `Domain ${d.name}` });
  return out;
}

/** The ontology's entities by name, for picking a mapping's sources. */
function ontologyChoices(ontology: ReturnType<typeof useStore.getState>['model']): { iri: string; name: string; kind: string }[] {
  return [
    ...ontology.terms.map((t) => ({ iri: t.iri ?? '', name: t.name, kind: t.type === 'property' ? 'data property' : t.type })),
    ...ontology.props.map((p) => ({ iri: p.iri ?? '', name: p.name, kind: 'object property' })),
    ...ontology.datatypes.map((d) => ({ iri: d.iri ?? '', name: d.name, kind: 'datatype' })),
  ].filter((x) => x.iri) as { iri: string; name: string; kind: string }[];
}

export function TraceabilityPanel({ m, focus, selected, set }: { m: LogicalModel; focus: ElementRef | null; selected: string | null; set: (patch: Partial<LdmViewState>) => void }) {
  const service = useStore((s) => s.traceabilityService);
  const ontology = useStore((s) => s.model);
  const ontologyChoicesHere = useMemo(() => ontologyChoices(ontology), [ontology]);
  const [report, setReport] = useState<TraceabilityReport | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [traced, setTraced] = useState<TraceResult | null>(null);
  const [traceIri, setTraceIri] = useState('');
  const [traceError, setTraceError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    service
      .report({ model: m.id })
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(said(e)));
    return () => {
      live = false;
    };
  }, [service, m.id, m.revision]);

  useEffect(() => {
    let live = true;
    setTraced(null);
    setTraceError('');
    if (!focus) return;
    service
      .trace({ model: m.id, element: focus })
      .then((r) => live && setTraced(r))
      .catch((e) => live && setTraceError(said(e)));
    return () => {
      live = false;
    };
  }, [service, m.id, focus && refKey(focus), m.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapping = report?.mappings.find((x) => x.mapping.id === selected) ?? null;
  const counts = report ? { current: 0, stale: 0, broken: 0 } : null;
  if (report && counts) for (const x of report.mappings) counts[x.status]++;
  const unrepresented = report?.coverage.unrepresented ?? [];
  const unsourced = report?.coverage.unsourced ?? [];

  const traceFromIri = async (iri: string) => {
    setTraceError('');
    try {
      setTraced(await service.trace({ iri }));
    } catch (e) {
      setTraceError(said(e));
    }
  };

  return (
    <div className="ldm-body ldm-traceability">
      <div className="ldm-list">
        <div className="ldm-list-tools">
          <strong>Traceability</strong>
          <button className="btn small" onClick={() => useStore.getState().setDialog('impact')} title="Compare the ontology with this model’s mappings, and review synchronization">
            Impact…
          </button>
        </div>
        {error && <p className="ldm-note warn">{error}</p>}
        {!report && !error && <p className="muted pad">Reading the mappings…</p>}
        {report && counts && (
          <div className="trace-summary">
            <span className={`trace-status current`}>{counts.current} current</span>
            <span className={`trace-status stale`}>{counts.stale} stale</span>
            <span className={`trace-status broken`}>{counts.broken} broken</span>
            <p className="muted">
              {report.coverage.counts.sourced} of {report.coverage.counts.elements} elements have a source
              {report.coverage.scope !== null ? `; ${report.coverage.scope} classes are in the derivation’s scope` : ''}.
            </p>
          </div>
        )}
        <ul className="trace-mappings">
          {(report?.mappings ?? []).map((x) => (
            <li key={x.mapping.id}>
              <button className={selected === x.mapping.id ? 'on' : ''} onClick={() => set({ element: { mapping: x.mapping.id } })}>
                <span className={`trace-dot ${x.status}`} aria-label={STATUS[x.status]} />
                <span className="trace-name">{x.targets.map((t) => t.name).join(', ') || x.mapping.strategy}</span>
                <span className="muted small">
                  {x.sources.map((s) => s.name || s.label || s.iri).join(' · ')} · {x.mapping.made.by}
                  {x.customised ? ' · changed by you' : ''}
                </span>
              </button>
            </li>
          ))}
          {report && !report.mappings.length && <li className="muted pad">No mappings yet. Derive elements from the ontology, or map one by hand.</li>}
        </ul>

        <div className="ldm-block trace-coverage">
          <div className="ldm-block-head">
            <h3>Coverage</h3>
          </div>
          <p className="muted">
            {unrepresented.length ? `${unrepresented.length} ${unrepresented.length === 1 ? 'class is' : 'classes are'} in scope without an element.` : 'Every class in the derivation’s scope has an element.'}
          </p>
          {!!unrepresented.length && (
            <ul className="ldm-plain-list">
              {unrepresented.map((u) => (
                <li key={u.iri} title={u.iri}>
                  {u.name}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            {unsourced.length ? `${unsourced.length} ${unsourced.length === 1 ? 'element has' : 'elements have'} no mapping.` : 'Every element has a mapping.'}
          </p>
          {!!unsourced.length && (
            <ul className="ldm-plain-list">
              {unsourced.map((u) => (
                <li key={refKey(u.ref)}>
                  <button className="linklike" onClick={() => set({ element: u.ref })}>
                    {u.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ldm-block">
          <div className="ldm-block-head">
            <h3>Trace an ontology entity</h3>
          </div>
          <div className="row">
            <input list="trace-ontology" value={traceIri} placeholder="Its IRI" aria-label="Ontology entity IRI" onChange={(e) => setTraceIri(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && traceIri && void traceFromIri(traceIri)} />
            <datalist id="trace-ontology">
              {ontologyChoicesHere.map((o) => (
                <option key={o.iri} value={o.iri}>
                  {o.name} ({o.kind})
                </option>
              ))}
            </datalist>
            <button className="btn small" disabled={!traceIri} onClick={() => void traceFromIri(traceIri)}>
              Trace
            </button>
          </div>
          {traceError && <p className="ldm-note warn">{traceError}</p>}
          {focus && (
            <div className="trace-from-element">
              <p className="muted">This element is mapped from:</p>
              {traceError ? null : traced ? (
                traced.sources.length ? (
                  <ul className="ldm-plain-list">
                    {traced.sources.map((s) => (
                      <li key={s.iri} title={s.axioms.join('\n')}>
                        {s.label || s.iri}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Nothing: it has no mapping.</p>
                )
              ) : (
                <p className="muted">Reading…</p>
              )}
            </div>
          )}
          {traced?.iri && (
            <div className="trace-results">
              {traced.mappings.length ? (
                <ul className="ldm-plain-list">
                  {traced.mappings.map((x) => (
                    <li key={`${x.model}:${x.mapping.id}`}>
                      <span className={`trace-dot ${x.status}`} aria-label={STATUS[x.status]} /> <strong>{x.modelName}</strong>: {x.targets.map((t) => t.name).join(', ')}{' '}
                      {x.model !== m.id && (
                        <button className="linklike" onClick={() => useStore.getState().openLogical(x.model, x.targets[0]?.ref)}>
                          open
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No element of any logical model is mapped from it.</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="ldm-editor">
        {editing ? (
          <MappingForm
            m={m}
            existing={editing === 'new' ? null : (report?.mappings.find((x) => x.mapping.id === editing)?.mapping ?? null)}
            choices={ontologyChoicesHere}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        ) : mapping ? (
          <>
            <div className="ldm-title">
              <h2>{mapping.targets.map((t) => t.name).join(', ') || 'A mapping'}</h2>
              <span className={`trace-status ${mapping.status}`}>{STATUS[mapping.status]}</span>
              {mapping.customised && <span className="trace-status customised">changed by you</span>}
            </div>
            <div className="ldm-block">
              <div className="ldm-block-head">
                <h3>Where it came from</h3>
              </div>
              <ul className="ldm-plain-list">
                {mapping.sources.map((s) => (
                  <li key={s.iri} title={s.iri}>
                    <strong>{s.name || s.label || s.iri}</strong>
                    {s.label && s.name && s.label !== s.name ? <span className="muted"> (was “{s.label}”)</span> : null}
                    {!s.exists && <span className="trace-status broken"> gone</span>}
                  </li>
                ))}
              </ul>
              {mapping.changes.length > 0 && (
                <>
                  <h3>What changed</h3>
                  <ul className="ldm-plain-list">
                    {mapping.changes.map((c, i) => (
                      <li key={i} className={c.kind === 'source-removed' || c.kind === 'target-removed' ? 'warn' : ''}>
                        {c.text}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h3>What it made</h3>
              <ul className="ldm-plain-list">
                {mapping.targets.map((t) => (
                  <li key={refKey(t.ref)}>
                    {t.name} {!t.exists && <span className="trace-status broken">gone from the LDM</span>} {t.customised && <span className="trace-status customised">changed by you</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div className="ldm-block">
              <dl className="trace-facts">
                <dt>Strategy</dt>
                <dd>{mapping.mapping.strategy}</dd>
                <dt>Why</dt>
                <dd>{mapping.mapping.rationale}</dd>
                <dt>Origin</dt>
                <dd>
                  {mapping.mapping.origin.ontology}, revision {mapping.mapping.origin.revision}
                  {mapping.mapping.origin.version ? ` (version ${mapping.mapping.origin.version})` : ''}
                </dd>
                <dt>Made</dt>
                <dd>
                  by {mapping.mapping.made.by}, {new Date(mapping.mapping.made.at).toLocaleString()}
                </dd>
              </dl>
              <div className="row">
                <button className="btn small" onClick={() => setEditing(mapping.mapping.id)}>
                  Edit this mapping…
                </button>
                <button
                  className="btn small danger"
                  onClick={() => {
                    if (!window.confirm('Remove this mapping? The elements it mapped stay in the logical model. Undo takes it back.')) return;
                    void service
                      .removeMapping({ model: m.id, mapping: mapping.mapping.id })
                      .then(() => useStore.getState().notify('Removed the mapping; its elements stay.'))
                      .catch((e) => useStore.getState().notify(said(e)));
                  }}
                >
                  Remove the mapping…
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="muted pad">Select a mapping to see where its elements came from, or map an element to the ontology by hand.</p>
            <div className="row">
              <button className="btn primary" onClick={() => setEditing('new')} disabled={!targetable(m).length}>
                Map an element by hand…
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MappingForm({ m, existing, choices, onDone, onCancel }: { m: LogicalModel; existing: MappingDescription['mapping'] | null; choices: { iri: string; name: string; kind: string }[]; onDone: () => void; onCancel: () => void }) {
  const targets = useMemo(() => targetable(m), [m]);
  const [target, setTarget] = useState<string>(existing ? refKey(existing.targets[0]) : targets[0] ? refKey(targets[0].ref) : '');
  const [sources, setSources] = useState<string[]>(existing?.sources.map((s) => s.iri) ?? []);
  const [pick, setPick] = useState('');
  const [strategy, setStrategy] = useState(existing?.strategy ?? '');
  const [rationale, setRationale] = useState(existing?.rationale ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const byIri = new Map(choices.map((c) => [c.iri, c]));

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      const ref = target ? keyRef(target) : null;
      if (!ref) throw new Error('Choose the element to map.');
      if (!sources.length) throw new Error('Add at least one ontology entity.');
      if (!strategy.trim()) throw new Error('Say what the mapping does.');
      if (!rationale.trim()) throw new Error('Say why the mapping holds.');
      if (existing) await useStore.getState().traceabilityService.editMapping({ model: m.id, mapping: existing.id, sources: sources.map((iri) => ({ iri })), targets: [ref], strategy, rationale });
      else await useStore.getState().traceabilityService.addMapping({ model: m.id, sources: sources.map((iri) => ({ iri })), targets: [ref], strategy, rationale });
      onDone();
      useStore.getState().notify(existing ? 'Updated the mapping.' : 'Mapped the element by hand.');
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trace-form">
      <div className="ldm-title">
        <h2>{existing ? 'Edit the mapping' : 'Map an element by hand'}</h2>
      </div>
      <label className="field">
        <span>Element</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Element to map">
          {targets.map((t) => (
            <option key={refKey(t.ref)} value={refKey(t.ref)}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Ontology entity</span>
        <div className="row">
          <input list="trace-source-choices" value={pick} placeholder="Name or IRI" aria-label="Ontology entity" onChange={(e) => setPick(e.target.value)} />
          <datalist id="trace-source-choices">
            {choices.map((c) => (
              <option key={c.iri} value={c.iri}>
                {c.name} ({c.kind})
              </option>
            ))}
          </datalist>
          <button
            className="btn small"
            onClick={() => {
              const direct = byIri.has(pick) ? pick : choices.find((c) => c.name === pick)?.iri;
              if (direct && !sources.includes(direct)) setSources([...sources, direct]);
              setPick('');
            }}
          >
            Add
          </button>
        </div>
      </label>
      {!!sources.length && (
        <ul className="ldm-plain-list">
          {sources.map((iri) => (
            <li key={iri} title={iri}>
              {byIri.get(iri)?.name ?? iri} <button className="linklike" onClick={() => setSources(sources.filter((x) => x !== iri))}>remove</button>
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>What the mapping does</span>
        <input value={strategy} placeholder="Two classes → one entity" onChange={(e) => setStrategy(e.target.value)} />
      </label>
      <label className="field">
        <span>Why it holds</span>
        <textarea value={rationale} rows={3} placeholder="In words, for the people who read the model later." onChange={(e) => setRationale(e.target.value)} />
      </label>
      {error && <p className="ldm-note warn">{error}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {existing ? 'Save the mapping' : 'Make the mapping'}
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
