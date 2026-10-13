import { useState } from 'react';
import { fetchDocument } from '../model/rdfFormats';
import { confirmDiscard, useStore } from '../model/store';
import { openDocument } from './Header';

/**
 * Opens an ontology from an address on the web as the model in the editor. It is fetched by the
 * browser, which the server has to allow, and read in whichever syntax it comes: the app asks
 * for Turtle, then RDF/XML, then the others it reads.
 */
export function OpenUrlDialog() {
  const st = useStore.getState;
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => st().setDialog(null);
  const open = async () => {
    const address = url.trim();
    if (!address || busy || !confirmDiscard()) return;
    setBusy(true);
    setError(undefined);
    try {
      const { text, contentType } = await fetchDocument(address);
      const problem = await openDocument(text, address, { contentType, url: address });
      if (problem === undefined) close();
      else setError(problem);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog saveas" role="dialog" aria-modal="true" aria-labelledby="openurl-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="openurl-title">Open an ontology from a URL</h2>
        <label className="field">
          <span>Address</span>
          <input autoFocus type="url" value={url} placeholder="https://…" aria-label="Ontology URL" aria-invalid={!!error} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void open()} />
          <small>
            The ontology is read in whichever syntax the server gives it: Turtle, RDF/XML (most .owl files), JSON-LD or N-Triples, and OWL/XML, functional or Manchester syntax where the local OWL service is running. It replaces the model in the
            editor. What it imports is recorded by its IRI and not fetched.
          </small>
        </label>
        {error && (
          <p className="bad" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!url.trim() || busy} onClick={() => void open()}>
            {busy ? 'Fetching…' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Something to tell that takes longer to read than a notice is shown for: it stays until it is dismissed. */
export function MessageDialog() {
  const message = useStore((s) => s.message);
  const close = useStore((s) => s.dismissMessage);
  if (!message) return null;
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog saveas" role="alertdialog" aria-modal="true" aria-labelledby="message-title" aria-describedby="message-text" onKeyDown={(e) => (e.key === 'Escape' || e.key === 'Enter') && close()}>
        <h2 id="message-title">{message.title}</h2>
        <p id="message-text" className="message-text">
          {message.text}
        </p>
        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn primary" autoFocus onClick={close}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
