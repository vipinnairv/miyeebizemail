import PostalMime, { type Address } from "postal-mime";
import type { Env } from "./env";
import { newMessageId, saveEmail, type StoredEmail } from "./storage";
import { sendAutoReply, shouldAutoReply } from "./outbound";

// Messages larger than this are stored headers-only to stay within Worker CPU/memory limits.
const MAX_PARSE_BYTES = 10 * 1024 * 1024;

/**
 * Entry point for mail delivered by Email Routing.
 *
 * Steps: parse -> store in KV -> (optionally) forward -> (optionally) auto-reply.
 * Each side effect is isolated so that, e.g., a KV failure doesn't stop forwarding.
 */
export async function handleInbound(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const id = newMessageId();
  const record = await parseMessage(message, id);

  console.log(
    JSON.stringify({
      event: "email.received",
      id,
      from: record.from,
      to: message.to,
      subject: record.subject,
      size: message.rawSize,
    }),
  );

  // KV write doesn't need to block delivery; waitUntil keeps the Worker alive until it finishes.
  ctx.waitUntil(
    saveEmail(env, record).catch((err) => console.error("Failed to store email", id, err)),
  );

  if (env.FORWARD_TO) {
    try {
      await message.forward(env.FORWARD_TO);
    } catch (err) {
      console.error("Failed to forward email", id, err);
    }
  }

  if (shouldAutoReply(message, env)) {
    try {
      const replyId = await sendAutoReply(message, env, record.subject);
      console.log(JSON.stringify({ event: "email.auto_replied", id, replyId }));
    } catch (err) {
      // Common causes: sender failed DMARC, or the message was already replied to.
      console.error("Failed to auto-reply", id, err);
    }
  }
}

async function parseMessage(message: ForwardableEmailMessage, id: string): Promise<StoredEmail> {
  const base = {
    id,
    receivedAt: new Date().toISOString(),
    envelopeFrom: message.from,
    envelopeTo: message.to,
    rawSize: message.rawSize,
  };

  if (message.rawSize > MAX_PARSE_BYTES) {
    return {
      ...base,
      from: message.headers.get("from") ?? message.from,
      to: [message.headers.get("to") ?? message.to],
      subject: message.headers.get("subject") ?? "",
      messageId: message.headers.get("message-id") ?? undefined,
      date: message.headers.get("date") ?? undefined,
      attachments: [],
      truncated: true,
    };
  }

  // `message.raw` is a ReadableStream and can only be consumed once.
  const parsed = await PostalMime.parse(message.raw);

  return {
    ...base,
    from: parsed.from ? formatAddress(parsed.from) : message.from,
    to: (parsed.to ?? []).map(formatAddress),
    subject: parsed.subject ?? "",
    messageId: parsed.messageId,
    date: parsed.date,
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
    })),
  };
}

function formatAddress(addr: Address): string {
  if (addr.group) return `${addr.name}: ${addr.group.map(formatAddress).join(", ")};`;
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}
