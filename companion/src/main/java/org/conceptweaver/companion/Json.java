package org.conceptweaver.companion;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * The JSON both endpoints answer with, in the shapes the single-file service established
 * (reasoner/ReasonerService.java): a reasoning result carries the engine, its version and two
 * lists whatever happens; a document that could not be read carries only its errors.
 */
final class Json {

  static final Gson GSON = new Gson();

  private Json() {}

  /** An empty reasoning result, as every /reason answer starts. */
  static JsonObject result() {
    JsonObject o = new JsonObject();
    o.addProperty("engine", "HermiT");
    o.addProperty("engineVersion", Versions.HERMIT);
    o.addProperty("owlapi", Versions.OWLAPI);
    o.add("errors", new JsonArray());
    o.add("warnings", new JsonArray());
    return o;
  }

  /** A reasoning result that failed before it began, saying why. */
  static JsonObject failure(String message) {
    JsonObject o = result();
    o.addProperty("status", "failed");
    o.addProperty("consistency", "unknown");
    strings(o, "errors").add(message);
    return o;
  }

  /** A document answer carrying only what went wrong, for /convert and /compare. */
  static JsonObject unread(String message) {
    JsonObject o = new JsonObject();
    JsonArray errors = new JsonArray();
    errors.add(message);
    o.add("errors", errors);
    return o;
  }

  static JsonArray strings(JsonObject o, String key) {
    return o.getAsJsonArray(key);
  }

  static int intOf(JsonObject o, String key, int fallback) {
    JsonElement e = o == null ? null : o.get(key);
    return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsInt() : fallback;
  }

  /** The first `n` lines of a message, on one line and short enough to show. */
  static String firstLines(String s, int n) {
    String[] lines = s.split("\\R");
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < lines.length && i < n; i++) b.append(i > 0 ? " " : "").append(lines[i].trim());
    return b.length() > 600 ? b.substring(0, 600) + "…" : b.toString();
  }
}
