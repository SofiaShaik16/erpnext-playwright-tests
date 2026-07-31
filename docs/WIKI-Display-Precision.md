# NTPT display precision — wiki

This page describes **how numeric fields are shown on the desk (forms and child tables)** when NTPT precision is enabled, and how that differs from **how values are stored and rounded in the database**. It is written for both **functional** (configuration, expectations) and **technical** (implementation, extension) readers.

---

## Functional brief

### Purpose

Organizations often want **consistent decimal places on screen** (for example, six decimals on rates in EUR and PLN) without changing ERPNext’s underlying field precision for storage, imports, or integrations. NTPT **display precision** applies to **Currency**, **Float**, and **Percent** fields on forms, including:

- Parent (main) document fields  
- **Child table** rows (collapsed grid cells and expanded row form)  
- **Read-only** display (plain text) and **editable** inputs (grey boxes), so both match when NTPT rules apply  

### What it does *not* do

- It does **not** replace Frappe’s chain for **stored** rounding and field meta: **Property Setter → Customize Form / DocField precision → System Settings** still govern persistence and server-side behaviour where applicable.  
- It does **not** automatically change **Query Report / Tabulator** formatting; those use **Tabulator Settings** (and related app logic), not this form patch.  
- It does **not** add new DocTypes for end users beyond what already exists under **NTPT Settings**.

### Where to configure

1. Open **NTPT Settings** (Single).  
2. Go to the **Precision Settings** tab.  
3. In **Doctype Precision Settings** (child table **Doctype Display Precision Settings**), add one row per DocType you want to override on the UI:  
   - **Doctype** — target DocType (e.g. Purchase Receipt, Sales Invoice Item).  
   - **Float precision** — decimals for Float / Percent-style display (select 2–9).  
   - **Currency precision** — decimals for Currency display (select 2–9).  

If a **child** DocType (e.g. `Purchase Receipt Item`) has **no** row, the patch **falls back** to the **parent** transaction DocType row (e.g. `Purchase Receipt`) when resolving settings for that form.

### Behaviour users see

- **Blurred / collapsed / read-only**: numbers are formatted with NTPT **currency** or **float** precision from settings (and the child/parent fallback above).  
- **Focused input**: the control uses Frappe’s normal **get_precision** chain so typing and parsing stay aligned with ERPNext defaults for that field.  
- After changing **NTPT Settings**, saving updates server cache; the browser also debounces refetches. A full desk reload may be needed if an old tab held stale client cache (short TTL applies on the client for settings fetch).

### Rounding label (desk boot)

**System Settings** (rounding method / commercial vs bank-style) is exposed for other features via `precision_utils` boot data; the **form display** patch primarily controls **decimal count** on screen, not re-implementing full server rounding for every save path.

---

## Technical brief

### Design principle: split UI marker from DB precision

- **`df.__ntpt_ui_precision`** (integer) is set only for **display** paths. It must **not** be written into `df.precision` for NTPT, so DocField / Property Setter precision remains authoritative for storage and `get_precision()` on the control when focused.  
- **`applyNtptUiMarker`** sets `__ntpt_ui_precision` on meta fields, `fields_dict` dfs, grid `docfields`, and **per-row** `frappe.meta.get_docfield(child_doctype, fieldname, row.name)` for child rows.

### Main client module

| File | Role |
|------|------|
| `ntpt_erpnext_app/public/js/currency_precision_patch.js` | Desk-only IIFE: patches controls and formatters, loads settings, applies markers, repaints grids. |
| `ntpt_erpnext_app/hooks.py` | `app_include_js` includes `currency_precision_patch.js` (and `precision_utils.js` for shared numeric helpers / boot consumers). |
| `ntpt_erpnext_app/api.py` → `get_ntpt_settings()` | Returns `doctype_precision_settings` (and other keys); **cached** under `ntpt_settings`. |
| `ntpt_erpnext_app/ntpt_erpnext_app/doctype/ntpt_settings/ntpt_settings.py` | `on_update` refreshes `ntpt_settings` cache including precision rows. |

### Patched surfaces (JavaScript)

1. **`ControlFloat.prototype.format_for_input`** (shared with Currency which extends Float)  
   - Blurred: use `__ntpt_ui_precision` if set.  
   - Focused or no marker: original `get_precision()` (float vs currency originals preserved).  

2. **`frappe.form.formatters.Currency`, `Float`, `Percent`**  
   - Read-only / `set_disp_area` uses `frappe.format` → these formatters. When `docfield.__ntpt_ui_precision` is set, format with that precision; otherwise **delegate to the original Frappe formatter** (no copy-paste of UAE fraction logic etc.).  

3. **Grid static columns**  
   - Collapsed cells use static HTML, not `format_for_input`. **`repaintNtptDisplays`** walks grids and sets `.static-area` via `formatStaticNtptDisplay` (uses `format_number` + field currency / number format).  
   - **Does not** call `field.refresh()` on **Table** / **Tab** wrappers (avoids full grid rebuild and flicker loops).  
   - **Does not** call `frm.refresh_field` / `frm.refresh_fields` after applying markers (those retrigger `frappe.format` with system precision and fight NTPT paint).

### Event flow and debouncing

| Event | Action |
|--------|--------|
| `form-refresh` | Debounced **`applyPrecision`** (~320 ms): fetch settings, clear markers, re-apply markers, `repaintNtptDisplays`. |
| `frappe.router` `change` | Same debounced apply after short delay (navigation). |
| `grid-row-render` | Debounced **`repaintNtptDisplays` only** (~120 ms) — **not** full `applyPrecision` (prevents grid-row ↔ refresh loops). |

`APPLY_IN_FLIGHT` guards overlapping async `applyPrecision` runs.

### Server-side helpers

| File | Role |
|------|------|
| `ntpt_erpnext_app/precision_utils.py` | `get_precision_boot_data()`, `boot_session` → `bootinfo.ntpt_precision` (defaults, doctype map, report map for Tabulator-related consumers). |
| `get_precision_config(doctype=None, report=None)` (whitelisted) | Resolved precision + flags for callers (forms vs reports); docstring states display vs document storage split. |

Child table **Doctype Display Precision Settings** is defined in JSON under `ntpt_erpnext_app/doctype/doctype_display_precision_settings/`.

### Raw input cache (grid editing)

`input` / `focusin` listeners cache raw string values per `(form, doc, row, field)` so focusing a cell can restore the user’s in-progress text without forced reformat mid-edit.

### Caching notes for developers

- Server: `get_ntpt_settings` uses `frappe.cache().get_value("ntpt_settings")`; **NTPT Settings** `on_update` rewrites this payload.  
- Client: short TTL cache in `currency_precision_patch.js` for the settings `frappe.call` response.  
- If you bypass `on_update` when mutating precision rows, clear `ntpt_settings` cache manually.

### Extension guidelines

- Prefer **reading** `__ntpt_ui_precision` in new display formatters; avoid persisting it on the DocField record.  
- New UI surfaces that show numbers **outside** `ControlFloat` / `frappe.format` must either call the same formatting helpers or set content through paths that already respect `__ntpt_ui_precision`.  
- For **reports**, wire precision through **Tabulator Settings** / `get_precision_config(..., report=...)` rather than duplicating NTPT form logic.

### Related files (historical / auxiliary)

- `ntpt_erpnext_app/patches/set_currency_field_precision.py` — migration-style patch; not the runtime desk display mechanism.  
- `public/js/utils/precision_utils.js` — client rounding helpers and boot-oriented formatting utilities.

---

## Document history

| Version | Summary |
|---------|---------|
| 1.0 | Initial wiki: functional + technical brief for NTPT display precision. |

Maintainers: update this file when changing `currency_precision_patch.js`, `get_ntpt_settings`, or NTPT Settings precision child tables.
