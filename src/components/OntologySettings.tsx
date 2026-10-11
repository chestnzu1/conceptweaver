import { useMemo, useState } from 'react';
import { baseIriOf } from '../model/iri';
import { ontologyIriOf, STANDARD, validateSettings } from '../model/prefixes';
import { useStore } from '../model/store';
import type { Prefix } from '../model/types';

/**
 * The ontology's identity and namespaces: its own IRI, the default namespace new entities are
 * made in, and the prefixes IRIs are abbreviated with. None of this rewrites an existing IRI.
 */
export function OntologySettings() {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const [ontologyIri, setOntologyIri] = useState(model.ontologyIri);
  const [baseIri, setBaseIri] = useState(model.baseIri);
  // Normally terms are named in the ontology's own namespace: the ontology IRI plus # (or /).
  // Only when this is ticked is the namespace a separate setting.
  const follows = (base: string, ont: string) => !ont.trim() || base.trim() === ont.trim() + '#' || base.trim() === ont.trim() + '/';
  const [separate, setSeparate] = useState(!follows(model.baseIri, model.ontologyIri));
  const sepOf = (base: string) => (base.trim().endsWith('/') ? '/' : '#');
  const [prefixes, setPrefixes] = useState<Prefix[]>(model.prefixes.map((p) => ({ ...p })));
  // Namespaces whose entities should not, or should, be moved into the default namespace on saving.
  // The one that was the default follows a change unless unticked; any other moves only if ticked.
  const [stay, setStay] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);
  const check = useMemo(() => validateSettings({ ontologyIri, baseIri, prefixes }), [ontologyIri, baseIri, prefixes]);
  const close = () => st().setDialog(null);
  // What applies when a field is left empty, shown as the placeholder.
  const effective = { ...model, baseIri: baseIri.trim(), ontologyIri: '' };
  const setRow = (i: number, patch: Partial<Prefix>) => setPrefixes(prefixes.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const entities = [...model.terms, ...model.props];
  const newBase = baseIriOf({ ...model, baseIri: baseIri.trim() });
  const oldBase = baseIriOf(model);
  const baseChanged = newBase !== oldBase && !check.baseIri;
  // Where the entities are now: each namespace in use, with how many entities it holds.
  const usage = useMemo(() => {
    const count = new Map<string, number>();
    for (const e of entities) {
      if (!e.iri) continue;
      const ns = e.iri.slice(0, Math.max(e.iri.lastIndexOf('#'), e.iri.lastIndexOf('/')) + 1);
      count.set(ns, (count.get(ns) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.terms, model.props]);
  const inNew = usage.find(([ns]) => ns === newBase)?.[1] ?? 0;
  const others = usage.filter(([ns]) => ns !== newBase);
  const moves = (ns: string) => (ns === oldBase && baseChanged ? !stay : extra.includes(ns));
  const toggle = (ns: string, on: boolean) => (ns === oldBase && baseChanged ? setStay(!on) : setExtra(on ? [...extra, ns] : extra.filter((x) => x !== ns)));
  const moving = others.filter(([ns]) => moves(ns));
  const movingCount = moving.reduce((n, [, c]) => n + c, 0);
  // The default namespace usually is the ontology IRI plus # or /. While it is, it follows the
  // ontology IRI as that is typed, so that changing one does not leave the other behind.
  const changeOntologyIri = (value: string) => {
    setOntologyIri(value);
    if (!separate && value.trim()) setBaseIri(value.trim() + sepOf(baseIri));
  };
  const changeSeparate = (on: boolean) => {
    setSeparate(on);
    // Back to one setting: the namespace becomes the ontology IRI plus #.
    if (!on && ontologyIri.trim()) setBaseIri(ontologyIri.trim() + sepOf(baseIri));
  };
  const save = () => {
    if (!check.ok) return;
    st().setOntologySettings({ ontologyIri: ontologyIri.trim(), baseIri: baseIri.trim(), prefixes: prefixes.map((p) => ({ prefix: p.prefix.trim(), iri: p.iri.trim() })) }, moving.map(([ns]) => ns));
    st().notify(movingCount ? `Ontology settings saved. ${movingCount} ${movingCount === 1 ? 'entity was' : 'entities were'} moved to ${newBase}` : 'Ontology settings saved.');
    close();
  };

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="settings-title">Ontology settings</h2>

        <label className="field">
          <span>Ontology IRI</span>
          <input autoFocus value={ontologyIri} placeholder={ontologyIriOf(effective)} aria-invalid={!!check.ontologyIri} spellCheck={false} onChange={(e) => changeOntologyIri(e.target.value)} />
          {check.ontologyIri ? (
            <small className="bad">{check.ontologyIri}</small>
          ) : (
            <small>
              Identifies the ontology as a whole.{' '}
              {separate ? 'New terms are named in the separate namespace below, not here.' : ontologyIri.trim() ? 'New terms are named in it: the namespace below follows what you type here.' : 'Left empty, it is the default namespace without its final # or /.'}
            </small>
          )}
        </label>

        <label className="field">
          <span>Default namespace</span>
          <input
            value={baseIri}
            placeholder={baseIriOf({ ...model, baseIri: '' })}
            aria-invalid={!!check.baseIri}
            spellCheck={false}
            // While it follows the ontology IRI it is shown, not typed.
            readOnly={!separate && !!ontologyIri.trim()}
            className={!separate && ontologyIri.trim() ? 'follows' : ''}
            onChange={(e) => setBaseIri(e.target.value)}
          />
          {check.baseIri ? (
            <small className="bad">{check.baseIri}</small>
          ) : (
            <small>
              New entities get their IRI here: a class named Actor becomes <code>{newBase + 'Actor'}</code>.
              {entities.length > 0 && ` ${inNew} of the ${entities.filter((e) => e.iri).length} existing entities ${inNew === 1 ? 'is' : 'are'} in it.`}
            </small>
          )}
        </label>

        <label className="check">
          <input type="checkbox" checked={separate} onChange={(e) => changeSeparate(e.target.checked)} />
          <span>Use a namespace for terms that is different from the ontology IRI</span>
        </label>

        {others.length > 0 && (
          <div className="move-box">
            <strong>Entities in other namespaces</strong>
            <small>
              An entity keeps the IRI it was given. Tick a namespace to move its entities into the default namespace when you save: their IRIs change to{' '}
              <code>{newBase}…</code> with the same last part. Do this while the ontology is still yours alone; once others refer to these IRIs, changing them breaks those references.
            </small>
            {others.map(([ns, n]) => (
              <label key={ns} className="check">
                <input type="checkbox" checked={moves(ns)} onChange={(e) => toggle(ns, e.target.checked)} />
                <span>
                  Move {n} {n === 1 ? 'entity' : 'entities'} from <code>{ns}</code>
                  {ns === oldBase && baseChanged && <span className="muted"> (the default namespace until now)</span>}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="field">
          <span>Prefixes</span>
          <table className="prefixes">
            <thead>
              <tr>
                <th style={{ width: 120 }}>Prefix</th>
                <th>Namespace</th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              <tr className="fixed">
                <td>
                  <code>:</code> <span className="muted">default</span>
                </td>
                <td colSpan={2}>
                  <code>{baseIri.trim() || baseIriOf({ ...model, baseIri: '' })}</code>
                </td>
              </tr>
              {prefixes.map((p, i) => (
                <tr key={i}>
                  <td>
                    <input value={p.prefix} placeholder="ex" aria-label="Prefix" aria-invalid={!!check.rows[i]} spellCheck={false} onChange={(e) => setRow(i, { prefix: e.target.value })} />
                  </td>
                  <td>
                    <input value={p.iri} placeholder="http://example.org/other#" aria-label="Namespace" aria-invalid={!!check.rows[i]} spellCheck={false} onChange={(e) => setRow(i, { iri: e.target.value })} />
                    {check.rows[i] && <small className="bad">{check.rows[i]}</small>}
                  </td>
                  <td>
                    <button className="btn icon ghost" title="Remove this prefix" aria-label={`Remove prefix ${p.prefix}`} onClick={() => setPrefixes(prefixes.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              {STANDARD.map((p) => (
                <tr key={p.prefix} className="fixed">
                  <td>
                    <code>{p.prefix}:</code> <span className="muted">standard</span>
                  </td>
                  <td colSpan={2}>
                    <code>{p.iri}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn small" onClick={() => setPrefixes([...prefixes, { prefix: '', iri: '' }])}>
            Add prefix
          </button>
          <small>A prefix only changes how an IRI is written (ex:Actor); adding, renaming or removing one never changes an IRI.</small>
        </div>

        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!check.ok} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
