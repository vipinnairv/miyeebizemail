import type { Env } from "./env";

export type Direction = "in" | "out";
export type Folder = "inbox" | "spam" | "sent";

/** A message as written to / read from D1. */
export interface MessageRecord {
  id: string;
  direction: Direction;
  receivedAt: string;
  envelopeFrom?: string;
  envelopeTo?: string;
  from: string;
  fromEmail?: string;
  replyTo?: string;
  to: string[];
  cc: string[];
  subject: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  text?: string;
  html?: string;
  rawKey?: string;
  rawSize: number;
  /** Set when a body was cut to fit D1's row size limit, or the message was too large to parse. */
  truncated: boolean;
  read: boolean;
  isSpam?: boolean;
  spamScore?: number;
  spamReasons?: string[];
}

export interface AttachmentRecord {
  id: string;
  messageId: string;
  filename: string | null;
  mimeType: string;
  disposition: string | null;
  contentId: string | null;
  size: number;
  r2Key: string;
}

export interface MessageSummary {
  id: string;
  direction: Direction;
  receivedAt: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  read: boolean;
  isSpam: boolean;
  attachmentCount: number;
}

// D1 rows are capped at 2 MB, so bodies are limited by byte size before insert.
const MAX_TEXT_BYTES = 300_000;
const MAX_HTML_BYTES = 1_200_000;

export async function insertMessage(env: Env, msg: MessageRecord, attachments: AttachmentRecord[] = []): Promise<void> {
  const text = truncateBytes(msg.text, MAX_TEXT_BYTES);
  const html = truncateBytes(msg.html, MAX_HTML_BYTES);
  const truncated = msg.truncated || text.cut || html.cut;

  const statements = [
    env.DB.prepare(
      `INSERT INTO messages (id, direction, received_at, envelope_from, envelope_to, from_addr, from_email,
         reply_to, to_addrs, cc_addrs, subject, message_id, in_reply_to, references_hdr, sent_date,
         text, html, snippet, raw_key, raw_size, truncated, is_read, is_spam, spam_score, spam_reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      msg.id,
      msg.direction,
      msg.receivedAt,
      msg.envelopeFrom ?? null,
      msg.envelopeTo ?? null,
      msg.from,
      msg.fromEmail ?? null,
      msg.replyTo ?? null,
      JSON.stringify(msg.to),
      JSON.stringify(msg.cc),
      msg.subject,
      msg.messageId ?? null,
      msg.inReplyTo ?? null,
      msg.references ?? null,
      msg.date ?? null,
      text.value ?? null,
      html.value ?? null,
      makeSnippet(msg.text, msg.html),
      msg.rawKey ?? null,
      msg.rawSize,
      truncated ? 1 : 0,
      msg.read ? 1 : 0,
      msg.isSpam ? 1 : 0,
      msg.spamScore ?? 0,
      JSON.stringify(msg.spamReasons ?? []),
    ),
    ...attachments.map((a) =>
      env.DB.prepare(
        `INSERT INTO attachments (id, message_id, filename, mime_type, disposition, content_id, size, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(a.id, a.messageId, a.filename, a.mimeType, a.disposition, a.contentId, a.size, a.r2Key),
    ),
  ];
  // batch() runs as a single transaction: the message and its attachments land together or not at all.
  await env.DB.batch(statements);
}

export interface ListOptions {
  folder: Folder;
  query?: string;
  limit: number;
  /** Opaque cursor returned by a previous call. */
  cursor?: string;
}

export async function listMessages(
  env: Env,
  opts: ListOptions,
): Promise<{ messages: MessageSummary[]; cursor?: string }> {
  const where = ["m.direction = ?", "m.is_spam = ?"];
  const params: unknown[] = [opts.folder === "sent" ? "out" : "in", opts.folder === "spam" ? 1 : 0];
  let join = "";

  const match = opts.query ? toFtsQuery(opts.query) : "";
  if (match) {
    join = "JOIN messages_fts ON messages_fts.rowid = m.rowid";
    where.push("messages_fts MATCH ?");
    params.push(match);
  }

  const after = decodeCursor(opts.cursor);
  if (after) {
    where.push("(m.received_at, m.id) < (?, ?)");
    params.push(after.receivedAt, after.id);
  }

  // Fetch one extra row to know whether another page exists.
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.direction, m.received_at, m.from_addr, m.to_addrs, m.subject, m.snippet, m.is_read, m.is_spam,
       (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id AND a.content_id IS NULL) AS attachment_count
     FROM messages m ${join}
     WHERE ${where.join(" AND ")}
     ORDER BY m.received_at DESC, m.id DESC
     LIMIT ?`,
  )
    .bind(...params, opts.limit + 1)
    .all<Record<string, unknown>>();

  const page = results.slice(0, opts.limit).map(
    (r): MessageSummary => ({
      id: r.id as string,
      direction: r.direction as Direction,
      receivedAt: r.received_at as string,
      from: r.from_addr as string,
      to: parseJsonArray(r.to_addrs),
      subject: r.subject as string,
      snippet: r.snippet as string,
      read: r.is_read === 1,
      isSpam: r.is_spam === 1,
      attachmentCount: r.attachment_count as number,
    }),
  );
  const last = page[page.length - 1];
  return {
    messages: page,
    cursor: results.length > opts.limit && last ? encodeCursor(last.receivedAt, last.id) : undefined,
  };
}

/** Unread counts for the Inbox and Spam folders. */
export async function countUnread(env: Env): Promise<{ inbox: number; spam: number }> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(is_spam = 0), 0) AS inbox, COALESCE(SUM(is_spam = 1), 0) AS spam
     FROM messages WHERE direction = 'in' AND is_read = 0`,
  ).first<{ inbox: number; spam: number }>();
  return { inbox: row?.inbox ?? 0, spam: row?.spam ?? 0 };
}

export async function getMessage(
  env: Env,
  id: string,
): Promise<(MessageRecord & { attachments: Omit<AttachmentRecord, "r2Key">[] }) | null> {
  const [msgRes, attRes] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id),
    env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid").bind(id),
  ]);
  const r = msgRes.results[0];
  if (!r) return null;
  return {
    id: r.id as string,
    direction: r.direction as Direction,
    receivedAt: r.received_at as string,
    envelopeFrom: (r.envelope_from as string) ?? undefined,
    envelopeTo: (r.envelope_to as string) ?? undefined,
    from: r.from_addr as string,
    fromEmail: (r.from_email as string) ?? undefined,
    replyTo: (r.reply_to as string) ?? undefined,
    to: parseJsonArray(r.to_addrs),
    cc: parseJsonArray(r.cc_addrs),
    subject: r.subject as string,
    messageId: (r.message_id as string) ?? undefined,
    inReplyTo: (r.in_reply_to as string) ?? undefined,
    references: (r.references_hdr as string) ?? undefined,
    date: (r.sent_date as string) ?? undefined,
    text: (r.text as string) ?? undefined,
    html: (r.html as string) ?? undefined,
    rawKey: (r.raw_key as string) ?? undefined,
    rawSize: r.raw_size as number,
    truncated: r.truncated === 1,
    read: r.is_read === 1,
    isSpam: r.is_spam === 1,
    spamScore: r.spam_score as number,
    spamReasons: parseJsonArray(r.spam_reasons),
    attachments: attRes.results.map((a) => ({
      id: a.id as string,
      messageId: a.message_id as string,
      filename: (a.filename as string) ?? null,
      mimeType: a.mime_type as string,
      disposition: (a.disposition as string) ?? null,
      contentId: (a.content_id as string) ?? null,
      size: a.size as number,
    })),
  };
}

export async function getAttachment(env: Env, id: string): Promise<AttachmentRecord | null> {
  const a = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!a) return null;
  return {
    id: a.id as string,
    messageId: a.message_id as string,
    filename: (a.filename as string) ?? null,
    mimeType: a.mime_type as string,
    disposition: (a.disposition as string) ?? null,
    contentId: (a.content_id as string) ?? null,
    size: a.size as number,
    r2Key: a.r2_key as string,
  };
}

export async function setRead(env: Env, id: string, read: boolean): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE messages SET is_read = ? WHERE id = ?").bind(read ? 1 : 0, id).run();
  return res.meta.changes > 0;
}

/** Move an inbound message between Inbox and Spam. Returns its sender address, or null if not found. */
export async function setSpam(env: Env, id: string, spam: boolean): Promise<string | null> {
  const row = await env.DB.prepare(
    "UPDATE messages SET is_spam = ? WHERE id = ? AND direction = 'in' RETURNING from_email, envelope_from",
  )
    .bind(spam ? 1 : 0, id)
    .first<{ from_email: string | null; envelope_from: string | null }>();
  if (!row) return null;
  return (row.from_email || row.envelope_from || "").toLowerCase();
}

/** Deletes messages (attachments cascade) and their R2 objects. Returns how many messages were removed. */
export async function deleteMessages(env: Env, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const [raw, att] = await env.DB.batch<{ key: string }>([
    env.DB.prepare(`SELECT raw_key AS key FROM messages WHERE id IN (${placeholders}) AND raw_key IS NOT NULL`).bind(...ids),
    env.DB.prepare(`SELECT r2_key AS key FROM attachments WHERE message_id IN (${placeholders})`).bind(...ids),
  ]);
  const keys = [...raw.results, ...att.results].map((r) => r.key);

  // RETURNING gives the real count; meta.changes also counts rows touched by the cascade and FTS triggers.
  const { results: deleted } = await env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders}) RETURNING id`)
    .bind(...ids)
    .all();
  // Delete the bytes after the rows, so the API never points at a missing object.
  for (let i = 0; i < keys.length; i += 1000) await env.MAIL_BUCKET.delete(keys.slice(i, i + 1000));
  return deleted.length;
}

/** Retention cleanup, called from the cron trigger. Works in batches to stay within limits. */
export async function purgeOlderThan(env: Env, cutoffIso: string, onlySpam = false): Promise<number> {
  let total = 0;
  const sql = `SELECT id FROM messages WHERE received_at < ?${onlySpam ? " AND is_spam = 1" : ""} LIMIT 50`;
  for (let round = 0; round < 20; round++) {
    const { results } = await env.DB.prepare(sql).bind(cutoffIso).all<{ id: string }>();
    if (results.length === 0) break;
    total += await deleteMessages(
      env,
      results.map((r) => r.id),
    );
  }
  return total;
}

/**
 * Turn free text into a safe FTS5 query: each word becomes a quoted prefix
 * term, so user input can't produce FTS syntax errors.
 */
function toFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((t) => `"${t}"*`)
    .join(" ");
}

function encodeCursor(receivedAt: string, id: string): string {
  return btoa(JSON.stringify([receivedAt, id]));
}

function decodeCursor(cursor?: string): { receivedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [receivedAt, id] = JSON.parse(atob(cursor));
    return typeof receivedAt === "string" && typeof id === "string" ? { receivedAt, id } : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function makeSnippet(text?: string, html?: string): string {
  const source = text || (html ?? "").replace(/<style[\s\S]*?<\/style>|<[^>]+>/gi, " ");
  return source.replace(/\s+/g, " ").trim().slice(0, 200);
}

function truncateBytes(value: string | undefined, maxBytes: number): { value?: string; cut: boolean } {
  if (value === undefined) return { cut: false };
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return { value, cut: false };
  return { value: new TextDecoder().decode(bytes.slice(0, maxBytes)), cut: true };
}
