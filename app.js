"use strict";
/* 天窗 0.3 —— 基于 Nostr 协议的客户端 */
const N = window.NostrTools;
const { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash, nip19, nip44 } = N;
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
const b64 = (u) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const isHex = (s, n) => typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const ls = { get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }, del(k) { try { localStorage.removeItem(k); } catch (e) {} } };
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.k); toast.k = setTimeout(() => (t.hidden = true), 2800); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast("已复制"); } catch (e) { toast("复制失败，请手动选中复制"); } }

const DEFAULT_RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom", "wss://relay.snort.social", "wss://offchain.pub", "wss://relay.damus.io"];
const DEFAULT_SEARCH = ["wss://search.nos.today", "wss://nostr.wine"];
const BLOSSOM = ["https://blossom.primal.net", "https://nostr.download"];
const TC_TAG = "tianchuang";
const IS_MAC = !!window.tcVault;
const scamRe = /保本|稳赚|稳定.{0,4}收益|翻倍|带单|内部票|进群|私信领取/;
const holdLab = { none: ["未持仓", "ok"], long: ["作者持有多头", ""], short: ["作者持有空头", ""], paid: ["含商业推广", "warn"] };
const ICON = {
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/></svg>',
  repost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>',
  bm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  bmOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
};
const likeIcon = (on) => `<svg viewBox="0 0 24 24" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z"/></svg>`;

/* ======================= 私钥保管 ======================= */
/* 存储里放的是 64 位 hex 私钥，或者 "enc1:" 开头、用解锁密码加密过的私钥 */
const store = {
  async get() { if (window.tcVault) return await window.tcVault.get(); return ls.get("tc-sk"); },
  async set(s) { if (window.tcVault) return await window.tcVault.set(s); ls.set("tc-sk", s); },
  async clear() { if (window.tcVault) return await window.tcVault.clear(); ls.del("tc-sk"); },
};
const PBKDF2_ITER = 600000;
async function pinKey(pin, salt, iter) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function sealSecret(hex, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await pinKey(pin, salt, PBKDF2_ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(hex)));
  return "enc1:" + JSON.stringify({ s: b64(salt), i: b64(iv), c: b64(ct), n: PBKDF2_ITER });
}
async function openSecret(blob, pin) {
  const o = JSON.parse(blob.slice(5));
  const k = await pinKey(pin, unb64(o.s), o.n);
  const hex = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.i) }, k, unb64(o.c)));
  if (!isHex(hex, 64)) throw new Error("bad");
  return hex;
}

/* ======================= 状态 ======================= */
let sk = null, pk = null, pool = null, storedBlob = null, booting = true;
let relays = JSON.parse(ls.get("tc-relays", "null") || "null") || DEFAULT_RELAYS.slice();
let searchRelays = JSON.parse(ls.get("tc-srelays", "null") || "null") || DEFAULT_SEARCH.slice();
if (searchRelays.join() === "wss://relay.nostr.band,wss://search.nos.today") searchRelays = DEFAULT_SEARCH.slice();
const events = new Map();     // id -> 所有内容事件（含回复），供查找
const posts = new Map();      // 顶层帖子
const profiles = new Map();   // pubkey -> {name, headline, about, picture, raw, at}
const likes = new Map();      // id -> Set(pubkey)
const replies = new Map();    // rootId -> Map(id -> ev)
const reposts = new Map();    // id -> Map(pubkey -> created_at)
const notifs = new Map();     // key -> {type, from, at, ref, text}
const pendingDel = new Map(); // 被删除的 id -> 删除者
let follows = new Set(), contactsEv = null, contactsLoaded = false;
let fof = new Set(), fofLoaded = false;
let bookmarks = new Set(), bmEv = null, mutes = new Set(), muteEv = null;
const convs = new Map();      // key -> {key, members, group, name, nameAt, msgs, last}
const blobCache = new Map(), loadingFiles = new Set();
const relayState = new Map();
const verified = new Set(JSON.parse(ls.get("tc-verified", "[]")));
const openReplies = new Set(), openText = new Set(), openMore = new Set();
const mentionMap = new Map();
const searchHits = new Set();
let searchQ = "", searchNote = "";
let tab = "plaza", mode = "short", media = null, quoteRef = null, curConv = null, showWire = false, pageSize = 40;
let subMain = null, subFollow = null, subEng = null;
let notifSeen = 0, readState = {}, panelMode = null;
const pk8 = () => pk.slice(0, 16);

const short = (p) => { try { const n = nip19.npubEncode(p); return n.slice(0, 10) + "…" + n.slice(-4); } catch (e) { return String(p).slice(0, 8); } };
const nameOf = (p) => { const pr = profiles.get(p); return (pr && pr.name) || short(p); };
const colorOf = (p) => ["#00BB77", "#0b0d0c", "#FA003F", "#6b726f"][parseInt(String(p).slice(0, 2), 16) % 4 || 0];
const ini = (s) => [...String(s).trim()][0] || "?";
const tag = (ev, k) => (ev.tags.find((t) => t[0] === k) || [])[1];
const hasP = (ev, p) => ev.tags.some((t) => t[0] === "p" && t[1] === p);
function ago(ts) { const d = now() - ts; if (d < 60) return "刚刚"; if (d < 3600) return Math.floor(d / 60) + "分钟"; if (d < 86400) return Math.floor(d / 3600) + "小时"; if (d < 86400 * 30) return Math.floor(d / 86400) + "天前"; return new Date(ts * 1000).toLocaleDateString("zh-CN"); }
function decodeNpub(s) {
  s = String(s).trim().replace(/^nostr:/, "");
  if (isHex(s.toLowerCase(), 64)) return s.toLowerCase();
  const d = nip19.decode(s);
  if (d.type === "npub") return d.data;
  if (d.type === "nprofile") return d.data.pubkey;
  throw new Error("不是有效的 npub");
}
function avatarHTML(p, cls = "avatar", attrs = "") {
  const pr = profiles.get(p);
  if (pr && pr.picture) return `<img class="${cls}" src="${esc(pr.picture)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-user="${p}" ${attrs}>`;
  return `<span class="${cls}" style="background:${colorOf(p)}" data-user="${p}" ${attrs}>${esc(ini(nameOf(p)))}</span>`;
}

/* ======================= 本地缓存（IndexedDB） ======================= */
const cache = {
  db: null, pending: new Map(), timer: null,
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open("tc-" + pk8(), 1);
        r.onupgradeneeded = () => r.result.createObjectStore("ev", { keyPath: "id" });
        r.onsuccess = () => { this.db = r.result; res(true); };
        r.onerror = () => res(false);
      } catch (e) { res(false); }
    });
  },
  loadAll() {
    if (!this.db) return Promise.resolve([]);
    return new Promise((res) => {
      const out = [];
      try {
        const rq = this.db.transaction("ev", "readonly").objectStore("ev").openCursor();
        rq.onsuccess = () => { const c = rq.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
        rq.onerror = () => res(out);
      } catch (e) { res(out); }
    });
  },
  put(ev) { if (!this.db) return; this.pending.set(ev.id, ev); clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 1500); },
  flush() { if (!this.db || !this.pending.size) return; try { const st = this.db.transaction("ev", "readwrite").objectStore("ev"); for (const e of this.pending.values()) st.put(e); } catch (e) {} this.pending.clear(); },
  del(id) { if (!this.db) return; try { this.db.transaction("ev", "readwrite").objectStore("ev").delete(id); } catch (e) {} },
  prune(all) {
    if (!this.db || all.length <= 6000) return;
    try { const st = this.db.transaction("ev", "readwrite").objectStore("ev"); all.slice().sort((a, b) => a.created_at - b.created_at).slice(0, all.length - 5000).forEach((e) => st.delete(e.id)); } catch (e) {}
  },
};
const CACHE_KINDS = new Set([0, 1, 5, 6, 7, 1059, 10000, 10003, 30023]);
const shouldCache = (ev) => CACHE_KINDS.has(ev.kind) || (ev.kind === 3 && ev.pubkey === pk);

/* ======================= 启动 / 锁屏 ======================= */
async function boot() {
  let saved = null;
  try { saved = await store.get(); } catch (e) {}
  if (!saved) {
    $("#obHint").textContent = IS_MAC
      ? "天窗没有注册，也没有手机号。你的账号就是一把密钥，生成在这台电脑上，加密存进 macOS 钥匙串，谁也收不走。"
      : "天窗没有注册，也没有手机号。你的账号就是一把密钥，只保存在这台设备上。创建后请立刻备份私钥：清除网站数据或换手机，都需要用它找回账号。";
    $("#obPinLabel").textContent = IS_MAC ? "解锁密码（可选，已有钥匙串保护）" : "解锁密码（强烈建议）";
    $("#onboard").hidden = false; return;
  }
  if (saved.startsWith("enc1:")) { storedBlob = saved; $("#lock").hidden = false; setTimeout(() => $("#lockIn").focus(), 50); return; }
  unlockWith(saved);
}
function unlockWith(hex) { sk = fromHex(hex); pk = getPublicKey(sk); start(); }
$("#lockForm").onsubmit = async (e) => {
  e.preventDefault();
  const pin = $("#lockIn").value; if (!pin) return;
  $("#lockGo").textContent = "解锁中…"; $("#lockGo").disabled = true; $("#lockErr").hidden = true;
  try { const hex = await openSecret(storedBlob, pin); $("#lockIn").value = ""; $("#lock").hidden = true; unlockWith(hex); }
  catch (err) { $("#lockErr").textContent = "密码不对，再试一次。"; $("#lockErr").hidden = false; }
  $("#lockGo").textContent = "解锁"; $("#lockGo").disabled = false;
};
$("#lockForgot").onclick = async () => {
  const b = $("#lockForgot");
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "确认：删除本机私钥，用备份重新导入"; return; }
  await store.clear(); location.reload();
};
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (storedBlob && sk && hiddenAt && Date.now() - hiddenAt > 15 * 60 * 1000) location.reload();   // 离开 15 分钟自动锁定
  if (tab === "dm") renderThread();
});

async function start() {
  pool = new SimplePool();
  const init = Number(ls.get("tc-init-" + pk8(), "0")) || now();
  ls.set("tc-init-" + pk8(), String(init));
  notifSeen = Number(ls.get("tc-nseen-" + pk8(), String(init)));
  try { readState = JSON.parse(ls.get("tc-read-" + pk8(), "{}")) || {}; } catch (e) { readState = {}; }
  readState.__init = init;
  $("#fWot").checked = ls.get("tc-wot", "0") === "1";
  renderMe();
  await cache.open();
  const cached = await cache.loadAll();
  cached.sort((a, b) => a.created_at - b.created_at).forEach((e) => ingest(e, true));
  cache.prune(cached);
  booting = false;
  probeRelays();
  subscribeMain();
  setInterval(refreshRelayState, 5000);
  setInterval(flushProfiles, 1200);
  setInterval(flushNeedEvents, 1500);
  render(); updateBadges();
  if ($("#fWot").checked) loadFof();
}

/* ---------- 首次启动 ---------- */
let obMode = "new";
$("#obChoice").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; obMode = b.dataset.ob; $$("#obChoice button").forEach((x) => x.classList.toggle("on", x === b)); $("#obNew").hidden = obMode !== "new"; $("#obImport").hidden = obMode !== "import"; };
function checkPin(a, b) { if (!a && !b) return ""; if (a.length < 6) throw new Error("解锁密码至少 6 位"); if (a !== b) throw new Error("两次输入的解锁密码不一样"); return a; }
$("#obGo").onclick = async () => {
  $("#obErr").hidden = true;
  try {
    const pin = checkPin($("#obPin").value, $("#obPin2").value);
    let bytes;
    if (obMode === "new") {
      if (!$("#obName").value.trim()) throw new Error("给自己起个昵称");
      bytes = generateSecretKey();
    } else {
      const v = $("#obNsec").value.trim();
      if (isHex(v.toLowerCase(), 64)) bytes = fromHex(v.toLowerCase());
      else { const d = nip19.decode(v); if (d.type !== "nsec") throw new Error("请粘贴 nsec 开头的私钥"); bytes = d.data; }
    }
    $("#obGo").textContent = "正在加密保存…"; $("#obGo").disabled = true;
    const hex = toHex(bytes);
    if (pin) { storedBlob = await sealSecret(hex, pin); await store.set(storedBlob); } else await store.set(hex);
    $("#obPin").value = $("#obPin2").value = "";
    sk = bytes; pk = getPublicKey(sk);
    $("#onboard").hidden = true;
    await start();
    if (obMode === "new") {
      const name = $("#obName").value.trim(), head = $("#obHead").value.trim();
      profiles.set(pk, { name, headline: head, about: "", picture: "", raw: {}, at: 0 }); renderMe();
      await publishProfile({ name, headline: head, about: "" });
      await publish({ kind: 10050, created_at: now(), content: "", tags: relays.map((r) => ["relay", r]) });
      openProfile(true);
    } else toast("已导入，正在从中继同步你的资料、关注和私信");
  } catch (e) { $("#obErr").textContent = e.message || "私钥格式不对"; $("#obErr").hidden = false; $("#obGo").textContent = "进入天窗"; $("#obGo").disabled = false; }
};

/* ======================= 中继 ======================= */
async function probeRelays() {
  relays.forEach((u) => relayState.set(u, { ok: null, ms: null }));
  renderNet();
  await Promise.all(relays.map(async (u) => {
    const t0 = performance.now();
    try { await pool.ensureRelay(u, { connectionTimeout: 9000 }); relayState.set(u, { ok: true, ms: Math.round(performance.now() - t0) }); }
    catch (e) { relayState.set(u, { ok: false, ms: null }); }
    renderNet();
  }));
}
function refreshRelayState() {
  if (!pool) return;
  const m = pool.listConnectionStatus();
  for (const u of relays) { const s = relayState.get(u) || {}; const live = m.get(u) ?? m.get(u + "/"); if (live === false && s.ok) relayState.set(u, { ok: false, ms: null }); if (live === true && !s.ok) relayState.set(u, { ok: true, ms: s.ms }); }
  renderNet();
}
function renderNet() {
  const up = relays.filter((u) => relayState.get(u)?.ok).length;
  $("#net").innerHTML = relays.map((u) => { const s = relayState.get(u) || {}; return `<span class="dot ${s.ok === false ? "off" : ""}" style="${s.ok == null ? "background:var(--line)" : ""}"></span><span class="url">${esc(u.replace("wss://", ""))}</span><span class="n">${s.ok ? (s.ms ?? "—") + " ms" : s.ok === false ? "不可达" : "连接中"}</span>`; }).join("");
  $("#mNet").textContent = `${up}/${relays.length} 中继`;
}

/* ======================= 订阅 ======================= */
function subscribeMain() {
  subMain?.close();
  subMain = pool.subscribeMany(relays, [
    { kinds: [1, 30023], "#t": [TC_TAG], limit: 200 },
    { kinds: [0, 3, 10000, 10003], authors: [pk] },
    { kinds: [1059], "#p": [pk], limit: 1000 },
    { kinds: [1, 6, 7], "#p": [pk], limit: 200 },
    { kinds: [3], "#p": [pk], limit: 200 },
  ], { onevent: (e) => ingest(e), oneose: () => { contactsLoaded = true; } });
  scheduleFollowSub();
}
let followSubTimer = null;
function scheduleFollowSub() {
  clearTimeout(followSubTimer);
  followSubTimer = setTimeout(() => {
    if (!pool) return;
    subFollow?.close();
    const authors = [...follows, pk];
    subFollow = pool.subscribeMany(relays, [{ kinds: [1, 6, 30023], authors, limit: 300 }, { kinds: [0], authors }, { kinds: [5], authors, limit: 200 }], { onevent: (e) => ingest(e) });
  }, 400);
}
let engTimer = null;
function subscribeEngagement() {
  clearTimeout(engTimer);
  engTimer = setTimeout(() => {
    if (!pool) return;
    subEng?.close();
    const ids = [...posts.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 300).map((e) => e.id);
    if (!ids.length) return;
    subEng = pool.subscribeMany(relays, [{ kinds: [1, 5, 6, 7], "#e": ids }], { onevent: (e) => ingest(e) });
  }, 1200);
}
const wantProfiles = new Set(), wantEvents = new Set();
function needProfile(p) { if (isHex(p, 64) && !profiles.has(p)) wantProfiles.add(p); }
function needEvent(id) { if (isHex(id, 64) && !events.has(id)) wantEvents.add(id); }
function flushProfiles() {
  if (!wantProfiles.size || !pool) return;
  const batch = [...wantProfiles].slice(0, 100);
  batch.forEach((p) => { wantProfiles.delete(p); if (!profiles.has(p)) profiles.set(p, { name: "", headline: "", about: "", picture: "", raw: {}, at: -1 }); });
  const s = pool.subscribeMany(relays, [{ kinds: [0], authors: batch }], { onevent: (e) => ingest(e), oneose: () => s.close() });
}
function flushNeedEvents() {
  if (!wantEvents.size || !pool) return;
  const batch = [...wantEvents].slice(0, 60); batch.forEach((id) => wantEvents.delete(id));
  const s = pool.subscribeMany(relays, [{ ids: batch }], { onevent: (e) => ingest(e), oneose: () => s.close() });
}

/* ======================= 收到事件 ======================= */
function ingest(ev, fromCache = false) {
  if (!fromCache && shouldCache(ev)) cache.put(ev);
  switch (ev.kind) {
    case 0: {
      const cur = profiles.get(ev.pubkey);
      if (cur && cur.at >= ev.created_at) return;
      let raw = {}; try { raw = JSON.parse(ev.content) || {}; } catch (e) {}
      const pic = typeof raw.picture === "string" && /^https:\/\/[^\s"'<>]+$/.test(raw.picture) ? raw.picture : "";
      profiles.set(ev.pubkey, { name: String(raw.display_name || raw.name || "").slice(0, 60), headline: String(raw.tc_headline || "").slice(0, 120), about: String(raw.about || "").slice(0, 600), picture: pic, raw, at: ev.created_at });
      if (ev.pubkey === pk) renderMe();
      return schedule();
    }
    case 3: {
      if (ev.pubkey === pk) {
        if (contactsEv && contactsEv.created_at >= ev.created_at) return;
        contactsEv = ev; follows = new Set(ev.tags.filter((t) => t[0] === "p" && isHex(t[1], 64)).map((t) => t[1]));
        fofLoaded = false; updateFollowCount(); scheduleFollowSub();
        if ($("#fWot").checked && !booting) loadFof();
      } else if (hasP(ev, pk)) addNotif("f:" + ev.pubkey, { type: "follow", from: ev.pubkey, at: ev.created_at });
      return schedule();
    }
    case 1: {
      if (pendingDel.get(ev.id) === ev.pubkey || events.has(ev.id)) return;
      events.set(ev.id, ev);
      const eTags = ev.tags.filter((t) => t[0] === "e");
      const root = eTags.find((t) => t[3] === "root") || eTags.find((t) => t[3] === "reply") || eTags.find((t) => !t[3]);
      const mentionsMe = ev.pubkey !== pk && hasP(ev, pk);
      needProfile(ev.pubkey);
      if (root) {
        if (!replies.has(root[1])) replies.set(root[1], new Map());
        replies.get(root[1]).set(ev.id, ev);
        if (mentionsMe) addNotif(ev.id, { type: "reply", from: ev.pubkey, at: ev.created_at, ref: root[1], text: ev.content });
      } else {
        posts.set(ev.id, ev); subscribeEngagement();
        if (mentionsMe) addNotif(ev.id, { type: ev.tags.some((t) => t[0] === "q") ? "quote" : "mention", from: ev.pubkey, at: ev.created_at, ref: ev.id, text: ev.content });
      }
      return schedule();
    }
    case 30023: {
      if (pendingDel.get(ev.id) === ev.pubkey) return;
      const key = ev.pubkey + ":" + (tag(ev, "d") || "");
      const old = [...posts.values()].find((p) => p.kind === 30023 && p.pubkey + ":" + (tag(p, "d") || "") === key);
      if (old && old.created_at >= ev.created_at) return;
      if (old) { posts.delete(old.id); events.delete(old.id); }
      posts.set(ev.id, ev); events.set(ev.id, ev); needProfile(ev.pubkey); subscribeEngagement(); return schedule();
    }
    case 6: {
      const t = [...ev.tags].reverse().find((x) => x[0] === "e"); if (!t || !isHex(t[1], 64)) return;
      if (!reposts.has(t[1])) reposts.set(t[1], new Map());
      reposts.get(t[1]).set(ev.pubkey, ev.created_at);
      if (!events.has(t[1])) {
        let inner = null; try { inner = JSON.parse(ev.content); } catch (e) {}
        if (inner && inner.id === t[1] && inner.kind === 1 && verifyEvent(inner)) ingest(inner, fromCache); else needEvent(t[1]);
      }
      needProfile(ev.pubkey);
      if (ev.pubkey !== pk && hasP(ev, pk)) addNotif(ev.id, { type: "repost", from: ev.pubkey, at: ev.created_at, ref: t[1] });
      return schedule();
    }
    case 7: {
      if (ev.content === "-") return;
      const target = [...ev.tags].reverse().find((t) => t[0] === "e"); if (!target) return;
      if (!likes.has(target[1])) likes.set(target[1], new Set());
      likes.get(target[1]).add(ev.pubkey);
      if (ev.pubkey !== pk && hasP(ev, pk)) addNotif(ev.id, { type: "like", from: ev.pubkey, at: ev.created_at, ref: target[1] });
      return schedule();
    }
    case 5: {
      for (const t of ev.tags) {
        if (t[0] !== "e" || !isHex(t[1], 64)) continue;
        const target = events.get(t[1]);
        if (target) { if (target.pubkey === ev.pubkey) removeEvent(t[1]); }
        else pendingDel.set(t[1], ev.pubkey);
      }
      return schedule();
    }
    case 10000: if (ev.pubkey === pk && (!muteEv || ev.created_at > muteEv.created_at)) { muteEv = ev; mutes = readList(ev, "p"); renderMuteList(); schedule(); } return;
    case 10003: if (ev.pubkey === pk && (!bmEv || ev.created_at > bmEv.created_at)) { bmEv = ev; bookmarks = readList(ev, "e"); bookmarks.forEach(needEvent); schedule(); } return;
    case 1059: return onGiftWrap(ev, fromCache);
  }
}
function removeEvent(id) {
  const ev = events.get(id); posts.delete(id); events.delete(id); cache.del(id);
  for (const m of replies.values()) m.delete(id);
  if (ev) pendingDel.set(id, ev.pubkey);
}

/* ---------- 私密列表（收藏、屏蔽）：条目用 NIP-44 加密给自己，中继看不到 ---------- */
function readList(ev, key) {
  const items = ev.tags.filter((t) => t[0] === key && isHex(t[1], 64)).map((t) => t[1]);
  if (ev.content) { try { JSON.parse(nip44.decrypt(ev.content, nip44.getConversationKey(sk, pk))).filter((t) => t[0] === key && isHex(t[1], 64)).forEach((t) => items.push(t[1])); } catch (e) {} }
  return new Set(items);
}
async function writeList(kind, key, set, prev) {
  const pubTags = (prev?.tags || []).filter((t) => t[0] !== key);
  const content = nip44.encrypt(JSON.stringify([...set].map((v) => [key, v])), nip44.getConversationKey(sk, pk));
  return publish({ kind, created_at: now(), tags: pubTags, content });
}

/* ======================= 通知与角标 ======================= */
function addNotif(key, n) {
  if (notifs.has(key)) return;
  notifs.set(key, n); needProfile(n.from);
  if (n.ref) needEvent(n.ref);
  if (!booting && n.at > notifSeen && n.at > now() - 300 && !mutes.has(n.from)) {
    const verb = { like: "赞了你的帖子", reply: "回复了你", mention: "提到了你", quote: "引用了你的帖子", repost: "转发了你的帖子", follow: "关注了你" }[n.type];
    nativeNotify("天窗", `${nameOf(n.from)} ${verb}`);
  }
}
const unreadNotif = () => [...notifs.values()].filter((n) => n.at > notifSeen && !mutes.has(n.from)).length;
function convUnread(c) { const seen = readState[c.key] || readState.__init || 0; let n = 0; for (const m of c.msgs.values()) if (!m.me && m.at > seen) n++; return n; }
const unreadDM = () => [...convs.values()].reduce((s, c) => s + convUnread(c), 0);
function setBadgeEl(sel, n) { const el = $(sel); if (!el) return; el.hidden = !n; el.textContent = n > 99 ? "99+" : String(n); }
function updateBadges() {
  if (!pk) return;
  const n = unreadNotif(), d = unreadDM(), total = n + d;
  setBadgeEl("#bNotif", n); setBadgeEl("#bNotif2", n); setBadgeEl("#bDM", d); setBadgeEl("#bDM2", d);
  document.title = total ? `(${total}) 天窗` : "天窗";
  if (window.tcApp) window.tcApp.setBadge(total);
  else if (navigator.setAppBadge) { (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {}); }
}
async function nativeNotify(title, body) {
  if (!document.hidden && document.hasFocus()) return;
  try {
    if (window.tcApp) { new Notification(title, { body }); return; }
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: "icons/icon-192.png", tag: "tc-" + Date.now() }); else new Notification(title, { body });
  } catch (e) {}
}
function saveRead() { const o = { ...readState }; delete o.__init; ls.set("tc-read-" + pk8(), JSON.stringify(o)); }

/* ======================= 发布 ======================= */
async function publish(tpl) {
  const ev = finalizeEvent(tpl, sk);
  const res = await Promise.allSettled(pool.publish(relays, ev));
  const ok = res.filter((r) => r.status === "fulfilled").length;
  if (ok) ingest(ev);
  return { ev, ok };
}
async function publishProfile({ name, headline, about, picture }) {
  const cur = profiles.get(pk) || {};
  const raw = { ...(cur.raw || {}), name, display_name: name, about, tc_headline: headline };
  if (picture !== undefined) raw.picture = picture; else if (cur.picture) raw.picture = cur.picture;
  const { ok } = await publish({ kind: 0, created_at: now(), tags: [], content: JSON.stringify(raw) });
  return ok;
}
async function ensureContacts() {
  if (contactsLoaded && contactsEv) return;
  const evs = await pool.querySync(relays, { kinds: [3], authors: [pk], limit: 1 }, { maxWait: 4000 });
  evs.forEach((e) => ingest(e)); contactsLoaded = true;
}
async function setFollow(target, on) {
  await ensureContacts();
  const tags = (contactsEv?.tags || []).filter((t) => !(t[0] === "p" && t[1] === target));
  if (on) tags.push(["p", target]);
  const { ok } = await publish({ kind: 3, created_at: now(), tags, content: contactsEv?.content || "" });
  toast(on ? `已关注 ${nameOf(target)} · 写入 ${ok} 个中继` : `已取消关注`);
}
function updateFollowCount() { $("#followCount").textContent = follows.size ? `你关注了 ${follows.size} 个人。` : "你还没有关注任何人。"; }

/* ---------- 关系网（反垃圾）：我关注的人 + 他们关注的人 ---------- */
async function loadFof(fromToggle) {
  if (!follows.size) { if (fromToggle) toast("先关注几个人，关系网过滤才有内容"); return; }
  if (fofLoaded || !pool) return;
  fofLoaded = true;
  const evs = await pool.querySync(relays, { kinds: [3], authors: [...follows].slice(0, 300) }, { maxWait: 6000 });
  const set = new Set();
  for (const e of evs) for (const t of e.tags) if (t[0] === "p" && isHex(t[1], 64) && set.size < 8000) set.add(t[1]);
  fof = set; render();
}
const inCircle = (p) => p === pk || follows.has(p) || fof.has(p);

/* ======================= 媒体：压缩、上传、加密 ======================= */
async function compressImage(file, max = 2048) {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? new File([blob], (file.name || "image").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch (e) { return file; }
}
async function uploadBlossom(file, type) {
  const hash = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
  const auth = finalizeEvent({ kind: 24242, created_at: now(), content: "Upload media", tags: [["t", "upload"], ["x", hash], ["expiration", String(now() + 600)]] }, sk);
  const header = "Nostr " + btoa(JSON.stringify(auth));
  let lastErr = "";
  const servers = type === "application/octet-stream" ? BLOSSOM.slice().reverse() : BLOSSOM;   // 加密附件优先放接受任意文件的服务器
  for (const server of servers) {
    try {
      const r = await fetch(server + "/upload", { method: "PUT", headers: { Authorization: header, "Content-Type": type || file.type || "application/octet-stream" }, body: file });
      if (!r.ok) { lastErr = server.replace("https://", "") + " 返回 " + r.status; continue; }
      const j = await r.json(); if (j.url) return { url: j.url, hash };
    } catch (e) { lastErr = server.replace("https://", "") + " 连不上"; }
  }
  throw new Error(lastErr || "上传失败");
}
async function encryptFile(blob) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, await blob.arrayBuffer()));
  return { blob: new Blob([ct], { type: "application/octet-stream" }), key: toHex(keyBytes), nonce: toHex(nonce) };
}
async function decryptFile(f) {
  const r = await fetch(f.url); if (!r.ok) throw new Error("下载失败");
  const k = await crypto.subtle.importKey("raw", fromHex(f.key), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(f.nonce) }, k, await r.arrayBuffer());
  return URL.createObjectURL(new Blob([pt], { type: f.mime }));
}

/* ======================= 渲染 ======================= */
let renderPending = false, renderBlocked = false;
function schedule() {
  if (renderPending || booting) return; renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (tab === "dm") { renderConvs(); renderThread(); } else if (tab !== "me") render();
    if (!$("#panel").hidden) renderPanel();
    updateBadges();
  });
}
const typingIn = (sel) => { const a = document.activeElement; return a && a.closest && a.closest(sel) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA"); };
document.addEventListener("focusout", (e) => { if (renderBlocked && e.target.closest?.("#feed,#panel")) { renderBlocked = false; setTimeout(() => { render(); renderPanel(); }, 0); } });

const urlRe = /https?:\/\/[^\s<>"']+/g;
function mediaKind(u) { const p = u.split("?")[0].toLowerCase(); if (/\.(mp4|mov|webm|m4v)$/.test(p)) return "video"; if (/\.(mp3|m4a|ogg|wav|aac|opus|flac)$/.test(p)) return "audio"; if (/\.(png|jpe?g|gif|webp|avif)$/.test(p)) return "image"; return null; }
const hasMedia = (ev) => (ev.content.match(urlRe) || []).some(mediaKind);
function mediaHTML(ev) {
  return (ev.content.match(urlRe) || []).filter(mediaKind).slice(0, 4).map((u) => {
    const k = mediaKind(u), s = esc(u);
    return `<div class="media">${k === "video" ? `<video controls playsinline preload="metadata" src="${s}"></video>` : k === "audio" ? `<audio controls preload="metadata" src="${s}"></audio>` : `<img loading="lazy" src="${s}" alt="">`}</div>`;
  }).join("");
}
const refRe = /nostr:(npub1[02-9ac-hj-np-z]+|nprofile1[02-9ac-hj-np-z]+|note1[02-9ac-hj-np-z]+|nevent1[02-9ac-hj-np-z]+|naddr1[02-9ac-hj-np-z]+)/g;
function renderContent(text, depth = 0) {
  const quotes = [];
  const html = esc(text)
    .replace(urlRe, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>`)
    .replace(refRe, (m, code) => {
      try {
        const d = nip19.decode(code);
        if (d.type === "npub" || d.type === "nprofile") { const p = d.type === "npub" ? d.data : d.data.pubkey; needProfile(p); return `<a href="#" class="mention" data-user="${p}">@${esc(nameOf(p))}</a>`; }
        if (d.type === "note" || d.type === "nevent") { const id = d.type === "note" ? d.data : d.data.id; if (depth === 0) { quotes.push(id); return ""; } return "〔引用〕"; }
        if (d.type === "naddr") { const ev = [...posts.values()].find((p) => p.kind === d.data.kind && p.pubkey === d.data.pubkey && (tag(p, "d") || "") === d.data.identifier); if (ev && depth === 0) { quotes.push(ev.id); return ""; } return "〔长文〕"; }
      } catch (e) {}
      return m;
    })
    .replace(/(^|[\s>])#([^\s#<，。,.!?！？]{1,30})/g, (m, pre, t) => `${pre}<a href="#" class="tag" data-hashtag="${esc(t)}">#${t}</a>`);
  return { html: html.trim(), quotes };
}
function quoteHTML(id) {
  const ev = events.get(id);
  if (!ev) { needEvent(id); return `<div class="quote"><span class="qhead">正在加载引用的内容…</span></div>`; }
  const t = tag(ev, "title");
  const body = (t ? t + "：" : "") + ev.content.replace(urlRe, (u) => (mediaKind(u) ? "〔媒体〕" : u)).replace(refRe, "").trim();
  return `<div class="quote" data-post="${ev.id}"><span class="qhead"><b>${esc(nameOf(ev.pubkey))}</b> · ${ago(ev.created_at)}</span><div>${renderContent(body.slice(0, 280) + (body.length > 280 ? "…" : ""), 1).html}</div></div>`;
}
function postHTML(ev, opts = {}) {
  const pr = profiles.get(ev.pubkey) || {}, name = nameOf(ev.pubkey), mine = ev.pubkey === pk;
  const scam = scamRe.test(ev.content), folded = scam && $("#fScam").checked && !openText.has(ev.id);
  const disc = tag(ev, "disclosure"), title = ev.kind === 30023 ? tag(ev, "title") : "";
  const lk = likes.get(ev.id), liked = lk?.has(pk), rp = replies.get(ev.id), rps = reposts.get(ev.id), reposted = rps?.has(pk), bm = bookmarks.has(ev.id);
  const tagsList = ev.tags.filter((t) => t[0] === "t" && t[1] !== TC_TAG).map((t) => t[1]).slice(0, 6);
  let head = "";
  if (opts.repostBy) head = `<div class="repost-head">${ICON.repost}<span>${esc(nameOf(opts.repostBy))} 转发了</span></div>`;
  let body = title ? `<div class="ptitle">${esc(title)}</div>` : "";
  if (folded) body += `<div class="aiout"><span class="h">已折叠</span>这条内容含"承诺收益 / 引流"类话术。内容仍在，你可以选择展开。<br><button class="more" data-unfold="${ev.id}">仍然展开</button></div>`;
  else {
    const long = ev.kind === 30023 && !openText.has(ev.id);
    const textOnly = ev.content.replace(urlRe, (u) => (mediaKind(u) ? "" : u)).trim();
    const rc = renderContent(textOnly);
    ev.tags.filter((t) => t[0] === "q" && isHex(t[1], 64)).forEach((t) => { if (!rc.quotes.includes(t[1])) rc.quotes.push(t[1]); });
    body += `<div class="text ${long ? "clamp" : ""}">${rc.html}</div>`;
    if (ev.kind === 30023) body += `<button class="more" data-expand="${ev.id}">${long ? "展开全文" : "收起"}</button>`;
    body += mediaHTML(ev) + rc.quotes.slice(0, 2).map(quoteHTML).join("");
    if (tagsList.length && ev.kind === 30023) body += `<div class="tags">${tagsList.map((t) => `<a href="#" class="tag" data-hashtag="${esc(t)}">#${esc(t)}</a>`).join("")}</div>`;
  }
  const labs = [];
  if (disc && holdLab[disc]) labs.push(`<span class="lab ${holdLab[disc][1]}">披露：${holdLab[disc][0]}</span>`);
  if (scam) labs.push(`<span class="lab warn">规则标注：疑似承诺收益</span>`);
  if (tag(ev, "client") === "天窗") labs.push(`<span class="lab">来自天窗</span>`);
  let rpHTML = "";
  if (openReplies.has(ev.id)) {
    const list = rp ? [...rp.values()].filter((r) => !mutes.has(r.pubkey)).sort((a, b) => a.created_at - b.created_at) : [];
    rpHTML = `<div class="replies">${list.map((r) => `<div class="reply"><b data-user="${r.pubkey}">${esc(nameOf(r.pubkey))}</b> <span class="time">· ${ago(r.created_at)}</span><div class="text">${renderContent(r.content, 1).html}</div></div>`).join("") || `<div class="reply" style="color:var(--muted)">还没有回复。</div>`}
      <form class="reply-form" data-reply="${ev.id}"><input id="rp-${ev.id}" placeholder="写回复…" autocomplete="off"><button>回复</button></form></div>`;
  }
  let moreHTML = "";
  if (openMore.has(ev.id)) {
    moreHTML = `<div class="more-row">
      <button data-link="${ev.id}">复制链接</button>
      ${mine ? `<button class="danger" data-del="${ev.id}">删除这条</button>` : `<button data-dmto="${ev.pubkey}">私信作者</button><button class="danger" data-mute="${ev.pubkey}">屏蔽这个人</button>`}</div>`;
  }
  return `<article class="post">
   ${avatarHTML(ev.pubkey)}
   <div style="min-width:0">
    ${head}
    <div class="who" style="display:flex"><b data-user="${ev.pubkey}">${esc(name)}</b><span class="time">· ${ago(ev.created_at)}</span>
      ${mine ? "" : `<button class="follow-btn ${follows.has(ev.pubkey) ? "on" : ""}" data-follow="${ev.pubkey}">${follows.has(ev.pubkey) ? "已关注" : "关注"}</button>`}</div>
    <div class="headline">${esc(pr.headline || short(ev.pubkey))}</div>
    ${body}
    ${labs.length ? `<div class="labels">${labs.join("")}</div>` : ""}
    ${folded ? "" : `<div class="aibar">
      <button class="aichip" data-ai="sum" data-id="${ev.id}">一句话摘要</button>
      <button class="aichip" data-ai="counter" data-id="${ev.id}">反方观点</button>
      <button class="aichip" data-ai="terms" data-id="${ev.id}">解释术语</button>
      <button class="aichip" data-ai="en" data-id="${ev.id}">译成英文</button></div><div id="ai${ev.id}"></div>`}
    ${rpHTML}
    <div class="actions">
     <button class="act" data-replies="${ev.id}" title="回复">${ICON.reply}${rp ? rp.size : 0}</button>
     ${ev.kind === 1 ? `<button class="act ${reposted ? "on" : ""}" data-repost="${ev.id}" title="转发">${ICON.repost}${rps ? rps.size : 0}</button>` : ""}
     <button class="act" data-quote="${ev.id}" title="引用">${ICON.quote}</button>
     <button class="act like ${liked ? "on" : ""}" data-like="${ev.id}" title="赞">${likeIcon(liked)}${lk ? lk.size : 0}</button>
     <button class="act bm ${bm ? "on" : ""}" data-bm="${ev.id}" title="${bm ? "取消收藏" : "收藏"}">${bm ? ICON.bmOn : ICON.bm}</button>
     <button class="act" data-moreopen="${ev.id}" title="更多">${ICON.more}</button>
    </div>
    ${moreHTML}
   </div></article>`;
}
function cardHTML(ev) {
  const bg = ["#00BB77", "#0b0d0c", "#FA003F", "#6b726f"][parseInt(ev.id.slice(0, 2), 16) % 4];
  const head = tag(ev, "title") || ev.content.replace(urlRe, "").replace(refRe, "").trim().split("\n")[0] || "（媒体）";
  const img = (ev.content.match(urlRe) || []).find((u) => mediaKind(u) === "image");
  const lk = likes.get(ev.id);
  const cover = img ? `<img class="cover-img" loading="lazy" src="${esc(img)}" alt="">` : `<div class="cover" style="background:${bg};min-height:${[150, 210, 180, 240][parseInt(ev.id.slice(2, 4), 16) % 4]}px">${esc(head.length > 34 ? head.slice(0, 34) + "…" : head)}</div>`;
  return `<div class="card" data-post="${ev.id}">${cover}
    <div class="meta">${img ? `<div class="t">${esc(head.slice(0, 40))}</div>` : ""}<div class="row"><span>${avatarHTML(ev.pubkey, "mini")}${esc(nameOf(ev.pubkey))}</span><span>♥ ${lk ? lk.size : 0}</span></div></div></div>`;
}

/* ---------- 各个列表 ---------- */
const sortTime = (e) => Number(tag(e, "published_at")) || e.created_at;
function followRepostBy(id) { const m = reposts.get(id); if (!m) return null; let best = null, at = 0; for (const [p, t] of m) if (follows.has(p) && t > at) { best = p; at = t; } return best ? { p: best, at } : null; }
function hotScore(e) { const age = Math.max(0, now() - e.created_at) / 3600; const l = likes.get(e.id)?.size || 0, r = replies.get(e.id)?.size || 0, rp = reposts.get(e.id)?.size || 0; return (1 + l + 2 * r + 3 * rp) / Math.pow(age + 2, 1.4); }
const isTC = (e) => e.tags.some((t) => t[0] === "t" && t[1] === TC_TAG);
function matchQ(e, q) { q = q.toLowerCase(); return (e.content + " " + (tag(e, "title") || "") + " " + nameOf(e.pubkey)).toLowerCase().includes(q); }
function visible() {
  let list;
  if (tab === "search") list = [...searchHits].map((id) => events.get(id)).filter(Boolean);
  else if (tab === "bookmarks") { list = [...bookmarks].map((id) => events.get(id)).filter(Boolean); bookmarks.forEach(needEvent); }
  else {
    list = [...posts.values()];
    if (tab === "plaza") { list = list.filter(isTC); if ($("#fWot").checked) list = list.filter((e) => inCircle(e.pubkey)); }
    if (tab === "follow") list = list.filter((e) => follows.has(e.pubkey) || e.pubkey === pk || followRepostBy(e.id));
    if (tab === "hot") list = list.filter((e) => (isTC(e) || follows.has(e.pubkey)) && e.created_at > now() - 7 * 86400);
    if (tab === "discover") list = list.filter((e) => isTC(e) || follows.has(e.pubkey));
    if (tab === "long") list = list.filter((e) => e.kind === 30023);
    if (tab === "media") list = list.filter(hasMedia);
  }
  list = list.filter((e) => !mutes.has(e.pubkey) && pendingDel.get(e.id) !== e.pubkey);
  if ($("#fPromo").checked) list = list.filter((e) => tag(e, "disclosure") !== "paid");
  const q = $("#q").value.trim();
  if (q && tab !== "search") list = list.filter((e) => matchQ(e, q));
  if (tab === "hot") return list.sort((a, b) => hotScore(b) - hotScore(a));
  if (tab === "follow") { const k = (e) => Math.max(sortTime(e), followRepostBy(e.id)?.at || 0); return list.sort((a, b) => k(b) - k(a)); }
  return list.sort((a, b) => sortTime(b) - sortTime(a));
}
function emptyHTML() {
  const npub = pk ? nip19.npubEncode(pk) : "";
  if (tab === "follow") return `<div class="empty"><h3>关注的人还没发帖</h3><p>在右侧粘贴朋友的 npub 关注对方，或者在「天窗广场」里点帖子上的「关注」。</p></div>`;
  if (tab === "bookmarks") return `<div class="empty"><h3>还没有收藏</h3><p>点帖子下面的书签按钮收藏。收藏列表加密保存在中继上，只有你自己能看到，换设备也在。</p></div>`;
  if (tab === "search") return `<div class="empty"><h3>没有找到</h3><p>${esc(searchNote || "换个关键词试试。")}</p></div>`;
  if (tab === "plaza" && $("#fWot").checked) return `<div class="empty"><h3>关系网里还没有人发帖</h3><p>你打开了「广场只看我的关系网」。多关注几个人，或者在右侧关掉这个过滤器看全部。</p></div>`;
  return `<div class="empty"><h3>这里还很安静</h3><p>天窗广场只显示用天窗发出的帖子。发第一条，或者把你的账号发给朋友，请对方装好天窗后关注你。</p>
    <div class="copy-row" style="width:100%"><div class="mono">${esc(npub)}</div><button class="ghost" data-copy="${esc(npub)}">复制我的 npub</button></div></div>`;
}
function render() {
  if (!pk || tab === "dm" || tab === "me") return;
  if (typingIn("#feed")) { renderBlocked = true; return; }
  const f = $("#feed");
  if (tab === "notif") { f.innerHTML = notifHTML(); renderTrend(); return; }
  const list = visible();
  let html = "";
  if (tab === "search") html += `<div class="search-note">搜索「${esc(searchQ)}」 · ${esc(searchNote)}</div>`;
  if (!list.length) html += emptyHTML();
  else if (tab === "discover") html += `<div class="grid">${list.slice(0, pageSize).map(cardHTML).join("")}</div>`;
  else html += list.slice(0, pageSize).map((e) => postHTML(e, tab === "follow" && !follows.has(e.pubkey) && e.pubkey !== pk ? { repostBy: followRepostBy(e.id)?.p } : {})).join("");
  if (list.length && !["search", "bookmarks"].includes(tab)) html += `<button class="loadmore" id="loadMore">${list.length > pageSize ? "加载更多" : "加载更早的内容"}</button>`;
  f.innerHTML = html;
  renderTrend();
}
async function loadMore() {
  const list = visible();
  if (list.length > pageSize) { pageSize += 40; render(); return; }
  const btn = $("#loadMore"); if (btn) { btn.textContent = "正在加载…"; btn.disabled = true; }
  const oldest = list.length ? Math.min(...list.map((e) => e.created_at)) : now();
  const filter = tab === "follow" ? { kinds: [1, 6, 30023], authors: [...follows, pk], until: oldest - 1, limit: 100 }
    : tab === "long" ? { kinds: [30023], "#t": [TC_TAG], until: oldest - 1, limit: 60 }
    : { kinds: [1, 30023], "#t": [TC_TAG], until: oldest - 1, limit: 100 };
  const evs = await pool.querySync(relays, filter, { maxWait: 6000 });
  evs.forEach((e) => ingest(e));
  pageSize += 40; render();
  if (!evs.length) toast("没有更早的内容了");
}
function notifHTML() {
  const list = [...notifs.values()].filter((n) => !mutes.has(n.from)).sort((a, b) => b.at - a.at).slice(0, 200);
  const head = `<div class="feed-head"><h2>通知</h2><span class="foot">回复、提到、转发、点赞和新关注</span></div>`;
  if (!list.length) return head + `<div class="empty"><p>还没有通知。有人回复、提到、转发、点赞或关注你，都会出现在这里。</p></div>`;
  const verb = { like: "赞了你的帖子", reply: "回复了你", mention: "提到了你", quote: "引用了你的帖子", repost: "转发了你的帖子", follow: "关注了你" };
  return head + list.map((n) => {
    const ref = n.ref ? events.get(n.ref) : null;
    const snip = n.type === "reply" || n.type === "mention" || n.type === "quote" ? n.text : ref ? (tag(ref, "title") || ref.content) : "";
    const target = n.type === "follow" ? `data-user="${n.from}"` : `data-post="${n.type === "reply" ? n.ref : n.ref || ""}"`;
    return `<div class="notif ${n.at > notifSeen ? "unread" : ""}" ${target}>${avatarHTML(n.from)}<div style="min-width:0"><div class="line"><b>${esc(nameOf(n.from))}</b> ${verb[n.type]} <span class="time">· ${ago(n.at)}</span></div>${snip ? `<div class="snip">${esc(String(snip).replace(refRe, "").replace(urlRe, "〔链接〕").slice(0, 120))}</div>` : ""}</div></div>`;
  }).join("");
}
function renderTrend() {
  const c = new Map();
  for (const e of posts.values()) if (e.created_at > now() - 14 * 86400) for (const t of e.tags) if (t[0] === "t" && t[1] !== TC_TAG) c.set(t[1], (c.get(t[1]) || 0) + 1);
  const top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("#trend").innerHTML = top.length ? top.map(([t, n]) => `<button data-hashtag="${esc(t)}"><b>#${esc(t)}</b>${n} 篇</button>`).join("") : `<div>帖子里带 #话题 后会出现在这里。</div>`;
}
function renderMe() {
  if (!pk) return;
  const n = nameOf(pk);
  $("#meName").textContent = n; $("#meKey").textContent = short(pk);
  $("#meName2").textContent = n; $("#meKey2").textContent = short(pk);
  $("#meAv").innerHTML = avatarHTML(pk, "avatar", 'style="width:38px;height:38px;font-size:14px"');
  $("#compAv").innerHTML = avatarHTML(pk); $("#meAv2").innerHTML = avatarHTML(pk);
}

/* ---------- 个人主页 / 帖子详情 ---------- */
async function openUser(p) {
  if (!isHex(p, 64)) return;
  panelMode = { type: "user", p }; needProfile(p); $("#panel").hidden = false; renderPanel();
  const evs = await pool.querySync(relays, { kinds: [1, 30023], authors: [p], limit: 40 }, { maxWait: 5000 });
  evs.forEach((e) => ingest(e)); renderPanel();
}
function openPost(id) {
  if (!isHex(id, 64)) return;
  panelMode = { type: "post", id }; openReplies.add(id); needEvent(id); $("#panel").hidden = false; renderPanel();
  const s = pool.subscribeMany(relays, [{ kinds: [1, 6, 7], "#e": [id] }], { onevent: (e) => ingest(e), oneose: () => setTimeout(() => s.close(), 8000) });
}
function renderPanel() {
  if (!panelMode || $("#panel").hidden) return;
  if (typingIn("#panel")) { renderBlocked = true; return; }
  const box = $("#panelBody");
  if (panelMode.type === "post") {
    const ev = events.get(panelMode.id);
    box.innerHTML = ev ? postHTML(ev) : `<div class="empty"><p>正在从中继加载这条内容…</p></div>`; return;
  }
  const p = panelMode.p, pr = profiles.get(p) || {}, me = p === pk;
  const list = [...events.values()].filter((e) => e.pubkey === p && posts.has(e.id)).sort((a, b) => sortTime(b) - sortTime(a)).slice(0, 40);
  const npub = nip19.npubEncode(p);
  box.innerHTML = `<div class="u-head">${avatarHTML(p)}<h2>${esc(nameOf(p))}</h2>
    ${pr.headline ? `<div class="headline">${esc(pr.headline)}</div>` : ""}${pr.about ? `<div class="about">${esc(pr.about)}</div>` : ""}
    <div class="copy-row"><div class="mono">${esc(npub)}</div><button class="ghost" data-copy="${esc(npub)}">复制</button></div>
    <div class="u-actions">${me ? `<button class="ghost" id="uEdit">编辑资料</button>` : `
      <button class="solid" data-follow="${p}">${follows.has(p) ? "取消关注" : "关注"}</button>
      <button class="ghost" data-dmto="${p}">加密私信</button>
      <button class="ghost" data-mute="${p}">${mutes.has(p) ? "取消屏蔽" : "屏蔽"}</button>`}</div></div>` +
    (mutes.has(p) ? `<div class="empty"><p>你屏蔽了这个人，他的内容不会出现在你的信息流里。</p></div>` : list.length ? list.map((e) => postHTML(e)).join("") : `<div class="empty"><p>还没有加载到这个人的帖子。</p></div>`);
  $("#uEdit") && ($("#uEdit").onclick = () => { $("#panel").hidden = true; openProfile(false); });
}
$("#panelClose").onclick = () => { $("#panel").hidden = true; panelMode = null; };

/* ======================= 标签页 ======================= */
function setTab(t) {
  if (t === "compose") { t = "plaza"; setTimeout(() => { $("#body").focus(); $("#composer").scrollIntoView({ behavior: "smooth" }); }, 50); }
  tab = t; pageSize = 40;
  $$(".tabs button,.tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $$(".nav a[data-go]").forEach((a) => a.classList.toggle("on", a.dataset.go === t));
  document.body.dataset.tab = t;
  const isDM = t === "dm", isNotif = t === "notif";
  $("#composer").hidden = !["plaza", "follow"].includes(t);
  $(".tabs").hidden = isDM || isNotif; $("#feed").hidden = isDM; $("#dm").hidden = !isDM; $(".mhead").hidden = isDM;
  window.scrollTo(0, 0);
  if (isDM) { renderConvs(); renderThread(); return; }
  if (t === "me") return;
  if (t === "plaza" && $("#fWot").checked) loadFof();
  render();
  if (isNotif) setTimeout(() => { if (tab !== "notif") return; notifSeen = now(); ls.set("tc-nseen-" + pk8(), String(notifSeen)); updateBadges(); }, 1500);
}
$$(".tabs button,.tabbar button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$$(".nav a[data-go]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); setTab(a.dataset.go); }));
["fPromo", "fScam"].forEach((id) => ($("#" + id).onchange = render));
$("#fWot").onchange = () => { ls.set("tc-wot", $("#fWot").checked ? "1" : "0"); if ($("#fWot").checked) loadFof(true); render(); };
$("#q").oninput = () => { if (tab !== "search") render(); };
$("#focusCompose").onclick = () => setTab("compose");
$("#mBookmarks").onclick = () => setTab("bookmarks");

/* ---------- 全网搜索（NIP-50） ---------- */
async function globalSearch(q) {
  q = q.trim(); if (!q || !pool) return;
  searchQ = q; searchHits.clear();
  for (const e of events.values()) if (posts.has(e.id) && matchQ(e, q)) searchHits.add(e.id);
  $("#tabSearch").hidden = false; $("#tabSearch").textContent = "搜索：" + (q.length > 8 ? q.slice(0, 8) + "…" : q);
  searchNote = `本地 ${searchHits.size} 条，正在搜索全网…`; setTab("search");
  const sp = new SimplePool(); let got = 0;
  try {
    const evs = await sp.querySync(searchRelays, { search: q, kinds: [1, 30023], limit: 60 }, { maxWait: 7000 });
    for (const e of evs) { ingest(e); if (events.has(e.id)) { searchHits.add(e.id); got++; } }
  } catch (e) {}
  try { sp.destroy(); } catch (e) {}
  searchNote = got ? `全网返回 ${got} 条，共 ${searchHits.size} 条` : `全网搜索没有返回结果，或搜索中继连不上。下面是本地的 ${searchHits.size} 条。`;
  if (tab === "search") render();
}
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); globalSearch($("#q").value); } });
$("#q2").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); globalSearch($("#q2").value); $("#q2").blur(); } });

/* ======================= 发帖 ======================= */
function syncSend() { $("#send").disabled = !($("#body").value.trim() || media || quoteRef); }
$("#body").oninput = () => { syncSend(); ls.set("tc-draft", $("#body").value); mentionCheck(); };
$("#body").value = ls.get("tc-draft", ""); syncSend();
$$("#modes button").forEach((b) => (b.onclick = () => { mode = b.dataset.mode; $$("#modes button").forEach((x) => x.classList.toggle("on", x === b)); $("#title").hidden = mode !== "article"; $("#body").placeholder = mode === "article" ? "正文。支持长篇论证，读者可一键 AI 摘要。" : "打开天窗说亮话。观点不需要被审批。输入 @ 可以提到别人。"; }));
$("#pickMedia").onclick = () => $("#fMedia").click();
$("#fMedia").onchange = async (e) => {
  let f = e.target.files[0]; e.target.value = ""; if (!f || !sk) return;
  if (f.size > 100 * 1024 * 1024) return toast("文件超过 100MB");
  $("#upState").hidden = false; $("#upState").textContent = "正在处理…"; media = null; syncSend();
  f = await compressImage(f);
  const local = URL.createObjectURL(f), k = f.type.split("/")[0];
  $("#mediaPrev").innerHTML = k === "video" ? `<video controls playsinline src="${local}"></video>` : k === "audio" ? `<audio controls src="${local}"></audio>` : `<img src="${local}" alt="">`;
  $("#upState").textContent = "正在上传到媒体服务器…（公开帖子里的媒体不加密，任何人都能看到）";
  try { const { url } = await uploadBlossom(f); media = { url }; $("#upState").textContent = "已上传 · " + url.replace(/^https:\/\//, "").slice(0, 48); }
  catch (err) { $("#upState").textContent = "上传失败：" + err.message; $("#mediaPrev").innerHTML = ""; }
  syncSend();
};
function setQuote(ev) {
  quoteRef = ev;
  if (!ev) { $("#quoteBox").hidden = true; $("#quoteBox").innerHTML = ""; syncSend(); return; }
  $("#quoteBox").innerHTML = quoteHTML(ev.id) + `<button class="x" type="button" data-unquote="1" title="取消引用">×</button>`;
  $("#quoteBox").hidden = false; syncSend();
}
/* @提及自动补全 */
function mentionCheck() {
  const el = $("#body"), box = $("#mentionBox");
  const m = el.value.slice(0, el.selectionStart).match(/@([^\s@#]{0,20})$/);
  if (!m) { box.hidden = true; return; }
  const q = m[1].toLowerCase();
  const cands = [...profiles.entries()].filter(([p, pr]) => pr.name && p !== pk && !mutes.has(p) && pr.name.toLowerCase().includes(q))
    .sort((a, b) => Number(follows.has(b[0])) - Number(follows.has(a[0]))).slice(0, 6);
  if (!cands.length) { box.hidden = true; return; }
  box.innerHTML = cands.map(([p, pr]) => `<button type="button" data-mention="${p}">${avatarHTML(p, "mini")}${esc(pr.name)}<span class="key">${short(p)}</span></button>`).join("");
  box.hidden = false;
}
function insertMention(p) {
  const el = $("#body"), pos = el.selectionStart, before = el.value.slice(0, pos), after = el.value.slice(pos);
  const name = nameOf(p).replace(/\s+/g, "");
  el.value = before.replace(/@([^\s@#]{0,20})$/, "@" + name + " ") + after;
  mentionMap.set(name, p); $("#mentionBox").hidden = true; el.focus(); syncSend();
}
$("#send").onclick = async () => {
  let text = $("#body").value.trim(); const title = $("#title").value.trim();
  if (mode === "article" && !title) return toast("长文需要标题");
  const hashtags = [...new Set((text.match(/#([^\s#，。,.!?！？]+)/g) || []).map((t) => t.slice(1)))].slice(0, 10);
  const ptags = [];
  for (const [name, p] of mentionMap) if (text.includes("@" + name)) { text = text.split("@" + name).join("nostr:" + nip19.npubEncode(p)); ptags.push(["p", p]); }
  for (const m of text.matchAll(/nostr:(npub1[02-9ac-hj-np-z]+)/g)) { try { const p = nip19.decode(m[1]).data; if (!ptags.some((t) => t[1] === p)) ptags.push(["p", p]); } catch (e) {} }
  const tags = [["t", TC_TAG], ["client", "天窗"], ["disclosure", $("#holding").value], ...hashtags.map((h) => ["t", h]), ...ptags];
  let content = [text, media?.url].filter(Boolean).join("\n\n");
  if (quoteRef) {
    const q = quoteRef;
    content += "\n\nnostr:" + (q.kind === 30023 ? nip19.naddrEncode({ kind: 30023, pubkey: q.pubkey, identifier: tag(q, "d") || "", relays: relays.slice(0, 2) }) : nip19.neventEncode({ id: q.id, relays: relays.slice(0, 2), author: q.pubkey }));
    tags.push(["q", q.id, relays[0] || "", q.pubkey]);
    if (!ptags.some((t) => t[1] === q.pubkey) && q.pubkey !== pk) tags.push(["p", q.pubkey]);
  }
  $("#send").disabled = true;
  let res;
  if (mode === "article") res = await publish({ kind: 30023, created_at: now(), content, tags: [["d", toHex(crypto.getRandomValues(new Uint8Array(8)))], ["title", title], ["published_at", String(now())], ...tags] });
  else res = await publish({ kind: 1, created_at: now(), content: content.trim(), tags });
  if (!res.ok) { toast("没有中继接收这条帖子，检查一下网络"); syncSend(); return; }
  $("#body").value = ""; $("#title").value = ""; $("#mediaPrev").innerHTML = ""; $("#upState").hidden = true; media = null; $("#composeAI").hidden = true; ls.del("tc-draft"); mentionMap.clear(); setQuote(null); syncSend();
  toast(`已签名并写入 ${res.ok}/${relays.length} 个中继`);
};

/* ======================= 点击操作（统一处理） ======================= */
document.addEventListener("click", async (e) => {
  if (e.target.closest("a[href^='http']")) return;
  const t = e.target.closest("button") || e.target.closest("a[data-user],a[data-hashtag],[data-user],[data-post]"); if (!t) return;
  const d = t.dataset;
  if (t.tagName === "A" && (d.user || d.hashtag)) e.preventDefault();
  if (d.like) {
    const ev = events.get(d.like); if (!ev || likes.get(ev.id)?.has(pk)) return;
    await publish({ kind: 7, created_at: now(), content: "+", tags: [["e", ev.id], ["p", ev.pubkey], ["k", String(ev.kind)]] });
  } else if (d.repost) {
    const ev = events.get(d.repost); if (!ev) return;
    if (reposts.get(ev.id)?.has(pk)) return toast("你已经转发过了");
    const { ok } = await publish({ kind: 6, created_at: now(), content: JSON.stringify(ev), tags: [["e", ev.id, relays[0] || ""], ["p", ev.pubkey]] });
    toast(ok ? "已转发" : "转发失败");
  } else if (d.quote) {
    const ev = events.get(d.quote); if (!ev) return;
    $("#panel").hidden = true; setTab("plaza"); setQuote(ev); setTimeout(() => $("#body").focus(), 60);
  } else if (d.bm) {
    const id = d.bm, on = !bookmarks.has(id);
    on ? bookmarks.add(id) : bookmarks.delete(id); schedule();
    const { ok } = await writeList(10003, "e", bookmarks, bmEv);
    toast(ok ? (on ? "已收藏（加密保存，只有你能看到）" : "已取消收藏") : "保存失败，检查一下网络");
  } else if (d.moreopen) { openMore.has(d.moreopen) ? openMore.delete(d.moreopen) : openMore.add(d.moreopen); render(); renderPanel(); }
  else if (d.del) {
    if (t.dataset.confirm !== "1") { t.dataset.confirm = "1"; t.textContent = "确认删除？再点一次"; return; }
    const ev = events.get(d.del); if (!ev) return;
    const tags = [["e", ev.id], ["k", String(ev.kind)]]; if (ev.kind === 30023) tags.push(["a", `30023:${ev.pubkey}:${tag(ev, "d") || ""}`]);
    const { ok } = await publish({ kind: 5, created_at: now(), content: "作者删除", tags });
    removeEvent(ev.id); schedule();
    toast(ok ? "已删除。已请求所有中继删除，但无法保证每个中继都照做。" : "删除请求发送失败");
  } else if (d.mute) {
    const p = d.mute, on = !mutes.has(p);
    on ? mutes.add(p) : mutes.delete(p); renderMuteList(); schedule();
    const { ok } = await writeList(10000, "p", mutes, muteEv);
    toast(ok ? (on ? `已屏蔽 ${nameOf(p)}，屏蔽名单加密保存` : `已取消屏蔽 ${nameOf(p)}`) : "保存失败，检查一下网络");
  } else if (d.replies) { openReplies.has(d.replies) ? openReplies.delete(d.replies) : openReplies.add(d.replies); render(); renderPanel(); setTimeout(() => $("#rp-" + d.replies)?.focus(), 30); }
  else if (d.follow) { const on = !follows.has(d.follow); t.disabled = true; await setFollow(d.follow, on); }
  else if (d.dmto) { $("#panel").hidden = true; openConv(d.dmto, [d.dmto]); setTab("dm"); }
  else if (d.link) { const ev = events.get(d.link); if (ev) copy(ev.kind === 30023 ? nip19.naddrEncode({ kind: 30023, pubkey: ev.pubkey, identifier: tag(ev, "d") || "", relays: relays.slice(0, 2) }) : nip19.neventEncode({ id: ev.id, relays: relays.slice(0, 2), author: ev.pubkey })); }
  else if (d.expand) { openText.has(d.expand) ? openText.delete(d.expand) : openText.add(d.expand); render(); renderPanel(); }
  else if (d.unfold) { openText.add(d.unfold); render(); renderPanel(); }
  else if (d.copy) copy(d.copy);
  else if (d.hashtag) { $("#panel").hidden = true; $("#q").value = "#" + d.hashtag; globalSearch("#" + d.hashtag); }
  else if (d.mention) insertMention(d.mention);
  else if (d.unquote) setQuote(null);
  else if (d.ai && d.id) postAI(d.ai, d.id);
  else if (t.classList.contains("ai")) composeAI(d.ai);
  else if (d.unmute) { mutes.delete(d.unmute); renderMuteList(); schedule(); await writeList(10000, "p", mutes, muteEv); toast("已取消屏蔽"); }
  else if (d.decrypt) { const [key, id] = d.decrypt.split("|"); const m = convs.get(key)?.msgs.get(id); if (m) loadFile(m, true); }
  else if (d.user && !t.closest(".mention-box,#convs,#meCard,#thAv,#meAv2,#compAv,#pfAv")) openUser(d.user);
  else if (d.post && t.tagName !== "BUTTON") openPost(d.post);
  else if (t.id === "loadMore") loadMore();
});
document.addEventListener("submit", async (e) => {
  const f = e.target; if (!f.dataset.reply) return; e.preventDefault();
  const root = events.get(f.dataset.reply), input = f.querySelector("input"), text = input.value.trim(); if (!text || !root) return;
  input.value = ""; input.blur();
  const tags = [["e", root.id, relays[0] || "", "root"], ["p", root.pubkey], ["client", "天窗"]];
  if (root.kind === 30023) tags.push(["a", `30023:${root.pubkey}:${tag(root, "d") || ""}`]);
  const { ok } = await publish({ kind: 1, created_at: now(), content: text, tags });
  toast(ok ? "回复已发布" : "回复发布失败");
});
$("#followForm").onsubmit = async (e) => {
  e.preventDefault();
  try { const p = decodeNpub($("#followIn").value); if (p === pk) return toast("这是你自己"); $("#followIn").value = ""; needProfile(p); await setFollow(p, true); }
  catch (err) { toast("没认出这个 npub"); }
};
function renderMuteList() {
  const box = $("#muteList"); if (!box) return;
  box.innerHTML = mutes.size ? [...mutes].map((p) => `<div><span>${esc(nameOf(p))} <span class="key">${short(p)}</span></span><button data-unmute="${p}">取消屏蔽</button></div>`).join("") : `<p class="hint">没有屏蔽任何人。在帖子的「更多」里可以屏蔽。名单加密保存在中继上，只有你能看到。</p>`;
}

/* ======================= 加密私信与群聊（NIP-17） ======================= */
function unwrapGift(wrap) {
  const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey)));
  if (seal.kind !== 13 || !verifyEvent(seal)) throw new Error("bad seal");
  const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey)));
  if (rumor.pubkey !== seal.pubkey) throw new Error("sender mismatch");     // 防冒充：内层作者必须等于封印签名者
  const h = getEventHash(rumor);
  if (rumor.id && rumor.id !== h) throw new Error("bad rumor id");
  rumor.id = h;
  return rumor;
}
const randPast = () => now() - Math.floor(Math.random() * 172800);
function giftWrap(rumor, recipient, expSec) {
  const seal = finalizeEvent({ kind: 13, created_at: randPast(), tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(sk, recipient)) }, sk);
  const rk = generateSecretKey(), tags = [["p", recipient]];
  if (expSec) tags.push(["expiration", String(now() + expSec)]);
  return finalizeEvent({ kind: 1059, created_at: randPast(), tags, content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(rk, recipient)) }, rk);
}
const convKeyOf = (members) => (members.length <= 1 ? members[0] || pk : "g:" + [...members, pk].sort().join(","));
const seenWraps = new Set();
function onGiftWrap(wrap, fromCache) {
  if (seenWraps.has(wrap.id)) return; seenWraps.add(wrap.id);
  const exp = Number(tag(wrap, "expiration")) || 0;
  if (exp && exp < now()) { cache.del(wrap.id); return; }
  let r; try { r = unwrapGift(wrap); } catch (e) { return; }
  if (r.kind !== 14 && r.kind !== 15) return;
  const parts = new Set([r.pubkey, ...r.tags.filter((t) => t[0] === "p" && isHex(t[1], 64)).map((t) => t[1])]);
  parts.delete(pk);
  const members = [...parts].sort();
  if (!members.length || members.length > 20) return;
  const key = convKeyOf(members);
  const msg = { id: r.id, me: r.pubkey === pk, from: r.pubkey, at: r.created_at, wire: wrap.content, exp, status: "" };
  if (r.kind === 14) msg.text = String(r.content).slice(0, 20000);
  else {
    msg.file = { url: String(r.content), mime: String(tag(r, "file-type") || "application/octet-stream"), key: tag(r, "decryption-key"), nonce: tag(r, "decryption-nonce"), alg: tag(r, "encryption-algorithm"), name: String(tag(r, "name") || "附件").slice(0, 80), size: Number(tag(r, "size")) || 0 };
    msg.text = msg.file.mime.startsWith("image/") ? "〔图片〕" : msg.file.mime.startsWith("video/") ? "〔视频〕" : "〔文件〕";
  }
  if (!fromCache && !booting && mutes.has(r.pubkey)) return;
  addMsg(key, members, msg, tag(r, "subject"));
  if (!msg.me && !fromCache && !booting && r.created_at > now() - 300 && !(tab === "dm" && curConv === key && !document.hidden)) {
    toast(`${nameOf(r.pubkey)} 发来一条加密私信`);
    nativeNotify("天窗", `${nameOf(r.pubkey)} 发来一条加密私信`);    // 系统通知里不显示私信内容
  }
}
function ensureConv(key, members) {
  if (!convs.has(key)) convs.set(key, { key, members, group: key.startsWith("g:"), name: "", nameAt: 0, msgs: new Map(), last: 0 });
  return convs.get(key);
}
function addMsg(key, members, m, subject) {
  const c = ensureConv(key, members);
  if (subject && m.at >= c.nameAt) { c.name = String(subject).slice(0, 40); c.nameAt = m.at; }
  const old = c.msgs.get(m.id);
  if (old) { if (!old.wire && m.wire) old.wire = m.wire; } else c.msgs.set(m.id, m);
  c.last = Math.max(c.last, m.at); members.forEach(needProfile); schedule();
}
const convTitle = (c) => (c.group ? c.name || c.members.map(nameOf).slice(0, 3).join("、") + (c.members.length > 3 ? " 等" : "") : nameOf(c.members[0]));
const convAvatar = (c) => (c.group ? `<span class="avatar" style="background:#0b0d0c">${esc(ini(convTitle(c)))}</span>` : avatarHTML(c.members[0]));
const dmRelayCache = new Map();
async function dmRelaysOf(p) {
  if (dmRelayCache.has(p)) return dmRelayCache.get(p);
  let out = relays;
  try { const ev = await pool.get(relays, { kinds: [10050], authors: [p] }, { maxWait: 3000 }); const r = (ev?.tags || []).filter((t) => t[0] === "relay" && /^wss:\/\/[^\s]+$/.test(t[1])).map((t) => t[1]); if (r.length) out = r.slice(0, 5); } catch (e) {}
  dmRelayCache.set(p, out); return out;
}
async function sendRumor(c, kind, content, extraTags = [], local = {}) {
  const exp = Number($("#timer").value) || 0;
  const tags = [...c.members.map((p) => ["p", p]), ...extraTags];
  if (c.group && c.name) tags.push(["subject", c.name]);
  const rumor = { kind, created_at: now(), tags, content, pubkey: pk };
  rumor.id = getEventHash(rumor);
  const msg = { id: rumor.id, me: true, from: pk, at: rumor.created_at, exp: exp ? now() + exp : 0, status: "发送中", ...local };
  addMsg(c.key, c.members, msg);
  let ok = 0;
  await Promise.all(c.members.filter((p) => p !== pk).map(async (p) => {
    const w = giftWrap(rumor, p, exp);
    if (!msg.wire) msg.wire = w.content;
    const target = [...new Set([...(await dmRelaysOf(p)), ...relays])];
    const res = await Promise.allSettled(pool.publish(target, w));
    if (res.some((x) => x.status === "fulfilled")) ok++;
  }));
  const self = giftWrap(rumor, pk, exp); seenWraps.add(self.id); cache.put(self);
  Promise.allSettled(pool.publish(relays, self));
  const n = c.members.filter((p) => p !== pk).length;
  msg.status = !n ? "已保存" : ok === n ? "已送达" : ok ? `已送达 ${ok}/${n} 人` : "发送失败";
  schedule();
}
function openConv(key, members) {
  const c = ensureConv(key, members);
  curConv = key; members.forEach(needProfile); $("#dm").classList.add("open"); $("#safety").hidden = true; $("#safeBtn").classList.remove("on");
  return c;
}
$("#newChat").onsubmit = (e) => {
  e.preventDefault();
  try { const p = decodeNpub($("#newChatIn").value); if (p === pk) return toast("不能给自己发私信"); $("#newChatIn").value = ""; openConv(p, [p]); renderConvs(); renderThread(); $("#dmIn").focus(); }
  catch (err) { toast("没认出这个 npub"); }
};
$("#ngToggle").onclick = () => { $("#newGroup").hidden = !$("#newGroup").hidden; if (!$("#newGroup").hidden) $("#ngName").focus(); };
$("#newGroup").onsubmit = (e) => {
  e.preventDefault();
  const raw = $("#ngMembers").value.split(/[\s,，]+/).filter(Boolean), members = new Set();
  for (const s of raw) { try { const p = decodeNpub(s); if (p !== pk) members.add(p); } catch (err) { return toast("有一个 npub 没认出来：" + s.slice(0, 16)); } }
  if (members.size < 2) return toast("群聊至少需要 2 位其他成员；只有一位就用「新对话」");
  if (members.size > 20) return toast("群聊最多 20 人");
  const list = [...members].sort(), key = convKeyOf(list);
  const c = openConv(key, list); c.name = $("#ngName").value.trim().slice(0, 40); c.nameAt = now();
  $("#ngMembers").value = ""; $("#ngName").value = ""; $("#newGroup").hidden = true;
  renderConvs(); renderThread(); $("#dmIn").focus();
  toast("群聊已创建。发出第一条消息后，成员才会看到这个群。");
};
$("#convs").onclick = (e) => { const b = e.target.closest("[data-conv]"); if (!b) return; const c = convs.get(b.dataset.conv); if (!c) return; openConv(c.key, c.members); renderConvs(); renderThread(); };
$("#dmBack").onclick = () => $("#dm").classList.remove("open");
$("#wire").onclick = () => { showWire = !showWire; $("#wire").classList.toggle("on", showWire); $("#wire").textContent = showWire ? "隐藏密文" : "显示密文"; renderThread(); };
$("#safeBtn").onclick = () => { $("#safety").hidden = !$("#safety").hidden; $("#safeBtn").classList.toggle("on", !$("#safety").hidden); };
$("#verifyBtn").onclick = () => { const c = convs.get(curConv); if (!c || c.group) return; const p = c.members[0]; verified.has(p) ? verified.delete(p) : verified.add(p); ls.set("tc-verified", JSON.stringify([...verified])); renderThread(); };
$("#dmForm").onsubmit = async (e) => {
  e.preventDefault(); const text = $("#dmIn").value.trim(); const c = convs.get(curConv); if (!text || !c) return;
  $("#dmIn").value = ""; await sendRumor(c, 14, text, [], { text });
};
$("#dmAttach").onclick = () => { if (!convs.get(curConv)) return toast("先选择一个对话"); $("#dmFile").click(); };
$("#dmFile").onchange = async (e) => {
  let f = e.target.files[0]; e.target.value = ""; const c = convs.get(curConv); if (!f || !c) return;
  if (f.size > 50 * 1024 * 1024) return toast("加密附件最大 50MB");
  toast("正在加密并上传…");
  try {
    f = await compressImage(f);
    const enc = await encryptFile(f);
    const { url, hash } = await uploadBlossom(enc.blob, "application/octet-stream");
    const mime = f.type || "application/octet-stream", name = (f.name || "附件").slice(0, 80);
    const local = URL.createObjectURL(f);
    const tags = [["file-type", mime], ["encryption-algorithm", "aes-gcm"], ["decryption-key", enc.key], ["decryption-nonce", enc.nonce], ["x", hash], ["size", String(enc.blob.size)], ["name", name]];
    const file = { url, mime, key: enc.key, nonce: enc.nonce, alg: "aes-gcm", name, size: enc.blob.size };
    const rumorText = mime.startsWith("image/") ? "〔图片〕" : mime.startsWith("video/") ? "〔视频〕" : "〔文件〕";
    await sendRumor(c, 15, url, tags, { file, text: rumorText, _local: local });
    const m = [...c.msgs.values()].find((x) => x._local === local); if (m) blobCache.set(m.id, local);
    schedule();
  } catch (err) { toast("附件发送失败：" + (err.message || "网络问题")); }
};
async function loadFile(m, manual) {
  const f = m.file; if (!f || loadingFiles.has(m.id) || blobCache.has(m.id)) return;
  if (f.alg !== "aes-gcm" || !isHex(f.key, 64) || !isHex(f.nonce, 24) || !/^https:\/\//.test(f.url)) { blobCache.set(m.id, null); return schedule(); }
  if (f.size > 25 * 1024 * 1024 && !manual) return;
  loadingFiles.add(m.id);
  try { blobCache.set(m.id, await decryptFile(f)); } catch (e) { blobCache.set(m.id, null); }
  loadingFiles.delete(m.id); schedule();
}
function fileHTML(c, m) {
  const f = m.file, u = blobCache.get(m.id);
  if (u === undefined) {
    if (f.size > 25 * 1024 * 1024) return `<div class="file"><button class="filebtn" data-decrypt="${esc(c.key)}|${m.id}">解密并下载 ${esc(f.name)}（${(f.size / 1048576).toFixed(1)} MB）</button></div>`;
    loadFile(m); return `<div class="file">正在下载并解密附件…</div>`;
  }
  if (u === null) return `<div class="file">附件无法解密，或已在服务器上过期。</div>`;
  if (f.mime.startsWith("image/")) return `<div class="file"><img src="${u}" alt=""></div>`;
  if (f.mime.startsWith("video/")) return `<div class="file"><video controls playsinline src="${u}"></video></div>`;
  if (f.mime.startsWith("audio/")) return `<div class="file"><audio controls src="${u}"></audio></div>`;
  return `<div class="file"><a href="${u}" download="${esc(f.name)}">下载 ${esc(f.name)}</a></div>`;
}
setInterval(() => { if (tab === "dm") renderThread(); }, 30000);

async function safetyNumber(a, b) {
  const [x, y] = [a, b].sort();
  const h = new Uint8Array(await crypto.subtle.digest("SHA-512", fromHex(x + y)));
  const out = []; for (let i = 0; i < 12; i++) { let n = 0; for (let j = 0; j < 5; j++) n = (n * 256 + h[i * 5 + j]) % 100000; out.push(String(n).padStart(5, "0")); }
  return out;
}
function renderConvs() {
  const list = [...convs.values()].filter((c) => c.group || !mutes.has(c.members[0])).sort((a, b) => b.last - a.last);
  $("#convs").innerHTML = list.map((c) => {
    const last = [...c.msgs.values()].sort((a, b) => b.at - a.at)[0], un = convUnread(c);
    const who = last ? (last.me ? "你：" : c.group ? nameOf(last.from) + "：" : "") : "";
    return `<button class="conv ${c.key === curConv ? "on" : ""}" data-conv="${esc(c.key)}">${convAvatar(c)}
      <div><b>${esc(convTitle(c))}${c.group ? ` <span class="key">· ${c.members.length + 1} 人</span>` : ""}</b><small>${last ? esc(who + last.text) : "尚无消息"}</small></div>${un ? `<i class="badge-n unread">${un}</i>` : ""}</button>`;
  }).join("");
}
async function renderThread() {
  const c = convs.get(curConv);
  if (!c) return;
  $("#thAv").innerHTML = convAvatar(c); $("#thName").textContent = convTitle(c);
  $("#safeBtn").hidden = c.group;
  if (c.group) { $("#thSub").className = "badge-u"; $("#thSub").textContent = `${c.members.length + 1} 人加密群聊`; $("#safety").hidden = true; }
  else {
    const p = c.members[0], v = verified.has(p);
    $("#thSub").className = v ? "badge-v" : "badge-u"; $("#thSub").textContent = v ? "✓ 安全码已验证" : short(p) + " · 未验证";
    $("#verifyBtn").textContent = v ? "已验证 ✓" : "标记为已验证"; $("#verifyBtn").classList.toggle("done", v);
  }
  const t = now();
  const msgs = [...c.msgs.values()].filter((m) => !m.exp || m.exp > t).sort((a, b) => a.at - b.at).slice(-300);
  const box = $("#msgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = `<div class="sys">${c.group ? "群消息逐个加密发给每位成员。" : ""}消息经 NIP-17 加密：中继只能看到一个随机临时身份发来的乱码，看不到内容，也看不到是谁发的。</div>` +
    msgs.map((m) => `<div class="bub ${m.me ? "mine" : "them"}">${c.group && !m.me ? `<div class="from">${esc(nameOf(m.from))}</div>` : ""}${m.file ? fileHTML(c, m) : esc(m.text)}${showWire && m.wire ? `<div class="ct">${esc(m.wire.slice(0, 220))}…</div>` : ""}<div class="m">${m.exp ? "⏱ " : ""}${ICON.lock}${new Date(m.at * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}${m.me && m.status ? ` · <span class="status">${esc(m.status)}</span>` : ""}</div></div>`).join("");
  if (atBottom) box.scrollTop = box.scrollHeight;
  if (tab === "dm" && !document.hidden) {
    const latest = msgs.length ? msgs[msgs.length - 1].at : 0;
    if (latest > (readState[c.key] || 0)) { readState[c.key] = latest; saveRead(); updateBadges(); renderConvs(); }
  }
  if (!c.group) { const digits = await safetyNumber(pk, c.members[0]); if (curConv === c.key) $("#digits").innerHTML = digits.map((d) => `<span>${d}</span>`).join(""); }
}

/* ======================= 个人档案 ======================= */
let pendingPicture;
function openProfile(first) {
  const pr = profiles.get(pk) || {};
  pendingPicture = undefined;
  $("#pfNpub").textContent = nip19.npubEncode(pk);
  $("#pfAv").innerHTML = avatarHTML(pk); $("#pfPicState").textContent = "";
  $("#pfName").value = pr.name || ""; $("#pfHead").value = pr.headline || ""; $("#pfAbout").value = pr.about || "";
  $("#pfNsec").textContent = "••••••••••••••••••••••••••••••••"; $("#showNsec").textContent = "显示";
  $("#pfTitle").textContent = first ? "身份已创建 · 请先备份私钥" : "个人档案";
  $("#profile").hidden = false;
}
$("#openProfile").onclick = (e) => { e.preventDefault(); if (pk) openProfile(false); };
$("#meCard").onclick = (e) => { e.stopPropagation(); if (pk) openProfile(false); };
$("#mProfile").onclick = () => pk && openProfile(false);
$("#mSettings").onclick = () => $("#openSettings").click();
$("#copyNpub").onclick = () => copy(nip19.npubEncode(pk));
$("#showNsec").onclick = () => { if ($("#showNsec").textContent === "显示") { $("#pfNsec").textContent = nip19.nsecEncode(sk); $("#showNsec").textContent = "复制"; } else copy(nip19.nsecEncode(sk)); };
$("#pfPicBtn").onclick = () => $("#pfPic").click();
$("#pfPic").onchange = async (e) => {
  let f = e.target.files[0]; e.target.value = ""; if (!f) return;
  $("#pfPicState").textContent = "正在上传…";
  try { f = await compressImage(f, 512); const { url } = await uploadBlossom(f); pendingPicture = url; $("#pfAv").innerHTML = `<img class="avatar" src="${esc(url)}" alt="">`; $("#pfPicState").textContent = "已上传，点「保存并发布」生效"; }
  catch (err) { $("#pfPicState").textContent = "上传失败：" + err.message; }
};
$("#pfSave").onclick = async () => {
  const n = $("#pfName").value.trim(); if (!n) return toast("昵称不能为空");
  const ok = await publishProfile({ name: n, headline: $("#pfHead").value.trim(), about: $("#pfAbout").value.trim(), picture: pendingPicture });
  toast(`资料已发布到 ${ok} 个中继`);
};
$("#closeProfile").onclick = () => { $("#profile").hidden = true; $("#pfNsec").textContent = "••••"; };

/* ======================= 设置 ======================= */
const isMacApp = new URLSearchParams(location.search).get("app") === "mac";
if (isMacApp) document.body.classList.add("mac-app");
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; $$("#themeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.th === (t || ""))); }
applyTheme(ls.get("tc-theme", ""));
function renderPinState() {
  $("#pinState").textContent = storedBlob
    ? "已开启：私钥用你的密码加密保存，每次打开和离开 15 分钟后都要输入密码。"
    : IS_MAC ? "未开启。私钥已由 macOS 钥匙串加密保护；再加一层密码可以防止别人用你没锁屏的电脑打开天窗。" : "未开启。私钥目前以明文保存在这台设备的浏览器里，强烈建议设置。";
  $("#pinRemove").hidden = !storedBlob; $("#pinSave").textContent = storedBlob ? "修改密码" : "设置密码";
}
$("#openSettings").onclick = (e) => {
  e.preventDefault();
  $("#apiKey").value = getKey(); $("#relayList").value = relays.join("\n"); $("#srelayList").value = searchRelays.join("\n");
  $("#logout").textContent = "退出账号（从本机删除私钥）"; $("#pinRemove").textContent = "移除密码"; delete $("#pinRemove").dataset.confirm;
  renderPinState(); renderMuteList();
  const canNotify = IS_MAC || ("Notification" in window);
  $("#notifBtn").hidden = IS_MAC || !canNotify;
  $("#notifHint").textContent = IS_MAC ? "天窗开着时，新回复、点赞、关注和私信会弹出系统通知，Dock 图标显示未读数。私信通知不显示内容。"
    : !canNotify ? "这个浏览器不支持系统通知。iPhone 上需要先把天窗添加到主屏幕，再从主屏幕打开。"
    : Notification.permission === "granted" ? "已开启。天窗开着时会提醒新消息，并在图标上显示未读数。没有推送服务器，关掉天窗后收不到提醒。"
    : "开启后，天窗开着时会提醒新消息，并在主屏幕图标上显示未读数。没有推送服务器，关掉天窗后收不到提醒。";
  $("#settings").hidden = false;
};
window.openTCSettings = () => $("#openSettings").click();
$("#closeSettings").onclick = () => ($("#settings").hidden = true);
$$(".scrim").forEach((s) => (s.onclick = (e) => { if (e.target === s && !["onboard", "lock"].includes(s.id)) { s.hidden = true; if (s.id === "panel") panelMode = null; } }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { ["settings", "profile", "panel"].forEach((id) => ($("#" + id).hidden = true)); panelMode = null; $("#mentionBox").hidden = true; } });
$("#pinSave").onclick = async () => {
  try {
    const pin = checkPin($("#pinNew").value, $("#pinNew2").value); if (!pin) return toast("先输入新密码");
    $("#pinSave").textContent = "正在加密…";
    const blob = await sealSecret(toHex(sk), pin); await store.set(blob); storedBlob = blob;
    $("#pinNew").value = $("#pinNew2").value = ""; renderPinState(); toast("解锁密码已保存");
  } catch (e) { toast(e.message || "保存失败"); renderPinState(); }
};
$("#pinRemove").onclick = async () => {
  const b = $("#pinRemove");
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "确认移除？"; return; }
  await store.set(toHex(sk)); storedBlob = null; delete b.dataset.confirm; b.textContent = "移除密码"; renderPinState(); toast("已移除解锁密码");
};
$("#notifBtn").onclick = async () => {
  try { const r = await Notification.requestPermission(); toast(r === "granted" ? "已开启通知" : "通知没有开启，可以在系统设置里打开"); updateBadges(); } catch (e) { toast("这个浏览器不支持通知"); }
};
$("#saveKey").onclick = () => { const v = $("#apiKey").value.trim(); ls.set(KEY_SLOT, v); toast(v ? "API Key 已保存在本机" : "已清空"); };
$("#clearKey").onclick = () => { $("#apiKey").value = ""; ls.del(KEY_SLOT); toast("API Key 已清除"); };
$("#saveRelays").onclick = () => {
  const parse = (v) => [...new Set(v.split(/\s+/).map((s) => s.trim()).filter((s) => /^wss:\/\/[^\s]+$/.test(s)))];
  const list = parse($("#relayList").value); if (!list.length) return toast("至少需要一个 wss:// 开头的中继");
  relays = list; searchRelays = parse($("#srelayList").value);
  ls.set("tc-relays", JSON.stringify(relays)); ls.set("tc-srelays", JSON.stringify(searchRelays));
  relayState.clear(); dmRelayCache.clear(); probeRelays(); subscribeMain(); toast("已重连"); $("#settings").hidden = true;
};
$("#resetRelays").onclick = () => { $("#relayList").value = DEFAULT_RELAYS.join("\n"); $("#srelayList").value = DEFAULT_SEARCH.join("\n"); };
$("#themeSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; applyTheme(b.dataset.th); ls.set("tc-theme", b.dataset.th); };
$("#logout").onclick = async () => {
  if ($("#logout").textContent !== "确认：从本机删除私钥") { $("#logout").textContent = "确认：从本机删除私钥"; return; }
  await store.clear(); try { indexedDB.deleteDatabase("tc-" + pk8()); } catch (e) {} location.reload();
};

/* ======================= AI（用你自己的 Anthropic API Key） ======================= */
const KEY_SLOT = "tc-anthropic-key";
const getKey = () => ls.get(KEY_SLOT, "");
async function sample(input, opts = {}) {
  const key = getKey(); if (!key) throw { code: "no_key" };
  const raw = typeof input === "string" ? [{ role: "user", content: input }] : input, messages = [];
  for (const m of raw) { const l = messages[messages.length - 1]; if (l && l.role === m.role) l.content += "\n\n" + m.content; else messages.push({ role: m.role, content: m.content }); }
  let res;
  try { res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify({ model: opts.modelTier === "quick" ? "claude-haiku-5-5" : "claude-sonnet-5-5", max_tokens: 1500, stream: true, messages }) }); }
  catch (e) { throw { code: "offline" }; }
  if (!res.ok) throw { code: res.status === 401 ? "bad_key" : res.status === 429 ? "rate_limited" : "upstream_error" };
  const rd = res.body.getReader(), td = new TextDecoder(); let buf = "", text = "";
  for (;;) { const { done, value } = await rd.read(); if (done) break; buf += td.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) { if (!l.startsWith("data:")) continue; try { const ev = JSON.parse(l.slice(5)); if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; opts.onText?.({ text }); } } catch (e) {} } }
  if (!text) throw { code: "upstream_error" };
  return { text };
}
const errCopy = (c) => ({ no_key: "在「设置」里填入你的 Anthropic API Key 即可使用 AI。密钥只保存在这台设备上。", bad_key: "API Key 无效，请在「设置」里检查。", offline: "连不上 AI 服务，检查一下网络。", rate_limited: "请求太频繁，稍后再试。" }[c] || "AI 暂时没有响应，再点一次试试。");
async function ask(prompt, out, head) {
  if (!out) return;
  out.innerHTML = `<div class="aiout"><span class="h">${head}</span><span class="b">思考中…</span></div>`;
  const b = out.querySelector(".b");
  try { await sample(prompt, { modelTier: "quick", onText: ({ text }) => (b.textContent = text) }); } catch (e) { b.textContent = errCopy(e.code); }
}
function postAI(kind, id) {
  const ev = events.get(id); if (!ev) return;
  const src = (tag(ev, "title") ? tag(ev, "title") + "\n" : "") + ev.content.slice(0, 8000);
  const P = {
    sum: ["一句话摘要", "用一句中文概括这条帖子的核心观点（不超过40字），只输出这句话：\n\n"],
    counter: ["反方观点", "你是一位严谨的买方研究员。针对下面这条观点，给出最有力的2-3条反方论据，用金融从业者的语言，每条一句，不要客套：\n\n"],
    terms: ["术语解释", "把下面帖子里的专业术语挑出来，每个用一句大白话解释，最多4个，格式'术语：解释'：\n\n"],
    en: ["English", "Translate this post into natural, concise English as a finance professional would write it. Output only the translation:\n\n"],
  }[kind];
  const outs = $$("#ai" + id); ask(P[1] + src, outs[outs.length - 1], P[0]);
}
function composeAI(kind) {
  const text = $("#body").value.trim(), box = $("#composeAI"); if (!text) return toast("先写点内容");
  box.hidden = false;
  const P = {
    polish: ["润色", "在不改变观点和立场的前提下，把下面这段中文帖子改得更清晰、更像资深从业者写的，保留原有数字。只输出改写后的正文：\n\n"],
    title: ["标题建议", "为下面的帖子给出3个克制、不标题党的中文标题，每行一个，不要编号：\n\n"],
    check: ["发布前自检", "检查下面的帖子：1) 是否含承诺收益、保本、引流等可能被认为是诈骗的话术；2) 是否有需要披露的利益冲突；3) 有没有明显的事实或逻辑漏洞。每项一句话结论，最后给一个总体判断：'可以放心发布' 或 '建议修改'：\n\n"],
  }[kind];
  ask(P[1] + text, box, P[0]);
}
const turns = [];
$("#askForm").onsubmit = async (e) => {
  e.preventDefault(); const q = $("#askIn").value.trim(); if (!q) return; $("#askIn").value = "";
  const chat = $("#chat"); chat.insertAdjacentHTML("beforeend", `<div class="msg u">${esc(q)}</div>`);
  const a = document.createElement("div"); a.className = "msg a"; a.textContent = "思考中…"; chat.append(a); chat.scrollTop = chat.scrollHeight;
  const ctx = [...posts.values()].filter((ev) => !mutes.has(ev.pubkey)).sort((x, y) => sortTime(y) - sortTime(x)).slice(0, 30).map((ev) => `[${nameOf(ev.pubkey)}｜披露:${holdLab[tag(ev, "disclosure")]?.[0] || "未披露"}] ${tag(ev, "title") ? tag(ev, "title") + "：" : ""}${ev.content.slice(0, 600)}`).join("\n");
  turns.push({ role: "user", content: q });
  try {
    const { text } = await sample([{ role: "user", content: "你是社交平台「天窗」里的研究助手，用简洁的中文、金融从业者的口吻回答，区分事实与观点，指出分歧。以下是当前信息流：\n" + (ctx || "（信息流为空）") }, ...turns.slice(-8)], { onText: ({ text }) => { a.textContent = text; chat.scrollTop = chat.scrollHeight; } });
    turns.push({ role: "assistant", content: text });
  } catch (err) { a.textContent = errCopy(err.code); turns.pop(); }
};

window.addEventListener("pagehide", () => cache.flush());
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
