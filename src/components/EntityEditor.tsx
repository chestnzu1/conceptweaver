import { useMemo, useState, type ReactNode } from 'react';
import {
  addFact,
  addLink,
  addPropLink,
  addToDomain,
  addValue,
  characteristicIssues,
  datatypeOf,
  inheritedPropertiesOfClass,
  linkedTerms,
  LINKS,
  propertiesOfClass,
  removeFromDomain,
  removeLink,
  removePropLink,
  removeValue,
  type ClassProperty,
  type LinkKind,
} from '../model/axioms';
import { baseIriOf } from '../model/iri';
import { compactIri } from '../model/prefixes';
import { findProp, objectProperties, propLinks, type PropView } from '../model/props';
import { reason } from '../model/reasoner';
import { stable } from '../model/stable';
import { isDirty, useStore } from '../model/store';
import { DATATYPES, type PropLink, type Term, type TermType } from '../model/types';
import { EntityPicker, type Choice } from './EntityPicker';
import { IriCell } from './Iri';

/**
 * The parts of the entity editor that state OWL axioms about the selected entity. What each part
 * shows is only what is asserted; whatever the reasoner works out is in the parts marked
 * "inferred", which have no controls. Every edit goes through the model's one way of changing,
 * so it is undoable, is drawn on the canvas and in the hierarchy at once, and is saved with the model.
 */

const choice = (t: Term): Choice => ({ id: t.id, name: t.name || 'Unnamed', iri: t.iri, ...(t.external !== undefined ? { tag: 'external' } : {}) });
const propChoice = (p: PropView): Choice => ({ id: p.key, name: p.name, iri: p.iri, ...(p.external !== undefined ? { tag: 'external' } : {}) });

/** The heading of the editor: what kind of entity it is, whether the model has unsaved changes, and a wider layout. */
export function EditorHead({ kind }: { kind: string }) {
  const dirty = useStore(isDirty);
  const docId = useStore((s) => s.doc.id);
  const wide = useStore((s) => s.editorWide);
  const st = useStore.getState;
  return (
    <div className="editor-head">
      <h2>{kind}</h2>
      <span
        className={'save-state ' + (docId ? (dirty ? 'dirty' : 'saved') : 'none')}
        title={docId ? (dirty ? 'Your edits are in the working copy but not yet saved to My Models' : 'Everything is saved to My Models in this browser') : 'Edits are kept in the working copy in this browser. Save to keep the model in My Models.'}
      >
        {docId ? (dirty ? 'Unsaved changes' : 'Saved') : 'Working copy'}
      </span>
      {(!docId || dirty) && (
        <button className="btn small" title="Save to My Models in this browser (Ctrl+S)" onClick={() => void st().saveToLibrary()}>
          Save
        </button>
      )}
      <button className="btn icon ghost" aria-pressed={wide} title={wide ? 'Narrow the editor' : 'Widen the editor'} aria-label={wide ? 'Narrow the editor' : 'Widen the editor'} onClick={() => st().setEditorWide(!wide)}>
        {wide ? '⇥' : '⇤'}
      </button>
    </div>
  );
}

const sectionOpen = new Map<string, boolean>();

/** A part of the editor that can be folded away; it stays as it was left while the app is open. */
export function Section({ id, title, count, children, inferred = false }: { id: string; title: string; count?: number | string; children: ReactNode; inferred?: boolean }) {
  const [open, setOpenState] = useState(sectionOpen.get(id) ?? true);
  const setOpen = (v: boolean) => {
    sectionOpen.set(id, v);
    setOpenState(v);
  };
  return (
    <section className={'editor-section' + (inferred ? ' inferred' : '')} data-section={id}>
      <h3>
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title}
          {count !== undefined && ` (${count})`}
        </button>
        {inferred && <span className="tag auto" title="Worked out by the reasoner from what is asserted. Never stored in the model or exported.">read-only</span>}
      </h3>
      {open && children}
    </section>
  );
}

/** An entity's identifier, in full, with how it is abbreviated and which namespace it is in. */
export function IriDetails({ iri, name }: { iri?: string; name: string }) {
  const model = useStore((s) => s.model);
  const cut = iri ? Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1 : 0;
  const ns = iri?.slice(0, cut);
  const curie = iri ? compactIri(model, iri) : undefined;
  const prefix = model.prefixes.find((p) => p.iri === ns);
  return (
    <div className="field">
      <span title="The identifier of this entity. It was made once and does not change when the name does.">IRI</span>
      <IriCell iri={iri} of={name} full />
      {iri && (
        <dl className="iri-parts">
          <dt>Prefixed name</dt>
          <dd>{curie ? <code>{curie}</code> : <span className="muted">none: no prefix covers this IRI</span>}</dd>
          <dt>Namespace</dt>
          <dd>
            <code>{ns}</code> <span className="muted">{ns === baseIriOf(model) ? '(default)' : prefix ? `(prefix ${prefix.prefix}:)` : '(no prefix declared)'}</span>
          </dd>
        </dl>
      )}
    </div>
  );
}

/** One kind of statement that holds both ways between this term and others of its kind: equivalent, disjoint, same, different. */
export function LinkEditor({ term, kind, noun, label, hint }: { term: Term; kind: LinkKind; noun: string; label: string; hint?: string }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const byId = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);
  const values = linkedTerms(model, term.id, kind)
    .filter((x) => byId.has(x.id))
    .map((x) => choice(byId.get(x.id)!));
  return (
    <div className="field">
      <span title={`${LINKS[kind].predicate}${hint ? ': ' + hint : ''}`}>
        {label} <code className="pred">{LINKS[kind].predicate}</code>
      </span>
      <EntityPicker
        values={values}
        options={() => model.terms.filter((t) => t.type === LINKS[kind].type && t.id !== term.id).map(choice)}
        onAdd={(id) => st().edit((m) => addLink(m, term.id, id, kind))}
        onRemove={(id) => st().apply((m) => removeLink(m, term.id, id, kind))}
        onOpen={(id) => st().select([id])}
        noun={noun}
        of={term.name}
        empty={model.vocab.enabled ? 'none stated' : 'none in force: RDFS & OWL properties are off'}
      />
    </div>
  );
}

/**
 * Class expressions without a name that are asserted of the class (an intersection, a nested
 * restriction…), kept exactly as they were written. They are shown apart from the named classes.
 */
export function AnonymousExpressions({ term, predicate }: { term: Term; predicate: 'rdfs:subClassOf' | 'owl:equivalentClass' }) {
  const st = useStore.getState;
  const all = term.axioms ?? [];
  const mine = all.map((a, i) => ({ a, i })).filter((x) => x.a.startsWith(predicate + ' '));
  if (!mine.length) return null;
  return (
    <div className="anonymous">
      <small>
        Anonymous class expression{mine.length === 1 ? '' : 's'}: kept exactly as written and exported with the class.
      </small>
      <ul className="axioms">
        {mine.map(({ a, i }) => (
          <li key={i}>
            <code>{a.slice(predicate.length + 1)}</code>
            <button
              className="btn icon ghost"
              title="Remove this expression from the class (Undo brings it back)"
              aria-label="Remove anonymous expression"
              onClick={() => {
                const left = all.filter((_, j) => j !== i);
                st().updateTerm(term.id, { axioms: left.length ? left : undefined });
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The properties declared to have this class as their domain, which is not the same as the class being required to have them. */
export function ClassProperties({ term }: { term: Term }) {
  // Moving terms about on the canvas does not change any of this, so it is not worked out again for it.
  const model = stable(useStore((s) => s.model));
  const st = useStore.getState;
  const all = propertiesOfClass(model, term.id);
  const side = (data: boolean) => {
    const mine = all.filter((p) => p.data === data);
    const asChoice = (p: ClassProperty): Choice => ({
      id: p.ref,
      name: p.name,
      iri: p.iri,
      ...(p.auto ? { tag: 'from use', locked: 'This domain follows where the property is used. To change it, change the restriction that uses it, or set the domain on the property.' } : {}),
    });
    return (
      <div className="field">
        <span>{data ? 'Data properties' : 'Object properties'}</span>
        <EntityPicker
          values={mine.map(asChoice)}
          options={() => (data ? model.terms.filter((t) => t.type === 'property').map(choice) : objectProperties(model).map(propChoice))}
          onAdd={(ref) => st().edit((m) => addToDomain(m, term.id, { ref, data }))}
          onRemove={(ref) => st().edit((m) => removeFromDomain(m, term.id, { ref, data }))}
          onOpen={(ref) => (data ? st().select([ref]) : st().selectProp(ref))}
          noun={data ? 'data property' : 'object property'}
          of={`the domain of ${term.name}`}
          addLabel={`Add ${term.name || 'this class'} to the domain of ${data ? 'a data property' : 'an object property'}`}
          searchLabel={`Search for ${data ? 'a data property' : 'an object property'}`}
          empty="none"
        />
      </div>
    );
  };
  return (
    <Section id="domain" title="Properties with this domain" count={all.length}>
      <p className="muted">
        Declared with <code className="pred">rdfs:domain</code>: whatever has the property is a {term.name || 'member of this class'}. It does not make the property required. For “every member has one”, add a restriction.
      </p>
      {side(false)}
      {side(true)}
    </Section>
  );
}

/** What the reasoner entails the entity to be a kind (or an instance) of, beyond what is stated. Read-only. */
export function InferredSupers({ term }: { term: Term }) {
  const model = stable(useStore((s) => s.model));
  const st = useStore.getState;
  const isClass = term.type === 'concept';
  const result = useMemo(() => {
    const reasoning = reason(model);
    if (!reasoning.consistent) return { consistent: false as const, links: [], inherited: [] };
    const stated = new Set(isClass ? linkedTerms(model, term.id, 'equivalentClass').map((x) => x.id) : []);
    const byId = new Map(model.terms.map((t) => [t.id, t]));
    const links = (isClass ? reasoning.superclasses(term.id) : reasoning.types(term.id))
      .filter((l) => !l.asserted && !stated.has(l.id))
      .map((l) => ({ ...l, name: byId.get(l.id)?.name || 'Unnamed', iri: byId.get(l.id)?.iri }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { consistent: true as const, links, inherited: isClass ? inheritedPropertiesOfClass(model, term.id) : [] };
  }, [model, term.id, isClass]);
  const what = isClass ? 'superclasses' : 'types';
  return (
    <>
      <Section id={'inferred-' + what} title={`Inferred ${what}`} count={result.consistent ? result.links.length : '—'} inferred>
        {!result.consistent && (
          <p className="bad" role="status">
            The reasoner finds the ontology inconsistent, so nothing reliable can be inferred. See the Validation tab.
          </p>
        )}
        {result.consistent && !result.links.length && <p className="muted">None beyond what is asserted.</p>}
        <ul className="inferred-list" aria-label={`Inferred ${what}`}>
          {result.links.map((l) => (
            <li key={l.id}>
              <button className="link" title={`${l.iri ?? ''}\nOpen it`} onClick={() => st().select([l.id])}>
                {l.name}
              </button>
              {l.equivalent && <span className="muted"> (equivalent)</span>}
              <span className="sources">{l.because}</span>
            </li>
          ))}
        </ul>
      </Section>
      {isClass && result.inherited.length > 0 && (
        <Section id="inferred-domain" title="Properties from superclass domains" count={result.inherited.length} inferred>
          <ul className="inferred-list" aria-label="Properties from superclass domains">
            {result.inherited.map((p) => (
              <li key={`${p.data}|${p.ref}`}>
                <button className="link" title={p.iri} onClick={() => (p.data ? st().select([p.ref]) : st().selectProp(p.ref))}>
                  {p.name}
                </button>
                <span className="muted"> {p.data ? 'data property' : 'object property'}</span>
                <span className="sources">Domain {p.viaName}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/** One entity chosen from a search, for a row that adds a statement. */
function PickOne({ value, options, onChange, noun, of }: { value?: Choice; options: () => Choice[]; onChange: (c: string | undefined) => void; noun: string; of: string }) {
  return <EntityPicker values={value ? [value] : []} options={options} onAdd={(id) => onChange(id)} onRemove={() => onChange(undefined)} noun={noun} of={of} addLabel={`Choose ${/^[aeio]/.test(noun) ? 'an' : 'a'} ${noun}`} searchLabel={`Search for ${/^[aeio]/.test(noun) ? 'an' : 'a'} ${noun}`} empty={`${noun}…`} max={1} />;
}

/** What is stated about an individual: the things it is related to, and the values it has. */
export function IndividualAssertions({ term }: { term: Term }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const byId = useMemo(() => new Map(model.terms.map((t) => [t.id, t])), [model.terms]);
  const props = objectProperties(model);
  const facts = props.flatMap((p) => p.rels.filter((r) => r.from === term.id && byId.get(r.to)?.type === 'instance').map((r) => ({ p, r })));
  const values = term.values ?? [];
  const [fact, setFact] = useState<{ prop?: string; to?: string; error?: string }>({});
  const [draft, setDraft] = useState<{ prop?: string; value: string; lang: string; error?: string }>({ value: '', lang: '' });
  const dataProp = draft.prop ? byId.get(draft.prop) : undefined;
  const textual = !dataProp?.range || dataProp.range === 'xsd:string' || dataProp.range === 'rdf:langString';
  const ofType = (type: TermType) => () => model.terms.filter((t) => t.type === type).map(choice);
  const stateFact = () => {
    const error = st().edit((m) => addFact(m, term.id, fact.prop ?? '', fact.to ?? ''));
    setFact(error ? { ...fact, error } : {});
  };
  const stateValue = () => {
    const error = st().edit((m) => addValue(m, term.id, { prop: draft.prop ?? '', value: draft.value, lang: draft.lang }));
    setDraft(error ? { ...draft, error } : { prop: draft.prop, value: '', lang: '' });
  };
  return (
    <>
      <Section id="facts" title="Object property assertions" count={facts.length}>
        {!facts.length && <p className="muted">None stated. An assertion relates this individual to another one by an object property.</p>}
        <ul className="assertions" aria-label="Object property assertions">
          {facts.map(({ p, r }) => (
            <li key={r.id}>
              <button className="link prop" title={`${p.iri ?? ''}\nOpen the property`} onClick={() => st().selectProp(p.key)}>
                {p.name}
              </button>
              <button className="link" title={`${byId.get(r.to)?.iri ?? ''}\nOpen it`} onClick={() => st().select([r.to])}>
                {byId.get(r.to)?.name || 'Unnamed'}
              </button>
              <button className="btn icon ghost" title="Remove this assertion" aria-label={`Remove ${p.name} ${byId.get(r.to)?.name}`} onClick={() => st().remove([], [r.id])}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="assertion-add">
          <PickOne value={fact.prop ? propChoice(findProp(model, fact.prop)!) : undefined} options={() => props.map(propChoice)} onChange={(prop) => setFact({ ...fact, prop, error: undefined })} noun="object property" of="state a fact" />
          <PickOne value={fact.to && byId.get(fact.to) ? choice(byId.get(fact.to)!) : undefined} options={ofType('instance')} onChange={(to) => setFact({ ...fact, to, error: undefined })} noun="individual" of="relate to" />
          <button className="btn small primary" disabled={!fact.prop || !fact.to} onClick={stateFact}>
            Add assertion
          </button>
        </div>
        {fact.error && (
          <small className="bad" role="alert">
            {fact.error}
          </small>
        )}
      </Section>
      <Section id="values" title="Data property assertions" count={values.length}>
        {!values.length && <p className="muted">None stated. An assertion gives this individual a value, such as a date or a number, for a data property.</p>}
        <ul className="assertions" aria-label="Data property assertions">
          {values.map((v, i) => {
            const dt = datatypeOf(model, v);
            return (
              <li key={i}>
                <button className="link prop" title={`${byId.get(v.prop)?.iri ?? ''}\nOpen the property`} onClick={() => st().select([v.prop])}>
                  {byId.get(v.prop)?.name || 'Unnamed'}
                </button>
                <span className="literal">
                  {v.value}
                  {v.lang ? <span className="lang">@{v.lang}</span> : dt && dt !== 'xsd:string' ? <span className="lang">{dt}</span> : null}
                </span>
                <button className="btn icon ghost" title="Remove this value" aria-label={`Remove ${byId.get(v.prop)?.name} ${v.value}`} onClick={() => st().apply((m) => removeValue(m, term.id, i))}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <div className="assertion-add">
          <PickOne value={dataProp ? choice(dataProp) : undefined} options={ofType('property')} onChange={(prop) => setDraft({ ...draft, prop, error: undefined })} noun="data property" of="give a value" />
          <input
            aria-label="Value"
            aria-invalid={!!draft.error}
            placeholder={dataProp?.range ? `${DATATYPES.find((d) => d.id === dataProp.range)?.label ?? 'value'} (${dataProp.range})` : 'Value'}
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value, error: undefined })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && draft.prop && draft.value.trim()) stateValue();
            }}
          />
          {textual && <input className="meta-lang" aria-label="Language of the value" placeholder="lang" title="Language of the value, e.g. nl. Leave empty if it has none." value={draft.lang} onChange={(e) => setDraft({ ...draft, lang: e.target.value, error: undefined })} onKeyDown={(e) => e.stopPropagation()} />}
          <button className="btn small primary" disabled={!draft.prop || !draft.value.trim()} onClick={stateValue}>
            Add value
          </button>
        </div>
        {draft.error && (
          <small className="bad" role="alert">
            {draft.error}
          </small>
        )}
      </Section>
    </>
  );
}

const PROP_LINK_FIELDS: { link: PropLink; label: string; predicate: string; noun: string }[] = [
  { link: 'parents', label: 'Superproperties', predicate: 'rdfs:subPropertyOf', noun: 'superproperty' },
  { link: 'inverses', label: 'Inverse properties', predicate: 'owl:inverseOf', noun: 'inverse property' },
  { link: 'equivalents', label: 'Equivalent properties', predicate: 'owl:equivalentProperty', noun: 'equivalent property' },
  { link: 'disjoints', label: 'Disjoint properties', predicate: 'owl:propertyDisjointWith', noun: 'disjoint property' },
];

/** How an object property stands to other object properties. */
export function PropLinks({ prop }: { prop: PropView }) {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const all = objectProperties(model);
  return (
    <>
      {PROP_LINK_FIELDS.map(({ link, label, predicate, noun }) => (
        <div className="field" key={link}>
          <span>
            {label} <code className="pred">{predicate}</code>
          </span>
          <EntityPicker
            values={propLinks(model, prop.key, link).map((k) => {
              const p = all.find((x) => x.key === k);
              return p ? propChoice(p) : { id: k, name: k };
            })}
            options={() => all.filter((p) => p.key !== prop.key).map(propChoice)}
            onAdd={(k) => st().edit((m) => addPropLink(m, prop.key, k, link))}
            onRemove={(k) => st().apply((m) => removePropLink(m, prop.key, k, link))}
            onOpen={(k) => findProp(model, k) && st().selectProp(k)}
            noun={noun}
            of={prop.name}
            empty="none stated"
          />
        </div>
      ))}
    </>
  );
}

/** Warnings about characteristics that cannot or should not be combined. */
export function CharacteristicWarnings({ chars }: { chars: string[] }) {
  const issues = characteristicIssues(chars);
  return (
    <>
      {issues.map((x) => (
        <small key={x} className="bad" role="alert">
          ⚠ {x}
        </small>
      ))}
    </>
  );
}
