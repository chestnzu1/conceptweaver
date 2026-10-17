import type { LogicalModel } from './contracts';
import { logicalModelFrom } from './rules';

/**
 * One logical data model as a file of its own (FR-M17-15, DATA_ARCHITECTURE.md §11.3): the LDM as
 * it is held, in a documented, versioned envelope. A later version of the format reads every
 * earlier one; the project's own file carries its LDMs as they are, in the model.
 */

export const LDM_FORMAT = 'conceptweaver-ldm';
export const LDM_FORMAT_VERSION = 1;

/** An LDM written out, readable by people and by any later version of the app. */
export function exportLogicalModel(m: LogicalModel): string {
  return JSON.stringify({ format: LDM_FORMAT, version: LDM_FORMAT_VERSION, model: m }, null, 2) + '\n';
}

/** An LDM read from its file: what it is, or why it is not one. What does not read in it is left out, as in a project. */
export function importLogicalModel(text: string): LogicalModel | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'The file is not JSON.' };
  }
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  if (o?.format !== LDM_FORMAT) return { error: 'The file is not a logical data model of ConceptWeaver (its "format" is not "conceptweaver-ldm").' };
  if (typeof o.version !== 'number' || o.version > LDM_FORMAT_VERSION) return { error: `The file is of version ${String(o.version)} of the format, which this version of the app does not read.` };
  const m = logicalModelFrom(o.model);
  return m ?? { error: 'The file holds no logical data model.' };
}
