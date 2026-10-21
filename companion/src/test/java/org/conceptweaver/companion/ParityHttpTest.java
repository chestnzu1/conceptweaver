package org.conceptweaver.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * The HTTP behaviour the four suites named in roadmap task 3.2 do not reach: the statuses and
 * answer shapes for a request that is not what an endpoint takes, the preflight, a named origin,
 * and the document endpoints' 422. The suites themselves are run unchanged against this service;
 * these tests cover what they leave out.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "conceptweaver.allow-origins=https://allowed.example")
class ParityHttpTest {

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
    if (body != null) request.header("Content-Type", "text/plain");
    request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
    return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }

  private static JsonObject json(HttpResponse<String> response) {
    return JsonParser.parseString(response.body()).getAsJsonObject();
  }

  @Test
  void healthSaysWhatThisServiceDoes() throws Exception {
    JsonObject health = json(send("GET", "/health", null, null));
    assertEquals("conceptweaver-reasoner", health.get("service").getAsString());
    assertEquals(1, health.get("protocol").getAsInt());
    assertTrue(health.get("converts").getAsBoolean());
    assertTrue(health.get("compares").getAsBoolean());
    assertTrue(health.get("jobs").getAsBoolean());
    // This build has no assistant endpoint, so it says it forwards nothing and holds no key.
    assertFalse(health.get("forwardsAi").getAsBoolean());
    assertFalse(health.get("holdsAiKeys").getAsBoolean());
    assertEquals(Versions.HERMIT, health.get("engineVersion").getAsString());
    assertEquals(Versions.OWLAPI, health.get("owlapi").getAsString());
  }

  @Test
  void reasonRefusesWhatItDoesNotTakeWithTheReasoningAnswerShape() throws Exception {
    HttpResponse<String> get = send("GET", "/reason", null, null);
    assertEquals(405, get.statusCode());
    assertEquals("POST an ontology to /reason.", json(get).getAsJsonArray("errors").get(0).getAsString());

    HttpResponse<String> empty = send("POST", "/reason", "{}", null);
    assertEquals(400, empty.statusCode());
    assertEquals("The request is not JSON with an \"ontology\" in Turtle.", json(empty).getAsJsonArray("errors").get(0).getAsString());

    HttpResponse<String> notJson = send("POST", "/reason", "nonsense", null);
    assertEquals(400, notJson.statusCode());
    assertTrue(json(notJson).get("status").getAsString().equals("failed"));
    assertEquals("unknown", json(notJson).get("consistency").getAsString());
  }

  @Test
  void aPageThatIsNotAllowedIsRefusedBeforeAnythingElse() throws Exception {
    // The origin is judged before the method: even a GET from an unlisted page is a 403.
    HttpResponse<String> refused = send("GET", "/reason", null, "https://elsewhere.example");
    assertEquals(403, refused.statusCode());
    assertNull(refused.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
    assertTrue(json(refused).getAsJsonArray("errors").get(0).getAsString().contains("--allow-origin"));

    HttpResponse<String> named = send("POST", "/reason", "{\"ontology\": " + Json.GSON.toJson(TURTLE) + "}", "https://allowed.example");
    assertEquals(200, named.statusCode());
    assertEquals("https://allowed.example", named.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
    assertEquals("complete", json(named).get("status").getAsString());
  }

  @Test
  void reasonSaysTheTimeAndHeapTheAnswerWasWorkedUnder() throws Exception {
    JsonObject report = json(send("POST", "/reason", "{\"ontology\": " + Json.GSON.toJson(TURTLE) + "}", null));
    JsonObject limits = report.getAsJsonObject("limits");
    assertEquals(60_000, limits.get("timeoutMs").getAsInt());
    assertTrue(limits.get("maxHeapMb").getAsInt() > 0);
  }

  @Test
  void aPreflightIsAnsweredWithTheHeadersTheRequestNeeds() throws Exception {
    HttpResponse<String> allowed = send("OPTIONS", "/convert", null, "https://allowed.example");
    assertEquals(204, allowed.statusCode());
    assertEquals("https://allowed.example", allowed.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
    assertEquals("GET, POST, OPTIONS", allowed.headers().firstValue("Access-Control-Allow-Methods").orElse(null));
    assertEquals("Content-Type", allowed.headers().firstValue("Access-Control-Allow-Headers").orElse(null));

    HttpResponse<String> refused = send("OPTIONS", "/convert", null, "https://elsewhere.example");
    assertEquals(403, refused.statusCode());
    assertNull(refused.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
  }

  @Test
  void convertAnswersWithTheDocumentOrWithWhyItIsNotOne() throws Exception {
    HttpResponse<String> missing = send("POST", "/convert", "{\"to\": \"owlxml\"}", null);
    assertEquals(400, missing.statusCode());
    assertEquals("The request is not JSON with the \"document\" to read.", json(missing).getAsJsonArray("errors").get(0).getAsString());

    HttpResponse<String> notWritten = send("POST", "/convert", Json.GSON.toJson(java.util.Map.of("document", TURTLE, "to", "n3")), null);
    assertEquals(422, notWritten.statusCode());
    assertTrue(json(notWritten).getAsJsonArray("errors").get(0).getAsString().contains("does not write \"n3\""));

    JsonObject functional = json(send("POST", "/convert", Json.GSON.toJson(java.util.Map.of("document", TURTLE, "to", "functional")), null));
    assertEquals("functional", functional.get("to").getAsString());
    assertTrue(functional.get("document").getAsString().contains("Ontology("));
    assertTrue(!functional.has("turtle"), "only a Turtle answer carries the turtle field");    assertEquals(3, functional.get("axioms").getAsInt());

    JsonObject asTurtle = json(send("POST", "/convert", Json.GSON.toJson(java.util.Map.of("document", TURTLE)), null));
    assertEquals("turtle", asTurtle.get("to").getAsString());
    assertTrue(asTurtle.get("turtle").getAsString().contains("owl:Class"));
  }

  @Test
  void compareSaysWhatOneDocumentHasAndTheOtherDoesNot() throws Exception {
    HttpResponse<String> missing = send("POST", "/compare", "{\"original\": \"\"}", null);
    assertEquals(400, missing.statusCode());
    assertEquals("The request is not JSON with the \"original\" and the \"exported\" document.", json(missing).getAsJsonArray("errors").get(0).getAsString());

    HttpResponse<String> same = send("POST", "/compare", Json.GSON.toJson(java.util.Map.of("original", TURTLE, "exported", TURTLE)), null);
    assertEquals(200, same.statusCode(), same.body());
    JsonObject compared = json(same);
    assertEquals(0, compared.getAsJsonArray("removed").size());
    assertEquals(0, compared.getAsJsonArray("added").size());
    assertEquals(3, compared.getAsJsonObject("original").get("axioms").getAsInt());

    HttpResponse<String> unreadable = send("POST", "/compare", Json.GSON.toJson(java.util.Map.of("original", "not an ontology", "exported", TURTLE)), null);
    assertEquals(422, unreadable.statusCode());
    assertTrue(json(unreadable).getAsJsonArray("errors").get(0).getAsString().startsWith("The original: "));

    HttpResponse<String> wrongMethod = send("GET", "/compare", null, null);
    assertEquals(405, wrongMethod.statusCode());
    assertEquals("POST two documents to /compare.", json(wrongMethod).getAsJsonArray("errors").get(0).getAsString());
  }
}
