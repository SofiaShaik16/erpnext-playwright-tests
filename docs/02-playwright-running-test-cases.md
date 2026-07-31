# Playwright Guide - Part 2: Running Test Cases

## Purpose

This guide explains how to run Playwright test cases, understand the files used in a test flow, generate test code, edit existing tests, and use debugging features such as screenshots, traces, headed mode, UI mode, and Playwright Inspector.

The goal is to help a developer convert any manual business workflow into an automated Playwright test.

## Basic Test Structure

A Playwright test setup usually contains these files:

- Spec files: Files that contain the actual test cases.
- Helper files: Reusable functions used by multiple tests.
- Fixture files: Input data used to create or verify records.
- Configuration file: Playwright settings such as browser, base URL, screenshots, traces, and timeouts.
- Environment file: Site URL, username, password, and other environment-specific values.

A common folder structure looks like this:

```text
playwright.config.js
tests/
  global-setup.js
  business_workflow.spec.js
  helpers/
    auth.js
    api.js
    form_helpers.js
    workflow_helpers.js
  fixtures/
    sample_input.json
    expected_output.json
```

## Spec Files

A spec file contains one or more test cases. It usually ends with `.spec.js`.

Example:

```js
import { expect, test } from "@playwright/test";

test.describe("Business workflow", () => {
	test("document can move to the expected final state", async ({ page }) => {
		await page.goto("/app/document-type");
		await expect(page.locator(".layout-main-section")).toBeVisible();
	});
});
```

A spec file usually includes:

- Imports from Playwright
- Imports from helper files
- Test groups using `test.describe`
- Test cases using `test`
- Browser actions using `page`
- Assertions using `expect`
- API checks when frontend checks are not enough

## Helper Files

Helper files keep tests clean and reusable.

For example, instead of writing the same code to open a document in every test, create a helper:

```js
export async function openDocument(page, doctype, documentName) {
	const route = `/app/${doctype.toLowerCase().replaceAll(" ", "-")}/${encodeURIComponent(documentName)}`;
	await page.goto(route);
	await page.waitForFunction(
		({ expectedDoctype, expectedName }) =>
			window.cur_frm?.doctype === expectedDoctype && window.cur_frm?.doc?.name === expectedName,
		{ expectedDoctype: doctype, expectedName: documentName }
	);
}
```

Then use it in the spec:

```js
await openDocument(page, "Document Type", "DOC-0001");
```

Use helpers for repeated actions such as:

- Opening forms
- Waiting for a form to load
- Clicking workflow actions
- Reading UI state
- Creating test records
- Calling backend APIs
- Closing common dialogs

## Fixture Files

Fixture files store test input data.

Example:

```json
{
	"doctype": "Document Type",
	"company": "Demo Company",
	"items": [
		{
			"item_code": "ITEM-001",
			"qty": 1
		}
	]
}
```

Fixtures are useful when a test needs the same type of data every time it runs. They also make the test easier to update because data is separated from the test logic.

Use fixture files for:

- Input document values
- Expected output values
- Test case titles
- Linked document data
- Workflow-specific conditions

## Configuration File

`playwright.config.js` controls how Playwright runs tests.

Common settings include:

```js
use: {
	baseURL: process.env.BASE_URL || "http://localhost:8000",
	storageState: "playwright/.auth/user.json",
	trace: "on-first-retry",
	screenshot: "only-on-failure",
}
```

These settings mean:

- `baseURL` lets tests use relative URLs.
- `storageState` reuses a saved login session.
- `trace` records detailed debugging information when needed.
- `screenshot` saves screenshots when a test fails.

## Environment File

Tests usually need environment values.

Example `.env`:

```text
BASE_URL=http://localhost:8000
TEST_USER=Administrator
TEST_PASSWORD=your-password
```

For UAT or staging, use a separate file:

```text
.env.uat
```

This keeps test code the same while allowing the test to run against different sites.

Do not hard-code passwords, tokens, or site-specific secrets inside test files.

## How a Manual Workflow Becomes a Test

Start by writing the manual workflow in simple steps.

Example manual workflow:

1. Open the required document.
2. Confirm the document is in the expected starting state.
3. Perform the first user action.
4. Confirm the page or document updated correctly.
5. Perform the next workflow action.
6. Verify that linked records or child rows were created.
7. Confirm the final status, fields, or backend values.

Then convert each step into test code:

```js
await openDocument(page, "Document Type", documentName);
await runWorkflowAction(page, "Review");

const state = await getCurrentDocumentState(page);
expect(state.status).toBe("Reviewed");
expect(state.itemCount).toBeGreaterThan(0);
```

A good automated test should check the result, not only perform clicks.

## What Test Code Should Include

A complete test usually contains:

- Setup: Create or find the records needed for the test.
- Navigation: Open the correct page or form.
- Actions: Click buttons, fill fields, save, submit, or run workflow actions.
- Waits: Wait for the page, form, dialog, or loading state.
- Assertions: Confirm the expected result.
- Cleanup or isolation: Avoid leaving data in a state that affects other tests.

Example:

```js
test("workflow creates the expected linked document", async ({ page, request }) => {
	const input = await createWorkflowFixture();

	await openDocument(page, input.doctype, input.name);
	await runWorkflowAction(page, "Submit");

	const currentDocument = await getCurrentDocumentState(page);
	expect(currentDocument.docstatus).toBe(1);

	const linkedDocument = await getLinkedDocument(request, currentDocument.name);
	expect(linkedDocument).toBeTruthy();
	expect(linkedDocument.items.length).toBeGreaterThan(0);
});
```

## Running Test Cases

Run commands from the project folder where `package.json` and `playwright.config.js` are present.

Run all tests:

```bash
npx playwright test
```

Run one test file:

```bash
npx playwright test tests/business_workflow.spec.js
```

Run tests with a matching title:

```bash
npx playwright test -g "workflow"
```

Run tests one by one:

```bash
npx playwright test --workers=1
```

Run tests using an npm script if the project provides one:

```bash
npm run test:e2e
```

## Running Tests With Browser Visible

Headed mode opens the browser while the test runs.

```bash
npx playwright test --headed
```

Run one file in headed mode:

```bash
npx playwright test tests/business_workflow.spec.js --headed
```

Use headed mode when you want to see:

- Which page opens
- Which button is clicked
- Which dialog appears
- Whether a field is hidden, disabled, or missing
- Where the test stops

## Running Tests in UI Mode

UI mode opens the interactive Playwright test runner.

```bash
npx playwright test --ui
```

UI mode is useful for:

- Running one test at a time
- Re-running failed tests
- Viewing each test step
- Inspecting locators
- Debugging flows visually

## Debug Mode

Debug mode opens Playwright Inspector and pauses the test.

```bash
npx playwright test tests/business_workflow.spec.js --debug
```

Use debug mode when:

- A locator is not finding the element
- The page is blocked by a dialog
- The workflow button is not available
- The test moves faster than the application
- The form state is different from what was expected

You can also pause inside a test:

```js
await page.pause();
```

Remove `page.pause()` before finalizing the test.

## Generating Code With Playwright

Playwright can generate test code while you manually use the browser.

Start code generation:

```bash
npx playwright codegen http://localhost:8000
```

The generated code may look like this:

```js
await page.getByRole("button", { name: "New" }).click();
await page.getByLabel("Name").fill("Test Value");
await page.getByRole("button", { name: "Save" }).click();
```

Generated code is helpful, but it should be cleaned before adding it to a real test.

Improve generated code by:

- Replacing repeated steps with helper functions
- Using stable locators
- Adding clear assertions
- Removing unnecessary waits
- Removing accidental clicks
- Giving the test a clear name

Example cleanup:

```js
await createNewDocument(page, input);
await expect(page.locator(".saved-message")).toBeVisible();
```

## Editing Playwright Tests

When editing a test, keep the flow easy to read.

A good test answers:

- What record is being tested?
- What user action is performed?
- What result is expected?
- Is the result checked through the UI, backend API, or both?

Use clear test names:

```js
test("document reaches the expected final status", async ({ page }) => {
	// test steps
});
```

Prefer stable locators:

```js
await page.getByRole("button", { name: "Save" }).click();
await page.locator('[data-fieldname="status"]').click();
```

Avoid fragile locators:

```js
await page.locator("div:nth-child(4) > button:nth-child(2)").click();
```

Use assertions after important actions:

```js
await expect(page.getByRole("button", { name: "Submit" })).toBeVisible();
expect(documentState.docstatus).toBe(1);
```

## Screenshots

Playwright can automatically save screenshots on failure if configured:

```js
screenshot: "only-on-failure"
```

You can also take a screenshot manually:

```js
await page.screenshot({ path: "test-results/current-page.png", fullPage: true });
```

Screenshots are useful when checking:

- A failed screen state
- A missing button
- A hidden or read-only field
- A blocking dialog
- A final document view

Do not keep unnecessary screenshots in final tests unless they help debugging or documentation.

## Traces

Traces record detailed information about a test run.

They can include:

- Test steps
- Screenshots
- DOM snapshots
- Console logs
- Network activity

Enable trace for a test run:

```bash
npx playwright test --trace on
```

Open the HTML report:

```bash
npx playwright show-report
```

Open a trace file:

```bash
npx playwright show-trace path/to/trace.zip
```

Use traces when the failure is difficult to understand from the terminal output.

## Common Playwright Features

### `page`

`page` represents the browser tab.

```js
await page.goto("/app/document-type");
await page.getByRole("button", { name: "Save" }).click();
```

### `expect`

`expect` checks that the result is correct.

```js
await expect(page.getByRole("button", { name: "Submit" })).toBeVisible();
expect(state.docstatus).toBe(1);
```

### `request`

`request` can call backend APIs during a test.

```js
const response = await request.get("/api/resource/Document Type/DOC-0001");
expect(response.ok()).toBeTruthy();
```

### `test.skip`

`test.skip` can skip a test when required data is missing.

```js
test.skip(!fixtureAvailable, "Required fixture data is not available");
```

### `test.describe.serial`

Use serial mode when one test depends on a previous test.

```js
test.describe.configure({ mode: "serial" });
```

Use this carefully. Independent tests are usually easier to maintain.

## Example Flow Ideas

Playwright can be used for many kinds of workflows, such as:

- Creating a document and checking required fields
- Moving a document through workflow states
- Creating linked documents from an existing document
- Verifying child table rows
- Checking hidden, visible, read-only, or required fields
- Confirming calculations or totals
- Testing scan, upload, print, or custom button behavior
- Verifying backend data after UI actions

These examples are only patterns. The same structure can be used for any business process that needs repeatable testing.

## Recommended Process for Writing a New Test

1. Write the manual workflow in simple steps.
2. Identify the input data required for the flow.
3. Add fixture files if test data is needed.
4. Create helper functions for repeated actions.
5. Create or update a `.spec.js` file.
6. Use Playwright codegen if locator help is needed.
7. Clean the generated code.
8. Add assertions after important actions.
9. Run the test in headed mode.
10. Run the test normally.
11. Check screenshots, traces, or the HTML report if it fails.

## Debug Checklist

If a test fails, check:

- Is the correct environment file loaded?
- Is the base URL correct?
- Did login setup complete?
- Is the required fixture data available?
- Did the page or form finish loading?
- Is a dialog blocking the page?
- Is the locator stable?
- Is the workflow action available for the current document state?
- Does the UI state match the backend state?

## Useful Commands

```bash
npx playwright test
npx playwright test tests/business_workflow.spec.js
npx playwright test -g "workflow"
npx playwright test --workers=1
npx playwright test --headed
npx playwright test --ui
npx playwright test --debug
npx playwright test --trace on
npx playwright show-report
npx playwright codegen http://localhost:8000
```
