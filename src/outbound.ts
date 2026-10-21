import type { Env } from "./env";
import { insertMessage, type AttachmentRecord, type MessageRecord } from "./db";

export interface OutgoingEmail {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  replyTo?: string;
  attachments?: OutgoingAttachment[];
}

/** An attachment as sent by the API client: content is base64-encoded. */
export interface OutgoingAttachment {
  filename: string;
  type: string;
  content: string;
}

export const MAX_ATTACHMENTS = 10;
/** Total size of all attachments, before base64 encoding. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface ThreadHeaders {
  inReplyTo?: string;
  references?: string;
}

/**
 * Send a new message from FROM_ADDRESS using the `send_email` binding and keep
 * a copy in the Sent folder. The runtime builds the MIME message, so no extra
 * library is needed.
 */
export async function sendEmail(env: Env, mail: OutgoingEmail, thread: ThreadHeaders = {}): Promise<MessageRecord> {
  const headers: Record<string, string> = {};
  if (thread.inReplyTo) headers["In-Reply-To"] = headerValue(thread.inReplyTo);
  if (thread.references) headers["References"] = headerValue(thread.references);

  const files = (mail.attachments ?? []).map((a) => ({
    filename: cleanFilename(a.filename),
    type: a.type || "application/octet-stream",
    bytes: base64ToBytes(a.content),
  }));

  const result = await env.EMAIL.send({
    from: { name: env.FROM_NAME, email: env.FROM_ADDRESS },
    to: mail.to,
    cc: mail.cc,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    headers: Object.keys(headers).length ? headers : undefined,
    attachments: files.length
      ? files.map((f) => ({ disposition: "attachment" as const, filename: f.filename, type: f.type, content: f.bytes }))
      : undefined,
  });

  const id = crypto.randomUUID();
  const record: MessageRecord = {
    id,
    direction: "out",
    receivedAt: new Date().toISOString(),
    from: env.FROM_NAME ? `${env.FROM_NAME} <${env.FROM_ADDRESS}>` : env.FROM_ADDRESS,
    fromEmail: env.FROM_ADDRESS,
    to: [mail.to].flat().filter((x): x is string => Boolean(x)),
    cc: [mail.cc].flat().filter((x): x is string => Boolean(x)),
    subject: mail.subject,
    messageId: result.messageId,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    date: new Date().toUTCString(),
    text: mail.text,
    html: mail.html,
    rawSize: 0,
    truncated: false,
    read: true,
  };
  try {
    // Keep a copy of each attachment so the Sent folder shows what went out.
    const attachments: AttachmentRecord[] = await Promise.all(
      files.map(async (f) => {
        const attId = crypto.randomUUID();
        const r2Key = `attachments/${id}/${attId}`;
        await env.MAIL_BUCKET.put(r2Key, f.bytes, { httpMetadata: { contentType: f.type } });
        return {
          id: attId,
          messageId: id,
          filename: f.filename,
          mimeType: f.type,
          disposition: "attachment",
          contentId: null,
          size: f.bytes.byteLength,
          r2Key,
        };
      }),
    );
    await insertMessage(env, record, attachments);
  } catch (err) {
    // The mail already went out; failing to file it in Sent shouldn't turn into an error for the caller.
    console.error("Sent mail but failed to store it", result.messageId, err);
  }
  return record;
}

/**
 * Reply later (from the API / inbox UI) to a stored message, keeping the thread
 * intact with In-Reply-To / References.
 */
export async function replyToStored(
  env: Env,
  original: MessageRecord,
  body: { text?: string; html?: string; attachments?: OutgoingAttachment[] },
): Promise<MessageRecord> {
  const to = original.direction === "in" ? original.replyTo || original.fromEmail : original.to[0];
  if (!to) throw new Error("Original message has no address to reply to");
  const references = [original.references, original.messageId].filter(Boolean).join(" ") || undefined;
  return sendEmail(env, { to, subject: replySubject(original.subject), ...body }, {
    inReplyTo: original.messageId,
    references,
  });
}

/**
 * Immediate auto-reply to an inbound message. `message.reply()` threads the
 * reply automatically and always goes to the original sender. The From address
 * must be the address that received it.
 */
export async function sendAutoReply(
  message: ForwardableEmailMessage,
  env: Env,
  originalSubject: string,
): Promise<string> {
  const result = await message.reply({
    from: { name: env.FROM_NAME, email: message.to },
    subject: replySubject(originalSubject),
    headers: { "Auto-Submitted": "auto-replied" },
    text:
      "Thanks for your email! This is an automatic confirmation that we received it.\n" +
      "We'll get back to you as soon as we can.\n",
    html:
      "<p>Thanks for your email! This is an automatic confirmation that we received it.</p>" +
      "<p>We'll get back to you as soon as we can.</p>",
  });
  return result.messageId;
}

/**
 * Never auto-reply to automated mail: bounces, mailing lists, other
 * auto-responders, or ourselves. Without this, two auto-responders can loop forever.
 */
export function shouldAutoReply(message: ForwardableEmailMessage, env: Env): boolean {
  if (env.AUTO_REPLY !== "true") return false;

  const h = message.headers;
  const autoSubmitted = h.get("auto-submitted");
  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") return false;
  if (h.has("list-id") || h.has("list-unsubscribe")) return false;
  if (/^(bulk|list|junk|auto_reply)$/i.test(h.get("precedence") ?? "")) return false;
  if (h.has("x-autoreply") || h.has("x-autorespond")) return false;

  const from = message.from.toLowerCase();
  if (!from || /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/.test(from)) return false;
  const ourDomain = env.FROM_ADDRESS.split("@")[1]?.toLowerCase();
  if (ourDomain && from.endsWith("@" + ourDomain)) return false;

  return true;
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject || "your message"}`;
}

/**
 * Check client-supplied attachments; returns an error message or null.
 * Size is computed from the base64 length so nothing is decoded before validation passes.
 */
export function validateAttachments(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "`attachments` must be a list";
  if (value.length > MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} attachments`;
  let total = 0;
  for (const a of value) {
    if (!a || typeof a.filename !== "string" || !a.filename.trim()) return "Each attachment needs a `filename`";
    if (typeof a.content !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.content)) {
      return `Attachment ${a.filename} must have base64 \`content\``;
    }
    if (a.type !== undefined && typeof a.type !== "string") return "Attachment `type` must be a string";
    total += Math.floor((a.content.length * 3) / 4);
  }
  if (total > MAX_ATTACHMENT_BYTES) return `Attachments are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB in total`;
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function cleanFilename(name: string): string {
  return name.replace(/[\\/\r\n"]/g, "_").trim().slice(0, 200) || "attachment";
}

/** Header values must be a single line; drop anything that could inject extra headers. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
