import { expect } from "@playwright/test";
import { waitForPickListForm } from "./pick_list.js";

export async function openSalesOrder(page, name) {
	const path = name
		? `/app/sales-order/${encodeURIComponent(name)}`
		: "/app/sales-order/new";

	await page.goto(path, { waitUntil: "domcontentloaded" });
	try {
		await waitForSalesOrderForm(page, name);
	} catch (error) {
		if (!name) {
			throw error;
		}

		await routeToSalesOrderForm(page, name);
		await waitForSalesOrderForm(page, name);
	}
}

export async function waitForSalesOrderForm(page, expectedName = null) {
	try {
		await page.waitForFunction(
			(name) => {
				const frm = window.cur_frm;
				if (!frm || frm.doctype !== "Sales Order") {
					return false;
				}
				if (!name) {
					return frm.is_new();
				}
				return frm.doc?.name === name;
			},
			expectedName,
			{ timeout: 60000 }
		);
	} catch (error) {
		const state = await getSalesOrderLoadDebugState(page).catch(() => null);
		throw new Error(
			[
				`Sales Order form did not load${expectedName ? ` for ${expectedName}` : ""}.`,
				state ? `URL: ${state.url}` : null,
				state?.route ? `Route: ${state.route}` : null,
				state?.currentForm
					? `Current form: ${state.currentForm.doctype} ${state.currentForm.name || ""}`.trim()
					: "Current form: none",
				state?.bodyText ? `Page text: ${state.bodyText}` : null,
				`Original error: ${error.message}`,
			]
				.filter(Boolean)
				.join("\n")
		);
	}
	await expect(page.locator('[id^="page-Sales Order"] .layout-main-section')).toBeVisible();
}

async function routeToSalesOrderForm(page, name) {
	await page.goto("/app/sales-order", { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => !!window.frappe?.set_route, undefined, { timeout: 60000 });
	await page.evaluate((salesOrderName) => frappe.set_route("Form", "Sales Order", salesOrderName), name);
}

async function getSalesOrderLoadDebugState(page) {
	return page.evaluate(() => ({
		url: window.location.href,
		route: window.frappe?.get_route?.()?.join("/") || null,
		currentForm: window.cur_frm
			? {
					doctype: window.cur_frm.doctype,
					name: window.cur_frm.doc?.name || null,
			  }
			: null,
		bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1000),
	}));
}

export function getSalesOrderFormState(page) {
	return page.evaluate(() => {
		const frm = window.cur_frm;
		if (!frm || frm.doctype !== "Sales Order") {
			return null;
		}

		const hasCreatePickList = !!frm.page?.inner_toolbar
			?.find?.("button")
			?.filter((_i, el) => (el.textContent || "").includes("Pick List"))?.length;

		return {
			name: frm.doc?.name || null,
			docstatus: frm.doc?.docstatus,
			workflow_state: frm.doc?.workflow_state,
			customer: frm.doc?.customer,
			company: frm.doc?.company,
			per_delivered: frm.doc?.per_delivered,
			hasCreatePickListButton: hasCreatePickList,
			itemCount: (frm.doc?.items || []).length,
		};
	});
}

export async function clickWorkflowAction(page, actionLabel) {
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	const actionsButton = page
		.locator('[id^="page-Sales Order"] .page-actions button')
		.filter({ hasText: "Actions" })
		.first();
	await expect(actionsButton).toBeVisible({ timeout: 15000 });
	await actionsButton.click({ force: true });

	const openMenu = page.locator(".dropdown-menu.show").last();
	await expect(openMenu).toBeVisible({ timeout: 5000 });
	await openMenu.getByText(actionLabel, { exact: true }).click();
}

export async function getAvailableWorkflowActions(page) {
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	const actionsButton = page
		.locator('[id^="page-Sales Order"] .page-actions button')
		.filter({ hasText: "Actions" })
		.first();
	await expect(actionsButton).toBeVisible({ timeout: 15000 });
	await actionsButton.click({ force: true });
	const labels = await page.locator(".dropdown-menu.show a, .dropdown-menu.show .dropdown-item").allTextContents();
	await page.keyboard.press("Escape");
	return labels.map((label) => label.trim()).filter(Boolean);
}

export async function submitSalesOrderViaWorkflow(page) {
	const preferred = ["SO Reviewed", "SO Acknowledged", "Packing Completed", "Submit"];
	let actions = await getAvailableWorkflowActions(page);

	for (const action of preferred) {
		if (!actions.includes(action)) {
			continue;
		}
		await clickWorkflowAction(page, action);
		await page.waitForTimeout(2000);
		actions = await getAvailableWorkflowActions(page).catch(() => []);
	}

	await page.waitForFunction(
		() => {
			const frm = window.cur_frm;
			return frm?.doctype === "Sales Order" && frm.doc?.docstatus === 1;
		},
		undefined,
		{ timeout: 120000 }
	);
}

export async function clickCreateMenuItem(page, itemLabel) {
	await page.getByRole("button", { name: "Create" }).click();
	const item = page
		.getByRole("link", { name: itemLabel })
		.or(page.getByRole("menuitem", { name: itemLabel }))
		.or(page.locator(".dropdown-menu").getByText(itemLabel, { exact: true }));
	await expect(item.first()).toBeVisible({ timeout: 15000 });
	await item.first().click();
}

export async function createPickListFromSalesOrder(page, packageComment = "Playwright E2E PKG") {
	await clickCreateMenuItem(page, "Pick List");

	const dialog = page.locator(".modal-dialog").filter({ hasText: "Package Comment" });
	await expect(dialog).toBeVisible({ timeout: 15000 });

	const commentField = dialog.locator('textarea[data-fieldname="comment"]');
	if (await commentField.isVisible().catch(() => false)) {
		await commentField.fill(packageComment);
	}

	await dialog.getByRole("button", { name: "Create Pick List" }).click();

	await page.waitForURL(/\/app\/pick-list\//, { timeout: 60000 });
	await waitForPickListForm(page);
}
