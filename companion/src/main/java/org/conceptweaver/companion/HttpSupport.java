package org.conceptweaver.companion;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import jakarta.servlet.http.HttpServletRequest;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/** The HTTP details both endpoints share: the body limit, JSON reading and the answer envelope. */
final class HttpSupport {

  /** The most the service accepts, as the single-file service does (64 MB). */
  static final int MAX_BODY = 64 * 1024 * 1024;

  private HttpSupport() {}

  /** What was sent, or nothing when it is more than the service takes. */
  static byte[] body(HttpServletRequest request) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    try (InputStream in = request.getInputStream()) {
      byte[] chunk = new byte[65536];
      for (int n; (n = in.read(chunk)) > 0; ) {
        buf.write(chunk, 0, n);
        if (buf.size() > MAX_BODY) return null;
      }
    }
    return buf.toByteArray();
  }

  /** What was sent, read as JSON, or null when it is not JSON or is not an object. */
  static JsonObject parse(byte[] sent) {
    try {
      return Json.GSON.fromJson(new String(sent, StandardCharsets.UTF_8), JsonObject.class);
    } catch (RuntimeException e) {
      return null;
    }
  }

  /** A JSON answer, as the single-file service writes it: never cached. */
  static ResponseEntity<String> respond(int status, JsonElement body) {
    return ResponseEntity.status(status)
        .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
        .cacheControl(CacheControl.noStore())
        .body(Json.GSON.toJson(body));
  }

  /** An answer with no body, for a preflight. */
  static ResponseEntity<Void> noContent() {
    return ResponseEntity.noContent().build();
  }
}
