import { drawnWhole } from '../model/culling';
import { useCallback, useEffect, useRef, useState } from 'react';
import { exportModel, readModelFile } from '../model/files';
import { fileText, FORMAT_LABEL, MODEL_FILES } from '../model/rdfFormats';
import { sampleModel, skosSample } from '../model/sample';
import { universitySample } from '../model/sampleUniversity';
import { stressModel } from '../model/stress';
import { stable } from '../model/stable';
import { configOf, supports, VIEW_LABEL, viewFor } from '../model/modelTypes';
import { confirmDiscard, isDirty, layoutOf, problemCount, useStore } from '../model/store';
import { LAYOUT_KINDS, LAYOUTS } from '../layout/types';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';
import { CommitInput } from './fields';
import { Icon } from './Icon';

/**
 * Puts a document in the editor as the model: the app's own JSON, or an ontology in any syntax
 * that is read. `source` says where it is from when that is not a file.
 */
export async function openDocument(text: string, name: string, source: { contentType?: string; url?: string } = {}): Promise<string | undefined> {
  const st = useStore.getState();
  try {
    const { model, format, kept } = await readModelFile(text, name, { ...source, serviceUrl: st.validation.reasonerUrl });
    st.replaceModel(model);
    // On the canvas, unless it is too large to draw whole: then it opens on the Structure Explorer.
    if (drawnWhole(model)) st.setView('graph');
    const opened = `Opened “${model.name}”${format === 'model' ? '' : ` from ${FORMAT_LABEL[format]}`}: ${model.terms.length.toLocaleString('en')} terms, ${model.relations.length.toLocaleString('en')} relations.`;
    st.notify(opened);
    // What the model has no place for is kept as it was and written back, and that is said: it is there, but not to be edited here.
    if (kept.length) {
      const one = kept.length === 1 && /^1 /.test(kept[0]);
      st.showMessage('Opened, with statements kept that cannot be edited here', `${opened} The file also has ${kept.join(', ').replace(/, ([^,]*)$/, ' and $1')}, which the editor has no place for. ${one ? 'It is' : 'They are'} kept as ${one ? 'it was' : 'they were'} and written back whenever the ontology is saved or exported, but ${one ? 'it is' : 'they are'} not shown or edited here. The OWL 2 DL reasoner takes ${one ? 'it' : 'them'} into account; the app's own reasoner does not.`);
    }
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function openFile(file: File) {
  const st = useStore.getState();
  // A large ontology in a syntax that needs the RDF engine takes a moment: say that it is being read.
  if (file.size > 300_000) st.notify(`Reading ${file.name}…`);
  const problem = await openDocument(await fileText(file), file.name);
  if (problem !== undefined) st.showMessage('The file could not be opened', `“${file.name}” was not opened, and the model in the editor is as it was. ${problem}`);
}

export function Header() {
  const model = useStore((s) => s.model);
  const layout = useStore(layoutOf);
  // The view in force: the one asked for, where the type of model has it.
  const view = viewFor(model, useStore((s) => s.view));
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.theme);
  const docId = useStore((s) => s.doc.id);
  const dirty = useStore(isDirty);
  const st = useStore.getState;
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Moving terms around doesn't change what the checks find.
  const meaning = stable(model);
  // The count comes from checks that run by themselves away from the page, asked for a moment after
  // an edit, so that checking a large model never holds up the edit itself. Until they have
  // answered about the model as it is, the last count stays.
  const revision = useStore((s) => s.version.revision);
  const checked = useStore((s) => s.validation.checks.problems?.report);
  const validated = supports(meaning, 'validation');
  const problems = validated ? problemCount(checked) : 0;
  useEffect(() => {
    // Nothing is checked for a type of model that has no validation.
    if (!validated) return;
    const id = setTimeout(() => useStore.getState().requestChecks('problems'), meaning.terms.length > 300 ? 400 : 0);
    return () => clearTimeout(id);
  }, [revision, validated, meaning.terms.length]);

  const dropdown = (e: React.MouseEvent, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  const fileMenu: MenuItem[] = [
    { label: 'New model…', onClick: () => confirmDiscard() && st().setDialog('new'), hint: 'choose its type' },
    { label: 'Open a file…', onClick: () => confirmDiscard() && fileRef.current?.click(), hint: 'OWL, RDF, JSON' },
    { label: 'Open from a URL…', onClick: () => st().setDialog('openurl'), hint: 'an ontology on the web' },
    { label: 'My Models…', onClick: () => st().setDialog('library'), hint: 'saved in this browser' },
    { label: 'Ontology settings…', onClick: () => st().setDialog('settings'), hint: 'IRI, prefixes' },
    { label: 'Load the SKOS example', onClick: () => confirmDiscard() && st().replaceModel(skosSample()) },
    { label: 'Load the ontology example', onClick: () => confirmDiscard() && st().replaceModel(sampleModel()) },
    { label: 'Load the large ontology example', onClick: () => confirmDiscard() && st().replaceModel(universitySample()), hint: '130 terms' },
    { label: 'Generate a stress-test model', onClick: () => confirmDiscard() && st().replaceModel(stressModel()), hint: '960 terms' },
    'sep',
    { label: 'Save', onClick: () => void st().saveToLibrary(), hint: 'Ctrl+S' },
    { label: 'Save as…', onClick: () => st().setDialog('saveas') },
    { heading: 'Files' },
    { label: 'Download as JSON', onClick: () => exportModel('json') },
    { heading: 'Export' },
    { label: 'Interactive page (HTML)', onClick: () => exportModel('html'), hint: 'opens anywhere' },
    { label: 'SKOS (Turtle)', onClick: () => exportModel('skos'), hint: model.mode === 'skos' ? '' : 'converted' },
    { label: 'OWL (Turtle)', onClick: () => exportModel('owl'), hint: model.mode === 'ontology' ? '' : 'converted' },
    // Asserted axioms only is what an export is. This one adds, after them and marked as such, what the reasoner entails.
    ...(supports(model, 'reasoning') ? [{ label: 'OWL with inferred assertions (Turtle)', onClick: () => void exportModel('owl-inferred'), hint: 'materialized' }] : []),
    { label: 'JSON-LD', onClick: () => exportModel('jsonld') },
    { label: 'Terms as CSV', onClick: () => exportModel('csv-terms') },
    { label: 'Relations as CSV', onClick: () => exportModel('csv-relations') },
    { label: 'Image (SVG)', onClick: () => exportModel('svg') },
    { label: 'Image (PNG)', onClick: () => exportModel('png') },
  ];
  // The same layouts as the selector above the graph has; the one in use is ticked.
  const arrangeMenu: MenuItem[] = [
    ...LAYOUT_KINDS.map((k) => ({ label: LAYOUTS[k].label, checked: layout.kind === k, onClick: () => st().arrange(k) })),
    'sep',
    { label: 'Rearrange', onClick: () => st().rearrange(), disabled: layout.kind === 'manual' },
  ];

  return (
    <header className="header">
      <div className="header-doc">
        <div className="brand" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="22" height="22">
            <rect width="32" height="32" rx="7" fill="var(--accent)" />
            <circle cx="10" cy="11" r="4" fill="var(--on-accent)" />
            <circle cx="22" cy="21" r="4" fill="var(--on-accent)" />
            <path d="M13 13.5l6 5" stroke="var(--on-accent)" strokeWidth="2" />
          </svg>
        </div>
        <CommitInput
          className="model-name"
          aria-label="Model name"
          value={model.name}
          onCommit={(name) => st().apply((m) => ({ ...m, name: name.trim() || 'Untitled model' }))}
        />
        <span className={'save-state ' + (docId ? (dirty ? 'dirty' : 'saved') : 'none')} role="status" title={docId ? (dirty ? 'This model has changes that are not saved to My Models yet' : 'Everything is saved to My Models in this browser') : 'This model is not saved to My Models. It is kept as a working copy in this browser until you replace it.'}>
          {docId ? (dirty ? 'Unsaved changes' : 'Saved') : 'Not in My Models'}
        </span>
        <button className="btn" title="Save to My Models in this browser (Ctrl+S)" disabled={!!docId && !dirty} onClick={() => void st().saveToLibrary()}>
          Save
        </button>
        <button className="btn" onClick={() => st().setDialog('library')}>
          My Models
        </button>
        <button className="btn" aria-haspopup="menu" onClick={(e) => dropdown(e, fileMenu)}>
          File <Icon name="chevronDown" size={14} />
        </button>
      </div>

      <nav className="tabs" role="tablist" aria-label="View">
        {/* The functions the type of model has, and no others. */}
        {configOf(model).views.map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => st().setView(v)}>
            {VIEW_LABEL[v]}
            {v === 'checks' && problems > 0 && <span className="badge">{problems}</span>}
          </button>
        ))}
      </nav>

      <div className="header-tools">
        <button className="btn icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={() => st().undo()}>
          <Icon name="undo" />
        </button>
        <button className="btn icon" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!canRedo} onClick={() => st().redo()}>
          <Icon name="redo" />
        </button>
        <button className="btn" aria-haspopup="menu" onClick={(e) => dropdown(e, arrangeMenu)}>
          Arrange <Icon name="chevronDown" size={14} />
        </button>
        <button className="btn" onClick={() => st().setDialog('bulk')}>
          Bulk add
        </button>
        <button
          className="btn icon"
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
          onClick={() => st().setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        hidden
        accept={MODEL_FILES}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void openFile(f);
        }}
      />
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </header>
  );
}
