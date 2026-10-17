# Technical Debt and Architectural Risk Assessment

Assessed against the repository as of 2026-10-13 (branch `instance-of-and-iri-suffix`, commit
`ce6419e`); extended on 2026-10-17 with TD-19, TD-20 and AR-17 to AR-21 for the logical data
modelling track, AR-11 to AR-16 dormant with the deferred data-integration track. Companion documents: [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md),
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md), [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md).

## 1. How to read this document

Two kinds of finding are kept apart:

- **Confirmed technical debt (`TD-n`)**: something that is in the code today and can be pointed
  at. Each names the files it was found in.
- **Architectural risk (`AR-n`)**: something that is not a defect today but is likely to become
  one on the way to the target architecture. These are judgements, not observations.

Severity is about the cost of leaving the item alone while the product grows:

| Severity | Meaning |
| --- | --- |
| **High** | Blocks a roadmap phase, or loses or corrupts ontology content. |
| **Medium** | Slows development or limits scale; workarounds exist. |
| **Low** | Friction. Worth fixing when the area is touched anyway. |

What is *not* debt deserves saying first, because it shapes the remediation: the codebase is
unusually well tested for its age (87 unit-test files with 990 tests, and 40 browser scripts,
one of them a UI audit), the model layer is free of UI imports, and two subsystems (`src/structure`,
`src/entities`) are already written against service interfaces with HTTP clients and tests that
enforce their boundaries. The recommended remediation is to spread that existing pattern, not
to introduce a new one.

## 2. Summary

| Id | Finding | Severity | Phase that addresses it |
| --- | --- | --- | --- |
| TD-01 | The model is a drawing-first projection of OWL, not an axiom store | High | 1, 3 |
| TD-02 | Class expressions are kept as raw Turtle text | High | 2 |
| TD-03 | Object properties are identified by lower-cased name | High | 1 |
| TD-04 | `store.ts` holds document, UI, jobs and persistence in one module | Medium | 1 |
| TD-05 | Components reach into model internals | Medium | 1 |
| TD-06 | The same rule is written in more than one place | Medium | 1 |
| TD-07 | Line geometry is implemented twice | Medium | when touched |
| TD-08 | The in-page reasoner blocks the page | Medium | 1 |
| TD-09 | Validation runs on the main thread and cannot be cancelled | Medium | 1 |
| TD-10 | The canvas draws every term | High | 2 |
| TD-11 | Browser persistence is a single JSON string with a hard ceiling | Medium | 2, 4 |
| TD-12 | No version history, diff or audit trail | High | 2, 4 |
| TD-13 | Serialization gaps: no RDF/XML export, constructs lost on import | Medium | 2, 3 |
| TD-14 | The reasoning service is a stateless single file on a frozen library bundle | Medium | 3 |
| TD-15 | No CI, no linter, no component tests, hand-run browser checks | Medium | 1 |
| TD-16 | One global 6,400-line stylesheet | Low | when touched |
| TD-17 | Bulk add reads pasted text only | Low | 2 |
| TD-18 | Two identity schemes for entities | Medium | 1 |
| TD-19 | History steps and change sets describe ontology axioms only | Medium | 2 (LM-1) |
| TD-20 | The ontology's revision follows a hand-kept list of model fields | Medium | 2 (LM-1) |

| Id | Risk | Likelihood | Impact |
| --- | --- | --- | --- |
| AR-01 | The TypeScript model and the server's axiom model drift apart | High | High |
| AR-02 | OWL 2 DL reasoning does not finish on large or expressive ontologies | High | Medium |
| AR-03 | JVM dependency alignment (OWL API, reasoners, Jena, Spring) | Medium | Medium |
| AR-04 | A local copy and a server copy of the same project conflict | Medium | High |
| AR-05 | Breadth outruns one developer | High | High |
| AR-06 | Keeping every version as a full graph multiplies storage | Medium | Medium |
| AR-07 | A server adds an attack surface the app has never had | Medium | High |
| AR-08 | SVG has a ceiling that culling does not remove | Medium | Medium |
| AR-09 | The browser evicts locally stored work | Low | High |
| AR-10 | AI suggestions introduce wrong axioms or leak content | Medium | High |
| AR-11 | A database credential or row data leaks through the new backend surface (dormant: data integration deferred) | Medium | High |
| AR-12 | The preview evaluator and the query engine read one mapping differently (dormant) | Medium | High |
| AR-13 | The OBDA engine's dependencies and limits constrain the backend (dormant) | Medium | Medium |
| AR-14 | A schema changes and mappings break unnoticed (dormant) | High | Medium |
| AR-15 | Database constraints or query answers are taken for ontological facts (dormant) | Medium | High |
| AR-16 | The product overloads or exposes a production database (dormant) | Low | High |
| AR-17 | The logical data model becomes a projection of the ontology, or a second ontology | Medium | High |
| AR-18 | Open-world axioms become closed-world constraints by default | High | High |
| AR-19 | Synchronization overwrites what the designer decided, or mappings drift unnoticed | Medium | High |
| AR-20 | LDM edits invalidate what was worked out for the ontology, or are read stale | High | Medium |
| AR-21 | A second editor, with its diagram, outruns one developer | Medium | Medium |

## 3. Confirmed technical debt

### TD-01 The model is a drawing-first projection of OWL, not an axiom store — High

**Where.** `src/model/types.ts` (`Model`, `Term`, `Relation`, `ObjProp`), `src/model/rdf.ts`
(`toTurtle` at line 344, `fromTurtle` at line 446, `leftOut` at line 421).

**What.** The application's data structure is a diagram: terms with positions and colours,
relationships between two terms, and a list of object properties. OWL is produced from it on
export and squeezed into it on import. What the diagram has no shape for is dropped:

- Property chains, keys (`owl:hasKey`), negative property assertions, SWRL rules, annotations on
  axioms and `owl:disjointUnionOf` are not read. `leftOut` counts most of them and the user is
  told, which is honest, but the content is gone after a round trip.
- Annotation properties are entities since 2026-10-17 (task 2.7), with their domains, ranges,
  superproperties and annotations; the ontology's own annotations beyond name and description,
  and `owl:imports`, are not kept (README, *OWL constructs without an editor*).
- A model has one own language (`Model.lang`); labels in other languages are kept as annotation
  fields and, since 2026-10-17, shown through a display language (task 2.7), but the form still
  edits the primary name in the model's language.

**Impact.** An ontology engineer cannot safely open a professional ontology (one with property
chains or axiom annotations is ordinary), edit it and save it back. This is the single largest
gap between the current product and "comparable to Protégé", and it is structural: no amount of
editor work fixes it while the storage cannot hold the statements.

**Remediation.** Do not replace `Model`. Add a lossless side channel first, then a canonical
axiom model on the server:

1. Phase 1: keep every triple the reader does not understand in an `unmapped` Turtle block on
   the model (the mechanism `Term.axioms` already uses, generalised to the whole ontology) and
   write it back unchanged. Round trips stop losing data before any editor exists for it.
2. Phase 3: on the server, the OWL API's `OWLOntology` is the canonical form
   (ADR-004 in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md)); `Model` becomes the editing
   view and the offline file format.

**Measured, 2026-10-14** (roadmap task 1.3). The round-trip test (`src/model/corpus.test.ts`)
saves nine public ontologies unchanged: 795 statements lost and 2,056 added between them, of which
the message on opening names at most 36. The loss is wider than this section says. Besides the
constructs listed above, it drops classes defined by an `owl:intersectionOf` stated on the class
(61 in Wine), properties typed only by a characteristic, datatype definitions and `owl:sameAs`;
it writes `rdfs:comment` back as `skos:definition`; and it restates n-ary disjointness and
difference pair by pair. Details in [BASELINES.md](BASELINES.md); the lists in `corpus/expected/`.

**Status, 2026-10-14.** Step 1 done (roadmap task 1.5). Every statement the reader takes
nothing from is kept whole in `Model.unmapped` (`src/model/unmapped.ts`) and written back with
every Turtle and JSON-LD export; the reader records what it maps, so a statement is never both
held by the model and kept. Kept statements follow an entity's new IRI and go with a deleted
entity. Descriptions, names and annotations are written back with the property and language
they were read in. The corpus now loses 28 statements of nine ontologies, not 790; what remains
is listed in BASELINES.md. Step 2 (the OWL API as the canonical form) is Phase 3.

**Status, 2026-10-14, later.** Domains and ranges are axioms (model format 3, see TD-02): two
`rdfs:domain` statements of one property were read as one union, which changed what they meant
(PROV-O's `prov:hadActivity` and `prov:hadRole`); each is now an axiom of its own. The corpus
loses 24 statements.

**Status, 2026-10-15.** The corpus loses nothing (Phase 1's acceptance criterion, MS-2). What it
lost is written back: disjointness and difference among more than two are drawn as pairs that
remember the axiom they came from and written as that axiom while all its pairs stand; a data
restriction to another datatype than the property's range is an axiom of the class; text that
looks like a link stays text; and RDF/XML attribute values are read with XML's white space
rules. What it still adds that says more than the original is a domain or range that follows a
property's uses where the file states none (3 axioms over the nine). Step 2 is Phase 3.

### TD-02 Class expressions are kept as raw Turtle text — High

**Where.** `Term.axioms` in `src/model/types.ts`; written back at `src/model/rdf.ts:293`.

**What.** A superclass or equivalent class that is a union, intersection, complement, nested
restriction, `owl:hasValue`, `owl:hasSelf` or unqualified cardinality is stored as a string such
as `rdfs:subClassOf [ owl:intersectionOf ( … ) ]` and spliced into the output. It is shown,
exported and sent to HermiT, but:

- it cannot be edited piece by piece;
- the in-page reasoner ignores it (`REASONER_LIMITS` in `src/model/validation.ts`);
- it is text, so anything that renames an IRI has to rewrite strings.

**Impact.** Defined classes (`EquivalentTo: Pizza and (hasTopping some MeatTopping)`) are the
core of OWL modelling. They can be imported and reasoned over but not authored.

**Remediation.** A structured class-expression type (a small tagged union: named class, and/or/
not, some/only/min/max/exactly/value/self, one-of) with a parser from and a writer to Turtle,
and a Manchester-syntax text editor with completion over it. Existing `axioms` strings are
parsed on load and fall back to text when they cannot be. See M2 in
[PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md).

**Status, 2026-10-14: done for domains and ranges.** `src/model/expressions.ts` is that type:
`ClassExpression` and `DataRange`, named as in the OWL 2 structural specification (and so as the
OWL API's classes are), entities by IRI, with a reader from RDF, IRI renaming, pruning of deleted
entities and an `Unparsed` case for what has no structure (kept as canonical Turtle, read-only).
`src/model/manchester.ts` prints and parses it; `src/components/AxiomList.tsx` edits it. Domains
and ranges of object and data properties are lists of axioms of it (`ObjProp.domains`/`ranges`,
`Term.domains`/`ranges`, model format 3), and a data range a format 2 model kept in `Term.axioms`
is parsed into one on load.

**Status, 2026-10-14, later: done.** Superclasses, equivalent classes and disjoint classes that
are expressions are axioms of the class with that structure (`Term.classAxioms`, model format 4;
`Term.axioms` is gone, and a model of format 3 or before is converted on load). The type has an
object property expression of its own (a property or its inverse), typed data properties and
individuals, and a printer to OWL functional syntax, the OWL API's form. The editor
(`src/components/ExpressionEditor.tsx`) builds an expression as nested blocks or writes it in
Manchester syntax with completion of the next name or keyword, highlighting, bracket matching,
formatting and errors in place; the reader is checked against the OWL API's own Manchester
parser (`src/model/expressionConformance.test.ts`). What remains as text is what OWL has no class
expression for (`Unparsed`, read-only); general class axioms, property chains, keys and
`owl:disjointUnionOf` are still kept as statements (TD-01). The app's own rule reasoner still
does not interpret expressions (`REASONER_LIMITS`); HermiT does. The limits that remain are listed in
[EXPRESSION_EDITOR_LIMITATIONS.md](EXPRESSION_EDITOR_LIMITATIONS.md).

**Status, 2026-10-15: roadmap task 2.1 done.** What 2.1 asked for beyond the above: an expression
is read out in words (`src/model/inWords.ts`), in the editor and under every class, domain and
range axiom; a class with something it is equivalent to is a defined class, marked ≡ in the class
tree and named so in its editor; a name two properties share is refused in Manchester syntax as
one two classes share is. Phase 2's acceptance for it is tested: every class expression of the
corpus opens as structure, reads back the same from its text and its blocks, and survives an
edit of its class (`corpusExpressions.test.ts`); each of Pizza's definitions typed again in the
editor is classified by HermiT as Protégé's is (`expressionConformance.test.ts`).

### TD-03 Object properties are identified by lower-cased name — High

**Where.** `propKey` in `src/model/props.ts:20` (`labelKey(name) || DEFAULT_PROP`), `labelKey`
in `src/model/vocab.ts:201`; references by key in `ObjProp.parents`, `inverses`, `equivalents`,
`disjoints`; a relationship names its property through `Relation.label`. `renameProp` in
`src/model/store.ts:1305` rewrites the references.

**What.** Classes, data properties and individuals are `Term`s with a stable `id`. Object
properties are not: a property *is* its name, lower-cased. Consequences:

- two properties cannot share a label, although their IRIs may differ (two imported ontologies
  each with a `hasPart`);
- names that differ only by case collide;
- every rename is a multi-place rewrite, and a missed place silently detaches a relationship
  into a "plain relationship".

**Impact.** Imports of real ontologies can merge or split properties incorrectly, and any
backend that speaks IRIs has to translate through names.

**Remediation.** Give `ObjProp` a stable `id` and make every reference use it (a model-format
migration, `version: 2`, with the old format still read). This is a prerequisite for TD-18 and
for the change-set contract of Phase 1.

**Status, 2026-10-14.** Done (roadmap task 1.4). `ObjProp.id`; a relationship names the
property it uses in `Relation.prop`; links between properties are ids; `src/model/identity.ts`
joins a relationship given only a label (drawn, pasted, read from a file) to the property of that
name, once. Model format 2; format 1 is read and brought up to date by `normalizeModel`, and
`src/model/migration.test.ts` opens three models saved in format 1 and checks that their Turtle,
their relationships, their properties and their picture are what they were. Two properties may
share a name: FOAF's two "account" properties are now both kept on import (the round-trip corpus
lost five fewer statements for it). Annotation properties became entities of their own in format
7 (roadmap task 2.7).

### TD-04 `store.ts` holds document, UI, jobs and persistence in one module — Medium

**Where.** `src/model/store.ts`: 1,801 lines, 99 actions, about 45 state fields.

**What.** One zustand store carries the ontology document and its undo history, selection and
viewport, dialogs, the validation run and reasoner address, the external-ontology cache, layout
jobs, the Structure Explorer's focus and the persistence timers. It also contains rule logic
(TD-06).

**Impact.** Every feature edits the same file; nothing in it can be moved to a server without
untangling which state is the document and which is the session.

**Remediation.** Split by lifetime, without changing behaviour: a *document* slice (model,
history, the edit commands), a *session* slice (selection, viewport, dialogs, panels), and one
slice per job-like concern (validation, reasoning, layout, externals). The document slice is
what later talks to `OntologyEditService` (see ADR-002).

**Status, 2026-10-14.** Done (roadmap task 1.6), with no change in behaviour. `store.ts` is now
65 lines that put the store together from slices in `src/model/state/`: the document
(`document.ts`: the model, its history, the saved model it is; `edits.ts`: the edit commands),
the session (`session.ts`: selection, viewport, view, dialogs, panels, preferences, notices, the
Structure Explorer and Entities lists; `subgraph.ts`), and one slice per job (`validation.ts`,
`externals.ts`, `layout.ts`, whose run and glide are its own). The working copy kept in the
browser is `persistence.ts`, attached to the store once it is made; storage keys are
`storage.ts`, and what the canvas shows of the model is `view.ts`. Every member was moved as it
was: the store has the same 136 keys, of the same kinds, with the same initial values, and every
import of `store.ts` stays as it was. `state/slices.test.ts` checks that no two slices have a key
in common and that together they are the store. Slices reach each other through `get()`; the
document's `replaceModel` still resets the session and the jobs for a new document, which is the
one place the document knows of them. The rule logic in the edit commands (TD-06) is next, in
task 1.7.

### TD-05 Components reach into model internals — Medium

**Where.** 34 of the 37 files in `src/components` import from `../model/` (`Alignment.tsx` 14
imports, `Canvas.tsx` 12, `Inspector.tsx` 11, `EntityEditor.tsx` 11). `EntityEditor.tsx:255` and
`Validation.tsx:44` call the reasoner directly while rendering.

**What.** Views compute domain answers themselves from the whole in-memory model. The exceptions
are the Structure views and the Entities tables, which ask a service.

**Impact.** These views only work when the entire ontology is in the page. They are what has to
change for the ontology to live anywhere else.

**Remediation.** View by view, replace direct model reads with a question to a service whose
local implementation calls the same model functions. Order by payoff: entity editor (so that an
entity can be edited without loading the ontology), then validation and alignment. The canvas
comes last and through `GraphService` (subgraph in, positions kept locally).

### TD-06 The same rule is written in more than one place — Medium

**Where and what.**

- `addSuperclass` in `src/model/store.ts:1386–1390` repeats the checks and messages of `addIsA`
  in `src/model/axioms.ts` (self-superclass, already asserted, cycle note).
- Moving the end of a relationship has two behaviours: `updateRelation` in the store re-derives
  the *kind* of relationship from its new ends; `reconnect` in `src/model/reconnect.ts` holds
  the kind fixed. Both are deliberate, but the user-visible rule depends on which control was
  used.
- Eight modules under `src/model` each define their own `q()` quoting helper.
- `src/model/layout.ts` is a 25-line shim over `src/layout/` kept for older callers.

**Impact.** Rules drift. A server implementation would have to reproduce each variant.

**Remediation.** One function per rule in the model layer, called by the store and by services;
decide the reconnect question once (recommended: the stricter rule everywhere, with changing the
kind as its own explicit command).

**Status, 2026-10-15.** Done (roadmap task 1.7), with the recommended rule.

- Moving an end has one rule, `reconnect.ts`: what the relationship is stays fixed. The canvas,
  the side panel and the table of relationships all move an end with `reconnectRelation`. The
  panel and the table share one dropdown, `src/components/EndSelect.tsx`, which lists a term
  that cannot take the end greyed out, with the reason as its tooltip; it asks `reconnection`
  when the dropdown is reached, as the canvas does when an end is taken hold of. `updateRelation`
  no longer takes ends: its patch type leaves `from` and `to` out, so a control that tries does
  not compile. The kind is changed with `setRelChoice` (*Kind*). What this costs: where no kind
  fits both the old pair of terms and the new one (a class membership whose start would move to
  a class), the relationship is drawn again; before, the panel and the table turned it into
  whatever the new pair made it.
- A pair that no line joins (an individual and a data property) is refused, when an end is
  moved, with the reason `cannotRelate` gives when one is drawn, and what to do instead.
- The store's `addSuperclass` had no callers and is gone; `removeSuperclass` is gone too, and
  the entity editor adds and removes a superclass with `addIsA` and `removeIsA` through `edit`.
  The check that an individual is not stated twice to be an instance of a class was written in
  both `makeInstanceOf` and `updateRelation`; it is `statedMember` in `axioms.ts`.
- The eight `q()` helpers are `quoted` and `quotedName` in `src/model/words.ts`.
- `src/model/layout.ts` is gone. `arrangeAsHierarchy` and `hierarchyOf` (a whole model, with the
  usual settings) are in `src/layout/graph.ts` beside `graphOf`, and no two functions share the
  names `hierarchyLayout` and `forceLayout` any more.

Not done: some refusals still say the same thing in two wordings (moving an end says "It is
already stated that “Film” is a kind of “Work”", adding a superclass "“Work” is already an
asserted superclass of “Film”"), and `reverseRelation` checks only the direction a membership
and a "has data property" must have, not whether the reversed statement is stated already.

### TD-07 Line geometry is implemented twice — Medium

**Where.** `src/model/geometry.ts` (668 lines, TypeScript) and `src/export/viewer.js` (862 lines,
plain JavaScript, inlined into exported HTML pages).

**What.** The exported page redraws lines when a term is dragged, so it carries a hand port of
the routing code. The two are kept equal by a browser check (`e2e/html-export.mjs`,
`e2e/edge-endpoints.mjs`), not by sharing code.

**Remediation.** Build the viewer from the TypeScript source (a second Vite entry that bundles
`geometry.ts`) the next time the routing changes. Not urgent while the checks hold.

### TD-08 The in-page reasoner blocks the page — Medium

**Where.** `src/model/reasoner.ts` (`reason`, line 100), called from `inferred.ts`,
`validation.ts`, `axioms.ts`, `src/structure/local.ts`, `src/entities/local.ts` and two
components.

**What.** A forward-chaining rule reasoner runs synchronously on the main thread and keeps
exactly one result (`last`). Measured on this machine with `src/model/bench.test.ts`:

| Generated ontology | Reasoner run |
| --- | --- |
| 350 classes (517 terms, 1,373 relationships) | 70 ms |
| 650 classes | 158 ms |
| 1,300 classes | 277 ms |
| 2,600 classes (3,839 terms, 10,206 relationships) | 572 ms |

It runs again after every edit that changes meaning. It cannot be cancelled.

**Remediation.** Move it behind `ReasoningService` and run the local implementation in a Web
Worker (the layout code already does this: `src/layout/run.ts`, `worker.ts`). Results become
asynchronous and tied to a revision, which is the shape the HermiT path already has.

**Status, 2026-10-15.** Done (roadmap task 1.9). `ReasoningService` (`src/reasoning`) starts,
follows and stops jobs, each of one revision; the fast reasoner runs in a worker, HermiT through
the reasoning service, both through the same interface. The reasoner is split in two
(`src/model/reasoner.ts`): `derive`, the rules and the contradictions, in the worker, answering
with plain facts; and `view`, which words them and looks up what is asked about, on the page. Its
answer is asked for only by what shows it, through the store (`useReasoning`), and each view says
it is working until the answer is there. On the 2,600-class model an edit's longest task went from
533 ms to 72 ms (docs/BASELINES.md). The model-layer functions that used the reasoner take its
answer as an argument; `reason(model)` remains for what needs it at once (an export with the
inferred statements), and is given the worker's answer when there is one (`adopt`).

### TD-09 Validation runs on the main thread and cannot be cancelled — Medium

**Where.** `validate` in `src/model/validation.ts:637`; README, *Validation: what is and is not
covered* ("runs in the page, in steps, not in a background thread; a run cannot be cancelled").

**Remediation.** Same worker and job model as TD-08.

**Status, 2026-10-15.** Done (roadmap task 1.9). `ValidationService` (`src/validation`) runs the
checks in a worker as a job, which says what it is doing as it goes and can be stopped (*Stop* in
the workbench). A report names the revision it is of, not the model object, and a quick fix
travels as what it does and is found again in the model when it is applied. The count in the
header and the check of the mappings run as background jobs of the same service. A validation
run on the 2,600-class model has no task over 50 ms (from 386 ms).

### TD-10 The canvas draws every term — High

**Where.** `Scene` in `src/components/Canvas.tsx` maps over all `model.terms` and all relations;
there is no viewport test anywhere in the file. Label placement (`placeLabels`) and edge
geometry are recomputed for the whole graph on every pointer move of a drag.

**What.** The README's own measurement: responsive to about 2,000 terms, slow at 4,000. Layout
is not the limit (5,000 terms arrange in 30 ms); drawing is.

**Impact.** A 10,000-class ontology cannot be opened in the Graph view at all, although the
Structure Explorer handles 200,000 classes (hierarchy built in 0.65 s in
`src/structure/bench.test.ts`).

**Remediation.** In order, stopping when it is enough (ADR-008):

1. Viewport culling: render only terms and lines whose boxes intersect the visible area.
2. Level of detail: below a zoom threshold draw boxes without text (a `far` class already hides
   edge labels below 30 % zoom).
3. Subgraph-first: above a size threshold open the Graph view on a subgraph and never
   instantiate the full graph.
4. Only if those fail: a Canvas 2D layer for edges.

**Status, 2026-10-15: done (roadmap task 2.2), without step 4.** `src/model/culling.ts`:

- Culling: of a graph of more than 500 terms, the canvas draws the terms and lines in an area
  around the view (the view and four tenths of it on each side), kept while the view stays
  inside it; a smaller one is drawn whole, as before. Culling the terms was not
  enough: on a wide hierarchy some 6,000 lines between terms out of view cross it, 1.3 billion
  pixels of path, so a line that runs out of the area is cut to it, as the same curve.
- The area is a layer of its own: a pan moves it on the compositor and paints nothing; only a
  new area, or another zoom, is painted.
- Level of detail: below 30 % no words on the lines, below 20 % none in the terms and no handles;
  there, above 1,500 lines, the lines are drawn as one path for each way of drawing them.
- Subgraph-first: above 12,000 terms (`GRAPH_LIMIT`) the model opens on the Structure Explorer,
  and the Graph view builds nothing until a class is chosen to draw the graph around.

Panning with some 300 terms in view: 4.5 to 55 frames a second at 2,600 classes, 0.9 to 43 at
9,892 terms, in a headless browser that paints on the processor; the number of SVG elements
follows what is in view (BASELINES.md). What remains: a jump to another part of the graph paints
the new area at once (0.28 s at 9,892 terms), and an edit still works out the lines of the whole
graph (0.19 s there). Pictures are of the whole graph, drawn in full for the moment they are taken.

### TD-11 Browser persistence is a single JSON string with a hard ceiling — Medium

**Where.** The subscriber at the end of `src/model/store.ts` writes
`JSON.stringify(model)` to `localStorage` 300 ms after each change; `src/model/library.ts`
stores saved models in IndexedDB.

**What.** The working copy is the whole model as one string. A generated 2,600-class ontology
serializes to 2.1 MB; browsers allow about 5 MB per origin in `localStorage`, so the working copy
stops being kept somewhere near 5,000–6,000 classes. The store detects the failure and warns
(`workingCopyAtRisk`), which prevents silent loss but not the limit. Undo history (100 steps,
`HISTORY`) is in memory only. The content of external ontologies is cached per browser and is
not in the model file.

**Remediation.** Move the working copy to IndexedDB (no practical size limit, asynchronous),
ask for persistent storage (`navigator.storage.persist()`, not called anywhere today), and write
changes rather than the whole document once change sets exist (TD-12).

**Status, 2026-10-15.** Done but for the last part (roadmap task 1.10). The working copy is a
record in IndexedDB (database version 3, store `working`): the model itself, with which saved model
it is and whether it has changes not saved there. It is written 300 ms after a change, one write at
a time and the latest last, and at once when the page is hidden. The app reads it before it is
shown, so the example it starts with never takes its place; a copy an earlier version left in
`localStorage` is moved over and taken out of there. Once something has been edited, the browser
is asked once to keep the site's data when space runs low; *My Models* says how much is kept and
whether it has agreed. `e2e/working-copy.mjs` keeps and reopens a 5,200-class model of 6.5 million
characters, which `localStorage` refuses. Still the whole model is written each time, not the
change (about 15 ms of copying at 2,600 classes); undo history is still in memory only.

**Status, 2026-10-16.** The data graphs SHACL validates (roadmap stage SH-2) keep their content
beside it, in a store of its own (database version 4, `datagraphs`), apart from the model, which
names them. Content is never taken out: a deleted graph's stays so that undo, or a model saved
before with the same graph, finds it again. It accumulates until the site's data is cleared;
collecting what no model names any more needs to know every model that might, which versions
(2.3) will.

### TD-12 No version history, diff or audit trail — High

**Where.** `past: Model[]` and `future: Model[]` in `src/model/store.ts`. The only "revision" in
the code is a content fingerprint used to mark validation and reasoning results stale
(`revisionOf` in `src/model/validation.ts`).

**Impact.** Nothing answers "what changed since last week, and who changed it". This is a
baseline expectation of both comparison products and a precondition for collaboration,
governance workflows and publishing.

**Remediation.** Named versions with an axiom-level diff, first locally (Phase 2), then as
server revisions with change sets (Phase 4). Design in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §6.

**Status, 2026-10-15.** The groundwork is there (roadmap task 1.8). The history is no longer a
list of models but of steps, each a change set of the edit service (`src/editing/local.ts`):
undo applies one backwards. The document has a revision of its own (`version` in the store), and
any step can be given as axioms added and removed (`changeSetOf`), which is the difference a
named version will show. Named versions, their storage and a view of the history are task 2.3.

**Status, 2026-10-16.** Shape sets (roadmap stage SH-1) are part of the same history: an edit of
a shape is one step, undone and redone like any other. A change set lists ontology axioms only,
so such a step has none, and says in its summary that it changed the SHACL shapes. What a step
changed in a shape set, statement by statement, is for 2.3, when a version has to show it.

**Status, 2026-10-16: named versions and differences, locally (roadmap task 2.3).** A model in My
Models has versions in IndexedDB (`src/projects/local.ts`): each the whole model, compressed,
with a content hash. Two versions, or a version and the model now, are compared over what each
states (`changesBetween`), entity by entity, with the shape sets' statements and the data graphs
(`src/projects/difference.ts`); a version is restored as a new one, which undo takes back. Left:
the history of one entity (FR-M10-4), who changed what, and revisions on a server (Phase 4).
Versions are kept whole, not as change sets: a version of a large model costs its compressed size
each time.

### TD-13 Serialization gaps — Medium

**Where.** `exportModel` in `src/model/files.ts:193`; `src/model/rdf.ts`.

**What.**

- **No RDF/XML, OWL/XML, functional or Manchester export.** The app reads all of these (the
  last three through the Java service) but writes only Turtle, JSON-LD, its own JSON, CSV,
  images and the HTML page. RDF/XML is what Protégé saves by default and what many pipelines
  expect.
- Turtle is written by the app's own writer (a node list joined into text), not by a library.
  It is covered by round-trip tests, but every new construct is new writer code.
- `owl:imports` is not written or followed; imported ontologies are attached under *Align* by
  hand.

**Remediation.** Export in the remaining syntaxes through the service that already converts the
other way (`/convert` in `reasoner/ReasonerService.java` uses the OWL API, which writes all of
them). Imports closure belongs to M8.

**Status, 2026-10-16: the first point done (roadmap task 2.5).** RDF/XML is written in the page
from the Turtle (`src/model/rdfxml.ts`); OWL/XML, functional and Manchester syntax by the OWL
service, whose `/convert` now takes the syntax to write (`to`). The OWL API finds every export
states what the Turtle does. The Turtle writer is still the app's own, and imports are still not
followed.

### TD-14 The reasoning service is a stateless single file on a frozen library bundle — Medium

**Where.** `reasoner/ReasonerService.java` (820 lines), `reasoner/run.mjs`,
`src/model/reasoning.ts` (`dlRequest`, `askReasoner`).

**What.**

- Every run re-exports the whole ontology as Turtle and posts it with its imports; the service
  parses, reasons, answers and forgets. There is no job id, progress or cancel beyond a timeout
  (60 s by default, 600 s at most).
- HTTP, JSON handling, CORS and origin checks are hand-written on the JDK's `HttpServer`.
- Both executors are unbounded cached thread pools; two concurrent requests each load an
  ontology into the same 2 GB heap (`-Xmx2g` in `run.mjs`).
- It depends on `robot.jar` (93 MB, pinned by SHA-256), which fixes OWL API 4.5.29, HermiT
  1.4.5.456 and Jena 3.17.0. Upgrading any one means leaving the bundle.
- It has no tests of its own; it is exercised through TypeScript tests that skip when Java is
  missing.

**What is good and should be kept.** The request and response shapes, the honest status
(*complete*, *partial*, *failed*), the justifications and the refusal to fetch anything from the
network.

**Remediation.** Phase 3 moves the same endpoints into a Spring Boot application with declared
dependencies, a bounded job executor and its own tests (ADR-003). The bundle already contains
ELK, JFact and Whelk, so a second reasoner can be offered before that migration.

### TD-15 No CI, no linter, no component tests, hand-run browser checks — Medium

**Where.** No `.github/` or other pipeline configuration; no ESLint or Prettier configuration,
although the source has 21 `eslint-disable` comments; no test files under `src/components`;
`e2e/*.mjs` are 21 Node scripts started by hand against a preview server, 8 of them with the
port hard-coded.

**What.** Quality depends on one person remembering to run about 25 commands. One browser check
is known to fail intermittently on timing (`e2e/sidebar-tree.mjs`, a 400 ms bound).

**Remediation.** The first task of Phase 1: a single `pnpm verify` script and a CI workflow that
runs type-check, unit tests, build, every browser script and the UI audit; the benchmarks run on
a schedule and their numbers are kept. Add a linter with the rules the disable comments already
assume. Give every browser script the base-URL argument.

**Status, 2026-10-14.** Done apart from component tests: `pnpm verify` (`scripts/verify.mjs`)
and `.github/workflows/verify.yml` on every push; oxlint (`.oxlintrc.json`) with the two
`react-hooks` rules the comments assume, since typescript-eslint does not read TypeScript 7;
every browser script takes the base URL; the timing check in `e2e/sidebar-tree.mjs` is a median
of five against a calibration; `pnpm bench` weekly in `.github/workflows/benchmarks.yml`, with
today's numbers in [BASELINES.md](BASELINES.md). oxlint finds no problem behind three of the 21
`exhaustive-deps` comments (`Canvas.tsx`, `SparqlView.tsx`, `StructureExplore.tsx`); they are kept,
because its port of the rule is not the original's and at least the one in `SparqlView.tsx`
suppresses a finding the original reports.

### TD-16 One global 6,400-line stylesheet — Low

**Where.** `src/styles.css` (6,434 lines). Class names are global.

**Remediation.** Split by view when a view is next reworked; no behaviour depends on it.

### TD-17 Bulk add reads pasted text only — Low

**Where.** `src/model/bulk.ts` (`parseTerms`, `parseRelations`, `parseOutline`).

**What.** Rows are pasted as text, tab- or pipe-separated, with an optional header row whose
column names are matched against a fixed English list. There is no file upload, no CSV or XLSX
parsing, no mapping screen, no preview of what will be created beyond notes, and no saved
template. Relationships are a second paste in arrow notation.

**Remediation.** M7 in [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md). The parsers are a
sound base for the row-to-entity step.

**Status, 2026-10-16: done (roadmap task 2.4)**, beside *Bulk add*, which stays for pasted text.
*Import a table* reads CSV, TSV and Excel files (`src/import/`), maps columns on a screen, previews
row by row with reasons, imports as one edit and keeps templates, over a mapping core that does
not assume a file (`src/mapping/`, ADR-019). Left: updating entities from a table (FR-M7-6).

### TD-18 Two identity schemes for entities — Medium

**Where.** `Term.id` (random) and `Term.iri` (optional until the term is named) in
`src/model/types.ts`; `classIriOf` in `src/structure/local.ts`; README, *Moving the Structure
Explorer to a semantic backend* ("a class without an IRI yet is known locally as
`urn:conceptweaver:term:…`").

**What.** The editor addresses entities by internal id, the service contracts by IRI, and object
properties by name (TD-03). Translation happens at each boundary.

**Remediation.** Every entity has an IRI from creation (a placeholder in the model's namespace
until named), internal ids stay as a local convenience, and service contracts use IRIs only.

**Status, 2026-10-14.** Done for the IRI (roadmap task 1.4): every term, object property and
named datatype has one from creation, a stand-in marked `pendingIri` until its first real name
replaces it, once. The Structure service speaks IRIs only; the Entities service keeps keys of its
own choosing, which its contract already treats as opaque. Internal ids remain the editor's.

### TD-19 History steps and change sets describe ontology axioms only — Medium

**Where.** `ChangeSet` in `src/editing/contracts.ts` (its changes are OWL axioms); `Step` and
`Patch` in `src/editing/local.ts` (a step is the model's fields before and after, its axioms
worked out on request); the SH-1 status in [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §10 ("a
step that changes shapes says so in its summary and has no axioms"); `Difference` in
`src/projects/contracts.ts`.

**What.** A step that changes something other than the ontology (a shape set, a data graph's
reference) has an empty list of axioms and is named only by its summary. Nothing records which
artifact a step changed. With logical data models (roadmap §1.3) most edits of a session may be
of an LDM, and the history, versions and, on the server, change entries need to tell them apart
from ontology changes.

**Remediation.** Part of roadmap LM-1: a step names the artifacts it changed (`ontology`,
`shapes`, `dataGraphs`, `ldm:{id}`), read from the fields its patch replaced; LDM edits have their
own contract, the logical change set, never axioms (ADR-023); the version difference gains a list
per LDM; on the server, change entries say which artifact they belong to
([DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §11.7).

**Status, 2026-10-17: done (roadmap LM-1)** for the page. `artifactsOf` in `src/editing/local.ts`
says which artifacts a step changed (`ontology`, `shapes`, `dataGraphs`, `picture`, `ldm:{id}`),
read from the parts of the model its patch replaced, a step that only moved terms being the
picture's; an LDM step is named for its LDM ("Changed the logical model “Films”"). LDM edits are
logical change sets (`src/logical/contracts.ts`), never axioms, and the version difference has a
list per LDM. Left for the server: change entries that say their artifact (LM-5).

### TD-20 The ontology's revision follows a hand-kept list of model fields — Medium

**Where.** `sameMeaning` and `stable` in `src/model/stable.ts`; `revisionOf` in
`src/structure/local.ts`, which every cached result (reasoning, validation, shape proposals, the
assistant's proposals) is keyed by.

**What.** Whether two models "mean the same" is decided by comparing a list of fields written out
by hand (relations, props, shape sets, data graphs, …), and `revisionOf` gives the same revision
to models that do. A field added to the model and left off the list is invisible to every
revision-keyed result: anything that reads through `stable()` sees the earlier copy. A field put
on the list moves the ontology's revision whenever it changes. Neither is right for logical data
models: an LDM edit must not move the ontology's revision (NFR-17), and must not be read stale.

**Remediation.** Part of roadmap LM-1: the list becomes the ontology's parts, named as such and
covered by a test that fails when a field of `Model` is in neither the ontology's parts nor a
declared list of other artifacts' parts; LDMs get revisions of their own and are never read
through `stable()`.

**Status, 2026-10-17: done (roadmap LM-1).** `MODEL_PARTS` in `src/model/types.ts` says of every
field of `Model` whether it is the ontology's (`revision`), the picture's, a logical model's or
the file's; it is a `Record` over the model's keys, so a field left out does not compile, and
`stable.ts` follows the ontology's parts and nothing else. Doing so put fields on the list
that had been left off it: the statements kept as written (`unmapped`), and the properties names
and descriptions are read from with their languages (`namedBy`, `describedBy`, `nameLang`,
`descriptionLang`), which now move the revision as they should.
`src/model/stable.test.ts` checks that a kept statement moves the revision and an LDM, a style, the
layout or a term's place do not. Each LDM has a revision of its own, which moves with every change
to it and nothing else.

## 4. Architectural risks

### AR-01 The TypeScript model and the server's axiom model drift apart

Once the OWL API is canonical on the server, the same ontology exists in two shapes. Without a
discipline, an edit that is valid in one is rejected or reinterpreted in the other.

*Mitigation.* One contract for edits (axiom-level change sets), one shared set of fixture
ontologies, and a conformance suite that runs every fixture through both implementations and
compares the result as RDF. The existing `http.test.ts` files do exactly this for two services
already.

*Status, 2026-10-15.* The contract exists (`src/editing/contracts.ts`), and the local side of the
conformance suite with it: `src/editing/local.test.ts` takes edits made in the editor, describes
each as a change set, applies that to the model before the edit, and compares the statements with
those of the model after it.

### AR-02 OWL 2 DL reasoning does not finish on large or expressive ontologies

OWL 2 DL entailment is N2EXPTIME-complete in the worst case. HermiT is fast on many real
ontologies and can also run out of time or memory on others, with no reliable way to predict
which.

*Mitigation.* Detect the OWL 2 profile before reasoning; use ELK for ontologies in OWL 2 EL;
bound time and memory per job; report *partial* and *failed* as the service does today; never
block editing on a reasoner. See [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §7.

### AR-03 JVM dependency alignment

The working combination is the one inside `robot.jar` (OWL API 4.5.29, HermiT 1.4.5.456, ELK,
Jena 3.17.0 with TDB1). The target adds Spring Boot and Jena TDB2. Jena 5 requires Java 17 and
Jena 6 is announced with Java 21 as its minimum; Spring Boot 4 requires Java 17 or later; ELK
0.6.0 supports OWL API 5. Which HermiT build works with which OWL API major version must be
confirmed by building, not assumed.

*Mitigation.* A one-day spike at the start of Phase 3: a Gradle or Maven build with declared
versions, the service's existing tests green, before any feature work.

### AR-04 A local copy and a server copy of the same project conflict

Local-first means a project can be edited offline while the server copy moves on.

*Mitigation.* No live synchronisation before Phase 5. Until then: explicit *push* and *pull*,
each carrying the revision it was based on; a push against a newer server revision is refused
with the `stale-revision` code the contracts already define, and the user pulls first.

### AR-05 Breadth outruns one developer

Thirteen functional modules are in scope. The codebase is already broad (eight views).

*Mitigation.* The MVP in [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) §4 is deliberately
narrow: lossless OWL, expression editing, versions, tabular import. Everything multi-user is
after it.

### AR-06 Keeping every version as a full graph multiplies storage

A named graph per revision copies every triple each time.

*Mitigation.* Store change sets for every revision and full snapshots only for tagged releases;
rebuild an arbitrary revision from the nearest snapshot.

### AR-07 A server adds an attack surface the app has never had

Today nothing listens beyond `127.0.0.1`. A hosted backend parses untrusted RDF/XML (XML
external entities), runs user-written SPARQL (unbounded queries), accepts uploads and holds
credentials.

*Mitigation.* [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §9: parser hardening, query time
and result limits, read-only SPARQL, per-project authorisation checked in one place.

### AR-08 SVG has a ceiling that culling does not remove

Culling bounds what is drawn by what is visible; zoomed out over a large graph, everything is
visible.

*Mitigation.* Subgraph-first above a size threshold, level of detail, and as a last step a
Canvas 2D layer for edges only, keeping nodes in SVG for accessibility and export.

### AR-09 The browser evicts locally stored work

IndexedDB and `localStorage` can be cleared by the browser under storage pressure or by the
user.

*Mitigation.* Request persistent storage, show when the last file export or server push was,
and prompt before long unsaved stretches.

### AR-10 AI suggestions introduce wrong axioms or leak content

*Mitigation.* Suggestions are proposals that a person accepts one at a time, recorded with their
origin (the mapping workflow already works this way: `MappingMeta.method`, `status`); no
ontology content leaves the machine unless a provider has been configured explicitly.

*Status (2026-10-16).* The assistant (README, *The assistant*) holds to this: a proposal is
compiled to a change set, checked by the editor's rules and the fast reasoner (inconsistency,
classes made unsatisfiable), shown with its axioms and before and after, and applied only on
*Accept*, as one edit named *Assistant: …*; one checked against an earlier revision is refused.
Nothing is sent until a provider and key are set and a question asked; the ontology is sent only
as the bounded answers of read-only lookups, each listed in the panel; labels and annotations
are passed as data the model is told never to follow. The key is held in memory only, bound to
one endpoint, redacted from errors, and found in no storage or export (`e2e/assistant.mjs`). The
local service forwards to private addresses only when started with `--allow-local-ai`, and
connects to the very address it checked, so DNS rebinding is not followed
(`src/ai/proxyTls.test.ts`). A proposal can be checked by HermiT before it is accepted, where
the fast reasoner is incomplete; with *Show me each lookup* on, nothing of the ontology is sent
without the user's say. Left: a proposal's origin is kept only in the history's name for it;
the HermiT check is asked for, not made by itself.

**Risks introduced by ontology-to-relational data integration.** Added with the extension of 2026-10-13 ([SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §12).
None is debt: nothing of this capability is built yet. They are listed so that each is designed
against from the first stage. **Dormant since 2026-10-17**, when the track was deferred
([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §11): they apply again if it is resumed.

### AR-11 A database credential or row data leaks through the new backend surface

Until now the application held no secret and made no outbound connection except to fetch a
public ontology. Data integration adds stored or session credentials, connections into private
networks, and real data passing through previews.

*Mitigation.* The measures of [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §12.9 and the
principles of [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §10.6 are requirements of the first
stage: structured connection definitions with no client-supplied connection string, secrets
that are write-only, host allow-lists in the Server profile, and tests that search storage,
responses, exports and logs for a known test password (NFR-12).

### AR-12 The preview evaluator and the query engine read one mapping differently

The preview is computed by a small evaluator written for the purpose; virtual graphs and
materialisation are computed by Ontop. If the two disagree on a corner of R2RML (encoding in a
template, a `NULL` in a join, a datatype's lexical form), the user is shown one thing and gets
another.

*Mitigation.* The evaluator supports a stated subset and is held to the W3C R2RML test cases
for it. From stage DI-4, a cross-check suite materialises every fixture mapping with the engine
and compares, row for row, with the preview. Where the evaluator cannot be sure, the preview
says "computed by the engine" and asks it.

### AR-13 The OBDA engine's dependencies and limits constrain the backend

Ontop brings its own versions of the OWL API and other libraries, serves one relational source
per instance, and reasons in OWL 2 QL. Embedding it would tie the backend's versions to its.

*Mitigation.* It runs as a separate process behind the API (ADR-016), which its own
documentation recommends over the library. Its limits are stated to the user with each answer.
A spike at the start of stage DI-4 confirms the target databases and the SPARQL features that
matter before anything is built on it; the fallback for materialisation alone is another R2RML
processor.

### AR-14 A schema changes and mappings break unnoticed

Databases change on their owners' schedule. A dropped or retyped column makes a rule wrong
without any edit to the mapping.

*Mitigation.* Every mapping revision records the schema fingerprint it was written against.
A refresh compares fingerprints table by table and lists the rules affected (FR-M15-13); a
virtual graph is not served on a fingerprint it was not checked against without a warning.
Detection is on refresh, not continuous: the product does not watch databases.

### AR-15 Database constraints or query answers are taken for ontological facts

Two errors of the same kind: turning `NOT NULL`, `UNIQUE` and foreign keys into OWL axioms
because they look similar, and reading a query answer over the data that happens to be stored
as an entailment.

*Mitigation.* ADR-017: no axiom from a constraint without confirmation, and proposals default
to SHACL shapes. Answers from data carry their source and the reasoning applied
([SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §12.7). NFR-14 is tested.

### AR-16 The product overloads or exposes a production database

A mapping over a large table, a query that rewrites into an expensive join, or a
materialisation started at the wrong hour can hurt a system the product does not own.

*Mitigation.* Read-only connections and transactions; a statement time limit, a row limit and a
small connection pool per source; jobs sized and confirmed before they start; the advice, on
the connection form, to point the product at a replica where there is one.

**Risks introduced by ontology-driven logical data modelling.** Added on 2026-10-17 with the
roadmap's logical data modelling track ([SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §13).
LM-1 to LM-4 of the track are built in the browser (2026-10-17); each risk below says what their
implementation holds to, and what remains open until LM-5 and the platform work.

### AR-17 The logical data model becomes a projection of the ontology, or a second ontology

The easy implementation makes an entity of every class and an attribute of every property, and
keeps them in step mechanically; or it puts OWL constructs into the LDM so that nothing is lost.
Either way the LDM stops being a design of its own.

*Mitigation.* ADR-022 and ADR-026: a metamodel with no OWL construct and no physical one;
transformation as proposals over a chosen scope, many to many (FR-M18-6); elements with no
semantic source are normal, not findings; the LDM is edited freely after it is made.

*Status, 2026-10-17: held to in LM-1 to LM-4.* The metamodel (`src/logical/contracts.ts`) has
no OWL construct; transformation proposes over a chosen scope; an element with no semantic
source is ordinary, and every element of an LDM is edited freely after it is accepted.

### AR-18 Open-world axioms become closed-world constraints by default

`some`, `min`, `exactly`, domains and ranges look like mandatory fields and foreign keys. Turned
into constraints by default they make an application refuse records the domain allows: a film
whose director is unknown. The same error ADR-017 and ADR-020 guard against for database
constraints and shapes.

*Mitigation.* ADR-024: candidate constraints are never chosen to begin with, and each says what
the axiom means and what the constraint would require; NFR-18 is a test; the assistant's LDM
proposals follow the same rule.

*Status, 2026-10-17: held to in LM-3.* Restrictions and `owl:hasKey` are proposed as candidates
only, never chosen by default (`src/traceability/transform.test.ts`), and are written only when
the reviewer takes them.

### AR-19 Synchronization overwrites what the designer decided, or mappings drift unnoticed

An ontology change that rewrites an LDM undoes design decisions; one that is not reported leaves
the LDM silently out of step with the domain.

*Mitigation.* ADR-025: mappings record their sources by axiom and their origin revision; status
(current, stale, broken) is worked out against the ontology as it is; customisation is detected
against what a mapping last made, and a customised element is only ever proposed for; impact
reports per LDM (FR-M18-11).

*Status, 2026-10-17: built in LM-4.* `src/traceability/impact.ts` works out status, coverage,
impact and synchronization against the ontology; every proposal is reviewed in the *Impact…*
dialog, a customised element is flagged and never chosen to begin with, and an accepted
proposal is one undoable LDM change set that leaves the ontology untouched.

### AR-20 LDM edits invalidate what was worked out for the ontology, or are read stale

Every result in the application is keyed by the ontology's revision (TD-20). If LDM edits move it,
each one discards reasoning and validation results and makes pending proposals out of date; if
they are kept out of it carelessly, anything reading through `stable()` sees an old LDM.

*Mitigation.* Revisions per artifact from LM-1 (ADR-023); a test that an LDM edit leaves the
ontology's results and proposals current (NFR-17); LDMs never read through `stable()`.

*Status, 2026-10-17: built in LM-1 and LM-4.* Each LDM has its own revision, and the NFR-17 test
(`src/logical/logical.test.ts`) holds that no artifact moves another's revision through LM-4's
edits, transformation and synchronization.

### AR-21 A second editor, with its diagram, outruns one developer

An LDM workspace with an ER diagram is an editor the size of the ontology's, on top of the
remaining Phase 2 tasks (AR-05).

*Mitigation.* One notation; the existing layouts, geometry and culling; no free drawing; forms
first, the diagram as a view of the same operations; the proposal and difference machinery of
SH-3 and 2.3 reused for review and comparison; several diagrams per LDM and formal rules deferred
(FR-M17-13, FR-M17-9).

*Status, 2026-10-17: the editor was built that way (LM-2).* One notation, forms first with the
diagram as a view; several diagrams per LDM and formal rules remain deferred.

## 5. Refactoring priorities

In the order they should be done. Each step leaves the application working and shippable.

| Order | Item | Why first |
| --- | --- | --- |
| 1 | TD-15 CI and baselines | Protects everything that follows; cheap. |
| 2 | TD-03, TD-18 Stable ids and IRIs for every entity | Every contract depends on identity. |
| 3 | TD-01 (step 1) Keep unmapped triples | Stops data loss immediately, before any editor work. |
| 4 | TD-04, TD-06 Split the store; one function per rule | Makes the document slice a thing that can sit behind a service. |
| 5 | TD-08, TD-09 Reasoning and validation as worker jobs | Removes the main-thread stalls and fixes the job shape the server will reuse. |
| 6 | TD-11 Working copy to IndexedDB | Removes the 5 MB ceiling. |
| 7 | TD-10 Canvas culling | Raises the Graph view's limit by an order of magnitude. |
| 8 | TD-02 Structured class expressions | The largest modelling gap; needs 2 and 3. |
| 9 | TD-12 Versions and diff | Needs 2; unlocks governance and publishing. |
| 10 | TD-05 Views behind services | Continuous, one view per release. |
| 11 | TD-14, TD-13 Service to Spring Boot; remaining export syntaxes | Start of Phase 3. |
| 12 | TD-19, TD-20 Steps that name their artifact; revisions per artifact | Before any LDM edit exists: part of roadmap LM-1. Done 2026-10-17. |
| — | TD-07, TD-16, TD-17 | When the area is next changed. |
