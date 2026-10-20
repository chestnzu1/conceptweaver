import { uid, type Diagram, type Model } from '../types';
import type { Slice } from './types';

/**
 * The diagrams of the ontology (FR-M5-7): several pictures of it, each with its own contents,
 * arrangement and style. A diagram leaves terms out rather than holding them: a term is in every
 * diagram until one leaves it out, a term made later is in all of them, and a term left out of a
 * diagram is still in the ontology, in the other diagrams, and in the RDF.
 *
 * The diagram on the canvas keeps its positions on the terms themselves (Term.x/y), its style in
 * `Model.style` and its layout in `Model.layout`, as a model of one diagram always has. Its
 * snapshot in `diagrams` is brought up to date when the canvas switches to another one.
 */

/** The diagram on the canvas. A model always has one; a model read from an earlier format is given one. */
export const activeDiagramOf = (m: Model): Diagram | undefined => m.diagrams.find((d) => d.id === m.diagram) ?? m.diagrams[0];

/** The model with the diagram on its canvas written down as it is drawn now. */
function snapshot(m: Model): Model {
  const active = activeDiagramOf(m);
  if (!active) return m;
  const positions = Object.fromEntries(m.terms.map((t) => [t.id, { x: t.x, y: t.y }]));
  return { ...m, diagrams: m.diagrams.map((d) => (d === active ? { ...d, positions, style: m.style, layout: m.layout } : d)) };
}

/** The model with `to` on its canvas: its terms where it puts them, drawn as it is drawn. */
function show(m: Model, to: Diagram): Model {
  return {
    ...m,
    diagram: to.id,
    terms: m.terms.map((t) => (to.positions[t.id] ? { ...t, x: to.positions[t.id].x, y: to.positions[t.id].y } : t)),
    style: to.style,
    layout: to.layout,
  };
}

/** A name no diagram has: "Diagram 2" after "Diagram 1". */
function freeName(diagrams: Diagram[]): string {
  const used = new Set(diagrams.map((d) => d.name.trim().toLowerCase()));
  let n = 1;
  while (used.has(`diagram ${n}`)) n++;
  return `Diagram ${n}`;
}

export interface DiagramsSlice {
  /** Draws another of the model's diagrams: its contents, where its terms sit, its style and its layout. */
  switchDiagram: (id: string) => void;
  /** Makes a diagram that starts as a copy of the one on the canvas, and draws it. Returns its id. */
  addDiagram: (name?: string) => string;
  /** Gives a diagram another name. */
  renameDiagram: (id: string, name: string) => void;
  /**
   * Removes a diagram. If it was on the canvas, another one is drawn. Nothing is removed from the
   * ontology: every term stays, in the other diagrams and in the RDF.
   */
  deleteDiagram: (id: string) => void;
  /** Leaves terms out of the diagram on the canvas. They stay in the ontology. */
  hideFromDiagram: (ids: string[]) => void;
  /** Puts terms back in the diagram on the canvas. */
  showInDiagram: (ids: string[]) => void;
  /** Puts back every term the diagram on the canvas leaves out. */
  showAllInDiagram: () => void;
}

export const diagramsSlice: Slice<DiagramsSlice> = (_set, get) => ({
  switchDiagram: (id) => {
    const m = get().model;
    if (m.diagram === id || !m.diagrams.some((d) => d.id === id)) return;
    get().apply((model) => {
      const target = model.diagrams.find((d) => d.id === id);
      return target ? show(snapshot(model), target) : model;
    });
    get().fit();
  },
  addDiagram: (name) => {
    const id = uid();
    const named = name?.trim() || freeName(get().model.diagrams);
    get().apply((model) => {
      const snap = snapshot(model);
      const active = activeDiagramOf(snap);
      if (!active) return model;
      const made: Diagram = {
        id,
        name: named,
        // It starts as the picture on the canvas: the same terms left out, places, style and layout.
        hidden: [...active.hidden],
        positions: { ...active.positions },
        style: active.style,
        layout: active.layout,
      };
      return { ...snap, diagrams: [...snap.diagrams, made], diagram: id };
    });
    get().fit();
    return id;
  },
  renameDiagram: (id, name) => {
    const clean = name.trim();
    if (!clean || !get().model.diagrams.some((d) => d.id === id)) return;
    get().apply((m) => ({ ...m, diagrams: m.diagrams.map((d) => (d.id === id && d.name !== clean ? { ...d, name: clean } : d)) }));
  },
  deleteDiagram: (id) => {
    const m = get().model;
    const at = m.diagrams.findIndex((d) => d.id === id);
    if (at < 0) return;
    if (m.diagrams.length === 1) {
      get().notify('A model keeps at least one diagram.');
      return;
    }
    get().apply((model) => {
      const drawn = model.diagram === id;
      const base = drawn ? model : snapshot(model);
      const left = base.diagrams.filter((d) => d.id !== id);
      const next = left[Math.max(0, Math.min(at - 1, left.length - 1))];
      return drawn ? show({ ...base, diagrams: left }, next) : { ...base, diagrams: left };
    });
    get().fit();
  },
  hideFromDiagram: (ids) => {
    const hiding = new Set(ids);
    if (!hiding.size) return;
    get().apply((m) => {
      const active = activeDiagramOf(m);
      if (!active) return m;
      const known = m.terms.filter((t) => hiding.has(t.id)).map((t) => t.id);
      if (!known.length || known.every((x) => active.hidden.includes(x))) return m;
      const hidden = [...new Set([...active.hidden, ...known])];
      return { ...m, diagrams: m.diagrams.map((d) => (d === active ? { ...d, hidden } : d)) };
    });
  },
  showInDiagram: (ids) => {
    const showing = new Set(ids);
    if (!showing.size) return;
    get().apply((m) => {
      const active = activeDiagramOf(m);
      if (!active || !active.hidden.some((x) => showing.has(x))) return m;
      return { ...m, diagrams: m.diagrams.map((d) => (d === active ? { ...d, hidden: d.hidden.filter((x) => !showing.has(x)) } : d)) };
    });
  },
  showAllInDiagram: () =>
    get().apply((m) => {
      const active = activeDiagramOf(m);
      if (!active?.hidden.length) return m;
      return { ...m, diagrams: m.diagrams.map((d) => (d === active ? { ...d, hidden: [] } : d)) };
    }),
});
