import type { Model, ModelMode, Relation } from './types';
import { labelKey, resolveModel } from './vocab';

/** How each SKOS relation is expressed in an ontology. `reverse` swaps the two ends. */
const SKOS_TO_OWL: Record<string, { kind: Relation['kind']; predicate?: string; label?: string; reverse?: boolean }> = {
  'skos:broader': { kind: 'generalization' },
  'skos:broadMatch': { kind: 'generalization' },
  'skos:narrowMatch': { kind: 'generalization', reverse: true },
  'skos:exactMatch': { kind: 'association', predicate: 'owl:equivalentClass' },
  'skos:closeMatch': { kind: 'association', predicate: 'rdfs:seeAlso' },
  'skos:related': { kind: 'association', label: 'related to' },
  'skos:relatedMatch': { kind: 'association', label: 'related to' },
};

/** The other direction. RDFS/OWL statements SKOS cannot say are kept as relationships with a plain label. */
const OWL_TO_SKOS: Record<string, { kind: Relation['kind']; predicate?: string; label?: string }> = {
  'rdfs:subClassOf': { kind: 'generalization' },
  'rdfs:subPropertyOf': { kind: 'generalization' },
  'rdf:type': { kind: 'generalization' },
  'owl:equivalentClass': { kind: 'association', predicate: 'skos:exactMatch' },
  'owl:equivalentProperty': { kind: 'association', predicate: 'skos:exactMatch' },
  'owl:sameAs': { kind: 'association', predicate: 'skos:exactMatch' },
  'rdfs:seeAlso': { kind: 'association', predicate: 'skos:related' },
  'owl:disjointWith': { kind: 'association', label: 'disjoint with' },
  'owl:complementOf': { kind: 'association', label: 'complement of' },
  'owl:differentFrom': { kind: 'association', label: 'different from' },
  'rdfs:domain': { kind: 'association', label: 'applies to' },
  'rdfs:range': { kind: 'association', label: 'has values in' },
};

/**
 * The same model as the other type: a SKOS concept scheme turned into an ontology (concepts
 * become classes, broader becomes "is a" / rdfs:subClassOf), or the reverse. Terms, their
 * labels and metadata are untouched; only what the relations mean is translated.
 */
export function convertModel(model: Model, to: ModelMode): Model {
  if (model.mode === to) return model;
  const table = to === 'ontology' ? SKOS_TO_OWL : OWL_TO_SKOS;
  const relations = resolveModel(model).relations.map((r): Relation => {
    const { predicate, ...rest } = r;
    const rule = predicate ? table[predicate] : undefined;
    if (!rule) {
      // No standard meaning: an unlabelled association is SKOS "related", which an ontology has to name.
      return to === 'ontology' && rest.kind === 'association' && !rest.label.trim() ? { ...rest, label: 'related to' } : rest;
    }
    const ends = 'reverse' in rule && rule.reverse ? { from: r.to, to: r.from, fromCard: r.toCard, toCard: r.fromCard } : {};
    return { ...rest, ...ends, kind: rule.kind, label: rest.label.trim() || rule.label || '', ...(rule.predicate ? { predicate: rule.predicate } : {}) };
  });
  // Label mappings carry over where the target has an equivalent standard property.
  const map: Record<string, string> = {};
  for (const [label, p] of Object.entries(model.vocab.map)) {
    const rule = table[p];
    const mapped = rule?.predicate ?? (rule?.kind === 'generalization' && !('reverse' in rule && rule.reverse) ? (to === 'ontology' ? 'rdfs:subClassOf' : 'skos:broader') : undefined);
    if (mapped) map[labelKey(label)] = mapped;
  }
  return { ...model, mode: to, vocab: { enabled: to === 'ontology' ? true : model.vocab.enabled, map }, relations };
}
