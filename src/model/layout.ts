import { forceLayout as force } from '../layout/force';
import { graphOf } from '../layout/graph';
import { hierarchyLayout as hierarchy } from '../layout/hierarchy';
import { noLayout, type Positions } from '../layout/types';
import type { Model } from './types';

export type { Positions };

const USUAL = noLayout();

/**
 * Layered top-down layout of a whole model, as it is set when nothing else was asked for:
 * what a model gets when it is first made or read. The layouts themselves are in src/layout.
 */
export const hierarchyLayout = (model: Model): Positions => hierarchy(graphOf(model), USUAL);

/** Force-directed layout of a whole model, with the usual settings. */
export const forceLayout = (model: Model): Positions => force(graphOf(model), USUAL);

/** Arranges a model that was just made or read, in place, and says so in it: the layout selector then shows what it is looking at. */
export function arrangeAsHierarchy(m: Model): void {
  const pos = hierarchyLayout(m);
  for (const t of m.terms) Object.assign(t, pos.get(t.id));
  m.layout = { ...m.layout, kind: 'hierarchy' };
}
