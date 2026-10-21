package org.conceptweaver.companion;

import com.google.gson.JsonObject;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /editing/{question}: change sets applied to a held ontology (roadmap task 3.5), whole or
 * not at all, held to the editor's own rules, status for status and message for message as the
 * page's own service says them (src/editing/http.ts answerEditRequest). A preflight is answered
 * by {@link CorsFilter}; a page that is not allowed is refused here with the questions' own shape.
 */
@RestController
final class EditingController {

  private final OriginPolicy origins;
  private final SessionEditing editing;

  EditingController(OriginPolicy origins, SessionEditing editing) {
    this.origins = origins;
    this.editing = editing;
  }

  @RequestMapping("/editing/{question}")
  ResponseEntity<String> ask(@PathVariable String question, HttpServletRequest request) throws IOException {
    String origin = request.getHeader("Origin");
    if (!origins.allowed(origin)) {
      return HttpSupport.respond(403, Json.message("This page is not allowed to use the edit service. Start the service with --allow-origin=<the page's origin>."));
    }
    if (!"POST".equals(request.getMethod())) {
      return HttpSupport.respond(405, Json.message("POST a question to /editing/{question}."));
    }
    if (!java.util.Arrays.asList("apply", "validate", "entity").contains(question)) {
      return HttpSupport.respond(404, new Refusal("not-found", "There is no question “" + question + "”.").body());
    }
    byte[] sent = HttpSupport.body(request);
    if (sent == null) {
      return HttpSupport.respond(413, Json.message("The question is larger than the service accepts (64 MB)."));
    }
    JsonObject query = HttpSupport.parse(sent);
    boolean named = query != null && query.has("ontologyId") && (query.has("baseRevision") || query.has("revisionId"));
    if (!named) {
      return HttpSupport.respond(400, Json.message("The request is not JSON with the \"ontologyId\" and the revision of the ontology to edit."));
    }
    try {
      return HttpSupport.respond(200, editing.answer(question, query));
    } catch (Refusal e) {
      return HttpSupport.respond(e.status(), e.body());
    } catch (RuntimeException | Error e) {
      return HttpSupport.respond(500, Json.message("The edit service failed: " + e));
    }
  }
}
