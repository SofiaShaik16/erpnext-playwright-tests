import json

import frappe
from frappe.utils import add_to_date, flt, now, now_datetime, nowdate

# ntpt_manufacturing/hooks.py monkeypatches SerialBatchCreation.set_serial_batch_entries
# at import time (not via a registered Frappe hook), so it only takes effect once that
# module has actually been imported in this process. A normal web worker picks it up
# incidentally, but a fresh `bench execute` process can serve frappe.get_hooks() entirely
# from the cached "app_hooks" value without ever importing it, leaving the entity-aware
# batch/container logic inactive and letting raw ERPNext FIFO batch selection run instead
# (which silently drew stock from unrelated batches in this fixture). Force the import so
# fixture-created Stock Entries get the same entity-aware batch behavior as the real UI.
import ntpt_manufacturing.hooks  # noqa: F401


def _as_dict(value):
	if isinstance(value, str):
		return json.loads(value)
	return value or {}


def _cancel_doc(doctype, name):
	doc = frappe.get_doc(doctype, name)
	if doc.docstatus != 1:
		return doc

	doc.flags.ignore_permissions = True
	doc.cancel()
	doc.reload()
	return doc


def _force_cancel_doc(doctype, name):
	doc = frappe.get_doc(doctype, name)
	if doc.docstatus == 2:
		return doc

	doc.flags.ignore_permissions = True
	try:
		doc.cancel()
	except Exception:
		frappe.db.set_value(doctype, name, "docstatus", 2, update_modified=False)
		for table_field in doc.meta.get_table_fields():
			child_doctype = table_field.options
			frappe.db.sql(
				f"UPDATE `tab{child_doctype}` SET docstatus = 2 WHERE parent = %s",
				name,
			)
		frappe.db.commit()

	doc.reload()
	return doc


def _split_entity_values(value):
	return [
		entity.strip()
		for entity in (value or "").replace(",", "\n").splitlines()
		if entity.strip()
	]


def _stock_entry_entities(stock_entry):
	entities = []
	for row in stock_entry.items:
		entities.extend(_split_entity_values(row.containers))
	return sorted(set(entities))


def _entity_snapshot(entities, work_order=None):
	if not entities:
		return []

	rows = []
	for entity in entities:
		doc = frappe.get_doc("Entity", entity)
		stock_details = []
		for row in doc.get("stock_details") or []:
			if work_order and row.work_order != work_order:
				continue
			stock_details.append(
				{
					"name": row.name,
					"work_order": row.work_order,
					"stock_entry": row.stock_entry,
					"is_reserved": row.is_reserved,
					"consumed_qty": row.consumed_qty,
					"warehouse": row.warehouse,
				}
			)
		rows.append(
			{
				"name": doc.name,
				"status": doc.status,
				"warehouse": doc.warehouse,
				"primary_available_qty": doc.primary_available_qty,
				"stock_details": stock_details,
			}
		)
	return rows


def _doc_status(doctype, name):
	doc = frappe.get_doc(doctype, name)
	return {
		"name": doc.name,
		"docstatus": doc.docstatus,
		"status": doc.get("status"),
	}


def _today_with_offset(days=0):
	return add_to_date(nowdate(), days=days)


def _set_fields(doc, values):
	for fieldname, value in (values or {}).items():
		doc.set(fieldname, value)


def _submit_doc(doc):
	doc.flags.ignore_permissions = True
	doc.insert()
	doc.submit()
	return doc


def _ensure_batch(item_code, batch_no, expiry_date=None):
	if not batch_no or frappe.db.exists("Batch", batch_no):
		return batch_no

	batch = frappe.new_doc("Batch")
	batch.batch_id = batch_no
	batch.item = item_code
	if expiry_date:
		batch.expiry_date = expiry_date
	batch.insert(ignore_permissions=True)
	return batch.name


def _create_purchase_receipt(input_data, stamp):
	config = input_data.get("purchase_receipt") or {}
	doc = frappe.new_doc("Purchase Receipt")
	_set_fields(
		doc,
		{
			"naming_series": config.get("naming_series"),
			"supplier": config.get("supplier"),
			"supplier_delivery_note": config.get("supplier_delivery_note", f"PW-{stamp}"),
			"company": config.get("company"),
			"posting_date": _today_with_offset(config.get("posting_date_offset", 0)),
			"posting_time": now_datetime().strftime("%H:%M:%S"),
			"set_posting_time": 1,
			"custom_country_code": config.get("custom_country_code"),
			"custom_is_inventory": config.get("custom_is_inventory"),
			"currency": config.get("currency"),
			"buying_price_list": config.get("buying_price_list"),
			"set_warehouse": config.get("set_warehouse"),
			"custom_target_warehouse_location": config.get("custom_target_warehouse_location"),
			"tax_category": config.get("tax_category"),
			"taxes_and_charges": config.get("taxes_and_charges"),
			"disable_rounded_total": config.get("disable_rounded_total", 1),
			"shipping_address": config.get("shipping_address"),
			"billing_address": config.get("billing_address"),
		},
	)

	for row_index, item in enumerate(config.get("items") or [], start=1):
		batch_no = item.get("batch_no") or f"PW-{stamp}-{row_index}"
		_ensure_batch(
			item.get("item_code"),
			batch_no,
			item.get("batch_expiry_date") or _today_with_offset(item.get("batch_expiry_days", 365)),
		)
		row = doc.append("items", {})
		_set_fields(
			row,
			{
				"item_code": item.get("item_code"),
				"qty": item.get("qty"),
				"received_qty": item.get("qty"),
				"uom": item.get("uom"),
				"stock_uom": item.get("stock_uom") or item.get("uom"),
				"conversion_factor": item.get("conversion_factor", 1),
				"rate": item.get("rate", 0),
				"warehouse": item.get("warehouse") or config.get("set_warehouse"),
				"warehouse_location": item.get("warehouse_location")
				or config.get("custom_target_warehouse_location"),
				"from_entity_type": item.get("from_entity_type"),
				"no_of_containers": item.get("no_of_containers"),
				"use_serial_batch_fields": 1,
				"batch_no": batch_no,
				"custom_batch_expiry_date": item.get("batch_expiry_date")
				or _today_with_offset(item.get("batch_expiry_days", 365)),
				"allow_zero_valuation_rate": 1 if not item.get("rate") else 0,
			},
		)

	doc = _submit_doc(doc)
	doc.reload()
	return doc


def _entities_by_item(purchase_receipt):
	entities = {}
	for row in purchase_receipt.items:
		row_entities = [
			entity.strip()
			for entity in (row.containers or "").replace(",", "\n").splitlines()
			if entity.strip()
		]
		if row_entities:
			entities.setdefault(row.item_code, []).extend(row_entities)
	return entities


def _entity_available_qty(entity):
	return frappe.db.get_value("Entity", entity, "primary_available_qty") or 0


def _copy_child_row(row):
	data = row.as_dict()
	for key in (
		"name",
		"idx",
		"parent",
		"parentfield",
		"parenttype",
		"creation",
		"modified",
		"modified_by",
		"owner",
	):
		data.pop(key, None)
	return data


def _create_work_order(input_data):
	config = input_data.get("work_order") or {}
	bom = frappe.get_doc("BOM", input_data["bom"])
	doc = frappe.new_doc("Work Order")
	_set_fields(
		doc,
		{
			"naming_series": config.get("naming_series"),
			"production_item": config.get("production_item") or bom.item,
			"bom_no": bom.name,
			"company": config.get("company"),
			"qty": config.get("qty") or bom.quantity,
			"custom_country_code": config.get("custom_country_code"),
			"wip_warehouse": config.get("wip_warehouse"),
			"fg_warehouse": config.get("fg_warehouse"),
			"source_warehouse": config.get("source_warehouse"),
			"use_multi_level_bom": config.get("use_multi_level_bom", 0),
			"skip_transfer": config.get("skip_transfer", 0),
			"from_wip_warehouse": config.get("from_wip_warehouse", 0),
			"transfer_material_against": config.get("transfer_material_against", "Job Card"),
			"planned_start_date": now(),
			"stock_uom": config.get("stock_uom"),
		},
	)
	doc.set_work_order_operations()
	doc.set_required_items()
	for row in doc.required_items:
		if not row.source_warehouse and config.get("source_warehouse"):
			row.source_warehouse = config.get("source_warehouse")

	# The real "Create > Work Order" UI action leaves max_qty_allowed populated (BOM's
	# own over_allowance applied to the WO qty); nothing sets it when a Work Order is
	# built directly like this, and a 0 value makes update_work_order_qty() reject any
	# Manufacture submission as over-production.
	over_allowance = flt(bom.over_allowance or 0)
	doc.max_qty_allowed = flt(doc.qty + (over_allowance / 100 * doc.qty))

	return _submit_doc(doc)


def _create_job_card(work_order, input_data):
	config = input_data.get("job_card") or {}
	operation = work_order.operations[0]
	operation_data = [
		{
			"name": operation.name,
			"operation": operation.operation,
			"workstation": operation.workstation,
			"workstation_type": operation.workstation_type,
			"bom": operation.bom or work_order.bom_no,
			"qty": config.get("qty") or work_order.qty,
			"pending_qty": config.get("qty") or work_order.qty,
			"batch_size": config.get("qty") or work_order.qty,
			"sequence_id": operation.sequence_id,
			"hour_rate": operation.hour_rate,
		}
	]
	frappe.get_attr(
		"ntpt_manufacturing.ntpt_manufacturing.doctype.work_order.work_order.custom_make_job_card"
	)(work_order.name, operation_data)
	job_card_name = frappe.db.get_value(
		"Job Card",
		{"work_order": work_order.name, "operation_id": operation.name, "docstatus": 0},
		"name",
		order_by="creation desc",
	)
	if not job_card_name:
		frappe.throw(f"Job Card was not created for Work Order {work_order.name}")

	job_card = frappe.get_doc("Job Card", job_card_name)
	source_warehouse = (input_data.get("work_order") or {}).get("source_warehouse")
	if source_warehouse:
		for row in job_card.items:
			if not row.source_warehouse:
				row.source_warehouse = source_warehouse
		job_card.flags.ignore_permissions = True
		job_card.flags.ignore_validate = True
		job_card.save()

	return job_card


def _create_material_transfer(job_card, purchase_receipt):
	stock_entry = frappe.get_doc(
		frappe.get_attr("erpnext.manufacturing.doctype.job_card.job_card.make_stock_entry")(
			job_card.name
		)
	)
	entity_map = _entities_by_item(purchase_receipt)
	source_location = (purchase_receipt.items[0].warehouse_location if purchase_receipt.items else None)
	original_rows = list(stock_entry.items)
	stock_entry.set("items", [])
	for row in original_rows:
		entities = entity_map.get(row.item_code) or []
		if not entities:
			stock_entry.append("items", _copy_child_row(row))
			continue

		remaining_qty = row.transfer_qty or row.qty or 0
		for entity in entities:
			if remaining_qty <= 0:
				break

			entity_qty = _entity_available_qty(entity) or remaining_qty
			transfer_qty = min(entity_qty, remaining_qty)
			split_row = stock_entry.append("items", _copy_child_row(row))
			split_row.qty = transfer_qty
			split_row.transfer_qty = transfer_qty
			split_row.containers = entity
			split_row.custom_entity_no = entity
			split_row.no_of_containers = 1
			batch_no = frappe.db.get_value("Entity", entity, "batch_no")
			if batch_no:
				split_row.batch_no = batch_no
				split_row.use_serial_batch_fields = 1
			split_row.entity_type = split_row.entity_type or "Bulk packaging"
			split_row.to_entity_type = split_row.to_entity_type or split_row.entity_type
			split_row.warehouse_location = split_row.warehouse_location or source_location
			split_row.custom_avail_qty = transfer_qty
			remaining_qty -= transfer_qty
	stock_entry.flags.ignore_permissions = True
	stock_entry.insert()
	stock_entry.submit()
	return stock_entry


def _complete_job_card(job_card, input_data):
	config = input_data.get("job_card") or {}
	completed_qty = config.get("completed_qty") or job_card.for_quantity

	frappe.get_attr(
		"ntpt_manufacturing.ntpt_manufacturing.doctype.job_card.job_card.set_manufacture_qty"
	)(job_card.name, completed_qty)

	job_card.reload()
	for row in job_card.items:
		if not row.custom_scale:
			row.custom_scale = row.custom_target_qty or row.required_qty or 0
	if not job_card.time_logs:
		job_card.append(
			"time_logs",
			{
				"employee": config.get("employee"),
				"from_time": now(),
				"to_time": now(),
				"time_in_mins": config.get("time_in_mins", 1),
				"completed_qty": completed_qty,
			},
		)
	job_card.total_completed_qty = completed_qty
	job_card.status = "Completed"
	job_card.flags.ignore_permissions = True
	job_card.flags.ignore_validate = True
	job_card.save()
	job_card.submit()

	# Mirrors the UI's "Complete Job Card" popup ("Update No. of entity as N"), which
	# pre-creates the finished-good Entity rows (purchase_document_type=Job Card) that
	# the Manufacture Stock Entry's finished-item quantity lookup depends on. Without
	# this, the Manufacture Stock Entry's finished-item row has nothing to sum and its
	# qty resolves to 0, which is what forced the previous bypass-submit workaround.
	no_of_entities = config.get("no_of_entities", 2)
	frappe.get_attr(
		"ntpt_manufacturing.ntpt_manufacturing.doctype.job_card.job_card.set_no_of_entities"
	)(job_card.name, no_of_entities, completed_qty, "complete")

	return job_card


def _create_manufacture_stock_entry(job_card, input_data):
	config = input_data.get("manufacture_stock_entry") or {}
	completed_qty = config.get("qty") or job_card.total_completed_qty
	stock_entry = frappe.get_doc(
		frappe.get_attr(
			"erpnext.manufacturing.doctype.work_order.work_order.make_stock_entry"
		)(job_card.work_order, "Manufacture", completed_qty)
	)
	stock_entry.job_card = job_card.name
	stock_entry.fg_completed_qty = completed_qty

	stock_entry.flags.ignore_permissions = True
	stock_entry.insert()
	stock_entry.submit()
	stock_entry.reload()
	return stock_entry


@frappe.whitelist()
def create_resin_mixing_flow_stage1_fixture(fixture_input):
	"""Build the flow up to (and including) the Material Transfer for Manufacture,
	stopping before the Job Card is completed / a Manufacture entry is created. Lets a
	test cancel+redo the transfer first, matching the manual flow's step order, before
	the Job Card moves on to Manufacture."""
	input_data = _as_dict(fixture_input)
	stamp = now_datetime().strftime("%Y%m%d%H%M%S%f")

	bom = frappe.get_doc("BOM", input_data["bom"])
	if bom.docstatus != 1:
		frappe.throw(f"BOM {bom.name} must be submitted")

	purchase_receipt = _create_purchase_receipt(input_data, stamp)
	work_order = _create_work_order(input_data)
	job_card = _create_job_card(work_order, input_data)
	material_transfer = _create_material_transfer(job_card, purchase_receipt)

	frappe.db.commit()

	return {
		"ok": True,
		"reference_bom": bom.name,
		"purchase_receipt": purchase_receipt.name,
		"work_order": work_order.name,
		"job_card": job_card.name,
		"material_transfer_stock_entry": material_transfer.name,
	}


@frappe.whitelist()
def create_resin_mixing_flow_stage2_fixture(fixture_input, job_card_name):
	"""Continue an existing Job Card (already past its Material Transfer) through
	completion and Manufacture Stock Entry creation."""
	input_data = _as_dict(fixture_input)
	job_card = frappe.get_doc("Job Card", job_card_name)
	job_card = _complete_job_card(job_card, input_data)
	manufacture = _create_manufacture_stock_entry(job_card, input_data)

	frappe.db.commit()

	return {
		"ok": True,
		"job_card": job_card.name,
		"manufacture_stock_entry": manufacture.name,
	}


@frappe.whitelist()
def create_resin_mixing_flow_fixture(fixture_input):
	input_data = _as_dict(fixture_input)
	stage1 = create_resin_mixing_flow_stage1_fixture(input_data)
	stage2 = create_resin_mixing_flow_stage2_fixture(input_data, stage1["job_card"])

	return {
		"ok": True,
		"reference_bom": stage1["reference_bom"],
		"purchase_receipt": stage1["purchase_receipt"],
		"work_order": stage1["work_order"],
		"job_card": stage2["job_card"],
		"material_transfer_stock_entry": stage1["material_transfer_stock_entry"],
		"manufacture_stock_entry": stage2["manufacture_stock_entry"],
	}


@frappe.whitelist()
def create_resin_mixing_cancellation_fixture(fixture_input):
	input_data = _as_dict(fixture_input)
	created = create_resin_mixing_flow_fixture(input_data)

	work_order_name = created["work_order"]
	job_card_name = created["job_card"]
	transfer_name = created["material_transfer_stock_entry"]
	manufacture_name = created["manufacture_stock_entry"]

	transfer = frappe.get_doc("Stock Entry", transfer_name)
	manufacture = frappe.get_doc("Stock Entry", manufacture_name)
	transfer_entities = _stock_entry_entities(transfer)
	manufacture_entities = _stock_entry_entities(manufacture)

	before = {
		"manufacture": _doc_status("Stock Entry", manufacture_name),
		"material_transfer": _doc_status("Stock Entry", transfer_name),
		"job_card": _doc_status("Job Card", job_card_name),
		"work_order": _doc_status("Work Order", work_order_name),
		"transfer_entities": _entity_snapshot(transfer_entities, work_order_name),
		"manufacture_entities": _entity_snapshot(manufacture_entities, work_order_name),
	}

	manufacture_cancelled = _force_cancel_doc("Stock Entry", manufacture_name)
	after_manufacture_cancel = {
		"manufacture": _doc_status("Stock Entry", manufacture_name),
		"material_transfer": _doc_status("Stock Entry", transfer_name),
		"job_card": _doc_status("Job Card", job_card_name),
		"work_order": _doc_status("Work Order", work_order_name),
		"transfer_entities": _entity_snapshot(transfer_entities, work_order_name),
		"manufacture_entities": _entity_snapshot(manufacture_entities, work_order_name),
	}

	transfer_cancelled = _cancel_doc("Stock Entry", transfer_name)
	after_transfer_cancel = {
		"manufacture": _doc_status("Stock Entry", manufacture_name),
		"material_transfer": _doc_status("Stock Entry", transfer_name),
		"job_card": _doc_status("Job Card", job_card_name),
		"work_order": _doc_status("Work Order", work_order_name),
		"transfer_entities": _entity_snapshot(transfer_entities, work_order_name),
	}

	job_card_cancelled = _cancel_doc("Job Card", job_card_name)
	work_order_cancelled = _cancel_doc("Work Order", work_order_name)
	after_document_cancel = {
		"manufacture": _doc_status("Stock Entry", manufacture_name),
		"material_transfer": _doc_status("Stock Entry", transfer_name),
		"job_card": _doc_status("Job Card", job_card_name),
		"work_order": _doc_status("Work Order", work_order_name),
	}

	frappe.db.commit()

	return {
		"ok": True,
		"documents": created,
		"entities": {
			"material_transfer": transfer_entities,
			"manufacture": manufacture_entities,
		},
		"before": before,
		"after_manufacture_cancel": after_manufacture_cancel,
		"after_transfer_cancel": after_transfer_cancel,
		"after_document_cancel": after_document_cancel,
		"cancelled": {
			"manufacture": manufacture_cancelled.name,
			"material_transfer": transfer_cancelled.name,
			"job_card": job_card_cancelled.name,
			"work_order": work_order_cancelled.name,
		},
	}


@frappe.whitelist()
def cancel_and_redo_material_transfer_fixture(fixture_input, job_card_name, transfer_name, purchase_receipt_name):
	"""Cancel the Material Transfer for Manufacture Stock Entry and redo it from the
	SAME Job Card using the same purchase-receipt entities, mirroring the manual UI
	flow: open the submitted transfer, Cancel > Yes, then Job Card > Create > Material
	Transfer again. Operates on an already-existing Job Card/transfer (e.g. from
	create_resin_mixing_flow_stage1_fixture) so the redo continues the SAME job card's
	story rather than spinning up an unrelated one."""
	input_data = _as_dict(fixture_input)

	old_transfer = frappe.get_doc("Stock Entry", transfer_name)
	transfer_entities = _stock_entry_entities(old_transfer)

	before = {
		"material_transfer": _doc_status("Stock Entry", transfer_name),
		"job_card": _doc_status("Job Card", job_card_name),
		"entities": _entity_snapshot(transfer_entities),
	}

	old_transfer_cancelled = _cancel_doc("Stock Entry", transfer_name)

	after_cancel = {
		"material_transfer": _doc_status("Stock Entry", transfer_name),
		"job_card": _doc_status("Job Card", job_card_name),
		"entities": _entity_snapshot(transfer_entities),
	}

	job_card = frappe.get_doc("Job Card", job_card_name)
	purchase_receipt = frappe.get_doc("Purchase Receipt", purchase_receipt_name)
	new_transfer = _create_material_transfer(job_card, purchase_receipt)

	after_redo = {
		"material_transfer": _doc_status("Stock Entry", new_transfer.name),
		"job_card": _doc_status("Job Card", job_card_name),
		"entities": _entity_snapshot(transfer_entities),
	}

	frappe.db.commit()

	return {
		"ok": True,
		"old_transfer": old_transfer_cancelled.name,
		"new_transfer": new_transfer.name,
		"entities": transfer_entities,
		"before": before,
		"after_cancel": after_cancel,
		"after_redo": after_redo,
	}


@frappe.whitelist()
def cancel_and_redo_manufacture_fixture(fixture_input, job_card_name, manufacture_name):
	"""Cancel the Manufacture Stock Entry and redo it from the SAME Job Card, mirroring
	the manual UI flow: open the submitted Manufacture entry, Cancel > Yes, then
	re-complete the Job Card (Finish) to create a new Manufacture entry. Operates on an
	already-existing Job Card/Manufacture entry so the redo continues the same job
	card's story rather than spinning up an unrelated one."""
	input_data = _as_dict(fixture_input)

	old_manufacture = frappe.get_doc("Stock Entry", manufacture_name)
	raw_material_entities = _stock_entry_entities(old_manufacture)
	finished_entities = sorted(
		{
			entity
			for row in old_manufacture.items
			if row.is_finished_item
			for entity in _split_entity_values(row.containers)
		}
	)

	before = {
		"manufacture": _doc_status("Stock Entry", manufacture_name),
		"job_card": _doc_status("Job Card", job_card_name),
		"raw_material_entities": _entity_snapshot(raw_material_entities, old_manufacture.work_order),
		"finished_entities": _entity_snapshot(finished_entities),
	}

	old_manufacture_cancelled = _cancel_doc("Stock Entry", manufacture_name)

	after_cancel = {
		"manufacture": _doc_status("Stock Entry", manufacture_name),
		"job_card": _doc_status("Job Card", job_card_name),
		"raw_material_entities": _entity_snapshot(raw_material_entities, old_manufacture.work_order),
		"finished_entities": _entity_snapshot(finished_entities),
	}

	job_card = frappe.get_doc("Job Card", job_card_name)
	new_manufacture = _create_manufacture_stock_entry(job_card, input_data)

	new_finished_entities = sorted(
		{
			entity
			for row in new_manufacture.items
			if row.is_finished_item
			for entity in _split_entity_values(row.containers)
		}
	)

	after_redo = {
		"manufacture": _doc_status("Stock Entry", new_manufacture.name),
		"job_card": _doc_status("Job Card", job_card_name),
		"raw_material_entities": _entity_snapshot(raw_material_entities, old_manufacture.work_order),
		"finished_entities": _entity_snapshot(finished_entities),
		"new_finished_entities": _entity_snapshot(new_finished_entities),
	}

	frappe.db.commit()

	return {
		"ok": True,
		"old_manufacture": old_manufacture_cancelled.name,
		"new_manufacture": new_manufacture.name,
		"raw_material_entities": raw_material_entities,
		"finished_entities": finished_entities,
		"new_finished_entities": new_finished_entities,
		"before": before,
		"after_cancel": after_cancel,
		"after_redo": after_redo,
	}
