import { expect } from "@playwright/test";

export async function openPickList(page, name) {
	const path = name
		? `/app/pick-list/${encodeURIComponent(name)}`
		: "/app/pick-list/new";

	await page.goto(path, { waitUntil: "domcontentloaded" });
	await waitForPickListForm(page, name);
}

export async function waitForPickListForm(page, expectedName = null) {
	await page.waitForFunction(
		(name) => {
			const frm = window.cur_frm;
			if (!frm || frm.doctype !== "Pick List") {
				return false;
			}
			if (!name) {
				return frm.is_new() || !!frm.doc?.name;
			}
			return frm.doc?.name === name;
		},
		expectedName,
		{ timeout: 120000 }
	);
	await expect(page.locator('[id^="page-Pick List"] .layout-main-section')).toBeVisible();
}

export function getPickListFormState(page) {
	return page.evaluate(() => {
		const frm = window.cur_frm;
		if (!frm || frm.doctype !== "Pick List") {
			return null;
		}

		const locations = frm.doc?.locations || [];
		const salesOrders = [
			...new Set(locations.map((row) => row.sales_order).filter(Boolean)),
		].sort();

		return {
			name: frm.doc?.name || null,
			docstatus: frm.doc?.docstatus,
			pick_manually: frm.doc?.pick_manually,
			customer: frm.doc?.customer,
			company: frm.doc?.company,
			purpose: frm.doc?.purpose,
			locationCount: locations.length,
			salesOrders,
			warehousesCleared: locations.every((row) => !row.warehouse && !row.batch_no),
			packageComment: frm.doc?.custom_package_print_comment || "",
		};
	});
}

export async function newDeliveryPickList(page, { customer, company }) {
	await openPickList(page);

	await page.evaluate(
		({ customer, company }) =>
			new Promise((resolve, reject) => {
				const frm = window.cur_frm;
				if (!frm) {
					reject(new Error("Pick List form not ready"));
					return;
				}
				frappe.run_serially([
					() => frm.set_value("purpose", "Delivery"),
					() => frm.set_value("company", company),
					() => frm.set_value("customer", customer),
					() => resolve(),
				]);
			}),
		{ customer, company }
	);

	await page.waitForFunction(
		({ customer, company }) => {
			const frm = window.cur_frm;
			return frm?.doc?.customer === customer && frm?.doc?.company === company;
		},
		{ customer, company },
		{ timeout: 30000 }
	);
	await page.waitForTimeout(500);
}

export async function getItemsFromSalesOrders(page, salesOrderNames) {
	await expect(page.getByRole("button", { name: "Get Items" })).toBeVisible({
		timeout: 15000,
	});
	await page.getByRole("button", { name: "Get Items" }).click();

	const dialog = page.locator(".modal-dialog").filter({ hasText: "Select Sales Order" });
	await expect(dialog).toBeVisible({ timeout: 30000 });

	for (const soName of salesOrderNames) {
		const search = dialog.locator('input[data-fieldname="search_term"]');
		if (await search.isVisible().catch(() => false)) {
			await search.fill("");
			await page.waitForTimeout(300);
			await search.fill(soName);
			await page.waitForTimeout(800);
		}

		const link = dialog.getByRole("link", { name: soName });
		await expect(link).toBeVisible({ timeout: 20000 });
		const checkbox = link.locator('xpath=preceding::input[@type="checkbox"][1]');
		if (!(await checkbox.isChecked())) {
			await checkbox.check();
		}
	}

	await page.waitForTimeout(300);

	await dialog.getByRole("button", { name: "Get Items" }).click();

	await page.waitForFunction(
		(expectedCount) => {
			const frm = window.cur_frm;
			return (
				frm?.doctype === "Pick List" &&
				(frm.doc?.locations || []).length >= expectedCount
			);
		},
		1,
		{ timeout: 120000 }
	);

	// NTPT auto-saves after Get Items mapping.
	await page.waitForFunction(
		() => {
			const frm = window.cur_frm;
			return frm?.doctype === "Pick List" && !frm.is_new() && frm.doc?.name;
		},
		undefined,
		{ timeout: 120000 }
	);
}

export async function createDeliveryNoteFromPickListUi(page) {
	const createButton = page.getByRole("button", { name: "Create" });
	await expect(createButton).toBeVisible({ timeout: 15000 });
	await createButton.click();
	await page.getByRole("link", { name: "Delivery Note" }).click();

	await page.waitForURL(/\/app\/delivery-note\//, { timeout: 60000 });
	await page.waitForFunction(
		() => window.cur_frm?.doctype === "Delivery Note",
		undefined,
		{ timeout: 60000 }
	);
}

export async function triggerCreateDeliveryNoteMappedDoc(page) {
	await page.evaluate(() => {
		const frm = window.cur_frm;
		return frappe.model.open_mapped_doc({
			method: "erpnext.stock.doctype.pick_list.pick_list.create_delivery_note",
			frm,
		});
	});
	await page.waitForURL(/\/app\/delivery-note\//, { timeout: 60000 });
}
