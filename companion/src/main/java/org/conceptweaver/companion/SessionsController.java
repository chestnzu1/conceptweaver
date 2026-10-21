package org.conceptweaver.companion;

import com.google.gson.JsonObject;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /sessions: an ontology uploaded once and held by content hash (roadmap task 3.4), answered
 * with the reference the structure and entity questions ask by. A preflight is answered by
 * {@link CorsFilter}; a page that is not allowed is refused here as every endpoint refuses it.
 */
@RestController
final class SessionsController {

  private final OriginPolicy origins;
  private final Sessions sessions;

  SessionsController(OriginPolicy origins, Sessions sessions) {
    this.origins = origins;
    this.sessions = sessions;
  }

  @RequestMapping("/sessions")
  ResponseEntity<String> upload(HttpServletRequest request) throws IOException {
    String origin = request.getHeader("Origin");
    if (!origins.allowed(origin)) {
      return HttpSupport.respond(403, Json.message("This page is not allowed to use the ontology service. Start the service with --allow-origin=<the page's origin>."));
    }
    if (!"POST".equals(request.getMethod())) {
      return HttpSupport.respond(405, Json.message("POST an ontology to /sessions."));
    }
    byte[] sent = HttpSupport.body(request);
    if (sent == null) {
      return HttpSupport.respond(413, Json.message("The ontology is larger than the service accepts (64 MB)."));
    }
    JsonObject json = HttpSupport.parse(sent);
    if (json == null || !json.has("document") || !json.get("document").isJsonPrimitive()) {
      return HttpSupport.respond(400, Json.message("The request is not JSON with the \"document\" to hold, in Turtle."));
    }
    try {
      return HttpSupport.respond(200, sessions.upload(json));
    } catch (Refusal e) {
      return HttpSupport.respond(e.status(), Json.message(e.getMessage()));
    } catch (RuntimeException | Error e) {
      return HttpSupport.respond(500, Json.message("The ontology service failed: " + e));
    }
  }
}
