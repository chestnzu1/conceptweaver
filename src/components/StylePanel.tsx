import { useState, type ReactNode } from 'react';
import { edgeTypesOf } from '../model/edgeKinds';
import {
  ARROWS,
  dashOf,
  EDGE_TYPE_LABEL,
  EDGE_TYPES,
  isHex,
  LINES,
  NAMED_COLORS,
  NODE_TYPE_LABEL,
  NODE_TYPES,
  nodeTypeOf,
  noStyle,
  paint,
  patchEdges,
  patchEdgeType,
  patchNodes,
  patchNodeType,
  resetOwn,
  SHAPE_LABEL,
  SHAPES,
  THEMES,
  withTheme,
  type ArrowStyle,
  type EdgeStyle,
  type EdgeType,
  type GraphStyle,
  type LabelMode,
  type LineStyle,
  type NodeStyle,
  type NodeType,
  type Shape,
} from '../model/graphStyle';
import { stable } from '../model/stable';
import { useStore, viewOf } from '../model/store';

const st = useStore.getState;
type Tab = 'nodes' | 'edges' | 'themes';
let lastTab: Tab = 'nodes';

const COLOR_NAME: Record<string, string> = { blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', purple: 'Purple', teal: 'Teal', pink: 'Pink', ink: 'Text colour' };

/** A row of the panel: what is being set, and the control that sets it. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="style-row">
      <span className="style-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * A colour: the default, one of the app's named colours (which follow light and dark mode), or
 * any colour from the picker. The chosen one carries a tick, so it is not told by its ring alone.
 */
function ColorField({ label, value, role, onChange }: { label: string; value: string | undefined; role: 'fill' | 'line'; onChange: (c: string | undefined) => void }) {
  return (
    <Row label={label}>
      <div className="swatches" role="group" aria-label={label}>
        <button className={'swatch none' + (!value ? ' on' : '')} aria-pressed={!value} title="Default" aria-label={`${label}: default`} onClick={() => onChange(undefined)} />
        {NAMED_COLORS.map((c) => (
          <button
            key={c}
            className={'swatch' + (value === c ? ' on' : '')}
            aria-pressed={value === c}
            title={COLOR_NAME[c]}
            aria-label={`${label}: ${COLOR_NAME[c]}`}
            style={{ background: paint(c, role), borderColor: paint(c, 'line') }}
            onClick={() => onChange(c)}
          />
        ))}
        <label className={'swatch custom' + (isHex(value) ? ' on' : '')} title={isHex(value) ? `Any colour: ${value}` : 'Any colour'} style={isHex(value) ? { background: value } : undefined}>
          <input type="color" aria-label={`${label}: any colour`} value={isHex(value) ? value : '#4a78c9'} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
    </Row>
  );
}

/** A number, by slider where it has a natural range, and always by typing. Empty is the default. */
function NumberField({ label, value, min, max, step = 1, slider, base, auto = 'auto', onChange }: { label: string; value: number | undefined; min: number; max: number; step?: number; slider?: boolean; base?: number; auto?: string; onChange: (n: number | undefined) => void }) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <Row label={label}>
      <div className="style-number">
        {slider && <input type="range" aria-label={label} min={min} max={max} step={step} value={value ?? base ?? min} onChange={(e) => onChange(Number(e.target.value))} />}
        <input
          type="number"
          aria-label={slider ? `${label}, as a number` : label}
          min={min}
          max={max}
          step={step}
          placeholder={auto}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' || Number.isNaN(Number(e.target.value)) ? undefined : clamp(Number(e.target.value)))}
        />
      </div>
    </Row>
  );
}

/** One of a few options, each shown as a small drawing of what it does. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T | undefined; options: { id: T | undefined; name: string; icon: ReactNode }[]; onChange: (v: T | undefined) => void }) {
  return (
    <Row label={label}>
      <div className="style-choice" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.id ?? 'default'} className={value === o.id ? 'on' : ''} aria-pressed={value === o.id} title={o.name} aria-label={`${label}: ${o.name}`} onClick={() => onChange(o.id)}>
            {o.icon}
          </button>
        ))}
      </div>
    </Row>
  );
}

const Auto = () => <span className="style-auto">Auto</span>;

function ShapeIcon({ shape, w = 30, h = 18 }: { shape: Shape; w?: number; h?: number }) {
  const p = 1.5;
  const c = Math.min(h * 0.32, w * 0.25);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" className="shape-icon">
      {shape === 'rectangle' && <rect x={p} y={p} width={w - 2 * p} height={h - 2 * p} />}
      {shape === 'rounded' && <rect x={p} y={p} width={w - 2 * p} height={h - 2 * p} rx={5} />}
      {shape === 'ellipse' && <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - p} ry={h / 2 - p} />}
      {shape === 'circle' && <circle cx={w / 2} cy={h / 2} r={h / 2 - p} />}
      {shape === 'diamond' && <polygon points={`${w / 2},${p} ${w - p},${h / 2} ${w / 2},${h - p} ${p},${h / 2}`} />}
      {shape === 'hexagon' && <polygon points={`${c + p},${p} ${w - c - p},${p} ${w - p},${h / 2} ${w - c - p},${h - p} ${c + p},${h - p} ${p},${h / 2}`} />}
    </svg>
  );
}

const LINE_NAME: Record<LineStyle, string> = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' };
const ARROW_NAME: Record<ArrowStyle, string> = { filled: 'Filled arrowhead', hollow: 'Hollow arrowhead', open: 'Open arrowhead', none: 'No arrowhead' };

function LineIcon({ line, arrow }: { line?: LineStyle; arrow?: ArrowStyle }) {
  return (
    <svg viewBox="0 0 34 14" width={34} height={14} aria-hidden="true" className="line-icon">
      <path d={arrow && arrow !== 'none' ? (arrow === 'hollow' ? 'M2,7H22' : 'M2,7H30') : 'M2,7H32'} strokeDasharray={line ? dashOf(line, 1.6) : undefined} strokeLinecap={line === 'dotted' ? 'round' : undefined} />
      {arrow === 'filled' && <polygon points="32,7 24,3 24,11" className="solid" />}
      {arrow === 'hollow' && <polygon points="32,7 22,2.5 22,11.5" />}
      {arrow === 'open' && <polyline points="23,2.5 32,7 23,11.5" />}
    </svg>
  );
}

/** Which things the controls below apply to: every term or relationship of a kind, or the ones selected on the canvas. */
function Scope({ own, setOwn, count, noun }: { own: boolean; setOwn: (own: boolean) => void; count: number; noun: string }) {
  return (
    <div className="tabs style-scope" role="group" aria-label="What to style">
      <button className={own ? '' : 'on'} aria-pressed={!own} onClick={() => setOwn(false)}>
        By kind
      </button>
      <button className={own ? 'on' : ''} aria-pressed={own} disabled={!count} title={count ? undefined : `Select a ${noun} on the canvas to give it a style of its own`} onClick={() => setOwn(true)}>
        Selected{count ? ` (${count})` : ''}
      </button>
    </div>
  );
}

/** The styles by kind that the style's theme has, to go back to. */
function themeOf(style: GraphStyle): Pick<GraphStyle, 'nodeTypes' | 'edgeTypes'> {
  return THEMES.find((t) => t.id === style.theme) ?? st().savedStyles.find((s) => s.name === style.theme) ?? noStyle();
}
const without = <T extends object>(map: T, key: keyof T): T => {
  const next = { ...map };
  delete next[key];
  return next;
};

function NodesTab({ style }: { style: GraphStyle }) {
  const model = useStore(viewOf);
  const selected = useStore((s) => s.sel.terms);
  const skos = model.mode === 'skos';
  const [type, setType] = useState<NodeType>('class');
  const [wantOwn, setOwn] = useState(false);
  const own = wantOwn && selected.length > 0;
  const first = model.terms.find((t) => t.id === selected[0]);
  const kind: NodeType = own && first ? nodeTypeOf(model.mode, first.type) : skos ? 'class' : type;
  const current: NodeStyle = (own ? style.nodes[selected[0]] : style.nodeTypes[kind]) ?? {};
  const kindName = skos ? 'Concept' : NODE_TYPE_LABEL[kind];
  const set = (patch: NodeStyle, what: string) => st().setStyle((s) => (own ? patchNodes(s, selected, patch) : patchNodeType(s, kind, patch)), `${own ? selected.join() : kind}:${what}`);
  // A term's colour from the canvas menu is its own fill too: it is shown and changed here as one thing.
  const ownFill = own ? (current.fill ?? (first?.color || undefined)) : undefined;
  const styled = Object.keys(current).length > 0 || (own && model.terms.some((t) => selected.includes(t.id) && t.color));
  // Terms of this kind that keep a fill of their own, whatever is chosen for the kind.
  const coloured = own ? [] : model.terms.filter((t) => nodeTypeOf(model.mode, t.type) === kind && (t.color || style.nodes[t.id]?.fill)).map((t) => t.id);

  return (
    <>
      <Scope own={own} setOwn={setOwn} count={selected.length} noun="term" />
      {own ? (
        <p className="style-hint">
          For <strong>{selected.length === 1 ? first?.name || 'Unnamed' : `${selected.length} terms`}</strong> only. Whatever is left at its default follows the kind ({kindName}).
        </p>
      ) : skos ? (
        <p className="style-hint">Every concept of the scheme.</p>
      ) : (
        <Row label="Kind of term">
          <select aria-label="Kind of term" value={kind} onChange={(e) => setType(e.target.value as NodeType)}>
            {NODE_TYPES.map((k) => (
              <option key={k} value={k}>
                {NODE_TYPE_LABEL[k]}
              </option>
            ))}
          </select>
        </Row>
      )}

      <Choice<Shape> label="Shape" value={current.shape} onChange={(shape) => set({ shape }, 'shape')} options={[{ id: undefined, name: 'Default for its kind', icon: <Auto /> }, ...SHAPES.map((s) => ({ id: s, name: SHAPE_LABEL[s], icon: <ShapeIcon shape={s} /> }))]} />
      <ColorField label="Fill" role="fill" value={own ? ownFill : current.fill} onChange={(fill) => (own ? st().setOwnFill(selected, fill) : set({ fill }, 'fill'))} />
      {coloured.length > 0 && (
        <p className="style-hint">
          {coloured.length} {coloured.length === 1 ? 'term of this kind keeps' : 'terms of this kind keep'} a fill of {coloured.length === 1 ? 'its' : 'their'} own.{' '}
          <button className="link" title="They take the fill of their kind again. Undo brings their colours back." onClick={() => st().setOwnFill(coloured, undefined)}>
            Clear {coloured.length === 1 ? 'it' : 'them'}
          </button>
        </p>
      )}
      <ColorField label="Border" role="line" value={current.stroke} onChange={(stroke) => set({ stroke }, 'stroke')} />
      <NumberField label="Border thickness" slider min={0} max={6} step={0.5} base={1.5} value={current.strokeWidth} onChange={(strokeWidth) => set({ strokeWidth }, 'strokeWidth')} />
      <Row label="Size">
        <div className="style-pair">
          <input type="number" aria-label="Width" title="Width in pixels. Empty: as wide as the label needs." placeholder="width" min={30} max={400} step={2} value={current.width ?? ''} onChange={(e) => set({ width: e.target.value === '' ? undefined : Math.min(400, Math.max(30, Number(e.target.value) || 30)) }, 'width')} />
          <span aria-hidden="true">×</span>
          <input type="number" aria-label="Height" title="Height in pixels. Empty: the standard height." placeholder="height" min={24} max={300} step={2} value={current.height ?? ''} onChange={(e) => set({ height: e.target.value === '' ? undefined : Math.min(300, Math.max(24, Number(e.target.value) || 24)) }, 'height')} />
        </div>
      </Row>
      <Row label="Label shows">
        <select aria-label="Label shows" value={current.label ?? ''} onChange={(e) => set({ label: (e.target.value || undefined) as LabelMode | undefined }, 'label')}>
          <option value="">Default (name)</option>
          <option value="name">Name</option>
          <option value="curie">Prefixed IRI</option>
          <option value="iri">Full IRI</option>
        </select>
      </Row>
      <NumberField label="Label size" min={10} max={24} value={current.fontSize} auto="14" onChange={(fontSize) => set({ fontSize }, 'fontSize')} />
      <Row label="Label weight">
        <select aria-label="Label weight" value={current.fontWeight ?? ''} onChange={(e) => set({ fontWeight: e.target.value ? Number(e.target.value) : undefined }, 'fontWeight')}>
          <option value="">Default</option>
          <option value="400">Regular</option>
          <option value="500">Medium</option>
          <option value="600">Semibold</option>
          <option value="700">Bold</option>
        </select>
      </Row>
      <ColorField label="Label colour" role="line" value={current.labelColor} onChange={(labelColor) => set({ labelColor }, 'labelColor')} />
      <NumberField label="Opacity %" slider min={10} max={100} step={5} base={100} auto="100" value={current.opacity === undefined ? undefined : Math.round(current.opacity * 100)} onChange={(n) => set({ opacity: n === undefined || n >= 100 ? undefined : n / 100 }, 'opacity')} />

      <div className="style-actions">
        {own ? (
          <>
            <button className="btn small" disabled={!styled} title="Take this style away again: the selection looks like its kind" onClick={() => st().resetOwnStyle(selected, [])}>
              Reset to its kind
            </button>
            <button
              className="btn small"
              disabled={!styled}
              title={`Make this the style of every ${kindName.toLowerCase()}`}
              onClick={() => st().setStyle((s) => resetOwn({ ...s, customized: true, nodeTypes: { ...s.nodeTypes, [kind]: { ...s.nodeTypes[kind], ...current, ...(ownFill ? { fill: ownFill } : {}) } } }, selected, []))}
            >
              Apply to all of its kind
            </button>
          </>
        ) : (
          <>
            <button
              className="btn small"
              title="Back to what the theme has for this kind"
              onClick={() =>
                st().setStyle((s) => {
                  const base = themeOf(s).nodeTypes[kind];
                  return { ...s, nodeTypes: base ? { ...s.nodeTypes, [kind]: base } : without(s.nodeTypes, kind) };
                })
              }
            >
              Reset to default
            </button>
            {!skos && (
              <button className="btn small" disabled={!styled} title="Give every kind of term this style" onClick={() => st().setStyle((s) => ({ ...s, customized: true, nodeTypes: Object.fromEntries(NODE_TYPES.map((k) => [k, { ...current }])) }))}>
                Apply to all kinds
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function EdgesTab({ style }: { style: GraphStyle }) {
  const model = useStore(viewOf);
  const selected = useStore((s) => s.sel.rels);
  const [type, setType] = useState<EdgeType>('subClassOf');
  const [wantOwn, setOwn] = useState(false);
  const own = wantOwn && selected.length > 0;
  const kind: EdgeType = own ? (edgeTypesOf(stable(model)).get(selected[0]) ?? 'plain') : type;
  const current: EdgeStyle = (own ? style.edges[selected[0]] : style.edgeTypes[kind]) ?? {};
  const set = (patch: EdgeStyle, what: string) => st().setStyle((s) => (own ? patchEdges(s, selected, patch) : patchEdgeType(s, kind, patch)), `${own ? selected.join() : kind}:${what}`);
  const styled = Object.keys(current).length > 0;
  // In a concept scheme there are three kinds of line: broader, the standard SKOS ones, and the rest.
  const kinds = model.mode === 'skos' ? (['subClassOf', 'standard', 'objectProperty'] as EdgeType[]) : EDGE_TYPES;
  const name = (k: EdgeType) => (model.mode === 'skos' ? ({ subClassOf: 'Broader (skos:broader)', standard: 'Other SKOS property', objectProperty: 'Relationship of your own' } as Record<string, string>)[k] : EDGE_TYPE_LABEL[k]);

  return (
    <>
      <Scope own={own} setOwn={setOwn} count={selected.length} noun="relationship" />
      {own ? (
        <p className="style-hint">
          For <strong>{selected.length === 1 ? 'the selected relationship' : `${selected.length} relationships`}</strong> only. Whatever is left at its default follows the kind ({name(kind)}).
        </p>
      ) : (
        <Row label="Kind of relationship">
          <select aria-label="Kind of relationship" value={kinds.includes(kind) ? kind : kinds[0]} onChange={(e) => setType(e.target.value as EdgeType)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {name(k)}
              </option>
            ))}
          </select>
        </Row>
      )}

      <ColorField label="Colour" role="line" value={current.color} onChange={(color) => set({ color }, 'color')} />
      <NumberField label="Thickness" slider min={0.5} max={6} step={0.5} base={1.5} value={current.width} onChange={(width) => set({ width }, 'width')} />
      <Choice<LineStyle> label="Line" value={current.line} onChange={(line) => set({ line }, 'line')} options={[{ id: undefined, name: 'Default for its kind', icon: <Auto /> }, ...LINES.map((l) => ({ id: l, name: LINE_NAME[l], icon: <LineIcon line={l} /> }))]} />
      <Choice<ArrowStyle> label="Arrowhead" value={current.arrow} onChange={(arrow) => set({ arrow }, 'arrow')} options={[{ id: undefined, name: 'Default for its kind', icon: <Auto /> }, ...ARROWS.map((a) => ({ id: a, name: ARROW_NAME[a], icon: <LineIcon arrow={a} /> }))]} />
      <NumberField label="Curvature" slider min={-120} max={120} step={10} base={0} auto="0" value={current.curve} onChange={(curve) => set({ curve: curve || undefined }, 'curve')} />
      <Row label="Label">
        <select aria-label="Label" value={current.labels === undefined ? '' : current.labels ? 'show' : 'hide'} onChange={(e) => set({ labels: e.target.value === '' ? undefined : e.target.value === 'show' }, 'labels')}>
          <option value="">{own ? 'As its kind' : 'Shown'}</option>
          {own && <option value="show">Shown</option>}
          <option value="hide">Hidden</option>
        </select>
      </Row>
      <NumberField label="Label size" min={10} max={20} value={current.labelSize} auto="12" onChange={(labelSize) => set({ labelSize }, 'labelSize')} />
      <ColorField label="Label colour" role="line" value={current.labelColor} onChange={(labelColor) => set({ labelColor }, 'labelColor')} />

      <div className="style-actions">
        {own ? (
          <>
            <button className="btn small" disabled={!styled} title="Take this style away again: the selection looks like its kind" onClick={() => st().setStyle((s) => resetOwn(s, [], selected))}>
              Reset to its kind
            </button>
            <button className="btn small" disabled={!styled} title={`Make this the style of every relationship of the kind “${name(kind)}”`} onClick={() => st().setStyle((s) => resetOwn({ ...s, customized: true, edgeTypes: { ...s.edgeTypes, [kind]: { ...s.edgeTypes[kind], ...current } } }, [], selected))}>
              Apply to all of its kind
            </button>
          </>
        ) : (
          <>
            <button
              className="btn small"
              title="Back to what the theme has for this kind"
              onClick={() =>
                st().setStyle((s) => {
                  const base = themeOf(s).edgeTypes[kind];
                  return { ...s, edgeTypes: base ? { ...s.edgeTypes, [kind]: base } : without(s.edgeTypes, kind) };
                })
              }
            >
              Reset to default
            </button>
            <button className="btn small" disabled={!styled} title="Give every kind of relationship this style" onClick={() => st().setStyle((s) => ({ ...s, customized: true, edgeTypes: Object.fromEntries(kinds.map((k) => [k, { ...current }])) }))}>
              Apply to all kinds
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** A theme at a glance: a class, an individual and a data property as it draws them, on its "is a" line. */
function ThemePreview({ theme }: { theme: Pick<GraphStyle, 'nodeTypes' | 'edgeTypes'> }) {
  const node = (kind: NodeType, x: number) => {
    const s = theme.nodeTypes[kind] ?? {};
    const shape: Shape = s.shape ?? (kind === 'individual' ? 'rectangle' : 'rounded');
    const look = { fill: paint(s.fill, 'fill') ?? 'var(--nc-default-fill)', stroke: paint(s.stroke, 'line') ?? (s.fill && !isHex(s.fill) ? paint(s.fill, 'line') : 'var(--nc-default-stroke)'), strokeWidth: Math.min(2.5, s.strokeWidth ?? 1.5), strokeDasharray: kind === 'dataProperty' && !s.shape ? '3 2' : undefined };
    const [w, h] = shape === 'circle' ? [18, 18] : [26, 16];
    const c = Math.min(h * 0.32, w * 0.25);
    return (
      <g transform={`translate(${x - w / 2},${14 - h / 2})`} style={look}>
        {(shape === 'rectangle' || shape === 'rounded') && <rect width={w} height={h} rx={shape === 'rounded' ? (kind === 'dataProperty' && !s.shape ? 8 : 4) : 0} />}
        {(shape === 'ellipse' || shape === 'circle') && <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} />}
        {shape === 'diamond' && <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />}
        {shape === 'hexagon' && <polygon points={`${c},0 ${w - c},0 ${w},${h / 2} ${w - c},${h} ${c},${h} 0,${h / 2}`} />}
      </g>
    );
  };
  const edge = theme.edgeTypes.subClassOf ?? {};
  return (
    <svg viewBox="0 0 120 28" width={120} height={28} aria-hidden="true" className="theme-preview">
      <path d="M30,14H47M73,14H90" style={{ stroke: paint(edge.color, 'line') ?? 'var(--edge)', strokeWidth: Math.min(2.5, edge.width ?? 1.5), strokeDasharray: dashOf(edge.line, 1.5) }} />
      {node('class', 17)}
      {node('individual', 60)}
      {node('dataProperty', 103)}
    </svg>
  );
}

function ThemesTab({ style }: { style: GraphStyle }) {
  const saved = useStore((s) => s.savedStyles);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const terms = useStore((s) => s.model.terms);
  // What single terms and relationships were given: a style of their own, or for a term a colour from the canvas menu.
  const own = new Set([...Object.keys(style.nodes), ...terms.filter((t) => t.color).map((t) => t.id)]).size + Object.keys(style.edges).length;
  const save = () => {
    const refused = st().saveStyleAs(name);
    setError(refused);
    if (!refused) setName('');
  };
  return (
    <>
      <p className="style-hint">A theme sets the style of every kind of term and relationship. What single terms were given, a colour or a style of their own, stays as it is.</p>
      <ul className="theme-list">
        {THEMES.map((t) => {
          const on = style.theme === t.id;
          return (
            <li key={t.id}>
              <button className={'theme' + (on ? ' on' : '')} aria-pressed={on} title={t.about} onClick={() => st().setStyle((s) => withTheme(s, t))}>
                <ThemePreview theme={t} />
                <span className="theme-name">
                  <strong>{t.label}</strong>
                  {on && <em>{style.customized ? 'in use, changed since' : 'in use'}</em>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <h3>Your styles</h3>
      {saved.length ? (
        <ul className="theme-list">
          {saved.map((s) => {
            const on = style.theme === s.name;
            return (
              <li key={s.name} className="saved">
                <button className={'theme' + (on ? ' on' : '')} aria-pressed={on} onClick={() => st().setStyle((cur) => withTheme(cur, s))}>
                  <ThemePreview theme={s} />
                  <span className="theme-name">
                    <strong>{s.name}</strong>
                    {on && <em>{style.customized ? 'in use, changed since' : 'in use'}</em>}
                  </span>
                </button>
                <button className="btn icon ghost" title="Delete this saved style. Models that use it keep their look." aria-label={`Delete the saved style ${s.name}`} onClick={() => st().deleteSavedStyle(s.name)}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="style-hint">None saved yet. A style saved here can be used in any model in this browser.</p>
      )}
      <div className="style-save">
        <input aria-label="Name for the current style" aria-invalid={!!error} placeholder="Name for the current style" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <button className="btn small" disabled={!name.trim()} onClick={save}>
          Save
        </button>
      </div>
      {error && (
        <small className="bad" role="alert">
          {error}
        </small>
      )}

      <div className="style-actions">
        <button className="btn small" disabled={!own} title="Every term and relationship looks like its kind again: their own styles go, and the colours terms were given on the canvas" onClick={() => st().resetOwnStyle('all', 'all')}>
          Clear {own || ''} individual style{own === 1 ? '' : 's'}
        </button>
        <button
          className="btn small"
          title="The standard theme, and no styles of their own on single terms or relationships. Colours given to terms on the canvas stay."
          onClick={() => {
            st().setStyle(() => noStyle());
            st().notify('Graph style restored to the default. Undo brings the previous one back.');
          }}
        >
          Restore defaults
        </button>
      </div>
    </>
  );
}

/**
 * The graph style editor: how terms and relationships are drawn, by kind and one by one, and the
 * themes. It changes the picture only. Nothing here touches the ontology, and every change is one
 * step of Undo.
 */
export function StylePanel() {
  const style = useStore((s) => s.model.style);
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => setTabState((lastTab = t));
  const tabs: [Tab, string][] = [
    ['nodes', 'Nodes'],
    ['edges', 'Edges'],
    ['themes', 'Themes'],
  ];
  return (
    <aside className="style-panel" aria-label="Graph style" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="style-head">
        <h2>Graph style</h2>
        <button className="btn icon ghost" title="Close" aria-label="Close the graph style panel" onClick={() => st().setStylePanel(false)}>
          ×
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label="What to style">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="style-body" role="tabpanel">
        {tab === 'nodes' && <NodesTab style={style} />}
        {tab === 'edges' && <EdgesTab style={style} />}
        {tab === 'themes' && <ThemesTab style={style} />}
      </div>
    </aside>
  );
}
