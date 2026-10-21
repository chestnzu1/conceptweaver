package org.conceptweaver.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
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
 * The HTTP behaviour of change sets (roadmap task 3.5) that the conformance suite does not reach:
 * the statuses and answer shapes of the service itself. What is applied and what is refused, in
 * the page's own words, is compared with the page by src/editing/conformance.test.ts.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class EditingHttpTest {

  private static final String TURTLE =
      "@prefix : <http://example.org/o#> .\n"
      + "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
      + "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
      + "<http://example.org/o> a owl:Ontology ; rdfs:label \"O\" .\n"
      + ":A a owl:Class ; rdfs:label \"A\" .\n"
      + ":B a owl:Class ; rdfs:label \"B\" .\n";

  private static final HttpClient HTTP = HttpClient.newHttpClient();

  @Value("${local.server.port}")
  int port;

  private HttpResponse<String> send(String method, String path, String body, String origin) throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
    if (body != null) request.header("Content-Type", "application/json");
    if (origin != null) request.header("Origin", origin);
    request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
    return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }

  private static JsonObject json(HttpResponse<String> response) {
    return JsonParser.parseString(response.body()).getAsJsonObject();
  }

  /** The reference of an uploaded ontology, for a change set to be made against. */
  private JsonObject upload() throws Exception {
    return json(send("POST", "/sessions", "{\"document\":\"" + TURTLE.replace("\n", "\\n").replace("\"", "\\\"") + "\"}", null));
  }

  private JsonObject changeSet(String ontologyId, String revisionId, String changes) {
    return JsonParser.parseString("{\"ontologyId\":\"" + ontologyId + "\",\"baseRevision\":\"" + revisionId + "\",\"changes\":" + changes + ",\"summary\":\"From the test.\"}").getAsJsonObject();
  }

  private HttpResponse<String> apply(JsonObject body) throws Exception {
    return send("POST", "/editing/apply", body.toString(), null);
  }

  @Test
  void aChangeSetIsAppliedToAHeldOntologyWholeAndHeldAsANewRevision() throws Exception {
    JsonObject ref = upload();
    String changes = "[{\"op\":\"add\",\"axiom\":{\"type\":\"SubClassOf\",\"sub\":{\"type\":\"Class\",\"iri\":\"http://example.org/o#A\"},\"sup\":{\"type\":\"Class\",\"iri\":\"http://example.org/o#B\"}}}]";
    HttpResponse<String> response = apply(changeSet(ref.get("ontologyId").getAsString(), ref.get("revisionId").getAsString(), changes));
    assertEquals(200, response.statusCode());
    JsonObject applied = json(response);
    assertEquals(ref.get("ontologyId").getAsString(), applied.get("ontologyId").getAsString());
    assertNotEquals(ref.get("revisionId").getAsString(), applied.get("revisionId").getAsString());
    assertEquals(0, applied.getAsJsonArray("notes").size());
    assertTrue(applied.get("document").getAsString().contains("rdfs:subClassOf"));
    // The result is held: the same change set against it is stated already.
    HttpResponse<String> again = apply(changeSet(ref.get("ontologyId").getAsString(), applied.get("revisionId").getAsString(), changes));
    assertEquals(409, again.statusCode());
    assertEquals("refused", json(again).get("code").getAsString());
    assertEquals("invalid", json(again).getAsJsonArray("refusals").get(0).getAsJsonObject().get("code").getAsString());
  }

  @Test
  void theServiceSaysWhatItDoesNotAnswerAndWhichQuestionsItDoesNotHave() throws Exception {
    JsonObject ref = upload();
    String refJson = "{\"ontologyId\":\"" + ref.get("ontologyId").getAsString() + "\",\"revisionId\":\"" + ref.get("revisionId").getAsString() + "\"}";
    // A question the service does not know is said so in the questions' own shape.
    HttpResponse<String> unknown = send("POST", "/editing/delete", refJson, null);
    assertEquals(404, unknown.statusCode());
    assertEquals("not-found", json(unknown).get("code").getAsString());
    assertEquals("There is no question “delete”.", json(unknown).get("message").getAsString());
    // What the service does not answer yet is said so with the status the client maps.
    HttpResponse<String> entity = send("POST", "/editing/entity", refJson, null);
    assertEquals(501, entity.statusCode());
    assertEquals("unsupported", json(entity).get("code").getAsString());
    // A revision the ontology has moved on from is its own status.
    HttpResponse<String> stale = apply(changeSet(ref.get("ontologyId").getAsString(), "r0", "[]"));
    assertEquals(409, stale.statusCode());
    assertEquals("stale-revision", json(stale).get("code").getAsString());
    assertEquals("The ontology has moved on from revision r0.", json(stale).get("message").getAsString());
  }

  @Test
  void aChangeSetHeldToTheEditorsRulesIsRefusedWithItsRefusals() throws Exception {
    JsonObject ref = upload();
    String self = "[{\"op\":\"add\",\"axiom\":{\"type\":\"SubClassOf\",\"sub\":{\"type\":\"Class\",\"iri\":\"http://example.org/o#A\"},\"sup\":{\"type\":\"Class\",\"iri\":\"http://example.org/o#A\"}}}]";
    HttpResponse<String> response = apply(changeSet(ref.get("ontologyId").getAsString(), ref.get("revisionId").getAsString(), self));
    assertEquals(409, response.statusCode());
    JsonObject refused = json(response);
    assertEquals("refused", refused.get("code").getAsString());
    assertEquals("“A” cannot be its own superclass.", refused.get("message").getAsString());
    JsonArray refusals = refused.getAsJsonArray("refusals");
    assertEquals(1, refusals.size());
    assertEquals("refused", refusals.get(0).getAsJsonObject().get("code").getAsString());
    assertEquals("“A” cannot be its own superclass.", refusals.get(0).getAsJsonObject().get("message").getAsString());
    // A change set the result would not come back as asked for is refused in the page's words.
    String bare = "[{\"op\":\"add\",\"axiom\":{\"type\":\"Declaration\",\"entity\":\"Class\",\"iri\":\"http://example.org/o#NewClass\"}}]";
    HttpResponse<String> unsupported = apply(changeSet(ref.get("ontologyId").getAsString(), ref.get("revisionId").getAsString(), bare));
    assertEquals(409, unsupported.statusCode());
    assertEquals("refused", json(unsupported).get("code").getAsString());
    assertEquals("unsupported", json(unsupported).getAsJsonArray("refusals").get(0).getAsJsonObject().get("code").getAsString());
    assertEquals("The editor would not hold the result as it was asked for: 0 statement(s) would be lost and 1 added, such as <http://example.org/o#NewClass> <http://www.w3.org/2000/01/rdf-schema#label> \"New Class\" .", json(unsupported).getAsJsonArray("refusals").get(0).getAsJsonObject().get("message").getAsString());
  }

  @Test
  void theServiceSaysWhoMayUseItAndHowItIsAsked() throws Exception {
    JsonObject ref = upload();
    JsonObject body = changeSet(ref.get("ontologyId").getAsString(), ref.get("revisionId").getAsString(), "[]");
    // A page from elsewhere is refused before anything else is looked at.
    HttpResponse<String> foreign = send("POST", "/editing/apply", body.toString(), "http://evil.example");
    assertEquals(403, foreign.statusCode());
    assertEquals("This page is not allowed to use the edit service. Start the service with --allow-origin=<the page's origin>.", json(foreign).get("message").getAsString());
    // The question is POSTed, and the body is the JSON of a change set.
    HttpResponse<String> get = send("GET", "/editing/apply", null, null);
    assertEquals(405, get.statusCode());
    assertEquals("POST a question to /editing/{question}.", json(get).get("message").getAsString());
    HttpResponse<String> notJson = send("POST", "/editing/apply", "not json", null);
    assertEquals(400, notJson.statusCode());
    assertEquals("The request is not JSON with the \"ontologyId\" and the revision of the ontology to edit.", json(notJson).get("message").getAsString());
    HttpResponse<String> unnamed = send("POST", "/editing/apply", "{\"changes\":[]}", null);
    assertEquals(400, unnamed.statusCode());
    assertEquals("The request is not JSON with the \"ontologyId\" and the revision of the ontology to edit.", json(unnamed).get("message").getAsString());
  }
}
