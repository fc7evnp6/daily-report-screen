// 日報の入力画面の動き。質問を1つずつ出し、確認画面で見直して「登録」し、登録したあとの画面まで。
//
// ■ このファイルは公開される。秘密の情報や本物のデータを書かない。
// 画面に出す文字は、すべて文字として入れる（textContent。HTML として扱わない）。
// GAS とのやりとりは server に任せる（見本では、どこにも送らない偽物の server を使う）。
// 返事の形は GAS（src/screen-api.js の冒頭）と同じ。断るときは { ok: false, error, message }
// （答えの確かめで断るときは errors に直すことの一覧）。
//   server.loadProfile()            → { ok, name, stores, candidates: { 店舗: [氏名] }, dates, defaultDate, unsent }
//                                     （dates と defaultDate は GAS の時計で決めた、選べる日付と最初の値）
//   server.loadDay(store, date)     → { ok, registered: 'none' | 'mine' | 'other', version, nextVersion, answers }
//   server.check(answers)           → { ok, errors: [文字], warnings: [{ message, step }], version }
//   server.register(answers, id)    → { ok, date, store, version, text, message }（text は管理者に送る、いつもの日報の文章）
//   server.canShare()               → 送り先を選ぶ画面を使えるか（使えなければ「文章をコピー」だけ）
//   server.share(text)              → { status: 'sent' | 'cancelled' | 'unavailable' | 'failed', message }
//   server.recordSent(report, how)  → 管理者に送った（how: 'shared'）・コピーした（'copied'）記録を残す（GAS の sent）
//   server.close()                  → { message }（画面を閉じる。見本では説明を返すだけ）
// 入力の途中は、options.draftStore（screen/draft.js）があれば端末に残す。答えを変えたときだけ書き、登録したら消す。
// 開き直して途中があれば「続きから入力する／新しく入力する」を聞く。ログインし直した直後（RELOGIN_RESUME_MS 以内の
// ログインし直す印があり、そのとき入力の途中があった）なら、聞かずに続きから出す。

var EXPENSE_ITEMS = [
  ['food', '食材費'],
  ['iceMix', 'アイスミックス'],
  ['materials', '資材費'],
  ['supplies', '消耗品費'],
  ['misc', '雑費'],
  ['utilities', '光熱費'],
  ['card', 'カード'],
];

// 質問の順番。kind は欄の種類（amount：金額、count：件数）
var STEPS = [
  { id: 'day', title: 'どの日の日報ですか？' },
  { id: 'salesCash', title: '売上現金はいくらですか？', kind: 'amount', required: true },
  {
    id: 'monthToDate',
    title: '月累計はいくらですか？',
    help: 'この日の売上を含めた、今月の売上現金の合計です。',
    kind: 'amount',
    required: true,
  },
  { id: 'weather', title: '天候は？' },
  { id: 'deliveryCount', title: 'デリバリーは何件でしたか？', kind: 'count', required: true },
  { id: 'staff', title: '勤務したスタッフ', help: '時刻は30分刻みです。勤務時間は自動で計算します。' },
  { id: 'expenses', title: '経費の内訳', help: '使わなかった項目は空欄のままでかまいません（0円として扱います）。' },
  { id: 'expenseTotal', title: '合計経費はいくらですか？', kind: 'amount', required: true },
  {
    id: 'envelopeBalance',
    title: '封筒残金はいくらですか？',
    help: '封筒に残っている金額です。残っていなければ 0 と入力してください。',
    kind: 'amount',
    required: true,
  },
  { id: 'reviewCount', title: '今月の口コミ数は何件ですか？', help: '毎月7件必達です。', kind: 'count', required: true },
  {
    id: 'comment',
    title: '1日で感じたこと',
    help: 'お店の問題点や感じたこと、提案など、何でも書いてください。なければ空欄のままでかまいません。',
  },
  { id: 'confirm', title: '内容を確かめてください' },
  { id: 'done', title: '登録しました' },
];

var QUESTION_COUNT = STEPS.length - 2; // 確認画面と、登録したあとの画面は数えない
// ログインし直す印から、この時間内に開いたら、ログインし直した直後として扱う（聞かずに続きから出す。くり返さない）
var RELOGIN_RESUME_MS = 10 * 60 * 1000;
// 開くところで断られても「もう一度読み込む」を出さないもの（名簿にない・申請中、閉じて開き直すしかないとき）
var NO_RETRY_ERRORS = ['not_registered', 'pending', 'expired', 'token', 'not_configured'];
var WEATHER_CHOICES = ['晴れ', '曇り', '雨'];
var NUMBER_FIELDS = ['salesCash', 'monthToDate', 'deliveryCount', 'expenseTotal', 'envelopeBalance', 'reviewCount'];

/**
 * 入力画面を始める。
 * @param {Object} server GAS とのやりとり（上の説明を参照）
 * @param {{now?: Date, draftStore?: Object}} options draftStore：入力の途中を端末に残す（screen/draft.js。なければ残さない）
 */
function startReportApp(server, options) {
  var root = document.getElementById('app');
  var now = (options && options.now) || new Date();
  var drafts = (options && options.draftStore) || null;
  var state = {
    profile: null,
    stepIndex: 0,
    returnToConfirm: false, // 確認画面の「直す」から来たら、次へで確認画面に戻る
    store: '',
    date: defaultReportDate(now),
    loadedKey: '', // 前の内容を読み込んだ日付と店舗
    dayInfo: null,
    dayNotice: '',
    answers: emptyAnswers(''),
    dates: selectableReportDates(now), // 選べる日付（GAS から届いたら、GAS の時計で決めたものに置き換える）
    errors: [],
    errorHeading: '', // 断られたときの見出し（直すことの一覧があるとき）
    check: null,
    result: null,
    shareMessage: '',
    sentHow: '', // 登録したあとに、管理者に送った（shared）かコピーした（copied）か
    closeAsked: false, // 送らずに「閉じる」を押して、1回聞いたか
    unsent: [], // 開いたときの、管理者にまだ送っていない日報
    unsentMessage: '',
    busy: '',
    submissionId: '',
    resumeOffer: null, // 開いたときに見つかった入力の途中（「続きから入力する」かを聞く）
    draftNotice: '', // 入力の途中の保存についての知らせ（別の画面の保存とぶつかった、など）
    resumeNotice: '', // ログインし直したあと、続きから出したことの知らせ
    dirty: false, // この画面に、本人の入力の途中があるか（答えを変えた、続きから出した）
    inFlight: false, // 問い合わせの返事を待っているか
  };

  function emptyAnswers(name) {
    var fields = {};
    NUMBER_FIELDS.forEach(function (key) {
      fields[key] = '';
    });
    var expenses = {};
    EXPENSE_ITEMS.forEach(function (item) {
      expenses[item[0]] = '';
    });
    return {
      fields: fields,
      expenses: expenses,
      weather: '',
      staff: [staffMember(name)],
      comment: '',
    };
  }

  /** スタッフの欄1人分（開始は17:00、終了は選ばれていない。typed は「一覧にない人を入力する」を選んだか）。 */
  function staffMember(name) {
    var person = newStaffMember(name);
    person.typed = false;
    return person;
  }

  // ============================================================
  // 進む・戻る
  // ============================================================

  function step() {
    return STEPS[state.stepIndex];
  }

  function goTo(id) {
    state.stepIndex = STEPS.map(function (s) {
      return s.id;
    }).indexOf(id);
    state.errors = [];
    state.errorHeading = '';
    if (id === 'confirm') {
      loadCheck();
      return;
    }
    render();
    window.scrollTo(0, 0);
  }

  function next() {
    state.resumeNotice = '';
    var current = step();
    state.errors = problemsOf(current);
    if (state.errors.length > 0) {
      render();
      return;
    }
    if (current.id === 'day') {
      state.resumeOffer = null; // 続きからを選ばずに進んだら、新しく入力する
      loadDay();
      return;
    }
    if (state.returnToConfirm) {
      goTo('confirm');
      return;
    }
    goTo(STEPS[state.stepIndex + 1].id);
  }

  function back() {
    state.resumeNotice = '';
    state.errors = [];
    state.errorHeading = '';
    if (state.returnToConfirm && step().id !== 'confirm') {
      goTo('confirm');
      return;
    }
    if (step().id === 'confirm') state.returnToConfirm = false;
    goTo(STEPS[state.stepIndex - 1].id);
  }

  function fix(id) {
    state.resumeNotice = '';
    state.returnToConfirm = true;
    goTo(id);
  }

  /**
   * GAS に断られた（ok が false）なら、今の画面のまま断られた言葉を出して true を返す。
   * 答えの確かめで断られたときは、言葉を見出しにして、直すことの一覧を出す。
   */
  function refused(reply) {
    if (!reply || reply.ok !== false) return false;
    var list = reply.errors && reply.errors.length > 0;
    state.errors = list ? reply.errors : [reply.message || '受け付けられませんでした。もう一度押してください。'];
    state.errorHeading = list ? reply.message || '' : '';
    render();
    return true;
  }

  /**
   * 時間のかかる問い合わせのあいだ、「読み込み中」を出してボタンを押せなくする。
   * 問い合わせは1つずつ（返事を待っているあいだに押されたボタンは、何もしない。2回押しで2回送らないように）。
   * @param {string} text 待っているあいだに出す言葉（空なら出さない）
   * @param {function(): Promise} start 問い合わせを始める
   * @param {function(*)} then 返事が届いたら
   */
  function withBusy(text, start, then) {
    if (state.inFlight) return;
    state.inFlight = true;
    state.busy = text;
    render();
    start().then(
      function (value) {
        state.inFlight = false;
        state.busy = '';
        then(value);
      },
      function () {
        state.inFlight = false;
        state.busy = '';
        state.errors = ['通信できませんでした。電波の良いところで、もう一度押してください。'];
        state.errorHeading = '';
        render();
      }
    );
  }

  // ============================================================
  // 進めない理由（画面の確かめ。最後は GAS が確かめ直す）
  // ============================================================

  function problemsOf(current) {
    var a = state.answers;
    if (current.id === 'day') return state.store ? [] : ['店舗を選んでください。'];
    if (current.kind) {
      var read = readField(current.kind, a.fields[current.id]);
      if (read.error) return [read.error];
      if (current.required && read.value === null) {
        return [current.kind === 'amount' ? '金額を入力してください（なければ 0）。' : '件数を入力してください（なければ 0）。'];
      }
      return [];
    }
    if (current.id === 'weather') return WEATHER_CHOICES.indexOf(a.weather) !== -1 ? [] : ['天候を選んでください。'];
    if (current.id === 'staff') return staffProblems(a.staff);
    if (current.id === 'expenses') {
      var problems = [];
      EXPENSE_ITEMS.forEach(function (item) {
        var error = readAmountInput(a.expenses[item[0]]).error;
        if (error) problems.push(item[1] + '：' + error);
      });
      return problems;
    }
    if (current.id === 'comment') {
      var commentError = commentProblem(a.comment);
      return commentError ? [commentError] : [];
    }
    return [];
  }

  function readField(kind, text) {
    return kind === 'count' ? readCountInput(text) : readAmountInput(text);
  }

  /** GAS に送る答え（数字は読み取った値にする）。 */
  function collectAnswers() {
    var a = state.answers;
    var values = {};
    NUMBER_FIELDS.forEach(function (key) {
      var kind = key === 'deliveryCount' || key === 'reviewCount' ? 'count' : 'amount';
      values[key] = readField(kind, a.fields[key]).value;
    });
    var expenses = {};
    EXPENSE_ITEMS.forEach(function (item) {
      expenses[item[0]] = readAmountInput(a.expenses[item[0]]).value;
    });
    return {
      store: state.store,
      date: state.date,
      salesCash: values.salesCash,
      monthToDate: values.monthToDate,
      weather: a.weather,
      deliveryCount: values.deliveryCount,
      staff: a.staff.map(function (p) {
        return { name: p.name.trim(), start: p.start, end: p.end };
      }),
      expenses: expenses,
      expenseTotal: values.expenseTotal,
      envelopeBalance: values.envelopeBalance,
      reviewCount: values.reviewCount,
      comment: a.comment.trim(),
    };
  }

  /** GAS から届いた前の内容を、画面の欄に入れる。 */
  function answersFrom(saved) {
    var a = emptyAnswers('');
    NUMBER_FIELDS.forEach(function (key) {
      a.fields[key] = saved[key] === null || saved[key] === undefined ? '' : String(saved[key]);
    });
    EXPENSE_ITEMS.forEach(function (item) {
      var value = saved.expenses[item[0]];
      a.expenses[item[0]] = value ? String(value) : '';
    });
    // 画面で選べない値（文章で送った日報の「晴れのち曇り」や「11:15」など）は空にして、選び直してもらう
    a.weather = WEATHER_CHOICES.indexOf(saved.weather) !== -1 ? saved.weather : '';
    var candidates = candidatesOf(state.store);
    a.staff = saved.staff.map(function (p) {
      var start = startTimeOptions().indexOf(p.start) !== -1 ? p.start : '';
      var end = start && endTimeOptions(start).indexOf(p.end) !== -1 ? p.end : '';
      return { name: p.name, start: start, end: end, typed: candidates.indexOf(p.name) === -1 };
    });
    a.comment = saved.comment || '';
    return a;
  }

  function candidatesOf(store) {
    return (state.profile.candidates && state.profile.candidates[store]) || [];
  }

  function hasAnswers() {
    var a = state.answers;
    var filled = function (obj) {
      return Object.keys(obj).some(function (key) {
        return String(obj[key]).trim() !== '';
      });
    };
    return (
      filled(a.fields) ||
      filled(a.expenses) ||
      a.weather !== '' ||
      a.comment.trim() !== '' ||
      a.staff.length !== 1 ||
      a.staff[0].start !== newStaffMember('').start ||
      a.staff[0].end !== ''
    );
  }

  // ============================================================
  // 入力の途中を端末に残す
  // ============================================================

  /** 画面に戻すのに要るもの（端末に残す中身）。 */
  function snapshot() {
    return {
      store: state.store,
      date: state.date,
      stepId: step().id,
      answers: state.answers,
      loadedKey: state.loadedKey,
      dayInfo: state.dayInfo,
      dayNotice: state.dayNotice,
      returnToConfirm: state.returnToConfirm,
    };
  }

  /** 本人が答えを変えたときに、入力の途中を残す（開いただけ、進んだだけでは書かない）。 */
  function changed() {
    state.dirty = true;
    if (!drafts) return;
    var result = drafts.save(snapshot(), 'input');
    // 別の画面で、もっと新しい保存がされていた。上書きせずに、新しい方を出し直す（この画面は、もう保存しない）
    if (result.conflict) showNewerDraft(result.conflict);
  }

  /** 別の画面のもっと新しい保存を、この画面に出し直して知らせる（登録したあとの画面や、使えない保存なら知らせるだけ）。 */
  function showNewerDraft(draft) {
    // 返事を待っているあいだは入れ替えない（あとから届いた返事で、入れ替えた内容が上書きされないように）
    if (!state.inFlight && draft && state.profile && state.profile.ok !== false && step().id !== 'done' && usableDraft(draft)) {
      state.draftNotice = '別の画面で入力した内容があったため、そちらに入れ替えました。この画面の入力は、端末に残していません。';
      restore(draft.content);
      return;
    }
    state.draftNotice = '別の画面で入力が進んでいます。この画面の入力は、端末に残していません（画面を閉じて、開き直してください）。';
    render();
  }

  /** 端末に残っていた途中のうち、今の本人が使えるもの（送れる店舗、選べる日付、画面の形）。 */
  function usableDraft(draft) {
    var c = draft && draft.content;
    if (!c || state.profile.stores.indexOf(c.store) === -1 || state.dates.indexOf(c.date) === -1) return false;
    var a = c.answers;
    return Boolean(
      a && a.fields && a.expenses && Array.isArray(a.staff) && a.staff.length > 0 &&
      typeof a.weather === 'string' && typeof a.comment === 'string'
    );
  }

  /** 端末に残っていた途中を、画面に戻す。 */
  function restore(c) {
    state.resumeOffer = null;
    state.dirty = true;
    state.store = c.store;
    state.date = c.date;
    state.answers = c.answers;
    state.loadedKey = c.loadedKey || '';
    state.dayInfo = c.dayInfo || null;
    state.dayNotice = c.dayNotice || '';
    state.returnToConfirm = Boolean(c.returnToConfirm);
    var ids = STEPS.map(function (s) {
      return s.id;
    });
    var id = ids.indexOf(c.stepId) !== -1 && c.stepId !== 'done' ? c.stepId : 'day';
    // 日付の画面のあとの質問は、その日付と店舗を読み込んだあとでないと出さない
    if (id !== 'day' && state.loadedKey !== state.store + '|' + state.date) id = 'day';
    goTo(id);
  }

  /**
   * 開いたとき：使える途中（いちばん新しいもの）があれば、ログインし直した直後で、そのとき入力の途中があったなら
   * 聞かずに続きから出す。そうでなければ、続きからか聞く。
   */
  function offerDraft() {
    var draft = drafts ? drafts.newest(usableDraft) : null;
    if (!draft) return false;
    if (reloginAt > 0 && reloginMark && reloginMark.resume) {
      state.resumeNotice =
        '本人の確かめをし直しました。続きから入力できます。' +
        (draft.content.stepId === 'confirm' ? 'もう一度「この内容で登録する」を押してください。' : '');
      restore(draft.content);
      return true;
    }
    state.resumeOffer = draft;
    return false;
  }

  // 同じ端末の別の画面が、もっと新しい保存をした（この画面は、もう保存しない。新しい方を出し直す）
  if (drafts && typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', function (event) {
      var newer = drafts.onStorageEvent(event);
      if (newer) showNewerDraft(newer);
    });
  }

  // ============================================================
  // GAS への問い合わせ
  // ============================================================

  function loadProfile() {
    withBusy('読み込み中…', function () {
      return server.loadProfile();
    }, function (profile) {
      state.profile = profile; // 断られたとき（名簿にない人など）は、その言葉だけを出す（render）
      if (profile.ok !== false) {
        state.store = profile.stores.length === 1 ? profile.stores[0] : '';
        state.answers = emptyAnswers(profile.name);
        state.unsent = profile.unsent || [];
        if (profile.dates && profile.dates.length > 0) state.dates = profile.dates;
        if (profile.defaultDate) state.date = profile.defaultDate;
        if (offerDraft()) return; // ログインし直した直後は、続きから出した
      }
      render();
    });
  }

  function loadDay() {
    var key = state.store + '|' + state.date;
    if (key === state.loadedKey) {
      goTo(state.returnToConfirm ? 'confirm' : STEPS[1].id);
      return;
    }
    withBusy('読み込み中…', function () {
      return server.loadDay(state.store, state.date);
    }, function (info) {
      if (refused(info)) return; // 日付の画面のまま
      state.loadedKey = key;
      state.dayInfo = info;
      state.returnToConfirm = false;
      if (info.registered === 'mine') {
        state.answers = answersFrom(info.answers);
        state.dayNotice =
          'この日は登録済みです（' + info.version + '回目の報告）。前の内容が入っています。' +
          '直して登録すると、' + info.nextVersion + '回目の報告として前の内容と置き換わります。';
      } else {
        state.answers = emptyAnswers(state.profile.name);
        state.dayNotice =
          info.registered === 'other'
            ? 'この日の日報は、別のスタッフが登録しています。ここで登録すると、' + info.nextVersion +
              '回目の報告として前の内容と置き換わります。'
            : '';
      }
      goTo(STEPS[1].id);
    });
  }

  function loadCheck() {
    state.check = null;
    state.submissionId = newSubmissionId();
    withBusy('確かめています…', function () {
      return server.check(collectAnswers());
    }, function (check) {
      if (refused(check)) return; // 確認できないので、登録のボタンは押せないまま
      state.check = check;
      render();
      window.scrollTo(0, 0);
    });
  }

  function register() {
    withBusy('登録しています…', function () {
      return server.register(collectAnswers(), state.submissionId);
    }, function (result) {
      if (refused(result)) return; // 確認画面のまま
      if (drafts) drafts.clear(); // 登録したら、入力の途中は要らない
      state.result = result;
      state.sentHow = '';
      state.closeAsked = false;
      state.shareMessage = '';
      state.returnToConfirm = false;
      goTo('done');
    });
  }

  /** 送信ごとの番号。「登録」を2回押しても、GAS が2回目を記録しないようにする。 */
  function newSubmissionId() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map
      .call(bytes, function (b) {
        return (b < 16 ? '0' : '') + b.toString(16);
      })
      .join('');
  }

  // ============================================================
  // 画面を作る
  // ============================================================

  function render() {
    root.textContent = '';
    if (!state.profile) {
      if (state.busy) root.appendChild(el('div', { className: 'busy', text: state.busy }));
      else if (state.errors.length > 0) root.appendChild(startProblemPage(errorBox(state.errors), true));
      return;
    }
    if (state.profile.ok === false) {
      // 名簿にない・申請中の人や、閉じて開き直すしかないときは、もう一度読み込んでも変わらない
      var retry = NO_RETRY_ERRORS.indexOf(state.profile.error) === -1;
      root.appendChild(startProblemPage(el('div', { className: 'box info', text: state.profile.message }), retry));
      return;
    }

    var current = step();
    var page = el('div', { className: 'page' }, [topbar(current)]);
    if (state.draftNotice) page.appendChild(el('div', { className: 'box warn', text: state.draftNotice }));
    if (state.resumeNotice) page.appendChild(el('div', { className: 'box info', text: state.resumeNotice }));
    if (current.id !== 'done') page.appendChild(el('h1', { text: current.title }));
    if (current.help) page.appendChild(el('p', { className: 'help', text: current.help }));
    if (state.stepIndex === 1 && state.dayNotice && !state.returnToConfirm) {
      page.appendChild(el('div', { className: 'box info', text: state.dayNotice }));
    }

    var body = renderers[current.kind ? 'number' : current.id](current);
    body.forEach(function (node) {
      page.appendChild(node);
    });
    if (state.errors.length > 0) page.appendChild(errorBox(state.errors, state.errorHeading));
    root.appendChild(page);

    var action = actionsOf(current);
    if (action) root.appendChild(action);
    if (state.busy) root.appendChild(el('div', { className: 'busy', text: state.busy }));
  }

  /** 開くところで止まったときの画面（言葉と、もう一度読み込むボタン）。 */
  function startProblemPage(box, retry) {
    return el('div', { className: 'page' }, [
      el('h1', { text: '日報の入力' }),
      box,
      retry
        ? el('button', {
            className: 'primary',
            type: 'button',
            text: 'もう一度読み込む',
            onclick: function () {
              state.profile = null;
              state.errors = [];
              loadProfile();
            },
          })
        : null,
    ]);
  }

  function topbar(current) {
    var showBack = state.stepIndex > 0 && current.id !== 'done';
    var context = current.id === 'day' ? '日報の入力' : dateLabel(state.date) + '　' + state.store;
    var progress =
      state.stepIndex < QUESTION_COUNT ? state.stepIndex + 1 + ' / ' + QUESTION_COUNT : current.id === 'confirm' ? '確認' : '';
    return el('div', { className: 'topbar' }, [
      showBack ? el('button', { className: 'back', type: 'button', text: '‹ 戻る', onclick: back }) : el('span', { className: 'back' }),
      el('div', { className: 'context', text: context }),
      el('div', { className: 'progress', text: progress }),
    ]);
  }

  function actionsOf(current) {
    if (current.id === 'done') return null;
    var button;
    if (current.id === 'confirm') {
      var blocked = !state.check || state.check.errors.length > 0;
      button = el('button', {
        className: 'primary',
        type: 'button',
        text: 'この内容で登録する',
        disabled: blocked || Boolean(state.busy),
        onclick: register,
      });
    } else {
      var label = state.returnToConfirm ? '確認画面に戻る' : '次へ';
      if (current.id === 'day' && dayWillReset()) label = '日付を変えて次へ';
      button = el('button', { className: 'primary', type: 'button', text: label, disabled: Boolean(state.busy), onclick: next });
    }
    return el('div', { className: 'actions' }, [el('div', { className: 'inner' }, [button])]);
  }

  /** 入力したあとに日付や店舗を変えると、入力した内容が消える。 */
  function dayWillReset() {
    return state.loadedKey !== '' && state.loadedKey !== state.store + '|' + state.date && hasAnswers();
  }

  var renderers = {
    day: function () {
      var nodes = [];
      if (state.unsent.length > 0 || state.unsentMessage) nodes.push(unsentBox());
      if (state.resumeOffer) nodes.push(resumeBox(state.resumeOffer));
      var stores = state.profile.stores;
      if (stores.length > 1) {
        nodes.push(el('h2', { text: '店舗' }));
        nodes.push(
          el(
            'div',
            { className: 'choices' },
            stores.map(function (store) {
              return choiceButton(store, '', state.store === store, function () {
                state.store = store;
                if (!state.resumeOffer) changed(); // 「続きから」を聞いているあいだは保存しない（途中を隠さないように）
                render();
              });
            })
          )
        );
        nodes.push(el('h2', { text: '日付', style: 'margin-top:16px' }));
      } else {
        nodes.push(el('p', { className: 'help', text: '店舗：' + state.store }));
      }
      var dates = state.dates;
      nodes.push(
        el(
          'div',
          { className: 'choices' },
          dates.map(function (date, index) {
            var sub = index === 0 ? '今日' : index === 1 ? '昨日' : '';
            return choiceButton(dateLabel(date), sub, state.date === date, function () {
              state.date = date;
              state.errors = [];
              if (!state.resumeOffer) changed();
              render();
            });
          })
        )
      );
      if (dayWillReset()) {
        nodes.push(
          el('div', {
            className: 'box warn',
            style: 'margin-top:16px',
            text: '日付や店舗を変えると、ここまでに入力した内容は消えます。',
          })
        );
      }
      return nodes;
    },

    number: function (current) {
      var unit = current.kind === 'amount' ? '円' : '件';
      var preview = el('div', { className: 'preview' });
      var input = el('input', {
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        'aria-label': current.title,
        value: state.answers.fields[current.id],
        oninput: function (event) {
          state.answers.fields[current.id] = event.target.value;
          showPreview(preview, current.kind, event.target.value);
          changed();
        },
        onkeydown: function (event) {
          if (event.key === 'Enter') next();
        },
      });
      showPreview(preview, current.kind, state.answers.fields[current.id]);
      setTimeout(function () {
        input.focus();
      }, 0);
      return [el('div', { className: 'amount' }, [input, el('span', { className: 'unit', text: unit })]), preview];
    },

    weather: function () {
      return [
        el(
          'div',
          { className: 'choices three' },
          WEATHER_CHOICES.map(function (choice) {
            return choiceButton(choice, '', state.answers.weather === choice, function () {
              state.answers.weather = choice;
              state.errors = [];
              changed();
              render();
            });
          })
        ),
      ];
    },

    staff: function () {
      var nodes = state.answers.staff.map(function (person, index) {
        return personCard(person, index);
      });
      nodes.push(
        el('button', {
          className: 'add',
          type: 'button',
          text: '＋ スタッフを足す',
          onclick: function () {
            state.answers.staff.push(staffMember(''));
            changed();
            render();
          },
        })
      );
      return nodes;
    },

    expenses: function () {
      return [
        el(
          'div',
          { className: 'rows' },
          EXPENSE_ITEMS.map(function (item) {
            var id = 'expense-' + item[0];
            return el('div', { className: 'row' }, [
              el('label', { for: id, text: item[1] }),
              el('input', {
                id: id,
                type: 'text',
                inputmode: 'numeric',
                autocomplete: 'off',
                placeholder: '0',
                value: state.answers.expenses[item[0]],
                oninput: function (event) {
                  state.answers.expenses[item[0]] = event.target.value;
                  changed();
                },
              }),
              el('span', { className: 'unit', text: '円' }),
            ]);
          })
        ),
      ];
    },

    comment: function () {
      var counter = el('div', { className: 'counter' });
      var showCount = function () {
        counter.textContent = state.answers.comment.length + ' / 1000文字';
      };
      showCount();
      return [
        el('textarea', {
          'aria-label': '1日で感じたこと',
          value: state.answers.comment,
          oninput: function (event) {
            state.answers.comment = event.target.value;
            showCount();
            changed();
          },
        }),
        counter,
      ];
    },

    confirm: function () {
      var nodes = [];
      var check = state.check;
      if (!check) {
        // 確かめられなかった（通信できない、断られた）：もう一度確かめるボタン
        if (!state.busy && !state.inFlight) {
          nodes.push(el('button', { className: 'secondary', type: 'button', text: 'もう一度確かめる', onclick: loadCheck }));
        }
        return nodes;
      }
      if (check.version) nodes.push(el('p', { className: 'help', text: check.version + '回目の報告として登録します。' }));
      if (check.errors.length > 0) {
        nodes.push(errorBox(check.errors, 'このままでは登録できません。直してください。'));
      }
      if (check.warnings.length > 0) {
        nodes.push(
          el('div', { className: 'box warn' }, [
            el('strong', { text: '確かめてください（このままでも登録できます）' }),
            el(
              'ul',
              {},
              check.warnings.map(function (warning) {
                return el('li', {}, [
                  el('span', { text: warning.message + ' ' }),
                  warning.step ? fixButton(warning.step) : null,
                ]);
              })
            ),
          ])
        );
      }
      return nodes.concat(summary(collectAnswers()));
    },

    done: function () {
      var result = state.result;
      var report = reportOf(result);
      var canShare = typeof server.canShare !== 'function' || server.canShare();
      var nodes = [
        el('div', { className: 'done-mark', text: '✓' }),
        el('h1', { className: 'center', text: '登録しました' }),
        el('p', {
          className: 'center help',
          text: dateLabel(report.date) + ' ' + report.store + 'の日報（' + result.version + '回目の報告）',
        }),
        el('h2', { text: '管理者にも送る' }),
        el('p', {
          className: 'help',
          text: canShare
            ? 'いつもの日報の文章を、管理者の LINE に送れます。'
            : '文章をコピーして、管理者とのトークに貼り付けて送ってください。',
        }),
      ];
      // いちばん上を、大きな緑の「管理者に日報を送る」にする（押し忘れを減らすため）。使えなければ「文章をコピー」
      if (canShare) {
        nodes.push(
          el('button', {
            className: 'primary',
            type: 'button',
            text: '管理者に日報を送る',
            onclick: function () {
              shareReport(report, result.text, function (message, sent) {
                if (sent) state.sentHow = 'shared';
                state.shareMessage = message;
                render();
              });
            },
          })
        );
      }
      nodes.push(
        el('button', {
          className: canShare ? 'secondary' : 'primary',
          type: 'button',
          text: '文章をコピー',
          onclick: function () {
            copyReport(report, result.text, function (message, copied) {
              if (copied && !state.sentHow) state.sentHow = 'copied';
              state.shareMessage = message;
              render();
            });
          },
        })
      );
      if (state.shareMessage) nodes.push(el('div', { className: 'box info', style: 'margin-top:16px', text: state.shareMessage }));
      nodes.push(
        el('details', {}, [el('summary', { text: '送られる文章を見る' }), el('pre', { className: 'report-text', text: result.text })])
      );
      if (state.closeAsked && !state.sentHow) {
        nodes.push(
          el('div', {
            className: 'box warn',
            style: 'margin-top:16px',
            text: '管理者にまだ送っていません。送らずに閉じますか？（送らずに閉じるときは、もう一度「閉じる」を押してください）',
          })
        );
      }
      nodes.push(
        el('div', { className: 'center', style: 'margin-top:20px' }, [
          el('button', { className: 'link', type: 'button', text: '閉じる', onclick: closeScreen }),
        ])
      );
      return nodes;
    },
  };

  /** 登録の返事から、送った記録に使う日報（日付・店舗・版）。 */
  function reportOf(result) {
    return { date: result.date || state.date, store: result.store || state.store, version: result.version };
  }

  /**
   * 送り先を選ぶ画面で、日報の文章を送る。送ったら、送った記録を残す（shared）。
   * 結果は show(言葉, 送ったか) で渡す（記録を残せなかったときは、言葉を足して、もう一度渡す）。
   */
  function shareReport(report, text, show) {
    withBusy('', function () {
      return server.share(text);
    }, function (shared) {
      var status = shared && shared.status;
      if (status === 'sent') {
        var message = shared.message || '送りました。';
        show(message, true);
        recordSent(report, 'shared', function () {
          show(message + '（送った記録は残せませんでした。送ったことは変わりません）', true);
        });
        return;
      }
      if (status === 'cancelled') show('送りませんでした。送るときは、もう一度押してください。', false);
      else if (status === 'unavailable') show('この LINE では送り先を選ぶ画面を使えません。「文章をコピー」を使ってください。', false);
      else show((shared && shared.message) || '管理者に送れませんでした。もう一度押すか、「文章をコピー」を使ってください。', false);
    });
  }

  /**
   * 日報の文章をコピーし、コピーできたら、コピーした記録を残す（copied。送ったかまでは分からない）。
   * 結果は show(言葉, コピーできたか) で渡す。
   */
  function copyReport(report, text, show) {
    copyText(
      text,
      function () {
        var message = 'コピーしました。管理者とのトークに貼り付けて送ってください。';
        show(message, true);
        recordSent(report, 'copied', function () {
          show(message + '（コピーした記録は残せませんでした）', true);
        });
      },
      function () {
        show('コピーできませんでした。「送られる文章を見る」を開いて、文章を長押ししてコピーしてください。', false);
      }
    );
  }

  /** 送った・コピーした記録を GAS に残す。残せなかったら onFailed を呼ぶ（送ったことは変わらないので、止めない）。 */
  function recordSent(report, how, onFailed) {
    if (typeof server.recordSent !== 'function') return;
    server.recordSent(report, how).then(
      function (reply) {
        if (!reply || reply.ok === false) onFailed();
      },
      function () {
        onFailed();
      }
    );
  }

  /** 登録したあとの「閉じる」。管理者にまだ送っていなければ、1回だけ聞く。 */
  function closeScreen() {
    if (!state.sentHow && !state.closeAsked) {
      state.closeAsked = true;
      render();
      return;
    }
    withBusy('', function () {
      return server.close();
    }, function (closed) {
      if (closed && closed.message) {
        state.shareMessage = closed.message;
        render();
      }
    });
  }

  /** 開いたときの知らせ：管理者にまだ送っていない日報。その場で送れる（送ったら・コピーしたら、知らせから消す）。 */
  function unsentBox() {
    var canShare = typeof server.canShare !== 'function' || server.canShare();
    var manyStores = state.profile.stores.length > 1;
    var items = state.unsent.map(function (item) {
      var report = { date: item.date, store: item.store, version: item.version };
      var show = function (message, handedOver) {
        if (handedOver) {
          state.unsent = state.unsent.filter(function (other) {
            return other !== item;
          });
        }
        state.unsentMessage = message;
        render();
      };
      return el('div', { className: 'item' }, [
        el('div', {
          text:
            dateLabel(item.date) + (manyStores ? ' ' + item.store : '') + ' の日報（' + item.version +
            '回目の報告）を、まだ管理者に送っていません。',
        }),
        el('div', { className: 'unsent-actions' }, [
          canShare
            ? el('button', {
                className: 'primary',
                type: 'button',
                text: '管理者に送る',
                onclick: function () {
                  shareReport(report, item.text, show);
                },
              })
            : null,
          el('button', {
            className: 'secondary',
            type: 'button',
            text: '文章をコピー',
            onclick: function () {
              copyReport(report, item.text, show);
            },
          }),
        ]),
      ]);
    });
    return el(
      'div',
      { className: 'box warn unsent' },
      [el('strong', { text: state.unsent.length > 0 ? 'まだ管理者に送っていない日報があります' : '管理者に送る日報' })]
        .concat(items)
        .concat(state.unsentMessage ? [el('div', { className: 'unsent-message', text: state.unsentMessage })] : [])
    );
  }

  /** 開いたときに見つかった入力の途中：「続きから入力する」か「新しく入力する」かを聞く。 */
  function resumeBox(draft) {
    var c = draft.content;
    var saved = new Date(draft.savedAt);
    return el('div', { className: 'box info' }, [
      el('strong', {
        text:
          '入力の途中があります（' + dateLabel(c.date) + ' ' + c.store + '・' + saved.getHours() + ':' +
          ('0' + saved.getMinutes()).slice(-2) + ' に保存）',
      }),
      el('div', { className: 'resume-actions' }, [
        el('button', {
          className: 'primary',
          type: 'button',
          text: '続きから入力する',
          onclick: function () {
            restore(c);
          },
        }),
        el('button', {
          className: 'secondary',
          type: 'button',
          text: '新しく入力する',
          onclick: function () {
            drafts.clear();
            state.resumeOffer = null;
            render();
          },
        }),
      ]),
    ]);
  }

  function personCard(person, index) {
    var candidates = candidatesOf(state.store);
    var hours = workHours(person.start, person.end);
    var select = el(
      'select',
      {
        'aria-label': index + 1 + '人目の氏名',
        onchange: function (event) {
          var value = event.target.value;
          person.typed = value === '__typed__';
          person.name = person.typed ? '' : value;
          changed();
          render();
        },
      },
      [el('option', { value: '', text: '氏名を選んでください' })]
        .concat(
          candidates.map(function (name) {
            return el('option', { value: name, text: name });
          })
        )
        .concat([el('option', { value: '__typed__', text: '一覧にない人を入力する' })])
    );
    select.value = person.typed ? '__typed__' : person.name;

    var head = el('div', { className: 'head' }, [el('span', { text: index + 1 + '人目' })]);
    if (state.answers.staff.length > 1) {
      head.appendChild(
        el('button', {
          className: 'link',
          type: 'button',
          text: 'この人を外す',
          onclick: function () {
            state.answers.staff.splice(index, 1);
            changed();
            render();
          },
        })
      );
    }

    var card = el('div', { className: 'person' }, [head, select]);
    if (person.typed) {
      card.appendChild(
        el('input', {
          className: 'typed',
          type: 'text',
          placeholder: 'フルネーム（例：見本 花子）',
          'aria-label': index + 1 + '人目の氏名（手で入力）',
          value: person.name,
          oninput: function (event) {
            person.name = event.target.value;
            changed();
          },
        })
      );
    }
    card.appendChild(
      el('div', { className: 'times' }, [
        timeSelect('開始', startTimeOptions(), person.start, function (value) {
          person.start = value;
          person.end = endAfterStartChange(value, person.end); // 開始より前か同じになったら、選び直してもらう
        }),
        el('span', { text: '〜' }),
        // 終了は、開始より後の時刻だけを出す（開始と同じ時刻にならないように）
        timeSelect('終了', endTimeOptions(person.start), person.end, function (value) {
          person.end = value;
        }),
      ])
    );
    card.appendChild(el('div', { className: 'hours', text: hours ? '勤務 ' + describeWorkHours(hours) : '' }));
    return card;
  }

  /** 時刻の選択。まだ選ばれていないとき（value が空）だけ、「開始」「終了」の見出しの行を先頭に出す。 */
  function timeSelect(label, options, value, onChange) {
    var select = el(
      'select',
      {
        'aria-label': label,
        onchange: function (event) {
          onChange(event.target.value);
          changed();
          render();
        },
      },
      (value ? [] : [el('option', { value: '', text: label })]).concat(
        options.map(function (time) {
          return el('option', { value: time, text: timeLabel(time) });
        })
      )
    );
    select.value = value;
    return select;
  }

  /** 確認画面の一覧。いつもの日報と同じ並び。「直す」で、その質問に戻る。 */
  function summary(a) {
    var yen = function (value) {
      return value === null ? '空欄' : formatYen(value);
    };
    var count = function (value) {
      return value === null ? '空欄' : value + '件';
    };
    return [
      section('売上', null, [
        ['売上現金', yen(a.salesCash), 'salesCash'],
        ['月累計', yen(a.monthToDate), 'monthToDate'],
        ['天候', a.weather, 'weather'],
        ['デリバリー', count(a.deliveryCount), 'deliveryCount'],
      ]),
      section(
        '勤務',
        'staff',
        a.staff.map(function (p) {
          var hours = workHours(p.start, p.end);
          return [p.name, timeLabel(p.start) + '〜' + timeLabel(p.end) + '　' + (hours ? describeWorkHours(hours) : '')];
        }),
        true
      ),
      section('経費', null, [['合計経費', yen(a.expenseTotal), 'expenseTotal']]),
      section(
        '経費の内訳',
        'expenses',
        EXPENSE_ITEMS.map(function (item) {
          return [item[1], formatYen(a.expenses[item[0]] || 0)];
        })
      ),
      section('封筒残金と口コミ', null, [
        ['封筒残金', yen(a.envelopeBalance), 'envelopeBalance'],
        ['今月の口コミ数', count(a.reviewCount), 'reviewCount'],
      ]),
      el('div', { className: 'summary' }, [
        el('div', { className: 'section-head' }, [el('h2', { text: '1日で感じたこと' }), fixButton('comment')]),
        el('div', { className: 'comment', text: a.comment || 'なし' }),
      ]),
    ];
  }

  /**
   * 確認画面の一覧の1まとまり。
   * headStep があれば見出しに「直す」を付け、items の3つ目（質問の id）があれば、その行に「直す」を付ける。
   * stacked なら、名前と中身を2行に分ける（勤務のように、名前も中身も長いとき）。
   */
  function section(title, headStep, items, stacked) {
    return el('div', { className: 'summary' }, [
      el('div', { className: 'section-head' }, [el('h2', { text: title }), headStep ? fixButton(headStep) : null]),
      el(
        'dl',
        {},
        items.map(function (item) {
          return el('div', { className: stacked ? 'item stacked' : 'item' }, [
            el('dt', { text: item[0] }),
            el('dd', { text: item[1] }),
            item[2] ? fixButton(item[2]) : null,
          ]);
        })
      ),
    ]);
  }

  function fixButton(stepId) {
    return el('button', {
      className: 'fix',
      type: 'button',
      text: '直す',
      onclick: function () {
        fix(stepId);
      },
    });
  }

  function choiceButton(label, sub, pressed, onclick) {
    return el('button', { className: 'choice', type: 'button', 'aria-pressed': String(pressed), onclick: onclick }, [
      el('span', { text: label }),
      sub ? el('span', { className: 'sub', text: sub }) : null,
    ]);
  }

  function errorBox(messages, heading) {
    return el('div', { className: 'box error' }, [
      heading ? el('strong', { text: heading }) : null,
      el(
        'ul',
        {},
        messages.map(function (message) {
          return el('li', { text: message });
        })
      ),
    ]);
  }

  function showPreview(node, kind, text) {
    var read = readField(kind, text);
    if (read.error) node.textContent = read.error;
    else if (read.value === null) node.textContent = '';
    else node.textContent = kind === 'amount' ? formatYen(read.value) : read.value + '件';
  }

  /** 文字をコピーする。できたら done、できなかったら failed を呼ぶ（「送られる文章を見る」から選んでコピーできる）。 */
  function copyText(text, done, failed) {
    var fallback = function () {
      if (copyWithTextarea(text)) done();
      else failed();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  /** 画面の外に置いた入力欄を選んでコピーする（クリップボードを使えないとき）。コピーできたら true。 */
  function copyWithTextarea(text) {
    var area = el('textarea', { value: text, style: 'position:fixed;top:-1000px' });
    document.body.appendChild(area);
    var copied = false;
    try {
      area.focus();
      area.select();
      area.setSelectionRange(0, text.length); // iPhone では select だけでは選ばれない
      copied = document.execCommand('copy') === true;
    } catch (err) {
      copied = false;
    }
    document.body.removeChild(area);
    return copied;
  }

  // 期限切れのときのログインし直し（screen/report/gas-server.js）とのつなぎ。
  // ログインし直す直前に、入力の途中があれば残し、ログインし直す印を残す（印は途中の保存とは別の名前。
  // 途中のない画面の空の保存で、本当の途中が隠れないように）。開いたときの印が新しければ、ログインし直した直後なので、
  // もう一度期限切れになっても、くり返さない。印に「続きから出す」とあれば、聞かずに続きから出す（offerDraft）
  var reloginMark = drafts ? drafts.reloginMark() : null;
  var reloginAt = reloginMark && Date.now() - reloginMark.at < RELOGIN_RESUME_MS ? reloginMark.at : 0;
  if (typeof server.attach === 'function') {
    server.attach({
      beforeRelogin: function () {
        if (!drafts) return { ok: false, problem: '入力の途中を端末に残せない' };
        if (state.dirty) {
          var saved = drafts.save(snapshot(), 'relogin');
          if (!saved.ok) return saved;
        }
        var marked = drafts.markRelogin(state.dirty);
        if (marked.ok) {
          state.busy = '本人の確かめをし直しています…';
          render();
        }
        return marked;
      },
      recentRelogin: function () {
        return reloginAt > 0 && Date.now() - reloginAt < RELOGIN_RESUME_MS;
      },
    });
  }

  loadProfile();
}

/**
 * 画面の部品を作る。文字は textContent で入れる（HTML として扱わない）。
 * props の on〜 は出来事（クリックなど）、value は部品を作り終えてから入れる（select の選択肢のあと）。
 */
function el(tag, props, children) {
  var node = document.createElement(tag);
  var value;
  Object.keys(props || {}).forEach(function (key) {
    var v = props[key];
    if (v === null || v === undefined || v === false) return;
    if (key === 'text') node.textContent = v;
    else if (key === 'className') node.className = v;
    else if (key === 'value') value = v;
    else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), v);
    else node.setAttribute(key, v === true ? '' : v);
  });
  (children || []).forEach(function (child) {
    if (child) node.appendChild(child);
  });
  if (value !== undefined) node.value = value;
  return node;
}
