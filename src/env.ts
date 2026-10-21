/**
 * Bindings and variables available to the Worker. Keep this in sync with
 * wrangler.jsonc (or generate it with `npx wrangler types`).
 */
export interface Env {
  /** D1 database holding messages and attachment metadata (see migrations/). */
  DB: D1Database;
  /** R2 bucket holding original .eml files and attachment bytes. */
  MAIL_BUCKET: R2Bucket;
  /** Outbound email binding (`send_email` in wrangler.jsonc). */
  EMAIL: SendEmail;

  FROM_ADDRESS: string;
  FROM_NAME: string;
  /** Verified destination address to forward inbound mail to; "" disables forwarding. */
  FORWARD_TO: string;
  /** "true" to send an automatic acknowledgement to inbound senders. */
  AUTO_REPLY: string;
  /** Messages older than this are deleted by the daily cron job. */
  RETENTION_DAYS: string;
  /** Spam score at or above which inbound mail goes to the Spam folder. */
  SPAM_THRESHOLD: string;
  /** Messages in the Spam folder are deleted after this many days. */
  SPAM_RETENTION_DAYS: string;

  /** Secret: bearer token protecting the HTTP API and web inbox. */
  API_TOKEN: string;
}
