# Product Requirements Document

ConceptWeaver: from a browser-based ontology editor to a platform for semantic modelling,
ontology management and ontology-driven logical data modelling.

**Realigned on 2026-10-17.** The product's objective is to use an OWL ontology as the semantic
foundation for designing relational logical data models (LDMs): OWL ontology → semantic-to-logical
transformation → editable logical data model → semantic traceability and change impact analysis.
Modules M17 and M18, journeys J13 to J15, NFR-17 to NFR-20 and FR-M12-8 to FR-M12-11 were added for
it. Physical data models, database schema generation, SQL DDL and deployment are out of scope.

The data-integration scope (modules M14 to M16, journeys J10 to J12, NFR-12 to NFR-16, and the
requirements of other modules that serve it), added on 2026-10-13, is **deferred**: kept with its
identifiers, marked so, and not scheduled
([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §11).

Current state assessed against the repository as of 2026-10-13 (commit `ce6419e`). Companion
documents: [EXECUTIVE_SUMMARY.md](EXECUTIVE_SUMMARY.md),
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md), [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md),
[DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md), [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md).

## 1. How to read this document

**Status labels.** Every capability is marked with what the code shows, not with what was
intended:

| Label | Meaning |
| --- | --- |
| **Existing** | Confirmed in the current codebase. |
| **Partially Implemented** | Present but incomplete; the gap is stated. |
| **Recommended** | Proposed; not in the code. |
| **Future** | Long-term; scoped but not specified in detail. |
| **Deferred** | Specified, then set aside by a decision of the product owner (2026-10-17: data integration). Kept with its identifier and, in its table, the status it had; not scheduled. |

**Priorities.**

| Priority | Meaning | Roadmap |
| --- | --- | --- |
| **P0** | Needed for the MVP: a single-user editor an ontology engineer can trust with a real ontology. | Phases 1–2 |
| **P1** | Needed for the platform: logical data modelling from the ontology, server-side storage, scale, history. | The LDM workstream of Phase 2; Phases 3–4 |
| **P2** | Team and enterprise use. | Phase 5 |
| **P3** | Long-term. | After Phase 5 |

**Identifiers.** Modules are `M1`–`M18`; functional requirements `FR-Mx-n`; non-functional
requirements `NFR-n`; journeys `J1`–`J15`. Identifiers of deferred requirements are never reused. Debt items (`TD-n`), risks (`AR-n`) and decisions
(`ADR-n`) are defined in the companion documents.

## 2. Product vision and positioning

### 2.1 Vision

Ontology engineering that starts in a browser tab and grows into a managed platform, without
changing tools on the way: the same application for sketching a first model on a laptop and for
maintaining a governed, versioned, reasoned-over ontology in a team.

And an ontology that does not stop at the diagram. The same tool turns the ontology into the
foundation of application data design: from what the domain *is*, the logical data models of
the applications that hold its data are designed, by transformations the user reviews, and kept
traceable to the ontology as both evolve. Ontology, constraint model (SHACL shape sets) and
logical data models are three artifacts, each visible, each owned, related by mappings and none
generated from another by itself.

### 2.2 Mission

Make formal ontologies approachable without making them informal. Every picture the product
draws is a faithful view of OWL axioms, every limit of a reasoner or an import is stated to the
user, and nothing is lost between opening a file and saving it. The same holds across the
bridge to data design: an open-world axiom is never passed off as a mandatory data constraint, a
design decision is never passed off as an ontological fact, and an ontology change never
overwrites a decision the designer made.

### 2.3 Core value proposition

| For | The product offers | Unlike |
| --- | --- | --- |
| People who model | A visual, immediate editor where a line between two boxes is a precise OWL statement, checked as it is drawn. | Form-based editors, where the picture is an afterthought. |
| People who must be right | Two reasoners, SHACL and quality rules in one place, each result saying what it covers and for which revision. | Tools that report "consistent" without saying by what standard. |
| People who start small | No installation, no account; a file or a URL is enough. | Desktop installs and enterprise server deployments. |
| People who end up large | The same interface over a server-side store, with history, review and publishing. | Outgrowing a lightweight tool and migrating to another. |
| People who design application data | Logical data models derived from the ontology by reviewed transformation, edited freely, and traced to it: which element came from which axiom, and what an ontology change means for each model. | Designing data models in one tool from a domain model kept in another, with the link between them in people's heads. |

### 2.4 Target users

| User | What they do | What they need most | Served today |
| --- | --- | --- | --- |
| **Ontology engineer** | Authors and maintains OWL ontologies; uses restrictions, defined classes, reasoning. | Complete OWL 2 editing, lossless files, reliable reasoning, explanations. | Partly: authoring of class expressions and lossless round trips are missing (TD-01, TD-02). |
| **Knowledge engineer / taxonomist** | Builds vocabularies, taxonomies, thesauri. | Fast hierarchy editing, labels in several languages, SKOS export, bulk import. | Well: labels in several languages with a display language, SKOS export, and CSV, TSV and Excel through a mapping screen. |
| **Data architect** | Aligns a domain model with data assets and standards; designs the logical data models of applications from it. | Reuse of standard ontologies, SHACL for data; logical models derived from the ontology, with keys, cardinalities and rules decided by them, and traced back. | Well for reuse, SHACL and import; logical models are authored by hand (M17), derived from the ontology with reviewed proposals (M18, LM-3), and traced to it with impact reports and reviewed synchronization (M18, LM-4). |
| **Logical data modeller / application designer** | Designs the entities, attributes, relationships and keys an application stores. | An ER editor; a starting point from the domain model that does not decide for them; to know what an ontology change means for their model. | In part: an LDM workspace and ER diagram (M17), proposals derived from the ontology, none imposed (M18, LM-3), and every element traced to its sources, with what an ontology change means for the model (M18, LM-4). |
| **Semantic modeller / analyst** | Reads and reviews models more than writes them. | Clear pictures, hierarchy exploration, search, comparison. | Well. |
| **Data governance professional** | Owns definitions, status, stewardship. | Metadata, lifecycle status, change history, approval. | Metadata yes; history and approval no. |
| **Data engineer / integration specialist** (deferred track) | Makes data from operational databases available in shared terms. | To see a schema, map it to an ontology without guesswork, check the result on real rows, and hand the mapping to a standard engine. | Not at all; deferred. |
| **Database architect** (deferred track) | Owns physical schemas. | Assurance of read-only, bounded access; to see which columns a semantic layer depends on before changing them. | Not at all; deferred. |

### 2.5 Primary use cases

1. Sketch a domain model visually and export it as valid OWL.
2. Open an existing ontology, understand its structure, and extend it.
3. Check a model: consistency, unsatisfiable classes, data against shapes, modelling quality.
4. Build a vocabulary or taxonomy from a spreadsheet.
5. Reuse terms from standard ontologies and record mappings to them.
6. Maintain an ontology over time: versions, differences, releases.
7. Share a model with people who do not have the tool.
8. (Later) Curate an ontology as a team, with review and governance.
9. (Deferred) Inspect a relational database's schema beside the ontology.
10. (Deferred) Map tables, columns and keys to classes and properties, and check the mapping on
    real rows.
11. (Deferred) Ask for relational data in the ontology's terms, without copying it.
12. Design a logical data model for an application from the ontology, deciding keys,
    cardinalities and rules oneself.
13. Edit a logical data model as a model of its own: entities, attributes, relationships, keys,
    specializations, rules, on an ER diagram.
14. Know where each element of a logical model came from in the ontology, and which elements
    have no semantic source.
15. See what an ontology change means for every logical model derived from it, and bring each up
    to date by reviewed proposals.

### 2.6 Competitive positioning

Characterisations of other products are from their public documentation and general knowledge
as of October 2026. PoolParty and WebProtégé were checked against their documentation while
writing; the others were not re-verified. Check before quoting externally.

| Capability | Protégé (desktop) | WebProtégé | PoolParty | VocBench | ConceptWeaver today | ConceptWeaver target |
| --- | --- | --- | --- | --- | --- | --- |
| Runs without installing | No (Java desktop) | Yes (hosted or self-hosted) | Yes (server product) | Yes (server product) | **Yes, no server at all** | Yes |
| Complete OWL 2 authoring | Yes | Configurable; lightweight by default | Ontology management alongside SKOS | Yes | Partial (TD-02) | Yes |
| Diagram-first editing | Plugins, read-mostly | No | Visualisation | No | **Yes: the canvas is the editor** | Yes |
| DL reasoning | Yes, several reasoners | — | Not its focus | Rule-based, from its triple store | HermiT via local service; rule reasoner in the page | HermiT and ELK, as jobs |
| SHACL validation | Plugin | — | — | — | **Yes, with a shape form** | Yes |
| Tabular import with mapping | Plugin (Cellfie) | — | Yes | Yes (Sheet2RDF) | Pasted rows only | Yes |
| Versions and change history | No (files) | **Yes, full revision history** | Yes | Yes | **No** | Yes |
| Collaboration, roles, review | No | **Yes** | **Yes, with approval workflow** | **Yes** | No | Phase 5 |
| Taxonomy and thesaurus focus | No | No | **Core strength** | **Core strength** | A SKOS model type | Yes |
| Text mining, entity extraction | No | No | **Yes** | No | No | Not planned |
| Logical data models derived from the ontology, traced to it | No | No | — | — | No | Yes (M17, M18) |
| Cost and openness | Free, open source | Free, open source | Commercial | Free, open source | No licence file in the repository | To be decided |

A dash means the point was not established from the sources consulted; it is not a claim that
the product lacks the capability.

Sources consulted on 2026-10-13:
[PoolParty overview](https://help.poolparty.biz/en/poolparty-overview.html) and
[system architecture](https://help.poolparty.biz/en/poolparty-overview/poolparty-system-architecture.html);
[Protégé and WebProtégé product page](https://protege.stanford.edu/software),
[WebProtégé backend repository](https://github.com/protegeproject/webprotege-backend-service) and
[the 2014 WebProtégé paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC4176057).

### 2.7 Differentiation opportunities

1. **Zero-install, local-first.** No comparable tool with this breadth runs with no server.
   This must survive every phase (ADR-001).
2. **The diagram is the ontology.** Drawing a line creates the right axiom or is refused with a
   reason (`src/model/relating.ts`, `reconnect.ts`). Competitors visualise; this product edits
   visually.
3. **Honest results.** Reasoner status as *complete*, *partial* or *failed*; imports that say
   what they could not read; results marked stale. This is a trust feature and is rare.
4. **One tool across sizes.** The Structure Explorer already handles 200,000 classes through a
   service interface; the same design applied everywhere removes the usual reason to switch
   tools.
5. **Explanations in words.** The in-page reasoner derives each inference from stated facts and
   says so in sentences; HermiT findings carry justifications.

6. **From meaning to logical design, traceably.** The tools that author ontologies and the
   tools that design logical data models are mostly different tools, and the link between a
   domain model and an application's data model lives in documents or in people's heads. Here a
   logical model is proposed from the live ontology, every constraint decided by the designer,
   every element traced to the axioms it came from, and every ontology change reported against
   every model derived from it. (The earlier sixth point, mapping the ontology to existing
   databases, is deferred with the data-integration track.)

Where the product should *not* compete: enterprise text mining and search (PoolParty's
middleware), plug-in ecosystems (Protégé's), query engines, and physical database design and
deployment (data modelling suites' forward engineering to DDL).

**Positioning in logical data modelling.** From general knowledge, not verified for this
document: established data modelling tools (erwin Data Modeler, ER/Studio, SAP PowerDesigner and
others) author conceptual, logical and physical models and generate DDL, and some import
glossaries or business vocabularies; OWL editors stop at the ontology. A tool in which logical
models are derived from an OWL ontology by reviewed transformation and kept traceable to its
axioms is the gap this product aims at. Verify before using externally.

**Positioning in data integration (deferred).** From general knowledge, with Ontop's facts checked against
its documentation (see [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §14): Ontop is the
leading open-source virtual-knowledge-graph engine, with mapping authoring available as text in
a Protégé plug-in; commercial knowledge-graph platforms offer virtual graphs and visual mapping
as part of a server product. No lightweight, standards-first tool combines visual ontology
authoring with visual, validated R2RML mapping. That gap is the opportunity; verify the
competitive claims before using them externally.

### 2.8 Scope: MVP and beyond

**MVP (P0): "trust it with a real ontology".** A single user, in the browser, optionally with
the local companion.

| In the MVP | Why |
| --- | --- |
| Lossless open and save of OWL 2 ontologies (FR-M1-8, FR-M11-2) | Without it no professional can adopt the tool. |
| Structured class expressions with a Manchester-syntax editor (FR-M2-2, FR-M2-3) | The core of OWL authoring. |
| Stable identity for every entity (FR-M1-2, FR-M1-3) | Everything else depends on it. |
| Reasoning and validation that do not block the page (FR-M3-1, FR-M4-4) | Usability at a few thousand classes. |
| Graph view usable at 10,000 classes (FR-M5-5, FR-M5-6) | Stated scale target. |
| Named versions with a diff (FR-M10-1 to FR-M10-3) | Minimum change tracking. |
| CSV and Excel import with column mapping (FR-M7-2 to FR-M7-4) | Most common way real vocabularies arrive. |
| Continuous integration and performance baselines | Keeps the above true. |

**Not in the MVP, deliberately:** accounts, sharing, server storage, review workflows,
publishing portals, AI assistance, SWRL, branches.

**Long-term scope** is the remainder of this document: server-side storage and scale (P1),
collaboration and governance (P2), AI assistance and publishing infrastructure (P2–P3).

**The logical data modelling MVP: "design a logical model from the ontology, and trust the
link".** After the first MVP (reached 2026-10-16), in the browser, with no server.

| In the LDM MVP | Why |
| --- | --- |
| Logical data models as an artifact of their own, several per project, saved and versioned with it (FR-M17-1 to FR-M17-8, FR-M17-14) | The thing designed has to exist on its own before it can be derived or traced. |
| The LDM workspace and an ER diagram (FR-M17-10 to FR-M17-12) | A logical model is read and reviewed as a diagram. |
| Proposals from the ontology, reviewed, with no constraint imposed (FR-M18-1 to FR-M18-6, NFR-18) | The product's objective, and its main risk if done carelessly. |
| Semantic mappings, stale detection and impact reports with reviewed synchronization (FR-M18-8 to FR-M18-14) | What makes the derivation last beyond the first day. |

**Not in it, deliberately:** physical models and DDL (out of scope altogether), several
diagrams per LDM, formal rule expressions, shape sets as transformation input, LDM assistance,
server-side LDMs.

**A second MVP, for data integration: "map one database, and trust the mapping"** (deferred,
2026-10-17). It did not change the first one, and could not precede the backend, because a
browser cannot connect to a database.

| In the data-integration MVP | Why |
| --- | --- |
| Connect one PostgreSQL database, read-only, through the local companion (FR-M14-1 to FR-M14-3, FR-M14-9) | One dialect done properly before three done thinly (ADR-015). |
| Discover and browse its schema, with keys and relationships (FR-M14-4 to FR-M14-7) | The physical side has to be seen before it can be mapped. |
| Map classes to tables or views, data properties to columns, object properties to foreign keys, with IRI templates (FR-M15-1 to FR-M15-5) | The core of every mapping. |
| Preview the triples from real rows; check the mapping in the Validation view (FR-M15-7, FR-M15-9) | A mapping nobody has seen run is a guess. |
| The three-area mapping editor (FR-M15-8) | The differentiator. |
| Export as R2RML (the export half of FR-M15-10) | What makes it useful beyond this product on day one. |

**Not in it, deliberately:** other dialects, SQL written by hand, stored credentials, R2RML
import, materialisation, virtual knowledge graphs, several databases, writing to a database.

## 3. Current capability at a glance

| Module | Status | Strongest evidence | Largest gap |
| --- | --- | --- | --- |
| M1 Modelling and entity management | **Existing** | `src/components/Entities.tsx`, `EntityEditor.tsx`, `src/model/iri.ts`, `src/model/identity.ts` | Lossless round trip (property identity done 2026-10-14) |
| M2 Axiom and restriction editing | **Partially Implemented** | `src/model/axioms.ts`, `props.ts`, `expressions.ts`, `src/components/AxiomParts.tsx` | General class axioms and SWRL rules have no editor |
| M3 Reasoning | **Existing**, job handling partial | `src/model/reasoner.ts`, `reasoning.ts`, `src/reasoning/`, `reasoner/ReasonerService.java` (HermiT and ELK, chosen by profile) | No server-side jobs or size budget |
| M4 SHACL and quality | **Existing** | `src/model/validation.ts`, `shacl.ts`, `quality.ts`, `src/validation/` | No SHACL-SPARQL; no server engine; keys and nested class expressions are not proposed as shapes (SHACL track, SH-4 and SH-5) |
| M5 Graph and subgraph | **Existing** | `src/components/Canvas.tsx`, `src/layout/`, `src/model/subgraph.ts` | About 2,000 terms |
| M6 Structure exploration | **Existing** | `src/structure/` | No ontology-level comparison |
| M7 Bulk import and mapping | **Partially Implemented** | `src/model/bulk.ts`, `src/mapping/`, `src/import/` | No update mode, no server job, no RML |
| M8 Reuse and alignment | **Existing** | `src/model/external.ts`, `alignment.ts`, `matcher.ts` | Imports not transitive or declared |
| M9 Search and SPARQL | **Existing** | `src/entities/`, `src/model/sparql.ts` | Asserted graph only |
| M10 Versioning | **Partially Implemented** | `src/projects/` (named versions, differences, restore, in this browser; 2026-10-16) | No history of one entity, no server revisions, no releases |
| M11 Publishing and export | **Partially Implemented** | `src/model/files.ts`, `htmlExport.ts`, `src/io/` | No generated documentation; no publishing |
| M12 AI assistance | **Partially Implemented** | `src/ai/`, `src/components/assistant/` (the assistant, bring your own key; 2026-10-16); matcher seam in `matcher.ts` | No mapping, drafting or query suggestions |
| M13 Collaboration and governance | **Partially Implemented** | `src/model/governance.ts` | No users, review or audit |
| M14 Database connectivity and schema exploration | **Deferred**; not implemented | Free-text `database`, `schema`, `table`, `column` fields in `src/model/governance.ts` | Everything; needs the backend |
| M15 Ontology-to-relational semantic mapping | **Deferred**; not implemented | Reusable parts only (entity lists, validation, matcher, IRI handling) | Everything |
| M16 Relational data access: materialisation and virtual knowledge graph | **Deferred**; not implemented | SPARQL view over the ontology (`src/model/sparql.ts`) | Everything |
| M17 Logical data model authoring | **Partially Implemented** | `src/logical/` (the metamodel, its query and edit services, rules, findings; 2026-10-17), the LDM workspace and ER diagram (`src/components/LogicalData.tsx`, `LdmDiagram.tsx`) | Formal rule expressions (FR-M17-9), several diagrams (FR-M17-13), LDMs on a server (roadmap LM-5) |
| M18 Ontology-to-LDM transformation and semantic traceability | **Partially Implemented** | `src/traceability/` (proposals from the ontology under a saved configuration; mappings, traceability, impact and reviewed synchronization; 2026-10-17), the *Derive from the ontology…* dialog (`src/components/TransformationDialog.tsx`), the LDM view's *Traceability* part (`src/components/Traceability.tsx`) and its *Impact…* dialog (`src/components/ImpactDialog.tsx`) | Shape sets as a further input (FR-M18-7); mappings exported as RDF with PROV-O (FR-M18-15) |

## 4. Non-functional requirements (apply to every module)

| Id | Requirement | Measure |
| --- | --- | --- |
| NFR-1 | **Semantic fidelity.** Opening an OWL 2 ontology and saving it unchanged yields the same axioms. | Axiom-set equality (OWL API structural comparison) on a corpus of public ontologies; zero unreported loss. |
| NFR-2 | **Honesty.** Any result that is incomplete, stale or produced under a limit says so where it is shown. | Review checklist per feature; existing behaviour for reasoning is the reference. |
| NFR-3 | **Responsiveness.** No interaction blocks the page for more than 100 ms; longer work shows progress and can be cancelled. | Main-thread long-task measurement in the browser checks. |
| NFR-4 | **Scale, Local profile.** 10,000 classes: Entities, Structure and search answer within 200 ms; Graph view pans and zooms at 30 frames per second on a subgraph of 500 terms. | Benchmarks in CI. |
| NFR-5 | **Scale, with a server.** 100,000 classes and 1,000,000 triples: the same interaction targets, with the ontology never fully loaded into the browser. | Benchmarks against a seeded store. |
| NFR-6 | **Local-first.** Every P0 feature works with no network and no server. | Browser checks run offline. |
| NFR-7 | **Accessibility.** Text contrast of 4.5:1, pointer targets of 24 px, keyboard access to every function, no information by colour alone. | `e2e/ui-audit.mjs` (existing) extended with keyboard checks. |
| NFR-8 | **Undo.** Every change to an ontology is one undoable step and, once versions exist, one recorded change. | Unit tests per command. |
| NFR-9 | **Compatibility.** Model files written by earlier versions open in later ones. | A fixture file per format version, opened in CI. |
| NFR-10 | **Privacy.** No ontology content leaves the user's machine unless they chose a server or a provider. | Network assertions in browser checks. |
| NFR-11 | **Maintainability.** Views do not contain ontology rules; services do not import views. | Boundary tests, as `src/structure/boundaries.test.ts`. |
| | *NFR-12 to NFR-16 serve the deferred data-integration track; they stand as written for when it is resumed.* | |
| NFR-12 | **Secrets stay on the backend.** No database credential reaches the browser's storage, a model file, an export, a log or an API response. | A browser check that inspects storage and every response after a connection is defined; a test that greps exports and logs for the test password. |
| NFR-13 | **External databases are read, never written, and never overloaded.** Every statement is read-only, time-limited and row-limited. | Integration tests against a database whose account can write: an attempted write fails; a slow query is cut off at the limit. |
| NFR-14 | **No silent semantics.** No OWL axiom is created from a database constraint without an explicit, undoable confirmation. | A test that maps a schema with keys and constraints and asserts the ontology revision is unchanged. |
| NFR-15 | **Rows stay out of the browser's storage** and cross to it only in bounded pages. | Storage inspection in browser checks; response size limits asserted. |
| NFR-16 | **Mapping fidelity.** An R2RML document imported and exported unchanged is an equivalent RDF graph. | Graph isomorphism over the W3C R2RML test-case mappings and a corpus of published mappings. |
| NFR-17 | **Artifact independence.** An LDM edit never changes the ontology, its revision or its shape sets; an ontology edit never changes an LDM or its revision; an edit of one LDM never changes another. | Tests that edit each artifact and assert the others' content and revisions unchanged, and that reasoning results and pending proposals about the ontology stay current across an LDM edit. |
| NFR-18 | **No silent constraints.** No mandatory attribute or relationship end, no bound taken from a cardinality restriction, no key and no business rule is created in an LDM from an OWL axiom or a SHACL shape without the user choosing it. A property's functionality may shape a proposed relationship, stated as the reason. | A transformation of an ontology full of restrictions, keys and functional properties, accepted as offered, yields only optional attributes and ends, no key and no rule; with nothing accepted, the LDM's revision is unchanged. |
| NFR-19 | **Scale, logical models.** An LDM of 2,000 entities and 30,000 attributes: an edit blocks the page under 100 ms; search within 200 ms; the ER diagram pans at 30 frames per second with 300 entities in view. Transformation and impact over a 10,000-class ontology run off the main thread and can be cancelled. | Benchmarks in CI on generated LDMs and ontologies ([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §8). |
| NFR-20 | **LDM fidelity.** An LDM saved and reopened, exported and imported in its JSON format, or restored from a version, is identical element for element, ids included. | Round-trip tests on fixture LDMs covering every kind of element. |

## 5. Functional modules

Each module below gives: what it is, what exists, what is missing, user stories, functional
requirements with status and priority, the non-functional points specific to it, dependencies,
and acceptance criteria for the requirements that are not yet met.

### M1 Ontology modelling and entity management

**Description.** Creating and maintaining the entities of an ontology: classes, object
properties, data properties, annotation properties, individuals and datatypes, with their names,
IRIs and annotations.

**Status: Existing.** Classes, data properties and individuals are terms on the canvas and rows
in *Entities* (`src/components/Entities.tsx`), edited in a Protégé-style side panel
(`EntityEditor.tsx`, `Inspector.tsx`). Object properties have seven characteristics, domains,
ranges, and sub-, inverse, equivalent and disjoint links (`src/model/props.ts`). IRIs are made
once and kept through renames; the suffix is editable; prefixes and namespaces are managed
(`src/model/iri.ts`, `prefixes.ts`, `OntologySettings.tsx`). Two model types, OWL ontology and
SKOS vocabulary, decide which features are offered (`src/model/modelTypes.ts`). Since
2026-10-17 annotation properties are entities of their own (`Model.annProps`), with
superproperties, domains, ranges and annotations, and names, descriptions and notes may be in
several languages, with a display language for entity names across the interface
(`src/model/labels.ts`).

**Gaps.** Statements the model has no place for are dropped on import (TD-01). Object
properties are identified by name (TD-03). Refactoring is limited to moving a namespace.

**User stories.**

- As an ontology engineer I open my organisation's ontology, add three classes and save it, and
  nothing else in the file has changed.
- As a taxonomist I give each concept a preferred label in English, German and French and switch
  the display between them.
- As a modeller I rename a property and every place that uses it follows.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M1-1 | Create, rename and delete classes, object properties, data properties and individuals from the canvas, the tables and the editor. | Existing | P0 |
| FR-M1-2 | Every entity has an IRI from the moment it is created; name and IRI are independent; renaming never changes an IRI. | Implemented 2026-10-14 (a stand-in IRI until the first name; `src/model/iri.ts`) | P0 |
| FR-M1-3 | Object properties have a stable identity independent of their name; two properties may share a label. | Implemented 2026-10-14 (model format 2; `src/model/identity.ts`) | P0 |
| FR-M1-4 | Annotation properties are entities: declared, listed, arranged in a hierarchy, with domain and range. | Implemented 2026-10-17 (`Model.annProps`; superproperties, domains, ranges and annotations; `src/model/annotationProps.ts`, `src/components/Entities.tsx`) | P1 |
| FR-M1-5 | Labels, definitions and notes in several languages per entity; a display language for the whole interface. | Implemented 2026-10-17 (labels, definitions and notes in any number of languages; a display language for entity names in the header, remembered; `src/model/labels.ts`) | P1 |
| FR-M1-6 | Refactoring: merge two entities, move entities to another namespace, replace one entity by another everywhere, deprecate with a successor. | Partially Implemented (`moveNamespace`) | P2 |
| FR-M1-7 | For any entity, list every axiom that mentions it. | Partially Implemented (relationships and restrictions are listed) | P1 |
| FR-M1-8 | Statements with no editor are preserved and written back unchanged. | Implemented 2026-10-14 (kept whole as read, `src/model/unmapped.ts`); since 2026-10-15 the corpus of nine ontologies loses nothing | P0 |
| FR-M1-9 | Namespace prefixes and the ontology IRI are managed in one place and kept on import and export. | Existing | P0 |

**Module non-functional points.** NFR-1 is decided here. Identity changes need a file-format
migration (NFR-9).

**Dependencies.** None; this is the foundation. FR-M1-2 and FR-M1-3 precede M2, M7, M10.

**Acceptance criteria.**

- FR-M1-3: two object properties named `hasPart` with different IRIs coexist; renaming one
  leaves relationships using the other untouched; a model saved before the change opens with
  the same relationships.
- FR-M1-8: each ontology of a public test corpus (at least Pizza, Wine, Koala, PROV-O, SKOS,
  OWL-Time, FOAF, and two that use property chains and axiom annotations) is opened and
  exported, and an OWL API comparison of the original and the export reports no axiom added or
  removed.
- FR-M1-2: no entity in a saved model lacks an IRI; no code path outside the local model uses a
  term id.
- FR-M1-4: an annotation property is declared, renamed, given a superproperty, a domain and a
  range, and listed in its own tab; fields that name it — by name, prefixed name or IRI — are
  annotations made with it, counted and traced to the entities that use it; the RDF types it
  `owl:AnnotationProperty` and keeps its domain, range and subproperty statements, and a model
  exported and imported again states the same axioms; a property declared in another vocabulary
  is kept as an external entity, found by its IRI.
- FR-M1-5: an entity carries labels, definitions and notes in any number of languages; with a
  display language chosen, the tables, the tree, the canvas and the editors' pickers show each
  entity's name in it, the editor says when the name it edits is not the one shown, and the
  choice is remembered across a reload; every language still reads as it did, and a search in
  the model language finds an entity that has another language's name too.

### M2 Advanced OWL axiom and restriction editing

**Description.** Authoring the logical content of an ontology: restrictions, class expressions,
defined classes, property axioms, assertions about individuals.

**Status: Partially Implemented.** Existing: existential, universal, minimum, maximum and exact
qualified restrictions on one property with a named class or datatype, several on one line
(`restrictionSpecs` in `src/model/props.ts`); equivalent and disjoint classes and properties,
same and different individuals (`LINKS` in `src/model/axioms.ts`); enumerated classes and
datatypes; property characteristics; every edit checked by rule functions that refuse with a
reason. Class expressions are structured data since 2026-10-14 (model format 4, FR-M2-2 and
FR-M2-3); property chains, keys, disjoint unions, negative property assertions and annotations
on axioms are typed since 2026-10-17 (model format 8, FR-M2-4 and FR-M2-5).

**Gaps.** No editor for general class axioms, datatype facets or rules.

**User stories.**

- As an ontology engineer I define `VegetarianPizza` as "Pizza and not (hasTopping some
  MeatTopping)" by typing it, with completion and immediate checking.
- As an ontology engineer I state that `hasGrandparent` is the chain of `hasParent` and
  `hasParent`.
- As a reviewer I read a class's definition in words and in Manchester syntax.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M2-1 | Qualified restrictions (some, only, min, max, exactly) on a property, drawn as a line or edited in a form. | Existing | P0 |
| FR-M2-2 | Class expressions are structured data: named class, and, or, not, some, only, min, max, exactly, value, self, one-of, nested to any depth. | Implemented 2026-10-14: domains and ranges (model format 3) and superclasses, equivalent and disjoint classes (model format 4, `Term.classAxioms`), with inverse properties and data ranges; `src/model/expressions.ts` | P0 |
| FR-M2-3 | A Manchester-syntax editor for superclass and equivalent-class expressions, with completion of entity names, syntax errors shown in place, and a rendering in words. | Implemented 2026-10-14: a visual editor (nested blocks) and a Manchester-syntax editor (CodeMirror: completion, highlighting, bracket matching, formatting, errors in place) on one expression; checked against the OWL API's Manchester parser. A rendering in words since 2026-10-15 (`src/model/inWords.ts`), under the editor and every axiom listed | P0 |
| FR-M2-4 | Property chains, keys, disjoint unions, negative property assertions and general class axioms can be stated and edited. | Partially implemented 2026-10-17: property chains, keys, disjoint unions and negative property assertions are typed axioms (model format 8), read and written as OWL states them, and edited on the object property, class and individual (`src/components/AxiomParts.tsx`, `src/model/typedAxioms.test.ts`, `e2e/axioms.mjs`); general class axioms are still kept as they were read | P1 |
| FR-M2-5 | Annotations on axioms are kept, shown and editable. | Implemented 2026-10-17: `Model.axiomAnnotations` (model format 8), shown and edited on the statement they are about, written as `owl:Axiom` | P1 |
| FR-M2-6 | Datatype restrictions with facets (ranges, patterns, lengths). | Partly implemented 2026-10-14: in any data range of an expression or a range axiom (`xsd:integer[>= 0]`); not as a named datatype | P2 |
| FR-M2-7 | Every edit goes through one rule service that accepts it or refuses it with a reason, whichever control was used. | Partially Implemented (since 2026-10-15 one rule for moving an end from the canvas, the panel and the table, TD-06; every edit is a change set of `OntologyEditService`, and one made elsewhere is held to the editor's rule functions, with a reason for each refusal; the editor's own controls still call those functions directly) | P0 |
| FR-M2-8 | SWRL rules. | Future | P3 |

**Module non-functional points.** A class expression that fails to parse is never discarded: it
stays as text (NFR-1). Completion answers within 100 ms at 10,000 entities (NFR-4).

**Dependencies.** FR-M1-2, FR-M1-3 (expressions refer to entities by IRI). FR-M2-4 and FR-M2-5
need the axiom-level contract of [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §4.3.

**Acceptance criteria.**

- FR-M2-2, FR-M2-3: every class expression in the Pizza ontology opens in the editor as
  structure, not text; editing one and saving produces the intended axiom, verified by HermiT
  classifying the result as the reference does.
- FR-M2-3: an expression with an unknown entity or unbalanced brackets cannot be saved and
  shows where the error is.
- FR-M2-7: moving the end of a relationship gives the same outcome from the canvas, the panel
  and the table.

### M3 Ontology reasoning and inference management

**Description.** Deriving what follows from an ontology, checking it for contradictions, and
showing and explaining the results without confusing them with what was asserted.

**Status: Existing; job handling Partially Implemented.** An in-page rule reasoner (RDFS and
part of OWL 2 RL; `src/model/reasoner.ts`, its coverage stated in `REASONER_PROFILE`) gives
inferred types, superclasses, facts and conflicts, each traced to stated facts. HermiT is
available through a local Java service (`reasoner/ReasonerService.java`), with a complete,
partial or failed status, OWL 2 DL profile violations and justifications
(`src/model/reasoning.ts`). Inferred memberships and relationships can be drawn dotted on the
canvas, listed per entity, browsed as an inferred hierarchy and exported separately.

**Gaps.** The in-page reasoner runs on the main thread after every edit (TD-08). HermiT runs
are a single blocking request with a timeout (TD-14). ELK is not offered although it is in the
service's library bundle. No progress, no cancel, no cache across sessions.

**User stories.**

- As an ontology engineer I start a classification of a large ontology and keep editing while
  it runs.
- As a modeller I ask why a class is unsatisfiable and get the axioms responsible.
- As a terminology maintainer with an OWL 2 EL ontology of 80,000 classes I get the inferred
  hierarchy in under a minute.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M3-1 | Immediate rule-based feedback while editing, without blocking the page. | Implemented 2026-10-15: the fast reasoner runs in a worker after an edit, for what shows it; an edit on 2,600 classes has no task over 100 ms | P0 |
| FR-M3-2 | Complete OWL 2 DL reasoning with HermiT, reporting complete, partial or failed with reasons. | Existing | P0 |
| FR-M3-3 | Inferred statements are shown apart from asserted ones, never stored among them, and exportable on request. | Existing | P0 |
| FR-M3-4 | Reasoning is a job: started, followed, cancelled; one result per revision and reasoner, reused until the ontology changes. | Recommended | P1 |
| FR-M3-5 | ELK is offered for OWL 2 EL ontologies; "automatic" chooses a reasoner from the ontology's profile and says which it chose. | **Existing** (2026-10-17, roadmap 2.6): in the local service; the reasoner list in Validation, automatic by default | P1 |
| FR-M3-6 | A justification can be asked for any inferred subclass relationship, type or inconsistency. | Partially Implemented (for HermiT findings; the hierarchy's `explain` has none for HermiT) | P1 |
| FR-M3-7 | An inferred statement can be made an asserted one by an explicit command, as a normal edit. | Recommended | P2 |
| FR-M3-8 | Time and memory limits are settings, shown with each result. | Partially Implemented (fixed defaults) | P1 |

**Module non-functional points.** NFR-2 is defined by this module's existing behaviour. A
reasoner never blocks editing (NFR-3). Complete OWL 2 DL reasoning is not guaranteed to finish
(AR-02); the requirement is to bound and report it.

**Dependencies.** FR-M3-4 needs the job model (Phase 1 locally, Phase 3 on the server).

**Acceptance criteria.**

- FR-M3-1: with a 2,600-class generated ontology open, an edit produces no main-thread task
  longer than 100 ms; inferences appear when the worker finishes.
- FR-M3-5: for an OWL 2 EL ontology, automatic selection uses ELK and the result says
  "complete for OWL 2 EL"; for one outside EL it uses HermiT or reports ELK's result as partial
  with the ignored axiom types listed.
- FR-M3-4: cancelling a running job returns control within two seconds and leaves no result.

### M4 SHACL validation and ontology quality assurance

**Description.** Checking data against shapes, and the ontology itself against modelling good
practice.

**Status: Existing.** SHACL Core through `rdf-validate-shacl` (`src/model/shaclEngine.ts`,
`shaclFindings` in `validation.ts`), of a chosen shape set or every set, on the model's own
individuals or on a data graph kept with the model (`src/model/dataGraphs.ts`; since 2026-10-16,
SH-2); every test of the W3C SHACL 1.0 Core suite gives its expected report
(`shaclConformance.test.ts`). A finding gives the line of its file the focus node is on and
opens the property shape at the constraint it failed. Shapes in a view of their own, in shape
sets, every SHACL 1.0 Core construct in the form and read from and written to Turtle with
nothing lost (`src/model/shacl.ts`, `shapes.ts`, `Shapes.tsx`; since 2026-10-16, SH-1). 34 quality rules in seven groups, each switchable, some with a quick fix
(`src/model/quality.ts`). One results table across the three kinds of check, with reports in
JSON and RDF.

**Gaps.** No SHACL-SPARQL. No user-defined quality rules. No way to run checks outside the
application. A data graph's content is in one browser only. Keys, and restrictions whose filler
is a nested class expression, are not proposed as shapes (each is listed with why). (Validation in a worker, cancellable: done 2026-10-15. Shapes as a view of their own,
in shape sets, with all of Core in the form; a chosen set validated against a data graph kept
with the model, findings to the constraint and the line; shapes proposed from the ontology,
reviewed one by one, with their origin kept: done 2026-10-16.)

**Direction (2026-10-15).** Three models, related by mappings and never one-to-one: the
conceptual model (OWL), the constraint model (SHACL shape sets: what an application accepts,
several per ontology) and the physical model (a relational schema). The shapes editor is a
first-class editor of the constraint model, parallel to the ontology's, not settings on each
class. SHACL validates an RDF data graph; relational data is validated through a mapping (M15).
An OWL axiom is never taken for a SHACL constraint, nor a domain or range for a data rule,
without review (ADR-020). SHACL 1.0 Core first (ADR-021). The roadmap's SHACL track, SH-1 to
SH-5, delivers FR-M4-12 to FR-M4-16 ([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §1.4).

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M4-1 | Validate the model's individuals, or imported RDF data, against SHACL Core shapes. | Existing; the data kept with the model since 2026-10-16 (SH-2) | P0 |
| FR-M4-2 | Author shapes in a form for common constraints and as Turtle for the rest. | Existing | P0 |
| FR-M4-3 | Quality rules with severity, switchable per model, with quick fixes where one is safe. | Existing | P0 |
| FR-M4-4 | Validation is a cancellable background job with progress. | Implemented 2026-10-15 (`ValidationService`, in a worker; *Stop*; the phase shown as it goes) | P0 |
| FR-M4-5 | Results state the revision they are of and are marked stale after an edit. | Existing | P0 |
| FR-M4-6 | Reports as JSON and RDF; additionally as CSV and a printable page. | Partially Implemented (JSON, RDF) | P2 |
| FR-M4-7 | Custom quality rules written as SPARQL queries. | Recommended | P2 |
| FR-M4-8 | The same checks run from a command line, for continuous integration of an ontology repository. | Recommended | P2 |
| FR-M4-9 | SHACL-SPARQL and validation against the inferred graph, with a server engine. | Recommended (SH-5) | P2 |
| FR-M4-10 | The workbench has a fourth kind of check, *Mapping*, beside OWL, SHACL and quality: same results table, same links to what a finding is about, stale when the mapping, the ontology or the schema changes. The checks themselves are FR-M15-9. | **Deferred** (data integration); was: Recommended | P1 |
| FR-M4-11 | Data from a relational source, previewed or materialised through a mapping, can be validated against the project's shapes. | **Deferred** (data integration); was: Recommended: previewed rows at DI-2, materialised data at DI-4 | P1 (previewed), P2 (materialised) |
| FR-M4-12 | Shapes are edited in a view of their own, beside the ontology's editors, in named shape sets (constraint models), several per ontology, each with its purpose, validated and exported on its own. A class may have any number of shapes; a class's and a property's editor list the shapes about them. | Implemented 2026-10-16 (SH-1: the sets, the *Shapes* view, the entities' editors, export per set, `src/components/Shapes.tsx`; SH-2: a set validated on its own) | P0 |
| FR-M4-13 | Every SHACL 1.0 Core construct is edited in the form: logical constraints, qualified value shapes, property pair constraints, property paths, nested shapes, closed shapes. A shape set reads from and writes to Turtle with nothing lost; what the form cannot hold (SHACL-SPARQL) is kept and written back. | Implemented 2026-10-16 (SH-1; `src/model/shacl.ts`, checked on the W3C suite by `shacl.test.ts`) | P0 |
| FR-M4-14 | A chosen shape set is validated against a chosen data graph; data graphs are kept with the project. A finding opens the property shape at the constraint it failed, with the value and the path, and says where in its file the focus node is. | Implemented 2026-10-16 (SH-2; `src/model/dataGraphs.ts`, `validation.ts`; the W3C suite in `shaclConformance.test.ts`, the view in `e2e/data-graphs.mjs`) | P0 |
| FR-M4-15 | Shapes are proposed from the ontology (restrictions, domains and ranges, characteristics, datatypes, enumerations, keys), each saying what the axiom means, what the shape would check and where they differ; accepted, edited or dismissed one by one; nothing is added unreviewed; an accepted shape keeps its origin and goes stale when the axiom changes. | Implemented 2026-10-16 (SH-3; `src/model/proposals.ts`, `src/components/Proposals.tsx`; Pizza in `proposals.test.ts`) | P1 |
| FR-M4-16 | The server validates with Jena SHACL behind the same interface, giving the browser's reports on the W3C SHACL Core tests, and validates data graphs too large for the page. | Recommended (SH-4) | P1 |

**Dependencies.** FR-M4-4 shares the job model with M3. FR-M4-12 to FR-M4-14 need stable
identity (FR-M1-2) and change sets (FR-M10). FR-M4-15 needs structured class expressions
(FR-M2-2). FR-M4-16 and FR-M4-9 need the Java backend (Phase 3). FR-M4-11 needs a mapping
(M15), and is deferred with it. Shape sets may inform proposals of logical data models, never
become their requirements (FR-M18-7, ADR-024).

**Acceptance criteria.**

- FR-M4-4: a validation of a 3,000-term model can be cancelled; while it runs the page stays
  responsive (NFR-3).
- FR-M4-7: a rule given as a `SELECT` query returning `?entity ?message` appears in the results
  table with its own severity and can be switched off.
- FR-M4-12: two shape sets of one ontology, with a different shape for one class in each,
  validate one data graph to different results, and each exports as a file of its own.
- FR-M4-13: the shapes of every W3C SHACL 1.0 Core test open in the form and are written back
  statement for statement.
- FR-M4-14: validating each W3C SHACL 1.0 Core test's data gives its expected report; a finding
  opens the property shape at the failed constraint.
- FR-M4-15: shapes proposed for the Pizza ontology change nothing until accepted; an accepted
  one names its axiom and goes stale when the axiom is removed.
- FR-M4-16: the browser and the server give the same report on every W3C SHACL Core test.

### M5 Graph and subgraph visualization

**Description.** The canvas: seeing and editing the ontology as a graph.

**Status: Existing.** The application's own SVG canvas (`src/components/Canvas.tsx`): direct
manipulation, seven layouts with routing options computed in a worker (`src/layout/`), per-kind
and per-element styling with themes (`src/model/graphStyle.ts`), subgraphs by starting terms,
depth, direction and relationship type (`src/model/subgraph.ts`), adjustable line ends and
drag-to-reconnect (`src/model/reconnect.ts`), spotlight and path finding, export as SVG, PNG and
an interactive HTML page.

**Gaps.** One diagram per ontology. Lines do not route around other terms. Drawn whole (up to
12,000 terms), the graph's lines are worked out again at every edit.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M5-1 | Create and edit entities and relationships directly on the canvas, with rules enforced as they are drawn. | Existing | P0 |
| FR-M5-2 | Layouts: hierarchical, layered, orthogonal, radial, circular, force-directed, manual; routing straight, curved or right-angled. | Existing | P0 |
| FR-M5-3 | Subgraph by starting terms, depth, direction and relationship kinds, expandable in place. | Existing | P0 |
| FR-M5-4 | Only what is in view is drawn; detail is reduced when zoomed out. | Implemented 2026-10-15 (`src/model/culling.ts`: the area around the view, lines cut to it, a layer moved by a pan; no words below 30 % and 20 %, lines batched far out) | P0 |
| FR-M5-5 | Above a size threshold the graph opens on a subgraph; the full graph is never instantiated. | Implemented 2026-10-15 (above 12,000 terms: opens on the Structure Explorer, the graph drawn around a chosen class) | P0 |
| FR-M5-6 | Styling by kind and by element, themes, saved styles. | Existing | P1 |
| FR-M5-7 | Several named diagrams per ontology, each with its own contents, layout and style. | Recommended | P1 |
| FR-M5-8 | Export the picture as SVG, PNG and an interactive page. | Existing | P1 |
| FR-M5-9 | Overview map and jump-to-entity. | Recommended | P2 |
| FR-M5-10 | Neighbourhoods are fetched from a server on demand. | Recommended | P1 |

**Module non-functional points.** NFR-4. Statement of limits: no rendering technique makes
10,000 nodes readable; the requirement is reachability, not totality.

**Dependencies.** FR-M5-10 needs `GraphService` and Phase 4.

**Acceptance criteria.**

- FR-M5-4: with 10,000 terms loaded and 300 in view, panning holds 30 frames per second; the
  number of SVG nodes follows what is in view.
- FR-M5-5: opening a 50,000-class ontology shows Entities or Structure first and offers the
  graph around a chosen class; memory use does not grow with ontology size.
- FR-M5-7: two diagrams of one ontology show different subsets; deleting a term from a diagram
  does not delete it from the ontology.

### M6 Ontology structure exploration and comparison

**Description.** Understanding an ontology's shape: its hierarchies, how classes relate, where
it is deep, wide or irregular; and comparing things.

**Status: Existing.** The Structure Explorer (`src/components/Structure*.tsx` over
`src/structure/`): *Explore* (asserted or inferred class hierarchy, paged, with a summary of the
class in focus), *Compare* (two classes: what each asserts and inherits), *Analyze* (metrics,
distributions, diagnostics, with the classes behind each number). All through `StructureService`
with an HTTP client ready. Since 2026-10-18 (roadmap 2.10) *Explore* also browses the object and
data properties in one tree under what they are stated to be subproperties of
(`StructurePropertyExplore.tsx` over `propertyGraph.ts`); the difference engine tells a renamed
class and a moved class as one change each, and a version can be compared with another version,
the model now, or a model in My Models (`src/projects/`, `Versions.tsx`).

**Gaps.** The HTTP implementation has no server.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M6-1 | Browse the asserted and the inferred class hierarchy, a branch at a time, at any size. | Existing | P0 |
| FR-M6-2 | Summary of a class: stated and inferred superclasses, equivalents, depth, descendants, ways down to it. | Existing | P0 |
| FR-M6-3 | Compare two classes: asserted and inherited restrictions side by side. | Existing | P1 |
| FR-M6-4 | Metrics and diagnostics of the hierarchy, each with the classes behind it. | Existing | P1 |
| FR-M6-5 | Object- and data-property hierarchies in the same explorer. | Implemented 2026-10-18 (`StructurePropertyExplore.tsx` over `propertyGraph.ts`: both kinds in one tree, each badged by kind, stated `rdfs:subPropertyOf` only) | P1 |
| FR-M6-6 | Compare two versions of an ontology, or two ontologies: entities and axioms added, removed and changed. | Implemented 2026-10-18 (`src/projects/difference.ts` names renames and moves; `Versions.tsx` compares with a version, the model now, or a model in My Models) | P1 |
| FR-M6-7 | The explorer is answered by a server for server-side ontologies. | Partially Implemented (client only) | P1 |

**Dependencies.** FR-M6-6 needs M10. FR-M6-7 needs Phase 3.

**Acceptance criteria.**

- FR-M6-5: object and data properties are browsed branch by branch in one tree, each marked by
  its kind; a search finds either kind, and the summary describes the property in focus.
- FR-M6-6: for two versions that differ by one renamed class, one moved class and one removed
  restriction, the comparison shows exactly those three changes, grouped by entity.
- FR-M6-7: the existing `http.test.ts` suite passes against the Java implementation.

### M7 Advanced bulk import and data mapping

**Description.** Bringing many entities in at once from tabular sources, with control over what
each column becomes.

**Status: Partially Implemented.** *Bulk add* (`src/model/bulk.ts`) takes pasted text: terms
with their metadata, then relationships in arrow notation, or an indented outline. *Import a
table* (since 2026-10-16, roadmap task 2.4) reads CSV, TSV and Excel files, in an encoding, with
a sheet and header row chosen; maps each column to a use on a mapping screen, with IRIs made by
templates; previews what each row becomes or why it is skipped; imports as one undoable edit;
and keeps mappings as templates. It is built on a mapping core that does not assume a file
(`src/mapping/`, ADR-019).

**Gaps.** No updating of existing entities from a table (FR-M7-6): a row the model has is left as
it is. No server job for files too large for the browser. No RML.

**User stories.**

- As a taxonomist I drop a spreadsheet with columns *Code, Label, Parent code, Definition* and
  say which is which; I see the resulting hierarchy before anything is created.
- As a data architect I import 5,000 product rows as individuals of a class, with three columns
  as data property values, and re-import next month to update them.
- As a team lead I save the mapping so that a colleague imports the next file the same way.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M7-1 | Paste rows of terms and relationships. | Existing | P0 |
| FR-M7-2 | Upload CSV, TSV and Excel files; choose sheet, header row and encoding. | Implemented 2026-10-16 (`src/import/`) | P0 |
| FR-M7-3 | A mapping screen: each column becomes a name, an IRI or part of one, a type, a parent, an annotation (with language), a data property value, or a link to another entity by a chosen property. | Implemented 2026-10-16 (`ImportTable.tsx`, over `src/mapping/`) | P0 |
| FR-M7-4 | Preview before commit: what will be created, what will be skipped and why, row by row; the import is one undoable change. | Implemented 2026-10-16 (`src/mapping/plan.ts`) | P0 |
| FR-M7-5 | Mappings are saved as named templates and reused. | Implemented 2026-10-16 (`src/import/templates.ts`, in this browser) | P1 |
| FR-M7-6 | Update mode: rows are matched to existing entities by IRI or a key column; changes are shown before they are applied. | Recommended | P1 |
| FR-M7-7 | Files too large for the browser are imported as a server job. | Future | P2 |
| FR-M7-8 | A mapping can be exported in a standard mapping language (RML). | Future | P3 |

**Module non-functional points.** 20,000 rows are mapped and previewed in the browser without
blocking it (NFR-3). Every created entity satisfies the same rules as one created by hand
(FR-M2-7).

**Dependencies.** FR-M1-2 (IRIs from rows). Excel parsing needs a library, loaded on demand as
oxigraph and Dagre are.

**Acceptance criteria.**

- FR-M7-2, FR-M7-3: a 2,000-row CSV with parent references becomes a hierarchy with the right
  2,000 classes and parents; a row whose parent is missing is reported with its row number and
  nothing is created for it.
- FR-M7-4: one undo removes the whole import.
- FR-M7-6: re-importing the same file changes nothing and says so.

### M8 Ontology reuse and semantic alignment

**Description.** Building on existing ontologies rather than beside them: adding them,
referring to their entities, and recording how local entities correspond to theirs.

**Status: Existing.** *Align* (`src/components/Alignment.tsx`): a library of external
ontologies added from a file or URL in any supported syntax, with a preview and collision
report (`src/model/external.ts`); reuse of an entity by reference or by copy; mappings with
thirteen OWL and SKOS predicates, a method, a score, a status (proposed, approved, needs
review), author and comment (`src/model/alignment.ts`); lexical suggestions that can be accepted
or turned down (`src/model/matcher.ts`); mappings exported and imported as Turtle.

**Gaps.** `owl:imports` is neither written nor followed transitively. External content is
cached per browser, not with the model. No SSSOM. Suggestions are lexical only. No catalogue
search.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M8-1 | Add an external ontology from a file or a URL; see what it contains and what collides. | Existing | P0 |
| FR-M8-2 | Reuse an external entity by reference (its own IRI) or by copy. | Existing | P0 |
| FR-M8-3 | Record mappings with standard predicates, with status, author and comment; review them in one list. | Existing | P1 |
| FR-M8-4 | Suggest mappings; accept or turn down each; never suggest a rejected one again. | Existing (lexical) | P1 |
| FR-M8-5 | `owl:imports` is declared on export and the imports closure is resolved transitively, with missing imports reported. | Existing | P1 |
| FR-M8-6 | Import and export mappings as SSSOM. | Recommended | P2 |
| FR-M8-7 | Extract a module of an external ontology (the part needed for chosen terms) instead of the whole. | Future | P3 |
| FR-M8-8 | Search public catalogues for terms to reuse. | Future | P3 |
| FR-M8-9 | Semantic (embedding-based) suggestions. | Future | P3 |

**Dependencies.** FR-M8-5 shares the imports design with M3 (a reasoner needs the same
closure). FR-M8-9 is M12.

**Acceptance criteria.**

- FR-M8-5: an ontology that imports another which imports a third is reasoned over with all
  three; removing the third from the cache produces a "missing import" finding naming it.

### M9 Ontology search and SPARQL querying

**Description.** Finding things, by text and by query.

**Status: Existing.** Entity tables with search over names, other labels, IRIs and definitions,
sorting and filters, answered by a query service with matches highlighted (`src/entities/`). A
sidebar search and hierarchy. A SPARQL view over the asserted ontology using oxigraph in the
page, with example queries per model type, results as a table, CSV download, and the last query
remembered (`src/model/sparql.ts`, `SparqlView.tsx`).

**Gaps.** SPARQL sees the asserted graph only. One remembered query, no named ones. No search
across axioms and annotations as such.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M9-1 | Search entities by name, label, IRI and definition, with matches highlighted. | Existing | P0 |
| FR-M9-2 | Sort and filter each list by what is said about its entities. | Existing | P0 |
| FR-M9-3 | SPARQL `SELECT`, `ASK` and `CONSTRUCT` over the ontology, with examples and CSV download. | Existing | P1 |
| FR-M9-4 | Choose what a query reads: asserted, asserted with imports, or with inferred statements. | Recommended | P1 |
| FR-M9-5 | Named, saved queries per project. | Recommended | P2 |
| FR-M9-6 | One search box across entities, annotations and axioms, with results grouped by kind. | Recommended | P2 |
| FR-M9-7 | A read-only SPARQL endpoint for a published ontology. | Future | P3 |

**Dependencies.** FR-M9-4 needs inferred results kept per revision (M3) and, at scale, Phase 4.

**Acceptance criteria.**

- FR-M9-4: the same query for instances of a class returns the asserted instances in one mode
  and the asserted and inferred ones in the other, and the result header says which.

### M10 Ontology versioning and change tracking

**Description.** Knowing what an ontology was, what it is, and what changed in between.

**Status: Partially Implemented (2026-10-16, roadmap task 2.3).** A model in My Models has named
versions, kept in this browser (`src/projects/local.ts`, IndexedDB): saved with a name and a
line, listed newest first, compared with each other or with the model now entity by entity (the
axioms added and removed under each, the shape sets' statements, the data graphs), and restored
as a new version. Undo is still a history of 100 steps in memory. There is no history of one
entity, no record of who changed what, and no release (TD-12).

**User stories.**

- As a maintainer I save "Before restructuring Person" and return to it if the restructuring
  fails.
- As a reviewer I see what changed since the last release, entity by entity.
- As a publisher I tag a release with a version number and a version IRI.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M10-1 | Save a named version with a summary; list versions newest first. | Implemented 2026-10-16 (`src/projects/local.ts`, `Versions.tsx`) | P0 |
| FR-M10-2 | Show the difference between any two versions, or a version and now: entities added, removed, changed; for each, the axioms added and removed. | Implemented 2026-10-16 (`src/projects/difference.ts`) | P0 |
| FR-M10-3 | Restore a version, as a new version, never by deleting history. | Implemented 2026-10-16 (`restore` in `src/projects/local.ts`) | P0 |
| FR-M10-4 | The history of one entity: every change that touched it. | Recommended | P1 |
| FR-M10-5 | On a server, every saved change is an immutable revision with its author and time. | Recommended | P1 |
| FR-M10-6 | A release: a tagged revision with `owl:versionIRI` and `owl:versionInfo`, exportable and comparable. | Recommended | P1 |
| FR-M10-7 | Branches and merging. | Future | P3 |

Logical data models and their semantic mappings are in every version from roadmap LM-1, and the
difference lists their changes element by element (FR-M17-14); on a server each LDM has a line of
revisions of its own (FR-M17-17). (Mapping sets of the deferred data-integration track were to be
versioned on a line of their own: FR-M15-12.)

**Module non-functional points.** Differences are computed over axioms, not text, so that
reordering a file is not a change (NFR-1). Picture-only changes are not ontology changes.

**Dependencies.** FR-M1-2, FR-M1-3. Design in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §6.

**Acceptance criteria.**

- FR-M10-2: moving terms on the canvas between two versions shows "no changes to the ontology".
- FR-M10-2: adding one superclass and removing one restriction shows exactly two changes under
  the right class.
- FR-M10-3: after restoring version 3 of 5, there are six versions and the sixth equals the
  third.

### M11 Ontology publishing and export

**Description.** Getting an ontology out: as files in standard syntaxes, as documentation, as a
published resource.

**Status: Partially Implemented.** Exports (`exportModel` in `src/model/files.ts`): the
application's JSON, Turtle (as OWL, as SKOS, and with inferred assertions), JSON-LD, RDF/XML
(written in the page), OWL/XML, functional and Manchester syntax (through the local OWL service;
since 2026-10-16, `src/io/`), CSV of terms and relationships, SVG, PNG, and a self-contained
interactive HTML page with search and a draggable graph (`src/model/htmlExport.ts`, `src/export/`).

**Gaps.** No generated documentation. No publishing to a stable address. No Excel or PDF.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M11-1 | Export as Turtle, JSON-LD and the application's own format. | Existing | P0 |
| FR-M11-2 | Export as RDF/XML, OWL/XML, functional and Manchester syntax. | Implemented 2026-10-16 (`src/io/local.ts`; RDF/XML in the page, the others through the OWL service) | P0 |
| FR-M11-3 | Export with inferred statements as a separate, clearly marked section. | Existing | P1 |
| FR-M11-4 | A self-contained interactive page of the model that opens anywhere. | Existing | P1 |
| FR-M11-5 | Generated documentation: a page per entity with its definition, hierarchy, restrictions and usage, and an index. | Recommended | P2 |
| FR-M11-6 | Publish a release at stable IRIs with content negotiation between documentation and RDF. | Future | P2 |
| FR-M11-7 | Excel and PDF exports. | Recommended | P3 |

**Dependencies.** FR-M11-2 uses the OWL service that already converts in the other direction;
without the service the export is offered as Turtle only, with that said. FR-M11-6 needs M10 and
the Server profile.

**Acceptance criteria.**

- FR-M11-2: an ontology exported as RDF/XML opens in Protégé with the same axiom count and no
  parse warning; an OWL API comparison with the Turtle export shows no difference.

### M12 AI-assisted ontology modelling

**Description.** Suggestions from language models and embeddings that a person accepts or
rejects.

**Status: Partially Implemented** (2026-10-16). The assistant (README, *The assistant*): a panel
that answers questions about the open ontology with the user's own provider and key (OpenAI,
Anthropic, Gemini, an OpenAI-compatible endpoint), through nine read-only tools, and proposes
typed changes that are compiled to change sets, checked by the editor's rules and the fast
reasoner (and, on request, HermiT), reviewed, edited, and applied only when accepted, as one
edit (`src/ai/`, `src/components/assistant/`, `e2e/assistant.mjs`). Conversations and proposals
are kept per ontology in this browser. The key is held in the page's memory, or in the local
service's memory behind a handle; requests go straight to the provider or through the local
service (`/ai/forward`), which refuses private addresses and connects to the address it checked. Mapping suggestion remains a list of matcher functions (`MATCHERS` in
`src/model/matcher.ts`), written so that another matcher can be added beside the lexical one.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M12-1 | Every AI output is a proposal: shown, attributed to its source, and applied only on acceptance, as an ordinary change. | **Existing** for the assistant: a proposal is applied on *Accept* only, as one undoable change set named *Assistant: …*; not recorded beyond the history | P2 |
| FR-M12-2 | Semantic mapping suggestions between local and external entities. | Future | P2 |
| FR-M12-3 | Draft a definition or labels for an entity from its position and neighbours. | Future | P3 |
| FR-M12-4 | Propose classes and relationships from a document or a list of terms. | Future | P3 |
| FR-M12-5 | Translate a question into SPARQL, or a description into a class expression, for the user to check. | Partial: the assistant proposes class expressions in Manchester syntax, checked before acceptance; no SPARQL | P3 |
| FR-M12-6 | A provider is configured explicitly; what would be sent is shown; nothing is sent otherwise. | **Existing** for the assistant: nothing is sent until a provider and key are set and a question is asked; the panel says what is sent and lists each lookup; with *Show me each lookup* on, each lookup's result is shown in full and sent only when the user says so | P2 |
| FR-M12-7 | Suggest mappings between a schema and the ontology from names, comments, types and sample values. Schema names and sample values are sent to a provider only with explicit consent per data source. | **Deferred** (data integration); was: Future | P3 |
| FR-M12-8 | For logical data models, the assistant's read tools: a project's LDMs, an LDM's summary, an element's details, its semantic mappings and an impact report; with the same answer budgets and the same rule that names and definitions are data, not instructions. | Future (roadmap 5.7) | P2 |
| FR-M12-9 | Explanations in words of a semantic mapping (why this element came from those axioms) and of an impact report, grounded in the tools. | Future | P2 |
| FR-M12-10 | Typed LDM changes proposed through the assistant, compiled to logical change sets and reviewed, edited and accepted as ontology proposals are; never applied without acceptance. | Future | P2 |
| FR-M12-11 | Transformation suggestions (a strategy for a hierarchy or an object property, a candidate key) offered as transformation proposals with their rationale, under NFR-18. | Future | P2 |

**Module non-functional points.** NFR-10 and AR-10. A proposed axiom is validated by the same
rule service as a typed one (FR-M2-7) and can be checked by a reasoner before acceptance.

**Dependencies.** M10 (provenance of accepted suggestions), M2 (structured expressions to
propose into). FR-M12-8 to FR-M12-11 need M17 and M18's services; they extend the existing
assistant, never a second one. Architecture: ADR-010.

**Acceptance criteria.** For any AI feature: with no provider configured there is no network
request; an accepted suggestion appears in the history as a change with its origin; a rejected
one is not offered again.

### M13 Collaboration and governance

**Description.** More than one person working on an ontology, under rules about who may change
what and how changes are approved.

**Status: Partially Implemented.** Governance *metadata* is Existing: a configurable registry
of about forty fields mapped to standard properties, including owner, steward, sensitivity,
lifecycle status and version, with required-field checks and a profile per entity kind
(`src/model/governance.ts`, `Governance.tsx`). Mappings carry a review status. There are no
users, roles, comments, approvals or audit trail; the application is single-user by
construction.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M13-1 | Governance metadata per entity with configurable fields mapped to standard properties. | Existing | P1 |
| FR-M13-2 | Lifecycle status per entity, with required fields checked by validation. | Existing | P1 |
| FR-M13-3 | Accounts and roles per project: viewer, commenter, editor, owner. | Future | P2 |
| FR-M13-4 | Comments and discussions on an entity or a change. | Future | P2 |
| FR-M13-5 | Review: a change is proposed, reviewed and approved or returned before it becomes part of the ontology. | Future | P2 |
| FR-M13-6 | Audit trail: who changed what and when, for ontology and for settings. | Future | P2 |
| FR-M13-7 | Watches and notifications. | Future | P3 |
| FR-M13-8 | Several people editing at the same time see each other's changes. | Future | P3 |
| FR-M13-9 | Lineage: from an entity, the tables and columns it is mapped from; from a column, the entities that depend on it. The existing free-text database, schema, table and column fields are filled from mappings where one exists. | **Deferred** (data integration); was: Recommended | P2 |
| FR-M13-10 | Permission on a data source is separate from permission on a project; mapping changes can be put through review like ontology changes. | **Deferred** (data integration); was: Future | P2 |

**Dependencies.** M10 (a proposal is a change set; the audit trail is the revision history),
the Server profile, authentication.

**Acceptance criteria.** Deferred to the Phase 5 specification. One criterion is fixed now:
adding collaboration must not remove the ability to work alone with no server (ADR-001).

### M14 Database connectivity and schema exploration

**Deferred on 2026-10-17** with the data-integration track ([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §11). Kept as specified, under its identifiers; the statuses in its table are those it had. Not scheduled.

**Description.** Connecting external relational databases, read-only, and making their
structure visible: schemas, tables, views, columns, types, keys and the relationships between
tables.

**Status: Not implemented.** The application has never connected to a database and has no
model of a relational schema. Two things point at the need: governance metadata already has
free-text fields for *database*, *schema*, *table*, *column* and *physical data type*, and an
entity kind *technical data asset* (`src/model/governance.ts`). They are typed by hand today.

**Why it needs the backend.** A browser cannot open a database connection, and a credential
must not be in one. This module exists only with the companion or a server (ADR-014).

**User stories.**

- As a data engineer I connect the reporting database with a read-only account, choose the two
  schemas that matter, and browse their tables and keys.
- As a database architect I am shown, before I agree to a connection, that the product cannot
  write and cannot run an unbounded query.
- As a modeller I search for every column called `customer_id` and see which tables are joined
  through it.
- As a data engineer I refresh the schema after a migration and see what changed.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M14-1 | Define a data source from structured fields: dialect, host, port, database, TLS mode, account. A raw connection string is not accepted. | Recommended | P1 |
| FR-M14-2 | The credential is entered once and handled by the backend only: held for the session, or taken from a secret the environment provides, or stored encrypted. It is never shown again and never sent back. | Recommended | P1 |
| FR-M14-3 | Test a connection: reachable, authenticated, server version, and whether the account can write (a warning if so). | Recommended | P1 |
| FR-M14-4 | Discover schemas, tables, views, columns with type, length, precision, nullability, default and comment; primary keys, foreign keys and unique constraints. | Recommended | P1 |
| FR-M14-5 | Schema Explorer: a tree of schemas, tables and columns drawn a branch at a time; search and filter by name, type, kind and key role; a table's detail with its keys, the tables it refers to and the tables that refer to it. | Recommended | P1 |
| FR-M14-6 | Choose the schemas and tables to work with; everything else is left unread and out of sight. | Recommended | P1 |
| FR-M14-7 | Refresh metadata as a background job. Each read is a snapshot with a fingerprint; the explorer says when it was taken. | Recommended | P1 |
| FR-M14-8 | A bounded sample of a table's rows, read-only, with columns marked sensitive masked. | Recommended | P1 |
| FR-M14-9 | PostgreSQL is supported. | Recommended | P1 |
| FR-M14-10 | SQL Server and MySQL are supported through the same adapter interface. | Recommended | P2 |
| FR-M14-11 | Relationships between tables as a diagram, laid out by the existing layouts. | Recommended | P2 |
| FR-M14-12 | Several independent data sources per project. | Future | P2 |
| FR-M14-13 | A schema can be loaded from a DDL script, with no live connection. | Future | P3 |

**Module non-functional points.** NFR-12, NFR-13 and NFR-15 are decided here. Discovery of a
schema of 10,000 tables is a job that reports progress and can be cancelled; browsing it
afterwards answers within 200 ms a page (NFR-5). Nothing here touches the ontology (NFR-14).

**Dependencies.** The Java backend (Phase 3, task 3.2) and a metadata store for sources and
snapshots. Security measures of [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §12.9 are part
of the first release, not a later one.

**Acceptance criteria.**

- FR-M14-2: after a data source is defined and used, the test password occurs in no browser
  storage, no API response, no export and no log line.
- FR-M14-3: with an account that can write, the test reports it; an attempted write through any
  path of the product fails regardless.
- FR-M14-4: for a reference database with composite keys, a self-referencing foreign key, a
  view and a table with no key, discovery reports each correctly.
- FR-M14-5: searching a snapshot of 200,000 columns answers within 200 ms; the tree never holds
  more lines than are in view.
- FR-M14-7: after a column is dropped and another retyped in the database, a refresh produces a
  new fingerprint and lists exactly those two changes.

### M15 Ontology-to-relational semantic mapping

**Deferred on 2026-10-17** with the data-integration track ([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §11). Kept as specified, under its identifiers; the statuses in its table are those it had. Not scheduled.

**Description.** The Semantic Mapping Workbench: stating how rows of a relational database
correspond to instances of classes and values of properties, checking that statement, and
keeping it as a standard, versioned artefact.

**Status: Not implemented.** Parts it will be built from exist: entity lists with search and
filters (`src/entities/`), the hierarchy service (`src/structure/`), the validation results
model (`src/model/validation.ts`), datatype and literal checking (`src/model/literals.ts`), IRI
and prefix handling (`src/model/iri.ts`, `prefixes.ts`), and the suggestion model of the
alignment workbench (`src/model/matcher.ts`). The reuse map is in
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §12.5.

**What a mapping can say.**

| Ontology element | Relational source | In R2RML |
| --- | --- | --- |
| Class | A table, a view, or a query | A triples map with a logical table and a class on its subject map |
| Individual IRI | A template over one or more columns, usually the key | `rr:template` on the subject map |
| Class membership | Each row of the logical table is one individual of the class | The subject map's `rr:class` |
| Several classes from one table | A condition per class on a discriminating column | A triples map per class, each over a query with the condition |
| A class from several tables | A join, as a view or a query | A logical table that is a query |
| Data property | A column, or an expression | A predicate-object map with `rr:column` |
| Datatype | A conversion from the column's SQL type | `rr:datatype`, or the standard's natural mapping where none is given |
| Language-tagged text | A column with a fixed language | `rr:language` |
| Object property | A foreign key or a longer join path to another class's rows | A referencing object map with join conditions |
| A missing value | `NULL` | No triple |

Nothing in this table is one-to-one by assumption. A table is not a class until someone says
so, and a column is not a property until someone maps it.

**User stories.**

- As a data engineer I map the class `Film` to the table `film`, give its individuals IRIs from
  `film_id`, and see the first fifty films as triples.
- As a data engineer I map `Documentary` to the same table where `kind = 'documentary'`.
- As a modeller I see at a glance which classes and properties have no mapping, and which
  columns of the tables I chose are not used.
- As a data engineer I am told, after the schema was refreshed, that two of my rules refer to a
  column that no longer exists.
- As an integrator I export the mapping as R2RML and run it in another engine.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M15-1 | Map a class to a table or a view. A class may have several such maps; a table may serve several classes. | Recommended | P1 |
| FR-M15-2 | IRI templates for individuals, from one or more columns, with values encoded for use in an IRI; a default instance namespace per mapping set; the template is checked as it is typed. | Recommended | P1 |
| FR-M15-3 | Map a data property to a column, with a datatype conversion chosen from those the column's type allows, or a language tag. A `NULL` yields no triple. | Recommended | P1 |
| FR-M15-4 | Map an object property to a foreign key between two mapped tables, or to a join path of several keys. | Recommended | P1 |
| FR-M15-5 | A condition on a class map, built from column, operator and value, so that several classes can be populated from one table. | Recommended | P1 |
| FR-M15-6 | A SQL query as a logical table, and a SQL expression as a value, written by the user: a single read-only `SELECT`, checked before it is saved. | Recommended | P2 |
| FR-M15-7 | Preview: the triples a rule generates from the first rows of its source, with, for each row that yields nothing, the reason. | Recommended | P1 |
| FR-M15-8 | The three-area mapping editor described under *Interaction design* below: ontology on the left, schema on the right, mappings between; coverage shown on both sides; every action possible without dragging. | Recommended | P1 |
| FR-M15-9 | Mapping checks, shown in the Validation view (FR-M4-10): the checks listed below. | Recommended | P1 |
| FR-M15-10 | R2RML: export a mapping set; import one; constructs with no editor are kept, shown read-only and exported unchanged. | Recommended | P2 |
| FR-M15-11 | A mapping set is saved with its project, edited, duplicated and reused against another data source of the same shape. | Recommended | P1 |
| FR-M15-12 | Mapping revisions on their own line, each recording the ontology revision and the schema fingerprint it was written against; differences between two revisions. | Recommended | P2 |
| FR-M15-13 | Schema change detection: after a refresh, the rules affected by each change are listed with what changed. | Recommended | P2 |
| FR-M15-14 | Reusable mapping patterns: a rule or group of rules saved as a template and applied to another table of the same shape. | Recommended | P2 |
| FR-M15-15 | Suggestions: candidate columns for a property and tables for a class, by name and type, each accepted or turned down, never applied by themselves. | Recommended | P2 |
| FR-M15-16 | Proposals derived from constraints (a shape from `NOT NULL`, a key from `UNIQUE`, an object-property mapping from a foreign key) are offered with what each would mean, default to SHACL, and change the ontology only on confirmation. | Recommended | P2 |
| FR-M15-17 | A draft mapping generated from a schema is available as a starting point, shown in full before anything is kept. | Recommended | P2 |
| FR-M15-18 | Value transformations beyond datatype conversion: lookups, string functions, unit conversion. | Future | P3 |

**Mapping checks (FR-M15-9).** Each is a finding with a level, the rule it concerns, and an
explanation in words, in the manner of the existing quality rules.

| Check | Finds | Needs a connection |
| --- | --- | --- |
| Unresolved source | A rule names a table or column that is not in the current snapshot. | No |
| Unknown entity | A rule names a class or property that is not in the current ontology, or names a class where a property is needed. | No |
| Incompatible datatype | A column's type cannot be converted to the datatype of the mapping, or the mapping's datatype contradicts the property's range. | No |
| Invalid IRI template | A template is not an IRI once filled, refers to a column the source lacks, or uses a nullable column, so that some rows would have no IRI. | No |
| Template not identifying | The template's columns are not a key of the source: two rows would become one individual. Reported as a warning, since that is sometimes intended. | No |
| Broken join | A join names columns that do not exist, differ in type, or are not backed by a key on the side that should be unique. | No |
| Incomplete rule | A class map with no template; a property map with no source; an object-property map whose target class has no map. | No |
| Duplicate or conflicting rules | Two rules generate the same triples; two rules give one property different datatypes; two class maps with different templates for the same class and table. | No |
| Schema changed | The mapping was written against a fingerprint that is no longer the newest. | No |
| Values do not convert | Sampled values that fail conversion to the mapped datatype, with examples. | Yes, bounded |

**Interaction design.** Three areas, as the brief specifies.

```
+----------------------+--------------------------------+----------------------+
| ONTOLOGY             | MAPPINGS                       | DATABASE SCHEMA      |
| search, filters:     |  Film   <-  film               | search, filters:     |
|  all | not mapped     |    IRI  .../film/{film_id}     |  all | not used      |
|                      |    releaseDate <- released_on  |                      |
| v Work               |    directedBy  <- director_id  | v public             |
|   v Film        [3]  |                    -> person   |   v film        [3/7]|
|       Documentary[1] |  Documentary <- film           |       film_id  PK    |
|   Person        [0]! |    where kind = 'documentary'  |       title          |
|                      |                                |       released_on    |
| Object properties    | [Preview]  [Check]  [R2RML]    |       director_id FK |
| Data properties      | 50 rows -> 148 triples, 2 skip |   > person      [0/4]|
+----------------------+--------------------------------+----------------------+
```

- **Left, the ontology explorer.** The class hierarchy and the lists of object and data
  properties, from the existing entity and structure services, with a count of rules on each
  entity and a filter for those with none.
- **Right, the schema explorer.** The tree of M14, with keys marked and, on each table, how
  many of its columns are used.
- **Centre, the mapping workspace.** The rules, grouped by class: for each, its source, its IRI
  template, its conditions, and its property rules. Selecting a rule highlights its two ends in
  the side areas. A panel edits the selected rule: source, join, filter, conversion, template.
  Below, the preview and the findings for that rule.

Principles, the first eight from the `ui-ux-pro-max` guidance consulted for this design:

1. **Dragging is never the only way.** A column can be dragged onto a property; the same is
   done by selecting one on each side and pressing *Map*, and from the keyboard (guideline:
   *Dragging Movements*, a single-pointer alternative is required).
2. **Status is not colour alone.** Mapped, not mapped and invalid each have an icon and a
   count as well as a colour (guideline: *Color Only*).
3. **Errors sit at the field** that caused them (the template, the condition), and a summary
   above the rule links to each (guidelines: *Error Placement*, *Focusable Error Summary*).
4. **Empty states say what to do**: no data source yet, nothing chosen yet, nothing mapped yet
   each offer the next action (guideline: *Empty States*).
5. **Long work shows progress** suited to its length, without the layout jumping or the focus
   moving: discovery, preview, validation (guideline: *Loading Indicators*).
6. **Removing asks first**: a mapping set, a data source (guideline: *Confirmation Dialogs*).
7. **Everything by keyboard**, in the order it is seen: left, centre, right (guideline:
   *Keyboard Navigation*).
8. **The connection form accepts paste and password managers** (guideline: *Accessible
   Authentication*).
9. **Lines between the sides are an aid, not the model.** Connecting lines are drawn for the
   selected class only; a full web of lines over two long lists is unreadable. This and the
   next point are from the application's own practice, not from the guidance, which had no
   matching entry.
10. **Long trees draw what is in view**, a branch at a time, as the Structure Explorer does.
11. **What a rule means is said in words** and in R2RML, side by side: "Each row of `film`
    where `kind` is `documentary` is a `Documentary`, identified by `…/film/{film_id}`."

**Module non-functional points.** NFR-14 and NFR-16. Editing a mapping never changes the
ontology and never touches the database. Static checks answer as the user types; anything that
reads rows is bounded (NFR-13). The mapping model and its checks contain no user-interface
code (NFR-11) and run in the page for offline editing against a cached snapshot.

**Dependencies.** M14 (a snapshot to map against). FR-M1-2 and FR-M1-3 (rules name entities by
IRI). The mapping core shared with tabular import (FR-M7-3; ADR-019). FR-M15-12 needs the
metadata store of Phase 4.

**Acceptance criteria.**

- FR-M15-1, FR-M15-5: `Film` and `Documentary` mapped to one table by a condition; the preview
  of each shows only its own rows; every documentary is also previewed as a film.
- FR-M15-2: a template over a nullable column is reported; a template whose value contains a
  space or a slash yields a valid, encoded IRI.
- FR-M15-3: a row whose mapped column is `NULL` yields no triple for that property and the
  preview says so; a `DATE` column mapped to `xsd:date` yields typed literals; mapping a text
  column to `xsd:integer` is flagged before any row is read.
- FR-M15-4: an object property mapped through a foreign key yields triples whose objects are
  the IRIs the target class's template generates for the referenced rows.
- FR-M15-7: the preview's triples equal those the reference engine produces from the exported
  R2RML for the same rows (AR-12).
- FR-M15-8: every mapping action in the editor can be completed with the keyboard alone and
  with single clicks alone.
- FR-M15-10: the exported R2RML of a mapping made in the workbench is executed by an
  independent R2RML processor without error; a published R2RML document is imported and
  exported as an equivalent graph (NFR-16).
- FR-M15-13: after a mapped column is dropped and the schema refreshed, the rule using it is
  listed with "column removed", and no other rule is.
- FR-M15-16: accepting no proposal leaves the ontology revision unchanged (NFR-14).

### M16 Relational data access: materialisation and virtual knowledge graph

**Deferred on 2026-10-17** with the data-integration track ([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §11). Kept as specified, under its identifiers; the statuses in its table are those it had. Not scheduled.

**Description.** Using a mapping to get at the data: by generating RDF from it and storing the
result, or by answering SPARQL queries from the database directly with nothing stored.

**Status: Not implemented.** The SPARQL view queries the ontology in the page
(`src/model/sparql.ts`). There is no engine that reads a relational database.

**The three things, and why they are separate** are set out in
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §12.2. In short: a mapping is a description;
materialising runs it and keeps a copy; a virtual graph answers each query from the source at
the time it is asked.

**User stories.**

- As an analyst I ask, in SPARQL and the ontology's terms, for directors of documentaries
  released after 2020, and get the answer from the live database.
- As a data engineer I see the SQL my query became and how long each part took.
- As a data steward I materialise last night's data and validate it against our shapes.
- As a modeller I ask for instances of `Work` and get films too, because `Film` is a subclass,
  and I am told that this much reasoning, and no more, was applied.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M16-1 | Materialise a mapping set into a data graph of the project, as a job, with an estimate of its size before it starts and a record of which mapping, ontology and schema it came from. | Recommended | P2 |
| FR-M16-2 | A virtual knowledge graph for a mapping revision: SPARQL in the ontology's terms is answered from the database, with nothing stored. | Recommended | P2 |
| FR-M16-3 | Every answer says how it was obtained: virtual or materialised, which mapping and ontology revisions, and which reasoning was applied (the OWL 2 QL part of the ontology for a virtual graph). | Recommended | P2 |
| FR-M16-4 | Trace: for a query, the SQL it was rewritten to, the time spent rewriting and executing, and the rows returned. | Recommended | P2 |
| FR-M16-5 | Limits: a time limit and a result cap on every query, set per data source; results reach the browser a page at a time. | Recommended | P2 |
| FR-M16-6 | The SPARQL view offers the virtual graph and the materialised data as sources beside the ontology, with the existing results table and CSV download. | Recommended | P2 |
| FR-M16-7 | Parts of a query the engine does not support are refused with a statement of what is not supported, not answered partially. | Recommended | P2 |
| FR-M16-8 | One query across several databases. | Future | P3 |
| FR-M16-9 | Writing changes back to a database. | Future | P3 |

**Module non-functional points.** NFR-13 and NFR-15 above all: a query from this product must
never be the reason a source database is slow. NFR-2 applies in a new form: an answer from a
virtual graph is complete with respect to the data and the OWL 2 QL part of the ontology, and
says so; it is not a claim about what is true in an open world
([SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §12.7).

**FR-M16-9 is not a later step of this module.** Writing to a database needs its own design for
transactions, authorisation and integrity, and is recorded here only so that nothing in the
read-only design is mistaken for a first half of it (ADR-018).

**Dependencies.** M15 (a valid mapping revision, as R2RML). The triple store of Phase 4 for
materialisation. An OBDA engine, adopted after a spike (ADR-016).

**Acceptance criteria.**

- FR-M16-2: for a reference database and mapping, a set of SPARQL queries returns the same
  answers from the virtual graph as from a materialisation of the same mapping queried in the
  triple store.
- FR-M16-3: a query for instances of a superclass returns instances mapped only to its
  subclasses, and the answer's header names the reasoning applied.
- FR-M16-4: the trace of a query shows SQL that runs unchanged in a database client and returns
  the same rows.
- FR-M16-5: a query that would run for minutes is stopped at the limit, the database session is
  released, and the user is told which limit was reached.
- FR-M16-7: a query using an unsupported feature is refused with that feature named.

### M17 Logical data model authoring

**Description.** Logical data models (LDMs) as an artifact of their own beside the ontology and the
shape sets: how an application organises its data, in entities, attributes with logical types,
relationships with cardinality and optionality, identifiers, specializations and business rules,
several per project; edited in a workspace and on an ER diagram; validated, versioned and, later,
kept on a server. Logical only: no physical model, database type or DDL.

**Status: Partially implemented** (added 2026-10-17; roadmap LM-1, LM-2, LM-5). The metamodel and
its services (`src/logical/`), the LDM workspace and its ER diagram (`src/components/LogicalData.tsx`,
`LdmDiagram.tsx`) and LDM findings in the Validation view exist (2026-10-17). What remains is
FR-M17-9, FR-M17-13 and the server's LDMs (LM-5). The design is
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §13.3 to §13.5 and
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §11.

**User stories.**

- As a data architect I keep two logical models of one ontology, one for the catalogue
  application and one for the rights-management system, and edit each without touching the other
  or the ontology.
- As a logical modeller I give `film` a primary key of its own, make `release_date` mandatory, and
  say a film is directed by at most one person, on the diagram or in a form.
- As a modeller I resolve the many-to-many between `film` and `person` into an associative entity
  `film_credit` with a `role` attribute.
- As a reviewer I compare two versions of the project and see that a key was added and a
  relationship's cardinality changed, and nothing in the ontology.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M17-1 | Several LDMs per project, each with its own identity (an id never reused), name, description and purpose; created, renamed, duplicated (with new ids), imported, exported and deleted. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-2 | Logical entities: a name unique in the LDM, a definition, and a mark for an abstract supertype. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-3 | Logical attributes: a name unique in the entity, inherited ones included; a definition; a logical type or a domain; optional or mandatory (optional unless the user says otherwise); a mark for derived. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-4 | Logical data types, technology-neutral: text (with an optional maximum length), integer, decimal (precision, scale), boolean, date, time, date-time, duration, binary, identifier; and named domains over them, restricted by length, range, pattern or enumerated values with codes and labels. No database-specific type. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-5 | Relationships between two entities (the same one for a recursive relationship), each end with a role, a minimum and a maximum cardinality (minimum 0: optional); identifying or not; many-to-many allowed, with a command that resolves it into an associative entity. | **Existing** (2026-10-17, LM-1 and LM-2): the metamodel, and the command in the relationship editor | P1 |
| FR-M17-6 | Identifiers: per entity at most one primary key and any number of candidate keys, each of attributes and, for an identifying relationship, of the relationship's end. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-7 | Generalization: a supertype and its subtypes, complete or incomplete, exclusive or overlapping, with an optional discriminator attribute; subtypes inherit attributes and keys; no cycles. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-8 | Business rules in words, named, attached to entities, attributes or relationships, each a constraint or a derivation, proposed or accepted. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-9 | A formal expression for a business rule, in a small language over attributes (comparisons, ranges, required-if, uniqueness within a scope), checked as it is typed. | Recommended | P2 |
| FR-M17-10 | LDM validation in the Validation view: an entity with no primary key of its own or inherited, a key naming a missing attribute, a relationship end on a missing entity, duplicate names, a generalization cycle, an attribute with no type, an unresolved many-to-many (information), an attribute repeating an inherited one; each finding opens its element. | **Existing** (2026-10-17, roadmap LM-2) | P1 |
| FR-M17-11 | The LDM workspace: a view of its own with the project's LDMs, an entity list with search, and editors for entities, attributes, relationships, keys, generalizations, rules and domains; every action by keyboard. | **Existing** (2026-10-17, roadmap LM-2) | P1 |
| FR-M17-12 | An ER diagram of an LDM in Information Engineering notation (crow's foot), laid out by the existing layouts and culled at scale; keys marked PK and AK, inherited keys and identities borrowed from identifying relationships written in the entity's box, an attribute typed by a domain named by that domain; a subtype is drawn by its line and symbol, labelled with its discriminator; its positions kept apart from the LDM's meaning; edits on it are the same operations as in the forms. | **Existing** (2026-10-17, roadmap LM-2): the diagram, its positions and its tools; a relationship is drawn by the tool and edited in its editor, not by dragging between entities | P1 |
| FR-M17-13 | Several diagrams per LDM, each of a chosen subset of its entities. | Recommended | P2 |
| FR-M17-14 | Every LDM edit is one undoable step, kept in the working copy, saved with the project and in its versions; the difference between two versions lists LDM changes element by element and field by field, apart from the ontology's. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-15 | An LDM is exported to and imported from a documented, versioned JSON format, losslessly; the project's own file carries its LDMs. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-16 | `LogicalModelQueryService` and `LogicalModelEditService`: questions by element id of a named LDM revision, paged, cancellable, refusals typed, plain data only, as the existing services. | **Existing** (2026-10-17, roadmap LM-1) | P1 |
| FR-M17-17 | On a server, LDMs are kept with revisions of their own, queried a page at a time and edited through the same contracts; a change made against a moved revision is refused. | Recommended (LM-5) | P1 |

**Module non-functional points.** NFR-17 (an LDM edit changes nothing of the ontology), NFR-19
(scale), NFR-20 (fidelity), NFR-9 (a project saved before LDMs existed opens unchanged), NFR-7
(the diagram passes the UI audit and every action has a keyboard path), NFR-11 (the services have
no UI imports).

**Dependencies.** The change-set contract (task 1.8) as the pattern for logical change sets; the
working copy (1.10) and versions (2.3, M10); the layouts and culling of 2.2 for the diagram. For
FR-M17-17: the server projects of Phase 4.

**Acceptance criteria.**

- FR-M17-1 to FR-M17-8, FR-M17-15: a fixture LDM with every kind of element is created through
  the edit service and read back element for element through the query service; and again after a
  JSON export and import, a reload, a save, and a restored version (NFR-20).
- FR-M17-5 to FR-M17-7: a key naming a removed attribute, a relationship to a removed entity, a
  second primary key and a generalization cycle are each refused with a reason, and nothing
  changes.
- FR-M17-10: validation of a fixture LDM reports exactly the problems seeded in it.
- FR-M17-11, FR-M17-12: an entity, two attributes, a relationship with its cardinalities and a
  key are made with the keyboard alone; in an LDM of 2,000 entities the diagram pans at 30 frames
  per second with 300 in view (NFR-19).
- FR-M17-14: between two versions that differ by an attribute's type, a relationship end's
  maximum and a removed candidate key, the difference lists exactly those three LDM changes and
  no ontology change; an LDM edit leaves the ontology's revision unchanged (NFR-17).
- FR-M17-17: the contract fixtures pass against the local and the server implementation alike.

### M18 Ontology-to-LDM transformation and semantic traceability

**Description.** Proposing logical data models from the ontology, by rules the user configures
and decisions the user reviews; and keeping each LDM traceable to the ontology through explicit
semantic mappings, with stale detection, change impact reports and reviewed synchronization.

**Status: In part — implemented 2026-10-17** (LM-3 and LM-4: FR-M18-1 to FR-M18-6 and FR-M18-8
to FR-M18-14; FR-M18-7 and FR-M18-15 remain). Patterns it builds on exist: shapes proposed from the ontology, each
with what the axiom means and where it differs, none chosen by default, origin kept as the axiom in
functional syntax and marked stale when it goes (`src/model/proposals.ts`, FR-M4-15); the
axiom-level difference between two states of the ontology (`changesBetween`, M10); structured class
expressions (M2). The design is [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §13.6 to §13.9.
The transformation, traceability and impact are `src/traceability/`, reviewed in the *Derive from
the ontology…* dialog, the LDM view's *Traceability* part and its *Impact…* dialog.

**Why the open world matters here.** An ontology says what is true of a domain; an LDM says what
an application stores. `Film SubClassOf directedBy some Director` means every film has a
director, known or not: a film with none recorded contradicts nothing. Made into *director is
mandatory*, it would reject the record of a film whose director is unknown. A domain infers a
type; it requires nothing. With no unique names, "at most one" counts individuals that may have
several names. So the transformation proposes structure, and offers constraints only as
candidates for the designer to choose.

**User stories.**

- As a data architect I choose the `Work` branch of the ontology and get a proposed logical model,
  each entity and attribute with the axioms it came from, and decide which constraints to keep.
- As a data architect I choose to roll the subclasses of `Award` up into one entity with a
  discriminator, rather than an entity each.
- As a logical modeller I see, for `film.release_date`, that it came from `:releaseDate` and from
  which version of the ontology.
- As a data architect, after the ontology team removed `:runningTime`, I see which attributes of
  which models depend on it, and remove or keep each.
- As a logical modeller I am sure that a synchronization never undoes my renaming of `film_code`.

| Id | Requirement | Status | Priority |
| --- | --- | --- | --- |
| FR-M18-1 | Propose an LDM, new or into an existing one, from a chosen scope of the ontology (all, a branch, chosen classes, with or without loaded imports), as a set of proposals; nothing is created until accepted, and the ontology is never changed. | Implemented (LM-3, 2026-10-17) | P1 |
| FR-M18-2 | Transformation rules: classes to entities; datatype properties to attributes, typed by a configurable XSD-to-logical table; object properties to relationships or associative entities, and to an attribute typed by the domain when the other end is an enumerated class; inverse pairs to one relationship with two roles; subclass hierarchies to specializations, or rolled up or down; enumerations to domains; `owl:hasKey` to candidate keys. | Implemented (LM-3, 2026-10-17) | P1 |
| FR-M18-3 | Restrictions, domains, ranges, cardinalities and keys are offered as candidate constraints (mandatory, a maximum, a key, a rule), never chosen to begin with; each says what the axiom means in OWL, what the constraint would require, and where they differ. A property's functionality shapes the proposed relationship, shown as its reason. | Implemented (LM-3, 2026-10-17) | P1 |
| FR-M18-4 | Each proposal shows its source axioms, the elements it would create or change, its strategy and its rationale; proposals are chosen, edited or dismissed one by one or by kind; the chosen ones are applied as one logical change set, with the semantic mappings they imply, undone in one step. | Implemented (LM-3, 2026-10-17; applied as one change set, and *Apply and edit* opens the element) | P1 |
| FR-M18-5 | A configuration saved with each LDM: naming (from labels or local names, case, separators, singular), the datatype table, the default hierarchy and object-property strategies, the scope, definitions from annotations or not. | Implemented (LM-3, 2026-10-17) | P1 |
| FR-M18-6 | Many to many: a class may become several entities and several classes one; a property several attributes; elements may be mapped by hand where no rule applies, and may have no semantic source at all. | Implemented (LM-3 and LM-4, 2026-10-17: roll-up and associative entities; mappings by hand) | P1 |
| FR-M18-7 | A shape set may be chosen as a further input: its constraints are offered as candidate constraints naming the shape, never imposed. | Recommended | P2 |
| FR-M18-8 | Semantic mappings: each relates ontology sources (entity IRIs and the axioms used, in functional syntax) to LDM targets (element ids), with its strategy from a fixed catalogue (an id beside the words), rationale, origin (ontology, revision, named version), what it last made of its targets, the conversion it last went through, and how and when it was made (transformation, by hand, synchronization, assistant). A mapping whose strategy's expected kind is not its target's kind is marked mismatched. Changing the strategy to one that makes a different kind of element is a reviewed structural conversion, applied as one undoable change set; any reason it cannot be is a conflict that changes nothing; the ontology is never changed. A mapping written before strategies had ids keeps its words, shown as needing classification until someone chooses. | Implemented (LM-4, 2026-10-17; typed strategies and reviewed conversions 2026-10-18) | P1 |
| FR-M18-9 | Traceability both ways: from an LDM element to its sources, from an ontology entity to every element made from it in every LDM; coverage of each LDM: ontology entities in scope not represented, elements with no semantic source. | Implemented (LM-4, 2026-10-17) | P1 |
| FR-M18-10 | Stale detection: a mapping whose source axiom changed is stale, one whose source entity or target element is gone is broken, each with what changed; worked out against the ontology as it is. | Implemented (LM-4, 2026-10-17) | P1 |
| FR-M18-11 | Change impact report, per LDM, for the ontology now against each mapping's origin or between two versions: the affected elements and mappings, each with the kind of change (not represented, source removed, type changed, cardinality axiom changed, hierarchy changed, renamed). | Implemented (LM-4, 2026-10-17) | P1 |
| FR-M18-12 | Synchronization proposals from an impact report, reviewed as transformation proposals are; an element the user customised (it differs from what its mapping last made) is never changed without explicit acceptance; a dismissed proposal is not offered again until its source changes again. | Implemented (LM-4, 2026-10-17) | P1 |
| FR-M18-13 | Several LDMs derived from one ontology, each with its own configuration, mappings and impact report. | Implemented (LM-4, 2026-10-17) | P1 |
| FR-M18-14 | Mappings are kept with their LDM, in the project's versions and differences; deleting an LDM element breaks the mappings to it and changes nothing in the ontology. | Implemented (LM-4, 2026-10-17) | P1 |
| FR-M18-15 | Mappings exported as RDF with PROV-O provenance, for other tools. | Future | P3 |

**Module non-functional points.** NFR-18 above all: no constraint without the user's choice.
NFR-17: transformation and synchronization never change the ontology. NFR-3 and NFR-19:
transformation and impact reports run in a worker and can be cancelled. NFR-2: a proposal says
where OWL and the LDM differ; a mapping's status says when it was last checked against what.

**Dependencies.** M17 (an LDM to propose into); M2 (structured class expressions); M10 (the
versions an impact is reported between); M4's shape sets for FR-M18-7. Decisions ADR-024 and
ADR-025.

**Acceptance criteria.**

- FR-M18-1, FR-M18-3, NFR-18: for the example ontology with every proposal accepted as offered,
  the LDM has an entity for each class in scope, an attribute for each datatype property, a
  relationship for each object property, and no mandatory attribute or end, no key and no rule;
  with nothing accepted, the LDM and the ontology are unchanged.
- FR-M18-2: the subclasses of a chosen class become a specialization by default, and one entity
  with a discriminator under the roll-up strategy; an inverse pair becomes one relationship with
  two roles.
- FR-M18-4: a proposal for `Film SubClassOf directedBy some Director` shows the axiom, the
  candidate *mandatory* on the end, and the open-world difference in words.
- FR-M18-5, FR-M18-12: run again after the user renamed an entity and made an attribute
  mandatory, the transformation proposes no change to either.
- FR-M18-10, FR-M18-11: after a datatype property is removed from the ontology, the impact report
  of each of two LDMs derived from it lists exactly the attributes mapped from it, as *source
  removed*, and their mappings are broken.
- FR-M18-12: synchronization proposes removing them; a customised one is proposed, never changed
  silently; accepting is one undoable change of the LDM, and the ontology's revision does not move.
- FR-M18-8: a domain mapped by hand from an enumerated class is *current*; choosing the
  reference-entity representation in its mapping shows the entity, its code, label and primary
  key, the attributes that would be retyped and the values that would be kept, before anything is
  written; applying is one undoable change set after which the domain is gone, the entity is in
  its place and the mapping is current, and one undo brings both back. While another mapping still
  targets the domain, the conversion is refused with that conflict and nothing is written. A
  mapping saved with older free text shows the words as needing classification, and choosing a
  strategy that makes the same kind of element changes no element.
- Proposals for Pizza are worked out in a worker without blocking the page; for a 10,000-class
  generated ontology within 30 seconds (NFR-19).

## 6. User journeys

Each journey gives the user's objective, where it starts, what the user does and how the system
answers **today** (with the status of each step), where it is hard, and what would improve it.
Steps that do not exist yet are marked Recommended and describe the intended behaviour.

### J1 Creating a new ontology project

**Objective.** Start a new ontology with a name, a type and a namespace, and have it kept.

**Entry point.** *File → New model…* (`src/components/NewModel.tsx`).

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Chooses *New model…* | A dialog asks for a name, the type (OWL ontology or SKOS-like vocabulary, each described), the ontology IRI and the default namespace, the last two suggested from the name. | Existing |
| 2 | Confirms | An empty canvas with a hint: double-click to add a term, or use *Bulk add*. The type decides which views and editors are offered. | Existing |
| 3 | Starts modelling | The working copy is kept in the browser after every change. | Existing |
| 4 | Presses Save (Ctrl+S) | The model is stored under *My Models* in this browser; the header shows whether there are unsaved changes. | Existing |
| 5 | Chooses where the project lives: this browser, or a server | — | Future (Server profile) |

```mermaid
flowchart LR
  A["File, New model"] --> B["Name, type, IRI, namespace"]
  B --> C["Empty canvas with hint"]
  C --> D["Model, edits kept in the browser"]
  D --> E["Save to My Models"]
  E --> F["Download a file as backup"]
```

**Difficulties.**

- "Model", "ontology" and "project" are used for nearly the same thing.
- The namespace has to be decided before the user knows why it matters.
- "Saved" means "in this browser"; clearing site data loses it. The header says so, but only
  once the user knows to look.
- An empty canvas gives no starting structure.

**UX opportunities.**

- Offer three starts: empty, from a file or URL, from a template (a small upper structure, a
  SKOS scheme).
- One sentence in the dialog on what the namespace is for, with the default good enough to
  accept.
- After the first save, say where the model is and offer a file download; remind when the last
  backup is old (AR-09).
- A project home: name, type, counts, versions, last checks.

### J2 Defining classes and properties

**Objective.** Describe the kinds of thing in a domain and how they relate.

**Entry points.** The canvas; *Entities*; *Bulk add*.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Double-clicks the canvas, types a name | A class is created with an IRI made from the name. | Existing |
| 2 | Drags the ⊕ handle of a class onto another class and names the line "is a" | A subclass axiom. The hierarchy in the sidebar updates. | Existing |
| 3 | Drags again and names the line "directs" | An object property `directs` is declared if new, and the first class is restricted: *directs some* the second. | Existing |
| 4 | Changes a term's type to data property; drags a class onto it | "Has data property": the class is given the property. | Existing |
| 5 | Opens *Entities → Object properties* and edits `directs` | Characteristics, domain, range, inverse and parent in the side panel. | Existing |
| 6 | Tries a line that OWL has no meaning for (an individual to a data property) | Refused, with the reason and what to do instead. | Existing |
| 7 | Sees, as the line is dropped, which axiom will be created, in words and in Manchester syntax | — | Recommended |

**Difficulties.**

- A named line between two classes creates an existential restriction. People from UML or ER
  modelling expect "a relationship", and ontology engineers may have meant a domain and range.
- The meaning of a line depends on its name ("is a") and on the types of its ends. This is
  explained in the panel, after the fact.
- Object properties come into being by naming a line; there is no moment of "creating a
  property".

**UX opportunities.**

- At the drop, a compact chooser of what the line can mean between these two ends, with the
  default highlighted. The rule service already knows the options (`kindsBetween` in
  `src/model/props.ts`).
- A one-line confirmation of the axiom just created, with *undo* beside it.
- For newcomers, a mode that reads each relationship as a sentence ("Every Director directs at
  least one Film").

### J3 Creating individuals and relationships

**Objective.** Record particular things, what they are, and what is true of them.

**Entry points.** The canvas; *Entities → Individuals*; the entity editor.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Creates a term and sets its type to individual | An individual, drawn differently from a class. | Existing |
| 2 | Drags it onto a class | "Is Instance Of": a class assertion, always from the individual to the class. | Existing |
| 3 | Drags it onto another individual and names the line | A fact using that object property. | Existing |
| 4 | Opens it and adds a value under *Data property assertions* | The value is checked against the property's datatype or enumerated range. | Existing |
| 5 | Turns on *Inferred facts* | Inferred memberships and relationships are drawn dotted, never stored. | Existing |
| 6 | Enters fifty individuals in a table, one per row, with their values in columns | — | Recommended (M7) |

**Difficulties.**

- Individuals crowd a diagram quickly.
- Values are entered one at a time in a side panel.
- An individual and a data property cannot be joined by a line; the message explains it, but the
  attempt is natural.

**UX opportunities.**

- A grid for individuals of a class: rows are individuals, columns are its properties.
- Hide individuals on the canvas by default above a count, with a count badge on their class.
- Import individuals from a spreadsheet (J5).

### J4 Defining OWL restrictions and axioms

**Objective.** Say precisely what it takes to be a member of a class, and how properties
behave.

**Entry points.** A relationship's panel; a class's editor; a property's editor.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Selects a relationship between two classes | The panel shows the restriction and reads it back: "Every Director: directs some Film". | Existing |
| 2 | Changes *some* to *only*, *min*, *max* or *exactly*, with a number | The restriction changes; the line's label follows. | Existing |
| 3 | Adds another restriction on the same line | Several restrictions with one property and filler. | Existing |
| 4 | In the class editor, adds an equivalent or a disjoint class | The axiom is stated; a statement that contradicts an existing one is refused with the reason. | Existing |
| 5 | Sets a property transitive, functional, and so on | Stated; combinations that exclude each other are reported by validation. | Existing |
| 6 | Opens a class imported with a complex definition | The expression is shown as text and cannot be edited. | Partially Implemented |
| 7 | Types `Pizza and (hasTopping some MeatTopping)` as an equivalent class | — | Recommended (FR-M2-3) |
| 8 | States a property chain or a key | The axiom is stated on the property or class; RDF writes it as a list. | Implemented (2.8) |

**Difficulties.**

- A restriction can only be made by drawing a line to a class that is on the canvas.
- Necessary conditions (superclasses) and definitions (equivalent classes) look alike.
- Anything beyond one property and one named filler cannot be authored (TD-02).

**UX opportunities.**

- A *Definition* section in the class editor with two lists, "is always" and "is defined as",
  each taking expressions.
- Completion, bracket matching and a plain-language reading beside the expression.
- After a change to a definition, show what the fast reasoner now infers for that class.

### J5 Importing CSV or Excel files and mapping columns to ontology entities

**Objective.** Turn a table that already exists into classes, properties or individuals.

**Entry point today.** *Bulk add* (pasted text). **Target.** *File → Import a table…*.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Copies rows from a spreadsheet and pastes them into *Bulk add*, step 1 | Each row becomes a term. With a header row starting with "Name", columns are matched by their names; unknown columns become annotations. | Existing |
| 2 | Pastes relationships in step 2, as `Customer -> places -> Order` | Relationships are added, each through the same rules as one drawn by hand; lines that cannot be used are listed with the reason. | Existing |
| 3 | Drops a `.csv` or `.xlsx` file | The file is read; sheet, header row and encoding are detected and can be changed. | Recommended |
| 4 | Says what each column is | A mapping screen: name, IRI, type, parent, annotation with language, data value, link by a property. A sample of rows shows the result as it is built. | Recommended |
| 5 | Reviews the preview | Counts of what will be created, updated and skipped; every skipped row with its number and reason; the hierarchy that would result. | Recommended |
| 6 | Commits | One change, one undo, one entry in the history. | Partially Implemented (one undo step today) |
| 7 | Saves the mapping as a template | It is offered the next time a file with the same columns is dropped. | Recommended |

```mermaid
flowchart LR
  A["Drop a file"] --> B["Detect sheet, header, encoding"]
  B --> C["Map columns"]
  C --> D["Preview and row errors"]
  D --> E{"Acceptable?"}
  E -- "No" --> C
  E -- "Yes" --> F["Commit as one change"]
  F --> G["Save mapping as template"]
```

**Difficulties today.**

- The header convention has to be known in advance.
- Relationships are a second paste in a notation of their own; a parent column in the same
  table cannot be used.
- There is no view of the result before it is made.
- Individuals with values cannot be imported.

**UX opportunities.** The target journey above. In addition: recognise common column names in
several languages; show duplicates against existing entities before committing; make *update*
as safe as *create* by showing a difference first.

### J6 Running OWL reasoning and SHACL validation

**Objective.** Find out whether the ontology is consistent, what follows from it, whether data
conforms, and what should be improved.

**Entry point.** The *Validation* view; the *Inferred facts* switch on the graph.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Opens *Validation* | Three cards: OWL consistency, SHACL validation, ontology quality. The fast checks have run once. | Existing |
| 2 | Chooses the reasoning engine | Fast reasoner (in the page) or Advanced reasoner (HermiT). Each says what it covers. | Existing |
| 3 | Chooses Advanced without the service running | Status "Unknown: the reasoner gave no answer", with how to start it. Never "consistent". | Existing |
| 4 | Starts the service in a terminal (`pnpm reasoner`) and runs again | The ontology is sent, reasoned over and the result shown as complete, partial or failed, with findings and justifications. | Existing |
| 5 | Edits the model | Results are marked stale; nothing is silently kept. | Existing |
| 6 | Defines a shape and runs SHACL | Findings per focus node, with the shape and the value at fault. | Existing |
| 7 | Clicks a finding | The entity opens; some quality findings offer a quick fix. | Existing |
| 8 | Keeps working while a long run proceeds, sees its progress, cancels it | — | Recommended (FR-M3-4, FR-M4-4) |
| 9 | Lets the application choose a reasoner | — | Recommended (FR-M3-5) |

```mermaid
flowchart TD
  A["Open Validation"] --> B{"Which engine?"}
  B -- "Fast" --> C["Rules in the page"]
  B -- "Advanced" --> D{"Service running?"}
  D -- "No" --> E["Unknown, with how to start it"]
  D -- "Yes" --> F["HermiT classifies"]
  C --> G["Findings, each with its basis"]
  F --> G
  G --> H["Open the entity, fix, run again"]
```

**Difficulties.**

- The advanced reasoner needs Java and a terminal.
- A large run freezes the page for its duration.
- "Partial" needs reading to understand.
- Checks are re-run by hand after an edit.

**UX opportunities.**

- A packaged companion started by double-clicking, detected automatically.
- Runs in the background with progress; the fast checks re-run by themselves when the page is
  idle.
- A summary line in the header: last result, for which revision, by which reasoner.
- For each kind of finding, the usual repair.

### J7 Exploring class hierarchies and graph relationships

**Objective.** Understand an ontology one did not write, or check the shape of one's own.

**Entry points.** The sidebar tree; *Structure*; the *Subgraph* mode of the graph.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Opens *Structure → Explore* | The class hierarchy under `owl:Thing`, a branch at a time. | Existing |
| 2 | Switches from asserted to inferred | The reasoner's hierarchy, saying which reasoner and whether it may be incomplete; equivalent classes on one line; unsatisfiable ones under `owl:Nothing`. | Existing |
| 3 | Selects a class | A summary: superclasses stated and inferred, depth, descendants, the ways down to it. | Existing |
| 4 | Opens *Compare* with two classes | What each asserts and inherits, side by side. | Existing |
| 5 | Opens *Analyze* | Counts, depth and breadth distributions, diagnostics; a click on a number lists the classes behind it. | Existing |
| 6 | On the graph, chooses *Show as a subgraph* for a class | The class and its neighbours to a chosen depth; neighbours expand in place. | Existing |
| 7 | Selects two terms and asks for the path between them | The shortest path is spotlighted. | Existing |
| 8 | Browses the hierarchy of properties | *Explore* switches from classes to properties: object and data properties in one tree under their stated superproperties, each badged by kind, with search and a summary. | Existing (2026-10-18, FR-M6-5) |
| 9 | Opens a 50,000-class ontology and goes straight to a neighbourhood | — | Recommended (FR-M5-5) |

**Difficulties.**

- The full graph of anything large is not readable; the subgraph mode is the answer but has to
  be found.
- The canvas draws everything first (TD-10).

**UX opportunities.**

- *Show in graph* and *Show in Structure* on every entity, everywhere.
- Open large ontologies in Structure by default and say why.
- Named diagrams, so that a useful view can be returned to (FR-M5-7).

### J8 Reusing external ontologies and aligning entities

**Objective.** Use terms from an existing ontology, and record how one's own terms correspond
to someone else's.

**Entry point.** The *Align* view.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Adds an ontology from a file or a URL | It is read in whichever syntax it is in; a preview gives counts and the entities whose IRIs or names collide with the model's. | Existing |
| 2 | Confirms | It joins the library; its content is cached in this browser. | Existing |
| 3 | Browses its entities and reuses one | By reference (it keeps its IRI and is marked external) or by copy. | Existing |
| 4 | Relates a local class to an external one | A mapping with a chosen predicate; each predicate says what it means and what a reasoner will make of it. | Existing |
| 5 | Opens *Suggestions* | Lexical candidates with a score; each is accepted or turned down, and a rejected one is not offered again. | Existing |
| 6 | Reviews mappings | One list with status (proposed, approved, needs review), author and comment; exported as Turtle. | Existing |
| 7 | An added ontology imports others | They are read from the browser's cache too, however deep the chain, and reasoned with; one whose content is not there is reported as a missing import, naming it. | Existing |
| 8 | Searches a public catalogue for a term | — | Future |

```mermaid
flowchart LR
  A["Add ontology from file or URL"] --> B["Preview: counts, collisions"]
  B --> C["In the library"]
  C --> D["Reuse by reference or copy"]
  C --> E["Suggestions"]
  E --> F["Accept or turn down"]
  D --> G["Mappings list with status"]
  F --> G
  G --> H["Export mappings"]
```

**Difficulties.**

- Many ontology servers do not allow a browser to fetch from them; the file has to be
  downloaded first.
- The cached content does not travel with the model file.
- Choosing between `owl:equivalentClass` and `skos:exactMatch` has consequences the user may
  not foresee.

**UX opportunities.**

- With the companion or a server, fetch through it and avoid the browser's restriction.
- After adding a mapping, run the fast reasoner and show at once whether it made anything
  unsatisfiable.
- Embed external content in the saved project when asked.

### J9 Saving, exporting and publishing an ontology

**Objective.** Keep the work, hand it to other tools and people, and make a version of it
official.

**Entry point.** The *File* menu.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Saves | Stored in *My Models* in this browser; optional autosave for a model already there. | Existing |
| 2 | Downloads the model as JSON | The complete model, with positions, styles and settings. | Existing |
| 3 | Exports as OWL (Turtle), SKOS (Turtle) or JSON-LD | Standard RDF without the picture. A vocabulary can be exported as an ontology and the reverse, converted on the way out. | Existing |
| 4 | Exports with inferred assertions | The ontology, then the inferred statements in a marked section. | Existing |
| 5 | Exports an interactive page | One HTML file with the graph, the hierarchy and search, needing nothing else. | Existing |
| 6 | Exports as RDF/XML for a colleague using Protégé | — | Recommended (FR-M11-2) |
| 7 | Saves a named version and compares it with the last | — | Recommended (M10) |
| 8 | Tags a release with a version number and gets files and documentation for it | — | Recommended (FR-M10-6, FR-M11-5) |
| 9 | Publishes the release at its IRI | — | Future (FR-M11-6) |

```mermaid
flowchart LR
  A["Save in the browser"] --> B["Named version"]
  B --> C["Compare with the previous version"]
  C --> D["Tag a release"]
  D --> E["Files in standard syntaxes"]
  D --> F["Generated documentation"]
  E --> G["Publish at stable IRIs"]
  F --> G
```

**Difficulties.**

- The JSON file is the only complete copy; the RDF exports leave out the picture, which is
  right but not obvious.
- No RDF/XML, the format most other tools exchange.
- "Publishing" does not exist; an exported file is put somewhere by hand.

**UX opportunities.**

- An export dialog organised by purpose ("to continue in Protégé", "to share a picture", "to
  back up everything") rather than by format.
- A release flow: version number, checks must pass, files and documentation produced together.
- A visible "last backed up" in the header.

### J10 Connecting a relational database and exploring its schema

**Deferred on 2026-10-17** with the data-integration track (M14 to M16). Kept as written.

**Objective.** See the structure of a database beside the ontology, without risk to the
database and without the credential leaving the backend.

**Entry point.** A new *Data sources* area (Recommended). Every step is Recommended: none
exists today.

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Opens *Data sources* with no companion or server running | An explanation of why a database cannot be reached from the browser alone, and how to start the companion. Mappings already cached can still be opened. | Recommended |
| 2 | Chooses *Add a database*, PostgreSQL | A form of separate fields: host, port, database, TLS mode, account, password. No free-form connection string. It says what will and will not be done: read-only, time-limited, nothing stored but structure. | Recommended |
| 3 | Presses *Test* | Reachable or not, with the database's own message; server version; a warning if the account can write. | Recommended |
| 4 | Chooses how the password is kept | For this session only (default for the companion), or by reference to a secret the environment provides. | Recommended |
| 5 | Chooses the schemas to read | Discovery runs as a job with progress; the explorer fills as schemas complete. | Recommended |
| 6 | Browses and searches | A tree of schemas, tables and columns; keys marked; search by name, type and key role. | Recommended |
| 7 | Opens a table | Its columns with types and nullability, its keys, the tables it refers to and those that refer to it; a sample of rows on request. | Recommended |
| 8 | Comes back after a migration and refreshes | A new snapshot; what changed since the last; which mappings that affects (J11). | Recommended |

```mermaid
flowchart LR
  A["Add a database"] --> B["Structured connection form"]
  B --> C{"Test"}
  C -- "Fails" --> B
  C -- "Can write" --> D["Warning, continue read-only"]
  C -- "Read-only" --> E["Choose schemas"]
  D --> E
  E --> F["Discovery job"]
  F --> G["Browse, search, open a table"]
  G --> H["Refresh later, see what changed"]
```

**Difficulties to design for.**

- The person modelling often does not hold database credentials; the person who does is wary
  of a new tool. The connection screen has to earn that trust in one reading.
- Real schemas are large and full of tables nobody wants. Choosing a scope must come before
  reading everything.
- Naming differs by dialect: a "schema" in one is a "database" in another.
- A firewall or a missing TLS certificate produces failures that are not the product's.

**UX opportunities.**

- A plain statement of guarantees on the form, each one true by construction (NFR-12, NFR-13).
- Counts before commitment: "this schema has 1,240 tables" before it is read.
- Errors in the database's own words with the usual cause beside them.
- A table's neighbours as a small diagram, reusing the existing layouts.

### J11 Mapping ontology entities to tables and columns

**Deferred on 2026-10-17** with the data-integration track (M14 to M16). Kept as written.

**Objective.** State, check and keep how the database's rows correspond to the ontology's
classes and properties.

**Entry point.** The *Mapping* workbench of a project that has an ontology and a data source
(Recommended throughout).

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Opens the workbench | Three areas: the ontology with every entity marked "not mapped", the schema with every column "not used", an empty workspace saying how to begin. | Recommended |
| 2 | Selects the class `Film` and the table `film`, presses *Map* (or drags one onto the other) | A class rule. An IRI template is proposed from the primary key and shown with an example IRI from a real row. Nothing else is assumed. | Recommended |
| 3 | Selects the property `release date` and the column `released_on`, presses *Map* | A property rule under the class rule, with the conversion the column's type suggests (`DATE` to `xsd:date`). A conflict with the property's range would be flagged here. | Recommended |
| 4 | Maps `directed by` to the foreign key `director_id` | Possible once `Person` has a class rule; otherwise the workspace says which rule is missing and offers to create it. | Recommended |
| 5 | Adds `Documentary` on the same table with the condition `kind` = `documentary` | A second class rule over the same table; the workspace reads it back in words. | Recommended |
| 6 | Presses *Preview* | The triples from the first fifty rows; for a row that produced nothing, why (a `NULL`, a value that does not convert). | Recommended |
| 7 | Presses *Check* | Mapping findings in the Validation view's terms: unresolved columns, bad templates, broken joins, conflicts; each links to its rule. | Recommended |
| 8 | Looks for what is left | Filters "not mapped" on the left and "not used" on the right. | Recommended |
| 9 | Considers a proposal: "`released_on` is NOT NULL; add a shape requiring a release date?" | Shown with what it would mean; accepted or dismissed. The ontology is unchanged unless accepted. | Recommended |
| 10 | Exports | An R2RML file, with no connection details in it. | Recommended |
| 11 | Returns after the schema changed | The rules affected, each with what changed under it. | Recommended |

```mermaid
flowchart TD
  A["Select a class and a table"] --> B["Class rule, IRI template from the key"]
  B --> C["Map properties to columns and keys"]
  C --> D["Preview on real rows"]
  D --> E{"As expected?"}
  E -- "No" --> C
  E -- "Yes" --> F["Check the mapping"]
  F --> G{"Findings?"}
  G -- "Yes" --> C
  G -- "No" --> H["Save, export R2RML"]
```

**Difficulties to design for.**

- The tempting shortcut, "map everything automatically", produces exactly the one-table-one-class
  model the ontology was written to get away from.
- Join tables, discriminator columns and shared keys do not look like classes or properties.
- A mapping can be syntactically fine and semantically wrong; only looking at rows shows it.
- Two long lists and lines between them become unreadable quickly.

**UX opportunities.**

- Every rule read back as a sentence, and previewed on rows, before it is trusted.
- Proposals instead of automation: a draft, a suggested column, a suggested shape, each one
  visible and declinable (FR-M15-15 to FR-M15-17).
- Coverage as the organising idea: what is not mapped, what is not used.
- Recognise a join table and offer it as an object-property mapping rather than a class.

### J12 Querying relational data through the ontology

**Deferred on 2026-10-17** with the data-integration track (M14 to M16). Kept as written.

**Objective.** Ask for data in the ontology's vocabulary and get it from the database, live,
without copying it.

**Entry point.** The *SPARQL* view, with a virtual graph as its source (Recommended
throughout; stage DI-4).

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Deploys a virtual graph for a checked mapping revision | The engine starts for that mapping and ontology; the view shows it is ready and what it serves. | Recommended |
| 2 | Chooses the source: ontology, materialised data, or virtual graph | The header says which, and for a virtual graph which revisions and which reasoning apply. | Recommended |
| 3 | Writes a query in the ontology's terms | Completion over classes and properties, as elsewhere. | Recommended |
| 4 | Runs it | Results, a page at a time, in the existing table; the time taken; CSV download. | Recommended |
| 5 | Opens *How was this answered?* | The SQL the query became, the time spent rewriting and executing, the rows read. | Recommended |
| 6 | Asks for instances of a superclass | Instances mapped to its subclasses are included; the header says the hierarchy was applied. | Recommended |
| 7 | Uses a feature the engine does not support | Refused, naming the feature; not answered in part. | Recommended |
| 8 | Runs a query that is too slow | Stopped at the limit; told which limit and shown the SQL, so that the cause can be found in the database. | Recommended |
| 9 | Wants the data validated against shapes | Materialises a bounded sample or the whole, then validates it (FR-M4-11). | Recommended |

**Difficulties to design for.**

- An answer from live data looks exactly like an answer from the ontology, and means something
  different.
- Slow queries are usually the database's indexes, not the product; the user needs to be able
  to see that.
- "No results" has two causes: no such data, or no mapping for that term. They must be told
  apart.

**UX opportunities.**

- The source and the reasoning applied are always in the result header, never implicit.
- When a query uses a class or property that has no mapping, say so: "nothing maps to
  `Award`", instead of an empty table.
- A one-click path from a slow query to its SQL.

### J13 Designing a logical data model from the ontology

**Objective.** Start an application's logical data model from the part of the ontology it needs,
and decide its constraints oneself.

**Entry point.** *Derive from the ontology…* in the *LDM* view (Existing, 2026-10-17; roadmap LM-3).

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Makes a logical model *Film catalogue* and opens *Derive from the ontology…* | The transformation dialog: scope, configuration, target. | Existing |
| 2 | Chooses the scope: a branch, with `Person` and `Award` added, and imported classes if wanted | The proposals are read from those classes. | Existing |
| 3 | Sets the configuration: names in snake case from English labels; hierarchies as specializations | Saved with the LDM. | Existing |
| 4 | Presses *Propose again* | Proposals worked out in a worker, grouped by what they would make; the structure selected, the candidate constraints not. | Existing |
| 5 | Opens the proposal for `film`'s director | The axiom `Film SubClassOf directedBy some Director`, the relationship `film` to `person` (many-to-one, because `directedBy` is functional), and the candidate *director is mandatory*, with: "The ontology says every film has a director, known or not; a mandatory end would refuse a film whose director is not recorded." | Existing |
| 6 | Chooses that candidate, leaves the others, dismisses the proposal for `Award`'s subclasses and changes the hierarchy strategy to roll-up | The proposals change accordingly; nothing is created yet. | Existing |
| 7 | Presses *Apply the chosen* | One change to the LDM: entities, attributes, relationships, the one constraint chosen, and their semantic mappings; undo takes it back whole. The ontology's revision is unchanged. | Existing |
| 8 | Opens the ER diagram, or the *Traceability* part | The entities laid out; each element's sources in the ontology, and how its mapping stands. | Existing |

```mermaid
flowchart LR
  A["New LDM from the ontology"] --> B["Scope and configuration"]
  B --> C["Proposals: structure selected,<br/>constraints offered"]
  C --> D{"Review each"}
  D -->|choose, edit, dismiss| C
  D -->|apply| E["One LDM change,<br/>with its mappings"]
  E --> F["ER diagram, traceability"]
```

**Difficulties to design for.**

- Accepting everything must give a usable but unconstrained model; a designer who accepts in
  haste must not end up with mandatory fields the domain never required.
- Hierarchies and object properties have several good logical forms; the choice must be visible
  and cheap to change.
- Hundreds of proposals for a large scope: grouping, filtering and deciding by kind are needed.

**UX opportunities.**

- Each candidate constraint read out in words beside its axiom, with the open-world difference.
- A preview of the resulting diagram before applying.
- Decide by kind: "all attributes from this class", "none of the cardinality candidates".

### J14 Editing a logical data model

**Objective.** Shape a logical model as the application needs it, independently of the ontology.

**Entry point.** The *LDM* view (2026-10-17; roadmap LM-2).

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | Opens the *LDM* view and chooses *Film catalogue* | The entity list and the ER diagram; its findings are in the Validation view's LDM category. | Existing |
| 2 | Adds an entity `film_credit` and resolves the many-to-many between `film` and `person` into it | Two one-to-many relationships and the associative entity, with a key of the two ends; one step in the history. | Existing |
| 3 | Gives `film` a primary key `film_code` (identifier) | The key on the diagram; the finding *no primary key* goes. | Existing |
| 4 | Adds a domain `rating` with five codes, and uses it for an attribute | The domain listed; the attribute typed by it. | Existing |
| 5 | Adds a rule: "A film's release date is not before 1888." | A rule in words, attached to `release_date`. | Existing |
| 6 | Saves a version, then compares it with the previous | The LDM's changes element by element, apart from the ontology's (none). | Existing |

**Difficulties to design for.**

- Keyboard and form editing must be as complete as diagram editing (NFR-7).
- Elements with no semantic source (an audit entity) are normal, not warnings.

**UX opportunities.**

- Elements made from the ontology show a small mark, and *customised* once edited.
- The same element selected in the list, the form and the diagram.

### J15 Assessing an ontology change against logical models

**Objective.** Know what an ontology change means for every logical model derived from it, and
bring each up to date without losing one's own decisions.

**Entry point.** The *Traceability* part of the *LDM* view, whose summary says how many mappings are
stale or broken, and *Impact…* (Existing, 2026-10-17; roadmap LM-4).

| Step | User action | System response | Status |
| --- | --- | --- | --- |
| 1 | The ontology team removes `:runningTime` and makes `directedBy` no longer functional | In each LDM derived from the ontology, the affected mappings are marked stale or broken. | Existing |
| 2 | Opens *Impact* for *Film catalogue* | The report: `film.running_time` has lost its source; the relationship `film` to `person` no longer has its reason for *many-to-one*. | Existing |
| 3 | Opens *Impact* for *Rights management*, derived from the same ontology | Its own report: one attribute affected. | Existing |
| 4 | Opens the synchronization proposals | *Remove `running_time`* (proposed, not selected: the user had renamed it, so it is customised); *make the relationship many-to-many* (offered, with the reason). | Existing |
| 5 | Keeps `running_time` as application-specific and dismisses the cardinality change | The removal is turned down and the mapping removed by hand in the *Traceability* part; the element stays, with no semantic source; the dismissal is remembered until the source changes again. | Existing |
| 6 | Compares two named versions instead | The same report between those versions, for planning a change before it is made. | Existing |

**Difficulties to design for.**

- Several LDMs with different decisions about the same axiom: one report each, never merged.
- A report must say what changed in the ontology and why it matters for this model, not only
  that something did.

**UX opportunities.**

- The impact report as a list grouped by kind of change, each with a one-click proposal.
- From an ontology entity, *Where is this used?* across every LDM, before it is changed.


## 7. Assumptions and open questions

**Assumptions made in this document.**

1. The product is developed by one person; scope is ordered accordingly.
2. The first customers are single users and small teams who run it themselves. A hosted,
   multi-tenant service is not designed here.
3. OWL 2 DL is the reference language; OWL 2 Full is not a goal.
4. The SKOS vocabulary type remains a first-class kind of project, not a reduced ontology.
5. Relational databases are read, never written, by this product (and, while data integration is
   deferred, not read either).
6. The first users of data integration run the companion on a machine that can reach the
   database; a hosted service connecting into customers' networks is not designed here
   (deferred).
7. Logical data models are logical: technology-neutral types, no physical model, no DDL, no
   deployment (ADR-026). A physical layer, if ever wanted, is a separate artifact.
8. The first users of logical modelling design relational application data from an ontology they
   or their team maintain in this product; LDMs edited by hand with no ontology behind them are
   supported, not targeted.

**Open questions for the product owner.**

| Question | Why it matters | Default taken |
| --- | --- | --- |
| Will the product be open source, source-available or commercial? | Decides which libraries can be bundled and how the companion is distributed. | Undecided; no library with restrictive terms is proposed. |
| Is the SKOS-centred user (taxonomist) or the OWL-centred user (ontology engineer) the first audience? | They pull the MVP in different directions: multilingual labels and import versus class expressions and reasoning. | Ontology engineer first, because lossless OWL is the harder credibility gap. |
| How large are the ontologies the first users actually have? | Sets how early Phase 4 is needed. | 10,000 classes as the Local-profile target. |
| Is hosting a service something the developer wants to operate? | The Server profile can be delivered as software to self-host only. | Self-hosted. |
| Which ER notation, and is more than one needed? | Designers are trained on different notations. | Information Engineering (crow's foot) only. |
| Must LDMs be exchanged with other data modelling tools, and in which format? | No common logical-model format is used by every tool. | The product's own documented JSON; others when users ask. |
| Should individuals (reference data, code lists) become anything in an LDM? | Code lists often live as individuals in ontologies. | Not at first: enumerations become domains; reference data is Future. |
| Is a formal language for business rules needed early? | Rules in words cannot be checked. | Words first (FR-M17-8); a small expression language later (FR-M17-9). |
| (Deferred.) Which database do the first data-integration users have? | The first dialect is the only one for a while. | PostgreSQL (ADR-015). |
| (Deferred.) Is live querying (a virtual graph) or a governed, exportable mapping the first goal? | The first needs an engine and operations; the second is useful with an export alone. | The mapping first; the virtual graph at stage DI-4. |
| When, if ever, is data integration resumed? | It was deferred, not rejected; its design is kept. | Not scheduled; decided by the product owner (ADR-027). |
