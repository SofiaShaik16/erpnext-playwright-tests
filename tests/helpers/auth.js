import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function storageStatePath() {
	return path.join(__dirname, "..", ".auth", "storage.json");
}

/**
 * Log in via Frappe API and sync session cookies into the browser context.
 *
 * Env:
 *   FRAPPE_BASE_URL  (default http://localhost:8000)
 *   FRAPPE_USER      (default Administrator)
 *   FRAPPE_PASSWORD  (required)
 */
export async function loginWithApi(request) {
	const baseURL = process.env.FRAPPE_BASE_URL || "http://localhost:8000";
	const user = process.env.FRAPPE_USER || "Administrator";
	const password = process.env.FRAPPE_PASSWORD;

	if (!password) {
		throw new Error(
			[
				"FRAPPE_PASSWORD is not set.",
				"Copy .env.example to .env in apps/ntpt_erpnext_app and set your site password,",
				"or run: export FRAPPE_PASSWORD=1",
			].join(" ")
		);
	}

	let response;
	try {
		response = await request.post("/api/method/login", {
			form: { usr: user, pwd: password },
		});
	} catch (error) {
		throw new Error(`Frappe login request failed for ${baseURL}: ${error.message}`);
	}

	if (!response.ok()) {
		const body = await response.text();
		throw new Error(
			[
				`Login failed (${response.status()}): ${body}`,
				`Check FRAPPE_USER (${user}), FRAPPE_PASSWORD, and FRAPPE_BASE_URL (${baseURL}).`,
			].join("\n")
		);
	}

	return response;
}

export async function applyLoginCookies(context, request) {
	await loginWithApi(request);
	const { cookies } = await request.storageState();
	if (cookies.length) {
		await context.addCookies(cookies);
	}
}
