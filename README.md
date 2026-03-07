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

For existing services, pass `workspace-id`, `spec-id`, and any existing collection IDs to rerun the bootstrap safely without creating duplicate Postman assets. When GitHub repo variable persistence is enabled, the action also falls back to `POSTMAN_WORKSPACE_ID`, `POSTMAN_SPEC_UID`, `POSTMAN_BASELINE_COLLECTION_UID`, `POSTMAN_SMOKE_COLLECTION_UID`, and `POSTMAN_CONTRACT_COLLECTION_UID` on reruns.

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

  bootstrap-existing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: postman-cs/postman-bootstrap-action@v0
        with:
          project-name: core-payments
          workspace-id: ws-123
          spec-id: spec-123
          baseline-collection-id: col-baseline
          smoke-collection-id: col-smoke
          contract-collection-id: col-contract
          spec-url: https://example.com/openapi.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
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

`npm run build` produces the committed `dist/index.cjs` action bundle used by `action.yml`.

## Beta Release Strategy

- Beta channel tags use `v0.x.y`.
- Consumers can pin immutable tags such as `v0.2.0` for reproducibility.
- Moving tag `v0` is used only as the rolling beta channel.

## REST Migration Seam

Public inputs and outputs are backend-neutral. `integration-backend` currently supports `bifrost`, and backend-specific metadata stays internal so a future REST backend can replace the implementation without changing caller workflow syntax.
