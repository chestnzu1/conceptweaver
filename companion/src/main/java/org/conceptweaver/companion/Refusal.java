package org.conceptweaver.companion;

import com.google.gson.JsonObject;

/**
 * A refusal of the job API, in the terms the page knows (src/reasoning/contracts.ts): a code and
 * what it means. The code says which refusal it is; the status is how it is said in HTTP.
 */
final class Refusal extends RuntimeException {

  final String code;

  Refusal(String code, String message) {
    super(message);
    this.code = code;
  }

  int status() {
    return switch (code) {
      case "not-found" -> 404;
      case "invalid" -> 400;
      case "unsupported" -> 501;
      case "stale-revision", "cancelled" -> 409;
      case "failed" -> 422;
      case "aborted" -> 499;
      case "busy" -> 429;
      default -> 500;
    };
  }

  /** What the page is told: the code and the message, and nothing else. */
  JsonObject body() {
    JsonObject o = new JsonObject();
    o.addProperty("code", code);
    o.addProperty("message", getMessage());
    return o;
  }
}
