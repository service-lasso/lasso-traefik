# Bootstrap a new Service Lasso service repo

The canonical reader workflow for creating a release-backed service repository
is [Create the Release Repo](https://service-lasso.github.io/service-lasso/service-authoring/03-create-release-repo).

That Core guide requires a GitHub template-created repository, verifies its
`template_repository`, and starts adaptation from an authorized `develop`
branch. This redirect depends on Core PR
[service-lasso#1288](https://github.com/service-lasso/service-lasso/pull/1288)
and must not merge before that guide is available.

This repository retains Traefik-specific packaging, manifest, route, security,
and validation contracts.