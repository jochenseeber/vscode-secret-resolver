import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { regenerateCurrentVersionChangelog } from "./changelog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = resolve(ROOT, "package.json");

interface PackageJson {
    releaseRefPrefix: string;
    releaseBranchSuffix: string;
    version: string;
}

function readPackageJson(): PackageJson {
    return JSON.parse(readFileSync(PKG_PATH, "utf8")) as PackageJson;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RELEASE_REF_PREFIX = readPackageJson().releaseRefPrefix;
const TAG_PREFIX = RELEASE_REF_PREFIX;
const RELEASE_BRANCH_SUFFIX = readPackageJson().releaseBranchSuffix;
const RELEASE_BRANCH_RE = new RegExp(
    `^${escapeRegExp(RELEASE_REF_PREFIX)}(\\d+)\.(\\d+)${escapeRegExp(RELEASE_BRANCH_SUFFIX)}$`,
);

interface Version {
    major: number;
    minor: number;
    patch: number;
    prerelease: string | null;
}

type BumpChoice = "major" | "minor";

interface BumpDecision {
    choice: BumpChoice;
    reason: string;
}

function git(...args: string[]): string {
    try {
        return execFileSync("git", args, { encoding: "utf8", cwd: ROOT }).trim();
    }
    catch (e) {
        const err = e as { stderr?: Buffer; message: string };
        const msg = err.stderr?.toString().trim() || err.message;
        throw new Error(`git ${args.join(" ")} failed:\n${msg}`);
    }
}

function parseVersion(v: string): Version {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    if (!m) throw new Error(`Invalid version: ${v}`);
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        prerelease: m[4] ?? null,
    };
}

function formatVersion(v: Version): string {
    const base = `${v.major}.${v.minor}.${v.patch}`;
    return v.prerelease ? `${base}-${v.prerelease}` : base;
}

function readVersion(): string {
    return readPackageJson().version;
}

function writeVersion(version: string): void {
    const raw = readFileSync(PKG_PATH, "utf8");
    const updated = raw.replace(
        /("version"\s*:\s*")[^"]+(")/,
        `$1${version}$2`,
    );
    writeFileSync(PKG_PATH, updated);
}

function detectBumpFromCommits(): BumpDecision {
    let rangeStart = "";

    try {
        rangeStart = git(
            "log",
            "--extended-regexp",
            "--grep=^Start [0-9]+\\.[0-9]+\\.0 development",
            "--format=%H",
            "-n",
            "1",
        );
    }
    catch {
        // no matching commits; treat whole history as the range
    }

    const range = rangeStart ? `${rangeStart}..HEAD` : "HEAD";
    const log = git("log", range, "--format=%H%n%B%x00");
    const commits = log.split("\0").map((c) => c.trim()).filter(Boolean);

    const breakingSubject = /^[a-z]+(?:\([^)]+\))?!:/m;
    const breakingBody = /^BREAKING[ -]CHANGE:/m;

    for (const commit of commits) {
        const [sha, ...bodyLines] = commit.split("\n");
        const subject = bodyLines[0] ?? "";
        const body = bodyLines.join("\n");

        if (breakingSubject.test(subject) || breakingBody.test(body)) {
            return {
                choice: "major",
                reason: `breaking change in ${sha.slice(0, 7)}: ${subject}`,
            };
        }
    }

    return { choice: "minor", reason: "no breaking changes detected" };
}

async function resolveBump(): Promise<BumpDecision> {
    const argChoice = process.argv[2];

    if (argChoice === "major" || argChoice === "minor") {
        return { choice: argChoice, reason: "overridden via CLI argument" };
    }

    if (argChoice) {
        throw new Error(
            `Unknown bump type: ${argChoice} (expected 'major' or 'minor')`,
        );
    }

    return detectBumpFromCommits();
}

async function confirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    rl.close();
    return answer === "y" || answer === "yes";
}

function commitVersion(message: string): void {
    git("add", "package.json");
    git("commit", "-m", message);
}

function createTag(tag: string): void {
    git("tag", tag);
}

/**
 * Regenerates changelog entries for the current package.json version from
 * commits since the last tag. Delegates to scripts/changelog.ts so the
 * top-level `# Changelog` heading is preserved. Stages the updated file so
 * the caller can fold it into the next commit.
 */
async function regenerateChangelog(): Promise<void> {
    await regenerateCurrentVersionChangelog();
    git("add", "CHANGELOG.md");
}

async function main(): Promise<void> {
    const status = git("status", "--porcelain");

    if (status) {
        throw new Error(`Workspace is not clean:\n${status}`);
    }

    const current = parseVersion(readVersion());

    const branch = git("rev-parse", "--abbrev-ref", "HEAD");

    if (branch === "HEAD") {
        throw new Error("Cannot release from detached HEAD.");
    }

    const onReleaseBranch = RELEASE_BRANCH_RE.test(branch);
    const fromBranch = branch;

    let releaseVersion: Version;
    let releaseBranchName: string;
    let releaseBranchNextDev: Version;
    let fromBranchNextDev: Version | null = null;

    if (onReleaseBranch) {
        if (current.prerelease !== "dev") {
            throw new Error(
                `Release branch version "${
                    formatVersion(current)
                }" has no -dev suffix; bump the branch to the next patch development version before cutting another release.`,
            );
        }

        releaseVersion = { ...current, prerelease: null };
        releaseBranchNextDev = {
            ...current,
            patch: current.patch + 1,
            prerelease: "dev",
        };
        releaseBranchName = branch;
    }
    else if (branch === "main") {
        if (current.prerelease !== "dev") {
            throw new Error(
                `Current version "${formatVersion(current)}" has no -dev suffix; nothing to release from main.`,
            );
        }

        const decision = await resolveBump();
        console.log(`Auto-detected bump: ${decision.choice} (${decision.reason})`);

        if (decision.choice === "major") {
            releaseVersion = { major: current.major + 1, minor: 0, patch: 0, prerelease: null };
            fromBranchNextDev = { major: current.major + 1, minor: 1, patch: 0, prerelease: "dev" };
        }
        else {
            releaseVersion = { ...current, prerelease: null };
            fromBranchNextDev = {
                major: current.major,
                minor: current.minor + 1,
                patch: 0,
                prerelease: "dev",
            };
        }

        releaseBranchName = `${TAG_PREFIX}${releaseVersion.major}.${releaseVersion.minor}${RELEASE_BRANCH_SUFFIX}`;
        releaseBranchNextDev = {
            major: releaseVersion.major,
            minor: releaseVersion.minor,
            patch: releaseVersion.patch + 1,
            prerelease: "dev",
        };
    }
    else {
        throw new Error(`Must be on 'main' or a release branch (got '${branch}').`);
    }

    const releaseStr = formatVersion(releaseVersion);
    const releaseBranchNextDevStr = formatVersion(releaseBranchNextDev);
    const fromBranchNextDevStr = fromBranchNextDev
        ? formatVersion(fromBranchNextDev)
        : null;
    const tag = `${TAG_PREFIX}${releaseStr}`;

    console.log(`\nRelease version        : ${releaseStr}  (on ${releaseBranchName})`);
    console.log(`Release branch next dev: ${releaseBranchNextDevStr}  (on ${releaseBranchName})`);

    if (fromBranchNextDevStr) {
        console.log(`Main next dev          : ${fromBranchNextDevStr}  (on ${fromBranch})`);
    }

    console.log(`Tag to create          : ${tag}\n`);

    if (!(await confirm("Proceed?"))) {
        console.log("Aborted.");
        process.exit(1);
    }

    if (onReleaseBranch) {
        writeVersion(releaseStr);
        await regenerateChangelog();
        commitVersion(`Release ${releaseStr}`);
        createTag(tag);

        writeVersion(releaseBranchNextDevStr);
        commitVersion(`Start ${releaseBranchNextDevStr} development`);
    }
    else {
        git("branch", releaseBranchName);
        git("checkout", releaseBranchName);
        writeVersion(releaseStr);
        await regenerateChangelog();
        commitVersion(`Release ${releaseStr}`);
        createTag(tag);

        writeVersion(releaseBranchNextDevStr);
        commitVersion(`Start ${releaseBranchNextDevStr} development`);

        git("checkout", fromBranch);
        writeVersion(fromBranchNextDevStr ?? "");
        commitVersion(`Start ${fromBranchNextDevStr} development`);
    }

    console.log("\nDone. Next steps:");
    console.log(`  git push origin ${releaseBranchName} ${tag}`);

    if (fromBranchNextDevStr) {
        console.log(`  git push origin ${fromBranch}`);
    }
}

main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
});
