# Moss

Moss is a self-hosted Minecraft management app for your browser, using **Modrinth's original Vue UI components** and a local Node.js backend. No launcher, Tauri runtime, Modrinth account, or Modrinth Hosting subscription is required.

The console, console filters/search/fullscreen, resource cards, content list, installation settings, file browser/editor, backup cards, buttons, dialogs, icons, colors, and styles come from the pinned Modrinth source in `vendor/modrinth`. The browser shell, local sign-in, server creation, settings form, and backend are specific to this project. This is an independent adaptation, not the complete Modrinth Hosting product or its private backend.

## Run

Requires Node.js 22+, macOS or Linux, and Java appropriate for your Minecraft server. The panel runs Java processes directly on the same host; it does not use Docker or SSH.

```sh
npm ci
npm run build
npm start
```

Open Moss at **http://127.0.0.1:3000** and choose **Create an account**. Enter a username, a password of at least 12 characters, and the admin key from `panel-data/admin-token` (the server prints the file location, not the secret). Scan the QR code with an authenticator app and verify its six-digit code to finish registration. Save the ten one-time recovery codes somewhere private.

Future sign-ins require only your username, password, and authenticator code (or one unused recovery code). The admin key cannot sign in or bypass 2FA; it authorizes creation of another account. **Every registered account has full access to all servers**, so share the key only with trusted administrators. Existing servers are preserved when upgrading from token login; create your first account with the existing key. Passwords are stored as salted scrypt hashes, authenticator secrets are encrypted with `panel-data/auth-key`, and recovery codes are hashed. Back up the complete data directory, including `auth-key` and `users.json`, together. Keep the host clock synchronized for authenticator codes. Click your username in the header to change your password; this signs out your other sessions.

1. Create a server and review/accept the Minecraft EULA. Optionally select an existing **world ZIP** in the creation form. The ZIP must contain one Java Edition world with `level.dat` at its root or inside a folder; it is imported as `world`, and `level-name=world` is written to the server properties. Limits: 512 MiB compressed, 4 GiB expanded, 100,000 entries. Unsafe paths, symlinks, encrypted ZIPs, and archives containing multiple worlds are rejected. Zip the world folder, not a whole server or a Bedrock world. Use matching Minecraft software/mods to preserve compatibility. Dimensions inside the world folder are included; separate Paper/Bukkit dimension folders must be migrated separately. Failed imports do not create partial servers.
2. Open **Installation → Edit** to install Vanilla, Fabric, or a stable Paper build. Alternatively, upload an executable JAR in Files and select it under **Installation → Use an uploaded server JAR**.
3. For Fabric mods or Paper plugins, open **Mods & plugins**. Browse compatible Modrinth projects, choose a version, and review the required dependencies before installing; you can also upload JARs, enable/disable, or delete content.
4. Click **Start**. The console shows startup output and accepts Minecraft commands. `running` means the Java process exists; wait for Minecraft's ready message before connecting.
5. Connect your Minecraft client to the host and game port you selected.
6. Stop the server before changing files, uploading, changing settings, or creating/restoring backups.

Built-in software installers use Mojang's version manifest, Fabric Meta, and PaperMC Fill v3. Existing JARs and worlds are kept; back up worlds before changing Minecraft versions. Fabric's launcher downloads its runtime dependencies on first start. Set `JAVA_BIN` to a compatible Java executable.

The Mods & plugins page uses Modrinth's original installed-content layout. Its browse dialog is a local adapter to the public Modrinth API, filtered by the configured loader and game version. Installation includes required dependencies and verifies available file checksums. Optional dependencies, automatic updates, full modpack installation, Forge/NeoForge launch scripts, collaborator roles, and Modrinth billing are not implemented. For a manually uploaded JAR, specify its actual platform and game version to enable compatible browsing. Do not change an installed mod's version until removing its old file; the backend rejects tracked conflicting versions.

The previous `data/` directory is untouched. This version uses a separate `panel-data/` directory; it does not automatically import older records or servers.

## Features

- Click a server icon in the server list or header to upload a PNG, JPEG, or WebP (up to 5 MiB and 16 million pixels). Images are center-cropped to 256×256 PNG and kept in `panel-data/icons/`. This customizes the web panel only, not Minecraft’s multiplayer-list `server-icon.png`.

- Multiple persistent server records, unique configured ports, and configurable JVM heap limits.
- Start, stop, restart, console input, and a bounded recent-log buffer.
- Original terminal UI: search, severity filters, clear display, and fullscreen.
- Original resource cards: process CPU and RSS memory from `ps`, server directory size, and short in-browser history. CPU is the OS process metric, not a Minecraft tick-rate measurement. Memory charts compare RSS to the configured JVM heap; heap is not a hard process limit.
- Original file browser: navigation, text editing, file/folder creation, rename, move, delete, download, and upload. Symlinks and parent traversal are rejected. Text editing is limited to 1 MiB; individual uploads to 512 MiB.
- Full directory backups while stopped and confirmed restore. Backups remain on this host under `panel-data/backups/`; copy them elsewhere for off-host protection.
- Admin-key-authorized account creation, mandatory authenticator 2FA, one-time recovery codes, and password changes. Expiring HttpOnly, SameSite sessions reset when the panel restarts. Authentication is limited to ten attempts per minute per connection IP (including enrollment and password changes).
- Optional world ZIP import during server creation, staged before server creation and scoped to the uploading account. Unused uploads expire after 30 minutes; files are cleaned on the next import or panel restart.

Console/status updates use polling every 2.5 seconds through the original UI's provider interfaces. This is not an Archon/Kyros protocol clone. Public log sharing and unsupported archive operations are unavailable. Logs and graph history are not persisted by the panel; Minecraft still writes its own log files.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `3000` | Panel HTTP port |
| `DATA_DIR` | `./panel-data` | Persistent accounts, encryption key, admin key, servers, and backups |
| `JAVA_BIN` | `java` | Java executable path |
| `SECURE_COOKIE` | `false` | Set `true` when serving through HTTPS |

For deployment, use an HTTPS reverse proxy and set `SECURE_COOKIE=true` so passwords, authenticator codes, and sessions are protected in transit. Bind the panel to localhost behind the proxy (or a private interface). Preserve the browser's Host header at the proxy because the backend checks request origins. Use a dedicated OS account: server JARs run with the panel process's permissions, not in a sandbox. Stop the panel gracefully to stop its managed servers. A second panel cannot use the same data directory concurrently; a stale lock is recovered after its owner exits.

## Development and validation

Run `npm start` for the API and `npm run dev` in another terminal for the Vite frontend. Vite proxies `/api` to port 3000.

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run verify:upstream
```

Backend tests cover TOTP test vectors, mandatory enrollment, code replay, recovery-code reuse, password changes/session revocation, account persistence, rate limits, safe/unsafe world ZIPs, and import ownership. The lifecycle integration test exercises authentication, origin checks, traversal and symlink rejection, uploads, lifecycle/commands, backup restore, and persistence. Browser checks cover account creation, authenticator enrollment, recovery-code acknowledgement, logout/login without the admin key, world ZIP creation, the original console, file editor/save, backups, settings, and mobile overflow. Tests also cover official installer selection, dependencies, checksum failures, mod toggles, and retained SVG viewBox attributes. Automated download tests use deterministic fixtures; live upstream metadata was checked separately. Both suites use an isolated **fake Java process**, not a Minecraft server; actual Minecraft startup still needs testing with your chosen JAR and Java version. Browser test screenshots are saved in `artifacts/` and are not committed.

## Upstream source and licenses

Pinned source: https://github.com/modrinth/code/tree/eacc38fb51ad7ef5c66714afebd66e24b4ec9301

See [UPSTREAM.md](UPSTREAM.md) for the integration map and modifications. Package licenses and notices are retained beside the sources. The new adapter code is GPL-3.0-only; upstream packages retain their respective licenses. Restricted Modrinth branding assets are omitted. Inter is bundled locally through `@fontsource/inter`, which carries its font license. Local management works without Modrinth services. Browsing/installing content contacts Modrinth; software installation contacts the selected official download service. Catalogs are fetched by the backend, not the browser.
