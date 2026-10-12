import type { Model } from './types';
import { dataDomain, fitsIn, hasCardinality, objectProperties, plainRelationships } from './props';
import { resolveModel, stdProp } from './vocab';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  rule: string;
  severity: Severity;
  message: string;
  terms: string[];
  rels: string[];
}

const CARD = /^(\d+|\*)(\.\.(\d+|\*))?$/;

/** The built-in model checks. Each returns zero or more issues pointing at the offending items. */
export function runChecks(model: Model): Issue[] {
  const m = resolveModel(model);
  const issues: Issue[] = [];
  const add = (rule: string, severity: Severity, message: string, terms: string[] = [], rels: string[] = []) =>
    issues.push({ rule, severity, message, terms, rels });
  const byId = new Map(m.terms.map((t) => [t.id, t]));
  const name = (id: string) => byId.get(id)?.name || '(unnamed)';

  // 1. Unnamed terms
  for (const t of m.terms) {
    if (!t.name.trim()) add('Unnamed term', 'error', 'A term has no name.', [t.id]);
  }

  // 2. Duplicate names
  const names = new Map<string, string[]>();
  for (const t of m.terms) {
    const k = t.name.trim().toLowerCase();
    if (!k) continue;
    names.set(k, [...(names.get(k) ?? []), t.id]);
  }
  for (const ids of names.values()) {
    // Not an error: the terms have different IRIs and so are different things. Usually a slip, though.
    if (ids.length > 1) add('Duplicate name', 'warning', `"${name(ids[0])}" is the name of ${ids.length} terms. They are told apart by their IRIs.`, ids);
  }

  // 3. Name also listed as another term's synonym
  for (const t of m.terms) {
    for (const syn of t.synonyms.split(',')) {
      const other = names.get(syn.trim().toLowerCase())?.find((id) => id !== t.id);
      if (syn.trim() && other) {
        add('Synonym clash', 'warning', `"${syn.trim()}" is a synonym of "${t.name}" but also a term of its own.`, [t.id, other]);
      }
    }
  }

  // 4. Circular hierarchy (strongly connected components of the "is a" graph)
  const gen = m.relations.filter((r) => r.kind === 'generalization' && byId.has(r.from) && byId.has(r.to));
  const parents = new Map<string, string[]>();
  for (const r of gen) parents.set(r.from, [...(parents.get(r.from) ?? []), r.to]);
  {
    let counter = 0;
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const visit = (v: string) => {
      idx.set(v, counter);
      low.set(v, counter++);
      stack.push(v);
      onStack.add(v);
      for (const w of parents.get(v) ?? []) {
        if (!idx.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      }
      if (low.get(v) === idx.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1) {
          const set = new Set(comp);
          add(
            'Circular hierarchy',
            'error',
            `These terms are each other's ancestors: ${comp.map(name).join(', ')}.`,
            comp,
            gen.filter((r) => set.has(r.from) && set.has(r.to)).map((r) => r.id),
          );
        }
      }
    };
    for (const t of m.terms) if (!idx.has(t.id) && parents.has(t.id)) visit(t.id);
  }

  // 5. Self-referencing relations
  for (const r of m.relations) {
    if (r.from !== r.to) continue;
    if (r.kind === 'generalization') add('Circular hierarchy', 'error', `"${name(r.from)}" is its own parent.`, [r.from], [r.id]);
    else add('Self relation', 'info', `"${name(r.from)}" is related to itself.`, [r.from], [r.id]);
  }

  // 6. Duplicate relations
  const seen = new Map<string, string>();
  for (const r of m.relations) {
    const k = `${r.from}|${r.to}|${r.kind}|${r.predicate ?? ''}|${r.label.trim().toLowerCase()}`;
    const first = seen.get(k);
    if (first) add('Duplicate relation', 'warning', `"${name(r.from)}" → "${name(r.to)}" is defined twice.`, [], [first, r.id]);
    else seen.set(k, r.id);
  }

  // 7. Unlabelled associations
  for (const r of m.relations) {
    if (r.kind === 'association' && !r.label.trim() && !r.predicate && m.mode !== 'skos') {
      add('Unlabelled relation', 'warning', `The relation "${name(r.from)}" → "${name(r.to)}" has no label.`, [], [r.id]);
    }
  }

  // 8. Opposite "is a" between the same association pair
  const genPairs = new Set(gen.map((r) => `${r.from}|${r.to}`));

  // 9. Redundant generalization: A is-a C directly and also through another parent
  if (gen.length <= 3000) {
    for (const r of gen) {
      if (r.from === r.to) continue;
      const seenUp = new Set<string>();
      const queue = (parents.get(r.from) ?? []).filter((p) => p !== r.to && p !== r.from);
      let found = false;
      while (queue.length && !found) {
        const v = queue.pop()!;
        if (seenUp.has(v)) continue;
        seenUp.add(v);
        for (const p of parents.get(v) ?? []) {
          if (p === r.to) found = true;
          else if (p !== r.from) queue.push(p);
        }
      }
      if (found) {
        add('Redundant hierarchy', 'info', `"${name(r.from)}" is a "${name(r.to)}" both directly and through another parent.`, [r.from], [r.id]);
      }
    }
  }

  // 10. Multiple parents
  for (const [child, ps] of parents) {
    const uniq = [...new Set(ps)].filter((p) => p !== child);
    if (uniq.length > 1) {
      add('Multiple parents', 'info', `"${name(child)}" has ${uniq.length} parents: ${uniq.map(name).join(', ')}.`, [child]);
    }
  }

  // 11. Isolated terms
  const connected = new Set<string>();
  for (const r of m.relations) {
    connected.add(r.from);
    connected.add(r.to);
  }
  if (m.terms.length > 1) {
    for (const t of m.terms) {
      // A data property with a domain is placed even if no class is drawn as having it.
      if (!connected.has(t.id) && !(t.type === 'property' && t.domain?.length)) add('Isolated term', 'warning', `"${name(t.id)}" has no relations.`, [t.id]);
    }
  }

  // 12. Properties: a domain and datatype for data properties, uses that fall outside a
  // declared domain or range, and relationships nobody has classified yet
  if (m.mode !== 'skos') {
    for (const t of m.terms) {
      if (t.type !== 'property') continue;
      const domain = dataDomain(m, t);
      if (connected.has(t.id) && !domain.ids.length) {
        add('No domain', 'warning', `Data property "${name(t.id)}" has no domain: attach it to a class, or set its domain.`, [t.id]);
      }
      if (!t.range) add('No range', 'info', `Data property "${name(t.id)}" has no datatype.`, [t.id]);
      if (domain.auto) continue;
      for (const r of m.relations) {
        if (r.kind !== 'property' || r.to !== t.id || byId.get(r.from)?.type !== 'concept' || fitsIn(m, r.from, domain.ids)) continue;
        add('Outside domain', 'warning', `"${name(r.from)}" has the data property "${name(t.id)}", but is not ${domain.ids.map(name).join(' or ')} or a kind of it.`, [], [r.id]);
      }
    }
    for (const p of objectProperties(m)) {
      for (const r of p.rels) {
        const a = byId.get(r.from)!;
        const b = byId.get(r.to)!;
        // Only a class is held to the domain and range: for an individual they are something to
        // infer its type from, which is the reasoner's business.
        if (a.type !== 'concept' || b.type !== 'concept') continue;
        if (!p.domainAuto && p.domain.length && !fitsIn(m, a.id, p.domain)) {
          add('Outside domain', 'warning', `"${name(a.id)}" uses "${p.name}", but is not ${p.domain.map(name).join(' or ')} or a kind of it.`, [], [r.id]);
        }
        if (!p.rangeAuto && p.range.length && !fitsIn(m, b.id, p.range)) {
          add('Outside range', 'warning', `"${p.name}" points to "${name(b.id)}", which is not ${p.range.map(name).join(' or ')} or a kind of it.`, [], [r.id]);
        }
      }
    }
    for (const p of plainRelationships(m)) {
      if (!p.rels.some((r) => r.label.trim())) continue;
      add(
        'Undetermined relationship',
        'info',
        `"${p.name}" is a plain relationship (${p.rels.length} use${p.rels.length === 1 ? '' : 's'}). Make it an object property to give it a domain, a range and characteristics.`,
        [],
        p.rels.map((r) => r.id),
      );
    }
  }

  // 13. "Has property" pointing at something that isn't a property; "is a" across term types
  for (const r of m.relations) {
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    if (!a || !b) continue;
    if (r.kind === 'property' && b.type !== 'property') {
      add('Type mismatch', 'info', `"${name(r.to)}" is used as a property of "${name(r.from)}" but is a ${b.type}.`, [r.to], [r.id]);
    }
    if (r.kind === 'generalization' && !r.predicate && a.type === 'concept' && b.type !== 'concept') {
      add('Type mismatch', 'warning', `Concept "${name(r.from)}" cannot be a kind of ${b.type} "${name(r.to)}".`, [], [r.id]);
    }
    if (r.kind === 'association' && genPairs.has(`${r.from}|${r.to}`) && /^is[- ]an?$/i.test(r.label.trim())) {
      add('Duplicate relation', 'warning', `"${name(r.from)}" → "${name(r.to)}" is both an "is a" relation and an association labelled "${r.label}".`, [], [r.id]);
    }
  }

  // Standard RDFS/OWL properties used between the wrong kinds of term
  for (const r of m.relations) {
    const p = stdProp(r.predicate);
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    if (!p || !a || !b) continue;
    if ((p.from.length && !p.from.includes(a.type)) || (p.to.length && !p.to.includes(b.type))) {
      add(
        'Property misuse',
        'warning',
        `${p.id} links a ${p.from.join('/')} to a ${p.to.join('/')}, but "${name(r.from)}" is a ${a.type} and "${name(r.to)}" is a ${b.type}.`,
        [],
        [r.id],
      );
    }
  }

  // SKOS integrity conditions
  if (m.mode === 'skos') {
    for (const t of m.terms) {
      if (t.type !== 'concept') add('Not SKOS', 'info', `"${name(t.id)}" is a${t.type === 'instance' ? 'n' : ''} ${t.type}; in a concept scheme it is exported as a plain concept.`, [t.id]);
      // At most one preferred label per language (the name is the one in the model's language).
      const perLang = new Map<string, number>([[m.lang, 1]]);
      for (const f of t.fields) if (f.key === 'skos:prefLabel') perLang.set(f.lang ?? '', (perLang.get(f.lang ?? '') ?? 0) + 1);
      for (const [lang, n] of perLang) {
        if (n > 1) add('Preferred label clash', 'error', `"${name(t.id)}" has ${n} preferred labels ${lang ? `in “${lang}”` : 'without a language'}; SKOS allows one per language.`, [t.id]);
      }
      // Preferred, alternative and hidden labels must not overlap.
      const labels = new Map<string, string>([[`${m.lang}|${t.name.trim().toLowerCase()}`, 'preferred label']]);
      const others: [string, string, string][] = t.synonyms.split(',').map((x): [string, string, string] => [m.lang, x, 'synonym']);
      for (const f of t.fields) if (f.key === 'skos:altLabel' || f.key === 'skos:hiddenLabel' || f.key === 'skos:prefLabel') others.push([f.lang ?? '', f.value, f.key]);
      for (const [lang, value, what] of others) {
        const k = `${lang}|${value.trim().toLowerCase()}`;
        if (!value.trim()) continue;
        if (labels.has(k)) add('Label clash', 'warning', `"${name(t.id)}" uses “${value.trim()}” both as ${labels.get(k)} and as ${what}.`, [t.id]);
        else labels.set(k, what);
      }
    }
    // skos:related must not connect a concept with one of its own broader or narrower concepts.
    const ancestors = (id: string) => {
      const seenUp = new Set<string>();
      const queue = [...(parents.get(id) ?? [])];
      while (queue.length) {
        const v = queue.pop()!;
        if (seenUp.has(v)) continue;
        seenUp.add(v);
        queue.push(...(parents.get(v) ?? []));
      }
      return seenUp;
    };
    const matches = new Map<string, Set<string>>();
    for (const r of m.relations) {
      if (r.from === r.to || !byId.has(r.from) || !byId.has(r.to)) continue;
      const associative = r.kind !== 'generalization' && (!r.predicate || r.predicate === 'skos:related' || r.predicate === 'skos:relatedMatch');
      if (associative && (ancestors(r.from).has(r.to) || ancestors(r.to).has(r.from))) {
        add('Related and broader clash', 'error', `"${name(r.from)}" and "${name(r.to)}" are related, but one is already broader than the other.`, [], [r.id]);
      }
      if (r.predicate?.endsWith('Match')) {
        const pair = r.from < r.to ? `${r.from}|${r.to}` : `${r.to}|${r.from}`;
        (matches.get(pair) ?? matches.set(pair, new Set()).get(pair)!).add(r.predicate);
      }
    }
    for (const [pair, kinds] of matches) {
      if (kinds.has('skos:exactMatch') && kinds.size > 1) {
        const [a, b] = pair.split('|');
        add('Mapping clash', 'error', `"${name(a)}" and "${name(b)}" are an exact match and also ${[...kinds].filter((k) => k !== 'skos:exactMatch').join(', ')}; these exclude each other.`, [a, b]);
      }
    }
  }

  // 14. Malformed cardinalities
  for (const r of m.relations) {
    if (!hasCardinality(m, r)) continue;
    for (const c of [r.fromCard, r.toCard]) {
      if (c.trim() && !CARD.test(c.trim())) {
        add('Invalid cardinality', 'warning', `"${c}" on "${name(r.from)}" → "${name(r.to)}" is not a cardinality (use 1, 0..1, 1..*, *).`, [], [r.id]);
      }
    }
  }

  // 15. Missing descriptions
  for (const t of m.terms) {
    if (t.name.trim() && !t.description.trim()) add('Missing description', 'info', `"${t.name}" has no description.`, [t.id]);
  }

  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Shortest undirected path between two terms; returns the term and relation ids along it. */
export function findPath(m: Model, a: string, b: string): { terms: string[]; rels: string[] } | null {
  const adj = new Map<string, { to: string; rel: string }[]>();
  for (const r of m.relations) {
    (adj.get(r.from) ?? adj.set(r.from, []).get(r.from)!).push({ to: r.to, rel: r.id });
    (adj.get(r.to) ?? adj.set(r.to, []).get(r.to)!).push({ to: r.from, rel: r.id });
  }
  const prev = new Map<string, { from: string; rel: string }>();
  const queue = [a];
  const seen = new Set([a]);
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i];
    if (v === b) break;
    for (const e of adj.get(v) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: v, rel: e.rel });
      queue.push(e.to);
    }
  }
  if (!seen.has(b)) return null;
  const terms = [b];
  const rels: string[] = [];
  for (let v = b; v !== a; ) {
    const p = prev.get(v)!;
    rels.push(p.rel);
    terms.push(p.from);
    v = p.from;
  }
  return { terms: terms.reverse(), rels: rels.reverse() };
}
