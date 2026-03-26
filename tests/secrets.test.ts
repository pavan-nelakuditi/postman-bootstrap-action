import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/lib/http-error.js';
import {
  REDACTED,
  redactSecrets,
  sanitizeHeaders
} from '../src/lib/secrets.js';

describe('secret safety rails', () => {
  it('redacts configured secret values from freeform text', () => {
    const sanitized = redactSecrets(
      'Authorization: Bearer token-123 and key pmak-secret',
      ['token-123', 'pmak-secret']
    );

    expect(sanitized).toBe(`Authorization: Bearer ${REDACTED} and key ${REDACTED}`);
  });

  it('sanitizes headers before surfacing them', () => {
    const headers = sanitizeHeaders(
      {
        Authorization: 'Bearer token-123',
        'x-api-key': 'pmak-secret',
        'x-trace-id': 'trace-token-123'
      },
      ['token-123', 'pmak-secret']
    );

    expect(headers).toEqual({
      authorization: REDACTED,
      'x-api-key': REDACTED,
      'x-trace-id': `trace-${REDACTED}`
    });
  });

  it('builds sanitized HTTP diagnostics without leaking token material', () => {
    const error = new HttpError({
      method: 'POST',
      url: 'https://example.test/resource?token=token-123',
      status: 401,
      statusText: 'Unauthorized',
      requestHeaders: {
        Authorization: 'Bearer token-123',
        'x-api-key': 'pmak-secret'
      },
      responseBody: 'token-123 rejected with api key pmak-secret',
      secretValues: ['token-123', 'pmak-secret']
    });

    expect(error.message).not.toContain('token-123');
    expect(error.message).not.toContain('pmak-secret');
    expect(error.toJSON()).toEqual({
      method: 'POST',
      name: 'HttpError',
      requestHeaders: {
        authorization: REDACTED,
        'x-api-key': REDACTED
      },
      responseBody: `${REDACTED} rejected with api key ${REDACTED}`,
      status: 401,
      statusText: 'Unauthorized',
      url: `https://example.test/resource?token=${REDACTED}`
    });
  });
});
