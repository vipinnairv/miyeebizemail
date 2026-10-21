# miyeebizemail

A custom email app for your domain, running entirely in one Cloudflare Worker:

- **Inbound:** Cloudflare Email Routing delivers mail to the Worker's `email` handler, which parses it with [`postal-mime`](https://github.com/postalsys/postal-mime), stores it in KV, optionally forwards it to your mailbox, and sends an automatic acknowledgement.
- **Outbound:** the `send_email` binding sends new messages (`env.EMAIL.send(...)`) and threaded replies (`message.reply(...)`). The runtime builds the MIME message, so no MIME library is needed.
- **API:** a small authenticated JSON API (`fetch` handler) to list/read/delete stored messages and send email.

## Architecture

```
                 ┌──────────────────────── Cloudflare ────────────────────────┐
 sender ──SMTP──▶│ MX (Email Routing) ──rule──▶ Worker.email()                │
                 │                               ├─ postal-mime parse         │
                 │                               ├─ KV put  (EMAIL_LOG)       │
                 │                               ├─ forward → FORWARD_TO      │──▶ your inbox
                 │                               └─ reply()  (auto-ack)       │──▶ sender
                 │                                                            │
 you ──HTTPS────▶│ Worker.fetch()  /api/messages  → KV list/get/delete        │
                 │                 /api/send      → env.EMAIL.send()          │──▶ recipient
                 └────────────────────────────────────────────────────────────┘
```

| File | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry: wires `email` and `fetch` handlers |
| `src/inbound.ts` | Parse → store → forward → auto-reply pipeline |
| `src/outbound.ts` | `sendEmail`, `sendAutoReply`, and the auto-reply loop guard |
| `src/storage.ts` | KV layout (newest-first keys, summary metadata, TTL) |
| `src/api.ts` | HTTP API with bearer-token auth |
| `src/env.ts` | Typed bindings/vars |
| `wrangler.jsonc` | Worker config: KV, `send_email`, vars |

**Design notes**

- KV keys are `msg:<inverted-timestamp>-<random>`, so `list()` returns newest first, and each key carries a small summary (from/subject/snippet) as metadata. Listing messages takes one KV call.
- Each side effect in the inbound pipeline has its own try/catch. If one fails (for example a KV write), forwarding and the auto-reply still run.
- Auto-replies are skipped for automated mail (`Auto-Submitted`, `List-Id`, `Precedence: bulk`, `noreply@`, `mailer-daemon@`, your own domain) to prevent reply loops.
- Messages over 10 MB are stored with headers only, to stay within Worker memory and CPU limits.

## 1. Local setup

Prerequisites: Node.js 18+ and a Cloudflare account with your domain on Cloudflare DNS.

```bash
npm install
npx wrangler login

# Create the KV namespace and paste the printed id into wrangler.jsonc ("REPLACE_WITH_KV_NAMESPACE_ID")
npx wrangler kv namespace create EMAIL_LOG

# Local secret for the API
cp .dev.vars.example .dev.vars        # then edit API_TOKEN
```

Edit `wrangler.jsonc`: set `FROM_ADDRESS`, `FROM_NAME`, `allowed_sender_addresses`, and optionally `FORWARD_TO`.

### Run and test locally

```bash
npm run dev            # wrangler dev on http://localhost:8787
```

Simulate an inbound email (wrangler provides this local endpoint):

```bash
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alice@gmail.com&to=hello@example.com' \
  --data-binary $'From: Alice <alice@gmail.com>\r\nTo: hello@example.com\r\nSubject: Hi\r\nMessage-ID: <1@gmail.com>\r\n\r\nHello!\r\n'
```

Read it back and send a message:

```bash
curl -H 'Authorization: Bearer <API_TOKEN>' http://localhost:8787/api/messages
curl -H 'Authorization: Bearer <API_TOKEN>' http://localhost:8787/api/messages/<id>
curl -X POST -H 'Authorization: Bearer <API_TOKEN>' -H 'Content-Type: application/json' \
  http://localhost:8787/api/send -d '{"to":"bob@example.org","subject":"Hello","text":"Hi Bob"}'
```

In local dev, outgoing mail and replies are not delivered. Wrangler writes them to `.wrangler/tmp/email/` and logs the path.

`npm run check` runs the TypeScript check and a dry-run bundle.

### Deploy

```bash
npx wrangler secret put API_TOKEN     # use a long random string, e.g. `openssl rand -hex 32`
npm run deploy
npx wrangler tail                     # live logs
```

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

6. With only Email Routing, the `send_email` binding can deliver **only to verified destination addresses**. That is enough for notifications to yourself. To email arbitrary recipients from `/api/send`, onboard the domain to **Cloudflare Email Sending** (in the dashboard under Email) and add the **DKIM/SPF/return-path** records it lists exactly as shown.
7. Add a **DMARC** record if you don't have one: `TXT _dmarc` with value `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`. Tighten it to `quarantine`/`reject` once reports look clean.

**Reply restrictions to know about:** `message.reply()` only works when the incoming message passed DMARC, it goes only to the original sender, and each message can be replied to once. The code logs and continues if a reply is refused.

## 3. API reference

All `/api/*` routes need `Authorization: Bearer <API_TOKEN>`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness check (no auth) |
| GET | `/api/messages?limit=20&cursor=` | Newest-first summaries; pass returned `cursor` for the next page |
| GET | `/api/messages/:id` | Full parsed message (text, html, attachment list) |
| DELETE | `/api/messages/:id` | Delete a stored message |
| POST | `/api/send` | `{ "to", "subject", "text"?, "html"?, "cc"?, "replyTo"? }` |

## Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `EMAIL_LOG` | KV binding | Stores parsed messages |
| `EMAIL` | send_email binding | Outbound mail |
| `FROM_ADDRESS` / `FROM_NAME` | var | Sender identity for `/api/send` |
| `FORWARD_TO` | var | Verified mailbox to forward inbound mail to (`""` = off) |
| `AUTO_REPLY` | var | `"true"` to send acknowledgements |
| `RETENTION_DAYS` | var | KV TTL for stored messages |
| `API_TOKEN` | secret | Bearer token for the API |

## Next steps (ideas)

- Store attachments in **R2** and keep only references in KV.
- Use **D1** instead of KV if you need search or filtering by sender or date.
- Add a small web inbox UI served from the same Worker (or Workers static assets).
- Use **Workers AI** to classify or summarize inbound mail before it is stored.
