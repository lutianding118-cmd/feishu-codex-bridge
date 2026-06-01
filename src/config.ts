import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env");

export type FeishuMessageMode = "direct" | "bridge";

export type BridgeConfig = {
  feishuAppId: string;
  feishuAppSecret: string;
  feishuVerificationToken: string;
  bridgePort: number;
  bridgeAuthCode: string;
  defaultWorkspaceDir: string;
  codexCommand: string;
  codexModel: string;
  codexApprovalPolicy: string;
  codexTimeoutMs: number;
  codexDisableSandbox: boolean;
  feishuMessageMode: FeishuMessageMode;
  feishuResponseLimit: number;
  directReplyTimeoutMs: number;
  taskHeartbeatMs: number;
  chatTimeoutMs: number;
  intentClassifierEnabled: boolean;
  intentClassifierTimeoutMs: number;
  autoEvolutionEnabled: boolean;
  evolutionCheckIntervalMs: number;
  evolutionMinEvidence: number;
  pathExtra: string;
};

export type ConfigPatch = Partial<{
  feishuAppId: string;
  feishuAppSecret: string;
  feishuVerificationToken: string;
  bridgeAuthCode: string;
  defaultWorkspaceDir: string;
  codexCommand: string;
  codexModel: string;
  codexApprovalPolicy: string;
  codexTimeoutMs: string;
  codexDisableSandbox: string;
  feishuMessageMode: string;
  feishuResponseLimit: string;
  directReplyTimeoutMs: string;
  taskHeartbeatMs: string;
  chatTimeoutMs: string;
  intentClassifierEnabled: string;
  intentClassifierTimeoutMs: string;
  autoEvolutionEnabled: string;
  evolutionCheckIntervalMs: string;
  evolutionMinEvidence: string;
  pathExtra: string;
}>;

const DEFAULTS: Record<string, string> = {
  FEISHU_APP_ID: "",
  FEISHU_APP_SECRET: "",
  FEISHU_VERIFICATION_TOKEN: "",
  BRIDGE_PORT: "3457",
  BRIDGE_AUTH_CODE: "123456",
  DEFAULT_WORKSPACE_DIR: "E:\\unity-projects",
  CODEX_COMMAND: "codex",
  CODEX_MODEL: "",
  CODEX_APPROVAL_POLICY: "never",
  CODEX_TIMEOUT_MS: "900000",
  CODEX_DISABLE_SANDBOX: "1",
  FEISHU_MESSAGE_MODE: "direct",
  FEISHU_RESPONSE_LIMIT: "4000",
  DIRECT_REPLY_TIMEOUT_MS: "900000",
  TASK_HEARTBEAT_MS: "60000",
  CHAT_TIMEOUT_MS: "90000",
  INTENT_CLASSIFIER_ENABLED: "0",
  INTENT_CLASSIFIER_TIMEOUT_MS: "15000",
  AUTO_EVOLUTION_ENABLED: "1",
  EVOLUTION_CHECK_INTERVAL_MS: "3600000",
  EVOLUTION_MIN_EVIDENCE: "2",
  PATH_EXTRA: "",
};

let rawConfig = loadRawEnv();
let currentConfig = normalizeConfig(rawConfig);

function parseEnv(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    parsed[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return parsed;
}

function loadRawEnv(): Record<string, string> {
  const fromFile = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, "utf-8")) : {};
  if (fromFile.CODEX_PROJECT_DIR && !fromFile.DEFAULT_WORKSPACE_DIR) {
    fromFile.DEFAULT_WORKSPACE_DIR = fromFile.CODEX_PROJECT_DIR;
  }
  return { ...DEFAULTS, ...fromFile };
}

function toInt(value: string, fallback: number): number {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isEnabled(value: string): boolean {
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function normalizeMessageMode(value: string | undefined): FeishuMessageMode {
  return value?.trim().toLowerCase() === "bridge" ? "bridge" : "direct";
}

function normalizeConfig(raw: Record<string, string>): BridgeConfig {
  return {
    feishuAppId: raw.FEISHU_APP_ID ?? "",
    feishuAppSecret: raw.FEISHU_APP_SECRET ?? "",
    feishuVerificationToken: raw.FEISHU_VERIFICATION_TOKEN ?? "",
    bridgePort: toInt(raw.BRIDGE_PORT ?? DEFAULTS.BRIDGE_PORT, 3457),
    bridgeAuthCode: raw.BRIDGE_AUTH_CODE || DEFAULTS.BRIDGE_AUTH_CODE,
    defaultWorkspaceDir: raw.DEFAULT_WORKSPACE_DIR || DEFAULTS.DEFAULT_WORKSPACE_DIR,
    codexCommand: raw.CODEX_COMMAND || DEFAULTS.CODEX_COMMAND,
    codexModel: raw.CODEX_MODEL ?? "",
    codexApprovalPolicy: raw.CODEX_APPROVAL_POLICY || DEFAULTS.CODEX_APPROVAL_POLICY,
    codexTimeoutMs: toInt(raw.CODEX_TIMEOUT_MS ?? DEFAULTS.CODEX_TIMEOUT_MS, 300000),
    codexDisableSandbox: isEnabled(raw.CODEX_DISABLE_SANDBOX ?? DEFAULTS.CODEX_DISABLE_SANDBOX),
    feishuMessageMode: normalizeMessageMode(raw.FEISHU_MESSAGE_MODE ?? DEFAULTS.FEISHU_MESSAGE_MODE),
    feishuResponseLimit: toInt(raw.FEISHU_RESPONSE_LIMIT ?? DEFAULTS.FEISHU_RESPONSE_LIMIT, 4000),
    directReplyTimeoutMs: toInt(raw.DIRECT_REPLY_TIMEOUT_MS ?? DEFAULTS.DIRECT_REPLY_TIMEOUT_MS, 900000),
    taskHeartbeatMs: toInt(raw.TASK_HEARTBEAT_MS ?? DEFAULTS.TASK_HEARTBEAT_MS, 60000),
    chatTimeoutMs: toInt(raw.CHAT_TIMEOUT_MS ?? DEFAULTS.CHAT_TIMEOUT_MS, 90000),
    intentClassifierEnabled: isEnabled(raw.INTENT_CLASSIFIER_ENABLED ?? DEFAULTS.INTENT_CLASSIFIER_ENABLED),
    intentClassifierTimeoutMs: toInt(raw.INTENT_CLASSIFIER_TIMEOUT_MS ?? DEFAULTS.INTENT_CLASSIFIER_TIMEOUT_MS, 15000),
    autoEvolutionEnabled: isEnabled(raw.AUTO_EVOLUTION_ENABLED ?? DEFAULTS.AUTO_EVOLUTION_ENABLED),
    evolutionCheckIntervalMs: toInt(raw.EVOLUTION_CHECK_INTERVAL_MS ?? DEFAULTS.EVOLUTION_CHECK_INTERVAL_MS, 3600000),
    evolutionMinEvidence: toInt(raw.EVOLUTION_MIN_EVIDENCE ?? DEFAULTS.EVOLUTION_MIN_EVIDENCE, 2),
    pathExtra: raw.PATH_EXTRA ?? "",
  };
}

function writeRawEnv(raw: Record<string, string>) {
  const content = [
    "# Feishu App credentials",
    `FEISHU_APP_ID=${raw.FEISHU_APP_ID ?? ""}`,
    `FEISHU_APP_SECRET=${raw.FEISHU_APP_SECRET ?? ""}`,
    `FEISHU_VERIFICATION_TOKEN=${raw.FEISHU_VERIFICATION_TOKEN ?? ""}`,
    "",
    "# Bridge server",
    `BRIDGE_PORT=${raw.BRIDGE_PORT ?? DEFAULTS.BRIDGE_PORT}`,
    `BRIDGE_AUTH_CODE=${raw.BRIDGE_AUTH_CODE || DEFAULTS.BRIDGE_AUTH_CODE}`,
    "",
    "# Workspace",
    `DEFAULT_WORKSPACE_DIR=${raw.DEFAULT_WORKSPACE_DIR || DEFAULTS.DEFAULT_WORKSPACE_DIR}`,
    "",
    "# Codex CLI",
    `CODEX_COMMAND=${raw.CODEX_COMMAND || DEFAULTS.CODEX_COMMAND}`,
    `CODEX_MODEL=${raw.CODEX_MODEL ?? ""}`,
    `CODEX_APPROVAL_POLICY=${raw.CODEX_APPROVAL_POLICY || DEFAULTS.CODEX_APPROVAL_POLICY}`,
    `CODEX_TIMEOUT_MS=${raw.CODEX_TIMEOUT_MS || DEFAULTS.CODEX_TIMEOUT_MS}`,
    `CODEX_DISABLE_SANDBOX=${raw.CODEX_DISABLE_SANDBOX || DEFAULTS.CODEX_DISABLE_SANDBOX}`,
    `FEISHU_MESSAGE_MODE=${raw.FEISHU_MESSAGE_MODE || DEFAULTS.FEISHU_MESSAGE_MODE}`,
    `FEISHU_RESPONSE_LIMIT=${raw.FEISHU_RESPONSE_LIMIT || DEFAULTS.FEISHU_RESPONSE_LIMIT}`,
    `DIRECT_REPLY_TIMEOUT_MS=${raw.DIRECT_REPLY_TIMEOUT_MS || DEFAULTS.DIRECT_REPLY_TIMEOUT_MS}`,
    `TASK_HEARTBEAT_MS=${raw.TASK_HEARTBEAT_MS || DEFAULTS.TASK_HEARTBEAT_MS}`,
    `CHAT_TIMEOUT_MS=${raw.CHAT_TIMEOUT_MS || DEFAULTS.CHAT_TIMEOUT_MS}`,
    `INTENT_CLASSIFIER_ENABLED=${raw.INTENT_CLASSIFIER_ENABLED || DEFAULTS.INTENT_CLASSIFIER_ENABLED}`,
    `INTENT_CLASSIFIER_TIMEOUT_MS=${raw.INTENT_CLASSIFIER_TIMEOUT_MS || DEFAULTS.INTENT_CLASSIFIER_TIMEOUT_MS}`,
    `AUTO_EVOLUTION_ENABLED=${raw.AUTO_EVOLUTION_ENABLED || DEFAULTS.AUTO_EVOLUTION_ENABLED}`,
    `EVOLUTION_CHECK_INTERVAL_MS=${raw.EVOLUTION_CHECK_INTERVAL_MS || DEFAULTS.EVOLUTION_CHECK_INTERVAL_MS}`,
    `EVOLUTION_MIN_EVIDENCE=${raw.EVOLUTION_MIN_EVIDENCE || DEFAULTS.EVOLUTION_MIN_EVIDENCE}`,
    "",
    "# Optional PATH prefix for Codex command",
    `PATH_EXTRA=${raw.PATH_EXTRA ?? ""}`,
    "",
  ].join("\n");
  writeFileSync(ENV_PATH, content, "utf-8");
}

export function getConfig(): BridgeConfig {
  return currentConfig;
}

export function saveConfig(patch: ConfigPatch): BridgeConfig {
  const next = { ...rawConfig };
  if (patch.feishuAppId !== undefined) next.FEISHU_APP_ID = patch.feishuAppId.trim();
  if (patch.feishuAppSecret !== undefined && patch.feishuAppSecret.trim()) {
    next.FEISHU_APP_SECRET = patch.feishuAppSecret.trim();
  }
  if (patch.feishuVerificationToken !== undefined && patch.feishuVerificationToken.trim()) {
    next.FEISHU_VERIFICATION_TOKEN = patch.feishuVerificationToken.trim();
  }
  if (patch.bridgeAuthCode !== undefined) {
    next.BRIDGE_AUTH_CODE = patch.bridgeAuthCode.trim() || DEFAULTS.BRIDGE_AUTH_CODE;
  }
  if (patch.defaultWorkspaceDir !== undefined) {
    next.DEFAULT_WORKSPACE_DIR = patch.defaultWorkspaceDir.trim() || DEFAULTS.DEFAULT_WORKSPACE_DIR;
  }
  if (patch.codexCommand !== undefined) next.CODEX_COMMAND = patch.codexCommand.trim() || DEFAULTS.CODEX_COMMAND;
  if (patch.codexModel !== undefined) next.CODEX_MODEL = patch.codexModel.trim();
  if (patch.codexApprovalPolicy !== undefined) {
    next.CODEX_APPROVAL_POLICY = patch.codexApprovalPolicy.trim() || DEFAULTS.CODEX_APPROVAL_POLICY;
  }
  if (patch.codexTimeoutMs !== undefined) next.CODEX_TIMEOUT_MS = patch.codexTimeoutMs.trim() || DEFAULTS.CODEX_TIMEOUT_MS;
  if (patch.codexDisableSandbox !== undefined) next.CODEX_DISABLE_SANDBOX = patch.codexDisableSandbox;
  if (patch.feishuMessageMode !== undefined) next.FEISHU_MESSAGE_MODE = normalizeMessageMode(patch.feishuMessageMode);
  if (patch.feishuResponseLimit !== undefined) {
    next.FEISHU_RESPONSE_LIMIT = patch.feishuResponseLimit.trim() || DEFAULTS.FEISHU_RESPONSE_LIMIT;
  }
  if (patch.directReplyTimeoutMs !== undefined) {
    next.DIRECT_REPLY_TIMEOUT_MS = patch.directReplyTimeoutMs.trim() || DEFAULTS.DIRECT_REPLY_TIMEOUT_MS;
  }
  if (patch.taskHeartbeatMs !== undefined) next.TASK_HEARTBEAT_MS = patch.taskHeartbeatMs.trim() || DEFAULTS.TASK_HEARTBEAT_MS;
  if (patch.chatTimeoutMs !== undefined) next.CHAT_TIMEOUT_MS = patch.chatTimeoutMs.trim() || DEFAULTS.CHAT_TIMEOUT_MS;
  if (patch.intentClassifierEnabled !== undefined) next.INTENT_CLASSIFIER_ENABLED = patch.intentClassifierEnabled;
  if (patch.intentClassifierTimeoutMs !== undefined) {
    next.INTENT_CLASSIFIER_TIMEOUT_MS = patch.intentClassifierTimeoutMs.trim() || DEFAULTS.INTENT_CLASSIFIER_TIMEOUT_MS;
  }
  if (patch.autoEvolutionEnabled !== undefined) next.AUTO_EVOLUTION_ENABLED = patch.autoEvolutionEnabled;
  if (patch.evolutionCheckIntervalMs !== undefined) {
    next.EVOLUTION_CHECK_INTERVAL_MS = patch.evolutionCheckIntervalMs.trim() || DEFAULTS.EVOLUTION_CHECK_INTERVAL_MS;
  }
  if (patch.evolutionMinEvidence !== undefined) {
    next.EVOLUTION_MIN_EVIDENCE = patch.evolutionMinEvidence.trim() || DEFAULTS.EVOLUTION_MIN_EVIDENCE;
  }
  if (patch.pathExtra !== undefined) next.PATH_EXTRA = patch.pathExtra.trim();

  rawConfig = { ...DEFAULTS, ...next };
  currentConfig = normalizeConfig(rawConfig);
  writeRawEnv(rawConfig);
  return currentConfig;
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}********${value.slice(-4)}`;
}
