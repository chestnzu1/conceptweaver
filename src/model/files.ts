import { flushSync } from 'react-dom';
import { convertModel } from './convert';
import { bounds } from './geometry';
import { fromTurtle, toJsonLd, toTurtle } from './rdf';
import { useStore, viewOf } from './store';
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
    ...m.relations.map((r) => [name.get(r.from) ?? '', r.label, name.get(r.to) ?? '', r.kind, r.fromCard, r.toCard, r.description]),
  ]);
}

/** Reads a dropped/opened file into a model. JSON is our own format; anything else is tried as Turtle. */
export function parseModelFile(text: string, fileName: string): Model {
  const head = text.trimStart();
  const title = fileName.replace(/\.[^.]+$/, '');
  if (head.startsWith('{')) {
    const json = JSON.parse(text);
    if (json['@context'] || json['@graph']) throw new Error('JSON-LD import is not supported yet. Convert the file to Turtle first.');
    return normalizeModel(json);
  }
  if (head.startsWith('<?xml') || head.startsWith('<rdf:RDF') || head.startsWith('<Ontology')) {
    throw new Error('RDF/XML is not supported. Save the ontology as Turtle (.ttl) and import that.');
  }
  const m = fromTurtle(text, title);
  if (!m.terms.length) throw new Error('No classes, concepts or properties found in this file.');
  return m;
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

export type ExportFormat = 'json' | 'jsonld' | 'turtle' | 'owl' | 'skos' | 'csv-terms' | 'csv-relations' | 'svg' | 'png';

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
    else if (format === 'skos') download(`${base}${m.mode === 'skos' ? '' : '-skos'}.ttl`, toTurtle(convertModel(m, 'skos')), 'text/turtle');
    else if (format === 'csv-terms') download(`${base}-terms.csv`, '﻿' + termsCsv(m), 'text/csv');
    else if (format === 'csv-relations') download(`${base}-relations.csv`, '﻿' + relationsCsv(m), 'text/csv');
    else if (!viewOf(store).terms.length) store.notify('Nothing to export yet.');
    else if (format === 'svg') download(`${base}.svg`, graphSvg()!.svg, 'image/svg+xml');
    else await exportPng(`${base}.png`);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : 'Export failed.');
  }
}
