import type { ElementRef, LogicalModel } from './contracts';
import { problemsOf } from './rules';

/**
 * What is worth saying about the project's logical data models (roadmap LM-2, FR-M17-10): what
 * breaks an LDM's rules, and the modelling questions that are not errors — an entity nothing
 * identifies, a many-to-many relationship that an associative entity would resolve. Each names
 * the model and the element it is about, so that it opens where it is edited.
 */

export type LdmLevel = 'error' | 'warning' | 'info';

export interface LdmProblem {
  /** Stable for as long as the element is: the same finding is the same line in the list. */
  id: string;
  model: string;
  modelName: string;
  severity: LdmLevel;
  ruleId: string;
  rule: string;
  message: string;
  /** The element it is about, or nothing when it is about the model as a whole. */
  element?: ElementRef;
  /** What the element is called, with the model for a finding about the model itself. */
  elementName: string;
}

const idOf = (ref: ElementRef) => Object.values(ref)[0] as string;

/** What the element is called, plainly: a table of results names it, not a sentence about it. */
function nameOf(model: LogicalModel, ref: ElementRef): string {
  const id = idOf(ref);
  const [kind] = Object.keys(ref);
  const entity = model.entities.find((e) => e.id === id);
  if (kind === 'entity') return entity?.name || id;
  if (kind === 'attribute') {
    for (const e of model.entities) {
      const attribute = e.attributes.find((a) => a.id === id);
      if (attribute) return `${e.name}.${attribute.name}`;
    }
    return id;
  }
  if (kind === 'key') {
    for (const e of model.entities) {
      const key = e.keys.find((k) => k.id === id);
      if (key) return `${e.name}.${key.name || 'key'}`;
    }
    return id;
  }
  if (kind === 'relationship') return model.relationships.find((r) => r.id === id)?.name || id;
  if (kind === 'generalization') {
    const g = model.generalizations.find((x) => x.id === id);
    return g ? `Generalization of ${model.entities.find((e) => e.id === g.supertype)?.name ?? g.supertype}` : id;
  }
  if (kind === 'rule') return model.rules.find((r) => r.id === id)?.name || id;
  if (kind === 'domain') return model.domains.find((d) => d.id === id)?.name || id;
  if (kind === 'diagram') return model.diagrams.find((d) => d.id === id)?.name || id;
  return id;
}

const target = (model: LogicalModel, ref: ElementRef | { model: true } | undefined): { element?: ElementRef; elementName: string } => {
  if (!ref || 'model' in ref) return { elementName: model.name };
  return { element: ref, elementName: nameOf(model, ref) };
};

/** Everything the editor has to say about these LDMs, in the order the models are in. */
export function ldmProblems(models: LogicalModel[]): LdmProblem[] {
  const out: LdmProblem[] = [];
  for (const model of models) {
    // More than one rule can be broken by the same element: the nth finding about it gets its
    // own id, in the order the problems are found, which is the same for the same model.
    const seen = new Map<string, number>();
    const add = (severity: LdmLevel, ruleId: string, rule: string, message: string, ref?: ElementRef | { model: true }) => {
      const { element, elementName } = target(model, ref);
      const prefix = `ldm:${model.id}:${ruleId}:${element ? `${Object.keys(element)[0]}:${idOf(element)}` : 'model'}`;
      const n = (seen.get(prefix) ?? 0) + 1;
      seen.set(prefix, n);
      out.push({ id: `${prefix}:${n}`, model: model.id, modelName: model.name, severity, ruleId, rule, message, ...(element ? { element } : {}), elementName });
    };

    // What the model's own rules find. An LDM that breaks one cannot be applied to; this is what
    // an imported or older document would show, and what the editor would say if one slipped in.
    for (const refusal of problemsOf(model)) {
      add(refusal.code === 'invalid' ? 'error' : 'warning', 'ldm-rule', 'Breaks a logical data model rule', refusal.message, refusal.element);
    }

    for (const entity of model.entities) {
      if (!entity.keys.some((k) => k.kind === 'primary')) {
        add('warning', 'ldm-no-primary-key', 'Entity without a primary key', `The entity “${entity.name}” has no primary key: nothing tells one of its instances from another.`, { entity: entity.id });
      }
    }

    for (const relationship of model.relationships) {
      if (relationship.ends[0].max === 'many' && relationship.ends[1].max === 'many') {
        add('info', 'ldm-many-to-many', 'Many-to-many relationship', `The relationship “${relationship.name || 'unnamed'}” is many-to-many. An associative entity can resolve it.`, { relationship: relationship.id });
      }
    }
  }
  return out;
}
