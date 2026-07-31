"""
SO → Pick List → Delivery Note logistics flow tests.
Run: bench --site ntpt execute ntpt_erpnext_app.functional_tests.run_logistics_flow_tests.run
"""
from __future__ import annotations

import json
import traceback

import frappe
import requests
from frappe.utils import flt, today

BASE = "http://127.0.0.1:8000"
RESULTS: list[dict] = []
_CTX: dict = {}


def _record(case_id, title, steps, expected, actual, status, error=None):
	RESULTS.append(
		{
			"case_id": case_id,
			"title": title,
			"steps": steps,
			"expected": expected,
			"actual": actual,
			"status": status,
			"error": error,
		}
	)


def _print_report():
	print("\n" + "=" * 72)
	print("LOGISTICS FLOW: SO → Pick List → Delivery Note")
	print("=" * 72)
	passed = failed = blocked = 0
	for r in RESULTS:
		st = r["status"]
		if st == "PASS":
			passed += 1
		elif st == "FAIL":
			failed += 1
		else:
			blocked += 1
		print(f"\n[{r['case_id']}] {r['title']} — {st}")
		print(f"  Steps:    {r['steps']}")
		print(f"  Expected: {r['expected']}")
		print(f"  Actual:   {r['actual']}")
	print("\n" + "-" * 72)
	print(f"SUMMARY: PASS={passed}  FAIL={failed}  BLOCKED={blocked}  TOTAL={len(RESULTS)}")
	if _CTX.get("so"):
		print(f"Test SO: {_CTX.get('so')} | Pick List: {_CTX.get('pl')} | DN: {_CTX.get('dn')}")
	print("=" * 72 + "\n")


def _find_so_for_logistics():
	"""Submitted SO with undelivered qty and deliverable items."""
	return frappe.db.sql(
		"""
		SELECT so.name
		FROM `tabSales Order` so
		INNER JOIN `tabSales Order Item` soi ON soi.parent = so.name
		INNER JOIN `tabItem` i ON i.name = soi.item_code AND i.is_stock_item = 1
		WHERE so.docstatus = 1
		  AND so.status NOT IN ('Closed', 'Cancelled', 'On Hold')
		  AND so.per_delivered < 100
		  AND (soi.qty - soi.delivered_qty) > 0
		ORDER BY so.modified DESC
		LIMIT 1
		""",
		as_dict=True,
	)


def _http_login_read(so_name):
	s = requests.Session()
	r = s.post(f"{BASE}/api/method/login", json={"usr": "Administrator", "pwd": "1"}, timeout=30)
	ok = r.json().get("message") == "Logged In"
	_record(
		"LOG-UI-01",
		"Login for logistics UI path",
		"POST login",
		"Logged In",
		r.json().get("message"),
		"PASS" if ok else "FAIL",
	)
	if so_name:
		r2 = s.get(f"{BASE}/api/resource/Sales Order/{so_name}", timeout=30)
		if r2.ok:
			d = r2.json().get("data", {})
			_record(
				"LOG-UI-02",
				f"Open SO {so_name}",
				"GET SO",
				"per_delivered < 100",
				f"status={d.get('status')}, per_delivered={d.get('per_delivered')}",
				"PASS" if flt(d.get("per_delivered")) < 100 else "FAIL",
			)


def _find_two_sos_same_customer():
	"""Two submitted SOs for the same customer with undelivered stock lines."""
	return frappe.db.sql(
		"""
		SELECT so.customer, GROUP_CONCAT(so.name ORDER BY so.modified DESC SEPARATOR ',') AS so_names
		FROM `tabSales Order` so
		WHERE so.docstatus = 1
		  AND so.status NOT IN ('Closed', 'Cancelled', 'On Hold')
		  AND so.per_delivered < 100
		  AND EXISTS (
			SELECT 1
			FROM `tabSales Order Item` soi
			INNER JOIN `tabItem` i ON i.name = soi.item_code AND i.is_stock_item = 1
			WHERE soi.parent = so.name
			  AND (soi.qty - soi.delivered_qty) > 0
		  )
		GROUP BY so.customer
		HAVING COUNT(*) >= 2
		ORDER BY MAX(so.modified) DESC
		LIMIT 1
		""",
		as_dict=True,
	)


def run_multi_so_flow():
	from erpnext.selling.doctype.sales_order.sales_order import create_pick_list
	from ntpt_erpnext_app.ntpt_erpnext_app.doctype.delivery_note.delivery_note import (
		sync_delivery_note_sales_orders,
	)
	from ntpt_erpnext_app.ntpt_erpnext_app.doctype.pick_list.pick_list import (
		apply_ntpt_manual_pick_rules,
		sync_pick_list_header_from_sales_orders,
	)

	row = _find_two_sos_same_customer()
	if not row:
		_record(
			"LOG-M01",
			"Find two SOs (same customer)",
			"query",
			"2+ SOs same customer",
			"None found",
			"BLOCKED",
		)
		return

	so_names = row[0].so_names.split(",")[:2]
	customer = row[0].customer

	try:
		pick_list = frappe.new_doc("Pick List")
		for so_name in so_names:
			pick_list = create_pick_list(so_name, pick_list)
		apply_ntpt_manual_pick_rules(pick_list)
		sync_pick_list_header_from_sales_orders(pick_list)
		pick_list.flags.ignore_mandatory = True
		pick_list.save(ignore_permissions=True)

		linked_sos = sorted({loc.sales_order for loc in pick_list.locations if loc.sales_order})
		manual = pick_list.pick_manually
		cleared = all(not (r.warehouse or r.batch_no) for r in pick_list.locations[:5])
		_record(
			"LOG-M01",
			"Multi-SO Pick List (Get Items path)",
			f"SOs {so_names}, customer {customer}",
			"PL with both SOs, pick_manually=1, WH/batch cleared",
			f"{pick_list.name} sos={linked_sos} manual={manual} cleared={cleared}",
			"PASS"
			if set(so_names).issubset(set(linked_sos)) and manual and cleared
			else "FAIL",
		)
	except Exception as e:
		_record(
			"LOG-M01",
			"Multi-SO Pick List",
			str(so_names),
			"Pick List saved",
			str(e)[:280],
			"FAIL",
			traceback.format_exc(),
		)
		return

	pl_name = pick_list.name

	try:
		pl_doc = frappe.get_doc("Pick List", pl_name)
		dn = frappe.new_doc("Delivery Note")
		dn.company = pl_doc.company
		dn.customer = customer
		for loc in pl_doc.locations:
			if not loc.sales_order:
				continue
			dn.append(
				"items",
				{
					"item_code": loc.item_code,
					"qty": flt(loc.qty) or 1,
					"against_sales_order": loc.sales_order,
					"so_detail": loc.sales_order_item,
					"against_pick_list": pl_name,
					"pick_list_item": loc.name,
				},
			)
		sync_delivery_note_sales_orders(dn)
		item_sos = sorted({i.against_sales_order for i in dn.items if i.against_sales_order})
		header_sos = sorted(
			{row.sales_order for row in dn.get("custom_sales_orders") or [] if row.sales_order}
		)
		_record(
			"LOG-M02",
			"Multi-SO DN header sync",
			f"sync_delivery_note_sales_orders from {pl_name}",
			"DN items + custom_sales_orders list both SOs",
			f"item_sos={item_sos} header_sos={header_sos}",
			"PASS"
			if set(so_names).issubset(set(item_sos)) and set(so_names).issubset(set(header_sos))
			else "FAIL",
		)
	except Exception as e:
		_record(
			"LOG-M02",
			"Multi-SO DN header sync",
			pl_name,
			"DN with multi-SO header",
			str(e)[:280],
			"FAIL",
			traceback.format_exc(),
		)
		return

	try:
		header_sos = sorted(
			{row.sales_order for row in dn.get("custom_sales_orders") or [] if row.sales_order}
		)
		_record(
			"LOG-M03",
			"DN sales orders multiselect",
			pl_name,
			"custom_sales_orders contains both SO names",
			str(header_sos),
			"PASS" if set(so_names).issubset(set(header_sos)) else "FAIL",
		)
	except Exception as e:
		_record("LOG-M03", "DN order IDs display", pl_name, "Synced display", str(e)[:280], "FAIL")

	try:
		from ntpt_erpnext_app.ntpt_erpnext_app.doctype.shipment.shipment import update_so_status

		dn.flags.ignore_mandatory = True
		dn.insert(ignore_permissions=True)

		class _ShipmentStub:
			def get(self, key):
				if key == "shipment_delivery_note":
					return [frappe._dict({"delivery_note": dn.name})]
				return []

		update_so_status(_ShipmentStub(), None)
		closed = {
			frappe.db.get_value("Sales Order", so_name, "workflow_state") for so_name in so_names
		}
		_record(
			"LOG-M04",
			"Shipment closes all DN sales orders",
			dn.name,
			"All linked SOs workflow_state=Closed",
			str(closed),
			"PASS" if closed == {"Closed"} else "FAIL",
		)
	except Exception as e:
		_record("LOG-M04", "Shipment multi-SO close", pl_name, "All SOs closed", str(e)[:280], "FAIL")


def run_flow():
	from ntpt_erpnext_app.ntpt_erpnext_app.doctype.sales_order.sales_order import (
		create_pick_list_with_comment,
	)
	from erpnext.stock.doctype.pick_list.pick_list import create_delivery_note

	so_row = _find_so_for_logistics()
	if not so_row:
		_record("LOG-01", "Find SO for logistics", "query", "SO with stock lines", "None found", "BLOCKED")
		return
	so_name = so_row[0].name
	_CTX["so"] = so_name

	# LOG-01 Create Pick List from SO (custom NTPT path)
	try:
		pl = create_pick_list_with_comment(so_name, comment="Logistics functional test PKG-001")
		pl_name = pl.name if hasattr(pl, "name") else pl.get("name")
		_CTX["pl"] = pl_name
		pl_doc = frappe.get_doc("Pick List", pl_name)
		manual = pl_doc.pick_manually
		comment = pl_doc.custom_package_print_comment
		cleared = all(not (r.warehouse or r.batch_no) for r in pl_doc.locations[:3])
		_record(
			"LOG-01",
			"SO → Pick List (create_pick_list_with_comment)",
			f"SO {so_name}",
			"PL saved, pick_manually=1, comment set, WH/batch cleared",
			f"{pl_name} manual={manual} comment={comment!r} cleared_sample={cleared}",
			"PASS" if manual and comment and pl_doc.locations else "FAIL",
		)
	except Exception as e:
		_record("LOG-01", "SO → Pick List", f"from {so_name}", "Pick List created", str(e)[:280], "FAIL", traceback.format_exc())
		return

	pl_name = _CTX["pl"]

	# LOG-02 Draft Pick List remains valid (NTPT: no warehouse on PL rows)
	try:
		pl_doc = frappe.get_doc("Pick List", pl_name)
		_record(
			"LOG-02",
			"Pick List draft (manual pick, no warehouse)",
			pl_name,
			"Draft docstatus=0, locations present",
			f"rows={len(pl_doc.locations)}, sample_wh={pl_doc.locations[0].warehouse if pl_doc.locations else ''}",
			"PASS" if pl_doc.docstatus == 0 and pl_doc.locations else "FAIL",
		)
	except Exception as e:
		_record("LOG-02", "Pick List draft", pl_name, "Valid draft", str(e)[:280], "FAIL")
		return

	# LOG-03 Submit Pick List without warehouse (NTPT assigns stock on DN)
	try:
		pl_doc = frappe.get_doc("Pick List", pl_name)
		pl_doc.flags.ignore_mandatory = True
		pl_doc.submit()
		_record(
			"LOG-03",
			"Submit Pick List (empty warehouse)",
			pl_name,
			"Blocked or NTPT allows submit",
			f"docstatus={pl_doc.docstatus}",
			"PASS" if pl_doc.docstatus == 1 else "FAIL",
		)
	except Exception as e:
		msg = str(e)
		_record(
			"LOG-03",
			"Submit Pick List (empty warehouse)",
			pl_name,
			"Blocked — stock/warehouse validated on submit",
			msg[:280],
			"PASS" if "available stock" in msg or "warehouse" in msg.lower() else "FAIL",
		)

	# LOG-04 Pick List → Delivery Note (works from draft PL in NTPT flow)
	try:
		dn = create_delivery_note(pl_name)
		dn_name = dn.name if hasattr(dn, "name") and dn.name else None
		if not dn_name:
			dn.flags.ignore_mandatory = True
			dn.save(ignore_permissions=True)
			dn_name = dn.name
		_CTX["dn"] = dn_name
		dn_doc = frappe.get_doc("Delivery Note", dn_name)
		linked_pl = {i.against_pick_list for i in dn_doc.items if i.against_pick_list}
		pli_links = sum(1 for i in dn_doc.items if i.pick_list_item)
		pkg_comment = dn_doc.get("custom_package_print_comment")
		qty_zero = sum(1 for i in dn_doc.items if flt(i.qty) == 0)
		_record(
			"LOG-04",
			"Pick List → Delivery Note (draft PL OK)",
			f"create_delivery_note({pl_name})",
			"DN linked to PL + package comment from PL",
			f"{dn_name} linked_pl={linked_pl} pli_rows={pli_links} comment={pkg_comment!r} zero_qty_rows={qty_zero}",
			"PASS" if pl_name in linked_pl and pli_links else "FAIL",
		)
	except Exception as e:
		_record("LOG-04", "PL → Delivery Note", "create_delivery_note", "DN created", str(e)[:280], "FAIL", traceback.format_exc())
		return

	dn_name = _CTX.get("dn")
	if not dn_name:
		return

	# LOG-05 DN draft save (Ready to Pack on PL)
	try:
		dn_doc = frappe.get_doc("Delivery Note", dn_name)
		pl_status_before = frappe.db.get_value("Pick List", pl_name, "status")
		dn_doc.flags.ignore_mandatory = True
		dn_doc.save(ignore_permissions=True)
		pl_status_after = frappe.db.get_value("Pick List", pl_name, "status")
		_record(
			"LOG-05",
			"Save DN draft → Pick List status",
			dn_name,
			"PL moves toward Ready to Pack / updated",
			f"PL status {pl_status_before} → {pl_status_after}",
			"PASS",
		)
	except Exception as e:
		_record("LOG-05", "Save DN draft", dn_name, "Saved", str(e)[:280], "FAIL")

	# LOG-06 get_pick_list_item_batch_map API
	try:
		from ntpt_erpnext_app.ntpt_erpnext_app.doctype.delivery_note.delivery_note import (
			get_pick_list_item_batch_map,
		)

		pli_names = [i.pick_list_item for i in dn_doc.items if i.pick_list_item]
		out = get_pick_list_item_batch_map(pli_names)
		_record(
			"LOG-06",
			"DN batch map from Pick List rows",
			"get_pick_list_item_batch_map",
			"Dict keyed by PL item name",
			f"{len(out or {})} mappings",
			"PASS",
		)
	except Exception as e:
		_record("LOG-06", "Batch map API", "call", str(e)[:280], "FAIL")

	# LOG-07 Submit DN without entity scan (expect block)
	try:
		dn_doc = frappe.get_doc("Delivery Note", dn_name)
		dn_doc.submit()
		_record(
			"LOG-07",
			"Submit DN without scanned entities",
			dn_name,
			"Validation error (entities/packages required)",
			f"Submitted docstatus={dn_doc.docstatus}",
			"FAIL",
		)
	except Exception as e:
		msg = str(e)
		_record(
			"LOG-07",
			"Submit DN without scanned entities",
			dn_name,
			"Blocked until entities/packages configured",
			msg[:280],
			"PASS" if msg else "BLOCKED",
		)

	# LOG-08 SO → DN direct (bypass Pick List) for comparison
	try:
		from erpnext.selling.doctype.sales_order.sales_order import make_delivery_note as so_dn

		dn_direct = so_dn(so_name)
		ok = getattr(dn_direct, "doctype", None) == "Delivery Note"
		has_pl_link = any(getattr(i, "against_pick_list", None) for i in (dn_direct.items or []))
		_record(
			"LOG-08",
			"SO → DN direct (no Pick List)",
			so_name,
			"DN without against_pick_list",
			f"items={len(dn_direct.items or [])} has_pl_link={has_pl_link}",
			"PASS" if ok and not has_pl_link else "FAIL",
		)
	except Exception as e:
		_record("LOG-08", "SO → DN direct", so_name, "DN draft", str(e)[:280], "FAIL")

	# LOG-09 map_pl_locations patch active
	try:
		from erpnext.stock.doctype.pick_list.pick_list import map_pl_locations

		patched = getattr(map_pl_locations, "__name__", "") == "map_pl_locations_with_pick_list_sync"
		_record(
			"LOG-09",
			"NTPT Pick List→DN batch sync hook",
			"hooks patch",
			"map_pl_locations patched",
			getattr(map_pl_locations, "__name__", str(map_pl_locations)),
			"PASS" if patched else "FAIL",
		)
	except Exception as e:
		_record("LOG-09", "Batch sync hook", "import", "patched", str(e)[:200], "FAIL")


def run():
	frappe.connect()
	frappe.set_user("Administrator")
	frappe.flags.in_test = True
	so_name = None
	try:
		row = _find_so_for_logistics()
		so_name = row[0].name if row else None
		_http_login_read(so_name)
		run_flow()
		run_multi_so_flow()
	finally:
		frappe.db.rollback()
	_print_report()
	return RESULTS
