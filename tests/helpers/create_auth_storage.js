import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request as playwrightRequest } from "@playwright/test";
import dotenv from "dotenv";
import { loginWithApi, storageStatePath } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
	path: path.join(__dirname, "..", "..", process.env.PW_ENV_FILE || ".env"),
	override: true,
});

const authFile = storageStatePath();
const baseURL = process.env.FRAPPE_BASE_URL || "http://localhost:8000";

await mkdir(path.dirname(authFile), { recursive: true });

const api = await playwrightRequest.newContext({ baseURL });

try {
	await loginWithApi(api);
	await api.storageState({ path: authFile });
	console.log(`Saved Playwright login state to ${authFile}`);
} finally {
	await api.dispose();
}
