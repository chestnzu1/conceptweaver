import { Fragment, type ReactNode } from 'react';
import type { ModelTypeConfig } from '../model/modelTypes';
import type { ClassRef, ClassSummary, HierarchyMode, Iri, PathResult, Provenance } from '../structure/contracts';
import { IriCell } from './Iri';
import type { StructureHost } from './Structure';

/** "superclass" to "superclasses", "broader concept" to "broader concepts". */
export const plural = (noun: string) => noun + (noun.endsWith('s') ? 'es' : 's');

/** The reasoner an answer is from, as it is named beside the answer. */
export const reasonerName = (p: Provenance) => (p.engine ? `${p.engine.name}${p.engine.version ? ' ' + p.engine.version : ''}` : 'no reasoner');

/** Why a reasoner has no answer to show, in a few words. */
export function noAnswer(p: Provenance): string {
  const who = reasonerName(p);
  if (p.status === 'stale') return `The answer of ${who} is of the ontology as it was before it was last changed.`;
  if (p.status === 'failed') return `${who} gave no answer.`;
  if (p.status === 'inconsistent') return `${who} finds the ontology inconsistent. From a contradiction everything follows, so nothing is inferred from it.`;
  return `${who} has not been asked about this ontology.`;
}

export interface About {
  iri: Iri;
  summary: ClassSummary;
  ways: PathResult;
}

interface Props {
  host: StructureHost;
  config: ModelTypeConfig;
  mode: HierarchyMode;
  focus: Iri | null;
  /** What the service said of the class in focus. Not there yet for a class that has only just been chosen. */
  about: About | null;
  /** Brings another class into focus and into view. */
  onGo: (iri: Iri) => void;
  /** Brings one of the places of the class in focus into view: the one this way down leads to. */
  onWay: (way: ClassRef[]) => void;
  /** Sets the class in focus beside another, to compare the two. */
  onCompare: (iri: Iri) => void;
}

/**
 * The structure of the class in focus at a glance: what is stated of where it stands, what the
 * reasoner adds, and how far it reaches. Nothing here is edited, and nothing of the entity's
 * annotations or restrictions is repeated: the buttons at the top lead to where those are.
 */
export function StructureSummary({ host, config, mode, focus, about, onGo, onWay, onCompare }: Props) {
  const one = config.termType.concept.label.toLowerCase();
  const seen = focus ? host.look(focus) : null;
  if (!focus || !seen) {
    return (
      <aside className="st-summary" aria-label={`The ${one} in focus`}>
        <p className="st-focus muted">Choose a {one} to see where it stands, to open it in Entities or to see it in the graph. Choosing one here does not select it.</p>
      </aside>
    );
  }
  const parents = plural(config.hierarchy.parent);
  const children = plural(config.hierarchy.child);
  const root = config.hierarchy.root;
  const link = (c: ClassRef) =>
    c.builtin ? (
      <code>{c.label}</code>
    ) : (
      <button className="link" title={c.iri} onClick={() => onGo(c.iri)}>
        {c.label}
      </button>
    );
  const listed = (items: ClassRef[], after?: (c: ClassRef) => ReactNode) =>
    items.map((c, i) => (
      <Fragment key={c.iri}>
        {i > 0 && ', '}
        {link(c)}
        {after?.(c)}
      </Fragment>
    ));
  const s = about?.summary;
  const inferred = s?.inferred;
  const current = inferred?.provenance.status === 'current';
  const position = s?.position;
  const count = (n: number, noun: string) => `${n.toLocaleString('en')} ${n === 1 ? noun : plural(noun)}`;

  return (
    <aside className="st-summary" aria-label={`The ${one} in focus`}>
      <div className="st-focus">
        <span className="dot concept" style={{ background: `var(--nc-${seen.color}-fill)`, borderColor: `var(--nc-${seen.color}-stroke)` }} />
        <strong className="name">{seen.label}</strong>
        <IriCell iri={seen.iri} of={seen.label} />
        <div className="row">
          <button className="btn small" title="Open it in the Entities view, where it is edited" onClick={() => host.openInEntities(focus)}>
            Open in Entities
          </button>
          <button className="btn small" title="Show it on the canvas" onClick={() => host.viewInGraph(focus)}>
            View in Graph
          </button>
          <button className="btn small" title={`Set it beside another ${one}: what each asserts, what each inherits, and how the two stand to each other`} onClick={() => onCompare(focus)}>
            Compare…
          </button>
        </div>
      </div>

      {s && inferred?.unsatisfiable && (
        <p className="st-unsat" role="status">
          <strong>Unsatisfiable.</strong> It can never have an instance: it is equivalent to <code>owl:Nothing</code>, according to {reasonerName(inferred.provenance)}.{' '}
          <button className="link" onClick={() => host.openValidation(focus)}>
            See why in Validation
          </button>
        </p>
      )}

      {s && (
        <>
          <section>
            <h3>{parents[0].toUpperCase() + parents.slice(1)}</h3>
            <dl className="st-facts">
              <dt>Asserted</dt>
              <dd>
                {s.asserted.superclasses.length ? listed(s.asserted.superclasses) : <span className="muted">none: directly under {root}</span>}
                {s.asserted.anonymousSuperclasses > 0 && (
                  <small title="It is asserted to be a subclass of a class expression, such as a restriction or an intersection. That is a superclass without a name: it is not a class in the hierarchy. Open the class in Entities to read it.">
                    and {s.asserted.anonymousSuperclasses} class expression{s.asserted.anonymousSuperclasses === 1 ? '' : 's'} without a name
                  </small>
                )}
              </dd>
              {host.reasoning && inferred && (
                <>
                  <dt>Inferred</dt>
                  <dd>
                    {!current ? (
                      <span className="muted">{noAnswer(inferred.provenance)}</span>
                    ) : inferred.unsatisfiable ? (
                      <code>owl:Nothing</code>
                    ) : inferred.superclasses?.length ? (
                      listed(
                        inferred.superclasses.map((x) => x.class),
                        (c) =>
                          inferred.superclasses!.find((x) => x.class.iri === c.iri)!.stated ? null : (
                            <span className="tag inferred" title="Entailed, and nowhere stated">
                              inferred
                            </span>
                          ),
                      )
                    ) : (
                      <span className="muted">none: directly under {root}</span>
                    )}
                    {current && (
                      <small title={inferred.provenance.notes.join('\n')}>
                        {inferred.unsatisfiable ? 'Equivalent to it' : 'Directly above it'}, according to {reasonerName(inferred.provenance)}
                        {inferred.provenance.completeness === 'incomplete' ? ', whose answer may be incomplete' : ''}.
                      </small>
                    )}
                  </dd>
                </>
              )}
            </dl>
          </section>

          {(s.asserted.equivalents.length > 0 || (inferred?.equivalents?.length ?? 0) > 0) && (
            <section>
              <h3>Equivalent {plural(one)}</h3>
              <dl className="st-facts">
                <dt>Asserted</dt>
                <dd>{s.asserted.equivalents.length ? listed(s.asserted.equivalents) : <span className="muted">none stated</span>}</dd>
                {current && (
                  <>
                    <dt>Inferred</dt>
                    <dd>{inferred?.equivalents?.length ? listed(inferred.equivalents) : <span className="muted">none</span>}</dd>
                  </>
                )}
              </dl>
            </section>
          )}

          <section>
            <h3>In the {mode} hierarchy</h3>
            {!position ? (
              <p className="muted">{inferred ? noAnswer(inferred.provenance) : ''} Its place in the asserted hierarchy is shown when that one is chosen.</p>
            ) : mode === 'inferred' && inferred?.unsatisfiable ? (
              <p className="muted">
                It is listed under <code>owl:Nothing</code>, with the other {plural(one)} that can have no instance. Being equivalent to <code>owl:Nothing</code>, it is below every {one} and has no level of its own.
              </p>
            ) : (
              <>
                <dl className="st-facts">
                  <dt>{children[0].toUpperCase() + children.slice(1)}</dt>
                  <dd>{position.subclasses ? `${position.subclasses.toLocaleString('en')} direct, ${position.descendants.toLocaleString('en')} in all` : 'none'}</dd>
                  <dt>Depth</dt>
                  <dd title={`${root} is level 0. Where a ${one} is reached by ways of different length, it is on more than one level.`}>
                    {position.depth.min === position.depth.max ? `level ${position.depth.min}` : `levels ${position.depth.min} to ${position.depth.max}`} below {root}
                  </dd>
                  <dt>Inheritance</dt>
                  <dd>
                    {position.superclasses > 1 ? `Multiple: ${count(position.superclasses, config.hierarchy.parent)} directly above it` : position.superclasses === 1 ? `Single: one ${config.hierarchy.parent} directly above it` : `None: directly under ${root}`}
                    {position.inCycle && <small>It is one of a group that are each other’s {parents}.</small>}
                  </dd>
                </dl>
                {about.ways.paths.length > 0 && (
                  <>
                    <h4>
                      {about.ways.paths.length === 1 ? 'The way' : `${about.ways.paths.length}${about.ways.truncated ? ' or more' : ''} ways`} down to it from {root}
                    </h4>
                    <ul className="st-ways">
                      {about.ways.paths.map((way) => (
                        <li key={way.map((c) => c.iri).join(' ')}>
                          <button title="Show this place in the hierarchy" onClick={() => onWay(way)}>
                            {way.map((c, i) => (
                              <Fragment key={c.iri}>
                                {i > 0 && <span aria-hidden="true"> › </span>}
                                <span className={i === way.length - 1 ? 'last' : ''}>{c.label}</span>
                              </Fragment>
                            ))}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
