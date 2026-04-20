import { readFileSync, writeFileSync } from "node:fs";
import { ROOT, runEntrypoint } from "./util.ts";

import { Resvg } from "@resvg/resvg-js";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

export function generateIcon(): void {
    const lockSvgPath = require.resolve("@tabler/icons/outline/lock.svg");
    const source = readFileSync(lockSvgPath, "utf8");
    const innerMatch = source.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);

    if (!innerMatch) {
        throw new Error(`Could not parse Tabler icon at ${lockSvgPath}`);
    }

    const paths = innerMatch[1].trim();

    const composed = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 24 24">
  <defs>
    <filter id="lockShadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="0.4" stdDeviation="0.4" flood-color="#000000" flood-opacity="0.35" />
    </filter>
  </defs>
  <circle cx="12" cy="12" r="12" fill="#ffffff" />
  <g transform="translate(12 12) scale(0.7) translate(-12 -12)" fill="none" stroke="#f59e0b" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" filter="url(#lockShadow)">
    ${paths}
  </g>
</svg>
`;

    const pngOut = resolve(ROOT, "images/icon.png");
    const resvg = new Resvg(composed);
    const pngData = resvg.render().asPng();

    writeFileSync(pngOut, pngData);
}

runEntrypoint(import.meta.url, generateIcon);
