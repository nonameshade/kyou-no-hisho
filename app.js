/* ============================================================
   きょうの秘書 — app.js
   データは localStorage に保存。将来 Google Sheets 同期を追加する
   前提で、タスクに date フィールドを持たせています。
   ============================================================ */

const STORE_KEY = "hisho:data:v1";

const pad = (n) => String(n).padStart(2, "0");
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hmToMin = (hm) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};
const nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
const nowHM = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDur = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- 状態 ---------- */
let state = { tasks: [] };
let wakeLock = null;
let lastBeep = 0;
let renderedCurrentId = null;
let renderedOverrun = false;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {
    console.error("読み込みに失敗しました", e);
  }
  if (!state || !Array.isArray(state.tasks)) state = { tasks: [] };
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    localStorage.setItem(DIRTY_KEY, "1");
  } catch (e) {
    console.error("保存に失敗しました", e);
  }
  scheduleSync();
}

/* ---------- スプレッドシート同期(フェーズ2) ---------- */
const SYNC_URL_KEY = "hisho:sync:url";
const SYNC_TOKEN_KEY = "hisho:sync:token";
const LAST_SYNC_KEY = "hisho:sync:last";
const DIRTY_KEY = "hisho:sync:dirty";
let syncTimer = null;
let syncing = false;

const syncConfigured = () => !!localStorage.getItem(SYNC_URL_KEY);

function setSyncMsg(text, isErr) {
  const el = document.getElementById("sync-status");
  if (el) {
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }
  const m = document.getElementById("settings-msg");
  if (m && !document.getElementById("settings").classList.contains("hidden")) {
    m.textContent = text;
  }
}

function syncStatusLabel() {
  if (!syncConfigured()) return "⚙ 同期を設定";
  if (localStorage.getItem(DIRTY_KEY) === "1") return "未同期の変更あり";
  const last = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
  if (!last) return "まだ同期していません";
  const d = new Date(last);
  return `同期済み ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scheduleSync() {
  setSyncMsg(syncStatusLabel());
  if (!syncConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(false), 4000);
}

async function doSync(manual) {
  if (!syncConfigured()) {
    if (manual) setSyncMsg("先にURLと合言葉を保存してください", true);
    return;
  }
  if (!navigator.onLine) {
    setSyncMsg("オフライン(接続後に自動同期します)");
    return;
  }
  if (syncing) return;
  syncing = true;
  setSyncMsg("同期中…");
  try {
    const res = await fetch(localStorage.getItem(SYNC_URL_KEY), {
      method: "POST",
      body: JSON.stringify({
        token: localStorage.getItem(SYNC_TOKEN_KEY) || "",
        tasks: state.tasks,
      }),
    });
    const data = await res.json();
    if (data && data.ok) {
      localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
      localStorage.setItem(DIRTY_KEY, "0");
      setSyncMsg(syncStatusLabel());
    } else {
      setSyncMsg(`同期エラー: ${(data && data.error) || "不明"}`, true);
    }
  } catch (e) {
    setSyncMsg("同期に失敗しました(URLと通信環境を確認)", true);
  }
  syncing = false;
}

window.addEventListener("online", () => doSync(false));

/* ---------- 参照ヘルパー ---------- */
const todays = () =>
  state.tasks
    .filter((t) => t.date === todayKey())
    .sort((a, b) => hmToMin(a.start) - hmToMin(b.start));

const runningTask = () => todays().find((t) => t.status === "doing") || null;

const elapsedSec = (t) =>
  t.spentSec + (t.status === "doing" && t.startedAt ? (Date.now() - t.startedAt) / 1000 : 0);

const isOver = (t) => elapsedSec(t) > t.estimateMin * 60;

/* 秘書ロジック:いま取り組むべきタスク */
function currentTask() {
  const list = todays();
  return (
    runningTask() ||
    list.filter((t) => t.status !== "done" && hmToMin(t.start) <= nowMin()).pop() ||
    list.find((t) => t.status !== "done") ||
    null
  );
}

/* ---------- アラート ---------- */
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const play = (t, freq) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.4);
    };
    play(0, 880);
    play(0.45, 880);
    play(0.9, 1175);
  } catch (e) {}
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
  } catch (e) {}
}

function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch (e) {}
}

/* ---------- 操作 ---------- */
async function startTask(id) {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  } catch (e) {}
  try {
    if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (e) {}
  lastBeep = 0;
  state.tasks = state.tasks.map((t) => {
    if (t.id === id) return { ...t, status: "doing", startedAt: Date.now() };
    if (t.status === "doing") return { ...t, status: "todo", spentSec: elapsedSec(t), startedAt: null };
    return t;
  });
  save();
  renderAll();
}

function pauseTask(id) {
  state.tasks = state.tasks.map((t) =>
    t.id === id ? { ...t, status: "todo", spentSec: elapsedSec(t), startedAt: null } : t
  );
  releaseWake();
  save();
  renderAll();
}

function finishTask(id) {
  state.tasks = state.tasks.map((t) =>
    t.id === id ? { ...t, status: "done", spentSec: elapsedSec(t), startedAt: null } : t
  );
  releaseWake();
  save();
  renderAll();
}

function removeTask(id) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  save();
  renderAll();
}

function releaseWake() {
  if (wakeLock && !runningTask()) {
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
}

function addTask(title, start, estimateMin) {
  state.tasks.push({
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    date: todayKey(),
    title: title.trim(),
    start,
    estimateMin: Math.max(1, Number(estimateMin) || 25),
    status: "todo",
    spentSec: 0,
    startedAt: null,
  });
  save();
  renderAll();
}

/* ---------- 描画 ---------- */
function renderHeader() {
  const d = new Date();
  const youbi = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  document.getElementById("date-label").textContent = `${d.getMonth() + 1}月${d.getDate()}日(${youbi})`;

  const list = todays();
  const rest = list.filter((t) => t.status !== "done").reduce((s, t) => s + t.estimateMin, 0);
  const done = list.filter((t) => t.status === "done").length;
  document.getElementById("stats").innerHTML =
    `<div>残り見積 ${Math.floor(rest / 60)}時間${rest % 60}分</div><div>完了 ${done} / ${list.length}</div>`;
}

function renderHero() {
  const hero = document.getElementById("hero");
  const cur = currentTask();
  if (!cur) {
    const has = todays().length > 0;
    hero.innerHTML = `<div class="empty-card">${
      has
        ? "今日のタスクはすべて完了しました 🎉<br><small>おつかれさまでした</small>"
        : "今日のタスクはまだありません。<br><small>下の「+ タスクを追加」から今日の予定を登録しましょう</small>"
    }</div>`;
    document.body.classList.remove("overrun");
    return;
  }

  const run = runningTask();
  const mine = run && run.id === cur.id;
  const over = mine && isOver(cur);
  document.body.classList.toggle("overrun", !!over);

  const eyebrow = over ? "⚠ 見積時間を超過しています" : mine ? "作業中" : "次にやること";
  const buttons = mine
    ? `<button class="btn solid" data-action="finish" data-id="${cur.id}">完了にする</button>
       <button class="btn" data-action="pause" data-id="${cur.id}">中断</button>`
    : `<button class="btn solid" data-action="start" data-id="${cur.id}">作業を開始</button>`;

  hero.innerHTML = `
    <div class="hero ${over ? "overrun" : ""}">
      <div class="hero-eyebrow">${eyebrow}</div>
      <div class="hero-title">${esc(cur.title)}</div>
      <div class="hero-meta">${cur.start} 開始予定 ・ 見積 ${cur.estimateMin}分</div>
      <div class="timer-row">
        <div class="timer-digits" id="timer-digits">${fmtDur(elapsedSec(cur))}</div>
        <div class="timer-est">/ ${cur.estimateMin}:00</div>
      </div>
      <div class="bar"><div class="bar-fill" id="timer-bar"></div></div>
      <div class="btn-row">${buttons}</div>
      ${over ? `<div class="overrun-note">切り上げて次の短いタスクに移ることを検討しましょう。続ける場合はこのままで構いません。</div>` : ""}
    </div>`;
  updateTimerVisuals(cur);
}

function renderTimeline() {
  const box = document.getElementById("timeline");
  const list = todays();
  const cur = currentTask();
  if (!list.length) {
    box.innerHTML = `<div class="t-sub" style="padding:8px 0 24px;">タスクを追加するとここに表示されます</div>`;
    return;
  }
  box.innerHTML = list
    .map((t) => {
      const done = t.status === "done";
      const active = cur && cur.id === t.id;
      const past = !done && hmToMin(t.start) + t.estimateMin < nowMin();
      const spent = t.spentSec > 5 ? ` ・ 実績 ${fmtDur(elapsedSec(t))}` : "";
      const actions = done
        ? `<button class="sbtn muted" data-action="remove" data-id="${t.id}">削除</button>`
        : `${active ? "" : `<button class="sbtn" data-action="start" data-id="${t.id}">開始</button>`}
           <button class="sbtn muted" data-action="finish" data-id="${t.id}">完了</button>`;
      return `
        <div class="t-item ${done ? "done" : ""} ${active ? "active" : ""}">
          <div class="t-time">${t.start}</div>
          <div class="t-dot"></div>
          <div class="t-card">
            <div class="t-main">
              <div class="t-title">${esc(t.title)}</div>
              <div class="t-sub">見積 ${t.estimateMin}分${spent}${past ? " ・ 予定時刻を過ぎています" : ""}</div>
            </div>
            <div class="t-actions">${actions}</div>
          </div>
        </div>`;
    })
    .join("");
}

function renderAll() {
  const cur = currentTask();
  renderedCurrentId = cur ? cur.id : null;
  const run = runningTask();
  renderedOverrun = !!(run && isOver(run));
  renderHeader();
  renderHero();
  renderTimeline();
}

function updateTimerVisuals(cur) {
  const run = runningTask();
  const digits = document.getElementById("timer-digits");
  const bar = document.getElementById("timer-bar");
  if (!cur || !digits || !bar) return;
  const el = elapsedSec(cur);
  digits.textContent = fmtDur(el);
  bar.style.width = `${Math.min(100, (el / (cur.estimateMin * 60)) * 100)}%`;
}

/* ---------- 毎秒の処理 ---------- */
function tick() {
  const cur = currentTask();
  const curId = cur ? cur.id : null;
  const run = runningTask();
  const over = !!(run && isOver(run));

  // 「いま」のタスクや超過状態が変わったら全体を描き直す
  if (curId !== renderedCurrentId || over !== renderedOverrun) {
    renderAll();
  } else {
    updateTimerVisuals(cur);
  }

  // 超過アラート(60秒ごとに再通知)
  if (run && over && Date.now() - lastBeep > 60000) {
    lastBeep = Date.now();
    beep();
    notify("見積時間を超過しました", `「${run.title}」を切り上げるか、続行するか選んでください`);
  }
}

/* ---------- イベント ---------- */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === "start") startTask(id);
  else if (action === "pause") pauseTask(id);
  else if (action === "finish") finishTask(id);
  else if (action === "remove") removeTask(id);
  else if (action === "add-open") {
    document.getElementById("add-form").classList.remove("hidden");
    document.getElementById("fab").classList.add("hidden");
    document.getElementById("f-start").value = nowHM();
    document.getElementById("f-title").focus();
  } else if (action === "add-cancel") {
    document.getElementById("add-form").classList.add("hidden");
    document.getElementById("fab").classList.remove("hidden");
  } else if (action === "settings-open") {
    const panel = document.getElementById("settings");
    panel.classList.remove("hidden");
    document.getElementById("s-url").value = localStorage.getItem(SYNC_URL_KEY) || "";
    document.getElementById("s-token").value = localStorage.getItem(SYNC_TOKEN_KEY) || "";
    document.getElementById("settings-msg").textContent = "";
    panel.scrollIntoView({ behavior: "smooth" });
  } else if (action === "settings-close") {
    document.getElementById("settings").classList.add("hidden");
  } else if (action === "settings-save") {
    const url = document.getElementById("s-url").value.trim();
    const token = document.getElementById("s-token").value.trim();
    if (url && !url.startsWith("https://script.google.com/")) {
      document.getElementById("settings-msg").textContent =
        "URLは https://script.google.com/ で始まるものを貼り付けてください";
      return;
    }
    localStorage.setItem(SYNC_URL_KEY, url);
    localStorage.setItem(SYNC_TOKEN_KEY, token);
    document.getElementById("settings-msg").textContent = url
      ? "保存しました。「今すぐ同期」で動作を確認できます"
      : "同期設定を削除しました";
    setSyncMsg(syncStatusLabel());
  } else if (action === "sync-now") {
    doSync(true);
  } else if (action === "add-confirm") {
    const title = document.getElementById("f-title").value;
    if (!title.trim()) return;
    addTask(title, document.getElementById("f-start").value || nowHM(), document.getElementById("f-est").value);
    document.getElementById("f-title").value = "";
    document.getElementById("add-form").classList.add("hidden");
    document.getElementById("fab").classList.remove("hidden");
  }
});

/* 画面復帰時にWake Lockを取り直す(iOSはバックグラウンドで解除されるため) */
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && runningTask() && navigator.wakeLock && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
  }
  if (document.visibilityState === "visible") renderAll();
});

/* ---------- 起動 ---------- */
load();
renderAll();
setSyncMsg(syncStatusLabel());
if (syncConfigured() && localStorage.getItem(DIRTY_KEY) === "1") doSync(false);
setInterval(tick, 1000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
