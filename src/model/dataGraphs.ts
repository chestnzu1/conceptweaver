import { Parser } from 'n3';
import { MODEL_DATA, type DataGraph } from '../validation/contracts';
import { dataGraphsKept, keepDataGraph, keptDataGraph } from './library';
import { asTurtle } from './rdfFormats';
import { uid, type DataGraphRef, type Model } from './types';
import { fingerprint } from './validation';

/**
 * The data graphs of a model (roadmap stage SH-2): RDF read from files to validate the shapes
 * against, beside the model's own individuals. The model keeps what each is (Model.dataGraphs),
 * so they are saved, opened and undone with it; the content, which can be large, is kept as
 * Turtle in this browser's IndexedDB under the graph's id (library.ts). None of it is ever part
 * of the ontology.
 */

/** The content of the data graphs read in this session, so that a run does not wait on the database for it. */
const read = new Map<string, string>();

/** A data graph read from a file: what the model keeps of it, and its content. */
export async function readDataGraph(text: string, file: string, serviceUrl: string, id: string = uid()): Promise<{ ref: DataGraphRef; turtle: string }> {
  // Data comes in the syntaxes an ontology does; it is kept as Turtle, which is what the checks read.
  const { turtle, format } = await asTurtle(text, { name: file, serviceUrl });
  const triples = new Parser().parse(turtle).length;
  return { ref: { id, name: file.replace(/\.[^.]+$/, '') || file, file, format, triples, fingerprint: fingerprint(turtle), includeOntology: true, read: Date.now() }, turtle };
}

/**
 * Keeps the content of a data graph in this browser. Resolves to whether it is kept beyond this
 * session: where the browser keeps nothing for the site, it is there until the page is closed.
 */
export async function keepGraphText(id: string, turtle: string): Promise<boolean> {
  read.set(id, turtle);
  try {
    await keepDataGraph(id, turtle);
    return true;
  } catch {
    return false;
  }
}

/** The content of a data graph, as Turtle: nothing where it is not in this browser. */
export async function graphText(id: string): Promise<string | undefined> {
  if (read.has(id)) return read.get(id);
  try {
    const text = await keptDataGraph(id);
    if (text !== undefined) read.set(id, text);
    return text;
  } catch {
    return undefined;
  }
}

/** Which of these data graphs have their content here: read in this session, or kept in this browser. */
export async function graphsHere(ids: string[]): Promise<Set<string>> {
  let kept = new Set<string>();
  try {
    kept = await dataGraphsKept(ids);
  } catch {
    // The browser keeps nothing for the site: only what was read in this session is here.
  }
  return new Set(ids.filter((id) => read.has(id) || kept.has(id)));
}

/** A data graph of the model as validation takes it, without its content. */
export const dataOf = (g: DataGraphRef): DataGraph => ({ source: 'graph', id: g.id, name: g.name, fingerprint: g.fingerprint, includeOntology: g.includeOntology, ...(g.format === 'turtle' ? { lines: true } : {}) });

/**
 * The data graph chosen, as it is now in the model: its name, content and setting may have changed
 * since it was chosen. One that is no longer in the model leaves the model's own data.
 */
export function currentData(model: Model, chosen: DataGraph): DataGraph {
  if (chosen.source !== 'graph') return MODEL_DATA;
  const g = model.dataGraphs.find((x) => x.id === chosen.id);
  return g ? dataOf(g) : MODEL_DATA;
}

/** The shape set chosen, while it is in the model; every set otherwise. */
export const currentShapeSet = (model: Model, chosen: string | null): string | undefined => (chosen && model.shapeSets.some((s) => s.id === chosen) ? chosen : undefined);
