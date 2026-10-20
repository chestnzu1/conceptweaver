package org.conceptweaver.companion;

import com.google.gson.JsonObject;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.function.Function;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /convert and POST /compare: reading a document in any OWL syntax and writing it in
 * another, or comparing two documents of one ontology statement by statement, as the single-file
 * service answers (reasoner/ReasonerService.java). Errors are the document answer's own shape,
 * sent as 422; a preflight is answered by {@link CorsFilter}.
 */
@RestController
final class OwlController {

  private final OriginPolicy origins;

  OwlController(OriginPolicy origins) {
    this.origins = origins;
  }

  @RequestMapping("/convert")
  ResponseEntity<String> convert(HttpServletRequest request) throws IOException {
    return documents(request, "POST an ontology to /convert.", "The request is not JSON with the \"document\" to read.", new String[] {"document"},
        r -> OwlDocuments.converted(r.get("document").getAsString(), r.has("to") && r.get("to").isJsonPrimitive() ? r.get("to").getAsString() : "turtle"));
  }

  @RequestMapping("/compare")
  ResponseEntity<String> compare(HttpServletRequest request) throws IOException {
    return documents(request, "POST two documents to /compare.", "The request is not JSON with the \"original\" and the \"exported\" document.", new String[] {"original", "exported"},
        r -> OwlDocuments.compared(r.get("original").getAsString(), r.get("exported").getAsString()));
  }

  /**
   * What /convert and /compare have in common as HTTP: a POST of JSON in which each of `fields` is
   * a string, answered with what `answer` makes of it, and as 422 when that is errors only.
   */
  private ResponseEntity<String> documents(HttpServletRequest request, String usage, String malformed, String[] fields, Function<JsonObject, JsonObject> answer) throws IOException {
    String origin = request.getHeader("Origin");
    if (!origins.allowed(origin)) {
      return HttpSupport.respond(403, Json.unread("This page is not allowed to use the OWL service. Start the service with --allow-origin=<the page's origin>."));
    }
    if (!"POST".equals(request.getMethod())) {
      return HttpSupport.respond(405, Json.unread(usage));
    }
    byte[] sent = HttpSupport.body(request);
    if (sent == null) {
      return HttpSupport.respond(413, Json.unread("The ontology is larger than the service accepts (64 MB)."));
    }
    JsonObject json = HttpSupport.parse(sent);
    boolean complete = json != null;
    for (String f : fields) complete = complete && json.has(f) && json.get(f).isJsonPrimitive();
    if (!complete) {
      return HttpSupport.respond(400, Json.unread(malformed));
    }
    try {
      JsonObject out = answer.apply(json);
      return HttpSupport.respond(out.getAsJsonArray("errors").size() == 0 ? 200 : 422, out);
    } catch (RuntimeException | Error e) {
      return HttpSupport.respond(500, Json.unread(e instanceof OutOfMemoryError ? "The OWL service ran out of memory reading this ontology." : "The OWL service failed: " + e));
    }
  }
}
