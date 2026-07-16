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
let state = { v: 5, updatedAt: 0, issues: [], tasks: [], assignments: [], skips: [], reserves: [], closedDates: [] };
let wakeLock = null;
let overNotifiedId = null;
let renderedCurrentId = null;
let renderedOverrun = false;
let view = "today";
let editingTaskId = null;
let editingIssueId = null;
let editingAsgId = null;
let selDate = todayKey();
let viewDate = todayKey(); // 今日タブで表示中の日付
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
  if (!state || typeof state !== "object") state = { v: 5, updatedAt: 0, issues: [], tasks: [], assignments: [], skips: [], reserves: [], closedDates: [] };
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
  if (state.v < 4) {
    state.reserves = [];
    state.v = 4;
  }
  if (state.v < 5) {
    state.closedDates = [];
    state.v = 5;
  }
  if (!Array.isArray(state.issues)) state.issues = [];
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!Array.isArray(state.assignments)) state.assignments = [];
  if (!Array.isArray(state.skips)) state.skips = [];
  if (!Array.isArray(state.reserves)) state.reserves = [];
  if (!Array.isArray(state.closedDates)) state.closedDates = [];
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
const issueColor = () => "#0E7C66"; // 課題ごとの色分けは廃止(並べ替えで色が変わるのを防ぐ)
const isTaskArchived = (t) =>
  !!t.archived || !!(t.issueId && (issueById(t.issueId) || {}).archived);

const asgTitle = (a) => {
  const t = a.taskId ? taskById(a.taskId) : null;
  return t ? t.title : a.title;
};
const hasSkip = (taskId, dk) => state.skips.some((s) => s.taskId === taskId && s.date === dk);
const isClosed = (dk) => state.closedDates.includes(dk);
/* 実行系の編集可否:未来は不可・締め済みも不可 */
const execEditable = (dk) => dk <= todayKey() && !isClosed(dk);

function crumbOf(taskId) {
  let t = taskId ? taskById(taskId) : null;
  if (!t) return "";
  const parts = [];
  let p = t.parentId ? taskById(t.parentId) : null;
  while (p) {
    parts.unshift(p.title);
    p = p.parentId ? taskById(p.parentId) : null;
  }
  return parts.join(" › ");
}

const dayList = (dk) =>
  state.assignments
    .filter((a) => a.date === dk)
    .sort((x, y) => hmToMin(x.start) - hmToMin(y.start));

const todays = () => dayList(viewDate);

/* 日跨ぎで継続中の作業も拾うため、全日付から検索(前日の作業とみなす) */
const runningAsg = () => state.assignments.find((a) => a.status === "doing") || null;

const elapsedSec = (a) =>
  a.spentSec + (a.status === "doing" && a.startedAt ? (Date.now() - a.startedAt) / 1000 : 0);

const isOver = (a) => elapsedSec(a) > a.estimateMin * 60;

function currentAsg() {
  if (viewDate !== todayKey()) return null;
  const list = dayList(todayKey());
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
  if (task.type === "summary") return "サマリー";
  if (task.type === "irregular") return "不定期";
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
  if (isClosed(dk)) return;
  let changed = false;
  state.tasks
    .filter((t) => !isTaskArchived(t) && t.type === "recurring" && occursOn(t, dk) && !hasSkip(t.id, dk))
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

/* ---------- 予備日 ---------- */
const findReserve = (taskId, dk) =>
  state.reserves.find((r) => r.taskId === taskId && r.date === dk) || null;

/* 周期タスク:1つの実施日に対するルール上の予備日 */
function reserveFor(task, dk) {
  const rr = task.reserveRule;
  if (!rr) return null;
  if (rr.mode === "after") return addDays(dk, rr.n || 1);
  if (rr.mode === "before") return addDays(dk, -(rr.n || 1));
  if (rr.mode === "weekday") {
    const d = new Date(dk + "T00:00:00");
    const r = addDays(dk, rr.weekday - d.getDay()); // 同じ週(日曜はじまり)
    return r === dk ? null : r;
  }
  return null;
}

/* 周期タスク:期間内に落ちるルール予備日の集合 */
function ruleReserveDates(task, from, to) {
  const out = new Set();
  if (isTaskArchived(task) || task.type !== "recurring" || !task.reserveRule) return out;
  let d = addDays(from, -35);
  const end = addDays(to, 35);
  while (d <= end) {
    if (occursOn(task, d) && !hasSkip(task.id, d)) {
      const r = reserveFor(task, d);
      if (r && r >= from && r <= to) out.add(r);
    }
    d = addDays(d, 1);
  }
  return out;
}

/* その日の項目:実際の割り当て + 周期タスクの自動予定(今日以降・スキップ除く) */
function dayItems(dk) {
  const real = state.assignments.filter((a) => a.date === dk);
  const virt =
    dk >= todayKey()
      ? state.tasks
          .filter(
            (t) =>
              !isTaskArchived(t) &&
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
  const target = state.assignments.find((x) => x.id === id);
  if (!target || !execEditable(target.date)) return;
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
  overNotifiedId = null; // 開始のたびに超過通知を1回だけ出し直す
  state.assignments = state.assignments.map((a) => {
    if (a.id === id) return { ...a, status: "doing", startedAt: Date.now() };
    if (a.status === "doing") return { ...a, status: "todo", spentSec: elapsedSec(a), startedAt: null };
    return a;
  });
  save();
  renderAll();
}

function pauseAsg(id) {
  const target = state.assignments.find((x) => x.id === id);
  if (!target || !execEditable(target.date)) return;
  state.assignments = state.assignments.map((a) =>
    a.id === id ? { ...a, status: "todo", spentSec: elapsedSec(a), startedAt: null } : a
  );
  releaseWake();
  save();
  renderAll();
}

function finishAsg(id) {
  const target0 = state.assignments.find((x) => x.id === id);
  if (!target0 || !execEditable(target0.date)) return;
  state.assignments = state.assignments.map((a) =>
    a.id === id ? { ...a, status: "done", spentSec: elapsedSec(a), startedAt: null } : a
  );
  const a = state.assignments.find((x) => x.id === id);
  if (a && a.taskId) {
    const t = taskById(a.taskId);
    if (t && t.type === "single") { t.done = true; t.archived = true; } // 完了と同時に自動アーカイブ
  }
  releaseWake();
  save();
  renderAll();
}

/* 完了の取り消し */
function reopenAsg(id) {
  const target = state.assignments.find((x) => x.id === id);
  if (!target || !execEditable(target.date)) return;
  const a = state.assignments.find((x) => x.id === id);
  if (!a) return;
  a.status = "todo";
  if (a.taskId) {
    const t = taskById(a.taskId);
    if (t && t.type === "single") { t.done = false; t.archived = false; } // 完了解除でアーカイブも解除
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

function createSingleTask(title, defStart, estimateMin) {
  const t = {
    id: uid("t"),
    title: title.trim(),
    parentId: null,
    issueId: null,
    type: "single",
    estimateMin: Math.max(1, Number(estimateMin) || 25),
    defStart: defStart || "09:00",
    planStart: null,
    planEnd: null,
    recurrence: null,
    reserveRule: null,
    done: false,
    createdDate: todayKey(),
  };
  state.tasks.push(t);
  return t;
}

function addAdhoc(title, start, estimateMin) {
  if (!execEditable(viewDate)) return;
  const t = createSingleTask(title, start, estimateMin); // 課題タブ・計画タブにも出るよう原本を作る
  state.assignments.push({
    id: uid("a"),
    taskId: t.id,
    title: t.title,
    date: viewDate,
    start,
    estimateMin: t.estimateMin,
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
  const tk = todayKey();
  const d = new Date(viewDate + "T00:00:00");
  const youbi = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  const lockMark = isClosed(viewDate) ? " 🔒" : "";
  const suffix = viewDate === tk ? "" : viewDate < tk ? "(過去)" : "(未来)";
  document.getElementById("date-label").textContent =
    `${d.getMonth() + 1}月${d.getDate()}日(${youbi})${suffix}${lockMark}`;
  const tl = document.getElementById("timeline-label");
  if (tl) tl.textContent = viewDate === tk ? "今日のタイムライン" : "この日のタイムライン";
  const list = dayItems(viewDate);
  const done = list.filter((a) => a.status === "done").length;
  if (viewDate === tk) {
    const rest = list.filter((a) => a.status !== "done").reduce((s, a) => s + a.estimateMin, 0);
    document.getElementById("stats").innerHTML =
      `<div>残り見積 ${Math.floor(rest / 60)}時間${rest % 60}分</div><div>完了 ${done} / ${list.length}</div>`;
  } else {
    const plan = list.reduce((s, a) => s + (a.estimateMin || 0), 0);
    const actual = list.reduce((s, a) => s + (a.spentSec || 0), 0);
    document.getElementById("stats").innerHTML =
      `<div>予定 ${fmtH(plan)} ・ 実績 ${fmtH(Math.round(actual / 60))}</div><div>完了 ${done} / ${list.length}</div>`;
  }
}

/* ---------- 描画:今日 ---------- */
function renderHero() {
  const hero = document.getElementById("hero");
  const tk = todayKey();
  if (viewDate !== tk) {
    const closed = isClosed(viewDate);
    const msg = viewDate > tk
      ? "🔒 未来の日付は閲覧のみです。<br><small>割り当ての変更は計画タブで行えます</small>"
      : closed
        ? "🔒 この日は締め済みです。<br><small>編集するには下の「締めを解除」を押してください</small>"
        : "過去の日付です。<br><small>締め前のため、完了の修正やタスク追加ができます</small>";
    hero.innerHTML = `<div class="empty-card">${msg}</div>`;
    document.body.classList.remove("overrun");
    return;
  }
  const cur = currentAsg();
  if (!cur) {
    const has = todays().length > 0;
    hero.innerHTML = `<div class="empty-card">${
      has
        ? "今日のタスクはすべて完了しました 🎉<br><small>おつかれさまでした</small>"
        : "今日のタスクはまだありません。<br><small>「+ タスクを追加」か、計画で日付マスをタップして割り当てましょう</small>"
    }</div>`;
    document.body.classList.remove("overrun");
    return;
  }
  const run = runningAsg();
  const mine = run && run.id === cur.id;
  const over = mine && isOver(cur);
  document.body.classList.toggle("overrun", !!over);

  const crumb = cur.taskId ? crumbOf(cur.taskId) : "";
  const eyebrow = over ? "⚠ 見積時間を超過しています" : mine ? "作業中" : "次にやること";
  const buttons = mine
    ? `<button class="btn solid" data-action="finish" data-id="${cur.id}">完了にする</button>
       <button class="btn" data-action="pause" data-id="${cur.id}">中断</button>`
    : `<button class="btn solid" data-action="start" data-id="${cur.id}">作業を開始</button>`;

  hero.innerHTML = `
    <div class="hero ${over ? "overrun" : ""}">
      <div class="hero-eyebrow">${eyebrow}</div>
      ${crumb ? `<div class="hero-crumb">${esc(crumb)} ›</div>` : ""}
      <div class="hero-title">${esc(asgTitle(cur))}</div>
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
  const list = dayItems(viewDate); // 自動予定(周期の仮想分)も含めて表示
  const cur = currentAsg();
  const editable = execEditable(viewDate);
  if (!list.length) {
    box.innerHTML = `<div class="t-sub" style="padding:8px 0 24px;">この日の割り当てはありません</div>`;
    renderDayClose();
    return;
  }
  box.innerHTML = list
    .map((a, idx) => {
      const done = a.status === "done";
      const active = !a.virtual && cur && cur.id === a.id;
      const past = viewDate === todayKey() && !done && hmToMin(a.start) + a.estimateMin < nowMin();
      const spent = !a.virtual && a.spentSec > 5 ? ` ・ 実績 ${fmtDur(elapsedSec(a))}` : "";
      const t = a.taskId ? taskById(a.taskId) : null;
      const rec = a.virtual ? " ・ 🔁 自動" : t && t.type === "recurring" ? " ・ 🔁" : "";
      const crumb = a.taskId ? crumbOf(a.taskId) : "";
      const notes = t && t.notes ? t.notes : "";
      const full = (crumb ? `${crumb} › ${asgTitle(a)}` : asgTitle(a)) + (notes ? `\n📝 ${notes}` : "");
      const showTime = idx === 0 || list[idx - 1].start !== a.start;
      const actions = a.virtual || !editable
        ? `<span class="virtual-tag">${a.virtual ? "🔁" : "🔒"}</span>`
        : done
          ? `<button class="sbtn" data-action="reopen" data-id="${a.id}">戻す</button>`
          : `${active ? "" : `<button class="sbtn" data-action="start" data-id="${a.id}">開始</button>`}
             <button class="sbtn muted" data-action="finish" data-id="${a.id}">完了</button>`;
      return `
        <div class="t-item ${done ? "done" : ""} ${active ? "active" : ""}">
          <div class="t-time">${showTime ? a.start : ""}</div>
          <div class="t-dot"></div>
          <div class="t-card">
            <div class="t-main">
              <div class="t-title" data-action="g-showname" data-name="${esc(full)}">${crumb ? `<span class="crumb">${esc(crumb)} › </span>` : ""}${esc(asgTitle(a))}</div>
              <div class="t-sub">見積 ${a.estimateMin}分${spent}${rec}${notes ? " ・ 📝" : ""}${past ? " ・ 予定時刻を過ぎています" : ""}</div>
            </div>
            <div class="t-actions">${actions}</div>
          </div>
        </div>`;
    })
    .join("");
  renderDayClose();
}

/* ---------- 締め(日次ロック) ---------- */
function renderDayClose() {
  const box = document.getElementById("day-close");
  if (!box) return;
  const tk = todayKey();
  if (viewDate > tk) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = isClosed(viewDate)
    ? `<div class="btn-row" style="margin-top:20px;"><button class="btn" data-action="day-open">🔓 この日の締めを解除</button></div>`
    : `<div class="btn-row" style="margin-top:20px;"><button class="btn danger" data-action="day-close">🔒 この日を締める</button></div>`;
}

/* ---------- 描画:統合ガント(計画モード) ---------- *//* ---------- 描画:統合ガント(計画モード) ---------- */
let showArch = localStorage.getItem("hisho:ui:showarch") === "1";
let openIssueIds = new Set(JSON.parse(localStorage.getItem("hisho:ui:openissues") || "[]"));
function saveOpenIssues() {
  localStorage.setItem("hisho:ui:openissues", JSON.stringify([...openIssueIds]));
}
function orderedRoots(issueId) {
  if (issueId !== undefined) {
    return state.tasks.filter((t) => !t.parentId && (t.issueId || null) === issueId);
  }
  const out = [];
  state.issues.forEach((g) => out.push(...state.tasks.filter((t) => !t.parentId && t.issueId === g.id)));
  out.push(...state.tasks.filter((t) => !t.parentId && !t.issueId));
  return out;
}
let collapsedIds = new Set(JSON.parse(localStorage.getItem("hisho:ui:collapsed") || "[]"));
function saveCollapsed() {
  localStorage.setItem("hisho:ui:collapsed", JSON.stringify([...collapsedIds]));
}

function renderGantt() {
  const box = document.getElementById("gantt");
  const archChk = document.getElementById("g-showarch");
  if (archChk) archChk.checked = showArch;

  if (!state.tasks.length) {
    box.innerHTML = `<div class="g-empty">課題タブでタスクを登録すると、ここで日付マスをタップして割り当てられます。</div>`;
    renderDayDetail();
    return;
  }
  const prevScroll = box.querySelector(".g-scroll");
  const keepLeft = prevScroll ? prevScroll.scrollLeft : null;

  const days = [...Array(G_DAYS)].map((_, i) => addDays(gStart, i));
  const tk = todayKey();
  const trackW = G_DAYS * G_COLW;
  const colX = (i) => i * G_COLW;
  const tdIdx = days.indexOf(tk);
  const lockCols = days
    .map((dk, i) =>
      isClosed(dk) ? `<div class="g-lock-col" style="left:${colX(i)}px;width:${G_COLW}px"></div>` : ""
    )
    .join("");

  const weCols = days
    .map((dk, i) => {
      const wd = new Date(dk + "T00:00:00").getDay();
      return wd === 0 || wd === 6
        ? `<div class="g-we-col" style="left:${colX(i)}px;width:${G_COLW}px"></div>`
        : "";
    })
    .join("");
  const todayLine = tdIdx >= 0 ? `<div class="g-today-line" style="left:${colX(tdIdx)}px"></div>` : "";

  /* 日付ヘッダー */
  const hcells = days
    .map((dk, i) => {
      const d = new Date(dk + "T00:00:00");
      const wd = d.getDay();
      const mon = d.getDate() === 1 || i === 0
        ? `<span class="g-mon2">${d.getMonth() + 1}月</span>`
        : "";
      return `<button class="g-hcell2 ${wd === 0 || wd === 6 ? "we" : ""} ${dk === tk ? "td" : ""} ${dk === selDate ? "sel" : ""} ${isClosed(dk) ? "locked" : ""}"
        style="left:${colX(i)}px;width:${G_COLW}px" data-action="g-selday" data-date="${dk}">
        ${mon}${d.getDate()}</button>`;
    })
    .join("");

  /* 見積合計行 */
  const heat = (min) => {
    if (min <= 0) return "transparent";
    if (min <= 120) return "#EAF4F1";
    if (min <= 240) return "#D2E9E2";
    if (min <= 360) return "#B5DCD0";
    return "#F6D9D3";
  };
  const sumCells = days
    .map((dk, i) => {
      const m = dayItems(dk).reduce((s, x) => s + (x.estimateMin || 0), 0);
      return `<button class="g-sum-cell" style="left:${colX(i) + 1}px;width:${G_COLW - 2}px;background:${heat(m)}"
        data-action="g-selday" data-date="${dk}">${m ? fmtH(m).replace("分", "m") : ""}</button>`;
    })
    .join("");

  /* タスク行:左の名前列と右のトラックを同じ順序で組み立てる */
  const sideRows = [];
  const trackRows = [];
  const walk = (parentId, depth) => {
    (parentId === null ? orderedRoots() : state.tasks.filter((t) => t.parentId === parentId))
      .forEach((t) => {
        const hideThis = !showArch && isTaskArchived(t); // アーカイブのみ非表示(完了でも未アーカイブなら表示)
        if (!hideThis) {
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

          const ruleRes = ruleReserveDates(t, days[0], days[days.length - 1]);

          const cells = days
            .map((dk, i) => {
              const real = state.assignments.find((a) => a.taskId === t.id && a.date === dk);
              const manualRes = !real && findReserve(t.id, dk);
              const virt =
                !real &&
                t.type === "recurring" &&
                dk >= tk &&
                occursOn(t, dk) &&
                !hasSkip(t.id, dk);
              const autoRes = !real && !virt && !manualRes && ruleRes.has(dk);
              let mark = "";
              let movable = "";
              if (real) {
                mark =
                  real.status === "done"
                    ? `<span class="mark done-m">✓</span>`
                    : `<span class="mark todo-m">●</span>`;
                if (t.type !== "recurring") movable = "has-mark";
              } else if (manualRes) {
                mark = `<span class="mark res-m">○</span>`;
                movable = "has-mark";
              } else if (virt) {
                mark = `<span class="mark virt-m">🔁</span>`;
              } else if (autoRes) {
                mark = `<span class="mark ares-m">○</span>`;
              }
              if (t.type === "summary" || isClosed(dk)) {
                return `<div class="g-cell locked-cell" style="left:${colX(i)}px;width:${G_COLW}px">${t.type === "summary" ? "" : mark}</div>`;
              }
              return `<button class="g-cell ${movable}" style="left:${colX(i)}px;width:${G_COLW}px"
                data-action="g-cell" data-task="${t.id}" data-date="${dk}">${mark}</button>`;
            })
            .join("");

          const rec = t.type === "recurring" ? "🔁 " : t.type === "irregular" ? "〰 " : "";
          const isCollapsedG = collapsedIds.has(t.id);
          const caretG = children.length
            ? `<button class="caret" data-action="node-toggle" data-id="${t.id}">${isCollapsedG ? "▸" : "▾"}</button>`
            : `<span class="caret ghost"></span>`;
          const unsched =
            (t.type === "single" || t.type === "irregular") &&
            !t.done &&
            !children.length &&
            !state.assignments.some((a) => a.taskId === t.id);
          const tipText = (crumbOf(t.id) ? crumbOf(t.id) + " › " + t.title : t.title) + (t.notes ? `\n📝 ${t.notes}` : "");
          sideRows.push(`
            <div class="g-scell ${t.done ? "done-task" : ""} ${unsched ? "unsched" : ""}" style="padding-left:${4 + depth * 14}px"
                 title="${esc(t.title)}" data-action="g-showname" data-name="${esc(tipText)}">
              ${caretG}
              <span class="g-name">${rec}${esc(t.title)}</span>
              ${prog !== null ? `<span class="g-prog">${prog}%</span>` : ""}
            </div>`);
          trackRows.push(`<div class="g-trow">${weCols}${lockCols}${todayLine}${bar}${cells}</div>`);
        }
        if (!collapsedIds.has(t.id)) walk(t.id, depth + 1);
      });
  };
  walk(null, 0);

  box.innerHTML = `
    <div class="g-wrap2">
      <div class="g-side">
        <div class="g-scell g-sh">タスク</div>
        <div class="g-scell g-ss">見積合計</div>
        ${sideRows.join("")}
      </div>
      <div class="g-scroll">
        <div style="width:${trackW}px">
          <div class="g-trow g-sh">${hcells}</div>
          <div class="g-trow g-ss">${lockCols}${sumCells}</div>
          ${trackRows.join("")}
        </div>
      </div>
    </div>`;

  const sc = box.querySelector(".g-scroll");
  if (sc) {
    if (keepLeft !== null) sc.scrollLeft = keepLeft;
    else if (tdIdx >= 0) sc.scrollLeft = Math.max(0, (tdIdx - 3) * G_COLW);
  }
  updateGanttStickyHeader();
  renderDayDetail();
}

/* 縦スクロール時、日付ヘッダー行を画面上部に貼り付ける */
function updateGanttStickyHeader() {
  if (view !== "gantt") return;
  const box = document.getElementById("gantt");
  if (!box) return;
  const headTrack = box.querySelector(".g-trow.g-sh");
  const headSide = box.querySelector(".g-side .g-scell.g-sh");
  if (!headTrack || !headSide) return;
  const bars = document.getElementById("fixedbars");
  const topEdge = bars ? bars.offsetHeight : 0;
  const rect = box.getBoundingClientRect();
  const headH = headTrack.offsetHeight;
  let offset = 0;
  if (rect.top < topEdge && rect.bottom > topEdge + headH + 40) {
    offset = topEdge - rect.top;
  }
  const tf = offset > 0 ? `translateY(${offset}px)` : "";
  headTrack.style.transform = tf;
  headSide.style.transform = tf;
  headTrack.classList.toggle("floating", offset > 0);
  headSide.classList.toggle("floating", offset > 0);
}

window.addEventListener("scroll", () => {
  requestAnimationFrame(updateGanttStickyHeader);
}, { passive: true });

/* マスのタップ:空→●実施→○予備→空(周期タスクは自動予定のオン/オフ) */
function toggleCell(taskId, dk) {
  if (isClosed(dk)) return;
  const t = taskById(taskId);
  if (!t || t.type === "summary") return;
  const real = state.assignments.find((a) => a.taskId === taskId && a.date === dk);

  if (t.type === "recurring") {
    if (real) {
      if ((real.status === "done" || real.spentSec > 5) &&
          !confirm("実績が記録されています。この割り当てを取り消しますか?")) return;
      state.assignments = state.assignments.filter((a) => a.id !== real.id);
      if (dk >= todayKey() && occursOn(t, dk)) state.skips.push({ taskId, date: dk });
    } else if (dk >= todayKey() && occursOn(t, dk)) {
      if (hasSkip(taskId, dk)) {
        state.skips = state.skips.filter((s) => !(s.taskId === taskId && s.date === dk));
      } else {
        state.skips.push({ taskId, date: dk });
      }
    } else {
      state.assignments.push({
        id: uid("a"), taskId, title: t.title, date: dk,
        start: t.defStart || "09:00", estimateMin: t.estimateMin || 25,
        status: "todo", spentSec: 0, startedAt: null,
      });
    }
  } else {
    const res = findReserve(taskId, dk);
    if (real) {
      if ((real.status === "done" || real.spentSec > 5) &&
          !confirm("実績が記録されています。実施日を予備日に変えますか?")) return;
      state.assignments = state.assignments.filter((a) => a.id !== real.id);
      state.reserves.push({ id: uid("r"), taskId, date: dk }); // ● → ○
    } else if (res) {
      state.reserves = state.reserves.filter((r) => r.id !== res.id); // ○ → 空
    } else {
      state.assignments.push({
        id: uid("a"), taskId, title: t.title, date: dk,
        start: t.defStart || "09:00", estimateMin: t.estimateMin || 25,
        status: "todo", spentSec: 0, startedAt: null,
      }); // 空 → ●
    }
  }
  save();
  renderGantt();
}

/* ---------- タスク名の全体表示チップ ---------- */
function showNameTip(text, anchor) {
  let tip = document.getElementById("name-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "name-tip";
    document.body.appendChild(tip);
  }
  /* 同じタイトルをもう一度タップしたら閉じる */
  if (tip.style.display === "block" && showNameTip._anchor === anchor) {
    tip.style.display = "none";
    showNameTip._anchor = null;
    clearTimeout(showNameTip._t);
    return;
  }
  showNameTip._anchor = anchor;
  tip.textContent = text;
  tip.style.display = "block";
  /* タップした行の真下に、ページ座標で固定(スクロールに追随し、ずれが蓄積しない) */
  const r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth;
  const x = Math.max(8 + window.scrollX, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 8));
  tip.style.left = `${x}px`;
  tip.style.top = `${r.bottom + window.scrollY + 6}px`;
  clearTimeout(showNameTip._t);
  showNameTip._t = setTimeout(() => { tip.style.display = "none"; showNameTip._anchor = null; }, 4000);
}

/* ---------- 並べ替えドラッグ(課題カード・タスク行) ---------- */
let sortDrag = null;
let sortAutoScrollSpeed = 0;
let sortAutoScrollRAF = null;

function sortAutoScrollTick() {
  if (!sortDrag || !sortAutoScrollSpeed) { sortAutoScrollRAF = null; return; }
  window.scrollBy(0, sortAutoScrollSpeed);
  sortAutoScrollRAF = requestAnimationFrame(sortAutoScrollTick);
}

/* 画面の上端/下端付近にポインタが来たらゆっくりスクロールする */
function updateSortAutoScroll(clientY) {
  const EDGE = 70; // この距離まで端に近づいたらスクロール開始
  const MAX_SPEED = 9; // 最大速度(px/フレーム)
  const vh = window.innerHeight;
  let speed = 0;
  if (clientY < EDGE) {
    speed = -MAX_SPEED * (1 - clientY / EDGE);
  } else if (clientY > vh - EDGE) {
    speed = MAX_SPEED * (1 - (vh - clientY) / EDGE);
  }
  sortAutoScrollSpeed = speed;
  if (speed && !sortAutoScrollRAF) sortAutoScrollRAF = requestAnimationFrame(sortAutoScrollTick);
}

function stopSortAutoScroll() {
  sortAutoScrollSpeed = 0;
  if (sortAutoScrollRAF) { cancelAnimationFrame(sortAutoScrollRAF); sortAutoScrollRAF = null; }
}

function sortCandidates(d) {
  if (d.type === "issue") {
    return [...document.querySelectorAll(".issue-card[data-issue]")].filter(
      (el) => el.dataset.issue !== d.id
    );
  }
  const dragged = taskById(d.id);
  if (!dragged) return [];
  return [...document.querySelectorAll(".p-row[data-task]")].filter((el) => {
    if (el.dataset.task === d.id) return false;
    const t = taskById(el.dataset.task);
    if (!t) return false;
    if ((t.parentId || null) !== (dragged.parentId || null)) return false;
    if (!dragged.parentId && (t.issueId || null) !== (dragged.issueId || null)) return false;
    return true;
  });
}

function getDropLine() {
  let l = document.getElementById("drop-line");
  if (!l) {
    l = document.createElement("div");
    l.id = "drop-line";
  }
  return l;
}

document.addEventListener("pointerdown", (e) => {
  const h = e.target.closest(".drag-h");
  if (!h) return;
  const issueEl = h.closest("[data-issue]");
  const taskEl = h.closest("[data-task]");
  if (!issueEl && !taskEl) return;
  sortDrag = {
    type: issueEl ? "issue" : "task",
    id: issueEl ? issueEl.dataset.issue : taskEl.dataset.task,
    el: issueEl || taskEl,
    py: e.clientY,
    moved: false,
    idx: null,
  };
  sortDrag.el.classList.add("grabbed"); // 掴めた合図(押した瞬間に浮く)
  try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}
});

document.addEventListener("pointermove", (e) => {
  if (!sortDrag) return;
  if (!sortDrag.moved && Math.abs(e.clientY - sortDrag.py) > 6) {
    sortDrag.moved = true;
    sortDrag.el.classList.add("sorting");
  }
  if (!sortDrag.moved) return;
  /* カードがポインタに追随して動く */
  sortDrag.el.style.transform = `translateY(${e.clientY - sortDrag.py}px) scale(1.02)`;
  updateSortAutoScroll(e.clientY);
  const cands = sortCandidates(sortDrag);
  if (!cands.length) return;
  /* ポインタ位置と各要素の中央を比べて挿入位置を決める(上下で対称) */
  let idx = 0;
  cands.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top + r.height / 2 < e.clientY) idx++;
  });
  sortDrag.idx = idx;
  const line = getDropLine();
  if (idx < cands.length) {
    cands[idx].parentNode.insertBefore(line, cands[idx]);
  } else {
    const last = cands[cands.length - 1];
    last.parentNode.insertBefore(line, last.nextSibling);
  }
});

document.addEventListener("pointerup", () => {
  if (!sortDrag) return;
  const d = sortDrag;
  sortDrag = null;
  stopSortAutoScroll();
  d.el.classList.remove("sorting");
  d.el.classList.remove("grabbed");
  d.el.style.transform = "";
  const line = document.getElementById("drop-line");
  const cands = sortCandidates(d);
  if (line) line.remove();
  if (!d.moved) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 80);
  if (d.idx === null || !cands.length) return;

  if (d.type === "issue") {
    const dragged = issueById(d.id);
    if (!dragged) return;
    const order = cands.map((el) => el.dataset.issue); // ドラッグ中の要素を除いた並び
    order.splice(d.idx, 0, d.id);
    state.issues = order.map((id) => issueById(id)).filter(Boolean);
    save();
    renderPlan();
  } else {
    const dragged = taskById(d.id);
    if (!dragged) return;
    state.tasks = state.tasks.filter((t) => t.id !== d.id);
    if (d.idx < cands.length) {
      const before = taskById(cands[d.idx].dataset.task);
      const pos = state.tasks.indexOf(before);
      state.tasks.splice(pos, 0, dragged);
    } else {
      const lastSib = taskById(cands[cands.length - 1].dataset.task);
      const pos = state.tasks.indexOf(lastSib) + 1;
      state.tasks.splice(pos, 0, dragged);
    }
    save();
    renderPlan();
  }
});

/* ---------- スワイプでアーカイブ(課題タブのタスク行・課題カード) ---------- */
let swipe = null;
let openSwipeRow = null;

function closeOpenSwipe() {
  if (openSwipeRow) {
    const row = openSwipeRow;
    const wrap = row.closest(".swipe-wrap");
    openSwipeRow = null;
    row.style.transition = "transform .18s ease";
    row.style.transform = "";
    if (wrap) setTimeout(() => wrap.classList.remove("show-action"), 200);
  }
}

document.addEventListener("pointerdown", (e) => {
  if (view !== "plan") return;
  if (e.target.closest("button") || e.target.closest(".drag-h") || e.target.closest(".caret")) return;
  const row = e.target.closest(".swipeable > .swipe-target");
  if (openSwipeRow && openSwipeRow !== row) closeOpenSwipe();
  if (!row) return;
  swipe = {
    row,
    wrap: row.closest(".swipe-wrap"),
    sx: e.clientX,
    sy: e.clientY,
    horiz: null,
    base: row === openSwipeRow ? -88 : 0, // 開いた状態から右スワイプで戻せるように基点を持つ
    cur: null,
  };
});

document.addEventListener("pointermove", (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.sx;
  const dy = e.clientY - swipe.sy;
  if (swipe.horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
    swipe.horiz = Math.abs(dx) > Math.abs(dy);
    if (!swipe.horiz) { swipe = null; return; }
    swipe.row.style.transition = "none";
    if (swipe.wrap) swipe.wrap.classList.add("show-action"); // スワイプ中だけボタンを見せる
  }
  if (!swipe.horiz) return;
  swipe.cur = Math.max(-110, Math.min(0, swipe.base + dx));
  swipe.row.style.transform = `translateX(${swipe.cur}px)`; // 指に追随(枠は変形させない)
});

document.addEventListener("pointerup", () => {
  if (!swipe) return;
  const s = swipe;
  swipe = null;
  if (s.horiz === null) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 80);
  s.row.style.transition = "transform .18s ease"; // 戻すときもアニメーション
  if (s.cur !== null && s.cur < -55) {
    s.row.style.transform = "translateX(-88px)";
    openSwipeRow = s.row;
  } else {
    s.row.style.transform = "";
    if (openSwipeRow === s.row) openSwipeRow = null;
    if (s.wrap) setTimeout(() => { if (openSwipeRow !== s.row) s.wrap.classList.remove("show-action"); }, 200);
  }
});

/* ---------- マークのドラッグ移動 ---------- *//* ---------- マークのドラッグ移動 ---------- */
let drag = null;
let suppressClick = false;

document.addEventListener("pointerdown", (e) => {
  if (view !== "gantt") return;
  const cell = e.target.closest(".g-cell.has-mark");
  if (!cell) return;
  const taskId = cell.dataset.task;
  const dk = cell.dataset.date;
  const real = state.assignments.find((a) => a.taskId === taskId && a.date === dk);
  const res = real ? null : findReserve(taskId, dk);
  if (!real && !res) return;
  drag = {
    kind: real ? "asg" : "res",
    id: real ? real.id : res.id,
    track: cell.parentElement,
    fromIdx: diffDays(dk, gStart),
    overIdx: null,
    px: e.clientX,
    moved: false,
  };
});

document.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.moved && Math.abs(e.clientX - drag.px) > 8) drag.moved = true;
  if (!drag.moved) return;
  const rect = drag.track.getBoundingClientRect();
  let idx = Math.floor((e.clientX - rect.left) / G_COLW);
  idx = Math.max(0, Math.min(G_DAYS - 1, idx));
  drag.overIdx = idx;
  let ghost = drag.track.querySelector(".g-dropcol");
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.className = "g-dropcol";
    drag.track.appendChild(ghost);
  }
  ghost.style.left = `${idx * G_COLW}px`;
  ghost.style.width = `${G_COLW}px`;
});

document.addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  const ghost = d.track.querySelector(".g-dropcol");
  if (ghost) ghost.remove();
  if (d.moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
    if (d.overIdx !== null && d.overIdx !== d.fromIdx) {
      const nd = addDays(gStart, d.overIdx);
      if (isClosed(nd)) return;
      if (d.kind === "asg") {
        const a = state.assignments.find((x) => x.id === d.id);
        if (a) a.date = nd;
      } else {
        const r = state.reserves.find((x) => x.id === d.id);
        if (r) r.date = nd;
      }
      save();
      renderGantt();
    }
  }
});

/* ---------- 日別詳細 ---------- *//* ---------- 日別詳細 ---------- */
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
          const lockedDay = isClosed(selDate);
          const actions = lockedDay
            ? `<span class="virtual-tag">🔒</span>`
            : i.virtual
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

  /* この日の予備日(手動+周期ルール) */
  const resRows = [];
  state.reserves
    .filter((r) => r.date === selDate)
    .forEach((r) => {
      const t = taskById(r.taskId);
      if (t) resRows.push(`<div class="p-row"><div class="p-main"><div class="p-title">○ ${esc(t.title)}</div><div class="p-sub">予備日</div></div></div>`);
    });
  state.tasks
    .filter((t) => t.type === "recurring" && t.reserveRule)
    .forEach((t) => {
      if (ruleReserveDates(t, selDate, selDate).has(selDate)) {
        resRows.push(`<div class="p-row"><div class="p-main"><div class="p-title">○ ${esc(t.title)}</div><div class="p-sub">予備日(自動)</div></div></div>`);
      }
    });

  box.innerHTML = `
    <div class="plan-head">
      <h2 class="section-label">${d.getMonth() + 1}月${d.getDate()}日(${youbi}) 合計 ${fmtH(total)}${isClosed(selDate) ? " 🔒締め済み" : ""}</h2>
      ${isClosed(selDate) ? "" : `<button class="sbtn" data-action="asg-add">+ 割り当て</button>`}
    </div>
    ${rows}
    ${resRows.join("")}`;
}

/* ---------- 割り当てフォーム ---------- */
function fillAsgTaskSelect() {
  const sel = document.getElementById("a-task");
  const options = [];
  const walk = (parentId, depth) => {
    state.tasks
      .filter((t) => (t.parentId || null) === parentId)
      .forEach((t) => {
        if (!isTaskArchived(t) && t.type !== "summary" && !(t.type === "single" && t.done)) {
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
  let taskId = document.getElementById("a-task").value || null;
  const title = document.getElementById("a-title").value.trim();
  if (!taskId && !title) return;
  const date = document.getElementById("a-date").value || selDate;
  const start = document.getElementById("a-start").value || "09:00";
  const est = Math.max(1, Number(document.getElementById("a-est").value) || 25);
  if (isClosed(date)) { alert("その日は締め済みのため編集できません"); return; }
  if (editingAsgId) {
    const orig = state.assignments.find((x) => x.id === editingAsgId);
    if (orig && isClosed(orig.date)) { alert("締め済みの日の割り当ては編集できません"); return; }
  }
  if (!taskId && !editingAsgId) {
    taskId = createSingleTask(title, start, est).id; // 直接入力も原本を作る
  }

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
  if (isClosed(dk)) return;
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

/* ---------- 描画:課題タブ(課題ごとにタスクを展開) ---------- */
let searchQuery = "";
let archFilter = localStorage.getItem("hisho:ui:archfilter") || "active";

function computeVisibleTasks() {
  const q = searchQuery.trim().toLowerCase();
  const base = new Set();
  state.tasks.forEach((t) => {
    const archOk =
      archFilter === "all" ? true : archFilter === "archived" ? !!t.archived : !t.archived;
    const qOk = !q || t.title.toLowerCase().includes(q);
    if (archOk && qOk) base.add(t.id);
  });
  /* マッチしたタスクの祖先は文脈として表示する */
  const visible = new Set(base);
  base.forEach((id) => {
    let p = taskById(id);
    p = p && p.parentId ? taskById(p.parentId) : null;
    while (p) {
      visible.add(p.id);
      p = p.parentId ? taskById(p.parentId) : null;
    }
  });
  return visible;
}

function renderTaskTree(roots, visible) {
  const searching = !!searchQuery.trim();
  const renderNode = (t, depth) => {
    if (visible && !visible.has(t.id)) return "";
    const prog = !t.parentId ? progressOf(t) : null;
    const issue = t.issueId ? issueById(t.issueId) : null;
    const children = state.tasks.filter((c) => c.parentId === t.id);
    const marks = t.type === "recurring" ? "🔁 " : t.type === "irregular" ? "〰 " : t.type === "summary" ? "▤ " : "";
    const isCollapsed = !searching && collapsedIds.has(t.id);
    const caret = children.length
      ? `<button class="caret" data-action="node-toggle" data-id="${t.id}">${isCollapsed ? "▸" : "▾"}</button>`
      : `<span class="caret ghost"></span>`;
    const reopenBtn = t.type === "single" && t.done && !t.archived
      ? `<button class="sbtn" data-action="task-reopen" data-id="${t.id}">戻す</button>`
      : "";
    const archBtn = t.archived
      ? `<button class="sbtn" data-action="task-unarchive" data-id="${t.id}">解除</button>`
      : "";
    const archTag = t.archived ? `<span class="virtual-tag">📦 アーカイブ済</span> ` : "";
    const notesMark = t.notes ? " ・ 📝" : "";
    const sub = t.type === "summary"
      ? `${prog !== null ? `進捗 ${prog}% ・ ` : ""}サマリー${children.length ? ` ・ 子タスク ${children.length}件${isCollapsed ? "(折りたたみ中)" : ""}` : ""}${notesMark}`
      : `${prog !== null ? `進捗 ${prog}% ・ ` : ""}${recurrenceLabel(t)} ・ 見積 ${t.estimateMin}分${children.length ? ` ・ 子タスク ${children.length}件${isCollapsed ? "(折りたたみ中)" : ""}` : ""}${notesMark}`;
    const row = `
      <div class="swipe-wrap${t.archived ? "" : " swipeable"}">
        ${t.archived ? "" : `<div class="swipe-action"><button data-action="task-archive" data-id="${t.id}">📦<br>アーカイブ</button></div>`}
        <div class="p-row swipe-target" data-task="${t.id}" style="margin-left:${depth * 18}px;border-left-color:${issue ? issueColor(issue.id) : "transparent"}">
          <span class="drag-h" title="ドラッグで並べ替え">⋮⋮</span>
          ${caret}
          <div class="p-main">
            <div class="p-title ${t.done ? "done-task" : ""}">${archTag}${marks}${esc(t.title)}</div>
            <div class="p-sub">${sub}</div>
          </div>
          <div class="p-actions">
            ${archBtn}
            ${reopenBtn}
            <button class="sbtn muted" data-action="task-child" data-id="${t.id}">+子</button>
            <button class="sbtn muted" data-action="task-edit" data-id="${t.id}">編集</button>
          </div>
        </div>
      </div>`;
    return row + (isCollapsed ? "" : children.map((c) => renderNode(c, depth + 1)).join(""));
  };
  return roots.map((t) => renderNode(t, 0)).join("");
}

function renderPlan() {
  /* 検索・絞り込みUIの状態反映 */
  const sInput = document.getElementById("task-search");
  if (sInput && sInput.value !== searchQuery) sInput.value = searchQuery;
  const clearBtn = document.getElementById("search-clear");
  if (clearBtn) clearBtn.classList.toggle("hidden", !searchQuery);
  document.querySelectorAll(".fchip").forEach((el) =>
    el.classList.toggle("on", el.dataset.v === archFilter)
  );

  const visible = computeVisibleTasks();
  const searching = !!searchQuery.trim();
  const list = document.getElementById("issue-list");
  const tk = todayKey();

  list.innerHTML = state.issues.length
    ? state.issues
        .map((g) => {
          const issueArchived = !!g.archived;
          /* 絞り込み:通常=未アーカイブ課題のみ / アーカイブ=アーカイブ課題+アーカイブタスクを含む課題 / すべて=全部 */
          const roots = issueArchived
            ? orderedRoots(g.id)
            : orderedRoots(g.id).filter((t) => visible.has(t.id));
          if (archFilter === "active" && issueArchived) return "";
          if (archFilter === "archived" && !issueArchived && !roots.length) return "";
          if (searching && !roots.length && !issueArchived) return "";
          const cnt = issueArchived
            ? state.tasks.filter((t) => t.issueId === g.id).length
            : state.tasks.filter((t) => t.issueId === g.id && visible.has(t.id)).length;
          const c = issueColor(g.id);
          const open = searching || openIssueIds.has(g.id);
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
          const body = open
            ? `
            ${g.purpose ? `<div class="issue-purpose">目的: ${esc(g.purpose)}</div>` : ""}
            ${targets ? `<div class="issue-targets">${targets}</div>` : ""}
            <div class="issue-tasks">
              ${roots.length ? renderTaskTree(roots, issueArchived ? null : visible) : `<div class="plan-empty">${searching ? "一致するタスクはありません。" : "この課題のタスクはまだありません。"}</div>`}
            </div>
            <div class="issue-foot">
              <button class="sbtn" data-action="task-add-issue" data-id="${g.id}">+ タスク</button>
              <button class="sbtn muted" data-action="issue-edit" data-id="${g.id}">課題を編集</button>
            </div>`
            : "";
          return `
          <div class="swipe-wrap${issueArchived ? "" : " swipeable"}">
            ${issueArchived ? "" : `<div class="swipe-action"><button data-action="issue-archive" data-id="${g.id}">📦<br>アーカイブ</button></div>`}
            <div class="issue-card swipe-target" data-issue="${g.id}" style="border-left-color:${c}">
              <div class="issue-top" data-action="issue-open" data-id="${g.id}">
                <span class="drag-h" title="ドラッグで並べ替え">⋮⋮</span>
                <span class="caret">${open ? "▾" : "▸"}</span>
                <div style="flex:1;min-width:0;">
                  <div class="issue-title">${issueArchived ? "📦 " : ""}${esc(g.title)}</div>
                  ${!open ? `<div class="issue-purpose">タスク ${cnt}件</div>` : ""}
                </div>
                ${issueArchived ? `<button class="sbtn" data-action="issue-unarchive" data-id="${g.id}">解除</button>` : dl}
              </div>
              ${body}
            </div>
          </div>`;
        })
        .join("")
    : `<div class="plan-empty">課題を登録すると、目的・目標(S/A/B…)・期日とあわせて管理できます。</div>`;

  /* 未分類タスク */
  const tree = document.getElementById("task-tree");
  const orphanRoots = orderedRoots(null).filter((t) => visible.has(t.id));
  tree.innerHTML = orphanRoots.length
    ? renderTaskTree(orphanRoots, visible)
    : `<div class="plan-empty">${searching ? "一致するタスクはありません。" : "課題に紐づかないタスクはここに表示されます。"}</div>`;
}

/* ---------- アーカイブ ---------- */
function archiveIssue(id) {
  const g = issueById(id);
  if (!g) return;
  g.archived = true;
  save();
  renderPlan();
  showSnack("課題をアーカイブしました", "キャンセル", () => {
    const x = issueById(id);
    if (x) { x.archived = false; save(); renderPlan(); }
  });
}

function archiveTask(id) {
  const t = taskById(id);
  if (!t) return;
  t.archived = true;
  save();
  renderPlan();
  showSnack("アーカイブしました", "キャンセル", () => {
    const x = taskById(id);
    if (x) { x.archived = false; save(); renderPlan(); }
  });
}

function showSnack(msg, actionLabel, cb) {
  const bar = document.getElementById("snackbar");
  const msgEl = document.getElementById("snack-msg");
  const act = document.getElementById("snack-act");
  if (!bar) return;
  msgEl.textContent = msg;
  act.textContent = actionLabel || "";
  act.style.display = actionLabel ? "" : "none";
  act.onclick = () => {
    bar.classList.add("hidden");
    if (cb) cb();
  };
  bar.classList.remove("hidden");
  clearTimeout(showSnack._t);
  showSnack._t = setTimeout(() => bar.classList.add("hidden"), 5000);
}

function renderAll() {
  renderHeader();
  const fab = document.getElementById("fab");
  if (fab) fab.style.display = view === "today" && execEditable(viewDate) ? "" : "none";
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
  const isSummary = type === "summary";
  document.getElementById("rec-block").classList.toggle("hidden", type !== "recurring");
  document.getElementById("period-block").classList.toggle("hidden", type === "recurring" || isSummary);
  document.getElementById("t-est").parentElement.classList.toggle("hidden", isSummary);
  document.getElementById("t-defstart").parentElement.classList.toggle("hidden", isSummary);
  const kind = document.getElementById("t-rkind").value;
  document.getElementById("rec-ndays").classList.toggle("hidden", kind !== "everyNDays");
  document.getElementById("rec-weekly").classList.toggle("hidden", kind !== "weekly");
  document.getElementById("rec-monthly").classList.toggle("hidden", kind !== "monthly");
  document.getElementById("rec-yearly").classList.toggle("hidden", kind !== "yearly");
  const rs = document.getElementById("t-rsmode").value;
  document.getElementById("rs-n").classList.toggle("hidden", rs !== "after" && rs !== "before");
  document.getElementById("rs-wd").classList.toggle("hidden", rs !== "weekday");
}

function openTaskForm(task, parentId, presetIssueId) {
  editingTaskId = task ? task.id : null;
  fillParentGoalSelects(editingTaskId);
  document.getElementById("task-form-title").textContent = task ? "タスクを編集" : "タスクを追加";
  document.getElementById("t-title").value = task ? task.title : "";
  document.getElementById("t-parent").value = task ? task.parentId || "" : parentId || "";
  const parent = parentId ? taskById(parentId) : null;
  document.getElementById("t-goal").value = task
    ? task.issueId || ""
    : parent
      ? parent.issueId || ""
      : presetIssueId || "";
  document.getElementById("t-type").value = task ? task.type : "single";
  document.getElementById("t-est").value = task ? task.estimateMin : 25;
  document.getElementById("t-defstart").value = task ? task.defStart || "09:00" : "09:00";
  document.getElementById("t-pstart").value = task ? task.planStart || "" : "";
  document.getElementById("t-pend").value = task ? task.planEnd || "" : "";
  document.getElementById("t-notes").value = task ? task.notes || "" : "";
  document.getElementById("t-anchor").value = todayKey();
  const rr = task && task.reserveRule;
  document.getElementById("t-rsmode").value = rr ? rr.mode : "";
  document.getElementById("t-rsn").value = rr && rr.n ? rr.n : 1;
  document.getElementById("t-rswd").value = rr && rr.weekday !== undefined ? rr.weekday : 6;
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

function readReserveRule() {
  const mode = document.getElementById("t-rsmode").value;
  if (!mode) return null;
  if (mode === "weekday") {
    return { mode, weekday: Number(document.getElementById("t-rswd").value) || 0 };
  }
  return { mode, n: Math.max(1, Number(document.getElementById("t-rsn").value) || 1) };
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
    estimateMin: type === "summary" ? 0 : Math.max(1, Number(document.getElementById("t-est").value) || 25),
    defStart: document.getElementById("t-defstart").value || "09:00",
    planStart: type === "recurring" || type === "summary" ? null : ps,
    planEnd: type === "recurring" || type === "summary" ? null : pe,
    recurrence: type === "recurring" ? readRecurrence() : null,
    reserveRule: type === "recurring" ? readReserveRule() : null,
    notes: document.getElementById("t-notes").value.trim(),
  };
  let savedId;
  if (editingTaskId) {
    Object.assign(taskById(editingTaskId), data);
    savedId = editingTaskId;
  } else {
    savedId = uid("t");
    state.tasks.push({ id: savedId, done: false, createdDate: todayKey(), ...data });
  }
  editingTaskId = null;
  document.getElementById("task-form").classList.add("hidden");
  if (data.issueId) {
    openIssueIds.add(data.issueId); // 保存先の課題を開いた状態にする
    saveOpenIssues();
  }
  materializeToday();
  save();
  /* 保存した行が確実に見える状態にする(祖先の展開・絞り込みの解除) */
  {
    let anc = data.parentId ? taskById(data.parentId) : null;
    while (anc) {
      collapsedIds.delete(anc.id);
      anc = anc.parentId ? taskById(anc.parentId) : null;
    }
    saveCollapsed();
    const savedTask = taskById(savedId);
    const q = searchQuery.trim().toLowerCase();
    if (q && savedTask && !savedTask.title.toLowerCase().includes(q)) searchQuery = "";
    if (archFilter === "archived" && savedTask && !savedTask.archived) {
      archFilter = "active";
      localStorage.setItem("hisho:ui:archfilter", archFilter);
    }
  }
  renderPlan();
  /* 保存したタスクの位置までスクロールして一瞬ハイライト */
  requestAnimationFrame(() => {
    const el = document.querySelector(`.p-row[data-task="${savedId}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1200);
    }
  });
}

/* ---------- スプレッドシート同期(双方向) ---------- */
const SYNC_URL_KEY = "hisho:sync:url";
const SYNC_TOKEN_KEY = "hisho:sync:token";
const LAST_SYNC_KEY = "hisho:sync:last";
const DIRTY_KEY = "hisho:sync:dirty";
let syncTimer = null;
let syncing = false;

const syncConfigured = () => !!localStorage.getItem(SYNC_URL_KEY);

function syncFixedOffset() {
  const bars = document.getElementById("fixedbars");
  const wrap = document.querySelector(".wrap");
  if (bars && wrap) wrap.style.marginTop = bars.offsetHeight ? `${bars.offsetHeight}px` : "";
}

function updateSyncWarn() {
  const el = document.getElementById("sync-warn");
  if (!el) return;
  const busy = typeof syncing !== "undefined" && syncing;
  const show = syncConfigured() && (localStorage.getItem(DIRTY_KEY) === "1" || busy);
  el.textContent = busy ? "⏳ 同期しています…" : "⚠ 未同期の変更があります — タップで今すぐ同期";
  el.classList.toggle("hidden", !show);
  syncFixedOffset();
}

function setSyncMsg(text, isErr) {
  updateSyncWarn();
  const el = document.getElementById("sync-status");
  if (el) {
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }
  const m = document.getElementById("settings-msg");
  const ov = document.getElementById("settings-overlay");
  if (m && ov && !ov.classList.contains("hidden")) {
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
    worklog: state.assignments.map((a) => {
      const sec = (a.spentSec || 0) + (a.status === "doing" && a.startedAt ? (Date.now() - a.startedAt) / 1000 : 0);
      return {
        id: a.id,
        date: a.date,
        start: a.start,
        title: asgTitle(a),
        plan: a.estimateMin || 0,
        actual: Math.round(sec / 6) / 10,
        status: a.status,
        closed: isClosed(a.date) ? "締" : "",
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
async function pushSync(manual, useKeepalive) {
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
    const body = JSON.stringify({
      token: localStorage.getItem(SYNC_TOKEN_KEY) || "",
      updatedAt: state.updatedAt || 0,
      state,
      readable: readablePayload(),
    });
    // keepalive付きfetchはボディが64KBを超えると送信自体が失敗する仕様のため、
    // タブを閉じる瞬間の即時送信(useKeepalive)でもサイズが収まる時だけ付ける
    const canKeepalive = !!useKeepalive && new Blob([body]).size < 65536;
    const res = await fetch(localStorage.getItem(SYNC_URL_KEY), {
      method: "POST",
      keepalive: canKeepalive,
      body,
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
  updateSyncWarn(); // 同期終了後にバナー表示を更新
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
    updateSyncWarn();
    return;
  }
  syncing = false;
  updateSyncWarn();
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

/* ---------- ミニタイマー(タイマーが見えないときの上部バナー) ---------- */
function updateMiniTimer() {
  const bar = document.getElementById("mini-timer");
  if (!bar) return;
  const run = runningAsg();
  let show = false;
  if (run) {
    if (view !== "today" || viewDate !== todayKey()) {
      show = true;
    } else {
      const hero = document.getElementById("hero");
      const r = hero ? hero.getBoundingClientRect() : null;
      show = r ? r.bottom < 70 : true;
    }
  }
  if (show) {
    const over = isOver(run);
    bar.classList.toggle("over", over);
    bar.textContent = `${over ? "⚠" : "▶"} ${asgTitle(run)} — ${fmtDur(elapsedSec(run))} / ${run.estimateMin}:00`;
  }
  const wasHidden = bar.classList.contains("hidden");
  bar.classList.toggle("hidden", !show);
  if (wasHidden !== !show) syncFixedOffset();
}

/* ---------- 毎秒の処理 ---------- */
function tick() {
  const run = runningAsg();
  const over = !!(run && isOver(run));
  updateMiniTimer();
  if (run && over && overNotifiedId !== run.id) {
    overNotifiedId = run.id; // 1回の開始に対して1回だけ通知
    beep();
    notify("見積時間を超過しました", `「${asgTitle(run)}」を切り上げるか、続行するか選んでください`);
  }
  if (view !== "today") return;
  const cur = currentAsg();
  const curId = cur ? cur.id : null;
  if (curId !== renderedCurrentId || over !== renderedOverrun) {
    renderAll();
  } else {
    updateTimerVisuals(cur);
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
  else if (action === "mini-jump") {
    viewDate = todayKey();
    switchView("today");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  else if (action === "d-prev") { viewDate = addDays(viewDate, -1); renderAll(); }
  else if (action === "d-next") { viewDate = addDays(viewDate, 1); renderAll(); }
  else if (action === "d-today") { viewDate = todayKey(); renderAll(); }
  else if (action === "day-close") {
    if (viewDate > todayKey()) return;
    if (dayList(viewDate).some((a) => a.status === "doing")) {
      alert("作業中のタイマーがあります。完了か中断をしてから締めてください。");
      return;
    }
    if (confirm("この日を締めますか?締め後はこの日の編集ができなくなります。")) {
      state.closedDates.push(viewDate);
      save();
      renderAll();
    }
  }
  else if (action === "day-open") {
    state.closedDates = state.closedDates.filter((dk) => dk !== viewDate);
    save();
    renderAll();
  }

  /* ガント */
  else if (action === "g-prev") { gStart = addDays(gStart, -14); renderGantt(); }
  else if (action === "g-next") { gStart = addDays(gStart, 14); renderGantt(); }
  else if (action === "g-today") { gStart = addDays(todayKey(), -7); selDate = todayKey(); renderGantt(); }
  else if (action === "g-selday") {
    selDate = btn.dataset.date;
    document.getElementById("asg-form").classList.add("hidden");
    editingAsgId = null;
    renderGantt();
  } else if (action === "g-cell") {
    if (!suppressClick) toggleCell(btn.dataset.task, btn.dataset.date);
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
  else if (action === "issue-open") {
    if (suppressClick) return;
    if (openIssueIds.has(id)) openIssueIds.delete(id);
    else openIssueIds.add(id);
    saveOpenIssues();
    renderPlan();
  } else if (action === "task-add-issue") {
    openTaskForm(null, null, id);
  } else if (action === "g-showname") {
    showNameTip(btn.dataset.name, btn);
  } else if (action === "issue-add") openIssueForm(null);
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
      /* 削除前に、スクロール先のアンカー(親→隣のタスク→課題)を決めておく */
      const delTask = taskById(editingTaskId);
      let anchorTask = null;
      let anchorIssue = null;
      if (delTask) {
        anchorIssue = delTask.issueId || null;
        if (delTask.parentId) {
          anchorTask = delTask.parentId;
        } else {
          const sibs = orderedRoots(delTask.issueId || null).filter((x) => x.id !== delTask.id);
          const all = orderedRoots(delTask.issueId || null);
          const idx = all.findIndex((x) => x.id === delTask.id);
          const near = all[idx - 1] || all[idx + 1] || sibs[0] || null;
          anchorTask = near ? near.id : null;
        }
      }
      removeTaskDef(editingTaskId);
      editingTaskId = null;
      document.getElementById("task-form").classList.add("hidden");
      requestAnimationFrame(() => {
        const el =
          (anchorTask && document.querySelector(`.p-row[data-task="${anchorTask}"]`)) ||
          (anchorIssue && document.querySelector(`.issue-card[data-issue="${anchorIssue}"]`)) ||
          document.getElementById("task-tree");
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  }

  /* 設定 */
  else if (action === "settings-open") {
    document.getElementById("settings-overlay").classList.remove("hidden");
    document.getElementById("s-url").value = localStorage.getItem(SYNC_URL_KEY) || "";
    document.getElementById("s-token").value = localStorage.getItem(SYNC_TOKEN_KEY) || "";
    document.getElementById("settings-msg").textContent = "";
  } else if (action === "settings-close") {
    document.getElementById("settings-overlay").classList.add("hidden");
  } else if (action === "g-help") {
    document.getElementById("help-overlay").classList.remove("hidden");
  } else if (action === "g-help-close") {
    document.getElementById("help-overlay").classList.add("hidden");
  } else if (action === "node-toggle") {
    if (collapsedIds.has(id)) collapsedIds.delete(id);
    else collapsedIds.add(id);
    saveCollapsed();
    renderAll();
  } else if (action === "task-reopen") {
    const t = taskById(id);
    if (t) { t.done = false; t.archived = false; save(); renderPlan(); }
  } else if (action === "task-archive") {
    if (!suppressClick) archiveTask(id);
  } else if (action === "issue-archive") {
    if (!suppressClick) archiveIssue(id);
  } else if (action === "issue-unarchive") {
    const g = issueById(id);
    if (g) { g.archived = false; save(); renderPlan(); }
  } else if (action === "task-unarchive") {
    const t = taskById(id);
    if (t) { t.archived = false; save(); renderPlan(); }
  } else if (action === "arch-filter") {
    archFilter = btn.dataset.v;
    localStorage.setItem("hisho:ui:archfilter", archFilter);
    renderPlan();
  } else if (action === "search-clear") {
    searchQuery = "";
    renderPlan();
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

let searchTimer = null;
document.addEventListener("input", (e) => {
  if (e.target.id === "task-search") {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value;
      const focused = document.activeElement;
      renderPlan();
      if (focused && focused.id === "task-search") {
        const el = document.getElementById("task-search");
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 200);
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "t-type" || e.target.id === "t-rkind" || e.target.id === "t-rsmode") updateRecVisibility();
  if (e.target.id === "g-showarch") {
    showArch = e.target.checked;
    localStorage.setItem("hisho:ui:showarch", showArch ? "1" : "0");
    renderGantt();
  }
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
  if (document.visibilityState === "hidden") {
    /* 閉じる・切り替えの瞬間、未送信があれば即時送信(keepaliveで送信は継続される) */
    if (syncConfigured() && navigator.onLine && localStorage.getItem(DIRTY_KEY) === "1") {
      clearTimeout(syncTimer);
      pushSync(false, true);
    }
    return;
  }
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
updateSyncWarn();
fullSync(false);
setInterval(tick, 1000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
