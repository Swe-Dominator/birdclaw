import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
	absWorkingDir: root,
	entryPoints: ["src/cli.ts"],
	outfile: "dist/cli/birdclaw.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node26",
	packages: "external",
	logLevel: "info",
});
