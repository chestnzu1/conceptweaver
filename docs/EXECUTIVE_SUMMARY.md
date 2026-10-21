# Executive Summary

ConceptWeaver: assessment and blueprint, first written 2026-10-13 (commit `ce6419e`); brought
up to date and realigned on 2026-10-17 (commit `22f39d4`) with ontology-driven logical data
modelling as the product's objective. Ontology-to-relational data integration, added on
2026-10-13, is deferred (§8).

## Long-term vision

A platform for **semantic modelling, ontology management and ontology-driven logical data
modelling**: one tool in which an ontology is drawn and reasoned over, maintained and governed
over time, and used as the semantic foundation from which the relational logical data models of
applications are designed:

> OWL ontology → semantic-to-logical transformation → editable logical data model → semantic
> traceability and change impact analysis

Ontology, constraint model (SHACL shape sets) and logical data models stay three separate,
visible artifacts, related by mappings and never generated from one another by themselves.
Physical data models, DDL and database deployment are out of scope.

## The documents

| Document | Answers |
| --- | --- |
| [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) | What the product is for, who uses it, what each of 18 modules must do (M17 and M18 are logical data modelling; M14 to M16, data integration, are deferred), and fifteen user journeys. |
| [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | How it is built today, the target architecture, API boundaries, technology choices, scalability, security, decisions. Section 13 is logical data modelling; section 12, data integration, is deferred. |
| [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) | What is stored where: triple store, relational store, browser; versioning; consistency. Section 11 is logical data models and their mappings; section 10 is deferred. |
| [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) | Five phases with tasks, dependencies, risks and acceptance criteria; the logical data modelling track LM-1 to LM-5 and the SHACL track placed within them; the next task; the deferred track (§11). |
| [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) | 20 confirmed debt items and 21 architectural risks (six of them dormant with the deferred track), with files, severity and remediation. |

## 1. Current product maturity

**A capable single-user ontology editor that runs entirely in the browser, at its MVP, with
logical data models that are authored, derived from the ontology and traced back to it; not yet a
platform.**

About 73,000 lines of TypeScript, 990 unit tests, and 40 browser scripts, one of them a UI audit,
all run by one command (`pnpm verify`) and in CI.

| Area | State, 2026-10-17 |
| --- | --- |
| Visual modelling, entity editing, IRIs and namespaces | **Strong.** The diagram is the editor, and every line is checked against OWL rules as it is drawn. Every entity has a stable IRI. Annotation properties are entities of their own, and names, definitions and notes may be in several languages, with a display language for the names shown across the interface. |
| OWL authoring and fidelity | **Good.** Class expressions are authored in Manchester syntax with completion; what the editor has no form for is kept and written back; a corpus of nine public ontologies round-trips with nothing lost. |
| Structure exploration, entity search | **Strong, and already built for a backend.** Handles 200,000 classes through a service interface. |
| Reasoning | **Good.** A rule reasoner in a worker; HermiT and ELK through a local service, chosen by the ontology's profile; honest reporting of what a result covers. |
| SHACL | **Strong.** Shape sets edited in a view of their own, every SHACL 1.0 Core construct, held to the W3C Core test suite; shapes proposed from the ontology and reviewed one by one. |
| Versions and differences | **Good, locally.** Named versions in the browser, compared axiom by axiom and told entity by entity. No server history yet. |
| Import and export | **Good.** CSV, TSV and Excel through a mapping screen; every OWL syntax written. |
| AI assistance | **Partial.** An assistant with the user's own key, answering from the ontology through read-only lookups and proposing changes applied only on acceptance. |
| Collaboration, server storage | **Missing.** |
| Logical data modelling | **Good, in the browser.** Logical models are authored by hand in a workspace of their own, with an ER diagram and findings in the Validation view (LM-1, LM-2), derived from the ontology through reviewed proposals applied as one change set (LM-3), and traced to it: mappings with status, coverage and traces both ways, impact reports and reviewed synchronization (LM-4), all 2026-10-17. Element types — entity, reference entity and domain — are first-class, changed only through a reviewed structural preview that takes the mappings with them (2026-10-20; FR-M17-18, FR-M18-16). Server-side LDMs are missing (LM-5). |
| Connecting to relational databases | **Missing, and deferred.** |

## 2. Major architectural weaknesses

The six weaknesses found on 2026-10-13 have all been addressed by Phase 1 and the start of Phase
2 (identity, lossless round trip, change sets, workers, CI, versions; see TECHNICAL_DEBT.md for
what each left). What remains:

1. **Much is still in the page** (TD-05, TD-10 in part). Views not yet behind services read the
   model directly; the browser's limits are raised, not removed, until Phase 4.
2. **No server history or collaboration** (TD-12 in part): versions are kept in one browser.
3. ~~**The history and the revisions know one artifact** (TD-19, TD-20).~~ Done with roadmap
   stages LM-1 and LM-2 (2026-10-17): a step names the artifacts it changed, every field of the
   model is said to be the ontology's or another artifact's, and an LDM edit leaves the ontology's
   revision as it was. LDMs are now authored in a workspace of their own, with an ER diagram and
   with their findings in the Validation view.

None requires a rewrite.

## 3. Recommended long-term architecture

**Keep the browser application and its no-server mode. Put every operation behind a service
interface. Add one Java application that implements those interfaces.**

- **Frontend.** The existing React and TypeScript application, unchanged in technology. Views
  ask services instead of reading the model.
- **Backend.** One Spring Boot application, grown from the present single-file service. The OWL
  API is the canonical model on the server. HermiT and ELK, chosen by profile, as bounded,
  cancellable jobs.
- **Storage.** Apache Jena TDB2, embedded, for ontologies as named graphs; PostgreSQL for
  application metadata and for logical data models and their revisions, once there is a shared
  server; IndexedDB for local projects and offline work.
- **Logical data models, as an artifact of their own.** A typed metamodel (entities, attributes,
  logical types and domains, relationships with cardinality and optionality, keys,
  specializations, business rules), its own change sets and revisions, an editor with an ER
  diagram; transformation from the ontology as reviewed proposals; explicit semantic mappings
  with stale detection and impact reports. In the page first; on the server in Phase 4.
- **Not adopted.** Microservices, a message broker, a separate triple-store server, a graph or
  diagramming library, a Python runtime, a physical data model.
- **Three ways to run one codebase.** Browser only; browser with a local companion; server.

## 4. Highest-priority improvements

The first five, the MVP path, are done (2026-10-16). In order from here:

| # | Improvement | Why |
| --- | --- | --- |
| 1 | ~~ELK in the companion, with the reasoner chosen by profile (task 2.6)~~ | Done 2026-10-17. |
| 2 | ~~Logical data model metamodel and services (LM-1), with revisions per artifact~~ | Done 2026-10-17. |
| 3 | ~~The LDM editor and its ER diagram (LM-2)~~ | Done 2026-10-17. |
| 4 | ~~Ontology-to-LDM transformation (LM-3)~~ | Done 2026-10-17: logical models proposed from the ontology, constraints decided by the designer. |
| 5 | ~~Semantic traceability and change impact (LM-4)~~ | Done 2026-10-17: every element traced, every ontology change reported per model. |
| 6 | ~~Annotation properties as entities, with labels in several languages and a display language (task 2.7)~~ | Done 2026-10-17. |
| 7 | ~~Further axioms: property chains, keys, disjoint unions, negative assertions and annotations on axioms (task 2.8)~~ | Done 2026-10-17. |
| 8 | ~~Imports, structure and the remaining service interfaces (tasks 2.9 to 2.11)~~ | Done 2026-10-18. |
| 9 | ~~Update mode for import, several diagrams, custom SPARQL quality rules (task 2.12); element types in the LDM Entities workspace (task 2.13)~~ | Done 2026-10-20; Phase 2 complete. |
| 10 | The Java backend and the triple store, with LDMs on the server (LM-5) | Scale beyond the browser, and persistent history. |
| 11 | Collaboration, publishing, assistance with LDM tools, integration (a public API and a read-only MCP server) | The platform. |

## 5. MVPs

**"Trust it with a real ontology"** (reached 2026-10-16): lossless OWL 2, class expressions,
reasoning and validation without a frozen page, 10,000 classes, versions with differences,
spreadsheet import, every OWL syntax exported.

**"Design a logical model from the ontology, and trust the link"** (reached 2026-10-17, LM-1 to
LM-4), in the browser: logical data models as an artifact of their own, edited in a workspace and
on an ER diagram; proposed from a chosen part of the ontology with no constraint imposed; every
element traced to its axioms; every ontology change reported per model and synchronized only by
reviewed proposals.
Excluded: physical models and DDL, several diagrams per model, formal rule expressions, LDM
assistance, server-side LDMs.

## 6. Suggested next development milestone

**MS-15, traceable and impact-aware**, is reached (2026-10-17) with LM-4. Phase 2 is complete
(task 2.13 done 2026-10-20), and task 3.1, the companion's dependency spike, is done too:
Spring Boot 4.1.1 with OWL API 5.5.1, HermiT 1.4.5.519 and ELK 0.6.0 on JDK 21 passes the same
tests as the OWL API 4.5.29 line. Task 3.2, parity of the OWL service in Spring Boot, is done as
well (2026-10-20): the four frontend suites named for it pass unchanged against the companion.
Task 3.3, reasoning jobs, is done too (2026-10-21): the companion starts, follows, cancels and
answers jobs through one bounded executor, caching each answer by content and reasoner. Task
3.4, ontology sessions, is done the same day: an ontology is uploaded once and held by content
hash, the Structure Explorer's and the Entities page's questions are answered from it over the
OWL API, and the frontend's own `http.test.ts` suites pass against the companion. The next
milestone is **MS-5, the companion**, which replaces
the single-file service, and the next task is 3.5, change sets on the server. MS-16, server-side logical
models through LM-5, follows in Phase 4. MS-17, the
read-only MCP server, is scheduled in Phase 5: its local stage (5.8a) can follow 3.4, which is
done, and its production stage (5.8b) follows 5.8a, 5.1, 4.4 and LM-5
([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §10).

## 7. Logical data modelling in brief

**Three artifacts.** The ontology says what is true of the domain, under the open world; shape
sets say what RDF data an application accepts; a logical data model says how an application
organises its data, under the closed world of a store. They are related by mappings, many to
many, never one-to-one by assumption.

**Transformation as proposals.** From a chosen scope of the ontology and a configuration
(naming, datatypes, strategies for hierarchies and object properties), the product proposes
entities, attributes, relationships and specializations, each with the axioms it came from and
its rationale. Restrictions, domains, ranges, keys and shapes are offered only as *candidate*
constraints, never chosen to begin with: `Film SubClassOf directedBy some Director` says every
film has a director, known or not, not that a record must name one.

**Traceability and impact.** Each element made from the ontology keeps its sources (IRIs and
axioms), strategy, rationale and the ontology version it came from. An ontology change marks
mappings stale or broken and produces an impact report per logical model, with synchronization
proposals that never change what the designer customised without acceptance.

**Independence.** An LDM edit never changes the ontology or its revision, and an ontology edit
never changes an LDM. Each LDM has its own revisions; several LDMs may be derived from one
ontology, each with its own decisions.

**What is reused.** The layouts, geometry and culling of the Graph view for the ER diagram; the
validation findings model; the version difference; the proposal-review pattern of shapes
proposed from the ontology; the axiom difference for impact; the assistant, extended with LDM
tools rather than duplicated.

## 8. Data integration, deferred

Database connections, schema exploration, R2RML mapping, materialisation and virtual knowledge
graphs (stages DI-1 to DI-5, modules M14 to M16) were specified on 2026-10-13 and are deferred by
the realignment of 2026-10-17: kept with their identifiers and design as the record for a later
decision, not scheduled ([DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §11). The mapping core
built for spreadsheet import (task 2.4) was designed to serve them as well and still could.

## 9. Decisions needed from the product owner

| Decision | Default assumed in these documents |
| --- | --- |
| Open source, source-available or commercial? | Undecided. No dependency with restrictive terms is proposed. |
| First audience: ontology engineers, taxonomists, or data architects designing from an ontology? | Ontology engineers and the data architects who design from their ontologies. |
| Will a hosted service be operated, or only software to self-host? | Self-hosted. |
| How large are the first users' ontologies and logical models? | 10,000 classes; LDMs of up to 2,000 entities in the browser. |
| Which ER notation? | Information Engineering (crow's foot) only. |
| Is an exchange format with other data modelling tools needed? | The product's own documented JSON format first. |
| When, if ever, is data integration resumed? | Not scheduled. |
