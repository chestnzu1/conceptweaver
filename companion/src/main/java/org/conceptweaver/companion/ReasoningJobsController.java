package org.conceptweaver.companion;

import com.google.gson.JsonObject;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The job API of roadmap task 3.3: POST /reasoning/start, /status, /cancel and /result, each one
 * JSON question and one JSON answer (src/reasoning/http.ts). A start is the whole question,
 * ontology and imports included; the others name a job. A refusal is a code and a message, with
 * the status the page knows it by; /result waits for the answer, and the request thread is held
 * for it rather than the job being stopped when the page goes away.
 */
@RestController
final class ReasoningJobsController {

  private static final Set<String> QUESTIONS = Set.of("start", "status", "cancel", "result");

  private final OriginPolicy origins;
  private final ReasoningJobs jobs;

  ReasoningJobsController(OriginPolicy origins, ReasoningJobs jobs) {
    this.origins = origins;
    this.jobs = jobs;
  }

  @RequestMapping("/reasoning/{question}")
  CompletableFuture<ResponseEntity<String>> ask(@PathVariable("question") String question, HttpServletRequest request) throws IOException {
    String origin = request.getHeader("Origin");
    if (!origins.allowed(origin)) {
      return done(HttpSupport.respond(403, Json.message("This page is not allowed to use the reasoning service. Start the service with --allow-origin=<the page's origin>.")));
    }
    if (!"POST".equals(request.getMethod())) {
      return done(HttpSupport.respond(405, Json.message("POST a question to /reasoning/{start|status|cancel|result}.")));
    }
    if (!QUESTIONS.contains(question)) {
      return done(HttpSupport.respond(404, Json.message("There is no question \"" + question + "\".")));
    }
    byte[] sent = HttpSupport.body(request);
    if (sent == null) {
      return done(HttpSupport.respond(413, Json.message("The request is larger than the service accepts (64 MB).")));
    }
    JsonObject json = HttpSupport.parse(sent);
    if (json == null) {
      return done(HttpSupport.respond(400, new Refusal("invalid", "The request is not a JSON object.").body()));
    }
    try {
      return switch (question) {
        case "start" -> done(HttpSupport.respond(200, jobs.start(json)));
        case "status" -> done(HttpSupport.respond(200, jobs.status(jobOf(json))));
        case "cancel" -> done(HttpSupport.respond(200, jobs.cancel(jobOf(json))));
        default -> jobs.result(jobOf(json)).handle((answer, e) -> {
          if (e == null) return HttpSupport.respond(200, answer);
          Throwable cause = ReasoningJobs.cause(e);
          if (cause instanceof Refusal r) return HttpSupport.respond(r.status(), r.body());
          return HttpSupport.respond(500, Json.message("The reasoning service failed: " + cause));
        });
      };
    } catch (Refusal r) {
      return done(HttpSupport.respond(r.status(), r.body()));
    }
  }

  /** The job a question is about. A question that names none is not a question. */
  private static String jobOf(JsonObject json) {
    if (!json.has("job") || !json.get("job").isJsonPrimitive() || !json.getAsJsonPrimitive("job").isString()) {
      throw new Refusal("invalid", "The request is not JSON with a \"job\".");
    }
    return json.get("job").getAsString();
  }

  private static CompletableFuture<ResponseEntity<String>> done(ResponseEntity<String> answer) {
    return CompletableFuture.completedFuture(answer);
  }
}
