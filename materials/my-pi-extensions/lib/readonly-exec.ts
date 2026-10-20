import { spawn } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { Readable, type Writable } from "node:stream";
import {
	executableArguments, parseReadonlyShell, ReadonlyPolicyError, supportedCommands,
	type ReadonlyCommand, type ReadonlyProgram,
} from "./readonly-shell.ts";

export interface ReadonlyConfiguration {
	trustedExecutables: Record<string, string>;
	trustedTools: string[];
}
export interface ExecutionOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}
export type ExecutableMap = ReadonlyMap<string, string>;

export async function loadReadonlyConfiguration(cwd: string): Promise<ReadonlyConfiguration> {
	let content: string;
	try { content = await readFile(join(cwd, ".pi", "readonly-lock.json"), "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { trustedExecutables: {}, trustedTools: [] };
		throw error;
	}
	const value: unknown = JSON.parse(content);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("readonly-lock.json 必须是对象");
	const config = value as Record<string, unknown>;
	if (Object.keys(config).some((key) => !["trustedExecutables", "trustedTools"].includes(key))) throw new Error("readonly-lock.json 包含未知配置项");
	const executables = config.trustedExecutables ?? {};
	const tools = config.trustedTools ?? [];
	if (!executables || typeof executables !== "object" || Array.isArray(executables)) throw new Error("trustedExecutables 必须是命令名到绝对路径的映射");
	for (const [name, path] of Object.entries(executables)) {
		if (!supportedCommands.includes(name) || ["cd", "pwd", "echo"].includes(name)) throw new Error(`不能配置未支持命令 ${name}`);
		if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${name} 必须配置可信程序的绝对路径`);
	}
	if (!Array.isArray(tools) || tools.some((name) => typeof name !== "string" || !name)) throw new Error("trustedTools 必须是非空工具名的数组");
	return { trustedExecutables: executables as Record<string, string>, trustedTools: tools as string[] };
}

/** Never search PATH or the working directory. Explicit configuration is a user trust decision. */
export async function resolveTrustedExecutables(
	cwd: string,
	agentDir: string,
	config: ReadonlyConfiguration,
): Promise<Map<string, string>> {
	const windows = process.platform === "win32";
	const roots = windows
		? [...new Set([
			process.env.ProgramFiles, process.env["ProgramFiles(x86)"],
			join(parse(resolve(cwd)).root, "Program Files"),
			join(parse(process.execPath).root, "Program Files"),
		].filter((path): path is string => !!path))]
			.flatMap((root) => [join(root, "Git", "usr", "bin"), join(root, "Git", "mingw64", "bin"), join(root, "Git", "cmd")])
		: ["/usr/bin", "/bin", "/usr/local/bin"];
	const map = new Map<string, string>();
	for (const name of supportedCommands) {
		if (["cd", "pwd", "echo"].includes(name)) continue;
		const configured = config.trustedExecutables[name];
		const filename = windows ? `${name}.exe` : name;
		const candidates = configured ? [configured] : [
			...roots.map((root) => join(root, filename)),
			...(["rg", "fd"].includes(name) ? [join(agentDir, "bin", filename)] : []),
			...(!windows && name === "fd" ? ["/usr/bin/fdfind"] : []),
		];
		for (const candidate of candidates) {
			try {
				const canonical = await realpath(candidate);
				if (!(await stat(canonical)).isFile()) continue;
				await access(canonical, constants.X_OK);
				map.set(name, canonical);
				break;
			} catch (error) {
				if (configured) throw new Error(`可信程序 ${name} 不可用: ${(error as Error).message}`);
			}
		}
	}
	return map;
}

export function readonlyEnvironment(executables: ExecutableMap): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: [...new Set([...executables.values()].map(dirname))].join(process.platform === "win32" ? ";" : ":"),
		LANG: "C.UTF-8",
		HOME: homedir(),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_NO_LAZY_FETCH: "1",
		GIT_PAGER: "cat",
	};
	// No BASH_ENV, exported functions, GIT_CONFIG_COUNT, RIPGREP_CONFIG_PATH,
	// loader injection, aliases, or arbitrary inherited tool configuration.
	for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

function nativeDirectory(input: string, cwd: string): string {
	if (process.platform === "win32" && /^\/[a-z](?:\/|$)/i.test(input)) {
		input = `${input[1]}:${input.slice(2) || "/"}`;
	}
	return resolve(cwd, input);
}

export function checkAvailableCommands(program: ReadonlyProgram, executables: ExecutableMap): void {
	for (const step of program.steps) {
		for (const command of step.pipeline) {
			if (!["cd", "pwd", "echo"].includes(command.name) && !executables.has(command.name)) {
				throw new ReadonlyPolicyError(`可信程序 ${command.name} 不可用；请配置安装位置或使用读取工具`);
			}
		}
	}
}

/** Bash-style echo formatting, performed entirely in memory after shell validation. */
export function formatEcho(args: readonly string[]): Buffer {
	let newline = true;
	let expandEscapes = false;
	let start = 0;
	while (/^-[neE]+$/.test(args[start] ?? "")) {
		for (const option of args[start++].slice(1)) {
			if (option === "n") newline = false;
			else expandEscapes = option === "e";
		}
	}
	const text = args.slice(start).join(" ");
	if (!expandEscapes) return Buffer.from(text + (newline ? "\n" : ""));
	const chunks: Buffer[] = [];
	let literal = "";
	const flush = () => { if (literal) { chunks.push(Buffer.from(literal)); literal = ""; } };
	const controls: Record<string, number> = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92 };
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "\\" || i + 1 === text.length) { literal += text[i]; continue; }
		const escape = text[i + 1];
		if (escape === "c") { newline = false; break; }
		if (controls[escape] !== undefined) {
			flush(); chunks.push(Buffer.from([controls[escape]])); i++; continue;
		}
		if (escape === "0") {
			const digits = text.slice(i + 2, i + 5).match(/^[0-7]*/)?.[0] ?? "";
			flush(); chunks.push(Buffer.from([Number.parseInt("0" + digits, 8) & 255]));
			i += 1 + digits.length; continue;
		}
		if (escape === "x" || escape === "u" || escape === "U") {
			const width = escape === "x" ? 2 : escape === "u" ? 4 : 8;
			const digits = text.slice(i + 2, i + 2 + width).match(/^[0-9a-fA-F]+/)?.[0];
			if (digits) {
				const value = Number.parseInt(digits, 16);
				if (escape === "x") { flush(); chunks.push(Buffer.from([value])); }
				else if (value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)) {
					flush(); chunks.push(Buffer.from(String.fromCodePoint(value)));
				} else literal += "\\" + escape + digits;
				i += 1 + digits.length; continue;
			}
		}
		// Unknown or incomplete escapes stay literal; generated text is never executed.
		literal += "\\" + escape; i++;
	}
	flush();
	if (newline) chunks.push(Buffer.from("\n"));
	return Buffer.concat(chunks);
}

interface Stage {
	stdout: Readable;
	stderr: Readable;
	stdin?: Writable;
	completion: Promise<{ code: number; error?: Error }>;
	stop: (force?: boolean) => void;
}

function startStage(command: ReadonlyCommand, cwd: string, executables: ExecutableMap, env: NodeJS.ProcessEnv): Stage {
	if (command.name === "pwd" || command.name === "echo") {
		const output = command.name === "pwd" ? Buffer.from(`${cwd}\n`) : formatEcho(command.args);
		return { stdout: Readable.from([output]), stderr: Readable.from([]), completion: Promise.resolve({ code: 0 }), stop: () => {} };
	}
	const child = spawn(executables.get(command.name)!, executableArguments(command), {
		cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
	});
	let error: Error | undefined;
	const completion = new Promise<{ code: number; error?: Error }>((finish) => {
		child.once("error", (value) => { error = value; });
		child.once("close", (code, signal) => finish({ code: code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1), error }));
	});
	return {
		stdout: child.stdout!, stderr: child.stderr!, stdin: child.stdin!, completion,
		stop: (force) => { if (child.exitCode === null) child.kill(force ? "SIGKILL" : "SIGTERM"); },
	};
}

function connect(sources: Readable[], destination: Writable): void {
	let remaining = sources.length;
	const end = () => { if (--remaining === 0 && !destination.destroyed) destination.end(); };
	destination.on("error", (error: NodeJS.ErrnoException) => {
		// A downstream head/grep can close its input before upstream finishes.
		if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") destination.destroy();
	});
	destination.once("close", () => { for (const source of sources) source.resume(); });
	for (const source of sources) {
		source.once("end", end);
		source.pipe(destination, { end: false });
	}
}

export async function executeReadonlyShell(
	source: string,
	initialCwd: string,
	executables: ExecutableMap,
	options: ExecutionOptions,
): Promise<{ exitCode: number }> {
	// Validate every branch before starting any command, including skipped branches.
	const program = parseReadonlyShell(source);
	checkAvailableCommands(program, executables);
	const timeout = options.timeout ?? 30;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeout 必须为正数");
	let cwd = await realpath(initialCwd);
	let exitCode = 0;
	let failure: Error | undefined;
	let active: Stage[] = [];
	let escalation: ReturnType<typeof setTimeout> | undefined;
	const env = readonlyEnvironment(executables);
	const stop = (error: Error) => {
		if (failure) return;
		failure = error;
		for (const stage of active) stage.stop();
		escalation = setTimeout(() => { for (const stage of active) stage.stop(true); }, 250);
	};
	const onAbort = () => stop(new Error("aborted"));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => stop(new Error(`timeout:${timeout}`)), timeout * 1000);
	try {
		if (options.signal?.aborted) onAbort();
		for (const step of program.steps) {
			if (failure) throw failure;
			if (step.condition === "success" && exitCode !== 0) continue;
			if (step.condition === "failure" && exitCode === 0) continue;
			if (step.pipeline[0].name === "cd") {
				const command = step.pipeline[0];
				const target = nativeDirectory(command.args[0] === "--" ? command.args[1] : command.args[0], cwd);
				try {
					const directory = await realpath(target);
					if (!(await stat(directory)).isDirectory()) throw new Error("不是目录");
					cwd = directory; exitCode = 0;
				} catch (error) {
					exitCode = 1;
					if (command.stderr !== "discard") options.onData(Buffer.from(`cd: ${(error as Error).message}\n`));
				}
				continue;
			}
			active = [];
			for (const command of step.pipeline) active.push(startStage(command, cwd, executables, env));
			for (let i = 0; i < active.length; i++) {
				const stage = active[i];
				const command = step.pipeline[i];
				if (i === 0) stage.stdin?.end();
				const outputs = command.stderr === "merge" ? [stage.stdout, stage.stderr] : [stage.stdout];
				if (i + 1 < active.length) {
					const next = active[i + 1];
					if (next.stdin) connect(outputs, next.stdin);
					else for (const stream of outputs) stream.resume();
				} else for (const stream of outputs) stream.on("data", options.onData);
				if (command.stderr === "discard") stage.stderr.resume();
				else if (command.stderr === "normal") stage.stderr.on("data", options.onData);
			}
			const results = await Promise.all(active.map((stage) => stage.completion));
			// Builtins finish synchronously, but their readable output must be drained too.
			await Promise.all(active.flatMap((stage) => [stage.stdout, stage.stderr].map((stream) => stream.readableEnded || stream.destroyed ? Promise.resolve() : new Promise<void>((finish) => {
				stream.once("end", finish); stream.once("close", finish);
			}))));
			if (failure) throw failure;
			const spawnError = results.find((result) => result.error)?.error;
			if (spawnError) throw spawnError;
			exitCode = results.at(-1)!.code;
			active = [];
		}
		return { exitCode };
	} finally {
		clearTimeout(timer);
		if (escalation) clearTimeout(escalation);
		options.signal?.removeEventListener("abort", onAbort);
		if (active.length) {
			for (const stage of active) stage.stop(true);
			await Promise.all(active.map((stage) => stage.completion));
		}
	}
}
