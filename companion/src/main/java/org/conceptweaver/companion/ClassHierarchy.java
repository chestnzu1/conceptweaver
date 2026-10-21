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
 * The class hierarchy as a graph, and the questions asked of it: a port of
 * src/structure/graph.ts, kept behaviour for behaviour, so that the answers of this service and
 * of the page's own cannot drift (FR-M6-7).
 *
 * A hierarchy is not a tree. A class may have several superclasses, and classes may be each
 * other's superclasses; both are valid OWL. Every walk keeps count of where it has been, so a
 * ring of classes cannot make one run on.
 */

/** What a hierarchy is built from. */
record ClassInput(String iri, String label, List<String> search, boolean external, int anonymousSuperclasses) implements Sorting.Ref {

  ClassInput {
    search = search == null ? List.of() : search;
  }
}

record ClassGraphInput(List<ClassInput> classes, List<String[]> subClassOf, List<String[]> equivalent, List<String[]> disjoint) {}

/** What a reasoner entails, for the inferred hierarchy to be built from. */
record EntailedInput(List<String[]> subClassOf, String links, List<List<String>> equivalent, List<String> unsatisfiable) {}

record ClassRef(String iri, String label, boolean external, boolean builtin) implements Sorting.Ref {}

/** A class as the hierarchy holds it. */
final class ClassEntry implements Sorting.Ref {
  ClassRef ref;
  String text;
  final List<String> parents = new ArrayList<>();
  final List<String> children = new ArrayList<>();
  final List<ClassRef> equivalents = new ArrayList<>();
  final List<ClassRef> disjoints = new ArrayList<>();
  int size = 1;
  boolean inCycle;
  boolean unsatisfiable;
  int anonymousSuperclasses;

  @Override
  public String iri() {
    return ref.iri();
  }

  @Override
  public String label() {
    return ref.label();
  }
}

/** A node of a search for rings, as either hierarchy supplies it. */
interface RingNode {
  List<String> parents();
  List<String> children();
}

final class ClassHierarchy {
  static final String OWL_NOTHING = "http://www.w3.org/2002/07/owl#Nothing";

  final Map<String, ClassEntry> entries = new LinkedHashMap<>();
  /** The classes at the top, in order of label. */
  final List<String> top = new ArrayList<>();
  /** The groups of classes that are each other's superclasses. None in the inferred hierarchy. */
  final List<List<String>> cycles = new ArrayList<>();
  /** In the inferred hierarchy: each class that shares a place, with the class that speaks for the place. */
  final Map<String, String> alias = new LinkedHashMap<>();
  /** In the inferred hierarchy: the links that are entailed and nowhere stated, as "sub\nsup". */
  final Set<String> entailedOnly = new LinkedHashSet<>();
  /** Worked out when first asked for. */
  Map<String, int[]> depths;

  ClassHierarchy build(ClassGraphInput input) {
    // An IRI is one class, however often it is listed.
    for (ClassInput c : input.classes()) if (!entries.containsKey(c.iri())) entries.put(c.iri(), of(c));
    for (String[] link : input.subClassOf()) {
      ClassEntry a = entries.get(link[0]);
      ClassEntry b = entries.get(link[1]);
      // A class is not listed under itself, and a link stated twice is one link.
      if (a == null || b == null || link[0].equals(link[1]) || a.parents.contains(link[1])) continue;
      a.parents.add(link[1]);
      b.children.add(link[0]);
    }
    for (String[] pair : input.equivalent()) {
      ClassEntry x = entries.get(pair[0]);
      ClassEntry y = entries.get(pair[1]);
      if (x == null || y == null || pair[0].equals(pair[1]) || x.equivalents.stream().anyMatch((e) -> e.iri().equals(pair[1]))) continue;
      x.equivalents.add(y.ref);
      y.equivalents.add(x.ref);
    }
    for (String[] pair : input.disjoint()) {
      ClassEntry x = entries.get(pair[0]);
      ClassEntry y = entries.get(pair[1]);
      if (x == null || y == null || x.disjoints.stream().anyMatch((e) -> e.iri().equals(pair[1]))) continue;
      x.disjoints.add(y.ref);
      if (!pair[0].equals(pair[1])) y.disjoints.add(x.ref);
    }
    for (ClassEntry e : entries.values()) {
      Sorting.sortIrisByLabel(e.children, entries);
      Sorting.sortRefs(e.equivalents);
      Sorting.sortRefs(e.disjoints);
    }
    cycles.addAll(rings(this.ringNodes()));
    for (Map.Entry<String, ClassEntry> at : entries.entrySet()) if (at.getValue().parents.isEmpty()) top.add(at.getKey());
    for (List<String> ring : cycles) {
      Set<String> inside = new LinkedHashSet<>(ring);
      for (String iri : ring) entries.get(iri).inCycle = true;
      // Classes that are only each other's superclasses have nothing above them to be reached
      // from. One of them is listed at the top, so that every class is somewhere in the hierarchy.
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

  /**
   * The hierarchy a reasoner entails: classes entailed to be equivalent share one place, under the
   * name of one of them, each place under the places directly above it. A class that can have no
   * instance, and with it every class below it, is listed under owl:Nothing and nowhere else.
   */
  ClassHierarchy buildInferred(ClassGraphInput input, EntailedInput entailed) {
    Map<String, ClassInput> classes = new LinkedHashMap<>();
    for (ClassInput c : input.classes()) if (!classes.containsKey(c.iri())) classes.put(c.iri(), c);
    List<String[]> links = new ArrayList<>();
    for (String[] l : entailed.subClassOf()) if (!l[0].equals(l[1]) && classes.containsKey(l[0]) && classes.containsKey(l[1])) links.add(l);

    // What is below a class without instances has none either.
    Set<String> empty = new LinkedHashSet<>();
    for (String iri : entailed.unsatisfiable()) if (classes.containsKey(iri)) empty.add(iri);
    if (!empty.isEmpty()) {
      Map<String, List<String>> below = new LinkedHashMap<>();
      for (String[] l : links) below.computeIfAbsent(l[1], (k) -> new ArrayList<>()).add(l[0]);
      Deque<String> todo = new ArrayDeque<>(empty);
      while (!todo.isEmpty()) {
        for (String sub : below.getOrDefault(todo.pop(), List.of())) {
          if (empty.contains(sub)) continue;
          empty.add(sub);
          todo.push(sub);
        }
      }
    }

    // The classes that share a place: the groups the reasoner names, and any that its links make
    // each other's superclasses.
    Map<String, String> leader = new LinkedHashMap<>();
    java.util.function.UnaryOperator<String> find = new java.util.function.UnaryOperator<>() {
      @Override
      public String apply(String x) {
        String root = x;
        while (leader.get(root) != null && !leader.get(root).equals(root)) root = leader.get(root);
        for (String at = x; !at.equals(root); ) {
          String next = leader.get(at);
          leader.put(at, root);
          at = next;
        }
        return root;
      }
    };
    class Join {
      void join(String a, String b) {
        String x = find.apply(a);
        String y = find.apply(b);
        if (!x.equals(y)) leader.put(x, y);
      }
    }
    Join join = new Join();
    for (List<String> group : entailed.equivalent()) {
      List<String> members = group.stream().filter((iri) -> classes.containsKey(iri) && !empty.contains(iri)).toList();
      for (String m : members.subList(1, members.size())) join.join(members.get(0), m);
    }
    List<String[]> live = empty.isEmpty() ? links : links.stream().filter((l) -> !empty.contains(l[0]) && !empty.contains(l[1])).toList();
    {
      // Only what the search for rings needs of each group: what is above it and what is below.
      Map<String, List<String>> parents = new LinkedHashMap<>();
      Map<String, List<String>> children = new LinkedHashMap<>();
      for (String[] l : live) {
        String a = find.apply(l[0]);
        String b = find.apply(l[1]);
        if (a.equals(b)) continue;
        parents.computeIfAbsent(a, (k) -> new ArrayList<>()).add(b);
        children.computeIfAbsent(b, (k) -> new ArrayList<>()).add(a);
      }
      for (List<String> ring : rings(groupNodes(parents, children))) for (String iri : ring.subList(1, ring.size())) join.join(ring.get(0), iri);
    }

    // Each group under the name of the first of its classes by label.
    Map<String, List<ClassInput>> groups = new LinkedHashMap<>();
    for (ClassInput c : classes.values()) {
      if (empty.contains(c.iri())) continue;
      groups.computeIfAbsent(find.apply(c.iri()), (k) -> new ArrayList<>()).add(c);
    }
    Map<String, String> speaker = new LinkedHashMap<>();
    for (List<ClassInput> members : groups.values()) {
      if (members.size() > 1) Sorting.sortRefs(members);
      ClassInput first = members.get(0);
      ClassEntry e = of(first);
      if (members.size() > 1) {
        for (ClassInput c : members.subList(1, members.size())) e.equivalents.add(refOf(c));
        e.text = members.stream().map(ClassHierarchy::textOf).reduce((x, y) -> x + "\n" + y).orElse("");
        e.size = members.size();
        for (ClassInput c : members.subList(1, members.size())) alias.put(c.iri(), first.iri());
      }
      entries.put(first.iri(), e);
      speaker.put(find.apply(first.iri()), first.iri());
    }
    java.util.function.Function<String, String> placeOf = (iri) -> speaker.get(find.apply(iri));

    // Every place above each place, as far as the links say; then the ones directly above it.
    Map<String, Set<String>> above = new LinkedHashMap<>();
    for (String[] l : live) {
      String a = placeOf.apply(l[0]);
      String b = placeOf.apply(l[1]);
      if (!a.equals(b)) above.computeIfAbsent(a, (k) -> new LinkedHashSet<>()).add(b);
    }
    for (Map.Entry<String, Set<String>> at : above.entrySet()) {
      String iri = at.getKey();
      Set<String> ups = at.getValue();
      List<String> direct = new ArrayList<>(ups);
      if (entailed.links().equals("all")) {
        // Given every link, the place with the most above it is the nearest, and whatever is above
        // a nearer place is not directly above this one.
        java.util.function.Function<String, Integer> reach = (x) -> above.getOrDefault(x, Set.of()).size();
        List<String> ordered = new ArrayList<>(ups);
        ordered.sort((x, y) -> reach.apply(y) - reach.apply(x));
        Set<String> covered = new LinkedHashSet<>();
        direct = new ArrayList<>();
        for (String up : ordered) {
          if (covered.contains(up)) continue;
          direct.add(up);
          covered.addAll(above.getOrDefault(up, Set.of()));
        }
      }
      ClassEntry e = entries.get(iri);
      e.parents.addAll(direct);
      for (String up : direct) entries.get(up).children.add(iri);
    }

    // A link is stated where any class of the lower place is stated to be a subclass of any class of the upper one.
    Set<String> stated = new LinkedHashSet<>();
    for (String[] l : input.subClassOf()) {
      if (!classes.containsKey(l[0]) || !classes.containsKey(l[1]) || empty.contains(l[0]) || empty.contains(l[1])) continue;
      stated.add(placeOf.apply(l[0]) + "\n" + placeOf.apply(l[1]));
    }
    for (Map.Entry<String, ClassEntry> at : entries.entrySet()) {
      for (String up : at.getValue().parents) if (!stated.contains(at.getKey() + "\n" + up)) entailedOnly.add(at.getKey() + "\n" + up);
    }

    for (Map.Entry<String, ClassEntry> at : entries.entrySet()) if (at.getValue().parents.isEmpty()) top.add(at.getKey());
    if (!empty.isEmpty()) {
      ClassEntry nothing = of(new ClassInput(OWL_NOTHING, "owl:Nothing", List.of(), false, 0));
      nothing.ref = new ClassRef(OWL_NOTHING, "owl:Nothing", false, true);
      nothing.size = 0;
      entries.put(OWL_NOTHING, nothing);
      for (String iri : empty) {
        ClassEntry e = of(classes.get(iri));
        e.unsatisfiable = true;
        e.parents.add(OWL_NOTHING);
        entries.put(iri, e);
        nothing.children.add(iri);
        entailedOnly.add(iri + "\n" + OWL_NOTHING);
      }
    }
    for (ClassEntry e : entries.values()) Sorting.sortIrisByLabel(e.children, entries);
    Sorting.sortIrisByLabel(top, entries);
    // owl:Nothing is the bottom of the hierarchy. It is listed last, after everything that can have instances.
    if (!empty.isEmpty()) top.add(OWL_NOTHING);
    return this;
  }

  static ClassRef refOf(ClassInput c) {
    return new ClassRef(c.iri(), c.label(), c.external(), false);
  }

  static String textOf(ClassInput c) {
    StringBuilder b = new StringBuilder(c.label()).append('\n').append(c.iri());
    for (String s : c.search()) b.append('\n').append(s);
    return b.toString().toLowerCase();
  }

  private static ClassEntry of(ClassInput c) {
    ClassEntry e = new ClassEntry();
    e.ref = refOf(c);
    e.text = textOf(c);
    e.anonymousSuperclasses = c.anonymousSuperclasses();
    return e;
  }

  /** The place of a class: its own, or in the inferred hierarchy the one it shares. */
  String placeIn(String iri) {
    return alias.getOrDefault(iri, iri);
  }

  ClassEntry entryOf(String iri) {
    ClassEntry e = entries.get(placeIn(iri));
    if (e == null) throw new Refusal("not-found", "There is no class <" + iri + "> in this ontology.");
    return e;
  }

  /** A class as it is listed, under `parent` when that is given, which says whether its place there is stated. */
  Jsonish nodeOf(String iri, Set<String> kept, Set<String> matches, String parent) {
    ClassEntry e = entryOf(iri);
    int childCount = kept == null ? e.children.size() : (int) e.children.stream().filter(kept::contains).count();
    return new Jsonish(e.ref, e.equivalents, childCount, e.parents.size(), e.inCycle, matches != null && matches.contains(e.ref.iri()),
        parent != null && entailedOnly.contains(e.ref.iri() + "\n" + parent), e.unsatisfiable);
  }

  /** Everything one listing of a class says: the entry, in JSON shape. */
  record Jsonish(ClassRef ref, List<ClassRef> equivalents, int childCount, int parentCount, boolean inCycle, boolean match, boolean entailedOnly, boolean unsatisfiable) {}

  // ---------------------------------------------------------------- the walks

  /** How many steps upward a search for ways down may take before it gives what it has. */
  private static final int PATH_WORK = 50_000;

  /** The hierarchy's entries as nodes of a search for rings. */
  private Map<String, RingNode> ringNodes() {
    Map<String, RingNode> out = new LinkedHashMap<>();
    for (Map.Entry<String, ClassEntry> at : entries.entrySet()) {
      ClassEntry e = at.getValue();
      out.put(at.getKey(), new RingNode() {
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
    return out;
  }

  /** Nodes of a search for rings over what the inferred build knows of each group. */
  private static Map<String, RingNode> groupNodes(Map<String, List<String>> parents, Map<String, List<String>> children) {
    Map<String, RingNode> out = new LinkedHashMap<>();
    Set<String> all = new LinkedHashSet<>(parents.keySet());
    all.addAll(children.keySet());
    for (String iri : all) {
      out.put(iri, new RingNode() {
        @Override
        public List<String> parents() {
          return parents.getOrDefault(iri, List.of());
        }

        @Override
        public List<String> children() {
          return children.getOrDefault(iri, List.of());
        }
      });
    }
    return out;
  }

  /** The groups of classes that are each other's superclasses: Tarjan's algorithm, with a stack of its own. */
  static List<List<String>> rings(Map<String, RingNode> nodes) {
    Map<String, Integer> index = new LinkedHashMap<>();
    Map<String, Integer> low = new LinkedHashMap<>();
    List<String> waiting = new ArrayList<>();
    Set<String> isWaiting = new LinkedHashSet<>();
    List<List<String>> out = new ArrayList<>();
    int[] counter = {0};
    for (Map.Entry<String, RingNode> start : nodes.entrySet()) {
      String v = start.getKey();
      // A class in a ring has both a superclass and a subclass.
      if (index.containsKey(v) || start.getValue().parents().isEmpty() || start.getValue().children().isEmpty()) continue;
      index.put(v, counter[0]);
      low.put(v, counter[0]++);
      waiting.add(v);
      isWaiting.add(v);
      record Frame(String v, int next) {}
      Deque<Frame> work = new ArrayDeque<>();
      work.push(new Frame(v, 0));
      while (!work.isEmpty()) {
        Frame frame = work.peek();
        List<String> ups = nodes.get(frame.v()).parents();
        if (frame.next() < ups.size()) {
          Frame advanced = new Frame(frame.v(), frame.next() + 1);
          work.pop();
          work.push(advanced);
          String w = ups.get(frame.next());
          if (!index.containsKey(w)) {
            index.put(w, counter[0]);
            low.put(w, counter[0]++);
            waiting.add(w);
            isWaiting.add(w);
            work.push(new Frame(w, 0));
          } else if (isWaiting.contains(w)) {
            low.put(frame.v(), Math.min(low.get(frame.v()), index.get(w)));
          }
          continue;
        }
        work.pop();
        Frame below = work.peek();
        if (below != null) low.put(below.v(), Math.min(low.get(below.v()), low.get(frame.v())));
        if (!low.get(frame.v()).equals(index.get(frame.v()))) continue;
        List<String> ring = new ArrayList<>();
        for (;;) {
          String w = waiting.remove(waiting.size() - 1);
          isWaiting.remove(w);
          ring.add(w);
          if (w.equals(frame.v())) break;
        }
        if (ring.size() > 1) out.add(ring);
      }
    }
    return out;
  }

  /** The classes a filter finds: their label, other labels or IRI contain the text. */
  Set<String> matched(String text) {
    String q = text.trim().toLowerCase();
    Set<String> matches = new LinkedHashSet<>();
    for (Map.Entry<String, ClassEntry> at : entries.entrySet()) {
      if (at.getValue().ref.builtin()) continue;
      if (at.getValue().text.contains(q)) matches.add(at.getKey());
    }
    return matches;
  }

  /** The matches, with the classes that lead down to one. */
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

  /** The ways down the hierarchy to a class, each from a class at the top, shortest first. */
  List<List<ClassRef>> pathsTo(String iri, int limit, boolean[] truncated) {
    String start = entryOf(iri).ref.iri();
    Set<String> topSet = new LinkedHashSet<>(top);
    class Step {
      final String iri;
      final Step below;
      Step(String iri, Step below) {
        this.iri = iri;
        this.below = below;
      }

      /** Whether this way down has passed `x` already: only a class in a ring can come round again. */
      boolean passes(String x) {
        for (Step s = this; s != null; s = s.below) if (s.iri.equals(x)) return true;
        return false;
      }
    }
    List<List<ClassRef>> paths = new ArrayList<>();
    int[] work = {0};
    List<Step> level = new ArrayList<>(List.of(new Step(start, null)));
    while (!level.isEmpty()) {
      List<Step> next = new ArrayList<>();
      for (int n = 0; n < level.size(); n++) {
        Step step = level.get(n);
        if (topSet.contains(step.iri)) {
          List<ClassRef> path = new ArrayList<>();
          for (Step s = step; s != null; s = s.below) path.add(entries.get(s.iri).ref);
          paths.add(path);
          if (paths.size() >= limit) {
            truncated[0] = n + 1 < level.size() || !next.isEmpty();
            return paths;
          }
          continue;
        }
        for (String up : entries.get(step.iri).parents) {
          // Only a class in a ring can come round again.
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

  /** How many levels each class is below owl:Thing, at the least and at the most. */
  Map<String, int[]> depthsOf() {
    if (depths != null) return depths;
    // Each ring taken as one: the first of its classes stands for it, and every other class for itself.
    Map<String, String> ring = new LinkedHashMap<>();
    Map<String, List<String>> members = new LinkedHashMap<>();
    for (List<String> cycle : cycles) {
      members.put(cycle.get(0), cycle);
      for (String iri : cycle) ring.put(iri, cycle.get(0));
    }
    boolean plain = cycles.isEmpty();
    java.util.function.UnaryOperator<String> unit = plain ? (iri) -> iri : (iri) -> ring.getOrDefault(iri, iri);
    // What is directly below a class or a ring, outside it.
    java.util.function.Function<String, List<String>> belowOf = plain
        ? (u) -> entries.get(u).children
        : (u) -> {
          List<String> out = new ArrayList<>();
          for (String iri : members.getOrDefault(u, List.of(u))) {
            for (String c : entries.get(iri).children) {
              String v = unit.apply(c);
              if (!v.equals(u)) out.add(v);
            }
          }
          return out;
        };

    // The least: level by level from the top, each at the level it is first met on.
    Map<String, Integer> min = new LinkedHashMap<>();
    List<String> level = new ArrayList<>();
    for (String iri : top) {
      if (min.containsKey(unit.apply(iri))) continue;
      min.put(unit.apply(iri), 1);
      level.add(unit.apply(iri));
    }
    for (int depth = 2; !level.isEmpty(); depth++) {
      List<String> next = new ArrayList<>();
      for (String u : level) {
        for (String v : belowOf.apply(u)) {
          if (min.containsKey(v)) continue;
          min.put(v, depth);
          next.add(v);
        }
      }
      level = next;
    }

    // The most: the longest way down, which is known once everything above has been gone through.
    Map<String, Integer> waits = new LinkedHashMap<>();
    Map<String, Integer> max = new LinkedHashMap<>();
    for (Map.Entry<String, ClassEntry> at : entries.entrySet()) {
      String u = unit.apply(at.getKey());
      int n = plain ? at.getValue().parents.size() : (int) at.getValue().parents.stream().filter((p) -> !unit.apply(p).equals(u)).count();
      waits.put(u, waits.getOrDefault(u, 0) + n);
    }
    Deque<String> ready = new ArrayDeque<>();
    for (Map.Entry<String, Integer> at : waits.entrySet()) {
      if (at.getValue() != 0) continue;
      max.put(at.getKey(), 1);
      ready.push(at.getKey());
    }
    while (!ready.isEmpty()) {
      String u = ready.pop();
      for (String v : belowOf.apply(u)) {
        max.put(v, Math.max(max.getOrDefault(v, 0), max.get(u) + 1));
        waits.put(v, waits.get(v) - 1);
        if (waits.get(v) == 0) ready.push(v);
      }
    }
    depths = new LinkedHashMap<>();
    for (String iri : entries.keySet()) depths.put(iri, new int[] {min.getOrDefault(unit.apply(iri), 1), max.getOrDefault(unit.apply(iri), 1)});
    return depths;
  }

  /** Every class above a class, by any way up. */
  List<String> ancestorsOf(String iri) {
    String start = entryOf(iri).ref.iri();
    Set<String> seen = new LinkedHashSet<>(List.of(start));
    Deque<String> todo = new ArrayDeque<>(List.of(start));
    while (!todo.isEmpty()) {
      for (String p : entries.get(todo.pop()).parents) {
        if (seen.contains(p)) continue;
        seen.add(p);
        todo.push(p);
      }
    }
    seen.remove(start);
    return new ArrayList<>(seen);
  }

  /** How many named classes are below a class, by any way down, each counted once. */
  int descendantsOf(String iri) {
    String start = entryOf(iri).ref.iri();
    Set<String> seen = new LinkedHashSet<>(List.of(start));
    Deque<String> todo = new ArrayDeque<>(List.of(start));
    int count = 0;
    while (!todo.isEmpty()) {
      for (String c : entries.get(todo.pop()).children) {
        if (seen.contains(c)) continue;
        seen.add(c);
        count += entries.get(c).size;
        todo.push(c);
      }
    }
    return count;
  }

  /** The shortest way from one class up to another through the links: the classes from the upper one down to the lower one. */
  List<ClassRef> chainBetween(String lower, String upper) {
    String from = entryOf(lower).ref.iri();
    String to = entryOf(upper).ref.iri();
    Map<String, String> reached = new LinkedHashMap<>();
    reached.put(from, null);
    List<String> level = new ArrayList<>(List.of(from));
    while (!level.isEmpty() && !reached.containsKey(to)) {
      List<String> next = new ArrayList<>();
      for (String iri : level) {
        for (String p : entries.get(iri).parents) {
          if (reached.containsKey(p)) continue;
          reached.put(p, iri);
          next.add(p);
        }
      }
      level = next;
    }
    if (from.equals(to) || !reached.containsKey(to)) return null;
    List<ClassRef> chain = new ArrayList<>();
    for (String at = to; at != null; at = reached.get(at)) chain.add(entries.get(at).ref);
    return chain;
  }

  /** The classes a text finds: by label first, then by anything else they are searched by. */
  List<ClassRef> searchClasses(String text, int limit, int[] total) {
    String q = text.trim().toLowerCase();
    if (q.isEmpty()) {
      total[0] = 0;
      return List.of();
    }
    record Found(ClassRef ref, int score) {}
    List<Found> found = new ArrayList<>();
    for (ClassEntry e : entries.values()) {
      if (e.ref.builtin() || !e.text.contains(q)) continue;
      String label = e.ref.label().toLowerCase();
      int score = label.equals(q) ? 0 : label.startsWith(q) ? 1 : label.contains(q) ? 2 : 3;
      found.add(new Found(e.ref, score));
    }
    found.sort((x, y) -> {
      if (x.score() != y.score()) return x.score() - y.score();
      if (x.ref().label().length() != y.ref().label().length()) return x.ref().label().length() - y.ref().label().length();
      return Sorting.byRef(x.ref(), y.ref());
    });
    total[0] = found.size();
    List<ClassRef> out = new ArrayList<>();
    for (Found f : found.subList(0, Math.min(limit, found.size()))) out.add(f.ref());
    return out;
  }

  /** The classes of one branch: its top class and everything below it, each with the level it is on. */
  List<String[]> branchMembers(String root, Map<String, int[]> depths) {
    Set<String> seen = new LinkedHashSet<>(List.of(root));
    Deque<String> todo = new ArrayDeque<>(List.of(root));
    List<String[]> out = new ArrayList<>();
    while (!todo.isEmpty()) {
      ClassEntry e = entries.get(todo.pop());
      if (e == null) continue;
      int[] d = depths.get(e.ref.iri());
      out.add(new String[] {e.ref.iri(), String.valueOf(d == null ? 0 : d[1])});
      for (String c : e.children) {
        if (seen.contains(c)) continue;
        seen.add(c);
        todo.push(c);
      }
    }
    return out;
  }
}
