package org.conceptweaver.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.google.gson.JsonObject;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * The bookkeeping of reasoning jobs, without a reasoner: one job at a time with a few waiting,
 * cancel, the wall-clock limit, the answer kept for each content, and the refusals. What the work
 * itself answers is the subject of the HTTP test and of the parity suites.
 */
class ReasoningJobsTest {

  private static final String ONTOLOGY = "@prefix : <http://example.org/> . :A a :B .";
  private static final String OTHER = "@prefix : <http://example.org/> . :C a :D .";

  private static ReasoningJobs jobs(ReasoningWork work) {
    return jobs(work, 1, 2, 5_000, 4);
  }

  private static ReasoningJobs jobs(ReasoningWork work, int workers, int queue, int timeoutMs, int cache) {
    ReasoningSettings settings = new ReasoningSettings(workers, queue, timeoutMs, timeoutMs, cache);
    return new ReasoningJobs(settings, new ReasoningPool(settings), work);
  }

  private static JsonObject request(String ontology, int timeoutMs) {
    JsonObject o = new JsonObject();
    o.addProperty("ontologyId", "ontology");
    o.addProperty("revisionId", "r1");
    o.addProperty("engine", "dl");
    o.addProperty("ontology", ontology);
    o.addProperty("timeoutMs", timeoutMs);
    return o;
  }

  private static JsonObject good() {
    JsonObject o = Json.result();
    o.addProperty("status", "complete");
    o.addProperty("consistency", "consistent");
    return o;
  }

  private static String idOf(JsonObject job) {
    return job.get("job").getAsString();
  }

  private static JsonObject until(ReasoningJobs jobs, String id, String state, long ms) throws InterruptedException {
    long deadline = System.currentTimeMillis() + ms;
    JsonObject seen = jobs.status(id);
    while (!state.equals(seen.get("state").getAsString())) {
      if (System.currentTimeMillis() >= deadline) fail("The job never became " + state + ": " + seen);
      Thread.sleep(20);
      seen = jobs.status(id);
    }
    return seen;
  }

  @Test
  void answersTheSameContentOnceAndKeepsItForTheSameReasonerAndSettings() throws Exception {
    AtomicInteger ran = new AtomicInteger();
    ReasoningWork work = (request, timeoutMs, phase, running) -> {
      ran.incrementAndGet();
      phase.accept("Reasoning with HermiT…");
      return good();
    };
    ReasoningJobs jobs = jobs(work);
    JsonObject first = jobs.start(request(ONTOLOGY, 5_000));
    JsonObject answer = jobs.result(idOf(first)).get(2, TimeUnit.SECONDS);
    assertEquals("dl", answer.get("engine").getAsString());
    assertEquals("ontology", answer.get("ontologyId").getAsString());
    assertEquals("complete", answer.getAsJsonObject("report").get("status").getAsString());
    assertEquals(1, ran.get());

    JsonObject again = jobs.start(request(ONTOLOGY, 5_000));
    assertEquals("done", again.get("state").getAsString());
    assertTrue(again.get("cached").getAsBoolean());
    assertEquals("complete", jobs.result(idOf(again)).get(2, TimeUnit.SECONDS).getAsJsonObject("report").get("status").getAsString());
    assertEquals(1, ran.get(), "the same content is not worked out twice");

    JsonObject other = jobs.start(request(OTHER, 5_000));
    jobs.result(idOf(other)).get(2, TimeUnit.SECONDS);
    assertEquals(2, ran.get(), "different content is worked out again");
  }

  @Test
  void stopsAJobAtOnceAndLeavesNoResult() throws Exception {
    CountDownLatch started = new CountDownLatch(1);
    ReasoningWork work = (request, timeoutMs, phase, running) -> {
      started.countDown();
      Thread.sleep(60_000);
      return good();
    };
    ReasoningJobs jobs = jobs(work);
    String id = idOf(jobs.start(request(ONTOLOGY, 60_000)));
    assertTrue(started.await(2, TimeUnit.SECONDS));

    long t0 = System.nanoTime();
    JsonObject stopped = jobs.cancel(id);
    long took = Duration.ofNanos(System.nanoTime() - t0).toMillis();
    assertTrue(took < 2_000, "cancel took " + took + " ms");
    assertEquals("cancelled", stopped.get("state").getAsString());
    assertEquals("", stopped.get("phase").getAsString());

    ExecutionException refused = assertThrows(ExecutionException.class, () -> jobs.result(id).get(2, TimeUnit.SECONDS));
    Refusal why = assertInstanceOf(Refusal.class, ReasoningJobs.cause(refused));
    assertEquals("cancelled", why.code);
    assertEquals(409, why.status());
    assertEquals("cancelled", jobs.status(id).get("state").getAsString());
  }

  @Test
  void failsAJobThatOutlivesTheTimeItWasAllowed() throws Exception {
    ReasoningWork work = (request, timeoutMs, phase, running) -> {
      Thread.sleep(60_000);
      return good();
    };
    ReasoningJobs jobs = jobs(work, 1, 1, 1_000, 1);
    String id = idOf(jobs.start(request(ONTOLOGY, 1_000)));
    JsonObject failed = until(jobs, id, "failed", 5_000);
    assertEquals("Reasoning was stopped after 1 seconds without finishing.", failed.get("error").getAsString());

    ExecutionException refused = assertThrows(ExecutionException.class, () -> jobs.result(id).get(2, TimeUnit.SECONDS));
    Refusal why = assertInstanceOf(Refusal.class, ReasoningJobs.cause(refused));
    assertEquals("failed", why.code);
    assertEquals(422, why.status());
    assertEquals("Reasoning was stopped after 1 seconds without finishing.", why.getMessage());
  }

  @Test
  void refusesAStartWhenEveryWorkerAndPlaceInTheQueueIsTaken() throws Exception {
    CountDownLatch started = new CountDownLatch(1);
    ReasoningWork work = (request, timeoutMs, phase, running) -> {
      started.countDown();
      Thread.sleep(60_000);
      return good();
    };
    ReasoningJobs jobs = jobs(work, 1, 1, 60_000, 0);
    String first = idOf(jobs.start(request(ONTOLOGY, 60_000)));
    assertTrue(started.await(2, TimeUnit.SECONDS));
    String second = idOf(jobs.start(request(OTHER, 60_000)));
    assertEquals("queued", jobs.status(second).get("state").getAsString());

    Refusal busy = assertThrows(Refusal.class, () -> jobs.start(request("@prefix : <http://example.org/> . :E a :F .", 60_000)));
    assertEquals("busy", busy.code);
    assertEquals(429, busy.status());
    assertTrue(busy.getMessage().contains("busy"));

    jobs.cancel(first);
    jobs.cancel(second);
  }

  @Test
  void saysWhatAJobIsDoingWhileItRuns() throws Exception {
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    ReasoningWork work = (request, timeoutMs, phase, running) -> {
      phase.accept("Reasoning with ELK…");
      started.countDown();
      release.await();
      return good();
    };
    ReasoningJobs jobs = jobs(work);
    String id = idOf(jobs.start(request(ONTOLOGY, 5_000)));
    assertTrue(started.await(2, TimeUnit.SECONDS));
    assertEquals("Reasoning with ELK…", jobs.status(id).get("phase").getAsString());
    assertEquals("running", jobs.status(id).get("state").getAsString());
    release.countDown();
    assertEquals("done", until(jobs, id, "done", 2_000).get("state").getAsString());
    assertEquals("", jobs.status(id).get("phase").getAsString());
  }

  @Test
  void aReportThatSaysReasoningFailedIsAJobThatFailed() throws Exception {
    AtomicInteger ran = new AtomicInteger();
    ReasoningWork work = (request, timeoutMs, phase, running) -> {
      ran.incrementAndGet();
      return Json.failure("The ontology could not be read as OWL.");
    };
    ReasoningJobs jobs = jobs(work);
    String id = idOf(jobs.start(request(ONTOLOGY, 5_000)));
    assertEquals("failed", until(jobs, id, "failed", 2_000).get("state").getAsString());
    assertEquals("The ontology could not be read as OWL.", jobs.status(id).get("error").getAsString());

    ExecutionException refused = assertThrows(ExecutionException.class, () -> jobs.result(id).get(2, TimeUnit.SECONDS));
    assertEquals("failed", assertInstanceOf(Refusal.class, ReasoningJobs.cause(refused)).code);

    // A failure is not an answer, so it is not kept for the next start.
    jobs.start(request(ONTOLOGY, 5_000));
    Thread.sleep(200);
    assertEquals(2, ran.get());
  }

  @Test
  void refusesWhatItCannotTakeBeforeStartingAnything() {
    ReasoningJobs jobs = jobs((request, timeoutMs, phase, running) -> good());

    JsonObject fast = request(ONTOLOGY, 5_000);
    fast.addProperty("engine", "fast");
    assertEquals("unsupported", assertThrows(Refusal.class, () -> jobs.start(fast)).code);
    assertEquals(501, assertThrows(Refusal.class, () -> jobs.start(fast)).status());

    JsonObject noOntology = request(ONTOLOGY, 5_000);
    noOntology.remove("ontology");
    assertEquals("invalid", assertThrows(Refusal.class, () -> jobs.start(noOntology)).code);
    assertEquals(400, assertThrows(Refusal.class, () -> jobs.start(noOntology)).status());

    JsonObject noEngine = request(ONTOLOGY, 5_000);
    noEngine.remove("engine");
    assertEquals("invalid", assertThrows(Refusal.class, () -> jobs.start(noEngine)).code);

    JsonObject noRevision = request(ONTOLOGY, 5_000);
    noRevision.addProperty("revisionId", "");
    assertEquals("invalid", assertThrows(Refusal.class, () -> jobs.start(noRevision)).code);

    Refusal missing = assertThrows(Refusal.class, () -> jobs.status("dl-does-not-exist"));
    assertEquals("not-found", missing.code);
    assertEquals(404, missing.status());
    assertEquals("not-found", assertThrows(Refusal.class, () -> jobs.result("dl-does-not-exist")).code);
    assertEquals("not-found", assertThrows(Refusal.class, () -> jobs.cancel("dl-does-not-exist")).code);
  }
}
