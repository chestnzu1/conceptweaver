import { useEffect } from 'react';
import { currentReasoning, useStore, type Reasoning } from '../model/store';

/**
 * The app's own reasoner's answer about the model as it is, once it has one. It is asked for when
 * it is first `wanted` and works in a worker, so that showing what follows never holds up an
 * edit; until it answers this is undefined, and what shows its answer says that it is working.
 */
export function useReasoning(wanted = true): Reasoning | undefined {
  const reasoning = useStore(currentReasoning);
  const revision = useStore((s) => s.version.revision);
  useEffect(() => {
    if (wanted && !reasoning) useStore.getState().requestReasoning();
  }, [wanted, reasoning, revision]);
  return wanted ? reasoning : undefined;
}

/** Why the reasoner could not answer about the model as it is, when it could not. */
export const useReasoningFailure = (): string | undefined => useStore((s) => (s.reasoning.failed?.revisionId === s.version.revision ? s.reasoning.failed.error : undefined));

/** Said where the reasoner's answer goes, while it works. */
export const WORKING = 'Working out what follows…';
