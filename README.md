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

Phase C3, first part: on top of C1 (configuration, structured logging, health endpoints, the Kubernetes REST client,
the Lease-based single writer, the start-up handshake) and C2 (the desired-state long poll, status reports, the projected
token on its calls), the controller reconciles the desired state into external-dns Deployments, `ExternalSecret`s and
`DNSEndpoint`s. Its status reports don't list them yet, and the secret routes for the Kubernetes-Secret backend are still
to come.

| Phase | Scope | State |
| --- | --- | --- |
| C1 | Skeleton: configuration, logging, health, Kubernetes client, Lease, `v1` types and the handshake | done |
| C2 | Desired-state long poll, status reports, projected-token authentication on its calls | done |
| C3 | Reconcile: external-dns Deployments, `DNSEndpoint`s, `ExternalSecret`s (done); per-provider and per-endpoint status, secret writes for the Kubernetes-Secret backend (planned) | in progress |
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
- **Authentication.** The controller presents a projected ServiceAccount token (audience `rapidmx-internal-dns`) on
  every call to the server, which verifies it. Nothing authenticates to the controller: it serves no API of its own and
  listens only on the health port, so every call goes from the controller to the server.

## What it writes

All in its own namespace, with server-side apply as `rapidmx-dns-controller`, only while it is compatible with the server
and holds its Lease (checked before every write), and labelled `app.kubernetes.io/managed-by: rapidmx-dns-controller` and
`app.kubernetes.io/instance: <release>`, which is how it finds what to delete.

- **Per DNS provider config:** the Deployment `<fullname>-external-dns-<uid>`: external-dns with exactly the pinned
  image (`DNS_CONTROLLER_EXTERNAL_DNS_IMAGE`; a desired state naming another changes no Deployment), one replica (none
  while the config is disabled or its credentials are incomplete), `Recreate`, non-root, read-only, no capabilities,
  reading only the `DNSEndpoint`s labelled `rapidmx.io/dns-provider: <uid>` with the TXT registry
  (`--txt-owner-id` from the server, `--txt-prefix=rmx-%{record_type}.`, `--policy=sync`, MX, TXT and SRV managed, but
  never MX or SRV for rfc2136), kept out of any zone another config has nested under its own (`--exclude-domains`). Its
  credentials come only from the Secret `<fullname>-dns-<uid>`, as environment
  variables or a mounted file, never as arguments. With OpenBao, an `ExternalSecret` of the same name has External
  Secrets write that Secret. The pod template carries the credentials generation the Secret already holds, so new
  credentials roll the pod once they are there.
- **Per endpoint set** (a domain's records, a provider's share of the deployment's hosts): the `DNSEndpoint`
  `<fullname>-<set id>`, TXT targets in the form the provider keeps them (quoted, long values in 255-byte strings, for
  Cloudflare, Route 53 and Google; verbatim for Azure, which keeps only one value per name; unquoted for rfc2136, which
  can't update or delete a value with a space, `;` or quote, so such a value is left out there), Cloudflare's
  A/AAAA/CNAME unproxied.
- **Pruning:** a `DNSEndpoint` the desired state no longer has is deleted. A deleted provider's `ExternalSecret`,
  Secret and Deployment go two minutes after its endpoints, so its instance can remove the records it owns; the Secret
  only when its labels say it is that provider's, and the Deployment last.

A desired state with a provider config without zones, a zone in two configs, or a credentials path outside `dns/` is
refused whole: nothing is written.

It reconciles on every new desired state, when it takes the Lease, every `DNS_CONTROLLER_RESYNC_MINUTES`, and again
(15 s, backing off to a minute) after a pass that left something undone. On shutdown it lets the pass under way finish
its request before releasing the Lease. It reads Secrets' metadata only, never their values.

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
| `DNS_CONTROLLER_LEASE_NAME` | **Required.** The Lease that makes this the single writer (`<release>-dns-controller`) |
| `DNS_CONTROLLER_FULLNAME` | **Required.** The server release's full name, which names every object the controller writes |
| `DNS_CONTROLLER_RELEASE` | **Required.** The Helm release, the `app.kubernetes.io/instance` label of those objects |
| `DNS_CONTROLLER_EXTERNAL_DNS_IMAGE` | The only external-dns image it runs (default `registry.k8s.io/external-dns/external-dns:v0.23.0`; the chart pins it by digest). The desired state's image must be this reference, or its tag when this one adds a digest |
| `DNS_CONTROLLER_EXTERNAL_DNS_SERVICE_ACCOUNT` | The ServiceAccount external-dns runs as (default `<fullname>-external-dns`) |
| `DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES` | The external-dns container's `resources`, as JSON (default none) |
| `DNS_CONTROLLER_RESYNC_MINUTES` | How often the whole desired state is reconciled again (default `10`) |
| `DNS_CONTROLLER_OPENBAO_SECRET_STORE` | With OpenBao: the release's `SecretStore` (`<fullname>-openbao`); set with the next one or not at all |
| `DNS_CONTROLLER_OPENBAO_PATH_PREFIX` | With OpenBao: the integrations prefix in the KV mount (`<fullname>/integrations`) |
| `DNS_CONTROLLER_EXTERNAL_SECRETS_API_VERSION` | `external-secrets.io/v1` (default) or `external-secrets.io/v1beta1` |
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
