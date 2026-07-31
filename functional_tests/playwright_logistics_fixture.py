"""
Playwright E2E fixtures for SO → Pick List → Delivery Note flows.
Run: bench --site <site> execute ntpt_erpnext_app.functional_tests.playwright_logistics_fixture.<fn>
"""
from __future__ import annotations

import frappe
from frappe.utils import add_days, flt, now_datetime, nowdate


SYSTEM_FIELDS = {
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
}


def _scrub_doc_for_insert(data):
	if not isinstance(data, dict):
		return data

	scrubbed = {}
	for fieldname, value in data.items():
		if fieldname in SYSTEM_FIELDS:
			continue
		if isinstance(value, list):
			scrubbed[fieldname] = [_scrub_doc_for_insert(row) for row in value]
		elif isinstance(value, dict):
			scrubbed[fieldname] = _scrub_doc_for_insert(value)
		else:
			scrubbed[fieldname] = value

	scrubbed["docstatus"] = 0
	return scrubbed


def _reset_so_child_rows(doc):
	for df in doc.meta.get_table_fields():
		for row in doc.get(df.fieldname) or []:
			row.docstatus = 0

	for row in doc.get("items") or []:
		row.delivery_date = doc.delivery_date
		for fieldname in (
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
		):
			if row.meta.has_field(fieldname):
				row.set(fieldname, 0)

	for row in doc.get("payment_schedule") or []:
		row.due_date = doc.transaction_date
		if row.meta.has_field("custom_payment_due_date"):
			row.custom_payment_due_date = doc.transaction_date
		if row.meta.has_field("discount_date"):
			row.discount_date = doc.transaction_date


def _apply_sales_order_fixture_values(doc, fixture_data, stamp):
	if not fixture_data:
		return

	for fieldname, value in (fixture_data.get("sales_order") or {}).items():
		doc.set(fieldname, value)

	for fieldname in fixture_data.get("clear_fields") or []:
		doc.set(fieldname, None)

	for fieldname, template in (fixture_data.get("generated_fields") or {}).items():
		doc.set(fieldname, str(template).format(stamp=stamp))

	for fieldname, offset in (fixture_data.get("date_offsets") or {}).items():
		doc.set(fieldname, add_days(nowdate(), int(offset)))


def _restore_payment_terms_from_fixture(doc, source_document):
	payment_terms_template = (source_document or {}).get("payment_terms_template")
	if not payment_terms_template or doc.payment_terms_template:
		return

	doc.payment_terms_template = payment_terms_template
	doc.set_payment_schedule()


@frappe.whitelist()
def create_internal_sales_order_workflow_fixture(
	fixture_data=None,
	reference_so=None,
):
	"""Create a fresh draft SO for Playwright from sales_order.json data."""
	if fixture_data is None and isinstance(reference_so, dict):
		fixture_data = reference_so
		reference_so = None

	stamp = now_datetime().strftime("%Y%m%d%H%M%S")
	source_document = fixture_data and fixture_data.get("document")

	if not source_document:
		return {"ok": False, "reason": "sales_order.json must include a full document object"}

	doc_data = _scrub_doc_for_insert(source_document)
	doc_data["doctype"] = "Sales Order"
	doc = frappe.get_doc(doc_data)
	doc.docstatus = 0
	doc.workflow_state = "Draft"
	doc.custom_previous_workflow_state_ = None
	doc.custom_previous_status = None
	doc.status = "Draft"
	doc.delivery_status = "Not Delivered"
	doc.billing_status = "Not Billed"
	doc.per_delivered = 0
	doc.per_billed = 0
	doc.per_picked = 0
	doc.transaction_date = nowdate()
	doc.delivery_date = add_days(nowdate(), 7)
	doc.custom_internal_order_required = 1
	doc.custom_source_of_order = "B2C Website"
	doc.custom_type_of_order = "Golf Order"
	doc.custom_has_stock = 0
	doc.custom_payment_status = "Received"
	doc.custom_payment_date = nowdate()
	doc.custom_mrp_order_id = f"PW-{stamp}"
	doc.woocommerce_order_id = f"PW-{stamp}"
	doc.custom_order_key = f"pw_order_{stamp}"
	doc.custom_transaction_id = f"pw_txn_{stamp}"
	doc.custom_invoice_number = None
	doc.custom_invoice_date = None
	doc.inter_company_order_reference = None
	doc.custom_against_sales_order = None
	doc.custom_sale_order = None
	doc.custom_internal_customer = None
	doc.custom_internal_customer_name = None
	_apply_sales_order_fixture_values(doc, fixture_data, stamp)

	_reset_so_child_rows(doc)
	doc.set_missing_values()
	doc.calculate_taxes_and_totals()
	_restore_payment_terms_from_fixture(doc, source_document)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	frappe.db.commit()

	return {
		"ok": True,
		"name": doc.name,
		"reference": fixture_data.get("source_sales_order") if fixture_data else reference_so,
		"customer": doc.customer,
		"company": doc.company,
		"delivery_date": str(doc.delivery_date),
		"delivery_terms": doc.delivery_terms,
		"named_place": doc.named_place,
		"payment_terms_template": doc.payment_terms_template,
	}


@frappe.whitelist()
def export_sales_order_json_fixture(reference_so="US-TPT-SO-26-0254"):
	"""Return a full Sales Order JSON fixture that tests can use without DB-copying the reference."""
	if not frappe.db.exists("Sales Order", reference_so):
		return {"ok": False, "reason": f"Reference Sales Order {reference_so} not found"}

	document = frappe.get_doc("Sales Order", reference_so).as_dict(no_nulls=False)
	return {
		"source_sales_order": reference_so,
		"document": document,
		"generated_fields": {
			"custom_mrp_order_id": "PW-{stamp}",
			"woocommerce_order_id": "PW-{stamp}",
			"custom_order_key": "pw_order_{stamp}",
			"custom_transaction_id": "pw_txn_{stamp}",
		},
		"date_offsets": {
			"transaction_date": 0,
			"delivery_date": 7,
			"custom_payment_date": 0,
		},
		"clear_fields": [
			"custom_previous_workflow_state_",
			"custom_previous_status",
			"custom_invoice_number",
			"custom_invoice_date",
			"inter_company_order_reference",
			"custom_against_sales_order",
			"custom_sale_order",
			"custom_internal_customer",
			"custom_internal_customer_name",
		],
		"sales_order": {
			"workflow_state": "Draft",
			"status": "Draft",
			"delivery_status": "Not Delivered",
			"billing_status": "Not Billed",
			"per_delivered": 0,
			"per_billed": 0,
			"per_picked": 0,
			"custom_internal_order_required": 1,
			"custom_source_of_order": "B2C Website",
			"custom_type_of_order": "Golf Order",
			"custom_has_stock": 0,
			"custom_payment_status": "Received",
		},
	}


@frappe.whitelist()
def get_internal_order_chain_state(initial_so_name):
	"""Return linked Internal PO and Internal SO state for an initial SO."""
	po_name = frappe.db.get_value(
		"Purchase Order",
		{
			"custom_internal_sales_order": initial_so_name,
			"is_internal_supplier": 1,
			"docstatus": ("!=", 2),
		},
		"name",
		order_by="creation desc",
	)
	po = frappe.get_doc("Purchase Order", po_name) if po_name else None

	internal_so_name = None
	if po:
		internal_so_name = po.inter_company_order_reference or frappe.db.get_value(
			"Sales Order",
			{
				"inter_company_order_reference": po.name,
				"is_internal_customer": 1,
				"docstatus": ("!=", 2),
			},
			"name",
			order_by="creation desc",
		)
	internal_so = frappe.get_doc("Sales Order", internal_so_name) if internal_so_name else None
	initial_so = frappe.get_doc("Sales Order", initial_so_name)

	return {
		"ok": True,
		"initial_so": {
			"name": initial_so.name,
			"docstatus": initial_so.docstatus,
			"workflow_state": initial_so.workflow_state,
			"status": initial_so.status,
			"delivery_terms": initial_so.delivery_terms,
			"payment_terms_template": initial_so.payment_terms_template,
		},
		"internal_po": {
			"name": po.name,
			"docstatus": po.docstatus,
			"workflow_state": po.workflow_state,
			"status": po.status,
			"delivery_terms": po.get("delivery_terms"),
			"payment_terms_template": po.payment_terms_template,
		}
		if po
		else None,
		"internal_so": {
			"name": internal_so.name,
			"docstatus": internal_so.docstatus,
			"workflow_state": internal_so.workflow_state,
			"status": internal_so.status,
			"delivery_terms": internal_so.delivery_terms,
			"payment_terms_template": internal_so.payment_terms_template,
		}
		if internal_so
		else None,
	}


@frappe.whitelist()
def set_pricing_rule_disabled(pricing_rule, disabled):
	"""Toggle a Pricing Rule for Playwright and return the previous/current state."""
	if not frappe.db.exists("Pricing Rule", pricing_rule):
		return {
			"ok": False,
			"reason": f"Pricing Rule {pricing_rule} not found",
		}

	before = frappe.db.get_value("Pricing Rule", pricing_rule, "disable")
	frappe.db.set_value("Pricing Rule", pricing_rule, "disable", 1 if disabled else 0)
	frappe.db.commit()
	return {
		"ok": True,
		"name": pricing_rule,
		"previous_disabled": int(before or 0),
		"disabled": int(1 if disabled else 0),
	}


@frappe.whitelist()
def get_pricing_rule_rate(pricing_rule, item_code=None):
	"""Return the configured numeric rate from a Pricing Rule."""
	if not frappe.db.exists("Pricing Rule", pricing_rule):
		return {
			"ok": False,
			"reason": f"Pricing Rule {pricing_rule} not found",
		}

	rule = frappe.get_doc("Pricing Rule", pricing_rule)
	disabled = int(rule.get("disable") or 0)

	def numeric_value(value):
		number = flt(value)
		return number if number > 0 else None

	if item_code:
		for table_name in ("pricing_rule_details", "items"):
			for row in rule.get(table_name) or []:
				if row.get("item_code") and row.get("item_code") != item_code:
					continue

				row_rate = numeric_value(row.get("rate_or_discount")) or numeric_value(row.get("rate"))
				if row_rate is not None:
					return {
						"ok": True,
						"name": pricing_rule,
						"disabled": disabled,
						"rate": row_rate,
						"source": f"{table_name}.rate_or_discount",
						"item_code": row.get("item_code"),
					}

	direct_rate = numeric_value(rule.get("rate_or_discount")) or numeric_value(rule.get("rate"))
	if direct_rate is not None:
		return {
			"ok": True,
			"name": pricing_rule,
			"disabled": disabled,
			"rate": direct_rate,
			"source": "Pricing Rule.rate_or_discount",
		}

	for table_name in ("pricing_rule_details", "items"):
		for row in rule.get(table_name) or []:
			row_rate = numeric_value(row.get("rate_or_discount")) or numeric_value(row.get("rate"))
			if row_rate is not None:
				return {
					"ok": True,
					"name": pricing_rule,
					"disabled": disabled,
					"rate": row_rate,
					"source": f"{table_name}.rate_or_discount",
					"item_code": row.get("item_code"),
				}

	return {
		"ok": False,
		"name": pricing_rule,
		"disabled": disabled,
		"reason": f"Pricing Rule {pricing_rule} does not have a configured rate",
	}


@frappe.whitelist()
def get_internal_order_rate_snapshot(initial_so_name):
	"""Return first item rates for the original SO and its Internal PO."""
	chain = get_internal_order_chain_state(initial_so_name)
	if not chain.get("internal_po"):
		return {
			"ok": False,
			"reason": f"Internal Purchase Order not found for {initial_so_name}",
			"chain": chain,
		}

	initial_so = frappe.get_doc("Sales Order", initial_so_name)
	internal_po = frappe.get_doc("Purchase Order", chain["internal_po"]["name"])

	def first_item(doc):
		row = (doc.get("items") or [None])[0]
		if not row:
			return None
		return {
			"item_code": row.item_code,
			"custom_item_pricelist": row.get("custom_item_pricelist"),
			"uom": row.get("uom"),
			"stock_uom": row.get("stock_uom"),
			"price_list_rate": flt(row.get("price_list_rate")),
			"rate": flt(row.get("rate")),
			"amount": flt(row.get("amount")),
			"pricing_rules": row.get("pricing_rules"),
		}

	return {
		"ok": True,
		"initial_so": {
			"name": initial_so.name,
			"currency": initial_so.currency,
			"price_list_currency": initial_so.price_list_currency,
			"ignore_pricing_rule": int(initial_so.get("ignore_pricing_rule") or 0),
			"item": first_item(initial_so),
		},
		"internal_po": {
			"name": internal_po.name,
			"currency": internal_po.currency,
			"price_list_currency": internal_po.price_list_currency,
			"buying_price_list": internal_po.buying_price_list,
			"conversion_rate": flt(internal_po.conversion_rate),
			"ignore_pricing_rule": int(internal_po.get("ignore_pricing_rule") or 0),
			"item": first_item(internal_po),
		},
	}


@frappe.whitelist()
def apply_internal_so_workflow_action(sales_order_name, action):
	"""Apply a Sales Order workflow action and mirror internal-order side effects."""
	from frappe.model.workflow import apply_workflow
	from ntpt_erpnext_app.ntpt_erpnext_app.doctype.sales_order.sales_order import (
		update_internal_order_workflow,
	)

	doc = frappe.get_doc("Sales Order", sales_order_name)
	updated = apply_workflow(doc, action)

	if (
		updated.doctype == "Sales Order"
		and updated.custom_type_of_order == "Internal Order"
		and updated.workflow_state in ("Order Shipped", "Delivered")
		and updated.custom_sale_order
	):
		update_internal_order_workflow("Sales Order", updated.custom_sale_order, updated.workflow_state)

	frappe.db.commit()
	return {
		"ok": True,
		"name": updated.name,
		"docstatus": updated.docstatus,
		"workflow_state": updated.workflow_state,
		"status": updated.status,
		"action": action,
	}


@frappe.whitelist()
def get_multi_so_fixture():
	"""Return two submitted, undelivered SOs for the same customer."""
	rows = frappe.db.sql(
		"""
		SELECT so.customer, so.company, GROUP_CONCAT(so.name ORDER BY so.modified DESC SEPARATOR ',') AS so_names
		FROM `tabSales Order` so
		WHERE so.docstatus = 1
		  AND so.status NOT IN ('Closed', 'Cancelled', 'On Hold')
		  AND so.per_delivered < 100
		  AND so.per_picked < 100
		  AND IFNULL(so.custom_internal_order_required, 0) = 0
		  AND so.name NOT LIKE '%-IC-%'
		  AND EXISTS (
			SELECT 1
			FROM `tabSales Order Item` soi
			INNER JOIN `tabItem` i ON i.name = soi.item_code AND i.is_stock_item = 1
			WHERE soi.parent = so.name
			  AND (soi.qty - soi.delivered_qty) > 0
		  )
		GROUP BY so.customer, so.company
		HAVING COUNT(*) >= 2
		ORDER BY MAX(so.modified) DESC
		LIMIT 1
		""",
		as_dict=True,
	)
	if not rows:
		return {"ok": False, "reason": "No customer with 2+ eligible submitted Sales Orders"}

	so_names = rows[0].so_names.split(",")[:2]
	eligible = []
	for so_name in so_names:
		per_picked, per_delivered = frappe.db.get_value(
			"Sales Order", so_name, ["per_picked", "per_delivered"]
		)
		if flt(per_picked) < 100 and flt(per_delivered) < 100:
			eligible.append(so_name)

	if len(eligible) < 2:
		return {
			"ok": False,
			"reason": "Multi-SO pair no longer eligible (picked/delivered)",
			"candidate_names": so_names,
		}

	return {
		"ok": True,
		"customer": rows[0].customer,
		"company": rows[0].company,
		"so_names": eligible[:2],
	}


@frappe.whitelist()
def create_multi_so_pick_list(so_names):
	"""Create a multi-SO Pick List via server mapper (stable test setup)."""
	from erpnext.selling.doctype.sales_order.sales_order import create_pick_list
	from ntpt_erpnext_app.ntpt_erpnext_app.doctype.pick_list.pick_list import (
		apply_ntpt_manual_pick_rules,
		sync_pick_list_header_from_sales_orders,
	)

	pick_list = frappe.new_doc("Pick List")
	for so_name in so_names:
		pick_list = create_pick_list(so_name, pick_list)
	apply_ntpt_manual_pick_rules(pick_list)
	sync_pick_list_header_from_sales_orders(pick_list)
	pick_list.flags.ignore_mandatory = True
	pick_list.save(ignore_permissions=True)
	frappe.db.commit()
	linked_sos = sorted({loc.sales_order for loc in pick_list.locations if loc.sales_order})
	return {
		"ok": True,
		"name": pick_list.name,
		"sales_orders": linked_sos,
		"pick_manually": pick_list.pick_manually,
	}


@frappe.whitelist()
def get_single_so_fixture():
	"""Submitted SO for single-SO Pick List test (not shared with multi-SO pair)."""
	multi = get_multi_so_fixture()
	exclude = set(multi.get("so_names") or []) if multi.get("ok") else set()
	rows = frappe.db.sql(
		"""
		SELECT so.name, so.customer, so.company, so.docstatus, so.workflow_state
		FROM `tabSales Order` so
		WHERE so.docstatus = 1
		  AND so.status NOT IN ('Closed', 'Cancelled', 'On Hold')
		  AND so.per_delivered < 100
		  AND so.per_picked < 100
		  AND IFNULL(so.custom_internal_order_required, 0) = 0
		  AND so.name NOT LIKE '%-IC-%'
		  AND EXISTS (
			SELECT 1
			FROM `tabSales Order Item` soi
			INNER JOIN `tabItem` i ON i.name = soi.item_code AND i.is_stock_item = 1
			WHERE soi.parent = so.name
			  AND (soi.qty - soi.delivered_qty) > 0
		  )
		ORDER BY so.modified DESC
		LIMIT 20
		""",
		as_dict=True,
	)
	for so in rows:
		if so.name in exclude:
			continue
		return {
			"ok": True,
			"name": so.name,
			"customer": so.customer,
			"company": so.company,
			"docstatus": so.docstatus,
			"workflow_state": so.workflow_state,
		}
	return {"ok": False, "reason": "No eligible single Sales Order found"}


@frappe.whitelist()
def get_submitted_so_fixture():
	"""Return one submitted SO eligible for Pick List creation."""
	rows = frappe.db.sql(
		"""
		SELECT so.name, so.customer, so.company, so.docstatus, so.workflow_state,
		       so.per_picked, so.per_delivered
		FROM `tabSales Order` so
		WHERE so.docstatus = 1
		  AND so.status NOT IN ('Closed', 'Cancelled', 'On Hold')
		  AND so.per_delivered < 100
		  AND so.per_picked < 100
		  AND IFNULL(so.custom_internal_order_required, 0) = 0
		  AND so.name NOT LIKE '%-IC-%'
		  AND EXISTS (
			SELECT 1
			FROM `tabSales Order Item` soi
			INNER JOIN `tabItem` i ON i.name = soi.item_code AND i.is_stock_item = 1
			WHERE soi.parent = so.name
			  AND (soi.qty - soi.delivered_qty) > 0
		  )
		ORDER BY so.modified DESC
		LIMIT 1
		""",
		as_dict=True,
	)
	if not rows:
		return {"ok": False, "reason": "No eligible submitted Sales Order found"}
	so = rows[0]
	return {
		"ok": True,
		"name": so.name,
		"customer": so.customer,
		"company": so.company,
		"docstatus": so.docstatus,
		"workflow_state": so.workflow_state,
	}


@frappe.whitelist()
def get_draft_so_fixture():
	"""Return a draft SO that can be submitted (has items, delivery terms if required)."""
	rows = frappe.db.sql(
		"""
		SELECT so.name, so.customer, so.company, so.workflow_state
		FROM `tabSales Order` so
		WHERE so.docstatus = 0
		  AND so.workflow_state = 'Draft'
		  AND IFNULL(so.custom_internal_order_required, 0) = 0
		  AND so.order_type IN ('Sales', 'Shopping Cart')
		  AND EXISTS (
			SELECT 1 FROM `tabSales Order Item` soi WHERE soi.parent = so.name
		  )
		ORDER BY so.modified DESC
		LIMIT 5
		""",
		as_dict=True,
	)
	for so in rows:
		has_delivery_terms = True
		if frappe.get_meta("Sales Order").has_field("custom_delivery_terms"):
			has_delivery_terms = bool(
				frappe.db.get_value("Sales Order", so.name, "custom_delivery_terms")
			)
		if has_delivery_terms:
			return {
				"ok": True,
				"name": so.name,
				"customer": so.customer,
				"company": so.company,
				"workflow_state": so.workflow_state,
			}
	return {"ok": False, "reason": "No draft Sales Order with items and delivery terms found"}


@frappe.whitelist()
def submit_pick_list_for_dn(pick_list_name):
	"""Submit a draft Pick List (NTPT manual pick allows empty warehouse)."""
	pl = frappe.get_doc("Pick List", pick_list_name)
	if pl.docstatus == 1:
		return {"ok": True, "name": pl.name, "docstatus": 1, "already_submitted": True}
	pl.flags.ignore_mandatory = True
	pl.submit()
	frappe.db.commit()
	return {"ok": True, "name": pl.name, "docstatus": pl.docstatus}


@frappe.whitelist()
def create_delivery_note_from_pick_list(pick_list_name):
	"""Create DN from Pick List via ERPNext mapper (API path used when UI needs submitted PL)."""
	from erpnext.stock.doctype.pick_list.pick_list import create_delivery_note

	try:
		dn = create_delivery_note(pick_list_name)
	except Exception as exc:
		return {"ok": False, "reason": str(exc)}

	filtered_items = []
	for item in dn.get("items") or []:
		if flt(item.qty) <= 0:
			continue
		if frappe.db.get_value("Item", item.item_code, "disabled"):
			continue
		filtered_items.append(item)

	if not filtered_items:
		return {"ok": False, "reason": "No deliverable items after filtering zero/disabled rows"}

	dn.set("items", filtered_items)
	dn.flags.ignore_mandatory = True
	if not dn.name:
		try:
			dn.save(ignore_permissions=True)
		except Exception as exc:
			return {"ok": False, "reason": str(exc)}

	frappe.db.commit()
	item_sos = sorted({i.against_sales_order for i in dn.items if i.against_sales_order})
	header_sos = sorted(
		{row.sales_order for row in dn.get("custom_sales_orders") or [] if row.sales_order}
	)
	return {
		"ok": True,
		"name": dn.name,
		"pick_list": pick_list_name,
		"item_sales_orders": item_sos,
		"header_sales_orders": header_sos,
		"item_count": len(dn.items or []),
	}


@frappe.whitelist()
def get_pick_list_state(pick_list_name):
	pl = frappe.get_doc("Pick List", pick_list_name)
	linked_sos = sorted({loc.sales_order for loc in pl.locations if loc.sales_order})
	cleared = all(not (r.warehouse or r.batch_no) for r in pl.locations)
	return {
		"name": pl.name,
		"docstatus": pl.docstatus,
		"pick_manually": pl.pick_manually,
		"customer": pl.customer,
		"company": pl.company,
		"location_count": len(pl.locations),
		"sales_orders": linked_sos,
		"warehouses_cleared": cleared,
		"package_comment": pl.custom_package_print_comment or "",
	}


@frappe.whitelist()
def get_delivery_note_state(delivery_note_name):
	dn = frappe.get_doc("Delivery Note", delivery_note_name)
	item_sos = sorted({i.against_sales_order for i in dn.items if i.against_sales_order})
	header_sos = sorted(
		{row.sales_order for row in dn.get("custom_sales_orders") or [] if row.sales_order}
	)
	pick_lists = sorted({i.against_pick_list for i in dn.items if i.against_pick_list})
	return {
		"name": dn.name,
		"docstatus": dn.docstatus,
		"customer": dn.customer,
		"item_sales_orders": item_sos,
		"header_sales_orders": header_sos,
		"pick_lists": pick_lists,
		"item_count": len(dn.items or []),
		"package_comment": dn.get("custom_package_print_comment") or "",
	}
