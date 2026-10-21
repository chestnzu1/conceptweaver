import { useEffect, useMemo, useRef, useState } from 'react';
import { BASE_TYPES, LogicalError, type BaseTypeName, type ElementRef, type TransformationConfig } from '../logical/contracts';
import { useStore } from '../model/store';
import type { TransformationProposal, TransformationResult } from '../traceability/contracts';
import { DEFAULT_DATATYPES, chosenByDefault, defaultTransformationConfig } from '../traceability/transform';

/**
 * Deriving a logical data model from the ontology (roadmap LM-3; FR-M18-1 to FR-M18-6, ADR-024).
 * The configuration is reviewed at the top; proposals come back grouped by what they would make,
 * each with the axioms it was read from, the elements it would make or change, the strategy, the
 * rationale and where OWL and the LDM differ. Constraints are candidates, never chosen to begin
 * with (NFR-18). Proposals are chosen one by one or by kind; applying them is one change set of
 * the LDM, which undo takes back, and the LDM's revision moves. The ontology is never written.
 */

const GROUPS = ['entity', 'attribute', 'relationship', 'specialization', 'domain', 'constraint'] as const;
const GROUP_TITLE: Record<(typeof GROUPS)[number], string> = { entity: 'Entities', attribute: 'Attributes', relationship: 'Relationships', specialization: 'Specializations', domain: 'Domains', constraint: 'Candidate constraints' };
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const said = (e: unknown) => (e instanceof LogicalError || e instanceof Error ? e.message : String(e));
const short = (iri: string) => iri.split(/[#/]/).filter(Boolean).pop() ?? iri;

/** The element a proposal would make or change first, for "apply and edit". */
function firstElement(p: TransformationProposal): ElementRef | undefined {
  for (const c of p.changes) {
    if (c.op === 'add') {
      switch (c.element.kind) {
        case 'entity':
          return { entity: c.element.entity.id };
        case 'attribute':
          return { attribute: c.element.attribute.id };
        case 'relationship':
          return { relationship: c.element.relationship.id };
        case 'domain':
          return { domain: c.element.domain.id };
        case 'generalization':
          return { generalization: c.element.generalization.id };
        case 'rule':
          return { rule: c.element.rule.id };
        default:
          continue;
      }
    }
    if (c.op === 'update') {
      if ('model' in c.target) continue;
      return c.target;
    }
  }
  return undefined;
}

/** A proposal and everything it requires, transitively. */
function closureOf(result: TransformationResult, p: TransformationProposal): string[] {
  const ids = new Set<string>();
  const todo = [p.id];
  while (todo.length) {
    const id = todo.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const found = result.proposals.find((x) => x.id === id);
    todo.push(...(found?.requires ?? []));
  }
  return [...ids];
}

export function TransformationDialog() {
  const project = useStore((s) => s.model);
  const view = useStore((s) => s.ldmView);
  const st = useStore.getState;
  const target = project.logicalModels.find((m) => m.id === view.model) ?? project.logicalModels[0] ?? null;
  const close = () => st().setDialog(null);

  const [config, setConfig] = useState<TransformationConfig>(() => (target?.derivation ? structuredClone(target.derivation) : defaultTransformationConfig()));
  const [result, setResult] = useState<TransformationResult | null>(null);
  const [running, setRunning] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const stop = useRef<AbortController | null>(null);

  const classes = useMemo(() => project.terms.filter((t) => t.type === 'concept').map((t) => ({ id: t.iri ?? t.id, name: t.name || 'Unnamed class' })).sort((a, b) => a.name.localeCompare(b.name)), [project.terms]);
  const dataTypes = useMemo(() => {
    const found = new Set<string>();
    for (const t of project.terms) {
      if (t.type !== 'property') continue;
      for (const a of t.ranges ?? []) {
        if (a.range.type === 'Datatype') found.add(a.range.iri);
        else if (a.range.type === 'DatatypeRestriction') found.add(a.range.datatype);
      }
    }
    return [...found].sort();
  }, [project.terms]);

  const change = (fn: (c: TransformationConfig) => TransformationConfig) => {
    setConfig((c) => fn(structuredClone(c)));
    setDirty(true);
  };

  const run = async (cfg: TransformationConfig) => {
    if (!target) return;
    stop.current?.abort();
    const controller = new AbortController();
    stop.current = controller;
    setRunning(true);
    setError(null);
    try {
      const next = await st().transformationService.propose({ model: target.id, config: cfg }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult(next);
      // Structure for the scope comes chosen, as the design says (SYSTEM_ARCHITECTURE.md §13.6);
      // candidate constraints never do (NFR-18).
      setChosen(new Set(next.proposals.filter(chosenByDefault).map((p) => p.id)));
      setDismissed(new Set());
      setDirty(false);
    } catch (e) {
      if (!controller.signal.aborted) setError(said(e));
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  };

  useEffect(() => {
    void run(config);
    return () => stop.current?.abort();
    // Run once when the dialog opens, from the configuration the LDM was last derived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!target) {
    return (
      <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        <div className="dialog proposals" role="dialog" aria-modal="true">
          <h2>Derive from the ontology</h2>
          <p className="muted">Make a logical model first: proposals are made into one.</p>
          <div className="dialog-actions">
            <button className="btn" onClick={close}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const shown = result?.proposals.filter((p) => !dismissed.has(p.id)) ?? [];
  const takeable = shown.filter(chosenByDefault);
  const toggle = (ids: string[], on: boolean) => setChosen((c) => new Set(on ? [...c, ...ids] : [...c].filter((x) => !ids.includes(x))));
  const chosenHere = shown.filter((p) => chosen.has(p.id));
  const apply = async (ids: string[], then?: (p: TransformationProposal) => void) => {
    if (!result) return;
    try {
      const applied = await st().transformationService.apply({ result, accepted: ids });
      st().setDialog(null);
      if (applied.applied) st().notify(`Derived ${plural(applied.applied, 'element')} from the ontology into “${target.name}”. Undo takes ${applied.applied === 1 ? 'it' : 'them'} back.`);
      else st().notify('Nothing was chosen, so the logical model was not changed.');
      if (then) then(result.proposals.find((p) => ids.includes(p.id))!);
    } catch (e) {
      st().notify(said(e));
    }
  };
  const applyChosen = () => {
    const ids = chosenHere.map((p) => p.id);
    if (ids.length) void apply(ids, () => st().openLogical(target.id));
  };
  const applyAndEdit = (p: TransformationProposal) => {
    const ids = closureOf(result!, p);
    const element = firstElement(p);
    void apply(ids, () => st().openLogical(target.id, element));
  };

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog proposals transform" role="dialog" aria-modal="true" aria-labelledby="transform-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="transform-title">Derive “{target.name}” from the ontology</h2>
        <p className="muted">
          Each proposal says which axioms it came from, what it would make or change in the logical model, the strategy, why, and where the OWL construct and the LDM differ. Nothing is written until you apply what you choose. The ontology is never changed; applying is one step of this logical model’s history, and undo takes it back.
        </p>

        <div className="transform-config">
          <label className="field">
            <span>Classes</span>
            <select aria-label="Which classes to derive from" value={config.scope.kind} onChange={(e) => change((c) => ({ ...c, scope: { ...c.scope, kind: e.target.value as TransformationConfig['scope']['kind'] } }))}>
              <option value="all">The whole ontology</option>
              <option value="branch">A branch, and what is under it</option>
              <option value="classes">The classes chosen</option>
            </select>
          </label>
          <label className="field">
            <span>Names from</span>
            <select aria-label="Where names come from" value={config.naming.from} onChange={(e) => change((c) => ({ ...c, naming: { ...c.naming, from: e.target.value as TransformationConfig['naming']['from'] } }))}>
              <option value="label">The ontology’s labels</option>
              <option value="localName">The last part of each IRI</option>
            </select>
          </label>
          <label className="field">
            <span>Case</span>
            <select aria-label="How names are cased" value={config.naming.case} onChange={(e) => change((c) => ({ ...c, naming: { ...c.naming, case: e.target.value as TransformationConfig['naming']['case'] } }))}>
              <option value="asis">As written</option>
              <option value="lower">lower case</option>
              <option value="upper">UPPER CASE</option>
              <option value="pascal">PascalCase</option>
              <option value="camel">camelCase</option>
            </select>
          </label>
          <label className="field">
            <span>Between words</span>
            <select aria-label="What joins the words of a name" value={config.naming.separator} onChange={(e) => change((c) => ({ ...c, naming: { ...c.naming, separator: e.target.value as TransformationConfig['naming']['separator'] } }))}>
              <option value=" ">A space</option>
              <option value="">Nothing</option>
              <option value="_">An underscore</option>
              <option value="-">A hyphen</option>
            </select>
          </label>
          <label className="field">
            <span>Hierarchy</span>
            <select aria-label="What a subclass hierarchy becomes" value={config.hierarchy} onChange={(e) => change((c) => ({ ...c, hierarchy: e.target.value as TransformationConfig['hierarchy'] }))}>
              <option value="specialization">A specialization</option>
              <option value="rollup">One entity per hierarchy</option>
              <option value="rolldown">Attributes copied into each subtype</option>
              <option value="reference">A reference entity of the subclasses, and an entity for the instances</option>
            </select>
          </label>
          <label className="field">
            <span>Object properties</span>
            <select aria-label="What an object property becomes" value={config.objectProperties} onChange={(e) => change((c) => ({ ...c, objectProperties: e.target.value as TransformationConfig['objectProperties'] }))}>
              <option value="relationship">A relationship</option>
              <option value="associative">An associative entity where both ends are many</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={config.naming.singular} onChange={(e) => change((c) => ({ ...c, naming: { ...c.naming, singular: e.target.checked } }))} />
            Singular entity names
          </label>
          <label className="check">
            <input type="checkbox" checked={config.definitions} onChange={(e) => change((c) => ({ ...c, definitions: e.target.checked }))} />
            Read definitions from the ontology
          </label>
          <label className="check">
            <input type="checkbox" checked={config.scope.withImports} onChange={(e) => change((c) => ({ ...c, scope: { ...c.scope, withImports: e.target.checked } }))} />
            Include imported classes
          </label>
        </div>

        {config.scope.kind !== 'all' && (
          <fieldset className="transform-scope">
            <legend>{config.scope.kind === 'branch' ? 'The roots of the branch' : 'The classes to derive from'}</legend>
            <div className="transform-classes">
              {classes.map((c) => (
                <label key={c.id} className="check">
                  <input
                    type="checkbox"
                    checked={config.scope.classes.includes(c.id)}
                    onChange={(e) => change((x) => ({ ...x, scope: { ...x.scope, classes: e.target.checked ? [...x.scope.classes, c.id] : x.scope.classes.filter((id) => id !== c.id) } }))}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {dataTypes.length > 0 && (
          <details className="transform-datatypes">
            <summary>Datatypes ({dataTypes.length})</summary>
            <p className="muted">What each datatype in the ontology’s ranges becomes. A table kept with the logical model, so a run again reads the same way.</p>
            <div className="transform-grid">
              {dataTypes.map((iri) => (
                <label key={iri} className="field" title={iri}>
                  <span>{short(iri)}</span>
                  <select
                    aria-label={`Logical type for ${iri}`}
                    value={config.datatypes[iri] ?? DEFAULT_DATATYPES[iri] ?? 'text'}
                    onChange={(e) => change((c) => ({ ...c, datatypes: { ...c.datatypes, [iri]: e.target.value as BaseTypeName } }))}
                  >
                    {BASE_TYPES.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </details>
        )}

        <div className="transform-run">
          <button className="btn small" disabled={running} onClick={() => void run(config)}>
            {running ? 'Proposing…' : 'Propose again'}
          </button>
          {dirty && !running && <span className="muted">The configuration changed: propose again to see what it would make.</span>}
          {result && !dirty && !running && <span className="muted">{plural(result.proposals.length, 'proposal')} from {plural(result.scope.classes.length, 'class', 'classes')}.</span>}
          {error && <span className="warn">{error}</span>}
        </div>

        <div className="proposal-list" aria-label="Transformation proposals">
          {running && !result && <p className="muted">Reading the ontology…</p>}
          {!running && result && !shown.length && <p className="muted">Nothing is proposed: the logical model already has what the ontology states here.</p>}
          {!running && result && shown.length > 0 && (
            <div className="transform-choose-all">
              <button className="link" disabled={!takeable.length} onClick={() => toggle(takeable.map((p) => p.id), true)}>
                Choose all {takeable.length} structural proposals
              </button>
              <button className="link" disabled={!chosenHere.length} onClick={() => toggle(shown.map((p) => p.id), false)}>
                Choose none
              </button>
              <span className="muted">Structure comes chosen; candidate constraints never do: choose one itself to say you want it.</span>
            </div>
          )}
          {GROUPS.map((group) => {
            const here = shown.filter((p) => p.kind === group);
            if (!here.length) return null;
            const open = here.filter(chosenByDefault);
            return (
              <section key={group} className="proposal-group" data-kind={group}>
                <header>
                  <h3>
                    {GROUP_TITLE[group]} ({here.length})
                  </h3>
                  {open.length > 0 && (
                    <button className="link" disabled={running} onClick={() => toggle(open.map((p) => p.id), !open.every((p) => chosen.has(p.id)))}>
                      {open.every((p) => chosen.has(p.id)) ? 'Choose none of these' : `Choose all ${open.length}`}
                    </button>
                  )}
                  <button className="link" onClick={() => setDismissed((d) => new Set([...d, ...here.map((p) => p.id)]))}>
                    Dismiss these
                  </button>
                </header>
                {here.map((p) => (
                  <article key={p.id} className={'proposal' + (chosen.has(p.id) ? ' on' : '')} data-proposal={p.id} data-candidate={p.candidate ? 'true' : 'false'}>
                    <label className="check">
                      <input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => toggle([p.id], e.target.checked)} aria-label={`Choose ${p.title}`} />
                      <strong>{p.title}</strong>
                      {p.candidate && <span className="tag">Candidate: not chosen by default</span>}
                    </label>
                    <div className="transform-sources">
                      {p.sources.map((s) => (
                        <div key={s.iri}>
                          <code className="axiom" title={s.iri}>
                            {s.axioms.join('\n')}
                          </code>
                        </div>
                      ))}
                    </div>
                    <p className="muted">{p.elements.join(' · ')}</p>
                    <dl>
                      <dt>Strategy</dt>
                      <dd>{p.strategy}</dd>
                      <dt>Why</dt>
                      <dd>{p.rationale}</dd>
                      <dt>Differs</dt>
                      <dd>{p.difference}</dd>
                    </dl>
                    <div className="transform-actions">
                      <button className="btn small" disabled={running} onClick={() => applyAndEdit(p)}>
                        Apply and edit
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
          {result && result.skipped.length > 0 && (
            <details className="not-proposed">
              <summary>Left alone ({result.skipped.length})</summary>
              <ul>
                {result.skipped.map((s) => (
                  <li key={`${s.iri}-${s.reason}`}>
                    <code>{short(s.iri)}</code> <span className="muted">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {dismissed.size > 0 && (
            <button className="link" onClick={() => setDismissed(new Set())}>
              Show the {dismissed.size} dismissed again
            </button>
          )}
        </div>

        <div className="dialog-actions">
          <span className="muted">{chosenHere.length ? `${chosenHere.length} chosen` : 'Nothing chosen'}</span>
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" disabled={!chosenHere.length || running || dirty} onClick={applyChosen}>
            Apply the chosen
          </button>
        </div>
      </div>
    </div>
  );
}
