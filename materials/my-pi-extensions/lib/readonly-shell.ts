/** A deliberately small shell language. No shell evaluates the accepted result. */
export class ReadonlyPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReadonlyPolicyError";
	}
}

export type StderrMode = "normal" | "discard" | "merge";
export interface ReadonlyCommand { name: string; args: string[]; stderr: StderrMode }
export interface ReadonlyStep {
	condition: "always" | "success" | "failure";
	pipeline: ReadonlyCommand[];
}
export interface ReadonlyProgram { steps: ReadonlyStep[] }
interface Token { kind: "word" | "operator"; value: string }
function deny(message: string): never { throw new ReadonlyPolicyError(message); }

function tokenize(source: string): Token[] {
	if (source.includes("\0")) deny("命令包含 NUL 字符");
	const tokens: Token[] = [];
	let word = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	const flush = () => {
		if (started) tokens.push({ kind: "word", value: word });
		word = "";
		started = false;
	};
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else word += ch;
			continue;
		}
		if (ch === "\\") {
			const next = source[++i];
			if (next === undefined) deny("末尾转义符缺少字符");
			if (next === "\n") continue;
			if (next === "\r" && source[i + 1] === "\n") { i++; continue; }
			started = true;
			// Double quotes only remove backslashes before $, `, ", \\ or newline.
			word += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			else if (ch === "$" || ch === "`") deny("双引号内的变量展开和命令替换不可用");
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
		if (ch === "$" || ch === "`") deny("变量展开和命令替换不可用；请使用明确路径或字面量");
		if ("*?[{}()~".includes(ch)) deny(`未引用的 ${ch} 属于未支持的展开或语法；字面量请加引号`);
		if (ch === "#" && !started) {
			while (i + 1 < source.length && source[i + 1] !== "\n") i++;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") { flush(); continue; }
		if (!started && source.startsWith("2>&1", i)) {
			tokens.push({ kind: "operator", value: "2>&1" }); i += 3; continue;
		}
		if (!started && source.startsWith("2>", i)) {
			if (source[i + 2] === ">") deny("追加重定向不可用");
			tokens.push({ kind: "operator", value: "2>" }); i++; continue;
		}
		if (ch === "<" || ch === ">") deny("文件重定向不可用；仅支持 2>/dev/null 和 2>&1");
		if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") {
			flush();
			let op = ch;
			if ((ch === "&" || ch === "|") && source[i + 1] === ch) { op += ch; i++; }
			if (op === "&") deny("后台执行和调用运算符 & 不可用");
			tokens.push({ kind: "operator", value: op });
			continue;
		}
		if (ch.charCodeAt(0) < 32) deny("命令包含未支持的控制字符");
		started = true;
		word += ch;
	}
	if (quote) deny("引号未闭合");
	flush();
	return tokens;
}

export function parseReadonlyShell(source: string): ReadonlyProgram {
	const tokens = tokenize(source);
	const steps: ReadonlyStep[] = [];
	let index = 0;
	let condition: ReadonlyStep["condition"] = "always";
	const skipNewlines = () => { while (tokens[index]?.value === "\n" && tokens[index]?.kind === "operator") index++; };
	skipNewlines();
	while (index < tokens.length) {
		const pipeline: ReadonlyCommand[] = [];
		while (true) {
			const first = tokens[index++];
			if (first?.kind !== "word" || !first.value) deny("操作符前后需要完整命令");
			const command: ReadonlyCommand = { name: first.value, args: [], stderr: "normal" };
			let redirected = false;
			while (index < tokens.length) {
				const token = tokens[index];
				if (token.kind === "word") {
					if (redirected) deny("重定向必须位于命令参数之后");
					command.args.push(token.value); index++; continue;
				}
				if (token.value === "2>" || token.value === "2>&1") {
					index++;
					if (redirected) deny("每条命令只支持一个 stderr 重定向");
					redirected = true;
					if (token.value === "2>&1") command.stderr = "merge";
					else {
						const target = tokens[index++];
						if (target?.kind !== "word" || target.value !== "/dev/null") deny("stderr 只允许丢弃到 /dev/null");
						command.stderr = "discard";
					}
					continue;
				}
				break;
			}
			validateReadonlyCommand(command);
			pipeline.push(command);
			if (tokens[index]?.value !== "|" || tokens[index]?.kind !== "operator") break;
			index++; skipNewlines();
		}
		if (pipeline.length > 1 && pipeline.some((command) => command.name === "cd")) deny("cd 只能用于顺序命令，不能放进管道");
		steps.push({ condition, pipeline });
		if (index >= tokens.length) break;
		const separator = tokens[index++];
		if (separator.kind !== "operator") deny("命令之间缺少操作符");
		if (separator.value === "&&" || separator.value === "||") {
			condition = separator.value === "&&" ? "success" : "failure";
			skipNewlines();
			if (index >= tokens.length) deny("条件操作符后缺少命令");
		} else if (separator.value === ";" || separator.value === "\n") {
			condition = "always"; skipNewlines();
		} else deny(`未支持的操作符 ${separator.value}`);
	}
	if (steps.length === 0) deny("命令不能为空");
	return { steps };
}

type Arity = "flag" | "value" | "optional";
interface OptionRule {
	flags?: string;
	values?: string;
	shortOptional?: string;
	longFlags?: string;
	longValues?: string;
	longOptional?: string;
	minOperands?: number;
	maxOperands?: number;
	legacyCount?: boolean;
}
const common = { longFlags: "help version" };
const rule = (options: OptionRule): OptionRule => ({ ...common, ...options,
	longFlags: `${common.longFlags} ${options.longFlags ?? ""}`,
});

/** Only audited options are listed. Unknown options fail closed, including clustered shorts. */
const RULES: Record<string, OptionRule> = {
	pwd: rule({ flags: "LP", maxOperands: 0 }),
	cd: { minOperands: 1, maxOperands: 1 },
	echo: {}, // Its controlled builtin treats non-option arguments as literal output.
	printf: rule({}),
	ls: rule({ flags: "aAbBcCdDfFgGhHiklLmnpqQrRsStuUvwxX1", values: "IT", longFlags: "all almost-all author classify directory file-type full-time group-directories-first human-readable inode literal numeric-uid-gid quote-name recursive reverse size dereference dereference-command-line", longValues: "block-size format hide ignore indicator-style quoting-style sort tabsize time time-style width", longOptional: "color hyperlink" }),
	cat: rule({ flags: "AbeEnstTuv", longFlags: "show-all number-nonblank show-ends number squeeze-blank show-tabs show-nonprinting" }),
	head: rule({ flags: "qvz", values: "nc", longFlags: "quiet silent verbose zero-terminated", longValues: "lines bytes", legacyCount: true }),
	tail: rule({ flags: "qvz", values: "nc", longFlags: "quiet silent verbose zero-terminated", longValues: "lines bytes", legacyCount: true }),
	wc: rule({ flags: "clmwL", longFlags: "bytes chars lines words max-line-length", longValues: "files0-from" }),
	grep: rule({ flags: "EFGPivwxclLnHhrRsaIoqbUzZ", values: "efmABC", longFlags: "extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case invert-match word-regexp line-regexp count files-with-matches files-without-match line-number with-filename no-filename recursive dereference-recursive no-messages text only-matching quiet silent byte-offset null null-data", longValues: "regexp file max-count after-context before-context context include exclude exclude-from exclude-dir binary-files label devices directories" }),
	rg: rule({ flags: "iSsivwxclLnHhbaUoqFPup", values: "efgtrTmjABC", longFlags: "files hidden no-ignore no-ignore-vcs no-ignore-parent no-ignore-global no-ignore-dot ignore-case smart-case case-sensitive invert-match word-regexp line-regexp count count-matches files-with-matches files-without-match line-number no-line-number with-filename no-filename text multiline multiline-dotall only-matching quiet fixed-strings pcre2 unicode no-unicode follow stats no-config no-pre type-list crlf null null-data json no-messages no-heading heading pretty passthru", longValues: "regexp file glob iglob type type-not type-add type-clear replace max-count threads after-context before-context context max-depth max-filesize sort sortr encoding color context-separator", longOptional: "no-ignore-files" }),
	fd: rule({ flags: "HILsaip0uqg", values: "tdEe", longFlags: "hidden no-ignore no-ignore-vcs no-ignore-parent follow absolute-path full-path fixed-strings ignore-case case-sensitive print0 show-errors strip-cwd-prefix glob", longValues: "type extension exclude max-depth min-depth size changed-within changed-before base-directory color threads" }),
	sort: rule({ flags: "bdfginruMhVs z".replaceAll(" ", ""), values: "ktS", longFlags: "ignore-leading-blanks dictionary-order ignore-case general-numeric-sort ignore-nonprinting numeric-sort reverse stable unique zero-terminated human-numeric-sort version-sort", longValues: "key field-separator buffer-size", longOptional: "check" }),
	uniq: rule({ flags: "cduDiz", values: "fsw", longFlags: "count repeated unique ignore-case zero-terminated", longValues: "skip-fields skip-chars check-chars", longOptional: "all-repeated group", maxOperands: 1 }),
	diff: rule({ flags: "abBcCdeEfHiNnpqrsStuUwWy", values: "UCLFx", longFlags: "text ignore-space-change ignore-blank-lines ignore-case brief report-identical-files recursive new-file ignore-all-space", longValues: "unified context label exclude exclude-from width tabsize", longOptional: "color" }),
	stat: rule({ flags: "Lft", values: "c", longFlags: "dereference file-system terse", longValues: "format printf", longOptional: "cached" }),
	file: rule({ flags: "bikLnNr", values: "fFm", longFlags: "brief mime mime-type mime-encoding keep-going dereference no-dereference no-pad raw", longValues: "files-from separator magic-file exclude" }),
	du: rule({ flags: "a b c D h H k L l m P S s x 0".replaceAll(" ", ""), values: "dBX", longFlags: "all bytes total dereference-args human-readable dereference count-links no-dereference separate-dirs summarize one-file-system null", longValues: "max-depth block-size exclude exclude-from", longOptional: "time" }),
	df: rule({ flags: "aBhHiklPTx", values: "Bt x".replaceAll(" ", ""), longFlags: "all human-readable si inodes local portability print-type", longValues: "block-size type exclude-type", longOptional: "output" }),
	tree: rule({ flags: "adfilnNpqrsutughDFQJX", values: "LIP", longFlags: "dirsfirst noreport inodes device gitignore prune filelimit", longValues: "charset", longOptional: "sort" }),
	date: rule({ flags: "uR", values: "d", longFlags: "utc universal rfc-email", longValues: "date reference", longOptional: "iso-8601 rfc-3339", maxOperands: 1 }),
	uname: rule({ flags: "asnrvmpio", longFlags: "all kernel-name nodename kernel-release kernel-version machine processor hardware-platform operating-system", maxOperands: 0 }),
	whoami: rule({ maxOperands: 0 }),
	id: rule({ flags: "agnruzG", longFlags: "groups name real user group zero", maxOperands: 1 }),
	uptime: rule({ flags: "ps", maxOperands: 0 }),
	printenv: rule({ flags: "0", longFlags: "null" }),
	basename: rule({ flags: "asz", values: "s", longFlags: "multiple zero", longValues: "suffix" }),
	dirname: rule({ flags: "z", longFlags: "zero" }),
	cut: rule({ flags: "nsz", values: "bcdf", longFlags: "complement only-delimited zero-terminated", longValues: "bytes characters delimiter fields output-delimiter" }),
	tr: rule({ flags: "cCds t".replaceAll(" ", ""), longFlags: "complement delete squeeze-repeats truncate-set", minOperands: 1, maxOperands: 2 }),
};

function longOptions(spec: OptionRule): Map<string, Arity> {
	const options = new Map<string, Arity>();
	for (const [names, arity] of [[spec.longFlags, "flag"], [spec.longValues, "value"], [spec.longOptional, "optional"]] as const) {
		for (const name of names?.split(/\s+/).filter(Boolean) ?? []) options.set(name, arity);
	}
	return options;
}

function validateOptions(name: string, args: string[], spec: OptionRule): string[] {
	const operands: string[] = [];
	const longs = longOptions(spec);
	let ended = false;
	for (let i = 0; i < args.length; i++) {
		const takeValue = (key: string) => {
			const value = args[++i];
			if (value === undefined) deny(`${name} 的 ${key} 缺少参数值`);
			const pattern = ["grep", "rg", "git grep"].includes(name) && ["e", "regexp"].includes(key);
			if (value.startsWith("-") && !/^-\d+$/.test(value) && !pattern) {
				deny(`${name} 的 ${key} 参数值不能隐藏其他选项；请使用 --option=value 或附着的短参数值`);
			}
		};
		const arg = args[i];
		if (!ended && arg === "--") { ended = true; continue; }
		if (ended || arg === "-" || !arg.startsWith("-")) { operands.push(arg); continue; }
		if (spec.legacyCount && /^-\d+$/.test(arg)) continue;
		if (arg.startsWith("--")) {
			const equal = arg.indexOf("=");
			const key = arg.slice(2, equal < 0 ? undefined : equal);
			const arity = longs.get(key);
			if (!arity) deny(`${name} 的参数 --${key} 未获只读授权`);
			if (arity === "flag" && equal >= 0) deny(`${name} 的 --${key} 不接受参数值`);
			if (arity === "value" && equal < 0) takeValue(key);
			continue;
		}
		for (let j = 1; j < arg.length; j++) {
			const flag = arg[j];
			if (spec.shortOptional?.includes(flag)) {
				if (!/^\d*$/.test(arg.slice(j + 1))) deny(`${name} 的 -${flag} 附着值必须为数字`);
				break;
			}
			if (spec.values?.includes(flag)) {
				if (j + 1 === arg.length) takeValue(flag);
				break;
			}
			if (!spec.flags?.includes(flag)) deny(`${name} 的参数 -${flag} 未获只读授权`);
		}
	}
	if (operands.length < (spec.minOperands ?? 0)) deny(`${name} 缺少位置参数`);
	if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) deny(`${name} 最多允许 ${spec.maxOperands} 个输入位置参数；输出文件位置参数不可用`);
	return operands;
}

const FIND_FLAGS = new Set("-H -L -P --help --version -depth -mount -xdev -noleaf -ignore_readdir_race -noignore_readdir_race -daystart -follow -empty -false -true -readable -writable -executable -nouser -nogroup -print -print0 -printf -ls -prune -quit -not -a -and -o -or ! ( )".split(" "));
const FIND_VALUES = new Set("-name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -size -maxdepth -mindepth -mtime -mmin -atime -amin -ctime -cmin -newer -anewer -cnewer -perm -user -group -uid -gid -inum -links -fstype -used".split(" "));
function validateFind(args: string[]): void {
	let expression = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (FIND_VALUES.has(arg) || arg === "-printf") {
			expression = true;
			if (++i >= args.length) deny(`find 的 ${arg} 缺少参数值`);
		} else if (FIND_FLAGS.has(arg)) expression = true;
		else if (arg.startsWith("-") || expression) deny(`find 的动作或参数 ${arg} 未获只读授权`);
	}
}

const GIT_RULES: Record<string, OptionRule> = {
	status: { flags: "sbvz", longFlags: "short branch show-stash verbose null no-renames", longOptional: "porcelain untracked-files ignored", maxOperands: 0 },
	log: { flags: "pPsz", values: "n", legacyCount: true, longFlags: "oneline all reverse no-merges merges first-parent graph abbrev-commit no-abbrev-commit relative-date no-decorate follow name-only name-status no-ext-diff no-textconv", longValues: "max-count since until after before author committer grep date skip", longOptional: "format pretty decorate stat branches tags remotes" },
	show: { flags: "pPsz", legacyCount: true, longFlags: "oneline abbrev-commit no-abbrev-commit name-only name-status no-ext-diff no-textconv", longValues: "date", longOptional: "format pretty stat" },
	diff: { flags: "pPswbz", shortOptional: "U", longFlags: "name-only name-status numstat shortstat summary check quiet exit-code cached staged no-index ignore-space-change ignore-all-space ignore-space-at-eol ignore-cr-at-eol no-ext-diff no-textconv no-renames", longValues: "src-prefix dst-prefix diff-filter", longOptional: "unified stat relative color" },
	grep: { flags: "EFGPivwxclLnHhrIqaz", values: "efmABC", longFlags: "cached no-index untracked no-exclude-standard recurse-submodules ignore-case invert-match word-regexp count files-with-matches files-without-match line-number only-matching quiet text extended-regexp fixed-strings perl-regexp", longValues: "regexp file max-count after-context before-context context" },
	"ls-files": { flags: "csdomuikvz", values: "xX", longFlags: "cached deleted modified others ignored stage unmerged killed directory no-empty-directory exclude-standard full-name error-unmatch eol deduplicate", longValues: "exclude exclude-from exclude-per-directory format" },
	"rev-parse": { longFlags: "show-toplevel show-prefix show-cdup git-dir absolute-git-dir git-common-dir is-inside-work-tree is-inside-git-dir is-bare-repository verify quiet abbrev-ref symbolic symbolic-full-name all branches tags remotes", longValues: "git-path", longOptional: "short" },
	blame: { flags: "wblL", values: "LS", longFlags: "line-porcelain porcelain incremental show-email show-name show-number root", longValues: "contents date" },
	describe: { longFlags: "all tags contains always long exact-match first-parent", longValues: "match exclude candidates abbrev", longOptional: "dirty broken" },
	"merge-base": { flags: "a", longFlags: "all octopus independent is-ancestor fork-point" },
	"cat-file": { flags: "tsep", maxOperands: 2 },
	shortlog: { flags: "sne", longFlags: "summary numbered email all", longValues: "group", longOptional: "format" },
	branch: { flags: "arv", longFlags: "all remotes verbose list show-current", longValues: "format sort", maxOperands: 0 },
	remote: { flags: "v", longFlags: "verbose", maxOperands: 0 },
};

export function validateReadonlyCommand(command: ReadonlyCommand): void {
	const { name, args } = command;
	if (!/^[a-z][a-z0-9-]*$/.test(name)) deny("只允许命令名；可执行文件路径、赋值、别名和大小写变体不可用");
	// echo cannot write files or launch programs. The lexer and program parser
	// already enforce redirections, substitutions, and every following command.
	// Its builtin recognizes only leading -n/-e/-E groups; other words are data.
	if (name === "echo") return;
	if (name === "find") { validateFind(args); return; }
	if (name === "git") {
		const subcommand = args[0];
		const spec = Object.hasOwn(GIT_RULES, subcommand) ? GIT_RULES[subcommand] : undefined;
		if (!spec) deny(`git 子命令 ${subcommand ?? "(缺失)"} 未获只读授权`);
		validateOptions(`git ${subcommand}`, args.slice(1), spec);
		return;
	}
	const spec = Object.hasOwn(RULES, name) ? RULES[name] : undefined;
	if (!spec) deny(`命令 ${name} 未获只读授权`);
	const operands = validateOptions(name, args, spec);
	if (name === "date" && operands.some((arg) => !arg.startsWith("+"))) deny("date 的裸日期参数会设置时间；只允许 +FORMAT 或 --date 查询");
	if (name === "cd" && operands[0] === "-") deny("cd - 不可用；请使用明确目录");
}

export const supportedCommands = Object.freeze([...Object.keys(RULES), "find", "git"]);

/** Defense in depth for commands that normally consult configuration or launch helpers. */
export function executableArguments(command: ReadonlyCommand): string[] {
	if (command.name === "rg") return ["--no-config", ...command.args];
	if (command.name !== "git") return command.args;
	const [subcommand, ...args] = command.args;
	const guards = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null"];
	const diffGuards = ["log", "show", "diff"].includes(subcommand) ? ["--no-ext-diff", "--no-textconv"] : [];
	return [...guards, subcommand, ...diffGuards, ...args];
}
