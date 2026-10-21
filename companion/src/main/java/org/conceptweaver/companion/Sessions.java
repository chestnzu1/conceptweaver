package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.semanticweb.owlapi.apibinding.OWLManager;
import org.semanticweb.owlapi.formats.TurtleDocumentFormat;
import org.semanticweb.owlapi.io.StringDocumentSource;
import org.semanticweb.owlapi.model.IRI;
import org.semanticweb.owlapi.model.MissingImportHandlingStrategy;
import org.semanticweb.owlapi.model.OWLOntology;
import org.semanticweb.owlapi.model.OWLOntologyIRIMapper;
import org.semanticweb.owlapi.model.OWLOntologyLoaderConfiguration;
import org.semanticweb.owlapi.model.OWLOntologyManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Ontology sessions (roadmap task 3.4): an ontology is uploaded once and held by the hash of its
 * content, and the structure and entity query services are answered from it. The same content
 * uploaded again is the same session; a held session is what its reference says it is, so a
 * question about another revision of it is refused as stale.
 *
 * Holding is bounded: this is the bridge to Phase 4, not a store, and the oldest session goes
 * when the bound is reached (ADRs keep the page's ontology in the page until 3.7).
 */
@Service
public final class Sessions {

  /** One held ontology: what was uploaded, and what was read from it. */
  record Held(OWLOntologyManager manager, OWLOntology ontology, String document, List<String[]> imports, String ontologyId, String revisionId, long used) {}

  private final int bound;

  /** Held by their reference, the one most recently asked of last. */
  private final Map<String, Held> held = new LinkedHashMap<>(8, 0.75f, true);

  Sessions(@Value("${conceptweaver.sessions.cache:8}") int bound) {
    this.bound = bound;
  }

  /**
   * Uploads an ontology: one POST of `{document, imports?}` to /sessions, answered with the
   * reference the structure and entity questions ask by. The revision is the SHA-256 of the
   * document and its imports, so the same content is the same session whoever asks; the ontology
   * is the one the document names, or a name of its own where it names none.
   */
  public JsonObject upload(JsonObject request) {
    String document = request.get("document").getAsString();
    List<String[]> imports = new ArrayList<>();
    JsonArray provided = request.has("imports") && request.get("imports").isJsonArray() ? request.getAsJsonArray("imports") : new JsonArray();
    for (JsonElement e : provided) {
      JsonObject imp = e.getAsJsonObject();
      imports.add(new String[] {imp.get("iri").getAsString(), imp.get("text").getAsString()});
    }
    String revisionId = hash(document, imports);
    OWLOntologyManager manager = OWLManager.createOWLOntologyManager();
    manager.getIRIMappers().add((OWLOntologyIRIMapper) iri -> IRI.create(OwlDocuments.NOT_PROVIDED + Integer.toHexString(iri.toString().hashCode())));
    OWLOntologyLoaderConfiguration config = new OWLOntologyLoaderConfiguration().setMissingImportHandlingStrategy(MissingImportHandlingStrategy.SILENT);
    // An import that was not sent is not fetched; one that was, is loaded from what was sent.
    Map<String, IRI> providedIris = new LinkedHashMap<>();
    for (int i = 0; i < imports.size(); i++) providedIris.put(imports.get(i)[0], IRI.create("urn:conceptweaver:import:" + i));
    manager.getIRIMappers().add((OWLOntologyIRIMapper) iri -> providedIris.get(iri.toString()));
    for (int i = 0; i < imports.size(); i++) {
      try {
        manager.loadOntologyFromOntologyDocument(new StringDocumentSource(imports.get(i)[1], IRI.create("urn:conceptweaver:import:" + i), new TurtleDocumentFormat(), null), config);
      } catch (Exception ignored) {
        // An import that cannot be read is left out, as /reason leaves it out; the session is the document itself.
      }
    }
    OWLOntology ontology;
    try {
      ontology = manager.loadOntologyFromOntologyDocument(new StringDocumentSource(document, IRI.create("urn:conceptweaver:ontology"), new TurtleDocumentFormat(), null), config);
    } catch (Exception e) {
      throw new Refusal("failed", ReasoningService.describe(e));
    }
    String ontologyId = OwlDocuments.iriText(ontology.getOntologyID().getOntologyIRI());
    if (ontologyId.isEmpty()) ontologyId = "urn:conceptweaver:ontology:" + revisionId.substring(0, 16);
    Held one = new Held(manager, ontology, document, imports, ontologyId, revisionId, System.nanoTime());
    held.put(ontologyId + "\n" + revisionId, one);
    while (held.size() > bound) held.remove(held.keySet().iterator().next());
    JsonObject out = new JsonObject();
    out.addProperty("ontologyId", ontologyId);
    out.addProperty("revisionId", revisionId);
    return out;
  }

  /** The held session a question names, or the refusal a session that is not held gets. */
  public Held held(String ontologyId, String revisionId) {
    Held one = held.get(ontologyId + "\n" + revisionId);
    if (one == null) throw new Refusal("stale-revision", "The ontology has changed since this was asked about.");
    return one;
  }

  /** The SHA-256 of the document and its imports, as the revision of the session. */
  static String hash(String document, List<String[]> imports) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      digest.update(document.getBytes(StandardCharsets.UTF_8));
      for (String[] imp : imports) {
        digest.update(imp[0].getBytes(StandardCharsets.UTF_8));
        digest.update((byte) 0);
        digest.update(imp[1].getBytes(StandardCharsets.UTF_8));
        digest.update((byte) 0);
      }
      return HexFormat.of().formatHex(digest.digest());
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
