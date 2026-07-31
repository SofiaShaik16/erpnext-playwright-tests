import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	createInternalSalesOrderWorkflowFixtureFromInput,
	getInternalOrderRateSnapshot,
	getInternalOrderChainState,
	getPricingRuleRate,
	loadSalesOrderInput,
} from "./helpers/logistics_data.js";
import { remoteCallFrappeMethod } from "./helpers/frappe_api.js";
import { openSalesOrder } from "./helpers/sales_order.js";

async function waitForForm(page, doctype, name = null) {
	await page.waitForFunction(
		({ doctype: expectedDoctype, name: expectedName }) => {
			const frm = window.cur_frm;
			if (!frm || frm.doctype !== expectedDoctype) {
				return false;
			}
			if (!expectedName) {
				return true;
			}
			return frm.doc?.name === expectedName;
		},
		{ doctype, name },
		{ timeout: 60000 }
	);
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	await dismissNonWorkflowDialogs(page);
}

async function openForm(page, doctype, name) {
	const slug = doctype.toLowerCase().replaceAll(" ", "-");
	const route = `/app/${slug}/${encodeURIComponent(name)}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await page.goto(route, { waitUntil: "domcontentloaded" });
		try {
			await waitForForm(page, doctype, name);
			return;
		} catch (error) {
			if (attempt === 1) {
				throw error;
			}
			await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
		}
	}
}

async function getCurrentDoc(page) {
	return page.evaluate(() => {
		const doc = window.cur_frm?.doc;
		return doc
			? {
					name: doc.name,
					doctype: doc.doctype,
					docstatus: doc.docstatus,
					workflow_state: doc.workflow_state,
					status: doc.status,
					delivery_date: doc.delivery_date,
					delivery_terms: doc.delivery_terms,
					named_place: doc.named_place,
					payment_terms_template: doc.payment_terms_template,
					custom_internal_order_required: doc.custom_internal_order_required,
					custom_source_of_order: doc.custom_source_of_order,
					custom_type_of_order: doc.custom_type_of_order,
					custom_sale_order: doc.custom_sale_order,
					inter_company_order_reference: doc.inter_company_order_reference,
					item_count: (doc.items || []).length,
				}
			: null;
	});
}

async function getFirstSalesOrderItemPricing(page) {
	return page.evaluate(() => {
		const row = window.cur_frm?.doc?.items?.[0];
		return row
			? {
					item_code: row.item_code,
					qty: Number(row.qty || 0),
					price_list_rate: Number(row.price_list_rate || 0),
					rate: Number(row.rate || 0),
					net_rate: Number(row.net_rate || 0),
					amount: Number(row.amount || 0),
					net_amount: Number(row.net_amount || 0),
				}
			: null;
	});
}

async function setFirstSalesOrderItemManualRate(page, manualRate) {
	const itemUpdate = await page.evaluate((rate) => {
		const frm = window.cur_frm;
		if (!frm || frm.doctype !== "Sales Order") {
			throw new Error("Current form is not Sales Order");
		}

		const row = frm.doc.items?.[0];
		if (!row) {
			throw new Error("Sales Order has no item rows");
		}

		return {
			parent_doctype: frm.doc.doctype,
			parent_doctype_name: frm.doc.name,
			child_docname: "items",
			row: {
				docname: row.name,
				name: row.name,
				idx: row.idx,
				item_code: row.item_code,
				custom_item_pricelist: row.custom_item_pricelist,
				qty: row.qty,
				rate,
				uom: row.uom,
				conversion_factor: row.conversion_factor,
				delivery_date: row.delivery_date || frm.doc.delivery_date,
				custom_return_quantity: row.custom_return_quantity || 0,
			},
		};
	}, manualRate);

	await remoteCallFrappeMethod("frappe.client.set_value", {
		doctype: itemUpdate.parent_doctype,
		name: itemUpdate.parent_doctype_name,
		fieldname: "ignore_pricing_rule",
		value: 1,
	});
	await remoteCallFrappeMethod("erpnext.controllers.accounts_controller.update_child_qty_rate", {
		parent_doctype: itemUpdate.parent_doctype,
		parent_doctype_name: itemUpdate.parent_doctype_name,
		child_docname: itemUpdate.child_docname,
		trans_items: JSON.stringify([itemUpdate.row]),
	});

	await reloadCurrentForm(page);
}

async function acceptVisibleDialog(page) {
	const dialog = page.locator(".modal-dialog:visible").last();
	if (!(await dialog.isVisible().catch(() => false))) {
		return;
	}

	const text = (await dialog.innerText().catch(() => "")).trim();
	const yes = dialog.getByRole("button", { name: /^(Yes|Confirm|OK)$/i }).last();
	if (/Internal order required/i.test(text) && (await yes.isVisible().catch(() => false))) {
		await yes.click();
		await page.locator(".modal-dialog:visible").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
		return;
	}

	await closeVisibleDialog(page);
}

async function closeVisibleDialog(page) {
	const dialog = page.locator(".modal-dialog:visible").last();
	if (!(await dialog.isVisible().catch(() => false))) {
		return false;
	}

	const closeButton = dialog
		.locator(
			'.modal-header .btn-close, .modal-header .close, .modal-header button, [aria-label="Close"]'
		)
		.last();
	if (await closeButton.isVisible().catch(() => false)) {
		await closeButton.click();
		await page.locator(".modal-dialog:visible").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
		return true;
	}

	await page.keyboard.press("Escape").catch(() => {});
	await page.locator(".modal-dialog:visible").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	return true;
}

async function dismissNonWorkflowDialogs(page) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const dialog = page.locator(".modal-dialog:visible").last();
		if (!(await dialog.isVisible().catch(() => false))) {
			return;
		}
		const text = (await dialog.innerText().catch(() => "")).trim();
		if (/Internal order required/i.test(text)) {
			return;
		}
		await closeVisibleDialog(page);
	}
}

async function getWorkflowActions(page, doctype) {
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	const openMenu = await openActionsMenu(page, doctype);
	const labels = await openMenu.locator("a, .dropdown-item").allTextContents();
	await page.keyboard.press("Escape");
	return labels.map((label) => label.trim()).filter(Boolean);
}

async function openActionsMenu(page, doctype) {
	const actionsButton = page
		.locator(`[id^="page-${doctype}"] .page-actions button`)
		.filter({ hasText: "Actions" })
		.last();
	await expect(actionsButton).toBeVisible({ timeout: 15000 });

	for (let attempt = 0; attempt < 5; attempt += 1) {
		await dismissNonWorkflowDialogs(page);
		try {
			await actionsButton.click({ timeout: 5000 });
		} catch (error) {
			if (await closeVisibleDialog(page)) {
				continue;
			}
			throw error;
		}
		const openMenu = page.locator(".dropdown-menu:visible").last();
		if (await openMenu.isVisible({ timeout: 3000 }).catch(() => false)) {
			return openMenu;
		}
		await page.keyboard.press("Escape").catch(() => {});
		await page.waitForTimeout(300);
	}

	throw new Error(`Actions menu did not open for ${doctype}`);
}

async function runWorkflowAction(page, doctype, actionLabel, expectedState = null) {
	const before = await getCurrentDoc(page);
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	await dismissNonWorkflowDialogs(page);

	const openMenu = await openActionsMenu(page, doctype);
	await openMenu.getByText(actionLabel, { exact: true }).click();
	await page.waitForTimeout(500);
	await acceptVisibleDialog(page);
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 60000 }).catch(() => {});

	const blockingModal = page.locator(".modal-dialog:visible").last();
	if (await blockingModal.isVisible().catch(() => false)) {
		const modalText = (await blockingModal.innerText().catch(() => "")).trim();
		throw new Error(`Workflow action "${actionLabel}" was blocked by dialog:\n${modalText}`);
	}

	if (expectedState) {
		await page.waitForFunction(
			({ doctype: expectedDoctype, state }) =>
				window.cur_frm?.doctype === expectedDoctype &&
				window.cur_frm?.doc?.workflow_state === state,
			{ doctype, state: expectedState },
			{ timeout: 120000 }
		);
	} else {
		await page.waitForFunction(
			({ doctype: expectedDoctype, previousState }) =>
				window.cur_frm?.doctype === expectedDoctype &&
				window.cur_frm?.doc?.workflow_state !== previousState,
			{ doctype, previousState: before?.workflow_state },
			{ timeout: 120000 }
		);
	}
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
}

async function reloadCurrentForm(page) {
	const doc = await getCurrentDoc(page);
	await page.reload({ waitUntil: "domcontentloaded" });
	await waitForForm(page, doc.doctype, doc.name);
}

async function runWorkflowActionIfAvailable(page, doctype, actionLabel, expectedState = null) {
	const actions = await getWorkflowActions(page, doctype);
	if (!actions.includes(actionLabel)) {
		return false;
	}
	await runWorkflowAction(page, doctype, actionLabel, expectedState);
	return true;
}

async function runWorkflowActionInForm(page, doctype, actionLabel, expectedState) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await waitForForm(page, doctype);
		await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
		try {
			await page.evaluate(
				async ({ expectedDoctype, action }) => {
					const frm = window.cur_frm;
					if (!frm || frm.doctype !== expectedDoctype) {
						throw new Error(`Current form is not ${expectedDoctype}`);
					}

					frappe.dom.freeze();
					try {
						frm._last_workflow_state = frm.doc.workflow_state;
						frm.selected_workflow_action = action;
						const doc = await frappe.xcall("frappe.model.workflow.apply_workflow", {
							doc: frm.doc,
							action,
						});
						frappe.model.sync(doc);
						await frm.refresh();
						frm.selected_workflow_action = null;
						await frm.script_manager.trigger("after_workflow_action");
					} finally {
						frappe.dom.unfreeze();
					}
				},
				{ expectedDoctype: doctype, action: actionLabel }
			);
			break;
		} catch (error) {
			const current = await getCurrentDoc(page).catch(() => null);
			if (current?.workflow_state === expectedState) {
				break;
			}
			if (
				attempt < 2 &&
				/execution context was destroyed|navigation/i.test(error.message || "")
			) {
				await page.waitForLoadState("domcontentloaded").catch(() => {});
				continue;
			}
			throw error;
		}
	}

	try {
		await page.waitForFunction(
			({ expectedDoctype, state }) =>
				window.cur_frm?.doctype === expectedDoctype &&
				window.cur_frm?.doc?.workflow_state === state,
			{ expectedDoctype: doctype, state: expectedState },
			{ timeout: 120000 }
		);
	} catch (error) {
		await reloadCurrentForm(page).catch(() => {});
		const current = await getCurrentDoc(page).catch(() => null);
		if (current?.workflow_state !== expectedState) {
			throw error;
		}
	}
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
}

async function ensureSalesOrderAcknowledged(page) {
	const doc = await getCurrentDoc(page);
	if (doc?.workflow_state === "Acknowledged") {
		return;
	}

	if (doc?.workflow_state === "On Hold") {
		await runWorkflowActionInForm(page, "Sales Order", "Production Pending", "Acknowledged");
		return;
	}

	throw new Error(`Sales Order is ${doc?.workflow_state}, expected Acknowledged or On Hold`);
}

async function clickCreateMenuItem(page, labels) {
	const labelList = Array.isArray(labels) ? labels : [labels];
	const createButton = page.getByRole("button", { name: "Create" });

	for (let attempt = 0; attempt < 5; attempt += 1) {
		await dismissNonWorkflowDialogs(page);
		try {
			await createButton.click({ timeout: 5000 });
		} catch (error) {
			if (await closeVisibleDialog(page)) {
				continue;
			}
			throw error;
		}

		for (const label of labelList) {
			const item = page
				.getByRole("link", { name: label })
				.or(page.getByRole("menuitem", { name: label }))
				.or(page.locator(".dropdown-menu.show").getByText(label, { exact: true }))
				.first();
			if (await item.isVisible().catch(() => false)) {
				await item.click();
				return label;
			}
		}

		await page.keyboard.press("Escape").catch(() => {});
		await page.waitForTimeout(300);
	}

	throw new Error(`None of the Create menu items were visible: ${labelList.join(", ")}`);
}

async function saveCurrentForm(page, doctype) {
	await page.getByRole("button", { name: "Save" }).click();
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 60000 }).catch(() => {});
	await page.waitForFunction(
		(expectedDoctype) => {
			const frm = window.cur_frm;
			return frm?.doctype === expectedDoctype && !frm.is_new?.() && !!frm.doc?.name;
		},
		doctype,
		{ timeout: 120000 }
	);
}

function waitForChain(initialSoName, predicate, timeout = 120000) {
	return expect
			.poll(
				async () => {
					const state = await getInternalOrderChainState(initialSoName);
					return predicate(state) ? state : null;
				},
				{ timeout, intervals: [1000, 2000, 5000] }
		)
		.not.toBeNull();
}

function buildPricingRuleRateInput(input) {
	const copy = JSON.parse(JSON.stringify(input));
	const doc = copy.document;
	const firstItem = doc.items?.[0];
	if (!firstItem) {
		throw new Error("sales_order.json fixture must include at least one item");
	}

	doc.ignore_pricing_rule = 1;
	doc.total = 800;
	doc.net_total = 800;
	doc.grand_total = 800;
	doc.rounded_total = 800;
	doc.base_total = 800;
	doc.base_net_total = 800;
	doc.base_grand_total = 800;
	doc.base_rounded_total = 800;
	doc.items = [firstItem];
	doc.taxes = [];
	doc.pricing_rules = [];

	Object.assign(firstItem, {
		item_code: pricingRule.businessId,
		custom_product_code: pricingRule.businessId,
		item_name: pricingRule.itemName,
		description: pricingRule.itemName,
		item_group: "Fitted Driver Shafts",
		uom: pricingRule.uom,
		stock_uom: pricingRule.uom,
		conversion_factor: 1,
		qty: 1,
		stock_qty: 1,
		price_list_rate: 800,
		base_price_list_rate: 800,
		rate: 800,
		base_rate: 800,
		net_rate: 800,
		base_net_rate: 800,
		stock_uom_rate: 800,
		amount: 800,
		base_amount: 800,
		net_amount: 800,
		base_net_amount: 800,
		discount_percentage: 0,
		discount_amount: 0,
		pricing_rules: null,
	});

	return copy;
}

function expectRateClose(actual, expected, message, precision = 2) {
	const received = Number(actual);
	const tolerance = 0.5 * 10 ** -precision;
	if (!Number.isFinite(received) || Math.abs(received - expected) >= tolerance) {
		throw new Error(`${message}: expected ${expected}, received ${actual}`);
	}
}

function parsePricingRules(value) {
	if (!value) {
		return [];
	}
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "string") {
		return [];
	}
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return value
			.split(/[\n,]+/)
			.map((rule) => rule.trim())
			.filter(Boolean);
	}
}

async function createAcknowledgedInternalOrder(page, context, input) {
	const fixture = await createInternalSalesOrderWorkflowFixtureFromInput(input);
	expect(fixture?.ok, fixture?.reason || "Fixture creation failed").toBeTruthy();

	await openSalesOrder(page, fixture.name);
	await runWorkflowAction(page, "Sales Order", "SO Reviewed", "Received and Pending Approval");

	const popupPromise = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
	await runWorkflowActionInForm(page, "Sales Order", "SO Acknowledged", "Acknowledged");
	const popup = await popupPromise;
	if (popup && popup !== page) {
		await popup.close().catch(() => {});
	}

	await waitForChain(fixture.name, (state) => !!state?.internal_po);
	return fixture.name;
}

const pricingRule = {
	businessId: "I-0932",
	itemName: "Fitted Driver Power Shaft (With Grip and Adapter)",
	uom: "Pcs",
	currency: "USD",
};
const manualSalesOrderRate = 512;
const flow = {
	initialSoName: null,
	internalPoName: null,
	internalSoName: null,
};
const flowStatePath = path.join(process.cwd(), "test-results", "internal_so_workflow_state.json");
const flowScreenshotDir = path.join(process.cwd(), "test-results", "internal_so_workflow_screenshots");

function resetFlowState() {
	fs.rmSync(flowStatePath, { force: true });
	fs.rmSync(flowScreenshotDir, { recursive: true, force: true });
}

function saveFlowState() {
	fs.mkdirSync(path.dirname(flowStatePath), { recursive: true });
	fs.writeFileSync(flowStatePath, JSON.stringify(flow, null, 2));
}

function loadFlowState() {
	if (!fs.existsSync(flowStatePath)) {
		return;
	}

	Object.assign(flow, JSON.parse(fs.readFileSync(flowStatePath, "utf8")));
}

function requireFlowState(...fieldnames) {
	loadFlowState();
	for (const fieldname of fieldnames) {
		if (!flow[fieldname]) {
			throw new Error(`Missing workflow state "${fieldname}". Run the earlier workflow tests first.`);
		}
	}
}

function cleanScreenshotName(value) {
	return String(value || "unsaved")
		.replace(/[^a-z0-9._-]+/gi, "-")
		.replace(/^-+|-+$/g, "");
}

async function captureWorkflowScreenshot(page, testInfo, sequence, label) {
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	await dismissNonWorkflowDialogs(page);
	await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

	const doc = await getCurrentDoc(page);
	const fileName = `${sequence}-${cleanScreenshotName(label)}-${cleanScreenshotName(doc?.name)}.png`;
	const screenshotPath = path.join(flowScreenshotDir, fileName);
	fs.mkdirSync(flowScreenshotDir, { recursive: true });
	await page.screenshot({ path: screenshotPath, fullPage: true });

	if (testInfo) {
		await testInfo.attach(fileName, {
			path: screenshotPath,
			contentType: "image/png",
		});
	}
}

async function captureItemsTableScreenshot(page, testInfo, sequence, label) {
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	await dismissNonWorkflowDialogs(page);
	await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

	const doc = await getCurrentDoc(page);
	await page.evaluate(() => {
		const existing = document.getElementById("pw-items-table-capture");
		if (existing) {
			existing.remove();
		}

		const frm = window.cur_frm;
		const items = frm?.doc?.items || [];
		if (!frm || !items.length) {
			throw new Error("Current form has no items rows to capture");
		}

		const ignoredFieldnames = new Set([
			"doctype",
			"parent",
			"parentfield",
			"parenttype",
			"owner",
			"creation",
			"modified",
			"modified_by",
			"docstatus",
		]);
		const ignoredFieldtypes = new Set([
			"Section Break",
			"Column Break",
			"Tab Break",
			"Fold",
			"Button",
			"HTML",
			"Table",
		]);
		const gridFields = frm.fields_dict?.items?.grid?.docfields || [];
		const fieldMeta = new Map();

		for (const df of gridFields) {
			if (!df.fieldname || ignoredFieldnames.has(df.fieldname) || ignoredFieldtypes.has(df.fieldtype)) {
				continue;
			}
			fieldMeta.set(df.fieldname, {
				label: df.label || df.fieldname,
				idx: df.idx || fieldMeta.size,
			});
		}

		for (const item of items) {
			for (const fieldname of Object.keys(item)) {
				if (!fieldMeta.has(fieldname) && !ignoredFieldnames.has(fieldname)) {
					fieldMeta.set(fieldname, { label: fieldname, idx: fieldMeta.size });
				}
			}
		}

		const hasValue = (value) =>
			value !== undefined &&
			value !== null &&
			value !== "" &&
			!(Array.isArray(value) && value.length === 0);
		const formatValue = (value) => {
			if (Array.isArray(value)) {
				return value.length ? JSON.stringify(value) : "";
			}
			if (typeof value === "object" && value !== null) {
				return JSON.stringify(value);
			}
			return String(value);
		};
		const escapeHtml = (value) =>
			String(value)
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;")
				.replaceAll('"', "&quot;")
				.replaceAll("'", "&#39;");

		const fields = Array.from(fieldMeta.entries()).sort((a, b) => a[1].idx - b[1].idx);
		const rows = [];
		for (const item of items) {
			for (const [fieldname, meta] of fields) {
				const value = item[fieldname];
				if (!hasValue(value)) {
					continue;
				}
				rows.push({
					itemIndex: item.idx || items.indexOf(item) + 1,
					itemCode: item.item_code || "",
					field: meta.label,
					fieldname,
					value: formatValue(value),
				});
			}
		}

		const wrapper = document.createElement("div");
		wrapper.id = "pw-items-table-capture";
		wrapper.innerHTML = `
			<style>
				#pw-items-table-capture {
					position: absolute;
					top: 0;
					left: 0;
					z-index: 2147483647;
					width: 1400px;
					padding: 24px;
					background: #ffffff;
					color: #111827;
					font-family: Arial, sans-serif;
					font-size: 12px;
					line-height: 1.35;
				}
				#pw-items-table-capture h1 {
					margin: 0 0 6px;
					font-size: 20px;
					font-weight: 700;
				}
				#pw-items-table-capture .meta {
					margin: 0 0 16px;
					color: #4b5563;
					font-size: 12px;
				}
				#pw-items-table-capture table {
					width: 100%;
					border-collapse: collapse;
					table-layout: fixed;
				}
				#pw-items-table-capture th,
				#pw-items-table-capture td {
					border: 1px solid #d1d5db;
					padding: 6px 8px;
					vertical-align: top;
					overflow-wrap: anywhere;
					white-space: pre-wrap;
				}
				#pw-items-table-capture th {
					background: #f3f4f6;
					font-weight: 700;
					text-align: left;
				}
				#pw-items-table-capture tbody tr:nth-child(even) td {
					background: #f9fafb;
				}
				#pw-items-table-capture .row-col {
					width: 70px;
				}
				#pw-items-table-capture .item-col {
					width: 170px;
				}
				#pw-items-table-capture .field-col {
					width: 260px;
				}
			</style>
			<h1>${escapeHtml(frm.doctype)} Items</h1>
			<div class="meta">
				Document: ${escapeHtml(frm.doc.name || "unsaved")} | Item rows: ${items.length} | Captured fields: ${rows.length}
			</div>
			<table>
				<thead>
					<tr>
						<th class="row-col">Item Row</th>
						<th class="item-col">Item Code</th>
						<th class="field-col">Field</th>
						<th>Value</th>
					</tr>
				</thead>
				<tbody>
					${rows
						.map(
							(row) => `
								<tr>
									<td>${escapeHtml(row.itemIndex)}</td>
									<td>${escapeHtml(row.itemCode)}</td>
									<td>${escapeHtml(row.field)}<br><small>${escapeHtml(row.fieldname)}</small></td>
									<td>${escapeHtml(row.value)}</td>
								</tr>
							`
						)
						.join("")}
				</tbody>
			</table>
		`;
		document.body.appendChild(wrapper);
	});

	const itemsTable = page.locator("#pw-items-table-capture");
	await expect(itemsTable).toBeVisible({ timeout: 15000 });

	const fileName = `${sequence}-${cleanScreenshotName(label)}-${cleanScreenshotName(doc?.name)}-items-table-full.png`;
	const screenshotPath = path.join(flowScreenshotDir, fileName);
	fs.mkdirSync(flowScreenshotDir, { recursive: true });
	await itemsTable.screenshot({ path: screenshotPath });
	await page.evaluate(() => document.getElementById("pw-items-table-capture")?.remove());

	if (testInfo) {
		await testInfo.attach(fileName, {
			path: screenshotPath,
			contentType: "image/png",
		});
	}
}

test.describe.serial("Internal Sales Order -> Internal PO -> Inter-Company SO workflow", () => {
	test("creates a fresh internal-order Sales Order from the reference SO", async ({ page }, testInfo) => {
		test.setTimeout(180000);
		resetFlowState();

		const salesOrderInput = loadSalesOrderInput();
		const fixture = await createInternalSalesOrderWorkflowFixtureFromInput(salesOrderInput);
		expect(fixture?.ok, fixture?.reason || "Fixture creation failed").toBeTruthy();
		flow.initialSoName = fixture.name;
		saveFlowState();

		await openSalesOrder(page, flow.initialSoName);
		await setFirstSalesOrderItemManualRate(page, manualSalesOrderRate);

		const editedItem = await getFirstSalesOrderItemPricing(page);
		expectRateClose(editedItem.price_list_rate, manualSalesOrderRate, "SO price_list_rate edit");
		expectRateClose(editedItem.rate, manualSalesOrderRate, "SO rate edit");
		expectRateClose(editedItem.net_rate, manualSalesOrderRate, "SO net_rate edit");

		const original = await getCurrentDoc(page);
		expect(original.custom_internal_order_required).toBe(1);
		expect(original.custom_source_of_order).toBe("B2C Website");
		expect(original.delivery_terms).toBeTruthy();
		expect(original.payment_terms_template).toBeTruthy();
		expect(original.item_count).toBeGreaterThan(0);
		await captureItemsTableScreenshot(page, testInfo, "00", "original-sales-order-created");
	});

	test("reviews and acknowledges the original SO, auto-creating the Internal PO", async ({
		page,
		context,
	}, testInfo) => {
		test.setTimeout(240000);

		await openSalesOrder(page, flow.initialSoName);
		await runWorkflowAction(page, "Sales Order", "SO Reviewed", "Received and Pending Approval");

		const popupPromise = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
		await runWorkflowActionInForm(page, "Sales Order", "SO Acknowledged", "Acknowledged");
		const popup = await popupPromise;
		if (popup && popup !== page) {
			await popup.close().catch(() => {});
		}
		await reloadCurrentForm(page);
		await captureWorkflowScreenshot(page, testInfo, "01", "original-sales-order-acknowledged");
		await captureItemsTableScreenshot(page, testInfo, "01", "original-sales-order-acknowledged");

		await waitForChain(flow.initialSoName, (state) => !!state?.internal_po);
		const chain = await getInternalOrderChainState(flow.initialSoName);
		flow.internalPoName = chain.internal_po?.name;
		expect(flow.internalPoName).toBeTruthy();
		saveFlowState();
	});

	test("verifies Internal PO delivery terms and accepts it", async ({ page }, testInfo) => {
		test.setTimeout(180000);
		requireFlowState("internalPoName");

		await openForm(page, "Purchase Order", flow.internalPoName);
		const poDraft = await getCurrentDoc(page);
		expect(poDraft.delivery_terms || poDraft.named_place).toBeTruthy();

		await runWorkflowAction(page, "Purchase Order", "Accept", "In Progress");
		await captureWorkflowScreenshot(page, testInfo, "02", "internal-purchase-order-accepted");
		await captureItemsTableScreenshot(page, testInfo, "02", "internal-purchase-order-accepted");
	});
});

test("Internal Sales Order -> Internal PO -> Inter-Company SO workflow › verifies Internal PO rate matches enabled Pricing Rule", async ({
	page,
	context,
}) => {
	test.setTimeout(360000);

	const input = buildPricingRuleRateInput(loadSalesOrderInput());
	const pricingSoName = await createAcknowledgedInternalOrder(page, context, input);
	const rates = await getInternalOrderRateSnapshot(pricingSoName);
	expect(rates?.ok, rates?.reason || "Rate snapshot failed").toBeTruthy();
	expect(
		rates.internal_po.currency,
		"Internal Purchase Order currency should be USD for the pricing-rule rate validation"
	).toBe(pricingRule.currency);
	expect(
		rates.internal_po.item.uom,
		"Internal Purchase Order item UOM should match the source Sales Order item UOM"
	).toBe(rates.initial_so.item.uom);
	expect(
		rates.internal_po.item.stock_uom,
		"Internal Purchase Order item Stock UOM should match the source Sales Order item Stock UOM"
	).toBe(rates.initial_so.item.stock_uom);
	const appliedPricingRules = parsePricingRules(rates.internal_po.item.pricing_rules);
	expect(
		appliedPricingRules.length,
		`${pricingRule.businessId} Internal Purchase Order should apply at least one Pricing Rule`
	).toBeGreaterThan(0);
	const appliedRule = await getPricingRuleRate(appliedPricingRules[0], pricingRule.businessId);
	expect(appliedRule?.ok, appliedRule?.reason || "Applied Pricing Rule lookup failed").toBeTruthy();
	expect(
		appliedRule.disabled,
		`Applied Pricing Rule ${appliedPricingRules[0]} should be enabled`
	).toBe(0);
	expect(Number(rates.internal_po.item.rate), "Internal Purchase Order rate should be recalculated").toBeGreaterThan(0);
	expect(
		Number(rates.internal_po.item.rate),
		"Internal Purchase Order rate should not keep the manual source Sales Order rate"
	).not.toBe(Number(rates.initial_so.item.rate));
});

test.describe.serial("Internal Sales Order -> Internal PO -> Inter-Company SO workflow", () => {
	test("creates the Internal Inter-Company Sales Order from the Internal PO", async ({ page }, testInfo) => {
		test.setTimeout(180000);
		requireFlowState("initialSoName", "internalPoName");

		await openForm(page, "Purchase Order", flow.internalPoName);
		await clickCreateMenuItem(page, ["Inter Company Sales Order", "Internal Sales Order"]);
		await waitForForm(page, "Sales Order");

		let internalSo = await getCurrentDoc(page);
		expect(internalSo.inter_company_order_reference).toBe(flow.internalPoName);
		expect(internalSo.delivery_terms || internalSo.named_place).toBeTruthy();
		expect(internalSo.payment_terms_template).toBeTruthy();
		await page.waitForFunction(
			(initialSoName) => window.cur_frm?.doc?.custom_sale_order === initialSoName,
			flow.initialSoName,
			{ timeout: 30000 }
		);

		await saveCurrentForm(page, "Sales Order");
		internalSo = await getCurrentDoc(page);
		flow.internalSoName = internalSo.name;
		expect(flow.internalSoName).toBeTruthy();
		await reloadCurrentForm(page);
		await captureWorkflowScreenshot(page, testInfo, "03", "internal-sales-order-created");
		await captureItemsTableScreenshot(page, testInfo, "03", "internal-sales-order-created");
		saveFlowState();
	});

	test("drives the Internal SO through production and fulfilment workflow", async ({ page }) => {
		test.setTimeout(240000);
		requireFlowState("internalSoName");

		await openSalesOrder(page, flow.internalSoName);
		await runWorkflowAction(page, "Sales Order", "SO Reviewed", "Received and Pending Approval");
		await runWorkflowAction(page, "Sales Order", "SO Acknowledged");
		await ensureSalesOrderAcknowledged(page);
		await runWorkflowActionInForm(page, "Sales Order", "Work Order Created", "Production In Progress");
		await runWorkflowActionInForm(page, "Sales Order", "Work Order Completed", "Work Order Completed");
		await runWorkflowActionInForm(page, "Sales Order", "Handed over to Logistics", "Fulfillment Pending");
		await runWorkflowActionInForm(page, "Sales Order", "Packing Completed", "Fulfilment In Progress");
	});

	test("closes the Internal PO and ships/delivers the original SO", async ({ page }) => {
		test.setTimeout(240000);
		requireFlowState("initialSoName", "internalSoName");

		await openSalesOrder(page, flow.internalSoName);
		await runWorkflowActionInForm(page, "Sales Order", "Order Shipped", "Order Shipped");

		await waitForChain(
			flow.initialSoName,
			(state) =>
				state?.internal_so?.workflow_state === "Order Shipped" &&
				state?.initial_so?.workflow_state === "Order Shipped" &&
				state?.internal_po?.workflow_state === "Closed"
		);

		await runWorkflowActionInForm(page, "Sales Order", "Deliver", "Delivered");
	});

	test("verifies final chain status across Original SO, Internal PO and Internal SO", async () => {
		test.setTimeout(120000);
		requireFlowState("initialSoName", "internalPoName", "internalSoName");

		const chain = await getInternalOrderChainState(flow.initialSoName);
		expect(chain.internal_so?.name).toBe(flow.internalSoName);
		expect(chain.internal_po?.name).toBe(flow.internalPoName);
		expect(chain.internal_so?.workflow_state).toBe("Delivered");
		expect(chain.initial_so?.workflow_state).toBe("Delivered");
		expect(chain.internal_po?.workflow_state).toBe("Closed");
	});
});
