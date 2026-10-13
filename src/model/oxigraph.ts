/**
 * The RDF engine the app has for what it does not do itself: SPARQL queries, and reading the RDF
 * syntaxes other than Turtle. It is a 4 MB WebAssembly module, so it is fetched only when one of
 * those is first asked for, and once.
 */

export interface OxStore {
  load(input: string, options: { format: string; base_iri?: string }): void;
  query(query: string, options?: { results_format?: string }): unknown;
  /** The triples of one graph, written in a syntax. */
  dump(options: { format: string; from_graph_name?: unknown }): string;
}

/** A term as the engine has it; written out, it is the term in N-Triples. */
export interface OxTerm {
  termType: string;
  value: string;
  toString(): string;
}

export interface OxQuad {
  subject: OxTerm;
  predicate: OxTerm;
  object: OxTerm;
}

export interface Oxigraph {
  Store: new () => OxStore;
  defaultGraph: () => unknown;
  /** The statements of a document, in the order it has them and with every literal as it was written. */
  parse(input: string, options: { format: string; base_iri?: string }): OxQuad[];
}

let engine: Promise<Oxigraph> | undefined;

export function loadOxigraph(): Promise<Oxigraph> {
  engine ??= import('oxigraph').then(async (mod) => {
    const init = (mod as unknown as { default?: unknown }).default;
    // The browser build has to be initialised; the Node build (used by the tests) does not.
    if (typeof init === 'function') await init();
    return mod as unknown as Oxigraph;
  });
  return engine;
}
