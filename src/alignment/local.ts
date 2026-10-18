import { listMappings, mappingIssues, type Mapping, type MappingIssue } from '../model/alignment';
import { addExternal, collisions, copyEntities, importsClosure, iriKey, readExternal, removeExternal, reuseEntity, type Closure, type CopyResult, type Entity } from '../model/external';
import { suggestMappings, type Suggestion } from '../model/matcher';
import type { ExternalRef, Model } from '../model/types';
import { AlignmentError, type AlignmentHost, type AlignmentService, type OntologyContents, type OntologyPreview } from './contracts';

/**
 * The alignment service of the editor: the browser's cache and the model in it, behind the
 * contract. Content is read with the same reader as any model and kept apart from the active
 * one; only what the user copies in becomes part of it. An ontology imported by an ontology the
 * model imports is read too, by its ontology IRI, however deep the chain goes.
 */
export function createLocalAlignmentService(host: AlignmentHost): AlignmentService {
  const identity = (ref: ExternalRef) => ref.iri || ref.namespace || ref.id;

  /** One from the browser's cache, read as the model's reader reads it; nothing when it is not here or not readable. */
  const fromCache = async (ref: ExternalRef): Promise<Model | undefined> => {
    try {
      const text = await host.cached(ref.id, ref.iri);
      return text ? readExternal(text, ref.source || ref.name, ref.sourceKind).model : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    read(text, source, sourceKind): OntologyPreview {
      try {
        const summary = readExternal(text, source, sourceKind);
        return { summary, collisions: collisions(host.current(), summary.model) };
      } catch (e) {
        throw new AlignmentError('invalid', e instanceof Error ? e.message : 'It could not be read.');
      }
    },

    async contents(model, held = {}): Promise<OntologyContents> {
      const loaded: Record<string, Model> = {};
      const missing: ExternalRef[] = [];
      const noted = new Set<string>();
      const tried = new Set<string>();
      const byIri = new Map<string, Model>();
      const noteMissing = (ref: ExternalRef) => {
        if (noted.has(identity(ref))) return;
        noted.add(identity(ref));
        missing.push(ref);
      };
      /** Content under the keys the closure and the library look it up by: an id for a direct reference, the IRI for any ontology. */
      const keep = (ref: ExternalRef, ext: Model, direct: boolean) => {
        if (direct) loaded[ref.id] = ext;
        if (ref.iri) {
          loaded[iriKey(ref.iri)] = ext;
          byIri.set(ref.iri, ext);
        }
      };

      // Every ontology the model names, imported or only kept to browse.
      for (const ref of model.externals) {
        const known = held[ref.id] ?? (ref.iri ? (held[iriKey(ref.iri)] ?? held[ref.iri]) : undefined);
        if (known) {
          keep(ref, known, true);
          continue;
        }
        tried.add(identity(ref));
        const ext = await fromCache(ref);
        if (ext) keep(ref, ext, true);
        else noteMissing(ref);
      }

      // And the ones those import, for as long as the chain goes and this browser has them.
      const seen = new Set<string>();
      const queue = model.externals.filter((e) => e.imports);
      while (queue.length) {
        const ref = queue.shift()!;
        if (seen.has(identity(ref))) continue;
        seen.add(identity(ref));
        let ext: Model | undefined = byIri.get(ref.iri) ?? loaded[ref.id];
        if (!ext && !tried.has(identity(ref))) {
          tried.add(identity(ref));
          ext = await fromCache(ref);
        }
        if (!ext) {
          noteMissing(ref);
          continue;
        }
        keep(ref, ext, false);
        for (const next of ext.externals) if (next.imports) queue.push(next);
      }
      return { loaded, missing };
    },

    add(preview, imports, now): { model: Model; ref: ExternalRef } {
      return addExternal(host.current(), preview.summary, imports, now);
    },

    remove(id): Model {
      const result = removeExternal(host.current(), id);
      if (result.error !== undefined) throw new AlignmentError('in-use', result.error);
      return result.model;
    },

    reuse(ref, ext, entity): { model: Model; entity: Entity; added: boolean } {
      return reuseEntity(host.current(), ref, ext, entity);
    },

    copy(ref, ext, chosen): CopyResult {
      return copyEntities(host.current(), ref, ext, chosen);
    },

    closure(model, loaded): Closure {
      return importsClosure(model, loaded);
    },

    mappings(model): Mapping[] {
      return listMappings(model);
    },

    issues(model, mappings): MappingIssue[] {
      return mappingIssues(model, mappings);
    },

    suggest(model, external, mapped): Suggestion[] {
      return suggestMappings(model, external, { mapped });
    },
  };
}
