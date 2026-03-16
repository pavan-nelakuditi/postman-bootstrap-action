import { describe, expect, it, vi } from 'vitest';

import {
  chooseCanonicalWorkspace,
  resolveCanonicalWorkspaceSelection
} from '../src/lib/postman/workspace-selection.js';
import { normalizeGitHubRepoUrl } from '../src/lib/postman/postman-assets-client.js';

describe('normalizeGitHubRepoUrl', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeGitHubRepoUrl('')).toBe('');
    expect(normalizeGitHubRepoUrl(null)).toBe('');
    expect(normalizeGitHubRepoUrl(undefined)).toBe('');
  });

  it('normalizes HTTPS GitHub URLs to lowercase owner/repo', () => {
    expect(normalizeGitHubRepoUrl('https://github.com/Postman-CS/my-repo')).toBe(
      'https://github.com/postman-cs/my-repo'
    );
  });

  it('strips trailing .git suffix', () => {
    expect(normalizeGitHubRepoUrl('https://github.com/postman-cs/my-repo.git')).toBe(
      'https://github.com/postman-cs/my-repo'
    );
  });

  it('strips trailing slashes', () => {
    expect(normalizeGitHubRepoUrl('https://github.com/postman-cs/my-repo/')).toBe(
      'https://github.com/postman-cs/my-repo'
    );
  });

  it('converts SSH git@ URLs to HTTPS', () => {
    expect(normalizeGitHubRepoUrl('git@github.com:postman-cs/my-repo.git')).toBe(
      'https://github.com/postman-cs/my-repo'
    );
  });

  it('returns non-GitHub URLs lowercased but otherwise unchanged', () => {
    const url = 'https://gitlab.com/org/repo';
    expect(normalizeGitHubRepoUrl(url)).toBe(url);
  });
});

describe('chooseCanonicalWorkspace', () => {
  const repoUrl = 'https://github.com/postman-cs/core-payments';

  it('returns create when no matching workspaces exist', () => {
    const result = chooseCanonicalWorkspace({
      repoUrl,
      matchingWorkspaces: []
    });
    expect(result).toEqual({ type: 'create' });
  });

  it('returns existing with linked_match when exactly one workspace is linked to the repo', () => {
    const result = chooseCanonicalWorkspace({
      repoUrl,
      matchingWorkspaces: [
        { id: 'ws-abc', linkedRepoUrl: repoUrl }
      ]
    });
    expect(result).toEqual({
      type: 'existing',
      workspaceId: 'ws-abc',
      source: 'linked_match',
      warning: undefined
    });
  });

  it('emits a warning when linked workspace differs from repo var workspace', () => {
    const result = chooseCanonicalWorkspace({
      repoUrl,
      repoWorkspaceId: 'ws-old',
      matchingWorkspaces: [
        { id: 'ws-new', linkedRepoUrl: repoUrl }
      ]
    });
    expect(result.type).toBe('existing');
    if (result.type === 'existing') {
      expect(result.workspaceId).toBe('ws-new');
      expect(result.source).toBe('linked_match');
      expect(result.warning).toContain('ws-old');
      expect(result.warning).toContain('ws-new');
    }
  });

  it('returns manual_review when multiple workspaces are linked to the same repo', () => {
    const result = chooseCanonicalWorkspace({
      repoUrl,
      matchingWorkspaces: [
        { id: 'ws-1', linkedRepoUrl: repoUrl },
        { id: 'ws-2', linkedRepoUrl: repoUrl }
      ]
    });
    expect(result.type).toBe('manual_review');
    if (result.type === 'manual_review') {
      expect(result.reason).toContain('ws-1');
      expect(result.reason).toContain('ws-2');
    }
  });

  it('keeps repo var workspace when multiple linked workspaces exist and one matches', () => {
    const result = chooseCanonicalWorkspace({
      repoUrl,
      repoWorkspaceId: 'ws-1',
      matchingWorkspaces: [
        { id: 'ws-1', linkedRepoUrl: repoUrl },
        { id: 'ws-2', linkedRepoUrl: repoUrl }
      ]
    });
    expect(result.type).toBe('existing');
    if (result.type === 'existing') {
      expect(result.workspaceId).toBe('ws-1');
      expect(result.source).toBe('linked_match');
    }
  });

  it('returns existing with repo_var when no linked match but repo var is set', () => {
    const result = chooseCanonicalWorkspace({
      repoUrl,
      repoWorkspaceId: 'ws-from-var',
      matchingWorkspaces: [
        { id: 'ws-from-var', linkedRepoUrl: null }
      ]
    });
    expect(result).toEqual({
      type: 'existing',
      workspaceId: 'ws-from-var',
      source: 'repo_var'
    });
  });

  it('returns existing with name_match when no linked match and no repo var', () => {
    const result = chooseCanonicalWorkspace({
      repoUrl,
      matchingWorkspaces: [
        { id: 'ws-name-match', linkedRepoUrl: null }
      ]
    });
    expect(result).toEqual({
      type: 'existing',
      workspaceId: 'ws-name-match',
      source: 'name_match'
    });
  });

  it('picks the lexicographically first workspace on name_match when multiple exist', () => {
    const result = chooseCanonicalWorkspace({
      repoUrl,
      matchingWorkspaces: [
        { id: 'ws-zzz', linkedRepoUrl: null },
        { id: 'ws-aaa', linkedRepoUrl: null }
      ]
    });
    expect(result.type).toBe('existing');
    if (result.type === 'existing') {
      expect(result.workspaceId).toBe('ws-aaa');
    }
  });
});

describe('resolveCanonicalWorkspaceSelection', () => {
  const repoUrl = 'https://github.com/postman-cs/core-payments';
  const workspaceName = '[AF] core-payments';

  it('returns create when no workspaces match by name', async () => {
    const postman = {
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn()
    };

    const result = await resolveCanonicalWorkspaceSelection({
      postman,
      workspaceName,
      repoUrl,
      teamId: 'team-123',
      accessToken: 'token-abc'
    });

    expect(result).toEqual({ type: 'create' });
    expect(postman.getWorkspaceGitRepoUrl).not.toHaveBeenCalled();
  });

  it('fetches git repo URL even when only one workspace matches by name', async () => {
    const postman = {
      findWorkspacesByName: vi.fn().mockResolvedValue([{ id: 'ws-single', name: workspaceName }]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(repoUrl)
    };

    const result = await resolveCanonicalWorkspaceSelection({
      postman,
      workspaceName,
      repoUrl,
      teamId: 'team-123',
      accessToken: 'token-abc'
    });

    expect(result.type).toBe('existing');
    expect(postman.getWorkspaceGitRepoUrl).toHaveBeenCalled();
  });

  it('fetches git repo URLs when multiple workspaces match by name', async () => {
    const postman = {
      findWorkspacesByName: vi.fn().mockResolvedValue([
        { id: 'ws-1', name: workspaceName },
        { id: 'ws-2', name: workspaceName }
      ]),
      getWorkspaceGitRepoUrl: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'ws-1') return repoUrl;
        return null;
      })
    };

    const result = await resolveCanonicalWorkspaceSelection({
      postman,
      workspaceName,
      repoUrl,
      teamId: 'team-123',
      accessToken: 'token-abc'
    });

    expect(result.type).toBe('existing');
    if (result.type === 'existing') {
      expect(result.workspaceId).toBe('ws-1');
      expect(result.source).toBe('linked_match');
    }
    expect(postman.getWorkspaceGitRepoUrl).toHaveBeenCalledTimes(2);
  });

  it('falls back to repoWorkspaceId when workspace lookup fails', async () => {
    const warn = vi.fn();
    const postman = {
      findWorkspacesByName: vi.fn().mockRejectedValue(new Error('network error')),
      getWorkspaceGitRepoUrl: vi.fn()
    };

    const result = await resolveCanonicalWorkspaceSelection({
      postman,
      workspaceName,
      repoWorkspaceId: 'ws-fallback',
      repoUrl,
      teamId: 'team-123',
      accessToken: 'token-abc',
      warn
    });

    expect(result.type).toBe('existing');
    if (result.type === 'existing') {
      expect(result.workspaceId).toBe('ws-fallback');
      expect(result.source).toBe('repo_var');
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ws-fallback'));
  });

  it('rethrows workspace lookup error when no repoWorkspaceId fallback exists', async () => {
    const postman = {
      findWorkspacesByName: vi.fn().mockRejectedValue(new Error('network error')),
      getWorkspaceGitRepoUrl: vi.fn()
    };

    await expect(
      resolveCanonicalWorkspaceSelection({
        postman,
        workspaceName,
        repoUrl,
        teamId: 'team-123',
        accessToken: 'token-abc'
      })
    ).rejects.toThrow('network error');
  });
});
