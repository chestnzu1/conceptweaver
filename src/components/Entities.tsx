import { useMemo, useState, type ReactNode } from 'react';
import { inferredRestrictions } from '../model/inferred';
import { CHARACTERISTICS, dataDomain, fitsIn, hasCardinality, objectProperties, isInstanceOf, plainRelationships, propKey, propLinks, offeredChoices, relChoice, restrictionsOf, type RelChoice } from '../model/props';
import { useStore } from '../model/store';
import { iriCut, setIriSuffix } from '../model/iri';
import { configOf, type EntityColumn } from '../model/modelTypes';
import { type Model, type Term, type TermType } from '../model/types';
import { CommitInput, useLazyOptions } from './fields';
import { RangeSelect } from './Datatypes';
import { GovernanceView } from './Governance';
import { IriCell, SuperclassEditor } from './Iri';
import { TermChips } from './TermChips';

type Tab = 'concept' | 'object' | 'property' | 'instance' | 'relations' | 'governance';

/** Remembered while the app is open. */
let lastTab: Tab = 'concept';

/** Has the Entities view open on this section the next time it is shown: for coming to an entity from elsewhere. */
export const openEntityTab = (tab: Tab) => {
  lastTab = tab;
};

/** Rows shown at a time; a table of thousands of editable rows is slow to draw and no use to read. */
const PAGE = 150;

/** A class's inferred restrictions for the table: each with the class it comes from. */
function InferredCell({ model, id }: { model: Model; id: string }) {
  const inferred = useMemo(() => inferredRestrictions(model, id), [model, id]);
  if (inferred.status === 'inconsistent') return <span className="muted">ontology inconsistent</span>;
  return (
    <>
      {inferred.restrictions.map(({ key, restriction: r, sources }) => (
        <div key={key} title={sources.map((x) => x.because).join('\n')}>
          {r.property} <em>{r.quantifier}{r.n !== undefined ? ' ' + r.n : ''}</em> {r.filler} <span className="from">← {sources.map((x) => x.name).join(', ')}</span>
        </div>
      ))}
      {inferred.expressions.length > 0 && (
        <div className="muted" title={inferred.expressions.map((e) => e.text).join('\n')}>
          + {inferred.expressions.length} inherited expression{inferred.expressions.length === 1 ? '' : 's'}
        </div>
      )}
    </>
  );
}

/** A dropdown of every term that only builds its options when it is about to be used. */
function TermSelect({ value, current, onChange, label, sorted }: { value: string; current: string; onChange: (id: string) => void; label: string; sorted: Term[] }) {
  const { ready, lazy } = useLazyOptions();
  return (
    <select aria-label={label} value={value} {...lazy} onChange={(e) => onChange(e.target.value)}>
      {ready ? (
        sorted.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name || 'Unnamed'}
          </option>
        ))
      ) : (
        <option value={value}>{current}</option>
      )}
    </select>
  );
}

/**
 * Everything in the model by kind, the way an ontology editor lists it: classes, object
 * properties, data properties and individuals, each in its own tab. The side panel edits
 * whichever row is selected.
 */
export function EntitiesView() {
  const model = useStore((s) => s.model);
  const sel = useStore((s) => s.sel);
  const selProp = useStore((s) => s.selProp);
  const st = useStore.getState;
  const skos = model.mode === 'skos';
  const [tabState, setTabState] = useState<Tab>(lastTab);
  // The sections the type of model has; one it does not have is never the one shown.
  const config = configOf(model);
  const tab: Tab = config.entityTabs.includes(tabState) ? tabState : config.entityTabs[0];
  const [configuring, setConfiguring] = useState(false);
  const setTab = (t: Tab) => setTabState((lastTab = t));

  const props = useMemo(() => objectProperties(model), [model]);
  const plain = useMemo(() => new Set(skos ? [] : plainRelationships(model).flatMap((p) => p.rels.map((r) => r.id))), [model, skos]);
  const declared = useMemo(() => new Set(props.map((p) => p.key)), [props]);
  const name = useMemo(() => new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed'])), [model.terms]);
  const names = (ids: string[]) => ids.map((id) => name.get(id)).join(', ');
  const type = useMemo(() => new Map(model.terms.map((t) => [t.id, t.type])), [model.terms]);
  // Where there is one kind of term, every term is of it.
  const of = (type: TermType) => model.terms.filter((t) => config.termTypes.length < 2 || t.type === type);
  const sorted = useMemo(() => [...model.terms].sort((a, b) => a.name.localeCompare(b.name)), [model.terms]);
  // What each term is a kind of (or an instance of), and which terms have each data property.
  const { owners, degree } = useMemo(() => {
    const owners = new Map<string, string[]>();
    const degree = new Map<string, number>();
    for (const r of model.relations) {
      degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
      if (r.to !== r.from) degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
      if (r.kind === 'property') owners.set(r.to, [...(owners.get(r.to) ?? []), r.from]);
    }
    return { owners, degree };
  }, [model.relations]);

  const tabInfo: Record<Tab, { label: string; count: number }> = {
    concept: { label: config.termType.concept.plural, count: of('concept').length },
    object: { label: 'Object properties', count: props.length },
    property: { label: 'Data properties', count: of('property').length },
    instance: { label: 'Individuals', count: of('instance').length },
    relations: { label: 'Relationships', count: model.relations.length },
    governance: { label: 'Governance & Metadata', count: -1 },
  };
  const tabs = config.entityTabs.map((id) => ({ id, ...tabInfo[id] }));

  const addTerm = (type: TermType, label: string) => {
    const id = st().addTerm({ type, name: label });
    st().select([id]);
  };
  const add: Record<Tab, { label: string; run: () => void; disabled?: boolean }> = {
    concept: { label: `Add ${config.termType.concept.label.toLowerCase()}`, run: () => addTerm('concept', `New ${config.termType.concept.label.toLowerCase()}`) },
    object: { label: 'Add object property', run: () => st().addProp() },
    property: { label: 'Add data property', run: () => addTerm('property', 'New data property') },
    instance: { label: 'Add individual', run: () => addTerm('instance', 'New individual') },
    relations: {
      label: 'Add relationship',
      run: () => st().addRelation({ from: sorted[0].id, to: (sorted[1] ?? sorted[0]).id }),
      disabled: !model.terms.length,
    },
    governance: { label: configuring ? 'Back to the entities' : 'Configure fields', run: () => setConfiguring(!configuring) },
  };
  const hint: Record<Tab, string> = {
    concept: skos ? 'Every concept of the vocabulary, by its name and its IRI. Its labels, definition and ownership are under Governance & Metadata; what it is broader or narrower than is under Structure.' : 'The classes of the ontology, each with the restrictions its properties place on it. Click a row to edit it in the side panel.',
    object: 'Object properties link two terms. Each is declared once here and reused wherever its name is used. A domain or range marked “from use” follows where the property is used; choose a class in the cell to set it yourself.',
    property: 'Data properties hold a value such as a date or a number. Attach one to a class with a “has property” relation.',
    instance: 'Individuals are particular things. Give one a type by making it “is a” of a class.',
    relations: skos
      ? 'Every relationship between two concepts.'
      : 'Every line drawn between two terms. One that uses an object property is a restriction or a fact; the others are plain relationships until you make their label an object property.',
    governance: configuring
      ? 'The metadata field registry of this model.'
      : 'Who owns each entity, where it stands, and where its data lives. Select an entity to see the metadata that applies to its kind. Every value is an annotation on the entity, stored with a standard RDF property where one exists; none of it changes what a class means.',
  };

  const termSelect = (value: string, onChange: (id: string) => void, label: string) => <TermSelect value={value} onChange={onChange} label={label} sorted={sorted} current={name.get(value) ?? 'Unnamed'} />;
  const rowProps = (t: Term) => ({
    className: sel.terms.includes(t.id) ? 'sel' : '',
    onFocusCapture: () => !sel.terms.includes(t.id) && st().select([t.id]),
    onClick: () => !sel.terms.includes(t.id) && st().select([t.id]),
  });
  const actions = (t: Term) => (
    <td className="row-actions">
      <button className="btn small ghost" title="Show on the canvas" onClick={() => st().focusTerm(t.id)}>
        Show
      </button>
      <button className="btn icon ghost" title="Delete" aria-label={`Delete ${t.name}`} onClick={() => st().remove([t.id], [])}>
        ×
      </button>
    </td>
  );
  const text = (t: Term, field: 'name' | 'description' | 'synonyms', label: string) => (
    <CommitInput aria-label={label} value={t[field]} onCommit={(v) => st().updateTerm(t.id, { [field]: field === 'name' ? v.trim() : v })} />
  );
  // Every column the table of classes or concepts can have. Which of them it has is the type of model's to say.
  const columns: Record<EntityColumn, { head: string; width: string | number; title?: string; cls?: string; cell: (t: Term) => ReactNode }> = {
    name: { head: 'Name', width: '15%', cell: (t) => text(t, 'name', 'Name') },
    iri: { head: 'IRI', width: '19%', cls: 'ro', cell: (t) => <IriCell iri={t.iri} of={t.name} /> },
    suffix: {
      head: 'IRI suffix',
      width: '18%',
      title: 'The last part of the IRI. It is the entity’s identifier, apart from its name: renaming the entity does not change it.',
      cell: (t) => (
        <CommitInput
          aria-label="IRI suffix"
          disabled={t.external !== undefined}
          value={t.iri ? t.iri.slice(iriCut(t.iri)) : ''}
          placeholder="made from the name"
          onCommit={(v) => {
            const refused = st().edit((m) => setIriSuffix(m, { term: t.id }, v));
            if (refused) st().notify(refused);
          }}
        />
      ),
    },
    type: {
      head: 'Type',
      width: '18%',
      cls: 'ro',
      cell: (t) => (
        <>
          {config.termType[t.type].label} <code className="pred">{config.termType[t.type].rdf}</code>
        </>
      ),
    },
    hierarchy: { head: 'Asserted Superclasses', width: '17%', title: 'The superclasses explicitly stated for each class (rdfs:subClassOf). Superclasses that only follow from these are not listed.', cls: 'cell-edit', cell: (t) => <SuperclassEditor term={t} /> },
    restrictions: {
      head: 'Asserted Restrictions',
      width: '17%',
      title: 'Stated on the class itself: what its properties require of it',
      cls: 'ro restrictions-cell',
      cell: (t) => (
        <>
          {restrictionsOf(model, t.id).map((r) => (
            <div key={`${r.rel.id}:${r.index}`}>
              {r.property} <em>{r.quantifier}{r.n !== undefined ? ' ' + r.n : ''}</em> {r.filler}
            </div>
          ))}
          {t.axioms?.length ? (
            <div className="muted" title={t.axioms.join('\n')}>
              + {t.axioms.length} other asserted expression{t.axioms.length === 1 ? '' : 's'}
            </div>
          ) : null}
        </>
      ),
    },
    inferred: { head: 'Inferred Restrictions', width: '19%', title: 'Not stated on the class, but entailed by the reasoner: inherited from its superclasses and equivalent classes. Read-only.', cls: 'ro restrictions-cell inferred', cell: (t) => <InferredCell model={model} id={t.id} /> },
    description: { head: 'Description', width: '13%', cell: (t) => text(t, 'description', 'Description') },
    synonyms: { head: 'Synonyms', width: '9%', cell: (t) => text(t, 'synonyms', 'Synonyms') },
    relations: { head: 'Relations', width: 80, cls: 'num', cell: (t) => degree.get(t.id) ?? 0 },
  };
  // The search box on the left narrows every table; long tables are shown a page at a time.
  const filter = useStore((s) => s.filter);
  const q = filter.trim().toLowerCase();
  const [limits, setLimits] = useState<Record<string, number>>({});
  const limit = limits[tab + '|' + q] ?? PAGE;
  const all = {
    terms: of(tab === 'object' || tab === 'relations' || tab === 'governance' ? 'concept' : tab).filter((t) => !q || `${t.name}\n${t.description}\n${t.synonyms}`.toLowerCase().includes(q)),
    props: props.filter((p) => !q || p.name.toLowerCase().includes(q)),
    relations: model.relations.filter((r) => !q || `${r.label}\n${name.get(r.from)}\n${name.get(r.to)}`.toLowerCase().includes(q)),
  };
  const total = tab === 'object' ? all.props.length : tab === 'relations' ? all.relations.length : all.terms.length;
  const list = all.terms.slice(0, limit);
  const shownProps = all.props.slice(0, limit);
  const shownRelations = all.relations.slice(0, limit);

  return (
    <div className="view">
      <div className="view-head">
        <div className="tabs" role="tablist" aria-label="Kind of entity">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}{t.count >= 0 ? ` (${t.count})` : ''}
            </button>
          ))}
        </div>
      </div>
      {/* What the tab is for, with its one action beside it: there the action fits however narrow the view is. */}
      <div className="view-sub">
        <p className="muted">
          {hint[tab]}
          {q && tab !== 'governance' && <strong> Filtered by “{filter.trim()}”: {total} shown.</strong>}
        </p>
        <button className="btn primary" disabled={add[tab].disabled} onClick={add[tab].run}>
          {add[tab].label}
        </button>
      </div>
      {tab === 'governance' && <GovernanceView configuring={configuring} />}
      <div className="table-wrap" hidden={tab === 'governance'}>
        {tab === 'concept' && (
          <table className={config.entityColumns.length > 5 ? 'wide' : ''}>
            <thead>
              <tr>
                {config.entityColumns.map((c) => (
                  <th key={c} style={{ width: columns[c].width }} className={c === 'relations' ? 'num' : undefined} title={columns[c].title}>
                    {columns[c].head}
                  </th>
                ))}
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} {...rowProps(t)}>
                  {config.entityColumns.map((c) => (
                    <td key={c} className={columns[c].cls}>
                      {columns[c].cell(t)}
                    </td>
                  ))}
                  {actions(t)}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'object' && (
          <table>
            <thead>
              <tr>
                <th style={{ width: '14%' }}>Name</th>
                <th style={{ width: '17%' }}>IRI</th>
                <th>Domain</th>
                <th>Range</th>
                <th style={{ width: '17%' }}>Characteristics</th>
                <th style={{ width: '13%' }}>Inverse of</th>
                <th style={{ width: 60 }} className="num">
                  Uses
                </th>
                <th style={{ width: 50 }} />
              </tr>
            </thead>
            <tbody>
              {shownProps.map((p) => (
                <tr
                  key={p.key}
                  className={selProp === p.key ? 'sel' : ''}
                  onFocusCapture={() => selProp !== p.key && st().selectProp(p.key)}
                  onClick={() => selProp !== p.key && st().selectProp(p.key)}
                >
                  <td>
                    <CommitInput aria-label="Property name" value={p.name} onCommit={(v) => st().renameProp(p.key, v)} />
                  </td>
                  <td className="ro">
                    <IriCell iri={p.iri} of={p.name} />
                  </td>
                  {(['domain', 'range'] as const).map((side) => {
                    const ids = p[side];
                    const auto = side === 'domain' ? p.domainAuto : p.rangeAuto;
                    // Uses between classes that a hand-set domain or range does not cover.
                    const outside = auto
                      ? 0
                      : p.rels.filter((r) => type.get(r.from) === 'concept' && type.get(r.to) === 'concept' && ids.length > 0 && !fitsIn(model, side === 'domain' ? r.from : r.to, ids)).length;
                    return (
                      <td key={side} className="cell-edit">
                        <TermChips
                          ids={ids}
                          placeholder={`Add a class to the ${side}`}
                          of={p.name}
                          empty="anything"
                          add={(id) => st().updateProp(p.key, { [side]: [...ids, id] })}
                          remove={(id) => st().updateProp(p.key, { [side]: ids.filter((x) => x !== id) })}
                        />
                        {auto && ids.length > 0 && <span className="tag auto">from use</span>}
                        {!auto && (
                          <button className="link reset" title="Let it follow where the property is used again" onClick={() => st().updateProp(p.key, { [side]: undefined })}>
                            reset
                          </button>
                        )}
                        {outside > 0 && (
                          <span className="bad" title="Open the property to see which">
                            ✗ {outside} use{outside === 1 ? '' : 's'} outside
                          </span>
                        )}
                        {!auto && ids.length > 0 && p.rels.length > 0 && outside === 0 && <span className="good">✓ uses fit</span>}
                      </td>
                    );
                  })}
                  <td className="ro">{CHARACTERISTICS.filter((c) => p.chars.includes(c.id)).map((c) => c.label).join(', ') || '—'}</td>
                  <td className="ro">{propLinks(model, p.key, 'inverses').map((k) => props.find((x) => x.key === k)?.name ?? k).join(', ') || '—'}</td>
                  <td className="num">{p.rels.length}</td>
                  <td className="row-actions">
                    <button className="btn icon ghost" title="Delete the property and the relationships that use it" aria-label={`Delete ${p.name}`} onClick={() => st().deleteProp(p.key)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'property' && (
          <table>
            <thead>
              <tr>
                <th style={{ width: '16%' }}>Name</th>
                <th style={{ width: '18%' }}>IRI</th>
                <th style={{ width: '18%' }}>Domain</th>
                <th style={{ width: '16%' }}>Attached to</th>
                <th style={{ width: 220 }}>Range (datatype)</th>
                <th style={{ width: 90 }} title="Each thing has at most one value (owl:FunctionalProperty)">
                  Functional
                </th>
                <th>Description</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} {...rowProps(t)}>
                  <td>{text(t, 'name', 'Name')}</td>
                  <td className="ro">
                    <IriCell iri={t.iri} of={t.name} />
                  </td>
                  <td className="cell-edit">
                    {(() => {
                      const d = dataDomain(model, t);
                      return (
                        <>
                          <TermChips
                            ids={d.ids}
                            placeholder="Add a class to the domain"
                            of={t.name}
                            empty="not set"
                            add={(id) => st().updateTerm(t.id, { domain: [...d.ids, id] })}
                            remove={(id) => st().updateTerm(t.id, { domain: d.ids.filter((x) => x !== id) })}
                          />
                          {d.auto ? (
                            d.ids.length > 0 && <span className="tag auto">from use</span>
                          ) : (
                            <button className="link reset" title="Let it follow the classes it is attached to again" onClick={() => st().updateTerm(t.id, { domain: undefined })}>
                              reset
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </td>
                  <td className="ro">{names(owners.get(t.id) ?? []) || '—'}</td>
                  <td>
                    <RangeSelect term={t} />
                  </td>
                  <td className="num">
                    <input type="checkbox" aria-label={`${t.name} is functional`} checked={!!t.functional} onChange={(e) => st().updateTerm(t.id, { functional: e.target.checked || undefined })} />
                  </td>
                  <td>{text(t, 'description', 'Description')}</td>
                  {actions(t)}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'instance' && (
          <table>
            <thead>
              <tr>
                <th style={{ width: '18%' }}>Name</th>
                <th style={{ width: '22%' }}>IRI</th>
                <th style={{ width: '18%' }}>Type</th>
                <th>Description</th>
                <th style={{ width: 80 }} className="num">
                  Relations
                </th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} {...rowProps(t)}>
                  <td>{text(t, 'name', 'Name')}</td>
                  <td className="ro">
                    <IriCell iri={t.iri} of={t.name} />
                  </td>
                  <td className="cell-edit">
                    <SuperclassEditor term={t} />
                  </td>
                  <td>{text(t, 'description', 'Description')}</td>
                  <td className="num">{degree.get(t.id) ?? 0}</td>
                  {actions(t)}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'relations' && (
          <table>
            <thead>
              <tr>
                <th style={{ width: '20%' }}>From</th>
                <th style={{ width: '18%' }}>{skos ? 'Label' : 'Property / label'}</th>
                <th style={{ width: '20%' }}>To</th>
                <th style={{ width: 230 }}>Kind</th>
                {!skos && <th style={{ width: 190 }}>Meaning</th>}
                <th style={{ width: 90 }}>From card.</th>
                <th style={{ width: 90 }}>To card.</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {shownRelations.map((r) => (
                <tr
                  key={r.id}
                  className={sel.rels.includes(r.id) ? 'sel' : ''}
                  onFocusCapture={() => !sel.rels.includes(r.id) && st().select([], [r.id])}
                  onClick={() => !sel.rels.includes(r.id) && st().select([], [r.id])}
                >
                  <td>{termSelect(r.from, (from) => st().updateRelation(r.id, { from }), 'From')}</td>
                  <td>
                    <CommitInput aria-label="Label" list={skos ? undefined : 'object-props'} value={r.label} onCommit={(v) => st().updateRelation(r.id, { label: v.trim() })} />
                  </td>
                  <td>{termSelect(r.to, (to) => st().updateRelation(r.id, { to }), 'To')}</td>
                  <td>
                    <select aria-label="Kind" value={relChoice(model, r)} onChange={(e) => st().setRelChoice(r.id, e.target.value as RelChoice)}>
                      {offeredChoices(model, r).map((k) => (
                        <option key={k.value} value={k.value} disabled={!!k.disabled} title={k.disabled}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  {!skos && (
                    <td className="ro">
                      {r.kind !== 'association' || r.predicate ? (
                        <span className="muted">{isInstanceOf(model, r) ? 'class membership (rdf:type)' : (r.predicate ?? (r.kind === 'generalization' ? 'hierarchy' : 'data property'))}</span>
                      ) : declared.has(propKey(r.label)) && !plain.has(r.id) ? (
                        <button className="link" title="Open the object property" onClick={() => st().selectProp(propKey(r.label))}>
                          object property
                        </button>
                      ) : plain.has(r.id) ? (
                        <button
                          className="btn small"
                          title={declared.has(propKey(r.label)) ? 'Make this relationship a use of the object property with this name' : 'Declare this label as an object property; every relationship carrying it becomes a use of it'}
                          onClick={() => (declared.has(propKey(r.label)) ? st().setRelChoice(r.id, 'object') : st().declareProp(r.label))}
                        >
                          Make object property
                        </button>
                      ) : null}
                    </td>
                  )}
                  {/* Only a plain relationship has cardinalities; the other kinds say "how many" with restrictions, or not at all. */}
                  {hasCardinality(model, r) ? (
                    <>
                      <td>
                        <CommitInput aria-label="From cardinality" value={r.fromCard} onCommit={(v) => st().updateRelation(r.id, { fromCard: v.trim() })} />
                      </td>
                      <td>
                        <CommitInput aria-label="To cardinality" value={r.toCard} onCommit={(v) => st().updateRelation(r.id, { toCard: v.trim() })} />
                      </td>
                    </>
                  ) : (
                    <td colSpan={2} className="ro muted" title="Cardinalities are for plain relationships">
                      —
                    </td>
                  )}
                  <td className="row-actions">
                    <button className="btn small ghost" title="Show on the canvas" onClick={() => st().focusRelation(r.id)}>
                      Show
                    </button>
                    <button className="btn icon ghost" title="Delete relationship" aria-label="Delete relationship" onClick={() => st().remove([], [r.id])}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {total === 0 && tab !== 'governance' && <p className="muted pad">{q ? `Nothing matches “${filter.trim()}”.` : 'Nothing here yet.'}</p>}
        {total > limit && (
          <p className="pager">
            Showing {limit} of {total}.
            <button className="btn small" onClick={() => setLimits({ ...limits, [tab + '|' + q]: limit + PAGE * 2 })}>
              Show {Math.min(PAGE * 2, total - limit)} more
            </button>
            <button className="btn small" onClick={() => setLimits({ ...limits, [tab + '|' + q]: total })}>
              Show all
            </button>
            <span className="muted">Use the search box on the left to narrow the list.</span>
          </p>
        )}
      </div>
      <datalist id="object-props">
        {props.map((p) => (
          <option key={p.key} value={p.name} />
        ))}
      </datalist>
    </div>
  );
}
