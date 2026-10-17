import type { Model } from '../model/types';
import { LogicalError, type CallOptions, type ElementDescription, type EntityRow, type LogicalModel, type LogicalModelEditService, type LogicalModelInfo, type LogicalModelQueryService, type LogicalModelRef } from './contracts';
import { importLogicalModel } from './exchange';
import { hasPrimaryKey } from './edits';
import { applied, copied, countsOf, elementOf, emptyLogicalModel, newId, newRevision, problemsOf, supertypesOf } from './rules';

/**
 * The logical data model services over the project in the editor (roadmap LM-1): questions about
 * its LDMs, and changes to them, each one step of the document's history. The host gives the
 * model as it is and takes the next one; nothing of an LDM is read through `stable()` (TD-20),
 * and no change here touches anything but `Model.logicalModels`, so the ontology's revision does
 * not move (NFR-17).
 */

export interface LogicalHost {
  /** The model in the editor, as it is now. */
  current(): { model: Model };
  /** Makes `next` the model in the editor, as one step of the history. */
  commit(next: Model): void;
}

const aborted = (options?: CallOptions) => {
  if (options?.signal?.aborted) throw new LogicalError('aborted', 'The question was given up.');
};

const PAGE = 100;
const MAX_PAGE = 500;
const norm = (s: string) => s.trim().toLowerCase();

export function createLocalLogicalServices(host: LogicalHost): { query: LogicalModelQueryService; edit: LogicalModelEditService } {
  const all = () => host.current().model.logicalModels;
  /** The LDM a question is about, at the revision it names. */
  const ldm = (ref: LogicalModelRef): LogicalModel => {
    const m = all().find((x) => x.id === ref.model);
    if (!m) throw new LogicalError('not-found', `There is no logical model “${ref.model}” in the project.`);
    if (ref.revision !== undefined && ref.revision !== m.revision) throw new LogicalError('stale-revision', `The logical model “${m.name}” has moved on from revision ${ref.revision}.`);
    return m;
  };
  /** The project with its LDMs replaced: one step of the history. */
  const commit = (models: LogicalModel[]) => host.commit({ ...host.current().model, logicalModels: models });
  const unusedName = (name: string, except?: string) => {
    const taken = new Set(all().filter((x) => x.id !== except).map((x) => norm(x.name)));
    if (!taken.has(norm(name))) return name;
    for (let n = 2; ; n++) if (!taken.has(norm(`${name} (${n})`))) return `${name} (${n})`;
  };
  const info = (m: LogicalModel): LogicalModelInfo => ({ id: m.id, name: m.name, description: m.description, purpose: m.purpose, revision: m.revision, counts: countsOf(m) });

  const query: LogicalModelQueryService = {
    async models(options) {
      aborted(options);
      return all().map(info);
    },
    async model(ref, options) {
      aborted(options);
      return ldm(ref);
    },
    async entities(q, options) {
      aborted(options);
      const m = ldm(q);
      const supers = supertypesOf(m);
      const words = norm(q.search ?? '');
      const found = m.entities.filter((e) => !words || norm(e.name).includes(words) || norm(e.definition).includes(words)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const offset = Math.max(0, Math.floor(q.offset ?? 0));
      const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(q.limit ?? PAGE)));
      const items = found.slice(offset, offset + limit).map((e): EntityRow => ({ id: e.id, name: e.name, definition: e.definition, attributes: e.attributes.length, hasPrimaryKey: hasPrimaryKey(m, e.id), supertypes: supers.get(e.id) ?? [] }));
      return { revision: m.revision, total: found.length, offset, items };
    },
    async describe(q, options) {
      aborted(options);
      const m = ldm(q);
      const found = elementOf(m, q.element);
      if (!found) throw new LogicalError('not-found', 'The logical model has no such element.');
      const about = (id: string) => m.rules.filter((r) => r.appliesTo.some((x) => Object.values(x)[0] === id));
      let description: ElementDescription;
      switch (found.kind) {
        case 'entity': {
          const supers = supertypesOf(m).get(found.entity.id) ?? [];
          const byId = new Map(m.entities.map((e) => [e.id, e]));
          description = {
            kind: 'entity',
            entity: found.entity,
            inherited: supers.flatMap((s) => (byId.get(s)?.attributes ?? []).map((attribute) => ({ from: s, attribute }))),
            inheritedKeys: supers.flatMap((s) => (byId.get(s)?.keys ?? []).map((key) => ({ from: s, key }))),
            supertypes: supers,
            subtypes: m.entities.filter((e) => (supertypesOf(m).get(e.id) ?? []).includes(found.entity.id)).map((e) => e.id),
            relationships: m.relationships.filter((r) => r.ends.some((x) => x.entity === found.entity.id)),
            generalizations: m.generalizations.filter((g) => g.supertype === found.entity.id || g.subtypes.includes(found.entity.id)),
            rules: about(found.entity.id),
          };
          break;
        }
        case 'attribute':
          description = { kind: 'attribute', entity: found.entity, attribute: found.attribute, inKeys: m.entities.flatMap((e) => e.keys.filter((k) => k.members.some((x) => 'attribute' in x && x.attribute === found.attribute.id)).map((k) => k.id)), rules: about(found.attribute.id) };
          break;
        case 'relationship':
          description = { kind: 'relationship', relationship: found.relationship, rules: about(found.relationship.id) };
          break;
        case 'domain':
          description = { kind: 'domain', domain: found.domain, usedBy: m.entities.flatMap((e) => e.attributes.filter((a) => 'domain' in a.type && a.type.domain === found.domain.id).map((a) => ({ entity: e.id, attribute: a.id }))) };
          break;
        default:
          description = found as ElementDescription;
      }
      return { revision: m.revision, description };
    },
    async relationships(q, options) {
      aborted(options);
      const m = ldm(q);
      if (!m.entities.some((e) => e.id === q.entity)) throw new LogicalError('not-found', 'The logical model has no such entity.');
      return { revision: m.revision, items: m.relationships.filter((r) => r.ends.some((x) => x.entity === q.entity)) };
    },
  };

  const edit: LogicalModelEditService = {
    async create(input, options) {
      aborted(options);
      const name = input.name.trim();
      if (!name) throw new LogicalError('invalid', 'A logical model needs a name.', [{ code: 'invalid', message: 'A logical model needs a name.' }]);
      if (all().some((x) => norm(x.name) === norm(name))) throw new LogicalError('refused', `The project has a logical model called “${name}” already.`, [{ code: 'refused', message: `The project has a logical model called “${name}” already.` }]);
      const m = emptyLogicalModel({ name, description: input.description, purpose: input.purpose });
      commit([...all(), m]);
      return { model: m.id, revision: m.revision };
    },
    async duplicate(input, options) {
      aborted(options);
      const from = ldm({ model: input.model });
      const m = copied(from, unusedName(input.name?.trim() || `${from.name} (copy)`));
      commit([...all(), m]);
      return { model: m.id, revision: m.revision };
    },
    async remove(input, options) {
      aborted(options);
      ldm({ model: input.model });
      commit(all().filter((x) => x.id !== input.model));
    },
    async import(input, options) {
      aborted(options);
      const read = importLogicalModel(input.document);
      if ('error' in read) throw new LogicalError('invalid', read.error, [{ code: 'invalid', message: read.error }]);
      const problems = problemsOf(read);
      if (problems.length) throw new LogicalError('invalid', `The logical model in the file breaks the rules: ${problems[0].message}`, problems);
      // Its id and name are kept unless the project has them already.
      const m: LogicalModel = { ...read, id: all().some((x) => x.id === read.id) ? newId('ldm') : read.id, name: unusedName(read.name.trim() || 'Imported model'), revision: newRevision() };
      commit([...all(), m]);
      return { model: m.id, revision: m.revision, name: m.name };
    },
    async validate(changeSet, options) {
      aborted(options);
      if (!changeSet.changes?.length) return { ok: false, refusals: [{ code: 'invalid', message: 'The change set changes nothing.' }] };
      const result = applied(ldm({ model: changeSet.model, revision: changeSet.baseRevision }), changeSet.changes);
      return { ok: !result.refusals.length, refusals: result.refusals };
    },
    async apply(changeSet, options) {
      aborted(options);
      if (!changeSet.changes?.length) throw new LogicalError('invalid', 'The change set changes nothing.', [{ code: 'invalid', message: 'The change set changes nothing.' }]);
      const m = ldm({ model: changeSet.model, revision: changeSet.baseRevision });
      const result = applied(m, changeSet.changes);
      if (!result.next) throw new LogicalError(result.refusals.some((r) => r.code === 'invalid') ? 'invalid' : 'refused', result.refusals[0].message, result.refusals);
      const next = { ...result.next, revision: newRevision() };
      commit(all().map((x) => (x.id === m.id ? next : x)));
      return { model: m.id, revision: next.revision };
    },
  };
  return { query, edit };
}
