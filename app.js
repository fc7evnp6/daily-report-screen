// 日報の入力画面の動き。質問を1つずつ出し、確認画面で見直して「登録」し、登録したあとの画面まで。
//
// ■ このファイルは公開される。秘密の情報や本物のデータを書かない。
// 画面に出す文字は、すべて文字として入れる（textContent。HTML として扱わない）。
// GAS とのやりとりは server に任せる（見本では、どこにも送らない偽物の server を使う）。
//   server.loadProfile()            → { name, stores, candidates: { 店舗: [氏名] } } か { message }（名簿にない人など）
//   server.loadDay(store, date)     → { registered: 'none' | 'mine' | 'other', version, answers }
//   server.check(answers)           → { errors: [文字], warnings: [{ message, step }], version }
//   server.register(answers, id)    → { version, text }（text は管理者に送る、いつもの日報の文章）
//   server.share(text)              → { message }（管理者に送る。見本では説明を返すだけ）
//   server.close()                  → { message }（画面を閉じる）

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
var WEATHER_CHOICES = ['晴れ', '曇り', '雨'];
var NUMBER_FIELDS = ['salesCash', 'monthToDate', 'deliveryCount', 'expenseTotal', 'envelopeBalance', 'reviewCount'];

/**
 * 入力画面を始める。
 * @param {Object} server GAS とのやりとり（上の説明を参照）
 * @param {{now?: Date}} options
 */
function startReportApp(server, options) {
  var root = document.getElementById('app');
  var now = (options && options.now) || new Date();
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
    errors: [],
    check: null,
    result: null,
    shareMessage: '',
    busy: '',
    submissionId: '',
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
    if (id === 'confirm') {
      loadCheck();
      return;
    }
    render();
    window.scrollTo(0, 0);
  }

  function next() {
    var current = step();
    state.errors = problemsOf(current);
    if (state.errors.length > 0) {
      render();
      return;
    }
    if (current.id === 'day') {
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
    state.errors = [];
    if (state.returnToConfirm && step().id !== 'confirm') {
      goTo('confirm');
      return;
    }
    if (step().id === 'confirm') state.returnToConfirm = false;
    goTo(STEPS[state.stepIndex - 1].id);
  }

  function fix(id) {
    state.returnToConfirm = true;
    goTo(id);
  }

  /** 時間のかかる問い合わせのあいだ、「読み込み中」を出してボタンを押せなくする。 */
  function withBusy(text, promise, then) {
    state.busy = text;
    render();
    promise
      .then(function (value) {
        state.busy = '';
        then(value);
      })
      .catch(function () {
        state.busy = '';
        state.errors = ['通信できませんでした。電波の良いところで、もう一度押してください。'];
        render();
      });
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
    if (current.id === 'weather') return a.weather ? [] : ['天候を選んでください。'];
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
    a.weather = saved.weather || '';
    var candidates = candidatesOf(state.store);
    a.staff = saved.staff.map(function (p) {
      return { name: p.name, start: p.start, end: p.end, typed: candidates.indexOf(p.name) === -1 };
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
  // GAS への問い合わせ
  // ============================================================

  function loadProfile() {
    withBusy('読み込み中…', server.loadProfile(), function (profile) {
      state.profile = profile;
      if (!profile.message) {
        state.store = profile.stores.length === 1 ? profile.stores[0] : '';
        state.answers = emptyAnswers(profile.name);
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
    withBusy('読み込み中…', server.loadDay(state.store, state.date), function (info) {
      state.loadedKey = key;
      state.dayInfo = info;
      state.returnToConfirm = false;
      if (info.registered === 'mine') {
        state.answers = answersFrom(info.answers);
        state.dayNotice =
          'この日は登録済みです（' + info.version + '回目の報告）。前の内容が入っています。' +
          '直して登録すると、' + (info.version + 1) + '回目の報告として前の内容と置き換わります。';
      } else {
        state.answers = emptyAnswers(state.profile.name);
        state.dayNotice =
          info.registered === 'other'
            ? 'この日の日報は、別のスタッフが登録しています。ここで登録すると、新しい報告として前の内容と置き換わります。'
            : '';
      }
      goTo(STEPS[1].id);
    });
  }

  function loadCheck() {
    state.check = null;
    state.submissionId = newSubmissionId();
    withBusy('確かめています…', server.check(collectAnswers()), function (check) {
      state.check = check;
      render();
      window.scrollTo(0, 0);
    });
  }

  function register() {
    withBusy('登録しています…', server.register(collectAnswers(), state.submissionId), function (result) {
      state.result = result;
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
      return;
    }
    if (state.profile.message) {
      root.appendChild(
        el('div', { className: 'page' }, [
          el('h1', { text: '日報の入力' }),
          el('div', { className: 'box info', text: state.profile.message }),
        ])
      );
      return;
    }

    var current = step();
    var page = el('div', { className: 'page' }, [topbar(current)]);
    if (current.id !== 'done') page.appendChild(el('h1', { text: current.title }));
    if (current.help) page.appendChild(el('p', { className: 'help', text: current.help }));
    if (state.stepIndex === 1 && state.dayNotice && !state.returnToConfirm) {
      page.appendChild(el('div', { className: 'box info', text: state.dayNotice }));
    }

    var body = renderers[current.kind ? 'number' : current.id](current);
    body.forEach(function (node) {
      page.appendChild(node);
    });
    if (state.errors.length > 0) page.appendChild(errorBox(state.errors));
    root.appendChild(page);

    var action = actionsOf(current);
    if (action) root.appendChild(action);
    if (state.busy) root.appendChild(el('div', { className: 'busy', text: state.busy }));
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
                render();
              });
            })
          )
        );
        nodes.push(el('h2', { text: '日付', style: 'margin-top:16px' }));
      } else {
        nodes.push(el('p', { className: 'help', text: '店舗：' + state.store }));
      }
      var dates = selectableReportDates(now);
      nodes.push(
        el(
          'div',
          { className: 'choices' },
          dates.map(function (date, index) {
            var sub = index === 0 ? '今日' : index === 1 ? '昨日' : '';
            return choiceButton(dateLabel(date), sub, state.date === date, function () {
              state.date = date;
              state.errors = [];
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
          },
        }),
        counter,
      ];
    },

    confirm: function () {
      var nodes = [];
      var check = state.check;
      if (!check) return nodes;
      nodes.push(el('p', { className: 'help', text: check.version + '回目の報告として登録します。' }));
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
      var nodes = [
        el('div', { className: 'done-mark', text: '✓' }),
        el('h1', { className: 'center', text: '登録しました' }),
        el('p', {
          className: 'center help',
          text: dateLabel(state.date) + ' ' + state.store + 'の日報（' + result.version + '回目の報告）',
        }),
        el('h2', { text: '管理者にも送る' }),
        el('p', { className: 'help', text: 'いつもの日報の文章を、管理者の LINE に送れます。' }),
        el('button', {
          className: 'primary',
          type: 'button',
          text: '管理者に日報を送る',
          onclick: function () {
            withBusy('', server.share(result.text), function (shared) {
              state.shareMessage = shared.message;
              render();
            });
          },
        }),
        el('button', {
          className: 'secondary',
          type: 'button',
          text: '文章をコピー',
          onclick: function () {
            copyText(result.text);
          },
        }),
      ];
      if (state.shareMessage) nodes.push(el('div', { className: 'box info', style: 'margin-top:16px', text: state.shareMessage }));
      nodes.push(
        el('details', {}, [el('summary', { text: '送られる文章を見る' }), el('pre', { className: 'report-text', text: result.text })])
      );
      nodes.push(
        el('button', {
          className: 'secondary',
          type: 'button',
          text: '閉じる',
          onclick: function () {
            withBusy('', server.close(), function (closed) {
              if (closed && closed.message) {
                state.shareMessage = closed.message;
                render();
              }
            });
          },
        })
      );
      return nodes;
    },
  };

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

  function copyText(text) {
    var done = function () {
      state.shareMessage = 'コピーしました。管理者とのトークに貼り付けて送れます。';
      render();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        copyWithTextarea(text);
        done();
      });
    } else {
      copyWithTextarea(text);
      done();
    }
  }

  function copyWithTextarea(text) {
    var area = el('textarea', { value: text, readonly: true, style: 'position:fixed;top:-1000px' });
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      // コピーできなくても、「送られる文章を見る」から選んでコピーできる
    }
    document.body.removeChild(area);
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
