import type { Env } from "./env";
import { deleteEmail, getEmail, listEmails } from "./storage";
import { sendEmail, type OutgoingEmail } from "./outbound";

/**
 * Tiny JSON API for viewing stored mail and sending messages.
 *
 *   GET    /health                    -> liveness check (no auth)
 *   GET    /api/messages?limit=&cursor= -> newest-first list of summaries
 *   GET    /api/messages/:id          -> full parsed message
 *   DELETE /api/messages/:id          -> remove a message
 *   POST   /api/send                  -> send { to, subject, text?, html?, cc?, replyTo? }
 *
 * All /api routes require `Authorization: Bearer <API_TOKEN>`.
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/health") return json({ ok: true });
  if (!pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }

  try {
    if (pathname === "/api/messages" && request.method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      return json(await listEmails(env, limit, cursor));
    }

    const match = pathname.match(/^\/api\/messages\/([\w-]+)$/);
    if (match) {
      const id = match[1];
      if (request.method === "GET") {
        const email = await getEmail(env, id);
        return email ? json(email) : json({ error: "Not found" }, 404);
      }
      if (request.method === "DELETE") {
        await deleteEmail(env, id);
        return json({ deleted: id });
      }
    }

    if (pathname === "/api/send" && request.method === "POST") {
      const body = await request.json<Partial<OutgoingEmail>>().catch(() => null);
      const error = validateOutgoing(body);
      if (error) return json({ error }, 400);
      const messageId = await sendEmail(env, body as OutgoingEmail);
      return json({ sent: true, messageId });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("API error", pathname, err);
    return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}

function validateOutgoing(body: Partial<OutgoingEmail> | null): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const recipients = [body.to].flat().filter(Boolean);
  if (recipients.length === 0) return "`to` is required";
  if (!recipients.every((r) => typeof r === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r))) {
    return "`to` must be an email address or a list of them";
  }
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

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
