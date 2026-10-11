import { compactIri } from './prefixes';
import { objectProperties, propKey } from './props';
import type { Model, Relation } from './types';
import { resolveModel } from './vocab';

/**
 * Subgraph extraction: which terms and relationships to show when the canvas is focused on a
 * few chosen terms. Pure functions over the model; nothing here draws or changes anything.
 *
 * Traversal runs on the graph the canvas draws, not on the RDF. So an object-property
 * restriction is one edge from the restricted class to the class it points to (there is no
 * blank node to step through), a data property is a node attached by its "has" edge, and the
 * domain and range of an object property are not edges at all, because object properties are
 * not nodes on the canvas.
 */

export type Direction = 'both' | 'out' | 'in';

export interface SubgraphOptions {
  /** The chosen terms the subgraph grows from. */
  roots: string[];
  /** How many steps out from the roots: 0 shows the roots alone. */
  depth: number;
  direction: Direction;
  /** Relationship types that are switched off (see `edgeType`). */
  off: string[];
  /** Terms whose direct neighbours are shown whatever the depth. */
  expanded: string[];
  /** Terms taken out of the view by hand. */
  hidden: string[];
  /** Upper limit on the number of terms shown. */
  maxNodes: number;
}

export interface Subgraph {
  /** Visible term ids, roots first, then in the order they were reached. */
  terms: string[];
  /** Ids of the relationships between visible terms. */
  rels: string[];
  /** For each visible term that isn't a root: the visible term it was reached from. */
  via: Map<string, string>;
  /** For each visible term: how many of its neighbours (by the current filters) are not shown. */
  more: Map<string, number>;
  /** The limit on terms was reached, so the subgraph is incomplete. */
  truncated: boolean;
}

export const MAX_DEPTH = 6;
export const DEFAULT_MAX_NODES = 250;

interface Edge {
  rel: string;
  other: string;
  type: string;
}

interface Index {
  out: Map<string, Edge[]>;
  in: Map<string, Edge[]>;
  /** Relationship id → its type. */
  type: Map<string, string>;
  /** The types present in the model, with how many relationships each has. */
  types: { key: string; label: string; count: number }[];
}

const LABELS: Record<string, string> = {
  restriction: 'Restrictions (object properties)',
  data: 'Data properties (has)',
  fact: 'Facts between individuals',
  plain: 'Plain relationships',
};

const cache = new WeakMap<Model, Index>();

/**
 * The type of each relationship as the canvas shows it: the hierarchy by what it means
 * ("rdfs:subClassOf", "rdf:type", "rdfs:subPropertyOf", or "skos:broader"), a standard
 * RDFS/OWL/SKOS property by its name, and the rest as restrictions, data properties, facts
 * between individuals, or plain relationships.
 */
function buildIndex(model: Model): Index {
  const hit = cache.get(model);
  if (hit) return hit;
  const m = resolveModel(model);
  const type = new Map(m.terms.map((t) => [t.id, t.type]));
  const declared = new Set(m.mode === 'skos' ? [] : objectProperties(model).map((p) => p.key));
  const index: Index = { out: new Map(), in: new Map(), type: new Map(), types: [] };
  const counts = new Map<string, number>();
  const kindOf = (r: Relation): string => {
    const a = type.get(r.from);
    const b = type.get(r.to);
    if (r.predicate) return r.predicate;
    if (r.kind === 'generalization') {
      if (m.mode === 'skos') return 'skos:broader';
      return a === 'instance' && b === 'concept' ? 'rdf:type' : a === 'property' && b === 'property' ? 'rdfs:subPropertyOf' : 'rdfs:subClassOf';
    }
    if (r.kind === 'property') return 'data';
    if (m.mode === 'skos') return r.label.trim() ? 'plain' : 'skos:related';
    if (r.plain || !declared.has(propKey(r.label))) return 'plain';
    return a === 'concept' && b === 'concept' ? 'restriction' : 'fact';
  };
  const push = (map: Map<string, Edge[]>, key: string, e: Edge) => (map.get(key) ?? map.set(key, []).get(key)!).push(e);
  for (const r of m.relations) {
    if (!type.has(r.from) || !type.has(r.to)) continue;
    const t = kindOf(r);
    index.type.set(r.id, t);
    counts.set(t, (counts.get(t) ?? 0) + 1);
    push(index.out, r.from, { rel: r.id, other: r.to, type: t });
    push(index.in, r.to, { rel: r.id, other: r.from, type: t });
  }
  // Hierarchy first, then the app's own kinds, then standard properties by name.
  const order = ['rdfs:subClassOf', 'skos:broader', 'rdf:type', 'rdfs:subPropertyOf', 'restriction', 'data', 'fact', 'plain'];
  index.types = [...counts]
    .map(([key, count]) => ({ key, label: LABELS[key] ?? key, count }))
    .sort((x, y) => (order.indexOf(x.key) + 1 || 99) - (order.indexOf(y.key) + 1 || 99) || x.key.localeCompare(y.key));
  cache.set(model, index);
  return index;
}

/** The relationship types present in the model, for the filter. */
export const edgeTypes = (model: Model) => buildIndex(model).types;

/**
 * The terms within `depth` steps of the roots (following only the enabled relationship types,
 * in the chosen direction), plus the direct neighbours of every expanded term, and all enabled
 * relationships between the terms that end up visible.
 */
export function extractSubgraph(model: Model, o: SubgraphOptions): Subgraph {
  const index = buildIndex(model);
  const known = new Set(model.terms.map((t) => t.id));
  const off = new Set(o.off);
  const hidden = new Set(o.hidden);
  const expanded = new Set(o.expanded);
  const depth = Math.max(0, Math.min(MAX_DEPTH, Math.floor(o.depth)));
  const limit = Math.max(1, o.maxNodes);
  const roots = [...new Set(o.roots)].filter((id) => known.has(id));
  const neighbours = (id: string): Edge[] => [
    ...(o.direction !== 'in' ? (index.out.get(id) ?? []) : []),
    ...(o.direction !== 'out' ? (index.in.get(id) ?? []) : []),
  ];

  // Breadth-first from the roots. A term reached again by a shorter way is revisited, so that
  // an expanded term deep in the graph does not cut short what the depth would have shown.
  const dist = new Map<string, number>();
  const via = new Map<string, string>();
  const order: string[] = [];
  let truncated = false;
  const queue: string[] = [];
  for (const id of roots) {
    if (order.length >= limit) {
      truncated = true;
      break;
    }
    dist.set(id, 0);
    order.push(id);
    queue.push(id);
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const d = dist.get(id)!;
    // An expanded term shows its neighbours even at the edge of the depth, but they are leaves.
    const grows = d < depth || expanded.has(id);
    if (!grows) continue;
    for (const e of neighbours(id)) {
      if (off.has(e.type) || hidden.has(e.other) || e.other === id) continue;
      const next = d < depth ? d + 1 : depth + 1;
      const seen = dist.get(e.other);
      if (seen !== undefined) {
        if (next < seen) {
          dist.set(e.other, next);
          queue.push(e.other);
        }
        continue;
      }
      if (order.length >= limit) {
        truncated = true;
        continue;
      }
      dist.set(e.other, next);
      via.set(e.other, id);
      order.push(e.other);
      queue.push(e.other);
    }
  }

  const visible = new Set(order);
  const rels: string[] = [];
  const more = new Map<string, number>();
  for (const id of order) {
    for (const e of index.out.get(id) ?? []) if (visible.has(e.other) && !off.has(e.type)) rels.push(e.rel);
    const unseen = new Set<string>();
    for (const e of neighbours(id)) if (!off.has(e.type) && !visible.has(e.other) && !hidden.has(e.other) && e.other !== id) unseen.add(e.other);
    if (unseen.size) more.set(id, unseen.size);
  }
  return { terms: order, rels, via, more, truncated };
}

/** Terms whose name or IRI contains the text, best matches first, for choosing roots. */
export function searchTerms(model: Model, text: string, limit = 8): { id: string; name: string; type: string }[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const scored: { id: string; name: string; type: string; score: number }[] = [];
  for (const t of model.terms) {
    const name = t.name.toLowerCase();
    // By name first, then by synonym or by IRI, in full or written with a prefix ("ex:Actor").
    const iri = t.iri ? `${t.iri}\n${compactIri(model, t.iri) ?? ''}`.toLowerCase() : '';
    const score = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : iri.includes(q) || t.synonyms.toLowerCase().includes(q) ? 3 : -1;
    if (score >= 0) scored.push({ id: t.id, name: t.name || 'Unnamed', type: t.type, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name)).slice(0, limit);
}
