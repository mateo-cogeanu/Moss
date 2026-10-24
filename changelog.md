# Changelog

Changes are recorded from 2026-09-23 onward.

## 2026-10-24

### Added
- Authenticated **Update now** button with confirmation, immediate GitHub checks and checking/stopping/installing/error feedback. Manual updates also work when scheduled updates are disabled and can explicitly retry a failed revision. No available update means games keep running.
- Manual update preparation pauses new changes, waits for active writes and asks every Minecraft server to save/stop. A slow or stuck operation/server cancels the update without force-killing the game. After updating, sign in and start games again.
- NeoForge installation and mod browsing, using official Maven release metadata and SHA-256 installer verification. Maps Minecraft 1.20.1's legacy artifact, 1.20.2+ release lines and year-based versions; beta/alpha builds are labelled and snapshot-specific coordinates are excluded.
- NeoForge runtime staging, direct Java argument-file startup, persisted launch selection, Java requirement display and compatible required-dependency handling. Shared Forge installer safeguards continue to protect existing worlds, mods and prior selections.

### Fixed
- Read-only UI polling no longer prevents update admission. Update checks/pending states are logged, error details are exposed to signed-in administrators, and updater dependency installs explicitly include build tools even under production npm settings.
- Avoid incompatible-version build requests and stale error notices when switching installation platforms.

### Validation
- All 25 automated tests pass. Manual-update coverage includes authentication/origin/confirmation requirements, disabled schedules, duplicate checks, no-update/dirty-checkout behavior, explicit failed-revision retry, stopping games before worker launch, busy-request cancellation and refusing to force-kill unresponsive Minecraft processes. Systemd operations are simulated; no home-server deployment was performed.
- Existing tests cover NeoForge metadata mapping, artifact/build/checksum validation, mod compatibility and dependency filtering, multiple release-family installs, persisted startup, heap arguments, stopped-server restrictions and switching back to Forge.
- Production build, browser smoke checks (Forge followed by NeoForge 1.21.1 installation, mod/dependency installation, and Update now confirmation/cancellation/status), and upstream integrity checks pass. Vendored Modrinth files are unchanged.
- A real NeoForge 21.1.262 / Minecraft 1.21.1 server was installed through the Moss API, reached Minecraft's ready message and stopped cleanly on Java 21 in an isolated temporary directory. Other version families have fixture coverage and launch-file inspection, not full live gameplay testing; no client join/modpack gameplay was tested.

## 2026-10-23

### Added
- Official Forge installation for Minecraft 1.17+: Minecraft/build selection, recommended-build labels, official installer checksum verification, a bounded Java installer process with console output, and isolated runtime folders.
- Both modern argument-list and recent shim-JAR Forge startup through generated argument files with Moss heap settings, keeping worlds/mods/configs at the existing server root. Failed installs preserve the previous selection; panel shutdown cancels active Forge installers. Older runtimes remain available on disk.
- Compatible Forge mod browsing and required-dependency installation through Modrinth. Updated installation help, README and feature-gap inventory.

### Validation
- Forge tests cover metadata/build/checksum validation, compatible dependencies, failed installer cleanup, symlink rejection, runtime persistence, heap/argument launch, shim library publication/conflict checks, stopped-server requirements and switching back to Vanilla. Existing suites use a fake Java process.
- All 17 automated tests, the production build, browser smoke checks (Forge selection/install plus compatible mods), and upstream integrity checks pass.
- Live official Forge 1.20.1 / 47.4.0 installer completed in an isolated temporary directory. Its generated runtime reached Minecraft’s ready message and stopped cleanly using Moss-rewritten arguments on Java 17. Java 25 was incompatible with that older Forge runtime, as expected. No client join/modpack gameplay was tested; vendored Modrinth files remain unchanged.

## 2026-09-26

### Added
- Executable `setup.sh` for Linux user-systemd installation: prerequisite checks, npm dependency installation, production build, service creation/enabling, user lingering, startup and HTTP health verification.
- Repeat setup preserves existing service/drop-in settings and persistent data. Setup rejects root execution, mismatched existing service directories and concurrent automatic updates. Fresh-service settings support quoted paths and environment overrides.
- README setup instructions, configuration boundaries, and build-failure recovery instructions.

### Validation
- All 13 automated tests pass.
- Bash syntax/help checks and command-fixture tests cover fresh service creation, existing configuration preservation, paths with spaces/percent signs, mismatched paths, build failure and active-update refusal. Tests simulate systemd and the HTTP health response; the script has not been run on the home Linux server.

## 2026-09-23

### Added
- Opt-in automatic Moss updates for Linux user systemd deployments: startup/15-minute checks of the official main branch, deferred installation until all Minecraft servers and operations stop, an independent update worker, clean-checkout/fast-forward checks, build/dependency recovery and startup health checks. Failed revisions are remembered to prevent retry loops.
- Signed-in update status, a one-time setup script, deployment/recovery instructions, and a source-backed inventory of missing/partial Modrinth UI features.
- Clickable server icons on the server list and server detail header, with keyboard-accessible image upload controls and upload feedback.
- Authenticated PNG, JPEG, and WebP uploads, limited to 5 MiB and 16 million pixels. Images are decoded, oriented, center-cropped, stripped of metadata, and stored as 256×256 PNGs. SVG, animated and invalid images are rejected.
- Persistent web-panel icons stored under `panel-data/icons/`, usable without stopping Minecraft. Initially customized the web panel only; see the update below.
- `AGENTS.md` requiring changelog entries for future work, relevant validation, and GitHub commits/pushes once the user supplies the target repository. Secrets and server data must remain excluded.
- README documentation for custom icons and the sharp image-processing dependency.

### Changed
- Icon uploads now also write a 64×64 `server-icon.png` in the Minecraft server directory, replacing any previous game icon. Upload feedback explains that Minecraft picks it up on its next start; existing Moss icons can be reapplied by uploading them again. Writes use temporary files and reject symbolic-link destinations.
- Applied Moss branding to the README, browser title, header, sign-in screen, recovery-code downloads, startup logs, package metadata, and catalog request user agent. New authenticator enrollments use the Moss issuer; existing accounts, 2FA secrets, cookies, and data paths remain compatible. Updated browser selectors and test-directory names.
- Switched to a main-only workflow: `main` is the default and working branch; future updates are committed and pushed directly to it unless the user requests otherwise. Replaces the initial `codex/initial-moss` branch without discarding its history.
- Named the project Moss and recorded `https://github.com/mateo-cogeanu/Moss.git` as the publishing destination in `AGENTS.md`. Publishing must use terminal Git/GitHub CLI commands, not a skill.

### Validation
- Updater tests cover dirty/wrong-branch/wrong-origin/diverged checkouts, busy deferral, worker launch failure, successful installation, npm/build/health-check failures, rollback, preserved data, failed-revision suppression and maintenance admission. Systemd operations are simulated in tests; the home Linux deployment still needs its one-time setup.
- Icon synchronization checks cover 64×64 Minecraft PNG creation, replacement, persistence, invalid uploads leaving the game icon intact, and symbolic-link/directory rejection without changing the panel icon. Browser checks verify that UI uploads create the game icon.
- Twelve backend tests pass, including image validation, authentication, upload limits, and persistence across backend restart.
- Production build passes.
- Browser checks pass, including icon upload and replacement from both locations, persistence after page reload, and existing account/server workflows.
- Upstream integrity check passes for all 1,529 vendored files.

### Publishing
- GitHub destination: `https://github.com/mateo-cogeanu/Moss.git`. Linux deployment is not updated automatically.
