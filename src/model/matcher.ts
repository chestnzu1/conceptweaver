import { assertedSuperclasses } from './props';
import type { Model, Term } from './types';

/**
 * Candidate mappings: pairs of a local and an external entity that look alike.
 *
 * Everything here is a heuristic over names, definitions and position in the hierarchy. A
 * score says how alike two descriptions are; it is not a probability that the entities are the
 * same, and nothing is ever asserted from it. Each candidate says which features it rests on.
 *
 * A matcher is a function from two lists of entities to candidates. More can be added to
 * MATCHERS (one using embeddings, say) without changing anything that uses the suggestions.
 */

export type MatchKind = 'class' | 'object property' | 'data property' | 'individual';

export interface Matchable {
  /** Term id, or object property key. */
  id: string;
  prop: boolean;
  iri: string;
  kind: MatchKind;
  name: string;
  alt: string[];
  definition: string;
  /** Names of what it is directly a kind of. */
  parents: string[];
  /** Other annotation values, for spotting shared codes and notations. */
  values: string[];
}

export interface Feature {
  label: string;
  /** How much this feature alone would make the pair alike, 0 to 1. */
  score: number;
}

export interface Suggestion {
  key: string;
  local: Matchable;
  external: Matchable;
  /** 0 to 1. Comparable between suggestions; not a likelihood. */
  score: number;
  features: Feature[];
}

export type Matcher = (local: Matchable[], external: Matchable[]) => Suggestion[];

const kindOf = (t: Term): MatchKind => (t.type === 'concept' ? 'class' : t.type === 'property' ? 'data property' : 'individual');

/** The entities of a model as the matchers see them. With `externalToo` false, references to other ontologies are left out. */
export function matchables(model: Model, externalToo = true): Matchable[] {
  const name = new Map(model.terms.map((t) => [t.id, t.name]));
  const out: Matchable[] = [];
  for (const t of model.terms) {
    if (!t.iri || (!externalToo && t.external !== undefined)) continue;
    out.push({
      id: t.id,
      prop: false,
      iri: t.iri,
      kind: kindOf(t),
      name: t.name,
      alt: [...t.synonyms.split(','), ...t.fields.filter((f) => /label$/i.test(f.key)).map((f) => f.value)].map((x) => x.trim()).filter(Boolean),
      definition: t.description,
      parents: assertedSuperclasses(model, t.id).map((id) => name.get(id) ?? '').filter(Boolean),
      values: t.fields.filter((f) => !/label$|definition|comment|note/i.test(f.key)).map((f) => f.value.trim()).filter((v) => v.length > 1),
    });
  }
  for (const p of model.props) {
    if (!p.iri || (!externalToo && p.external !== undefined)) continue;
    out.push({ id: p.id, prop: true, iri: p.iri, kind: 'object property', name: p.name, alt: (p.fields ?? []).filter((f) => /label$/i.test(f.key)).map((f) => f.value), definition: p.description, parents: p.parents ?? [], values: [] });
  }
  return out;
}

const STOP = new Set('a an the of and or to in on for with by is are was be as at from that this it its which who whom has have had not no any all some one two something someone thing things'.split(' '));
/** Words of a text, lower-cased, camelCase and punctuation split, plural -s dropped. */
const words = (s: string) =>
  s
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
const norm = (s: string) => words(s).join(' ');
const content = (s: string) => words(s).filter((w) => !STOP.has(w) && w.length > 1);
const localName = (iri: string) => decodeURIComponent(iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1));

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

/** How alike two short strings are, 0 to 1, by the edits needed to turn one into the other. */
export function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * The deterministic matcher: labels, alternative labels, local names, definitions, shared
 * annotation values and parents. The score is the strongest name feature, raised a little by
 * each supporting feature and never above 0.99: only identical IRIs would be certain.
 */
export const lexicalMatcher: Matcher = (local, external) => {
  // Candidates are found through shared words, so that not every pair has to be compared.
  const index = new Map<string, number[]>();
  const tokensOf = (e: Matchable) => new Set([...words(e.name), ...e.alt.flatMap(words), ...words(localName(e.iri))].filter((w) => !STOP.has(w)));
  external.forEach((e, i) => {
    for (const w of tokensOf(e)) (index.get(w) ?? index.set(w, []).get(w)!).push(i);
  });
  const out: Suggestion[] = [];
  for (const l of local) {
    const seen = new Set<number>();
    for (const w of tokensOf(l)) for (const i of index.get(w) ?? []) seen.add(i);
    for (const i of seen) {
      const e = external[i];
      if (e.kind !== l.kind || e.iri === l.iri) continue;
      const features: Feature[] = [];
      const [ln, en] = [norm(l.name), norm(e.name)];
      if (l.name.trim() === e.name.trim() && l.name.trim()) features.push({ label: `same label “${e.name.trim()}”`, score: 0.95 });
      else if (ln && ln === en) features.push({ label: `same label apart from case or form: “${l.name.trim()}” / “${e.name.trim()}”`, score: 0.9 });
      const alts = (a: Matchable, b: Matchable) => a.alt.find((x) => norm(x) && norm(x) === norm(b.name));
      const alt = alts(l, e) ?? alts(e, l);
      if (alt && ln !== en) features.push({ label: `“${alt.trim()}” is an alternative label of one and the label of the other`, score: 0.85 });
      const [lo, eo] = [norm(localName(l.iri)), norm(localName(e.iri))];
      if (lo && lo === eo && ln !== en) features.push({ label: `same local name in the IRI: ${localName(e.iri)}`, score: 0.8 });
      if (!features.length) {
        const sim = Math.max(editSimilarity(ln, en), jaccard(words(l.name), words(e.name)));
        if (sim >= 0.6) features.push({ label: `similar labels: “${l.name.trim()}” / “${e.name.trim()}”`, score: Number((sim * 0.8).toFixed(2)) });
      }
      if (!features.length) continue;
      const support: Feature[] = [];
      const def = jaccard(content(l.definition), content(e.definition));
      if (def >= 0.2) support.push({ label: `definitions share ${Math.round(def * 100)}% of their words`, score: Number(def.toFixed(2)) });
      const parents = l.parents.filter((p) => e.parents.some((x) => norm(x) === norm(p)));
      if (parents.length) support.push({ label: `both are directly under “${parents[0]}”`, score: 0.5 });
      const shared = l.values.filter((v) => e.values.includes(v));
      if (shared.length) support.push({ label: `share the annotation value “${shared[0]}”`, score: 0.5 });
      const base = Math.max(...features.map((f) => f.score));
      const score = Math.min(0.99, base + support.reduce((n, f) => n + 0.04 * Math.min(1, f.score * 2), 0));
      out.push({ key: `${l.iri}|${e.iri}`, local: l, external: e, score: Number(score.toFixed(2)), features: [...features, ...support] });
    }
  }
  return out;
};

export const MATCHERS: Matcher[] = [lexicalMatcher];

/**
 * Candidates for mapping the model's own entities to those of an external ontology, best first.
 * Pairs already mapped, and pairs the user turned down, are left out. At most `perEntity` for
 * each local entity.
 */
export function suggestMappings(model: Model, external: Model, opts: { mapped?: Set<string>; threshold?: number; perEntity?: number } = {}): Suggestion[] {
  const { mapped = new Set<string>(), threshold = 0.5, perEntity = 3 } = opts;
  const rejected = new Set(model.rejected);
  const local = matchables(model, false);
  const ext = matchables(external);
  const best = new Map<string, Suggestion>();
  for (const matcher of MATCHERS) {
    for (const s of matcher(local, ext)) {
      if (s.score < threshold || rejected.has(s.key) || mapped.has(s.key)) continue;
      const hit = best.get(s.key);
      // Two matchers proposing one pair: the stronger score, and the features of both.
      if (!hit) best.set(s.key, s);
      else best.set(s.key, { ...hit, score: Math.max(hit.score, s.score), features: [...hit.features, ...s.features.filter((f) => !hit.features.some((x) => x.label === f.label))] });
    }
  }
  const perLocal = new Map<string, number>();
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.local.name.localeCompare(b.local.name))
    .filter((s) => {
      const n = perLocal.get(s.local.iri) ?? 0;
      perLocal.set(s.local.iri, n + 1);
      return n < perEntity;
    });
}
