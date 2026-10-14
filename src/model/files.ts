import { flushSync } from 'react-dom';
import { convertModel } from './convert';
import { beyondEnumerations, enumerationEdges } from './edgeKinds';
import { bounds } from './geometry';
import { htmlPage, LIGHT_TOKENS, viewerData, type Tokens } from './htmlExport';
import { entailed as entailedBy } from './inferred';
import { supports } from './modelTypes';
import { hasCardinality } from './props';
import { fromTurtle, toJsonLd, toTurtle, toTurtleWithInferred } from './rdf';
import { keptSummary } from './unmapped';
import { asTurtle, detectFormat, FORMAT_LABEL, type DocumentFormat, type DocumentSource } from './rdfFormats';
import { stable } from './stable';
import { routeOf } from '../layout/types';
import { currentDl, layoutOf, useStore, viewOf } from './store';
import { normalizeModel, type Model } from './types';

const fileBase = (m: Model) => m.name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'model';

export function download(name: string, data: string | Blob, mime = 'text/plain') {
  const url = URL.createObjectURL(typeof data === 'string' ? new Blob([data], { type: mime }) : data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csv = (rows: string[][]) =>
  rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n';

export function termsCsv(m: Model): string {
  return csv([['Name', 'Type', 'Description', 'Synonyms', 'IRI'], ...m.terms.map((t) => [t.name, t.type, t.description, t.synonyms, t.iri ?? ''])]);
}

export function relationsCsv(m: Model): string {
  const name = new Map(m.terms.map((t) => [t.id, t.name]));
  return csv([
    ['From', 'Label', 'To', 'Kind', 'From cardinality', 'To cardinality', 'Description'],
    ...m.relations.map((r) => [name.get(r.from) ?? '', r.label, name.get(r.to) ?? '', r.kind, ...(hasCardinality(m, r) ? [r.fromCard, r.toCard] : ['', '']), r.description]),
  ]);
}

/**
 * Reads an opened, dropped or fetched document into a model. JSON is the app's own format;
 * anything else is an ontology in one of the syntaxes of RDF and OWL, which is made Turtle first
 * (see rdfFormats.ts) and then read as Turtle is. Reading the syntaxes that are not Turtle is
 * not done at once: the engine for them is fetched when first needed, or the local OWL service
 * is asked.
 */
export async function readModelFile(text: string, fileName: string, source: Omit<DocumentSource, 'name'> = {}): Promise<{ model: Model; format: DocumentFormat; /** What the file states that the model has no place for, kept as it was: counted by kind. */ kept: string[] }> {
  const title = fileName.replace(/[?#].*$/, '').replace(/^.*\//, '').replace(/\.[^.]+$/, '') || 'Imported model';
  const format = detectFormat(text, fileName, source.contentType);
  if (format === 'model') return { model: normalizeModel(JSON.parse(text)), format, kept: [] };
  const { turtle } = await asTurtle(text, { ...source, name: fileName });
  let m: Model;
  try {
    m = fromTurtle(turtle, title);
  } catch (e) {
    // What the Turtle reader objects to in a file that was never Turtle would only mislead.
    throw new Error(format === 'turtle' ? `It is not well-formed Turtle: ${e instanceof Error ? e.message : String(e)}` : `It was read as ${FORMAT_LABEL[format]}, but what it holds could not be made a model: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!m.terms.length && !m.props.length) throw new Error(`No classes, concepts, properties or individuals were found in it (it was read as ${FORMAT_LABEL[format]}).`);
  return { model: m, format, kept: keptSummary(m.unmapped) };
}

const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'text-decoration-line',
  'paint-order',
];

/** Serialises the live canvas to a standalone SVG covering the whole model. */
function graphSvg(): { svg: string; w: number; h: number } | null {
  const store = useStore.getState();
  // Selection and spotlight styling shouldn't end up in the picture.
  flushSync(() => {
    store.select([]);
    store.setHighlight([]);
    store.setEditing(null);
  });
  const live = document.getElementById('graph-svg') as SVGSVGElement | null;
  // The picture is of what the canvas shows: the full graph, or the subgraph when that is on.
  const b = bounds(viewOf(useStore.getState()).terms);
  if (!live || !b) return null;
  const clone = live.cloneNode(true) as SVGSVGElement;
  const src = live.querySelectorAll('*');
  const dst = clone.querySelectorAll('*');
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const target = dst[i] as SVGElement;
    for (const p of STYLE_PROPS) target.style.setProperty(p, cs.getPropertyValue(p));
    target.removeAttribute('class');
  });
  clone.querySelectorAll('[data-noexport]').forEach((el) => el.remove());
  const pad = 70;
  const w = Math.ceil(b.x1 - b.x0 + pad * 2);
  const h = Math.ceil(b.y1 - b.y0 + pad * 2);
  clone.querySelector('[data-world]')?.setAttribute('transform', '');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${b.x0 - pad} ${b.y0 - pad} ${w} ${h}`);
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.removeAttribute('class');
  clone.removeAttribute('id');
  clone.removeAttribute('style');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', String(b.x0 - pad));
  bg.setAttribute('y', String(b.y0 - pad));
  bg.setAttribute('width', String(w));
  bg.setAttribute('height', String(h));
  bg.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#fff');
  clone.insertBefore(bg, clone.firstChild);
  return { svg: new XMLSerializer().serializeToString(clone), w, h };
}

async function exportPng(name: string) {
  const g = graphSvg();
  if (!g) return;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([g.svg], { type: 'image/svg+xml' }));
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not render the image.'));
    img.src = url;
  });
  URL.revokeObjectURL(url);
  // Stay under browser canvas limits for very large models.
  const scale = Math.min(2, 8000 / Math.max(g.w, g.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(g.w * scale);
  canvas.height = Math.round(g.h * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (blob) download(name, blob);
}

/**
 * The model as a page that opens on its own: the graph as the canvas shows it now, in the
 * colours the app is in now, with a list, a search and the details of whatever is clicked.
 */
function interactivePage(): string {
  const graph = graphSvg();
  const store = useStore.getState();
  const style = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries((Object.keys(LIGHT_TOKENS) as (keyof Tokens)[]).map((k) => [k, style.getPropertyValue('--' + k).trim() || LIGHT_TOKENS[k]])) as Tokens;
  // The picture is of what the canvas shows, which in a subgraph is part of the model. The page says so, and lists all of it.
  const shown = new Set(viewOf(store).terms.map((t) => t.id));
  // What the reasoner works out is in the picture when it was asked for on the canvas: the same, from the same reasoners.
  const entailed = store.showInferred && supports(store.model, 'reasoning') ? entailedBy(stable(store.model), currentDl(store)) : undefined;
  // Where the line of an enumeration is in the picture, the canvas leaves out the inferred membership it would repeat.
  const drawn = new Set(Array.from((graph?.svg ?? '').matchAll(/data-rel="([^"]+)"/g), (x) => x[1]));
  const inferred = beyondEnumerations(entailed?.memberships ?? [], enumerationEdges(store.model).filter((e) => drawn.has(e.id)));
  return htmlPage(viewerData(store.model, new Date(), { shown, inferred, facts: entailed?.facts ?? [], enumerations: store.showEnumerations, route: routeOf(layoutOf(store)) }), graph?.svg ?? '', tokens, store.theme === 'dark');
}

/**
 * The ontology as Turtle with what the chosen reasoner entails written out after it: inferred
 * class memberships and inferred relationships between individuals. Nothing is added to the
 * model. Where the reasoner has no answer, or finds the ontology inconsistent, there is nothing
 * to write: the reason is given and no file is made.
 */
export async function inferredTurtle(): Promise<{ text: string; count: number } | { error: string }> {
  let store = useStore.getState();
  if (!supports(store.model, 'reasoning')) return { error: 'There is no reasoning for this type of model, so nothing is inferred from it.' };
  if (store.validation.engine === 'dl' && !currentDl(store)) {
    // The OWL 2 DL reasoner is asked now, about the model as it is.
    await store.runValidation('owl');
    store = useStore.getState();
    if (!currentDl(store)) return { error: `The OWL 2 DL reasoner gave no answer, so there are no inferred assertions to export. ${store.validation.run?.owl?.errors?.[0] ?? ''}`.trim() };
  }
  const dl = currentDl(store);
  const found = entailedBy(stable(store.model), dl);
  if (!found.consistent) return { error: 'The ontology is inconsistent. From a contradiction everything follows, so nothing is exported as inferred. See the Validation tab.' };
  const notes = [...(found.partial ? ['The reasoning was partial, so more may follow than is written here.'] : []), ...(dl?.warnings ?? [])];
  const text = toTurtleWithInferred(store.model, { types: found.memberships.map((x) => ({ individual: x.from, class: x.to })), facts: found.facts.map((x) => ({ from: x.from, prop: x.prop, to: x.to })), by: found.by, notes });
  return { text, count: found.memberships.length + found.facts.length };
}

export type ExportFormat = 'json' | 'jsonld' | 'turtle' | 'owl' | 'owl-inferred' | 'skos' | 'csv-terms' | 'csv-relations' | 'svg' | 'png' | 'html';

export async function exportModel(format: ExportFormat) {
  const store = useStore.getState();
  const m = store.model;
  const base = fileBase(m);
  try {
    if (format === 'json') download(`${base}.json`, JSON.stringify(m, null, 2), 'application/json');
    else if (format === 'jsonld') download(`${base}.jsonld`, toJsonLd(m), 'application/ld+json');
    else if (format === 'turtle') download(`${base}.ttl`, toTurtle(m), 'text/turtle');
    // Either type on request, whatever the model currently is: it is converted on the way out.
    else if (format === 'owl') download(`${base}${m.mode === 'ontology' ? '' : '-ontology'}.ttl`, toTurtle(convertModel(m, 'ontology')), 'text/turtle');
    else if (format === 'owl-inferred') {
      const made = await inferredTurtle();
      if ('error' in made) store.notify(made.error);
      else {
        download(`${base}-with-inferred.ttl`, made.text, 'text/turtle');
        store.notify(`Exported with ${made.count} inferred assertion${made.count === 1 ? '' : 's'} written after the ontology. The model itself is unchanged.`);
      }
    }
    else if (format === 'skos') download(`${base}${m.mode === 'skos' ? '' : '-skos'}.ttl`, toTurtle(convertModel(m, 'skos')), 'text/turtle');
    else if (format === 'csv-terms') download(`${base}-terms.csv`, '﻿' + termsCsv(m), 'text/csv');
    else if (format === 'csv-relations') download(`${base}-relations.csv`, '﻿' + relationsCsv(m), 'text/csv');
    else if (!viewOf(store).terms.length) store.notify('Nothing to export yet.');
    else if (format === 'html') download(`${base}.html`, interactivePage(), 'text/html');
    else if (format === 'svg') download(`${base}.svg`, graphSvg()!.svg, 'image/svg+xml');
    else await exportPng(`${base}.png`);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : 'Export failed.');
  }
}
