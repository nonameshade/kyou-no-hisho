/* ============================================================
   今日の秘書 — app.js(フェーズ4)
   データ構造 v6:
     issues:      課題 [{id, title, purpose, startDate, deadline, status,
                   color, targets:[{rank,text,doneAt}]}]
     tasks:       タスク原本 [{id, title, parentId, issueId, type,
                   estimateMin, defStart, planStart, planEnd,
                   recurrence, done, createdDate}]
     assignments: 日々への割り当て(今日画面の実体)
     skips:       周期タスクの自動予定を外した日 [{taskId, date}]
     updatedAt:   最終更新時刻(双方向同期の勝敗判定に使用)
   ============================================================ */

const STORE_KEY = "hisho:data:v1";
const APP_VERSION = "v137"; // sw.jsのCACHE版数と揃えて更新すること

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
let state = { v: 6, updatedAt: 0, issues: [], tasks: [], assignments: [], skips: [], reserves: [], closedDates: [] };
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
const G_SIDE_NAME_W = 130; // 左カラム(タスク名列)の幅。styles.cssの.g-scell-nameと合わせること
const G_SIDE_END_W = 60; // 左カラム(予定終了日列)の幅。styles.cssの.g-scell-endと合わせること

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {
    console.error("読み込みに失敗しました", e);
  }
  if (!state || typeof state !== "object") state = { v: 6, updatedAt: 0, issues: [], tasks: [], assignments: [], skips: [], reserves: [], closedDates: [] };
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
  if (state.v < 6) {
    (state.issues || []).forEach((g) => {
      if (g.startDate === undefined) g.startDate = null;
      if (g.status === undefined) g.status = "todo";
      if (g.color === undefined) g.color = null;
      (g.targets || []).forEach((t) => { if (t.doneAt === undefined) t.doneAt = null; });
    });
    state.v = 6;
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
/* 課題ごとの色。以前はインデックス依存のパレット参照で「並べ替えると色が変わる」
   不具合があり廃止された経緯があるため、必ず課題オブジェクト自身が持つ
   永続化されたcolorフィールド(なければ既定色)を返す形にする */
const issueColor = (issue) => (issue && issue.color) || "#0E7C66";
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
  /* 今日の最初のタスクの開始時刻になるまで(=today内でstartedが1件もない)は、
     前日がまだ締められておらず未完了のタスクが残っていれば、それを引き続き
     「次にやること」として表示する。前日の開始時刻が今日の最初のタスクと
     重なる(=今日の最初のタスクの開始時刻を過ぎた)時点でこの分岐には
     入らなくなり、自然に今日のタスクが優先される。前日の中では一番遅い
     開始時刻のものを対象にする(今日のstartedと同じ考え方) */
  const yesterday = addDays(todayKey(), -1);
  if (!isClosed(yesterday)) {
    const yIncomplete = dayList(yesterday).filter((a) => a.status !== "done");
    if (yIncomplete.length) return yIncomplete[yIncomplete.length - 1];
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

/* 今日タブへのタスク追加で開始時刻が未入力の時のデフォルト値。
   今日の最後のカード(開始時刻が一番遅いもの)の終了時刻(開始+見積)を返す。
   今日にまだ何もなければnullを返す */
function lastTodayEnd() {
  const list = dayItems(todayKey());
  if (!list.length) return null;
  const last = list[list.length - 1];
  return minToHm(hmToMin(last.start) + (last.estimateMin || 0));
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
     .g-side-body/.g-track-bodyのtransformが動いたまま残ってしまうため、
     切り替え前に確定させておく */
  if (view === "gantt" && v !== "gantt" && (gScrollFallback || gMomentumRAF)) {
    if (gScrollRAF) { cancelAnimationFrame(gScrollRAF); gScrollRAF = null; }
    if (gMomentumRAF) { cancelAnimationFrame(gMomentumRAF); gMomentumRAF = null; }
    gFinalizeScrollFallback();
  }
  if (view === "gantt" && v !== "gantt") {
    /* #tab-headerの高さ・#tab-header-innerのtransformは計画タブ表示中だけ
       JSが書き換える。他タブでは常に自然な表示に戻すため、離れる際は必ず
       元に戻す(ジェスチャーが途中でなくても、畳んだ状態のまま次のタブに
       引き継がないように) */
    const header = document.getElementById("tab-header");
    if (header) header.style.height = "";
    const headerInner = document.getElementById("tab-header-inner");
    if (headerInner) headerInner.style.transform = "";
  }
  /* 計画タブに入るたびに、選択中の日付による絞り込みの対象を最新化する
     (前回タブを離れてからの変更を反映するため。タブ滞在中の個々のマーク
     編集では更新しない、recomputeSelDayVisible()のコメント参照) */
  if (v === "gantt" && selDate !== null) recomputeSelDayVisible();
  if (v === "gantt" && view !== "gantt") {
    /* 別タブから計画タブに入るときは、#tab-headerが畳まれていない
       (タブバーが全部見える)状態から始める。gHeaderMaxはまだ測定して
       いないことがあるため、大きめの負の値を仮に入れておき、この後
       renderGantt()から呼ばれるgRecalcScrollMax()で
       -gHeaderMaxに正しくクランプされる */
    gScrollTop = -999999;
  }
  view = v;
  document.body.dataset.view = v;
  document.querySelectorAll(".tab").forEach((el) =>
    el.classList.toggle("active", el.dataset.tab === v)
  );
  document.getElementById("view-today").classList.toggle("hidden", v !== "today");
  document.getElementById("view-gantt").classList.toggle("hidden", v !== "gantt");
  document.getElementById("view-plan").classList.toggle("hidden", v !== "plan");
  /* タブボタンを直接タップした場合(スワイプでのタブ切り替えは別途
     window.scrollTo(0,0)している)もページのスクロール位置を一番上に戻す。
     計画タブは#gantt自体が画面の残り高さぶんの固定表示領域になっており、
     .cal-stickyのすぐ下から始まる前提で高さを計算しているため、切り替え前の
     タブでページが下にスクロールされたままだと表示が崩れて見える */
  window.scrollTo(0, 0);
  /* #fixedbars(タイマーバナーの表示/非表示で高さが変わりうる)の高さを
     確定させてからrenderAll()を呼ぶ。順序が逆だと、計画タブの#gantt自身の
     高さ(#fixedbars等の高さを基準に画面の残り高さとして算出する)が
     古い高さで計算されてしまう */
  updateMiniTimer();
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
  const timeEl = tlDrag.el.querySelector(".t-time");
  if (gapIndex === orig) {
    /* 元の位置に戻っている間は、4ルールでの計算値ではなく元の開始時刻をそのまま表示する
       (ドロップ時に開始時刻を変更しないのに合わせるため) */
    if (timeEl) timeEl.textContent = tlDrag.originalStart;
    return;
  }
  const above = tlDrag.others[gapIndex - 1] || null;
  const below = tlDrag.others[gapIndex] || null;
  const startMin = tlComputeStart(above, below, tlDrag.estimateMin);
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
    originalStart: item.dataset.start,
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
  /* 元の位置(掴んだ時点のgapIndex)のまま、または動かして元の位置に戻して
     ドロップした場合は、並び順が変わっていないので開始時刻は変更しない */
  const moved = d.gapIndex !== d.originalIndex;
  if (a) {
    if (moved && startMin !== null) a.start = minToHm(startMin);
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

/* タスクtが日付dkに関係する(実施日・予備日・周期の自動予定・自動予備日の
   いずれかがある)かどうか。日付見出しをタップして選択したときの絞り込みに使う。
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

/* 選択中の日付(日付見出しをタップして選ぶ)による絞り込みの表示対象タスクid
   一覧。マスのタップ/長押し編集/ドラッグ移動でカレンダーを操作しても、この
   一覧はその場では更新しない(誤ってマークを消した、あるいはマークを変更
   する途中で一時的に空欄を通過しただけの可能性があるため、対象から外れた
   行をその場で消してしまわないようにする)。日付の選択が変わったときなど、
   明示的なタイミングだけでrecomputeSelDayVisible()を呼んで更新する。
   selDateがnull(日付が選択されていない)ときはこの絞り込み自体を適用しない */
let selDayVisibleIds = null;
function recomputeSelDayVisible() {
  selDayVisibleIds = selDate === null
    ? null
    : new Set(state.tasks.filter((t) => taskRelevantToDate(t, selDate)).map((t) => t.id));
}

/* ガント表のタスク名検索(半角/全角スペース区切りの複数キーワードAND検索、
   大文字小文字を区別しない)。マーク操作とは無関係な絞り込みのため、
   選択日の絞り込みと違いスナップショットにせず、入力のたびに即座に反映する */
let gTaskSearch = "";
function ganttSearchKeywords() {
  return gTaskSearch.trim().split(/[\s　]+/).filter(Boolean).map((k) => k.toLowerCase());
}
/* タスクt自身のタイトルが全キーワードを含むか、配下(子孫)にそういうタスクが
   1つでもあれば表示対象とする(taskRelevantToDateと同じ「祖先も文脈として
   表示する」考え方をキーワード検索にも適用したもの) */
function taskMatchesSearch(t, keywords) {
  if (keywords.every((k) => t.title.toLowerCase().includes(k))) return true;
  return state.tasks.some((c) => c.parentId === t.id && taskMatchesSearch(c, keywords));
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

function renderGantt(refreshVisibility, scrollToTodayLeft) {
  const box = document.getElementById("gantt");
  const archChk = document.getElementById("g-showarch");
  if (archChk) archChk.checked = showArch;
  const searchInput = document.getElementById("g-task-search");
  if (searchInput && searchInput.value !== gTaskSearch) searchInput.value = gTaskSearch;
  const searchClearBtn = document.getElementById("g-search-clear");
  if (searchClearBtn) searchClearBtn.classList.toggle("hidden", !gTaskSearch);
  if (selDate !== null && (refreshVisibility || !selDayVisibleIds)) recomputeSelDayVisible();
  const searchKeywords = ganttSearchKeywords();

  if (!state.tasks.length) {
    box.innerHTML = `<div class="g-empty">課題タブでタスクを登録すると、ここで日付マスをタップして割り当てられます。</div>`;
    return;
  }
  const prevScroll = box.querySelector(".g-scroll");
  const keepLeft = prevScroll ? prevScroll.scrollLeft : null;
  const prevSideScroll = box.querySelector(".g-side-clip");
  const keepSideLeft = prevSideScroll ? prevSideScroll.scrollLeft : null;
  const sideW = G_SIDE_NAME_W + G_SIDE_END_W;

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
          (selDate !== null && !(selDayVisibleIds && selDayVisibleIds.has(t.id))) || // 選択中の日付での絞り込み(スナップショット)
          (searchKeywords.length > 0 && !taskMatchesSearch(t, searchKeywords)); // タスク名検索(即時反映)
        if (!hideThis) {
          const children = state.tasks.filter((c) => c.parentId === t.id);
          const color = t.issueId ? issueColor(issueById(t.issueId)) : "#0E7C66";
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
          /* 実施予定なし: 今日以降の実施日(●)が1件も無い(過去にしか実施予定が
             無いタスクも「予定なし」扱いにする)。行全体を着色して分かりやすくする */
          const unsched =
            (t.type === "single" || t.type === "irregular") &&
            !t.done &&
            !children.length &&
            !state.assignments.some((a) => a.taskId === t.id && a.date >= tk);
          const endLabel = t.planEnd ? esc(t.planEnd.slice(5).replace("-", "/")) : "";
          sideRows.push(`
            <div class="g-scell ${t.done ? "done-task" : ""} ${unsched ? "unsched" : ""}" data-task="${t.id}">
              <span class="g-scell-name" style="padding-left:${4 + depth * 14}px">
                ${caretG}
                <span class="g-name" title="${esc(t.title)}" data-action="g-showname" data-name="${esc(t.title)}">${rec}${esc(t.title)}</span>
              </span>
              <span class="g-scell-end">${endLabel}</span>
            </div>`);
          trackRows.push(`<div class="g-trow ${unsched ? "unsched" : ""}">${weCols}${lockCols}${todayLine}${bar}${cells}</div>`);
        }
        if (!collapsedIds.has(t.id)) walk(t.id, depth + 1);
      });
  };
  walk(null, 0);

  box.innerHTML = `
    <div class="g-wrap2">
      <div class="g-side">
        <div class="g-side-head">
          <div class="g-side-head-clip">
            <div class="g-side-head-inner" style="width:${sideW}px">
              <div class="g-scell g-sh"><span class="g-scell-name">タスク</span><span class="g-scell-end">終了日</span></div>
              <div class="g-scell g-ss"><span class="g-scell-name">見積合計</span><span class="g-scell-end"></span></div>
            </div>
          </div>
        </div>
        <div class="g-side-clip">
          <div class="g-side-body" style="width:${sideW}px">
            ${sideRows.join("")}
          </div>
        </div>
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
          <div class="g-track-body" style="width:${trackW}px">
            ${trackRows.join("")}
          </div>
        </div>
      </div>
    </div>`;

  const sc = box.querySelector(".g-scroll");
  if (sc) {
    /* 「今日へ」ボタンでは、今日の列がちょうど一番左に来るようにする
       (前回のスクロール位置は引き継がない) */
    if (scrollToTodayLeft && tdIdx >= 0) sc.scrollLeft = Math.max(0, tdIdx * G_COLW);
    else if (keepLeft !== null) sc.scrollLeft = keepLeft;
    else if (tdIdx >= 0) sc.scrollLeft = Math.max(0, (tdIdx - 3) * G_COLW);
  }
  const sideSc = box.querySelector(".g-side-clip");
  if (sideSc && keepSideLeft !== null) sideSc.scrollLeft = keepSideLeft;
  /* 日付見出し行(.g-track-head-inner)は.g-scrollの外に出したため、
     横スクロール位置を自分では追随しない。scrollLeft復元直後に
     一度だけ明示的に揃えておく(以後はsyncGanttTrackHeadX()が
     .g-scrollのscrollイベントで追随させる)。左カラムの見出しも同様に
     syncGanttSideHeadX()で.g-side-clipに追随させる */
  syncGanttTrackHeadX();
  syncGanttSideHeadX();
  applyGanttViewportHeight();
  /* renderGantt()はDOMを丸ごと作り直す(.g-side-body/.g-track-bodyも新しい
     要素になり、transformは初期状態=0に戻る)。gScrollTop自体は再描画をまたいで
     保持される値なので、gRecalcScrollMax()が範囲をクランプし直したうえで
     新しいDOMにも現在位置を反映させる(内部でgApplyScrollPosition()を呼ぶ) */
  gRecalcScrollMax();
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
/* 左カラム(タスク名+予定終了日の2カラム)の見出し行も、右側と同じ理由・
   同じ方式で.g-side-clipの横スクロールに追従させる */
function syncGanttSideHeadX() {
  const scroller = document.querySelector("#gantt .g-side-clip");
  const headInner = document.querySelector("#gantt .g-side-head-inner");
  if (scroller && headInner) headInner.style.transform = `translateX(${-scroller.scrollLeft}px)`;
}
{
  const box = document.getElementById("gantt");
  if (box) {
    box.addEventListener("scroll", syncGanttTrackHeadX, true);
    box.addEventListener("scroll", syncGanttSideHeadX, true);
  }
}

/* .cal-sticky(範囲選択ナビ)のすぐ下の位置。#gantt自身の高さ
   (applyGanttViewportHeight())の算出に使う(画面の残り高さ=画面全体の高さ
   - この値) */
function ganttTopEdge() {
  const bars = document.getElementById("fixedbars");
  const nav = document.querySelector(".cal-sticky");
  const navTop = nav ? parseFloat(getComputedStyle(nav).top) || 0 : 0;
  return nav ? navTop + nav.getBoundingClientRect().height : (bars ? bars.getBoundingClientRect().height : 0);
}

window.addEventListener("resize", () => {
  /* DevToolsのスマホ/PC表示切り替え等でリサイズが発生すると、進行中の
     ポインタ操作にpointerup/pointercancelが届かないまま終わることがあり、
     gScrollFallbackがtrueに固定されたままになる不具合があった。リサイズ時は
     進行中のフェイクスクロールを強制的に確定させ、状態が固定化されない
     ようにする */
  if (gScrollFallback) {
    if (gScrollRAF) { cancelAnimationFrame(gScrollRAF); gScrollRAF = null; }
    if (gMomentumRAF) { cancelAnimationFrame(gMomentumRAF); gMomentumRAF = null; }
    gFinalizeScrollFallback();
  }
  applyGanttViewportHeight();
  gRecalcScrollMax();
});

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
function hideNameTip() {
  const tip = document.getElementById("name-tip");
  if (!tip) return;
  tip.style.display = "none";
  showNameTip._anchor = null;
  clearTimeout(showNameTip._t);
}

function showNameTip(text, anchor) {
  let tip = document.getElementById("name-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "name-tip";
    document.body.appendChild(tip);
  }
  /* 同じタイトルをもう一度タップしたら閉じる */
  if (tip.style.display === "block" && showNameTip._anchor === anchor) {
    hideNameTip();
    return;
  }
  showNameTip._anchor = anchor;
  tip.textContent = text;
  tip.style.display = "block";
  /* タップしたタスク名の真上に、テキストの開始位置を揃えて表示する(ページ座標で
     固定し、スクロールに追随してずれが蓄積しないようにする)。anchor(.g-name)の
     左端=タスク名の文字の開始位置そのものなので、チップ自身の左パディング(12px、
     #name-tipのpadding: 8px 12px参照)分だけ差し引けば、チップの枠ではなく
     中のテキストの位置が揃う */
  const r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const x = Math.max(8 + window.scrollX, Math.min(r.left + window.scrollX - 12, window.scrollX + window.innerWidth - w - 8));
  tip.style.left = `${x}px`;
  tip.style.top = `${r.top + window.scrollY - h - 6}px`;
  clearTimeout(showNameTip._t);
  showNameTip._t = setTimeout(hideNameTip, 4000);
}

/* 時間経過だけでなく、ツールチップの外側での操作(タップ・ドラッグの開始など)
   があった時点でも閉じる。アンカー自身への操作は上のトグル処理(同じ行を
   もう一度タップしたら閉じる)に任せるため、ここでは触らない */
document.addEventListener("pointerdown", (e) => {
  const tip = document.getElementById("name-tip");
  if (!tip || tip.style.display !== "block") return;
  if (showNameTip._anchor && showNameTip._anchor.contains(e.target)) return;
  hideNameTip();
});

/* ---------- 課題タブ:長押しドラッグでの並べ替え・複製メニュー・横スワイプ(統合) ----------
   以前はハンドル(.drag-h)を掴んだ瞬間にドラッグが始まる方式(並べ替え)と、
   カード本体を横スワイプするとアーカイブボタンが出る方式(swipe)が、別々の
   pointerdownリスナーとして共存していた(ハンドルという別要素上でしか
   発火しないため互いに競合しなかった)。今回ハンドルを廃止し、カード/行
   本体を今日タブと同じ「長押しで掴む」方式の並べ替え起点にしたため、
   同じ要素の同じpointerdownを長押しドラッグと横スワイプの両方が奪い合う
   ことになり、1つの状態機械に統合する必要が生じた。

   1回のpointerdownからの分岐:
   1. 短いタップ(450ms未満・8px未満): 何もしない(課題カードの開閉トグルは
      既存のissue-openクリックハンドラがsuppressClickを見て自然に処理する)。
   2. 長押し確定(450ms経過・8px未満)後、そのまま指を離す: 課題カードのみ
      複製メニューを表示する(タスク行は何もしない)。
   3. 長押し確定後にドラッグ: 今日タブのtlApplyGap方式(他のカードを
      translateYでリアルタイムに動かして隙間を見せる)で並べ替える。
   4. 450ms未満に8px以上・横方向優勢に動いた場合: 横スワイプ(アーカイブ
      ボタン表示)に移行する。アーカイブスワイプが可能な行(.swipeable内)
      に限る。
   5. 450ms未満に8px以上・縦方向優勢に動いた場合: 手動スクロール代行
      (planScrollFallback)に切り替える。.swipe-targetはtouch-action:noneの
      ため(不具合Aの対策、下記)ブラウザはネイティブスクロールしてくれない。
      今日タブのtlScrollFallbackと全く同じ方式(指が触れている間は.wrapを
      transformで見た目だけ動かし、実際のスクロール位置は指を離した瞬間に
      一度だけ確定させる。window.scrollToは指が動いている間ずっと呼ぶと
      レイアウトを伴う重い処理でタッチ追跡と競合し振動して見えるため)。
      #timeline-headのようなsticky吸着の複雑さが無いぶんシンプルで、
      慣性(モーメンタム)も付けない。 */
const PLAN_LONGPRESS_MS = 450;
let planPending = null; // 判定待ち { type, id, el, px, py, swipeable, swipeBase }
let planLongPressTimer = null;
let planDrag = null; // 並べ替えドラッグ確定後 { type, id, el, height, originalIndex, others, gapIndex, startX, startY, py, curX, curY, scrollStart, placeholder }
let planAutoScrollSpeed = 0;
let planAutoScrollRAF = null;
let planScrollFallback = false; // 手動スクロール代行中か(不具合A対策)
let planScrollStartY = 0; // フォールバック開始時の指のY座標(基準点)
let planScrollStartScrollY = 0; // フォールバック開始時のスクロール位置(基準点)
let planScrollMaxY = 0; // フォールバック開始時点でのスクロール可能な最大値(上下端のクランプ用)
let planScrollPendingY = null; // まだ画面に反映していない最新の指のY座標
let planScrollRAF = null;
let swipe = null; // 横スワイプ確定後 { row, wrap, sx, sy, horiz, base, cur }
let openSwipeRow = null;
let planMenuAnchor = null; // 複製メニューを開いている対象カード要素
let planMenuIssueId = null;

/* フォールバック開始時の基準点からのオフセットを、上下端を超えないようクランプする
   (今日タブのtlClampScrollOffsetと同じ) */
function planClampScrollOffset(offset) {
  const minOffset = planScrollStartScrollY - planScrollMaxY;
  const maxOffset = planScrollStartScrollY;
  return Math.max(minOffset, Math.min(maxOffset, offset));
}

/* 指の最新位置に合わせて.wrap全体をtransformで見た目だけ動かす(今日タブの
   tlApplyScrollFallbackと同じ)。window.scrollToを指が動くたびに呼ぶと、
   iOS側のタッチ追跡処理と競合して描画が追いつかず画面が振動して見える
   ことがあるため、指が触れている間はGPU合成だけで完結するtransformで
   見た目を追従させ、実際のスクロール位置は指を離した瞬間に一度だけ
   確定させる(planFinalizeScrollFallback)。課題タブには今日タブの
   #timeline-headのようなsticky要素が無いため、打ち消し用の逆transformは
   不要(.wrap自体の移動がそのまま正しい見た目になる) */
function planApplyScrollFallback() {
  planScrollRAF = null;
  if (!planScrollFallback || planScrollPendingY === null) return;
  const wrap = document.querySelector(".wrap");
  if (!wrap) return;
  const offset = planClampScrollOffset(planScrollPendingY - planScrollStartY);
  wrap.style.transform = `translateY(${offset}px)`;
}

/* スワイプを終え、transformで見せていた位置を実際のスクロール位置として
   一度だけ確定する(今日タブのtlFinalizeScrollFallbackと同じ) */
function planFinalizeScrollFallback() {
  planScrollFallback = false;
  const wrap = document.querySelector(".wrap");
  if (wrap) {
    if (planScrollPendingY !== null) {
      /* 確定時だけは、キャッシュ済みのplanScrollMaxY(ジェスチャー開始時点の値)
         ではなく今の実際の最大スクロール量で上限を取り直す */
      const freshMaxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const minOffset = planScrollStartScrollY - freshMaxY;
      const maxOffset = planScrollStartScrollY;
      const rawOffset = planScrollPendingY - planScrollStartY;
      const finalOffset = Math.max(minOffset, Math.min(maxOffset, rawOffset));
      window.scrollTo(0, planScrollStartScrollY - finalOffset);
    }
    wrap.style.transform = "";
  }
  planScrollPendingY = null;
  if (planScrollRAF) { cancelAnimationFrame(planScrollRAF); planScrollRAF = null; }
}

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

/* gapIndexに応じて他のカード/行をずらして隙間を空ける(今日タブのtlApplyGap相当) */
function applyPlanGap(gapIndex) {
  const orig = planDrag.originalIndex;
  planDrag.others.forEach((o, i) => {
    let shift = 0;
    if (gapIndex > orig && i >= orig && i < gapIndex) shift = -planDrag.height;
    else if (gapIndex < orig && i >= gapIndex && i < orig) shift = planDrag.height;
    o.el.style.transform = shift ? `translateY(${shift}px)` : "";
  });
  planDrag.gapIndex = gapIndex;
}

/* 現在の指位置に合わせて掴んでいる要素の見た目とgapIndexを更新する(今日タブのtlUpdateDragVisual相当) */
function updatePlanDragVisual() {
  planDrag.el.style.transform = `translateY(${planDrag.curY - planDrag.py}px)`;
  const scrolled = window.scrollY - planDrag.scrollStart;
  let idx = 0;
  planDrag.others.forEach((o) => { if (o.midY - scrolled < planDrag.curY) idx++; });
  if (idx !== planDrag.gapIndex) applyPlanGap(idx);
}

function planAutoScrollTick() {
  if (!planDrag || !planAutoScrollSpeed) { planAutoScrollRAF = null; return; }
  window.scrollBy(0, planAutoScrollSpeed);
  updatePlanDragVisual();
  planAutoScrollRAF = requestAnimationFrame(planAutoScrollTick);
}

/* 画面の上端/下端付近にポインタが来たらゆっくりスクロールする */
function updatePlanAutoScroll(clientY) {
  const EDGE = 70;
  const MAX_SPEED = 9;
  const vh = window.innerHeight;
  let speed = 0;
  if (clientY < EDGE) {
    speed = -MAX_SPEED * (1 - clientY / EDGE);
  } else if (clientY > vh - EDGE) {
    speed = MAX_SPEED * (1 - (vh - clientY) / EDGE);
  }
  planAutoScrollSpeed = speed;
  if (speed && !planAutoScrollRAF) planAutoScrollRAF = requestAnimationFrame(planAutoScrollTick);
}

function stopPlanAutoScroll() {
  planAutoScrollSpeed = 0;
  if (planAutoScrollRAF) { cancelAnimationFrame(planAutoScrollRAF); planAutoScrollRAF = null; }
}

function hidePlanMenu() {
  const menu = document.getElementById("plan-menu");
  if (menu) menu.style.display = "none";
  planMenuAnchor = null;
  planMenuIssueId = null;
}

/* 課題カードの複製メニュー(name-tipと同じ「浮動要素をJS生成、外側操作/タイムアウトで閉じる」方式) */
function showPlanMenu(issue, anchor) {
  if (!issue) return;
  let menu = document.getElementById("plan-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "plan-menu";
    menu.innerHTML = `<button type="button" data-action="issue-duplicate">複製</button>`;
    document.body.appendChild(menu);
  }
  planMenuAnchor = anchor;
  planMenuIssueId = issue.id;
  menu.style.display = "block";
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const x = Math.max(8 + window.scrollX, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${r.top + window.scrollY - h - 6}px`; // 対象カードの真上に表示
}

document.addEventListener("pointerdown", (e) => {
  const menu = document.getElementById("plan-menu");
  if (!menu || menu.style.display !== "block") return;
  if (planMenuAnchor && planMenuAnchor.contains(e.target)) return;
  if (e.target.closest("#plan-menu")) return;
  hidePlanMenu();
});

/* 長押し確定:今日タブのtlStartDrag相当。要素をposition:fixedにして指に追従させ、
   元の位置には高さ保持用のプレースホルダーを置く */
function planStartDrag(p) {
  const { type, id, el } = p;
  let allInclSelf = [...document.querySelectorAll(type === "issue" ? ".issue-card[data-issue]" : ".p-row[data-task]")];
  if (type === "task") {
    const dragged = taskById(id);
    allInclSelf = allInclSelf.filter((x) => {
      if (x === el) return true;
      const t = taskById(x.dataset.task);
      if (!t || !dragged) return false;
      if ((t.parentId || null) !== (dragged.parentId || null)) return false;
      if (!dragged.parentId && (t.issueId || null) !== (dragged.issueId || null)) return false;
      return true;
    });
  }
  allInclSelf.forEach((x) => { x.style.transition = "none"; x.style.transform = ""; });
  void el.parentNode.offsetHeight; // 直前のtransition/transform解除を確実に反映させてから測定する

  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const height = rect.height + (parseFloat(style.marginBottom) || 0);
  const originalIndex = allInclSelf.indexOf(el);
  const others = allInclSelf
    .filter((x) => x !== el)
    .map((x) => {
      const r = x.getBoundingClientRect();
      return { el: x, midY: r.top + r.height / 2 };
    });

  const placeholder = document.createElement("div");
  placeholder.className = "plan-drag-placeholder";
  placeholder.style.height = `${height}px`;
  el.parentNode.insertBefore(placeholder, el);

  planDrag = {
    type, id, el, height, originalIndex, others,
    gapIndex: originalIndex,
    startX: p.px, startY: p.py,
    py: p.py, curX: p.px, curY: p.py,
    scrollStart: window.scrollY,
    placeholder,
  };

  el.style.position = "fixed";
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.margin = "0";
  el.style.zIndex = "50";
  el.classList.add("plan-dragging");
  try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (planDrag) planDrag.others.forEach((o) => { o.el.style.transition = ""; });
    });
  });
}

document.addEventListener("pointerdown", (e) => {
  if (view !== "plan") return;
  if (e.target.closest("button") || e.target.closest(".caret") || e.target.closest("input, textarea, select")) return;
  const el = e.target.closest(".swipe-target");
  if (openSwipeRow && openSwipeRow !== el) closeOpenSwipe();
  if (!el) return;
  clearTimeout(planLongPressTimer);
  const type = el.dataset.issue !== undefined ? "issue" : "task";
  const id = type === "issue" ? el.dataset.issue : el.dataset.task;
  planPending = {
    type, id, el,
    px: e.clientX, py: e.clientY,
    swipeable: !!el.closest(".swipeable"), // アーカイブ済みの行/カードは横スワイプ対象外
    swipeBase: el === openSwipeRow ? -88 : 0, // 開いた状態から右スワイプで戻せるように基点を持つ
  };
  planLongPressTimer = setTimeout(() => {
    if (planPending) planStartDrag(planPending);
    planPending = null;
  }, PLAN_LONGPRESS_MS);
});

document.addEventListener("pointermove", (e) => {
  if (view !== "plan") return;
  if (planPending) {
    const dx = e.clientX - planPending.px;
    const dy = e.clientY - planPending.py;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      clearTimeout(planLongPressTimer);
      if (planPending.swipeable && Math.abs(dx) > Math.abs(dy)) {
        swipe = {
          row: planPending.el,
          wrap: planPending.el.closest(".swipe-wrap"),
          sx: planPending.px,
          sy: planPending.py,
          horiz: null,
          base: planPending.swipeBase,
          cur: null,
        };
      } else {
        /* 縦方向優勢(またはアーカイブスワイプ対象外の行での横方向の動き):
           .swipe-targetはtouch-action:noneのためブラウザは代わりにスクロール
           してくれない。指の動きぶんをこちらで手動スクロールする */
        planScrollFallback = true;
        planScrollStartY = e.clientY;
        planScrollStartScrollY = window.scrollY;
        planScrollMaxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        planScrollPendingY = null;
        /* マウスでのスワイプ操作はブラウザ側で移動量に関わらずclickが
           発火してしまい、開閉トグルなどが誤爆するため抑制する(今日タブと同じ) */
        suppressClick = true;
      }
      planPending = null;
    }
    return;
  }
  if (planScrollFallback) {
    e.preventDefault();
    planScrollPendingY = e.clientY;
    if (!planScrollRAF) planScrollRAF = requestAnimationFrame(planApplyScrollFallback);
    return;
  }
  if (swipe) {
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
    return;
  }
  if (planDrag) {
    planDrag.curX = e.clientX;
    planDrag.curY = e.clientY;
    updatePlanAutoScroll(e.clientY);
    updatePlanDragVisual();
  }
});

function planPointerEnd() {
  clearTimeout(planLongPressTimer);
  planPending = null;
  if (planScrollFallback) {
    planFinalizeScrollFallback();
    setTimeout(() => { suppressClick = false; }, 80);
  }

  if (swipe) {
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
    return;
  }

  if (!planDrag) return;
  const d = planDrag;
  planDrag = null;
  stopPlanAutoScroll();
  d.el.classList.remove("plan-dragging");
  d.el.style.position = "";
  d.el.style.left = "";
  d.el.style.top = "";
  d.el.style.width = "";
  d.el.style.margin = "";
  d.el.style.zIndex = "";
  d.el.style.transform = "";
  if (d.placeholder && d.placeholder.parentNode) d.placeholder.remove();
  d.others.forEach((o) => { o.el.style.transform = ""; });

  /* 長押し確定後、指をほぼ動かさずに離した場合(=8px未満)は「並べ替えドラッグ
     ではなく長押しそのもの」とみなし、課題カードなら複製メニューを表示する
     (タスク行は何もしない)。gapIndexが元のままかどうかではなく実際の指の
     移動量で判定するのは、一度動かしてから元の位置に戻して離した場合は
     複製メニューではなく通常のドラッグ確定として扱いたいため */
  const heldStill = Math.abs(d.curX - d.startX) < 8 && Math.abs(d.curY - d.startY) < 8;
  if (heldStill) {
    if (d.type === "issue") {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 80);
      showPlanMenu(issueById(d.id), d.el);
    }
    return;
  }

  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 80);

  if (d.type === "issue") {
    const order = d.others.map((o) => o.el.dataset.issue);
    order.splice(d.gapIndex, 0, d.id);
    state.issues = order.map((id) => issueById(id)).filter(Boolean);
    save();
    renderPlan();
  } else {
    const dragged = taskById(d.id);
    if (dragged) {
      state.tasks = state.tasks.filter((t) => t.id !== d.id);
      if (d.gapIndex < d.others.length) {
        const before = taskById(d.others[d.gapIndex].el.dataset.task);
        const pos = state.tasks.indexOf(before);
        state.tasks.splice(pos, 0, dragged);
      } else {
        const lastSib = taskById(d.others[d.others.length - 1].el.dataset.task);
        const pos = state.tasks.indexOf(lastSib) + 1;
        state.tasks.splice(pos, 0, dragged);
      }
      save();
      renderPlan();
    }
  }
}
document.addEventListener("pointerup", planPointerEnd);
document.addEventListener("pointercancel", planPointerEnd);

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
/* 【アーキテクチャ】ガント表(#gantt)は画面の残り高さぶんに固定された表示領域
   (overflow:hidden、高さはapplyGanttViewportHeight()がJSで算出)を持ち、
   その中でタスク行の一覧だけが縦にJS管理のフェイクスクロールで動く。見出し行
   (.g-track-head/.g-side .g-scell.g-sh/.g-ss)や範囲選択ナビ(.cal-sticky)は
   一切動かない、単純な静的要素になる(position:stickyもJSのtransformも
   使わない)。
   以前は.wrap(計画タブの中身全体を包む祖先要素、ページ全体スクロールの
   一部)を透明祖先としてtransformで動かし、その中にあるsticky要素
   (ガント見出し行3つ・.cal-sticky)をそれぞれ逆transformで打ち消して見た目
   だけ静止させる設計だった。しかしDevToolsでの実機調査で、スクロール確定の
   瞬間(祖先のtransform解除・window.scrollTo()・sticky要素の逆transform解除
   が同じタイミングで起きる)に、ちょうど1フレームだけガント見出し行が完全に
   欠けて描画される不具合が繰り返し発生することが分かった。
   measureGanttSticky()の誤測定・topEdgeの丸め誤差・will-change・祖先自体の
   transformトグル・position:fixed一時退避の有無・確定処理のフレーム分割など、
   考えられる原因を数多く検証・除外した結果、「sticky要素がtransformされた
   祖先の中で動かされ、逆transformで戻される」という設計自体がこの不具合の
   温床になっていると判断し、根本的に作り直した。
   新しい設計では、ガント表専用の固定表示領域を作ることで、そもそもページ
   全体をスクロールする必要がなくなった(#gantt自身が画面の残り高さに収まる
   ため)。したがって.cal-sticky・ガント見出し行のどちらも、もう一切動かす
   必要がない(position:sticky/JSのtransform、どちらも不要)。実際にJSで
   動かす対象は、ガント表の「本体」側の要素(.g-side-body: タスク行の一覧、
   .g-track-body: 日付マスが並ぶ本体)だけになった。ドラッグ中は見た目だけ
   動かし、指を離したら速度に応じてJSで慣性させる。ページ全体のscrollには
   一切触れないため、window.scrollTo()も.cal-stickyのposition:fixed一時退避も
   不要になった。
   【v119で追加】.topbar/.tabs(#tab-header)を上にスクロールして隠す操作も、
   この#gantt内でのドラッグに統一した(以前は#gantt外の.topbar/.tabs/
   .cal-stickyから始まるジェスチャーをページのネイティブスクロールに任せて
   いたが、iPhoneでは範囲が狭く操作しづらいうえ、「上の方でスワイプしたのに
   下のガント表が反応しているように見える」という分かりにくさがあった)。
   gScrollTopの値の範囲を0始まりではなく負の領域まで拡張し、
   [-gHeaderMax, gScrollMaxTop] とする。gScrollTopが負の間は「#tab-header
   を畳んでいる途中」を表し、本体(.g-side-body/.g-track-body)は動かさない。
   0を超えたら#tab-headerは完全に畳まれた状態のまま、本体側のスクロールに
   切り替わる(gApplyScrollPosition()参照)。1本のドラッグ/慣性で連続して
   両方を扱えるため、境界での特別な処理は不要 */
let gScrollPending = null; // 判定待ち { x, y }
let gScrollFallback = false;
let gScrollStartY = 0; // ジェスチャー開始時の指のY座標(ホイールは基準として0)
let gScrollTop = 0; // ガント表内の仮想スクロール位置。0=#tab-header畳み終わり/本体一番上。負の値=#tab-header畳み途中
let gScrollStartTop = 0; // ジェスチャー開始時点のgScrollTop
let gHeaderMax = 0; // #tab-headerの自然な高さ(=畳める最大量)
let gScrollMaxTop = 0; // 最大スクロール量(自然な最大=gNaturalMaxTop + FABクリアランス猶予=gFabGap)
let gNaturalMaxTop = 0; // 全行が実際に収まりきらない量(本体の全高 - フル表示領域の高さ)。FABクリアランスは含まない
let gFabGap = 0; // gNaturalMaxTopを超えて引っ張れる猶予量(=gFabClearance())。この分だけ#gantt自体が縮んで外側に余白が現れる
let gGanttFullHeight = 0; // #gantt本来の(FABクリアランスで縮める前の)高さ
let gScrollPendingTop = null; // ドラッグ中の暫定スクロール位置
let gScrollRAF = null;
let gScrollVelSamples = [];
let gMomentumRAF = null;
let gWheelEndTimer = null; // マウスホイールでの疑似スクロール確定待ちタイマー

/* FAB(タスクを追加ボタン)の実際の画面上の位置から、最後の行がその裏に
   隠れないために必要なクリアランス量を算出する。#fabはposition:fixedなので
   getBoundingClientRect().topがそのままenv(safe-area-inset-bottom)込みの
   実際の表示位置になる */
function gFabClearance() {
  const fab = document.getElementById("fab");
  if (!fab) return 0;
  return Math.max(0, window.innerHeight - fab.getBoundingClientRect().top + 12);
}

/* #gantt自体の高さを「画面の残り高さ」(=フルの高さ、gGanttFullHeight)に
   リセットする。.cal-stickyのすぐ下から画面下端までを表示領域とする。
   FABクリアランスはここでは一切考慮しない(常にフルの高さに戻すだけ)。
   実際に高さを縮めて外側に余白を作るかどうかはgApplyScrollPosition()が
   現在のスクロール位置(gScrollTop)に応じて毎回判定する(下記参照) */
function applyGanttViewportHeight() {
  const box = document.getElementById("gantt");
  if (!box) return;
  gGanttFullHeight = Math.max(120, window.innerHeight - ganttTopEdge());
  box.style.height = `${gGanttFullHeight}px`;
}

/* #tab-headerの自然な高さ(畳める最大量)を測り直す。style.heightで縮めて
   いても、scrollHeightは(overflow:hiddenでも)本来の中身の高さを返すため、
   一時的に戻す必要はない */
function gMeasureHeaderMax() {
  const header = document.getElementById("tab-header");
  gHeaderMax = header ? header.scrollHeight : 0;
}

/* 現在表示中の本体の全高・表示領域の高さ・#tab-headerの高さから、
   スクロール範囲を測り直す。タスクの折りたたみ・フィルタ変更・再描画・
   リサイズなど内容の高さが変わりうるタイミングで呼ぶ。現在位置が新しい
   範囲からはみ出していればその場でクランプし直す(内容が短くなったのに
   空白のまま、を防ぐ)。
   表示領域の高さ(.g-scrollのclientHeight)は「自然な(FABクリアランスで
   縮める前の)高さ」で測る必要があるため、#gantt自体を一旦gGanttFullHeight
   に戻してから測る(gBeginScrollFallback()経由など、直前のスクロール位置に
   よっては#ganttがすでに縮んだ状態で呼ばれることがあるため)。
   最大スクロール量(gScrollMaxTop)は、全行が実際に収まりきらない量
   (gNaturalMaxTop)に、FABクリアランスの猶予(gFabGap)を足したもの。
   この猶予分を実際にスクロールした(引っ張った)ときだけ、
   gApplyScrollPosition()が#gantt自体の高さを縮めて外側に余白を見せる */
function gRecalcScrollMax() {
  gMeasureHeaderMax();
  const box = document.getElementById("gantt");
  if (box) {
    gGanttFullHeight = Math.max(120, window.innerHeight - ganttTopEdge());
    box.style.height = `${gGanttFullHeight}px`;
  }
  const trackBody = document.querySelector("#gantt .g-track-body");
  const viewport = document.querySelector("#gantt .g-scroll");
  const contentHeight = trackBody ? trackBody.offsetHeight : 0;
  const viewportHeight = viewport ? viewport.clientHeight : 0;
  gNaturalMaxTop = Math.max(0, contentHeight - viewportHeight);
  gFabGap = gFabClearance();
  gScrollMaxTop = gNaturalMaxTop + gFabGap;
  gScrollTop = gClampScrollTop(gScrollTop);
  gApplyScrollPosition(gScrollTop);
}

function gClampScrollTop(top) {
  return Math.max(-gHeaderMax, Math.min(gScrollMaxTop, top));
}

function gApplyScrollPosition(top) {
  /* #tab-headerは計画タブ専用のもの(他タブでは常に自然な高さ)なので、
     リサイズハンドラ経由などview!=="gantt"の状態でこの関数が呼ばれても
     #tab-header/#tab-header-innerには触れない */
  if (view !== "gantt") return;
  /* topが負の間(#tab-headerを畳んでいる途中)は#tab-headerの高さを縮め、
     本体はまだ動かさない。0を超えたら#tab-headerは高さ0で固定し、以降は
     本体側のスクロールに切り替える。高さを縮めるだけだと中身が上端に
     張り付いたまま下からクリップされるだけになるため、縮んだ量と同じだけ
     #tab-header-innerをtranslateYで押し上げ、タブバー自体も一緒に上へ
     スライドして画面上端の外へ消えていくように見せる */
  const header = document.getElementById("tab-header");
  const headerInner = document.getElementById("tab-header-inner");
  const collapse = Math.min(gHeaderMax, Math.max(0, top + gHeaderMax));
  if (header) header.style.height = `${gHeaderMax - collapse}px`;
  if (headerInner) headerInner.style.transform = `translateY(${-collapse}px)`;
  const bodyOffset = Math.max(0, top);
  /* 空文字には戻さず常にtranslateYを明示するのは、CSS側の
     transform: translateY(0px)ベースライン宣言と対になっている
     (noneへの切り替えを避けるため、他のtransform常時化と同じ理由) */
  const sideBody = document.querySelector("#gantt .g-side-body");
  if (sideBody) sideBody.style.transform = `translateY(${-bodyOffset}px)`;
  const trackBody = document.querySelector("#gantt .g-track-body");
  if (trackBody) trackBody.style.transform = `translateY(${-bodyOffset}px)`;
  /* 全行が自然に収まる範囲(bodyOffset <= gNaturalMaxTop)ではFAB用の余白は
     一切作らず、#gantt自体はgGanttFullHeightのまま。gNaturalMaxTopを超えて
     引っ張った分(最大gFabGapまで)だけ#gantt自体の高さをその場で縮め、
     縮んだ分がそのまま画面下端との間に表の外側の余白として現れる
     (最後の行はtranslateYで下端に張り付いたままなので、外側の余白が
     増えた分だけ最後の行がFABの上に持ち上がって見える)。これにより余白は
     実際に最後まで引っ張ったときだけ現れ、それ以外は一切作られない */
  const reveal = Math.max(0, Math.min(gFabGap, bodyOffset - gNaturalMaxTop));
  const box = document.getElementById("gantt");
  if (box) box.style.height = `${Math.max(120, gGanttFullHeight - reveal)}px`;
}

function gApplyScrollFallback() {
  gScrollRAF = null;
  if (!gScrollFallback || gScrollPendingTop === null || view !== "gantt") return;
  gScrollTop = gClampScrollTop(gScrollPendingTop);
  gApplyScrollPosition(gScrollTop);
}

/* ポインタでのドラッグ開始・マウスホイールでの疑似スクロール開始の
   共通初期化(startYは基準点。ホイールには実際の指位置がないため0を渡す) */
function gBeginScrollFallback(startY) {
  gScrollFallback = true;
  gScrollStartY = startY;
  gRecalcScrollMax();
  gScrollStartTop = gScrollTop;
  gScrollVelSamples = [];
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
  /* #gantt自体が専用のスクロール領域になったため、このフェイクスクロールの
     対象は#gantt内から始まるジェスチャーだけに限定する。.topbar/.tabsを
     畳む操作もこの中に統合されている(gApplyScrollPosition()参照)ため、
     .topbar/.tabs/.cal-sticky(#ganttの外)自体から始まる操作は対象外
     (これらの領域はtouch-action: noneにしてあり、ここから始めても何も
     起きない。「ガント表を操作する」という1つのジェスチャーに統一する) */
  if (!e.target.closest("#gantt")) return;
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
    /* 指が上に動く(clientYが減る)ほど下方向へスクロール(gScrollTopが増える) */
    gScrollPendingTop = gScrollStartTop + (gScrollStartY - e.clientY);
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

/* マウスホイール(Windows等)によるスクロールも、指でのスワイプと同じJS管理の
   縦フェイクスクロールに乗せる。#gantt内から始まるホイール操作だけを対象に
   する(pointerdownの理由と同じ)。ホイールには指のような明確な
   「開始/終了」がないため、イベントが一定時間(150ms)途切れた時点で
   スクロールが止まったとみなして確定させる */
document.addEventListener("wheel", (e) => {
  if (view !== "gantt") return;
  if (document.body.style.position === "fixed") return; // 全画面フォーム表示中
  if (e.target.closest(".overlay")) return;
  if (e.target.closest("input, textarea, select")) return;
  if (!e.target.closest("#gantt")) return;
  /* Shift+ホイールは横スクロールとして扱う。ブラウザによってはShiftキーを
     押しながらのホイールを自動的にdeltaXへ変換してくれる(その場合は下の
     deltaX/deltaY比較だけで横スクロールに譲れる)が、環境によっては変換
     されずdeltaYのまま来ることがあるため、e.shiftKeyを直接見て明示的に
     scrollLeftを動かす。マウスカーソルが左カラム(.g-side、タスク名+
     予定終了日)の上にあれば左を、それ以外(右側の日付トラック)なら右を
     スクロールする */
  if (e.shiftKey) {
    const scroller = e.target.closest(".g-side")
      ? document.querySelector("#gantt .g-side-clip")
      : document.querySelector("#gantt .g-scroll");
    if (scroller) {
      e.preventDefault();
      scroller.scrollLeft += e.deltaX || e.deltaY;
    }
    return;
  }
  if (e.target.closest(".g-scroll, .g-side")) {
    // 表本体上での横方向ホイールは横スクロールに譲る
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  }
  e.preventDefault();
  if (!gScrollFallback) gBeginScrollFallback(0);
  clearTimeout(gWheelEndTimer);
  gScrollPendingTop = (gScrollPendingTop ?? gScrollTop) + e.deltaY;
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
    gScrollPendingTop += avgVelocity * dt;
    gScrollTop = gClampScrollTop(gScrollPendingTop);
    gApplyScrollPosition(gScrollTop);
    const hitBoundary = gClampScrollTop(gScrollPendingTop) !== gScrollPendingTop;
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
  if (gScrollPendingTop !== null) {
    gScrollTop = gClampScrollTop(gScrollPendingTop);
    gApplyScrollPosition(gScrollTop);
  }
  gScrollPendingTop = null;
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
    /* fingerVelは指のclientYの変化率(下向きが正)。gScrollTopは上向きの
       ドラッグで増える向きなので符号を反転させる(pointermoveの計算式と
       同じ対応関係) */
    gStartMomentum(-fingerVel);
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

/* ---------- ガントのタスク名長押し:タスクを編集 ---------- */
/* .g-cellの長押し(上記)と全く同じパターン。.g-scellの本体(タスク名の
   ツールチップ用タップ領域=.g-name含む)を長押しすると、マス単位の割り当て
   編集ではなく、タスク原本そのものの編集フォーム(#task-form、課題タブの
   「編集」ボタンと同じもの)を開く。同じpointerdownから独立してタイマーを
   走らせるのは.g-cellの場合と同じ理由(縦フェイクスクロールの判定と
   競合させないため) */
let gNamePressTimer = null;
let gNamePressStart = null; // { x, y, taskId }
const GNAME_LONGPRESS_MS = 500;

document.addEventListener("pointerdown", (e) => {
  if (view !== "gantt") return;
  const cell = e.target.closest(".g-scell");
  if (!cell || !cell.dataset.task || e.target.closest(".caret")) return;
  gNamePressStart = { x: e.clientX, y: e.clientY, taskId: cell.dataset.task };
  clearTimeout(gNamePressTimer);
  gNamePressTimer = setTimeout(() => {
    if (!gNamePressStart) return;
    const { taskId } = gNamePressStart;
    gNamePressStart = null;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
    const t = taskById(taskId);
    if (t) openTaskForm(t, null);
  }, GNAME_LONGPRESS_MS);
});
document.addEventListener("pointermove", (e) => {
  if (!gNamePressStart) return;
  if (Math.abs(e.clientX - gNamePressStart.x) > 8 || Math.abs(e.clientY - gNamePressStart.y) > 8) {
    clearTimeout(gNamePressTimer);
    gNamePressStart = null;
  }
});
document.addEventListener("pointerup", () => { clearTimeout(gNamePressTimer); gNamePressStart = null; });
document.addEventListener("pointercancel", () => { clearTimeout(gNamePressTimer); gNamePressStart = null; });

/* ---------- 横スワイプでのタブ切り替え ---------- */
/* 今日/計画/課題タブを横スワイプで切り替える。既に横方向の操作が
   割り当てられている領域(ガントの横スクロール・マークのドラッグ、課題タブの
   長押しドラッグ/複製/アーカイブスワイプ、今日タブのカード)は対象外にし、
   既存の操作を優先する。全画面フォーム表示中(lockBodyScroll中)も対象外 */
const TAB_ORDER = ["today", "gantt", "plan"];
let tabSwipe = null; // { startX, startY, curX, horiz, el }

function tabSwipeExcluded(target) {
  return !!(
    target.closest("#gantt") ||
    target.closest(".swipe-target") ||
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
        <div class="p-row swipe-target" data-task="${t.id}" style="margin-left:${depth * 18}px;border-left-color:${issue ? issueColor(issue) : "transparent"}">
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
          const c = issueColor(g);
          const open = searching || openIssueIds.has(g.id);
          let dl = "";
          if (g.deadline || g.startDate) {
            const rest = g.deadline ? diffDays(g.deadline, tk) : null;
            const cls = rest === null ? "" : rest < 0 ? "over" : rest <= 7 ? "near" : "";
            const label = rest === null ? "" : rest < 0 ? `期限超過 ${-rest}日` : rest === 0 ? "今日が期日" : `あと${rest}日`;
            const range = `${g.startDate ? g.startDate.replaceAll("-", "/") + " 〜 " : ""}${g.deadline ? g.deadline.replaceAll("-", "/") : ""}`;
            dl = `<span class="issue-deadline ${cls}">${range}${label ? " ・ " + label : ""}</span>`;
          }
          const statusLabel = { todo: "未着手", doing: "進行中", done: "完了" }[g.status || "todo"];
          const targets = (g.targets || [])
            .map((t) => {
              const done = t.doneAt ? `<span class="rank-done">✓ ${esc(t.doneAt.replaceAll("-", "/"))}</span>` : "";
              return `<div class="issue-target"><span class="rank-chip" style="background:${c}">${esc(t.rank)}</span><span>${esc(t.text)}</span>${done}</div>`;
            })
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
                <span class="caret">${open ? "▾" : "▸"}</span>
                <div style="flex:1;min-width:0;">
                  <div class="issue-title">${issueArchived ? "📦 " : ""}${esc(g.title)} <span class="issue-status s-${g.status || "todo"}">${statusLabel}</span></div>
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
function addTargetRow(rank, text, doneAt) {
  const box = document.getElementById("target-rows");
  const row = document.createElement("div");
  row.className = "target-row";
  row.innerHTML = `
    <input type="text" class="rank" placeholder="S" maxlength="6" value="${esc(rank || "")}">
    <input type="text" class="ttext" placeholder="例: 新規レビュー投稿数 50" maxlength="120" value="${esc(text || "")}">
    <input type="date" class="tdone" title="達成日" value="${esc(doneAt || "")}">
    <button type="button" class="search-clear tdone-clear" data-action="target-clear-date" aria-label="達成日をクリア">×</button>
    <button class="sbtn muted" data-action="target-remove">×</button>`;
  box.appendChild(row);
}

/* 課題の色: 既存6色パレットのスウォッチ+自由なカラーピッカーの両方から選べる。
   選択中の色はeditingIssueColorに保持し、フォームの開閉をまたいで
   保存されない一時状態として扱う(保存時にstate.issues側へ書き込む) */
let editingIssueColor = null;

function renderColorRow() {
  const box = document.getElementById("i-color-row");
  box.innerHTML = ISSUE_COLORS.map(
    (c) =>
      `<button type="button" class="color-swatch ${editingIssueColor === c ? "on" : ""}" style="background:${c}" data-action="i-color-pick" data-color="${c}" aria-label="${c}"></button>`
  ).join("");
}

function openIssueForm(issue) {
  editingIssueId = issue ? issue.id : null;
  document.getElementById("issue-form-title").textContent = issue ? "課題を編集" : "課題を追加";
  document.getElementById("i-title").value = issue ? issue.title : "";
  document.getElementById("i-purpose").value = issue ? issue.purpose || "" : "";
  document.getElementById("i-startdate").value = issue ? issue.startDate || "" : "";
  document.getElementById("i-deadline").value = issue ? issue.deadline || "" : "";
  document.getElementById("i-status").value = issue ? issue.status || "todo" : "todo";
  editingIssueColor = issue ? issue.color || null : null;
  renderColorRow();
  const box = document.getElementById("target-rows");
  box.innerHTML = "";
  const targets = issue && issue.targets && issue.targets.length ? issue.targets : [{ rank: "S", text: "" }, { rank: "A", text: "" }, { rank: "B", text: "" }];
  targets.forEach((t) => addTargetRow(t.rank, t.text, t.doneAt));
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
      doneAt: row.querySelector(".tdone").value || null,
    }))
    .filter((t) => t.text);
  const data = {
    title,
    purpose: document.getElementById("i-purpose").value.trim(),
    startDate: document.getElementById("i-startdate").value || null,
    deadline: document.getElementById("i-deadline").value || null,
    status: document.getElementById("i-status").value,
    color: editingIssueColor,
    targets,
  };
  if (editingIssueId) {
    Object.assign(issueById(editingIssueId), data);
  } else {
    state.issues.push({ id: uid("g"), ...data });
  }
  editingIssueId = null;
  editingIssueColor = null;
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
  /* 「今日に追加する」は新規作成時、かつ単発/不定期タスクの時だけ表示する
     (周期タスクは自動予定、サマリーはそもそも実行対象ではないため対象外) */
  const showToday = !editingTaskId && (type === "single" || type === "irregular");
  const todayRow = document.getElementById("t-today-row");
  todayRow.classList.toggle("hidden", !showToday);
  const todayChk = document.getElementById("t-today");
  document.getElementById("t-today-start-row").classList.toggle("hidden", !showToday || !todayChk.checked);
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
  /* 「今日に追加する」は新規作成時のみ(既存タスクの編集では出さない)。
     #add-formのcanTodayと同じロジックで既定チェック/無効化する */
  const todayChk = document.getElementById("t-today");
  const canToday = !task && execEditable(viewDate);
  todayChk.checked = canToday;
  todayChk.disabled = !canToday;
  document.getElementById("t-today-start").value = "";
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
  let isNew = false;
  if (editingTaskId) {
    Object.assign(taskById(editingTaskId), data);
    savedId = editingTaskId;
  } else {
    isNew = true;
    savedId = uid("t");
    state.tasks.push({ id: savedId, done: false, createdDate: todayKey(), ...data });
  }
  editingTaskId = null;
  /* 「今日に追加する」がチェックされていれば、#add-formのadd-confirmと同じ
     要領で割り当ても作成する(新規作成・単発/不定期タスクのみが対象、
     updateRecVisibility()の表示条件と揃える) */
  const todayChk = document.getElementById("t-today");
  const addToday = isNew && !todayChk.disabled && todayChk.checked && (type === "single" || type === "irregular");
  if (addToday) {
    const start = document.getElementById("t-today-start").value || lastTodayEnd() || nowHM();
    state.assignments.push({
      id: uid("a"), taskId: savedId, title, date: viewDate, start,
      estimateMin: data.estimateMin, status: "todo", spentSec: 0, startedAt: null,
    });
  }
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
  /* 「今日に追加する」を使った場合、今日タブ(または計画タブ)が表示中なら
     そちらにも即座に反映させる(renderPlan()は課題タブのDOMしか更新しない
     ため)。renderAll()は現在表示中のタブに応じた再描画を行う */
  if (addToday) renderAll();
  /* 保存したタスクの位置までスクロールして一瞬ハイライト。キャンセル時と同様、
     アニメーションは表示せず即座に元の(あるいは新しい)スクロール位置に移動する
     (保存によって展開/絞り込みが変わり、キャンセル時よりも大きくスクロール
     先が動くことがあるため、smoothだと目立つスクロールアニメーションになっていた) */
  requestAnimationFrame(() => {
    const el = document.querySelector(`.p-row[data-task="${savedId}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
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
  const dot = document.getElementById("sync-dot");
  const err = !syncing && syncConfigured() && localStorage.getItem(DIRTY_KEY) === "1";
  if (el) {
    el.textContent = headerSyncLabel();
    el.classList.toggle("err", err);
  }
  if (dot) {
    dot.dataset.state = syncing
      ? "syncing"
      : err
        ? "error"
        : syncConfigured() && localStorage.getItem(LAST_SYNC_KEY)
          ? "done"
          : "idle";
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

  /* タブ */
  else if (action === "tab") switchView(btn.dataset.tab);
  else if (action === "mini-jump") {
    /* ミニタイマーが表示しているのはupdateMiniTimer()と同じ run||nextTodayAsg()。
       これが今日以外の日付(締めていない前日から持ち越したタスクなど)を
       指している場合もあるため、常にtodayKey()に固定するのではなく、
       表示中のタスクの実際の日付に合わせてそちらを表示する */
    const run = runningAsg();
    const cur = run || nextTodayAsg();
    viewDate = cur ? cur.date : todayKey();
    switchView("today");
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
  else if (action === "g-today") {
    gStart = addDays(todayKey(), -7);
    selDate = todayKey();
    renderGantt(true, true); // 今日の列を一番左に表示する
  }
  else if (action === "g-selday") {
    /* 選択中の日付をもう一度タップすると選択を解除する(絞り込みも解除) */
    selDate = selDate === btn.dataset.date ? null : btn.dataset.date;
    renderGantt(true);
  } else if (action === "g-search-clear") {
    gTaskSearch = "";
    renderGantt();
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
    /* data-action="g-showname"は.g-name自身に付いている(btn === .g-name)。
       タスク名が省略されず全部表示されている場合はツールチップを出さない */
    if (btn.scrollWidth <= btn.clientWidth + 1) return;
    /* タスク名全体ではなく、省略記号(…)が表示されている右端付近をタップした
       場合だけツールチップを出す(CSSのellipsisは実体を持つ要素ではないため、
       右端からの距離で近似する) */
    const r = btn.getBoundingClientRect();
    if (r.right - e.clientX > 40) return;
    showNameTip(btn.dataset.name, btn);
  } else if (action === "issue-add") openIssueForm(null);
  else if (action === "issue-edit") openIssueForm(issueById(id));
  else if (action === "issue-cancel") {
    editingIssueId = null;
    editingIssueColor = null;
    document.getElementById("issue-form").classList.add("hidden");
    document.getElementById("fab").classList.remove("hidden");
    unlockBodyScroll();
  } else if (action === "issue-save") saveIssueForm();
  else if (action === "issue-delete") {
    if (editingIssueId && confirm("この課題を削除しますか?(タスクは残ります)")) {
      removeIssue(editingIssueId);
      editingIssueId = null;
      editingIssueColor = null;
      document.getElementById("issue-form").classList.add("hidden");
      document.getElementById("fab").classList.remove("hidden");
      unlockBodyScroll();
    }
  } else if (action === "target-add") {
    addTargetRow("", "");
  } else if (action === "target-remove") {
    btn.closest(".target-row").remove();
  } else if (action === "target-clear-date") {
    const dateInput = btn.closest(".target-row").querySelector(".tdone");
    if (dateInput) dateInput.value = "";
  } else if (action === "i-color-pick") {
    editingIssueColor = btn.dataset.color;
    renderColorRow();
  } else if (action === "issue-duplicate") {
    const src = planMenuIssueId ? issueById(planMenuIssueId) : null;
    hidePlanMenu();
    if (src) {
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid("g");
      copy.title = `${src.title}(コピー)`;
      copy.archived = false;
      const idx = state.issues.indexOf(src);
      state.issues.splice(idx + 1, 0, copy);
      save();
      renderPlan();
    }
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

let gSearchTimer = null;
document.addEventListener("input", (e) => {
  if (e.target.id === "g-task-search") {
    clearTimeout(gSearchTimer);
    gSearchTimer = setTimeout(() => {
      gTaskSearch = e.target.value;
      const focused = document.activeElement;
      renderGantt();
      if (focused && focused.id === "g-task-search") {
        const el = document.getElementById("g-task-search");
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 200);
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "t-type" || e.target.id === "t-rkind" || e.target.id === "t-rsmode" || e.target.id === "t-today") updateRecVisibility();
  if (e.target.id === "g-showarch") {
    showArch = e.target.checked;
    localStorage.setItem("hisho:ui:showarch", showArch ? "1" : "0");
    renderGantt();
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
