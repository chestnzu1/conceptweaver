package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * What this service is: the same answer the single-file service gives on /health
 * (reasoner/ReasonerService.java). It names the reasoners and document syntaxes this build has;
 * it forwards no assistant request and holds no key, so it says so.
 */
@RestController
final class HealthController {

  @GetMapping(value = "/health", produces = "application/json; charset=utf-8")
  public ResponseEntity<String> health() {
    JsonObject o = new JsonObject();
    o.addProperty("service", "conceptweaver-reasoner");
    o.addProperty("protocol", 1);
    o.addProperty("engine", "HermiT");
    o.addProperty("engineVersion", Versions.HERMIT);
    o.addProperty("owlapi", Versions.OWLAPI);
    o.addProperty("profile", "OWL 2 DL");
    // What else it does besides reasoning: turning an ontology in any OWL syntax into Turtle,
    // and comparing two documents of an ontology statement by statement.
    o.addProperty("converts", true);
    o.addProperty("compares", true);
    // The assistant's requests are forwarded by the browser's profile only; this build has neither
    // /ai/forward nor /ai/key, so it says what it has.
    o.addProperty("forwardsAi", false);
    JsonArray reasoners = new JsonArray();
    for (String[] r : new String[][] {{"HermiT", Versions.HERMIT, "OWL 2 DL"}, {"ELK", Versions.ELK, "OWL 2 EL"}}) {
      JsonObject one = new JsonObject();
      one.addProperty("engine", r[0]);
      one.addProperty("engineVersion", r[1]);
      one.addProperty("covers", r[2]);
      reasoners.add(one);
    }
    o.add("reasoners", reasoners);
    // A key is held by the browser's profile only.
    o.addProperty("holdsAiKeys", false);
    // The syntaxes /convert writes, besides reading every one of them.
    JsonArray writes = new JsonArray();
    for (String w : OwlDocuments.WRITES) writes.add(w);
    o.add("writes", writes);
    return HttpSupport.respond(200, o);
  }
}
