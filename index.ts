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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth, type AutocompleteProvider } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	searchName: string;
	searchDescription: string;
	sortIndex: number;
}

interface SkillPaletteState {
	queuedSkills: Skill[];
}

const MAX_QUEUED_SKILLS = 3;

// Shared state across the extension
const state: SkillPaletteState = {
	queuedSkills: [],
};

// ═══════════════════════════════════════════════════════════════════════════
// Theming
// ═══════════════════════════════════════════════════════════════════════════

interface PaletteTheme {
	border: string;        // Box borders
	title: string;         // Title text
	selected: string;      // Selected item highlight
	selectedText: string;  // Selected item text
	queued: string;        // Queued badge
	searchIcon: string;    // Search icon
	placeholder: string;   // Placeholder text
	description: string;   // Skill descriptions
	hint: string;          // Footer hints
	confirm: string;       // Confirm button (keep)
	cancel: string;        // Cancel button (remove)
}

const DEFAULT_THEME: PaletteTheme = {
	border: "2",           // dim
	title: "2",            // dim
	selected: "36",        // cyan
	selectedText: "36",    // cyan
	queued: "32",          // green
	searchIcon: "2",       // dim
	placeholder: "2;3",    // dim italic
	description: "2",      // dim
	hint: "2",             // dim
	confirm: "32",         // green
	cancel: "31",          // red
};

function loadTheme(): PaletteTheme {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-skill-palette", "theme.json");
	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			const custom = JSON.parse(content) as Partial<PaletteTheme>;
			return { ...DEFAULT_THEME, ...custom };
		}
	} catch {
		// Ignore errors, use default
	}
	return DEFAULT_THEME;
}

function fg(code: string, text: string): string {
	if (!code) return text;
	// Handle compound codes like "2;3" (dim + italic)
	return `\x1b[${code}m${text}\x1b[0m`;
}

// Rainbow colors (matching powerline-footer thinking:high)
const RAINBOW_COLORS = [
	"38;2;178;129;214",  // #b281d6 purple
	"38;2;215;135;175",  // #d787af pink
	"38;2;254;188;56",   // #febc38 orange
	"38;2;228;192;15",   // #e4c00f yellow
	"38;2;137;210;129",  // #89d281 green
	"38;2;0;175;175",    // #00afaf cyan
	"38;2;23;143;185",   // #178fb9 blue
];

// Render spaced rainbow progress dots
function rainbowProgress(filled: number, total: number): string {
	const dots: string[] = [];
	for (let i = 0; i < total; i++) {
		const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
		const dot = i < filled ? "●" : "○";
		dots.push(fg(color, dot));
	}
	return dots.join(" ");
}

// Load theme once at startup
const paletteTheme = loadTheme();

// Cache keyed on array identity: pi rebuilds its system-prompt options (new skills
// array) on reload, so an identity change is exactly when re-indexing is needed.
let loadedSkillsSource: ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>["skills"];
let loadedSkillsCache: Skill[] = [];
let commandSkillsCache: Skill[] | null = null;

function indexSkills(skills: Array<Pick<Skill, "name" | "description" | "filePath" | "baseDir">>): Skill[] {
	return [...skills]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((skill, sortIndex) => ({
			...skill,
			searchName: skill.name.toLowerCase(),
			searchDescription: skill.description.toLowerCase(),
			sortIndex,
		}));
}

function getLoadedSkills(ctx: ExtensionCommandContext): Skill[] {
	const source = ctx.getSystemPromptOptions().skills;
	if (source === loadedSkillsSource) return loadedSkillsCache;

	loadedSkillsSource = source;
	loadedSkillsCache = indexSkills((source ?? []).map((skill) => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
	})));
	return loadedSkillsCache;
}

function getCommandSkills(pi: ExtensionAPI): Skill[] {
	commandSkillsCache ??= indexSkills(pi.getCommands()
		.filter((command) => command.source === "skill" && command.name.startsWith("skill:") && command.sourceInfo.path)
		.map((command) => {
			const name = command.name.slice("skill:".length);
			return {
				name,
				description: command.description ?? "",
				filePath: command.sourceInfo.path,
				baseDir: command.sourceInfo.baseDir ?? path.dirname(command.sourceInfo.path),
			};
		}));
	return commandSkillsCache;
}

function getQueuedSkillNames(): Set<string> {
	return new Set(state.queuedSkills.map((skill) => skill.name));
}

function formatSkillList(skills: Skill[]): string {
	return skills.map((skill) => skill.name).join(", ");
}

type QueueSkillsResult =
	| { status: "queued" }
	| { status: "full" };

function queueSkills(skills: Skill[]): QueueSkillsResult {
	const names = getQueuedSkillNames();
	const next = [...state.queuedSkills];

	for (const skill of skills) {
		if (names.has(skill.name)) continue;
		if (next.length >= MAX_QUEUED_SKILLS) {
			return { status: "full" };
		}
		next.push(skill);
		names.add(skill.name);
	}

	state.queuedSkills = next;
	return { status: "queued" };
}

function removeQueuedSkill(skill: Skill): void {
	state.queuedSkills = state.queuedSkills.filter((queuedSkill) => queuedSkill.name !== skill.name);
}

function updateQueuedSkillIndicators(ctx: Pick<ExtensionContext, "ui">, skills = state.queuedSkills): void {
	if (skills.length === 0) {
		ctx.ui.setStatus("skill", undefined);
		ctx.ui.setWidget("skill", undefined);
		return;
	}

	const names = formatSkillList(skills);
	const count = `${skills.length}/${MAX_QUEUED_SKILLS}`;
	ctx.ui.setStatus("skill", `📚 ${count} ${names}`);
	ctx.ui.setWidget("skill", [`\x1b[2m📚 Skills (${count}): \x1b[0m\x1b[36m${names}\x1b[0m\x1b[2m — will be applied to next message\x1b[0m`]);
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function buildSkillContext(skills: Skill[]): string {
	const blocks = skills.map((skill) => {
		const skillContent = getSkillContent(skill);
		return `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${skillContent}\n</skill>`;
	});

	if (blocks.length === 1) return blocks[0];
	return `<skills count="${blocks.length}">\n${blocks.join("\n\n")}\n</skills>`;
}

/**
 * Simple fuzzy match scoring. Expects query and text to be pre-lowercased.
 */
function fuzzyScore(query: string, text: string): number {
	if (text.includes(query)) {
		return 100 + (query.length / text.length) * 50;
	}

	let score = 0;
	let queryIndex = 0;
	let consecutiveBonus = 0;

	for (let i = 0; i < text.length && queryIndex < query.length; i++) {
		if (text[i] === query[queryIndex]) {
			score += 10 + consecutiveBonus;
			consecutiveBonus += 5;
			queryIndex++;
		} else {
			consecutiveBonus = 0;
		}
	}

	return queryIndex === query.length ? score : 0;
}

/**
 * Filter and sort skills by fuzzy match
 */
function filterSkills(skills: Skill[], query: string): Skill[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return skills;

	const scored: Array<{ skill: Skill; score: number }> = [];
	for (const skill of skills) {
		const score = Math.max(
			fuzzyScore(normalizedQuery, skill.searchName),
			fuzzyScore(normalizedQuery, skill.searchDescription) * 0.8
		);
		if (score > 0) scored.push({ skill, score });
	}
	scored.sort((a, b) => b.score - a.score || a.skill.sortIndex - b.skill.sortIndex);
	return scored.map((item) => item.skill);
}

interface ParsedSkillCommands {
	skills: Skill[];
	prompt: string;
}

interface SkillCompletionToken {
	prefix: string;
	selectedNames: Set<string>;
}

const SKILL_COMMAND_PREFIX = "/skill:";

function isCommandBoundary(char: string | undefined): boolean {
	return char === undefined || /[\s,]/.test(char);
}

function matchSkillAt(text: string, index: number, skills: Skill[]): Skill | null {
	for (const skill of skills) {
		if (text.startsWith(skill.name, index) && isCommandBoundary(text[index + skill.name.length])) {
			return skill;
		}
	}
	return null;
}

function parseSkillCommands(text: string, skills: Skill[]): ParsedSkillCommands | null {
	let index = 0;
	let first = true;
	const selected: Skill[] = [];
	const sortedSkills = [...skills].sort((a, b) => b.name.length - a.name.length);

	while (index < text.length) {
		while (/\s/.test(text[index] ?? "")) index++;

		if (first) {
			if (!text.startsWith(SKILL_COMMAND_PREFIX, index)) return null;
			index += SKILL_COMMAND_PREFIX.length;
		} else if (text.startsWith(SKILL_COMMAND_PREFIX, index)) {
			index += SKILL_COMMAND_PREFIX.length;
		} else if (text[index] === ",") {
			index++;
			while (/\s/.test(text[index] ?? "")) index++;
			if (text.startsWith(SKILL_COMMAND_PREFIX, index)) {
				index += SKILL_COMMAND_PREFIX.length;
			}
		} else {
			break;
		}

		const skill = matchSkillAt(text, index, sortedSkills);
		if (!skill) return null;
		selected.push(skill);
		index += skill.name.length;
		first = false;
	}

	return selected.length > 0 ? { skills: selected, prompt: text.slice(index).trimStart() } : null;
}

function findSkillCompletionToken(textBeforeCursor: string): SkillCompletionToken | null {
	const commandStart = textBeforeCursor.search(/\S/);
	if (commandStart === -1 || !textBeforeCursor.startsWith(SKILL_COMMAND_PREFIX, commandStart)) return null;

	let index = commandStart + SKILL_COMMAND_PREFIX.length;
	const selectedNames = new Set<string>();

	while (index <= textBeforeCursor.length) {
		const tokenStart = index;
		while (index < textBeforeCursor.length && !/[\s,]/.test(textBeforeCursor[index] ?? "")) index++;

		const token = textBeforeCursor.slice(tokenStart, index);
		if (index === textBeforeCursor.length) return { prefix: token, selectedNames };

		if (token) selectedNames.add(token);

		if (textBeforeCursor[index] === ",") {
			index++;
			while (/[\t ]/.test(textBeforeCursor[index] ?? "")) index++;
			if (textBeforeCursor.startsWith(SKILL_COMMAND_PREFIX, index)) {
				index += SKILL_COMMAND_PREFIX.length;
			}
			if (index === textBeforeCursor.length) return { prefix: "", selectedNames };
			continue;
		}

		while (/\s/.test(textBeforeCursor[index] ?? "")) index++;
		if (!textBeforeCursor.startsWith(SKILL_COMMAND_PREFIX, index)) return null;
		index += SKILL_COMMAND_PREFIX.length;
		if (index === textBeforeCursor.length) return { prefix: "", selectedNames };
	}

	return null;
}

function createSkillAutocompleteProvider(current: AutocompleteProvider, pi: ExtensionAPI): AutocompleteProvider {
	return {
		triggerCharacters: [":", ","],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const token = findSkillCompletionToken(line.slice(0, cursorCol));
			if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const blockedNames = new Set([
				...token.selectedNames,
				...state.queuedSkills.map((skill) => skill.name),
			]);
			if (blockedNames.size >= MAX_QUEUED_SKILLS) return null;

			const suggestions = filterSkills(getCommandSkills(pi), token.prefix)
				.filter((skill) => !blockedNames.has(skill.name))
				.map((skill) => ({
					value: skill.name,
					label: skill.name,
					description: skill.description,
				}));
			if (suggestions.length === 0) return null;

			return { prefix: token.prefix, items: suggestions };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

/**
 * Confirmation Dialog Component
 */
class ConfirmDialog {
	private selected = 1; // 0 = Remove, 1 = Keep (default to Keep)
	private timeoutId: ReturnType<typeof setTimeout> | null = null;
	private remainingSeconds = 30;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private requestRender: (() => void) | null = null;

	constructor(
		private skillName: string,
		private done: (confirmed: boolean) => void
	) {
		this.timeoutId = setTimeout(() => {
			this.cleanup();
			this.done(false);
		}, 30000);
	}

	/** Call after construction to start the countdown timer */
	setRequestRender(fn: () => void): void {
		this.requestRender = fn;
		// Start interval now that we can trigger re-renders
		this.intervalId = setInterval(() => {
			if (this.remainingSeconds > 0) {
				this.remainingSeconds--;
				this.requestRender?.();
			}
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
		const innerW = width - 2;
		const lines: string[] = [];

		// Theme-aware color helpers
		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const confirm = (s: string) => fg(t.confirm, s);
		const cancel = (s: string) => fg(t.cancel, s);
		const hint = (s: string) => fg(t.hint, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
		const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

		const visLen = visibleWidth;

		const center = (s: string, len: number) => {
			const truncated = truncateToWidth(s, len, "…");
			const padding = Math.max(0, len - visLen(truncated));
			const left = Math.floor(padding / 2);
			return " ".repeat(left) + truncated + " ".repeat(padding - left);
		};

		const row = (content: string) => border("│") + truncateToWidth(" " + content, innerW, "…", true) + border("│");
		const centerRow = (content: string) => border("│") + center(content, innerW) + border("│");
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Top border with title
		const titleText = " Unqueue Skill ";
		const borderLen = innerW - visLen(titleText);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border("╭" + "─".repeat(leftBorder)) + title(titleText) + border("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());

		// Skill name with icon
		lines.push(centerRow(`${selected("◆")} ${bold(this.skillName)}`));

		lines.push(emptyRow());

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		lines.push(emptyRow());

		// Buttons - pill style with inverse for selection
		const removeLabel = "  Remove  ";
		const keepLabel = "  Keep  ";

		const removeBtn = this.selected === 0
			? inverse(bold(cancel(removeLabel)))
			: hint(removeLabel);
		const keepBtn = this.selected === 1
			? inverse(bold(confirm(keepLabel)))
			: hint(keepLabel);

		lines.push(centerRow(`${removeBtn}   ${keepBtn}`));

		lines.push(emptyRow());

		// Timeout - rainbow progress indicator
		const prog = Math.max(0, Math.min(10, Math.round((this.remainingSeconds / 30) * 10)));
		const progressBar = rainbowProgress(prog, 10);
		lines.push(centerRow(`${progressBar}  ${hint(`${this.remainingSeconds}s`)}`));

		lines.push(emptyRow());

		// Footer hints - minimal
		lines.push(centerRow(hint(italic("tab") + " switch  " + italic("enter") + " confirm  " + italic("esc") + " cancel")));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

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
	private allSkills: Skill[];
	private filtered: Skill[];
	private selected = 0;
	private query = "";
	private previousQuery = "";
	private queuedSkillNames: Set<string>;
	private queuedSkillCount: number;
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private static readonly INACTIVITY_MS = 60000; // Auto-dismiss after 60s of no input

	constructor(
		skills: Skill[],
		queuedSkills: Skill[],
		private done: (skill: Skill | null, action: "select" | "unqueue" | "cancel") => void
	) {
		this.allSkills = skills;
		this.filtered = skills;
		this.queuedSkillNames = new Set(queuedSkills.map((skill) => skill.name));
		this.queuedSkillCount = queuedSkills.length;
		this.resetInactivityTimeout();
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup();
			this.done(null, "cancel");
		}, SkillPaletteComponent.INACTIVITY_MS);
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout(); // Reset on any input

		if (matchesKey(data, "escape")) {
			this.cleanup();
			this.done(null, "cancel");
			return;
		}

		if (matchesKey(data, "return")) {
			const skill = this.filtered[this.selected];
			if (skill) {
				this.cleanup();
				// Toggle: if already queued, unqueue it
				if (this.queuedSkillNames.has(skill.name)) {
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
		// Extending the query can only shrink the match set, so narrow over the
		// previous results; any other edit (backspace, paste) rescans all skills.
		const candidates = this.query.startsWith(this.previousQuery) ? this.filtered : this.allSkills;
		this.filtered = filterSkills(candidates, this.query);
		this.previousQuery = this.query;
		this.selected = 0; // Always jump to top match when typing
	}

	render(width: number): string[] {
		const innerW = width - 2;
		const lines: string[] = [];

		// Theme-aware color helpers
		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const selectedText = (s: string) => fg(t.selectedText, s);
		const queued = (s: string) => fg(t.queued, s);
		const searchIcon = (s: string) => fg(t.searchIcon, s);
		const placeholder = (s: string) => fg(t.placeholder, s);
		const description = (s: string) => fg(t.description, s);
		const hint = (s: string) => fg(t.hint, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

		const visLen = visibleWidth;

		const row = (content: string) => border("│") + truncateToWidth(" " + content, innerW, "…", true) + border("│");
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Top border with title
		const titleText = " Skills ";
		const borderLen = innerW - visLen(titleText);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border("╭" + "─".repeat(leftBorder)) + title(titleText) + border("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());

		// Search input - clean underlined style
		const cursor = selected("│");
		const searchIconChar = searchIcon("◎");
		const queryDisplay = this.query
			? `${this.query}${cursor}`
			: `${cursor}${placeholder(italic("type to filter..."))}`;
		lines.push(row(`${searchIconChar}  ${queryDisplay}`));

		lines.push(emptyRow());

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		// Skills list
		const maxVisible = 8;
		const startIndex = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

		if (this.filtered.length === 0) {
			lines.push(emptyRow());
			lines.push(row(hint(italic("No matching skills"))));
			lines.push(emptyRow());
		} else {
			lines.push(emptyRow());
			for (let i = startIndex; i < endIndex; i++) {
				const skill = this.filtered[i];
				const isSelected = i === this.selected;
				const isQueued = this.queuedSkillNames.has(skill.name);

				// Build the skill line
				const prefix = isSelected ? selected("▸") : border("·");
				const queuedBadge = isQueued ? ` ${queued("●")}` : "";
				const nameStr = isSelected ? bold(selectedText(skill.name)) : skill.name;
				const maxDescLen = Math.max(0, innerW - visLen(skill.name) - 12);
				const descStr = maxDescLen > 3 ? description(truncateToWidth(skill.description, maxDescLen, "…")) : "";

				const separator = descStr ? `  ${border("—")}  ` : "";
				const skillLine = `${prefix} ${nameStr}${queuedBadge}${separator}${descStr}`;
				lines.push(row(skillLine));
			}
			lines.push(emptyRow());

			// Scroll position indicator - rainbow dots
			if (this.filtered.length > maxVisible) {
				const prog = Math.round(((this.selected + 1) / this.filtered.length) * 10);
				const progressBar = rainbowProgress(prog, 10);
				const countStr = `${this.selected + 1}/${this.filtered.length}`;
				lines.push(row(`${progressBar}  ${hint(countStr)}`));
				lines.push(emptyRow());
			}
		}

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		lines.push(emptyRow());

		// Footer hints - minimal and elegant
		const count = `${this.queuedSkillCount}/${MAX_QUEUED_SKILLS}`;
		const hints = this.queuedSkillCount > 0
			? `${italic("↑↓")} navigate  ${italic("enter")} select${hint("/")}unqueue  ${hint(count)} queued  ${italic("esc")} cancel`
			: `${italic("↑↓")} navigate  ${italic("enter")} select  ${hint(count)} queued  ${italic("esc")} cancel`;
		lines.push(row(hint(hints)));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.cleanup();
	}
}

function extractTextPart(value: unknown): string {
	if (typeof value !== "object" || value === null || !("type" in value)) return "";

	const part = value as { type?: unknown; text?: unknown };
	if (part.type !== "text") return "";
	return typeof part.text === "string" ? part.text : "";
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content.map(extractTextPart).join("");
}

export default function skillPaletteExtension(pi: ExtensionAPI): void {
	// Register custom renderer for skill-context messages
	pi.registerMessageRenderer("skill-context", (message, options, theme) => {
		// Extract skill name and content (handle both string and array content)
		const rawContent = extractTextContent(message.content);
		const skillMatches = Array.from(rawContent.matchAll(/<skill name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/skill>/g));
		const skillNames = skillMatches.map((match) => match[1]);
		const skillTitle = skillNames.length > 1
			? `${skillNames.length}/${MAX_QUEUED_SKILLS} ${skillNames.join(", ")}`
			: skillNames[0] ?? "Unknown Skill";
		const skillContent = skillMatches.length > 1
			? skillMatches.map((match) => `# ${match[1]}\n${match[2].trim()}`).join("\n\n")
			: skillMatches[0]?.[2]?.trim() || rawContent;

		// Content preview (collapsible like read tool)
		const PREVIEW_LINES = 8;
		const parts = [
			theme.fg("accent", "◆ ") +
				theme.fg("customMessageLabel", theme.bold(skillNames.length > 1 ? "Skills: " : "Skill: ")) +
				theme.fg("accent", skillTitle),
		];
		// Dim each line separately so ANSI resets stay per-line, matching the old per-line Text output
		const lines = skillContent.split("\n");
		const shownLines = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
		parts.push(shownLines.map((line) => theme.fg("dim", line)).join("\n"));
		if (!options.expanded && lines.length > PREVIEW_LINES) {
			parts.push(theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines (click to expand)`));
		}
		return new Text(parts.join("\n"), options.outputPad, 0);
	});

	// Register the /skill command
	pi.registerCommand("skill", {
		description: "Open skill palette to select a skill for the next message",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) {
					ctx.ui.notify("/skill requires interactive TUI mode", "warning");
				}
				return;
			}

			const skills = getLoadedSkills(ctx);

			if (skills.length === 0) {
				ctx.ui.setStatus("skill", "No skills found");
				setTimeout(() => ctx.ui.setStatus("skill", undefined), 3000);
				return;
			}

			// Show the overlay and wait for result
			const result = await ctx.ui.custom<{ skill: Skill | null; action: "select" | "unqueue" | "cancel" }>(
				(_tui, _theme, _keybindings, done) => new SkillPaletteComponent(
					skills,
					state.queuedSkills,
					(skill, action) => done({ skill, action })
				),
				{ overlay: true, overlayOptions: { anchor: "center", width: 70 } }
			);

			if (result.action === "select" && result.skill) {
				const queueResult = queueSkills([result.skill]);
				if (queueResult.status === "full") {
					ctx.ui.notify(`You can queue up to ${MAX_QUEUED_SKILLS} skills. Unqueue one first.`, "warning");
					return;
				}
				updateQueuedSkillIndicators(ctx);
				ctx.ui.notify(`Skill queued (${state.queuedSkills.length}/${MAX_QUEUED_SKILLS}): ${result.skill.name}`, "info");
			} else if (result.action === "unqueue" && result.skill) {
				const skill = result.skill;
				const confirmed = await ctx.ui.custom<boolean>(
					(tui, _theme, _keybindings, done) => {
						const dialog = new ConfirmDialog(skill.name, done);
						dialog.setRequestRender(() => tui.requestRender());
						return dialog;
					},
					{ overlay: true, overlayOptions: { anchor: "center", width: 44 } }
				);

				if (confirmed) {
					removeQueuedSkill(skill);
					updateQueuedSkillIndicators(ctx);
					ctx.ui.notify(`Skill unqueued: ${skill.name}`, "info");
				}
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, pi));
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || !event.text.startsWith(SKILL_COMMAND_PREFIX)) {
			return { action: "continue" as const };
		}

		const parsed = parseSkillCommands(event.text, getCommandSkills(pi));
		if (!parsed || parsed.skills.length <= 1) {
			return { action: "continue" as const };
		}

		const uniqueSkills = parsed.skills.filter((skill, index, skills) =>
			skills.findIndex((candidate) => candidate.name === skill.name) === index
		);
		const queueResult = queueSkills(uniqueSkills);
		if (queueResult.status === "full") {
			if (ctx.hasUI) {
				ctx.ui.notify(`You can load up to ${MAX_QUEUED_SKILLS} different skills at once.`, "warning");
			}
			return { action: "handled" as const };
		}
		if (ctx.hasUI) {
			updateQueuedSkillIndicators(ctx);
			ctx.ui.notify(`Queued ${state.queuedSkills.length}/${MAX_QUEUED_SKILLS} skills: ${formatSkillList(state.queuedSkills)}`, "info");
		}

		if (!parsed.prompt) {
			return { action: "handled" as const };
		}
		return { action: "transform" as const, text: parsed.prompt };
	});

	// Handle the before_agent_start event to send skill content as custom message
	pi.on("before_agent_start", async (_event, ctx) => {
		if (state.queuedSkills.length === 0) {
			return {};
		}

		const skills = state.queuedSkills;
		state.queuedSkills = [];

		// Clear the visual indicators (use optional chaining for non-UI contexts)
		ctx.ui?.setStatus("skill", undefined);
		ctx.ui?.setWidget("skill", undefined);

		try {
			return {
				message: {
					customType: "skill-context",
					// Mirrors pi's own skill expansion so relative references inside a skill
					// resolve against the skill directory rather than the cwd.
					content: buildSkillContext(skills),
					display: true,  // Show the skill injection in chat
				},
			};
		} catch {
			ctx.ui?.setWidget("skill", undefined);
			ctx.ui?.notify(`Failed to load queued skills: ${formatSkillList(skills)}`, "warning");
			return {};
		}
	});
}
