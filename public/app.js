// Web inbox for the miyeebizemail Worker. Plain ES module, no build step.
// Everything here talks to the JSON API in src/api.ts with a bearer token.

const $ = (id) => document.getElementById(id);

const state = {
  token: loadToken(),
  folder: "inbox",
  query: "",
  cursor: undefined,
  messages: [],
  current: null, // full message open in the reader
  replyTo: null, // message being replied to, or null for a new message
  files: [], // File objects attached in the compose dialog
  objectUrls: [],
};

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // matches the server limit (total, before encoding)

// ---------- token storage (browser storage may be unavailable) ----------

function loadToken() {
  try {
    return localStorage.getItem("apiToken") || "";
  } catch {
    return "";
  }
}

function saveToken(token) {
  state.token = token;
  try {
    if (token) localStorage.setItem("apiToken", token);
    else localStorage.removeItem("apiToken");
  } catch {
    /* keep it in memory only */
  }
}

// ---------- API ----------

class AuthError extends Error {}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401) throw new AuthError("Unauthorized");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res;
}

const getJson = async (path, options) => (await api(path, options)).json();

// ---------- sign in / out ----------

async function signIn(token) {
  saveToken(token);
  await getJson("/api/messages?limit=1"); // throws AuthError if the token is wrong
  $("login").hidden = true;
  $("app").hidden = false;
  await loadList();
}

function signOut() {
  saveToken("");
  closeReader();
  $("app").hidden = true;
  $("login").hidden = false;
  $("token").value = "";
  $("token").focus();
}

function handleError(err) {
  if (err instanceof AuthError) {
    signOut();
    showLoginError("That token was not accepted.");
    return;
  }
  console.error(err);
  toast(err.message || "Something went wrong");
}

function showLoginError(text) {
  $("login-error").textContent = text;
  $("login-error").hidden = !text;
}

// ---------- message list ----------

async function loadList({ append = false } = {}) {
  const params = new URLSearchParams({ folder: state.folder, limit: "30" });
  if (state.query) params.set("q", state.query);
  if (append && state.cursor) params.set("cursor", state.cursor);

  const data = await getJson(`/api/messages?${params}`);
  state.messages = append ? [...state.messages, ...data.messages] : data.messages;
  state.cursor = data.cursor;
  setUnread(data.unread);
  setSpamUnread(data.spamUnread);
  renderList();
}

function setUnread(count) {
  $("unread").textContent = String(count);
  $("unread").hidden = !count;
}

function setSpamUnread(count) {
  $("spam-unread").textContent = String(count);
  $("spam-unread").hidden = !count;
}

function adjustUnread(msg, delta) {
  const badge = msg.isSpam ? "spam-unread" : "unread";
  const next = Math.max(0, Number($(badge).textContent || 0) + delta);
  (msg.isSpam ? setSpamUnread : setUnread)(next);
}

function renderList() {
  const list = $("message-list");
  list.replaceChildren(...state.messages.map(renderItem));
  $("list-empty").hidden = state.messages.length > 0;
  $("list-empty").textContent = state.query
    ? "No messages match your search."
    : state.folder === "spam"
      ? "No spam."
      : "No messages.";
  $("load-more").hidden = !state.cursor;
}

function renderItem(msg) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = "message-item" + (msg.read ? "" : " unread");
  btn.dataset.id = msg.id;
  if (state.current?.id === msg.id) btn.setAttribute("aria-current", "true");

  const row = el("div", "row");
  const who = state.folder === "sent" ? `To: ${msg.to.join(", ")}` : displayName(msg.from);
  row.append(el("span", "who", who), el("span", "when", formatDate(msg.receivedAt, true)));
  const subject = el("div", "subject", msg.subject || "(no subject)");
  if (msg.attachmentCount) subject.append(" ", el("span", "clip", `📎 ${msg.attachmentCount}`));

  btn.append(row, subject, el("div", "snippet", msg.snippet));
  btn.addEventListener("click", () => openMessage(msg.id).catch(handleError));
  li.append(btn);
  return li;
}

// ---------- reader ----------

async function openMessage(id) {
  const msg = await getJson(`/api/messages/${encodeURIComponent(id)}`);
  state.current = msg;
  renderReader(msg);
  $("app").classList.add("reading");
  renderList();

  if (msg.direction === "in" && !msg.read) {
    await setRead(msg, true);
  }
}

async function setRead(msg, read) {
  await api(`/api/messages/${encodeURIComponent(msg.id)}`, { method: "PATCH", body: JSON.stringify({ read }) });
  msg.read = read;
  const item = state.messages.find((m) => m.id === msg.id);
  if (item) item.read = read;
  adjustUnread(msg, read ? -1 : 1);
  renderList();
}

function renderReader(msg) {
  revokeObjectUrls();
  $("reader-empty").hidden = true;
  $("reader-content").hidden = false;

  $("r-subject").textContent = msg.subject || "(no subject)";
  $("r-from").textContent = msg.from;
  $("r-to").textContent = msg.to.join(", ") || msg.envelopeTo || "";
  $("r-cc").textContent = msg.cc.join(", ");
  $("r-cc").hidden = $("r-cc-label").hidden = msg.cc.length === 0;
  $("r-date").textContent = formatDate(msg.date || msg.receivedAt);
  $("r-truncated").hidden = !msg.truncated;
  $("unread-btn").hidden = msg.direction !== "in";
  $("spam-btn").hidden = msg.direction !== "in" || msg.isSpam;
  $("reply-btn").hidden = Boolean(msg.isSpam); // replying to spam confirms your address is live
  $("r-spam").hidden = !msg.isSpam;
  $("r-spam-reasons").replaceChildren(...(msg.spamReasons || []).map((r) => el("li", "", r)));
  $("raw-btn").hidden = !msg.hasRaw;

  // Inline images (cid:) are shown inside the HTML; everything else is a download chip.
  const files = msg.attachments.filter((a) => !a.contentId);
  $("r-attachments").replaceChildren(
    ...files.map((a) => {
      const li = document.createElement("li");
      const b = el("button", "", `📎 ${a.filename || "attachment"} (${formatSize(a.size)})`);
      b.addEventListener("click", () => downloadFile(`/api/attachments/${a.id}`, a.filename || "attachment").catch(handleError));
      li.append(b);
      return li;
    }),
  );

  $("r-text").textContent = msg.text || "";
  const hasHtml = Boolean(msg.html);
  $("body-toggle").hidden = !(hasHtml && msg.text);
  showBody(hasHtml ? "html" : "text");
  if (hasHtml) renderHtml(msg).catch(handleError);
}

function showBody(kind) {
  $("r-html").hidden = kind !== "html";
  $("r-text").hidden = kind !== "text";
  $("show-html").setAttribute("aria-pressed", String(kind === "html"));
  $("show-text").setAttribute("aria-pressed", String(kind === "text"));
}

async function renderHtml(msg) {
  let html = msg.html;
  // Swap cid: references for data: URLs. The iframe is sandboxed to an opaque
  // origin, so it can't use blob: URLs from this page.
  for (const a of msg.attachments.filter((x) => x.contentId)) {
    try {
      const blob = await (await api(`/api/attachments/${a.id}`)).blob();
      const dataUrl = await blobToDataUrl(new Blob([blob], { type: a.mimeType }));
      html = html.split(`cid:${a.contentId}`).join(dataUrl);
    } catch (err) {
      console.warn("Inline image failed", a.id, err);
    }
  }
  if (state.current?.id !== msg.id) return; // user moved on while images loaded

  // The page's CSP is inherited by this srcdoc frame: scripts and remote images stay blocked.
  $("r-html").srcdoc =
    '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">' +
    "<style>body{margin:16px;font:14px/1.5 system-ui,sans-serif;color:#1b1f24;background:#fff;overflow-wrap:anywhere}" +
    "img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>" +
    html +
    "</body></html>";
}

function closeReader() {
  state.current = null;
  revokeObjectUrls();
  $("reader-content").hidden = true;
  $("reader-empty").hidden = false;
  $("r-html").srcdoc = "";
  $("app").classList.remove("reading");
  document.querySelectorAll(".message-item[aria-current]").forEach((b) => b.removeAttribute("aria-current"));
}

async function deleteCurrent() {
  const msg = state.current;
  if (!msg || !confirm("Delete this message permanently?")) return;
  await api(`/api/messages/${encodeURIComponent(msg.id)}`, { method: "DELETE" });
  state.messages = state.messages.filter((m) => m.id !== msg.id);
  if (msg.direction === "in" && !msg.read) adjustUnread(msg, -1);
  closeReader();
  renderList();
  toast("Message deleted");
}

// ---------- spam ----------

async function moveSpam(spam) {
  const msg = state.current;
  if (!msg) return;
  const res = await getJson(`/api/messages/${encodeURIComponent(msg.id)}/spam`, {
    method: "POST",
    body: JSON.stringify({ spam }),
  });
  if (!msg.read) adjustUnread(msg, -1);
  state.messages = state.messages.filter((m) => m.id !== msg.id);
  closeReader();
  renderList();
  const where = spam ? "Spam" : "Inbox";
  toast(res.rule ? `Moved to ${where}. Future mail from ${res.rule} will go there too.` : `Moved to ${where}`);
  // The message was unread-counted in the other folder; refresh counts.
  loadCountsOnly().catch(handleError);
}

async function loadCountsOnly() {
  const data = await getJson("/api/messages?limit=1");
  setUnread(data.unread);
  setSpamUnread(data.spamUnread);
}

async function openFilters() {
  $("rule-error").hidden = true;
  $("filters").showModal();
  await renderRules();
}

async function renderRules() {
  const { rules } = await getJson("/api/rules");
  $("rule-empty").hidden = rules.length > 0;
  $("rule-list").replaceChildren(
    ...rules.map((r) => {
      const li = document.createElement("li");
      const remove = el("button", "ghost", "Remove");
      remove.addEventListener("click", async () => {
        try {
          await api(`/api/rules/${encodeURIComponent(r.pattern)}`, { method: "DELETE" });
          await renderRules();
        } catch (err) {
          handleError(err);
        }
      });
      const label = { allow: "Allow", spam: "Spam", block: "Block" }[r.action];
      li.append(el("span", "pattern", r.pattern), el("span", `rule-tag ${r.action}`, label), remove);
      return li;
    }),
  );
}

async function addRule() {
  $("rule-error").hidden = true;
  try {
    await getJson("/api/rules", {
      method: "POST",
      body: JSON.stringify({ pattern: $("rule-pattern").value, action: $("rule-action").value }),
    });
    $("rule-pattern").value = "";
    await renderRules();
  } catch (err) {
    if (err instanceof AuthError) return handleError(err);
    $("rule-error").textContent = err.message;
    $("rule-error").hidden = false;
  }
}

// ---------- compose / reply ----------

function openCompose(replyTo = null) {
  state.replyTo = replyTo;
  state.files = [];
  renderFiles();
  $("c-files").value = "";
  $("compose-title").textContent = replyTo ? "Reply" : "New message";
  $("compose-error").hidden = true;
  $("c-to").disabled = Boolean(replyTo);
  $("c-cc").disabled = Boolean(replyTo);
  $("c-subject").disabled = Boolean(replyTo);

  if (replyTo) {
    const to = replyTo.direction === "in" ? replyTo.replyTo || replyTo.fromEmail : replyTo.to[0];
    $("c-to").value = to || "";
    $("c-cc").value = "";
    $("c-subject").value = /^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`;
    const quoted = (replyTo.text || "").split("\n").map((l) => `> ${l}`).join("\n");
    $("c-body").value = `\n\nOn ${formatDate(replyTo.date || replyTo.receivedAt)}, ${replyTo.from} wrote:\n${quoted}`;
  } else {
    $("c-to").value = $("c-cc").value = $("c-subject").value = $("c-body").value = "";
  }

  $("compose").showModal();
  (replyTo ? $("c-body") : $("c-to")).focus();
  if (replyTo) $("c-body").setSelectionRange(0, 0);
}

function addFiles(fileList) {
  const next = [...state.files, ...fileList];
  const total = next.reduce((sum, f) => sum + f.size, 0);
  if (next.length > MAX_FILES) return toast(`You can attach up to ${MAX_FILES} files`);
  if (total > MAX_FILE_BYTES) return toast("Attachments are limited to 10 MB in total");
  state.files = next;
  renderFiles();
}

function renderFiles() {
  $("c-attachments").replaceChildren(
    ...state.files.map((f, i) => {
      const li = document.createElement("li");
      const remove = el("button", "", "✕");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${f.name}`);
      remove.addEventListener("click", () => {
        state.files.splice(i, 1);
        renderFiles();
      });
      li.append(el("span", "", `${f.name} (${formatSize(f.size)})`), remove);
      return li;
    }),
  );
}

async function encodeFiles() {
  return Promise.all(
    state.files.map(async (f) => {
      const dataUrl = await blobToDataUrl(f);
      return { filename: f.name, type: f.type || "application/octet-stream", content: dataUrl.slice(dataUrl.indexOf(",") + 1) };
    }),
  );
}

async function sendCompose() {
  const text = $("c-body").value;
  const button = $("compose-send");
  button.disabled = true;
  button.textContent = "Sending…";
  $("compose-error").hidden = true;
  try {
    const attachments = state.files.length ? await encodeFiles() : undefined;
    if (state.replyTo) {
      await api(`/api/messages/${encodeURIComponent(state.replyTo.id)}/reply`, {
        method: "POST",
        body: JSON.stringify({ text, attachments }),
      });
    } else {
      const split = (s) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      const cc = split($("c-cc").value);
      await api("/api/send", {
        method: "POST",
        body: JSON.stringify({
          to: split($("c-to").value),
          cc: cc.length ? cc : undefined,
          subject: $("c-subject").value,
          text,
          attachments,
        }),
      });
    }
    $("compose").close();
    toast("Message sent");
    if (state.folder === "sent") await loadList();
  } catch (err) {
    if (err instanceof AuthError) {
      $("compose").close();
      return handleError(err);
    }
    $("compose-error").textContent = err.message;
    $("compose-error").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Send";
  }
}

// ---------- helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function displayName(from) {
  const m = /^(.*?)\s*<[^>]+>$/.exec(from || "");
  return (m && m[1].replace(/^"|"$/g, "")) || from || "(unknown sender)";
}

function formatDate(value, short = false) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value || "";
  if (!short) return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadFile(path, filename) {
  const blob = await (await api(path)).blob();
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

function revokeObjectUrls() {
  state.objectUrls.forEach((u) => URL.revokeObjectURL(u));
  state.objectUrls = [];
}

let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3000);
}

// ---------- wiring ----------

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  showLoginError("");
  signIn($("token").value.trim()).catch((err) => {
    saveToken("");
    showLoginError(err instanceof AuthError ? "That token was not accepted." : err.message);
  });
});

$("logout-btn").addEventListener("click", signOut);
$("compose-btn").addEventListener("click", () => openCompose());
$("compose-cancel").addEventListener("click", () => $("compose").close());
$("compose-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendCompose();
});

document.querySelectorAll(".folder[data-folder]").forEach((btn) =>
  btn.addEventListener("click", () => {
    state.folder = btn.dataset.folder;
    state.cursor = undefined;
    state.query = "";
    $("search").value = "";
    document.querySelectorAll(".folder[data-folder]").forEach((b) => b.setAttribute("aria-current", String(b === btn)));
    closeReader();
    loadList().catch(handleError);
  }),
);

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = $("search").value.trim();
    state.cursor = undefined;
    loadList().catch(handleError);
  }, 300);
});
$("search-form").addEventListener("submit", (e) => e.preventDefault());

$("load-more").addEventListener("click", () => loadList({ append: true }).catch(handleError));
$("back-btn").addEventListener("click", closeReader);
$("reply-btn").addEventListener("click", () => state.current && openCompose(state.current));
$("unread-btn").addEventListener("click", () => {
  if (!state.current) return;
  setRead(state.current, false).then(closeReader).catch(handleError);
});
$("delete-btn").addEventListener("click", () => deleteCurrent().catch(handleError));
$("raw-btn").addEventListener("click", () => {
  const msg = state.current;
  if (msg) downloadFile(`/api/messages/${encodeURIComponent(msg.id)}/raw`, `${msg.id}.eml`).catch(handleError);
});
$("spam-btn").addEventListener("click", () => moveSpam(true).catch(handleError));
$("not-spam-btn").addEventListener("click", () => moveSpam(false).catch(handleError));
$("filters-btn").addEventListener("click", () => openFilters().catch(handleError));
$("filters-close").addEventListener("click", () => $("filters").close());
$("rule-form").addEventListener("submit", (e) => {
  e.preventDefault();
  addRule();
});
$("c-files").addEventListener("change", (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
});
$("show-html").addEventListener("click", () => showBody("html"));
$("show-text").addEventListener("click", () => showBody("text"));

// Start: reuse a saved token if we have one.
if (state.token) {
  signIn(state.token).catch((err) => {
    signOut();
    if (!(err instanceof AuthError)) showLoginError(err.message);
  });
} else {
  $("login").hidden = false;
}
