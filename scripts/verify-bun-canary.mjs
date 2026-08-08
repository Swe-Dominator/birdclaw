import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
	readBunCanaryConfig,
	repositoryRoot,
} from "../src/lib/bun-toolchain.ts";

const config = readBunCanaryConfig();
if (!process.versions.bun || typeof Bun === "undefined") {
	throw new Error("The pinned Bun verifier must run under Bun");
}
if (Bun.version !== config.BUN_CANARY_RUNTIME_VERSION) {
	throw new Error(
		`Expected Bun ${config.BUN_CANARY_RUNTIME_VERSION}, got ${Bun.version}`,
	);
}
if (Bun.revision !== config.BUN_CANARY_SOURCE_SHA) {
	throw new Error(
		`Expected Bun source ${config.BUN_CANARY_SOURCE_SHA}, got ${Bun.revision}`,
	);
}

const platformKey = `${process.platform}-${process.arch}`;
const expectedBinarySha =
	platformKey === "darwin-arm64"
		? config.BUN_CANARY_DARWIN_ARM64_BINARY_SHA256
		: platformKey === "linux-x64"
			? config.BUN_CANARY_LINUX_X64_BINARY_SHA256
			: undefined;
if (!expectedBinarySha) {
	throw new Error(`Unsupported Bun verifier platform ${platformKey}`);
}
const binarySha = createHash("sha256")
	.update(fs.readFileSync(process.execPath))
	.digest("hex");
if (binarySha !== expectedBinarySha) {
	throw new Error(`Expected Bun binary ${expectedBinarySha}, got ${binarySha}`);
}

const revision = spawnSync(process.execPath, ["--revision"], {
	encoding: "utf8",
}).stdout.trim();
if (revision !== config.BUN_CANARY_REVISION) {
	throw new Error(
		`Expected Bun revision ${config.BUN_CANARY_REVISION}, got ${revision}`,
	);
}

const packageJson = JSON.parse(
	fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
const expectedPackageManager = `bun@${config.BUN_CANARY_REVISION}`;
if (packageJson.packageManager !== expectedPackageManager) {
	throw new Error(
		`Expected packageManager ${expectedPackageManager}, got ${String(packageJson.packageManager)}`,
	);
}

console.log(`Bun ${revision} (${binarySha})`);
