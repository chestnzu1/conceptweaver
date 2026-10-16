import { useEffect, useMemo, useRef, useState } from 'react';
import { download } from '../model/files';
import { objectProperties } from '../model/props';
import { isPropertyShape, PARAM, PARAMS, pathOf, pathToSparql, SH, shapeSetTurtle, sparqlToPath, termFromText, termToText, valuesOf, type ParamInfo, type Shape, type ShaclTerm, type ShaclValue, type ShapeProp, type ShapeSet } from '../model/shacl';
import { importIntoSet, inlineIn, modelPrefixes, namespaceOf, nestedIds, newInlineShape, newNodeShape, newPropertyShape, newSetFor, setTurtle, shapeName, shapeNaming, shapesAbout, targetClasses, topShapes, turtleProblem, withoutInline, type ShapeNaming } from '../model/shapes';
import { stable } from '../model/stable';
import { useStore } from '../model/store';
import { DATATYPES, type Model } from '../model/types';
import { EntityPicker, type Choice } from './EntityPicker';
import { Section } from './EntityEditor';
import { CommitInput } from './fields';

/**
 * The Shapes view (roadmap stage SH-1): the model's SHACL shape sets, each a constraint model of
 * its own (what an application or a source accepts), beside the ontology and never part of it.
 * A set lists its shapes by what they target; a shape is edited as what is said of it, parameter
 * by parameter, every construct of SHACL Core in the form, shapes inside shapes in place. Shapes
 * name classes and properties by IRI, so they also work for data with a vocabulary of its own.
 */

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NODE_KINDS = ['IRI', 'Literal', 'BlankNode', 'BlankNodeOrIRI', 'BlankNodeOrLiteral', 'IRIOrLiteral'];
const SEVERITIES = ['Violation', 'Warning', 'Info'];
/** What is shown apart from the parameters: the kind, the name, the path, the property shapes. */
const OWN = new Set([RDF + 'type', RDFS + 'label', SH + 'path', SH + 'property']);
const GROUPS = [...new Set(PARAMS.map((p) => p.group))];
const fileName = (model: Model, set: ShapeSet) => `${[model.name, set.name].map((x) => x.trim().replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()).filter(Boolean).join('-') || 'shapes'}.ttl`;

/** The model's entities as choices whose identity is their IRI. */
function useChoices(model: Model) {
  return useMemo(() => {
    const of = { class: [] as Choice[], property: [] as Choice[], individual: [] as Choice[] };
    for (const t of model.terms) if (t.iri) of[t.type === 'concept' ? 'class' : t.type === 'instance' ? 'individual' : 'property'].push({ id: t.iri, name: t.name || 'Unnamed', iri: t.iri });
    if (model.mode !== 'skos') for (const p of objectProperties(model)) if (p.iri) of.property.push({ id: p.iri, name: p.name, iri: p.iri });
    const datatypes: Choice[] = [...DATATYPES.map((d) => ({ id: d.id.startsWith('xsd:') ? XSD + d.id.slice(4) : RDF + d.id.slice(4), name: d.id, tag: d.label })), { id: RDFS + 'Literal', name: 'rdfs:Literal', tag: 'any literal' }];
    return { ...of, datatype: datatypes };
  }, [model]);
}

/** Edits of the set open in the view, each an edit of the model. */
function useEdits(setId: string) {
  const st = useStore.getState;
  const editSet = (f: (s: ShapeSet) => ShapeSet) => st().setShapeSets((sets) => sets.map((s) => (s.id === setId ? f(s) : s)));
  const editShape = (id: string, f: (s: Shape) => Shape) => editSet((s) => ({ ...s, shapes: s.shapes.map((x) => (x.id === id ? f(x) : x)) }));
  return {
    editSet,
    editShape,
    setValue: (id: string, index: number, v: ShaclValue) => editShape(id, (s) => ({ ...s, props: s.props.map((x, i) => (i === index ? { ...x, v } : x)) })),
    remove: (id: string, index: number) =>
      editSet((set) => {
        const shape = set.shapes.find((x) => x.id === id)!;
        const v = shape.props[index].v;
        const next = { ...set, shapes: set.shapes.map((x) => (x.id === id ? { ...x, props: x.props.filter((_, i) => i !== index) } : x)) };
        // A shape written in place goes with the value it was.
        return withoutInline(next, inlineIn(v));
      }),
    add: (id: string, prop: ShapeProp, shapes: Shape[] = []) => editSet((s) => ({ ...s, shapes: [...s.shapes.map((x) => (x.id === id ? { ...x, props: [...x.props, prop] } : x)), ...shapes] })),
  };
}
type Edits = ReturnType<typeof useEdits>;

export function ShapesView() {
  const model = stable(useStore((s) => s.model));
  const open = useStore((s) => s.shapesView);
  const st = useStore.getState;
  const sets = model.shapeSets;
  const set = sets.find((s) => s.id === open.set) ?? sets[0];
  const addSet = () => {
    const made = newSetFor(sets.length ? `Shapes ${sets.length + 1}` : 'Shapes');
    st().setShapeSets((all) => [...all, made]);
    st().openShapes(made.id);
  };
  return (
    <div className="view shapes-view">
      <div className="view-head">
        <div>
          <h2>Shapes</h2>
          <small className="muted">SHACL shape sets: what data each application or source accepts. They are kept with the model, apart from the ontology; no OWL restriction becomes a shape.</small>
        </div>
      </div>
      <div className="shapes-body">
        <aside className="shape-sets" aria-label="Shape sets">
          <ul>
            {sets.map((s) => (
              <li key={s.id}>
                <button className={s === set ? 'on' : ''} aria-current={s === set} onClick={() => st().openShapes(s.id)}>
                  <strong>{s.name || 'Shapes'}</strong>
                  <span className="muted">
                    {topShapes(s).length} shape{topShapes(s).length === 1 ? '' : 's'}
                    {s.description ? ` · ${s.description}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button className="btn small" onClick={addSet}>
            New shape set
          </button>
          {!sets.length && <p className="muted">No shapes yet. A shape says what data must contain: “every Person has exactly one name”. Make a set, or import shapes into one.</p>}
        </aside>
        {set ? <SetPanel key={set.id} set={set} model={model} shapeId={open.shape} /> : <div className="muted pad">Make a shape set to begin, or open a model that has shapes.</div>}
      </div>
    </div>
  );
}

function SetPanel({ set, model, shapeId }: { set: ShapeSet; model: Model; shapeId: string | null }) {
  const st = useStore.getState;
  const edits = useEdits(set.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const naming = useMemo(() => shapeNaming(model, set), [model, set]);
  const tops = useMemo(() => topShapes(set), [set]);
  const open = (id: string | null) => st().openShapes(set.id, id);
  const kept = shapeId === 'kept';
  const shown = tops.find((s) => s.id === shapeId) ?? (shapeId && !kept ? tops.find((s) => nestedIds(set, s).has(shapeId)) : undefined);

  // The shapes by what they target: a class, other targets, or nothing (shapes used by others).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = new Map<string, Shape[]>();
    for (const s of tops) {
      const classes = targetClasses(s).map(naming.label);
      const other = ['targetNode', 'targetSubjectsOf', 'targetObjectsOf'].some((l) => valuesOf(s, SH + l).length);
      const text = `${shapeName(s)}\n${s.iri ?? ''}\n${classes.join('\n')}`.toLowerCase();
      if (q && !text.includes(q)) continue;
      const keys = classes.length ? classes : [other ? 'Other targets' : 'No target: used by other shapes'];
      for (const k of keys) (out.get(k) ?? out.set(k, []).get(k)!).push(s);
    }
    return [...out].sort((a, b) => (a[0].startsWith('No target') ? 1 : b[0].startsWith('No target') ? -1 : a[0] === 'Other targets' ? 1 : b[0] === 'Other targets' ? -1 : a[0].localeCompare(b[0])));
  }, [tops, query, naming]);

  const addShape = () => {
    // Started from the class selected elsewhere, if one is: the commonest shape says what its instances must have.
    const sel = st().sel.terms.map((id) => model.terms.find((t) => t.id === id)).find((t) => t?.type === 'concept' && t.iri);
    const shape = newNodeShape(model, set, sel ? sel.name : 'New shape', sel?.iri);
    edits.editSet((s) => ({ ...s, shapes: [...s.shapes, shape] }));
    open(shape.id);
  };
  const importFile = async (file: File) => {
    try {
      const got = importIntoSet(set, await file.text());
      if (!got.shapes && !got.kept) return st().notify(`No SHACL shapes found in ${file.name}.`);
      edits.editSet(() => got.set);
      st().notify(`Read ${file.name} into “${set.name}”: ${got.shapes} shape${got.shapes === 1 ? '' : 's'}${got.replaced ? `, ${got.replaced} of them in place of shapes with the same IRI` : ''}${got.kept ? `; ${got.kept} statement${got.kept === 1 ? '' : 's'} about no shape, kept as written` : ''}.`);
    } catch (e) {
      st().notify(`Could not read ${file.name}: ${e instanceof Error ? e.message : 'not valid Turtle'}`);
    }
  };
  const remove = () => {
    if (set.shapes.length && !window.confirm(`Delete the shape set “${set.name}” and its ${tops.length} shape${tops.length === 1 ? '' : 's'}? Undo brings it back.`)) return;
    st().setShapeSets((all) => all.filter((s) => s.id !== set.id));
    st().openShapes(null);
  };

  return (
    <div className="shape-set">
      <div className="shape-set-head">
        <label className="field">
          <span>Shape set</span>
          <CommitInput aria-label="Shape set name" value={set.name} onCommit={(name) => edits.editSet((s) => ({ ...s, name: name.trim() || 'Shapes' }))} />
        </label>
        <label className="field">
          <span>What it is for</span>
          <CommitInput aria-label="What the shape set is for" value={set.description} placeholder="An application, a data source…" onCommit={(description) => edits.editSet((s) => ({ ...s, description: description.trim() }))} />
        </label>
        <label className="field">
          <span>Namespace of its new shapes</span>
          <CommitInput aria-label="Namespace of new shapes" value={set.namespace} placeholder={namespaceOf(model, { ...set, namespace: '' })} onCommit={(namespace) => edits.editSet((s) => ({ ...s, namespace: namespace.trim() }))} />
        </label>
        <div className="row wrap">
          <button className="btn small" onClick={() => fileRef.current?.click()}>
            Import Turtle…
          </button>
          <button className="btn small" disabled={!set.shapes.length && !set.extra.trim()} onClick={() => download(fileName(model, set), setTurtle(model, set), 'text/turtle')}>
            Export
          </button>
          <button className="btn small danger" onClick={remove}>
            Delete set
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".ttl,.nt,.n3,.turtle,.shacl,text/turtle"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importFile(f);
          }}
        />
      </div>
      <div className="shapes">
        <aside className="shape-list" aria-label={`Shapes of ${set.name}`}>
          <div className="row wrap">
            <button className="btn small primary" onClick={addShape}>
              New shape
            </button>
            <input type="search" aria-label="Search the shapes" placeholder="Search shapes" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {groups.map(([group, shapes]) => (
            <div key={group} className="shape-group">
              <h4>{group}</h4>
              <ul>
                {shapes.map((s) => (
                  <li key={s.id}>
                    <button className={shown?.id === s.id ? 'on' : ''} aria-current={shown?.id === s.id} onClick={() => open(s.id)}>
                      <strong>{shapeName(s)}</strong>
                      <span className="muted">
                        {isPropertyShape(s) ? `property shape · ${pathToSparql(pathOf(s)!, naming.name)}` : `node shape · ${valuesOf(s, SH + 'property').length} propert${valuesOf(s, SH + 'property').length === 1 ? 'y' : 'ies'}`}
                      </span>
                      {valuesOf(s, SH + 'deactivated').some((v) => 'lit' in v && v.lit === 'true') && <span className="tag auto">off</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!tops.length && <p className="muted">No shapes in this set yet.</p>}
          <ul>
            <li>
              <button className={kept ? 'on' : ''} aria-current={kept} onClick={() => open('kept')}>
                <strong>Turtle kept as written</strong>
                <span className="muted">{set.extra.trim() ? 'what the set says about no shape' : 'nothing; write or paste shapes as Turtle'}</span>
              </button>
            </li>
          </ul>
        </aside>
        <div className="shape-editor">
          {shown && <ShapeForm key={shown.id} set={set} shape={shown} top={shown} model={model} naming={naming} edits={edits} focus={shapeId} />}
          {kept && <KeptText set={set} edits={edits} />}
          {!shown && !kept && (
            <div className="muted pad">
              <p>Choose a shape, or make a new one.</p>
              <p>A shape set is a constraint model: what an application, or a source of data, accepts. One class can have shapes in several sets, and several in one. A restriction of the ontology says what follows about a class’s members; a shape says what data must contain to be accepted, and is checked against the data as it is.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A shape, edited as what is said of it. `nested` for a shape inside another, written in place. */
function ShapeForm({ set, shape, top, model, naming, edits, focus, nested = false }: { set: ShapeSet; shape: Shape; top: Shape; model: Model; naming: ShapeNaming; edits: Edits; focus: string | null; nested?: boolean }) {
  const st = useStore.getState;
  const choices = useChoices(model);
  const [adding, setAdding] = useState('');
  const property = isPropertyShape(shape);
  const label = shape.props.findIndex((x) => x.p === RDFS + 'label' && 'lit' in x.v);
  const rows = shape.props.map((x, i) => ({ ...x, i })).filter((x) => !OWN.has(x.p) || (x.p === RDF + 'type' && !('iri' in x.v && (x.v.iri === SH + 'NodeShape' || x.v.iri === SH + 'PropertyShape'))) || (x.p === RDFS + 'label' && x.i !== label));
  const core = rows.filter((x) => PARAM.has(x.p) && fits(PARAM.get(x.p)!, x.v));
  const other = rows.filter((x) => !core.includes(x));
  const properties = shape.props.map((x, i) => ({ ...x, i })).filter((x) => x.p === SH + 'property');
  const offered = PARAMS.filter((p) => p.on === 'both' || (p.on === 'property') === property);
  // Opened from a validation finding: what failed this shape, shown here, at the constraint it failed.
  const failed = useStore((s) => (s.shapesView.shape === shape.id ? s.shapesView.failed : undefined));
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!failed) return;
    const at = here.current?.querySelector(`:scope > .shape-params > [data-param="${failed.parameter}"]`) ?? here.current;
    at?.scrollIntoView({ block: 'center' });
  }, [failed]);
  const preview = useMemo(() => {
    const ids = nestedIds(set, shape);
    return shapeSetTurtle({ shapes: set.shapes.filter((s) => s.id === shape.id || ids.has(s.id)), extra: '', prefixes: set.prefixes }, { prefixes: { ...modelPrefixes(model), ...set.prefixes } });
  }, [set, shape, model]);

  const start = (local: string) => {
    const info = PARAM.get(SH + local)!;
    // What has a value to start from is added at once; what needs one chosen is asked for first.
    const ready = initial(info);
    if (ready) edits.add(shape.id, { p: SH + local, v: ready.v }, ready.shapes);
    else setAdding(local);
  };

  return (
    <div ref={here} className={'shape-form' + (nested ? ' nested' : '') + (focus === shape.id && nested ? ' focused' : '')} data-shape={shape.id}>
      {!nested && (
        <div className="shape-head">
          <label className="field">
            <span>Shape name</span>
            <CommitInput
              aria-label="Shape name"
              value={label >= 0 ? (shape.props[label].v as { lit: string }).lit : ''}
              placeholder={shapeName(shape)}
              onCommit={(name) =>
                edits.editShape(shape.id, (s) => {
                  const text = name.trim();
                  if (label >= 0) return { ...s, props: text ? s.props.map((x, i) => (i === label ? { ...x, v: { ...(x.v as { lit: string; lang?: string }), lit: text } } : x)) : s.props.filter((_, i) => i !== label) };
                  return text ? { ...s, props: [...s.props, { p: RDFS + 'label', v: { lit: text } }] } : s;
                })
              }
            />
          </label>
          <div className="field">
            <span>{property ? 'Property shape' : 'Node shape'}</span>
            <code title={shape.iri}>{shape.iri ? naming.name(shape.iri) : 'anonymous (a blank node)'}</code>
          </div>
          <button
            className="btn small danger"
            onClick={() => {
              edits.editSet((s) => withoutInline({ ...s, shapes: s.shapes.filter((x) => x.id !== shape.id) }, [...nestedIds(s, shape)]));
              st().openShapes(set.id, null);
            }}
          >
            Delete shape
          </button>
        </div>
      )}
      {failed && (
        <div className="shape-failed" role="note" aria-label="What validation found">
          <p>
            <strong>Not met{failed.parameter ? <> at sh:{failed.parameter}</> : ''}</strong> by <code>{failed.focusNode}</code>
            {failed.line ? `, line ${failed.line} of ${failed.data}` : failed.data ? ` in ${failed.data}` : ''}: {failed.message}
          </p>
          {(failed.path || failed.value) && (
            <p className="muted">
              {failed.path && (
                <>
                  Path <code>{failed.path}</code>
                  {failed.value ? '; ' : '.'}
                </>
              )}
              {failed.value && (
                <>
                  value <code>{failed.value}</code>.
                </>
              )}
            </p>
          )}
          <div className="row">
            <button
              className="link"
              onClick={() => {
                st().setView('checks');
                st().setValidation({ tab: 'results', focus: failed.finding });
              }}
            >
              Back to the finding
            </button>
            <button className="btn icon ghost" aria-label="Close what validation found" title="Close" onClick={() => st().openShapes(set.id, shape.id)}>
              ×
            </button>
          </div>
        </div>
      )}
      {property && <PathField shape={shape} naming={naming} edits={edits} />}
      {GROUPS.map((group) => {
        const here = core.filter((x) => PARAM.get(x.p)!.group === group);
        if (!here.length) return null;
        return (
          <div key={group} className="shape-params" data-group={group}>
            <h4>{group}</h4>
            {here.map((x) => (
              <ParamRow key={x.i} info={PARAM.get(x.p)!} value={x.v} index={x.i} set={set} shape={shape} top={top} model={model} naming={naming} edits={edits} choices={choices} focus={focus} failed={failed?.parameter === PARAM.get(x.p)!.local} />
            ))}
          </div>
        );
      })}
      {adding && (
        <div className="shape-params adding">
          <NewValue info={PARAM.get(SH + adding)!} naming={naming} choices={choices} onDone={(v) => (v && edits.add(shape.id, { p: SH + adding, v }), setAdding(''))} />
        </div>
      )}
      <div className="row wrap">
        <select aria-label={`Add a constraint to ${shapeName(shape)}`} value="" onChange={(e) => e.target.value && start(e.target.value)}>
          <option value="">Add a constraint or target…</option>
          {GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {offered
                .filter((p) => p.group === g)
                .map((p) => (
                  <option key={p.local} value={p.local} title={p.about}>
                    {p.label} (sh:{p.local})
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      {/* A property shape has property shapes of its own only rarely: the list is shown there when it has some. */}
      {(!property || properties.length > 0) && (
        <div className="shape-properties">
          <h4>Property shapes ({properties.length})</h4>
          {properties.map((x) => (
            <ShapeValueField key={x.i} value={x.v} index={x.i} owner={shape} top={top} set={set} model={model} naming={naming} edits={edits} focus={focus} kind="property" />
          ))}
          <AddProperty shape={shape} choices={choices} naming={naming} edits={edits} />
        </div>
      )}
      {other.length > 0 && (
        <div className="shape-params other">
          <h4>Other statements, kept as written</h4>
          {other.map((x) => (
            <div key={x.i} className="param-row">
              <code>
                {x.p === RDF + 'type' ? 'a' : naming.name(x.p)} {valueText(x.v, naming, set)}
              </code>
              <button className="btn icon ghost" aria-label={`Remove ${naming.name(x.p)}`} title="Take this statement away" onClick={() => edits.remove(shape.id, x.i)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {!nested && (
        <details className="shape-turtle">
          <summary>As Turtle</summary>
          <pre className="rdf-code shape-preview">{preview}</pre>
        </details>
      )}
    </div>
  );
}

/** Whether a value is of the kind its parameter takes: what is not is shown as written. */
function fits(info: ParamInfo, v: ShaclValue): boolean {
  switch (info.kind) {
    case 'class':
    case 'property':
    case 'datatype':
    case 'iri':
    case 'nodeKind':
    case 'severity':
      return 'iri' in v;
    case 'count':
      return 'lit' in v && /^\d+$/.test(v.lit);
    case 'boolean':
      return 'lit' in v && /^(true|false)$/.test(v.lit);
    case 'text':
      return 'lit' in v && !v.dt && !v.lang;
    case 'literal':
      return 'lit' in v;
    case 'term':
      return 'iri' in v || 'lit' in v;
    case 'shape':
      return 'shape' in v || 'iri' in v;
    case 'shapes':
      return 'list' in v && v.list.every((x) => 'shape' in x || 'iri' in x);
    case 'terms':
      return 'list' in v && v.list.every((x) => 'iri' in x || 'lit' in x);
    case 'langs':
      return 'list' in v && v.list.every((x) => 'lit' in x);
    case 'properties':
      return 'list' in v && v.list.every((x) => 'iri' in x);
  }
}

/** The value a new parameter starts with, where it can start with one; then nothing needs asking. */
function initial(info: ParamInfo): { v: ShaclValue; shapes: Shape[] } | undefined {
  const lit = (l: string, dt: string) => ({ v: { lit: l, dt: XSD + dt }, shapes: [] });
  switch (info.kind) {
    case 'count':
      return lit(info.local === 'maxCount' || info.local === 'qualifiedMaxCount' ? '1' : info.local.startsWith('min') || info.local.startsWith('qualifiedMin') ? '1' : '0', 'integer');
    case 'boolean':
      return lit('true', 'boolean');
    case 'nodeKind':
      return { v: { iri: SH + 'IRI' }, shapes: [] };
    case 'severity':
      return { v: { iri: SH + 'Warning' }, shapes: [] };
    case 'shape': {
      const s = newInlineShape();
      return { v: { shape: s.id }, shapes: [s] };
    }
    case 'shapes': {
      const a = newInlineShape();
      const b = newInlineShape();
      return { v: { list: [{ shape: a.id }, { shape: b.id }] }, shapes: [a, b] };
    }
    default:
      return undefined;
  }
}

/** A value as Turtle writes it, for what is shown as written. */
function valueText(v: ShaclValue, naming: ShapeNaming, set: ShapeSet): string {
  if ('iri' in v || 'lit' in v) return termToText(v, naming.name);
  if ('list' in v) return `( ${v.list.map((x) => valueText(x, naming, set)).join(' ')} )`;
  if ('path' in v) return pathToSparql(v.path, naming.name);
  if ('ttl' in v) return v.ttl;
  if ('blank' in v) return `_:${v.blank}`;
  const s = set.shapes.find((x) => x.id === v.shape);
  return s ? `[ ${shapeName(s)} ]` : '[]';
}

function ParamRow({ info, value, index, set, shape, top, model, naming, edits, choices, focus, failed = false }: { info: ParamInfo; value: ShaclValue; index: number; set: ShapeSet; shape: Shape; top: Shape; model: Model; naming: ShapeNaming; edits: Edits; choices: ReturnType<typeof useChoices>; focus: string | null; failed?: boolean }) {
  const put = (v: ShaclValue) => edits.setValue(shape.id, index, v);
  const drop = () => edits.remove(shape.id, index);
  const head = (
    <span className="param-name" title={info.about}>
      {info.label} <code className="pred">sh:{info.local}</code>
    </span>
  );
  const removeButton = (
    <button className="btn icon ghost" aria-label={`Remove ${info.label} of ${shapeName(shape)}`} title="Take this away" onClick={drop}>
      ×
    </button>
  );
  if (info.kind === 'shape') return <ShapeValueField value={value} index={index} owner={shape} top={top} set={set} model={model} naming={naming} edits={edits} focus={focus} kind={info.local} failed={failed} />;
  if (info.kind === 'shapes') {
    const list = (value as { list: ShaclValue[] }).list;
    const setList = (next: ShaclValue[], shapes: Shape[] = [], dropped: string[] = []) =>
      edits.editSet((s) => withoutInline({ ...s, shapes: [...s.shapes.map((x) => (x.id === shape.id ? { ...x, props: x.props.map((p, i) => (i === index ? { ...p, v: { list: next } } : p)) } : x)), ...shapes] }, dropped));
    return (
      <fieldset className={'param-shapes' + (failed ? ' failed' : '')} data-param={info.local}>
        <legend>
          {head}
          {removeButton}
        </legend>
        {list.map((member, k) => (
          <div key={k} className="param-member">
            <span className="muted">{k === 0 ? '' : info.local === 'and' ? 'and' : info.local === 'or' ? 'or' : 'or else'}</span>
            <MemberField value={member} top={top} set={set} model={model} naming={naming} edits={edits} focus={focus} onChange={(v, shapes, dropped) => setList(list.map((x, i) => (i === k ? v : x)), shapes, dropped)} onRemove={() => edits.editSet((s) => withoutInline({ ...s, shapes: s.shapes.map((x) => (x.id === shape.id ? { ...x, props: x.props.map((p, i) => (i === index ? { ...p, v: { list: list.filter((_, j) => j !== k) } } : p)) } : x)) }, inlineIn(member)))} />
          </div>
        ))}
        <button
          className="link"
          onClick={() => {
            const s = newInlineShape();
            setList([...list, { shape: s.id }], [s]);
          }}
        >
          Add a shape to {info.label.toLowerCase()}
        </button>
      </fieldset>
    );
  }
  return (
    <div className={'param-row' + (failed ? ' failed' : '')} data-param={info.local}>
      {head}
      <span className="param-value">
        <ValueField info={info} value={value} naming={naming} choices={choices} onChange={put} onRemove={drop} of={shapeName(shape)} />
      </span>
      {removeButton}
    </div>
  );
}

/** A value of one of the kinds a field edits directly. */
function ValueField({ info, value, naming, choices, onChange, onRemove, of }: { info: ParamInfo; value: ShaclValue; naming: ShapeNaming; choices: ReturnType<typeof useChoices>; onChange: (v: ShaclValue) => void; onRemove: () => void; of: string }) {
  const picker = (kind: 'class' | 'property' | 'datatype' | 'individual') => {
    const iri = (value as { iri: string }).iri;
    return (
      <EntityPicker
        values={[{ id: iri, name: naming.label(iri), iri, ...(choices[kind].some((c) => c.id === iri) ? {} : { tag: 'not in this ontology' }) }]}
        max={1}
        options={() => choices[kind]}
        onAdd={(id) => (onChange({ iri: id }), undefined)}
        onRemove={onRemove}
        noun={info.label.toLowerCase()}
        of={of}
        custom={(text) => {
          const resolved = naming.resolve(text);
          return resolved ? { id: resolved, name: naming.name(resolved), iri: resolved } : undefined;
        }}
      />
    );
  };
  switch (info.kind) {
    case 'class':
      return picker('class');
    case 'property':
      return picker('property');
    case 'datatype':
      return picker('datatype');
    case 'count':
      return <CommitInput aria-label={`${info.label} of ${of}`} inputMode="numeric" value={(value as { lit: string }).lit} onCommit={(v) => /^\d+$/.test(v.trim()) && onChange({ lit: v.trim(), dt: XSD + 'integer' })} />;
    case 'boolean':
      return (
        <label className="check">
          <input type="checkbox" checked={(value as { lit: string }).lit === 'true'} onChange={(e) => onChange({ lit: String(e.target.checked), dt: XSD + 'boolean' })} />
          <span>{(value as { lit: string }).lit === 'true' ? 'yes' : 'no'}</span>
        </label>
      );
    case 'nodeKind':
    case 'severity': {
      const options = info.kind === 'nodeKind' ? NODE_KINDS : SEVERITIES;
      const iri = (value as { iri: string }).iri;
      return (
        <select aria-label={`${info.label} of ${of}`} value={iri} onChange={(e) => onChange({ iri: e.target.value })}>
          {!options.some((o) => SH + o === iri) && <option value={iri}>{naming.name(iri)}</option>}
          {options.map((o) => (
            <option key={o} value={SH + o}>
              sh:{o}
            </option>
          ))}
        </select>
      );
    }
    case 'text':
      return <CommitInput aria-label={`${info.label} of ${of}`} value={(value as { lit: string }).lit} onCommit={(v) => onChange({ lit: v })} />;
    case 'terms':
    case 'langs':
    case 'properties':
      return <ListField info={info} value={value as { list: ShaclValue[] }} naming={naming} onChange={onChange} of={of} />;
    default:
      return <TermField label={`${info.label} of ${of}`} value={value as ShaclTerm} naming={naming} onChange={onChange} literal={info.kind === 'literal'} />;
  }
}

/** One term written as Turtle writes it: a name, <IRI>, "text", "text"@en, 18, true. */
function TermField({ label, value, naming, onChange, literal }: { label: string; value: ShaclTerm; naming: ShapeNaming; onChange: (v: ShaclTerm) => void; literal?: boolean }) {
  const [problem, setProblem] = useState('');
  return (
    <>
      <CommitInput
        aria-label={label}
        value={termToText(value, naming.name)}
        onCommit={(text) => {
          try {
            const t = termFromText(text, naming.resolve);
            if (literal && 'iri' in t) throw new Error('A literal is wanted here: "text", 18, true…');
            setProblem('');
            onChange(t);
          } catch (e) {
            setProblem(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      {problem && (
        <small className="bad" role="alert">
          {problem}
        </small>
      )}
    </>
  );
}

/** A list of terms (sh:in), language tags (sh:languageIn) or properties (sh:ignoredProperties), written one after another. */
function ListField({ info, value, naming, onChange, of }: { info: ParamInfo; value: { list: ShaclValue[] }; naming: ShapeNaming; onChange: (v: ShaclValue) => void; of: string }) {
  const [problem, setProblem] = useState('');
  const text = info.kind === 'langs' ? value.list.map((x) => (x as { lit: string }).lit).join(', ') : value.list.map((x) => termToText(x as ShaclTerm, naming.name)).join(' ');
  return (
    <>
      <CommitInput
        aria-label={`${info.label} of ${of}`}
        value={text}
        placeholder={info.kind === 'langs' ? 'en, nl' : info.kind === 'properties' ? 'rdf:type ex:p' : 'ex:a "b" 3'}
        onCommit={(t) => {
          try {
            const items =
              info.kind === 'langs'
                ? t.split(/[\s,]+/).filter(Boolean).map((l): ShaclValue => ({ lit: l }))
                : [...t.matchAll(/"(?:[^"\\]|\\.)*"(?:@[\w-]+|\^\^\S+)?|<[^>]*>|\S+/g)].map((m) => {
                    const term = termFromText(m[0], naming.resolve);
                    if (info.kind === 'properties' && !('iri' in term)) throw new Error(`“${m[0]}” is not a property.`);
                    return term;
                  });
            setProblem('');
            onChange({ list: items });
          } catch (e) {
            setProblem(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      {problem && (
        <small className="bad" role="alert">
          {problem}
        </small>
      )}
    </>
  );
}

/** What a new value is, asked for before it is added: for parameters with no value to start from. */
function NewValue({ info, naming, choices, onDone }: { info: ParamInfo; naming: ShapeNaming; choices: ReturnType<typeof useChoices>; onDone: (v: ShaclValue | undefined) => void }) {
  const [problem, setProblem] = useState('');
  const pickable = info.kind === 'class' || info.kind === 'property' || info.kind === 'datatype' || (info.kind === 'term' && info.local === 'targetNode');
  return (
    <div className="param-row" data-param={info.local}>
      <span className="param-name" title={info.about}>
        {info.label} <code className="pred">sh:{info.local}</code>
      </span>
      <span className="param-value">
        {pickable ? (
          <EntityPicker
            values={[]}
            options={() => choices[info.kind === 'term' ? 'individual' : (info.kind as 'class' | 'property' | 'datatype')]}
            onAdd={(id) => (onDone({ iri: id }), undefined)}
            onRemove={() => undefined}
            noun={info.label.toLowerCase()}
            of=""
            empty="choose…"
            custom={(text) => {
              const resolved = naming.resolve(text);
              return resolved ? { id: resolved, name: naming.name(resolved), iri: resolved } : undefined;
            }}
          />
        ) : (
          <input
            autoFocus
            aria-label={`New ${info.label}`}
            placeholder={info.kind === 'langs' ? 'en, nl' : info.kind === 'terms' || info.kind === 'properties' ? 'one after another' : info.kind === 'text' ? 'text' : '"text", 18, true, or a name'}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onDone(undefined);
              if (e.key !== 'Enter') return;
              const text = e.currentTarget.value;
              try {
                if (info.kind === 'text') return onDone({ lit: text });
                if (info.kind === 'langs') return onDone({ list: text.split(/[\s,]+/).filter(Boolean).map((l) => ({ lit: l })) });
                if (info.kind === 'terms' || info.kind === 'properties') return onDone({ list: [...text.matchAll(/"(?:[^"\\]|\\.)*"(?:@[\w-]+|\^\^\S+)?|<[^>]*>|\S+/g)].map((m) => termFromText(m[0], naming.resolve)) });
                onDone(termFromText(text, naming.resolve));
              } catch (err) {
                setProblem(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        )}
        {problem && (
          <small className="bad" role="alert">
            {problem}
          </small>
        )}
      </span>
      <button className="btn icon ghost" aria-label="Cancel" onClick={() => onDone(undefined)}>
        ×
      </button>
    </div>
  );
}

/** The path of a property shape, written as SPARQL writes paths: ex:a / ^ex:b, ex:a | ex:b, ex:p*. */
function PathField({ shape, naming, edits }: { shape: Shape; naming: ShapeNaming; edits: Edits }) {
  const [problem, setProblem] = useState('');
  const index = shape.props.findIndex((x) => x.p === SH + 'path');
  const path = pathOf(shape)!;
  return (
    <div className="param-row path" data-param="path">
      <span className="param-name" title="Where the values of the property shape are reached from the focus node: a property, its inverse (^), one after another (/), either (|), any number (*), at least one (+), at most one (?).">
        Path <code className="pred">sh:path</code>
      </span>
      <span className="param-value">
        <CommitInput
          aria-label="Path"
          value={pathToSparql(path, naming.name)}
          onCommit={(text) => {
            try {
              const p = sparqlToPath(text, naming.resolve);
              setProblem('');
              edits.setValue(shape.id, index, { path: p });
            } catch (e) {
              setProblem(e instanceof Error ? e.message : String(e));
            }
          }}
        />
        {problem && (
          <small className="bad" role="alert">
            {problem}
          </small>
        )}
      </span>
    </div>
  );
}

/** A shape that is a value: a named shape, by IRI, or one written in place, edited where it is. */
function ShapeValueField({ value, index, owner, top, set, model, naming, edits, focus, kind, failed = false }: { value: ShaclValue; index: number; owner: Shape; top: Shape; set: ShapeSet; model: Model; naming: ShapeNaming; edits: Edits; focus: string | null; kind: string; failed?: boolean }) {
  const info = PARAM.get(SH + kind)!;
  const inner = 'shape' in value ? set.shapes.find((s) => s.id === value.shape) : undefined;
  return (
    <fieldset className={'param-shape' + (kind === 'property' ? ' property' : '') + (failed ? ' failed' : '')} data-param={kind}>
      <legend>
        <span className="param-name" title={info.about}>
          {kind === 'property' ? (inner && isPropertyShape(inner) ? pathToSparql(pathOf(inner)!, naming.label) : 'Property shape') : info.label} <code className="pred">sh:{kind}</code>
        </span>
        <button className="btn icon ghost" aria-label={`Remove ${kind === 'property' && inner && isPropertyShape(inner) ? `the property shape ${pathToSparql(pathOf(inner)!, naming.label)}` : info.label} of ${shapeName(owner)}`} title="Take this away" onClick={() => edits.remove(owner.id, index)}>
          ×
        </button>
      </legend>
      <MemberField
        value={value}
        top={top}
        set={set}
        model={model}
        naming={naming}
        edits={edits}
        focus={focus}
        onChange={(v, shapes, dropped = []) => edits.editSet((s) => withoutInline({ ...s, shapes: [...s.shapes.map((x) => (x.id === owner.id ? { ...x, props: x.props.map((p, i) => (i === index ? { ...p, v } : p)) } : x)), ...shapes] }, dropped))}
      />
    </fieldset>
  );
}

/** A shape as a value: a named one (any set's, by IRI), or one in place, with its own form. */
function MemberField({ value, top, set, model, naming, edits, focus, onChange, onRemove }: { value: ShaclValue; top: Shape; set: ShapeSet; model: Model; naming: ShapeNaming; edits: Edits; focus: string | null; onChange: (v: ShaclValue, shapes: Shape[], dropped?: string[]) => void; onRemove?: () => void }) {
  const st = useStore.getState;
  // The shape being edited is not offered inside itself: SHACL leaves a shape that refers to itself undefined.
  const named = useMemo(
    () => model.shapeSets.flatMap((s) => s.shapes.filter((x) => x.iri && x.id !== top.id).map((x) => ({ id: x.iri!, name: shapeName(x), iri: x.iri, tag: s.id === set.id ? naming.name(x.iri!) : `${s.name} · ${naming.name(x.iri!)}` }))),
    [model, set, top, naming],
  );
  // A shape is named by its IRI: a prefixed name or <IRI> typed is taken, not the name of an entity of the ontology.
  const shapeIri = (text: string) => {
    const t = text.trim();
    const resolved = t.startsWith('<') || t.includes(':') ? naming.resolve(t) : undefined;
    return resolved ? { id: resolved, name: naming.name(resolved), iri: resolved } : undefined;
  };
  const remove = onRemove && (
    <button className="btn icon ghost" aria-label="Remove this shape" title="Take this shape away" onClick={onRemove}>
      ×
    </button>
  );
  if ('shape' in value) {
    const inner = set.shapes.find((s) => s.id === value.shape);
    return (
      <div className="member">
        {remove}
        <div className="member-body">
          {inner ? <ShapeForm set={set} shape={inner} top={top} model={model} naming={naming} edits={edits} focus={focus} nested /> : <span className="muted">A shape that is no longer there.</span>}
          {/* Written in place, or a shape of its own, named, that others can use too. */}
          {inner && !isPropertyShape(inner) && (
            <EntityPicker
              values={[]}
              options={() => named}
              onAdd={(iri) => (onChange({ iri }, [], [value.shape]), undefined)}
              onRemove={() => undefined}
              noun="named shape"
              of=""
              addLabel="Refer to a named shape instead"
              searchLabel="Search for a named shape"
              empty="or refer to a named shape"
              custom={shapeIri}
            />
          )}
        </div>
      </div>
    );
  }
  if ('iri' in value) {
    const found = model.shapeSets.flatMap((s) => s.shapes.map((x) => ({ s, x }))).find(({ x }) => x.iri === value.iri);
    return (
      <div className="member named">
        <EntityPicker
          values={[{ id: value.iri, name: found ? shapeName(found.x) : naming.name(value.iri), iri: value.iri, ...(found ? {} : { tag: 'not a shape here' }) }]}
          max={1}
          options={() => named}
          onAdd={(id) => (onChange({ iri: id }, []), undefined)}
          onRemove={() => {
            const s = newInlineShape();
            onChange({ shape: s.id }, [s]);
          }}
          onOpen={() => found && st().openShapes(found.s.id, found.x.id)}
          noun="named shape"
          of=""
          custom={shapeIri}
        />
        {remove}
      </div>
    );
  }
  return (
    <div className="member">
      <code>{valueText(value, naming, set)}</code>
      {remove}
    </div>
  );
}

/** Adds a property shape: on a property, written in place; or a named property shape, by IRI. */
function AddProperty({ shape, choices, naming, edits }: { shape: Shape; choices: ReturnType<typeof useChoices>; naming: ShapeNaming; edits: Edits }) {
  return (
    <div className="add-property">
      <EntityPicker
        values={[]}
        options={() => choices.property}
        onAdd={(iri) => {
          const p = newPropertyShape(iri);
          edits.add(shape.id, { p: SH + 'property', v: { shape: p.id } }, [p]);
          return undefined;
        }}
        onRemove={() => undefined}
        noun="property shape"
        of={shapeName(shape)}
        addLabel="Add a property shape"
        searchLabel="Search for a property to constrain"
        empty="Add a property shape"
        custom={(text) => {
          const resolved = naming.resolve(text);
          return resolved ? { id: resolved, name: naming.name(resolved), iri: resolved } : undefined;
        }}
      />
    </div>
  );
}

/** What the set says about no shape, kept as written; shapes written here become shapes of the set when saved. */
function KeptText({ set, edits }: { set: ShapeSet; edits: Edits }) {
  const st = useStore.getState;
  const [text, setText] = useState(set.extra);
  const [seen, setSeen] = useState(set.extra);
  // Undo, or an import, changes it under the editor: take the new text.
  if (set.extra !== seen) {
    setSeen(set.extra);
    setText(set.extra);
  }
  const problem = useMemo(() => turtleProblem(text), [text]);
  const changed = text !== set.extra;
  return (
    <>
      <h3>Turtle kept as written</h3>
      <p className="muted">What the set says that is about no shape (data, property groups, an ontology) is kept here as it was read, and written back with the set. Shapes written here become shapes of the set when the text is saved, each with its own form.</p>
      <textarea
        className="shapes-text"
        aria-label="Turtle kept as written"
        spellCheck={false}
        rows={18}
        value={text}
        placeholder={'@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix : <…> .\n\n:EitherShape a sh:NodeShape ;\n    sh:targetClass :Person ;\n    sh:or ( [ sh:path :hasName ; sh:minCount 1 ] [ sh:path :hasNickname ; sh:minCount 1 ] ) .'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {problem && (
        <p className="bad" role="alert">
          Not valid Turtle, so it cannot be saved yet: {problem}
        </p>
      )}
      <div className="row">
        <button
          className="btn small primary"
          disabled={!changed || !!problem}
          onClick={() => {
            const got = importIntoSet({ ...set, extra: '' }, text);
            edits.editSet(() => got.set);
            if (got.shapes) st().notify(`${got.shapes} shape${got.shapes === 1 ? '' : 's'} read from the text into the set, each with its own form.`);
          }}
        >
          Save the Turtle
        </button>
        <button className="btn small" disabled={!changed} onClick={() => setText(set.extra)}>
          Discard changes
        </button>
      </div>
    </>
  );
}

/** For the class and property editors: the shapes, in every set, that are about the entity, and for a class a new one. */
export function ShapesAbout({ iri, name, isClass }: { iri: string | undefined; name: string; isClass: boolean }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const about = useMemo(() => (iri ? shapesAbout(model, iri) : []), [model, iri]);
  if (!iri) return null;
  const add = () => {
    const at = useStore.getState().shapesView.set;
    const set = model.shapeSets.find((s) => s.id === at) ?? model.shapeSets[0];
    if (set) {
      const shape = newNodeShape(model, set, name, iri);
      st().setShapeSets((all) => all.map((s) => (s.id === set.id ? { ...s, shapes: [...s.shapes, shape] } : s)));
      st().openShapes(set.id, shape.id);
    } else {
      const made = newSetFor('Shapes');
      const shape = newNodeShape({ ...model, shapeSets: [made] }, made, name, iri);
      st().setShapeSets((all) => [...all, { ...made, shapes: [shape] }]);
      st().openShapes(made.id, shape.id);
    }
  };
  return (
    <Section id="shapes" title="SHACL shapes" count={about.length}>
      {!about.length && <p className="muted">{isClass ? 'No shape targets this class. A shape says what data about its instances must contain to be accepted.' : 'No shape constrains this property.'}</p>}
      {about.length > 0 && (
        <ul>
          {about.map(({ set, shape, how }) => (
            <li key={set.id + shape.id + how}>
              <button className="link" onClick={() => st().openShapes(set.id, shape.id)}>
                {shapeName(shape)}
              </button>{' '}
              <span className="muted">
                {how}, in “{set.name}”
              </span>
            </li>
          ))}
        </ul>
      )}
      {isClass && (
        <button className="btn small" onClick={add}>
          Add a shape for this class
        </button>
      )}
    </Section>
  );
}
