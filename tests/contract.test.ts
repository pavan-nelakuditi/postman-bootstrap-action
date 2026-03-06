import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  betaActionContract,
  contractInputNames,
  contractOutputNames
} from '../src/contracts.js';
import { createPlannedOutputs, resolveInputs } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..');
const actionManifest = parse(
  readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')
) as {
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
};

describe('beta action contract', () => {
  it('uses kebab-case input and output names', () => {
    const kebabCasePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    for (const name of [...contractInputNames, ...contractOutputNames]) {
      expect(name).toMatch(kebabCasePattern);
    }
  });

  it('keeps action.yml aligned with the contract surface', () => {
    expect(Object.keys(actionManifest.inputs)).toEqual(contractInputNames);
    expect(Object.keys(actionManifest.outputs)).toEqual(contractOutputNames);
  });

  it('defaults integration-backend to bifrost in the contract, manifest, and runtime', () => {
    expect(betaActionContract.inputs['integration-backend'].default).toBe('bifrost');
    expect(betaActionContract.inputs['integration-backend'].allowedValues).toEqual([
      'bifrost'
    ]);
    expect(actionManifest.inputs['integration-backend'].default).toBe('bifrost');
    expect(resolveInputs({}).integrationBackend).toBe('bifrost');
  });

  it('rejects unsupported integration backends during input resolution', () => {
    expect(() =>
      resolveInputs({
        INPUT_INTEGRATION_BACKEND: 'custom'
      })
    ).toThrow(/Unsupported integration-backend/);
  });

  it('documents the retained bootstrap steps and removed internal-only behavior', () => {
    expect(betaActionContract.retainedBehavior).toContain('spec linting by UID');
    expect(betaActionContract.retainedBehavior).toContain('workspace creation');
    expect(betaActionContract.retainedBehavior).toContain(
      'governance group assignment'
    );
    expect(betaActionContract.retainedBehavior).toContain(
      'GitHub repository variable persistence for downstream sync steps'
    );
    expect(betaActionContract.removedBehavior).toContain('step mode');
    expect(betaActionContract.removedBehavior).toContain(
      'aws, docker, and infra workflow concerns'
    );
  });

  it('builds placeholder outputs that match the public beta output surface', () => {
    const outputs = createPlannedOutputs(
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_DOMAIN_CODE: 'AF',
        INPUT_SPEC_URL: 'https://example.com/openapi.yaml',
        INPUT_POSTMAN_API_KEY: 'pmak-test'
      })
    );

    expect(outputs).toEqual({
      'workspace-id': '',
      'workspace-url': '',
      'workspace-name': '[AF] core-payments',
      'spec-id': '',
      'baseline-collection-id': '',
      'smoke-collection-id': '',
      'contract-collection-id': '',
      'collections-json': JSON.stringify({
        baseline: '',
        smoke: '',
        contract: ''
      }),
      'lint-summary-json': JSON.stringify({
        errors: 0,
        total: 0,
        violations: [],
        warnings: 0
      })
    });
  });
});
