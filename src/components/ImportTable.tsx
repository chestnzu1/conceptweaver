import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ANNOTATION_PROPS } from '../model/annotations';
import { baseIriOf } from '../model/iri';
import { useStore } from '../model/store';
import type { ColumnUse, Plan, RowOutcome, TabularMapping } from '../mapping/contracts';
import { planImport } from '../mapping/plan';
import { fillTemplate, parseTemplate, templateColumns } from '../mapping/template';
import { decodeText, ENCODINGS, parseDelimited, tableOf } from '../import/delimited';
import { guessMapping } from '../import/guess';
import { deleteTemplate, loadTemplates, saveTemplate } from '../import/templates';
import type { Sheet } from '../import/xlsx';

/**
 * Importing a table (roadmap task 2.4, FR-M7-2 to FR-M7-5): a CSV, TSV or Excel file is read in
 * the encoding, with the separator, sheet and header row chosen; each column is given a use; and
 * before anything is made, the preview says what each row becomes, or why it is skipped. The
 * import is one edit, which one undo takes back. A mapping can be kept as a template for the next
 * file laid out the same way.
 */

interface Source {
  name: string;
  bytes: Uint8Array;
  /** For a workbook: its sheets, read. */
  sheets?: Sheet[];
}

const SEPARATORS: [string, string][] = [
  ['auto', 'Found in the file'],
  [',', 'Comma'],
  [';', 'Semicolon'],
  ['\t', 'Tab'],
  ['|', 'Vertical bar'],
];
const SHOWN = 100;

/** What a column becomes, as the value of its select. */
const keyOfUse = (u: ColumnUse | undefined) => (!u ? '' : u.as === 'value' || u.as === 'link' ? `${u.as}:${u.property}` : u.as);

export function ImportTableDialog() {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const close = () => st().setDialog(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [reading, setReading] = useState(false);
  const [encoding, setEncoding] = useState('auto');
  const [separator, setSeparator] = useState('auto');
  const [sheet, setSheet] = useState(0);
  const [header, setHeader] = useState(1);
  const [mapping, setMapping] = useState<TabularMapping | null>(null);
  const [templates, setTemplates] = useState(loadTemplates);
  const [templateName, setTemplateName] = useState('');
  const [show, setShow] = useState<'all' | 'skip' | 'notes'>('all');
  const [limit, setLimit] = useState(SHOWN);
  const skos = model.mode === 'skos';

  const read = async (file: File) => {
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || /\.xlsx$/i.test(file.name)) {
        // The reader of workbooks is loaded when the first one is opened.
        const { readWorkbook } = await import('../import/xlsx');
        const sheets = (await readWorkbook(bytes)).filter((s) => s.rows.length);
        if (!sheets.length) throw new Error('none of its sheets has a row.');
        setSource({ name: file.name, bytes, sheets });
      } else setSource({ name: file.name, bytes });
      setSheet(0);
      setHeader(1);
      setMapping(null);
      setLimit(SHOWN);
    } catch (e) {
      st().notify(`Could not read ${file.name}: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setReading(false);
    }
  };

  const raw = useMemo(() => {
    if (!source) return null;
    if (source.sheets) {
      const s = source.sheets[sheet] ?? source.sheets[0];
      return { rows: s.rows, lines: s.rowNumbers, encoding: '', separator: '' };
    }
    const { text, encoding: used } = decodeText(source.bytes, encoding);
    const parsed = parseDelimited(text, separator === 'auto' ? undefined : separator);
    return { rows: parsed.rows, lines: parsed.lines, encoding: used, separator: parsed.separator };
  }, [source, sheet, encoding, separator]);
  const table = useMemo(() => (raw ? tableOf(raw.rows, raw.lines, header) : null), [raw, header]);

  // A first mapping for the columns, guessed from what they are called, whenever the columns are other ones.
  const columnsKey = table?.columns.join('\u0000') ?? '';
  useEffect(() => {
    if (!table) return;
    setMapping((m) => (m && [...Object.keys(m.columns), ...templateColumns(m.iri)].every((c) => table.columns.includes(c)) ? m : guessMapping(table.columns, model)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey]);

  const deferred = useDeferredValue(mapping);
  const planned = useMemo((): { plan: Plan } | { error: string } | null => {
    if (!table || !deferred) return null;
    try {
      return { plan: planImport(model, table, deferred) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'The mapping does not read.' };
    }
  }, [model, table, deferred]);
  const plan = planned && 'plan' in planned ? planned.plan : null;

  const set = (patch: Partial<TabularMapping>) => setMapping((m) => (m ? { ...m, ...patch } : m));
  const setUse = (column: string, use: ColumnUse | undefined) =>
    setMapping((m) => {
      if (!m) return m;
      const columns = { ...m.columns };
      if (use) columns[column] = use;
      else delete columns[column];
      return { ...m, columns };
    });
  const classes = useMemo(() => model.terms.filter((t) => t.type === 'concept' && t.iri).sort((a, b) => a.name.localeCompare(b.name)), [model.terms]);
  const dataProps = useMemo(() => model.terms.filter((t) => t.type === 'property' && t.iri), [model.terms]);
  const objectProps = useMemo(() => model.props.filter((p) => p.iri), [model.props]);
  const sample = (c: number) =>
    table!.rows
      .map((r) => r[c])
      .filter((v) => v?.trim())
      .slice(0, 2);
  const firstIri = useMemo(() => {
    if (!table || !mapping || !table.rows.length) return '';
    try {
      const made = fillTemplate(parseTemplate(mapping.iri), (c) => (table.columns.includes(c) ? table.rows[0][table.columns.indexOf(c)] : undefined));
      return 'iri' in made ? made.iri : `(${made.error})`;
    } catch (e) {
      return `(${e instanceof Error ? e.message : ''})`;
    }
  }, [table, mapping]);
  const iriFrom = mapping ? templateColumns(mapping.iri)[0] : undefined;
  const iriStyle = mapping && iriFrom && mapping.iri.includes(`{${iriFrom}:name}`) ? 'name' : 'encoded';
  const shownRows = (plan?.rows ?? []).filter((r) => show === 'all' || (show === 'skip' ? r.status === 'skip' : r.notes.length > 0));

  const applyTemplate = (name: string) => {
    const t = templates.find((x) => x.name === name);
    if (!t) return;
    setHeader(t.header);
    if (t.sheet && source?.sheets) setSheet(Math.max(0, source.sheets.findIndex((s) => s.name === t.sheet)));
    setMapping(t.mapping);
    setTemplateName(t.name);
  };
  const keepTemplate = () => {
    if (!mapping || !templateName.trim()) return;
    const kept = saveTemplate({ name: templateName.trim(), mapping, header, ...(source?.sheets ? { sheet: source.sheets[sheet]?.name } : {}) });
    setTemplates(loadTemplates());
    st().notify(kept ? `The mapping is kept as the template “${templateName.trim()}”.` : 'This browser keeps nothing for the site, so the template could not be kept.');
  };
  const run = () => {
    if (!plan?.counts.create) return;
    const { added } = st().importPlan(plan);
    close();
    st().notify(`Imported ${added} ${mapping?.rows === 'individual' ? 'individuals' : skos ? 'concepts' : 'classes'} from ${source?.name}${plan.counts.skip ? `; ${plan.counts.skip} row${plan.counts.skip === 1 ? '' : 's'} skipped` : ''}${plan.counts.exists ? `; ${plan.counts.exists} already in the model` : ''}. One undo takes the import back.`);
  };

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog import-table" role="dialog" aria-modal="true" aria-labelledby="import-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="import-title">Import a table</h2>

        <section className="import-source" aria-label="The file">
          <div className="row wrap">
            <button className="btn" disabled={reading} onClick={() => fileRef.current?.click()}>
              {source ? 'Another file…' : 'Choose a file…'}
            </button>
            <span className="muted">{reading ? 'Reading…' : source ? source.name : 'CSV, TSV or Excel (.xlsx). Each row becomes a class or an individual.'}</span>
          </div>
          {source && raw && (
            <div className="row wrap import-options">
              {source.sheets ? (
                <label className="field">
                  <span>Sheet</span>
                  <select aria-label="Sheet" value={sheet} onChange={(e) => setSheet(Number(e.target.value))}>
                    {source.sheets.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.name} ({s.rows.length} rows)
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className="field">
                    <span>Encoding</span>
                    <select aria-label="Encoding" value={encoding} onChange={(e) => setEncoding(e.target.value)}>
                      {ENCODINGS.map((x) => (
                        <option key={x} value={x}>
                          {x === 'auto' ? `Found in the file (${raw.encoding})` : x}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Separator</span>
                    <select aria-label="Separator" value={separator} onChange={(e) => setSeparator(e.target.value)}>
                      {SEPARATORS.map(([v, l]) => (
                        <option key={l} value={v}>
                          {v === 'auto' ? `${l} (${SEPARATORS.find(([s]) => s === raw.separator)?.[1].toLowerCase() ?? raw.separator})` : l}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <label className="field">
                <span>Header row</span>
                <input aria-label="Header row" type="number" min={0} max={raw.rows.length} value={header} onChange={(e) => setHeader(Math.max(0, Math.min(raw.rows.length, Number(e.target.value) || 0)))} />
              </label>
              <span className="muted">{header ? `Row ${header} names the columns.` : 'No row names the columns.'}</span>
            </div>
          )}
        </section>

        {table && mapping && (
          <section className="import-mapping" aria-label="What each row and column becomes">
            <div className="row wrap">
              <span>Each row is</span>
              <label className="check">
                <input type="radio" name="rows" checked={mapping.rows === 'class'} onChange={() => set({ rows: 'class' })} />
                <span>{skos ? 'a concept' : 'a class'}</span>
              </label>
              {!skos && (
                <label className="check">
                  <input type="radio" name="rows" checked={mapping.rows === 'individual'} onChange={() => set({ rows: 'individual' })} />
                  <span>an individual of</span>
                </label>
              )}
              {!skos && mapping.rows === 'individual' && (
                <select aria-label="Class of the individuals" value={mapping.classIri ?? ''} onChange={(e) => set({ classIri: e.target.value || undefined })}>
                  <option value="">no class, unless a column says</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.iri}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              {templates.length > 0 && (
                <select aria-label="Use a template" value="" onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">Use a template…</option>
                  {templates.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="row wrap import-iri">
              <span>Its IRI is made from</span>
              <select
                aria-label="Column the IRI is made from"
                value={iriFrom ?? ''}
                onChange={(e) => {
                  const ns = baseIriOf(model);
                  set({ iri: `${ns}{${e.target.value}${iriStyle === 'name' ? ':name' : ''}}`, key: e.target.value });
                }}
              >
                {table.columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select aria-label="How the value is put in the IRI" value={iriStyle} onChange={(e) => iriFrom && set({ iri: mapping.iri.replace(new RegExp(`\\{${iriFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:name)?\\}`), `{${iriFrom}${e.target.value === 'name' ? ':name' : ''}}`) })}>
                <option value="encoded">as written</option>
                <option value="name">made into a name</option>
              </select>
              <label className="field grow">
                <span>IRI template</span>
                <input aria-label="IRI template" value={mapping.iri} spellCheck={false} onChange={(e) => set({ iri: e.target.value })} />
              </label>
              <span className="muted sample-iri" title="The IRI of the first row">
                {firstIri}
              </span>
            </div>
            <div className="row wrap">
              <label className="field">
                <span>Rows are referred to by</span>
                <select aria-label="Column rows are referred to by" value={mapping.key ?? ''} onChange={(e) => set({ key: e.target.value || undefined })}>
                  {table.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Several values in a cell, separated by</span>
                <input aria-label="Separator of several values" value={mapping.split ?? ''} placeholder="one value a cell" onChange={(e) => set({ split: e.target.value || undefined })} />
              </label>
            </div>
            <div className="table-wrap import-columns">
              <table>
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>For example</th>
                    <th>Becomes</th>
                  </tr>
                </thead>
                <tbody>
                  {table.columns.map((c, i) => {
                    const use = mapping.columns[c];
                    return (
                      <tr key={c} data-column={c}>
                        <td>
                          <strong>{c}</strong>
                          {templateColumns(mapping.iri).includes(c) && <span className="tag">makes the IRI</span>}
                          {mapping.key === c && <span className="tag">rows are referred to by it</span>}
                        </td>
                        <td className="muted">{sample(i).join(' · ')}</td>
                        <td>
                          <div className="row wrap">
                            <select
                              aria-label={`What ${c} becomes`}
                              value={keyOfUse(use)}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (!v) return setUse(c, undefined);
                                if (v.startsWith('value:')) return setUse(c, { as: 'value', property: v.slice(6) });
                                if (v.startsWith('link:')) return setUse(c, { as: 'link', property: v.slice(5) });
                                if (v === 'annotation') return setUse(c, { as: 'annotation', property: 'skos:note' });
                                setUse(c, { as: v } as ColumnUse);
                              }}
                            >
                              <option value="">Left out</option>
                              <option value="name">Name</option>
                              {mapping.rows === 'class' ? <option value="parent">{skos ? 'Broader concept' : 'Superclass'}</option> : <option value="type">Class</option>}
                              <option value="description">Description</option>
                              <option value="synonyms">Synonyms</option>
                              <option value="annotation">Annotation…</option>
                              {mapping.rows === 'individual' && dataProps.length > 0 && (
                                <optgroup label="A value of the data property">
                                  {dataProps.map((p) => (
                                    <option key={p.id} value={`value:${p.iri}`}>
                                      {p.name}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              {!skos && objectProps.length > 0 && (
                                <optgroup label={mapping.rows === 'individual' ? 'A link by the object property' : 'A restriction by the object property'}>
                                  {objectProps.map((p) => (
                                    <option key={p.id} value={`link:${p.iri}`}>
                                      {p.name}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </select>
                            {use?.as === 'annotation' && (
                              <select aria-label={`Annotation property of ${c}`} value={use.property} onChange={(e) => setUse(c, { ...use, property: e.target.value })}>
                                {ANNOTATION_PROPS.filter((p) => !['owl:deprecated', 'rdfs:label', 'skos:prefLabel'].includes(p.id)).map((p) => (
                                  <option key={p.id} value={p.id} title={p.about}>
                                    {p.id}
                                  </option>
                                ))}
                              </select>
                            )}
                            {(use?.as === 'annotation' || use?.as === 'description' || use?.as === 'synonyms') && (
                              <input className="lang" aria-label={`Language of ${c}`} placeholder="language, e.g. en" value={use.lang ?? ''} onChange={(e) => setUse(c, { ...use, lang: e.target.value.trim() || undefined })} />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="row wrap">
              <input aria-label="Name of the template" placeholder="Name of a template" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
              <button className="btn small" disabled={!templateName.trim()} title="Keeps this mapping, to import the next file laid out the same way" onClick={keepTemplate}>
                Keep as a template
              </button>
              {templates.some((t) => t.name === templateName.trim()) && (
                <button
                  className="btn small ghost"
                  onClick={() => {
                    deleteTemplate(templateName.trim());
                    setTemplates(loadTemplates());
                  }}
                >
                  Delete the template
                </button>
              )}
            </div>
          </section>
        )}

        {planned && 'error' in planned && (
          <p className="bad" role="alert">
            {planned.error}
          </p>
        )}
        {plan && (
          <section className="import-preview" aria-label="Preview">
            <p className="counts" role="status">
              <strong>{plan.counts.create}</strong> to make · {plan.counts.exists} already in the model · <strong>{plan.counts.skip}</strong> skipped
              {plan.counts.notes ? ` · ${plan.counts.notes} value${plan.counts.notes === 1 ? '' : 's'} left out` : ''}
            </p>
            {mapping?.rows === 'class' && plan.entities.some((e) => e.parents.some((p) => 'row' in p)) && <Hierarchy plan={plan} />}
            <div className="row wrap">
              {(
                [
                  ['all', `Every row (${plan.rows.length})`],
                  ['skip', `Skipped (${plan.counts.skip})`],
                  ['notes', `With values left out (${plan.rows.filter((r) => r.notes.length).length})`],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={'btn small' + (show === id ? ' on' : '')} aria-pressed={show === id} onClick={() => setShow(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="table-wrap import-rows">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>Row</th>
                    <th>Name</th>
                    <th>What happens</th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.slice(0, limit).map((r) => (
                    <RowLine key={r.row} r={r} />
                  ))}
                </tbody>
              </table>
            </div>
            {shownRows.length > limit && (
              <button className="btn small" onClick={() => setLimit(limit + SHOWN * 5)}>
                Show {Math.min(SHOWN * 5, shownRows.length - limit)} more
              </button>
            )}
          </section>
        )}

        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!plan?.counts.create} onClick={run}>
            {plan?.counts.create ? `Import ${plan.counts.create}` : 'Import'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".csv,.tsv,.tab,.txt,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void read(f);
          }}
        />
      </div>
    </div>
  );
}

function RowLine({ r }: { r: RowOutcome }) {
  return (
    <tr className={'import-row ' + r.status} data-row={r.row}>
      <td>{r.row}</td>
      <td>
        {r.name ?? <span className="muted">—</span>}
        {r.iri && <code className="iri"> {r.iri}</code>}
      </td>
      <td>
        <span className={'tag ' + r.status}>{r.status === 'create' ? 'made' : r.status === 'exists' ? 'in the model' : 'skipped'}</span>
        {r.reason && <span className="reason"> {r.reason[0].toUpperCase() + r.reason.slice(1)}.</span>}
        {r.notes.map((n) => (
          <span key={n} className="note">
            {' '}
            {n[0].toUpperCase() + n.slice(1)}.
          </span>
        ))}
      </td>
    </tr>
  );
}

/** The classes an import makes, as the hierarchy they will be: the first few, a few levels down. */
function Hierarchy({ plan }: { plan: Plan }) {
  const children = new Map<number, number[]>();
  const index = new Map(plan.entities.map((e, n) => [e.index, n]));
  const roots: number[] = [];
  plan.entities.forEach((e, n) => {
    const parents = e.parents.filter((p): p is { row: number } => 'row' in p && index.has(p.row));
    if (!parents.length) roots.push(n);
    for (const p of parents) children.set(index.get(p.row)!, [...(children.get(index.get(p.row)!) ?? []), n]);
  });
  const MAX = 8;
  const branch = (n: number, depth: number): React.ReactNode => {
    const kids = children.get(n) ?? [];
    return (
      <li key={n}>
        {plan.entities[n].name}
        {kids.length > 0 && depth < 3 && (
          <ul>
            {kids.slice(0, MAX).map((k) => branch(k, depth + 1))}
            {kids.length > MAX && <li className="muted">and {kids.length - MAX} more</li>}
          </ul>
        )}
        {kids.length > 0 && depth >= 3 && <span className="muted"> ({kids.length} below)</span>}
      </li>
    );
  };
  return (
    <details className="import-tree" open>
      <summary>As a hierarchy</summary>
      <ul>
        {roots.slice(0, MAX).map((n) => branch(n, 0))}
        {roots.length > MAX && <li className="muted">and {roots.length - MAX} more at the top</li>}
      </ul>
    </details>
  );
}
