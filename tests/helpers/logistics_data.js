import {
	benchExecute,
	remoteCallFrappeMethod,
	remoteGetDoc,
	remoteGetList,
	useRemoteFrappeApi,
} from "./frappe_api.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_MODULE =
	"ntpt_erpnext_app.functional_tests.playwright_logistics_fixture";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SALES_ORDER_FIXTURE = path.resolve(__dirname, "../fixtures/sales_order.json");
const SYSTEM_FIELDS = new Set([
	"name",
	"owner",
	"creation",
	"modified",
	"modified_by",
	"_user_tags",
	"_comments",
	"_assign",
	"_liked_by",
	"parent",
	"parentfield",
	"parenttype",
]);

export function loadSalesOrderInput(fixturePath = process.env.SALES_ORDER_FIXTURE) {
	const resolvedPath = fixturePath
		? path.resolve(process.cwd(), fixturePath)
		: DEFAULT_SALES_ORDER_FIXTURE;

	return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
}

function addDays(date, days) {
	const copy = new Date(date);
	copy.setDate(copy.getDate() + Number(days || 0));
	return copy.toISOString().slice(0, 10);
}

function today() {
	return new Date().toISOString().slice(0, 10);
}

function scrubDocForInsert(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return data;
	}

	const scrubbed = {};
	for (const [fieldname, value] of Object.entries(data)) {
		if (SYSTEM_FIELDS.has(fieldname)) {
			continue;
		}
		if (Array.isArray(value)) {
			scrubbed[fieldname] = value.map((row) => scrubDocForInsert(row));
		} else if (value && typeof value === "object") {
			scrubbed[fieldname] = scrubDocForInsert(value);
		} else {
			scrubbed[fieldname] = value;
		}
	}

	scrubbed.docstatus = 0;
	return scrubbed;
}

function resetSalesOrderChildRows(doc) {
	for (const row of doc.items || []) {
		row.delivery_date = doc.delivery_date;
		for (const fieldname of [
			"billed_amt",
			"delivered_qty",
			"ordered_qty",
			"planned_qty",
			"production_plan_qty",
			"requested_qty",
			"work_order_qty",
			"produced_qty",
			"returned_qty",
			"picked_qty",
			"stock_reserved_qty",
		]) {
			if (fieldname in row) {
				row[fieldname] = 0;
			}
		}
	}

	for (const row of doc.payment_schedule || []) {
		row.due_date = doc.transaction_date;
		if ("custom_payment_due_date" in row) {
			row.custom_payment_due_date = doc.transaction_date;
		}
		if ("discount_date" in row) {
			row.discount_date = doc.transaction_date;
		}
	}
}

function applySalesOrderFixtureValues(doc, fixtureData, stamp) {
	for (const [fieldname, value] of Object.entries(fixtureData.sales_order || {})) {
		doc[fieldname] = value;
	}

	for (const fieldname of fixtureData.clear_fields || []) {
		doc[fieldname] = null;
	}

	for (const [fieldname, template] of Object.entries(fixtureData.generated_fields || {})) {
		doc[fieldname] = String(template).replaceAll("{stamp}", stamp);
	}

	for (const [fieldname, offset] of Object.entries(fixtureData.date_offsets || {})) {
		doc[fieldname] = addDays(today(), offset);
	}
}

async function createInternalSalesOrderWorkflowFixtureViaApi(fixtureData) {
	const sourceDocument = fixtureData?.document;
	if (!sourceDocument) {
		return { ok: false, reason: "sales_order.json must include a full document object" };
	}

	const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
	const doc = scrubDocForInsert(sourceDocument);
	Object.assign(doc, {
		doctype: "Sales Order",
		docstatus: 0,
		workflow_state: "Draft",
		custom_previous_workflow_state_: null,
		custom_previous_status: null,
		status: "Draft",
		delivery_status: "Not Delivered",
		billing_status: "Not Billed",
		per_delivered: 0,
		per_billed: 0,
		per_picked: 0,
		transaction_date: today(),
		delivery_date: addDays(today(), 7),
		custom_internal_order_required: 1,
		custom_source_of_order: "B2C Website",
		custom_type_of_order: "Golf Order",
		custom_has_stock: 0,
		custom_payment_status: "Received",
		custom_payment_date: today(),
		custom_mrp_order_id: `PW-${stamp}`,
		woocommerce_order_id: `PW-${stamp}`,
		custom_order_key: `pw_order_${stamp}`,
		custom_transaction_id: `pw_txn_${stamp}`,
		custom_invoice_number: null,
		custom_invoice_date: null,
		contact_person: null,
		customer_address: null,
		shipping_address_name: null,
		inter_company_order_reference: null,
		custom_against_sales_order: null,
		custom_sale_order: null,
		custom_internal_customer: null,
		custom_internal_customer_name: null,
	});

	applySalesOrderFixtureValues(doc, fixtureData, stamp);
	resetSalesOrderChildRows(doc);
	const customer = await ensureFixtureCustomer(sourceDocument);
	const address = await createFixtureCustomerAddress(customer, sourceDocument, stamp);
	doc.customer = customer.name;
	doc.customer_name = customer.customer_name || customer.name;
	doc.customer_address = address.name;
	doc.shipping_address_name = address.name;

	const inserted = await remoteCallFrappeMethod("frappe.client.insert", { doc });
	const paymentTermsTemplate = sourceDocument.payment_terms_template;
	if (paymentTermsTemplate && !inserted.payment_terms_template) {
		await remoteCallFrappeMethod("frappe.client.set_value", {
			doctype: "Sales Order",
			name: inserted.name,
			fieldname: "payment_terms_template",
			value: paymentTermsTemplate,
		});
		inserted.payment_terms_template = paymentTermsTemplate;
	}

	return {
		ok: true,
		name: inserted.name,
		reference: fixtureData.source_sales_order,
		customer: inserted.customer,
		company: inserted.company,
		delivery_date: inserted.delivery_date,
		delivery_terms: inserted.delivery_terms,
		named_place: inserted.named_place,
		payment_terms_template: inserted.payment_terms_template,
	};
}

async function createFixtureCustomerAddress(customer, sourceDocument, stamp) {
	const inserted = await remoteCallFrappeMethod("frappe.client.insert", {
		doc: {
			doctype: "Address",
			address_title: `${customer.customer_name || customer.name} ${stamp}`,
			address_type: "Billing",
			address_line1: "Playwright UAT test address",
			city: sourceDocument.named_place || "Alexandria",
			state: "VA",
			pincode: "22305",
			country: "United States",
			links: [
				{
					doctype: "Dynamic Link",
					link_doctype: "Customer",
					link_name: customer.name,
				},
			],
		},
	});
	return inserted;
}

async function ensureFixtureCustomer(sourceDocument) {
	const sourceCustomerName = sourceDocument.customer;
	if (sourceCustomerName) {
		const existing = await remoteGetDoc("Customer", sourceCustomerName, [
			"name",
			"customer_name",
		]);
		if (existing) {
			return existing;
		}
	}

	const inserted = await remoteCallFrappeMethod("frappe.client.insert", {
		doc: {
			doctype: "Customer",
			customer_name: sourceDocument.customer_name || `Playwright Customer ${Date.now()}`,
			customer_type: "Individual",
			customer_group: sourceDocument.customer_group || "Individual",
			territory: sourceDocument.territory || "All Territories",
		},
	});
	return inserted;
}

async function getInternalOrderChainStateViaApi(initialSoName) {
	const initialSo = await remoteGetDoc("Sales Order", initialSoName, [
		"name",
		"docstatus",
		"workflow_state",
		"status",
		"delivery_terms",
		"payment_terms_template",
	]);
	if (!initialSo) {
		return null;
	}

	const [po] = await remoteGetList("Purchase Order", {
		filters: [
			["custom_internal_sales_order", "=", initialSoName],
			["is_internal_supplier", "=", 1],
			["docstatus", "!=", 2],
		],
		fields: [
			"name",
			"docstatus",
			"workflow_state",
			"status",
			"delivery_terms",
			"payment_terms_template",
			"inter_company_order_reference",
		],
		limit: 1,
		orderBy: "creation desc",
	});

	let internalSo = null;
	if (po?.inter_company_order_reference) {
		internalSo = await remoteGetDoc("Sales Order", po.inter_company_order_reference, [
			"name",
			"docstatus",
			"workflow_state",
			"status",
			"delivery_terms",
			"payment_terms_template",
		]);
	} else if (po?.name) {
		const [candidate] = await remoteGetList("Sales Order", {
			filters: [
				["inter_company_order_reference", "=", po.name],
				["is_internal_customer", "=", 1],
				["docstatus", "!=", 2],
			],
			fields: [
				"name",
				"docstatus",
				"workflow_state",
				"status",
				"delivery_terms",
				"payment_terms_template",
			],
			limit: 1,
			orderBy: "creation desc",
		});
		internalSo = candidate || null;
	}

	return {
		ok: true,
		initial_so: initialSo,
		internal_po: po || null,
		internal_so: internalSo,
	};
}

function firstRateItem(doc) {
	const row = doc?.items?.[0];
	if (!row) {
		return null;
	}
	return {
		item_code: row.item_code,
		custom_item_pricelist: row.custom_item_pricelist,
		uom: row.uom,
		stock_uom: row.stock_uom,
		price_list_rate: Number(row.price_list_rate || 0),
		rate: Number(row.rate || 0),
		amount: Number(row.amount || 0),
		pricing_rules: row.pricing_rules,
	};
}

function numericValue(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

function pricingRuleRateFromDoc(rule, itemCode = null) {
	const disabled = Number(rule?.disable || 0);

	if (itemCode) {
		for (const tableName of ["pricing_rule_details", "items"]) {
			for (const row of rule?.[tableName] || []) {
				if (row.item_code && row.item_code !== itemCode) {
					continue;
				}

				const rowRate = numericValue(row.rate_or_discount) ?? numericValue(row.rate);
				if (rowRate !== null) {
					return {
						ok: true,
						name: rule.name,
						disabled,
						rate: rowRate,
						source: `${tableName}.rate_or_discount`,
						item_code: row.item_code,
					};
				}
			}
		}
	}

	const directRate = numericValue(rule?.rate_or_discount) ?? numericValue(rule?.rate);
	if (directRate !== null) {
		return {
			ok: true,
			name: rule.name,
			disabled,
			rate: directRate,
			source: "Pricing Rule.rate_or_discount",
		};
	}

	for (const tableName of ["pricing_rule_details", "items"]) {
		for (const row of rule?.[tableName] || []) {
			const rowRate = numericValue(row.rate_or_discount) ?? numericValue(row.rate);
			if (rowRate !== null) {
				return {
					ok: true,
					name: rule.name,
					disabled,
					rate: rowRate,
					source: `${tableName}.rate_or_discount`,
					item_code: row.item_code,
				};
			}
		}
	}

	return {
		ok: false,
		name: rule?.name,
		disabled,
		reason: `Pricing Rule ${rule?.name || ""} does not have a configured rate`,
	};
}

async function getInternalOrderRateSnapshotViaApi(initialSoName) {
	const chain = await getInternalOrderChainStateViaApi(initialSoName);
	if (!chain?.internal_po?.name) {
		return {
			ok: false,
			reason: `Internal Purchase Order not found for ${initialSoName}`,
			chain,
		};
	}

	const initialSo = await remoteGetDoc("Sales Order", initialSoName);
	const internalPo = await remoteGetDoc("Purchase Order", chain.internal_po.name);
	return {
		ok: true,
		initial_so: {
			name: initialSo.name,
			currency: initialSo.currency,
			price_list_currency: initialSo.price_list_currency,
			ignore_pricing_rule: Number(initialSo.ignore_pricing_rule || 0),
			item: firstRateItem(initialSo),
		},
		internal_po: {
			name: internalPo.name,
			currency: internalPo.currency,
			price_list_currency: internalPo.price_list_currency,
			buying_price_list: internalPo.buying_price_list,
			conversion_rate: Number(internalPo.conversion_rate || 0),
			ignore_pricing_rule: Number(internalPo.ignore_pricing_rule || 0),
			item: firstRateItem(internalPo),
		},
	};
}

export function getMultiSoFixture() {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.get_multi_so_fixture`);
	}
	return benchExecute(`${FIXTURE_MODULE}.get_multi_so_fixture`);
}

export function getSingleSoFixture() {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.get_single_so_fixture`);
	}
	return benchExecute(`${FIXTURE_MODULE}.get_single_so_fixture`);
}

export function createMultiSoPickList(soNames) {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.create_multi_so_pick_list`, {
			so_names: soNames,
		});
	}
	return benchExecute(`${FIXTURE_MODULE}.create_multi_so_pick_list`, [soNames]);
}

export function getSubmittedSoFixture() {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.get_submitted_so_fixture`);
	}
	return benchExecute(`${FIXTURE_MODULE}.get_submitted_so_fixture`);
}

export function getDraftSoFixture() {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.get_draft_so_fixture`);
	}
	return benchExecute(`${FIXTURE_MODULE}.get_draft_so_fixture`);
}

export function createInternalSalesOrderWorkflowFixture(referenceSo) {
	if (useRemoteFrappeApi()) {
		return createInternalSalesOrderWorkflowFixtureViaApi(referenceSo);
	}
	return benchExecute(`${FIXTURE_MODULE}.create_internal_sales_order_workflow_fixture`, [
		referenceSo,
	]);
}

export function createInternalSalesOrderWorkflowFixtureFromInput(input) {
	if (useRemoteFrappeApi()) {
		return createInternalSalesOrderWorkflowFixtureViaApi(input);
	}
	return benchExecute(`${FIXTURE_MODULE}.create_internal_sales_order_workflow_fixture`, [
		input,
	]);
}

export function getInternalOrderChainState(initialSoName) {
	if (useRemoteFrappeApi()) {
		return getInternalOrderChainStateViaApi(initialSoName);
	}
	return benchExecute(`${FIXTURE_MODULE}.get_internal_order_chain_state`, [initialSoName]);
}

export function setPricingRuleDisabled(pricingRule, disabled) {
	if (useRemoteFrappeApi()) {
		return (async () => {
			const rule = await remoteGetDoc("Pricing Rule", pricingRule, ["name", "disable"]);
			if (!rule) {
				return {
					ok: false,
					reason: `Pricing Rule ${pricingRule} not found`,
				};
			}
			const previousDisabled = Number(rule.disable || 0);
			await remoteCallFrappeMethod("frappe.client.set_value", {
				doctype: "Pricing Rule",
				name: pricingRule,
				fieldname: "disable",
				value: disabled ? 1 : 0,
			});
			return {
				ok: true,
				name: pricingRule,
				previous_disabled: previousDisabled,
				disabled: disabled ? 1 : 0,
			};
		})();
	}
	return benchExecute(`${FIXTURE_MODULE}.set_pricing_rule_disabled`, [pricingRule, disabled]);
}

export function getPricingRuleRate(pricingRule, itemCode = null) {
	if (useRemoteFrappeApi()) {
		return (async () => {
			const rule = await remoteGetDoc("Pricing Rule", pricingRule);
			if (!rule) {
				return {
					ok: false,
					reason: `Pricing Rule ${pricingRule} not found`,
				};
			}
			return pricingRuleRateFromDoc(rule, itemCode);
		})();
	}
	return benchExecute(`${FIXTURE_MODULE}.get_pricing_rule_rate`, [pricingRule, itemCode]);
}

export function getInternalOrderRateSnapshot(initialSoName) {
	if (useRemoteFrappeApi()) {
		return getInternalOrderRateSnapshotViaApi(initialSoName);
	}
	return benchExecute(`${FIXTURE_MODULE}.get_internal_order_rate_snapshot`, [initialSoName]);
}

export function applyInternalSoWorkflowAction(salesOrderName, action) {
	return benchExecute(`${FIXTURE_MODULE}.apply_internal_so_workflow_action`, [
		salesOrderName,
		action,
	]);
}

export function getPickListState(pickListName) {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.get_pick_list_state`, {
			pick_list_name: pickListName,
		});
	}
	return benchExecute(`${FIXTURE_MODULE}.get_pick_list_state`, [pickListName]);
}

export function getDeliveryNoteState(deliveryNoteName) {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.get_delivery_note_state`, {
			delivery_note_name: deliveryNoteName,
		});
	}
	return benchExecute(`${FIXTURE_MODULE}.get_delivery_note_state`, [deliveryNoteName]);
}

export function submitPickListForDn(pickListName) {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.submit_pick_list_for_dn`, {
			pick_list_name: pickListName,
		});
	}
	return benchExecute(`${FIXTURE_MODULE}.submit_pick_list_for_dn`, [pickListName]);
}

export function createDeliveryNoteFromPickList(pickListName) {
	if (useRemoteFrappeApi()) {
		return remoteCallFrappeMethod(`${FIXTURE_MODULE}.create_delivery_note_from_pick_list`, {
			pick_list_name: pickListName,
		});
	}
	return benchExecute(`${FIXTURE_MODULE}.create_delivery_note_from_pick_list`, [
		pickListName,
	]);
}
