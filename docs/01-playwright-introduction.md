# Playwright Guide - Part 1: Getting Started

## Introduction

Playwright is an end-to-end testing framework for modern web applications. It allows developers to automate real browser actions such as opening pages, logging in, clicking buttons, filling forms, submitting documents, and verifying that the expected result appears on screen.

For a business application like ERPNext/Frappe, Playwright is useful because many workflows depend on both backend data and frontend behavior. A workflow may look correct in code, but still fail for a user because a button is hidden, a field is not editable, a page takes longer to load, or a custom script behaves differently after a change. Playwright helps catch these problems by testing the application as a user would use it.

## Purpose of Playwright Testing

The main purpose of Playwright testing is to protect important workflows from breaking during development.

In this platform, Playwright can be used to test scenarios such as:

- Opening ERPNext forms and list views
- Verifying custom buttons, fields, and layouts
- Checking whether fields are visible, hidden, required, or read-only
- Creating and submitting business documents
- Testing multi-step flows such as Sales Order, Pick List, Delivery Note, packing, scanning, and manufacturing flows
- Confirming that frontend customizations still work after code changes
- Reproducing issues consistently during debugging

These tests are especially useful when the same checks must be repeated after every change, deployment, or release.

## Why Developers Should Use It

Manual testing is important, but it becomes slow and unreliable when workflows are large or repetitive. Playwright reduces that effort by turning important checks into automated tests.

Using Playwright gives developers several advantages:

- Faster feedback after making code changes
- Better confidence before deploying to another environment
- Easier debugging when a workflow fails
- Clear proof that a feature works as expected
- Reduced risk of breaking existing business flows
- Repeatable testing across local, staging, and UAT environments

Playwright does not replace developer understanding or manual review. It supports them by repeatedly checking the behavior that matters most.

## How Playwright Works

Playwright runs tests inside real browsers. A test usually follows this flow:

1. Start a browser.
2. Open the target application.
3. Use an authenticated session or perform login.
4. Navigate to a page or form.
5. Perform user actions such as click, fill, select, save, or submit.
6. Wait for the application to finish loading or updating.
7. Assert that the expected UI or data is present.
8. Save debugging information if the test fails.

Example:

```js
import { expect, test } from "@playwright/test";

test("opens Delivery Note list", async ({ page }) => {
	await page.goto("/app/delivery-note");
	await expect(page.locator(".layout-main-section")).toBeVisible();
	await expect(page.getByRole("button", { name: /Add Delivery Note/i })).toBeVisible();
});
```

This test opens the Delivery Note list and confirms that the main page area and the Add Delivery Note button are visible.

## Key Concepts

### Test

A test is one automated scenario. It should verify one clear behavior or one small part of a workflow.

```js
test("shows Add Delivery Note button", async ({ page }) => {
	await page.goto("/app/delivery-note");
	await expect(page.getByRole("button", { name: /Add Delivery Note/i })).toBeVisible();
});
```

### Page

`page` represents a browser tab. Developers use it to navigate, click, type, and inspect the UI.

Common examples:

```js
await page.goto("/app/delivery-note");
await page.getByRole("button", { name: "Save" }).click();
await page.locator('[data-fieldname="customer"]').fill("Customer Name");
```

### Locator

A locator tells Playwright how to find an element on the page.

Examples:

```js
page.getByRole("button", { name: "Save" })
page.locator(".layout-main-section")
page.locator('[data-fieldname="customer"]')
```

Prefer meaningful locators such as role, label, text, or stable attributes. Avoid depending on fragile CSS selectors unless there is no better option.

### Assertion

An assertion checks that something is true.

```js
await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
```

If the expected condition is not met, the test fails.

### Fixture

A fixture is a reusable object or setup provided to a test.

Common Playwright fixtures include:

- `page` for browser UI testing
- `request` for API calls
- `context` for browser session handling
- `browser` for browser-level control

For Frappe/ERPNext testing, `page` is useful for UI workflows and `request` is useful for creating, reading, or preparing backend data through APIs.

### Global Setup

Global setup is code that runs before the test suite starts. It is commonly used for login, test data preparation, or shared setup required by all tests.

For this platform, global setup can log in once and save the browser session. The tests can then reuse that session instead of logging in manually in every test.

## Installation

Playwright requires Node.js and npm.

To install Playwright in an existing JavaScript project:

```bash
npm install
npx playwright install
```

If Playwright is being added to a new project for the first time:

```bash
npm init playwright@latest
```

This command creates the basic Playwright setup, including a configuration file, test folder, and example test.

In an existing project, check `package.json` for Playwright scripts and dependencies.

### Playwright Plugin Option

Playwright can also be used through a Playwright plugin when the development environment supports plugins. This can help with installation and setup because the plugin may provide Playwright commands, browser installation support, test running tools, or integration with the editor.

If a Playwright plugin is available, install and enable it first, then confirm that the project still has the required Playwright dependencies and browser binaries installed. The plugin is a helpful setup tool, but the project should still keep its Playwright configuration, tests, and npm scripts in version control.

## Environment Setup

Automated tests usually need environment values so they can run against different sites without changing test code.

Typical values include:

```text
FRAPPE_BASE_URL=http://localhost:8000
FRAPPE_USER=Administrator
FRAPPE_PASSWORD=your-password
```

Use separate environment files for separate environments when needed:

- `.env` for local development
- `.env.uat` for UAT testing
- CI/CD variables for pipeline execution

Do not hard-code passwords, tokens, or site-specific secrets in test files.

## Running Tests

Run all Playwright tests:

```bash
npx playwright test
```

Run one test file:

```bash
npx playwright test tests/delivery_note.spec.js
```

Run tests with the browser visible:

```bash
npx playwright test --headed
```

Run tests in interactive UI mode:

```bash
npx playwright test --ui
```

Run tests in debug mode:

```bash
npx playwright test --debug
```

Run tests matching a title:

```bash
npx playwright test -g "Delivery Note"
```

Run tests one by one:

```bash
npx playwright test --workers=1
```

Project-specific shortcuts may also be available through npm scripts. Check `package.json` before running tests.

## Writing a Good Playwright Test

A good Playwright test should be clear, stable, and focused.

Recommended structure:

1. Prepare the required data.
2. Open the required page.
3. Perform the user action.
4. Assert the expected result.
5. Clean up only if the test created data that should not remain.

Example:

```js
test("shows scan field on saved Delivery Note", async ({ page }) => {
	await page.goto("/app/delivery-note/DN-0001");
	await expect(page.locator(".ntpt-dn-scan-float input")).toBeVisible();
});
```

Keep test names readable. A future developer should understand the purpose of the test without reading every line of code.

## Debugging Failed Tests

When a test fails, Playwright can help identify what happened.

Useful commands:

```bash
npx playwright test --headed
npx playwright test --debug
npx playwright test --ui
npx playwright show-report
```

Common things to check:

- Is the Frappe site running?
- Is the base URL correct?
- Are the username and password correct?
- Does the required test data exist?
- Did the page take longer than expected to load?
- Did the UI text, button name, or field name change?
- Is the test depending on data that is different in another environment?

When a failure happens in CI or during retry, Playwright can capture screenshots, traces, and reports depending on the project configuration.

## Testing With Frappe/ERPNext

Frappe and ERPNext pages are dynamic. Forms often load scripts, permissions, custom fields, child tables, buttons, and workflow actions after the first page navigation. Because of this, tests should wait for meaningful UI conditions before making assertions.

Good examples:

```js
await page.goto("/app/delivery-note");
await expect(page.locator(".layout-main-section")).toBeVisible();
```

```js
await page.goto("/app/sales-order/SO-0001");
await expect(page.locator('[data-fieldname="customer"]')).toBeVisible();
```

For business workflows, try to separate responsibilities:

- Use helpers to create or fetch test data.
- Use page actions to test real user behavior.
- Use assertions to confirm the result.
- Use clear test names so failures are easy to understand.

## Summary

Playwright helps developers test this platform from the user’s point of view. It is used to automate browser workflows, verify UI behavior, and protect important ERPNext/Frappe customizations from regressions.

A developer working on this platform should understand:

- What workflow is being tested
- What data the test needs
- Which page actions represent the user behavior
- Which assertions prove that the behavior is correct
- How to run and debug the test when it fails

Good Playwright tests should be readable, focused, repeatable, and connected to real business value.

## References

- [Playwright installation documentation](https://playwright.dev/docs/intro)
- [Playwright command line documentation](https://playwright.dev/docs/test-cli)
