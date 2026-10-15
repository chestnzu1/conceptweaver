import { useMemo, useState } from 'react';
import { CLASS_AXIOM_KINDS, same, type ClassAxiomKind, type ClassExpression, type ClassExpressionAxiom } from '../model/expressions';
import { classAxiomInWords } from '../model/inWords';
import { formatClass, hasUnparsed, namingFor } from '../model/manchester';
import { useStore } from '../model/store';
import { uid, type Term } from '../model/types';
import { Section } from './EntityEditor';
import { ExpressionDialog } from './ExpressionEditor';

/** How each kind of class axiom is named, written and explained. */
export const CLASS_AXIOM: Record<ClassAxiomKind, { label: string; pred: string; about: string }> = {
  SubClassOf: { label: 'SubClass Of', pred: 'rdfs:subClassOf', about: 'Every member of the class is in the expression. Not the other way round: being in it does not make something a member.' },
  EquivalentClasses: { label: 'Equivalent To', pred: 'owl:equivalentClass', about: 'The class has exactly the members of the expression: being in it is enough to be a member, and a reasoner will classify by it.' },
  DisjointClasses: { label: 'Disjoint With', pred: 'owl:disjointWith', about: 'Nothing is both a member of the class and in the expression.' },
};

/**
 * A class's axioms that are expressions: what it is a subclass of, equivalent to or disjoint with,
 * where that is not a named class or one restriction drawn on the canvas. Each axiom is its own:
 * of the kind it was stated as (which is chosen, never assumed), never merged with another, and
 * edited in the expression editor, as blocks or as Manchester syntax.
 */
export function ClassAxioms({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const naming = useMemo(() => namingFor(model), [model]);
  const [editing, setEditing] = useState<string>();
  const [kind, setKind] = useState<ClassAxiomKind>();
  const axioms = term.classAxioms ?? [];
  const name = term.name || 'This class';
  const put = (next: ClassExpressionAxiom[]) => st().updateTerm(term.id, { classAxioms: next.length ? next : undefined });
  const start = (id: string, k?: ClassAxiomKind) => {
    setEditing(id);
    setKind(k);
  };
  const save = (expression: ClassExpression): string | undefined => {
    if (!kind) return 'Choose what kind of axiom it is: SubClass Of, Equivalent To or Disjoint With.';
    const id = editing === 'new' || !editing ? uid() : editing;
    if (axioms.some((a) => a.id !== id && a.kind === kind && same(a.expression, expression))) return `${name} is ${CLASS_AXIOM[kind].label.toLowerCase()} that already.`;
    if (expression.type === 'Class' && expression.iri === term.iri) return `An axiom of ${name} about ${name} itself says nothing.`;
    const made: ClassExpressionAxiom = { id, kind, expression };
    put(editing === 'new' ? [...axioms, made] : axioms.map((a) => (a.id === id ? made : a)));
    setEditing(undefined);
    return undefined;
  };
  const kindChoice = (
    <fieldset className="field xe-kind">
      <legend>What the axiom says of {name}</legend>
      {CLASS_AXIOM_KINDS.map((k) => (
        <label key={k} className="check" title={CLASS_AXIOM[k].about}>
          <input type="radio" name={`axiom-kind-${term.id}`} checked={kind === k} onChange={() => setKind(k)} />
          <span>
            {CLASS_AXIOM[k].label} <code className="pred">{CLASS_AXIOM[k].pred}</code>
          </span>
        </label>
      ))}
      {kind && <small>{CLASS_AXIOM[kind].about}</small>}
    </fieldset>
  );
  const editor = (initial?: ClassExpression) => (
    <ExpressionDialog
      title={editing === 'new' ? `A new class axiom of ${name}` : `An axiom of ${name}`}
      sort="class"
      initial={initial}
      label={`${editing === 'new' ? 'New' : 'Changed'} class axiom of ${name}`}
      before={kindChoice}
      blocked={kind ? undefined : 'Choose what kind of axiom it is.'}
      inWords={kind ? (e) => classAxiomInWords(kind, term.name, e as ClassExpression, naming) : undefined}
      onSave={(e) => save(e as ClassExpression)}
      onCancel={() => setEditing(undefined)}
      saveLabel={editing === 'new' ? 'Add the axiom' : 'Save the axiom'}
    />
  );
  return (
    <Section id="class-expressions" title="Class expressions" count={axioms.length}>
      {!axioms.length && <p className="muted">None. A superclass, a definition (equivalent class) or a disjoint class that is an expression, such as Person and (hasAge some xsd:integer[&gt;= 18]), is stated here.</p>}
      {CLASS_AXIOM_KINDS.filter((k) => axioms.some((a) => a.kind === k)).map((k) => (
        <div key={k} className="field" data-axiom-kind={k}>
          <span title={CLASS_AXIOM[k].about}>
            {CLASS_AXIOM[k].label} <code className="pred">{CLASS_AXIOM[k].pred}</code>
          </span>
          <ul className="class-axioms">
            {axioms
              .filter((a) => a.kind === k)
              .map((a) => (
                <li key={a.id} className={hasUnparsed(a.expression) ? 'kept' : undefined}>
                  {editing === a.id && editor(a.expression)}
                  {
                    <>
                      <pre className="axiom">{formatClass(a.expression, naming, 60)}</pre>
                      <p className="axiom-words">{classAxiomInWords(a.kind, term.name, a.expression, naming)}</p>
                      <span className="row">
                        {hasUnparsed(a.expression) ? (
                          <small className="tag" title="Part of it is kept exactly as it was read, in a form this editor has no structure for. It is written back as it was. It can be taken away, not changed here.">
                            kept as read
                          </small>
                        ) : (
                          <button className="link" aria-label={`Change the ${CLASS_AXIOM[k].label} axiom ${formatClass(a.expression, naming, 1000)}`} onClick={() => start(a.id, a.kind)}>
                            Change
                          </button>
                        )}
                        <button className="link" aria-label={`Remove the ${CLASS_AXIOM[k].label} axiom ${formatClass(a.expression, naming, 1000)}`} onClick={() => put(axioms.filter((x) => x.id !== a.id))}>
                          Remove
                        </button>
                      </span>
                    </>
                  }
                </li>
              ))}
          </ul>
        </div>
      ))}
      {editing === 'new' && editor()}
      <button className="btn small" onClick={() => start('new')}>
        Add a class axiom
      </button>
    </Section>
  );
}
