/* ============================================================
   きょうの秘書 — app.js(フェーズ3a)
   データ構造:
     goals:       長期目標 [{id, title}]
     tasks:       タスクの原本 [{id, title, parentId, goalId, type,
                   estimateMin, defStart, recurrence, done, createdDate}]
     assignments: 日々への割り当て(きょう画面の実体)
                  [{id, taskId, title, date, start, estimateMin,
                    status, spentSec, startedAt}]
   ============================================================ */

const STORE_KEY = "hisho:data:v1";

const pad = (n) => String(n).padStart(2, "0");
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
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
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const GOAL_COLORS = ["#0E7C66", "#3D5A9E", "#B0692B", "#8A4E9E", "#3F7A3F", "#A8455C"];

/* ---------- 状態 ---------- */
let state = { v: 2, goals: [], tasks: [], assignments: [] };
let wakeLock = null;
let lastBeep = 0;
let renderedCurrentId = null;
let renderedOverrun = false;
let view = "today";
let editingTaskId = null;
let addChildOf = null;
let calY = new Date().getFullYear();
let calM = new Date().getMonth(); // 0始まり
let selDate = todayKey();
let editingAsgId = null;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {
    console.error("読み込みに失敗しました", e);
  }
  if (!state || typeof state !== "object") state = { v: 2, goals: [], tasks: [], assignments: [] };
  migrate();
}

/* 旧形式(フェーズ1-2: tasksが日々のタスクだった)からの移行 */
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
  if (!Array.isArray(state.goals)) state.goals = [];
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!Array.isArray(state.assignments)) state.assignments = [];
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

/* ---------- 参照ヘルパー ---------- */
const taskById = (id) => state.tasks.find((t) => t.id === id) || null;
const goalById = (id) => state.goals.find((g) => g.id === id) || null;
const goalColor = (id) => {
  const i = state.goals.findIndex((g) => g.id === id);
  return i >= 0 ? GOAL_COLORS[i % GOAL_COLORS.length] : "transparent";
};
const asgTitle = (a) => {
  const t = a.taskId ? taskById(a.taskId) : null;
  return t ? t.title : a.title;
};

const todays = () =>
  state.assignments
    .filter((a) => a.date === todayKey())
    .sort((x, y) => hmToMin(x.start) - hmToMin(y.start));

const runningAsg = () => todays().find((a) => a.status === "doing") || null;

const elapsedSec = (a) =>
  a.spentSec + (a.status === "doing" && a.startedAt ? (Date.now() - a.startedAt) / 1000 : 0);

const isOver = (a) => elapsedSec(a) > a.estimateMin * 60;

/* 秘書ロジック:いま取り組むべきもの */
function currentAsg() {
  const list = todays();
  return (
    runningAsg() ||
    list.filter((a) => a.status !== "done" && hmToMin(a.start) <= nowMin()).pop() ||
    list.find((a) => a.status !== "done") ||
    null
  );
}

/* ---------- 周期タスクの判定と自動展開 ---------- */
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

/* 今日が該当日の周期タスクを、きょうのタイムラインへ自動追加 */
function materializeToday() {
  const dk = todayKey();
  let changed = false;
  state.tasks
    .filter((t) => t.type === "recurring" && occursOn(t, dk))
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

/* ---------- きょう:操作 ---------- */
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
    if (t && t.type === "single") t.done = true; // 単発タスクは完了扱いに
  }
  releaseWake();
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

function assignTaskToToday(taskId) {
  const t = taskById(taskId);
  if (!t) return;
  state.assignments.push({
    id: uid("a"),
    taskId: t.id,
    title: t.title,
    date: todayKey(),
    start: t.defStart || nowHM(),
    estimateMin: t.estimateMin || 25,
    status: "todo",
    spentSec: 0,
    startedAt: null,
  });
  save();
  switchView("today");
}

/* ---------- 計画:目標 ---------- */
function saveGoal(title) {
  state.goals.push({ id: uid("g"), title: title.trim() });
  save();
  renderPlan();
}
function removeGoal(id) {
  state.goals = state.goals.filter((g) => g.id !== id);
  state.tasks.forEach((t) => { if (t.goalId === id) t.goalId = null; });
  save();
  renderPlan();
}

/* ---------- 計画:タスク ---------- */
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
  // 子タスクは1段上へ引き継ぐ
  state.tasks.forEach((c) => { if (c.parentId === id) c.parentId = t.parentId || null; });
  state.tasks = state.tasks.filter((x) => x.id !== id);
  // 未完了の割り当ては残すが、原本の名前を写しておく
  state.assignments.forEach((a) => { if (a.taskId === id) { a.title = t.title; a.taskId = null; } });
  save();
  renderPlan();
}

/* ---------- 画面切替 ---------- */
function switchView(v) {
  view = v;
  document.body.dataset.view = v;
  document.querySelectorAll(".tab").forEach((el) =>
    el.classList.toggle("active", el.dataset.tab === v)
  );
  document.getElementById("view-today").classList.toggle("hidden", v !== "today");
  document.getElementById("view-cal").classList.toggle("hidden", v !== "cal");
  document.getElementById("view-plan").classList.toggle("hidden", v !== "plan");
  renderAll();
}

/* ---------- 描画:きょう ---------- */
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

function renderHero() {
  const hero = document.getElementById("hero");
  const cur = currentAsg();
  if (!cur) {
    const has = todays().length > 0;
    hero.innerHTML = `<div class="empty-card">${
      has
        ? "今日のタスクはすべて完了しました 🎉<br><small>おつかれさまでした</small>"
        : "今日のタスクはまだありません。<br><small>「+ タスクを追加」か、計画タブの「今日へ」から登録できます</small>"
    }</div>`;
    document.body.classList.remove("overrun");
    return;
  }
  const run = runningAsg();
  const mine = run && run.id === cur.id;
  const over = mine && isOver(cur);
  document.body.classList.toggle("overrun", !!over);

  const t = cur.taskId ? taskById(cur.taskId) : null;
  const goal = t && t.goalId ? goalById(t.goalId) : null;
  const goalChip = goal
    ? `<span class="goal-chip" style="background:${goalColor(goal.id)}22;color:${goalColor(goal.id)}">${esc(goal.title)}</span>`
    : "";

  const eyebrow = over ? "⚠ 見積時間を超過しています" : mine ? "作業中" : "次にやること";
  const buttons = mine
    ? `<button class="btn solid" data-action="finish" data-id="${cur.id}">完了にする</button>
       <button class="btn" data-action="pause" data-id="${cur.id}">中断</button>`
    : `<button class="btn solid" data-action="start" data-id="${cur.id}">作業を開始</button>`;

  hero.innerHTML = `
    <div class="hero ${over ? "overrun" : ""}">
      <div class="hero-eyebrow">${eyebrow}</div>
      <div class="hero-title">${goalChip}${esc(asgTitle(cur))}</div>
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
        ? `<button class="sbtn muted" data-action="remove" data-id="${a.id}">削除</button>`
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

/* ---------- 描画:計画 ---------- */
function renderPlan() {
  // 目標
  const gl = document.getElementById("goal-list");
  gl.innerHTML = state.goals.length
    ? state.goals
        .map((g) => {
          const cnt = state.tasks.filter((t) => t.goalId === g.id).length;
          return `
          <div class="g-row">
            <div class="p-main">
              <div class="p-title"><span class="goal-chip" style="background:${goalColor(g.id)}22;color:${goalColor(g.id)}">●</span>${esc(g.title)}</div>
              <div class="p-sub">関連タスク ${cnt}件</div>
            </div>
            <div class="p-actions">
              <button class="sbtn muted" data-action="goal-remove" data-id="${g.id}">削除</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="plan-empty">長期目標を登録すると、タスクと紐づけて管理できます。</div>`;

  // タスクツリー
  const tree = document.getElementById("task-tree");
  const roots = state.tasks.filter((t) => !t.parentId);
  if (!state.tasks.length) {
    tree.innerHTML = `<div class="plan-empty">ここに登録したタスクの原本を、日々のカレンダーへ割り当てていきます。<br>周期タスク(毎週◯曜など)は該当日に自動で「きょう」へ現れます。</div>`;
    return;
  }
  const renderNode = (t, depth) => {
    const goal = t.goalId ? goalById(t.goalId) : null;
    const chip = goal
      ? `<span class="goal-chip" style="background:${goalColor(goal.id)}22;color:${goalColor(goal.id)}">${esc(goal.title)}</span>`
      : "";
    const children = state.tasks.filter((c) => c.parentId === t.id);
    const row = `
      <div class="p-row" style="margin-left:${depth * 18}px;border-left-color:${goal ? goalColor(goal.id) : "transparent"}">
        <div class="p-main">
          <div class="p-title ${t.done ? "done-task" : ""}">${chip}${esc(t.title)}</div>
          <div class="p-sub">${recurrenceLabel(t)} ・ 見積 ${t.estimateMin}分${children.length ? ` ・ 子タスク ${children.length}件` : ""}</div>
        </div>
        <div class="p-actions">
          <button class="sbtn" data-action="assign-today" data-id="${t.id}">今日へ</button>
          <button class="sbtn muted" data-action="task-child" data-id="${t.id}">+子</button>
          <button class="sbtn muted" data-action="task-edit" data-id="${t.id}">編集</button>
        </div>
      </div>`;
    return row + children.map((c) => renderNode(c, depth + 1)).join("");
  };
  tree.innerHTML = roots.map((t) => renderNode(t, 0)).join("");
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
  } else if (view === "cal") {
    renderCal();
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
    state.goals.map((g) => `<option value="${g.id}">${esc(g.title)}</option>`).join("");
}

function updateRecVisibility() {
  const type = document.getElementById("t-type").value;
  document.getElementById("rec-block").classList.toggle("hidden", type !== "recurring");
  const kind = document.getElementById("t-rkind").value;
  document.getElementById("rec-ndays").classList.toggle("hidden", kind !== "everyNDays");
  document.getElementById("rec-weekly").classList.toggle("hidden", kind !== "weekly");
  document.getElementById("rec-monthly").classList.toggle("hidden", kind !== "monthly");
  document.getElementById("rec-yearly").classList.toggle("hidden", kind !== "yearly");
}

function openTaskForm(task, parentId) {
  editingTaskId = task ? task.id : null;
  addChildOf = parentId || null;
  fillParentGoalSelects(editingTaskId);
  document.getElementById("task-form-title").textContent = task ? "タスクを編集" : "タスクを追加";
  document.getElementById("t-title").value = task ? task.title : "";
  document.getElementById("t-parent").value = task ? task.parentId || "" : parentId || "";
  document.getElementById("t-goal").value = task ? task.goalId || "" : "";
  document.getElementById("t-type").value = task ? task.type : "single";
  document.getElementById("t-est").value = task ? task.estimateMin : 25;
  document.getElementById("t-defstart").value = task ? task.defStart || "09:00" : "09:00";
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
  const data = {
    title,
    parentId: document.getElementById("t-parent").value || null,
    goalId: document.getElementById("t-goal").value || null,
    type,
    estimateMin: Math.max(1, Number(document.getElementById("t-est").value) || 25),
    defStart: document.getElementById("t-defstart").value || "09:00",
    recurrence: type === "recurring" ? readRecurrence() : null,
  };
  if (editingTaskId) {
    const t = taskById(editingTaskId);
    Object.assign(t, data);
  } else {
    state.tasks.push({ id: uid("t"), done: false, createdDate: todayKey(), ...data });
  }
  editingTaskId = null;
  document.getElementById("task-form").classList.add("hidden");
  materializeToday();
  save();
  renderPlan();
}

/* ---------- カレンダー(フェーズ3b) ---------- */
const dkOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const fmtH = (min) => (min >= 60 ? `${Math.round(min / 6) / 10}h` : `${min}分`);

/* その日の項目:実際の割り当て + 周期タスクの自動予定(今日以降のみ) */
function dayItems(dk) {
  const real = state.assignments.filter((a) => a.date === dk);
  const virt =
    dk >= todayKey()
      ? state.tasks
          .filter(
            (t) =>
              t.type === "recurring" &&
              occursOn(t, dk) &&
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
const dayTotal = (dk) => dayItems(dk).reduce((s, i) => s + (i.estimateMin || 0), 0);

function heatClass(min) {
  if (min <= 0) return "";
  if (min <= 120) return "heat1";
  if (min <= 240) return "heat2";
  if (min <= 360) return "heat3";
  return "heat4";
}

function renderCal() {
  document.getElementById("cal-month-label").textContent = `${calY}年${calM + 1}月`;
  const first = new Date(calY, calM, 1);
  const daysInMonth = new Date(calY, calM + 1, 0).getDate();
  const lead = first.getDay();
  const tk = todayKey();
  let cells = [];
  for (let i = 0; i < lead; i++) cells.push(`<div class="cal-cell blank"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dk = dkOf(calY, calM, d);
    const items = dayItems(dk);
    const total = items.reduce((s, i) => s + (i.estimateMin || 0), 0);
    const cls = [
      "cal-cell",
      heatClass(total),
      dk === tk ? "today-cell" : "",
      dk === selDate ? "sel" : "",
      dk < tk ? "past" : "",
    ].join(" ");
    cells.push(`
      <button class="${cls}" data-action="cal-day" data-date="${dk}">
        <span class="cal-d">${d}</span>
        ${total ? `<span class="cal-sum">${fmtH(total)}</span>` : ""}
        ${items.length ? `<span class="cal-cnt">${items.length}件</span>` : ""}
      </button>`);
  }
  document.getElementById("cal-grid").innerHTML = cells.join("");
  renderDayDetail();
}

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
          const goal = t && t.goalId ? goalById(t.goalId) : null;
          const chip = goal
            ? `<span class="goal-chip" style="background:${goalColor(goal.id)}22;color:${goalColor(goal.id)}">${esc(goal.title)}</span>`
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
    : `<div class="plan-empty">この日の割り当てはまだありません。</div>`;

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
  const dd = new Date(date + "T00:00:00");
  calY = dd.getFullYear();
  calM = dd.getMonth();
  save();
  renderCal();
}

/* 周期タスクの自動予定を実体化して時刻を調整できるようにする */
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
  renderCal();
  openAsgForm(dk, a);
}


/* ---------- スプレッドシート同期 ---------- */
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

function syncPayload() {
  return {
    token: localStorage.getItem(SYNC_TOKEN_KEY) || "",
    goals: state.goals.map((g) => ({ id: g.id, title: g.title })),
    tasks: state.tasks.map((t) => {
      const p = t.parentId ? taskById(t.parentId) : null;
      const g = t.goalId ? goalById(t.goalId) : null;
      return {
        id: t.id,
        title: t.title,
        parent: p ? p.title : "",
        goal: g ? g.title : "",
        kind: recurrenceLabel(t),
        estimateMin: t.estimateMin,
        defStart: t.defStart || "",
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
      body: JSON.stringify(syncPayload()),
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

  /* きょう */
  if (action === "start") startAsg(id);
  else if (action === "pause") pauseAsg(id);
  else if (action === "finish") finishAsg(id);
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

  /* カレンダー */
  else if (action === "cal-prev") {
    calM--;
    if (calM < 0) { calM = 11; calY--; }
    renderCal();
  } else if (action === "cal-next") {
    calM++;
    if (calM > 11) { calM = 0; calY++; }
    renderCal();
  } else if (action === "cal-day") {
    selDate = btn.dataset.date;
    document.getElementById("asg-form").classList.add("hidden");
    editingAsgId = null;
    renderCal();
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
      state.assignments = state.assignments.filter((x) => x.id !== editingAsgId);
      editingAsgId = null;
      document.getElementById("asg-form").classList.add("hidden");
      save();
      renderCal();
    }
  } else if (action === "asg-fix") {
    fixVirtual(btn.dataset.task, btn.dataset.date);
  }

  /* 目標 */
  else if (action === "goal-add") {
    document.getElementById("goal-form").classList.remove("hidden");
    document.getElementById("g-title").focus();
  } else if (action === "goal-cancel") {
    document.getElementById("goal-form").classList.add("hidden");
  } else if (action === "goal-save") {
    const v = document.getElementById("g-title").value;
    if (!v.trim()) return;
    saveGoal(v);
    document.getElementById("g-title").value = "";
    document.getElementById("goal-form").classList.add("hidden");
  } else if (action === "goal-remove") {
    if (confirm("この目標を削除しますか?(タスクは残ります)")) removeGoal(id);
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
  } else if (action === "assign-today") assignTaskToToday(id);

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
  } else if (action === "sync-now") doSync(true);
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
  }
});

/* ---------- 起動 ---------- */
load();
materializeToday();
document.body.dataset.view = "today";
renderAll();
setSyncMsg(syncStatusLabel());
if (syncConfigured() && localStorage.getItem(DIRTY_KEY) === "1") doSync(false);
setInterval(tick, 1000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
