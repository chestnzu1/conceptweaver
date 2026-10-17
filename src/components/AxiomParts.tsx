import { useState } from 'react';
import { classText, namingFor } from '../model/manchester';
import type { ClassExpression } from '../model/expressions';
import { nameIn } from '../model/labels';
import { compactIri } from '../model/prefixes';
import type { PropView } from '../model/props';
import { useStore } from '../model/store';
import { uid, type AxiomAnnotation, type ChainProperty, type DisjointUnion, type ExtraField, type HasKey, type KeyProperty, type Model, type NegativeAssertion, type PropertyChain, type Term } from '../model/types';
import { Section } from './EntityEditor';
import { EntityPicker, type Choice } from './EntityPicker';
import { Metadata } from './Metadata';

/**
 * The axioms that OWL states with a list or a blank node, edited where they belong: a property's
 * chains, a class's keys and disjoint unions, an individual's negative assertions, and the
 * annotations on axioms (owl:Axiom). What is read from a file is here, and what is added here is
 * written back as the statements they are (rdf.ts).
 */

const named = (iri: string): ClassExpression => ({ type: 'Class', iri });

/** What an IRI is called here: an entity's name, a prefixed name, or the IRI. */
function iriName(model: Model, iri: string): string {
  const entity = [...model.terms, ...model.props, ...model.annProps].find((x) => x.iri === iri);
  return entity?.name || compactIri(model, iri) || `<${iri}>`;
}

/** A class expression or statement target with its IRIs named, for showing which axiom is annotated. */
function namedText(model: Model, text: string): string {
  return text.replace(/<([^<>]+)>/g, (_all, iri: string) => iriName(model, iri));
}

/** The chains a property is the head of: `p1 o p2 o …` entails it (owl:propertyChainAxiom). */
export function PropertyChains({ prop }: { prop: PropView }) {
  const model = useStore((s) => s.model);
  const displayLang = useStore((s) => s.displayLang);
  const st = useStore.getState;
  const raw = model.props.find((p) => p.id === prop.id);
  if (!raw) return null;
  const chains = raw.chains ?? [];
  const set = (next: PropertyChain[]) => st().updateProp(prop.id, { chains: next.length ? next : undefined });
  const options = model.props;
  const label = (id: string) => {
    const p = model.props.find((x) => x.id === id);
    return p ? nameIn(p, model.lang, displayLang) || 'Unnamed' : 'Unnamed';
  };
  const patch = (ci: number, steps: ChainProperty[]) =>
    set(chains.map((c, i) => (i === ci ? { ...c, properties: steps } : c)));
  return (
    <div className="field">
      <span title="If a is related to b by the first property, b to c by the second, and so on, then a is related to the last thing by this property (owl:propertyChainAxiom).">
        Property chains <code className="pred">owl:propertyChainAxiom</code>
      </span>
      {chains.map((chain, ci) => (
        <div key={chain.id} className="axiom-card">
          <div className="row wrap">
            <span className="muted">A chain of {chain.properties.length || 'no'} propert{chain.properties.length === 1 ? 'y' : 'ies'}</span>
            <button className="btn icon ghost" title="Remove this chain" aria-label="Remove this chain" onClick={() => set(chains.filter((_, i) => i !== ci))}>
              ×
            </button>
          </div>
          <ol className="chain-steps">
            {chain.properties.map((step, si) => (
              <li key={si} className="row wrap">
                <select aria-label={`Property ${si + 1} of the chain`} value={step.prop} onChange={(e) => patch(ci, chain.properties.map((s, j) => (j === si ? { ...s, prop: e.target.value } : s)))}>
                  {!model.props.some((p) => p.id === step.prop) && <option value={step.prop}>Unnamed</option>}
                  {options.map((p) => (
                    <option key={p.id} value={p.id}>
                      {nameIn(p, model.lang, displayLang) || 'Unnamed'}
                    </option>
                  ))}
                </select>
                <label className="check" title="The property is followed backwards (an inverse property expression).">
                  <input
                    type="checkbox"
                    checked={!!step.inverse}
                    onChange={(e) => patch(ci, chain.properties.map((s, j) => (j === si ? (e.target.checked ? { ...s, inverse: true } : { prop: s.prop }) : s)))}
                  />
                  <span>inverse</span>
                </label>
                <button
                  className="btn icon ghost"
                  title="Remove this step"
                  aria-label={`Remove step ${si + 1}`}
                  onClick={() => {
                    const steps = chain.properties.filter((_, j) => j !== si);
                    if (steps.length) patch(ci, steps);
                    else set(chains.filter((_, i) => i !== ci));
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
          <div className="row wrap">
            <select
              aria-label="Add a step to the chain"
              value=""
              onChange={(e) => {
                // A property already in the chain may stand in it more than once: the chain is a sequence.
                if (e.target.value) patch(ci, [...chain.properties, { prop: e.target.value }]);
              }}
            >
              <option value="">Add a property to the chain…</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {label(p.id)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      <button className="btn small" onClick={() => set([...chains, { id: uid(), properties: [] }])}>
        Add a chain
      </button>
      {chains.some((c) => c.properties.length < 2) && <small>A chain is written once it has at least two steps.</small>}
    </div>
  );
}

/** The keys of a class: the properties whose values identify a member (owl:hasKey). */
export function ClassKeys({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const displayLang = useStore((s) => s.displayLang);
  const update = useStore((s) => s.updateTerm);
  const keys = term.keys ?? [];
  const set = (next: HasKey[]) => update(term.id, { keys: next.length ? next : undefined });
  const choice = (id: string): Choice | undefined => {
    const p = model.props.find((x) => x.id === id);
    if (p) return { id, name: nameIn(p, model.lang, displayLang) || 'Unnamed', iri: p.iri };
    const t = model.terms.find((x) => x.id === id);
    return t ? { id, name: nameIn(t, model.lang, displayLang) || 'Unnamed', iri: t.iri } : undefined;
  };
  const ref = (x: KeyProperty): string => ('prop' in x ? x.prop : x.data);
  return (
    <div className="field">
      <span title="The values of these properties together identify a member of the class: no two members can have the same ones (owl:hasKey).">
        Keys <code className="pred">owl:hasKey</code>
      </span>
      {keys.map((key, ki) => (
        <div key={key.id} className="axiom-card">
          <div className="row wrap">
            <span className="muted">Key {ki + 1}</span>
            <button className="btn icon ghost" title="Remove this key" aria-label={`Remove key ${ki + 1}`} onClick={() => set(keys.filter((_, i) => i !== ki))}>
              ×
            </button>
          </div>
          <EntityPicker
            values={key.properties.map(ref).flatMap((id) => choice(id) ?? [])}
            options={() => [
              ...model.props.map((p): Choice => ({ id: p.id, name: nameIn(p, model.lang, displayLang) || 'Unnamed', iri: p.iri, tag: 'object property' })),
              ...model.terms.filter((t) => t.type === 'property').map((t): Choice => ({ id: t.id, name: nameIn(t, model.lang, displayLang) || 'Unnamed', iri: t.iri, tag: 'data property' })),
            ]}
            onAdd={(id) => {
              if (key.properties.some((x) => ref(x) === id)) return 'It is already part of this key.';
              const property: KeyProperty = model.props.some((p) => p.id === id) ? { prop: id } : { data: id };
              set(keys.map((k, i) => (i === ki ? { ...k, properties: [...k.properties, property] } : k)));
            }}
            onRemove={(id) => set(keys.map((k, i) => (i === ki ? { ...k, properties: k.properties.filter((x) => ref(x) !== id) } : k)))}
            noun="property"
            of={`key ${ki + 1} of this class`}
            addLabel="Add a property to the key"
            searchLabel="Search for an object or data property"
            empty="No properties yet. Add the properties that identify a member"
          />
        </div>
      ))}
      <button className="btn small" onClick={() => set([...keys, { id: uid(), properties: [] }])}>
        Add a key
      </button>
      {keys.some((k) => !k.properties.length) && <small>A key is written once it names at least one property.</small>}
    </div>
  );
}

/** The classes a class is the disjoint union of: every member is one, and no two members overlap (owl:disjointUnionOf). */
export function DisjointUnions({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const displayLang = useStore((s) => s.displayLang);
  const update = useStore((s) => s.updateTerm);
  const naming = namingFor(model);
  const unions = term.disjointUnions ?? [];
  const set = (next: DisjointUnion[]) => update(term.id, { disjointUnions: next.length ? next : undefined });
  const of = (u: DisjointUnion) => new Set(u.classes.flatMap((c) => (c.type === 'Class' ? [c.iri] : [])));
  return (
    <div className="field">
      <span title="Every member of the class is a member of exactly one of these classes (owl:disjointUnionOf).">
        Disjoint unions <code className="pred">owl:disjointUnionOf</code>
      </span>
      {unions.map((u, ui) => (
        <div key={u.id} className="axiom-card">
          <div className="row wrap">
            <span className="muted">Union {ui + 1}</span>
            <button className="btn icon ghost" title="Remove this union" aria-label={`Remove union ${ui + 1}`} onClick={() => set(unions.filter((_, i) => i !== ui))}>
              ×
            </button>
          </div>
          <ul className="enum-members">
            {u.classes.map((c, ci) => (
              <li key={ci}>
                <span>{classText(c, naming)}</span>
                <button
                  className="btn icon ghost"
                  title="Take it out of the union"
                  aria-label={`Remove member ${ci + 1}`}
                  onClick={() => {
                    const classes = u.classes.filter((_, i) => i !== ci);
                    // Fewer than two classes is no union at all.
                    set(classes.length >= 2 ? unions.map((x, i) => (i === ui ? { ...x, classes } : x)) : unions.filter((_, i) => i !== ui));
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <EntityPicker
            values={[]}
            options={() => model.terms.filter((t) => t.type === 'concept' && !!t.iri && !of(u).has(t.iri)).map((t): Choice => ({ id: t.id, name: nameIn(t, model.lang, displayLang) || 'Unnamed', iri: t.iri }))}
            onAdd={(id) => {
              const t = model.terms.find((x) => x.id === id);
              if (!t?.iri) return 'That class has no IRI yet.';
              if (of(u).has(t.iri)) return 'It is already part of this union.';
              set(unions.map((x, i) => (i === ui ? { ...x, classes: [...x.classes, named(t.iri!)] } : x)));
            }}
            onRemove={() => undefined}
            noun="class"
            of={`union ${ui + 1} of this class`}
            addLabel="Add a class to the union"
            searchLabel="Search for a class"
            empty="No classes yet"
          />
        </div>
      ))}
      <button className="btn small" onClick={() => set([...unions, { id: uid(), classes: [] }])}>
        Add a disjoint union
      </button>
      {unions.some((u) => u.classes.length < 2) && <small>A union is written once it has at least two classes.</small>}
    </div>
  );
}

/** What an individual is stated not to have: a value of an object or data property (owl:NegativePropertyAssertion). */
export function NegativeAssertions({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const displayLang = useStore((s) => s.displayLang);
  const update = useStore((s) => s.updateTerm);
  const [prop, setProp] = useState('');
  const [target, setTarget] = useState('');
  const [value, setValue] = useState('');
  const list = term.negativeAssertions ?? [];
  const set = (next: NegativeAssertion[]) => update(term.id, { negativeAssertions: next.length ? next : undefined });
  const name = (id: string) => {
    const x = model.terms.find((t) => t.id === id) ?? model.props.find((p) => p.id === id);
    return x ? nameIn(x, model.lang, displayLang) || 'Unnamed' : 'something gone';
  };
  const object = model.props.some((p) => p.id === prop);
  const individuals = model.terms.filter((t) => t.type === 'instance');
  const add = () => {
    if (!prop) return;
    if (object) {
      if (!target) return;
      set([...list, { id: uid(), kind: 'object', prop, target }]);
      setTarget('');
    } else {
      set([...list, { id: uid(), kind: 'data', prop, value }]);
      setValue('');
    }
    setProp('');
  };
  return (
    <div className="field">
      <span title="A statement that something is not the case: an individual does not have this value of the property (owl:NegativePropertyAssertion).">
        Negative assertions <code className="pred">owl:NegativePropertyAssertion</code>
      </span>
      {list.length > 0 && (
        <ul className="enum-members">
          {list.map((n) => (
            <li key={n.id}>
              <span>
                not {name(n.prop)} {n.kind === 'object' ? name(n.target) : `“${n.value}”${n.lang ? `@${n.lang}` : ''}`}
              </span>
              <button className="btn icon ghost" title="Remove this assertion" aria-label="Remove this negative assertion" onClick={() => set(list.filter((x) => x.id !== n.id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap">
        <select
          aria-label="Property of the negative assertion"
          value={prop}
          onChange={(e) => {
            setProp(e.target.value);
            setTarget('');
            setValue('');
          }}
        >
          <option value="">Choose a property…</option>
          {model.props.length > 0 && (
            <optgroup label="Object properties">
              {model.props.map((p) => (
                <option key={p.id} value={p.id}>
                  {nameIn(p, model.lang, displayLang) || 'Unnamed'}
                </option>
              ))}
            </optgroup>
          )}
          {model.terms.some((t) => t.type === 'property') && (
            <optgroup label="Data properties">
              {model.terms
                .filter((t) => t.type === 'property')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {nameIn(t, model.lang, displayLang) || 'Unnamed'}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
        {!object && prop && <input aria-label="Value it does not have" placeholder="A value it does not have" value={value} onChange={(e) => setValue(e.target.value)} />}
        {object && (
          <select aria-label="Individual it is not related to" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">An individual it is not related to…</option>
            {individuals
              .filter((t) => t.id !== term.id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {nameIn(t, model.lang, displayLang) || 'Unnamed'}
                </option>
              ))}
          </select>
        )}
        <button className="btn small" disabled={!prop || (object ? !target : false)} onClick={add}>
          Add
        </button>
      </div>
      {!individuals.length && <small>There are no other individuals to state this of yet.</small>}
    </div>
  );
}

/** The annotations on statements about an entity (owl:Axiom): their values are edited, and they can be taken away. */
export function AxiomAnnotations({ iri }: { iri?: string }) {
  const model = useStore((s) => s.model);
  const displayLang = useStore((s) => s.displayLang);
  const st = useStore.getState;
  const [property, setProperty] = useState('');
  const [target, setTarget] = useState('');
  const [fields, setFields] = useState<ExtraField[]>([]);
  if (!iri) return null;
  const list = (model.axiomAnnotations ?? []).filter((a) => a.subject === iri);
  const annotationProps = [...model.annProps, ...model.props].filter((p) => !!p.iri);
  const name = (p: { name: string; nameLang?: string }) => nameIn(p, model.lang, displayLang) || 'Unnamed';
  const touch = (id: string, next: ExtraField[]) => st().setAxiomAnnotations((all) => all?.map((a) => (a.id === id ? { ...a, fields: next } : a)));
  const add = () => {
    if (!property || !target.trim()) return;
    const field: AxiomAnnotation = { id: uid(), subject: iri, property, target: target.trim(), fields };
    st().setAxiomAnnotations((all) => [...(all ?? []), field]);
    setProperty('');
    setTarget('');
    setFields([]);
  };
  return (
    <Section id="axiom-annotations" title="Annotations on axioms" count={list.length || undefined}>
      {list.map((a) => (
        <div key={a.id} className="axiom-card">
          <div className="row wrap">
            <span>
              <code className="pred">{iriName(model, a.property)}</code> on <code>{namedText(model, a.target)}</code>
            </span>
            <button
              className="btn icon ghost"
              title="Remove this annotation. The statement it annotates stays."
              aria-label="Remove this annotation on an axiom"
              onClick={() => st().setAxiomAnnotations((all) => (all ?? []).filter((x) => x.id !== a.id))}
            >
              ×
            </button>
          </div>
          <Metadata title="What it says" fields={a.fields} onChange={(next) => touch(a.id, next)} />
        </div>
      ))}
      <div className="field">
        <span>Annotate a statement</span>
        <div className="row wrap">
          <select aria-label="Annotation property" value={property} onChange={(e) => setProperty(e.target.value)}>
            <option value="">Choose an annotation property…</option>
            {annotationProps.map((p) => (
              <option key={p.id} value={p.iri ?? ''}>
                {name(p)}
              </option>
            ))}
          </select>
          <input aria-label="The statement target, as Turtle" placeholder="The statement's target, as Turtle" value={target} onChange={(e) => setTarget(e.target.value)} />
        </div>
        <Metadata title="What the annotation says" fields={fields} onChange={setFields} />
        <button className="btn small" disabled={!property || !target.trim()} onClick={add}>
          Add annotation
        </button>
        <small>An annotation is kept with the statement it is about: its subject, the property, and the target as Turtle.</small>
      </div>
    </Section>
  );
}
