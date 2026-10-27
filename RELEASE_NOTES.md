# Release Notes

## Unreleased

### dns-controller

* First version (phase C1 skeleton, not yet released): configuration from the environment with fail-fast validation, JSON-lines logging, `/healthz` and `/readyz`, a dependency-free Kubernetes REST client using the pod's ServiceAccount token and the cluster CA, a Lease-based single writer, and the versioned internal API (`dns.rapidmx.io/v1`) with the start-up compatibility handshake: on a version mismatch the controller refuses to act and reports it. It does not manage external-dns yet.
* Published as the container image `ghcr.io/rapidmx/dns-controller`, built on a distroless, non-root Node.js 24 base with no run-time dependencies. The RapidMX server's Helm chart deploys it and pins its version.
