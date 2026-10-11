import { useStore } from '../model/store';
import { useLazyOptions } from './fields';

/** A removable chip per term, plus a dropdown to add another. */
export function TermChips({ ids, add, remove, placeholder, exclude = [] }: { ids: string[]; add: (id: string) => void; remove: (id: string) => void; placeholder: string; exclude?: string[] }) {
  const terms = useStore((s) => s.model.terms);
  const st = useStore.getState;
  // Only the few terms shown as chips are looked up, not the whole model.
  const byId = new Map(ids.map((id) => [id, terms.find((t) => t.id === id)] as const).filter((x): x is [string, (typeof terms)[number]] => !!x[1]));
  const { ready, lazy } = useLazyOptions();
  const options = ready ? terms.filter((t) => t.type !== 'property' && !ids.includes(t.id) && !exclude.includes(t.id)).sort((a, b) => a.name.localeCompare(b.name)) : [];
  return (
    <>
      <div className="chips-inline">
        {ids
          .filter((id) => byId.has(id))
          .map((id) => (
            <span key={id} className="chip-x">
              <button className="link" title="Show on the canvas" onClick={() => st().focusTerm(id)}>
                {byId.get(id)!.name || 'Unnamed'}
              </button>
              <button aria-label={`Remove ${byId.get(id)!.name}`} title="Remove" onClick={() => remove(id)}>
                ×
              </button>
            </span>
          ))}
      </div>
      <select aria-label={placeholder} value="" {...lazy} onChange={(e) => e.target.value && add(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name || 'Unnamed'}
          </option>
        ))}
      </select>
    </>
  );
}
