/**
 * pi-skill-palette
 *
 * A VS Code/Amp-style command palette for quickly selecting and applying skills.
 * Usage: /skill - Opens the skill picker overlay
 *
 * When a skill is selected, it's queued and the skill content is sent
 * alongside your next message automatically.
 *
 * https://github.com/nicobailon/pi-skill-palette
 */

import type { ExtensionAPI, ExtensionContext } from "@anthropic-ai/claude-code";
import { matchesKey } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface Skill {
	name: string;
	description: string;
	filePath: string;
}

interface SkillPaletteState {
	queuedSkill: Skill | null;
}

// Shared state across the extension
const state: SkillPaletteState = {
	queuedSkill: null,
};

/**
 * Load skills from known directories
 */
function loadSkills(): Skill[] {
	const skillsByName = new Map<string, Skill>();
	const skillDirs = [
		path.join(os.homedir(), ".pi", "agent", "skills"),
		path.join(os.homedir(), ".pi", "skills"),
		path.join(process.cwd(), ".pi", "skills"),
	];

	for (const skillDir of skillDirs) {
		if (!fs.existsSync(skillDir)) continue;

		try {
			const entries = fs.readdirSync(skillDir);
			for (const entryName of entries) {
				const entryPath = path.join(skillDir, entryName);
				
				// Check if it's a directory (follows symlinks)
				try {
					const stat = fs.statSync(entryPath);
					if (!stat.isDirectory()) continue;
				} catch {
					continue;
				}

				const skillFile = path.join(entryPath, "SKILL.md");
				if (!fs.existsSync(skillFile)) continue;

				try {
					const content = fs.readFileSync(skillFile, "utf-8");
					const { name, description } = parseFrontmatter(content, entryName);
					if (description && !skillsByName.has(name)) {
						// First occurrence wins (user > project scope)
						skillsByName.set(name, {
							name,
							description,
							filePath: skillFile,
						});
					}
				} catch {
					// Skip invalid skill files
				}
			}
		} catch {
			// Skip inaccessible directories
		}
	}

	// Sort alphabetically by name
	return Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse frontmatter from skill file
 */
function parseFrontmatter(content: string, fallbackName: string): { name: string; description: string } {
	if (!content.startsWith("---")) {
		return { name: fallbackName, description: "" };
	}

	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { name: fallbackName, description: "" };
	}

	const frontmatter = content.slice(4, endIndex);
	let name = fallbackName;
	let description = "";

	for (const line of frontmatter.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;

		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();

		if (key === "name") name = value;
		if (key === "description") description = value;
	}

	return { name, description };
}

/**
 * Get skill content without frontmatter
 */
function getSkillContent(skill: Skill): string {
	const raw = fs.readFileSync(skill.filePath, "utf-8");
	if (!raw.startsWith("---")) return raw;

	const endIndex = raw.indexOf("\n---", 3);
	if (endIndex === -1) return raw;

	return raw.slice(endIndex + 4).trim();
}

/**
 * Simple fuzzy match scoring
 */
function fuzzyScore(query: string, text: string): number {
	const lowerQuery = query.toLowerCase();
	const lowerText = text.toLowerCase();

	if (lowerText.includes(lowerQuery)) {
		return 100 + (lowerQuery.length / lowerText.length) * 50;
	}

	let score = 0;
	let queryIndex = 0;
	let consecutiveBonus = 0;

	for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
		if (lowerText[i] === lowerQuery[queryIndex]) {
			score += 10 + consecutiveBonus;
			consecutiveBonus += 5;
			queryIndex++;
		} else {
			consecutiveBonus = 0;
		}
	}

	return queryIndex === lowerQuery.length ? score : 0;
}

/**
 * Filter and sort skills by fuzzy match
 */
function filterSkills(skills: Skill[], query: string): Skill[] {
	if (!query.trim()) return skills;

	const scored = skills
		.map((skill) => ({
			skill,
			score: Math.max(
				fuzzyScore(query, skill.name),
				fuzzyScore(query, skill.description) * 0.8
			),
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);

	return scored.map((item) => item.skill);
}

/**
 * Confirmation Dialog Component
 */
class ConfirmDialog {
	readonly width = 44;
	private selected = 1; // 0 = Remove, 1 = Keep (default to Keep)
	private timeoutId: ReturnType<typeof setTimeout> | null = null;
	private remainingSeconds = 30;
	private intervalId: ReturnType<typeof setInterval> | null = null;

	constructor(
		private skillName: string,
		private done: (confirmed: boolean) => void
	) {
		this.timeoutId = setTimeout(() => {
			this.cleanup();
			this.done(false);
		}, 30000);
		
		this.intervalId = setInterval(() => {
			this.remainingSeconds--;
		}, 1000);
	}

	private cleanup(): void {
		if (this.timeoutId) clearTimeout(this.timeoutId);
		if (this.intervalId) clearInterval(this.intervalId);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.cleanup();
			this.done(false);
			return;
		}

		if (matchesKey(data, "return")) {
			this.cleanup();
			this.done(this.selected === 0);
			return;
		}

		if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.selected = this.selected === 0 ? 1 : 0;
			return;
		}

		if (data === "y" || data === "Y") {
			this.cleanup();
			this.done(true);
			return;
		}

		if (data === "n" || data === "N") {
			this.cleanup();
			this.done(false);
			return;
		}
	}

	render(width: number): string[] {
		const w = Math.min(this.width, width - 4);
		const innerW = w - 2;
		const lines: string[] = [];

		// ANSI codes
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
		const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

		const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

		const pad = (s: string, len: number) => {
			return s + " ".repeat(Math.max(0, len - visLen(s)));
		};

		const center = (s: string, len: number) => {
			const padding = Math.max(0, len - visLen(s));
			const left = Math.floor(padding / 2);
			return " ".repeat(left) + s + " ".repeat(padding - left);
		};

		const row = (content: string) => dim("│") + pad(" " + content, innerW) + dim("│");
		const centerRow = (content: string) => dim("│") + center(content, innerW) + dim("│");
		const emptyRow = () => dim("│") + " ".repeat(innerW) + dim("│");

		// Top border with title
		const title = " Unqueue Skill ";
		const borderLen = innerW - visLen(title);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(dim("╭" + "─".repeat(leftBorder)) + dim(title) + dim("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());
		
		// Skill name with icon
		lines.push(centerRow(`${yellow("◆")} ${bold(this.skillName)}`));
		
		lines.push(emptyRow());

		// Divider
		lines.push(dim("├" + "─".repeat(innerW) + "┤"));
		
		lines.push(emptyRow());

		// Buttons - pill style with inverse for selection
		const removeLabel = "  Remove  ";
		const keepLabel = "  Keep  ";
		
		const removeBtn = this.selected === 0 
			? inverse(bold(red(removeLabel)))
			: dim(removeLabel);
		const keepBtn = this.selected === 1 
			? inverse(bold(green(keepLabel)))
			: dim(keepLabel);
		
		lines.push(centerRow(`${removeBtn}   ${keepBtn}`));

		lines.push(emptyRow());

		// Timeout - subtle progress indicator
		const progress = Math.round((this.remainingSeconds / 30) * 10);
		const progressBar = "●".repeat(progress) + "○".repeat(10 - progress);
		lines.push(centerRow(dim(`${progressBar}  ${this.remainingSeconds}s`)));

		lines.push(emptyRow());

		// Footer hints - minimal
		lines.push(centerRow(dim(italic("tab") + " switch  " + italic("enter") + " confirm  " + italic("esc") + " cancel")));

		// Bottom border
		lines.push(dim(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	
	dispose(): void {
		this.cleanup();
	}
}

/**
 * Skill Palette Overlay Component
 */
class SkillPaletteComponent {
	readonly width = 70;
	private allSkills: Skill[];
	private filtered: Skill[];
	private selected = 0;
	private query = "";
	private queuedSkillName: string | null;

	constructor(
		skills: Skill[],
		queuedSkill: Skill | null,
		private done: (skill: Skill | null, action: "select" | "unqueue" | "cancel") => void
	) {
		this.allSkills = skills;
		this.filtered = skills;
		this.queuedSkillName = queuedSkill?.name ?? null;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(null, "cancel");
			return;
		}

		if (matchesKey(data, "return")) {
			const skill = this.filtered[this.selected];
			if (skill) {
				// Toggle: if already queued, unqueue it
				if (skill.name === this.queuedSkillName) {
					this.done(skill, "unqueue");
				} else {
					this.done(skill, "select");
				}
			}
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
			}
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.updateFilter();
			}
			return;
		}

		// Printable character
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.updateFilter();
		}
	}

	private updateFilter(): void {
		this.filtered = filterSkills(this.allSkills, this.query);
		this.selected = 0; // Always jump to top match when typing
	}

	render(width: number): string[] {
		const w = Math.min(this.width, width - 4);
		const innerW = w - 2;
		const lines: string[] = [];

		// ANSI codes
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
		const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[39m`;

		const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

		const pad = (s: string, len: number) => {
			return s + " ".repeat(Math.max(0, len - visLen(s)));
		};

		const truncate = (s: string, maxLen: number) => {
			if (s.length <= maxLen) return s;
			return s.slice(0, maxLen - 1) + "…";
		};

		const row = (content: string) => dim("│") + pad(" " + content, innerW) + dim("│");
		const emptyRow = () => dim("│") + " ".repeat(innerW) + dim("│");

		// Top border with title
		const title = " Skills ";
		const borderLen = innerW - visLen(title);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(dim("╭" + "─".repeat(leftBorder)) + dim(title) + dim("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());

		// Search input - clean underlined style
		const cursor = cyan("│");
		const searchIcon = dim("◎");
		const queryDisplay = this.query || dim(italic("type to filter..."));
		lines.push(row(`${searchIcon}  ${queryDisplay}${cursor}`));

		lines.push(emptyRow());

		// Divider
		lines.push(dim("├" + "─".repeat(innerW) + "┤"));

		// Skills list
		const maxVisible = 8;
		const startIndex = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

		if (this.filtered.length === 0) {
			lines.push(emptyRow());
			lines.push(row(dim(italic("No matching skills"))));
			lines.push(emptyRow());
		} else {
			lines.push(emptyRow());
			for (let i = startIndex; i < endIndex; i++) {
				const skill = this.filtered[i];
				const isSelected = i === this.selected;
				const isQueued = skill.name === this.queuedSkillName;
				
				// Build the skill line
				const prefix = isSelected ? cyan("▸") : dim("·");
				const queuedBadge = isQueued ? ` ${green("●")}` : "";
				const nameStr = isSelected ? bold(cyan(skill.name)) : skill.name;
				const maxDescLen = innerW - visLen(skill.name) - 12;
				const descStr = dim(truncate(skill.description, maxDescLen));
				
				const skillLine = `${prefix} ${nameStr}${queuedBadge}  ${dim("—")}  ${descStr}`;
				lines.push(row(skillLine));
			}
			lines.push(emptyRow());

			// Scroll position indicator
			if (this.filtered.length > maxVisible) {
				const progress = Math.round(((this.selected + 1) / this.filtered.length) * 10);
				const progressBar = "●".repeat(progress) + "○".repeat(10 - progress);
				const countStr = `${this.selected + 1}/${this.filtered.length}`;
				lines.push(row(dim(`${progressBar}  ${countStr}`)));
				lines.push(emptyRow());
			}
		}

		// Divider
		lines.push(dim("├" + "─".repeat(innerW) + "┤"));

		lines.push(emptyRow());

		// Footer hints - minimal and elegant
		const hints = this.queuedSkillName 
			? `${italic("↑↓")} navigate  ${italic("enter")} select${dim("/")}unqueue  ${italic("esc")} cancel`
			: `${italic("↑↓")} navigate  ${italic("enter")} select  ${italic("esc")} cancel`;
		lines.push(row(dim(hints)));

		// Bottom border
		lines.push(dim(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function skillPaletteExtension(pi: ExtensionAPI): void {
	// Register the /skill command
	pi.registerCommand("skill", {
		description: "Open skill palette to select a skill for the next message",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const skills = loadSkills();

			if (skills.length === 0) {
				ctx.ui.setStatus("skill", "No skills found");
				setTimeout(() => ctx.ui.setStatus("skill", undefined), 3000);
				return;
			}

			// Show the overlay and wait for result
			const result = await ctx.ui.custom<{ skill: Skill | null; action: "select" | "unqueue" | "cancel" }>(
				(_tui, _theme, _keybindings, done) => new SkillPaletteComponent(
					skills,
					state.queuedSkill,
					(skill, action) => done({ skill, action })
				),
				{ overlay: true }
			);

			if (result.action === "select" && result.skill) {
				state.queuedSkill = result.skill;
				ctx.ui.setStatus("skill", `📚 ${result.skill.name}`);
				ctx.ui.setWidget("skill", [`\x1b[2m📚 Skill: \x1b[0m\x1b[36m${result.skill.name}\x1b[0m\x1b[2m — will be applied to next message\x1b[0m`]);
				ctx.ui.notify(`Skill queued: ${result.skill.name}`, "info");
			} else if (result.action === "unqueue" && result.skill) {
				// Show confirmation dialog
				const confirmed = await ctx.ui.custom<boolean>(
					(_tui, _theme, _keybindings, done) => new ConfirmDialog(result.skill!.name, done),
					{ overlay: true }
				);

				if (confirmed) {
					state.queuedSkill = null;
					ctx.ui.setStatus("skill", undefined);
					ctx.ui.setWidget("skill", undefined);
					ctx.ui.notify("Skill unqueued", "info");
				}
			}
		},
	});

	// Handle the before_agent_start event to send skill content as custom message
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.queuedSkill) {
			return {};
		}

		const skill = state.queuedSkill;
		state.queuedSkill = null;

		// Clear the visual indicators
		ctx.ui.setStatus("skill", undefined);
		ctx.ui.setWidget("skill", undefined);

		try {
			const skillContent = getSkillContent(skill);

			return {
				message: {
					customType: "skill-context",
					content: `<skill name="${skill.name}">\n${skillContent}\n</skill>`,
					display: false,
				},
			};
		} catch {
			ctx.ui.setWidget("skill", undefined);
			ctx.ui.notify(`Failed to load skill: ${skill.name}`, "warning");
			return {};
		}
	});
}
