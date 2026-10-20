# The ConceptWeaver companion

The Java semantic backend of Phase 3. Task 3.1 (done 2026-10-20) chose the versions the companion
is built with: Spring Boot 4.1.1, OWL API 5.5.1, HermiT 1.4.5.519, ELK 0.6.0 and owlexplanation
5.0.1 on JDK 21. Task 3.2 (done 2026-10-20) ported the single-file service's endpoints —
`/health`, `/reason`, `/convert` and `/compare` — with the same requests, responses and statuses,
and passed the frontend's own suites against it unchanged.

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
spike's 10, and 16 since 3.2's HTTP parity tests joined them.

```
$ ./mvnw test
Tests run: 16, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
$ ./mvnw -Powlapi4 test
Tests run: 16, Failures: 0, Errors: 0, Skipped: 0
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
in the single-file service.

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
`reasoner/run.mjs` passes them through when it starts the jar in place of the single file. From
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
- its catalog is fixed in code and read-only: after 3.4, a project summary, entity search, an
  entity's details and the class and property hierarchies, all bounded and paged;
- it has no tool that edits an ontology or an LDM, applies a mapping or deletes a project, and no
  access to an AI provider or key;
- it calls the same `StructureService` and `EntityQueryService` the frontend uses; a tool whose
  service is absent from this build is absent from the catalog.

The design is in [SYSTEM_ARCHITECTURE.md](../docs/SYSTEM_ARCHITECTURE.md) §3.4, the catalog in
§4.5, the boundary in §9.1, and the decision in ADR-028. The production stage (5.8b) waits for
accounts, `GraphService` on the server and LM-5.

## Not here yet

- Reasoning jobs (3.3), ontology sessions (3.4), change sets (3.5), difference and export (3.6).
- The assistant forwarding endpoints of the single-file service (`/ai/forward`, `/ai/key` and
  `/ai/key/forget`); `/health` reports `forwardsAi` and `holdsAiKeys` as false, and
  `reasoner/run.mjs` ignores `--allow-local-ai` when it starts the companion.
- The read-only MCP adapter (5.8a), which waits for 3.4's services.
- Packaging as the default and a frontend that detects it (3.7). Until then `pnpm reasoner`
  starts the single-file service of `reasoner/` unless `CONCEPTWEAVER_COMPANION_JAR` is set.
- Jena TDB2 and SHACL: Phase 4 and SH-4. AR-03 remains open for the Jena half of the alignment.
- Persistence of any kind; the application holds nothing between requests.
