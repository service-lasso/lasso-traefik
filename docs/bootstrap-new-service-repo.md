# Bootstrap a new Service Lasso service repo

This is the canonical flow for creating Service Lasso service repos.

## Reader workflow

For the canonical reader workflow for creating a release-backed service repository,
see [Create the Release Repo](https://service-lasso.github.io/service-lasso/service-authoring/03-create-release-repo).
It covers creating and verifying the template-origin repository, cloning its develop branch,
and beginning the first focused adaptation issue and branch.

Use that workflow before completing the component-specific adaptation requirements below.

## Required rename/adaptation checklist

Update these at minimum:

- `README.md`
- `service.json`
  - `id`
  - `name`
  - `description`
  - `logs.default.path`
  - `meta.repository.url`
  - docs/issues/support links
  - `artifact.source.repo`
  - platform `assetName` values
  - platform `command` values
  - action descriptions
  - `execconfig.executable`
  - `execconfig.args` when needed
  - `execconfig.env`
  - `healthchecks[]`
- `verify/service-harness.json`
  - `serviceId`
  - artifact path
  - harness-compatible health shape
- `scripts/package.ps1`
- `scripts/package.sh`
- `scripts/test.ps1`
- `scripts/test.sh`
- `scripts/verify.ps1`
- `scripts/verify.sh`
- `.github/workflows/release.yml`
- `.github/workflows/validate-template.yml`

## System service naming

Base/system services use an `@` service id:

```text
@node
@python
@java
@localcert
@nginx
@traefik
@serviceadmin
@secretsbroker
```

Repo names should still use normal GitHub-friendly names, for example:

```text
lasso-secretsbroker -> service id @secretsbroker
lasso-serviceadmin  -> service id @serviceadmin
```

Sample/test services may remain unprefixed, for example `echo-service`.

## Compiled runtime services

If the service builds a binary, keep the template package/test/verify contract but add the toolchain setup explicitly.

For Go services, add this after checkout in both workflow files before package/test steps:

```yaml
- name: Set up Go
  uses: actions/setup-go@v6
  with:
    go-version-file: go.mod
```

Then package scripts should build the platform artifact before archiving it.

## Harness compatibility note

The released `service-lasso-harness` contract is intentionally narrower than `service.json`.

For example, `service.json` may carry an HTTP healthcheck:

```json
"healthchecks": [
  {
    "id": "http-ready",
    "type": "http",
    "url": "http://127.0.0.1:17890/health",
    "timeoutSeconds": 5
  }
]
```

But `verify/service-harness.json` currently must stay compatible with the released harness schema. If the harness does not support a field such as `health.url`, keep the verify contract on the supported shape, for example:

```json
"health": {
  "type": "process",
  "timeoutSeconds": 30
}
```

Do not copy runtime-only `service.json` fields into the harness contract unless the harness schema supports them.

## Local scratch hygiene

Use repo-local `.tmp/` for temporary files and remove it before committing.

The template ignores `.tmp/`, `dist/`, `output/`, `.harness/`, and generated `verify/service-harness.ci.json`.

## Issue/PR trail

Every real service bootstrap should leave a visible trail:

- issue created before work starts
- start/resume comment
- validation comment
- PR linked to issue
- final comment with commit, PR, and validation evidence
