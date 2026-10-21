package org.conceptweaver.companion;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.semanticweb.owlapi.formats.PrefixDocumentFormat;
import org.semanticweb.owlapi.model.AxiomType;
import org.semanticweb.owlapi.model.IRI;
import org.semanticweb.owlapi.model.OWLAnnotationAssertionAxiom;
import org.semanticweb.owlapi.model.OWLAnnotationProperty;
import org.semanticweb.owlapi.model.OWLAxiom;
import org.semanticweb.owlapi.model.OWLClass;
import org.semanticweb.owlapi.model.OWLClassAssertionAxiom;
import org.semanticweb.owlapi.model.OWLClassExpression;
import org.semanticweb.owlapi.model.OWLDataAllValuesFrom;
import org.semanticweb.owlapi.model.OWLDataExactCardinality;
import org.semanticweb.owlapi.model.OWLDataMaxCardinality;
import org.semanticweb.owlapi.model.OWLDataMinCardinality;
import org.semanticweb.owlapi.model.OWLDataProperty;
import org.semanticweb.owlapi.model.OWLDataPropertyRangeAxiom;
import org.semanticweb.owlapi.model.OWLDataRange;
import org.semanticweb.owlapi.model.OWLDataSomeValuesFrom;
import org.semanticweb.owlapi.model.OWLDeclarationAxiom;
import org.semanticweb.owlapi.model.OWLDatatype;
import org.semanticweb.owlapi.model.OWLDisjointClassesAxiom;
import org.semanticweb.owlapi.model.OWLEntity;
import org.semanticweb.owlapi.model.OWLEquivalentClassesAxiom;
import org.semanticweb.owlapi.model.OWLLiteral;
import org.semanticweb.owlapi.model.OWLNamedIndividual;
import org.semanticweb.owlapi.model.OWLObjectAllValuesFrom;
import org.semanticweb.owlapi.model.OWLObjectExactCardinality;
import org.semanticweb.owlapi.model.OWLObjectMaxCardinality;
import org.semanticweb.owlapi.model.OWLObjectMinCardinality;
import org.semanticweb.owlapi.model.OWLObjectProperty;
import org.semanticweb.owlapi.model.OWLObjectPropertyAssertionAxiom;
import org.semanticweb.owlapi.model.OWLObjectPropertyExpression;
import org.semanticweb.owlapi.model.OWLObjectSomeValuesFrom;
import org.semanticweb.owlapi.model.OWLOntology;
import org.semanticweb.owlapi.model.OWLSubClassOfAxiom;
import org.semanticweb.owlapi.model.OWLSubDataPropertyOfAxiom;
import org.semanticweb.owlapi.model.OWLSubObjectPropertyOfAxiom;
import org.semanticweb.owlapi.model.parameters.Imports;

/**
 * What the structure and entity services read of a held ontology: the classes, the links and the
 * properties, in the terms the page's own reader gives for the same document
 * (src/model/rdf.ts fromTurtle, src/structure/local.ts, src/entities/local.ts). Nothing here
 * fetches or writes anything; the ontology is the one uploaded to /sessions.
 */
final class OntologyView {

  static final String[][] VOCABULARIES = {
    {"rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#"},
    {"rdfs", "http://www.w3.org/2000/01/rdf-schema#"},
    {"owl", "http://www.w3.org/2002/07/owl#"},
    {"xsd", "http://www.w3.org/2001/XMLSchema#"},
    {"skos", "http://www.w3.org/2004/02/skos/core#"},
    {"dcterms", "http://purl.org/dc/terms/"},
    {"dcat", "http://www.w3.org/ns/dcat#"},
    {"prov", "http://www.w3.org/ns/prov#"},
    {"dqv", "http://www.w3.org/ns/dqv#"},
    {"adms", "http://www.w3.org/ns/adms#"},
  };

  static final IRI RDFS_LABEL = IRI.create("http://www.w3.org/2000/01/rdf-schema#label");
  static final IRI SKOS_PREF = IRI.create("http://www.w3.org/2004/02/skos/core#prefLabel");
  static final IRI SKOS_ALT = IRI.create("http://www.w3.org/2004/02/skos/core#altLabel");
  static final IRI SKOS_HIDDEN = IRI.create("http://www.w3.org/2004/02/skos/core#hiddenLabel");
  static final IRI DCT_TITLE = IRI.create("http://purl.org/dc/terms/title");
  static final IRI SKOS_DEFINITION = IRI.create("http://www.w3.org/2004/02/skos/core#definition");
  static final IRI RDFS_COMMENT = IRI.create("http://www.w3.org/2000/01/rdf-schema#comment");
  static final IRI RDFS_LITERAL = IRI.create("http://www.w3.org/2000/01/rdf-schema#Literal");

  final Sessions.Held held;
  final OWLOntology ontology;
  final String ontologyId;
  final String revisionId;

  /** The language most names are written in, and what the classes are named in. */
  final String pref;
  /** The document's default namespace: its default prefix, or the namespace most terms are in. */
  final String baseIri;
  /** The declared prefixes, as the app keeps them: not standard, not the XML namespace, first declaration wins. */
  final Map<String, String> prefixes = new LinkedHashMap<>();

  final Map<String, ClassInput> classes = new LinkedHashMap<>();
  final Map<String, ClassInput> objectProps = new LinkedHashMap<>();
  final Map<String, ClassInput> dataProps = new LinkedHashMap<>();
  final Map<String, ClassInput> annProps = new LinkedHashMap<>();
  final Map<String, ClassInput> individuals = new LinkedHashMap<>();

  /** One drawn restriction, as the app reads it (src/model/props.ts restrictionsOf). */
  record Restriction(boolean data, String propIri, String propLabel, String quantifier, String n, String fillerIri, String fillerLabel, String key, String text) {}

  final List<String[]> subClassOf = new ArrayList<>();
  final List<String[]> equivalent = new ArrayList<>();
  final List<String[]> disjoint = new ArrayList<>();
  final List<String[]> subPropertyOf = new ArrayList<>();
  /** The drawn restrictions of each class, and the class expressions kept as axioms. */
  final Map<String, List<Restriction>> restrictions = new LinkedHashMap<>();
  /** How many statements each class takes part in, of any kind. */
  final Map<String, Integer> connections = new LinkedHashMap<>();

  /** The owl characteristics an object property has, by the ids the app gives them. */
  final Map<String, List<String>> characteristics = new LinkedHashMap<>();
  final Map<String, List<String>> inverses = new LinkedHashMap<>();
  /** Whether the property has a stated domain or range that says more than where it is used. */
  final Set<String> domainStated = new LinkedHashSet<>();
  final Set<String> rangeStated = new LinkedHashSet<>();
  /** The classes a property is used from and to, for a domain or range left to follow its use. */
  final Map<String, List<String>> usedFrom = new LinkedHashMap<>();
  final Map<String, List<String>> usedTo = new LinkedHashMap<>();
  /** How many relations use each object property. */
  final Map<String, Integer> propUses = new LinkedHashMap<>();
  /** Whether a data property is functional, and its datatype keys. */
  final Set<String> functional = new LinkedHashSet<>();
  final Map<String, List<String>> datatypeKeys = new LinkedHashMap<>();
  /** The classes each data property is attached to by a "has data property" relation. */
  final Map<String, List<String>> attached = new LinkedHashMap<>();
  /** The classes each individual is stated to be an instance of. */
  final Map<String, List<String>> assertedTypes = new LinkedHashMap<>();
  /** How many relations each entity (a class or an individual) takes part in. */
  final Map<String, Integer> degrees = new LinkedHashMap<>();
  /** The class expressions kept as axioms of each class: anonymous equivalents and disjointnesses. */
  final Map<String, Integer> expressionAxioms = new LinkedHashMap<>();
  /** The data properties that have a range stated at all. */
  final Set<String> hasDataRange = new LinkedHashSet<>();
  /** The annotation properties above and below each annotation property, and how often each is used. */
  final Map<String, List<String>> annParents = new LinkedHashMap<>();
  final Map<String, List<String>> annChildren = new LinkedHashMap<>();
  final Map<String, Integer> annUses = new LinkedHashMap<>();
  /** The domain and range axioms of the object properties, for judging whether they repeat the uses. */
  final Map<String, List<List<String>>> objDomains = new LinkedHashMap<>();
  final Map<String, List<List<String>>> objRanges = new LinkedHashMap<>();
  final Map<String, List<List<String>>> dataDomains = new LinkedHashMap<>();

  /** The relationships, as the page lists them (src/entities/local.ts). Each: kind, from, to, label, prop. */
  final List<String[]> relations = new ArrayList<>();

  OntologyView(Sessions.Held held) {
    this.held = held;
    this.ontology = held.ontology();
    this.ontologyId = held.ontologyId();
    this.revisionId = held.revisionId();
    this.pref = prefLanguage();
    this.baseIri = baseIri();
    readDeclared();
    readClasses();
    readProperties();
    readRestrictions();
    readIndividuals();
    readRelations();
  }

  // ---------------------------------------------------------------- names

  /** The language most names are written in: the one most rdfs:label and skos:prefLabel values are in, "en" winning ties. */
  private String prefLanguage() {
    Map<String, Integer> langs = new LinkedHashMap<>();
    for (OWLAnnotationAssertionAxiom a : ontology.getAxioms(AxiomType.ANNOTATION_ASSERTION)) {
      IRI p = a.getProperty().getIRI();
      if (!p.equals(RDFS_LABEL) && !p.equals(SKOS_PREF)) continue;
      if (!(a.getValue() instanceof OWLLiteral literal)) continue;
      String lang = literal.hasLang() ? literal.getLang() : "";
      langs.put(lang, langs.getOrDefault(lang, 0) + 1);
    }
    List<Map.Entry<String, Integer>> byCount = new ArrayList<>(langs.entrySet());
    byCount.sort((x, y) -> {
      if (y.getValue() != x.getValue()) return y.getValue() - x.getValue();
      if (x.getKey().equals("en")) return -1;
      if (y.getKey().equals("en")) return 1;
      return 0;
    });
    return byCount.isEmpty() ? "" : byCount.get(0).getKey();
  }

  /** What an entity is called, as the page's own reader names it: its label, or the IRI made readable. */
  static String nameIn(OWLOntology ontology, String iri) {
    return nameIn(ontology, IRI.create(iri), prefLanguageOf(ontology));
  }

  /** The same, with the language already known. */
  static String nameIn(OWLOntology ontology, IRI entity, String pref) {
    for (IRI p : new IRI[] {RDFS_LABEL, SKOS_PREF, DCT_TITLE}) {
      List<OWLLiteral> literals = literalsIn(ontology, entity, p);
      if (literals.isEmpty()) continue;
      OWLLiteral best = null;
      for (OWLLiteral l : literals) {
        if (lang(l).equals(pref)) {
          best = l;
          break;
        }
        if (best == null && !l.hasLang()) best = l;
      }
      if (best == null) best = literals.get(0);
      return best.getLiteral();
    }
    return humanize(entity.toString(), false);
  }

  /** The language most names are written in, worked out once for a plan. */
  static String prefLanguageOf(OWLOntology ontology) {
    Map<String, Integer> langs = new LinkedHashMap<>();
    for (OWLAnnotationAssertionAxiom a : ontology.getAxioms(AxiomType.ANNOTATION_ASSERTION)) {
      IRI p = a.getProperty().getIRI();
      if (!p.equals(RDFS_LABEL) && !p.equals(SKOS_PREF)) continue;
      if (!(a.getValue() instanceof OWLLiteral literal)) continue;
      String lang = literal.hasLang() ? literal.getLang() : "";
      langs.put(lang, langs.getOrDefault(lang, 0) + 1);
    }
    List<Map.Entry<String, Integer>> byCount = new ArrayList<>(langs.entrySet());
    byCount.sort((x, y) -> {
      if (y.getValue() != x.getValue()) return y.getValue() - x.getValue();
      if (x.getKey().equals("en")) return -1;
      if (y.getKey().equals("en")) return 1;
      return 0;
    });
    return byCount.isEmpty() ? "" : byCount.get(0).getKey();
  }

  private static List<OWLLiteral> literalsIn(OWLOntology ontology, IRI entity, IRI property) {
    List<OWLLiteral> out = new ArrayList<>();
    for (OWLAnnotationAssertionAxiom a : ontology.getAnnotationAssertionAxioms(entity)) {
      if (a.getProperty().getIRI().equals(property) && a.getValue() instanceof OWLLiteral literal) out.add(literal);
    }
    return out;
  }

  /** The value of the first of these properties the entity has, in the preferred language where it has one. */
  String nameOf(IRI entity, IRI[] properties) {
    for (IRI p : properties) {
      List<OWLLiteral> literals = literalsIn(ontology, entity, p);
      if (literals.isEmpty()) continue;
      OWLLiteral best = null;
      for (OWLLiteral l : literals) {
        if (lang(l).equals(pref)) {
          best = l;
          break;
        }
        if (best == null && !l.hasLang()) best = l;
      }
      if (best == null) best = literals.get(0);
      return best.getLiteral();
    }
    return humanize(entity.toString(), false);
  }

  String descriptionOf(IRI entity) {
    for (IRI p : new IRI[] {SKOS_DEFINITION, RDFS_COMMENT, IRI.create("http://purl.org/dc/terms/description")}) {
      List<OWLLiteral> literals = literalsOf(entity, p);
      if (literals.isEmpty()) continue;
      OWLLiteral best = null;
      for (OWLLiteral l : literals) {
        if (lang(l).equals(pref)) {
          best = l;
          break;
        }
        if (best == null && !l.hasLang()) best = l;
      }
      if (best == null) best = literals.get(0);
      return best.getLiteral();
    }
    return "";
  }

  /** The altLabels in the preferred language, as the app joins them into synonyms. */
  List<String> synonymsOf(IRI entity) {
    List<String> out = new ArrayList<>();
    for (OWLAnnotationAssertionAxiom a : ontology.getAnnotationAssertionAxioms(entity)) {
      if (!a.getProperty().getIRI().equals(SKOS_ALT)) continue;
      if (a.getValue() instanceof OWLLiteral literal && lang(literal).equals(pref)) out.add(literal.getLiteral());
    }
    return out;
  }

  /** A naming annotation with its language, as the annotations of an entity keep it. */
  private record Named(String value, String property, String lang) {}

  /** Every literal value of the naming annotations, with what was said of it. */
  private List<Named> namingLiterals(IRI entity) {
    List<Named> out = new ArrayList<>();
    for (OWLAnnotationAssertionAxiom a : ontology.getAnnotationAssertionAxioms(entity)) {
      IRI p = a.getProperty().getIRI();
      if (!p.equals(RDFS_LABEL) && !p.equals(SKOS_PREF) && !p.equals(SKOS_ALT) && !p.equals(SKOS_HIDDEN)) continue;
      if (a.getValue() instanceof OWLLiteral literal) out.add(new Named(literal.getLiteral(), p.toString(), lang(literal)));
    }
    return out;
  }

  /** What a search finds a class by, besides its name: its other labels and its IRI written with a prefix. */
  List<String> searchTexts(ClassInput named, String shown, boolean hasSynonyms) {
    List<String> search = new ArrayList<>();
    if (hasSynonyms) for (String s : synonymsOf(IRI.create(named.iri()))) if (!s.isEmpty()) search.add(s);
    for (Named s : namingLiterals(IRI.create(named.iri()))) {
      // The name taken, and the altLabels of the preferred language (the synonyms above), are not said twice.
      if (s.value().isEmpty() || s.value().equals(shown)) continue;
      if (hasSynonyms && s.property().equals(SKOS_ALT.toString()) && s.lang().equals(pref)) continue;
      search.add(s.value());
    }
    search.removeIf((s) -> s.isEmpty() || s.equals(shown));
    String curie = compactIri(named.iri());
    if (curie != null) search.add(curie);
    return search;
  }

  private static String lang(OWLLiteral l) {
    return l.hasLang() ? l.getLang() : "";
  }

  private List<OWLLiteral> literalsOf(IRI entity, IRI property) {
    List<OWLLiteral> out = new ArrayList<>();
    for (OWLAnnotationAssertionAxiom a : ontology.getAnnotationAssertionAxioms(entity)) {
      if (a.getProperty().getIRI().equals(property) && a.getValue() instanceof OWLLiteral literal) out.add(literal);
    }
    return out;
  }

  /** The local name of an IRI, with the pieces CamelCase gives it set apart by spaces. */
  static String humanize(String iri, boolean lower) {
    String local = iri.substring(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
    try {
      local = java.net.URLDecoder.decode(local, java.nio.charset.StandardCharsets.UTF_8);
    } catch (IllegalArgumentException ignored) {
      // Not percent-encoded: as it is.
    }
    String words = local.replaceAll("[_-]+", " ").replaceAll("(\\p{Ll}|\\p{N})(\\p{Lu})", "$1 $2").trim();
    return lower ? words.toLowerCase() : words;
  }

  /** The prefixed form of an IRI, or null where no prefix covers it: the model's prefixes, its default namespace, then the standard ones. */
  String compactIri(String iri) {
    List<Map.Entry<String, String>> all = new ArrayList<>();
    all.addAll(prefixes.entrySet());
    if (!baseIri.isEmpty()) all.add(Map.entry("", baseIri));
    for (String[] v : VOCABULARIES) all.add(Map.entry(v[0], v[1]));
    String bestPrefix = null;
    String bestRest = null;
    int bestLength = -1;
    for (Map.Entry<String, String> p : all) {
      if (!iri.startsWith(p.getValue())) continue;
      String rest = iri.substring(p.getValue().length());
      if (!rest.matches("[\\p{L}\\p{N}_][\\p{L}\\p{N}_-]*")) continue;
      if (p.getValue().length() > bestLength) {
        bestLength = p.getValue().length();
        bestPrefix = p.getKey();
        bestRest = rest;
      }
    }
    return bestRest == null ? null : bestPrefix + ":" + bestRest;
  }

  /** The document's default namespace: its default prefix, or the namespace most terms are in. */
  private String baseIri() {
    org.semanticweb.owlapi.model.OWLDocumentFormat format = ontology.getOWLOntologyManager().getOntologyFormat(ontology);
    if (format instanceof PrefixDocumentFormat prefixed) {
      for (Map.Entry<String, String> e : prefixed.getPrefixName2PrefixMap().entrySet()) {
        if (e.getKey().equals(":") || e.getKey().isEmpty()) return e.getValue();
      }
    }
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (OWLClass c : ontology.getClassesInSignature(Imports.INCLUDED)) {
      if (c.isBuiltIn()) continue;
      String ns = namespaceOf(c.getIRI().toString());
      counts.put(ns, counts.getOrDefault(ns, 0) + 1);
    }
    return counts.entrySet().stream().max((x, y) -> x.getValue() - y.getValue()).map(Map.Entry::getKey).orElse("");
  }

  private static String namespaceOf(String iri) {
    return iri.substring(0, Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
  }

  // ---------------------------------------------------------------- what is declared

  private final Set<OWLEntity> declared = new LinkedHashSet<>();

  private void readDeclared() {
    for (OWLDeclarationAxiom d : ontology.getAxioms(AxiomType.DECLARATION)) declared.add(d.getEntity());
    org.semanticweb.owlapi.model.OWLDocumentFormat format = ontology.getOWLOntologyManager().getOntologyFormat(ontology);
    if (format instanceof PrefixDocumentFormat prefixed) {
      for (Map.Entry<String, String> e : prefixed.getPrefixName2PrefixMap().entrySet()) {
        String name = e.getKey().equals(":") ? "" : e.getKey();
        if (e.getValue().equals("http://www.w3.org/XML/1998/namespace")) continue;
        if (isStandardPrefix(name) || isStandardNamespace(e.getValue())) continue;
        if (!name.isEmpty() && name.matches("[A-Za-z][A-Za-z0-9_-]*") && !prefixes.containsValue(e.getValue())) prefixes.put(name, e.getValue());
      }
    }
  }

  private static boolean isStandardPrefix(String prefix) {
    for (String[] v : VOCABULARIES) if (v[0].equals(prefix)) return true;
    return false;
  }

  private static boolean isStandardNamespace(String ns) {
    for (String[] v : VOCABULARIES) if (v[1].equals(ns)) return true;
    return false;
  }

  // ---------------------------------------------------------------- classes

  private void readClasses() {
    for (OWLClass c : ontology.getClassesInSignature(Imports.INCLUDED)) {
      if (c.isBuiltIn()) continue;
      String iri = c.getIRI().toString();
      String name = nameOf(c.getIRI(), new IRI[] {RDFS_LABEL, SKOS_PREF, DCT_TITLE});
      if (name.isEmpty()) name = "Unnamed";
      classes.put(iri, new ClassInput(iri, name, List.of(), false, 0));
    }
    // The links, as the page reads them: named classes only.
    for (OWLSubClassOfAxiom a : ontology.getAxioms(AxiomType.SUBCLASS_OF)) {
      OWLClassExpression sub = a.getSubClass();
      OWLClassExpression sup = a.getSuperClass();
      if (sub.isAnonymous() || sup.isAnonymous() || sub.asOWLClass().isBuiltIn() || sup.asOWLClass().isBuiltIn()) continue;
      String s = sub.asOWLClass().getIRI().toString();
      String p = sup.asOWLClass().getIRI().toString();
      if (!s.equals(p)) {
        subClassOf.add(new String[] {s, p});
        touch(s);
        touch(p);
      }
    }
    for (OWLEquivalentClassesAxiom a : ontology.getAxioms(AxiomType.EQUIVALENT_CLASSES)) {
      List<OWLClass> cs = new ArrayList<>();
      for (OWLClassExpression c : a.getClassExpressionsAsList()) {
        if (!c.isAnonymous() && !c.asOWLClass().isBuiltIn()) cs.add(c.asOWLClass());
      }
      for (int i = 1; i < cs.size(); i++) {
        String x = cs.get(0).getIRI().toString();
        String y = cs.get(i).getIRI().toString();
        equivalent.add(new String[] {x, y});
        touch(x);
        touch(y);
      }
    }
    for (OWLDisjointClassesAxiom a : ontology.getAxioms(AxiomType.DISJOINT_CLASSES)) {
      List<OWLClass> cs = new ArrayList<>();
      for (OWLClassExpression c : a.getClassExpressionsAsList()) {
        if (!c.isAnonymous() && !c.asOWLClass().isBuiltIn()) cs.add(c.asOWLClass());
      }
      for (int i = 1; i < cs.size(); i++) {
        String x = cs.get(0).getIRI().toString();
        String y = cs.get(i).getIRI().toString();
        disjoint.add(new String[] {x, y});
        touch(x);
        touch(y);
      }
    }
  }

  /** The drawn restrictions and the anonymous superclasses kept as axioms: read once the properties are known. */
  private void readRestrictions() {
    for (OWLClass c : ontology.getClassesInSignature(Imports.INCLUDED)) {
      if (c.isBuiltIn()) continue;
      for (OWLSubClassOfAxiom a : ontology.getAxioms(AxiomType.SUBCLASS_OF)) {
        if (!a.getSubClass().equals(c) || !a.getSuperClass().isAnonymous()) continue;
        Restriction r = drawRestriction(c.getIRI().toString(), a.getSuperClass());
        if (r != null) {
          restrictions.computeIfAbsent(c.getIRI().toString(), (k) -> new ArrayList<>()).add(r);
          touch(c.getIRI().toString());
          if (!r.data()) touch(r.fillerIri());
          if (r.data()) attached.computeIfAbsent(r.propIri(), (k) -> new ArrayList<>()).add(c.getIRI().toString());
          else {
            usedFrom.computeIfAbsent(r.propIri(), (k) -> new ArrayList<>()).add(c.getIRI().toString());
            usedTo.computeIfAbsent(r.propIri(), (k) -> new ArrayList<>()).add(r.fillerIri());
          }
        }
      }
    }
    for (ClassInput c : new ArrayList<>(classes.values())) {
      int anonymous = anonymousSuperclasses(c.iri());
      List<String> search = searchTexts(c, c.label(), true);
      classes.put(c.iri(), new ClassInput(c.iri(), c.label(), search, external(c.iri()), anonymous));
    }
    // The class expressions kept as axioms: an anonymous equivalent or disjointness, each statement one.
    for (OWLEquivalentClassesAxiom a : ontology.getAxioms(AxiomType.EQUIVALENT_CLASSES)) {
      List<OWLClassExpression> cs = a.getClassExpressionsAsList();
      if (cs.stream().noneMatch(OWLClassExpression::isAnonymous)) continue;
      for (OWLClassExpression other : cs) {
        if (other.isAnonymous() || other.asOWLClass().isBuiltIn()) continue;
        String iri = other.asOWLClass().getIRI().toString();
        expressionAxioms.put(iri, expressionAxioms.getOrDefault(iri, 0) + 1);
      }
    }
    for (OWLDisjointClassesAxiom a : ontology.getAxioms(AxiomType.DISJOINT_CLASSES)) {
      List<OWLClassExpression> cs = a.getClassExpressionsAsList();
      if (cs.stream().noneMatch(OWLClassExpression::isAnonymous)) continue;
      for (OWLClassExpression other : cs) {
        if (other.isAnonymous() || other.asOWLClass().isBuiltIn()) continue;
        String iri = other.asOWLClass().getIRI().toString();
        expressionAxioms.put(iri, expressionAxioms.getOrDefault(iri, 0) + 1);
      }
    }
  }

  /** How many anonymous superclasses a class has that are not restrictions the app draws. */
  private int anonymousSuperclasses(String classIri) {
    int n = 0;
    for (OWLSubClassOfAxiom a : ontology.getAxioms(AxiomType.SUBCLASS_OF)) {
      if (!a.getSubClass().isAnonymous() && a.getSubClass().asOWLClass().getIRI().toString().equals(classIri) && a.getSuperClass().isAnonymous()) {
        if (drawRestriction(classIri, a.getSuperClass()) == null) n++;
      }
    }
    return n;
  }

  /**
   * A restriction as the app draws it: an object property with one named filler that is a class,
   * or a data property whose filler is the property's stated range. Anything else is an axiom.
   */
  Restriction drawRestriction(String classIri, OWLClassExpression expression) {
    IRI propIri = null;
    String quantifier = "some";
    String n = null;
    OWLClassExpression objectFiller = null;
    OWLDataRange dataFiller = null;
    if (expression instanceof OWLObjectSomeValuesFrom some) {
      propIri = propertyIri(some.getProperty());
      objectFiller = some.getFiller();
    } else if (expression instanceof OWLObjectAllValuesFrom only) {
      propIri = propertyIri(only.getProperty());
      quantifier = "only";
      objectFiller = only.getFiller();
    } else if (expression instanceof OWLObjectMinCardinality min) {
      propIri = propertyIri(min.getProperty());
      quantifier = "min";
      n = String.valueOf(min.getCardinality());
      objectFiller = min.getFiller();
    } else if (expression instanceof OWLObjectMaxCardinality max) {
      propIri = propertyIri(max.getProperty());
      quantifier = "max";
      n = String.valueOf(max.getCardinality());
      objectFiller = max.getFiller();
    } else if (expression instanceof OWLObjectExactCardinality exact) {
      propIri = propertyIri(exact.getProperty());
      quantifier = "exactly";
      n = String.valueOf(exact.getCardinality());
      objectFiller = exact.getFiller();
    } else if (expression instanceof OWLDataSomeValuesFrom some) {
      propIri = some.getProperty().asOWLDataProperty().getIRI();
      dataFiller = some.getFiller();
    } else if (expression instanceof OWLDataAllValuesFrom only) {
      propIri = only.getProperty().asOWLDataProperty().getIRI();
      quantifier = "only";
      dataFiller = only.getFiller();
    } else if (expression instanceof OWLDataMinCardinality min) {
      propIri = min.getProperty().asOWLDataProperty().getIRI();
      quantifier = "min";
      n = String.valueOf(min.getCardinality());
      dataFiller = min.getFiller();
    } else if (expression instanceof OWLDataMaxCardinality max) {
      propIri = max.getProperty().asOWLDataProperty().getIRI();
      quantifier = "max";
      n = String.valueOf(max.getCardinality());
      dataFiller = max.getFiller();
    } else if (expression instanceof OWLDataExactCardinality exact) {
      propIri = exact.getProperty().asOWLDataProperty().getIRI();
      quantifier = "exactly";
      n = String.valueOf(exact.getCardinality());
      dataFiller = exact.getFiller();
    } else {
      return null;
    }
    if (propIri == null) return null;
    if (objectFiller != null) {
      if (objectFiller.isAnonymous() || objectFiller.asOWLClass().isBuiltIn()) return null;
      String filler = objectFiller.asOWLClass().getIRI().toString();
      if (!objectProps.containsKey(propIri.toString()) || !classes.containsKey(filler)) return null;
      String propLabel = objectProps.get(propIri.toString()).label();
      String fillerLabel = classes.get(filler).label();
      String key = "r|" + propIri + "|" + quantifier + "|" + (n == null ? "" : n) + "|" + filler;
      return new Restriction(false, propIri.toString(), propLabel, quantifier, n, filler, fillerLabel, key, propLabel + " " + quantifier + (n == null ? "" : " " + n) + " " + fillerLabel);
    }
    // A data property: its filler has to be the property's stated range, or rdfs:Literal where there is none.
    String filler = dataRangeIri(dataFiller);
    if (filler == null || !dataProps.containsKey(propIri.toString())) return null;
    String said = statedRange(propIri.toString());
    if (said == null || !filler.equals(said)) return null;
    String propLabel = dataProps.get(propIri.toString()).label();
    // The filler is named as the app names the datatype: "xsd:string" for a standard one, "rdfs:Literal" where there is none.
    String fillerName = filler.equals(RDFS_LITERAL.toString()) ? "rdfs:Literal" : datatypeKey(dataFiller);
    String key = "r|" + propIri + "|" + quantifier + "|" + (n == null ? "" : n) + "|" + fillerName;
    return new Restriction(true, propIri.toString(), propLabel, quantifier, n, null, fillerName, key, propLabel + " " + quantifier + (n == null ? "" : " " + n) + " " + fillerName);
  }

  private static IRI propertyIri(OWLObjectPropertyExpression p) {
    return p.isAnonymous() ? null : p.asOWLObjectProperty().getIRI();
  }

  /** The single named range a data property is stated to have; rdfs:Literal where it has none. Null where it has several. */
  private String statedRange(String propIri) {
    List<String> ranges = new ArrayList<>();
    for (OWLDataPropertyRangeAxiom a : ontology.getAxioms(AxiomType.DATA_PROPERTY_RANGE)) {
      if (!a.getProperty().asOWLDataProperty().getIRI().toString().equals(propIri)) continue;
      String iri = dataRangeIri(a.getRange());
      if (iri != null) ranges.add(iri);
    }
    return ranges.size() == 1 ? ranges.get(0) : ranges.isEmpty() ? RDFS_LITERAL.toString() : null;
  }

  /** The IRI a data range names on its own; null for a range narrowed by facets or a list of literals. */
  private static String dataRangeIri(OWLDataRange range) {
    return range instanceof OWLDatatype ? range.asOWLDatatype().getIRI().toString() : null;
  }

  /** Whether an entity is referred to rather than defined: outside the default namespace, with nothing but its declaration. */
  private boolean external(String iri) {
    if (baseIri.isEmpty() || iri.startsWith(baseIri)) return false;
    for (OWLAxiom a : ontology.getAxioms()) {
      if (a.getSignature().stream().noneMatch((e) -> e.getIRI().toString().equals(iri))) continue;
      if (!(a instanceof OWLDeclarationAxiom)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- properties

  private void readProperties() {
    Set<OWLObjectProperty> objProps = new LinkedHashSet<>();
    Set<OWLDataProperty> datProps = new LinkedHashSet<>();
    Set<OWLAnnotationProperty> anns = new LinkedHashSet<>();
    for (OWLEntity e : declared) {
      if (e.isBuiltIn()) continue;
      if (e instanceof OWLObjectProperty) objProps.add((OWLObjectProperty) e);
      else if (e instanceof OWLDataProperty) datProps.add((OWLDataProperty) e);
      else if (e instanceof OWLAnnotationProperty && !isStandardNamespace(namespaceOf(e.getIRI().toString()))) anns.add((OWLAnnotationProperty) e);
    }
    for (OWLObjectProperty p : objProps) {
      String iri = p.getIRI().toString();
      String name = nameOf(p.getIRI(), new IRI[] {RDFS_LABEL, SKOS_PREF});
      if (name.isEmpty()) name = "Unnamed";
      objectProps.put(iri, new ClassInput(iri, name, List.of(), false, 0));
      List<String> chars = new ArrayList<>();
      for (OWLAnnotationAssertionAxiom a : ontology.getAnnotationAssertionAxioms(p.getIRI())) {
        if (!a.getProperty().getIRI().toString().equals("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")) continue;
        if (a.getValue() instanceof IRI v) {
          String id = switch (v.toString()) {
            case "http://www.w3.org/2002/07/owl#FunctionalProperty" -> "functional";
            case "http://www.w3.org/2002/07/owl#InverseFunctionalProperty" -> "inverseFunctional";
            case "http://www.w3.org/2002/07/owl#TransitiveProperty" -> "transitive";
            case "http://www.w3.org/2002/07/owl#SymmetricProperty" -> "symmetric";
            case "http://www.w3.org/2002/07/owl#AsymmetricProperty" -> "asymmetric";
            case "http://www.w3.org/2002/07/owl#ReflexiveProperty" -> "reflexive";
            case "http://www.w3.org/2002/07/owl#IrreflexiveProperty" -> "irreflexive";
            default -> null;
          };
          if (id != null && !chars.contains(id)) chars.add(id);
        }
      }
      characteristics.put(iri, chars);
      objDomains.put(iri, namedDomains(p.getIRI(), true));
      objRanges.put(iri, namedDomains(p.getIRI(), false));
    }
    for (OWLDataProperty p : datProps) {
      String iri = p.getIRI().toString();
      String name = nameOf(p.getIRI(), new IRI[] {RDFS_LABEL, SKOS_PREF});
      if (name.isEmpty()) name = "Unnamed";
      dataProps.put(iri, new ClassInput(iri, name, List.of(), false, 0));
      for (OWLDataPropertyRangeAxiom a : ontology.getAxioms(AxiomType.DATA_PROPERTY_RANGE)) {
        if (!a.getProperty().asOWLDataProperty().getIRI().toString().equals(iri)) continue;
        hasDataRange.add(iri);
        String key = datatypeKey(a.getRange());
        if (key != null) datatypeKeys.computeIfAbsent(iri, (k) -> new ArrayList<>()).add(key);
      }
      for (OWLAnnotationAssertionAxiom a : ontology.getAnnotationAssertionAxioms(p.getIRI())) {
        if (a.getProperty().getIRI().toString().equals("http://www.w3.org/1999/02/22-rdf-syntax-ns#type") && a.getValue() instanceof IRI v && v.toString().equals("http://www.w3.org/2002/07/owl#FunctionalProperty")) {
          functional.add(iri);
        }
      }
      dataDomains.put(iri, namedDomains(p.getIRI(), true));
    }
    for (OWLAnnotationProperty p : anns) {
      String iri = p.getIRI().toString();
      String name = nameOf(p.getIRI(), new IRI[] {RDFS_LABEL, SKOS_PREF});
      if (name.isEmpty()) name = "Unnamed";
      annProps.put(iri, new ClassInput(iri, name, List.of(), false, 0));
    }
    // subPropertyOf links, among properties of one kind.
    for (OWLSubObjectPropertyOfAxiom ax : ontology.getAxioms(AxiomType.SUB_OBJECT_PROPERTY)) {
      if (ax.getSubProperty().isAnonymous() || ax.getSuperProperty().isAnonymous()) continue;
      String sub = ax.getSubProperty().asOWLObjectProperty().getIRI().toString();
      String sup = ax.getSuperProperty().asOWLObjectProperty().getIRI().toString();
      if (objectProps.containsKey(sub) && objectProps.containsKey(sup) && !sub.equals(sup)) subPropertyOf.add(new String[] {sub, sup});
    }
    for (OWLSubDataPropertyOfAxiom ax : ontology.getAxioms(AxiomType.SUB_DATA_PROPERTY)) {
      String sub = ax.getSubProperty().asOWLDataProperty().getIRI().toString();
      String sup = ax.getSuperProperty().asOWLDataProperty().getIRI().toString();
      if (dataProps.containsKey(sub) && dataProps.containsKey(sup) && !sub.equals(sup)) subPropertyOf.add(new String[] {sub, sup});
    }
    for (OWLAxiom a : ontology.getAxioms(AxiomType.SUB_ANNOTATION_PROPERTY_OF)) {
      org.semanticweb.owlapi.model.OWLSubAnnotationPropertyOfAxiom ax = (org.semanticweb.owlapi.model.OWLSubAnnotationPropertyOfAxiom) a;
      String sub = ax.getSubProperty().getIRI().toString();
      String sup = ax.getSuperProperty().getIRI().toString();
      if (annProps.containsKey(sub) && annProps.containsKey(sup) && !sub.equals(sup)) {
        annParents.computeIfAbsent(sub, (k) -> new ArrayList<>()).add(sup);
        annChildren.computeIfAbsent(sup, (k) -> new ArrayList<>()).add(sub);
      }
    }
    // Inverses, among declared object properties.
    for (org.semanticweb.owlapi.model.OWLInverseObjectPropertiesAxiom ax : ontology.getAxioms(AxiomType.INVERSE_OBJECT_PROPERTIES)) {
      if (ax.getFirstProperty().isAnonymous() || ax.getSecondProperty().isAnonymous()) continue;
      String first = ax.getFirstProperty().asOWLObjectProperty().getIRI().toString();
      String second = ax.getSecondProperty().asOWLObjectProperty().getIRI().toString();
      if (objectProps.containsKey(first) && objectProps.containsKey(second)) {
        inverses.computeIfAbsent(first, (k) -> new ArrayList<>()).add(second);
        inverses.computeIfAbsent(second, (k) -> new ArrayList<>()).add(first);
      }
    }
    // How often each annotation property is used, over the entities of this ontology.
    for (OWLEntity e : ontology.getSignature(Imports.INCLUDED)) {
      for (OWLAnnotationAssertionAxiom a : ontology.getAnnotationAssertionAxioms(e.getIRI())) {
        String p = a.getProperty().getIRI().toString();
        if (annProps.containsKey(p)) annUses.put(p, annUses.getOrDefault(p, 0) + 1);
      }
    }
  }

  /** The named classes each domain or range axiom of an object or data property names: a class, or the union of several. */
  private List<List<String>> namedDomains(IRI property, boolean domain) {
    List<List<String>> out = new ArrayList<>();
    List<OWLAxiom> axioms = new ArrayList<>();
    for (org.semanticweb.owlapi.model.OWLObjectPropertyDomainAxiom a : ontology.getAxioms(AxiomType.OBJECT_PROPERTY_DOMAIN)) {
      if (a.getProperty().getNamedProperty().getIRI().equals(property)) axioms.add(a);
    }
    if (!domain) {
      axioms.clear();
      for (org.semanticweb.owlapi.model.OWLObjectPropertyRangeAxiom a : ontology.getAxioms(AxiomType.OBJECT_PROPERTY_RANGE)) {
        if (a.getProperty().getNamedProperty().getIRI().equals(property)) axioms.add(a);
      }
    }
    for (OWLAxiom a : axioms) {
      OWLClassExpression c = domain
          ? ((org.semanticweb.owlapi.model.OWLObjectPropertyDomainAxiom) a).getDomain()
          : ((org.semanticweb.owlapi.model.OWLObjectPropertyRangeAxiom) a).getRange();
      out.add(unionClasses(c));
    }
    return out;
  }

  /** The named classes an expression is: itself, or the classes of its union. */
  private static List<String> unionClasses(OWLClassExpression c) {
    if (!c.isAnonymous()) {
      if (c.asOWLClass().isBuiltIn()) return List.of();
      return List.of(c.asOWLClass().getIRI().toString());
    }
    if (c instanceof org.semanticweb.owlapi.model.OWLObjectUnionOf union) {
      List<String> out = new ArrayList<>();
      for (OWLClassExpression member : union.getOperandsAsList()) {
        if (!member.isAnonymous() && !member.asOWLClass().isBuiltIn()) out.add(member.asOWLClass().getIRI().toString());
      }
      return out;
    }
    return List.of();
  }

  /** Whether the classes stated as a domain or range are exactly the classes the property is used from or to. */
  private boolean followsUse(List<List<String>> axioms, List<String> used) {
    if (axioms.size() != 1) return false;
    List<String> named = axioms.get(0);
    Set<String> usedSet = new LinkedHashSet<>(used);
    return !named.isEmpty() && named.size() == usedSet.size() && usedSet.containsAll(named);
  }

  /** The key a datatype is known by, as the app names it: "xsd:string", or <iri> for another. */
  private static String datatypeKey(OWLDataRange range) {
    if (!(range instanceof OWLDatatype)) return null;
    OWLDatatype d = range.asOWLDatatype();
    String iri = d.getIRI().toString();
    String xsd = "http://www.w3.org/2001/XMLSchema#";
    if (iri.startsWith(xsd) && iri.substring(xsd.length()).matches("[A-Za-z][\\w-]*")) return "xsd:" + iri.substring(xsd.length());
    if (iri.equals("http://www.w3.org/1999/02/22-rdf-syntax-ns#langString")) return "rdf:langString";
    return "<" + iri + ">";
  }

  // ---------------------------------------------------------------- individuals

  private void readIndividuals() {
    Set<OWLNamedIndividual> people = new LinkedHashSet<>();
    for (OWLEntity e : declared) if (e instanceof OWLNamedIndividual && !e.isBuiltIn()) people.add((OWLNamedIndividual) e);
    for (OWLClassAssertionAxiom a : ontology.getAxioms(AxiomType.CLASS_ASSERTION)) {
      if (!a.getClassExpression().isAnonymous() && !a.getClassExpression().asOWLClass().isBuiltIn() && a.getIndividual().isNamed()) people.add(a.getIndividual().asOWLNamedIndividual());
    }
    for (OWLNamedIndividual i : people) {
      String iri = i.getIRI().toString();
      String name = nameOf(i.getIRI(), new IRI[] {RDFS_LABEL, SKOS_PREF, DCT_TITLE});
      if (name.isEmpty()) name = "Unnamed";
      individuals.put(iri, new ClassInput(iri, name, List.of(), false, 0));
      List<String> types = new ArrayList<>();
      for (OWLClassAssertionAxiom a : ontology.getAxioms(AxiomType.CLASS_ASSERTION)) {
        if (!a.getIndividual().isNamed() || !a.getIndividual().asOWLNamedIndividual().getIRI().equals(i.getIRI())) continue;
        if (!a.getClassExpression().isAnonymous() && !a.getClassExpression().asOWLClass().isBuiltIn()) {
          String t = a.getClassExpression().asOWLClass().getIRI().toString();
          if (!types.contains(t)) types.add(t);
        }
      }
      assertedTypes.put(iri, types);
    }
  }

  // ---------------------------------------------------------------- relationships

  /** How many statements each class takes part in, and each entity's degree: read off the relations as the app draws them. */
  private void touch(String classIri) {
    if (classes.containsKey(classIri)) connections.put(classIri, connections.getOrDefault(classIri, 0) + 1);
  }

  private void degree(String iri) {
    degrees.put(iri, degrees.getOrDefault(iri, 0) + 1);
  }

  private void readRelations() {
    // The class assertions: what an individual is stated to be an instance of.
    for (OWLClassAssertionAxiom a : ontology.getAxioms(AxiomType.CLASS_ASSERTION)) {
      if (a.getClassExpression().isAnonymous() || a.getClassExpression().asOWLClass().isBuiltIn() || !a.getIndividual().isNamed()) continue;
      String from = a.getIndividual().asOWLNamedIndividual().getIRI().toString();
      String to = a.getClassExpression().asOWLClass().getIRI().toString();
      if (!individuals.containsKey(from) || !classes.containsKey(to)) continue;
      relations.add(new String[] {"instanceOf", from, to, "", ""});
      degree(from);
      degree(to);
      touch(to);
    }
    // The object property assertions between entities of the model.
    for (OWLObjectPropertyAssertionAxiom a : ontology.getAxioms(AxiomType.OBJECT_PROPERTY_ASSERTION)) {
      if (a.getProperty().isAnonymous() || !a.getSubject().isNamed() || !a.getObject().isNamed()) continue;
      String prop = a.getProperty().asOWLObjectProperty().getIRI().toString();
      if (!objectProps.containsKey(prop)) continue;
      String from = a.getSubject().asOWLNamedIndividual().getIRI().toString();
      String to = a.getObject().asOWLNamedIndividual().getIRI().toString();
      boolean knownFrom = classes.containsKey(from) || individuals.containsKey(from);
      boolean knownTo = classes.containsKey(to) || individuals.containsKey(to);
      if (!knownFrom || !knownTo) continue;
      String label = objectProps.get(prop).label();
      relations.add(new String[] {"object", from, to, label, prop});
      degree(from);
      degree(to);
      propUses.put(prop, propUses.getOrDefault(prop, 0) + 1);
      touch(from);
      touch(to);
      if (classes.containsKey(from)) usedFrom.computeIfAbsent(prop, (k) -> new ArrayList<>()).add(from);
      if (classes.containsKey(to)) usedTo.computeIfAbsent(prop, (k) -> new ArrayList<>()).add(to);
    }
    // The drawn restrictions: their uses of the property, and their place in the relations.
    for (Map.Entry<String, List<Restriction>> at : restrictions.entrySet()) {
      for (Restriction r : at.getValue()) {
        relations.add(new String[] {r.data() ? "property" : "object", at.getKey(), r.data() ? r.propIri() : r.fillerIri(), r.data() ? "" : r.propLabel(), r.data() ? "" : r.propIri()});
        degree(at.getKey());
        propUses.put(r.propIri(), propUses.getOrDefault(r.propIri(), 0) + 1);
        if (!r.data()) degree(r.fillerIri());
      }
    }
    // The standard-property pairs: what an equivalence or a disjointness says, as a relationship each.
    for (String[] pair : equivalent) {
      relations.add(new String[] {"standard", pair[0], pair[1], "owl:equivalentClass", ""});
      degree(pair[0]);
      degree(pair[1]);
    }
    for (String[] pair : disjoint) {
      relations.add(new String[] {"standard", pair[0], pair[1], "owl:disjointWith", ""});
      degree(pair[0]);
      degree(pair[1]);
    }
    // The subPropertyOf links between data properties are relationships of the model too.
    for (String[] link : subPropertyOf) {
      if (dataProps.containsKey(link[0])) {
        relations.add(new String[] {"generalization", link[0], link[1], "", ""});
        degree(link[0]);
        degree(link[1]);
      }
    }
    // The subClassOf links: one relationship each, and a statement each class takes part in.
    for (String[] link : subClassOf) {
      relations.add(new String[] {"generalization", link[0], link[1], "", ""});
      degree(link[0]);
      degree(link[1]);
    }
    // Whether a stated domain or range says no more than where the property is used.
    for (String iri : objectProps.keySet()) {
      if (!objDomains.getOrDefault(iri, List.of()).isEmpty() && !followsUse(objDomains.getOrDefault(iri, List.of()), usedFrom.getOrDefault(iri, List.of()))) domainStated.add(iri);
      if (!objRanges.getOrDefault(iri, List.of()).isEmpty() && !followsUse(objRanges.getOrDefault(iri, List.of()), usedTo.getOrDefault(iri, List.of()))) rangeStated.add(iri);
    }
    for (String iri : dataProps.keySet()) {
      if (!dataDomains.getOrDefault(iri, List.of()).isEmpty() && !followsUse(dataDomains.getOrDefault(iri, List.of()), attached.getOrDefault(iri, List.of()))) domainStated.add(iri);
    }
    for (String iri : annProps.keySet()) {
      boolean hasDomain = ontology.getAxioms(AxiomType.ANNOTATION_PROPERTY_DOMAIN).stream().anyMatch((a) -> ((org.semanticweb.owlapi.model.OWLAnnotationPropertyDomainAxiom) a).getProperty().getIRI().toString().equals(iri));
      boolean hasRange = ontology.getAxioms(AxiomType.ANNOTATION_PROPERTY_RANGE).stream().anyMatch((a) -> ((org.semanticweb.owlapi.model.OWLAnnotationPropertyRangeAxiom) a).getProperty().getIRI().toString().equals(iri));
      if (hasDomain) domainStated.add(iri);
      if (hasRange) rangeStated.add(iri);
    }
    // Whether an entity is referred to rather than defined: outside the default namespace, with nothing but its declaration.
    if (!baseIri.isEmpty()) {
      for (String iri : new ArrayList<>(classes.keySet())) if (external(iri)) classes.put(iri, new ClassInput(iri, classes.get(iri).label(), classes.get(iri).search(), true, classes.get(iri).anonymousSuperclasses()));
      for (String iri : new ArrayList<>(objectProps.keySet())) if (external(iri)) objectProps.put(iri, new ClassInput(iri, objectProps.get(iri).label(), objectProps.get(iri).search(), true, 0));
      for (String iri : new ArrayList<>(dataProps.keySet())) if (external(iri)) dataProps.put(iri, new ClassInput(iri, dataProps.get(iri).label(), dataProps.get(iri).search(), true, 0));
      for (String iri : new ArrayList<>(annProps.keySet())) if (external(iri)) annProps.put(iri, new ClassInput(iri, annProps.get(iri).label(), annProps.get(iri).search(), true, 0));
    }
    // The search texts of the properties, once the external flags are known.
    for (String iri : new ArrayList<>(objectProps.keySet())) {
      ClassInput p = objectProps.get(iri);
      List<String> search = searchTexts(p, p.label(), false);
      objectProps.put(iri, new ClassInput(iri, p.label(), search, p.external(), 0));
    }
    for (String iri : new ArrayList<>(dataProps.keySet())) {
      ClassInput p = dataProps.get(iri);
      List<String> search = searchTexts(p, p.label(), false);
      dataProps.put(iri, new ClassInput(iri, p.label(), search, p.external(), 0));
    }
  }

  /** What an entity is called, for a relationship's ends: its label, or nothing where it is not of this ontology. */
  String entityName(String iri) {
    if (classes.containsKey(iri)) return classes.get(iri).label();
    if (individuals.containsKey(iri)) return individuals.get(iri).label();
    if (dataProps.containsKey(iri)) return dataProps.get(iri).label();
    return "";
  }

  // ---------------------------------------------------------------- the reasoning

  /** The reasoning of a session: the report /reason gives, mapped to what the inferred hierarchy is built from. */
  record Reasoned(JsonObject provenance, EntailedInput entailed) {}

  /**
   * The report mapped to what the page makes of it (src/model/reasoning.ts dlResult, read by
   * src/structure/local.ts dlAnswer): the provenance says which reasoner and how far its answer
   * goes, and the entailed links are there only when it has a current answer.
   */
  Reasoned mapReport(JsonObject report) {
    String consistency = report.has("consistency") ? report.get("consistency").getAsString() : "unknown";
    String status = report.has("status") ? report.get("status").getAsString() : "failed";
    JsonArray notes = new JsonArray();
    if (!consistency.equals("inconsistent") && (status.equals("failed") || consistency.equals("unknown"))) {
      for (JsonElement e : report.has("errors") ? report.getAsJsonArray("errors") : new JsonArray()) notes.add(e);
    } else if (!consistency.equals("inconsistent")) {
      for (JsonElement e : report.has("warnings") ? report.getAsJsonArray("warnings") : new JsonArray()) notes.add(e);
    }
    JsonObject engine = new JsonObject();
    engine.addProperty("id", "dl");
    engine.addProperty("name", report.has("engine") ? report.get("engine").getAsString() : "HermiT");
    engine.addProperty("version", report.has("engineVersion") ? report.get("engineVersion").getAsString() : "");
    JsonObject provenance = new JsonObject();
    provenance.add("engine", engine);
    provenance.addProperty("revisionId", revisionId);
    provenance.addProperty("status", consistency.equals("inconsistent") ? "inconsistent" : (status.equals("failed") || consistency.equals("unknown") ? "failed" : "current"));
    provenance.addProperty("completeness", status.equals("complete") ? "complete" : "incomplete");
    provenance.add("notes", notes);
    if (!provenance.get("status").getAsString().equals("current")) return new Reasoned(provenance, null);
    List<String[]> links = new ArrayList<>();
    for (JsonElement e : report.has("subclasses") ? report.getAsJsonArray("subclasses") : new JsonArray()) {
      JsonObject pair = e.getAsJsonObject();
      links.add(new String[] {pair.get("sub").getAsString(), pair.get("sup").getAsString()});
    }
    List<List<String>> equivalent = new ArrayList<>();
    for (JsonElement e : report.has("equivalents") ? report.getAsJsonArray("equivalents") : new JsonArray()) {
      List<String> group = new ArrayList<>();
      for (JsonElement one : e.getAsJsonArray()) group.add(one.getAsString());
      equivalent.add(group);
    }
    List<String> unsatisfiable = new ArrayList<>();
    for (JsonElement e : report.has("unsatisfiable") ? report.getAsJsonArray("unsatisfiable") : new JsonArray()) unsatisfiable.add(e.getAsString());
    return new Reasoned(provenance, new EntailedInput(links, "direct", equivalent, unsatisfiable));
  }

  JsonObject classRefJson(String iri) {
    ClassInput input = classes.get(iri);
    JsonObject ref = new JsonObject();
    ref.addProperty("iri", iri);
    ref.addProperty("label", input.label());
    if (input.external()) ref.addProperty("external", true);
    return ref;
  }
}
