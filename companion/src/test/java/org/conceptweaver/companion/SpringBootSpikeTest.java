package org.conceptweaver.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * Spring Boot, on the same classpath as the OWL API and both reasoners, starts and answers
 * (roadmap task 3.1). Task 3.2 gives this answer the behaviour of the single-file service.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SpringBootSpikeTest {

  @Value("${local.server.port}")
  int port;

  @Test
  void healthAnswersWithTheServiceAndTheDependencies() throws Exception {
    HttpResponse<String> response = HttpClient.newHttpClient().send(
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health")).GET().build(),
        HttpResponse.BodyHandlers.ofString());

    assertEquals(200, response.statusCode());
    JsonObject health = JsonParser.parseString(response.body()).getAsJsonObject();
    assertEquals("conceptweaver-reasoner", health.get("service").getAsString());
    assertEquals("HermiT", health.get("engine").getAsString());
    assertEquals(System.getProperty("expected.owlapi.version"), health.get("owlapi").getAsString(),
        "the service reports the OWL API the profile declared");
    assertEquals("HermiT", health.getAsJsonArray("reasoners").get(0).getAsJsonObject().get("engine").getAsString());
    assertEquals("ELK", health.getAsJsonArray("reasoners").get(1).getAsJsonObject().get("engine").getAsString());
    assertEquals(System.getProperty("expected.elk.version"),
        health.getAsJsonArray("reasoners").get(1).getAsJsonObject().get("engineVersion").getAsString(),
        "the service reports the ELK the profile declared");
    assertTrue(health.getAsJsonArray("writes").size() == 5, "every syntax /convert writes is named");
  }
}
