#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
	const options = {
		label: "runtime",
		runtime: process.execPath,
		runtimeArgs: [],
		entry: "bin/birdclaw.mjs",
		home: process.env.BIRDCLAW_HOME,
		iterations: 30,
		gitSha: undefined,
	};
	for (const arg of argv) {
		if (arg.startsWith("--label=")) options.label = arg.slice(8);
		else if (arg.startsWith("--runtime=")) options.runtime = arg.slice(10);
		else if (arg.startsWith("--runtime-arg=")) {
			options.runtimeArgs.push(arg.slice(14));
		} else if (arg.startsWith("--entry=")) options.entry = arg.slice(8);
		else if (arg.startsWith("--home=")) options.home = arg.slice(7);
		else if (arg.startsWith("--iterations=")) {
			options.iterations = Number.parseInt(arg.slice(13), 10);
		} else if (arg.startsWith("--git-sha=")) options.gitSha = arg.slice(10);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isInteger(options.iterations) || options.iterations < 1) {
		throw new Error("--iterations must be a positive integer");
	}
	if (!options.home) throw new Error("--home or BIRDCLAW_HOME is required");
	options.entry = path.resolve(options.entry);
	options.home = path.resolve(options.home);
	return options;
}

function percentile(values, point) {
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(
		sorted.length - 1,
		Math.ceil(sorted.length * point) - 1,
	);
	return sorted[index] ?? 0;
}

function median(values) {
	return percentile(values, 0.5);
}

function bootstrapMedianInterval(values) {
	let state = 0x5eed1234;
	const random = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const medians = [];
	for (let sample = 0; sample < 2000; sample += 1) {
		const resampled = [];
		for (let index = 0; index < values.length; index += 1) {
			resampled.push(values[Math.floor(random() * values.length)] ?? 0);
		}
		medians.push(median(resampled));
	}
	return {
		low: percentile(medians, 0.025),
		high: percentile(medians, 0.975),
	};
}

function summarizeMs(values) {
	return {
		medianMs: median(values),
		p95Ms: percentile(values, 0.95),
		median95CiMs: bootstrapMedianInterval(values),
	};
}

function summarizeKb(values) {
	return {
		medianKb: median(values),
		p95Kb: percentile(values, 0.95),
		median95CiKb: bootstrapMedianInterval(values),
	};
}

async function sha256(filePath) {
	return createHash("sha256")
		.update(await readFile(filePath))
		.digest("hex");
}

function logicalDatabaseSha256(filePath) {
	const database = new DatabaseSync(filePath);
	try {
		database.exec("pragma query_only = on");
		return createHash("sha256").update(database.serialize()).digest("hex");
	} finally {
		database.close();
	}
}

async function runtimeIdentity(options) {
	const args = path.basename(options.runtime).toLowerCase().startsWith("bun")
		? ["--revision"]
		: ["--version"];
	const { stdout } = await execFileAsync(options.runtime, args);
	return stdout.trim();
}

async function gitSha() {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
		return stdout.trim();
	} catch {
		return undefined;
	}
}

async function measureCli(options) {
	const startedAt = performance.now();
	await execFileAsync(
		options.runtime,
		[...options.runtimeArgs, options.entry, "--version"],
		{
			env: {
				...process.env,
				BIRDCLAW_HOME: options.home,
				DO_NOT_TRACK: "1",
			},
		},
	);
	return performance.now() - startedAt;
}

async function readRssKb(pid) {
	try {
		const { stdout } = await execFileAsync("ps", [
			"-o",
			"rss=",
			"-p",
			String(pid),
		]);
		const value = Number.parseInt(stdout.trim(), 10);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

async function measureServer(options) {
	const startedAt = performance.now();
	const child = spawn(
		options.runtime,
		[
			...options.runtimeArgs,
			options.entry,
			"serve",
			"--host",
			"127.0.0.1",
			"--port",
			"0",
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				BIRDCLAW_BACKUP_AUTO_SYNC: "0",
				BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP: "1",
				BIRDCLAW_DISABLE_LIVE_WRITES: "1",
				BIRDCLAW_HOME: options.home,
				DO_NOT_TRACK: "1",
			},
		},
	);
	let output = "";
	const listening = new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`server startup timed out\n${output}`)),
			20_000,
		);
		const onData = (chunk) => {
			output += String(chunk);
			const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
			if (!match) return;
			clearTimeout(timer);
			resolve(Number(match[1]));
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(
				new Error(
					`server exited before startup (${String(code ?? signal)})\n${output}`,
				),
			);
		});
	});
	try {
		const port = await listening;
		const listeningMs = performance.now() - startedAt;
		const responseStartedAt = performance.now();
		const response = await fetch(`http://127.0.0.1:${String(port)}/`);
		await response.arrayBuffer();
		if (!response.ok) {
			throw new Error(`server returned HTTP ${String(response.status)}`);
		}
		const firstResponseMs = performance.now() - responseStartedAt;
		return {
			listeningMs,
			firstResponseMs,
			rssKb: await readRssKb(child.pid),
		};
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGTERM");
			await exited;
		}
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const databasePath = path.join(options.home, "birdclaw.sqlite");
	const inputDatabaseFileSha256 = await sha256(databasePath);
	const inputDatabaseLogicalSha256 = logicalDatabaseSha256(databasePath);
	const cliSamplesMs = [];
	const serverSamples = [];
	await measureCli(options);
	await measureServer(options);
	for (let index = 0; index < options.iterations; index += 1) {
		cliSamplesMs.push(await measureCli(options));
		serverSamples.push(await measureServer(options));
	}
	const rssSamples = serverSamples
		.map((sample) => sample.rssKb)
		.filter((value) => typeof value === "number");
	const packageRoot = path.dirname(path.dirname(options.entry));
	const artifactPaths = {
		launcher: options.entry,
		cli: path.join(packageRoot, "dist", "cli", "birdclaw.js"),
		server: path.join(packageRoot, "dist", "server", "server.js"),
	};
	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				label: options.label,
				gitSha: options.gitSha ?? (await gitSha()),
				entry: options.entry,
				artifacts: {
					launcherSha256: await sha256(artifactPaths.launcher),
					cliSha256: await sha256(artifactPaths.cli),
					serverSha256: await sha256(artifactPaths.server),
				},
				home: options.home,
				inputDatabaseFileSha256,
				finalDatabaseFileSha256: await sha256(databasePath),
				inputDatabaseLogicalSha256,
				finalDatabaseLogicalSha256: logicalDatabaseSha256(databasePath),
				runtime: {
					executable: path.resolve(options.runtime),
					args: options.runtimeArgs,
					identity: await runtimeIdentity(options),
				},
				iterations: options.iterations,
				summary: {
					cli: summarizeMs(cliSamplesMs),
					serverListening: summarizeMs(
						serverSamples.map((sample) => sample.listeningMs),
					),
					firstResponse: summarizeMs(
						serverSamples.map((sample) => sample.firstResponseMs),
					),
					rssKb: rssSamples.length > 0 ? summarizeKb(rssSamples) : null,
				},
				samples: {
					cliMs: cliSamplesMs,
					server: serverSamples,
				},
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exit(1);
});
