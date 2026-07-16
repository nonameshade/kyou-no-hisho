/* ============================================================
   今日の秘書 — スプレッドシート受け口 v6(作業ログ内訳対応)
   ・アプリからの送信(doPost):全state(JSON)を _sync タブに保存し、
     Issues / Tasks / Assignments / WorkLog タブを見やすく書き出す
   ・アプリへの読み込み(doGet mode=pull):保存した全stateを返す
   ★SECRET を利用者の合言葉に設定すること。
   ★変更後は「デプロイを管理」→「新バージョン」で更新(新しいデプロイはURLが変わるので不可)
   ============================================================ */

const SECRET = "ここを合言葉に変える";
const CHUNK = 40000; // セル1つの文字数上限対策

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!SECRET || body.token !== SECRET) {
      return out({ ok: false, error: "合言葉が一致しません" });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const now = new Date();

    /* 全データ(JSON)を隠しタブに保存 → 他の端末がここから読み込む */
    saveState(ss, body.state, body.updatedAt || 0);

    /* 見やすい形のタブを書き出し */
    const r = body.readable || {};

    writeSheet(ss, "Issues",
      ["id", "課題", "目的", "期日", "目標", "受信日時"],
      (r.issues || []).map(function (g) {
        return [g.id, g.title, g.purpose, g.deadline, g.targets, now];
      })
    );

    writeSheet(ss, "Tasks",
      ["id", "タスク名", "親タスク", "課題", "種類", "見積(分)", "既定開始", "開始予定日", "終了予定日", "進捗%", "状態", "受信日時"],
      (r.tasks || []).map(function (t) {
        return [t.id, t.title, t.parent, t.issue, t.kind, t.estimateMin, t.defStart,
                t.pstart || "", t.pend || "",
                t.progress === "" || t.progress === undefined ? "" : t.progress,
                t.done, now];
      })
    );

    const jp = { todo: "未着手", doing: "作業中", done: "完了" };
    writeSheet(ss, "Assignments",
      ["id", "日付", "タスク名", "開始予定", "見積(分)", "状態", "実績(分)", "受信日時"],
      (r.assignments || []).map(function (a) {
        return [
          a.id, a.date, a.title, a.start,
          Number(a.estimateMin) || 0,
          jp[a.status] || a.status || "",
          Math.round((Number(a.spentSec) || 0) / 6) / 10,
          now,
        ];
      })
    );

    upsertWorkLog(ss, r.worklog || [], now);

    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

/* 作業ログを日付+タスク単位で蓄積(既存行はIDキーで更新、消えた割り当ての行も保持) */
function upsertWorkLog(ss, rows, now) {
  const header = ["日付", "開始予定", "タスク名", "予定(分)", "実績(分)", "状態", "締め", "更新日時", "ID(内部用)"];
  const ID_COL = 8;
  let sh = ss.getSheetByName("WorkLog");
  if (!sh) sh = ss.insertSheet("WorkLog");
  const map = {};
  const last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, header.length).getValues().forEach(function (r) {
      const key = String(r[ID_COL] || "");
      if (key) map[key] = r;
    });
  }
  const jp = { todo: "未着手", doing: "作業中", done: "完了" };
  rows.forEach(function (w) {
    map[w.id] = [w.date, w.start, w.title, w.plan, w.actual, jp[w.status] || w.status || "", w.closed, now, w.id];
  });
  const sorted = Object.keys(map).map(function (k) {
    const r = map[k];
    r[0] = normDate(r[0]);
    return r;
  }).sort(function (a, b) {
    const ka = String(a[0]) + " " + String(a[1]);
    const kb = String(b[0]) + " " + String(b[1]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (sorted.length) {
    sh.getRange(2, 1, sorted.length, header.length).setValues(sorted);
  }
}

function normDate(v) {
  if (!v) return "";
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v);
}

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.mode === "pull") {
      if (!SECRET || p.token !== SECRET) {
        return out({ ok: false, error: "合言葉が一致しません" });
      }
      const loaded = loadState(SpreadsheetApp.getActiveSpreadsheet());
      return out({ ok: true, updatedAt: loaded.updatedAt, state: loaded.state });
    }
    return out({ ok: true, message: "今日の秘書の同期受け口は動作しています(v6)" });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function saveState(ss, state, updatedAt) {
  let sh = ss.getSheetByName("_sync");
  if (!sh) {
    sh = ss.insertSheet("_sync");
    sh.hideSheet();
  }
  sh.clearContents();
  sh.getRange(1, 1).setValue(updatedAt);
  const json = JSON.stringify(state || {});
  const rows = [];
  for (let i = 0; i < json.length; i += CHUNK) {
    rows.push([json.substring(i, i + CHUNK)]);
  }
  if (rows.length) sh.getRange(2, 1, rows.length, 1).setValues(rows);
}

function loadState(ss) {
  const sh = ss.getSheetByName("_sync");
  if (!sh) return { updatedAt: 0, state: null };
  const updatedAt = Number(sh.getRange(1, 1).getValue()) || 0;
  const last = sh.getLastRow();
  if (last < 2) return { updatedAt: 0, state: null };
  const vals = sh.getRange(2, 1, last - 1, 1).getValues();
  const json = vals.map(function (r) { return r[0]; }).join("");
  try {
    return { updatedAt: updatedAt, state: JSON.parse(json) };
  } catch (err) {
    return { updatedAt: 0, state: null };
  }
}

function writeSheet(ss, name, header, rows) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
