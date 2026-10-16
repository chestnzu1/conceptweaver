import { useMemo, useState } from 'react';
import { alreadyIn, PROPOSAL_GROUPS, proposalsFor, proposalText, proposeShapes, withProposals, type Proposal } from '../model/proposals';
import { newSetFor, shapeNaming } from '../model/shapes';
import { useStore } from '../model/store';
import { EntityPicker, type Choice } from './EntityPicker';

/**
 * The shapes the ontology suggests, to review (roadmap stage SH-3, ADR-020). Each proposal shows
 * its axiom, the shape it would add, what the axiom means in OWL, what the shape would check, and
 * where the two differ. None is chosen to begin with: they are chosen one by one or by kind, or
 * dismissed, and the ones chosen are added to a shape set as one edit, which undo takes back.
 */
export function ProposalsDialog({ classes }: { classes: string[] | null }) {
  const model = useStore((s) => s.model);
  const openSet = useStore((s) => s.shapesView.set);
  const st = useStore.getState;
  const all = useMemo(() => proposeShapes(model), [model]);
  const found = useMemo(() => proposalsFor(all, classes), [all, classes]);
  const [into, setInto] = useState<string>(() => (model.shapeSets.some((s) => s.id === openSet) ? openSet! : (model.shapeSets[0]?.id ?? 'new')));
  const set = model.shapeSets.find((s) => s.id === into);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const naming = useMemo(() => shapeNaming(model, set ?? newSetFor('')), [model, set]);
  const shown = found.proposals.filter((p) => !dismissed.has(p.id));
  const has = (p: Proposal) => !!set && alreadyIn(set, p);
  const takeable = (list: Proposal[]) => list.filter((p) => !has(p));
  const toggle = (ids: string[], on: boolean) => setChosen((c) => new Set(on ? [...c, ...ids] : [...c].filter((x) => !ids.includes(x))));
  const close = () => st().openProposals(undefined);
  const classChoices = useMemo<Choice[]>(() => model.terms.filter((t) => t.type === 'concept' && t.iri).map((t) => ({ id: t.iri!, name: t.name || 'Unnamed', iri: t.iri })), [model.terms]);
  const nameOf = (iri: string) => classChoices.find((c) => c.id === iri)?.name ?? naming.name(iri);

  const add = () => {
    const accepted = shown.filter((p) => chosen.has(p.id) && !has(p));
    if (!accepted.length) return;
    const target = set ?? newSetFor('From the ontology');
    const { set: next, shapes } = withProposals(model, target, accepted);
    st().setShapeSets((sets) => (set ? sets.map((s) => (s.id === set.id ? next : s)) : [...sets, next]));
    st().openShapes(next.id, null);
    st().notify(`${shapes} shape${shapes === 1 ? '' : 's'} added to “${next.name}”, each saying which axiom it came from. Undo takes ${shapes === 1 ? 'it' : 'them'} back.`);
  };
  const count = shown.filter((p) => chosen.has(p.id) && !has(p)).length;

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog proposals" role="dialog" aria-modal="true" aria-labelledby="proposals-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="proposals-title">Shapes proposed from the ontology</h2>
        <p className="muted">
          An axiom is not a shape. The axiom says what holds and lets OWL conclude what is not stated; a shape says what the data must state. Each proposal says what its axiom means, what the shape would check, and where they differ. Nothing is added until you choose it.
        </p>
        <div className="proposal-scope">
          <span>For</span>
          {classes ? (
            <EntityPicker
              values={classes.map((iri) => ({ id: iri, name: nameOf(iri), iri }))}
              options={() => classChoices.filter((c) => !classes.includes(c.id))}
              onAdd={(id) => st().openProposals([...classes, id])}
              onRemove={(id) => st().openProposals(classes.filter((x) => x !== id).length ? classes.filter((x) => x !== id) : null)}
              noun="class"
              of="the proposals"
              addLabel="Add a class"
              searchLabel="Search for a class to propose shapes for"
            />
          ) : (
            <strong>the whole ontology</strong>
          )}
          <button className="link" onClick={() => st().openProposals(classes ? null : [])}>
            {classes ? 'the whole ontology instead' : 'some classes instead'}
          </button>
        </div>
        <div className="proposal-list" aria-label="Proposals">
          {!shown.length && <p className="muted">{classes && !classes.length ? 'Choose a class, or the whole ontology.' : 'The ontology states nothing a shape could be proposed from here.'}</p>}
          {PROPOSAL_GROUPS.map((group) => {
            const here = shown.filter((p) => p.group === group);
            if (!here.length) return null;
            const open = takeable(here);
            return (
              <section key={group} className="proposal-group" data-group={group}>
                <header>
                  <h3>
                    {group} ({here.length})
                  </h3>
                  <button className="link" disabled={!open.length} onClick={() => toggle(open.map((p) => p.id), !open.every((p) => chosen.has(p.id)))}>
                    {open.length && open.every((p) => chosen.has(p.id)) ? 'Choose none of these' : `Choose all ${open.length}`}
                  </button>
                  <button className="link" onClick={() => setDismissed((d) => new Set([...d, ...here.map((p) => p.id)]))}>
                    Dismiss these
                  </button>
                </header>
                {here.map((p) => (
                  <article key={p.id} className={'proposal' + (chosen.has(p.id) ? ' on' : '')} data-proposal={p.id}>
                    <label className="check">
                      <input type="checkbox" disabled={has(p)} checked={chosen.has(p.id) && !has(p)} onChange={(e) => toggle([p.id], e.target.checked)} aria-label={`Choose the shape from ${p.axiom}`} />
                      <code className="axiom">{p.axiom}</code>
                      {has(p) && <span className="tag">in “{set!.name}” already</span>}
                    </label>
                    <code className="proposed">{proposalText(p, naming.name)}</code>
                    <dl>
                      <dt>OWL</dt>
                      <dd>{p.owl}</dd>
                      <dt>The shape</dt>
                      <dd>{p.shacl}</dd>
                      <dt>Differs</dt>
                      <dd>{p.differ}</dd>
                    </dl>
                    <button className="btn icon ghost" aria-label={`Dismiss the proposal from ${p.axiom}`} title="Dismiss: not shown again while this is open" onClick={() => setDismissed((d) => new Set([...d, p.id]))}>
                      ×
                    </button>
                  </article>
                ))}
              </section>
            );
          })}
          {found.notProposed.length > 0 && (
            <details className="not-proposed">
              <summary>Not proposed ({found.notProposed.length})</summary>
              <ul>
                {found.notProposed.map((x) => (
                  <li key={x.origin}>
                    <code>{x.axiom}</code>
                    <span className="muted"> {x.why}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {dismissed.size > 0 && (
            <button className="link" onClick={() => setDismissed(new Set())}>
              Show the {dismissed.size} dismissed again
            </button>
          )}
        </div>
        <div className="dialog-actions">
          <label className="field into">
            <span>Into</span>
            <select aria-label="Shape set to add to" value={into} onChange={(e) => setInto(e.target.value)}>
              {model.shapeSets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || 'Shapes'}
                </option>
              ))}
              <option value="new">A new shape set</option>
            </select>
          </label>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" disabled={!count} onClick={add}>
            {count ? `Add ${count} shape${count === 1 ? '' : 's'}` : 'Add shapes'}
          </button>
        </div>
      </div>
    </div>
  );
}
