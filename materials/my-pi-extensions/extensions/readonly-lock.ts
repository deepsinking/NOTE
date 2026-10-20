/**
 * Readonly Lock: session permission switch with a restricted, shell-free executor.
 * Install both .pi/extensions/readonly-lock.ts and .pi/lib/readonly-*.ts.
 * Alt+L / /lock controls model calls; user ! commands use Pi's normal execution.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { checkAvailableCommands, executeReadonlyShell, loadReadonlyConfiguration, resolveTrustedExecutables } from "../lib/readonly-exec.ts";
import { parseReadonlyShell } from "../lib/readonly-shell.ts";
import { restoreLockState } from "../lib/readonly-session.ts";

const ENTRY_TYPE = "readonly-lock";
const STATUS_KEY = "readonly-lock";
const SECTION_NAME = "readonly_lock";
const DEFAULT_LOCKED = false;
const LOCKED_TEXT = [
	"READ-ONLY MODE IS ACTIVE.",
	"",
	"File modification tools and untrusted tools are unavailable; their calls will fail.",
	"Bash supports audited inspection commands, literal arguments, cd, pipes, &&, ||, semicolons,",
	"and stderr discard/merge (2>/dev/null or 2>&1). It uses pinned executables without a shell.",
	"Unsupported options, file outputs, background execution, expansions, substitutions, and",
	"PowerShell are unavailable. Quote literal patterns and paths containing spaces.",
	"",
	"This is a session permission state and remains active until the user changes it.",
	"Continue the requested inspection. Do not probe denied operations or ask to be unlocked.",
	"Report findings and state which requested changes need write access. The user controls the switch.",
].join("\n");
const ALWAYS_BLOCKED = new Set(["edit", "write", "replace", "insert", "undo_last_change", "apply_patch", "str_replace", "codemode", "tool_search"]);
// These names assume the installed first-party tools and extensions are trusted.
// readOnlyHint alone does not grant permission to third-party tools.
const KNOWN_READONLY = new Set(["read", "grep", "find", "ls", "glob", "tree", "question", "questionnaire"]);

export default function readonlyLock(pi: ExtensionAPI): void {
	let locked = DEFAULT_LOCKED;
	let executables = new Map<string, string>();
	let trustedTools = new Set<string>();
	let initializationError: string | undefined;
	let ready: Promise<void> = Promise.resolve();

	function applyStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, locked ? ctx.ui.theme.fg("warning", "🔒 readonly") : undefined);
	}
	function setLocked(next: boolean, ctx: ExtensionContext): void {
		if (locked === next) return;
		locked = next;
		pi.appendEntry(ENTRY_TYPE, { locked });
		applyStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify(locked ? "只读锁已开启：模型只能查看，不能修改" : "只读锁已关闭", locked ? "warning" : "info");
	}
	async function initialize(ctx: ExtensionContext): Promise<void> {
		executables = new Map(); trustedTools = new Set(); initializationError = undefined;
		try {
			const config = await loadReadonlyConfiguration(ctx.cwd);
			executables = await resolveTrustedExecutables(ctx.cwd, getAgentDir(), config);
			trustedTools = new Set(config.trustedTools);
		} catch (error) {
			initializationError = `只读执行配置不可用: ${(error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(initializationError, "error");
		}
	}

	pi.registerCommand("lock", {
		description: "只读锁：/lock 切换，/lock on|off|status 显式控制",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "on") return setLocked(true, ctx);
			if (sub === "off") return setLocked(false, ctx);
			if (sub === "status") {
				ctx.ui.notify(locked ? "🔒 只读锁：已开启" : "🔓 只读锁：已关闭", "info");
				return;
			}
			if (sub) { ctx.ui.notify(`未知参数 "${sub}"，用 /lock [on|off|status]`, "warning"); return; }
			setLocked(!locked, ctx);
		},
	});
	pi.registerShortcut(Key.alt("l"), { description: "Toggle readonly lock", handler: async (ctx) => setLocked(!locked, ctx) });

	// Override only the model's tool. Pi's user_bash channel is intentionally separate.
	const normalBash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...normalBash,
		execute: async (id, params, signal, onUpdate, ctx) => {
			await ready;
			if (!locked) {
				const settings = pi.getSettings();
				return createBashToolDefinition(ctx.cwd, {
					shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix,
				}).execute(id, params, signal, onUpdate, ctx);
			}
			if (initializationError) throw new Error(initializationError);
			const restrictedBash = createBashToolDefinition(ctx.cwd, {
				exposeSessionEnvironment: false,
				operations: { exec: (command, cwd, options) => executeReadonlyShell(command, cwd, executables, options) },
			});
			return restrictedBash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions.sections;
		if (locked) {
			if (sections[SECTION_NAME] !== LOCKED_TEXT) sections[SECTION_NAME] = LOCKED_TEXT;
		} else if (SECTION_NAME in sections) delete sections[SECTION_NAME];
	});

	pi.on("tool_call", async (event) => {
		if (!locked) return;
		const name = event.toolName;
		const block = (reason: string) => ({ block: true as const, reason: `只读锁已开启：${reason}。请基于只读检查汇报，需要修改的部分需要写权限。` });
		if (ALWAYS_BLOCKED.has(name)) return block(`${name} 不可用`);
		if (name === "powershell") return block("PowerShell 尚无独立只读规则，请使用 Bash 或读取工具");
		if (name === "bash") {
			await ready;
			if (initializationError) return block(initializationError);
			try {
				const input = event.input as { command?: unknown };
				if (typeof input.command !== "string") return block("command 必须是字符串");
				checkAvailableCommands(parseReadonlyShell(input.command), executables);
			} catch (error) { return block((error as Error).message); }
			return;
		}
		if (KNOWN_READONLY.has(name) || trustedTools.has(name)) return;
		return block(`工具 "${name}" 不在可信只读工具清单中，readOnlyHint 不自动授权`);
	});

	pi.on("session_start", async (_event, ctx) => {
		// Permission is session-wide: use the latest explicit toggle across branches.
		// A new session with no permission record uses the declared default.
		locked = restoreLockState(ctx.sessionManager.getEntries(), DEFAULT_LOCKED);
		applyStatus(ctx);
		ready = initialize(ctx);
		await ready;
	});
	pi.on("session_tree", async (_event, ctx) => applyStatus(ctx));
}
