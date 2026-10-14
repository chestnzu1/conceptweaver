import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { configOf } from '../model/modelTypes';
import { compactIri } from '../model/prefixes';
import { useStore } from '../model/store';
import { StructureError, type AxiomStanding, type Basis, type ClassAxiom, type ClassComparison, type ClassRef, type ClassSummary, type Iri, type SubclassExplanation } from '../structure/contracts';
import { IriCell } from './Iri';
import type { StructureHost } from './Structure';
import { noAnswer, plural, reasonerName } from './StructureSummary';

/** How something is known, in a word or two, as it is said beside it. */
const HOW: Record<Basis, string> = { asserted: 'stated', 'asserted-chain': 'through stated links', entailed: 'entailed' };

/**
 * Two classes side by side: how they stand to each other, which restrictions each asserts and
 * which it inherits, and from where. Whatever is said to hold says how it is known; where a
 * reasoner was not to be had, that is said too, and nothing is concluded in its place.
 */
export function StructureCompare({ host }: { host: StructureHost }) {
  const { service, ontology } = host;
  const config = useStore((s) => configOf(s.model));
  const { a, b } = useStore((s) => s.structure.compare);
  const focus = useStore((s) => s.structure.focus);
  const st = useStore.getState;
  const one = config.termType.concept.label.toLowerCase();
  const skos = config.id === 'skos';
  const set = (next: { a: Iri | null; b: Iri | null }) => st().setStructure({ compare: next });
  const reasoningKey = host.reasoning?.key ?? '';

  const [result, setResult] = useState<{ of: string; comparison: ClassComparison } | null>(null);
  const [error, setError] = useState<string>();
  const of = a && b ? `${ontology.revisionId}\n${a}\n${b}\n${reasoningKey}` : '';
  useEffect(() => {
    if (!a || !b) return setResult(null);
    const abort = new AbortController();
    void (async () => {
      try {
        const comparison = await service.compare({ ...ontology, classAIri: a, classBIri: b }, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setError(undefined);
        setResult({ of, comparison });
      } catch (e) {
        if (abort.signal.aborted || (e instanceof StructureError && (e.code === 'stale-revision' || e.code === 'aborted'))) return;
        // One of the two is not in the ontology any more: its place is empty again.
        if (e instanceof StructureError && e.code === 'not-found') return set({ a: host.look(a) ? a : null, b: host.look(b) ? b : null });
        setError(e instanceof Error ? e.message : 'The two could not be compared.');
      }
    })();
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [of, service, ontology]);
  // A class that was deleted, or given another IRI, leaves its place.
  useEffect(() => {
    if ((a && !host.look(a)) || (b && !host.look(b))) set({ a: a && host.look(a) ? a : null, b: b && host.look(b) ? b : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, host]);

  // With one class chosen, the classes directly above it are the first ones to set it against.
  const alone = a && !b ? a : b && !a ? b : null;
  const [near, setNear] = useState<{ of: Iri; summary: ClassSummary } | null>(null);
  useEffect(() => {
    if (!alone) return;
    let live = true;
    service
      .summary({ ...ontology, classIri: alone, mode: 'asserted' })
      .then((summary) => live && setNear({ of: alone, summary }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [alone, service, ontology]);
  const above = near && near.of === alone ? [...near.summary.asserted.superclasses, ...(near.summary.inferred.superclasses ?? []).map((x) => x.class).filter((c) => !c.builtin && !near.summary.asserted.superclasses.some((s) => s.iri === c.iri))] : [];

  const c = result && result.of === of ? result.comparison : null;
  return (
    <div className="st-compare">
      <div className="st-pair">
        <Slot host={host} label={`${config.termType.concept.label} A`} iri={a} other={b} focus={focus} one={one} onPick={(iri) => set({ a: iri, b })} />
        <button className="btn small" disabled={!a && !b} title="Put each in the other’s place" onClick={() => set({ a: b, b: a })}>
          Swap
        </button>
        <Slot host={host} label={`${config.termType.concept.label} B`} iri={b} other={a} focus={focus} one={one} onPick={(iri) => set({ a, b: iri })} />
      </div>

      {error && (
        <p className="bad pad" role="alert">
          {error}
        </p>
      )}
      {(!a || !b) && (
        <div className="st-compare-empty">
          <p className="muted">
            Choose two {plural(one)} to set side by side: how they stand to each other, what is asserted of each, what each inherits and from which {config.hierarchy.parent}. Nothing here changes the {skos ? 'vocabulary' : 'ontology'}.
          </p>
          {alone && above.length > 0 && (
            <p>
              Set it against one of its {plural(config.hierarchy.parent)}:{' '}
              {above.map((x) => (
                <button key={x.iri} className="btn small" title={x.iri} onClick={() => set(a ? { a, b: x.iri } : { a: x.iri, b })}>
                  {x.label}
                </button>
              ))}
            </p>
          )}
        </div>
      )}
      {c && a && b && <Comparison host={host} c={c} skos={skos} parent={config.hierarchy.parent} one={one} />}
    </div>
  );
}

/** One of the two places: the class in it, or a search for one to put there. */
function Slot({ host, label, iri, other, focus, one, onPick }: { host: StructureHost; label: string; iri: Iri | null; other: Iri | null; focus: Iri | null; one: string; onPick: (iri: Iri | null) => void }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ text: string; matches: ClassRef[]; total: number } | null>(null);
  const text = query.trim();
  // Asked a moment after the typing stops: each search is a question to the service.
  useEffect(() => {
    if (!text) return setFound(null);
    let live = true;
    const id = setTimeout(() => {
      host.service
        .search({ ...host.ontology, text, limit: 8 })
        .then((r) => live && setFound({ text, matches: r.matches, total: r.total }))
        .catch(() => undefined);
    }, 140);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [text, host.service, host.ontology]);
  const seen = iri ? host.look(iri) : null;
  const inFocus = focus && focus !== other ? host.look(focus) : null;
  // Each candidate with its IRI, written with a prefix where there is one, so that two of the same name can be told apart.
  const short = (found: Iri) => {
    const real = host.look(found)?.iri;
    return real ? (compactIri(useStore.getState().model, real) ?? real) : '';
  };
  const pick = (next: Iri) => {
    setQuery('');
    onPick(next);
  };
  return (
    <div className="st-slot" role="group" aria-label={label}>
      <span className="st-slot-label">{label}</span>
      {iri && seen ? (
        <div className="st-chosen">
          <span className="dot concept" style={{ background: `var(--nc-${seen.color}-fill)`, borderColor: `var(--nc-${seen.color}-stroke)` }} />
          <strong className="name">{seen.label}</strong>
          <button className="btn small ghost" aria-label={`Choose another ${one} for ${label}`} onClick={() => onPick(null)}>
            Change
          </button>
          <IriCell iri={seen.iri} of={seen.label} />
        </div>
      ) : (
        <div className="st-search">
          <input type="search" role="combobox" aria-expanded={!!text} aria-autocomplete="list" value={query} placeholder="Search by name, label or IRI" aria-label={`Search for ${label}`} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && found?.matches[0] && found.text === text && pick(found.matches[0].iri)} />
          {text && found && found.text === text && (
            <ul className="subgraph-found" role="listbox">
              {found.matches
                .filter((m) => m.iri !== other)
                .map((m) => (
                  <li key={m.iri} role="option" aria-selected="false">
                    <button title={m.iri} onClick={() => pick(m.iri)}>
                      {m.label} <span className="muted">{short(m.iri)}</span>
                    </button>
                  </li>
                ))}
              {!found.matches.length && <li className="muted">No {one} matches.</li>}
              {found.total > found.matches.length && <li className="muted">{found.total - found.matches.length} more: type more of the name.</li>}
            </ul>
          )}
          {!text && inFocus && focus && (
            <button className="btn small" title={`The ${one} in focus in Explore`} onClick={() => pick(focus)}>
              Use {inFocus.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Comparison({ host, c, skos, parent, one }: { host: StructureHost; c: ClassComparison; skos: boolean; parent: string; one: string }) {
  const st = useStore.getState;
  const [why, setWhy] = useState<Record<string, SubclassExplanation | 'asking'>>({});
  const key = (sub: Iri, sup: Iri) => `${sub}\n${sup}`;
  // An explanation is asked for when someone wants to see it, and not before.
  const explain = (sub: Iri, sup: Iri) => {
    const k = key(sub, sup);
    if (why[k]) return setWhy(({ [k]: _, ...rest }) => rest);
    setWhy((w) => ({ ...w, [k]: 'asking' }));
    host.service
      .explain({ ...host.ontology, subClassIri: sub, superClassIri: sup })
      .then((e) => setWhy((w) => (w[k] ? { ...w, [k]: e } : w)))
      .catch(() => setWhy(({ [k]: _, ...rest }) => rest));
  };
  const who = reasonerName(c.reasoning);
  const current = c.reasoning.status === 'current';
  const entity = (iri: Iri | undefined, label: string) =>
    iri ? (
      <button className="link" title={`${iri}\nOpen it in the side panel`} onClick={() => host.openEntity(iri)}>
        {label}
      </button>
    ) : (
      label
    );
  const cls = (x: ClassRef) => entity(x.iri, x.label);
  const how = (basis: Basis) => (basis === 'entailed' ? `entailed, according to ${who}` : HOW[basis]);
  const whyButton = (sub: ClassRef, sup: ClassRef) => (
    <button className="link st-why-ask" aria-expanded={!!why[key(sub.iri, sup.iri)]} onClick={() => explain(sub.iri, sup.iri)}>
      {why[key(sub.iri, sup.iri)] ? 'Hide the explanation' : 'View semantic explanation'}
    </button>
  );
  const explanation = (sub: ClassRef, sup: ClassRef) => {
    const e = why[key(sub.iri, sup.iri)];
    if (!e) return null;
    if (e === 'asking') return <p className="muted st-why">Asking…</p>;
    return (
      <div className="st-why" role="status">
        {e.available ? (
          <>
            <p>
              {e.basis === 'entailed' ? `What ${reasonerName(e.provenance)} gives as its grounds for it:` : `It follows from ${e.statements.length === 1 ? 'this stated axiom' : `these ${e.statements.length} stated axioms`}:`}
            </p>
            <ol>
              {e.statements.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ol>
          </>
        ) : (
          <p>No justification is available. {e.reason}</p>
        )}
      </div>
    );
  };

  const r = c.relationship;
  const verb = skos ? 'is narrower than' : 'SubClassOf';
  const [lower, upper] = r.kind === 'b-below-a' ? [c.b, c.a] : [c.a, c.b];
  const textOf = (k: string) => c.axioms.find((x) => x.axiom.key === k)?.axiom.text ?? '';
  const standing = (s: AxiomStanding): ReactNode =>
    s.state === 'own' ? (
      <span className="st-own">Own</span>
    ) : s.state === 'inherited' ? (
      <>
        <span className="st-inherited">Inherited</span>
        <small>
          from{' '}
          {(s.from ?? []).map((f, i) => (
            <Fragment key={f.class.iri}>
              {i > 0 && ', '}
              {cls(f.class)}
              {f.basis !== 'asserted' && <span className={'tag' + (f.basis === 'entailed' ? ' inferred' : '')}>{f.basis === 'entailed' ? 'entailed' : 'further up'}</span>}
            </Fragment>
          ))}
        </small>
      </>
    ) : (
      <span className="muted" aria-label="Not asserted and not inherited">
        —
      </span>
    );
  const axiomText = (x: ClassAxiom) =>
    x.kind === 'restriction' ? (
      <>
        {entity(x.property.iri.startsWith('urn:') ? undefined : x.property.iri, x.property.label)} <em>{x.quantifier}{x.n !== undefined ? ' ' + x.n : ''}</em> {x.filler.kind === 'class' ? entity(x.filler.iri, x.filler.label) : <code>{x.filler.label}</code>}
      </>
    ) : (
      <>
        <code>{x.text}</code> <span className="tag auto" title={`A class expression the class is asserted to be ${x.relation === 'subClassOf' ? 'a subclass of' : x.relation === 'equivalentClass' ? 'equivalent to' : 'disjoint with'}. It is compared as it is written, and not interpreted.`}>{x.relation === 'subClassOf' ? 'expression' : x.relation === 'equivalentClass' ? 'equivalent to' : 'disjoint with'}</span>
      </>
    );
  return (
    <div className="st-compared">
      <section className="st-relation" aria-label="How the two stand to each other">
        <h3>Relationship</h3>
        <p className="st-headline">
          {r.kind === 'same' ? (
            <>The same {one} is in both places.</>
          ) : r.kind === 'equivalent' ? (
            <>
              <strong>{c.a.label}</strong> <code>{skos ? 'is as broad as' : 'EquivalentTo'}</code> <strong>{c.b.label}</strong>
            </>
          ) : r.kind === 'a-below-b' || r.kind === 'b-below-a' ? (
            <>
              <strong>{lower.label}</strong> <code>{verb}</code> <strong>{upper.label}</strong>
            </>
          ) : (
            <>Neither is {skos ? 'narrower than' : 'a subclass of'} the other{current ? `, as far as ${who} finds` : ', as far as is stated'}.</>
          )}
        </p>
        <p className="muted">
          {r.kind === 'equivalent' && (r.basis === 'asserted' ? 'Stated outright.' : r.basis === 'asserted-chain' ? `Each is stated, through its ${plural(parent)}, to be under the other, which makes them equivalent.` : `Entailed, according to ${who}. It is not stated.`)}
          {(r.kind === 'a-below-b' || r.kind === 'b-below-a') &&
            (r.basis === 'asserted' ? 'Stated outright.' : r.basis === 'asserted-chain' ? `Not stated outright: it follows through stated links, ${(r.chain ?? []).map((x) => x.label).join(' › ')}.` : `Entailed, according to ${who}. No stated links lead from the one to the other.`)}
          {r.kind === 'siblings' && (
            <>
              Both are directly under {r.shared.map((x, i) => (
                <Fragment key={x.iri}>
                  {i > 0 && ', '}
                  {cls(x)}
                </Fragment>
              ))}
              .
            </>
          )}
          {r.kind === 'unrelated' &&
            (r.shared.length ? (
              <>
                The nearest {plural(one)} above both: {r.shared.map((x, i) => (
                  <Fragment key={x.iri}>
                    {i > 0 && ', '}
                    {cls(x)}
                  </Fragment>
                ))}
                .
              </>
            ) : (
              `They have no ${parent} in common.`
            ))}{' '}
          {(r.kind === 'a-below-b' || r.kind === 'b-below-a') && whyButton(lower, upper)}
          {r.kind === 'equivalent' && r.basis !== 'asserted' && whyButton(c.a, c.b)}
        </p>
        {(r.kind === 'a-below-b' || r.kind === 'b-below-a') && explanation(lower, upper)}
        {r.kind === 'equivalent' && explanation(c.a, c.b)}
        {c.disjointness && (
          <p className="st-disjoint">
            <strong>Disjoint.</strong>{' '}
            {c.disjointness.basis === 'asserted' ? (
              'The two are stated to share no instance.'
            ) : (
              <>
                They can share no instance: {cls(c.disjointness.between.a)} and {cls(c.disjointness.between.b)} are stated to be disjoint
                {c.disjointness.aBasis && `, ${c.a.label} is under ${c.disjointness.between.a.label} (${how(c.disjointness.aBasis)})`}
                {c.disjointness.bBasis && `, ${c.b.label} is under ${c.disjointness.between.b.label} (${how(c.disjointness.bBasis)})`}.
              </>
            )}
            {(r.kind === 'a-below-b' || r.kind === 'b-below-a') && ` Being under a ${one} it is disjoint with, ${lower.label} can never have an instance.`}
            {r.kind === 'equivalent' && ` Being equivalent as well, neither can have an instance.`}
          </p>
        )}
        {c.unsatisfiable && (c.unsatisfiable.a || c.unsatisfiable.b) && (
          <p className="st-disjoint">
            <strong>Unsatisfiable.</strong> {[c.unsatisfiable.a && c.a.label, c.unsatisfiable.b && c.b.label].filter(Boolean).join(' and ')} can never have an instance, according to {who}.
          </p>
        )}
        {!skos && (
          <p className={'st-checked' + (current ? '' : ' unverified')} role="status">
            {current ? (
              <>
                What is marked <span className="tag inferred">entailed</span> is from {who}
                {c.reasoning.completeness === 'incomplete' ? ', whose answer may be incomplete: there may be more than it finds' : ', whose answer is complete'}.
              </>
            ) : (
              <>
                <span className="tag warn">unverified</span> Only what is stated was read. {noAnswer(c.reasoning)} More may hold between the two than is said here.{' '}
                {host.reasoning?.asked && (
                  <button className="btn small" disabled={host.reasoning.running} onClick={host.runReasoning}>
                    {host.reasoning.running ? 'Reasoning…' : 'Run reasoning'}
                  </button>
                )}
              </>
            )}
          </p>
        )}
      </section>

      {!skos && (
        <section aria-label="Restrictions and class expressions">
          <h3>Restrictions</h3>
          {c.axioms.length ? (
            <>
              <p className="st-counts">
                <span>
                  <strong>{c.counts.shared}</strong> in both
                </span>
                <span>
                  <strong>{c.counts.onlyA}</strong> only in {c.a.label}
                </span>
                <span>
                  <strong>{c.counts.onlyB}</strong> only in {c.b.label}
                </span>
                <span>
                  {c.a.label}: <strong>{c.counts.ownA}</strong> own, <strong>{c.counts.inheritedA}</strong> inherited
                </span>
                <span>
                  {c.b.label}: <strong>{c.counts.ownB}</strong> own, <strong>{c.counts.inheritedB}</strong> inherited
                </span>
              </p>
              <div className="st-table">
                <table>
                  <thead>
                    <tr>
                      <th title="What a class requires of its members: a restriction on a property, or a class expression. A property that merely has the class as its domain is not listed: that says what has the property, not what the class requires.">Restriction</th>
                      <th style={{ width: '27%' }}>{c.a.label}</th>
                      <th style={{ width: '27%' }}>{c.b.label}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.axioms.map((x) => (
                      <tr key={x.axiom.key} className={x.a.state !== 'absent' && x.b.state !== 'absent' ? 'both' : 'one'}>
                        <td>
                          <div className="st-axiom">{axiomText(x.axiom)}</div>
                          {x.relations.map((rel) => (
                            <div key={rel.than} className="st-rel">
                              <span className="tag">{rel.kind === 'equivalent' ? 'says the same as' : 'stronger than'}</span> “{textOf(rel.than)}”
                              {rel.evidence.length > 0 ? (
                                <>
                                  , because{' '}
                                  {rel.evidence.map((e, i) => (
                                    <Fragment key={e.sub.iri + e.sup.iri}>
                                      {i > 0 && ' and '}
                                      {cls(e.sub)} is under {cls(e.sup)} ({how(e.basis)}) {whyButton(e.sub, e.sup)}
                                      {explanation(e.sub, e.sup)}
                                    </Fragment>
                                  ))}
                                </>
                              ) : (
                                ': the same property and filler, and the numbers allow it.'
                              )}
                            </div>
                          ))}
                          {x.unverified.map((k) => (
                            <div key={k} className="st-rel unverified">
                              <span className="tag warn">unverified</span> Whether it is stronger than “{textOf(k)}” was not checked: that depends on how their fillers stand to each other, and no reasoner’s answer is to be had.
                            </div>
                          ))}
                        </td>
                        <td>{standing(x.a)}</td>
                        <td>{standing(x.b)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="muted">Neither has a restriction or a class expression, of its own or inherited.</p>
          )}
        </section>
      )}

      <section aria-label={`The ${plural(parent)} of the two`}>
        <h3>{plural(parent)[0].toUpperCase() + plural(parent).slice(1)}</h3>
        {c.superclasses.length ? (
          <div className="st-table">
            <table>
              <thead>
                <tr>
                  <th>{parent[0].toUpperCase() + parent.slice(1)}</th>
                  <th style={{ width: '27%' }}>{c.a.label}</th>
                  <th style={{ width: '27%' }}>{c.b.label}</th>
                </tr>
              </thead>
              <tbody>
                {c.superclasses.map((s) => (
                  <tr key={s.class.iri} className={s.a !== 'absent' && s.b !== 'absent' ? 'both' : 'one'}>
                    <td>{cls(s.class)}</td>
                    {[s.a, s.b].map((x, i) => (
                      <td key={i}>
                        {x === 'absent' ? (
                          <span className="muted" aria-label={`Not a ${parent}`}>
                            —
                          </span>
                        ) : x === 'self' ? (
                          <span className="muted">is this {one}</span>
                        ) : x === 'asserted' ? (
                          'Stated'
                        ) : x === 'asserted-chain' ? (
                          'Through stated links'
                        ) : (
                          <span className="tag inferred">entailed</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Neither has a {parent}.</p>
        )}
      </section>

      {(['equivalents', 'disjoints'] as const).some((k) => c.stated.a[k].length || c.stated.b[k].length) && (
        <section aria-label="Stated equivalence and disjointness">
          <h3>Stated to be equivalent or disjoint</h3>
          <dl className="st-facts">
            {(['a', 'b'] as const).map((which) => (
              <Fragment key={which}>
                <dt>{c[which].label}</dt>
                <dd>
                  {(['equivalents', 'disjoints'] as const)
                    .filter((k) => c.stated[which][k].length)
                    .map((k) => (
                      <div key={k}>
                        {k === 'equivalents' ? 'Equivalent to' : 'Disjoint with'}{' '}
                        {c.stated[which][k].map((x, i) => (
                          <Fragment key={x.iri}>
                            {i > 0 && ', '}
                            {cls(x)}
                          </Fragment>
                        ))}
                      </div>
                    ))}
                  {!c.stated[which].equivalents.length && !c.stated[which].disjoints.length && <span className="muted">nothing stated</span>}
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
      )}

      {c.notes.length > 0 && (
        <section aria-label="What was not compared">
          <h3>Not compared</h3>
          <ul className="st-notes">
            {c.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="st-compare-actions row wrap">
        <button className="btn small" onClick={() => host.openInEntities(c.a.iri)}>
          Open {c.a.label} in Entities
        </button>
        {c.b.iri !== c.a.iri && (
          <button className="btn small" onClick={() => host.openInEntities(c.b.iri)}>
            Open {c.b.label} in Entities
          </button>
        )}
        {c.b.iri !== c.a.iri && (
          <button className="btn small" title="Show the two on the canvas, with the shortest way between them" onClick={() => host.viewPairInGraph(c.a.iri, c.b.iri)}>
            View in Graph
          </button>
        )}
        <button className="btn small" title="Look through the hierarchy with the first of the two in focus" onClick={() => st().setStructure({ mode: 'explore', focus: c.a.iri })}>
          Show {c.a.label} in Explore
        </button>
      </div>
    </div>
  );
}
