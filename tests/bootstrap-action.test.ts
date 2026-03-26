import { describe, expect, it, vi } from 'vitest';

import {
  lintSpecViaCli,
  normalizeSpecDocument,
  readActionInputs,
  runBootstrap,
  type CoreLike,
  type ExecLike,
  type IOLike,
  type ResolvedInputs
} from '../src/index.js';

function createCoreStub(values: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const secrets: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];

  const core: CoreLike = {
    error: (message: string) => {
      errors.push(message);
    },
    getInput: (name: string, options?: { required?: boolean }) => {
      const value = values[name] ?? '';
      if (options?.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    group: async (_name: string, fn: () => Promise<any>) => fn(),
    info: (message: string) => {
      infos.push(message);
    },
    setFailed: vi.fn(),
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
    setSecret: (secret: string) => {
      secrets.push(secret);
    },
    warning: (message: string) => {
      warnings.push(message);
    }
  };

  return {
    core,
    errors,
    infos,
    outputs,
    secrets,
    warnings
  };
}

function createInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'core-payments',
    domain: 'core-banking',
    domainCode: 'AF',
    requesterEmail: 'owner@example.com',
    workspaceAdminUserIds: '101,102',
    repoUrl: 'https://github.com/postman-cs/bootstrap-action-test',
    specUrl: 'https://example.test/openapi.yaml',
    environmentsJson: '["prod","stage"]',
    systemEnvMapJson: '{"prod":"sys-prod","stage":"sys-stage"}',
    governanceMappingJson: '{"core-banking":"Core Banking"}',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    githubToken: 'github-token',
    ghFallbackToken: 'github-fallback-token',
    githubAuthMode: 'github_token_first',
    integrationBackend: 'bifrost',
    ...overrides
  };
}

function createExecStub(stdout = '{"violations":[]}'): ExecLike {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout,
      stderr: ''
    })
  };
}

function createIoStub(): IOLike {
  return {
    which: vi.fn().mockResolvedValue('/usr/local/bin/postman')
  };
}

describe('bootstrap action', () => {
  it('marks secrets as early as input resolution', () => {
    const { core, secrets } = createCoreStub({
      'project-name': 'core-payments',
      'spec-url': 'https://example.test/openapi.yaml',
      'postman-api-key': 'pmak-test',
      'postman-access-token': 'postman-access-token',
      'github-token': 'github-token',
      'gh-fallback-token': 'github-fallback-token'
    });

    const inputs = readActionInputs(core);

    expect(inputs.postmanApiKey).toBe('pmak-test');
    expect(secrets).toEqual([
      'pmak-test',
      'postman-access-token',
      'github-token',
      'github-fallback-token'
    ]);
  });

  it('runs the bootstrap flow end to end and emits outputs', async () => {
    const { core, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const order: string[] = [];
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
          order.push(prefix);
          if (prefix === '[Baseline]') return 'col-baseline';
          if (prefix === '[Smoke]') return 'col-smoke';
          return 'col-contract';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined)
    };
    const github = {
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
      getRepositoryVariable: vi.fn().mockResolvedValue('')
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('openapi: 3.1.0', {
        status: 200
      })
    );

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      github,
      io: ioStub,
      internalIntegration,
      postman,
      specFetcher
    });

    expect(execStub.exec).toHaveBeenCalledWith('postman', ['login', '--with-api-key', 'pmak-test']);
    expect(internalIntegration.assignWorkspaceToGovernanceGroup).toHaveBeenCalledWith(
      'ws-123',
      'core-banking',
      '{"core-banking":"Core Banking"}'
    );
    expect(postman.inviteRequesterToWorkspace).toHaveBeenCalledWith(
      'ws-123',
      'owner@example.com'
    );
    expect(postman.addAdminsToWorkspace).toHaveBeenCalledWith('ws-123', '101,102');
    expect(order).toEqual(['[Baseline]', '[Smoke]', '[Contract]']);
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'LINT_WARNINGS',
      '0'
    );
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'LINT_ERRORS',
      '0'
    );
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'POSTMAN_WORKSPACE_ID',
      'ws-123'
    );
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'POSTMAN_CORE_PAYMENTS_WORKSPACE_ID',
      'ws-123'
    );
    expect(result).toMatchObject({
      'workspace-id': 'ws-123',
      'workspace-name': '[AF] core-payments',
      'spec-id': 'spec-123',
      'baseline-collection-id': 'col-baseline',
      'smoke-collection-id': 'col-smoke',
      'contract-collection-id': 'col-contract'
    });
    expect(outputs['collections-json']).toBe(
      JSON.stringify({
        baseline: 'col-baseline',
        contract: 'col-contract',
        smoke: 'col-smoke'
      })
    );
    expect(outputs['lint-summary-json']).toBe(
      JSON.stringify({
        errors: 0,
        total: 0,
        violations: [],
        warnings: 0
      })
    );
  });

  it('fails when spec lint returns errors', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub(
      JSON.stringify({
        violations: [
          {
            issue: 'Missing operationId',
            path: '$.paths./payments.get',
            severity: 'ERROR'
          }
        ]
      })
    );
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      })
    ).rejects.toThrow('Spec lint found 1 errors');

    expect(postman.generateCollection).not.toHaveBeenCalled();
  });

  it('restores previous spec content when lint fails after an update', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub(
      JSON.stringify({
        violations: [
          {
            issue: 'Broken schema',
            path: '$.paths./payments.get',
            severity: 'ERROR'
          }
        ]
      })
    );
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.0.0\ninfo:\n  title: old\n'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      runBootstrap(
        createInputs({ workspaceId: 'ws-existing', specId: 'spec-existing' }),
        {
          core,
          exec: execStub,
          io: ioStub,
          postman,
          specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
            new Response('openapi: 3.1.0', { status: 200 })
          )
        }
      )
    ).rejects.toThrow('Spec lint found 1 errors');

    expect(postman.getSpecContent).toHaveBeenCalledWith('spec-existing');
    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      1,
      'spec-existing',
      'openapi: 3.1.0',
      'ws-existing'
    );
    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      2,
      'spec-existing',
      'openapi: 3.0.0\ninfo:\n  title: old\n',
      'ws-existing'
    );
  });

  it('validates normalized spec structure before upload or update', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn()
    };

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('info:\n  title: Missing version\n', { status: 200 })
        )
      })
    ).rejects.toThrow('Spec is missing "openapi" or "swagger" version field');

    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.updateSpec).not.toHaveBeenCalled();
  });

  it('reuses existing workspace, spec, and collection ids from explicit inputs', async () => {
    const { core, infos, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const github = {
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
      getRepositoryVariable: vi.fn()
    };

    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing'
      }),
      {
        core,
        exec: execStub,
        github,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      }
    );

    expect(github.getRepositoryVariable).not.toHaveBeenCalled();
    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.updateSpec).toHaveBeenCalledWith('spec-existing', 'openapi: 3.1.0', 'ws-existing');
    expect(result).toMatchObject({
      'workspace-id': 'ws-existing',
      'spec-id': 'spec-existing',
      'baseline-collection-id': 'col-baseline-existing',
      'smoke-collection-id': 'col-smoke-existing',
      'contract-collection-id': 'col-contract-existing'
    });
    expect(outputs['collections-json']).toBe(
      JSON.stringify({
        baseline: 'col-baseline-existing',
        contract: 'col-contract-existing',
        smoke: 'col-smoke-existing'
      })
    );
    expect(infos).toContain('Using existing workspace: ws-existing');
    expect(infos).toContain('Using existing baseline collection: col-baseline-existing');
    expect(infos).toContain('Using existing smoke collection: col-smoke-existing');
    expect(infos).toContain('Using existing contract collection: col-contract-existing');
  });

  it('falls back to repository variables for reruns before creating new assets', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const github = {
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
      getRepositoryVariable: vi.fn(async (name: string) => {
        const values: Record<string, string> = {
          POSTMAN_WORKSPACE_ID: 'ws-from-vars',
          POSTMAN_SPEC_UID: 'spec-from-vars',
          POSTMAN_BASELINE_COLLECTION_UID: 'col-baseline-from-vars',
          POSTMAN_SMOKE_COLLECTION_UID: 'col-smoke-from-vars',
          POSTMAN_CONTRACT_COLLECTION_UID: 'col-contract-from-vars'
        };
        return values[name] ?? '';
      })
    };

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      github,
      io: ioStub,
      postman,
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('openapi: 3.1.0', { status: 200 })
      )
    });

    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.updateSpec).toHaveBeenCalledWith('spec-from-vars', 'openapi: 3.1.0', 'ws-from-vars');
    expect(github.getRepositoryVariable).toHaveBeenCalledWith('POSTMAN_CORE_PAYMENTS_WORKSPACE_ID');
    expect(github.getRepositoryVariable).toHaveBeenCalledWith('POSTMAN_WORKSPACE_ID');
    expect(result).toMatchObject({
      'workspace-id': 'ws-from-vars',
      'spec-id': 'spec-from-vars',
      'baseline-collection-id': 'col-baseline-from-vars',
      'smoke-collection-id': 'col-smoke-from-vars',
      'contract-collection-id': 'col-contract-from-vars'
    });
  });

  it('creates a new workspace when the repo-variable workspace is linked to a different repository', async () => {
    const previousRepository = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = 'postman-cs/bootstrap-action-test';

    try {
      const { core } = createCoreStub();
      const execStub = createExecStub();
      const ioStub = createIoStub();
      const postman = {
        addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
        createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
        findWorkspacesByName: vi.fn().mockResolvedValue([{ id: 'ws-from-vars', name: '[AF] core-payments' }]),
        generateCollection: vi
          .fn()
          .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
            if (prefix === '[Baseline]') return 'col-baseline';
            if (prefix === '[Smoke]') return 'col-smoke';
            return 'col-contract';
          }),
        getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
        getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue('https://github.com/postman-cs/different-repo'),
        injectTests: vi.fn().mockResolvedValue(undefined),
        inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
        tagCollection: vi.fn().mockResolvedValue(undefined),
        uploadSpec: vi.fn().mockResolvedValue('spec-123'),
        updateSpec: vi.fn().mockResolvedValue(undefined),
        getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
      };
      const github = {
        setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
        getRepositoryVariable: vi.fn(async (name: string) => {
          const values: Record<string, string> = {
            POSTMAN_WORKSPACE_ID: 'ws-from-vars'
          };
          return values[name] ?? '';
        })
      };

      const result = await runBootstrap(createInputs(), {
        core,
        exec: execStub,
        github,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      });

      expect(postman.getWorkspaceGitRepoUrl).toHaveBeenCalledWith('ws-from-vars', '12345', 'postman-access-token');
      expect(postman.createWorkspace).toHaveBeenCalled();
      expect(result['workspace-id']).toBe('ws-new');
      expect(postman.updateSpec).not.toHaveBeenCalled();
    } finally {
      if (previousRepository === undefined) {
        delete process.env.GITHUB_REPOSITORY;
      } else {
        process.env.GITHUB_REPOSITORY = previousRepository;
      }
    }
  });

  it('skips governance assignment when postman-access-token is absent', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };

    const result = await runBootstrap(
      createInputs({ postmanAccessToken: undefined }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      }
    );

    expect(result['workspace-id']).toBe('ws-123');
    expect(postman.createWorkspace).toHaveBeenCalled();
  });

  it('skips repo variable persistence when github dependency is absent', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };

    const result = await runBootstrap(
      createInputs({ githubToken: undefined }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      }
    );

    expect(result['workspace-id']).toBe('ws-123');
    expect(result['spec-id']).toBe('spec-123');
  });

  it('emits warnings for lint violations but does not fail', async () => {
    const { core, warnings } = createCoreStub();
    const execStub = createExecStub(
      JSON.stringify({
        violations: [
          { issue: 'Missing description', path: '$.paths./payments.get', severity: 'WARNING' }
        ]
      })
    );
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: ioStub,
      postman,
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('openapi: 3.1.0', { status: 200 })
      )
    });

    expect(result['workspace-id']).toBe('ws-123');
    expect(warnings.some((w) => w.includes('Missing description'))).toBe(true);
    const lintSummary = JSON.parse(result['lint-summary-json']);
    expect(lintSummary.warnings).toBe(1);
    expect(lintSummary.errors).toBe(0);
  });

  it('normalizeSpecDocument adds summary from operationId or METHOD+path', () => {
    const warn = vi.fn();
    const withId = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: { '/pets': { get: { operationId: 'listPets' } } }
      }),
      warn
    );
    expect(JSON.parse(withId).paths['/pets'].get.summary).toBe('listPets');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('operationId'));

    const warn2 = vi.fn();
    const bare = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: { '/x': { post: {} } }
      }),
      warn2
    );
    expect(JSON.parse(bare).paths['/x'].post.summary).toBe('POST /x');
    expect(warn2).toHaveBeenCalledWith(expect.stringContaining('method + path'));
  });

  it('normalizeSpecDocument truncates long summaries', () => {
    const long = 'x'.repeat(250);
    const warn = vi.fn();
    const out = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: { '/a': { get: { summary: long } } }
      }),
      warn
    );
    const s = JSON.parse(out).paths['/a'].get.summary as string;
    expect(s.length).toBe(200);
    expect(s.endsWith('…')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
  });
});

describe('lintSpecViaCli', () => {
  it('parses warning and error counts from postman cli json output', async () => {
    const summary = await lintSpecViaCli(
      {
        exec: createExecStub(
          JSON.stringify({
            violations: [
              { severity: 'ERROR', issue: 'broken' },
              { severity: 'WARNING', issue: 'warn' }
            ]
          })
        )
      },
      'ws-123',
      'spec-123'
    );

    expect(summary).toEqual({
      errors: 1,
      violations: [
        { severity: 'ERROR', issue: 'broken' },
        { severity: 'WARNING', issue: 'warn' }
      ],
      warnings: 1
    });
  });
});
