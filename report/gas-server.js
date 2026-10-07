// 本物の入力画面の、LINE（LIFF）と GAS とのやりとり。画面（../app.js）の server として使う。
//
// ■ このフォルダ（screen/）の中身は、GitHub Pages の公開リポジトリに写すので、誰でも見られる。
//   秘密の情報、本物のデータ、実在の人の名前は書かない（GAS の URL と LIFF ID は config.js にだけ書く）。
//
//   ・LIFF を始め、LINE の中で開いているかを確かめる（LINE の外なら、案内だけを出す）
//   ・GAS には IDトークンだけを付けて送る（ユーザーIDやプロフィールは送らない）。本文は JSON の文字列で、
//     種類は text/plain（GAS は事前の問い合わせ（OPTIONS）に答えられないため）
//   ・GAS の返事の形は src/screen-api.js の冒頭のとおり。読めない返事は、断られたときと同じ形にする
//   ・IDトークンの期限（1時間）が切れていたら、入力の途中を端末に残してから、ログアウトして読み込み直す
//     （新しいトークンになる。2026/10/07 の iPhone での確かめ）。ログインし直すのは1回だけ。読み込み直した直後に
//     また期限切れのときや、途中を残せないときは、くり返さずに GAS の言葉（「画面を閉じて、開き直してください」）を出す
//   ・ユーザーIDは、入力の途中を人ごとに分ける名前（ハッシュ）を作るためだけに、端末の中で使う

var REPORT_MESSAGES = {
  outside: 'LINE の外で開いています。LINE のトークから開いてください。',
  start: 'LINE での準備ができませんでした。画面を閉じて、開き直してください。',
  token: 'LINE での本人の確かめができませんでした。画面を閉じて、開き直してください。',
  badReply: '返事を読めませんでした。少し時間をおいて、もう一度押してください。',
  shareFailed: '管理者に送れませんでした。もう一度押すか、「文章をコピー」を使ってください。',
};

/**
 * GAS とやりとりする server を作る。
 * @param {{gasUrl: string, liffId: string}} config
 * @param {Object} [env] テスト用の差し替え（liff、fetch、location、ownerKeyOf）。省けばブラウザのもの
 */
function createGasServer(config, env) {
  env = env || {};
  var liff = env.liff || window.liff;
  var fetchFn =
    env.fetch ||
    function (url, options) {
      return window.fetch(url, options);
    };
  var location = env.location || window.location;
  var ownerKeyOf =
    env.ownerKeyOf || (typeof draftOwnerKey === 'function' ? draftOwnerKey : require('../draft.js').draftOwnerKey);
  var hooks = {};
  var shareAvailable = false;

  function refusal(error, message) {
    return { ok: false, error: error, message: message };
  }

  /**
   * GAS に送り、返事を読む。通信できなければ失敗（画面が「通信できませんでした」と出す）。
   * noRelogin：期限切れでもログインし直さない（送った記録。登録したあとの画面を消さないように）
   */
  function request(action, fields, noRelogin) {
    var idToken = null;
    try {
      idToken = liff.getIDToken();
    } catch (err) {
      idToken = null;
    }
    if (!idToken) return Promise.resolve(refusal('token', REPORT_MESSAGES.token));
    var body = { action: action, idToken: idToken };
    Object.keys(fields || {}).forEach(function (key) {
      body[key] = fields[key];
    });
    return fetchFn(config.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    })
      .then(function (response) {
        return response.text();
      })
      .then(function (text) {
        var reply = null;
        try {
          reply = JSON.parse(text);
        } catch (err) {
          reply = null;
        }
        if (!reply || typeof reply.ok !== 'boolean') return refusal('bad_reply', REPORT_MESSAGES.badReply);
        if (reply.ok === false && reply.error === 'expired' && !noRelogin) return relogin(reply);
        return reply;
      });
  }

  /**
   * 期限切れ：入力の途中を残してから、ログアウトして読み込み直す（返事は待たない）。
   * 読み込み直した直後や、途中を残せないときは、くり返さずに GAS の言葉を返す。
   */
  function relogin(reply) {
    if (typeof hooks.recentRelogin === 'function' && hooks.recentRelogin()) return reply;
    var saved = typeof hooks.beforeRelogin === 'function' ? hooks.beforeRelogin() : null;
    if (!saved || !saved.ok) return reply;
    try {
      liff.logout();
    } catch (err) {
      // ログアウトできなくても読み込み直す（直後にまた期限切れなら、くり返さない）
    }
    location.reload();
    return new Promise(function () {});
  }

  return {
    /**
     * LIFF を始める。LINE の中で、本人の確かめができれば { ok: true, ownerKey }（入力の途中を人ごとに分ける名前。
     * 作れなければ null）、できなければ { ok: false, message }。
     */
    start: function () {
      return Promise.resolve()
        .then(function () {
          return liff.init({ liffId: config.liffId });
        })
        .then(
          function () {
            if (!liff.isInClient()) return { ok: false, message: REPORT_MESSAGES.outside };
            var decoded = null;
            try {
              decoded = liff.getDecodedIDToken();
            } catch (err) {
              decoded = null;
            }
            if (!decoded || !decoded.sub) return { ok: false, message: REPORT_MESSAGES.token };
            try {
              shareAvailable = Boolean(liff.isApiAvailable('shareTargetPicker'));
            } catch (err) {
              shareAvailable = false;
            }
            // 名前を作れなければ（ハッシュの部品がない、など）、途中を残さないだけ
            return Promise.resolve()
              .then(function () {
                return ownerKeyOf(decoded.sub);
              })
              .then(
                function (ownerKey) {
                  return { ok: true, ownerKey: ownerKey };
                },
                function () {
                  return { ok: true, ownerKey: null };
                }
              );
          },
          function () {
            return { ok: false, message: REPORT_MESSAGES.start };
          }
        );
    },

    /** 画面とのつなぎ：beforeRelogin（途中を残す。{ ok } を返す）、recentRelogin（ログインし直した直後か）。 */
    attach: function (h) {
      hooks = h || {};
    },

    loadProfile: function () {
      return request('profile');
    },
    loadDay: function (store, date) {
      return request('day', { store: store, date: date });
    },
    check: function (answers) {
      return request('check', { answers: answers });
    },
    register: function (answers, submissionId) {
      return request('register', { answers: answers, submissionId: submissionId });
    },
    /**
     * 管理者に送った（how: 'shared'）、または文章をコピーした（'copied'）ことを残す。
     * 期限切れで断られても、ログインし直さない（送り先を選ぶ画面は、期限が切れていても送れる。2026/10/07 に確かめた）
     */
    recordSent: function (report, how) {
      return request('sent', { date: report.date, store: report.store, version: report.version, how: how }, true);
    },

    /** 送り先を選ぶ画面を使えるか（LINE Developers の設定がオフ、古い LINE などでは使えない）。 */
    canShare: function () {
      return shareAvailable;
    },

    /**
     * 送り先を選ぶ画面で、日報の文章を送る。
     * @return {Promise<{status: string, message?: string}>} sent（送った）、cancelled（選ばずに閉じた）、
     *   unavailable（使えない）、failed（失敗した）
     */
    share: function (text) {
      if (!shareAvailable) return Promise.resolve({ status: 'unavailable' });
      return liff.shareTargetPicker([{ type: 'text', text: text }]).then(
        function (result) {
          return result && result.status === 'success' ? { status: 'sent' } : { status: 'cancelled' };
        },
        function () {
          return { status: 'failed', message: REPORT_MESSAGES.shareFailed };
        }
      );
    },

    /** LINE の画面を閉じる。 */
    close: function () {
      liff.closeWindow();
      return Promise.resolve({});
    },
  };
}

/**
 * 本物の入力画面を始める（report/dev/index.html、report/pub/index.html から呼ぶ）。
 * @param {string} which 'dev'（開発用）か 'pub'（公開用）。config.js の LIFF ID を選ぶ
 */
function startLineReport(which) {
  var root = document.getElementById('app');
  var show = function (className, text) {
    root.textContent = '';
    root.appendChild(
      className === 'busy'
        ? el('div', { className: 'busy', text: text })
        : el('div', { className: 'page' }, [el('h1', { text: '日報の入力' }), el('div', { className: 'box info', text: text })])
    );
  };
  var server = createGasServer({ gasUrl: REPORT_CONFIG.gasUrl, liffId: REPORT_CONFIG.liffIds[which] });
  show('busy', '読み込み中…');
  server
    .start()
    .catch(function () {
      return { ok: false, message: REPORT_MESSAGES.start };
    })
    .then(function (started) {
      if (!started.ok) {
        show('info', started.message);
        return;
      }
      var storage = null;
      try {
        storage = window.localStorage;
      } catch (err) {
        storage = null;
      }
      var pageCode = Math.random().toString(36).slice(2, 5).toUpperCase();
      startReportApp(server, {
        draftStore: started.ownerKey ? createDraftStore(storage, started.ownerKey, { pageCode: pageCode }) : null,
      });
    });
}

if (typeof module !== 'undefined') module.exports = { createGasServer: createGasServer };
