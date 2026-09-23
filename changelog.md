# Changelog

Changes are recorded from 2026-09-23 onward.

## 2026-09-23

### Added
- Clickable server icons on the server list and server detail header, with keyboard-accessible image upload controls and upload feedback.
- Authenticated PNG, JPEG, and WebP uploads, limited to 5 MiB and 16 million pixels. Images are decoded, oriented, center-cropped, stripped of metadata, and stored as 256×256 PNGs. SVG, animated and invalid images are rejected.
- Persistent web-panel icons stored under `panel-data/icons/`, usable without stopping Minecraft. Minecraft's in-game server-list icon is unchanged.
- `AGENTS.md` requiring changelog entries for future work, relevant validation, and GitHub commits/pushes once the user supplies the target repository. Secrets and server data must remain excluded.
- README documentation for custom icons and the sharp image-processing dependency.

### Changed
- Named the project Moss and recorded `https://github.com/mateo-cogeanu/Moss.git` as the publishing destination in `AGENTS.md`. Publishing must use terminal Git/GitHub CLI commands, not a skill.

### Validation
- Eight backend tests pass, including image validation, authentication, upload limits, and persistence across backend restart.
- Production build passes.
- Browser checks pass, including icon upload and replacement from both locations, persistence after page reload, and existing account/server workflows.
- Upstream integrity check passes for all 1,529 vendored files.

### Publishing
- GitHub destination: `https://github.com/mateo-cogeanu/Moss.git`. Linux deployment is not updated automatically.
