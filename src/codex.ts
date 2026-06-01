import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { getConfig } from "./config.ts";

type ChatSession = {
  chatId: string;
  threadId?: string;
  workspaceDir: string;
  updatedAt: string;
};

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CodexProgressEvent = {
  type: "started" | "completed" | "info";
  summary: string;
  detail?: string;
  rawType?: string;
};

export type CodexIntentClassification = {
  intent: "chat" | "task" | "confirm";
  reason: string;
  taskText?: string;
};

type RunCodexOptions = {
  onProgress?: (event: CodexProgressEvent) => void;
  onJsonEvent?: (event: any) => void;
  timeoutMs?: number;
  killOnTimeout?: boolean;
};

const STATE_DIR = resolve(process.cwd(), ".bridge-state");
const SESSION_FILE = join(STATE_DIR, "sessions.json");
const WINDOWS_CODEX_COMMANDS = [
  join(process.cwd(), "codex-bin", "codex.exe"),
  "C:\\Program Files\\nodejs\\codex.cmd",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe") : "",
];
const DEFAULT_CODEX_COMMAND =
  process.platform === "win32"
    ? WINDOWS_CODEX_COMMANDS.find((path) => path && existsSync(path)) ?? "codex"
    : "codex";

const chatSessions = loadSessions();

function quoteWindowsArg(value: string): string {
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function loadSessions(): Map<string, ChatSession> {
  const files = [SESSION_FILE, `${SESSION_FILE}.bak`];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as { sessions?: ChatSession[] };
      const sessions = (raw.sessions ?? []).filter((session) => session.chatId && session.workspaceDir);
      if (sessions.length > 0) return new Map(sessions.map((session) => [session.chatId, session]));
    } catch {}
  }
  return new Map();
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(STATE_DIR, { recursive: true });
  if (existsSync(path)) {
    await copyFile(path, `${path}.bak`).catch(() => {});
  }
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await rename(tmp, path);
}

async function saveSessions() {
  try {
    await writeJsonAtomic(SESSION_FILE, { sessions: [...chatSessions.values()] });
  } catch (err) {
    console.error(`[Codex] Cannot save sessions: ${(err as Error).message}`);
  }
}

function getCodexEnv() {
  const env = { ...process.env };
  const pathExtra = getConfig().pathExtra;
  const currentPath = env.PATH ?? env.Path ?? "";
  if (pathExtra) {
    env.PATH = `${pathExtra}${delimiter}${currentPath}`;
    env.Path = env.PATH;
  } else if (currentPath) {
    env.PATH = currentPath;
    env.Path = currentPath;
  }
  return env;
}

function getCodexCommand(): string {
  const command = getConfig().codexCommand || DEFAULT_CODEX_COMMAND;
  if (/^[A-Za-z]:[\\/]/.test(command) || command.startsWith("\\\\")) return command;
  if (/[\\/]/.test(command)) return resolve(process.cwd(), command);
  return command;
}

function sanitizeProgressText(value: string): string {
  return value
    .replace(/((?:secret|token|key|password|authorization)\s*[:=]\s*)[^\s"',;}]+/gi, "$1***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeToolArgs(args: unknown): string | undefined {
  const parsed = parseMaybeJson(args);
  if (!parsed) return undefined;
  if (typeof parsed === "string") return sanitizeProgressText(parsed);
  if (typeof parsed !== "object") return undefined;

  const record = parsed as Record<string, unknown>;
  const interesting = record.command ?? record.cmd ?? record.path ?? record.file ?? record.url ?? record.query;
  if (typeof interesting === "string") return sanitizeProgressText(interesting);
  return sanitizeProgressText(JSON.stringify(record));
}

function extractVisibleMessageText(item: any): string | undefined {
  const candidates = [
    item?.text,
    item?.message,
    item?.content,
    item?.output,
    item?.data?.text,
    item?.data?.content,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return sanitizeProgressText(candidate);
    if (Array.isArray(candidate)) {
      const text = candidate
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          if (typeof part?.content === "string") return part.content;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      if (text.trim()) return sanitizeProgressText(text);
    }
  }

  return undefined;
}

function extractCodexProgress(event: any): CodexProgressEvent | undefined {
  const rawType = String(event?.type ?? event?.event ?? "");
  const normalizedType = rawType.replace(/_/g, ".");
  const item = event?.item ?? event?.data?.item ?? event?.payload?.item;
  const itemType = String(item?.type ?? event?.item_type ?? "");
  const toolName = item?.name ?? item?.tool_name ?? item?.function?.name ?? event?.name;
  const detail = summarizeToolArgs(item?.arguments ?? item?.args ?? event?.arguments);

  if (normalizedType === "thread.started") {
    return { type: "started", summary: "Codex 会话已建立", rawType };
  }
  if (normalizedType === "turn.started" || normalizedType === "task.started") {
    return { type: "started", summary: "Codex 已开始处理任务", rawType };
  }

  if (normalizedType === "item.started") {
    if (itemType.includes("tool") || itemType.includes("function")) {
      return {
        type: "started",
        summary: `正在执行工具: ${toolName || "unknown"}`,
        detail,
        rawType,
      };
    }
    if (itemType.includes("message")) return { type: "started", summary: "正在整理回复", rawType };
    if (itemType.includes("reasoning")) return { type: "info", summary: "正在分析任务", rawType };
  }

  if (normalizedType === "item.completed") {
    if (itemType.includes("tool") || itemType.includes("function")) {
      return {
        type: "completed",
        summary: `已完成工具: ${toolName || "unknown"}`,
        detail,
        rawType,
      };
    }
    if (itemType.includes("message")) {
      const text = extractVisibleMessageText(item);
      return { type: "completed", summary: "Codex 阶段说明", detail: text, rawType };
    }
  }

  if (normalizedType === "error") {
    return { type: "info", summary: "Codex 返回错误事件", detail: sanitizeProgressText(JSON.stringify(event)), rawType };
  }

  return undefined;
}

function emitProgressLine(line: string, options: RunCodexOptions = {}) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  try {
    const event = JSON.parse(trimmed);
    options.onJsonEvent?.(event);
    const progress = extractCodexProgress(event);
    if (progress) options.onProgress?.(progress);
  } catch {}
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    });
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {}
}

function runCodex(args: string[], stdin: string, timeoutMs: number, cwd: string, options: RunCodexOptions = {}): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stdoutLineBuffer = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let killFallback: NodeJS.Timeout | undefined;
    const startedAt = Date.now();
    let lastActivityAt = Date.now();
    const codexCommand = getCodexCommand();

    const command = process.platform === "win32" ? "cmd.exe" : codexCommand;
    const commandArgs =
      process.platform === "win32"
        ? ["/d", "/c", ["call", codexCommand, ...args].map(quoteWindowsArg).join(" ")]
        : args;

    const child = spawn(command, commandArgs, {
      cwd,
      env: getCodexEnv(),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (killFallback) clearTimeout(killFallback);
      resolveResult(result);
    };

    const runtimeText = () => {
      const elapsedMs = Date.now() - startedAt;
      const idleMs = Date.now() - lastActivityAt;
      return `已运行 ${Math.floor(elapsedMs / 60000)}分${Math.floor((elapsedMs % 60000) / 1000)}秒，最近 ${Math.floor(idleMs / 1000)}秒无新输出`;
    };

    const resetIdleTimer = () => {
      lastActivityAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const idleMs = Date.now() - lastActivityAt;
        if (options.killOnTimeout === false) {
          options.onProgress?.({
            type: "info",
            summary: "Codex 仍在运行，等待下一步输出",
            detail: runtimeText(),
          });
          resetIdleTimer();
          return;
        }
        timedOut = true;
        stderr = `${stderr}\nCodex idle timeout after ${idleMs}ms without output`.trim();
        terminateProcessTree(child);
        killFallback = setTimeout(() => {
          finish({ code: null, stdout, stderr, timedOut });
        }, 5000);
      }, timeoutMs);
    };

    resetIdleTimer();

    const markActivity = () => {
      if (!settled && !timedOut) resetIdleTimer();
    };

    child.on("spawn", markActivity);

    child.stdout.on("data", (chunk) => {
      markActivity();
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) emitProgressLine(line, options);
    });
    child.stderr.on("data", (chunk) => {
      markActivity();
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({ code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on("close", (code) => {
      if (stdoutLineBuffer.trim()) emitProgressLine(stdoutLineBuffer, options);
      finish({ code, stdout, stderr, timedOut });
    });

    child.stdin.end(stdin);
  });
}

function getChatSession(chatId: string): ChatSession {
  const existing = chatSessions.get(chatId);
  if (existing) return existing;
  const session: ChatSession = {
    chatId,
    workspaceDir: getConfig().defaultWorkspaceDir,
    updatedAt: new Date().toISOString(),
  };
  chatSessions.set(chatId, session);
  return session;
}

function buildCodexArgs(session: ChatSession, outFile: string): string[] {
  const config = getConfig();
  const baseArgs = config.codexDisableSandbox
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["--ask-for-approval", config.codexApprovalPolicy];

  if (session.threadId) {
    const args = [
      ...baseArgs,
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--output-last-message",
      outFile,
    ];
    if (config.codexModel) args.push("--model", config.codexModel);
    args.push(session.threadId, "-");
    return args;
  }

  const args = [
    ...baseArgs,
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--cd",
    session.workspaceDir,
    "--output-last-message",
    outFile,
  ];
  if (config.codexModel) args.push("--model", config.codexModel);
  args.push("-");
  return args;
}

function parseJsonEvents(stdout: string): { threadId?: string; lastMessage?: string } {
  let threadId: string | undefined;
  let lastMessage: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as any;
      if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        lastMessage = event.item.text;
      }
    } catch {}
  }
  return { threadId, lastMessage };
}

function isStaleThreadResumeError(result: ProcessResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return /thread\/resume failed|no rollout found|stale rollout path|stale_db_path/i.test(text);
}

function extractJsonObject(value: string): Record<string, unknown> | undefined {
  const clean = value.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {}

  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {}
  }
  return undefined;
}

function normalizeIntentClassification(value: string, fallbackMessage: string): CodexIntentClassification | null {
  const parsed = extractJsonObject(value);
  if (!parsed) return null;
  const rawIntent = String(parsed.intent ?? "").toLowerCase();
  if (!["chat", "task", "confirm"].includes(rawIntent)) return null;
  const taskText = typeof parsed.taskText === "string" && parsed.taskText.trim() ? parsed.taskText.trim() : fallbackMessage;
  return {
    intent: rawIntent as "chat" | "task" | "confirm",
    reason: typeof parsed.reason === "string" ? sanitizeProgressText(parsed.reason) : "",
    taskText,
  };
}

function shouldReturnDecisionPlan(message: string): boolean {
  return /决策|我来决策|需要确认|需要我确认|所有需要决策|先问我|不要擅自/.test(message);
}

function buildBridgePrompt(workspaceDir: string, message: string): string {
  const lines = [
    "你是通过飞书机器人转发调用的本地 Codex。",
    "默认用中文回复，只输出可以直接发给用户的最终结果，不输出内部推理过程。",
    `当前工作区: ${workspaceDir}`,
  ];

  if (shouldReturnDecisionPlan(message)) {
    lines.push(
      "这条消息包含用户决策要求。先把任务拆成可执行步骤，并列出必须由用户确认的决策项、推荐选项和默认建议；不要直接启动长时间执行。"
    );
  }

  lines.push(`用户消息:\n${message}`);
  return lines.join("\n\n");
}

async function runCodexExec(
  session: ChatSession,
  message: string,
  options: RunCodexOptions = {},
  retryOnStaleThread = true
): Promise<string> {
  const config = getConfig();
  const workspaceDir = resolve(session.workspaceDir || config.defaultWorkspaceDir);
  await mkdir(workspaceDir, { recursive: true });

  const outDir = join(STATE_DIR, "last-messages");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);

  const prompt = buildBridgePrompt(workspaceDir, message);
  let sessionSavePromise: Promise<void> = Promise.resolve();
  const runOptions: RunCodexOptions = {
    ...options,
    killOnTimeout: false,
    onJsonEvent: (event) => {
      options.onJsonEvent?.(event);
      if (event?.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
        session.threadId = event.thread_id;
        session.workspaceDir = workspaceDir;
        session.updatedAt = new Date().toISOString();
        sessionSavePromise = sessionSavePromise.then(() => saveSessions());
      }
    },
  };

  const result = await runCodex(
    buildCodexArgs({ ...session, workspaceDir }, outFile),
    prompt,
    options.timeoutMs ?? config.codexTimeoutMs,
    workspaceDir,
    runOptions
  );
  await sessionSavePromise;
  const output = await readFile(outFile, "utf-8").catch(() => "");
  await rm(outFile, { force: true }).catch(() => {});

  const events = parseJsonEvents(result.stdout);
  if (events.threadId) session.threadId = events.threadId;
  session.workspaceDir = workspaceDir;
  session.updatedAt = new Date().toISOString();
  await saveSessions();

  if (retryOnStaleThread && result.code !== 0 && isStaleThreadResumeError(result)) {
    const staleThreadId = session.threadId;
    delete session.threadId;
    session.updatedAt = new Date().toISOString();
    await saveSessions();
    console.warn(`[Codex] stale thread cleared, retrying with a new session: ${staleThreadId ?? "(unknown)"}`);
    options.onProgress?.({
      type: "info",
      summary: "Codex 会话已失效，正在新建会话重试",
      detail: staleThreadId ? `旧会话 ${staleThreadId} 已清理` : "旧会话已清理",
    });
    return runCodexExec(session, message, options, false);
  }

  if (result.timedOut) {
    const timeoutDetail = (result.stderr || result.stdout).trim();
    throw new Error(timeoutDetail || `Codex idle timeout after ${options.timeoutMs ?? config.codexTimeoutMs}ms without output`);
  }
  if (result.code !== 0 && !output.trim() && !events.lastMessage?.trim()) {
    throw new Error((result.stderr || result.stdout || `Codex exited with ${result.code}`).trim());
  }

  return (output || events.lastMessage || result.stdout).trim() || "(Codex 无响应)";
}

export async function initCodex(): Promise<boolean> {
  try {
    const workspaceDir = resolve(getConfig().defaultWorkspaceDir);
    await mkdir(workspaceDir, { recursive: true });
    const result = await runCodex(["--version"], "", 15000, workspaceDir);
    const version = (result.stdout || result.stderr).trim();
    if (result.code !== 0 || !version) {
      throw new Error(result.stderr || "codex command returned no version");
    }
    console.log(`[Codex] ${version}`);
    console.log(`[Codex] Default workspace: ${workspaceDir}`);
    return true;
  } catch (err) {
    console.error(`[Codex] Cannot run ${getCodexCommand()}: ${(err as Error).message}`);
    return false;
  }
}

export async function sendPrompt(chatId: string, message: string, options: RunCodexOptions = {}): Promise<string> {
  return await runCodexExec(getChatSession(chatId), message, options);
}

export async function classifyIntentWithCodex(
  message: string,
  timeoutMs: number
): Promise<CodexIntentClassification | null> {
  const config = getConfig();
  const workspaceDir = resolve(config.defaultWorkspaceDir);
  await mkdir(workspaceDir, { recursive: true });

  const outDir = join(STATE_DIR, "last-messages");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `intent-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const baseArgs = config.codexDisableSandbox
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["--ask-for-approval", config.codexApprovalPolicy];
  const args = [
    ...baseArgs,
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--cd",
    workspaceDir,
    "--output-last-message",
    outFile,
  ];
  if (config.codexModel) args.push("--model", config.codexModel);
  args.push("-");

  const prompt = [
    "你是飞书到本地 Codex 桥接服务的意图分类器。",
    "只判断意图，不执行任务，不调用工具，不解释过程。",
    "输出严格 JSON，不要 Markdown，不要代码块。",
    'JSON schema: {"intent":"chat|task|confirm","reason":"简短原因","taskText":"如果是任务，提炼后的任务内容"}',
    "分类规则:",
    "- chat: 用户是在提问、咨询、确认概念、询问状态，适合直接回答。",
    "- task: 用户明确要求执行、修改、创建、启动、测试、修复、部署、生成、整理一项工作，且需要进度跟踪。",
    "- confirm: 用户表达模糊，可能是任务也可能只是聊天，需要先问用户是否生成任务。",
    `用户消息: ${message}`,
  ].join("\n");

  try {
    const result = await runCodex(args, prompt, timeoutMs, workspaceDir);
    const output = await readFile(outFile, "utf-8").catch(() => "");
    await rm(outFile, { force: true }).catch(() => {});
    if (result.timedOut || result.code !== 0) return null;
    return normalizeIntentClassification(output || result.stdout, message);
  } catch {
    await rm(outFile, { force: true }).catch(() => {});
    return null;
  }
}

export async function resetSession(chatId: string): Promise<void> {
  const session = getChatSession(chatId);
  delete session.threadId;
  session.updatedAt = new Date().toISOString();
  await saveSessions();
}

export async function setWorkspace(chatId: string, workspaceDir: string): Promise<ChatSession> {
  const session = getChatSession(chatId);
  session.workspaceDir = resolve(workspaceDir);
  delete session.threadId;
  session.updatedAt = new Date().toISOString();
  await mkdir(session.workspaceDir, { recursive: true });
  await saveSessions();
  return session;
}

export function getSessionCount(): number {
  return chatSessions.size;
}

export function getChatStatus(chatId: string): ChatSession {
  return getChatSession(chatId);
}

export function listSessions(): ChatSession[] {
  return [...chatSessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
