package org.conceptweaver.companion;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The companion service: the Java semantic backend of Phase 3, run beside the app as the
 * single-file service is (reasoner/ReasonerService.java) and taking the same arguments:
 * {@code --port=5190}, {@code --host=127.0.0.1} and, repeated, {@code --allow-origin=<origin>}.
 * It listens on this machine only unless started with another host.
 */
@SpringBootApplication
public class CompanionApplication {

  public static void main(String[] args) {
    List<String> spring = new ArrayList<>();
    List<String> origins = new ArrayList<>();
    for (String a : args) {
      if (a.startsWith("--port=")) spring.add("--server.port=" + a.substring(7));
      else if (a.startsWith("--host=")) spring.add("--server.address=" + a.substring(7));
      else if (a.startsWith("--allow-origin=")) origins.add(a.substring(15));
      else spring.add(a);
    }
    if (!origins.isEmpty()) System.setProperty("conceptweaver.allow-origins", String.join(",", origins));
    SpringApplication.run(CompanionApplication.class, spring.toArray(new String[0]));
  }
}
