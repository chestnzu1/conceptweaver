# The ConceptWeaver companion

The Java semantic backend of Phase 3. Task 3.1 (done 2026-10-20) chose the versions the companion
is built with: Spring Boot 4.1.1, OWL API 5.5.1, HermiT 1.4.5.519, ELK 0.6.0 and owlexplanation
5.0.1 on JDK 21. Task 3.2 (done 2026-10-20) ported the single-file service's endpoints —
`/health`, `/reason`, `/convert` and `/compare` — with the same requests, responses and statuses,
and passed the frontend's own suites against it unchanged. Task 3.3 (done 2026-10-21) added
reasoning as jobs: start, status, cancel and result over HTTP, one bounded executor, a wall-clock
limit per job, and answers cached by content and reasoner. Task 3.4 (done 2026-10-21) added
ontology sessions: an ontology uploaded once and held by content hash, with the Structure
Explorer's and the Entities page's questions answered from it over the OWL API, and the
frontend's own `http.test.ts` suites passing against it.

`CompanionApplication` is that application. `reasoner/run.mjs` starts it in place of the
single-file service when `CONCEPTWEAVER_COMPANION_JAR` names the built jar; without that variable
the app still starts `reasoner/ReasonerService.java`, so nothing changes for a user who has not
built the companion.

## Versions

| Component | Version | Why |
| --- | --- | --- |
| JDK | 21 | ADR-011. Spring Boot 4 requires 17 or later; Jena 6 is announced with 21 as its minimum. |
| Spring Boot | 4.1.1 | The current stable major line when the spike ran. |
| OWL API | 5.5.1 | Chosen by the spike; the current line, with every reasoner build below made for it. |
| HermiT | 1.4.5.519 | The OWL API 5 build of the reasoner the service uses. |
| ELK | 0.6.0 | OWL 2 EL. Compiled against OWL API 5.1.20 and running against 5.5.1 here. |
| owlexplanation | 5.0.1 | The OWL API 5 build; gives the justifications `/reason` offers. |

The POM also has an `owlapi4` profile, which is the line inside `reasoner/lib/robot.jar` today:
OWL API 4.5.29, HermiT 1.4.5.456 and owlexplanation 2.0.0. It keeps the comparison runnable and
builds the jar the frontend's parity suites run against, since they assert that line's versions;
the chosen target remains OWL API 5.

## The decision: OWL API 5.5.1

The roadmap's fallback was to stay on 4.5 if OWL API 5 with the needed reasoners was not clean.
It was clean: the same tests pass on JDK 21 with Spring Boot 4.1.1 under both profiles — the
spike's 10, plus the HTTP parity tests of 3.2 and the jobs tests of 3.3, 29 in all.

```
$ ./mvnw test
Tests run: 32, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
$ ./mvnw -Powlapi4 test
Tests run: 32, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

OWL API 5 is chosen because it is the current line and the whole set is built for it. On the 4
line, HermiT 1.4.5.456 and owlexplanation 2.0.0 work, but ELK 0.6.0 is compiled against OWL API
5 and owlexplanation 2.0.0 against 4.1.3; the combination is older than any of its parts.
`runsTheDeclaredOwlApiLine` checks the version of every declared component actually loaded, not
just the ones written in the POM, and `SpringBootSpikeTest` checks that `/health` reports the
same OWL API and ELK versions.

ELK's transitive OWL API dependencies are excluded, so each profile has exactly one OWL API on
its classpath. Without the exclusion, ELK 0.6.0 would put OWL API 5.1.20 behind the distribution
jar and either line could answer.

## Parity with the single-file service (3.2)

The same endpoints, the same fields in every answer, the same statuses and the same messages:
`/health`, `/reason`, `/convert` and `/compare`. `/compare` is beyond the three endpoints 3.2
names because `src/model/owlSyntaxes.test.ts` calls it, as do the corpus and conformance suites.
`/reason`, `/convert` and `/compare` check `Origin` before the method, read at most 64 MB, answer
JSON with `Cache-Control: no-store`, and never fetch an import. `/health` has no origin check, as
in the single-file service; it adds `"jobs": true`, which the single-file service does not say,
and the parity tests compare the fields they need rather than the whole answer.

The tests that prove it are the frontend's own, run unchanged against the jar:

```sh
./mvnw -Powlapi4 clean package
export JAVA_HOME=/path/to/jdk-21
export CONCEPTWEAVER_COMPANION_JAR=$PWD/target/companion-0.1.0-SNAPSHOT.jar
cd ..
pnpm exec vitest run src/model/dlReasoning.test.ts src/model/owlSyntaxes.test.ts
```

The two browser suites need the preview server and are started the same way:

```sh
pnpm build && pnpm exec vite preview --port 5181   # in one terminal
CONCEPTWEAVER_COMPANION_JAR=... JAVA_HOME=... node e2e/dl-reasoning.mjs
CONCEPTWEAVER_COMPANION_JAR=... JAVA_HOME=... node e2e/open-owl.mjs
```

The profile is `owlapi4` on purpose: the suites assert the versions inside `robot.jar` — OWL API
4.5.29, HermiT 1.4.5.456, ELK 0.6.0 — and the browser checks read those versions off the page.
The default `owlapi5` build answers the same, reporting HermiT 1.4.5.519 and OWL API 5.5.1; the
version strings are what differs, not the behaviour.

ELK's logging is turned off in `application.properties`. ELK logs what it left out while it
reasons, and each such call also records that the monitor has said its piece, so a later ask with
the same monitor stays silent. The single-file service had no SLF4J binding, which made those
calls no-ops; Spring Boot has one, so `org.semanticweb.elk` is set to `OFF`, and `/reason` asks
the monitors itself, once, as the single-file service did.

## Reasoning as jobs (3.3)

`POST /reasoning/start` takes `{ontologyId, revisionId, engine: "dl", ontology, imports?,
timeoutMs?, explanations?, reasoner?}` and answers with a job at once:
`{job, ontologyId, revisionId, engine, state, phase}`. `state` is `queued`, `running`, `done`,
`failed` or `cancelled`; `phase` says what the job is doing ("Reading the ontology…", "Checking
the ontology's profile…", "Reasoning with HermiT…", "Working out justifications…"). `POST
/reasoning/status` and `/reasoning/cancel` take `{job}` and answer with the job; `POST
/reasoning/result` takes `{job}` and waits for `{ontologyId, revisionId, engine, report}`, the
same report `/reason` gives. A refusal is `{code, message}` with the status
`src/reasoning/http.ts` expects: `invalid` 400, `not-found` 404, `cancelled` 409, `failed` 422,
`busy` 429, `unsupported` 501. The page's client is `src/reasoning/http.ts`; the editor is not
wired to it until 3.4 and 3.7.

- **One executor.** Jobs and `/reason` share a bounded `ThreadPoolExecutor`: one worker and four
  places in the queue by default. Work beyond that is refused (`busy`) rather than loaded into
  the same heap (TD-14). Cancel returns within two seconds, interrupts the reasoner, and leaves
  no result.
- **Limits.** `conceptweaver.reasoning.timeout-ms` (60 s) is the default and
  `max-timeout-ms` (600 s) the most a request may ask for. Every report says `limits.timeoutMs`
  and `limits.maxHeapMb`, and so does `/reason`; the Validation card shows them. The heap is set
  where the service is started: `reasoner/run.mjs --memory=<size>` passes `-Xmx<size>` to either
  service, 2 GB unless given.
- **Cache.** An answer is kept under the SHA-256 of the ontology, imports, explanations, timeout
  and reasoner, 16 least-recently-used first (`conceptweaver.reasoning.cache`). A second start
  of the same content answers `done` with `cached: true` and runs nothing. Failed, cancelled and
  timed-out jobs are not kept.
- **Settings.** `conceptweaver.reasoning.workers`, `.queue`, `.timeout-ms`, `.max-timeout-ms`
  and `.cache`, in `application.properties` or on the command line.
  `spring.mvc.async.request-timeout` is raised so that `/reasoning/result` may wait as long as a
  job may run.
- **No revisions yet.** The companion holds no ontology of its own for reasoning: a start
  carries the ontology and its imports, and accepts any non-empty `revisionId`. The sessions of
  3.4 are the structure and entity services' own holding, and reasoning over a session runs
  through the same cache.

`ReasoningJobsTest` covers the bookkeeping without a reasoner — one content answered once and
kept, cancel within two seconds leaving no result, the timeout, `busy`, phases, a failed report
being a failed job that is not kept, and the refusals. `ReasoningJobsHttpTest` covers the four
questions over HTTP, the refusals' statuses and codes, the POST-only and origin rules, and
`health.jobs`. `src/reasoning/http.test.ts` runs the local reasoning service and the same
service behind the HTTP client side by side and compares their answers and refusals.

## Ontology sessions (3.4)

`POST /sessions` takes `{document, imports?}` — the ontology in Turtle, and the imports it
declares — and answers `{ontologyId, revisionId}`: the ontology's IRI, and the SHA-256 of the
content, so the same content uploaded again is the same session and another document of the same
ontology is another revision of it. Eight sessions are held, the least recently asked of going
first (`conceptweaver.sessions.cache`); holding is bounded on purpose — these are the bridge to
Phase 4, not a store. A refusal is `{message}` with 400 for a request that is not JSON with a
`document`, 413 over the 64 MB limit, and 422 for a document that could not be read.

`POST /structure/{question}` and `POST /entities/{question}` answer from a held session, each
question a JSON query naming the session's reference, question for question, status for status
and message for message as the page's own services answer (`src/structure/http.ts` and
`src/entities/http.ts`): the structure service's 13 questions and the entity service's three,
with `{code, message}` refusals — `stale-revision` 409 for a session that is not held or a
revision that is not the held one, `not-found` 404, `invalid` 400, `unsupported` 501. What the
answer is: the hierarchy walks, the comparison, the analysis and the entity records are Java
ports of `src/structure/graph.ts`, `propertyGraph.ts`, `compare.ts`, `analyze.ts` and the record
reading of `src/entities/local.ts`, kept behaviour for behaviour; the asserted hierarchy is read
from the document as the app reads it (labels and their language, prefixes, externals, drawn
restrictions), and the inferred hierarchy is built from the same `/reason` report the page
reads, so the two sides agree on what the reasoner entails. An entity in an answer is a key the
service chooses — here the entity's IRI.

`SessionsHttpTest` covers the upload and the refusals' statuses and shapes; the parity check is
the frontend's own, run against the jar:

```sh
./mvnw clean package
export JAVA_HOME=/path/to/jdk-21
export CONCEPTWEAVER_COMPANION_JAR=$PWD/target/companion-0.1.0-SNAPSHOT.jar
cd ..
pnpm exec vitest run src/structure/http.test.ts src/entities/http.test.ts
```

Each suite uploads its fixture document, asks every question of the local service over the same
document and of the companion, and compares the answers: the session's reference and the entity
keys are each side's own, and everything else is alike.

## What the tests reproduce

`DependencySpikeTest` covers, through the declared dependencies only:

- loading Turtle and classifying it with HermiT: consistency, unsatisfiable classes, inferred
  superclasses and the classes of an individual;
- finding an ontology inconsistent;
- explaining an entailment with the justification generator `/reason` uses;
- checking the OWL 2 DL and OWL 2 EL profiles and choosing ELK for an ontology in EL;
- classifying with ELK and reading the incompleteness monitor that marks an answer partial;
- writing and rereading all five syntaxes `/convert` writes (Turtle, RDF/XML, OWL/XML,
  Functional, Manchester) without losing an axiom;
- comparing two documents by axiom, as `/compare` does;
- reporting a missing import without fetching it.

`SpringBootSpikeTest` starts the application on a random port and checks the `/health` answer:
service name, engine, the declared OWL API version, both reasoners and the five syntaxes.

`ParityHttpTest` starts the application with a named origin and covers the statuses and shapes
the frontend suites do not reach: 405 and 400 with the reasoning answer shape, the 403 that
comes before the method, the preflight and CORS headers on an allowed and a refused origin,
`/convert`'s 400, 422 and 200, and `/compare`'s 400, 422 and 405. The frontend's four suites are
the parity check; these tests are for what they leave out.

## Building and running

JDK 21 is required. Maven does not need to be installed: the wrapper downloads Maven 3.9.16 on
first use.

```sh
./mvnw test                     # OWL API 5.5.1, the chosen line
./mvnw -Powlapi4 test           # the OWL API 4.5.29 comparison
./mvnw spring-boot:run          # then: curl http://127.0.0.1:5190/health
./mvnw -Powlapi4 clean package  # target/companion-0.1.0-SNAPSHOT.jar
```

The application listens on 127.0.0.1:5190 by default, as the single-file service does. It takes
the same launch arguments: `--port=`, `--host=` and repeated `--allow-origin=`.
`reasoner/run.mjs` passes them through when it starts the jar in place of the single file, and
turns `--memory=<size>` into the JVM's `-Xmx<size>` for either service (`2g` unless given). From
the repository root, after the jar is built:

```sh
CONCEPTWEAVER_COMPANION_JAR=companion/target/companion-0.1.0-SNAPSHOT.jar pnpm reasoner
```

`JAVA_HOME` must point at a JDK 21; a `java` on the path is not enough when several JDKs are
installed.

## MCP (planned, roadmap 5.8a)

The read-only MCP server of roadmap 5.8a belongs here, in this deployable: a protocol adapter over
the services the companion answers, not a second backend. It is not built yet. When it is:

- it is disabled by default, bound to loopback, guarded by a bearer token generated per start and
  by `Host` and `Origin` checks, with an allow-list of projects;
- its catalog is fixed in code and read-only: over the sessions of 3.4, a project summary,
  entity search, an entity's details and the class and property hierarchies, all bounded and
  paged;
- it has no tool that edits an ontology or an LDM, applies a mapping or deletes a project, and no
  access to an AI provider or key;
- it calls the same `StructureService` and `EntityQueryService` the frontend uses; a tool whose
  service is absent from this build is absent from the catalog.

The design is in [SYSTEM_ARCHITECTURE.md](../docs/SYSTEM_ARCHITECTURE.md) §3.4, the catalog in
§4.5, the boundary in §9.1, and the decision in ADR-028. The production stage (5.8b) waits for
accounts, `GraphService` on the server and LM-5.

## Not here yet

- Change sets (3.5), difference and export (3.6).
- The assistant forwarding endpoints of the single-file service (`/ai/forward`, `/ai/key` and
  `/ai/key/forget`); `/health` reports `forwardsAi` and `holdsAiKeys` as false, and
  `reasoner/run.mjs` ignores `--allow-local-ai` when it starts the companion.
- The read-only MCP adapter (5.8a), which is now eligible: the sessions of 3.4 answer every
  service its tools need.
- Packaging as the default and a frontend that detects it (3.7). Until then `pnpm reasoner`
  starts the single-file service of `reasoner/` unless `CONCEPTWEAVER_COMPANION_JAR` is set.
- Jena TDB2 and SHACL: Phase 4 and SH-4. AR-03 remains open for the Jena half of the alignment.
- Persistence of any kind; the application holds nothing between requests.
