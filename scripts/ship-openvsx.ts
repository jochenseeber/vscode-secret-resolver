import { loadPublishContext, requireEnv, run, runEntrypoint } from "./util.ts";

export function shipOpenVsx(): void {
    const token = requireEnv("OPENVSX_TOKEN");

    const { vsix, isPrerelease } = loadPublishContext();

    const args = ["exec", "ovsx", "publish", vsix];
    if (isPrerelease) args.push("--pre-release");

    run("pnpm", args, { OVSX_PAT: token });
}

runEntrypoint(import.meta.url, shipOpenVsx);
