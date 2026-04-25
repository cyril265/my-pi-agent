# pi-audit

Audits Pi packages before installing, migrating, or updating them as local managed snapshots.

- `pi-audit install <source> [-l|--local]` — audit source, confirm, install snapshot globally or into project with `--local`.
- `pi-audit update [package]` — update matching managed package; with no package, updates all.
- `pi-audit update-all` — update every unpinned managed package with newer source available.
- `pi-audit migrate` — convert existing npm/git Pi packages into audited local snapshots.
