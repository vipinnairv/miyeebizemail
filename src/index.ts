import type { Env } from "./env";
import { handleInbound } from "./inbound";
import { handleApi } from "./api";
import { purgeOlderThan } from "./db";

export default {
  /** Inbound mail from Cloudflare Email Routing. */
  async email(message, env) {
    await handleInbound(message, env);
  },

  /**
   * HTTP API. The web inbox in public/ is served by Workers static assets
   * before this handler runs, so only non-asset paths (e.g. /api/*) reach it.
   */
  async fetch(request, env) {
    return handleApi(request, env);
  },

  /** Daily retention cleanup (cron trigger in wrangler.jsonc). */
  async scheduled(_controller, env) {
    const days = Number(env.RETENTION_DAYS) || 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const deleted = await purgeOlderThan(env, cutoff);

    // Spam is kept for a shorter time.
    const spamDays = Number(env.SPAM_RETENTION_DAYS) || 30;
    const spamCutoff = new Date(Date.now() - spamDays * 24 * 60 * 60 * 1000).toISOString();
    const deletedSpam = await purgeOlderThan(env, spamCutoff, true);
    console.log(JSON.stringify({ event: "retention.purged", deleted, deletedSpam, cutoff, spamCutoff }));
  },
} satisfies ExportedHandler<Env>;
