import { putVersion, storedVersion, storedVersions, type StoredVersion } from '../model/library';
import { toTurtle } from '../model/rdf';
import { shapesToTurtle } from '../model/shapes';
import { normalizeModel, uid, type Model } from '../model/types';
import { fingerprint } from '../model/validation';
import { ProjectError, type ProjectService, type StateRef, type VersionInfo } from './contracts';
import { difference } from './difference';

/**
 * The project service of the editor: the versions of the models in My Models, kept in this
 * browser's IndexedDB (library.ts), each with the whole model compressed (gzip, where the
 * browser has CompressionStream), and differences worked out here.
 */

/** What the service is given of the editor. */
export interface ProjectHost {
  /** The model in the editor, as it is now. */
  current(): Model;
  /** Puts a model in the editor in place of the one there, as one edit that undo takes back. */
  replace(model: Model): void;
}

/** A fingerprint of what a model states: the ontology, the shapes and the data graphs it names. Equal content, equal fingerprint. */
export const contentHash = (m: Model): string =>
  fingerprint(`${toTurtle(m)}\n${shapesToTurtle(m)}\n${m.dataGraphs.map((g) => `${g.id} ${g.fingerprint} ${g.includeOntology}`).join('\n')}${m.logicalModels.length ? `\n${JSON.stringify(m.logicalModels.map(({ revision: _r, diagrams: _d, ...content }) => content))}` : ''}`);

async function pack(model: Model): Promise<Pick<StoredVersion, 'packed' | 'data'>> {
  const json = JSON.stringify(model);
  if (typeof CompressionStream === 'undefined') return { packed: 'json', data: json };
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return { packed: 'gzip', data: await new Response(stream).arrayBuffer() };
}

async function unpack(v: StoredVersion): Promise<Model> {
  if (v.packed === 'json') return normalizeModel(JSON.parse(v.data as string));
  const stream = new Blob([v.data as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return normalizeModel(JSON.parse(await new Response(stream).text()));
}

/** A saved version's model and name, for reading it outside this service (traceability's between-versions impact). */
export async function storedModel(id: string): Promise<{ model: Model; name: string } | undefined> {
  const v = await storedVersion(id);
  return v ? { model: await unpack(v), name: v.name } : undefined;
}

const info = ({ packed: _p, data: _d, ...v }: StoredVersion): VersionInfo => v;

export function createLocalProjectService(host: ProjectHost): ProjectService {
  const found = async (project: string, id: string) => {
    const v = await storedVersion(id);
    if (!v || v.project !== project) throw new ProjectError('not-found', 'That version is not kept in this browser any more.');
    return v;
  };
  const state = async (project: string, ref: StateRef) => (ref === 'current' ? host.current() : unpack(await found(project, ref.version)));
  return {
    async versions(project) {
      return (await storedVersions(project)).map(info).reverse();
    },
    async saveVersion(project, name, summary) {
      if (!name.trim()) throw new ProjectError('invalid', 'A version needs a name.');
      const model = host.current();
      const all = await storedVersions(project);
      const v: StoredVersion = {
        id: uid(),
        project,
        seq: (all[all.length - 1]?.seq ?? 0) + 1,
        name: name.trim(),
        summary: summary.trim(),
        created: Date.now(),
        hash: contentHash(model),
        entities: model.terms.length + model.props.length,
        ...(await pack(model)),
      };
      await putVersion(v);
      return info(v);
    },
    async version(project, id) {
      return unpack(await found(project, id));
    },
    async diff(project, from, to) {
      return difference(await state(project, from), await state(project, to));
    },
    async restore(project, id) {
      const v = await found(project, id);
      host.replace(await unpack(v));
      return this.saveVersion(project, `Restored version ${v.seq}`, `“${v.name}”, as it was on ${new Date(v.created).toLocaleString()}`);
    },
  };
}
