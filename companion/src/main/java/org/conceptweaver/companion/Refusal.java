package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * A refusal of the job API, in the terms the page knows (src/reasoning/contracts.ts): a code and
 * what it means. The code says which refusal it is; the status is how it is said in HTTP.
 */
final class Refusal extends RuntimeException {

  final String code;
  final JsonArray refusals;

  Refusal(String code, String message) {
    this(code, message, null);
  }

  Refusal(String code, String message, JsonArray refusals) {
    super(message);
    this.code = code;
    this.refusals = refusals;
  }

  int status() {
    return switch (code) {
      case "not-found" -> 404;
      case "invalid" -> 400;
      case "unsupported" -> 501;
      case "stale-revision", "cancelled", "refused" -> 409;
      case "failed" -> 422;
      case "aborted" -> 499;
      case "busy" -> 429;
      default -> 500;
    };
  }

  /** What the page is told: the code and the message, with the refusals of a change set where it was one. */
  JsonObject body() {
    JsonObject o = new JsonObject();
    o.addProperty("code", code);
    o.addProperty("message", getMessage());
    if (refusals != null) o.add("refusals", refusals);
    return o;
  }
}
