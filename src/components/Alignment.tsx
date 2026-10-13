import { useEffect, useMemo, useRef, useState } from 'react';
import { addMapping, importMappings, listMappings, mappedCounts, MAPPING_PREDICATES, mappingIssues, mappingPredicate, mappingsToTurtle, removeMapping, setMappingMeta, type EntityKind, type Mapping } from '../model/alignment';
import { copyEntities, externalUse, importsClosure, reuseEntity, type Entity, type ExtEntity } from '../model/external';
import { download } from '../model/files';
import { listModels, loadModel, type SavedInfo } from '../model/library';
import { suggestMappings, type Suggestion } from '../model/matcher';
import { compactIri } from '../model/prefixes';
import { propKey } from '../model/props';
import { toTurtle } from '../model/rdf';
import { asTurtle, fetchDocument, fileText, ONTOLOGY_FILES } from '../model/rdfFormats';
import { stable } from '../model/stable';
import { useStore } from '../model/store';
import { classTree, ROOT } from '../model/tree';
import { MAPPING_STATUS, type ExternalRef, type MappingMeta, type Model } from '../model/types';
import { owlFindings } from '../model/validation';
import { CommitInput } from './fields';

/**
 * Other ontologies and this one: a library of them, reuse of their entities, and mappings to
 * them. Three different things can be done with another ontology (depend on it, refer to one
 * of its entities, copy from it) and the view keeps them apart, because they mean different
 * things in OWL.
 */

const KINDS: EntityKind[] = ['class', 'object property', 'data property', 'individual'];
const PLURAL: Record<EntityKind, string> = { class: 'Classes', 'object property': 'Object properties', 'data property': 'Data properties', individual: 'Individuals' };
const PAGE = 300;

/** An entity in a list: of this model or of an external ontology's own model. */
interface Item {
  /** Term id or object property key, in the model it comes from. */
  id: string;
  prop: boolean;
  iri: string;
  name: string;
  description: string;
  depth: number;
}

/** The entities of one kind in a model, classes as an indented hierarchy. External references are left out when `own`. */
function itemsOf(model: Model, kind: EntityKind, own: boolean): Item[] {
  if (kind === 'object property') {
    return model.props
      .filter((p) => p.iri && (!own || p.external === undefined))
      .map((p) => ({ id: propKey(p.name), prop: true, iri: p.iri!, name: p.name, description: p.description, depth: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const type = kind === 'class' ? 'concept' : kind === 'data property' ? 'property' : 'instance';
  const terms = model.terms.filter((t) => t.type === type && t.iri && (!own || t.external === undefined));
  const item = (id: string, depth: number): Item | undefined => {
    const t = byId.get(id);
    return t ? { id, prop: false, iri: t.iri!, name: t.name || 'Unnamed', description: t.description, depth } : undefined;
  };
  const byId = new Map(terms.map((t) => [t.id, t]));
  if (kind !== 'class') return terms.map((t) => item(t.id, 0)!).sort((a, b) => a.name.localeCompare(b.name));
  // The hierarchy, each class once: under its first parent.
  const tree = classTree(model);
  const out: Item[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const it = item(id, depth);
    if (it) out.push(it);
    for (const c of tree.children.get(id) ?? []) walk(c, it ? depth + 1 : depth);
  };
  for (const c of tree.children.get(ROOT) ?? []) walk(c, 0);
  for (const t of terms) if (!seen.has(t.id)) out.push(item(t.id, 0)!);
  return out;
}

const matches = (i: Item, q: string) => !q || `${i.name}\n${i.iri}\n${i.description}`.toLowerCase().includes(q);

function EntityList({ items, model, selected, onSelect, mapped, label, render }: { items: Item[]; model: Model; selected?: string; onSelect?: (i: Item) => void; mapped?: Map<string, number>; label: string; render?: (i: Item) => React.ReactNode }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => matches(i, q));
  return (
    <div className="entity-list">
      <input type="search" aria-label={`Search ${label}`} placeholder="Search by label, IRI or definition" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <ul aria-label={label}>
        {shown.slice(0, PAGE).map((i) => (
          <li key={i.id} className={(selected === i.id ? 'on' : '') + (mapped?.has(i.iri) ? ' mapped' : '')} style={{ paddingLeft: 6 + (q ? 0 : i.depth) * 14 }}>
            <button className="pick" title={`${i.iri}${i.description ? '\n' + i.description : ''}`} onClick={() => onSelect?.(i)} aria-pressed={selected === i.id}>
              <span className="name">{i.name}</span> <span className="muted">{compactIri(model, i.iri) ?? i.iri}</span>
              {mapped?.has(i.iri) && <span className="tag auto">{mapped.get(i.iri)} mapped</span>}
            </button>
            {render?.(i)}
          </li>
        ))}
        {!shown.length && <li className="muted">{items.length ? 'Nothing matches.' : 'None.'}</li>}
        {shown.length > PAGE && <li className="muted">Showing {PAGE} of {shown.length}. Search to narrow the list.</li>}
      </ul>
    </div>
  );
}

/** Makes a change and, if it put new terms on the canvas, brings the whole graph into view so that they are not left off-screen. */
function placed<T>(change: () => T): T {
  const st = useStore.getState;
  const before = st().model.terms.length;
  const out = change();
  if (st().model.terms.length > before) st().fit();
  return out;
}

const fmtDate = (ms: number) => (ms ? new Date(ms).toLocaleDateString() : '—');

export function AlignmentView() {
  const model = stable(useStore((s) => s.model));
  const { loaded, missing, tab, selected, preview } = useStore((s) => s.ext);
  const docSeq = useStore((s) => s.docSeq);
  const st = useStore.getState;
  useEffect(() => void st().loadExternals(), [docSeq, model.externals, st]);
  const mappings = useMemo(() => listMappings(model), [model]);
  const ref = model.externals.find((e) => e.id === selected) ?? model.externals[0];

  return (
    <div className="view alignment">
      <div className="view-head">
        <div className="tabs" role="tablist" aria-label="Alignment">
          {(
            [
              ['library', `Ontology library (${model.externals.length})`],
              ['align', 'Align'],
              ['mappings', `Mappings (${mappings.length})`],
              ['suggestions', 'Suggestions'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => st().setExt({ tab: id })}>
              {label}
            </button>
          ))}
        </div>
        <AddOntology />
      </div>
      {missing.length > 0 && (
        <p className="stale" role="alert">
          The content of {missing.map((id) => `“${model.externals.find((e) => e.id === id)?.name}”`).join(', ')} is not in this browser, so {missing.length === 1 ? 'it' : 'they'} cannot be browsed or checked here. The references and mappings are kept. Add the ontology again from its file or URL to restore it.
        </p>
      )}
      {tab === 'library' && <Library model={model} loaded={loaded} missing={missing} current={ref} mappings={mappings} />}
      {tab === 'align' && <Align model={model} loaded={loaded} current={ref} mappings={mappings} />}
      {tab === 'mappings' && <Mappings model={model} loaded={loaded} mappings={mappings} />}
      {tab === 'suggestions' && <Suggestions model={model} loaded={loaded} current={ref} mappings={mappings} />}
      {preview && <PreviewDialog />}
    </div>
  );
}

/** The ways of bringing an ontology in: a file, a URL, or a model saved in this browser. */
function AddOntology() {
  const st = useStore.getState;
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'url' | 'saved' | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<SavedInfo[]>([]);
  const read = async (text: string, source: string, kind: 'file' | 'url' | 'model', contentType?: string) => {
    let turtle = text;
    // In whichever syntax it comes, it is kept here as Turtle: that is what is read again later, and what a reasoner is sent.
    // A saved model is written as Turtle to begin with.
    if (kind !== 'model') {
      try {
        turtle = (await asTurtle(text, { name: source, contentType, ...(kind === 'url' ? { url: source } : {}), serviceUrl: st().validation.reasonerUrl })).turtle;
      } catch (e) {
        return setError(`${source} could not be read. ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const problem = st().previewExternal(turtle, source, kind);
    setError(problem ? `${source} could not be read: ${problem}` : undefined);
    if (!problem) setMode(null);
  };
  const fetchUrl = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { text, contentType } = await fetchDocument(url.trim());
      await read(text, url.trim(), 'url', contentType);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace('open it as a file', 'add it as a file') : `${url.trim()} could not be fetched.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="add-ontology">
      <div className="row">
        <span className="muted">Add an ontology:</span>
        <button className="btn small primary" onClick={() => fileRef.current?.click()}>
          From a file…
        </button>
        <button className="btn small" aria-expanded={mode === 'url'} onClick={() => setMode(mode === 'url' ? null : 'url')}>
          From a URL…
        </button>
        <button
          className="btn small"
          aria-expanded={mode === 'saved'}
          onClick={() => {
            setMode(mode === 'saved' ? null : 'saved');
            listModels().then(setSaved, () => setSaved([]));
          }}
        >
          From My Models…
        </button>
      </div>
      {mode === 'url' && (
        <div className="row">
          <input type="url" aria-label="Ontology URL" placeholder="https://… (Turtle, RDF/XML, JSON-LD)" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && url.trim() && void fetchUrl())} />
          <button className="btn small primary" disabled={!url.trim() || busy} onClick={() => void fetchUrl()}>
            {busy ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
      )}
      {mode === 'saved' && (
        <ul className="saved-models" aria-label="Saved models">
          {saved
            .filter((m) => m.id !== st().doc.id)
            .map((m) => (
              <li key={m.id}>
                <button className="link" onClick={async () => { const found = await loadModel(m.id); if (found) void read(toTurtle(found.model), m.name, 'model'); }}>
                  {m.name}
                </button>{' '}
                <span className="muted">{m.entities} entities</span>
              </li>
            ))}
          {!saved.filter((m) => m.id !== st().doc.id).length && <li className="muted">No other saved models in this browser.</li>}
        </ul>
      )}
      {error && (
        <p className="bad" role="alert">
          {error}
        </p>
      )}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept={ONTOLOGY_FILES}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void read(await fileText(f), f.name, 'file');
        }}
      />
    </div>
  );
}

/** What an ontology is, shown before anything is done with it, and the choice of what to do. */
function PreviewDialog() {
  const preview = useStore((s) => s.ext.preview)!;
  const st = useStore.getState;
  const { ref } = preview.summary;
  const conflicts = preview.collisions.filter((c) => c.conflict);
  const confirm = (imports: boolean, then: 'library' | 'copy') => {
    st().confirmExternal(imports);
    st().setExt({ tab: 'library' });
    if (then === 'copy') st().notify('Added to the library. Tick the entities to copy, then “Copy selected”.');
  };
  return (
    <div className="backdrop">
      <div className="dialog ext-preview" role="dialog" aria-modal="true" aria-label="External ontology">
        <h2>External ontology</h2>
        <h3>{ref.name}</h3>
        <dl>
          <dt>Ontology IRI</dt>
          <dd>{ref.iri ? <code>{ref.iri}</code> : <span className="muted">none stated in the file</span>}</dd>
          {ref.versionIri && (
            <>
              <dt>Version IRI</dt>
              <dd>
                <code>{ref.versionIri}</code>
              </dd>
            </>
          )}
          <dt>Namespace</dt>
          <dd>
            <code>{ref.namespace}</code>
          </dd>
          <dt>Source</dt>
          <dd>{ref.source}</dd>
          <dt>Classes</dt>
          <dd>{ref.classes}</dd>
          <dt>Object properties</dt>
          <dd>{ref.objectProperties}</dd>
          <dt>Data properties</dt>
          <dd>{ref.dataProperties}</dd>
          <dt>Individuals</dt>
          <dd>{ref.individuals}</dd>
        </dl>
        {preview.collisions.length > 0 && (
          <div className={conflicts.length ? 'bad' : 'muted'} role={conflicts.length ? 'alert' : undefined}>
            {preview.collisions.length} of its entities have an IRI that your ontology already defines{conflicts.length ? `, ${conflicts.length} of them differently` : ', in the same way'}. Nothing of yours will be overwritten.
            <ul>
              {preview.collisions.slice(0, 6).map((c) => (
                <li key={c.iri}>
                  <code>{c.iri}</code> {c.conflict ?? 'same kind and name'}
                </li>
              ))}
              {preview.collisions.length > 6 && <li>and {preview.collisions.length - 6} more</li>}
            </ul>
          </div>
        )}
        <p className="muted">
          Either way the ontology goes into the library, where you can browse it, reuse its entities and map to them. None of its axioms are merged into your ontology.
        </p>
        <div className="choices">
          <div>
            <button className="btn primary" onClick={() => confirm(true, 'library')} disabled={!ref.iri} title={ref.iri ? undefined : 'An ontology without an IRI cannot be imported by reference'}>
              Reference ontology
            </button>
            <small>
              Your ontology depends on it: <code>owl:imports</code> is written, and its axioms count when reasoning. Its content stays its own.
            </small>
          </div>
          <div>
            <button className="btn" onClick={() => confirm(false, 'copy')}>
              Import axioms…
            </button>
            <small>No dependency. You then choose entities to copy in; the copies keep their IRIs and are yours to maintain from then on.</small>
          </div>
          <div>
            <button className="btn" onClick={() => st().setExt({ preview: null })}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface Common {
  model: Model;
  loaded: Record<string, Model>;
  mappings: Mapping[];
}

function OntologyPicker({ model, current }: { model: Model; current?: ExternalRef }) {
  return (
    <select aria-label="External ontology" value={current?.id ?? ''} onChange={(e) => useStore.getState().setExt({ selected: e.target.value })}>
      {model.externals.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name}
        </option>
      ))}
    </select>
  );
}

function Library({ model, loaded, missing, current, mappings }: Common & { missing: string[]; current?: ExternalRef }) {
  const st = useStore.getState;
  const [kind, setKind] = useState<EntityKind>('class');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const ext = current ? loaded[current.id] : undefined;
  const items = useMemo(() => (ext ? itemsOf(ext, kind, false) : []), [ext, kind]);
  const here = useMemo(() => new Map([...model.terms.filter((t) => t.iri).map((t) => [t.iri!, t.external !== undefined ? 'referred to' : 'copied'] as const), ...model.props.filter((p) => p.iri).map((p) => [p.iri!, p.external !== undefined ? 'referred to' : 'copied'] as const)]), [model]);
  const mapped = useMemo(() => mappedCounts(mappings), [mappings]);
  if (!model.externals.length) {
    return (
      <div className="muted pad">
        <p>No other ontologies yet. Add one from a file, a URL or your saved models.</p>
        <p>An ontology in the library is kept apart from yours. You can depend on it (owl:imports), refer to its entities under their own IRIs, copy entities in, or map your entities to its.</p>
      </div>
    );
  }
  const entityOf = (i: Item): ExtEntity => (i.prop ? { prop: i.id } : { term: i.id });
  const reuse = (i: Item) => {
    if (!current || !ext) return;
    const r = reuseEntity(st().model, current, ext, entityOf(i));
    if (r.added) placed(() => st().apply(() => r.model));
    st().notify(r.added ? `“${i.name}” can now be chosen as a superclass, domain, range or filler. It keeps its IRI ${i.iri}.` : `“${i.name}” is already in your ontology.`);
  };
  const copy = () => {
    if (!current || !ext) return;
    const chosen = items.filter((i) => picked.has(i.id));
    const r = copyEntities(st().model, current, ext, { terms: chosen.filter((i) => !i.prop).map((i) => i.id), props: chosen.filter((i) => i.prop).map((i) => i.id) });
    placed(() => st().apply(() => r.model));
    setPicked(new Set());
    st().notify(`Copied ${r.copied} ${r.copied === 1 ? 'entity' : 'entities'} with their definitions; they are now yours to maintain.${r.referenced ? ` ${r.referenced} they refer to are kept as references.` : ''}${r.skipped.length ? ` ${r.skipped.length} skipped: already in your ontology.` : ''}`);
  };
  return (
    <div className="library-grid">
      <aside aria-label="External ontologies">
        <ul className="ontologies">
          {model.externals.map((e) => (
            <li key={e.id}>
              <button className={current?.id === e.id ? 'on' : ''} aria-current={current?.id === e.id} onClick={() => (st().setExt({ selected: e.id }), setPicked(new Set()), setError(undefined))}>
                <strong>{e.name}</strong>
                <span className="muted">{e.iri || e.namespace}</span>
                <span>
                  <span className={'tag ' + (e.imports ? 'dep' : 'auto')}>{e.imports ? 'dependency · owl:imports' : 'library only'}</span>
                  {missing.includes(e.id) && <span className="tag warn">content missing</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {current && (
        <section className="ontology-detail">
          <div className="row wrap head">
            <h3>{current.name}</h3>
            <label className="check" title="Your ontology imports it: owl:imports is written on export, and its axioms count when reasoning.">
              <input type="checkbox" checked={current.imports} disabled={!current.iri} onChange={(e) => st().apply((m) => ({ ...m, externals: m.externals.map((x) => (x.id === current.id ? { ...x, imports: e.target.checked } : x)) }))} />
              <span>
                Dependency <code className="pred">owl:imports</code>
              </span>
            </label>
            <button className="btn small danger" onClick={() => setError(st().removeExternalRef(current.id))}>
              Remove from the library
            </button>
          </div>
          {error && (
            <p className="bad" role="alert">
              {error}
            </p>
          )}
          <dl className="ontology-facts">
            <dt>Ontology IRI</dt>
            <dd>{current.iri ? <code>{current.iri}</code> : '—'}</dd>
            <dt>Version IRI</dt>
            <dd>{current.versionIri ? <code>{current.versionIri}</code> : '—'}</dd>
            <dt>Namespace</dt>
            <dd>
              <code>{current.namespace || '—'}</code>
            </dd>
            <dt>Source</dt>
            <dd>{current.source ? `${current.source} (${current.sourceKind})` : 'named by an imported file; content never supplied'}</dd>
            <dt>Added</dt>
            <dd>{fmtDate(current.addedAt)}</dd>
            <dt>Entities</dt>
            <dd>
              {current.classes} classes · {current.objectProperties} object properties · {current.dataProperties} data properties · {current.individuals} individuals
            </dd>
            <dt>Used here</dt>
            <dd>{(() => { const u = externalUse(model, current.id); return u.entities ? `${u.entities} of its entities referred to, in ${u.statements} statement${u.statements === 1 ? '' : 's'}` : 'not yet'; })()}</dd>
            {ext?.description && (
              <>
                <dt>Description</dt>
                <dd>{ext.description}</dd>
              </>
            )}
          </dl>
          {!ext ? (
            <p className="muted">Its content is not available in this browser, so it cannot be browsed.</p>
          ) : (
            <>
              <div className="row wrap">
                <div className="tabs" role="tablist" aria-label="Kind of entity">
                  {KINDS.map((k) => (
                    <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                      {PLURAL[k]}
                    </button>
                  ))}
                </div>
                <button className="btn small" disabled={!picked.size} title="Copies the ticked entities into your ontology with their definitions. The copies are yours to maintain from then on." onClick={copy}>
                  Copy selected ({picked.size})
                </button>
                <button className="btn small ghost" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}>
                  {picked.size === items.length && items.length ? 'Select none' : 'Select all'}
                </button>
              </div>
              <EntityList
                items={items}
                model={ext}
                mapped={mapped}
                label={`${PLURAL[kind]} of ${current.name}`}
                render={(i) => (
                  <span className="actions">
                    {here.has(i.iri) ? (
                      <span className="tag auto">{here.get(i.iri)}</span>
                    ) : (
                      <>
                        <label className="check" title="Tick to copy with its definition">
                          <input type="checkbox" aria-label={`Select ${i.name} to copy`} checked={picked.has(i.id)} onChange={(e) => setPicked((p) => { const n = new Set(p); e.target.checked ? n.add(i.id) : n.delete(i.id); return n; })} />
                        </label>
                        <button className="btn small" title="Refer to it under its own IRI, so it can be chosen as a superclass, domain, range or filler. Its definition is not copied." aria-label={`Reuse ${i.name}`} onClick={() => reuse(i)}>
                          Reuse
                        </button>
                      </>
                    )}
                  </span>
                )}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Align({ model, loaded, current, mappings }: Common & { current?: ExternalRef }) {
  const st = useStore.getState;
  const [kind, setKind] = useState<EntityKind>('class');
  const [local, setLocal] = useState<Item>();
  const [other, setOther] = useState<Item>();
  const [predicate, setPredicate] = useState('');
  const [reverse, setReverse] = useState(false);
  const [error, setError] = useState<string>();
  const ext = current ? loaded[current.id] : undefined;
  const mine = useMemo(() => itemsOf(model, kind, true), [model, kind]);
  const theirs = useMemo(() => (ext ? itemsOf(ext, kind, false) : []), [ext, kind]);
  const mapped = useMemo(() => mappedCounts(mappings), [mappings]);
  const predicates = MAPPING_PREDICATES.filter((p) => p.kinds.includes(kind) && (model.mode !== 'skos' || p.group === 'SKOS'));
  const def = mappingPredicate(predicate);
  const reset = (k: EntityKind) => (setKind(k), setLocal(undefined), setOther(undefined), setPredicate(''), setError(undefined));
  if (!current) return <p className="muted pad">Add an ontology to the library first; then its entities can be mapped to yours.</p>;
  const create = () => {
    if (!local || !other || !ext) return;
    // The external entity becomes a reference in the model if it is not one yet, then the mapping is stated; one undo step for both.
    const reused = reuseEntity(st().model, current, ext, other.prop ? { prop: other.id } : { term: other.id });
    const mineRef: Entity = { kind: local.prop ? 'prop' : 'term', id: local.id };
    const problem = placed(() => st().edit(() => (reverse ? addMapping(reused.model, reused.entity, predicate, mineRef) : addMapping(reused.model, mineRef, predicate, reused.entity))));
    setError(problem);
    if (!problem) setPredicate('');
  };
  const [a, b] = reverse ? [other, local] : [local, other];
  return (
    <div className="align">
      <div className="row wrap">
        <div className="tabs" role="tablist" aria-label="Kind of entity to align">
          {KINDS.filter((k) => model.mode !== 'skos' || k === 'class').map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => reset(k)}>
              {model.mode === 'skos' ? 'Concepts' : PLURAL[k]}
            </button>
          ))}
        </div>
        <span className="muted">with</span>
        <OntologyPicker model={model} current={current} />
      </div>
      <div className="sides">
        <section>
          <h3>{model.name} <span className="muted">your ontology</span></h3>
          <EntityList items={mine} model={model} selected={local?.id} onSelect={(i) => (setLocal(i), setError(undefined))} mapped={mapped} label="Local entities" />
        </section>
        <section>
          <h3>{current.name} <span className="muted">external</span></h3>
          {ext ? <EntityList items={theirs} model={ext} selected={other?.id} onSelect={(i) => (setOther(i), setError(undefined))} mapped={mapped} label="External entities" /> : <p className="muted">Its content is not available in this browser.</p>}
        </section>
      </div>
      <div className="mapping-form" aria-label="New mapping">
        <div className="pair">
          {[a, b].map((x, n) => (
            <div key={n} className="end">
              <span className="muted">{n === 0 ? 'Source' : 'Target'}</span>
              {x ? (
                <>
                  <strong>{x.name}</strong>
                  <code>{x.iri}</code>
                  {x.description && <small>{x.description}</small>}
                </>
              ) : (
                <em className="muted">select {(n === 0) !== reverse ? 'one of your entities' : 'an external entity'} above</em>
              )}
            </div>
          ))}
        </div>
        <div className="row wrap">
          <label>
            <span>Mapping relationship</span>
            <select aria-label="Mapping relationship" value={predicate} onChange={(e) => (setPredicate(e.target.value), setError(undefined))}>
              <option value="">choose…</option>
              {(['OWL', 'SKOS'] as const).map((g) => (
                <optgroup key={g} label={g}>
                  {predicates.filter((p) => p.group === g).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button className="btn small" disabled={def?.symmetric} title={def?.symmetric ? 'This relationship holds both ways, so there is no direction to swap' : 'Swap source and target'} onClick={() => setReverse(!reverse)}>
            ⇄ Swap direction
          </button>
          <button className="btn primary" disabled={!local || !other || !predicate} onClick={create}>
            Create mapping
          </button>
        </div>
        {def && <p className="muted">{def.about}</p>}
        {a && b && def && (
          <p className="statement">
            <code>
              {compactIri(model, a.iri) ?? `<${a.iri}>`} {def.id} {compactIri(model, b.iri) ?? `<${b.iri}>`}
            </code>
          </p>
        )}
        {error && (
          <p className="bad" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function Mappings({ model, loaded, mappings }: Common) {
  const st = useStore.getState;
  const fileRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [withMeta, setWithMeta] = useState(false);
  const [error, setError] = useState<string>();
  const shown = mappings.filter((m) => !filter || m.predicate === filter);
  const used = [...new Set(mappings.map((m) => m.predicate))];
  const short = (iri: string) => compactIri(model, iri) ?? iri;
  // The reasoner over this ontology together with the ones it imports: what the mappings lead to.
  const check = useMemo(() => {
    const closure = importsClosure(model, new Map(Object.entries(loaded)));
    return { ...owlFindings(closure.model), missing: closure.missing, issues: mappingIssues(model, mappings) };
  }, [model, loaded, mappings]);
  const open = (e: Mapping['source']) => (e.ref.kind === 'term' ? st().select([e.ref.id]) : st().selectProp(e.ref.id));
  const lookup = (iri: string) => {
    for (const ext of Object.values(loaded)) {
      const t = ext.terms.find((x) => x.iri === iri);
      if (t) return { name: t.name, type: t.type };
      const p = ext.props.find((x) => x.iri === iri);
      if (p) return { name: p.name, type: 'object' as const };
    }
    return undefined;
  };
  const importFile = async (f: File) => {
    try {
      const got = importMappings(st().model, await f.text(), lookup);
      if (got.added) placed(() => st().apply(() => got.model));
      st().notify(`${f.name}: ${got.added} mapping${got.added === 1 ? '' : 's'} added${got.duplicates ? `, ${got.duplicates} already there` : ''}${got.refused.length ? `, ${got.refused.length} left out (${got.refused[0]})` : ''}.`);
    } catch (e) {
      st().notify(`Could not read ${f.name}: ${e instanceof Error ? e.message : 'not valid Turtle'}`);
    }
  };
  const showInGraph = (m: Mapping) => {
    const ids = [m.source, m.target].filter((e) => e.ref.kind === 'term').map((e) => e.ref.id);
    if (!ids.length) return st().notify('Object properties are not drawn as nodes; open one to see its mappings in the editor.');
    st().showFullGraph();
    st().setSubgraph({ roots: ids, depth: 1, direction: 'both', expanded: [], hidden: [] });
    st().visualizeSubgraph();
  };
  const changePredicate = (m: Mapping, next: string) => {
    // A different relationship is a different axiom: the old one is withdrawn and the new one stated, as one step.
    const problem = st().edit((model_) => addMapping(removeMapping(model_, m), m.source.ref, next, m.target.ref, { ...m.meta, now: m.meta?.created }));
    setError(problem);
  };
  const meta = (m: Mapping, patch: Partial<Pick<MappingMeta, 'status' | 'comment' | 'author'>>) => st().apply((x) => setMappingMeta(x, m, patch));
  const owl = check.summary;
  const end = (e: Mapping['source']) => (
    <td className="ro">
      <button className="link" title={`${e.iri}\nOpen it`} onClick={() => open(e)}>
        {short(e.iri)}
      </button>
      {e.external !== undefined && <span className="tag auto">{model.externals.find((x) => x.id === e.external)?.name ?? 'external'}</span>}
    </td>
  );
  return (
    <div className="mappings">
      <div className="row wrap">
        <label>
          <span className="muted">Relationship </span>
          <select aria-label="Filter by relationship" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All ({mappings.length})</option>
            {used.map((p) => (
              <option key={p} value={p}>
                {p} ({mappings.filter((m) => m.predicate === p).length})
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button className="btn small" onClick={() => (st().setGraphScope('alignment'), st().showFullGraph(), st().setView('graph'))} disabled={!mappings.length} title="The canvas with only the mappings and the entities they connect">
          Show all in the graph
        </button>
        <button className="btn small" onClick={() => fileRef.current?.click()}>
          Import mappings…
        </button>
        <label className="check" title="Adds method, status, date, similarity and comment to the export, as annotations on each mapping axiom">
          <input type="checkbox" checked={withMeta} onChange={(e) => setWithMeta(e.target.checked)} />
          <span>with metadata</span>
        </label>
        <button className="btn small" disabled={!mappings.length} onClick={() => download(`${model.name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase() || 'model'}-mappings.ttl`, mappingsToTurtle(model, { metadata: withMeta }, mappings), 'text/turtle')}>
          Export mappings
        </button>
      </div>
      <div className={'check-result ' + (owl.status === 'inconsistent' ? 'is-bad' : owl.unsatisfiable.length || check.issues.some((i) => i.severity === 'warning') ? 'is-warn' : 'is-good')} role="status" aria-label="Consistency of the mappings">
        <strong>
          {model.mode === 'skos'
            ? 'SKOS mappings assert no logic, so there is nothing for the reasoner to check.'
            : owl.status === 'inconsistent'
              ? `Inconsistent: with these mappings the ontology contradicts itself (${owl.contradictions} contradiction${owl.contradictions === 1 ? '' : 's'}).`
              : owl.unsatisfiable.length
                ? `No contradiction found, but ${owl.unsatisfiable.length} class${owl.unsatisfiable.length === 1 ? '' : 'es'} can never have a member.`
                : 'No contradiction found by the fast reasoner.'}
        </strong>{' '}
        <span className="muted">
          This is the app’s own rule reasoner, which does not prove consistency; the OWL 2 DL reasoner under Validation does. Reasoned over your ontology{model.externals.some((e) => e.imports) ? ` together with the ${model.externals.filter((e) => e.imports).length} it imports` : '; ontologies in the library that are not dependencies are not part of it'}.
          {check.missing.length > 0 && ` Not included, because the content is not in this browser: ${check.missing.map((e) => e.name).join(', ')}.`}
        </span>
        <ul>
          {check.findings.filter((f) => f.severity === 'error').slice(0, 20).map((f) => (
            <li key={f.id} className="bad">
              <button className="link" onClick={() => f.entity?.kind === 'term' && model.terms.some((t) => t.id === f.entity!.id) && st().select([f.entity.id])}>
                {f.rule}
              </button>
              : {f.message} <span className="muted">{f.explanation}</span>
            </li>
          ))}
          {check.issues.map((i) => (
            <li key={i.message} className={i.severity === 'warning' ? 'warn-text' : 'muted'}>
              {i.message}
            </li>
          ))}
        </ul>
      </div>
      {error && (
        <p className="bad" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: '17%' }}>Source</th>
              <th style={{ width: 200 }}>Relationship</th>
              <th style={{ width: '17%' }}>Target</th>
              <th style={{ width: 110 }}>Method</th>
              <th style={{ width: 130 }}>Status</th>
              <th>Comment</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.key}>
                {end(m.source)}
                <td>
                  <select aria-label={`Relationship of ${m.source.name} to ${m.target.name}`} value={m.predicate} onChange={(e) => changePredicate(m, e.target.value)}>
                    {MAPPING_PREDICATES.filter((p) => p.kinds.includes(m.source.kind) && (model.mode !== 'skos' || p.group === 'SKOS')).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </select>
                </td>
                {end(m.target)}
                <td className="ro">
                  {m.meta?.method ?? 'manual'}
                  {m.meta?.score !== undefined && <span className="muted" title="The similarity the suggestion had. A heuristic, not a probability."> {m.meta.score.toFixed(2)}</span>}
                </td>
                <td>
                  <select aria-label={`Status of ${m.source.name} to ${m.target.name}`} value={m.meta?.status ?? 'proposed'} onChange={(e) => meta(m, { status: e.target.value as MappingMeta['status'] })}>
                    {MAPPING_STATUS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <CommitInput aria-label={`Comment on ${m.source.name} to ${m.target.name}`} value={m.meta?.comment ?? ''} placeholder="why this mapping holds" onCommit={(comment) => meta(m, { comment: comment.trim() })} />
                </td>
                <td className="row-actions">
                  <button className="btn small ghost" title="The two entities and what is around them, on the canvas" onClick={() => showInGraph(m)}>
                    Graph
                  </button>
                  <button className="btn icon ghost" title="Remove this mapping. The entities stay." aria-label={`Remove mapping ${m.source.name} ${m.predicate} ${m.target.name}`} onClick={() => st().apply((x) => removeMapping(x, m))}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="muted pad">{mappings.length ? 'No mapping with that relationship.' : 'No mappings yet. Make one under Align, accept a suggestion, or import a mappings file.'}</p>}
      </div>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".ttl,.nt,.n3,.turtle,text/turtle"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
    </div>
  );
}

let kept: { doc: number; found: { for: string; list: Suggestion[] } } | undefined;

function Suggestions({ model, loaded, current, mappings }: Common & { current?: ExternalRef }) {
  const st = useStore.getState;
  const ext = current ? loaded[current.id] : undefined;
  // Candidates stay as found while the user looks elsewhere (at an entity, at the RDF) and comes back.
  const docSeq = useStore((x) => x.docSeq);
  const [found, setFoundState] = useState<{ for: string; list: Suggestion[] } | null>(kept?.doc === docSeq ? kept.found : null);
  const setFound = (f: { for: string; list: Suggestion[] }) => {
    kept = { doc: docSeq, found: f };
    setFoundState(f);
  };
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ key: string; text: string }>();
  const mapped = useMemo(() => new Set(mappings.flatMap((m) => [`${m.source.iri}|${m.target.iri}`, `${m.target.iri}|${m.source.iri}`])), [mappings]);
  const rejected = useMemo(() => new Set(model.rejected), [model.rejected]);
  if (!current) return <p className="muted pad">Add an ontology to the library first.</p>;
  const list = found?.for === current.id ? found.list.filter((s) => !mapped.has(s.key) && !rejected.has(s.key)) : null;
  const accept = (s: Suggestion) => {
    if (!ext) return;
    const reused = reuseEntity(st().model, current, ext, s.external.prop ? { prop: s.external.id } : { term: s.external.id });
    const problem = placed(() => st().edit(() => addMapping(reused.model, { kind: s.local.prop ? 'prop' : 'term', id: s.local.id }, choice[s.key] ?? '', reused.entity, { method: 'suggested', score: s.score })));
    setError(problem ? { key: s.key, text: problem } : undefined);
  };
  return (
    <div className="suggestions">
      <div className="row wrap">
        <span className="muted">Candidates between your ontology and</span>
        <OntologyPicker model={model} current={current} />
        <button className="btn primary" disabled={!ext} onClick={() => ext && setFound({ for: current.id, list: suggestMappings(st().model, ext, { mapped }) })}>
          Find candidates
        </button>
        {model.rejected.length > 0 && (
          <button className="link" onClick={() => st().apply((m) => ({ ...m, rejected: [] }))}>
            Bring back the {model.rejected.length} rejected
          </button>
        )}
      </div>
      <p className="muted">
        Look-alikes found by comparing labels, alternative labels, IRI names, definitions and position in the hierarchy. The score says how alike two descriptions are; it is not a probability that the entities are the same. Nothing is asserted until you choose a relationship and accept, and there is no default relationship.
      </p>
      {!ext && <p className="muted">The content of “{current.name}” is not available in this browser.</p>}
      {list && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: '16%' }}>Your entity</th>
                <th style={{ width: '16%' }}>External entity</th>
                <th style={{ width: 90 }} className="num">Similarity</th>
                <th>Why</th>
                <th style={{ width: 210 }}>Relationship</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.key}>
                  <td className="ro" title={s.local.iri}>
                    {s.local.name} <span className="muted">{s.local.kind}</span>
                  </td>
                  <td className="ro" title={s.external.iri}>
                    {s.external.name} <span className="muted">{ext && (compactIri(ext, s.external.iri) ?? '')}</span>
                  </td>
                  <td className="num">{s.score.toFixed(2)}</td>
                  <td className="ro why">
                    {s.features.map((f) => f.label).join('; ')}
                    {error?.key === s.key && (
                      <span className="bad" role="alert">
                        {' '}
                        {error.text}
                      </span>
                    )}
                  </td>
                  <td>
                    <select aria-label={`Relationship for ${s.local.name} and ${s.external.name}`} value={choice[s.key] ?? ''} onChange={(e) => setChoice({ ...choice, [s.key]: e.target.value })}>
                      <option value="">choose…</option>
                      {MAPPING_PREDICATES.filter((p) => p.kinds.includes(s.local.kind) && (model.mode !== 'skos' || p.group === 'SKOS')).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="row-actions">
                    <button className="btn small primary" disabled={!choice[s.key]} title={choice[s.key] ? undefined : 'Choose the relationship first'} onClick={() => accept(s)}>
                      Accept
                    </button>
                    <button className="btn small ghost" title="Not a match: do not suggest this pair again" onClick={() => st().apply((m) => ({ ...m, rejected: [...m.rejected, s.key] }))}>
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <p className="muted pad">No candidates above the threshold that are not already mapped or rejected.</p>}
        </div>
      )}
    </div>
  );
}

