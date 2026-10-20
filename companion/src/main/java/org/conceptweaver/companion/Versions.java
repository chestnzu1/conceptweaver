package org.conceptweaver.companion;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/**
 * The versions of what this service actually loads, read from the Maven metadata on the
 * classpath. The single-file service reports the same fields; reading the metadata rather than
 * naming versions in code keeps the answer true whichever profile the companion was built with.
 */
final class Versions {

  /** HermiT, the OWL 2 DL reasoner. */
  static final String HERMIT = of("net.sourceforge.owlapi", "org.semanticweb.hermit");
  /** ELK, the OWL 2 EL reasoner. */
  static final String ELK = of("io.github.liveontologies", "elk-owlapi");
  /** The OWL API itself. */
  static final String OWLAPI = of("net.sourceforge.owlapi", "owlapi-api");

  private Versions() {}

  static String of(String group, String artifact) {
    String path = "META-INF/maven/" + group + "/" + artifact + "/pom.properties";
    try (InputStream in = Versions.class.getClassLoader().getResourceAsStream(path)) {
      if (in == null) return "unknown";
      Properties p = new Properties();
      p.load(in);
      return p.getProperty("version", "unknown");
    } catch (IOException e) {
      return "unknown";
    }
  }
}
