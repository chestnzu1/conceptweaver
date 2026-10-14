import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { checkExpression, type ExpressionIssue } from '../model/expressionCheck';
import { addOperand, draftText, fromDraft, hasFiller, hole, isCounted, isRestriction, removeNode, toDraft, unwrapNode, updateNode, withKind, withProperty, wrapNode, type DraftKind, type DraftNode, type Problem, type Sort } from '../model/expressionDraft';
import { OWL, XSD, type ClassExpression, type DataRange, type Literal } from '../model/expressions';
import { FACETS, facetIri, facetText, formatClass, dataText, literalText, namingFor, parseClass, parseDataRange, parseLiteral, ParseError, type Naming } from '../model/manchester';
import { useStore } from '../model/store';
import { DATATYPES, type Model } from '../model/types';
import { EntityPicker, type Choice } from './EntityPicker';
import type { ManchesterEditor } from './manchesterEditor';

/**
 * The editor of a class expression or a data range: built as nested blocks (the visual editor),
 * or written in Manchester syntax (the text editor). Both edit one expression, the structured
 * one of src/model/expressions.ts: switching between them changes how it is shown, never what it
 * says. An expression is saved only when it is finished and OWL 2 DL allows it; until then the
 * editor says, at the block or the place in the text, what is still to be done.
 */

type Expression = ClassExpression | DataRange;

// ---------------------------------------------------------------- choices of entities

const DATATYPE_IRIS: Choice[] = [...DATATYPES.map((d) => ({ id: d.id.startsWith('xsd:') ? XSD + d.id.slice(4) : 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' + d.id.slice(4), name: d.id, iri: undefined, tag: d.label })), { id: 'http://www.w3.org/2000/01/rdf-schema#Literal', name: 'rdfs:Literal', tag: 'any literal' }, ...['nonNegativeInteger', 'positiveInteger', 'float', 'token', 'gYearMonth', 'dateTimeStamp'].map((x) => ({ id: XSD + x, name: 'xsd:' + x }))];

function choicesOf(model: Model, naming: Naming) {
  const unquote = (s: string) => s.replace(/^'(.*)'$/, '$1');
  return {
    class: (): Choice[] => [...model.terms.filter((t) => t.type === 'concept' && t.iri).map((t) => ({ id: t.iri!, name: t.name || 'Unnamed', iri: t.iri, ...(t.external !== undefined ? { tag: 'external' } : {}) })), { id: OWL + 'Thing', name: 'owl:Thing' }, { id: OWL + 'Nothing', name: 'owl:Nothing' }],
    property: (): Choice[] => [...model.props.filter((p) => p.iri).map((p) => ({ id: p.iri!, name: p.name, iri: p.iri, tag: 'object property' })), ...model.terms.filter((t) => t.type === 'property' && t.iri).map((t) => ({ id: t.iri!, name: t.name || 'Unnamed', iri: t.iri, tag: 'data property' }))],
    individual: (): Choice[] => model.terms.filter((t) => t.type === 'instance' && t.iri).map((t) => ({ id: t.iri!, name: t.name || 'Unnamed', iri: t.iri })),
    datatype: (): Choice[] => [...DATATYPE_IRIS, ...model.datatypes.filter((d) => d.iri && !d.anonymous).map((d) => ({ id: d.iri!, name: d.name || 'Datatype', iri: d.iri, tag: 'enumerated' }))],
    /** A chosen IRI as a chip: by the name the model gives it, or its prefixed name. */
    chip: (iri: string, kind: Parameters<Naming['name']>[1]): Choice => ({ id: iri, name: unquote(naming.name(iri, kind)), iri }),
    /** An IRI typed in (in angle brackets, or a prefixed name), for an entity the model does not list. */
    custom: (text: string): Choice | undefined => {
      const t = text.trim();
      const iri = /^<[^<>\s]+>$/.test(t) ? t.slice(1, -1) : /^[A-Za-z][\w-]*:\S+$/.test(t) ? naming.expand(t) : undefined;
      return iri ? { id: iri, name: t, iri } : undefined;
    },
  };
}

type Choices = ReturnType<typeof choicesOf>;

// ---------------------------------------------------------------- the visual editor

const CLASS_KINDS: { kind: DraftKind; label: string }[] = [
  { kind: 'class', label: 'Class' },
  { kind: 'and', label: 'AND · intersection' },
  { kind: 'or', label: 'OR · union' },
  { kind: 'not', label: 'NOT · complement' },
  { kind: 'some', label: 'SOME · existential' },
  { kind: 'only', label: 'ONLY · universal' },
  { kind: 'value', label: 'VALUE · has value' },
  { kind: 'min', label: 'MIN · at least' },
  { kind: 'max', label: 'MAX · at most' },
  { kind: 'exactly', label: 'EXACTLY' },
  { kind: 'self', label: 'SELF · to itself' },
  { kind: 'oneOf', label: 'ONE OF · individuals' },
];
const DATA_KINDS: { kind: DraftKind; label: string }[] = [
  { kind: 'datatype', label: 'Datatype' },
  { kind: 'facets', label: 'Datatype with facets' },
  { kind: 'enum', label: 'Enumerated datatype' },
  { kind: 'literals', label: 'ONE OF · values' },
  { kind: 'and', label: 'AND · intersection' },
  { kind: 'or', label: 'OR · union' },
  { kind: 'not', label: 'NOT · complement' },
];
const NOUN: Partial<Record<DraftKind, string>> = { and: 'intersection', or: 'union', not: 'complement', some: 'existential restriction', only: 'universal restriction', value: 'value restriction', min: 'minimum cardinality', max: 'maximum cardinality', exactly: 'exact cardinality', self: 'self restriction', oneOf: 'list of individuals', literals: 'list of values', facets: 'datatype with facets' };

interface Edit {
  set: (d: DraftNode) => void;
  root: DraftNode;
  naming: Naming;
  choices: Choices;
  problems: Map<string, string>;
  model: Model;
}

/** A literal typed in as Manchester syntax writes one, read when it is left. */
function LiteralInput({ value, onChange, label, naming }: { value?: Literal; onChange: (l: Literal | undefined) => void; label: string; naming: Naming }) {
  const [text, setText] = useState(value ? literalText(value, naming) : '');
  const [error, setError] = useState<string>();
  const commit = () => {
    if (!text.trim()) return onChange(undefined);
    try {
      onChange(parseLiteral(text, naming));
      setError(undefined);
    } catch (e) {
      setError(e instanceof ParseError ? e.message : String(e));
    }
  };
  return (
    <span className="xb-literal">
      <input aria-label={label} value={text} placeholder={'18, "text", "text"@en, "2026-01-01"^^xsd:date'} aria-invalid={!!error} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      {error && <small className="bad">{error}</small>}
    </span>
  );
}

/** One block of the visual editor, with the blocks under it. */
function Block({ node, sort, edit, depth, parentKind }: { node: DraftNode; sort: Sort; edit: Edit; depth: number; parentKind?: DraftKind }) {
  const [open, setOpen] = useState(true);
  const { naming, choices } = edit;
  const set = (change: (n: DraftNode) => DraftNode) => edit.set(updateNode(edit.root, node.key, change));
  const kinds = sort === 'class' ? CLASS_KINDS : DATA_KINDS;
  const problem = edit.problems.get(node.key);
  const fillerSort: Sort = node.property?.kind === 'data' ? 'data' : 'class';
  const label = NOUN[node.kind] ?? (node.kind === 'class' ? 'class' : node.kind === 'datatype' ? 'datatype' : 'expression');
  const children = node.kind === 'not' ? node.children.slice(0, 1) : hasFiller(node.kind) || node.kind === 'and' || node.kind === 'or' ? node.children : [];
  const where = parentKind ? ` in the ${NOUN[parentKind] ?? 'expression'}` : '';

  if (node.kind === 'unparsed') {
    return (
      <div className="xb kept" data-kind="unparsed">
        <code>{draftText(node, naming, sort)}</code>
        <small className="tag" title="Part of it is kept exactly as it was read, in a form this editor has no structure for. It is written back as it was, and cannot be changed here.">
          kept as read
        </small>
        <button className="link" onClick={() => edit.set(removeNode(edit.root, node.key))}>
          Remove
        </button>
      </div>
    );
  }
  return (
    <div className={`xb${problem ? ' wrong' : ''}`} data-kind={node.kind} role="group" aria-label={`${label}${where}`}>
      <div className="xb-head">
        {children.length > 0 && (
          <button className="xb-fold" aria-expanded={open} aria-label={open ? `Fold the ${label}` : `Unfold the ${label}`} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'}
          </button>
        )}
        <select aria-label={`What this is${where}`} value={node.kind === 'hole' ? '' : node.kind} onChange={(e) => set((n) => withKind(n, e.target.value as DraftKind, sort))}>
          {node.kind === 'hole' && <option value="">Choose…</option>}
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        {node.kind === 'class' && <EntityPicker values={node.iri ? [choices.chip(node.iri, 'class')] : []} options={choices.class} onAdd={(iri) => set((n) => ({ ...n, iri }))} onRemove={() => set((n) => ({ ...n, iri: undefined }))} noun="class" of={`this block${where}`} addLabel="Choose a class" searchLabel="Search for a class" custom={choices.custom} max={1} empty="—" />}
        {(node.kind === 'datatype' || node.kind === 'facets') && <EntityPicker values={node.iri ? [choices.chip(node.iri, 'datatype')] : []} options={choices.datatype} onAdd={(iri) => set((n) => ({ ...n, iri }))} onRemove={() => set((n) => ({ ...n, iri: undefined }))} noun="datatype" of={`this block${where}`} addLabel="Choose a datatype" searchLabel="Search for a datatype" custom={choices.custom} max={1} empty="—" />}
        {node.kind === 'enum' && (
          <select aria-label="Enumerated datatype" value={node.enumId ?? ''} onChange={(e) => set((n) => ({ ...n, enumId: e.target.value || undefined }))}>
            <option value="">Choose…</option>
            {edit.model.datatypes.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || 'Unnamed'} ({d.values.length} values)
              </option>
            ))}
          </select>
        )}
        {isRestriction(node.kind) && (
          <>
            <EntityPicker
              values={node.property ? [{ ...choices.chip(node.property.iri, node.property.kind), tag: node.property.kind === 'data' ? 'data property' : 'object property' }] : []}
              options={choices.property}
              onAdd={(iri) => {
                const kind = edit.model.terms.some((t) => t.iri === iri && t.type === 'property') ? 'data' : 'object';
                set((n) => withProperty(n, { iri, kind, inverse: kind === 'object' ? n.property?.inverse : undefined }));
              }}
              onRemove={() => set((n) => ({ ...n, property: undefined }))}
              noun="property"
              of={`this ${label}`}
              addLabel="Choose the property"
              searchLabel="Search for a property"
              custom={choices.custom}
              max={1}
              empty="property…"
            />
            {node.property?.kind === 'object' && (
              <label className="check" title="The inverse of the property: “inverse hasMember” relates a member to what has it as a member.">
                <input type="checkbox" checked={!!node.property.inverse} onChange={(e) => set((n) => ({ ...n, property: { ...n.property!, inverse: e.target.checked || undefined } }))} />
                <span>inverse</span>
              </label>
            )}
          </>
        )}
        {isCounted(node.kind) && <input className="xb-n" type="number" min={0} step={1} aria-label="How many" value={node.n ?? ''} onChange={(e) => set((n) => ({ ...n, n: e.target.value === '' ? undefined : Math.max(0, Math.floor(Number(e.target.value))) }))} />}
        {node.kind === 'value' && node.property?.kind !== 'data' && <EntityPicker values={node.individuals?.[0] ? [choices.chip(node.individuals[0], 'individual')] : []} options={choices.individual} onAdd={(iri) => set((n) => ({ ...n, individuals: [iri] }))} onRemove={() => set((n) => ({ ...n, individuals: undefined }))} noun="individual" of={`this ${label}`} addLabel="Choose the individual" searchLabel="Search for an individual" custom={choices.custom} max={1} empty="individual…" />}
        {node.kind === 'value' && node.property?.kind === 'data' && <LiteralInput key={node.key} value={node.literal} label="The value" naming={naming} onChange={(literal) => set((n) => ({ ...n, literal }))} />}
        <BlockActions node={node} edit={edit} label={label} />
      </div>
      {node.kind === 'oneOf' && <EntityPicker values={(node.individuals ?? []).map((i) => choices.chip(i, 'individual'))} options={choices.individual} onAdd={(iri) => set((n) => ({ ...n, individuals: [...(n.individuals ?? []).filter((x) => x !== iri), iri] }))} onRemove={(iri) => set((n) => ({ ...n, individuals: (n.individuals ?? []).filter((x) => x !== iri) }))} noun="individual" of="the list" addLabel="Add an individual" searchLabel="Search for an individual" custom={choices.custom} empty="none yet" />}
      {node.kind === 'literals' && <LiteralList node={node} set={set} naming={naming} />}
      {node.kind === 'facets' && <Facets node={node} set={set} naming={naming} />}
      {open && children.length > 0 && (
        <div className="xb-body">
          {children.map((c, i) => (
            <div key={c.key} className="xb-child">
              {i > 0 && (node.kind === 'and' || node.kind === 'or') && <span className="xb-joint">{node.kind}</span>}
              {hasFiller(node.kind) && <span className="xb-joint">{node.kind === 'some' ? 'some' : node.kind === 'only' ? 'only' : 'of'}</span>}
              <Block node={c} sort={hasFiller(node.kind) ? fillerSort : sort} edit={edit} depth={depth + 1} parentKind={node.kind} />
            </div>
          ))}
          {(node.kind === 'and' || node.kind === 'or') && (
            <button className="link xb-add" onClick={() => edit.set(addOperand(edit.root, node.key))}>
              + Add to the {node.kind === 'and' ? 'intersection' : 'union'}
            </button>
          )}
        </div>
      )}
      {!open && <code className="xb-summary">{draftText(node, naming, sort)}</code>}
      {isCounted(node.kind) && !node.children.length && (
        <button className="link xb-add" onClick={() => set((n) => ({ ...n, children: [hole()] }))}>
          + Qualify with a {fillerSort === 'class' ? 'class' : 'datatype'}
        </button>
      )}
      {problem && (
        <small className="bad" role="status">
          {problem}
        </small>
      )}
    </div>
  );
}

/** What can be done with a block as a whole: grouping it with others, ungrouping it, taking it away. */
function BlockActions({ node, edit, label }: { node: DraftNode; edit: Edit; label: string }) {
  const act = (what: string) => {
    if (what === 'and' || what === 'or' || what === 'not') edit.set(wrapNode(edit.root, node.key, what));
    else if (what === 'unwrap') edit.set(unwrapNode(edit.root, node.key));
    else if (what === 'remove') edit.set(removeNode(edit.root, node.key));
  };
  const nested = node.kind === 'and' || node.kind === 'or' || node.kind === 'not';
  return (
    <select className="xb-actions" aria-label={`More for the ${label}`} value="" onChange={(e) => act(e.target.value)}>
      <option value="">⋯</option>
      <option value="and">Put in an AND with another</option>
      <option value="or">Put in an OR with another</option>
      <option value="not">Put in a NOT</option>
      {nested && node.children.length > 0 && <option value="unwrap">Keep only the first part</option>}
      <option value="remove">Remove</option>
    </select>
  );
}

function LiteralList({ node, set, naming }: { node: DraftNode; set: (c: (n: DraftNode) => DraftNode) => void; naming: Naming }) {
  const [text, setText] = useState((node.literals ?? []).map((l) => literalText(l, naming)).join(', '));
  const [error, setError] = useState<string>();
  const commit = () => {
    try {
      const r = text.trim() ? parseDataRange(`{${text}}`, naming) : undefined;
      set((n) => ({ ...n, literals: r && r.type === 'DataOneOf' ? r.literals : [] }));
      setError(undefined);
    } catch (e) {
      setError(e instanceof ParseError ? e.message : String(e));
    }
  };
  return (
    <div className="xb-row">
      <input aria-label="The values, separated by commas" value={text} placeholder={'"S", "M", "L"'} aria-invalid={!!error} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      {error && <small className="bad">{error}</small>}
    </div>
  );
}

function Facets({ node, set, naming }: { node: DraftNode; set: (c: (n: DraftNode) => DraftNode) => void; naming: Naming }) {
  const facets = node.facets ?? [];
  const put = (i: number, f: (typeof facets)[number] | undefined) => set((n) => ({ ...n, facets: f ? facets.map((x, j) => (j === i ? f : x)) : facets.filter((_, j) => j !== i) }));
  return (
    <div className="xb-facets">
      {facets.map((f, i) => (
        <div key={i} className="xb-row">
          <select aria-label="Facet" value={facetText(f.facet)} onChange={(e) => put(i, { ...f, facet: facetIri(e.target.value)! })}>
            {FACETS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <LiteralInput key={`${i}|${f.facet}`} value={f.value} label={`Value of ${facetText(f.facet)}`} naming={naming} onChange={(value) => put(i, { ...f, value })} />
          <button className="link" onClick={() => put(i, undefined)}>
            Remove
          </button>
        </div>
      ))}
      <button className="link xb-add" onClick={() => set((n) => ({ ...n, facets: [...facets, { facet: facetIri('>=')! }] }))}>
        + Add a facet
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the text editor

/** The Manchester-syntax editor (CodeMirror, loaded when first shown). */
function ManchesterText({ text, sort, naming, onChange, onSubmit, label }: { text: string; sort: Sort; naming: Naming; onChange: (t: string) => void; onSubmit: () => void; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<ManchesterEditor | null>(null);
  const latest = useRef({ naming, onChange, onSubmit });
  latest.current = { naming, onChange, onSubmit };
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let gone = false;
    void import('./manchesterEditor').then(({ createManchesterEditor }) => {
      if (gone || !host.current) return;
      editor.current = createManchesterEditor({
        parent: host.current,
        text,
        as: sort,
        label,
        naming: () => latest.current.naming,
        onChange: (t) => latest.current.onChange(t),
        onSubmit: () => latest.current.onSubmit(),
        placeholder: sort === 'class' ? 'Person and (hasChild some Student)' : 'xsd:integer[>= 0]',
      });
      editor.current.focus();
      setLoaded(true);
    });
    return () => {
      gone = true;
      editor.current?.destroy();
      editor.current = null;
    };
    // Made once; later text comes in through setText.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => editor.current?.setText(text), [text]);
  return (
    <div className="mx-editor" ref={host}>
      {!loaded && <span className="muted">Loading the editor…</span>}
    </div>
  );
}

// ---------------------------------------------------------------- the two together

/** Which editor was used last: the next one opens in it. */
let lastMode: 'visual' | 'text' = 'visual';

export function ExpressionEditor({
  sort,
  initial,
  label,
  onSave,
  onCancel,
  saveLabel = 'Save',
  before,
  blocked,
}: {
  sort: Sort;
  initial?: Expression;
  /** What the expression is, for what assistive technology reads out: "Domain axiom of hasActivity". */
  label: string;
  onSave: (e: Expression) => string | undefined | void;
  onCancel: () => void;
  saveLabel?: string;
  /** Shown above the editor: what kind of axiom it is, where that is to be chosen. */
  before?: ReactNode;
  /** Why it cannot be saved yet, whatever the expression (no kind of axiom chosen). */
  blocked?: string;
}) {
  const model = useStore((s) => s.model);
  const naming = useMemo(() => namingFor(model), [model]);
  const choices = useMemo(() => choicesOf(model, naming), [model, naming]);
  const [draft, setDraft] = useState<DraftNode>(() => (initial ? toDraft(initial) : hole()));
  const [text, setText] = useState(() => (initial ? (sort === 'class' ? formatClass(initial as ClassExpression, naming) : dataText(initial as DataRange, naming)) : ''));
  const [textError, setTextError] = useState<string>();
  const [mode, setMode] = useState(lastMode);
  const [refused, setRefused] = useState<string>();
  const finished = fromDraft(draft, sort as 'class') as { value?: Expression; problems: Problem[] };
  const problems = new Map(finished.problems.map((p) => [p.key, p.message]));
  const issues: ExpressionIssue[] = finished.value ? checkExpression(finished.value, naming) : [];
  const errors = issues.filter((i) => i.severity === 'error');
  const why = blocked ?? (mode === 'text' && textError ? 'The text does not read as an expression yet.' : finished.problems.length ? 'The expression is not finished: see the blocks.' : errors.length ? 'OWL 2 DL does not allow this expression: see below.' : undefined);

  const fromBlocks = (d: DraftNode) => {
    setDraft(d);
    setText(draftText(d, naming, sort));
    setTextError(undefined);
    setRefused(undefined);
  };
  const fromText = (t: string) => {
    setText(t);
    setRefused(undefined);
    try {
      const e = sort === 'class' ? parseClass(t, naming) : parseDataRange(t, naming);
      setDraft(toDraft(e));
      setTextError(undefined);
    } catch (e) {
      setTextError(e instanceof ParseError ? e.message : String(e));
    }
  };
  const switchTo = (to: 'visual' | 'text') => {
    if (to === 'visual' && textError) return setRefused(`The text does not read as an expression yet, so it cannot be shown as blocks: ${textError}`);
    lastMode = to;
    setMode(to);
  };
  const save = () => {
    if (why || !finished.value) return;
    const no = onSave(finished.value);
    if (no) setRefused(no);
  };
  return (
    <div className="xe" role="group" aria-label={label}>
      {before}
      <div className="xe-modes" role="tablist" aria-label="How to edit the expression">
        <button role="tab" aria-selected={mode === 'visual'} className={mode === 'visual' ? 'on' : ''} onClick={() => switchTo('visual')}>
          Blocks
        </button>
        <button role="tab" aria-selected={mode === 'text'} className={mode === 'text' ? 'on' : ''} onClick={() => switchTo('text')}>
          Manchester syntax
        </button>
      </div>
      {mode === 'visual' ? (
        <div className="xe-visual">
          <Block node={draft} sort={sort} depth={0} edit={{ set: fromBlocks, root: draft, naming, choices, problems, model }} />
          <div className="xe-preview">
            <span className="muted">Manchester syntax:</span> <code>{draftText(draft, naming, sort)}</code>
          </div>
        </div>
      ) : (
        <div className="xe-text">
          <ManchesterText text={text} sort={sort} naming={naming} onChange={fromText} onSubmit={save} label={`${label}, in Manchester syntax`} />
          <div className="row">
            <button className="link" disabled={!finished.value || !!textError || sort !== 'class'} onClick={() => finished.value && setText(formatClass(finished.value as ClassExpression, naming))} title="Lay the expression out over lines, one part to a line">
              Format
            </button>
            <small className="muted">Ctrl+Space suggests names; Ctrl+Enter saves.</small>
          </div>
          {textError && (
            <small className="bad" role="status">
              {textError}
            </small>
          )}
        </div>
      )}
      {issues.map((i, k) => (
        <small key={k} className={i.severity === 'error' ? 'bad' : 'warn'} role="status">
          {i.severity === 'error' ? '✗ ' : '⚠ '}
          {i.message}
        </small>
      ))}
      {refused && (
        <small className="bad" role="alert">
          {refused}
        </small>
      )}
      <div className="row">
        <button className="btn small" disabled={!!why} title={why} onClick={save}>
          {saveLabel}
        </button>
        <button className="btn small" onClick={onCancel}>
          Cancel
        </button>
        {why && <small className="muted">{why}</small>}
      </div>
    </div>
  );
}

/**
 * The expression editor in a dialog of its own, wide enough for nested blocks and for the text:
 * the side panel is too narrow for either. Escape cancels (unless the text editor took it, to
 * close its suggestions); a click beside it does nothing, so that no edit is lost by a slip.
 */
export function ExpressionDialog({ title, ...props }: Parameters<typeof ExpressionEditor>[0] & { title: string }) {
  const id = useId();
  return (
    <div className="backdrop">
      <div className="dialog xe-dialog" role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && props.onCancel()}>
        <h2 id={id}>{title}</h2>
        <ExpressionEditor {...props} />
      </div>
    </div>
  );
}
