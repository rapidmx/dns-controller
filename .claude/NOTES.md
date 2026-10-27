# Code review notes — rapidmx/dns-controller

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

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
