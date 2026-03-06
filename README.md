# postman-bootstrap-action

Public beta GitHub Action for Postman workspace bootstrap from a registry-backed OpenAPI spec.

## Scope

This action preserves the bootstrap slice of the API Catalog demo flow:

- create a Postman workspace
- assign the workspace to a governance group through the current Bifrost and internal path
- invite the requester and add workspace admins
- upload a remote spec to Spec Hub
- lint the uploaded spec by UID with the Postman CLI
- generate baseline, smoke, and contract collections sequentially
- inject generated tests and apply collection tags
- persist bootstrap repo variables needed by downstream sync work

The public beta contract uses kebab-case inputs and outputs and defaults `integration-backend` to `bifrost`.

## Usage

```yaml
jobs:
  bootstrap:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: postman-cs/postman-bootstrap-action@v0
        with:
          project-name: core-payments
          domain: core-banking
          domain-code: AF
          requester-email: owner@example.com
          workspace-admin-user-ids: 101,102
          spec-url: https://example.com/openapi.yaml
          environments-json: '["prod","stage"]'
          system-env-map-json: '{"prod":"uuid-prod","stage":"uuid-stage"}'
          governance-mapping-json: '{"core-banking":"Core Banking"}'
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          gh-fallback-token: ${{ secrets.GH_FALLBACK_TOKEN }}
```

## Outputs

- `workspace-id`
- `workspace-url`
- `workspace-name`
- `spec-id`
- `baseline-collection-id`
- `smoke-collection-id`
- `contract-collection-id`
- `collections-json`
- `lint-summary-json`

## Local development

```bash
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` produces the committed `dist/index.js` action bundle used by `action.yml`.

## Beta Release Strategy

- Beta channel tags use `v0.x.y`.
- Consumers can pin immutable tags such as `v0.2.0` for reproducibility.
- Moving tag `v0` is used only as the rolling beta channel.

## REST Migration Seam

Public inputs and outputs are backend-neutral. `integration-backend` currently supports `bifrost`, and backend-specific metadata stays internal so a future REST backend can replace the implementation without changing caller workflow syntax.
