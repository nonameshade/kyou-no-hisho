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
const APP_VERSION = "v113"; // sw.jsのCACHE版数と揃えて更新すること

/* 今日タブのカード編集ボタン用に新規デザインした鉛筆アイコン(SVG) */
const PENCIL_ICON = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M13.4 3.4a1.5 1.5 0 0 1 2.12 0l1.08 1.08a1.5 1.5 0 0 1 0 2.12L7.5 15.7l-4 1 1-4L13.4 3.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="M11.8 5 15 8.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

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
const minToHm = (m) => `${pad(Math.floor(m / 60))}:${pad(((m % 60) + 60) % 60)}`;
/* 2つの割り当て(開始+見積)の実施時間帯が重なるか */
const timeOverlap = (a, b) =>
  hmToMin(a.start) < hmToMin(b.start) + b.estimateMin &&
  hmToMin(b.start) < hmToMin(a.start) + a.estimateMin;
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
let taskFormReturnAnchor = null; // キャンセル時に戻る行のid(編集なら本人、子タスク追加なら親)
let editingIssueId = null;
let editingAsgQuickId = null; // 今日タブの鉛筆アイコンから開く簡易編集(開始時刻・見積のみ)の対象id
let gcellEdit = null; // 計画タブのマス長押し/右クリック編集の対象 { taskId, date }
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

/* 日跨ぎで継続中の作業も拾うため、全日付から検索(前日の作業とみなす) */
const runningAsg = () => state.assignments.find((a) => a.status === "doing") || null;

const elapsedSec = (a) =>
  a.spentSec + (a.status === "doing" && a.startedAt ? (Date.now() - a.startedAt) / 1000 : 0);

const isOver = (a) => elapsedSec(a) > a.estimateMin * 60;

/* 「実際の今日」における次にやること/作業中を返す。viewDate(閲覧中の日付)には
   依存しない(過去日・未来日を見ていてもヘッダーのタイマーバナーは常に
   本当の今日を基準に表示するため) */
function nextTodayAsg() {
  const list = dayList(todayKey());
  const run = runningAsg();
  if (run) return run;
  const started = list.filter((a) => a.status !== "done" && hmToMin(a.start) <= nowMin());
  if (started.length) {
    /* 同じ開始時刻が複数ある場合は一番上(先に描画される方)を対象にする */
    const latest = hmToMin(started[started.length - 1].start);
    return started.find((a) => hmToMin(a.start) === latest);
  }
  return list.find((a) => a.status !== "done") || null;
}

/* タイムラインのカード強調(緑)用。閲覧中の日付(viewDate)が本当の今日と
   一致している時だけ「次にやること」まで含めて有効(過去日・未来日の
   タイムラインでは強調しない)。ただし、日をまたいで計測中のタスクが
   閲覧中の日付(=そのタスク本来の日付)のものであれば、今日でなくても
   常に優先して強調する */
function currentAsg() {
  const run = runningAsg();
  if (run && run.date === viewDate) return run;
  if (viewDate !== todayKey()) return null;
  return nextTodayAsg();
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

/* 周期タスクの1回分(dk)だけを実体化する(他の日には影響しない)。既にあればそれを返す */
function materializeOccurrence(taskId, dk) {
  const existing = state.assignments.find((a) => a.taskId === taskId && a.date === dk);
  if (existing) return existing;
  const t = taskById(taskId);
  if (!t) return null;
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
  return a;
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

/* 今日タブへのタスク追加で開始時刻が未入力の時のデフォルト値。
   今日の最後のカード(開始時刻が一番遅いもの)の終了時刻(開始+見積)を返す。
   今日にまだ何もなければnullを返す */
function lastTodayEnd() {
  const list = dayItems(todayKey());
  if (!list.length) return null;
  const last = list[list.length - 1];
  return minToHm(hmToMin(last.start) + (last.estimateMin || 0));
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
  /* 計画タブでの縦フェイクスクロール/慣性が終わらないまま別タブへ切り替えると、
     .wrapのtransformが新しいタブの内容に残ったままになってしまうため、
     切り替え前に確定させておく */
  if (view === "gantt" && v !== "gantt" && (gScrollFallback || gMomentumRAF)) {
    if (gScrollRAF) { cancelAnimationFrame(gScrollRAF); gScrollRAF = null; }
    if (gMomentumRAF) { cancelAnimationFrame(gMomentumRAF); gMomentumRAF = null; }
    gFinalizeScrollFallback();
  }
  /* 計画タブに入るたびに「選択日のタスクのみ表示」の対象を最新化する
     (前回タブを離れてからの変更を反映するため。タブ滞在中の個々のマーク
     編集では更新しない、recomputeSelDayVisible()のコメント参照) */
  if (v === "gantt" && selDayOnly) recomputeSelDayVisible();
  view = v;
  document.body.dataset.view = v;
  document.querySelectorAll(".tab").forEach((el) =>
    el.classList.toggle("active", el.dataset.tab === v)
  );
  document.getElementById("view-today").classList.toggle("hidden", v !== "today");
  document.getElementById("view-gantt").classList.toggle("hidden", v !== "gantt");
  document.getElementById("view-plan").classList.toggle("hidden", v !== "plan");
  /* #fixedbars(タイマーバナーの表示/非表示で高さが変わりうる)の高さを
     確定させてからrenderAll()を呼ぶ。順序が逆だと、計画タブのガント見出しの
     固定位置(#fixedbarsの高さを基準に計算)が古い高さで計算されてしまい、
     直後のスクロールで正しい位置へ動いて見える不具合になる */
  updateMiniTimer();
  renderAll();
  if (v === "gantt") startGanttStickyLoop();
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
  if (tl) tl.textContent = "タイムライン";
  const adjBtn = document.getElementById("timeline-adjust-btn");
  if (adjBtn) adjBtn.disabled = !execEditable(viewDate);
  const list = dayItems(viewDate);
  const done = list.filter((a) => a.status === "done").length;
  if (viewDate === tk) {
    const rest = list.filter((a) => a.status !== "done").reduce((s, a) => s + a.estimateMin, 0);
    document.getElementById("stats").innerHTML =
      `<div>残り ${Math.floor(rest / 60)}時間${rest % 60}分</div><div>完了 ${done} / ${list.length}</div>`;
  } else {
    const plan = list.reduce((s, a) => s + (a.estimateMin || 0), 0);
    const actual = list.reduce((s, a) => s + (a.spentSec || 0), 0);
    document.getElementById("stats").innerHTML =
      `<div>予定 ${fmtH(plan)} ・ 実績 ${fmtH(Math.round(actual / 60))}</div><div>完了 ${done} / ${list.length}</div>`;
  }
}

/* ---------- 描画:今日 ---------- */

/* タイムラインの自動調整:開始時刻が重複するカードを見積時間ぶんずらす。
   ずらした結果が次の(重複していない)カードの開始時刻以降になってしまう場合は、
   衝突が起きる直前のカードと同じ開始時刻に戻す。以降のカードも、その「直前のカード」を
   基準にした計算が衝突し続ける限り、間に何枚あっても同じ開始時刻のままになる
   (仮想の自動予定は対象外) */
/* 完了済みで、かつ未来の時刻に置かれているカードは所要時間0分として扱う
   (自動調整の空き時間計算で他のカードを不必要にブロックしないように) */
const autoAdjustEstimate = (a, now) =>
  a.status === "done" && hmToMin(a.start) > now ? 0 : a.estimateMin || 0;

function autoAdjustTimeline() {
  if (!execEditable(viewDate)) return;
  const now = nowMin();
  const items = state.assignments
    .filter((a) => a.date === viewDate)
    .sort((x, y) => hmToMin(x.start) - hmToMin(y.start));
  let changed = false;
  if (items.length >= 2) {
    const origStart = items.map((a) => hmToMin(a.start));
    const adjStart = origStart.slice();
    let i = 0;
    while (i < items.length) {
      let j = i + 1;
      while (j < items.length && origStart[j] === origStart[i]) j++;
      const nextBoundary = j < items.length ? origStart[j] : Infinity;
      let refStart = adjStart[i];
      let refEst = autoAdjustEstimate(items[i], now);
      for (let k = i + 1; k < j; k++) {
        const candidate = refStart + refEst;
        if (candidate >= nextBoundary) {
          adjStart[k] = refStart; // 基準(ref)は更新しない → 以降も同じ時刻が続く
        } else {
          adjStart[k] = candidate;
          refStart = candidate;
          refEst = autoAdjustEstimate(items[k], now);
        }
      }
      i = j;
    }
    items.forEach((a, idx) => {
      const hm = minToHm(adjStart[idx]);
      if (hm !== a.start) {
        a.start = hm;
        changed = true;
      }
    });
  }
  if (autoAdjustPastCards(now)) changed = true;
  if (changed) {
    save();
    renderAll();
  }
}

/* 自動調整②: 現在時刻カード(緑)より上にある未完了カードを、空き時間へ移動する。
   1. 上にあるカードから優先的に処理する
   2. 空き時間を先頭(現在時刻)から探し、他のカード(緑のカード・未来のカード・完了済み
      カード・既に移動した過去のカード)と重ならない最初の隙間に入れる
   3. 隙間が無ければ最後のカードの後ろに置く(検索ループが自然にそこへ辿り着く)
   例外: 開始時刻は過去でも、既に計測履歴があり(経過時間>0)、かつ
   「開始時刻+残見積(見積-経過)」が現在時刻より未来のカードは対象外とし、
   そのままの位置に残す(実施中で時間がかかっているカードが後ろへ回されて
   しまうのを防ぐ) */
function autoAdjustPastCards(now) {
  const cur = currentAsg();
  if (!cur) return false; // 今日タブ以外、または現在該当するカードが無い時は対象外
  const list = dayList(todayKey());
  const curIndex = list.findIndex((a) => a.id === cur.id);
  if (curIndex <= 0) return false;
  const pastCards = list.slice(0, curIndex).filter((a) => {
    if (a.status === "done") return false;
    const elapsed = elapsedSec(a);
    if (elapsed > 0) {
      const remainingMin = Math.max(0, a.estimateMin - elapsed / 60);
      if (hmToMin(a.start) + remainingMin > now) return false;
    }
    return true;
  });
  if (!pastCards.length) return false;

  const pastIds = new Set(pastCards.map((a) => a.id));
  const occupied = list
    .filter((a) => !pastIds.has(a.id))
    .map((a) => ({ start: hmToMin(a.start), end: hmToMin(a.start) + autoAdjustEstimate(a, now) }))
    .sort((x, y) => x.start - y.start);

  let changed = false;
  pastCards.forEach((a) => {
    const est = a.estimateMin || 0;
    let cursor = now;
    for (const o of occupied) {
      if (o.start > cursor && o.start - cursor >= est) break;
      if (o.end > cursor) cursor = o.end;
    }
    const hm = minToHm(cursor);
    if (hm !== a.start) {
      a.start = hm;
      changed = true;
    }
    occupied.push({ start: cursor, end: cursor + est });
    occupied.sort((x, y) => x.start - y.start);
  });
  return changed;
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
      /* 現在時刻(緑=active)を優先し、それ以外で他のカードと理論上重なるものだけ薄い赤にする */
      const conflict = !active && list.some((b, j) => j !== idx && timeOverlap(a, b));
      const crumb = a.taskId ? crumbOf(a.taskId) : "";
      const showTime = idx === 0 || list[idx - 1].start !== a.start;
      const running = a.status === "doing";
      const startable = !a.virtual && editable && !done;
      const tapStart = startable ? ` data-action="${running ? "pause" : "start"}" data-id="${a.id}"` : "";
      const checkDisabled = a.virtual || !editable;
      const checkbox = `<input type="checkbox" class="t-check" data-action="finish-toggle" data-id="${a.virtual ? "" : a.id}"${done ? " checked" : ""}${checkDisabled ? " disabled" : ""} aria-label="完了">`;
      const actions = a.virtual || !editable
        ? `<span class="virtual-tag">${a.virtual ? "🔁" : "🔒"}</span>`
        : `<button class="sbtn muted t-edit" data-action="asg-edit-open" data-id="${a.id}" aria-label="編集">${PENCIL_ICON}</button>`;
      return `
        <div class="t-item ${done ? "done" : ""} ${active ? "active" : ""} ${conflict ? "conflict" : ""}"
             data-asg="${a.virtual ? "" : a.id}" data-virtual="${a.virtual ? "1" : "0"}" data-task="${a.taskId || ""}"
             data-draggable="${editable ? "1" : "0"}"
             data-start="${a.start}" data-est="${a.estimateMin}">
          <div class="t-time">${showTime ? a.start : ""}</div>
          <div class="t-dot"></div>
          <div class="t-card"${tapStart}>
            ${checkbox}
            <div class="t-main">
              ${crumb ? `<div class="t-crumb">${esc(crumb)} ›</div>` : ""}
              <div class="t-name">${esc(asgTitle(a))}</div>
              <div class="t-est">${fmtDur(elapsedSec(a))} / ${fmtDur(a.estimateMin * 60)}${running ? ` <span class="t-running-tag">作業中</span>` : ""}</div>
            </div>
            <div class="t-actions">${actions}</div>
          </div>
        </div>`;
    })
    .join("");
  renderDayClose();
  /* 描画確定後でないと位置が測れない。端末によっては1回のrAFではレイアウトが
     完全に落ち着く前に測ってしまい線がずれることがあるため2回分待つ */
  requestAnimationFrame(() => requestAnimationFrame(updateNowLine));
}

/* 固定ヘッダー(#fixedbars)とスティッキーのタイムライン見出しの高さぶんを差し引いて、
   カードがそれらの直下に来る位置までスクロールする */
function scrollToTimelineCard(el) {
  const fixedH = document.getElementById("fixedbars").offsetHeight;
  const head = document.getElementById("timeline-head");
  const headH = head ? head.getBoundingClientRect().height : 0;
  const rect = el.getBoundingClientRect();
  const targetY = window.scrollY + rect.top - fixedH - headH - 8;
  window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
}

/* 現在時刻を示す横線を#timeline内に描く。カードや時刻グラフの背後(z-index低)に表示し、
   実施中カードの中では見積に対する経過割合で補間、カード間では直前カードの下端に置く */
function updateNowLine() {
  /* ドラッグ中のカードはposition:fixedで指の位置に追従しているため、
     ここで再計算すると線がそのカードの位置を拾ってしまい一緒に動いて見える。
     呼び出し元の対策漏れがあっても崩れないよう、ここでも必ず止めておく */
  if (tlDrag || tlPending || tlScrollFallback) return;
  const box = document.getElementById("timeline");
  if (!box) return;
  let line = document.getElementById("tl-now-line");
  if (viewDate !== todayKey()) {
    if (line) line.style.display = "none";
    return;
  }
  const items = [...box.querySelectorAll(".t-item")];
  if (!items.length) {
    if (line) line.style.display = "none";
    return;
  }
  if (!line) {
    line = document.createElement("div");
    line.id = "tl-now-line";
    box.insertBefore(line, box.firstChild); // 常に最初の子要素にして背後に来るようにする
  }
  const now = nowMin();
  const boxRect = box.getBoundingClientRect();
  let top = 0;
  for (const el of items) {
    const start = hmToMin(el.dataset.start);
    const est = Number(el.dataset.est) || 0;
    const r = el.getBoundingClientRect();
    const relTop = r.top - boxRect.top;
    const relBottom = r.bottom - boxRect.top;
    if (now < start) { top = relTop; break; }
    if (now < start + est) {
      const ratio = est > 0 ? (now - start) / est : 0;
      top = relTop + (relBottom - relTop) * ratio;
      break;
    }
    top = relBottom;
  }
  line.style.top = `${top}px`;
  line.style.display = "";
}

/* ---------- 今日タブ:カードの長押しドラッグで開始時刻を変更 ---------- */
let tlPending = null; // 長押し判定待ち { item, px, py }
let tlScrollFallback = false; // 長押し確定前にスワイプ(スクロール)とみなした後、手動スクロールを代行中か
let tlScrollStartY = 0; // フォールバック開始時の指のY座標(基準点)
let tlScrollStartScrollY = 0; // フォールバック開始時のスクロール位置(基準点)
let tlScrollMaxY = 0; // フォールバック開始時点でのスクロール可能な最大値(上下端のクランプ用)
let tlHeadStickyTop = 0; // #timeline-headのsticky吸着位置(--fixed-hを解決した実際のpx値)
let tlHeadNaturalK = 0; // #timeline-headの本来の(吸着していない)位置 - フォールバック開始時のスクロール位置
let tlHeadBaseRendered = 0; // フォールバック開始時点(offset=0)での実際の描画位置(吸着中ならtlHeadStickyTopと同じ)
let tlHeadSettleGen = 0; // position:fixed引き渡し待ち(settle)の世代カウンタ。前のジェスチャーのreleaseが後発ジェスチャーのfixedを誤って解除しないためのガード
let tlScrollPendingY = null; // まだ画面に反映していない最新の指のY座標
let tlScrollRAF = null;
let tlScrollVelSamples = []; // 慣性スクロール用、直近の指位置サンプル { t, y }
let tlMomentumRAF = null; // 指を離した後の慣性スクロールのrAFハンドル
let tlDrag = null; // ドラッグ中 { el, id, estimateMin, py, curY, scrollStart, others, gapIndex }
let tlLongPressTimer = null;
let tlAutoScrollSpeed = 0;
let tlAutoScrollRAF = null;

/* 開始時刻(分)を計算する4ルール。above/belowはnull可、estimateMinは動かしているカードの見積 */
function tlComputeStart(above, below, estimateMin) {
  if (!above && !below) return null;
  if (above) {
    const aboveEnd = above.start + above.estimateMin;
    if (!below || aboveEnd + estimateMin <= below.start) return aboveEnd; // ルール2/上のみ
    return above.start; // ルール4(下と衝突するので上と同じ開始時刻)
  }
  return Math.max(0, below.start - estimateMin); // ルール3(上が無い)
}

/* gapIndexに応じて他のカードをずらして隙間を空け、開始時刻プレビューを更新する。
   掴んだ元の位置には高さ保持用のプレースホルダーを置いたままにしているため、
   「元の位置(originalIndex)から現在のgapIndexまでの範囲」だけをずらせばよい。
   掴んだ直後(まだ指を動かしていない時)はgapIndex===originalIndexなので、
   他のカードは動かない。実際にドラッグして位置が変わった時だけ、その範囲だけが動く */
function tlApplyGap(gapIndex) {
  const orig = tlDrag.originalIndex;
  tlDrag.others.forEach((o, i) => {
    let shift = 0;
    if (gapIndex > orig && i >= orig && i < gapIndex) shift = -tlDrag.height;
    else if (gapIndex < orig && i >= gapIndex && i < orig) shift = tlDrag.height;
    o.el.style.transform = shift ? `translateY(${shift}px)` : "";
  });
  tlDrag.gapIndex = gapIndex;
  const above = tlDrag.others[gapIndex - 1] || null;
  const below = tlDrag.others[gapIndex] || null;
  const startMin = tlComputeStart(above, below, tlDrag.estimateMin);
  const timeEl = tlDrag.el.querySelector(".t-time");
  if (timeEl && startMin !== null) timeEl.textContent = minToHm(startMin);
}

/* 現在の指位置(tlDrag.curY)に合わせてカードの見た目とgapIndexを更新する(自動スクロール中も呼ぶ)。
   ドラッグ中のカードはposition:fixedなのでスクロールしても指との相対位置は変わらず、
   py側の補正は不要。他のカード(others)は通常のフローなのでスクロール量ぶんだけ
   見かけの位置がずれるため、比較時にそのぶんを差し引く */
function tlUpdateDragVisual() {
  tlDrag.el.style.transform = `translateY(${tlDrag.curY - tlDrag.py}px)`;
  const scrolled = window.scrollY - tlDrag.scrollStart;
  let idx = 0;
  tlDrag.others.forEach((o) => { if (o.midY - scrolled < tlDrag.curY) idx++; });
  if (idx !== tlDrag.gapIndex) tlApplyGap(idx);
}

function tlAutoScrollTick() {
  if (!tlDrag || !tlAutoScrollSpeed) { tlAutoScrollRAF = null; return; }
  window.scrollBy(0, tlAutoScrollSpeed);
  tlUpdateDragVisual();
  tlAutoScrollRAF = requestAnimationFrame(tlAutoScrollTick);
}

/* 画面の上端/下端付近にポインタが来たらゆっくりスクロールする。
   上端側は画面の物理的な最上部(0px)ではなく、タイムライン見出し(sticky)の
   下端を基準にする。見出しの高さぶん、実際にカードが表示され得る領域は
   画面上端よりだいぶ下から始まるため、物理的な最上部基準のままだと
   見出しの下まで来ただけではスクロールが始まらず使いにくかった */
function tlUpdateAutoScroll(clientY) {
  const EDGE = 70;
  const MAX_SPEED = 9;
  const vh = window.innerHeight;
  const head = document.getElementById("timeline-head");
  const topEdge = head ? head.getBoundingClientRect().bottom : 0;
  let speed = 0;
  if (clientY < topEdge + EDGE) {
    const dist = Math.max(0, topEdge + EDGE - clientY);
    speed = -MAX_SPEED * Math.min(1, dist / EDGE);
  } else if (clientY > vh - EDGE) {
    speed = MAX_SPEED * (1 - (vh - clientY) / EDGE);
  }
  tlAutoScrollSpeed = speed;
  if (speed && !tlAutoScrollRAF) tlAutoScrollRAF = requestAnimationFrame(tlAutoScrollTick);
}

function tlStopAutoScroll() {
  tlAutoScrollSpeed = 0;
  if (tlAutoScrollRAF) { cancelAnimationFrame(tlAutoScrollRAF); tlAutoScrollRAF = null; }
}

function tlStartDrag(item, clientY) {
  let asgId = item.dataset.asg;
  if (item.dataset.virtual === "1") {
    /* 周期タスクの自動予定はこの1回分だけ実体化する(他の日には影響しない) */
    const a = materializeOccurrence(item.dataset.task, viewDate);
    if (!a) return;
    asgId = a.id;
    item.dataset.asg = asgId;
    item.dataset.virtual = "0";
  }
  const allItemsRaw = [...document.querySelectorAll("#timeline .t-item")];
  /* 直前の操作のCSSトランジションが完了しきっていないまま次のドラッグを始めると、
     位置の測定がずれてカードが上のカードに重なる不具合があったため、
     測定前に必ずトランジション/transformを確定させておく */
  allItemsRaw.forEach((el) => {
    el.style.transition = "none";
    el.style.transform = "";
  });
  void document.getElementById("timeline").offsetHeight; // 上記を確実に反映させる

  const rect = item.getBoundingClientRect();
  const style = getComputedStyle(item);
  const originalIndex = allItemsRaw.indexOf(item); // othersの中で「元々何個前にあったか」と同じ数
  const height = rect.height + (parseFloat(style.marginBottom) || 0);
  tlDrag = {
    el: item,
    id: asgId,
    estimateMin: Number(item.dataset.est) || 0,
    height,
    originalIndex,
    py: clientY,
    curY: clientY,
    scrollStart: window.scrollY,
    others: allItemsRaw
      .filter((el) => el !== item)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, start: hmToMin(el.dataset.start), estimateMin: Number(el.dataset.est) || 0, midY: r.top + r.height / 2 };
      }),
    gapIndex: 0,
    placeholder: null,
  };
  /* 元の位置に余白(隙間)が残らないよう、ドラッグ中は文書の流れから外す。
     その分レイアウトの高さが縮んで後ろの要素(締めボタン等)がずれ上がってしまうため、
     同じ高さのプレースホルダーを代わりに挿入して高さを維持する */
  const placeholder = document.createElement("div");
  placeholder.className = "tl-placeholder";
  placeholder.style.height = `${height}px`;
  item.parentNode.insertBefore(placeholder, item);
  tlDrag.placeholder = placeholder;

  item.style.position = "fixed";
  item.style.left = `${rect.left}px`;
  item.style.top = `${rect.top}px`;
  item.style.width = `${rect.width}px`;
  item.style.margin = "0";
  item.classList.add("tl-dragging");
  try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}
  /* 掴んだ直後は元の位置のままにし、他のカードが不自然に動かないようにする */
  tlApplyGap(originalIndex);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (tlDrag) tlDrag.others.forEach((o) => { o.el.style.transition = ""; });
    });
  });
}

document.addEventListener("pointerdown", (e) => {
  const card = e.target.closest("#timeline .t-card");
  if (!card || e.target.closest(".t-actions") || e.target.closest(".t-check")) return;
  const item = card.closest(".t-item");
  if (!item || item.dataset.draggable !== "1") return;
  clearTimeout(tlLongPressTimer);
  /* 前のスワイプ/慣性スクロールがまだ終わっていなければ、新しい操作を
     始める前にスクロール位置を確定させる(指で画面を止めたのと同じ扱い) */
  if (tlScrollFallback) {
    if (tlScrollRAF) { cancelAnimationFrame(tlScrollRAF); tlScrollRAF = null; }
    if (tlMomentumRAF) { cancelAnimationFrame(tlMomentumRAF); tlMomentumRAF = null; }
    tlFinalizeScrollFallback();
  }
  tlScrollVelSamples = [];
  tlPending = { item, px: e.clientX, py: e.clientY };
  tlLongPressTimer = setTimeout(() => {
    if (tlPending) tlStartDrag(tlPending.item, tlPending.py);
    tlPending = null;
  }, 450);
});

/* フォールバック開始時の基準点からのオフセットを、上下端を超えないようクランプする */
function tlClampScrollOffset(offset) {
  const minOffset = tlScrollStartScrollY - tlScrollMaxY;
  const maxOffset = tlScrollStartScrollY;
  return Math.max(minOffset, Math.min(maxOffset, offset));
}

/* 指の最新位置に合わせて.wrap全体をtransformで見た目だけ動かす。
   window.scrollToはレイアウトを伴う重い処理で、指が触れたまま連続して
   動いている間はiOS側のタッチ追跡処理と競合して描画が追いつかず振動して
   見えることがあったため、スワイプ中はGPU合成だけで完結するtransformで
   見た目を追従させ、実際のスクロール位置は指を離した瞬間に一度だけ確定させる
   (tlPointerEndを参照) */
function tlApplyScrollFallback() {
  tlScrollRAF = null;
  if (!tlScrollFallback || tlScrollPendingY === null) return;
  const wrap = document.querySelector(".wrap");
  if (!wrap) return;
  const offset = tlClampScrollOffset(tlScrollPendingY - tlScrollStartY);
  /* 移動量が0の時だけtransformを消す(空文字に戻す)と、スワイプ開始直後など
     0を跨ぐたびにtransformプロパティの有無が切り替わり、ブラウザが合成用
     レイヤーを都度破棄・再生成して一瞬ちらつくことがある。スワイプ中は
     0でも明示的にtranslateY(0px)を指定し続け、プロパティ自体は消さない
     (実際に消すのはtlFinalizeScrollFallbackでスワイプが終わった時だけ) */
  wrap.style.transform = `translateY(${offset}px)`;
  /* #timeline-head(sticky)は.wrapの子要素のため、.wrapにtransformをかけると
     その影響を受けて一緒に動いてしまう(本来はスクロールしても動かない要素)。
     逆方向のtransformで打ち消す。#timeline-headはsticky指定なので、まだ
     吸着する位置に達していない間は打ち消さずコンテンツと一緒に動かし、
     吸着位置を過ぎた分だけ打ち消してその場に留める
     (ネイティブのstickyスクロールと同じ見た目にする)。
     実際の描画位置は「吸着していれば常にtlHeadStickyTop、していなければ
     tlHeadNaturalK+offset」で決まるので、そこから見た目上あるべき位置を
     引いて必要な打ち消し量を毎回計算し直す。
     #fab(タスクを追加ボタン)は.wrapの外に配置しているので影響を受けない */
  const head = document.getElementById("timeline-head");
  if (head) {
    const desired = Math.max(tlHeadStickyTop, tlHeadNaturalK + offset);
    const headCounter = desired - tlHeadBaseRendered - offset;
    head.style.transform = `translateY(${headCounter}px)`;
  }
}

document.addEventListener("pointermove", (e) => {
  /* カードはtouch-action:noneのため、ブラウザは縦スワイプを一切スクロールしてくれない
     (長押しでのドラッグを確実に持ち上げるための制約)。長押しが確定する前に
     スクロール意図(8px以上の移動)と判断した場合は、指の移動量ぶんを
     こちらで代わりにスクロールする */
  if (tlScrollFallback) {
    e.preventDefault();
    tlScrollPendingY = e.clientY;
    if (!tlScrollRAF) tlScrollRAF = requestAnimationFrame(tlApplyScrollFallback);
    /* 慣性スクロール用に直近100ms分だけ指位置を記録しておく(指を離した瞬間の
       速度を、離す直前の一定時間の移動量から推定するため) */
    const now = performance.now();
    tlScrollVelSamples.push({ t: now, y: e.clientY });
    const cutoff = now - 100;
    while (tlScrollVelSamples.length > 1 && tlScrollVelSamples[0].t < cutoff) tlScrollVelSamples.shift();
    return;
  }
  if (tlPending) {
    if (Math.abs(e.clientY - tlPending.py) > 8 || Math.abs(e.clientX - tlPending.px) > 8) {
      clearTimeout(tlLongPressTimer);
      tlPending = null;
      tlScrollFallback = true;
      tlScrollStartY = e.clientY;
      tlScrollStartScrollY = window.scrollY;
      tlScrollMaxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      /* #timeline-headがまだ吸着(sticky)していない場合、実際に吸着し始める
         スクロール量までは一緒に動かしたい。「本来の(吸着していない)位置」が
         必要だが、offsetTopは既に吸着中の場合にブラウザによって現在の吸着
         位置を返してしまうことがあり信頼できないため、一時的にposition:static
         に切り替えて実測する(同期的に戻すため見た目のちらつきは出ない) */
      const head = document.getElementById("timeline-head");
      if (head) {
        /* 前のジェスチャーのsettle(position:fixed引き渡し待ち)がまだ完了して
           いない場合に備え、まずsticky管理下に戻す(このgen更新で前のreleaseは
           世代不一致により無効化される) */
        tlHeadSettleGen++;
        if (head.style.position === "fixed") {
          head.style.position = "";
          head.style.left = "";
          head.style.width = "";
          head.style.top = "";
          const spacer = document.getElementById("timeline-head-spacer");
          if (spacer) spacer.style.height = "0px";
        }
        tlHeadStickyTop = parseFloat(getComputedStyle(head).top) || 0;
        const prevPosition = head.style.position;
        head.style.position = "static";
        const naturalTop = tlScrollStartScrollY + head.getBoundingClientRect().top;
        head.style.position = prevPosition;
        tlHeadNaturalK = naturalTop - tlScrollStartScrollY;
        /* フォールバック開始時点(offset=0)で実際に描画されている位置。
           既に吸着中ならtlHeadStickyTop、していなければtlHeadNaturalKに一致する */
        tlHeadBaseRendered = Math.max(tlHeadStickyTop, tlHeadNaturalK);
      }
      /* マウスでのスワイプ操作はブラウザ側で移動量に関わらずclickが
         発火してしまい、タイマー開始/停止が誤爆するため抑制する */
      suppressClick = true;
    }
    return;
  }
  if (!tlDrag) return;
  e.preventDefault();
  tlDrag.curY = e.clientY;
  tlUpdateAutoScroll(e.clientY);
  tlUpdateDragVisual();
});

const TL_MOMENTUM_MIN_VELOCITY = 0.05; // px/ms未満は慣性スクロールしない(離しただけの動作とみなす)
const TL_MOMENTUM_MAX_VELOCITY = 3.5; // px/ms、指の急な動きの外れ値を抑える上限
const TL_MOMENTUM_DECEL = 0.0015; // px/ms^2、慣性の減速度合い

/* スワイプ/慣性スクロールを終える。.wrapは即座にtransformを解除してよいが、
   #timeline-head(ネイティブsticky)は要注意: transformで打ち消す方式だと、
   ネイティブのsticky計算自体がスクロール位置反映の途中で一時的に
   不安定(吸着していない本来の位置で描画される等)になることがあり、
   その不安定なネイティブの結果の上にこちらの打ち消し量を重ねても
   正しい位置にならない(打ち消し量はネイティブが正しく吸着している前提の
   計算のため)。そこで確定直後の短い間だけ、position:stickyへの依存を
   断ち切ってJS管理のposition:fixedに切り替え、ネイティブの計算結果に
   一切依存しない絶対位置で描画する。scrollend(または十分な待機)の後、
   position:stickyへ戻す */
function tlFinalizeScrollFallback() {
  tlScrollFallback = false;
  const wrap = document.querySelector(".wrap");
  let finalOffset = null;
  if (wrap) {
    if (tlScrollPendingY !== null) {
      /* 確定時だけは、キャッシュ済みのtlScrollMaxY(ジェスチャー開始時点の値)
         ではなく今の実際の最大スクロール量で上限を取り直す。ずれたまま
         window.scrollToに渡すと、ブラウザ側で範囲外とみなされて弾かれ
         (elastic bounce)、一瞬ヘッダーが乱れて見える一因になりうるため */
      const freshMaxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const minOffset = tlScrollStartScrollY - freshMaxY;
      const maxOffset = tlScrollStartScrollY;
      const rawOffset = tlScrollPendingY - tlScrollStartY;
      finalOffset = Math.max(minOffset, Math.min(maxOffset, rawOffset));
      window.scrollTo(0, tlScrollStartScrollY - finalOffset);
    }
    wrap.style.transform = "";
  }
  tlScrollPendingY = null;
  const head = document.getElementById("timeline-head");
  if (!head) return;
  if (finalOffset === null) { head.style.transform = ""; return; }
  /* transformがまだ効いている(=ライブドラッグ最終フレームと同じ見た目の)
     うちに現在の描画矩形を測っておく。translateYは横位置・幅に影響しない
     ため、left/widthはそのまま正しい値として使える */
  const rect = head.getBoundingClientRect();
  /* getBoundingClientRectはmargin分を含まない。.plan-headにはmargin-bottomが
     指定されているため、spacerの高さにはそれも足し込まないと数px分ずれる */
  const marginBottom = parseFloat(getComputedStyle(head).marginBottom) || 0;
  const desired = Math.max(tlHeadStickyTop, tlHeadNaturalK + finalOffset);
  head.style.transform = "";
  head.style.position = "fixed";
  head.style.left = `${rect.left}px`;
  head.style.width = `${rect.width}px`;
  head.style.top = `${desired}px`;
  /* position:fixedにすると通常のドキュメントフローから外れ、それまでheadが
     占めていた分の高さ(margin込み)が消えて後続要素が一瞬詰まって見える
     (そして解除時にまた戻る)。spacerでその高さぶんを確保しておく */
  const spacer = document.getElementById("timeline-head-spacer");
  if (spacer) spacer.style.height = `${rect.height + marginBottom}px`;
  /* このsettleの世代を記録しておき、releaseが実際に発火する時点で世代が
     ずれていたら(=その後さらに新しいジェスチャーが始まっていたら)何もしない。
     tlScrollFallbackだけを見ると、後発ジェスチャーが既に終わってさらに次の
     settle待ちに入っている場合を区別できず、古いreleaseが後発のfixed位置を
     誤って解除してしまう(一瞬ネイティブに戻って乱れる)ことがあったため */
  const gen = ++tlHeadSettleGen;
  const release = () => {
    if (tlScrollFallback || gen !== tlHeadSettleGen) return;
    head.style.position = "";
    head.style.left = "";
    head.style.width = "";
    head.style.top = "";
    if (spacer) spacer.style.height = "0px";
  };
  if ("onscrollend" in window) {
    window.addEventListener("scrollend", release, { once: true });
    setTimeout(release, 500); // scrollendが発火しない場合(実質的なオフセット0等)の保険
  } else {
    setTimeout(release, 300);
  }
}

/* 指を離した瞬間の勢いでそのままスクロールし続ける(慣性スクロール)。
   ネイティブスクロールでの「離した後も少し流れる」挙動を手動で再現する。
   毎フレームwindow.scrollToを呼ぶとレイアウト計算を伴いカクついて見えるため、
   慣性中も指を離す前と同じtransformベースの描画(tlApplyScrollFallback)を
   使い続け、GPU合成だけで滑らかに動かす。止まったところで初めて
   実際のスクロール位置を一度だけ確定する(tlFinalizeScrollFallback) */
function tlStartMomentum(v0) {
  if (tlMomentumRAF) { cancelAnimationFrame(tlMomentumRAF); tlMomentumRAF = null; }
  let velocity = Math.max(-TL_MOMENTUM_MAX_VELOCITY, Math.min(TL_MOMENTUM_MAX_VELOCITY, v0));
  let lastT = performance.now();
  function step() {
    const now = performance.now();
    const dt = Math.min(50, now - lastT); // タブ切替復帰等での大きなdtを抑える
    lastT = now;
    const sign = velocity > 0 ? 1 : -1;
    let nextVelocity = velocity - sign * TL_MOMENTUM_DECEL * dt;
    if (sign > 0 && nextVelocity < 0) nextVelocity = 0;
    if (sign < 0 && nextVelocity > 0) nextVelocity = 0;
    const avgVelocity = (velocity + nextVelocity) / 2;
    velocity = nextVelocity;
    tlScrollPendingY += avgVelocity * dt; // 指が動き続けているのと同じ扱いにする
    tlApplyScrollFallback();
    const rawOffset = tlScrollPendingY - tlScrollStartY;
    const hitBoundary = tlClampScrollOffset(rawOffset) !== rawOffset;
    if (velocity !== 0 && !hitBoundary) {
      tlMomentumRAF = requestAnimationFrame(step);
    } else {
      tlMomentumRAF = null;
      tlFinalizeScrollFallback();
    }
  }
  tlMomentumRAF = requestAnimationFrame(step);
}

/* 慣性スクロール中に画面のどこかに触れたら、指で画面を止めたのと同じなので
   慣性を打ち切り、その時点のスクロール位置を確定する
   (タイムラインのカード以外に触れた場合もこちらで対応) */
document.addEventListener("pointerdown", () => {
  if (tlMomentumRAF) {
    cancelAnimationFrame(tlMomentumRAF);
    tlMomentumRAF = null;
    tlFinalizeScrollFallback();
  }
});

/* pointerupだけでなくpointercancelでも同じ後片付けをする。iOS Safariは
   長く触れ続けたタッチに対してシステム側でジェスチャーを仲裁することがあり、
   その際pointerupを送らずpointercancelだけを送ってくることがある。
   これを無視するとtlScrollFallback等の状態が中途半端なまま残り、
   以後の操作と噛み合わなくなる(スワイプが長いと振動する不具合の一因) */
/* ドラッグにも長押し待ち中のスワイプ判定にも至らなかった場合、単純な
   タップとみなして開始/停止を確実に実行する。ブラウザのネイティブclick
   イベントに頼ると、touch-action:noneとの組み合わせ等で発火しない端末が
   ありうるため、ここで明示的に実行する(直後のclickはsuppressClickで無視) */
function tlHandleTap(item) {
  const card = item.querySelector(".t-card");
  const action = card ? card.dataset.action : null;
  const id = card ? card.dataset.id : null;
  if (action === "start") startAsg(id);
  else if (action === "pause") pauseAsg(id);
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 80);
}

function tlPointerEnd() {
  clearTimeout(tlLongPressTimer);
  const tappedItem = tlPending ? tlPending.item : null;
  tlPending = null;
  if (tlScrollFallback) {
    if (tlScrollRAF) { cancelAnimationFrame(tlScrollRAF); tlScrollRAF = null; }
    /* 指を離す直前(直近100ms)の移動速度から、そのまま慣性で流すか、
       ここで確定するかを決める。tlStartMomentum/tlFinalizeScrollFallbackの
       どちらの経路でも最終的に実スクロール位置の確定とtransform解除を行う */
    let fingerVel = 0;
    if (tlScrollVelSamples.length >= 2) {
      const first = tlScrollVelSamples[0];
      const last = tlScrollVelSamples[tlScrollVelSamples.length - 1];
      const dt = last.t - first.t;
      if (dt > 0) fingerVel = (last.y - first.y) / dt; // px/ms、指が下向きなら正
    }
    tlScrollVelSamples = [];
    if (Math.abs(fingerVel) >= TL_MOMENTUM_MIN_VELOCITY) {
      tlStartMomentum(fingerVel);
    } else {
      tlFinalizeScrollFallback();
    }
    setTimeout(() => { suppressClick = false; }, 80);
  }
  if (!tlDrag) {
    if (tappedItem) tlHandleTap(tappedItem);
    return;
  }
  const d = tlDrag;
  tlDrag = null;
  tlStopAutoScroll();
  d.el.classList.remove("tl-dragging");
  d.el.style.position = "";
  d.el.style.left = "";
  d.el.style.top = "";
  d.el.style.width = "";
  d.el.style.margin = "";
  d.el.style.transform = "";
  if (d.placeholder && d.placeholder.parentNode) d.placeholder.remove();
  d.others.forEach((o) => { o.el.style.transform = ""; });
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 80);
  const above = d.others[d.gapIndex - 1] || null;
  const below = d.others[d.gapIndex] || null;
  const startMin = tlComputeStart(above, below, d.estimateMin);
  const a = d.id ? state.assignments.find((x) => x.id === d.id) : null;
  if (a) {
    if (startMin !== null) a.start = minToHm(startMin);
    /* 配列内の並び順もドロップ位置に合わせる。開始時刻が同じ(同着)場合はこの並び順で
       表示順が決まるため、時刻のルールだけでは並び替えできない場面(同時刻同士の間へ
       ドロップした結果、時刻が変わらない/同じになる場合)でも位置が反映されるようにする */
    const idx = state.assignments.indexOf(a);
    if (idx !== -1) state.assignments.splice(idx, 1);
    const aboveA = above && above.el.dataset.asg ? state.assignments.find((x) => x.id === above.el.dataset.asg) : null;
    const belowA = below && below.el.dataset.asg ? state.assignments.find((x) => x.id === below.el.dataset.asg) : null;
    let insertAt;
    if (aboveA) insertAt = state.assignments.indexOf(aboveA) + 1;
    else if (belowA) insertAt = state.assignments.indexOf(belowA);
    else insertAt = state.assignments.length;
    state.assignments.splice(insertAt, 0, a);
  }
  save(); // 周期タスクの実体化だけが起きた場合も保存する
  renderAll();
  /* 再描画でカードのDOM要素は作り直されるため、新しい要素にドロップの一時ハイライトを付ける */
  if (d.id) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`.t-item[data-asg="${d.id}"]`);
      if (el) {
        el.classList.add("drop-flash");
        setTimeout(() => el.classList.remove("drop-flash"), 1200);
      }
    });
  }
}
document.addEventListener("pointerup", tlPointerEnd);
document.addEventListener("pointercancel", tlPointerEnd);

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
let selDayOnly = localStorage.getItem("hisho:ui:seldayonly") === "1";

/* タスクtが日付dkに関係する(実施日・予備日・周期の自動予定・自動予備日の
   いずれかがある)かどうか。「選択日のタスクのみ表示」の絞り込みに使う。
   summary(見出し)行自体はマークを持たないため、配下(子孫、入れ子のsummary
   も再帰的に)にマークのある行が1つでもあれば関係ありとする */
function taskRelevantToDate(t, dk) {
  if (t.type === "summary") {
    return state.tasks.some((c) => c.parentId === t.id && taskRelevantToDate(c, dk));
  }
  if (state.assignments.some((a) => a.taskId === t.id && a.date === dk)) return true;
  if (findReserve(t.id, dk)) return true;
  if (t.type === "recurring" && dk >= todayKey() && occursOn(t, dk) && !hasSkip(t.id, dk)) return true;
  if (ruleReserveDates(t, dk, dk).has(dk)) return true;
  return false;
}

/* 「選択日のタスクのみ表示」の表示対象タスクidの一覧。マスのタップ/長押し編集/
   ドラッグ移動でカレンダーを操作しても、この一覧はその場では更新しない(誤って
   マークを消した、あるいはマークを変更する途中で一時的に空欄を通過しただけの
   可能性があるため、対象から外れた行をその場で消してしまわないようにする)。
   日付の選択が変わったときやチェックを入れた直後など、明示的なタイミングだけで
   recomputeSelDayVisible()を呼んで更新する */
let selDayVisibleIds = null;
function recomputeSelDayVisible() {
  selDayVisibleIds = new Set(state.tasks.filter((t) => taskRelevantToDate(t, selDate)).map((t) => t.id));
}
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

function renderGantt(refreshVisibility) {
  const box = document.getElementById("gantt");
  const archChk = document.getElementById("g-showarch");
  if (archChk) archChk.checked = showArch;
  const seldayChk = document.getElementById("g-selday-only");
  if (seldayChk) seldayChk.checked = selDayOnly;
  if (selDayOnly && (refreshVisibility || !selDayVisibleIds)) recomputeSelDayVisible();

  if (!state.tasks.length) {
    box.innerHTML = `<div class="g-empty">課題タブでタスクを登録すると、ここで日付マスをタップして割り当てられます。</div>`;
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
        const hideThis =
          (!showArch && isTaskArchived(t)) || // アーカイブのみ非表示(完了でも未アーカイブなら表示)
          (selDayOnly && !(selDayVisibleIds && selDayVisibleIds.has(t.id))); // 選択日のタスクのみ表示(スナップショット)
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
      <div class="g-track-wrap">
        <div class="g-track-head">
          <div class="g-track-head-clip">
            <div class="g-track-head-inner" style="width:${trackW}px">
              <div class="g-trow g-sh">${hcells}</div>
              <div class="g-trow g-ss">${lockCols}${sumCells}</div>
            </div>
          </div>
        </div>
        <div class="g-scroll">
          <div style="width:${trackW}px">
            ${trackRows.join("")}
          </div>
        </div>
      </div>
    </div>`;

  const sc = box.querySelector(".g-scroll");
  if (sc) {
    if (keepLeft !== null) sc.scrollLeft = keepLeft;
    else if (tdIdx >= 0) sc.scrollLeft = Math.max(0, (tdIdx - 3) * G_COLW);
  }
  /* 日付見出し行(.g-track-head-inner)は.g-scrollの外に出したため、
     横スクロール位置を自分では追随しない。scrollLeft復元直後に
     一度だけ明示的に揃えておく(以後はsyncGanttTrackHeadX()が
     .g-scrollのscrollイベントで追随させる) */
  syncGanttTrackHeadX();
  measureGanttSticky();
  updateGanttStickyHeader();
}

/* 日付見出し行(.g-track-head-inner)は.g-scrollの外(ネイティブstickyを
   使うため)にあるので、.g-scrollを横スクロールしても自動的には追随しない。
   .g-scrollのscrollLeftに合わせてtranslateXを当てて同期する。
   scrollイベントはバブリングしないため、#gantt(renderGantt()で中身が
   丸ごと差し替わっても要素自体は再生成されない)にキャプチャフェーズで
   一度だけ登録し、再描画のたびに登録し直さなくて済むようにする */
function syncGanttTrackHeadX() {
  const scroller = document.querySelector("#gantt .g-scroll");
  const headInner = document.querySelector("#gantt .g-track-head-inner");
  if (scroller && headInner) headInner.style.transform = `translateX(${-scroller.scrollLeft}px)`;
}
{
  const box = document.getElementById("gantt");
  if (box) box.addEventListener("scroll", syncGanttTrackHeadX, true);
}

/* #gantt本体の文書上の位置と日付ヘッダー行の高さは、レイアウトが変わらない
   限り毎フレーム測り直す必要がない。getBoundingClientRect()/offsetHeightは
   呼ぶたびに同期的なレイアウト計算を強制するため、rAFループの中で毎回
   呼ぶとメインスレッドの処理が重くなり、iOSの慣性スクロール中に読み取る
   スクロール位置が実際の描画から遅れる一因になっていた可能性がある。
   そこで測定はレイアウトが変わりうるタイミング(再描画・リサイズ)だけで
   行い、毎フレームの処理はwindow.scrollYを使った軽い算術計算だけにする */
let ganttBoxDocTop = 0;
let ganttBoxDocHeight = 0;
let ganttHeadHeight = 0;
let ganttHeadDocTop = 0; // .g-track-head(右側、日付トラック側の見出し全体)の自然な位置
let ganttHeadSideDocTop = 0; // .g-side .g-scell.g-sh(左側、タスク名列)の自然な位置
let ganttSumHeight = 0;
let ganttSumSideDocTop = 0;
function measureGanttSticky() {
  const box = document.getElementById("gantt");
  if (!box) return;
  const trackHead = box.querySelector(".g-track-head");
  const headRow = box.querySelector(".g-trow.g-sh");
  const sumRow = box.querySelector(".g-trow.g-ss");
  const headSide = box.querySelector(".g-side .g-scell.g-sh");
  const sumSide = box.querySelector(".g-side .g-scell.g-ss");
  const r = box.getBoundingClientRect();
  ganttBoxDocTop = r.top + window.scrollY;
  ganttBoxDocHeight = r.height;
  ganttHeadHeight = headRow ? headRow.offsetHeight : 0;
  ganttSumHeight = sumRow ? sumRow.offsetHeight : 0;
  /* 右側(日付トラック)は.g-trow.g-sh/.g-ssをまとめて.g-track-head(ネイティブ
     position:sticky)1つで固定するようになったため、.g-track-head自身の
     自然な位置を測る。左側(タスク名列)は.g-scell.g-sh/.g-ssそれぞれが
     個別にネイティブstickyのため、両方を個別に測る(自然位置が完全に
     一致する保証はなく、実際わずかにずれてタスク行の文字がヘッダーの上に
     はみ出して見える不具合の原因になっていた) */
  ganttHeadDocTop = ganttNaturalDocTop(trackHead) ?? ganttBoxDocTop;
  ganttHeadSideDocTop = ganttNaturalDocTop(headSide) ?? ganttHeadDocTop;
  ganttSumSideDocTop = ganttNaturalDocTop(sumSide) ?? ganttHeadSideDocTop + ganttHeadHeight;
}

/* position:stickyで既に吸着中の要素は、getBoundingClientRect().topが
   「吸着位置」を返してしまい、「本来の(吸着していない)自然位置」を正しく
   測れない(ページを途中までスクロールした状態で計画タブを開く/再描画される
   と、この時点で既に吸着済みのことがある)。.cal-sticky/#timeline-headの
   自然位置測定と全く同じ手法で、一時的にposition:staticへ切り替えて実測
   してから元に戻す(同期的に戻すため見た目のちらつきは出ない)。この誤測定は
   画面ローテート後に次のドラッグでヘッダーが指に追随して見える不具合の
   直接原因だったと考えられる(誤ったganttHeadDocTop等を基準に打ち消し量を
   計算すると、結果がほぼ0になり.wrapのtransformがヘッダーにもそのまま
   効いてしまうため) */
function ganttNaturalDocTop(el) {
  if (!el) return null;
  const prevPosition = el.style.position;
  el.style.position = "static";
  const top = el.getBoundingClientRect().top + window.scrollY;
  el.style.position = prevPosition;
  return top;
}
/* .cal-sticky(範囲選択ナビ)のすぐ下の位置。ヘッダー系要素のtopとして
   updateGanttStickyHeader()が参照する(値がずれるとヘッダーの吸着位置が
   左右/更新タイミングで食い違う不具合の元になるため一箇所に共通化する) */
function ganttTopEdge() {
  const bars = document.getElementById("fixedbars");
  const nav = document.querySelector(".cal-sticky");
  const navTop = nav ? parseFloat(getComputedStyle(nav).top) || 0 : 0;
  /* offsetHeightは整数に丸められる(端数切り捨て/丸め)ため、.cal-stickyの
     実際の高さが端数を持つ場合に最大1px前後の誤差が生じ、ヘッダーが
     本来より下にずれて隙間からタスク行がはみ出して見える一因になっていた。
     getBoundingClientRect().heightは小数点まで正確な値を返す */
  return nav ? navTop + nav.getBoundingClientRect().height : (bars ? bars.getBoundingClientRect().height : 0);
}

window.addEventListener("resize", () => {
  /* DevToolsのスマホ/PC表示切り替え等でリサイズが発生すると、進行中の
     ポインタ操作にpointerup/pointercancelが届かないまま終わることがあり、
     gScrollFallbackがtrueに固定されたままになる。この場合
     updateGanttStickyHeader()のscrollYOverrideなし呼び出しは全て無視
     されてしまい(gApplyScrollFallback側の計算と競合させないための
     ガード)、右側の見出し行が更新されなくなる(固定されなくなったように
     見える)。リサイズ時は進行中のフェイクスクロールを強制的に確定させ、
     状態が固定化されないようにする */
  if (gScrollFallback) {
    if (gScrollRAF) { cancelAnimationFrame(gScrollRAF); gScrollRAF = null; }
    if (gMomentumRAF) { cancelAnimationFrame(gMomentumRAF); gMomentumRAF = null; }
    gFinalizeScrollFallback();
  }
  measureGanttSticky();
  updateGanttStickyHeader();
});

/* 縦スクロール時、日付ヘッダー行を画面上部に貼り付ける。
   scrollYOverrideを渡すと、実際のwindow.scrollYの代わりにその値で計算する
   (gApplyScrollFallback()が指のフェイクスクロール中に使う) */
function updateGanttStickyHeader(scrollYOverride) {
  if (view !== "gantt") return;
  /* フェイクスクロール中(gScrollFallback)は実スクロール位置(window.scrollY)が
     まだ動いていないため、scrollYOverride無しでの呼び出し(scrollイベント/
     ganttStickyLoopの毎フレーム呼び出し)は無視する。放置するとgApplyScroll
     Fallback()側の(正しい)計算と同じフレーム内で競合し、見出し行が毎フレーム
     2つの異なる値の間で揺れ動いてしまう */
  if (scrollYOverride === undefined && gScrollFallback) return;
  const box = document.getElementById("gantt");
  if (!box) return;
  const trackHead = box.querySelector(".g-track-head");
  const headSide = box.querySelector(".g-side .g-scell.g-sh");
  const sumSide = box.querySelector(".g-side .g-scell.g-ss");
  if (!trackHead || !headSide) return;
  const topEdge = ganttTopEdge();
  /* .g-track-head/.g-side側のネイティブposition:stickyが参照する目標値。
     ドラッグの有無にかかわらず常に最新化しておく。--gantt-head-heightは
     見積合計行(.g-ss)がすぐ下に連なる位置を計算するのに使う(CSS側で
     32pxと決め打ちしない) */
  document.documentElement.style.setProperty("--gantt-head-top", `${topEdge}px`);
  document.documentElement.style.setProperty("--gantt-head-height", `${ganttHeadHeight}px`);
  const scrollY = scrollYOverride !== undefined ? scrollYOverride : window.scrollY;
  const rectTop = ganttBoxDocTop - scrollY;
  const rectBottom = rectTop + ganttBoxDocHeight;
  /* 「浮かせるかどうか」の判定は#gantt自体の矩形(rectTop/rectBottom)で行うが、
     実際に浮かせる位置は各要素自身の自然な位置を基準に計算する。#gantt
     には1pxの枠線があり中の行はその内側から始まるため、#gantt自身の
     矩形をそのまま基準にすると数px分ずれてしまう */
  const combinedHeight = ganttHeadHeight + ganttSumHeight;
  const floating = rectTop < topEdge && rectBottom > topEdge + combinedHeight + 40;
  /* 右側(日付トラック)は日付見出し行・見積合計行をまとめた.g-track-head
     1つがネイティブのposition:stickyで固定される(.g-scrollの横スクロール
     に巻き込まれないよう.g-scrollの外に出してある)。左側(タスク名列)も
     ネイティブのposition:stickyに任せるのが基本。ただし指でのドラッグ中
     (gScrollFallback、scrollYOverrideありで呼ばれる)だけは.wrapの
     transformに巻き込まれてしまうため、.cal-stickyと同じ理由でJS計算の
     transformを一時的に上乗せする。ドラッグ以外(ネイティブscrollイベント・
     ganttStickyLoopの毎フレーム呼び出し)ではtransformを空にしてネイティブ
     の計算に完全に委ね、iOSやChromeがアクティブなスクロール中に
     requestAnimationFrameを間引く(ヘッダーが一瞬消える不具合の原因と
     考えられる)影響を受けないようにする。
     ネイティブstickyはドラッグ中も実スクロール位置(gScrollStartScrollYで
     固定されたまま)を基準に計算され続けるため、その「素の描画位置」
     (baseRendered、吸着していればtopEdge・していなければ自然位置)と
     .wrapのtransform量(wrapOffset)の両方を打ち消してから、あらためて
     現在(フェイクスクロール後)の目標位置に合わせる。.cal-stickyの
     打ち消し式と同じ考え方 */
  const wrapOffset = scrollYOverride !== undefined ? gScrollStartScrollY - scrollY : 0;

  const headNaturalTop = ganttHeadDocTop - scrollY;
  let trackOffset = 0;
  if (scrollYOverride !== undefined) {
    const trackBaseRendered = Math.max(topEdge, ganttHeadDocTop - gScrollStartScrollY);
    const trackDesired = Math.max(topEdge, headNaturalTop);
    trackOffset = trackDesired - trackBaseRendered - wrapOffset;
  }
  /* trackOffsetはドラッグ中(scrollYOverrideあり)以外は0のまま(上のif文参照)。
     transformを空文字に戻さず常にtranslateYを明示するのは、CSS側の
     transform: translateY(0px)ベースライン宣言と対になっている
     (.g-track-headのコメント参照。noneへの切り替えを避けるため) */
  trackHead.style.transform = `translateY(${trackOffset}px)`;
  trackHead.classList.toggle("floating", floating);

  const headSideNaturalTop = ganttHeadSideDocTop - scrollY;
  let offsetSide = 0;
  if (scrollYOverride !== undefined) {
    const headSideBaseRendered = Math.max(topEdge, ganttHeadSideDocTop - gScrollStartScrollY);
    const headSideDesired = Math.max(topEdge, headSideNaturalTop);
    offsetSide = headSideDesired - headSideBaseRendered - wrapOffset;
  }
  headSide.style.transform = `translateY(${offsetSide}px)`;
  headSide.classList.toggle("floating", floating);

  if (sumSide) {
    const sumDesired = topEdge + ganttHeadHeight; // 見出し行のすぐ下
    const sumSideNaturalTop = ganttSumSideDocTop - scrollY;
    let sumOffsetSide = 0;
    if (scrollYOverride !== undefined) {
      const sumSideBaseRendered = Math.max(sumDesired, ganttSumSideDocTop - gScrollStartScrollY);
      const sumSideDesired = Math.max(sumDesired, sumSideNaturalTop);
      sumOffsetSide = sumSideDesired - sumSideBaseRendered - wrapOffset;
    }
    sumSide.style.transform = `translateY(${sumOffsetSide}px)`;
    sumSide.classList.toggle("floating", floating);
  }
}

window.addEventListener("scroll", () => {
  requestAnimationFrame(updateGanttStickyHeader);
}, { passive: true });

/* scrollイベントだけに頼ると、iOSの慣性スクロール中はイベント発火が実際の
   描画に対して遅延/まとめ打ちされることがあり、見出し行が本来の位置を
   一瞬追い越してから遅れて補正される(ちらつき/ジャンプに見える)ことが
   あった。計画タブを表示している間は毎フレーム無条件に位置を再計算する
   ことで、scrollイベントのタイミングに依存しないようにする */
let ganttStickyLoopActive = false;
function ganttStickyLoop() {
  if (view !== "gantt") { ganttStickyLoopActive = false; return; }
  updateGanttStickyHeader();
  requestAnimationFrame(ganttStickyLoop);
}
function startGanttStickyLoop() {
  if (ganttStickyLoopActive) return;
  ganttStickyLoopActive = true;
  requestAnimationFrame(ganttStickyLoop);
}

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
  /* ポインタが止まっていてもページだけ動く分、基準点をずらしてカードを指の位置に留める */
  sortDrag.py -= sortAutoScrollSpeed;
  applySortDragPosition();
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
    curY: e.clientY,
    moved: false,
    idx: null,
  };
  sortDrag.el.classList.add("grabbed"); // 掴めた合図(押した瞬間に浮く)
  try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}
});

/* カードをポインタ位置に合わせて動かし、挿入ラインを更新する(自動スクロール中も毎フレーム呼ぶ) */
function applySortDragPosition() {
  sortDrag.el.style.transform = `translateY(${sortDrag.curY - sortDrag.py}px) scale(1.02)`;
  const cands = sortCandidates(sortDrag);
  if (!cands.length) return;
  /* ポインタ位置と各要素の中央を比べて挿入位置を決める(上下で対称) */
  let idx = 0;
  cands.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top + r.height / 2 < sortDrag.curY) idx++;
  });
  sortDrag.idx = idx;
  const line = getDropLine();
  if (idx < cands.length) {
    cands[idx].parentNode.insertBefore(line, cands[idx]);
  } else {
    const last = cands[cands.length - 1];
    last.parentNode.insertBefore(line, last.nextSibling);
  }
}

document.addEventListener("pointermove", (e) => {
  if (!sortDrag) return;
  if (!sortDrag.moved && Math.abs(e.clientY - sortDrag.py) > 6) {
    sortDrag.moved = true;
    sortDrag.el.classList.add("sorting");
  }
  if (!sortDrag.moved) return;
  sortDrag.curY = e.clientY;
  updateSortAutoScroll(e.clientY);
  applySortDragPosition();
});

function sortPointerEnd() {
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
}
document.addEventListener("pointerup", sortPointerEnd);
document.addEventListener("pointercancel", sortPointerEnd);

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

function swipePointerEnd() {
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
}
document.addEventListener("pointerup", swipePointerEnd);
document.addEventListener("pointercancel", swipePointerEnd);

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

function ganttDragPointerEnd() {
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
}
document.addEventListener("pointerup", ganttDragPointerEnd);
document.addEventListener("pointercancel", ganttDragPointerEnd);

/* ---------- 計画タブの縦スクロール(フェイクスクロール) ---------- */
/* タイムライン見出しのちらつき調査で判明した通り、iOSはネイティブの慣性
   スクロール中にJSの実行(rAFや読み取り)自体を遅延させることがあり、
   scrollイベント頼みでは見出し行の追随が一瞬遅れて見える。そこで計画タブの
   縦スクロールも、今日タブのタイムラインと同じ考え方で完全にJS管理にする:
   ドラッグ中は.wrapをtransformで見た目だけ動かし(実スクロールに触れない)、
   指を離したら速度に応じてJSで慣性させ、最後に一度だけ実スクロール位置を
   確定する。この間ネイティブの慣性スクロールは一度も発生しないため、
   ブラウザ側のJS実行遅延の影響を受けない。
   ガントの見出し行はタイムラインと違いネイティブのposition:stickyを使わず
   常にJS計算のtransformで描画しているため、確定後の「ネイティブへの引き渡し
   待ち」は不要(updateGanttStickyHeader()を1回呼び直すだけで一致する)。
   一方、範囲選択ボタン等(.cal-sticky)はネイティブのposition:stickyなので、
   .wrapのtransformの影響を打ち消す必要があり(タイムライン見出しと同じ理由)、
   確定時の引き渡しもタイムラインと同じposition:fixed一時切替えで行う */
let gScrollPending = null; // 判定待ち { x, y }
let gScrollFallback = false;
let gScrollStartY = 0;
let gScrollStartScrollY = 0;
let gScrollMaxY = 0;
let gScrollPendingY = null;
let gScrollRAF = null;
let gScrollVelSamples = [];
let gMomentumRAF = null;
let gCalStickyTop = 0; // .cal-stickyのsticky吸着位置(--fixed-hを解決した実際のpx値)
let gCalNaturalK = 0; // .cal-stickyの本来の(吸着していない)位置 - フォールバック開始時のスクロール位置
let gCalBaseRendered = 0; // フォールバック開始時点(offset=0)での実際の描画位置
let gCalSettleGen = 0; // .cal-stickyのposition:fixed引き渡し待ちの世代カウンタ(timelineと同じ理由)
let gWheelEndTimer = null; // マウスホイールでの疑似スクロール確定待ちタイマー

function gClampScrollOffset(offset) {
  const minOffset = gScrollStartScrollY - gScrollMaxY;
  const maxOffset = gScrollStartScrollY;
  return Math.max(minOffset, Math.min(maxOffset, offset));
}

function gApplyScrollFallback() {
  gScrollRAF = null;
  if (!gScrollFallback || gScrollPendingY === null || view !== "gantt") return;
  const wrap = document.querySelector(".wrap");
  if (!wrap) return;
  const offset = gClampScrollOffset(gScrollPendingY - gScrollStartY);
  wrap.style.transform = `translateY(${offset}px)`;
  /* 実際にスクロールしたのと同じ実効scrollYを渡し、見出し行の位置計算を
     updateGanttStickyHeader()と完全に共通化する */
  updateGanttStickyHeader(gScrollStartScrollY - offset);
  /* .cal-sticky(ネイティブsticky)は.wrapのtransformの影響をそのまま受けて
     一緒に動いてしまうため、タイムライン見出しと同じ式で打ち消す */
  const cal = document.querySelector(".cal-sticky");
  if (cal) {
    const desired = Math.max(gCalStickyTop, gCalNaturalK + offset);
    const counter = desired - gCalBaseRendered - offset;
    cal.style.transform = `translateY(${counter}px)`;
  }
}

/* ポインタでのドラッグ開始・マウスホイールでの疑似スクロール開始の
   共通初期化(startYは基準点。ホイールには実際の指位置がないため0を渡す) */
function gBeginScrollFallback(startY) {
  gScrollFallback = true;
  gScrollStartY = startY;
  gScrollStartScrollY = window.scrollY;
  gScrollMaxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  gScrollVelSamples = [];
  /* .cal-stickyの「本来の(吸着していない)位置」を測る。#timeline-headと同じ
     手法(一時的にposition:staticに戻して実測)。前のジェスチャーの引き渡し
     待ち(position:fixed)がまだ残っていれば、まずsticky管理下に戻す */
  const cal = document.querySelector(".cal-sticky");
  if (cal) {
    gCalSettleGen++;
    if (cal.style.position === "fixed") {
      cal.style.position = "";
      cal.style.left = "";
      cal.style.width = "";
      cal.style.top = "";
      const spacer = document.getElementById("cal-sticky-spacer");
      if (spacer) spacer.style.height = "0px";
    }
    gCalStickyTop = parseFloat(getComputedStyle(cal).top) || 0;
    const prevPosition = cal.style.position;
    cal.style.position = "static";
    const naturalTop = gScrollStartScrollY + cal.getBoundingClientRect().top;
    cal.style.position = prevPosition;
    gCalNaturalK = naturalTop - gScrollStartScrollY;
    gCalBaseRendered = Math.max(gCalStickyTop, gCalNaturalK);
  }
}

function gEngageScrollFallback(e) {
  gScrollPending = null;
  drag = null; // マークのドラッグ移動が判定待ちのままなら取り消す(縦スクロール優先)
  gBeginScrollFallback(e.clientY);
  e.preventDefault();
}

document.addEventListener("pointerdown", (e) => {
  if (view !== "gantt") return;
  if (document.body.style.position === "fixed") return; // 全画面フォーム表示中
  if (e.target.closest(".overlay")) return; // 操作方法モーダル等の表示中
  if (e.target.closest("input, textarea, select")) return;
  /* #view-gantt(表本体+.cal-sticky)だけでなく、.topbar/.tabs(画面最上部の
     日付表示・タブ切り替え。他タブと共有のためDOM上は#view-ganttの外にある)
     から始まる縦スワイプもここで受け止める。対象外の領域から始まる縦
     スクロールはネイティブスクロールに委ねることになり、その間ネイティブの
     慣性スクロール中はJSの実行が遅延して見出し行が消える/追随しない
     不具合があった。計画タブ表示中(view==="gantt")に限定されるため、
     他タブのスクロールには影響しない */
  if (gScrollFallback) {
    if (gScrollRAF) { cancelAnimationFrame(gScrollRAF); gScrollRAF = null; }
    if (gMomentumRAF) { cancelAnimationFrame(gMomentumRAF); gMomentumRAF = null; }
    gFinalizeScrollFallback();
  }
  /* .g-scroll/.g-side(表本体、横方向のネイティブスクロールが必要)以外は
     ネイティブに横スクロールの需要が無いのに、方向判定中(8px未満)は
     まだpreventDefaultしていなかったため、ネイティブが先にバーティカル
     スクロールを開始してしまい、その後のpreventDefaultでは止められない
     ことがあった(.wrapの余白部分等、touch-actionを個別に指定していない
     場所で発生)。該当領域か覚えておき、pointermoveの判定中から先んじて
     preventDefaultする */
  gScrollPending = { x: e.clientX, y: e.clientY, allowNativeHorizontal: !!e.target.closest(".g-scroll, .g-side") };
});

document.addEventListener("pointermove", (e) => {
  if (gScrollFallback) {
    e.preventDefault();
    gScrollPendingY = e.clientY;
    if (!gScrollRAF) gScrollRAF = requestAnimationFrame(gApplyScrollFallback);
    const now = performance.now();
    gScrollVelSamples.push({ t: now, y: e.clientY });
    const cutoff = now - 100;
    while (gScrollVelSamples.length > 1 && gScrollVelSamples[0].t < cutoff) gScrollVelSamples.shift();
    return;
  }
  if (gScrollPending) {
    if (!gScrollPending.allowNativeHorizontal) e.preventDefault();
    const dx = e.clientX - gScrollPending.x;
    const dy = e.clientY - gScrollPending.y;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dy) <= Math.abs(dx)) { gScrollPending = null; return; } // 横方向優勢は横スクロール/マーク移動に譲る
    gEngageScrollFallback(e);
  }
});

/* pointermoveでのpreventDefault()だけでは、iOSでスクロールの合成(コンポジット)
   がメインスレッドのJSを待たずに先行してしまうこと(スワイプの速度が速いほど
   ヘッダーが消えたままになり、遅いとちらつきながら見えることがある症状の
   原因と考えられる)があるため、より確実にネイティブスクロールをブロックする
   目的で、非passiveなtouchmoveでも同じ条件でpreventDefault()する(Pointer
   Eventsだけに頼らず、従来からのタッチイベントの経路でも早期に止める) */
document.addEventListener("touchmove", (e) => {
  if (view !== "gantt") return;
  if (gScrollFallback || (gScrollPending && !gScrollPending.allowNativeHorizontal)) {
    e.preventDefault();
  }
}, { passive: false });

/* マウスホイール(Windows等)によるネイティブスクロールも、指でのスワイプと
   同じJS管理の縦フェイクスクロールに乗せる。タッチではネイティブの慣性
   スクロールを一度も発生させない設計にしてこの一連の不具合(見出し行の
   ちらつき・追随遅れ)を回避しているが、マウスホイールはこれまでこの
   仕組みを経由せず素通りしており(常にscrollYOverride無しでネイティブ
   stickyに委ねる経路のみを通っていた)、Windowsでスクロール中にタスク行が
   見出し行の上にはみ出して見える不具合の原因になっていたと考えられる。
   ホイールには指のような明確な「開始/終了」がないため、イベントが一定時間
   (150ms)途切れた時点でスクロールが止まったとみなして確定させる */
document.addEventListener("wheel", (e) => {
  if (view !== "gantt") return;
  if (document.body.style.position === "fixed") return; // 全画面フォーム表示中
  if (e.target.closest(".overlay")) return;
  if (e.target.closest("input, textarea, select")) return;
  if (e.target.closest(".g-scroll, .g-side")) {
    // 表本体上でのShift+ホイール/横方向ホイールは横スクロールに譲る
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  }
  e.preventDefault();
  if (!gScrollFallback) gBeginScrollFallback(0);
  clearTimeout(gWheelEndTimer);
  gScrollPendingY = (gScrollPendingY ?? 0) - e.deltaY;
  if (!gScrollRAF) gScrollRAF = requestAnimationFrame(gApplyScrollFallback);
  gWheelEndTimer = setTimeout(() => {
    if (gScrollRAF) { cancelAnimationFrame(gScrollRAF); gScrollRAF = null; }
    gFinalizeScrollFallback();
  }, 150);
}, { passive: false });

function gStartMomentum(v0) {
  if (gMomentumRAF) { cancelAnimationFrame(gMomentumRAF); gMomentumRAF = null; }
  let velocity = Math.max(-TL_MOMENTUM_MAX_VELOCITY, Math.min(TL_MOMENTUM_MAX_VELOCITY, v0));
  let lastT = performance.now();
  function step() {
    const now = performance.now();
    const dt = Math.min(50, now - lastT);
    lastT = now;
    const sign = velocity > 0 ? 1 : -1;
    let nextVelocity = velocity - sign * TL_MOMENTUM_DECEL * dt;
    if (sign > 0 && nextVelocity < 0) nextVelocity = 0;
    if (sign < 0 && nextVelocity > 0) nextVelocity = 0;
    const avgVelocity = (velocity + nextVelocity) / 2;
    velocity = nextVelocity;
    gScrollPendingY += avgVelocity * dt;
    gApplyScrollFallback();
    const rawOffset = gScrollPendingY - gScrollStartY;
    const hitBoundary = gClampScrollOffset(rawOffset) !== rawOffset;
    if (velocity !== 0 && !hitBoundary) {
      gMomentumRAF = requestAnimationFrame(step);
    } else {
      gMomentumRAF = null;
      gFinalizeScrollFallback();
    }
  }
  gMomentumRAF = requestAnimationFrame(step);
}

function gFinalizeScrollFallback() {
  gScrollFallback = false;
  clearTimeout(gWheelEndTimer);
  const wrap = document.querySelector(".wrap");
  let finalOffset = null;
  if (wrap) {
    if (gScrollPendingY !== null) {
      const freshMaxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const minOffset = gScrollStartScrollY - freshMaxY;
      const maxOffset = gScrollStartScrollY;
      const rawOffset = gScrollPendingY - gScrollStartY;
      finalOffset = Math.max(minOffset, Math.min(maxOffset, rawOffset));
      window.scrollTo(0, gScrollStartScrollY - finalOffset);
    }
    wrap.style.transform = "";
  }
  gScrollPendingY = null;
  updateGanttStickyHeader(); // 実スクロール位置(window.scrollTo直後)で再計算し直す
  /* ↑ここまでは全てtransformの書き換えのみでレイアウトに影響しないため、
     window.scrollTo()/.wrapのtransform解除と同じ同期処理のままにしておく */
  const cal = document.querySelector(".cal-sticky");
  if (cal) cal.style.transform = "";

  /* .cal-stickyのposition:fixedへの切り替え(position/spacerの高さ変更を
     伴う、レイアウトに影響する重い変更)だけは、次の描画フレームまで1コマ
     遅らせる。Performanceパネルでの実機調査で、window.scrollTo()直後の
     同じ同期処理の中でこの切り替えまで行っていると、ちょうど1フレームだけ
     ガント見出し行が欠けて描画される(Paint flashingで他のコンテンツより
     見出し行の再描画が遅れて別に光る現象と一致)ことが分かったため、
     スクロール位置の変更をブラウザが先に合成し終える猶予を与える狙い。
     transformだけの軽い変更(上のupdateGanttStickyHeader()やcalのtransform
     クリア)は据え置き、レイアウトに影響する重い変更だけを遅らせることで、
     ヘッダー自身が1フレームだけ古いtransformのまま取り残されて位置がずれる、
     という新たな不具合を生まないようにしている */
  if (finalOffset !== null) {
    requestAnimationFrame(() => gFinalizeCalSettle(finalOffset));
  }
}

function gFinalizeCalSettle(finalOffset) {
  /* .cal-stickyはネイティブsticky。#timeline-headと同じ理由(ネイティブの
     sticky計算がスクロール位置反映の途中で一時的に不安定になりうる)で、
     確定直後の短い間だけJS管理のposition:fixedに切り替えてネイティブの
     計算結果に依存しない絶対位置で描画し、scrollend/タイムアウトを待って
     から一括でsticky管理に戻す。
     (実験メモ: この処理を一時的に無効化して検証したところ、ガント見出し行の
     点滅が「ヘッダーが固定表示中のみ」から「固定表示でなくても常に」発生する
     ように悪化したため元に戻した。この処理は点滅の原因ではなく、むしろ
     発生範囲を限定する側に働いていたと考えられる) */
  const cal = document.querySelector(".cal-sticky");
  if (!cal) return;
  const rect = cal.getBoundingClientRect();
  const desired = Math.max(gCalStickyTop, gCalNaturalK + finalOffset);
  cal.style.transform = "";
  cal.style.position = "fixed";
  cal.style.left = `${rect.left}px`;
  cal.style.width = `${rect.width}px`;
  cal.style.top = `${desired}px`;
  /* position:fixedにすると通常のドキュメントフローから外れ、それまで.cal-sticky
     が占めていた分の高さが消えて後続要素(#gantt)が詰まって見える(#timeline-head
     のときと同じ問題)。spacerでその高さぶんを確保しておく */
  const spacer = document.getElementById("cal-sticky-spacer");
  if (spacer) spacer.style.height = `${rect.height}px`;
  const gen = ++gCalSettleGen;
  const release = () => {
    if (gScrollFallback || gen !== gCalSettleGen) return;
    cal.style.position = "";
    cal.style.left = "";
    cal.style.width = "";
    cal.style.top = "";
    if (spacer) spacer.style.height = "0px";
  };
  if ("onscrollend" in window) {
    window.addEventListener("scrollend", release, { once: true });
    setTimeout(release, 500);
  } else {
    setTimeout(release, 300);
  }
}

function gPointerEnd() {
  gScrollPending = null;
  if (!gScrollFallback) return;
  if (gScrollRAF) { cancelAnimationFrame(gScrollRAF); gScrollRAF = null; }
  let fingerVel = 0;
  if (gScrollVelSamples.length >= 2) {
    const first = gScrollVelSamples[0];
    const last = gScrollVelSamples[gScrollVelSamples.length - 1];
    const dt = last.t - first.t;
    if (dt > 0) fingerVel = (last.y - first.y) / dt;
  }
  gScrollVelSamples = [];
  if (Math.abs(fingerVel) >= TL_MOMENTUM_MIN_VELOCITY) {
    gStartMomentum(fingerVel);
  } else {
    gFinalizeScrollFallback();
  }
}
document.addEventListener("pointerup", gPointerEnd);
document.addEventListener("pointercancel", gPointerEnd);

/* ---------- ガントのマス長押し/右クリック:割り当てを編集 ---------- */
/* ロック中の日・summary行のマスは<div>(data-task/data-date無し)のため
   button.g-cellでの絞り込みだけで自然に対象外になる。マークのドラッグ移動
   (直近のpointerdown、8px以上動くとdrag.moved=trueになる)とは別に、
   同じpointerdownから独立してタイマーを走らせ、動きがあれば取り消す */
let gcellPressTimer = null;
let gcellPressStart = null; // { x, y, taskId, date }
const GCELL_LONGPRESS_MS = 500;

document.addEventListener("pointerdown", (e) => {
  if (view !== "gantt") return;
  const cell = e.target.closest("button.g-cell");
  if (!cell || !cell.dataset.task || !cell.dataset.date) return;
  gcellPressStart = { x: e.clientX, y: e.clientY, taskId: cell.dataset.task, date: cell.dataset.date };
  clearTimeout(gcellPressTimer);
  gcellPressTimer = setTimeout(() => {
    if (!gcellPressStart) return;
    const { taskId, date } = gcellPressStart;
    gcellPressStart = null;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
    openGcellForm(taskId, date);
  }, GCELL_LONGPRESS_MS);
});
document.addEventListener("pointermove", (e) => {
  if (!gcellPressStart) return;
  if (Math.abs(e.clientX - gcellPressStart.x) > 8 || Math.abs(e.clientY - gcellPressStart.y) > 8) {
    clearTimeout(gcellPressTimer);
    gcellPressStart = null;
  }
});
document.addEventListener("pointerup", () => { clearTimeout(gcellPressTimer); gcellPressStart = null; });
document.addEventListener("pointercancel", () => { clearTimeout(gcellPressTimer); gcellPressStart = null; });

document.addEventListener("contextmenu", (e) => {
  if (view !== "gantt") return;
  const cell = e.target.closest("button.g-cell");
  if (!cell || !cell.dataset.task || !cell.dataset.date) return;
  e.preventDefault();
  openGcellForm(cell.dataset.task, cell.dataset.date);
});

/* ---------- 横スワイプでのタブ切り替え ---------- */
/* 今日/計画/課題タブを横スワイプで切り替える。既に横方向の操作が
   割り当てられている領域(ガントの横スクロール・マークのドラッグ、課題タブの
   アーカイブスワイプ、並べ替えハンドル、今日タブのカード)は対象外にし、
   既存の操作を優先する。全画面フォーム表示中(lockBodyScroll中)も対象外 */
const TAB_ORDER = ["today", "gantt", "plan"];
let tabSwipe = null; // { startX, startY, curX, horiz, el }

function tabSwipeExcluded(target) {
  return !!(
    target.closest("#gantt") ||
    target.closest(".swipe-target") ||
    target.closest(".drag-h") ||
    target.closest("#timeline .t-card") ||
    target.closest("input, textarea, select")
  );
}

document.addEventListener("pointerdown", (e) => {
  if (document.body.style.position === "fixed") return; // 全画面フォーム表示中
  if (tabSwipeExcluded(e.target)) return;
  const el = document.getElementById(`view-${view}`);
  if (!el) return;
  tabSwipe = { startX: e.clientX, startY: e.clientY, curX: e.clientX, horiz: null, el };
});

document.addEventListener("pointermove", (e) => {
  if (!tabSwipe) return;
  const dx = e.clientX - tabSwipe.startX;
  const dy = e.clientY - tabSwipe.startY;
  if (tabSwipe.horiz === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    tabSwipe.horiz = Math.abs(dx) > Math.abs(dy);
    if (!tabSwipe.horiz) { tabSwipe = null; return; } // 縦方向の動きなら諦めて通常のスクロールに譲る
    tabSwipe.el.style.transition = "none";
  }
  tabSwipe.curX = e.clientX;
  e.preventDefault();
  tabSwipe.el.style.transform = `translateX(${dx}px)`;
});

function tabSwipeEnd() {
  if (!tabSwipe) return;
  const s = tabSwipe;
  tabSwipe = null;
  if (!s.horiz) return;
  const dx = s.curX - s.startX;
  const THRESHOLD = 80; // px。これ未満なら元のタブに戻す
  const idx = TAB_ORDER.indexOf(view);
  let targetIdx = idx;
  if (dx <= -THRESHOLD && idx < TAB_ORDER.length - 1) targetIdx = idx + 1; // 左スワイプ→次のタブ
  else if (dx >= THRESHOLD && idx > 0) targetIdx = idx - 1; // 右スワイプ→前のタブ

  s.el.style.transition = "transform .18s ease";
  if (targetIdx !== idx) {
    s.el.style.transform = `translateX(${dx < 0 ? "-100%" : "100%"})`;
    setTimeout(() => {
      s.el.style.transition = "";
      s.el.style.transform = "";
      switchView(TAB_ORDER[targetIdx]);
      window.scrollTo(0, 0); // タブ切り替え後はスクロール位置を一番上にする
    }, 180);
  } else {
    /* スワイプ量が閾値未満: 元のタブに戻す。この場合はスクロール位置を変えない */
    s.el.style.transform = "";
    setTimeout(() => { s.el.style.transition = ""; }, 180);
  }
}
document.addEventListener("pointerup", tabSwipeEnd);
document.addEventListener("pointercancel", tabSwipeEnd);

/* ---------- 割り当てを編集フォーム(長押し/右クリックで開く) ---------- */
/* そのマスの現在の状態(実施/予備/自動予定/自動予備/空)を判定する。
   renderGantt()のマス描画と同じ判定式 */
function gcellState(taskId, dk) {
  const t = taskById(taskId);
  const real = state.assignments.find((a) => a.taskId === taskId && a.date === dk);
  const manualRes = !real && findReserve(taskId, dk);
  const virt =
    !real &&
    t.type === "recurring" &&
    dk >= todayKey() &&
    occursOn(t, dk) &&
    !hasSkip(taskId, dk);
  const autoRes = !real && !virt && !manualRes && ruleReserveDates(t, dk, dk).has(dk);
  return { t, real, manualRes, virt, autoRes };
}

function gcellIconInfo(st) {
  if (st.real) {
    return st.real.status === "done"
      ? { icon: "✓", label: "完了", cls: "done-m" }
      : { icon: "●", label: "実施日", cls: "todo-m" };
  }
  if (st.manualRes) return { icon: "○", label: "予備日", cls: "res-m" };
  if (st.virt) return { icon: "🔁", label: "自動予定(周期タスク)", cls: "virt-m" };
  if (st.autoRes) return { icon: "○", label: "予備日(自動)", cls: "ares-m" };
  return { icon: "—", label: "空(未設定)", cls: "" };
}

function openGcellForm(taskId, dk) {
  const t = taskById(taskId);
  if (!t || isClosed(dk)) return;
  gcellEdit = { taskId, date: dk };
  document.getElementById("gc-task").textContent = t.title;
  const d = new Date(dk + "T00:00:00");
  const youbi = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  document.getElementById("gc-date").textContent = `${d.getMonth() + 1}月${d.getDate()}日(${youbi})`;
  refreshGcellForm();
  document.getElementById("gcell-form").classList.remove("hidden");
  syncFixedOffset();
  lockBodyScroll();
}

/* マークの状態が変わるたび(アイコンタップ後)に表示を更新する */
function refreshGcellForm() {
  if (!gcellEdit) return;
  const st = gcellState(gcellEdit.taskId, gcellEdit.date);
  const { icon, label, cls } = gcellIconInfo(st);
  const iconEl = document.getElementById("gc-icon");
  iconEl.textContent = icon;
  iconEl.className = `gc-icon ${cls}`;
  document.getElementById("gc-icon-label").textContent = label;
  document.getElementById("gc-start").value = st.real ? st.real.start : (st.t.defStart || "09:00");
  document.getElementById("gc-est").value = st.real ? st.real.estimateMin : (st.t.estimateMin || 25);
}

/* アイコンをタップするとマスをタップしたのと同じ順序(空→●→○→空、周期タスクは
   自動予定のオン/オフ)で状態が切り替わる。既存のtoggleCell()をそのまま使う */
function gcellIconTap() {
  if (!gcellEdit) return;
  toggleCell(gcellEdit.taskId, gcellEdit.date);
  refreshGcellForm();
}

function closeGcellForm() {
  document.getElementById("gcell-form").classList.add("hidden");
  unlockBodyScroll();
  gcellEdit = null;
}

function saveGcellForm() {
  if (!gcellEdit) return;
  const { taskId, date } = gcellEdit;
  if (isClosed(date)) { closeGcellForm(); return; }
  const t = taskById(taskId);
  const start = document.getElementById("gc-start").value || "09:00";
  const est = Math.max(1, Number(document.getElementById("gc-est").value) || 25);
  const real = state.assignments.find((a) => a.taskId === taskId && a.date === date);
  if (real) {
    real.start = start;
    real.estimateMin = est;
  } else {
    /* 実施日でなければ(予備日/自動予定/空)、開始時刻・見積を入力して保存する
       ことは実施日として確定させることを意味する。既存の予備日/スキップは解除する */
    state.reserves = state.reserves.filter((r) => !(r.taskId === taskId && r.date === date));
    if (t.type === "recurring" && hasSkip(taskId, date)) {
      state.skips = state.skips.filter((s) => !(s.taskId === taskId && s.date === date));
    }
    state.assignments.push({
      id: uid("a"), taskId, title: t.title, date, start, estimateMin: est,
      status: "todo", spentSec: 0, startedAt: null,
    });
  }
  save();
  closeGcellForm();
  renderGantt();
}

/* ---------- 描画:課題タブ(課題ごとにタスクを展開) ---------- */
let searchQuery = "";
let archFilter = localStorage.getItem("hisho:ui:archfilter") || "active";

function computeVisibleTasks() {
  const q = searchQuery.trim().toLowerCase();
  const archOkOf = (t) =>
    archFilter === "all" ? true : archFilter === "archived" ? !!t.archived : !t.archived;
  const base = new Set();
  state.tasks.forEach((t) => {
    const qOk = !q || t.title.toLowerCase().includes(q);
    if (archOkOf(t) && qOk) base.add(t.id);
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
  /* 親タスクがマッチした場合、その子タスクも検索結果としてヒットさせる */
  if (q) {
    const addChildren = (id) => {
      state.tasks.forEach((c) => {
        if (c.parentId === id && archOkOf(c) && !visible.has(c.id)) {
          visible.add(c.id);
          addChildren(c.id);
        }
      });
    };
    base.forEach((id) => addChildren(id));
  }
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
  if (fab) fab.style.display = "";
  if (view === "today") {
    const cur = currentAsg();
    renderedCurrentId = cur ? cur.id : null;
    const run = runningAsg();
    renderedOverrun = !!(run && isOver(run));
    renderTimeline();
  } else if (view === "gantt") {
    renderGantt();
  } else {
    renderPlan();
  }
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
  document.getElementById("issue-form").classList.remove("hidden");
  document.getElementById("fab").classList.add("hidden");
  syncFixedOffset(); // 全画面フォームの開始位置(ヘッダー直下)を最新化
  lockBodyScroll();
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
  document.getElementById("fab").classList.remove("hidden");
  unlockBodyScroll();
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

/* 今日タブの鉛筆アイコンから開く簡易編集。タスク自体ではなく、この日の割り当て
   (開始時刻・見積)だけを編集する全画面フォーム */
function openAsgEditForm(a) {
  editingAsgQuickId = a.id;
  document.getElementById("ae-start").value = a.start;
  document.getElementById("ae-est").value = a.estimateMin;
  document.getElementById("asg-edit-form").classList.remove("hidden");
  syncFixedOffset();
  lockBodyScroll();
}

function openTaskForm(task, parentId, presetIssueId) {
  editingTaskId = task ? task.id : null;
  taskFormReturnAnchor = task ? task.id : (parentId || null);
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
  document.getElementById("task-form").classList.remove("hidden");
  document.getElementById("fab").classList.add("hidden");
  syncFixedOffset(); // 全画面フォームの開始位置(ヘッダー直下)を最新化
  lockBodyScroll();
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
  document.getElementById("fab").classList.remove("hidden");
  unlockBodyScroll();
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

/* 全画面フォームを開いている間、背後のページがスワイプでスクロールしないようにする */
function lockBodyScroll() {
  const y = window.scrollY;
  document.body.dataset.scrollLockY = String(y);
  document.body.style.position = "fixed";
  document.body.style.top = `-${y}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
}
function unlockBodyScroll() {
  const y = Number(document.body.dataset.scrollLockY || 0);
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  delete document.body.dataset.scrollLockY;
  window.scrollTo(0, y);
}

function syncFixedOffset() {
  const bars = document.getElementById("fixedbars");
  const wrap = document.querySelector(".wrap");
  if (!bars) return;
  const h = bars.offsetHeight;
  if (wrap) wrap.style.marginTop = h ? `${h}px` : "";
  document.documentElement.style.setProperty("--fixed-h", `${h}px`); // タスク追加の全画面フォームがヘッダー直下から始まるよう共有
}

/* ヘッダーの同期状態は常に「未同期」「同期中」「同期済」の3種類のみ(表示幅を揃えるため) */
function headerSyncLabel() {
  if (syncing) return "同期中";
  if (!syncConfigured() || localStorage.getItem(DIRTY_KEY) === "1" || !localStorage.getItem(LAST_SYNC_KEY)) return "未同期";
  return "同期済";
}

/* 同期関連の状態はヘッダーにだけ出す(設定画面には出さない)。設定画面のメッセージ欄は
   保存確認や「最新版に更新」の結果など、その場の操作フィードバック専用 */
function updateHeaderSync() {
  const el = document.getElementById("sync-status");
  if (el) {
    el.textContent = headerSyncLabel();
    el.classList.toggle("err", !syncing && syncConfigured() && localStorage.getItem(DIRTY_KEY) === "1");
  }
  syncFixedOffset();
}

function setSettingsMsg(text) {
  const m = document.getElementById("settings-msg");
  if (m) m.textContent = text;
}

function scheduleSync() {
  updateHeaderSync();
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
    return;
  }
  if (!navigator.onLine) {
    updateHeaderSync();
    return;
  }
  if (syncing) return;
  syncing = true;
  updateHeaderSync();
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
    syncing = false; // ヘッダーの表示切り替え前に必ず落としておく
    if (data && data.ok) {
      localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
      localStorage.setItem(DIRTY_KEY, "0");
    }
  } catch (e) {
    syncing = false;
  }
  updateHeaderSync();
}

/* 取得→必要なら送信(起動時・復帰時・手動) */
async function fullSync(manual) {
  if (!syncConfigured()) {
    return;
  }
  if (!navigator.onLine) {
    updateHeaderSync();
    return;
  }
  if (syncing) return;
  syncing = true;
  updateHeaderSync();
  let pulled = false;
  try {
    pulled = await pullSync();
  } catch (e) {
    syncing = false;
    updateHeaderSync();
    return;
  }
  syncing = false;
  updateHeaderSync();
  if (pulled) {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  }
  if (localStorage.getItem(DIRTY_KEY) === "1") {
    await pushSync(manual);
  } else {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    updateHeaderSync();
  }
}

window.addEventListener("online", () => fullSync(false));

/* ---------- 最新版に更新 ---------- */
async function forceUpdate() {
  setSettingsMsg("更新を確認中…");
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.update();
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    setSettingsMsg("更新しました。反映するには「閉じる」の後、アプリを開き直してください");
  } catch (e) {
    setSettingsMsg("更新に失敗しました。通信環境を確認してもう一度お試しください");
  }
}

/* ---------- ミニタイマー(タイマーが見えないときの上部バナー) ---------- */
/* コンパクトなタイマーバナー(旧ヒーローカードを統合)。作業中/次にやることは
   タブや閲覧中の日付(viewDate)に関わらず、常に「本当の今日」を基準にして
   ヘッダーに固定表示する(過去日・未来日を見ていても表示し続ける) */
function updateMiniTimer() {
  const bar = document.getElementById("mini-timer");
  const warnBtn = document.getElementById("mt-warn");
  const textEl = document.getElementById("mt-text");
  const toggleBtn = document.getElementById("mt-toggle");
  if (!bar || !warnBtn || !textEl || !toggleBtn) return;
  const run = runningAsg();
  const cur = run || nextTodayAsg();
  const mine = !!(run && cur && run.id === cur.id);
  const over = !!cur && isOver(cur); // 停止中(未着手・一時停止)でも超過していれば赤くする
  const show = !!cur;

  document.body.classList.toggle("overrun", !!over);
  if (show) {
    bar.classList.toggle("over", over);
    warnBtn.classList.toggle("hidden", !over);
    const label = mine ? "作業中" : "次にやること";
    textEl.textContent = `${label}: ${asgTitle(cur)} — ${fmtDur(elapsedSec(cur))} / ${fmtDur(cur.estimateMin * 60)}`;
    toggleBtn.textContent = mine ? "停止" : "再開";
    toggleBtn.dataset.id = cur.id;
  } else {
    document.getElementById("overrun-popup").classList.add("hidden");
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
  /* タイムラインのカードをドラッグ中/長押し判定中/スワイプ代行スクロール中は
     再描画でDOMを差し替えない(1秒を超える操作で毎秒のtickにより再描画が
     割り込み、スクロールが振動して見える不具合の原因だった) */
  if (tlDrag || tlPending || tlScrollFallback) return;
  if (curId !== renderedCurrentId || over !== renderedOverrun) {
    renderAll();
  } else {
    updateNowLine();
    updateRunningCardTime();
  }
}

/* 実行中カードの経過/見積表示を、フル再描画なしで毎秒更新する */
function updateRunningCardTime() {
  const run = runningAsg();
  if (!run) return;
  const el = document.querySelector(`.t-item[data-asg="${run.id}"] .t-est`);
  /* textContentで置き換えると中の「作業中」タグ(span)まで消えてしまうため、
     renderTimeline()と同じ内容をinnerHTMLで作り直す */
  if (el) el.innerHTML = `${fmtDur(elapsedSec(run))} / ${fmtDur(run.estimateMin * 60)} <span class="t-running-tag">作業中</span>`;
}

/* ---------- イベント ---------- */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  /* 今日 */
  if (action === "start") { if (!suppressClick) startAsg(id); }
  else if (action === "pause") { if (!suppressClick) pauseAsg(id); }
  else if (action === "finish") finishAsg(id);
  else if (action === "reopen") reopenAsg(id);
  else if (action === "remove") removeAsg(id);
  else if (action === "finish-toggle") {
    const a = id ? state.assignments.find((x) => x.id === id) : null;
    if (a) { if (a.status === "done") reopenAsg(id); else finishAsg(id); }
  }
  else if (action === "asg-edit-open") {
    const a = id ? state.assignments.find((x) => x.id === id) : null;
    if (a) openAsgEditForm(a);
  }
  else if (action === "asg-edit-cancel") {
    editingAsgQuickId = null;
    document.getElementById("asg-edit-form").classList.add("hidden");
    unlockBodyScroll();
  }
  else if (action === "asg-edit-save") {
    const a = editingAsgQuickId ? state.assignments.find((x) => x.id === editingAsgQuickId) : null;
    if (a) {
      a.start = document.getElementById("ae-start").value || a.start;
      a.estimateMin = Math.max(1, Number(document.getElementById("ae-est").value) || a.estimateMin);
      save();
      renderAll();
    }
    editingAsgQuickId = null;
    document.getElementById("asg-edit-form").classList.add("hidden");
    unlockBodyScroll();
  }
  else if (action === "add-open") {
    document.getElementById("add-form").classList.remove("hidden");
    document.getElementById("fab").classList.add("hidden");
    syncFixedOffset(); // 全画面フォームの開始位置(ヘッダー直下)を最新化
    lockBodyScroll();
    /* 開始時刻は未入力をデフォルトにする。空のまま入力補助(ネイティブの時刻選択)を
       開くと、ブラウザ標準の挙動で現在時刻が基準として表示される */
    document.getElementById("f-start").value = "";
    /* 今日タブで、閲覧中の日が編集可能な時だけ「今日に追加する」を選べる。それ以外はタスク登録のみ */
    const canToday = execEditable(viewDate);
    const todayChk = document.getElementById("f-today");
    todayChk.checked = canToday;
    todayChk.disabled = !canToday;
    document.getElementById("f-today-row").classList.toggle("hidden", !canToday);
    document.getElementById("f-title").focus();
  } else if (action === "add-cancel") {
    document.getElementById("add-form").classList.add("hidden");
    document.getElementById("fab").classList.remove("hidden");
    unlockBodyScroll();
  } else if (action === "add-confirm") {
    const title = document.getElementById("f-title").value;
    if (!title.trim()) return;
    const startInput = document.getElementById("f-start").value;
    const est = document.getElementById("f-est").value;
    const todayChk = document.getElementById("f-today");
    if (todayChk.checked && !todayChk.disabled) {
      /* 開始時刻が未入力なら、今日の最後のカードの終了時刻(開始+見積)を
         自動設定する。今日にまだ何もなければ現在時刻にする */
      const start = startInput || lastTodayEnd() || nowHM();
      addAdhoc(title, start, est);
    } else {
      createSingleTask(title, startInput, est);
      save();
      renderAll();
    }
    document.getElementById("f-title").value = "";
    document.getElementById("add-form").classList.add("hidden");
    unlockBodyScroll();
    document.getElementById("fab").classList.remove("hidden");
  }

  /* タブ */
  else if (action === "tab") switchView(btn.dataset.tab);
  else if (action === "mini-jump") {
    viewDate = todayKey();
    switchView("today");
    const run = runningAsg();
    const cur = run || currentAsg();
    const el = cur ? document.querySelector(`.t-item[data-asg="${cur.id}"]`) : null;
    if (el) requestAnimationFrame(() => scrollToTimelineCard(el));
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }
  else if (action === "mt-toggle") {
    const running = runningAsg();
    if (running && running.id === id) pauseAsg(id);
    else if (id) startAsg(id);
  }
  else if (action === "mt-warn-tap") {
    document.getElementById("overrun-popup").classList.toggle("hidden");
  }
  else if (action === "d-prev") { viewDate = addDays(viewDate, -1); renderAll(); }
  else if (action === "d-next") { viewDate = addDays(viewDate, 1); renderAll(); }
  else if (action === "d-today") { viewDate = todayKey(); renderAll(); }
  else if (action === "timeline-auto-adjust") autoAdjustTimeline();
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
  else if (action === "g-today") { gStart = addDays(todayKey(), -7); selDate = todayKey(); renderGantt(true); }
  else if (action === "g-selday") {
    selDate = btn.dataset.date;
    renderGantt(true);
  } else if (action === "g-cell") {
    if (!suppressClick) toggleCell(btn.dataset.task, btn.dataset.date);
  } else if (action === "gc-icon-tap") {
    gcellIconTap();
  } else if (action === "gc-cancel") {
    closeGcellForm();
  } else if (action === "gc-save") {
    saveGcellForm();
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
    if (suppressClick) return;
    showNameTip(btn.dataset.name, btn);
  } else if (action === "issue-add") openIssueForm(null);
  else if (action === "issue-edit") openIssueForm(issueById(id));
  else if (action === "issue-cancel") {
    editingIssueId = null;
    document.getElementById("issue-form").classList.add("hidden");
    document.getElementById("fab").classList.remove("hidden");
    unlockBodyScroll();
  } else if (action === "issue-save") saveIssueForm();
  else if (action === "issue-delete") {
    if (editingIssueId && confirm("この課題を削除しますか?(タスクは残ります)")) {
      removeIssue(editingIssueId);
      editingIssueId = null;
      document.getElementById("issue-form").classList.add("hidden");
      document.getElementById("fab").classList.remove("hidden");
      unlockBodyScroll();
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
    const anchorId = taskFormReturnAnchor;
    editingTaskId = null;
    taskFormReturnAnchor = null;
    document.getElementById("task-form").classList.add("hidden");
    document.getElementById("fab").classList.remove("hidden");
    unlockBodyScroll();
    /* 戻り先がない(親を持たない新規追加)ときは何もしない。
       編集の取りやめは本人の行へ、子タスク追加の取りやめは親の行へ戻す */
    if (anchorId) {
      requestAnimationFrame(() => {
        const el = document.querySelector(`.p-row[data-task="${anchorId}"]`);
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
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
      document.getElementById("fab").classList.remove("hidden");
      unlockBodyScroll();
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
    updateHeaderSync();
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
  if (e.target.id === "g-selday-only") {
    selDayOnly = e.target.checked;
    localStorage.setItem("hisho:ui:seldayonly", selDayOnly ? "1" : "0");
    renderGantt(true);
  }
});

/* 超過警告ポップアップは画面のどこを押しても閉じる(警告マーク自身のタップで開いた瞬間は除く) */
document.addEventListener("click", (e) => {
  const popup = document.getElementById("overrun-popup");
  if (!popup || popup.classList.contains("hidden")) return;
  if (e.target.closest("#mt-warn")) return;
  popup.classList.add("hidden");
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
    if (tlDrag || tlPending || tlScrollFallback) return; // ドラッグ/スワイプ中は再描画でDOMを差し替えない
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
const verEl = document.getElementById("app-version");
if (verEl) verEl.textContent = APP_VERSION;
updateHeaderSync();
fullSync(false);
setInterval(tick, 1000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
