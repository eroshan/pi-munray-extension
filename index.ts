import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	accessSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DynamicBorder,
	getMarkdownTheme,
	highlightCode,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

type JsonRpcId = number | string;

type JsonRpcRequest<TParams = unknown> = {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: TParams;
};

type JsonRpcResponse<TResult = unknown> = {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: TResult;
	error?: { code: number; message: string; data?: unknown };
};

type McpConfig = {
	command: string[];
	environment?: Record<string, string>;
};

type McpTool = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
};

// Calculate the extension name from the current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const extensionName = basename(__dirname);
const EXTENSION_ID = "munray";
const CONFIG_FILENAME = `pi-${EXTENSION_ID}-extension.conf`;
const DEFAULT_CONFIG_PATH = resolve(homedir(), ".pi", "agent", CONFIG_FILENAME);
const CONFIG_TEMPLATE_PATH = resolve(__dirname, `${CONFIG_FILENAME}.template`);

function expandHome(p: string): string {
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	if (p === "~") return homedir();
	return p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function toErrorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return typeof e === "string" ? e : String(e);
}

function parseFileRef(value: string): { type: "file"; path: string } | null {
	const m = value.match(/^\{file:(.+)\}$/);
	if (!m) return null;
	return { type: "file", path: expandHome(m[1].trim()) };
}

function stripJsonComments(raw: string): string {
	let result = "";
	let inString = false;
	let escaped = false;

	for (let i = 0; i < raw.length; i++) {
		const char = raw[i];
		const next = raw[i + 1];
		if (inString) {
			result += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			result += char;
		} else if (char === "/" && next === "/") {
			while (i < raw.length && raw[i] !== "\n") i++;
			if (i < raw.length) result += "\n";
		} else if (char === "/" && next === "*") {
			i += 2;
			while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
				if (raw[i] === "\n") result += "\n";
				i++;
			}
			i++;
		} else {
			result += char;
		}
	}
	return result;
}

function ensureDefaultConfig(): void {
	if (existsSync(DEFAULT_CONFIG_PATH)) return;

	mkdirSync(dirname(DEFAULT_CONFIG_PATH), { recursive: true });
	const template = readFileSync(CONFIG_TEMPLATE_PATH, "utf-8");
	try {
		// "wx" ensures a config created by another Pi process is never overwritten.
		writeFileSync(DEFAULT_CONFIG_PATH, template, { encoding: "utf-8", mode: 0o600, flag: "wx" });
	} catch (error: unknown) {
		if (!(isRecord(error) && error["code"] === "EEXIST")) throw error;
	}
}

function loadConfig(path: string): McpConfig {
	const abs = expandHome(path);
	const raw = readFileSync(abs, "utf-8");
	const data: unknown = JSON.parse(stripJsonComments(raw));

	// Accept either { command, environment } or a nested MCP server configuration.
	let cfg: unknown = data;
	if (isRecord(cfg)) {
		const mcp = cfg["mcp"];
		if (isRecord(mcp)) {
			const serverConfig = mcp[EXTENSION_ID];
			if (isRecord(serverConfig)) cfg = serverConfig;
		}
	}

	if (!isRecord(cfg)) {
		throw new Error(`Invalid ${EXTENSION_ID} config at ${abs}: expected object`);
	}

	const command = cfg["command"];
	if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string")) {
		throw new Error(`Invalid ${EXTENSION_ID} config at ${abs}: missing command array`);
	}

	const environmentRaw = cfg["environment"];
	const environment: Record<string, string> = {};
	if (isRecord(environmentRaw)) {
		for (const [k, v] of Object.entries(environmentRaw)) {
			if (typeof v === "string") environment[k] = v;
		}
	}

	return { command, environment };
}

function buildEnv(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...process.env };
	if (!env) return out;

	for (const [k, v] of Object.entries(env)) {
		const fileRef = typeof v === "string" ? parseFileRef(v) : null;
		if (fileRef) {
			const content = readFileSync(fileRef.path, "utf-8").replace(/\r?\n$/, "");
			out[k] = content;
		} else {
			out[k] = v;
		}
	}
	return out;
}

class McpStdioClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
	private lastCtx: ExtensionContext | null = null;
	private initialized = false;
	private initInstructions: string | null = null;
	private serverInfo: { name?: string; version?: string } | null = null;
	private mcpTools: McpTool[] = [];
	private unavailableReason: string | null = null;
	private lastFatalNotified: string | null = null;

	// When executing a mutating tool, the server may send a truncated code preview in elicitation.message.
	// We keep the full code here so the approval UI can show an expandable full preview.
	private pendingMutatingCode: string | null = null;

	constructor(private _pi: ExtensionAPI) {}

	setPendingMutatingCode(code: string | null) {
		this.pendingMutatingCode = code;
	}

	getPendingMutatingCode(): string | null {
		return this.pendingMutatingCode;
	}

	setContext(ctx: ExtensionContext | null) {
		this.lastCtx = ctx;
	}

	isRunning(): boolean {
		return !!this.child && !this.child.killed;
	}

	async start(config: McpConfig, ctx: ExtensionContext, meta?: { configPath?: string }) {
		if (this.isRunning()) return;

		const [cmd, ...args] = config.command;
		const env = buildEnv(config.environment);

		// Graceful degradation: if the command is an explicit path, preflight it so we can fail with
		// a friendly error (and without an unhandled ChildProcess 'error' event).
		if (cmd.includes("/") || cmd.includes("\\") || cmd.startsWith(".")) {
			try {
				accessSync(cmd, fsConstants.X_OK);
			} catch {
				const cfgHint = meta?.configPath ? ` (config: ${meta.configPath})` : "";
				const msg = `${EXTENSION_ID} binary not found or not executable: ${cmd}${cfgHint}. Update your ${EXTENSION_ID} config and run /${EXTENSION_ID}-restart.`;
				this.unavailableReason = msg;
				ctx.ui.setStatus(extensionName, `${EXTENSION_ID} MCP: unavailable (binary not found)`);
				if (ctx.hasUI && this.lastFatalNotified !== msg) {
					ctx.ui.notify(msg, "error");
					this.lastFatalNotified = msg;
				}
				throw new Error(msg);
			}
		}

		const child = spawn(cmd, args, { stdio: "pipe", env });
		this.child = child;

		child.on("exit", (code, signal) => {
			const msg = `${EXTENSION_ID} MCP exited (code=${code}, signal=${signal ?? ""})`;
			this.rejectAllPending(new Error(msg));
			this.initialized = false;
			this.initInstructions = null;
			this.serverInfo = null;
			this.mcpTools = [];
			if (this.child === child) this.child = null;
			this.unavailableReason = msg;
			ctx.ui.setStatus(extensionName, `${EXTENSION_ID} MCP: disconnected`);
		});

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			// stderr is for debugging; keep it short in the footer.
			ctx.ui.setStatus(extensionName, `${EXTENSION_ID} stderr: ${String(chunk).trim().slice(0, 120)}`);
		});

		// If spawn fails (ENOENT, permissions, ...), Node emits an 'error' event on ChildProcess.
		// Attach a one-shot listener so it never becomes an unhandled event.
		try {
			await new Promise<void>((resolve, reject) => {
				const onSpawn = () => {
					child.off("error", onError);
					resolve();
				};
				const onError = (err: unknown) => {
					child.off("spawn", onSpawn);
					reject(err);
				};
				child.once("spawn", onSpawn);
				child.once("error", onError);
			});
		} catch (e: unknown) {
			this.handleChildFatal(e, ctx, cmd, meta?.configPath);
			throw e;
		}

		// Also handle any later process-level errors (rare, but don't crash the whole Pi session).
		child.on("error", (e: unknown) => this.handleChildFatal(e, ctx, cmd, meta?.configPath));

		try {
			await this.initialize(ctx);
			this.unavailableReason = null;
			this.lastFatalNotified = null;
		} catch (e: unknown) {
			this.handleChildFatal(e, ctx, cmd, meta?.configPath);
			throw e;
		}
	}

	stop() {
		if (!this.child) return;
		this.rejectAllPending(new Error(`${EXTENSION_ID} MCP stopped`));
		try {
			this.child.kill();
		} catch {
			// ignore
		}
		this.child = null;
		this.initialized = false;
		this.initInstructions = null;
		this.serverInfo = null;
		this.mcpTools = [];
	}

	private rejectAllPending(err: Error) {
		for (const { reject } of this.pending.values()) {
			reject(err);
		}
		this.pending.clear();
	}

	private handleChildFatal(err: unknown, ctx: ExtensionContext | null, cmd: string, configPath?: string) {
		const rec = isRecord(err) ? err : null;
		const code = rec?.["code"];
		const errno = rec?.["errno"];
		const base = rec && typeof rec["message"] === "string" ? String(rec["message"]) : toErrorMessage(err);

		let msg = base;
		if (code === "ENOENT" || errno === -2) {
			const cfgHint = configPath ? ` (config: ${configPath})` : "";
			msg = `${EXTENSION_ID} binary not found: ${cmd}${cfgHint}. Update your ${EXTENSION_ID} config and run /${EXTENSION_ID}-restart.`;
		}

		this.unavailableReason = msg;
		this.rejectAllPending(new Error(msg));

		try {
			this.child?.kill();
		} catch {
			// ignore
		}
		this.child = null;
		this.initialized = false;
		this.initInstructions = null;
		this.serverInfo = null;
		this.mcpTools = [];

		if (ctx?.hasUI) {
			ctx.ui.setStatus(extensionName, `${EXTENSION_ID} MCP: unavailable`);
			if (this.lastFatalNotified !== msg) {
				ctx.ui.notify(msg, "error");
				this.lastFatalNotified = msg;
			}
		}
	}

	private async initialize(ctx: ExtensionContext) {
		if (this.initialized) return;

		// Tell the server we support form-mode elicitation so it can request approvals.
		const initResult = await this.request<Record<string, unknown>>("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: { elicitation: { form: {} } },
			clientInfo: { name: "pi", version: extensionName },
		});

		this.initInstructions =
			isRecord(initResult) && typeof initResult["instructions"] === "string" ? initResult["instructions"] : null;

		const serverInfo = isRecord(initResult) ? initResult["serverInfo"] : null;
		this.serverInfo =
			isRecord(serverInfo)
				? {
					name: typeof serverInfo["name"] === "string" ? serverInfo["name"] : undefined,
					version: typeof serverInfo["version"] === "string" ? serverInfo["version"] : undefined,
				}
				: null;

		// MCP expects an "initialized" notification.
		await this.notify("initialized", {});

		this.initialized = true;
		this.mcpTools = await this.listTools();
		const si = this.serverInfo?.name ? `${this.serverInfo.name}${this.serverInfo.version ? " " + this.serverInfo.version : ""}` : `${EXTENSION_ID}`;
		ctx.ui.setStatus(extensionName, `${EXTENSION_ID} MCP: connected (${si}, ${this.mcpTools.length} tools)`);
	}

	getInstructions(): string | null {
		return this.initInstructions;
	}

	getServerInfo(): { name?: string; version?: string } | null {
		return this.serverInfo;
	}

	getTools(): McpTool[] {
		return this.mcpTools;
	}

	private async listTools(): Promise<McpTool[]> {
		try {
			const result = await this.request("tools/list", {});
			const tools = isRecord(result) ? result["tools"] : null;
			if (!Array.isArray(tools)) return [];
			return tools.flatMap((tool): McpTool[] => {
				if (!isRecord(tool) || typeof tool["name"] !== "string") return [];
				return [{
					name: tool["name"],
					description: typeof tool["description"] === "string" ? tool["description"] : undefined,
					inputSchema: isRecord(tool["inputSchema"]) ? tool["inputSchema"] : undefined,
					annotations: isRecord(tool["annotations"]) ? tool["annotations"] : undefined,
				}];
			});
		} catch {
			return [];
		}
	}

	getUnavailableReason(): string | null {
		return this.unavailableReason;
	}

	async request<TResult = unknown, TParams = unknown>(method: string, params?: TParams): Promise<TResult> {
		if (!this.child) throw new Error(`${EXTENSION_ID} MCP not running`);
		const id = this.nextId++;

		const req: JsonRpcRequest<TParams> = { jsonrpc: "2.0", id, method, params };
		const p = new Promise<TResult>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
		});

		this.child.stdin.write(JSON.stringify(req) + "\n");
		return p;
	}

	async notify<TParams = unknown>(method: string, params?: TParams): Promise<void> {
		if (!this.child) throw new Error(`${EXTENSION_ID} MCP not running`);
		const req: JsonRpcRequest<TParams> = { jsonrpc: "2.0", method, params };
		this.child.stdin.write(JSON.stringify(req) + "\n");
	}

	private async respond(id: JsonRpcId | null | undefined, result?: unknown, error?: { code: number; message: string; data?: unknown }) {
		if (!this.child) return;
		const resp: JsonRpcResponse = {
			jsonrpc: "2.0",
			id: id ?? null,
			...(error ? { error } : { result }),
		};
		this.child.stdin.write(JSON.stringify(resp) + "\n");
	}

	private onData(chunk: string) {
		this.buffer += chunk;
		while (true) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			this.onLine(line).catch(() => {
				// avoid unhandled promise rejections from async request handlers
			});
		}
	}

	private async onLine(line: string) {
		let msg: unknown;
		try {
			msg = JSON.parse(line) as unknown;
		} catch {
			return;
		}

		if (!isRecord(msg)) return;

		// Response?
		if ("id" in msg && !("method" in msg)) {
			const id = msg["id"];
			if (typeof id === "number" || typeof id === "string") {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);

				const err = msg["error"];
				if (isRecord(err) && typeof err["message"] === "string") {
					pending.reject(new Error(String(err["message"])));
				} else if (err) {
					pending.reject(new Error("MCP error"));
				} else {
					pending.resolve(msg["result"]);
				}
			}
			return;
		}

		// Server request?
		const method = msg["method"];
		if (typeof method === "string") {
			if (method === "elicitation/create") {
				await this.handleElicitationCreate(msg);
				return;
			}

			const id = msg["id"];
			await this.respond(typeof id === "number" || typeof id === "string" ? id : null, undefined, {
				code: -32601,
				message: `Method not found: ${method}`,
			});
			return;
		}
	}

	private parseElicitationMessage(message: string): { text: string; code: string | null } {
		// The server formats messages like:
		// `Mutating Extension execution requested.\n\nSession: ...\nCode preview:\n<code>`
		const lines = message.split("\n");
		const idx = lines.findIndex(
			(l) => l.trim().toLowerCase() === "code preview:" || l.trim().startsWith("Code preview:"),
		);
		if (idx === -1) return { text: message, code: null };

		const before = lines.slice(0, idx).join("\n").trimEnd();
		const code = lines.slice(idx + 1).join("\n").trimEnd();
		return { text: before, code: code.trim() ? code : null };
	}

	private async handleElicitationCreate(req: unknown) {
		const ctx = this.lastCtx;
		const reqId =
			isRecord(req) && (typeof req["id"] === "number" || typeof req["id"] === "string") ? (req["id"] as JsonRpcId) : null;
		const params = isRecord(req) ? req["params"] : null;
		const message: string =
			isRecord(params) && typeof params["message"] === "string" ? String(params["message"]) : "Mutating operation requested.";

		if (!ctx || !ctx.hasUI) {
			await this.respond(reqId, undefined, { code: -32603, message: "No UI available for elicitation" });
			return;
		}

		// Custom dialog with formatted message + highlighted Extension code preview.
		const mdTheme = getMarkdownTheme();
		const parsedMsg = this.parseElicitationMessage(message);
		const codeForPanels = this.getPendingMutatingCode() ?? parsedMsg.code;

		// Emit a Pi inter-extension event so other extensions (e.g. a terminal notifier)
		// can react to approval prompts.
		try {
			this._pi.events.emit(`${EXTENSION_ID}:elicitation`, {
				phase: "create",
				requestId: reqId,
				message: parsedMsg.text,
				hasCodePreview: !!codeForPanels,
			});
		} catch {
			// ignore: events are optional
		}

		const items: Array<SelectItem & { value: "approve" | "reject" }> = [
			{ value: "approve", label: "Yes (Approve)" },
			{ value: "reject", label: "No" },
		];

		const choice = await ctx.ui.custom<"approve" | "reject" | null>((tui, theme, _kb, done) => {
			let codeOverlayOpen = false;
			const openCodeOverlay = () => {
				if (!codeForPanels || codeOverlayOpen) return;
				codeOverlayOpen = true;

				const code = codeForPanels;
				const border = (s: string) => theme.fg("mdCodeBlockBorder", s);
				let scroll = 0;
				let lastBodyHeight = 20;

				const overlay = {
					invalidate() {},
					render(width: number): string[] {
						const inner = Math.max(1, width - 2);
						const top = border("┌" + "─".repeat(inner) + "┐");
						const bottom = border("└" + "─".repeat(inner) + "┘");

						const highlighted = highlightCode(code);
						const rawLines = Array.isArray(highlighted)
							? highlighted
							: String(highlighted ?? "").split("\n");

						// Compute body height based on terminal size (overlayOptions will still crop if needed)
						lastBodyHeight = Math.max(8, Math.min(60, tui.terminal.rows - 10));
						const maxScroll = Math.max(0, rawLines.length - lastBodyHeight);
						scroll = Math.max(0, Math.min(scroll, maxScroll));
						const viewLines = rawLines.slice(scroll, scroll + lastBodyHeight);

						const body = viewLines.map((l) => {
							const truncated = truncateToWidth(l, inner, "");
							const pad = Math.max(0, inner - visibleWidth(truncated));
							return border("│") + truncated + " ".repeat(pad) + border("│");
						});

						const info = theme.fg(
							"dim",
							`lines ${rawLines.length ? scroll + 1 : 0}-${Math.min(rawLines.length, scroll + lastBodyHeight)} of ${rawLines.length}  •  ↑↓ scroll  PgUp/PgDn  •  esc/ctrl+o close`,
						);

						return [
							theme.fg("accent", theme.bold("Code preview (full)")),
							"",
							top,
							...body,
							bottom,
							"",
							info,
						];
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o")) {
							codeOverlayOpen = false;
							tui.hideOverlay();
							return;
						}

						if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
						else if (matchesKey(data, "down")) scroll = scroll + 1;
						else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - lastBodyHeight);
						else if (matchesKey(data, "pageDown")) scroll = scroll + lastBodyHeight;
						else if (matchesKey(data, "home")) scroll = 0;
						else if (matchesKey(data, "end")) scroll = 1e9;
					},
				};

				tui.showOverlay(overlay, { width: "90%", maxHeight: "90%", minWidth: 60, margin: 1 });
			};

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`${EXTENSION_ID}: approve mutating operation?`)), 1, 0));

			// Message (without code)
			container.addChild(new Markdown(parsedMsg.text, 1, 0, mdTheme));

			// Code panel (preview). Ctrl+o opens a scrollable full preview.
			if (codeForPanels) {
				container.addChild(new Text(theme.fg("muted", "Code preview:"), 1, 0));
				const code = codeForPanels;
				const border = (s: string) => theme.fg("mdCodeBlockBorder", s);
				const maxPreviewLines = 12;
				let previewWasTruncated = false;

				const codePanel = {
					invalidate() {
						previewWasTruncated = false;
					},
					render(width: number): string[] {
						const inner = Math.max(1, width - 2);
						const top = border("┌" + "─".repeat(inner) + "┐");
						const bottom = border("└" + "─".repeat(inner) + "┘");

						const highlighted = highlightCode(code);
						const rawLines = Array.isArray(highlighted)
							? highlighted
							: String(highlighted ?? "").split("\n");

						previewWasTruncated = rawLines.length > maxPreviewLines;
						const viewLines = previewWasTruncated ? rawLines.slice(0, maxPreviewLines) : rawLines;

						const body = viewLines.map((l) => {
							const truncated = truncateToWidth(l, inner, "");
							const pad = Math.max(0, inner - visibleWidth(truncated));
							return border("│") + truncated + " ".repeat(pad) + border("│");
						});

						return [top, ...body, bottom];
					},
				};
				container.addChild(codePanel);

				const truncInfo = {
					invalidate() {},
					render(_width: number): string[] {
						return previewWasTruncated ? [theme.fg("dim", "Ctrl+o to view full code") ] : [];
					},
				};
				container.addChild(truncInfo);
			}

			const selectList = new SelectList(items, items.length, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value as "approve" | "reject");
			selectList.onCancel = () => done(null);
			container.addChild(selectList);

			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel • ctrl+o code"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, "ctrl+o")) {
						openCodeOverlay();
						return;
					}
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		const emitResolve = (decision: "approve" | "reject" | "cancel") => {
			try {
				this._pi.events.emit(`${EXTENSION_ID}:elicitation`, {
					phase: "resolve",
					requestId: reqId,
					decision,
				});
			} catch {
				// ignore
			}
		};

		if (choice === "approve") {
			emitResolve("approve");
			await this.respond(reqId, { action: "accept", content: { decision: "Approve" } });
			return;
		}

		if (choice === "reject") {
			emitResolve("reject");
			await this.respond(reqId, { action: "decline" });
			return;
		}

		// Esc/cancel
		emitResolve("cancel");
		await this.respond(reqId, { action: "cancel" });
	}
}

function extractTextContent(toolResult: unknown): string {
	if (!isRecord(toolResult)) return "";
	const content = toolResult["content"];
	if (!Array.isArray(content) || content.length === 0) return "";

	const first = content.find((c) => isRecord(c) && c["type"] === "text");
	if (!isRecord(first)) return "";
	const text = first["text"];
	return typeof text === "string" ? text : "";
}

const toolSchema = Type.Object({
	code: Type.String({ description: "Code to execute" }),
	timeout_ms: Type.Optional(Type.Integer({ description: "Optional per-call execution timeout in milliseconds" })),
	session_id: Type.Optional(Type.String({ description: "Optional session identifier for state reuse" })),
});

type McpToolArgs = {
	code: string;
	timeout_ms?: number;
	session_id?: string;
};

type ToolRenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: NodeJS.Timeout;
};

type ToolRenderContext = {
	state: ToolRenderState;
	invalidate: () => void;
	executionStarted: boolean;
	isPartial: boolean;
	isError: boolean;
};

export default function (pi: ExtensionAPI) {
	pi.registerFlag(`${EXTENSION_ID}-config`, {
		description: `Path to ${EXTENSION_ID} MCP config JSON (default: ${DEFAULT_CONFIG_PATH})`,
		type: "string",
		default: DEFAULT_CONFIG_PATH,
	});

	const client = new McpStdioClient(pi);
	let config: McpConfig | null = null;
	let configPathUsed: string | null = null;
	let currentSessionId: string | null = null;
	let serverInstructions: string | null = null;
	const registeredToolNames = new Set<string>();

	// Controls how much code we show in the read-only tool call renderer.
	// Toggled via the preview command.
	let showReadOnlyFullPreview = false;

	// Controls whether the *UI* shows tool results/output.
	// The model always receives full tool results; this only affects interactive rendering.
	// Toggled via the result command.
	let showToolResultsInUI = false;

	async function ensureStarted(ctx: ExtensionContext) {
		if (!config) {
			const path = String(pi.getFlag(`${EXTENSION_ID}-config`) ?? DEFAULT_CONFIG_PATH);
			if (expandHome(path) === DEFAULT_CONFIG_PATH) ensureDefaultConfig();
			configPathUsed = path;
			config = loadConfig(path);
		}
		await client.start(config, ctx, { configPath: configPathUsed ?? undefined });
		serverInstructions = client.getInstructions();
	}

	const isMutatingMcpTool = (tool: McpTool): boolean => {
		const readOnlyHint = tool.annotations?.["readOnlyHint"];
		if (readOnlyHint === true) return false;
		if (readOnlyHint === false) return true;

		const text = `${tool.name}\n${tool.description ?? ""}`.toLowerCase();
		if (text.includes("read-only") || text.includes("readonly")) return false;
		return text.includes("mutating") || text.includes("mutation") || text.includes("write") || text.includes("modify");
	};

	const registerMcpTools = (ctx: ExtensionContext) => {
		const tools = client.getTools();
		if (tools.length === 0) {
			ctx.ui.notify(`${EXTENSION_ID} MCP did not advertise any tools via tools/list`, "warning");
			return;
		}

		for (const tool of tools) {
			if (registeredToolNames.has(tool.name)) continue;
			registeredToolNames.add(tool.name);
			const isMutating = isMutatingMcpTool(tool);
			pi.registerTool({
				name: tool.name,
				label: tool.name,
				description:
					tool.description ??
					`Execute code${isMutating ? " with mutating operations" : ""} through the MCP server.`,
				parameters: (tool.inputSchema ?? toolSchema) as typeof toolSchema,
				execute: async (_id, params, _signal, _onUpdate, execCtx) =>
					callMcpTool(tool.name, params as McpToolArgs, execCtx, isMutating),
				renderCall: (args, theme, context) =>
					isMutating
						? renderToolCallFull(tool.name, args, theme, context)
						: renderToolCallReadOnly(tool.name, args, theme, context),
				renderResult: (result, _options, theme) => renderToolResult(result, theme),
			});
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureStarted(ctx);
			registerMcpTools(ctx);
		} catch (e: unknown) {
			const msg = toErrorMessage(e);
			// client.start() already notifies for common spawn errors (ENOENT, permissions, ...).
			if (!client.getUnavailableReason()) {
				ctx.ui.notify(`${EXTENSION_ID} MCP init failed: ${msg}`, "error");
			}
		}
	});

	// Inject server initialize.instructions into model context by appending them to the system prompt.
	pi.on("before_agent_start", async (event) => {
		if (!serverInstructions || !serverInstructions.trim()) return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n" +
				`# ${EXTENSION_ID} MCP server instructions (from initialize)\n` +
				serverInstructions.trim() +
				"\n",
		};
	});

	pi.on("session_shutdown", async () => {
		client.stop();
	});

	pi.registerCommand(`${EXTENSION_ID}-session`, {
		description: `Show current ${EXTENSION_ID} session id`,
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${EXTENSION_ID} session_id: ${currentSessionId ?? "(none yet)"}`, "info");
		},
	});

	pi.registerCommand(`${EXTENSION_ID}-restart`, {
		description: `Restart ${EXTENSION_ID} MCP process (drops in-memory state)`,
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm(
				`Restart ${EXTENSION_ID} MCP?`,
				`This will restart the ${EXTENSION_ID} MCP process and lose in-memory session state.`,
			);
			if (!ok) return;
			client.stop();
			config = null;
			configPathUsed = null;
			currentSessionId = null;
			try {
				await ensureStarted(ctx);
				registerMcpTools(ctx);
			} catch (e: unknown) {
				const msg = toErrorMessage(e);
				if (!client.getUnavailableReason()) {
					ctx.ui.notify(`${EXTENSION_ID} restart failed: ${msg}`, "error");
				}
			}
		},
	});

	const toggleReadOnlyPreview = (ctx: ExtensionContext) => {
		showReadOnlyFullPreview = !showReadOnlyFullPreview;
		ctx.ui.notify(
			`${EXTENSION_ID} read-only tool preview: ${showReadOnlyFullPreview ? "full" : "truncated"}`,
			"info",
		);
	};

	pi.registerCommand(`${EXTENSION_ID}-toggle-preview`, {
		description: `Toggle ${EXTENSION_ID} read-only tool-call preview between truncated and full`,
		handler: async (_args, ctx) => toggleReadOnlyPreview(ctx),
	});

	pi.registerCommand(`${EXTENSION_ID}-toggle-result`, {
		description: `Toggle whether the UI shows ${EXTENSION_ID} tool results/output (model always receives full results)`,
		handler: async (_args, ctx) => {
			showToolResultsInUI = !showToolResultsInUI;
			ctx.ui.notify(`${EXTENSION_ID} tool results (UI): ${showToolResultsInUI ? "shown" : "suppressed"}`, "info");
		},
	});

	async function callMcpTool(
		toolName: string,
		params: McpToolArgs,
		ctx: ExtensionContext,
		isMutating: boolean,
	): Promise<AgentToolResult<unknown>> {
		try {
			await ensureStarted(ctx);
		} catch (e: unknown) {
			const msg = toErrorMessage(e);
			const reason = client.getUnavailableReason() ?? msg;
			const rawText = JSON.stringify({ session_id: currentSessionId ?? "", error: reason });
			return {
				content: [{ type: "text", text: `error: ${reason}` }],
				details: {
					mcp: {
						toolName,
						session_id: currentSessionId,
						rawText,
					},
				},
			};
		}
		client.setContext(ctx);

		const args: McpToolArgs = { ...params };
		// auto-inject session_id if not provided
		if (!args.session_id && currentSessionId) args.session_id = currentSessionId;

		// The server only includes a truncated code summary in elicitation.message; keep the full code around
		// while the mutating call is in-flight so the approval UI can show it.
		if (isMutating) {
			client.setPendingMutatingCode(args.code);
		}

		let result: unknown;
		try {
			result = await client.request("tools/call", { name: toolName, arguments: args });
		} finally {
			if (isMutating) {
				client.setPendingMutatingCode(null);
			}
		}

		const text = extractTextContent(result);
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(text) as unknown;
			if (isRecord(parsed) && typeof parsed["session_id"] === "string") {
				currentSessionId = String(parsed["session_id"]);
			}
		} catch {
			// ignore
		}

		// Friendly summary for the model.
		// NOTE: UI suppression is handled via renderResult().
		// Also: avoid echoing tool *input code* back to the model via output, since the tool call already shows it.
		let summary = "";
		if (isRecord(parsed)) {
			summary += `session_id: ${typeof parsed["session_id"] === "string" ? parsed["session_id"] : ""}`;
			if (parsed["warnings"] !== undefined) summary += `\nwarnings: ${JSON.stringify(parsed["warnings"])}`;
			if (parsed["confirmation"] !== undefined)
				summary += `\nconfirmation: ${JSON.stringify(parsed["confirmation"])}`;
			if (parsed["error"] !== undefined) summary += `\nerror: ${String(parsed["error"])}`;

			// Some backends may include a markdown echo of the executed code in `output`.
			// That is redundant (the tool call already renders the code nicely), and it can cause the LLM
			// to re-print the same code block in its response.
			if (parsed["output"] !== undefined && parsed["output"] !== null) {
				const outStr = String(parsed["output"]);
				const looksLikeCodeEcho = args.code.trim().length > 0 && outStr.includes(args.code.trim());
				if (!looksLikeCodeEcho) {
					summary += `\n\noutput:\n${outStr}`;
				}
			}

			if (parsed["result"] !== undefined) {
				summary += `\n\nresult:\n${JSON.stringify(parsed["result"], null, 2)}`;
			}
		} else {
			summary = text;
		}

		return {
			content: [{ type: "text", text: summary || text }],
			details: {
				mcp: {
					toolName,
					session_id: currentSessionId,
					rawText: text,
				},
			},
		};
	}

	const formatDuration = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

	const syncToolCallTiming = (state: ToolRenderState, context: ToolRenderContext) => {
		if (context.executionStarted && state.startedAt === undefined) {
			state.startedAt = Date.now();
			state.endedAt = undefined;
		}

		if (state.startedAt !== undefined && context.executionStarted && context.isPartial && !state.interval) {
			state.interval = setInterval(() => context.invalidate(), 1000);
		}

		if (state.startedAt !== undefined && (!context.isPartial || context.isError)) {
			state.endedAt ??= Date.now();
			if (state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}
		}
	};

	const getToolCallTimingLine = (theme: Theme, state: ToolRenderState, context: ToolRenderContext) => {
		if (state.startedAt === undefined) return null;
		const label = context.isPartial && !context.isError ? "Elapsed" : "Took";
		const endTime = state.endedAt ?? Date.now();
		return theme.fg("muted", `${label} ${formatDuration(endTime - state.startedAt)}`);
	};

	const getToolCallHeader = (toolName: string, args: unknown, theme: Theme) => {
		const argRec = isRecord(args) ? args : {};
		const sessionId = typeof argRec["session_id"] === "string" ? argRec["session_id"] : null;
		const session = sessionId ? `session_id=${sessionId}` : "session_id=(auto)";
		const timeoutMs = argRec["timeout_ms"];
		const timeout = typeof timeoutMs === "number" ? `timeout_ms=${timeoutMs}` : undefined;

		let header = theme.fg("toolTitle", theme.bold(toolName));
		header += " " + theme.fg("muted", session);
		if (timeout) header += " " + theme.fg("muted", timeout);
		return header;
	};

	const renderToolCallFull = (
		toolName: string,
		args: unknown,
		theme: Theme,
		context: ToolRenderContext,
	) => {
		const state = context.state;
		syncToolCallTiming(state, context);

		const header = getToolCallHeader(toolName, args, theme);
		const argRec = isRecord(args) ? args : {};
		const code = typeof argRec["code"] === "string" ? argRec["code"] : "";
		const border = (s: string) => theme.fg("mdCodeBlockBorder", s);

		return {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [header];

				if (!code.trim()) {
					lines.push(theme.fg("dim", "(no code)"));
				} else {
					const inner = Math.max(1, width - 2);
					const top = border("┌" + "─".repeat(inner) + "┐");
					const bottom = border("└" + "─".repeat(inner) + "┘");

					const highlighted = highlightCode(code);
					const rawLines = Array.isArray(highlighted)
						? highlighted
						: String(highlighted ?? "").split("\n");

					lines.push(top);
					for (const l of rawLines) {
						const truncated = truncateToWidth(l, inner, "");
						const pad = Math.max(0, inner - visibleWidth(truncated));
						lines.push(border("│") + truncated + " ".repeat(pad) + border("│"));
					}
					lines.push(bottom);
				}

				const timing = getToolCallTimingLine(theme, state, context);
				if (timing) lines.push(timing);

				return lines;
			},
		};
	};

	const renderToolCallReadOnly = (
		toolName: string,
		args: unknown,
		theme: Theme,
		context: ToolRenderContext,
	) => {
		const state = context.state;
		syncToolCallTiming(state, context);

		const header = getToolCallHeader(toolName, args, theme);
		const argRec = isRecord(args) ? args : {};
		const code = typeof argRec["code"] === "string" ? argRec["code"] : "";
		const border = (s: string) => theme.fg("mdCodeBlockBorder", s);
		const maxPreviewLines = 18;

		return {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [header];

				if (!code.trim()) {
					lines.push(theme.fg("dim", "(no code)"));
				} else {
					const expanded = showReadOnlyFullPreview;
					const inner = Math.max(1, width - 2);
					const top = border("┌" + "─".repeat(inner) + "┐");
					const bottom = border("└" + "─".repeat(inner) + "┘");

					const highlighted = highlightCode(code);
					const rawLines = Array.isArray(highlighted)
						? highlighted
						: String(highlighted ?? "").split("\n");

					const previewWasTruncated = rawLines.length > maxPreviewLines;
					const viewLines = expanded ? rawLines : rawLines.slice(0, maxPreviewLines);

					lines.push(top);
					for (const l of viewLines) {
						const truncated = truncateToWidth(l, inner, "");
						const pad = Math.max(0, inner - visibleWidth(truncated));
						lines.push(border("│") + truncated + " ".repeat(pad) + border("│"));
					}
					lines.push(bottom);

					if (previewWasTruncated) {
						lines.push(
							theme.fg(
								"dim",
								expanded
									? `Preview: full (run /${EXTENSION_ID}-toggle-preview to collapse)`
									: `Preview: truncated (run /${EXTENSION_ID}-toggle-preview to expand)`,
							),
						);
					}
				}

				const timing = getToolCallTimingLine(theme, state, context);
				if (timing) lines.push(timing);

				return lines;
			},
		};
	};

	const renderToolResult = (result: unknown, _theme: Theme) => {
		const rawText =
			isRecord(result) &&
			isRecord(result["details"]) &&
			isRecord(result["details"]["mcp"])
				? result["details"]["mcp"]["rawText"]
				: undefined;

		let parsed: unknown = null;
		if (typeof rawText === "string") {
			try {
				parsed = JSON.parse(rawText) as unknown;
			} catch {
				parsed = null;
			}
		}

		const describeValue = (v: unknown): string => {
			if (v === null) return "null";
			if (Array.isArray(v)) return `array(${v.length})`;
			if (typeof v === "object") return `object(${Object.keys(v as object).length} keys)`;
			if (typeof v === "string") return `string(${v.length} chars)`;
			return typeof v;
		};

		const buildText = () => {
			if (!isRecord(parsed)) {
				return extractTextContent(result) || (typeof rawText === "string" ? rawText : "");
			}

			let txt = "";
			txt += `session_id: ${typeof parsed["session_id"] === "string" ? parsed["session_id"] : ""}`;
			if (parsed["warnings"] !== undefined) txt += `\nwarnings: ${JSON.stringify(parsed["warnings"])}`;
			if (parsed["confirmation"] !== undefined)
				txt += `\nconfirmation: ${JSON.stringify(parsed["confirmation"])}`;
			if (parsed["error"] !== undefined) txt += `\nerror: ${String(parsed["error"])}`;

			if (showToolResultsInUI) {
				if (parsed["output"] !== undefined) txt += `\n\noutput:\n${String(parsed["output"])}`;
				if (parsed["result"] !== undefined) txt += `\n\nresult:\n${JSON.stringify(parsed["result"], null, 2)}`;
				if (parsed["output"] !== undefined || parsed["result"] !== undefined) {
					txt += `\n\n(run /${EXTENSION_ID}-toggle-result to hide)`;
				}
				return txt;
			}

			const suppressed: string[] = [];
			if (parsed["output"] !== undefined) suppressed.push(`output ${describeValue(parsed["output"])}`);
			if (parsed["result"] !== undefined) suppressed.push(`result ${describeValue(parsed["result"])}`);
			if (suppressed.length > 0) {
				txt += `\n\n(suppressed: ${suppressed.join(", ")}; run /${EXTENSION_ID}-toggle-result to show)`;
			}
			return txt;
		};

		return {
			invalidate() {},
			render(width: number): string[] {
				return new Text(buildText(), 0, 0).render(width);
			},
		};
	};

}
