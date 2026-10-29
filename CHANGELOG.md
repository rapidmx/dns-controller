# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-29

### Added
- Added the RapidMX DNS controller project with the tooling of its siblings: TypeScript on Node.js 24, eslint, vitest with 100% coverage thresholds, validate.sh, MPL-2.0, CONTRIBUTING, NOTES and release notes
- Added configuration from the environment that fails start-up naming the first missing or invalid value
- Added a JSON-lines logger, and /healthz and /readyz on their own port
- Added a dependency-free Kubernetes REST client over node:https that re-reads the ServiceAccount token on every request and trusts the cluster CA for the API server only
- Added a Lease-based single writer that judges another holder's expiry by its own clock's view of the record, stops writing at once when another holder appears, and releases the Lease on shutdown
- Added the versioned internal API types (dns.rapidmx.io/v1, apiVersion and kind in every payload) with shared contract fixtures, and the unversioned start-up handshake after which an incompatible controller takes no Lease, writes nothing and reports not ready
- Added a multi-stage Dockerfile shipping only the compiled controller on a distroless, non-root Node.js 24 image
- Added the Build workflow, and a Publish workflow that pushes the image to ghcr.io only from a release tag's own green Build once every Build of its commit has finished green
- Added list-valued provider options (Cloudflare's zoneIds, rfc2136's hosts) in DnsProviderV1, as the server sends them
- Added the desired-state long poll (GET /v1/desired-state, the whole state first, then since its version with a timeout of its own, DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS), treating any other version as a change, a lower one too, and starting requests at most once a second
- Added parseDesiredState(), refusing a malformed desired state whole (an unknown provider type, record type or operation included) and keeping the last good state, retried with backoff from 1 s to 30 s
- Added status reports (PUT /v1/status, answered with StatusReportResult) after every new desired-state version and every DNS_CONTROLLER_STATUS_INTERVAL_SECONDS, never two at once, saying whether this pod holds the Lease
- Added ServiceAccountTokenVerifier verifying projected tokens with node:crypto (RS256 or ES256 with a required kid, issuer, audience, expiry and not-before with a minute of skew, a non-empty subject), against keys and an issuer fetched in-cluster, never from the advertised jwks_uri, refetched at most once a minute, and ignoring RSA keys under 2048 bits
- Added the internal API on DNS_CONTROLLER_API_PORT (8080), authenticating the server's projected token (audience DNS_CONTROLLER_API_AUDIENCE, exact subject DNS_CONTROLLER_SERVER_SUBJECT, now required) before the path with the same 403 for every failure, then answering 400, 404, 405, 413, and 503 not_ready whenever the controller may not write
- Added the reconciler: per DNS provider config one external-dns v0.23.0 Deployment <fullname>-external-dns-<uid> with the pinned image, one replica (none while disabled or missing a required credential), Recreate and the controller's hardening, and per endpoint set one DNSEndpoint <fullname>-<set id>, all by server-side apply as rapidmx-dns-controller with force, asking Controller.mayWrite() immediately before every write
- Added external-dns's exact v0.23.0 arguments: the label filter on rapidmx.io/dns-provider=<uid>, one --domain-filter per zone, --txt-owner-id, --txt-prefix=rmx-%{record_type}., --managed-record-types with MX, TXT and SRV (A, AAAA, CNAME and TXT only for rfc2136), --policy=sync, and each provider's own flags
- Added --exclude-domains for zones other configs nest under an instance's own, since every instance shares the owner id and would otherwise delete the nested config's records
- Added credentials only from the Secret <fullname>-dns-<uid>, as environment variables or a mounted file, with an ExternalSecret materializing it from OpenBao and building Azure's azure.json in its template
- Added rolling the pod on the credentials generation the Secret already holds, read as PartialObjectMetadata so no secret value reaches the controller (KubeClient.getMetadata())
- Added TXT targets in each provider's form: quoted and split into 255-byte strings for Cloudflare, Route 53 and Google, verbatim for Azure, unquoted plain values for rfc2136, leaving out an Azure TXT name with several values and an rfc2136 value with a space, semicolon or quote, which external-dns can't update or delete there
- Added ownershipEndpoint() building the TXT registry's ownership record without a TTL for the coming takeover Jobs
- Added pruning by the managed-by and instance labels, removing a deleted provider's ExternalSecret, its labelled Secret and last its Deployment two minutes after its endpoints
- Added the settings DNS_CONTROLLER_FULLNAME and DNS_CONTROLLER_RELEASE (required), DNS_CONTROLLER_EXTERNAL_DNS_IMAGE, DNS_CONTROLLER_EXTERNAL_DNS_SERVICE_ACCOUNT, DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES, DNS_CONTROLLER_RESYNC_MINUTES, DNS_CONTROLLER_OPENBAO_SECRET_STORE, DNS_CONTROLLER_OPENBAO_PATH_PREFIX and DNS_CONTROLLER_EXTERNAL_SECRETS_API_VERSION
- Added the rule that the more specific agent model assignment wins where categories overlap
- Added the status report's entries: per provider the ready replicas of its external-dns Deployment, its image and its last completed rollout, per endpoint set the DNSEndpoint's generation and the generation external-dns observed, and per operation the result the controller holds, all read for the Lease holder only with one list of Deployments and one of DNSEndpoints and left out when a list fails
- Added the optional lastRolloutAt to the v1 provider status entry
- Added the OperationLedger of operation results, pruned as a desired state arrives and cleared when the Lease is lost
- Added the OperationRunner, which runs the operations of the desired state at the end of every reconcile pass as one-shot Jobs from the pinned image (test as a dry run, takeover with a temporary DNSEndpoint of the records and their ownership records, restore with the SPF and the kept values and no ownership record) and reports each result in the status report Make a takeover wait for the regular endpoint to hold its records and a restore wait for the regular instance to have read and removed the set Fail an operation that can never run at once, and a takeover whose records the desired state's own endpoint set no longer holds Report a failed Job by the last error external-dns logged, else how its container ended, else why it never started, else the Job's own reason Keep the temporary endpoint of a Job whose creation outcome is unknown until the Job is finished or unlisted Start no operation the newest desired state no longer lists, and clear the restore waits when the Lease is lost Create the Jobs with POST without a TTL so the Job stays the durable record of the result until the server stops listing the operation Share the container and pod spec between the instances and the Jobs, move NotWriterError, isOurSecret and ENDPOINT_SET_ID out of the Reconciler and skip the operations' temporary endpoints when pruning Describe the operations in the README and the release notes Record the step in the project notes
- Added the external-dns health to the status report: parse each pod's /metrics (last sync, registry, source and provider errors, owner-mismatch records) with ExternalDnsMetrics, tested against pages recorded from the real v0.23.0 image, and scrape the Running pods of each provider at their IP with a 5 s timeout, the pod that synced last speaking for the provider Add registryErrors, sourceErrors, providerErrors and ownerMismatchRecords to the v1 provider status entry Report providerErrors as the consecutive soft errors, as v0.23.0 has no provider error counter, and ownerMismatchRecords only when the page has a series Set lastError only when the syncs are failing or every pod of the provider is unreadable, with no running count in its words so the server's row does not change on every report Read each page as a stream and refuse one over 1 MiB Pass the fetch override to the StatusCollector Describe the health in the README and the release notes Record the step and the restapi follow-ups in the project notes
- Added test/release.test.ts pinning what the image-only release is: a private project without run-time dependencies, no chart, the distroless nonroot Dockerfile that exposes only the health port, the publish workflow's gates and the contract fixtures' byte-identity with restapi's
- Added .gitattributes holding the contract fixtures as LF text so their bytes are the committed ones whatever core.autocrlf says

### Changed
- Make zoneIds a list in the shared desired-state contract fixture, byte-identical to @rapidmx/restapi's copy
- Note the server's StatusReportResult, its answer to a since ahead of its counter and the Lease-holder-only status reports for phase C3
- Send the controller back to the handshake on a 404, a 400 unsupported_api_version or an answer of another apiVersion or kind, stopping writes and handshaking again at once the first time, then at most once per handshake retry interval, and log a refused token (401/403) as such and retry it
- Log a desired-state callback that throws as desired_state_apply_failed and keep polling, so it never becomes an unhandled rejection that ends the process
- Listen on Node's default address (:: with its fallback to 0.0.0.0) for the health port and the internal API, so a single-stack IPv6 cluster reaches both
- Document the C2 settings in the README and release notes, and note C2 in NOTES
- Refuse a whole desired state with a malformed or repeated provider uid or endpoint set id, a provider without zones or with a malformed zone, a zone in two configs, or a credentials path outside dns/
- Reconcile on every new desired state, when the Lease is taken, every DNS_CONTROLLER_RESYNC_MINUTES and when a removal is due, retrying an incomplete pass from 15 s to a minute
- Release the Lease on shutdown only after the reconcile pass under way has had its request answered
- Document what the controller writes in the README and release notes, and note C3's first part in NOTES
- Record the standing agent model assignments in the project notes
- Move the agent model assignments to the top of the project notes, keeping session history at the bottom
- Update the agent model assignments to JP's revised criteria: Sonnet for general code and review, Opus for architecture, planning, investigation, security and performance, Haiku for simple operations
- Replace the ExternalSecret path with the credentials the server sends: fetch GET /internal/dns/v1/providers/:uid/credentials when a provider's Secret is missing, holds another credentials generation or has no owner among the applied Deployment, and apply the Secret owned by that Deployment with Azure's azure.json built by the controller, keeping the Secret on a failed fetch, a stale answer or an unreadable field Remove the ExternalSecret manifest, the Azure template, the OpenBao and External Secrets settings, the ExternalSecret pruning and the secretRef path check Change DnsProviderV1.secretRef to credentials with keys and generation and add the shared credentials fixtures in step with restapi Roll the pod after a Secret of unknown generation is rewritten and delete a Secret no longer needed only once the Deployment was updated, never while the image is refused Describe the credentials fetch in the README and release notes
- Send a status report when each reconcile pass ends, so the applied generations reach the server without waiting for the interval
- Read the desired state once per status report so its entries and its version agree, and send the report without entries when reading them throws
- Report lastRolloutAt only for a completed rollout of the Progressing condition, not while one is under way or after a failed one
- Move the label-selected list out of the Reconciler into listManaged
- Describe the status entries in the README and the release notes
- Record the step in the project notes
- Update the release notes' first bullet now that D1 to D5 are on main
- Record the first image's release readiness in the project notes, including the restapi follow-ups the server release must hold and providerErrors among the volatile status fields
- Settle httpsTransport on a response cut short and make timeoutMs a deadline for the whole request so a connection closed mid-body can no longer stall the Lease loop, the reconciler and the status reports
- List the Deployments before applying any instance and keep a deleted provider's zones out of the instances that cover them until its instance is removed, then apply them again at once
- Pass --rfc2136-zone once for every zone of the config with the zone option first
- Record the review round 1 fixes in the project notes

### Fixed
- Fixed the Build's coverage upload failing by installing curl and ca-certificates in the test job's slim container, which the Coveralls action downloads its reporter with

### Removed
- Removed the controller's internal API, its ServiceAccount token verifier and the settings DNS_CONTROLLER_API_PORT, DNS_CONTROLLER_API_AUDIENCE and DNS_CONTROLLER_SERVER_SUBJECT, leaving only the health port listening

[Unreleased]: https://github.com/rapidmx/dns-controller/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rapidmx/dns-controller/releases/tag/v0.1.0
