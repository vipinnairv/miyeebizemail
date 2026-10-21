/**
 * Bindings and variables available to the Worker. Keep this in sync with
 * wrangler.jsonc (or generate it with `npx wrangler types`).
 */
export interface Env {
  /** KV namespace holding parsed inbound messages. */
  EMAIL_LOG: KVNamespace;
  /** Outbound email binding (`send_email` in wrangler.jsonc). */
  EMAIL: SendEmail;

  FROM_ADDRESS: string;
  FROM_NAME: string;
  /** Verified destination address to forward inbound mail to; "" disables forwarding. */
  FORWARD_TO: string;
  /** "true" to send an automatic acknowledgement to inbound senders. */
  AUTO_REPLY: string;
  RETENTION_DAYS: string;

  /** Secret: bearer token protecting the HTTP API. */
  API_TOKEN: string;
}
