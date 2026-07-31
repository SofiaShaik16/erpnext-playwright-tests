import { expect, test } from "@playwright/test";
import {
	getDeliveryNote,
	getFormUiState,
	openDeliveryNote,
	waitForDraftNtptUi,
	waitForNtptNewFormUi,
	waitForReturnNtptUi,
	waitForScanFloat,
} from "./helpers/delivery_note.js";

test.describe("Delivery Note — list and navigation", () => {
	test("opens Delivery Note list after login", async ({ page }) => {
		await page.goto("/app/delivery-note");
		await page.waitForURL(/\/app\/delivery-note/);
		await expect(page.locator(".layout-main-section")).toBeVisible();
	});

	test("list view loads with NTPT customized layout", async ({ page }) => {
		await page.goto("/app/delivery-note");
		await expect(page.locator(".layout-main-section")).toBeVisible();
		await expect(page.getByRole("button", { name: /Add Delivery Note/i })).toBeVisible();
	});
});

test.describe("Delivery Note — new form", () => {
	test("hides Order ID and keeps Sales Orders read-only", async ({ page }) => {
		await openDeliveryNote(page);
		await waitForNtptNewFormUi(page);

		const ui = await getFormUiState(page);
		expect(ui).not.toBeNull();
		if (ui.orderId.exists) {
			expect(ui.orderId.hidden).toBeTruthy();
		}
		if (ui.salesOrders.exists) {
			expect(ui.salesOrders.readOnly).toBeTruthy();
		}
	});

	test("does not show floating scan barcode before save", async ({ page }) => {
		await openDeliveryNote(page);
		await waitForNtptNewFormUi(page);
		await waitForScanFloat(page, false);
	});

	test("keeps On Hold checkbox read-only", async ({ page }) => {
		await openDeliveryNote(page);
		await waitForNtptNewFormUi(page);

		const ui = await getFormUiState(page);
		if (ui.onHold.exists) {
			expect(ui.onHold.readOnly).toBeTruthy();
		}
	});

	test("shows Add Entities and Assign Stocks actions", async ({ page }) => {
		await openDeliveryNote(page);
		await waitForNtptNewFormUi(page);

		await expect(page.getByRole("button", { name: "Add Entities" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Assign Stocks" })).toBeVisible();
	});
});

test.describe("Delivery Note — draft (saved, not submitted)", () => {
	test.describe.configure({ mode: "serial" });

	test("shows floating scan barcode with camera button", async ({ page, request }) => {
		const draft = await getDeliveryNote(request, [
			["docstatus", "=", 0],
			["is_return", "=", 0],
		]);
		test.skip(!draft, "No draft Delivery Note found on site");

		await openDeliveryNote(page, draft.name);
		await waitForDraftNtptUi(page);
		await waitForScanFloat(page, true);
		await expect(page.locator(".ntpt-dn-scan-float input")).toBeVisible();
		await expect(page.locator(".ntpt-dn-scan-float__camera")).toBeVisible();
	});

	test("shows inline Package Print Comment button", async ({ page, request }) => {
		const draft = await getDeliveryNote(request, [
			["docstatus", "=", 0],
			["is_return", "=", 0],
		]);
		test.skip(!draft, "No draft Delivery Note found on site");

		await openDeliveryNote(page, draft.name);
		await waitForDraftNtptUi(page);
		await expect(page.locator(".ntpt-dn-package-print-btn")).toBeVisible();
	});

	test("disables manual add/delete on packages grid", async ({ page, request }) => {
		const draft = await getDeliveryNote(request, [
			["docstatus", "=", 0],
			["is_return", "=", 0],
		]);
		test.skip(!draft, "No draft Delivery Note found on site");

		await openDeliveryNote(page, draft.name);
		await waitForDraftNtptUi(page);
		await page.waitForFunction(() => {
			const grid = window.cur_frm?.fields_dict?.custom_packages?.grid;
			return grid && (grid.cannot_add_rows === true || grid.wrapper?.find(".grid-add-row").is(":hidden"));
		});
		const ui = await getFormUiState(page);

		expect(ui.packagesGrid.exists).toBeTruthy();
		expect(ui.packagesGrid.cannotAddRows || ui.packagesGrid.addRowHidden).toBeTruthy();
		expect(ui.packagesGrid.cannotDeleteRows).toBeTruthy();
	});

	test("disables manual add on scanned entities grid", async ({ page, request }) => {
		const draft = await getDeliveryNote(request, [
			["docstatus", "=", 0],
			["is_return", "=", 0],
		]);
		test.skip(!draft, "No draft Delivery Note found on site");

		await openDeliveryNote(page, draft.name);
		await waitForDraftNtptUi(page);
		const ui = await getFormUiState(page);

		expect(ui.scannedEntitiesGrid.exists).toBeTruthy();
		expect(ui.scannedEntitiesGrid.cannotAddRows || ui.scannedEntitiesGrid.addRowHidden).toBeTruthy();
	});

	test("shows item row Print buttons when items exist", async ({ page, request }) => {
		const draft = await getDeliveryNote(request, [
			["docstatus", "=", 0],
			["is_return", "=", 0],
		]);
		test.skip(!draft, "No draft Delivery Note found on site");

		await openDeliveryNote(page, draft.name);
		test.skip(!(await getFormUiState(page))?.itemCount, "Draft DN has no item rows");

		await page.waitForFunction(
			() => !!document.querySelector(".custom-item-print-btn"),
			undefined,
			{ timeout: 15000 }
		);
		await expect(page.locator(".custom-item-print-btn").first()).toBeVisible();
	});

	test("scan float clears after barcode input", async ({ page, request }) => {
		const draft = await getDeliveryNote(request, [
			["docstatus", "=", 0],
			["is_return", "=", 0],
		]);
		test.skip(!draft, "No draft Delivery Note found on site");

		await openDeliveryNote(page, draft.name);
		await waitForDraftNtptUi(page);
		await waitForScanFloat(page, true);

		const input = page.locator(".ntpt-dn-scan-float input");
		await input.fill("PLAYWRIGHT-TEST-BARCODE");
		await page.waitForTimeout(600);

		await expect(input).toHaveValue("");
	});

	test("removes scan float when navigating away (SPA)", async ({ page, request }) => {
		const draft = await getDeliveryNote(request, [
			["docstatus", "=", 0],
			["is_return", "=", 0],
		]);
		test.skip(!draft, "No draft Delivery Note found on site");

		await openDeliveryNote(page, draft.name);
		await waitForDraftNtptUi(page);
		await waitForScanFloat(page, true);

		await page.goto("/app/delivery-note");
		await page.waitForURL(/\/app\/delivery-note$/);
		await waitForScanFloat(page, false);
	});
});

test.describe("Delivery Note — submitted", () => {
	test("does not show floating scan barcode", async ({ page, request }) => {
		const submitted = await getDeliveryNote(request, [
			["docstatus", "=", 1],
			["is_return", "=", 0],
		]);
		test.skip(!submitted, "No submitted Delivery Note found on site");

		await openDeliveryNote(page, submitted.name);
		await waitForScanFloat(page, false);
	});

	test("does not show inline Package Print Comment button", async ({ page, request }) => {
		const submitted = await getDeliveryNote(request, [
			["docstatus", "=", 1],
			["is_return", "=", 0],
		]);
		test.skip(!submitted, "No submitted Delivery Note found on site");

		await openDeliveryNote(page, submitted.name);
		await expect(page.locator(".ntpt-dn-package-print-btn")).toHaveCount(0);
	});

	test("shows Stock Ledger - NTPT under View menu", async ({ page, request }) => {
		const submitted = await getDeliveryNote(request, [
			["docstatus", "=", 1],
			["is_return", "=", 0],
		]);
		test.skip(!submitted, "No submitted Delivery Note found on site");

		await openDeliveryNote(page, submitted.name);
		await page.getByRole("button", { name: "View" }).click();
		await expect(page.getByRole("link", { name: "Stock Ledger - NTPT" })).toBeVisible();
	});
});

test.describe("Delivery Note — return", () => {
	test.describe.configure({ mode: "serial" });

	test("hides scan barcode UI", async ({ page, request }) => {
		const returnDoc = await getDeliveryNote(request, [["is_return", "=", 1]]);
		test.skip(!returnDoc, "No return Delivery Note found on site");

		await openDeliveryNote(page, returnDoc.name);
		await waitForScanFloat(page, false);

		const ui = await getFormUiState(page);
		if (ui.scanBarcode.exists) {
			expect(ui.scanBarcode.hidden).toBeTruthy();
		}
	});

	test("hides packages, scanned entities, and non-entity sections", async ({ page, request }) => {
		const returnDoc = await getDeliveryNote(request, [["is_return", "=", 1]]);
		test.skip(!returnDoc, "No return Delivery Note found on site");

		await openDeliveryNote(page, returnDoc.name);
		await waitForReturnNtptUi(page);
		const ui = await getFormUiState(page);

		if (ui.packages.exists) {
			expect(ui.packages.hidden).toBeTruthy();
		}
		if (ui.scannedEntities.exists) {
			expect(ui.scannedEntities.hidden).toBeTruthy();
		}
		if (ui.nonEntityItems.exists) {
			expect(ui.nonEntityItems.hidden).toBeTruthy();
		}
		if (ui.activePackage.exists) {
			expect(ui.activePackage.hidden).toBeTruthy();
		}
	});

	test("keeps On Hold read-only", async ({ page, request }) => {
		const returnDoc = await getDeliveryNote(request, [["is_return", "=", 1]]);
		test.skip(!returnDoc, "No return Delivery Note found on site");

		await openDeliveryNote(page, returnDoc.name);
		const ui = await getFormUiState(page);
		if (ui.onHold.exists) {
			expect(ui.onHold.readOnly).toBeTruthy();
		}
	});
});

test.describe("Delivery Note — sample order", () => {
	test("submitted returnable sample order shows Sample Return action", async ({ page, request }) => {
		const sample = await getDeliveryNote(request, [
			["docstatus", "=", 1],
			["is_return", "=", 0],
			["is_sample_order", "=", 1],
			["is_sample_order_returnable", "=", 1],
		]);
		test.skip(!sample, "No returnable sample Delivery Note found on site");

		await openDeliveryNote(page, sample.name);
		await page.waitForTimeout(1200);

		await expect(page.getByRole("button", { name: "Sample Return" })).toBeVisible();
	});
});
