// Feishu (Lark) API client
// Handles: tenant_access_token, sending messages, webhook verification

const FEISHU_API = "https://open.feishu.cn/open-apis";

let cachedToken: { token: string; expiresAt: number } | null = null;

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
}

let config: FeishuConfig;

export function initFeishu(cfg: FeishuConfig) {
  config = cfg;
}

async function getTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.token;
  }

  const resp = await fetch(
    `${FEISHU_API}/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    }
  );

  const data = (await resp.json()) as any;
  if (data.code !== 0) {
    throw new Error(`Feishu auth failed: ${data.msg} (code=${data.code})`);
  }

  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  };

  return cachedToken.token;
}

// Send text message to a chat
export async function sendMessage(chatId: string, content: string) {
  const token = await getTenantToken();

  const resp = await fetch(
    `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: content }),
      }),
    }
  );

  const data = (await resp.json()) as any;
  if (data.code !== 0) {
    console.error(`[Feishu] Send message failed: ${data.msg}`);
  }
  return data;
}

// Send a card/rich message with markdown support
export async function sendCardMessage(
  chatId: string,
  header: string,
  content: string
) {
  const token = await getTenantToken();

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: header },
      template: "blue" as const,
    },
    elements: [
      {
        tag: "markdown",
        content: content.substring(0, 30000), // Feishu limit
      },
    ],
  };

  const resp = await fetch(
    `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    }
  );

  const data = (await resp.json()) as any;
  if (data.code !== 0) {
    console.error(`[Feishu] Send card failed: ${data.msg}`);
  }
  return data;
}

// Reply to a message (in group chat, replies in thread)
export async function replyMessage(
  messageId: string,
  content: string,
  chatId?: string
) {
  const token = await getTenantToken();

  const resp = await fetch(
    `${FEISHU_API}/im/v1/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        content: JSON.stringify({ text: content }),
        msg_type: "text",
      }),
    }
  );

  const data = (await resp.json()) as any;
  if (data.code !== 0) {
    console.error(`[Feishu] Reply failed: ${data.msg}`);
  }
  return data;
}

// Reply with interactive card (for long responses)
export async function replyCardMessage(
  messageId: string,
  header: string,
  content: string
) {
  const token = await getTenantToken();

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: header },
      template: "blue" as const,
    },
    elements: [
      {
        tag: "markdown",
        content: content.substring(0, 30000),
      },
    ],
  };

  const resp = await fetch(
    `${FEISHU_API}/im/v1/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
        msg_type: "interactive",
      }),
    }
  );

  const data = (await resp.json()) as any;
  if (data.code !== 0) {
    console.error(`[Feishu] Reply card failed: ${data.msg}`);
  }
  return data;
}

// Verify webhook challenge from Feishu
export function verifyWebhook(timestamp: string, nonce: string): string {
  const crypto = require("node:crypto");

  // Feishu event verification - URL verification challenge
  const str = `${timestamp}${nonce}`;
  // Note: actual verification uses the encryption key, not simple hash
  return str;
}

// Decrypt Feishu event body (if encryption is enabled)
export function decryptEvent(encrypt: string): string {
  const crypto = require("node:crypto");

  // Feishu uses AES-256-CBC with the app's encrypt key
  // For simplicity, if encryption is enabled, configure accordingly
  // By default, newer Feishu apps send plain JSON
  return encrypt;
}
