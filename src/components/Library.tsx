import { useEffect, useState } from 'react';
import { deleteModel, duplicateModel, listModels, renameModel, type SavedInfo } from '../model/library';
import { confirmDiscard, isDirty, useStore } from '../model/store';

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** My Models: the ontology models saved in this browser, to open, rename, duplicate or delete. */
export function LibraryDialog() {
  const doc = useStore((s) => s.doc);
  const dirty = useStore(isDirty);
  const name = useStore((s) => s.model.name);
  const autosave = useStore((s) => s.libraryAutosave);
  const st = useStore.getState;
  const [models, setModels] = useState<SavedInfo[] | null>(null);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const close = () => st().setDialog(null);
  const refresh = () =>
    listModels().then(setModels, (e: unknown) => {
      setModels([]);
      setError(e instanceof Error ? e.message : 'The saved models could not be read.');
    });
  // Loaded when the dialog opens, and again whenever the open model is saved.
  useEffect(() => {
    void refresh();
  }, [doc]);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    }
    await refresh();
  };

  const open = async (m: SavedInfo) => {
    if (m.id === doc.id && !dirty) return close();
    if (!confirmDiscard()) return;
    if (await st().openFromLibrary(m.id)) close();
  };
  const rename = () => {
    if (!renaming) return;
    const { id, name: next } = renaming;
    setRenaming(null);
    if (!next.trim()) return;
    void run(async () => {
      const info = await renameModel(id, next);
      if (info) st().syncDoc({ renamed: { id, name: info.name } });
    });
  };
  const remove = (m: SavedInfo) => {
    if (!window.confirm(`Delete “${m.name}” from My Models?\n\nThis cannot be undone. If you may need it again, export it to a file first.`)) return;
    void run(async () => {
      await deleteModel(m.id);
      st().syncDoc({ deleted: m.id });
    });
  };

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog library" role="dialog" aria-modal="true" aria-labelledby="library-title" onKeyDown={(e) => e.key === 'Escape' && !renaming && close()}>
        <h2 id="library-title">My Models</h2>
        <p className="muted">
          Models saved in this browser. They stay here between sessions, but only in this browser on this computer, and are removed if the browser's site data is cleared. Keep a
          file of anything important: File → Download as JSON, or an OWL/SKOS export.
        </p>

        <div className="library-current">
          <span>
            In the editor: <strong>{name}</strong> <span className={'save-state ' + (doc.id ? (dirty ? 'dirty' : 'saved') : 'none')}>{doc.id ? (dirty ? 'Unsaved changes' : 'Saved') : 'Not in My Models'}</span>
          </span>
          <span className="spacer" />
          <button className="btn small primary" disabled={!!doc.id && !dirty} onClick={() => void st().saveToLibrary()}>
            Save
          </button>
          <button className="btn small" onClick={() => st().setDialog('saveas')}>
            Save as…
          </button>
        </div>

        {error && (
          <p className="bad" role="alert">
            {error}
          </p>
        )}

        <div className="library-list">
          {models === null ? (
            <p className="muted pad">Loading…</p>
          ) : models.length === 0 ? (
            <p className="muted pad">Nothing saved yet. Press Save to keep the model in the editor here.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '30%' }}>Ontology IRI</th>
                  <th style={{ width: 150 }}>Last modified</th>
                  <th style={{ width: 70 }} className="num">
                    Entities
                  </th>
                  <th style={{ width: 310 }} />
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id} className={m.id === doc.id ? 'sel' : ''}>
                    <td>
                      {renaming?.id === m.id ? (
                        <input
                          autoFocus
                          aria-label={`New name for ${m.name}`}
                          value={renaming.name}
                          onChange={(e) => setRenaming({ id: m.id, name: e.target.value })}
                          onBlur={rename}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') rename();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                        />
                      ) : (
                        <>
                          {m.name}
                          {m.id === doc.id && <span className="tag">open</span>}
                        </>
                      )}
                    </td>
                    <td className="iri" title={m.ontologyIri}>
                      {m.ontologyIri}
                    </td>
                    <td title={`Created ${when(m.created)}`}>{when(m.modified)}</td>
                    <td className="num">{m.entities}</td>
                    <td className="row-actions">
                      <button className="btn small" onClick={() => void open(m)}>
                        Open
                      </button>
                      <button className="btn small ghost" onClick={() => setRenaming({ id: m.id, name: m.name })}>
                        Rename
                      </button>
                      <button className="btn small ghost" onClick={() => void run(() => duplicateModel(m.id))}>
                        Duplicate
                      </button>
                      <button className="btn small ghost danger" aria-label={`Delete ${m.name}`} onClick={() => remove(m)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="dialog-actions">
          <label className="check" title="Applies to a model that is already in My Models: each change is saved there a moment later.">
            <input type="checkbox" checked={autosave} onChange={(e) => st().setLibraryAutosave(e.target.checked)} />
            <span>Save changes to an opened model automatically</span>
          </label>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Asks for the name under which to save the model as a new entry in My Models. */
export function SaveAsDialog() {
  const model = useStore((s) => s.model);
  const doc = useStore((s) => s.doc);
  const st = useStore.getState;
  // A copy of a model that is already saved gets a name of its own to start from.
  const [name, setName] = useState(doc.id ? `${model.name} copy` : model.name);
  const close = () => st().setDialog(null);
  const save = async () => {
    if (!name.trim()) return;
    if (await st().saveToLibrary({ name, asNew: true })) close();
  };
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog saveas" role="dialog" aria-modal="true" aria-labelledby="saveas-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="saveas-title">{doc.id ? 'Save as a new model' : 'Save to My Models'}</h2>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} aria-label="Model name" onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} onKeyDown={(e) => e.key === 'Enter' && void save()} />
          <small>
            {doc.id
              ? 'A separate copy is made under this name and becomes the model in the editor. The model it was copied from stays as it was last saved.'
              : 'The model is kept in this browser and can be reopened from My Models. Export a file as well for anything you cannot afford to lose.'}
          </small>
        </label>
        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
