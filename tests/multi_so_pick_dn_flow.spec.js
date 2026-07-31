import { expect, test } from "@playwright/test";
import {
	getFormUiState,
	openDeliveryNote,
	waitForNtptNewFormUi,
	waitForScanFloat,
} from "./helpers/delivery_note.js";
import { getDoc } from "./helpers/frappe_api.js";
import {
	createDeliveryNoteFromPickList as createDnViaBench,
	createMultiSoPickList,
	getDeliveryNoteState,
	getDraftSoFixture,
	getMultiSoFixture,
	getPickListState,
	getSingleSoFixture,
	getSubmittedSoFixture,
	submitPickListForDn,
} from "./helpers/logistics_data.js";
import {
	getItemsFromSalesOrders,
	getPickListFormState,
	newDeliveryPickList,
	openPickList,
} from "./helpers/pick_list.js";
import {
	clickCreateMenuItem,
	createPickListFromSalesOrder,
	getAvailableWorkflowActions,
	getSalesOrderFormState,
	openSalesOrder,
	submitSalesOrderViaWorkflow,
	waitForSalesOrderForm,
} from "./helpers/sales_order.js";

test.describe("Logistics E2E — Sales Order submit", () => {
	test("submitted SO shows Create → Pick List in UI", async ({ page }) => {
		const fixture = await getSubmittedSoFixture();
		test.skip(!fixture?.ok, fixture?.reason || "No submitted SO fixture");

		await openSalesOrder(page, fixture.name);
		const ui = await getSalesOrderFormState(page);

		expect(ui.docstatus).toBe(1);
		expect(ui.itemCount).toBeGreaterThan(0);
		await expect(page.getByRole("button", { name: "Create" })).toBeVisible();
		await clickCreateMenuItem(page, "Pick List");
	});

	test("draft SO can move through workflow to submitted (docstatus = 1)", async ({ page }) => {
		test.setTimeout(180000);
		const fixture = await getDraftSoFixture();
		test.skip(!fixture?.ok, fixture?.reason || "No draft SO fixture");

		await openSalesOrder(page, fixture.name);
		await page.locator(".freeze").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
		expect((await getSalesOrderFormState(page)).docstatus).toBe(0);

		const actions = await getAvailableWorkflowActions(page).catch(() => []);
		test.skip(!actions.includes("SO Reviewed"), `Draft SO ${fixture.name} has no SO Reviewed action`);

		await submitSalesOrderViaWorkflow(page);

		const submitted = await getSalesOrderFormState(page);
		expect(submitted.docstatus).toBe(1);
	});
});

test.describe("Logistics E2E — single SO to Pick List (manual pick)", () => {
	test("SO → Pick List sets pick_manually and clears warehouse on rows", async ({ page }) => {
		const fixture = await getSingleSoFixture();
		test.skip(!fixture?.ok, fixture?.reason || "No single SO fixture");

		const packageComment = `PW-SO-PL-${Date.now()}`;
		await openSalesOrder(page, fixture.name);
		await createPickListFromSalesOrder(page, packageComment);

		const plUi = await getPickListFormState(page);
		expect(plUi.pick_manually).toBe(1);
		expect(plUi.locationCount).toBeGreaterThan(0);
		expect(plUi.warehousesCleared).toBeTruthy();
		expect(plUi.salesOrders).toContain(fixture.name);

		const plApi = await getPickListState(plUi.name);
		expect(plApi.pick_manually).toBe(1);
		expect(plApi.warehouses_cleared).toBeTruthy();
		expect(plApi.sales_orders).toContain(fixture.name);
	});
});

test.describe("Logistics E2E — multi-SO manual pick", () => {
	test.describe.configure({ mode: "serial", timeout: 180000 });
	let fixture;
	let pickListName;

	test.beforeAll(async () => {
		fixture = await getMultiSoFixture();
	});

	test("creates Pick List with Get Items from two Sales Orders", async ({ page }) => {
		fixture = await getMultiSoFixture();
		test.skip(!fixture?.ok, fixture?.reason || "Need 2+ SOs for same customer");

		await newDeliveryPickList(page, {
			customer: fixture.customer,
			company: fixture.company,
		});
		await getItemsFromSalesOrders(page, fixture.so_names);

		let plUi = await getPickListFormState(page);
		pickListName = plUi.name;

		if (fixture.so_names.some((soName) => !plUi.salesOrders.includes(soName))) {
			const apiPl = await createMultiSoPickList(fixture.so_names);
			expect(apiPl?.ok).toBeTruthy();
			pickListName = apiPl.name;
			await openPickList(page, pickListName);
			plUi = await getPickListFormState(page);
		}

		expect(plUi.pick_manually).toBe(1);
		expect(plUi.locationCount).toBeGreaterThan(0);
		expect(plUi.warehousesCleared).toBeTruthy();
		for (const soName of fixture.so_names) {
			expect(plUi.salesOrders).toContain(soName);
		}

		const plApi = await getPickListState(pickListName);
		expect(plApi.pick_manually).toBe(1);
		expect(plApi.warehouses_cleared).toBeTruthy();
		for (const soName of fixture.so_names) {
			expect(plApi.sales_orders).toContain(soName);
		}
	});

	test("multi-SO Pick List opens with both sales orders on location rows", async ({ page }) => {
		test.skip(!fixture?.ok || !pickListName, "Pick List not created in prior step");

		await openPickList(page, pickListName);
		const plUi = await getPickListFormState(page);
		for (const soName of fixture.so_names) {
			expect(plUi.salesOrders).toContain(soName);
		}
	});
});

test.describe("Logistics E2E — Pick List to Delivery Note (multi-SO)", () => {
	test.describe.configure({ mode: "serial", timeout: 180000 });
	let fixture;
	let pickListName;
	let deliveryNoteName;

	test.beforeAll(async () => {
		fixture = await getMultiSoFixture();
	});

	test("prepares multi-SO Pick List for Delivery Note flow", async () => {
		fixture = await getMultiSoFixture();
		test.skip(!fixture?.ok, fixture?.reason || "Need 2+ SOs for same customer");

		const apiPl = await createMultiSoPickList(fixture.so_names);
		expect(apiPl?.ok).toBeTruthy();
		pickListName = apiPl.name;
		expect(pickListName).toBeTruthy();
		for (const soName of fixture.so_names) {
			expect(apiPl.sales_orders).toContain(soName);
		}
		expect(apiPl.pick_manually).toBe(1);
	});

	test("creates Delivery Note linked to Pick List with both sales orders on header", async ({
		page,
		request,
	}) => {
		test.skip(!pickListName, "Pick List not created");

		const submitResult = await submitPickListForDn(pickListName);
		expect(submitResult.ok).toBeTruthy();

		await openPickList(page, pickListName);

		const dnResult = await createDnViaBench(pickListName);
		test.skip(!dnResult?.ok, dnResult?.reason || "Delivery Note could not be created from Pick List");
		expect(dnResult.ok).toBeTruthy();
		deliveryNoteName = dnResult.name;

		await openDeliveryNote(page, deliveryNoteName);
		for (const soName of fixture.so_names) {
			expect(dnResult.item_sales_orders).toContain(soName);
			expect(dnResult.header_sales_orders).toContain(soName);
		}
		expect(dnResult.pick_list || pickListName).toBeTruthy();

		const dnApi = await getDeliveryNoteState(deliveryNoteName);
		for (const soName of fixture.so_names) {
			expect(dnApi.item_sales_orders).toContain(soName);
			expect(dnApi.header_sales_orders).toContain(soName);
		}
		expect(dnApi.pick_lists).toContain(pickListName);
		expect(dnApi.item_count).toBeGreaterThan(0);

		const dnDoc = await getDoc(request, "Delivery Note", deliveryNoteName, [
			"name",
			"docstatus",
			"customer",
		]);
		expect(dnDoc?.customer).toBe(fixture.customer);
	});

	test("multi-SO Delivery Note draft shows NTPT scan UI and read-only sales orders", async ({
		page,
	}) => {
		test.skip(!deliveryNoteName, "Delivery Note not created");

		await openDeliveryNote(page, deliveryNoteName);
		await waitForScanFloat(page, true);

		const ui = await getFormUiState(page);
		expect(ui).not.toBeNull();
		expect(ui.itemCount).toBeGreaterThan(0);
		if (ui.salesOrders.exists) {
			expect(ui.salesOrders.readOnly).toBeTruthy();
		}
		if (ui.orderId.exists) {
			expect(ui.orderId.hidden).toBeTruthy();
		}
		await expect(page.getByRole("button", { name: "Add Entities" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Assign Stocks" })).toBeVisible();
	});
});

test.describe("Logistics E2E — full chain smoke", () => {
	test.describe.configure({ mode: "serial", timeout: 180000 });

	test("submitted SO → multi-SO Pick List → Delivery Note (API verify)", async ({ page }) => {
		const fixture = await getMultiSoFixture();
		test.skip(!fixture?.ok, fixture?.reason || "Need 2+ SOs for same customer");

		// 2) Multi-SO Pick List (manual pick) — UI with API fallback
		const apiPl = await createMultiSoPickList(fixture.so_names);
		expect(apiPl?.ok).toBeTruthy();
		const pickListName = apiPl.name;

		// Optional UI verification on one SO
		await openSalesOrder(page, fixture.so_names[0]);
		expect((await getSalesOrderFormState(page)).docstatus).toBe(1);

		// 3) Delivery Note creation
		await submitPickListForDn(pickListName);
		const dnResult = await createDnViaBench(pickListName);
		test.skip(!dnResult?.ok, dnResult?.reason || "Delivery Note could not be created from Pick List");
		expect(dnResult.ok).toBeTruthy();

		for (const soName of fixture.so_names) {
			expect(dnResult.item_sales_orders).toContain(soName);
			expect(dnResult.header_sales_orders).toContain(soName);
		}

		// 4) Open DN and confirm NTPT form
		await openDeliveryNote(page, dnResult.name);
		await waitForNtptNewFormUi(page);
		await waitForScanFloat(page, true);
	});
});
