import { useState } from 'react';
import { baseIriOf } from '../model/iri';
import { MODEL_TYPE_LIST } from '../model/modelTypes';
import { isAbsoluteIri } from '../model/prefixes';
import { createModel, useStore } from '../model/store';
import { emptyModel, type ModelMode } from '../model/types';

/**
 * A new model starts with a choice of what kind of model it is, because that decides everything
 * the app then offers for it. Nothing is chosen for the user: the type is not changed again
 * behind their back, so it is not picked behind their back either.
 */
export function NewModelDialog() {
  const st = useStore.getState;
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ModelMode | null>(null);
  const [ontologyIri, setOntologyIri] = useState('');
  const [baseIri, setBaseIri] = useState('');
  const close = () => st().setDialog(null);

  // What is left empty is made from the name, as it is for a model that was never asked.
  const auto = baseIriOf({ ...emptyModel(name.trim() || 'Untitled model') });
  const badIri = !!ontologyIri.trim() && !isAbsoluteIri(ontologyIri.trim());
  const base = baseIri.trim();
  const badBase = !!base && (!isAbsoluteIri(base) ? 'Not an IRI. It should look like http://example.org/vocabulary#' : !/[#/:]$/.test(base) ? 'A namespace ends with # or /, so that names can be added to it.' : '');
  const ready = !!mode && !badIri && !badBase;
  const create = () => {
    if (!ready || !mode) return;
    createModel({ name: name.trim() || 'Untitled model', mode, ontologyIri: ontologyIri.trim(), baseIri: base });
    close();
  };

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog new-model" role="dialog" aria-modal="true" aria-labelledby="new-model-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="new-model-title">Create new model</h2>
        <label className="field">
          <span>Model name</span>
          <input autoFocus value={name} placeholder="Untitled model" aria-label="Model name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </label>
        <fieldset className="field model-types">
          <legend>Model type</legend>
          {MODEL_TYPE_LIST.map((t) => (
            <label key={t.id} className={'model-type' + (mode === t.id ? ' on' : '')}>
              <input type="radio" name="model-type" value={t.id} checked={mode === t.id} onChange={() => setMode(t.id)} />
              <span>
                <strong>{t.label}</strong>
                <small>{t.about}</small>
              </span>
            </label>
          ))}
          {!mode && <small>Choose one. The type decides which functions the model has, and stays with it.</small>}
        </fieldset>
        <label className="field">
          <span>Base IRI</span>
          <input value={ontologyIri} aria-label="Base IRI" aria-invalid={badIri} placeholder={auto.replace(/[#/]$/, '')} onChange={(e) => setOntologyIri(e.target.value)} />
          <small className={badIri ? 'bad' : ''}>{badIri ? 'Not an IRI. It should look like http://example.org/vocabulary' : 'The IRI of the model itself. Empty: the default namespace without its last character.'}</small>
        </label>
        <label className="field">
          <span>Default namespace</span>
          <input value={baseIri} aria-label="Default namespace" aria-invalid={!!badBase} placeholder={auto} onChange={(e) => setBaseIri(e.target.value)} />
          <small className={badBase ? 'bad' : ''}>{badBase || 'New entities get their IRI in this namespace. Empty: made from the name.'}</small>
        </label>
        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready} onClick={create}>
            Create model
          </button>
        </div>
      </div>
    </div>
  );
}
