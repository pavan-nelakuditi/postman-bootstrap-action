import { describe, expect, it } from 'vitest';

import type { ParsedFlowManifest } from '../src/lib/flow/flow-manifest.js';
import { compileFlowCollectionItems } from '../src/lib/flow/flow-compiler.js';
import type { SpecOperationEntry } from '../src/lib/flow/operation-catalog.js';

describe('flow compiler', () => {
  it('builds flow folders from baseline request templates and applies bindings/extracts', () => {
    const manifest: ParsedFlowManifest = {
      flows: [
        {
          name: 'checkout smoke',
          type: 'smoke',
          steps: [
            {
              stepKey: 'list-products-1',
              operationId: 'listProducts',
              extract: [{ variable: 'productId', jsonPath: '$.items[0].id' }]
            },
            {
              stepKey: 'get-product-by-id-2',
              operationId: 'getProductById',
              bindings: [
                {
                  fieldKey: 'id',
                  source: 'prior_output',
                  sourceStepKey: 'list-products-1',
                  variable: 'productId'
                }
              ]
            }
          ]
        }
      ]
    };

    const lookup = new Map([
      [
        'listProducts',
        {
          canonicalPath: '/products',
          item: {
            name: 'List products',
            request: {
              method: 'GET',
              url: {
                raw: '{{baseUrl}}/products'
              }
            }
          },
          itemName: 'List products',
          method: 'GET',
          path: '/products'
        }
      ],
      [
        'getProductById',
        {
          canonicalPath: '/products/{id}',
          item: {
            name: 'Get product by id',
            request: {
              method: 'GET',
              url: {
                raw: '{{baseUrl}}/products/:id',
                path: ['products', ':id']
              }
            }
          },
          itemName: 'Get product by id',
          method: 'GET',
          path: '/products/:id'
        }
      ]
    ]);
    const specOperationMap = new Map<string, SpecOperationEntry>([
      [
        'listProducts',
        {
          canonicalPath: '/products',
          inputTargets: {},
          method: 'GET',
          operationId: 'listProducts',
          path: '/products'
        }
      ],
      [
        'getProductById',
        {
          canonicalPath: '/products/{id}',
          inputTargets: { id: 'path' },
          method: 'GET',
          operationId: 'getProductById',
          path: '/products/{id}'
        }
      ]
    ]);

    const items = compileFlowCollectionItems(manifest, 'smoke', lookup, specOperationMap);

    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('checkout smoke');
    expect(items[0].item).toHaveLength(2);
    expect(items[0].item[1].request.url.raw).toContain('/products/{{productId}}');
    expect(items[0].item[1].request.url.path[1]).toBe('{{productId}}');
    expect(items[0].item[0].event[0].script.exec.join('\n')).toContain(
      'pm.collectionVariables.set("productId"'
    );
  });

  it('creates missing query, header, and nested body targets when bindings require them', () => {
    const manifest: ParsedFlowManifest = {
      flows: [
        {
          name: 'create cart smoke',
          type: 'smoke',
          steps: [
            {
              stepKey: 'create-cart-1',
              operationId: 'createCart',
              bindings: [
                {
                  fieldKey: 'locale',
                  source: 'literal',
                  value: 'en-US'
                },
                {
                  fieldKey: 'x-trace-id',
                  source: 'literal',
                  value: 'trace-123'
                },
                {
                  fieldKey: 'customer.profile.id',
                  source: 'literal',
                  value: 'cust-123'
                }
              ]
            }
          ]
        }
      ]
    };

    const lookup = new Map([
      [
        'createCart',
        {
          canonicalPath: '/cart',
          item: {
            name: 'Create cart',
            request: {
              method: 'POST',
              url: {
                raw: '{{baseUrl}}/cart'
              }
            }
          },
          itemName: 'Create cart',
          method: 'POST',
          path: '/cart'
        }
      ]
    ]);

    const specOperationMap = new Map<string, SpecOperationEntry>([
      [
        'createCart',
        {
          canonicalPath: '/cart',
          inputTargets: {
            locale: 'query',
            'x-trace-id': 'header',
            'customer.profile.id': 'body'
          },
          method: 'POST',
          operationId: 'createCart',
          path: '/cart'
        }
      ]
    ]);

    const items = compileFlowCollectionItems(manifest, 'smoke', lookup, specOperationMap);
    const request = items[0].item[0].request;

    expect(request.url.query).toEqual([{ key: 'locale', value: 'en-US' }]);
    expect(request.header).toEqual([{ key: 'x-trace-id', value: 'trace-123' }]);
    expect(JSON.parse(request.body.raw)).toEqual({
      customer: {
        profile: {
          id: 'cust-123'
        }
      }
    });
  });

  it('strips server-managed ids and response examples from cloned items before update', () => {
    const manifest: ParsedFlowManifest = {
      flows: [
        {
          name: 'sanitized smoke',
          type: 'smoke',
          steps: [
            {
              stepKey: 'list-products-1',
              operationId: 'listProducts'
            }
          ]
        }
      ]
    };

    const lookup = new Map([
      [
        'listProducts',
        {
          canonicalPath: '/products',
          item: {
            id: 'item-123',
            uid: 'uid-123',
            name: 'List products',
            request: {
              id: 'request-123',
              method: 'GET',
              url: {
                raw: '{{baseUrl}}/products'
              }
            },
            response: [{ name: '200 OK' }]
          },
          itemName: 'List products',
          method: 'GET',
          path: '/products'
        }
      ]
    ]);

    const specOperationMap = new Map<string, SpecOperationEntry>([
      [
        'listProducts',
        {
          canonicalPath: '/products',
          inputTargets: {},
          method: 'GET',
          operationId: 'listProducts',
          path: '/products'
        }
      ]
    ]);

    const items = compileFlowCollectionItems(manifest, 'smoke', lookup, specOperationMap);
    const requestItem = items[0].item[0];

    expect(requestItem.id).toBeUndefined();
    expect(requestItem.uid).toBeUndefined();
    expect(requestItem.response).toBeUndefined();
    expect(requestItem.request.id).toBeUndefined();
  });
});
