package org.conceptweaver.companion;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /structure/{question}: the Structure Explorer's questions, answered from a held ontology
 * (roadmap task 3.4), status for status and message for message as the page's own answerer says
 * them (src/structure/http.ts answerStructureRequest). A preflight is answered by
 * {@link CorsFilter}; a page that is not allowed is refused here with the questions' own shape.
 */
@RestController
final class StructureController {

  private final OriginPolicy origins;
  private final SessionStructure structure;

  StructureController(OriginPolicy origins, SessionStructure structure) {
    this.origins = origins;
    this.structure = structure;
  }

  @RequestMapping("/structure/{question}")
  ResponseEntity<String> ask(@PathVariable String question, HttpServletRequest request) throws IOException {
    String origin = request.getHeader("Origin");
    if (!origins.allowed(origin)) {
      return HttpSupport.respond(403, Json.message("This page is not allowed to use the structure service. Start the service with --allow-origin=<the page's origin>."));
    }
    if (!"POST".equals(request.getMethod())) {
      return HttpSupport.respond(405, Json.message("POST a question to /structure/{question}."));
    }
    if (!java.util.Arrays.asList(SessionStructure.QUESTIONS).contains(question)) {
      return HttpSupport.respond(404, new Refusal("not-found", "There is no question “" + question + "”.").body());
    }
    byte[] sent = HttpSupport.body(request);
    if (sent == null) {
      return HttpSupport.respond(413, Json.message("The question is larger than the service accepts (64 MB)."));
    }
    JsonObject query = HttpSupport.parse(sent);
    if (query == null || !query.has("ontologyId") || !query.has("revisionId")) {
      return HttpSupport.respond(400, Json.message("The request is not JSON with the \"ontologyId\" and \"revisionId\" of the ontology to ask about."));
    }
    try {
      return HttpSupport.respond(200, structure.answer(question, query));
    } catch (Refusal e) {
      return HttpSupport.respond(e.status(), e.body());
    } catch (RuntimeException | Error e) {
      return HttpSupport.respond(500, Json.message("The structure service failed: " + e));
    }
  }
}
