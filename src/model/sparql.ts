import { loadOxigraph, type OxStore } from './oxigraph';
import { compactIri, longestMatch } from './prefixes';
import { prefixesOf, toTurtle } from './rdf';
import type { Model } from './types';

export interface Cell {
  kind: 'iri' | 'literal' | 'bnode';
  /** Full IRI, literal text, or blank node label. */
  value: string;
  /** How it is displayed: IRIs shortened to prefixed names. */
  text: string;
  lang?: string;
}

export type SparqlResult =
  | { type: 'select'; vars: string[]; rows: (Cell | null)[][] }
  | { type: 'ask'; value: boolean }
  /** CONSTRUCT / DESCRIBE: one row per triple. */
  | { type: 'graph'; vars: string[]; rows: (Cell | null)[][] };

interface OxTerm {
  termType: string;
  value: string;
  language?: string;
}
const loadEngine = loadOxigraph;

let cached: { turtle: string; store: OxStore } | undefined;

/** Leading comments and PREFIX / BASE declarations, to find the query form behind them. */
const PROLOGUE = /^(\s*(#[^\n]*\n|(PREFIX\s+[^\s:]*:\s*<[^>]*>|BASE\s*<[^>]*>)))*\s*/i;

/** Runs a read-only SPARQL query over the model's RDF (the same graph as the Turtle export). */
export async function runSparql(model: Model, query: string): Promise<SparqlResult> {
  return queryTurtle(model, toTurtle(model), query, prefixesOf(model));
}

/**
 * Runs a read-only SPARQL query over a graph given as Turtle. `model` is what IRIs are shortened
 * by, and `prefixes` are what the query may use without declaring them: the model's own, and
 * after them those of whatever else the graph holds (the imports closure). The engine is loaded
 * on first use, and the store it loads the graph into is kept for as long as the graph is the
 * same, so asking again about an unchanged graph costs only the query.
 */
export async function queryTurtle(model: Model, turtle: string, query: string, prefixes: [string, string][]): Promise<SparqlResult> {
  const form = query.replace(PROLOGUE, '').match(/^(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i)?.[1].toUpperCase();
  if (!form) {
    throw new Error(
      /^\s*(#[^\n]*\n|\s|PREFIX[^\n]*\n)*(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|WITH|COPY|MOVE|ADD)\b/i.test(query)
        ? 'Updates are not supported here: the query runs on a read-only copy of the model. Edit the model in the Graph or Table view.'
        : 'Expected a SELECT, ASK, CONSTRUCT or DESCRIBE query.',
    );
  }
  const { Store } = await loadEngine();
  if (cached?.turtle !== turtle) {
    const store = new Store();
    store.load(turtle, { format: 'text/turtle' });
    cached = { turtle, store };
  }

  // Prefixes the query doesn't declare itself are added on one line, so error positions shift by one line only.
  const declared = new Set([...query.matchAll(/PREFIX\s+([^\s:]*):/gi)].map((m) => m[1]));
  const header = prefixes.filter(([p]) => !declared.has(p)).map(([p, ns]) => `PREFIX ${p}: <${ns}>`).join(' ');
  const text = header + '\n' + query;

  const short = (iri: string) => compactIri(model, iri) ?? longestMatch(prefixes, iri) ?? `<${iri}>`;
  const cell = (type: string, value: string, lang?: string): Cell =>
    type === 'uri' || type === 'NamedNode'
      ? { kind: 'iri', value, text: short(value) }
      : type === 'bnode' || type === 'BlankNode'
        ? { kind: 'bnode', value, text: '_:' + value }
        : { kind: 'literal', value, text: value, ...(lang ? { lang } : {}) };

  try {
    if (form === 'CONSTRUCT' || form === 'DESCRIBE') {
      const quads = cached.store.query(text) as { subject: OxTerm; predicate: OxTerm; object: OxTerm }[];
      return {
        type: 'graph',
        vars: ['subject', 'predicate', 'object'],
        rows: quads.map((q) => [q.subject, q.predicate, q.object].map((t) => cell(t.termType, t.value, t.language))),
      };
    }
    const json = JSON.parse(cached.store.query(text, { results_format: 'application/sparql-results+json' }) as string) as {
      boolean?: boolean;
      head?: { vars?: string[] };
      results?: { bindings: Record<string, { type: string; value: string; 'xml:lang'?: string }>[] };
    };
    if (typeof json.boolean === 'boolean') return { type: 'ask', value: json.boolean };
    const vars = json.head?.vars ?? [];
    return {
      type: 'select',
      vars,
      rows: (json.results?.bindings ?? []).map((b) => vars.map((v) => (b[v] ? cell(b[v].type, b[v].value, b[v]['xml:lang']) : null))),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Undo the one-line shift caused by the added prefix header.
    throw new Error(msg.replace(/\bat (\d+):(\d+)/, (_all, line: string, col: string) => `at line ${Math.max(1, +line - 1)}, column ${col}`));
  }
}

export const SPARQL_EXAMPLES: { name: string; query: string }[] = [
  {
    name: 'Classes and their parents',
    query: `SELECT ?class ?label ?parent
WHERE {
  ?class a owl:Class ;
         rdfs:label ?label .
  OPTIONAL { ?class rdfs:subClassOf ?parent . FILTER(isIRI(?parent)) }
}
ORDER BY ?label`,
  },
  {
    name: 'All ancestors (transitive)',
    query: `# The + follows rdfs:subClassOf any number of steps.
SELECT ?class ?ancestor
WHERE {
  ?class rdfs:subClassOf+ ?ancestor .
  FILTER(isIRI(?ancestor))
}
ORDER BY ?class ?ancestor`,
  },
  {
    name: 'Relationships between classes',
    query: `SELECT ?from ?relationship ?to
WHERE {
  ?p a owl:ObjectProperty ;
     rdfs:label ?relationship ;
     rdfs:domain ?from ;
     rdfs:range ?to .
}
ORDER BY ?from ?relationship`,
  },
  {
    name: 'Restrictions on classes',
    query: `SELECT ?class ?property ?quantifier ?filler
WHERE {
  ?class rdfs:subClassOf ?r .
  ?r a owl:Restriction ;
     owl:onProperty ?property ;
     ?quantifier ?filler .
  FILTER(?quantifier IN (owl:someValuesFrom, owl:allValuesFrom, owl:onClass, owl:onDataRange))
}
ORDER BY ?class ?property`,
  },
  {
    name: 'Object properties and their characteristics',
    query: `SELECT ?property ?label (GROUP_CONCAT(DISTINCT STRAFTER(STR(?kind), "#"); separator=", ") AS ?kinds) ?inverse ?parent
WHERE {
  ?property a owl:ObjectProperty ;
            a ?kind ;
            rdfs:label ?label .
  OPTIONAL { ?property owl:inverseOf ?inverse }
  OPTIONAL { ?property rdfs:subPropertyOf ?parent }
}
GROUP BY ?property ?label ?inverse ?parent
ORDER BY ?label`,
  },
  {
    name: 'Properties and who owns them',
    query: `SELECT ?property ?owner
WHERE {
  ?property a owl:DatatypeProperty .
  OPTIONAL { ?property rdfs:domain ?owner }
}
ORDER BY ?owner ?property`,
  },
  {
    name: 'Instances and their types',
    query: `SELECT ?individual ?type
WHERE {
  ?individual a owl:NamedIndividual ;
              a ?type .
  FILTER(?type != owl:NamedIndividual)
}
ORDER BY ?individual`,
  },
  {
    name: 'Terms without a definition',
    query: `SELECT ?term ?label
WHERE {
  ?term rdfs:label ?label .
  FILTER NOT EXISTS { ?term skos:definition ?d }
  FILTER NOT EXISTS { ?term a owl:Ontology }
  FILTER NOT EXISTS { ?term a owl:ObjectProperty }
}
ORDER BY ?label`,
  },
  {
    name: 'Count terms by kind',
    query: `SELECT ?kind (COUNT(?term) AS ?count)
WHERE { ?term a ?kind }
GROUP BY ?kind
ORDER BY DESC(?count)`,
  },
  {
    name: 'Ask: is any class a subclass of another?',
    query: `ASK { ?a rdfs:subClassOf ?b . FILTER(isIRI(?b)) }`,
  },
  {
    name: 'Construct: the hierarchy only',
    query: `CONSTRUCT { ?child rdfs:subClassOf ?parent }
WHERE {
  ?child rdfs:subClassOf ?parent .
  FILTER(isIRI(?parent))
}`,
  },
  {
    name: 'Every triple',
    query: `SELECT ?s ?p ?o
WHERE { ?s ?p ?o }
LIMIT 500`,
  },
];

export const SKOS_EXAMPLES: { name: string; query: string }[] = [
  {
    name: 'Concepts and their broader concept',
    query: `SELECT ?concept ?label ?broader
WHERE {
  ?concept a skos:Concept ;
           skos:prefLabel ?label .
  OPTIONAL { ?concept skos:broader ?broader }
}
ORDER BY ?label`,
  },
  {
    name: 'Top concepts',
    query: `SELECT ?concept ?label
WHERE {
  ?scheme skos:hasTopConcept ?concept .
  ?concept skos:prefLabel ?label .
}
ORDER BY ?label`,
  },
  {
    name: 'Everything under a concept (transitive)',
    query: `# The + follows skos:broader any number of steps.
SELECT ?concept ?ancestor
WHERE { ?concept skos:broader+ ?ancestor }
ORDER BY ?ancestor ?concept`,
  },
  {
    name: 'Labels in every language',
    query: `SELECT ?concept ?kind ?label (LANG(?label) AS ?language)
WHERE {
  VALUES ?kind { skos:prefLabel skos:altLabel skos:hiddenLabel }
  ?concept a skos:Concept ;
           ?kind ?label .
}
ORDER BY ?concept ?kind ?language`,
  },
  {
    name: 'Concepts missing a label in a language',
    query: `# Change "nl" to the language you are translating into.
SELECT ?concept ?label
WHERE {
  ?concept a skos:Concept ;
           skos:prefLabel ?label .
  FILTER NOT EXISTS { ?concept skos:prefLabel ?other . FILTER(LANG(?other) = "nl") }
}
ORDER BY ?label`,
  },
  {
    name: 'Concepts without a definition',
    query: `SELECT ?concept ?label
WHERE {
  ?concept a skos:Concept ;
           skos:prefLabel ?label .
  FILTER NOT EXISTS { ?concept skos:definition ?d }
}
ORDER BY ?label`,
  },
  {
    name: 'Related concepts and mappings',
    query: `SELECT ?concept ?relation ?other
WHERE {
  VALUES ?relation { skos:related skos:exactMatch skos:closeMatch skos:broadMatch skos:narrowMatch skos:relatedMatch }
  ?concept ?relation ?other .
}
ORDER BY ?relation ?concept`,
  },
  {
    name: 'Number of narrower concepts',
    query: `SELECT ?label (COUNT(?narrower) AS ?narrowerConcepts)
WHERE {
  ?concept skos:prefLabel ?label .
  ?narrower skos:broader ?concept .
}
GROUP BY ?label
ORDER BY DESC(?narrowerConcepts)`,
  },
  {
    name: 'Every triple',
    query: `SELECT ?s ?p ?o
WHERE { ?s ?p ?o }
LIMIT 500`,
  },
];

export const examplesFor = (mode: Model['mode']) => (mode === 'skos' ? SKOS_EXAMPLES : SPARQL_EXAMPLES);
