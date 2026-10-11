import { useMemo, useState } from 'react';
import { stable } from '../model/stable';
import { useStore } from '../model/store';
import { TERM_TYPES, type TermType } from '../model/types';

export function TermList() {
  // The list only shows names and colours, so it is left alone while terms are dragged around.
  const terms = stable(useStore((s) => s.model)).terms;
  const selected = useStore((s) => s.sel.terms);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const focusTerm = useStore((s) => s.focusTerm);
  const [type, setType] = useState<TermType | ''>('');

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return terms
      .filter((t) => (!type || t.type === type) && (!q || `${t.name}\n${t.description}\n${t.synonyms}`.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [terms, filter, type]);

  return (
    <aside className="panel term-list">
      <div className="search">
        <input type="search" value={filter} placeholder="Search terms" aria-label="Search terms" onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="chips" role="group" aria-label="Filter by type">
        <button className={'chip' + (type === '' ? ' on' : '')} onClick={() => setType('')}>
          All
        </button>
        {TERM_TYPES.map((t) => (
          <button key={t.value} className={'chip' + (type === t.value ? ' on' : '')} onClick={() => setType(t.value)}>
            {t.value === 'property' ? 'Properties' : t.label + 's'}
          </button>
        ))}
      </div>
      <div className="list-count">
        {shown.length === terms.length ? `${terms.length} terms` : `${shown.length} of ${terms.length} terms`}
      </div>
      <ul>
        {shown.map((t) => (
          <li key={t.id}>
            <button className={selected.includes(t.id) ? 'on' : ''} onClick={() => focusTerm(t.id)} title={t.description || undefined}>
              <span className={'dot ' + t.type} style={{ background: `var(--nc-${t.color || 'default'}-fill)`, borderColor: `var(--nc-${t.color || 'default'}-stroke)` }} />
              <span className="name">{t.name || 'Unnamed'}</span>
            </button>
          </li>
        ))}
      </ul>
      {!shown.length && <p className="muted pad">{terms.length ? 'No terms match.' : 'No terms yet.'}</p>}
    </aside>
  );
}
