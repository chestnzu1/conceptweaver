package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.semanticweb.owlapi.apibinding.OWLManager;
import org.semanticweb.owlapi.formats.FunctionalSyntaxDocumentFormat;
import org.semanticweb.owlapi.formats.ManchesterSyntaxDocumentFormat;
import org.semanticweb.owlapi.formats.OBODocumentFormat;
import org.semanticweb.owlapi.formats.OWLXMLDocumentFormat;
import org.semanticweb.owlapi.formats.PrefixDocumentFormat;
import org.semanticweb.owlapi.formats.RDFXMLDocumentFormat;
import org.semanticweb.owlapi.formats.TurtleDocumentFormat;
import org.semanticweb.owlapi.io.StringDocumentSource;
import org.semanticweb.owlapi.io.StringDocumentTarget;
import org.semanticweb.owlapi.model.IRI;
import org.semanticweb.owlapi.model.MissingImportHandlingStrategy;
import org.semanticweb.owlapi.model.OWLAnnotation;
import org.semanticweb.owlapi.model.OWLAxiom;
import org.semanticweb.owlapi.model.OWLDocumentFormat;
import org.semanticweb.owlapi.model.OWLImportsDeclaration;
import org.semanticweb.owlapi.model.OWLOntology;
import org.semanticweb.owlapi.model.OWLOntologyIRIMapper;
import org.semanticweb.owlapi.model.OWLOntologyLoaderConfiguration;
import org.semanticweb.owlapi.model.OWLOntologyManager;
import org.semanticweb.owlapi.util.SimpleRenderer;

/**
 * Reading a document in any syntax the OWL API knows, writing it in another, and comparing two
 * documents statement by statement: what /convert and /compare answer, carried over unchanged from
 * reasoner/ReasonerService.java. Nothing is fetched: an import stays an import by its IRI.
 */
final class OwlDocuments {

  /** Where an import that was not sent is "found": a file that does not exist, so that it is missing and nothing is fetched. */
  static final String NOT_PROVIDED = "file:/conceptweaver-import-not-provided/";

  /** The syntaxes a document can be written in, by the names the app gives them. */
  static final String[] WRITES = {"turtle", "rdfxml", "owlxml", "functional", "manchester"};

  static final Pattern BLANK_NODE = Pattern.compile("_:[A-Za-z0-9_.-]+");

  private OwlDocuments() {}

  static OWLDocumentFormat writer(String to) {
    switch (to) {
      case "turtle": return new TurtleDocumentFormat();
      case "rdfxml": return new RDFXMLDocumentFormat();
      case "owlxml": return new OWLXMLDocumentFormat();
      case "functional": return new FunctionalSyntaxDocumentFormat();
      case "manchester": return new ManchesterSyntaxDocumentFormat();
      default: return null;
    }
  }

  /** A document that could not be read, and why, in words. */
  static final class Unreadable extends Exception {
    Unreadable(String message) {
      super(message);
    }
  }

  /**
   * Reads a document into `manager`. Nothing is fetched: what the document imports stays an
   * import by its IRI, which the app records.
   */
  static OWLOntology read(OWLOntologyManager manager, String document) throws Unreadable {
    manager.getIRIMappers().add((OWLOntologyIRIMapper) iri -> IRI.create(NOT_PROVIDED + Integer.toHexString(iri.toString().hashCode())));
    OWLOntologyLoaderConfiguration config = new OWLOntologyLoaderConfiguration().setMissingImportHandlingStrategy(MissingImportHandlingStrategy.SILENT);
    // The syntax is told from how the document starts, so that one parser is tried and its complaint is the one reported.
    OWLDocumentFormat written = syntaxOf(document);
    try {
      StringDocumentSource source = written == null ? new StringDocumentSource(document) : new StringDocumentSource(document, IRI.create("urn:conceptweaver:document"), written, null);
      return manager.loadOntologyFromOntologyDocument(source, config);
    } catch (Exception e) {
      String said = e.getMessage() == null ? e.toString() : e.getMessage();
      String as = written == null ? "an ontology in any syntax the OWL API knows" : written.getKey();
      throw new Unreadable("It could not be read as " + as + ": " + complaint(said));
    }
  }

  /**
   * A document read in whichever syntax it is in and written in another, with the prefixes it
   * was written with: as Turtle (`turtle`, for reading into the app), or, for exporting from it,
   * as RDF/XML, OWL/XML, functional or Manchester syntax (`document`).
   */
  static JsonObject converted(String document, String to) {
    OWLDocumentFormat into = writer(to);
    if (into == null) return Json.unread("The OWL service does not write \"" + to + "\": it writes " + String.join(", ", WRITES) + ".");
    OWLOntologyManager manager = OWLManager.createOWLOntologyManager();
    OWLOntology ontology;
    try {
      ontology = read(manager, document);
    } catch (Unreadable e) {
      return Json.unread(e.getMessage());
    }
    try {
      OWLDocumentFormat source = manager.getOntologyFormat(ontology);
      if (source instanceof PrefixDocumentFormat && into instanceof PrefixDocumentFormat) ((PrefixDocumentFormat) into).copyPrefixesFrom((PrefixDocumentFormat) source);
      StringDocumentTarget target = new StringDocumentTarget();
      manager.saveOntology(ontology, into, target);
      JsonObject out = new JsonObject();
      out.add("errors", new JsonArray());
      if (to.equals("turtle")) out.addProperty("turtle", target.toString());
      out.addProperty("document", target.toString());
      out.addProperty("to", to);
      out.addProperty("format", source == null ? "unknown" : source.getKey());
      out.addProperty("axioms", ontology.getAxiomCount());
      return out;
    } catch (Exception e) {
      return Json.unread("It was read, but could not be written as " + into.getKey() + ": " + Json.firstLines(String.valueOf(e.getMessage()), 3));
    }
  }

  /** The syntax a document is written in, by how it starts; nothing where that does not say. */
  static OWLDocumentFormat syntaxOf(String document) {
    String start = document.replaceFirst("^\\uFEFF", "").replaceFirst("(?s)^(\\s*#[^\\n]*\\n)+", "").trim();
    if (start.matches("(?s)^(Prefix|Ontology)\\s*\\(.*")) return new FunctionalSyntaxDocumentFormat();
    if (start.matches("(?s)^(Prefix|Namespace|Ontology|Import):.*")) return new ManchesterSyntaxDocumentFormat();
    if (start.matches("(?s)^format-version\\s*:.*")) return new OBODocumentFormat();
    if (start.startsWith("<")) {
      String head = start.substring(0, Math.min(start.length(), 20000));
      if (head.matches("(?s).*<Ontology\\b[^>]*\\bxmlns\\s*=\\s*[\"']http://www\\.w3\\.org/2002/07/owl#[\"'].*")) return new OWLXMLDocumentFormat();
      if (head.contains("<rdf:RDF") || head.contains(":RDF ")) return new RDFXMLDocumentFormat();
    }
    return null;
  }

  /** What a parser objected to, without the list of parsers that were tried and without the stack. */
  static String complaint(String message) {
    Matcher m = Pattern.compile("(?s)Parser: [^\\n]*\\n\\s*(?:Stack trace:\\s*)?(.*?)(?:\\n\\s*\\n|\\z)").matcher(message);
    String found = m.find() ? m.group(1) : message;
    return Json.firstLines(found.replaceAll("(?m)^\\s*at .*$", "").replaceAll("org\\.[A-Za-z.]+\\.([A-Za-z]+Exception):?", "").trim(), 3);
  }

  /**
   * The IRI an optional holds, or the empty string: OWL API 4's OWLOntologyID hands back Guava's
   * Optional and OWL API 5's java.util's, so the value is asked for by what it offers, not by type.
   */
  static String iriText(Object optional) {
    if (optional == null) return "";
    if (optional instanceof java.util.Optional) {
      java.util.Optional<?> one = (java.util.Optional<?>) optional;
      return one.isPresent() ? one.get().toString() : "";
    }
    try {
      // Guava's Optional: its methods are asked for on the public Optional class — the Present it
      // hands back is package-private, and a method asked for on that class is not callable.
      Class<?> optionalClass = Class.forName("com.google.common.base.Optional");
      boolean present = (Boolean) optionalClass.getMethod("isPresent").invoke(optional);
      return present ? String.valueOf(optionalClass.getMethod("get").invoke(optional)) : "";
    } catch (ReflectiveOperationException e) {
      return "";
    }
  }

  /**
   * Two documents of one ontology, as different tools wrote them, compared statement by statement:
   * the axioms, the ontology's IRI and version IRI, its annotations and its imports. What is in
   * one and not the other is listed, each statement written as in functional syntax with the
   * prefixes of the original. Used to measure what a round trip through the app loses.
   */
  static JsonObject compared(String original, String exported) {
    // One manager each: the two documents are usually the same ontology, by the same IRI.
    OWLOntologyManager left = OWLManager.createOWLOntologyManager();
    OWLOntologyManager right = OWLManager.createOWLOntologyManager();
    OWLOntology a;
    OWLOntology b;
    try {
      a = read(left, original);
    } catch (Unreadable e) {
      return Json.unread("The original: " + e.getMessage());
    }
    try {
      b = read(right, exported);
    } catch (Unreadable e) {
      return Json.unread("The export: " + e.getMessage());
    }
    SimpleRenderer shown = new SimpleRenderer();
    setPrefixes(shown, a);
    SimpleRenderer plain = new SimpleRenderer();
    Map<Object, String> inA = statements(a, shown, plain);
    Map<Object, String> inB = statements(b, shown, plain);
    JsonObject out = new JsonObject();
    out.add("errors", new JsonArray());
    out.add("original", described(left, a));
    out.add("exported", described(right, b));
    out.add("removed", only(inA, inB));
    out.add("added", only(inB, inA));
    return out;
  }

  /**
   * The prefixes of the ontology's format, set on the renderer. The OWL API 4 call takes the
   * manager and the OWL API 5 call does not; copying the map works the same on both.
   */
  static void setPrefixes(SimpleRenderer renderer, OWLOntology ontology) {
    OWLDocumentFormat format = ontology.getOWLOntologyManager().getOntologyFormat(ontology);
    if (!(format instanceof PrefixDocumentFormat)) return;
    for (Map.Entry<String, String> e : ((PrefixDocumentFormat) format).getPrefixName2PrefixMap().entrySet()) {
      if (!e.getKey().equals(":")) renderer.setPrefix(e.getKey(), e.getValue());
    }
  }

  static JsonObject described(OWLOntologyManager manager, OWLOntology o) {
    JsonObject d = new JsonObject();
    OWLDocumentFormat format = manager.getOntologyFormat(o);
    d.addProperty("format", format == null ? "unknown" : format.getKey());
    d.addProperty("axioms", o.getAxiomCount());
    return d;
  }

  /** The statements of `in` that `other` does not have, as they are written, sorted. */
  static JsonArray only(Map<Object, String> in, Map<Object, String> other) {
    List<String> missing = new ArrayList<>();
    for (Map.Entry<Object, String> e : in.entrySet()) if (!other.containsKey(e.getKey())) missing.add(e.getValue());
    Collections.sort(missing);
    JsonArray out = new JsonArray();
    for (String m : missing) out.add(m);
    return out;
  }

  /**
   * What an ontology states, each statement under the key by which the same statement is found in
   * the other document: the OWL API object itself, which compares by structure. An anonymous
   * individual is named afresh each time a document is read, so a statement that has one is
   * keyed by how it reads with every blank node called the same; and is written so, as _:x.
   */
  static Map<Object, String> statements(OWLOntology o, SimpleRenderer shown, SimpleRenderer plain) {
    Map<Object, String> out = new HashMap<>();
    for (OWLAxiom ax : o.getAxioms()) out.put(ax.getAnonymousIndividuals().isEmpty() ? ax : "axiom " + BLANK_NODE.matcher(plain.render(ax)).replaceAll("_:x"), BLANK_NODE.matcher(shown.render(ax)).replaceAll("_:x"));
    org.semanticweb.owlapi.model.OWLOntologyID id = o.getOntologyID();
    String ontologyIri = iriText(id.getOntologyIRI());
    String versionIri = iriText(id.getVersionIRI());
    String header = "Ontology(" + (ontologyIri.isEmpty() ? "" : "<" + ontologyIri + ">") + (versionIri.isEmpty() ? "" : " <" + versionIri + ">") + ")";
    out.put("header " + header, header);
    for (OWLAnnotation an : o.getAnnotations()) out.put(an.getAnonymousIndividuals().isEmpty() ? an : "annotation " + BLANK_NODE.matcher(plain.render(an)).replaceAll("_:x"), BLANK_NODE.matcher(shown.render(an)).replaceAll("_:x"));
    for (OWLImportsDeclaration d : o.getImportsDeclarations()) out.put(d, "Import(<" + d.getIRI() + ">)");
    return out;
  }
}
