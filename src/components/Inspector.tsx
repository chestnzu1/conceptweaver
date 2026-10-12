import { useStore } from '../model/store';
import { useMemo, useState } from 'react';
import { baseIriOf } from '../model/iri';
import { DATATYPES, QUANTIFIERS, type Quantifier, isLang, kindLabel, REL_KINDS, relLabel, TYPE_CHOICES, typeChoice, type Relation, type ModelMode, type RelKind, type Term } from '../model/types';
import { inferredRestrictions, NOT_INFERRED, type RestrictionSource } from '../model/inferred';
import { hasCardinality, isInstanceOf, nextSpec, offeredChoices, relChoice, restrictionSpecs, specsPatch, type RelChoice, CHARACTERISTICS, dataDomain, findProp, fitsIn, objectProperties, propKey, restrictionsOf, type PropView } from '../model/props';
import { activeProps, automaticMeaning, resolveModel } from '../model/vocab';
import { Swatches } from './ContextMenu';
import { CommitInput, CommitTextarea } from './fields';
import { SuperclassEditor } from './Iri';
import { AnonymousExpressions, CharacteristicWarnings, ClassProperties, EditorHead, IndividualAssertions, InferredSupers, IriDetails, LinkEditor, PropLinks, Section } from './EntityEditor';
import { Metadata } from './Metadata';
import { TermChips } from './TermChips';

export function Inspector() {
  const model = useStore((s) => s.model);
  const sel = useStore((s) => s.sel);
  const terms = model.terms.filter((t) => sel.terms.includes(t.id));
  const rels = model.relations.filter((r) => sel.rels.includes(r.id));
  const selProp = useStore((s) => s.selProp);
  const prop = selProp && model.mode !== 'skos' ? findProp(model, selProp) : undefined;
  const wide = useStore((s) => s.editorWide);

  let body;
  if (prop && !terms.length && !rels.length) body = <ObjectPropertyPanel key={prop.key} prop={prop} />;
  else if (terms.length === 1 && !rels.length) body = <TermPanel key={terms[0].id} term={terms[0]} />;
  else if (rels.length === 1 && !terms.length) body = <RelationPanel key={rels[0].id} rel={rels[0]} />;
  else if (terms.length + rels.length > 1) body = <MultiPanel terms={terms} rels={rels} />;
  else body = <ModelPanel />;
  return <aside className={'panel inspector' + (wide ? ' wide' : '')}>{body}</aside>;
}

/** Says that the entity belongs to another ontology, and what that means for editing it here. */
function ExternalNote({ id }: { id: string }) {
  const ref = useStore((s) => s.model.externals.find((e) => e.id === id));
  const st = useStore.getState;
  return (
    <p className="external-note">
      Defined in{' '}
      {ref ? (
        <button
          className="link"
          onClick={() => {
            st().setExt({ tab: 'library', selected: ref.id });
            st().setView('align');
          }}
        >
          {ref.name}
        </button>
      ) : (
        'an ontology that is not in the library'
      )}
      , and referred to here under its own IRI. Its name and definition are that ontology’s and are not exported from here; whatever you state about it below is an axiom of your ontology.
    </p>
  );
}

function ModelPanel() {
  const model = useStore((s) => s.model);
  const apply = useStore((s) => s.apply);
  return (
    <>
      <h2>Model</h2>
      <label className="field">
        <span>Name</span>
        <CommitInput value={model.name} onCommit={(name) => apply((m) => ({ ...m, name: name.trim() || 'Untitled model' }))} />
      </label>
      <label className="field">
        <span>Description</span>
        <CommitTextarea rows={4} value={model.description} onCommit={(description) => apply((m) => ({ ...m, description }))} />
      </label>
      <div className="field">
        <span>Default namespace</span>
        <code className="ns-summary" title="New entities get their IRI in this namespace">
          {baseIriOf(model)}
        </code>
        <button className="btn small" onClick={() => useStore.getState().setDialog('settings')}>
          Ontology IRI and prefixes…
        </button>
      </div>
      <div className="field two">
        <label>
          <span>Model type</span>
          <select value={model.mode} onChange={(e) => useStore.getState().convertTo(e.target.value as ModelMode)}>
            <option value="skos">Concept scheme (SKOS)</option>
            <option value="ontology">Ontology (OWL)</option>
          </select>
        </label>
        <label style={{ flex: '0 0 84px' }}>
          <span>Language</span>
          <CommitInput
            value={model.lang}
            placeholder="e.g. en"
            title="Language of the names, descriptions and synonyms. Labels in other languages go in a term's metadata."
            onCommit={(v) => {
              const lang = v.trim().toLowerCase();
              if (lang && !isLang(lang)) return useStore.getState().notify(`“${v}” is not a language code. Use one like en, nl or zh.`);
              apply((m) => ({ ...m, lang }));
            }}
          />
        </label>
      </div>
      {model.mode === 'ontology' && (
        <label className="check">
          <input type="checkbox" checked={model.vocab.enabled} onChange={(e) => useStore.getState().setVocabEnabled(e.target.checked)} />
          <span>Use RDFS &amp; OWL properties</span>
        </label>
      )}
      <button className="btn small" onClick={() => useStore.getState().setView('vocab')}>
        {model.mode === 'skos' ? 'SKOS relations and conversion…' : 'Map relationships and convert…'}
      </button>
      <p className="stat">
        {model.terms.length} terms · {model.relations.length} relations
      </p>
      <h3>On the canvas</h3>
      <dl className="keys">
        <dt>Double-click</dt>
        <dd>Add a term, or rename one</dd>
        <dt>Drag the ⊕ handle</dt>
        <dd>Relate two terms</dd>
        <dt>Right-click</dt>
        <dd>Menu for anything</dd>
        <dt>Ctrl + drag</dt>
        <dd>Box-select</dd>
        <dt>Shift + click</dt>
        <dd>Add to selection</dd>
        <dt>Del</dt>
        <dd>Delete the selection</dd>
        <dt>Ctrl + Z / Y</dt>
        <dd>Undo / redo</dd>
      </dl>
    </>
  );
}

function TermPanel({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.updateTerm);
  const st = useStore.getState;
  const skos = model.mode === 'skos';
  const name = new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed']));
  const related = resolveModel(model).relations.filter((r) => r.from === term.id || r.to === term.id);

  const kind = skos ? 'Concept' : term.type === 'concept' ? 'Class' : term.type === 'property' ? 'Data property' : 'Individual';
  const other = (term.axioms ?? []).filter((x) => !x.startsWith('rdfs:subClassOf ') && !x.startsWith('owl:equivalentClass '));
  const annotations = (
    <Section id="annotations" title="Annotations" count={term.fields.length + (term.description ? 1 : 0) + term.synonyms.split(',').filter((x) => x.trim()).length}>
      <label className="field">
        <span>
          {skos ? 'Definition' : 'Description'} <code className="pred">skos:definition</code>
        </span>
        <CommitTextarea rows={5} value={term.description} placeholder="What does this term mean?" onCommit={(description) => update(term.id, { description })} />
      </label>
      <label className="field">
        <span>
          {skos ? 'Alternative labels' : 'Synonyms'} <code className="pred">skos:altLabel</code>
        </span>
        <CommitInput value={term.synonyms} placeholder="Comma-separated" onCommit={(synonyms) => update(term.id, { synonyms })} />
        {model.lang && <small>The name, description and synonyms are in “{model.lang}”. Add the same in other languages below, each with its language.</small>}
      </label>
      <Metadata title="Other annotations" fields={term.fields} onChange={(fields) => update(term.id, { fields })} />
    </Section>
  );

  return (
    <>
      <EditorHead kind={term.external !== undefined ? `External ${kind.toLowerCase()}` : kind} />
      {term.external !== undefined && <ExternalNote id={term.external} />}
      <label className="field">
        <span>
          {skos ? 'Preferred label' : 'Name'} <code className="pred">{skos ? 'skos:prefLabel' : 'rdfs:label'}</code>
        </span>
        <CommitInput value={term.name} onCommit={(v) => update(term.id, { name: v.trim() })} />
      </label>
      <IriDetails key={term.id} iri={term.iri} name={term.name} owner={{ term: term.id }} external={term.external !== undefined} />
      {/* A concept scheme only has concepts; the choice shows up just to fix a term that isn't one. */}
      {(!skos || term.type !== 'concept') && (
        <label className="field">
          <span>Type</span>
          <select value={typeChoice(term)} onChange={(e) => update(term.id, TYPE_CHOICES.find((c) => c.value === e.target.value)!.patch)}>
            {TYPE_CHOICES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {skos && term.type === 'concept' && (
        <div className="field">
          <span>Broader concepts</span>
          <SuperclassEditor term={term} />
        </div>
      )}

      {!skos && term.type === 'concept' && (
        <>
          <Section id="class-axioms" title="Class axioms">
            <div className="field">
              <span title="Explicitly stated superclasses. Ones that only follow from these are listed under Inferred superclasses.">
                Asserted superclasses <code className="pred">rdfs:subClassOf</code>
              </span>
              <SuperclassEditor term={term} />
              <AnonymousExpressions term={term} predicate="rdfs:subClassOf" />
            </div>
            <LinkEditor term={term} kind="equivalentClass" noun="equivalent class" label="Equivalent classes" hint="both classes have exactly the same members" />
            <AnonymousExpressions term={term} predicate="owl:equivalentClass" />
            <LinkEditor term={term} kind="disjointWith" noun="disjoint class" label="Disjoint classes" hint="nothing can belong to both" />
          </Section>
          <ClassRestrictions term={term} />
          <ClassProperties term={term} />
          <InferredSupers term={term} />
          <InferredRestrictionsPanel term={term} />
        </>
      )}

      {!skos && term.type === 'property' && (
        <Section id="property-axioms" title="Property axioms">
          <PropertyFields term={term} />
          <fieldset className="field checks">
            <legend>Characteristics</legend>
            <label className="check" title="Each thing has at most one value (owl:FunctionalProperty).">
              <input type="checkbox" checked={!!term.functional} onChange={(e) => update(term.id, { functional: e.target.checked || undefined })} />
              <span>Functional</span>
            </label>
          </fieldset>
          <div className="field">
            <span>
              Superproperties <code className="pred">rdfs:subPropertyOf</code>
            </span>
            <SuperclassEditor term={term} />
          </div>
          <LinkEditor term={term} kind="equivalentProperty" noun="equivalent property" label="Equivalent properties" />
          <LinkEditor term={term} kind="propertyDisjointWith" noun="disjoint property" label="Disjoint properties" />
        </Section>
      )}

      {!skos && term.type === 'instance' && (
        <>
          <Section id="individual-axioms" title="Individual axioms">
            <div className="field">
              <span title="The classes this individual is explicitly stated to be an instance of.">
                Asserted types <code className="pred">rdf:type</code>
              </span>
              <SuperclassEditor term={term} />
            </div>
            <LinkEditor term={term} kind="sameAs" noun="same individual" label="Same individuals" hint="two names for one and the same thing" />
            <LinkEditor term={term} kind="differentFrom" noun="different individual" label="Different individuals" hint="definitely not the same thing" />
          </Section>
          <IndividualAssertions term={term} />
          <InferredSupers term={term} />
        </>
      )}

      {other.length ? (
        <>
          <h3>Other asserted expressions ({other.length})</h3>
          <p className="muted">Kept exactly as written and exported with the entity.</p>
          <ul className="axioms">
            {other.map((a, i) => (
              <li key={i}>
                <code>{a}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {annotations}
      <div className="field">
        <span>Colour on the canvas</span>
        <Swatches value={term.color} onPick={(color) => update(term.id, { color })} />
      </div>

      <h3>Relations ({related.length})</h3>
      {related.length > 0 && (
        <div className="row wrap">
          <span className="muted">Highlight</span>
          <button className="btn small" title="Terms with a relation pointing to this one" onClick={() => st().showNeighbours([term.id], 'in')}>
            Incoming
          </button>
          <button className="btn small" title="Terms this one has a relation pointing to" onClick={() => st().showNeighbours([term.id], 'out')}>
            Outgoing
          </button>
          <button className="btn small" onClick={() => st().showNeighbours([term.id], 'both')}>
            Both
          </button>
        </div>
      )}
      {related.length === 0 && <p className="muted">None yet. Drag the ⊕ handle on the term to another term.</p>}
      <ul className="rel-list">
        {related.map((r) => (
          <li key={r.id}>
            <button onClick={() => st().select([], [r.id])} title="Open this relation">
              {r.from === term.id ? (
                <>
                  <em>{relLabel(r, skos, isInstanceOf(model, r)) || (skos ? 'related' : '→')}</em> {name.get(r.to)}
                </>
              ) : (
                <>
                  {name.get(r.from)} <em>{relLabel(r, skos, isInstanceOf(model, r)) || (skos ? 'related' : '→')}</em> this
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      <button className="btn danger" onClick={() => st().remove([term.id], [])}>
        Delete term
      </button>
    </>
  );
}

/** A data property: the classes that have it, its domain, and the type of its values. */
function PropertyFields({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const attached = model.relations.filter((r) => r.kind === 'property' && r.to === term.id);
  const domain = dataDomain(model, term);
  const name = (id: string) => model.terms.find((t) => t.id === id)?.name || 'Unnamed';
  const outside = domain.auto ? [] : attached.filter((r) => model.terms.find((t) => t.id === r.from)?.type === 'concept' && !fitsIn(model, r.from, domain.ids));
  return (
    <>
      <div className="field">
        <span>Attached to: the classes that have it</span>
        <TermChips
          ids={attached.map((r) => r.from)}
          placeholder="Attach to a class"
          of={term.name}
          empty="no class yet"
          add={(id) => st().addRelation({ from: id, to: term.id, kind: 'property' })}
          remove={(id) => st().remove([], attached.filter((r) => r.from === id).map((r) => r.id))}
        />
      </div>
      <div className="field">
        <span>
          Domain <code className="pred">rdfs:domain</code>
        </span>
        <TermChips
          ids={domain.ids}
          placeholder="Add a class to the domain"
          of={term.name}
          empty="not set: anything"
          add={(id) => st().updateTerm(term.id, { domain: [...domain.ids, id] })}
          remove={(id) => st().updateTerm(term.id, { domain: domain.ids.filter((x) => x !== id) })}
        />
        {domain.auto ? (
          <small>{domain.ids.length ? 'Follows the classes it is attached to. Add a class, for example a more general one, to set it yourself.' : 'Add a class to set it. A domain is not a requirement: it says what anything that has the property is.'}</small>
        ) : (
          <small>
            Set by you.{' '}
            <button className="link" onClick={() => st().updateTerm(term.id, { domain: undefined })}>
              Follow the attached classes again
            </button>
          </small>
        )}
        {outside.map((r) => (
          <small key={r.id} className="bad">
            ✗ {name(r.from)} has this property but is not {domain.ids.map(name).join(' or ')} or a kind of it.
          </small>
        ))}
        {!domain.auto && attached.length > 0 && !outside.length && <small className="good">✓ Every class that has it is inside the domain.</small>}
      </div>
      <label className="field">
        <span>
          Range: the type of its values <code className="pred">rdfs:range</code>
        </span>
        <select aria-label="Datatype" value={term.range ?? ''} onChange={(e) => st().updateTerm(term.id, { range: e.target.value || undefined })}>
          <option value="">Not set</option>
          {DATATYPES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id} ({d.label})
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/** Quantifier of one of a relationship's restrictions, with its number where one is needed. */
function QuantifierSelect({ rel, index = 0 }: { rel: Relation; index?: number }) {
  const update = useStore((s) => s.updateRelation);
  const specs = restrictionSpecs(rel);
  const q = specs[index]?.restriction ?? 'some';
  const counted = q === 'min' || q === 'max' || q === 'exactly';
  const set = (spec: (typeof specs)[number]) => update(rel.id, specsPatch(specs.map((s, i) => (i === index ? spec : s))));
  return (
    <span className="quant">
      <select
        aria-label="Quantifier"
        value={q}
        onChange={(e) => {
          const next = e.target.value as Quantifier;
          const n = next === 'min' || next === 'max' || next === 'exactly';
          set({ restriction: next, restrictionN: n ? (specs[index]?.restrictionN ?? 1) : undefined });
        }}
      >
        {QUANTIFIERS.map((x) => (
          <option key={x.id} value={x.id} title={x.about}>
            {x.id}
          </option>
        ))}
      </select>
      {counted && (
        <input
          type="number"
          min={0}
          aria-label="Number"
          value={specs[index]?.restrictionN ?? 1}
          onChange={(e) => set({ restriction: q, restrictionN: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
        />
      )}
    </span>
  );
}

/** A class described the OWL way: how its object and data properties restrict it. */
function ClassRestrictions({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const restrictions = restrictionsOf(model, term.id);
  const objProps = objectProperties(model);
  const dataProps = model.terms.filter((t) => t.type === 'property').sort((a, b) => a.name.localeCompare(b.name));
  const classes = model.terms.filter((t) => t.type === 'concept').sort((a, b) => a.name.localeCompare(b.name));
  const [prop, setProp] = useState('');
  const [target, setTarget] = useState('');
  const isData = prop.startsWith('d:');
  const add = () => {
    // A further restriction by a property the class already has towards the same target joins that relationship.
    const drawn = restrictions.find((r) => (isData ? r.data && r.rel.to === prop.slice(2) : !r.data && r.rel.to === target && propKey(r.rel.label) === prop.slice(2)))?.rel;
    const further = drawn && nextSpec(drawn);
    if (drawn) {
      if (further) st().updateRelation(drawn.id, specsPatch([...restrictionSpecs(drawn), further]));
      else st().notify('That relationship already states a restriction of every kind.');
    } else if (isData) st().addRelation({ from: term.id, to: prop.slice(2), kind: 'property' });
    else st().addRelation({ from: term.id, to: target, label: objProps.find((p) => p.key === prop.slice(2))!.name });
    setProp('');
    setTarget('');
  };
  // Takes one restriction away; the relationship goes with its last one.
  const removeOne = (rel: Relation, index: number) => {
    const specs = restrictionSpecs(rel);
    if (specs.length > 1) st().updateRelation(rel.id, specsPatch(specs.filter((_, i) => i !== index)));
    else st().remove([], [rel.id]);
  };
  return (
    <>
      <h3>Asserted restrictions ({restrictions.length})</h3>
      {restrictions.length === 0 && <p className="muted">None stated on this class. A restriction says what every member of the class has: “directs some Film”, “release date some date”.</p>}
      <ul className="restrictions">
        {restrictions.map((r) => (
          <li key={`${r.rel.id}:${r.index}`}>
            <button className="link" title="Show on the canvas" onClick={() => st().focusRelation(r.rel.id)}>
              {r.property}
            </button>
            <QuantifierSelect rel={r.rel} index={r.index} />
            <span className={r.data ? 'datatype' : ''}>{r.filler}</span>
            <button className="btn icon ghost" title="Remove this restriction" aria-label={`Remove ${r.text}`} onClick={() => removeOne(r.rel, r.index)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="restriction-add">
        <select aria-label="Property to restrict by" value={prop} onChange={(e) => setProp(e.target.value)}>
          <option value="">Add: choose a property…</option>
          <optgroup label="Object properties">
            {objProps.map((p) => (
              <option key={p.key} value={'o:' + p.key}>
                {p.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Data properties">
            {dataProps.map((p) => (
                <option key={p.id} value={'d:' + p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        </select>
        {prop && !isData && (
          <select aria-label="Class it points to" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">some… choose a class</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || 'Unnamed'}
              </option>
            ))}
          </select>
        )}
        {prop && (
          <button className="btn small primary" disabled={!isData && !target} onClick={add}>
            Add
          </button>
        )}
      </div>
    </>
  );
}

/** Where an inferred restriction comes from: the classes it is asserted on, each a link to that class. */
export function Sources({ sources }: { sources: RestrictionSource[] }) {
  const st = useStore.getState;
  return (
    <span className="sources">
      {sources.some((x) => !x.equivalent) ? 'Inherited from ' : 'From equivalent class '}
      {sources.map((x, i) => (
        <span key={x.id}>
          {i > 0 && ', '}
          <button className="link" title={`${x.because}\nOpen ${x.name}`} onClick={() => st().select([x.id])}>
            {x.name}
          </button>
          {x.equivalent && sources.some((y) => !y.equivalent) && ' (equivalent)'}
        </span>
      ))}
    </span>
  );
}

/**
 * Restrictions that hold for the class because the reasoner entails it to be a kind of a class
 * they are asserted on. Read-only: they are worked out from the model each time, never stored in it.
 */
function InferredRestrictionsPanel({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const inferred = useMemo(() => inferredRestrictions(model, term.id), [model, term.id]);
  const count = inferred.restrictions.length + inferred.expressions.length;
  const [open, setOpen] = useState(true);
  return (
    <>
      <h3>
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Inferred restrictions ({inferred.status === 'inconsistent' ? '—' : count})
        </button>
      </h3>
      {open && (
        <>
          {inferred.status === 'inconsistent' && (
            <p className="bad" role="status">
              The reasoner finds the ontology inconsistent, so nothing reliable can be inferred. See the Validation tab.
            </p>
          )}
          {inferred.status === 'unsatisfiable' && (
            <p className="bad" role="status">
              This class can never have members (see Validation), so anything at all holds of it. The restrictions below are the inherited ones.
            </p>
          )}
          {inferred.status === 'partial' && <p className="muted">The reasoner stopped early on this large model; there may be more.</p>}
          {inferred.status !== 'inconsistent' && count === 0 && <p className="muted">None. Nothing is inherited from a superclass or an equivalent class.</p>}
          <ul className="restrictions inferred">
            {inferred.restrictions.map(({ key, restriction: r, sources }) => (
              <li key={key}>
                <span className="what">
                  <span className="prop">{r.property}</span> <em>{r.quantifier}{r.n !== undefined ? ' ' + r.n : ''}</em> <span className={r.data ? 'datatype' : ''}>{r.filler}</span>
                </span>
                <Sources sources={sources} />
              </li>
            ))}
            {inferred.expressions.map(({ key, text, sources }) => (
              <li key={key}>
                <code className="what">{text}</code>
                <Sources sources={sources} />
              </li>
            ))}
          </ul>
          <details className="not-inferred">
            <summary>What is not inferred</summary>
            <p>These follow from the ontology by reasoning over its hierarchy and equivalences, kept up to date as you edit. The reasoner does not work out:</p>
            <ul>
              {NOT_INFERRED.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </>
  );
}

/** An object property: declared once, used by every relationship that carries its name. */
function ObjectPropertyPanel({ prop }: { prop: PropView }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const type = (id: string) => model.terms.find((t) => t.id === id)?.type;
  const name = new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed']));
  const set = (patch: Parameters<ReturnType<typeof useStore.getState>['updateProp']>[1]) => st().updateProp(prop.key, patch);
  const side = (which: 'domain' | 'range') => {
    const ids = prop[which];
    const auto = which === 'domain' ? prop.domainAuto : prop.rangeAuto;
    return (
      <div className="field">
        <span>
          {which === 'domain' ? 'Domain: what can have it' : 'Range: what it points to'} <code className="pred">rdfs:{which}</code>
        </span>
        <TermChips ids={ids} placeholder={`Add a class to the ${which}`} of={prop.name} empty="not set: anything" add={(id) => set({ [which]: [...ids, id] })} remove={(id) => set({ [which]: ids.filter((x) => x !== id) })} />
        {auto ? (
          <small>{ids.length ? 'Follows the classes it is used between. Add a class, for example a more general one, to set it yourself.' : 'Add a class to set it.'}</small>
        ) : (
          <small>
            Set by you.{' '}
            <button className="link" onClick={() => set({ [which]: undefined })}>
              Follow the relationships again
            </button>
          </small>
        )}
      </div>
    );
  };
  return (
    <>
      <EditorHead kind={prop.external !== undefined ? 'External object property' : 'Object property'} />
      {prop.external !== undefined && <ExternalNote id={prop.external} />}
      <label className="field">
        <span>
          Name <code className="pred">rdfs:label</code>
        </span>
        <CommitInput value={prop.name} onCommit={(v) => st().renameProp(prop.key, v)} />
        <small>Renaming it renames every relationship that uses it.</small>
      </label>
      <IriDetails key={prop.key} iri={prop.iri} name={prop.name} owner={{ prop: prop.key }} external={prop.external !== undefined} />
      <Section id="property-axioms" title="Property axioms">
        {side('domain')}
        {side('range')}
      <fieldset className="field checks">
        <legend>Characteristics</legend>
        {CHARACTERISTICS.map((c) => (
          <label key={c.id} className="check" title={c.about}>
            <input
              type="checkbox"
              checked={prop.chars.includes(c.id)}
              onChange={(e) => set({ chars: e.target.checked ? [...prop.chars, c.id] : prop.chars.filter((x) => x !== c.id) })}
            />
            <span>{c.label}</span>
          </label>
        ))}
        <CharacteristicWarnings chars={prop.chars} />
      </fieldset>
        <PropLinks prop={prop} />
      </Section>
      <Section id="annotations" title="Annotations" count={prop.fields.length + (prop.description ? 1 : 0)}>
        <label className="field">
          <span>
            Description <code className="pred">skos:definition</code>
          </span>
          <CommitTextarea rows={3} value={prop.description} placeholder="What does this property mean?" onCommit={(description) => set({ description })} />
        </label>
        <Metadata title="Other annotations" fields={prop.fields} onChange={(fields) => set({ fields })} />
      </Section>

      <h3>Used by ({prop.rels.length})</h3>
      {prop.rels.length === 0 && <p className="muted">Nothing uses it yet. Add a restriction to a class, or on the canvas drag from one term to another and pick this name as the label.</p>}
      <ul className="rel-list">
        {prop.rels.map((r) => {
          // A class is held to a domain or range set by hand: it has to be one of those classes or a kind of one.
          const classLevel = type(r.from) === 'concept' && type(r.to) === 'concept';
          const badFrom = classLevel && !prop.domainAuto && prop.domain.length > 0 && !fitsIn(model, r.from, prop.domain);
          const badTo = classLevel && !prop.rangeAuto && prop.range.length > 0 && !fitsIn(model, r.to, prop.range);
          const judged = classLevel && (!prop.domainAuto || !prop.rangeAuto);
          return (
            <li key={r.id}>
              <button onClick={() => st().focusRelation(r.id)} title="Show on the canvas">
                {judged && <span className={badFrom || badTo ? 'bad' : 'good'}>{badFrom || badTo ? '✗ ' : '✓ '}</span>}
                {name.get(r.from)} <em>{classLevel ? restrictionSpecs(r).map((s) => s.restriction + (s.restrictionN !== undefined ? ' ' + s.restrictionN : '')).join(', ') : '→'}</em> {name.get(r.to)}
                {badFrom && <small className="bad"> {name.get(r.from)} is not a kind of {prop.domain.map((id) => name.get(id)).join(' or ')}</small>}
                {badTo && <small className="bad"> {name.get(r.to)} is not a kind of {prop.range.map((id) => name.get(id)).join(' or ')}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      {prop.rels.length > 0 && (
        <button
          className="btn small"
          onClick={() => {
            st().setHighlight([...prop.rels.map((r) => r.id), ...prop.rels.flatMap((r) => [r.from, r.to])], `Uses of “${prop.name}” (${prop.rels.length})`);
            st().setView('graph');
          }}
        >
          Highlight on the canvas
        </button>
      )}
      <button className="btn danger" onClick={() => st().deleteProp(prop.key)}>
        {prop.rels.length ? `Delete property and its ${prop.rels.length} relationship${prop.rels.length === 1 ? '' : 's'}` : 'Delete property'}
      </button>
    </>
  );
}

function RelationPanel({ rel }: { rel: Relation }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.updateRelation);
  const st = useStore.getState;
  const sorted = [...model.terms].sort((a, b) => a.name.localeCompare(b.name));
  const skos = model.mode === 'skos';
  const props = activeProps(model);
  const own = props.some((p) => p.id === rel.predicate) ? rel.predicate! : '';
  // In an ontology a relationship between two terms is a use of an object property.
  // In an ontology a relationship either uses a declared object property or is still just a relationship.
  const usesProp = !skos && rel.kind === 'association' && !own && !model.vocab.map[rel.label.trim().toLowerCase()];
  const objProps = usesProp ? objectProperties(model) : [];
  const prop = usesProp ? objProps.find((p) => p.key === propKey(rel.label)) : undefined;
  // Every restriction this relationship puts on its class: one or several.
  const stated = !skos ? restrictionsOf(model, rel.from).filter((r) => r.rel.id === rel.id) : [];
  const restriction = stated[0];
  const further = nextSpec(rel);
  // A class membership: it points from an individual to a class and cannot be turned around.
  const instanceOf = isInstanceOf(model, rel);

  const names = (ids: string[]) => ids.map((id) => model.terms.find((t) => t.id === id)?.name).join(', ') || 'anything';
  const endpoint = (side: 'from' | 'to') => (
    <label className="field">
      <span>{side === 'from' ? 'From' : 'To'}</span>
      <select value={rel[side]} onChange={(e) => update(rel.id, { [side]: e.target.value })}>
        {sorted.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name || 'Unnamed'}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <h2>{restriction ? 'Restriction' : instanceOf ? 'Class membership' : usesProp ? 'Relationship' : 'Relation'}</h2>
      {endpoint('from')}
      <label className="field">
        <span>{prop ? 'Object property' : usesProp ? 'Label, or an object property' : 'Label'}</span>
        <CommitInput
          list={usesProp ? 'panel-object-props' : undefined}
          value={rel.label}
          placeholder={rel.kind === 'association' ? (skos ? 'empty means related' : 'pick one or type a new name') : relLabel({ ...rel, label: '' }, skos, instanceOf)}
          onCommit={(v) => update(rel.id, { label: v.trim() })}
        />
        {usesProp && (
          <datalist id="panel-object-props">
            {objProps.map((p) => (
              <option key={p.key} value={p.name} />
            ))}
          </datalist>
        )}
        {prop && (
          <small>
            Domain: {names(prop.domain)}. Range: {names(prop.range)}.{' '}
            <button className="link" onClick={() => st().selectProp(prop.key)}>
              Edit the property
            </button>
          </small>
        )}
        {usesProp && !prop && (
          <small>
            A plain relationship: not an object property.{' '}
            <button className="link" onClick={() => st().setRelChoice(rel.id, 'object')}>
              Make it a use of the object property “{rel.label.trim() || 'related to'}”
            </button>
          </small>
        )}
      </label>
      {endpoint('to')}
      <button className="btn small" disabled={instanceOf} title={instanceOf ? 'A class membership always points from the individual to the class' : undefined} onClick={() => st().reverseRelation(rel.id)}>
        Reverse direction
      </button>
      <label className="field">
        <span>Kind</span>
        {skos ? (
          <select value={rel.kind} onChange={(e) => update(rel.id, { kind: e.target.value as RelKind })}>
            {REL_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {kindLabel(k.value, skos)}
              </option>
            ))}
          </select>
        ) : (
          <select value={relChoice(model, rel)} onChange={(e) => st().setRelChoice(rel.id, e.target.value as RelChoice)}>
            {offeredChoices(model, rel).map((k) => (
              <option key={k.value} value={k.value} disabled={!!k.disabled} title={k.disabled}>
                {k.label}
              </option>
            ))}
          </select>
        )}
        {instanceOf && (
          <small>
            {names([rel.from])} is a member of the class {names([rel.to])}. Exports as <code className="pred">rdf:type</code>.
          </small>
        )}
      </label>
      {props.length > 0 && (
        <label className="field">
          <span>Standard property</span>
          <select value={own} onChange={(e) => update(rel.id, { predicate: e.target.value || undefined })}>
            <option value="">Automatic</option>
            {props.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
          <small>
            {own
              ? `Exports as ${own}; the kind above is ignored.`
              : `Exports as ${automaticMeaning(model, rel)}.`}
          </small>
        </label>
      )}
      {restriction && (
        <div className="field">
          {/* A restriction is on a property: the data property, or the object property, the class has. */}
          <span>
            {stated.length > 1 ? 'Restrictions' : 'Restriction'} on {restriction.property}
          </span>
          <ul className="restrictions">
            {stated.map((r) => (
              <li key={r.index}>
                <QuantifierSelect rel={rel} index={r.index} />
                <span className={r.data ? 'datatype' : ''}>{r.filler}</span>
                {stated.length > 1 && (
                  <button className="btn icon ghost" title="Remove this restriction" aria-label={`Remove ${r.text}`} onClick={() => update(rel.id, specsPatch(restrictionSpecs(rel).filter((_, i) => i !== r.index)))}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
          {further && (
            <button className="btn small" title="State a further restriction with the same property and target" onClick={() => update(rel.id, specsPatch([...restrictionSpecs(rel), further]))}>
              Add another restriction
            </button>
          )}
          <small>
            Every {names([rel.from])}:{' '}
            {stated.map((r, i) => (
              <span key={r.index}>
                {i > 0 && ', and '}
                <strong>{r.text}</strong>
              </span>
            ))}
            .
          </small>
        </div>
      )}

      {/* Cardinalities are a plain relationship's; the other kinds say "how many" with restrictions, or not at all. */}
      {hasCardinality(model, rel) && (
        <div className="field two">
          <label>
            <span>From cardinality</span>
            <CommitInput value={rel.fromCard} placeholder="1..*" onCommit={(v) => update(rel.id, { fromCard: v.trim() })} />
          </label>
          <label>
            <span>To cardinality</span>
            <CommitInput value={rel.toCard} placeholder="0..1" onCommit={(v) => update(rel.id, { toCard: v.trim() })} />
          </label>
        </div>
      )}
      <label className="field">
        <span>Description</span>
        <CommitTextarea rows={4} value={rel.description} onCommit={(description) => update(rel.id, { description })} />
      </label>
      <button className="btn danger" onClick={() => st().remove([], [rel.id])}>
        Delete relation
      </button>
    </>
  );
}

function MultiPanel({ terms, rels }: { terms: Term[]; rels: Relation[] }) {
  const st = useStore.getState;
  const ids = terms.map((t) => t.id);
  return (
    <>
      <h2>Selection</h2>
      <p className="stat">
        {terms.length} terms · {rels.length} relations
      </p>
      {terms.length > 0 && (
        <>
          <label className="field">
            <span>Set type</span>
            <select value="" onChange={(e) => e.target.value && st().updateTerms(ids, TYPE_CHOICES.find((c) => c.value === e.target.value)!.patch)}>
              <option value="">Choose…</option>
              {TYPE_CHOICES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Set colour</span>
            <Swatches onPick={(color) => st().updateTerms(ids, { color })} />
          </div>
        </>
      )}
      {terms.length > 0 && (
        <div className="row wrap">
          <span className="muted">Highlight</span>
          <button className="btn small" onClick={() => st().showNeighbours(ids, 'in')}>
            Incoming
          </button>
          <button className="btn small" onClick={() => st().showNeighbours(ids, 'out')}>
            Outgoing
          </button>
          <button className="btn small" onClick={() => st().showNeighbours(ids, 'both')}>
            Both
          </button>
        </div>
      )}
      {terms.length === 2 && (
        <button className="btn" onClick={() => st().showPath(ids[0], ids[1])}>
          Find path between them
        </button>
      )}
      <button className="btn danger" onClick={() => st().deleteSelection()}>
        Delete selection
      </button>
    </>
  );
}
