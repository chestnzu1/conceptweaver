import { useRef, useState } from 'react';
import { LogicalError, type LogicalModel } from '../logical/contracts';
import { exportLogicalModel } from '../logical/exchange';
import { countsOf } from '../logical/rules';
import { download } from '../model/files';
import { useStore } from '../model/store';
import { CommitInput } from './fields';

/**
 * The project's logical data models (roadmap LM-1, FR-M17-1, FR-M17-15): made, renamed,
 * duplicated, exported, imported and deleted, each one step of the history and kept with the
 * project and its versions. What is in them is edited in the LDM workspace (LM-2); this is where
 * they are kept.
 */

const said = (e: unknown) => (e instanceof LogicalError || e instanceof Error ? e.message : String(e));
const fileName = (name: string) => `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'logical-model'}.ldm.json`;

export function LogicalModelsDialog() {
  const models = useStore((s) => s.model.logicalModels);
  const st = useStore.getState;
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const close = () => st().setDialog(null);
  const run = async (what: () => Promise<unknown>, done?: string) => {
    setError('');
    try {
      await what();
      if (done) st().notify(done);
    } catch (e) {
      setError(said(e));
    }
  };
  const create = () =>
    run(async () => {
      await st().logicalEdit.create({ name, purpose });
      setName('');
      setPurpose('');
    }, `The logical model “${name.trim()}” was made. Undo takes it back.`);
  const change = (m: LogicalModel, field: 'name' | 'purpose', value: string) =>
    value.trim() === m[field]
      ? undefined
      : run(() => st().logicalEdit.apply({ model: m.id, baseRevision: m.revision, changes: [{ op: 'update', target: { model: true }, before: { [field]: m[field] }, after: { [field]: value.trim() } }], summary: `${field === 'name' ? 'Renamed' : 'Changed the purpose of'} the logical model “${m.name}”` }));

  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog logical-models" role="dialog" aria-modal="true" aria-labelledby="logical-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="logical-title">Logical data models</h2>
        <p className="muted">
          How applications organise this project’s data: entities, attributes, relationships and keys, apart from the ontology and never written into it. Each is kept with the project and in its versions, and every change is undone like any other. Their entities are edited in the LDM workspace.
        </p>
        <div className="logical-new">
          <label className="field">
            <span>Name</span>
            <input aria-label="Name of the new logical model" value={name} placeholder="Film catalogue" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
          </label>
          <label className="field grow">
            <span>What it is for</span>
            <input aria-label="What the new logical model is for" value={purpose} placeholder="The catalogue application" onChange={(e) => setPurpose(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
          </label>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
            Make a logical model
          </button>
        </div>
        {error && (
          <p className="bad" role="alert">
            {error}
          </p>
        )}
        <div className="logical-list" aria-label="Logical models">
          {!models.length && <p className="muted">No logical models yet.</p>}
          {models.map((m) => {
            const c = countsOf(m);
            return (
              <div key={m.id} className="logical-row" data-ldm={m.id}>
                <div className="what">
                  <CommitInput aria-label={`Name of the logical model ${m.name}`} value={m.name} spellCheck={false} onCommit={(v) => void change(m, 'name', v)} />
                  <CommitInput aria-label={`What ${m.name} is for`} value={m.purpose} placeholder="What it is for" onCommit={(v) => void change(m, 'purpose', v)} />
                  <span className="muted counts">
                    {c.entities} entit{c.entities === 1 ? 'y' : 'ies'}, {c.attributes} attribute{c.attributes === 1 ? '' : 's'}, {c.relationships} relationship{c.relationships === 1 ? '' : 's'}, {c.keys} key{c.keys === 1 ? '' : 's'}
                    {c.generalizations ? `, ${c.generalizations} generalization${c.generalizations === 1 ? '' : 's'}` : ''}
                    {c.rules ? `, ${c.rules} rule${c.rules === 1 ? '' : 's'}` : ''}
                    {c.domains ? `, ${c.domains} domain${c.domains === 1 ? '' : 's'}` : ''}
                  </span>
                </div>
                <button
                  className="btn small"
                  title="Read and edit the entities, relationships, domains and rules of this logical model"
                  onClick={() => {
                    st().setDialog(null);
                    st().openLogical(m.id);
                  }}
                >
                  Open
                </button>
                <button className="btn small" onClick={() => void run(() => st().logicalEdit.duplicate({ model: m.id }), `“${m.name}” was copied.`)}>
                  Duplicate
                </button>
                <button className="btn small" onClick={() => download(fileName(m.name), exportLogicalModel(m), 'application/json')}>
                  Export
                </button>
                <button
                  className="btn small danger"
                  onClick={() => window.confirm(`Delete the logical model “${m.name}”? Undo brings it back; the ontology is not touched.`) && void run(() => st().logicalEdit.remove({ model: m.id }), `“${m.name}” was deleted. Undo brings it back.`)}
                >
                  Delete…
                </button>
              </div>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => file.current?.click()}>
            Import a logical model…
          </button>
          <input
            ref={file}
            type="file"
            hidden
            accept=".json,application/json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const text = await f.text();
              void run(async () => {
                const made = await st().logicalEdit.import({ document: text });
                st().notify(`The logical model “${made.name}” was imported. Undo takes it back.`);
              });
            }}
          />
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
