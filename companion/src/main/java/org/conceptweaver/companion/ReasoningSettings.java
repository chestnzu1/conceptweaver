package org.conceptweaver.companion;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * How much reasoning the service does at once, and for how long (roadmap task 3.3, TD-14).
 *
 * One job at a time unless told otherwise, with a few waiting: two classifications at once would
 * each load their ontology into the same heap, which is how the service ran out of memory. A
 * request may ask for a different timeout, within the maximum; it may not raise the maximum. The
 * answer says the timeout and heap it was worked out under.
 */
@Component
final class ReasoningSettings {

  /** However little a request asks for, the reasoner is given this long. */
  static final int MIN_TIMEOUT_MS = 1_000;

  final int workers;
  final int queue;
  final int timeoutMs;
  final int maxTimeoutMs;
  final int cache;

  ReasoningSettings(
      @Value("${conceptweaver.reasoning.workers:1}") int workers,
      @Value("${conceptweaver.reasoning.queue:4}") int queue,
      @Value("${conceptweaver.reasoning.timeout-ms:60000}") int timeoutMs,
      @Value("${conceptweaver.reasoning.max-timeout-ms:600000}") int maxTimeoutMs,
      @Value("${conceptweaver.reasoning.cache:16}") int cache) {
    this.workers = Math.max(1, workers);
    this.queue = Math.max(0, queue);
    this.maxTimeoutMs = Math.max(MIN_TIMEOUT_MS, maxTimeoutMs);
    this.timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(this.maxTimeoutMs, timeoutMs));
    this.cache = Math.max(0, cache);
  }

  /** The timeout a request is worked out under: what it asks for, within what the service allows. */
  int timeoutOf(int asked) {
    return Math.max(MIN_TIMEOUT_MS, Math.min(maxTimeoutMs, asked));
  }
}
