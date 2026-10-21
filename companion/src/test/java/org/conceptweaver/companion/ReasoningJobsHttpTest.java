package org.conceptweaver.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * The job API of roadmap task 3.3 over HTTP: start, status, cancel and result as the page asks
 * them (src/reasoning/http.ts), the answer kept for one content, and the refusals with the code
 * and status the page knows. The reasoning itself is the parity suites' subject.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "conceptweaver.allow-origins=https://allowed.example")
class ReasoningJobsHttpTest {

  private static final String TURTLE =
      "@prefix : <http://example.org/> .\n"
      + "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
      + ":A a owl:Class .\n"
      + ":B a owl:Class ; owl:equivalentClass :A .\n";

  private static final HttpClient HTTP = HttpClient.newHttpClient();

  @Value("${local.server.port}")
  int port;

  private HttpResponse<String> send(String method, String path, String body, String origin) throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
    if (origin != null) request.header("Origin", origin);
    if (body != null) request.header("Content-Type", "application/json");
    request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
    return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }

  private static JsonObject json(HttpResponse<String> response) {
    return JsonParser.parseString(response.body()).getAsJsonObject();
  }

  private static String startBody(String engine, boolean withOntology, int timeoutMs) {
    JsonObject o = new JsonObject();
    o.addProperty("ontologyId", "working-copy");
    o.addProperty("revisionId", "r1");
    o.addProperty("engine", engine);
    if (withOntology) o.addProperty("ontology", TURTLE);
    o.addProperty("timeoutMs", timeoutMs);
    return Json.GSON.toJson(o);
  }

  private static String about(String job) {
    JsonObject o = new JsonObject();
    o.addProperty("job", job);
    return Json.GSON.toJson(o);
  }

  @Test
  void startsAJobFollowsItAndAnswersWithTheReport() throws Exception {
    HttpResponse<String> started = send("POST", "/reasoning/start", startBody("dl", true, 5_000), null);
    assertEquals(200, started.statusCode(), started.body());
    JsonObject job = json(started);
    String id = job.get("job").getAsString();
    assertEquals("dl", job.get("engine").getAsString());
    assertEquals("working-copy", job.get("ontologyId").getAsString());
    assertEquals("r1", job.get("revisionId").getAsString());
    assertTrue(Set.of("queued", "running", "done").contains(job.get("state").getAsString()));

    HttpResponse<String> status = send("POST", "/reasoning/status", about(id), null);
    assertEquals(200, status.statusCode(), status.body());
    assertEquals(id, json(status).get("job").getAsString());

    HttpResponse<String> answered = send("POST", "/reasoning/result", about(id), null);
    assertEquals(200, answered.statusCode(), answered.body());
    JsonObject answer = json(answered);
    assertEquals("working-copy", answer.get("ontologyId").getAsString());
    assertEquals("r1", answer.get("revisionId").getAsString());
    assertEquals("dl", answer.get("engine").getAsString());
    JsonObject report = answer.getAsJsonObject("report");
    assertEquals("complete", report.get("status").getAsString());
    assertEquals("consistent", report.get("consistency").getAsString());
    assertEquals(5_000, report.getAsJsonObject("limits").get("timeoutMs").getAsInt());
    assertTrue(report.getAsJsonObject("limits").get("maxHeapMb").getAsInt() > 0);
    assertEquals("done", json(send("POST", "/reasoning/status", about(id), null)).get("state").getAsString());
  }

  @Test
  void answersTheSameContentFromWhatWasKept() throws Exception {
    String first = json(send("POST", "/reasoning/start", startBody("dl", true, 5_000), null)).get("job").getAsString();
    assertEquals(200, send("POST", "/reasoning/result", about(first), null).statusCode());

    HttpResponse<String> again = send("POST", "/reasoning/start", startBody("dl", true, 5_000), null);
    assertEquals(200, again.statusCode(), again.body());
    JsonObject kept = json(again);
    assertEquals("done", kept.get("state").getAsString());
    assertTrue(kept.get("cached").getAsBoolean());
    assertEquals("", kept.get("phase").getAsString());
    assertEquals(200, send("POST", "/reasoning/result", about(kept.get("job").getAsString()), null).statusCode());
  }

  @Test
  void refusesWhatItDoesNotOfferWithACodeAndAStatus() throws Exception {
    HttpResponse<String> fast = send("POST", "/reasoning/start", startBody("fast", true, 5_000), null);
    assertEquals(501, fast.statusCode());
    assertEquals("unsupported", json(fast).get("code").getAsString());
    assertTrue(json(fast).get("message").getAsString().contains("dl"));

    HttpResponse<String> unknown = send("POST", "/reasoning/start", startBody("magic", true, 5_000), null);
    assertEquals(400, unknown.statusCode());
    assertEquals("invalid", json(unknown).get("code").getAsString());

    HttpResponse<String> noOntology = send("POST", "/reasoning/start", startBody("dl", false, 5_000), null);
    assertEquals(400, noOntology.statusCode());
    assertEquals("invalid", json(noOntology).get("code").getAsString());

    HttpResponse<String> notJson = send("POST", "/reasoning/start", "nonsense", null);
    assertEquals(400, notJson.statusCode());
    assertEquals("invalid", json(notJson).get("code").getAsString());

    HttpResponse<String> noJob = send("POST", "/reasoning/status", "{}", null);
    assertEquals(400, noJob.statusCode());
    assertEquals("invalid", json(noJob).get("code").getAsString());

    HttpResponse<String> missing = send("POST", "/reasoning/status", about("dl-never"), null);
    assertEquals(404, missing.statusCode());
    assertEquals("not-found", json(missing).get("code").getAsString());
    assertEquals(404, send("POST", "/reasoning/result", about("dl-never"), null).statusCode());
    assertEquals(404, send("POST", "/reasoning/cancel", about("dl-never"), null).statusCode());
  }

  @Test
  void answersOnlyPostFromAnAllowedPage() throws Exception {
    HttpResponse<String> get = send("GET", "/reasoning/start", null, null);
    assertEquals(405, get.statusCode());
    assertNotNull(json(get).get("message"));

    HttpResponse<String> elsewhere = send("POST", "/reasoning/start", startBody("dl", true, 5_000), "https://elsewhere.example");
    assertEquals(403, elsewhere.statusCode());
    assertTrue(json(elsewhere).get("message").getAsString().contains("--allow-origin"));

    HttpResponse<String> named = send("POST", "/reasoning/status", about("dl-never"), "https://allowed.example");
    assertEquals(404, named.statusCode());
    assertEquals("https://allowed.example", named.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
  }

  @Test
  void healthSaysItTakesJobs() throws Exception {
    assertTrue(json(send("GET", "/health", null, null)).get("jobs").getAsBoolean());
  }
}
