import type { Env } from "./env";
import { countUnread, deleteMessages, getAttachment, getMessage, listMessages, setRead, setSpam, type Folder } from "./db";
import { replyToStored, sendEmail, validateAttachments, type OutgoingAttachment, type OutgoingEmail } from "./outbound";
import { deleteSenderRule, listSenderRules, normalizePattern, setSenderRule, type RuleAction } from "./spam";

/**
 * JSON API used by the web inbox (public/) and by scripts.
 *
 *   GET    /health                          liveness check (no auth)
 *   GET    /api/messages?folder=&q=&limit=&cursor=
 *                                           newest-first summaries; folder = inbox | spam | sent, q = full-text search
 *   GET    /api/messages/:id                full message with attachment list
 *   PATCH  /api/messages/:id                { "read": true | false }
 *   DELETE /api/messages/:id                delete message, attachments and original
 *   GET    /api/messages/:id/raw            original .eml (inbound only)
 *   POST   /api/messages/:id/reply          { "text", "html"?, "attachments"? } threaded reply
 *   POST   /api/messages/:id/spam           { "spam": bool, "rememberSender"?: bool } move to Spam / Inbox
 *   GET    /api/attachments/:id             attachment download
 *   POST   /api/send                        { "to", "subject", "text"?, "html"?, "cc"?, "replyTo"?, "attachments"? }
 *   GET    /api/rules                       sender rules (allow / spam / block)
 *   POST   /api/rules                       { "pattern": "a@b.com" | "@b.com", "action" }
 *   DELETE /api/rules/:pattern              remove a rule
 *
 * Attachments are { "filename", "type", "content" } with base64 content.
 *
 * All /api routes require `Authorization: Bearer <API_TOKEN>`.
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/health") return json({ ok: true });
  if (!pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }

  try {
    if (pathname === "/api/messages" && method === "GET") {
      const requested = url.searchParams.get("folder");
      const folder: Folder = requested === "sent" || requested === "spam" ? requested : "inbox";
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
      const [page, unread] = await Promise.all([
        listMessages(env, {
          folder,
          query: url.searchParams.get("q") ?? undefined,
          limit,
          cursor: url.searchParams.get("cursor") ?? undefined,
        }),
        countUnread(env),
      ]);
      return json({ ...page, unread: unread.inbox, spamUnread: unread.spam });
    }

    if (pathname === "/api/send" && method === "POST") {
      const body = await readJson<Partial<OutgoingEmail>>(request);
      const error = validateOutgoing(body);
      if (error) return json({ error }, 400);
      const sent = await sendEmail(env, body as OutgoingEmail);
      return json({ sent: true, id: sent.id, messageId: sent.messageId });
    }

    if (pathname === "/api/rules" && method === "GET") {
      return json({ rules: await listSenderRules(env) });
    }
    if (pathname === "/api/rules" && method === "POST") {
      const body = await readJson<{ pattern?: unknown; action?: unknown }>(request);
      const pattern = typeof body?.pattern === "string" ? normalizePattern(body.pattern) : null;
      if (!pattern) return json({ error: "`pattern` must be an address (a@b.com) or a domain (@b.com)" }, 400);
      if (!isRuleAction(body?.action)) return json({ error: "`action` must be allow, spam or block" }, 400);
      await setSenderRule(env, pattern, body.action);
      return json({ pattern, action: body.action });
    }
    const rule = pathname.match(/^\/api\/rules\/(.+)$/);
    if (rule && method === "DELETE") {
      const pattern = decodeURIComponent(rule[1]).toLowerCase();
      return (await deleteSenderRule(env, pattern)) ? json({ deleted: pattern }) : notFound();
    }

    let m = pathname.match(/^\/api\/messages\/([\w-]+)(\/raw|\/reply|\/spam)?$/);
    if (m) {
      const [, id, sub] = m;

      if (!sub && method === "GET") {
        const msg = await getMessage(env, id);
        if (!msg) return notFound();
        const { rawKey, ...rest } = msg;
        return json({ ...rest, hasRaw: Boolean(rawKey) });
      }
      if (!sub && method === "PATCH") {
        const body = await readJson<{ read?: unknown }>(request);
        if (typeof body?.read !== "boolean") return json({ error: "`read` must be a boolean" }, 400);
        return (await setRead(env, id, body.read)) ? json({ id, read: body.read }) : notFound();
      }
      if (!sub && method === "DELETE") {
        return (await deleteMessages(env, [id])) ? json({ deleted: id }) : notFound();
      }
      if (sub === "/raw" && method === "GET") {
        const msg = await getMessage(env, id);
        const obj = msg?.rawKey ? await env.MAIL_BUCKET.get(msg.rawKey) : null;
        if (!obj) return notFound();
        return download(obj.body, "message/rfc822", `${id}.eml`);
      }
      if (sub === "/reply" && method === "POST") {
        const body = await readJson<{ text?: unknown; html?: unknown; attachments?: unknown }>(request);
        const text = typeof body?.text === "string" ? body.text : undefined;
        const html = typeof body?.html === "string" ? body.html : undefined;
        if (!text?.trim() && !html?.trim()) return json({ error: "Provide `text` and/or `html`" }, 400);
        const attachmentError = validateAttachments(body?.attachments);
        if (attachmentError) return json({ error: attachmentError }, 400);
        const original = await getMessage(env, id);
        if (!original) return notFound();
        const attachments = body?.attachments as OutgoingAttachment[] | undefined;
        const sent = await replyToStored(env, original, { text, html, attachments });
        return json({ sent: true, id: sent.id, messageId: sent.messageId });
      }
      if (sub === "/spam" && method === "POST") {
        const body = await readJson<{ spam?: unknown; rememberSender?: unknown }>(request);
        if (typeof body?.spam !== "boolean") return json({ error: "`spam` must be a boolean" }, 400);
        const sender = await setSpam(env, id, body.spam);
        if (sender === null) return notFound();
        // By default, teach the filter: future mail from this sender follows the same choice.
        let rule: string | undefined;
        if (body.rememberSender !== false && sender) {
          const pattern = normalizePattern(sender);
          if (pattern) {
            await setSenderRule(env, pattern, body.spam ? "spam" : "allow");
            rule = pattern;
          }
        }
        return json({ id, spam: body.spam, rule });
      }
    }

    m = pathname.match(/^\/api\/attachments\/([\w-]+)$/);
    if (m && method === "GET") {
      const att = await getAttachment(env, m[1]);
      const obj = att ? await env.MAIL_BUCKET.get(att.r2Key) : null;
      if (!att || !obj) return notFound();
      return download(obj.body, att.mimeType, att.filename ?? "attachment");
    }

    return notFound();
  } catch (err) {
    console.error("API error", method, pathname, err);
    return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}

function validateOutgoing(body: Partial<OutgoingEmail> | null): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const isEmail = (r: unknown) => typeof r === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r);
  const recipients = [body.to].flat().filter(Boolean);
  if (recipients.length === 0) return "`to` is required";
  if (!recipients.every(isEmail)) return "`to` must be an email address or a list of them";
  if (body.cc !== undefined && ![body.cc].flat().every(isEmail)) return "`cc` must be email addresses";
  if (body.replyTo !== undefined && !isEmail(body.replyTo)) return "`replyTo` must be an email address";
  if (typeof body.subject !== "string" || !body.subject.trim()) return "`subject` is required";
  if (!body.text && !body.html) return "Provide `text` and/or `html`";
  return validateAttachments(body.attachments);
}

function isRuleAction(value: unknown): value is RuleAction {
  return value === "allow" || value === "spam" || value === "block";
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.API_TOKEN) return false; // Fail closed if the secret was never set.
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(env.API_TOKEN);
  // Constant-time comparison so the token can't be guessed byte by byte from response timing.
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function readJson<T>(request: Request): Promise<T | null> {
  return request.json<T>().catch(() => null);
}

/**
 * Serve stored bytes as a download. Attachments are untrusted (they can be HTML
 * or SVG with scripts), so they are never rendered inline on this origin.
 */
function download(body: ReadableStream, contentType: string, filename: string): Response {
  const safeName = filename.replace(/[\r\n"\\]/g, "_");
  return new Response(body, {
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

function notFound(): Response {
  return json({ error: "Not found" }, 404);
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
