// Feishu x Codex Bridge - WebSocket long connection mode
import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  classifyIntentWithCodex,
  type CodexProgressEvent,
  getChatStatus,
  getSessionCount,
  initCodex,
  listSessions,
  resetSession,
  sendPrompt,
  setWorkspace,
} from "./codex.ts";
import { ConfigPatch, getConfig, maskSecret, saveConfig, type FeishuMessageMode } from "./config.ts";

process.on("uncaughtException", (e) => {
  console.error("[FATAL]", e.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL P]", reason);
});

let codexAvailable = false;

const startupConfig = getConfig();
if (!startupConfig.feishuAppId || !startupConfig.feishuAppSecret) {
  console.error("[Config] Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  process.exit(1);
}

const BRIDGE_PORT = startupConfig.bridgePort;
const SESSION_TTL = 24 * 3600 * 1000;
const recentMessages = new Set<string>();

type TaskStatus = "queued" | "running" | "done" | "failed";
type TaskProgressLog = {
  at: string;
  type: "started" | "completed" | "info";
  summary: string;
  detail?: string;
};

type BridgeTask = {
  id: string;
  chatId: string;
  message: string;
  preview: string;
  mode: FeishuMessageMode;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  resultPreview?: string;
  error?: string;
  heartbeatCount: number;
  currentStep?: string;
  progressSummary?: string;
  completedSteps: string[];
  nextSteps: string[];
  progressLog: TaskProgressLog[];
  recoveryNotifiedAt?: string;
};

type ChatWorkItem =
  | { kind: "task"; task: BridgeTask }
  | {
      kind: "chat";
      id: string;
      chatId: string;
      message: string;
      preview: string;
      createdAt: string;
      mode: FeishuMessageMode;
    };

type PendingTaskConfirmation = {
  chatId: string;
  message: string;
  preview: string;
  mode: FeishuMessageMode;
  createdAt: string;
};

type InteractionRoute =
  | "explicit_task"
  | "command"
  | "pending_confirmation"
  | "execution_continue"
  | "intent_task"
  | "intent_confirm"
  | "direct_chat"
  | "progress_query"
  | "chat"
  | "codex_not_ready"
  | "error";

type InteractionRecord = {
  id: string;
  at: string;
  chatId: string;
  message: string;
  preview: string;
  mode?: FeishuMessageMode;
  route: InteractionRoute;
  note?: string;
};

type MessageDirection = "inbound" | "outbound";
type MessageStatus = "received" | "sent" | "failed";

type MessageRecord = {
  id: string;
  at: string;
  chatId: string;
  mode?: FeishuMessageMode;
  direction: MessageDirection;
  status: MessageStatus;
  text: string;
  preview: string;
  feishuMessageId?: string;
  error?: string;
};

type ConversationRunStatus = "running" | "done" | "failed" | "interrupted";

type ConversationRunRecord = {
  id: string;
  chatId: string;
  message: string;
  preview: string;
  mode: FeishuMessageMode;
  status: ConversationRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  finishedAt?: string;
  latest: string;
  completedSteps: string[];
  heartbeatCount: number;
  resultPreview?: string;
  error?: string;
  finalNotifiedAt?: string;
  recoveryNotifiedAt?: string;
};

type EvolutionEvidence = {
  type: string;
  count: number;
  examples: string[];
};

type EvolutionRecommendation = {
  title: string;
  reason: string;
  confidence: number;
  suggestedAction: string;
  evidence: EvolutionEvidence[];
  autoApplied: false;
};

type EvolutionReport = {
  id: string;
  at: string;
  windowStart: string;
  windowEnd: string;
  scanned: {
    messages: number;
    interactions: number;
    tasks: number;
  };
  summary: string;
  recommendations: EvolutionRecommendation[];
  noChangeReasons: string[];
};

type EvolutionSchedulerStatus = {
  enabled: boolean;
  timerActive: boolean;
  intervalMs: number;
  startedAt?: string;
  lastRunAt?: string;
  lastRunReason?: "manual" | "scheduled" | "startup";
  nextRunAt?: string;
  lastError?: string;
};

const TASK_HISTORY_LIMIT = 200;
const INTERACTION_HISTORY_LIMIT = 500;
const MESSAGE_HISTORY_LIMIT = 1000;
const CONVERSATION_RUN_LIMIT = 200;
const EVOLUTION_REPORT_LIMIT = 200;
const STATE_DIR = resolve(process.cwd(), ".bridge-state");
const TASK_FILE = join(STATE_DIR, "tasks.json");
const INTERACTION_FILE = join(STATE_DIR, "interactions.json");
const MESSAGE_FILE = join(STATE_DIR, "messages.json");
const CONVERSATION_RUN_FILE = join(STATE_DIR, "codex-runs.json");
const EVOLUTION_FILE = join(STATE_DIR, "evolution-reports.json");
const BARE_EXECUTION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const DECISION_CONFIRMATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const tasks = loadTaskState();
const interactions = loadInteractionState();
const messages = loadMessageState();
const conversationRuns = loadConversationRunState();
const evolutionReports = loadEvolutionReports();
const workQueues = new Map<string, ChatWorkItem[]>();
const runningChats = new Set<string>();
const pendingTaskConfirmations = new Map<string, PendingTaskConfirmation>();
let evolutionTimer: ReturnType<typeof setInterval> | undefined;
let evolutionScheduler: EvolutionSchedulerStatus = {
  enabled: false,
  timerActive: false,
  intervalMs: 0,
};
let shutdownStarted = false;
let httpServer: Server | undefined;

console.log("=== Feishu x Codex Bridge (WS Mode) ===");
console.log(`Port: ${BRIDGE_PORT}`);

const feishuClient = new Lark.Client({
  appId: startupConfig.feishuAppId,
  appSecret: startupConfig.feishuAppSecret,
});
const wsClient = new Lark.WSClient({
  appId: startupConfig.feishuAppId,
  appSecret: startupConfig.feishuAppSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0f0f12;color:#e8e8ef;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:1040px;margin:0 auto;padding:32px 20px 56px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.brand h1{font-size:24px;line-height:1.2;margin:0 0 5px}.brand p{margin:0;color:#8a8d99;font-size:13px}.nav{display:flex;gap:10px;flex-wrap:wrap}.nav a,.btn{border:1px solid #2b2d38;background:#1a1b23;color:#f2f3f7;border-radius:8px;padding:10px 14px;text-decoration:none;font-size:14px;cursor:pointer}.btn.primary{background:#4a7cff;border-color:#4a7cff;color:white}.btn.danger{color:#ff6b6b;border-color:#5b2b33}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.panel{border:1px solid #2b2d38;background:#181922;border-radius:8px;padding:18px}.metric{font-size:30px;font-weight:700;margin-top:8px}.metric.small{font-size:18px;line-height:1.35}.label{color:#8a8d99;font-size:13px}.ok{color:#4ade80}.bad{color:#ff6b6b}.form{display:grid;grid-template-columns:1fr 1fr;gap:16px}.field{display:flex;flex-direction:column;gap:8px}.field.full{grid-column:1/-1}label{font-size:13px;color:#b6bac8}input,select{width:100%;border:1px solid #2b2d38;background:#0f0f12;color:#f2f3f7;border-radius:8px;padding:11px 12px;font-size:14px}small{color:#8a8d99}.actions{display:flex;align-items:center;gap:10px;margin-top:18px}.notice{border:1px solid #31533b;background:#14251a;color:#bdf7ca;border-radius:8px;padding:10px 12px;margin-bottom:16px}.table{width:100%;border-collapse:collapse;font-size:13px}.table th,.table td{border-bottom:1px solid #292b35;padding:9px 8px;text-align:left;vertical-align:top}.table th{color:#9da3b3;font-weight:600}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:12px;border:1px solid #363946}.badge.queued{color:#facc15}.badge.running{color:#60a5fa}.badge.done{color:#4ade80}.badge.failed{color:#ff6b6b}.muted{color:#8a8d99}.logbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.logbar .left{display:flex;gap:8px;flex-wrap:wrap}.logbar select{width:auto;min-width:136px;padding:8px 10px}.logbar .btn{padding:8px 12px}.timeline{display:flex;flex-direction:column;gap:8px}.logitem{border:1px solid #292b35;background:#12131a;border-radius:8px;padding:12px}.loghead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.logtext{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5}.source-feishu{color:#60a5fa}.source-codex{color:#4ade80}.source-router{color:#facc15}.source-bridge{color:#c084fc}@media(max-width:760px){.top{align-items:flex-start;flex-direction:column}.grid,.form{grid-template-columns:1fr}.loghead{align-items:flex-start;flex-direction:column}}
</style></head><body><main class="page">${body}</main></body></html>`;
}

async function sendFeishuText(chatId: string, text: string, mode: FeishuMessageMode = getConfig().feishuMessageMode) {
  try {
    await feishuClient.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    recordMessage({ chatId, mode, direction: "outbound", status: "sent", text });
  } catch (err) {
    recordMessage({
      chatId,
      mode,
      direction: "outbound",
      status: "failed",
      text,
      error: (err as Error).message,
    });
    throw err;
  }
}

async function sendFeishuTextSafe(chatId: string, text: string, mode: FeishuMessageMode = getConfig().feishuMessageMode) {
  try {
    await sendFeishuText(chatId, text, mode);
  } catch (err) {
    console.error(`[Feishu] send failed: ${(err as Error).message}`);
  }
}

async function sendFeishuTextTracked(
  chatId: string,
  text: string,
  mode: FeishuMessageMode = getConfig().feishuMessageMode
): Promise<boolean> {
  try {
    await sendFeishuText(chatId, text, mode);
    return true;
  } catch (err) {
    console.error(`[Feishu] send failed: ${(err as Error).message}`);
    return false;
  }
}

function rememberMessage(messageId: string): boolean {
  if (recentMessages.has(messageId)) return false;
  recentMessages.add(messageId);
  if (recentMessages.size > 100) {
    const iterator = recentMessages.values();
    const oldest = iterator.next().value;
    if (oldest) recentMessages.delete(oldest);
  }
  return true;
}

function normalizeTask(raw: Partial<BridgeTask>): BridgeTask | undefined {
  if (!raw.id || !raw.chatId || !raw.preview || !raw.createdAt || !raw.updatedAt) return undefined;
  const status = ["queued", "running", "done", "failed"].includes(String(raw.status)) ? raw.status! : "failed";
  return {
    id: raw.id,
    chatId: raw.chatId,
    message: raw.message ?? raw.preview,
    preview: raw.preview,
    mode: raw.mode === "direct" ? "direct" : "bridge",
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    resultPreview: raw.resultPreview,
    error: raw.error,
    heartbeatCount: raw.heartbeatCount ?? 0,
    currentStep: raw.currentStep,
    progressSummary: raw.progressSummary,
    completedSteps: Array.isArray(raw.completedSteps) ? raw.completedSteps.slice(-12) : [],
    nextSteps: Array.isArray(raw.nextSteps) ? raw.nextSteps.slice(-5) : [],
    progressLog: Array.isArray(raw.progressLog) ? raw.progressLog.slice(-40) : [],
    recoveryNotifiedAt: raw.recoveryNotifiedAt,
  };
}

function loadTaskState(): Map<string, BridgeTask> {
  const loaded = new Map<string, BridgeTask>();
  let changed = false;
  try {
    if (!existsSync(TASK_FILE)) return loaded;
    const raw = JSON.parse(readFileSync(TASK_FILE, "utf-8")) as { tasks?: Partial<BridgeTask>[] };
    const now = nowIso();
    for (const item of raw.tasks ?? []) {
      const task = normalizeTask(item);
      if (!task) continue;
      if (task.status === "running" || task.status === "queued") {
        task.status = "failed";
        task.finishedAt = now;
        task.updatedAt = now;
        task.error = "服务重启，原任务已中断，请重新发送任务。";
        task.currentStep = "任务已被服务重启中断";
        task.nextSteps = ["重新发送任务"];
        task.progressLog.push({
          at: now,
          type: "info",
          summary: "服务重启后恢复任务记录，未完成任务已标记为中断",
        });
        changed = true;
      }
      loaded.set(task.id, task);
    }
  } catch (err) {
    console.error(`[Task] Cannot load task state: ${(err as Error).message}`);
  }
  if (changed) saveTaskState(loaded);
  return loaded;
}

function saveTaskState(source: Map<string, BridgeTask> = tasks) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const savedTasks = [...source.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    writeFileSync(TASK_FILE, JSON.stringify({ tasks: savedTasks }, null, 2), "utf-8");
  } catch (err) {
    console.error(`[Task] Cannot save task state: ${(err as Error).message}`);
  }
}

function normalizeInteraction(raw: Partial<InteractionRecord>): InteractionRecord | undefined {
  if (!raw.id || !raw.chatId || !raw.message || !raw.preview || !raw.route || !raw.at) return undefined;
  const routes: InteractionRoute[] = [
    "explicit_task",
    "command",
    "pending_confirmation",
    "execution_continue",
    "intent_task",
    "intent_confirm",
    "direct_chat",
    "progress_query",
    "chat",
    "codex_not_ready",
    "error",
  ];
  if (!routes.includes(raw.route)) return undefined;
  return {
    id: raw.id,
    at: raw.at,
    chatId: raw.chatId,
    message: raw.message,
    preview: raw.preview,
    mode: raw.mode === "direct" || raw.mode === "bridge" ? raw.mode : undefined,
    route: raw.route,
    note: raw.note,
  };
}

function loadInteractionState(): InteractionRecord[] {
  try {
    if (!existsSync(INTERACTION_FILE)) return [];
    const raw = JSON.parse(readFileSync(INTERACTION_FILE, "utf-8")) as { interactions?: Partial<InteractionRecord>[] };
    return (raw.interactions ?? [])
      .map(normalizeInteraction)
      .filter((item): item is InteractionRecord => Boolean(item))
      .slice(-INTERACTION_HISTORY_LIMIT);
  } catch (err) {
    console.error(`[Interaction] Cannot load interaction state: ${(err as Error).message}`);
    return [];
  }
}

function saveInteractionState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(INTERACTION_FILE, JSON.stringify({ interactions }, null, 2), "utf-8");
  } catch (err) {
    console.error(`[Interaction] Cannot save interaction state: ${(err as Error).message}`);
  }
}

function recordInteraction(
  chatId: string,
  message: string,
  route: InteractionRoute,
  note?: string,
  mode: FeishuMessageMode = getConfig().feishuMessageMode
) {
  interactions.push({
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    at: nowIso(),
    chatId,
    message,
    preview: taskPreview(message),
    mode,
    route,
    note,
  });
  while (interactions.length > INTERACTION_HISTORY_LIMIT) interactions.shift();
  saveInteractionState();
}

function maskSensitiveText(value: string): string {
  return value
    .replace(/((?:secret|token|key|password|authorization|app_secret|verification_token|授权码|密钥)\s*[:=：]\s*)[^\s"',;，。}]+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***");
}

function normalizeMessage(raw: Partial<MessageRecord>): MessageRecord | undefined {
  if (!raw.id || !raw.at || !raw.chatId || !raw.direction || !raw.status || typeof raw.text !== "string") return undefined;
  if (!["inbound", "outbound"].includes(raw.direction)) return undefined;
  if (!["received", "sent", "failed"].includes(raw.status)) return undefined;
  return {
    id: raw.id,
    at: raw.at,
    chatId: raw.chatId,
    mode: raw.mode === "direct" || raw.mode === "bridge" ? raw.mode : undefined,
    direction: raw.direction,
    status: raw.status,
    text: raw.text,
    preview: raw.preview || taskPreview(raw.text),
    feishuMessageId: raw.feishuMessageId,
    error: raw.error,
  };
}

function loadMessageState(): MessageRecord[] {
  try {
    if (!existsSync(MESSAGE_FILE)) return [];
    const raw = JSON.parse(readFileSync(MESSAGE_FILE, "utf-8")) as { messages?: Partial<MessageRecord>[] };
    return (raw.messages ?? [])
      .map(normalizeMessage)
      .filter((item): item is MessageRecord => Boolean(item))
      .slice(-MESSAGE_HISTORY_LIMIT);
  } catch (err) {
    console.error(`[Message] Cannot load message state: ${(err as Error).message}`);
    return [];
  }
}

function saveMessageState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MESSAGE_FILE, JSON.stringify({ messages }, null, 2), "utf-8");
  } catch (err) {
    console.error(`[Message] Cannot save message state: ${(err as Error).message}`);
  }
}

function recordMessage(input: {
  chatId: string;
  mode?: FeishuMessageMode;
  direction: MessageDirection;
  status: MessageStatus;
  text: string;
  feishuMessageId?: string;
  error?: string;
}) {
  const text = maskSensitiveText(input.text);
  messages.push({
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    at: nowIso(),
    chatId: input.chatId,
    mode: input.mode,
    direction: input.direction,
    status: input.status,
    text,
    preview: taskPreview(text),
    feishuMessageId: input.feishuMessageId,
    error: input.error ? maskSensitiveText(input.error) : undefined,
  });
  while (messages.length > MESSAGE_HISTORY_LIMIT) messages.shift();
  saveMessageState();
}

function normalizeConversationRun(raw: Partial<ConversationRunRecord>): ConversationRunRecord | undefined {
  if (!raw.id || !raw.chatId || !raw.message || !raw.preview || !raw.createdAt || !raw.updatedAt) return undefined;
  const status = ["running", "done", "failed", "interrupted"].includes(String(raw.status))
    ? raw.status!
    : "interrupted";
  const mode: FeishuMessageMode = raw.mode === "direct" ? "direct" : "bridge";
  return {
    id: raw.id,
    chatId: raw.chatId,
    message: raw.message,
    preview: raw.preview,
    mode,
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    startedAt: raw.startedAt ?? raw.createdAt,
    finishedAt: raw.finishedAt,
    latest: raw.latest || "Codex 正在处理",
    completedSteps: Array.isArray(raw.completedSteps) ? raw.completedSteps.slice(-12) : [],
    heartbeatCount: raw.heartbeatCount ?? 0,
    resultPreview: raw.resultPreview,
    error: raw.error,
    finalNotifiedAt: raw.finalNotifiedAt,
    recoveryNotifiedAt: raw.recoveryNotifiedAt,
  };
}

function loadConversationRunState(): Map<string, ConversationRunRecord> {
  const loaded = new Map<string, ConversationRunRecord>();
  let changed = false;
  try {
    if (!existsSync(CONVERSATION_RUN_FILE)) return loaded;
    const raw = JSON.parse(readFileSync(CONVERSATION_RUN_FILE, "utf-8")) as {
      runs?: Partial<ConversationRunRecord>[];
    };
    const now = nowIso();
    for (const item of raw.runs ?? []) {
      const run = normalizeConversationRun(item);
      if (!run) continue;
      if (run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = now;
        run.updatedAt = now;
        run.error = "服务重启或进程中断，上一次 Codex 执行没有完成。";
        run.latest ||= "服务中断前没有记录到 Codex 进展";
        changed = true;
      }
      loaded.set(run.id, run);
    }
  } catch (err) {
    console.error(`[Run] Cannot load Codex run state: ${(err as Error).message}`);
  }
  if (changed) saveConversationRunState(loaded);
  return loaded;
}

function saveConversationRunState(source: Map<string, ConversationRunRecord> = conversationRuns) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const runs = [...source.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    writeFileSync(CONVERSATION_RUN_FILE, JSON.stringify({ runs }, null, 2), "utf-8");
  } catch (err) {
    console.error(`[Run] Cannot save Codex run state: ${(err as Error).message}`);
  }
}

function pruneConversationRunHistory() {
  const terminalRuns = [...conversationRuns.values()]
    .filter((run) => run.status !== "running")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  while (conversationRuns.size > CONVERSATION_RUN_LIMIT && terminalRuns.length > 0) {
    const run = terminalRuns.shift();
    if (run) conversationRuns.delete(run.id);
  }
}

function createConversationRun(item: Extract<ChatWorkItem, { kind: "chat" }>): ConversationRunRecord {
  const now = nowIso();
  const run: ConversationRunRecord = {
    id: item.id,
    chatId: item.chatId,
    message: item.message,
    preview: item.preview,
    mode: item.mode,
    status: "running",
    createdAt: item.createdAt,
    startedAt: now,
    updatedAt: now,
    latest: "已接收，等待 Codex 建立会话",
    completedSteps: [],
    heartbeatCount: 0,
  };
  conversationRuns.set(run.id, run);
  pruneConversationRunHistory();
  saveConversationRunState();
  return run;
}

function updateConversationRunProgress(run: ConversationRunRecord, event: CodexProgressEvent) {
  const at = nowIso();
  run.updatedAt = at;
  if (event.type === "completed") {
    pushUniqueStep(run.completedSteps, event.summary, 12);
  }
  run.latest = event.detail || event.summary;
  saveConversationRunState();
}

function updateConversationRunHeartbeat(run: ConversationRunRecord, latest?: string) {
  run.heartbeatCount += 1;
  run.updatedAt = nowIso();
  if (latest) run.latest = latest;
  saveConversationRunState();
}

function finishConversationRun(
  run: ConversationRunRecord,
  status: Exclude<ConversationRunStatus, "running">,
  patch: { result?: string; error?: string; latest?: string } = {}
) {
  const now = nowIso();
  run.status = status;
  run.finishedAt = now;
  run.updatedAt = now;
  if (patch.result) run.resultPreview = taskPreview(patch.result).slice(0, 220);
  if (patch.error) run.error = patch.error;
  run.latest = patch.latest || patch.error || patch.result || run.latest;
  saveConversationRunState();
}

function markConversationRunNotified(run: ConversationRunRecord, field: "finalNotifiedAt" | "recoveryNotifiedAt") {
  run[field] = nowIso();
  run.updatedAt = run[field]!;
  saveConversationRunState();
}

function normalizeEvolutionReport(raw: Partial<EvolutionReport>): EvolutionReport | undefined {
  if (!raw.id || !raw.at || !raw.windowStart || !raw.windowEnd || !raw.summary) return undefined;
  return {
    id: raw.id,
    at: raw.at,
    windowStart: raw.windowStart,
    windowEnd: raw.windowEnd,
    scanned: {
      messages: raw.scanned?.messages ?? 0,
      interactions: raw.scanned?.interactions ?? 0,
      tasks: raw.scanned?.tasks ?? 0,
    },
    summary: raw.summary,
    recommendations: Array.isArray(raw.recommendations) ? raw.recommendations.slice(0, 10) : [],
    noChangeReasons: Array.isArray(raw.noChangeReasons) ? raw.noChangeReasons.slice(0, 10) : [],
  };
}

function loadEvolutionReports(): EvolutionReport[] {
  try {
    if (!existsSync(EVOLUTION_FILE)) return [];
    const raw = JSON.parse(readFileSync(EVOLUTION_FILE, "utf-8")) as { reports?: Partial<EvolutionReport>[] };
    return (raw.reports ?? [])
      .map(normalizeEvolutionReport)
      .filter((item): item is EvolutionReport => Boolean(item))
      .slice(-EVOLUTION_REPORT_LIMIT);
  } catch (err) {
    console.error(`[Evolution] Cannot load reports: ${(err as Error).message}`);
    return [];
  }
}

function saveEvolutionReports() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(EVOLUTION_FILE, JSON.stringify({ reports: evolutionReports }, null, 2), "utf-8");
  } catch (err) {
    console.error(`[Evolution] Cannot save reports: ${(err as Error).message}`);
  }
}

function recentExample(values: string[], limit = 4): string[] {
  return values.filter(Boolean).slice(-limit).map((value) => taskPreview(value));
}

function createEvidence(type: string, examples: string[]): EvolutionEvidence {
  return {
    type,
    count: examples.length,
    examples: recentExample(examples),
  };
}

function pushRecommendation(
  list: EvolutionRecommendation[],
  recommendation: Omit<EvolutionRecommendation, "autoApplied">
) {
  list.push({ ...recommendation, autoApplied: false });
}

function analyzeEvolutionWindow(now = new Date()): EvolutionReport {
  const config = getConfig();
  const intervalMs = Math.max(config.evolutionCheckIntervalMs, 60 * 60 * 1000);
  const minEvidence = Math.max(config.evolutionMinEvidence, 1);
  const windowStartDate = new Date(now.getTime() - intervalMs);
  const windowStart = windowStartDate.toISOString();
  const windowEnd = now.toISOString();

  const inWindow = (value: string | undefined) => Boolean(value && Date.parse(value) >= windowStartDate.getTime());
  const windowMessages = messages.filter((message) => inWindow(message.at));
  const windowInteractions = interactions.filter((interaction) => inWindow(interaction.at));
  const windowTasks = [...tasks.values()].filter(
    (task) => inWindow(task.createdAt) || inWindow(task.updatedAt) || inWindow(task.finishedAt)
  );
  const windowRuns = [...conversationRuns.values()].filter(
    (run) => inWindow(run.createdAt) || inWindow(run.updatedAt) || inWindow(run.finishedAt)
  );
  const windowBridgeMessages = windowMessages.filter((message) => message.mode === "bridge");
  const windowBridgeInteractions = windowInteractions.filter((interaction) => interaction.mode === "bridge");
  const windowBridgeTasks = windowTasks.filter((task) => task.mode === "bridge");
  const windowBridgeRuns = windowRuns.filter((run) => run.mode === "bridge");
  const bridgeChatIds = new Set<string>([
    ...windowBridgeTasks.map((task) => task.chatId),
    ...windowBridgeRuns.map((run) => run.chatId),
    ...windowBridgeInteractions.map((interaction) => interaction.chatId),
  ]);
  const bridgeEvidenceCount =
    windowBridgeMessages.length + windowBridgeInteractions.length + windowBridgeTasks.length + windowBridgeRuns.length;

  const recommendations: EvolutionRecommendation[] = [];
  const noChangeReasons: string[] = [];

  const failedOutbound = windowBridgeMessages.filter((message) => message.direction === "outbound" && message.status === "failed");
  if (failedOutbound.length > 0) {
    pushRecommendation(recommendations, {
      title: "增强桥接模式发送失败处理",
      reason: "桥接模式出现实际 outbound 发送失败，用户可能收不到回复。",
      confidence: 0.85,
      suggestedAction: "保留桥接回复失败消息并增加重试/补发入口；复盘失败原因是否为网络波动或 token 问题。",
      evidence: [createEvidence("outbound_failed", failedOutbound.map((message) => `${message.at} ${message.error || message.preview}`))],
    });
  }

  const bridgeConversationTimeouts = windowBridgeRuns.filter(
    (run) => run.status === "failed" && /timeout/i.test(`${run.error ?? ""} ${run.latest}`)
  );
  if (bridgeConversationTimeouts.length >= minEvidence) {
    pushRecommendation(recommendations, {
      title: "降低桥接普通会话超时断链",
      reason: "桥接模式普通会话多次等到 Codex timeout，用户会看到失败而不是持续进展。",
      confidence: 0.9,
      suggestedAction: "优化桥接模式下普通会话的阶段心跳、超时前摘要和任务化提示；必要时调整 CHAT_TIMEOUT_MS。",
      evidence: [
        createEvidence("bridge_conversation_timeout", bridgeConversationTimeouts.map((run) => `${run.id} ${run.preview}`)),
      ],
    });
  }

  const timeoutTasks = windowBridgeTasks.filter((task) => task.status === "failed" && /timeout/i.test(task.error ?? task.progressSummary ?? ""));
  if (timeoutTasks.length >= minEvidence) {
    pushRecommendation(recommendations, {
      title: "优化长任务超时前的阶段反馈",
      reason: "同一复盘窗口内出现多次 Codex timeout，说明用户可能长时间等不到有效结果。",
      confidence: 0.78,
      suggestedAction: "把长任务拆成更小阶段，超时前保存阶段产物，并在飞书回复可继续的下一步。",
      evidence: [createEvidence("codex_timeout_tasks", timeoutTasks.map((task) => `${task.id} ${task.preview}`))],
    });
  }

  const shortContinueMisroutes = windowBridgeInteractions.filter(
    (interaction) =>
      /^(继续|继续开发|继续上面|继续上个|执行|开始执行)/.test(interaction.message.trim()) &&
      (interaction.route === "intent_task" || interaction.route === "intent_confirm" || interaction.route === "chat")
  );
  if (shortContinueMisroutes.length >= minEvidence) {
    pushRecommendation(recommendations, {
      title: "补齐继续类短句路由",
      reason: "继续类短句多次没有直接进入 execution_continue，容易变成裸任务或确认打断。",
      confidence: 0.82,
      suggestedAction: "把高频继续短句加入续接规则；先人工确认短句语义后再改代码。",
      evidence: [createEvidence("continue_route_mismatch", shortContinueMisroutes.map((item) => `${item.route}: ${item.message}`))],
    });
  }

  const decisionMisroutes = windowBridgeInteractions.filter(
    (interaction) =>
      isDecisionConfirmationRequest(interaction.message) &&
      (interaction.route === "intent_task" || interaction.route === "intent_confirm" || interaction.route === "chat")
  );
  if (decisionMisroutes.length >= 1) {
    pushRecommendation(recommendations, {
      title: "补齐方案确认类短句路由",
      reason: "用户确认默认方案或选择项时被当成普通会话/模糊确认，容易超时或打断任务推进。",
      confidence: 0.84,
      suggestedAction: "把方案确认短句路由到最近带决策上下文的任务；没有决策上下文时提示指定任务。",
      evidence: [createEvidence("decision_confirmation_mismatch", decisionMisroutes.map((item) => `${item.route}: ${item.message}`))],
    });
  }

  const repeatedConfirmations = windowBridgeInteractions.filter((interaction) => interaction.route === "intent_confirm");
  if (repeatedConfirmations.length >= minEvidence + 1) {
    pushRecommendation(recommendations, {
      title: "减少重复确认打断",
      reason: "模糊确认次数偏多，说明本地规则可能没有覆盖用户常用表达。",
      confidence: 0.72,
      suggestedAction: "统计高频确认消息，优先把明确任务/明确会话表达加入规则，避免用户重复确认。",
      evidence: [createEvidence("intent_confirm", repeatedConfirmations.map((item) => item.message))],
    });
  }

  const sessionsWithoutThread = listSessions().filter((session) => !session.threadId && bridgeChatIds.has(session.chatId));
  if (sessionsWithoutThread.length > 0 && bridgeEvidenceCount >= minEvidence) {
    pushRecommendation(recommendations, {
      title: "检查飞书会话绑定",
      reason: "桥接模式存在没有 threadId 的飞书会话，可能导致后续消息新开 Codex 会话。",
      confidence: 0.8,
      suggestedAction: "确认该会话是否已真正调用过 Codex；如果调用过仍无 threadId，需要检查 thread.started 落盘。",
      evidence: [createEvidence("sessions_without_thread", sessionsWithoutThread.map((session) => session.chatId))],
    });
  }

  if (bridgeEvidenceCount < minEvidence) {
    noChangeReasons.push(`桥接模式样本不足: ${bridgeEvidenceCount}/${minEvidence}`);
  }
  if (recommendations.length === 0 && bridgeEvidenceCount >= minEvidence) {
    noChangeReasons.push("桥接模式未发现发送失败、重复误判、重复确认或会话绑定风险。");
  }

  return {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    at: windowEnd,
    windowStart,
    windowEnd,
    scanned: {
      messages: windowBridgeMessages.length,
      interactions: windowBridgeInteractions.length,
      tasks: windowBridgeTasks.length,
    },
    summary:
      recommendations.length > 0
        ? `桥接模式发现 ${recommendations.length} 条有证据的待确认进化建议，未自动改代码。`
        : "桥接模式证据不足或状态正常，本轮不进化。",
    recommendations,
    noChangeReasons,
  };
}

function saveEvolutionReport(report: EvolutionReport): EvolutionReport {
  evolutionReports.push(report);
  while (evolutionReports.length > EVOLUTION_REPORT_LIMIT) evolutionReports.shift();
  saveEvolutionReports();
  return report;
}

function runEvolutionCheck(reason: "manual" | "scheduled" | "startup" = "manual"): EvolutionReport {
  const report = saveEvolutionReport(analyzeEvolutionWindow());
  evolutionScheduler.lastRunAt = report.at;
  evolutionScheduler.lastRunReason = reason;
  evolutionScheduler.lastError = undefined;
  if (reason === "scheduled" && evolutionScheduler.enabled) {
    evolutionScheduler.nextRunAt = new Date(Date.now() + evolutionScheduler.intervalMs).toISOString();
  }
  console.log(
    `[Evolution] ${reason} ${report.id}: messages=${report.scanned.messages}, recommendations=${report.recommendations.length}`
  );
  return report;
}

function getEvolutionIntervalMs(): number {
  return Math.max(getConfig().evolutionCheckIntervalMs, 60 * 60 * 1000);
}

function getEvolutionSchedulerStatus() {
  const latest = evolutionReports[evolutionReports.length - 1];
  return {
    ...evolutionScheduler,
    intervalMs: evolutionScheduler.intervalMs || getEvolutionIntervalMs(),
    reportCount: evolutionReports.length,
    latestReport: latest
      ? {
          id: latest.id,
          at: latest.at,
          summary: latest.summary,
          recommendations: latest.recommendations.length,
          noChangeReasons: latest.noChangeReasons.length,
        }
      : null,
    stateFile: EVOLUTION_FILE,
  };
}

function formatLocalTime(value?: string): string {
  if (!value) return "暂无";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function formatTimeUntil(value?: string): string {
  if (!value) return "暂无";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "暂无";
  const diff = timestamp - Date.now();
  if (diff <= 0) return "即将执行";
  return formatDuration(diff);
}

function formatEvolutionSchedulerStatus(): string {
  const status = getEvolutionSchedulerStatus();
  return formatBlock("自动复盘状态", [
    `状态: ${status.enabled ? (status.timerActive ? "开启，定时器运行中" : "开启，但定时器未运行") : "关闭"}`,
    "范围: 仅桥接模式",
    `间隔: ${formatDuration(status.intervalMs)}`,
    `服务启动: ${formatLocalTime(status.startedAt)}`,
    `上次运行: ${formatLocalTime(status.lastRunAt)}${status.lastRunReason ? `｜${status.lastRunReason}` : ""}`,
    `下次运行: ${formatLocalTime(status.nextRunAt)}｜${formatTimeUntil(status.nextRunAt)}`,
    `报告数量: ${status.reportCount}`,
    `最新结论: ${status.latestReport?.summary ?? "暂无报告"}`,
    `记录文件: .bridge-state\\evolution-reports.json`,
    "",
    "指令: /evo 查看最新报告，/evo run 立即复盘",
  ]);
}

function formatEvolutionReport(report: EvolutionReport): string {
  const lines = [
    `时间: ${report.at}`,
    "范围: 仅桥接模式",
    `窗口: ${report.windowStart} ~ ${report.windowEnd}`,
    `扫描: 消息 ${report.scanned.messages}｜路由 ${report.scanned.interactions}｜任务 ${report.scanned.tasks}`,
    `结论: ${report.summary}`,
  ];

  if (report.recommendations.length > 0) {
    lines.push(
      "",
      "建议:",
      ...report.recommendations.map(
        (item, index) =>
          `${index + 1}. ${item.title}｜置信度 ${Math.round(item.confidence * 100)}%\n   依据: ${item.evidence
            .map((evidence) => `${evidence.type} ${evidence.count}条`)
            .join("；")}\n   动作: ${item.suggestedAction}`
      )
    );
  }

  if (report.noChangeReasons.length > 0) {
    lines.push("", "不进化原因:", ...report.noChangeReasons.map((reasonText) => `- ${reasonText}`));
  }

  return formatBlock("自我进化复盘", lines);
}

function nowIso(): string {
  return new Date().toISOString();
}

function taskPreview(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 120) || "(空任务)";
}

function taskStatusText(status: TaskStatus): string {
  const names: Record<TaskStatus, string> = {
    queued: "排队中",
    running: "处理中",
    done: "已完成",
    failed: "失败",
  };
  return names[status];
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function taskElapsed(task: BridgeTask): string {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  return formatDuration(end - start);
}

function getTaskCounts() {
  const queuedTasks = [...tasks.values()].filter((task) => task.status === "queued").length;
  const runningTasks = [...tasks.values()].filter((task) => task.status === "running").length;
  return { queuedTasks, runningTasks };
}

function getActiveConversationRun(chatId: string): ConversationRunRecord | undefined {
  return [...conversationRuns.values()]
    .filter((run) => run.chatId === chatId && run.status === "running")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function pruneTaskHistory() {
  const terminalTasks = [...tasks.values()]
    .filter((task) => task.status === "done" || task.status === "failed")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  while (tasks.size > TASK_HISTORY_LIMIT && terminalTasks.length > 0) {
    const task = terminalTasks.shift();
    if (task) tasks.delete(task.id);
  }
}

function createTask(chatId: string, message: string, mode: FeishuMessageMode = getConfig().feishuMessageMode): BridgeTask {
  const createdAt = nowIso();
  const task: BridgeTask = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    chatId,
    message,
    preview: taskPreview(message),
    mode,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    heartbeatCount: 0,
    currentStep: "等待进入执行队列",
    progressSummary: "任务已入队",
    completedSteps: [],
    nextSteps: ["等待当前聊天中的前一个任务完成"],
    progressLog: [{ at: createdAt, type: "info", summary: "任务已入队" }],
  };

  tasks.set(task.id, task);
  enqueueWorkItem(chatId, { kind: "task", task });
  pruneTaskHistory();
  saveTaskState();
  return task;
}

function createChatWork(
  chatId: string,
  message: string,
  mode: FeishuMessageMode = "bridge"
): Extract<ChatWorkItem, { kind: "chat" }> {
  const work: Extract<ChatWorkItem, { kind: "chat" }> = {
    kind: "chat",
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    chatId,
    message,
    preview: taskPreview(message),
    createdAt: nowIso(),
    mode,
  };
  enqueueWorkItem(chatId, work);
  return work;
}

async function enqueueTrackedTask(chatId: string, message: string, mode: FeishuMessageMode = getConfig().feishuMessageMode) {
  const validationError = validateTrackedTaskText(message);
  if (validationError) {
    await sendFeishuText(chatId, validationError, mode);
    return;
  }

  const task = createTask(chatId, message, mode);
  const queuePosition = getQueuePosition(chatId, task.id);
  await sendFeishuText(
    chatId,
    formatBlock("Codex 已收到", [
      `ID: ${task.id}`,
      `队列位置: ${queuePosition}`,
      `任务: ${task.preview}`,
      formatNextInstructionAdvice(chatId, queuePosition && queuePosition > 1 ? "busy" : "busy"),
      "",
      "未完成列表: /list",
      "进度详情: /td",
    ]),
    mode
  );
  void processChatQueue(chatId);
}

function enqueueWorkItem(chatId: string, item: ChatWorkItem) {
  const queue = workQueues.get(chatId) ?? [];
  queue.push(item);
  workQueues.set(chatId, queue);
}

function publicTask(task: BridgeTask) {
  return {
    id: task.id,
    chatId: task.chatId,
    mode: task.mode,
    preview: task.preview,
    status: task.status,
    statusText: taskStatusText(task.status),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    elapsed: taskElapsed(task),
    resultPreview: task.resultPreview,
    error: task.error,
    heartbeatCount: task.heartbeatCount,
    currentStep: task.currentStep,
    progressSummary: task.progressSummary,
    completedSteps: task.completedSteps,
    nextSteps: task.nextSteps,
    progressLog: task.progressLog,
    recoveryNotifiedAt: task.recoveryNotifiedAt,
  };
}

function publicLogs(limit: number) {
  const messageLogs = messages.map((message) => ({
    id: message.id,
    at: message.at,
    source: message.direction === "inbound" ? "feishu" : "bridge",
    title: message.direction === "inbound" ? "飞书消息" : message.status === "failed" ? "回复失败" : "回复飞书",
    status: message.status,
    chatId: message.chatId,
    text: message.text,
    preview: message.preview,
  }));

  const routeLogs = interactions.map((interaction) => ({
    id: interaction.id,
    at: interaction.at,
    source: "router",
    title: "路由判断",
    status: interaction.route,
    chatId: interaction.chatId,
    text: `${interaction.route}${interaction.note ? `｜${interaction.note}` : ""}\n${interaction.preview}`,
    preview: interaction.preview,
  }));

  const codexLogs = [...tasks.values()].flatMap((task) =>
    task.progressLog.map((log, index) => ({
      id: `${task.id}-${index}-${log.at}`,
      at: log.at,
      source: "codex",
      title: `Codex 进度｜${shortTaskId(task)}`,
      status: log.type,
      chatId: task.chatId,
      taskId: task.id,
      text: `${log.summary}${log.detail ? `\n${log.detail}` : ""}\n任务: ${task.preview}`,
      preview: log.summary,
    }))
  );

  const runLogs = [...conversationRuns.values()].map((run) => ({
    id: run.id,
    at: run.updatedAt,
    source: "codex",
    title: `Codex 会话｜${modeLabel(run.mode)}`,
    status: run.status,
    chatId: run.chatId,
    text: [
      `内容: ${run.preview}`,
      `状态: ${run.status}`,
      `最近进展: ${run.latest}`,
      run.error ? `错误: ${run.error}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    preview: run.latest,
  }));

  const logs = [...messageLogs, ...routeLogs, ...codexLogs, ...runLogs]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
  return {
    count: logs.length,
    totals: {
      messages: messages.length,
      interactions: interactions.length,
      codexProgress: codexLogs.length + runLogs.length,
    },
    logs,
  };
}

function getQueuePosition(chatId: string, taskId: string): number {
  return getWorkQueuePosition(chatId, taskId);
}

function getWorkQueuePosition(chatId: string, id: string): number {
  return (
    (workQueues.get(chatId) ?? []).findIndex((item) =>
      item.kind === "task" ? item.task.id === id : item.id === id
    ) + 1
  );
}

function pushUniqueStep(steps: string[], step: string, limit: number) {
  const clean = step.trim();
  if (!clean) return;
  const existingIndex = steps.indexOf(clean);
  if (existingIndex >= 0) steps.splice(existingIndex, 1);
  steps.push(clean);
  while (steps.length > limit) steps.shift();
}

function updateNextSteps(task: BridgeTask) {
  if (task.status === "queued") {
    task.nextSteps = ["等待进入执行队列"];
    return;
  }
  if (task.status === "done") {
    task.nextSteps = ["已完成"];
    return;
  }
  if (task.status === "failed") {
    task.nextSteps = ["根据错误调整后重新发送任务"];
    return;
  }
  if (task.currentStep?.startsWith("正在执行工具")) {
    task.nextSteps = ["等待工具返回", "根据结果继续下一步"];
    return;
  }
  if (task.currentStep?.includes("整理回复")) {
    task.nextSteps = ["发送最终结果"];
    return;
  }
  task.nextSteps = ["继续分析并执行下一步"];
}

function recordTaskProgress(task: BridgeTask, event: CodexProgressEvent) {
  const at = nowIso();
  task.updatedAt = at;
  task.progressLog.push({ at, type: event.type, summary: event.summary, detail: event.detail });
  task.progressLog = task.progressLog.slice(-40);

  if (event.type === "completed") {
    pushUniqueStep(task.completedSteps, event.summary, 12);
  } else {
    task.currentStep = event.summary;
  }
  if (event.detail) task.progressSummary = event.detail;
  else task.progressSummary = event.summary;
  updateNextSteps(task);
  saveTaskState();
}

function formatSteps(steps: string[], fallback: string, limit: number): string {
  const values = steps.filter(Boolean).slice(-limit);
  return values.length ? values.join("；") : fallback;
}

function shortTaskId(task: BridgeTask): string {
  return task.id.slice(0, 10);
}

function formatBlock(title: string, lines: string[]): string {
  return [`【${title}】`, ...lines.filter(Boolean)].join("\n");
}

function heartbeatIntervalMs(): number {
  return Math.max(getConfig().taskHeartbeatMs, 15000);
}

function parseHeartbeatIntervalInput(value: string): number | undefined {
  const text = value.trim().toLowerCase();
  const match = text.match(/^(\d+)(?:\s*(ms|s|sec|secs|second|seconds|秒|m|min|mins|minute|minutes|分|分钟))?$/);
  if (!match) return undefined;
  const amount = parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2] ?? "ms";
  if (["s", "sec", "secs", "second", "seconds", "秒"].includes(unit)) return amount * 1000;
  if (["m", "min", "mins", "minute", "minutes", "分", "分钟"].includes(unit)) return amount * 60 * 1000;
  return amount;
}

function startDynamicHeartbeat(send: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      send();
      schedule();
    }, heartbeatIntervalMs());
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function getQueuedWorkCount(chatId: string): number {
  return workQueues.get(chatId)?.length ?? 0;
}

function formatQueueState(chatId: string): string {
  const queued = getQueuedWorkCount(chatId);
  if (queued > 0) return `队列: 当前会话还有 ${queued} 条等待`;
  return "队列: 当前会话没有等待项";
}

function formatNextInstructionAdvice(chatId: string, status: "busy" | "idle" = "busy"): string {
  const queued = getQueuedWorkCount(chatId);
  if (status === "idle") return "建议: 当前会话空闲，可以发送下一条指令。";
  if (queued > 0) return "建议: 当前会话忙，新指令会继续排队；补充信息可以发送，重复任务建议先等待。";
  return "建议: 当前会话忙，新指令会排队；如果是同一个任务，建议先等待当前结果或用 /status 查看。";
}

function modeLabel(mode: FeishuMessageMode): string {
  return mode === "direct" ? "直连模式" : "桥接模式";
}

function formatCompactTask(task: BridgeTask, index: number, includeChat = false): string {
  const queuePosition = task.status === "queued" ? `队列 ${getQueuePosition(task.chatId, task.id) || "-"}` : "执行中";
  const chat = includeChat ? `｜Chat ${task.chatId.slice(-8)}` : "";
  return [
    `${index}. ${taskStatusText(task.status)}｜${queuePosition}｜${taskElapsed(task)}${chat}`,
    `   ID: ${shortTaskId(task)} (${task.id})`,
    `   任务: ${task.preview}`,
    `   正在: ${task.currentStep || "等待进度更新"}`,
  ].join("\n");
}

function formatTaskHeartbeat(task: BridgeTask): string {
  return formatBlock("Codex 仍在运行", [
    `ID: ${task.id}`,
    `状态: ${taskStatusText(task.status)}｜已运行 ${taskElapsed(task)}`,
    `任务: ${task.preview}`,
    formatQueueState(task.chatId),
    "",
    `可见过程: ${task.progressSummary || task.currentStep || "暂无新的可见过程，Codex 进程仍在运行"}`,
    `已完成: ${formatSteps(task.completedSteps, "等待 Codex 更新", 2)}`,
    `正在: ${task.currentStep || "处理中"}`,
    `后面: ${formatSteps(task.nextSteps, "继续下一步", 2)}`,
    "",
    formatNextInstructionAdvice(task.chatId, "busy"),
    "详情: /td",
  ]);
}

function formatTaskLine(task: BridgeTask): string {
  const queuePosition = task.status === "queued" ? `｜队列 ${getQueuePosition(task.chatId, task.id) || "-"}` : "";
  const error = task.error ? `\n   错误: ${task.error}` : "";
  return [
    `${taskStatusText(task.status)}｜${taskElapsed(task)}${queuePosition}`,
    `ID: ${task.id}`,
    `任务: ${task.preview}`,
    task.currentStep ? `正在: ${task.currentStep}` : "",
    error,
  ]
    .filter(Boolean)
    .join("\n");
}

function getTaskReport(chatId: string): string {
  const chatTasks = [...tasks.values()].filter((task) => task.chatId === chatId);
  const active = chatTasks
    .filter((task) => task.status === "running" || task.status === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recentDone = chatTasks
    .filter((task) => task.status === "done" || task.status === "failed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);

  if (active.length === 0 && recentDone.length === 0) return formatBlock("当前任务", ["暂无任务。"]);

  const lines: string[] = [];
  if (active.length > 0) {
    lines.push(formatBlock("当前未完成", active.map((task, index) => formatCompactTask(task, index + 1))));
  }
  if (recentDone.length > 0) {
    lines.push(
      formatBlock(
        "最近结束",
        recentDone.map((task, index) => {
          const error = task.error ? `｜${task.error}` : "";
          return `${index + 1}. ${taskStatusText(task.status)}｜${taskElapsed(task)}｜${task.preview}${error}`;
        })
      )
    );
  }
  return lines.join("\n\n");
}

function getAllOpenTaskList(): string {
  const openTasks = [...tasks.values()]
    .filter((task) => task.status === "running" || task.status === "queued")
    .sort((a, b) => {
      const rank: Record<TaskStatus, number> = { running: 0, queued: 1, failed: 2, done: 3 };
      const statusRank = rank[a.status] - rank[b.status];
      if (statusRank !== 0) return statusRank;
      return a.createdAt.localeCompare(b.createdAt);
    });

  if (openTasks.length === 0) return formatBlock("未完成任务", ["当前没有未完成任务。"]);

  return formatBlock(
    `未完成任务 ${openTasks.length} 个`,
    [
      ...openTasks.map((task, index) => formatCompactTask(task, index + 1, true)),
      "",
      "详情: /td 1 或 /td <任务ID>",
    ]
  );
}

function getTaskDetail(taskId: string): string {
  const task = tasks.get(taskId);
  if (!task) return `没有找到任务: ${taskId}`;
  return formatTaskDetail(task);
}

function listChatTasksForDetail(chatId: string): BridgeTask[] {
  const rank: Record<TaskStatus, number> = { running: 0, queued: 1, done: 2, failed: 2 };
  return [...tasks.values()]
    .filter((task) => task.chatId === chatId)
    .sort((a, b) => {
      const statusRank = rank[a.status] - rank[b.status];
      if (statusRank !== 0) return statusRank;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

function listChatTasksByUpdated(chatId: string): BridgeTask[] {
  return [...tasks.values()]
    .filter((task) => task.chatId === chatId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getActiveOrLatestTask(chatId: string): BridgeTask | undefined {
  const chatTasks = listChatTasksByUpdated(chatId);
  return chatTasks.find((task) => task.status === "running" || task.status === "queued") ?? chatTasks[0];
}

function getTaskDetailBySelector(chatId: string, selector: string): string {
  const trimmed = selector.trim();
  if (trimmed && !/^\d+$/.test(trimmed)) return getTaskDetail(trimmed);

  const index = Math.max(parseInt(trimmed || "1", 10) || 1, 1);
  const task = listChatTasksForDetail(chatId)[index - 1];
  if (!task) return `没有找到第 ${index} 个任务。`;
  return formatTaskDetail(task, index);
}

function formatTaskDetail(task: BridgeTask, index?: number): string {
  const recentLog = task.progressLog
    .slice(-6)
    .map((log, logIndex) => `${logIndex + 1}. ${log.summary}${log.detail ? `\n   ${log.detail}` : ""}`);

  return formatBlock(`任务详情${index ? ` #${index}` : ""}`, [
    `ID: ${task.id}`,
    `状态: ${taskStatusText(task.status)}｜已运行 ${taskElapsed(task)}｜心跳 ${task.heartbeatCount}`,
    `任务: ${task.preview}`,
    "",
    `进度: ${task.progressSummary || task.currentStep || "暂无进度"}`,
    `已完成: ${formatSteps(task.completedSteps, "暂无", 4)}`,
    `正在: ${task.currentStep || "暂无"}`,
    `后面: ${formatSteps(task.nextSteps, "暂无", 3)}`,
    recentLog.length ? `最近动作:\n${recentLog.join("\n")}` : "",
    task.resultPreview ? `结果摘要: ${task.resultPreview}` : "",
    task.error ? `错误: ${task.error}` : "",
  ]);
}

function truncateFeishuReply(reply: string): string {
  const limit = getConfig().feishuResponseLimit;
  return reply.length > limit ? `${reply.slice(0, limit)}\n\n(截断)` : reply;
}

function formatChatAccepted(item: Extract<ChatWorkItem, { kind: "chat" }>): string {
  const queuePosition = getWorkQueuePosition(item.chatId, item.id);
  return formatBlock("Codex 已收到", [
    `ID: ${item.id}`,
    `内容: ${item.preview}`,
    queuePosition > 0 ? `队列位置: ${queuePosition}` : "队列位置: 即将开始",
    formatNextInstructionAdvice(item.chatId, "busy"),
  ]);
}

function formatChatCompletion(title: string, item: Extract<ChatWorkItem, { kind: "chat" }>, reply: string): string {
  const summary = formatBlock(title, [
    `任务: ${item.preview}`,
    `耗时: ${formatDuration(Date.now() - Date.parse(item.createdAt))}`,
    "状态: 已完成",
    formatQueueState(item.chatId),
    formatNextInstructionAdvice(item.chatId, "idle"),
    "",
    "下一步建议:",
    "1. 如果结果需要继续推进，直接补充你的要求。",
    "2. 如果要长期跟踪进度，使用 /run <任务内容> 创建桥接任务。",
  ]);
  return `${summary}\n\n${truncateFeishuReply(reply)}`;
}

function conversationRunElapsed(run: ConversationRunRecord): string {
  const start = Date.parse(run.startedAt || run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return formatDuration(end - start);
}

function formatConversationHeartbeat(run: ConversationRunRecord, title = "Codex 仍在运行"): string {
  return formatBlock(title, [
    `内容: ${run.preview}`,
    `模式: ${modeLabel(run.mode)}`,
    `已运行: ${conversationRunElapsed(run)}`,
    `可见过程: ${run.latest || "暂无新的可见过程，Codex 进程仍在运行"}`,
    formatQueueState(run.chatId),
    formatNextInstructionAdvice(run.chatId, "busy"),
  ]);
}

function formatConversationRunInterrupted(run: ConversationRunRecord, title = "Codex 执行已中断"): string {
  return formatBlock(title, [
    `内容: ${run.preview}`,
    `模式: ${modeLabel(run.mode)}`,
    `已运行: ${conversationRunElapsed(run)}`,
    `最后进展: ${run.latest || "暂无进展记录"}`,
    run.completedSteps.length ? `已完成: ${formatSteps(run.completedSteps, "暂无", 3)}` : "",
    `原因: ${run.error || "服务停止或重启，Codex 会话没有返回最终结果。"}`,
    "",
    "这不是完成结果。",
    formatNextInstructionAdvice(run.chatId, "idle"),
    "建议: 重新发送原消息；如果需要长期跟踪，使用 /run <任务内容>。",
  ]);
}

function isRestartInterruptedTask(task: BridgeTask): boolean {
  return (
    task.status === "failed" &&
    !task.recoveryNotifiedAt &&
    /服务重启|中断|停止/.test(`${task.error ?? ""} ${task.currentStep ?? ""} ${task.progressSummary ?? ""}`)
  );
}

function formatTaskInterrupted(task: BridgeTask, title = "任务已中断"): string {
  return formatBlock(title, [
    `ID: ${task.id}`,
    `任务: ${task.preview}`,
    `已运行: ${taskElapsed(task)}`,
    `最后进展: ${task.progressSummary || task.currentStep || "暂无进展记录"}`,
    `原因: ${task.error || "服务停止或重启，Codex 没有返回最终结果。"}`,
    "",
    "这不是完成结果。",
    "详情: /td 1",
    "建议: 重新发送任务，或补充“继续处理这个任务”。",
  ]);
}

function formatTaskCompletion(task: BridgeTask, reply: string): string {
  return `${formatBlock("Codex 已完成", [
    `ID: ${task.id}`,
    `任务: ${task.preview}`,
    `耗时: ${taskElapsed(task)}`,
    formatQueueState(task.chatId),
    getQueuedWorkCount(task.chatId) > 0
      ? "建议: 本任务已完成；当前会话还有队列，会继续按顺序处理。"
      : "建议: 当前任务已完成，可以发送下一条指令。",
    "",
    "本次总结:",
    taskPreview(reply).slice(0, 200),
    "",
    "下一步建议:",
    "1. 发送 /td 1 查看完整进度详情。",
    "2. 如果要继续推进，回复“继续下一步”或补充新的明确要求。",
  ])}\n\n${reply}`;
}

function isVagueContinueRequest(message: string): boolean {
  return /^(继续|继续当前任务|继续这个任务|接着做|接着处理)$/i.test(message.trim());
}

function isBridgeProgressQuery(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (/^\/?(task|status|list|td)\b/i.test(text)) return false;
  return (
    /(进度|状态|做到哪|做到哪里|到哪一步|当前到哪|现在到哪|开始了吗|开始了没|处理了没有|在处理了没有|在处理吗|做完了吗|完成了吗|结束了吗|跑完了吗|成功了吗|结果呢|有结果了吗|看下|看一下)/.test(text) &&
    !/(修复|修改|增加|新增|创建|新建|生成|录制|截图|构建|打包|测试|部署|安装|删除|清理|迁移)/.test(text)
  );
}

function formatBridgeProgressReply(chatId: string): string {
  const task = getActiveOrLatestTask(chatId);
  if (!task) {
    return formatBlock("任务进度", [
      "当前没有任务记录。",
      "需要跟踪执行时请使用 /run <任务内容>，或切到桥接模式后发送明确执行请求。",
    ]);
  }

  if (task.status === "running" || task.status === "queued") return formatTaskHeartbeat(task);

  return formatBlock("最近任务进度", [
    `ID: ${task.id}`,
    `状态: ${taskStatusText(task.status)}｜耗时 ${taskElapsed(task)}`,
    `任务: ${task.preview}`,
    `结果: ${task.resultPreview || task.progressSummary || "暂无结果摘要"}`,
    task.error ? `错误: ${task.error}` : "",
    "",
    "详情: /td 1",
  ]);
}

function isExecutionConfirmationRequest(message: string): boolean {
  return !!parseExecutionTargetSelector(message);
}

function isDecisionConfirmationRequest(message: string): boolean {
  return /^(按照你的默认方案来|按你的默认方案来|按照默认方案|按默认方案|默认方案|用默认方案|确认默认方案|按推荐方案|用推荐方案|按你推荐的来|按推荐的来|就按默认|就按你说的|同意默认方案|选A|选择A|A|a|1A|1A、2B、3A|1A,2B,3A|按1A|按1A、2B、3A)$/i.test(message.trim());
}

function parseExecutionTargetSelector(message: string): string | undefined | false {
  const text = message.trim();
  if (isDecisionConfirmationRequest(text)) return undefined;
  const match = text.match(
    /^(执行|执行吧|开始执行|确认执行|继续执行|接着执行|开始做|继续做|做吧|可以执行|立即执行|继续开发|继续实现|继续推进|继续往下做|继续任务|继续试试|继续上面任务|继续上面的任务|继续上个任务|继续上一个任务|继续上条任务|继续上一条任务|继续前一个任务|继续刚才的任务|按这个执行|按上面执行|按刚才执行|按刚才的执行)(?:\s+(.+))?$/i
  );
  if (!match) return false;
  const selector = match[2]?.trim();
  if (!selector) return undefined;
  return selector.replace(/^第\s*/, "").replace(/\s*(个|号|项|个任务|任务)$/i, "").trim();
}

function isQuestionLike(message: string): boolean {
  const text = message.trim();
  if (/[?？]$/.test(text)) return true;
  if (/(吗|呢|么|是否|是不是|能不能|可不可以|合理吗|知道吗)/.test(text)) return true;
  return /^(为什么|为啥|怎么|如何|什么|哪个|哪里|多少|请问|你觉得|你知道|能解释|能说下)/.test(text);
}

function classifyMessageIntent(message: string): "chat" | "task" | "confirm" {
  const text = message.trim();
  if (!text) return "chat";
  if (isBridgeProgressQuery(text)) return "chat";
  if (isQuestionLike(text)) return "chat";
  if (isVagueContinueRequest(text)) return "confirm";

  const strongTaskPattern =
    /(增加|新增|修改|修复|优化|实现|开发|新建|创建|复制|启动|重启|测试|验证|部署|安装|配置|接入|删除|清理|迁移|改成|加个|做一个|写一个|处理下面|完成|生成|保存|同步|导出|导入|截图|录制|录像|拍个|发视频|构建|打包|运行|打开|找一找|查找)/;
  const actionLeadPattern = /^(帮我|请|你帮我|麻烦|给我|把|将|继续|直接|现在|那你|你)/;
  if (strongTaskPattern.test(text) && (actionLeadPattern.test(text) || text.length <= 80)) return "task";

  const ambiguousTaskPattern = /(帮我|处理|继续|看看|看一下|分析一下|整理一下|优化一下|修一下|改一下|任务|需求)/;
  if (ambiguousTaskPattern.test(text)) return "confirm";

  return "chat";
}

async function classifyMessageIntentHybrid(message: string): Promise<{ intent: "chat" | "task" | "confirm"; taskText: string; reason?: string }> {
  const localIntent = classifyMessageIntent(message);
  if (localIntent !== "confirm") return { intent: localIntent, taskText: message };
  if (!getConfig().intentClassifierEnabled) {
    return { intent: "confirm", taskText: message, reason: "本地规则无法确定，Codex 分类已关闭" };
  }

  const aiIntent = await classifyIntentWithCodex(message, getConfig().intentClassifierTimeoutMs);
  if (!aiIntent) return { intent: "confirm", taskText: message, reason: "本地规则无法确定，AI 分类超时或失败" };
  return {
    intent: aiIntent.intent,
    taskText: aiIntent.taskText || message,
    reason: aiIntent.reason,
  };
}

function getPendingTaskConfirmation(chatId: string): PendingTaskConfirmation | undefined {
  const pending = pendingTaskConfirmations.get(chatId);
  if (!pending) return undefined;
  if (Date.now() - Date.parse(pending.createdAt) > 10 * 60 * 1000) {
    pendingTaskConfirmations.delete(chatId);
    return undefined;
  }
  return pending;
}

function isTaskConfirmationAccept(message: string): boolean {
  return /^(确认|确认生成任务|生成任务|作为任务|是|对|好|可以|创建任务|建立任务)$/i.test(message.trim()) || isExecutionConfirmationRequest(message);
}

function isTaskConfirmationChat(message: string): boolean {
  return /^(普通回答|作为会话|只回答|不要生成任务|不生成任务|不用|否|不是任务)$/i.test(message.trim());
}

function isTaskConfirmationCancel(message: string): boolean {
  return /^(取消|算了|忽略|不用处理)$/i.test(message.trim());
}

async function askTaskConfirmation(chatId: string, message: string, mode: FeishuMessageMode = getConfig().feishuMessageMode) {
  const pending: PendingTaskConfirmation = {
    chatId,
    message,
    preview: taskPreview(message),
    mode,
    createdAt: nowIso(),
  };
  pendingTaskConfirmations.set(chatId, pending);
  await sendFeishuText(
    chatId,
    formatBlock("需要确认", [
      "我判断这可能是一个需要跟踪进度的任务，但还不够确定。",
      `内容: ${pending.preview}`,
      "",
      "回复以下任意一种:",
      "确认生成任务",
      "普通回答",
      "取消",
    ]),
    mode
  );
}

async function handlePendingTaskConfirmation(chatId: string, message: string): Promise<boolean> {
  const pending = getPendingTaskConfirmation(chatId);
  if (!pending) return false;

  if (isTaskConfirmationAccept(message)) {
    pendingTaskConfirmations.delete(chatId);
    await enqueueTrackedTask(chatId, pending.message, pending.mode);
    return true;
  }

  if (isTaskConfirmationChat(message)) {
    pendingTaskConfirmations.delete(chatId);
    await sendFeishuText(chatId, formatBlock("普通会话", ["已按普通问答处理，不加入任务列表。"]), pending.mode);
    createChatWork(chatId, pending.message, pending.mode);
    void processChatQueue(chatId);
    return true;
  }

  if (isTaskConfirmationCancel(message)) {
    pendingTaskConfirmations.delete(chatId);
    await sendFeishuText(chatId, formatBlock("已取消", ["没有创建任务，也没有继续处理该消息。"]), pending.mode);
    return true;
  }

  return false;
}

function findChatTaskBySelector(chatId: string, selector: string): BridgeTask | undefined {
  const clean = selector.trim();
  if (!clean) return undefined;

  if (/^\d+$/.test(clean)) {
    const index = Math.max(parseInt(clean, 10) || 1, 1);
    return listChatTasksForDetail(chatId)[index - 1];
  }

  return listChatTasksByUpdated(chatId).find((task) => task.id === clean || task.id.startsWith(clean));
}

function buildContinueTaskMessage(task: BridgeTask, userMessage: string): string {
  const context = task.resultPreview
    ? `上一任务结果摘要：${task.resultPreview}`
    : task.error
      ? `上一任务失败信息：${task.error}`
      : `上一任务状态：${taskStatusText(task.status)}，${task.progressSummary || task.currentStep || "暂无进度"}`;

  return [
    "继续执行上一条飞书任务。",
    `用户回复：${userMessage}`,
    `上一任务ID：${task.id}`,
    `上一任务原始内容：${task.message}`,
    context,
    "要求：从上一任务停止处继续推进；如果需要用户决策，先给出清晰选项并等待用户确认。",
  ].join("\n");
}

function taskHasDecisionContext(task: BridgeTask): boolean {
  const logText = task.progressLog
    .slice(-8)
    .map((log) => `${log.summary} ${log.detail ?? ""}`)
    .join(" ");
  return /决策|确认|默认建议|默认方案|推荐选项|推荐方案|必须确认|选项|1A|2B|3A/i.test(
    `${task.message} ${task.resultPreview ?? ""} ${logText}`
  );
}

async function handleExecutionConfirmation(chatId: string, message: string): Promise<boolean> {
  const mode: FeishuMessageMode = "bridge";
  const selector = parseExecutionTargetSelector(message);
  if (selector === false) return false;
  const isDecisionConfirmation = isDecisionConfirmationRequest(message);

  const recentTasks = listChatTasksByUpdated(chatId);
  const selectedTask = selector ? findChatTaskBySelector(chatId, selector) : undefined;
  if (selector && !selectedTask) {
    await sendFeishuText(
      chatId,
      formatBlock("没有找到任务", [
        `目标: ${selector}`,
        "可以发送 /td 1 查看详情，或发送 /list 查看未完成任务。",
      ]),
      mode
    );
    return true;
  }

  const active = selectedTask?.status === "running" || selectedTask?.status === "queued"
    ? selectedTask
    : !selectedTask
      ? recentTasks.find((task) => task.status === "running" || task.status === "queued")
      : undefined;
  if (active) {
    await sendFeishuText(
      chatId,
      formatBlock("已有任务在处理", [
        `ID: ${active.id}`,
        `状态: ${taskStatusText(active.status)}`,
        `任务: ${active.preview}`,
        "",
        "详情: /td",
        "列表: /list",
      ]),
      mode
    );
    return true;
  }

  const latest = selectedTask ?? recentTasks[0];
  if (!latest) {
    await sendFeishuText(
      chatId,
      formatBlock("需要补充任务范围", [
        "没有找到可继续执行的历史任务。",
        "请直接说明要执行什么，或使用 /run <任务内容>。",
      ]),
      mode
    );
    return true;
  }

  if (isDecisionConfirmation && !taskHasDecisionContext(latest)) {
    await sendFeishuText(
      chatId,
      formatBlock("需要指定任务", [
        "这像是在确认某个方案，但最近任务里没有找到明确决策上下文。",
        `最近任务: ${latest.preview}`,
        "",
        "建议:",
        `/td 1 查看详情`,
        `执行 ${latest.id}`,
      ]),
      mode
    );
    return true;
  }

  if (!selectedTask && Date.now() - Date.parse(latest.updatedAt) > BARE_EXECUTION_MAX_AGE_MS) {
    const maxAge = isDecisionConfirmation ? DECISION_CONFIRMATION_MAX_AGE_MS : BARE_EXECUTION_MAX_AGE_MS;
    if (Date.now() - Date.parse(latest.updatedAt) <= maxAge) {
      await enqueueTrackedTask(chatId, buildContinueTaskMessage(latest, message), mode);
      return true;
    }

    await sendFeishuText(
      chatId,
      formatBlock("需要指定任务", [
        "最近任务距离现在较久，直接“执行”可能会接错上下文。",
        `最近任务: ${latest.preview}`,
        "",
        "建议:",
        `/td 1 查看详情`,
        `执行 ${latest.id}`,
      ]),
      mode
    );
    return true;
  }

  await enqueueTrackedTask(chatId, buildContinueTaskMessage(latest, message), mode);
  return true;
}

type DirectProgressState = {
  lastSentAt: number;
  lastText: string;
  latest: string;
  count: number;
  run: ConversationRunRecord;
};

function formatDirectProgress(chatId: string, event: CodexProgressEvent): string {
  const detail = event.detail ? `\n细节: ${event.detail}` : "";
  return formatBlock("Codex 进展", [`可见过程: ${event.summary}${detail}`, formatNextInstructionAdvice(chatId, "busy")]);
}

function pushDirectProgress(chatId: string, event: CodexProgressEvent, state: DirectProgressState) {
  updateConversationRunProgress(state.run, event);

  const text = formatDirectProgress(chatId, event);
  const now = Date.now();
  const progressIntervalMs = Math.max(getConfig().taskHeartbeatMs, 60000);
  const shouldSend =
    state.count < 1 ||
    event.type === "completed" ||
    now - state.lastSentAt >= progressIntervalMs;
  if (!shouldSend || text === state.lastText) return;

  state.lastSentAt = now;
  state.lastText = text;
  state.latest = event.detail || event.summary;
  state.count += 1;
  void sendFeishuTextSafe(chatId, text, "direct");
}

async function processDirectChatWork(item: Extract<ChatWorkItem, { kind: "chat" }>) {
  console.log(`[Direct] start ${item.id} ${item.chatId.slice(-8)}: ${item.preview}`);
  const run = createConversationRun(item);
  await sendFeishuTextSafe(
    item.chatId,
    formatBlock("Codex 开始处理", [
      `ID: ${item.id}`,
      `内容: ${item.preview}`,
      "模式: 飞书 ⇄ Codex",
      `心跳: 每 ${formatDuration(heartbeatIntervalMs())} 反馈一次`,
      formatQueueState(item.chatId),
      formatNextInstructionAdvice(item.chatId, "busy"),
    ]),
    "direct"
  );

  const progress: DirectProgressState = {
    lastSentAt: 0,
    lastText: "",
    latest: "Codex 正在处理",
    count: 0,
    run,
  };
  const stopHeartbeat = startDynamicHeartbeat(() => {
    updateConversationRunHeartbeat(run, progress.latest);
    void sendFeishuTextSafe(item.chatId, formatConversationHeartbeat(run), "direct");
  });

  try {
    const config = getConfig();
    const reply = await sendPrompt(item.chatId, item.message, {
      timeoutMs: Math.max(config.directReplyTimeoutMs, config.chatTimeoutMs, 60000),
      onProgress: (event) => pushDirectProgress(item.chatId, event, progress),
    });
    finishConversationRun(run, "done", { result: reply, latest: "Codex 已完成并返回结果" });
    if (await sendFeishuTextTracked(item.chatId, formatChatCompletion("直连完成", item, reply), "direct")) {
      markConversationRunNotified(run, "finalNotifiedAt");
    }
    console.log(`  [Direct] ${item.id} done`);
  } catch (err) {
    const message = (err as Error).message;
    finishConversationRun(run, "failed", { error: message });
    if (await sendFeishuTextTracked(
      item.chatId,
      formatBlock("直连失败", [
        `错误: ${message}`,
        `最后进展: ${run.latest || progress.latest}`,
        formatQueueState(item.chatId),
        formatNextInstructionAdvice(item.chatId, "idle"),
        "飞书连接仍保持，可以继续发送消息。",
        "需要任务跟踪时可使用 /run <任务内容>，或 /mode bridge 切回桥接模式。",
      ]),
      "direct"
    )) {
      markConversationRunNotified(run, "finalNotifiedAt");
    }
    console.error(`[Direct] failed ${item.id}: ${message}`);
  } finally {
    stopHeartbeat();
  }
}

async function processChatWork(item: Extract<ChatWorkItem, { kind: "chat" }>) {
  if (item.mode === "direct") {
    await processDirectChatWork(item);
    return;
  }

  console.log(`[Chat] start ${item.id} ${item.chatId.slice(-8)}: ${item.preview}`);
  if (isVagueContinueRequest(item.message)) {
    await sendFeishuTextSafe(
      item.chatId,
      formatBlock("需要补充任务范围", [
        "这条消息没有进入任务列表。",
        "“继续当前任务”容易跑偏或超时。",
        "",
        "建议:",
        "/list 查看未完成任务",
        "/td 1 查看第一个任务详情",
        "也可以直接说清楚要继续哪个任务",
      ]),
      "bridge"
    );
    return;
  }

  const run = createConversationRun(item);
  await sendFeishuTextSafe(
    item.chatId,
    formatBlock("Codex 开始处理", [
      `ID: ${item.id}`,
      `内容: ${item.preview}`,
      "这条消息不会进入任务列表。",
      `心跳: 每 ${formatDuration(heartbeatIntervalMs())} 反馈一次`,
      formatQueueState(item.chatId),
      formatNextInstructionAdvice(item.chatId, "busy"),
      "完成后会发送结果总结和下一步建议。",
    ]),
    "bridge"
  );

  const stopHeartbeat = startDynamicHeartbeat(() => {
    updateConversationRunHeartbeat(run);
    void sendFeishuTextSafe(item.chatId, formatConversationHeartbeat(run), "bridge");
  });

  try {
    const reply = await sendPrompt(item.chatId, item.message, {
      timeoutMs: getConfig().chatTimeoutMs,
      onProgress: (event) => updateConversationRunProgress(run, event),
    });
    finishConversationRun(run, "done", { result: reply, latest: "Codex 已完成并返回结果" });
    if (await sendFeishuTextTracked(item.chatId, formatChatCompletion("会话完成", item, reply), "bridge")) {
      markConversationRunNotified(run, "finalNotifiedAt");
    }
    console.log(`  [Chat] ${item.id} done`);
  } catch (err) {
    const message = (err as Error).message;
    finishConversationRun(run, "failed", { error: message });
    if (await sendFeishuTextTracked(
      item.chatId,
      formatBlock("会话失败", [
        `错误: ${message}`,
        `最后进展: ${run.latest}`,
        formatQueueState(item.chatId),
        formatNextInstructionAdvice(item.chatId, "idle"),
      ]),
      "bridge"
    )) {
      markConversationRunNotified(run, "finalNotifiedAt");
    }
    console.error(`[Chat] failed ${item.id}: ${message}`);
  } finally {
    stopHeartbeat();
  }
}

async function processChatQueue(chatId: string) {
  if (runningChats.has(chatId)) return;
  runningChats.add(chatId);

  try {
    const queue = workQueues.get(chatId) ?? [];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.kind === "chat") {
        await processChatWork(item);
        continue;
      }

      const task = item.task;
      const startedAt = nowIso();
      task.status = "running";
      task.startedAt = startedAt;
      task.updatedAt = startedAt;
      task.currentStep = "Codex 准备处理任务";
      task.progressSummary = "任务已开始";
      task.nextSteps = ["调用 Codex 执行任务"];
      task.progressLog.push({ at: startedAt, type: "started", summary: "任务已开始处理" });
      saveTaskState();

      console.log(`[Task] start ${task.id} ${chatId.slice(-8)}: ${task.preview}`);
      await sendFeishuTextSafe(
        chatId,
        formatBlock("Codex 开始处理", [
          `ID: ${task.id}`,
          `任务: ${task.preview}`,
          `心跳: 每 ${formatDuration(heartbeatIntervalMs())} 反馈一次`,
          formatQueueState(chatId),
          formatNextInstructionAdvice(chatId, "busy"),
          "完成后会发送任务总结和下一步建议。",
          "",
          "详情: /td",
          "未完成列表: /list",
        ]),
        task.mode
      );

      const stopHeartbeat = startDynamicHeartbeat(() => {
        task.heartbeatCount += 1;
        task.updatedAt = nowIso();
        saveTaskState();
        void sendFeishuTextSafe(chatId, formatTaskHeartbeat(task), task.mode);
      });

      try {
        const reply = await sendPrompt(chatId, task.message, {
          onProgress: (event) => recordTaskProgress(task, event),
        });
        const out = truncateFeishuReply(reply);
        const finishedAt = nowIso();
        task.status = "done";
        task.finishedAt = finishedAt;
        task.updatedAt = finishedAt;
        task.currentStep = "任务已完成";
        task.progressSummary = "最终结果已返回";
        updateNextSteps(task);
        task.resultPreview = taskPreview(out).slice(0, 200);
        task.progressLog.push({ at: finishedAt, type: "completed", summary: "任务完成，已发送结果" });
        task.progressLog = task.progressLog.slice(-40);
        saveTaskState();
        await sendFeishuTextSafe(chatId, formatTaskCompletion(task, out), task.mode);
        console.log(`  [Codex] ${task.id} ${out.slice(0, 60)}`);
      } catch (err) {
        const message = (err as Error).message;
        const finishedAt = nowIso();
        task.status = "failed";
        task.finishedAt = finishedAt;
        task.updatedAt = finishedAt;
        task.error = message;
        task.currentStep = "任务失败";
        task.progressSummary = message;
        updateNextSteps(task);
        task.progressLog.push({ at: finishedAt, type: "info", summary: "任务失败", detail: message.slice(0, 180) });
        task.progressLog = task.progressLog.slice(-40);
        saveTaskState();
        await sendFeishuTextSafe(
          chatId,
          formatBlock("任务失败", [
            `ID: ${task.id}`,
            `错误: ${message}`,
            `最后进展: ${task.progressSummary || task.currentStep || "暂无进展记录"}`,
            formatQueueState(chatId),
            formatNextInstructionAdvice(chatId, "idle"),
            "",
            "队列: /list",
            "详情: /td",
          ]),
          task.mode
        );
        console.error(`[Task] failed ${task.id}: ${message}`);
      } finally {
        stopHeartbeat();
        pruneTaskHistory();
        saveTaskState();
      }
    }
  } finally {
    runningChats.delete(chatId);
    if ((workQueues.get(chatId) ?? []).length > 0) void processChatQueue(chatId);
  }
}

function extractTrackedTaskText(text: string): string | null {
  const trimmed = text.trim();
  const prefixRules = ["/run ", "/task new ", "/task add ", "任务：", "任务:"];
  for (const prefix of prefixRules) {
    if (trimmed.startsWith(prefix)) {
      const content = trimmed.slice(prefix.length).trim();
      return content || null;
    }
  }
  return null;
}

function validateTrackedTaskText(message: string): string | null {
  if (!isVagueContinueRequest(message)) return null;
  return formatBlock("任务描述不明确", [
    "没有创建任务。",
    "“继续当前任务”缺少具体目标，容易导致长时间超时。",
    "",
    "你可以这样发:",
    "/list",
    "/td 1",
    "/run 继续 mp6on3po-19b4ee 的失败原因并给出下一步",
  ]);
}

async function handleCommand(chatId: string, text: string): Promise<string | null> {
  if (text === "/run" || text === "/task new" || text === "/task add") {
    return formatBlock("任务内容缺失", [
      "请写完整任务内容。",
      "你可以直接自然表达，我会判断是否需要建任务。",
      "快捷写法: /run 新建一个古代恐龙幼儿科普项目",
    ]);
  }

  if (text === "/reset") {
    await resetSession(chatId);
    return formatBlock("会话重置", ["当前 Codex 会话已重置。", "工作区已保留。"]);
  }

  if (text === "/mode") {
    const config = getConfig();
    return formatBlock("消息模式", [
      `当前: ${modeLabel(config.feishuMessageMode)}`,
      config.feishuMessageMode === "direct"
        ? "普通飞书消息会直接进入 Codex，并把阶段进展直接发回飞书。"
        : "普通飞书消息会经过意图识别、任务确认和队列跟踪。",
      "",
      "切换: /mode direct 或 /mode bridge",
    ]);
  }

  if (/^\/mode\s+/i.test(text)) {
    const target = text.slice("/mode".length).trim().toLowerCase();
    if (!["direct", "bridge"].includes(target)) {
      return formatBlock("模式错误", ["只支持: /mode direct 或 /mode bridge"]);
    }
    const config = saveConfig({ feishuMessageMode: target });
    return formatBlock("消息模式已切换", [`当前: ${modeLabel(config.feishuMessageMode)}`, "该设置立即生效。"]);
  }

  if (text === "/heartbeat" || text === "/hb") {
    return formatBlock("心跳设置", [
      `当前: ${formatDuration(heartbeatIntervalMs())}`,
      "修改: /heartbeat 30s",
      "也支持: /heartbeat 60000、/hb 2m",
      "范围: 最低 15 秒；运行中任务会在下一次心跳后使用新间隔。",
    ]);
  }

  if (/^\/(?:heartbeat|hb)\s+/i.test(text)) {
    const raw = text.replace(/^\/(?:heartbeat|hb)\s+/i, "").trim();
    const parsed = parseHeartbeatIntervalInput(raw);
    if (!parsed) {
      return formatBlock("心跳设置错误", [
        "格式示例: /heartbeat 30s",
        "也支持: /heartbeat 60000、/hb 2m",
        "最低 15 秒。",
      ]);
    }
    const nextMs = Math.max(parsed, 15000);
    saveConfig({ taskHeartbeatMs: String(nextMs) });
    return formatBlock("心跳已更新", [
      `当前: ${formatDuration(heartbeatIntervalMs())}`,
      parsed < 15000 ? "你设置的值低于 15 秒，已自动按 15 秒处理。" : "",
      "运行中的任务会在下一次心跳后使用新间隔。",
      "查看状态: /status",
    ]);
  }

  if (text === "/status") {
    const session = getChatStatus(chatId);
    const { queuedTasks, runningTasks } = getTaskCounts();
    const autoEvolution = getEvolutionSchedulerStatus();
    const config = getConfig();
    const activeRun = getActiveConversationRun(chatId);
    const activeTask = [...tasks.values()]
      .filter((task) => task.chatId === chatId && (task.status === "running" || task.status === "queued"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const currentState = activeRun || activeTask || runningChats.has(chatId) || getQueuedWorkCount(chatId) > 0 ? "忙" : "空闲";
    const latestProgress = activeRun?.latest || activeTask?.progressSummary || activeTask?.currentStep || "暂无运行中的进展";
    return formatBlock("运行状态", [
      `Codex: ${codexAvailable ? "已就绪" : "未就绪"}`,
      `消息模式: ${modeLabel(config.feishuMessageMode)}`,
      `当前会话: ${currentState}`,
      `工作区: ${session.workspaceDir}`,
      `会话: ${session.threadId ?? "尚未创建"}`,
      `活跃会话: ${getSessionCount()}`,
      `任务: 执行中 ${runningTasks}｜排队 ${queuedTasks}`,
      activeRun ? `当前运行: ${activeRun.id}｜已运行 ${conversationRunElapsed(activeRun)}` : "",
      activeTask ? `当前任务: ${activeTask.id}｜${taskStatusText(activeTask.status)}｜${taskElapsed(activeTask)}` : "",
      `最近进展: ${latestProgress}`,
      formatQueueState(chatId),
      `心跳: ${formatDuration(heartbeatIntervalMs())}`,
      formatNextInstructionAdvice(chatId, currentState === "空闲" ? "idle" : "busy"),
      `自动复盘: ${
        autoEvolution.enabled
          ? `${autoEvolution.timerActive ? "运行中" : "未运行"}｜${formatDuration(autoEvolution.intervalMs)}/次`
          : "关闭"
      }`,
      `下次复盘: ${formatLocalTime(autoEvolution.nextRunAt)}｜${formatTimeUntil(autoEvolution.nextRunAt)}`,
      "",
      "指令: /mode 模式，/list 未完成任务，/td 详情，/evo status 自动化状态",
    ]);
  }

  if (text === "/evo status") {
    return formatEvolutionSchedulerStatus();
  }

  if (text === "/evo") {
    const latest = evolutionReports[evolutionReports.length - 1] ?? runEvolutionCheck("manual");
    return formatEvolutionReport(latest);
  }

  if (text === "/evo run") {
    return formatEvolutionReport(runEvolutionCheck("manual"));
  }

  if (text === "/list") return getAllOpenTaskList();

  if (text === "/task") return getTaskReport(chatId);

  if (text.startsWith("/task ")) {
    const taskId = text.slice("/task ".length).trim();
    return getTaskDetail(taskId);
  }

  if (text === "/td") return getTaskDetailBySelector(chatId, "1");

  if (text.startsWith("/td ")) {
    return getTaskDetailBySelector(chatId, text.slice("/td ".length));
  }

  if (text === "/workspace") {
    const session = getChatStatus(chatId);
    return formatBlock("当前工作区", [`路径: ${session.workspaceDir}`, `会话: ${session.threadId ?? "尚未创建"}`]);
  }

  if (text.startsWith("/workspace ")) {
    const workspaceDir = text.slice("/workspace ".length).trim();
    if (!workspaceDir) return formatBlock("参数缺失", ["请提供工作区路径。", "示例: /workspace E:\\unity-projects"]);
    const session = await setWorkspace(chatId, workspaceDir);
    return formatBlock("工作区已切换", [`路径: ${session.workspaceDir}`, "已开启新的 Codex 会话。"]);
  }

  return null;
}

async function notifyStartupRecoveries() {
  let runChanged = false;
  for (const run of conversationRuns.values()) {
    if (run.status !== "interrupted" || run.recoveryNotifiedAt || run.finalNotifiedAt) continue;
    if (await sendFeishuTextTracked(run.chatId, formatConversationRunInterrupted(run, "上次 Codex 执行已中断"), run.mode)) {
      run.recoveryNotifiedAt = nowIso();
      run.updatedAt = run.recoveryNotifiedAt;
      runChanged = true;
    }
  }
  if (runChanged) saveConversationRunState();

  let taskChanged = false;
  for (const task of tasks.values()) {
    if (!isRestartInterruptedTask(task)) continue;
    if (await sendFeishuTextTracked(task.chatId, formatTaskInterrupted(task, "上次任务已中断"), task.mode)) {
      task.recoveryNotifiedAt = nowIso();
      task.updatedAt = task.recoveryNotifiedAt;
      taskChanged = true;
    }
  }
  if (taskChanged) saveTaskState();
}

async function markActiveWorkInterrupted(reason: string, title = "Codex 执行已停止") {
  const now = nowIso();
  let runChanged = false;
  for (const run of conversationRuns.values()) {
    if (run.status !== "running") continue;
    run.status = "interrupted";
    run.finishedAt = now;
    run.updatedAt = now;
    run.error = reason;
    run.latest ||= "服务停止前没有记录到 Codex 进展";
    runChanged = true;
    if (await sendFeishuTextTracked(run.chatId, formatConversationRunInterrupted(run, title), run.mode)) {
      run.recoveryNotifiedAt = nowIso();
      run.updatedAt = run.recoveryNotifiedAt;
    }
  }
  if (runChanged) saveConversationRunState();

  let taskChanged = false;
  for (const task of tasks.values()) {
    if (task.status !== "running" && task.status !== "queued") continue;
    task.status = "failed";
    task.finishedAt = now;
    task.updatedAt = now;
    task.error = reason;
    task.currentStep = "任务已被服务停止中断";
    task.progressSummary = task.progressSummary || "服务停止前没有记录到更多进展";
    task.nextSteps = ["重新发送任务", "或补充继续处理的要求"];
    task.progressLog.push({ at: now, type: "info", summary: "服务停止，任务未完成", detail: reason });
    task.progressLog = task.progressLog.slice(-40);
    taskChanged = true;
    if (await sendFeishuTextTracked(task.chatId, formatTaskInterrupted(task, "任务已停止"), task.mode)) {
      task.recoveryNotifiedAt = nowIso();
      task.updatedAt = task.recoveryNotifiedAt;
    }
  }
  if (taskChanged) saveTaskState();
}

async function prepareShutdown(reason: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (evolutionTimer) {
    clearInterval(evolutionTimer);
    evolutionTimer = undefined;
    evolutionScheduler.timerActive = false;
  }
  await markActiveWorkInterrupted(reason, "Codex 执行已停止");
}

function exitAfterGracefulShutdown(reason: string) {
  void (async () => {
    await prepareShutdown(reason);
    httpServer?.close();
    setTimeout(() => process.exit(0), 300);
  })();
}

process.once("SIGINT", () => exitAfterGracefulShutdown("服务收到停止信号，当前 Codex 执行已中断。"));
process.once("SIGTERM", () => exitAfterGracefulShutdown("服务收到终止信号，当前 Codex 执行已中断。"));
process.once("SIGBREAK", () => exitAfterGracefulShutdown("服务收到控制台中断信号，当前 Codex 执行已中断。"));

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      const msg = data?.message;
      if (!msg?.chat_id || !msg?.message_id) return;
      if (!rememberMessage(msg.message_id)) return;

      let text = "";
      try {
        text = JSON.parse(msg.content ?? "{}").text?.trim() ?? "";
      } catch {
        text = msg.content ?? "";
      }
      if (!text) return;

      const messageMode = getConfig().feishuMessageMode;
      recordMessage({
        chatId: msg.chat_id,
        mode: messageMode,
        direction: "inbound",
        status: "received",
        text,
        feishuMessageId: msg.message_id,
      });
      console.log(`[WS] ${msg.chat_id.slice(-8)}: ${text.slice(0, 60)}`);

      try {
        const trackedTaskText = extractTrackedTaskText(text);
        if (trackedTaskText) {
          if (!codexAvailable) {
            recordInteraction(msg.chat_id, text, "codex_not_ready", "explicit task", messageMode);
            await sendFeishuText(msg.chat_id, formatBlock("Codex 未就绪", ["服务还没有完成初始化，请稍后重试。"]), messageMode);
            return;
          }

          recordInteraction(msg.chat_id, text, "explicit_task", undefined, messageMode);
          await enqueueTrackedTask(msg.chat_id, trackedTaskText, messageMode);
          return;
        }

        const commandReply = await handleCommand(msg.chat_id, text);
        if (commandReply) {
          recordInteraction(msg.chat_id, text, "command", undefined, messageMode);
          await sendFeishuText(msg.chat_id, commandReply, messageMode);
          return;
        }

        if (await handlePendingTaskConfirmation(msg.chat_id, text)) {
          recordInteraction(msg.chat_id, text, "pending_confirmation", undefined, messageMode);
          return;
        }

        if (!codexAvailable) {
          recordInteraction(msg.chat_id, text, "codex_not_ready", undefined, messageMode);
          await sendFeishuText(msg.chat_id, formatBlock("Codex 未就绪", ["服务还没有完成初始化，请稍后重试。"]), messageMode);
          return;
        }

        if (messageMode === "direct") {
          recordInteraction(msg.chat_id, text, "direct_chat", undefined, messageMode);
          const work = createChatWork(msg.chat_id, text, "direct");
          await sendFeishuText(msg.chat_id, formatChatAccepted(work), messageMode);
          void processChatQueue(msg.chat_id);
          return;
        }

        if (isBridgeProgressQuery(text)) {
          recordInteraction(msg.chat_id, text, "progress_query", undefined, messageMode);
          await sendFeishuText(msg.chat_id, formatBridgeProgressReply(msg.chat_id), messageMode);
          return;
        }

        if (await handleExecutionConfirmation(msg.chat_id, text)) {
          recordInteraction(msg.chat_id, text, "execution_continue", undefined, messageMode);
          return;
        }

        const intent = await classifyMessageIntentHybrid(text);
        if (intent.intent === "task") {
          recordInteraction(msg.chat_id, text, "intent_task", intent.reason, messageMode);
          await enqueueTrackedTask(msg.chat_id, intent.taskText, messageMode);
          return;
        }

        if (intent.intent === "confirm") {
          recordInteraction(msg.chat_id, text, "intent_confirm", intent.reason, messageMode);
          await askTaskConfirmation(msg.chat_id, text, messageMode);
          return;
        }

        recordInteraction(msg.chat_id, text, "chat", undefined, messageMode);
        const work = createChatWork(msg.chat_id, text, "bridge");
        await sendFeishuText(msg.chat_id, formatChatAccepted(work), messageMode);
        void processChatQueue(msg.chat_id);
      } catch (e) {
        recordInteraction(msg.chat_id, text, "error", e instanceof Error ? e.message : JSON.stringify(e), messageMode);
        console.error("[WS] ERROR:", e instanceof Error ? e.stack : JSON.stringify(e));
      }
    },
  }),
});

console.log("[WS] WebSocket client started");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.use((req: any, _res, next) => {
  req.cookies = {};
  (req.headers.cookie ?? "").split(";").forEach((cookie: string) => {
    const [key, ...value] = cookie.trim().split("=");
    if (key) req.cookies[key] = value.join("=");
  });
  next();
});

const webSessions = new Map<string, number>();
app.use((req, res, next) => {
  if (req.path === "/login" || req.path === "/health" || req.path === "/internal/shutdown") return next();
  const token = req.cookies?.bridge_token;
  if (token && webSessions.get(token) && Date.now() < webSessions.get(token)!) return next();
  if (req.headers["content-type"]?.includes("json")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.redirect("/login");
});

app.post("/internal/shutdown", async (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || "");
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) {
    res.status(403).json({ error: "local_only" });
    return;
  }
  await prepareShutdown("服务正在重启，当前 Codex 执行已中断。");
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});

app.get(
  "/login",
  (_req, res) =>
    res.type("html").send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Codex Bridge</title><style>*{margin:0;padding:0;box-sizing:border-box}body{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f0f12;font-family:system-ui}.c{background:#1a1a20;border:1px solid #2a2a35;border-radius:8px;padding:40px;width:360px;text-align:center}h1{color:#e0e0e0;font-size:20px;margin-bottom:6px}p{color:#777;font-size:13px;margin-bottom:24px}input{width:100%;padding:12px;background:#0f0f12;border:1px solid #2a2a35;border-radius:8px;color:#e0e0e0;font-size:15px;font-family:monospace;outline:none}input:focus{border-color:#4a7cff}button{width:100%;margin-top:14px;padding:12px;background:#4a7cff;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}button:hover{background:#3a6aee}.err{color:#ff4d4d;font-size:13px;margin-top:10px;display:none}.err.show{display:block}</style></head><body><div class="c"><h1>Codex Bridge</h1><p>请输入授权码</p><form id="f"><input type="text" name="username" autocomplete="username" value="bridge" hidden><input id="code" type="password" placeholder="授权码" autocomplete="current-password" autofocus><button type="submit">登录</button><div class="err" id="err">授权码错误</div></form></div><script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'code='+encodeURIComponent(document.getElementById('code').value)});if(r.ok)location.href='/';else document.getElementById('err').classList.add('show')})</script></body></html>`)
);

app.post("/login", (req, res) => {
  if ((req.body.code ?? "") === getConfig().bridgeAuthCode) {
    const token = crypto.randomBytes(32).toString("hex");
    webSessions.set(token, Date.now() + SESSION_TTL);
    res.cookie("bridge_token", token, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: SESSION_TTL,
    });
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "invalid" });
  }
});

app.post("/logout", (_req, res) => {
  res.clearCookie("bridge_token");
  res.redirect("/login");
});
app.get("/logout", (_req, res) => {
  res.clearCookie("bridge_token");
  res.redirect("/login");
});

app.get("/", (_req, res) => {
  const config = getConfig();
  const sessions = listSessions();
  const recentTasks = [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
  const { queuedTasks, runningTasks } = getTaskCounts();
  const autoEvolution = getEvolutionSchedulerStatus();
  const body = `
<div class="top"><div class="brand"><h1>Codex Bridge</h1><p>飞书长连接已启动，默认工作区 ${escapeHtml(config.defaultWorkspaceDir)}</p></div><div class="nav"><a href="/logs">日志</a><a href="/settings">工作区设置</a><a href="/logout">退出</a></div></div>
<section class="grid">
  <div class="panel"><div class="label">Codex</div><div class="metric ${codexAvailable ? "ok" : "bad"}">${codexAvailable ? "已就绪" : "未就绪"}</div></div>
  <div class="panel"><div class="label">消息模式</div><div class="metric small">${escapeHtml(modeLabel(config.feishuMessageMode))}</div></div>
  <div class="panel"><div class="label">飞书会话</div><div class="metric">${sessions.length}</div></div>
  <div class="panel"><div class="label">沙盒模式</div><div class="metric">${config.codexDisableSandbox ? "关闭" : "开启"}</div></div>
  <div class="panel"><div class="label">运行任务</div><div class="metric">${runningTasks}</div></div>
  <div class="panel"><div class="label">排队任务</div><div class="metric">${queuedTasks}</div></div>
  <div class="panel"><div class="label">心跳间隔</div><div class="metric">${heartbeatIntervalMs() / 1000}s</div></div>
  <div class="panel"><div class="label">自动复盘</div><div class="metric ${autoEvolution.timerActive ? "ok" : "bad"}">${autoEvolution.enabled ? (autoEvolution.timerActive ? "运行中" : "未运行") : "关闭"}</div></div>
  <div class="panel"><div class="label">复盘间隔</div><div class="metric small">${escapeHtml(formatDuration(autoEvolution.intervalMs))}</div></div>
  <div class="panel"><div class="label">下次复盘</div><div class="metric small">${escapeHtml(formatTimeUntil(autoEvolution.nextRunAt))}</div></div>
</section>
<section class="panel" style="margin-top:14px"><table class="table"><tbody>
  <tr><th>自动化任务</th><td>${autoEvolution.enabled ? (autoEvolution.timerActive ? "定时器运行中" : "已开启但定时器未运行") : "已关闭"}</td></tr>
  <tr><th>启动时间</th><td>${escapeHtml(formatLocalTime(autoEvolution.startedAt))}</td></tr>
  <tr><th>上次运行</th><td>${escapeHtml(formatLocalTime(autoEvolution.lastRunAt))}${autoEvolution.lastRunReason ? `｜${escapeHtml(autoEvolution.lastRunReason)}` : ""}</td></tr>
  <tr><th>下次运行</th><td>${escapeHtml(formatLocalTime(autoEvolution.nextRunAt))}｜${escapeHtml(formatTimeUntil(autoEvolution.nextRunAt))}</td></tr>
  <tr><th>报告</th><td>${autoEvolution.reportCount} 条｜${escapeHtml(autoEvolution.latestReport?.summary ?? "暂无报告")}</td></tr>
  <tr><th>接口</th><td class="mono">GET /api/evolution/status</td></tr>
</tbody></table></section>
<section class="panel" style="margin-top:14px"><table class="table"><thead><tr><th>Chat</th><th>工作区</th><th>Codex 会话</th><th>更新时间</th></tr></thead><tbody>
${sessions
  .map(
    (session) =>
      `<tr><td class="mono">${escapeHtml(session.chatId.slice(-12))}</td><td class="mono">${escapeHtml(session.workspaceDir)}</td><td class="mono">${escapeHtml(session.threadId ?? "尚未创建")}</td><td>${escapeHtml(session.updatedAt)}</td></tr>`
  )
  .join("") || `<tr><td colspan="4" class="label">暂无飞书会话</td></tr>`}
</tbody></table></section>
<section class="panel" style="margin-top:14px"><table class="table"><thead><tr><th>任务</th><th>状态</th><th>当前任务</th><th>耗时</th><th>更新时间</th></tr></thead><tbody>
${recentTasks
  .map(
    (task) =>
      `<tr><td class="mono">${escapeHtml(task.id)}</td><td><span class="badge ${task.status}">${escapeHtml(taskStatusText(task.status))}</span></td><td>${escapeHtml(task.preview)}</td><td>${escapeHtml(taskElapsed(task))}</td><td>${escapeHtml(task.updatedAt)}</td></tr>`
  )
  .join("") || `<tr><td colspan="5" class="label">暂无任务</td></tr>`}
</tbody></table></section>`;
  res.type("html").send(pageShell("Codex Bridge", body));
});

app.get("/logs", (_req, res) => {
  const body = `
<div class="top"><div class="brand"><h1>实时日志</h1><p>飞书消息、Codex 进度、路由判断，每 3 秒自动刷新。</p></div><div class="nav"><a href="/">状态</a><a href="/settings">工作区设置</a><a href="/logout">退出</a></div></div>
<section class="panel">
  <div class="logbar">
    <div class="left">
      <select id="source"><option value="">全部</option><option value="feishu">飞书</option><option value="bridge">回复</option><option value="codex">Codex</option><option value="router">路由</option></select>
      <select id="limit"><option value="80">80条</option><option value="150">150条</option><option value="300">300条</option></select>
      <button class="btn" id="refresh" type="button">刷新</button>
    </div>
    <div class="label" id="summary">加载中</div>
  </div>
  <div class="timeline" id="logs"></div>
</section>
<script>
const sourceSelect = document.getElementById('source');
const limitSelect = document.getElementById('limit');
const logsEl = document.getElementById('logs');
const summaryEl = document.getElementById('summary');
function esc(value){return String(value ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function localTime(value){const d = new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', {hour12:false});}
function sourceName(value){return ({feishu:'飞书',bridge:'回复',codex:'Codex',router:'路由'}[value] || value);}
async function loadLogs(){
  const limit = encodeURIComponent(limitSelect.value || '80');
  const source = sourceSelect.value;
  const res = await fetch('/api/logs?limit=' + limit);
  if(!res.ok){summaryEl.textContent='加载失败';return;}
  const data = await res.json();
  const list = (data.logs || []).filter(item => !source || item.source === source);
  summaryEl.textContent = '显示 ' + list.length + ' 条｜消息 ' + data.totals.messages + '｜路由 ' + data.totals.interactions + '｜Codex ' + data.totals.codexProgress;
  logsEl.innerHTML = list.map(item => '<article class="logitem"><div class="loghead"><div><span class="badge source-' + esc(item.source) + '">' + esc(sourceName(item.source)) + '</span> <strong>' + esc(item.title) + '</strong> <span class="label">' + esc(item.status) + '</span></div><div class="label mono">' + esc(localTime(item.at)) + '｜' + esc((item.chatId || '').slice(-10)) + '</div></div><div class="logtext">' + esc(item.text || item.preview || '') + '</div></article>').join('') || '<div class="label">暂无日志</div>';
}
document.getElementById('refresh').addEventListener('click', loadLogs);
sourceSelect.addEventListener('change', loadLogs);
limitSelect.addEventListener('change', loadLogs);
loadLogs();
setInterval(loadLogs, 3000);
</script>`;
  res.type("html").send(pageShell("实时日志", body));
});

app.get("/settings", (req, res) => {
  const config = getConfig();
  const saved = req.query.saved === "1" ? `<div class="notice">设置已保存。飞书 App ID / Secret 变更需要重启服务后生效。</div>` : "";
  const body = `
<div class="top"><div class="brand"><h1>工作区设置</h1><p>保存到 .env；授权码和默认工作区立即生效。</p></div><div class="nav"><a href="/">状态</a><a href="/logs">日志</a><a href="/logout">退出</a></div></div>
${saved}
<form class="panel" method="post" action="/settings">
  <div class="form">
    <div class="field"><label>飞书 App ID</label><input name="feishuAppId" value="${escapeHtml(config.feishuAppId)}"></div>
    <div class="field"><label>飞书 App Secret</label><input name="feishuAppSecret" type="password" placeholder="${escapeHtml(maskSecret(config.feishuAppSecret) || "留空保持不变")}" autocomplete="new-password"><small>留空表示不修改。</small></div>
    <div class="field"><label>飞书 Verification Token</label><input name="feishuVerificationToken" type="password" placeholder="${escapeHtml(maskSecret(config.feishuVerificationToken) || "留空保持不变")}" autocomplete="new-password"><small>长连接模式通常不使用，保留给回调兼容。</small></div>
    <div class="field"><label>管理页授权码</label><input name="bridgeAuthCode" value="${escapeHtml(config.bridgeAuthCode)}" autocomplete="off"></div>
    <div class="field full"><label>默认工作区</label><input name="defaultWorkspaceDir" value="${escapeHtml(config.defaultWorkspaceDir)}"><small>新飞书会话默认在这里运行；已有会话保持自己的当前工作区。</small></div>
    <div class="field"><label>Codex 命令</label><input name="codexCommand" value="${escapeHtml(config.codexCommand)}"></div>
    <div class="field"><label>Codex 模型</label><input name="codexModel" value="${escapeHtml(config.codexModel)}" placeholder="留空使用 Codex 默认模型"></div>
    <div class="field"><label>审批策略</label><input name="codexApprovalPolicy" value="${escapeHtml(config.codexApprovalPolicy)}"></div>
    <div class="field"><label>任务无输出提醒 ms</label><input name="codexTimeoutMs" value="${escapeHtml(config.codexTimeoutMs)}"><small>用户任务不会因此杀 Codex；无输出达到该时间只记录“仍在运行”。</small></div>
    <div class="field"><label>沙盒模式</label><select name="codexDisableSandbox"><option value="1" ${config.codexDisableSandbox ? "selected" : ""}>关闭沙盒</option><option value="0" ${config.codexDisableSandbox ? "" : "selected"}>开启沙盒</option></select></div>
    <div class="field"><label>飞书消息模式</label><select name="feishuMessageMode"><option value="direct" ${config.feishuMessageMode === "direct" ? "selected" : ""}>直连模式</option><option value="bridge" ${config.feishuMessageMode === "bridge" ? "selected" : ""}>桥接模式</option></select><small>直连模式绕过任务识别；桥接模式使用任务队列和意图确认。</small></div>
    <div class="field"><label>飞书回复长度</label><input name="feishuResponseLimit" value="${escapeHtml(config.feishuResponseLimit)}"></div>
    <div class="field"><label>直连无输出提醒 ms</label><input name="directReplyTimeoutMs" value="${escapeHtml(config.directReplyTimeoutMs)}"><small>直连普通消息无输出达到该时间只更新运行状态，不杀 Codex。</small></div>
    <div class="field"><label>默认心跳间隔 ms（飞书进度反馈）</label><input name="taskHeartbeatMs" value="${escapeHtml(config.taskHeartbeatMs)}" placeholder="60000"><small>运行中任务会按这个默认间隔向飞书发送进度心跳，当前 ${escapeHtml(formatDuration(heartbeatIntervalMs()))}，最低 15000ms；飞书里可用 /heartbeat 30s 动态修改。</small></div>
    <div class="field"><label>普通聊天无输出提醒 ms</label><input name="chatTimeoutMs" value="${escapeHtml(config.chatTimeoutMs)}"><small>桥接普通聊天无输出达到该时间只更新运行状态，不杀 Codex。</small></div>
    <div class="field"><label>Codex 意图识别</label><select name="intentClassifierEnabled"><option value="0" ${config.intentClassifierEnabled ? "" : "selected"}>关闭，模糊时直接确认</option><option value="1" ${config.intentClassifierEnabled ? "selected" : ""}>开启，模糊时先让 Codex 分类</option></select></div>
    <div class="field"><label>意图识别超时 ms</label><input name="intentClassifierTimeoutMs" value="${escapeHtml(config.intentClassifierTimeoutMs)}"><small>仅在本地规则无法判断时调用 Codex 做轻量分类。</small></div>
    <div class="field"><label>自动复盘进化</label><select name="autoEvolutionEnabled"><option value="1" ${config.autoEvolutionEnabled ? "selected" : ""}>开启，只生成有证据报告</option><option value="0" ${config.autoEvolutionEnabled ? "" : "selected"}>关闭</option></select></div>
    <div class="field"><label>复盘间隔 ms</label><input name="evolutionCheckIntervalMs" value="${escapeHtml(config.evolutionCheckIntervalMs)}"><small>默认 3600000ms，即 1 小时。</small></div>
    <div class="field"><label>最小证据数</label><input name="evolutionMinEvidence" value="${escapeHtml(config.evolutionMinEvidence)}"><small>低于该样本数时只记录不进化。</small></div>
    <div class="field full"><label>PATH 前缀</label><input name="pathExtra" value="${escapeHtml(config.pathExtra)}"></div>
  </div>
  <div class="actions"><button class="btn primary" type="submit">保存设置</button><a class="btn" href="/">取消</a></div>
</form>`;
  res.type("html").send(pageShell("工作区设置", body));
});

app.post("/settings", (req, res) => {
  saveConfig(req.body as ConfigPatch);
  startEvolutionScheduler();
  res.redirect("/settings?saved=1");
});

app.get("/api/tasks", (_req, res) => {
  const { queuedTasks, runningTasks } = getTaskCounts();
  res.json({
    queuedTasks,
    runningTasks,
    tasks: [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicTask),
  });
});

app.get("/api/tasks/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(publicTask(task));
});

app.get("/api/interactions", (_req, res) => {
  res.json({
    count: interactions.length,
    interactions: interactions.slice(-100).reverse(),
  });
});

app.get("/api/messages", (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1), 500);
  const chatId = typeof req.query.chatId === "string" ? req.query.chatId : "";
  const filtered = chatId ? messages.filter((message) => message.chatId === chatId) : messages;
  res.json({
    count: filtered.length,
    messages: filtered.slice(-limit).reverse(),
  });
});

app.get("/api/logs", (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "120"), 10) || 120, 1), 500);
  res.json(publicLogs(limit));
});

app.get("/api/codex-runs", (_req, res) => {
  const runs = [...conversationRuns.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({
    running: runs.filter((run) => run.status === "running").length,
    count: runs.length,
    runs: runs.slice(0, 100),
  });
});

app.get("/api/evolution", (_req, res) => {
  res.json({
    count: evolutionReports.length,
    reports: evolutionReports.slice(-50).reverse(),
  });
});

app.get("/api/evolution/latest", (_req, res) => {
  const latest = evolutionReports[evolutionReports.length - 1];
  if (!latest) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(latest);
});

app.get("/api/evolution/status", (_req, res) => {
  res.json(getEvolutionSchedulerStatus());
});

app.post("/api/evolution/run", (_req, res) => {
  res.json(runEvolutionCheck("manual"));
});

app.get("/api/evolution/run", (_req, res) => {
  res.json(runEvolutionCheck("manual"));
});

app.get("/health", (_req, res) => {
  const config = getConfig();
  const { queuedTasks, runningTasks } = getTaskCounts();
  res.json({
    status: "ok",
    codex: codexAvailable,
    sessions: getSessionCount(),
    queuedTasks,
    runningTasks,
    runningCodexRuns: [...conversationRuns.values()].filter((run) => run.status === "running").length,
    defaultWorkspaceDir: config.defaultWorkspaceDir,
    sandbox: config.codexDisableSandbox ? "disabled" : "enabled",
    feishuMessageMode: config.feishuMessageMode,
    directReplyTimeoutMs: config.directReplyTimeoutMs,
    taskHeartbeatMs: heartbeatIntervalMs(),
    autoEvolution: config.autoEvolutionEnabled ? "enabled" : "disabled",
    evolutionCheckIntervalMs: Math.max(config.evolutionCheckIntervalMs, 3600000),
    evolutionScheduler: getEvolutionSchedulerStatus(),
  });
});

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

function startEvolutionScheduler() {
  const config = getConfig();
  if (evolutionTimer) {
    clearInterval(evolutionTimer);
    evolutionTimer = undefined;
  }

  const intervalMs = Math.max(config.evolutionCheckIntervalMs, 60 * 60 * 1000);
  evolutionScheduler = {
    enabled: config.autoEvolutionEnabled,
    timerActive: false,
    intervalMs,
    lastRunAt: evolutionScheduler.lastRunAt,
    lastRunReason: evolutionScheduler.lastRunReason,
  };

  if (!config.autoEvolutionEnabled) {
    console.log("[Evolution] disabled");
    return;
  }

  evolutionScheduler.startedAt = nowIso();
  evolutionScheduler.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  evolutionScheduler.timerActive = true;
  console.log(
    `[Evolution] scheduler enabled: ${Math.round(intervalMs / 60000)} minutes, next=${evolutionScheduler.nextRunAt}`
  );
  evolutionTimer = setInterval(() => {
    try {
      runEvolutionCheck("scheduled");
    } catch (err) {
      evolutionScheduler.lastError = (err as Error).message;
      console.error(`[Evolution] scheduled check failed: ${(err as Error).message}`);
    }
  }, intervalMs);
}

async function main() {
  codexAvailable = await initCodex();
  startEvolutionScheduler();

  httpServer = app.listen(BRIDGE_PORT, () => {
    console.log(`[Bridge] Admin: http://localhost:${BRIDGE_PORT}`);
  });
  void notifyStartupRecoveries();

  setInterval(() => {}, 60000);
}

main().catch((e) => console.error("[FATAL M]", e.stack));
