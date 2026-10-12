import { compactIri } from './prefixes';
import { ENUM_RANGE, type Model, type Term, type TermType } from './types';

/**
 * How the graph is drawn: shapes, colours, line styles. None of it is part of the ontology. It is
 * kept beside the model the way the positions of the terms are, is never written to RDF, and
 * changing it changes nothing the reasoner or the validation sees.
 *
 * Three levels, the later overriding the earlier, property by property:
 *   the default theme (the stylesheet, which follows light and dark mode)
 *   a style for each kind of term and each kind of relationship
 *   a style of its own for one term or one relationship
 */

export const SHAPES = ['rounded', 'rectangle', 'ellipse', 'circle', 'diamond', 'hexagon'] as const;
export type Shape = (typeof SHAPES)[number];
export const SHAPE_LABEL: Record<Shape, string> = { rounded: 'Rounded rectangle', rectangle: 'Rectangle', ellipse: 'Ellipse', circle: 'Circle', diamond: 'Diamond', hexagon: 'Hexagon' };

export const LABEL_MODES = ['name', 'curie', 'iri'] as const;
export type LabelMode = (typeof LABEL_MODES)[number];
export const LINES = ['solid', 'dashed', 'dotted'] as const;
export type LineStyle = (typeof LINES)[number];
export const ARROWS = ['filled', 'hollow', 'open', 'none'] as const;
export type ArrowStyle = (typeof ARROWS)[number];

/** What can be set about a node. A property left out is taken from the level below. */
export interface NodeStyle {
  shape?: Shape;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  width?: number;
  height?: number;
  fontSize?: number;
  fontWeight?: number;
  labelColor?: string;
  label?: LabelMode;
  opacity?: number;
}

/** What can be set about an edge. */
export interface EdgeStyle {
  color?: string;
  width?: number;
  line?: LineStyle;
  arrow?: ArrowStyle;
  labelSize?: number;
  labelColor?: string;
  /** How far the line bows sideways, in pixels; negative bows the other way. */
  curve?: number;
  /** false hides the label; true shows it where the kind's style hides it. */
  labels?: boolean;
}

/** The kinds of term that are drawn as nodes. */
export const NODE_TYPES = ['class', 'individual', 'dataProperty'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const NODE_TYPE_LABEL: Record<NodeType, string> = { class: 'Class', individual: 'Individual', dataProperty: 'Datatype property' };

/** The kinds of relationship that are drawn as edges. Object properties and restrictions are edges here, not nodes. */
export const EDGE_TYPES = ['subClassOf', 'type', 'restriction', 'objectProperty', 'dataProperty', 'plain', 'subPropertyOf', 'equivalentClass', 'disjointWith', 'domain', 'range', 'standard', 'oneOf', 'inferred'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];
export const EDGE_TYPE_LABEL: Record<EdgeType, string> = {
  subClassOf: 'Is a (rdfs:subClassOf)',
  type: 'Is Instance Of (rdf:type)',
  restriction: 'Restriction by an object property',
  objectProperty: 'Object property between individuals',
  dataProperty: 'Has data property',
  plain: 'Plain relationship',
  subPropertyOf: 'Subproperty (rdfs:subPropertyOf)',
  equivalentClass: 'owl:equivalentClass',
  disjointWith: 'owl:disjointWith',
  domain: 'rdfs:domain',
  range: 'rdfs:range',
  standard: 'Other standard property',
  oneOf: 'Enumeration membership (owl:oneOf)',
  inferred: 'Inferred Is Instance Of',
};

export interface GraphStyle {
  /** The theme the styles started from: a built-in one, or the name of a saved one. */
  theme: string;
  /** True once a style by kind has been changed since the theme was applied. */
  customized?: boolean;
  nodeTypes: Partial<Record<NodeType, NodeStyle>>;
  edgeTypes: Partial<Record<EdgeType, EdgeStyle>>;
  /** Styles of single terms, by term id. */
  nodes: Record<string, NodeStyle>;
  /** Styles of single relationships, by relationship id. */
  edges: Record<string, EdgeStyle>;
}

export const noStyle = (): GraphStyle => ({ theme: 'standard', nodeTypes: {}, edgeTypes: {}, nodes: {}, edges: {} });

// ---------------------------------------------------------------- colours

/**
 * A colour is one of the app's own (which follow light and dark mode) or one picked freely.
 * The named ones are the palette the canvas already has for terms, and the text colour.
 */
export const PALETTE = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'] as const;
export const NAMED_COLORS = [...PALETTE, 'ink'] as const;
const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (c: string | undefined): c is string => !!c && HEX.test(c);
const isNamed = (c: string | undefined): c is string => !!c && (NAMED_COLORS as readonly string[]).includes(c);

/** The CSS value for a colour: as a fill it is the soft tone of a named colour, as a line or text its strong tone. */
export function paint(color: string | undefined, role: 'fill' | 'line'): string | undefined {
  if (isHex(color)) return color;
  if (color === 'ink') return role === 'fill' ? 'var(--panel)' : 'var(--ink)';
  if (isNamed(color)) return `var(--nc-${color}-${role === 'fill' ? 'fill' : 'stroke'})`;
  return undefined;
}

/** Black or white, whichever reads better on a freely picked fill. */
export function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#14171a' : '#ffffff';
}

// ---------------------------------------------------------------- which style applies

export const nodeTypeOf = (mode: Model['mode'], type: TermType): NodeType => (mode === 'skos' || type === 'concept' ? 'class' : type === 'property' ? 'dataProperty' : 'individual');

/** What kind of edge a relationship is drawn as. */
export function edgeTypeOf(r: { kind: string; predicate?: string }, is: { instanceOf: boolean; plain: boolean; restriction: boolean; betweenProperties: boolean }): EdgeType {
  if (is.instanceOf) return 'type';
  if (r.predicate === 'owl:equivalentClass') return 'equivalentClass';
  if (r.predicate === 'owl:disjointWith') return 'disjointWith';
  if (r.predicate === 'rdfs:domain') return 'domain';
  if (r.predicate === 'rdfs:range') return 'range';
  if (r.predicate === 'rdfs:subPropertyOf') return 'subPropertyOf';
  if (r.kind === 'generalization') return is.betweenProperties ? 'subPropertyOf' : 'subClassOf';
  if (r.predicate) return 'standard';
  if (r.kind === 'property') return 'dataProperty';
  if (is.restriction) return 'restriction';
  return is.plain ? 'plain' : 'objectProperty';
}

// A resolved style is worked out once for each style and then handed out as the same object, so
// that a node or an edge is only drawn again when its look really changed.
const resolved = new WeakMap<GraphStyle, Map<string, NodeStyle | EdgeStyle>>();
const cacheOf = (style: GraphStyle) => resolved.get(style) ?? resolved.set(style, new Map()).get(style)!;
const NONE: NodeStyle & EdgeStyle = Object.freeze({});

/**
 * The style of one term: its kind's, with its own on top. A term that has been given one of
 * the canvas colours keeps it over the colour of its kind: that too was a choice for this term.
 */
export function resolveNode(style: GraphStyle | undefined, type: NodeType, t: Pick<Term, 'id' | 'color'>): NodeStyle {
  if (!style) return NONE;
  const byType = style.nodeTypes[type];
  const own = style.nodes[t.id];
  if (!byType && !own) return NONE;
  const key = `n|${type}|${t.id}|${t.color}`;
  const cache = cacheOf(style);
  let out = cache.get(key) as NodeStyle | undefined;
  if (!out) {
    const base = { ...byType };
    if (t.color) {
      delete base.fill;
      delete base.stroke;
    }
    out = { ...base, ...own };
    cache.set(key, out);
  }
  return out;
}

export function resolveEdge(style: GraphStyle | undefined, type: EdgeType, id: string): EdgeStyle {
  if (!style) return NONE;
  const byType = style.edgeTypes[type];
  const own = style.edges[id];
  if (!byType && !own) return NONE;
  const key = `e|${type}|${id}`;
  const cache = cacheOf(style);
  let out = cache.get(key) as EdgeStyle | undefined;
  if (!out) cache.set(key, (out = { ...byType, ...own }));
  return out;
}

/** The dash pattern of a line style, scaled to the line's thickness so that a thick dotted line still reads as dots. */
export const dashOf = (line: LineStyle | undefined, width = 1.5): string | undefined => (line === 'solid' ? 'none' : line === 'dashed' ? `${4 * width} ${2.7 * width}` : line === 'dotted' ? `0.1 ${2.6 * width + 1}` : undefined);

/** The words on a node: its name, or its IRI in short or in full where that was asked for and it has one. */
export function labelText(model: Model, t: Pick<Term, 'name' | 'iri'>, mode: LabelMode | undefined): string {
  if (mode === 'iri' && t.iri) return t.iri;
  if (mode === 'curie' && t.iri) return compactIri(model, t.iri) ?? t.iri;
  return t.name || '';
}

// ---------------------------------------------------------------- changing it

const clean = <T extends object>(s: T): T => {
  const out = { ...s };
  for (const k of Object.keys(out) as (keyof T)[]) if (out[k] === undefined || out[k] === '') delete out[k];
  return out;
};
const setIn = <K extends string, T extends object>(map: Partial<Record<K, T>>, key: K, value: T): Partial<Record<K, T>> => {
  const next = { ...map };
  if (Object.keys(value).length) next[key] = value;
  else delete next[key];
  return next;
};

/** Changes the style of a kind of term. A property set to undefined goes back to the theme's. */
export const patchNodeType = (s: GraphStyle, type: NodeType, patch: NodeStyle): GraphStyle => ({ ...s, customized: true, nodeTypes: setIn(s.nodeTypes, type, clean({ ...s.nodeTypes[type], ...patch })) });
export const patchEdgeType = (s: GraphStyle, type: EdgeType, patch: EdgeStyle): GraphStyle => ({ ...s, customized: true, edgeTypes: setIn(s.edgeTypes, type, clean({ ...s.edgeTypes[type], ...patch })) });
/** Changes the style of single terms. A property set to undefined goes back to what the kind has. */
export const patchNodes = (s: GraphStyle, ids: string[], patch: NodeStyle): GraphStyle => ({ ...s, nodes: ids.reduce((map, id) => setIn(map, id, clean({ ...map[id], ...patch })) as Record<string, NodeStyle>, s.nodes) });
export const patchEdges = (s: GraphStyle, ids: string[], patch: EdgeStyle): GraphStyle => ({ ...s, edges: ids.reduce((map, id) => setIn(map, id, clean({ ...map[id], ...patch })) as Record<string, EdgeStyle>, s.edges) });
/** Takes the styles of their own away from these terms and relationships; they look like their kind again. */
export const resetOwn = (s: GraphStyle, nodes: string[], edges: string[]): GraphStyle => ({
  ...s,
  nodes: Object.fromEntries(Object.entries(s.nodes).filter(([id]) => !nodes.includes(id))),
  edges: Object.fromEntries(Object.entries(s.edges).filter(([id]) => !edges.includes(id))),
});

// ---------------------------------------------------------------- themes

export interface Theme {
  id: string;
  label: string;
  about: string;
  nodeTypes: GraphStyle['nodeTypes'];
  edgeTypes: GraphStyle['edgeTypes'];
}

const each = <K extends string, T>(keys: readonly K[], value: T): Record<K, T> => Object.fromEntries(keys.map((k) => [k, value])) as Record<K, T>;

/** The built-in themes. Their colours are the app's named ones, so each works in light and in dark mode. */
export const THEMES: Theme[] = [
  { id: 'standard', label: 'Standard', about: 'The app’s own look: rounded classes, dashed data properties, square individuals.', nodeTypes: {}, edgeTypes: {} },
  {
    id: 'professional',
    label: 'Professional',
    about: 'A shape for each kind of term, in restrained colours.',
    nodeTypes: { class: { shape: 'rounded', fill: 'blue' }, individual: { shape: 'ellipse', fill: 'amber' }, dataProperty: { shape: 'hexagon', fill: 'green' } },
    edgeTypes: { subClassOf: { width: 2 }, type: { line: 'dashed' }, plain: { line: 'dotted' }, equivalentClass: { color: 'green' }, disjointWith: { color: 'red', line: 'dashed' } },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    about: 'Plain rectangles and thin lines; the hierarchy and membership lines go unlabelled.',
    nodeTypes: each(NODE_TYPES, { shape: 'rectangle', strokeWidth: 1, fontWeight: 400 } as NodeStyle),
    edgeTypes: { ...each(EDGE_TYPES, { width: 1 } as EdgeStyle), subClassOf: { width: 1, labels: false }, type: { width: 1, labels: false, line: 'dashed' }, plain: { width: 1, line: 'dotted' } },
  },
  {
    id: 'highContrast',
    label: 'High contrast',
    about: 'Heavy outlines and lines in the text colour, with bold labels.',
    nodeTypes: { ...each(NODE_TYPES, { fill: 'ink', stroke: 'ink', strokeWidth: 2.5, fontWeight: 700, labelColor: 'ink' } as NodeStyle), individual: { shape: 'ellipse', fill: 'ink', stroke: 'ink', strokeWidth: 2.5, fontWeight: 700, labelColor: 'ink' } },
    edgeTypes: { ...each(EDGE_TYPES, { color: 'ink', width: 2, labelColor: 'ink', labelSize: 13 } as EdgeStyle), plain: { color: 'ink', width: 2, labelColor: 'ink', labelSize: 13, line: 'dotted' }, inferred: { color: 'ink', width: 2, labelColor: 'ink', labelSize: 13, line: 'dotted' } },
  },
  {
    id: 'colorful',
    label: 'Colorful',
    about: 'A colour and a shape for each kind of term and of relationship.',
    nodeTypes: { class: { shape: 'rounded', fill: 'blue', strokeWidth: 2 }, individual: { shape: 'circle', fill: 'pink', strokeWidth: 2 }, dataProperty: { shape: 'hexagon', fill: 'amber', strokeWidth: 2 } },
    edgeTypes: {
      subClassOf: { color: 'blue', width: 2 },
      type: { color: 'pink', width: 2 },
      restriction: { color: 'purple' },
      objectProperty: { color: 'teal' },
      dataProperty: { color: 'amber' },
      subPropertyOf: { color: 'blue' },
      equivalentClass: { color: 'green', width: 2 },
      disjointWith: { color: 'red', width: 2, line: 'dashed' },
      domain: { color: 'teal', line: 'dashed' },
      range: { color: 'teal', line: 'dashed' },
    },
  },
];

/** A style with a theme's styles by kind. The styles single terms and relationships have of their own stay. */
export const withTheme = (s: GraphStyle, theme: Pick<Theme, 'nodeTypes' | 'edgeTypes'> & { id?: string; name?: string }): GraphStyle => ({
  theme: theme.id ?? theme.name ?? 'standard',
  nodeTypes: structuredClone(theme.nodeTypes),
  edgeTypes: structuredClone(theme.edgeTypes),
  nodes: s.nodes,
  edges: s.edges,
});

/** A style someone saved under a name, to use again in any model: the styles by kind, not those of single terms. */
export interface SavedStyle {
  name: string;
  nodeTypes: GraphStyle['nodeTypes'];
  edgeTypes: GraphStyle['edgeTypes'];
}

// ---------------------------------------------------------------- reading it back

const num = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
const color = (v: unknown): string | undefined => (typeof v === 'string' && (isHex(v) || isNamed(v)) ? v.toLowerCase() : undefined);
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T | undefined => (all as readonly unknown[]).includes(v) ? (v as T) : undefined;

export function normalizeNodeStyle(raw: unknown): NodeStyle {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return clean({
    shape: oneOf(o.shape, SHAPES),
    fill: color(o.fill),
    stroke: color(o.stroke),
    strokeWidth: num(o.strokeWidth, 0, 8),
    width: num(o.width, 30, 400),
    height: num(o.height, 24, 300),
    fontSize: num(o.fontSize, 10, 24),
    fontWeight: num(o.fontWeight, 400, 700),
    labelColor: color(o.labelColor),
    label: oneOf(o.label, LABEL_MODES),
    opacity: num(o.opacity, 0.1, 1),
  });
}

export function normalizeEdgeStyle(raw: unknown): EdgeStyle {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return clean({
    color: color(o.color),
    width: num(o.width, 0.5, 8),
    line: oneOf(o.line, LINES),
    arrow: oneOf(o.arrow, ARROWS),
    labelSize: num(o.labelSize, 10, 20),
    labelColor: color(o.labelColor),
    curve: num(o.curve, -160, 160),
    labels: typeof o.labels === 'boolean' ? o.labels : undefined,
  });
}

const record = <T extends object>(raw: unknown, keep: (key: string) => boolean, read: (v: unknown) => T): Record<string, T> => {
  const out: Record<string, T> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = keep(k) ? read(v) : undefined;
      if (s && Object.keys(s).length) out[k] = s;
    }
  }
  return out;
};

export function normalizeByKind(raw: unknown): Pick<GraphStyle, 'nodeTypes' | 'edgeTypes'> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    nodeTypes: record(o.nodeTypes, (k) => (NODE_TYPES as readonly string[]).includes(k), normalizeNodeStyle),
    edgeTypes: record(o.edgeTypes, (k) => (EDGE_TYPES as readonly string[]).includes(k), normalizeEdgeStyle),
  };
}

/** A well-formed style from untrusted JSON. Styles of terms and relationships that no longer exist are dropped. */
export function normalizeGraphStyle(raw: unknown, termIds: Set<string>, relIds: Set<string>): GraphStyle {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    theme: typeof o.theme === 'string' && o.theme ? o.theme : 'standard',
    ...(o.customized === true ? { customized: true } : {}),
    ...normalizeByKind(o),
    nodes: record(o.nodes, (k) => termIds.has(k), normalizeNodeStyle),
    edges: record(o.edges, (k) => relIds.has(k), normalizeEdgeStyle),
  };
}

// ---------------------------------------------------------------- geometry

/** What the geometry needs to know of a node's style (see setNodeLook in geometry.ts). */
interface Look {
  shape?: Shape;
  width?: number;
  height?: number;
  fontSize?: number;
  fontWeight?: number;
  text?: string;
  datatype?: string;
}

/**
 * For a model, the function that says how each of its terms is drawn as far as geometry goes,
 * or null when every node is the standard box. What it returns is remembered per term, so asking
 * again while nothing changed costs a lookup.
 */
export function nodeLookFor(model: Model): ((t: Pick<Term, 'name' | 'type' | 'range'>) => Look | undefined) | null {
  const style = model.style;
  const enums = model.datatypes;
  if (!Object.keys(style.nodeTypes).length && !Object.keys(style.nodes).length && !enums.length) return null;
  const byTerm = new WeakMap<object, Look | null>();
  return (sized) => {
    const hit = byTerm.get(sized);
    if (hit !== undefined) return hit ?? undefined;
    const t = sized as Term;
    const ns = resolveNode(style, nodeTypeOf(model.mode, t.type), t);
    const text = ns.label && ns.label !== 'name' ? labelText(model, t, ns.label) : undefined;
    // A data property whose values are an enumerated datatype shows that datatype's name.
    const datatype = t.type === 'property' && t.range?.startsWith(ENUM_RANGE) ? enums.find((d) => d.id === t.range!.slice(ENUM_RANGE.length))?.name : undefined;
    const look: Look | null =
      ns.shape || ns.width || ns.height || ns.fontSize || ns.fontWeight || text !== undefined || datatype
        ? { shape: ns.shape, width: ns.width, height: ns.height, fontSize: ns.fontSize, fontWeight: ns.fontWeight, ...(text !== undefined ? { text } : {}), ...(datatype ? { datatype } : {}) }
        : null;
    byTerm.set(sized, look);
    return look ?? undefined;
  };
}
