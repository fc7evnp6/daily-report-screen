// 日報の入力画面で使う計算（日付、時刻、勤務時間、数字の読み取り、スタッフの確かめ）。
//
// ■ このフォルダ（screen/）の中身は、GitHub Pages の公開リポジトリに写すので、誰でも見られる。
//   秘密の情報、本物のデータ、実在の人の名前は書かない。
//
// 画面の確かめは、打ち間違いをその場で知らせるためだけのもの。
// 受け付けるかどうかは、最後に GAS がもう一度確かめて決める（ここの確かめは信じない）。
// ブラウザでも Node.js（テスト）でも読めるよう、GAS のサービスや画面の部品は使わない。

// 0〜5時台に開いたら、日付の最初の値を前の日にする（閉店後、日付が変わってから入力するため）
var EARLY_MORNING_END_HOUR = 6;
// 選べる日付は、今日と前の7日（GAS の「8日以上離れていたら受け付けない」と同じ）
var SELECTABLE_PAST_DAYS = 7;

// 時刻の選択肢（0時からの分）。30分刻み（管理表が0.5時間単位のため）。
// 終了は日をまたいで翌5:00（29:00）まで選べる。範囲はオーナーに確かめてから決める
var TIME_STEP_MINUTES = 30;
var FIRST_START_MINUTES = 8 * 60;
var LAST_START_MINUTES = 23 * 60 + 30;
var FIRST_END_MINUTES = 8 * 60 + 30;
var LAST_END_MINUTES = 29 * 60;
// 勤務時間を22時の前後に分ける（給与シートの深夜給の欄に合わせる）
var LATE_NIGHT_START = 22 * 60;

var MAX_AMOUNT = 100000000; // 1億円以上は桁の間違いとみなす
var MAX_COUNT = 1000;
var NAME_MAX_LENGTH = 30; // GAS の名簿の申請と同じ
var COMMENT_MAX_LENGTH = 1000;

var WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// ============================================================
// 日付
// ============================================================

/** 日付の最初の値（'2026-10-06' の形）。0〜5時台なら前の日。 */
function defaultReportDate(now) {
  var back = now.getHours() < EARLY_MORNING_END_HOUR ? 1 : 0;
  return dateText(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
}

/** 選べる日付（今日と前の7日。新しい順）。 */
function selectableReportDates(now) {
  var dates = [];
  for (var i = 0; i <= SELECTABLE_PAST_DAYS; i++) {
    dates.push(dateText(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return dates;
}

/** '2026-10-06' を '10/6(火)' にする。 */
function dateLabel(date) {
  var p = date.split('-').map(Number);
  var weekday = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  return p[1] + '/' + p[2] + '(' + WEEKDAY_NAMES[weekday] + ')';
}

function dateText(day) {
  return day.getFullYear() + '-' + pad2(day.getMonth() + 1) + '-' + pad2(day.getDate());
}

// ============================================================
// 時刻と勤務時間
// ============================================================

/** 開始の時刻の選択肢（'08:00' の形）。 */
function startTimeOptions() {
  return timeOptions(FIRST_START_MINUTES, LAST_START_MINUTES);
}

/** 終了の時刻の選択肢。日をまたいだ時刻は '25:00' の形（記録と同じ）。 */
function endTimeOptions() {
  return timeOptions(FIRST_END_MINUTES, LAST_END_MINUTES);
}

function timeOptions(first, last) {
  var options = [];
  for (var minutes = first; minutes <= last; minutes += TIME_STEP_MINUTES) {
    options.push(pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60));
  }
  return options;
}

/** 画面に出す時刻。'25:30' は '翌1:30'、'09:00' は '9:00' にする。 */
function timeLabel(time) {
  var minutes = toMinutes(time);
  var nextDay = minutes >= 24 * 60;
  if (nextDay) minutes -= 24 * 60;
  return (nextDay ? '翌' : '') + Math.floor(minutes / 60) + ':' + pad2(minutes % 60);
}

/**
 * 勤務時間（時間）を、22時までと22時以降に分けて返す。
 * 時刻が選ばれていない、または終了が開始より前か同じなら null。
 */
function workHours(start, end) {
  if (!start || !end) return null;
  var s = toMinutes(start);
  var e = toMinutes(end);
  if (e <= s) return null;
  var until22 = (Math.min(e, LATE_NIGHT_START) - Math.min(s, LATE_NIGHT_START)) / 60;
  var after22 = (Math.max(e, LATE_NIGHT_START) - Math.max(s, LATE_NIGHT_START)) / 60;
  return { total: until22 + after22, until22: until22, after22: after22 };
}

/** 「7時間（うち22時以降 3時間）」の形。22時以降がなければ「8時間」だけ。 */
function describeWorkHours(hours) {
  var text = hours.total + '時間';
  if (hours.after22 > 0) text += '（うち22時以降 ' + hours.after22 + '時間）';
  return text;
}

function toMinutes(time) {
  var parts = time.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

// ============================================================
// 数字の読み取り
// ============================================================

/**
 * 金額の欄を読む。全角の数字・カンマ・「円」・前後の空白は許す。
 * 空欄なら { value: null, error: null }。読めなければ推測せずに error を返す。
 */
function readAmountInput(text) {
  var result = readNumberText(text, '円', '数字だけで入力してください（例：48500）。');
  if (result.value !== null && result.value >= MAX_AMOUNT) {
    return { value: null, error: '1億円以上の金額は入力できません。桁を確かめてください。' };
  }
  return result;
}

/** 件数の欄を読む（「件」は付いていてもよい）。 */
function readCountInput(text) {
  var result = readNumberText(text, '件', '数字だけで入力してください（例：3）。');
  if (result.value !== null && result.value >= MAX_COUNT) {
    return { value: null, error: '件数の桁を確かめてください（1000件以上は入力できません）。' };
  }
  return result;
}

function readNumberText(text, unit, message) {
  var normalized = String(text === null || text === undefined ? '' : text)
    .replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    })
    .replace(/，/g, ',')
    .trim();
  if (normalized.slice(-1) === unit) normalized = normalized.slice(0, -1).trim();
  if (normalized === '') return { value: null, error: null };
  // 「48500」か、3桁ごとにカンマで区切った「48,500」だけを受け付ける
  if (!/^(\d+|\d{1,3}(,\d{3})+)$/.test(normalized)) return { value: null, error: message };
  return { value: Number(normalized.replace(/,/g, '')), error: null };
}

/** 48500 を '48,500円' にする。 */
function formatYen(n) {
  return withCommas(n) + '円';
}

function withCommas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ============================================================
// スタッフ、経費、感じたこと
// ============================================================

/**
 * スタッフの欄で、次へ進めない問題を返す（なければ空の配列）。
 * @param {{name: string, start: string, end: string}[]} staff
 */
function staffProblems(staff) {
  if (staff.length === 0) return ['スタッフを1人以上入れてください。'];
  var problems = [];
  var seen = {};
  staff.forEach(function (person, index) {
    var name = (person.name || '').trim();
    var label = index + 1 + '人目';
    if (!name) {
      problems.push(label + 'の氏名を選んでください。');
      return;
    }
    var nameError = nameProblem(name);
    if (nameError) {
      problems.push(label + 'の' + nameError);
      return;
    }
    if (!person.start || !person.end) {
      problems.push(name + 'さんの開始と終了の時刻を選んでください。');
    } else if (!workHours(person.start, person.end)) {
      problems.push(name + 'さんの終了の時刻が、開始の時刻より前か同じです。');
    }
    // 空白の違い（全角・半角、あるかないか）は同じ人とみなす（管理表の氏名の探し方と同じ）
    var key = name.replace(/\s/g, '');
    if (seen[key]) problems.push(name + 'さんが2回入っています。1人にまとめてください。');
    seen[key] = true;
  });
  return problems;
}

/**
 * 手で入力した氏名の問題（なければ null）。
 * 数字があると、日報の文章にしたときに時刻と見分けられない。【】は日報の見出しと混ざる。
 */
function nameProblem(name) {
  if (/[0-9０-９]/.test(name)) return '氏名に数字は使えません。';
  if (/[【】]/.test(name)) return '氏名に【】は使えません。';
  if (name.length > NAME_MAX_LENGTH) return '氏名は' + NAME_MAX_LENGTH + '文字までにしてください。';
  return null;
}

/** 経費の内訳の合計。アイスミックスとカードを含む合計と、含まない合計の両方（空欄は0）。 */
function expenseTotals(expenses) {
  var v = function (key) {
    return expenses[key] || 0;
  };
  var excluding = v('food') + v('materials') + v('supplies') + v('misc') + v('utilities');
  return { including: excluding + v('iceMix') + v('card'), excluding: excluding };
}

/** 感じたことの問題（なければ null）。 */
function commentProblem(text) {
  if (text.length > COMMENT_MAX_LENGTH) {
    return '感じたことは' + COMMENT_MAX_LENGTH + '文字までにしてください（今は' + text.length + '文字）。';
  }
  if (/[【】]/.test(text)) return '感じたことに【】は使えません。「」などに変えてください。';
  return null;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

if (typeof module !== 'undefined') {
  module.exports = {
    defaultReportDate: defaultReportDate,
    selectableReportDates: selectableReportDates,
    dateLabel: dateLabel,
    startTimeOptions: startTimeOptions,
    endTimeOptions: endTimeOptions,
    timeLabel: timeLabel,
    workHours: workHours,
    describeWorkHours: describeWorkHours,
    readAmountInput: readAmountInput,
    readCountInput: readCountInput,
    formatYen: formatYen,
    staffProblems: staffProblems,
    nameProblem: nameProblem,
    expenseTotals: expenseTotals,
    commentProblem: commentProblem,
  };
}
