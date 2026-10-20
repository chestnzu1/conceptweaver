package org.conceptweaver.companion;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Which pages may use the service, as the single-file service decides it: a page on this machine
 * always may, another origin only when it was named at start (--allow-origin=&lt;origin&gt;, or
 * {@code *}). The service itself refuses a disallowed origin; CORS headers only tell the browser
 * what this check already allows.
 */
@Component
final class OriginPolicy {

  private final List<String> named = new ArrayList<>();

  OriginPolicy(@Value("${conceptweaver.allow-origins:}") String origins) {
    for (String origin : origins.split(",")) {
      String one = origin.trim();
      if (!one.isEmpty()) named.add(one);
    }
  }

  boolean allowed(String origin) {
    if (origin == null) return true;
    if (named.contains("*") || named.contains(origin)) return true;
    try {
      String host = URI.create(origin).getHost();
      return host != null && (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]") || host.equals("::1"));
    } catch (IllegalArgumentException e) {
      return false;
    }
  }
}
