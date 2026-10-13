import viewerCss from '../export/viewer.css?raw';
import viewerJs from '../export/viewer.js?raw';
import { enumOf, literalText, rangeLabel } from './datatypes';
import { edgeLabelsOf, edgeTypesOf, enumerationEdges, ONE_OF_LABEL } from './edgeKinds';
import { edgeOffsets, nodeSize, routeHints, type EdgeAnchors } from './geometry';
import { fieldKey, fieldsFor, metaEntity, sameKey, valuesOf, type MetaEntity } from './governance';
import { nodeTypeOf, resolveEdge, resolveNode, type EdgeType } from './graphStyle';
import { baseIriOf } from './iri';
import { configOf } from './modelTypes';
import { compactIri, ontologyIriOf } from './prefixes';
import { CHARACTERISTICS, objectProperties } from './props';
import { routeOf, type Route } from '../layout/types';
import type { Model, Term } from './types';
import { resolveModel } from './vocab';

/**
 * The model as a page of its own: one HTML file that opens anywhere, with the graph as it is
 * drawn here, a list and a search, and everything known about whatever is clicked. The terms and
 * lines of the graph can be moved about, which rearranges the picture and nothing else: the page
 * reads the model, it does not edit it. It needs neither this app nor a network.
 *
 * Two halves. `viewerData` is the model boiled down to what the page shows, as plain data.
 * `htmlPage` wraps that data, the picture and the page's own script and stylesheet
 * (src/export/viewer.js and viewer.css) into the file.
 */

/** A value of a piece of metadata: text, or an entity of the model, or a link elsewhere. */
export interface ViewerValue {
  text: string;
  /** The id of the term it names, to jump to. */
  ref?: string;
  href?: string;
  lang?: string;
}

export interface ViewerTerm {
  id: string;
  name: string;
  /** concept, property or instance: which list it is in. */
  type: Term['type'];
  /** What that is called in this type of model: Class, Concept, Individual. */
  kind: string;
  iri?: string;
  curie?: string;
  x: number;
  y: number;
  /** Its size and outline in the picture, so that the page can move it and keep its lines attached. */
  w: number;
  h: number;
  shape: 'rect' | 'ellipse' | 'diamond' | 'hexagon';
  description: string;
  synonyms: string[];
  /** For a data property: the datatype of its values. */
  datatype?: string;
  /** For an individual: the values it has for data properties. */
  values: { prop: string; value: string }[];
  meta: { label: string; values: ViewerValue[] }[];
  external?: boolean;
}

export interface ViewerRel {
  id: string;
  from: string;
  to: string;
  /** The words on its line. */
  label: string;
  /** What kind of statement it is, in words. */
  kind: string;
  /** Part of the hierarchy ("is a", class membership), or what an enumeration class lists. */
  hier?: 'isa' | 'type' | 'oneOf';
  description: string;
  cards?: string;
  /** How its line is drawn: how far it bows sideways, and how it ends. The page redraws it from these when an end moves. */
  bend: number;
  head: 'filled' | 'hollow' | 'open' | 'none';
  /** Where a routed line arrives at its lower term, and whether its words go by the upper one: as the picture has them. */
  port?: number;
  labelUp?: boolean;
  /** The ends that were put somewhere on their terms by hand: the page keeps them there when a term is moved. */
  pins?: EdgeAnchors;
}

export interface ViewerProp {
  id: string;
  name: string;
  iri?: string;
  curie?: string;
  description: string;
  domain: string[];
  range: string[];
  characteristics: string[];
  /** Ids of the relationships that use it. */
  uses: string[];
  meta: { label: string; values: ViewerValue[] }[];
}

export interface ViewerData {
  model: { name: string; description: string; type: string; namespace: string; iri: string; lang: string; exported: string; partial: boolean };
  /** What things are called in this type of model. */
  words: { term: string; terms: string; parent: string; child: string; root: string; kinds: Record<Term['type'], { label: string; plural: string }> };
  terms: ViewerTerm[];
  rels: ViewerRel[];
  props: ViewerProp[];
  /** The hierarchy of classes or concepts: what is at the top, and what is under what. */
  tree: { roots: string[]; children: Record<string, string[]> };
  /** How the lines of the picture run: straight, curved or with right angles. The page draws a line the same way when its term is moved. */
  route: Route;
}

const KIND_WORDS: Record<EdgeType, string> = {
  subClassOf: 'is a',
  type: 'class membership',
  restriction: 'restriction',
  objectProperty: 'object property',
  dataProperty: 'data property',
  plain: 'relationship',
  subPropertyOf: 'subproperty',
  equivalentClass: 'owl:equivalentClass',
  disjointWith: 'owl:disjointWith',
  domain: 'rdfs:domain',
  range: 'rdfs:range',
  standard: 'standard property',
  oneOf: 'enumeration membership (owl:oneOf)',
  inferred: 'inferred',
};

/** What the picture that goes with the data has in it, where that is not simply the whole model as stored. */
export interface Picture {
  /** The terms in the picture, when that is not all of them (a subgraph). */
  shown?: Set<string>;
  /** Class memberships the reasoner worked out, when the picture has them. */
  inferred?: { id: string; from: string; to: string; because: string }[];
  /** Relationships between individuals the reasoner worked out, when the picture has them. */
  facts?: { id: string; from: string; to: string; name: string; because: string }[];
  /** False when the lines from enumeration classes to their members were switched off. */
  enumerations?: boolean;
  /** How the lines of the picture are routed, when it is not by the model's own layout (a subgraph has a layout of its own). */
  route?: Route;
}

/** What the page shows of a model. */
export function viewerData(model: Model, now = new Date(), picture: Picture = {}): ViewerData {
  const { shown, inferred = [], facts = [] } = picture;
  const config = configOf(model);
  const byIri = new Map(model.terms.filter((t) => t.iri).map((t) => [t.iri!, t]));
  const name = (id: string) => model.terms.find((t) => t.id === id)?.name || 'Unnamed';

  // The metadata an entity has: the fields of the registry that have a value, then whatever other annotations there are.
  const metaOf = (e: MetaEntity | undefined): ViewerTerm['meta'] => {
    if (!e) return [];
    const value = (v: { value: string; iri?: boolean; lang?: string }): ViewerValue => {
      if (!v.iri) return { text: v.value, ...(v.lang ? { lang: v.lang } : {}) };
      const term = byIri.get(v.value);
      if (term) return { text: term.name || 'Unnamed', ref: term.id };
      return { text: compactIri(model, v.value) ?? v.value, ...(/^https?:\/\//.test(v.value) ? { href: v.value } : {}) };
    };
    const fields = fieldsFor(model, e.kind).filter((f) => !f.bind || f.bind === 'range');
    const out: ViewerTerm['meta'] = [];
    for (const f of fields) {
      if (f.bind) continue;
      const values = valuesOf(model, e, f);
      if (values.length) out.push({ label: f.label, values: values.map(value) });
    }
    const covered = fields.filter((f) => !f.bind).map(fieldKey);
    const others = new Map<string, ViewerValue[]>();
    for (const x of e.fields) {
      if (!x.value.trim() || covered.some((k) => sameKey(k, x.key))) continue;
      others.set(x.key, [...(others.get(x.key) ?? []), value(x)]);
    }
    for (const [label, values] of others) out.push({ label, values });
    return out;
  };

  // The outline an edge has to meet: the page works out where lines end from this, as the canvas does.
  const shapeOf = (t: Term): ViewerTerm['shape'] => {
    const shape = resolveNode(model.style, nodeTypeOf(model.mode, t.type), t).shape;
    return shape === 'ellipse' || shape === 'circle' ? 'ellipse' : shape === 'diamond' || shape === 'hexagon' ? shape : 'rect';
  };
  const terms: ViewerTerm[] = model.terms.map((t) => ({
    id: t.id,
    name: t.name || 'Unnamed',
    type: config.termTypes.includes(t.type) ? t.type : config.termTypes[0],
    kind: config.termType[t.type].label,
    ...(t.iri ? { iri: t.iri, curie: compactIri(model, t.iri) ?? t.iri } : {}),
    x: t.x,
    y: t.y,
    ...nodeSize(t),
    shape: shapeOf(t),
    description: t.description,
    synonyms: t.synonyms.split(',').map((s) => s.trim()).filter(Boolean),
    // A standard datatype by its name; an enumerated one by its name and the values it lists.
    ...(t.type === 'property' && t.range ? { datatype: enumOf(model, t.range) ? `${rangeLabel(model, t.range)}: one of ${enumOf(model, t.range)!.values.map(literalText).join(', ') || '(no values yet)'}` : t.range } : {}),
    values: (t.values ?? []).map((v) => ({ prop: name(v.prop), value: v.value + (v.lang ? ` @${v.lang}` : '') })),
    meta: metaOf(metaEntity(model, { term: t.id })),
    ...(t.external !== undefined ? { external: true } : {}),
  }));

  const types = edgeTypesOf(model);
  const labels = edgeLabelsOf(model);
  const ids = new Set(model.terms.map((t) => t.id));
  const resolved = resolveModel(model).relations.filter((r) => ids.has(r.from) && ids.has(r.to));
  // Lines between the same two terms fan out. Only the ones in the picture take part, as on the canvas.
  const inPicture = (r: { from: string; to: string }) => !shown || (shown.has(r.from) && shown.has(r.to));
  // What each enumeration class lists is a line too, though no relationship of the model: it is listed with the class either way.
  const listed = enumerationEdges(model);
  const offsets = edgeOffsets([...resolved.filter(inPicture), ...inferred.filter(inPicture), ...facts.filter(inPicture), ...(picture.enumerations === false ? [] : listed.filter(inPicture))]);
  const rels: ViewerRel[] = resolved
    .map((r) => {
      const type = types.get(r.id) ?? 'plain';
      const es = resolveEdge(model.style, type, r.id);
      const cards = [r.fromCard, r.toCard].some(Boolean) ? `${r.fromCard || '…'} to ${r.toCard || '…'}` : '';
      return {
        id: r.id,
        from: r.from,
        to: r.to,
        label: labels.get(r.id) || (type === 'subClassOf' || type === 'subPropertyOf' ? config.hierarchy.relation : 'related to'),
        kind: type === 'standard' ? (r.predicate ?? KIND_WORDS.standard) : type === 'subClassOf' ? `${config.hierarchy.relation} (${config.hierarchy.predicate})` : KIND_WORDS[type],
        ...(type === 'subClassOf' || type === 'subPropertyOf' ? { hier: 'isa' as const } : type === 'type' ? { hier: 'type' as const } : {}),
        description: r.description,
        ...(cards ? { cards } : {}),
        bend: (offsets.get(r.id) ?? 0) + (es.curve ?? 0),
        head: es.arrow ?? (r.kind === 'generalization' ? ('hollow' as const) : ('filled' as const)),
        ...(model.style.anchors[r.id] ? { pins: model.style.anchors[r.id] } : {}),
      };
    });
  // What the reasoner worked out is in the picture when it was asked for, and so is listed, marked as inferred.
  const inferredStyle = resolveEdge(model.style, 'inferred', '');
  for (const x of inferred) {
    if (!ids.has(x.from) || !ids.has(x.to)) continue;
    rels.push({ id: x.id, from: x.from, to: x.to, label: 'Is Instance Of (inferred)', kind: 'inferred class membership', description: x.because, bend: (offsets.get(x.id) ?? 0) + (inferredStyle.curve ?? 0), head: inferredStyle.arrow ?? 'hollow' });
  }
  for (const x of facts) {
    if (!ids.has(x.from) || !ids.has(x.to)) continue;
    rels.push({ id: x.id, from: x.from, to: x.to, label: `${x.name} (inferred)`, kind: 'inferred relationship', description: x.because, bend: (offsets.get(x.id) ?? 0) + (inferredStyle.curve ?? 0), head: inferredStyle.arrow ?? 'filled' });
  }
  const oneOfStyle = resolveEdge(model.style, 'oneOf', '');
  for (const x of listed) rels.push({ id: x.id, from: x.from, to: x.to, label: ONE_OF_LABEL, kind: KIND_WORDS.oneOf, hier: 'oneOf', description: x.because, bend: (offsets.get(x.id) ?? 0) + (oneOfStyle.curve ?? 0), head: oneOfStyle.arrow ?? 'filled' });

  // Lines that are routed keep the places the picture gave them among the others at their terms.
  const route = picture.route ?? routeOf(model.layout);
  const drawn = new Map(model.terms.filter((t) => !shown || shown.has(t.id)).map((t) => [t.id, t]));
  for (const [id, hint] of routeHints(rels.filter((r) => picture.enumerations !== false || r.hier !== 'oneOf'), drawn, route)) Object.assign(rels.find((r) => r.id === id)!, { ...(hint.port ? { port: hint.port } : {}), ...(hint.labelUp ? { labelUp: true } : {}) });

  const props: ViewerProp[] =
    model.mode === 'skos'
      ? []
      : objectProperties(model).map((p) => ({
          id: 'prop:' + p.key,
          name: p.name,
          ...(p.iri ? { iri: p.iri, curie: compactIri(model, p.iri) ?? p.iri } : {}),
          description: p.description,
          domain: p.domain.map(name),
          range: p.range.map(name),
          characteristics: CHARACTERISTICS.filter((c) => p.chars.includes(c.id)).map((c) => c.label),
          uses: p.rels.map((r) => r.id),
          meta: metaOf(metaEntity(model, { prop: p.key })),
        }));

  // The hierarchy: every class or concept under what it is a kind of. Ones that are each other's
  // ancestors have no top among them; one of each such ring is put at the top so that all are shown.
  const inTree = new Set(terms.filter((t) => t.type === 'concept').map((t) => t.id));
  const children: Record<string, string[]> = {};
  const hasParent = new Set<string>();
  for (const r of rels) {
    if (r.hier !== 'isa' || !inTree.has(r.from) || !inTree.has(r.to) || r.from === r.to) continue;
    if (!(children[r.to] ??= []).includes(r.from)) children[r.to].push(r.from);
    hasParent.add(r.from);
  }
  const byName = (a: string, b: string) => name(a).localeCompare(name(b));
  for (const list of Object.values(children)) list.sort(byName);
  const roots = [...inTree].filter((id) => !hasParent.has(id)).sort(byName);
  const reached = new Set<string>();
  const walk = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    (children[id] ?? []).forEach(walk);
  };
  roots.forEach(walk);
  for (const id of [...inTree].sort(byName)) {
    if (reached.has(id)) continue;
    roots.push(id);
    walk(id);
  }

  // On the page a list is headed by the full name of what is in it: "Data properties", where the app's narrow sidebar says "Properties".
  const plural = (k: { label: string; plural: string }) => ({ label: k.label, plural: k.label === 'Data property' ? 'Data properties' : k.plural });
  return {
    model: {
      name: model.name,
      description: model.description,
      type: config.label,
      namespace: baseIriOf(model),
      iri: ontologyIriOf(model),
      lang: model.lang,
      exported: now.toISOString(),
      partial: !!shown && shown.size < model.terms.length,
    },
    words: { term: config.termType.concept.label, terms: config.termType.concept.plural, parent: config.hierarchy.parent, child: config.hierarchy.child, root: config.hierarchy.root, kinds: { concept: plural(config.termType.concept), property: plural(config.termType.property), instance: plural(config.termType.instance) } },
    terms,
    rels,
    props,
    tree: { roots, children },
    route,
  };
}

/** The colours of the page, as the app has them. The picture is drawn in them already, so the page around it has to match. */
export type Tokens = Record<'bg' | 'canvas' | 'panel' | 'panel-2' | 'line' | 'line-strong' | 'ink' | 'ink-2' | 'ink-3' | 'accent' | 'accent-soft' | 'on-accent', string>;
export const LIGHT_TOKENS: Tokens = { bg: '#f4f2ec', canvas: '#faf9f5', panel: '#ffffff', 'panel-2': '#f6f5f0', line: '#e2dfd5', 'line-strong': '#c9c5b8', ink: '#1d2126', 'ink-2': '#4a5058', 'ink-3': '#636971', accent: '#0f766e', 'accent-soft': '#d9f0ec', 'on-accent': '#ffffff' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The whole page as one string. Everything is in it: nothing is fetched when it is opened.
 * The model's own words reach the page only as data, which the script puts in as text, so
 * nothing in a name or a description can run as markup or as script.
 */
export function htmlPage(data: ViewerData, svg: string, tokens: Tokens = LIGHT_TOKENS, dark = false): string {
  // Inside a script element only "</" could end it early; a "<" written as an escape cannot.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const vars = Object.entries(tokens)
    .map(([k, v]) => `--${k}:${v.replace(/[;{}<>]/g, '')}`)
    .join(';');
  return `<!doctype html>
<html lang="${esc(data.model.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="ConceptWeaver">
<title>${esc(data.model.name)}</title>
<style>:root{${vars};color-scheme:${dark ? 'dark' : 'light'}}
${viewerCss}</style>
</head>
<body>
<header class="top">
  <h1 id="title"></h1>
  <span id="type" class="chip"></span>
  <label class="search"><span class="sr">Search the model</span><input id="q" type="search" placeholder="Search by name or IRI" autocomplete="off"></label>
</header>
<div class="layout">
  <nav id="nav" aria-label="Entities of the model"></nav>
  <main id="graph" aria-label="Graph of the model">
    ${svg || '<p class="empty">There is no picture of this model: it has no terms on the canvas.</p>'}
    <div class="zoom" role="group" aria-label="Zoom">
      <button id="zoom-out" type="button" aria-label="Zoom out" title="Zoom out">−</button>
      <button id="zoom-in" type="button" aria-label="Zoom in" title="Zoom in">+</button>
      <button id="zoom-fit" type="button" title="Show the whole graph">Fit</button>
      <button id="layout-reset" type="button" title="Put every term and relationship back where it was when the page was exported" hidden>Reset layout</button>
    </div>
  </main>
  <aside id="detail" aria-label="Details" aria-live="polite"></aside>
</div>
<script type="application/json" id="model-data">${json}</script>
<script>
${viewerJs}
</script>
</body>
</html>
`;
}
