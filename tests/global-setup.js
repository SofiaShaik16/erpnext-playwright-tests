import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request as playwrightRequest } from "@playwright/test";
import dotenv from "dotenv";
import { loginWithApi, storageStatePath } from "./helpers/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFile = storageStatePath();

dotenv.config({
	path: path.join(__dirname, "..", process.env.PW_ENV_FILE || ".env"),
	override: true,
});

export default async function globalSetup() {
	await mkdir(path.dirname(authFile), { recursive: true });

	const baseURL = process.env.FRAPPE_BASE_URL || "http://localhost:8000";
	const api = await playwrightRequest.newContext({ baseURL });

	try {
		await loginWithApi(api);
		await api.storageState({ path: authFile });
	} finally {
		await api.dispose();
	}
}

export { authFile };
