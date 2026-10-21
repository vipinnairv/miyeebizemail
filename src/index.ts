import type { Env } from "./env";
import { handleInbound } from "./inbound";
import { handleApi } from "./api";

export default {
  /** Inbound mail from Cloudflare Email Routing. */
  async email(message, env, ctx) {
    await handleInbound(message, env, ctx);
  },

  /** HTTP API for reading stored mail and sending messages. */
  async fetch(request, env) {
    return handleApi(request, env);
  },
} satisfies ExportedHandler<Env>;
