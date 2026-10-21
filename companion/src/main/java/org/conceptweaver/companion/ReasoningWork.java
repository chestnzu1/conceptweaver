package org.conceptweaver.companion;

import com.google.gson.JsonObject;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.semanticweb.owlapi.reasoner.OWLReasoner;

/**
 * The work one reasoning job does: the report /reason gives for a request, telling `phase` what
 * it is doing as it goes (roadmap task 3.3). It is the seam that lets a job's bookkeeping — queue,
 * cancel, timeout, cache — be tested without a reasoner.
 */
@FunctionalInterface
interface ReasoningWork {

  /** The report for `request`, worked out to finish within `timeoutMs`, unless stopped first. */
  JsonObject report(JsonObject request, int timeoutMs, Consumer<String> phase, AtomicReference<OWLReasoner> running) throws Exception;
}
