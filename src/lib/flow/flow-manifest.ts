import { parse } from 'yaml';
import type { SpecOperationEntry } from './operation-catalog.js';

type AnyRecord = Record<string, unknown>;

export interface ParsedFlowManifest {
  spec?: {
    fileName?: string;
    title?: string;
    version?: string;
  };
  flows: Array<{
    name: string;
    type: 'smoke' | 'contract';
    steps: Array<{
      stepKey: string;
      operationId: string;
      bindings?: Array<{
        fieldKey: string;
        source: 'example' | 'literal' | 'prior_output';
        value?: string;
        sourceStepKey?: string;
        variable?: string;
      }>;
      extract?: Array<{
        variable: string;
        jsonPath: string;
      }>;
    }>;
  }>;
}

type ParsedFlow = ParsedFlowManifest['flows'][number];
type ParsedFlowStep = ParsedFlow['steps'][number];
type ParsedFlowBinding = NonNullable<ParsedFlowStep['bindings']>[number];
type ParsedFlowExtract = NonNullable<ParsedFlowStep['extract']>[number];

function isObject(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseFlowManifest(content: string): ParsedFlowManifest {
  const parsed = parse(content) as unknown;
  if (!isObject(parsed)) {
    throw new Error('Flow manifest must be a YAML object');
  }

  if (!Array.isArray(parsed.flows)) {
    throw new Error('Flow manifest must contain a flows array');
  }

  const flows: ParsedFlow[] = parsed.flows.map((flow, flowIndex) => {
    if (!isObject(flow)) {
      throw new Error(`Flow at index ${flowIndex} must be an object`);
    }
    if (typeof flow.name !== 'string' || !flow.name.trim()) {
      throw new Error(`Flow at index ${flowIndex} is missing a name`);
    }
    if (flow.type !== 'smoke' && flow.type !== 'contract') {
      throw new Error(`Flow "${flow.name}" has an unsupported type`);
    }
    if (!Array.isArray(flow.steps)) {
      throw new Error(`Flow "${flow.name}" must contain a steps array`);
    }

    return {
      name: flow.name,
      type: flow.type,
      steps: flow.steps.map((step, stepIndex): ParsedFlowStep => {
        if (!isObject(step)) {
          throw new Error(`Step ${stepIndex + 1} in flow "${flow.name}" must be an object`);
        }
        if (typeof step.stepKey !== 'string' || !step.stepKey.trim()) {
          throw new Error(`Step ${stepIndex + 1} in flow "${flow.name}" is missing stepKey`);
        }
        if (typeof step.operationId !== 'string' || !step.operationId.trim()) {
          throw new Error(`Step ${step.stepKey} in flow "${flow.name}" is missing operationId`);
        }
        if (step.bindings && !Array.isArray(step.bindings)) {
          throw new Error(`Step ${step.stepKey} in flow "${flow.name}" has invalid bindings`);
        }
        if (step.extract && !Array.isArray(step.extract)) {
          throw new Error(`Step ${step.stepKey} in flow "${flow.name}" has invalid extract rules`);
        }

        return {
          stepKey: step.stepKey,
          operationId: step.operationId,
          bindings: Array.isArray(step.bindings)
            ? step.bindings.map((binding, bindingIndex): ParsedFlowBinding => {
                if (!isObject(binding)) {
                  throw new Error(`Binding ${bindingIndex + 1} on step ${step.stepKey} must be an object`);
                }
                if (typeof binding.fieldKey !== 'string' || !binding.fieldKey.trim()) {
                  throw new Error(`Binding ${bindingIndex + 1} on step ${step.stepKey} is missing fieldKey`);
                }
                if (
                  binding.source !== 'example' &&
                  binding.source !== 'literal' &&
                  binding.source !== 'prior_output'
                ) {
                  throw new Error(`Binding ${binding.fieldKey} on step ${step.stepKey} has invalid source`);
                }
                return {
                  fieldKey: binding.fieldKey,
                  source: binding.source,
                  ...(typeof binding.value === 'string' ? { value: binding.value } : {}),
                  ...(typeof binding.sourceStepKey === 'string'
                    ? { sourceStepKey: binding.sourceStepKey }
                    : {}),
                  ...(typeof binding.variable === 'string' ? { variable: binding.variable } : {})
                };
              })
            : [],
          extract: Array.isArray(step.extract)
            ? step.extract.map((extract, extractIndex): ParsedFlowExtract => {
                if (!isObject(extract)) {
                  throw new Error(`Extract ${extractIndex + 1} on step ${step.stepKey} must be an object`);
                }
                if (typeof extract.variable !== 'string' || !extract.variable.trim()) {
                  throw new Error(`Extract ${extractIndex + 1} on step ${step.stepKey} is missing variable`);
                }
                if (typeof extract.jsonPath !== 'string' || !extract.jsonPath.trim()) {
                  throw new Error(`Extract ${extractIndex + 1} on step ${step.stepKey} is missing jsonPath`);
                }
                return {
                  variable: extract.variable,
                  jsonPath: extract.jsonPath
                };
              })
            : []
        };
      })
    };
  });

  return {
    ...(isObject(parsed.spec) ? { spec: parsed.spec } : {}),
    flows
  };
}

export function validateFlowManifestAgainstSpec(
  manifest: ParsedFlowManifest,
  specOperations: SpecOperationEntry[]
): void {
  const operationMap = new Map(specOperations.map((operation) => [operation.operationId, operation]));

  manifest.flows.forEach((flow) => {
    const extractedVariablesByStep = new Map<string, Set<string>>();

    flow.steps.forEach((step) => {
      const operation = operationMap.get(step.operationId);
      if (!operation) {
        throw new Error(
          `Flow "${flow.name}" references unknown operationId "${step.operationId}"`
        );
      }

      for (const binding of step.bindings ?? []) {
        if (!operation.inputTargets[binding.fieldKey]) {
          throw new Error(
            `Flow "${flow.name}" step "${step.stepKey}" binds unknown field "${binding.fieldKey}" for operation "${step.operationId}"`
          );
        }

        if (binding.source === 'literal' && typeof binding.value !== 'string') {
          throw new Error(
            `Flow "${flow.name}" step "${step.stepKey}" binding "${binding.fieldKey}" requires a literal value`
          );
        }

        if (binding.source === 'prior_output') {
          if (!binding.sourceStepKey || !binding.variable) {
            throw new Error(
              `Flow "${flow.name}" step "${step.stepKey}" prior_output binding "${binding.fieldKey}" requires sourceStepKey and variable`
            );
          }

          const availableVariables = extractedVariablesByStep.get(binding.sourceStepKey);
          if (!availableVariables) {
            throw new Error(
              `Flow "${flow.name}" step "${step.stepKey}" references unknown prior step "${binding.sourceStepKey}"`
            );
          }
          if (!availableVariables.has(binding.variable)) {
            throw new Error(
              `Flow "${flow.name}" step "${step.stepKey}" references missing extracted variable "${binding.variable}" from step "${binding.sourceStepKey}"`
            );
          }
        }
      }

      extractedVariablesByStep.set(
        step.stepKey,
        new Set((step.extract ?? []).map((extract) => extract.variable))
      );
    });
  });
}
