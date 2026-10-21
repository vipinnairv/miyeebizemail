import type { Email } from "postal-mime";
import type { Env } from "./env";

/**
 * Spam filtering for inbound mail.
 *
 * Each check adds points; a message at or above SPAM_THRESHOLD goes to the Spam
 * folder. Sender rules (allow / spam / block) set by the user override the score.
 * Every point comes with a human-readable reason so the inbox can explain the verdict.
 */

export type RuleAction = "allow" | "spam" | "block";

export interface SenderRule {
  pattern: string;
  action: RuleAction;
  createdAt: string;
}

export interface SpamVerdict {
  /** "block" means reject at SMTP and don't store anything. */
  action: "inbox" | "spam" | "block";
  score: number;
  reasons: string[];
}

export interface SpamInput {
  headers: Headers;
  /** SMTP envelope sender: set by the sending server, harder to fake than the From header. */
  envelopeFrom: string;
  /** Bare address from the From header. */
  fromEmail?: string;
  /** Display name from the From header. */
  fromName?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments: { filename: string | null }[];
}

const DEFAULT_THRESHOLD = 5;

const DANGEROUS_EXTENSIONS =
  /\.(exe|scr|bat|cmd|com|pif|cpl|js|jse|vbs|vbe|wsf|wsh|hta|msi|msp|jar|ps1|psm1|lnk|reg|iso|img|vhd|vhdx|appx|msix)$/i;

const SPAM_PHRASES = [
  "you have won",
  "you've won",
  "claim your prize",
  "lottery",
  "jackpot",
  "inheritance",
  "beneficiary",
  "next of kin",
  "western union",
  "moneygram",
  "wire transfer",
  "bitcoin",
  "crypto investment",
  "guaranteed income",
  "make money fast",
  "work from home",
  "100% free",
  "risk-free",
  "act now",
  "limited time offer",
  "urgent response",
  "verify your account",
  "confirm your account",
  "account suspended",
  "account has been locked",
  "unusual sign-in activity",
  "your password expires",
  "update your payment",
  "dear friend",
  "dear beneficiary",
  "viagra",
  "casino",
  "weight loss",
];

export async function classify(env: Env, input: SpamInput): Promise<SpamVerdict> {
  const { score, reasons, forged } = scoreMessage(input, ourDomain(env));
  const sender = (input.fromEmail || input.envelopeFrom).toLowerCase();
  const rule = await findSenderRule(env, sender);

  if (rule?.action === "block") return { action: "block", score, reasons: [`Sender is blocked (${rule.pattern})`] };
  // An allow rule matches the From header, which can be faked, so it doesn't apply to forged mail.
  if (rule?.action === "allow" && !forged) return { action: "inbox", score, reasons: [`Sender is on your allow list (${rule.pattern})`, ...reasons] };
  if (rule?.action === "spam") return { action: "spam", score, reasons: [`You marked this sender as spam (${rule.pattern})`, ...reasons] };

  const threshold = Number(env.SPAM_THRESHOLD) || DEFAULT_THRESHOLD;
  return { action: score >= threshold ? "spam" : "inbox", score, reasons };
}

export function scoreMessage(
  input: SpamInput,
  domain: string | undefined,
): { score: number; reasons: string[]; forged: boolean } {
  let score = 0;
  /** True when the From address is shown to be fake (DMARC failure or spoofing our own domain). */
  let forged = false;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  // 1. Cloudflare's own spam score (0-5, higher = more likely spam).
  const cf = Number.parseFloat(input.headers.get("x-cf-spamh-score") ?? "");
  if (Number.isFinite(cf) && cf > 0) add(cf, `Cloudflare spam score ${cf}/5`);

  // 2. Sender authentication, when the receiving server recorded it.
  const auth = [input.headers.get("authentication-results"), input.headers.get("arc-authentication-results")]
    .filter(Boolean)
    .join("; ")
    .toLowerCase();
  if (/\bdmarc=fail\b/.test(auth)) forged = true;
  if (forged) add(4, "Failed DMARC: the sender's domain did not authorize this message");
  if (/\bspf=fail\b/.test(auth)) add(2, "Failed SPF: sent from a server the domain doesn't allow");
  else if (/\bspf=softfail\b/.test(auth)) add(1, "SPF soft fail");
  if (/\bdkim=fail\b/.test(auth)) add(1, "DKIM signature did not verify");

  // 3. Spoofing: claims to be from your own domain but came from somewhere else.
  const fromDomain = domainOf(input.fromEmail);
  const envelopeDomain = domainOf(input.envelopeFrom);
  if (domain && fromDomain === domain && envelopeDomain !== domain) {
    forged = true;
    add(5, `Pretends to be from your own domain (${domain})`);
  }

  // 4. Display name shows a different address than the real sender, e.g. "support@bank.com" <x@evil.net>.
  const nameAddress = input.fromName?.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0]?.toLowerCase();
  if (nameAddress && nameAddress !== input.fromEmail?.toLowerCase()) {
    add(3, `Sender name shows a different address (${nameAddress})`);
  }

  // 5. Replies redirected to an unrelated domain.
  const replyDomain = domainOf(input.replyTo);
  if (replyDomain && fromDomain && replyDomain !== fromDomain) add(1, `Replies go to a different domain (${replyDomain})`);

  // 6. Dangerous attachments.
  for (const a of input.attachments) {
    if (a.filename && DANGEROUS_EXTENSIONS.test(a.filename.trim())) add(5, `Dangerous attachment: ${a.filename}`);
  }

  // 7. Links whose visible text shows a different website than where they go (phishing).
  const mismatched = mismatchedLinks(input.html ?? "");
  if (mismatched.length) add(3, `Link text shows a different website than it opens (${mismatched.slice(0, 2).join(", ")})`);

  // 8. Content heuristics.
  const subjectLetters = input.subject.replace(/[^a-z]/gi, "");
  if (subjectLetters.length >= 10 && subjectLetters.replace(/[^A-Z]/g, "").length / subjectLetters.length > 0.7) {
    add(1, "Subject is mostly capital letters");
  }
  if (/!{3,}|\${3,}/.test(input.subject)) add(1, "Subject has '!!!' or '$$$'");

  const haystack = `${input.subject}\n${input.text ?? stripTags(input.html ?? "")}`.toLowerCase();
  const phrases = SPAM_PHRASES.filter((p) => haystack.includes(p));
  if (phrases.length) add(Math.min(phrases.length, 3), `Common spam phrases: ${phrases.slice(0, 4).map((p) => `"${p}"`).join(", ")}`);

  if (!input.headers.get("message-id")) add(1, "No Message-ID header");

  return { score: Math.round(score * 10) / 10, reasons, forged };
}

// ---------- sender rules ----------

export async function findSenderRule(env: Env, address: string): Promise<SenderRule | null> {
  const domain = domainOf(address);
  const row = await env.DB.prepare(
    "SELECT pattern, action, created_at FROM sender_rules WHERE pattern IN (?, ?) ORDER BY length(pattern) DESC LIMIT 1",
  )
    .bind(address.toLowerCase(), domain ? `@${domain}` : "")
    .first<{ pattern: string; action: RuleAction; created_at: string }>();
  return row ? { pattern: row.pattern, action: row.action, createdAt: row.created_at } : null;
}

export async function listSenderRules(env: Env): Promise<SenderRule[]> {
  const { results } = await env.DB.prepare(
    "SELECT pattern, action, created_at FROM sender_rules ORDER BY created_at DESC",
  ).all<{ pattern: string; action: RuleAction; created_at: string }>();
  return results.map((r) => ({ pattern: r.pattern, action: r.action, createdAt: r.created_at }));
}

export async function setSenderRule(env: Env, pattern: string, action: RuleAction): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sender_rules (pattern, action, created_at) VALUES (?, ?, ?)
     ON CONFLICT (pattern) DO UPDATE SET action = excluded.action, created_at = excluded.created_at`,
  )
    .bind(pattern, action, new Date().toISOString())
    .run();
}

export async function deleteSenderRule(env: Env, pattern: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM sender_rules WHERE pattern = ?").bind(pattern).run();
  return res.meta.changes > 0;
}

/** Normalize user input to "addr@domain" or "@domain"; null if it is neither. */
export function normalizePattern(input: string): string | null {
  const p = input.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) return p;
  const domain = p.replace(/^@/, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return `@${domain}`;
  return null;
}

// ---------- helpers ----------

/** Pull the From display name and address out of a parsed message. */
export function senderOf(parsed: Email): { name?: string; email?: string } {
  const from = parsed.from;
  if (!from) return {};
  if (from.group) return { name: from.name, email: from.group[0]?.address };
  return { name: from.name || undefined, email: from.address || undefined };
}

function ourDomain(env: Env): string | undefined {
  return domainOf(env.FROM_ADDRESS);
}

function domainOf(address?: string): string | undefined {
  const at = address?.lastIndexOf("@") ?? -1;
  return address && at >= 0 ? address.slice(at + 1).toLowerCase().replace(/>$/, "") : undefined;
}

function hostOf(value: string): string | undefined {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function mismatchedLinks(html: string): string[] {
  const found: string[] = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchor)) {
    const href = m[1].trim();
    const label = stripTags(m[2]).trim();
    // Only judge links whose visible text itself looks like a web address.
    if (!/^https?:\/\//i.test(href) || !/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(label)) continue;
    const shown = hostOf(label);
    const actual = hostOf(href);
    if (shown && actual && shown !== actual && !actual.endsWith(`.${shown}`)) found.push(`${shown} → ${actual}`);
    if (found.length >= 5) break;
  }
  return found;
}

function stripTags(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/gi, " ").replace(/&nbsp;/g, " ");
}
