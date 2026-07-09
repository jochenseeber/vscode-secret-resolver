import {
    assertCleanWorkspace,
    capture,
    formatVersion,
    parseVersion,
    readPackageJson,
    runEntrypoint,
    Version,
    writeVersion,
} from "./util.ts"

import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { regenerateCurrentVersionChangelog } from "./changelog.ts"

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const { releaseRefPrefix: RELEASE_REF_PREFIX, releaseBranchSuffix: RELEASE_BRANCH_SUFFIX } = readPackageJson()
const TAG_PREFIX = RELEASE_REF_PREFIX
const RELEASE_BRANCH_RE = new RegExp(
    `^${escapeRegExp(RELEASE_REF_PREFIX)}(\\d+)\.(\\d+)${escapeRegExp(RELEASE_BRANCH_SUFFIX)}$`,
)

type BumpChoice = "major" | "minor"

interface BumpDecision {
    choice: BumpChoice
    reason: string
}

interface VersionTriple {
    major: number
    minor: number
    patch: number
}

const git = (...args: string[]): string => capture("git", args)

const TAG_RE = new RegExp(
    `^${escapeRegExp(TAG_PREFIX)}(\\d+)\\.(\\d+)\\.(\\d+)(?:-[\\w.-]+)?$`,
)

function compareTriples(a: VersionTriple, b: VersionTriple): number {
    if (a.major !== b.major) return a.major - b.major
    if (a.minor !== b.minor) return a.minor - b.minor
    return a.patch - b.patch
}

/**
 * Walks local branches matching `RELEASE_BRANCH_RE` and tags matching
 * `TAG_RE`, returning the highest-versioned reference. Branches contribute
 * `(major, minor)` only — patch is treated as `-1` so a tag at the same
 * `(major, minor)` ranks higher when both exist.
 */
function findLatestReleaseRef(): { triple: VersionTriple; ref: string } | null {
    const branches = git(
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
    ).split("\n").filter(Boolean)

    const tags = git("tag", "-l").split("\n").filter(Boolean)

    let latest: { triple: VersionTriple; ref: string } | null = null

    const consider = (triple: VersionTriple, ref: string): void => {
        if (latest === null || compareTriples(triple, latest.triple) > 0) {
            latest = { triple, ref }
        }
    }

    for (const branch of branches) {
        const m = RELEASE_BRANCH_RE.exec(branch)
        if (m) consider({ major: +m[1], minor: +m[2], patch: -1 }, branch)
    }

    for (const tag of tags) {
        const m = TAG_RE.exec(tag)
        if (m) consider({ major: +m[1], minor: +m[2], patch: +m[3] }, tag)
    }

    return latest
}

/**
 * Derives the bump label by comparing `package.json`'s current version
 * against the highest-versioned release branch/tag in the repository. The
 * label is informational only — release version and next-dev version are
 * computed directly from `package.json`.
 */
function detectBumpFromVersionState(current: Version): BumpDecision {
    const latest = findLatestReleaseRef()

    if (latest === null) {
        return { choice: "minor", reason: "no prior release branches or tags found" }
    }

    const currentTriple: VersionTriple = {
        major: current.major,
        minor: current.minor,
        patch: current.patch,
    }

    if (compareTriples(currentTriple, latest.triple) <= 0) {
        throw new Error(
            `package.json version ${
                formatVersion(current)
            } is not ahead of latest release ${latest.ref}. Bump package.json before releasing.`,
        )
    }

    if (current.major > latest.triple.major) {
        return {
            choice: "major",
            reason: `package.json ${formatVersion(current)} advances major from ${latest.ref}`,
        }
    }

    return {
        choice: "minor",
        reason: `package.json ${
            formatVersion(current)
        } stays on major ${current.major} (latest release: ${latest.ref})`,
    }
}

interface ReleaseOptions {
    /** `--yes` / `-y`: proceed without the interactive confirmation prompt. */
    assumeYes: boolean
}

/**
 * Parses the script's command line. Positionals and unknown options are
 * rejected. `--no-yes` restores the prompt when a wrapper passes `--yes` by
 * default.
 */
function parseReleaseOptions(args: string[]): ReleaseOptions {
    const { values } = parseArgs({
        args,
        options: {
            yes: { type: "boolean", short: "y", default: false },
        },
        allowNegative: true,
    })

    const options: ReleaseOptions = { assumeYes: values.yes === true }
    return options
}

async function confirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    rl.close()
    return answer === "y" || answer === "yes"
}

function commitVersion(message: string): void {
    git("add", "package.json", "CHANGELOG.md")
    git("commit", "-m", message)
}

function createTag(tag: string): void {
    git("tag", tag)
}

/**
 * Regenerates changelog entries for the current package.json version from
 * commits since the last tag. Delegates to scripts/changelog.ts so the
 * top-level `# Changelog` heading is preserved. Stages the updated file so
 * the caller can fold it into the next commit.
 */
async function regenerateChangelog(): Promise<void> {
    await regenerateCurrentVersionChangelog()
    git("add", "CHANGELOG.md")
}

async function main(): Promise<void> {
    const options = parseReleaseOptions(process.argv.slice(2))

    assertCleanWorkspace()

    const current = parseVersion(readPackageJson().version)

    const branch = git("rev-parse", "--abbrev-ref", "HEAD")

    if (branch === "HEAD") {
        throw new Error("Cannot release from detached HEAD.")
    }

    const onReleaseBranch = RELEASE_BRANCH_RE.test(branch)
    const fromBranch = branch

    let releaseVersion: Version
    let releaseBranchName: string
    let releaseBranchNextDev: Version
    let fromBranchNextDev: Version | null = null

    if (onReleaseBranch) {
        if (current.prerelease !== "dev") {
            throw new Error(
                `Release branch version "${
                    formatVersion(current)
                }" has no -dev suffix; bump the branch to the next patch development version before cutting another release.`,
            )
        }

        releaseVersion = { ...current, prerelease: null }
        releaseBranchNextDev = {
            ...current,
            patch: current.patch + 1,
            prerelease: "dev",
        }
        releaseBranchName = branch
    }
    else if (branch === "main") {
        if (current.prerelease !== "dev") {
            throw new Error(
                `Current version "${formatVersion(current)}" has no -dev suffix; nothing to release from main.`,
            )
        }

        const decision = detectBumpFromVersionState(current)
        console.log(`Detected bump: ${decision.choice} (${decision.reason})`)

        releaseVersion = { ...current, prerelease: null }
        fromBranchNextDev = {
            major: current.major,
            minor: current.minor + 1,
            patch: 0,
            prerelease: "dev",
        }

        releaseBranchName = `${TAG_PREFIX}${releaseVersion.major}.${releaseVersion.minor}${RELEASE_BRANCH_SUFFIX}`
        releaseBranchNextDev = {
            major: releaseVersion.major,
            minor: releaseVersion.minor,
            patch: releaseVersion.patch + 1,
            prerelease: "dev",
        }
    }
    else {
        throw new Error(`Must be on 'main' or a release branch (got '${branch}').`)
    }

    const releaseStr = formatVersion(releaseVersion)
    const releaseBranchNextDevStr = formatVersion(releaseBranchNextDev)
    const fromBranchNextDevStr = fromBranchNextDev
        ? formatVersion(fromBranchNextDev)
        : null
    const tag = `${TAG_PREFIX}${releaseStr}`

    console.log(`\nRelease version        : ${releaseStr}  (on ${releaseBranchName})`)
    console.log(`Release branch next dev: ${releaseBranchNextDevStr}  (on ${releaseBranchName})`)

    if (fromBranchNextDevStr) {
        console.log(`Main next dev          : ${fromBranchNextDevStr}  (on ${fromBranch})`)
    }

    console.log(`Tag to create          : ${tag}\n`)

    if (options.assumeYes) {
        console.log("Proceeding without confirmation (--yes).")
    }
    else if (!(await confirm("Proceed?"))) {
        console.log("Aborted.")
        process.exit(1)
    }

    if (onReleaseBranch) {
        writeVersion(releaseStr)
        await regenerateChangelog()
        commitVersion(`chore: release ${releaseStr}`)
        createTag(tag)

        writeVersion(releaseBranchNextDevStr)
        commitVersion(`chore: start ${releaseBranchNextDevStr} development`)
    }
    else {
        git("branch", releaseBranchName)
        git("checkout", releaseBranchName)
        writeVersion(releaseStr)
        await regenerateChangelog()
        commitVersion(`chore: release ${releaseStr}`)
        createTag(tag)

        writeVersion(releaseBranchNextDevStr)
        commitVersion(`chore: start ${releaseBranchNextDevStr} development`)

        git("checkout", fromBranch)
        // Bring the regenerated CHANGELOG.md from the release branch onto
        // `fromBranch` so the changelog history is visible there too.
        git("checkout", releaseBranchName, "--", "CHANGELOG.md")
        writeVersion(fromBranchNextDevStr ?? "")
        commitVersion(`chore: start ${fromBranchNextDevStr} development`)
    }

    console.log("\nDone. Next steps:")
    console.log(`  git push origin ${releaseBranchName} ${tag}`)

    if (fromBranchNextDevStr) {
        console.log(`  git push origin ${fromBranch}`)
    }
}

runEntrypoint(import.meta.url, main)
