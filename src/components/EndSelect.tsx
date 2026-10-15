import { useMemo } from 'react';
import { reconnection, type End } from '../model/reconnect';
import { useStore } from '../model/store';
import type { Relation, Term } from '../model/types';
import { useLazyOptions } from './fields';

/**
 * The term at one end of a relationship, in a dropdown that moves the end to another term: the
 * edit that dragging the end does on the canvas, by the same rule (reconnect.ts). What the
 * relationship is stays what it is, so a term that cannot take the end in that way is listed
 * greyed out with the reason as its tooltip, as the canvas fades it and says why. What the
 * relationship is, is changed on its own, under Kind.
 */
export function EndSelect({ rel, end, sorted, current, label }: { rel: Relation; end: End; sorted: Term[]; current: string; label?: string }) {
  const model = useStore((s) => s.model);
  const { ready, lazy } = useLazyOptions();
  // Worked out once the dropdown is reached, as the canvas does when the end is taken hold of: then every term is asked.
  const plan = useMemo(() => (ready ? reconnection(model, rel.id, end) : undefined), [ready, model, rel.id, end]);
  return (
    <select aria-label={label} value={rel[end]} title={plan?.fixed} {...lazy} onChange={(e) => useStore.getState().reconnectRelation(rel.id, end, e.target.value)}>
      {ready ? (
        sorted.map((t) => {
          const why = plan?.refusal(t.id);
          return (
            <option key={t.id} value={t.id} disabled={!!why} title={why}>
              {t.name || 'Unnamed'}
            </option>
          );
        })
      ) : (
        <option value={rel[end]}>{current}</option>
      )}
    </select>
  );
}
