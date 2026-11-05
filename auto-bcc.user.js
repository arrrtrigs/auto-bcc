// ==UserScript==
// @name         Auto BCC for Gmail
// @namespace    https://github.com/arrrtrigs/auto-bcc
// @version      1.3.0
// @description  Automatically adds Cc/Bcc addresses to Gmail messages based on the From account.
// @author       You
// @match        https://mail.google.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/arrrtrigs/auto-bcc/main/auto-bcc.user.js
// @downloadURL  https://raw.githubusercontent.com/arrrtrigs/auto-bcc/main/auto-bcc.user.js
// ==/UserScript==

/*
 * HOW UPDATES WORK
 * Tampermonkey checks @updateURL about once a day. When you publish a change,
 * raise @version above (1.3.0 → 1.3.1). If the number doesn't go up, nobody
 * gets the update.
 *
 * Open settings: Tampermonkey icon → "Auto BCC settings" (while Gmail is open).
 */
(() => {
  const DEFAULTS = {
    enabled: true,
    rules: [{ id: "default", addresses: [], mode: "bcc", fromAddress: "", applyTo: "all", skipDomains: [] }]
  };

  const SEL = {
    body: 'div[role="textbox"][aria-label*="Message Body"], div[contenteditable="true"][g_editable="true"]',
    sendButton: 'div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"]',
    recipientInputs: 'input[aria-label*="recipients" i], textarea[name="to"], textarea[name="cc"], textarea[name="bcc"], input[name="to"]:not([type="hidden"]), input[name="cc"]:not([type="hidden"]), input[name="bcc"]:not([type="hidden"])',
    toggles: 'span[role="link"], div[role="link"], span[data-tooltip], [aria-label^="Add Cc" i], [aria-label^="Add Bcc" i]',
    chip: '[email], [data-hovercard-id]'
  };

  const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const log = (...a) => console.log("[Auto BCC]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (e) => (e || "").trim().toLowerCase();
  const emailOf = (s) => { const m = (s || "").match(EMAIL_RE); return m ? norm(m[0]) : ""; };
  const visible = (el) => !!el && el.offsetParent !== null;

  let settings = DEFAULTS;
  const composes = new Map(); // root element -> state

  // ---------- settings ----------
  function loadSettings() {
    settings = Object.assign({}, DEFAULTS, GM_getValue("settings", DEFAULTS));
    log("Settings loaded:", settings);
    composes.forEach((st, root) => { st.lastKey = null; sync(root, st); });
  }
  function saveSettings(s) {
    GM_setValue("settings", s);
    loadSettings();
  }
  // Pick up changes saved in another Gmail tab.
  if (typeof GM_addValueChangeListener === "function") {
    GM_addValueChangeListener("settings", (_k, _o, _n, remote) => { if (remote) loadSettings(); });
  }

  // ---------- finding things inside a compose ----------
  function composeRoot(bodyEl) {
    let el = bodyEl;
    while (el && el !== document.body) {
      if (el.querySelector(SEL.sendButton) && el.querySelector(SEL.recipientInputs)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Which recipient field is this input: "to", "cc" or "bcc"?
  function kindOf(input) {
    const name = norm(input.getAttribute("name"));
    if (["to", "cc", "bcc"].includes(name)) return name;
    const label = norm(input.getAttribute("aria-label"));
    if (/^bcc\b/.test(label)) return "bcc";
    if (/^cc\b/.test(label)) return "cc";
    if (/^to\b/.test(label)) return "to";
    return "";
  }

  function findInput(root, kind) {
    return [...root.querySelectorAll(SEL.recipientInputs)].find((i) => kindOf(i) === kind && visible(i)) || null;
  }

  // The container for one recipient row (the input plus its chips), stopping before
  // we reach an ancestor that also holds another row's input.
  function rowOf(input) {
    let el = input;
    while (el.parentElement) {
      const inputs = el.parentElement.querySelectorAll(SEL.recipientInputs);
      if ([...inputs].some((i) => i !== input && kindOf(i) && kindOf(i) !== kindOf(input))) break;
      el = el.parentElement;
    }
    return el;
  }

  function chipsIn(container) {
    return [...container.querySelectorAll(SEL.chip)]
      .map((c) => ({ el: c, email: emailOf(c.getAttribute("email") || c.getAttribute("data-hovercard-id")) }))
      .filter((c) => c.email);
  }

  // Every recipient across To/Cc/Bcc.
  function allRecipients(root) {
    const set = new Set();
    for (const k of ["to", "cc", "bcc"]) {
      const inp = [...root.querySelectorAll(SEL.recipientInputs)].find((i) => kindOf(i) === k);
      if (inp) chipsIn(rowOf(inp)).forEach((c) => set.add(c.email));
    }
    return [...set];
  }

  // The selected From address. Gmail keeps it in a hidden input when you have several
  // accounts/aliases, and shows it as "Name <email>" in the From dropdown.
  function fromAddress(root) {
    const hidden = root.querySelector('input[name="from"]');
    if (hidden && emailOf(hidden.value)) return emailOf(hidden.value);

    // Look for the row whose label reads "From".
    const labels = [...root.querySelectorAll("span, div, td, label")]
      .filter((el) => el.children.length === 0 && /^from$/i.test(el.textContent.trim()));
    for (const label of labels) {
      let row = label.parentElement;
      for (let i = 0; i < 4 && row; i++, row = row.parentElement) {
        const sel = row.querySelector('[role="listbox"], [aria-haspopup], [email]');
        const text = (sel && (sel.getAttribute("email") || sel.textContent)) || row.textContent;
        const e = emailOf(text);
        if (e) return e;
      }
    }
    // Single-account Gmail has no From row: use the signed-in account.
    const acct = document.querySelector('a[aria-label*="@"][href*="accounts.google.com"], [aria-label^="Google Account"]');
    return acct ? emailOf(acct.getAttribute("aria-label")) : "";
  }

  function composeType(root) {
    const subj = root.querySelector('input[name="subjectbox"]');
    if (!subj) return "reply"; // inline reply
    if (/^\s*(re|aw|sv):/i.test(subj.value)) return "reply";
    if (/^\s*(fwd?|wg|tr):/i.test(subj.value)) return "forward";
    return "new";
  }

  // ---------- which addresses should be on this message? ----------
  function wanted(root, from, { atSend }) {
    const out = new Map(); // email -> "cc" | "bcc"
    if (!settings.enabled) return out;
    const type = composeType(root);
    const recips = allRecipients(root);

    for (const r of settings.rules || []) {
      if (!r.addresses?.length) continue;
      if (r.applyTo === "new" && type !== "new") continue;
      if (r.applyTo === "replies" && type === "new") continue;
      if (r.fromAddress) {
        const ruleFrom = emailOf(r.fromAddress);
        if (!from || ruleFrom !== from) continue;
      }
      const skip = (r.skipDomains || []).map((d) => norm(d).replace(/^@/, "")).filter(Boolean);
      if (skip.length) {
        if (!atSend) continue; // recipients not final until Send
        const others = recips.filter((e) => !r.addresses.map(emailOf).includes(e));
        if (others.length && others.every((e) => skip.some((d) => e.endsWith("@" + d)))) continue;
      }
      r.addresses.map(emailOf).filter(Boolean).forEach((a) => out.set(a, r.mode === "cc" ? "cc" : "bcc"));
    }
    return out;
  }

  // ---------- editing fields ----------
  // Gmail ignores a bare .click() on many controls; it listens for the full
  // mousedown → mouseup → click sequence.
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ev = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, opts));
    }
  }

  async function waitForInput(root, kind, ms = 1500) {
    for (let t = 0; t < ms; t += 50) {
      const input = findInput(root, kind);
      if (input) return input;
      await sleep(50);
    }
    return null;
  }

  function findToggle(root, kind) {
    const re = kind === "bcc" ? /^(add\s+)?bcc\b/i : /^(add\s+)?cc\b/i;
    return [...root.querySelectorAll(SEL.toggles)].find((t) =>
      visible(t) &&
      re.test((t.getAttribute("aria-label") || t.getAttribute("data-tooltip") || t.textContent || "").trim()));
  }

  // Replies start with the recipients collapsed into one summary line
  // ("To: someone"); the Cc/Bcc links only exist after it is expanded.
  function expandRecipients(root) {
    const to = [...root.querySelectorAll(SEL.recipientInputs)].find((i) => kindOf(i) === "to");
    if (to && visible(to)) { realClick(to); to.focus(); return true; }
    const summary = [...root.querySelectorAll('[role="button"], [tabindex], span, div')].find((el) =>
      visible(el) && el.children.length < 6 &&
      /^(to|recipients)\b/i.test((el.getAttribute("aria-label") || el.textContent || "").trim()) &&
      !el.querySelector(SEL.body));
    if (summary) { realClick(summary); return true; }
    return false;
  }

  async function openRow(root, kind) {
    let input = findInput(root, kind);
    if (input) return input;

    // 1) The "Cc" / "Bcc" link.
    let toggle = findToggle(root, kind);
    if (!toggle && expandRecipients(root)) { await sleep(250); toggle = findToggle(root, kind); }
    if (toggle) {
      realClick(toggle);
      input = await waitForInput(root, kind);
      if (input) return input;
    }

    // 2) Gmail's own shortcut: Ctrl/⌘ + Shift + C (Cc) or B (Bcc), sent to the message body.
    const body = root.querySelector(SEL.body);
    if (body) {
      const mac = /Mac/i.test(navigator.platform);
      const letter = kind === "bcc" ? "b" : "c";
      body.focus();
      body.dispatchEvent(new KeyboardEvent("keydown", {
        key: letter.toUpperCase(), code: "Key" + letter.toUpperCase(),
        keyCode: letter.toUpperCase().charCodeAt(0), which: letter.toUpperCase().charCodeAt(0),
        shiftKey: true, ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true
      }));
      input = await waitForInput(root, kind, 800);
      if (input) return input;
    }

    log(`Couldn't open the ${kind.toUpperCase()} field yet. Will retry.`);
    return null;
  }

  async function addAddress(input, email) {
    input.focus();
    input.value = email;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(60);
    for (const [key, code, keyCode] of [[",", "Comma", 188], ["Enter", "Enter", 13]]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, code, keyCode, which: keyCode, bubbles: true }));
    }
    input.blur();
    await sleep(100);
  }

  async function removeAddress(root, kind, email) {
    const input = findInput(root, kind);
    if (!input) return;
    const chip = chipsIn(rowOf(input)).find((c) => c.email === email);
    if (!chip) return;
    // Prefer the chip's own remove (×) button.
    let host = chip.el;
    for (let i = 0; i < 3 && host; i++, host = host.parentElement) {
      const x = host.querySelector('[aria-label^="Remove" i], [data-tooltip^="Remove" i]');
      if (x) { x.click(); await sleep(80); return; }
    }
    // Fallback: select the chip and press Delete.
    chip.el.focus();
    chip.el.click();
    for (const key of ["Backspace", "Delete"]) {
      chip.el.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, keyCode: key === "Delete" ? 46 : 8, bubbles: true }));
    }
    await sleep(80);
  }

  // ---------- keep a compose in sync with the rules ----------
  async function sync(root, st, opts = { atSend: false }) {
    if (st.busy) return;
    const from = fromAddress(root);
    const want = wanted(root, from, opts);
    const key = from + "|" + [...want].join(",");
    if (key === st.lastKey && !opts.atSend) return;

    if (key !== st.attemptKey) { st.attemptKey = key; st.retries = 0; }
    st.busy = true;
    try {
      if (from !== st.lastFrom) log("From account:", from || "(not detected)");
      st.lastFrom = from;
      const focusBack = document.activeElement;

      // Remove addresses we added earlier that no longer apply (e.g. From changed).
      for (const [email, kind] of st.added) {
        if (want.get(email) !== kind) { await removeAddress(root, kind, email); st.added.delete(email); log("Removed", email); }
      }
      // Add what's missing.
      let allDone = true;
      const present = new Set(allRecipients(root));
      for (const [email, kind] of want) {
        if (present.has(email)) { if (!st.added.has(email)) st.added.set(email, kind); continue; }
        const input = await openRow(root, kind);
        if (!input) { allDone = false; continue; }
        await addAddress(input, email);
        await sleep(150);
        const consumed = !(findInput(root, kind)?.value || "").includes(email);
        if (new Set(allRecipients(root)).has(email) || consumed) {
          st.added.set(email, kind);
          log(`Added ${email} to ${kind.toUpperCase()}`);
        } else {
          allDone = false;
          log(`Typed ${email} but Gmail hasn't shown it yet. Will check again.`);
        }
      }
      if (!opts.atSend && focusBack && root.contains(focusBack)) focusBack.focus();

      // Only remember this state once it actually worked; otherwise the 500 ms
      // check runs again, so a closed Cc row or a slow Gmail doesn't need you
      // to switch accounts back and forth.
      if (allDone) { st.lastKey = key; st.retries = 0; }
      else if (++st.retries >= 20) { st.lastKey = key; log("Gave up after 20 tries. Check the console lines above."); }
    } finally {
      st.busy = false;
    }
  }

  function hookSend(root, st) {
    const btn = root.querySelector(SEL.sendButton);
    if (!btn || btn.dataset.autoBccHooked) return;
    btn.dataset.autoBccHooked = "1";
    btn.addEventListener("click", async (e) => {
      const needsCheck = (settings.rules || []).some((r) => r.skipDomains?.length);
      if (!settings.enabled || !needsCheck || btn.dataset.autoBccPassed) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      await sync(root, st, { atSend: true });
      btn.dataset.autoBccPassed = "1";
      btn.click();
    }, true);
  }

  function track(bodyEl) {
    const root = composeRoot(bodyEl);
    if (!root || composes.has(root)) return;
    const st = { added: new Map(), lastKey: null, attemptKey: null, retries: 0, lastFrom: null, busy: false };
    composes.set(root, st);
    log("Compose window detected");
    // Gmail fills the From field a moment after the window opens, and you can
    // change it at any time, so check twice a second while the compose is open.
    st.timer = setInterval(() => {
      if (!document.contains(root)) { clearInterval(st.timer); composes.delete(root); return; }
      hookSend(root, st);
      sync(root, st);
    }, 500);
  }

  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; document.querySelectorAll(SEL.body).forEach(track); });
  }).observe(document.body, { childList: true, subtree: true });

  // ======================================================================
  // Settings window (opens inside Gmail)
  // Gmail blocks innerHTML (Trusted Types), so everything is built with
  // createElement, inside a shadow root so Gmail's CSS doesn't leak in.
  // ======================================================================
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    kids.flat().forEach((c) => c != null && el.append(c.nodeType ? c : document.createTextNode(c)));
    return el;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483000; background: rgba(10,20,18,.45);
      display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px;
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
    .panel { --bg:#f4f6f5; --surface:#fff; --ink:#16302b; --muted:#5f716c; --line:#d6dfdc;
      --accent:#2f7d62; --accent-ink:#fff; --danger:#b4412f;
      background: var(--bg); color: var(--ink); width: min(1120px, 100%); max-height: calc(100vh - 80px);
      display: flex; flex-direction: column; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.3); }
    @media (prefers-color-scheme: dark) { .panel { --bg:#111a18; --surface:#182421; --ink:#e3ece9;
      --muted:#93a6a1; --line:#2b3b37; --accent:#5fb898; --accent-ink:#0e1a17; --danger:#e0806f; } }
    .top { display: flex; gap: 16px; align-items: flex-start; padding: 20px 22px 12px; }
    h1 { font-size: 19px; margin: 0 0 2px; font-weight: 650; }
    .lede { margin: 0; color: var(--muted); font-size: 13px; }
    .grow { flex: 1; }
    .toolbar { display: flex; gap: 8px; align-items: center; padding: 0 22px 10px; flex-wrap: wrap; }
    input[type=text], input[type=search], select { width: 100%; padding: 5px 8px; border: 1px solid var(--line);
      border-radius: 6px; background: var(--surface); color: var(--ink); font: inherit; font-size: 13.5px; }
    input[type=search] { flex: 1; width: auto; min-width: 180px; padding: 7px 10px; }
    button { font: inherit; font-size: 13.5px; border-radius: 6px; padding: 6px 12px; cursor: pointer;
      border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
    button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
    button.icon { border: none; background: none; padding: 4px 6px; color: var(--muted); font-size: 15px; }
    button.icon:hover { color: var(--ink); } button.del:hover { color: var(--danger); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .wrap { margin: 0 22px; overflow: auto; background: var(--surface); border: 1px solid var(--line);
      border-radius: 8px; flex: 1; min-height: 120px; }
    table { width: 100%; border-collapse: collapse; min-width: 880px; }
    th { position: sticky; top: 0; background: var(--surface); text-align: left; font-size: 11.5px;
      font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
      padding: 9px 8px; border-bottom: 1px solid var(--line); z-index: 1; }
    td { padding: 5px 8px; border-bottom: 1px solid var(--line); }
    tr.invalid td { background: color-mix(in srgb, var(--danger) 10%, transparent); }
    td.num { color: var(--muted); font-size: 12px; width: 28px; text-align: right; }
    td.act { width: 64px; white-space: nowrap; text-align: right; }
    .count { color: var(--muted); font-size: 12.5px; }
    .switch { display: flex; gap: 8px; align-items: center; font-weight: 550; cursor: pointer; }
    .switch input { width: 17px; height: 17px; accent-color: var(--accent); }
    .bottom { display: flex; gap: 8px; align-items: center; padding: 12px 22px 18px; flex-wrap: wrap; }
    .status { font-weight: 550; font-size: 13px; }
    .legend { color: var(--muted); font-size: 12.5px; padding: 8px 22px 0; margin: 0; }
  `;

  const EMAIL_STRICT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const splitList = (s) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  let modalHost = null;

  function openSettings() {
    if (modalHost) return;
    modalHost = h("div", { id: "auto-bcc-settings" });
    const shadow = modalHost.attachShadow({ mode: "open" });
    shadow.append(h("style", {}, CSS));

    // Stop Gmail's keyboard shortcuts from firing while typing in the window.
    for (const t of ["keydown", "keypress", "keyup"]) {
      modalHost.addEventListener(t, (e) => {
        e.stopPropagation();
        if (t === "keydown" && e.key === "Escape") close();
        if (t === "keydown" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      });
    }

    let dirty = false;
    const tbody = h("tbody");
    const enabled = h("input", { type: "checkbox", checked: settings.enabled !== false });
    const filter = h("input", { type: "search", placeholder: "Filter by account, address or domain" });
    const count = h("span", { class: "count" });
    const status = h("span", { class: "status" });

    const setStatus = (msg, tone) => {
      status.textContent = msg;
      status.style.color = tone === "error" ? "var(--danger)" : tone === "muted" ? "var(--muted)" : "var(--accent)";
    };
    const changed = () => { dirty = true; setStatus("Unsaved changes", "muted"); refresh(); };

    const readRow = (tr) => ({
      id: tr.dataset.id,
      fromAddress: tr.querySelector(".fromAddress").value.trim(),
      addresses: splitList(tr.querySelector(".addresses").value),
      mode: tr.querySelector(".mode").value,
      applyTo: tr.querySelector(".applyTo").value,
      skipDomains: splitList(tr.querySelector(".skipDomains").value).map((d) => d.replace(/^@/, ""))
    });

    function addRow(rule = {}, { after = null, focus = false } = {}) {
      const opt = (v, t, cur) => h("option", { value: v, selected: v === cur }, t);
      const tr = h("tr", {},
        h("td", { class: "num" }),
        h("td", {}, h("input", { type: "text", class: "fromAddress", placeholder: "Any account", value: rule.fromAddress || "" })),
        h("td", {}, h("input", { type: "text", class: "addresses", placeholder: "crm@company.com, archive@company.com", value: (rule.addresses || []).join(", ") })),
        h("td", {}, h("select", { class: "mode" }, opt("bcc", "Bcc", rule.mode || "bcc"), opt("cc", "Cc", rule.mode))),
        h("td", {}, h("select", { class: "applyTo" },
          opt("all", "All messages", rule.applyTo || "all"), opt("new", "New only", rule.applyTo),
          opt("replies", "Replies & forwards", rule.applyTo))),
        h("td", {}, h("input", { type: "text", class: "skipDomains", placeholder: "none", value: (rule.skipDomains || []).join(", ") })),
        h("td", { class: "act" },
          h("button", { class: "icon", title: "Duplicate rule", onclick: () => { addRow(readRow(tr), { after: tr, focus: true }); changed(); } }, "⧉"),
          h("button", { class: "icon del", title: "Delete rule", onclick: () => { tr.remove(); changed(); } }, "✕"))
      );
      tr.dataset.id = rule.id || Math.random().toString(36).slice(2);
      if (after) after.after(tr); else tbody.append(tr);
      if (focus) tr.querySelector(".fromAddress").focus();
      refresh();
    }

    function refresh() {
      const rows = [...tbody.rows];
      const q = filter.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach((tr, i) => {
        tr.querySelector(".num").textContent = i + 1;
        const text = [...tr.querySelectorAll("input")].map((x) => x.value).join(" ").toLowerCase();
        tr.hidden = !!q && !text.includes(q);
        if (!tr.hidden) shown++;
      });
      count.textContent = q ? `${shown} of ${rows.length} rules` : `${rows.length} rule${rows.length === 1 ? "" : "s"}`;
    }

    function validate() {
      const problems = [];
      [...tbody.rows].forEach((tr, i) => {
        const r = readRow(tr);
        const bad = r.addresses.filter((a) => !EMAIL_STRICT.test(a));
        if (r.fromAddress && !EMAIL_STRICT.test(r.fromAddress)) bad.unshift(r.fromAddress);
        const empty = !r.addresses.length;
        tr.classList.toggle("invalid", empty || bad.length > 0);
        if (empty) problems.push(`row ${i + 1}: no addresses`);
        if (bad.length) problems.push(`row ${i + 1}: ${bad.join(", ")}`);
      });
      return problems;
    }

    function save() {
      const problems = validate();
      if (problems.length) return setStatus(`Fix: ${problems.join("; ")}`, "error");
      saveSettings({ enabled: enabled.checked, rules: [...tbody.rows].map(readRow) });
      dirty = false;
      setStatus("Settings saved");
    }

    function close() {
      if (dirty && !confirm("You have unsaved changes. Close without saving?")) return;
      modalHost.remove();
      modalHost = null;
    }

    function exportRules() {
      const data = JSON.stringify({ enabled: enabled.checked, rules: [...tbody.rows].map(readRow) }, null, 2);
      const a = h("a", { href: URL.createObjectURL(new Blob([data], { type: "application/json" })), download: "auto-bcc-rules.json" });
      document.body.append(a); a.click(); a.remove();
    }

    function importRules() {
      const input = h("input", { type: "file", accept: ".json,application/json" });
      input.onchange = async () => {
        try {
          const data = JSON.parse(await input.files[0].text());
          if (!Array.isArray(data.rules)) throw new Error("No rules found in file");
          tbody.replaceChildren();
          data.rules.forEach((r) => addRow(r));
          if (typeof data.enabled === "boolean") enabled.checked = data.enabled;
          changed();
          setStatus(`Imported ${data.rules.length} rules. Click Save to keep them.`, "muted");
        } catch (err) { setStatus("Import failed: " + err.message, "error"); }
      };
      input.click();
    }

    tbody.addEventListener("input", changed);
    tbody.addEventListener("change", changed);
    enabled.addEventListener("change", changed);
    filter.addEventListener("input", refresh);

    const panel = h("div", { class: "panel", role: "dialog", "aria-label": "Auto BCC settings" },
      h("div", { class: "top" },
        h("div", { class: "grow" },
          h("h1", {}, "Auto BCC"),
          h("p", { class: "lede" }, "Each row is a rule. Addresses are added to Cc or Bcc of matching messages, where you can still remove them before sending.")),
        h("label", { class: "switch" }, enabled, "On"),
        h("button", { class: "icon", title: "Close", onclick: close }, "✕")),
      h("div", { class: "toolbar" }, filter, count,
        h("button", { onclick: () => { filter.value = ""; addRow({}, { focus: true }); changed(); } }, "Add rule")),
      h("div", { class: "wrap" },
        h("table", {},
          h("thead", {}, h("tr", {},
            h("th"), h("th", { style: "width:22%" }, "When sending from"), h("th", { style: "width:28%" }, "Add these addresses"),
            h("th", { style: "width:9%" }, "As"), h("th", { style: "width:16%" }, "Use on"),
            h("th", { style: "width:17%" }, "Skip if all recipients at"), h("th"))),
          tbody)),
      h("p", { class: "legend" }, "Leave “When sending from” blank to match every account. Separate several addresses or domains with commas."),
      h("div", { class: "bottom" },
        h("button", { onclick: importRules }, "Import"),
        h("button", { onclick: exportRules }, "Export"),
        status, h("span", { class: "grow" }),
        h("button", { onclick: close }, "Close"),
        h("button", { class: "primary", onclick: save }, "Save settings")));

    const backdrop = h("div", { class: "backdrop", onclick: (e) => { if (e.target === backdrop) close(); } }, panel);
    shadow.append(backdrop);
    document.body.append(modalHost);

    const rules = (settings.rules || []).filter((r) => r.addresses?.length || r.fromAddress);
    rules.forEach((r) => addRow(r));
    if (!rules.length) addRow();
    dirty = false;
  }

  GM_registerMenuCommand("Auto BCC settings", openSettings);
  GM_registerMenuCommand("Turn Auto BCC on/off", () => {
    saveSettings({ ...settings, enabled: !settings.enabled });
    alert("Auto BCC is now " + (settings.enabled ? "ON" : "OFF"));
  });

  loadSettings();
})();
