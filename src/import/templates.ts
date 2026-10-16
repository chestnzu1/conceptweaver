import type { TabularMapping } from '../mapping/contracts';

/**
 * Import templates (FR-M7-5): a mapping saved by name, with how its file is read, to import the
 * next file laid out the same way the same way. A mapping names columns by their header, so it
 * fits any file with those columns. Kept in this browser, for whoever imports here.
 */
export interface ImportTemplate {
  name: string;
  mapping: TabularMapping;
  /** The header row (1-based; 0 for none), and for a workbook the sheet by name. */
  header: number;
  sheet?: string;
  saved: number;
}

const KEY = 'conceptweaver:import-templates';

export function loadTemplates(): ImportTemplate[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((t): t is ImportTemplate => !!t && typeof t === 'object' && typeof (t as ImportTemplate).name === 'string' && !!(t as ImportTemplate).mapping) : [];
  } catch {
    return [];
  }
}

/** Saves a template under its name, in place of one of that name. Resolves to whether it is kept beyond this page. */
export function saveTemplate(t: Omit<ImportTemplate, 'saved'>): boolean {
  const all = [...loadTemplates().filter((x) => x.name !== t.name), { ...t, saved: Date.now() }].sort((a, b) => a.name.localeCompare(b.name));
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function deleteTemplate(name: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadTemplates().filter((x) => x.name !== name)));
  } catch {
    // Nothing kept to take away.
  }
}
