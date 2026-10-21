package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import org.semanticweb.owlapi.apibinding.OWLManager;
import org.semanticweb.owlapi.formats.FunctionalSyntaxDocumentFormat;
import org.semanticweb.owlapi.io.StringDocumentSource;
import org.semanticweb.owlapi.model.IRI;
import org.semanticweb.owlapi.model.OWLAxiom;
import org.semanticweb.owlapi.model.OWLDataFactory;
import org.semanticweb.owlapi.model.OWLOntology;
import org.semanticweb.owlapi.model.OWLOntologyLoaderConfiguration;
import org.semanticweb.owlapi.model.OWLOntologyManager;

/**
 * An axiom of a change set, as the page writes it (src/editing/contracts.ts): read as the OWL
 * axiom it is, over OWL 2's own words. Each is written as functional syntax and parsed by the
 * OWL API, so both implementations mean the same thing by an axiom (AR-01) — the page's own
 * reader gives the same statements for it.
 */
final class Axioms {

  private Axioms() {}

  /** The entities an added axiom would introduce, by the type each position states; the page declares every term it reads. */
  record Entity(String iri, String type) {}

  // ---------------------------------------------------------------- rendering

  /** The axiom written as OWL functional syntax; nothing where this build cannot write it. */
  static String functional(JsonObject axiom) {
    return switch (axiom.get("type").getAsString()) {
      case "Declaration" -> "Declaration(" + entityType(axiom.get("entity").getAsString()) + "(" + iri(axiom.get("iri").getAsString()) + "))";
      case "SubClassOf" -> "SubClassOf(" + classExpression(axiom.getAsJsonObject("sub")) + " " + classExpression(axiom.getAsJsonObject("sup")) + ")";
      case "EquivalentClasses", "DisjointClasses" -> axiom.get("type").getAsString() + "(" + join(classExpressions(axiom.getAsJsonArray("classes"))) + ")";
      case "ClassAssertion" -> "ClassAssertion(" + classExpression(axiom.getAsJsonObject("class")) + " " + iri(axiom.get("individual").getAsString()) + ")";
      case "ObjectPropertyAssertion" -> "ObjectPropertyAssertion(" + iri(axiom.get("property").getAsString()) + " " + iri(axiom.get("source").getAsString()) + " " + iri(axiom.get("target").getAsString()) + ")";
      case "DataPropertyAssertion" -> "DataPropertyAssertion(" + iri(axiom.get("property").getAsString()) + " " + iri(axiom.get("source").getAsString()) + " " + literal(axiom.getAsJsonObject("value")) + ")";
      case "SameIndividual", "DifferentIndividuals" -> axiom.get("type").getAsString() + "(" + join(iris(axiom.getAsJsonArray("individuals"))) + ")";
      case "SubObjectPropertyOf" -> "SubObjectPropertyOf(" + iri(axiom.get("sub").getAsString()) + " " + iri(axiom.get("sup").getAsString()) + ")";
      case "SubDataPropertyOf" -> "SubDataPropertyOf(" + iri(axiom.get("sub").getAsString()) + " " + iri(axiom.get("sup").getAsString()) + ")";
      case "SubAnnotationPropertyOf" -> "SubAnnotationPropertyOf(" + iri(axiom.get("sub").getAsString()) + " " + iri(axiom.get("sup").getAsString()) + ")";
      case "SubPropertyChainOf" -> {
        StringBuilder chain = new StringBuilder("ObjectPropertyChain(");
        for (JsonElement e : axiom.getAsJsonArray("chain")) chain.append(' ').append(objectPropertyExpression(e.getAsJsonObject()));
        chain.append(')');
        yield "SubObjectPropertyOf(" + chain + " " + iri(axiom.get("sup").getAsString()) + ")";
      }
      case "HasKey" -> "HasKey(" + iri(axiom.get("class").getAsString()) + " " + properties(axiom.getAsJsonArray("properties")) + ")";
      case "DisjointUnion" -> "DisjointUnion(" + iri(axiom.get("class").getAsString()) + " " + join(classExpressions(axiom.getAsJsonArray("classes"))) + ")";
      case "NegativeObjectPropertyAssertion" -> "NegativeObjectPropertyAssertion(" + iri(axiom.get("property").getAsString()) + " " + iri(axiom.get("source").getAsString()) + " " + iri(axiom.get("target").getAsString()) + ")";
      case "NegativeDataPropertyAssertion" -> "NegativeDataPropertyAssertion(" + iri(axiom.get("property").getAsString()) + " " + iri(axiom.get("source").getAsString()) + " " + literal(axiom.getAsJsonObject("value")) + ")";
      case "EquivalentObjectProperties", "DisjointObjectProperties", "EquivalentDataProperties", "DisjointDataProperties" -> axiom.get("type").getAsString() + "(" + join(iris(axiom.getAsJsonArray("properties"))) + ")";
      case "InverseObjectProperties" -> "InverseObjectProperties(" + iri(axiom.get("first").getAsString()) + " " + iri(axiom.get("second").getAsString()) + ")";
      case "ObjectPropertyDomain" -> "ObjectPropertyDomain(" + iri(axiom.get("property").getAsString()) + " " + classExpression(axiom.getAsJsonObject("domain")) + ")";
      case "DataPropertyDomain" -> "DataPropertyDomain(" + iri(axiom.get("property").getAsString()) + " " + classExpression(axiom.getAsJsonObject("domain")) + ")";
      case "ObjectPropertyRange" -> "ObjectPropertyRange(" + iri(axiom.get("property").getAsString()) + " " + classExpression(axiom.getAsJsonObject("range")) + ")";
      case "DataPropertyRange" -> "DataPropertyRange(" + iri(axiom.get("property").getAsString()) + " " + dataRange(axiom.getAsJsonObject("range")) + ")";
      case "FunctionalObjectProperty" -> "FunctionalObjectProperty(" + iri(axiom.get("property").getAsString()) + ")";
      case "InverseFunctionalObjectProperty" -> "InverseFunctionalObjectProperty(" + iri(axiom.get("property").getAsString()) + ")";
      case "ReflexiveObjectProperty" -> "ReflexiveObjectProperty(" + iri(axiom.get("property").getAsString()) + ")";
      case "IrreflexiveObjectProperty" -> "IrreflexiveObjectProperty(" + iri(axiom.get("property").getAsString()) + ")";
      case "SymmetricObjectProperty" -> "SymmetricObjectProperty(" + iri(axiom.get("property").getAsString()) + ")";
      case "AsymmetricObjectProperty" -> "AsymmetricObjectProperty(" + iri(axiom.get("property").getAsString()) + ")";
      case "TransitiveObjectProperty" -> "TransitiveObjectProperty(" + iri(axiom.get("property").getAsString()) + ")";
      case "FunctionalDataProperty" -> "FunctionalDataProperty(" + iri(axiom.get("property").getAsString()) + ")";
      case "DatatypeDefinition" -> "DatatypeDefinition(" + iri(axiom.get("datatype").getAsString()) + " " + dataRange(axiom.getAsJsonObject("range")) + ")";
      case "AnnotationAssertion" -> {
        JsonObject value = axiom.getAsJsonObject("value");
        yield "AnnotationAssertion(" + iri(axiom.get("property").getAsString()) + " " + iri(axiom.get("subject").getAsString()) + " " + (value.has("iri") ? iri(value.get("iri").getAsString()) : literal(value)) + ")";
      }
      default -> null;
    };
  }

  /** The entities an added axiom would introduce, by the type each position states. */
  static List<Entity> introduced(JsonObject axiom) {
    List<Entity> out = new ArrayList<>();
    BiConsumer<String, String> put = (iri, type) -> {
      if (!iri.startsWith("http://www.w3.org/2002/07/owl#") && !iri.startsWith("http://www.w3.org/2000/01/rdf-schema#")) out.add(new Entity(iri, type));
    };
    switch (axiom.get("type").getAsString()) {
      case "Declaration" -> put.accept(axiom.get("iri").getAsString(), axiom.get("entity").getAsString());
      case "SubClassOf" -> {
        classEntities(axiom.getAsJsonObject("sub"), put);
        classEntities(axiom.getAsJsonObject("sup"), put);
      }
      case "EquivalentClasses", "DisjointClasses", "DisjointUnion" -> {
        for (JsonElement e : axiom.getAsJsonArray("classes")) classEntities(e.getAsJsonObject(), put);
      }
      case "ClassAssertion" -> {
        classEntities(axiom.getAsJsonObject("class"), put);
        put.accept(axiom.get("individual").getAsString(), "NamedIndividual");
      }
      case "ObjectPropertyAssertion" -> {
        put.accept(axiom.get("property").getAsString(), "ObjectProperty");
        put.accept(axiom.get("source").getAsString(), "NamedIndividual");
        put.accept(axiom.get("target").getAsString(), "NamedIndividual");
      }
      case "DataPropertyAssertion", "NegativeDataPropertyAssertion" -> {
        put.accept(axiom.get("property").getAsString(), "DataProperty");
        put.accept(axiom.get("source").getAsString(), "NamedIndividual");
      }
      case "NegativeObjectPropertyAssertion" -> {
        put.accept(axiom.get("property").getAsString(), "ObjectProperty");
        put.accept(axiom.get("source").getAsString(), "NamedIndividual");
        put.accept(axiom.get("target").getAsString(), "NamedIndividual");
      }
      case "SameIndividual", "DifferentIndividuals" -> {
        for (JsonElement e : axiom.getAsJsonArray("individuals")) put.accept(e.getAsString(), "NamedIndividual");
      }
      case "SubObjectPropertyOf" -> {
        put.accept(axiom.get("sub").getAsString(), "ObjectProperty");
        put.accept(axiom.get("sup").getAsString(), "ObjectProperty");
      }
      case "SubDataPropertyOf" -> {
        put.accept(axiom.get("sub").getAsString(), "DataProperty");
        put.accept(axiom.get("sup").getAsString(), "DataProperty");
      }
      case "SubAnnotationPropertyOf" -> {
        put.accept(axiom.get("sub").getAsString(), "AnnotationProperty");
        put.accept(axiom.get("sup").getAsString(), "AnnotationProperty");
      }
      case "SubPropertyChainOf" -> {
        for (JsonElement e : axiom.getAsJsonArray("chain")) {
          if (e.getAsJsonObject().get("type").getAsString().equals("ObjectProperty")) put.accept(e.getAsJsonObject().get("iri").getAsString(), "ObjectProperty");
        }
      }
      case "HasKey" -> {
        put.accept(axiom.get("class").getAsString(), "Class");
        for (JsonElement e : axiom.getAsJsonArray("properties")) put.accept(e.getAsJsonObject().get("iri").getAsString(), e.getAsJsonObject().get("type").getAsString());
      }
      case "EquivalentObjectProperties", "DisjointObjectProperties" -> {
        for (JsonElement e : axiom.getAsJsonArray("properties")) put.accept(e.getAsString(), "ObjectProperty");
      }
      case "EquivalentDataProperties", "DisjointDataProperties" -> {
        for (JsonElement e : axiom.getAsJsonArray("properties")) put.accept(e.getAsString(), "DataProperty");
      }
      case "InverseObjectProperties" -> {
        put.accept(axiom.get("first").getAsString(), "ObjectProperty");
        put.accept(axiom.get("second").getAsString(), "ObjectProperty");
      }
      case "ObjectPropertyDomain", "ObjectPropertyRange" -> {
        put.accept(axiom.get("property").getAsString(), "ObjectProperty");
        classEntities(axiom.getAsJsonObject(axiom.has("domain") ? "domain" : "range"), put);
      }
      case "DataPropertyDomain" -> {
        put.accept(axiom.get("property").getAsString(), "DataProperty");
        classEntities(axiom.getAsJsonObject("domain"), put);
      }
      case "DataPropertyRange" -> put.accept(axiom.get("property").getAsString(), "DataProperty");
      case "FunctionalObjectProperty", "InverseFunctionalObjectProperty", "ReflexiveObjectProperty", "IrreflexiveObjectProperty", "SymmetricObjectProperty", "AsymmetricObjectProperty", "TransitiveObjectProperty" -> put.accept(axiom.get("property").getAsString(), "ObjectProperty");
      case "FunctionalDataProperty" -> put.accept(axiom.get("property").getAsString(), "DataProperty");
      case "DatatypeDefinition" -> put.accept(axiom.get("datatype").getAsString(), "Datatype");
      case "AnnotationAssertion" -> put.accept(axiom.get("property").getAsString(), "AnnotationProperty");
      default -> {
      }
    }
    return out;
  }

  private static void classEntities(JsonObject expression, BiConsumer<String, String> put) {
    if (expression == null) return;
    String type = expression.get("type").getAsString();
    if (type.equals("Class")) {
      put.accept(expression.get("iri").getAsString(), "Class");
      return;
    }
    if (type.equals("ObjectProperty")) {
      put.accept(expression.get("iri").getAsString(), "ObjectProperty");
      return;
    }
    if (type.equals("ObjectInverseOf")) {
      put.accept(expression.getAsJsonObject("property").get("iri").getAsString(), "ObjectProperty");
      return;
    }
    if (type.equals("DataProperty")) {
      put.accept(expression.get("iri").getAsString(), "DataProperty");
      return;
    }
    if (expression.has("property") && expression.get("property").isJsonObject()) classEntities(expression.getAsJsonObject("property"), put);
    if (expression.has("filler") && expression.get("filler").isJsonObject()) classEntities(expression.getAsJsonObject("filler"), put);
    for (String key : new String[] {"operands", "operand", "individuals"}) {
      if (!expression.has(key)) continue;
      if (expression.get(key).isJsonArray()) for (JsonElement e : expression.getAsJsonArray(key)) if (e.isJsonObject()) classEntities(e.getAsJsonObject(), put);
      else if (expression.get(key).isJsonObject()) classEntities(expression.getAsJsonObject(key), put);
    }
  }

  private static String entityType(String type) {
    return switch (type) {
      case "ObjectProperty", "DataProperty", "AnnotationProperty", "NamedIndividual", "Datatype" -> type;
      default -> "Class";
    };
  }

  private static String objectPropertyExpression(JsonObject p) {
    return p.get("type").getAsString().equals("ObjectInverseOf") ? "ObjectInverseOf(" + iri(p.getAsJsonObject("property").get("iri").getAsString()) + ")" : iri(p.get("iri").getAsString());
  }

  private static String properties(JsonArray properties) {
    List<String> out = new ArrayList<>();
    for (JsonElement e : properties) out.add(iri(e.getAsJsonObject().get("iri").getAsString()));
    return join(out);
  }

  private static String classExpression(JsonObject e) {
    if (e == null) return "";
    return switch (e.get("type").getAsString()) {
      case "Class" -> iri(e.get("iri").getAsString());
      case "ObjectIntersectionOf" -> "ObjectIntersectionOf(" + join(classExpressions(e.getAsJsonArray("operands"))) + ")";
      case "ObjectUnionOf" -> "ObjectUnionOf(" + join(classExpressions(e.getAsJsonArray("operands"))) + ")";
      case "ObjectComplementOf" -> "ObjectComplementOf(" + classExpression(e.getAsJsonObject("operand")) + ")";
      case "ObjectOneOf" -> "ObjectOneOf(" + individuals(e.getAsJsonArray("individuals")) + ")";
      case "ObjectSomeValuesFrom" -> "ObjectSomeValuesFrom(" + objectPropertyExpression(e.getAsJsonObject("property")) + " " + classExpression(e.getAsJsonObject("filler")) + ")";
      case "ObjectAllValuesFrom" -> "ObjectAllValuesFrom(" + objectPropertyExpression(e.getAsJsonObject("property")) + " " + classExpression(e.getAsJsonObject("filler")) + ")";
      case "ObjectHasValue" -> "ObjectHasValue(" + objectPropertyExpression(e.getAsJsonObject("property")) + " " + individual(e.getAsJsonObject("individual")) + ")";
      case "ObjectHasSelf" -> "ObjectHasSelf(" + objectPropertyExpression(e.getAsJsonObject("property")) + ")";
      case "ObjectMinCardinality" -> cardinality("ObjectMinCardinality", e);
      case "ObjectMaxCardinality" -> cardinality("ObjectMaxCardinality", e);
      case "ObjectExactCardinality" -> cardinality("ObjectExactCardinality", e);
      case "DataSomeValuesFrom" -> "DataSomeValuesFrom(" + iri(e.getAsJsonObject("property").get("iri").getAsString()) + " " + dataRange(e.getAsJsonObject("filler")) + ")";
      case "DataAllValuesFrom" -> "DataAllValuesFrom(" + iri(e.getAsJsonObject("property").get("iri").getAsString()) + " " + dataRange(e.getAsJsonObject("filler")) + ")";
      case "DataHasValue" -> "DataHasValue(" + iri(e.getAsJsonObject("property").get("iri").getAsString()) + " " + literal(e.getAsJsonObject("value")) + ")";
      case "DataMinCardinality" -> dataCardinality("DataMinCardinality", e);
      case "DataMaxCardinality" -> dataCardinality("DataMaxCardinality", e);
      case "DataExactCardinality" -> dataCardinality("DataExactCardinality", e);
      default -> null;
    };
  }

  private static String cardinality(String name, JsonObject e) {
    return name + "(" + e.get("n").getAsInt() + " " + objectPropertyExpression(e.getAsJsonObject("property")) + (e.has("filler") ? " " + classExpression(e.getAsJsonObject("filler")) : "") + ")";
  }

  private static String dataCardinality(String name, JsonObject e) {
    return name + "(" + e.get("n").getAsInt() + " " + iri(e.getAsJsonObject("property").get("iri").getAsString()) + (e.has("filler") ? " " + dataRange(e.getAsJsonObject("filler")) : "") + ")";
  }

  private static String individual(JsonObject i) {
    return iri(i.get("iri").getAsString());
  }

  private static String individuals(JsonArray list) {
    List<String> out = new ArrayList<>();
    for (JsonElement e : list) out.add(individual(e.getAsJsonObject()));
    return join(out);
  }

  private static String dataRange(JsonObject r) {
    return switch (r.get("type").getAsString()) {
      case "Datatype" -> iri(r.get("iri").getAsString());
      case "DataIntersectionOf" -> "DataIntersectionOf(" + join(dataRanges(r.getAsJsonArray("operands"))) + ")";
      case "DataUnionOf" -> "DataUnionOf(" + join(dataRanges(r.getAsJsonArray("operands"))) + ")";
      case "DataComplementOf" -> "DataComplementOf(" + dataRange(r.getAsJsonObject("operand")) + ")";
      case "DataOneOf" -> {
        List<String> out = new ArrayList<>();
        for (JsonElement e : r.getAsJsonArray("literals")) out.add(literal(e.getAsJsonObject()));
        yield "DataOneOf(" + join(out) + ")";
      }
      case "DatatypeRestriction" -> {
        StringBuilder out = new StringBuilder("DatatypeRestriction(" + iri(r.get("datatype").getAsString()));
        for (JsonElement f : r.getAsJsonArray("facets")) out.append(' ').append(iri(f.getAsJsonObject().get("facet").getAsString())).append(' ').append(literal(f.getAsJsonObject().getAsJsonObject("value")));
        yield out + ")";
      }
      default -> null;
    };
  }

  private static List<String> classExpressions(JsonArray list) {
    List<String> out = new ArrayList<>();
    for (JsonElement e : list) out.add(classExpression(e.getAsJsonObject()));
    return out;
  }

  private static List<String> dataRanges(JsonArray list) {
    List<String> out = new ArrayList<>();
    for (JsonElement e : list) out.add(dataRange(e.getAsJsonObject()));
    return out;
  }

  private static List<String> iris(JsonArray list) {
    List<String> out = new ArrayList<>();
    for (JsonElement e : list) out.add(iri(e.getAsString()));
    return out;
  }

  private static String join(List<String> parts) {
    return String.join(" ", parts);
  }

  private static String iri(String iri) {
    return "<" + iri.replace("\\", "\\\\").replace(">", "\\>") + ">";
  }

  private static String literal(JsonObject l) {
    String value = l.get("value").getAsString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    if (l.has("lang")) return "\"" + value + "\"@" + l.get("lang").getAsString();
    if (l.has("datatype")) return "\"" + value + "\"^^" + iri(l.get("datatype").getAsString());
    return "\"" + value + "\"";
  }

  // ---------------------------------------------------------------- parsing

  /** The OWL axiom the page's axiom is; nothing where this build cannot read it. */
  static OWLAxiom parse(JsonObject axiom) {
    // The OWL API's functional-syntax parser does not read HasKey, so the axiom is built directly.
    if (axiom.get("type").getAsString().equals("HasKey")) {
      OWLDataFactory df = OWLManager.getOWLDataFactory();
      List<org.semanticweb.owlapi.model.OWLPropertyExpression> properties = new ArrayList<>();
      for (JsonElement p : axiom.getAsJsonArray("properties")) {
        String iri = p.getAsJsonObject().get("iri").getAsString();
        String kind = p.getAsJsonObject().get("type").getAsString();
        properties.add(kind.equals("ObjectProperty") ? df.getOWLObjectProperty(IRI.create(iri)) : df.getOWLDataProperty(IRI.create(iri)));
      }
      return df.getOWLHasKeyAxiom(df.getOWLClass(IRI.create(axiom.get("class").getAsString())), properties);
    }
    String text = functional(axiom);
    if (text == null) return null;
    try {
      OWLOntologyManager manager = OWLManager.createOWLOntologyManager();
      // One axiom is parsed by being written in a document of its own: the public API of both
      // OWL API lines reads documents, and the single-axiom parser is not part of either.
      OWLOntology ontology = manager.loadOntologyFromOntologyDocument(new StringDocumentSource("Ontology(<urn:conceptweaver:axiom> " + text + ")", IRI.create("urn:conceptweaver:axiom-document"), new FunctionalSyntaxDocumentFormat(), null), new OWLOntologyLoaderConfiguration());
      return ontology.getAxioms().stream().findFirst().orElse(null);
    } catch (Exception | Error e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- what one is called

  /** An axiom in a few words, as the page says which one a refusal is about (src/editing/axioms.ts brief). */
  static String brief(JsonObject axiom) {
    String type = axiom.get("type").getAsString();
    if (type.equals("Unmapped")) {
      String turtle = axiom.get("turtle").getAsString();
      return turtle.length() > 120 ? turtle.substring(0, 117) + "…" : turtle;
    }
    List<String> parts = new ArrayList<>();
    walk(axiom, "", parts);
    return type + "(" + String.join(" ", parts) + ")";
  }

  private static void walk(JsonElement x, String key, List<String> parts) {
    if (x.isJsonPrimitive() && x.getAsJsonPrimitive().isString()) {
      String s = x.getAsString();
      if (key.equals("value")) parts.add(Json.GSON.toJson(s));
      else if (!key.equals("type") && !key.equals("entity") && !key.equals("lang") && !key.equals("datatype") && !key.equals("turtle")) parts.add(shortIri(s));
    } else if (x.isJsonArray()) {
      for (JsonElement e : x.getAsJsonArray()) walk(e, "", parts);
    } else if (x.isJsonObject()) {
      for (Map.Entry<String, JsonElement> at : x.getAsJsonObject().entrySet()) walk(at.getValue(), at.getKey(), parts);
    }
  }

  private static String shortIri(String iri) {
    int cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
    return cut >= 0 && cut < iri.length() - 1 ? iri.substring(cut + 1) : iri;
  }
}
