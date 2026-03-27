import { describe, expect, it } from 'vitest';

import { buildSpecOperationCatalog } from '../src/lib/flow/operation-catalog.js';
import {
  parseFlowManifest,
  validateFlowManifestAgainstSpec
} from '../src/lib/flow/flow-manifest.js';

describe('flow manifest validation', () => {
  it('validates bindings and prior_output references against the spec', () => {
    const manifest = parseFlowManifest(`
flows:
  - name: checkout
    type: smoke
    steps:
      - stepKey: create-cart-1
        operationId: createCart
        bindings:
          - fieldKey: currency
            source: literal
            value: USD
        extract:
          - variable: cartId
            jsonPath: $.id
      - stepKey: get-cart-2
        operationId: getCartById
        bindings:
          - fieldKey: id
            source: prior_output
            sourceStepKey: create-cart-1
            variable: cartId
`);

    const operations = buildSpecOperationCatalog(`
openapi: 3.0.3
info:
  title: sample
  version: 1.0.0
paths:
  /cart:
    post:
      operationId: createCart
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                currency:
                  type: string
      responses:
        "200":
          description: ok
  /cart/{id}:
    get:
      operationId: getCartById
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: ok
`);

    expect(() => validateFlowManifestAgainstSpec(manifest, operations)).not.toThrow();
  });

  it('fails on unknown binding fields', () => {
    const manifest = parseFlowManifest(`
flows:
  - name: bad flow
    type: smoke
    steps:
      - stepKey: create-cart-1
        operationId: createCart
        bindings:
          - fieldKey: notAField
            source: literal
            value: x
`);

    const operations = buildSpecOperationCatalog(`
openapi: 3.0.3
info:
  title: sample
  version: 1.0.0
paths:
  /cart:
    post:
      operationId: createCart
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                currency:
                  type: string
      responses:
        "200":
          description: ok
`);

    expect(() => validateFlowManifestAgainstSpec(manifest, operations)).toThrow(
      /binds unknown field/
    );
  });
});
