package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
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
import org.semanticweb.owl.explanation.api.ExplanationProgressMonitor;
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
import org.semanticweb.owlapi.profiles.OWL2ELProfile;
import org.semanticweb.owlapi.profiles.OWLProfileReport;
import org.semanticweb.owlapi.profiles.OWLProfileViolation;
import org.semanticweb.owlapi.reasoner.InferenceType;
import org.semanticweb.owlapi.reasoner.Node;
import org.semanticweb.owlapi.reasoner.NodeSet;
import org.semanticweb.owlapi.reasoner.OWLReasoner;
import org.semanticweb.owlapi.util.AnnotationValueShortFormProvider;
import org.semanticweb.owlapi.util.ShortFormProvider;
import org.springframework.stereotype.Service;

/**
 * The reasoning /reason answers: HermiT over OWL 2 DL, or ELK over OWL 2 EL, chosen or asked for,
 * with the profile check, the justifications and the warnings the single-file service gives
 * (reasoner/ReasonerService.java). An ontology lives for the length of its request and is never
 * written anywhere; an import that was not sent is reported as missing, not fetched.
 */
@Service
public final class ReasoningService {

  /** The service never waits longer than this for one answer, whatever the request asks. */
  static final int MIN_TIMEOUT_MS = 1_000;
  static final int MAX_TIMEOUT_MS = 600_000;

  static final ExecutorService WORKERS = Executors.newCachedThreadPool(r -> {
    Thread t = new Thread(r, "reasoning");
    t.setDaemon(true);
    return t;
  });

  /** What the service will not go on with, already said in words. */
  static final class Refused extends RuntimeException {
    Refused(String message) {
      super(message);
    }
  }

  /**
   * Reasons over the ontology in `request`, waiting at most its timeout. Whatever had been worked
   * out when the time ran out is not shown: half a classification reads like a whole one.
   */
  public JsonObject run(JsonObject request) {
    long t0 = System.nanoTime();
    int timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Json.intOf(request, "timeoutMs", 60_000)));
    AtomicReference<OWLReasoner> running = new AtomicReference<>();
    JsonObject out = Json.result();
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
        Json.strings(out, "errors").add("Reasoning was stopped after " + (timeoutMs / 1000) + " seconds without finishing.");
      }
    } catch (Exception e) {
      Throwable cause = e.getCause() == null ? e : e.getCause();
      synchronized (out) {
        out.addProperty("status", "failed");
        if (!out.has("consistency")) out.addProperty("consistency", "unknown");
        Json.strings(out, "errors").add(describe(cause));
      }
    }
    synchronized (out) {
      out.addProperty("ms", (System.nanoTime() - t0) / 1_000_000);
      return out.deepCopy();
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
    if (e instanceof IllegalArgumentException) return "HermiT cannot reason over this ontology: " + Json.firstLines(message, 4);
    return name + (message.isEmpty() ? "" : ": " + Json.firstLines(message, 4));
  }

  /** What the Turtle parser objected to, without the list of every other format that was not tried. */
  static String parseProblem(String message) {
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?s)Parser: org\\.semanticweb\\.owlapi\\.rdf\\.turtle\\.parser\\.TurtleOntologyParser.*?\\n\\s*(?:Stack trace:\\s*)?(.*?)(?:\\n\\s*\\n|\\z)").matcher(message);
    String found = m.find() ? m.group(1) : message;
    return Json.firstLines(found.replaceAll("(?m)^\\s*at .*$", "").replaceAll("org\\.semanticweb\\.[A-Za-z.]+\\.([A-Za-z]+Exception):?", "").trim(), 3);
  }

  static void work(JsonObject request, JsonObject out, AtomicReference<OWLReasoner> running) {
    OWLOntologyManager manager = OWLManager.createOWLOntologyManager();
    OWLDataFactory df = manager.getOWLDataFactory();
    // An import that was not sent with the request is not fetched: its address is mapped to one nothing can be loaded from.
    manager.getIRIMappers().add((OWLOntologyIRIMapper) iri -> IRI.create(OwlDocuments.NOT_PROVIDED + Integer.toHexString(iri.toString().hashCode())));
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
          Json.strings(out, "warnings").add("The imported ontology <" + name + "> could not be read and is left out: " + Json.firstLines(String.valueOf(ex.getMessage()), 2));
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
      for (JsonElement m : missing) Json.strings(out, "warnings").add("The imported ontology <" + m.getAsString() + "> was not available, so its axioms are not part of this result.");
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
        Json.strings(out, "warnings").add(which + " is not in the OWL 2 datatype map (xsd:date, xsd:time, xsd:gYear and xsd:duration are not). HermiT took every such datatype as one it knows nothing about: its values are not checked or compared.");
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
      int perSubject = Math.max(0, Math.min(5, Json.intOf(wanted, "perSubject", 1)));
      int maxSubjects = Math.max(0, Math.min(200, Json.intOf(wanted, "max", 25)));
      long budget = Math.max(0, Math.min(300_000, Json.intOf(wanted, "timeoutMs", 20_000)));
      JsonArray explanations = new JsonArray();

      if (!consistent) {
        // From a contradiction everything follows, so there is no hierarchy to report: only why.
        if (perSubject > 0) {
          OWLAxiom entailment = df.getOWLSubClassOfAxiom(df.getOWLThing(), df.getOWLNothing());
          explanations.add(explain("inconsistent", null, entailment, Explanations.inconsistent(explaining, df, budget), ontology, perSubject, System.currentTimeMillis() + budget, names, df));
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
        else Json.strings(out, "warnings").add("Inferred relationships between individuals were not worked out: with " + individuals.size() + " individuals and " + properties.size() + " object properties that is too many questions to ask.");
      }

      // Why each unsatisfiable class is one, as far as the time for it goes.
      if (perSubject > 0) {
        long deadline = System.currentTimeMillis() + budget;
        ExplanationGeneratorFactory<OWLAxiom> generators = Explanations.manager(explaining);
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
      out.addProperty("engineVersion", Versions.ELK);
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
          Json.strings(out, "warnings").add("ELK found a contradiction, and gives no justification for it: ask HermiT to see why.");
          // ELK is sound: a contradiction it finds is one.
          out.addProperty("status", "complete");
        }
        return;
      }
      org.semanticweb.elk.reasoner.completeness.IncompleteResult<Node<OWLClass>> bottom = reasoner.computeUnsatisfiableClasses();
      monitors.add(bottom.getIncompletenessMonitor());
      Set<OWLClass> unsat = value(bottom).getEntitiesMinusBottom();
      JsonArray unsatisfiable = new JsonArray();
      for (OWLClass c : sorted(unsat)) unsatisfiable.add(c.getIRI().toString());

      JsonArray subclasses = new JsonArray();
      JsonArray equivalents = new JsonArray();
      Set<String> grouped = new HashSet<>();
      for (OWLClass c : sorted(ontology.getClassesInSignature(Imports.INCLUDED))) {
        if (c.isOWLThing() || c.isOWLNothing() || unsat.contains(c)) continue;
        org.semanticweb.elk.reasoner.completeness.IncompleteResult<Node<OWLClass>> sameR = reasoner.computeEquivalentClasses(c);
        monitors.add(sameR.getIncompletenessMonitor());
        Node<OWLClass> same = value(sameR);
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
        for (OWLClass sup : sorted(value(upR).getFlattened())) {
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
        for (OWLClass c : sorted(value(typesR).getFlattened())) {
          if (c.isOWLThing()) continue;
          JsonObject pair = new JsonObject();
          pair.addProperty("individual", i.getIRI().toString());
          pair.addProperty("class", c.getIRI().toString());
          types.add(pair);
        }
      }
      // What ELK says it left out, once for each kind of answer, in its own words.
      Set<String> leftOut = new java.util.LinkedHashSet<>();
      Set<org.semanticweb.elk.reasoner.completeness.IncompletenessMonitor> said = Collections.newSetFromMap(new java.util.IdentityHashMap<>());
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
        JsonArray warnings = Json.strings(out, "warnings");
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

  /**
   * The value of one ELK answer, without its status being logged first. ELK's own convenience
   * method, Incompleteness.getValue, asks the monitor to log its status to ELK's logger before it
   * hands the value over, and that call also records that the monitor has said its piece. In the
   * single-file service that log went nowhere (there is no logging binding on its classpath);
   * Spring Boot has a binding, which application.properties turns off for ELK, and this asks the
   * result for its value directly as well, so that the status is asked for afterwards, in this
   * service's own words and with the final counts, whatever the logging says. getValue is
   * package-private, hence the reflected call.
   */
  private static final java.lang.reflect.Method ELK_VALUE;

  static {
    try {
      ELK_VALUE = org.semanticweb.elk.reasoner.completeness.IncompleteResult.class.getDeclaredMethod("getValue");
      ELK_VALUE.setAccessible(true);
    } catch (ReflectiveOperationException e) {
      throw new ExceptionInInitializerError(e);
    }
  }

  @SuppressWarnings("unchecked")
  static <T> T value(org.semanticweb.elk.reasoner.completeness.IncompleteResult<T> result) {
    try {
      return (T) ELK_VALUE.invoke(result);
    } catch (ReflectiveOperationException e) {
      throw new IllegalStateException("The ELK answer could not be read: " + e, e);
    }
  }

  /** A logger that keeps what is said to it, for what ELK reports of itself: nothing of it reaches the console. */
  static org.slf4j.Logger capturing(Set<String> lines) {
    return (org.slf4j.Logger) java.lang.reflect.Proxy.newProxyInstance(ReasoningService.class.getClassLoader(), new Class<?>[] {org.slf4j.Logger.class}, (proxy, method, args) -> {
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
