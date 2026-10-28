import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// What a release of this repository is (spec 18.2, "Releases"): the container image alone, built from a project with no
// run-time dependencies, serving only the health port, whose v1 contract fixtures are the server's. These read the files
// the release is made from, so a change that would make the image something else fails here, before a tag does.

const root: string = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");
const pkg = JSON.parse(read("package.json"));

describe("the image-only release", () => {
    it("is a private project, so nothing can be published to npm", () => {
        expect(pkg.name).toBe("dns-controller");
        expect(pkg.private).toBe(true);
    });

    it("has no run-time dependencies, so the image carries no node_modules", () => {
        expect(pkg.dependencies).toBeUndefined();
        expect(pkg.optionalDependencies).toBeUndefined();
        expect(pkg.peerDependencies).toBeUndefined();
    });

    it("ships no Helm chart: the server's chart templates the Deployment and pins the image", () => {
        const entries: string[] = readdirSync(root);
        expect(entries).not.toContain("helm");
        expect(entries).not.toContain("Chart.yaml");
        expect(existsSync(`${root}.github/workflows/publish.yml`)).toBe(true);
        expect(read(".github/workflows/publish.yml")).not.toMatch(/helm|npm publish|yarn npm publish/i);
    });

    describe("Dockerfile", () => {
        const dockerfile: string = read("Dockerfile");
        const runtime: string = dockerfile.slice(dockerfile.indexOf("AS runtime"));

        it("ends in the distroless, non-root runtime stage, so a plain docker build produces the published image", () => {
            expect(dockerfile.match(/^FROM .*$/gm)).toEqual([
                "FROM node:24-trixie-slim AS builder",
                "FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime",
            ]);
            expect(runtime).toMatch(/^USER nonroot$/m);
        });

        it("copies only package.json and dist into the runtime and listens on the health port alone", () => {
            expect(runtime.match(/^COPY .*$/gm)).toEqual([
                "COPY --from=builder /app/package.json ./package.json",
                "COPY --from=builder /app/dist ./dist",
            ]);
            expect(runtime.match(/^EXPOSE .*$/gm)).toEqual(["EXPOSE 8081"]);
        });

        it("starts the entry point the build produces, with node as PID 1 so SIGTERM releases the Lease", () => {
            expect(runtime).toMatch(/^CMD \["dist\/src\/main\.js"\]$/m);
            expect(runtime).not.toMatch(/^ENTRYPOINT/m);
            expect(pkg.scripts.start).toBe("node dist/src/main.js");
        });
    });

    describe("publish workflow", () => {
        const publish: string = read(".github/workflows/publish.yml");
        // The jobs by name (the file has no YAML parser to hand and the jobs sit two spaces in): each job's text, from its
        // key to the next one, so an assertion is about the job that must hold it and not about the file as a whole.
        const jobText: string = publish.slice(publish.indexOf("\njobs:\n"));
        const jobs: Record<string, string> = Object.fromEntries(
            jobText.split(/^ {2}(?=[\w-]+:$)/m).slice(1).map((job) => [job.slice(0, job.indexOf(":")), job]),
        );
        const stepsOf = (job: string): string => job.slice(job.indexOf("\n    steps:\n"));

        it("has the check and the publishing job, and nothing else that could push an image", () => {
            expect(Object.keys(jobs)).toEqual(["check", "publish-docker-image"]);
            expect(publish.match(/docker push/g)).toHaveLength(2);
            expect(stepsOf(jobs["check"])).not.toMatch(/docker (push|login)/);
        });

        it("runs the check only for a tag's successful Build, which must be on main and have every Build of its commit green", () => {
            const check: string = jobs["check"];
            expect(check).toContain("github.event.workflow_run.conclusion == 'success'");
            expect(check).toContain("github.event.workflow_run.event == 'push'");
            expect(check).toContain("startsWith(github.event.workflow_run.head_branch, 'v')");
            expect(check).toContain("git merge-base --is-ancestor HEAD origin/main");
            // A red Build or a check that is allowed to fail must stop the release, not let it through.
            expect(publish).not.toMatch(/continue-on-error/);
        });

        it("publishes only after the check, and compares the tag with the package version before it logs in or pushes", () => {
            const publishing: string = jobs["publish-docker-image"];
            expect(publishing).toMatch(/^ {4}needs: check$/m);
            expect(publishing).not.toMatch(/^ {4}if:/m);
            const steps: string = stepsOf(publishing);
            const compare: number = steps.indexOf('if [ "v$version" != "$TAG" ]');
            expect(compare).toBeGreaterThan(-1);
            expect(compare).toBeLessThan(steps.indexOf("docker login"));
            expect(compare).toBeLessThan(steps.indexOf("docker push"));
        });

        it("never makes a prerelease the latest image", () => {
            const push: string = jobs["publish-docker-image"].slice(jobs["publish-docker-image"].indexOf("- name: Push image"));
            const latest: number = push.indexOf('docker push "$IMAGE:latest"');
            expect(push.indexOf('if [[ "$VERSION" != *-* ]]')).toBeGreaterThan(-1);
            expect(push.indexOf('if [[ "$VERSION" != *-* ]]')).toBeLessThan(push.indexOf('docker tag "$IMAGE:$VERSION" "$IMAGE:latest"'));
            expect(push.indexOf('docker tag "$IMAGE:$VERSION" "$IMAGE:latest"')).toBeLessThan(latest);
            // The tag and the push are the only mentions, in the whole job: nothing else can make an image `latest`.
            expect(jobs["publish-docker-image"].match(/:latest/g)).toHaveLength(2);
        });
    });

    describe("contract fixtures", () => {
        // The shared files of spec 7.3: restapi's copy is the server's, and the two must stay byte-identical. Compared only
        // where the sibling repository is checked out beside this one (CI has this repository alone).
        const sibling: string = `${root}../restapi/test/fixtures/dns-api/v1/`;
        const ours: string = `${root}test/fixtures/api/v1/`;

        it("are held as LF in the working tree, so the bytes compared are the committed ones on every platform", () => {
            // core.autocrlf (Git for Windows' default) would otherwise rewrite them as CRLF on a checkout, and make two
            // identical commits differ on disk, or two different ones look alike.
            expect(read(".gitattributes")).toMatch(/^test\/fixtures\/api\/\*\* text eol=lf$/m);
            for (const name of readdirSync(ours)) {
                expect(readFileSync(`${ours}${name}`).includes(13), name).toBe(false);
            }
        });

        it.runIf(existsSync(sibling))("are byte-identical with restapi's", () => {
            const names: string[] = readdirSync(ours).sort();
            expect(names.length).toBeGreaterThan(0);
            expect(readdirSync(sibling).sort()).toEqual(names);
            for (const name of names) {
                expect(readFileSync(`${ours}${name}`).equals(readFileSync(`${sibling}${name}`)), name).toBe(true);
            }
        });
    });
});
