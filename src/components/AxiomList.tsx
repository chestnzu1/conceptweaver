import { useMemo, useState, type ReactNode } from 'react';
import { same, type ClassAxiom, type ClassExpression, type DataRange, type DataRangeAxiom } from '../model/expressions';
import { classText, dataText, hasUnparsed, namingFor } from '../model/manchester';
import { useStore } from '../model/store';
import { uid } from '../model/types';
import { ExpressionDialog } from './ExpressionEditor';

type Axiom = ClassAxiom | DataRangeAxiom;

/**
 * A domain or range as the axioms it is stated as, each one rdfs:domain or rdfs:range statement:
 * shown, added, changed and taken away one at a time. Several hold together (their intersection),
 * which the list says, joining them with "and"; "either" is one axiom with "or". An axiom is
 * written and changed in the expression editor (as blocks, or in Manchester syntax). One with
 * something in it kept as it was read is shown as it is, and can be taken away but not changed.
 *
 * `axioms` undefined: none is stated, and it follows what `follows` says (shown, with its text).
 * Adding one then states it by hand. `onFollow`, where given, goes back to following.
 */
export function AxiomList({
  kind,
  axioms,
  follows,
  onChange,
  onFollow,
  of,
  which,
  empty = 'Stated as none: anything.',
  inWords,
}: {
  kind: 'class' | 'data';
  axioms: Axiom[] | undefined;
  follows?: { text: string; what: string };
  onChange: (axioms: Axiom[]) => void;
  onFollow?: { label: string; run: () => void };
  /** Whose domain or range it is, for what assistive technology reads out. */
  of: string;
  which: 'domain' | 'range';
  /** What is said where the list is stated and empty. */
  empty?: string;
  /** An axiom as a sentence about the property: "Anything that is related by “p” to something is a “Person”." */
  inWords?: (e: ClassExpression | DataRange) => string;
}) {
  const model = useStore((s) => s.model);
  const naming = useMemo(() => namingFor(model), [model]);
  const [editing, setEditing] = useState<string | undefined>();
  const list_ = axioms ?? [];
  const body = (a: Axiom) => ('expression' in a ? a.expression : a.range);
  const text = (a: Axiom) => ('expression' in a ? classText(a.expression, naming) : dataText(a.range, naming));
  const kept = (a: Axiom) => hasUnparsed(body(a));

  const save = (e: ClassExpression | DataRange): string | undefined => {
    const id = editing === 'new' || !editing ? uid() : editing;
    const made: Axiom = kind === 'class' ? { id, expression: e as ClassExpression } : { id, range: e as DataRange };
    if (list_.some((a) => a.id !== made.id && same(body(a), body(made)))) return `That is stated already: ${text(made)}.`;
    onChange(editing === 'new' ? [...list_, made] : list_.map((a) => (a.id === made.id ? made : a)));
    setEditing(undefined);
    return undefined;
  };
  const editor = (label: string, initial?: Axiom) => <ExpressionDialog title={label} sort={kind} initial={initial && body(initial)} label={label} onSave={save} onCancel={() => setEditing(undefined)} saveLabel={editing === 'new' ? 'Add' : 'Save'} inWords={inWords} />;

  let note: ReactNode;
  if (!axioms) note = follows?.text ? <>Follows {follows.what}: {follows.text}. Add an axiom to state it yourself.</> : <>Not stated: anything. Add an axiom to state it.</>;
  else if (!list_.length) note = empty;
  else if (list_.length > 1) note = <>All of these hold: whatever {which === 'domain' ? 'has it' : 'it points to'} is in every one of them (their intersection). For “either”, write one axiom with or.</>;
  return (
    <div className="axioms" data-which={which}>
      {follows?.text && !axioms && <code className="axiom auto">{follows.text}</code>}
      {list_.length > 0 && (
        <ol className="axiom-list" aria-label={`${which === 'domain' ? 'Domain' : 'Range'} axioms of ${of}`}>
          {list_.map((a, i) => (
            <li key={a.id} className={kept(a) ? 'kept' : undefined}>
              {i > 0 && <span className="axiom-and">and</span>}
              {editing === a.id && editor(`The ${which} axiom ${text(a)} of ${of}`, a)}
              {
                <>
                  <code className="axiom">{text(a)}</code>
                  {kept(a) ? (
                    <small className="tag" title="Part of it is kept exactly as it was read, in a form this editor has no structure for. It is written back as it was. It can be taken away, not changed here.">
                      kept as read
                    </small>
                  ) : (
                    <button className="link" aria-label={`Change the ${which} axiom ${text(a)}`} onClick={() => setEditing(a.id)}>
                      Change
                    </button>
                  )}
                  <button className="link" aria-label={`Remove the ${which} axiom ${text(a)}`} onClick={() => onChange(list_.filter((x) => x.id !== a.id))}>
                    Remove
                  </button>
                  {inWords && <p className="axiom-words">{inWords(body(a))}</p>}
                </>
              }
            </li>
          ))}
        </ol>
      )}
      {editing === 'new' && editor(`A new ${which} axiom of ${of}`)}
      <button className="link" onClick={() => setEditing('new')}>
        Add {which === 'domain' ? 'a domain' : 'a range'} axiom
      </button>
      <small>
        {note}
        {onFollow && axioms && (
          <>
            {' '}
            <button className="link" onClick={onFollow.run}>
              {onFollow.label}
            </button>
          </>
        )}
      </small>
    </div>
  );
}
