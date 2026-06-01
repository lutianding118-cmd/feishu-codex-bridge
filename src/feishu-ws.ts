// Feishu WebSocket Long Connection Client
// Uses Feishu's WebSocket event subscription (no HTTP callback needed)

const FEISHU_API = "https://open.feishu.cn/open-apis";
const WS_URL = "wss://open.feishu.cn/open-apis/event/v1/ws";

let cachedToken: string | null = null;
let tokenExpiry = 0;

export interface WsMessage {
  chatId: string;
  messageId: string;
  text: string;
  chatType: string;
}

type MessageHandler = (msg: WsMessage, reply: (text: string) => Promise<void>) => Promise<void>;

async function getToken(appId: string, appSecret: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const resp = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = (await resp.json()) as any;
  if (data.code !== 0) throw new Error(`Auth failed: ${data.msg}`);
  cachedToken = data.tenant_access_token as string;
  tokenExpiry = Date.now() + (data.expire ?? 7200) * 1000;
  return cachedToken;
}

export async function startWsListener(
  appId: string,
  appSecret: string,
  handler: MessageHandler
): Promise<void> {
  const token = await getToken(appId, appSecret);

  // Connect to Feishu WS
  const ws = new WebSocket(`${WS_URL}?token=${token}`);

  ws.onopen = () => { console.log("[Feishu WS] Connected"); };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data.toString());
      if (data.type === "url_verification") {
        // Actually, the WS mode doesn't use url_verification
      }
      if (data.eventType === "im.message.receive_v1") {
        console.log("[Feishu WS] Message received");
        // Parse message
        const msgEvent = data.event;
        const body = JSON.parse(msgEvent?.message?.content ?? "{}");
        const text = body.text?.trim() ?? "";
        if (!text) return;

        const wsMsg: WsMessage = {
          chatId: msgEvent.message.chat_id,
          messageId: msgEvent.message.message_id,
          text,
          chatType: msgEvent.message.chat_type,
        };

        await handler(wsMsg, async (replyText) => {
          await replyMessage(wsMsg.messageId, replyText);
        });
      }
    } catch (err) {
      console.error("[Feishu WS] Error:", err);
    }
  };

  ws.onclose = () => {
    console.log("[Feishu WS] Disconnected, reconnecting in 5s...");
    setTimeout(() => startWsListener(appId, appSecret, handler), 5000);
  };

  ws.onerror = (err) => {
    console.error("[Feishu WS] Error:", err);
  };
}

async function replyMessage(messageId: string, content: string) {
  const appId = process.env.FEISHU_APP_ID!;
  const appSecret = process.env.FEISHU_APP_SECRET!;
  const token = await getToken(appId, appSecret);

  const resp = await fetch(`${FEISHU_API}/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      content: JSON.stringify({ text: content }),
      msg_type: "text",
    }),
  });
  const data = (await resp.json()) as any;
  if (data.code !== 0) console.error(`[Feishu WS] Reply failed: ${data.msg}`);
}

export async function sendWsMessage(chatId: string, content: string) {
  const appId = process.env.FEISHU_APP_ID!;
  const appSecret = process.env.FEISHU_APP_SECRET!;
  const token = await getToken(appId, appSecret);

  await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
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
  });
}
