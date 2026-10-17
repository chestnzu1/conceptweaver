import { nameIn } from './labels';
import { compactIri } from './prefixes';
import { assertedSuperclasses } from './props';
import type { Model } from './types';

/**
 * The class hierarchy as a tree for navigation: owl:Thing at the top, each class under every
 * superclass that is explicitly stated for it. Only stated relationships are used, nothing
 * inferred, and nothing here changes the model.
 */

/** Stands for owl:Thing (or, in a concept scheme, the scheme): the parent of every class that has no stated superclass. */
export const ROOT = '#root';

export interface ClassTree {
  /** Subclasses of each class, sorted by name. `ROOT` lists the classes at the top. */
  children: Map<string, string[]>;
  /** The stated superclasses of each class that are classes themselves. */
  parents: Map<string, string[]>;
  /** How many classes there are. */
  size: number;
}

const cache = new WeakMap<Model, ClassTree>();

export function classTree(model: Model): ClassTree {
  const hit = cache.get(model);
  if (hit) return hit;
  const classes = model.terms.filter((t) => t.type === 'concept');
  const isClass = new Set(classes.map((t) => t.id));
  const name = new Map(classes.map((t) => [t.id, t.name]));
  const children = new Map<string, string[]>([[ROOT, []]]);
  const parents = new Map<string, string[]>();
  for (const t of classes) {
    // A class is listed under each of its superclasses, so one with two parents appears twice.
    const supers = assertedSuperclasses(model, t.id).filter((p) => isClass.has(p) && p !== t.id);
    parents.set(t.id, supers);
    for (const p of supers.length ? supers : [ROOT]) (children.get(p) ?? children.set(p, []).get(p)!).push(t.id);
  }
  // Classes that are only each other's ancestors have no way down from the top. One of each
  // such group is put at the top as well, so that every class can be reached.
  const reached = new Set<string>();
  const walk = (start: string) => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      stack.push(...(children.get(id) ?? []));
    }
  };
  walk(ROOT);
  for (const t of [...classes].sort((a, b) => a.name.localeCompare(b.name))) {
    if (reached.has(t.id)) continue;
    children.get(ROOT)!.push(t.id);
    walk(t.id);
  }
  const byName = (a: string, b: string) => (name.get(a) ?? '').localeCompare(name.get(b) ?? '') || a.localeCompare(b);
  for (const list of children.values()) list.sort(byName);
  const tree = { children, parents, size: classes.length };
  cache.set(model, tree);
  return tree;
}

/** Every class above the given ones, by any chain of stated superclasses. */
export function ancestorsOf(tree: ClassTree, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    for (const p of tree.parents.get(stack.pop()!) ?? []) {
      if (out.has(p)) continue;
      out.add(p);
      stack.push(p);
    }
  }
  return out;
}

/** The classes whose name, synonyms, description or IRI (in full or with a prefix) contain the text. */
export function matchingClasses(model: Model, text: string, lang = ''): Set<string> {
  const q = text.trim().toLowerCase();
  const out = new Set<string>();
  if (!q) return out;
  for (const t of model.terms) {
    if (t.type !== 'concept') continue;
    // The name it is shown by, whichever language is shown, and the names it is kept under.
    const hay = `${nameIn(t, model.lang, lang)}\n${t.name}\n${t.synonyms}\n${t.description}\n${t.iri ?? ''}\n${t.iri ? (compactIri(model, t.iri) ?? '') : ''}`.toLowerCase();
    if (hay.includes(q)) out.add(t.id);
  }
  return out;
}

/** Which classes start out expanded: all of a small hierarchy, the top two levels of a large one. */
export function defaultOpen(tree: ClassTree): Set<string> {
  const open = new Set<string>([ROOT]);
  if (tree.size <= 60) {
    for (const id of tree.children.keys()) open.add(id);
    return open;
  }
  for (const id of tree.children.get(ROOT) ?? []) open.add(id);
  return open;
}

export interface TreeRow {
  /** Unique per place in the tree: the same class under two parents has two keys. */
  key: string;
  id: string;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  /** The class is one of its own ancestors here; the branch is not followed further. */
  cycle: boolean;
}

/**
 * The rows to draw: the tree walked from the top, going into a class only if it is open. With
 * `only`, the walk keeps to those classes (search results and what leads to them) and every one
 * of them counts as open.
 */
export function treeRows(tree: ClassTree, open: Set<string>, only?: Set<string>, limit = 4000): TreeRow[] {
  const rows: TreeRow[] = [];
  const path: string[] = [];
  const visit = (id: string, depth: number, key: string) => {
    if (rows.length >= limit) return;
    const cycle = path.includes(id);
    const kids = cycle ? [] : (tree.children.get(id) ?? []).filter((k) => !only || only.has(k));
    const isOpen = !cycle && kids.length > 0 && (only ? true : open.has(id));
    rows.push({ key, id, depth, hasChildren: kids.length > 0, open: isOpen, cycle });
    if (!isOpen) return;
    path.push(id);
    for (const k of kids) visit(k, depth + 1, `${key}/${k}`);
    path.pop();
  };
  visit(ROOT, 0, ROOT);
  return rows;
}
