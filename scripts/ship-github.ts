import {
    assertGithubAuth,
    assertPublishable,
    parsePrerelease,
    readPackageJson,
    releaseTag,
    run,
    runEntrypoint,
} from "./util.js"

import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const PKG_DIR = resolve(process.cwd(), "pkg")

function listAssets(): string[] {
    if (!existsSync(PKG_DIR)) return []

    return readdirSync(PKG_DIR)
        .map((name) => join(PKG_DIR, name))
        .filter((path) => statSync(path).isFile())
}

export function shipGithub(): void {
    assertGithubAuth()

    const pkg = readPackageJson()
    assertPublishable(pkg)

    const tag = releaseTag(pkg)
    const assets = listAssets()
    const { isPrerelease } = parsePrerelease(pkg.version)

    const args = ["release", "create", tag, ...assets, "--generate-notes", "--verify-tag"]
    if (isPrerelease) args.push("--prerelease")

    run("gh", args)
}

runEntrypoint(import.meta.url, shipGithub)
