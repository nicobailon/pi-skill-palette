# Changelog

All notable changes to pi-skill-palette will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] - 2026-07-30

### Removed
- **Breaking:** the palette no longer scans `~/.codex/skills`, `~/.claude/skills`, or `<cwd>/.claude/skills`. Skill discovery is now entirely pi's, and pi does not read those directories, so skills kept only there will stop appearing in `/skill`. To restore them, either symlink them into a directory pi does read (`~/.pi/agent/skills`, `<cwd>/.pi/skills`, `~/.agents/skills`, or `<cwd>/.agents/skills` — symlinks are followed), or add their paths to pi's configured skill paths.

### Changed
- **Breaking:** requires pi 0.83.0 or newer. The extension now reads `getSystemPromptOptions().skills` and each skill's `baseDir`, and honors the renderer's `outputPad`; peer dependency ranges were tightened from `*` accordingly.
- Performance: cache the sorted skill index between palette openings, pre-normalize search text and narrow fuzzy matches incrementally while typing, and render skill previews as a single cached text block. Repeated palette opens and re-renders of large skill content are now near-instant, with byte-identical rendered output.
- Use pi's loaded skill list instead of duplicating skill directory discovery, preserving current pi trust, package, settings, and deduplication behavior.
- Updated extension imports for the `@earendil-works` pi packages.

### Fixed
- Relative references inside a skill (for example `./assets`) now resolve against the skill's own directory instead of the current working directory. Queued skills are injected with `location` and a "References are relative to" line, matching pi's own skill expansion ([#3](https://github.com/nicobailon/pi-skill-palette/issues/3), reported by @hetzge).
- Guard `/skill` so the overlay only opens in interactive TUI mode.
- Respect pi's configured custom-message output padding in the skill preview renderer.

## [1.2.0] - 2026-01-29

### Fixed
- **Overlay rendering** — Use pi-tui's `truncateToWidth` and `visibleWidth` instead of custom regex-based width calculation, fixing right border not rendering
- **Overlay positioning** — Use `overlayOptions` with `anchor: "center"` for proper centering
- **Cursor placement** — Cursor now appears before placeholder text when search is empty, not after

### Changed
- Replaced all custom width/pad/truncate helpers with pi-tui builtins (`truncateToWidth`, `visibleWidth`)
- ConfirmDialog `center` function now truncates before centering to prevent overflow with long skill names
- Polished README with banner image and restructured to follow pi extension conventions

### Removed
- Dead code: unused `readonly width` properties, `pad` and `truncate` helper functions

## [1.1.0] - 2026-01-27

### Changed
- Added `pi` manifest to package.json for pi v0.50.0 package system compliance
- Added `pi-package` keyword for npm discoverability
- Skill injection now sets `display: true` to show content in chat

### Added
- **Theming system** — Load custom colors from `theme.json` with fallback to defaults
- **Rainbow progress dots** — Spaced out dots with rainbow gradient (matching powerline-footer)
- **Skill content preview** — Message renderer shows actual skill content in collapsible block
- **Expandable content** — Click to expand full skill content in chat

### Fixed
- **Import package** — Changed from `@anthropic-ai/claude-code` to `@mariozechner/pi-coding-agent`
- **Countdown timer** — Unqueue dialog timer now actually updates visually
- **Array content handling** — Message renderer handles both string and TextContent[] formats
- **Missing skill directories** — Now scans all directories that pi scans:
  - `~/.codex/skills` (recursive)
  - `~/.claude/skills` (claude format - one level)
  - `${cwd}/.claude/skills` (claude format - one level)
  - `~/.pi/agent/skills` (recursive)
  - `~/.pi/skills` (recursive)
  - `${cwd}/.pi/skills` (recursive)
- **Claude format support** — Claude skill directories (one level deep) now handled differently from recursive directories

### Removed
- Unused `progress` theme property (progress dots use rainbow colors directly)

## [1.0.0] - 2025-01-09

### Added

- Initial release of Skill Palette extension
- `/skill` command to open the skill palette overlay
- Fuzzy search filtering by skill name and description
- Keyboard navigation with arrow keys and wrap-around
- Visual queue indicators:
  - Footer status showing queued skill name
  - Widget above editor with "will be applied to next message" hint
  - Green dot indicator next to queued skill in palette
- Toggle behavior: selecting a queued skill triggers unqueue flow
- Confirmation dialog for unqueuing with:
  - 30-second auto-cancel timeout
  - Color-coded Remove (red) / Keep (green) buttons
  - Quick `Y`/`N` keyboard shortcuts
  - Progress dots countdown timer
- Skill content injection via `before_agent_start` event
- Support for multiple skill directories:
  - `~/.pi/agent/skills/`
  - `~/.pi/skills/`
  - `.pi/skills/` (project-specific)
- Symlink support for skill directories
- Skill deduplication by name (first occurrence wins)
- Elegant TUI design with:
  - Title integrated into border
  - Section dividers
  - Search icon with placeholder text
  - Dot-style selection indicators
  - Progress dots for scroll position
  - Italic keyboard hints
