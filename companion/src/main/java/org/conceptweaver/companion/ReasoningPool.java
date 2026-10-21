package org.conceptweaver.companion;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Future;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Callable;
import org.springframework.stereotype.Component;

/**
 * The one executor every piece of reasoning goes through: jobs, and the synchronous /reason too,
 * so that the bound holds however the page asks. Its size is the installation's (one worker, a
 * few waiting, by default): a full queue refuses new work rather than hold it in an unbounded one
 * and load more ontologies into the same heap (TD-14).
 */
@Component
final class ReasoningPool {

  private final ThreadPoolExecutor pool;
  private final ReasoningSettings settings;

  ReasoningPool(ReasoningSettings settings) {
    this.settings = settings;
    BlockingQueue<Runnable> waiting = settings.queue == 0 ? new SynchronousQueue<>() : new ArrayBlockingQueue<>(settings.queue);
    this.pool = new ThreadPoolExecutor(settings.workers, settings.workers, 0L, TimeUnit.MILLISECONDS, waiting, r -> {
      Thread t = new Thread(r, "reasoning");
      t.setDaemon(true);
      return t;
    });
  }

  /** What is refused when there is no room; the refusal's own words are {@link #busy()}. */
  <T> Future<T> submit(Callable<T> task) {
    return pool.submit(task);
  }

  /** Why a start could not be taken on, in words a person can act on. */
  String busy() {
    return "The reasoning service is busy: " + settings.workers + (settings.workers == 1 ? " job runs" : " jobs run") + " at a time and " + settings.queue
        + (settings.queue == 1 ? " waits" : " wait") + ". Ask again when one has finished.";
  }
}
