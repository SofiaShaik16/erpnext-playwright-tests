# NTPT Technical Wiki (source files)

Markdown under **`tech-doc/`** is the **source of truth** for Wiki pages. Wiki content in the database is created/updated by the installer script.

## Layout

```
docs/wiki/
├── README.md
└── tech-doc/
    ├── 00-ntpt-technical-home.md
    ├── 01-ntpt-tech-sales.md
    ├── 02-ntpt-tech-purchase.md
    └── 03-ntpt-tech-logistics.md
```

## Deploy to any site

Wiki pages are synced automatically on **`bench migrate`** (UAT/prod deploy pipeline).

Optional manual run:

```bash
cd /path/to/frappe-bench
bench --site YOUR_SITE execute ntpt_erpnext_app.install_ntpt_wiki_docs.install
```

This creates or updates:

| Route | Page |
|-------|------|
| `/wiki/ntpt-tech-home` | Technical documentation home |
| `/wiki/ntpt-tech-sales` | Sales guide |
| `/wiki/ntpt-tech-purchase` | Purchase guide |
| `/wiki/ntpt-tech-logistics` | Logistics guide |
| `/wiki/ntpt-tech-manufacturing` | Manufacturing guide (when `ntpt_manufacturing` is installed) |

Sidebar group: **NTPT Technical** (Wiki Space `wiki`).

## Edit workflow

1. Edit the `.md` files in `docs/wiki/tech-doc/`.
2. Commit and deploy — `bench migrate` on the site updates Wiki pages automatically.
3. Or run the manual install command above if needed on a single site.

## Requirements

- App `wiki` must be installed on the bench.
- User running the command needs permission to create/update Wiki Page.
