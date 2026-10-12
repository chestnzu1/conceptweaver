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
import org.semanticweb.owlapi.formats.TurtleDocumentFormat;
import org.semanticweb.owlapi.io.StringDocumentSource;
import org.semanticweb.owlapi.manchestersyntax.renderer.ManchesterOWLSyntaxOWLObjectRendererImpl;
import org.semanticweb.owlapi.model.IRI;
import org.semanticweb.owlapi.model.MissingImportHandlingStrategy;
import org.semanticweb.owlapi.model.OWLAxiom;
import org.semanticweb.owlapi.model.OWLClass;
import org.semanticweb.owlapi.model.OWLDataFactory;
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
import org.semanticweb.owlapi.profiles.OWLProfileReport;
import org.semanticweb.owlapi.profiles.OWLProfileViolation;
import org.semanticweb.owlapi.reasoner.InferenceType;
import org.semanticweb.owlapi.reasoner.Node;
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
 *   POST /reason   { ontology, imports?: [{ iri, text }], timeoutMs?, explanations?: { max, perSubject, timeoutMs } }
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
  static String hermitVersion = "unknown";
  static String owlapiVersion = "unknown";

  public static void main(String[] args) throws IOException {
    int port = 5190;
    String host = "127.0.0.1";
    for (String a : args) {
      if (a.startsWith("--port=")) port = Integer.parseInt(a.substring(7));
      else if (a.startsWith("--host=")) host = a.substring(7);
      else if (a.startsWith("--allow-origin=")) allowedOrigins.add(a.substring(15));
    }
    hermitVersion = versionOf("net.sourceforge.owlapi/org.semanticweb.hermit");
    owlapiVersion = versionOf("net.sourceforge.owlapi/owlapi-api");
    HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 16);
    server.createContext("/health", x -> respond(x, 200, health()));
    server.createContext("/reason", ReasonerService::reason);
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
    if (origin != null && allowed(origin)) {
      x.getResponseHeaders().set("Access-Control-Allow-Origin", origin);
      x.getResponseHeaders().set("Vary", "Origin");
      x.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      x.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
      x.getResponseHeaders().set("Access-Control-Allow-Private-Network", "true");
      x.getResponseHeaders().set("Access-Control-Max-Age", "600");
    }
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
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      try (InputStream in = x.getRequestBody()) {
        byte[] chunk = new byte[65536];
        for (int n; (n = in.read(chunk)) > 0; ) {
          buf.write(chunk, 0, n);
          if (buf.size() > MAX_BODY) {
            respond(x, 413, failure("The ontology is larger than the service accepts (64 MB)."));
            return;
          }
        }
      }
      JsonObject request;
      try {
        request = GSON.fromJson(new String(buf.toByteArray(), StandardCharsets.UTF_8), JsonObject.class);
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
    synchronized (out) {
      out.add("profile", profile);
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
