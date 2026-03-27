import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import { readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

import { openAlphaActionContract } from './contracts.js';
import {
  buildBaselineRequestCatalog,
  buildSpecOperationCatalog,
  matchOperationsToBaselineRequests,
  type SpecOperationEntry
} from './lib/flow/operation-catalog.js';
import { compileFlowCollectionItems } from './lib/flow/flow-compiler.js';
import { fetchFlowManifest } from './lib/flow/flow-manifest-client.js';
import {
  parseFlowManifest,
  type ParsedFlowManifest,
  validateFlowManifestAgainstSpec
} from './lib/flow/flow-manifest.js';
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
  syncExamples: boolean;
  collectionSyncMode: 'reuse' | 'refresh' | 'version';
  specSyncMode: 'update' | 'version';
  releaseLabel?: string;
  flowManifestUrl?: string;
  domain?: string;
  domainCode?: string;
  requesterEmail?: string;
  workspaceAdminUserIds?: string;
  workspaceTeamId?: string;
  teamId?: string;
  repoUrl?: string;
  specUrl: string;
  governanceMappingJson: string;
  postmanApiKey: string;
  postmanAccessToken?: string;
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
  io: IOLike;
  internalIntegration?: Pick<
    InternalIntegrationAdapter,
    'assignWorkspaceToGovernanceGroup' | 'linkCollectionsToSpecification' | 'syncCollection'
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
  > &
    Partial<Pick<PostmanAssetsClient, 'getCollection' | 'updateCollection'>>;
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

  const flowManifestUrl = getInput('flow-manifest-url', env) ?? '';
  if (flowManifestUrl) {
    try {
      const parsedUrl = new URL(flowManifestUrl);
      if (parsedUrl.protocol !== 'https:') {
        throw new Error('not https');
      }
    } catch {
      throw new Error(`flow-manifest-url must be a valid HTTPS URL, got: ${flowManifestUrl}`);
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
    syncExamples: parseBooleanInput(getInput('sync-examples', env), true),
    collectionSyncMode: parseCollectionSyncMode(getInput('collection-sync-mode', env)),
    specSyncMode: parseSpecSyncMode(getInput('spec-sync-mode', env)),
    releaseLabel: getInput('release-label', env),
    flowManifestUrl: getInput('flow-manifest-url', env),
    domain: getInput('domain', env),
    domainCode: getInput('domain-code', env),
    requesterEmail: getInput('requester-email', env),
    workspaceAdminUserIds:
      getInput('workspace-admin-user-ids', env) || env.WORKSPACE_ADMIN_USER_IDS || '',
    workspaceTeamId: getInput('workspace-team-id', env) || env.POSTMAN_WORKSPACE_TEAM_ID,
    teamId: getInput('team-id', env) || env.POSTMAN_TEAM_ID || '',
    repoUrl: repoContext.repoUrl || '',
    specUrl,
    governanceMappingJson:
      getInput('governance-mapping-json', env) ??
      openAlphaActionContract.inputs['governance-mapping-json'].default ??
      '{}',
    postmanApiKey: getInput('postman-api-key', env) ?? '',
    postmanAccessToken: getInput('postman-access-token', env),
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
    })
  };
}

export function readActionInputs(
  actionCore: Pick<CoreLike, 'getInput' | 'setSecret'>
): ResolvedInputs {
  const projectName = requireInput(actionCore, 'project-name');
  const specUrl = requireInput(actionCore, 'spec-url');
  const postmanApiKey = requireInput(actionCore, 'postman-api-key');
  const postmanAccessToken = optionalInput(actionCore, 'postman-access-token');

  actionCore.setSecret(postmanApiKey);
  if (postmanAccessToken) actionCore.setSecret(postmanAccessToken);

  const inputs = resolveInputs({
    ...process.env,
    INPUT_PROJECT_NAME: projectName,
    INPUT_WORKSPACE_ID: optionalInput(actionCore, 'workspace-id'),
    INPUT_SPEC_ID: optionalInput(actionCore, 'spec-id'),
    INPUT_BASELINE_COLLECTION_ID: optionalInput(actionCore, 'baseline-collection-id'),
    INPUT_SMOKE_COLLECTION_ID: optionalInput(actionCore, 'smoke-collection-id'),
    INPUT_CONTRACT_COLLECTION_ID: optionalInput(actionCore, 'contract-collection-id'),
    INPUT_SYNC_EXAMPLES:
      optionalInput(actionCore, 'sync-examples') ??
      openAlphaActionContract.inputs['sync-examples'].default,
    INPUT_COLLECTION_SYNC_MODE:
      optionalInput(actionCore, 'collection-sync-mode') ??
      openAlphaActionContract.inputs['collection-sync-mode'].default,
    INPUT_SPEC_SYNC_MODE:
      optionalInput(actionCore, 'spec-sync-mode') ??
      openAlphaActionContract.inputs['spec-sync-mode'].default,
    INPUT_RELEASE_LABEL: optionalInput(actionCore, 'release-label'),
    INPUT_FLOW_MANIFEST_URL: optionalInput(actionCore, 'flow-manifest-url'),
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
    INPUT_GOVERNANCE_MAPPING_JSON:
      optionalInput(actionCore, 'governance-mapping-json') ??
      openAlphaActionContract.inputs['governance-mapping-json'].default,
    INPUT_POSTMAN_API_KEY: postmanApiKey,
    INPUT_POSTMAN_ACCESS_TOKEN: postmanAccessToken,
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

function createAssetProjectName(
  inputs: ResolvedInputs,
  releaseLabel?: string
): string {
  if (!releaseLabel) {
    return inputs.projectName;
  }

  return `${inputs.projectName} ${releaseLabel}`;
}

type CloudResourceMap = Record<string, string>;

type PostmanResourcesState = {
  workspace?: {
    id?: string;
  };
  cloudResources?: {
    collections?: CloudResourceMap;
    environments?: CloudResourceMap;
    specs?: CloudResourceMap;
  };
};

function readResourcesState(): PostmanResourcesState | null {
  try {
    return parse(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
  } catch {
    return null;
  }
}

function getFirstCloudResourceId(map: CloudResourceMap | undefined): string | undefined {
  if (!map) {
    return undefined;
  }
  return Object.values(map)[0];
}

function findCloudResourceId(
  map: CloudResourceMap | undefined,
  matcher: (path: string) => boolean
): string | undefined {
  if (!map) {
    return undefined;
  }

  const match = Object.entries(map).find(([filePath]) => matcher(filePath));
  return match?.[1];
}

function createCollectionResourceMatcher(
  prefix: '[Baseline]' | '[Smoke]' | '[Contract]',
  releaseLabel?: string
): (path: string) => boolean {
  return (filePath: string) => {
    const normalizedPath = String(filePath || '');
    if (!normalizedPath.includes(prefix)) {
      return false;
    }

    if (!releaseLabel) {
      return true;
    }

    return normalizedPath.includes(` ${releaseLabel}`);
  };
}

function summarizeCollectionShape(collection: unknown): string {
  if (!collection || typeof collection !== 'object') {
    return `top-level=${typeof collection}`;
  }

  const record = collection as Record<string, unknown>;
  const topLevelKeys = Object.keys(record);
  const items = Array.isArray(record.item) ? record.item : [];
  const sample = items.slice(0, 5).map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return `#${index + 1}:non-object`;
    }

    const item = entry as Record<string, unknown>;
    const children = Array.isArray(item.item) ? item.item : [];
    const childSummary = children.slice(0, 3).map((child, childIndex) => {
      if (!child || typeof child !== 'object') {
        return `child#${childIndex + 1}:non-object`;
      }

      const childItem = child as Record<string, unknown>;
      const grandChildren = Array.isArray(childItem.item) ? childItem.item.length : 0;
      return `child#${childIndex + 1}:${typeof childItem.name === 'string' ? childItem.name : '<unnamed>'}:request=${typeof childItem.request}:itemCount=${grandChildren}`;
    });

    return `#${index + 1}:${typeof item.name === 'string' ? item.name : '<unnamed>'}:request=${typeof item.request}:itemCount=${children.length}:children=[${childSummary.join(', ')}]`;
  });

  return `keys=${topLevelKeys.join(',') || '<none>'}; itemCount=${items.length}; sample=[${sample.join('; ')}]`;
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

export async function runBootstrap(
  inputs: ResolvedInputs,
  dependencies: BootstrapExecutionDependencies
): Promise<PlannedOutputs> {
  const outputs = createPlannedOutputs(inputs);
  const requiresReleaseLabel =
    inputs.collectionSyncMode === 'version' || inputs.specSyncMode === 'version';
  const releaseLabel = requiresReleaseLabel ? deriveReleaseLabel(inputs) : undefined;
  if (requiresReleaseLabel && !releaseLabel) {
    throw new Error(
      'Versioned spec or collection sync requires a release-label or derivable GitHub ref metadata'
    );
  }
  const workspaceName = createWorkspaceName(inputs);
  const aboutText = `Auto-provisioned by Postman CS open-alpha for ${inputs.projectName}`;

  await runGroup(dependencies.core, 'Install Postman CLI', async () => {
    await ensurePostmanCli(dependencies, inputs.postmanApiKey);
  });

  const resourcesState = readResourcesState();

  let explicitWorkspaceId = inputs.workspaceId;
  if (!explicitWorkspaceId && resourcesState?.workspace?.id) {
    explicitWorkspaceId = resourcesState.workspace.id;
    dependencies.core.info('Resolved workspace-id from .postman/resources.yaml');
  }

  const repoWorkspaceId = explicitWorkspaceId;
  let workspaceId = explicitWorkspaceId;

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

  let specId = inputs.specId;
  if (!specId) {
    specId = getFirstCloudResourceId(resourcesState?.cloudResources?.specs);
    if (specId) {
      dependencies.core.info('Resolved spec-id from .postman/resources.yaml');
    }
  }

  let baselineCollectionId =
    inputs.collectionSyncMode === 'refresh' ? undefined : inputs.baselineCollectionId;
  let smokeCollectionId =
    inputs.collectionSyncMode === 'refresh' ? undefined : inputs.smokeCollectionId;
  let contractCollectionId =
    inputs.collectionSyncMode === 'refresh' ? undefined : inputs.contractCollectionId;

  if (inputs.collectionSyncMode !== 'refresh') {
    const cloudCollections = resourcesState?.cloudResources?.collections;
    if (!baselineCollectionId) {
      baselineCollectionId = findCloudResourceId(
        cloudCollections,
        createCollectionResourceMatcher(
          '[Baseline]',
          inputs.collectionSyncMode === 'version' ? releaseLabel : undefined
        )
      );
      if (baselineCollectionId) {
        dependencies.core.info('Resolved baseline-collection-id from .postman/resources.yaml');
      }
    }
    if (!smokeCollectionId) {
      smokeCollectionId = findCloudResourceId(
        cloudCollections,
        createCollectionResourceMatcher(
          '[Smoke]',
          inputs.collectionSyncMode === 'version' ? releaseLabel : undefined
        )
      );
      if (smokeCollectionId) {
        dependencies.core.info('Resolved smoke-collection-id from .postman/resources.yaml');
      }
    }
    if (!contractCollectionId) {
      contractCollectionId = findCloudResourceId(
        cloudCollections,
        createCollectionResourceMatcher(
          '[Contract]',
          inputs.collectionSyncMode === 'version' ? releaseLabel : undefined
        )
      );
      if (contractCollectionId) {
        dependencies.core.info('Resolved contract-collection-id from .postman/resources.yaml');
      }
    }
  }

  if (specId) {
    dependencies.core.info(`Updating existing spec ${specId} from ${inputs.specUrl}`);
  }

  const isSpecUpdate = Boolean(specId);
  let previousSpecContent: string | undefined;
  let flowManifest: ParsedFlowManifest | undefined;
  let specOperationCatalog: SpecOperationEntry[] = [];
  let baselineOperationLookup:
    | ReturnType<typeof matchOperationsToBaselineRequests>
    | undefined;

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

  if (inputs.flowManifestUrl) {
    await runGroup(
      dependencies.core,
      'Fetch and Validate Flow Manifest',
      async () => {
        const manifestContent = await fetchFlowManifest(
          inputs.flowManifestUrl || '',
          dependencies.specFetcher
        );
        const manifest = parseFlowManifest(manifestContent);
        flowManifest = manifest;
        dependencies.core.info(
          `Validated flow manifest with ${manifest.flows.length} flow(s)`
        );
      }
    );
  }

  specOperationCatalog = buildSpecOperationCatalog(specContent);
  if (flowManifest) {
    await runGroup(
      dependencies.core,
      'Validate Flow Manifest Against Spec',
      async () => {
        validateFlowManifestAgainstSpec(flowManifest!, specOperationCatalog);
        dependencies.core.info('Validated flow manifest bindings against spec operations');
      }
    );
  }

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
      const shouldReuseCollections = inputs.collectionSyncMode !== 'refresh';
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
    }
  );

  outputs['collections-json'] = JSON.stringify({
    baseline: outputs['baseline-collection-id'],
    contract: outputs['contract-collection-id'],
    smoke: outputs['smoke-collection-id']
  });

  await runGroup(
    dependencies.core,
    'Build Baseline Operation Lookup',
    async () => {
      const getCollection = dependencies.postman.getCollection;
      if (!getCollection) {
        dependencies.core.warning('Skipping baseline operation lookup because getCollection is unavailable');
        return;
      }

      const buildLookupFromCollection = (collection: unknown) => {
        const baselineRequests = buildBaselineRequestCatalog(collection);
        return matchOperationsToBaselineRequests(
          specOperationCatalog,
          baselineRequests
        );
      };

      try {
        const lookup = await retry(
          async () => {
            const baselineCollection = await getCollection(
              outputs['baseline-collection-id']
            );
            return buildLookupFromCollection(baselineCollection);
          },
          {
            maxAttempts: 3,
            delayMs: 2000
          }
        );
        baselineOperationLookup = lookup;

        dependencies.core.info(
          `Mapped ${lookup.size}/${specOperationCatalog.length} spec operations to baseline requests`
        );
      } catch (error) {
        if (inputs.flowManifestUrl) {
          try {
            const collection = await getCollection(
              outputs['baseline-collection-id']
            );
            dependencies.core.warning(
              `Baseline collection shape: ${summarizeCollectionShape(collection)}`
            );

            const recoveredLookup = buildLookupFromCollection(collection);
            baselineOperationLookup = recoveredLookup;
            dependencies.core.info(
              `Recovered baseline operation lookup after retry with ${recoveredLookup.size}/${specOperationCatalog.length} mapped operations`
            );
            return;
          } catch (shapeError) {
            dependencies.core.warning(
              `Failed to inspect baseline collection shape: ${shapeError instanceof Error ? shapeError.message : String(shapeError)}`
            );
          }
        }
        dependencies.core.warning(
          `Failed to build baseline operation lookup: ${error instanceof Error ? error.message : String(error)}`
        );
        if (error instanceof Error && error.stack) {
          dependencies.core.warning(`Baseline lookup stack: ${error.stack}`);
        }
      }
    }
  );

  if (flowManifest) {
    await runGroup(
      dependencies.core,
      'Curate Flow-Driven Smoke and Contract Collections',
      async () => {
        const getCollection = dependencies.postman.getCollection;
        const updateCollection = dependencies.postman.updateCollection;

        if (!getCollection || !updateCollection) {
          dependencies.core.warning(
            'Skipping flow-based collection curation because getCollection/updateCollection is unavailable'
          );
          return;
        }

        if (!baselineOperationLookup) {
          throw new Error('Flow manifest was provided but baseline operation lookup was not built');
        }

        const specOperationMap = new Map(
          specOperationCatalog.map((operation) => [operation.operationId, operation])
        );

        const curateType = async (
          collectionType: 'smoke' | 'contract',
          collectionId: string
        ) => {
          const curatedItems = compileFlowCollectionItems(
            flowManifest!,
            collectionType,
            baselineOperationLookup!,
            specOperationMap
          );
          if (curatedItems.length === 0) {
            dependencies.core.info(
              `No ${collectionType} flows found in flow manifest; leaving generated ${collectionType} collection unchanged`
            );
            return;
          }

          const collection = await getCollection(collectionId);
          collection.item = curatedItems;
          await updateCollection(collectionId, collection);
          dependencies.core.info(
            `Curated ${collectionType} collection with ${curatedItems.length} flow folder(s)`
          );
        };

        await curateType('smoke', outputs['smoke-collection-id']);
        await curateType('contract', outputs['contract-collection-id']);
      }
    );
  }

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

  const linkedCollectionIds = [
    outputs['baseline-collection-id'],
    outputs['smoke-collection-id'],
    outputs['contract-collection-id']
  ].filter(Boolean);

  if (linkedCollectionIds.length > 0) {
    if (dependencies.internalIntegration) {
      await runGroup(
        dependencies.core,
        'Link Collections to Specification',
        async () => {
          await dependencies.internalIntegration?.linkCollectionsToSpecification(
            outputs['spec-id'],
            linkedCollectionIds.map((collectionId) => ({
              collectionId,
              syncOptions: {
                syncExamples: inputs.syncExamples
              }
            }))
          );
        }
      );

      await runGroup(
        dependencies.core,
        'Sync Linked Collections',
        async () => {
          await Promise.all(
            linkedCollectionIds.map((collectionId) =>
              dependencies.internalIntegration!.syncCollection(
                outputs['spec-id'],
                collectionId
              )
            )
          );
        }
      );
    } else {
      dependencies.core.warning(
        'Skipping cloud spec-to-collection linking and sync because postman-access-token is not configured'
      );
    }
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
    inputs.postmanAccessToken
  ]);
  const postman = new PostmanAssetsClient({
    apiKey: inputs.postmanApiKey,
    secretMasker
  });
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
    io: factories.io,
    internalIntegration,
    postman,
    specFetcher: factories.specFetcher ?? fetch
  };
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
