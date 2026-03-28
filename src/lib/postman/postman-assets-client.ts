import { HttpError } from '../http-error.js';
import { retry } from '../retry.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';

type EnvironmentValue = {
  key: string;
  type: string;
  value: string;
};

type FetchResult = Record<string, any> | null;

export interface PostmanAssetsClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
}

export function normalizeGitRepoUrl(url: string | null | undefined): string {
  const raw = String(url || '').trim();
  if (!raw) return '';

  // git@<host>:<owner>/<repo>.git  ->  https://<host>/<owner>/<repo>
  const sshMatch = raw.match(/^git@([^:]+):(.+)$/i);
  if (sshMatch?.[1] && sshMatch?.[2]) {
    return normalizeGitRepoUrl(`https://${sshMatch[1]}/${sshMatch[2]}`);
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (parts.length < 2) return raw.replace(/\.git$/i, '').replace(/\/+$/g, '').toLowerCase();
    return `https://${host}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  } catch {
    return raw.replace(/\.git$/i, '').replace(/\/+$/g, '').toLowerCase();
  }
}

function extractGitRepoUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const normalized = normalizeGitRepoUrl(value);
    // Accept any URL that looks like a hosted git repo (github.com, gitlab.com, or self-hosted)
    if (/^https:\/\/[^/]+\/[^/]+\/[^/]+$/.test(normalized)) return normalized;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const repoUrl = extractGitRepoUrl(item);
      if (repoUrl) return repoUrl;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferredKeys = ['repo', 'repository', 'repoUrl', 'repo_url', 'remoteUrl', 'remote_url', 'origin'];
    for (const key of preferredKeys) {
      const repoUrl = extractGitRepoUrl(record[key]);
      if (repoUrl) return repoUrl;
    }
    for (const nested of Object.values(record)) {
      const repoUrl = extractGitRepoUrl(nested);
      if (repoUrl) return repoUrl;
    }
  }
  return null;
}

export class PostmanAssetsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: SecretMasker;

  constructor(options: PostmanAssetsClientOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.baseUrl = String(options.baseUrl || 'https://api.getpostman.com').replace(
      /\/+$/,
      ''
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.apiKey]);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async getMe(): Promise<Record<string, unknown> | null> {
    return this.request('/me', { method: 'GET' }) as Promise<Record<string, unknown> | null>;
  }

  async getAutoDerivedTeamId(): Promise<string | undefined> {
    try {
      const data = await this.getMe();
      const user = data?.user;
      if (user && typeof user === 'object' && 'teamId' in user && user.teamId) {
        return String(user.teamId);
      }
    } catch (e) {
      // ignore
    }
    return undefined;
  }

  async getTeams(): Promise<Array<{ id: number; name: string; handle: string; organizationId?: number }>> {
    const data = await this.request('/teams');
    const teams = data?.data ?? [];
    return Array.isArray(teams)
      ? teams
          .filter((t: any) => t?.id && t?.name)
          .map((t: any) => ({
            id: Number(t.id),
            name: String(t.name),
            handle: String(t.handle || ''),
            ...(t.organizationId != null ? { organizationId: Number(t.organizationId) } : {})
          }))
      : [];
  }

  private async request(
    path: string,
    init: RequestInit = {}
  ): Promise<FetchResult> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        ...(init.headers || {})
      }
    });

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: init.method || 'GET',
        requestHeaders: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
          ...(init.headers || {})
        },
        secretValues: [this.apiKey],
        url
      });
    }

    try {
      return (await response.json()) as Record<string, any>;
    } catch {
      return null;
    }
  }

  async createWorkspace(name: string, about: string, targetTeamId?: number): Promise<{ id: string }> {
    return retry(async () => {
      const payload = {
        workspace: {
          about,
          name,
          type: 'team',
          ...(targetTeamId != null && !Number.isNaN(targetTeamId) ? { teamId: targetTeamId } : {})
        }
      };
      let created: FetchResult;
      try {
        created = await this.request('/workspaces', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes('Only personal workspaces')) {
          throw new Error(
            'Workspace creation failed: This may be an Org-mode account that requires a workspace-team-id input. ' +
            'The Postman API does not allow creating team workspaces at the organization level. ' +
            'Use the workspace-team-id input to specify which sub-team should own this workspace.'
          );
        }
        throw err;
      }

      const workspaceId = created?.workspace?.id;
      if (!workspaceId) {
        throw new Error('Workspace create did not return an id');
      }

      const workspace = await this.request(`/workspaces/${workspaceId}`);
      if (workspace?.workspace?.visibility !== 'team') {
        await this.request(`/workspaces/${workspaceId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      }

      return {
        id: workspaceId
      };
    }, {
      maxAttempts: 3,
      delayMs: 2000,
      shouldRetry: (err) =>
        !(err instanceof Error && err.message.includes('workspace-team-id'))
    });
  }

  async listWorkspaces(): Promise<Array<{ id: string; name: string; type: string }>> {
    const data = await this.request('/workspaces');
    const workspaces = data?.workspaces ?? [];
    return Array.isArray(workspaces)
      ? workspaces
          .filter((w: any) => w?.id && w?.name)
          .map((w: any) => ({
            id: String(w.id),
            name: String(w.name),
            type: String(w.type ?? 'team')
          }))
      : [];
  }

  async workspaceExists(workspaceId: string): Promise<boolean> {
    try {
      await this.request(`/workspaces/${workspaceId}`);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async findWorkspacesByName(name: string): Promise<Array<{ id: string; name: string }>> {
    const workspaces = await this.listWorkspaces();
    return workspaces
      .filter((w) => w.name === name)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => ({ id: w.id, name: w.name }));
  }

  async getWorkspaceGitRepoUrl(
    workspaceId: string,
    teamId: string,
    accessToken: string
  ): Promise<string | null> {
    const url = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';
    const headers: Record<string, string> = {
      'x-access-token': accessToken,
      'Content-Type': 'application/json'
    };
    if (teamId) {
      headers['x-entity-team-id'] = teamId;
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        service: 'workspaces',
        method: 'GET',
        path: `/workspaces/${workspaceId}/filesystem`
      })
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Bifrost workspace lookup failed: ${response.status} - ${body}`);
    }

    const body = await response.text();
    if (!body.trim()) return null;

    try {
      return extractGitRepoUrl(JSON.parse(body));
    } catch {
      return extractGitRepoUrl(body);
    }
  }

  async inviteRequesterToWorkspace(
    workspaceId: string,
    email: string
  ): Promise<void> {
    const users = await this.request('/users');
    const user = users?.data?.find((entry: any) => entry.email === email);
    if (!user?.id) {
      return;
    }

    await this.request(`/workspaces/${workspaceId}/roles`, {
      method: 'PATCH',
      body: JSON.stringify({
        roles: [
          {
            op: 'add',
            path: '/user',
            value: [{ id: user.id, role: 2 }]
          }
        ]
      })
    });
  }

  async addAdminsToWorkspace(
    workspaceId: string,
    adminIds: string
  ): Promise<void> {
    const ids = String(adminIds || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return;
    }

    await this.request(`/workspaces/${workspaceId}/roles`, {
      method: 'PATCH',
      body: JSON.stringify({
        roles: [
          {
            op: 'add',
            path: '/user',
            value: ids.map((id) => ({
              id: Number.parseInt(id, 10),
              role: 3
            }))
          }
        ]
      })
    });
  }

  async uploadSpec(
    workspaceId: string,
    projectName: string,
    specContent: string
  ): Promise<string> {
    const response = await this.request(`/specs?workspaceId=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        name: projectName,
        type: 'OPENAPI:3.0',
        files: [{ path: 'index.yaml', content: specContent }]
      })
    });

    const specId = String(response?.id || '').trim();
    if (!specId) {
      throw new Error('Spec upload did not return an ID');
    }

    await retry(async () => {
      const verified = await this.request(`/specs/${specId}?workspaceId=${workspaceId}`);
      if (verified?.id !== specId) {
        throw new Error(`Spec preflight response did not contain expected id ${specId}`);
      }
    }, { maxAttempts: 3, delayMs: 2000 });

    return specId;
  }


  async updateSpec(
    specId: string,
    specContent: string,
    _workspaceId?: string
  ): Promise<void> {
    // Postman Spec Hub uses PATCH /specs/{specId}/files/{filePath} for updates.
    // PUT /specs/{specId} is not a valid endpoint and returns 404.
    await this.request(`/specs/${specId}/files/index.yaml`, {
      method: 'PATCH',
      body: JSON.stringify({ content: specContent })
    });
  }

  async getSpecContent(specId: string): Promise<string | undefined> {
    try {
      const result = await this.request(`/specs/${specId}/files/index.yaml`);
      return typeof result?.content === 'string' ? result.content : undefined;
    } catch {
      return undefined;
    }
  }

  async generateCollection(
    specId: string,
    projectName: string,
    prefix: string
  ): Promise<string> {
    const payload = {
      name: `${prefix} ${projectName}`,
      options: {
        requestNameSource: 'Fallback'
      }
    };

    const extractUid = (data: any): string | undefined =>
      data?.details?.resources?.[0]?.id ||
      data?.collection?.id ||
      data?.collection?.uid ||
      data?.resource?.uid ||
      data?.resource?.id ||
      undefined;

    return retry(
      async () => {
        const maxLockedRetries = 5;
        let response: FetchResult = null;

        for (let lockedAttempt = 0; ; lockedAttempt += 1) {
          try {
            response = await this.request(`/specs/${specId}/generations/collection`, {
              method: 'POST',
              body: JSON.stringify(payload)
            });
            break;
          } catch (error) {
            const message = this.secretMasker(
              error instanceof Error ? error.message : String(error)
            );
            const isLocked = message.includes('423');
            if (!isLocked || lockedAttempt >= maxLockedRetries) {
              throw error;
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 5000 * Math.pow(2, lockedAttempt));
            });
          }
        }

        const directUid = extractUid(response);
        if (directUid) {
          return directUid;
        }

        let taskUrl =
          response?.url ||
          response?.task_url ||
          response?.taskUrl ||
          response?.links?.task;
        if (!taskUrl) {
          const taskId = response?.taskId || response?.task?.id || response?.id;
          if (!taskId) {
            throw new Error(
              `Collection generation did not return a task URL or ID for ${prefix}`
            );
          }
          taskUrl = `/specs/${specId}/tasks/${taskId}`;
        }

        for (let attempt = 0; attempt < 45; attempt += 1) {
          await new Promise((resolve) => {
            setTimeout(resolve, 2000);
          });
          const task = await this.request(taskUrl);
          const status = String(task?.status || task?.task?.status || '').toLowerCase();
          if (status === 'completed') {
            const taskUid = extractUid(task);
            if (!taskUid) {
              throw new Error(`Task completed but no UID found for ${prefix}`);
            }
            return taskUid;
          }
          if (status === 'failed') {
            throw new Error(`Task failed for ${prefix}`);
          }
        }

        throw new Error(`Collection generation timed out for ${prefix}`);
      },
      {
        maxAttempts: 4,
        delayMs: 2000
      }
    );
  }

  async tagCollection(collectionUid: string, tags: string[]): Promise<void> {
    const normalized = tags
      .map((entry) =>
        String(entry || '')
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
      )
      .filter((entry) => /^[a-z][a-z0-9-]*[a-z0-9]$/.test(entry));

    if (normalized.length === 0) {
      throw new Error(`No valid tag slugs to apply for collection ${collectionUid}`);
    }

    await this.request(`/collections/${collectionUid}/tags`, {
      method: 'PUT',
      body: JSON.stringify({
        tags: normalized.map((slug) => ({ slug }))
      })
    });
  }

  async injectTests(collectionUid: string, type: 'contract' | 'smoke'): Promise<void> {
    const collectionResponse = await this.request(`/collections/${collectionUid}`);
    const collection = collectionResponse?.collection;
    if (!collection) {
      throw new Error(`Failed to fetch collection ${collectionUid}`);
    }

    const smokeTests = [
      "// [Smoke] Auto-generated test assertions",
      "",
      "pm.test('Status code is successful (2xx)', function () {",
      "    pm.response.to.be.success;",
      "});",
      "",
      "pm.test('Response time is acceptable', function () {",
      "    var threshold = parseInt(pm.environment.get('RESPONSE_TIME_THRESHOLD') || '2000', 10);",
      "    pm.expect(pm.response.responseTime).to.be.below(threshold);",
      "});",
      "",
      "pm.test('Response body is not empty', function () {",
      "    if (pm.response.code !== 204) {",
      "        var body = pm.response.text();",
      "        pm.expect(body.length).to.be.above(0);",
      "    }",
      "});"
    ];
    const contractTests = [
      "// [Contract] Auto-generated contract test assertions",
      "",
      "pm.test('Status code is successful (2xx)', function () {",
      "    pm.response.to.be.success;",
      "});",
      "",
      "pm.test('Response time is acceptable', function () {",
      "    var threshold = parseInt(pm.environment.get('RESPONSE_TIME_THRESHOLD') || '2000', 10);",
      "    pm.expect(pm.response.responseTime).to.be.below(threshold);",
      "});",
      "",
      "pm.test('Response body is not empty', function () {",
      "    if (pm.response.code !== 204) {",
      "        var body = pm.response.text();",
      "        pm.expect(body.length).to.be.above(0);",
      "    }",
      "});",
      "",
      "pm.test('Content-Type is application/json', function () {",
      "    if (pm.response.code !== 204) {",
      "        pm.response.to.have.header('Content-Type');",
      "        pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json');",
      "    }",
      "});",
      "",
      "pm.test('Response is valid JSON', function () {",
      "    if (pm.response.code !== 204) {",
      "        pm.response.to.be.json;",
      "    }",
      "});",
      "",
      "// Validate required fields from response schema",
      "pm.test('Required fields are present', function () {",
      "    if (pm.response.code === 204) return;",
      "    var jsonData = pm.response.json();",
      "    pm.expect(jsonData).to.be.an('object');",
      "    var keys = Object.keys(jsonData);",
      "    if (keys.length === 1 && Array.isArray(jsonData[keys[0]])) {",
      "        pm.expect(jsonData[keys[0]]).to.be.an('array');",
      "    }",
      "});",
      "",
      "// Validate response field types (non-null required fields)",
      "pm.test('Field types are correct', function () {",
      "    if (pm.response.code === 204) return;",
      "    var jsonData = pm.response.json();",
      "    Object.keys(jsonData).forEach(function(key) {",
      "        pm.expect(jsonData[key]).to.not.be.undefined;",
      "    });",
      "});",
      "",
      "(function() {",
      "    var status = pm.response.code;",
      "    if (status === 204) return; ",
      "    try {",
      "        var body = pm.response.json();",
      "        pm.test('Response body matches expected structure', function () {",
      "            pm.expect(typeof body).to.equal('object');",
      "            if (status >= 400) {",
      "                pm.expect(body).to.have.property('error');",
      "                pm.expect(body).to.have.property('message');",
      "            }",
      "        });",
      "    } catch (e) {}",
      "})();"
    ];

    const scriptsToInject = type === 'smoke' ? smokeTests : contractTests;
    const request0Item = {
      name: '00 - Resolve Secrets',
      request: {
        auth: {
          type: 'awsv4',
          awsv4: [
            { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
            { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
            { key: 'region', value: '{{AWS_REGION}}' },
            { key: 'service', value: 'secretsmanager' }
          ]
        },
        method: 'POST',
        header: [
          { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
          { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
        ],
        body: {
          mode: 'raw',
          raw: '{"SecretId": "{{AWS_SECRET_NAME}}"}'
        },
        url: {
          raw: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
          protocol: 'https',
          host: ['secretsmanager', '{{AWS_REGION}}', 'amazonaws', 'com']
        }
      },
      event: [
        {
          listen: 'test',
          script: {
            exec: [
              'if (pm.environment.get("CI") === "true") { return; }',
              'const body = pm.response.json();',
              'if (body.SecretString) {',
              '  const secrets = JSON.parse(body.SecretString);',
              '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
              '}'
            ]
          }
        }
      ]
    };

    const autoGeneratedMarker =
      type === 'smoke'
        ? '// [Smoke] Auto-generated test assertions'
        : '// [Contract] Auto-generated contract test assertions';

    const injectScripts = (itemNode: any) => {
      if (itemNode.name === '00 - Resolve Secrets') {
        return;
      }

      if (itemNode.request) {
        itemNode.event = (itemNode.event || []).filter((entry: any) => {
          if (entry.listen !== 'test') {
            return true;
          }

          const exec = entry?.script?.exec;
          return !Array.isArray(exec) || !exec.includes(autoGeneratedMarker);
        });
        itemNode.event.push({
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: scriptsToInject
          }
        });
      }
      if (Array.isArray(itemNode.item)) {
        itemNode.item.forEach(injectScripts);
      }
    };

    if (Array.isArray(collection.item)) {
      // Remove any existing secrets resolver to prevent duplicates on reruns
      collection.item = collection.item.filter(
        (entry: any) => entry.name !== '00 - Resolve Secrets'
      );
      collection.item.forEach(injectScripts);
    } else {
      collection.item = [];
    }

    collection.item.unshift(request0Item);

    await this.request(`/collections/${collectionUid}`, {
      method: 'PUT',
      body: JSON.stringify({ collection })
    });
  }

  async updateCollection(collectionUid: string, collection: Record<string, any>): Promise<void> {
    try {
      await this.request(`/collections/${collectionUid}`, {
        method: 'PUT',
        body: JSON.stringify({ collection })
      });
    } catch (error) {
      const info = collection?.info && typeof collection.info === 'object'
        ? collection.info
        : {};
      const itemCount = Array.isArray(collection?.item) ? collection.item.length : 0;
      const summary = `collectionUid=${collectionUid}; name=${String((info as Record<string, unknown>).name || '<unnamed>')}; itemCount=${itemCount}`;
      if (error instanceof Error) {
        throw new Error(`Collection update failed (${summary}): ${error.message}`);
      }
      throw new Error(`Collection update failed (${summary}): ${String(error)}`);
    }
  }

  async createEnvironment(
    workspaceId: string,
    name: string,
    values: EnvironmentValue[]
  ): Promise<string> {
    const response = await this.request(`/environments?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        environment: {
          name,
          values
        }
      })
    });

    const uid = String(response?.environment?.uid || '').trim();
    if (!uid) {
      throw new Error('Environment create did not return a UID');
    }
    return uid;
  }

  async updateEnvironment(
    uid: string,
    name: string,
    values: EnvironmentValue[]
  ): Promise<void> {
    await this.request(`/environments/${uid}`, {
      method: 'PUT',
      body: JSON.stringify({
        environment: {
          name,
          values
        }
      })
    });
  }

  async createMonitor(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string
  ): Promise<string> {
    const response = await this.request(`/monitors?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        monitor: {
          name,
          collection: collectionUid,
          environment: environmentUid,
          schedule: {
            cron: '*/5 * * * *',
            timezone: 'UTC'
          }
        }
      })
    });

    const uid = String(response?.monitor?.uid || '').trim();
    if (!uid) {
      throw new Error('Monitor create did not return a UID');
    }
    return uid;
  }

  async createMock(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string
  ): Promise<{ uid: string; url: string }> {
    const response = await this.request(`/mocks?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        mock: {
          name,
          collection: collectionUid,
          environment: environmentUid,
          private: false
        }
      })
    });

    const uid = String(response?.mock?.uid || '').trim();
    if (!uid) {
      throw new Error('Mock create did not return a UID');
    }

    return {
      uid,
      url:
        String(response?.mock?.mockUrl || '').trim() ||
        String(response?.mock?.config?.serverResponseId || '').trim()
    };
  }

  async getCollection(uid: string): Promise<any> {
    await new Promise((resolve) => {
      setTimeout(resolve, 10000);
    });

    return retry(async () => {
      let response: FetchResult = null;
      try {
        response = await this.request(`/collections/${uid}`);
      } catch (error) {
        const message = this.secretMasker(
          error instanceof Error ? error.message : String(error)
        );
        if (message.includes("reading 'request'")) {
          throw new Error(`Collection ${uid} is not ready to read yet`);
        }
        throw error;
      }

      if (!response?.collection) {
        throw new Error(`Collection ${uid} response did not include collection payload`);
      }

      return response.collection;
    }, {
      maxAttempts: 4,
      delayMs: 3000
    });
  }

  async getEnvironment(uid: string): Promise<any> {
    const response = await this.request(`/environments/${uid}`);
    return response?.environment;
  }

  async getEnvironments(workspaceId: string): Promise<any[]> {
    const response = await this.request(`/environments?workspace=${workspaceId}`);
    return response?.environments || [];
  }
}
