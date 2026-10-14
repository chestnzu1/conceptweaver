import { useMemo } from 'react';
import { findPath } from '../model/checks';
import { configOf, supports } from '../model/modelTypes';
import { objectProperties } from '../model/props';
import { ENGINES } from '../model/reasoning';
import { stable } from '../model/stable';
import { useStore, type StructureMode } from '../model/store';
import type { HierarchyMode, Iri, OntologyRef, StructureService } from '../structure/contracts';
import { createLocalStructureService, ontologyRef, termOfClass } from '../structure/local';
import { openEntityTab } from './Entities';
import { StructureAnalyze } from './StructureAnalyze';
import { StructureCompare } from './StructureCompare';
import { StructureExplore } from './StructureExplore';

/**
 * Where the Structure Explorer gets its answers. Today that is the model in the editor, and for
 * what is inferred the reasoner chosen under Validation. A service that asks a backend would be
 * put here in its place, and nothing below would change.
 */
const service: StructureService = createLocalStructureService(() => {
  const s = useStore.getState();
  return { model: s.model, docId: s.doc.id, reasoning: { engine: s.validation.engine, run: s.validation.run } };
});

/**
 * What the explorer's views are given of the app around them. They ask the service about the
 * ontology and name classes by IRI; this is how they reach the rest of the app from there.
 */
export interface StructureHost {
  service: StructureService;
  /** The ontology in the editor, as it is now. */
  ontology: OntologyRef;
  /** A class as the app shows it elsewhere, or null when there is no such class any more. */
  look: (iri: Iri) => { label: string; iri?: string; color: string } | null;
  /** Opens the class in the Entities view, where it is edited. */
  openInEntities: (iri: Iri) => void;
  /** Shows the class on the canvas. */
  viewInGraph: (iri: Iri) => void;
  /** Shows two classes on the canvas, both selected, with the shortest way between them picked out where there is one. */
  viewPairInGraph: (a: Iri, b: Iri) => void;
  /** Opens an entity a result names (a class, or a property by its IRI) in the side panel, without leaving the explorer. */
  openEntity: (iri: Iri) => void;
  /** The reasoners there are to choose from, and what the one in use is doing. None, for a type of model that is not reasoned over. */
  reasoning: {
    engines: { id: string; label: string; about: string }[];
    engine: string;
    /** It answers only when it is asked, so there is something to run. */
    asked: boolean;
    running: boolean;
    phase: string;
    /** Changes whenever what the reasoner has to say may have changed, so that what was asked of it is asked again. */
    key: string;
  } | null;
  chooseReasoner: (id: string) => void;
  runReasoning: () => void;
  /** Opens the Validation view: on what it found about a class, when one is given and it found something. */
  openValidation: (about?: Iri) => void;
  /** Opens the Validation view on the first thing it found under one of these rules, where it found any. */
  openValidationFor: (rules: string[]) => void;
  /** Shows a set of classes on the canvas as a subgraph: those classes, and the relationships between them. */
  viewManyInGraph: (iris: Iri[]) => void;
}

const MODES: { id: StructureMode; label: string }[] = [
  { id: 'explore', label: 'Explore' },
  { id: 'compare', label: 'Compare' },
  { id: 'analyze', label: 'Analyze' },
];

const HIERARCHIES: { id: HierarchyMode; label: string; about: string }[] = [
  { id: 'asserted', label: 'Asserted', about: 'What is stated: each class under every superclass that is stated for it, and nothing else.' },
  { id: 'inferred', label: 'Inferred', about: 'What the chosen reasoner entails: each class under the classes directly above it, equivalent classes together, and the classes that can have no instance set apart.' },
];

/**
 * The Structure Explorer: the hierarchy of the ontology to look through, to compare classes in
 * and to measure. It reads the ontology and changes nothing in it; an entity is edited in the
 * Entities view, which every class here leads to.
 */
export function StructureView() {
  // What the ontology says does not change while terms are dragged about, so neither does this.
  const model = stable(useStore((s) => s.model));
  const docId = useStore((s) => s.doc.id);
  const docSeq = useStore((s) => s.docSeq);
  const mode = useStore((s) => s.structure.mode);
  const wanted = useStore((s) => s.structure.hierarchy);
  const engine = useStore((s) => s.validation.engine);
  const running = useStore((s) => s.validation.running);
  const phase = useStore((s) => s.validation.phase);
  const ranAt = useStore((s) => s.validation.run?.at ?? 0);
  const st = useStore.getState;
  const config = configOf(model);
  const reasons = supports(model, 'reasoning');
  // A type of model that is not reasoned over has the asserted hierarchy and no other.
  const hierarchy: HierarchyMode = reasons ? wanted : 'asserted';
  // The same for as long as the ontology is: what was asked of one revision is not asked again because a reasoner started or stopped.
  const ontology = useMemo(() => ontologyRef(model, docId), [model, docId]);
  const host = useMemo((): StructureHost => {
    const byId = new Map(model.terms.map((t) => [t.id, t]));
    const term = (iri: Iri) => byId.get(termOfClass(model, iri) ?? '');
    return {
      service,
      ontology,
      look: (iri) => {
        const t = term(iri);
        return t ? { label: t.name || 'Unnamed', iri: t.iri, color: t.color || 'default' } : null;
      },
      openInEntities: (iri) => {
        const t = term(iri);
        if (!t) return;
        openEntityTab('concept', t.id);
        st().select([t.id]);
        st().setView('table');
      },
      viewInGraph: (iri) => {
        const t = term(iri);
        if (t) st().focusTerm(t.id);
      },
      viewPairInGraph: (a, b) => {
        const [x, y] = [term(a), term(b)];
        if (!x || !y) return;
        st().focusTerm(x.id);
        st().select([x.id, y.id]);
        const way = findPath(st().model, x.id, y.id);
        if (way) st().setHighlight([...way.terms, ...way.rels], 'Showing the shortest path between the two classes');
      },
      openEntity: (iri) => {
        const t = term(iri) ?? model.terms.find((x) => x.iri === iri);
        if (t) return st().select([t.id]);
        const prop = model.mode === 'skos' ? undefined : objectProperties(model).find((p) => p.iri === iri);
        if (prop) st().selectProp(prop.id);
      },
      reasoning: reasons ? { engines: ENGINES, engine, asked: engine === 'dl', running, phase, key: `${engine} ${ranAt} ${running}` } : null,
      chooseReasoner: (id) => {
        const next = ENGINES.find((e) => e.id === id);
        if (!next || next.id === st().validation.engine) return;
        // As under Validation: the other reasoner's answer is not left standing as if it were this one's. It is asked at once.
        st().setValidation({ engine: next.id });
        void st().runValidation('owl');
      },
      runReasoning: () => void st().runValidation('owl'),
      openValidation: (about) => {
        const t = about ? term(about) : undefined;
        const finding = t && st().validation.run?.findings.find((f) => f.category === 'owl' && (f.ruleId === 'owl-unsatisfiable' || f.ruleId === 'owl-restrictions') && f.entity?.kind === 'term' && f.entity.id === t.id);
        st().setView('checks');
        st().setValidation({ tab: 'results', ...(finding ? { focus: finding.id } : {}) });
      },
      openValidationFor: (rules) => {
        const finding = st().validation.run?.findings.find((f) => rules.includes(f.ruleId));
        st().setView('checks');
        st().setValidation({ tab: 'results', ...(finding ? { focus: finding.id } : {}) });
      },
      viewManyInGraph: (iris) => {
        const ids = iris.map((iri) => term(iri)?.id).filter((id): id is string => !!id);
        if (!ids.length) return;
        // The classes themselves and what holds between them: nothing is added to them by going further out.
        st().setSubgraph({ roots: ids, depth: 0, expanded: [], hidden: [] });
        st().visualizeSubgraph();
      },
    };
  }, [model, ontology, st, reasons, engine, running, phase, ranAt]);
  return (
    <div className="view structure">
      <div className="view-head">
        <div className="tabs" role="tablist" aria-label="What to do with the structure">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => st().setStructure({ mode: m.id })}>
              {m.label}
            </button>
          ))}
        </div>
        {mode !== 'compare' &&
          (reasons ? (
            <div className="st-which">
              <span id="st-which">Hierarchy</span>
              <div className="tabs" role="group" aria-labelledby="st-which">
                {HIERARCHIES.map((h) => (
                  <button key={h.id} aria-pressed={hierarchy === h.id} className={hierarchy === h.id ? 'on' : ''} title={h.about} onClick={() => st().setStructure({ hierarchy: h.id })}>
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <span className="st-basis" title={`Each ${config.termType.concept.label.toLowerCase()} is under every ${config.hierarchy.parent} that is stated for it. Nothing inferred is shown.`}>
              Asserted hierarchy <code className="pred">{config.hierarchy.predicate}</code>
            </span>
          ))}
      </div>
      {/* Another model in the editor, or the other hierarchy, starts the explorer afresh; what was open in each is remembered. */}
      {mode === 'explore' && <StructureExplore key={`${docSeq} ${hierarchy}`} host={host} mode={hierarchy} />}
      {mode === 'compare' && <StructureCompare key={docSeq} host={host} />}
      {mode === 'analyze' && <StructureAnalyze key={`${docSeq} ${hierarchy}`} host={host} mode={hierarchy} />}
    </div>
  );
}
