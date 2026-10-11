import { useMemo, useState } from 'react';
import { runChecks, type Issue } from '../model/checks';
import { parseOutline, parseRelations, parseTerms } from '../model/bulk';
import { reason } from '../model/reasoner';
import { useStore } from '../model/store';
import type { Model, Term } from '../model/types';
import { resolveModel } from '../model/vocab';

// -------------------------------------------------------------- hierarchy

function buildTree(model: Model) {
  const m = resolveModel(model);
  const byId = new Map(m.terms.map((t) => [t.id, t]));
  const children = new Map<string, Term[]>();
  const props = new Map<string, Term[]>();
  const hasParent = new Set<string>();
  for (const r of m.relations) {
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    if (!a || !b || a === b) continue;
    if (r.kind === 'generalization') {
      children.set(b.id, [...(children.get(b.id) ?? []), a]);
      hasParent.add(a.id);
    } else if (r.kind === 'property') {
      props.set(a.id, [...(props.get(a.id) ?? []), b]);
      if (b.type === 'property') hasParent.add(b.id);
    }
  }
  const byName = (a: Term, b: Term) => a.name.localeCompare(b.name);
  for (const list of children.values()) list.sort(byName);
  const roots = m.terms.filter((t) => !hasParent.has(t.id)).sort((a, b) => (children.has(b.id) ? 1 : 0) - (children.has(a.id) ? 1 : 0) || byName(a, b));
  return { children, props, roots };
}

export function HierarchyView() {
  const model = useStore((s) => s.model);
  const focusTerm = useStore((s) => s.focusTerm);
  const { children, props, roots } = useMemo(() => buildTree(model), [model]);
  // A big hierarchy opens folded to its top two levels; unfolding everything is one click away.
  const [closed, setClosed] = useState<Set<string>>(() => {
    if (model.terms.length < 400) return new Set();
    const open = new Set(roots.map((t) => t.id));
    return new Set([...children.keys()].filter((id) => !open.has(id)));
  });
  const skos = model.mode === 'skos';
  // Where a new term is being typed in: under a term, or at the top level (null).
  const [adding, setAdding] = useState<{ parent: string | null } | null>(null);
  const [draft, setDraft] = useState('');
  const startAdding = (parent: string | null) => {
    if (parent) setClosed((prev) => new Set([...prev].filter((id) => id !== parent)));
    setDraft('');
    setAdding({ parent });
  };
  const entry = (parent: string | null) => (
    <li className="tree-add" key="add">
      <input
        autoFocus
        value={draft}
        aria-label={parent ? 'Name of the narrower term' : 'Name of the top-level term'}
        placeholder={skos ? (parent ? 'Narrower concept, Enter to add' : 'Top concept, Enter to add') : 'New term, Enter to add'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => !draft.trim() && setAdding(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') setAdding(null);
          if (e.key !== 'Enter') return;
          // Stays open so a whole list of siblings can be typed one after another.
          if (draft.trim()) useStore.getState().addNarrower(parent, draft.trim());
          setDraft('');
        }}
      />
      <span className="muted">Enter adds, Esc closes</span>
    </li>
  );

  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const node = (t: Term, path: string[]) => {
    const kids = path.includes(t.id) ? [] : (children.get(t.id) ?? []);
    const open = !closed.has(t.id);
    return (
      <li key={t.id}>
        <div className="tree-row">
          {kids.length ? (
            <button className="twisty" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} onClick={() => toggle(t.id)}>
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span className="twisty" />
          )}
          <button className="tree-name" onClick={() => focusTerm(t.id)} title="Show on the canvas">
            <span className={'dot ' + t.type} style={{ background: `var(--nc-${t.color || 'default'}-fill)`, borderColor: `var(--nc-${t.color || 'default'}-stroke)` }} />
            {t.name || 'Unnamed'}
          </button>
          {t.type !== 'concept' && <span className="tag">{t.type}</span>}
          {kids.length > 0 && <span className="count">{kids.length}</span>}
          {(props.get(t.id) ?? []).map((p) => (
            <span key={p.id} className="tag prop">
              {p.name}
            </span>
          ))}
          {path.includes(t.id) && <span className="tag warn">cycle</span>}
          <button className="btn small ghost add" title={skos ? 'Add a narrower concept' : 'Add a term under this one'} onClick={() => startAdding(t.id)}>
            + {skos ? 'narrower' : 'add under'}
          </button>
        </div>
        {open && (kids.length > 0 || adding?.parent === t.id) && (
          <ul>
            {kids.map((k) => node(k, [...path, t.id]))}
            {adding?.parent === t.id && !path.includes(t.id) && entry(t.id)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="view">
      <div className="view-head">
        <p className="muted">
          {skos
            ? 'The broader / narrower hierarchy. Hover a concept and press “+ narrower” to type concepts straight into the tree.'
            : 'Built from the “is a” relations. Properties are shown next to the term that owns them.'}
        </p>
        <div className="row">
          <button className="btn small primary" onClick={() => startAdding(null)}>
            {skos ? 'Add top concept' : 'Add top-level term'}
          </button>
          <button className="btn small" onClick={() => setClosed(new Set())}>
            Expand all
          </button>
          <button className="btn small" onClick={() => setClosed(new Set(children.keys()))}>
            Collapse all
          </button>
        </div>
      </div>
      <div className="tree-wrap">
        <ul className="tree">
          {roots.map((t) => node(t, []))}
          {adding && adding.parent === null && entry(null)}
        </ul>
        {!roots.length && !adding && <p className="muted pad">No terms yet.</p>}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- checks

export function ChecksView() {
  const model = useStore((s) => s.model);
  // Results follow the model as it changes; the button runs everything again from scratch.
  const [run, setRun] = useState({ n: 0, at: new Date(), ms: 0 });
  // The button below has already refreshed the reasoner's cached result by the time this runs again.
  const [issues, reasoning] = useMemo(() => [runChecks(model), reason(model)] as const, [model, run.n]);
  // Thousands of results are possible on a large model; they are shown a batch at a time.
  const [shown, setShown] = useState({ inferences: 200, issues: 300 });
  const st = useStore.getState;
  const rerun = () => {
    const t0 = performance.now();
    reason(model, true);
    runChecks(model);
    setRun((r) => ({ n: r.n + 1, at: new Date(), ms: Math.max(1, Math.round(performance.now() - t0)) }));
    st().notify(`Checks re-run: ${st().model.terms.length} terms, ${st().model.relations.length} relations.`);
  };
  const count = (s: Issue['severity']) => issues.filter((i) => i.severity === s).length;
  const contradictions = reasoning.conflicts.filter((c) => c.severity === 'error').length;

  const show = (terms: string[], rels: string[]) => {
    if (terms.length) st().focusTerm(terms[0]);
    else if (rels.length) st().focusRelation(rels[0]);
    st().select(terms, rels);
  };

  return (
    <div className="view">
      <div className="view-head">
        <span className="muted" aria-live="polite">
          {run.n ? `Last run at ${run.at.toLocaleTimeString()} (${run.ms} ms).` : 'Results update as you edit the model.'}
        </span>
        <button className="btn primary" onClick={rerun}>
          Run checks again
        </button>
      </div>
      <div className="issues">
        <section aria-labelledby="reasoner-title">
          <div className="section-head">
            <h3 id="reasoner-title">Reasoner</h3>
            <span className={'sev ' + (reasoning.consistent ? 'ok' : 'error')}>
              {reasoning.consistent ? '✓ Consistent' : `✗ Inconsistent: ${contradictions} ${contradictions === 1 ? 'contradiction' : 'contradictions'}`}
            </span>
            <span className="muted">
              {reasoning.asserted} stated facts · {reasoning.inferred} inferred
            </span>
          </div>
          {model.mode === 'skos' && (
            <p className="muted note">
              This is a SKOS concept scheme, so the reasoner follows the broader hierarchy only; the SKOS integrity conditions are checked under Model checks
              below. To reason about classes, equivalence and disjointness, convert the model to an ontology in the{' '}
              <button className="link" onClick={() => st().setView('vocab')}>
                Vocabulary
              </button>{' '}
              view.
            </p>
          )}
          {model.mode !== 'skos' && !model.vocab.enabled && (
            <p className="muted note">
              RDFS &amp; OWL properties are off, so the reasoner only works with “is a” and “has property”. Turn them on in the{' '}
              <button className="link" onClick={() => st().setView('vocab')}>
                Vocabulary
              </button>{' '}
              view to reason about equivalence, disjointness and identity as well.
            </p>
          )}
          {reasoning.truncated && <p className="muted note">The model is too large to reason over completely; these results are partial.</p>}
          {reasoning.conflicts.map((c, n) => (
            <button key={n} className="issue" onClick={() => show(c.terms, c.rels)} title="Show on the canvas">
              <span className={'sev ' + c.severity}>{c.severity}</span>
              <span className="issue-rule">{c.rule}</span>
              <span className="issue-msg">
                {c.message}
                <span className="why">Because {c.because}</span>
              </span>
            </button>
          ))}
          {reasoning.inferences.slice(0, shown.inferences).map((i) => (
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
          {reasoning.inferences.length > shown.inferences && (
            <p className="pager">
              Showing {shown.inferences} of {reasoning.inferences.length} inferred facts.
              <button className="btn small" onClick={() => setShown({ ...shown, inferences: shown.inferences + 500 })}>
                Show 500 more
              </button>
              <button className="btn small" onClick={() => setShown({ ...shown, inferences: reasoning.inferences.length })}>
                Show all
              </button>
            </p>
          )}
          {!reasoning.conflicts.length && !reasoning.inferences.length && <p className="muted note">Nothing new follows from the model yet.</p>}
        </section>

        <section aria-labelledby="checks-title">
          <div className="section-head">
            <h3 id="checks-title">Model checks</h3>
            <span className="sev error">{count('error')} errors</span>
            <span className="sev warning">{count('warning')} warnings</span>
            <span className="sev info">{count('info')} suggestions</span>
          </div>
          {!issues.length && <p className="muted note">No problems found. The model passes every check.</p>}
          {issues.slice(0, shown.issues).map((i, n) => (
            <button key={n} className="issue" onClick={() => show(i.terms, i.rels)} title="Show on the canvas">
              <span className={'sev ' + i.severity}>{i.severity === 'info' ? 'suggestion' : i.severity}</span>
              <span className="issue-rule">{i.rule}</span>
              <span className="issue-msg">{i.message}</span>
            </button>
          ))}
          {issues.length > shown.issues && (
            <p className="pager">
              Showing {shown.issues} of {issues.length} results.
              <button className="btn small" onClick={() => setShown({ ...shown, issues: shown.issues + 500 })}>
                Show 500 more
              </button>
              <button className="btn small" onClick={() => setShown({ ...shown, issues: issues.length })}>
                Show all
              </button>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ bulk dialog

const TERMS_EXAMPLE = `Customer | concept | Someone who buys from us | Client, Buyer
Order | concept | A request to purchase goods
Order date | property | The day the order was placed
Acme Ltd | instance`;

const OUTLINE_EXAMPLE = `Vehicles
  Cars
    Electric cars
    Sports cars
  Bicycles
    Racing bikes
People
  Drivers`;

const RELATIONS_EXAMPLE = `Customer -> places -> Order
Premium customer -> is a -> Customer
Order -> has property -> Order date
Acme Ltd -> is a -> Customer`;

/** Remembered while the app is open. */
let lastBulkTab: 'terms' | 'relations' | 'outline' = 'terms';

export function BulkDialog() {
  const model = useStore((s) => s.model);
  const [tab, setTabState] = useState(lastBulkTab);
  const [termsText, setTermsText] = useState('');
  const [relsText, setRelsText] = useState('');
  const [outlineText, setOutlineText] = useState('');
  const outline = useMemo(() => parseOutline(outlineText), [outlineText]);
  const [createMissing, setCreateMissing] = useState(true);
  const st = useStore.getState;
  const close = () => st().setDialog(null);
  const setTab = (t: typeof tab) => setTabState((lastBulkTab = t));

  const names = useMemo(() => new Set(model.terms.map((t) => t.name.trim().toLowerCase())), [model.terms]);
  const terms = useMemo(() => parseTerms(termsText), [termsText]);
  const rels = useMemo(() => parseRelations(relsText), [relsText]);
  const known = terms.items.filter((t) => names.has(t.name.toLowerCase())).length;
  const unknown = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of rels.items) for (const n of [r.from, r.to]) if (!names.has(n.toLowerCase())) out.set(n.toLowerCase(), n);
    return [...out.values()];
  }, [rels, names]);
  const usable = createMissing ? rels.items.length : rels.items.filter((r) => names.has(r.from.toLowerCase()) && names.has(r.to.toLowerCase())).length;

  const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const addTerms = () => {
    const r = st().bulkAddTerms(terms.items);
    if (!r.added && !r.updated) return st().notify('Nothing new: these terms already exist with the same details.');
    st().notify(`Added ${plural(r.added, 'term')}${r.updated ? `, updated ${r.updated}` : ''}.`);
    // Stay open and move on to the second step.
    setTermsText('');
    setTab('relations');
    st().setView('graph');
  };
  const addRelations = () => {
    const r = st().bulkAddRelations(rels.items, createMissing);
    if (!r.added) return st().notify(r.skipped ? 'Nothing added: every line was already there or names a term that does not exist.' : 'Nothing to add.');
    st().notify(`Added ${plural(r.added, 'relationship')}${r.created ? ` and ${plural(r.created, 'new term')}` : ''}${r.skipped ? `; skipped ${r.skipped}` : ''}.`);
    st().setView('graph');
    close();
  };
  const addOutline = () => {
    const r = st().bulkAddOutline(outline);
    if (!r.terms && !r.rels) return st().notify('Nothing new: this hierarchy is already in the model.');
    st().notify(`Added ${plural(r.terms, 'term')} and ${plural(r.rels, model.mode === 'skos' ? 'broader link' : '“is a” link')}.`);
    st().setView('graph');
    close();
  };
  const notes = tab === 'terms' ? terms.notes : tab === 'outline' ? outline.notes : rels.notes;
  const outlineNew = outline.terms.filter((n) => !names.has(n.toLowerCase())).length;

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="bulk-title">Bulk add</h2>
        <div className="tabs" role="tablist" aria-label="What to add">
          <button role="tab" aria-selected={tab === 'terms'} className={tab === 'terms' ? 'on' : ''} onClick={() => setTab('terms')}>
            1. Terms
          </button>
          <button role="tab" aria-selected={tab === 'relations'} className={tab === 'relations' ? 'on' : ''} onClick={() => setTab('relations')}>
            2. Relationships
          </button>
          <button role="tab" aria-selected={tab === 'outline'} className={tab === 'outline' ? 'on' : ''} onClick={() => setTab('outline')}>
            Hierarchy outline
          </button>
        </div>

        {tab === 'outline' ? (
          <>
            <p className="muted">
              A whole hierarchy at once: one term per line, indented under the term it belongs to (two spaces or a tab per level). Each indented term becomes{' '}
              {model.mode === 'skos' ? 'narrower than' : 'a kind of'} the one above it. Terms already in the model are reused, so you can extend an existing branch.
            </p>
            <textarea
              autoFocus
              rows={11}
              value={outlineText}
              placeholder={OUTLINE_EXAMPLE}
              aria-label="Hierarchy outline"
              spellCheck={false}
              onChange={(e) => setOutlineText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Tab') return;
                e.preventDefault();
                const el = e.currentTarget;
                // Tab indents the current line, Shift+Tab outdents it.
                const start = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
                if (e.shiftKey) {
                  if (el.value.startsWith('  ', start)) el.setRangeText('', start, start + 2, 'end');
                } else el.setRangeText('  ', start, start, 'end');
                setOutlineText(el.value);
              }}
            />
            <p className="bulk-preview" role="status">
              {outline.terms.length
                ? `${plural(outline.terms.length, 'term')} (${outlineNew} new) in ${plural(outline.rels.length, 'hierarchy link')}.`
                : 'Nothing to add yet.'}
            </p>
          </>
        ) : tab === 'terms' ? (
          <>
            <p className="muted">
              One term per line: <code>Name | Type | Description | Synonyms</code>. Only the name is needed; the type is concept, property or instance. Rows
              pasted from a spreadsheet work too. Start with a header row (<code>Name | Type | Owner | …</code>) to choose the columns yourself; columns it
              doesn’t know become extra fields. A term that already exists is updated, not duplicated.
            </p>
            <textarea autoFocus rows={11} value={termsText} placeholder={TERMS_EXAMPLE} aria-label="Terms" spellCheck={false} onChange={(e) => setTermsText(e.target.value)} />
            <p className="bulk-preview" role="status">
              {terms.items.length ? `${plural(terms.items.length - known, 'new term')}${known ? `, ${known} already in the model (details will be updated)` : ''}.` : 'Nothing to add yet.'}
            </p>
          </>
        ) : (
          <>
            <p className="muted">
              One relationship per line: <code>From -&gt; label -&gt; To</code>, or three columns <code>From | label | To</code>. The labels <code>is a</code> and{' '}
              <code>has property</code> are understood. Terms are matched by name.
            </p>
            <textarea autoFocus rows={11} value={relsText} placeholder={RELATIONS_EXAMPLE} aria-label="Relationships" spellCheck={false} onChange={(e) => setRelsText(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
              <span>Create terms that don’t exist yet</span>
            </label>
            <p className="bulk-preview" role="status">
              {rels.items.length
                ? `${plural(usable, 'relationship')} to add.` +
                  (unknown.length
                    ? ` ${plural(unknown.length, 'name')} not in the model (${unknown.slice(0, 4).join(', ')}${unknown.length > 4 ? ', …' : ''}): ${
                        createMissing ? 'will be created as concepts' : 'those lines will be skipped'
                      }.`
                    : '')
                : 'Nothing to add yet.'}
            </p>
          </>
        )}
        {notes.length > 0 && (
          <ul className="bulk-notes">
            {notes.slice(0, 5).map((n) => (
              <li key={n}>{n}</li>
            ))}
            {notes.length > 5 && <li>…and {notes.length - 5} more.</li>}
          </ul>
        )}

        <div className="dialog-actions">
          <button className="btn ghost" onClick={() => (tab === 'terms' ? setTermsText(TERMS_EXAMPLE) : tab === 'outline' ? setOutlineText(OUTLINE_EXAMPLE) : setRelsText(RELATIONS_EXAMPLE))}>
            Insert example
          </button>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
          {tab === 'outline' ? (
            <button className="btn primary" disabled={!outline.terms.length} onClick={addOutline}>
              Add hierarchy
            </button>
          ) : tab === 'terms' ? (
            <button className="btn primary" disabled={!terms.items.length} onClick={addTerms}>
              Add terms
            </button>
          ) : (
            <button className="btn primary" disabled={!usable} onClick={addRelations}>
              Add relationships
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
