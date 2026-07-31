# NTPT technical documentation (source)

Markdown pages in this folder are published to the Frappe Wiki automatically on **`bench migrate`**.

Optional manual sync:

```bash
bench --site YOUR_SITE execute ntpt_erpnext_app.install_ntpt_wiki_docs.install
```

Add new guides here as numbered `NN-topic-name.md` files and register them in `ntpt_erpnext_app/install_ntpt_wiki_docs.py`.
