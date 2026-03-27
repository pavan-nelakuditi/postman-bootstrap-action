import { describe, expect, it } from 'vitest';
import {
  buildBaselineRequestCatalog,
  buildSpecOperationCatalog,
  canonicalizePath,
  matchOperationsToBaselineRequests
} from '../src/lib/flow/operation-catalog.js';

describe('operation catalog helpers', () => {
  it('canonicalizes Postman-style and OpenAPI-style path params to the same form', () => {
    expect(canonicalizePath('/products/{id}')).toBe('/products/{id}');
    expect(canonicalizePath('/products/:id')).toBe('/products/{id}');
  });

  it('matches spec operations to generated baseline requests by method and normalized path', () => {
    const specOperations = buildSpecOperationCatalog(`
openapi: 3.0.3
info:
  title: sample
  version: 1.0.0
paths:
  /products:
    get:
      operationId: listProducts
      responses:
        "200":
          description: ok
  /products/{id}:
    get:
      operationId: getProductById
      responses:
        "200":
          description: ok
`);

    const baselineRequests = buildBaselineRequestCatalog({
      item: [
        {
          name: 'List products',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/products'
            }
          }
        },
        {
          name: 'Get product by id',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/products/:id'
            }
          }
        }
      ]
    });

    const lookup = matchOperationsToBaselineRequests(specOperations, baselineRequests);

    expect(lookup.get('listProducts')?.itemName).toBe('List products');
    expect(lookup.get('getProductById')?.itemName).toBe('Get product by id');
  });

  it('extracts binding targets from parameters and top-level JSON request bodies', () => {
    const specOperations = buildSpecOperationCatalog(`
openapi: 3.0.3
info:
  title: sample
  version: 1.0.0
paths:
  /products/{id}:
    get:
      operationId: getProductById
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
        - name: locale
          in: query
          schema:
            type: string
      responses:
        "200":
          description: ok
  /cart:
    post:
      operationId: createCart
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateCartRequest"
      responses:
        "200":
          description: ok
components:
  schemas:
    CreateCartRequest:
      type: object
      properties:
        currency:
          type: string
        customerId:
          type: string
`);

    expect(specOperations.find((entry) => entry.operationId === 'getProductById')?.inputTargets).toEqual({
      id: 'path',
      locale: 'query'
    });
    expect(specOperations.find((entry) => entry.operationId === 'createCart')?.inputTargets).toEqual({
      currency: 'body',
      customerId: 'body'
    });
  });
});
