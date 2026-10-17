import { addEnumMember, createEnumMember, declareAllDifferent, definedClasses, enumerationExpression, enumMembers, isEnumeration, removeEnumMember, setEnumeration } from '../model/axioms';
import { nameIn } from '../model/labels';
import { compactIri } from '../model/prefixes';
import { useStore } from '../model/store';
import type { Term } from '../model/types';
import { Section } from './EntityEditor';
import { EntityPicker } from './EntityPicker';

/**
 * How a class is defined, where it is defined by more than its place in the hierarchy. The
 * definition edited here is the enumeration: the class is exactly the individuals listed
 * (owl:equivalentClass with owl:oneOf). A class defined by what else it is equivalent to (a class,
 * or an expression) says so, and points to where those are edited. The class stays a class; its
 * other axioms and its annotations are edited where they always were.
 */
export function ClassDefinition({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const displayLang = useStore((s) => s.displayLang);
  const st = useStore.getState;
  const shown = (t: Term) => nameIn(t, model.lang, displayLang) || 'Unnamed';
  const on = isEnumeration(term);
  // Defined otherwise: by an equivalent class or an Equivalent To expression.
  const byEquivalents = !on && definedClasses(model).has(term.id);
  const members = enumMembers(model, term);
  const locked = term.external !== undefined;
  const short = (iri?: string) => (iri ? (compactIri(model, iri) ?? `<${iri}>`) : undefined);
  const say = (refused: string | undefined) => (refused ? st().notify(refused) : undefined);
  const list = members.map((m) => short(m.iri) ?? m.name).join(' ');

  return (
    <Section id="class-definition" title="Class definition" count={on ? members.length : undefined}>
      <label className="field">
        <span>Defined as</span>
        <select aria-label="Class definition" value={on ? 'oneOf' : ''} disabled={locked} onChange={(e) => say(st().edit((m) => setEnumeration(m, term.id, e.target.value === 'oneOf')))}>
          <option value="">{byEquivalents ? 'By what it is equivalent to (below)' : 'No definition (an ordinary class)'}</option>
          <option value="oneOf">Enumeration (ObjectOneOf)</option>
        </select>
        {byEquivalents && <small>A defined class: being what it is equivalent to, under Equivalent classes or Class expressions below, is enough to be one, and a reasoner classifies by it.</small>}
        {!on && <small>An enumeration is a class that is exactly a list of individuals, such as the colours of a traffic light.</small>}
      </label>
      {on && (
        <>
          <div className="field">
            <span>
              Enumerated individuals <code className="pred">owl:oneOf</code>
            </span>
            {members.length > 0 && (
              <ul className="enum-members" aria-label={`Members of ${nameIn(term, model.lang, displayLang)}`}>
                {members.map((m) => (
                  <li key={m.id}>
                    <button className="link" title="Open this individual" onClick={() => st().select([m.id])}>
                      {shown(m)}
                    </button>
                    <code className="pred" title={m.iri}>
                      {short(m.iri) ?? 'IRI assigned when named'}
                    </code>
                    {m.type !== 'instance' && (
                      <span className="tag warn" title="An enumeration lists individuals. This term is something else.">
                        not an individual
                      </span>
                    )}
                    {!locked && (
                      <button className="btn icon ghost" title="Take it off the list. The individual itself stays in the model." aria-label={`Remove ${shown(m)} from the enumeration`} onClick={() => st().apply((mm) => removeEnumMember(mm, term.id, m.id))}>
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!locked && (
              <EntityPicker
                values={[]}
                // Individuals that are not members yet. One individual can be a member of several enumerations.
                options={() => model.terms.filter((t) => t.type === 'instance' && !term.oneOf!.includes(t.id)).map((t) => ({ id: t.id, name: nameIn(t, model.lang, displayLang) || 'Unnamed', iri: t.iri }))}
                // Any other name typed is a new individual, made and listed in one step.
                custom={(text) => (model.terms.some((t) => t.type === 'instance' && t.name.trim().toLowerCase() === text.toLowerCase()) ? undefined : { id: 'new:' + text, name: text, tag: 'create individual' })}
                noun="individual"
                of={nameIn(term, model.lang, displayLang)}
                addLabel="Add an individual to the enumeration"
                searchLabel="Search for an individual, or type the name of a new one"
                empty={members.length ? 'Add individual' : 'No members yet. Add an individual'}
                onAdd={(id) => st().edit((m) => (id.startsWith('new:') ? createEnumMember(m, term.id, id.slice(4)) : addEnumMember(m, term.id, id)))}
                onRemove={() => undefined}
              />
            )}
          </div>
          <label className="check" title="States that no two members are the same individual. Without it nothing is assumed: two members may be one thing under two names.">
            <input type="checkbox" checked={!!term.allDifferent} disabled={locked || members.length < 2} onChange={(e) => say(st().edit((m) => declareAllDifferent(m, term.id, e.target.checked)))} />
            <span>
              Declare all members different <code className="pred">owl:AllDifferent</code>
            </span>
          </label>
          <div className="field">
            <span>OWL expression</span>
            <code className="expression" aria-label="Manchester syntax">
              {term.name || 'Unnamed'} EquivalentTo: {enumerationExpression(model, term)}
            </code>
            {members.length > 0 ? (
              <code className="expression" aria-label="Turtle">
                owl:equivalentClass [ a owl:Class ; owl:oneOf ( {list} ) ]
              </code>
            ) : (
              <small>With no members it says nothing yet, and nothing is exported for it.</small>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
