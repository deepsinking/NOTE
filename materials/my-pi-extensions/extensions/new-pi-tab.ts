/**
 * New Pi Tab Extension
 *
 * Binds Alt+N to open a new terminal tab in the same working directory as the
 * current Pi session, and start Pi in it automatically.
 *
 * The tab is opened through Windows Terminal's command line interface:
 *
 *   wt -w 0 nt -d <cwd> powershell -NoExit -Command pi
 *
 * - `-w 0`             target the most recently used Windows Terminal window
 * - `nt`               new-tab shorthand
 * - `-d <cwd>`         starting directory, taken from Pi's own working directory
 * - `powershell ...`   command run inside the new tab; -NoExit keeps it open
 *
 * Using Pi's `ctx.cwd` as the starting directory is what makes this reliable.
 * Windows Terminal cannot inherit a tab's working directory on its own unless
 * the shell emits an OSC 9;9 escape sequence, which Windows PowerShell 5.1 does
 * not do by default.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

/** Resolve `wt.exe`, an app execution alias that fs.existsSync can miss. */
function findWt(): string | null {
	if (process.platform !== "win32") return null;
	const localAppData = process.env.LOCALAPPDATA;
	const candidates = [
		localAppData ? join(localAppData, "Microsoft", "WindowsApps", "wt.exe") : null,
		join(process.env.ProgramFiles ?? "C:\\Program Files", "WindowsApps", "wt.exe"),
	].filter((p): p is string => p !== null);
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// ignore and try the next candidate
		}
	}
	// Nothing matched statically; fall back to the alias name and let
	// CreateProcess resolve it through the App Execution Alias mechanism.
	return candidates[0] ?? null;
}

export default function newPiTab(pi: ExtensionAPI) {
	pi.registerShortcut(Key.alt("n"), {
		description: "Open a new tab in the same directory and start Pi",
		handler: async (ctx) => {
			if (process.platform !== "win32") {
				ctx.ui.notify("New Pi tab is only supported on Windows", "error");
				return;
			}

			const wt = findWt();
			if (!wt) {
				ctx.ui.notify("Could not locate wt.exe (Windows Terminal)", "error");
				return;
			}

			const cwd = ctx.cwd;
			const args = [
				"-w", "0",
				"nt",
				"-d", cwd,
				"powershell", "-NoExit", "-Command", "pi",
			];

			try {
				const child = spawn(wt, args, {
					cwd,
					detached: true,
					stdio: "ignore",
					windowsHide: true,
				});
				child.on("error", (error) => {
					ctx.ui.notify(`Failed to open new tab: ${error.message}`, "error");
				});
				child.unref();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to open new tab: ${message}`, "error");
			}
		},
	});
}
