/* ============================================================
   今日の秘書 — app.js(フェーズ4)
   データ構造 v3:
     issues:      課題 [{id, title, purpose, deadline, targets:[{rank,text}]}]
     tasks:       タスク原本 [{id, title, parentId, issueId, type,
                   estimateMin, defStart, planStart, planEnd,
                   recurrence, done, createdDate}]
     assignments: 日々への割り当て(今日画面の実体)
     skips:       周期タスクの自動予定を外した日 [{taskId, date}]
     updatedAt:   最終更新時刻(双方向同期の勝敗判定に使用)
   ============================================================ */

const STORE_KEY = "hisho:data:v1";

const pad = (n) => String(n).padStart(2, "0");
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dkOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const hmToMin = (hm) => {
  const [h, m] = String(hm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
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
const fmtH = (min) => (min >= 60 ? `${Math.round(min / 6) / 10}h` : `${min}分`);
const addDays = (dk, n) => {
  const d = new Date(dk + "T00:00:00");
  d.setDate(d.getDate() + n);
  return dkOf(d.getFullYear(), d.getMonth(), d.getDate());
};
const diffDays = (a, b) =>
  Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const ISSUE_COLORS = ["#0E7C66", "#3D5A9E", "#B0692B", "#8A4E9E", "#3F7A3F", "#A8455C"];

/* ---------- 状態 ---------- */
let state = { v: 3, updatedAt: 0, issues: [], tasks: [], assignments: [], skips: [] };
let wakeLock = null;
let lastBeep = 0;
let renderedCurrentId = null;
let renderedOverrun = false;
let view = "today";
let editingTaskId = null;
let editingIssueId = null;
let editingAsgId = null;
let selDate = todayKey();
let gStart = addDays(todayKey(), -7);
const G_DAYS = 42;
const G_COLW = 26;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {
    console.error("読み込みに失敗しました", e);
  }
  if (!state || typeof state !== "object") state = { v: 3, updatedAt: 0, issues: [], tasks: [], assignments: [], skips: [] };
  migrate();
}

function migrate() {
  if (!state.v || state.v < 2) {
    const old = Array.isArray(state.tasks) ? state.tasks : [];
    state = {
      v: 2,
      goals: [],
      tasks: [],
      assignments: old.map((t) => ({
        id: "a_" + (t.id || uid("m")),
        taskId: null,
        title: t.title || "",
        date: t.date || todayKey(),
        start: t.start || "09:00",
        estimateMin: t.estimateMin || 25,
        status: t.status || "todo",
        spentSec: t.spentSec || 0,
        startedAt: t.startedAt || null,
      })),
    };
  }
  if (state.v < 3) {
    state.issues = (state.goals || []).map((g) => ({
      id: g.id,
      title: g.title,
      purpose: "",
      deadline: null,
      targets: [],
    }));
    delete state.goals;
    (state.tasks || []).forEach((t) => {
      if (t.goalId !== undefined) {
        t.issueId = t.goalId || null;
        delete t.goalId;
      }
    });
    state.skips = [];
    state.v = 3;
  }
  if (!Array.isArray(state.issues)) state.issues = [];
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!Array.isArray(state.assignments)) state.assignments = [];
  if (!Array.isArray(state.skips)) state.skips = [];
  if (!state.updatedAt) state.updatedAt = 0;
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("保存に失敗しました", e);
  }
}

function save() {
  state.updatedAt = Date.now();
  persist();
  localStorage.setItem(DIRTY_KEY, "1");
  scheduleSync();
}

/* ---------- 参照ヘルパー ---------- */
const taskById = (id) => state.tasks.find((t) => t.id === id) || null;
const issueById = (id) => state.issues.find((g) => g.id === id) || null;
const issueColor = (id) => {
  const i = state.issues.findIndex((g) => g.id === id);
  return i >= 0 ? ISSUE_COLORS[i % ISSUE_COLORS.length] : "#0E7C66";
};
const asgTitle = (a) => {
  const t = a.taskId ? taskById(a.taskId) : null;
  return t ? t.title : a.title;
};
const hasSkip = (taskId, dk) => state.skips.some((s) => s.taskId === taskId && s.date === dk);

const todays = () =>
  state.assignments
    .filter((a) => a.date === todayKey())
    .sort((x, y) => hmToMin(x.start) - hmToMin(y.start));

const runningAsg = () => todays().find((a) => a.status === "doing") || null;

const elapsedSec = (a) =>
  a.spentSec + (a.status === "doing" && a.startedAt ? (Date.now() - a.startedAt) / 1000 : 0);

const isOver = (a) => elapsedSec(a) > a.estimateMin * 60;

function currentAsg() {
  const list = todays();
  return (
    runningAsg() ||
    list.filter((a) => a.status !== "done" && hmToMin(a.start) <= nowMin()).pop() ||
    list.find((a) => a.status !== "done") ||
    null
  );
}

/* ---------- 周期タスク ---------- */
function occursOn(task, dateKey) {
  const r = task.recurrence;
  if (!r) return false;
  const d = new Date(dateKey + "T00:00:00");
  if (r.kind === "everyNDays") {
    const anchor = new Date((r.anchor || task.createdDate || dateKey) + "T00:00:00");
    const diff = Math.round((d - anchor) / 86400000);
    return diff >= 0 && r.n > 0 && diff % r.n === 0;
  }
  if (r.kind === "weekly") return Array.isArray(r.weekdays) && r.weekdays.includes(d.getDay());
  if (r.kind === "monthly") return d.getDate() === r.day;
  if (r.kind === "yearly") return d.getMonth() + 1 === r.month && d.getDate() === r.day;
  return false;
}

function recurrenceLabel(task) {
  const r = task.recurrence;
  if (!r) return "1回限り";
  const W = "日月火水木金土";
  if (r.kind === "everyNDays") return `${r.n}日ごと`;
  if (r.kind === "weekly") return `毎週${(r.weekdays || []).map((d) => W[d]).join("・")}曜`;
  if (r.kind === "monthly") return `毎月${r.day}日`;
  if (r.kind === "yearly") return `毎年${r.month}月${r.day}日`;
  return "周期";
}

function materializeToday() {
  const dk = todayKey();
  let changed = false;
  state.tasks
    .filter((t) => t.type === "recurring" && occursOn(t, dk) && !hasSkip(t.id, dk))
    .forEach((t) => {
      const exists = state.assignments.some((a) => a.taskId === t.id && a.date === dk);
      if (!exists) {
        state.assignments.push({
          id: uid("a"),
          taskId: t.id,
          title: t.title,
          date: dk,
          start: t.defStart || "09:00",
          estimateMin: t.estimateMin || 25,
          status: "todo",
          spentSec: 0,
          startedAt: null,
        });
        changed = true;
      }
    });
  if (changed) save();
}

/* その日の項目:実際の割り当て + 周期タスクの自動予定(今日以降・スキップ除く) */
function dayItems(dk) {
  const real = state.assignments.filter((a) => a.date === dk);
  const virt =
    dk >= todayKey()
      ? state.tasks
          .filter(
            (t) =>
              t.type === "recurring" &&
              occursOn(t, dk) &&
              !hasSkip(t.id, dk) &&
              !real.some((a) => a.taskId === t.id)
          )
          .map((t) => ({
            virtual: true,
            taskId: t.id,
            title: t.title,
            start: t.defStart || "09:00",
            estimateMin: t.estimateMin || 25,
            status: "todo",
          }))
      : [];
  return real.concat(virt).sort((x, y) => hmToMin(x.start) - hmToMin(y.start));
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

/* ---------- 今日:操作 ---------- */
async function startAsg(id) {
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
  state.assignments = state.assignments.map((a) => {
    if (a.id === id) return { ...a, status: "doing", startedAt: Date.now() };
    if (a.status === "doing") return { ...a, status: "todo", spentSec: elapsedSec(a), startedAt: null };
    return a;
  });
  save();
  renderAll();
}

function pauseAsg(id) {
  state.assignments = state.assignments.map((a) =>
    a.id === id ? { ...a, status: "todo", spentSec: elapsedSec(a), startedAt: null } : a
  );
  releaseWake();
  save();
  renderAll();
}

function finishAsg(id) {
  state.assignments = state.assignments.map((a) =>
    a.id === id ? { ...a, status: "done", spentSec: elapsedSec(a), startedAt: null } : a
  );
  const a = state.assignments.find((x) => x.id === id);
  if (a && a.taskId) {
    const t = taskById(a.taskId);
    if (t && t.type === "single") t.done = true;
  }
  releaseWake();
  save();
  renderAll();
}

/* 完了の取り消し */
function reopenAsg(id) {
  const a = state.assignments.find((x) => x.id === id);
  if (!a) return;
  a.status = "todo";
  if (a.taskId) {
    const t = taskById(a.taskId);
    if (t && t.type === "single") t.done = false;
  }
  save();
  renderAll();
}

function removeAsg(id) {
  state.assignments = state.assignments.filter((a) => a.id !== id);
  save();
  renderAll();
}

function releaseWake() {
  if (wakeLock && !runningAsg()) {
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
}

function addAdhoc(title, start, estimateMin) {
  state.assignments.push({
    id: uid("a"),
    taskId: null,
    title: title.trim(),
    date: todayKey(),
    start,
    estimateMin: Math.max(1, Number(estimateMin) || 25),
    status: "todo",
    spentSec: 0,
    startedAt: null,
  });
  save();
  renderAll();
}

/* ---------- 課題 ---------- */
function removeIssue(id) {
  state.issues = state.issues.filter((g) => g.id !== id);
  state.tasks.forEach((t) => { if (t.issueId === id) t.issueId = null; });
  save();
  renderPlan();
}

/* ---------- タスク原本 ---------- */
function descendants(id, acc) {
  acc = acc || new Set();
  state.tasks.filter((t) => t.parentId === id).forEach((c) => {
    acc.add(c.id);
    descendants(c.id, acc);
  });
  return acc;
}

function removeTaskDef(id) {
  const t = taskById(id);
  if (!t) return;
  state.tasks.forEach((c) => { if (c.parentId === id) c.parentId = t.parentId || null; });
  state.tasks = state.tasks.filter((x) => x.id !== id);
  state.assignments.forEach((a) => { if (a.taskId === id) { a.title = t.title; a.taskId = null; } });
  state.skips = state.skips.filter((s) => s.taskId !== id);
  save();
  renderPlan();
}

/* タスクの有効期間(子からのロールアップ) */
function effPeriod(t) {
  let s = t.planStart || null;
  let e = t.planEnd || null;
  state.tasks
    .filter((c) => c.parentId === t.id)
    .forEach((c) => {
      const p = effPeriod(c);
      if (p.s && (!s || p.s < s)) s = p.s;
      if (p.e && (!e || p.e > e)) e = p.e;
    });
  if (s && !e) e = s;
  if (e && !s) s = e;
  return { s, e };
}

/* 進捗率:配下(自身含む)の単発タスクの見積時間ベース */
function progressOf(t) {
  const ids = descendants(t.id);
  ids.add(t.id);
  const singles = state.tasks.filter((x) => ids.has(x.id) && x.type === "single");
  const total = singles.reduce((s, x) => s + (x.estimateMin || 0), 0);
  if (!total) return null;
  const done = singles.filter((x) => x.done).reduce((s, x) => s + (x.estimateMin || 0), 0);
  return Math.round((done / total) * 100);
}

/* ---------- 画面切替 ---------- */
function switchView(v) {
  view = v;
  document.body.dataset.view = v;
  document.querySelectorAll(".tab").forEach((el) =>
    el.classList.toggle("active", el.dataset.tab === v)
  );
  document.getElementById("view-today").classList.toggle("hidden", v !== "today");
  document.getElementById("view-gantt").classList.toggle("hidden", v !== "gantt");
  document.getElementById("view-plan").classList.toggle("hidden", v !== "plan");
  renderAll();
}

/* ---------- 描画:共通ヘッダー ---------- */
function renderHeader() {
  const d = new Date();
  const youbi = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  document.getElementById("date-label").textContent = `${d.getMonth() + 1}月${d.getDate()}日(${youbi})`;
  const list = todays();
  const rest = list.filter((a) => a.status !== "done").reduce((s, a) => s + a.estimateMin, 0);
  const done = list.filter((a) => a.status === "done").length;
  document.getElementById("stats").innerHTML =
    `<div>残り見積 ${Math.floor(rest / 60)}時間${rest % 60}分</div><div>完了 ${done} / ${list.length}</div>`;
}

/* ---------- 描画:今日 ---------- */
function renderHero() {
  const hero = document.getElementById("hero");
  const cur = currentAsg();
  if (!cur) {
    const has = todays().length > 0;
    hero.innerHTML = `<div class="empty-card">${
      has
        ? "今日のタスクはすべて完了しました 🎉<br><small>おつかれさまでした</small>"
        : "今日のタスクはまだありません。<br><small>「+ タスクを追加」か、ガントで日付マスをタップして割り当てましょう</small>"
    }</div>`;
    document.body.classList.remove("overrun");
    return;
  }
  const run = runningAsg();
  const mine = run && run.id === cur.id;
  const over = mine && isOver(cur);
  document.body.classList.toggle("overrun", !!over);

  const t = cur.taskId ? taskById(cur.taskId) : null;
  const issue = t && t.issueId ? issueById(t.issueId) : null;
  const chip = issue
    ? `<span class="goal-chip" style="background:${issueColor(issue.id)}22;color:${issueColor(issue.id)}">${esc(issue.title)}</span>`
    : "";

  const eyebrow = over ? "⚠ 見積時間を超過しています" : mine ? "作業中" : "次にやること";
  const buttons = mine
    ? `<button class="btn solid" data-action="finish" data-id="${cur.id}">完了にする</button>
       <button class="btn" data-action="pause" data-id="${cur.id}">中断</button>`
    : `<button class="btn solid" data-action="start" data-id="${cur.id}">作業を開始</button>`;

  hero.innerHTML = `
    <div class="hero ${over ? "overrun" : ""}">
      <div class="hero-eyebrow">${eyebrow}</div>
      <div class="hero-title">${chip}${esc(asgTitle(cur))}</div>
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
  const cur = currentAsg();
  if (!list.length) {
    box.innerHTML = `<div class="t-sub" style="padding:8px 0 24px;">タスクを追加するとここに表示されます</div>`;
    return;
  }
  box.innerHTML = list
    .map((a) => {
      const done = a.status === "done";
      const active = cur && cur.id === a.id;
      const past = !done && hmToMin(a.start) + a.estimateMin < nowMin();
      const spent = a.spentSec > 5 ? ` ・ 実績 ${fmtDur(elapsedSec(a))}` : "";
      const t = a.taskId ? taskById(a.taskId) : null;
      const rec = t && t.type === "recurring" ? " ・ 🔁" : "";
      const actions = done
        ? `<button class="sbtn" data-action="reopen" data-id="${a.id}">戻す</button>
           <button class="sbtn muted" data-action="remove" data-id="${a.id}">削除</button>`
        : `${active ? "" : `<button class="sbtn" data-action="start" data-id="${a.id}">開始</button>`}
           <button class="sbtn muted" data-action="finish" data-id="${a.id}">完了</button>`;
      return `
        <div class="t-item ${done ? "done" : ""} ${active ? "active" : ""}">
          <div class="t-time">${a.start}</div>
          <div class="t-dot"></div>
          <div class="t-card">
            <div class="t-main">
              <div class="t-title">${esc(asgTitle(a))}</div>
              <div class="t-sub">見積 ${a.estimateMin}分${spent}${rec}${past ? " ・ 予定時刻を過ぎています" : ""}</div>
            </div>
            <div class="t-actions">${actions}</div>
          </div>
        </div>`;
    })
    .join("");
}

/* ---------- 描画:統合ガント(計画モード) ---------- */
function renderGantt() {
  const box = document.getElementById("gantt");
  if (!state.tasks.length) {
    box.innerHTML = `<div class="g-empty">課題タブでタスクを登録すると、ここで日付マスをタップして割り当てられます。</div>`;
    renderDayDetail();
    return;
  }
  const days = [...Array(G_DAYS)].map((_, i) => addDays(gStart, i));
  const tk = todayKey();
  const trackW = G_DAYS * G_COLW;

  const colX = (i) => i * G_COLW;
  const weCols = days
    .map((dk, i) => {
      const wd = new Date(dk + "T00:00:00").getDay();
      return wd === 0 || wd === 6
        ? `<div class="g-we-col" style="left:${colX(i)}px;width:${G_COLW}px"></div>`
        : "";
    })
    .join("");
  const tdIdx = days.indexOf(tk);
  const todayLine = tdIdx >= 0 ? `<div class="g-today-line" style="left:${colX(tdIdx)}px"></div>` : "";

  /* 日付ヘッダー行(絶対配置でマスと完全一致させる) */
  const hcells = days
    .map((dk, i) => {
      const d = new Date(dk + "T00:00:00");
      const wd = d.getDay();
      const mon = d.getDate() === 1 || i === 0 ? `${d.getMonth() + 1}月` : "&nbsp;";
      return `<button class="g-hcell2 ${wd === 0 || wd === 6 ? "we" : ""} ${dk === tk ? "td" : ""} ${dk === selDate ? "sel" : ""}"
        style="left:${colX(i)}px;width:${G_COLW}px" data-action="g-selday" data-date="${dk}">
        <span class="g-mon2">${mon}</span>${d.getDate()}</button>`;
    })
    .join("");

  /* 見積合計行 */
  const totals = days.map((dk) => dayItems(dk).reduce((s, x) => s + (x.estimateMin || 0), 0));
  const heat = (min) => {
    if (min <= 0) return "transparent";
    if (min <= 120) return "#EAF4F1";
    if (min <= 240) return "#D2E9E2";
    if (min <= 360) return "#B5DCD0";
    return "#F6D9D3";
  };
  const sumCells = days
    .map((dk, i) => {
      const m = totals[i];
      return `<button class="g-sum-cell" style="left:${colX(i) + 1}px;width:${G_COLW - 2}px;background:${heat(m)}"
        data-action="g-selday" data-date="${dk}">${m ? fmtH(m).replace("分", "m") : ""}</button>`;
    })
    .join("");

  /* タスク行 */
  const rows = [];
  const walk = (parentId, depth) => {
    state.tasks
      .filter((t) => (t.parentId || null) === parentId)
      .forEach((t) => {
        const children = state.tasks.filter((c) => c.parentId === t.id);
        const color = t.issueId ? issueColor(t.issueId) : "#0E7C66";
        const prog = depth === 0 ? progressOf(t) : null;
        const p = t.type === "recurring" ? { s: null, e: null } : effPeriod(t);

        let bar = "";
        if (p.s && p.e && p.e >= days[0] && p.s <= days[days.length - 1]) {
          const s = p.s < days[0] ? days[0] : p.s;
          const e = p.e > days[days.length - 1] ? days[days.length - 1] : p.e;
          const left = diffDays(s, days[0]) * G_COLW + 2;
          const width = (diffDays(e, s) + 1) * G_COLW - 4;
          bar = `<div class="g-bar ${children.length ? "parent" : ""}" style="left:${left}px;width:${width}px;background:${color}" title="${esc(t.title)} ${p.s}〜${p.e}"></div>`;
        }

        const cells = days
          .map((dk, i) => {
            const real = state.assignments.find((a) => a.taskId === t.id && a.date === dk);
            const virt =
              !real &&
              t.type === "recurring" &&
              dk >= tk &&
              occursOn(t, dk) &&
              !hasSkip(t.id, dk);
            let mark = "";
            if (real) {
              mark =
                real.status === "done"
                  ? `<span class="mark done-m">✓</span>`
                  : `<span class="mark todo-m">●</span>`;
            } else if (virt) {
              mark = `<span class="mark virt-m">🔁</span>`;
            }
            return `<button class="g-cell" style="left:${colX(i)}px;width:${G_COLW}px"
              data-action="g-cell" data-task="${t.id}" data-date="${dk}">${mark}</button>`;
          })
          .join("");

        const rec = t.type === "recurring" ? "🔁 " : "";
        rows.push(`
          <div class="g-row">
            <div class="g-label ${t.done ? "done-task" : ""}" style="padding-left:${10 + depth * 14}px">
              <span class="g-name">${rec}${esc(t.title)}</span>
              ${prog !== null ? `<span class="g-prog">${prog}%</span>` : ""}
            </div>
            <div class="g-track" style="width:${trackW}px">${weCols}${todayLine}${bar}${cells}</div>
          </div>`);
        walk(t.id, depth + 1);
      });
  };
  walk(null, 0);

  box.innerHTML = `
    <div class="g-inner">
      <div class="g-hrow">
        <div class="g-label" style="font-weight:700;color:var(--muted);font-size:11px;">タスク</div>
        <div class="g-track" style="width:${trackW}px;height:30px;">${hcells}</div>
      </div>
      <div class="g-row">
        <div class="g-label" style="font-size:11px;color:var(--muted);">見積合計</div>
        <div class="g-track" style="width:${trackW}px;height:22px;">${sumCells}</div>
      </div>
      ${rows.join("")}
    </div>`;
  renderDayDetail();
}

/* マスのタップ:割り当てのオン/オフ */
function toggleCell(taskId, dk) {
  const t = taskById(taskId);
  if (!t) return;
  const real = state.assignments.find((a) => a.taskId === taskId && a.date === dk);
  if (real) {
    if ((real.status === "done" || real.spentSec > 5) &&
        !confirm("実績が記録されています。この割り当てを取り消しますか?")) return;
    state.assignments = state.assignments.filter((a) => a.id !== real.id);
    if (t.type === "recurring" && dk >= todayKey() && occursOn(t, dk)) {
      state.skips.push({ taskId, date: dk }); // 自動予定も出ないようにする
    }
  } else if (t.type === "recurring" && dk >= todayKey() && occursOn(t, dk)) {
    if (hasSkip(taskId, dk)) {
      state.skips = state.skips.filter((s) => !(s.taskId === taskId && s.date === dk)); // 自動予定を復活
    } else {
      state.skips.push({ taskId, date: dk }); // 自動予定をオフ
    }
  } else {
    state.assignments.push({
      id: uid("a"),
      taskId,
      title: t.title,
      date: dk,
      start: t.defStart || "09:00",
      estimateMin: t.estimateMin || 25,
      status: "todo",
      spentSec: 0,
      startedAt: null,
    });
  }
  save();
  renderGantt();
}

/* ---------- 日別詳細 ---------- */
function renderDayDetail() {
  const box = document.getElementById("day-detail");
  const d = new Date(selDate + "T00:00:00");
  const youbi = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  const items = dayItems(selDate);
  const total = items.reduce((s, i) => s + (i.estimateMin || 0), 0);
  const jp = { todo: "未着手", doing: "作業中", done: "完了" };

  const rows = items.length
    ? items
        .map((i) => {
          const t = i.taskId ? taskById(i.taskId) : null;
          const issue = t && t.issueId ? issueById(t.issueId) : null;
          const chip = issue
            ? `<span class="goal-chip" style="background:${issueColor(issue.id)}22;color:${issueColor(issue.id)}">${esc(issue.title)}</span>`
            : "";
          const actions = i.virtual
            ? `<span class="virtual-tag">🔁 自動</span>
               <button class="sbtn muted" data-action="asg-fix" data-task="${i.taskId}" data-date="${selDate}">時間調整</button>`
            : `<button class="sbtn muted" data-action="asg-edit" data-id="${i.id}">編集</button>`;
          return `
          <div class="p-row">
            <div class="p-main">
              <div class="p-title">${chip}${esc(i.virtual ? i.title : asgTitle(i))}</div>
              <div class="p-sub">${i.start} ・ 見積 ${i.estimateMin}分 ・ ${jp[i.status] || ""}${i.spentSec > 5 ? ` ・ 実績 ${fmtDur(i.spentSec)}` : ""}</div>
            </div>
            <div class="p-actions">${actions}</div>
          </div>`;
        })
        .join("")
    : `<div class="plan-empty">この日の割り当てはまだありません。上のマスをタップするか「+ 割り当て」から追加できます。</div>`;

  box.innerHTML = `
    <div class="plan-head">
      <h2 class="section-label">${d.getMonth() + 1}月${d.getDate()}日(${youbi}) 合計 ${fmtH(total)}</h2>
      <button class="sbtn" data-action="asg-add">+ 割り当て</button>
    </div>
    ${rows}`;
}

/* ---------- 割り当てフォーム ---------- */
function fillAsgTaskSelect() {
  const sel = document.getElementById("a-task");
  const options = [];
  const walk = (parentId, depth) => {
    state.tasks
      .filter((t) => (t.parentId || null) === parentId)
      .forEach((t) => {
        if (!(t.type === "single" && t.done)) {
          options.push(`<option value="${t.id}">${"　".repeat(depth)}${esc(t.title)}</option>`);
        }
        walk(t.id, depth + 1);
      });
  };
  walk(null, 0);
  sel.innerHTML = `<option value="">(直接入力する)</option>` + options.join("");
}

function openAsgForm(dk, asg) {
  editingAsgId = asg ? asg.id : null;
  fillAsgTaskSelect();
  document.getElementById("asg-form-title").textContent = asg ? "割り当てを編集" : "タスクを割り当て";
  document.getElementById("a-task").value = asg ? asg.taskId || "" : "";
  document.getElementById("a-title").value = asg && !asg.taskId ? asg.title : "";
  document.getElementById("a-date").value = asg ? asg.date : dk;
  document.getElementById("a-start").value = asg ? asg.start : "09:00";
  document.getElementById("a-est").value = asg ? asg.estimateMin : 25;
  document.getElementById("asg-delete-row").classList.toggle("hidden", !asg);
  updateAsgTitleVisibility();
  const form = document.getElementById("asg-form");
  form.classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth" });
}

function updateAsgTitleVisibility() {
  const hasTask = !!document.getElementById("a-task").value;
  document.getElementById("a-title").classList.toggle("hidden", hasTask);
}

function saveAsgForm() {
  const taskId = document.getElementById("a-task").value || null;
  const title = document.getElementById("a-title").value.trim();
  if (!taskId && !title) return;
  const date = document.getElementById("a-date").value || selDate;
  const start = document.getElementById("a-start").value || "09:00";
  const est = Math.max(1, Number(document.getElementById("a-est").value) || 25);

  if (editingAsgId) {
    const a = state.assignments.find((x) => x.id === editingAsgId);
    if (a) {
      a.taskId = taskId;
      a.title = taskId ? (taskById(taskId) || {}).title || a.title : title;
      a.date = date;
      a.start = start;
      a.estimateMin = est;
    }
  } else {
    state.assignments.push({
      id: uid("a"),
      taskId,
      title: taskId ? (taskById(taskId) || {}).title || "" : title,
      date,
      start,
      estimateMin: est,
      status: "todo",
      spentSec: 0,
      startedAt: null,
    });
  }
  editingAsgId = null;
  document.getElementById("asg-form").classList.add("hidden");
  selDate = date;
  save();
  renderGantt();
}

function fixVirtual(taskId, dk) {
  const t = taskById(taskId);
  if (!t) return;
  const a = {
    id: uid("a"),
    taskId: t.id,
    title: t.title,
    date: dk,
    start: t.defStart || "09:00",
    estimateMin: t.estimateMin || 25,
    status: "todo",
    spentSec: 0,
    startedAt: null,
  };
  state.assignments.push(a);
  save();
  renderGantt();
  openAsgForm(dk, a);
}

/* ---------- 描画:課題タブ ---------- */
function renderPlan() {
  const list = document.getElementById("issue-list");
  const tk = todayKey();
  list.innerHTML = state.issues.length
    ? state.issues
        .map((g) => {
          const cnt = state.tasks.filter((t) => t.issueId === g.id).length;
          const c = issueColor(g.id);
          let dl = "";
          if (g.deadline) {
            const rest = diffDays(g.deadline, tk);
            const cls = rest < 0 ? "over" : rest <= 7 ? "near" : "";
            const label = rest < 0 ? `期限超過 ${-rest}日` : rest === 0 ? "今日が期日" : `あと${rest}日`;
            dl = `<span class="issue-deadline ${cls}">${g.deadline.replaceAll("-", "/")} ・ ${label}</span>`;
          }
          const targets = (g.targets || [])
            .map(
              (t) =>
                `<div class="issue-target"><span class="rank-chip" style="background:${c}">${esc(t.rank)}</span><span>${esc(t.text)}</span></div>`
            )
            .join("");
          return `
          <div class="issue-card" style="border-left-color:${c}">
            <div class="issue-top">
              <div>
                <div class="issue-title">${esc(g.title)}</div>
                ${g.purpose ? `<div class="issue-purpose">目的: ${esc(g.purpose)}</div>` : ""}
              </div>
              ${dl}
            </div>
            ${targets ? `<div class="issue-targets">${targets}</div>` : ""}
            <div class="issue-foot">
              <div class="p-sub">関連タスク ${cnt}件</div>
              <button class="sbtn muted" data-action="issue-edit" data-id="${g.id}">編集</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="plan-empty">課題を登録すると、目的・目標(S/A/B…)・期日とあわせて管理できます。</div>`;

  /* タスクツリー */
  const tree = document.getElementById("task-tree");
  if (!state.tasks.length) {
    tree.innerHTML = `<div class="plan-empty">タスクの原本をここで管理します。日付への割り当てはガントのマスをタップして行います。</div>`;
    return;
  }
  const renderNode = (t, depth) => {
    const prog = depth === 0 ? progressOf(t) : null;
    const issue = t.issueId ? issueById(t.issueId) : null;
    const chip = issue
      ? `<span class="goal-chip" style="background:${issueColor(issue.id)}22;color:${issueColor(issue.id)}">${esc(issue.title)}</span>`
      : "";
    const children = state.tasks.filter((c) => c.parentId === t.id);
    const row = `
      <div class="p-row" style="margin-left:${depth * 18}px;border-left-color:${issue ? issueColor(issue.id) : "transparent"}">
        <div class="p-main">
          <div class="p-title ${t.done ? "done-task" : ""}">${chip}${esc(t.title)}</div>
          <div class="p-sub">${prog !== null ? `進捗 ${prog}% ・ ` : ""}${recurrenceLabel(t)} ・ 見積 ${t.estimateMin}分${children.length ? ` ・ 子タスク ${children.length}件` : ""}</div>
        </div>
        <div class="p-actions">
          <button class="sbtn muted" data-action="task-child" data-id="${t.id}">+子</button>
          <button class="sbtn muted" data-action="task-edit" data-id="${t.id}">編集</button>
        </div>
      </div>`;
    return row + children.map((c) => renderNode(c, depth + 1)).join("");
  };
  tree.innerHTML = state.tasks.filter((t) => !t.parentId).map((t) => renderNode(t, 0)).join("");
}

function renderAll() {
  renderHeader();
  if (view === "today") {
    const cur = currentAsg();
    renderedCurrentId = cur ? cur.id : null;
    const run = runningAsg();
    renderedOverrun = !!(run && isOver(run));
    renderHero();
    renderTimeline();
  } else if (view === "gantt") {
    renderGantt();
  } else {
    renderPlan();
  }
}

function updateTimerVisuals(cur) {
  const digits = document.getElementById("timer-digits");
  const bar = document.getElementById("timer-bar");
  if (!cur || !digits || !bar) return;
  const el = elapsedSec(cur);
  digits.textContent = fmtDur(el);
  bar.style.width = `${Math.min(100, (el / (cur.estimateMin * 60)) * 100)}%`;
}

/* ---------- 課題フォーム ---------- */
function addTargetRow(rank, text) {
  const box = document.getElementById("target-rows");
  const row = document.createElement("div");
  row.className = "target-row";
  row.innerHTML = `
    <input type="text" class="rank" placeholder="S" maxlength="6" value="${esc(rank || "")}">
    <input type="text" class="ttext" placeholder="例: 新規レビュー投稿数 50" maxlength="120" value="${esc(text || "")}">
    <button class="sbtn muted" data-action="target-remove">×</button>`;
  box.appendChild(row);
}

function openIssueForm(issue) {
  editingIssueId = issue ? issue.id : null;
  document.getElementById("issue-form-title").textContent = issue ? "課題を編集" : "課題を追加";
  document.getElementById("i-title").value = issue ? issue.title : "";
  document.getElementById("i-purpose").value = issue ? issue.purpose || "" : "";
  document.getElementById("i-deadline").value = issue ? issue.deadline || "" : "";
  const box = document.getElementById("target-rows");
  box.innerHTML = "";
  const targets = issue && issue.targets && issue.targets.length ? issue.targets : [{ rank: "S", text: "" }, { rank: "A", text: "" }, { rank: "B", text: "" }];
  targets.forEach((t) => addTargetRow(t.rank, t.text));
  document.getElementById("issue-delete-row").classList.toggle("hidden", !issue);
  const form = document.getElementById("issue-form");
  form.classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth" });
  document.getElementById("i-title").focus();
}

function saveIssueForm() {
  const title = document.getElementById("i-title").value.trim();
  if (!title) return;
  const targets = [...document.querySelectorAll("#target-rows .target-row")]
    .map((row) => ({
      rank: row.querySelector(".rank").value.trim(),
      text: row.querySelector(".ttext").value.trim(),
    }))
    .filter((t) => t.text);
  const data = {
    title,
    purpose: document.getElementById("i-purpose").value.trim(),
    deadline: document.getElementById("i-deadline").value || null,
    targets,
  };
  if (editingIssueId) {
    Object.assign(issueById(editingIssueId), data);
  } else {
    state.issues.push({ id: uid("g"), ...data });
  }
  editingIssueId = null;
  document.getElementById("issue-form").classList.add("hidden");
  save();
  renderPlan();
}

/* ---------- タスクフォーム ---------- */
function fillParentGoalSelects(excludeId) {
  const ps = document.getElementById("t-parent");
  const ex = excludeId ? descendants(excludeId) : new Set();
  if (excludeId) ex.add(excludeId);
  ps.innerHTML =
    `<option value="">(なし・最上位)</option>` +
    state.tasks
      .filter((t) => !ex.has(t.id))
      .map((t) => `<option value="${t.id}">${esc(t.title)}</option>`)
      .join("");
  const gs = document.getElementById("t-goal");
  gs.innerHTML =
    `<option value="">(なし)</option>` +
    state.issues.map((g) => `<option value="${g.id}">${esc(g.title)}</option>`).join("");
}

function updateRecVisibility() {
  const type = document.getElementById("t-type").value;
  document.getElementById("rec-block").classList.toggle("hidden", type !== "recurring");
  document.getElementById("period-block").classList.toggle("hidden", type === "recurring");
  const kind = document.getElementById("t-rkind").value;
  document.getElementById("rec-ndays").classList.toggle("hidden", kind !== "everyNDays");
  document.getElementById("rec-weekly").classList.toggle("hidden", kind !== "weekly");
  document.getElementById("rec-monthly").classList.toggle("hidden", kind !== "monthly");
  document.getElementById("rec-yearly").classList.toggle("hidden", kind !== "yearly");
}

function openTaskForm(task, parentId) {
  editingTaskId = task ? task.id : null;
  fillParentGoalSelects(editingTaskId);
  document.getElementById("task-form-title").textContent = task ? "タスクを編集" : "タスクを追加";
  document.getElementById("t-title").value = task ? task.title : "";
  document.getElementById("t-parent").value = task ? task.parentId || "" : parentId || "";
  document.getElementById("t-goal").value = task ? task.issueId || "" : "";
  document.getElementById("t-type").value = task ? task.type : "single";
  document.getElementById("t-est").value = task ? task.estimateMin : 25;
  document.getElementById("t-defstart").value = task ? task.defStart || "09:00" : "09:00";
  document.getElementById("t-pstart").value = task ? task.planStart || "" : "";
  document.getElementById("t-pend").value = task ? task.planEnd || "" : "";
  document.getElementById("t-anchor").value = todayKey();
  const r = task && task.recurrence;
  if (r) {
    document.getElementById("t-rkind").value = r.kind;
    if (r.kind === "everyNDays") {
      document.getElementById("t-rn").value = r.n;
      document.getElementById("t-anchor").value = r.anchor || todayKey();
    }
    if (r.kind === "weekly") {
      document.querySelectorAll("#rec-weekly input").forEach((cb) => {
        cb.checked = (r.weekdays || []).includes(Number(cb.value));
      });
    }
    if (r.kind === "monthly") document.getElementById("t-rday").value = r.day;
    if (r.kind === "yearly") {
      document.getElementById("t-rmonth").value = r.month;
      document.getElementById("t-rmday").value = r.day;
    }
  } else {
    document.querySelectorAll("#rec-weekly input").forEach((cb) => (cb.checked = false));
  }
  document.getElementById("task-delete-row").classList.toggle("hidden", !task);
  updateRecVisibility();
  const form = document.getElementById("task-form");
  form.classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth" });
  document.getElementById("t-title").focus();
}

function readRecurrence() {
  const kind = document.getElementById("t-rkind").value;
  if (kind === "everyNDays") {
    return {
      kind,
      n: Math.max(1, Number(document.getElementById("t-rn").value) || 1),
      anchor: document.getElementById("t-anchor").value || todayKey(),
    };
  }
  if (kind === "weekly") {
    const days = [...document.querySelectorAll("#rec-weekly input:checked")].map((cb) => Number(cb.value));
    return { kind, weekdays: days.length ? days : [new Date().getDay()] };
  }
  if (kind === "monthly") {
    return { kind, day: Math.min(31, Math.max(1, Number(document.getElementById("t-rday").value) || 1)) };
  }
  return {
    kind: "yearly",
    month: Math.min(12, Math.max(1, Number(document.getElementById("t-rmonth").value) || 1)),
    day: Math.min(31, Math.max(1, Number(document.getElementById("t-rmday").value) || 1)),
  };
}

function saveTaskForm() {
  const title = document.getElementById("t-title").value.trim();
  if (!title) return;
  const type = document.getElementById("t-type").value;
  let ps = document.getElementById("t-pstart").value || null;
  let pe = document.getElementById("t-pend").value || null;
  if (ps && pe && pe < ps) { const tmp = ps; ps = pe; pe = tmp; }
  const data = {
    title,
    parentId: document.getElementById("t-parent").value || null,
    issueId: document.getElementById("t-goal").value || null,
    type,
    estimateMin: Math.max(1, Number(document.getElementById("t-est").value) || 25),
    defStart: document.getElementById("t-defstart").value || "09:00",
    planStart: type === "recurring" ? null : ps,
    planEnd: type === "recurring" ? null : pe,
    recurrence: type === "recurring" ? readRecurrence() : null,
  };
  if (editingTaskId) {
    Object.assign(taskById(editingTaskId), data);
  } else {
    state.tasks.push({ id: uid("t"), done: false, createdDate: todayKey(), ...data });
  }
  editingTaskId = null;
  document.getElementById("task-form").classList.add("hidden");
  materializeToday();
  save();
  renderPlan();
}

/* ---------- スプレッドシート同期(双方向) ---------- */
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
  syncTimer = setTimeout(() => pushSync(false), 4000);
}

function readablePayload() {
  return {
    issues: state.issues.map((g) => ({
      id: g.id,
      title: g.title,
      purpose: g.purpose || "",
      deadline: g.deadline || "",
      targets: (g.targets || []).map((t) => `${t.rank}: ${t.text}`).join("\n"),
    })),
    tasks: state.tasks.map((t) => {
      const p = t.parentId ? taskById(t.parentId) : null;
      const g = t.issueId ? issueById(t.issueId) : null;
      const prog = progressOf(t);
      return {
        id: t.id,
        title: t.title,
        parent: p ? p.title : "",
        issue: g ? g.title : "",
        kind: recurrenceLabel(t),
        estimateMin: t.estimateMin,
        defStart: t.defStart || "",
        pstart: t.planStart || "",
        pend: t.planEnd || "",
        progress: prog === null ? "" : prog,
        done: t.type === "single" ? (t.done ? "完了" : "未完了") : "",
      };
    }),
    assignments: state.assignments.map((a) => ({
      id: a.id,
      date: a.date,
      title: asgTitle(a),
      start: a.start,
      estimateMin: a.estimateMin,
      status: a.status,
      spentSec: a.spentSec + (a.status === "doing" && a.startedAt ? (Date.now() - a.startedAt) / 1000 : 0),
    })),
  };
}

/* シートから読み込み(取得) */
async function pullSync() {
  const url = localStorage.getItem(SYNC_URL_KEY);
  const token = encodeURIComponent(localStorage.getItem(SYNC_TOKEN_KEY) || "");
  const res = await fetch(`${url}?mode=pull&token=${token}`);
  const data = await res.json();
  if (!data || !data.ok) throw new Error((data && data.error) || "取得エラー");
  if (data.state && (data.updatedAt || 0) > (state.updatedAt || 0)) {
    state = data.state;
    migrate();
    persist();
    localStorage.setItem(DIRTY_KEY, "0");
    materializeToday();
    renderAll();
    return true;
  }
  return false;
}

/* シートへ書き込み(送信) */
async function pushSync(manual) {
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
        updatedAt: state.updatedAt || 0,
        state,
        readable: readablePayload(),
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

/* 取得→必要なら送信(起動時・復帰時・手動) */
async function fullSync(manual) {
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
  let pulled = false;
  try {
    pulled = await pullSync();
  } catch (e) {
    setSyncMsg("シートからの取得に失敗しました", true);
    syncing = false;
    return;
  }
  syncing = false;
  if (pulled) {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    setSyncMsg(syncStatusLabel());
  }
  if (localStorage.getItem(DIRTY_KEY) === "1") {
    await pushSync(manual);
  } else {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    setSyncMsg(syncStatusLabel());
  }
}

window.addEventListener("online", () => fullSync(false));

/* ---------- 最新版に更新 ---------- */
async function forceUpdate() {
  setSyncMsg("更新を確認中…");
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.update();
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch (e) {}
  location.reload();
}

/* ---------- 毎秒の処理 ---------- */
function tick() {
  if (view !== "today") return;
  const cur = currentAsg();
  const curId = cur ? cur.id : null;
  const run = runningAsg();
  const over = !!(run && isOver(run));
  if (curId !== renderedCurrentId || over !== renderedOverrun) {
    renderAll();
  } else {
    updateTimerVisuals(cur);
  }
  if (run && over && Date.now() - lastBeep > 60000) {
    lastBeep = Date.now();
    beep();
    notify("見積時間を超過しました", `「${asgTitle(run)}」を切り上げるか、続行するか選んでください`);
  }
}

/* ---------- イベント ---------- */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  /* 今日 */
  if (action === "start") startAsg(id);
  else if (action === "pause") pauseAsg(id);
  else if (action === "finish") finishAsg(id);
  else if (action === "reopen") reopenAsg(id);
  else if (action === "remove") removeAsg(id);
  else if (action === "add-open") {
    document.getElementById("add-form").classList.remove("hidden");
    document.getElementById("fab").classList.add("hidden");
    document.getElementById("f-start").value = nowHM();
    document.getElementById("f-title").focus();
  } else if (action === "add-cancel") {
    document.getElementById("add-form").classList.add("hidden");
    document.getElementById("fab").classList.remove("hidden");
  } else if (action === "add-confirm") {
    const title = document.getElementById("f-title").value;
    if (!title.trim()) return;
    addAdhoc(title, document.getElementById("f-start").value || nowHM(), document.getElementById("f-est").value);
    document.getElementById("f-title").value = "";
    document.getElementById("add-form").classList.add("hidden");
    document.getElementById("fab").classList.remove("hidden");
  }

  /* タブ */
  else if (action === "tab") switchView(btn.dataset.tab);

  /* ガント */
  else if (action === "g-prev") { gStart = addDays(gStart, -14); renderGantt(); }
  else if (action === "g-next") { gStart = addDays(gStart, 14); renderGantt(); }
  else if (action === "g-today") { gStart = addDays(todayKey(), -7); renderGantt(); }
  else if (action === "g-selday") {
    selDate = btn.dataset.date;
    document.getElementById("asg-form").classList.add("hidden");
    editingAsgId = null;
    renderGantt();
  } else if (action === "g-cell") {
    toggleCell(btn.dataset.task, btn.dataset.date);
  } else if (action === "asg-add") {
    openAsgForm(selDate, null);
  } else if (action === "asg-edit") {
    const a = state.assignments.find((x) => x.id === id);
    if (a) openAsgForm(a.date, a);
  } else if (action === "asg-cancel") {
    editingAsgId = null;
    document.getElementById("asg-form").classList.add("hidden");
  } else if (action === "asg-save") {
    saveAsgForm();
  } else if (action === "asg-delete") {
    if (editingAsgId && confirm("この割り当てを取り消しますか?")) {
      const a = state.assignments.find((x) => x.id === editingAsgId);
      state.assignments = state.assignments.filter((x) => x.id !== editingAsgId);
      if (a && a.taskId) {
        const t = taskById(a.taskId);
        if (t && t.type === "recurring" && a.date >= todayKey() && occursOn(t, a.date)) {
          state.skips.push({ taskId: a.taskId, date: a.date });
        }
      }
      editingAsgId = null;
      document.getElementById("asg-form").classList.add("hidden");
      save();
      renderGantt();
    }
  } else if (action === "asg-fix") {
    fixVirtual(btn.dataset.task, btn.dataset.date);
  }

  /* 課題 */
  else if (action === "issue-add") openIssueForm(null);
  else if (action === "issue-edit") openIssueForm(issueById(id));
  else if (action === "issue-cancel") {
    editingIssueId = null;
    document.getElementById("issue-form").classList.add("hidden");
  } else if (action === "issue-save") saveIssueForm();
  else if (action === "issue-delete") {
    if (editingIssueId && confirm("この課題を削除しますか?(タスクは残ります)")) {
      removeIssue(editingIssueId);
      editingIssueId = null;
      document.getElementById("issue-form").classList.add("hidden");
    }
  } else if (action === "target-add") {
    addTargetRow("", "");
  } else if (action === "target-remove") {
    btn.closest(".target-row").remove();
  }

  /* タスク原本 */
  else if (action === "task-add") openTaskForm(null, null);
  else if (action === "task-child") openTaskForm(null, id);
  else if (action === "task-edit") openTaskForm(taskById(id), null);
  else if (action === "task-cancel") {
    editingTaskId = null;
    document.getElementById("task-form").classList.add("hidden");
  } else if (action === "task-save") saveTaskForm();
  else if (action === "task-delete") {
    if (confirm("このタスクを削除しますか?(子タスクは1段上に移動します)")) {
      removeTaskDef(editingTaskId);
      editingTaskId = null;
      document.getElementById("task-form").classList.add("hidden");
    }
  }

  /* 設定 */
  else if (action === "settings-open") {
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
  } else if (action === "sync-now") fullSync(true);
  else if (action === "force-update") forceUpdate();
});

document.addEventListener("change", (e) => {
  if (e.target.id === "t-type" || e.target.id === "t-rkind") updateRecVisibility();
  if (e.target.id === "a-task") {
    updateAsgTitleVisibility();
    const t = e.target.value ? taskById(e.target.value) : null;
    if (t && !editingAsgId) {
      document.getElementById("a-start").value = t.defStart || "09:00";
      document.getElementById("a-est").value = t.estimateMin || 25;
    }
  }
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    if (runningAsg() && navigator.wakeLock && !wakeLock) {
      try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
    }
    materializeToday();
    renderAll();
    fullSync(false);
  }
});

/* ---------- 起動 ---------- */
load();
materializeToday();
document.body.dataset.view = "today";
renderAll();
setSyncMsg(syncStatusLabel());
fullSync(false);
setInterval(tick, 1000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
