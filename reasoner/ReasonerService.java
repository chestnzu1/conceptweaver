import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import org.semanticweb.HermiT.Configuration;
import org.semanticweb.HermiT.ReasonerFactory;
import org.semanticweb.owl.explanation.api.Explanation;
import org.semanticweb.owl.explanation.api.ExplanationGenerator;
import org.semanticweb.owl.explanation.api.ExplanationGeneratorFactory;
import org.semanticweb.owl.explanation.api.ExplanationManager;
import org.semanticweb.owl.explanation.api.ExplanationProgressMonitor;
import org.semanticweb.owl.explanation.impl.blackbox.checker.InconsistentOntologyExplanationGeneratorFactory;
import org.semanticweb.owlapi.apibinding.OWLManager;
import org.semanticweb.owlapi.formats.FunctionalSyntaxDocumentFormat;
import org.semanticweb.owlapi.formats.ManchesterSyntaxDocumentFormat;
import org.semanticweb.owlapi.formats.OBODocumentFormat;
import org.semanticweb.owlapi.formats.OWLXMLDocumentFormat;
import org.semanticweb.owlapi.formats.RDFXMLDocumentFormat;
import org.semanticweb.owlapi.formats.TurtleDocumentFormat;
import org.semanticweb.owlapi.io.StringDocumentSource;
import org.semanticweb.owlapi.io.StringDocumentTarget;
import org.semanticweb.owlapi.manchestersyntax.renderer.ManchesterOWLSyntaxOWLObjectRendererImpl;
import org.semanticweb.owlapi.model.IRI;
import org.semanticweb.owlapi.model.MissingImportHandlingStrategy;
import org.semanticweb.owlapi.model.OWLAxiom;
import org.semanticweb.owlapi.model.OWLClass;
import org.semanticweb.owlapi.model.OWLDataFactory;
import org.semanticweb.owlapi.model.OWLDocumentFormat;
import org.semanticweb.owlapi.model.OWLEntity;
import org.semanticweb.owlapi.model.OWLImportsDeclaration;
import org.semanticweb.owlapi.model.OWLNamedIndividual;
import org.semanticweb.owlapi.model.OWLObjectProperty;
import org.semanticweb.owlapi.model.OWLOntology;
import org.semanticweb.owlapi.model.OWLOntologyIRIMapper;
import org.semanticweb.owlapi.model.OWLOntologyLoaderConfiguration;
import org.semanticweb.owlapi.model.OWLOntologyManager;
import org.semanticweb.owlapi.model.parameters.Imports;
import org.semanticweb.owlapi.profiles.OWL2DLProfile;
import org.semanticweb.owlapi.profiles.OWL2ELProfile;
import org.semanticweb.owlapi.profiles.OWLProfileReport;
import org.semanticweb.owlapi.profiles.OWLProfileViolation;
import org.semanticweb.owlapi.reasoner.InferenceType;
import org.semanticweb.owlapi.reasoner.Node;
import org.semanticweb.owlapi.reasoner.NodeSet;
import org.semanticweb.owlapi.reasoner.OWLReasoner;
import org.semanticweb.owlapi.util.AnnotationValueShortFormProvider;
import org.semanticweb.owlapi.util.ShortFormProvider;

/**
 * The OWL 2 DL reasoning service of ConceptWeaver: HermiT behind a small HTTP interface.
 *
 * It is given an ontology as Turtle (and, apart from it, the Turtle of the ontologies it
 * imports), reasons over it with HermiT through the OWL API, and answers with what HermiT found:
 * whether the ontology is consistent, which named classes are unsatisfiable, the inferred class
 * hierarchy and class memberships, and justifications for what is wrong.
 *
 * It keeps nothing: an ontology lives for the length of its request and is never written
 * anywhere. It fetches nothing either: an import whose content was not sent with the request is
 * reported as missing, not looked up on the network.
 *
 *   GET  /health   which reasoner this is
 *   POST /reason   { ontology, imports?: [{ iri, text }], timeoutMs?, explanations?: { max, perSubject, timeoutMs },
 *                    reasoner?: hermit (the default) | elk | auto }: auto uses ELK for an ontology in
 *                  OWL 2 EL and HermiT otherwise, and the answer says which it chose and why
 *   POST /convert  { document, to? }: the document, in any OWL syntax, as Turtle, or as `to` says:
 *                  rdfxml, owlxml, functional or manchester
 *   POST /compare  { original, exported }: the statements in one document and not the other
 *   POST /ai/forward { provider, path, method, body?, key or handle, baseUrl? }: a request of the
 *                  app's assistant, forwarded to the AI provider with the key set on it, and its
 *                  answer streamed back (see forward)
 *   POST /ai/key   { provider, baseUrl?, key }: holds the key in memory for that endpoint, and
 *                  answers with a handle to forward with instead; /ai/key/forget { handle }
 */
public class ReasonerService {
  /** Where an import that was not sent is "found": a file that does not exist, so that it is missing and nothing is fetched. */
  static final String NOT_PROVIDED = "file:/conceptweaver-import-not-provided/";
  static final int MAX_BODY = 64 * 1024 * 1024;
  static final Gson GSON = new Gson();
  static final ExecutorService WORKERS = Executors.newCachedThreadPool(r -> {
    Thread t = new Thread(r, "reasoning");
    t.setDaemon(true);
    return t;
  });
  static final List<String> allowedOrigins = new ArrayList<>();
  /** Whether /ai/forward may reach an endpoint on this machine or the local network (a model server): off unless asked for. */
  static boolean allowLocalAi = false;
  static String hermitVersion = "unknown";
  static String elkVersion = "unknown";
  static String owlapiVersion = "unknown";

  public static void main(String[] args) throws IOException {
    int port = 5190;
    String host = "127.0.0.1";
    for (String a : args) {
      if (a.startsWith("--port=")) port = Integer.parseInt(a.substring(7));
      else if (a.startsWith("--host=")) host = a.substring(7);
      else if (a.startsWith("--allow-origin=")) allowedOrigins.add(a.substring(15));
      else if (a.equals("--allow-local-ai")) allowLocalAi = true;
    }
    hermitVersion = versionOf("net.sourceforge.owlapi/org.semanticweb.hermit");
    elkVersion = versionOf("io.github.liveontologies/elk-owlapi");
    owlapiVersion = versionOf("net.sourceforge.owlapi/owlapi-api");
    HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 16);
    server.createContext("/health", x -> respond(x, 200, health()));
    server.createContext("/reason", ReasonerService::reason);
    server.createContext("/convert", ReasonerService::convert);
    server.createContext("/compare", ReasonerService::compare);
    server.createContext("/ai/forward", ReasonerService::forward);
    server.createContext("/ai/key/forget", ReasonerService::forgetKey);
    server.createContext("/ai/key", ReasonerService::holdKey);
    server.setExecutor(Executors.newCachedThreadPool());
    server.start();
    System.out.println("ConceptWeaver reasoning service: HermiT " + hermitVersion + " (OWL API " + owlapiVersion + ") on http://" + host + ":" + port);
  }

  static String versionOf(String artifact) {
    try (InputStream in = ReasonerService.class.getResourceAsStream("/META-INF/maven/" + artifact + "/pom.properties")) {
      if (in == null) return "unknown";
      Properties p = new Properties();
      p.load(in);
      return p.getProperty("version", "unknown");
    } catch (IOException e) {
      return "unknown";
    }
  }

  static JsonObject health() {
    JsonObject o = new JsonObject();
    o.addProperty("service", "conceptweaver-reasoner");
    o.addProperty("protocol", 1);
    o.addProperty("engine", "HermiT");
    o.addProperty("engineVersion", hermitVersion);
    o.addProperty("owlapi", owlapiVersion);
    o.addProperty("profile", "OWL 2 DL");
    // What else it does besides reasoning: turning an ontology in any OWL syntax into Turtle,
    // and comparing two documents of an ontology statement by statement.
    o.addProperty("converts", true);
    o.addProperty("compares", true);
    o.addProperty("forwardsAi", true);
    // The reasoners /reason can be asked for, beside HermiT, which the fields above name.
    JsonArray reasoners = new JsonArray();
    for (String[] r : new String[][] {{"HermiT", hermitVersion, "OWL 2 DL"}, {"ELK", elkVersion, "OWL 2 EL"}}) {
      JsonObject one = new JsonObject();
      one.addProperty("engine", r[0]);
      one.addProperty("engineVersion", r[1]);
      one.addProperty("covers", r[2]);
      reasoners.add(one);
    }
    o.add("reasoners", reasoners);
    // It holds a key for the assistant, by a handle, so that the page need not (POST /ai/key).
    o.addProperty("holdsAiKeys", true);
    // The syntaxes /convert writes, besides reading every one of them.
    JsonArray writes = new JsonArray();
    for (String w : WRITES) writes.add(w);
    o.add("writes", writes);
    return o;
  }

  // ---------------------------------------------------------------- HTTP

  /** A page of this machine may ask; any other origin only if it was named when the service was started. */
  static boolean allowed(String origin) {
    if (origin == null) return true;
    if (allowedOrigins.contains("*") || allowedOrigins.contains(origin)) return true;
    try {
      String h = URI.create(origin).getHost();
      return h != null && (h.equals("localhost") || h.equals("127.0.0.1") || h.equals("[::1]") || h.equals("::1"));
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

  static void respond(HttpExchange x, int status, JsonObject body) throws IOException {
    String origin = x.getRequestHeaders().getFirst("Origin");
    cors(x);
    if (x.getRequestMethod().equals("OPTIONS")) {
      x.sendResponseHeaders(origin != null && allowed(origin) ? 204 : 403, -1);
      x.close();
      return;
    }
    byte[] bytes = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
    x.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    x.getResponseHeaders().set("Cache-Control", "no-store");
    x.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = x.getResponseBody()) {
      out.write(bytes);
    }
  }

  /** The headers that let an allowed page read the answer. */
  static void cors(HttpExchange x) {
    String origin = x.getRequestHeaders().getFirst("Origin");
    if (origin != null && allowed(origin)) {
      x.getResponseHeaders().set("Access-Control-Allow-Origin", origin);
      x.getResponseHeaders().set("Vary", "Origin");
      x.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      x.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
      x.getResponseHeaders().set("Access-Control-Allow-Private-Network", "true");
      x.getResponseHeaders().set("Access-Control-Max-Age", "600");
    }
  }

  static JsonObject failure(String message) {
    JsonObject o = result();
    o.addProperty("status", "failed");
    o.addProperty("consistency", "unknown");
    strings(o, "errors").add(message);
    return o;
  }

  static void reason(HttpExchange x) throws IOException {
    try {
      if (x.getRequestMethod().equals("OPTIONS")) {
        respond(x, 204, new JsonObject());
        return;
      }
      if (!allowed(x.getRequestHeaders().getFirst("Origin"))) {
        respond(x, 403, failure("This page is not allowed to use the reasoning service. Start the service with --allow-origin=<the page's origin>."));
        return;
      }
      if (!x.getRequestMethod().equals("POST")) {
        respond(x, 405, failure("POST an ontology to /reason."));
        return;
      }
      byte[] sent = body(x);
      if (sent == null) {
        respond(x, 413, failure("The ontology is larger than the service accepts (64 MB)."));
        return;
      }
      JsonObject request;
      try {
        request = GSON.fromJson(new String(sent, StandardCharsets.UTF_8), JsonObject.class);
      } catch (RuntimeException e) {
        request = null;
      }
      if (request == null || !request.has("ontology") || !request.get("ontology").isJsonPrimitive()) {
        respond(x, 400, failure("The request is not JSON with an \"ontology\" in Turtle."));
        return;
      }
      respond(x, 200, run(request));
    } catch (RuntimeException | Error e) {
      // Whatever went wrong, the page is told that reasoning failed; it is never left to assume a result.
      try {
        respond(x, 500, failure("The reasoning service failed: " + e));
      } catch (IOException ignored) {
        x.close();
      }
    }
  }

  /** What was sent, or nothing when it is more than the service takes. */
  static byte[] body(HttpExchange x) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    try (InputStream in = x.getRequestBody()) {
      byte[] chunk = new byte[65536];
      for (int n; (n = in.read(chunk)) > 0; ) {
        buf.write(chunk, 0, n);
        if (buf.size() > MAX_BODY) return null;
      }
    }
    return buf.toByteArray();
  }

  // ---------------------------------------------------------------- reading other syntaxes

  static JsonObject unread(String message) {
    JsonObject o = new JsonObject();
    JsonArray errors = new JsonArray();
    errors.add(message);
    o.add("errors", errors);
    return o;
  }

  /**
   * An ontology in any syntax the OWL API reads (OWL/XML, functional and Manchester syntax, OBO,
   * RDF/XML, Turtle), answered as Turtle with the prefixes it was written with. Only the document
   * itself is read: an import is not fetched, and nothing is reasoned over or kept.
   */
  static void convert(HttpExchange x) throws IOException {
    documents(x, "POST an ontology to /convert.", "The request is not JSON with the \"document\" to read.", new String[] {"document"}, r -> converted(r.get("document").getAsString(), r.has("to") && r.get("to").isJsonPrimitive() ? r.get("to").getAsString() : "turtle"));
  }

  /** The syntaxes a document can be written in, by the names the app gives them. */
  static final String[] WRITES = {"turtle", "rdfxml", "owlxml", "functional", "manchester"};

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

  /**
   * What /convert and /compare have in common as HTTP: a POST of JSON in which each of `fields` is
   * a string, answered with what `answer` makes of it, and as 422 when that is errors only.
   */
  static void documents(HttpExchange x, String usage, String malformed, String[] fields, java.util.function.Function<JsonObject, JsonObject> answer) throws IOException {
    try {
      if (x.getRequestMethod().equals("OPTIONS")) {
        respond(x, 204, new JsonObject());
        return;
      }
      if (!allowed(x.getRequestHeaders().getFirst("Origin"))) {
        respond(x, 403, unread("This page is not allowed to use the OWL service. Start the service with --allow-origin=<the page's origin>."));
        return;
      }
      if (!x.getRequestMethod().equals("POST")) {
        respond(x, 405, unread(usage));
        return;
      }
      byte[] sent = body(x);
      if (sent == null) {
        respond(x, 413, unread("The ontology is larger than the service accepts (64 MB)."));
        return;
      }
      JsonObject request;
      try {
        request = GSON.fromJson(new String(sent, StandardCharsets.UTF_8), JsonObject.class);
      } catch (RuntimeException e) {
        request = null;
      }
      boolean complete = request != null;
      for (String f : fields) complete = complete && request.has(f) && request.get(f).isJsonPrimitive();
      if (!complete) {
        respond(x, 400, unread(malformed));
        return;
      }
      JsonObject out = answer.apply(request);
      respond(x, out.getAsJsonArray("errors").size() == 0 ? 200 : 422, out);
    } catch (RuntimeException | Error e) {
      try {
        respond(x, 500, unread(e instanceof OutOfMemoryError ? "The OWL service ran out of memory reading this ontology." : "The OWL service failed: " + e));
      } catch (IOException ignored) {
        x.close();
      }
    }
  }

  /** A document that could not be read, and why, in words. */
  static class Unreadable extends Exception {
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
    if (into == null) return unread("The OWL service does not write \"" + to + "\": it writes " + String.join(", ", WRITES) + ".");
    OWLOntologyManager manager = OWLManager.createOWLOntologyManager();
    OWLOntology ontology;
    try {
      ontology = read(manager, document);
    } catch (Unreadable e) {
      return unread(e.getMessage());
    }
    try {
      OWLDocumentFormat source = manager.getOntologyFormat(ontology);
      if (source != null && source.isPrefixOWLOntologyFormat() && into.isPrefixOWLOntologyFormat()) into.asPrefixOWLOntologyFormat().copyPrefixesFrom(source.asPrefixOWLOntologyFormat());
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
      return unread("It was read, but could not be written as " + into.getKey() + ": " + firstLines(String.valueOf(e.getMessage()), 3));
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
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?s)Parser: [^\\n]*\\n\\s*(?:Stack trace:\\s*)?(.*?)(?:\\n\\s*\\n|\\z)").matcher(message);
    String found = m.find() ? m.group(1) : message;
    return firstLines(found.replaceAll("(?m)^\\s*at .*$", "").replaceAll("org\\.[A-Za-z.]+\\.([A-Za-z]+Exception):?", "").trim(), 3);
  }

  // ---------------------------------------------------------------- comparing two documents

  /**
   * Two documents of one ontology, as different tools wrote them, compared statement by statement:
   * the axioms, the ontology's IRI and version IRI, its annotations and its imports. What is in
   * one and not the other is listed, each statement written as in functional syntax with the
   * prefixes of the original. Used to measure what a round trip through the app loses.
   */
  static void compare(HttpExchange x) throws IOException {
    documents(x, "POST two documents to /compare.", "The request is not JSON with the \"original\" and the \"exported\" document.", new String[] {"original", "exported"}, r -> compared(r.get("original").getAsString(), r.get("exported").getAsString()));
  }

  static final java.util.regex.Pattern BLANK_NODE = java.util.regex.Pattern.compile("_:[A-Za-z0-9_.-]+");

  static JsonObject compared(String original, String exported) {
    // One manager each: the two documents are usually the same ontology, by the same IRI.
    OWLOntologyManager left = OWLManager.createOWLOntologyManager();
    OWLOntologyManager right = OWLManager.createOWLOntologyManager();
    OWLOntology a;
    OWLOntology b;
    try {
      a = read(left, original);
    } catch (Unreadable e) {
      return unread("The original: " + e.getMessage());
    }
    try {
      b = read(right, exported);
    } catch (Unreadable e) {
      return unread("The export: " + e.getMessage());
    }
    org.semanticweb.owlapi.util.SimpleRenderer shown = new org.semanticweb.owlapi.util.SimpleRenderer();
    shown.setPrefixesFromOntologyFormat(a, left, false);
    org.semanticweb.owlapi.util.SimpleRenderer plain = new org.semanticweb.owlapi.util.SimpleRenderer();
    java.util.Map<Object, String> inA = statements(a, shown, plain);
    java.util.Map<Object, String> inB = statements(b, shown, plain);
    JsonObject out = new JsonObject();
    out.add("errors", new JsonArray());
    out.add("original", described(left, a));
    out.add("exported", described(right, b));
    out.add("removed", only(inA, inB));
    out.add("added", only(inB, inA));
    return out;
  }

  static JsonObject described(OWLOntologyManager manager, OWLOntology o) {
    JsonObject d = new JsonObject();
    OWLDocumentFormat format = manager.getOntologyFormat(o);
    d.addProperty("format", format == null ? "unknown" : format.getKey());
    d.addProperty("axioms", o.getAxiomCount());
    return d;
  }

  /** The statements of `in` that `other` does not have, as they are written, sorted. */
  static JsonArray only(java.util.Map<Object, String> in, java.util.Map<Object, String> other) {
    List<String> missing = new ArrayList<>();
    for (java.util.Map.Entry<Object, String> e : in.entrySet()) if (!other.containsKey(e.getKey())) missing.add(e.getValue());
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
  static java.util.Map<Object, String> statements(OWLOntology o, org.semanticweb.owlapi.util.SimpleRenderer shown, org.semanticweb.owlapi.util.SimpleRenderer plain) {
    java.util.Map<Object, String> out = new java.util.HashMap<>();
    for (OWLAxiom ax : o.getAxioms()) out.put(ax.getAnonymousIndividuals().isEmpty() ? ax : "axiom " + BLANK_NODE.matcher(plain.render(ax)).replaceAll("_:x"), BLANK_NODE.matcher(shown.render(ax)).replaceAll("_:x"));
    org.semanticweb.owlapi.model.OWLOntologyID id = o.getOntologyID();
    String header = "Ontology(" + (id.getOntologyIRI().isPresent() ? "<" + id.getOntologyIRI().get() + ">" : "") + (id.getVersionIRI().isPresent() ? " <" + id.getVersionIRI().get() + ">" : "") + ")";
    out.put("header " + header, header);
    for (org.semanticweb.owlapi.model.OWLAnnotation an : o.getAnnotations()) out.put(an.getAnonymousIndividuals().isEmpty() ? an : "annotation " + BLANK_NODE.matcher(plain.render(an)).replaceAll("_:x"), BLANK_NODE.matcher(shown.render(an)).replaceAll("_:x"));
    for (OWLImportsDeclaration d : o.getImportsDeclarations()) out.put(d, "Import(<" + d.getIRI() + ">)");
    return out;
  }

  // ---------------------------------------------------------------- forwarding the assistant's requests

  /** Where each provider is, fixed: a request for one of them can go nowhere else. */
  static final java.util.Map<String, String> AI_BASES = java.util.Map.of("openai", "https://api.openai.com/v1", "anthropic", "https://api.anthropic.com/v1", "gemini", "https://generativelanguage.googleapis.com/v1beta");
  /** The paths each kind of provider is asked at; nothing else is forwarded. */
  static final java.util.regex.Pattern OPENAI_PATH = java.util.regex.Pattern.compile("^/(chat/completions|models)$");
  static final java.util.regex.Pattern ANTHROPIC_PATH = java.util.regex.Pattern.compile("^/(messages|models)$");
  static final java.util.regex.Pattern GEMINI_PATH = java.util.regex.Pattern.compile("^/models(\\?pageSize=\\d{1,4}|/[A-Za-z0-9._-]{1,120}:streamGenerateContent\\?alt=sse)?$");
  /** How long a connection to a provider may take to be made, and how long its answer may be silent. */
  static final int AI_CONNECT_MS = Integer.getInteger("conceptweaver.ai.connectTimeoutMs", 15_000);
  static final int AI_SILENT_MS = 120_000;

  /** A key the page asked the service to hold, for one endpoint: used for it, never given back. */
  static final class HeldKey {
    final String provider;
    /** The custom endpoint's base URL, without a trailing slash; null for a provider's own. */
    final String base;
    final String key;

    HeldKey(String provider, String base, String key) {
      this.provider = provider;
      this.base = base;
      this.key = key;
    }
  }

  /** The keys held, by an unguessable handle: in this process's memory only, gone when it stops; the oldest go past 64. */
  static final java.util.Map<String, HeldKey> HELD = Collections.synchronizedMap(new java.util.LinkedHashMap<String, HeldKey>() {
    @Override
    protected boolean removeEldestEntry(java.util.Map.Entry<String, HeldKey> eldest) {
      return size() > 64;
    }
  });
  static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();

  /** A request the service will not send, and why: said to the page as 403. */
  static final class AiRefused extends Exception {
    AiRefused(String why) {
      super(why);
    }
  }

  /** Where a request for a provider goes, and which paths it may take, once its endpoint is checked. */
  static final class Endpoint {
    final URI base;
    final java.util.regex.Pattern paths;
    /** A custom endpoint: its addresses are checked before it is asked. */
    final boolean custom;

    Endpoint(URI base, java.util.regex.Pattern paths, boolean custom) {
      this.base = base;
      this.paths = paths;
      this.custom = custom;
    }

    /** As a held key is bound to it: the custom base URL, or null for a provider's own. */
    String bound() {
      return custom ? base.toString() : null;
    }
  }

  static Endpoint endpoint(String provider, String baseUrl) throws AiRefused {
    if (provider.equals("custom")) {
      String why = urlRefused(baseUrl);
      if (why != null) throw new AiRefused(why);
      return new Endpoint(URI.create(baseUrl.trim().replaceAll("/+$", "")), OPENAI_PATH, true);
    }
    if (AI_BASES.containsKey(provider)) return new Endpoint(URI.create(AI_BASES.get(provider)), provider.equals("anthropic") ? ANTHROPIC_PATH : provider.equals("gemini") ? GEMINI_PATH : OPENAI_PATH, false);
    throw new AiRefused("There is no provider \"" + provider + "\" to forward to.");
  }

  static boolean known(String provider) {
    return provider.equals("custom") || AI_BASES.containsKey(provider);
  }

  static boolean keyReads(String key) {
    return key != null && !key.isEmpty() && key.length() <= 1000 && key.matches("[\\x21-\\x7e]+");
  }

  /** The request's JSON, or null. */
  static JsonObject requestJson(HttpExchange x) throws IOException {
    byte[] sent = body(x);
    try {
      return sent == null ? null : GSON.fromJson(new String(sent, StandardCharsets.UTF_8), JsonObject.class);
    } catch (RuntimeException e) {
      return null;
    }
  }

  /** Whether the request may be answered at all: an allowed page, POST. Answers it if not. */
  static boolean admitted(HttpExchange x, String what) throws IOException {
    if (x.getRequestMethod().equals("OPTIONS")) {
      respond(x, 204, new JsonObject());
      return false;
    }
    if (!allowed(x.getRequestHeaders().getFirst("Origin"))) {
      respond(x, 403, unread("This page is not allowed to use the service. Start it with --allow-origin=<the page's origin>."));
      return false;
    }
    if (!x.getRequestMethod().equals("POST")) {
      respond(x, 405, unread("POST a request to " + what + "."));
      return false;
    }
    return true;
  }

  /**
   * Holds a key for one endpoint, in this process's memory, and answers with a handle the page
   * keeps instead of the key (POST /ai/key { provider, baseUrl?, key }); forgets it again
   * (POST /ai/key/forget { handle }). A handle is 256 random bits: it is what lets a request
   * through /ai/forward use the key, for that endpoint only, and the key is never given back.
   * Nothing is written to disk: a key held is gone when the service stops.
   */
  static void holdKey(HttpExchange x) throws IOException {
    try {
      if (!admitted(x, "/ai/key")) return;
      JsonObject r = requestJson(x);
      String provider = text(r, "provider");
      String key = text(r, "key");
      if (provider == null || !known(provider) || !keyReads(key)) {
        respond(x, 400, unread("The request is not JSON with a provider there is and a key that reads as one."));
        return;
      }
      Endpoint e = endpoint(provider, text(r, "baseUrl"));
      if (e.custom && !allowLocalAi) {
        String why = addressRefused(resolve(e.base.getHost()));
        if (why != null) throw new AiRefused(why);
      }
      byte[] bits = new byte[32];
      RANDOM.nextBytes(bits);
      String handle = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bits);
      HELD.put(handle, new HeldKey(provider, e.bound(), key));
      JsonObject o = new JsonObject();
      o.addProperty("handle", handle);
      respond(x, 200, o);
    } catch (AiRefused e) {
      respond(x, 403, unread(e.getMessage()));
    } catch (RuntimeException e) {
      respond(x, 500, unread("The service failed to hold the key."));
    }
  }

  static void forgetKey(HttpExchange x) throws IOException {
    if (!admitted(x, "/ai/key/forget")) return;
    String handle = text(requestJson(x), "handle");
    if (handle != null) HELD.remove(handle);
    respond(x, 200, new JsonObject());
  }

  /**
   * A request of the app's assistant, forwarded to the AI provider it names, and the provider's
   * answer streamed back as it comes. The key comes with the request, or is one the service holds
   * (by its handle, for this endpoint only); the service sets it on the request in the provider's
   * own header and sends it nowhere else: a provider's address is fixed, a custom endpoint has to
   * be https and on the public internet (unless the service was started with --allow-local-ai,
   * for a model server here), the connection is made to the very address that was checked
   * (aiRequest), a redirect is never followed, and only the paths a chat or a list of models needs
   * are forwarded. Nothing of the request is logged or kept.
   */
  static void forward(HttpExchange x) throws IOException {
    AiAnswer answer = null;
    try {
      if (!admitted(x, "/ai/forward")) return;
      JsonObject r = requestJson(x);
      String provider = text(r, "provider");
      String path = text(r, "path");
      String method = text(r, "method");
      String key = text(r, "key");
      String handle = text(r, "handle");
      String content = text(r, "body");
      if (provider == null || path == null || method == null || (key == null && handle == null)) {
        respond(x, 400, unread("The request is not JSON with the provider, path, method and key."));
        return;
      }
      if (key != null && !keyReads(key)) {
        respond(x, 400, unread("The key is empty or has characters a key does not have."));
        return;
      }
      if (!method.equals("GET") && !method.equals("POST")) {
        respond(x, 400, unread("Only GET and POST are forwarded."));
        return;
      }
      if (!known(provider)) {
        respond(x, 400, unread("There is no provider \"" + provider + "\" to forward to."));
        return;
      }
      Endpoint e = endpoint(provider, text(r, "baseUrl"));
      if (key == null) {
        HeldKey held = HELD.get(handle);
        if (held == null) {
          respond(x, 410, unread("The key is no longer held (the service was restarted, or the key was forgotten): enter it again."));
          return;
        }
        if (!held.provider.equals(provider) || !java.util.Objects.equals(held.base, e.bound())) throw new AiRefused("The key the service holds is for another endpoint.");
        key = held.key;
      }
      if (!e.paths.matcher(path).matches()) {
        respond(x, 400, unread("The path " + path + " is not one the assistant asks a provider at."));
        return;
      }
      List<String[]> headers = new ArrayList<>();
      headers.add(new String[] {"Accept", "text/event-stream, application/json"});
      if (provider.equals("anthropic")) {
        headers.add(new String[] {"x-api-key", key});
        headers.add(new String[] {"anthropic-version", "2023-06-01"});
      } else if (provider.equals("gemini")) headers.add(new String[] {"x-goog-api-key", key});
      else headers.add(new String[] {"Authorization", "Bearer " + key});
      byte[] payload = method.equals("POST") ? (content == null ? "{}" : content).getBytes(StandardCharsets.UTF_8) : null;
      if (payload != null) headers.add(new String[] {"Content-Type", "application/json"});
      try {
        answer = aiRequest(URI.create(e.base + path), method, headers, payload, e.custom);
      } catch (java.net.SocketTimeoutException t) {
        respond(x, 504, unread("The provider did not answer in time."));
        return;
      } catch (javax.net.ssl.SSLException t) {
        respond(x, 502, unread("The endpoint's certificate could not be verified for " + e.base.getHost() + ", so nothing was sent to it."));
        return;
      } catch (IOException t) {
        respond(x, 502, unread("The provider could not be reached from this machine (" + e.base.getHost() + ")."));
        return;
      }
      if (answer.status >= 300 && answer.status < 400) {
        respond(x, 502, unread("The endpoint answered with a redirect, which is not followed, so that the key goes nowhere it was not sent."));
        return;
      }
      cors(x);
      x.getResponseHeaders().set("Content-Type", answer.contentType == null ? "application/json" : answer.contentType);
      x.getResponseHeaders().set("Cache-Control", "no-store");
      x.sendResponseHeaders(answer.status, 0);
      try (OutputStream out = x.getResponseBody()) {
        byte[] buf = new byte[8192];
        for (int n; (n = answer.body.read(buf)) > 0; ) {
          out.write(buf, 0, n);
          out.flush();
        }
      }
    } catch (AiRefused e) {
      respond(x, 403, unread(e.getMessage()));
    } catch (RuntimeException e) {
      // Never with the request in it: it holds the key.
      respond(x, 500, unread("The service failed to forward the request."));
    } finally {
      if (answer != null) answer.close();
    }
  }

  static String text(JsonObject o, String field) {
    return o != null && o.has(field) && o.get(field).isJsonPrimitive() ? o.get(field).getAsString() : null;
  }

  /**
   * Why a custom endpoint's base URL is not forwarded to, if it is not: it has to be https (or,
   * with --allow-local-ai, http) with a host and no user name, password, query or fragment.
   */
  static String urlRefused(String base) {
    if (base == null || base.isBlank()) return "A custom endpoint needs its base URL.";
    URI u;
    try {
      u = URI.create(base.trim());
    } catch (IllegalArgumentException e) {
      return "The endpoint's base URL is not a URL.";
    }
    if (u.getUserInfo() != null || u.getQuery() != null || u.getFragment() != null) return "The endpoint's base URL may not hold a user name, password, query or fragment.";
    String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
    if (!scheme.equals("https") && !(scheme.equals("http") && allowLocalAi)) return "The endpoint has to be https. (An http endpoint on this machine is reached when the service is started with --allow-local-ai.)";
    if (u.getHost() == null) return "The endpoint's base URL has no host.";
    return null;
  }

  /** Every address a host has, looked up once. */
  static java.net.InetAddress[] resolve(String host) throws AiRefused {
    try {
      return java.net.InetAddress.getAllByName(host);
    } catch (java.net.UnknownHostException e) {
      throw new AiRefused("The endpoint's host, " + host + ", is not known.");
    }
  }

  /** Why these addresses are not forwarded to, if they are not: any of them on this machine or a private network. */
  static String addressRefused(java.net.InetAddress[] all) {
    for (java.net.InetAddress a : all) {
      byte[] b = a.getAddress();
      boolean uniqueLocal = a instanceof java.net.Inet6Address && (b[0] & 0xfe) == 0xfc;
      boolean shared = b.length == 4 && (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64;
      if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress() || a.isMulticastAddress() || uniqueLocal || shared)
        return "The endpoint is on this machine or a private network, which the service does not forward to unless it is started with --allow-local-ai.";
    }
    return null;
  }

  /** A provider's answer as it comes: its status, its type, and its body, read until it ends. */
  static final class AiAnswer implements AutoCloseable {
    final int status;
    final String contentType;
    final InputStream body;
    final java.net.Socket socket;

    AiAnswer(int status, String contentType, InputStream body, java.net.Socket socket) {
      this.status = status;
      this.contentType = contentType;
      this.body = body;
      this.socket = socket;
    }

    @Override
    public void close() {
      try {
        socket.close();
      } catch (IOException e) {
        // Closed already.
      }
    }
  }

  /**
   * One HTTP/1.1 request to an AI endpoint, made to the address its host was checked to have. The
   * host is looked up once, here; for a custom endpoint every address it has is checked (unless
   * the service was started with --allow-local-ai); and the connection is made to that address,
   * so a name that resolves elsewhere a moment later (DNS rebinding) is not followed. TLS is
   * spoken to the host by its name (SNI), and the certificate is verified for that name. The
   * answer is streamed: chunked or not, and silent for no longer than AI_SILENT_MS.
   */
  static AiAnswer aiRequest(URI target, String method, List<String[]> headers, byte[] payload, boolean check) throws IOException, AiRefused {
    String host = target.getHost();
    boolean tls = "https".equalsIgnoreCase(target.getScheme());
    int port = target.getPort() != -1 ? target.getPort() : tls ? 443 : 80;
    java.net.InetAddress[] all = resolve(host);
    if (check && !allowLocalAi) {
      String why = addressRefused(all);
      if (why != null) throw new AiRefused(why);
    }
    // The address checked, with the host's name kept for TLS: no second lookup is made.
    java.net.InetAddress pinned = java.net.InetAddress.getByAddress(host, all[0].getAddress());
    java.net.Socket socket = new java.net.Socket();
    try {
      socket.connect(new InetSocketAddress(pinned, port), AI_CONNECT_MS);
      socket.setSoTimeout(AI_SILENT_MS);
      java.net.Socket wire = socket;
      if (tls) {
        javax.net.ssl.SSLSocket t = (javax.net.ssl.SSLSocket) ((javax.net.ssl.SSLSocketFactory) javax.net.ssl.SSLSocketFactory.getDefault()).createSocket(socket, host, port, true);
        javax.net.ssl.SSLParameters p = t.getSSLParameters();
        p.setEndpointIdentificationAlgorithm("HTTPS");
        if (!host.startsWith("[") && !host.matches("[0-9.]+")) p.setServerNames(List.of(new javax.net.ssl.SNIHostName(host)));
        t.setSSLParameters(p);
        t.startHandshake();
        wire = t;
      }
      StringBuilder h = new StringBuilder();
      String path = (target.getRawPath() == null || target.getRawPath().isEmpty() ? "/" : target.getRawPath()) + (target.getRawQuery() == null ? "" : "?" + target.getRawQuery());
      h.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
      h.append("Host: ").append(target.getRawAuthority()).append("\r\n");
      for (String[] kv : headers) {
        if (kv[1].indexOf('\r') >= 0 || kv[1].indexOf('\n') >= 0) throw new AiRefused("A header of the request has a line break in it.");
        h.append(kv[0]).append(": ").append(kv[1]).append("\r\n");
      }
      h.append("Accept-Encoding: identity\r\nUser-Agent: ConceptWeaver local service\r\nConnection: close\r\n");
      if (payload != null) h.append("Content-Length: ").append(payload.length).append("\r\n");
      h.append("\r\n");
      OutputStream out = new java.io.BufferedOutputStream(wire.getOutputStream());
      out.write(h.toString().getBytes(StandardCharsets.UTF_8));
      if (payload != null) out.write(payload);
      out.flush();
      InputStream in = new java.io.BufferedInputStream(wire.getInputStream());
      int status;
      java.util.Map<String, String> got;
      do {
        String line = httpLine(in);
        if (line == null || !line.matches("HTTP/1\\.[01] \\d{3}.*")) throw new IOException("What answered is not HTTP.");
        status = Integer.parseInt(line.substring(9, 12));
        got = new java.util.HashMap<>();
        for (String l; (l = httpLine(in)) != null && !l.isEmpty(); ) {
          int colon = l.indexOf(':');
          if (colon > 0) got.put(l.substring(0, colon).trim().toLowerCase(), l.substring(colon + 1).trim());
        }
      } while (status >= 100 && status < 200);
      InputStream body;
      if ("chunked".equalsIgnoreCase(got.get("transfer-encoding"))) body = new Chunked(in);
      else if (got.containsKey("content-length")) body = new Limited(in, Long.parseLong(got.get("content-length")));
      else body = in;
      return new AiAnswer(status, got.get("content-type"), body, wire);
    } catch (IOException | AiRefused | RuntimeException e) {
      socket.close();
      throw e;
    }
  }

  /** A line of an HTTP head, without its line break; null at the end. */
  static String httpLine(InputStream in) throws IOException {
    ByteArrayOutputStream line = new ByteArrayOutputStream();
    for (int c; (c = in.read()) != -1; ) {
      if (c == '\n') return line.toString(StandardCharsets.ISO_8859_1).replaceAll("\r$", "");
      if (line.size() > 65_536) throw new IOException("A line of the answer's head is too long.");
      line.write(c);
    }
    return line.size() == 0 ? null : line.toString(StandardCharsets.ISO_8859_1);
  }

  /** A body sent in chunks, read as the bytes it is. */
  static final class Chunked extends InputStream {
    final InputStream in;
    long left = 0;
    boolean ended = false;

    Chunked(InputStream in) {
      this.in = in;
    }

    @Override
    public int read() throws IOException {
      byte[] one = new byte[1];
      return read(one, 0, 1) <= 0 ? -1 : one[0] & 0xff;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
      if (ended) return -1;
      if (left == 0) {
        String size = httpLine(in);
        if (size == null) throw new java.io.EOFException();
        int semi = size.indexOf(';');
        left = Long.parseLong((semi >= 0 ? size.substring(0, semi) : size).trim(), 16);
        if (left == 0) {
          while (true) {
            String trailer = httpLine(in);
            if (trailer == null || trailer.isEmpty()) break;
          }
          ended = true;
          return -1;
        }
      }
      int n = in.read(b, off, (int) Math.min(len, left));
      if (n < 0) throw new java.io.EOFException();
      left -= n;
      if (left == 0) httpLine(in);
      return n;
    }
  }

  /** A body of a known length. */
  static final class Limited extends InputStream {
    final InputStream in;
    long left;

    Limited(InputStream in, long length) {
      this.in = in;
      this.left = length;
    }

    @Override
    public int read() throws IOException {
      if (left <= 0) return -1;
      int c = in.read();
      if (c >= 0) left--;
      return c;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
      if (left <= 0) return -1;
      int n = in.read(b, off, (int) Math.min(len, left));
      if (n > 0) left -= n;
      return n;
    }
  }

  // ---------------------------------------------------------------- reasoning

  static JsonObject result() {
    JsonObject o = new JsonObject();
    o.addProperty("engine", "HermiT");
    o.addProperty("engineVersion", hermitVersion);
    o.addProperty("owlapi", owlapiVersion);
    o.add("errors", new JsonArray());
    o.add("warnings", new JsonArray());
    return o;
  }

  static JsonArray strings(JsonObject o, String key) {
    return o.getAsJsonArray(key);
  }

  static int intOf(JsonObject o, String key, int fallback) {
    JsonElement e = o == null ? null : o.get(key);
    return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsInt() : fallback;
  }

  static JsonObject run(JsonObject request) {
    long t0 = System.nanoTime();
    int timeoutMs = Math.max(1000, Math.min(600_000, intOf(request, "timeoutMs", 60_000)));
    AtomicReference<OWLReasoner> running = new AtomicReference<>();
    JsonObject out = result();
    Future<?> job = WORKERS.submit(() -> work(request, out, running));
    try {
      job.get(timeoutMs, TimeUnit.MILLISECONDS);
    } catch (TimeoutException e) {
      OWLReasoner r = running.get();
      if (r != null) r.interrupt();
      job.cancel(true);
      synchronized (out) {
        // Whatever had been worked out is not shown: half a classification reads like a whole one.
        for (String k : new String[] {"unsatisfiable", "subclasses", "equivalents", "types", "same", "relations", "explanations"}) out.remove(k);
        out.addProperty("status", "failed");
        if (!out.has("consistency")) out.addProperty("consistency", "unknown");
        strings(out, "errors").add("Reasoning was stopped after " + (timeoutMs / 1000) + " seconds without finishing.");
      }
    } catch (Exception e) {
      Throwable cause = e.getCause() == null ? e : e.getCause();
      synchronized (out) {
        out.addProperty("status", "failed");
        if (!out.has("consistency")) out.addProperty("consistency", "unknown");
        strings(out, "errors").add(describe(cause));
      }
    }
    synchronized (out) {
      out.addProperty("ms", (System.nanoTime() - t0) / 1_000_000);
      // What the answer was worked out under: the time it was allowed, and the heap it had.
      JsonObject limits = new JsonObject();
      limits.addProperty("timeoutMs", timeoutMs);
      limits.addProperty("maxHeapMb", Runtime.getRuntime().maxMemory() / (1024 * 1024));
      out.add("limits", limits);
      return out.deepCopy();
    }
  }

  /** Something the service will not go on with, already said in words. */
  static class Refused extends RuntimeException {
    Refused(String message) {
      super(message);
    }
  }

  /** What went wrong, in words a modeller can act on. */
  static String describe(Throwable e) {
    if (e instanceof Refused) return e.getMessage();
    String name = e.getClass().getSimpleName();
    String message = e.getMessage() == null ? "" : e.getMessage().trim();
    if (name.contains("UnsupportedDatatype")) return "HermiT does not support a datatype this ontology uses: " + message;
    if (name.toLowerCase().contains("pars") || name.contains("UnloadableImport") || name.contains("Ontology")) return "The ontology could not be read as OWL: " + parseProblem(message);
    if (e instanceof OutOfMemoryError) return "The reasoner ran out of memory on this ontology.";
    if (e instanceof IllegalArgumentException) return "HermiT cannot reason over this ontology: " + firstLines(message, 4);
    return name + (message.isEmpty() ? "" : ": " + firstLines(message, 4));
  }

  /** What the Turtle parser objected to, without the list of every other format that was not tried. */
  static String parseProblem(String message) {
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?s)Parser: org\\.semanticweb\\.owlapi\\.rdf\\.turtle\\.parser\\.TurtleOntologyParser.*?\\n\\s*(?:Stack trace:\\s*)?(.*?)(?:\\n\\s*\\n|\\z)").matcher(message);
    String found = m.find() ? m.group(1) : message;
    return firstLines(found.replaceAll("(?m)^\\s*at .*$", "").replaceAll("org\\.semanticweb\\.[A-Za-z.]+\\.([A-Za-z]+Exception):?", "").trim(), 3);
  }

  static String firstLines(String s, int n) {
    String[] lines = s.split("\\R");
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < lines.length && i < n; i++) b.append(i > 0 ? " " : "").append(lines[i].trim());
    return b.length() > 600 ? b.substring(0, 600) + "…" : b.toString();
  }

  static void work(JsonObject request, JsonObject out, AtomicReference<OWLReasoner> running) {
    OWLOntologyManager manager = OWLManager.createOWLOntologyManager();
    OWLDataFactory df = manager.getOWLDataFactory();
    // An import that was not sent with the request is not fetched: its address is mapped to one nothing can be loaded from.
    manager.getIRIMappers().add((OWLOntologyIRIMapper) iri -> IRI.create(NOT_PROVIDED + Integer.toHexString(iri.toString().hashCode())));
    OWLOntologyLoaderConfiguration config = new OWLOntologyLoaderConfiguration().setMissingImportHandlingStrategy(MissingImportHandlingStrategy.SILENT);

    JsonArray provided = request.has("imports") && request.get("imports").isJsonArray() ? request.getAsJsonArray("imports") : new JsonArray();
    int n = 0;
    for (JsonElement e : provided) {
      JsonObject imp = e.getAsJsonObject();
      String text = imp.get("text").getAsString();
      String name = imp.has("iri") ? imp.get("iri").getAsString() : "import " + (n + 1);
      try {
        manager.loadOntologyFromOntologyDocument(new StringDocumentSource(text, IRI.create("urn:conceptweaver:import:" + (n++)), new TurtleDocumentFormat(), null), config);
      } catch (Exception ex) {
        synchronized (out) {
          strings(out, "warnings").add("The imported ontology <" + name + "> could not be read and is left out: " + firstLines(String.valueOf(ex.getMessage()), 2));
        }
      }
    }
    OWLOntology ontology;
    try {
      ontology = manager.loadOntologyFromOntologyDocument(new StringDocumentSource(request.get("ontology").getAsString(), IRI.create("urn:conceptweaver:ontology"), new TurtleDocumentFormat(), null), config);
    } catch (Exception e) {
      throw new Refused(describe(e));
    }

    // What it imports, and which of those it was given.
    JsonArray resolved = new JsonArray();
    JsonArray missing = new JsonArray();
    for (OWLOntology o : ontology.getImportsClosure()) {
      for (OWLImportsDeclaration d : o.getImportsDeclarations()) {
        boolean there = manager.getImportedOntology(d) != null;
        JsonArray list = there ? resolved : missing;
        if (!contains(list, d.getIRI().toString())) list.add(d.getIRI().toString());
      }
    }
    Set<OWLAxiom> logical = new HashSet<>(ontology.getLogicalAxioms(Imports.INCLUDED));
    ShortFormProvider names = names(manager, df);
    synchronized (out) {
      JsonObject imports = new JsonObject();
      imports.add("resolved", resolved);
      imports.add("missing", missing);
      out.add("imports", imports);
      out.addProperty("axioms", ontology.getAxiomCount(Imports.INCLUDED));
      out.addProperty("logicalAxioms", logical.size());
      for (JsonElement m : missing) strings(out, "warnings").add("The imported ontology <" + m.getAsString() + "> was not available, so its axioms are not part of this result.");
    }

    // Whether this is OWL 2 DL at all. Something used without being declared (an annotation property
    // such as skos:definition, most often) is read as what its use implies and changes no axiom, so it
    // is counted apart from what really puts the ontology outside OWL 2 DL.
    OWLProfileReport report = new OWL2DLProfile().checkOntology(ontology);
    JsonObject profile = new JsonObject();
    JsonArray violations = new JsonArray();
    Set<String> seen = new HashSet<>();
    Set<String> undeclared = new TreeSet<>();
    int outside = 0;
    ManchesterOWLSyntaxOWLObjectRendererImpl plain = new ManchesterOWLSyntaxOWLObjectRendererImpl();
    plain.setShortFormProvider(names);
    for (OWLProfileViolation v : report.getViolations()) {
      String kind = v.getClass().getSimpleName();
      if (kind.startsWith("UseOfUndeclared")) {
        Object what = v.getExpression();
        undeclared.add(what instanceof OWLEntity ? names.getShortForm((OWLEntity) what) : String.valueOf(what));
        continue;
      }
      // What kind of violation, in words, and the axiom it is in, as the modeller would write it.
      String rule = v.toString().replaceAll("\\s+", " ").trim();
      int cut = rule.indexOf(" [");
      if (cut > 0) rule = rule.substring(0, cut);
      rule = rule.replaceAll(":? ?<[^>]*>|:? ?[A-Z][A-Za-z]+\\(.*$", "").trim();
      OWLAxiom axiom = v.getAxiom();
      String text = axiom == null ? "" : plain.render(axiom).replaceAll("\\s+", " ").trim();
      if (!seen.add(rule + "|" + text)) continue;
      outside++;
      if (violations.size() >= 40) continue;
      JsonObject o = new JsonObject();
      o.addProperty("rule", rule);
      o.addProperty("text", text);
      o.add("entities", axiom == null ? new JsonArray() : entities(axiom, names));
      violations.add(o);
    }
    JsonArray undeclaredNames = new JsonArray();
    for (String u : undeclared) if (undeclaredNames.size() < 40) undeclaredNames.add(u);
    profile.addProperty("owl2dl", outside == 0);
    profile.add("violations", violations);
    profile.addProperty("violationCount", outside);
    profile.add("undeclared", undeclaredNames);
    profile.addProperty("undeclaredCount", undeclared.size());
    // Whether it is in OWL 2 EL, the profile ELK is complete for. Undeclared entities are left out of
    // this count as of the one above: they change no axiom.
    int outsideEl = 0;
    String firstOutsideEl = null;
    for (OWLProfileViolation v : new OWL2ELProfile().checkOntology(ontology).getViolations()) {
      if (v.getClass().getSimpleName().startsWith("UseOfUndeclared")) continue;
      outsideEl++;
      if (firstOutsideEl == null) {
        OWLAxiom axiom = v.getAxiom();
        String rule = v.toString().replaceAll("\\s+", " ").trim();
        int cut = rule.indexOf(" [");
        if (cut > 0) rule = rule.substring(0, cut);
        rule = rule.replaceAll(":? ?<[^>]*>|:? ?[A-Z][A-Za-z]+\\(.*$", "").trim();
        firstOutsideEl = rule + (axiom == null ? "" : ", in " + plain.render(axiom).replaceAll("\\s+", " ").trim());
      }
    }
    profile.addProperty("owl2el", outsideEl == 0);
    profile.addProperty("elViolationCount", outsideEl);
    synchronized (out) {
      out.add("profile", profile);
    }

    // Which reasoner: the one asked for, or, asked to choose, ELK for an ontology in OWL 2 EL and HermiT otherwise.
    String requested = request.has("reasoner") && request.get("reasoner").isJsonPrimitive() ? request.get("reasoner").getAsString() : "hermit";
    if (!requested.equals("auto") && !requested.equals("elk") && !requested.equals("hermit")) throw new Refused("There is no reasoner \"" + requested + "\": ask for hermit, elk or auto.");
    boolean useElk = requested.equals("elk") || (requested.equals("auto") && outsideEl == 0);
    JsonObject choice = new JsonObject();
    choice.addProperty("requested", requested);
    choice.addProperty("reasoner", useElk ? "ELK" : "HermiT");
    choice.addProperty("why", requested.equals("auto")
        ? (useElk ? "Chosen automatically: the ontology is in OWL 2 EL, for which ELK is complete and fast." : "Chosen automatically: the ontology is not in OWL 2 EL (" + outsideEl + " axiom" + (outsideEl == 1 ? "" : "s") + " outside it, first: " + firstOutsideEl + "), so HermiT, which covers OWL 2 DL.")
        : (useElk ? "ELK, as asked." : "HermiT, as asked."));
    synchronized (out) {
      out.add("choice", choice);
    }
    if (useElk) {
      elk(ontology, out, running, missing.size() == 0);
      return;
    }

    ReasonerFactory factory = new ReasonerFactory();
    Configuration hermit = new Configuration();
    OWLReasoner reasoner;
    boolean opaque = false;
    try {
      reasoner = factory.createReasoner(ontology, hermit);
    } catch (RuntimeException e) {
      if (!e.getClass().getSimpleName().contains("UnsupportedDatatype")) throw e;
      // A datatype outside the OWL 2 datatype map, such as xsd:date. HermiT has no semantics for it. Rather
      // than give up, it is asked to take such a datatype as one it knows nothing about: its values
      // are then neither checked nor compared, and the page is told that this result is partial.
      opaque = true;
      hermit = new Configuration();
      hermit.ignoreUnsupportedDatatypes = true;
      reasoner = factory.createReasoner(ontology, hermit);
      java.util.regex.Matcher m = java.util.regex.Pattern.compile("datatype '([^']+)'").matcher(String.valueOf(e.getMessage()));
      String which = m.find() ? m.group(1).replace("http://www.w3.org/2001/XMLSchema#", "xsd:") : "A datatype";
      synchronized (out) {
        strings(out, "warnings").add(which + " is not in the OWL 2 datatype map (xsd:date, xsd:time, xsd:gYear and xsd:duration are not). HermiT took every such datatype as one it knows nothing about: its values are not checked or compared.");
      }
    }
    final Configuration used = hermit;
    ReasonerFactory explaining = new ReasonerFactory() {
      @Override
      public OWLReasoner createReasoner(OWLOntology o) {
        return super.createReasoner(o, used);
      }

      @Override
      public OWLReasoner createNonBufferingReasoner(OWLOntology o) {
        return super.createNonBufferingReasoner(o, used);
      }
    };
    running.set(reasoner);
    try {
      boolean consistent = reasoner.isConsistent();
      synchronized (out) {
        out.addProperty("consistency", consistent ? "consistent" : "inconsistent");
      }
      JsonObject wanted = request.has("explanations") && request.get("explanations").isJsonObject() ? request.getAsJsonObject("explanations") : null;
      int perSubject = Math.max(0, Math.min(5, intOf(wanted, "perSubject", 1)));
      int maxSubjects = Math.max(0, Math.min(200, intOf(wanted, "max", 25)));
      long budget = Math.max(0, Math.min(300_000, intOf(wanted, "timeoutMs", 20_000)));
      JsonArray explanations = new JsonArray();

      if (!consistent) {
        // From a contradiction everything follows, so there is no hierarchy to report: only why.
        if (perSubject > 0) {
          OWLAxiom entailment = df.getOWLSubClassOfAxiom(df.getOWLThing(), df.getOWLNothing());
          explanations.add(explain("inconsistent", null, entailment, new InconsistentOntologyExplanationGeneratorFactory(explaining, budget), ontology, perSubject, System.currentTimeMillis() + budget, names, df));
        }
        synchronized (out) {
          out.add("explanations", explanations);
          // An inconsistency that was found is one, whatever else about the ontology is outside OWL 2 DL.
          out.addProperty("status", "complete");
        }
        return;
      }

      reasoner.precomputeInferences(InferenceType.CLASS_HIERARCHY, InferenceType.CLASS_ASSERTIONS);
      List<OWLClass> classes = sorted(ontology.getClassesInSignature(Imports.INCLUDED));
      Set<OWLClass> unsat = reasoner.getUnsatisfiableClasses().getEntitiesMinusBottom();
      JsonArray unsatisfiable = new JsonArray();
      for (OWLClass c : sorted(unsat)) unsatisfiable.add(c.getIRI().toString());

      // The inferred hierarchy of the classes that can have members: each with the classes directly above it.
      JsonArray subclasses = new JsonArray();
      JsonArray equivalents = new JsonArray();
      Set<String> grouped = new HashSet<>();
      for (OWLClass c : classes) {
        if (c.isOWLThing() || c.isOWLNothing() || unsat.contains(c)) continue;
        Node<OWLClass> same = reasoner.getEquivalentClasses(c);
        if (same.getSize() > 1 && !same.isTopNode()) {
          List<OWLClass> group = sorted(same.getEntities());
          if (grouped.add(group.get(0).getIRI().toString())) {
            JsonArray g = new JsonArray();
            for (OWLClass e : group) g.add(e.getIRI().toString());
            equivalents.add(g);
          }
        } else if (same.isTopNode()) {
          JsonArray g = new JsonArray();
          g.add(c.getIRI().toString());
          g.add(df.getOWLThing().getIRI().toString());
          equivalents.add(g);
        }
        for (OWLClass sup : sorted(reasoner.getSuperClasses(c, true).getFlattened())) {
          if (sup.isOWLThing()) continue;
          JsonObject pair = new JsonObject();
          pair.addProperty("sub", c.getIRI().toString());
          pair.addProperty("sup", sup.getIRI().toString());
          subclasses.add(pair);
        }
      }

      // What each individual is, most specifically; and which individuals are one and the same.
      List<OWLNamedIndividual> individuals = sorted(ontology.getIndividualsInSignature(Imports.INCLUDED));
      JsonArray types = new JsonArray();
      JsonArray sameIndividuals = new JsonArray();
      Set<String> sameSeen = new HashSet<>();
      for (OWLNamedIndividual i : individuals) {
        for (OWLClass c : sorted(reasoner.getTypes(i, true).getFlattened())) {
          if (c.isOWLThing()) continue;
          JsonObject pair = new JsonObject();
          pair.addProperty("individual", i.getIRI().toString());
          pair.addProperty("class", c.getIRI().toString());
          types.add(pair);
        }
        Node<OWLNamedIndividual> same = reasoner.getSameIndividuals(i);
        if (same.getSize() > 1) {
          List<OWLNamedIndividual> group = sorted(same.getEntities());
          if (sameSeen.add(group.get(0).getIRI().toString())) {
            JsonArray g = new JsonArray();
            for (OWLNamedIndividual e : group) g.add(e.getIRI().toString());
            sameIndividuals.add(g);
          }
        }
      }

      // Which individuals are related by which object property. One question to the reasoner for each
      // individual and property, so it is only asked of an ontology small enough for that.
      JsonArray relations = new JsonArray();
      List<OWLObjectProperty> properties = sorted(ontology.getObjectPropertiesInSignature(Imports.INCLUDED));
      boolean relationsAsked = (long) individuals.size() * properties.size() <= 4000;
      if (relationsAsked) {
        reasoner.precomputeInferences(InferenceType.OBJECT_PROPERTY_ASSERTIONS);
        for (OWLNamedIndividual i : individuals) {
          for (OWLObjectProperty p : properties) {
            if (p.isOWLTopObjectProperty() || p.isOWLBottomObjectProperty()) continue;
            for (OWLNamedIndividual o : sorted(reasoner.getObjectPropertyValues(i, p).getFlattened())) {
              JsonObject triple = new JsonObject();
              triple.addProperty("subject", i.getIRI().toString());
              triple.addProperty("property", p.getIRI().toString());
              triple.addProperty("object", o.getIRI().toString());
              relations.add(triple);
            }
          }
        }
      }

      synchronized (out) {
        out.add("unsatisfiable", unsatisfiable);
        out.add("subclasses", subclasses);
        out.add("equivalents", equivalents);
        out.add("types", types);
        out.add("same", sameIndividuals);
        if (relationsAsked) out.add("relations", relations);
        else strings(out, "warnings").add("Inferred relationships between individuals were not worked out: with " + individuals.size() + " individuals and " + properties.size() + " object properties that is too many questions to ask.");
      }

      // Why each unsatisfiable class is one, as far as the time for it goes.
      if (perSubject > 0) {
        long deadline = System.currentTimeMillis() + budget;
        ExplanationGeneratorFactory<OWLAxiom> generators = ExplanationManager.createExplanationGeneratorFactory(explaining);
        int done = 0;
        for (OWLClass c : sorted(unsat)) {
          if (done++ >= maxSubjects || System.currentTimeMillis() >= deadline) {
            JsonObject skipped = new JsonObject();
            skipped.addProperty("kind", "unsatisfiable");
            skipped.addProperty("subject", c.getIRI().toString());
            skipped.add("justifications", new JsonArray());
            skipped.addProperty("note", done > maxSubjects ? "No justification was asked for: there are more unsatisfiable classes than are explained in one run." : "No justification was worked out: the time allowed for explanations had run out.");
            explanations.add(skipped);
            continue;
          }
          explanations.add(explain("unsatisfiable", c, df.getOWLSubClassOfAxiom(c, df.getOWLNothing()), generators, ontology, perSubject, deadline, names, df));
        }
      }
      synchronized (out) {
        out.add("explanations", explanations);
        // Outside OWL 2 DL the reasoner's answers are what it could work out, not a guarantee.
        out.addProperty("status", outside == 0 && !opaque && missing.size() == 0 ? "complete" : "partial");
      }
    } finally {
      running.set(null);
      reasoner.dispose();
    }
  }

  /**
   * Reasons with ELK: consistency, unsatisfiable classes, the inferred hierarchy and the most
   * specific classes of each individual. ELK is complete for OWL 2 EL and leaves out what it does not
   * support; each of its answers carries a monitor of what it left out, so the result is complete
   * only where none of them reports anything, and otherwise says, in ELK's words, what was left out.
   * Which individuals are the same, how individuals are related, and justifications are HermiT's.
   */
  static void elk(OWLOntology ontology, JsonObject out, AtomicReference<OWLReasoner> running, boolean importsHere) {
    org.semanticweb.elk.owlapi.ElkReasoner reasoner = (org.semanticweb.elk.owlapi.ElkReasoner) new org.semanticweb.elk.owlapi.ElkReasonerFactory().createReasoner(ontology);
    synchronized (out) {
      out.addProperty("engine", "ELK");
      out.addProperty("engineVersion", elkVersion);
    }
    running.set(reasoner);
    List<org.semanticweb.elk.reasoner.completeness.IncompletenessMonitor> monitors = new ArrayList<>();
    try {
      boolean consistent = reasoner.isConsistent();
      synchronized (out) {
        out.addProperty("consistency", consistent ? "consistent" : "inconsistent");
      }
      if (!consistent) {
        synchronized (out) {
          out.add("explanations", new JsonArray());
          strings(out, "warnings").add("ELK found a contradiction, and gives no justification for it: ask HermiT to see why.");
          // ELK is sound: a contradiction it finds is one.
          out.addProperty("status", "complete");
        }
        return;
      }
      org.semanticweb.elk.reasoner.completeness.IncompleteResult<Node<OWLClass>> bottom = reasoner.computeUnsatisfiableClasses();
      monitors.add(bottom.getIncompletenessMonitor());
      Set<OWLClass> unsat = org.semanticweb.elk.reasoner.completeness.Incompleteness.getValue(bottom).getEntitiesMinusBottom();
      JsonArray unsatisfiable = new JsonArray();
      for (OWLClass c : sorted(unsat)) unsatisfiable.add(c.getIRI().toString());

      JsonArray subclasses = new JsonArray();
      JsonArray equivalents = new JsonArray();
      Set<String> grouped = new HashSet<>();
      for (OWLClass c : sorted(ontology.getClassesInSignature(Imports.INCLUDED))) {
        if (c.isOWLThing() || c.isOWLNothing() || unsat.contains(c)) continue;
        org.semanticweb.elk.reasoner.completeness.IncompleteResult<Node<OWLClass>> sameR = reasoner.computeEquivalentClasses(c);
        monitors.add(sameR.getIncompletenessMonitor());
        Node<OWLClass> same = org.semanticweb.elk.reasoner.completeness.Incompleteness.getValue(sameR);
        if (same.getSize() > 1 && !same.isTopNode()) {
          List<OWLClass> group = sorted(same.getEntities());
          if (grouped.add(group.get(0).getIRI().toString())) {
            JsonArray g = new JsonArray();
            for (OWLClass e : group) g.add(e.getIRI().toString());
            equivalents.add(g);
          }
        }
        org.semanticweb.elk.reasoner.completeness.IncompleteResult<NodeSet<OWLClass>> upR = reasoner.computeSuperClasses(c, true);
        monitors.add(upR.getIncompletenessMonitor());
        for (OWLClass sup : sorted(org.semanticweb.elk.reasoner.completeness.Incompleteness.getValue(upR).getFlattened())) {
          if (sup.isOWLThing()) continue;
          JsonObject pair = new JsonObject();
          pair.addProperty("sub", c.getIRI().toString());
          pair.addProperty("sup", sup.getIRI().toString());
          subclasses.add(pair);
        }
      }
      List<OWLNamedIndividual> individuals = sorted(ontology.getIndividualsInSignature(Imports.INCLUDED));
      JsonArray types = new JsonArray();
      for (OWLNamedIndividual i : individuals) {
        org.semanticweb.elk.reasoner.completeness.IncompleteResult<NodeSet<OWLClass>> typesR = reasoner.computeTypes(i, true);
        monitors.add(typesR.getIncompletenessMonitor());
        for (OWLClass c : sorted(org.semanticweb.elk.reasoner.completeness.Incompleteness.getValue(typesR).getFlattened())) {
          if (c.isOWLThing()) continue;
          JsonObject pair = new JsonObject();
          pair.addProperty("individual", i.getIRI().toString());
          pair.addProperty("class", c.getIRI().toString());
          types.add(pair);
        }
      }
      // What ELK says it left out, once for each kind of answer, in its own words.
      Set<String> leftOut = new java.util.LinkedHashSet<>();
      Set<org.semanticweb.elk.reasoner.completeness.IncompletenessMonitor> said = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
      boolean incomplete = false;
      for (org.semanticweb.elk.reasoner.completeness.IncompletenessMonitor m : monitors) {
        if (!m.isIncompletenessDetected()) continue;
        incomplete = true;
        if (said.add(m)) m.logStatus(capturing(leftOut));
      }
      synchronized (out) {
        out.add("unsatisfiable", unsatisfiable);
        out.add("subclasses", subclasses);
        out.add("equivalents", equivalents);
        out.add("types", types);
        out.add("explanations", new JsonArray());
        JsonArray warnings = strings(out, "warnings");
        if (incomplete) {
          warnings.add("ELK covers OWL 2 EL and left out what it does not support, so its answer may be missing entailments" + (leftOut.isEmpty() ? "." : ":"));
          // ELK's own lines, without what only its log could act on ("Enable DEBUG for details") and
          // without the heading each count already says.
          int n = 0;
          for (String line : leftOut) {
            String l = line.replaceAll("\\s*Enable (INFO|DEBUG|TRACE) for details\\.?", "").replace('!', '.').trim();
            if (l.isEmpty() || l.startsWith("Potential incompleteness due to") || l.equals("Ontology satisfiability cannot be checked.")) continue;
            if (n++ < 12) warnings.add(l);
          }
        }
        if (!individuals.isEmpty()) warnings.add("ELK does not work out which individuals are the same or how individuals are related: HermiT does.");
        if (!unsat.isEmpty()) warnings.add("ELK gives no justification for an unsatisfiable class: ask HermiT to see why.");
        out.addProperty("status", !incomplete && importsHere ? "complete" : "partial");
      }
    } finally {
      running.set(null);
      reasoner.dispose();
    }
  }

  /** A logger that keeps what is said to it, for what ELK reports of itself: nothing of it reaches the console. */
  static org.slf4j.Logger capturing(Set<String> lines) {
    return (org.slf4j.Logger) java.lang.reflect.Proxy.newProxyInstance(ReasonerService.class.getClassLoader(), new Class<?>[] {org.slf4j.Logger.class}, (proxy, method, args) -> {
      String name = method.getName();
      if (name.startsWith("is") && name.endsWith("Enabled")) return true;
      if (name.equals("getName")) return "conceptweaver.elk";
      if ((name.equals("info") || name.equals("warn")) && args != null) {
        int at = args.length > 0 && args[0] instanceof org.slf4j.Marker ? 1 : 0;
        if (at < args.length && args[at] instanceof String) {
          Object[] rest = java.util.Arrays.copyOfRange(args, at + 1, args.length);
          if (rest.length == 1 && rest[0] instanceof Object[]) rest = (Object[]) rest[0];
          String line = org.slf4j.helpers.MessageFormatter.arrayFormat((String) args[at], rest).getMessage();
          if (line != null && !line.isBlank()) lines.add(line.trim());
        }
      }
      return null;
    });
  }

  /** The entities an axiom is about, for finding them in the editor. */
  static JsonArray entities(OWLAxiom a, ShortFormProvider names) {
    JsonArray entities = new JsonArray();
    for (OWLEntity en : sorted(a.getSignature())) {
      if (en.isBuiltIn()) continue;
      JsonObject ref = new JsonObject();
      ref.addProperty("iri", en.getIRI().toString());
      ref.addProperty("kind", en.getEntityType().getName());
      ref.addProperty("name", names.getShortForm(en));
      entities.add(ref);
    }
    return entities;
  }

  static boolean contains(JsonArray list, String s) {
    for (JsonElement e : list) if (e.getAsString().equals(s)) return true;
    return false;
  }

  static <T extends OWLEntity> List<T> sorted(Set<T> set) {
    List<T> list = new ArrayList<>(set);
    list.sort(Comparator.comparing(e -> e.getIRI().toString()));
    return list;
  }

  // ---------------------------------------------------------------- explanations

  static final String[][] VOCABULARIES = {
    {"xsd", "http://www.w3.org/2001/XMLSchema#"},
    {"rdfs", "http://www.w3.org/2000/01/rdf-schema#"},
    {"rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#"},
    {"owl", "http://www.w3.org/2002/07/owl#"},
    {"skos", "http://www.w3.org/2004/02/skos/core#"},
    {"dcterms", "http://purl.org/dc/terms/"},
    {"dc", "http://purl.org/dc/elements/1.1/"},
    {"dcat", "http://www.w3.org/ns/dcat#"},
    {"prov", "http://www.w3.org/ns/prov#"},
    {"foaf", "http://xmlns.com/foaf/0.1/"},
  };

  /** Entities by their label where they have one, as a modeller knows them; quoted when a name is more than one word. */
  static ShortFormProvider names(OWLOntologyManager manager, OWLDataFactory df) {
    ShortFormProvider labels = new AnnotationValueShortFormProvider(Collections.singletonList(df.getRDFSLabel()), Collections.emptyMap(), manager);
    return new ShortFormProvider() {
      @Override
      public String getShortForm(OWLEntity entity) {
        String iri = entity.getIRI().toString();
        if (entity.isBuiltIn()) return iri.startsWith("http://www.w3.org/2001/XMLSchema#") ? "xsd:" + entity.getIRI().getShortForm() : "owl:" + entity.getIRI().getShortForm();
        String name = labels.getShortForm(entity);
        // Something of a well-known vocabulary that has no label here goes by its usual short name.
        if (name.equals(entity.getIRI().getShortForm())) for (String[] v : VOCABULARIES) if (iri.startsWith(v[1])) return v[0] + ":" + name;
        return name.matches("[\\p{L}\\p{N}_.-]+") ? name : "'" + name.replace("'", "\\'") + "'";
      }

      @Override
      public void dispose() {
        labels.dispose();
      }
    };
  }

  /**
   * The justifications for one entailment: each a smallest set of asserted axioms from which it
   * follows. They come from the OWL API's explanation library, which asks the reasoner; nothing
   * here is composed by hand. When none is found in time, that is what is said.
   */
  static JsonObject explain(String kind, OWLClass subject, OWLAxiom entailment, ExplanationGeneratorFactory<OWLAxiom> generators, OWLOntology ontology, int max, long deadline, ShortFormProvider names, OWLDataFactory df) {
    JsonObject out = new JsonObject();
    out.addProperty("kind", kind);
    if (subject != null) out.addProperty("subject", subject.getIRI().toString());
    JsonArray justifications = new JsonArray();
    out.add("justifications", justifications);
    ExplanationProgressMonitor<OWLAxiom> monitor = new ExplanationProgressMonitor<OWLAxiom>() {
      @Override
      public void foundExplanation(ExplanationGenerator<OWLAxiom> generator, Explanation<OWLAxiom> explanation, Set<Explanation<OWLAxiom>> all) {}

      @Override
      public boolean isCancelled() {
        return System.currentTimeMillis() >= deadline || Thread.currentThread().isInterrupted();
      }
    };
    try {
      ExplanationGenerator<OWLAxiom> generator = generators.createExplanationGenerator(ontology.getLogicalAxioms(Imports.INCLUDED), monitor);
      Set<Explanation<OWLAxiom>> found = generator.getExplanations(entailment, max);
      ManchesterOWLSyntaxOWLObjectRendererImpl renderer = new ManchesterOWLSyntaxOWLObjectRendererImpl();
      renderer.setShortFormProvider(names);
      List<Explanation<OWLAxiom>> ordered = new ArrayList<>(found);
      ordered.sort(Comparator.comparingInt(Explanation::getSize));
      for (Explanation<OWLAxiom> e : ordered) {
        if (e.isEmpty()) continue;
        JsonObject j = new JsonObject();
        JsonArray axioms = new JsonArray();
        List<OWLAxiom> list = new ArrayList<>(e.getAxioms());
        list.sort(Comparator.comparing(a -> renderer.render(a)));
        for (OWLAxiom a : list) {
          JsonObject ax = new JsonObject();
          ax.addProperty("text", renderer.render(a).replaceAll("\\s+", " ").trim());
          ax.addProperty("type", a.getAxiomType().getName());
          ax.add("entities", entities(a, names));
          axioms.add(ax);
        }
        j.add("axioms", axioms);
        justifications.add(j);
      }
      if (justifications.size() == 0) out.addProperty("note", System.currentTimeMillis() >= deadline ? "No justification was worked out in the time allowed for explanations." : "The explanation service found no justification.");
    } catch (Exception | StackOverflowError e) {
      out.addProperty("note", System.currentTimeMillis() >= deadline ? "No justification was worked out in the time allowed for explanations." : "No justification could be worked out: " + describe(e));
    }
    return out;
  }
}
