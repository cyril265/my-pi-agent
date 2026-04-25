# pi-audit

Audits Pi packages before install/update, then installs approved local snapshots.

- `pi-audit install <source> [-l|--local]` — audit source, ask confirmation, install snapshot globally or into project with `--local`.
  - Example: `pi-audit install npm:@scope/pi-package`
  - Example: `pi-audit install git:github.com/user/pi-package --local`
- `pi-audit update [package]` — update matching managed package; with no package, updates all managed packages.
  - Example: `pi-audit update @scope/pi-package`
  - Example: `pi-audit update`
- `pi-audit update-all` — update every unpinned managed package with newer source available.
- `pi-audit migrate` — convert existing npm/git Pi packages into audited local snapshots.
