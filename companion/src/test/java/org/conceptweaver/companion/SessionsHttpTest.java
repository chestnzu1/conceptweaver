package org.conceptweaver.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
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
 * The HTTP behaviour of ontology sessions (roadmap task 3.4) that the frontend's suites do not
 * reach: the upload itself, the reference a session is asked by, and the statuses and answer
 * shapes of the structure and entity questions' refusals. The questions themselves are compared
 * with the page's own answers by the suites, which run unchanged against this service.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SessionsHttpTest {

  private static final String TURTLE =
      "@prefix : <http://example.org/o#> .\n"
      + "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
      + "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
      + "<http://example.org/o> a owl:Ontology .\n"
      + ":A a owl:Class ; rdfs:label \"A\" .\n"
      + ":B a owl:Class ; rdfs:label \"B\" ; rdfs:subClassOf :A .\n";

  private static final HttpClient HTTP = HttpClient.newHttpClient();

  @Value("${local.server.port}")
  int port;

  private HttpResponse<String> send(String method, String path, String body) throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
    if (body != null) request.header("Content-Type", "application/json");
    request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
    return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }

  private JsonObject ask(String path, String ontologyId, String revisionId, String extra) throws Exception {
    String body = "{\"ontologyId\":\"" + ontologyId + "\",\"revisionId\":\"" + revisionId + "\"" + (extra == null ? "" : "," + extra) + "}";
    return JsonParser.parseString(send("POST", path, body).body()).getAsJsonObject();
  }

  private static JsonObject json(HttpResponse<String> response) {
    return JsonParser.parseString(response.body()).getAsJsonObject();
  }

  @Test
  void anOntologyIsUploadedOnceAndHeldByItsContentHash() throws Exception {
    HttpResponse<String> wrong = send("GET", "/sessions", null);
    assertEquals(405, wrong.statusCode());
    assertEquals("POST an ontology to /sessions.", json(wrong).get("message").getAsString());

    HttpResponse<String> empty = send("POST", "/sessions", "{}");
    assertEquals(400, empty.statusCode());
    assertEquals("The request is not JSON with the \"document\" to hold, in Turtle.", json(empty).get("message").getAsString());

    HttpResponse<String> unreadable = send("POST", "/sessions", Json.GSON.toJson(java.util.Map.of("document", "not an ontology")));
    assertEquals(422, unreadable.statusCode());
    assertTrue(json(unreadable).get("message").getAsString().contains("could not be read"));

    HttpResponse<String> up = send("POST", "/sessions", Json.GSON.toJson(java.util.Map.of("document", TURTLE)));
    assertEquals(200, up.statusCode());
    JsonObject ref = json(up);
    assertEquals("http://example.org/o", ref.get("ontologyId").getAsString());
    assertEquals(64, ref.get("revisionId").getAsString().length());

    // The same content is the same session; other content is another revision of the same ontology.
    HttpResponse<String> again = send("POST", "/sessions", Json.GSON.toJson(java.util.Map.of("document", TURTLE)));
    assertEquals(ref, json(again));
    HttpResponse<String> other = send("POST", "/sessions", Json.GSON.toJson(java.util.Map.of("document", TURTLE + ":C a owl:Class .\n")));
    assertEquals(ref.get("ontologyId"), json(other).get("ontologyId"));
    assertNotEquals(ref.get("revisionId"), json(other).get("revisionId"));
  }

  @Test
  void theStructureAndEntityQuestionsAreAnsweredFromTheHeldOntology() throws Exception {
    JsonObject ref = json(send("POST", "/sessions", Json.GSON.toJson(java.util.Map.of("document", TURTLE))));

    JsonObject children = ask("/structure/children", ref.get("ontologyId").getAsString(), ref.get("revisionId").getAsString(), "\"mode\":\"asserted\"");
    assertEquals(1, children.get("total").getAsInt());
    assertEquals("A", children.getAsJsonArray("nodes").get(0).getAsJsonObject().getAsJsonObject("class").get("label").getAsString());

    JsonObject stale = ask("/structure/children", ref.get("ontologyId").getAsString(), "r0", "\"mode\":\"asserted\"");
    assertEquals("stale-revision", stale.get("code").getAsString());
    assertEquals("The ontology has changed since this was asked about.", stale.get("message").getAsString());

    JsonObject missing = ask("/structure/summary", ref.get("ontologyId").getAsString(), ref.get("revisionId").getAsString(), "\"mode\":\"asserted\",\"classIri\":\"http://example.org/o#Nobody\"");
    assertEquals("not-found", missing.get("code").getAsString());
    assertEquals("There is no class <http://example.org/o#Nobody> in this ontology.", missing.get("message").getAsString());

    HttpResponse<String> unknown = send("POST", "/structure/drop-everything", Json.GSON.toJson(java.util.Map.of("ontologyId", ref.get("ontologyId").getAsString(), "revisionId", ref.get("revisionId").getAsString(), "mode", "asserted")));
    assertEquals(404, unknown.statusCode());
    assertEquals("not-found", json(unknown).get("code").getAsString());
    assertEquals("There is no question “drop-everything”.", json(unknown).get("message").getAsString());

    JsonObject describe = ask("/entities/describe", ref.get("ontologyId").getAsString(), ref.get("revisionId").getAsString(), "\"kind\":\"class\"");
    assertEquals(2, describe.get("total").getAsInt());
    JsonObject badSort = ask("/entities/query", ref.get("ontologyId").getAsString(), ref.get("revisionId").getAsString(), "\"kind\":\"class\",\"sort\":{\"by\":\"colour\",\"dir\":\"asc\"}");
    assertEquals("invalid", badSort.get("code").getAsString());
    assertEquals("This kind of entity is not sorted by \"colour\".", badSort.get("message").getAsString());

    // A question without a session to name is refused before it is read.
    HttpResponse<String> malformed = send("POST", "/structure/children", "{\"mode\":\"asserted\"}");
    assertEquals(400, malformed.statusCode());
    assertTrue(json(malformed).get("message").getAsString().contains("\"ontologyId\""));
  }

  @Test
  void theHealthSaysSessionsAreHeld() throws Exception {
    JsonObject health = json(send("GET", "/health", null));
    assertTrue(health.get("sessions").getAsBoolean());
  }
}
