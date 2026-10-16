# Executive Summary

ConceptWeaver: assessment and blueprint, as of 2026-10-13 (commit `ce6419e`). Extended the same
day with ontology-to-relational data integration (§3 and §8 below).

## Long-term vision

A platform for **semantic modelling, ontology management and ontology-to-relational data
integration**: one tool in which an ontology is drawn and reasoned over, maintained and
governed over time, and connected to the relational databases where the data is, so that the
data can be asked for in the ontology's terms. Conceptual model, physical schema and the
mapping between them stay three separate, visible things.

## The documents

| Document | Answers |
| --- | --- |
| [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) | What the product is for, who uses it, what each of 16 modules must do (M14 to M16 are data integration), and twelve user journeys. |
| [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | How it is built today, the target architecture, API boundaries, technology choices, scalability, security, decisions. Section 12 is data integration. |
| [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) | What is stored where: triple store, relational store, browser; versioning; consistency. Section 10 is connections, credentials, schema snapshots and mappings. |
| [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) | Five phases with tasks, dependencies, risks and acceptance criteria; the five data-integration stages placed within them; the next task. |
| [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) | 18 confirmed debt items and 16 architectural risks, with files, severity and remediation. |

## 1. Current product maturity

**A capable single-user ontology editor that runs entirely in the browser; not yet a platform.**

What is there is broader and better tested than its age suggests: about 50,000 lines of
TypeScript, 603 unit tests, and 21 browser scripts, one of them a UI audit.

| Area | State |
| --- | --- |
| Visual modelling, entity editing, IRIs and namespaces | **Strong.** The diagram is the editor, and every line is checked against OWL rules as it is drawn. |
| Structure exploration, entity search | **Strong, and already built for a backend.** Handles 200,000 classes through a service interface. |
| Reasoning | **Good.** A rule reasoner in the page and HermiT through a local service, with unusually honest reporting of what a result covers. |
| SHACL, quality rules, reuse and mappings, governance metadata | **Good.** |
| Authoring of OWL class expressions | **Missing.** Imported expressions are kept as text and cannot be edited. |
| Tabular import | **Basic.** Pasted rows only. |
| Versioning, change history | **Missing.** |
| Collaboration, server storage | **Missing.** |
| AI assistance | **Partial**: an assistant with the user's own key, answering from the ontology through read-only lookups and proposing changes applied only on acceptance (2026-10-16). |
| Connecting to relational databases, mapping, querying data through the ontology | **Missing.** Nothing exists; governance metadata has free-text database, schema, table and column fields. Useful parts to build from do exist (§8). |

Three items in the brief's feature list are less complete than their names suggest: *OWL RL
reasoning* is a subset of the rules; *spreadsheet mapping* is a header convention on pasted
text; and export covers Turtle and JSON-LD but **not RDF/XML**, which the application reads but
does not write.

## 2. Major architectural weaknesses

1. **The data model is a drawing, not a set of axioms** (TD-01). OWL is produced from terms,
   lines and positions on export and squeezed back in on import. What does not fit is dropped:
   property chains, keys, annotations on axioms and more. The user is told, but the content is
   gone. This is the main thing between the product and professional use.
2. **Identity is inconsistent** (TD-03, TD-18). Classes have internal ids, service interfaces
   use IRIs, and object properties are identified by their lower-cased name.
3. **The whole ontology must be in the page** (TD-05, TD-10). Most views read the in-memory
   model directly and the canvas draws every term. The comfortable limit is about 2,000 terms,
   while the two views written against a service interface are two orders of magnitude beyond
   that.
4. **Long work runs on the main thread** (TD-08, TD-09). Reasoning takes 570 ms at 2,600
   classes and runs after every edit.
5. **There is no history** (TD-12): a 100-step undo in memory, and nothing else.
6. **There is no continuous integration** (TD-15). The safety net exists but is run by hand.

None of these requires a rewrite. All have an incremental remedy.

## 3. Recommended long-term architecture

**Keep the browser application and its no-server mode. Put every ontology operation behind a
service interface. Add one Java application that implements those interfaces.**

- **Frontend.** The existing React and TypeScript application, unchanged in technology. Views
  ask services instead of reading the model. This pattern already exists for two subsystems and
  is extended to the rest.
- **Backend.** One Spring Boot application, grown from the present single-file reasoner
  service. The OWL API is the canonical model on the server. HermiT for complete OWL 2 DL
  reasoning and ELK for large OWL 2 EL ontologies, chosen by profile, run as bounded,
  cancellable jobs. ELK is already inside the library the current service downloads.
- **Storage.** Apache Jena TDB2, embedded, for ontologies as named graphs, with asserted and
  inferred statements always in separate graphs. PostgreSQL for application metadata only, and
  only once there is a shared server. IndexedDB remains for local projects and offline work.
- **Not adopted.** Microservices, a message broker, a separate triple-store server, a graph
  rendering library, a Python runtime. Each was weighed and deferred or rejected as cost
  without need for one developer.
- **Three ways to run one codebase.** Browser only; browser with a local companion; server.
- **Data integration, as modules of the same backend.** Relational databases are reached only
  from the backend through JDBC, read-only, with credentials that never reach the browser.
  PostgreSQL first. Mappings are kept as standard R2RML. Virtual knowledge graphs are provided
  by Ontop, an existing open-source engine, run as a separate process behind the API and
  adopted last; it is not rebuilt.

## 4. Highest-priority improvements

In order. The first five are the MVP path.

| # | Improvement | Why |
| --- | --- | --- |
| 1 | **Continuous integration and performance baselines** | Makes every later change safe. Days of work. |
| 2 | **Stable identity and no data loss**: IRIs for every entity, ids for object properties, unmapped statements preserved | Stops losing content on a round trip, before any new editor is written. |
| 3 | **A change-set contract and service interfaces for editing, reasoning and validation; long work moved to workers** | The hinge of the migration, and the end of frozen pages. |
| 4 | **Structured class expressions with a Manchester-syntax editor** | The largest authoring gap against Protégé. |
| 5 | **Versions with differences; tabular import with mapping; export in every OWL syntax; canvas culling** | What turns a capable editor into a tool for maintained ontologies. |
| 6 | The Java backend, then the triple store | Scale beyond the browser, and persistent history. |
| 7 | Collaboration, publishing, assistance | The platform. |
| 8 | **Data integration**, in five stages from the backend onwards: schema explorer, mapping workbench, R2RML and schema-change detection, virtual knowledge graph, enterprise integration | The third pillar. It starts where the backend does and asks only two small things of the earlier phases. |

## 5. Recommended MVP

**"Trust it with a real ontology"**: one user, in the browser, optionally with the local
companion.

- Open and save any OWL 2 ontology with nothing lost.
- Author class expressions and defined classes.
- Reason and validate without the page freezing; ELK or HermiT chosen automatically.
- Work with 10,000 classes.
- Save versions and see what changed.
- Import a spreadsheet with a column mapping.
- Export RDF/XML and the other OWL syntaxes.

Deliberately excluded: accounts, sharing, server storage, review, publishing, AI.

**A second MVP, for data integration**, after the backend exists: **"map one database, and
trust the mapping"**. One PostgreSQL database, read-only, through the local companion; its
schema browsed beside the ontology; classes, properties and keys mapped in a three-area editor;
the result previewed on real rows and checked in the Validation view; exported as R2RML. No
other dialects, no hand-written SQL, no stored passwords, no virtual graph yet.

## 6. Suggested next development milestone

**MS-1, the safety net** ([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §10): one command
and one pipeline that run every existing check, a linter, and recorded baselines for the
benchmarks and for main-thread stalls. It changes no behaviour and takes days.

It is followed directly by **MS-2, nothing lost**: a round-trip test over a corpus of public
ontologies, stable identity for every entity, and preservation of statements the editor does
not understand.

## 7. Data integration in brief

**How it fits.** As four more modules of the one Java application (data sources, schema,
mapping, virtual graph) and three more service interfaces in the frontend, following the
pattern already used. It is the first capability with no browser-only form: a browser cannot
open a database connection and must not hold a credential.

**Schema mapping, materialisation and virtual graphs are three things.** A mapping is a
description of which rows become which statements. Materialising runs it and stores a copy as
RDF. A virtual graph stores nothing and answers each SPARQL query by rewriting it to SQL
against the live database. The mapping is the asset; the other two are ways of using it.

**What is reused.** Entity lists and search, the hierarchy service and its paged tree, the
layouts, the validation results model, SHACL over imported data, datatype and IRI handling, the
suggestion model of the alignment workbench, the SPARQL and triples views, and the mapping core
planned for spreadsheet import.

**What is new.** Database connections and secret handling; schema snapshots with fingerprints;
a mapping model with R2RML reading and writing; a preview evaluator; the Schema Explorer and
the Mapping Workbench; and, last, the management of an OBDA engine.

**Semantic correctness.** A `NOT NULL`, a `UNIQUE` or a foreign key is a rule about what a
database will store, not a statement about the world. The product creates no OWL axiom from one
without explicit confirmation, and proposes SHACL shapes by default. An answer from a virtual
graph says which reasoning was applied (the OWL 2 QL part of the ontology) and is not presented
as an open-world entailment.

**Security and scale.** Structured connection fields, never a raw connection string;
credentials write-only and preferably not stored; every statement read-only, time-limited and
row-limited; rows never in browser storage. Schema discovery is a background job into a
snapshot that is browsed a page at a time; previews are fifty rows; virtual queries are capped
and their SQL is shown.

## 8. Decisions needed from the product owner

| Decision | Default assumed in these documents |
| --- | --- |
| Open source, source-available or commercial? | Undecided. No dependency with restrictive terms is proposed. |
| First audience: ontology engineers or taxonomists? | Ontology engineers, because lossless OWL is the harder credibility gap. |
| Will a hosted service be operated, or only software to self-host? | Self-hosted. |
| How large are the first users' ontologies? | 10,000 classes as the browser target. |
| Which database do the first data-integration users have? | PostgreSQL first and alone; SQL Server and MySQL after. |
| Is a governed, exportable mapping or live querying the first goal of data integration? | The mapping first; the virtual graph at the fourth stage. |
| Does data integration come before collaboration? | Its first three stages are placed in Phases 3 and 4; the fourth and collaboration are ordered by demand. |
