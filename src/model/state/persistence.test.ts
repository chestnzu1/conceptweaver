import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readWorkingCopy, useIndexedDb, writeWorkingCopy } from '../library';
import { universitySample } from '../sampleUniversity';
import { isDirty, startWorkingCopy, useStore } from '../store';
import { stressModel } from '../stress';
import { normalizeModel } from '../types';
import { DOC_KEY, MODEL_KEY } from './storage';

/** localStorage as a browser has it, for what an earlier version of the app kept there. */
const local = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
    clear: () => local.clear(),
  },
});

const st = useStore.getState;
const kept = () => new Promise((r) => setTimeout(r, 400));

describe('the working copy', () => {
  let db: IDBFactory;
  beforeAll(async () => {
    // A browser where an earlier version of the app kept the working copy in localStorage.
    db = new IDBFactory();
    useIndexedDb(db);
    local.set(MODEL_KEY, JSON.stringify(universitySample()));
    local.set(DOC_KEY, JSON.stringify({ id: 'saved-1', dirty: true }));
    await startWorkingCopy();
  });
  beforeEach(() => useIndexedDb(db));

  it('is moved over from localStorage, as it was, and taken out of there', async () => {
    expect(st().model.name).toBe(universitySample().name);
    expect(st().model.terms).toHaveLength(universitySample().terms.length);
    expect(st().doc.id).toBe('saved-1');
    expect(isDirty(st())).toBe(true);
    expect((await readWorkingCopy())?.model.terms).toHaveLength(universitySample().terms.length);
    expect(local.has(MODEL_KEY) || local.has(DOC_KEY)).toBe(false);
  });

  it('is kept as it is edited, a moment after each change', async () => {
    const id = st().addTerm({ name: 'Visiting lecturer' });
    await kept();
    const copy = await readWorkingCopy();
    expect(copy?.model.terms.find((t) => t.id === id)?.name).toBe('Visiting lecturer');
    expect(copy?.doc).toEqual({ id: 'saved-1', dirty: true });
    // Read back, it is the model in the editor.
    expect(normalizeModel(copy!.model).terms.map((t) => t.name)).toEqual(st().model.terms.map((t) => t.name));
  });

  it('says so when it cannot be kept, and again keeps it once it can', async () => {
    useIndexedDb(undefined);
    const original = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB: undefined });
    try {
      st().addTerm({ name: 'Not kept' });
      await kept();
      expect(st().workingCopyAtRisk).toBe(true);
      expect(st().toast).toMatch(/could not be kept as a working copy/);
    } finally {
      Object.assign(globalThis, { indexedDB: original });
      useIndexedDb(db);
    }
    st().addTerm({ name: 'Kept again' });
    await kept();
    expect(st().workingCopyAtRisk).toBe(false);
    expect((await readWorkingCopy())?.model.terms.some((t) => t.name === 'Kept again')).toBe(true);
  });

  it('has no limit but the browser’s space: a model of 5,200 classes is kept and read back whole', async () => {
    const big = stressModel(5200);
    expect(JSON.stringify(big).length).toBeGreaterThan(4_000_000);
    await writeWorkingCopy({ model: big, doc: { id: null, dirty: true } });
    const back = await readWorkingCopy();
    expect(back?.model.terms).toHaveLength(big.terms.length);
    expect(back?.model.relations).toHaveLength(big.relations.length);
  });
});
