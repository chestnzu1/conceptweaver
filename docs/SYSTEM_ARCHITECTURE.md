# System Architecture

Current state assessed against the repository as of 2026-10-13 (commit `ce6419e`). Companion
documents: [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md), [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md),
[PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md),
[DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md).

Sections 1 to 11 are the architecture of the ontology platform. **Section 12 extends it with
ontology-to-relational data integration** (database schema exploration, semantic mapping,
materialisation and virtual knowledge graphs), added on 2026-10-13 after the first version of
this document; the diagrams and tables of sections 3 and 4 include its components.

Every statement about the application carries one of four labels:

| Label | Meaning |
| --- | --- |
| **Existing** | Confirmed in the current codebase; the source file is named. |
| **Partially Implemented** | Present, but incomplete in a way that is stated. |
| **Recommended** | Proposed here; not in the code. |
| **Future** | Long-term; deliberately not designed in detail. |

## 1. Current architecture (Existing)

### 1.1 Shape

ConceptWeaver is a single-page application that runs entirely in the browser, with one optional
companion process on the same machine.

```mermaid
flowchart LR
  subgraph Browser["Browser (single page)"]
    UI["React 19 views<br/>src/components"]
    Store["zustand store<br/>src/model/store.ts"]
    Domain["Model layer<br/>src/model"]
    Svc["Service layers<br/>src/structure, src/entities"]
    Layout["Layouts in a Web Worker<br/>src/layout"]
    RDF["n3, oxigraph (WASM),<br/>rdf-validate-shacl"]
    LS[("localStorage<br/>working copy")]
    IDB[("IndexedDB<br/>saved models, external ontologies")]
  end
  subgraph Local["Same machine, optional"]
    Java["ReasonerService.java<br/>OWL API 4.5.29, HermiT"]
  end
  UI --> Store
  UI --> Svc
  UI --> Domain
  Store --> Domain
  Svc --> Domain
  Store --> Layout
  Domain --> RDF
  Store --> LS
  Store --> IDB
  Domain -- "POST /reason, /convert (Turtle in, JSON out)" --> Java
```

| Part | Where | Size | Role |
| --- | --- | --- | --- |
| Views | `src/components` (37 `.tsx`) | 12,500 lines | Graph, Entities, Structure, Validation, Align, RDF, SPARQL, Vocabulary; side panels and dialogs. |
| Store | `src/model/store.ts` | 1,800 lines | All state and 99 actions: document, undo, selection, jobs, persistence. |
| Model layer | `src/model` (71 files) | 21,100 lines incl. tests | Types, OWL rules, RDF reading and writing, both reasoning paths, validation, alignment, governance, geometry. No UI imports. |
| Structure service | `src/structure` | 4,800 lines incl. tests | Hierarchy questions behind `StructureService`; local and HTTP implementations. |
| Entities service | `src/entities` | 1,500 lines incl. tests | Search, sort, filter behind `EntityQueryService`; local and HTTP implementations. |
| Layouts | `src/layout` | 1,400 lines | Seven layouts over a neutral `LayoutGraph`; run in a worker. |
| HTML export | `src/export` | 1,300 lines | Self-contained viewer page. |
| OWL service | `reasoner/` | 930 lines | One Java file on the JDK's `HttpServer`: `/health`, `/reason`, `/convert` (and, since 2026-10-14, `/compare`, for the round-trip test). |
| Browser checks | `e2e/` (21 scripts) | 5,400 lines | Playwright scripts against the built app; one of them is a UI audit. |

Runtime dependencies are few (`package.json`): `react`, `zustand`, `n3` (Turtle), `oxigraph`
(SPARQL and RDF/XML, JSON-LD parsing, loaded on demand), `rdf-validate-shacl` with
`@zazuko/env` (SHACL Core), `@dagrejs/dagre` (one layout, loaded on demand).

### 1.2 What is sound and should be preserved

- **A model layer without UI imports.** Rules such as "what can relate two terms"
  (`src/model/props.ts`, `relating.ts`, `axioms.ts`, `reconnect.ts`) are pure functions from a
  model to a new model or a refusal with a reason. They are testable and are tested.
- **Two subsystems already written for a backend.** `src/structure/contracts.ts` and
  `src/entities/contracts.ts` define questions asked by IRI of a named revision, answered with
  plain JSON-serialisable data, a page at a time, cancellable. Each has a local implementation,
  an HTTP client (`http.ts`), a test that puts every question through JSON and compares
  (`http.test.ts`), and a test that fails if the service imports the UI or the store
  (`boundaries.test.ts`).
- **Honest reasoning results.** Results name the reasoner, say whether they are complete,
  partial or failed, and are marked stale when the model changes (`src/model/reasoning.ts`,
  `validation.ts`).
- **Separation of picture from meaning.** Positions, styles, layouts and line ends are kept out
  of RDF, and `stable(model)` (`src/model/stable.ts`) gives the same object while only the
  picture changes, so nothing is reasoned again for a drag.
- **A local companion that asks nothing of the network** and binds to `127.0.0.1`.

### 1.3 What limits it

In one sentence: **the whole ontology has to be in the page, in a shape designed for drawing.**
The consequences are itemised in [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md); the ones that shape the
architecture are TD-01 (not an axiom store), TD-03 and TD-18 (identity), TD-05 (views read the
model directly), TD-08 (reasoning on the main thread), TD-10 (the canvas draws everything) and
TD-12 (no versions).

Measured limits on the development machine (`src/model/bench.test.ts`,
`src/structure/bench.test.ts`, run on 2026-10-13; Node 22, 13th-generation Core i9):

| Operation | 650 classes | 2,600 classes | Note |
| --- | --- | --- | --- |
| In-page reasoner | 158 ms | 572 ms | Main thread, after every semantic edit. |
| Export Turtle | 19 ms (252 KB) | 123 ms (1.0 MB) | |
| Import Turtle | 99 ms | 438 ms | |
| Model as JSON | 515 KB | 2.1 MB | `localStorage` holds about 5 MB. |
| Model checks | 23 ms | 131 ms | |

| Structure service | 10,000 classes | 50,000 classes | 200,000 classes |
| --- | --- | --- | --- |
| Build the hierarchy | 28 ms | 116 ms | 646 ms |
| Inferred hierarchy from direct links | 46 ms | 266 ms | 1,322 ms |
| A page of subclasses, a search | under 2 ms | under 6 ms | under 20 ms |

The second table is the important one: the part of the application that was written against a
service interface is two orders of magnitude beyond the part that was not.

## 2. Drivers and constraints

1. **One developer.** Every moving part has to be worth its upkeep. No broker, no service mesh,
   no second language runtime until something cannot be done without it.
2. **Evolve, do not rewrite.** The application works and has 600 tests. Each step must leave it
   working.
3. **OWL correctness before features.** Losing a statement on a round trip is worse than not
   having an editor for it.
4. **Local-first stays.** Opening the app and modelling with no account and no server is the
   product's clearest advantage over the tools it is compared with.
5. **Honest scale.** The target is 10,000 or more classes and hundreds of thousands of axioms
   in daily use, with complete OWL 2 DL reasoning offered where it can finish and not promised
   where it cannot.

## 3. Target architecture (Recommended)

### 3.1 Overview

The browser application keeps its local mode. Every ontology operation goes through a service
interface. Each interface has a local implementation (today's code) and a remote one. A single
Java application, grown from the present reasoner service, implements the remote side.

```mermaid
flowchart TB
  subgraph Browser["Browser"]
    Views["Views (React)"]
    Session["Session state<br/>selection, viewport, panels"]
    Ports["Service interfaces<br/>edit, query, structure, graph, reasoning, validation,<br/>import/export, SPARQL, data sources, schema, mapping"]
    LocalImpl["Local implementations<br/>today's model layer, workers"]
    HttpImpl["HTTP implementations"]
    IDB[("IndexedDB<br/>local projects, cache, drafts")]
  end
  subgraph Server["One Spring Boot application (optional)"]
    Api["REST API and job endpoints"]
    Onto["Ontology module<br/>OWL API: load, edit, diff, serialize"]
    Reason["Reasoning module<br/>profile check, ELK, HermiT, job queue"]
    Valid["Validation module<br/>SHACL, quality rules, mapping checks"]
    Query["Query module<br/>entities, structure, graph, SPARQL"]
    Meta["Metadata module<br/>projects, versions, jobs, users"]
    Source["Data source module<br/>connections, secrets, JDBC adapters"]
    Schema["Schema module<br/>discovery, snapshots, fingerprints"]
    Mapping["Mapping module<br/>R2RML, preview, materialisation jobs"]
    Vkg["Virtual graph module<br/>manages the OBDA engine, proxies queries"]
  end
  TDB[("Jena TDB2, embedded<br/>named graphs: asserted, inferred, shapes, imports, materialised data")]
  PG[("PostgreSQL<br/>application metadata")]
  Ontop["Ontop endpoint<br/>separate process, optional"]
  Ext[("External relational databases<br/>read-only")]
  Views --> Session
  Views --> Ports
  Ports --> LocalImpl
  Ports --> HttpImpl
  LocalImpl --> IDB
  HttpImpl --> Api
  Api --> Onto
  Api --> Reason
  Api --> Valid
  Api --> Query
  Api --> Meta
  Api --> Source
  Api --> Schema
  Api --> Mapping
  Api --> Vkg
  Onto --> TDB
  Reason --> TDB
  Valid --> TDB
  Query --> TDB
  Meta --> PG
  Schema --> Source
  Mapping --> Source
  Mapping --> TDB
  Source --> Ext
  Vkg --> Ontop
  Ontop --> Ext
```

### 3.2 Three deployment profiles from one codebase

| Profile | What runs | Storage | For | Status |
| --- | --- | --- | --- | --- |
| **Local** | The static web app | IndexedDB | Trying it, small and medium ontologies, offline work. | **Existing** (with `localStorage`; see TD-11) |
| **Local with companion** | The web app and the Java application on the same machine, started with one command | IndexedDB; TDB2 in a local folder once Phase 4 lands | One person with large ontologies or a need for HermiT, ELK and every OWL syntax. | **Partially Implemented** (`pnpm reasoner`: reasoning and conversion only) |
| **Server** | The same Java application behind HTTPS, with PostgreSQL | TDB2 and PostgreSQL on the server; IndexedDB as cache and offline drafts | A team; shared projects, versions, review. | **Future** (Phase 4 storage, Phase 5 accounts) |

The companion and the server are the same artefact with different configuration. That is the
reason for choosing one application over several.

Connecting to a relational database is the one capability with no browser-only form: a browser
cannot open a database connection, and credentials must not be in it (ADR-014). It needs the
companion or a server. Without either, the Local profile can still open and edit a mapping
against a schema snapshot it has cached; it cannot discover, preview or query.

### 3.3 Component responsibilities

**Browser**

| Component | Responsibility | Status |
| --- | --- | --- |
| Views | Render, collect input, ask services. Hold no ontology rules. | Existing; TD-05 for the views that still read the model |
| Session state | Selection, viewport, open panels, dialog, theme. Never sent to a server. | Existing inside `store.ts`; split out in Phase 1 (TD-04) |
| Service interfaces | The only way a view reaches ontology content. | Existing for Structure and Entities; Recommended for the rest |
| Local implementations | Today's pure functions, called through the interfaces; reasoner and validation in workers. | Recommended (functions exist) |
| HTTP implementations | One POST or GET per question; refusals as typed errors. | Existing for two services |
| Geometry, layouts, styling | Stay in the browser in every profile: they are about the picture. | Existing |

**Server (one deployable, internal modules with enforced dependencies)**

| Module | Responsibility | Built on |
| --- | --- | --- |
| API | HTTP, authentication, authorisation, request limits, job endpoints. | Spring Web |
| Ontology | Load and save ontologies, apply change sets, compute diffs, serialize in every OWL syntax, imports closure. | OWL API |
| Reasoning | Profile detection, reasoner choice, bounded job execution, materialising results. | OWL API profiles, ELK, HermiT |
| Validation | SHACL validation, quality rules. | Jena SHACL |
| Query | Entities, structure, graph neighbourhoods, text search, SPARQL. | Jena ARQ, TDB2, Jena text index |
| Metadata | Projects, revisions, jobs, users, templates, diagrams. | Spring Data, PostgreSQL |
| Data source | Connection definitions, secrets, connection pools, dialect adapters, the read-only guard. The only module that opens a connection to an external database. | JDBC, a connection pool |
| Schema | Discovery jobs, schema snapshots, fingerprints, differences, search over schema objects. | `DatabaseMetaData` with dialect adapters |
| Mapping | The mapping model, R2RML reading and writing, coverage, mapping validation, preview, materialisation jobs. | An R2RML layer; see §12 |
| Virtual graph | Starts and stops the OBDA engine for a mapping revision, proxies SPARQL to it with limits, collects traces. | Ontop, as a separate process (ADR-016) |

Module boundaries inside the monolith are enforced by a test, as `boundaries.test.ts` does in the
frontend today (ArchUnit or Spring Modulith's verification serves the same purpose in Java).

## 4. API boundaries (Recommended)

### 4.1 The service interfaces

Each is a TypeScript interface under `src/<area>/contracts.ts`, following the two that exist.

| Service | Questions and commands | Local implementation | Status |
| --- | --- | --- | --- |
| `StructureService` | children, branches, paths, summary, search, compare, explain, analyze, members | `src/structure/local.ts` | **Existing** |
| `EntityQueryService` | describe, query, options | `src/entities/local.ts` | **Existing** |
| `OntologyEditService` | `apply(changeSet)`, `validate(changeSet)`, `entity(iri)` | `src/editing/local.ts`, over the rule functions of `axioms.ts`; the document's edits are its steps | **Existing** (2026-10-15) |
| `ReasoningService` | `start(revision, engine)`, `status(job)`, `cancel(job)`, `result(job)` | `src/reasoning/local.ts`: `reasoner.ts` in a worker; HermiT through `reasoning.ts` | **Existing** (2026-10-15) |
| `ValidationService` | `start(revision, scope)`, `status`, `cancel`, `report` | `src/validation/local.ts`: `validation.ts` in a worker | **Existing** (2026-10-15) |
| `GraphService` | `neighbourhood(roots, depth, filters)`, `search(text)` | `subgraph.ts` (`extractSubgraph`, `searchTerms`) | Recommended, Phase 2 |
| `ImportExportService` | `detect`, `read(document)`, `write(revision, syntax)` | `rdfFormats.ts`, `rdf.ts`, `files.ts` | Recommended, Phase 2 |
| `SparqlService` | `query(revision, text, graph)` | `sparql.ts` | Recommended, Phase 2 |
| `AlignmentService` | external ontologies, mappings, suggestions | `external.ts`, `alignment.ts`, `matcher.ts` | Recommended, Phase 2 |
| `ProjectService` | versions, save a version, a version's model, diff, restore; list, open and save | `src/projects/local.ts` over `library.ts` | **Existing** for versions (2026-10-16); list, open and save are still `library.ts` called directly |
| `DataSourceService` | list, create, update, remove, test; never answers with a secret | None: backend only | Recommended, Phase 3 |
| `SchemaService` | refresh (job), snapshot, objects (paged search), table detail, relationships, sample rows, difference of two snapshots | A cached snapshot, read-only | Recommended, Phase 3 |
| `MappingService` | get, apply a mapping change, coverage, validate (job), import and export R2RML, revisions | Editing and static checks over a cached snapshot | Recommended, Phase 4 |
| `RdfGenerationService` | preview a mapping rule on a bounded number of rows; materialise (job) | None: backend only | Recommended, Phase 4 |
| `VirtualGraphService` | deploy a mapping revision, status, query, explain | None: backend only | Recommended, Phase 5 |

### 4.2 Conventions, taken from the existing contracts

These are what the two existing services already do; the new ones follow them so that a view
cannot tell a local service from a remote one.

- **Entities are named by IRI**, never by an internal id or a label (resolves TD-18).
- **Every question names a revision** (`ontologyId`, `revisionId`). An answer for a revision
  that is no longer current is refused with `stale-revision` (HTTP 409).
- **Plain data only**: no maps, sets, functions or class instances, so that a question and its
  answer are JSON.
- **Lists are paged**; the service may return fewer than asked for.
- **Calls can be given up** (`AbortSignal`), and a refusal is a typed error with a code:
  `stale-revision` 409, `not-found` 404, `invalid` 400, `unsupported` 501.
- **Read and write are separate interfaces.** A query service never changes an ontology.
- **Long work is a job**: start returns an id at once; status reports progress and can be
  polled or streamed (Server-Sent Events); cancel is always available.

### 4.3 The change-set contract

This is the one genuinely new piece of design, and the hinge of the migration. An edit is a
list of axiom additions and removals against a base revision:

```ts
interface ChangeSet {
  ontologyId: string;
  baseRevision: string;
  changes: { op: 'add' | 'remove'; axiom: Axiom }[];
  /** For the history: what the user did, in words. */
  summary: string;
}

type Axiom =
  | { type: 'Declaration'; entity: EntityRef }
  | { type: 'SubClassOf'; sub: ClassExpression; sup: ClassExpression }
  | { type: 'EquivalentClasses'; classes: ClassExpression[] }
  | { type: 'ClassAssertion'; class: ClassExpression; individual: Iri }
  | { type: 'ObjectPropertyAssertion'; property: Iri; source: Iri; target: Iri }
  | { type: 'AnnotationAssertion'; property: Iri; subject: Iri; value: Literal | Iri }
  // … one member for each OWL 2 axiom type, added as editors arrive
  | { type: 'Unmapped'; turtle: string };
```

- The local implementation translates a change set into the model operations that exist today.
- The server implementation translates it into `OWLOntologyChange` objects and applies them in
  one transaction.
- Applying is atomic: every change, or none, and a new revision id on success.
- A change set is also the unit of undo, of history (TD-12) and, later, of synchronisation
  (AR-04).

`Unmapped` carries statements neither side has a typed form for yet, so that nothing is lost
while the typed list grows.

**Status, 2026-10-15 (roadmap task 1.8).** `src/editing/contracts.ts` is this contract, with the
axiom list grown to what the editor states (declarations, class axioms with full class
expressions, assertions, property axioms and characteristics, datatype definitions, annotations,
the ontology's IRI, annotations and imports), and `Refusal`s with codes (`invalid`, `refused`,
`unsupported`). The local implementation (`src/editing/local.ts`) differs from the sketch above in
one respect, as §5.1's risk asked: an edit made in the editor is applied as the parts of the model
it replaced (a step), and its axioms are worked out at the document boundary when they are asked
for, because working them out costs as much as an export (half a second at 2,600 classes). A
change set made elsewhere is applied to the ontology's statements, read back, and taken only if
the result states exactly what was asked. Undo applies a step backwards. See the README, *Edits
as change sets*.

### 4.4 REST sketch for the remote side

Paths follow the pattern the existing HTTP clients use (`POST {base}/structure/{question}`),
placed under a versioned, project-scoped prefix.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/projects`, `POST /api/v1/projects` | List, create. |
| `GET /api/v1/projects/{id}/revisions` | History, newest first, paged. |
| `POST /api/v1/projects/{id}/changes` | Apply a change set; answers the new revision. |
| `GET /api/v1/projects/{id}/diff?from=&to=` | Axioms added and removed between two revisions. |
| `POST /api/v1/projects/{id}/structure/{question}` | `StructureService`, unchanged. |
| `POST /api/v1/projects/{id}/entities/{question}` | `EntityQueryService`, unchanged. |
| `POST /api/v1/projects/{id}/graph/neighbourhood` | `GraphService`. |
| `POST /api/v1/projects/{id}/reasoning/jobs`, `GET …/jobs/{job}`, `DELETE …/jobs/{job}` | Start, follow, cancel. |
| `POST /api/v1/projects/{id}/validation/jobs` … | Same shape. |
| `POST /api/v1/projects/{id}/sparql` | Read-only query against a chosen graph. |
| `GET /api/v1/projects/{id}/export?revision=&syntax=` | Serialize. |
| `POST /api/v1/convert`, `POST /api/v1/reason` | Stateless, as today's `/convert` and `/reason`; kept for the Local profile. |
| `GET`, `POST /api/v1/data-sources`; `POST …/{source}/test` | Define and test a connection. A secret is write-only. |
| `POST /api/v1/data-sources/{source}/schema/refresh`; `GET …/schema/snapshots/{snapshot}/objects` | Discover (a job); browse and search a snapshot, a page at a time. |
| `GET /api/v1/data-sources/{source}/tables/{table}/sample?limit=` | A bounded sample of rows. |
| `GET`, `POST /api/v1/projects/{id}/mappings/{set}`; `…/revisions`; `…/export?syntax=r2rml` | Read, change, version and exchange a mapping set. |
| `POST /api/v1/projects/{id}/mappings/{set}/preview` | Triples generated from the first rows of one rule, with diagnostics. |
| `POST /api/v1/projects/{id}/mappings/{set}/materialisations` | Materialise as a job. |
| `POST /api/v1/projects/{id}/virtual-graphs/{graph}/sparql`; `…/explain` | Query through the ontology; see the SQL it became. |

## 5. Data flow

### 5.1 An edit

```mermaid
sequenceDiagram
  participant V as View
  participant E as OntologyEditService
  participant L as Local model
  participant S as Server
  V->>E: apply(changeSet on revision r)
  alt Local profile
    E->>L: check rules, apply
    L-->>E: revision r+1, or refusal with reason
  else Server profile
    E->>S: POST /changes
    S->>S: check rules, apply in one transaction
    S-->>E: revision r+1, or 409 stale / 400 invalid
  end
  E-->>V: new revision, or reason
  V->>V: results of r marked stale, queries re-asked
```

### 5.2 Reasoning

```mermaid
sequenceDiagram
  participant V as View
  participant R as ReasoningService
  participant J as Job executor
  participant G as Triple store
  V->>R: start(revision r, engine auto)
  R->>J: enqueue
  R-->>V: job id
  J->>J: profile check, choose reasoner
  J->>J: classify with time and memory limits
  J->>G: write inferred graph for (r, reasoner)
  V->>R: status(job)
  R-->>V: done, complete or partial or failed, with reasons
  V->>R: structure questions with hierarchy "inferred"
```

In the Local profile the job executor is a Web Worker for the in-page reasoner, or the companion
for HermiT and ELK; nothing is written to a triple store and the result is held in memory, as
now.

## 6. Technology stack evaluation

The brief proposes a stack. Each choice is weighed here against what the application needs and
what one person can maintain.

### 6.1 Frontend

| Choice | Verdict | Reasons |
| --- | --- | --- |
| TypeScript, React 19, Vite | **Keep** (Existing) | Working, tested, current. |
| zustand | **Keep, split** | Adequate. The problem is one store doing everything (TD-04), not the library. |
| Own SVG canvas | **Keep** (ADR-008) | Routing, label placement, styles, line ends and exports are built on it. A graph library would replace roughly 4,000 lines that work and would not remove the need for subgraph loading. |
| n3, oxigraph, rdf-validate-shacl | **Keep for the Local profile** | They are what makes the app work with no server. |
| A component library | **Do not add** | The UI is consistent and passes its own audit of contrast, text size and pointer-target size (`e2e/ui-audit.mjs`); a library would be a restyle of every view. |

### 6.2 Backend

| Choice | Verdict | For | Against |
| --- | --- | --- | --- |
| **Java with Spring Boot** | **Adopt in Phase 3** | The OWL API, HermiT, ELK and Jena are Java libraries; there is no equivalent elsewhere. Spring Boot gives HTTP, validation, security, scheduling, database migration and testing in one maintained package, replacing 300 hand-written lines of server plumbing. | Start-up time and memory are larger than today's single file. A second language for one developer. |
| Keeping the single-file service | Rejected beyond Phase 2 | No build, starts fast. | No dependency management, no tests, no job model; everything a real backend needs would be written by hand (TD-14). |
| Node.js backend | Rejected | One language. | No OWL API, no DL reasoner; it would still need the JVM beside it. |
| Microservices | Rejected (ADR-003) | Independent scaling of reasoning. | Deployment, versioning and observability cost that one developer cannot carry. A bounded in-process job queue gives the isolation that matters; a reasoner can be moved to its own process later behind the same interface if it ever has to be. |

Baseline: **JDK 21** and the current Spring Boot major line. Jena 5 requires Java 17 and Jena 6
is announced with Java 21 as its minimum; Spring Boot 4 requires Java 17 or later. Choosing 21
now avoids a second migration. The present service states Java 11; this is a requirement change
for users of the companion and must be said in the release notes.

### 6.3 Ontology processing

| Choice | Verdict | For | Against |
| --- | --- | --- | --- |
| **OWL API** | **Adopt as the server's canonical model** (ADR-004). Already in use: 4.5.29. | Complete OWL 2 structural model, every syntax, profile checkers, diff by structural equality, the interface every Java reasoner implements. | A large API. Version 4 and 5 differ; reasoner builds are tied to one or the other (AR-03). |
| **HermiT** | **Keep** (Existing) | Complete for OWL 2 DL; justifications through the explanation library already wired in. | Worst-case behaviour (AR-02). Its last published Maven build dates from 2020, so fixes should not be counted on. |
| **ELK** | **Adopt early** | Polynomial for OWL 2 EL; classifies ontologies of hundreds of thousands of classes in seconds to minutes on ordinary hardware according to its authors' published results. It is already inside `robot.jar`, so offering it in the companion needs no new dependency. | Incomplete outside OWL 2 EL: results must be labelled, as the in-page reasoner's are. |
| In-page rule reasoner | **Keep for the Local profile** (Existing) | Instant, no install, explains each inference from stated facts. | A subset of OWL 2 RL; must never be presented as complete. |
| A general OWL 2 RL engine on the server | Not now | Jena's rule engines exist. | ELK and HermiT cover the need; a third engine is a third set of behaviours to explain. |

### 6.4 Storage

| Choice | Verdict | For | Against |
| --- | --- | --- | --- |
| **Apache Jena TDB2, embedded** | **Adopt in Phase 4** (ADR-006) | Transactional (ACID, serialisable), named graphs, runs inside the application with no separate server, SPARQL 1.1 through ARQ, a SHACL engine and a Lucene text index in the same project. One dependency family for storage, query, validation and search. | Single-writer; no built-in clustering. Jena 3.17 with TDB1 is in today's bundle, so TDB2 is a new dependency, not a reuse. |
| Eclipse RDF4J (Native or LMDB store) | Evaluated, not chosen | Also embeddable; a SHACL engine that validates on commit; RDF4J model classes already arrive with the OWL API. | No decisive advantage for this workload, and a second RDF framework beside Jena's SPARQL and SHACL tooling. Chosen only if the spike in AR-03 finds Jena and the OWL API cannot share a classpath cleanly. |
| A separate triple-store server (Fuseki, GraphDB) | Rejected for now | Scales out; PoolParty's documentation names GraphDB or RDF4J as its store. | Another process to install, secure, back up and upgrade. The embedded store can be exposed as a SPARQL endpoint later without moving the data. |
| **PostgreSQL** | **Adopt with the Server profile only** (ADR-007) | Users, projects, jobs, audit: relational data with real integrity needs. | Not needed until there is more than one user. The companion uses an embedded file database through the same migration scripts, so there is one schema. |
| **IndexedDB** | **Keep and extend** (Existing) | Local projects, cache of fetched ontologies, offline drafts. | Evictable (AR-09). |

### 6.5 AI services

| Choice | Verdict | Reasons |
| --- | --- | --- |
| Python services | **Defer to Phase 5** (ADR-010) | Nothing in Phases 1–4 needs them. A third runtime is the most expensive item on the list for one maintainer. |
| Embedding-based matching | Future | `src/model/matcher.ts` is already a list of `Matcher` functions; an embedding matcher is another entry, and can call a hosted embedding API from the Java application without any Python. |
| LLM-assisted modelling | Future | Calls to a hosted model from the server, behind one interface, producing change sets a person accepts. No model is run locally by default. |

## 7. Reasoner orchestration (Recommended)

### 7.1 Choosing a reasoner

```mermaid
flowchart TD
  A["Reasoning requested for revision r"] --> B{"Profile of the<br/>imports closure"}
  B -- "OWL 2 EL" --> C["ELK: complete"]
  B -- "OWL 2 DL, within size budget" --> D["HermiT: complete"]
  B -- "OWL 2 DL, over budget" --> E["ELK on the EL part: partial,<br/>ignored axioms listed"]
  B -- "outside OWL 2 DL" --> F["Refuse DL reasoning,<br/>list the violations"]
  D -- "time or memory limit" --> E
  C --> G["Inferred graph for (r, reasoner),<br/>status and limits recorded"]
  D --> G
  E --> G
```

- The profile check uses the OWL API's profile classes, which the current service already calls
  for OWL 2 DL (`OWL2DLProfile` in `reasoner/ReasonerService.java`).
- "Auto" is a default, not a constraint: the user can ask for a specific reasoner.
- The size budget is configuration, set from measurement, not a constant in code.

### 7.2 Rules that hold for every reasoner

Each of these is how the application behaves today and is carried over unchanged.

1. A result names its reasoner and version, the revision it is of, and whether it is *complete*,
   *partial* (with what was left out) or *failed*.
2. An inconsistent ontology has no inferred hierarchy: none is shown, and the asserted one is
   never put in its place.
3. Inferred statements are never written into the asserted ontology. They are a separate graph,
   exported only on request.
4. A result for an older revision is stale and is shown as such.
5. Justifications come from the reasoner's explanation machinery within a time limit, or the
   finding says none was computed.

### 7.3 Jobs

- One bounded executor for reasoning (default: one job at a time per installation, queue of a
  few) so that two classifications cannot exhaust the heap together (fixes TD-14).
- Each job has a wall-clock limit and is interrupted when it passes it; a job that does not
  respond to interruption is the one case for running reasoners in a child process, which the
  interface allows without changing callers.
- Results are cached by revision and reasoner. Reasoning again without an edit is free.
- **Incremental reasoning is not promised.** ELK supports incremental classification for some
  kinds of change; HermiT does not. The design assumes a full run per revision and treats
  anything faster as an optimisation.

## 8. Scalability and performance

Three different problems, with different answers.

### 8.1 Storage scalability

| Scale | Local profile | With TDB2 |
| --- | --- | --- |
| Up to about 5,000 classes, 50,000 triples | Works today. | Not needed. |
| 10,000–100,000 classes, up to a few million triples | Model in memory is possible (the model accepts 250,000 terms since 2026-10-15, `MAX_TERMS`; it was 50,000), but parsing takes seconds and the working copy must move to IndexedDB (TD-11). | Comfortable. Queries are index lookups; text search through the Lucene index. |
| Tens of millions of triples (instance data) | Not a goal. | Ordinary for TDB2 on one machine with adequate memory and SSD storage. Bulk loading at this size is done with the bulk loader as an offline job, not through the API. |
| Beyond one machine | — | Out of scope. TDB2 does not cluster; that would be the point to move to a server product behind the same query module. |

Design consequences:

- **Do not load, ask.** The Entities and Structure services already work this way. With a
  triple store their server implementations become SPARQL plus a small label index.
- **Cache by revision.** Depths, counts and the hierarchy are computed once per revision and
  kept, as `src/structure` does in memory today.
- **Index what is searched.** Labels, alternative labels, IRIs and definitions go into the text
  index when a revision is committed.
- **Version economically.** Change sets for every revision, snapshots for tagged releases
  (AR-06, [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §6).

### 8.2 Reasoning scalability

| Fragment | Complexity (taxonomic reasoning) | Reasoner | Realistic expectation |
| --- | --- | --- | --- |
| RDFS and the rules the app implements | Polynomial | In-page | Hundreds of milliseconds at a few thousand classes (measured above); move to a worker. |
| OWL 2 EL | Polynomial | ELK | Large terminologies (hundreds of thousands of classes) classify in seconds to minutes. |
| OWL 2 RL | Polynomial | Rule engines | Not planned as a separate engine. |
| OWL 2 DL | N2EXPTIME-complete in the worst case | HermiT | Unpredictable. Many ontologies of tens of thousands of classes classify in seconds; some small, highly expressive ones do not finish. |

What follows:

- Complete OWL 2 DL reasoning is **offered, bounded and reported**, never assumed.
- The time limit and heap are settings shown to the user with the result, so that "failed after
  60 seconds" is something they can act on.
- **Materialisation is selective.** Store the inferred class hierarchy, unsatisfiable classes,
  inferred types and inferred property assertions (what the service extracts today). Do not
  materialise the full deductive closure.
- **Explanations are on demand**, one entailment at a time, with their own limit.
- Module extraction (the OWL API's locality-based modules, present in the bundle) is a later
  optimisation for explaining or reasoning over the part of an ontology relevant to one class.

### 8.3 Visualization scalability

| Technique | State | Effect |
| --- | --- | --- |
| Subgraph extraction (`extractSubgraph`, default 250 terms, depth up to 6) | **Existing** | The Graph view stays useful on any size of ontology. |
| Paged tables (150 rows at a time, asked of a query service) | **Existing** | Entities page independent of ontology size. |
| On-demand hierarchy expansion (a branch or a page at a time), only the lines in view drawn | **Existing** | Structure Explorer to 200,000 classes. |
| Not drawing the canvas while another view covers it | **Existing** | Other views stay fast with a large model open. |
| Layout in a worker, cancellable | **Existing** | The page stays responsive while arranging. |
| Viewport culling | **Recommended**, Phase 2 | Cost follows what is visible, not what exists (TD-10). |
| Level of detail by zoom | **Partially Implemented** (labels only) | Zoomed-out views stay drawable. |
| Subgraph-first opening above a threshold | **Recommended**, Phase 2 | A 50,000-class ontology opens in Structure and Entities; the graph is asked for by neighbourhood. |
| Server-side neighbourhood queries (`GraphService`) | **Recommended**, Phase 4 | The browser never holds the whole ontology. |
| Canvas 2D or WebGL rendering | **Future**, only if needed | See AR-08. |

A statement of limits: no technique makes a readable picture of 10,000 nodes. The goal is not
to draw large ontologies whole but to make every part of them reachable in a picture of a few
hundred terms.

### 8.4 Concurrent users and large imports

- **Concurrent users** matter from Phase 5. TDB2 allows many readers with one writer; writes are
  short (a change set), so a single writer is adequate for editing teams of tens. Reasoning and
  validation are jobs and do not hold a write transaction.
- **Large tabular imports** (hundreds of thousands of rows) are jobs too: parse and map in a
  stream, validate against the mapping, produce a preview and a change set, apply on
  confirmation. In the Local profile the practical limit is browser memory (tens of thousands
  of rows); beyond that the companion does it.

## 9. Security

Nothing here is needed for the Local profile, which has no server. All of it is needed before
the Server profile is exposed.

| Concern | Measure |
| --- | --- |
| Authentication | Delegated: OpenID Connect through Spring Security. No password storage in the application. |
| Authorisation | Role per project (viewer, commenter, editor, owner), checked in one place in the API module for every project-scoped path. |
| Untrusted RDF/XML and OWL/XML | XML parsers configured to refuse external entities and DTDs. Upload size limit (the current service already caps a body at 64 MB). |
| Imports | The server does not fetch arbitrary URLs on a user's behalf without an allow-list (server-side request forgery). Today's service fetches nothing; keep that as the default. |
| SPARQL | Read-only (no `UPDATE`, no `SERVICE`), per-query time limit and result cap. |
| Cross-origin access | The companion keeps the origin allow-list it has (`--allow-origin`). The server uses same-origin deployment where possible. |
| Secrets | Database and provider credentials from the environment, never in the repository. |
| Auditing | Every change set records who and when (it is the history). |
| AI providers | Off unless configured; what is sent is shown before it is sent (AR-10). |
| External databases | Credentials, read-only access, user-written SQL and row data: §12.9. |

## 10. Deployment

| Option | How | When |
| --- | --- | --- |
| Static site | `pnpm build`, any static host. | Today. |
| Companion | One command starts the Java application and opens the app; packaged as a runnable jar. | Phase 3. |
| Single container | One image with the Java application serving the built frontend; a volume for TDB2; PostgreSQL beside it with Docker Compose. | Phase 4–5. |
| Managed platform | The same image on any container host with managed PostgreSQL and a persistent disk. | When there are users to justify it. |

Operational needs to plan for from the first server deployment: backup of the TDB2 directory
and the database together (a version is consistent only if both are), health endpoints, and
structured logs. Metrics and tracing can wait.

## 11. Architecture decision records

Short form. Each is revisited when its "revisit if" becomes true.

| Id | Decision | Why | Revisit if |
| --- | --- | --- | --- |
| **ADR-001** | The browser-only Local profile remains a first-class way to run the product. | It is the differentiator, and it keeps the application usable when no server is. | Maintaining two implementations of a service costs more than the profile is worth. |
| **ADR-002** | Every ontology operation goes through a service interface with a local and an HTTP implementation. | The pattern exists, is tested, and is the only incremental path off "everything in the page". | — |
| **ADR-003** | One Spring Boot application with internal modules; no microservices, no message broker. | One developer; one thing to deploy, monitor and upgrade. | A reasoner must be isolated in its own process for stability. |
| **ADR-004** | On the server the OWL API's ontology is the canonical form, persisted as RDF named graphs. The TypeScript `Model` remains the editing view and the offline file format. | Lossless OWL (TD-01) without rewriting the frontend. | — |
| **ADR-005** | Reasoner chosen by OWL profile; results are bounded jobs, labelled complete, partial or failed, stored apart from asserted axioms. | AR-02; continues present behaviour. | — |
| **ADR-006** | Apache Jena TDB2, embedded, for RDF storage and SPARQL. | One dependency family for storage, query, SHACL and text search; no separate server. | The classpath spike fails (then RDF4J), or data outgrows one machine. |
| **ADR-007** | PostgreSQL for application metadata in the Server profile only; the companion uses an embedded database with the same schema; the Local profile uses IndexedDB. | Integrity where there are users; nothing to install where there are none. | — |
| **ADR-008** | Keep the SVG canvas. Add culling, level of detail and subgraph-first loading before considering another renderer. | Preserves working routing, styling and exports; addresses the actual limit (TD-10). | Culling and subgraphs are in place and the Graph view is still the bottleneck. |
| **ADR-009** | Versions are immutable revisions, each a change set on its predecessor; full snapshots for tagged releases. | TD-12, AR-06. | — |
| **ADR-010** | AI features are optional suggestion services behind existing interfaces, deferred to Phase 5, with no Python runtime until one is unavoidable. | Cost of a third runtime; AR-10. | A required capability has no hosted or JVM option. |
| **ADR-011** | JDK 21 and the current Spring Boot major line as the server baseline. | Jena's and Spring's stated minimums; avoids a second migration. | — |
| **ADR-012** | Entities are identified by IRI in every contract; internal ids are private to the local model. | TD-03, TD-18. | — |
| **ADR-020** | No OWL axiom becomes a SHACL constraint, and no shape an axiom, without the user's review. Shapes drawn from the ontology are proposals, each stating what the axiom means, what the shape would check and where they differ, accepted one by one with their origin kept. | An axiom licenses inferences under the open world and no unique names; a shape checks the data a graph holds. `p exactly 1 C` is not `sh:minCount 1 ; sh:maxCount 1`, and a domain or range infers a type rather than requiring a value. The same rule as ADR-017, from the ontology's side. | — |
| **ADR-021** | Shapes are SHACL 1.0 Core (the W3C Recommendation of 2017) first, validated by `rdf-validate-shacl` in the page and Jena SHACL on the server; SHACL-SPARQL on the server only; SHACL 1.2 is built on once it is a Recommendation. | A stable standard with a test suite both engines can be held to. | SHACL 1.2 becomes a Recommendation. |

ADR-013 to ADR-019, on data integration, are in §12.11.

## 12. Ontology-to-relational data integration (Recommended)

Nothing in this section exists in the code today. It extends the target architecture with a
third concern beside modelling and managing ontologies: **connecting the conceptual model to
the relational databases where the data is.**

### 12.1 How it fits

Four things are kept apart, and a fifth joins them:

| Plane | What it holds | Who owns it | Where it lives |
| --- | --- | --- | --- |
| **Conceptual** | The ontology: classes, properties, axioms. | The modeller. | Asserted graph (§3, [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §4). |
| **Constraint** | What data an application accepts: SHACL shape sets, several per ontology, one per application or source. Added 2026-10-15 (the SHACL track, [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §1.4). | The data steward, the application's owner. | One shapes graph per shape set; in the model locally. |
| **Physical** | A database's schema: tables, columns, types, keys. | The database's owner. The application only reads it. | Schema snapshots (metadata store). |
| **Mapping** | How rows of the physical plane become statements in the terms of the conceptual one. | The data integrator. | Mapping sets, as R2RML. |
| **Data** | The rows themselves, or triples made from them. | The database. | In the source database; optionally a materialised copy. |

The ontology never mentions a table, and a schema snapshot never mentions a class. Only a
mapping refers to both. Shapes name the ontology's classes and properties, since they constrain
the data a mapping makes in its terms, but they are not axioms (ADR-020): SHACL validates the
RDF data graph a mapping presents, never the database itself, and a shape set is chosen for
each validation. That is what lets each change on its own schedule, and it is the
separation R2RML itself is built on.

Two properties of this capability set it apart from everything in sections 1 to 11:

- **It cannot run in a browser alone.** It is the first feature with no Local-profile
  implementation of its core (ADR-014). The mapping *document* can still be edited offline.
- **It reaches into systems the product does not own.** Every design choice below starts from
  read-only access, bounded work and no stored row data.

### 12.2 Schema mapping, materialisation and virtual knowledge graphs

Three different things that are often spoken of as one.

| | Schema mapping | RDF materialisation | Virtual knowledge graph |
| --- | --- | --- | --- |
| What it is | A *description*: which rows become which triples. | *Running* the description and storing the triples. | *Answering a query* by rewriting SPARQL into SQL through the description. Nothing is stored. |
| Where the data is | Nowhere new. | A copy, in a named graph of the triple store. | Only in the source database. |
| Freshness | — | As of the last run. | Live. |
| Query capability | — | All of SPARQL 1.1 over the copy. | Most of SPARQL 1.1, read-only, within the engine's limits. |
| Reasoning | — | Whatever a reasoner can do at that size; SHACL over the copy. | Query rewriting with the OWL 2 QL part of the ontology; the rest of the ontology plays no part. |
| Cost | Authoring. | Storage, run time, staleness, re-runs. | Load on the source database at query time; speed depends on its indexes. |
| Needs | Ontology and schema snapshot. | A mapping and the triple store (Phase 4). | A mapping and an OBDA engine. |
| Delivered in | Stages DI-2 and DI-3. | Stage DI-4. | Stage DI-4. |

The mapping is the asset. Materialisation and virtualisation are two ways of using the same
mapping, and a project may use both: a virtual graph for live questions, a materialised sample
for validation against shapes.

### 12.3 Components

All but one are modules of the one Java application (§3.3). They are separated by what they
may touch:

| Component | May touch | Must not |
| --- | --- | --- |
| **Data source module** | External databases, through JDBC; the secret store. | Be bypassed: no other module opens a connection. |
| **Schema module** | The data source module (to read metadata); the metadata store. | Read rows, except the bounded sample it is asked for. |
| **Mapping module** | Mapping sets, schema snapshots, the ontology's entity list. | Open connections itself; it asks the data source module to run a statement. |
| **RDF generation** (part of the mapping module) | A statement runner from the data source module; the triple store, for materialisation. | Return unbounded results to a browser. |
| **Virtual graph module** | The OBDA engine's process and its configuration. | Expose the engine's endpoint directly; every query passes through the API. |
| **Ontop endpoint** | One external database, read-only; one ontology export; one R2RML file. | Be reachable from outside the host. |

```mermaid
flowchart LR
  subgraph Browser
    Exp["Schema Explorer"]
    Wb["Mapping Workbench"]
    Sp["SPARQL view"]
    Val["Validation view"]
  end
  subgraph App["Java application"]
    DS["Data source module<br/>pools, secrets, read-only guard"]
    SC["Schema module<br/>discovery, snapshots"]
    MP["Mapping module<br/>R2RML, coverage, checks"]
    RG["RDF generation<br/>preview, materialise"]
    VG["Virtual graph module"]
  end
  MS[("Metadata store<br/>sources, snapshots, mapping revisions")]
  TDB[("TDB2<br/>materialised data graphs")]
  OT["Ontop endpoint"]
  DB[("Relational database")]
  Exp --> SC
  Wb --> MP
  Wb --> RG
  Val --> MP
  Sp --> VG
  SC --> DS
  RG --> DS
  DS --> DB
  SC --> MS
  MP --> MS
  RG --> TDB
  VG --> OT
  OT --> DB
```

In the browser, three new service areas follow the existing pattern (`contracts.ts`, an HTTP
implementation, a boundary test): data sources, schema, mapping. Mapping logic that needs no
database (the mapping model, IRI templates, static checks against a snapshot, R2RML reading and
writing) is written once in TypeScript without React imports, so that it runs in the page for
offline editing and is mirrored by the server for validation.

### 12.4 Data flows

**Discovering a schema**

```mermaid
sequenceDiagram
  participant V as Schema Explorer
  participant S as Schema module
  participant D as Data source module
  participant X as External database
  participant M as Metadata store
  V->>S: refresh(source, chosen schemas)
  S-->>V: job id
  S->>D: metadata reader for source
  D->>X: read catalog metadata, read-only, with a time limit
  X-->>D: schemas, tables, columns, keys
  S->>M: store snapshot and its fingerprint
  V->>S: objects(snapshot, search, page)
  S-->>V: one page of tables or columns
```

**Previewing a mapping rule**

```mermaid
sequenceDiagram
  participant W as Mapping Workbench
  participant G as RDF generation
  participant D as Data source module
  participant X as External database
  W->>G: preview(rule, limit 50)
  G->>G: build one SELECT for the rule's logical table
  G->>D: run(statement, row limit, time limit)
  D->>X: read-only transaction
  X-->>D: at most 50 rows
  G->>G: apply IRI template and value conversions per row
  G-->>W: triples, and per row what was skipped and why
```

**Querying through the ontology**

```mermaid
sequenceDiagram
  participant Q as SPARQL view
  participant VG as Virtual graph module
  participant O as Ontop endpoint
  participant X as External database
  Q->>VG: query(SPARQL in ontology terms)
  VG->>VG: check permission, apply time and result limits
  VG->>O: forward the query
  O->>O: rewrite with the ontology and the mapping into SQL
  O->>X: SQL, read-only
  X-->>O: rows
  O-->>VG: RDF-form results
  VG-->>Q: a page of results, with the SQL and timings on request
```

### 12.5 What is reused, and what is new

**Reused.** Each of these exists today and is named with its file.

| Existing component | Reused for |
| --- | --- |
| Entity lists and search (`src/entities/`, `src/components/EntityPicker.tsx`, `TermList.tsx`) | The ontology side of the workbench: classes, object and data properties, with a "not mapped" filter beside the existing ones. |
| Class hierarchy service and its tree model (`src/structure/contracts.ts`, `outline.ts`) | The hierarchy in the ontology explorer; and the same paged, branch-at-a-time tree model for schemas, tables and columns, which can run to hundreds of thousands of lines. |
| Layouts over a neutral graph (`src/layout/`, `LayoutGraph`) and line geometry (`src/model/geometry.ts`) | The diagram of tables and their foreign keys. The layouts take any nodes and edges. |
| Validation results model (`Finding`, `ValidationRun`, `isStale` in `src/model/validation.ts`; the results table in `Validation.tsx`) | Mapping checks as a further category of finding, stale when the mapping, the ontology or the schema fingerprint changes. |
| SHACL over imported data (`DataGraph` with `source: 'imported'` in `validation.ts`) | Validating previewed or materialised triples against the project's shapes, with no new engine. |
| Datatypes and literal checking (`DATATYPES` in `src/model/types.ts`, `validateLiteral` in `literals.ts`) | Checking that a column's values convert to the datatype a property expects. |
| IRIs and prefixes (`src/model/iri.ts`, `prefixes.ts`: `isAbsoluteIri`, `compactIri`, `baseIriOf`) | Validating IRI templates; a default namespace for instance IRIs; showing generated IRIs compactly. |
| Suggestions with accept and reject (`Matcher`, `Suggestion`, `Feature` in `src/model/matcher.ts`; `MappingMeta.status`) | Proposing column-to-property and table-to-class candidates lexically, each accepted or turned down, with a review status. |
| The alignment workbench's two-list form (`Align` in `src/components/Alignment.tsx`) | The non-drag way of making a mapping: choose one on each side, choose how, add. |
| Triples table and SPARQL results (`RdfView.tsx`, `SparqlView.tsx`, `runSparql`) | Showing previewed triples; querying a virtual graph, with CSV download. |
| Governance fields `database`, `schema`, `table`, `column`, `physicalType` and the *technical data asset* kind (`src/model/governance.ts`) | These are free text today. They become links to real schema objects, which gives lineage without a new concept. |
| Browser cache with a "not on this machine" state (`externals` store in `src/model/library.ts`) | Caching schema snapshots and mapping drafts for offline editing. Never credentials, never rows. |
| The service pattern and its error codes (`http.ts`, `boundaries.test.ts`, `stale-revision`) | Every new interface. |
| The mapping core of tabular import (`src/mapping/`: `template.ts`, `values.ts`, `plan.ts`; **Existing** since 2026-10-16, task 2.4) | The same mapping core: IRI templates, column-to-property rules, value conversion, preview with row-level reasons (ADR-019). Its input is a `Table` of named columns, which a database result is as well as a file. |

**Not reusable as it is.** The canvas (`src/components/Canvas.tsx`) draws the ontology's own
`Model` and edits it (TD-05). A schema is not an ontology and must not be forced into that
type. The table diagram reuses layouts and geometry beneath it, in a small read-only view of
its own.

**New.**

| New component | Why nothing existing serves |
| --- | --- |
| Data source module with dialect adapters | The application has never opened a database connection. |
| Secret handling | There have been no secrets. |
| Schema snapshots, fingerprints and their difference | No model of a relational schema exists. |
| Mapping model with R2RML reader and writer | Alignment maps entity to entity; this maps entity to table, column and join. |
| Preview evaluator | Rows into triples, a few at a time, with reasons. |
| Virtual graph module and the OBDA engine | SPARQL-to-SQL rewriting is a research-grade system; it is adopted, not written. |
| Schema Explorer and Mapping Workbench views | New views; built from existing parts as above. |

### 12.6 Technology evaluation

| Choice | Verdict | For | Against |
| --- | --- | --- | --- |
| **JDBC in the backend, with a connection pool per data source** | **Adopt** (ADR-014) | The standard way; every target database has a driver; Spring Boot manages pools. | Each driver is a dependency and an attack surface (§12.9). |
| Database access from the browser | Rejected | — | Impossible without a proxy, and it would put credentials in the page. |
| **`DatabaseMetaData` plus a dialect adapter** | **Adopt** | Tables, columns, primary keys, foreign keys and unique indexes are available through one portable interface. | Dialects differ in what a "schema" is, in identifier case, in type names, in how comments and view definitions are read. Each needs an adapter and its own tests. |
| **PostgreSQL first, alone** | **Adopt** (ADR-015) | The Server profile already uses it, so the driver, the test containers and the expertise are shared. Its catalog is regular. One dialect lets the adapter interface be shaped by a real case before it is generalised. | Enterprise users often ask for SQL Server first. It is second. |
| MySQL and SQL Server | Second and third, in the order users ask | Same interface. | MySQL treats schema and database as one; SQL Server adds its own type names and quoting. Budget a week or two each, mostly tests. |
| **R2RML as the canonical mapping representation** | **Adopt** (ADR-013) | A W3C Recommendation since 2012; RDF, so it is stored and exchanged like everything else here; read by Ontop and other processors. Covers logical tables (a table, a view or a query), subject maps with templates and classes, predicate-object maps with columns, constants, datatypes and languages, and joins to another triples map. | No construct for a condition (it is written as a query), none for value transformation beyond SQL, and relational sources only. |
| RML | Not now | Generalises R2RML to files; would let tabular import and database mapping share one exchange format. | A second, younger family of specifications. Revisit with FR-M7-8. |
| W3C Direct Mapping, or bootstrapping a mapping from the schema | **As an offered draft only** | A fast start: a table becomes a class, a column a property. | It is exactly the one-to-one assumption this product must not make silently. Offered, shown, edited, never applied by itself. |
| **A small preview evaluator of our own** | **Adopt** for preview only | Sub-second answers on fifty rows, with a reason for every row that produced nothing. Small: one logical table, one template, value conversion. | A second implementation of mapping semantics (AR-12). Held to the W3C R2RML test cases for the constructs it supports. |
| **Ontop** as the virtual-graph engine and the materialiser | **Adopt at stage DI-4** (ADR-016) | Open source under Apache 2.0, actively released (5.5.0 in February 2026). Reads R2RML. Supports RDFS and OWL 2 QL ontologies and most of SPARQL 1.1. Its command line can start a SPARQL endpoint, materialise a graph, convert mappings to R2RML and bootstrap a mapping. One engine for virtual and materialised answers means one semantics to explain. | One relational source per instance; several sources need a federation layer in front. Reasoning is OWL 2 QL, not OWL 2 DL. A commercial distribution built on it reports recursive property paths and `SERVICE` as unsupported; to be confirmed for the open-source release in the spike. |
| Ontop **as a separate process**, not as a library | **Adopt** | Ontop's own guide recommends its HTTP endpoint over its Java API, because the API brings many dependencies and constrains the Java version. It also keeps a crash or a memory spike out of the main application. | A second JVM to start, watch and stop. Accepted: ADR-003 already allows a separate process where isolation requires it. |
| RMLMapper as the materialiser | Fallback | A Java processor that executes R2RML; its authors report full coverage of the R2RML test cases. | A second engine beside Ontop; used only if the spike finds Ontop's materialiser unsuitable. |
| Writing a SPARQL-to-SQL translator | Rejected | — | Years of research went into the existing ones. |
| A commercial virtual-graph product | Rejected | Mature. | Licence cost and a second server product; against the constraints in §2. |

### 12.7 Semantic correctness

A database schema and an ontology say different kinds of thing, and the workbench must not
blur them.

**Constraints are not axioms.** A constraint says what the database *will refuse to store*. An
axiom says what *is true of the world* and licenses inferences. Under OWL's open-world reading,
a missing value is unknown, not absent.

| In the database | What it guarantees | What it does not entail in OWL | What the workbench may propose, for the user to accept |
| --- | --- | --- | --- |
| `NOT NULL` column | Every stored row has a value. | An existential restriction. `C SubClassOf p some D` is a claim about the domain, with inferential consequences, and a nullable column licenses nothing about a maximum. | A SHACL `sh:minCount 1` on the shape for the class: a constraint for a constraint. An OWL restriction only if the user asks for one. |
| Primary key | Rows are identified by it. | A key axiom. | The IRI template. `owl:hasKey` only on request. |
| `UNIQUE` | No two rows share the value. | An inverse-functional property. For a column of literals OWL 2 DL has no inverse-functional data property at all; the counterpart is `owl:hasKey`, which applies to named individuals only. | `owl:hasKey`, flagged with what it means for reasoning. |
| Foreign key | A value refers to an existing row elsewhere. | An object property with that domain and range. In OWL, domain and range *infer* types; they do not restrict use. | An object-property mapping between the two class maps. A domain or range only on request, with the consequence stated. |
| Column type | The stored representation. | The range of a property. | A datatype conversion in the mapping; a `sh:datatype` in a shape. |
| Table | A set of rows. | A class. A join table is a relationship; one table may hold several classes, told apart by a column; one class may span tables. | Nothing by default. A draft mapping when asked (§12.6). |
| `NULL` | No value stored. | — | No triple. This is what R2RML specifies, and the preview says so per row. |

**Rule (ADR-017).** The application creates no OWL axiom from a physical constraint on its own.
Constraint-derived statements are offered as *proposals*, by default as SHACL shapes (where a
closed-world check is what is meant), and become part of the ontology only as an explicit,
undoable change with its origin recorded.

**Open and closed worlds, at the point of use.**

- A SPARQL query over a virtual graph is evaluated against the data that is there: "films with
  no director" (`FILTER NOT EXISTS`) lists films with no director *row*. That is a statement
  about the database, not an OWL entailment that those films have no director.
- A virtual graph applies the OWL 2 QL part of the ontology (subclass and subproperty
  hierarchies, domains, ranges, inverses, and existentials on the right-hand side). Everything
  else in the ontology is not used. The result header says which reasoning was applied, as
  reasoner results do today (§7.2).
- A consistency check by HermiT says nothing about the database unless data has been
  materialised and included, and at that point size decides whether it finishes (AR-02).

### 12.8 Scalability

| Concern | Design |
| --- | --- |
| Large schemas (10,000 tables, 200,000 columns) | Discovery is a job, per chosen schema, never a blocking request. Results are stored as a snapshot and browsed from the metadata store, a page at a time, with search on the server. The browser's tree draws a branch at a time, as the Structure Explorer does. |
| Repeated discovery | A snapshot is reused until refreshed. A refresh computes fingerprints first and re-reads only schemas whose fingerprint changed, where the dialect allows it cheaply. |
| Many data sources | A pool per source with a small maximum (a handful of connections), created on first use and closed when idle. No connection is held between requests. |
| Preview | One statement, a row limit, a time limit. Never more than the limit crosses to the browser. |
| Mapping validation | Static checks (against the snapshot and the ontology) run without a connection and can run in the page. Checks that need data are jobs with the same limits as preview. |
| Materialisation | A job that streams rows to the triple store's loader; size and duration are shown before it starts (an estimated row count from the database's statistics). |
| Virtual queries | Time limit, result cap and paging enforced by the virtual graph module, not left to the engine. Performance is the source database's: the trace shows the SQL so that a missing index can be found. |
| Several databases in one query | Not in the first four stages. One virtual graph per source. Later: a relational federation layer in front of the engine, which is the approach Ontop's documentation describes. |

What does not scale and is not promised: complete OWL 2 DL reasoning over materialised
relational data of ordinary enterprise size, and interactive speed on a source database with no
suitable indexes.

### 12.9 Security

This capability adds the product's first secrets and its first outbound connections. The
measures below are requirements of stage DI-1, not later hardening.

| Concern | Measure |
| --- | --- |
| **Credentials never in the browser** | The connection form posts a secret once over HTTPS (or to `127.0.0.1` for the companion). No API answers with one. Nothing secret is written to `localStorage`, IndexedDB, the model file, an R2RML export, a log or an error message. The connection form allows paste and password managers. |
| **Secrets at rest** | In order of preference: a reference to a secret the environment provides (an environment variable, a mounted file, a secret manager); kept in the backend's memory for the session only; stored encrypted with a key that is not in the database. Never in clear text. See [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §10.6. |
| **No raw connection strings** | A connection is defined by structured fields (dialect, host, port, database, TLS mode, account). The backend builds the JDBC URL and allows only a fixed list of driver properties. Driver URLs accept properties that load classes or read local files; a URL taken from a client is an attack vector. |
| **Read-only, enforced three ways** | The account should have read rights only, and the product says so and tests what it can. Every connection is opened read-only and every statement runs in a read-only transaction. Statements are generated by the application; where a user writes SQL (a query as a logical table, stage DI-3) it must parse as a single `SELECT`. |
| **Bounded work** | Statement time limit, row limit, pool size per source, concurrent jobs per source. A mapping cannot make the product a load generator against a production database (AR-16). |
| **Where the backend may connect** | In the Server profile, hosts are restricted to an allow-list set by an administrator, and only an administrator defines a data source: otherwise the product is a way to probe a private network. |
| **Transport** | TLS to the database, verifying the server's certificate, as the default. |
| **Who may see rows** | Permission per data source, separate from permission on the ontology project. Sample and preview data is shown, never cached in browser storage. Columns marked sensitive in governance metadata can be masked in samples. |
| **The OBDA engine** | Listens on the loopback interface only; receives its database credentials from the backend at start through its environment or a file with restricted permissions, removed on stop; is reachable only through the API, which applies permissions and limits. |
| **Audit** | Who defined or changed a data source, who ran which query or materialisation, with duration and row counts. Never the rows. |

### 12.10 The recommended minimum viable implementation

The smallest thing that is useful and that every later stage builds on, without rework:

| In | Out, for now |
| --- | --- |
| PostgreSQL only. | MySQL, SQL Server. |
| The companion profile, one user, one data source per project. | Accounts, roles on data sources, several sources. |
| A password entered when connecting and held in the backend's memory, or a reference to an environment variable. | Stored secrets. |
| Discovery of chosen schemas into a snapshot with a fingerprint; refresh on request. | Automatic change detection. |
| Schema Explorer: tree, search, table detail with keys, list of related tables; a bounded row sample. | The relationship diagram (useful, not necessary). |
| Mapping: a class to a table or a view, with an optional condition built from column, operator and value; a data property to a column with a datatype; an object property to a foreign key; IRI templates. | SQL queries as logical tables, SQL expressions, value transformations. |
| Preview of fifty rows as triples, with a reason per skipped row. | Materialisation. Virtual graphs. |
| Mapping checks in the Validation view. | Checks that need to scan data. |
| Export as R2RML. | R2RML import (it needs the read-only display of constructs without an editor). |
| The mapping saved with the project and versioned with it. | Independent mapping revisions and lineage. |

This is stages DI-1 and DI-2 with the R2RML export of DI-3 brought forward, because an export
is cheap and is what makes the first release interoperable.

### 12.11 Decisions

| Id | Decision | Why | Revisit if |
| --- | --- | --- | --- |
| **ADR-013** | R2RML is the canonical representation of a mapping. What the workbench cannot edit is kept and shown, not dropped. | A standard that the engines read; the same lossless principle as for OWL (NFR-1). | Non-relational sources become a requirement (then RML). |
| **ADR-014** | External databases are reached only from the backend, through JDBC, with structured connection definitions. Credentials never reach the browser. | The only safe form; §12.9. | — |
| **ADR-015** | PostgreSQL is the first and, at first, the only dialect; others are added behind one adapter interface. | Shared infrastructure with the Server profile; an interface shaped by one real case. | The first users are overwhelmingly on another database. |
| **ADR-016** | Ontop is the engine for virtual graphs and for materialisation, run as a separate process behind the API, adopted at stage DI-4 after a spike. | Maintained, open, standards-based; its own documentation advises the endpoint over the library; isolation. | The spike fails on a target database or on required SPARQL features. |
| **ADR-017** | No OWL axiom is generated from a database constraint without explicit confirmation. Proposals default to SHACL shapes. | §12.7. | — |
| **ADR-018** | Access to external databases is read-only. Writing back is a separate future capability with its own design for transactions, authorisation and integrity. | Risk out of proportion to the first four stages. | A concrete write-back use case is specified. |
| **ADR-019** | One mapping core (IRI templates, column-to-property rules, value conversion, preview with reasons) serves both tabular file import and database mapping. | They are the same problem with different lifecycles; building it once in Phase 2 saves building it twice. | — |

## 13. Sources for external facts

Statements about this application are from its source and its own benchmarks, as cited. Version
and requirement facts about third-party software were checked on 2026-10-13 against:

- Apache Jena: Java 17 required from Jena 5; Java 21 announced as the minimum for Jena 6.
  [Jena download page source](https://apache.googlesource.com/jena-site/+/refs/heads/main/source/download/__index.md),
  [Jena change log](https://apache.googlesource.com/jena/+/refs/heads/main/CHANGES.txt).
- Spring Boot 4: at least Java 17.
  [System requirements](https://docs.spring.io/spring-boot/4.0/system-requirements.html).
- ELK 0.6.0: support for OWL API 5.
  [ELK releases](https://github.com/liveontologies/elk-reasoner/releases).
- HermiT: Maven build 1.4.5.519, dated 2020.
  [Maven Central](https://central.sonatype.com/artifact/net.sourceforge.owlapi/org.semanticweb.hermit).
- What `robot.jar` contains (OWL API 4.5.29, HermiT, ELK, JFact, Whelk, Jena 3.17.0 with TDB1,
  no TDB2): read from the file in `reasoner/lib/`.

- Ontop: version 5.5.0 (February 2026), Apache 2.0, R2RML and OWL 2 QL support, the roles of
  its command line, the recommendation of the HTTP endpoint over the Java API, and federation
  of several sources through a federation tool.
  [Ontop guide](https://ontop-vkg.org/guide/),
  [getting started](https://ontop.inf.unibz.it/guide/getting-started.html),
  [endpoint tutorial](https://ontop-vkg.org/tutorial/endpoint/endpoint-cli.html),
  [federation tutorial](https://ontop-vkg.org/tutorial/federation),
  [tutorial paper, 2021](https://www.inf.unibz.it/~calvanese/papers/calv-etal-Patterns-2021.pdf).
  SPARQL features reported unsupported by a commercial distribution:
  [Ontopic Suite documentation](https://docs.ontopic.ai/suite/consume/sparql.html).
- R2RML: W3C Recommendation of 27 September 2012.
  [R2RML](https://www.w3.org/TR/r2rml/).
- RMLMapper and the R2RML test cases:
  [paper, 2024](https://ceur-ws.org/Vol-3718/paper10.pdf).

Not verified here and stated from general knowledge: the complexity classes of the OWL 2
profiles, ELK's published classification times, the capacity of TDB2, Ontop's minimum Java
version and its list of supported databases (PostgreSQL, MySQL and SQL Server are assumed; the
DI-4 spike confirms them). The roadmap measures
the last two before relying on them (the acceptance criteria of Phases 3 and 4).
