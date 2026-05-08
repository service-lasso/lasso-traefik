# Protected Service Admin route hardening

Service Admin traffic for the local SSO path must enter through Traefik at
`serviceadmin.servicelasso.localhost`. Direct backend ports and browser-supplied
identity headers are not trusted.

This repo only owns the Traefik side of the boundary. Service Lasso core stays
limited to Service Manager and Secrets Broker responsibilities; OIDC login,
callback, session, token validation, and claim handling are owned by
`traefik-oidc-auth`, ZITADEL, and the consuming service/app.

## Required route behavior

Protected Service Admin routes must:

- match `Host(`serviceadmin.servicelasso.localhost`)`;
- use the `websecure` entrypoint by default;
- strip incoming browser-controlled identity headers before auth forwarding;
- use `forwardAuth` for the OIDC/plugin auth gate;
- accept trusted identity metadata only from the auth middleware response;
- fail closed when the auth middleware is unavailable;
- forward to the local Service Admin backend only through Traefik.

## Spoofed headers that must be removed

The protected route fixture removes these incoming request headers before the
request reaches Service Admin:

- `X-Service-Lasso-User`
- `X-Service-Lasso-Workspace`
- `X-Service-Lasso-Roles`
- `X-Service-Lasso-Actor`
- `X-Forwarded-User`
- `X-Forwarded-Email`
- `X-Auth-Request-User`
- `X-Auth-Request-Email`

The auth middleware may then inject a bounded trusted set such as
`X-Service-Lasso-User`, `X-Service-Lasso-Workspace`, `X-Service-Lasso-Roles`,
and `X-Service-Lasso-Actor` after successful verification.

## Local development escape hatch

No unauthenticated bypass route is enabled by default. If local development ever
needs an unsafe bypass, it must be explicit, opt-in, dev-only, and visually named
as unsafe in its router/middleware names. It must not reuse
`serviceadmin.servicelasso.localhost`.

See the installed fixture `runtime/protected-serviceadmin.example.yml` for the
contract shape that tests inspect.
