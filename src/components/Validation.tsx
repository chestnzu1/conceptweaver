import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { download } from '../model/files';
import { QUALITY_RULES, ruleEnabled, setRule, type RuleGroup } from '../model/quality';
import { reason } from '../model/reasoner';
import { stable } from '../model/stable';
import { useStore } from '../model/store';
import { categoryLabel, isStale, MODEL_DATA, REASONER_LIMITS, reportJson, reportTurtle, SHACL_ENGINE, type Category, type EntityType, type Finding, type Level, type Scope } from '../model/validation';
import { ShapesPanel } from './Shapes';
import { Disclosure } from './Icon';

/**
 * The validation workbench: three kinds of check, run on request, with their results in one
 * list. OWL consistency, SHACL conformance and modelling quality answer different questions
 * and are kept visibly apart; nothing here changes the model unless the user applies a fix.
 */

const PAGE = 200;
const SEVERITY_LABEL: Record<Level, string> = { error: 'Error', warning: 'Warning', info: 'Suggestion' };
const fileBase = (name: string) => name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'model';

export function ValidationView() {
  const model = useStore((s) => s.model);
  const meaning = stable(model);
  const { run, running, phase, data, tab } = useStore((s) => s.validation);
  const st = useStore.getState;
  const dataRef = useRef<HTMLInputElement>(null);
  const stale = isStale(run, model, data);

  // The first time the workbench is opened for a model there is nothing to show, so it runs once.
  // After that it runs when asked: the results say what was validated, and when.
  const docSeq = useStore((s) => s.docSeq);
  useEffect(() => {
    if (!st().validation.run && !st().validation.running) void st().runValidation('all');
    // Another model in the editor starts without results, and gets its first run in the same way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docSeq]);

  const findings = run?.findings ?? [];
  const count = (c: Category, l?: Level) => findings.filter((f) => f.category === c && (!l || f.severity === l)).length;
  const inferences = useMemo(() => (tab === 'inferences' ? reason(meaning).inferences : []), [meaning, tab]);

  const importData = async (file: File) => {
    const text = await file.text();
    try {
      const { Parser } = await import('n3');
      const triples = new Parser().parse(text).length;
      st().setValidation({ data: { source: 'imported', name: file.name, text, includeOntology: true } });
      st().notify(`${file.name}: ${triples} triples, now the data SHACL validates. It is not added to the model.`);
    } catch (e) {
      st().notify(`Could not read ${file.name} as Turtle: ${e instanceof Error ? e.message : ''}`);
    }
  };

  const runButton = (scope: Scope, label: string, primary = false) => (
    <button className={'btn' + (primary ? ' primary' : '')} disabled={running} onClick={() => void st().runValidation(scope)}>
      {label}
    </button>
  );

  return (
    <div className="view validation">
      <div className="view-head">
        <div className="row wrap">
          {runButton('all', 'Run all checks', true)}
          {runButton('owl', 'OWL')}
          {runButton('shacl', 'SHACL')}
          {runButton('quality', 'Quality')}
        </div>
        <span className="muted run-state" role="status" aria-live="polite">
          {running ? phase || 'Working…' : run ? `Validated ${new Date(run.at).toLocaleTimeString()} · revision ${run.revision} · ${run.entities} entities` : 'Not validated yet.'}
        </span>
        <div className="row">
          <button className="btn small" disabled={!run} title="The results as JSON" onClick={() => run && download(`${fileBase(model.name)}-validation.json`, reportJson(run, model), 'application/json')}>
            Report (JSON)
          </button>
          <button className="btn small" disabled={!run} title="The results as RDF: the SHACL validation report as the engine produced it, and the other findings" onClick={() => run && download(`${fileBase(model.name)}-validation.ttl`, reportTurtle(run, model), 'text/turtle')}>
            Report (RDF)
          </button>
        </div>
      </div>

      {stale && !running && (
        <p className="stale" role="alert">
          The model has changed since these results (revision {run!.revision}). They may no longer hold.{' '}
          <button className="link" onClick={() => void st().runValidation('all')}>
            Run all checks again
          </button>
        </p>
      )}

      <div className="summary" aria-label="Summary">
        <section className={'card ' + (run?.owl ? (run.owl.status === 'inconsistent' ? 'is-bad' : run.owl.unsatisfiable.length ? 'is-warn' : 'is-good') : '')}>
          <h3>OWL consistency</h3>
          {!run?.owl ? (
            <p className="muted">Not run for this revision.</p>
          ) : run.owl.status === 'not-applicable' ? (
            <p className="muted">A SKOS concept scheme has no OWL axioms to contradict each other. Its integrity conditions are checked under Quality.</p>
          ) : (
            <>
              <p className="status">
                Status: <strong>{run.owl.status === 'consistent' ? (run.owl.partial ? 'No contradiction found (partial)' : 'Consistent') : `Inconsistent: ${run.owl.contradictions} contradiction${run.owl.contradictions === 1 ? '' : 's'}`}</strong>
              </p>
              <p>
                Unsatisfiable classes: <strong>{run.owl.unsatisfiable.length}</strong>
              </p>
              <p className="muted">
                {run.owl.asserted} stated facts, {run.owl.inferred} inferred · {run.owl.ms} ms
              </p>
            </>
          )}
          <details>
            <summary>What this covers</summary>
            <p>The app’s own reasoner: {run?.owl?.profile ?? 'RDFS and a subset of OWL 2 RL'}.</p>
            <ul>
              {REASONER_LIMITS.map((x) => (
                <li key={x}>{x}</li>
              ))}
              <li>OWL is open-world: something that is not stated is unknown, not wrong. A missing value is never an inconsistency. To require data, use a SHACL shape.</li>
              <li>An unsatisfiable class does not make the ontology inconsistent: the class exists, it just cannot have members.</li>
              {!model.vocab.enabled && model.mode !== 'skos' && <li>“Use RDFS &amp; OWL properties” is off, so only the hierarchy and property declarations are reasoned with.</li>}
            </ul>
          </details>
        </section>

        <section className={'card ' + (run?.shacl ? (run.shacl.status === 'conforms' ? 'is-good' : run.shacl.status === 'skipped' ? '' : run.shacl.violations || run.shacl.status === 'failed' ? 'is-bad' : 'is-warn') : '')}>
          <h3>SHACL validation</h3>
          {!run?.shacl ? (
            <p className="muted">Not run for this revision.</p>
          ) : run.shacl.status === 'skipped' ? (
            <p className="muted">
              No shapes yet, so there is nothing to validate against.{' '}
              <button className="link" onClick={() => st().setValidation({ tab: 'shapes' })}>
                Make or import shapes
              </button>
            </p>
          ) : run.shacl.status === 'failed' ? (
            <p className="bad">{run.shacl.error}</p>
          ) : (
            <>
              <p className="status">
                Status: <strong>{run.shacl.status === 'conforms' ? 'Conforms' : 'Does not conform'}</strong>
              </p>
              <p>
                Violations: <strong>{run.shacl.violations}</strong> · Warnings: <strong>{run.shacl.warnings}</strong>
                {run.shacl.infos > 0 && (
                  <>
                    {' '}
                    · Info: <strong>{run.shacl.infos}</strong>
                  </>
                )}
              </p>
              <p className="muted">
                {run.shacl.shapes} shape{run.shacl.shapes === 1 ? '' : 's'} · {run.shacl.dataTriples} triples from {run.shacl.dataSource} · {run.shacl.ms} ms
              </p>
            </>
          )}
          <div className="data-graph">
            <label>
              <span>Data to validate</span>
              <select aria-label="Data to validate" value={data.source} onChange={(e) => (e.target.value === 'model' ? st().setValidation({ data: MODEL_DATA }) : data.source === 'imported' ? undefined : dataRef.current?.click())}>
                <option value="model">This model</option>
                <option value="imported">{data.source === 'imported' ? `Imported: ${data.name}` : 'Imported RDF data…'}</option>
              </select>
            </label>
            {data.source === 'imported' && (
              <>
                <label className="check">
                  <input type="checkbox" checked={data.includeOntology} onChange={(e) => st().setValidation({ data: { ...data, includeOntology: e.target.checked } })} />
                  <span>with the ontology’s triples</span>
                </label>
                <button className="link" onClick={() => dataRef.current?.click()}>
                  another file…
                </button>
              </>
            )}
          </div>
          <details>
            <summary>What is validated</summary>
            <ul>
              <li>
                <strong>Shapes graph:</strong> the model’s shapes, and nothing else. OWL restrictions are not turned into shapes.
              </li>
              <li>
                <strong>Data graph, “This model”:</strong> the model as RDF, which is its individuals <em>and</em> its ontology triples (classes, properties, hierarchy). The hierarchy is what lets a shape for Person reach an Employee.
              </li>
              <li>
                <strong>Data graph, imported:</strong> the file you choose, with the ontology’s triples added if the box is ticked. The file is used for validation only: it is not added to the model and not saved with it.
              </li>
              <li>
                <strong>Engine:</strong> {SHACL_ENGINE.name}. {SHACL_ENGINE.supports}.
              </li>
              {SHACL_ENGINE.not.map((x) => (
                <li key={x}>Not supported: {x}</li>
              ))}
              <li>Reasoner-inferred types are not added to the data graph.</li>
            </ul>
          </details>
        </section>

        <section className={'card ' + (run?.quality ? (run.quality.errors ? 'is-bad' : run.quality.warnings ? 'is-warn' : 'is-good') : '')}>
          <h3>Ontology quality</h3>
          {!run?.quality ? (
            <p className="muted">Not run for this revision.</p>
          ) : (
            <>
              <p className="status">
                Warnings: <strong>{run.quality.warnings + run.quality.errors}</strong>
              </p>
              <p>
                Suggestions: <strong>{run.quality.suggestions}</strong>
              </p>
              <p className="muted">
                {run.quality.rulesOn} of {run.quality.rulesTotal} rules on · {run.quality.ms} ms
              </p>
            </>
          )}
          <p className="muted">
            Rules of thumb, not errors. A class without a definition or a property without a range is valid OWL.{' '}
            <button className="link" onClick={() => st().setValidation({ tab: 'rules' })}>
              Choose the rules
            </button>
          </p>
        </section>
      </div>

      <div className="tabs sub" role="tablist" aria-label="Validation">
        {(
          [
            ['results', `Results (${findings.length})`],
            ['shapes', `SHACL shapes (${model.shapes.nodes.length}${model.shapes.extra.trim() ? '+' : ''})`],
            ['rules', 'Quality rules'],
            ['inferences', 'Inferred facts'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => st().setValidation({ tab: id })}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'results' && <Results findings={findings} counts={{ owl: count('owl'), shacl: count('shacl'), quality: count('quality') }} stale={stale} ran={!!run} />}
      {tab === 'shapes' && <ShapesPanel />}
      {tab === 'rules' && <Rules />}
      {tab === 'inferences' && <Inferences inferences={inferences} />}

      <input
        ref={dataRef}
        type="file"
        hidden
        accept=".ttl,.nt,.n3,.turtle,text/turtle"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importData(f);
        }}
      />
    </div>
  );
}

function Results({ findings, counts, stale, ran }: { findings: Finding[]; counts: Record<Category, number>; stale: boolean; ran: boolean }) {
  const st = useStore.getState;
  const [category, setCategory] = useState<Category | ''>('');
  const [severity, setSeverity] = useState<Level | ''>('');
  const [type, setType] = useState<EntityType | ''>('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const types = useMemo(() => [...new Set(findings.map((f) => f.entity?.type).filter((t): t is EntityType => !!t))].sort(), [findings]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => findings.filter((f) => (!category || f.category === category) && (!severity || f.severity === severity) && (!type || f.entity?.type === type) && (!q || `${f.message}\n${f.rule}\n${f.entity?.name ?? ''}\n${f.entity?.iri ?? ''}\n${f.property ?? ''}`.toLowerCase().includes(q))),
    [findings, category, severity, type, q],
  );

  /** Opens what a result is about in the side panel (or the shape editor), without leaving the results. */
  const openEntity = (f: Finding) => {
    const e = f.entity;
    if (!e) return;
    if (e.kind === 'term') st().select([e.id]);
    else if (e.kind === 'prop') st().selectProp(e.id);
    else if (e.kind === 'rel') st().select([], [e.id]);
    else if (e.kind === 'shape') st().setValidation({ tab: 'shapes', shapeId: e.id });
    else if (e.kind === 'model') st().select([]);
  };
  const showOnCanvas = (f: Finding) => {
    if (f.terms.length) st().focusTerm(f.terms[0]);
    else if (f.rels.length) st().focusRelation(f.rels[0]);
    else return;
    if (f.terms.length + f.rels.length > 1) st().select(f.terms, f.rels);
    st().setHighlight([...f.terms, ...f.rels], `${categoryLabel(f.category)}: ${f.rule}`);
  };
  const applyFix = (f: Finding) => {
    if (!f.fix) return;
    st().apply(f.fix.apply);
    setFixing(null);
    setOpen(null);
    st().notify(`Done: ${f.fix.label}. Undo takes it back.`);
    // What was found before the fix no longer describes the model, so it is looked at again.
    void st().runValidation('all');
  };

  return (
    <>
      <div className="filters">
        <label>
          <span>Category</span>
          <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as Category | '')}>
            <option value="">All ({findings.length})</option>
            <option value="owl">OWL ({counts.owl})</option>
            <option value="shacl">SHACL ({counts.shacl})</option>
            <option value="quality">Quality ({counts.quality})</option>
          </select>
        </label>
        <label>
          <span>Severity</span>
          <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as Level | '')}>
            <option value="">All</option>
            <option value="error">Errors</option>
            <option value="warning">Warnings</option>
            <option value="info">Suggestions</option>
          </select>
        </label>
        <label>
          <span>Entity type</span>
          <select aria-label="Entity type" value={type} onChange={(e) => setType(e.target.value as EntityType | '')}>
            <option value="">All</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          <span>Search</span>
          <input type="search" aria-label="Search results" placeholder="entity, IRI, rule or message" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <span className="muted">
          {shown.length} of {findings.length}
        </span>
      </div>
      <div className={'table-wrap results' + (stale ? ' is-stale' : '')}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 96 }}>Severity</th>
              <th style={{ width: 86 }}>Category</th>
              <th style={{ width: '20%' }}>Entity</th>
              <th>Issue</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((f) => (
              <Fragment key={f.id}>
                <tr
                  className={'result' + (open === f.id ? ' sel' : '')}
                  onClick={() => {
                    setOpen(open === f.id ? null : f.id);
                    setFixing(null);
                    openEntity(f);
                  }}
                >
                  <td>
                    <span className={'sev ' + f.severity}>{SEVERITY_LABEL[f.severity]}</span>
                  </td>
                  <td>
                    <span className={'cat ' + f.category}>{categoryLabel(f.category)}</span>
                  </td>
                  <td className="entity">
                    {f.entity ? (
                      <>
                        <button className="link" title={`${f.entity.iri ?? ''}\nOpen this ${f.entity.type}`}>
                          {f.entity.name}
                        </button>
                        <span className="muted"> {f.entity.type}</span>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <strong>{f.rule}</strong> <span className="msg">{f.message}</span>
                  </td>
                  <td className="row-actions">
                    {f.fix && <span className="tag auto">fix available</span>}
                    <Disclosure open={open === f.id} />
                  </td>
                </tr>
                {open === f.id && (
                  <tr className="detail">
                    <td colSpan={5} onClick={(e) => e.stopPropagation()}>
                      <dl>
                        <dt>Category</dt>
                        <dd>
                          {f.category === 'owl' ? 'OWL logical consistency: from the reasoner' : f.category === 'shacl' ? 'SHACL constraint: the data does not have the required shape' : 'Ontology quality: a modelling diagnostic, not an error in the logic'}
                        </dd>
                        {f.entity && (
                          <>
                            <dt>{f.category === 'shacl' ? 'Focus node' : 'Entity'}</dt>
                            <dd>
                              {f.entity.name} <span className="muted">({f.entity.type})</span> {f.entity.iri && <code>{f.entity.iri}</code>}
                              {f.entity.kind === 'external' && <span className="muted"> — in the validated data, not an entity of this model</span>}
                            </dd>
                          </>
                        )}
                        {f.property && (
                          <>
                            <dt>Property</dt>
                            <dd>{f.property}</dd>
                          </>
                        )}
                        <dt>{f.category === 'shacl' ? 'Constraint' : 'Rule'}</dt>
                        <dd>{f.rule}</dd>
                        {f.explanation && (
                          <>
                            <dt>{f.category === 'owl' ? 'Justification' : 'About this rule'}</dt>
                            <dd>{f.explanation}</dd>
                          </>
                        )}
                        {f.category === 'owl' && !f.explanation && (
                          <>
                            <dt>Justification</dt>
                            <dd className="muted">The reasoner gives none for this.</dd>
                          </>
                        )}
                        {f.suggestion && (
                          <>
                            <dt>What can be done</dt>
                            <dd>{f.suggestion}</dd>
                          </>
                        )}
                        {f.shacl && (
                          <>
                            <dt>sh:focusNode</dt>
                            <dd>
                              <code>{f.shacl.focusNode}</code>
                            </dd>
                            <dt>sh:resultPath</dt>
                            <dd>{f.shacl.resultPath ? <code>{f.shacl.resultPath}</code> : <span className="muted">not given: the constraint is on the node itself</span>}</dd>
                            <dt>sh:value</dt>
                            <dd>{f.shacl.value ? <code>{f.shacl.value}</code> : <span className="muted">not given: there is no single offending value</span>}</dd>
                            <dt>sh:sourceShape</dt>
                            <dd>
                              <code>{f.shacl.sourceShape}</code>
                            </dd>
                            <dt>sh:sourceConstraintComponent</dt>
                            <dd>
                              <code>{f.shacl.sourceConstraintComponent}</code>
                            </dd>
                            <dt>sh:resultSeverity</dt>
                            <dd>
                              <code>{f.shacl.resultSeverity}</code>
                            </dd>
                            <dt>sh:resultMessage</dt>
                            <dd>{f.shacl.resultMessage.length ? f.shacl.resultMessage.join(' ') : <span className="muted">not given</span>}</dd>
                          </>
                        )}
                      </dl>
                      {fixing === f.id && f.fix && (
                        <div className="fix-preview" role="group" aria-label="Proposed change">
                          <strong>Proposed change</strong>
                          <p>{f.fix.preview}</p>
                          <div className="row">
                            <button className="btn small primary" onClick={() => applyFix(f)}>
                              Apply this change
                            </button>
                            <button className="btn small" onClick={() => setFixing(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="row wrap">
                        {f.fix && fixing !== f.id && (
                          <button className="btn small" disabled={stale} title={stale ? 'Run the checks again first: the model has changed since this was found' : 'Shows what would change before anything is changed'} onClick={() => setFixing(f.id)}>
                            {f.fix.label}…
                          </button>
                        )}
                        {(f.terms.length > 0 || f.rels.length > 0) && (
                          <button className="btn small" onClick={() => showOnCanvas(f)}>
                            Show in the graph
                          </button>
                        )}
                        {f.shapeId && (
                          <button className="btn small" onClick={() => st().setValidation({ tab: 'shapes', shapeId: f.shapeId! })}>
                            Open the shape
                          </button>
                        )}
                        {f.category === 'quality' && (
                          <button
                            className="btn small ghost"
                            title="Stop reporting this rule for this model. It can be switched on again under Quality rules."
                            onClick={() => {
                              st().apply((m) => ({ ...m, quality: setRule(m.quality, f.ruleId, false) }));
                              void st().runValidation('quality');
                            }}
                          >
                            Switch this rule off
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="muted pad">{!ran ? 'Run the checks to see results.' : findings.length ? 'No result matches these filters.' : 'Nothing found. The model passes every check that was run.'}</p>}
        {shown.length > limit && (
          <p className="pager">
            Showing {limit} of {shown.length}.
            <button className="btn small" onClick={() => setLimit(limit + PAGE * 3)}>
              Show {Math.min(PAGE * 3, shown.length - limit)} more
            </button>
            <button className="btn small" onClick={() => setLimit(shown.length)}>
              Show all
            </button>
          </p>
        )}
      </div>
    </>
  );
}

const GROUPS: RuleGroup[] = ['Documentation', 'Structure', 'IRIs and namespaces', 'Modelling practice', 'Governance', 'SKOS integrity'];

function Rules() {
  const quality = useStore((s) => s.model.quality);
  const st = useStore.getState;
  const set = (id: string, on: boolean) => st().apply((m) => ({ ...m, quality: setRule(m.quality, id, on) }));
  const changed = quality.off.length + quality.on.length;
  return (
    <div className="rules">
      <p className="muted">
        Each rule points out something worth a second look. None of them says the ontology is wrong, and none is needed for it to be valid OWL. Switch off the ones that do not fit how you model. The choice is saved with the model.
        {changed > 0 && (
          <>
            {' '}
            <button className="link" onClick={() => st().apply((m) => ({ ...m, quality: { off: [], on: [] } }))}>
              Back to the defaults
            </button>
          </>
        )}
      </p>
      {GROUPS.map((g) => (
        <fieldset key={g}>
          <legend>{g}</legend>
          {QUALITY_RULES.filter((r) => r.group === g).map((r) => (
            <label key={r.id} className="check rule">
              <input type="checkbox" checked={ruleEnabled(quality, r)} onChange={(e) => set(r.id, e.target.checked)} />
              <span>
                <strong>{r.label}</strong> <span className={'sev ' + r.severity}>{SEVERITY_LABEL[r.severity].toLowerCase()}</span>
                {!r.default && <span className="tag auto">off by default</span>}
                <small>{r.about}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

/** What follows from the model: not problems, but the other half of what the reasoner works out. */
function Inferences({ inferences }: { inferences: ReturnType<typeof reason>['inferences'] }) {
  const st = useStore.getState;
  const [limit, setLimit] = useState(PAGE);
  const show = (terms: string[], rels: string[]) => {
    if (terms.length) st().focusTerm(terms[0]);
    else if (rels.length) st().focusRelation(rels[0]);
    st().select(terms, rels);
  };
  return (
    <div className="issues">
      <p className="muted note">What the reasoner derives from the model, each with the stated facts it rests on. These are not stored: “Add to model” states one explicitly.</p>
      {!inferences.length && <p className="muted note">Nothing new follows from the model yet.</p>}
      {inferences.slice(0, limit).map((i) => (
        <div key={i.key} className="issue inference">
          <span className="sev inferred">inferred</span>
          <button className="issue-rule link" onClick={() => show(i.terms, i.rels)} title="Show what this rests on">
            {i.text}
          </button>
          <span className="issue-msg">
            <span className="why">Because {i.because}</span>
          </span>
          {i.add && (
            <button className="btn small" title="State this explicitly as a relation in the model" onClick={() => st().addRelation(i.add!)}>
              Add to model
            </button>
          )}
        </div>
      ))}
      {inferences.length > limit && (
        <p className="pager">
          Showing {limit} of {inferences.length} inferred facts.
          <button className="btn small" onClick={() => setLimit(limit + 500)}>
            Show 500 more
          </button>
          <button className="btn small" onClick={() => setLimit(inferences.length)}>
            Show all
          </button>
        </p>
      )}
    </div>
  );
}
