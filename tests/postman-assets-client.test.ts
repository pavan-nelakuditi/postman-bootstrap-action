import { describe, expect, it, vi } from 'vitest';

import { PostmanAssetsClient } from '../src/lib/postman/postman-assets-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  });
}

describe('PostmanAssetsClient', () => {
  it('uses the public Postman API base URL by default', () => {
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test'
    });

    expect(client.getBaseUrl()).toBe('https://api.getpostman.com');
  });

  it('creates a workspace and enforces team visibility', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-123'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-123',
            visibility: 'private'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspace: {
            id: 'ws-123',
            visibility: 'team'
          }
        })
      );

    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.createWorkspace('Core Banking', 'desc')).resolves.toEqual({
      id: 'ws-123'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://api.getpostman.com/workspaces/ws-123',
      expect.objectContaining({
        method: 'PUT'
      })
    );
  });

  it('normalizes collection tags to valid Postman slugs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 204
      })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await client.tagCollection('col-123', ['Generated Smoke', 'core banking']);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.getpostman.com/collections/col-123/tags',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          tags: [{ slug: 'generated-smoke' }, { slug: 'core-banking' }]
        })
      })
    );
  });

  it('returns existing spec content when available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ content: 'openapi: 3.1.0' })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.getSpecContent('spec-123')).resolves.toBe('openapi: 3.1.0');
  });

  it('returns undefined when fetching existing spec content fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not found', { status: 404 })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(client.getSpecContent('spec-123')).resolves.toBeUndefined();
  });
});
