# Code review notes — rapidmx/dns-controller

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Agent model assignments (JP, 2026-10-28)

Standing rule for every AI agent working on this project (applies to all RapidMX and RapidREST repositories):

General code and review is to be performed with Sonnet 5.5 (`claude-sonnet-5-5`), with architecture, planning and
investigation performed by Opus 5.5 (`claude-opus-5-5`). The following table details specific sub-categories or
specialties.

When categories overlap, the more specific one wins: for example, Security & Performance (Opus) overrides Code and Code
Review (Sonnet) for security and performance topics.

| Kind of work | Model |
|---|---|
| Design (specs, plans, architecture proposals) | Opus 5.5 (`claude-opus-5-5`) |
| Code (implementation, refactoring, evaluation) | Sonnet 5.5 (`claude-sonnet-5-5`) |
| Code Review (finding and verifying defects in diffs or code) | Sonnet 5.5 (`claude-sonnet-5-5`) |
| Security & Performance (analysis, code review, planning) | Opus 5.5 (`claude-opus-5-5`) |
| Simple operations (bash/terminal commands, file operations, project initialization and similar mechanical tasks) | Haiku 5.5 (`claude-haiku-5-5`) |

## Standing decisions

- **Commit discipline.** Don't `git commit` unless explicitly asked for *that specific piece of
  work*. An autonomous-execution/"commit as you go" approval given for one approved plan (e.g. via
  plan mode) is scoped to that plan only — it does not carry forward to later, separate requests in
  the same session, even ones that look similar in kind (a follow-up review-and-fix pass, a
  refactor, a new feature), and even after a full review-and-fix cycle with passing tests. Default
  to leaving changes staged/unstaged and saying so; only commit automatically within the exact
  scope of a plan that was explicitly approved as autonomous. If unsure whether new work falls
  inside that scope, treat it as outside and ask.
- **Commit message style: a flat list of one-line, verb-led items — no summary/title line, no
  `-`/`*` bullet markers.** This isn't just a style preference — it's dictated by how `release`
  (`@rapidrest/cli`) actually builds `CHANGELOG.md`. `collectChangelogBullets`/
  `classifyChangelogLine` (that repo's `src/lib/release.ts`) parse `git log --pretty=format:%B` and
  treat **every non-blank line of a commit's full message as its own changelog bullet** — there is
  no subject/body distinction. A conventional "short imperative subject + blank line + prose body"
  commit therefore leaks one changelog bullet per body sentence, and a `-`/`*`-prefixed line breaks
  `classifyChangelogLine`'s verb detection (it reads the line's first whitespace-delimited word as
  the verb; a leading `-` defeats that lookup and the dash leaks into the changelog text as
  `"- - Added foo"`). Correct format:
  - No separate summary/title line — if a commit needs an overview, that overview is itself just
    one more flat line, not a heading distinct from the rest.
  - No bullet-marker prefix of any kind — write bare lines.
  - Lead each line with an imperative verb where it fits: `Add`/`Fix`/`Remove` (and `-ing` forms)
    are recognized and become `Added`/`Fixed`/`Removed` entries; `Configuring`/`Converting`/
    `Refactoring`/`Updating`/etc. become `Changed`. Anything else still works, defaulting to
    `Changed` verbatim — see `CHANGELOG_VERB_REWRITES` in that repo's `src/lib/release.ts` for the
    full map.
  - A blank line before a trailing git trailer (`Co-Authored-By:`, `Signed-off-by:`, etc.) is fine
    — trailers matching `CHANGELOG_NOISE_PATTERNS` are dropped from the changelog — but nothing
    else should follow the item list.
  This mirrors JP's standing convention across his other repos; copy this exact rule verbatim into
  each sibling repo's own NOTES.md rather than paraphrasing it, since the paraphrase is what caused
  this to be gotten wrong in the first place (see `@rapidrest/cli`'s own NOTES.md, 2026-09-07 entry,
  for the full incident writeup and the `CHANGELOG_NOISE_PATTERNS` fix that accompanied it).
- **Never bump a `package.json` `version` field, in this repo or any sibling `@rapidrest/*` repo,
  and never publish/`npm publish` one.** JP has a formal release process for that (see e.g.
  `mail-server`'s own `"version"`/`"postversion"` npm-lifecycle scripts, which sync the Helm
  chart/README and push tags — a manual version edit bypasses all of that and produces conflicts).
  This applies even when a fix in a sibling repo is otherwise done and verified: land the source
  fix, leave the version field alone, and tell JP it's ready for him to version/publish himself.
  Once he publishes, bump *this* repo's dependency constraint (e.g. `"@rapidrest/auth": "^X.Y.Z"`)
  to the version he actually published — that part is fine, since it's just declaring what this
  repo needs, not deciding a sibling repo's own release number.

- **Wait for green CI before releasing.** Push, wait for the GitHub Actions **Build** run of that
  push to succeed, and only then run `yarn release` (`npx @rapidrest/cli release`). Never tag first
  and diagnose afterwards. Releases only happen when JP asks for them.
- **Release gate.** `.github/workflows/publish.yml` publishes the image only from a release tag's own
  green Build, only when the tag points at a commit on `main`, and only once every Build of that
  commit (the `main` push and the tag push) has finished green - the same gate as activesync's
  `publish.yml` and server/postfix-bridge's `release-gate`. A failed Build on either ref blocks the
  release until it is rerun green (which triggers Publish again). `validate` stays
  `continue-on-error`.
- **Release bump levels follow upstream** (same rule as the siblings): the server chart pins this
  image; a controller release the server picks up moves the server's bump at least to the same level.

## Standing decisions specific to this repo

The design is `@rapidmx/restapi`'s `specs/dns_publishing_and_integrations.md`, §7 (and §9 for the
takeover/restore Jobs). Do not change these without JP:

- **A dedicated project and image (JP, 2026-10-27),** not the server image with another command:
  this is the one RapidMX pod that can create Deployments, Secrets and Jobs, so it carries no server
  code. Image `ghcr.io/rapidmx/dns-controller:<version>`; **no Helm chart here** - the server chart
  templates the Deployment/ServiceAccount/Role/RoleBinding and pins this image's exact version
  (`dns.controller.image.tag`), moved in lock-step by YAML key path. No Service and no NetworkPolicy
  admitting the server: the controller serves no API (7.2), only the health port the kubelet probes.
- **Zero runtime dependencies.** Kubernetes REST through `node:https` with the ServiceAccount token
  (re-read every request) and the cluster CA scoped to the API server (`src/kube/KubeClient.ts`) -
  not `@kubernetes/client-node`, not global `fetch` (no per-request CA without `undici`;
  `NODE_EXTRA_CA_CERTS` would trust the cluster CA process-wide). The server's API is called with the
  global `fetch`. Adding a runtime dependency needs a written justification here.
- **Distroless runtime** (`gcr.io/distroless/nodejs24-debian13:nonroot`): no shell, uid 65532, only
  `dist/` and `package.json` in the image; the pod runs with a read-only root filesystem, no
  capabilities. Nothing may write to disk.
- **Versioned API.** Every payload carries `apiVersion: dns.rapidmx.io/v1` and a `kind`
  (`src/api/v1.ts`); within v1 changes are additive only; a breaking change is v2. The handshake
  (`POST <base>/handshake`, `Handshake`/`HandshakeResult`) is unversioned and frozen. On a mismatch
  the controller refuses to act: no Lease, no writes, `/readyz` 503, `dns_api_incompatible` logged,
  retried every `DNS_CONTROLLER_HANDSHAKE_RETRY_SECONDS`. The JSON fixtures in
  `test/fixtures/api/v1/` are the contract shared with restapi's copy of the types: change both
  repos together.
- **Single writer.** Hold the Lease (`src/kube/LeaseElector.ts`) and check `Controller.mayWrite()`
  immediately before every Kubernetes write. Lease expiry is judged client-go style, by when this
  process last saw the record change on its own clock, never by comparing `renewTime` with the local
  clock.
- **Namespace-scoped RBAC only**, never a ClusterRole.
- **The controller serves no API (JP, 2026-10-28):** only the health port (8081) listens, and every call
  goes from the controller to the server, which verifies the controller's projected token. Nothing
  verifies tokens in this repo, so there is no JWKS fetch either.
- **Never log secrets or tokens.** The logger does not filter fields.

## Session Log

### 2026-10-27 - Phase C1 skeleton (local scaffold)

Scaffolded from postfix-bridge's tooling (eslint, vitest with 100% thresholds, tsconfig, validate.sh,
LICENSE MPL-2.0, CONTRIBUTING) and ses-bridge/activesync's Build + Publish workflow split. C1 only:
`config.ts` (env, fail-fast), `log.ts` (JSON lines), `HealthServer.ts` (`/healthz`, `/readyz` on
8081), `kube/KubeClient.ts`, `kube/LeaseElector.ts`, `api/v1.ts` (types + `expectV1`),
`api/ServerClient.ts` (handshake), `Controller.ts` (handshake -> Lease state machine), `index.ts`
(wiring, `runMain`), `main.ts` (entry). No external-dns management yet (C3+). `package.json`
`version` is `0.0.0` (never released); `private: true` (image only, not on npm).

- `tsconfig.json` needs `"types": ["node"]`: TypeScript 6 includes no `@types` packages by default,
  and unlike postfix-bridge nothing here pulls the Node types in transitively.
- The httpsTransport tests use a committed, test-only self-signed certificate
  (`test/fixtures/tls/`, EC P-256, CN "dns-controller test API server", SAN localhost/127.0.0.1,
  100-year validity). It is not a secret and is used for nothing else.
- Verified locally: `yarn lint`, `yarn build`, `yarn test` (105 tests, 100% statements/branches/
  functions/lines), `docker build`, and a smoke run of the image with `--read-only --cap-drop ALL`
  (starts as `nonroot`, `/healthz` 200, `/readyz` 200 "unavailable" with no server, exits 1 with
  `start_failed` on a missing configuration, releases cleanly on SIGTERM).

### 2026-10-27 - List-valued provider options (lock-step with restapi DNS step 3)

`DnsProviderV1.options` values may be `string[]` (Cloudflare's `zoneIds`, rfc2136's `hosts`): the
server always sends `zoneIds` as a list. The shared desired-state fixture now has `zoneIds` as a list,
changed byte-identically in restapi's `test/fixtures/dns-api/v1/` (check with `cmp`). Adopted in
C2 (below): the `StatusReportResult` kind the server answers `PUT /v1/status` with; any desired-state
version other than the controller's own is a change (the server answers a `since` ahead of its
counter at once, after a Redis reset); only the Lease holder's status report changes server rows.

## 2026-10-28: DNS publishing and Integrations

### Phase C2 - desired state, status reports, auth both ways

Against restapi a7d6e78's `BaseDnsDesiredStateRoute`; spec 7.3 "As implemented in dns-controller C2"
is the reference. The secret routes moved from C2 to C3 (next to the other Kubernetes writes).

- `src/api/ServerClient.ts`: `desiredState(since, signal)` (`GET /v1/desired-state`, own timeout
  `DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS`, 75, above the server's 55) and `reportStatus()`
  (`PUT /v1/status`, expects `StatusReportResult`). 404, `400 unsupported_api_version` or another
  `apiVersion`/`kind` -> back to the handshake; 401/403 is a refused token, retried, not a mismatch.
- `parseDesiredState()` refuses a malformed state **whole** (an unknown provider type, record type or
  operation included): dropping one entry would delete its records. Don't relax this to per-entry.
- `src/DesiredStateSync.ts`: first request without `since`; any other version is a change; at least
  1 s between requests; backoff 1-30 s keeping the last good state; reports after each new version and
  every `DNS_CONTROLLER_STATUS_INTERVAL_SECONDS`, never two at once. The poll runs detached
  (`void this.poll()`), so `onDesiredState` (C3's reconcile) is wrapped: a throw is logged
  `desired_state_apply_failed` and the poll goes on - an escaped exception would be an unhandled
  rejection, which ends a Node 24 process. Keep anything C3 adds inside the loop from throwing.
- `src/auth/ServiceAccountTokenVerifier.ts`: RS256/ES256, `kid` required, issuer/audience/exp/nbf with
  60 s skew, non-empty subject; RSA keys under 2048 bits dropped (`node:crypto` imports an empty
  modulus). Keys from in-cluster `/openid/v1/jwks`, never the advertised `jwks_uri`; refetch at most
  once a minute.
- `src/InternalApiServer.ts` (8080): authenticate before routing (same 403 for everything, exact
  subject `DNS_CONTROLLER_SERVER_SUBJECT`, required), then 400/404/405/413, then 503 `not_ready`
  unless `mayWrite()`. No routes until C3.
- `HealthServer`/`InternalApiServer.listen()` take no host by default (Node's `::` with its fallback
  to `0.0.0.0`), so a single-stack IPv6 cluster reaches both ports. Don't pin `0.0.0.0` (IPv4 only)
  or `::` (fails where the pod has no IPv6). The IPv6 tests skip where the host has no `::1` (CI's
  container may not).
- The shared fixtures in `test/fixtures/api/v1/` were not changed (still byte-identical to restapi's).
  The spec edits for C2 first went out inside restapi c8da9da (a meet-plugin commit); the dates and the
  review fixes were corrected in a later restapi commit naming the C2 spec update.

### Phase C3, first part - external-dns Deployments, ExternalSecrets, DNSEndpoints

Spec 7.4 "As implemented in dns-controller C3" is the reference. Still to come in C3: the status report's
providers/endpoints/operations entries and `PUT`/`DELETE /v1/secrets/:path`.

- `src/reconcile/manifests.ts` (pure builders) and `src/reconcile/Reconciler.ts` (apply, prune, schedule). The
  external-dns flags were checked against v0.23.0's `pkg/apis/externaldns/types.go`; Cloudflare's property really is
  `cloudflare/proxied` (`annotations.CloudflareProxiedProperty`), and Azure's tenant has no flag (only `azure.json`).
- `quoteTxtTarget()` splits values over 255 bytes into `"..." "..."` (DKIM keys); not proven on Cloudflare by the
  spike (short values only): the e2e's DKIM rotation checks it. Don't drop the split: Route 53 needs it.
- **TXT form is per provider (`txtTargets()`), checked in v0.23.0's providers:** quoted for Cloudflare/Route 53/Google.
  Azure writes and reads `Targets[0]` verbatim (`provider/azure/azure.go`), so its value goes unquoted and unsplit, and a
  TXT name with several values is left out. rfc2136 writes zone-file text but reads back bare character-strings and
  removes an old value by parsing what it read (`RemoveRecord`: `;` starts a comment, spaces split strings), so a value
  with a space, `;`, quote, `\`, `(`, `)`, `$`, `@`, non-ASCII or over 255 bytes could never be updated or deleted: it
  is left out (like MX/SRV), and plain values go unquoted so they read back equal (`Targets.Same` is `EqualFold`). So on
  rfc2136 only the ownership-verification TXT is published; SPF/DKIM/DMARC need the server to show them manual.
- **Shared owner id + overlapping zones:** every instance has the same `--txt-owner-id` and `--policy=sync`, so two
  instances seeing one zone delete each other's records. A zone of another config nested under one of this config's
  zones goes in `--exclude-domains` (`nestedZones()`; `DomainFilter.Match` applies the exclusion to zones and plan
  records alike); the same zone in two configs (enabled or not: a disabled config's records would be deleted by the
  other) refuses the whole state. Per-instance owner ids were the alternative: they change restapi's conflict detection
  and C4's ownership records, so not without JP.
- `unpublishable()` also refuses a provider without zones (no `--domain-filter` = every zone the token reaches), a zone
  that isn't a lowercase name of two or more labels, and a `secretRef` whose path isn't `dns/<segments>` or whose keys
  aren't `[A-Za-z0-9_-]` (the path goes into the ExternalSecret's `remoteRef.key`).
- `Reconciler.stop()` resolves when the pass under way ends and `write()` refuses once stopping; `index.ts` awaits it
  before `controller.stop()` releases the Lease, so no request lands after a successor took it.
- Every write goes through `write()`, which asks the gate (`Controller.mayWrite()`) right before the call; a lost gate
  ends the pass (`not_writer`). Per-object failures go through one `attempt()` helper: logged, pass `incomplete`, retried
  15 s doubling to 60 s. The Lease's `onAcquired` wakes the reconciler.
- The pod-template annotation is the generation the **Secret** holds (read via `getMetadata()`, `PartialObjectMetadata`,
  so no values reach the controller), not the desired one: rolling before External Secrets refreshed would start the
  pod with old credentials. The Role therefore needs `get` on secrets without `resourceNames` (spec 7.6).
- Deleted providers: the ExternalSecret, Secret, then Deployment go 2 min after their endpoints (in-memory clock; a
  restart waits again), never while an endpoint delete or any list failed; the Secret only with our managed-by,
  `secret-kind: dns` and provider labels. The Deployment goes **last**: with the Kubernetes backend it is the only mark of
  a deleted provider (nothing lists Secrets). Residual: a Kubernetes-backend Secret whose Deployment was deleted by hand
  (or never created) is not found; the coming secret write could give it an ownerReference.
- Kept on review: `get`/`delete` on Secrets without `resourceNames`. The per-provider names aren't fixed, the spec's own
  7.6 already has the Kubernetes-backend secret write check labels before changing one (which needs `get`), and the
  Role's create-Deployment/Job rights already let it read any namespace Secret by mounting it. Only names built from a
  validated uid are ever read.
- Image pin: the Deployment always runs `DNS_CONTROLLER_EXTERNAL_DNS_IMAGE`; the desired image must equal it or its tag
  (the server's default has no digest). Another image changes no Deployment.
- For server step 8 (chart): the new env vars (`DNS_CONTROLLER_FULLNAME`, `_RELEASE` required; OpenBao store and
  prefix together), and the Kubernetes-backend secret write must produce Azure's `azure.json` (the ESO template does it
  for OpenBao).
- Spec edits (4.2 TXT splitting and per-provider form, 7.2 C3 status, 7.4/7.5/7.6 "as implemented") went out alone in
  restapi 68444dd, leaving another track's uncommitted move of the auth-server paragraph unstaged.
- Restapi follow-ups this asks for: refuse a zone already in another config (409); assign a domain only to the most
  specific covering config; mark rfc2136's non-plain TXT values and Azure's multi-value TXT names manual
  (`kind_unsupported`); refuse or limit the apex TXT opt-in on Azure.
- Review resolved (7 findings): per-provider TXT form, nested-zone exclusion and same-zone refusal, zone/path/key
  validation, stop() draining before the Lease is released, removal order; the broad Secret `get` kept (above).
- Verified: `yarn lint`, `yarn build`, `yarn test` (329 tests, 100% statements/branches/functions/lines) from D:;
  `tsc -p tsconfig.test.json` still has the 27 errors in untouched C2 test files.

## 2026-10-28: DNS publishing and Integrations (encrypted configuration)

Against the reworked spec (restapi `specs/dns_publishing_and_integrations.md`, 18.2); steps D1 to D3 come before the
first release.

### D1 - the controller's internal API removed

- Deleted `src/InternalApiServer.ts` (port 8080), `src/auth/ServiceAccountTokenVerifier.ts`, the settings
  `DNS_CONTROLLER_API_PORT`, `DNS_CONTROLLER_API_AUDIENCE` and `DNS_CONTROLLER_SERVER_SUBJECT` (the last was required, so
  a controller no longer needs it set; the three are simply ignored if still set), their tests, the `apiPort` of
  `startController()`'s `Running`/`Overrides` and its `started` log line, and EXPOSE 8080 in the Dockerfile. README
  and release notes describe only the health port.
- The C2 entry above still describes what was built; it is history. `test/helpers/ipv6.ts` stays (HealthServer's test).
- Tests first: `config.test.ts` (the old settings ignored and absent from the config) and `index.test.ts` (nothing
  listens on the old API port, no `apiPort`) failed, then passed after the removal.
- Review resolved (2 findings): the stale Service/NetworkPolicy standing decision corrected; the JWKS assertion could not
  fail (the verifier fetched keys lazily, inside `verify()`, only for a request to the API port) so it was dropped; the
  closed-port check is the guard.

### D2 - credentials from the server (C3 rework)

- Removed the `ExternalSecret` path: its manifest and Azure template, `OpenbaoSettings` and the three OpenBao and External
  Secrets settings (a chart that still sets them is ignored, not refused), the pruning of ExternalSecrets and the
  `secretRef` path check (now a credential field-name check). `DnsProviderV1.secretRef` became
  `credentials?: { keys, generation }` in `src/api/v1.ts`; the three fixtures are byte-identical with restapi's.
- `ServerClient.providerCredentials(uid)` calls `GET /v1/providers/:uid/credentials`. The Reconciler takes a `server`
  option and, when a provider's Secret is missing, holds another generation, has none, or is owned by another Deployment
  than the one just applied, fetches and applies it (labels, annotation, ownerReference with `apiVersion`, `kind`, `name`
  and `uid` only; Azure's `azure.json` built by `credentialsSecret()`). Order: Deployment, Secret, Deployment again to roll
  the pod. The existing Secret is kept on a failed fetch, an answer about another provider or at another generation, or an
  unreadable or missing field. A Secret without this controller's three labels is never written over or run on.
- Beyond the spec text (now in 7.3/7.4): any answer generation other than the listed one writes nothing; with the image
  refused the Secret is written only for an instance that exists (`credentials_deferred`); the 404 of the credentials route
  is a plain failed fetch.
- Review resolved (3 findings): a Secret whose generation annotation is gone is stamped `-1` on the first Deployment apply,
  so the apply after the write rolls the pod (it used to stamp the wanted generation and roll on the old data, once);
  a no-longer-needed Secret is deleted only after a Deployment apply (`secret_delete_deferred` while the image is refused,
  since the Deployment still refers to it); a Secret whose owner uid is not the applied Deployment's is written again
  (only checked when the Deployment was applied this pass; with the image refused nothing recreates the Deployment).
- Tests first, each failing without its fix; `yarn build` and `yarn test` pass (334 tests, 100% coverage). Spec text in
  restapi 7bd4bf3.

### D3 - status entries (the rest of C3)

- New `src/reconcile/StatusCollector.ts` (the entries), `OperationLedger.ts` (in-memory results of operations, fed by D4's
  runner) and `listManaged.ts` (the label-selected list, shared with the Reconciler). `DesiredStateSync` takes an
  `entries(state)` option, asked only of the Lease holder (the server ignores any other pod's); a pod without the Lease
  sends just itself. One list of Deployments and one of `DNSEndpoint`s per report (Role unchanged); a failed list leaves
  its entries out with `status_entries_failed`, never reporting what wasn't read.
- Per provider: ready replicas (0 when the Deployment is missing, has no status or its `observedGeneration` is behind),
  image (the `external-dns` container's), `lastRolloutAt`. Per endpoint set: `metadata.generation` and
  `status.observedGeneration` (written when external-dns *reads* the resource); a set without a `DNSEndpoint` is left out.
  `lastError`, `lastSyncAt` and the metrics are D5's.
- Beyond the spec text: `lastRolloutAt?: string` is an additive optional field of the controller's `ProviderStatusV1`
  (restapi's `DnsProviderStatus.lastRolloutAt` exists, the v1 entry had none). **Open restapi follow-up:** its
  `ProviderStatusV1`, `parseStatusReport` and `applyProviderStatus` must carry and store it, and the shared
  `status-report.json` fixture gains the field in both repos together; until then the console's "last rollout" stays
  empty. Operations are plumbing only until D4 (no operation is reported `failed` for being unsupported: a finished result
  is never reopened, so D4 could not run an operation queued meanwhile).
- Review resolved (6 findings): a report follows every reconcile pass (`Reconciler` `onPass`, wired to `sync.report()`,
  not after a pass refused for lack of the Lease), since the report sent as a state arrives reads the cluster before the
  pass applied it; a report reads `this.current` once, so its entries and `desiredStateVersion` agree; `lastRolloutAt` is
  the `Progressing` condition's last update only for status `True` and reason `NewReplicaSetAvailable` (the Deployment
  controller also moves it during a rollout and when one fails); the ledger is pruned as a state arrives (in `index.ts`,
  never by a report, which may be for an older state) and cleared when the Lease is lost; `entries` throwing is caught in
  `report()` (`status_entries_failed`, report without entries), since the reports run detached.
- **D4 preconditions:** record a result only for an operation in the latest state; the ledger is cleared on Lease loss,
  so an operation still listed after re-acquiring is run (or its result recorded) again.
- Tests first, each failing without its fix; `yarn build` and `yarn test` pass (374 tests, 100% coverage). The spec text
  (7.2, 7.3, 7.4, 7.7, 18.2) went out in a separate restapi commit.

### D4 - operations (C4)

Spec 9.3, "As implemented in dns-controller C4", is the reference. New `src/reconcile/OperationRunner.ts`, run by the
Reconciler at the end of every pass that published the state (after apply and prune, not while the image pin refuses it,
via `ReconcilerOptions.operations`; `NotWriterError` moved to its own file for the two to share). `manifests.ts` gained
`operationJob()`, `operationEndpoint()`, `operationName()`, `endpointEntries()` (what `dnsEndpoint()` now uses too) and
`isOurSecret()` / `ENDPOINT_SET_ID` (moved out of the Reconciler); `StatusCollector` exports `readyReplicas()`.

- **Names and labels:** Job and temporary endpoint are `<fullname>-op-<16 hex of sha256(operation id)>` (an id can be any
  text; the id itself is in the annotation `rapidmx.io/dns-operation-id`). Both carry `managed-by`, `instance` and
  `rapidmx.io/dns-operation`, **never** `rapidmx.io/dns-provider`: the instances' `--label-filter` and Deployment selectors
  must not see them. `Reconciler.prune()` skips endpoints with the operation label (the runner owns them).
- **Jobs are POSTed** (`kube.create`), not applied: the Role has `create/get/list/delete` on Jobs and no `patch`. Deleted with
  `?propagationPolicy=Background` (the API's default for Jobs orphans the pods). Pod failure reasons come from one list of
  pods by `job-name` (`pods get/list` is in the Role): the termination message is the log tail
  (`FallbackToLogsOnError`), read for its last JSON `error`/`fatal` `msg`.
- **Waits are the point of the design:** a takeover starts only once the regular `DNSEndpoint` holds each name and type
  (else the regular `--policy=sync` instance deletes what it finds owned and unwanted); a restore only once the regular
  endpoint no longer holds the set (or is gone), the instance has a ready replica, and 2 min have passed since first seeing
  both (in memory, like a deleted provider's removal; reset when either changes). The controller cannot read the provider's
  records, so there is no check that the ownership record is really gone. A disabled provider's restore waits until it is
  enabled. All operations wait for the provider's Secret (labels + generation). Waiting is reported `running` with a message
  (the server keeps an old message when a report has none, so every `running` report carries one).
- **The Job is the durable record:** kept until the server stops listing the operation (no `ttlSecondsAfterFinished`: a TTL could
  drop a result the server had not taken yet and run the operation again), so a restart or a re-acquired Lease (ledger cleared) reads the result from the Job instead of re-running.
  The temporary endpoint is deleted as soon as its Job is finished, or when no Job uses it. Results are recorded only while
  `mayWrite()` and only for an operation the newest state (`sync.desiredState`) still lists (the D3 precondition).
- **Fails at once** (final, never reopened): provider missing or missing a required credential, a takeover/restore without
  a valid `endpointSetId` (it becomes part of a request path: `ENDPOINT_SET_ID`) or records, a takeover whose set belongs to
  another provider, nothing the provider can keep. A Job that failed (`backoffLimit: 0`, deadline 300 s) fails the operation.
- No new setting. Open for D5/server: nothing in the status report says the restored set is live (the server's lookup does).
- Tests first: the new manifests, runner, Reconciler and index tests failed on the missing modules, then passed;
  `yarn build`, `yarn lint` and `yarn test` pass (439 tests, 100% coverage) from D:. The spec text (7.2, 9.3, 18.2) is
  uncommitted in restapi until stage 3.
- Review resolved (6 findings):
  - the temporary endpoint is in use from the first write of a launch, so a Job creation whose answer is lost (timeout,
    504) no longer has its endpoint deleted at the end of the run; it goes once the Job is finished or unlisted. Not done,
    deliberately: checking the endpoint's `observedGeneration` before reporting success, since with the endpoint kept
    until the Job finished, a finished Job did run with it present, and the check would fail operations on a status
    update external-dns merely logs.
  - a takeover whose names and types the state's own endpoint set lacks fails at once ("no longer holds the records"); it
    waits only while the state has them and the live endpoint doesn't yet.
  - a restore's clock starts only once the regular endpoint's `status.observedGeneration` reached its
    `metadata.generation` (when the endpoint exists) as well as the set being absent and a ready replica. Still no proof
    of a successful sync until D5's `lastSyncAt`; the server's live check (9.5, step 3) is not optional.
  - failure reasons: an error/fatal log entry, else the container's terminated reason and exit code (`OOMKilled (exit code
    137)`), else the waiting reason, else the Job condition's reason and message; a log line that is not an error is never
    the reason.
  - an operation the newest state no longer lists is not launched (`latest()` is asked before `launch()`).
  - `OperationRunner.forget()` clears the restore clocks when the Lease is lost (`onLost`, with the ledger).
  - `ttlSecondsAfterFinished` dropped from the Job (see above). 446 tests, 100% coverage. Spec 9.3/9.5 updated in restapi.

### D5 - health (C5)

Spec 7.7, "As implemented in dns-controller D5", is the reference. New `src/reconcile/ExternalDnsMetrics.ts` (pure parser of the
Prometheus text page) and the pod scrape in `StatusCollector` (one more list, of the managed pods, after the Deployments; the
Role already had `pods get/list`; no new setting; `fetch` and `metricsTimeoutMs` are options of the collector, `index.ts`
passes `overrides.fetch`).

- **The page is real:** `test/fixtures/external-dns/v0.23.0/metrics-synced.txt` and `metrics-provider-failing.txt` are unedited
  `/metrics` answers of the real `registry.k8s.io/external-dns/external-dns:v0.23.0` image (docker is on this machine), run with
  `--source=crd` against a stand-in Kubernetes API and `--provider=webhook` against a stand-in webhook (the `fake` source
  names records at random and the `connector` source speaks gob). Re-record the same way if the pinned version moves.
- **Metrics:** `lastSyncAt` = `external_dns_controller_last_sync_timestamp_seconds` (0 until the first sync: left out),
  `registryErrors` = `external_dns_registry_errors_total`, `sourceErrors` = `external_dns_source_errors_total`,
  `providerErrors` = `external_dns_controller_consecutive_soft_errors`, `ownerMismatchRecords` = the sum of
  `external_dns_registry_skipped_records_owner_mismatch_per_sync`.
- **Beyond the spec text:** v0.23.0 has no provider error counter. A provider that fails to list or change records is a soft
  error: it is also counted in `registry_errors_total` and retried (any other error exits the process). Hence the consecutive
  soft errors gauge for `providerErrors`.
- **The owner-mismatch metric never appeared** in the real runs (a TXT owned by `someone-else`, a record without any TXT, with
  the name desired or not; `Skipping endpoint ... because owner id does not match` is logged, the series is not exposed), though
  its name, help text and `foreign_owner`/`record_type` labels are in the binary. So it is reported only when the page has a
  series, never as 0 (0 would claim "no conflicts"). The parser test for the sum uses a series written by hand, and says so.
  Worth another look with a real provider before relying on it.
- `lastError` is set only for what the metrics prove: consecutive soft errors above 0, or every pod of the provider unreadable
  (`ECONNREFUSED`, `timed out`, `HTTP 500`, `not an external-dns metrics page`, `page too large`). No pod, no error (ready
  replicas say it). The failing-syncs wording carries no count (that is `providerErrors`): restapi rewrites the provider's row
  only when its status changed, and a running count would change it on every report.
- Pods scraped: `Running`, not terminating, labelled `external-dns` + the provider uid (an operation's pod has neither), with an
  address `net.isIP` accepts (it goes into a URL). Side by side, 5 s timeout over the body too; the pod that synced last speaks
  for the provider. The body is read as a stream and refused above 1 MiB (`page too large`; a real page is ~20 KB): the
  pods run third-party code with the provider's credentials and the timeout bounds time, not bytes.
- **Churn gate for restapi:** `applyProviderStatus` skips the row write only when the status other than `reportedAt` is
  unchanged, and `lastSyncAt` (already stored) now moves with every sync (external-dns `--interval=1m`), so each report would
  version-bump the DnsProvider row and 409 an admin's edit. Before D5 ships against restapi, its comparison must leave out the
  volatile fields (`lastSyncAt`, `registryErrors`, `sourceErrors`, `providerErrors` and `reportedAt`) so they refresh on the 5-minute cadence.
- **Open restapi follow-up (with D3's `lastRolloutAt`):** `ProviderStatusV1`, `parseStatusReport` and `applyProviderStatus` carry
  none of `registryErrors`, `sourceErrors`, `providerErrors`, `ownerMismatchRecords`; the shared `status-report.json` fixture is
  unchanged (it has `lastSyncAt`) until restapi has them, then both change together.
- Tests first (the new parser/collector/index tests failed on the missing module and options, then passed); `yarn lint`,
  `yarn build` and `yarn test` pass (487 tests, 100% coverage) from D:. Spec text uncommitted in restapi until stage 3.

### Releases - readiness of the first image (no release made)

Spec 18.2, "Releases", is the reference. The spec planned the first release after D1 to D3 and D4/D5 later, but D1 to D5 are all
on `main`, so the first release carries all five (the spec now says so). Nothing runs the controller until server step S9 pins it.

- `test/release.test.ts` pins what the release is: private project, no run-time dependencies (no `node_modules` in the image), no
  chart, a Dockerfile whose last stage is the distroless `nonroot` runtime with only `package.json` and `dist` copied and only
  8081 exposed, `CMD ["dist/src/main.js"]` with no ENTRYPOINT (node is PID 1), the publish gate (tag on `main`, every Build green,
  tag equal to the package.json version, a prerelease never `latest`), and the contract fixtures byte-identical with restapi's
  (`it.runIf` the sibling `../restapi` is checked out; CI has this repo alone, so locally only). The tests pass on the existing
  files, since the image was already built this way; each was shown to fail on the change it guards (an added `EXPOSE 8080`, one
  byte added to a fixture).
- Checked by hand: `docker build --pull .` succeeds, and the image run with `--read-only --cap-drop ALL`, the ServiceAccount
  files mounted and no server, starts as `nonroot` (`started` with version `0.0.0`), `/healthz` and `/readyz` answer 200,
  `dns_api_unavailable` is retried with backoff (no projected token), SIGTERM ends it with exit 0. A missing setting ends it with
  exit 1 and `start_failed`.
- Release notes: the first bullet no longer says "not yet released" or "does not manage external-dns yet".
- **For the release and S9:** `package.json` stays `0.0.0` until JP asks for the release. The settings S9 must set are
  `DNS_CONTROLLER_SERVER_URL`, `DNS_CONTROLLER_FULLNAME`, `DNS_CONTROLLER_RELEASE`, `DNS_CONTROLLER_LEASE_NAME` (required); the
  projected token is read from `/var/run/secrets/rapidmx/internal-dns/token` (audience `rapidmx-internal-dns`).
- **Open in restapi before the server release that pins this image** (D3, D5): `ProviderStatusV1`, `parseStatusReport` and
  `applyProviderStatus` carry `lastRolloutAt`, `registryErrors`, `sourceErrors`, `providerErrors` and `ownerMismatchRecords`, the
  shared `status-report.json` gains them in both repos together, and the provider row's change comparison leaves out the volatile
  fields (`lastSyncAt`, `registryErrors`, `sourceErrors`, `providerErrors`, `reportedAt`), else every status report version-bumps the row. `providerErrors`
  is external-dns's consecutive soft errors, which rises by one on every failing sync, so it is volatile like the other two counts; a provider
  that starts or stops failing still changes the row through `lastError`.
- **Review of the step, resolved:**
  - `providerErrors` was missing from the volatile set in the restapi spec (7.7, 18.2) and here: added (restapi `f9fd12d`). `lastError` needs no change:
    it holds no count, and for unreadable pods it names the pod and the reason, so it changes when the cause does (a pod restarted, timeout
    becoming ECONNREFUSED), not with every report; a flap between two reasons is a state change worth a row version, not churn.
  - The fixture byte-comparison depended on `core.autocrlf` (Git for Windows sets it): `.gitattributes` now holds `test/fixtures/api/** text eol=lf`
    here and `test/fixtures/dns-api/** text eol=lf` in restapi (`814ed9c`), so the working-tree bytes are the committed ones; the test asserts the
    attribute and that no fixture holds a CR (it runs in CI too, where the sibling comparison is skipped).
  - The publish-gate tests now read each job of `publish.yml` apart: the check job's conditions, no `continue-on-error`, `needs: check` and no `if:`
    on the publishing job, the tag/version comparison before `docker login` and `docker push`, `latest` only inside the non-prerelease branch.
    Each was shown to fail on the change it guards (dropping `needs: check`, adding `continue-on-error`, moving the comparison, dropping the
    attribute, a CRLF fixture).

## 2026-10-28: DNS review round 1 fixes

- **`httpsTransport` always settles (finding 113).** A server that cut the connection after the answer's headers left the
  promise pending for good (`res` has no error listener, `end` never comes, the socket's idle timeout can't fire on a closed
  socket), which stalled the Lease loop, the reconciler, the status reports and `stop()` while `/healthz` stayed green. Now
  `res` `close` before `complete` rejects ("the response was cut short"), and `timeoutMs` is a deadline for the whole request
  (a timer destroying the request, cleared when the promise settles) instead of the socket's idle timeout, which a server
  trickling bytes never reaches. Tests use a real TLS server that destroys / ends the socket mid-body and one that trickles.
- **A deleted provider's zones stay out of the instances that now cover them (finding 114).** The instance of a deleted config
  runs for `providerRemovalDelayMs` and, sharing the owner id, deletes every record in its zones, including the ones the
  parent's instance publishes there once the server moves the domain. A pass now lists the Deployments first
  (`goneInstances()`: the zones are the `--domain-filter`s of the instance's own container, read from the cluster, so a new
  Lease holder or a restart knows them too), and `nestedZones()` takes them as `pendingZones` (a zone equal to one of the
  instance's own as well: a new config with a deleted config's zone). When the instance is removed and its zones had been
  excluded, the pass sets `again`, so the instances are applied without the exclusion at once rather than at the resync. The
  Deployments are listed before anything is applied, and no instance is applied when they can't be listed (nothing is guessed;
  the endpoints still are); `prune()` takes the same list. Operation Jobs keep `nestedZones(provider, providers)`: they run the
  noop registry with `upsert-only` and delete nothing. Deliberately left: while the old instance runs, the domain moved to the
  parent is not published (it was already dark: the old instance removes its records once its endpoints go).
- **rfc2136 gets every zone (finding 115).** `--rfc2136-zone` is passed once per zone of the config, the `zone` option first
  (external-dns lists by AXFR and updates only the zones it is given, and sends a change under none of them to the root
  zone). The restapi rule "zone must be one of zones" stays; its spec needs an "As implemented" note (not done here: another repo).
- **Review of the round 1 fixes, two low findings, nothing changed.**
  - *A moved domain has a gap while the old instance runs.* Deliberate, and not new: the old instance removes the domain's records
    once its endpoints go, the same as before the exclusion existed (restapi's spec says a reassignment briefly removes them, and the
    console warns). The exclusion only stops the two instances fighting over the records. `providerRemovalDelayMs` is what lets the
    old instance clean up; skipping it when a remaining provider covers the zone would rest on how external-dns v0.23.0 behaves with a
    shared owner id, which can't be tested here, so it is left. If the gap proves too long in live use, that is the place to shorten it.
  - *No instance is applied while the Deployments can't be listed.* Kept. Which provider has a deleted instance nested under it is
    exactly what the list tells; applying on a guess brings the flapping of 114 back. A list the API server refuses means its writes
    are failing as well, and the pass is retried with backoff; the DNSEndpoints are still applied meanwhile.
