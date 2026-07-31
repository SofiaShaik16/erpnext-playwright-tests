import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recordedSpec = path.join(__dirname, "..", "recorded.spec.ts");

let source = await readFile(recordedSpec, "utf8");

source = source.replace(
	/  await page\.getByRole\('textbox', \{ name: 'Password' \}\)\.press\('Enter'\);\n  await page\.getByRole\('button', \{ name: 'Login' \}\)\.click\(\);\n/g,
	[
		"  await page.getByRole('textbox', { name: 'Password' }).press('Enter');",
		"  await page.waitForURL(/\\/apps|\\/app/, { timeout: 30000 });",
		"",
	].join("\n")
);

source = source.replace(
	/  await page\.getByRole\('button', \{ name: 'Login' \}\)\.click\(\);\n  await page\.locator\('a'\)\.filter\(\{ hasText: 'ERPNext' \}\)\.click\(\);\n/g,
	[
		"  await page.getByRole('button', { name: 'Login' }).click();",
		"  await page.waitForURL(/\\/apps|\\/app/, { timeout: 30000 });",
		"  await page.goto('/app');",
		"",
	].join("\n")
);

source = source.replace(
	/  await page\.locator\('a'\)\.filter\(\{ hasText: 'ERPNext' \}\)\.click\(\);\n/g,
	"  await page.goto('/app');\n"
);

source = source.replaceAll(
	"getByRole('combobox', { name: 'Search or type a command (' })",
	"getByRole('combobox', { name: /Search or type a command/ })"
);

await writeFile(recordedSpec, source);
console.log(`Normalized recorded Playwright spec: ${recordedSpec}`);
