package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.semanticweb.owlapi.reasoner.OWLReasoner;
import org.springframework.stereotype.Service;

/**
 * Reasoning as jobs (roadmap task 3.3): started, followed, stopped, and asked for the answer of,
 * with the same questions and answers the page's own service gives (src/reasoning/contracts.ts).
 *
 * A start answers at once with a job; the work is done by the one bounded executor
 * ({@link ReasoningPool}), so two ontologies are not classified into the same heap at once. Every
 * job has a wall-clock limit, after which it is stopped and failed; any job can be stopped, and a
 * stopped job leaves no result. One answer is kept for each ontology content and reasoner, so
 * reasoning again without an edit — a second tab, a reload — costs nothing (FR-M3-4).
 *
 * This service holds no ontology of its own: a start carries the ontology and its imports, as the
 * page's service carries its model. Ontology sessions (roadmap task 3.4) give it a store and with
 * it the revision check the page's service already makes.
 */
@Service
final class ReasoningJobs {

  /** How many finished jobs are remembered; older ones are forgotten, and their ids answer 404. */
  static final int KEPT = 64;

  private final ReasoningSettings settings;
  private final ReasoningPool pool;
  private final ReasoningWork work;
  private final ScheduledExecutorService watchdogs = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "reasoning-timeouts");
    t.setDaemon(true);
    return t;
  });
  private final Map<String, Job> jobs = new ConcurrentHashMap<>();
  private final Deque<String> finished = new ArrayDeque<>();
  private final AtomicLong made = new AtomicLong();
  /** The last answer of each content, least recently used first. Guarded by itself. */
  private final LinkedHashMap<String, JsonObject> cache;

  ReasoningJobs(ReasoningSettings settings, ReasoningPool pool, ReasoningWork work) {
    this.settings = settings;
    this.pool = pool;
    this.work = work;
    this.cache = new LinkedHashMap<>(16, 0.75f, true) {
      @Override
      protected boolean removeEldestEntry(Map.Entry<String, JsonObject> eldest) {
        return size() > settings.cache;
      }
    };
  }

  // ---------------------------------------------------------------- the questions

  /** Starts a job and answers with it at once. The timeouts and the heap are the service's. */
  JsonObject start(JsonObject request) {
    String engine = text(request, "engine");
    if ("fast".equals(engine)) {
      throw new Refusal("unsupported", "This service has no fast reasoner: it reasons over OWL 2 DL with HermiT or ELK. Ask for \"engine\": \"dl\".");
    }
    if (!"dl".equals(engine)) {
      throw new Refusal("invalid", engine == null ? "The request is not JSON with an \"engine\"." : "There is no engine \"" + engine + "\": this service reasons with \"dl\".");
    }
    String ontologyId = text(request, "ontologyId");
    String revisionId = text(request, "revisionId");
    if (ontologyId == null || ontologyId.isEmpty() || revisionId == null || revisionId.isEmpty()) {
      throw new Refusal("invalid", "The request is not JSON with an \"ontologyId\" and a \"revisionId\".");
    }
    if (!isText(request, "ontology")) throw new Refusal("invalid", "The request is not JSON with an \"ontology\" in Turtle.");
    int timeoutMs = settings.timeoutOf(Json.intOf(request, "timeoutMs", settings.timeoutMs));
    String key = contentKey(request, timeoutMs);

    String id = "dl-" + made.incrementAndGet();
    JsonObject cached = cacheGet(key);
    if (cached != null) {
      Job job = new Job(id, ontologyId, revisionId, key, timeoutMs);
      job.cached = true;
      synchronized (job) {
        job.state = "done";
        job.phase = "";
        job.answer.complete(answer(job, cached));
      }
      jobs.put(id, job);
      remember(job);
      return snapshot(job);
    }

    Job job = new Job(id, ontologyId, revisionId, key, timeoutMs);
    try {
      job.future = pool.submit((Callable<Void>) () -> {
        reason(job, request);
        return null;
      });
    } catch (RejectedExecutionException e) {
      throw new Refusal("busy", pool.busy());
    }
    jobs.put(id, job);
    return snapshot(job);
  }

  /** How a job is going. */
  JsonObject status(String id) {
    return snapshot(held(id));
  }

  /** Stops a job, if it has not finished. A finished job is left as it is. */
  JsonObject cancel(String id) {
    Job job = held(id);
    boolean ended = false;
    synchronized (job) {
      if (!terminal(job.state)) {
        job.phase = "";
        job.state = "cancelled";
        job.answer.completeExceptionally(new Refusal("cancelled", "The job was stopped."));
        ended = true;
        Future<?> f = job.future;
        if (f != null) f.cancel(true);
        OWLReasoner r = job.running.get();
        if (r != null) r.interrupt();
        Thread t = job.worker;
        if (t != null) t.interrupt();
      }
    }
    if (ended) remember(job);
    return snapshot(job);
  }

  /**
   * The answer of a job, once it has one. It may be waited for: the request is held until the job
   * finishes, or fails, or is stopped. Giving the request up does not stop the job.
   */
  CompletableFuture<JsonObject> result(String id) {
    return held(id).answer;
  }

  // ---------------------------------------------------------------- the work, and its endings

  private void reason(Job job, JsonObject request) {
    job.worker = Thread.currentThread();
    try {
      synchronized (job) {
        if (terminal(job.state)) return;
        job.state = "running";
      }
      job.watchdog = watchdogs.schedule(() -> timedOut(job), job.timeoutMs, TimeUnit.MILLISECONDS);
      JsonObject report = work.report(request, job.timeoutMs, phase -> say(job, phase), job.running);
      finished(job, report);
    } catch (Throwable e) {
      failed(job, ReasoningService.describe(e));
    } finally {
      job.worker = null;
      ScheduledFuture<?> watchdog = job.watchdog;
      if (watchdog != null) watchdog.cancel(false);
    }
  }

  private static void say(Job job, String phase) {
    synchronized (job) {
      if (!terminal(job.state)) job.phase = phase;
    }
  }

  /** The work came back with a report: the job is done, unless it is no longer wanted. */
  private void finished(Job job, JsonObject report) {
    String status = report.has("status") && report.get("status").isJsonPrimitive() ? report.get("status").getAsString() : "";
    if ("failed".equals(status)) {
      // The report says reasoning did not finish; the job did, without an answer.
      JsonArray errors = report.has("errors") && report.get("errors").isJsonArray() ? report.getAsJsonArray("errors") : new JsonArray();
      failed(job, errors.size() > 0 ? errors.get(0).getAsString() : "The reasoner did not finish.");
      return;
    }
    boolean ended = false;
    synchronized (job) {
      if (!terminal(job.state)) {
        job.phase = "";
        job.state = "done";
        job.answer.complete(answer(job, report));
        if (settings.cache > 0) cachePut(job.key, report);
        ended = true;
      }
    }
    if (ended) remember(job);
  }

  /** The work could not finish: the job says why, and answers no result. */
  private void failed(Job job, String message) {
    boolean ended = false;
    synchronized (job) {
      if (!terminal(job.state)) {
        job.phase = "";
        job.error = message;
        job.state = "failed";
        job.answer.completeExceptionally(new Refusal("failed", message));
        ended = true;
      }
    }
    if (ended) remember(job);
  }

  /** The time allowed ran out: the job is failed and the reasoner is stopped, as /reason does. */
  private void timedOut(Job job) {
    String message = "Reasoning was stopped after " + (job.timeoutMs / 1000) + " seconds without finishing.";
    boolean ended = false;
    synchronized (job) {
      if (!terminal(job.state)) {
        job.phase = "";
        job.error = message;
        job.state = "failed";
        job.answer.completeExceptionally(new Refusal("failed", message));
        ended = true;
        Future<?> f = job.future;
        if (f != null) f.cancel(true);
        OWLReasoner r = job.running.get();
        if (r != null) r.interrupt();
      }
    }
    if (ended) remember(job);
  }

  // ---------------------------------------------------------------- what a job says

  private Job held(String id) {
    Job job = jobs.get(id);
    if (job == null) throw new Refusal("not-found", "There is no job " + id + ".");
    return job;
  }

  private static boolean terminal(String state) {
    return "done".equals(state) || "failed".equals(state) || "cancelled".equals(state);
  }

  /** How many jobs are remembered: the last {@link #KEPT} finished ones. */
  private void remember(Job job) {
    synchronized (finished) {
      finished.addLast(job.id);
      while (finished.size() > KEPT) jobs.remove(finished.removeFirst());
    }
  }

  private static JsonObject snapshot(Job job) {
    String state;
    String phase;
    String error;
    synchronized (job) {
      state = job.state;
      phase = job.phase;
      error = job.error;
    }
    JsonObject o = new JsonObject();
    o.addProperty("job", job.id);
    o.addProperty("ontologyId", job.ontologyId);
    o.addProperty("revisionId", job.revisionId);
    o.addProperty("engine", "dl");
    o.addProperty("state", state);
    o.addProperty("phase", phase);
    if (error != null) o.addProperty("error", error);
    if (job.cached) o.addProperty("cached", true);
    return o;
  }

  /** What the job answers with: the revision it is of, and the report it worked out. */
  private static JsonObject answer(Job job, JsonObject report) {
    JsonObject o = new JsonObject();
    o.addProperty("ontologyId", job.ontologyId);
    o.addProperty("revisionId", job.revisionId);
    o.addProperty("engine", "dl");
    o.add("report", report);
    return o;
  }

  // ---------------------------------------------------------------- the answer kept for each content

  private JsonObject cacheGet(String key) {
    synchronized (cache) {
      return cache.get(key);
    }
  }

  private void cachePut(String key, JsonObject report) {
    synchronized (cache) {
      cache.put(key, report);
    }
  }

  /**
   * What the answer depends on: the ontology and its imports, the reasoner, the explanations asked
   * for, and the timeout it was worked out under. The revision and the job's name are not part of
   * it: the same content is the same work, whichever revision or tab asks.
   */
  private static String contentKey(JsonObject request, int timeoutMs) {
    JsonObject content = new JsonObject();
    content.add("ontology", request.get("ontology"));
    content.add("imports", request.has("imports") && request.get("imports").isJsonArray() ? request.get("imports") : new JsonArray());
    content.add("explanations", request.has("explanations") && request.get("explanations").isJsonObject() ? request.get("explanations") : new JsonObject());
    content.addProperty("timeoutMs", timeoutMs);
    content.addProperty("reasoner", textOr(request, "reasoner", "hermit"));
    return sha256(Json.GSON.toJson(content));
  }

  private static String sha256(String text) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
      StringBuilder b = new StringBuilder(64);
      for (byte x : digest) b.append(String.format("%02x", x));
      return b.toString();
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is not available.", e);
    }
  }

  // ---------------------------------------------------------------- reading the request

  private static boolean isText(JsonObject o, String key) {
    JsonElement e = o.get(key);
    return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString();
  }

  private static String text(JsonObject o, String key) {
    return isText(o, key) ? o.get(key).getAsString() : null;
  }

  private static String textOr(JsonObject o, String key, String fallback) {
    String given = text(o, key);
    return given == null ? fallback : given;
  }

  /** What a refusal was, whatever a future wrapped it in. */
  static Throwable cause(Throwable e) {
    while ((e instanceof CompletionException || e instanceof ExecutionException) && e.getCause() != null) e = e.getCause();
    return e;
  }

  /** One job, as it is followed from start to its answer. Every change is made under the job's own lock. */
  private static final class Job {
    final String id;
    final String ontologyId;
    final String revisionId;
    final String key;
    final int timeoutMs;
    final AtomicReference<OWLReasoner> running = new AtomicReference<>();
    final CompletableFuture<JsonObject> answer = new CompletableFuture<>();

    volatile String state = "queued";
    volatile String phase = "Waiting for the reasoner…";
    volatile String error;
    volatile boolean cached;
    volatile Future<?> future;
    volatile Thread worker;
    volatile ScheduledFuture<?> watchdog;

    Job(String id, String ontologyId, String revisionId, String key, int timeoutMs) {
      this.id = id;
      this.ontologyId = ontologyId;
      this.revisionId = revisionId;
      this.key = key;
      this.timeoutMs = timeoutMs;
    }
  }
}
