import { useMemo, useState } from 'react';
import { parseOutline, parseRelations, parseTerms } from '../model/bulk';
import { useStore } from '../model/store';

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
