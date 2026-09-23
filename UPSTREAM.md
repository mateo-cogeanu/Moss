# Original Modrinth UI integration

Repository: https://github.com/modrinth/code

Commit: `eacc38fb51ad7ef5c66714afebd66e24b4ec9301`

## Runtime integration

| Browser adapter | Original component |
| --- | --- |
| `web/Overview.vue` | `packages/ui/src/layouts/shared/console/layout.vue` and `components/servers/ServerManageStats.vue` |
| `web/Files.vue` | `packages/ui/src/layouts/shared/files-tab/layout.vue`, including its editor, table, toolbar, and dialogs |
| `web/Content.vue` | `packages/ui/src/layouts/shared/content-tab/layout.vue` and its tables, filters, actions, and dialogs |
| `web/Installation.vue` | `packages/ui/src/layouts/shared/installation-settings/layout.vue` and its software/version form |
| `web/Backups.vue` | `packages/ui/src/components/servers/backups/BackupItem.vue` |
| Browser shell and forms | Original Button, Input, TooltipDirective, icon components, and Omorphia/Tailwind styles |

The launcher wrappers in `apps/app-frontend/src/pages/hosting/manage` demonstrate how Modrinth shares these layouts between desktop and web. This project uses the same shared layouts with browser providers. The upstream launcher and website wrappers remain available as reference; they are not app entry points here.

`web/App.vue` supplies locale, notification, page, modal, and server identity providers. Individual browser pages supply the original console/file-manager provider contracts backed by `/api` endpoints. The backend manages local Java processes and disk files. No request is sent to Archon or Kyros.

`vite.config.ts` resolves named upstream barrel imports to their original modules at build time. This avoids importing unrelated storefront and desktop modules while preserving the original component source. The SVG loader uses the launcher’s SVGO configuration to preserve `viewBox` and avoid clipping/misalignment when icons scale. The asset barrel omits restricted branding. The application has its own build dependencies and lockfile; the monorepo's workspace package manifests are reference files.

## Small upstream adaptations

- `packages/assets/index.ts`: export usable original icons/illustrations, omit restricted branding imports and global style side effects (styles are loaded explicitly by the browser entry point).
- `packages/assets/omorphia.scss`: omit the CDN font stylesheet; bundle Inter locally.
- `packages/ui/src/components/servers/ServerManageStats.vue`: change the file-card link to this app's browser route.
- `packages/ui/src/components/base/BaseTerminal.vue`: change the welcome message from “Modrinth Server” to “Minecraft server”.
- `packages/ui/src/components/base/buttons/TeleportOverflowMenu.vue`: retain the accessible label on icon-only menu triggers instead of overriding it with undefined.
- Imported package `tsconfig*.json` files: remove unavailable monorepo configuration inheritance.

No console layout, file-manager layout, or backup-card template has been redesigned. The new local login, server selector/header/navigation, creation, and settings flows are adaptations for self-hosting, not exact copies of the launcher shell.

`vendor/modrinth/SOURCE_MANIFEST.json` records source hashes, upstream hashes, and whether each file is modified. `npm run verify:upstream` checks the local snapshot against that manifest. This verifies provenance/integrity, not application behavior.

## Licensing

The root LICENSE is GPL-3.0 for the new adapter. Upstream UI/assets/app-frontend are GPL-3.0; API client is LGPL-3.0; the included website/Labrinth references are AGPL-3.0. Package license and copying files remain authoritative for their respective sources. Restricted branding directories and the explicitly excluded server-branding components are not included. References to excluded assets can remain in unused reference code.

The content and installation adapters use the original provider contracts. Modrinth search/version review and uploaded-JAR selection are local adapter screens. Backend catalogs use [Mojang metadata](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json), [Fabric Meta](https://meta.fabricmc.net/), [PaperMC Fill](https://docs.papermc.io/misc/downloads-service/), and [Modrinth API](https://docs.modrinth.com/api/operations/getprojectversions/).
