import type { Env } from "./env";

export interface OutgoingEmail {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  replyTo?: string;
}

/**
 * Send a new message from FROM_ADDRESS using the `send_email` binding.
 * The runtime builds the MIME message for us, so no extra library is needed.
 */
export async function sendEmail(env: Env, mail: OutgoingEmail): Promise<string> {
  const result = await env.EMAIL.send({
    from: { name: env.FROM_NAME, email: env.FROM_ADDRESS },
    to: mail.to,
    cc: mail.cc,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  return result.messageId;
}

/**
 * Reply to an inbound message. `message.reply()` keeps the reply in the same
 * thread (In-Reply-To / References are set automatically) and always goes to
 * the original sender. The From address must be the address that received it.
 */
export async function sendAutoReply(
  message: ForwardableEmailMessage,
  env: Env,
  originalSubject: string,
): Promise<string> {
  const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject || "your message"}`;
  const result = await message.reply({
    from: { name: env.FROM_NAME, email: message.to },
    subject,
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
