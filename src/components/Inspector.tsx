import { currentDl, useStore } from '../model/store';
import { typed } from '../model/relating';
import type { End } from '../model/reconnect';
import { SIDES, type Side } from '../model/geometry';
import { creditOf, entailmentsOf } from '../model/reasoning';
import { useMemo, useState } from 'react';
import { baseIriOf } from '../model/iri';
import { QUANTIFIERS, type Quantifier, isLang, relLabel, TYPE_CHOICES, typeChoice, type Relation, type Term } from '../model/types';
import { allowsView, configOf, MODEL_TYPE_LIST, supports, type EditorSection } from '../model/modelTypes';
import { inferredRestrictions, NOT_INFERRED, type RestrictionSource } from '../model/inferred';
import { propOf } from '../model/identity';
import { hasCardinality, isInstanceOf, nextSpec, offeredChoices, relChoice, restrictionSpecs, specsPatch, type RelChoice, CHARACTERISTICS, dataDomain, expressionsOf, findProp, fitsAxioms, objectProperties, restrictionsOf, type PropView } from '../model/props';
import { activeProps, automaticMeaning, resolveModel } from '../model/vocab';
import { Swatches } from './ContextMenu';
import { EndSelect } from './EndSelect';
import { useReasoning, WORKING } from './reasoning';
import { CommitInput, CommitTextarea } from './fields';
import { SuperclassEditor } from './Iri';
import { CharacteristicWarnings, ClassProperties, EditorHead, IndividualAssertions, InferredSupers, IriDetails, LinkEditor, PropLinks, Section } from './EntityEditor';
import { Metadata } from './Metadata';
import { TermChips } from './TermChips';
import { AxiomList } from './AxiomList';
import { ClassAxioms } from './ClassAxioms';
import { definedClasses } from '../model/axioms';
import { datatypeAxiom } from '../model/domains';
import { classesOfUnion, type ClassAxiom, type ClassExpression, type DataRange, type DataRangeAxiom } from '../model/expressions';
import { domainInWords, rangeInWords } from '../model/inWords';
import { allOf, classText, namingFor, type Naming } from '../model/manchester';
import { RangeEnumeration, RangeSelect } from './Datatypes';
import { ClassDefinition } from './Enumeration';
import { Disclosure, Icon } from './Icon';

export function Inspector() {
  const model = useStore((s) => s.model);
  const sel = useStore((s) => s.sel);
  const terms = model.terms.filter((t) => sel.terms.includes(t.id));
  const rels = model.relations.filter((r) => sel.rels.includes(r.id));
  const selProp = useStore((s) => s.selProp);
  const prop = selProp && model.mode !== 'skos' ? findProp(model, selProp) : undefined;
  const wide = useStore((s) => s.editorWide);
  const modelHidden = useStore((s) => s.modelPanelHidden);

  let body;
  if (prop && !terms.length && !rels.length) body = <ObjectPropertyPanel key={prop.id} prop={prop} />;
  else if (terms.length === 1 && !rels.length) body = <TermPanel key={terms[0].id} term={terms[0]} />;
  else if (rels.length === 1 && !terms.length) body = <RelationPanel key={rels[0].id} rel={rels[0]} />;
  else if (terms.length + rels.length > 1) body = <MultiPanel terms={terms} rels={rels} />;
  // Nothing is selected: the model's own details, unless they were folded away. Then only a strip
  // is left to bring them back, and the room goes to the canvas or the table.
  else if (modelHidden) {
    return (
      <aside className="panel inspector rail">
        <button className="rail-open" title="Show the model details" aria-label="Show the model details" aria-expanded={false} onClick={() => useStore.getState().setModelPanelHidden(false)}>
          <Icon name="panelOpen" />
          <span aria-hidden="true">Model</span>
        </button>
      </aside>
    );
  } else body = <ModelPanel />;
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
  const config = configOf(model);
  const apply = useStore((s) => s.apply);
  return (
    <>
      <div className="editor-head">
        <h2>Model</h2>
        <button className="btn icon ghost" title="Hide the model details. Selecting a term or a relationship still opens its editor." aria-label="Hide the model details" aria-expanded={true} onClick={() => useStore.getState().setModelPanelHidden(true)}>
          <Icon name="panelClose" />
        </button>
      </div>
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
        <div className="model-type-shown">
          <span>Model type</span>
          {/* Shown, not chosen: the type is settled when the model is made, and changes only by converting it. */}
          <strong>{config.label}</strong>
        </div>
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
      {supports(model, 'standardProperties') && (
        <label className="check">
          <input type="checkbox" checked={model.vocab.enabled} onChange={(e) => useStore.getState().setVocabEnabled(e.target.checked)} />
          <span>Use RDFS &amp; OWL properties</span>
        </label>
      )}
      {allowsView(model, 'vocab') && (
        <button className="btn small" onClick={() => useStore.getState().setView('vocab')}>
          Map relationships and convert…
        </button>
      )}
      {/* Where there is no Vocabulary view to convert from, the conversion is offered here. It is asked for and confirmed, never done in passing. */}
      {!allowsView(model, 'vocab') &&
        MODEL_TYPE_LIST.filter((t) => t.id !== model.mode).map((t) => (
          <button
            key={t.id}
            className="btn small"
            title={`Makes this model a ${t.label}: its concepts and relationships are restated in that type's terms. Undo brings it back.`}
            onClick={() => window.confirm(`Convert “${model.name}” to a ${t.label}?\n\nIts concepts and relationships are restated in that type's terms, and the app then offers that type's functions. Undo brings it back.`) && useStore.getState().convertTo(t.id)}
          >
            Convert to {t.label}…
          </button>
        ))}
      <p className="stat">
        {model.terms.length} terms · {model.relations.length} relations
      </p>
      <h3>On the canvas</h3>
      <dl className="keys">
        <dt>Double-click</dt>
        <dd>Add a term, or rename one</dd>
        <dt>Drag the ⊕ handle</dt>
        <dd>Relate two terms</dd>
        <dt>Drag a line's end</dt>
        <dd>Move where it meets its term, or reconnect it</dd>
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
  // Which parts of the editor there are is a matter of the type of model: a vocabulary's concept has its name, IRI and type here and nothing else.
  const config = configOf(model);
  const has = (section: EditorSection) => config.editorSections.includes(section);
  const name = new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed']));
  const related = resolveModel(model).relations.filter((r) => r.from === term.id || r.to === term.id);

  const kind = config.termType[term.type].label;
  const defined = term.type === 'concept' && definedClasses(model).has(term.id);
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
      <EditorHead kind={term.external !== undefined ? `External ${kind.toLowerCase()}` : defined ? `Defined ${kind.toLowerCase()}` : kind} />
      {term.external !== undefined && <ExternalNote id={term.external} />}
      <label className="field">
        <span>
          Name <code className="pred">{config.rdf.label}</code>
        </span>
        <CommitInput value={term.name} onCommit={(v) => update(term.id, { name: v.trim() })} />
      </label>
      <IriDetails key={term.id} iri={term.iri} name={term.name} owner={{ term: term.id }} external={term.external !== undefined} />
      {config.termTypes.length > 1 ? (
        <label className="field">
          <span>Type</span>
          <select value={typeChoice(term)} onChange={(e) => update(term.id, TYPE_CHOICES.find((c) => c.value === e.target.value)!.patch)}>
            {TYPE_CHOICES.filter((t) => config.termTypes.includes(t.value)).map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        // One kind of term: there is nothing to choose, only to say.
        <div className="field">
          <span>Type</span>
          <span className="type-fixed">
            {kind} <code className="pred">{config.termType[term.type].rdf}</code>
          </span>
        </div>
      )}

      {has('axioms') && term.type === 'concept' && (
        <>
          <ClassDefinition term={term} />
          <Section id="class-axioms" title="Class axioms">
            <div className="field">
              <span title="Explicitly stated superclasses. Ones that only follow from these are listed under Inferred superclasses.">
                Asserted superclasses <code className="pred">rdfs:subClassOf</code>
              </span>
              <SuperclassEditor term={term} />
            </div>
            <LinkEditor term={term} kind="equivalentClass" noun="equivalent class" label="Equivalent classes" hint="both classes have exactly the same members" />
            <LinkEditor term={term} kind="disjointWith" noun="disjoint class" label="Disjoint classes" hint="nothing can belong to both" />
          </Section>
          <ClassAxioms term={term} />
          {has('restrictions') && <ClassRestrictions term={term} />}
          <ClassProperties term={term} />
          {has('inferred') && <InferredSupers term={term} />}
          {has('inferred') && <InferredRestrictionsPanel term={term} />}
        </>
      )}

      {has('axioms') && term.type === 'property' && (
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

      {has('axioms') && term.type === 'instance' && (
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

      {has('annotations') && annotations}
      {has('colour') && (
        <div className="field">
          <span>Colour on the canvas</span>
          <Swatches value={term.color} onPick={(color) => update(term.id, { color })} />
        </div>
      )}

      {has('relations') && <h3>Relations ({related.length})</h3>}
      {has('relations') && related.length > 0 && (
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
      {has('relations') && related.length === 0 && <p className="muted">None yet. Drag the ⊕ handle on the term to another term.</p>}
      <ul className="rel-list">
        {(has('relations') ? related : []).map((r) => (
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
      {!has('annotations') && (
        <p className="muted">
          Its labels, definition, notes and ownership are under{' '}
          <button className="link" onClick={() => st().setView('table')}>
            Entities, Governance &amp; Metadata
          </button>
          .
        </p>
      )}
      <button className="btn danger" onClick={() => st().remove([term.id], [])}>
        Delete {kind.toLowerCase()}
      </button>
    </>
  );
}

/** Why a class is outside an axiom of a domain or range: "is not a kind of A or B", or "is not" the expression. */
const notIn = (e: ClassExpression, naming: Naming, name: (iri: string) => string) => {
  const named = classesOfUnion(e);
  return named ? `is not a kind of ${named.map(name).join(' or ')}` : `is not ${classText(e, naming)}`;
};

/** A data property: the classes that have it, its domain, and the type of its values. */
function PropertyFields({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const naming = useMemo(() => namingFor(model), [model]);
  const attached = model.relations.filter((r) => r.kind === 'property' && r.to === term.id);
  const domain = dataDomain(model, term);
  const name = (id: string) => model.terms.find((t) => t.id === id)?.name || 'Unnamed';
  const nameOfIri = (iri: string) => model.terms.find((t) => t.iri === iri)?.name || iri;
  const outside = domain.auto ? [] : attached.flatMap((r) => (model.terms.find((t) => t.id === r.from)?.type === 'concept' ? [{ r, out: fitsAxioms(model, r.from, domain.axioms).outside }] : [])).filter((x) => x.out);
  // The datatype is chosen in a list; whatever else the range states is listed under it.
  const chosen = datatypeAxiom(term);
  const others = (term.ranges ?? []).filter((a) => a !== chosen);
  const withOthers = (next: DataRangeAxiom[]) => {
    const all = term.ranges ?? [];
    const out = [...next];
    if (chosen) out.splice(Math.min(all.indexOf(chosen), out.length), 0, chosen);
    st().updateTerm(term.id, { ranges: out.length ? out : undefined });
  };
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
        <AxiomList
          kind="class"
          which="domain"
          of={term.name}
          axioms={domain.auto ? undefined : domain.axioms}
          follows={{ text: expressionsOf(model, [], true, domain.attached).map((e) => classText(e, naming)).join(''), what: 'the classes it is attached to' }}
          onChange={(axioms) => st().updateTerm(term.id, { domains: axioms as ClassAxiom[] })}
          onFollow={{ label: 'Follow the attached classes again', run: () => st().updateTerm(term.id, { domains: undefined }) }}
          inWords={(e) => domainInWords(term.name, true, e as ClassExpression, naming)}
        />
        {domain.auto && !domain.attached.length && <small>A domain is not a requirement: it says what anything that has the property is.</small>}
        {outside.map(({ r, out }) => (
          <small key={r.id} className="bad">
            ✗ {name(r.from)} has this property but {notIn(out!.expression, naming, nameOfIri)}.
          </small>
        ))}
        {!domain.auto && attached.length > 0 && !outside.length && attached.every((r) => fitsAxioms(model, r.from, domain.axioms).fits) && <small className="good">✓ Every class that has it is inside the domain.</small>}
      </div>
      <label className="field">
        <span>
          Range: the type of its values <code className="pred">rdfs:range</code>
        </span>
        <RangeSelect term={term} />
      </label>
      {/* A range that is a list of values is edited here, where it is chosen. */}
      <RangeEnumeration term={term} />
      <div className="field">
        <span>Further range axioms: each holds as well</span>
        <AxiomList kind="data" which="range" of={term.name} axioms={others} empty={chosen ? 'None besides the datatype.' : 'None.'} onChange={(next) => withOthers(next as DataRangeAxiom[])} inWords={(r) => rangeInWords(term.name, { data: r as DataRange }, naming)} />
      </div>
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
    const drawn = restrictions.find((r) => (isData ? r.data && r.rel.to === prop.slice(2) : !r.data && r.rel.to === target && r.rel.prop === prop.slice(2)))?.rel;
    const further = drawn && nextSpec(drawn);
    if (drawn) {
      if (further) st().updateRelation(drawn.id, specsPatch([...restrictionSpecs(drawn), further]));
      else st().notify('That relationship already states a restriction of every kind.');
    } else if (isData) st().addRelation({ from: term.id, to: prop.slice(2), kind: 'property' });
    else st().addRelation({ from: term.id, to: target, label: objProps.find((p) => p.id === prop.slice(2))!.name, prop: prop.slice(2) });
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
              <option key={p.id} value={'o:' + p.id}>
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
  const dl = useStore(currentDl);
  const reasoning = useReasoning();
  const inferred = useMemo(() => {
    if (!dl || dl.consistency !== 'consistent') return inferredRestrictions(model, reasoning, term.id);
    // Superclasses that only the OWL 2 DL reasoner finds are inherited from in the same way.
    const of = entailmentsOf(dl, term.id);
    return inferredRestrictions(model, reasoning, term.id, { unsatisfiable: of.unsatisfiable, supers: of.superclasses.map((x) => ({ id: x.superclass, asserted: x.asserted, equivalent: of.equivalents.includes(x.superclass), because: creditOf(dl), rels: [] })) });
  }, [model, reasoning, term.id, dl]);
  const count = inferred.restrictions.length + inferred.expressions.length;
  const [open, setOpen] = useState(true);
  return (
    <>
      <h3>
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Disclosure open={open} /> Inferred restrictions ({inferred.status === 'inconsistent' ? '—' : inferred.status === 'working' ? '…' : count})
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
          {inferred.status === 'working' && (
            <p className="muted" role="status">
              {WORKING}
            </p>
          )}
          {inferred.status !== 'inconsistent' && inferred.status !== 'working' && count === 0 && <p className="muted">None. Nothing is inherited from a superclass or an equivalent class.</p>}
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
  const naming = useMemo(() => namingFor(model), [model]);
  const nameOfIri = (iri: string) => model.terms.find((t) => t.iri === iri)?.name || iri;
  const set = (patch: Parameters<ReturnType<typeof useStore.getState>['updateProp']>[1]) => st().updateProp(prop.id, patch);
  const side = (which: 'domain' | 'range') => {
    const auto = which === 'domain' ? prop.domainAuto : prop.rangeAuto;
    const key = which === 'domain' ? 'domains' : 'ranges';
    const derived = expressionsOf(model, [], true, which === 'domain' ? prop.usedFrom : prop.usedTo).map((e) => classText(e, naming)).join('');
    return (
      <div className="field">
        <span>
          {which === 'domain' ? 'Domain: what can have it' : 'Range: what it points to'} <code className="pred">rdfs:{which}</code>
        </span>
        <AxiomList
          kind="class"
          which={which}
          of={prop.name}
          axioms={auto ? undefined : prop[key]}
          follows={{ text: derived, what: 'the classes it is used between' }}
          onChange={(axioms) => set({ [key]: axioms as ClassAxiom[] })}
          onFollow={{ label: 'Follow the relationships again', run: () => set({ [key]: undefined }) }}
          inWords={(e) => (which === 'domain' ? domainInWords(prop.name, false, e as ClassExpression, naming) : rangeInWords(prop.name, { class: e as ClassExpression }, naming))}
        />
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
        <CommitInput value={prop.name} onCommit={(v) => st().renameProp(prop.id, v)} />
        <small>Renaming it renames every relationship that uses it.</small>
      </label>
      <IriDetails key={prop.id} iri={prop.iri} name={prop.name} owner={{ prop: prop.id }} external={prop.external !== undefined} />
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
          // Each axiom stated holds: a use is outside where it is outside any one of them, and judged where all can be told.
          const from = classLevel && !prop.domainAuto ? fitsAxioms(model, r.from, prop.domains) : undefined;
          const to = classLevel && !prop.rangeAuto ? fitsAxioms(model, r.to, prop.ranges) : undefined;
          const badFrom = from?.outside;
          const badTo = to?.outside;
          const judged = (!!from || !!to) && (badFrom || badTo || ((from?.fits ?? true) && (to?.fits ?? true)));
          return (
            <li key={r.id}>
              <button onClick={() => st().focusRelation(r.id)} title="Show on the canvas">
                {judged && <span className={badFrom || badTo ? 'bad' : 'good'}>{badFrom || badTo ? '✗ ' : '✓ '}</span>}
                {name.get(r.from)} <em>{classLevel ? restrictionSpecs(r).map((s) => s.restriction + (s.restrictionN !== undefined ? ' ' + s.restrictionN : '')).join(', ') : '→'}</em> {name.get(r.to)}
                {badFrom && (
                  <small className="bad">
                    {' '}
                    {name.get(r.from)} {notIn(badFrom.expression, naming, nameOfIri)}
                  </small>
                )}
                {badTo && (
                  <small className="bad">
                    {' '}
                    {name.get(r.to)} {notIn(badTo.expression, naming, nameOfIri)}
                  </small>
                )}
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
      <button className="btn danger" onClick={() => st().deleteProp(prop.id)}>
        {prop.rels.length ? `Delete property and its ${prop.rels.length} relationship${prop.rels.length === 1 ? '' : 's'}` : 'Delete property'}
      </button>
    </>
  );
}

function RelationPanel({ rel }: { rel: Relation }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.updateRelation);
  const st = useStore.getState;
  const sorted = useMemo(() => [...model.terms].sort((a, b) => a.name.localeCompare(b.name)), [model.terms]);
  const skos = model.mode === 'skos';
  const props = activeProps(model);
  const own = props.some((p) => p.id === rel.predicate) ? rel.predicate! : '';
  // In an ontology a relationship between two terms is a use of an object property.
  // In an ontology a relationship either uses a declared object property or is still just a relationship.
  const usesProp = !skos && rel.kind === 'association' && !own && !model.vocab.map[rel.label.trim().toLowerCase()];
  const objProps = usesProp ? objectProperties(model) : [];
  const used = usesProp ? propOf(model, rel) : undefined;
  const prop = used ? objProps.find((p) => p.id === used.id) : undefined;
  // Every restriction this relationship puts on its class: one or several.
  const stated = !skos ? restrictionsOf(model, rel.from).filter((r) => r.rel.id === rel.id) : [];
  const restriction = stated[0];
  const further = nextSpec(rel);
  // A class membership: it points from an individual to a class and cannot be turned around.
  const instanceOf = isInstanceOf(model, rel);
  // In an ontology what the line joins, and its name, decide what it is. Where they leave one kind only, there is nothing to choose.
  const kinds = offeredChoices(model, rel);
  const auto = typed(model);
  const settled = auto && kinds.filter((k) => !k.disabled).length <= 1 && !kinds.some((k) => k.disabled);
  const fixedWay = instanceOf || (auto && rel.kind === 'property' && !own);
  const byName = auto && !own && kinds.some((k) => k.value === 'object' && !k.disabled) && kinds.some((k) => k.value === 'generalization' && !k.disabled);

  const names = (ids: string[]) => ids.map((id) => model.terms.find((t) => t.id === id)?.name).join(', ') || 'anything';
  // Moving an end is the edit dragging it on the canvas makes, by the same rule: what the relationship is stays.
  const endpoint = (side: 'from' | 'to') => (
    <label className="field">
      <span>{side === 'from' ? 'From' : 'To'}</span>
      <EndSelect rel={rel} end={side} sorted={sorted} current={model.terms.find((t) => t.id === rel[side])?.name || 'Unnamed'} />
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
          placeholder={byName ? '“is a”, or the name of an object property' : rel.kind === 'association' ? (skos ? 'empty means related' : 'pick one or type a new name') : relLabel({ ...rel, label: '' }, skos, instanceOf)}
          onCommit={(v) => update(rel.id, { label: v.trim() })}
        />
        {usesProp && (
          <datalist id="panel-object-props">
            {objProps.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        )}
        {prop && (
          <small>
            Domain: {allOf(expressionsOf(model, prop.domains, prop.domainAuto, prop.usedFrom).map((e) => classText(e, namingFor(model)))) || 'anything'}. Range: {allOf(expressionsOf(model, prop.ranges, prop.rangeAuto, prop.usedTo).map((e) => classText(e, namingFor(model)))) || 'anything'}.{' '}
            <button className="link" onClick={() => st().selectProp(prop.id)}>
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
      <button className="btn small" disabled={fixedWay} title={instanceOf ? 'A class membership always points from the individual to the class' : fixedWay ? '“Has data property” always points from the class to the data property' : undefined} onClick={() => st().reverseRelation(rel.id)}>
        Reverse direction
      </button>
      <label className="field">
        <span>Kind</span>
        {/* The kinds the type of model has, of those the ones that fit what the line connects. */}
        <select value={relChoice(model, rel)} disabled={settled} onChange={(e) => st().setRelChoice(rel.id, e.target.value as RelChoice)}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value} disabled={!!k.disabled} title={k.disabled}>
              {k.label}
            </option>
          ))}
        </select>
        {settled && !instanceOf && <small>Follows from what the line joins: there is nothing else it could be.</small>}
        {byName && <small>Follows from the name: “is a” makes the first class a kind of the second; any other name is that object property.</small>}
        {instanceOf && (
          <small>
            {names([rel.from])} is a member of the class {names([rel.to])}. Exports as <code className="pred">rdf:type</code>.
          </small>
        )}
      </label>
      {supports(model, 'standardProperties') && props.length > 0 && (
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
      <ConnectionPoints rel={rel} />
      <button className="btn danger" onClick={() => st().remove([], [rel.id])}>
        Delete relation
      </button>
    </>
  );
}

const SIDE_NAME: Record<Side, string> = { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' };

/**
 * Where the two ends of the line meet their terms on the canvas: what dragging an end along its
 * term does, for whoever would rather choose than drag. It is how the graph is drawn and is kept
 * with its style; the ontology says nothing else for it.
 */
function ConnectionPoints({ rel }: { rel: Relation }) {
  const pins = useStore((s) => s.model.style.anchors[rel.id]);
  const names = useStore((s) => [s.model.terms.find((t) => t.id === rel.from)?.name || 'Unnamed', s.model.terms.find((t) => t.id === rel.to)?.name || 'Unnamed'].join('\n')).split('\n');
  const st = useStore.getState;
  // A relationship from a term to itself is drawn as a loop, which has one place to be.
  if (rel.from === rel.to) return null;
  const row = (end: End) => {
    const pin = pins?.[end];
    const term = names[end === 'from' ? 0 : 1];
    return (
      <div className="pin-row">
        <span>{end === 'from' ? 'Start' : 'End'}</span>
        <select
          aria-label={`Side of “${term}” the line ${end === 'from' ? 'starts' : 'ends'} on`}
          value={pin?.side ?? ''}
          onChange={(e) => st().setAnchor(rel.id, end, e.target.value ? { side: e.target.value as Side, at: pin?.at ?? 0.5 } : undefined)}
        >
          <option value="">Automatic</option>
          {SIDES.map((side) => (
            <option key={side} value={side}>
              {SIDE_NAME[side]}
            </option>
          ))}
        </select>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          disabled={!pin}
          value={Math.round((pin?.at ?? 0.5) * 100)}
          aria-label={`How far along that side of “${term}”, in percent`}
          title={pin ? 'How far along the side: from its left or upper end to its right or lower end' : 'Choose a side first'}
          onChange={(e) => pin && st().setAnchor(rel.id, end, { side: pin.side, at: Number(e.target.value) / 100 }, `anchor:${rel.id}:${end}`)}
        />
      </div>
    );
  };
  return (
    <div className="field pins">
      <span>Connection points</span>
      {row('from')}
      {row('to')}
      <small>Where the line meets each term on the canvas. This changes the picture only, never what the model says. On the canvas: select the line and drag one of its ends along the term.</small>
      <button className="btn small" disabled={!pins} title="Have both ends placed automatically again" onClick={() => st().resetAnchors([rel.id])}>
        Reset to automatic
      </button>
    </div>
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
