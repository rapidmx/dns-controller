# RapidMX: DNS Controller

[![Build](https://github.com/rapidmx/dns-controller/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/rapidmx/dns-controller/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/rapidmx/dns-controller/badge.svg?branch=main)](https://coveralls.io/github/rapidmx/dns-controller?branch=main)

Publishes the DNS records a [RapidMX server](https://github.com/rapidmx/server) deployment and its mail domains need
(MX, SPF, DKIM, DMARC, ownership verification, the deployment's hosts) through
[external-dns](https://github.com/kubernetes-sigs/external-dns).

It is the only RapidMX component allowed to create or change Kubernetes objects. The mail server, which is large and
internet-facing, keeps read-only Kubernetes access and only records the desired state; this small controller reads that
desired state from the server's internal API and turns it into one external-dns Deployment per DNS provider and
`DNSEndpoint` resources, in its own namespace only. It has no database, Redis or mail access, no run-time dependencies,
and runs on a distroless, non-root image with a read-only root filesystem.

The design is in `@rapidmx/restapi`'s
[`specs/dns_publishing_and_integrations.md`](https://github.com/rapidmx/restapi/blob/main/specs/dns_publishing_and_integrations.md)
(§7).

## Status

Phase C2: on top of the C1 skeleton (configuration, structured logging, health endpoints, the Kubernetes REST client,
the Lease-based single writer, the start-up handshake), the controller reads the desired state from the server with a
long poll, reports its status back, and authenticates the server's calls to its own internal API. It does not manage
external-dns yet.

| Phase | Scope | State |
| --- | --- | --- |
| C1 | Skeleton: configuration, logging, health, Kubernetes client, Lease, `v1` types and the handshake | done |
| C2 | Desired-state long poll, status reports, projected-token authentication both ways | done |
| C3 | Reconcile: external-dns Deployments, `DNSEndpoint`s, `ExternalSecret`s, per-provider and per-endpoint status, secret writes for the Kubernetes-Secret backend | planned |
| C4 | Takeover, credentials-test and restore Jobs | planned |
| C5 | external-dns metrics and per-provider health | planned |

## How it talks to the server

- **Versioned API.** Every route is under `<base>/v1`, and every payload carries `apiVersion: dns.rapidmx.io/v1` and a
  `kind` (`src/api/v1.ts`). Within v1 changes are additive only; a breaking change is v2.
- **Handshake.** At start-up the controller calls `POST <base>/handshake` (unversioned, frozen shape) with its version
  and the API versions it speaks. If the server shares none, the controller **refuses to act**: it does not take its
  Lease, writes nothing, answers `/readyz` with 503 and the reason, logs `dns_api_incompatible`, and asks again every
  `DNS_CONTROLLER_HANDSHAKE_RETRY_SECONDS`. The server records the mismatch so the admin console shows it. A server that
  cannot be reached is not a mismatch: the controller stays ready and retries with backoff.
- **Desired state.** `GET <base>/v1/desired-state` once for the whole state, then a long poll with `since=<version>`,
  which the server answers when the version moves (or after 55 s). Any version other than the controller's own is a
  change, a lower one too (the server's counter can be reset). A malformed state is refused whole and never acted on.
  A server that answers 404 or `unsupported_api_version` (rolled back underneath the controller) sends it back to the
  handshake.
- **Status.** `PUT <base>/v1/status` after every new desired-state version and every
  `DNS_CONTROLLER_STATUS_INTERVAL_SECONDS`, saying whether this pod holds the Lease: the server acts only on the
  holder's report.
- **Authentication.** Projected ServiceAccount tokens with dedicated audiences in both directions, no shared secrets.
  The controller presents its token (audience `rapidmx-internal-dns`) on every call. On its internal API
  (`DNS_CONTROLLER_API_PORT`) it accepts only the server's token: audience `rapidmx-dns-controller`, verified with
  `node:crypto` against the cluster's service-account keys, fetched in-cluster from the API server
  (`/openid/v1/jwks`, `/.well-known/openid-configuration`; the advertised `jwks_uri` is never used), and the exact
  subject `DNS_CONTROLLER_SERVER_SUBJECT`. Every refusal is the same 403. The internal API serves nothing while the
  controller may not write (incompatible, or not holding the Lease); its routes arrive with C3.

## Configuration

Set by the RapidMX server's Helm chart; listed here for reference and local runs.

| Environment variable | Purpose |
| --- | --- |
| `DNS_CONTROLLER_SERVER_URL` | **Required.** The server's internal DNS API base, e.g. `http://<release>-server.<namespace>.svc:3000/internal/dns` |
| `DNS_CONTROLLER_SERVER_TOKEN_FILE` | Projected token presented to the server (default `/var/run/secrets/rapidmx/internal-dns/token`), re-read on every call |
| `DNS_CONTROLLER_SERVER_TIMEOUT_MS` | Timeout of one call to the server (default `10000`) |
| `DNS_CONTROLLER_HANDSHAKE_RETRY_SECONDS` | Wait before asking again after an incompatible answer (default `60`) |
| `DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS` | Timeout of one desired-state long poll (default `75`; longer than the server's `mail:dns:desired_state:long_poll_seconds`, 55) |
| `DNS_CONTROLLER_STATUS_INTERVAL_SECONDS` | How often to report status while nothing changes (default `60`) |
| `DNS_CONTROLLER_SERVER_SUBJECT` | **Required.** The only token subject the internal API accepts: the server's ServiceAccount, `system:serviceaccount:<namespace>:<release>` |
| `DNS_CONTROLLER_API_AUDIENCE` | The audience the server's token must carry (default `rapidmx-dns-controller`) |
| `DNS_CONTROLLER_API_PORT` | Port of the internal API the server calls (default `8080`) |
| `DNS_CONTROLLER_LEASE_NAME` | **Required.** The Lease that makes this the single writer (`<release>-dns-controller`) |
| `DNS_CONTROLLER_LEASE_DURATION_SECONDS` | Lease duration (default `30`) |
| `DNS_CONTROLLER_LEASE_RENEW_SECONDS` | Renew interval (default `10`; at most a third of the duration) |
| `DNS_CONTROLLER_HEALTH_PORT` | Port of `/healthz` and `/readyz` (default `8081`) |
| `DNS_CONTROLLER_SERVICE_ACCOUNT_DIR` | ServiceAccount mount (default `/var/run/secrets/kubernetes.io/serviceaccount`) |
| `DNS_CONTROLLER_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error`; one JSON object per line on stdout |
| `POD_NAME` | This pod's identity in the Lease (falls back to `HOSTNAME`); set from the downward API |
| `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT` | Set by Kubernetes |

An invalid or missing value stops the controller at start-up with a `start_failed` log line naming it.

## Deployment

The controller is deployed by the RapidMX server's Helm chart when DNS publishing is enabled, which pins this image to an
exact release. There is no chart in this repository: everything the controller is configured with (its RBAC, the server
it trusts, its Lease) derives from the server release.

| Docker Image | |
| --- | --- |
| Registry | ghcr.io |
| Repository | rapidmx/dns-controller |

The pod is meant to run with `runAsNonRoot`, `readOnlyRootFilesystem: true`, all capabilities dropped, `RuntimeDefault`
seccomp and `replicas: 1` with the `Recreate` strategy.

## Development

```bash
corepack enable
yarn install
yarn build
yarn lint
yarn test          # vitest with 100% coverage thresholds
docker build -t dns-controller .
```

## License

[MPL-2.0](LICENSE)
