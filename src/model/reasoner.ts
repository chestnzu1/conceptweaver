import type { DataValue, Model, Relation } from './types';
import { denotes, enumOf, literalText } from './datatypes';
import { CHARACTERISTICS, dataDomain, DEFAULT_PROP, objectProperties, propKey } from './props';
import { resolveModel } from './vocab';

/**
 * A small forward-chaining reasoner for the RDFS / OWL 2 RL rules that apply to what a model
 * can express: class and property hierarchies, equivalence, disjointness and complements,
 * individuals with types, sameAs / differentFrom, domains and ranges, and enumerations.
 *
 * Statements are (subject, predicate, object) over term ids. A relationship of your own between
 * two individuals is a statement whose predicate is "p:" + its label.
 *
 * An enumeration (a class that is exactly the individuals it lists) is one statement about the
 * class, "enum", and "alldiff" is the statement that those individuals are all different. A data
 * property whose values come from an enumerated datatype has a "drange" to "dt:" + its id.
 */
type Pred = 'sub' | 'type' | 'eqc' | 'disj' | 'compl' | 'subp' | 'eqp' | 'dom' | 'rng' | 'same' | 'diff' | 'is' | 'inv' | 'pdisj' | 'enum' | 'alldiff' | 'drange' | `p:${string}`;

interface Fact {
  s: string;
  p: Pred;
  o: string;
  /** Relation that states it; absent for inferred facts. */
  rel?: string;
  /** Facts it was derived from. */
  from?: Fact[];
}

export interface Inference {
  key: string;
  text: string;
  because: string;
  terms: string[];
  /** Relations the conclusion rests on. */
  rels: string[];
  /** The relation that would state this in the model, when it can be stated. */
  add?: Pick<Relation, 'from' | 'to' | 'kind'> & { predicate?: string; label?: string };
}

export interface Conflict {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  because: string;
  terms: string[];
  rels: string[];
}

export interface Reasoning {
  consistent: boolean;
  conflicts: Conflict[];
  inferences: Inference[];
  asserted: number;
  inferred: number;
  /** Stopped early because the model produced too many facts. */
  truncated: boolean;
  /** Classes that can never have a member. */
  unsatisfiable: Set<string>;
  /**
   * Every class the given class is entailed to be a kind of, other than itself: stated ones,
   * ones that follow through the hierarchy, and equivalent classes. Each comes with the stated
   * facts it rests on.
   */
  superclasses: (classId: string) => SuperLink[];
  /** Every class an individual is entailed to be an instance of, in the same way. */
  types: (individualId: string) => SuperLink[];
}

export interface SuperLink {
  id: string;
  /** Stated directly rather than derived. */
  asserted: boolean;
  /** The two classes are entailed to be equivalent. */
  equivalent: boolean;
  because: string;
  rels: string[];
}

const STD_TO_PRED: Record<string, Pred> = {
  'rdfs:subClassOf': 'sub',
  'rdfs:subPropertyOf': 'subp',
  'rdf:type': 'type',
  'owl:equivalentClass': 'eqc',
  'owl:disjointWith': 'disj',
  'owl:complementOf': 'compl',
  'owl:equivalentProperty': 'eqp',
  'owl:propertyDisjointWith': 'pdisj',
  'rdfs:domain': 'dom',
  'rdfs:range': 'rng',
  'owl:sameAs': 'same',
  'owl:differentFrom': 'diff',
};

const MAX_FACTS = 150_000;

let last: { relations: Relation[]; props: Model['props']; datatypes: Model['datatypes']; sig: string; result: Reasoning } | undefined;

/** `fresh` skips the cached result and reasons from scratch. */
export function reason(model: Model, fresh = false): Reasoning {
  const m = resolveModel(model);
  // Dragging terms around changes the model on every frame but not what it means.
  const sig =
    (m.vocab.enabled ? '1' : '0') +
    m.mode +
    m.terms
      .map((t) => `${t.id}:${t.type}:${t.name}${t.functional ? ':f' : ''}${t.domain ? ':' + t.domain.join(',') : ''}${t.values ? ':' + JSON.stringify(t.values) : ''}${t.oneOf ? ':o' + t.oneOf.join(',') : ''}${t.allDifferent ? ':ad' : ''}${t.range ? ':r' + t.range : ''}`)
      .join('|');
  if (!fresh && last && last.relations === m.relations && last.props === m.props && last.datatypes === m.datatypes && last.sig === sig) return last.result;
  const result = run(m);
  last = { relations: m.relations, props: m.props, datatypes: m.datatypes, sig, result };
  return result;
}

function run(m: Model): Reasoning {
  const byId = new Map(m.terms.map((t) => [t.id, t]));
  const propLabel = new Map<string, string>();
  const facts = new Map<string, Fact>();
  const bySP = new Map<string, Fact[]>();
  const byPO = new Map<string, Fact[]>();
  const byP = new Map<string, Fact[]>();
  const queue: Fact[] = [];
  let truncated = false;

  const has = (s: string, p: Pred, o: string) => facts.has(`${s}|${p}|${o}`);
  const sp = (p: Pred, s: string) => bySP.get(`${p}|${s}`) ?? [];
  const po = (p: Pred, o: string) => byPO.get(`${p}|${o}`) ?? [];
  const push = (map: Map<string, Fact[]>, k: string, f: Fact) => (map.get(k) ?? map.set(k, []).get(k)!).push(f);
  const add = (s: string, p: Pred, o: string, from?: Fact[], rel?: string) => {
    const k = `${s}|${p}|${o}`;
    if (facts.has(k)) return;
    if (facts.size >= MAX_FACTS) {
      truncated = true;
      return;
    }
    const f: Fact = { s, p, o, from, rel };
    facts.set(k, f);
    push(bySP, `${p}|${s}`, f);
    push(byPO, `${p}|${o}`, f);
    push(byP, p, f);
    queue.push(f);
  };

  // ---- what the model states
  // Object properties first: their domain, range, characteristics, inverse and parent.
  const chars = new Map<string, Fact[]>();
  if (m.mode !== 'skos') {
    for (const v of objectProperties(m)) {
      const key: Pred = `p:${v.key}`;
      propLabel.set(key, v.name);
      const classLevel = v.rels.find((r) => byId.get(r.from)?.type === 'concept' && byId.get(r.to)?.type === 'concept');
      // A single class can be reasoned with; "any of several" cannot be turned into one type.
      if (v.domain.length === 1) add(key, 'dom', v.domain[0], undefined, v.domainAuto ? classLevel?.id : undefined);
      if (v.range.length === 1) add(key, 'rng', v.range[0], undefined, v.rangeAuto ? classLevel?.id : undefined);
      for (const c of v.chars) add(key, 'is', c);
      chars.set(key, sp('is', key));
      for (const k of v.parents) add(key, 'subp', `p:${k}`);
      for (const k of v.inverses) {
        add(key, 'inv', `p:${k}`);
        add(`p:${k}`, 'inv', key);
      }
      for (const k of v.equivalents) add(key, 'eqp', `p:${k}`);
      for (const k of v.disjoints) add(key, 'pdisj', `p:${k}`);
    }
  }
  // The literal values individuals have for data properties: facts whose predicate is the
  // property's term and whose object is the literal.
  const literal = (v: DataValue) => `lit:${JSON.stringify([v.value, v.lang ?? ''])}`;
  if (m.mode !== 'skos') {
    for (const t of m.terms) {
      if (t.type !== 'instance') continue;
      for (const v of t.values ?? []) {
        if (byId.get(v.prop)?.type !== 'property') continue;
        propLabel.set(literal(v), JSON.stringify(v.value) + (v.lang ? '@' + v.lang : ''));
        add(t.id, v.prop as Pred, literal(v));
      }
    }
  }
  for (const t of m.terms) {
    if (t.type !== 'property' || m.mode === 'skos') continue;
    const d = dataDomain(m, t);
    const ids = d.ids.filter((id) => byId.get(id)?.type === 'concept');
    if (ids.length === 1) add(t.id, 'dom', ids[0], undefined, d.auto ? m.relations.find((r) => r.kind === 'property' && r.to === t.id && r.from === ids[0])?.id : undefined);
    // A range that lists its values. One with no values yet says nothing, as nothing is written for it.
    const listed = enumOf(m, t.range);
    if (listed?.values.length) {
      propLabel.set(`dt:${listed.id}`, listed.name || 'Unnamed');
      add(t.id, 'drange', `dt:${listed.id}`);
    }
  }
  // Enumerations: a class that is exactly the individuals it lists. One without members yet says
  // nothing, as nothing is written for it. One that lists something other than an individual is
  // left alone altogether: "exactly these" cannot be reasoned with while one of them is unclear.
  const members = new Map<string, string[]>();
  const listedIn = new Map<string, string[]>();
  if (m.mode !== 'skos') {
    for (const t of m.terms) {
      if (t.type !== 'concept' || t.external !== undefined || !t.oneOf?.length) continue;
      const ids = [...new Set(t.oneOf)].filter((id) => byId.has(id));
      if (!ids.length || ids.some((id) => byId.get(id)!.type !== 'instance')) continue;
      members.set(t.id, ids);
      for (const id of ids) listedIn.set(id, [...(listedIn.get(id) ?? []), t.id]);
      add(t.id, 'enum', t.id);
      if (t.allDifferent && ids.length > 1) add(t.id, 'alldiff', t.id);
    }
  }
  const enumFact = (c: string) => facts.get(`${c}|enum|${c}`)!;
  /**
   * An instance of an enumeration is one of its members. Which one is concluded only when it is
   * known to differ from all the others: no cases are tried out.
   */
  const narrow = (x: string, c: string) => {
    const ids = members.get(c)!;
    const typed = facts.get(`${x}|type|${c}`);
    if (!typed || ids.includes(x) || byId.get(x)?.type !== 'instance') return;
    const open = ids.filter((id) => !has(x, 'diff', id));
    if (open.length !== 1) return;
    add(x, 'same', open[0], [typed, enumFact(c), ...ids.filter((id) => id !== open[0]).map((id) => facts.get(`${x}|diff|${id}`)!)]);
  };
  for (const r of m.relations) {
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    if (!a || !b) continue;
    if (r.predicate) {
      const p = STD_TO_PRED[r.predicate];
      if (p) add(a.id, p, b.id, undefined, r.id);
    } else if (r.kind === 'generalization') {
      add(a.id, a.type === 'instance' && b.type === 'concept' ? 'type' : a.type === 'property' && b.type === 'property' ? 'subp' : 'sub', b.id, undefined, r.id);
    } else if (r.kind === 'property') {
      // Attaching a data property restricts the class; the property's domain is handled below.
    } else if (a.type === 'instance' && b.type === 'instance') {
      // A relationship between two individuals is a fact that uses the property.
      // One kept plain shares only the name with the object property, not its meaning.
      const key: Pred = `p:${r.plain ? '~' : ''}${propKey(r.label)}`;
      if (!propLabel.has(key)) propLabel.set(key, r.label.trim() || DEFAULT_PROP);
      add(a.id, key, b.id, undefined, r.id);
    }
  }
  const asserted = facts.size;

  // ---- rules, applied to each new fact against everything known so far
  const symmetric = (f: Fact) => add(f.o, f.p, f.s, [f]);
  const transitive = (f: Fact) => {
    for (const g of sp(f.p, f.o)) if (g.o !== f.s) add(f.s, f.p, g.o, [f, g]);
    for (const g of po(f.p, f.s)) if (g.s !== f.o) add(g.s, f.p, f.o, [g, f]);
  };
  for (let i = 0; i < queue.length && !truncated; i++) {
    const f = queue[i];
    const { s, p, o } = f;
    if (p === 'sub') {
      if (s === o) continue;
      transitive(f);
      for (const g of po('type', s)) add(g.s, 'type', o, [g, f]);
      const back = facts.get(`${o}|sub|${s}`);
      if (back) add(s, 'eqc', o, [f, back]);
      for (const g of po('dom', s)) add(g.s, 'dom', o, [g, f]);
      for (const g of po('rng', s)) add(g.s, 'rng', o, [g, f]);
    } else if (p === 'type') {
      for (const g of sp('sub', o)) add(s, 'type', g.o, [f, g]);
      for (const g of sp('same', s)) add(g.o, 'type', o, [f, g]);
      if (members.has(o)) narrow(s, o);
      // When every member of an enumeration is of a class, the enumeration is a kind of that class.
      for (const c of listedIn.get(s) ?? []) {
        if (c === o || byId.get(o)?.type !== 'concept') continue;
        const typed = members.get(c)!.map((id) => facts.get(`${id}|type|${o}`));
        if (typed.every(Boolean)) add(c, 'sub', o, [enumFact(c), ...(typed as Fact[])]);
      }
    } else if (p === 'enum') {
      // What a class lists are instances of it.
      for (const id of members.get(s)!) add(id, 'type', s, [f]);
    } else if (p === 'alldiff') {
      const ids = members.get(s)!;
      for (const a of ids) for (const b of ids) if (a !== b) add(a, 'diff', b, [f]);
    } else if (p === 'eqc' || p === 'eqp') {
      if (s === o) continue;
      symmetric(f);
      add(s, p === 'eqc' ? 'sub' : 'subp', o, [f]);
      add(o, p === 'eqc' ? 'sub' : 'subp', s, [f]);
    } else if (p === 'disj' || p === 'diff' || p === 'pdisj') {
      symmetric(f);
      // Ruling out a member of an enumeration may leave one thing only that an instance of it can be.
      if (p === 'diff') for (const c of listedIn.get(o) ?? []) narrow(s, c);
    } else if (p === 'compl') {
      symmetric(f);
      add(s, 'disj', o, [f]);
    } else if (p === 'same') {
      if (s === o) continue;
      symmetric(f);
      transitive(f);
      for (const g of sp('type', s)) add(o, 'type', g.o, [g, f]);
    } else if (p === 'subp') {
      if (s === o) continue;
      transitive(f);
      const back = facts.get(`${o}|subp|${s}`);
      if (back) add(s, 'eqp', o, [f, back]);
      for (const g of sp('dom', o)) add(s, 'dom', g.o, [f, g]);
      for (const g of sp('rng', o)) add(s, 'rng', g.o, [f, g]);
      // Whatever is related by the sub-property is related by the property above it too.
      for (const g of byP.get(s) ?? []) add(g.s, o as Pred, g.o, [g, f]);
    } else if (p === 'is' || p === 'inv' || p === 'drange') {
      // Statements about a property; the rules below look them up.
    } else if (p === 'dom' || p === 'rng') {
      for (const g of sp('sub', o)) add(s, p, g.o, [f, g]);
      for (const g of po('subp', s)) add(g.s, p, o, [g, f]);
      for (const g of byP.get(s) ?? []) add(p === 'dom' ? g.s : g.o, 'type', o, [g, f]);
    } else {
      // A fact "s p o" that uses an object property.
      for (const g of sp('dom', p)) add(s, 'type', g.o, [f, g]);
      for (const g of sp('rng', p)) add(o, 'type', g.o, [f, g]);
      for (const g of sp('subp', p)) add(s, g.o as Pred, o, [f, g]);
      for (const g of sp('inv', p)) add(o, g.o as Pred, s, [f, g]);
      for (const c of chars.get(p) ?? []) {
        if (c.o === 'symmetric') add(o, p, s, [f, c]);
        if (c.o === 'transitive') {
          for (const g of sp(p, o)) if (g.o !== s) add(s, p, g.o, [f, g, c]);
          for (const g of po(p, s)) if (g.s !== o) add(g.s, p, o, [g, f, c]);
        }
        // Two values of a functional property must be one and the same individual.
        if (c.o === 'functional') for (const g of sp(p, s)) if (g.o !== o) add(o, 'same', g.o, [f, g, c]);
        if (c.o === 'inverseFunctional') for (const g of po(p, o)) if (g.s !== s) add(s, 'same', g.s, [f, g, c]);
      }
    }
  }

  // ---- wording
  const name = (id: string) => byId.get(id)?.name || propLabel.get(id) || (id.startsWith('p:') ? id.slice(2) : '(unnamed)');
  const list = (ids: string[]) => ids.map((id) => `“${name(id)}”`).join(', ');
  const say = (f: Fact): string => {
    const [a, b] = [`“${name(f.s)}”`, `“${name(f.o)}”`];
    switch (f.p) {
      case 'enum':
        return `${a} is defined as the enumeration of ${list(members.get(f.s)!)}`;
      case 'alldiff':
        return `the members of ${a} are declared to be all different`;
      case 'drange':
        return `${a} takes its values from ${b}`;
      case 'sub':
        return `${a} is a kind of ${b}`;
      case 'type':
        return `${a} is an instance of ${b}`;
      case 'eqc':
        return `${a} is equivalent to ${b}`;
      case 'disj':
        return `${a} is disjoint with ${b}`;
      case 'compl':
        return `${a} is the complement of ${b}`;
      case 'subp':
        return `${a} is a sub-property of ${b}`;
      case 'eqp':
        return `${a} is an equivalent property to ${b}`;
      case 'dom':
        return `${a} applies to ${b}`;
      case 'rng':
        return `${a} points to ${b}`;
      case 'same':
        return `${a} is the same as ${b}`;
      case 'diff':
        return `${a} is different from ${b}`;
      case 'is':
        return `${a} is ${CHARACTERISTICS.find((c) => c.id === f.o)?.label.toLowerCase() ?? f.o}`;
      case 'inv':
        return `${a} is the inverse of ${b}`;
      case 'pdisj':
        return `${a} is a disjoint property with ${b}`;
      default:
        return f.o.startsWith('lit:') ? `${a} has ${name(f.p)} ${propLabel.get(f.o)}` : `${a} ${propLabel.get(f.p) ?? byId.get(f.p)?.name ?? f.p.slice(2)} ${b}`;
    }
  };
  /** Picks one direction of a symmetric pair, by name so that the wording is stable. */
  const leads = (a: string, b: string) => name(a).localeCompare(name(b)) < 0 || (name(a) === name(b) && a < b);
  /** The stated facts a conclusion ultimately rests on. */
  const grounds = (fs: Fact[]): Fact[] => {
    const out = new Set<Fact>();
    const seen = new Set<Fact>();
    const walk = (f: Fact) => {
      if (seen.has(f)) return;
      seen.add(f);
      if (f.from) f.from.forEach(walk);
      else out.add(f);
    };
    fs.forEach(walk);
    return [...out];
  };
  const because = (fs: Fact[]) => {
    const g = grounds(fs);
    return { because: g.map(say).join('; ') + '.', rels: [...new Set(g.map((f) => f.rel!).filter(Boolean))] };
  };

  // ---- contradictions
  const conflicts: Conflict[] = [];
  const conflict = (severity: Conflict['severity'], rule: string, message: string, terms: string[], fs: Fact[]) =>
    conflicts.push({ severity, rule, message, terms, ...because(fs) });

  for (const t of m.terms) {
    if (t.type === 'instance') {
      for (const ta of sp('type', t.id)) {
        for (const d of sp('disj', ta.o)) {
          const tb = facts.get(`${t.id}|type|${d.o}`);
          if (tb && leads(ta.o, d.o)) {
            conflict('error', 'Inconsistent', `“${t.name}” is an instance of both “${name(ta.o)}” and “${name(d.o)}”, which cannot share members.`, [t.id, ta.o, d.o], [ta, tb, d]);
          }
        }
      }
      if (has(t.id, 'diff', t.id)) conflict('error', 'Inconsistent', `“${t.name}” is said to be different from itself.`, [t.id], [facts.get(`${t.id}|diff|${t.id}`)!]);
      // An instance of an enumeration has to be one of its members.
      for (const ta of sp('type', t.id)) {
        const ids = members.get(ta.o);
        if (!ids || ids.includes(t.id)) continue;
        const ruledOut = ids.map((id) => facts.get(`${t.id}|diff|${id}`));
        if (!ruledOut.every(Boolean)) continue;
        conflict('error', 'Inconsistent', `“${t.name}” is an instance of “${name(ta.o)}”, which has no members other than ${list(ids)}, but it is said to be different from ${ids.length === 1 ? 'that one' : 'each of them'}.`, [t.id, ta.o, ...ids], [ta, enumFact(ta.o), ...(ruledOut as Fact[])]);
      }
      for (const sa of sp('same', t.id)) {
        const df = facts.get(`${t.id}|diff|${sa.o}`);
        if (df && leads(t.id, sa.o)) {
          conflict('error', 'Inconsistent', `“${t.name}” and “${name(sa.o)}” are said to be both the same and different.`, [t.id, sa.o], [sa, df]);
        }
      }
    } else if (t.type === 'concept') {
      // A class that falls under two disjoint classes can never have a member.
      const supers = new Map<string, Fact | undefined>([[t.id, undefined], ...sp('sub', t.id).map((f): [string, Fact] => [f.o, f])]);
      for (const [a, fa] of supers) {
        for (const d of sp('disj', a)) {
          if (!supers.has(d.o) || (a !== d.o && !leads(a, d.o))) continue;
          const fb = supers.get(d.o);
          const which = a === d.o ? `“${name(a)}”, which is disjoint with itself` : `both “${name(a)}” and “${name(d.o)}”, which are disjoint`;
          conflict('warning', 'Unsatisfiable class', `“${t.name}” can never have instances: it falls under ${which}.`, [t.id], [d, ...(fa ? [fa] : []), ...(fb ? [fb] : [])]);
        }
      }
    }
  }

  for (const [pred, cs] of chars) {
    for (const c of cs) {
      if (c.o !== 'asymmetric' && c.o !== 'irreflexive') continue;
      for (const g of byP.get(pred) ?? []) {
        if (c.o === 'irreflexive' && g.s === g.o) {
          conflict('error', 'Inconsistent', `“${name(pred)}” is irreflexive, but “${name(g.s)}” is related to itself by it.`, [g.s], [g, c]);
        }
        const back = facts.get(`${g.o}|${pred}|${g.s}`);
        if (c.o === 'asymmetric' && back && (g.s === g.o || leads(g.s, g.o))) {
          conflict('error', 'Inconsistent', `“${name(pred)}” is asymmetric, but it holds both ways between “${name(g.s)}” and “${name(g.o)}”.`, [g.s, g.o], [g, back, c]);
        }
      }
    }
  }

  // Two disjoint properties can never relate the same pair.
  for (const d of byP.get('pdisj') ?? []) {
    if (!leads(d.s, d.o)) continue;
    for (const g of byP.get(d.s) ?? []) {
      const other = facts.get(`${g.s}|${d.o}|${g.o}`);
      if (other) conflict('error', 'Inconsistent', `“${name(d.s)}” and “${name(d.o)}” are disjoint properties, but both hold for “${name(g.s)}”${g.o.startsWith('lit:') ? ` with the value ${propLabel.get(g.o)}` : ` and “${name(g.o)}”`}.`, [g.s, ...(byId.has(g.o) ? [g.o] : [])], [g, other, d]);
    }
  }
  // A value of a property whose range lists its values has to be one of those.
  for (const r of byP.get('drange') ?? []) {
    const d = m.datatypes.find((x) => `dt:${x.id}` === r.o)!;
    for (const g of byP.get(r.s) ?? []) {
      if (!g.o.startsWith('lit:')) continue;
      const [value, lang] = JSON.parse(g.o.slice(4)) as [string, string];
      if (d.values.some((x) => denotes(x, value, lang))) continue;
      conflict('error', 'Inconsistent', `“${name(g.s)}” has the value ${propLabel.get(g.o)} for “${name(r.s)}”, but the values of that property are those of “${d.name || 'Unnamed'}”: ${d.values.map(literalText).join(', ')}.`, [g.s, r.s], [g, r]);
    }
  }
  // A functional data property has at most one value for each individual.
  for (const t of m.terms) {
    if (t.type !== 'property' || !t.functional || m.mode === 'skos') continue;
    const first = new Map<string, Fact>();
    for (const g of byP.get(t.id) ?? []) {
      const before = first.get(g.s);
      if (!before) first.set(g.s, g);
      else if (before.o !== g.o) conflict('error', 'Inconsistent', `“${t.name}” is functional, but “${name(g.s)}” has two different values for it: ${propLabel.get(before.o)} and ${propLabel.get(g.o)}.`, [g.s, t.id], [before, g]);
    }
  }

  // ---- conclusions worth showing: new knowledge about classes and individuals
  const inferences: Inference[] = [];
  const vocab = m.vocab.enabled;
  for (const f of facts.values()) {
    if (!f.from) continue;
    const a = byId.get(f.s);
    const b = byId.get(f.o);
    if (!a || !b) continue;
    let add_: Inference['add'];
    if (f.p === 'sub') {
      // Already implied by an equivalence that is shown, or stated, in its own right.
      if (has(f.s, 'eqc', f.o)) continue;
      add_ = { from: f.s, to: f.o, kind: 'generalization', ...(a.type === 'concept' && b.type === 'concept' ? {} : vocab ? { predicate: 'rdfs:subClassOf' } : {}) };
    } else if (f.p === 'type') {
      add_ = { from: f.s, to: f.o, kind: 'generalization', ...(a.type === 'instance' && b.type === 'concept' ? {} : vocab ? { predicate: 'rdf:type' } : {}) };
    } else if (f.p === 'eqc' || f.p === 'same' || f.p === 'eqp') {
      // Symmetric: show one direction, and only when neither was stated.
      if (!leads(f.s, f.o) || !facts.get(`${f.o}|${f.p}|${f.s}`)?.from) continue;
      const predicate = f.p === 'eqc' ? 'owl:equivalentClass' : f.p === 'same' ? 'owl:sameAs' : 'owl:equivalentProperty';
      if (vocab) add_ = { from: f.s, to: f.o, kind: 'association', predicate };
    } else if (f.p.startsWith('p:')) {
      add_ = { from: f.s, to: f.o, kind: 'association', label: name(f.p) } as Inference['add'];
    } else {
      continue;
    }
    inferences.push({ key: `${f.s}|${f.p}|${f.o}`, text: say(f), terms: [f.s, f.o], add: add_, ...because([f]) });
  }
  const order = (i: Inference) => (i.key.includes('|type|') ? 0 : i.key.includes('|sub|') ? 2 : 1);
  inferences.sort((x, y) => order(x) - order(y) || x.text.localeCompare(y.text));

  return {
    consistent: !conflicts.some((c) => c.severity === 'error'),
    conflicts: conflicts.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'error' ? -1 : 1)),
    inferences,
    asserted,
    inferred: facts.size - asserted,
    truncated,
    unsatisfiable: new Set(conflicts.filter((c) => c.rule === 'Unsatisfiable class').flatMap((c) => c.terms)),
    superclasses: (classId) =>
      sp('sub', classId)
        .filter((f) => f.o !== classId && byId.get(f.o)?.type === 'concept')
        .map((f) => ({ id: f.o, asserted: !f.from, equivalent: has(classId, 'eqc', f.o), ...because([f]) })),
    types: (id) =>
      sp('type', id)
        .filter((f) => byId.get(f.o)?.type === 'concept')
        .map((f) => ({ id: f.o, asserted: !f.from, equivalent: false, ...because([f]) })),
  };
}
