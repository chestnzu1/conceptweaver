import { useCallback, useEffect, useRef, useState } from 'react';
import { owlFindings, qualityFindings } from '../model/validation';
import { exportModel, parseModelFile } from '../model/files';
import { sampleModel, skosSample } from '../model/sample';
import { universitySample } from '../model/sampleUniversity';
import { stressModel } from '../model/stress';
import { stable } from '../model/stable';
import { confirmDiscard, isDirty, newModel, useStore, type View } from '../model/store';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';
import { CommitInput } from './fields';
import { Icon } from './Icon';

const VIEWS: { value: View; label: string }[] = [
  { value: 'graph', label: 'Graph' },
  { value: 'table', label: 'Entities' },
  { value: 'hierarchy', label: 'Hierarchy' },
  { value: 'checks', label: 'Validation' },
  { value: 'align', label: 'Align' },
  { value: 'rdf', label: 'RDF' },
  { value: 'sparql', label: 'SPARQL' },
  { value: 'vocab', label: 'Vocabulary' },
];

export async function openFile(file: File) {
  const st = useStore.getState();
  try {
    const model = parseModelFile(await file.text(), file.name);
    st.replaceModel(model);
    st.setView('graph');
    st.notify(`Opened “${model.name}”: ${model.terms.length} terms, ${model.relations.length} relations.`);
  } catch (e) {
    st.notify(e instanceof Error ? `Could not open ${file.name}: ${e.message}` : `Could not open ${file.name}.`);
  }
}

export function Header() {
  const model = useStore((s) => s.model);
  const view = useStore((s) => s.view);
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
  // The count comes a moment after an edit, so that checking a large model never holds up the edit itself.
  const [problems, setProblems] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setProblems([...owlFindings(meaning).findings, ...qualityFindings(meaning).findings].filter((f) => f.severity !== 'info').length), meaning.terms.length > 300 ? 400 : 0);
    return () => clearTimeout(id);
  }, [meaning]);

  const dropdown = (e: React.MouseEvent, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  const fileMenu: MenuItem[] = [
    { label: 'New model', onClick: () => confirmDiscard() && newModel() },
    { label: 'Open a file…', onClick: () => confirmDiscard() && fileRef.current?.click(), hint: 'JSON, Turtle' },
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
    { label: 'SKOS (Turtle)', onClick: () => exportModel('skos'), hint: model.mode === 'skos' ? '' : 'converted' },
    { label: 'OWL (Turtle)', onClick: () => exportModel('owl'), hint: model.mode === 'ontology' ? '' : 'converted' },
    { label: 'JSON-LD', onClick: () => exportModel('jsonld') },
    { label: 'Terms as CSV', onClick: () => exportModel('csv-terms') },
    { label: 'Relations as CSV', onClick: () => exportModel('csv-relations') },
    { label: 'Image (SVG)', onClick: () => exportModel('svg') },
    { label: 'Image (PNG)', onClick: () => exportModel('png') },
  ];
  const arrangeMenu: MenuItem[] = [
    { label: 'As hierarchy', onClick: () => st().arrange('hierarchy') },
    { label: 'As network', onClick: () => st().arrange('force') },
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
        {VIEWS.map((v) => (
          <button key={v.value} role="tab" aria-selected={view === v.value} className={view === v.value ? 'on' : ''} onClick={() => st().setView(v.value)}>
            {v.label}
            {v.value === 'checks' && problems > 0 && <span className="badge">{problems}</span>}
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
        accept=".json,.ttl,.nt,.n3,.turtle,application/json,text/turtle"
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
