package org.conceptweaver.companion;

import java.text.Collator;
import java.util.List;
import java.util.Locale;

/**
 * The order things are listed in: by label, and by IRI where two labels are the same, as the
 * page lists them (src/structure/graph.ts). The collator is the machine's, as the page's is the
 * reader's.
 */
final class Sorting {

  static final Collator COLLATOR = Collator.getInstance(Locale.getDefault());

  private Sorting() {}

  interface Ref {
    String iri();
    String label();
  }

  /** By label, and of IRI where two have the same label. */
  static <T extends Ref> int byRef(T a, T b) {
    int by = COLLATOR.compare(a.label(), b.label());
    return by != 0 ? by : a.iri().compareTo(b.iri());
  }

  static <T extends Ref> void sortRefs(List<T> list) {
    list.sort(Sorting::byRef);
  }

  /** Sorts a list of IRIs by the label of each in `entries`. */
  static <T extends Ref> void sortIrisByLabel(List<String> iris, java.util.Map<String, T> entries) {
    iris.sort((a, b) -> byRef(entries.get(a), entries.get(b)));
  }
}
