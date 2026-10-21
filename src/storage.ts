import type { Env } from "./env";

/** Everything we keep about one inbound message. */
export interface StoredEmail {
  id: string;
  receivedAt: string;
  /** SMTP envelope sender / recipient (what Cloudflare actually routed). */
  envelopeFrom: string;
  envelopeTo: string;
  /** Header values as parsed by postal-mime. */
  from: string;
  to: string[];
  subject: string;
  messageId?: string;
  date?: string;
  text?: string;
  html?: string;
  attachments: { filename: string | null; mimeType: string; size: number }[];
  rawSize: number;
  /** Set when the body was too large to parse and only headers were kept. */
  truncated?: boolean;
}

/** Small summary stored as KV metadata so listing needs no extra reads. */
export interface EmailSummary {
  from: string;
  subject: string;
  receivedAt: string;
  snippet: string;
}

const PREFIX = "msg:";
// KV metadata is limited to 1024 bytes once serialized.
const MAX_METADATA_BYTES = 1000;
// Keep stored bodies bounded; KV values can be large, but the API doesn't need megabytes of HTML.
const MAX_BODY_CHARS = 200_000;

/**
 * IDs start with an inverted timestamp so KV's lexicographic `list()` returns
 * the newest messages first.
 */
export function newMessageId(now = Date.now()): string {
  const inverted = (9_999_999_999_999 - now).toString().padStart(13, "0");
  return `${inverted}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function saveEmail(env: Env, email: StoredEmail): Promise<void> {
  const record: StoredEmail = {
    ...email,
    text: email.text?.slice(0, MAX_BODY_CHARS),
    html: email.html?.slice(0, MAX_BODY_CHARS),
  };
  const days = Number(env.RETENTION_DAYS) || 30;
  await env.EMAIL_LOG.put(PREFIX + email.id, JSON.stringify(record), {
    expirationTtl: days * 24 * 60 * 60,
    metadata: summarize(email),
  });
}

export async function getEmail(env: Env, id: string): Promise<StoredEmail | null> {
  return env.EMAIL_LOG.get<StoredEmail>(PREFIX + id, "json");
}

export async function listEmails(
  env: Env,
  limit: number,
  cursor?: string,
): Promise<{ messages: (EmailSummary & { id: string })[]; cursor?: string }> {
  const page = await env.EMAIL_LOG.list<EmailSummary>({ prefix: PREFIX, limit, cursor });
  return {
    messages: page.keys.map((k) => ({
      id: k.name.slice(PREFIX.length),
      ...(k.metadata ?? { from: "", subject: "", receivedAt: "", snippet: "" }),
    })),
    cursor: page.list_complete ? undefined : page.cursor,
  };
}

export async function deleteEmail(env: Env, id: string): Promise<void> {
  await env.EMAIL_LOG.delete(PREFIX + id);
}

function summarize(email: StoredEmail): EmailSummary {
  const summary: EmailSummary = {
    from: email.from.slice(0, 200),
    subject: email.subject.slice(0, 200),
    receivedAt: email.receivedAt,
    snippet: (email.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
  // Non-ASCII text can take up to 4 bytes per character, so shrink until it fits.
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(summary)).length > MAX_METADATA_BYTES) {
    if (summary.snippet) summary.snippet = summary.snippet.slice(0, -20);
    else if (summary.subject.length > 20) summary.subject = summary.subject.slice(0, -20);
    else summary.from = summary.from.slice(0, -20);
  }
  return summary;
}
