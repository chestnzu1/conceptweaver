import { useEffect, useMemo, useState } from 'react';
import type { ElementRef, ElementKind, ElementType, LogicalModel, StrategyId } from '../logical/contracts';
import { elementTypeWords } from '../logical/contracts';
import { convertibleFrom, expectedElementTypeOf, expectedKindOf, reasonsNotApplicable, STRATEGIES, strategyById, type StrategyEntry, type StrategySourceKind } from '../logical/strategies';
import { nameIn } from '../model/labels';
import { useStore } from '../model/store';
import type { LdmViewState } from '../model/state/session';
import type { ConversionPreview, MappingDescription, TraceabilityReport, TraceResult } from '../traceability/contracts';

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
  mismatched: 'mismatched',
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
    // A key is a mapping target of its own (owl:hasKey); the form must show it as it is rather
    // than fall back to another element.
    for (const k of e.keys) out.push({ ref: { key: k.id }, label: `${e.name}.${k.name}` });
  }
  for (const r of m.relationships) out.push({ ref: { relationship: r.id }, label: elementLabel(m, { relationship: r.id }) });
  for (const g of m.generalizations) out.push({ ref: { generalization: g.id }, label: elementLabel(m, { generalization: g.id }) });
  for (const r of m.rules) out.push({ ref: { rule: r.id }, label: `Rule ${r.name}` });
  for (const d of m.domains) out.push({ ref: { domain: d.id }, label: `Domain ${d.name}` });
  return out;
}

/** The ontology's entities by name, for picking a mapping's sources. */
function ontologyChoices(ontology: ReturnType<typeof useStore.getState>['model'], lang = ''): { iri: string; name: string; kind: string }[] {
  return [
    ...ontology.terms.map((t) => ({ iri: t.iri ?? '', name: nameIn(t, ontology.lang, lang), kind: t.type === 'property' ? 'data property' : t.type })),
    ...ontology.props.map((p) => ({ iri: p.iri ?? '', name: nameIn(p, ontology.lang, lang), kind: 'object property' })),
    ...ontology.datatypes.map((d) => ({ iri: d.iri ?? '', name: d.name, kind: 'datatype' })),
  ].filter((x) => x.iri) as { iri: string; name: string; kind: string }[];
}

export function TraceabilityPanel({ m, focus, selected, set }: { m: LogicalModel; focus: ElementRef | null; selected: string | null; set: (patch: Partial<LdmViewState>) => void }) {
  const service = useStore((s) => s.traceabilityService);
  const ontology = useStore((s) => s.model);
  const displayLang = useStore((s) => s.displayLang);
  const ontologyChoicesHere = useMemo(() => ontologyChoices(ontology, displayLang), [ontology, displayLang]);
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
  const counts = report ? { current: 0, stale: 0, broken: 0, mismatched: 0 } : null;
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
          <button className="btn small" onClick={() => setEditing('new')} disabled={!targetable(m).length} title="Map an element to the ontology by hand">
            Map an element by hand…
          </button>
        </div>
        {error && <p className="ldm-note warn">{error}</p>}
        {!report && !error && <p className="muted pad">Reading the mappings…</p>}
        {report && counts && (
          <div className="trace-summary">
            <span className={`trace-status current`}>{counts.current} current</span>
            <span className={`trace-status stale`}>{counts.stale} stale</span>
            <span className={`trace-status broken`}>{counts.broken} broken</span>
            <span className={`trace-status mismatched`}>{counts.mismatched} mismatched</span>
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
                <dt>Strategy id</dt>
                <dd>{mapping.mapping.strategyId ?? 'not classified yet'}</dd>
                {mapping.mapping.converted && (
                  <>
                    <dt>Converted</dt>
                    <dd>
                      from {strategyById(mapping.mapping.converted.from)?.label ?? mapping.mapping.converted.from ?? 'a strategy without an id'} to {strategyById(mapping.mapping.converted.to)?.label ?? mapping.mapping.converted.to}, {new Date(mapping.mapping.converted.at).toLocaleString()}
                    </dd>
                  </>
                )}
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
          </>
        )}
      </div>
    </div>
  );
}

const KIND_WORD: Record<ElementKind, string> = {
  entity: 'an entity',
  attribute: 'an attribute',
  key: 'a key',
  relationship: 'a relationship',
  generalization: 'a generalization',
  rule: 'a business rule',
  domain: 'a domain',
  mapping: 'a mapping',
  diagram: 'a diagram',
};

const refKindOf = (ref: ElementRef): ElementKind => Object.keys(ref)[0] as ElementKind;

/** What an entity or domain is in the model: an entity, a reference entity or a domain. */
function elementTypeIn(m: LogicalModel, ref: ElementRef): ElementType | undefined {
  if ('entity' in ref) {
    const entity = m.entities.find((e) => e.id === ref.entity);
    return entity ? (entity.reference === true ? 'reference' : 'entity') : undefined;
  }
  if ('domain' in ref) return m.domains.some((d) => d.id === ref.domain) ? 'domain' : undefined;
  return undefined;
}

/** Whether a strategy makes the other of the two entity types than the one it targets. */
function changesEntityType(entry: StrategyEntry, actual: ElementType | undefined): boolean {
  const makes = expectedElementTypeOf(entry.id);
  return entry.target === 'entity' && (makes === 'entity' || makes === 'reference') && !!actual && makes !== actual;
}

/** The kind of source a strategy catalogue entry is about, from the names the ontology choices use. */
function sourceKindOf(kind: string): StrategySourceKind | undefined {
  if (kind === 'concept' || kind === 'class') return 'class';
  if (kind === 'property' || kind === 'data property') return 'data property';
  if (kind === 'object property' || kind === 'datatype') return kind;
  return undefined;
}

export function PreviewList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="ldm-plain-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </>
  );
}

function MappingForm({ m, existing, choices, onDone, onCancel }: { m: LogicalModel; existing: MappingDescription['mapping'] | null; choices: { iri: string; name: string; kind: string }[]; onDone: () => void; onCancel: () => void }) {
  const targets = useMemo(() => targetable(m), [m]);
  const [target, setTarget] = useState<string>(existing ? refKey(existing.targets[0]) : targets[0] ? refKey(targets[0].ref) : '');
  const [sources, setSources] = useState<string[]>(existing?.sources.map((s) => s.iri) ?? []);
  const [pick, setPick] = useState('');
  const [strategyId, setStrategyId] = useState<StrategyId | ''>(existing?.strategyId ?? '');
  const [rationale, setRationale] = useState(existing?.rationale ?? '');
  const [preview, setPreview] = useState<ConversionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const byIri = new Map(choices.map((c) => [c.iri, c]));

  const targetKind: ElementKind = target ? refKindOf(keyRef(target)) : 'entity';
  const targetType = target ? elementTypeIn(m, keyRef(target)) : undefined;
  const selected = strategyById(strategyId || undefined);
  // An entity and a reference entity are one kind: changing between them is done in the Entities
  // workspace, so only a change of kind is a conversion here.
  const conversion = !!existing && !!selected && selected.target !== targetKind;
  const expectedType = expectedElementTypeOf(existing?.strategyId);
  const existingType = existing?.targets[0] ? elementTypeIn(m, existing.targets[0]) : undefined;
  const existingMismatched = !!existing && !!existing.targets[0] && (
    (expectedKindOf(existing.strategyId) !== undefined && expectedKindOf(existing.strategyId) !== refKindOf(existing.targets[0])) ||
    ((expectedType === 'entity' || expectedType === 'reference') && !!existingType && expectedType !== existingType)
  );
  const knownSourceKinds = sources.map((iri) => sourceKindOf(byIri.get(iri)?.kind ?? '')).filter((k): k is StrategySourceKind => !!k);
  const sourcesKnown = sources.length > 0 && knownSourceKinds.length === sources.length;

  /**
   * Why a strategy cannot be chosen here: it makes the wrong kind of element, or it does not read
   * these sources. An existing mapping may also choose a strategy that converts its element (a
   * domain into an entity); its conflicts are the conversion's to report. A new mapping maps an
   * element as it is: offering a conversion there would only fail on save.
   */
  const reasonFor = (entry: StrategyEntry): string | undefined => {
    const reaches = entry.target === targetKind || (!!existing && convertibleFrom(targetKind).includes(entry.target));
    if (!reaches) return reasonsNotApplicable(entry, { sourceKinds: [], targetKind });
    // A new mapping maps the element as it is. Between an entity and a reference entity the
    // element's type is changed in the Entities workspace, never by choosing a strategy here.
    if (!existing && changesEntityType(entry, targetType)) {
      return `It makes ${elementTypeWords(expectedElementTypeOf(entry.id)!)}; this mapping’s element is ${elementTypeWords(targetType!)}. Change the element’s type in the Entities workspace first.`;
    }
    if (!sourcesKnown) return undefined;
    return reasonsNotApplicable(entry, { sourceKinds: knownSourceKinds, targetKind: entry.target });
  };
  const offered = STRATEGIES.filter((entry) => reasonFor(entry) === undefined);
  const keep = offered.filter((entry) => entry.target === targetKind);
  const convert = offered.filter((entry) => entry.target !== targetKind);
  const reasons = STRATEGIES.map((entry) => ({ entry, reason: reasonFor(entry) })).filter((x): x is { entry: StrategyEntry; reason: string } => !!x.reason);

  const loadPreview = async (id: StrategyId, decisions: Record<string, string>) => {
    if (!existing) return;
    setPreviewing(true);
    setError('');
    try {
      const next = await useStore.getState().traceabilityService.previewConversion({
        model: m.id,
        mapping: existing.id,
        to: id,
        ...(Object.keys(decisions).length ? { decisions } : {}),
        sources: sources.map((iri) => ({ iri })),
        rationale,
      });
      setPreview(next);
    } catch (e) {
      setPreview(null);
      setError(said(e));
    } finally {
      setPreviewing(false);
    }
  };

  const choose = (value: string) => {
    const id = value as StrategyId | '';
    setStrategyId(id);
    setPreview(null);
    const entry = strategyById(id || undefined);
    if (existing && entry && entry.target !== targetKind) void loadPreview(entry.id, {});
  };

  const changeTarget = (value: string) => {
    setTarget(value);
    setPreview(null);
    const kind = value ? refKindOf(keyRef(value)) : targetKind;
    if (selected && selected.target !== kind && !convertibleFrom(kind).includes(selected.target)) setStrategyId('');
  };

  const changeSources = (next: string[]) => {
    setSources(next);
    // The sources are what a conversion reads (a reference entity takes its members from them):
    // a review made from other sources is no longer the review of this mapping.
    setPreview(null);
  };

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      const ref = target ? keyRef(target) : null;
      if (!ref) throw new Error('Choose the element to map.');
      if (!sources.length) throw new Error('Add at least one ontology entity.');
      if (!strategyId) throw new Error('Choose what the mapping does.');
      if (!rationale.trim()) throw new Error('Say why the mapping holds.');
      if (existing) await useStore.getState().traceabilityService.editMapping({ model: m.id, mapping: existing.id, sources: sources.map((iri) => ({ iri })), targets: [ref], strategyId, rationale });
      else await useStore.getState().traceabilityService.addMapping({ model: m.id, sources: sources.map((iri) => ({ iri })), targets: [ref], strategyId, rationale });
      onDone();
      useStore.getState().notify(existing ? 'Updated the mapping.' : 'Mapped the element by hand.');
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setError('');
    setBusy(true);
    try {
      await useStore.getState().traceabilityService.applyConversion(preview);
      onDone();
      useStore.getState().notify('Applied the transformation. Undo takes it back.');
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
      {existing && !existing.strategyId && <p className="ldm-note">This mapping predates typed strategies: its words “{existing.strategy}” are kept as they are. Choose the strategy it follows; it needs classification, and nothing is guessed.</p>}
      {existingMismatched && (
        <p className="ldm-note warn mapping-mismatch">
          This mapping says it makes {expectedType === 'entity' || expectedType === 'reference' ? elementTypeWords(expectedType) : KIND_WORD[expectedKindOf(existing.strategyId)!]}, but “{elementLabel(m, existing.targets[0])}” is {existingType ? elementTypeWords(existingType) : KIND_WORD[refKindOf(existing.targets[0])]}.
          {expectedKindOf(existing.strategyId) !== refKindOf(existing.targets[0])
            ? ' Choose a strategy that converts it, and apply the transformation.'
            : ' Choose a strategy that makes the element as it is, or change the element’s type in the Entities workspace.'}
        </p>
      )}
      <label className="field">
        <span>Element</span>
        <select value={target} onChange={(e) => changeTarget(e.target.value)} aria-label="Element to map">
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
              if (direct && !sources.includes(direct)) changeSources([...sources, direct]);
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
              {byIri.get(iri)?.name ?? iri} <button className="linklike" onClick={() => changeSources(sources.filter((x) => x !== iri))}>remove</button>
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>Strategy</span>
        <select value={strategyId} onChange={(e) => choose(e.target.value)} aria-label="Strategy">
          <option value="">Choose a strategy</option>
          {keep.length > 0 && (
            <optgroup label="Saves the element as it is">
              {keep.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </optgroup>
          )}
          {convert.length > 0 && (
            <optgroup label="Converts the element">
              {convert.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {selected && <p className="muted small">{selected.description}</p>}
      {reasons.length > 0 && (
        <details className="strategy-reasons">
          <summary>The other strategies, and why they do not apply</summary>
          <ul className="ldm-plain-list">
            {reasons.map(({ entry, reason }) => (
              <li key={entry.id}>
                <strong>{entry.label}</strong> — {reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <label className="field">
        <span>Why it holds</span>
        <textarea
          value={rationale}
          rows={3}
          placeholder="In words, for the people who read the model later."
          onChange={(e) => {
            setRationale(e.target.value);
            // The rationale is metadata: changing it never asks for a conversion. It travels with
            // the review, so that applying it keeps what the form says.
            setPreview((p) => (p ? { ...p, mappingAfter: { ...p.mappingAfter, rationale: e.target.value } } : p));
          }}
        />
      </label>
      {previewing && <p className="muted">Working out what the change would make of the model…</p>}
      {preview && (
        <div className="conversion-preview">
          <h3>Transformation preview</h3>
          <dl className="trace-facts">
            <dt>Now</dt>
            <dd>
              {preview.from.name} — {preview.from.strategyId ? (strategyById(preview.from.strategyId)?.label ?? preview.from.strategyId) : 'no typed strategy'} ({KIND_WORD[preview.from.kind]})
            </dd>
            <dt>After</dt>
            <dd>
              {preview.to.name} — {strategyById(preview.to.strategyId)?.label ?? preview.to.strategyId} ({KIND_WORD[preview.to.kind]})
            </dd>
          </dl>
          <PreviewList title="Creates" items={preview.creates} />
          <PreviewList title="Modifies" items={preview.modifies} />
          <PreviewList title="Removes" items={preview.removes} />
          <PreviewList title="Keys" items={preview.keys} />
          <PreviewList title="Constraints" items={preview.constraints} />
          {preview.decisions.map((d) => (
            <label className="field" key={d.name}>
              <span>{d.label}</span>
              <select
                value={d.chosen}
                aria-label={d.label}
                onChange={(e) => {
                  const chosen = Object.fromEntries(preview.decisions.map((x) => [x.name, x.name === d.name ? e.target.value : x.chosen]));
                  void loadPreview(preview.to.strategyId, chosen);
                }}
              >
                {d.choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {!!preview.warnings.length && (
            <div className="ldm-note">
              <ul className="ldm-plain-list">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {!!preview.conflicts.length && (
            <div className="conversion-conflicts">
              <h4>Cannot be applied</h4>
              <ul className="ldm-plain-list">
                {preview.conflicts.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {error && <p className="ldm-note warn">{error}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || previewing || conversion} onClick={() => void save()}>
          {existing ? 'Save the mapping' : 'Make the mapping'}
        </button>
        {conversion && (
          <button className="btn primary" disabled={busy || previewing || !preview || !preview.changes.length || preview.conflicts.length > 0} onClick={() => void apply()}>
            Apply the Transformation
          </button>
        )}
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
