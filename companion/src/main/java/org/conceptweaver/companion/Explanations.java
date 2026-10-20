package org.conceptweaver.companion;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.function.Supplier;
import org.semanticweb.owl.explanation.api.ExplanationGeneratorFactory;
import org.semanticweb.owl.explanation.api.ExplanationManager;
import org.semanticweb.owl.explanation.impl.blackbox.checker.InconsistentOntologyExplanationGeneratorFactory;
import org.semanticweb.owlapi.apibinding.OWLManager;
import org.semanticweb.owlapi.model.OWLAxiom;
import org.semanticweb.owlapi.model.OWLDataFactory;
import org.semanticweb.owlapi.model.OWLOntologyManager;
import org.semanticweb.owlapi.reasoner.OWLReasonerFactory;

/**
 * The two explanation factories whose signatures differ between the explanation library built for
 * OWL API 4 (2.0.0) and the one built for OWL API 5 (5.0.1). The other calls are the same on both
 * lines; these are made by asking the loaded library for the constructor or method it has, so that
 * one source tree runs against either profile.
 */
final class Explanations {

  private Explanations() {}

  @SuppressWarnings("unchecked")
  static ExplanationGeneratorFactory<OWLAxiom> manager(OWLReasonerFactory reasoners) {
    try {
      try {
        // owlexplanation 5.0.1: a supplier of the manager each fresh reasoner is made with.
        Method both = ExplanationManager.class.getMethod("createExplanationGeneratorFactory", OWLReasonerFactory.class, Supplier.class);
        return (ExplanationGeneratorFactory<OWLAxiom>) both.invoke(null, reasoners, (Supplier<OWLOntologyManager>) OWLManager::createOWLOntologyManager);
      } catch (NoSuchMethodException four) {
        // owlexplanation 2.0.0: the reasoner factory alone.
        Method one = ExplanationManager.class.getMethod("createExplanationGeneratorFactory", OWLReasonerFactory.class);
        return (ExplanationGeneratorFactory<OWLAxiom>) one.invoke(null, reasoners);
      }
    } catch (ReflectiveOperationException e) {
      throw new IllegalStateException("The explanation library offers no factory this build knows: " + e, e);
    }
  }

  @SuppressWarnings("unchecked")
  static ExplanationGeneratorFactory<OWLAxiom> inconsistent(OWLReasonerFactory reasoners, OWLDataFactory df, long budget) {
    for (Constructor<?> constructor : InconsistentOntologyExplanationGeneratorFactory.class.getConstructors()) {
      Class<?>[] types = constructor.getParameterTypes();
      try {
        // owlexplanation 2.0.0: (reasoner factory, budget).
        if (types.length == 2 && types[0] == OWLReasonerFactory.class && types[1] == long.class) {
          return (ExplanationGeneratorFactory<OWLAxiom>) constructor.newInstance(reasoners, budget);
        }
        // owlexplanation 5.0.1: (reasoner factory, data factory, manager supplier, budget).
        if (types.length == 4 && types[0] == OWLReasonerFactory.class && types[1] == OWLDataFactory.class && types[2] == Supplier.class && types[3] == long.class) {
          return (ExplanationGeneratorFactory<OWLAxiom>) constructor.newInstance(reasoners, df, (Supplier<OWLOntologyManager>) OWLManager::createOWLOntologyManager, budget);
        }
      } catch (ReflectiveOperationException e) {
        throw new IllegalStateException("The inconsistent-ontology explanation factory could not be made: " + e, e);
      }
    }
    throw new IllegalStateException("The explanation library offers no inconsistent-ontology factory this build knows.");
  }
}
