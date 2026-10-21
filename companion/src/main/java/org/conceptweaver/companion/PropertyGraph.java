package org.conceptweaver.companion;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The hierarchy of object and data properties, and the questions asked of it: a port of
 * src/structure/propertyGraph.ts. There is one hierarchy, the stated one: no reasoner draws a
 * property hierarchy, so what is not stated with rdfs:subPropertyOf is not in it.
 */

record PropertyRef(String iri, String label, String type, boolean external) implements Sorting.Ref {}

record PropertyInput(PropertyRef ref, List<String> search) {

  PropertyInput {
    search = search == null ? List.of() : search;
  }
}

record PropertyGraphInput(List<PropertyInput> properties, List<String[]> subPropertyOf) {}

final class PropertyEntry implements Sorting.Ref {
  PropertyRef ref;
  String text;
  final List<String> parents = new ArrayList<>();
  final List<String> children = new ArrayList<>();
  boolean inCycle;

  @Override
  public String iri() {
    return ref.iri();
  }

  @Override
  public String label() {
    return ref.label();
  }
}

final class PropertyHierarchy {
  final Map<String, PropertyEntry> entries = new LinkedHashMap<>();
  /** The properties at the top, in order of label. */
  final List<String> top = new ArrayList<>();
  /** The groups of properties that are each other's superproperties. */
  final List<List<String>> cycles = new ArrayList<>();

  PropertyHierarchy build(PropertyGraphInput input) {
    // An IRI is one property, however often it is listed.
    for (PropertyInput p : input.properties()) if (!entries.containsKey(p.ref().iri())) entries.put(p.ref().iri(), of(p));
    for (String[] link : input.subPropertyOf()) {
      PropertyEntry a = entries.get(link[0]);
      PropertyEntry b = entries.get(link[1]);
      // A property is not listed under itself, and a link stated twice is one link.
      if (a == null || b == null || link[0].equals(link[1]) || a.parents.contains(link[1])) continue;
      a.parents.add(link[1]);
      b.children.add(link[0]);
    }
    for (PropertyEntry e : entries.values()) Sorting.sortIrisByLabel(e.children, entries);
    cycles.addAll(rings());
    for (Map.Entry<String, PropertyEntry> at : entries.entrySet()) if (at.getValue().parents.isEmpty()) top.add(at.getKey());
    for (List<String> ring : cycles) {
      Set<String> inside = new LinkedHashSet<>(ring);
      for (String iri : ring) entries.get(iri).inCycle = true;
      // Properties that are only each other's superproperties have nothing above them to be
      // reached from. One of them is listed at the top, so that every property is somewhere.
      boolean onlyEachOther = ring.stream().allMatch((iri) -> entries.get(iri).parents.stream().allMatch(inside::contains));
      if (onlyEachOther) {
        List<String> byLabel = new ArrayList<>(ring);
        Sorting.sortIrisByLabel(byLabel, entries);
        top.add(byLabel.get(0));
      }
    }
    Sorting.sortIrisByLabel(top, entries);
    return this;
  }

  private static PropertyEntry of(PropertyInput p) {
    PropertyEntry e = new PropertyEntry();
    e.ref = p.ref();
    e.text = textOf(p);
    return e;
  }

  private static String textOf(PropertyInput p) {
    StringBuilder b = new StringBuilder(p.ref().label()).append('\n').append(p.ref().iri());
    for (String s : p.search()) b.append('\n').append(s);
    return b.toString().toLowerCase();
  }

  private List<List<String>> rings() {
    Map<String, RingNode> nodes = new LinkedHashMap<>();
    for (Map.Entry<String, PropertyEntry> at : entries.entrySet()) {
      PropertyEntry e = at.getValue();
      nodes.put(at.getKey(), new RingNode() {
        @Override
        public List<String> parents() {
          return e.parents;
        }

        @Override
        public List<String> children() {
          return e.children;
        }
      });
    }
    return ClassHierarchy.rings(nodes);
  }

  PropertyEntry entryOf(String iri) {
    PropertyEntry e = entries.get(iri);
    if (e == null) throw new Refusal("not-found", "There is no property <" + iri + "> in this ontology.");
    return e;
  }

  /** The properties a filter finds: their label, other labels or IRI contain the text. */
  Set<String> matched(String text) {
    String q = text.trim().toLowerCase();
    Set<String> matches = new LinkedHashSet<>();
    for (Map.Entry<String, PropertyEntry> at : entries.entrySet()) {
      if (at.getValue().text.contains(q)) matches.add(at.getKey());
    }
    return matches;
  }

  /** The matches, with the properties that lead down to one. */
  Set<String> kept(Set<String> matches) {
    Set<String> kept = new LinkedHashSet<>(matches);
    Deque<String> todo = new ArrayDeque<>(matches);
    while (!todo.isEmpty()) {
      for (String p : entries.get(todo.pop()).parents) {
        if (kept.contains(p)) continue;
        kept.add(p);
        todo.push(p);
      }
    }
    return kept;
  }

  /** The ways down the hierarchy to a property, each from one at the top, shortest first. */
  List<List<PropertyRef>> pathsTo(String iri, int limit, boolean[] truncated) {
    String start = entryOf(iri).ref.iri();
    Set<String> topSet = new LinkedHashSet<>(top);
    class Step {
      final String iri;
      final Step below;
      Step(String iri, Step below) {
        this.iri = iri;
        this.below = below;
      }

      boolean passes(String x) {
        for (Step s = this; s != null; s = s.below) if (s.iri.equals(x)) return true;
        return false;
      }
    }
    List<List<PropertyRef>> paths = new ArrayList<>();
    int[] work = {0};
    List<Step> level = new ArrayList<>(List.of(new Step(start, null)));
    while (!level.isEmpty()) {
      List<Step> next = new ArrayList<>();
      for (int n = 0; n < level.size(); n++) {
        Step step = level.get(n);
        if (topSet.contains(step.iri)) {
          List<PropertyRef> path = new ArrayList<>();
          for (Step s = step; s != null; s = s.below) path.add(entries.get(s.iri).ref);
          paths.add(path);
          if (paths.size() >= limit) {
            truncated[0] = n + 1 < level.size() || !next.isEmpty();
            return paths;
          }
          continue;
        }
        for (String up : entries.get(step.iri).parents) {
          // Only a property in a ring can come round again.
          if (entries.get(up).inCycle && step.passes(up)) continue;
          if (++work[0] > PATH_WORK) {
            truncated[0] = true;
            return paths;
          }
          next.add(new Step(up, step));
        }
      }
      level = next;
    }
    return paths;
  }

  /** How many steps upward a search for ways down may take before it gives what it has. */
  private static final int PATH_WORK = 50_000;

  /** How many properties are below a property, by any way down, each counted once. */
  int descendantsOf(String iri) {
    String start = entryOf(iri).ref.iri();
    Set<String> seen = new LinkedHashSet<>(List.of(start));
    Deque<String> todo = new ArrayDeque<>(List.of(start));
    int count = 0;
    while (!todo.isEmpty()) {
      for (String c : entries.get(todo.pop()).children) {
        if (seen.contains(c)) continue;
        seen.add(c);
        count++;
        todo.push(c);
      }
    }
    return count;
  }
}
