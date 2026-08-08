import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const bunCanaryConfigPath = path.join(
	repositoryRoot,
	"toolchains",
	"bun-canary.conf",
);

export function parseBunCanaryConfig(text: string) {
	const values: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^([A-Z0-9_]+)='([^']*)'$/);
		if (!match) throw new Error(`Invalid Bun canary config line: ${rawLine}`);
		values[match[1]] = match[2];
	}
	return values;
}

export function readBunCanaryConfig() {
	return parseBunCanaryConfig(fs.readFileSync(bunCanaryConfigPath, "utf8"));
}
