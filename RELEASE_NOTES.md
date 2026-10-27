# Release Notes

## Unreleased

### dns-controller

* First version (phase C1 skeleton, not yet released): configuration from the environment with fail-fast validation, JSON-lines logging, `/healthz` and `/readyz`, a dependency-free Kubernetes REST client using the pod's ServiceAccount token and the cluster CA, a Lease-based single writer, and the versioned internal API (`dns.rapidmx.io/v1`) with the start-up compatibility handshake: on a version mismatch the controller refuses to act and reports it. It does not manage external-dns yet.
* Phase C2: the controller reads the server's desired state (`GET /v1/desired-state`, then a long poll on its version, treating any other version as a change) and reports its status (`PUT /v1/status`, after every new version and every minute, saying whether it holds the Lease). A malformed desired state is refused whole and never acted on; a server that no longer speaks `dns.rapidmx.io/v1` sends the controller back to the handshake. Its internal API (port 8080) accepts only the server's projected ServiceAccount token, verified against the cluster's keys fetched in-cluster, and serves nothing while the controller may not write. Both ports listen on IPv6 as well as IPv4, so a single-stack IPv6 cluster reaches them. New settings: `DNS_CONTROLLER_SERVER_SUBJECT` (required), `DNS_CONTROLLER_API_PORT`, `DNS_CONTROLLER_API_AUDIENCE`, `DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS` and `DNS_CONTROLLER_STATUS_INTERVAL_SECONDS`.
* Published as the container image `ghcr.io/rapidmx/dns-controller`, built on a distroless, non-root Node.js 24 base with no run-time dependencies. The RapidMX server's Helm chart deploys it and pins its version.
