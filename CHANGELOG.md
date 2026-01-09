# Changelog

All notable changes to pi-skill-palette will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
