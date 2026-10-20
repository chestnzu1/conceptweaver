import { propDatatype } from '../model/domains';
import { bounds } from '../model/geometry';
import { hierarchyOf } from '../layout/graph';
import { expandIri } from '../model/prefixes';
import { newRelation, newTerm, type ExtraField, type Model, type Relation, type Term } from '../model/types';
import { quoted } from '../model/words';
import type { PlannedEntity, Plan, Reference, Replaced, RowChange, RowOutcome, Table, TabularMapping } from './contracts';
import { fillTemplate, parseTemplate, templateColumns } from './template';
import { convert } from './values';

/**
 * What an import would do, row by row (roadmap task 2.4, FR-M7-3, FR-M7-4, ADR-019), and the
 * model it makes. A row is made into an entity, or found in the model already and left as it
 * is, or skipped, with why: its IRI cannot be made, another row has it, or what it says it is
 * under (a parent, a class) is neither a row of the table nor in the model. A row under a row
 * that is skipped is skipped too, so that nothing is made half. A value that cannot be what its
 * column says (a price that is no number, a link to nothing) is left out, and the row says so.
 *
 * In update mode (FR-M7-6, roadmap task 2.12), a row whose IRI the model has is matched to that
 * entity: what its columns say replaces what the entity said about those fields, every change is
 * listed before anything is applied, and a row that says nothing new is unchanged. Matching is by
 * IRI, which the IRI template may make from the key column or from any other, so a key column
 * matches too. A row the model does not have is made, as in an ordinary import.
 */

/** The references of a mapping a value is looked for among, in order: a row's key, a row's name, the model. */
export function planImport(model: Model, table: Table, mapping: TabularMapping): Plan {
  const parts = parseTemplate(mapping.iri);
  const col = new Map(table.columns.map((c, i) => [c, i]));
  const cell = (row: string[], name: string) => (col.has(name) ? (row[col.get(name)!] ?? '') : undefined);
  const uses = Object.entries(mapping.columns).filter(([c]) => col.has(c));
  const nameCol = uses.find(([, u]) => u.as === 'name')?.[0];
  const keyCol = mapping.key && col.has(mapping.key) ? mapping.key : (templateColumns(mapping.iri)[0] ?? nameCol);
  const many = (v: string) => (mapping.split ? v.split(mapping.split) : [v]).map((x) => x.trim()).filter(Boolean);
  const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

  /** What the mapped columns say an existing entity is to be, and so what an update replaces. */
  const replaced: Replaced = {
    ...(uses.some(([, u]) => u.as === 'description') ? { description: true as const } : {}),
    ...(uses.some(([, u]) => u.as === 'synonyms') ? { synonyms: true as const } : {}),
    annotations: unique(uses.flatMap(([, u]) => (u.as === 'annotation' ? [u.property] : []))),
    values: unique(uses.flatMap(([, u]) => (u.as === 'value' ? [u.property] : []))),
    links: unique(uses.flatMap(([, u]) => (u.as === 'link' ? [u.property] : []))),
    ...((mapping.rows === 'individual' && mapping.classIri) || uses.some(([, u]) => u.as === 'parent' || u.as === 'type') ? { parents: true as const } : {}),
  };

  // ------------------------------------------------------------ each row's IRI and name
  const outcomes: RowOutcome[] = table.rows.map((_r, i) => ({ row: table.rowNumbers[i] ?? i + 1, status: 'create', notes: [] }));
  /** For a row update mode matches to an entity of the model: that entity. */
  const matched: (Term | undefined)[] = table.rows.map(() => undefined);
  const byIri = new Map<string, number>();
  const terms = new Map(model.terms.filter((t) => t.iri).map((t) => [t.iri!, t]));
  const props = new Map(model.props.filter((p) => p.iri).map((p) => [p.iri!, p]));
  table.rows.forEach((row, i) => {
    const o = outcomes[i];
    const made = fillTemplate(parts, (c) => cell(row, c));
    if ('error' in made) {
      o.status = 'skip';
      o.reason = made.error;
      return;
    }
    o.iri = made.iri;
    const named = nameCol ? cell(row, nameCol)?.trim() : '';
    o.name = named || decodeURIComponent(made.iri.replace(/^.*[#/:]/, '')) || made.iri;
    const before = byIri.get(made.iri);
    if (before !== undefined) {
      o.status = 'skip';
      o.reason = `row ${outcomes[before].row} has the same IRI, ${made.iri}`;
      return;
    }
    byIri.set(made.iri, i);
    const there = terms.get(made.iri);
    if (there && mapping.update) {
      // Matched: the row changes the entity the model has, and says which fields it speaks for.
      matched[i] = there;
      if (!named) {
        o.name = there.name || o.name;
        if (nameCol) o.notes.push(`it has no ${nameCol}: its name is left as it is`);
      }
      return;
    }
    const inModel = there ?? props.get(made.iri);
    if (inModel) {
      o.status = 'exists';
      o.reason = `it is in the model already, as ${quoted(inModel.name || 'Unnamed')}, and is left as it is`;
    } else if (nameCol && !named) {
      o.notes.push(`it has no ${nameCol}: it is named after its IRI`);
    }
  });

  // ------------------------------------------------------------ what a value refers to
  const byKey = new Map<string, number>();
  const byName = new Map<string, number>();
  table.rows.forEach((row, i) => {
    if (outcomes[i].status === 'skip' && !outcomes[i].iri) return;
    const k = keyCol ? cell(row, keyCol)?.trim() : undefined;
    if (k && !byKey.has(k)) byKey.set(k, i);
    const n = outcomes[i].name?.toLowerCase();
    if (n && !byName.has(n)) byName.set(n, i);
  });
  const modelByName = new Map<string, Term[]>();
  for (const t of model.terms) if (t.name) modelByName.set(t.name.trim().toLowerCase(), [...(modelByName.get(t.name.trim().toLowerCase()) ?? []), t]);
  /** A value as a row of the table (when rows can be what is wanted) or an entity of the model of the kind wanted. */
  const resolve = (v: string, want: 'concept' | 'instance', rowsMay: boolean): Reference | undefined => {
    if (rowsMay) {
      const i = byKey.get(v) ?? byName.get(v.toLowerCase());
      if (i !== undefined) return { row: i };
    }
    const iri = terms.has(v) ? v : (expandIri(model, v) ?? (/^<.+>$/.test(v) ? v.slice(1, -1) : undefined));
    const t = iri ? terms.get(iri) : undefined;
    if (t?.type === want) return { iri: t.iri! };
    const found = (modelByName.get(v.toLowerCase()) ?? []).filter((x) => x.type === want);
    return found.length === 1 ? { iri: found[0].iri! } : undefined;
  };

  // ------------------------------------------------------------ what each row says
  const entities: (PlannedEntity | undefined)[] = table.rows.map((row, i) => {
    const o = outcomes[i];
    if (o.status !== 'create') return undefined;
    const e: PlannedEntity = { index: i, iri: o.iri!, name: o.name!, kind: mapping.rows, parents: [], annotations: [], values: [], links: [] };
    const match = matched[i];
    if (match) {
      e.target = match.id;
      e.setName = !!nameCol && !!cell(row, nameCol)?.trim();
      e.replace = replaced;
    }
    if (mapping.rows === 'individual' && mapping.classIri) e.parents.push({ iri: mapping.classIri });
    for (const [c, use] of uses) {
      const raw = cell(row, c)!.trim();
      if (!raw) continue;
      switch (use.as) {
        case 'parent':
        case 'type': {
          const ofClass = use.as === 'type' || mapping.rows === 'class';
          for (const v of many(raw)) {
            // A class row's parent may be another row; an individual's class is a class of the model.
            const ref = resolve(v, 'concept', mapping.rows === 'class');
            if (!ref) {
              o.status = 'skip';
              o.reason = mapping.rows === 'class' ? `its ${c}, ${quoted(v)}, is neither a row of the table nor a class of the model` : `its ${c}, ${quoted(v)}, is not a class of the model`;
              return undefined;
            }
            if ('row' in ref && ref.row === i) {
              o.status = 'skip';
              o.reason = `its ${c} is itself`;
              return undefined;
            }
            if (ofClass) e.parents.push(ref);
          }
          break;
        }
        case 'description':
          e.description = { value: raw, ...(use.lang ? { lang: use.lang } : {}) };
          break;
        case 'synonyms':
          e.synonyms = { value: many(raw).join(', '), ...(use.lang ? { lang: use.lang } : {}) };
          break;
        case 'annotation':
          for (const v of many(raw)) e.annotations.push({ property: use.property, value: v, ...(use.lang ? { lang: use.lang } : {}) });
          break;
        case 'value': {
          const p = terms.get(use.property);
          if (p?.type !== 'property') {
            o.notes.push(`${c} is left out: ${quoted(use.property)} is not a data property of the model`);
            break;
          }
          const datatype = use.datatype ?? propDatatype(p);
          for (const v of many(raw)) {
            const got = convert(v, datatype);
            if ('error' in got) o.notes.push(`${c} ${quoted(v)} is left out: ${got.error}`);
            else e.values.push({ property: use.property, value: got.value, ...(datatype && datatype !== 'xsd:string' ? { datatype } : {}) });
          }
          break;
        }
        case 'link': {
          const p = props.get(use.property);
          if (!p) {
            o.notes.push(`${c} is left out: ${quoted(use.property)} is not an object property of the model`);
            break;
          }
          for (const v of many(raw)) {
            const ref = resolve(v, mapping.rows === 'class' ? 'concept' : 'instance', true);
            if (!ref) o.notes.push(`the link by ${quoted(p.name)} to ${quoted(v)} is left out: it is neither a row of the table nor in the model`);
            else e.links.push({ property: use.property, to: ref });
          }
          break;
        }
        default:
          break;
      }
    }
    return e;
  });

  // ------------------------------------------------------------ a row under a skipped row is skipped too
  for (let changed = true; changed; ) {
    changed = false;
    entities.forEach((e, i) => {
      if (!e || outcomes[i].status !== 'create') return;
      const gone = e.parents.find((r) => 'row' in r && outcomes[r.row].status === 'skip');
      if (!gone || !('row' in gone)) return;
      outcomes[i].status = 'skip';
      outcomes[i].reason = `what it is under, row ${outcomes[gone.row].row}, is skipped`;
      entities[i] = undefined;
      changed = true;
    });
  }
  // Links to rows that are skipped are left out; links and parents to rows the model has go to the entity in the model.
  const inModelRow = (i: number) => !!matched[i] || outcomes[i].status === 'exists';
  const kept = entities.filter((e): e is PlannedEntity => !!e);
  for (const e of kept) {
    const at = (r: Reference): Reference => ('row' in r && inModelRow(r.row) ? { iri: outcomes[r.row].iri! } : r);
    e.parents = e.parents.map(at);
    e.links = e.links
      .filter((l) => {
        if (!('row' in l.to) || outcomes[l.to.row].status !== 'skip') return true;
        outcomes[e.index].notes.push(`the link to row ${outcomes[l.to.row].row} is left out: that row is skipped`);
        return false;
      })
      .map((l) => ({ ...l, to: at(l.to) }));
  }

  // ------------------------------------------------------------ update mode: which rows change what
  // What a row under it is to be called: a row that is made has no entity of the model yet.
  const rowName = new Map(outcomes.filter((o) => o.iri).map((o) => [o.iri!, o.name ?? o.iri!]));
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const nameOfIri = (iri: string) => terms.get(iri)?.name || rowName.get(iri) || iri;
  const iriOfRef = (r: Reference) => ('row' in r ? outcomes[r.row].iri! : r.iri);
  const parentName = mapping.rows === 'class' ? (model.mode === 'skos' ? 'Broader concept' : 'Superclass') : 'Class';
  const changesOf = (t: Term, e: PlannedEntity): RowChange[] => {
    const changes: RowChange[] = [];
    const rep = e.replace;
    if (e.setName !== false && e.name !== t.name) changes.push({ what: 'Name', from: quoted(t.name || 'Unnamed'), to: quoted(e.name) });
    if (rep?.description) {
      const lang = e.description?.lang && e.description.lang !== model.lang ? e.description.lang : undefined;
      const value = e.description?.value ?? '';
      if (t.description !== value || (t.descriptionLang || undefined) !== lang) {
        changes.push({ what: 'Description', from: quoted(t.description ? `${t.description}${t.descriptionLang ? ` (${t.descriptionLang})` : ''}` : 'none'), to: quoted(value ? `${value}${lang ? ` (${lang})` : ''}` : 'none') });
      }
    }
    if (rep?.synonyms) {
      const lang = e.synonyms?.lang && e.synonyms.lang !== model.lang ? e.synonyms.lang : undefined;
      if (lang) {
        const was = t.fields.filter((f) => f.key === 'skos:altLabel' && f.lang === lang).map((f) => f.value);
        const now = e.synonyms ? e.synonyms.value.split(', ').filter(Boolean) : [];
        if (shown(was) !== shown(now)) changes.push({ what: `Synonyms (${lang})`, from: shown(was), to: shown(now) });
      } else if (t.synonyms !== (e.synonyms?.value ?? '')) {
        changes.push({ what: 'Synonyms', from: shown(t.synonyms ? t.synonyms.split(', ') : []), to: shown(e.synonyms ? e.synonyms.value.split(', ') : []) });
      }
    }
    for (const key of repo(rep?.annotations)) {
      const was = t.fields.filter((f) => f.key === key).map((f) => f.value + (f.lang ? ` (${f.lang})` : ''));
      const now = e.annotations.filter((a) => a.property === key).map((a) => a.value + (a.lang ? ` (${a.lang})` : ''));
      if (shown(was) !== shown(now)) changes.push({ what: `Annotation ${key}`, from: shown(was), to: shown(now) });
    }
    for (const property of repo(rep?.values)) {
      const p = terms.get(property);
      if (p?.type !== 'property') continue;
      const was = (t.values ?? []).filter((v) => v.prop === p.id).map((v) => v.value);
      const now = e.values.filter((v) => v.property === property).map((v) => v.value);
      if (shown(was) !== shown(now)) changes.push({ what: `Value of ${quoted(p.name)}`, from: shown(was), to: shown(now) });
    }
    for (const property of repo(rep?.links)) {
      const p = props.get(property);
      if (!p) continue;
      const was = unique(model.relations.filter((r) => r.from === t.id && r.prop === p.id).map((r) => byId.get(r.to)?.iri ?? '').filter(Boolean));
      const now = unique(e.links.filter((l) => l.property === property).map((l) => iriOfRef(l.to)));
      if (shown(was) !== shown(now)) changes.push({ what: `Link by ${quoted(p.name)}`, from: shown(was.map(nameOfIri)), to: shown(now.map(nameOfIri)) });
    }
    if (rep?.parents) {
      const was = unique(model.relations.filter((r) => r.from === t.id && r.kind === 'generalization').map((r) => byId.get(r.to)?.iri ?? '').filter(Boolean));
      const now = unique(e.parents.map(iriOfRef));
      if (shown(was) !== shown(now)) changes.push({ what: parentName, from: shown(was.map(nameOfIri)), to: shown(now.map(nameOfIri)) });
    }
    return changes;
  };
  const applied: PlannedEntity[] = [];
  for (const e of kept) {
    if (!e.target) {
      applied.push(e);
      continue;
    }
    const t = terms.get(e.iri)!;
    const changes = changesOf(t, e);
    const o = outcomes[e.index];
    if (changes.length) {
      o.status = 'update';
      o.changes = changes;
      applied.push(e);
    } else o.status = 'unchanged';
  }

  const count = (s: RowOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  return {
    rows: outcomes,
    entities: applied,
    counts: {
      create: count('create'),
      update: count('update'),
      unchanged: count('unchanged'),
      exists: count('exists'),
      skip: count('skip'),
      notes: outcomes.reduce((n, o) => n + (o.status === 'create' || o.status === 'update' ? o.notes.length : 0), 0),
    },
  };
}

/** Two lists of values as one text, in some order, or "none": what an unchanged list looks like. */
const shown = (values: string[]): string => (values.length ? [...values].sort().map((v) => quoted(v)).join(', ') : 'none');
/** A list of properties of a replacement, once each. */
const repo = (values: string[] | undefined): string[] => [...new Set(values ?? [])];

/** Above this many new terms, they are laid out row by row rather than as a hierarchy, which would take too long. */
const TREE_UP_TO = 3000;

/**
 * The model with what a plan makes and changes: the entities made, their superclasses or classes,
 * their values and links, laid out below what is on the canvas; the entities matched in update
 * mode changed where they are, with what the file no longer says removed. One model, for one edit
 * of the document.
 */
export function applyPlan(model: Model, plan: Plan): { model: Model; terms: string[]; updated: string[] } {
  if (!plan.entities.length) return { model, terms: [], updated: [] };
  const termsByIri = new Map(model.terms.filter((t) => t.iri).map((t) => [t.iri!, t]));
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const props = new Map(model.props.filter((p) => p.iri).map((p) => [p.iri!, p]));
  const made: Term[] = [];
  const ids = new Map<number, string>();
  const changed: PlannedEntity[] = [];
  const patches = new Map<string, Term>();
  for (const e of plan.entities) {
    if (e.target) {
      const t = byId.get(e.target);
      if (!t) continue;
      changed.push(e);
      patches.set(t.id, updatedTerm(model, t, e, termsByIri));
      continue;
    }
    const t = newTerm({
      name: e.name,
      iri: e.iri,
      type: e.kind === 'class' ? 'concept' : 'instance',
      description: e.description?.value ?? '',
      ...(e.description?.lang && e.description.lang !== model.lang ? { descriptionLang: e.description.lang } : {}),
      synonyms: synonymsOf(model, e).own,
      fields: fieldsOf(model, e),
      ...(e.values.length ? { values: e.values.map((v) => ({ prop: termsByIri.get(v.property)!.id, value: v.value })) } : {}),
    });
    ids.set(e.index, t.id);
    made.push(t);
  }
  const nextTerms = patches.size ? model.terms.map((t) => patches.get(t.id) ?? t) : model.terms;

  // What an update replaces is taken away; what is added is added once, however many rows said it.
  const removed = new Set<string>();
  for (const e of changed) {
    for (const r of model.relations) {
      if (r.from !== e.target) continue;
      if (e.replace?.parents && r.kind === 'generalization') removed.add(r.id);
      else if (r.prop && e.replace?.links.some((iri) => props.get(iri)?.id === r.prop)) removed.add(r.id);
    }
  }
  const relations = removed.size ? model.relations.filter((r) => !removed.has(r.id)) : [...model.relations];
  const keyOf = (r: Relation) => (r.kind === 'generalization' ? `g|${r.from}|${r.to}` : `p|${r.from}|${r.to}|${r.prop ?? r.label}`);
  const have = new Set(relations.map(keyOf));
  const add = (r: Relation) => {
    const key = keyOf(r);
    if (have.has(key)) return;
    have.add(key);
    relations.push(r);
  };
  const idOf = (r: Reference) => ('row' in r ? ids.get(r.row) : termsByIri.get(r.iri)?.id);
  for (const e of plan.entities) {
    const from = e.target ?? ids.get(e.index)!;
    for (const p of e.parents) {
      const to = idOf(p);
      if (to && to !== from) add(newRelation({ from, to, kind: 'generalization' }));
    }
    for (const l of e.links) {
      const to = idOf(l.to);
      const p = props.get(l.property);
      if (to && p) add(newRelation({ from, to, label: p.name, prop: p.id }));
    }
  }

  // Laid out below what is on the canvas: as a hierarchy of their own, or row by row when there are many.
  const b = bounds(model.terms);
  const top = b ? b.y1 + 130 : 0;
  const left = b ? b.x0 : 0;
  if (made.length <= TREE_UP_TO) {
    const fresh = new Set(made.map((t) => t.id));
    const pos = hierarchyOf({ ...model, terms: made, relations: relations.filter((r) => fresh.has(r.from) && fresh.has(r.to)) });
    const xs = [...pos.values()].map((p) => p.x);
    const dx = left - Math.min(...xs);
    for (const t of made) Object.assign(t, { x: (pos.get(t.id)?.x ?? 0) + dx, y: (pos.get(t.id)?.y ?? 0) + top });
  } else {
    const across = Math.ceil(Math.sqrt(made.length));
    made.forEach((t, i) => Object.assign(t, { x: left + (i % across) * 190, y: top + Math.floor(i / across) * 70 }));
  }
  return {
    model: { ...model, terms: [...nextTerms, ...made], relations },
    terms: made.map((t) => t.id),
    updated: changed.map((e) => e.target!),
  };
}

/** Synonyms in the model's own language: its one string; those in another language are labels of their own. */
function synonymsOf(model: Model, e: PlannedEntity): { own: string; elsewhere?: { value: string; lang: string } } {
  if (!e.synonyms) return { own: '' };
  if (e.synonyms.lang && e.synonyms.lang !== model.lang) return { own: '', elsewhere: { value: e.synonyms.value, lang: e.synonyms.lang } };
  return { own: e.synonyms.value };
}

/** The fields an entity's annotations and synonyms in another language make. */
function fieldsOf(model: Model, e: PlannedEntity): ExtraField[] {
  const fields: ExtraField[] = e.annotations.map((a) => ({ key: a.property, value: a.value, ...(a.lang ? { lang: a.lang } : {}) }));
  const elsewhere = synonymsOf(model, e).elsewhere;
  if (elsewhere) for (const s of elsewhere.value.split(', ')) fields.push({ key: 'skos:altLabel', value: s, lang: elsewhere.lang });
  return fields;
}

/** The term as an update leaves it: the named fields replaced, the rest as it was, and its place kept. */
function updatedTerm(model: Model, t: Term, e: PlannedEntity, termsByIri: Map<string, Term>): Term {
  const rep = e.replace;
  const next: Term = { ...t };
  if (e.setName !== false) {
    next.name = e.name;
    delete next.nameLang;
  }
  if (rep?.description) {
    next.description = e.description?.value ?? '';
    if (e.description?.lang && e.description.lang !== model.lang) next.descriptionLang = e.description.lang;
    else delete next.descriptionLang;
    delete next.describedBy;
  }
  const alt = synonymsOf(model, e).elsewhere;
  let fields = t.fields;
  if (rep) {
    const annotation = new Set(rep.annotations);
    fields = fields.filter((f) => !annotation.has(f.key) && !(rep.synonyms && alt && f.key === 'skos:altLabel' && f.lang === alt.lang));
  }
  if (rep?.synonyms) next.synonyms = synonymsOf(model, e).own;
  const added = fieldsOf(model, e);
  next.fields = added.length ? [...fields, ...added] : fields;
  if (rep?.values.length) {
    const replaced = new Set(rep.values.map((p) => termsByIri.get(p)?.id).filter((id): id is string => !!id));
    const values = [...(t.values ?? []).filter((v) => !replaced.has(v.prop)), ...e.values.filter((v) => replaced.has(termsByIri.get(v.property)?.id ?? '')).map((v) => ({ prop: termsByIri.get(v.property)!.id, value: v.value }))];
    if (values.length) next.values = values;
    else delete next.values;
  }
  return next;
}
