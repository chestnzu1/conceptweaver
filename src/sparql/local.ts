import { entailed } from '../model/inferred';
import { importsClosure } from '../model/external';
import { supports } from '../model/modelTypes';
import { reason } from '../model/reasoner';
import { prefixesOf, toTurtle, toTurtleWithInferred } from '../model/rdf';
import { queryTurtle } from '../model/sparql';
import { stable } from '../model/stable';
import type { Model } from '../model/types';
import type { ReasoningResult } from '../model/reasoning';
import { ontologyRef } from '../structure/local';
import { DEFAULT_GRAPH, GRAPHS, SparqlError, type CallOptions, type MissingImport, type OntologyRef, type SparqlAnswer, type SparqlQuery, type SparqlService } from './contracts';

/**
 * The SPARQL service of the editor: the query is run in the page, over the model as it is.
 *
 * The three graphs are the three ways the model is already written as RDF: its own Turtle for
 * the asserted graph; the Turtle of the imports closure for the graph with what it imports; and
 * for the inferred graph, that Turtle followed by the assertions a reasoner entails, exactly as
 * the owl-inferred export writes them. A query is refused rather than answered if the ontology
 * has moved on from the revision it names, as with the other services.
 */

/** What the local service is given of the editor: the ontology as it is, and what this browser keeps of what it imports. */
export interface SparqlHost {
  /** The ontology being edited, as it is now, with the OWL 2 DL reasoner's answer where it was asked. */
  current(): { model: Model; docId: string | null; dl?: ReasoningResult };
  /**
   * What this browser keeps of the ontologies the model imports, directly or through another,
   * and the ones whose content is not here. Read when the query reads the graph with imports.
   */
  imports(): Promise<{ loaded: Record<string, Model>; missing: { id: string; name: string; iri?: string }[] }>;
}

/** The prefixes of the model and of what it imports, the model's first: a name means the model's own. */
function mergedPrefixes(model: Model, imported: Model[]): [string, string][] {
  const seen = new Map<string, string>();
  for (const [prefix, namespace] of [...prefixesOf(model), ...imported.flatMap((m) => prefixesOf(m))]) if (!seen.has(prefix)) seen.set(prefix, namespace);
  return [...seen];
}

/** What to say about ontologies the graph with imports had to leave out. */
function missingNotes(missing: MissingImport[]): string[] {
  if (!missing.length) return [];
  const names = missing.map((m) => `“${m.name}”`).join(', ');
  const one = missing.length === 1;
  return [`${names} ${one ? 'is' : 'are'} imported, but ${one ? 'its content is' : 'their content is'} not in this browser, so the query read the graph without ${one ? 'it' : 'them'}.`];
}

export function createLocalSparqlService(host: SparqlHost): SparqlService {
  /** The revision the question names, refused if the ontology has left it, or if the question was given up. */
  const at = (query: OntologyRef, options?: CallOptions) => {
    if (options?.signal?.aborted) throw new SparqlError('aborted', 'The question was given up.');
    const now = host.current();
    const ref = ontologyRef(now.model, now.docId);
    if (query.ontologyId !== ref.ontologyId || query.revisionId !== ref.revisionId) throw new SparqlError('stale-revision', 'The ontology has changed since this was asked about.');
    return { ...now, ref };
  };

  /** Runs the query over a graph, its engine errors as the refusal that they are; anything else is a fault of the service. */
  const run = async (model: Model, turtle: string, query: string, prefixes: [string, string][], options?: CallOptions): Promise<SparqlAnswer['result']> => {
    try {
      const result = await queryTurtle(model, turtle, query, prefixes);
      if (options?.signal?.aborted) throw new SparqlError('aborted', 'The question was given up.');
      return result;
    } catch (e) {
      if (e instanceof SparqlError) throw e;
      throw new SparqlError('invalid', e instanceof Error ? e.message : String(e));
    }
  };

  return {
    async query(query: SparqlQuery, options?: CallOptions): Promise<SparqlAnswer> {
      const { model, dl, ref } = at(query, options);
      const graph = query.graph ?? DEFAULT_GRAPH;
      if (!GRAPHS.includes(graph)) throw new SparqlError('invalid', `“${String(graph)}” is not a graph a query can read: it is asserted, imports or inferred.`);
      const text = query.text ?? '';

      let result: SparqlAnswer['result'];
      let notes: string[] = [];
      let missing: MissingImport[] | undefined;

      if (graph === 'asserted') {
        result = await run(model, toTurtle(model), text, prefixesOf(model), options);
      } else if (graph === 'imports') {
        const contents = await host.imports();
        // Reading what this browser keeps may have taken a moment; the ontology must not have changed under it.
        at(ref, options);
        const loaded = new Map(Object.entries(contents.loaded));
        const closure = importsClosure(model, loaded);
        missing = contents.missing.map((m) => ({ id: m.id, name: m.name, ...(m.iri ? { iri: m.iri } : {}) }));
        notes = missingNotes(missing);
        result = await run(model, toTurtle(closure.model), text, mergedPrefixes(model, [...new Set(Object.values(contents.loaded))]), options);
      } else {
        if (!supports(model, 'reasoning')) throw new SparqlError('unsupported', 'There is no reasoning for this type of model, so nothing is inferred from it.');
        const m = stable(model);
        const found = entailed(m, reason(m), dl);
        if (!found.consistent) throw new SparqlError('inconsistent', 'The ontology is inconsistent. From a contradiction everything follows, so nothing is queried as inferred. See the Validation tab.');
        notes = [...(found.partial ? ['The reasoning was partial, so more may follow than this query shows.'] : []), ...(dl?.warnings ?? [])];
        const turtle = toTurtleWithInferred(model, { types: found.memberships.map((x) => ({ individual: x.from, class: x.to })), facts: found.facts.map((x) => ({ from: x.from, prop: x.prop, to: x.to })), by: found.by, notes });
        result = await run(model, turtle, text, prefixesOf(m), options);
      }

      // The query ran while the model was being edited: the answer is about a revision that is gone.
      at(ref, options);
      return { ...ref, graph, result, notes, ...(missing?.length ? { missing } : {}) };
    },
  };
}
