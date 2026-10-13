import { useEffect, useRef, useState, type ReactNode } from 'react';
import { configOf } from '../model/modelTypes';
import { useStore } from '../model/store';
import { StructureError, type AnalysisBucket, type AnalysisFinding, type ClassSetItem, type ClassSetPage, type HierarchyMode, type Iri, type StructureAnalysis, type StructureMetric } from '../structure/contracts';
import type { StructureHost } from './Structure';
import { noAnswer, plural, reasonerName } from './StructureSummary';

const number = (n: number) => n.toLocaleString('en', { maximumFractionDigits: 2 });
const range = (b: AnalysisBucket) => (b.to === null ? `${b.from} or more` : b.to === b.from ? String(b.from) : `${b.from}–${b.to}`);
/** How many classes the canvas is asked to draw at once, when a set of them is shown there. */
const IN_GRAPH = 250;

/** A set of classes that was picked to be listed: what it is called, and what to say of each class in it. */
interface Picked {
  set: string;
  title: string;
  say: (item: ClassSetItem) => ReactNode;
}

/**
 * The hierarchy as a whole in numbers: how large, how deep and how wide it is, how its classes
 * are spread over levels and branches, and what about its shape is worth a look. Every number,
 * bar and finding leads to the classes behind it. Nothing here is an editor, and nothing that
 * is merely unusual is called an error.
 */
export function StructureAnalyze({ host, mode }: { host: StructureHost; mode: HierarchyMode }) {
  const { service, ontology } = host;
  const config = useStore((s) => configOf(s.model));
  const st = useStore.getState;
  const one = config.termType.concept.label.toLowerCase();
  const many = config.termType.concept.plural.toLowerCase();
  const parent = config.hierarchy.parent;
  const [parents, children] = [plural(parent), plural(config.hierarchy.child)];
  const root = config.hierarchy.root;
  const skos = config.id === 'skos';
  const reasoningKey = host.reasoning?.key ?? '';

  const [analysis, setAnalysis] = useState<{ of: string; result: StructureAnalysis } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string>();
  const [again, setAgain] = useState(0);
  const running = useRef<AbortController | null>(null);
  const of = `${ontology.ontologyId}\n${ontology.revisionId}\n${mode}\n${reasoningKey}`;
  // Measured when the view is opened and again whenever the ontology, the hierarchy asked for or the reasoner's answer changes.
  // What was measured before stays on show meanwhile.
  useEffect(() => {
    const abort = new AbortController();
    running.current = abort;
    setStopped(false);
    setProgress(0);
    void (async () => {
      try {
        const result = await service.analyze({ ...ontology, mode }, { signal: abort.signal, onProgress: (f) => !abort.signal.aborted && setProgress(f) });
        if (abort.signal.aborted) return;
        setError(undefined);
        setAnalysis({ of, result });
        setProgress(null);
      } catch (e) {
        if (running.current === abort) setProgress(null);
        if (e instanceof StructureError && (e.code === 'aborted' || e.code === 'stale-revision')) return;
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'The hierarchy could not be measured.');
      }
    })();
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [of, again, service]);
  const stop = () => {
    running.current?.abort();
    setProgress(null);
    setStopped(true);
  };

  // The classes behind whatever was picked, fetched a page at a time.
  const [picked, setPicked] = useState<Picked | null>(null);
  const [members, setMembers] = useState<{ of: string; set: string; items: ClassSetItem[]; total: number; next?: string } | null>(null);
  const load = (set: string, cursor?: string) =>
    service
      .members({ ...ontology, mode, set, ...(cursor ? { cursor } : {}) })
      .then((page: ClassSetPage) => setMembers((had) => ({ of, set, items: cursor && had?.set === set && had.of === of ? [...had.items, ...page.items] : page.items, total: page.total, ...(page.nextCursor ? { next: page.nextCursor } : {}) })))
      .catch(() => setMembers({ of, set, items: [], total: 0 }));
  useEffect(() => {
    if (picked && analysis?.of === of) void load(picked.set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.set, analysis?.of === of ? of : '']);
  const pick = (set: string | undefined, title: string, say: Picked['say'] = () => null) => set && setPicked({ set, title, say });
  const show = (iri: Iri) => st().setStructure({ mode: 'explore', focus: iri });

  const a = analysis?.result;
  const stale = !!analysis && analysis.of !== of;
  const inferred = mode === 'inferred';
  const none = a && inferred && a.provenance.status !== 'current' ? a.provenance : null;
  const listed = members && picked && members.set === picked.set && members.of === of ? members : null;
  const names = (items: { label: string }[]) => items.map((x) => x.label).join(', ');

  const tiles: { id: StructureMetric; label: string; note: string; say?: Picked['say'] }[] = [
    { id: 'classes', label: config.termType.concept.plural, note: 'named' },
    { id: 'top', label: 'At the top', note: `directly under ${root}` },
    { id: 'leaves', label: 'Leaves', note: `with no ${config.hierarchy.child}`, say: (x) => `level ${x.value}` },
    { id: 'maxDepth', label: 'Deepest level', note: `${root} is level 0` },
    { id: 'averageDepth', label: 'Average depth', note: `the mean of each ${one}’s deepest level` },
    { id: 'multipleInheritance', label: 'Multiple inheritance', note: `more than one direct ${parent}`, say: (x) => `${x.value} ${parents}: ${names(x.related ?? [])}` },
    { id: 'noStatedSuperclass', label: `No stated ${parent}`, note: inferred ? 'whatever the reasoner adds' : 'none is asserted' },
    ...(skos
      ? []
      : ([
          { id: 'equivalenceGroups', label: 'Equivalent groups', note: inferred ? 'entailed to be equivalent' : 'stated to be equivalent', say: (x) => `equivalent to ${names(x.related ?? [])}` },
          { id: 'unsatisfiable', label: 'Unsatisfiable', note: a && a.reasoning.status === 'current' ? `according to ${reasonerName(a.reasoning)}` : 'not known' },
        ] satisfies { id: StructureMetric; label: string; note: string; say?: Picked['say'] }[])),
    { id: 'inCycles', label: 'In cycles', note: `each other’s ${parents}, as stated`, say: (x) => `with ${names(x.related ?? [])}` },
  ];

  const findingText = (f: AnalysisFinding): { title: string; about: string; say: Picked['say']; rules?: string[] } => {
    const n = number(f.count);
    switch (f.kind) {
      case 'unsatisfiable':
        return { title: `${n} unsatisfiable ${f.count === 1 ? one : many}`, about: `Can never have an instance, according to ${a ? reasonerName(a.reasoning) : 'the reasoner'}. This one is a finding of the reasoner, and usually a mistake.`, say: () => 'can have no instance', rules: ['owl-unsatisfiable', 'owl-restrictions'] };
      case 'cycle':
        return { title: `${n} subclass ${f.count === 1 ? 'cycle' : 'cycles'}`, about: `${many[0].toUpperCase() + many.slice(1)} that are stated, one after another, to be each other’s ${parents}. OWL reads them as equivalent, which is seldom what was meant.`, say: (x) => `with ${names(x.related ?? [])}`, rules: ['subclass-cycle'] };
      case 'redundant-superclass':
        return { title: `${n} potentially redundant ${f.count === 1 ? `${parent} statement` : `${parent} statements`}`, about: `A ${parent} that is stated outright and is also reached through another stated ${parent}. Harmless, and sometimes deliberate.`, say: (x) => `${names(x.related ?? [])} is also reached through another ${parent}`, rules: ['redundant-subclass'] };
      case 'multiple-inheritance':
        return { title: `${n} ${f.count === 1 ? one : many} with several ${parents}`, about: 'A valid and common pattern. Listed so that it can be looked over, not because anything is wrong.', say: (x) => `${x.value} ${parents}: ${names(x.related ?? [])}`, rules: ['multiple-inheritance'] };
      case 'wide':
        return { title: `${n} ${f.count === 1 ? one : many} with unusually many direct ${children}`, about: `More than ${f.above}, which is far above what is usual among the ${many} of this ${skos ? 'vocabulary' : 'ontology'} that have any. A level may be missing in between.`, say: (x) => `${number(x.value ?? 0)} direct ${children}` };
      case 'deep':
        return { title: `${n} unusually deep ${f.count === 1 ? 'leaf' : 'leaves'}`, about: `Below level ${f.above}, well beyond how deep the leaves here usually are.`, say: (x) => `level ${x.value}` };
      default:
        return { title: `${n} highly connected ${f.count === 1 ? one : many}`, about: `At one end of more than ${f.above} statements: as a ${parent}, in a restriction, as the ${one} of individuals. Much depends on ${f.count === 1 ? 'it' : 'them'}.`, say: (x) => `${number(x.value ?? 0)} statements` };
    }
  };

  return (
    <div className="st-body st-analyze">
      <div className="st-dash" aria-busy={progress !== null}>
        {progress !== null && (
          <p className="st-progress" role="status">
            <progress value={progress} max={1} aria-label="How far the measuring has got" />
            <span>Measuring the hierarchy… {Math.round(progress * 100)}%</span>
            <button className="btn small" onClick={stop}>
              Cancel
            </button>
          </p>
        )}
        {stopped && (
          <p className="st-progress" role="status">
            <span>The measuring was stopped{a ? ': what is shown is from before' : ''}.</span>
            <button className="btn small" onClick={() => setAgain((n) => n + 1)}>
              Measure again
            </button>
          </p>
        )}
        {error && (
          <p className="bad pad" role="alert">
            The hierarchy could not be measured: {error}
          </p>
        )}

        {a && inferred && (
          <p className={'st-prov-line ' + a.provenance.status} role="status">
            {a.provenance.status === 'current'
              ? `The inferred hierarchy, from ${reasonerName(a.provenance)}, whose answer ${a.provenance.completeness === 'complete' ? 'is complete' : 'may be incomplete'}, of the ontology as it is now.`
              : noAnswer(a.provenance)}
          </p>
        )}
        {none ? (
          <div className="st-none" role="status">
            <p>
              <strong>There is no inferred hierarchy to measure.</strong> {noAnswer(none)}
            </p>
            <div className="row wrap">
              {none.status !== 'inconsistent' && host.reasoning?.asked && (
                <button className="btn small primary" disabled={host.reasoning.running} onClick={host.runReasoning}>
                  {host.reasoning.running ? 'Reasoning…' : 'Run reasoning'}
                </button>
              )}
              {(none.status === 'inconsistent' || none.status === 'failed') && (
                <button className="btn small" onClick={() => host.openValidation()}>
                  Open Validation
                </button>
              )}
              <button className="btn small" onClick={() => st().setStructure({ hierarchy: 'asserted' })}>
                Measure the asserted hierarchy
              </button>
            </div>
          </div>
        ) : (
          a && (
            <div className={stale ? 'st-stale' : ''}>
              <section aria-label="The hierarchy in numbers">
                <ul className="st-tiles">
                  {tiles.map((t) => {
                    const value = a.metrics[t.id];
                    const set = a.sets[t.id];
                    const body = (
                      <>
                        <span className="st-tile-label">{t.label}</span>
                        <span className="st-tile-value">{value === null ? '—' : number(value)}</span>
                        <span className="st-tile-note">{value === null && t.id === 'unsatisfiable' ? `Not known. ${noAnswer(a.reasoning)}` : t.note}</span>
                      </>
                    );
                    return (
                      <li key={t.id} data-metric={t.id}>
                        {set && value ? (
                          <button className="st-tile" title={`List ${value === 1 ? 'it' : 'them'}`} aria-pressed={picked?.set === set} onClick={() => pick(set, t.label, t.say)}>
                            {body}
                          </button>
                        ) : (
                          <div className="st-tile">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="st-charts" aria-label="How the hierarchy is spread">
                <BarList
                  title="Depth"
                  caption={`How many ${many} have their deepest place on each level. ${root} is level 0.`}
                  picked={picked?.set}
                  rows={a.depth.map((b) => ({ key: b.set, label: `${b.to !== null && b.to !== b.from ? 'Levels' : 'Level'} ${range(b)}`, count: b.count, set: b.set }))}
                  unit={[one, many]}
                  onPick={(r) => pick(r.set, r.label, (x) => `level ${x.value}`)}
                />
                <BarList
                  title={`Direct ${children}`}
                  caption={`How many ${many} have so many ${children} directly below them.`}
                  picked={picked?.set}
                  rows={trimmed(a.subclasses).map((b) => ({ key: b.set, label: b.from === 0 ? 'None (leaves)' : range(b), count: b.count, set: b.set }))}
                  unit={[one, many]}
                  onPick={(r) => pick(r.set, `${r.label === 'None (leaves)' ? 'No' : r.label} direct ${children}`, (x) => (x.value ? `${number(x.value)} direct ${children}` : null))}
                />
                <BarList
                  title="Branches"
                  caption={`The ${many} at the top, by how many ${many} each has under it, itself included.`}
                  picked={picked?.set}
                  rows={[
                    ...a.branches.largest.map((b) => ({ key: b.set, label: b.class.label, count: b.classes, set: b.set, hint: `${number(b.classes)} ${b.classes === 1 ? one : many}, going ${b.depth} ${b.depth === 1 ? 'level' : 'levels'} down` })),
                    ...(a.branches.others ? [{ key: 'others', label: `${number(a.branches.others.branches)} other ${a.branches.others.branches === 1 ? 'branch' : 'branches'}`, count: a.branches.others.classes, set: a.sets.top }] : []),
                  ]}
                  unit={[one, many]}
                  onPick={(r) => pick(r.set, r.key === 'others' ? 'At the top' : `The branch of ${r.label}`, (x) => (x.value ? `level ${x.value}` : null))}
                />
                <BarList
                  title={`Direct ${parents}`}
                  caption={`How many ${many} have so many ${parents} directly above them. More than one is multiple inheritance, which is valid.`}
                  picked={picked?.set}
                  rows={trimmed(a.superclasses).map((b) => ({ key: b.set, label: b.from === 0 ? 'None (at the top)' : range(b), count: b.count, set: b.set }))}
                  unit={[one, many]}
                  onPick={(r) => pick(r.set, `${r.label === 'None (at the top)' ? 'No' : r.label} direct ${parents}`, (x) => (x.value ? `${x.value} direct ${parents}` : null))}
                />
              </section>

              <section aria-label="Structural findings">
                <h3>Structural findings</h3>
                <p className="muted">What about the shape of the hierarchy is worth a look. Apart from an unsatisfiable {one}, none of it is an error: these are patterns to review, and many are deliberate.</p>
                {a.findings.length ? (
                  <ul className="st-findings">
                    {a.findings.map((f) => {
                      const text = findingText(f);
                      return (
                        <li key={f.kind} data-finding={f.kind} className={f.kind === 'unsatisfiable' ? 'serious' : ''}>
                          <div>
                            <strong>{text.title}</strong>
                            <span className="muted">{text.about}</span>
                            <small>
                              {f.examples.map((x) => x.label).join(', ')}
                              {f.examples.length < f.count && f.kind !== 'cycle' && f.kind !== 'redundant-superclass' ? ', …' : ''}
                            </small>
                          </div>
                          <button className="btn small" aria-pressed={picked?.set === f.set} onClick={() => pick(f.set, text.title, text.say)}>
                            List
                          </button>
                          {text.rules && !skos && (
                            <button className="btn small" title="Open what Validation has to say of it" onClick={() => host.openValidationFor(text.rules!)}>
                              Open Validation
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>Nothing stands out.</p>
                )}
              </section>

              {a.deepest.length > 0 && (
                <section aria-label="The longest ways down">
                  <h3>Deepest chains</h3>
                  <ul className="st-ways">
                    {a.deepest.map((chain) => (
                      <li key={chain.map((c) => c.iri).join(' ')}>
                        <button title="Show its last class in Explore" onClick={() => show(chain[chain.length - 1].iri)}>
                          <span className="st-chain-length">{chain.length} levels</span>{' '}
                          {chain.map((c, i) => (
                            <span key={c.iri}>
                              {i > 0 && <span aria-hidden="true"> › </span>}
                              <span className={i === chain.length - 1 ? 'last' : ''}>{c.label}</span>
                            </span>
                          ))}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {a.warnings.length > 0 && (
                <ul className="st-notes">
                  {a.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )
        )}
      </div>

      <aside className="st-summary st-members" aria-label={`The ${many} behind a number`}>
        {!picked ? (
          <p className="st-focus muted">Choose a number, a bar or a finding to list the {many} behind it.</p>
        ) : (
          <>
            <div className="st-focus">
              <strong className="name">{picked.title}</strong>
              <span className="muted">{listed ? `${number(listed.total)} ${listed.total === 1 ? one : many}` : '…'}</span>
              <div className="row">
                <button className="btn small" disabled={!listed?.items.length} title={`Show them on the canvas as a subgraph${listed && listed.total > IN_GRAPH ? `: the first ${IN_GRAPH}` : ''}`} onClick={() => listed && host.viewManyInGraph([...new Set(listed.items.map((x) => x.class.iri))].slice(0, IN_GRAPH))}>
                  View in Graph
                </button>
                <button className="btn small ghost" onClick={() => setPicked(null)}>
                  Close
                </button>
              </div>
            </div>
            <ul className="st-member-list">
              {listed?.items.map((x, i) => (
                <li key={`${x.class.iri} ${i}`}>
                  <button title={`${x.class.iri}\nShow it in Explore`} onClick={() => show(x.class.iri)}>
                    <span className="name">{x.class.label}</span>
                    <small>{picked.say(x)}</small>
                  </button>
                </li>
              ))}
            </ul>
            {listed?.next && (
              <p className="st-more">
                <button className="btn small" onClick={() => void load(picked.set, listed.next)}>
                  Show more
                </button>
                <span className="muted">
                  {number(listed.items.length)} of {number(listed.total)}
                </span>
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

/** The ranges up to the last one that has anything in it: the empty ones beyond it say nothing. */
const trimmed = (buckets: AnalysisBucket[]) => buckets.slice(0, buckets.reduce((last, b, i) => (b.count ? i + 1 : last), 1));

interface BarRow {
  key: string;
  label: string;
  count: number;
  set?: string;
  hint?: string;
}

/**
 * Counts side by side as bars: one line for each, its name, a bar from a common baseline and the
 * number at its end. One series, so one colour and no legend; the number is written out on
 * every line, so nothing depends on the bar or on hovering. A line that has classes behind it
 * is a button that lists them.
 */
function BarList({ title, caption, rows, unit, picked, onPick }: { title: string; caption: string; rows: BarRow[]; unit: [string, string]; picked?: string; onPick: (row: BarRow) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <figure className="st-chart">
      <figcaption>
        <h3>{title}</h3>
        <p className="muted">{caption}</p>
      </figcaption>
      <ul className="st-bars">
        {rows.map((r) => {
          const said = `${r.label}: ${number(r.count)} ${r.count === 1 ? unit[0] : unit[1]}`;
          const line = (
            <>
              <span className="st-bar-label">{r.label}</span>
              <span className="st-bar-plot">
                {r.count > 0 && <span className="st-bar-fill" style={{ width: `calc((100% - 7ch) * ${r.count / max})` }} />}
                <span className="st-bar-value">{number(r.count)}</span>
              </span>
            </>
          );
          return (
            <li key={r.key}>
              {r.set && r.count ? (
                <button className="st-bar-row" aria-label={`${said}. List them`} aria-pressed={picked === r.set} title={r.hint ?? said} onClick={() => onPick(r)}>
                  {line}
                </button>
              ) : (
                <div className="st-bar-row" aria-label={said} title={r.hint ?? said}>
                  {line}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
