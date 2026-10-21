import PostalMime, { type Address, type Email } from "postal-mime";
import type { Env } from "./env";
import { insertMessage, type AttachmentRecord, type MessageRecord } from "./db";
import { sendAutoReply, shouldAutoReply } from "./outbound";
import { classify, senderOf, type SpamVerdict } from "./spam";

// Messages larger than this are kept as raw .eml only (headers in D1) to stay within Worker CPU/memory limits.
const MAX_PARSE_BYTES = 10 * 1024 * 1024;

/**
 * Entry point for mail delivered by Email Routing.
 *
 * Steps: parse -> spam check -> (blocked: reject) -> original + attachments to R2 -> row in D1
 *        -> forward -> auto-reply. Spam is stored in the Spam folder and is never forwarded or answered.
 * Each side effect is isolated so that, e.g., a storage failure doesn't stop forwarding.
 */
export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const id = crypto.randomUUID();
  let subject = message.headers.get("subject") ?? "";
  let verdict: SpamVerdict | undefined;

  try {
    const result = await processInbound(message, env, id);
    verdict = result.verdict;
    subject = result.subject;
    console.log(
      JSON.stringify({
        event: verdict.action === "block" ? "email.rejected" : "email.received",
        id,
        from: result.from,
        to: message.to,
        subject,
        size: message.rawSize,
        spam: verdict.action,
        spamScore: verdict.score,
      }),
    );
  } catch (err) {
    console.error("Failed to store email", id, err);
  }

  if (verdict?.action === "block") {
    message.setReject("Message rejected by recipient");
    return;
  }
  if (verdict?.action === "spam") return;

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

async function processInbound(
  message: ForwardableEmailMessage,
  env: Env,
  id: string,
): Promise<{ verdict: SpamVerdict; subject: string; from: string }> {
  // `message.raw` can only be read once, so buffer it: we need it for both R2 and the parser.
  const raw = await new Response(message.raw).arrayBuffer();
  const h = message.headers;
  const parsed = raw.byteLength > MAX_PARSE_BYTES ? null : await PostalMime.parse(raw);

  const sender = parsed ? senderOf(parsed) : { email: message.from };
  const subject = parsed ? (parsed.subject ?? "") : (h.get("subject") ?? "");
  const verdict = await classify(env, {
    headers: h,
    envelopeFrom: message.from,
    fromEmail: sender.email,
    fromName: sender.name,
    replyTo: firstMailbox(parsed?.replyTo?.[0]),
    subject,
    text: parsed?.text,
    html: parsed?.html,
    attachments: parsed?.attachments ?? [],
  });
  const from = parsed?.from ? formatAddress(parsed.from) : (h.get("from") ?? message.from);

  // Blocked senders: nothing is stored.
  if (verdict.action === "block") return { verdict, subject, from };

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
    isSpam: verdict.action === "spam",
    spamScore: verdict.score,
    spamReasons: verdict.reasons,
  };

  if (!parsed) {
    await insertMessage(env, {
      ...base,
      from,
      fromEmail: message.from,
      to: [h.get("to") ?? message.to],
      cc: [],
      subject,
      messageId: h.get("message-id") ?? undefined,
      date: h.get("date") ?? undefined,
      text: "This message was too large to display. Download the original to read it.",
      truncated: true,
    });
    return { verdict, subject, from };
  }

  const attachments = await storeAttachments(env, id, parsed);
  const record: MessageRecord = {
    ...base,
    from,
    fromEmail: sender.email ?? message.from,
    replyTo: firstMailbox(parsed.replyTo?.[0]),
    to: (parsed.to ?? []).map(formatAddress),
    cc: (parsed.cc ?? []).map(formatAddress),
    subject,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    date: parsed.date,
    text: parsed.text,
    html: parsed.html,
    truncated: false,
  };
  await insertMessage(env, record, attachments);
  return { verdict, subject, from };
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
