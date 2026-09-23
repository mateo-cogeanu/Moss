# Moss project instructions

- Maintain the original Modrinth-derived UI and existing local backend conventions. Preserve upstream licenses and attribution.
- Update `changelog.md` for every project change from 2026-09-23 onward. Add dated entries describing features, fixes, configuration/documentation changes, and relevant validation. Do not invent historical entries.
- After completing and validating changes, commit and push them to `https://github.com/mateo-cogeanu/Moss.git`. Use terminal commands (`git` for commits and pushes and the GitHub CLI `gh` when needed); do not use a GitHub skill or browser-based publishing workflow. Do not publish to another repository. Follow user-specified branch preferences; use `codex/` for new work branches by default.
- Before pushing, review staged changes. Never commit credentials, admin keys, account data, world files, backups, `.env`, `panel-data/`, `data/`, build output, or test artifacts. Preserve unrelated user changes.
- Run checks appropriate to the change and report their actual results. State clearly whether changes are local, pushed to GitHub, or deployed; a push does not update the home server automatically.
