import { propDatatype } from '../model/domains';
import { bounds } from '../model/geometry';
import { hierarchyOf } from '../layout/graph';
import { expandIri } from '../model/prefixes';
import { newRelation, newTerm, type ExtraField, type Model, type Relation, type Term } from '../model/types';
import { quoted } from '../model/words';
import type { PlannedEntity, Plan, Reference, RowOutcome, Table, TabularMapping } from './contracts';
import { fillTemplate, parseTemplate, templateColumns } from './template';
import { convert } from './values';

/**
 * What an import would do, row by row (roadmap task 2.4, FR-M7-3, FR-M7-4, ADR-019), and the
 * model it makes. A row is made into an entity, or found in the model already and left as it
 * is, or skipped, with why: its IRI cannot be made, another row has it, or what it says it is
 * under (a parent, a class) is neither a row of the table nor in the model. A row under a row
 * that is skipped is skipped too, so that nothing is made half. A value that cannot be what its
 * column says (a price that is no number, a link to nothing) is left out, and the row says so.
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

  // ------------------------------------------------------------ each row's IRI and name
  const outcomes: RowOutcome[] = table.rows.map((_r, i) => ({ row: table.rowNumbers[i] ?? i + 1, status: 'create', notes: [] }));
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
    if (nameCol && !named) o.notes.push(`it has no ${nameCol}: it is named after its IRI`);
    const before = byIri.get(made.iri);
    if (before !== undefined) {
      o.status = 'skip';
      o.reason = `row ${outcomes[before].row} has the same IRI, ${made.iri}`;
      return;
    }
    byIri.set(made.iri, i);
    const there = terms.get(made.iri) ?? props.get(made.iri);
    if (there) {
      o.status = 'exists';
      o.reason = `it is in the model already, as ${quoted(there.name || 'Unnamed')}, and is left as it is`;
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
  // Links to rows that are skipped are left out; links and parents to rows that exist go to the entity in the model.
  const kept = entities.filter((e): e is PlannedEntity => !!e);
  for (const e of kept) {
    const at = (r: Reference): Reference => ('row' in r && outcomes[r.row].status === 'exists' ? { iri: outcomes[r.row].iri! } : r);
    e.parents = e.parents.map(at);
    e.links = e.links
      .filter((l) => {
        if (!('row' in l.to) || outcomes[l.to.row].status !== 'skip') return true;
        outcomes[e.index].notes.push(`the link to row ${outcomes[l.to.row].row} is left out: that row is skipped`);
        return false;
      })
      .map((l) => ({ ...l, to: at(l.to) }));
  }
  const count = (s: RowOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  return { rows: outcomes, entities: kept, counts: { create: count('create'), exists: count('exists'), skip: count('skip'), notes: outcomes.reduce((n, o) => n + (o.status === 'create' ? o.notes.length : 0), 0) } };
}

/** Above this many new terms, they are laid out row by row rather than as a hierarchy, which would take too long. */
const TREE_UP_TO = 3000;

/**
 * The model with what a plan makes: the entities, their superclasses or classes, their values
 * and links, laid out below what is on the canvas. One model, for one edit of the document.
 */
export function applyPlan(model: Model, plan: Plan): { model: Model; terms: string[] } {
  if (!plan.entities.length) return { model, terms: [] };
  const ids = new Map<number, string>();
  const byIri = new Map(model.terms.filter((t) => t.iri).map((t) => [t.iri!, t.id]));
  const props = new Map(model.props.filter((p) => p.iri).map((p) => [p.iri!, p]));
  const terms: Term[] = plan.entities.map((e) => {
    const fields: ExtraField[] = e.annotations.map((a) => ({ key: a.property, value: a.value, ...(a.lang ? { lang: a.lang } : {}) }));
    // Synonyms in another language than the model's are labels of their own, in that language.
    const synonymsElsewhere = e.synonyms?.lang && e.synonyms.lang !== model.lang;
    if (synonymsElsewhere) for (const s of e.synonyms!.value.split(', ')) fields.push({ key: 'skos:altLabel', value: s, lang: e.synonyms!.lang });
    const t = newTerm({
      name: e.name,
      iri: e.iri,
      type: e.kind === 'class' ? 'concept' : 'instance',
      description: e.description?.value ?? '',
      ...(e.description?.lang && e.description.lang !== model.lang ? { descriptionLang: e.description.lang } : {}),
      synonyms: e.synonyms && !synonymsElsewhere ? e.synonyms.value : '',
      fields,
      ...(e.values.length ? { values: e.values.map((v) => ({ prop: byIri.get(v.property)!, value: v.value })) } : {}),
    });
    ids.set(e.index, t.id);
    return t;
  });
  const idOf = (r: Reference) => ('row' in r ? ids.get(r.row) : byIri.get(r.iri));
  const relations: Relation[] = [];
  plan.entities.forEach((e, n) => {
    const from = terms[n].id;
    for (const p of e.parents) {
      const to = idOf(p);
      if (to && to !== from) relations.push(newRelation({ from, to, kind: 'generalization' }));
    }
    for (const l of e.links) {
      const to = idOf(l.to);
      const p = props.get(l.property);
      if (to && p) relations.push(newRelation({ from, to, label: p.name, prop: p.id }));
    }
  });

  // Laid out below what is on the canvas: as a hierarchy of their own, or row by row when there are many.
  const b = bounds(model.terms);
  const top = b ? b.y1 + 130 : 0;
  const left = b ? b.x0 : 0;
  if (terms.length <= TREE_UP_TO) {
    const fresh = new Set(terms.map((t) => t.id));
    const pos = hierarchyOf({ ...model, terms, relations: relations.filter((r) => fresh.has(r.from) && fresh.has(r.to)) });
    const xs = [...pos.values()].map((p) => p.x);
    const dx = left - Math.min(...xs);
    for (const t of terms) Object.assign(t, { x: (pos.get(t.id)?.x ?? 0) + dx, y: (pos.get(t.id)?.y ?? 0) + top });
  } else {
    const across = Math.ceil(Math.sqrt(terms.length));
    terms.forEach((t, i) => Object.assign(t, { x: left + (i % across) * 190, y: top + Math.floor(i / across) * 70 }));
  }
  return { model: { ...model, terms: [...model.terms, ...terms], relations: [...model.relations, ...relations] }, terms: terms.map((t) => t.id) };
}
