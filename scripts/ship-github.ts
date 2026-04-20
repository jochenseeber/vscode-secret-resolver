import { assertGithubAuth, loadPublishContext, run, runEntrypoint } from "./util.ts";

export function shipGithub(): void {
    assertGithubAuth();

    const { tag, vsix, isPrerelease } = loadPublishContext();
    const args = ["release", "create", tag, vsix, "--generate-notes", "--verify-tag"];
    if (isPrerelease) args.push("--prerelease");

    run("gh", args);
}

runEntrypoint(import.meta.url, shipGithub);
