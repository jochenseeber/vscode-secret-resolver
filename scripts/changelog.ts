import { readPackageJson, ROOT, runEntrypoint, writeFormattedTextFile } from "./util.ts";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CHANGELOG_PATH = resolve(ROOT, "CHANGELOG.md");
const TITLE = "# Changelog";

const TAG_PREFIX = readPackageJson().releaseRefPrefix;

function readExistingBody(): string {
    try {
        return readFileSync(CHANGELOG_PATH, "utf8");
    }
    catch {
        return "";
    }
}

function stripLeadingTitle(body: string): string {
    const lines = body.split("\n");
    let i = 0;

    if (lines[i]?.trim() === TITLE) {
        i += 1;
        while (i < lines.length && lines[i].trim() === "") i += 1;
    }

    return lines.slice(i).join("\n");
}

function hasVersionSection(body: string, version: string): boolean {
    const escaped = version.replace(/[.\-+]/g, "\\$&");
    return new RegExp(`^##\\s+\\[?${escaped}[\\]\\s(]`, "m").test(body);
}

async function generateEntries(): Promise<string> {
    const { ConventionalChangelog } = await import("conventional-changelog");
    const generator = new ConventionalChangelog(ROOT)
        .loadPreset("conventionalcommits")
        .readPackage()
        .tags({ prefix: TAG_PREFIX })
        .options({ outputUnreleased: true, releaseCount: 1 });

    let out = "";

    for await (const chunk of generator.write()) {
        out += chunk;
    }

    return out.trim();
}

function writeChangelog(body: string): void {
    const trimmed = body.trim();
    const content = trimmed ? `${TITLE}\n\n${trimmed}\n` : `${TITLE}\n`;
    writeFormattedTextFile(CHANGELOG_PATH, content);
}

export async function regenerateCurrentVersionChangelog(): Promise<void> {
    const version = readPackageJson().version;
    const body = stripLeadingTitle(readExistingBody());

    // Only add — never touch an existing section for this version.
    if (hasVersionSection(body, version)) {
        writeChangelog(body);
        return;
    }

    const entries = await generateEntries();
    const combined = entries
        ? body ? `${entries}\n\n${body}` : entries
        : body;
    writeChangelog(combined);
}

runEntrypoint(import.meta.url, regenerateCurrentVersionChangelog);
