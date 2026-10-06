// 画面の見本で使う、偽物の server。どこにも送らず、架空のデータで GAS の返事のまねをする。
//
// ■ このファイルは公開される。名前（見本 花子 など）、ブランド（見本アイス）、店舗（見本店）、数字はすべて架空。
//   本物のブランド名、店舗名、日報の文章は、画面のコードに書かない（本物の画面では GAS から受け取る）。
// 本物の画面では、GAS に問い合わせる server に差し替える（注意の文章は、GAS が今の関数で作る）。

var SAMPLE_BRAND = '見本アイス'; // 日報の文章の見本の「#見本アイス見本店」の部分（架空の名前）
var SAMPLE_STORE = '見本店';
var SAMPLE_NAME = '見本 花子';
var SAMPLE_CANDIDATES = ['見本 花子', '架空 太郎', '試験 次郎'];
var SAMPLE_DELAY_MS = 700; // GAS の返事を待つ時間のまね
var SAMPLE_MISSING_DAY = 2; // 毎月2日を「報告がない日」にする
var SAMPLE_LONG_WORK_HOURS = 12;

/**
 * 見本の server を作る。前の日は本人が登録済み（2回目の報告）、2日前は別のスタッフが登録済みにしておく。
 * @param {Date} now
 */
function createMockServer(now) {
  var base = defaultReportDate(now);
  var registered = {}; // 日付 → { by: 'mine' | 'other', version, answers }
  var results = {}; // 送信ID → 登録の結果（2回押しのまね）

  var otherDate = addDays(base, -2);
  registered[otherDate] = { by: 'other', version: 1, answers: null };
  var mineDate = addDays(base, -1);
  registered[mineDate] = { by: 'mine', version: 2, answers: sampleAnswers(mineDate) };

  function sampleAnswers(date) {
    var answers = {
      store: SAMPLE_STORE,
      date: date,
      salesCash: fakeSales(date),
      monthToDate: null,
      weather: '曇り',
      deliveryCount: 2,
      staff: [
        { name: '見本 花子', start: '11:00', end: '19:00' },
        { name: '架空 太郎', start: '17:30', end: '22:00' },
      ],
      expenses: { food: 1200, iceMix: null, materials: 800, supplies: null, misc: 350, utilities: null, card: null },
      expenseTotal: 2350,
      envelopeBalance: 12000,
      reviewCount: 3,
      comment: '夕方にお客さんが集中して、レジ待ちの列ができました。',
    };
    answers.monthToDate = monthCheck(answers).calculated;
    return answers;
  }

  /** 架空の売上（日によって少し変える）。 */
  function fakeSales(date) {
    var day = Number(date.slice(8));
    return 38000 + ((day * 3700) % 15000);
  }

  function salesOf(date) {
    var saved = registered[date];
    return saved && saved.answers ? saved.answers.salesCash : fakeSales(date);
  }

  /** 記録から計算した月累計と、報告がない日（GAS の calculateMonthToDate_ のまね）。 */
  function monthCheck(answers) {
    var prefix = answers.date.slice(0, 8);
    var calculated = answers.salesCash || 0;
    var missingDays = [];
    for (var day = 1; day < Number(answers.date.slice(8)); day++) {
      var date = prefix + (day < 10 ? '0' : '') + day;
      if (day === SAMPLE_MISSING_DAY && !registered[date]) missingDays.push(date);
      else calculated += salesOf(date);
    }
    return { calculated: calculated, missingDays: missingDays };
  }

  function warningsOf(answers) {
    var warnings = [];
    var saved = registered[answers.date];
    if (saved && saved.by === 'mine') {
      warnings.push({ message: 'この日は登録済みです（' + saved.version + '回目の報告）。登録すると、前の内容と置き換わります。' });
    } else if (saved) {
      warnings.push({ message: 'この日の日報は、別のスタッフが登録しています。登録すると、前の内容と置き換わります。' });
    }

    var totals = expenseTotals(answers.expenses);
    if (answers.expenseTotal !== totals.including && answers.expenseTotal !== totals.excluding) {
      warnings.push({
        step: 'expenseTotal',
        message:
          '合計経費' + formatYen(answers.expenseTotal) + 'が、内訳の合計と合いません（アイスミックスとカードを含む合計：' +
          formatYen(totals.including) + '、含まない合計：' + formatYen(totals.excluding) + '）。',
      });
    }

    var month = monthCheck(answers);
    if (answers.monthToDate !== month.calculated) {
      var message =
        '月累計が記録と合いません（報告：' + formatYen(answers.monthToDate) + '、記録から計算：' +
        formatYen(month.calculated) + '）。';
      if (month.missingDays.length > 0) {
        message +=
          'この月で報告がない日：' + month.missingDays.map(function (date) {
            return dateLabel(date).replace(/\(.\)$/, '');
          }).join('、') + '。報告漏れがないか確認してください。';
      }
      warnings.push({ step: 'monthToDate', message: message });
    }

    answers.staff.forEach(function (person) {
      var hours = workHours(person.start, person.end);
      if (hours && hours.total > SAMPLE_LONG_WORK_HOURS) {
        warnings.push({
          step: 'staff',
          message:
            person.name + 'さんの勤務が' + hours.total + '時間になっています（' + timeLabel(person.start) + '〜' +
            timeLabel(person.end) + '）。開始と終了の時刻を確認してください。',
        });
      }
      if (SAMPLE_CANDIDATES.indexOf(person.name) === -1) {
        warnings.push({
          step: 'staff',
          message:
            '「' + person.name + '」さんは名簿にない名前です。管理表の氏名と書き方が違うと、' +
            '勤務時間が管理表に書かれません。',
        });
      }
    });
    return warnings;
  }

  function nextVersion(date) {
    return registered[date] ? registered[date].version + 1 : 1;
  }

  return {
    loadProfile: function () {
      var candidates = {};
      candidates[SAMPLE_STORE] = SAMPLE_CANDIDATES;
      return later({ name: SAMPLE_NAME, stores: [SAMPLE_STORE], candidates: candidates });
    },
    loadDay: function (store, date) {
      var saved = registered[date];
      if (!saved) return later({ registered: 'none', version: 0, answers: null });
      // 前の内容を返すのは、本人が登録した日だけ（別の人の日は、登録があることだけを返す）
      if (saved.by === 'other') return later({ registered: 'other', version: saved.version, answers: null });
      return later({ registered: 'mine', version: saved.version, answers: saved.answers });
    },
    check: function (answers) {
      return later({ errors: [], warnings: warningsOf(answers), version: nextVersion(answers.date) });
    },
    register: function (answers, submissionId) {
      if (!results[submissionId]) {
        var version = nextVersion(answers.date);
        registered[answers.date] = { by: 'mine', version: version, answers: answers };
        results[submissionId] = { version: version, text: reportText(answers) };
      }
      return later(results[submissionId]);
    },
    share: function () {
      return later({
        message:
          '（見本）実際には、ここで LINE の「送り先を選ぶ画面」が開きます。管理者か店舗のグループを選ぶと、' +
          'あなたからのメッセージとして、下の「送られる文章」が届きます。',
      });
    },
    close: function () {
      return later({
        message: '（見本）実際には、ここで画面が閉じて LINE のトークに戻ります。もう一度試すときは、ページを読み込み直してください。',
      });
    },
  };
}

/**
 * 管理者に送る、いつもの日報の文章（見本）。
 * 本物は GAS が組み立て、今の読み取り（parser.js）でそのまま読めることをテストで確かめる。
 */
function reportText(a) {
  var number = function (n) {
    return formatYen(n || 0).slice(0, -1);
  };
  var lines = [
    'お疲れ様です。',
    dateLabel(a.date).replace(')', '曜日)') + '#' + SAMPLE_BRAND + a.store + '売上報告です。',
    '売上現金:' + number(a.salesCash) + '円',
    '月累計:' + number(a.monthToDate),
    '',
    '【天候】 ' + a.weather,
    '',
    '【デリバリー件数】',
    a.deliveryCount + '件',
    '',
    '【アルバイトスタッフ氏名】',
  ];
  a.staff.forEach(function (person, index) {
    if (index > 0) lines.push('');
    lines.push(person.name);
    lines.push(clockText(person.start) + '〜' + clockText(person.end));
    lines.push(workHours(person.start, person.end).total + '時間勤務');
  });
  lines.push('', '【経費報告】', '合計経費:' + number(a.expenseTotal));
  EXPENSE_ITEMS.forEach(function (item) {
    lines.push(item[1] + ':' + number(a.expenses[item[0]]));
  });
  lines.push('封筒残金: ' + (a.envelopeBalance === null ? '' : number(a.envelopeBalance)) + '円');
  lines.push('', '【今月の口コミ数】', a.reviewCount + '件(毎月7件必達)');
  lines.push('', '【1日で感じたこと】', a.comment);
  return lines.join('\n');
}

/** '17:30' を '17時半'、'25:00' を '翌1時' にする（いつもの日報の書き方）。 */
function clockText(time) {
  var label = timeLabel(time); // '翌1:30' など
  var nextDay = label.charAt(0) === '翌';
  var parts = label.replace('翌', '').split(':');
  return (nextDay ? '翌' : '') + parts[0] + '時' + (parts[1] === '30' ? '半' : '');
}

function addDays(date, days) {
  var p = date.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
}

function later(value) {
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve(value);
    }, SAMPLE_DELAY_MS);
  });
}
