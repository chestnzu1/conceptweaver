import { useMemo, useState, type ReactNode } from 'react';
import { download } from '../model/files';
import { toJsonLd, toTriples, toTurtle } from '../model/rdf';
import { useStore } from '../model/store';

type Format = 'turtle' | 'jsonld' | 'triples';

const FORMATS: { value: Format; label: string }[] = [
  { value: 'turtle', label: 'Turtle' },
  { value: 'jsonld', label: 'JSON-LD' },
  { value: 'triples', label: 'Triples' },
];

const TURTLE_TOKEN = /("(?:[^"\\]|\\.)*")|(@prefix\b|(?<=\s)a(?=\s))|(<[^>\s]*>)|((?:owl|rdfs?|skos|xsd):[\w-]+)|(:[\p{L}\p{N}_-]*)/gu;
const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?/g;

/** Splits source text into coloured spans; `classify` names the class for each regex match. */
function highlight(text: string, re: RegExp, classify: (m: RegExpExecArray) => string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={m.index} className={classify(m)}>
        {m[1] ?? m[0]}
      </span>,
    );
    // In JSON the colon after a key stays uncoloured.
    last = m.index + (m[1] ?? m[0]).length;
    re.lastIndex = Math.max(re.lastIndex, last);
    if (m[1] && m[0].length > m[1].length) re.lastIndex = last;
  }
  out.push(text.slice(last));
  return out;
}

const turtleClass = (m: RegExpExecArray) => (m[1] ? 'str' : m[2] ? 'kw' : m[3] ? 'iri' : m[4] ? 'voc' : 'name');
const termClass = (t: string) => (t.startsWith(':') ? 'name' : t.startsWith('<') || t.startsWith('_:') ? 'iri' : t === 'a' ? 'kw' : 'voc');

/** Lines or rows shown at first. */
const PART = 1500;

/** Remembered while switching between views. */
let lastFormat: Format = 'turtle';

export function RdfView() {
  const model = useStore((s) => s.model);
  const notify = useStore((s) => s.notify);
  const [format, setFormatState] = useState<Format>(lastFormat);
  const setFormat = (f: Format) => setFormatState((lastFormat = f));
  const turtle = useMemo(() => toTurtle(model), [model]);
  const jsonld = useMemo(() => (format === 'jsonld' ? toJsonLd(model) : ''), [model, format]);
  const triples = useMemo(() => (format === 'triples' ? toTriples(model) : []), [model, format]);

  const text = format === 'jsonld' ? jsonld : format === 'turtle' ? turtle : triples.map((t) => `${t.s} ${t.p} ${t.o} .`).join('\n') + '\n';
  const lines = format === 'triples' ? triples.length : text.trimEnd().split('\n').length;
  // A large model is thousands of lines; they are shown a part at a time. Copy and Download always give everything.
  const [shownState, setShown] = useState({ format, n: PART });
  const shown = shownState.format === format ? shownState.n : PART;
  const visible = useMemo(() => {
    if (format === 'triples') return '';
    let at = -1;
    for (let i = 0; i < shown; i++) {
      at = text.indexOf('\n', at + 1);
      if (at === -1) return text;
    }
    return text.slice(0, at + 1);
  }, [text, shown, format]);
  const more = format === 'triples' ? triples.length > shown : visible.length < text.length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      notify('Copied to the clipboard.');
    } catch {
      notify('Could not copy. Select the text and copy it manually.');
    }
  };
  const save = () => {
    const base = model.name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'model';
    if (format === 'jsonld') download(`${base}.jsonld`, text, 'application/ld+json');
    else download(`${base}.ttl`, format === 'turtle' ? text : turtle, 'text/turtle');
  };

  return (
    <div className="view">
      <div className="view-head">
        <div className="row">
          <div className="tabs" role="tablist" aria-label="RDF format">
            {FORMATS.map((f) => (
              <button key={f.value} role="tab" aria-selected={format === f.value} className={format === f.value ? 'on' : ''} onClick={() => setFormat(f.value)}>
                {f.label}
              </button>
            ))}
          </div>
          <span className="muted">
            {format === 'triples' ? `${lines} triples` : `${lines} lines`} · updates as you edit the model
          </span>
        </div>
        <div className="row">
          <button className="btn" onClick={copy}>
            Copy
          </button>
          <button className="btn" onClick={save}>
            Download
          </button>
        </div>
      </div>
      {format === 'triples' ? (
        <div className="table-wrap">
          <table className="triples">
            <thead>
              <tr>
                <th style={{ width: '28%' }}>Subject</th>
                <th style={{ width: '24%' }}>Predicate</th>
                <th>Object</th>
              </tr>
            </thead>
            <tbody>
              {triples.slice(0, shown).map((t, i) => (
                <tr key={i}>
                  <td className={termClass(t.s)}>{t.s}</td>
                  <td className={termClass(t.p)}>{t.p}</td>
                  <td className={t.literal ? 'str' : termClass(t.o)}>{t.o}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rdf-wrap">
          <pre className="rdf-code" tabIndex={0} aria-label={format === 'turtle' ? 'Turtle source' : 'JSON-LD source'}>
            {format === 'turtle' ? highlight(visible, new RegExp(TURTLE_TOKEN), turtleClass) : highlight(visible, new RegExp(JSON_TOKEN), (m) => (m[2] ? 'name' : 'str'))}
          </pre>
        </div>
      )}
      {more && (
        <p className="pager">
          Showing the first {shown} of {lines} {format === 'triples' ? 'triples' : 'lines'}.
          <button className="btn small" onClick={() => setShown({ format, n: shown + 5000 })}>
            Show 5000 more
          </button>
          <button className="btn small" onClick={() => setShown({ format, n: Number.MAX_SAFE_INTEGER })}>
            Show all
          </button>
          <span className="muted">Copy and Download give the whole file.</span>
        </p>
      )}
    </div>
  );
}
