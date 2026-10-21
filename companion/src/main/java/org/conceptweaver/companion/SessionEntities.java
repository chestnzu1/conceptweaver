package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * The Entities page's questions, answered from a held ontology (roadmap task 3.4): a port of
 * src/entities/service.ts and the record reading of src/entities/local.ts, kept behaviour for
 * behaviour so that the page's own service and this one answer the same questions the same way
 * (FR-M6-7). An entity in an answer is a key, which the service chooses: here it is the entity's
 * IRI, and of a relationship the place it holds in the session's relations.
 */
@Service
final class SessionEntities {

  /** The questions, by the name each is asked under (src/entities/http.ts). */
  static final String[] QUESTIONS = {"describe", "query", "options"};

  /** How many rows a page has when nothing is asked for, and at most. */
  static final int PAGE = 150;
  static final int MAX_PAGE = 1000;

  private final SessionStructure structure;
  private final int indexBound;

  /** The records of a session, made once and kept with the session's view. */
  static final class Index {
    final String ontologyId;
    final String revisionId;
    final JsonObject report;
    final Map<String, List<Record>> records = new LinkedHashMap<>();
    final Map<String, List<Candidate>> candidates = new LinkedHashMap<>();

    Index(String ontologyId, String revisionId, OntologyView read, JsonObject report) {
      this.ontologyId = ontologyId;
      this.revisionId = revisionId;
      this.report = report;
      records.put("class", classes(read));
      records.put("objectProperty", objectProperties(read));
      records.put("dataProperty", dataProperties(read));
      records.put("annotationProperty", annotationProperties(read));
      records.put("individual", individuals(read));
      records.put("relationship", relationships(read));
      candidates.put("individual|assertedType", classCandidates(read, true));
      candidates.put("individual|inferredType", classCandidates(read, false));
      candidates.put("relationship|from", endCandidates(read, "from"));
      candidates.put("relationship|to", endCandidates(read, "to"));
    }
  }

  record Text(String field, String property, String text) {}
  record Record(String key, String iri, String label, List<Text> texts, Map<String, Object> sort, Map<String, List<String>> facts) {}
  record Candidate(String value, String label, Integer count, String text, String iri) {}

  private final Map<String, Index> indexes = new LinkedHashMap<>(8, 0.75f, true);

  SessionEntities(SessionStructure structure) {
    this.structure = structure;
    this.indexBound = 8;
  }

  private Index index(String ontologyId, String revisionId) {
    String key = ontologyId + "\n" + revisionId;
    Index one = indexes.get(key);
    if (one == null) {
      SessionStructure.View v = structure.reasonedView(ontologyId, revisionId);
      one = new Index(ontologyId, revisionId, v.read, v.report);
      indexes.put(key, one);
      while (indexes.size() > indexBound) indexes.remove(indexes.keySet().iterator().next());
    }
    return one;
  }

  /** What one question of the service is answered with, given the session it names. */
  JsonElement answer(String question, JsonObject query) {
    Index at = index(query.get("ontologyId").getAsString(), query.get("revisionId").getAsString());
    switch (question) {
      case "describe": return describe(at, query);
      case "query": return query(at, query);
      case "options": return options(at, query);
      default: throw new Refusal("not-found", "There is no question “" + question + "”.");
    }
  }

  // ---------------------------------------------------------------- the records

  /** What an entity is searched by: its name, its other names, its IRI in full and with a prefix, and its definition. */
  private static List<Text> textsOf(OntologyView read, ClassInput e, boolean synonyms) {
    List<Text> texts = new ArrayList<>();
    texts.add(new Text("name", null, e.label()));
    if (synonyms) {
      for (String s : read.synonymsOf(org.semanticweb.owlapi.model.IRI.create(e.iri())).stream().filter((x) -> !x.isEmpty()).toList()) {
        texts.add(new Text("label", "skos:altLabel", s));
      }
    }
    if (e.iri() != null) {
      texts.add(new Text("iri", null, e.iri()));
      String curie = read.compactIri(e.iri());
      if (curie != null) texts.add(new Text("curie", null, curie));
    }
    String description = read.descriptionOf(org.semanticweb.owlapi.model.IRI.create(e.iri()));
    if (!description.isEmpty()) texts.add(new Text("description", null, description));
    return texts;
  }

  private static List<Record> classes(OntologyView read) {
    Map<String, List<String>> children = new LinkedHashMap<>();
    for (String[] link : read.subClassOf) children.computeIfAbsent(link[1], (k) -> new ArrayList<>()).add(link[0]);
    Map<String, List<String>> parents = new LinkedHashMap<>();
    for (String[] link : read.subClassOf) parents.computeIfAbsent(link[0], (k) -> new ArrayList<>()).add(link[1]);
    List<Record> out = new ArrayList<>();
    for (ClassInput c : read.classes.values()) {
      List<String> supers = parents.getOrDefault(c.iri(), List.of());
      int subs = children.getOrDefault(c.iri(), List.of()).size();
      int restrictions = read.restrictions.getOrDefault(c.iri(), List.of()).size() + c.anonymousSuperclasses() + read.expressionAxioms.getOrDefault(c.iri(), 0);
      Map<String, Object> sort = new LinkedHashMap<>();
      sort.put("name", c.label());
      sort.put("iri", c.iri());
      sort.put("superclasses", supers.size());
      sort.put("subclasses", subs);
      sort.put("restrictions", restrictions);
      sort.put("relations", read.degrees.getOrDefault(c.iri(), 0));
      Map<String, List<String>> facts = new LinkedHashMap<>();
      List<String> position = new ArrayList<>();
      if (supers.isEmpty()) position.add("root");
      if (subs == 0) position.add("leaf");
      facts.put("position", position);
      facts.put("multipleInheritance", flag(supers.size() > 1));
      facts.put("assertedRestrictions", flag(restrictions > 0));
      out.add(new Record(c.iri(), c.iri(), c.label(), textsOf(read, c, true), sort, facts));
    }
    return out;
  }

  private static List<Record> objectProperties(OntologyView read) {
    List<Record> out = new ArrayList<>();
    for (ClassInput p : read.objectProps.values()) {
      Map<String, Object> sort = new LinkedHashMap<>();
      sort.put("name", p.label());
      sort.put("iri", p.iri());
      sort.put("relations", read.propUses.getOrDefault(p.iri(), 0));
      Map<String, List<String>> facts = new LinkedHashMap<>();
      facts.put("domain", withOrWithout(domainOf(read, p.iri(), false)));
      facts.put("range", withOrWithout(rangeOf(read, p.iri())));
      facts.put("characteristics", read.characteristics.getOrDefault(p.iri(), List.of()));
      facts.put("inverse", flag(!read.inverses.getOrDefault(p.iri(), List.of()).isEmpty()));
      out.add(new Record(p.iri(), p.iri(), p.label(), textsOf(read, p, false), sort, facts));
    }
    return out;
  }

  /** Whether the property has a domain, by hand or following where it is used. */
  private static boolean domainOf(OntologyView read, String iri, boolean data) {
    List<List<String>> axioms = data ? read.dataDomains.getOrDefault(iri, List.of()) : read.objDomains.getOrDefault(iri, List.of());
    if (axioms.isEmpty()) return false;
    if (read.domainStated.contains(iri)) return true;
    List<String> used = data ? read.attached.getOrDefault(iri, List.of()) : read.usedFrom.getOrDefault(iri, List.of());
    return !used.isEmpty();
  }

  private static boolean rangeOf(OntologyView read, String iri) {
    List<List<String>> axioms = read.objRanges.getOrDefault(iri, List.of());
    if (axioms.isEmpty()) return false;
    if (read.rangeStated.contains(iri)) return true;
    return !read.usedTo.getOrDefault(iri, List.of()).isEmpty();
  }

  private static List<Record> dataProperties(OntologyView read) {
    List<Record> out = new ArrayList<>();
    for (ClassInput p : read.dataProps.values()) {
      Map<String, Object> sort = new LinkedHashMap<>();
      sort.put("name", p.label());
      sort.put("iri", p.iri());
      String datatype = read.datatypeKeys.getOrDefault(p.iri(), List.of()).size() == 1 ? read.datatypeKeys.get(p.iri()).get(0) : null;
      sort.put("range", datatype == null ? "" : datatype.substring(datatype.indexOf(':') + 1));
      sort.put("relations", read.degrees.getOrDefault(p.iri(), 0));
      Map<String, List<String>> facts = new LinkedHashMap<>();
      facts.put("domain", withOrWithout(domainOf(read, p.iri(), true)));
      facts.put("range", withOrWithout(read.hasDataRange.contains(p.iri())));
      facts.put("functional", flag(read.functional.contains(p.iri())));
      facts.put("datatype", read.datatypeKeys.getOrDefault(p.iri(), List.of()));
      out.add(new Record(p.iri(), p.iri(), p.label(), textsOf(read, p, false), sort, facts));
    }
    return out;
  }

  private static List<Record> annotationProperties(OntologyView read) {
    List<Record> out = new ArrayList<>();
    for (ClassInput p : read.annProps.values()) {
      Map<String, Object> sort = new LinkedHashMap<>();
      sort.put("name", p.label());
      sort.put("iri", p.iri());
      sort.put("superproperties", read.annParents.getOrDefault(p.iri(), List.of()).size());
      sort.put("annotations", read.annUses.getOrDefault(p.iri(), 0));
      Map<String, List<String>> facts = new LinkedHashMap<>();
      facts.put("domain", withOrWithout(read.domainStated.contains(p.iri())));
      facts.put("range", withOrWithout(read.rangeStated.contains(p.iri())));
      facts.put("superproperty", flag(!read.annParents.getOrDefault(p.iri(), List.of()).isEmpty()));
      facts.put("subproperty", flag(!read.annChildren.getOrDefault(p.iri(), List.of()).isEmpty()));
      out.add(new Record(p.iri(), p.iri(), p.label(), textsOf(read, p, false), sort, facts));
    }
    return out;
  }

  private static List<Record> individuals(OntologyView read) {
    List<Record> out = new ArrayList<>();
    for (ClassInput i : read.individuals.values()) {
      List<String> types = read.assertedTypes.getOrDefault(i.iri(), List.of());
      List<String> names = new ArrayList<>();
      for (String t : types) {
        ClassInput cls = read.classes.get(t);
        if (cls != null) names.add(cls.label());
      }
      Map<String, Object> sort = new LinkedHashMap<>();
      sort.put("name", i.label());
      sort.put("iri", i.iri());
      sort.put("type", String.join(", ", names));
      sort.put("relations", read.degrees.getOrDefault(i.iri(), 0));
      Map<String, List<String>> facts = new LinkedHashMap<>();
      facts.put("assertedType", types);
      out.add(new Record(i.iri(), i.iri(), i.label(), textsOf(read, i, false), sort, facts));
    }
    return out;
  }

  /** What a relationship is called, by what it is (src/entities/local.ts makers.relationship). */
  private static String kindText(String kind, String predicate) {
    if (predicate != null && !predicate.isEmpty()) return "Standard property (" + predicate + ")";
    return switch (kind) {
      case "object" -> "Object property";
      case "generalization" -> "Is a (generalization)";
      case "instanceOf" -> "Is Instance Of";
      case "property" -> "Has data property";
      default -> "Relationship (plain)";
    };
  }

  private static List<Record> relationships(OntologyView read) {
    List<Record> out = new ArrayList<>();
    int n = 0;
    for (String[] r : read.relations) {
      String kind = r[0];
      String from = r[1];
      String to = r[2];
      // A standard property carries its predicate where the label of an ordinary relation is; its label is none.
      String label = kind.equals("standard") ? "" : r[3];
      String predicate = kind.equals("standard") ? r[3] : "";
      String prop = r[4];
      String choice = switch (kind) {
        case "standard" -> "standard";
        case "object" -> "object";
        case "generalization" -> "generalization";
        case "instanceOf" -> "instanceOf";
        case "property" -> "property";
        default -> "plain";
      };
      String text = kindText(choice, predicate);
      String fromName = read.entityName(from);
      String toName = read.entityName(to);
      List<Text> texts = new ArrayList<>();
      texts.add(new Text("name", null, label));
      texts.add(new Text("from", null, fromName));
      texts.add(new Text("to", null, toName));
      texts.add(new Text("kind", null, text));
      Map<String, Object> sort = new LinkedHashMap<>();
      sort.put("from", fromName);
      sort.put("label", label);
      sort.put("to", toName);
      sort.put("kind", text);
      Map<String, List<String>> facts = new LinkedHashMap<>();
      facts.put("kind", List.of(choice));
      facts.put("from", List.of(from));
      facts.put("to", List.of(to));
      out.add(new Record("rel-" + n++, null, label.isEmpty() ? text : label, texts, sort, facts));
    }
    return out;
  }

  /** The classes there are to choose from for a filter whose options are entities. The asserted-class filter
   *  lists only the classes an individual is stated to be an instance of; the inferred one lists every class. */
  private static List<Candidate> classCandidates(OntologyView read, boolean assertedOnly) {
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (List<String> types : read.assertedTypes.values()) {
      for (String t : types) counts.put(t, counts.getOrDefault(t, 0) + 1);
    }
    List<Candidate> out = new ArrayList<>();
    for (ClassInput c : read.classes.values()) {
      if (assertedOnly && !counts.containsKey(c.iri())) continue;
      String curie = read.compactIri(c.iri());
      out.add(new Candidate(c.iri(), c.label(), assertedOnly ? counts.get(c.iri()) : null,
          (c.label() + "\n" + c.label() + "\n" + (curie == null ? "" : curie)).toLowerCase(), c.iri().toLowerCase()));
    }
    return out;
  }

  private static List<Candidate> endCandidates(OntologyView read, String end) {
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (String[] r : read.relations) {
      String at = end.equals("from") ? r[1] : r[2];
      counts.put(at, counts.getOrDefault(at, 0) + 1);
    }
    List<Candidate> out = new ArrayList<>();
    for (Map.Entry<String, Integer> at : counts.entrySet()) {
      ClassInput e = read.classes.get(at.getKey());
      if (e == null) e = read.individuals.get(at.getKey());
      if (e == null) e = read.dataProps.get(at.getKey());
      if (e == null) continue;
      String curie = read.compactIri(e.iri());
      out.add(new Candidate(e.iri(), e.label(), at.getValue(), (e.label() + "\n" + e.label() + "\n" + (curie == null ? "" : curie)).toLowerCase(), e.iri().toLowerCase()));
    }
    return out;
  }

  private static List<String> flag(boolean on) {
    return on ? List.of("yes") : List.of();
  }

  private static List<String> withOrWithout(boolean has) {
    return List.of(has ? "with" : "without");
  }

  // ---------------------------------------------------------------- describe

  private static final String ON = "yes";

  private JsonObject describe(Index at, JsonObject query) {
    String kind = query.get("kind").getAsString();
    List<Record> records = at.records.getOrDefault(kind, List.of());
    JsonObject out = new JsonObject();
    out.addProperty("kind", kind);
    out.addProperty("revisionId", query.get("revisionId").getAsString());
    out.addProperty("total", records.size());
    out.add("sorts", sorts(kind));
    out.add("filters", filters(at, kind));
    return out;
  }

  private JsonArray sorts(String kind) {
    JsonArray out = new JsonArray();
    String[][] specs = switch (kind) {
      case "class" -> new String[][] {{"name", "Name", null}, {"iri", "IRI", null}, {"superclasses", "Asserted superclasses", "yes"}, {"subclasses", "Subclasses", "yes"}, {"restrictions", "Asserted restrictions", "yes"}, {"relations", "Relationships", "yes"}};
      case "objectProperty" -> new String[][] {{"name", "Name", null}, {"iri", "IRI", null}, {"relations", "Relationships that use it", "yes"}};
      case "dataProperty" -> new String[][] {{"name", "Name", null}, {"iri", "IRI", null}, {"range", "Datatype", null}, {"relations", "Relationships", "yes"}};
      case "annotationProperty" -> new String[][] {{"name", "Name", null}, {"iri", "IRI", null}, {"superproperties", "Superproperties", "yes"}, {"annotations", "Annotations", "yes"}};
      case "individual" -> new String[][] {{"name", "Name", null}, {"iri", "IRI", null}, {"type", "Type (asserted classes)", null}, {"relations", "Relationships", "yes"}};
      default -> new String[][] {{"from", "From", null}, {"label", "Property / label", null}, {"to", "To", null}, {"kind", "Kind", null}};
    };
    for (String[] s : specs) {
      JsonObject one = new JsonObject();
      one.addProperty("id", s[0]);
      one.addProperty("label", s[1]);
      if (s[2] != null) one.addProperty("numeric", true);
      out.add(one);
    }
    return out;
  }

  private JsonArray filters(Index at, String kind) {
    JsonArray out = new JsonArray();
    switch (kind) {
      case "class" -> {
        List<Record> all = at.records.get("class");
        JsonObject position = filter("position", "Hierarchy", "Root: a class with no asserted superclass. Leaf: one with no subclass. Both together: one that stands alone.", "all");
        position.add("options", options(List.of(option("root", "Root", countOf(all, "position", "root")), option("leaf", "Leaf", countOf(all, "position", "leaf")))));
        out.add(position);
        JsonObject multiple = filter("multipleInheritance", "Multiple inheritance", "More than one asserted superclass.", "flag");
        multiple.add("options", options(List.of(option(ON, "Yes", countOf(all, "multipleInheritance", ON)))));
        out.add(multiple);
        JsonObject assertedRestrictions = filter("assertedRestrictions", "Asserted restrictions", "A restriction by a property, or a class expression, is stated on the class itself.", "flag");
        assertedRestrictions.add("options", options(List.of(option(ON, "Yes", countOf(all, "assertedRestrictions", ON)))));
        out.add(assertedRestrictions);
        JsonObject inferredRestrictions = filter("inferredRestrictions", "Inferred restrictions", "A restriction is inherited from a superclass or an equivalent class the reasoner entails.", "flag");
        inferredRestrictions.add("options", options(List.of(option(ON, "Yes", null))));
        unavailableIfNeeded(at, inferredRestrictions);
        out.add(inferredRestrictions);
        JsonObject unsatisfiable = filter("unsatisfiable", "Unsatisfiable", "The reasoner finds that the class can never have an instance.", "flag");
        unsatisfiable.add("options", options(List.of(option(ON, "Yes", null))));
        unavailableIfNeeded(at, unsatisfiable);
        out.add(unsatisfiable);
      }
      case "objectProperty" -> {
        List<Record> all = at.records.get("objectProperty");
        out.add(setOrNot("domain", "Domain", "Whether the property has a domain, set by hand or following where it is used.", all));
        out.add(setOrNot("range", "Range", "Whether the property has a range, set by hand or following where it is used.", all));
        JsonObject characteristics = filter("characteristics", "Characteristics", "Properties that have every characteristic chosen.", "all");
        List<JsonObject> opts = new ArrayList<>();
        for (String[] c : new String[][] {{"functional", "Functional"}, {"inverseFunctional", "Inverse functional"}, {"transitive", "Transitive"}, {"symmetric", "Symmetric"}, {"asymmetric", "Asymmetric"}, {"reflexive", "Reflexive"}, {"irreflexive", "Irreflexive"}}) {
          opts.add(option(c[0], c[1], countOf(all, "characteristics", c[0])));
        }
        characteristics.add("options", options(opts));
        out.add(characteristics);
        JsonObject inverse = filter("inverse", "Has an inverse", "Another property is stated to be its inverse (owl:inverseOf), on either of the two.", "flag");
        inverse.add("options", options(List.of(option(ON, "Yes", countOf(all, "inverse", ON)))));
        out.add(inverse);
      }
      case "dataProperty" -> {
        List<Record> all = at.records.get("dataProperty");
        out.add(setOrNot("domain", "Domain", "Whether the property has a domain, set by hand or following the classes it is attached to.", all));
        out.add(setOrNot("range", "Range", "Whether the property has a datatype as its range.", all));
        JsonObject functional = filter("functional", "Functional", "Each thing has at most one value (owl:FunctionalProperty).", "flag");
        functional.add("options", options(List.of(option(ON, "Yes", countOf(all, "functional", ON)))));
        out.add(functional);
        Map<String, Integer> ranges = new LinkedHashMap<>();
        for (Record r : all) for (String dt : r.facts().getOrDefault("datatype", List.of())) ranges.put(dt, ranges.getOrDefault(dt, 0) + 1);
        JsonObject datatype = filter("datatype", "Datatype", "Properties whose range is any of the datatypes chosen.", "any");
        List<JsonObject> opts = new ArrayList<>();
        List<Map.Entry<String, Integer>> byLabel = new ArrayList<>(ranges.entrySet());
        byLabel.sort((x, y) -> Sorting.COLLATOR.compare(rangeLabel(x.getKey()), rangeLabel(y.getKey())));
        for (Map.Entry<String, Integer> r : byLabel) opts.add(option(r.getKey(), rangeLabel(r.getKey()), r.getValue()));
        datatype.add("options", options(opts));
        out.add(datatype);
      }
      case "annotationProperty" -> {
        List<Record> all = at.records.get("annotationProperty");
        out.add(setOrNot("domain", "Domain", "Whether the property has a domain (rdfs:domain).", all));
        out.add(setOrNot("range", "Range", "Whether the property has a range (rdfs:range).", all));
        JsonObject superproperty = filter("superproperty", "Has a superproperty", "Another annotation property it specialises (rdfs:subPropertyOf).", "flag");
        superproperty.add("options", options(List.of(option(ON, "Yes", countOf(all, "superproperty", ON)))));
        out.add(superproperty);
        JsonObject subproperty = filter("subproperty", "Has a subproperty", "Another annotation property that specialises it.", "flag");
        subproperty.add("options", options(List.of(option(ON, "Yes", countOf(all, "subproperty", ON)))));
        out.add(subproperty);
      }
      case "individual" -> {
        JsonObject assertedType = filter("assertedType", "Asserted class", "Individuals stated to be an instance of any of the classes chosen (rdf:type).", "any");
        assertedType.add("options", new JsonArray());
        assertedType.addProperty("entities", true);
        out.add(assertedType);
        JsonObject inferredType = filter("inferredType", "Inferred class", "Individuals the reasoner entails to be an instance of any of the classes chosen: stated, or following from the hierarchy, a domain or a range.", "any");
        inferredType.add("options", new JsonArray());
        inferredType.addProperty("entities", true);
        unavailableIfNeeded(at, inferredType);
        out.add(inferredType);
      }
      default -> {
        List<Record> all = at.records.get("relationship");
        Map<String, Integer> kinds = new LinkedHashMap<>();
        for (Record r : all) {
          String value = r.facts().get("kind").get(0);
          kinds.put(value, kinds.getOrDefault(value, 0) + 1);
        }
        JsonObject kindFilter = filter("kind", "Kind", "Relationships of any of the kinds chosen.", "any");
        List<JsonObject> opts = new ArrayList<>();
        for (Map.Entry<String, Integer> k : kinds.entrySet()) {
          opts.add(option(k.getKey(), sortOf(k.getKey()), k.getValue()));
        }
        opts.sort((x, y) -> Sorting.COLLATOR.compare(x.get("label").getAsString(), y.get("label").getAsString()));
        kindFilter.add("options", options(opts));
        out.add(kindFilter);
        JsonObject from = filter("from", "From", "Relationships that start at any of the entities chosen.", "any");
        from.add("options", new JsonArray());
        from.addProperty("entities", true);
        out.add(from);
        JsonObject to = filter("to", "To", "Relationships that end at any of the entities chosen.", "any");
        to.add("options", new JsonArray());
        to.addProperty("entities", true);
        out.add(to);
      }
    }
    return out;
  }

  /** What a relationship kind is called in the filter's options: the text the row shows it by. */
  private String sortOf(String choice) {
    return switch (choice) {
      case "object" -> "Object property";
      case "generalization" -> "Is a (generalization)";
      case "instanceOf" -> "Is Instance Of";
      case "property" -> "Has data property";
      case "standard" -> "Standard property";
      default -> "Relationship (plain)";
    };
  }

  /** Why a filter that rests on a reasoner is not answered, when the reasoner has no answer. */
  private void unavailableIfNeeded(Index at, JsonObject filter) {
    // The report the index was made with says whether the reasoner has an answer.
    JsonObject report = at.report;
    String consistency = report.has("consistency") ? report.get("consistency").getAsString() : "unknown";
    if (consistency.equals("inconsistent")) {
      filter.addProperty("unavailable", "the reasoner finds the ontology inconsistent, and from a contradiction anything follows. See the Validation tab.");
    } else if (report.has("status") && report.get("status").getAsString().equals("failed")) {
      filter.addProperty("unavailable", "the reasoner found no answer for this ontology.");
    }
  }

  private static int countOf(List<Record> records, String filter, String value) {
    int n = 0;
    for (Record r : records) if (r.facts().getOrDefault(filter, List.of()).contains(value)) n++;
    return n;
  }

  private static JsonObject option(String value, String label, Integer count) {
    JsonObject o = new JsonObject();
    o.addProperty("value", value);
    o.addProperty("label", label);
    if (count != null) o.addProperty("count", count);
    return o;
  }

  private static JsonArray options(List<JsonObject> list) {
    JsonArray out = new JsonArray();
    for (JsonObject o : list) out.add(o);
    return out;
  }

  private static JsonObject filter(String id, String label, String about, String type) {
    JsonObject o = new JsonObject();
    o.addProperty("id", id);
    o.addProperty("label", label);
    o.addProperty("about", about);
    o.addProperty("type", type);
    return o;
  }

  private static JsonObject setOrNot(String id, String label, String about, List<Record> all) {
    JsonObject o = filter(id, label, about, "one");
    JsonArray opts = new JsonArray();
    opts.add(option("with", "Set", countOf(all, id, "with")));
    opts.add(option("without", "Not set", countOf(all, id, "without")));
    o.add("options", opts);
    return o;
  }

  /** What a datatype is called where it is shown: "string" for xsd:string. */
  private static String rangeLabel(String key) {
    int colon = key.indexOf(':');
    return colon < 0 ? key : key.substring(colon + 1);
  }

  // ---------------------------------------------------------------- query

  private JsonObject query(Index at, JsonObject query) {
    String kind = query.get("kind").getAsString();
    List<Record> all = at.records.getOrDefault(kind, List.of());
    List<String> words = wordsOf(query.has("search") && query.get("search").isJsonPrimitive() ? query.get("search").getAsString() : null);
    List<String> notes = new ArrayList<>();
    JsonObject sort = query.has("sort") && query.get("sort").isJsonObject() ? query.getAsJsonObject("sort") : null;
    if (sort != null) {
      boolean known = false;
      for (JsonElement s : sorts(kind)) if (s.getAsJsonObject().get("id").getAsString().equals(sort.get("by").getAsString())) known = true;
      if (!known) throw new Refusal("invalid", "This kind of entity is not sorted by \"" + sort.get("by").getAsString() + "\".");
    }

    // Each filter that is on, as a question put to one entity.
    JsonArray specs = filters(at, kind);
    List<JsonObject> chosen = chosen(specs, query.has("filters") && query.get("filters").isJsonObject() ? query.getAsJsonObject("filters") : null);
    List<JsonObject> tests = new ArrayList<>();
    for (JsonObject chosenFilter : chosen) {
      JsonObject spec = chosenFilter.getAsJsonObject("spec");
      List<String> values = new ArrayList<>();
      for (JsonElement e : chosenFilter.getAsJsonArray("values")) values.add(e.getAsString());
      if (spec.has("unavailable")) {
        // It is let be rather than answered with nothing: what is listed is then at least true.
        notes.add("“" + spec.get("label").getAsString() + "” is not applied: " + spec.get("unavailable").getAsString());
        continue;
      }
      JsonObject costly = costly(at, kind, spec.get("id").getAsString());
      if (costly != null && costly.has("note")) notes.add(costly.get("note").getAsString());
      JsonObject test = new JsonObject();
      test.add("spec", spec);
      test.add("values", new JsonArray());
      for (String v : values) test.getAsJsonArray("values").add(v);
      test.add("costly", costly == null ? JsonNull.INSTANCE : costly);
      test.add("type", new com.google.gson.JsonPrimitive(spec.get("type").getAsString()));
      tests.add(test);
    }

    List<Record> left = new ArrayList<>();
    if (!tests.isEmpty() || !words.isEmpty()) {
      for (Record r : all) {
        boolean keep = true;
        for (JsonObject test : tests) {
          JsonObject spec = test.getAsJsonObject("spec");
          List<String> values = new ArrayList<>();
          for (JsonElement e : test.getAsJsonArray("values")) values.add(e.getAsString());
          List<String> has = new ArrayList<>();
          if (test.has("costly") && test.get("costly").isJsonObject()) has = factsOf(test.getAsJsonObject("costly"), r);
          else has = r.facts().getOrDefault(spec.get("id").getAsString(), List.of());
          boolean pass = spec.get("type").getAsString().equals("all") ? values.stream().allMatch(has::contains) : values.stream().anyMatch(has::contains);
          if (!pass) {
            keep = false;
            break;
          }
        }
        if (keep && (!words.isEmpty() && !found(r, words))) keep = false;
        if (keep) left.add(r);
      }
    } else {
      left.addAll(all);
    }
    if (sort != null) {
      String by = sort.get("by").getAsString();
      int sign = sort.has("dir") && sort.get("dir").getAsString().equals("desc") ? -1 : 1;
      List<Record> ordered = new ArrayList<>(left);
      ordered.sort((a, b) -> compareSort(a.sort().get(by), b.sort().get(by), sign));
      left = ordered;
    }
    double offsetGiven = query.has("offset") && query.get("offset").isJsonPrimitive() && query.get("offset").getAsJsonPrimitive().isNumber() ? query.get("offset").getAsDouble() : 0;
    int offset = Math.max(0, Math.min(left.size(), (int) Math.floor(offsetGiven)));
    int limit = clamp(query.get("limit"), PAGE, MAX_PAGE);
    JsonArray rows = new JsonArray();
    for (Record r : left.subList(offset, Math.min(offset + limit, left.size()))) {
      JsonObject row = new JsonObject();
      row.addProperty("key", r.key());
      if (r.iri() != null) row.addProperty("iri", r.iri());
      row.addProperty("label", r.label());
      if (!words.isEmpty()) {
        JsonArray matches = new JsonArray();
        for (JsonObject m : matchesOf(r, words)) matches.add(m);
        row.add("matches", matches);
      }
      rows.add(row);
    }
    JsonObject out = new JsonObject();
    out.addProperty("kind", kind);
    out.addProperty("revisionId", query.get("revisionId").getAsString());
    out.add("rows", rows);
    out.addProperty("offset", offset);
    out.addProperty("total", all.size());
    out.addProperty("matched", left.size());
    JsonArray wordsOut = new JsonArray();
    for (String w : words) wordsOut.add(w);
    out.add("words", wordsOut);
    JsonArray notesOut = new JsonArray();
    for (String n : notes) notesOut.add(n);
    out.add("notes", notesOut);
    return out;
  }

  private static List<String> factsOf(JsonObject costly, Record r) {
    JsonObject facts = costly.has("facts") ? costly.getAsJsonObject("facts") : new JsonObject();
    List<String> out = new ArrayList<>();
    if (facts.has(r.key())) for (JsonElement e : facts.getAsJsonArray(r.key())) out.add(e.getAsString());
    return out;
  }

  private static int compareSort(Object x, Object y, int sign) {
    boolean noX = x == null || (x instanceof String s && s.isEmpty());
    boolean noY = y == null || (y instanceof String s && s.isEmpty());
    if (noX || noY) return noX == noY ? 0 : noX ? 1 : -1;
    if (x instanceof Integer a && y instanceof Integer b) return sign * (a - b);
    return sign * Sorting.COLLATOR.compare(String.valueOf(x), String.valueOf(y));
  }

  /** The filters of a question as they will be applied: the ones that are on, each with the options chosen. */
  private static List<JsonObject> chosen(JsonArray specs, JsonObject values) {
    List<JsonObject> out = new ArrayList<>();
    if (values == null) return out;
    for (Map.Entry<String, JsonElement> at : values.entrySet()) {
      String id = at.getKey();
      JsonObject spec = null;
      for (JsonElement s : specs) if (s.getAsJsonObject().get("id").getAsString().equals(id)) spec = s.getAsJsonObject();
      if (spec == null) throw new Refusal("invalid", "There is no filter \"" + id + "\" for this kind of entity.");
      if (!at.getValue().isJsonArray()) throw new Refusal("invalid", "The filter \"" + id + "\" is given as a list of the options chosen.");
      Set<String> picked = new LinkedHashSet<>();
      for (JsonElement e : at.getValue().getAsJsonArray()) picked.add(e.getAsString());
      if (picked.isEmpty()) continue;
      List<String> kept = new ArrayList<>(picked);
      if (spec.get("type").getAsString().equals("one") || spec.get("type").getAsString().equals("flag")) kept = kept.subList(0, 1);
      JsonObject one = new JsonObject();
      one.add("spec", spec);
      JsonArray vs = new JsonArray();
      for (String v : kept) vs.add(v);
      one.add("values", vs);
      out.add(one);
    }
    return out;
  }

  /** The words of a search: what is between the spaces, in lower case, each once. */
  private static List<String> wordsOf(String search) {
    Set<String> words = new LinkedHashSet<>();
    for (String w : (search == null ? "" : search).toLowerCase().split("\\s+")) if (!w.isEmpty()) words.add(w);
    List<String> out = new ArrayList<>(words);
    return out.subList(0, Math.min(8, out.size()));
  }

  /** Whether a word is written the way part of an IRI is. */
  private static boolean iriLike(String word) {
    return word.matches(".*[:/#.].*");
  }

  private static boolean found(Record r, List<String> words) {
    List<String> texts = new ArrayList<>();
    for (Text t : r.texts()) texts.add(t.text().toLowerCase());
    return words.stream().allMatch((w) -> {
      for (int i = 0; i < texts.size(); i++) {
        if (texts.get(i).contains(w) && (!r.texts().get(i).field().equals("iri") || iriLike(w))) return true;
      }
      return false;
    });
  }

  /** Where in a text the words are: every occurrence of each, the ones that touch or overlap made one. */
  private static List<int[]> rangesIn(String text, List<String> words) {
    List<int[]> found = new ArrayList<>();
    for (String w : words) {
      for (int at = text.indexOf(w); at >= 0; at = text.indexOf(w, at + w.length())) found.add(new int[] {at, at + w.length()});
    }
    found.sort((a, b) -> a[0] != b[0] ? a[0] - b[0] : a[1] - b[1]);
    List<int[]> out = new ArrayList<>();
    for (int[] r : found) {
      if (!out.isEmpty() && r[0] <= out.get(out.size() - 1)[1]) {
        out.get(out.size() - 1)[1] = Math.max(out.get(out.size() - 1)[1], r[1]);
      } else {
        out.add(r);
      }
    }
    return out;
  }

  private static List<JsonObject> matchesOf(Record r, List<String> words) {
    List<String> texts = new ArrayList<>();
    for (Text t : r.texts()) texts.add(t.text().toLowerCase());
    List<JsonObject> out = new ArrayList<>();
    for (int i = 0; i < texts.size() && out.size() < 4; i++) {
      List<String> here = new ArrayList<>();
      for (String w : words) {
        if (texts.get(i).contains(w) && (!r.texts().get(i).field().equals("iri") || iriLike(w))) here.add(w);
      }
      if (here.isEmpty()) continue;
      JsonObject m = new JsonObject();
      m.addProperty("field", r.texts().get(i).field());
      if (r.texts().get(i).property() != null) m.addProperty("property", r.texts().get(i).property());
      m.addProperty("text", r.texts().get(i).text());
      JsonArray ranges = new JsonArray();
      for (int[] range : rangesIn(texts.get(i), here)) {
        JsonArray one = new JsonArray();
        one.add(range[0]);
        one.add(range[1]);
        ranges.add(one);
      }
      m.add("ranges", ranges);
      out.add(m);
    }
    return out;
  }

  /** What a filter that rests on a reasoner has for each entity, and the note that says so. */
  private JsonObject costly(Index at, String kind, String filter) {
    if (filter.equals("unsatisfiable") || filter.equals("inferredType") || filter.equals("inferredRestrictions")) {
      SessionStructure.View v = structure.reasonedView(at.ontologyId, at.revisionId);
      JsonObject report = v.report;
      String engine = report.has("engine") ? report.get("engine").getAsString() : "HermiT";
      String version = report.has("engineVersion") ? report.get("engineVersion").getAsString() : "";
      String covers = engine.startsWith("ELK") ? "OWL 2 EL" : "OWL 2 DL";
      String label = engine + (version.isEmpty() ? "" : " " + version) + " (" + covers + ")";
      String credit = label + (report.has("status") && report.get("status").getAsString().equals("complete") ? "" : ", which did not finish over all of the ontology");
      JsonObject facts = new JsonObject();
      if (filter.equals("unsatisfiable")) {
        for (JsonElement e : report.has("unsatisfiable") ? report.getAsJsonArray("unsatisfiable") : new JsonArray()) {
          String iri = e.getAsString();
          if (v.read.classes.containsKey(iri)) facts.add(iri, oneOf(ON));
        }
        return withNote(facts, "Unsatisfiable classes are as found by " + credit + ".");
      }
      if (filter.equals("inferredType")) {
        for (Map.Entry<String, List<String>> types : v.read.assertedTypes.entrySet()) {
          facts.add(types.getKey(), arrayOf(types.getValue()));
        }
        for (JsonElement e : report.has("types") ? report.getAsJsonArray("types") : new JsonArray()) {
          JsonObject pair = e.getAsJsonObject();
          String individual = pair.get("individual").getAsString();
          if (facts.has(individual) && v.read.individuals.containsKey(individual)) {
            List<String> have = new ArrayList<>();
            for (JsonElement one : facts.getAsJsonArray(individual)) have.add(one.getAsString());
            String cls = pair.get("class").getAsString();
            if (v.read.classes.containsKey(cls) && !have.contains(cls)) have.add(cls);
            facts.add(individual, arrayOf(have));
          }
        }
        return withNote(facts, "Inferred class memberships are as entailed by " + credit + ".");
      }
      if (filter.equals("inferredRestrictions")) {
        // A restriction the reasoner puts a class under another that has one it lacks: what the DL reasoner entails.
        ClassHierarchy inferred = v.inferred;
        if (inferred == null) return withNote(facts, "Inferred restrictions are those inherited through what " + label + " entails.");
        for (ClassInput c : v.read.classes.values()) {
          Set<String> own = new LinkedHashSet<>();
          for (OntologyView.Restriction r : v.read.restrictions.getOrDefault(c.iri(), List.of())) own.add(r.key());
          boolean inherits = false;
          for (String up : inferred.ancestorsOf(c.iri())) {
            for (OntologyView.Restriction r : v.read.restrictions.getOrDefault(up, List.of())) {
              if (!own.contains(r.key())) inherits = true;
            }
          }
          if (inherits) facts.add(c.iri(), oneOf(ON));
        }
        return withNote(facts, "Inferred restrictions are those inherited through what " + label + " entails.");
      }
    }
    return null;
  }

  private static JsonArray oneOf(String value) {
    JsonArray a = new JsonArray();
    a.add(value);
    return a;
  }

  private static JsonArray arrayOf(java.util.Collection<String> values) {
    JsonArray a = new JsonArray();
    for (String v : values) a.add(v);
    return a;
  }

  private static JsonObject withNote(JsonObject facts, String note) {
    JsonObject o = new JsonObject();
    o.add("facts", facts);
    o.addProperty("note", note);
    return o;
  }

  // ---------------------------------------------------------------- options

  private JsonObject options(Index at, JsonObject query) {
    String kind = query.get("kind").getAsString();
    String filter = query.get("filter").getAsString();
    JsonObject spec = null;
    for (JsonElement f : filters(at, kind)) {
      if (f.getAsJsonObject().get("id").getAsString().equals(filter)) spec = f.getAsJsonObject();
    }
    if (spec == null || !spec.has("entities")) throw new Refusal("invalid", "There is no filter \"" + filter + "\" with entities to choose from for this kind of entity.");
    String search = query.has("search") && query.get("search").isJsonPrimitive() ? query.get("search").getAsString() : "";
    List<String> words = wordsOf(search);
    List<Candidate> all = at.candidates.getOrDefault(kind + "|" + filter, List.of());
    List<Candidate> hits = words.isEmpty() ? all : all.stream().filter((c) -> words.stream().allMatch((w) -> c.text().contains(w) || (iriLike(w) && c.iri() != null && c.iri().contains(w)))).toList();
    String q = search.trim().toLowerCase();
    List<Candidate> best = new ArrayList<>(hits);
    best.sort((x, y) -> {
      int score = score(x, q) - score(y, q);
      if (score != 0) return score;
      if ((x.count() == null ? 0 : x.count()) != (y.count() == null ? 0 : y.count())) return (y.count() == null ? 0 : y.count()) - (x.count() == null ? 0 : x.count());
      return Sorting.COLLATOR.compare(x.label(), y.label());
    });
    int limit = clamp(query.get("limit"), 8, 50);
    JsonObject out = new JsonObject();
    JsonArray opts = new JsonArray();
    for (Candidate c : best.subList(0, Math.min(limit, best.size()))) {
      JsonObject one = new JsonObject();
      one.addProperty("value", c.value());
      one.addProperty("label", c.label());
      if (c.count() != null) one.addProperty("count", c.count());
      opts.add(one);
    }
    out.add("options", opts);
    out.addProperty("total", hits.size());
    return out;
  }

  private static int score(Candidate c, String q) {
    if (q.isEmpty()) return 0;
    String label = c.label().toLowerCase();
    return label.equals(q) ? 0 : label.startsWith(q) ? 1 : label.contains(q) ? 2 : 3;
  }

  private static int clamp(JsonElement n, int fallback, int max) {
    if (n == null || !n.isJsonPrimitive() || !n.getAsJsonPrimitive().isNumber() || !Double.isFinite(n.getAsDouble()) || n.getAsDouble() <= 0) return fallback;
    return Math.min(max, (int) Math.floor(n.getAsDouble()));
  }
}
