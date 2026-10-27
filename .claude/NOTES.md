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
  templates the Deployment/ServiceAccount/Role/RoleBinding/NetworkPolicy/Service and pins this
  image's exact version (`dns.controller.image.tag`), moved in lock-step by YAML key path.
- **Zero runtime dependencies.** Kubernetes REST through `node:https` with the ServiceAccount token
  (re-read every request) and the cluster CA scoped to the API server (`src/kube/KubeClient.ts`) -
  not `@kubernetes/client-node`, not global `fetch` (no per-request CA without `undici`;
  `NODE_EXTRA_CA_CERTS` would trust the cluster CA process-wide). The server's API is called with the
  global `fetch`. JWT verification (phase C2) uses `node:crypto`. Adding a runtime dependency needs a
  written justification here.
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
- **Namespace-scoped RBAC only**, never a ClusterRole. JWKS for token verification is fetched
  in-cluster from `https://kubernetes.default.svc/openid/v1/jwks` (the advertised `jwks_uri` on k3s
  is the node's public IP:6443); the default issuer-discovery binding grants it to every
  ServiceAccount (confirmed on k3s v1.36.4).
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
