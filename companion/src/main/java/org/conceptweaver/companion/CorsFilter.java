package org.conceptweaver.companion;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * The headers that let an allowed page read the answer, and the preflight answer. A preflight
 * from a disallowed origin is refused here; every other request goes on to the endpoint, which
 * refuses a disallowed origin itself with the answer shape of that endpoint.
 */
@Component
final class CorsFilter extends OncePerRequestFilter {

  private final OriginPolicy origins;

  CorsFilter(OriginPolicy origins) {
    this.origins = origins;
  }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
    String origin = request.getHeader("Origin");
    boolean allowed = origins.allowed(origin);
    if (origin != null && allowed) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      response.setHeader("Access-Control-Max-Age", "600");
    }
    if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
      response.setStatus(allowed ? HttpServletResponse.SC_NO_CONTENT : HttpServletResponse.SC_FORBIDDEN);
      return;
    }
    chain.doFilter(request, response);
  }
}
