# lasso-traefik template alignment

`lasso-traefik` is aligned to the current `service-lasso/service-template` baseline, then specialized for the Traefik release-backed service package.

## Preserved template baseline

The repo keeps the template's visible service-package structure:

- `.github/workflows/release.yml`
- `.github/workflows/validate-template.yml`
- `config/`
- `docs/`
- `runtime/`
- `scripts/`
- `service.json`
- `services/`
- `verify/`
- `CHANGELOG.md`
- `LICENSE`
- `README.md`

The copied `docs/reference/` material remains intentionally close to `service-template` so maintainers can compare this service repo against the canonical starter contract.

## Intentional Traefik differences

The following files intentionally differ from the sample template service:

- `service.json` declares the `@traefik` service id, Traefik `endpoints[]` for route bindings and URLs, env/globalenv selector projections, release artifact metadata, generated runtime config, and HTTP `/ping` readiness.
- `package.json` is present because this service packages upstream Traefik release assets with Node scripts.
- `scripts/package.mjs` downloads the selected upstream Traefik release asset for the target platform and creates the Service Lasso release archive.
- `scripts/verify.mjs` packages Traefik, extracts the archive, validates manifest invariants, starts Traefik with generated config, checks `/ping`, and shuts it down.
- `scripts/package.ps1`, `scripts/package.sh`, `scripts/test.ps1`, `scripts/test.sh`, `scripts/verify.ps1`, and `scripts/verify.sh` are template-shaped wrappers around the Traefik-specific Node packaging/verification flow.
- `.github/workflows/release.yml` publishes `lasso-traefik-*` archives, `service.json`, and `SHA256SUMS.txt` instead of sample `echo-service-*` archives.
- `.github/workflows/validate-template.yml` keeps the template validation entry point but runs the Traefik-specific package/test/verify wrappers for each OS matrix target.

## Validation contract

Local verification remains:

```powershell
npm test
```

Template-shaped entry points are also available:

```powershell
.\scripts\package.ps1
.\scripts\test.ps1
.\scripts\verify.ps1
```

On POSIX runners:

```bash
bash ./scripts/package.sh
bash ./scripts/test.sh
bash ./scripts/verify.sh
```
