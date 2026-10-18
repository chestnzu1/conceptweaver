import { useEffect, useRef, useState } from 'react';
import { EntityQueryError, type EntityDescription, type EntityPage, type EntityQueryService, type EntityRow, type ListKind, type OntologyRef } from '../entities/contracts';
import { createLocalEntityService } from '../entities/local';
import { MAX_PAGE } from '../entities/service';
import { currentDl, currentReasoning, useStore, type EntityViewState } from '../model/store';
import { useReasoning } from './reasoning';
import { ontologyRef } from '../structure/local';
import { TYPING_PAUSE, useSettled } from './useSettled';

/**
 * Where the Entities page gets its lists. Today that is the model in the editor, with what the
 * OWL 2 DL reasoner found about it where it was asked. A service that asks a backend would be put
 * here in its place, and nothing of the page would change: it puts whole questions and is given
 * keys in an order, a page at a time.
 */
export const entityService: EntityQueryService = createLocalEntityService(() => {
  const s = useStore.getState();
  return { model: s.model, docId: s.doc.id, dl: currentDl(s), fast: currentReasoning(s), lang: s.displayLang };
});

export interface EntityList {
  ontology: OntologyRef;
  /** The sorts and the filters the list has. Nothing until the service has said. */
  description: EntityDescription | null;
  /** The rows to show, in order: up to as many as were asked for. */
  rows: EntityRow[];
  /** The answer the rows are from: how many there are, the words that were looked for, what the service had to say. */
  page: EntityPage | null;
  /** What is shown is the answer to what is asked now: of this revision, this search, this order, these filters. Otherwise the answer is on its way, and what is shown is from the question before. */
  settled: boolean;
  /** Why the list could not be answered, when it could not. */
  error: string | null;
}

/**
 * One list of the Entities page as the service answers it: asked again whenever the ontology,
 * the search, the order, the filters or how much to show changes. A question still on its way
 * when the next is put is given up. Until the next answer is there the last one stays on show.
 */
export function useEntityList(kind: ListKind | null, view: EntityViewState, limit: number): EntityList {
  const model = useStore((s) => s.model);
  const docId = useStore((s) => s.doc.id);
  // What a reasoner found is part of what some filters answer with: the classes and individuals ask the app's own reasoner for it.
  const dl = useStore(currentDl);
  const fast = useReasoning(kind === 'class' || kind === 'individual');
  // Names are shown in the display language: a list is asked for again when that changes.
  const lang = useStore((s) => s.displayLang);
  const ontology = ontologyRef(model, docId);
  const { ontologyId, revisionId } = ontology;
  const search = useSettled(view.search, TYPING_PAUSE);
  const sort = view.sort ? `${view.sort.by} ${view.sort.dir}` : '';
  const filters = JSON.stringify(view.filters);

  const [described, setDescribed] = useState<{ kind: ListKind; description: EntityDescription } | null>(null);
  const [answer, setAnswer] = useState<{ asked: string; page: EntityPage; rows: EntityRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Everything the question is made of: an answer is the answer to this, or it is an earlier one.
  const asked = [kind, ontologyId, revisionId, search, sort, filters, limit, lang].join('\n');
  const latest = useRef(view);
  latest.current = view;

  useEffect(() => {
    if (!kind) return;
    const gone = new AbortController();
    entityService.describe({ ontologyId, revisionId, kind }, { signal: gone.signal }).then(
      (description) => !gone.signal.aborted && setDescribed({ kind, description }),
      () => undefined,
    );
    return () => gone.abort();
  }, [kind, ontologyId, revisionId, dl, fast, lang]);

  useEffect(() => {
    if (!kind) return;
    const gone = new AbortController();
    const { sort: by, filters: on } = latest.current;
    (async () => {
      // More than the service gives at once is asked for a page after a page.
      const first = await entityService.query({ ontologyId, revisionId, kind, search, ...(by ? { sort: by } : {}), filters: on, offset: 0, limit: Math.min(limit, MAX_PAGE) }, { signal: gone.signal });
      const rows = [...first.rows];
      while (rows.length < Math.min(limit, first.matched)) {
        const next = await entityService.query({ ontologyId, revisionId, kind, search, ...(by ? { sort: by } : {}), filters: on, offset: rows.length, limit: Math.min(limit - rows.length, MAX_PAGE) }, { signal: gone.signal });
        if (!next.rows.length) break;
        rows.push(...next.rows);
      }
      return { asked, page: first, rows };
    })().then(
      (got) => {
        if (gone.signal.aborted) return;
        setAnswer(got);
        setError(null);
      },
      (e: unknown) => {
        // Given up, or asked of a revision the model has since left: the next question is on its way already.
        if (gone.signal.aborted || (e instanceof EntityQueryError && (e.code === 'aborted' || e.code === 'stale-revision'))) return;
        setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => gone.abort();
    // The order and the filters are read as they are when the question is put; `asked` says when anything of it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, dl, fast]);

  // The last answer stays on show until the next is there, but not under another tab.
  const mine = answer && answer.page.kind === kind ? answer : null;
  return { ontology, description: described && described.kind === kind ? described.description : null, rows: mine?.rows ?? [], page: mine?.page ?? null, settled: !!mine && mine.asked === asked && search === view.search, error };
}
