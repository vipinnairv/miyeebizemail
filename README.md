# miyeebizemail

A custom email app for your domain, running entirely in one Cloudflare Worker:

- **Inbound:** Cloudflare Email Routing delivers mail to the Worker's `email` handler. The Worker keeps the original message in **R2**, parses it with [`postal-mime`](https://github.com/postalsys/postal-mime), saves attachments to **R2**, and indexes the message in **D1** with full-text search. It can also forward the mail to your mailbox and send an automatic acknowledgement.
- **Spam filtering:** every inbound message is scored, and spam goes to a Spam folder with the reasons listed. Spam is never forwarded or auto-replied to. Per-sender **Allow / Spam / Block** rules override the score.
- **Outbound:** the `send_email` binding sends new messages and threaded replies with **attachments**, and keeps a copy in the Sent folder.
- **Web inbox:** a page at `/` with Inbox, Spam and Sent folders, search, reading, attachment downloads, compose with attachments, reply, mark spam / not spam, spam filters, mark unread and delete. It works on phone and desktop, in light and dark mode.
- **API:** the JSON API the inbox uses, also available to scripts.
- **Retention:** a daily cron job deletes messages, and their R2 files, older than `RETENTION_DAYS`.

## Architecture

```
                 ┌──────────────────────────── Cloudflare ─────────────────────────────┐
 sender ──SMTP──▶│ MX (Email Routing) ──rule──▶ Worker.email()                         │
                 │                               ├─ R2: raw/<id>.eml                   │
                 │                               ├─ postal-mime parse                  │
                 │                               ├─ R2: attachments/<id>/<att-id>      │
                 │                               ├─ D1: messages, attachments, FTS     │
                 │                               ├─ forward → FORWARD_TO               │──▶ your inbox
                 │                               └─ reply()  (auto-ack)                │──▶ sender
                 │                                                                     │
 browser ───────▶│ static assets (public/)  ← web inbox                                │
         ──/api─▶│ Worker.fetch()  → D1 queries, R2 downloads, env.EMAIL.send()        │──▶ recipients
                 │ Worker.scheduled() (daily) → delete old rows + R2 objects           │
                 └─────────────────────────────────────────────────────────────────────┘
```

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry: `email`, `fetch` and `scheduled` handlers |
| `src/inbound.ts` | Store original → parse → attachments → D1 → forward → auto-reply |
| `src/spam.ts` | Spam scoring and sender rules (allow / spam / block) |
| `src/outbound.ts` | `sendEmail` (with attachments), `replyToStored`, `sendAutoReply`, and the auto-reply loop guard |
| `src/db.ts` | All D1 queries: insert, list/search, paging, read state, delete, retention |
| `src/api.ts` | HTTP API with bearer-token auth and safe downloads |
| `src/env.ts` | Typed bindings and vars |
| `migrations/0001_init.sql` | D1 schema: `messages`, `attachments`, and the `messages_fts` FTS5 index |
| `migrations/0002_spam_filtering.sql` | Spam columns on `messages`, plus the `sender_rules` table |
| `public/` | Web inbox (`index.html`, `app.js`, `styles.css`) and security headers (`_headers`) |
| `wrangler.jsonc` | Worker config: D1, R2, `send_email`, static assets, cron, vars |

**Design notes**

- **Storage split.** D1 holds what you search and list: headers, text and HTML bodies, and a snippet. R2 holds bytes: the original `.eml` and each attachment. Bodies are capped (300 KB text, 1.2 MB HTML) to stay under D1's 2 MB row limit. A cut message is flagged, and the original stays in R2.
- **Full-text search.** An FTS5 table covers subject, sender and body, kept in sync by triggers. Search terms are quoted before they reach FTS, so typed input can't cause query errors.
- **Paging.** Lists use a cursor on (received time, id) rather than offsets, so pages stay stable while new mail arrives.
- **Isolated steps.** Each inbound step has its own error handling. If storage fails, forwarding and the auto-reply still run.
- **Untrusted HTML mail.** The HTML body is shown in a sandboxed iframe: no scripts, and remote images (tracking pixels) are blocked by CSP. Inline `cid:` images still display. Attachments are only ever downloaded, never rendered on the app's own origin.
- **No reply loops.** Auto-replies skip automated mail: `Auto-Submitted`, `List-Id`, `Precedence: bulk`, `noreply@`, `mailer-daemon@`, and your own domain.

## Spam filtering

Each inbound message gets points from the checks below (`src/spam.ts`). At `SPAM_THRESHOLD` points or more (default **5**) it goes to Spam.

| Check | Points |
| --- | --- |
| Cloudflare's spam score (`X-Cf-Spamh-Score` header, 0–5) | 0–5 |
| DMARC failed | 4 |
| SPF failed / soft-failed | 2 / 1 |
| DKIM failed | 1 |
| Claims to be from your own domain but was sent from elsewhere | 5 |
| Sender name shows a different email address (e.g. `"support@paypal.com" <x@evil.net>`) | 3 |
| Dangerous attachment (`.exe`, `.scr`, `.js`, `.vbs`, `.iso`, …, including `invoice.pdf.exe`) | 5 each |
| Link text shows one website but opens another (phishing) | 3 |
| Reply-To goes to a different domain | 1 |
| Subject mostly capitals / contains `!!!` or `$$$` | 1 each |
| Common scam phrases ("you have won", "verify your account", …) | 1 each, max 3 |
| No Message-ID | 1 |

**Sender rules** (the **Spam filters** link in the inbox, or `/api/rules`) match an exact address (`bob@example.com`) or a whole domain (`@example.com`). An exact address beats a domain.

- **Allow:** always Inbox. Ignored when the message is provably forged (DMARC failure, or pretending to be from your domain), because the From header can be faked.
- **Spam:** always Spam.
- **Block:** the email is rejected during delivery and nothing is stored.

Clicking **Spam** or **Not spam** on a message moves it and adds a Spam or Allow rule for that sender, so the filter learns.

Tuning: set `SPAM_THRESHOLD` lower (e.g. `4`) to be stricter or higher (e.g. `7`) to be more relaxed, then redeploy. Spam is deleted after `SPAM_RETENTION_DAYS` (default 30).

## 1. Local setup

Prerequisites: Node.js 18+ and a Cloudflare account with your domain on Cloudflare DNS.

```bash
npm install
npx wrangler login

# Create the database and bucket, then paste the D1 id into wrangler.jsonc ("REPLACE_WITH_D1_DATABASE_ID")
npx wrangler d1 create miyeebizemail
npx wrangler r2 bucket create miyeebizemail-mail

# Local database schema and secret
npm run db:migrate:local
cp .dev.vars.example .dev.vars        # then edit API_TOKEN
```

Edit `wrangler.jsonc`: set `FROM_ADDRESS`, `FROM_NAME`, `allowed_sender_addresses`, and optionally `FORWARD_TO`.

### Run and test locally

```bash
npm run dev            # http://localhost:8787. Open it and sign in with your API_TOKEN.
```

Simulate an inbound email (wrangler provides this local endpoint):

```bash
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alice@gmail.com&to=hello@example.com' \
  --data-binary $'From: Alice <alice@gmail.com>\r\nTo: hello@example.com\r\nSubject: Hi\r\nMessage-ID: <1@gmail.com>\r\n\r\nHello!\r\n'
```

Trigger the retention job: `curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+3+*+*+*'`

In local dev, outgoing mail is not delivered. Wrangler writes it to `.wrangler/tmp/email/` and logs the path. D1 and R2 are simulated locally under `.wrangler/state/`.

`npm run check` runs the TypeScript check and a dry-run bundle.

### Deploy

```bash
npx wrangler secret put API_TOKEN     # a long random string, e.g. `openssl rand -hex 32`
npm run deploy                        # applies D1 migrations remotely, then deploys
npx wrangler tail                     # live logs
```

The inbox is then at `https://miyeebizemail.<your-subdomain>.workers.dev/`, or at a custom domain you attach to the Worker.

**Recommended:** put the Worker behind **Cloudflare Access** (Zero Trust → Access → Applications), so only you can even load the page. The API token still protects the data, but Access adds login with your Google account or a one-time code, and blocks everyone else at the edge.

## 2. Cloudflare dashboard checklist

**Email Routing (inbound)**

1. Open your domain, then **Email → Email Routing**, and click **Get started / Enable**.
2. Let Cloudflare **add the DNS records automatically**. It creates:
   - 3 × **MX** records on the apex: `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`, `route3.mx.cloudflare.net` (Cloudflare sets the priorities).
   - **TXT (SPF)** on the apex: `v=spf1 include:_spf.mx.cloudflare.net ~all`
   - Remove any **other MX records** (old mail provider). Mail would otherwise split between providers.
   - If you already have an SPF record, merge the includes into **one** SPF TXT record. Two SPF records make SPF invalid.
3. **Destination addresses:** add and verify any mailbox you set as `FORWARD_TO`. Forwarding only works to verified addresses.
4. **Routing rules:** deploy the Worker first, then:
   - **Custom address**, e.g. `hello@yourdomain.com`, action **Send to a Worker**, choose `miyeebizemail`, *or*
   - **Catch-all address**, action **Send to a Worker**, to process every address on the domain.
5. Make sure the rule and Email Routing itself both show as **Enabled**.

**Email Sending (outbound)**

6. With only Email Routing, the `send_email` binding can deliver **only to verified destination addresses**. To email arbitrary recipients (compose, replies, `/api/send`), onboard the domain to **Cloudflare Email Sending** (in the dashboard under Email) and add the **DKIM/SPF/return-path** records it lists exactly as shown.
7. Add a **DMARC** record if you don't have one: `TXT _dmarc` with value `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`. Tighten it to `quarantine`/`reject` once reports look clean.

**Storage**

8. D1 (`miyeebizemail`) and R2 (`miyeebizemail-mail`) are created by the commands above. Keep the R2 bucket **private**: don't enable public access or an r2.dev URL, because files are served only through the authenticated API.

**Things to know**

- `message.reply()` (the auto-acknowledgement) only works when the incoming message passed DMARC, it goes only to the original sender, and each message can be replied to once. Replies from the inbox use `env.EMAIL.send()` with `In-Reply-To`/`References` headers instead, so they work any time.
- Replies and new mail are sent from `FROM_ADDRESS`, even if the original came in to a different address on a catch-all.

## 3. API reference

All `/api/*` routes need `Authorization: Bearer <API_TOKEN>`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness check (no auth) |
| GET | `/api/messages?folder=inbox\|spam\|sent&q=&limit=30&cursor=` | Newest-first summaries plus `unread` / `spamUnread` counts; `q` is full-text search; pass the returned `cursor` for the next page |
| GET | `/api/messages/:id` | Full message (text, html, attachments) |
| PATCH | `/api/messages/:id` | `{ "read": true \| false }` |
| DELETE | `/api/messages/:id` | Delete message, attachments and original |
| GET | `/api/messages/:id/raw` | Download original `.eml` |
| POST | `/api/messages/:id/reply` | `{ "text", "html"?, "attachments"? }`: threaded reply to the sender |
| POST | `/api/messages/:id/spam` | `{ "spam": true \| false, "rememberSender"?: true }`: move to Spam / Inbox and add a sender rule |
| GET | `/api/attachments/:id` | Download an attachment |
| POST | `/api/send` | `{ "to", "subject", "text"?, "html"?, "cc"?, "replyTo"?, "attachments"? }` |
| GET | `/api/rules` | List sender rules |
| POST | `/api/rules` | `{ "pattern": "a@b.com" \| "@b.com", "action": "allow" \| "spam" \| "block" }` |
| DELETE | `/api/rules/:pattern` | Remove a rule (URL-encode the pattern) |

`attachments` is a list of `{ "filename", "type", "content" }` with base64 `content`, at most 10 files and 10 MB in total.

## Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `DB` | D1 binding | Messages, attachment metadata, search index |
| `MAIL_BUCKET` | R2 binding | Original `.eml` files and attachment bytes |
| `EMAIL` | send_email binding | Outbound mail |
| `FROM_ADDRESS` / `FROM_NAME` | var | Sender identity for compose and replies |
| `FORWARD_TO` | var | Verified mailbox to forward inbound mail to (`""` = off) |
| `AUTO_REPLY` | var | `"true"` to send acknowledgements |
| `RETENTION_DAYS` | var | Messages older than this are deleted daily (default 90) |
| `SPAM_THRESHOLD` | var | Score at which mail goes to Spam (default 5) |
| `SPAM_RETENTION_DAYS` | var | Spam older than this is deleted daily (default 30) |
| `API_TOKEN` | secret | Bearer token for the API and web inbox |

## Ideas for later

- Use **Workers AI** to classify or summarize inbound mail as it arrives.
- Add a "load remote images" button for trusted senders.
