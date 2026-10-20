package org.conceptweaver.companion;

import com.google.gson.JsonObject;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /reason: the answer the single-file service gives, status for status and message for
 * message (reasoner/ReasonerService.java). A preflight is answered by {@link CorsFilter}; a page
 * that is not allowed is refused here with the reasoning answer's own shape.
 */
@RestController
final class ReasonController {

  private final OriginPolicy origins;
  private final ReasoningService reasoning;

  ReasonController(OriginPolicy origins, ReasoningService reasoning) {
    this.origins = origins;
    this.reasoning = reasoning;
  }

  @RequestMapping("/reason")
  ResponseEntity<String> reason(HttpServletRequest request) throws IOException {
    String origin = request.getHeader("Origin");
    if (!origins.allowed(origin)) {
      return HttpSupport.respond(403, Json.failure("This page is not allowed to use the reasoning service. Start the service with --allow-origin=<the page's origin>."));
    }
    if (!"POST".equals(request.getMethod())) {
      return HttpSupport.respond(405, Json.failure("POST an ontology to /reason."));
    }
    byte[] sent = HttpSupport.body(request);
    if (sent == null) {
      return HttpSupport.respond(413, Json.failure("The ontology is larger than the service accepts (64 MB)."));
    }
    JsonObject json = HttpSupport.parse(sent);
    if (json == null || !json.has("ontology") || !json.get("ontology").isJsonPrimitive()) {
      return HttpSupport.respond(400, Json.failure("The request is not JSON with an \"ontology\" in Turtle."));
    }
    try {
      return HttpSupport.respond(200, reasoning.run(json));
    } catch (RuntimeException | Error e) {
      // Whatever went wrong, the page is told that reasoning failed; it is never left to assume a result.
      return HttpSupport.respond(500, Json.failure("The reasoning service failed: " + e));
    }
  }
}
