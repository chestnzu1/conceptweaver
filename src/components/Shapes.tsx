import { useMemo, useRef, useState } from 'react';
import { download } from '../model/files';
import { compactIri, expandIri, isAbsoluteIri } from '../model/prefixes';
import { objectProperties } from '../model/props';
import { EDITOR_FEATURES, extraSummary, importShapes, newPropertyShape, newShape, shapesToTurtle, turtleProblem } from '../model/shapes';
import { stable } from '../model/stable';
import { useStore } from '../model/store';
import { DATATYPES, NODE_KINDS, type Model, type PropertyShape, type ShaclSeverity, type ShapeDef, type Shapes, type ShapeValue } from '../model/types';
import { EntityPicker, type Choice } from './EntityPicker';
import { CommitInput } from './fields';

/**
 * The SHACL shapes of the model: a list, and for the selected shape a form that writes the
 * SHACL for you. Shapes name classes and properties by IRI, so they also work for data that
 * uses a vocabulary the ontology does not have.
 */

type Kind = 'class' | 'individual' | 'property';

/** Entities of the model as choices whose identity is their IRI. */
function useIriChoices(model: Model) {
  return useMemo(() => {
    const by = new Map<string, Choice>();
    const of: Record<Kind, Choice[]> = { class: [], individual: [], property: [] };
    const put = (kind: Kind, iri: string | undefined, name: string) => {
      if (!iri) return;
      const c = { id: iri, name: name || 'Unnamed', iri };
      by.set(iri, c);
      of[kind].push(c);
    };
    for (const t of model.terms) put(t.type === 'concept' ? 'class' : t.type === 'instance' ? 'individual' : 'property', t.iri, t.name);
    if (model.mode !== 'skos') for (const p of objectProperties(model)) put('property', p.iri, p.name);
    return { by, of };
  }, [model]);
}

const SEVERITIES: ShaclSeverity[] = ['Violation', 'Warning', 'Info'];

/** A whole number from a text box, or undefined when it is empty or not one. */
const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

export function ShapesPanel() {
  const model = stable(useStore((s) => s.model));
  const shapeId = useStore((s) => s.validation.shapeId);
  const st = useStore.getState;
  const fileRef = useRef<HTMLInputElement>(null);
  const { by, of } = useIriChoices(model);
  const shapes = model.shapes;
  const selected = shapes.nodes.find((s) => s.id === shapeId);
  const showText = shapeId === 'text';
  const extra = useMemo(() => extraSummary(shapes.extra), [shapes.extra]);

  const open = (id: string | null) => st().setValidation({ shapeId: id });
  const update = (id: string, patch: Partial<ShapeDef>) => st().setShapes((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  const add = () => {
    // Started from the selected class, if one is selected: the commonest shape says what its instances must have.
    const sel = st().sel.terms.map((id) => model.terms.find((t) => t.id === id)).find((t) => t?.type === 'concept' && t.iri);
    const shape = newShape(model, sel ? sel.name : 'New shape', sel?.iri);
    st().setShapes((s) => ({ ...s, nodes: [...s.nodes, shape] }));
    open(shape.id);
  };
  const importFile = async (file: File) => {
    try {
      const got = importShapes(st().model, await file.text());
      if (!got.editable && !got.kept) return st().notify(`No SHACL shapes found in ${file.name}.`);
      st().setShapes(() => got.shapes);
      st().notify(`Imported from ${file.name}: ${got.editable} shape${got.editable === 1 ? '' : 's'} you can edit here${got.kept ? `, ${got.kept} kept as Turtle (${got.reasons[0]}${got.reasons.length > 1 ? '…' : ''})` : ''}.`);
      if (got.kept && !got.editable) open('text');
    } catch (e) {
      st().notify(`Could not read ${file.name}: ${e instanceof Error ? e.message : 'not valid Turtle'}`);
    }
  };

  return (
    <div className="shapes">
      <aside className="shape-list" aria-label="Shapes">
        <div className="row wrap">
          <button className="btn small primary" onClick={add}>
            New shape
          </button>
          <button className="btn small" onClick={() => fileRef.current?.click()}>
            Import…
          </button>
          <button className="btn small" disabled={!shapes.nodes.length && !shapes.extra.trim()} onClick={() => download(`${model.name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase() || 'model'}-shapes.ttl`, shapesToTurtle(model), 'text/turtle')}>
            Export
          </button>
        </div>
        <ul>
          {shapes.nodes.map((s) => (
            <li key={s.id}>
              <button className={shapeId === s.id ? 'on' : ''} aria-current={shapeId === s.id} onClick={() => open(s.id)}>
                <strong>{s.name || 'Shape'}</strong>
                {s.deactivated && <span className="tag auto">off</span>}
                <span className="muted">
                  {s.targetClass.length ? s.targetClass.map((c) => by.get(c)?.name ?? compactIri(model, c) ?? c).join(', ') : s.targetNode.length + s.targetSubjectsOf.length + s.targetObjectsOf.length ? 'other targets' : 'no target yet'} · {s.properties.length} propert{s.properties.length === 1 ? 'y' : 'ies'}
                </span>
              </button>
            </li>
          ))}
          <li>
            <button className={showText ? 'on' : ''} aria-current={showText} onClick={() => open('text')}>
              <strong>Shapes as Turtle</strong>
              <span className="muted">{extra.triples ? `${extra.shapes} shape${extra.shapes === 1 ? '' : 's'} kept as written` : 'for what the form cannot say'}</span>
            </button>
          </li>
        </ul>
        {!shapes.nodes.length && !shapes.extra.trim() && <p className="muted">No shapes yet. A shape says what data must contain: “every Person has exactly one name”.</p>}
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
      </aside>
      <div className="shape-editor">
        {selected && <ShapeEditor key={selected.id} shape={selected} model={model} by={by} of={of} update={(patch) => update(selected.id, patch)} />}
        {showText && <ShapesText shapes={shapes} />}
        {!selected && !showText && (
          <div className="muted pad">
            <p>Choose a shape, or make a new one.</p>
            <p>
              Shapes are kept with the model but apart from the ontology: they are not part of its OWL export, and OWL restrictions are not turned into shapes. A restriction says what follows about a class’s members; a shape says what data must contain to be accepted.
            </p>
            <details>
              <summary>What the form covers</summary>
              <p>Targets: {EDITOR_FEATURES.targets.join(', ')}.</p>
              <p>Paths: {EDITOR_FEATURES.paths.join(', ')}.</p>
              <p>Constraints: {EDITOR_FEATURES.constraints.join(', ')}.</p>
              <p>Anything else in SHACL Core (sh:or, sh:and, sh:not, sh:xone, qualified value shapes, property pairs, other paths) can be written or imported as Turtle and is validated all the same.</p>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

function ShapeEditor({ shape, model, by, of, update }: { shape: ShapeDef; model: Model; by: Map<string, Choice>; of: Record<Kind, Choice[]>; update: (patch: Partial<ShapeDef>) => void }) {
  const st = useStore.getState;
  const asChoice = (iri: string): Choice => by.get(iri) ?? { id: iri, name: compactIri(model, iri) ?? iri, iri, tag: 'not in this ontology' };
  // An IRI typed in full, or with a prefix the ontology knows, can be used even if no entity has it.
  const custom = (text: string): Choice | undefined => {
    const iri = text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : (expandIri(model, text) ?? text);
    return isAbsoluteIri(iri) && /^[a-z][a-z0-9+.-]*:\/\//i.test(iri) ? { id: iri, name: compactIri(model, iri) ?? iri, iri } : undefined;
  };
  const targets = (field: 'targetClass' | 'targetNode' | 'targetSubjectsOf' | 'targetObjectsOf', label: string, kind: Kind, noun: string, hint: string) => (
    <div className="field">
      <span title={hint}>
        {label} <code className="pred">sh:{field}</code>
      </span>
      <EntityPicker values={shape[field].map(asChoice)} options={() => of[kind]} onAdd={(iri) => update({ [field]: [...shape[field], iri] })} onRemove={(iri) => update({ [field]: shape[field].filter((x) => x !== iri) })} noun={noun} of={shape.name} custom={custom} empty="none" />
    </div>
  );
  const setProp = (id: string, patch: Partial<PropertyShape>) => update({ properties: shape.properties.map((p) => (p.id === id ? clean({ ...p, ...patch }) : p)) });
  const noTarget = !shape.targetClass.length && !shape.targetNode.length && !shape.targetSubjectsOf.length && !shape.targetObjectsOf.length;
  const preview = useMemo(() => shapesToTurtle(model, { nodes: [shape], extra: '' }), [model, shape]);

  return (
    <>
      <div className="shape-head">
        <label className="field">
          <span>Shape name</span>
          <CommitInput aria-label="Shape name" value={shape.name} onCommit={(name) => update({ name: name.trim() })} />
        </label>
        <div className="field">
          <span>IRI</span>
          <code title={shape.iri}>{compactIri(model, shape.iri) ?? shape.iri}</code>
        </div>
        <label className="field">
          <span>Severity</span>
          <select aria-label="Shape severity" value={shape.severity ?? ''} onChange={(e) => update({ severity: (e.target.value || undefined) as ShaclSeverity | undefined })}>
            <option value="">Violation (default)</option>
            <option value="Warning">Warning</option>
            <option value="Info">Info</option>
          </select>
        </label>
        <button
          className="btn small danger"
          onClick={() => {
            st().setShapes((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== shape.id) }));
            st().setValidation({ shapeId: null });
          }}
        >
          Delete shape
        </button>
      </div>
      <div className="shape-targets">
        {targets('targetClass', 'Target classes', 'class', 'target class', 'Every instance of the class, and of its subclasses, must conform')}
        {targets('targetNode', 'Target nodes', 'individual', 'target node', 'These particular individuals must conform')}
        {targets('targetSubjectsOf', 'Subjects of', 'property', 'property', 'Everything that has this property must conform')}
        {targets('targetObjectsOf', 'Objects of', 'property', 'property', 'Everything that is a value of this property must conform')}
      </div>
      {noTarget && <p className="bad">This shape has no target, so it is checked against nothing. Add a target class, or use it from another shape with sh:node.</p>}
      <div className="row wrap">
        <label className="check" title="Only the properties listed below (and rdf:type) are allowed on a conforming node (sh:closed).">
          <input type="checkbox" checked={!!shape.closed} onChange={(e) => update({ closed: e.target.checked || undefined })} />
          <span>Closed: no other properties allowed</span>
        </label>
        <label className="check" title="Kept, but not validated (sh:deactivated).">
          <input type="checkbox" checked={!!shape.deactivated} onChange={(e) => update({ deactivated: e.target.checked || undefined })} />
          <span>Switched off</span>
        </label>
      </div>

      <h3>Property constraints ({shape.properties.length})</h3>
      {shape.properties.map((p) => (
        <PropertyCard key={p.id} p={p} model={model} of={of} asChoice={asChoice} custom={custom} set={(patch) => setProp(p.id, patch)} remove={() => update({ properties: shape.properties.filter((x) => x.id !== p.id) })} />
      ))}
      <button className="btn small" onClick={() => update({ properties: [...shape.properties, newPropertyShape()] })}>
        Add a property constraint
      </button>

      <h3>The SHACL this shape is</h3>
      <pre className="rdf-code shape-preview" aria-label="Generated SHACL">
        {preview || '# Nothing yet.'}
      </pre>
    </>
  );
}

/** Drops fields that were emptied, so that the shape holds only what it constrains. */
function clean(p: PropertyShape): PropertyShape {
  const out = { ...p } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) delete out[k];
  return { ...(out as unknown as PropertyShape), id: p.id, path: p.path };
}

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function PropertyCard({ p, model, of, asChoice, custom, set, remove }: { p: PropertyShape; model: Model; of: Record<Kind, Choice[]>; asChoice: (iri: string) => Choice; custom: (text: string) => Choice | undefined; set: (patch: Partial<PropertyShape>) => void; remove: () => void }) {
  const name = p.path ? asChoice(p.path).name : 'a property';
  // A bound is a literal of the constraint's datatype; without one, a number is taken as a number.
  const bound = (text: string): ShapeValue | undefined => {
    const v = text.trim();
    if (!v) return undefined;
    const dt = p.datatype && p.datatype !== 'xsd:string' ? p.datatype : /^[+-]?\d+$/.test(v) ? 'xsd:integer' : NUMERIC.test(v) ? 'xsd:decimal' : undefined;
    return { v, ...(dt ? { dt } : {}) };
  };
  // Allowed values: an IRI (in <>, in full, or with a known prefix) is an entity; anything else is a literal.
  const parseValues = (text: string): ShapeValue[] =>
    text
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x): ShapeValue => {
        const quoted = /^".*"$/.test(x);
        const iri = quoted ? undefined : x.startsWith('<') && x.endsWith('>') ? x.slice(1, -1) : (/^[A-Za-z][\w-]*:|^:/.test(x) ? expandIri(model, x) : undefined) ?? (/^https?:\/\//.test(x) ? x : undefined);
        if (iri && isAbsoluteIri(iri)) return { v: iri, iri: true };
        const v = quoted ? x.slice(1, -1) : x;
        return bound(v)?.dt && !quoted ? { v, dt: bound(v)!.dt } : { v };
      });
  const showValues = (vs?: ShapeValue[]) => (vs ?? []).map((v) => (v.iri ? (compactIri(model, v.v) ?? `<${v.v}>`) : v.dt || !/[,:]/.test(v.v) ? v.v : `"${v.v}"`)).join(', ');
  const num = (key: 'minCount' | 'maxCount' | 'minLength' | 'maxLength', label: string) => (
    <label>
      <span>{label}</span>
      <CommitInput aria-label={`${label} of ${name}`} inputMode="numeric" value={p[key] === undefined ? '' : String(p[key])} placeholder="—" onCommit={(v) => set({ [key]: whole(v) })} />
    </label>
  );
  const range = (key: 'minInclusive' | 'maxInclusive' | 'minExclusive' | 'maxExclusive', label: string) => (
    <label>
      <span>{label}</span>
      <CommitInput aria-label={`${label} of ${name}`} value={p[key]?.v ?? ''} placeholder="—" onCommit={(v) => set({ [key]: bound(v) })} />
    </label>
  );
  const problems: string[] = [];
  if (!p.path) problems.push('Choose the property this constrains. Until then it is not part of the shape.');
  if (p.minCount !== undefined && p.maxCount !== undefined && p.minCount > p.maxCount) problems.push(`At least ${p.minCount} and at most ${p.maxCount}: no data can satisfy both.`);
  if (p.datatype && p.class) problems.push('A datatype and a class together: a value cannot be both a literal and an instance of a class.');
  if (p.datatype && p.nodeKind && !p.nodeKind.includes('Literal')) problems.push(`A datatype with node kind ${p.nodeKind}: only a literal has a datatype.`);
  if (p.pattern) {
    try {
      new RegExp(p.pattern);
    } catch {
      problems.push('The pattern is not a valid regular expression.');
    }
  }
  const knownType = p.datatype ? DATATYPES.some((d) => d.id === p.datatype) : true;
  return (
    <fieldset className="shape-prop">
      <legend>{p.path ? `${p.inverse ? 'inverse of ' : ''}${name}` : 'New constraint'}</legend>
      <div className="shape-prop-head">
        <div className="field">
          <span>
            Property <code className="pred">sh:path</code>
          </span>
          <EntityPicker values={p.path ? [asChoice(p.path)] : []} options={() => of.property} onAdd={(iri) => set({ path: iri })} onRemove={() => set({ path: '' })} noun="property" of="this constraint" addLabel="Choose the property" searchLabel="Search for a property" custom={custom} empty="choose…" max={1} />
        </div>
        <label className="check" title="Follow the property backwards: constrain the things that have this node as a value (sh:inversePath).">
          <input type="checkbox" checked={!!p.inverse} onChange={(e) => set({ inverse: e.target.checked || undefined })} />
          <span>Inverse</span>
        </label>
        <button className="btn icon ghost" title="Remove this constraint" aria-label={`Remove the constraint on ${name}`} onClick={remove}>
          ×
        </button>
      </div>
      <div className="shape-grid">
        {num('minCount', 'Minimum count')}
        {num('maxCount', 'Maximum count')}
        <label>
          <span>Datatype</span>
          <select aria-label={`Datatype of ${name}`} value={p.datatype ?? ''} onChange={(e) => set({ datatype: e.target.value || undefined })}>
            <option value="">—</option>
            {!knownType && <option value={p.datatype}>{p.datatype}</option>}
            {DATATYPES.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Node kind</span>
          <select aria-label={`Node kind of ${name}`} value={p.nodeKind ?? ''} onChange={(e) => set({ nodeKind: (e.target.value || undefined) as PropertyShape['nodeKind'] })}>
            <option value="">—</option>
            {NODE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <div className="field wide">
          <span>
            Class of the values <code className="pred">sh:class</code>
          </span>
          <EntityPicker values={p.class ? [asChoice(p.class)] : []} options={() => of.class} onAdd={(iri) => set({ class: iri })} onRemove={() => set({ class: undefined })} noun="class" of={`the values of ${name}`} addLabel="Choose a class" searchLabel="Search for a class" custom={custom} empty="—" max={1} />
        </div>
        {range('minInclusive', 'Minimum inclusive')}
        {range('maxInclusive', 'Maximum inclusive')}
        {range('minExclusive', 'Minimum exclusive')}
        {range('maxExclusive', 'Maximum exclusive')}
        {num('minLength', 'Minimum length')}
        {num('maxLength', 'Maximum length')}
        <label className="wide">
          <span>
            Pattern <code className="pred">sh:pattern</code>
          </span>
          <CommitInput aria-label={`Pattern of ${name}`} value={p.pattern ?? ''} placeholder="a regular expression, e.g. ^[A-Z]{2}\d+$" onCommit={(v) => set({ pattern: v.trim() || undefined })} />
        </label>
        <label className="wide">
          <span>
            Allowed values <code className="pred">sh:in</code>
          </span>
          <CommitInput aria-label={`Allowed values of ${name}`} value={showValues(p.in)} placeholder="comma-separated: draft, final  or  :Red, :Green" onCommit={(v) => set({ in: parseValues(v) })} />
        </label>
        <label>
          <span>Severity</span>
          <select aria-label={`Severity of ${name}`} value={p.severity ?? ''} onChange={(e) => set({ severity: (e.target.value || undefined) as ShaclSeverity | undefined })}>
            <option value="">as the shape</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="No two values may be in the same language (sh:uniqueLang).">
          <input type="checkbox" checked={!!p.uniqueLang} onChange={(e) => set({ uniqueLang: e.target.checked || undefined })} />
          <span>One value per language</span>
        </label>
        <label className="wide">
          <span>
            Message <code className="pred">sh:message</code>
          </span>
          <CommitInput aria-label={`Message of ${name}`} value={p.message ?? ''} placeholder="shown when the data does not conform; otherwise the engine’s own wording" onCommit={(v) => set({ message: v.trim() || undefined })} />
        </label>
      </div>
      {(p.hasValue || p.languageIn?.length || p.node) && (
        <small className="muted">
          Also, from an import: {[p.hasValue && 'sh:hasValue', p.languageIn?.length && `sh:languageIn (${p.languageIn.join(', ')})`, p.node && `sh:node ${compactIri(model, p.node) ?? p.node}`].filter(Boolean).join(', ')}. Kept and validated; there is no field for it here.
        </small>
      )}
      {problems.map((x) => (
        <small key={x} className="bad" role="alert">
          {x}
        </small>
      ))}
    </fieldset>
  );
}

/** Shapes kept as Turtle: what an import had that the form has no field for, or what the user writes by hand. */
function ShapesText({ shapes }: { shapes: Shapes }) {
  const st = useStore.getState;
  const [text, setText] = useState(shapes.extra);
  const [seen, setSeen] = useState(shapes.extra);
  // Undo, or an import, changes it under the editor: take the new text.
  if (shapes.extra !== seen) {
    setSeen(shapes.extra);
    setText(shapes.extra);
  }
  const problem = useMemo(() => turtleProblem(text), [text]);
  const changed = text !== shapes.extra;
  return (
    <>
      <h3>Shapes as Turtle</h3>
      <p className="muted">
        For SHACL the form has no fields for: sh:or, sh:and, sh:not, sh:xone, qualified value shapes, property pairs such as sh:equals and sh:lessThan, sequence and alternative paths. Imported shapes that use them are kept here exactly as written. They are validated together with the shapes made in the form.
      </p>
      <textarea
        className="shapes-text"
        aria-label="Shapes as Turtle"
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
        <button className="btn small primary" disabled={!changed || !!problem} onClick={() => st().setShapes((s) => ({ ...s, extra: text.trim() ? text.trim() + '\n' : '' }))}>
          Save the Turtle
        </button>
        <button className="btn small" disabled={!changed} onClick={() => setText(shapes.extra)}>
          Discard changes
        </button>
      </div>
    </>
  );
}
