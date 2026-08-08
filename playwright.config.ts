import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const testHome = path.join(process.cwd(), ".playwright-home");
const port = process.env.BIRDCLAW_PLAYWRIGHT_PORT ?? "3000";
const baseURL = `http://127.0.0.1:${port}`;
const runtimeArgs = "bun" in process.versions ? " --no-env-file" : "";
const serverCommand = `${JSON.stringify(process.execPath)}${runtimeArgs} ./scripts/start-test-server.mjs`;

export default defineConfig({
	testDir: "./playwright",
	fullyParallel: false,
	retries: 0,
	workers: 1,
	use: {
		baseURL,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: serverCommand,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120000,
		env: {
			BIRDCLAW_PLAYWRIGHT_PORT: port,
			BIRDCLAW_HOME: testHome,
			BIRDCLAW_BACKUP_AUTO_SYNC: "0",
			BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP: "1",
			BIRDCLAW_DISABLE_LIVE_WRITES: "1",
			DO_NOT_TRACK: "1",
		},
	},
});
