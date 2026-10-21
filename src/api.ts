import type { Env } from "./env";
import { countUnread, deleteMessages, getAttachment, getMessage, listMessages, setRead } from "./db";
import { replyToStored, sendEmail, type OutgoingEmail } from "./outbound";

/**
 * JSON API used by the web inbox (public/) and by scripts.
 *
 *   GET    /health                          liveness check (no auth)
 *   GET    /api/messages?folder=&q=&limit=&cursor=
 *                                           newest-first summaries; folder = inbox | sent, q = full-text search
 *   GET    /api/messages/:id                full message with attachment list
 *   PATCH  /api/messages/:id                { "read": true | false }
 *   DELETE /api/messages/:id                delete message, attachments and original
 *   GET    /api/messages/:id/raw            original .eml (inbound only)
 *   POST   /api/messages/:id/reply          { "text", "html"? } threaded reply
 *   GET    /api/attachments/:id             attachment download
 *   POST   /api/send                        { "to", "subject", "text"?, "html"?, "cc"?, "replyTo"? }
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
      const folder = url.searchParams.get("folder") === "sent" ? "out" : "in";
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
      const [page, unread] = await Promise.all([
        listMessages(env, {
          direction: folder,
          query: url.searchParams.get("q") ?? undefined,
          limit,
          cursor: url.searchParams.get("cursor") ?? undefined,
        }),
        countUnread(env),
      ]);
      return json({ ...page, unread });
    }

    if (pathname === "/api/send" && method === "POST") {
      const body = await readJson<Partial<OutgoingEmail>>(request);
      const error = validateOutgoing(body);
      if (error) return json({ error }, 400);
      const sent = await sendEmail(env, body as OutgoingEmail);
      return json({ sent: true, id: sent.id, messageId: sent.messageId });
    }

    let m = pathname.match(/^\/api\/messages\/([\w-]+)(\/raw|\/reply)?$/);
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
        const body = await readJson<{ text?: unknown; html?: unknown }>(request);
        const text = typeof body?.text === "string" ? body.text : undefined;
        const html = typeof body?.html === "string" ? body.html : undefined;
        if (!text?.trim() && !html?.trim()) return json({ error: "Provide `text` and/or `html`" }, 400);
        const original = await getMessage(env, id);
        if (!original) return notFound();
        const sent = await replyToStored(env, original, { text, html });
        return json({ sent: true, id: sent.id, messageId: sent.messageId });
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
  return null;
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
