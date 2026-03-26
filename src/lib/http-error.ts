import { redactSecrets, sanitizeHeaders, type HeaderBag } from './secrets.js';

export interface HttpErrorInit {
  method: string;
  url: string;
  status: number;
  statusText: string;
  requestHeaders?: HeaderBag;
  responseBody?: string;
  secretValues?: unknown;
  bodyLimit?: number;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}...[truncated]`;
}

function buildMessage(init: HttpErrorInit): string {
  const method = String(init.method || 'GET').toUpperCase();
  const status = `${init.status}${init.statusText ? ` ${init.statusText}` : ''}`;
  const url = redactSecrets(init.url, init.secretValues);
  const body = truncate(
    redactSecrets(init.responseBody || '', init.secretValues),
    Math.max(0, init.bodyLimit ?? 800)
  );
  return body ? `${method} ${url} failed: ${status} - ${body}` : `${method} ${url} failed: ${status}`;
}

export class HttpError extends Error {
  readonly method: string;
  readonly requestHeaders: HeaderBag | undefined;
  readonly responseBody: string;
  readonly secretValues: unknown;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;

  constructor(init: HttpErrorInit) {
    super(buildMessage(init));
    this.name = 'HttpError';
    this.method = String(init.method || 'GET').toUpperCase();
    this.requestHeaders = init.requestHeaders;
    this.responseBody = init.responseBody || '';
    this.secretValues = init.secretValues;
    this.status = init.status;
    this.statusText = init.statusText;
    this.url = init.url;
  }

  static async fromResponse(
    response: Response,
    init: Omit<HttpErrorInit, 'responseBody' | 'status' | 'statusText'> & {
      responseBody?: string;
    }
  ): Promise<HttpError> {
    const responseBody =
      init.responseBody ?? (await response.text().catch(() => ''));
    return new HttpError({
      ...init,
      responseBody,
      status: response.status,
      statusText: response.statusText
    });
  }

  toJSON() {
    return {
      method: this.method,
      name: this.name,
      requestHeaders: sanitizeHeaders(this.requestHeaders, this.secretValues),
      responseBody: redactSecrets(this.responseBody, this.secretValues),
      status: this.status,
      statusText: this.statusText,
      url: redactSecrets(this.url, this.secretValues)
    };
  }
}
