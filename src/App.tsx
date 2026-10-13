import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Header, openFile } from './components/Header';
import { Inspector } from './components/Inspector';
import { TermList } from './components/TermList';
import { LibraryDialog, SaveAsDialog } from './components/Library';
import { OntologySettings } from './components/OntologySettings';
import { RdfView } from './components/RdfView';
import { SparqlView } from './components/SparqlView';
import { VocabView } from './components/VocabView';
import { EntitiesView } from './components/Entities';
import { AlignmentView } from './components/Alignment';
import { ValidationView } from './components/Validation';
import { StructureView } from './components/Structure';
import { BulkDialog } from './components/views';
import { viewFor } from './model/modelTypes';
import { confirmDiscard, isDirty, useStore } from './model/store';
import { NewModelDialog } from './components/NewModel';

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export function App() {
  // A function the type of model does not have is never shown, whatever view was left open.
  const view = viewFor(useStore((s) => s.model), useStore((s) => s.view));
  const theme = useStore((s) => s.theme);
  const dialog = useStore((s) => s.dialog);
  const toast = useStore((s) => s.toast);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // The working copy normally survives closing the page. Only if the browser could not keep it
  // would unsaved changes really be lost, and only then does the browser ask before leaving.
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => {
      const s = useStore.getState();
      if (s.workingCopyAtRisk && isDirty(s)) e.preventDefault();
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 's') {
        e.preventDefault();
        void st.saveToLibrary();
        return;
      }
      if (isTyping(e.target) || st.dialog) return;
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        st.redo();
      } else if (st.view !== 'graph') {
        return;
      } else if (mod && k === 'a') {
        e.preventDefault();
        st.selectAll();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        st.deleteSelection();
      } else if (e.key === 'Escape') {
        st.select([]);
        st.setHighlight([]);
      } else if (e.key === 'F2') {
        if (st.sel.terms.length === 1) st.setEditing({ kind: 'term', id: st.sel.terms[0] });
        else if (st.sel.rels.length === 1) st.setEditing({ kind: 'rel', id: st.sel.rels[0] });
      } else if (k === 'f' && !mod) {
        st.fit();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const f = e.dataTransfer.files[0];
        if (f && confirmDiscard()) void openFile(f);
      }}
    >
      <Header />
      <div className="body">
        <TermList />
        <main className="stage">
          {/* The canvas stays mounted under the other views so its size and image export keep working. */}
          <Canvas />
          {view === 'table' && <EntitiesView />}
          {view === 'structure' && <StructureView />}
          {view === 'checks' && <ValidationView />}
          {view === 'align' && <AlignmentView />}
          {view === 'rdf' && <RdfView />}
          {view === 'sparql' && <SparqlView />}
          {view === 'vocab' && <VocabView />}
        </main>
        <Inspector />
      </div>
      {dialog === 'bulk' && <BulkDialog />}
      {dialog === 'settings' && <OntologySettings />}
      {dialog === 'library' && <LibraryDialog />}
      {dialog === 'saveas' && <SaveAsDialog />}
      {dialog === 'new' && <NewModelDialog />}
      {dropping && <div className="drop-overlay">Drop a model (.json) or ontology (.ttl) to open it</div>}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
