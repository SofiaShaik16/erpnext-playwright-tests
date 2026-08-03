import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { callFixtureMethod, getDoc } from "./helpers/frappe_api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(__dirname, "fixtures/resin_mixing_flow");
const FIXTURE_FILES = {
	bom: "bom.json",
	purchase_receipt: "purchase_receipt.json",
	work_order: "work_order.json",
	job_card: "job_card.json",
	expected: "expected.json",
	test_cases: "test_cases.json",
};

function loadResinMixingFixture() {
	const fixturePath = path.resolve(process.env.RESIN_MIXING_FIXTURE || DEFAULT_FIXTURE);
	if (fs.statSync(fixturePath).isDirectory()) {
		return loadResinMixingFixtureDir(fixturePath);
	}

	const fixture = readJson(fixturePath);
	const fixtureDir = path.dirname(fixturePath);

	for (const [key, relativePath] of Object.entries(fixture.input_files || {})) {
		fixture[key] = readJson(path.resolve(fixtureDir, relativePath));
	}

	return normalizeFixture(fixture);
}

function loadResinMixingFixtureDir(fixtureDir) {
	const fixture = {};
	for (const [key, fileName] of Object.entries(FIXTURE_FILES)) {
		fixture[key] = readJson(path.resolve(fixtureDir, fileName));
	}

	return normalizeFixture(fixture);
}

function normalizeFixture(fixture) {
	if (typeof fixture.bom === "object") {
		fixture.bom = fixture.bom.name;
	}

	return fixture;
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function routeFor(doctype, name) {
	return `/app/${doctype.toLowerCase().replaceAll(" ", "-")}/${encodeURIComponent(name)}`;
}

async function openForm(page, doctype, name) {
	await page.goto(routeFor(doctype, name), { waitUntil: "domcontentloaded" });
	await page.waitForFunction(
		({ expectedDoctype, expectedName }) => {
			const frm = window.cur_frm;
			return frm?.doctype === expectedDoctype && frm?.doc?.name === expectedName;
		},
		{ expectedDoctype: doctype, expectedName: name },
		{ timeout: 60000 }
	);
	await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
	await suppressLegacyGravatarPrompt(page);
	await dismissBlockingDialogs(page);
}

async function suppressLegacyGravatarPrompt(page) {
	await page
		.evaluate(() => {
			if (window.frappe?.boot) {
				window.frappe.boot.show_gravatar_deletion_prompt = false;
			}

			for (const dialog of document.querySelectorAll(".modal.show")) {
				if (!dialog.textContent?.includes("Delete Gravatar URLs")) {
					continue;
				}

				window.$?.(dialog).modal?.("hide");
				dialog.remove();
			}

			for (const backdrop of document.querySelectorAll(".modal-backdrop")) {
				backdrop.remove();
			}

			if (!document.querySelector(".modal.show")) {
				document.body.classList.remove("modal-open");
				document.body.style.removeProperty("padding-right");
				document.body.style.removeProperty("overflow");
			}
		})
		.catch(() => {});
}

async function dismissBlockingDialogs(page) {
	const dialog = page.locator(".modal.show").first();
	if (!(await dialog.count())) {
		return;
	}

	await page.keyboard.press("Escape");
	await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(async () => {
		await page
			.locator(".modal.show .btn-modal-close, .modal.show .btn-close, .modal.show .close")
			.first()
			.click({ timeout: 2000 })
			.catch(() => {});
		await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
	});
}

async function expectDoc(request, doctype, name) {
	const doc = await getDoc(request, doctype, name);
	expect(doc, `${doctype} ${name} should exist`).toBeTruthy();
	return doc;
}

async function expectOpenFormDocstatus(page, docstatus, label) {
	await expect
		.poll(
			() =>
				page.evaluate(() => ({
					docstatus: window.cur_frm?.doc?.docstatus,
					statusText: document.body.innerText,
				})),
			{ message: `${label} should show docstatus ${docstatus}` }
		)
		.toMatchObject({ docstatus });
}

function expectSubmitted(doc, label) {
	expect(doc.docstatus, `${label} should be submitted`).toBe(1);
}

function expectHasChildRows(doc, tableField, label) {
	const rows = doc[tableField] || [];
	expect(rows.length, `${label} should have ${tableField} rows`).toBeGreaterThan(0);
	return rows;
}

function expectClose(actual, expected, label, precision = 3) {
	const received = Number(actual || 0);
	const target = Number(expected || 0);
	expect(Math.abs(received - target), `${label}: expected ${target}, received ${received}`).toBeLessThan(
		0.5 * 10 ** -precision
	);
}

function rowsForItem(rows, itemCode) {
	return rows.filter((row) => row.item_code === itemCode);
}

function sumByItem(rows, fieldname) {
	return rows.reduce((totals, row) => {
		totals[row.item_code] = Number(totals[row.item_code] || 0) + Number(row[fieldname] || 0);
		return totals;
	}, {});
}

async function createResinMixingFlowStage1Fixture(fixture) {
	const result = await callFixtureMethod(
		"ntpt_erpnext_app.functional_tests.playwright_resin_mixing_fixture.create_resin_mixing_flow_stage1_fixture",
		[fixture],
		{ fixture_input: fixture }
	);
	expect(result?.ok, result?.reason || "Resin mixing stage 1 fixture creation failed").toBeTruthy();
	return {
		bom: fixture.bom,
		purchase_receipt: result.purchase_receipt,
		work_order: result.work_order,
		job_card: result.job_card,
		material_transfer_stock_entry: result.material_transfer_stock_entry,
	};
}

async function createResinMixingFlowStage2Fixture(fixture, jobCardName) {
	const result = await callFixtureMethod(
		"ntpt_erpnext_app.functional_tests.playwright_resin_mixing_fixture.create_resin_mixing_flow_stage2_fixture",
		[fixture, jobCardName],
		{ fixture_input: fixture, job_card_name: jobCardName }
	);
	expect(result?.ok, result?.reason || "Resin mixing stage 2 fixture creation failed").toBeTruthy();
	return result;
}

async function createResinMixingCancellationFixture(fixture) {
	const result = await callFixtureMethod(
		"ntpt_erpnext_app.functional_tests.playwright_resin_mixing_fixture.create_resin_mixing_cancellation_fixture",
		[fixture],
		{ fixture_input: fixture }
	);
	expect(result?.ok, result?.reason || "Resin mixing cancellation fixture creation failed").toBeTruthy();
	return result;
}

async function cancelAndRedoMaterialTransfer(fixture, documents) {
	const result = await callFixtureMethod(
		"ntpt_erpnext_app.functional_tests.playwright_resin_mixing_fixture.cancel_and_redo_material_transfer_fixture",
		[fixture, documents.job_card, documents.material_transfer_stock_entry, documents.purchase_receipt],
		{
			fixture_input: fixture,
			job_card_name: documents.job_card,
			transfer_name: documents.material_transfer_stock_entry,
			purchase_receipt_name: documents.purchase_receipt,
		}
	);
	expect(result?.ok, result?.reason || "Cancel and redo Material Transfer fixture failed").toBeTruthy();
	return result;
}

async function cancelAndRedoManufacture(fixture, documents) {
	const result = await callFixtureMethod(
		"ntpt_erpnext_app.functional_tests.playwright_resin_mixing_fixture.cancel_and_redo_manufacture_fixture",
		[fixture, documents.job_card, documents.manufacture_stock_entry],
		{
			fixture_input: fixture,
			job_card_name: documents.job_card,
			manufacture_name: documents.manufacture_stock_entry,
		}
	);
	expect(result?.ok, result?.reason || "Cancel and redo Manufacture fixture failed").toBeTruthy();
	return result;
}

function entityStockDetails(entitySnapshots) {
	return (entitySnapshots || []).flatMap((entity) => entity.stock_details || []);
}

function splitEntityValues(value) {
	return String(value || "")
		.replaceAll(",", "\n")
		.split("\n")
		.map((entity) => entity.trim())
		.filter(Boolean);
}

function expectCancelled(status, label) {
	expect(status.docstatus, `${label} should be cancelled`).toBe(2);
}

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		const disablePrompt = () => {
			if (window.frappe?.boot) {
				window.frappe.boot.show_gravatar_deletion_prompt = false;
			}
		};

		disablePrompt();
		const timer = window.setInterval(disablePrompt, 50);
		window.setTimeout(() => window.clearInterval(timer), 5000);
	});
});

test.describe.serial("Resin Mixing Manufacturing Flow", () => {
	const fixture = loadResinMixingFixture();
	const { expected } = fixture;
	let documents;

	test.beforeAll(async () => {
		documents = await createResinMixingFlowStage1Fixture(fixture);
	});

	test(`${fixture.test_cases[0].id} - ${fixture.test_cases[0].title}`, async ({ page, request }) => {
		const bom = await expectDoc(request, "BOM", documents.bom);
		expectSubmitted(bom, "BOM");
		expect(bom.item).toBe(expected.production_item);
		expect(bom.quantity).toBeGreaterThan(0);
		expect(bom.with_operations, "BOM should include operations").toBeTruthy();
		expectHasChildRows(bom, "items", "BOM");
		expectHasChildRows(bom, "operations", "BOM");

		await openForm(page, "BOM", documents.bom);
		await expect(page.locator('[data-fieldname="item"]')).toContainText(expected.production_item);
	});

	test(`${fixture.test_cases[1].id} - ${fixture.test_cases[1].title}`, async ({ page, request }) => {
		const pr = await expectDoc(request, "Purchase Receipt", documents.purchase_receipt);
		expectSubmitted(pr, "Purchase Receipt");
		expect(pr.company).toBe(expected.company);
		const rows = expectHasChildRows(pr, "items", "Purchase Receipt");
		const rmRows = rowsForItem(rows, expected.purchase_receipt_item);
		expect(rmRows.length, `Purchase Receipt should include ${expected.purchase_receipt_item}`).toBeGreaterThan(0);
		expect(
			rmRows.some((row) => row.warehouse === expected.purchase_receipt_warehouse),
			`Purchase Receipt should receive ${expected.purchase_receipt_item} into ${expected.purchase_receipt_warehouse}`
		).toBeTruthy();

		await openForm(page, "Purchase Receipt", documents.purchase_receipt);
		await expect(page.locator('[data-fieldname="items"]')).toContainText(expected.purchase_receipt_item);
	});

	test(`${fixture.test_cases[2].id} - ${fixture.test_cases[2].title}`, async ({ page, request }) => {
		const wo = await expectDoc(request, "Work Order", documents.work_order);
		expectSubmitted(wo, "Work Order");
		expect(wo.bom_no).toBe(documents.bom);
		expect(wo.production_item).toBe(expected.production_item);
		expect(wo.company).toBe(expected.company);
		expect(wo.wip_warehouse).toBe(expected.wip_warehouse);
		expect(wo.fg_warehouse).toBe(expected.finished_goods_warehouse);
		expectClose(wo.qty, expected.work_order_qty, "Work Order qty");
		expectHasChildRows(wo, "required_items", "Work Order");
		expectHasChildRows(wo, "operations", "Work Order");

		await openForm(page, "Work Order", documents.work_order);
		await expect(page.locator('[data-fieldname="production_item"]')).toContainText(expected.production_item);
	});

	test(`${fixture.test_cases[3].id} - ${fixture.test_cases[3].title}`, async ({ page, request }) => {
		const jobCard = await expectDoc(request, "Job Card", documents.job_card);
		expect(jobCard.work_order).toBe(documents.work_order);
		expect(jobCard.bom_no).toBe(documents.bom);
		expect(jobCard.company).toBe(expected.company);
		expect(jobCard.wip_warehouse).toBe(expected.wip_warehouse);
		expectClose(jobCard.for_quantity, expected.job_card_qty, "Job Card qty");
		const requiredRows = expectHasChildRows(jobCard, "items", "Job Card required items");

		await openForm(page, "Job Card", documents.job_card);
		await expect(page.locator('[data-fieldname="work_order"]').first()).toContainText(documents.work_order);
		await page.getByRole("tab", { name: "Raw Materials" }).click();
		await expect(page.locator('[data-fieldname="items"]').first()).toBeVisible();
		await expect(page.locator('[data-fieldname="items"]').first()).toContainText(requiredRows[0].item_code);
	});

	test(`${fixture.test_cases[4].id} - ${fixture.test_cases[4].title}`, async ({ page, request }) => {
		const transfer = await expectDoc(
			request,
			"Stock Entry",
			documents.material_transfer_stock_entry
		);
		expectSubmitted(transfer, "Material Transfer Stock Entry");
		expect(transfer.stock_entry_type).toBe("Material Transfer for Manufacture");
		expect(transfer.work_order).toBe(documents.work_order);
		expect(transfer.job_card).toBe(documents.job_card);
		const rows = expectHasChildRows(transfer, "items", "Material Transfer Stock Entry");
		expect(
			rows.every((row) => !Number(row.is_finished_item || 0)),
			"Material Transfer rows should not be marked as finished goods"
		).toBeTruthy();
		expect(rows.some((row) => row.t_warehouse === expected.wip_warehouse)).toBeTruthy();

		await openForm(page, "Stock Entry", documents.material_transfer_stock_entry);
		await expect(page.locator('[data-fieldname="stock_entry_type"]')).toContainText(
			"Material Transfer for Manufacture"
		);
	});

	test(`${fixture.test_cases[5].id} - ${fixture.test_cases[5].title}`, async ({ page, request }) => {
		const result = await cancelAndRedoMaterialTransfer(fixture, documents);

		const oldTransfer = await expectDoc(request, "Stock Entry", result.old_transfer);
		expectCancelled(oldTransfer, "Cancelled Material Transfer Stock Entry");

		const newTransfer = await expectDoc(request, "Stock Entry", result.new_transfer);
		expectSubmitted(newTransfer, "Redone Material Transfer Stock Entry");
		expect(newTransfer.work_order).toBe(documents.work_order);
		expect(newTransfer.job_card).toBe(documents.job_card);

		const oldRows = expectHasChildRows(oldTransfer, "items", "Cancelled Material Transfer Stock Entry");
		const newRows = expectHasChildRows(newTransfer, "items", "Redone Material Transfer Stock Entry");
		const oldQtyByItem = sumByItem(oldRows, "transfer_qty");
		const newQtyByItem = sumByItem(newRows, "transfer_qty");
		for (const [itemCode, qty] of Object.entries(oldQtyByItem)) {
			expectClose(
				newQtyByItem[itemCode],
				qty,
				`Redone transfer should move the same total qty as a single clean transfer for ${itemCode}`
			);
		}

		// Continue the SAME job card's story with the redone transfer -- downstream
		// tests (Start of JC, Manufacture) must consume this, not the cancelled one.
		documents.material_transfer_stock_entry = result.new_transfer;

		await openForm(page, "Stock Entry", result.new_transfer);
		await expect(page.locator('[data-fieldname="stock_entry_type"]')).toContainText(
			"Material Transfer for Manufacture"
		);
	});

	test(`${fixture.test_cases[6].id} - ${fixture.test_cases[6].title}`, async ({ page, request }) => {
		// Continue the same job card: complete it and create its Manufacture entry
		// now, using the redone (post-cancel) Material Transfer from the previous test.
		const stage2 = await createResinMixingFlowStage2Fixture(fixture, documents.job_card);
		documents.manufacture_stock_entry = stage2.manufacture_stock_entry;

		const jobCard = await expectDoc(request, "Job Card", documents.job_card);
		const manufacture = await expectDoc(request, "Stock Entry", documents.manufacture_stock_entry);
		expectSubmitted(manufacture, "Manufacture Stock Entry");
		expect(manufacture.stock_entry_type).toBe("Manufacture");
		expect(manufacture.work_order).toBe(documents.work_order);
		expect(manufacture.job_card).toBe(documents.job_card);
		expect(Number(manufacture.fg_completed_qty || 0)).toBeGreaterThan(0);

		const rows = expectHasChildRows(manufacture, "items", "Manufacture Stock Entry");
		const finishedRows = rows.filter((row) => Number(row.is_finished_item || 0));
		expect(finishedRows.length, "Manufacture Stock Entry should have one finished-good row").toBe(1);
		expect(finishedRows[0].item_code).toBe(expected.production_item);
		expect(finishedRows[0].t_warehouse).toBe(expected.finished_goods_warehouse);
		expect(Number(finishedRows[0].qty || 0)).toBeGreaterThan(0);
		expect(rows.some((row) => !Number(row.is_finished_item || 0)), "Manufacture should consume raw materials").toBeTruthy();

		const rawRows = rows.filter((row) => !Number(row.is_finished_item || 0));
		const jobCardScaleByItem = sumByItem(jobCard.items || [], "custom_scale");
		const manufactureScaleByItem = sumByItem(rawRows, "custom_scale");

		for (const [itemCode, expectedScale] of Object.entries(jobCardScaleByItem)) {
			expectClose(
				manufactureScaleByItem[itemCode],
				expectedScale,
				`Manufacture scale should match Job Card scale for ${itemCode}`
			);
		}

		for (const row of rawRows) {
			const scaleQty = Number(row.custom_scale || 0);
			const availableQty = Number(row.custom_avail_qty || row.transfer_qty || row.qty || 0);
			const remainingQty = Number(row.custom_remaining_entity_qty || 0);
			const processLossQty = Number(row.custom_process_loss_qty || 0);

			expect(scaleQty, `Scale should be populated for ${row.item_code} row ${row.idx}`).toBeGreaterThan(0);
			expectClose(row.qty, scaleQty, `Manufacture consumed qty should use scale for ${row.item_code} row ${row.idx}`);
			expectClose(
				row.amount,
				Number(row.basic_rate || 0) * scaleQty,
				`Manufacture amount should use scale for ${row.item_code} row ${row.idx}`
			);
			expectClose(
				remainingQty,
				Math.max(availableQty - scaleQty, 0),
				`Remaining qty should be transferred qty minus scale for ${row.item_code} row ${row.idx}`
			);
			expectClose(
				processLossQty,
				Math.max(availableQty - remainingQty - scaleQty, 0),
				`Process loss should be derived from transfer, scale, and remaining qty for ${row.item_code} row ${row.idx}`
			);
		}

		await openForm(page, "Stock Entry", documents.manufacture_stock_entry);
		await expect(page.locator('[data-fieldname="stock_entry_type"]')).toContainText("Manufacture");
		await expect(page.locator('[data-fieldname="items"]')).toContainText(expected.production_item);
	});

	test(`${fixture.test_cases[7].id} - ${fixture.test_cases[7].title}`, async ({ page, request }) => {
		const manufacture = await expectDoc(request, "Stock Entry", documents.manufacture_stock_entry);
		const finishedRows = (manufacture.items || []).filter((row) => Number(row.is_finished_item || 0));
		expect(finishedRows.length, "Manufacture Stock Entry should have finished-good rows").toBeGreaterThan(0);

		const manufacturedEntities = splitEntityValues(finishedRows.flatMap((row) => row.containers || []).join("\n"));
		expect(
			manufacturedEntities.length,
			"Manufacture submit should generate a finished-good entity/sticker"
		).toBeGreaterThan(0);

		const entity = await expectDoc(request, "Entity", manufacturedEntities[0]);
		expect(entity.item_code).toBe(expected.production_item);
		expect(Number(entity.primary_available_qty || 0), "Manufactured entity should have available qty").toBeGreaterThan(0);

		await openForm(page, "Entity", entity.name);
		await expect(page.locator('[data-fieldname="item_code"]').first()).toContainText(expected.production_item);
	});

	test(`${fixture.test_cases[8].id} - ${fixture.test_cases[8].title}`, async ({ page, request }) => {
		const result = await cancelAndRedoManufacture(fixture, documents);

		const oldManufacture = await expectDoc(request, "Stock Entry", result.old_manufacture);
		expectCancelled(oldManufacture, "Cancelled Manufacture Stock Entry");

		const newManufacture = await expectDoc(request, "Stock Entry", result.new_manufacture);
		expectSubmitted(newManufacture, "Redone Manufacture Stock Entry");
		expect(newManufacture.work_order).toBe(documents.work_order);
		expect(newManufacture.job_card).toBe(documents.job_card);

		const oldRawRows = (oldManufacture.items || []).filter((row) => !Number(row.is_finished_item || 0));
		const newRawRows = (newManufacture.items || []).filter((row) => !Number(row.is_finished_item || 0));
		const oldRawQtyByItem = sumByItem(oldRawRows, "qty");
		const newRawQtyByItem = sumByItem(newRawRows, "qty");
		for (const [itemCode, qty] of Object.entries(oldRawQtyByItem)) {
			expectClose(
				newRawQtyByItem[itemCode],
				qty,
				`Redone manufacture should consume the same total qty as a single clean consumption for ${itemCode}`
			);
		}

		// Raw material entities: cancelling restores WIP qty, and the redo consumes it
		// back down to exactly where a single clean Manufacture would leave it -- no
		// double consumption from the cancelled attempt.
		const beforeAvailByName = Object.fromEntries(
			result.before.raw_material_entities.map((entity) => [entity.name, entity.primary_available_qty])
		);
		const afterRedoAvailByName = Object.fromEntries(
			result.after_redo.raw_material_entities.map((entity) => [entity.name, entity.primary_available_qty])
		);
		for (const [name, qty] of Object.entries(beforeAvailByName)) {
			expectClose(
				afterRedoAvailByName[name],
				qty,
				`Entity ${name} should settle at the same available qty as a single clean consumption`
			);
		}

		// Finished-good entity: inactive once the Manufacture entry that created it is
		// cancelled, reactivated (not orphaned) once the redo submits.
		for (const entity of result.after_cancel.finished_entities) {
			expect(
				entity.status,
				`Finished-good entity ${entity.name} should be Inactive after cancelling the Manufacture entry`
			).toBe("Inactive");
		}
		for (const entity of result.after_redo.new_finished_entities) {
			expect(
				entity.status,
				`Finished-good entity ${entity.name} should be Active again after the redo`
			).toBe("Active");
		}

		documents.manufacture_stock_entry = result.new_manufacture;

		await openForm(page, "Stock Entry", result.new_manufacture);
		await expect(page.locator('[data-fieldname="stock_entry_type"]')).toContainText("Manufacture");
	});
});
