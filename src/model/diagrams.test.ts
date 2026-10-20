import { beforeEach, describe, expect, it } from 'vitest';
import { useStore, viewOf } from './store';
import { NO_SUBGRAPH } from './state/subgraph';
import { FIRST_DIAGRAM, emptyModel, newTerm, normalizeModel, type Model } from './types';
import { withIris } from './iri';

/**
 * Several diagrams of one ontology (FR-M5-7): each with its own contents, arrangement and style.
 * A diagram leaves terms out; it never takes them out of the ontology.
 */

const model = (): Model => {
  const a = newTerm({ name: 'Alpha', iri: 'http://example.org/f#Alpha', x: 10, y: 20 });
  const b = newTerm({ name: 'Beta', iri: 'http://example.org/f#Beta', x: 200, y: 20 });
  const c = newTerm({ name: 'Gamma', iri: 'http://example.org/f#Gamma', x: 390, y: 20 });
  return withIris({ ...emptyModel('Several diagrams'), terms: [a, b, c] });
};
const names = (m: Model) => viewOf({ model: m, subgraph: NO_SUBGRAPH }).terms.map((t) => t.name);

describe('the diagrams of a model', () => {
  it('is one diagram when the model has none, drawn as the model was', () => {
    const raw = JSON.parse(JSON.stringify(model()));
    delete raw.diagrams;
    delete raw.diagram;
    const back = normalizeModel(raw);
    expect(back.diagrams).toHaveLength(1);
    expect(back.diagrams[0]).toMatchObject({ id: FIRST_DIAGRAM, name: 'Diagram 1', hidden: [] });
    expect(back.diagram).toBe(FIRST_DIAGRAM);
    // The diagram on the canvas is drawn by the model's own fields; its snapshot here starts empty
    // and is brought up to date when the canvas switches away from it.
    expect(back.diagrams[0].positions).toEqual({});
    expect(back.diagrams[0].style).toBe(back.style);
    expect(back.diagrams[0].layout).toBe(back.layout);
  });

  it('keeps what each diagram leaves out and where its terms sit, and the one it was on', () => {
    const m = model();
    const [a, b] = m.terms;
    const raw = {
      ...JSON.parse(JSON.stringify(m)),
      diagrams: [
        { id: 'd1', name: 'Overview', hidden: [], positions: { [a.id]: { x: 1, y: 2 } }, style: m.style, layout: m.layout },
        { id: 'd2', name: 'Detail', hidden: [b.id, 'gone'], positions: { [b.id]: { x: 300, y: 400 }, gone: { x: 0, y: 0 } }, style: { ...m.style, theme: 'slate' }, layout: { ...m.layout, routing: 'orthogonal' } },
      ],
      diagram: 'd2',
    };
    const back = normalizeModel(raw);
    expect(back.diagram).toBe('d2');
    expect(back.diagrams.map((d) => d.name)).toEqual(['Overview', 'Detail']);
    // Places and left-out terms of terms that no longer exist are dropped.
    expect(back.diagrams[1].hidden).toEqual([b.id]);
    expect(back.diagrams[0].positions).toEqual({ [a.id]: { x: 1, y: 2 } });
    expect(back.diagrams[1].positions).toEqual({ [b.id]: { x: 300, y: 400 } });
    // The diagram on the canvas is drawn by the model's own fields, which are the same for both:
    // its snapshot (theme "slate", orthogonal lines) is what it was, and is not what is drawn.
    expect(back.style.theme).toBe('standard');
    expect(back.layout.routing).toBe('auto');
    expect(back.diagrams[1].style.theme).toBe('slate');
    expect(back.diagrams[1].layout.routing).toBe('orthogonal');
  });
});

describe('switching diagrams', () => {
  beforeEach(() => useStore.getState().replaceModel(model()));

  it('shows the terms one leaves out as still in the ontology and in the other diagram', () => {
    const st = useStore.getState;
    const b = st().model.terms[1];
    const second = st().addDiagram();
    expect(st().model.diagrams.map((d) => d.name)).toEqual(['Diagram 1', 'Diagram 2']);
    expect(st().model.diagram).toBe(second);

    st().hideFromDiagram([b.id]);
    expect(names(st().model)).toEqual(['Alpha', 'Gamma']);
    // The ontology is not changed: the term is still there, and the other diagram shows it.
    expect(st().model.terms.map((t) => t.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    st().switchDiagram(FIRST_DIAGRAM);
    expect(names(st().model)).toEqual(['Alpha', 'Beta', 'Gamma']);
    st().switchDiagram(second);
    expect(names(st().model)).toEqual(['Alpha', 'Gamma']);
    // And it is back in that diagram's own record, still left out.
    expect(st().model.diagrams.find((d) => d.id === second)!.hidden).toEqual([b.id]);

    st().showInDiagram([b.id]);
    expect(names(st().model)).toEqual(['Alpha', 'Beta', 'Gamma']);
    st().showAllInDiagram();
    expect(st().model.diagrams.find((d) => d.id === second)!.hidden).toEqual([]);
  });

  it('keeps each diagram’s places, style and layout apart', () => {
    const st = useStore.getState;
    const a = st().model.terms[0];
    const second = st().addDiagram();
    st().updateTerm(a.id, { x: 500, y: 600 });
    st().setStyle((s) => ({ ...s, theme: 'slate' }));
    st().setLayout({ routing: 'orthogonal' });

    st().switchDiagram(FIRST_DIAGRAM);
    const first = st().model.terms.find((t) => t.id === a.id)!;
    expect([first.x, first.y]).toEqual([10, 20]);
    expect(st().model.style.theme).not.toBe('slate');
    expect(st().model.layout.routing).toBe('auto');

    st().switchDiagram(second);
    const again = st().model.terms.find((t) => t.id === a.id)!;
    expect([again.x, again.y]).toEqual([500, 600]);
    expect(st().model.style.theme).toBe('slate');
    expect(st().model.layout.routing).toBe('orthogonal');
  });

  it('deletes a diagram, not its terms, and keeps the one it was on when that is deleted', () => {
    const st = useStore.getState;
    const second = st().addDiagram('Detail');
    st().hideFromDiagram([st().model.terms[1].id]);
    st().deleteDiagram(second);
    expect(st().model.diagrams.map((d) => d.name)).toEqual(['Diagram 1']);
    expect(st().model.terms).toHaveLength(3);
    expect(names(st().model)).toEqual(['Alpha', 'Beta', 'Gamma']);
    // The last diagram stays: a model always has one picture.
    useStore.setState({ toast: null });
    st().deleteDiagram(FIRST_DIAGRAM);
    expect(st().model.diagrams).toHaveLength(1);
    expect(st().toast).toBe('A model keeps at least one diagram.');
  });

  it('renames a diagram, and leaves a name empty rather than nameless', () => {
    const st = useStore.getState;
    st().renameDiagram(FIRST_DIAGRAM, '  Overview  ');
    expect(st().model.diagrams[0].name).toBe('Overview');
    st().renameDiagram(FIRST_DIAGRAM, '   ');
    expect(st().model.diagrams[0].name).toBe('Overview');
  });
});
