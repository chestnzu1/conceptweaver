import { useEffect, useMemo, useRef, useState } from 'react';
import { CHARACTERISTICS, OPERATION_TYPES, type Operation, type ProposalInput } from '../../ai/proposals';
import { PROVIDERS, type ProviderSettings } from '../../ai/providers/contracts';
import { endpointProblem, hasKey, heldByService, holdKey, holdKeyInService } from '../../ai/providers/http';
import { adapterFor } from '../../ai/providers/index';
import { ASSISTANT_WIDTH, ontologyKey, proposalKey, useAssistant, type Proposal, type Turn } from '../../ai/state';
import { ontologyIriOf } from '../../model/prefixes';
import { useStore } from '../../model/store';
import { revisionOf } from '../../structure/local';
import { AnswerText } from './AnswerText';

/**
 * "Chat with my ontology" (the assistant): a panel beside the editor, which can be widened and put
 * away. It answers from the ontology open, through read-only tools, and proposes changes the user
 * reviews and accepts or rejects; it never changes the ontology itself. Its settings say which
 * provider, model and key: the key is for this session only.
 */

const providerName = (s: ProviderSettings | null) => (s ? (PROVIDERS.find((p) => p.id === s.provider)?.label ?? s.provider) : 'no provider');
const SUGGESTIONS = ['Explain the selected class.', 'What properties are associated with this class?', 'Why is a class unsatisfiable?', 'Find potentially redundant relationships.', 'Suggest a modelling pattern for nationality.'];

export function AssistantPanel() {
  const open = useAssistant((s) => s.open);
  const width = useAssistant((s) => s.width);
  const settings = useAssistant((s) => s.settings);
  const keyed = useAssistant((s) => s.keyed);
  const reviewing = useAssistant((s) => s.reviewing);
  const showSettings = useAssistant((s) => s.showSettings);
  const confirm = useAssistant((s) => s.confirmLookups);
  const a = useAssistant.getState;
  if (!open) return null;
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = a().width;
    const move = (m: PointerEvent) => a().setWidth(w0 + (x0 - m.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <aside className="panel assistant" style={{ width }} aria-label="Assistant">
      <div
        className="assistant-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Width of the assistant"
        aria-valuemin={ASSISTANT_WIDTH.min}
        aria-valuemax={ASSISTANT_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') a().setWidth(width + 24);
          if (e.key === 'ArrowRight') a().setWidth(width - 24);
        }}
      />
      <div className="assistant-head">
        <h2>Assistant</h2>
        <span className="spacer" />
        <button className="btn small" onClick={() => a().setShowSettings(true)}>
          Settings
        </button>
        <button className="btn small" title="Starts the conversation about this ontology afresh" onClick={() => a().clear()}>
          Clear
        </button>
        <button className="btn icon ghost" aria-label="Hide the assistant" title="Hide the assistant" onClick={() => a().setOpen(false)}>
          ×
        </button>
      </div>
      <div className="assistant-status">
        <span className={'tag ' + (settings && keyed ? 'auto' : 'warn')} title={settings ? `${providerName(settings)} · ${settings.model}` : ''}>
          {settings ? (keyed ? `${providerName(settings)} · ${settings.model}` : `${providerName(settings)}: no key yet`) : 'not set up'}
        </span>
      </div>
      <p className="assistant-notice">
        What you ask, and the parts of this ontology the assistant looks up, are sent to {settings ? providerName(settings) : 'the provider you choose'}{settings?.transport === 'proxy' ? ', through the local service' : ''}
        {confirm ? ', each lookup only once you have seen it and said so' : ''}. It changes nothing without your approval.
      </p>
      <Conversation />
      <Composer />
      {showSettings && <AssistantSettings />}
      {reviewing && <ProposalReview id={reviewing} />}
    </aside>
  );
}

const NO_TURNS: Turn[] = [];

function Conversation() {
  const ontology = useStore((s) => ontologyIriOf(s.model));
  // What was kept of the conversation about this ontology, in an earlier session.
  useEffect(() => {
    void useAssistant.getState().load();
  }, [ontology]);
  const turns = useAssistant((s) => s.conversations[ontologyKey()]?.turns ?? NO_TURNS);
  const end = useRef<HTMLDivElement>(null);
  const last = turns[turns.length - 1];
  const waiting = !!last?.asking;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, last?.text.length, last?.tools.length, last?.proposals.length, last?.error, waiting]);
  const a = useAssistant.getState;
  return (
    <div className="assistant-turns" role="log" aria-label="Conversation" aria-live="polite">
      {!turns.length && (
        <div className="assistant-empty">
          <p className="muted">Ask about the ontology open in the editor: what a class means, how it is defined, what is wrong with it, how to model something. Changes come as proposals for you to review.</p>
          <div className="row wrap">
            {SUGGESTIONS.map((q) => (
              <button key={q} className="btn small" onClick={() => void a().ask(q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      {turns.map((t) => (
        <TurnView key={t.id} t={t} />
      ))}
      <div ref={end} />
    </div>
  );
}

const TOOL_WORDS: Record<string, string> = {
  getOntologySummary: 'Looked at the ontology as a whole',
  searchEntities: 'Searched for',
  getEntityDetails: 'Looked up',
  getClassHierarchy: 'Looked at the hierarchy of',
  getPropertyAxioms: 'Looked at the axioms of',
  getSelectedEntity: 'Looked at the selection',
  getRestrictions: 'Looked at the restrictions of',
  getImports: 'Looked at the imports',
  getValidationResults: 'Looked at the validation results',
  proposeChanges: 'Proposed',
};

function TurnView({ t }: { t: Turn }) {
  const model = useStore((s) => s.model);
  const about = (x: string) => (/^[a-z][\w+.-]*:\/\//i.test(x) ? (model.terms.find((y) => y.iri === x)?.name ?? model.props.find((y) => y.iri === x)?.name ?? x) : x);
  if (t.role === 'user')
    return (
      <div className="turn user">
        <p>{t.text}</p>
      </div>
    );
  return (
    <div className="turn assistant-turn" data-streaming={t.streaming ? 'yes' : 'no'}>
      {t.tools.length > 0 && (
        <ul className="turn-tools" aria-label="What it looked up">
          {t.tools.map((x, i) => (
            <li key={i}>
              {TOOL_WORDS[x.name] ?? x.name} {x.about && <em>{about(x.about).slice(0, 80)}</em>}
              {x.done === undefined ? <span className="muted"> …</span> : x.done ? <span className="muted"> · {x.done}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {t.asking && <LookupApproval turnId={t.id} asking={t.asking} />}
      {t.text ? <AnswerText text={t.text} /> : t.streaming && !t.tools.length ? <p className="muted">Thinking…</p> : null}
      {t.proposals.map((id) => (
        <ProposalCard key={id} id={id} />
      ))}
      {t.error && (
        <p className={t.error === 'Stopped.' ? 'muted' : 'bad'} role="alert">
          {t.error}
        </p>
      )}
    </div>
  );
}

/** A lookup's result, shown before it is sent: sent, or not, as the user says. */
function LookupApproval({ turnId, asking }: { turnId: string; asking: NonNullable<Turn['asking']> }) {
  const settings = useAssistant((s) => s.settings);
  const a = useAssistant.getState;
  let shown = asking.result;
  try {
    shown = JSON.stringify(JSON.parse(asking.result), null, 2);
  } catch {
    // As it is.
  }
  return (
    <div className="lookup-ask" role="group" aria-label="A lookup waiting to be sent">
      <p>
        <strong>Send to {providerName(settings)}?</strong> {TOOL_WORDS[asking.name] ?? asking.name}
        {asking.about ? (
          <>
            {' '}
            <em>{asking.about.slice(0, 80)}</em>
          </>
        ) : null}
        : {asking.result.length.toLocaleString('en')} characters.
      </p>
      <details>
        <summary>What would be sent</summary>
        <pre>{shown.length > 8000 ? shown.slice(0, 8000) + '\n…' : shown}</pre>
      </details>
      <div className="row">
        <button className="btn small primary" onClick={() => a().answerLookup(turnId, true)}>
          Send
        </button>
        <button className="btn small" onClick={() => a().answerLookup(turnId, false)}>
          Don’t send
        </button>
      </div>
    </div>
  );
}

function Composer() {
  const busy = useAssistant((s) => s.busy);
  const model = useStore((s) => s.model);
  const sel = useStore((s) => s.sel);
  const selProp = useStore((s) => s.selProp);
  const [text, setText] = useState('');
  const a = useAssistant.getState;
  const selected = selProp ? model.props.find((p) => p.id === selProp)?.name : sel.terms.length === 1 ? model.terms.find((t) => t.id === sel.terms[0])?.name : undefined;
  const send = () => {
    if (!text.trim() || busy) return;
    void a().ask(text);
    setText('');
  };
  return (
    <div className="assistant-compose">
      {selected && <span className="muted context">About the selection: {selected}</span>}
      <textarea
        aria-label="Ask the assistant"
        placeholder="Ask about this ontology, or ask for a change…"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="row">
        <span className="spacer" />
        {/* Two buttons, not one restyled: the one is never seen fading into the other. */}
        {busy ? (
          <button key="stop" className="btn" onClick={() => a().stop()}>
            Stop
          </button>
        ) : (
          <button key="send" className="btn primary" disabled={!text.trim()} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- proposals

/** Whether a proposal can be accepted as it is, and if not, why: in a word, for its card. */
function standing(p: Proposal, revision: string): { label: string; tone: string; acceptable: boolean } {
  if (p.status === 'applied') return { label: 'applied', tone: 'auto', acceptable: false };
  if (p.status === 'rejected') return { label: 'rejected', tone: '', acceptable: false };
  if (p.review.errors.length) return { label: 'does not read', tone: 'warn', acceptable: false };
  if (p.review.refusals.length) return { label: p.review.refusals.some((r) => r.kind === 'unsupported') ? 'not supported' : 'refused', tone: 'warn', acceptable: false };
  if (p.status === 'stale' || p.revision !== revision) return { label: 'out of date', tone: 'warn', acceptable: false };
  return { label: 'to review', tone: '', acceptable: true };
}

function ProposalCard({ id }: { id: string }) {
  const p = useAssistant((s) => s.proposals[proposalKey(id)]);
  const revision = revisionOf(useStore((s) => s.model));
  const a = useAssistant.getState;
  const [said, setSaid] = useState('');
  if (!p) return null;
  const s = standing(p, revision);
  const adds = p.review.lines.filter((l) => l.op === 'add').length;
  const removes = p.review.lines.filter((l) => l.op === 'remove').length;
  return (
    <div className={'proposal-card ' + p.status} data-proposal={id}>
      <div className="row wrap">
        <strong>{id}</strong>
        <span>{p.input.summary || 'A proposed change'}</span>
        <span className={'tag ' + s.tone}>{s.label}</span>
      </div>
      <p className="muted">
        {adds} axiom{adds === 1 ? '' : 's'} to add, {removes} to remove
        {p.review.logical && 'newlyUnsatisfiable' in p.review.logical && p.review.logical.newlyUnsatisfiable.length ? ` · makes ${p.review.logical.newlyUnsatisfiable.length} class${p.review.logical.newlyUnsatisfiable.length === 1 ? '' : 'es'} unsatisfiable` : ''}
        {p.review.logical && 'inconsistentAfter' in p.review.logical && p.review.logical.inconsistentAfter && !p.review.logical.inconsistentBefore ? ' · makes the ontology inconsistent' : ''}
        {p.dl && p.dl !== 'running' && p.dl.status !== 'failed' ? (p.dl.after === 'inconsistent' && p.dl.before !== 'inconsistent' ? ' · HermiT: makes it inconsistent' : p.dl.newlyUnsatisfiable.length ? ` · HermiT: makes ${p.dl.newlyUnsatisfiable.length} class${p.dl.newlyUnsatisfiable.length === 1 ? '' : 'es'} unsatisfiable` : ' · HermiT finds no new problem') : ''}
      </p>
      <div className="row wrap">
        <button className="btn small" onClick={() => a().setReviewing(id)}>
          Review…
        </button>
        {p.status === 'pending' && (
          <>
            <button
              className="btn small primary"
              disabled={!s.acceptable}
              onClick={async () => {
                const why = await a().accept(id);
                setSaid(why ?? '');
              }}
            >
              Accept
            </button>
            <button className="btn small ghost" onClick={() => a().reject(id)}>
              Reject
            </button>
          </>
        )}
      </div>
      {said && (
        <p className="bad" role="alert">
          {said}
        </p>
      )}
    </div>
  );
}

const FIELDS: Record<Operation['type'], (keyof Operation)[]> = {
  declare: ['entityKind', 'name', 'iri', 'subject'],
  subClassOf: ['subject', 'expression'],
  equivalentClasses: ['subject', 'expression'],
  disjointClasses: ['subject', 'expression'],
  domain: ['property', 'expression'],
  range: ['property', 'expression'],
  characteristic: ['property', 'characteristic'],
  subPropertyOf: ['subject', 'property'],
  inverseOf: ['subject', 'property'],
  classAssertion: ['subject', 'expression'],
  objectPropertyAssertion: ['subject', 'property', 'object'],
  dataPropertyAssertion: ['subject', 'property', 'value', 'datatype'],
  annotation: ['subject', 'property', 'value', 'lang'],
  hasKey: ['subject', 'members'],
  equivalentProperties: ['subject', 'members'],
  disjointProperties: ['subject', 'members'],
  propertyChain: ['property', 'members'],
  sameIndividual: ['subject', 'members'],
  differentIndividuals: ['subject', 'members'],
  datatypeDefinition: ['subject', 'expression'],
  ontologyAnnotation: ['property', 'value', 'lang', 'object'],
  import: ['object'],
};

/**
 * A proposal, reviewed: what it adds and removes, before and after for the entities it touches,
 * what the editor's rules and the reasoner make of it, and what the assistant says it means;
 * edited operation by operation and checked again; then accepted or rejected.
 */
function ProposalReview({ id }: { id: string }) {
  const p = useAssistant((s) => s.proposals[proposalKey(id)]);
  const model = useStore((s) => s.model);
  const revision = revisionOf(model);
  const a = useAssistant.getState;
  const [editing, setEditing] = useState<ProposalInput | null>(null);
  const [said, setSaid] = useState('');
  const [checking, setChecking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  if (!p) return null;
  const s = standing(p, revision);
  const close = () => a().setReviewing(null);
  const r = p.review;
  const logical = r.logical;
  const setOp = (i: number, patch: Partial<Operation>) => setEditing((e) => (e ? { ...e, operations: e.operations.map((o, n) => (n === i ? { ...o, ...patch } : o)) } : e));
  const recheck = async (input?: ProposalInput) => {
    setChecking(true);
    await a().recheck(id, input);
    setChecking(false);
    setEditing(null);
  };
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} tabIndex={-1} className="dialog proposal-review" role="dialog" aria-modal="true" aria-labelledby="review-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="review-title">
          {id}: {p.input.summary || 'A proposed change'}
        </h2>
        <div className="row wrap">
          <span className={'tag ' + s.tone}>{s.label}</span>
          {p.status === 'pending' && p.revision !== revision && <span className="muted">The ontology has changed since this was checked: check it again before accepting it.</span>}
        </div>
        {p.input.explanation && (
          <p>
            <strong>Why. </strong>
            {p.input.explanation}
          </p>
        )}
        {p.input.impact && (
          <p>
            <strong>What it changes. </strong>
            {p.input.impact}
          </p>
        )}
        {p.input.concerns.length > 0 && (
          <div>
            <strong>To check</strong>
            <ul>
              {p.input.concerns.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        <section aria-label="What the editor and the reasoner make of it" className="review-checks">
          {r.errors.length > 0 && <Problems title="Does not read" items={r.errors} />}
          {r.refusals.filter((x) => x.kind !== 'unsupported').length > 0 && <Problems title="Refused by the editor’s rules" items={r.refusals.filter((x) => x.kind !== 'unsupported').map((x) => x.message)} />}
          {r.refusals.filter((x) => x.kind === 'unsupported').length > 0 && <Problems title="Not supported: the editor would not hold it as stated" items={r.refusals.filter((x) => x.kind === 'unsupported').map((x) => x.message)} />}
          {logical && 'skipped' in logical && <p className="muted">{logical.skipped}</p>}
          {logical && 'inconsistentAfter' in logical && (
            <div className="logic">
              <strong>Logic, by the fast reasoner</strong>
              <ul>
                <li className={logical.inconsistentAfter && !logical.inconsistentBefore ? 'bad' : ''}>{logical.inconsistentAfter ? (logical.inconsistentBefore ? 'The ontology is inconsistent before and after.' : 'It makes the ontology inconsistent.') : logical.inconsistentBefore ? 'It makes an inconsistent ontology consistent.' : 'No contradiction found before or after.'}</li>
                {logical.newlyUnsatisfiable.length > 0 && <li className="bad">It makes unsatisfiable: {logical.newlyUnsatisfiable.map((c) => c.name).join(', ')}.</li>}
                {logical.noLongerUnsatisfiable.length > 0 && <li>No longer unsatisfiable: {logical.noLongerUnsatisfiable.map((c) => c.name).join(', ')}.</li>}
              </ul>
              <p className="muted">The fast reasoner covers RDFS and part of OWL 2 RL: what it finds is so; what it does not find may still be.</p>
            </div>
          )}
          {r.changeSet && <DlLogic p={p} current={p.revision === revision} />}
          {r.notes.map((n) => (
            <p key={n} className="muted">
              {n}
            </p>
          ))}
        </section>

        <section aria-label="Axioms added and removed" className="review-lines">
          <strong>Axioms</strong>
          <ul>
            {r.lines.map((l, i) => (
              <li key={i} className={l.op}>
                <code>
                  {l.op === 'add' ? '+' : '−'} {l.text}
                </code>
              </li>
            ))}
          </ul>
        </section>

        {r.affected.length > 0 && (
          <section aria-label="Before and after" className="review-affected">
            {r.affected.map((x) => (
              <details key={x.iri}>
                <summary>
                  {x.name} <span className="muted">before and after</span>
                </summary>
                <div className="before-after">
                  <div>
                    <em>Before</em>
                    <ul>{x.before.length ? x.before.map((t, i) => <li key={i}>{x.after.includes(t) ? t : <del>{t}</del>}</li>) : <li className="muted">Not in the ontology.</li>}</ul>
                  </div>
                  <div>
                    <em>After</em>
                    <ul>{x.after.map((t, i) => <li key={i}>{x.before.includes(t) ? t : <ins>{t}</ins>}</li>)}</ul>
                  </div>
                </div>
              </details>
            ))}
          </section>
        )}

        {editing && (
          <section aria-label="Operations" className="review-edit">
            <strong>Operations</strong>
            {editing.operations.map((o, i) => (
              <div key={i} className="op-row" data-op={i}>
                <select aria-label={`Action of operation ${i + 1}`} value={o.action} onChange={(e) => setOp(i, { action: e.target.value as Operation['action'] })}>
                  <option value="add">add</option>
                  <option value="remove">remove</option>
                </select>
                <select aria-label={`Type of operation ${i + 1}`} value={o.type} onChange={(e) => setOp(i, { type: e.target.value as Operation['type'] })}>
                  {OPERATION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {FIELDS[o.type].map((f) =>
                  f === 'characteristic' ? (
                    <select key={f} aria-label={`Characteristic of operation ${i + 1}`} value={o.characteristic ?? ''} onChange={(e) => setOp(i, { characteristic: e.target.value as Operation['characteristic'] })}>
                      <option value="">characteristic…</option>
                      {CHARACTERISTICS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  ) : f === 'entityKind' ? (
                    <select key={f} aria-label={`What operation ${i + 1} declares`} value={o.entityKind ?? ''} onChange={(e) => setOp(i, { entityKind: e.target.value as Operation['entityKind'] })}>
                      <option value="class">class</option>
                      <option value="objectProperty">object property</option>
                      <option value="dataProperty">data property</option>
                      <option value="individual">individual</option>
                      <option value="datatype">datatype</option>
                    </select>
                  ) : f === 'members' ? (
                    <MembersInput key={f} label={`members of operation ${i + 1}`} value={o.members ?? []} onChange={(members) => setOp(i, { members })} />
                  ) : (
                    <input key={f} aria-label={`${f} of operation ${i + 1}`} placeholder={f} value={String(o[f] ?? '')} spellCheck={false} onChange={(e) => setOp(i, { [f]: e.target.value || undefined })} />
                  ),
                )}
                <button className="btn icon ghost" aria-label={`Take operation ${i + 1} out`} onClick={() => setEditing((e) => (e ? { ...e, operations: e.operations.filter((_, n) => n !== i) } : e))}>
                  ×
                </button>
              </div>
            ))}
          </section>
        )}

        {said && (
          <p className="bad" role="alert">
            {said}
          </p>
        )}
        <div className="dialog-actions">
          {p.status === 'pending' && !editing && (
            <button className="btn" onClick={() => setEditing(JSON.parse(JSON.stringify(p.input)))}>
              Edit
            </button>
          )}
          {editing && (
            <button className="btn" onClick={() => setEditing(null)}>
              Discard edits
            </button>
          )}
          {p.status !== 'applied' && p.status !== 'rejected' && (
            <button className="btn" disabled={checking} title="Compiles and checks it again against the ontology as it is now" onClick={() => void recheck(editing ?? undefined)}>
              {checking ? 'Checking…' : editing ? 'Check the edited proposal' : 'Check again'}
            </button>
          )}
          <span className="spacer" />
          {p.status === 'pending' && (
            <button
              className="btn ghost"
              onClick={() => {
                a().reject(id);
                close();
              }}
            >
              Reject
            </button>
          )}
          <button className="btn" onClick={close}>
            Close
          </button>
          {p.status === 'pending' && (
            <button
              className="btn primary"
              disabled={!s.acceptable || !!editing}
              onClick={async () => {
                const why = await a().accept(id);
                if (why) setSaid(why);
                else close();
              }}
            >
              Accept
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A list of entities, typed with commas between them: the text as typed is kept while it is edited. */
function MembersInput({ label, value, onChange }: { label: string; value: string[]; onChange: (members: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      aria-label={label}
      placeholder="members, separated by commas"
      value={text}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean));
      }}
    />
  );
}

/** What the OWL 2 DL reasoner makes of a proposal, or the button that asks it. */
function DlLogic({ p, current }: { p: Proposal; current: boolean }) {
  const a = useAssistant.getState;
  const dl = p.dl;
  return (
    <div className="logic dl" aria-live="polite">
      <strong>Logic, by the OWL 2 DL reasoner</strong>
      {!dl && (
        <div className="row wrap">
          <button className="btn small" disabled={!current || p.status !== 'pending'} onClick={() => void a().checkWithDl(p.id)}>
            Check with HermiT
          </button>
          <span className="muted">Complete for OWL 2 DL; needs the local service (pnpm reasoner).</span>
        </div>
      )}
      {dl === 'running' && <p className="muted">HermiT is reasoning over the ontology before and after the change…</p>}
      {dl && dl !== 'running' && dl.status === 'failed' && <p className="bad">{dl.errors[0] ?? 'The reasoner gave no answer.'}</p>}
      {dl && dl !== 'running' && dl.status !== 'failed' && (
        <ul>
          <li className={dl.after === 'inconsistent' && dl.before !== 'inconsistent' ? 'bad' : ''}>
            {dl.after === 'inconsistent' ? (dl.before === 'inconsistent' ? 'The ontology is inconsistent before and after.' : 'It makes the ontology inconsistent.') : dl.after === 'unknown' ? 'Whether it is consistent after it is not known.' : dl.before === 'inconsistent' ? 'It makes an inconsistent ontology consistent.' : 'Consistent before and after.'}
          </li>
          {dl.newlyUnsatisfiable.length > 0 && <li className="bad">It makes unsatisfiable: {dl.newlyUnsatisfiable.map((c) => c.name).join(', ')}.</li>}
          {dl.noLongerUnsatisfiable.length > 0 && <li>No longer unsatisfiable: {dl.noLongerUnsatisfiable.map((c) => c.name).join(', ')}.</li>}
          {dl.status === 'partial' && <li className="muted">Partial: {dl.warnings[0] ?? 'something was left out or taken loosely.'}</li>}
          <li className="muted">{dl.engine}.</li>
        </ul>
      )}
    </div>
  );
}

function Problems({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="problems">
      <strong>{title}</strong>
      <ul>
        {items.map((m, i) => (
          <li key={i} className="bad">
            {m}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- settings

/**
 * Which provider, model and key: the key for this session only, held in memory, never stored;
 * the rest kept in this browser. A connection is tested before it is relied on.
 */
function AssistantSettings() {
  const saved = useAssistant((s) => s.settings);
  const [confirm, setConfirm] = useState(() => useAssistant.getState().confirmLookups);
  const [inService, setInService] = useState(() => !!saved && heldByService(saved));
  const [saving, setSaving] = useState(false);
  const reasonerUrl = useStore((s) => s.validation.reasonerUrl);
  const a = useAssistant.getState;
  const [form, setForm] = useState<ProviderSettings>(() => saved ?? { provider: 'anthropic', model: '', transport: 'direct' });
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const settingsNow = { ...form, ...(form.transport === 'proxy' ? { proxyUrl: form.proxyUrl || reasonerUrl } : {}) };
  const keyed = hasKey(settingsNow);
  const held = keyed && heldByService(settingsNow);
  const problem = form.provider === 'custom' ? endpointProblem(form.baseUrl) : undefined;
  const meta = PROVIDERS.find((p) => p.id === form.provider)!;
  const complete = !!form.model.trim() && !problem && (keyed || !!key.trim());
  const settings = useMemo<ProviderSettings>(() => ({ ...form, ...(form.transport === 'proxy' ? { proxyUrl: form.proxyUrl || reasonerUrl } : {}) }), [form, reasonerUrl]);
  const close = () => a().setShowSettings(false);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      if (key.trim()) holdKey(key, settings);
      const r = await adapterFor(settings).test({ timeoutMs: 20_000 });
      setResult({ ok: true, text: r.detail });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
      // A key tried here replaces the one held: the panel says whether its settings still have one.
      a().refreshKeyed();
    }
  };
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} tabIndex={-1} className="dialog assistant-settings" role="dialog" aria-modal="true" aria-labelledby="assistant-settings-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="assistant-settings-title">Assistant settings</h2>
        <label className="field">
          <span>Provider</span>
          <select aria-label="Provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as ProviderSettings['provider'] })}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {form.provider === 'custom' && (
          <label className="field">
            <span>Base URL</span>
            <input aria-label="Base URL" value={form.baseUrl ?? ''} placeholder="https://example.org/v1" spellCheck={false} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            {form.baseUrl && problem && <small className="bad">{problem}</small>}
          </label>
        )}
        <label className="field">
          <span>Model</span>
          <input aria-label="Model" value={form.model} placeholder={meta.placeholder} spellCheck={false} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </label>
        <label className="field">
          <span>API key</span>
          <input aria-label="API key" type="password" autoComplete="off" spellCheck={false} value={key} placeholder={held ? 'The local service holds a key: type to replace it' : keyed ? 'A key is held for this session: type to replace it' : 'Your own key, for this session only'} onChange={(e) => setKey(e.target.value)} />
          <small className="muted">Kept in this page’s memory only: not saved, not in any file or export, gone when the page is closed. It is sent to {form.provider === 'custom' ? 'the endpoint above' : meta.label} and nowhere else; change the endpoint and it is asked for again.</small>
        </label>
        <fieldset className="route">
          <legend>Requests go</legend>
          <label className="check">
            <input type="radio" name="transport" checked={form.transport === 'direct'} onChange={() => setForm({ ...form, transport: 'direct' })} />
            <span>straight from this browser to the provider</span>
          </label>
          <label className="check">
            <input type="radio" name="transport" checked={form.transport === 'proxy'} onChange={() => setForm({ ...form, transport: 'proxy' })} />
            <span>through the local service (pnpm reasoner), which sets the key on each request and refuses endpoints on this machine or a private network</span>
          </label>
          {form.transport === 'proxy' && <input aria-label="Address of the local service" value={form.proxyUrl ?? reasonerUrl} spellCheck={false} onChange={(e) => setForm({ ...form, proxyUrl: e.target.value })} />}
          {form.transport === 'proxy' && (
            <label className="check">
              <input type="checkbox" checked={inService} onChange={(e) => setInService(e.target.checked)} />
              <span>Let the local service hold the key, in its memory, until it stops: this tab keeps only a handle to it, so a reload does not ask for the key again</span>
            </label>
          )}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>Show me each lookup, and send it only if I say so</span>
        </label>
        <p className="muted">The assistant sends what you ask and the parts of the open ontology it looks up (names, IRIs, axioms, annotations) to the provider you choose, under that provider’s terms. It never changes the ontology without your approval.</p>
        {result && (
          <p className={result.ok ? 'good' : 'bad'} role="status">
            {result.text}
          </p>
        )}
        <div className="dialog-actions">
          {saved && (
            <button
              className="btn ghost"
              onClick={() => {
                a().removeConfiguration();
                setKey('');
                setResult(null);
                setForm({ provider: 'anthropic', model: '', transport: 'direct' });
              }}
            >
              Remove configuration
            </button>
          )}
          <span className="spacer" />
          <button className="btn" disabled={!complete || testing} onClick={() => void test()}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn" onClick={close}>
            Close
          </button>
          <button
            className="btn primary"
            disabled={!complete || saving}
            onClick={async () => {
              if (key.trim() && settings.transport === 'proxy' && inService) {
                setSaving(true);
                try {
                  // The key goes to the service, and only the handle it answers with stays here.
                  await holdKeyInService(key, settings);
                  a().configure(settings);
                } catch (e) {
                  setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
                  return;
                } finally {
                  setSaving(false);
                }
              } else a().configure(settings, key.trim() ? key : undefined);
              a().setConfirmLookups(confirm);
              a().refreshKeyed();
              setKey('');
              close();
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
