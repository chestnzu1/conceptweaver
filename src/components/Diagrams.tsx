import { activeDiagramOf, useStore } from '../model/store';
import { CommitInput } from './fields';

/**
 * The diagrams of the ontology (FR-M5-7): several pictures of it, each with its own contents,
 * arrangement and style. The button says which diagram the canvas draws; opening it shows the
 * others, and what the diagram leaves out.
 */
export function DiagramBar({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const model = useStore((s) => s.model);
  const active = activeDiagramOf(model);
  return (
    <button
      className="btn small"
      aria-expanded={open}
      title="The diagrams of this ontology: each with its own contents, arrangement and style. What one leaves out stays in the ontology."
      onClick={onToggle}
    >
      {active?.name ?? 'Diagram'}
    </button>
  );
}

/** Which diagram is drawn, its name, and the terms it leaves out. */
export function DiagramOptions() {
  const model = useStore((s) => s.model);
  const selected = useStore((s) => s.sel.terms);
  const active = activeDiagramOf(model);
  const st = useStore.getState;
  if (!active) return null;
  const known = new Set(model.terms.map((t) => t.id));
  const leftOut = active.hidden.filter((id) => known.has(id)).length;
  const shown = model.terms.length - leftOut;
  const noun = leftOut === 1 ? 'term' : 'terms';
  return (
    <div className="subgraph-body diagram-options">
      <div className="field two">
        <label>
          <span>Diagram</span>
          <select aria-label="Diagram" value={active.id} onChange={(e) => st().switchDiagram(e.target.value)}>
            {model.diagrams.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Name</span>
          <CommitInput aria-label="Name of the diagram" value={active.name} spellCheck={false} onCommit={(name) => st().renameDiagram(active.id, name)} />
        </label>
      </div>
      <p className="muted">
        {shown} of {model.terms.length} {model.terms.length === 1 ? 'term' : 'terms'} shown{leftOut ? `, ${leftOut} left out` : ''}.
      </p>
      <div className="row">
        <button className="btn small" title="Make another diagram, starting as this one is now" onClick={() => st().addDiagram()}>
          New diagram
        </button>
        <button
          className="btn small"
          disabled={model.diagrams.length < 2}
          title={model.diagrams.length < 2 ? 'A model keeps at least one diagram.' : 'Delete this diagram. Its terms stay in the ontology and in the other diagrams.'}
          onClick={() => st().deleteDiagram(active.id)}
        >
          Delete this diagram
        </button>
      </div>
      <div className="field">
        <span>Contents</span>
        <div className="row">
          <button className="btn small" disabled={!selected.length} title={selected.length ? 'They stay in the ontology and in the other diagrams' : 'Select terms on the canvas first'} onClick={() => st().hideFromDiagram(selected)}>
            {selected.length === 1 ? 'Remove the selected term from this diagram' : `Remove ${selected.length || 'the selected'} terms from this diagram`}
          </button>
          <button className="btn small" disabled={!leftOut} onClick={() => st().showAllInDiagram()}>
            Put back the {leftOut || ''} {noun} left out
          </button>
        </div>
      </div>
      <p className="muted">What a diagram leaves out is not deleted: it stays in the ontology, in the other diagrams, and in the RDF.</p>
    </div>
  );
}
