import { Fragment, type ReactNode } from 'react';
import { useStore } from '../../model/store';

/**
 * An answer of the assistant, read as the little Markdown it writes: paragraphs, lists, headings,
 * code, bold and italics, and links. A link to an entity of the ontology opens it in the editor
 * and centres it on the canvas; a link to anything else is shown as its address and opened apart;
 * a link that looks like an IRI of the ontology but names nothing in it is marked as such. Nothing
 * of the text is ever read as HTML.
 */
export function AnswerText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      blocks.push(<pre key={blocks.length}>{code.join('\n')}</pre>);
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={blocks.length}>
          {items.map((t, n) => (
            <li key={n}>
              <Inline text={t} />
            </li>
          ))}
        </List>,
      );
    } else if (/^#{1,4}\s/.test(line)) {
      blocks.push(
        <p key={blocks.length} className="heading">
          <Inline text={line.replace(/^#+\s/, '')} />
        </p>,
      );
      i++;
    } else if (!line.trim()) i++;
    else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(
        <p key={blocks.length}>
          <Inline text={para.join(' ')} />
        </p>,
      );
    }
  }
  return <div className="answer-text">{blocks}</div>;
}

/** Bold, italics, code and links within a line. */
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|<https?:\/\/[^>\s]+>|\*[^*\s][^*]*\*)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) parts.push(text.slice(at, m.index));
    const t = m[0];
    if (t.startsWith('`')) parts.push(<code key={parts.length}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) parts.push(<strong key={parts.length}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('[')) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      parts.push(<EntityLink key={parts.length} label={label} href={href} />);
    } else if (t.startsWith('<')) parts.push(<EntityLink key={parts.length} label={t.slice(1, -1)} href={t.slice(1, -1)} />);
    else parts.push(<em key={parts.length}>{t.slice(1, -1)}</em>);
    at = m.index! + t.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <Fragment>{parts}</Fragment>;
}

/** A link: to an entity of the ontology, opened in the editor; to the web, opened apart; to an IRI the ontology does not have, marked. */
function EntityLink({ label, href }: { label: string; href: string }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const term = model.terms.find((t) => t.iri === href);
  const prop = term ? undefined : model.props.find((p) => p.iri === href);
  if (term || prop)
    return (
      <button
        className="link entity-ref"
        title={`${href}\nOpen it in the editor`}
        data-iri={href}
        onClick={() => {
          if (term) {
            st().select([term.id]);
            st().focusTerm(term.id);
          } else st().selectProp(prop!.id);
        }}
      >
        {label}
      </button>
    );
  const base = model.baseIri || '';
  if (base && href.startsWith(base))
    return (
      <span className="entity-ref missing" title={`${href}\nThe ontology has no entity with this IRI.`}>
        {label} <span className="tag warn">not in the ontology</span>
      </span>
    );
  if (/^https?:\/\//.test(href))
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={href}>
        {label}
      </a>
    );
  return <span title={href}>{label}</span>;
}
