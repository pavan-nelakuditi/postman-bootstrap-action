import { parse } from 'yaml';

type AnyRecord = Record<string, unknown>;

export type BindingTarget = 'path' | 'query' | 'header' | 'body';

export interface SpecOperationEntry {
  canonicalPath: string;
  inputTargets: Record<string, BindingTarget>;
  method: string;
  operationId: string;
  path: string;
}

export interface BaselineRequestEntry {
  canonicalPath: string;
  item: AnyRecord;
  itemName: string;
  method: string;
  path: string;
}

function isObject(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSpecDocument(specContent: string): AnyRecord {
  const trimmed = specContent.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(specContent) as AnyRecord;
  }
  return (parse(specContent) as AnyRecord) ?? {};
}

function resolveRef(document: AnyRecord, ref: string): AnyRecord | undefined {
  if (!ref.startsWith('#/')) {
    return undefined;
  }

  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((current, segment) => {
      if (!isObject(current)) return undefined;
      return current[segment];
    }, document) as AnyRecord | undefined;
}

function resolveSchema(document: AnyRecord, schema: unknown): AnyRecord | undefined {
  if (!isObject(schema)) {
    return undefined;
  }

  if (typeof schema.$ref === 'string') {
    return resolveRef(document, schema.$ref);
  }

  return schema;
}

function mergeInputTargets(
  target: Record<string, BindingTarget>,
  names: string[],
  bindingTarget: BindingTarget
): void {
  names.forEach((name) => {
    if (name && !target[name]) {
      target[name] = bindingTarget;
    }
  });
}

function extractParameterTargets(
  document: AnyRecord,
  parameters: unknown,
  target: Record<string, BindingTarget>
): void {
  if (!Array.isArray(parameters)) {
    return;
  }

  parameters.forEach((entry) => {
    const parameter =
      isObject(entry) && typeof entry.$ref === 'string'
        ? resolveRef(document, entry.$ref)
        : entry;
    if (!isObject(parameter)) {
      return;
    }

    const name = typeof parameter.name === 'string' ? parameter.name.trim() : '';
    const location = parameter.in;
    if (!name || (location !== 'path' && location !== 'query' && location !== 'header')) {
      return;
    }

    target[name] = location;
  });
}

function collectBodyPropertyNames(document: AnyRecord, schema: unknown, names: Set<string>): void {
  const resolved = resolveSchema(document, schema);
  if (!isObject(resolved)) {
    return;
  }

  if (isObject(resolved.properties)) {
    Object.keys(resolved.properties).forEach((key) => {
      if (key.trim()) {
        names.add(key);
      }
    });
  }

  if (Array.isArray(resolved.allOf)) {
    resolved.allOf.forEach((part) => collectBodyPropertyNames(document, part, names));
  }
}

function extractBodyTargets(
  document: AnyRecord,
  requestBody: unknown,
  target: Record<string, BindingTarget>
): void {
  const resolvedRequestBody =
    isObject(requestBody) && typeof requestBody.$ref === 'string'
      ? resolveRef(document, requestBody.$ref)
      : requestBody;
  if (!isObject(resolvedRequestBody) || !isObject(resolvedRequestBody.content)) {
    return;
  }

  const jsonContent =
    resolvedRequestBody.content['application/json'] ??
    resolvedRequestBody.content['application/*+json'];
  if (!isObject(jsonContent)) {
    return;
  }

  const bodyFieldNames = new Set<string>();
  collectBodyPropertyNames(document, jsonContent.schema, bodyFieldNames);
  mergeInputTargets(target, Array.from(bodyFieldNames), 'body');
}

export function canonicalizePath(path: string): string {
  return String(path || '')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\/+$/, '')
    .replace(/^$/, '/');
}

export function buildSpecOperationCatalog(specContent: string): SpecOperationEntry[] {
  const document = parseSpecDocument(specContent);
  const paths = isObject(document.paths) ? document.paths : {};
  const operations: SpecOperationEntry[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    const pathLevelParameters = pathItem.parameters;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isObject(operation)) continue;
      const normalizedMethod = method.toUpperCase();
      const operationId =
        typeof operation.operationId === 'string' ? operation.operationId.trim() : '';
      if (!operationId) continue;

      const inputTargets: Record<string, BindingTarget> = {};
      extractParameterTargets(document, pathLevelParameters, inputTargets);
      extractParameterTargets(document, operation.parameters, inputTargets);
      extractBodyTargets(document, operation.requestBody, inputTargets);

      operations.push({
        canonicalPath: canonicalizePath(path),
        inputTargets,
        method: normalizedMethod,
        operationId,
        path
      });
    }
  }

  return operations;
}

function collectCollectionItems(node: unknown): AnyRecord[] {
  if (!isObject(node)) return [];
  const items: AnyRecord[] = [];

  if (isObject(node.request)) {
    items.push(node);
  }

  if (Array.isArray(node.item)) {
    for (const child of node.item) {
      items.push(...collectCollectionItems(child));
    }
  }

  return items;
}

function extractRequestPath(url: unknown): string {
  if (typeof url === 'string') {
    try {
      return new URL(url).pathname || url;
    } catch {
      return url;
    }
  }

  if (isObject(url)) {
    if (typeof url.raw === 'string') {
      const rawValue = url.raw.trim();
      const strippedBaseVariable = rawValue.replace(/^\{\{[^}]+\}\}/, '');
      const raw = strippedBaseVariable.replace(/\{\{[^}]+\}\}/g, 'example');
      try {
        return new URL(raw).pathname || raw;
      } catch {
        const withoutQuery = raw.split('?')[0] ?? raw;
        return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery.replace(/^\/+/, '')}`;
      }
    }

    if (Array.isArray(url.path)) {
      return `/${url.path.map((segment) => String(segment)).join('/')}`;
    }
  }

  return '';
}

export function buildBaselineRequestCatalog(collection: unknown): BaselineRequestEntry[] {
  const items = collectCollectionItems(collection);
  return items.flatMap((item) => {
    const request = isObject(item.request) ? item.request : undefined;
    if (!request) return [];

    const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
    const path = extractRequestPath(request.url);
    if (!method || !path) return [];

    return [
      {
        canonicalPath: canonicalizePath(path),
        item,
        itemName: typeof item.name === 'string' ? item.name : '',
        method,
        path
      }
    ];
  });
}

export function matchOperationsToBaselineRequests(
  specOperations: SpecOperationEntry[],
  baselineRequests: BaselineRequestEntry[]
): Map<string, BaselineRequestEntry> {
  const baselineByKey = new Map<string, BaselineRequestEntry>();
  baselineRequests.forEach((request) => {
    baselineByKey.set(`${request.method} ${request.canonicalPath}`, request);
  });

  const matches = new Map<string, BaselineRequestEntry>();
  specOperations.forEach((operation) => {
    const key = `${operation.method} ${operation.canonicalPath}`;
    const request = baselineByKey.get(key);
    if (request) {
      matches.set(operation.operationId, request);
    }
  });

  return matches;
}
