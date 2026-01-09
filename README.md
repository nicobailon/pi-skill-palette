# pi-skill-palette

Trigger [pi](https://github.com/badlogic/pi) skills on demand with a VS Code/Amp-style command palette.

Instead of relying on the agent to automatically invoke skills based on task context, this extension lets you explicitly select which skill to apply to your next message.

<img width="1261" alt="Skill Palette" src="https://github.com/user-attachments/assets/a02602be-4b7b-424a-bec0-a3aeba92f09d" />

<img width="1263" alt="Unqueue Confirmation" src="https://github.com/user-attachments/assets/8ad93c58-e6e9-4c71-a0b9-41af9efe9311" />

## Features

- **Quick Access**: `/skill` command opens an elegant overlay
- **Fuzzy Search**: Type to filter skills by name or description
- **Visual Queue**: Selected skill shown in footer and widget until consumed
- **Toggle Support**: Re-select a queued skill to unqueue it (with confirmation)
- **Auto-Injection**: Skill content automatically sent with your next message

## Installation

Clone or copy the `pi-skill-palette` folder to your extensions directory:

```
~/.pi/agent/extensions/pi-skill-palette/
├── index.ts
├── package.json
├── README.md
└── CHANGELOG.md
```

## Usage

1. **Open palette**: Type `/skill` and press Enter
2. **Search**: Start typing to fuzzy-filter skills
3. **Navigate**: Use `↑`/`↓` arrow keys
4. **Select**: Press `Enter` to queue a skill
5. **Send message**: Your next message will include the skill context

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate skills |
| `Enter` | Select / Unqueue skill |
| `Esc` | Cancel |
| `Tab` | Switch buttons (in confirmation dialog) |
| `Y` / `N` | Quick confirm/cancel unqueue |

## Skill Locations

Skills are loaded from these directories (in order):

1. `~/.pi/agent/skills/` — User skills
2. `~/.pi/skills/` — Legacy user skills  
3. `.pi/skills/` — Project-specific skills

Each skill must be in its own directory with a `SKILL.md` file containing YAML frontmatter:

```markdown
---
name: my-skill
description: Brief description of what this skill does
---

# Skill Content

The actual skill instructions go here...
```

## How It Works

1. When you select a skill, it's queued in memory
2. Visual indicators show the queued skill (footer status + widget)
3. On your next message, the skill content is sent as a custom message alongside your prompt
4. The agent sees both your message and the skill context

## UI Components

### Skill Palette

```
╭──────────────────────── Skills ────────────────────────╮
│                                                        │
│  ◎  type to filter...│                                 │
│                                                        │
├────────────────────────────────────────────────────────┤
│                                                        │
│  · clean-copy  —  Reimplement a branch with clean...   │
│  ▸ code-mode ●  —  Batch multiple tool operations...   │
│  · planning  —  Create implementation plans...         │
│                                                        │
│  ●●●○○○○○○○  3/11                                      │
│                                                        │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ↑↓ navigate  enter select/unqueue  esc cancel         │
╰────────────────────────────────────────────────────────╯
```

- `▸` — Selected item
- `·` — Unselected item
- `●` — Currently queued skill
- Progress dots show scroll position

### Unqueue Confirmation

```
╭─────────────── Unqueue Skill ───────────────╮
│                                             │
│              ◆ planning                     │
│                                             │
├─────────────────────────────────────────────┤
│                                             │
│          Remove      Keep                   │
│                                             │
│           ●●●●●●●●○○  28s                   │
│                                             │
│     tab switch  enter confirm  esc cancel   │
╰─────────────────────────────────────────────╯
```

- 30-second auto-cancel timeout (keeps skill queued)
- Color-coded buttons: red Remove, green Keep
- Press `Y`/`N` for quick selection

## Dependencies

- `@mariozechner/pi-tui` — For `matchesKey` keyboard matching

## Technical Notes

- Skills are deduplicated by name (first occurrence wins)
- Symlinks are followed when scanning skill directories
- Skill content is sent via the `before_agent_start` extension event
- The skill message uses `display: false` to avoid cluttering the chat UI

## License

MIT
