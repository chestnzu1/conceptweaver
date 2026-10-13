import { compactIri } from '../model/prefixes';
import { assertedSuperclasses } from '../model/props';
import { useStore } from '../model/store';
import { addIsA } from '../model/axioms';
import { EntityPicker, type Choice } from './EntityPicker';
import type { Term } from '../model/types';
import { Marked, type Ranges } from './Highlight';
import { Icon } from './Icon';

/**
 * An entity's full IRI, read-only. The namespace gives way when space is short so that the
 * distinguishing last part stays visible; the whole IRI is in the tooltip and one click copies it.
 */
export function IriCell({ iri, of, full = false, marks }: { iri?: string; of: string; full?: boolean; /** Where a search found its words in what is shown: the prefixed IRI, or the full one. */ marks?: (shown: string) => Ranges | undefined }) {
  const notify = useStore((s) => s.notify);
  // Written with a prefix where the ontology has one for it (ex:Actor); the full IRI is always the tooltip and what Copy gives.
  const curie = useStore((s) => (iri && !full ? compactIri(s.model, iri) : undefined));
  if (!iri) {
    return (
      <span className="muted iri-none" title="An IRI is made from the name, in the model's base namespace, as soon as the entity is given one.">
        assigned when named
      </span>
    );
  }
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(iri);
      notify('IRI copied.');
    } catch {
      notify(`Could not copy. The IRI is ${iri}`);
    }
  };
  // The two parts are drawn apart, and a word that was found may lie across them.
  const shown = curie ?? iri;
  const at = curie ? curie.indexOf(':') + 1 : cut;
  const ranges = marks?.(shown);
  return (
    <span className="iri-cell" title={iri}>
      <span className={curie ? 'iri-prefix' : 'iri-ns'}>
        <Marked text={shown} ranges={ranges} to={at} />
      </span>
      <span className="iri-local">
        <Marked text={shown} ranges={ranges} from={at} />
      </span>
      <button className="btn icon ghost iri-copy" title="Copy the full IRI" aria-label={`Copy the IRI of ${of}`} onClick={copy}>
        <Icon name="copy" size={13} />
      </button>
    </span>
  );
}

/** What one "is a" statement about a term is called: a class has superclasses, an individual types, a data property superproperties. */
const isANoun = (term: Term, skos: boolean) => (term.type === 'instance' && !skos ? 'type' : term.type === 'property' && !skos ? 'superproperty' : 'superclass');

/**
 * What a term is explicitly stated to be a kind of: the asserted superclasses of a class, the
 * types of an individual, the superproperties of a data property. Each chip is one "is a"
 * statement: removing it removes that statement and no other. Any number can stand side by side.
 */
export function SuperclassEditor({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const skos = model.mode === 'skos';
  const noun = isANoun(term, skos);
  const pick = (t: Term): Choice => ({ id: t.id, name: t.name || 'Unnamed', iri: t.iri, ...(t.external !== undefined ? { tag: 'external' } : {}) });
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const supers = assertedSuperclasses(model, term.id).filter((id) => byId.has(id));
  // A class is a kind of classes and an individual an instance of them; a data property specialises data properties.
  const wanted = term.type === 'property' ? 'property' : 'concept';
  const label = skos ? 'a broader concept' : noun === 'type' ? 'a type' : `a ${noun}`;
  return (
    <EntityPicker
      values={supers.map((id) => pick(byId.get(id)!))}
      options={() => model.terms.filter((t) => t.id !== term.id && (skos || t.type === wanted)).map(pick)}
      onAdd={(id) => st().edit((m) => addIsA(m, term.id, id))}
      onRemove={(id) => st().removeSuperclass(term.id, id)}
      onOpen={(id) => st().focusTerm(id)}
      noun={noun}
      of={term.name}
      addLabel={`Add ${label}`}
      searchLabel={`Search for ${label}`}
      empty={skos ? 'top concept' : noun === 'type' ? 'not set' : '—'}
    />
  );
}
