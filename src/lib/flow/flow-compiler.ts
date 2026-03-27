import type { ParsedFlowManifest } from './flow-manifest.js';
import type { BaselineRequestEntry, BindingTarget, SpecOperationEntry } from './operation-catalog.js';

type CollectionItem = Record<string, any>;

function cloneItem<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeItemForCollectionUpdate(item: CollectionItem): CollectionItem {
  delete item.id;
  delete item.uid;
  delete item._postman_id;
  delete item.response;

  if (Array.isArray(item.item)) {
    item.item = item.item
      .filter((child) => child && typeof child === 'object')
      .map((child) => sanitizeItemForCollectionUpdate(child as CollectionItem));
  }

  if (item.request && typeof item.request === 'object') {
    delete item.request.id;
    delete item.request.uid;
    delete item.request._postman_id;
  }

  return item;
}

function setRequestDescription(item: CollectionItem, stepKey: string, operationId: string): void {
  const request = item.request;
  if (!request || typeof request !== 'object') {
    return;
  }

  const marker = `Generated from flow step ${stepKey} (operationId: ${operationId})`;
  const currentDescription =
    typeof request.description === 'string'
      ? request.description
      : typeof request.description?.content === 'string'
        ? request.description.content
        : '';

  const nextDescription = currentDescription
    ? `${currentDescription}\n\n${marker}`
    : marker;

  request.description = nextDescription;
}

function replaceRawPathSegment(raw: string, fieldKey: string, nextValue: string): string {
  return raw
    .replace(new RegExp(`:${fieldKey}(?=([/?#&]|$))`, 'g'), nextValue)
    .replace(new RegExp(`\\{${fieldKey}\\}`, 'g'), nextValue);
}

function setNestedBodyValue(body: Record<string, unknown>, fieldKey: string, nextValue: string): void {
  const segments = fieldKey.split('.').filter(Boolean);
  if (segments.length === 0) {
    return;
  }

  let current: Record<string, unknown> = body;
  segments.slice(0, -1).forEach((segment) => {
    const existing = current[segment];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  });

  current[segments[segments.length - 1] as string] = nextValue;
}

function setStructuredRequestValue(
  request: CollectionItem,
  fieldKey: string,
  nextValue: string,
  target: BindingTarget
): boolean {
  let applied = false;
  const url = request.url;

  if (target === 'path' && url && typeof url === 'object') {
    if (typeof url.raw === 'string') {
      const replaced = replaceRawPathSegment(url.raw, fieldKey, nextValue);
      if (replaced !== url.raw) {
        url.raw = replaced;
        applied = true;
      }
    }

    if (Array.isArray(url.path)) {
      url.path = url.path.map((segment: unknown) => {
        if (typeof segment !== 'string') return segment;
        if (segment === `:${fieldKey}` || segment === `{${fieldKey}}`) {
          applied = true;
          return nextValue;
        }
        return segment;
      });
    }

    if (Array.isArray(url.variable)) {
      url.variable.forEach((entry: CollectionItem) => {
        if (entry?.key === fieldKey) {
          entry.value = nextValue;
          applied = true;
        }
      });
    }

  }

  if (target === 'query' && url && typeof url === 'object') {
    if (Array.isArray(url.query)) {
      url.query.forEach((entry: CollectionItem) => {
        if (entry?.key === fieldKey) {
          entry.value = nextValue;
          applied = true;
        }
      });
    } else {
      url.query = [];
    }

    if (!applied && Array.isArray(url.query)) {
      url.query.push({
        key: fieldKey,
        value: nextValue
      });
      applied = true;
    }
  }

  if (target === 'header') {
    if (!Array.isArray(request.header)) {
      request.header = [];
    }

    request.header.forEach((entry: CollectionItem) => {
      if (String(entry?.key || '').toLowerCase() === fieldKey.toLowerCase()) {
        entry.value = nextValue;
        applied = true;
      }
    });

    if (!applied) {
      request.header.push({
        key: fieldKey,
        value: nextValue
      });
      applied = true;
    }
  }

  const body = request.body;
  if (target === 'body') {
    if (!body) {
      request.body = {
        mode: 'raw',
        raw: '{}',
        options: {
          raw: {
            language: 'json'
          }
        }
      };
    }

    const currentBody = request.body;
    if (currentBody?.mode === 'raw' && typeof currentBody.raw === 'string') {
      try {
        const parsed = JSON.parse(currentBody.raw || '{}') as Record<string, unknown>;
        setNestedBodyValue(parsed, fieldKey, nextValue);
        currentBody.raw = JSON.stringify(parsed, null, 2);
        applied = true;
      } catch {
        // ignore non-JSON raw bodies
      }
    }
  }

  return applied;
}

function addFlowExtracts(item: CollectionItem, extracts: NonNullable<ParsedFlowManifest['flows'][number]['steps'][number]['extract']>): void {
  if (extracts.length === 0) {
    return;
  }

  const exec = [
    '// [FlowExtract] Auto-generated response extractors',
    '(function () {',
    '  let data;',
    '  try {',
    '    data = pm.response.json();',
    '  } catch (error) {',
    '    return;',
    '  }',
    '  const readPath = (input, path) => {',
    "    const tokens = path.replace(/^\\$\\./, '').match(/[^.[\\]]+|\\[(\\d+)\\]/g) || [];",
    '    let current = input;',
    '    for (const token of tokens) {',
    "      const normalized = token.startsWith('[') ? token.slice(1, -1) : token;",
    '      if (current == null) return undefined;',
    '      current = current[normalized];',
    '    }',
    '    return current;',
    '  };'
  ];

  extracts.forEach((extract) => {
    exec.push(
      `  {`,
      `    const value = readPath(data, ${JSON.stringify(extract.jsonPath)});`,
      '    if (value !== undefined) {',
      `      pm.collectionVariables.set(${JSON.stringify(extract.variable)}, typeof value === 'string' ? value : JSON.stringify(value));`,
      '    }',
      '  }'
    );
  });

  exec.push('})();');

  item.event = Array.isArray(item.event) ? item.event : [];
  item.event.push({
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec
    }
  });
}

export function compileFlowCollectionItems(
  manifest: ParsedFlowManifest,
  type: 'smoke' | 'contract',
  operationLookup: Map<string, BaselineRequestEntry>,
  specOperationMap: Map<string, SpecOperationEntry>
): CollectionItem[] {
  return manifest.flows
    .filter((flow) => flow.type === type)
    .map((flow) => ({
      name: flow.name,
      item: flow.steps.map((step) => {
        const template = operationLookup.get(step.operationId);
        if (!template) {
          throw new Error(
            `Unable to resolve operationId "${step.operationId}" from baseline collection for flow "${flow.name}"`
          );
        }
        const operation = specOperationMap.get(step.operationId);
        if (!operation) {
          throw new Error(
            `Unable to resolve operation metadata for "${step.operationId}" in flow "${flow.name}"`
          );
        }

        const item = sanitizeItemForCollectionUpdate(cloneItem(template.item));
        setRequestDescription(item, step.stepKey, step.operationId);

        const request = item.request ?? {};
        for (const binding of step.bindings ?? []) {
          if (binding.source === 'example') {
            continue;
          }

          const nextValue =
            binding.source === 'literal'
              ? binding.value ?? ''
              : `{{${binding.variable ?? ''}}}`;

          setStructuredRequestValue(
            request,
            binding.fieldKey,
            nextValue,
            operation.inputTargets[binding.fieldKey] as BindingTarget
          );
        }

        addFlowExtracts(item, step.extract ?? []);
        return item;
      })
    }));
}
