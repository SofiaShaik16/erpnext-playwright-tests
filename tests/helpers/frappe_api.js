import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request as playwrightRequest } from "@playwright/test";
import { loginWithApi } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, "../../../..");
let remoteApiContextPromise = null;

function getFrappeBaseURL() {
	return process.env.FRAPPE_BASE_URL || "http://localhost:8000";
}

export function useRemoteFrappeApi() {
	const baseURL = getFrappeBaseURL();
	return /^https?:\/\/(?!localhost(?::|\/|$)|127\.0\.0\.1(?::|\/|$))/i.test(baseURL);
}

function toPythonLiteral(value) {
	if (value === null) {
		return "None";
	}
	if (typeof value === "boolean") {
		return value ? "True" : "False";
	}
	if (typeof value === "number") {
		return String(value);
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => toPythonLiteral(item)).join(", ")}]`;
	}
	if (typeof value === "object") {
		return `{${Object.entries(value)
			.map(([key, item]) => `${JSON.stringify(key)}: ${toPythonLiteral(item)}`)
			.join(", ")}}`;
	}
	throw new Error(`Unsupported bench argument value: ${value}`);
}

export function benchExecute(method, args = null) {
	const site = process.env.FRAPPE_SITE || "ntpt";
	const argsPart =
		args == null ? "" : ` --args '${toPythonLiteral(args).replace(/'/g, "'\\''")}'`;
	const command = `bench --site ${site} execute ${method}${argsPart}`;

	let stdout = "";
	try {
		stdout = execSync(command, {
			cwd: BENCH_ROOT,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		const stderr = error.stderr?.toString?.() || "";
		throw new Error(
			[
				`bench execute failed: ${method}`,
				stderr || error.message,
				`cwd=${BENCH_ROOT}`,
			].join("\n")
		);
	}

	const trimmed = stdout.trim();
	if (!trimmed) {
		return null;
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		return trimmed;
	}
}

/**
 * Call a whitelisted Frappe method, transparently choosing between a local
 * `bench execute` (positional args, for a machine with the site's bench checked
 * out) and a remote `/api/method` HTTP call (kwargs, for CI runners that only
 * have this repo checked out and talk to a deployed site over FRAPPE_BASE_URL).
 */
export async function callFixtureMethod(method, benchArgs = [], apiArgs = {}) {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(method, apiArgs);
	}
	return benchExecute(method, benchArgs);
}

async function getRemoteApiContext() {
	if (!remoteApiContextPromise) {
		remoteApiContextPromise = (async () => {
			const api = await playwrightRequest.newContext({ baseURL: getFrappeBaseURL() });
			await loginWithApi(api);
			return api;
		})();
	}
	return remoteApiContextPromise;
}

export async function remoteCallFrappeMethod(method, args = {}) {
	const request = await getRemoteApiContext();
	return callFrappeMethod(request, method, args);
}

export async function remoteGetDoc(doctype, name, fields = null) {
	const request = await getRemoteApiContext();
	return getDoc(request, doctype, name, fields);
}

export async function remoteGetList(doctype, options = {}) {
	const request = await getRemoteApiContext();
	return getList(request, doctype, options);
}

export async function callFrappeMethod(request, method, args = {}) {
	const endpoint = `/api/method/${method}`;
	let response;
	try {
		response = await request.post(endpoint, { data: args });
	} catch (error) {
		throw new Error(`Frappe API POST ${getFrappeBaseURL()}${endpoint} failed: ${error.message}`);
	}

	const body = await response.json();
	if (!response.ok() || body.exc) {
		throw new Error(
			`Frappe method ${method} failed: ${body._server_messages || body.message || response.status()}`
		);
	}

	return body.message;
}

export async function getDoc(request, doctype, name, fields = null) {
	const params = new URLSearchParams();
	if (fields) {
		params.set("fields", JSON.stringify(fields));
	}

	const endpoint = `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}?${params.toString()}`;
	let response;
	try {
		response = await request.get(endpoint);
	} catch (error) {
		throw new Error(
			`Frappe API GET ${getFrappeBaseURL()}${endpoint} failed: ${error.message}`
		);
	}

	if (!response.ok()) {
		return null;
	}

	const { data } = await response.json();
	return data;
}

export async function getList(request, doctype, { filters = [], fields = ["name"], limit = 1, orderBy } = {}) {
	const params = new URLSearchParams({
		fields: JSON.stringify(fields),
		filters: JSON.stringify(filters),
		limit_page_length: String(limit),
	});

	if (orderBy) {
		params.set("order_by", orderBy);
	}

	const endpoint = `/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`;
	let response;
	try {
		response = await request.get(endpoint);
	} catch (error) {
		throw new Error(
			`Frappe API GET ${getFrappeBaseURL()}${endpoint} failed: ${error.message}`
		);
	}

	if (!response.ok()) {
		return [];
	}

	const { data } = await response.json();
	return data || [];
}
