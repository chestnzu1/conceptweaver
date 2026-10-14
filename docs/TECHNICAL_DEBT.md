# Technical Debt and Architectural Risk Assessment

Assessed against the repository as of 2026-10-13 (branch `instance-of-and-iri-suffix`, commit
`ce6419e`). Companion documents: [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md),
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
unusually well tested for its age (42 unit-test files with 603 tests, and 21 browser scripts,
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
| AR-11 | A database credential or row data leaks through the new backend surface | Medium | High |
| AR-12 | The preview evaluator and the query engine read one mapping differently | Medium | High |
| AR-13 | The OBDA engine's dependencies and limits constrain the backend | Medium | Medium |
| AR-14 | A schema changes and mappings break unnoticed | High | Medium |
| AR-15 | Database constraints or query answers are taken for ontological facts | Medium | High |
| AR-16 | The product overloads or exposes a production database | Low | High |

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
- Domains, ranges and hierarchies of annotation properties, the ontology's own annotations
  beyond name and description, and `owl:imports` are not kept (README, *OWL constructs without
  an editor*).
- A model has one language (`Model.lang`); labels in other languages survive only as extra
  annotation fields.

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
  into a "plain relationship";
- annotation properties are not entities at all.

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
lost five fewer statements for it). Annotation properties are still not entities.

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

### TD-09 Validation runs on the main thread and cannot be cancelled — Medium

**Where.** `validate` in `src/model/validation.ts:637`; README, *Validation: what is and is not
covered* ("runs in the page, in steps, not in a background thread; a run cannot be cancelled").

**Remediation.** Same worker and job model as TD-08.

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

## 4. Architectural risks

### AR-01 The TypeScript model and the server's axiom model drift apart

Once the OWL API is canonical on the server, the same ontology exists in two shapes. Without a
discipline, an edit that is valid in one is rejected or reinterpreted in the other.

*Mitigation.* One contract for edits (axiom-level change sets), one shared set of fixture
ontologies, and a conformance suite that runs every fixture through both implementations and
compares the result as RDF. The existing `http.test.ts` files do exactly this for two services
already.

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

**Risks introduced by ontology-to-relational data integration.** Added with the extension of 2026-10-13 ([SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §12).
None is debt: nothing of this capability is built yet. They are listed so that each is designed
against from the first stage.

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
| — | TD-07, TD-16, TD-17 | When the area is next changed. |
