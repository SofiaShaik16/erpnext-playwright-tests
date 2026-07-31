import { expect } from "@playwright/test";

export async function openDeliveryNote(page, name) {
	const path = name
		? `/app/delivery-note/${encodeURIComponent(name)}`
		: "/app/delivery-note/new";

	await page.goto(path, { waitUntil: "domcontentloaded" });

	await page.waitForFunction(
		(expectedName) => {
			const frm = window.cur_frm;
			if (!frm || frm.doctype !== "Delivery Note") {
				return false;
			}
			if (!expectedName) {
				return frm.is_new();
			}
			return frm.doc?.name === expectedName;
		},
		name || null,
		{ timeout: 60000 }
	);

	await expect(page.locator('[id^="page-Delivery Note"] .layout-main-section')).toBeVisible();
}

export async function waitForNtptNewFormUi(page) {
	await page.waitForFunction(() => {
		const frm = window.cur_frm;
		if (!frm || !frm.is_new()) {
			return false;
		}
		const orderId = frm.fields_dict.custom_order_id;
		const salesOrders = frm.fields_dict.custom_sales_orders;
		const orderIdReady = !orderId || orderId.df.hidden === 1;
		const salesOrdersReady = !salesOrders || salesOrders.df.read_only === 1;
		return orderIdReady && salesOrdersReady;
	});
}

export async function getDeliveryNote(request, filters, fields = ["name", "docstatus", "is_return"]) {
	const params = new URLSearchParams({
		fields: JSON.stringify(fields),
		filters: JSON.stringify(filters),
		limit_page_length: "1",
		order_by: "modified desc",
	});

	const response = await request.get(`/api/resource/Delivery Note?${params.toString()}`);
	if (!response.ok()) {
		return null;
	}

	const { data } = await response.json();
	return data?.[0] || null;
}

export function getFormUiState(page) {
	return page.evaluate(() => {
		const cint = (value) => parseInt(value, 10) || 0;

		const frm = window.cur_frm;
		if (!frm || frm.doctype !== "Delivery Note") {
			return null;
		}

		const fieldState = (fieldname) => {
			const field = frm.fields_dict[fieldname];
			if (!field) {
				return { exists: false };
			}
			return {
				exists: true,
				hidden: field.df.hidden === 1 || field.$wrapper?.is(":hidden"),
				readOnly: field.df.read_only === 1,
			};
		};

		const gridState = (fieldname) => {
			const grid = frm.fields_dict[fieldname]?.grid;
			if (!grid) {
				return { exists: false };
			}
			return {
				exists: true,
				cannotAddRows: !!grid.cannot_add_rows,
				cannotDeleteRows: !!grid.cannot_delete_rows,
				addRowHidden: grid.wrapper
					? grid.wrapper.find(".grid-add-row").is(":hidden")
					: null,
			};
		};

		const hasButton = (label) =>
			!!frm.page?.inner_toolbar
				?.find?.("button")
				?.filter((_i, el) => (el.textContent || "").trim() === label)?.length;

		const hasCustomFieldButton = (fieldname) => {
			const field = frm.fields_dict[fieldname];
			return !!field?.$wrapper?.find("button").filter((_i, el) => el.offsetParent !== null).length;
		};

		return {
			name: frm.doc?.name || null,
			isNew: frm.is_new(),
			docstatus: frm.doc?.docstatus,
			isReturn: cint(frm.doc?.is_return),
			isSampleOrder: cint(frm.doc?.is_sample_order),
			status: frm.doc?.status,
			itemCount: (frm.doc?.items || []).length,
			orderId: fieldState("custom_order_id"),
			salesOrders: fieldState("custom_sales_orders"),
			onHold: fieldState("custom_on_hold"),
			scanBarcode: fieldState("scan_barcode"),
			packages: fieldState("custom_packages"),
			scannedEntities: fieldState("custom_scanned_entities"),
			nonEntityItems: fieldState("custom_non_entity_items"),
			activePackage: fieldState("custom_active_package"),
			packagesGrid: gridState("custom_packages"),
			scannedEntitiesGrid: gridState("custom_scanned_entities"),
			nonEntityItemsGrid: gridState("custom_non_entity_items"),
			hasAddEntitiesButton: hasCustomFieldButton("custom_add_entities"),
			hasAssignStocksButton: hasCustomFieldButton("custom_assign_stocks"),
			hasPackagePrintCommentButton: !!frm.wrapper?.querySelector(".ntpt-dn-package-print-btn"),
			hasPrintPackageCommentInMenu: !!frm.page?.inner_toolbar
				?.find?.('.dropdown-item:contains("Package Print Comment")')?.length,
			hasItemPrintButtons: !!frm.wrapper?.querySelector(".custom-item-print-btn"),
		};
	});
}

export async function waitForDraftNtptUi(page) {
	await page.waitForFunction(
		() => {
			const frm = window.cur_frm;
			if (!frm || frm.is_new() || frm.doc.docstatus !== 0 || frm.doc.is_return) {
				return false;
			}
			return !!document.querySelector(".ntpt-dn-scan-float");
		},
		undefined,
		{ timeout: 30000 }
	);
}

export async function waitForReturnNtptUi(page) {
	await page.waitForFunction(
		() => {
			const frm = window.cur_frm;
			if (!frm || !frm.doc.is_return) {
				return false;
			}
			const packages = frm.fields_dict.custom_packages;
			if (!packages) {
				return true;
			}
			return packages.df.hidden === 1 || packages.$wrapper?.is(":hidden");
		},
		undefined,
		{ timeout: 30000 }
	);
}

export async function waitForScanFloat(page, visible = true) {
	const locator = page.locator(".ntpt-dn-scan-float");
	if (visible) {
		await expect(locator).toBeVisible({ timeout: 30000 });
	} else {
		await expect(locator).toHaveCount(0);
	}
}
