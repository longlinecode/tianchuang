"use strict";
/* 天窗 0.2 —— 基于 Nostr 协议的客户端 */
const N = window.NostrTools;
const { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash, nip19, nip44 } = N;
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
const ls = { get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }, del(k) { try { localStorage.removeItem(k); } catch (e) {} } };
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.k); toast.k = setTimeout(() => (t.hidden = true), 2600); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast("已复制"); } catch (e) { toast("复制失败，请手动选中复制"); } }

const DEFAULT_RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom", "wss://relay.snort.social", "wss://offchain.pub", "wss://relay.damus.io"];
const BLOSSOM = ["https://blossom.primal.net", "https://nostr.download"];
const TC_TAG = "tianchuang";
const scamRe = /保本|稳赚|稳定.{0,4}收益|翻倍|带单|内部票|进群|私信领取/;
const holdLab = { none: ["未持仓", "ok"], long: ["作者持有多头", ""], short: ["作者持有空头", ""], paid: ["含商业推广", "warn"] };

/* ---------- 私钥保管：Mac App 里用钥匙串加密，浏览器里退回 localStorage ---------- */
const vault = {
  async get() { if (window.tcVault) return await window.tcVault.get(); return ls.get("tc-sk"); },
  async set(hex) { if (window.tcVault) return await window.tcVault.set(hex); ls.set("tc-sk", hex); },
  async clear() { if (window.tcVault) return await window.tcVault.clear(); ls.del("tc-sk"); },
};

/* ---------- 状态 ---------- */
let sk = null, pk = null, pool = null;
let relays = JSON.parse(ls.get("tc-relays", "null") || "null") || DEFAULT_RELAYS.slice();
const posts = new Map();          // 顶层帖子 id/坐标 -> event
const profiles = new Map();       // pubkey -> {name, headline, about, raw, at}
const likes = new Map();          // eventId -> Set(pubkey)
const replies = new Map();        // rootId -> Map(id->event)
const convs = new Map();          // peer -> {msgs: Map(rumorId->msg), last}
let follows = new Set(), contactsEv = null, contactsLoaded = false;
const relayState = new Map();     // url -> {ok, ms}
const verified = new Set(JSON.parse(ls.get("tc-verified", "[]")));
const openReplies = new Set(), openText = new Set();
let tab = "plaza", mode = "short", media = null, curPeer = null, showWire = false;
let subMain = null, subFollow = null, subEng = null;

const short = (p) => { try { const n = nip19.npubEncode(p); return n.slice(0, 10) + "…" + n.slice(-4); } catch (e) { return p.slice(0, 8); } };
const nameOf = (p) => { const pr = profiles.get(p); return (pr && pr.name) || short(p); };
const colorOf = (p) => ["#00BB77", "#0b0d0c", "#FA003F", "#6b726f"][parseInt(p.slice(0, 2), 16) % 4];
const ini = (s) => [...String(s).trim()][0] || "?";
const tag = (ev, k) => (ev.tags.find((t) => t[0] === k) || [])[1];
function ago(ts) { const d = now() - ts; if (d < 60) return "刚刚"; if (d < 3600) return Math.floor(d / 60) + "分钟"; if (d < 86400) return Math.floor(d / 3600) + "小时"; if (d < 86400 * 30) return Math.floor(d / 86400) + "天前"; return new Date(ts * 1000).toLocaleDateString("zh-CN"); }
function decodeNpub(s) {
  s = String(s).trim().replace(/^nostr:/, "");
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  const d = nip19.decode(s);
  if (d.type === "npub") return d.data;
  if (d.type === "nprofile") return d.data.pubkey;
  throw new Error("不是有效的 npub");
}

/* ---------- 启动 ---------- */
async function boot() {
  let saved = null;
  try { saved = await vault.get(); } catch (e) {}
  if (!saved) {
    $("#obHint").textContent = window.tcVault ? "天窗没有注册，也没有手机号。你的账号就是一把密钥，生成在这台电脑上，加密存进 macOS 钥匙串，谁也收不走。" : "天窗没有注册，也没有手机号。你的账号就是一把密钥，只保存在这台设备的浏览器里。创建后请立刻备份私钥：清除网站数据或换手机，都需要用它找回账号。";
    $("#onboard").hidden = false; return;
  }
  sk = fromHex(saved); pk = getPublicKey(sk);
  start();
}
function start() {
  pool = new SimplePool();
  renderMe();
  probeRelays();
  subscribeMain();
  setInterval(refreshRelayState, 5000);
  setInterval(flushProfiles, 1200);
  render();
}

/* ---------- 首次启动 ---------- */
let obMode = "new";
$("#obChoice").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; obMode = b.dataset.ob; $$("#obChoice button").forEach((x) => x.classList.toggle("on", x === b)); $("#obNew").hidden = obMode !== "new"; $("#obImport").hidden = obMode !== "import"; };
$("#obGo").onclick = async () => {
  $("#obErr").hidden = true;
  try {
    if (obMode === "new") {
      const name = $("#obName").value.trim(); if (!name) throw new Error("给自己起个昵称");
      sk = generateSecretKey(); pk = getPublicKey(sk);
      await vault.set(toHex(sk));
      $("#onboard").hidden = true; start();
      profiles.set(pk, { name, headline: $("#obHead").value.trim(), about: "", raw: {}, at: 0 }); renderMe();
      await publishProfile(name, $("#obHead").value.trim(), "");
      await publish({ kind: 10050, created_at: now(), content: "", tags: relays.map((r) => ["relay", r]) });
      openProfile(true);
    } else {
      const v = $("#obNsec").value.trim();
      let bytes;
      if (/^[0-9a-f]{64}$/i.test(v)) bytes = fromHex(v.toLowerCase());
      else { const d = nip19.decode(v); if (d.type !== "nsec") throw new Error("请粘贴 nsec 开头的私钥"); bytes = d.data; }
      sk = bytes; pk = getPublicKey(sk);
      await vault.set(toHex(sk));
      $("#onboard").hidden = true; start();
      toast("已导入，正在从中继同步你的资料");
    }
  } catch (e) { $("#obErr").textContent = e.message || "私钥格式不对"; $("#obErr").hidden = false; }
};

/* ---------- 中继 ---------- */
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
  $("#mNet").textContent = `已连接 ${up}/${relays.length} 个中继`;
}

/* ---------- 订阅 ---------- */
function subscribeMain() {
  subMain?.close();
  subMain = pool.subscribeMany(relays, [
    { kinds: [1, 30023], "#t": [TC_TAG], limit: 200 },
    { kinds: [0, 3], authors: [pk] },
    { kinds: [1059], "#p": [pk], limit: 1000 },
  ], { onevent: ingest, oneose: () => { contactsLoaded = true; } });
  subscribeFollows();
}
function subscribeFollows() {
  subFollow?.close();
  const authors = [...follows, pk];
  subFollow = pool.subscribeMany(relays, [{ kinds: [1, 30023], authors, limit: 300 }, { kinds: [0], authors }], { onevent: ingest });
}
let engTimer = null;
function subscribeEngagement() {
  clearTimeout(engTimer);
  engTimer = setTimeout(() => {
    subEng?.close();
    const ids = [...posts.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 250).map((e) => e.id);
    if (!ids.length) return;
    subEng = pool.subscribeMany(relays, [{ kinds: [1, 7], "#e": ids }], { onevent: ingest });
  }, 1200);
}
const wantProfiles = new Set();
function needProfile(p) { if (!profiles.has(p)) wantProfiles.add(p); }
function flushProfiles() {
  if (!wantProfiles.size || !pool) return;
  const batch = [...wantProfiles].slice(0, 100); batch.forEach((p) => { wantProfiles.delete(p); if (!profiles.has(p)) profiles.set(p, { name: "", headline: "", about: "", raw: {}, at: -1 }); });
  const s = pool.subscribeMany(relays, [{ kinds: [0], authors: batch }], { onevent: ingest, oneose: () => s.close() });
}

/* ---------- 收到事件 ---------- */
function ingest(ev) {
  switch (ev.kind) {
    case 0: {
      const cur = profiles.get(ev.pubkey);
      if (cur && cur.at >= ev.created_at) return;
      let raw = {}; try { raw = JSON.parse(ev.content) || {}; } catch (e) {}
      profiles.set(ev.pubkey, { name: String(raw.display_name || raw.name || "").slice(0, 60), headline: String(raw.tc_headline || "").slice(0, 120), about: String(raw.about || "").slice(0, 600), raw, at: ev.created_at });
      if (ev.pubkey === pk) renderMe();
      return schedule();
    }
    case 3: {
      if (ev.pubkey !== pk || (contactsEv && contactsEv.created_at >= ev.created_at)) return;
      contactsEv = ev; follows = new Set(ev.tags.filter((t) => t[0] === "p" && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1]));
      updateFollowCount(); subscribeFollows(); return schedule();
    }
    case 1: {
      const root = ev.tags.find((t) => t[0] === "e" && t[3] === "root") || ev.tags.find((t) => t[0] === "e");
      if (root) {
        if (!replies.has(root[1])) replies.set(root[1], new Map());
        replies.get(root[1]).set(ev.id, ev); needProfile(ev.pubkey); return schedule();
      }
      if (posts.has(ev.id)) return;
      posts.set(ev.id, ev); needProfile(ev.pubkey); subscribeEngagement(); return schedule();
    }
    case 30023: {
      const key = ev.pubkey + ":" + (tag(ev, "d") || "");
      const old = [...posts.values()].find((p) => p.kind === 30023 && p.pubkey + ":" + (tag(p, "d") || "") === key);
      if (old && old.created_at >= ev.created_at) return;
      if (old) posts.delete(old.id);
      posts.set(ev.id, ev); needProfile(ev.pubkey); subscribeEngagement(); return schedule();
    }
    case 7: {
      if (ev.content === "-") return;
      const target = [...ev.tags].reverse().find((t) => t[0] === "e"); if (!target) return;
      if (!likes.has(target[1])) likes.set(target[1], new Set());
      likes.get(target[1]).add(ev.pubkey); return schedule();
    }
    case 1059: return onGiftWrap(ev);
  }
}

/* ---------- 发布 ---------- */
async function publish(tpl) {
  const ev = finalizeEvent(tpl, sk);
  const res = await Promise.allSettled(pool.publish(relays, ev));
  const ok = res.filter((r) => r.status === "fulfilled").length;
  if (ok) ingest(ev);
  return { ev, ok };
}
async function publishProfile(name, headline, about) {
  const raw = { ...(profiles.get(pk)?.raw || {}), name, display_name: name, about, tc_headline: headline };
  const { ok } = await publish({ kind: 0, created_at: now(), tags: [], content: JSON.stringify(raw) });
  return ok;
}
async function ensureContacts() {
  if (contactsLoaded && contactsEv) return;
  const evs = await pool.querySync(relays, { kinds: [3], authors: [pk], limit: 1 }, { maxWait: 4000 });
  evs.forEach(ingest); contactsLoaded = true;
}
async function setFollow(target, on) {
  await ensureContacts();
  const tags = (contactsEv?.tags || []).filter((t) => !(t[0] === "p" && t[1] === target));
  if (on) tags.push(["p", target]);
  const { ok } = await publish({ kind: 3, created_at: now(), tags, content: contactsEv?.content || "" });
  toast(on ? `已关注 ${nameOf(target)} · 写入 ${ok} 个中继` : `已取消关注`);
}
function updateFollowCount() { $("#followCount").textContent = follows.size ? `你关注了 ${follows.size} 个人。` : "你还没有关注任何人。"; }

/* ---------- 媒体上传（Blossom 协议） ---------- */
async function uploadBlossom(file) {
  const hash = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
  const auth = finalizeEvent({ kind: 24242, created_at: now(), content: "Upload media", tags: [["t", "upload"], ["x", hash], ["expiration", String(now() + 600)]] }, sk);
  const header = "Nostr " + btoa(JSON.stringify(auth));
  let lastErr = "";
  for (const server of BLOSSOM) {
    try {
      const r = await fetch(server + "/upload", { method: "PUT", headers: { Authorization: header, "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!r.ok) { lastErr = server + " " + r.status; continue; }
      const j = await r.json(); if (j.url) return j.url;
    } catch (e) { lastErr = server + " 连不上"; }
  }
  throw new Error(lastErr || "上传失败");
}

/* ---------- 渲染 ---------- */
let renderPending = false, renderBlocked = false;
function schedule() { if (renderPending) return; renderPending = true; requestAnimationFrame(() => { renderPending = false; if (tab === "dm") { renderConvs(); renderThread(); } else render(); }); }
document.addEventListener("focusout", (e) => { if (renderBlocked && e.target.closest?.("#feed")) { renderBlocked = false; setTimeout(render, 0); } });

const mediaRe = /https?:\/\/[^\s<>"']+/g;
function mediaKind(u) { const p = u.split("?")[0].toLowerCase(); if (/\.(mp4|mov|webm|m4v)$/.test(p)) return "video"; if (/\.(mp3|m4a|ogg|wav|aac|opus|flac)$/.test(p)) return "audio"; if (/\.(png|jpe?g|gif|webp|avif)$/.test(p)) return "image"; return null; }
function hasMedia(ev) { return (ev.content.match(mediaRe) || []).some(mediaKind); }
function linkify(text) { return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>`); }
function mediaHTML(ev) {
  return (ev.content.match(mediaRe) || []).filter(mediaKind).slice(0, 4).map((u) => {
    const k = mediaKind(u), s = esc(u);
    return `<div class="media">${k === "video" ? `<video controls preload="metadata" src="${s}"></video>` : k === "audio" ? `<audio controls preload="metadata" src="${s}"></audio>` : `<img loading="lazy" src="${s}" alt="">`}</div>`;
  }).join("");
}
function visible() {
  let list = [...posts.values()];
  if (tab === "plaza") list = list.filter((e) => e.tags.some((t) => t[0] === "t" && t[1] === TC_TAG));
  if (tab === "follow") list = list.filter((e) => follows.has(e.pubkey) || e.pubkey === pk);
  if (tab === "long") list = list.filter((e) => e.kind === 30023);
  if (tab === "media") list = list.filter(hasMedia);
  if ($("#fPromo").checked) list = list.filter((e) => tag(e, "disclosure") !== "paid");
  const q = $("#q").value.trim(); if (q) list = list.filter((e) => (e.content + (tag(e, "title") || "") + nameOf(e.pubkey)).includes(q));
  return list.sort((a, b) => (Number(tag(b, "published_at")) || b.created_at) - (Number(tag(a, "published_at")) || a.created_at));
}
function postHTML(ev) {
  const pr = profiles.get(ev.pubkey) || {}, name = nameOf(ev.pubkey), mine = ev.pubkey === pk;
  const scam = scamRe.test(ev.content), folded = scam && $("#fScam").checked && !openText.has(ev.id);
  const disc = tag(ev, "disclosure"), title = ev.kind === 30023 ? tag(ev, "title") : "";
  const textOnly = ev.content.replace(mediaRe, (u) => (mediaKind(u) ? "" : u)).trim();
  const lk = likes.get(ev.id), liked = lk?.has(pk), rp = replies.get(ev.id);
  const tagsList = ev.tags.filter((t) => t[0] === "t" && t[1] !== TC_TAG).map((t) => t[1]).slice(0, 6);
  let body = title ? `<div class="ptitle">${esc(title)}</div>` : "";
  if (folded) body += `<div class="aiout"><span class="h">已折叠</span>这条内容含"承诺收益 / 引流"类话术。内容仍在，你可以选择展开。<br><button class="more" data-unfold="${ev.id}">仍然展开</button></div>`;
  else {
    const long = ev.kind === 30023 && !openText.has(ev.id);
    body += `<div class="text ${long ? "clamp" : ""}">${linkify(textOnly)}</div>`;
    if (ev.kind === 30023) body += `<button class="more" data-expand="${ev.id}">${long ? "展开全文" : "收起"}</button>`;
    body += mediaHTML(ev);
    if (tagsList.length) body += `<div class="tags">${tagsList.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>`;
  }
  const labs = [];
  if (disc && holdLab[disc]) labs.push(`<span class="lab ${holdLab[disc][1]}">披露：${holdLab[disc][0]}</span>`);
  if (scam) labs.push(`<span class="lab warn">规则标注：疑似承诺收益</span>`);
  if (tag(ev, "client") === "天窗") labs.push(`<span class="lab">来自天窗</span>`);
  let rpHTML = "";
  if (openReplies.has(ev.id)) {
    const list = rp ? [...rp.values()].sort((a, b) => a.created_at - b.created_at) : [];
    rpHTML = `<div class="replies">${list.map((r) => `<div class="reply"><b>${esc(nameOf(r.pubkey))}</b> <span class="time">· ${ago(r.created_at)}</span><div class="text">${linkify(r.content)}</div></div>`).join("") || `<div class="reply" style="color:var(--muted)">还没有回复。</div>`}
      <form class="reply-form" data-reply="${ev.id}"><input id="rp-${ev.id}" placeholder="写回复…" autocomplete="off"><button>回复</button></form></div>`;
  }
  return `<article class="post">
   <div class="avatar" style="background:${colorOf(ev.pubkey)}">${esc(ini(name))}</div>
   <div style="min-width:0">
    <div class="who" style="display:flex"><b>${esc(name)}</b><span class="time">· ${ago(ev.created_at)}</span>
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
     <button class="act" data-replies="${ev.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/></svg>${rp ? rp.size : 0}</button>
     <button class="act like ${liked ? "on" : ""}" data-like="${ev.id}"><svg viewBox="0 0 24 24" fill="${liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z"/></svg>${lk ? lk.size : 0}</button>
     ${mine ? "" : `<button class="act" data-dmto="${ev.pubkey}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>私信</button>`}
     <button class="act" data-link="${ev.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>链接</button>
    </div>
   </div></article>`;
}
function cardHTML(ev) {
  const bg = ["#00BB77", "#0b0d0c", "#FA003F", "#6b726f"][parseInt(ev.id.slice(0, 2), 16) % 4];
  const head = tag(ev, "title") || ev.content.replace(mediaRe, "").trim().split("\n")[0] || "（媒体）";
  const lk = likes.get(ev.id);
  return `<div class="card" data-open="${ev.id}"><div class="cover" style="background:${bg};min-height:${[150, 210, 180, 240][parseInt(ev.id.slice(2, 4), 16) % 4]}px">${esc(head.length > 34 ? head.slice(0, 34) + "…" : head)}</div>
    <div class="meta"><div class="row"><span><span class="mini" style="background:${colorOf(ev.pubkey)}">${esc(ini(nameOf(ev.pubkey)))}</span>${esc(nameOf(ev.pubkey))}</span><span>♥ ${lk ? lk.size : 0}</span></div></div></div>`;
}
function emptyHTML() {
  const npub = pk ? nip19.npubEncode(pk) : "";
  if (tab === "follow") return `<div class="empty"><h3>关注的人还没发帖</h3><p>在右侧粘贴朋友的 npub 关注对方，或者在「天窗广场」里点帖子上的「关注」。</p></div>`;
  return `<div class="empty"><h3>这里还很安静</h3><p>天窗广场只显示用天窗发出的帖子。发第一条，或者把你的账号发给朋友，请对方装好天窗后关注你。</p>
    <div class="copy-row" style="width:100%"><div class="mono">${esc(npub)}</div><button class="ghost" data-copy="${esc(npub)}">复制我的 npub</button></div></div>`;
}
function render() {
  if (tab === "dm" || !pk) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest("#feed") && a.tagName === "INPUT") { renderBlocked = true; return; }
  const list = visible(), f = $("#feed");
  if (tab === "discover") f.innerHTML = list.length ? `<div class="grid">${list.map(cardHTML).join("")}</div>` : emptyHTML();
  else f.innerHTML = list.length ? list.slice(0, 200).map(postHTML).join("") : emptyHTML();
  renderTrend();
}
function renderTrend() {
  const c = new Map();
  for (const e of posts.values()) for (const t of e.tags) if (t[0] === "t" && t[1] !== TC_TAG) c.set(t[1], (c.get(t[1]) || 0) + 1);
  const top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("#trend").innerHTML = top.length ? top.map(([t, n]) => `<button data-hashtag="${esc(t)}"><b>#${esc(t)}</b>${n} 篇</button>`).join("") : `<div>帖子里带 #话题 后会出现在这里。</div>`;
}
function renderMe() {
  if (!pk) return;
  const n = nameOf(pk);
  $("#meName").textContent = n; $("#meKey").textContent = short(pk);
  $("#meName2").textContent = n; $("#meKey2").textContent = short(pk);
  [$("#meAv"), $("#compAv"), $("#meAv2")].forEach((el) => { el.textContent = ini(n); el.style.background = colorOf(pk); });
}

/* ---------- 标签页 ---------- */
function setTab(t) {
  if (t === "compose") { t = "plaza"; setTimeout(() => { $("#body").focus(); $("#composer").scrollIntoView({ behavior: "smooth" }); }, 50); }
  tab = t;
  $$(".tabs button,.tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $$(".nav a[data-go]").forEach((a) => a.classList.toggle("on", a.dataset.go === t));
  const isDM = t === "dm";
  document.body.dataset.tab = t;
  $("#composer").hidden = t === "discover" || isDM;
  $(".tabs").hidden = isDM; $("#feed").hidden = isDM; $("#dm").hidden = !isDM; $(".mhead").hidden = isDM;
  window.scrollTo(0, 0);
  if (isDM) { renderConvs(); renderThread(); return; }
  if (t === "me") return;
  render();
}
$$(".tabs button,.tabbar button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$$(".nav a[data-go]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); setTab(a.dataset.go); }));
["fPromo", "fScam"].forEach((id) => ($("#" + id).onchange = render));
$("#q").oninput = render;
$("#focusCompose").onclick = () => setTab("compose");

/* ---------- 发帖 ---------- */
function syncSend() { $("#send").disabled = !($("#body").value.trim() || media); }
$("#body").oninput = () => { syncSend(); ls.set("tc-draft", $("#body").value); };
$("#body").value = ls.get("tc-draft", ""); syncSend();
$$("#modes button").forEach((b) => (b.onclick = () => { mode = b.dataset.mode; $$("#modes button").forEach((x) => x.classList.toggle("on", x === b)); $("#title").hidden = mode !== "article"; $("#body").placeholder = mode === "article" ? "正文。支持长篇论证，读者可一键 AI 摘要。" : "打开天窗说亮话。观点不需要被审批。"; }));
$("#pickMedia").onclick = () => $("#fMedia").click();
$("#fMedia").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || !sk) return;
  if (f.size > 100 * 1024 * 1024) return toast("文件超过 100MB");
  const local = URL.createObjectURL(f), k = f.type.split("/")[0];
  $("#mediaPrev").innerHTML = k === "video" ? `<video controls src="${local}"></video>` : k === "audio" ? `<audio controls src="${local}"></audio>` : `<img src="${local}" alt="">`;
  $("#upState").hidden = false; $("#upState").textContent = "正在上传到媒体服务器…"; media = null; syncSend();
  try { const url = await uploadBlossom(f); media = { url }; $("#upState").textContent = "已上传 · " + url.replace(/^https:\/\//, "").slice(0, 48); }
  catch (err) { $("#upState").textContent = "上传失败：" + err.message; $("#mediaPrev").innerHTML = ""; }
  syncSend();
};
$("#send").onclick = async () => {
  const text = $("#body").value.trim(), title = $("#title").value.trim();
  if (mode === "article" && !title) return toast("长文需要标题");
  const hashtags = [...new Set((text.match(/#([^\s#，。,.!?！？]+)/g) || []).map((t) => t.slice(1)))].slice(0, 10);
  const tags = [["t", TC_TAG], ["client", "天窗"], ["disclosure", $("#holding").value], ...hashtags.map((h) => ["t", h])];
  const content = [text, media?.url].filter(Boolean).join("\n\n");
  $("#send").disabled = true;
  let res;
  if (mode === "article") res = await publish({ kind: 30023, created_at: now(), content, tags: [["d", toHex(crypto.getRandomValues(new Uint8Array(8)))], ["title", title], ["published_at", String(now())], ...tags] });
  else res = await publish({ kind: 1, created_at: now(), content, tags });
  if (!res.ok) { toast("没有中继接收这条帖子，检查一下网络"); syncSend(); return; }
  $("#body").value = ""; $("#title").value = ""; $("#mediaPrev").innerHTML = ""; $("#upState").hidden = true; media = null; $("#composeAI").hidden = true; ls.del("tc-draft"); syncSend();
  toast(`已签名并写入 ${res.ok}/${relays.length} 个中继`);
};

/* ---------- 帖子上的操作 ---------- */
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button,[data-open]"); if (!t) return;
  const d = t.dataset;
  if (d.like) {
    const ev = posts.get(d.like); if (!ev || likes.get(ev.id)?.has(pk)) return;
    await publish({ kind: 7, created_at: now(), content: "+", tags: [["e", ev.id], ["p", ev.pubkey], ["k", String(ev.kind)]] });
  } else if (d.replies) { openReplies.has(d.replies) ? openReplies.delete(d.replies) : openReplies.add(d.replies); render(); setTimeout(() => $("#rp-" + d.replies)?.focus(), 30); }
  else if (d.follow) { const on = !follows.has(d.follow); t.disabled = true; await setFollow(d.follow, on); }
  else if (d.dmto) { openConv(d.dmto); setTab("dm"); }
  else if (d.link) { const ev = posts.get(d.link); copy(ev.kind === 30023 ? nip19.naddrEncode({ kind: 30023, pubkey: ev.pubkey, identifier: tag(ev, "d") || "", relays: relays.slice(0, 2) }) : nip19.neventEncode({ id: ev.id, relays: relays.slice(0, 2), author: ev.pubkey })); }
  else if (d.expand) { openText.has(d.expand) ? openText.delete(d.expand) : openText.add(d.expand); render(); }
  else if (d.unfold) { openText.add(d.unfold); render(); }
  else if (d.copy) copy(d.copy);
  else if (d.hashtag) { $("#q").value = d.hashtag; setTab("plaza"); }
  else if (d.open) setTab("plaza");
  else if (d.ai && d.id) postAI(d.ai, d.id);
  else if (t.classList.contains("ai")) composeAI(d.ai);
});
document.addEventListener("submit", async (e) => {
  const f = e.target; if (!f.dataset.reply) return; e.preventDefault();
  const root = posts.get(f.dataset.reply), input = f.querySelector("input"), text = input.value.trim(); if (!text || !root) return;
  input.value = ""; input.blur();
  const tags = [["e", root.id, relays[0], "root"], ["p", root.pubkey], ["client", "天窗"]];
  if (root.kind === 30023) tags.push(["a", `30023:${root.pubkey}:${tag(root, "d") || ""}`]);
  const { ok } = await publish({ kind: 1, created_at: now(), content: text, tags });
  toast(ok ? "回复已发布" : "回复发布失败");
});
$("#followForm").onsubmit = async (e) => {
  e.preventDefault();
  try { const p = decodeNpub($("#followIn").value); if (p === pk) return toast("这是你自己"); $("#followIn").value = ""; needProfile(p); await setFollow(p, true); }
  catch (err) { toast("没认出这个 npub"); }
};

/* ---------- 加密私信（NIP-17：kind 14 → 封印 13 → 礼物包装 1059） ---------- */
function unwrapGift(wrap) {
  const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey)));
  if (seal.kind !== 13 || !verifyEvent(seal)) throw new Error("bad seal");
  const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey)));
  if (rumor.pubkey !== seal.pubkey) throw new Error("sender mismatch");   // 防冒充：内层作者必须等于封印签名者
  return rumor;
}
const randPast = () => now() - Math.floor(Math.random() * 172800);
function giftWrap(rumor, recipient, expSec) {
  const seal = finalizeEvent({ kind: 13, created_at: randPast(), tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(sk, recipient)) }, sk);
  const rk = generateSecretKey(), tags = [["p", recipient]];
  if (expSec) tags.push(["expiration", String(now() + expSec)]);
  return finalizeEvent({ kind: 1059, created_at: randPast(), tags, content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(rk, recipient)) }, rk);
}
const seenWraps = new Set();
function onGiftWrap(wrap) {
  if (seenWraps.has(wrap.id)) return; seenWraps.add(wrap.id);
  let r; try { r = unwrapGift(wrap); } catch (e) { return; }
  if (r.kind !== 14) return;
  const peer = r.pubkey === pk ? (r.tags.find((t) => t[0] === "p" && t[1] !== pk) || [, pk])[1] : r.pubkey;
  const exp = Number(tag(wrap, "expiration")) || 0;
  addMsg(peer, { id: r.id, me: r.pubkey === pk, text: String(r.content), at: r.created_at, wire: wrap.content, exp, status: "" });
  if (r.pubkey !== pk && r.created_at > now() - 120 && !(tab === "dm" && curPeer === peer)) toast(`${nameOf(peer)} 发来一条加密私信`);
}
function addMsg(peer, m) {
  if (!convs.has(peer)) convs.set(peer, { msgs: new Map(), last: 0 });
  const c = convs.get(peer), old = c.msgs.get(m.id);
  if (old) { if (!old.wire && m.wire) old.wire = m.wire; if (m.status) old.status = m.status; }
  else c.msgs.set(m.id, m);
  c.last = Math.max(c.last, m.at); needProfile(peer); schedule();
}
async function dmRelaysOf(p) {
  try { const ev = await pool.get(relays, { kinds: [10050], authors: [p] }, { maxWait: 3000 }); const r = (ev?.tags || []).filter((t) => t[0] === "relay" && /^wss:\/\//.test(t[1])).map((t) => t[1]); if (r.length) return r.slice(0, 5); } catch (e) {}
  return relays;
}
async function sendDM(peer, text) {
  const exp = Number($("#timer").value) || 0;
  const rumor = { kind: 14, created_at: now(), tags: [["p", peer]], content: text, pubkey: pk };
  rumor.id = getEventHash(rumor);
  const toPeer = giftWrap(rumor, peer, exp), toSelf = giftWrap(rumor, pk, exp);
  addMsg(peer, { id: rumor.id, me: true, text, at: rumor.created_at, wire: toPeer.content, exp: exp ? now() + exp : 0, status: "发送中" });
  const target = [...new Set([...(await dmRelaysOf(peer)), ...relays])];
  const res = await Promise.allSettled(pool.publish(target, toPeer));
  Promise.allSettled(pool.publish(relays, toSelf));
  seenWraps.add(toSelf.id);
  const ok = res.filter((x) => x.status === "fulfilled").length;
  addMsg(peer, { id: rumor.id, status: ok ? `已送达 ${ok} 个中继` : "发送失败", at: rumor.created_at });
}
function openConv(p) { if (!convs.has(p)) convs.set(p, { msgs: new Map(), last: now() }); curPeer = p; needProfile(p); $("#dm").classList.add("open"); $("#safety").hidden = true; }
$("#newChat").onsubmit = (e) => { e.preventDefault(); try { const p = decodeNpub($("#newChatIn").value); if (p === pk) return toast("不能给自己发私信"); $("#newChatIn").value = ""; openConv(p); renderConvs(); renderThread(); $("#dmIn").focus(); } catch (err) { toast("没认出这个 npub"); } };
$("#convs").onclick = (e) => { const b = e.target.closest("[data-conv]"); if (!b) return; openConv(b.dataset.conv); renderConvs(); renderThread(); };
$("#dmBack").onclick = () => $("#dm").classList.remove("open");
$("#wire").onclick = () => { showWire = !showWire; $("#wire").classList.toggle("on", showWire); $("#wire").textContent = showWire ? "隐藏密文" : "显示密文"; renderThread(); };
$("#safeBtn").onclick = () => { $("#safety").hidden = !$("#safety").hidden; $("#safeBtn").classList.toggle("on", !$("#safety").hidden); };
$("#verifyBtn").onclick = () => { if (!curPeer) return; verified.has(curPeer) ? verified.delete(curPeer) : verified.add(curPeer); ls.set("tc-verified", JSON.stringify([...verified])); renderThread(); };
$("#dmForm").onsubmit = async (e) => { e.preventDefault(); const text = $("#dmIn").value.trim(); if (!text || !curPeer) return; $("#dmIn").value = ""; await sendDM(curPeer, text); };
setInterval(() => { if (tab === "dm") renderThread(); }, 30000);

async function safetyNumber(a, b) {
  const [x, y] = [a, b].sort();
  const h = new Uint8Array(await crypto.subtle.digest("SHA-512", fromHex(x + y)));
  const out = []; for (let i = 0; i < 12; i++) { let n = 0; for (let j = 0; j < 5; j++) n = (n * 256 + h[i * 5 + j]) % 100000; out.push(String(n).padStart(5, "0")); }
  return out;
}
function renderConvs() {
  const list = [...convs.entries()].sort((a, b) => b[1].last - a[1].last);
  $("#convs").innerHTML = list.map(([p, c]) => {
    const last = [...c.msgs.values()].sort((a, b) => b.at - a.at)[0];
    return `<button class="conv ${p === curPeer ? "on" : ""}" data-conv="${p}"><div class="avatar" style="background:${colorOf(p)}">${esc(ini(nameOf(p)))}</div>
      <div><b>${esc(nameOf(p))}</b><small>${last ? esc((last.me ? "你：" : "") + last.text) : "尚无消息"}</small></div></button>`;
  }).join("");
}
async function renderThread() {
  if (!curPeer) return;
  const p = curPeer, c = convs.get(p) || { msgs: new Map() };
  $("#thAv").textContent = ini(nameOf(p)); $("#thAv").style.background = colorOf(p); $("#thName").textContent = nameOf(p);
  const v = verified.has(p);
  $("#thSub").className = v ? "badge-v" : "badge-u"; $("#thSub").textContent = v ? "✓ 安全码已验证" : short(p) + " · 未验证";
  $("#verifyBtn").textContent = v ? "已验证 ✓" : "标记为已验证"; $("#verifyBtn").classList.toggle("done", v);
  const lock = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;
  const t = now();
  const msgs = [...c.msgs.values()].filter((m) => !m.exp || m.exp > t).sort((a, b) => a.at - b.at);
  const box = $("#msgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = `<div class="sys">消息经 NIP-17 加密：中继只能看到一个随机临时身份发给你的乱码，看不到内容、也看不到是谁发的。</div>` +
    msgs.map((m) => `<div class="bub ${m.me ? "mine" : "them"}">${esc(m.text)}${showWire && m.wire ? `<div class="ct">${esc(m.wire.slice(0, 220))}…</div>` : ""}<div class="m">${m.exp ? "⏱ " : ""}${lock}${new Date(m.at * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}${m.me && m.status ? ` · <span class="status">${esc(m.status)}</span>` : ""}</div></div>`).join("");
  if (atBottom) box.scrollTop = box.scrollHeight;
  const digits = await safetyNumber(pk, p);
  if (curPeer === p) $("#digits").innerHTML = digits.map((d) => `<span>${d}</span>`).join("");
}

/* ---------- 个人档案 ---------- */
function openProfile(first) {
  const pr = profiles.get(pk) || {};
  $("#pfNpub").textContent = nip19.npubEncode(pk);
  $("#pfName").value = pr.name || ""; $("#pfHead").value = pr.headline || ""; $("#pfAbout").value = pr.about || "";
  $("#pfNsec").textContent = "••••••••••••••••••••••••••••••••"; $("#showNsec").textContent = "显示";
  $("#pfTitle").textContent = first ? "身份已创建 · 请先备份私钥" : "个人档案";
  $("#profile").hidden = false;
}
$("#openProfile").onclick = (e) => { e.preventDefault(); if (pk) openProfile(false); };
$("#meCard").onclick = () => pk && openProfile(false);
$("#mProfile").onclick = () => pk && openProfile(false);
$("#mSettings").onclick = () => $("#openSettings").click();
$("#copyNpub").onclick = () => copy(nip19.npubEncode(pk));
$("#showNsec").onclick = () => { if ($("#showNsec").textContent === "显示") { $("#pfNsec").textContent = nip19.nsecEncode(sk); $("#showNsec").textContent = "复制"; } else copy(nip19.nsecEncode(sk)); };
$("#pfSave").onclick = async () => { const n = $("#pfName").value.trim(); if (!n) return toast("昵称不能为空"); const ok = await publishProfile(n, $("#pfHead").value.trim(), $("#pfAbout").value.trim()); toast(`资料已发布到 ${ok} 个中继`); };
$("#closeProfile").onclick = () => { $("#profile").hidden = true; $("#pfNsec").textContent = "••••"; };

/* ---------- 设置 ---------- */
const isMacApp = new URLSearchParams(location.search).get("app") === "mac";
if (isMacApp) document.body.classList.add("mac-app");
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; $$("#themeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.th === (t || ""))); }
applyTheme(ls.get("tc-theme", ""));
$("#openSettings").onclick = (e) => { e.preventDefault(); $("#apiKey").value = getKey(); $("#relayList").value = relays.join("\n"); $("#logout").textContent = "退出账号（从本机删除私钥）"; $("#settings").hidden = false; };
window.openTCSettings = () => $("#openSettings").click();
$("#closeSettings").onclick = () => ($("#settings").hidden = true);
$$(".scrim").forEach((s) => (s.onclick = (e) => { if (e.target === s && s.id !== "onboard") s.hidden = true; }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") ["settings", "profile"].forEach((id) => ($("#" + id).hidden = true)); });
$("#saveKey").onclick = () => { const v = $("#apiKey").value.trim(); ls.set(KEY_SLOT, v); toast(v ? "API Key 已保存在本机" : "已清空"); };
$("#clearKey").onclick = () => { $("#apiKey").value = ""; ls.del(KEY_SLOT); toast("API Key 已清除"); };
$("#saveRelays").onclick = () => {
  const list = [...new Set($("#relayList").value.split(/\s+/).map((s) => s.trim()).filter((s) => /^wss:\/\/[^\s]+$/.test(s)))];
  if (!list.length) return toast("至少需要一个 wss:// 开头的中继");
  relays = list; ls.set("tc-relays", JSON.stringify(relays)); relayState.clear(); probeRelays(); subscribeMain(); toast("已重连"); $("#settings").hidden = true;
};
$("#resetRelays").onclick = () => ($("#relayList").value = DEFAULT_RELAYS.join("\n"));
$("#themeSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; applyTheme(b.dataset.th); ls.set("tc-theme", b.dataset.th); };
$("#logout").onclick = async () => {
  if ($("#logout").textContent !== "确认：从本机删除私钥") { $("#logout").textContent = "确认：从本机删除私钥"; return; }
  await vault.clear(); location.reload();
};

/* ---------- AI（独立 App 用你自己的 Anthropic API Key） ---------- */
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
const errCopy = (c) => ({ no_key: "在「设置」里填入你的 Anthropic API Key 即可使用 AI。密钥只保存在这台电脑上。", bad_key: "API Key 无效，请在「设置」里检查。", offline: "连不上 AI 服务，检查一下网络。", rate_limited: "请求太频繁，稍后再试。" }[c] || "AI 暂时没有响应，再点一次试试。");
async function ask(prompt, out, head) {
  out.innerHTML = `<div class="aiout"><span class="h">${head}</span><span class="b">思考中…</span></div>`;
  const b = out.querySelector(".b");
  try { await sample(prompt, { modelTier: "quick", onText: ({ text }) => (b.textContent = text) }); } catch (e) { b.textContent = errCopy(e.code); }
}
function postAI(kind, id) {
  const ev = posts.get(id); if (!ev) return;
  const src = (tag(ev, "title") ? tag(ev, "title") + "\n" : "") + ev.content.slice(0, 8000);
  const P = {
    sum: ["一句话摘要", "用一句中文概括这条帖子的核心观点（不超过40字），只输出这句话：\n\n"],
    counter: ["反方观点", "你是一位严谨的买方研究员。针对下面这条观点，给出最有力的2-3条反方论据，用金融从业者的语言，每条一句，不要客套：\n\n"],
    terms: ["术语解释", "把下面帖子里的专业术语挑出来，每个用一句大白话解释，最多4个，格式'术语：解释'：\n\n"],
    en: ["English", "Translate this post into natural, concise English as a finance professional would write it. Output only the translation:\n\n"],
  }[kind];
  ask(P[1] + src, $("#ai" + id), P[0]);
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
  const ctx = visible().slice(0, 30).map((ev) => `[${nameOf(ev.pubkey)}｜披露:${holdLab[tag(ev, "disclosure")]?.[0] || "未披露"}] ${tag(ev, "title") ? tag(ev, "title") + "：" : ""}${ev.content.slice(0, 600)}`).join("\n");
  turns.push({ role: "user", content: q });
  try {
    const { text } = await sample([{ role: "user", content: "你是社交平台「天窗」里的研究助手，用简洁的中文、金融从业者的口吻回答，区分事实与观点，指出分歧。以下是当前信息流：\n" + (ctx || "（信息流为空）") }, ...turns.slice(-8)], { onText: ({ text }) => { a.textContent = text; chat.scrollTop = chat.scrollHeight; } });
    turns.push({ role: "assistant", content: text });
  } catch (err) { a.textContent = errCopy(err.code); turns.pop(); }
};

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
