# Traefik + ZITADEL SSO ingress contract

This contract defines the Traefik-owned edge behavior for Service Lasso local SSO. It starts with Service Admin at `serviceadmin.servicelasso.localhost` and is intended to apply to future local web UIs.

## Ownership boundaries

| Component | Owns | Does not own |
| --- | --- | --- |
| Traefik | local domains, entrypoints, TLS termination where configured, file-provider routing, protected route middleware, spoofed header stripping, fail-closed forwarding | OIDC code exchange, session storage, user/workspace mapping, app authorization |
| ZITADEL | login authority, OIDC provider, user authentication, MFA/policies, OIDC client issuance, login/logout provider screens | Service Lasso app routes, Service Admin authorization, Secrets Broker storage |
| Service Lasso auth facade | OIDC relying party, callback handling, state/nonce validation, local secure session cookie, forward-auth decision endpoint, normalized identity headers | Direct Traefik entrypoints, ZITADEL login UI, app-specific permissions beyond normalized identity context |
| Service Admin | consuming trusted Service Lasso identity context, app user/workspace/role mapping, UI state, audit actor usage | trusting browser-supplied identity headers, running its own duplicate SSO flow |

## Local domains

All browser-facing domains use the `.localhost` convention:

- `serviceadmin.servicelasso.localhost` routes to Service Admin and is protected.
- `auth.servicelasso.localhost` routes to the Service Lasso auth facade for `/oauth2/callback`, `/logout`, and forward-auth support endpoints where exposed.
- `zitadel.servicelasso.localhost` routes to the local ZITADEL service when locally hosted.
- `traefik.servicelasso.localhost` may route to the Traefik dashboard only when explicitly enabled.

Do not use `.local` for this flow.

## Protected Service Admin route

The protected route must:

- match `Host(`serviceadmin.servicelasso.localhost`)`;
- use `websecure` by default;
- require TLS/local certificate handling supplied by bootstrap/localcert;
- strip spoofable incoming identity headers before forwarding;
- call the auth facade forward-auth endpoint;
- trust identity headers only when emitted by the auth facade response;
- fail closed when the auth facade is unavailable;
- route to Service Admin only through a loopback/internal backend;
- avoid any default unauthenticated bypass router for the same host.

Reference fixture: `runtime/servicelasso-sso-ingress.example.yml`.

## Forward-auth contract

Traefik sends these request inputs to the auth facade:

- `Cookie`
- `Authorization`
- `X-Forwarded-Proto`
- `X-Forwarded-Host`
- `X-Forwarded-Uri`

The auth facade returns one of the following decisions:

| State | Auth facade response | Traefik behavior | Browser/app result |
| --- | --- | --- | --- |
| Unauthenticated | redirect to ZITADEL/login start | pass redirect response through | browser begins login |
| Authenticated | 2xx plus trusted identity headers | forward request to Service Admin | app receives trusted identity context |
| Forbidden/inactive workspace | 403 or redirect to app-safe error route | fail closed | app/browser sees forbidden/error state |
| Auth facade unavailable | no response/5xx from forward-auth service | fail closed | protected app is not reached |

## Trusted identity headers

Traefik must remove browser-supplied values for both legacy and new identity headers before auth. The auth facade may inject only this bounded trusted set after successful verification:

- `X-ServiceLasso-User-ID`
- `X-ServiceLasso-Workspace-ID`
- `X-ServiceLasso-Instance-ID`
- `X-ServiceLasso-Email`
- `X-ServiceLasso-Roles`
- `X-ServiceLasso-Auth-Method`
- `X-ServiceLasso-Audit-Actor`

A future signed identity envelope may be added, but browser-supplied identity headers are never trusted.

## Callback, logout, and redirect rules

Callback route:

```text
https://auth.servicelasso.localhost/oauth2/callback
```

Logout route:

```text
https://auth.servicelasso.localhost/logout
```

Redirect targets must be allowlisted to Service Lasso local domains only:

- `serviceadmin.servicelasso.localhost`
- `auth.servicelasso.localhost`
- `zitadel.servicelasso.localhost`

The auth facade validates OIDC state and nonce. Traefik only routes callback/logout traffic and must not log tokens, codes, cookies, or identity envelopes.

## TLS and cookie expectations

- Protected browser routes use `websecure`.
- Local certificate provisioning is owned by bootstrap/localcert.
- Session cookies are created by the auth facade, not Traefik.
- Cookies must use secure defaults: `Secure`, `HttpOnly`, and SameSite appropriate for the local domain flow.
- Traefik may add safe response hardening headers; it must not materialize or persist session cookie values.

## Auth failure responses

Traefik/auth facade behavior must distinguish these states without leaking tokens or cookies:

- unauthenticated/login required
- expired session
- invalid callback state/nonce
- forbidden user
- inactive workspace
- workspace mismatch
- missing role/permission
- auth facade unavailable
- ZITADEL unavailable
- route/middleware misconfigured

Diagnostics should name host, router, middleware, state, and next action only.

## Test/fixture coverage

The validation script inspects the SSO fixture for:

- protected `serviceadmin.servicelasso.localhost` route;
- `auth.servicelasso.localhost` callback/logout routes;
- `zitadel.servicelasso.localhost` route;
- spoofed identity header stripping;
- forward-auth request/response header contract;
- redirect allowlist metadata;
- no unauthenticated Service Admin bypass route.
