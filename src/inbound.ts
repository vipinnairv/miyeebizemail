import PostalMime, { type Address, type Email } from "postal-mime";
import type { Env } from "./env";
import { insertMessage, type AttachmentRecord, type MessageRecord } from "./db";
import { sendAutoReply, shouldAutoReply } from "./outbound";

// Messages larger than this are kept as raw .eml only (headers in D1) to stay within Worker CPU/memory limits.
const MAX_PARSE_BYTES = 10 * 1024 * 1024;

/**
 * Entry point for mail delivered by Email Routing.
 *
 * Steps: save original to R2 -> parse -> attachments to R2 -> row in D1 -> forward -> auto-reply.
 * Each side effect is isolated so that, e.g., a storage failure doesn't stop forwarding.
 */
export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const id = crypto.randomUUID();
  let subject = message.headers.get("subject") ?? "";

  try {
    const stored = await storeInbound(message, env, id);
    subject = stored.subject;
    console.log(
      JSON.stringify({
        event: "email.received",
        id,
        from: stored.from,
        to: message.to,
        subject: stored.subject,
        size: message.rawSize,
      }),
    );
  } catch (err) {
    console.error("Failed to store email", id, err);
  }

  if (env.FORWARD_TO) {
    try {
      await message.forward(env.FORWARD_TO);
    } catch (err) {
      console.error("Failed to forward email", id, err);
    }
  }

  if (shouldAutoReply(message, env)) {
    try {
      const replyId = await sendAutoReply(message, env, subject);
      console.log(JSON.stringify({ event: "email.auto_replied", id, replyId }));
    } catch (err) {
      // Common causes: sender failed DMARC, or the message was already replied to.
      console.error("Failed to auto-reply", id, err);
    }
  }
}

async function storeInbound(message: ForwardableEmailMessage, env: Env, id: string): Promise<MessageRecord> {
  // `message.raw` can only be read once, so buffer it: we need it for both R2 and the parser.
  const raw = await new Response(message.raw).arrayBuffer();
  const rawKey = `raw/${id}.eml`;
  await env.MAIL_BUCKET.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });

  const base = {
    id,
    direction: "in" as const,
    receivedAt: new Date().toISOString(),
    envelopeFrom: message.from,
    envelopeTo: message.to,
    rawKey,
    rawSize: message.rawSize,
    read: false,
  };

  if (raw.byteLength > MAX_PARSE_BYTES) {
    const h = message.headers;
    const record: MessageRecord = {
      ...base,
      from: h.get("from") ?? message.from,
      fromEmail: message.from,
      to: [h.get("to") ?? message.to],
      cc: [],
      subject: h.get("subject") ?? "",
      messageId: h.get("message-id") ?? undefined,
      date: h.get("date") ?? undefined,
      text: "This message was too large to display. Download the original to read it.",
      truncated: true,
    };
    await insertMessage(env, record);
    return record;
  }

  const parsed = await PostalMime.parse(raw);
  const attachments = await storeAttachments(env, id, parsed);
  const fromMailbox = firstMailbox(parsed.from);

  const record: MessageRecord = {
    ...base,
    from: parsed.from ? formatAddress(parsed.from) : message.from,
    fromEmail: fromMailbox ?? message.from,
    replyTo: firstMailbox(parsed.replyTo?.[0]),
    to: (parsed.to ?? []).map(formatAddress),
    cc: (parsed.cc ?? []).map(formatAddress),
    subject: parsed.subject ?? "",
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    date: parsed.date,
    text: parsed.text,
    html: parsed.html,
    truncated: false,
  };
  await insertMessage(env, record, attachments);
  return record;
}

async function storeAttachments(env: Env, messageId: string, parsed: Email): Promise<AttachmentRecord[]> {
  return Promise.all(
    parsed.attachments.map(async (a, i) => {
      const attId = crypto.randomUUID();
      const r2Key = `attachments/${messageId}/${attId}`;
      const content = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
      await env.MAIL_BUCKET.put(r2Key, content, { httpMetadata: { contentType: a.mimeType } });
      return {
        id: attId,
        messageId,
        filename: a.filename ?? `attachment-${i + 1}`,
        mimeType: a.mimeType,
        disposition: a.disposition,
        // Only inline parts referenced from the HTML get a content id; the UI swaps cid: links for them.
        contentId: a.contentId && (a.related || a.disposition === "inline") ? a.contentId.replace(/^<|>$/g, "") : null,
        size: content.byteLength,
        r2Key,
      };
    }),
  );
}

function formatAddress(addr: Address): string {
  if (addr.group) return `${addr.name}: ${addr.group.map(formatAddress).join(", ")};`;
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

function firstMailbox(addr?: Address): string | undefined {
  if (!addr) return undefined;
  if (addr.group) return addr.group[0]?.address;
  return addr.address || undefined;
}
