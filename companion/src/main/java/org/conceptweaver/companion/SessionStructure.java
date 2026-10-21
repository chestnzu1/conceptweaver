package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * The Structure Explorer's questions, answered from a held ontology over the OWL API (roadmap
 * task 3.4): a port of src/structure/service.ts, graph.ts, propertyGraph.ts, compare.ts and
 * analyze.ts, kept behaviour for behaviour so that the page's own service and this one answer
 * the same questions the same way (FR-M6-7).
 */
@Service
final class SessionStructure {

  /** The questions, by the name each is asked under (src/structure/http.ts). */
  static final String[] QUESTIONS = {"children", "branches", "paths", "summary", "search", "compare", "explain", "analyze", "members",
      "propertyChildren", "propertyBranches", "propertyPaths", "propertySummary"};

  /** How many subclasses a page holds unless asked otherwise, and the most it ever holds. */
  static final int PAGE = 200;
  static final int MAX_PAGE = 1000;
  /** How many classes one question may ask the subclasses of. */
  static final int MAX_BRANCHES = 500;
  /** How many ways down to a class are given unless asked otherwise, and at most. */
  static final int PATHS = 10;
  static final int MAX_PATHS = 100;
  /** How many classes a search gives unless asked otherwise, and at most. */
  static final int FOUND = 12;
  static final int MAX_FOUND = 200;

  private final ReasoningService reasoning;
  private final ReasoningSettings settings;
  private final Sessions sessions;
  private final int viewBound;

  /** A hierarchy measured: the numbers handed out, and the classes behind each of them. */
  static final class Analysis {
    JsonObject result;
    /** The classes of each set, with the largest number first where they have one. */
    final Map<String, List<JsonObject>> sorted = new LinkedHashMap<>();

    Analysis(JsonObject result) {
      this.result = result;
    }
  }

  /** One held session, with the hierarchies built from it and what was worked out of them. */
  static final class View {
    final OntologyView read;
    final ClassHierarchy asserted;
    final PropertyHierarchy props;
    OntologyView.Reasoned reasoned;
    ClassHierarchy inferred;
    /** The report /reason gives for the session, once it has been asked. */
    JsonObject report;
    /** The analysis of each mode, once it is measured. */
    final Map<String, Analysis> analyses = new LinkedHashMap<>();

    View(OntologyView read) {
      this.read = read;
      this.asserted = new ClassHierarchy().build(new ClassGraphInput(new ArrayList<>(read.classes.values()), read.subClassOf, read.equivalent, read.disjoint));
      List<PropertyInput> properties = new ArrayList<>();
      for (ClassInput p : read.objectProps.values()) properties.add(new PropertyInput(new PropertyRef(p.iri(), p.label(), "object", p.external()), p.search()));
      for (ClassInput p : read.dataProps.values()) properties.add(new PropertyInput(new PropertyRef(p.iri(), p.label(), "data", p.external()), p.search()));
      this.props = new PropertyHierarchy().build(new PropertyGraphInput(properties, read.subPropertyOf));
    }
  }

  /** The views of the sessions recently asked, the one most recently asked of last. */
  private final Map<String, View> views = new LinkedHashMap<>(8, 0.75f, true);

  SessionStructure(ReasoningService reasoning, ReasoningSettings settings, Sessions sessions, @Value("${conceptweaver.sessions.cache:8}") int viewBound) {
    this.reasoning = reasoning;
    this.settings = settings;
    this.sessions = sessions;
    this.viewBound = viewBound;
  }

  private View view(String ontologyId, String revisionId) {
    Sessions.Held held = sessions.held(ontologyId, revisionId);
    String key = ontologyId + "\n" + revisionId;
    View one = views.get(key);
    if (one == null) {
      one = new View(new OntologyView(held));
      views.put(key, one);
      while (views.size() > viewBound) views.remove(views.keySet().iterator().next());
    }
    return one;
  }

  /** What one question of the service is answered with, given the session it names. */
  JsonElement answer(String question, JsonObject query) {
    View v = view(query.get("ontologyId").getAsString(), query.get("revisionId").getAsString());
    switch (question) {
      case "children": return children(v, query);
      case "branches": return branches(v, query);
      case "paths": return paths(v, query);
      case "summary": return summary(v, query);
      case "search": return search(v, query);
      case "compare": return compare(v, query);
      case "explain": return explain(v, query);
      case "analyze": return analyze(v, query);
      case "members": return members(v, query);
      case "propertyChildren": return propertyChildren(v, query);
      case "propertyBranches": return propertyBranches(v, query);
      case "propertyPaths": return propertyPaths(v, query);
      case "propertySummary": return propertySummary(v, query);
      default: throw new Refusal("not-found", "There is no question “" + question + "”.");
    }
  }

  // ---------------------------------------------------------------- shared pieces

  private static int clamp(JsonElement n, int fallback, int max) {
    if (n == null || !n.isJsonPrimitive() || !n.getAsJsonPrimitive().isNumber() || !Double.isFinite(n.getAsDouble())) return fallback;
    return Math.max(1, Math.min(max, (int) Math.floor(n.getAsDouble())));
  }

  private static String optString(JsonObject o, String key) {
    return o.has(key) && o.get(key).isJsonPrimitive() ? o.get(key).getAsString() : null;
  }

  private static JsonObject refHead(JsonObject query) {
    JsonObject head = new JsonObject();
    head.addProperty("ontologyId", query.get("ontologyId").getAsString());
    head.addProperty("revisionId", query.get("revisionId").getAsString());
    return head;
  }

  /** What is asserted is read off as it stands: no reasoner has a part in it, and none of it is missing. */
  private static JsonObject assertedProvenance(String revisionId) {
    JsonObject p = new JsonObject();
    p.add("engine", JsonNull.INSTANCE);
    p.addProperty("revisionId", revisionId);
    p.addProperty("status", "current");
    p.addProperty("completeness", "complete");
    p.add("notes", new JsonArray());
    return p;
  }

  /** The reasoner's answer over the session, mapped to what the inferred hierarchy is built from; worked out once. */
  private OntologyView.Reasoned reasoned(View v) {
    if (v.reasoned == null) {
      JsonObject request = new JsonObject();
      request.addProperty("ontology", v.read.held.document());
      JsonArray imports = new JsonArray();
      for (String[] imp : v.read.held.imports()) {
        JsonObject one = new JsonObject();
        one.addProperty("iri", imp[0]);
        one.addProperty("text", imp[1]);
        imports.add(one);
      }
      request.add("imports", imports);
      request.addProperty("timeoutMs", settings.timeoutMs);
      request.addProperty("reasoner", "auto");
      JsonObject explanations = new JsonObject();
      explanations.addProperty("perSubject", 1);
      explanations.addProperty("max", 25);
      explanations.addProperty("timeoutMs", 20_000);
      request.add("explanations", explanations);
      v.report = reasoning.run(request);
      v.reasoned = v.read.mapReport(v.report);
    }
    return v.reasoned;
  }

  /** The view of a session, with its reasoner asked: for the entity service's filters that rest on one. */
  View reasonedView(String ontologyId, String revisionId) {
    View v = view(ontologyId, revisionId);
    reasoned(v);
    return v;
  }

  /** The inferred hierarchy of the session, or null where the reasoner has no current answer. */
  private ClassHierarchy inferred(View v) {
    OntologyView.Reasoned r = reasoned(v);
    if (r.entailed() == null) return null;
    if (v.inferred == null) v.inferred = new ClassHierarchy().buildInferred(new ClassGraphInput(new ArrayList<>(v.read.classes.values()), v.read.subClassOf, v.read.equivalent, v.read.disjoint), r.entailed());
    return v.inferred;
  }

  private static String modeOf(JsonObject query) {
    return query.has("mode") && query.get("mode").getAsString().equals("inferred") ? "inferred" : "asserted";
  }

  /** The hierarchy a question asks about, with where it comes from. */
  private record Answering(ClassHierarchy hierarchy, JsonObject provenance) {}

  private Answering answering(View v, JsonObject query) {
    if (modeOf(query).equals("asserted")) return new Answering(v.asserted, assertedProvenance(query.get("revisionId").getAsString()));
    OntologyView.Reasoned r = reasoned(v);
    return new Answering(inferred(v), r.provenance());
  }

  /** A cursor is this service's own business: where in the list the next page starts. */
  private static int offsetOf(String cursor) {
    if (cursor == null) return 0;
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("^at:(\\d+)$").matcher(cursor);
    if (!m.matches()) throw new Refusal("invalid", "That is not a place in this list to go on from.");
    return Integer.parseInt(m.group(1));
  }

  static JsonObject classRefJson(ClassRef ref) {
    JsonObject o = new JsonObject();
    o.addProperty("iri", ref.iri());
    o.addProperty("label", ref.label());
    if (ref.external()) o.addProperty("external", true);
    if (ref.builtin()) o.addProperty("builtin", true);
    return o;
  }

  private static JsonObject propertyRefJson(PropertyRef ref) {
    JsonObject o = new JsonObject();
    o.addProperty("iri", ref.iri());
    o.addProperty("label", ref.label());
    o.addProperty("type", ref.type());
    if (ref.external()) o.addProperty("external", true);
    return o;
  }

  /** A class the hierarchy does not have, as the comparison names it: by its IRI alone. */
  private static JsonObject bareRef(String iri) {
    JsonObject o = new JsonObject();
    o.addProperty("iri", iri);
    o.addProperty("label", iri);
    return o;
  }

  /** In order of label, and of IRI where two have the same label. */
  private static int byRef(JsonObject a, JsonObject b) {
    int by = Sorting.COLLATOR.compare(a.get("label").getAsString(), b.get("label").getAsString());
    return by != 0 ? by : a.get("iri").getAsString().compareTo(b.get("iri").getAsString());
  }

  private static List<JsonObject> refsSorted(List<JsonObject> refs) {
    refs.sort(SessionStructure::byRef);
    return refs;
  }

  // ---------------------------------------------------------------- the class hierarchy

  private JsonObject pageOf(View v, JsonObject query, Answering answering, JsonObject asked) {
    JsonObject head = refHead(query);
    head.addProperty("mode", modeOf(query));
    String parentIri = optString(asked, "parentIri");
    if (parentIri != null) head.addProperty("parentIri", parentIri);
    ClassHierarchy h = answering.hierarchy();
    if (h == null) {
      head.add("nodes", new JsonArray());
      head.addProperty("offset", 0);
      head.addProperty("total", 0);
      head.add("provenance", answering.provenance());
      return head;
    }
    ClassEntry parent = parentIri == null ? null : h.entryOf(parentIri);
    List<String> all = parent == null ? h.top : parent.children;
    Set<String> matched = null;
    Set<String> kept = null;
    String filter = optString(asked, "filter");
    if (filter != null && !filter.trim().isEmpty()) {
      matched = h.matched(filter);
      kept = h.kept(matched);
    }
    List<String> list = kept == null ? all : all.stream().filter(kept::contains).toList();
    int limit = clamp(asked.get("limit"), PAGE, MAX_PAGE);
    String cursor = optString(asked, "cursor");
    String through = optString(asked, "through");
    int wanted = -1;
    if (cursor == null && through != null) wanted = list.indexOf(h.alias.getOrDefault(through, through));
    int from = wanted < 0 ? offsetOf(cursor) : (wanted / limit) * limit;
    int to = from + limit;
    JsonArray nodes = new JsonArray();
    for (String iri : list.subList(from, Math.min(to, list.size()))) nodes.add(nodeJson(h, iri, kept, matched, parent == null ? null : parent.ref.iri()));
    head.add("nodes", nodes);
    head.addProperty("offset", from);
    head.addProperty("total", list.size());
    if (to < list.size()) head.addProperty("nextCursor", "at:" + to);
    if (matched != null) head.addProperty("matched", matched.size());
    head.add("provenance", answering.provenance());
    return head;
  }

  private static JsonObject nodeJson(ClassHierarchy h, String iri, Set<String> kept, Set<String> matched, String parent) {
    ClassEntry e = h.entryOf(iri);
    JsonObject node = new JsonObject();
    node.add("class", classRefJson(e.ref));
    JsonArray equivalents = new JsonArray();
    for (ClassRef eq : e.equivalents) equivalents.add(classRefJson(eq));
    node.add("equivalents", equivalents);
    node.addProperty("childCount", kept == null ? e.children.size() : e.children.stream().filter(kept::contains).count());
    node.addProperty("parentCount", e.parents.size());
    if (e.inCycle) node.addProperty("inCycle", true);
    if (matched != null && matched.contains(e.ref.iri())) node.addProperty("match", true);
    if (parent != null && h.entailedOnly.contains(e.ref.iri() + "\n" + parent)) node.addProperty("entailedOnly", true);
    if (e.unsatisfiable) node.addProperty("unsatisfiable", true);
    return node;
  }

  private JsonObject children(View v, JsonObject query) {
    return pageOf(v, query, answering(v, query), query);
  }

  private JsonElement branches(View v, JsonObject query) {
    JsonArray parents = query.has("parents") && query.get("parents").isJsonArray() ? query.getAsJsonArray("parents") : new JsonArray();
    if (parents.size() > MAX_BRANCHES) throw new Refusal("invalid", "No more than " + MAX_BRANCHES + " classes can be asked about at once.");
    Answering from = answering(v, query);
    JsonArray out = new JsonArray();
    for (JsonElement parent : parents) {
      JsonObject asked = parent.getAsJsonObject().deepCopy();
      if (query.has("filter")) asked.add("filter", query.get("filter"));
      out.add(pageOf(v, query, from, asked));
    }
    return out;
  }

  private JsonObject paths(View v, JsonObject query) {
    Answering answering = answering(v, query);
    JsonObject out = refHead(query);
    out.addProperty("mode", modeOf(query));
    ClassHierarchy h = answering.hierarchy();
    if (h == null) {
      out.add("paths", new JsonArray());
      out.addProperty("truncated", false);
      out.add("provenance", answering.provenance());
      return out;
    }
    int limit = clamp(query.get("limit"), PATHS, MAX_PATHS);
    boolean[] truncated = {false};
    List<List<ClassRef>> paths = h.pathsTo(query.get("classIri").getAsString(), limit, truncated);
    JsonArray list = new JsonArray();
    for (List<ClassRef> path : paths) {
      JsonArray one = new JsonArray();
      for (ClassRef ref : path) one.add(classRefJson(ref));
      list.add(one);
    }
    out.add("paths", list);
    out.addProperty("truncated", truncated[0]);
    out.add("provenance", answering.provenance());
    return out;
  }

  private JsonObject summary(View v, JsonObject query) {
    String iri = query.get("classIri").getAsString();
    ClassEntry stated = v.asserted.entryOf(iri);
    OntologyView.Reasoned reasoned = reasoned(v);
    ClassHierarchy entailed = inferred(v);
    JsonObject inferredPart = new JsonObject();
    inferredPart.add("provenance", reasoned.provenance());
    if (entailed != null) {
      ClassEntry e = entailed.entryOf(iri);
      JsonArray equivalents = new JsonArray();
      List<ClassRef> all = new ArrayList<>();
      all.add(e.ref);
      all.addAll(e.equivalents);
      for (ClassRef c : all) if (!c.iri().equals(iri) && !e.unsatisfiable) equivalents.add(classRefJson(c));
      inferredPart.add("equivalents", equivalents);
      inferredPart.addProperty("unsatisfiable", e.unsatisfiable);
      JsonArray superclasses = new JsonArray();
      if (!e.unsatisfiable) {
        for (String up : e.parents) {
          JsonObject one = new JsonObject();
          one.add("class", classRefJson(entailed.entries.get(up).ref));
          one.addProperty("stated", !entailed.entailedOnly.contains(e.ref.iri() + "\n" + up));
          superclasses.add(one);
        }
        inferredPart.add("superclasses", sortedByRef(superclasses, "class"));
      } else {
        inferredPart.add("superclasses", new JsonArray());
      }
    }
    JsonObject out = refHead(query);
    out.add("class", classRefJson(stated.ref));
    JsonObject asserted = new JsonObject();
    JsonArray supers = new JsonArray();
    for (String up : stated.parents) supers.add(classRefJson(v.asserted.entries.get(up).ref));
    asserted.add("superclasses", sortedByRef(supers, null));
    asserted.addProperty("anonymousSuperclasses", stated.anonymousSuperclasses);
    JsonArray equivalents = new JsonArray();
    for (ClassRef eq : stated.equivalents) equivalents.add(classRefJson(eq));
    asserted.add("equivalents", equivalents);
    out.add("asserted", asserted);
    out.add("inferred", inferredPart);
    ClassHierarchy hierarchy = modeOf(query).equals("asserted") ? v.asserted : entailed;
    if (hierarchy != null) {
      out.add("position", positionOf(hierarchy, iri, modeOf(query), modeOf(query).equals("asserted") ? assertedProvenance(query.get("revisionId").getAsString()) : reasoned.provenance()));
    }
    return out;
  }

  private static JsonObject positionOf(ClassHierarchy h, String iri, String mode, JsonObject provenance) {
    ClassEntry e = h.entryOf(iri);
    JsonObject position = new JsonObject();
    position.addProperty("mode", mode);
    position.addProperty("superclasses", e.parents.size());
    position.addProperty("subclasses", e.children.size());
    position.addProperty("descendants", h.descendantsOf(iri));
    int[] depth = h.depthsOf().get(e.ref.iri());
    JsonObject depths = new JsonObject();
    depths.addProperty("min", depth[0]);
    depths.addProperty("max", depth[1]);
    position.add("depth", depths);
    JsonArray ancestors = new JsonArray();
    for (String up : h.ancestorsOf(iri)) ancestors.add(up);
    position.add("ancestors", ancestors);
    position.addProperty("inCycle", e.inCycle);
    position.add("provenance", provenance);
    return position;
  }

  private static JsonArray sortedByRef(JsonArray list, String key) {
    List<JsonObject> items = new ArrayList<>();
    for (JsonElement e : list) items.add(e.getAsJsonObject());
    items.sort((x, y) -> byRef(key == null ? x : x.getAsJsonObject(key), key == null ? y : y.getAsJsonObject(key)));
    JsonArray out = new JsonArray();
    for (JsonObject o : items) out.add(o);
    return out;
  }

  private JsonObject search(View v, JsonObject query) {
    JsonObject out = refHead(query);
    String text = optString(query, "text");
    int[] total = {0};
    List<ClassRef> matches = v.asserted.searchClasses(text == null ? "" : text, clamp(query.get("limit"), FOUND, MAX_FOUND), total);
    JsonArray list = new JsonArray();
    for (ClassRef ref : matches) list.add(classRefJson(ref));
    out.add("matches", list);
    out.addProperty("total", total[0]);
    return out;
  }

  private JsonObject explain(View v, JsonObject query) {
    String subIri = query.get("subClassIri").getAsString();
    String supIri = query.get("superClassIri").getAsString();
    ClassRef sub = v.asserted.entryOf(subIri).ref;
    ClassRef sup = v.asserted.entryOf(supIri).ref;
    JsonObject head = refHead(query);
    head.add("sub", classRefJson(sub));
    head.add("sup", classRefJson(sup));
    // Stated links that lead from the one to the other are their own explanation.
    List<ClassRef> chain = v.asserted.chainBetween(sub.iri(), sup.iri());
    if (chain != null) {
      JsonArray statements = new JsonArray();
      // The chain runs from the upper class down to the lower one; the statements are given from the top down.
      for (int i = chain.size() - 1; i >= 1; i--) statements.add(chain.get(i).label() + " SubClassOf " + chain.get(i - 1).label());
      head.addProperty("available", true);
      head.addProperty("basis", chain.size() == 2 ? "asserted" : "asserted-chain");
      head.add("statements", statements);
      head.add("provenance", assertedProvenance(query.get("revisionId").getAsString()));
      return head;
    }
    OntologyView.Reasoned reasoned = reasoned(v);
    ClassHierarchy entailed = inferred(v);
    java.util.function.Function<String, JsonObject> none = (reason) -> {
      JsonObject out = head.deepCopy();
      out.addProperty("available", false);
      out.add("statements", new JsonArray());
      out.addProperty("reason", reason);
      out.add("provenance", reasoned.provenance());
      return out;
    };
    if (entailed == null) return none.apply("No reasoner’s answer is to be had for the ontology as it is, so nothing is known beyond what is stated, and that does not make the one a subclass of the other.");
    ClassEntry place = entailed.entryOf(sub.iri());
    String up = entailed.entryOf(sup.iri()).ref.iri();
    if (!place.ref.iri().equals(up) && !entailed.ancestorsOf(sub.iri()).contains(up)) return none.apply("It is not entailed: the reasoner does not find the one to be a subclass of the other.");
    // This service asks the reasoner for no justification of a subclass link, so none is made up.
    return none.apply("The reasoner entails it and gives no justification for it here.");
  }

  // ---------------------------------------------------------------- comparing two classes

  private JsonObject compare(View v, JsonObject query) {
    String aIri = query.get("classAIri").getAsString();
    String bIri = query.get("classBIri").getAsString();
    ClassHierarchy asserted = v.asserted;
    ClassHierarchy inferred = inferred(v);
    OntologyView.Reasoned reasoned = reasoned(v);
    JsonObject reasoning = reasoned.provenance();

    java.util.function.Function<String, JsonObject> refOf = (iri) -> {
      ClassEntry e = asserted.entries.get(iri);
      return e == null ? bareRef(iri) : classRefJson(e.ref);
    };

    record Lineage(JsonObject self, Set<String> direct, Set<String> chain, Set<String> entailed, boolean unsatisfiable) {}
    Map<String, Lineage> lineages = new LinkedHashMap<>();
    java.util.function.Function<String, Lineage> lineage = new java.util.function.Function<>() {
      @Override
      public Lineage apply(String iri) {
        Lineage hit = lineages.get(iri);
        if (hit != null) return hit;
        ClassEntry e = asserted.entryOf(iri);
        Set<String> entailed = null;
        boolean unsatisfiable = false;
        if (inferred != null) {
          ClassEntry place = inferred.entryOf(iri);
          unsatisfiable = place.unsatisfiable;
          // Everything is true of a class that can have no instance, so what is above it says nothing: only what is stated is read.
          if (!unsatisfiable) {
            entailed = new LinkedHashSet<>();
            List<String> at = new ArrayList<>();
            at.add(place.ref.iri());
            at.addAll(inferred.ancestorsOf(iri));
            for (String one : at) {
              ClassEntry p = inferred.entries.get(one);
              if (p.ref.builtin()) continue;
              entailed.add(p.ref.iri());
              for (ClassRef same : p.equivalents) entailed.add(same.iri());
            }
            entailed.remove(iri);
          }
        }
        Lineage made = new Lineage(classRefJson(e.ref), new LinkedHashSet<>(e.parents), new LinkedHashSet<>(asserted.ancestorsOf(iri)), entailed, unsatisfiable);
        lineages.put(iri, made);
        return made;
      }
    };
    // How `lower` is known to be under `upper`, if it is.
    java.util.function.BiFunction<String, String, String> below = (lower, upper) -> {
      if (lower.equals(upper) || !asserted.entries.containsKey(lower) || !asserted.entries.containsKey(upper)) return null;
      Lineage l = lineage.apply(lower);
      return l.direct().contains(upper) ? "asserted" : l.chain().contains(upper) ? "asserted-chain" : l.entailed() != null && l.entailed().contains(upper) ? "entailed" : null;
    };

    Lineage A = lineage.apply(aIri);
    Lineage B = lineage.apply(bIri);
    boolean verified = reasoned.entailed() != null && inferred != null;

    // ---- how the two stand to each other
    java.util.function.Function<Lineage, Set<String>> up = (l) -> {
      Set<String> out = new LinkedHashSet<>(l.chain());
      if (l.entailed() != null) out.addAll(l.entailed());
      return out;
    };
    Set<String> upA = up.apply(A);
    Set<String> upB = up.apply(B);
    JsonObject relationship = new JsonObject();
    if (aIri.equals(bIri)) {
      relationship.addProperty("kind", "same");
    } else {
      String ab = below.apply(aIri, bIri);
      String ba = below.apply(bIri, aIri);
      boolean statedSame = asserted.entryOf(aIri).equivalents.stream().anyMatch((e) -> e.iri().equals(bIri));
      if (statedSame) {
        relationship.addProperty("kind", "equivalent");
        relationship.addProperty("basis", "asserted");
      } else if (ab != null && ba != null) {
        relationship.addProperty("kind", "equivalent");
        relationship.addProperty("basis", ab.equals("entailed") || ba.equals("entailed") ? "entailed" : "asserted-chain");
      } else if (ab != null) {
        relationship.addProperty("kind", "a-below-b");
        relationship.addProperty("basis", ab);
        if (!ab.equals("entailed")) {
          JsonArray chain = new JsonArray();
          for (ClassRef c : chainOrEmpty(asserted, aIri, bIri)) chain.add(classRefJson(c));
          relationship.add("chain", chain);
        }
      } else if (ba != null) {
        relationship.addProperty("kind", "b-below-a");
        relationship.addProperty("basis", ba);
        if (!ba.equals("entailed")) {
          JsonArray chain = new JsonArray();
          for (ClassRef c : chainOrEmpty(asserted, bIri, aIri)) chain.add(classRefJson(c));
          relationship.add("chain", chain);
        }
      } else {
        // Neither is under the other. What they have directly above them in common makes them siblings.
        java.util.function.BiFunction<Lineage, String, Set<String>> directOf = (l, iri) -> {
          Set<String> out = new LinkedHashSet<>(l.direct());
          if (inferred != null && l.entailed() != null) {
            for (String p : inferred.entryOf(iri).parents) {
              out.add(p);
              for (ClassRef e : inferred.entries.get(p).equivalents) out.add(e.iri());
            }
          }
          return out;
        };
        Set<String> directA = directOf.apply(A, aIri);
        Set<String> directB = directOf.apply(B, bIri);
        List<String> parents = directA.stream().filter((iri) -> directB.contains(iri) && asserted.entries.containsKey(iri)).toList();
        if (!parents.isEmpty()) {
          relationship.addProperty("kind", "siblings");
          JsonArray shared = new JsonArray();
          List<JsonObject> refs = new ArrayList<>();
          for (String iri : parents) refs.add(refOf.apply(iri));
          for (JsonObject r : refsSorted(refs)) shared.add(r);
          relationship.add("shared", shared);
        } else {
          // The nearest classes above both: the common ones that are not above another common one.
          Set<String> common = new LinkedHashSet<>(upA);
          common.retainAll(upB);
          Set<String> further = new LinkedHashSet<>();
          for (String iri : common) further.addAll(up.apply(lineage.apply(iri)));
          relationship.addProperty("kind", "unrelated");
          JsonArray shared = new JsonArray();
          List<JsonObject> refs = new ArrayList<>();
          for (String iri : common) if (!further.contains(iri)) refs.add(refOf.apply(iri));
          for (JsonObject r : refsSorted(refs)) shared.add(r);
          relationship.add("shared", shared);
        }
      }
    }
    relationship.add("shared", relationship.has("shared") ? relationship.get("shared") : new JsonArray());
    relationship.addProperty("verified", verified);

    // ---- whether they can share an instance at all
    JsonObject disjointness = null;
    if (!aIri.equals(bIri)) {
      outer:
      for (String x : withFirst(aIri, upA)) {
        ClassEntry at = asserted.entries.get(x);
        if (at == null) continue;
        for (ClassRef stated : at.disjoints) {
          String y = stated.iri();
          if (!y.equals(bIri) && !upB.contains(y)) continue;
          if (x.equals(aIri) && y.equals(bIri)) {
            disjointness = new JsonObject();
            disjointness.addProperty("basis", "asserted");
            JsonObject between = new JsonObject();
            between.add("a", A.self());
            between.add("b", B.self());
            disjointness.add("between", between);
          } else {
            disjointness = new JsonObject();
            disjointness.addProperty("basis", "follows");
            JsonObject between = new JsonObject();
            between.add("a", refOf.apply(x));
            between.add("b", refOf.apply(y));
            disjointness.add("between", between);
            if (!x.equals(aIri)) disjointness.addProperty("aBasis", below.apply(aIri, x));
            if (!y.equals(bIri)) disjointness.addProperty("bBasis", below.apply(bIri, y));
          }
          break outer;
        }
      }
    }

    // ---- the classes above them
    java.util.function.BiFunction<String, String, String> standing = (iri, one) -> {
      String basis = below.apply(one, iri);
      return iri.equals(one) ? "self" : basis == null ? "absent" : basis;
    };
    Set<String> both = new LinkedHashSet<>(upA);
    both.addAll(upB);
    List<JsonObject> superclasses = new ArrayList<>();
    for (String iri : both) {
      if (!asserted.entries.containsKey(iri)) continue;
      JsonObject one = new JsonObject();
      one.add("class", refOf.apply(iri));
      one.addProperty("a", standing.apply(iri, aIri));
      one.addProperty("b", standing.apply(iri, bIri));
      superclasses.add(one);
    }
    superclasses.sort((x, y) -> {
      int xAny = (x.get("a").getAsString().equals("absent") || x.get("b").getAsString().equals("absent")) ? 1 : 0;
      int yAny = (y.get("a").getAsString().equals("absent") || y.get("b").getAsString().equals("absent")) ? 1 : 0;
      if (xAny != yAny) return xAny - yAny;
      int xA = x.get("a").getAsString().equals("absent") ? 1 : 0;
      int yA = y.get("a").getAsString().equals("absent") ? 1 : 0;
      if (xA != yA) return xA - yA;
      return byRef(x.getAsJsonObject("class"), y.getAsJsonObject("class"));
    });

    // ---- what is asserted of each, and what each inherits
    java.util.function.Function<Set<String>, List<String>> inOrder = (iris) -> {
      List<JsonObject> refs = new ArrayList<>();
      for (String iri : iris) refs.add(refOf.apply(iri));
      List<String> out = new ArrayList<>();
      for (JsonObject r : refsSorted(refs)) out.add(r.get("iri").getAsString());
      return out;
    };
    java.util.function.BiFunction<Lineage, String, List<String[]>> sources = (l, iri) -> {
      List<String[]> out = new ArrayList<>();
      for (String x : inOrder.apply(l.direct())) out.add(new String[] {x, "asserted"});
      Set<String> chainOnly = new LinkedHashSet<>(l.chain());
      chainOnly.removeAll(l.direct());
      chainOnly.remove(iri);
      for (String x : inOrder.apply(chainOnly)) out.add(new String[] {x, "asserted-chain"});
      if (l.entailed() != null) {
        Set<String> entailedOnly = new LinkedHashSet<>(l.entailed());
        entailedOnly.removeAll(l.chain());
        entailedOnly.remove(iri);
        for (String x : inOrder.apply(entailedOnly)) out.add(new String[] {x, "entailed"});
      }
      return out;
    };
    List<String[]> fromA = sources.apply(A, aIri);
    List<String[]> fromB = sources.apply(B, bIri);
    Set<String> asked = new LinkedHashSet<>(List.of(aIri, bIri));
    for (String[] s : fromA) asked.add(s[0]);
    for (String[] s : fromB) asked.add(s[0]);
    Map<String, List<JsonObject>> statedAxioms = new LinkedHashMap<>();
    for (String iri : asked) {
      List<JsonObject> axioms = new ArrayList<>();
      for (OntologyView.Restriction r : v.read.restrictions.getOrDefault(iri, List.of())) axioms.add(restrictionJson(r));
      statedAxioms.put(iri, axioms);
    }

    record Row(JsonObject axiom, JsonObject a, JsonObject b, List<JsonObject> relations, List<String> unverified) {}
    Map<String, Row> rows = new LinkedHashMap<>();
    java.util.function.Function<JsonObject, Row> row = (axiom) -> {
      Row r = rows.get(axiom.get("key").getAsString());
      if (r == null) {
        JsonObject a = new JsonObject();
        a.addProperty("state", "absent");
        JsonObject b = new JsonObject();
        b.addProperty("state", "absent");
        r = new Row(axiom, a, b, new ArrayList<>(), new ArrayList<>());
        rows.put(axiom.get("key").getAsString(), r);
      }
      return r;
    };
    class Place {
      void place(String side, String iri, List<String[]> from) {
        for (JsonObject axiom : statedAxioms.getOrDefault(iri, List.of())) {
          Row r = row.apply(axiom);
          JsonObject standing = new JsonObject();
          standing.addProperty("state", "own");
          rows.put(axiom.get("key").getAsString(), side.equals("a") ? new Row(r.axiom(), standing, r.b(), r.relations(), r.unverified()) : new Row(r.axiom(), r.a(), standing, r.relations(), r.unverified()));
        }
        for (String[] source : from) {
          for (JsonObject axiom : statedAxioms.getOrDefault(source[0], List.of())) {
            Row r = row.apply(axiom);
            JsonObject at = side.equals("a") ? r.a() : r.b();
            if (at.get("state").getAsString().equals("own")) continue;
            JsonObject inherited = new JsonObject();
            inherited.addProperty("state", "inherited");
            JsonArray sources = new JsonArray();
            if (at.has("from")) for (JsonElement e : at.getAsJsonArray("from")) sources.add(e);
            JsonObject one = new JsonObject();
            one.add("class", refOf.apply(source[0]));
            one.addProperty("basis", source[1]);
            sources.add(one);
            inherited.add("from", sources);
            rows.put(axiom.get("key").getAsString(), side.equals("a") ? new Row(r.axiom(), inherited, r.b(), r.relations(), r.unverified()) : new Row(r.axiom(), r.a(), inherited, r.relations(), r.unverified()));
          }
        }
      }
    }
    Place place = new Place();
    place.place("a", aIri, fromA);
    if (!bIri.equals(aIri)) place.place("b", bIri, fromB);
    else for (String key : new ArrayList<>(rows.keySet())) {
      Row r = rows.get(key);
      rows.put(key, new Row(r.axiom(), r.a(), r.a(), r.relations(), r.unverified()));
    }

    // ---- which of those axioms imply which, on evidence
    Map<String, List<String>> byProperty = new LinkedHashMap<>();
    for (String key : rows.keySet()) {
      Row r = rows.get(key);
      if (!r.axiom().get("kind").getAsString().equals("restriction")) continue;
      String prop = r.axiom().getAsJsonObject("property").get("iri").getAsString();
      byProperty.computeIfAbsent(prop, (k) -> new ArrayList<>()).add(key);
    }
    for (List<String> group : byProperty.values()) {
      for (String xKey : group) {
        for (String yKey : group) {
          if (xKey.equals(yKey)) continue;
          Row x = rows.get(xKey);
          Row y = rows.get(yKey);
          Object forward = implies(x.axiom(), y.axiom(), below, refOf);
          if (forward == UNKNOWN) {
            if (!verified) x.unverified().add(yKey);
            continue;
          }
          if (forward == FALSE) continue;
          Object back = implies(y.axiom(), x.axiom(), below, refOf);
          JsonObject relation = new JsonObject();
          relation.addProperty("kind", back != UNKNOWN && back != FALSE ? "equivalent" : "stronger");
          relation.addProperty("than", yKey);
          relation.add("evidence", (JsonArray) forward);
          x.relations().add(relation);
        }
      }
    }

    List<Row> ordered = new ArrayList<>(rows.values());
    ordered.sort((x, y) -> {
      int rank = rank(x.a(), x.b()) - rank(y.a(), y.b());
      if (rank != 0) return rank;
      return Sorting.COLLATOR.compare(x.axiom().get("text").getAsString(), y.axiom().get("text").getAsString());
    });
    JsonArray axioms = new JsonArray();
    for (Row r : ordered) {
      JsonObject one = new JsonObject();
      one.add("axiom", r.axiom());
      one.add("a", r.a());
      one.add("b", r.b());
      JsonArray relations = new JsonArray();
      for (JsonObject rel : r.relations()) relations.add(rel);
      one.add("relations", relations);
      JsonArray unverified = new JsonArray();
      for (String key : r.unverified()) unverified.add(key);
      one.add("unverified", unverified);
      axioms.add(one);
    }
    java.util.function.Predicate<JsonObject> has = (s) -> !s.get("state").getAsString().equals("absent");
    long shared = ordered.stream().filter((r) -> has.test(r.a()) && has.test(r.b())).count();
    long onlyA = ordered.stream().filter((r) -> has.test(r.a()) && !has.test(r.b())).count();
    long onlyB = ordered.stream().filter((r) -> !has.test(r.a()) && has.test(r.b())).count();
    long ownA = ordered.stream().filter((r) -> r.a().get("state").getAsString().equals("own")).count();
    long ownB = ordered.stream().filter((r) -> r.b().get("state").getAsString().equals("own")).count();
    long inheritedA = ordered.stream().filter((r) -> r.a().get("state").getAsString().equals("inherited")).count();
    long inheritedB = ordered.stream().filter((r) -> r.b().get("state").getAsString().equals("inherited")).count();

    JsonArray notes = new JsonArray();
    if (ordered.stream().anyMatch((r) -> r.axiom().get("kind").getAsString().equals("expression"))) {
      notes.add("Class expressions (intersections, unions, nested restrictions, enumerations) are compared as they are written. What they mean is not worked out, so one is never said to be stronger than another.");
    }
    if (byProperty.size() > 1) notes.add("Restrictions are compared only where they are on the same property. A restriction on a sub-property is not set against one on the property above it.");
    if (ordered.stream().anyMatch((r) -> r.axiom().get("kind").getAsString().equals("restriction") && r.axiom().getAsJsonObject("filler").get("kind").getAsString().equals("datatype"))) {
      notes.add("Datatypes are not compared with each other: restrictions on a data property are related only where they name the same datatype.");
    }
    for (Lineage l : List.of(A, B)) {
      if (l.unsatisfiable()) notes.add("“" + l.self().get("label").getAsString() + "” can never have an instance, according to the reasoner. Everything is true of such a class, so only what is stated of it and above it is shown as inherited.");
    }

    JsonObject out = refHead(query);
    out.add("a", A.self());
    out.add("b", B.self());
    out.add("relationship", relationship);
    if (disjointness != null) out.add("disjointness", disjointness);
    if (inferred != null) {
      JsonObject unsat = new JsonObject();
      unsat.addProperty("a", A.unsatisfiable());
      unsat.addProperty("b", B.unsatisfiable());
      out.add("unsatisfiable", unsat);
    }
    JsonArray supers = new JsonArray();
    for (JsonObject s : superclasses) supers.add(s);
    out.add("superclasses", supers);
    JsonObject stated = new JsonObject();
    JsonObject statedA = new JsonObject();
    JsonArray equivalentsA = new JsonArray();
    for (ClassRef eq : asserted.entryOf(aIri).equivalents) equivalentsA.add(classRefJson(eq));
    statedA.add("equivalents", equivalentsA);
    JsonArray disjointsA = new JsonArray();
    for (ClassRef d : asserted.entryOf(aIri).disjoints) disjointsA.add(classRefJson(d));
    statedA.add("disjoints", disjointsA);
    JsonObject statedB = new JsonObject();
    JsonArray equivalentsB = new JsonArray();
    for (ClassRef eq : asserted.entryOf(bIri).equivalents) equivalentsB.add(classRefJson(eq));
    statedB.add("equivalents", equivalentsB);
    JsonArray disjointsB = new JsonArray();
    for (ClassRef d : asserted.entryOf(bIri).disjoints) disjointsB.add(classRefJson(d));
    statedB.add("disjoints", disjointsB);
    stated.add("a", statedA);
    stated.add("b", statedB);
    out.add("stated", stated);
    out.add("axioms", axioms);
    JsonObject counts = new JsonObject();
    counts.addProperty("shared", shared);
    counts.addProperty("onlyA", onlyA);
    counts.addProperty("onlyB", onlyB);
    counts.addProperty("ownA", ownA);
    counts.addProperty("ownB", ownB);
    counts.addProperty("inheritedA", inheritedA);
    counts.addProperty("inheritedB", inheritedB);
    out.add("counts", counts);
    out.add("reasoning", reasoning);
    out.add("notes", notes);
    return out;
  }

  private static int rank(JsonObject a, JsonObject b) {
    String as = a.get("state").getAsString();
    String bs = b.get("state").getAsString();
    return !as.equals("absent") && !bs.equals("absent") ? 0 : !as.equals("absent") ? 1 : 2;
  }

  private static List<ClassRef> chainOrEmpty(ClassHierarchy h, String lower, String upper) {
    List<ClassRef> chain = h.chainBetween(lower, upper);
    return chain == null ? List.of() : chain;
  }

  private static Set<String> withFirst(String first, Set<String> rest) {
    Set<String> out = new LinkedHashSet<>();
    out.add(first);
    out.addAll(rest);
    return out;
  }

  private static JsonObject restrictionJson(OntologyView.Restriction r) {
    JsonObject axiom = new JsonObject();
    axiom.addProperty("kind", "restriction");
    axiom.addProperty("key", r.key());
    JsonObject property = new JsonObject();
    property.addProperty("iri", r.propIri());
    property.addProperty("label", r.propLabel());
    property.addProperty("type", r.data() ? "data" : "object");
    axiom.add("property", property);
    axiom.addProperty("quantifier", r.quantifier());
    if (r.n() != null) axiom.addProperty("n", r.n());
    JsonObject filler = new JsonObject();
    if (!r.data()) filler.addProperty("iri", r.fillerIri());
    filler.addProperty("label", r.fillerLabel());
    filler.addProperty("kind", r.data() ? "datatype" : "class");
    axiom.add("filler", filler);
    axiom.addProperty("text", r.text());
    return axiom;
  }

  private static final Object FALSE = new Object();
  private static final Object UNKNOWN = new Object();

  /** What a restriction asks for: at least so many, at most so many, or values of no other kind. */
  private static int[] demands(JsonObject axiom) {
    int n = axiom.has("n") ? axiom.get("n").getAsInt() : 1;
    return switch (axiom.get("quantifier").getAsString()) {
      case "some" -> new int[] {1, -1, 0};
      case "min" -> new int[] {n, -1, 0};
      case "max" -> new int[] {-1, n, 0};
      case "exactly" -> new int[] {n, n, 0};
      default -> new int[] {-1, -1, 1}; // only
    };
  }

  /**
   * Whether whatever meets `strong` meets `weak`: the evidence it rests on, false where the two
   * are not so related, and "unknown" where it would be so if one filler were a subclass of the
   * other and that is not known.
   */
  private Object implies(JsonObject strong, JsonObject weak, java.util.function.BiFunction<String, String, String> below, java.util.function.Function<String, JsonObject> refOf) {
    if (!strong.get("kind").getAsString().equals("restriction") || !weak.get("kind").getAsString().equals("restriction")
        || !strong.getAsJsonObject("property").get("iri").getAsString().equals(weak.getAsJsonObject("property").get("iri").getAsString())) return FALSE;
    int[] has = demands(strong);
    int[] wants = demands(weak);
    JsonArray evidence = new JsonArray();
    boolean[] unknown = {false};
    // Whether the filler of one is the filler of the other, or under it.
    java.util.function.BiFunction<JsonObject, JsonObject, Boolean> under = (lower, upper) -> {
      if (!lower.get("kind").getAsString().equals(upper.get("kind").getAsString())) return false;
      if (!lower.has("iri") || !upper.has("iri")) return lower.get("label").getAsString().equals(upper.get("label").getAsString());
      String lowerIri = lower.get("iri").getAsString();
      String upperIri = upper.get("iri").getAsString();
      if (lowerIri.equals(upperIri)) return true;
      String basis = below.apply(lowerIri, upperIri);
      if (basis == null) {
        unknown[0] = true;
        return false;
      }
      boolean said = false;
      for (JsonElement e : evidence) {
        JsonObject one = e.getAsJsonObject();
        if (one.getAsJsonObject("sub").get("iri").getAsString().equals(lowerIri) && one.getAsJsonObject("sup").get("iri").getAsString().equals(upperIri)) said = true;
      }
      if (!said) {
        JsonObject one = new JsonObject();
        one.add("sub", refOf.apply(lowerIri));
        one.add("sup", refOf.apply(upperIri));
        one.addProperty("basis", basis);
        evidence.add(one);
      }
      return true;
    };
    // "At least none" asks nothing, and anything gives it.
    if (wants[0] > 0 && !(has[0] >= wants[0] && under.apply(strong.getAsJsonObject("filler"), weak.getAsJsonObject("filler")))) {
      return unknown[0] && has[0] >= wants[0] ? UNKNOWN : FALSE;
    }
    if (wants[1] >= 0 && !(has[1] >= 0 && has[1] <= wants[1] && under.apply(weak.getAsJsonObject("filler"), strong.getAsJsonObject("filler")))) {
      return unknown[0] && has[1] >= 0 && has[1] <= wants[1] ? UNKNOWN : FALSE;
    }
    if (wants[2] == 1 && !(has[2] == 1 && under.apply(strong.getAsJsonObject("filler"), weak.getAsJsonObject("filler")))) {
      return unknown[0] && has[2] == 1 ? UNKNOWN : FALSE;
    }
    return evidence;
  }

  // ---------------------------------------------------------------- measuring the hierarchy as a whole

  private Analysis measured(View v, JsonObject query) {
    String mode = modeOf(query);
    Analysis kept = v.analyses.get(mode);
    if (kept == null) kept = measure(v, query, mode);
    return kept;
  }

  private Analysis measure(View v, JsonObject query, String mode) {
    OntologyView.Reasoned reasoned = reasoned(v);
    ClassHierarchy hierarchy = mode.equals("asserted") ? v.asserted : inferred(v);
    JsonObject provenance = mode.equals("asserted") ? assertedProvenance(query.get("revisionId").getAsString()) : reasoned.provenance();
    JsonObject head = refHead(query);
    head.addProperty("mode", mode);
    if (hierarchy == null) {
      JsonObject metrics = new JsonObject();
      for (String m : new String[] {"classes", "top", "leaves", "maxDepth", "averageDepth", "multipleInheritance", "noStatedSuperclass", "equivalenceGroups", "unsatisfiable", "inCycles"}) metrics.add(m, JsonNull.INSTANCE);
      head.add("metrics", metrics);
      head.add("sets", new JsonObject());
      head.add("depth", new JsonArray());
      head.add("subclasses", new JsonArray());
      head.add("superclasses", new JsonArray());
      JsonObject branches = new JsonObject();
      branches.add("largest", new JsonArray());
      branches.add("others", JsonNull.INSTANCE);
      head.add("branches", branches);
      head.add("findings", new JsonArray());
      head.add("deepest", new JsonArray());
      head.add("warnings", new JsonArray());
      head.add("provenance", provenance);
      head.add("reasoning", reasoned.provenance());
      Analysis analysis = new Analysis(head);
      v.analyses.put(mode, analysis);
      return analysis;
    }
    Analysis analysis = new Analysis(null);
    v.analyses.put(mode, analysis);
    JsonObject result = analyzeHierarchy(v, hierarchy, analysis);
    result.addProperty("ontologyId", query.get("ontologyId").getAsString());
    result.addProperty("revisionId", query.get("revisionId").getAsString());
    result.addProperty("mode", mode);
    result.add("provenance", provenance);
    result.add("reasoning", reasoned.provenance());
    analysis.result = result;
    return analysis;
  }

  /** A port of src/structure/analyze.ts, over one hierarchy. The answer's sets are kept in the analysis. */
  private JsonObject analyzeHierarchy(View v, ClassHierarchy h, Analysis analysis) {
    ClassHierarchy asserted = v.asserted;
    ClassHierarchy reasoned = v.inferred;
    boolean inferred = h != asserted;
    Map<String, List<JsonObject>> sets = new LinkedHashMap<>();
    java.util.function.BiFunction<String, JsonObject, Void> put = (set, item) -> {
      sets.computeIfAbsent(set, (k) -> new ArrayList<>()).add(item);
      return null;
    };
    Map<String, int[]> depths = h.depthsOf();
    // The classes that have a place of their own: not owl:Nothing, and not what is listed under it.
    List<ClassEntry> placed = new ArrayList<>();
    for (ClassEntry e : h.entries.values()) if (!e.ref.builtin() && !e.unsatisfiable) placed.add(e);

    // ---- one pass over the classes
    int placedClasses = 0;
    int depthSum = 0;
    int maxDepth = 0;
    Map<String, Integer> levelOf = new LinkedHashMap<>();
    List<Integer> subclassCounts = new ArrayList<>();
    List<Integer> leafDepths = new ArrayList<>();
    List<Integer> linkCounts = new ArrayList<>();
    for (ClassEntry e : placed) {
      int level = depths.get(e.ref.iri())[1];
      levelOf.put(e.ref.iri(), level);
      placedClasses += e.size;
      depthSum += level * e.size;
      maxDepth = Math.max(maxDepth, level);
      if (e.children.isEmpty()) {
        JsonObject item = new JsonObject();
        item.add("class", classRefJson(e.ref));
        item.addProperty("value", level);
        put.apply("leaves", item);
        leafDepths.add(level);
      } else {
        subclassCounts.add(e.children.size());
      }
      if (e.parents.size() > 1) {
        JsonObject item = new JsonObject();
        item.add("class", classRefJson(e.ref));
        item.addProperty("value", e.parents.size());
        JsonArray related = new JsonArray();
        List<JsonObject> refs = new ArrayList<>();
        for (String p : e.parents) refs.add(classRefJson(h.entries.get(p).ref));
        for (JsonObject r : refsSorted(refs)) related.add(r);
        item.add("related", related);
        put.apply("multipleInheritance", item);
      }
      if (inferred && e.size > 1) {
        JsonObject item = new JsonObject();
        item.add("class", classRefJson(e.ref));
        JsonArray related = new JsonArray();
        for (ClassRef eq : e.equivalents) related.add(classRefJson(eq));
        item.add("related", related);
        put.apply("equivalent", item);
      }
      linkCounts.add(v.read.connections.getOrDefault(e.ref.iri(), e.parents.size() + e.children.size()));
    }

    // ---- classes by level, by number of subclasses and by number of superclasses
    int width = Math.max(1, (int) Math.ceil((double) maxDepth / 12));
    List<int[]> depthRanges = new ArrayList<>();
    for (int from = 1; from <= maxDepth; from += width) depthRanges.add(new int[] {from, Math.min(maxDepth, from + width - 1)});
    JsonArray depthBuckets = buckets(sets, placed, "depth", depthRanges, levelOf::get);
    List<int[]> subclassesRanges = List.of(new int[] {0, 0}, new int[] {1, 1}, new int[] {2, 2}, new int[] {3, 5}, new int[] {6, 10}, new int[] {11, 20}, new int[] {21, 50}, new int[] {51, -1});
    JsonArray subclassesBuckets = buckets(sets, placed, "subclasses", subclassesRanges, (iri) -> h.entries.get(iri).children.size());
    List<int[]> superclassesRanges = List.of(new int[] {0, 0}, new int[] {1, 1}, new int[] {2, 2}, new int[] {3, 3}, new int[] {4, -1});
    JsonArray superclassesBuckets = buckets(sets, placed, "superclasses", superclassesRanges, (iri) -> h.entries.get(iri).parents.size());

    // ---- what is stated, whichever hierarchy is being measured
    for (ClassEntry e : asserted.entries.values()) {
      if (!e.parents.isEmpty()) continue;
      JsonObject item = new JsonObject();
      item.add("class", classRefJson(e.ref));
      put.apply("noStatedSuperclass", item);
    }
    for (List<String> ring : asserted.cycles) {
      List<JsonObject> members = new ArrayList<>();
      for (String iri : ring) members.add(classRefJson(asserted.entries.get(iri).ref));
      refsSorted(members);
      for (JsonObject c : members) {
        JsonObject item = new JsonObject();
        item.add("class", c);
        JsonArray related = new JsonArray();
        for (JsonObject other : members) if (!other.get("iri").getAsString().equals(c.get("iri").getAsString())) related.add(other);
        item.add("related", related);
        put.apply("inCycles", item);
      }
    }
    int groups = sets.getOrDefault("equivalent", List.of()).size();
    if (!inferred) {
      // The groups that stated equivalence makes: each class with the ones it is stated to be equivalent to.
      Map<String, String> leader = new LinkedHashMap<>();
      java.util.function.UnaryOperator<String> find = new java.util.function.UnaryOperator<>() {
        @Override
        public String apply(String x) {
          String root = x;
          while (leader.containsKey(root)) root = leader.get(root);
          return root;
        }
      };
      for (ClassEntry e : asserted.entries.values()) {
        for (ClassRef other : e.equivalents) {
          String x = find.apply(e.ref.iri());
          String y = find.apply(other.iri());
          if (!x.equals(y)) leader.put(x, y);
        }
      }
      Set<String> found = new LinkedHashSet<>();
      for (ClassEntry e : asserted.entries.values()) {
        if (e.equivalents.isEmpty()) continue;
        found.add(find.apply(e.ref.iri()));
        JsonObject item = new JsonObject();
        item.add("class", classRefJson(e.ref));
        JsonArray related = new JsonArray();
        for (ClassRef eq : e.equivalents) related.add(classRefJson(eq));
        item.add("related", related);
        put.apply("equivalent", item);
      }
      groups = found.size();
    }
    if (reasoned != null) {
      for (ClassEntry e : reasoned.entries.values()) {
        if (!e.unsatisfiable) continue;
        JsonObject item = new JsonObject();
        item.add("class", classRefJson(e.ref));
        put.apply("unsatisfiable", item);
      }
    }

    // ---- stated superclasses that are stated twice over
    int redundant = 0;
    List<ClassEntry> many = new ArrayList<>();
    for (ClassEntry e : asserted.entries.values()) if (e.parents.size() > 1) many.add(e);
    for (ClassEntry e : many) {
      // Everything above its superclasses. One of them is in there only if another one leads to it.
      Set<String> beyond = new LinkedHashSet<>();
      Deque<String> todo = new ArrayDeque<>();
      for (String p : e.parents) for (String up : asserted.entries.get(p).parents) todo.push(up);
      while (!todo.isEmpty()) {
        String up = todo.pop();
        if (beyond.contains(up) || up.equals(e.ref.iri())) continue;
        beyond.add(up);
        for (String further : asserted.entries.get(up).parents) todo.push(further);
      }
      for (String p : e.parents) {
        if (!beyond.contains(p)) continue;
        redundant += 1;
        JsonObject item = new JsonObject();
        item.add("class", classRefJson(e.ref));
        JsonArray related = new JsonArray();
        related.add(classRefJson(asserted.entries.get(p).ref));
        item.add("related", related);
        put.apply("redundant", item);
      }
    }

    // ---- the branches, largest first
    List<JsonObject> sized = new ArrayList<>();
    List<String> tops = new ArrayList<>();
    for (String iri : h.top) if (!h.entries.get(iri).ref.builtin()) tops.add(iri);
    for (String root : tops) {
      JsonObject item = new JsonObject();
      item.add("class", classRefJson(h.entries.get(root).ref));
      put.apply("top", item);
      Set<String> seen = new LinkedHashSet<>(List.of(root));
      Deque<String> todo = new ArrayDeque<>(List.of(root));
      int count = 0;
      int deepest = 1;
      while (!todo.isEmpty()) {
        ClassEntry e = h.entries.get(todo.pop());
        count += e.size;
        deepest = Math.max(deepest, levelOf.getOrDefault(e.ref.iri(), 1));
        for (String c : e.children) {
          if (seen.contains(c)) continue;
          seen.add(c);
          todo.push(c);
        }
      }
      JsonObject branch = new JsonObject();
      branch.add("class", classRefJson(h.entries.get(root).ref));
      branch.addProperty("classes", count);
      branch.addProperty("depth", deepest - 1);
      branch.addProperty("set", "branch:" + root);
      sized.add(branch);
    }
    sized.sort((x, y) -> {
      if (x.get("classes").getAsInt() != y.get("classes").getAsInt()) return y.get("classes").getAsInt() - x.get("classes").getAsInt();
      return byRef(x.getAsJsonObject("class"), y.getAsJsonObject("class"));
    });

    // ---- what stands out
    JsonArray findings = new JsonArray();
    class Finding {
      void finding(String kind, String set, Integer count, Integer above) {
        List<JsonObject> items = sets.getOrDefault(set, List.of());
        if (items.isEmpty()) return;
        JsonObject one = new JsonObject();
        one.addProperty("kind", kind);
        one.addProperty("count", count == null ? items.size() : count);
        if (above != null) one.addProperty("above", above);
        JsonArray examples = new JsonArray();
        List<JsonObject> refs = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonObject item : items) {
          JsonObject cls = item.getAsJsonObject("class");
          if (seen.add(cls.get("iri").getAsString())) refs.add(cls);
        }
        for (JsonObject r : refsSorted(refs).subList(0, Math.min(5, refs.size()))) examples.add(r);
        one.add("examples", examples);
        one.addProperty("set", set);
        findings.add(one);
      }
    }
    Finding finding = new Finding();
    class Far {
      int far(String name, List<Integer> values, int atLeast, double times, java.util.function.Function<String, Integer> valueOf) {
        int above = values.size() < 4 ? atLeast - 1 : Math.max(atLeast - 1, (int) Math.floor(fence(values, times)));
        for (ClassEntry e : placed) {
          Integer value = valueOf.apply(e.ref.iri());
          if (value != null && value > above) {
            JsonObject item = new JsonObject();
            item.add("class", classRefJson(e.ref));
            item.addProperty("value", value);
            put.apply(name, item);
          }
        }
        return above;
      }
    }
    Far far = new Far();
    Map<String, Integer> linksOf = new LinkedHashMap<>();
    for (int i = 0; i < placed.size(); i++) linksOf.put(placed.get(i).ref.iri(), linkCounts.get(i));
    int wideAbove = far.far("wide", subclassCounts, 8, 3, (iri) -> h.entries.get(iri).children.isEmpty() ? null : h.entries.get(iri).children.size());
    int deepAbove = far.far("deep", leafDepths, 6, 1.5, (iri) -> h.entries.get(iri).children.isEmpty() ? levelOf.get(iri) : null);
    int connectedAbove = far.far("connected", linkCounts, 10, 3, linksOf::get);
    finding.finding("unsatisfiable", "unsatisfiable", null, null);
    finding.finding("cycle", "inCycles", asserted.cycles.size(), null);
    finding.finding("redundant-superclass", "redundant", redundant, null);
    finding.finding("multiple-inheritance", "multipleInheritance", null, null);
    finding.finding("wide", "wide", null, wideAbove);
    finding.finding("deep", "deep", null, deepAbove);
    finding.finding("connected", "connected", null, connectedAbove);

    // ---- the longest ways down: from each of the deepest leaves, up by the superclass that is itself deepest
    List<JsonObject> leaves = new ArrayList<>(sets.getOrDefault("leaves", List.of()));
    leaves.sort((x, y) -> {
      if (x.get("value").getAsInt() != y.get("value").getAsInt()) return y.get("value").getAsInt() - x.get("value").getAsInt();
      return byRef(x.getAsJsonObject("class"), y.getAsJsonObject("class"));
    });
    JsonArray deepestChains = new JsonArray();
    for (JsonObject leaf : leaves.subList(0, Math.min(5, leaves.size()))) {
      List<JsonObject> chain = new ArrayList<>();
      Set<String> passed = new LinkedHashSet<>();
      String at = leaf.getAsJsonObject("class").get("iri").getAsString();
      while (at != null && !passed.contains(at)) {
        passed.add(at);
        chain.add(classRefJson(h.entries.get(at).ref));
        List<String> above = h.entries.get(at).parents;
        List<String> ordered = new ArrayList<>(above);
        ordered.sort((x, y) -> levelOf.getOrDefault(y, 0) - levelOf.getOrDefault(x, 0));
        at = ordered.isEmpty() ? null : ordered.get(0);
      }
      JsonArray reversed = new JsonArray();
      for (int i = chain.size() - 1; i >= 0; i--) reversed.add(chain.get(i));
      deepestChains.add(reversed);
    }

    java.util.function.Function<String, Integer> count = (set) -> sets.getOrDefault(set, List.of()).size();
    JsonObject metrics = new JsonObject();
    metrics.addProperty("classes", asserted.entries.size());
    metrics.addProperty("top", count.apply("top"));
    metrics.addProperty("leaves", count.apply("leaves"));
    metrics.addProperty("maxDepth", maxDepth);
    metrics.addProperty("averageDepth", placedClasses > 0 ? Math.round((double) depthSum / placedClasses * 100) / 100.0 : 0);
    metrics.addProperty("multipleInheritance", count.apply("multipleInheritance"));
    metrics.addProperty("noStatedSuperclass", count.apply("noStatedSuperclass"));
    metrics.addProperty("equivalenceGroups", groups);
    if (reasoned != null) metrics.addProperty("unsatisfiable", count.apply("unsatisfiable"));
    else metrics.add("unsatisfiable", JsonNull.INSTANCE);
    metrics.addProperty("inCycles", count.apply("inCycles"));
    JsonObject named = new JsonObject();
    for (String[] pair : new String[][] {{"top", "top"}, {"leaves", "leaves"}, {"multipleInheritance", "multipleInheritance"}, {"noStatedSuperclass", "noStatedSuperclass"}, {"equivalenceGroups", "equivalent"}, {"unsatisfiable", "unsatisfiable"}, {"inCycles", "inCycles"}}) {
      if (count.apply(pair[1]) > 0) named.addProperty(pair[0], pair[1]);
    }

    JsonObject result = new JsonObject();
    result.add("metrics", metrics);
    result.add("sets", named);
    result.add("depth", depthBuckets);
    result.add("subclasses", subclassesBuckets);
    result.add("superclasses", superclassesBuckets);
    JsonObject branches = new JsonObject();
    JsonArray largest = new JsonArray();
    for (JsonObject b : sized.subList(0, Math.min(12, sized.size()))) largest.add(b);
    branches.add("largest", largest);
    List<JsonObject> rest = sized.size() > 12 ? sized.subList(12, sized.size()) : List.of();
    if (!rest.isEmpty()) {
      JsonObject others = new JsonObject();
      others.addProperty("branches", rest.size());
      int classes = 0;
      for (JsonObject b : rest) classes += b.get("classes").getAsInt();
      others.addProperty("classes", classes);
      branches.add("others", others);
    } else {
      branches.add("others", JsonNull.INSTANCE);
    }
    result.add("branches", branches);
    result.add("findings", findings);
    result.add("deepest", deepestChains);
    JsonArray warnings = new JsonArray();
    if (inferred && h.entries.containsKey(ClassHierarchy.OWL_NOTHING)) warnings.add("The classes that can have no instance are counted among the classes and as unsatisfiable. They have no level and no place of their own, so they are left out of every other number.");
    result.add("warnings", warnings);

    // The sets, with the classes of each sorted as the members question lists them.
    for (Map.Entry<String, List<JsonObject>> at : sets.entrySet()) {
      List<JsonObject> sorted = new ArrayList<>(at.getValue());
      sorted.sort((x, y) -> {
        int xv = x.has("value") ? x.get("value").getAsInt() : 0;
        int yv = y.has("value") ? y.get("value").getAsInt() : 0;
        if (xv != yv) return yv - xv;
        return byRef(x.getAsJsonObject("class"), y.getAsJsonObject("class"));
      });
      analysis.sorted.put(at.getKey(), sorted);
    }
    return result;
  }

  /** The value above which a number is far out, by Tukey's fences. */
  private static double fence(List<Integer> values, double times) {
    if (values.isEmpty()) return Double.POSITIVE_INFINITY;
    List<Integer> sorted = new ArrayList<>(values);
    sorted.sort(Integer::compareTo);
    java.util.function.DoubleUnaryOperator at = (q) -> {
      double i = (sorted.size() - 1) * q;
      int lo = (int) Math.floor(i);
      return sorted.get(lo) + (sorted.get(Math.min(sorted.size() - 1, lo + 1)) - sorted.get(lo)) * (i - lo);
    };
    return at.applyAsDouble(0.75) + times * (at.applyAsDouble(0.75) - at.applyAsDouble(0.25));
  }

  /** Classes by a number of theirs in one range, each bucket with the set the classes are asked for by. */
  private static JsonArray buckets(Map<String, List<JsonObject>> sets, List<ClassEntry> placed, String name, List<int[]> ranges, java.util.function.Function<String, Integer> valueOf) {
    JsonArray out = new JsonArray();
    List<JsonObject> made = new ArrayList<>();
    List<String> setNames = new ArrayList<>();
    for (int[] range : ranges) {
      JsonObject b = new JsonObject();
      b.addProperty("from", range[0]);
      if (range[1] < 0) b.add("to", JsonNull.INSTANCE);
      else b.addProperty("to", range[1]);
      b.addProperty("count", 0);
      String set = name + ":" + range[0] + (range[1] < 0 ? "+" : range[1] == range[0] ? "" : "-" + range[1]);
      b.addProperty("set", set);
      made.add(b);
      setNames.add(set);
    }
    for (ClassEntry e : placed) {
      int value = valueOf.apply(e.ref.iri());
      for (int i = 0; i < ranges.size(); i++) {
        int[] range = ranges.get(i);
        if (value >= range[0] && (range[1] < 0 || value <= range[1])) {
          JsonObject b = made.get(i);
          b.addProperty("count", b.get("count").getAsInt() + 1);
          JsonObject item = new JsonObject();
          item.add("class", SessionStructure.classRefJson(e.ref));
          item.addProperty("value", value);
          sets.computeIfAbsent(setNames.get(i), (k) -> new ArrayList<>()).add(item);
          break;
        }
      }
    }
    for (JsonObject b : made) out.add(b);
    return out;
  }

  private JsonObject members(View v, JsonObject query) {
    String mode = modeOf(query);
    Analysis analysis = measured(v, query);
    JsonObject head = refHead(query);
    head.addProperty("mode", mode);
    head.addProperty("set", query.get("set").getAsString());
    ClassHierarchy hierarchy = mode.equals("asserted") ? v.asserted : inferred(v);
    String set = query.get("set").getAsString();
    if (hierarchy == null) {
      head.add("items", new JsonArray());
      head.addProperty("offset", 0);
      head.addProperty("total", 0);
      return head;
    }
    List<JsonObject> items = null;
    if (set.startsWith("branch:")) {
      items = analysis.sorted.get(set);
      if (items == null) {
        items = new ArrayList<>();
        for (String[] member : hierarchy.branchMembers(set.substring("branch:".length()), hierarchy.depthsOf())) {
          JsonObject item = new JsonObject();
          item.add("class", classRefJson(hierarchy.entries.get(member[0]).ref));
          item.addProperty("value", Integer.parseInt(member[1]));
          items.add(item);
        }
        items.sort((x, y) -> {
          if (x.get("value").getAsInt() != y.get("value").getAsInt()) return y.get("value").getAsInt() - x.get("value").getAsInt();
          return byRef(x.getAsJsonObject("class"), y.getAsJsonObject("class"));
        });
        analysis.sorted.put(set, items);
      }
    } else {
      items = analysis.sorted.get(set);
    }
    if (items == null) throw new Refusal("not-found", "There is no such set of classes in this analysis.");
    int limit = clamp(query.get("limit"), PAGE, MAX_PAGE);
    int from = offsetOf(optString(query, "cursor"));
    JsonArray page = new JsonArray();
    for (JsonObject item : items.subList(from, Math.min(from + limit, items.size()))) page.add(item);
    head.add("items", page);
    head.addProperty("offset", from);
    head.addProperty("total", items.size());
    if (from + limit < items.size()) head.addProperty("nextCursor", "at:" + (from + limit));
    return head;
  }

  private JsonObject analyze(View v, JsonObject query) {
    return measured(v, query).result;
  }

  // ---------------------------------------------------------------- the property hierarchy

  private JsonObject propertyPageOf(View v, JsonObject query, JsonObject asked) {
    JsonObject head = refHead(query);
    String parentIri = optString(asked, "parentIri");
    if (parentIri != null) head.addProperty("parentIri", parentIri);
    PropertyHierarchy h = v.props;
    PropertyEntry parent = parentIri == null ? null : h.entryOf(parentIri);
    List<String> all = parent == null ? h.top : parent.children;
    Set<String> matched = null;
    Set<String> kept = null;
    String filter = optString(asked, "filter");
    if (filter != null && !filter.trim().isEmpty()) {
      matched = h.matched(filter);
      kept = h.kept(matched);
    }
    List<String> list = kept == null ? all : all.stream().filter(kept::contains).toList();
    int limit = clamp(asked.get("limit"), PAGE, MAX_PAGE);
    String cursor = optString(asked, "cursor");
    String through = optString(asked, "through");
    int wanted = -1;
    if (cursor == null && through != null) wanted = list.indexOf(through);
    int from = wanted < 0 ? offsetOf(cursor) : (wanted / limit) * limit;
    int to = from + limit;
    JsonArray nodes = new JsonArray();
    for (String iri : list.subList(from, Math.min(to, list.size()))) {
      PropertyEntry e = h.entryOf(iri);
      JsonObject node = new JsonObject();
      node.add("property", propertyRefJson(e.ref));
      node.addProperty("childCount", kept == null ? e.children.size() : e.children.stream().filter(kept::contains).count());
      node.addProperty("parentCount", e.parents.size());
      if (e.inCycle) node.addProperty("inCycle", true);
      if (matched != null && matched.contains(e.ref.iri())) node.addProperty("match", true);
      nodes.add(node);
    }
    head.add("nodes", nodes);
    head.addProperty("offset", from);
    head.addProperty("total", list.size());
    if (to < list.size()) head.addProperty("nextCursor", "at:" + to);
    if (matched != null) head.addProperty("matched", matched.size());
    head.add("provenance", assertedProvenance(query.get("revisionId").getAsString()));
    return head;
  }

  private JsonObject propertyChildren(View v, JsonObject query) {
    return propertyPageOf(v, query, query);
  }

  private JsonElement propertyBranches(View v, JsonObject query) {
    JsonArray parents = query.has("parents") && query.get("parents").isJsonArray() ? query.getAsJsonArray("parents") : new JsonArray();
    if (parents.size() > MAX_BRANCHES) throw new Refusal("invalid", "No more than " + MAX_BRANCHES + " properties can be asked about at once.");
    JsonArray out = new JsonArray();
    for (JsonElement parent : parents) {
      JsonObject asked = parent.getAsJsonObject().deepCopy();
      if (query.has("filter")) asked.add("filter", query.get("filter"));
      out.add(propertyPageOf(v, query, asked));
    }
    return out;
  }

  private JsonObject propertyPaths(View v, JsonObject query) {
    PropertyHierarchy h = v.props;
    JsonObject out = refHead(query);
    int limit = clamp(query.get("limit"), PATHS, MAX_PATHS);
    boolean[] truncated = {false};
    List<List<PropertyRef>> paths = h.pathsTo(query.get("propertyIri").getAsString(), limit, truncated);
    JsonArray list = new JsonArray();
    for (List<PropertyRef> path : paths) {
      JsonArray one = new JsonArray();
      for (PropertyRef ref : path) one.add(propertyRefJson(ref));
      list.add(one);
    }
    out.add("paths", list);
    out.addProperty("truncated", truncated[0]);
    out.add("provenance", assertedProvenance(query.get("revisionId").getAsString()));
    return out;
  }

  private JsonObject propertySummary(View v, JsonObject query) {
    PropertyHierarchy h = v.props;
    PropertyEntry e = h.entryOf(query.get("propertyIri").getAsString());
    JsonObject out = refHead(query);
    out.add("property", propertyRefJson(e.ref));
    JsonArray supers = new JsonArray();
    List<JsonObject> refs = new ArrayList<>();
    for (String iri : e.parents) refs.add(propertyRefJson(h.entries.get(iri).ref));
    for (JsonObject r : refsSorted(refs)) supers.add(r);
    out.add("superproperties", supers);
    out.addProperty("subpropertyCount", e.children.size());
    out.addProperty("descendantCount", h.descendantsOf(query.get("propertyIri").getAsString()));
    out.addProperty("inCycle", e.inCycle);
    out.add("provenance", assertedProvenance(query.get("revisionId").getAsString()));
    return out;
  }
}
