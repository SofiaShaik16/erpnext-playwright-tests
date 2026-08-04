// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig, devices } from "@playwright/test";
import { storageStatePath } from "./tests/helpers/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
	path: path.join(__dirname, process.env.PW_ENV_FILE || ".env"),
	override: true,
});

const baseURL = process.env.FRAPPE_BASE_URL || "http://localhost:8000";

export default defineConfig({
	testDir: "./tests",
	timeout: 120000,
	globalSetup: "./tests/global-setup.js",
	reporter: [["list"], ["html", { open: "never" }]],
	use: {
		baseURL,
		storageState: storageStatePath(),
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
			},
		},
	],
});
