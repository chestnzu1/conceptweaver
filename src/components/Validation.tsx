import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { download } from '../model/files';
import { objectProperties } from '../model/props';
import { QUALITY_RULES, ruleEnabled, setRule, type RuleGroup } from '../model/quality';
import { currentData, currentShapeSet, dataOf, graphsHere, keepGraphText, readDataGraph } from '../model/dataGraphs';
import { fileText, FORMAT_LABEL, ONTOLOGY_FILES, type DocumentFormat } from '../model/rdfFormats';
import { useReasoning, WORKING } from './reasoning';
import type { Inference } from '../model/store';
import { currentDl, runIsStale, useStore } from '../model/store';
import { creditOf, DL_REASONERS, ENGINES, reasonerHealth, type DlReasonerChoice, type ReasoningResult } from '../model/reasoning';
import { MODEL_DATA, type Category, type EntityType, type Finding, type JustifiedEntity, type Level, type Scope } from '../validation/contracts';
import { fixOf } from '../validation/local';
import { categoryLabel, DL_LIMITS, REASONER_LIMITS, reportJson, reportTurtle, SHACL_ENGINE } from '../validation/report';
import { CommitInput } from './fields';
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
  const { run, running, phase, tab } = useStore((s) => s.validation);
  const st = useStore.getState;
  const dataRef = useRef<HTMLInputElement>(null);
  /** The data graph a file chosen is to replace; a new one when none. */
  const replacing = useRef<string | null>(null);
  const stale = useStore(runIsStale);
  // What SHACL validates, as it is in the model now: one of its data graphs or its own data, with every shape set or one.
  const data = currentData(model, useStore((s) => s.validation.data));
  const shapeSet = currentShapeSet(model, useStore((s) => s.validation.shapeSet));

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
  const reasoning = useReasoning(tab === 'inferences');
  // What the OWL 2 DL reasoner entails, when it is the one chosen and was asked about the model as it is.
  const dl = useStore(currentDl);

  /** Reads a file into a data graph of the model: a new one, or in place of the content of one it has. */
  const readData = async (file: File, id: string | null) => {
    try {
      const was = id ? st().model.dataGraphs.find((g) => g.id === id) : undefined;
      const { ref, turtle } = await readDataGraph(await fileText(file), file.name, st().validation.reasonerUrl, was?.id);
      const kept = await keepGraphText(ref.id, turtle);
      const from = `${ref.triples} triples${ref.format === 'turtle' ? '' : `, read from ${FORMAT_LABEL[ref.format as DocumentFormat] ?? ref.format}`}`;
      const only = kept ? '' : ' This browser keeps nothing for the site, so its content is here for this session only.';
      if (was) {
        // Replaced: the same graph, called and taken as before, with what the file has now.
        st().setDataGraphs((all) => all.map((g) => (g.id === was.id ? { ...ref, name: g.name, includeOntology: g.includeOntology } : g)));
        st().notify(`“${was.name}” is now what ${file.name} has: ${from}.${only}`);
      } else {
        st().setDataGraphs((all) => [...all, ref]);
        st().setValidation({ data: dataOf(ref) });
        st().notify(`${file.name}: ${from}, now a data graph of this model and the data SHACL validates. Nothing of it is added to the ontology.${only}`);
      }
    } catch (e) {
      st().notify(`Could not read ${file.name}: ${e instanceof Error ? e.message : ''}`);
    }
  };
  const chooseFile = (id: string | null) => {
    replacing.current = id;
    dataRef.current?.click();
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
          {running && (
            <button className="btn" title="Stops the checks under way: the results shown stay those of the last run" onClick={() => st().cancelValidation()}>
              Stop
            </button>
          )}
        </div>
        <span className="muted run-state" role="status" aria-live="polite">
          {running ? phase || 'Working…' : run ? `Validated ${new Date(run.at).toLocaleTimeString()} · revision ${run.fingerprint} · ${run.entities} entities` : 'Not validated yet.'}
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
          The model has changed since these results (revision {run!.fingerprint}). They may no longer hold.{' '}
          <button className="link" onClick={() => void st().runValidation('all')}>
            Run all checks again
          </button>
        </p>
      )}

      <div className="summary" aria-label="Summary">
        <OwlCard />

        <section className={'card ' + (run?.shacl ? (run.shacl.status === 'conforms' ? 'is-good' : run.shacl.status === 'skipped' ? '' : run.shacl.violations || run.shacl.status === 'failed' ? 'is-bad' : 'is-warn') : '')}>
          <h3>SHACL validation</h3>
          {!run?.shacl ? (
            <p className="muted">Not run for this revision.</p>
          ) : run.shacl.status === 'skipped' ? (
            <p className="muted">
              No shapes yet, so there is nothing to validate against.{' '}
              <button className="link" onClick={() => st().openShapes()}>
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
                {run.shacl.shapes} shape{run.shacl.shapes === 1 ? '' : 's'} {run.shacl.shapeSet ? `of “${run.shacl.shapeSet.name}”` : 'of every set'} · {run.shacl.dataTriples} triples from {run.shacl.dataSource} · {run.shacl.ms} ms
              </p>
            </>
          )}
          <div className="data-graph">
            <label>
              <span>Shapes</span>
              <select aria-label="Shapes to validate with" value={shapeSet ?? ''} onChange={(e) => st().setValidation({ shapeSet: e.target.value || null })}>
                <option value="">Every shape set{model.shapeSets.length > 1 ? ` (${model.shapeSets.length})` : ''}</option>
                {model.shapeSets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || 'Shapes'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Data</span>
              <select
                aria-label="Data to validate"
                value={data.id ?? 'model'}
                onChange={(e) => {
                  const v = e.target.value;
                  const g = model.dataGraphs.find((x) => x.id === v);
                  if (v === 'model') st().setValidation({ data: MODEL_DATA });
                  else if (g) st().setValidation({ data: dataOf(g) });
                  else chooseFile(null);
                }}
              >
                <option value="model">This model</option>
                {model.dataGraphs.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.triples} triples)
                  </option>
                ))}
                <option value="add">Add a data graph…</option>
              </select>
            </label>
            {data.source === 'graph' && (
              <label className="check">
                <input type="checkbox" checked={data.includeOntology} onChange={(e) => st().setDataGraphs((all) => all.map((g) => (g.id === data.id ? { ...g, includeOntology: e.target.checked } : g)))} />
                <span>with the ontology’s triples</span>
              </label>
            )}
            <button className="link" onClick={() => st().setValidation({ tab: 'graphs' })}>
              Data graphs ({model.dataGraphs.length})
            </button>
          </div>
          <details>
            <summary>What is validated</summary>
            <ul>
              <li>
                <strong>Shapes graph:</strong> the shape set chosen, or every set of the model, and nothing else. OWL restrictions are not turned into shapes.
              </li>
              <li>
                <strong>Data graph, “This model”:</strong> the model as RDF, which is its individuals <em>and</em> its ontology triples (classes, properties, hierarchy). The hierarchy is what lets a shape for Person reach an Employee.
              </li>
              <li>
                <strong>A data graph of the model:</strong> RDF read from a file, with the ontology’s triples added if the box is ticked. It is kept with the model and its content in this browser; nothing of it is added to the ontology. A finding gives the line of the file its focus node is on, where the file was Turtle.
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
            ['graphs', `Data graphs (${model.dataGraphs.length})`],
            ['rules', 'Quality rules'],
            ['inferences', 'Inferred facts'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => st().setValidation({ tab: id })}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'results' && <Results findings={findings} counts={{ owl: count('owl'), shacl: count('shacl'), quality: count('quality') }} stale={stale} ran={!!run} dataName={run?.data.source === 'graph' ? (run.shacl?.dataSource ?? '') : ''} />}
      {tab === 'graphs' && <DataGraphs chooseFile={chooseFile} />}
      {tab === 'rules' && <Rules />}
      {tab === 'inferences' && (
        <>
          <p className="note inferred-graph">
            <button
              className="btn small"
              title="Goes to the graph and draws the inferred class memberships and relationships between individuals, dotted, beside what is asserted"
              onClick={() => {
                st().setShowInferred(true);
                st().setView('graph');
              }}
            >
              Show inferred facts in the graph
            </button>
          </p>
          {dl ? <DlInferences result={dl} /> : <Inferences inferences={reasoning?.inferences} />}
        </>
      )}

      <input
        ref={dataRef}
        type="file"
        hidden
        accept={ONTOLOGY_FILES}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void readData(f, replacing.current);
        }}
      />
    </div>
  );
}

/**
 * What the reasoner says: which reasoner, whether the ontology is consistent, and which classes
 * can have no members. The engine is chosen here. The two do not promise the same, and the card
 * says which one answered and how far its answer goes.
 */
function OwlCard() {
  const model = useStore((s) => s.model);
  const { run, running, engine, reasonerUrl, dlReasoner } = useStore((s) => s.validation);
  const st = useStore.getState;
  const owl = run?.owl;
  const [health, setHealth] = useState<Awaited<ReturnType<typeof reasonerHealth>> | 'asking' | null>(null);
  // Whether the service is there is asked when the advanced reasoner is chosen, when its address changes, and after each run.
  useEffect(() => {
    if (engine !== 'dl') return;
    let live = true;
    setHealth('asking');
    void reasonerHealth(reasonerUrl).then((h) => live && setHealth(h));
    return () => {
      live = false;
    };
  }, [engine, reasonerUrl, run?.at]);

  const names = useMemo(() => new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed'])), [model.terms]);
  const chosen = ENGINES.find((e) => e.id === engine)!;
  const dl = owl?.engine === 'dl';
  const status = !owl
    ? ''
    : owl.status === 'unknown'
      ? 'Unknown: the reasoner gave no answer'
      : owl.status === 'inconsistent'
        ? dl
          ? 'Inconsistent'
          : `Inconsistent: ${owl.contradictions} contradiction${owl.contradictions === 1 ? '' : 's'}`
        : dl
          ? owl.proved
            ? 'Consistent'
            : 'Consistent, for what could be reasoned over (partial)'
          : owl.partial
            ? 'No contradiction found (partial)'
            : 'No contradiction found';
  const tone = !owl || owl.status === 'not-applicable' ? '' : owl.status === 'inconsistent' ? 'is-bad' : owl.status === 'unknown' || owl.unsatisfiable.length || (dl && !owl.proved) ? 'is-warn' : 'is-good';
  // The finding that explains a class, to open it in the results.
  const findingOf = (id: string) => run?.findings.find((f) => f.category === 'owl' && (f.ruleId === 'owl-unsatisfiable' || f.ruleId === 'owl-restrictions') && f.entity?.kind === 'term' && f.entity.id === id)?.id;
  const explain = (id: string | undefined) => id && st().setValidation({ tab: 'results', focus: id });
  const contradiction = run?.findings.find((f) => f.category === 'owl' && f.ruleId === 'owl-inconsistent')?.id;
  const SHOWN = 12;

  return (
    <section className={'card owl-card ' + tone}>
      <h3>OWL consistency</h3>
      {model.mode === 'skos' ? (
        <p className="muted">A SKOS concept scheme has no OWL axioms to contradict each other. Its integrity conditions are checked under Quality.</p>
      ) : (
        <>
          <fieldset className="engine" disabled={running}>
            <legend>Reasoning engine</legend>
            {ENGINES.map((e) => (
              <label key={e.id} title={e.about}>
                <input
                  type="radio"
                  name="reasoning-engine"
                  checked={engine === e.id}
                  onChange={() => {
                    // The other reasoner's answer is not left standing as if it were this one's: it is asked at once.
                    st().setValidation({ engine: e.id });
                    void st().runValidation('owl');
                  }}
                />
                <span>{e.label}</span>
              </label>
            ))}
            <button className="btn small" title={`Reasons over the ontology with the ${engine === 'dl' ? 'OWL 2 DL reasoner' : 'app’s own rules'}. The other checks are left as they are.`} onClick={() => void st().runValidation('owl')}>
              Run reasoning
            </button>
          </fieldset>
          {engine === 'dl' && (
            <div className="service">
              <label>
                <span>Reasoning service</span>
                <CommitInput aria-label="Address of the reasoning service" value={reasonerUrl} spellCheck={false} onCommit={(v) => st().setValidation({ reasonerUrl: v.trim() || 'http://localhost:5190' })} />
              </label>
              <label title={DL_REASONERS.find((r) => r.id === dlReasoner)?.about}>
                <span>Reasoner</span>
                <select
                  aria-label="Which reasoner the service uses"
                  value={dlReasoner}
                  disabled={running}
                  onChange={(e) => {
                    st().setValidation({ dlReasoner: e.target.value as DlReasonerChoice });
                    void st().runValidation('owl');
                  }}
                >
                  {DL_REASONERS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className={'health ' + (health === 'asking' || !health ? '' : health.ok ? 'up' : 'down')} role="status">
                {health === 'asking' || !health ? 'Looking for it…' : health.ok ? `${health.engine} ${health.engineVersion} is running` : 'Not running'}
              </span>
              {/* Said once: below, where a run that could not reach it reports the same. */}
              {health && health !== 'asking' && !health.ok && !(dl && owl?.errors?.length) && <p className="muted">{health.error}</p>}
            </div>
          )}
          {!owl || owl.status === 'not-applicable' ? (
            <p className="muted">Not run for this revision.</p>
          ) : (
            <div className="reasoned" data-engine={owl.engine}>
              {owl.engine !== engine && (
                <p className="muted">
                  What follows is the answer of the {dl ? 'OWL 2 DL reasoner' : 'fast reasoner'}. Run reasoning to ask the {engine === 'dl' ? 'OWL 2 DL reasoner' : 'fast reasoner'}.
                </p>
              )}
              <p className="reasoner">
                Reasoner: <strong>{owl.engineName}</strong>
              </p>
              {owl.chosen && <p className="muted chosen">{owl.chosen}</p>}
              <p className="status">
                Status: <strong>{status}</strong>
                {contradiction && dl && (
                  <button className="link" onClick={() => explain(contradiction)}>
                    View explanation
                  </button>
                )}
              </p>
              {!dl && owl.status === 'consistent' && <p className="muted">Its rules reached no contradiction. That is not a proof that the ontology is consistent: the OWL 2 DL reasoner gives one.</p>}
              {owl.errors?.map((e) => (
                <p key={e} className="reasoner-error" role="alert">
                  {e}
                </p>
              ))}
              {owl.status !== 'unknown' && !(dl && owl.status === 'inconsistent') && (
                <>
                  <p>
                    Unsatisfiable classes: <strong>{owl.unsatisfiable.length}</strong>
                  </p>
                  {owl.unsatisfiable.length > 0 && (
                    <ul className="unsat" aria-label="Unsatisfiable classes">
                      {owl.unsatisfiable.slice(0, SHOWN).map((id) => (
                        <li key={id}>
                          <button className="link" title="Open this class in the editor" onClick={() => st().select([id])}>
                            {names.get(id) ?? 'A class no longer in the model'}
                          </button>
                          {findingOf(id) && (
                            <button className="link explain" onClick={() => explain(findingOf(id))}>
                              View explanation
                            </button>
                          )}
                        </li>
                      ))}
                      {owl.unsatisfiable.length > SHOWN && <li className="muted">and {owl.unsatisfiable.length - SHOWN} more, in the results below</li>}
                    </ul>
                  )}
                </>
              )}
              {owl.notes?.map((n) => (
                <p key={n} className="muted reasoner-note">
                  {n}
                </p>
              ))}
              {owl.status === 'unknown' && !owl.asserted ? null : (
                <p className="muted">
                  {owl.asserted} {dl ? 'logical axioms' : 'stated facts'}
                  {owl.status === 'unknown' || (dl && owl.status === 'inconsistent') ? '' : `, ${owl.inferred} inferred`} · {owl.ms} ms
                </p>
              )}
            </div>
          )}
          <details>
            <summary>What this covers</summary>
            {(owl?.engine ?? engine) === 'dl' ? (
              <>
                <p>{owl?.engineName ?? 'HermiT'}: {owl?.profile ?? chosen.about}.</p>
                <ul>
                  {DL_LIMITS.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                  <li>An unsatisfiable class does not make the ontology inconsistent: the class exists, it just cannot have members. It becomes inconsistent when something is stated to be an instance of it.</li>
                </ul>
              </>
            ) : (
              <>
                <p>The app’s own reasoner: {owl?.profile ?? 'RDFS and a subset of OWL 2 RL'}.</p>
                <ul>
                  {REASONER_LIMITS.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                  <li>OWL is open-world: something that is not stated is unknown, not wrong. A missing value is never an inconsistency. To require data, use a SHACL shape.</li>
                  <li>An unsatisfiable class does not make the ontology inconsistent: the class exists, it just cannot have members.</li>
                  {!model.vocab.enabled && <li>“Use RDFS &amp; OWL properties” is off, so only the hierarchy and property declarations are reasoned with.</li>}
                </ul>
              </>
            )}
          </details>
        </>
      )}
    </section>
  );
}

const KEYWORDS = /\b(SubClassOf|EquivalentTo|DisjointWith|DisjointClasses|SubPropertyOf|InverseOf|Domain|Range|Type|Types|SameAs|DifferentFrom|DifferentIndividuals|SameIndividual|Functional|InverseFunctional|Transitive|Symmetric|Asymmetric|Reflexive|Irreflexive|some|only|min|max|exactly|value|Self|and|or|not|that|inverse)\b/;

/**
 * One asserted axiom of a justification, in Manchester syntax as the reasoner's library wrote it.
 * The entities in it that are in the model can be clicked, to open them in the editor.
 */
function Axiom({ text, entities }: { text: string; entities: JustifiedEntity[] }) {
  const st = useStore.getState;
  const byToken = new Map<string, JustifiedEntity>();
  for (const e of entities) if (e.kind !== 'external') byToken.set(e.token ?? e.name, e);
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = tokens.length ? text.split(new RegExp(`(?<![\\p{L}\\p{N}_'])(${tokens.map(esc).join('|')})(?![\\p{L}\\p{N}_'])`, 'u')) : [text];
  return (
    <code className="axiom">
      {parts.map((part, i) => {
        const e = byToken.get(part);
        if (e)
          return (
            <button key={i} className="link" title={`Open this ${e.type}`} onClick={() => (e.kind === 'term' ? st().select([e.id]) : st().selectProp(e.id))}>
              {part}
            </button>
          );
        return part.split(KEYWORDS).map((bit, j) => (j % 2 ? <b key={`${i}.${j}`}>{bit}</b> : bit));
      })}
    </code>
  );
}

/** The explanation of a finding of the OWL 2 DL reasoner: its justifications, or the plain statement that there is none. */
function Explanation({ f }: { f: Finding }) {
  const list = f.justifications ?? [];
  if (!list.length) return <p className="muted">{f.justificationNote ?? 'The reasoner gives none for this.'}</p>;
  return (
    <div className="explanation" role="group" aria-label="Explanation">
      {list.map((axioms, n) => (
        <div key={n} className="justification">
          <p className="muted">
            {list.length > 1 ? `Justification ${n + 1} of ${list.length}. ` : ''}
            {axioms.length === 1 ? 'One asserted axiom is enough for it' : `These ${axioms.length} asserted axioms are enough for it, and no fewer of them are`}, according to {f.engine ?? 'the reasoner'}:
          </p>
          <ol>
            {axioms.map((a, i) => (
              <li key={i}>
                <Axiom text={a.text} entities={a.entities} />
              </li>
            ))}
          </ol>
        </div>
      ))}
      <p className="conclusion">
        <strong>Conclusion:</strong> {f.ruleId === 'owl-inconsistent' ? 'these cannot all be true at once, so the ontology is inconsistent.' : `${f.entity?.name ? `“${f.entity.name}”` : 'the class'} cannot have any instances.`}
      </p>
    </div>
  );
}

function Results({ findings, counts, stale, ran, dataName }: { findings: Finding[]; counts: Record<Category, number>; stale: boolean; ran: boolean; dataName: string }) {
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
  // A finding asked for from the summary is opened here: the filters step aside, and it is brought into view.
  const focus = useStore((s) => s.validation.focus);
  useEffect(() => {
    if (!focus) return;
    const at = findings.findIndex((f) => f.id === focus);
    st().setValidation({ focus: null });
    if (at < 0) return;
    setCategory('');
    setSeverity('');
    setType('');
    setQuery('');
    setLimit((n) => Math.max(n, at + 1));
    setOpen(focus);
    setFixing(null);
    requestAnimationFrame(() => document.querySelector('tr.result.sel')?.scrollIntoView({ block: 'nearest' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
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
    else if (e.kind === 'shape') st().openShapes(null, e.id);
    else if (e.kind === 'model') st().select([]);
  };
  const showOnCanvas = (f: Finding) => {
    if (f.terms.length) st().focusTerm(f.terms[0]);
    else if (f.rels.length) st().focusRelation(f.rels[0]);
    else return;
    if (f.terms.length + f.rels.length > 1) st().select(f.terms, f.rels);
    st().setHighlight([...f.terms, ...f.rels], `${categoryLabel(f.category)}: ${f.rule}`);
  };
  /** Opens the shape a SHACL finding is of, at the constraint it failed, with what failed it. */
  const openShape = (f: Finding) => {
    const x = f.shacl;
    st().openShapes(null, f.shapeId!, x ? { finding: f.id, ...(x.parameter ? { parameter: x.parameter } : {}), focusNode: x.focusNode, ...(x.value ? { value: x.value } : {}), ...(x.resultPath ? { path: x.resultPath } : {}), message: f.message, ...(f.entity?.kind === 'external' && dataName ? { data: dataName } : {}), ...(x.line ? { line: x.line } : {}) } : undefined);
  };
  const applyFix = (f: Finding) => {
    // A finding comes with what its fix does; the fix itself is found again in the model as it is.
    const fix = fixOf(st().model, f);
    if (!fix) return st().notify('That fix no longer applies: the model has changed. Run the checks again.');
    st().apply(fix.apply);
    setFixing(null);
    setOpen(null);
    st().notify(`Done: ${fix.label}. Undo takes it back.`);
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
                          {f.category === 'owl' ? `OWL logical consistency: from ${f.engine ? `${f.engine}, the OWL 2 DL reasoner` : 'the app’s own reasoner'}` : f.category === 'shacl' ? 'SHACL constraint: the data does not have the required shape' : 'Ontology quality: a modelling diagnostic, not an error in the logic'}
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
                        {f.justifications ? (
                          <>
                            <dt>Explanation</dt>
                            <dd>
                              <Explanation f={f} />
                            </dd>
                          </>
                        ) : (
                          f.explanation && (
                            <>
                              <dt>{f.category === 'owl' ? 'Justification' : 'About this rule'}</dt>
                              <dd>{f.explanation}</dd>
                            </>
                          )
                        )}
                        {f.category === 'owl' && !f.explanation && !f.justifications && (
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
                              {f.shacl.line && (
                                <span className="muted line">
                                  {' '}
                                  · line {f.shacl.line} of {dataName}
                                </span>
                              )}
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
                          <button className="btn small" title={f.shacl?.parameter ? `Opens the shape this comes from at sh:${f.shacl.parameter}, the constraint that failed` : 'Opens the shape this is about'} onClick={() => (f.category === 'shacl' ? openShape(f) : st().openShapes(null, f.shapeId!))}>
                            {f.shacl?.parameter ? 'Open the shape at this constraint' : 'Open the shape'}
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

/**
 * The data graphs of the model: RDF read from files, each kept with the model and its content in
 * this browser, to validate the shapes against. Each can be renamed, read again from a file,
 * validated, or taken away; nothing of any of them is part of the ontology.
 */
function DataGraphs({ chooseFile }: { chooseFile: (id: string | null) => void }) {
  const graphs = useStore((s) => s.model.dataGraphs);
  const chosen = useStore((s) => s.validation.data);
  const running = useStore((s) => s.validation.running);
  const st = useStore.getState;
  // Which have their content in this browser: a model opened in another names graphs it does not have.
  // A graph is said to be missing only once it has been looked for, not while the answer is about others.
  const [checked, setChecked] = useState<{ of: Set<string>; here: Set<string> } | null>(null);
  useEffect(() => {
    let live = true;
    const ids = graphs.map((g) => g.id);
    void graphsHere(ids).then((here) => live && setChecked({ of: new Set(ids), here }));
    return () => {
      live = false;
    };
  }, [graphs]);
  const missing = (id: string) => !!checked && checked.of.has(id) && !checked.here.has(id);
  const edit = (id: string, patch: Partial<(typeof graphs)[number]>) => st().setDataGraphs((all) => all.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  return (
    <div className="data-graphs">
      <p className="muted">
        RDF to validate the shapes against, beside the model’s own individuals: test data, an export of an application, the rows a mapping produces. Each is kept with the model, its content in this browser; nothing of it is added to the ontology. A model opened in another browser names its data graphs without their content: read each from its file again.
      </p>
      <div className="row">
        <button className="btn small" onClick={() => chooseFile(null)}>
          Add a data graph…
        </button>
      </div>
      {graphs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Read from</th>
                <th style={{ width: 90 }}>Triples</th>
                <th style={{ width: 150 }}>With the ontology</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {graphs.map((g) => (
                <tr key={g.id} data-graph={g.id} className={chosen.id === g.id ? 'sel' : ''}>
                  <td>
                    <CommitInput aria-label={`Name of the data graph ${g.name}`} value={g.name} onCommit={(name) => name.trim() && edit(g.id, { name: name.trim() })} />
                  </td>
                  <td>
                    {g.file} <span className="muted">· {FORMAT_LABEL[g.format as DocumentFormat] ?? g.format}{g.read ? ` · ${new Date(g.read).toLocaleString()}` : ''}</span>
                    {missing(g.id) && (
                      <span className="tag warn" title="Its content is not in this browser: it was read in another one, or the browser cleared it. Read it again from its file.">
                        not in this browser
                      </span>
                    )}
                  </td>
                  <td>{g.triples}</td>
                  <td>
                    <label className="check">
                      <input type="checkbox" checked={g.includeOntology} onChange={(e) => edit(g.id, { includeOntology: e.target.checked })} />
                      <span>{g.includeOntology ? 'yes' : 'no'}</span>
                    </label>
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn small"
                      disabled={running}
                      title="Validates the shapes chosen against this data graph"
                      onClick={() => {
                        st().setValidation({ data: dataOf(g), tab: 'results' });
                        void st().runValidation('shacl');
                      }}
                    >
                      Validate
                    </button>
                    <button className="btn small" title="Reads a file in place of this graph’s content; it keeps its name and setting" onClick={() => chooseFile(g.id)}>
                      Replace…
                    </button>
                    <button
                      className="btn small ghost"
                      title="Takes the graph out of the model. Undo brings it back."
                      onClick={() => {
                        st().setDataGraphs((all) => all.filter((x) => x.id !== g.id));
                        st().notify(`“${g.name}” is no longer a data graph of this model. Undo brings it back.`);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!graphs.length && <p className="muted pad">No data graphs yet. SHACL validates the model’s own individuals until one is added.</p>}
    </div>
  );
}

const GROUPS: RuleGroup[] = ['Documentation', 'Structure', 'IRIs and namespaces', 'Modelling practice', 'Enumerations', 'Governance', 'SKOS integrity'];

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
/**
 * What the OWL 2 DL reasoner entails beyond what is stated: which class is a kind of which, and
 * which individual is an instance of which class. The nearest ones first; the rest follow from them.
 */
function DlInferences({ result }: { result: ReasoningResult }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const [limit, setLimit] = useState(PAGE);
  const names = useMemo(() => new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed'])), [model.terms]);
  const facts = useMemo(() => {
    const q = (id: string) => `“${names.get(id) ?? 'Unnamed'}”`;
    const props = new Map(objectProperties(model).map((p) => [p.id, p.name]));
    const out: { key: string; from: string; to: string; direct: boolean; text: string; label?: string }[] = [
      ...result.types.filter((x) => !x.asserted).map((x) => ({ key: `t|${x.individual}|${x.class}`, from: x.individual, to: x.class, direct: x.direct, text: `${q(x.individual)} is an instance of ${q(x.class)}` })),
      // What holds between two individuals through an inverse, a symmetric or transitive property, a sub-property or an equivalent one.
      ...result.relations.filter((x) => !x.asserted && props.has(x.property)).map((x) => ({ key: `r|${x.subject}|${x.property}|${x.object}`, from: x.subject, to: x.object, direct: true, text: `${q(x.subject)} ${props.get(x.property)} ${q(x.object)}`, label: props.get(x.property)! })),
      ...result.subclasses.filter((x) => !x.asserted).map((x) => ({ key: `s|${x.subclass}|${x.superclass}`, from: x.subclass, to: x.superclass, direct: x.direct, text: `${q(x.subclass)} is a kind of ${q(x.superclass)}` })),
    ];
    return out.sort((a, b) => Number(b.direct) - Number(a.direct) || a.text.localeCompare(b.text));
  }, [result, names, model]);
  const credit = creditOf(result);
  if (result.consistency !== 'consistent')
    return (
      <div className="issues">
        <p className="muted note">The OWL 2 DL reasoner finds the ontology inconsistent. From a contradiction everything follows, so nothing is listed as inferred.</p>
      </div>
    );
  return (
    <div className="issues" data-engine="dl">
      <p className="muted note">
        What {result.engine.name} entails beyond what is stated: class memberships, relationships between individuals and the class hierarchy. {result.proves ? '' : 'The reasoning was partial, so there may be more. '}These are not stored: “Add to model” states one explicitly.
      </p>
      {!facts.length && <p className="muted note">Nothing new follows from the model.</p>}
      {facts.slice(0, limit).map((f) => (
        <div key={f.key} className="issue inference">
          <span className="sev inferred">inferred</span>
          <button
            className="issue-rule link"
            title="Show the two on the canvas"
            onClick={() => {
              st().focusTerm(f.from);
              st().select([f.from, f.to]);
            }}
          >
            {f.text}
          </button>
          <span className="issue-msg">
            <span className="why">
              {credit}
              {f.direct ? '' : ' It follows through what is between them.'}
            </span>
          </span>
          <button className="btn small" title="State this explicitly as a relation in the model" onClick={() => st().addRelation(f.label ? { from: f.from, to: f.to, label: f.label } : { from: f.from, to: f.to, kind: 'generalization' })}>
            Add to model
          </button>
        </div>
      ))}
      {facts.length > limit && (
        <p className="pager">
          Showing {limit} of {facts.length} inferred facts.
          <button className="btn small" onClick={() => setLimit(facts.length)}>
            Show all
          </button>
        </p>
      )}
    </div>
  );
}

/** What the app's own reasoner derives, once it has answered; undefined while it works. */
function Inferences({ inferences }: { inferences: Inference[] | undefined }) {
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
      {!inferences && (
        <p className="muted note" role="status">
          {WORKING}
        </p>
      )}
      {inferences && !inferences.length && <p className="muted note">Nothing new follows from the model yet.</p>}
      {(inferences ?? []).slice(0, limit).map((i) => (
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
      {inferences && inferences.length > limit && (
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
