import { describe, expect, it } from 'vitest';
import { withIris } from '../model/iri';
import { sampleModel } from '../model/sample';
import type { Model } from '../model/types';
import type { TransformationConfig } from '../logical/contracts';
import { createLocalLogicalServices } from '../logical/local';
import { chosenByDefault, defaultTransformationConfig } from './transform';
import { createLocalTraceabilityService, impactOnThePage, onThePage, type TraceabilityHost } from './local';
import { createLocalTransformationService } from './local';
import type { MappingDescription, SynchronizationProposal } from './contracts';

/**
 * Traceability, impact and synchronization (LM-4): every mapping's status against the ontology,
 * coverage both ways, impact items, reviewed proposals, and hand-made mappings — with the
 * ontology never changed (ADR-025).
 */

const lower: TransformationConfig = { ...defaultTransformationConfig(), naming: { from: 'label', case: 'lower', separator: '_', singular: false } };

function harness() {
  let state = { model: withIris(sampleModel()) };
  let commits = 0;
  const versions = new Map<string, { model: Model; name: string }>();
  const { edit } = createLocalLogicalServices({
    current: () => ({ model: state.model }),
    commit: (next) => {
      commits++;
      state.model = next;
    },
  });
  const host: TraceabilityHost = {
    current: () => ({ model: state.model, ontologyId: 'film', revisionId: 'rev-1' }),
    withImports: () => undefined,
    savedVersion: async (id) => versions.get(id),
    edit,
  };
  const transformation = createLocalTransformationService(host, onThePage);
  const traceability = createLocalTraceabilityService(host, impactOnThePage);
  const iri = (name: string) => state.model.terms.find((t) => t.name === name)!.iri!;
  const ldm = (id: string) => state.model.logicalModels.find((m) => m.id === id)!;
  const derive = async (name: string, config: TransformationConfig = defaultTransformationConfig()) => {
    const made = await edit.create({ name });
    const result = await transformation.propose({ model: made.model, config });
    const accepted = result.proposals.filter(chosenByDefault).map((p) => p.id);
    await transformation.apply({ result, accepted });
    return made.model;
  };
  const removeProperty = (name: string) => {
    const term = state.model.terms.find((t) => t.name === name)!;
    state.model = {
      ...state.model,
      terms: state.model.terms.filter((t) => t.id !== term.id),
      relations: state.model.relations.filter((r) => r.from !== term.id && r.to !== term.id),
    };
  };
  const lastReport = async (model: string) => traceability.report({ model });
  return {
    edit,
    transformation,
    traceability,
    iri,
    ldm,
    derive,
    removeProperty,
    lastReport,
    versions,
    commits: () => commits,
    current: () => state.model,
    setOntology: (model: Model) => {
      state.model = model;
    },
  };
}

const statusOf = (mappings: MappingDescription[], target: string) => mappings.find((m) => m.mapping.targets.some((r) => Object.values(r).includes(target)))!.status;

const removalOfAttribute = (proposals: SynchronizationProposal[]) => proposals.filter((p) => p.kind === 'remove');

describe('the traceability report', () => {
  it('calls every mapping of a fresh derivation current, un-customised, and says what is covered', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    const report = await h.traceability.report({ model });
    expect(report.mappings).toHaveLength(17);
    expect(report.mappings.every((m) => m.status === 'current' && !m.customised)).toBe(true);
    expect(report.coverage.scope).toBe(8);
    expect(report.coverage.unrepresented).toEqual([]);
    expect(report.coverage.counts).toEqual({ elements: 17, sourced: 17 });
    expect(report.coverage.unsourced).toEqual([]);
    // A synchronization over an ontology that has not moved offers nothing.
    const sync = await h.traceability.synchronize({ model });
    expect(sync.proposals).toEqual([]);
  });

  it('marks a target the user changed customised, and leaves the mapping current', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    const film = h.ldm(model).entities.find((e) => e.name === 'Film')!;
    const attribute = film.attributes.find((a) => a.name === 'Release date')!;
    attribute.optional = false;
    const report = await h.traceability.report({ model });
    const described = report.mappings.find((m) => m.mapping.targets.some((r) => 'attribute' in r && r.attribute === attribute.id))!;
    expect(described.customised).toBe(true);
    expect(described.status).toBe('current');
  });
});

describe('impact and synchronization when a data property is removed', () => {
  it('lists exactly the attributes mapped from it, in each of two LDMs, and proposes removing them', async () => {
    const h = harness();
    const first = await h.derive('Film LDM');
    const second = await h.derive('Cinema LDM', lower);
    const release = h.ldm(first).entities.find((e) => e.name === 'Film')!.attributes.find((a) => a.name === 'Release date')!;
    const releaseLower = h.ldm(second).entities.find((e) => e.name === 'film')!.attributes.find((a) => a.name === 'release_date')!;
    const attributeCount = h.ldm(first).entities.flatMap((e) => e.attributes).length;

    h.removeProperty('Release date');

    for (const [model, expected] of [
      [first, release.id],
      [second, releaseLower.id],
    ] as const) {
      const report = await h.traceability.impact({ model });
      const removed = report.items.filter((i) => i.kind === 'source-removed');
      expect(removed).toHaveLength(1);
      expect(removed[0].target).toEqual({ attribute: expected });
      expect(removed[0].changed?.removed.length).toBeGreaterThan(0);
      expect(statusOf(report.mappings, expected)).toBe('broken');
      // The other attribute, and everything else, still holds.
      expect(report.mappings.filter((m) => m.status !== 'current' && m.status !== 'broken')).toEqual([]);
      expect(report.items.filter((i) => i.kind === 'not-represented')).toEqual([]);

      const sync = await h.traceability.synchronize({ model });
      const removals = removalOfAttribute(sync.proposals);
      expect(removals).toHaveLength(1);
      expect(removals[0].customised).toBe(false);
      expect(removals[0].elements).toEqual([expected === release.id ? 'Film.Release date' : 'film.release_date']);
      expect(removals[0].changes.some((c) => c.op === 'remove' && c.element.kind === 'attribute' && c.element.attribute.id === expected)).toBe(true);
    }
    expect(h.ldm(first).entities.flatMap((e) => e.attributes)).toHaveLength(attributeCount);
  });

  it('applies accepted removals as one step of the LDM history and never writes the ontology', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    h.removeProperty('Running time');
    const ontologyBefore = { terms: structuredClone(h.current().terms), props: structuredClone(h.current().props), relations: structuredClone(h.current().relations) };
    const sync = await h.traceability.synchronize({ model });
    const removals = removalOfAttribute(sync.proposals);
    expect(removals).toHaveLength(1);
    const revision = h.ldm(model).revision;
    const commits = h.commits();
    const applied = await h.traceability.apply({ result: sync, accepted: removals.map((p) => p.id) });
    expect(applied.applied).toBe(1);
    expect(h.commits()).toBe(commits + 1);
    expect(h.ldm(model).revision).toBe(applied.revision);
    expect(h.ldm(model).revision).not.toBe(revision);
    expect(h.ldm(model).entities.find((e) => e.name === 'Film')!.attributes.map((a) => a.name)).toEqual(['Release date']);
    expect({ terms: h.current().terms, props: h.current().props, relations: h.current().relations }).toEqual(ontologyBefore);
    // The removal was one change set: attribute and its mapping went together.
    expect(h.ldm(model).mappings.some((m) => m.targets.some((r) => 'attribute' in r && h.ldm(model).entities.every((e) => e.attributes.every((a) => a.id !== r.attribute))))).toBe(false);
  });

  it('offers a customised attribute, never chooses or changes it by default, and accepts it only when asked', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    const film = h.ldm(model).entities.find((e) => e.name === 'Film')!;
    const attribute = film.attributes.find((a) => a.name === 'Release date')!;
    attribute.name = 'Released';
    attribute.optional = false;
    h.removeProperty('Release date');
    const sync = await h.traceability.synchronize({ model });
    const removal = removalOfAttribute(sync.proposals)[0];
    expect(removal.customised).toBe(true);
    // Not accepted: the LDM is exactly where it was.
    const unchanged = await h.traceability.apply({ result: sync, accepted: [] });
    expect(unchanged.applied).toBe(0);
    expect(h.ldm(model).entities.find((e) => e.name === 'Film')!.attributes.find((a) => a.id === attribute.id)?.name).toBe('Released');
    // Dismissed, it is not offered again while the ontology says what it says.
    const dismissed = await h.traceability.synchronize({ model, dismissed: [removal.fingerprint] });
    expect(removalOfAttribute(dismissed.proposals)).toEqual([]);
    // Accepted, it is one undoable step the user chose.
    const commits = h.commits();
    const applied = await h.traceability.apply({ result: sync, accepted: [removal.id] });
    expect(applied.applied).toBe(1);
    expect(h.commits()).toBe(commits + 1);
    expect(h.ldm(model).entities.find((e) => e.name === 'Film')!.attributes.some((a) => a.id === attribute.id)).toBe(false);
  });
});

describe('impact of other ontology changes', () => {
  it('reports a rename and offers the new name as an update, leaving the ontology to the user', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    const film = h.current().terms.find((t) => t.name === 'Film')!;
    film.name = 'Movie';
    const report = await h.traceability.impact({ model });
    const renames = report.items.filter((i) => i.kind === 'renamed');
    expect(renames.length).toBeGreaterThanOrEqual(1);
    expect(renames.some((i) => i.title.includes('Movie'))).toBe(true);
    const entity = h.ldm(model).entities.find((e) => e.name === 'Film')!;
    expect(statusOf(report.mappings, entity.id)).toBe('current');

    const sync = await h.traceability.synchronize({ model });
    const update = sync.proposals.find((p) => p.kind === 'update' && p.elements.includes('Film'));
    expect(update).toBeDefined();
    expect(update!.customised).toBe(false);
    expect(update!.changes.some((c) => c.op === 'update' && 'entity' in c.target && c.target.entity === entity.id && c.after.name === 'Movie')).toBe(true);
    await h.traceability.apply({ result: sync, accepted: [update!.id] });
    expect(h.ldm(model).entities.find((e) => e.id === entity.id)!.name).toBe('Movie');
    expect(h.current().terms.find((t) => t.id === film.id)!.name).toBe('Movie');
  });

  it('reports a changed datatype as a type change and offers the attribute’s new type', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    const running = h.current().terms.find((t) => t.name === 'Running time')!;
    running.ranges = running.ranges!.map((a) => ({ ...a, range: { type: 'Datatype', iri: 'http://www.w3.org/2001/XMLSchema#decimal' } }));
    const report = await h.traceability.impact({ model });
    expect(report.items.some((i) => i.kind === 'type-changed')).toBe(true);
    const attribute = h.ldm(model).entities.find((e) => e.name === 'Film')!.attributes.find((a) => a.name === 'Running time')!;
    expect(statusOf(report.mappings, attribute.id)).toBe('stale');
    const sync = await h.traceability.synchronize({ model });
    const update = sync.proposals.find((p) => p.kind === 'update' && p.elements.includes('Film.Running time'))!;
    expect(update).toBeDefined();
    expect(update.changes.some((c) => c.op === 'update' && 'attribute' in c.target && c.target.attribute === attribute.id && JSON.stringify(c.after.type) === JSON.stringify({ base: 'decimal' }))).toBe(true);
    await h.traceability.apply({ result: sync, accepted: [update.id] });
    expect(h.ldm(model).entities.find((e) => e.name === 'Film')!.attributes.find((a) => a.id === attribute.id)!.type).toEqual({ base: 'decimal' });
    // One synchronization puts the mapping back to current.
    const after = await h.traceability.report({ model });
    expect(statusOf(after.mappings, attribute.id)).toBe('current');
  });

  it('compares two saved versions, naming them, and offers no synchronization for the past', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    h.versions.set('v1', { model: structuredClone(h.current()), name: 'Before the change' });
    h.removeProperty('Running time');
    h.versions.set('v2', { model: structuredClone(h.current()), name: 'After the change' });
    const report = await h.traceability.impact({ model, between: { from: { version: 'v1' }, to: { version: 'v2' } } });
    expect(report.compared).toEqual({ from: 'Before the change', to: 'After the change' });
    expect(report.items.filter((i) => i.kind === 'source-removed')).toHaveLength(1);
    // Between two versions there is no proposal to apply.
    expect(report.items.some((i) => i.kind === 'source-removed')).toBe(true);
  });
});

describe('hand-made mappings and tracing', () => {
  it('maps an element by hand, reads its status, edits it, and removes it without removing the element', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    const filmIri = h.iri('Film');
    const studioIri = h.iri('Studio');
    const { edit } = h;
    const added = await edit.apply({
      model,
      baseRevision: h.ldm(model).revision,
      changes: [{ op: 'add', element: { kind: 'entity', entity: { id: 'e-hand', name: 'Production company', definition: 'Who makes a film.', attributes: [], keys: [] } } }],
      summary: 'Added an entity.',
    });
    const made = await h.traceability.addMapping({ model, sources: [{ iri: filmIri }, { iri: studioIri }], targets: [{ entity: 'e-hand' }], strategy: 'two classes → one entity', rationale: 'A production company is both a studio and a film’s maker.' });
    expect(made.revision).not.toBe(added.revision);
    let report = await h.traceability.report({ model });
    let described = report.mappings.find((m) => m.mapping.id === made.mapping)!;
    expect(described.status).toBe('current');
    expect(described.mapping.made.by).toBe('hand');
    expect(described.sources.map((s) => s.name).sort()).toEqual(['Film', 'Studio']);
    expect(report.coverage.unsourced).toEqual([]);
    expect(report.coverage.counts).toEqual({ elements: 18, sourced: 18 });

    // Trace from the element back to its sources, and from the ontology entity to every target.
    const traced = await h.traceability.trace({ model, element: { entity: 'e-hand' } });
    expect(traced.mappings.map((m) => m.mapping.id)).toEqual([made.mapping]);
    expect(traced.sources.map((s) => s.iri).sort()).toEqual([filmIri, studioIri].sort());
    expect(traced.sources.every((s) => s.axioms.length > 0)).toBe(true);
    const fromIri = await h.traceability.trace({ iri: studioIri });
    expect(fromIri.mappings.some((m) => m.mapping.id === made.mapping)).toBe(true);
    expect(fromIri.mappings.some((m) => m.model === model && m.targets.some((t) => 'entity' in t.ref && t.ref.entity !== 'e-hand'))).toBe(true);

    // Changing what the mapping made marks it customised.
    h.ldm(model).entities.find((e) => e.id === 'e-hand')!.name = 'Maker';
    report = await h.traceability.report({ model });
    described = report.mappings.find((m) => m.mapping.id === made.mapping)!;
    expect(described.customised).toBe(true);

    await h.traceability.editMapping({ model, mapping: made.mapping, sources: [{ iri: studioIri }], targets: [{ entity: 'e-hand' }], strategy: 'class → entity', rationale: 'A maker is a studio.' });
    report = await h.traceability.report({ model });
    described = report.mappings.find((m) => m.mapping.id === made.mapping)!;
    expect(described.sources.map((s) => s.iri)).toEqual([studioIri]);
    expect(described.customised).toBe(false);

    await h.traceability.removeMapping({ model, mapping: made.mapping });
    expect(h.ldm(model).entities.some((e) => e.id === 'e-hand')).toBe(true);
    report = await h.traceability.report({ model });
    expect(report.coverage.unsourced).toContainEqual({ ref: { entity: 'e-hand' }, name: 'Maker' });
  });

  it('refuses a mapping to an element that is not there, and a source the ontology does not have', async () => {
    const h = harness();
    const model = await h.derive('Film LDM');
    await expect(h.traceability.addMapping({ model, sources: [{ iri: h.iri('Film') }], targets: [{ entity: 'nope' }], strategy: '', rationale: '' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(h.traceability.addMapping({ model, sources: [{ iri: 'http://example.org/nothing' }], targets: [{ entity: h.ldm(model).entities[0].id }], strategy: '', rationale: '' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
