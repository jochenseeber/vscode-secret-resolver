import { loadPublishContext, requireEnv, run, runEntrypoint } from "./util.ts";

export function shipMarketplace(): void {
    const token = requireEnv("AZURE_DEVOPS_TOKEN");

    const { vsix, isPrerelease } = loadPublishContext();

    const args = [
        "exec",
        "vsce",
        "publish",
        "--no-dependencies",
        "--packagePath",
        vsix,
    ];
    if (isPrerelease) args.push("--pre-release");

    run("pnpm", args, { VSCE_PAT: token });
}

runEntrypoint(import.meta.url, shipMarketplace);
