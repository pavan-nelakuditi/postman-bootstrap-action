import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse, stringify, parse as loadYaml, stringify as dumpYaml } from 'yaml';

import { openAlphaActionContract } from './contracts.js';
import { GitHubApiClient, type GitHubApiClientAuthMode } from './lib/github/github-api-client.js';
import { createInternalIntegrationAdapter, type InternalIntegrationAdapter } from './lib/postman/internal-integration-adapter.js';
import { PostmanAssetsClient } from './lib/postman/postman-assets-client.js';
import { resolveCanonicalWorkspaceSelection } from './lib/postman/workspace-selection.js';
import { detectRepoContext } from './lib/repo/context.js';
import { retry } from './lib/retry.js';
import { createSecretMasker } from './lib/secrets.js';

export interface ResolvedInputs {
  projectName: string;
  workspaceId?: string;
  specId?: string;
  baselineCollectionId?: string;
  smokeCollectionId?: string;
  contractCollectionId?: string;
  collectionSyncMode: 'reuse' | 'refresh' | 'version';
  specSyncMode: 'update' | 'version';
  releaseLabel?: string;
  setAsCurrent: boolean;
  domain?: string;
  domainCode?: string;
  requesterEmail?: string;
  workspaceAdminUserIds?: string;
  workspaceTeamId?: string;
  teamId?: string;
  repoUrl?: string;
  specUrl: string;
  environmentsJson: string;
  systemEnvMapJson: string;
  governanceMappingJson: string;
  postmanApiKey: string;
  postmanAccessToken?: string;
  githubToken?: string;
  ghFallbackToken?: string;
  githubAuthMode: string;
  integrationBackend: string;
  githubRefName?: string;
  githubHeadRef?: string;
  githubRef?: string;
  githubSha?: string;
}

export interface PlannedOutputs {
  'workspace-id': string;
  'workspace-url': string;
  'workspace-name': string;
  'spec-id': string;
  'baseline-collection-id': string;
  'smoke-collection-id': string;
  'contract-collection-id': string;
  'collections-json': string;
  'lint-summary-json': string;
  'releases-json': string;
}

export interface LintViolation {
  issue?: string;
  path?: string;
  severity?: string;
}

export interface LintSummary {
  errors: number;
  violations: LintViolation[];
  warnings: number;
}

interface BootstrapRepositoryVariables {
  lintErrors: number;
  lintWarnings: number;
}

interface ReleaseEntry {
  specId?: string;
  collections: {
    baseline?: string;
    smoke?: string;
    contract?: string;
  };
  source?: {
    ref?: string;
    sha?: string;
  };
}

interface ReleasesManifest {
  current?: string;
  releases: Record<string, ReleaseEntry>;
}

type RepoVariableClient = Pick<GitHubApiClient, 'setRepositoryVariable' | 'getRepositoryVariable'>;

export interface CoreLike {
  error(message: string): void;
  getInput(name: string, options?: { required?: boolean }): string;
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
  info(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string): void;
  setSecret(secret: string): void;
  warning(message: string): void;
}

export interface ExecLike {
  exec(
    commandLine: string,
    args?: string[],
    options?: Parameters<typeof exec.exec>[2]
  ): ReturnType<typeof exec.exec>;
  getExecOutput(
    commandLine: string,
    args?: string[],
    options?: Parameters<typeof exec.getExecOutput>[2]
  ): ReturnType<typeof exec.getExecOutput>;
}

export interface IOLike {
  which(tool: string, check?: boolean): Promise<string>;
}

export interface BootstrapExecutionDependencies {
  core: Pick<
    CoreLike,
    'error' | 'group' | 'info' | 'setOutput' | 'warning'
  >;
  exec: ExecLike;
  github?: RepoVariableClient;
  io: IOLike;
  internalIntegration?: Pick<
    InternalIntegrationAdapter,
    'assignWorkspaceToGovernanceGroup'
  >;
  postman: Pick<
    PostmanAssetsClient,
    | 'addAdminsToWorkspace'
    | 'createWorkspace'
    | 'findWorkspacesByName'
    | 'generateCollection'
    | 'getAutoDerivedTeamId'
    | 'getSpecContent'
    | 'getTeams'
    | 'getWorkspaceGitRepoUrl'
    | 'injectTests'
    | 'inviteRequesterToWorkspace'
    | 'tagCollection'
    | 'uploadSpec'
    | 'updateSpec'
  >;
  specFetcher: typeof fetch;
}

export interface BootstrapDependencyFactories {
  core: Pick<CoreLike, 'error' | 'group' | 'info' | 'setOutput' | 'warning'>;
  exec: ExecLike;
  io: IOLike;
  specFetcher?: typeof fetch;
}

function normalizeInputValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getInput(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const envName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  return normalizeInputValue(env[envName]);
}

function requireInput(
  actionCore: Pick<CoreLike, 'getInput'>,
  name: string
): string {
  return actionCore.getInput(name, { required: true }).trim();
}

function optionalInput(
  actionCore: Pick<CoreLike, 'getInput'>,
  name: string
): string | undefined {
  return normalizeInputValue(actionCore.getInput(name));
}

function parseJsonValue<T>(
  raw: string,
  fallback: T,
  inputName: string
): T {
  try {
    return (JSON.parse(raw || JSON.stringify(fallback)) as T) ?? fallback;
  } catch (error) {
    throw new Error(
      `Invalid JSON for ${inputName}: ${error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function asStringArray(value: unknown, inputName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${inputName} must be a JSON array`);
  }
  return value.map((entry) => String(entry));
}

function asStringMap(value: unknown, inputName: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${inputName} must be a JSON object`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      String(entry)
    ])
  );
}

function parseBooleanInput(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseCollectionSyncMode(
  value: string | undefined
): 'reuse' | 'refresh' | 'version' {
  if (value === 'reuse' || value === 'version') {
    return value;
  }
  return 'refresh';
}

function parseSpecSyncMode(value: string | undefined): 'update' | 'version' {
  if (value === 'version') {
    return value;
  }
  return 'update';
}

export function resolveInputs(
  env: NodeJS.ProcessEnv = process.env
): ResolvedInputs {
  const repoContext = detectRepoContext(
    {
      repoUrl: getInput('repo-url', env)
    },
    env
  );

  const integrationBackend =
    getInput('integration-backend', env) ??
    openAlphaActionContract.inputs['integration-backend'].default ??
    'bifrost';

  const allowedBackends =
    openAlphaActionContract.inputs['integration-backend'].allowedValues ?? [];
  if (allowedBackends.length > 0 && !allowedBackends.includes(integrationBackend)) {
    throw new Error(
      `Unsupported integration-backend "${integrationBackend}". Supported values: ${allowedBackends.join(', ')}`
    );
  }

  const specUrl = getInput('spec-url', env) ?? '';
  if (specUrl) {
    try {
      const parsedUrl = new URL(specUrl);
      if (parsedUrl.protocol !== 'https:') {
        throw new Error('not https');
      }
    } catch {
      throw new Error(`spec-url must be a valid HTTPS URL, got: ${specUrl}`);
    }
  }

  return {
    projectName: getInput('project-name', env)
      ?? env.GITHUB_REPOSITORY?.split('/').pop()
      ?? env.CI_PROJECT_NAME
      ?? '',
    workspaceId: getInput('workspace-id', env),
    specId: getInput('spec-id', env),
    baselineCollectionId: getInput('baseline-collection-id', env),
    smokeCollectionId: getInput('smoke-collection-id', env),
    contractCollectionId: getInput('contract-collection-id', env),
    collectionSyncMode: parseCollectionSyncMode(getInput('collection-sync-mode', env)),
    specSyncMode: parseSpecSyncMode(getInput('spec-sync-mode', env)),
    releaseLabel: getInput('release-label', env),
    setAsCurrent: parseBooleanInput(getInput('set-as-current', env), true),
    domain: getInput('domain', env),
    domainCode: getInput('domain-code', env),
    requesterEmail: getInput('requester-email', env),
    workspaceAdminUserIds:
      getInput('workspace-admin-user-ids', env) || env.WORKSPACE_ADMIN_USER_IDS || '',
    workspaceTeamId: getInput('workspace-team-id', env) || env.POSTMAN_WORKSPACE_TEAM_ID,
    teamId: getInput('team-id', env) || env.POSTMAN_TEAM_ID || '',
    repoUrl: repoContext.repoUrl || '',
    specUrl,
    environmentsJson:
      getInput('environments-json', env) ??
      openAlphaActionContract.inputs['environments-json'].default ??
      '["prod"]',
    systemEnvMapJson:
      getInput('system-env-map-json', env) ??
      openAlphaActionContract.inputs['system-env-map-json'].default ??
      '{}',
    governanceMappingJson:
      getInput('governance-mapping-json', env) ??
      openAlphaActionContract.inputs['governance-mapping-json'].default ??
      '{}',
    postmanApiKey: getInput('postman-api-key', env) ?? '',
    postmanAccessToken: getInput('postman-access-token', env),
    githubToken: getInput('github-token', env),
    ghFallbackToken: getInput('gh-fallback-token', env),
    githubAuthMode:
      getInput('github-auth-mode', env) ??
      openAlphaActionContract.inputs['github-auth-mode'].default ??
      'github_token_first',
    integrationBackend,
    githubRefName: env.GITHUB_REF_NAME,
    githubHeadRef: env.GITHUB_HEAD_REF,
    githubRef: env.GITHUB_REF,
    githubSha: env.GITHUB_SHA
  };
}

export function createPlannedOutputs(inputs: ResolvedInputs): PlannedOutputs {
  const workspaceName = inputs.domainCode
    ? `[${inputs.domainCode}] ${inputs.projectName}`
    : inputs.projectName;

  return {
    'workspace-id': '',
    'workspace-url': '',
    'workspace-name': workspaceName,
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
    }),
    'releases-json': ''
  };
}

export function readActionInputs(
  actionCore: Pick<CoreLike, 'getInput' | 'setSecret'>
): ResolvedInputs {
  const projectName = requireInput(actionCore, 'project-name');
  const specUrl = requireInput(actionCore, 'spec-url');
  const postmanApiKey = requireInput(actionCore, 'postman-api-key');
  const postmanAccessToken = optionalInput(actionCore, 'postman-access-token');
  const githubToken = optionalInput(actionCore, 'github-token');
  const ghFallbackToken = optionalInput(actionCore, 'gh-fallback-token');

  actionCore.setSecret(postmanApiKey);
  if (postmanAccessToken) actionCore.setSecret(postmanAccessToken);
  if (githubToken) actionCore.setSecret(githubToken);
  if (ghFallbackToken) actionCore.setSecret(ghFallbackToken);

  const inputs = resolveInputs({
    ...process.env,
    INPUT_PROJECT_NAME: projectName,
    INPUT_WORKSPACE_ID: optionalInput(actionCore, 'workspace-id'),
    INPUT_SPEC_ID: optionalInput(actionCore, 'spec-id'),
    INPUT_BASELINE_COLLECTION_ID: optionalInput(actionCore, 'baseline-collection-id'),
    INPUT_SMOKE_COLLECTION_ID: optionalInput(actionCore, 'smoke-collection-id'),
    INPUT_CONTRACT_COLLECTION_ID: optionalInput(actionCore, 'contract-collection-id'),
    INPUT_COLLECTION_SYNC_MODE:
      optionalInput(actionCore, 'collection-sync-mode') ??
      openAlphaActionContract.inputs['collection-sync-mode'].default,
    INPUT_SPEC_SYNC_MODE:
      optionalInput(actionCore, 'spec-sync-mode') ??
      openAlphaActionContract.inputs['spec-sync-mode'].default,
    INPUT_RELEASE_LABEL: optionalInput(actionCore, 'release-label'),
    INPUT_SET_AS_CURRENT:
      optionalInput(actionCore, 'set-as-current') ??
      openAlphaActionContract.inputs['set-as-current'].default,
    INPUT_DOMAIN: optionalInput(actionCore, 'domain'),
    INPUT_DOMAIN_CODE: optionalInput(actionCore, 'domain-code'),
    INPUT_REQUESTER_EMAIL: optionalInput(actionCore, 'requester-email'),
    INPUT_WORKSPACE_ADMIN_USER_IDS: optionalInput(
      actionCore,
      'workspace-admin-user-ids'
    ),
    INPUT_WORKSPACE_TEAM_ID:
      optionalInput(actionCore, 'workspace-team-id') || process.env.POSTMAN_WORKSPACE_TEAM_ID,
    INPUT_TEAM_ID:
      optionalInput(actionCore, 'postman-team-id') || process.env.POSTMAN_TEAM_ID,
    INPUT_REPO_URL: optionalInput(actionCore, 'repo-url'),
    INPUT_SPEC_URL: specUrl,
    INPUT_ENVIRONMENTS_JSON:
      optionalInput(actionCore, 'environments-json') ??
      openAlphaActionContract.inputs['environments-json'].default,
    INPUT_SYSTEM_ENV_MAP_JSON:
      optionalInput(actionCore, 'system-env-map-json') ??
      openAlphaActionContract.inputs['system-env-map-json'].default,
    INPUT_GOVERNANCE_MAPPING_JSON:
      optionalInput(actionCore, 'governance-mapping-json') ??
      openAlphaActionContract.inputs['governance-mapping-json'].default,
    INPUT_POSTMAN_API_KEY: postmanApiKey,
    INPUT_POSTMAN_ACCESS_TOKEN: postmanAccessToken,
    INPUT_GITHUB_TOKEN: githubToken,
    INPUT_GH_FALLBACK_TOKEN: ghFallbackToken,
    INPUT_GITHUB_AUTH_MODE:
      optionalInput(actionCore, 'github-auth-mode') ??
      openAlphaActionContract.inputs['github-auth-mode'].default,
    INPUT_INTEGRATION_BACKEND:
      optionalInput(actionCore, 'integration-backend') ??
      openAlphaActionContract.inputs['integration-backend'].default
  });

  return inputs;
}

function createWorkspaceName(inputs: ResolvedInputs): string {
  return inputs.domainCode
    ? `[${inputs.domainCode}] ${inputs.projectName}`
    : inputs.projectName;
}

async function runGroup<T>(
  actionCore: Pick<CoreLike, 'group'>,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  return actionCore.group(name, fn);
}

async function ensurePostmanCli(
  dependencies: Pick<BootstrapExecutionDependencies, 'exec' | 'io'>,
  postmanApiKey: string
): Promise<void> {
  const existing = await dependencies.io.which('postman', false).catch(() => '');
  if (!existing) {
    await dependencies.exec.exec('sh', [
      '-c',
      'curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh'
    ]);
  }

  await dependencies.exec.exec('postman', ['login', '--with-api-key', postmanApiKey]);
}

export async function lintSpecViaCli(
  dependencies: Pick<BootstrapExecutionDependencies, 'exec'>,
  workspaceId: string,
  specId: string
): Promise<LintSummary> {
  const result = await dependencies.exec.getExecOutput(
    'postman',
    [
      'spec',
      'lint',
      specId,
      '--workspace-id',
      workspaceId || '',
      '--report-events',
      '-o',
      'json'
    ],
    {
      ignoreReturnCode: true
    }
  );

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    throw new Error(`Spec lint command failed: ${result.stderr}`);
  }

  let parsed: { violations?: LintViolation[] };
  try {
    parsed = JSON.parse(result.stdout || '{}') as { violations?: LintViolation[] };
  } catch {
    throw new Error(
      `Spec lint output is not valid JSON. output: ${result.stdout}, err: ${result.stderr}`
    );
  }

  const violations = parsed.violations || [];
  const errors = violations.filter((entry) => entry.severity === 'ERROR').length;
  const warnings = violations.filter((entry) => entry.severity === 'WARNING').length;

  return {
    errors,
    violations,
    warnings
  };
}

async function fetchSpecDocument(
  specUrl: string,
  specFetcher: typeof fetch
): Promise<string> {
  return retry(
    async () => {
      const response = await specFetcher(specUrl, {
        headers: {
          'User-Agent': 'postman-bootstrap-action'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch spec from URL: ${response.status}`);
      }

      return response.text();
    },
    {
      maxAttempts: 3,
      delayMs: 3000
    }
  );
}

function normalizeReleaseLabel(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
    .replace(/^refs\/pull\//, 'pull-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || undefined;
}

function deriveReleaseLabel(inputs: ResolvedInputs): string | undefined {
  if (inputs.releaseLabel) {
    return normalizeReleaseLabel(inputs.releaseLabel);
  }

  return (
    normalizeReleaseLabel(inputs.githubRefName) ??
    normalizeReleaseLabel(inputs.githubHeadRef) ??
    normalizeReleaseLabel(inputs.githubRef)
  );
}

function parseReleasesManifest(raw: string | undefined): ReleasesManifest {
  if (!raw?.trim()) {
    return { releases: {} };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReleasesManifest>;
    return {
      current:
        typeof parsed.current === 'string' && parsed.current
          ? parsed.current
          : undefined,
      releases:
        parsed.releases && typeof parsed.releases === 'object'
          ? parsed.releases
          : {}
    };
  } catch {
    return { releases: {} };
  }
}

function createAssetProjectName(
  inputs: ResolvedInputs,
  releaseLabel?: string
): string {
  if (!releaseLabel) {
    return inputs.projectName;
  }

  return `${inputs.projectName} ${releaseLabel}`;
}

function createReleaseEntry(
  releaseLabel: string,
  outputs: PlannedOutputs,
  inputs: ResolvedInputs
): ReleaseEntry {
  return {
    specId: outputs['spec-id'],
    collections: {
      baseline: outputs['baseline-collection-id'],
      smoke: outputs['smoke-collection-id'],
      contract: outputs['contract-collection-id']
    },
    source: {
      ref:
        normalizeReleaseLabel(inputs.githubRefName) ??
        normalizeReleaseLabel(inputs.githubRef) ??
        releaseLabel,
      sha: inputs.githubSha || undefined
    }
  };
}

function applyReleaseEntry(
  manifest: ReleasesManifest,
  releaseLabel: string,
  outputs: PlannedOutputs,
  inputs: ResolvedInputs,
  setAsCurrent: boolean
): ReleasesManifest {
  manifest.releases[releaseLabel] = createReleaseEntry(
    releaseLabel,
    outputs,
    inputs
  );
  if (setAsCurrent) {
    manifest.current = releaseLabel;
  }
  return manifest;
}

const SPEC_SUMMARY_MAX_LEN = 200;
const SPEC_HTTP_METHODS = new Set([
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'
]);

/** OpenAPI JSON/YAML: fix missing or oversized operation summaries before Spec Hub upload. */
export function normalizeSpecDocument(raw: string, warn: (msg: string) => void): string {
  const head = raw.trimStart();
  let doc: unknown;
  let asJson = false;
  try {
    if (head.startsWith('{') || head.startsWith('[')) {
      doc = JSON.parse(raw) as unknown;
      asJson = true;
    } else {
      doc = parse(raw) as unknown;
    }
  } catch {
    warn('Spec normalization skipped: document is not valid JSON or YAML.');
    return raw;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return raw;
  const paths = (doc as Record<string, unknown>).paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return raw;

  let changed = false;
  for (const [pathKey, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) continue;
    const item = pathItem as Record<string, unknown>;
    for (const method of Object.keys(item)) {
      if (!SPEC_HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = item[method];
      if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
      const o = op as Record<string, unknown>;
      const prev = o.summary;
      let s = typeof o.summary === 'string' ? o.summary.trim() : '';
      const M = method.toUpperCase();
      if (!s && typeof o.operationId === 'string' && o.operationId.trim()) {
        s = o.operationId.trim();
        warn(`Spec normalization: ${M} ${pathKey} — missing summary; using operationId.`);
      }
      if (!s) {
        s = `${M} ${pathKey}`;
        warn(
          `Spec normalization: ${M} ${pathKey} — missing summary and operationId; using method + path.`
        );
      }
      if (s.length > SPEC_SUMMARY_MAX_LEN) {
        const before = s.length;
        s = `${s.slice(0, SPEC_SUMMARY_MAX_LEN - 1)}…`;
        warn(
          `Spec normalization: ${M} ${pathKey} — summary truncated from ${before} to ${SPEC_SUMMARY_MAX_LEN} characters.`
        );
      }
      if (prev !== s && (typeof prev !== 'string' || prev.trim() !== s)) {
        o.summary = s;
        changed = true;
      }
    }
  }
  if (!changed) return raw;
  return asJson ? `${JSON.stringify(doc, null, 2)}\n` : `${stringify(doc, { lineWidth: 0 })}\n`;
}

function validateSpecStructure(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    try {
      parsed = parse(content);
    } catch {
      throw new Error('Spec content is not valid JSON or YAML');
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Spec content must be a JSON or YAML object');
  }

  const doc = parsed as Record<string, unknown>;
  if (!doc.openapi && !doc.swagger) {
    throw new Error('Spec is missing "openapi" or "swagger" version field');
  }
}

function varName(projectName: string, baseName: string): string {
  const slug = projectName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `POSTMAN_${slug}_${baseName}`;
}

async function getRepositoryVariableSafe(
  github: RepoVariableClient | undefined,
  name: string
): Promise<string | undefined> {
  if (!github) {
    return undefined;
  }

  const value = await github.getRepositoryVariable(name).catch(() => undefined);
  return value || undefined;
}

async function readVariable(
  github: RepoVariableClient | undefined,
  projectName: string,
  baseName: string
): Promise<string | undefined> {
  if (!github) {
    return undefined;
  }

  const namespaced = await getRepositoryVariableSafe(
    github,
    varName(projectName, baseName)
  );
  if (namespaced) {
    return namespaced;
  }

  const legacy = await getRepositoryVariableSafe(github, `POSTMAN_${baseName}`);
  return legacy || undefined;
}

async function persistVariable(
  github: RepoVariableClient | undefined,
  name: string,
  value: string,
  actionCore: Pick<CoreLike, 'warning'>
): Promise<void> {
  if (!github || !value) {
    return;
  }

  try {
    await github.setRepositoryVariable(name, value);
  } catch (err) {
    actionCore.warning(
      `Failed to persist ${name}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function writeVariable(
  github: RepoVariableClient | undefined,
  projectName: string,
  baseName: string,
  value: string,
  actionCore: Pick<CoreLike, 'warning'>
): Promise<void> {
  if (!github || !value) {
    return;
  }

  await persistVariable(github, varName(projectName, baseName), value, actionCore);
  await persistVariable(github, `POSTMAN_${baseName}`, value, actionCore);
}

async function persistBootstrapRepositoryVariables(
  github: RepoVariableClient,
  projectName: string,
  outputs: PlannedOutputs,
  systemEnvMap: Record<string, string>,
  environments: string[],
  lintSummary: BootstrapRepositoryVariables,
  actionCore: Pick<CoreLike, 'warning'>,
  options: {
    setAsCurrent: boolean;
    releaseLabel?: string;
    releasesManifest?: ReleasesManifest;
    inputs: ResolvedInputs;
  }
): Promise<void> {
  await persistVariable(
    github,
    'LINT_WARNINGS',
    String(lintSummary.lintWarnings),
    actionCore
  );
  await persistVariable(
    github,
    'LINT_ERRORS',
    String(lintSummary.lintErrors),
    actionCore
  );
  if (options.setAsCurrent) {
    await writeVariable(
      github,
      projectName,
      'WORKSPACE_ID',
      outputs['workspace-id'],
      actionCore
    );
    await writeVariable(github, projectName, 'SPEC_UID', outputs['spec-id'], actionCore);
    await writeVariable(
      github,
      projectName,
      'BASELINE_COLLECTION_UID',
      outputs['baseline-collection-id'],
      actionCore
    );
    await writeVariable(
      github,
      projectName,
      'SMOKE_COLLECTION_UID',
      outputs['smoke-collection-id'],
      actionCore
    );
    await writeVariable(
      github,
      projectName,
      'CONTRACT_COLLECTION_UID',
      outputs['contract-collection-id'],
      actionCore
    );
  }

  if (options.releaseLabel) {
    const manifest = applyReleaseEntry(
      options.releasesManifest ?? { releases: {} },
      options.releaseLabel,
      outputs,
      options.inputs,
      options.setAsCurrent
    );
    if (options.setAsCurrent) {
      await writeVariable(
        github,
        projectName,
        'RELEASE_LABEL',
        options.releaseLabel,
        actionCore
      );
    }
    await writeVariable(
      github,
      projectName,
      'RELEASES_JSON',
      JSON.stringify(manifest),
      actionCore
    );
  }

  for (const envName of environments) {
    const systemEnvId = systemEnvMap[envName];
    if (!systemEnvId) {
      continue;
    }
    await writeVariable(
      github,
      projectName,
      `SYSTEM_ENV_${envName.toUpperCase()}`,
      systemEnvId,
      actionCore
    );
  }
}

export async function runBootstrap(
  inputs: ResolvedInputs,
  dependencies: BootstrapExecutionDependencies
): Promise<PlannedOutputs> {
  const outputs = createPlannedOutputs(inputs);
  const environments = asStringArray(
    parseJsonValue(inputs.environmentsJson, ['prod'], 'environments-json'),
    'environments-json'
  );
  const systemEnvMap = asStringMap(
    parseJsonValue(inputs.systemEnvMapJson, {}, 'system-env-map-json'),
    'system-env-map-json'
  );
  const requiresReleaseLabel =
    inputs.collectionSyncMode === 'version' || inputs.specSyncMode === 'version';
  const releaseLabel = requiresReleaseLabel ? deriveReleaseLabel(inputs) : undefined;
  if (requiresReleaseLabel && !releaseLabel) {
    throw new Error(
      'Versioned spec or collection sync requires a release-label or derivable GitHub ref metadata'
    );
  }
  const shouldSetCurrentPointers =
    inputs.collectionSyncMode === 'refresh' ? true : inputs.setAsCurrent;
  const workspaceName = createWorkspaceName(inputs);
  const aboutText = `Auto-provisioned by Postman CS open-alpha for ${inputs.projectName}`;

  await runGroup(dependencies.core, 'Install Postman CLI', async () => {
    await ensurePostmanCli(dependencies, inputs.postmanApiKey);
  });


  let explicitWorkspaceId = inputs.workspaceId;

  // .postman/ file fallback for workspace
  if (!explicitWorkspaceId) {
    try {
      const raw = readFileSync('.postman/resources.yaml', 'utf8');
      const config = loadYaml(raw) as Record<string, unknown> | null;
      const wsId = (config?.workspace as Record<string, string> | undefined)?.id;
      if (wsId) {
        explicitWorkspaceId = wsId;
        dependencies.core.info('Resolved workspace-id from .postman/resources.yaml');
      }
    } catch { /* file doesn't exist */ }
  }

  let repoWorkspaceId: string | undefined;
  let workspaceId = explicitWorkspaceId;
  if (!workspaceId && dependencies.github) {
    repoWorkspaceId = await readVariable(
      dependencies.github,
      inputs.projectName,
      'WORKSPACE_ID'
    );
    workspaceId = repoWorkspaceId;
  }

  let teamId = inputs.teamId || '';
  if (!teamId) {
    teamId = await dependencies.postman.getAutoDerivedTeamId() || '';
  }
  const repoUrl = inputs.repoUrl || '';

  if (!explicitWorkspaceId && repoUrl && inputs.postmanAccessToken && teamId) {
    const selection = await runGroup(
      dependencies.core,
      'Resolve Canonical Workspace',
      async () => resolveCanonicalWorkspaceSelection({
        postman: dependencies.postman,
        workspaceName,
        repoWorkspaceId,
        repoUrl,
        teamId,
        accessToken: inputs.postmanAccessToken!,
        warn: (msg) => dependencies.core.warning(msg),
      })
    );

    if (selection.type === 'existing') {
      workspaceId = selection.workspaceId;
      if (selection.warning) {
        dependencies.core.warning(selection.warning);
      }
      dependencies.core.info(`Using canonical workspace (${selection.source}): ${workspaceId}`);
    } else if (selection.type === 'manual_review') {
      throw new Error(`Workspace selection requires manual review: ${selection.reason}`);
    } else {
      workspaceId = undefined;
    }
  } else if (workspaceId) {
    dependencies.core.info(`Using existing workspace: ${workspaceId}`);
  }

  // Parse workspace-team-id from already-resolved inputs
  let workspaceTeamId: number | undefined;
  if (inputs.workspaceTeamId) {
    workspaceTeamId = parseInt(inputs.workspaceTeamId, 10);
    if (Number.isNaN(workspaceTeamId)) {
      throw new Error(`workspace-team-id must be a numeric sub-team ID, got: ${inputs.workspaceTeamId}`);
    }
  }

  // Org-mode detection: only check if we need to create a workspace (not reuse existing)
  if (!workspaceId && !workspaceTeamId) {
    try {
      const teams = await dependencies.postman.getTeams();
      if (teams.length > 1 && teams.every(t => t.organizationId == null)) {
        dependencies.core.warning(
          'GET /teams returned multiple teams but none include organizationId. ' +
          'Org-mode detection may be degraded due to an upstream API change. ' +
          'If workspace creation fails, set workspace-team-id explicitly.'
        );
      }
      const orgIds = new Set(teams.filter(t => t.organizationId != null).map(t => t.organizationId));
      const meTeamId = parseInt(teamId, 10);
      const isOrgMode = teams.length > 1
        && orgIds.size === 1
        && orgIds.has(meTeamId);

      if (isOrgMode) {
        const teamList = teams
          .map(t => `  ${t.id}  ${t.name}`)
          .join('\n');
        throw new Error(
          `Org-mode account detected. Workspace creation requires a specific sub-team ID.\n\n` +
          `Available sub-teams:\n${teamList}\n\n` +
          `To fix this, set the workspace-team-id input in your workflow:\n` +
          `  workspace-team-id: '<id>'\n\n` +
          `Or for reuse across runs, create a repository variable and reference it:\n` +
          `  workspace-team-id: \${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}\n\n` +
          `For CLI usage, pass --workspace-team-id <id> or export POSTMAN_WORKSPACE_TEAM_ID=<id>.`
        );
      } else if (teams.length > 1) {
        dependencies.core.warning(
          `API key has access to ${teams.length} teams but org-mode could not be confirmed. ` +
          `Proceeding without teamId. If workspace creation fails, set workspace-team-id explicitly.`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Org-mode account detected')) {
        throw err;
      }
      dependencies.core.warning(
        `Could not check for org-mode sub-teams: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (!workspaceId) {
    const workspace = await runGroup(
      dependencies.core,
      'Create Postman Workspace',
      async () => dependencies.postman.createWorkspace(workspaceName, aboutText, workspaceTeamId)
    );
    workspaceId = workspace.id;
  }

  outputs['workspace-id'] = workspaceId || '';
  outputs['workspace-url'] = `https://go.postman.co/workspace/${workspaceId}`;
  outputs['workspace-name'] = workspaceName;
  await writeVariable(
    shouldSetCurrentPointers ? dependencies.github : undefined,
    inputs.projectName,
    'WORKSPACE_ID',
    outputs['workspace-id'],
    dependencies.core
  );


  if (inputs.domain && dependencies.internalIntegration) {
    await runGroup(
      dependencies.core,
      'Assign Workspace to Governance Group',
      async () => {
        try {
          await dependencies.internalIntegration?.assignWorkspaceToGovernanceGroup(
            workspaceId || '',
            inputs.domain || '',
            inputs.governanceMappingJson
          );
        } catch (error) {
          dependencies.core.warning(
            `Failed to assign governance group: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );
  }

  if (inputs.requesterEmail) {
    await runGroup(
      dependencies.core,
      'Invite Requester to Workspace',
      async () => {
        try {
          await dependencies.postman.inviteRequesterToWorkspace(
            workspaceId || '',
            inputs.requesterEmail || ''
          );
        } catch (error) {
          dependencies.core.warning(
            `Failed to invite requester: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );
  }

  const adminIds = inputs.workspaceAdminUserIds || '';
  if (adminIds) {
    await runGroup(
      dependencies.core,
      'Add Team Admins to Workspace',
      async () => {
        try {
          await dependencies.postman.addAdminsToWorkspace(workspaceId || '', adminIds);
        } catch (error) {
          dependencies.core.warning(
            `Failed to add team admins: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );
  }


  let releasesManifest: ReleasesManifest = { releases: {} };
  if (requiresReleaseLabel) {
    let fromFile = false;
    try {
      const raw = readFileSync('.postman/releases.yaml', 'utf8');
      const parsed = loadYaml(raw);
      if (parsed && typeof parsed === 'object') {
        releasesManifest = parseReleasesManifest(JSON.stringify(parsed));
        fromFile = true;
        dependencies.core.info('Read releases manifest from .postman/releases.yaml');
      }
    } catch { /* file doesn't exist */ }
    if (!fromFile) {
      const rawManifest = await readVariable(
        dependencies.github,
        inputs.projectName,
        'RELEASES_JSON'
      );
      releasesManifest = parseReleasesManifest(rawManifest);
    }
  }
  const releaseEntry = releaseLabel ? releasesManifest.releases[releaseLabel] : undefined;

  let specId = inputs.specId;
  if (!specId && inputs.specSyncMode === 'version') {
    specId = releaseEntry?.specId;
  }
  if (!specId && inputs.specSyncMode === 'update') {
    try {
      const raw = readFileSync('.postman/resources.yaml', 'utf8');
      const config = loadYaml(raw) as Record<string, unknown> | null;
      const cloudSpecs = (config?.cloudResources as Record<string, unknown> | undefined)?.specs as Record<string, string> | undefined;
      if (cloudSpecs) {
        const firstValue = Object.values(cloudSpecs)[0];
        if (firstValue) {
          specId = firstValue;
          dependencies.core.info('Resolved spec-id from .postman/resources.yaml');
        }
      }
    } catch { /* file doesn't exist */ }
  }
  if (!specId && dependencies.github && inputs.specSyncMode === 'update') {
    specId = await readVariable(dependencies.github, inputs.projectName, 'SPEC_UID');
  }

  let baselineCollectionId =
    inputs.collectionSyncMode === 'refresh' ? undefined : inputs.baselineCollectionId;
  let smokeCollectionId =
    inputs.collectionSyncMode === 'refresh' ? undefined : inputs.smokeCollectionId;
  let contractCollectionId =
    inputs.collectionSyncMode === 'refresh' ? undefined : inputs.contractCollectionId;

  if (inputs.collectionSyncMode === 'version' && releaseEntry) {
    baselineCollectionId = baselineCollectionId || releaseEntry.collections.baseline;
    smokeCollectionId = smokeCollectionId || releaseEntry.collections.smoke;
    contractCollectionId = contractCollectionId || releaseEntry.collections.contract;
  }

  if (inputs.collectionSyncMode === 'reuse') {
    try {
      const raw = readFileSync('.postman/resources.yaml', 'utf8');
      const config = loadYaml(raw) as Record<string, unknown> | null;
      const cloudCols = (config?.cloudResources as Record<string, unknown> | undefined)?.collections as Record<string, string> | undefined;
      if (cloudCols) {
        if (!baselineCollectionId) {
          const match = Object.entries(cloudCols).find(([k]) => k.includes('[Baseline]'));
          if (match) { baselineCollectionId = match[1]; dependencies.core.info('Resolved baseline-collection-id from .postman/resources.yaml'); }
        }
        if (!smokeCollectionId) {
          const match = Object.entries(cloudCols).find(([k]) => k.includes('[Smoke]'));
          if (match) { smokeCollectionId = match[1]; dependencies.core.info('Resolved smoke-collection-id from .postman/resources.yaml'); }
        }
        if (!contractCollectionId) {
          const match = Object.entries(cloudCols).find(([k]) => k.includes('[Contract]'));
          if (match) { contractCollectionId = match[1]; dependencies.core.info('Resolved contract-collection-id from .postman/resources.yaml'); }
        }
      }
    } catch { /* file doesn't exist */ }
  }

  if (dependencies.github) {
    if (!baselineCollectionId && inputs.collectionSyncMode === 'reuse') {
      baselineCollectionId = await readVariable(
        dependencies.github,
        inputs.projectName,
        'BASELINE_COLLECTION_UID'
      );
    }
    if (!smokeCollectionId && inputs.collectionSyncMode === 'reuse') {
      smokeCollectionId = await readVariable(
        dependencies.github,
        inputs.projectName,
        'SMOKE_COLLECTION_UID'
      );
    }
    if (!contractCollectionId && inputs.collectionSyncMode === 'reuse') {
      contractCollectionId = await readVariable(
        dependencies.github,
        inputs.projectName,
        'CONTRACT_COLLECTION_UID'
      );
    }
  }

  if (specId) {
    dependencies.core.info(`Updating existing spec ${specId} from ${inputs.specUrl}`);
  }

  const isSpecUpdate = Boolean(specId);
  let previousSpecContent: string | undefined;

  const specContent = await runGroup(
    dependencies.core,
    specId ? 'Update Spec in Spec Hub' : 'Upload Spec to Spec Hub',
    async () => {
      const fetched = await fetchSpecDocument(inputs.specUrl, dependencies.specFetcher);
      const document = normalizeSpecDocument(fetched, (msg) =>
        dependencies.core.warning(msg)
      );
      validateSpecStructure(document);
      if (specId) {
        previousSpecContent = await dependencies.postman.getSpecContent(specId);
        await dependencies.postman.updateSpec(specId, document, workspaceId);
      } else {
        specId = await dependencies.postman.uploadSpec(
          workspaceId || '',
          createAssetProjectName(
            inputs,
            inputs.specSyncMode === 'version' ? releaseLabel : undefined
          ),
          document
        );
      }
      outputs['spec-id'] = specId;
      return document;
    }
  );

  void specContent;
  await writeVariable(
    shouldSetCurrentPointers ? dependencies.github : undefined,
    inputs.projectName,
    'SPEC_UID',
    outputs['spec-id'],
    dependencies.core
  );

  const lintSummary = await runGroup(
    dependencies.core,
    'Lint Spec via Postman CLI',
    async () => lintSpecViaCli(dependencies, workspaceId || '', outputs['spec-id'])
  );
  outputs['lint-summary-json'] = JSON.stringify({
    errors: lintSummary.errors,
    total: lintSummary.violations.length,
    violations: lintSummary.violations,
    warnings: lintSummary.warnings
  });

  if (lintSummary.errors > 0) {
    if (isSpecUpdate && specId && previousSpecContent !== undefined) {
      const restoringSpecId = specId;
      const previous = previousSpecContent;
      await runGroup(
        dependencies.core,
        'Restore Previous Spec Content',
        async () => {
          await dependencies.postman.updateSpec(restoringSpecId, previous, workspaceId);
        }
      );
    }
    lintSummary.violations
      .filter((entry) => entry.severity === 'ERROR')
      .forEach((entry) => {
        dependencies.core.error(`  ${entry.path || '<unknown>'}: ${entry.issue || 'Unknown lint error'}`);
      });
    throw new Error(`Spec lint found ${lintSummary.errors} errors`);
  }

  lintSummary.violations
    .filter((entry) => entry.severity === 'WARNING')
    .forEach((entry) => {
      dependencies.core.warning(
        `  ${entry.path || '<unknown>'}: ${entry.issue || 'Unknown lint warning'}`
      );
    });

  await runGroup(
    dependencies.core,
    'Generate Collections from Spec',
    async () => {
      const shouldReuseCollections =
        inputs.collectionSyncMode === 'reuse' ||
        (inputs.collectionSyncMode === 'version' &&
          Boolean(baselineCollectionId && smokeCollectionId && contractCollectionId));
      const assetProjectName =
        inputs.collectionSyncMode === 'version'
          ? createAssetProjectName(inputs, releaseLabel)
          : inputs.projectName;

      outputs['baseline-collection-id'] =
        shouldReuseCollections ? baselineCollectionId || '' : '';
      outputs['smoke-collection-id'] =
        shouldReuseCollections ? smokeCollectionId || '' : '';
      outputs['contract-collection-id'] =
        shouldReuseCollections ? contractCollectionId || '' : '';

      if (!outputs['baseline-collection-id']) {
        outputs['baseline-collection-id'] = await dependencies.postman.generateCollection(
          outputs['spec-id'],
          assetProjectName,
          '[Baseline]'
        );
      } else {
        dependencies.core.info(
          `Using existing baseline collection: ${outputs['baseline-collection-id']}`
        );
      }
      await writeVariable(
        shouldSetCurrentPointers ? dependencies.github : undefined,
        inputs.projectName,
        'BASELINE_COLLECTION_UID',
        outputs['baseline-collection-id'],
        dependencies.core
      );

      if (!outputs['smoke-collection-id']) {
        outputs['smoke-collection-id'] = await dependencies.postman.generateCollection(
          outputs['spec-id'],
          assetProjectName,
          '[Smoke]'
        );
      } else {
        dependencies.core.info(
          `Using existing smoke collection: ${outputs['smoke-collection-id']}`
        );
      }
      await writeVariable(
        shouldSetCurrentPointers ? dependencies.github : undefined,
        inputs.projectName,
        'SMOKE_COLLECTION_UID',
        outputs['smoke-collection-id'],
        dependencies.core
      );

      if (!outputs['contract-collection-id']) {
        outputs['contract-collection-id'] = await dependencies.postman.generateCollection(
          outputs['spec-id'],
          assetProjectName,
          '[Contract]'
        );
      } else {
        dependencies.core.info(
          `Using existing contract collection: ${outputs['contract-collection-id']}`
        );
      }
      await writeVariable(
        shouldSetCurrentPointers ? dependencies.github : undefined,
        inputs.projectName,
        'CONTRACT_COLLECTION_UID',
        outputs['contract-collection-id'],
        dependencies.core
      );
    }
  );

  outputs['collections-json'] = JSON.stringify({
    baseline: outputs['baseline-collection-id'],
    contract: outputs['contract-collection-id'],
    smoke: outputs['smoke-collection-id']
  });

  await runGroup(
    dependencies.core,
    'Inject Test Scripts',
    async () => {
      await Promise.all([
        dependencies.postman.injectTests(outputs['smoke-collection-id'], 'smoke'),
        dependencies.postman.injectTests(
          outputs['contract-collection-id'],
          'contract'
        )
      ]);
    }
  );

  await runGroup(
    dependencies.core,
    'Tag Collections',
    async () => {
      await Promise.all([
        dependencies.postman.tagCollection(outputs['baseline-collection-id'], [
          'generated-docs'
        ]),
        dependencies.postman.tagCollection(outputs['smoke-collection-id'], [
          'generated-smoke'
        ]),
        dependencies.postman.tagCollection(outputs['contract-collection-id'], [
          'generated-contract'
        ])
      ]);
    }
  );

  if (dependencies.github) {
    const github = dependencies.github;
    await runGroup(
      dependencies.core,
      'Store Postman UIDs as Repo Variables',
      async () => {
        await persistBootstrapRepositoryVariables(
          github,
          inputs.projectName,
          outputs,
          systemEnvMap,
          environments,
          {
            lintErrors: lintSummary.errors,
            lintWarnings: lintSummary.warnings
          },
          dependencies.core,
          {
            setAsCurrent: shouldSetCurrentPointers,
            releaseLabel,
            releasesManifest,
            inputs
          }
        );
      }
    );
  }

  if (releaseLabel) {
    releasesManifest = applyReleaseEntry(
      releasesManifest,
      releaseLabel,
      outputs,
      inputs,
      shouldSetCurrentPointers
    );
  }

  // Write releases manifest to disk and emit as output
  if (releaseLabel && Object.keys(releasesManifest.releases).length > 0) {
    try {
      mkdirSync('.postman', { recursive: true });
      writeFileSync('.postman/releases.yaml', dumpYaml(releasesManifest as unknown as Record<string, unknown>, {
        lineWidth: -1
      }));
    } catch (err) {
      dependencies.core.warning(`Failed to write .postman/releases.yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
    outputs['releases-json'] = JSON.stringify(releasesManifest);
  }

  for (const [name, value] of Object.entries(outputs)) {
    dependencies.core.setOutput(name, value);
  }

  return outputs;
}

export async function runAction(
  actionCore: CoreLike = core,
  actionExec: ExecLike = exec,
  actionIo: IOLike = io
): Promise<PlannedOutputs> {
  const inputs = readActionInputs(actionCore);
  const dependencies = createBootstrapDependencies(inputs, {
    core: actionCore,
    exec: actionExec,
    io: actionIo,
    specFetcher: fetch
  });

  if (!dependencies.github) {
    actionCore.info('GitHub repository variable persistence disabled for this run');
  }
  if (inputs.domain && !dependencies.internalIntegration) {
    actionCore.warning(
      'Skipping governance assignment because postman-access-token is not configured'
    );
  }

  return runBootstrap(inputs, dependencies);
}

export function createBootstrapDependencies(
  inputs: ResolvedInputs,
  factories: BootstrapDependencyFactories
): BootstrapExecutionDependencies {
  const secretMasker = createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    inputs.githubToken,
    inputs.ghFallbackToken
  ]);
  const postman = new PostmanAssetsClient({
    apiKey: inputs.postmanApiKey,
    secretMasker
  });
  const repository = extractRepositorySlug(inputs.repoUrl);
  const github =
    inputs.githubToken && inputs.repoUrl && repository
      ? new GitHubApiClient({
        authMode: inputs.githubAuthMode as GitHubApiClientAuthMode,
        fallbackToken: inputs.ghFallbackToken,
        repository,
        secretMasker,
        token: inputs.githubToken
      })
      : undefined;
  const internalIntegration =
    inputs.postmanAccessToken
      ? createInternalIntegrationAdapter({
        accessToken: inputs.postmanAccessToken,
        backend: inputs.integrationBackend,
        secretMasker,
        teamId: inputs.teamId || ''
      })
      : undefined;

  return {
    core: factories.core,
    exec: factories.exec,
    github,
    io: factories.io,
    internalIntegration,
    postman,
    specFetcher: factories.specFetcher ?? fetch
  };
}

export function extractRepositorySlug(repoUrl: string | undefined): string | undefined {
  const normalized = normalizeInputValue(repoUrl);
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runAction().catch((error) => {
    if (error instanceof Error) {
      core.setFailed(error.message);
      return;
    }
    core.setFailed(String(error));
  });
}
