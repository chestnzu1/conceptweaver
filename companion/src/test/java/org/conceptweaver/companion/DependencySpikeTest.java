package org.conceptweaver.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Method;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.semanticweb.HermiT.ReasonerFactory;
import org.semanticweb.elk.owlapi.ElkReasoner;
import org.semanticweb.elk.owlapi.ElkReasonerFactory;
import org.semanticweb.elk.reasoner.completeness.IncompleteResult;
import org.semanticweb.elk.reasoner.completeness.Incompleteness;
import org.semanticweb.owl.explanation.api.Explanation;
import org.semanticweb.owl.explanation.api.ExplanationGenerator;
import org.semanticweb.owl.explanation.api.ExplanationGeneratorFactory;
import org.semanticweb.owl.explanation.api.ExplanationManager;
import org.semanticweb.owlapi.apibinding.OWLManager;
import org.semanticweb.owlapi.formats.FunctionalSyntaxDocumentFormat;
import org.semanticweb.owlapi.formats.ManchesterSyntaxDocumentFormat;
import org.semanticweb.owlapi.formats.OWLXMLDocumentFormat;
import org.semanticweb.owlapi.formats.RDFXMLDocumentFormat;
import org.semanticweb.owlapi.formats.TurtleDocumentFormat;
import org.semanticweb.owlapi.io.StringDocumentSource;
import org.semanticweb.owlapi.io.StringDocumentTarget;
import org.semanticweb.owlapi.model.IRI;
import org.semanticweb.owlapi.model.MissingImportHandlingStrategy;
import org.semanticweb.owlapi.model.OWLAxiom;
import org.semanticweb.owlapi.model.OWLClass;
import org.semanticweb.owlapi.model.OWLDataFactory;
import org.semanticweb.owlapi.model.OWLDocumentFormat;
import org.semanticweb.owlapi.model.OWLNamedIndividual;
import org.semanticweb.owlapi.model.OWLOntology;
import org.semanticweb.owlapi.model.OWLOntologyCreationException;
import org.semanticweb.owlapi.model.OWLOntologyLoaderConfiguration;
import org.semanticweb.owlapi.model.OWLOntologyManager;
import org.semanticweb.owlapi.model.OWLOntologyStorageException;
import org.semanticweb.owlapi.model.parameters.Imports;
import org.semanticweb.owlapi.profiles.OWL2ELProfile;
import org.semanticweb.owlapi.profiles.OWL2DLProfile;
import org.semanticweb.owlapi.profiles.OWLProfileReport;
import org.semanticweb.owlapi.profiles.OWLProfileViolation;
import org.semanticweb.owlapi.reasoner.NodeSet;
import org.semanticweb.owlapi.reasoner.OWLReasoner;
import org.semanticweb.owlapi.reasoner.OWLReasonerFactory;

/**
 * What the single-file service does today, done here through the dependencies the companion will
 * declare (roadmap task 3.1):
 *
 * <ul>
 *   <li>read Turtle and classify it with HermiT: consistency, unsatisfiable classes, inferred
 *       superclasses and the classes of an individual;
 *   <li>explain an entailment, as /reason does when asked;
 *   <li>check the OWL 2 DL and OWL 2 EL profiles, and choose ELK for an ontology in EL;
 *   <li>classify with ELK, with the incompleteness monitor it reports;
 *   <li>write and reread every syntax /convert writes, and compare two documents by axiom;
 *   <li>report a missing import without fetching it.
 * </ul>
 *
 * The tests are the same under both Maven profiles, so the evidence for OWL API 4 or 5 is the
 * pair of runs, not an opinion.
 */
class DependencySpikeTest {

  static final String NS = "http://example.org/";

  static OWLDataFactory df() {
    return OWLManager.getOWLDataFactory();
  }

  static OWLClass cls(String name) {
    return df().getOWLClass(IRI.create(NS + name));
  }

  static OWLNamedIndividual individual(String name) {
    return df().getOWLNamedIndividual(IRI.create(NS + name));
  }

  static OWLOntology load(String document) throws OWLOntologyCreationException {
    return OWLManager.createOWLOntologyManager()
        .loadOntologyFromOntologyDocument(new StringDocumentSource(document));
  }

  static int elViolations(OWLOntology ontology) {
    OWLProfileReport report = new OWL2ELProfile().checkOntology(ontology);
    int n = 0;
    for (OWLProfileViolation v : report.getViolations()) {
      // An undeclared annotation property changes no axiom; the service counts it apart too.
      if (!v.getClass().getSimpleName().startsWith("UseOfUndeclared")) n++;
    }
    return n;
  }

  static String turtle(String body) {
    return """
        @prefix ex: <http://example.org/> .
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

        ex: a owl:Ontology .
        """ + body;
  }

  /**
   * owlexplanation 2.0.0 makes its generator from a reasoner factory alone; 5.0.1 also asks for
   * the manager to put working ontologies in. The same test runs against both, so the overload
   * is chosen at runtime; the companion itself will call the one of the line it is built on.
   */
  @SuppressWarnings("unchecked")
  static ExplanationGeneratorFactory<OWLAxiom> explanationFactory(
      OWLReasonerFactory reasoners, Supplier<OWLOntologyManager> managers) {
    for (Method m : ExplanationManager.class.getMethods()) {
      if (!m.getName().equals("createExplanationGeneratorFactory")) continue;
      Class<?>[] p = m.getParameterTypes();
      if (p.length == 1 && p[0].isAssignableFrom(reasoners.getClass())) {
        try {
          return (ExplanationGeneratorFactory<OWLAxiom>) m.invoke(null, reasoners);
        } catch (ReflectiveOperationException e) {
          throw new IllegalStateException(e);
        }
      }
      if (p.length == 2 && p[0].isAssignableFrom(reasoners.getClass()) && p[1] == Supplier.class) {
        try {
          return (ExplanationGeneratorFactory<OWLAxiom>) m.invoke(null, reasoners, managers);
        } catch (ReflectiveOperationException e) {
          throw new IllegalStateException(e);
        }
      }
    }
    throw new IllegalStateException("this explanation library has no reasoner-based generator factory");
  }

  @Test
  void readsTurtleAndClassifiesWithHermiT() throws Exception {
    OWLOntology ontology = load(turtle("""
        ex:A a owl:Class .
        ex:B a owl:Class ; rdfs:subClassOf ex:A .
        ex:C a owl:Class ; rdfs:subClassOf ex:B .
        ex:D a owl:Class ; owl:disjointWith ex:A .
        ex:i a owl:NamedIndividual, ex:C .
        """));

    assertEquals(4, ontology.getClassesInSignature().size());

    OWLReasoner reasoner = new ReasonerFactory().createReasoner(ontology);
    try {
      assertTrue(reasoner.isConsistent());
      assertEquals(Set.of(), new HashSet<>(reasoner.getUnsatisfiableClasses().getEntitiesMinusBottom()));

      Set<OWLClass> supers = reasoner.getSuperClasses(cls("C"), false).getFlattened();
      assertTrue(supers.contains(cls("B")), "C is a B");
      assertTrue(supers.contains(cls("A")), "C is an A through B");

      Set<OWLClass> types = reasoner.getTypes(individual("i"), false).getFlattened();
      assertTrue(types.containsAll(Set.of(cls("A"), cls("B"), cls("C"))), "i is an A, a B and a C");
    } finally {
      reasoner.dispose();
    }
  }

  @Test
  void findsAnOntologyInconsistent() throws Exception {
    OWLOntology ontology = load(turtle("""
        ex:X a owl:Class .
        ex:Y a owl:Class ; owl:disjointWith ex:X .
        ex:j a owl:NamedIndividual, ex:X, ex:Y .
        """));
    OWLReasoner reasoner = new ReasonerFactory().createReasoner(ontology);
    try {
      assertFalse(reasoner.isConsistent());
    } finally {
      reasoner.dispose();
    }
  }

  @Test
  void explainsAnEntailmentAsTheServiceDoes() throws Exception {
    OWLOntology ontology = load(turtle("""
        ex:A a owl:Class .
        ex:B a owl:Class ; rdfs:subClassOf ex:A .
        ex:C a owl:Class ; rdfs:subClassOf ex:B .
        """));

    ExplanationGeneratorFactory<OWLAxiom> factory =
        explanationFactory(new ReasonerFactory(), ontology::getOWLOntologyManager);
    ExplanationGenerator<OWLAxiom> generator = factory.createExplanationGenerator(ontology);
    Set<Explanation<OWLAxiom>> explanations =
        generator.getExplanations(df().getOWLSubClassOfAxiom(cls("C"), cls("A")), 2);

    assertFalse(explanations.isEmpty(), "C is an A through B, and that is the justification");
    Explanation<OWLAxiom> first = explanations.iterator().next();
    assertTrue(first.getAxioms().contains(df().getOWLSubClassOfAxiom(cls("C"), cls("B"))));
    assertTrue(first.getAxioms().contains(df().getOWLSubClassOfAxiom(cls("B"), cls("A"))));
    assertTrue(ontology.getAxioms().containsAll(first.getAxioms()), "every justification axiom is in the ontology");
  }

  @Test
  void checksProfilesAndChoosesElkForOwl2El() throws Exception {
    OWLOntology el = load(turtle("""
        ex:ElA a owl:Class .
        ex:ElB a owl:Class ; rdfs:subClassOf ex:ElA .
        ex:ElC a owl:Class ; rdfs:subClassOf ex:ElB .
        ex:hasPart a owl:ObjectProperty .
        ex:ElC rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasPart ; owl:someValuesFrom ex:ElA ] .
        """));
    OWLOntology dl = load(turtle("""
        ex:A a owl:Class .
        ex:B a owl:Class .
        ex:C a owl:Class .
        ex:A rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:allValuesFrom ex:B ] .
        """));

    assertEquals(0, elViolations(el), "the first ontology is in OWL 2 EL, so /reason auto chooses ELK");
    assertTrue(elViolations(dl) > 0, "the second is outside OWL 2 EL, so /reason auto chooses HermiT");
    assertTrue(new OWL2DLProfile().checkOntology(el).getViolations().stream()
        .noneMatch(v -> !v.getClass().getSimpleName().startsWith("UseOfUndeclared")));
  }

  @Test
  void classifiesWithElkAndReportsWhatItLeftOut() throws Exception {
    OWLOntology el = load(turtle("""
        ex:ElA a owl:Class .
        ex:ElB a owl:Class .
        ex:ElC a owl:Class .
        ex:ElB rdfs:subClassOf ex:ElA .
        ex:ElC rdfs:subClassOf ex:ElB .
        """));

    ElkReasoner reasoner = (ElkReasoner) new ElkReasonerFactory().createReasoner(el);
    try {
      assertTrue(reasoner.isConsistent());
      IncompleteResult<NodeSet<OWLClass>> supers = reasoner.computeSuperClasses(cls("ElC"), false);
      assertFalse(supers.getIncompletenessMonitor().isIncompletenessDetected(),
          "nothing outside EL, so the answer is complete");
      Set<OWLClass> flat = Incompleteness.getValue(supers).getFlattened();
      assertTrue(flat.contains(cls("ElB")));
      assertTrue(flat.contains(cls("ElA")));
    } finally {
      reasoner.dispose();
    }

    OWLOntology outside = load(turtle("""
        ex:A a owl:Class .
        ex:B a owl:Class .
        ex:C a owl:Class .
        ex:p a owl:ObjectProperty .
        ex:A rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:allValuesFrom ex:B ] .
        ex:D a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:someValuesFrom ex:C ] .
        """));
    ElkReasoner partial = (ElkReasoner) new ElkReasonerFactory().createReasoner(outside);
    try {
      IncompleteResult<NodeSet<OWLClass>> supers = partial.computeSuperClasses(cls("D"), false);
      assertTrue(supers.getIncompletenessMonitor().isIncompletenessDetected(),
          "ELK says the answer may be missing entailments");
    } finally {
      partial.dispose();
    }
  }

  @Test
  void writesAndRereadsEverySyntax() throws Exception {
    OWLOntology ontology = load("""
        Prefix(:=<http://example.org/>)
        Prefix(owl:=<http://www.w3.org/2002/07/owl#>)
        Prefix(rdfs:=<http://www.w3.org/2000/01/rdf-schema#>)
        Ontology(<http://example.org/convert>
          Declaration(Class(:A))
          Declaration(Class(:B))
          Declaration(ObjectProperty(:p))
          SubClassOf(:A :B)
          SubClassOf(:A ObjectSomeValuesFrom(:p :B))
          AnnotationAssertion(rdfs:label :A "A"@en)
        )
        """);

    List<OWLDocumentFormat> formats = List.of(
        new TurtleDocumentFormat(),
        new RDFXMLDocumentFormat(),
        new OWLXMLDocumentFormat(),
        new FunctionalSyntaxDocumentFormat(),
        new ManchesterSyntaxDocumentFormat());

    for (OWLDocumentFormat format : formats) {
      StringDocumentTarget target = new StringDocumentTarget();
      ontology.saveOntology(format, target);
      assertFalse(target.toString().isBlank(), format.getClass().getSimpleName() + " wrote nothing");

      OWLOntology reread = load(target.toString());
      assertEquals(ontology.getLogicalAxioms(), reread.getLogicalAxioms(),
          format.getClass().getSimpleName() + " kept every logical axiom");
      // The writers may add declarations of standard vocabulary (rdfs:label, rdf:langString):
      // the frontend's own syntax tests allow exactly those, and they say nothing new.
      assertTrue(reread.getAxioms().containsAll(ontology.getAxioms()),
          format.getClass().getSimpleName() + " lost no axiom");
    }
  }

  @Test
  void comparesTwoDocumentsByAxiom() throws Exception {
    OWLOntology original = load(turtle("""
        ex:A a owl:Class .
        ex:B a owl:Class ; rdfs:subClassOf ex:A .
        """));
    OWLOntology exported = load(turtle("""
        ex:A a owl:Class .
        ex:B a owl:Class ; rdfs:subClassOf ex:A .
        ex:C rdfs:subClassOf ex:B .
        """));

    Set<OWLAxiom> onlyExported = new HashSet<>(exported.getAxioms(Imports.INCLUDED));
    onlyExported.removeAll(original.getAxioms(Imports.INCLUDED));
    assertEquals(1, onlyExported.size());
    assertTrue(onlyExported.contains(df().getOWLSubClassOfAxiom(cls("C"), cls("B"))));

    Set<OWLAxiom> onlyOriginal = new HashSet<>(original.getAxioms(Imports.INCLUDED));
    onlyOriginal.removeAll(exported.getAxioms(Imports.INCLUDED));
    assertTrue(onlyOriginal.isEmpty());
  }

  @Test
  void reportsAMissingImportWithoutFetchingIt() throws Exception {
    OWLOntologyManager manager = OWLManager.createOWLOntologyManager();
    manager.setOntologyLoaderConfiguration(new OWLOntologyLoaderConfiguration()
        .setMissingImportHandlingStrategy(MissingImportHandlingStrategy.SILENT));
    // As the service does: every import that was not sent is "found" in a file that does not exist.
    manager.getIRIMappers().add(iri -> IRI.create("file:/conceptweaver-import-not-provided/" + iri));

    OWLOntology ontology = manager.loadOntologyFromOntologyDocument(new StringDocumentSource("""
        @prefix ex: <http://example.org/> .
        @prefix owl: <http://www.w3.org/2002/07/owl#> .

        <http://example.org/with-import> a owl:Ontology ;
            owl:imports <http://example.org/not-provided> .
        ex:A a owl:Class .
        """));

    assertEquals(1, ontology.getImportsDeclarations().size());
    assertEquals(1, manager.getOntologies().size(), "the missing import was not loaded from anywhere");
    assertEquals(1, ontology.getAxiomCount(Imports.INCLUDED));
  }

  @Test
  void runsTheDeclaredOwlApiLine() {
    String expected = System.getProperty("expected.owlapi.version");
    assertNotNull(expected, "the build should pass the profile's OWL API version");
    assertEquals(expected, Versions.of("net.sourceforge.owlapi", "owlapi-api"));
    assertEquals(expected, Versions.of("net.sourceforge.owlapi", "owlapi-impl"));
    assertEquals(System.getProperty("expected.hermit.version"),
        Versions.of("net.sourceforge.owlapi", "org.semanticweb.hermit"));
    assertEquals(System.getProperty("expected.elk.version"),
        Versions.of("io.github.liveontologies", "elk-owlapi"));
    assertEquals(System.getProperty("expected.owlexplanation.version"),
        Versions.of("net.sourceforge.owlapi", "owlexplanation"));
  }
}
