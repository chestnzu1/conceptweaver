import { nameIn } from '../model/labels';
import { useStore } from '../model/store';
import { EntityPicker, type Choice } from './EntityPicker';

/** A removable chip per term, and a search by name or IRI to add another. */
export function TermChips({ ids, add, remove, placeholder, exclude = [], noun = 'class', of = '', empty = '' }: { ids: string[]; add: (id: string) => void; remove: (id: string) => void; placeholder: string; exclude?: string[]; noun?: string; of?: string; empty?: string }) {
  const model = useStore((s) => s.model);
  const displayLang = useStore((s) => s.displayLang);
  const terms = model.terms;
  const st = useStore.getState;
  const pick = (t: (typeof terms)[number]): Choice => ({ id: t.id, name: nameIn(t, model.lang, displayLang) || 'Unnamed', iri: t.iri, ...(t.external !== undefined ? { tag: 'external' } : {}) });
  // Only the few terms shown as chips are looked up, not the whole model.
  const values = ids.map((id) => terms.find((t) => t.id === id)).filter((t): t is (typeof terms)[number] => !!t);
  return (
    <EntityPicker
      values={values.map(pick)}
      options={() => terms.filter((t) => t.type !== 'property' && !exclude.includes(t.id)).map(pick)}
      onAdd={add}
      onRemove={remove}
      onOpen={(id) => st().focusTerm(id)}
      noun={noun}
      of={of}
      addLabel={placeholder}
      searchLabel={placeholder}
      empty={empty}
    />
  );
}
