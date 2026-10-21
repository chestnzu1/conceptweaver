package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.semanticweb.owlapi.formats.PrefixDocumentFormat;
import org.semanticweb.owlapi.formats.TurtleDocumentFormat;
import org.semanticweb.owlapi.io.StringDocumentTarget;
import org.semanticweb.owlapi.model.AddAxiom;
import org.semanticweb.owlapi.model.IRI;
import org.semanticweb.owlapi.model.OWLAxiom;
import org.semanticweb.owlapi.model.OWLClass;
import org.semanticweb.owlapi.model.OWLClassAssertionAxiom;
import org.semanticweb.owlapi.model.OWLDataProperty;
import org.semanticweb.owlapi.model.OWLDataPropertyAssertionAxiom;
import org.semanticweb.owlapi.model.OWLDocumentFormat;
import org.semanticweb.owlapi.model.OWLEntity;
import org.semanticweb.owlapi.model.OWLEquivalentClassesAxiom;
import org.semanticweb.owlapi.model.OWLLiteral;
import org.semanticweb.owlapi.model.OWLNamedIndividual;
import org.semanticweb.owlapi.model.OWLObjectProperty;
import org.semanticweb.owlapi.model.OWLObjectPropertyAssertionAxiom;
import org.semanticweb.owlapi.model.OWLOntology;
import org.semanticweb.owlapi.model.OWLOntologyChange;
import org.semanticweb.owlapi.model.OWLOntologyManager;
import org.semanticweb.owlapi.model.OWLSubClassOfAxiom;
import org.semanticweb.owlapi.model.RemoveAxiom;
import org.semanticweb.owlapi.model.parameters.Imports;
import org.springframework.stereotype.Service;

/**
 * Change sets on the server (roadmap task 3.5): a change set is applied to a held ontology whole
 * or not at all, held to the editor's own rules, and the result is held as a new revision — its
 * content hash — of the same ontology. The rules are the page's (`planned` and `ruled` in
 * src/editing/local.ts): the same change set is refused or accepted by both implementations, for
 * the same reasons in the same words (AR-01).
 */
@Service
final class SessionEditing {

  private final Sessions sessions;

  SessionEditing(Sessions sessions) {
    this.sessions = sessions;
  }

  /** What one question of the service is answered with. */
  JsonObject answer(String question, JsonObject query) {
    switch (question) {
      case "apply": return applyChange(query);
      case "validate": return validateChange(query);
      case "entity": throw new Refusal("unsupported", "The edit service does not answer what is stated about one entity yet.");
      default: throw new Refusal("not-found", "There is no question “" + question + "”.");
    }
  }

  // ---------------------------------------------------------------- the plan

  /** What applying a change set would give: the refusals, or the notes worth telling. */
  record Plan(List<JsonObject> refusals, List<String> notes) {}

  private Sessions.Held against(JsonObject query) {
    String base = query.get("baseRevision").getAsString();
    try {
      return sessions.held(query.get("ontologyId").getAsString(), base);
    } catch (Refusal e) {
      throw new Refusal("stale-revision", "The ontology has moved on from revision " + base + ".");
    }
  }

  private static JsonObject refusal(String code, String message) {
    JsonObject o = new JsonObject();
    o.addProperty("code", code);
    o.addProperty("message", message);
    return o;
  }

  private Plan plan(Sessions.Held held, JsonObject changeSet) {
    OWLOntology ontology = held.ontology();
    Set<OWLAxiom> stated = new HashSet<>(ontology.getAxioms());
    List<JsonObject> refusals = new ArrayList<>();
    List<String> notes = new ArrayList<>();
    Set<OWLAxiom> seen = new HashSet<>();
    List<JsonObject> adds = new ArrayList<>();
    Set<OWLAxiom> removals = new LinkedHashSet<>();
    for (JsonElement c : changeSet.getAsJsonArray("changes")) {
      JsonObject change = c.getAsJsonObject();
      JsonObject axiomJson = change.getAsJsonObject("axiom");
      String brief = Axioms.brief(axiomJson);
      OWLAxiom axiom = Axioms.parse(axiomJson);
      if (axiom == null) refusals.add(refusal("invalid", brief + " is not one statement that can be read and written."));
      else if (!seen.add(axiom)) refusals.add(refusal("invalid", brief + " is changed twice by one change set."));
      else if (change.get("op").getAsString().equals("remove") && !stated.contains(axiom)) refusals.add(refusal("invalid", brief + " is not stated, so it cannot be removed."));
      else if (change.get("op").getAsString().equals("add") && stated.contains(axiom)) refusals.add(refusal("invalid", brief + " is stated already."));
      else if (change.get("op").getAsString().equals("remove")) removals.add(axiom);
      else adds.add(axiomJson);
    }
    if (!refusals.isEmpty()) return new Plan(refusals, notes);
    // What is added is held to the rules an edit in the editor is, in the ontology as it is once
    // the removals are made: what a change set takes away does not stand in the way of what it adds.
    Set<OWLAxiom> current = new HashSet<>(stated);
    current.removeAll(removals);
    String pref = OntologyView.prefLanguageOf(ontology);
    for (JsonObject axiomJson : adds) {
      String[] said = ruled(ontology, current, Axioms.parse(axiomJson), axiomJson, pref);
      if (said[0] != null) refusals.add(refusal("refused", said[0]));
      else if (said[1] != null) notes.add(said[1]);
    }
    if (!refusals.isEmpty()) return new Plan(refusals, notes);
    // What the page holds the result to, exactly (`planned` in src/editing/local.ts): an entity
    // the additions introduce is read back with its declaration and the name made from its IRI as
    // its label, so a change set whose result would come back with anything it did not ask for is
    // refused in the page's own words.
    Set<OWLEntity> signature = ontology.getSignature(Imports.INCLUDED);
    Set<String> introduced = new LinkedHashSet<>();
    List<String> extra = new ArrayList<>();
    for (JsonElement c : changeSet.getAsJsonArray("changes")) {
      JsonObject change = c.getAsJsonObject();
      if (!change.get("op").getAsString().equals("add")) continue;
      for (Axioms.Entity e : Axioms.introduced(change.getAsJsonObject("axiom"))) {
        // What is said about annotation properties is kept as it was written; the page reads no
        // entity from it, so nothing comes back that the change set did not ask for.
        if (e.type().equals("AnnotationProperty")) continue;
        if (signature.stream().anyMatch((x) -> x.getIRI().toString().equals(e.iri())) || !introduced.add(e.iri())) continue;
        boolean declared = false;
        boolean labelled = false;
        for (JsonElement x : changeSet.getAsJsonArray("changes")) {
          JsonObject other = x.getAsJsonObject();
          if (!other.get("op").getAsString().equals("add")) continue;
          JsonObject a = other.getAsJsonObject("axiom");
          if (a.get("type").getAsString().equals("Declaration") && a.get("entity").getAsString().equals(e.type()) && a.get("iri").getAsString().equals(e.iri())) declared = true;
          if (a.get("type").getAsString().equals("AnnotationAssertion") && a.get("property").getAsString().equals("http://www.w3.org/2000/01/rdf-schema#label") && a.get("subject").getAsString().equals(e.iri())) labelled = true;
        }
        if (!declared) extra.add("<" + e.iri() + "> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <" + declarationType(e.type()) + ">");
        if (!labelled) extra.add("<" + e.iri() + "> <http://www.w3.org/2000/01/rdf-schema#label> \"" + escapeText(OntologyView.humanize(e.iri(), e.type().endsWith("Property"))) + "\"");
      }
    }
    if (!extra.isEmpty()) {
      refusals.add(refusal("unsupported", "The editor would not hold the result as it was asked for: 0 statement(s) would be lost and " + extra.size() + " added, such as " + extra.get(0) + " ."));
    }
    return new Plan(refusals, notes);
  }

  /** What rdf:type the page states for a declaration of one of its kinds (owl:Class and so on). */
  private static String declarationType(String type) {
    return switch (type) {
      case "ObjectProperty" -> "http://www.w3.org/2002/07/owl#ObjectProperty";
      case "DataProperty" -> "http://www.w3.org/2002/07/owl#DatatypeProperty";
      case "NamedIndividual" -> "http://www.w3.org/2002/07/owl#NamedIndividual";
      case "Datatype" -> "http://www.w3.org/2000/01/rdf-schema#Datatype";
      default -> "http://www.w3.org/2002/07/owl#Class";
    };
  }

  /** A literal as the page writes it, for the statements it says the result would come back with. */
  private static String escapeText(String text) {
    return text.replace("\\", "\\\\").replace("\"", "\\\"");
  }

  // ---------------------------------------------------------------- the editor's rules

  /** Why an axiom being added is not allowed, or what is worth knowing; nothing where no rule is about it. */
  private String[] ruled(OWLOntology ontology, Set<OWLAxiom> current, OWLAxiom axiom, JsonObject axiomJson, String pref) {
    java.util.function.Function<String, String> name = (iri) -> OntologyView.nameIn(ontology, IRI.create(iri), pref);
    java.util.function.Function<String, String> q = (x) -> "“" + x + "”";
    if (axiom instanceof OWLSubClassOfAxiom sub) {
      if (sub.getSubClass().isAnonymous() || sub.getSuperClass().isAnonymous()) return new String[] {null, null};
      OWLClass a = sub.getSubClass().asOWLClass();
      OWLClass b = sub.getSuperClass().asOWLClass();
      String aName = name.apply(a.getIRI().toString());
      String bName = name.apply(b.getIRI().toString());
      if (a.equals(b)) return new String[] {q.apply(aName) + " cannot be its own superclass.", null};
      if (current.stream().anyMatch((x) -> x.equals(sub))) return new String[] {q.apply(bName) + " is already an asserted superclass of " + q.apply(aName) + ".", null};
      if (reaches(current, a, b)) return new String[] {null, q.apply(bName) + " is already a kind of " + q.apply(aName) + ", so the two are now each other's superclass. Validation lists this as a circular hierarchy."};
      return new String[] {null, null};
    }
    if (axiom instanceof OWLEquivalentClassesAxiom || axiom instanceof org.semanticweb.owlapi.model.OWLDisjointClassesAxiom) {
      boolean equivalent = axiom instanceof OWLEquivalentClassesAxiom;
      // The pair is taken from the change set itself: two of the same class in one axiom is what the
      // page rules on, where the OWL API reads it as the class apart from owl:Thing.
      JsonArray classes = axiomJson.getAsJsonArray("classes");
      if (classes.size() != 2 || !classes.get(0).getAsJsonObject().get("type").getAsString().equals("Class") || !classes.get(1).getAsJsonObject().get("type").getAsString().equals("Class")) return new String[] {null, null};
      OWLClass x = namedClass(ontology, classes.get(0).getAsJsonObject().get("iri").getAsString());
      OWLClass y = namedClass(ontology, classes.get(1).getAsJsonObject().get("iri").getAsString());
      if (x == null || y == null) return new String[] {null, null};
      return link(ontology, current, x, y, equivalent ? "equivalentClass" : "disjointWith", equivalent ? "equivalent to" : "disjoint with", pref);
    }
    if (axiom instanceof org.semanticweb.owlapi.model.OWLSameIndividualAxiom || axiom instanceof org.semanticweb.owlapi.model.OWLDifferentIndividualsAxiom) {
      boolean same = axiom instanceof org.semanticweb.owlapi.model.OWLSameIndividualAxiom;
      JsonArray people = axiomJson.getAsJsonArray("individuals");
      if (people.size() != 2) return new String[] {null, null};
      OWLNamedIndividual x = namedIndividual(ontology, people.get(0).getAsString());
      OWLNamedIndividual y = namedIndividual(ontology, people.get(1).getAsString());
      if (x == null || y == null) return new String[] {null, null};
      return link(ontology, current, x, y, same ? "sameAs" : "differentFrom", same ? "the same as" : "different from", pref);
    }
    if (axiom instanceof org.semanticweb.owlapi.model.OWLEquivalentDataPropertiesAxiom || axiom instanceof org.semanticweb.owlapi.model.OWLDisjointDataPropertiesAxiom) {
      boolean equivalent = axiom instanceof org.semanticweb.owlapi.model.OWLEquivalentDataPropertiesAxiom;
      JsonArray properties = axiomJson.getAsJsonArray("properties");
      if (properties.size() != 2) return new String[] {null, null};
      OWLDataProperty x = namedDataProperty(ontology, properties.get(0).getAsString());
      OWLDataProperty y = namedDataProperty(ontology, properties.get(1).getAsString());
      if (x == null || y == null) return new String[] {null, null};
      return link(ontology, current, x, y, equivalent ? "equivalentProperty" : "propertyDisjointWith", equivalent ? "equivalent to" : "disjoint with", pref);
    }
    if (axiom instanceof OWLClassAssertionAxiom assertion) {
      if (assertion.getClassExpression().isAnonymous() || !assertion.getIndividual().isNamed()) return new String[] {null, null};
      // What kind of thing each IRI is here decides: the axiom joins an individual and a class.
      Set<OWLEntity> signature = ontology.getSignature(Imports.INCLUDED);
      OWLEntity ind = at(signature, assertion.getIndividual().asOWLNamedIndividual().getIRI());
      OWLEntity cls = at(signature, assertion.getClassExpression().asOWLClass().getIRI());
      if (ind == null || cls == null) return new String[] {null, null};
      String indName = name.apply(ind.getIRI().toString());
      String clsName = name.apply(cls.getIRI().toString());
      if (!ind.isOWLNamedIndividual() || !cls.isOWLClass()) {
        return new String[] {"“Is Instance Of” joins an individual and a class. " + q.apply(indName) + " is " + articleOf(ind) + " and " + q.apply(clsName) + " is " + articleOf(cls) + ".", null};
      }
      OWLClass classExpr = assertion.getClassExpression().asOWLClass();
      OWLNamedIndividual individual = assertion.getIndividual().asOWLNamedIndividual();
      if (current.stream().anyMatch((x) -> x instanceof OWLClassAssertionAxiom other && other.getIndividual().equals(individual) && other.getClassExpression().equals(classExpr))) {
        return new String[] {q.apply(indName) + " is already stated to be an instance of " + q.apply(clsName) + ".", null};
      }
      return new String[] {null, null};
    }
    if (axiom instanceof OWLObjectPropertyAssertionAxiom assertion) {
      if (!assertion.getSubject().isNamed() || !assertion.getObject().isNamed() || assertion.getProperty().isAnonymous()) return new String[] {null, null};
      OWLNamedIndividual a = assertion.getSubject().asOWLNamedIndividual();
      OWLNamedIndividual b = assertion.getObject().asOWLNamedIndividual();
      OWLObjectProperty property = assertion.getProperty().asOWLObjectProperty();
      Set<OWLEntity> signature = ontology.getSignature(Imports.INCLUDED);
      if (at(signature, a.getIRI()) == null || !at(signature, a.getIRI()).isOWLNamedIndividual()) return new String[] {"Only an individual has property values.", null};
      if (at(signature, property.getIRI()) == null) return new String[] {"Choose an object property.", null};
      if (at(signature, b.getIRI()) == null || !at(signature, b.getIRI()).isOWLNamedIndividual()) return new String[] {"The value of an object property is another individual.", null};
      String aName = name.apply(a.getIRI().toString());
      String bName = name.apply(b.getIRI().toString());
      String propName = name.apply(property.getIRI().toString());
      if (current.stream().anyMatch((x) -> x.equals(assertion))) return new String[] {q.apply(aName) + " " + propName + " " + q.apply(bName) + " is already stated.", null};
      if (a.equals(b) && characteristic(ontology, property, "irreflexive")) return new String[] {null, q.apply(propName) + " is irreflexive, so nothing can be related to itself by it. Validation will list this."};
      return new String[] {null, null};
    }
    if (axiom instanceof OWLDataPropertyAssertionAxiom assertion) {
      if (!assertion.getSubject().isNamed() || assertion.getProperty().isAnonymous()) return new String[] {null, null};
      OWLNamedIndividual individual = assertion.getSubject().asOWLNamedIndividual();
      OWLDataProperty property = assertion.getProperty().asOWLDataProperty();
      Set<OWLEntity> signature = ontology.getSignature(Imports.INCLUDED);
      if (at(signature, individual.getIRI()) == null || at(signature, property.getIRI()) == null) return new String[] {null, null};
      String indName = name.apply(individual.getIRI().toString());
      String propName = name.apply(property.getIRI().toString());
      OWLLiteral value = assertion.getObject();
      boolean sameValue = current.stream().anyMatch((x) -> x instanceof OWLDataPropertyAssertionAxiom other && other.getSubject().equals(individual) && other.getProperty().equals(property) && other.getObject().getLiteral().equals(value.getLiteral()) && java.util.Objects.equals(other.getObject().getLang(), value.getLang()));
      if (sameValue) return new String[] {q.apply(indName) + " already has that value for " + q.apply(propName) + ".", null};
      boolean functional = characteristic(ontology, property, "functional");
      boolean otherValue = current.stream().anyMatch((x) -> x instanceof OWLDataPropertyAssertionAxiom other && other.getSubject().equals(individual) && other.getProperty().equals(property));
      if (functional && otherValue) return new String[] {null, q.apply(propName) + " is functional: a thing has at most one value. Two different values make the ontology inconsistent, and Validation will say so."};
      return new String[] {null, null};
    }
    if (axiom instanceof org.semanticweb.owlapi.model.OWLSubObjectPropertyOfAxiom sub) {
      if (sub.getSubProperty().isAnonymous() || sub.getSuperProperty().isAnonymous()) return new String[] {null, null};
      return propLink(ontology, current, sub.getSubProperty().asOWLObjectProperty(), sub.getSuperProperty().asOWLObjectProperty(), "parents", "a sub-property of", pref);
    }
    if (axiom instanceof org.semanticweb.owlapi.model.OWLInverseObjectPropertiesAxiom inverse) {
      if (inverse.getFirstProperty().isAnonymous() || inverse.getSecondProperty().isAnonymous()) return new String[] {null, null};
      return propLink(ontology, current, inverse.getFirstProperty().asOWLObjectProperty(), inverse.getSecondProperty().asOWLObjectProperty(), "inverses", "the inverse of", pref);
    }
    if (axiom instanceof org.semanticweb.owlapi.model.OWLEquivalentObjectPropertiesAxiom || axiom instanceof org.semanticweb.owlapi.model.OWLDisjointObjectPropertiesAxiom) {
      boolean equivalent = axiom instanceof org.semanticweb.owlapi.model.OWLEquivalentObjectPropertiesAxiom;
      List<OWLObjectProperty> properties = namedObjectProperties(new ArrayList<>(equivalent ? ((org.semanticweb.owlapi.model.OWLEquivalentObjectPropertiesAxiom) axiom).getProperties() : ((org.semanticweb.owlapi.model.OWLDisjointObjectPropertiesAxiom) axiom).getProperties()));
      if (properties.size() != 2) return new String[] {null, null};
      return propLink(ontology, current, properties.get(0), properties.get(1), equivalent ? "equivalents" : "disjoints", equivalent ? "equivalent to" : "disjoint with", pref);
    }
    return new String[] {null, null};
  }

  /** The named class of the IRI, where the ontology holds it as one; nothing where it does not. */
  private static OWLClass namedClass(OWLOntology ontology, String iri) {
    OWLEntity e = at(ontology.getSignature(Imports.INCLUDED), IRI.create(iri));
    return e instanceof OWLClass ? (OWLClass) e : null;
  }

  /** The named individual of the IRI, where the ontology holds it as one; nothing where it does not. */
  private static OWLNamedIndividual namedIndividual(OWLOntology ontology, String iri) {
    OWLEntity e = at(ontology.getSignature(Imports.INCLUDED), IRI.create(iri));
    return e instanceof OWLNamedIndividual ? (OWLNamedIndividual) e : null;
  }

  /** The data property of the IRI, where the ontology holds it as one; nothing where it does not. */
  private static OWLDataProperty namedDataProperty(OWLOntology ontology, String iri) {
    OWLEntity e = at(ontology.getSignature(Imports.INCLUDED), IRI.create(iri));
    return e instanceof OWLDataProperty ? (OWLDataProperty) e : null;
  }

  private static List<OWLObjectProperty> namedObjectProperties(List<org.semanticweb.owlapi.model.OWLObjectPropertyExpression> properties) {
    List<OWLObjectProperty> out = new ArrayList<>();
    for (org.semanticweb.owlapi.model.OWLObjectPropertyExpression p : properties) {
      if (p.isAnonymous()) return new ArrayList<>();
      out.add(p.asOWLObjectProperty());
    }
    return out;
  }

  private static OWLEntity at(Set<OWLEntity> signature, IRI iri) {
    for (OWLEntity e : signature) if (e.getIRI().equals(iri)) return e;
    return null;
  }

  /** Whether the ontology states the characteristic of the property, as the file's rdf:type, which the OWL API keeps as an annotation. */
  private static boolean characteristic(OWLOntology ontology, OWLEntity property, String id) {
    String iri = id.equals("irreflexive") ? "http://www.w3.org/2002/07/owl#IrreflexiveProperty" : "http://www.w3.org/2002/07/owl#FunctionalProperty";
    for (org.semanticweb.owlapi.model.OWLAnnotationAssertionAxiom a : ontology.getAnnotationAssertionAxioms(property.getIRI())) {
      if (a.getProperty().getIRI().toString().equals("http://www.w3.org/1999/02/22-rdf-syntax-ns#type") && a.getValue() instanceof IRI v && v.toString().equals(iri)) return true;
    }
    return false;
  }

  /** Whether the ontology states `above` above `below`, by any chain of subclass edges. */
  private static boolean reaches(Set<OWLAxiom> current, OWLClass above, OWLClass below) {
    Set<OWLClass> seen = new LinkedHashSet<>();
    java.util.Deque<OWLClass> todo = new java.util.ArrayDeque<>();
    todo.push(below);
    while (!todo.isEmpty()) {
      OWLClass at = todo.pop();
      if (!seen.add(at)) continue;
      for (OWLAxiom x : current) {
        if (x instanceof OWLSubClassOfAxiom sub && !sub.getSubClass().isAnonymous() && sub.getSubClass().asOWLClass().equals(at) && !sub.getSuperClass().isAnonymous()) {
          OWLClass up = sub.getSuperClass().asOWLClass();
          if (up.equals(above)) return true;
          todo.push(up);
        }
      }
    }
    return false;
  }

  /** What the editor's rules say of one statement between two entities of a kind, whichever of the two it was written on. */
  private String[] link(OWLOntology ontology, Set<OWLAxiom> current, OWLEntity a, OWLEntity b, String kind, String phrase, String pref) {
    String aName = OntologyView.nameIn(ontology, IRI.create(a.getIRI().toString()), pref);
    String bName = OntologyView.nameIn(ontology, IRI.create(b.getIRI().toString()), pref);
    if (a.equals(b)) return new String[] {"“" + aName + "” cannot be " + phrase + " itself.", null};
    String opposite = switch (kind) {
      case "equivalentClass" -> "disjointWith";
      case "disjointWith" -> "equivalentClass";
      case "equivalentProperty" -> "propertyDisjointWith";
      case "propertyDisjointWith" -> "equivalentProperty";
      case "sameAs" -> "differentFrom";
      default -> "sameAs";
    };
    String oppositePhrase = switch (opposite) {
      case "equivalentClass", "equivalentProperty" -> "equivalent to";
      case "disjointWith", "propertyDisjointWith" -> "disjoint with";
      case "differentFrom" -> "different from";
      default -> "the same as";
    };
    if (pairStated(current, a, b, kind)) return new String[] {"“" + aName + "” is already stated to be " + phrase + " “" + bName + "”.", null};
    if (pairStated(current, a, b, opposite)) return new String[] {"“" + aName + "” is stated to be " + oppositePhrase + " “" + bName + "”. Both cannot hold; remove that statement first.", null};
    String note = null;
    // Two classes that are a kind of one another: making them disjoint leaves one of them empty.
    if (kind.equals("disjointWith") && a instanceof OWLClass && b instanceof OWLClass
        && (reaches(current, (OWLClass) a, (OWLClass) b) || reaches(current, (OWLClass) b, (OWLClass) a))) {
      note = "“" + aName + "” and “" + bName + "” are a kind of one another, so the more specific one can now have no members. Validation will list it.";
    }
    // The page keeps RDFS & OWL properties off until a statement needs them; stating one switches
    // the setting on and says so.
    if (!vocabOn(current)) {
      note = (note == null ? "" : note + " ") + "“Use RDFS & OWL properties” was switched on, which this kind of statement needs.";
    }
    return new String[] {null, note};
  }

  /** Whether the page would have “Use RDFS & OWL properties” on for these statements (src/model/rdf.ts):
   * a link between two classes, individuals or data properties switches it on as the page reads. */
  private static boolean vocabOn(Set<OWLAxiom> current) {
    for (OWLAxiom x : current) {
      if (x instanceof OWLEquivalentClassesAxiom || x instanceof org.semanticweb.owlapi.model.OWLDisjointClassesAxiom
          || x instanceof org.semanticweb.owlapi.model.OWLSameIndividualAxiom || x instanceof org.semanticweb.owlapi.model.OWLDifferentIndividualsAxiom
          || x instanceof org.semanticweb.owlapi.model.OWLEquivalentDataPropertiesAxiom || x instanceof org.semanticweb.owlapi.model.OWLDisjointDataPropertiesAxiom) return true;
      if (x instanceof org.semanticweb.owlapi.model.OWLAnnotationAssertionAxiom said && said.getProperty().getIRI().toString().startsWith("http://www.w3.org/2004/02/skos/core#") && said.getProperty().getIRI().toString().endsWith("Match")) return true;
    }
    return false;
  }

  /** Whether the pair is stated, by an axiom of the kind that names them both. */
  private static boolean pairStated(Set<OWLAxiom> current, OWLEntity a, OWLEntity b, String kind) {
    for (OWLAxiom x : current) {
      Set<OWLEntity> members = new LinkedHashSet<>();
      if (kind.equals("equivalentClass") && x instanceof OWLEquivalentClassesAxiom nary) {
        for (org.semanticweb.owlapi.model.OWLClassExpression c : nary.getClassExpressionsAsList()) if (!c.isAnonymous()) members.add(c.asOWLClass());
      } else if (kind.equals("disjointWith") && x instanceof org.semanticweb.owlapi.model.OWLDisjointClassesAxiom nary) {
        for (org.semanticweb.owlapi.model.OWLClassExpression c : nary.getClassExpressionsAsList()) if (!c.isAnonymous()) members.add(c.asOWLClass());
      } else if (kind.equals("sameAs") && x instanceof org.semanticweb.owlapi.model.OWLSameIndividualAxiom nary) {
        for (org.semanticweb.owlapi.model.OWLIndividual i : nary.getIndividualsAsList()) if (i.isNamed()) members.add(i.asOWLNamedIndividual());
      } else if (kind.equals("differentFrom") && x instanceof org.semanticweb.owlapi.model.OWLDifferentIndividualsAxiom nary) {
        for (org.semanticweb.owlapi.model.OWLIndividual i : nary.getIndividualsAsList()) if (i.isNamed()) members.add(i.asOWLNamedIndividual());
      } else if (kind.equals("equivalentProperty") && x instanceof org.semanticweb.owlapi.model.OWLEquivalentDataPropertiesAxiom nary) {
        for (org.semanticweb.owlapi.model.OWLDataPropertyExpression p : nary.getProperties()) if (!p.isAnonymous()) members.add(p.asOWLDataProperty());
      } else if (kind.equals("propertyDisjointWith") && x instanceof org.semanticweb.owlapi.model.OWLDisjointDataPropertiesAxiom nary) {
        for (org.semanticweb.owlapi.model.OWLDataPropertyExpression p : nary.getProperties()) if (!p.isAnonymous()) members.add(p.asOWLDataProperty());
      } else {
        continue;
      }
      if (members.contains(a) && members.contains(b)) return true;
    }
    return false;
  }

  /** What the editor's rules say of one statement between two object properties. */
  private String[] propLink(OWLOntology ontology, Set<OWLAxiom> current, OWLObjectProperty a, OWLObjectProperty b, String link, String phrase, String pref) {
    String aName = OntologyView.nameIn(ontology, IRI.create(a.getIRI().toString()), pref);
    String bName = OntologyView.nameIn(ontology, IRI.create(b.getIRI().toString()), pref);
    Set<OWLEntity> signature = ontology.getSignature(Imports.INCLUDED);
    if (at(signature, a.getIRI()) == null || at(signature, b.getIRI()) == null) return new String[] {"That object property no longer exists.", null};
    if (a.equals(b)) {
      return link.equals("inverses")
          ? new String[] {"A property that is its own inverse is a symmetric property: tick “Symmetric” for “" + aName + "” instead.", null}
          : new String[] {"“" + aName + "” cannot be " + phrase + " itself.", null};
    }
    if (propPairStated(current, a, b, link)) return new String[] {"“" + aName + "” is already stated to be " + phrase + " “" + bName + "”.", null};
    if ((link.equals("equivalents") || link.equals("disjoints")) && propPairStated(current, a, b, link.equals("equivalents") ? "disjoints" : "equivalents")) {
      String clash = link.equals("equivalents") ? "disjoint with" : "equivalent to";
      return new String[] {"“" + aName + "” is stated to be " + clash + " “" + bName + "”. Both cannot hold; remove that statement first.", null};
    }
    if (link.equals("parents") && subPropertyOf(current, a, b)) return new String[] {null, "“" + bName + "” is already a sub-property of “" + aName + "”, so the two now mean the same."};
    return new String[] {null, null};
  }

  /** Whether the pair of object properties is stated in the way, either way round. */
  private static boolean propPairStated(Set<OWLAxiom> current, OWLObjectProperty a, OWLObjectProperty b, String link) {
    for (OWLAxiom x : current) {
      if (link.equals("parents") && x instanceof org.semanticweb.owlapi.model.OWLSubObjectPropertyOfAxiom sub) {
        if (sub.getSubProperty().equals(a) && sub.getSuperProperty().equals(b)) return true;
      } else if (link.equals("inverses") && x instanceof org.semanticweb.owlapi.model.OWLInverseObjectPropertiesAxiom inverse) {
        if ((inverse.getFirstProperty().equals(a) && inverse.getSecondProperty().equals(b)) || (inverse.getFirstProperty().equals(b) && inverse.getSecondProperty().equals(a))) return true;
      } else if (link.equals("equivalents") && x instanceof org.semanticweb.owlapi.model.OWLEquivalentObjectPropertiesAxiom nary) {
        List<OWLObjectProperty> properties = namedObjectProperties(new ArrayList<>(nary.getProperties()));
        if (properties.contains(a) && properties.contains(b)) return true;
      } else if (link.equals("disjoints") && x instanceof org.semanticweb.owlapi.model.OWLDisjointObjectPropertiesAxiom nary) {
        List<OWLObjectProperty> properties = namedObjectProperties(new ArrayList<>(nary.getProperties()));
        if (properties.contains(a) && properties.contains(b)) return true;
      }
    }
    return false;
  }

  /** Whether `below` is below `above` by any chain of sub-property edges. */
  private static boolean subPropertyOf(Set<OWLAxiom> current, OWLObjectProperty above, OWLObjectProperty below) {
    Set<OWLObjectProperty> seen = new LinkedHashSet<>();
    java.util.Deque<OWLObjectProperty> todo = new java.util.ArrayDeque<>();
    todo.push(below);
    while (!todo.isEmpty()) {
      OWLObjectProperty at = todo.pop();
      if (!seen.add(at)) continue;
      for (OWLAxiom x : current) {
        if (x instanceof org.semanticweb.owlapi.model.OWLSubObjectPropertyOfAxiom sub && sub.getSubProperty().equals(at) && !sub.getSuperProperty().isAnonymous()) {
          OWLObjectProperty up = sub.getSuperProperty().asOWLObjectProperty();
          if (up.equals(above)) return true;
          todo.push(up);
        }
      }
    }
    return false;
  }

  /** What a kind of entity is called with an article, for the joins message. */
  private static String articleOf(OWLEntity e) {
    return "a " + switch (e.getEntityType().getName()) {
      case "Class" -> "class";
      case "NamedIndividual" -> "individual";
      case "DataProperty" -> "data property";
      case "ObjectProperty" -> "object property";
      case "AnnotationProperty" -> "annotation property";
      default -> "datatype";
    };
  }

  // ---------------------------------------------------------------- applying

  private JsonObject applyChange(JsonObject query) {
    Sessions.Held held = against(query);
    Plan plan = plan(held, query);
    if (!plan.refusals().isEmpty()) {
      JsonArray refusals = new JsonArray();
      for (JsonObject r : plan.refusals()) refusals.add(r);
      throw new Refusal("refused", plan.refusals().get(0).get("message").getAsString(), refusals);
    }
    // The changes are made on a fresh reading of the held document, so the revision it was made
    // from stays as it is; the result is held as a new revision by its content hash.
    Sessions.Parsed parsed = Sessions.parse(held.document(), held.imports());
    OWLOntologyManager manager = parsed.manager();
    OWLOntology ontology = parsed.ontology();
    List<OWLOntologyChange> changes = new ArrayList<>();
    for (JsonElement c : query.getAsJsonArray("changes")) {
      JsonObject change = c.getAsJsonObject();
      OWLAxiom axiom = Axioms.parse(change.getAsJsonObject("axiom"));
      changes.add(change.get("op").getAsString().equals("remove") ? new RemoveAxiom(ontology, axiom) : new AddAxiom(ontology, axiom));
    }
    manager.applyChanges(changes);
    String document = serialize(manager, ontology, held);
    String revisionId = Sessions.hash(document, held.imports());
    sessions.hold(held.ontologyId(), revisionId, manager, ontology, document, held.imports());
    JsonObject out = new JsonObject();
    out.addProperty("ontologyId", held.ontologyId());
    out.addProperty("revisionId", revisionId);
    JsonArray notes = new JsonArray();
    for (String note : plan.notes()) notes.add(note);
    out.add("notes", notes);
    out.addProperty("document", document);
    return out;
  }

  private JsonObject validateChange(JsonObject query) {
    Sessions.Held held = against(query);
    Plan plan = plan(held, query);
    JsonObject out = new JsonObject();
    out.addProperty("ok", plan.refusals().isEmpty());
    JsonArray refusals = new JsonArray();
    for (JsonObject r : plan.refusals()) refusals.add(r);
    out.add("refusals", refusals);
    JsonArray notes = new JsonArray();
    for (String note : plan.notes()) notes.add(note);
    out.add("notes", notes);
    return out;
  }

  /** The held ontology written as Turtle, with the prefixes it was uploaded with. */
  private static String serialize(OWLOntologyManager manager, OWLOntology ontology, Sessions.Held held) {
    TurtleDocumentFormat into = new TurtleDocumentFormat();
    OWLDocumentFormat source = held.manager().getOntologyFormat(held.ontology());
    if (source instanceof PrefixDocumentFormat) ((PrefixDocumentFormat) into).copyPrefixesFrom((PrefixDocumentFormat) source);
    StringDocumentTarget target = new StringDocumentTarget();
    try {
      manager.saveOntology(ontology, into, target);
    } catch (Exception e) {
      throw new Refusal("unsupported", "The result could not be written: " + Json.firstLines(String.valueOf(e.getMessage()), 2));
    }
    return target.toString();
  }
}
