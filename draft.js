// 入力の途中を、端末の中（localStorage）に残す。
//
// ■ このフォルダ（screen/）の中身は、GitHub Pages の公開リポジトリに写すので、誰でも見られる。
//   秘密の情報、本物のデータ、実在の人の名前は書かない。
//
// 本人の確かめの期限（1時間）が切れたら、画面はログインし直して読み込み直す。そのときに入力の途中が消えないよう、
// 答えを変えるたびに端末に残す。ログアウトして読み込み直すと、1秒ほどのあいだに画面が3回続けて読み込まれる
// （2026/10/07 の iPhone での確かめ）ので、続けて読み込まれても古い内容に戻らないように、次のように作る。
//   ・開いたとき・読み込んだときは書かない（読むだけ）。書くのは、本人が答えを変えたときと、ログインし直す直前だけ
//   ・「読んで、足して、書き戻す」形にしない。保存のたびに、入力の途中の全体を1つの値として、通し番号と
//     画面の番号ごとに別の名前で書く（上書きしない）
//   ・書く直前に読み直し、この画面が知っているより新しい保存（別の画面が書いたもの）があれば書かずに、新しい方を返す。
//     そのあとは、この画面は保存をやめる
//   ・同じ端末の別の画面が新しい保存をしたと知らせ（storage）が届いたときも、この画面は保存をやめる
//   ・開いたときは、いちばん新しい保存（通し番号が大きい方。同じ番号なら保存した時刻が新しい方）から続ける
//   ・48時間たった保存は使わず、保存するときに消す。登録したら、その人の分を消す
//   ・通し番号のいちばん大きい値（と、それを書いた画面）は、別の名前（report-draft-last:）に残し、消したあとも残す
//     （消したあとに開いた画面の番号が1に戻ると、古い画面の保存の方が新しく見えてしまうため）
//   ・ログインし直す印（いつ、続きから出すか）は、途中の保存とは別の名前（report-relogin:）に残す
//     （途中を出さない空の画面の保存で、本当の途中が隠れないように）
//   ・店の端末を何人かで使っても混ざらないよう、人ごとに分ける。保存の名前には、LINE のユーザーIDそのものではなく、
//     元に戻せない形に変えた値（ハッシュ）を使う（ユーザーIDは端末の中だけで使い、GAS には送らない）
// ブラウザでも Node.js（テスト）でも読めるよう、画面の部品は使わない。

var DRAFT_KEY_PREFIX = 'report-draft:';
var DRAFT_LAST_PREFIX = 'report-draft-last:'; // 通し番号のいちばん大きい値と、それを書いた画面
var DRAFT_RELOGIN_PREFIX = 'report-relogin:'; // ログインし直す印
var DRAFT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
var DRAFT_KEEP = 5; // 人ごとに残す保存の数（新しいものから）

/**
 * 1つの画面（読み込み1回分）の、入力の途中の保存。
 * @param {Storage|null} storage localStorage（使えなければ null）
 * @param {string} ownerKey 人ごとの名前（draftOwnerKey で作る。見本の画面では決まった言葉）
 * @param {{pageCode: string, now?: function(): number}} options pageCode：この画面の番号（英数字）
 */
function createDraftStore(storage, ownerKey, options) {
  var pageCode = options.pageCode;
  var now =
    options.now ||
    function () {
      return Date.now();
    };
  var prefix = DRAFT_KEY_PREFIX + ownerKey + ':';
  var lastKey = DRAFT_LAST_PREFIX + ownerKey;
  var reloginKey = DRAFT_RELOGIN_PREFIX + ownerKey;
  var stale = false;
  // この画面が知っている、いちばん大きい通し番号（開いたときに読んだもの。この画面が保存したら、その番号）
  var knownRev = 0;
  try {
    var first = newestOrThrow();
    var last = readLast();
    knownRev = Math.max(first ? first.rev : 0, last ? last.rev : 0);
  } catch (err) {
    knownRev = 0;
  }

  /** 通し番号のいちばん大きい値の印（{ rev, page }。なければ null）。読めなければエラーを投げる。 */
  function readLast() {
    if (!storage) return null;
    return parseLast(storage.getItem(lastKey));
  }

  function parseLast(text) {
    var value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      return null;
    }
    return value && typeof value.rev === 'number' && typeof value.page === 'string' ? value : null;
  }

  /** 保存の名前を読む（この人の分なら { rev, page }、ほかは null）。 */
  function parseKey(key) {
    if (typeof key !== 'string' || key.indexOf(prefix) !== 0) return null;
    var parts = key.slice(prefix.length).split(':');
    var rev = Number(parts[0]);
    if (parts.length !== 2 || !(rev > 0) || !parts[1]) return null;
    return { rev: rev, page: parts[1] };
  }

  /** 保存の中身を読む。壊れていたり形が違えば null。 */
  function read(key) {
    var value;
    try {
      value = JSON.parse(storage.getItem(key));
    } catch (err) {
      return null;
    }
    if (!value || typeof value.rev !== 'number' || typeof value.savedAt !== 'number' || typeof value.page !== 'string') return null;
    if (!value.content || typeof value.content !== 'object') return null;
    return value;
  }

  function expired(draft) {
    return now() - draft.savedAt >= DRAFT_MAX_AGE_MS;
  }

  /** 端末にある保存の名前（すべての人の分）。読めなければエラーを投げる。 */
  function allKeys() {
    var keys = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (typeof key === 'string' && key.indexOf(DRAFT_KEY_PREFIX) === 0) keys.push(key);
    }
    return keys;
  }

  /**
   * この人の、いちばん新しい保存（48時間を過ぎたものは使わない）。filter があれば、それに合うものの中で。
   * 読めなければエラーを投げる。
   */
  function newestOrThrow(filter) {
    if (!storage) return null;
    var best = null;
    allKeys().forEach(function (key) {
      if (!parseKey(key)) return;
      var draft = read(key);
      if (!draft || expired(draft) || (filter && !filter(draft))) return;
      if (!best || draft.rev > best.rev || (draft.rev === best.rev && draft.savedAt > best.savedAt)) best = draft;
    });
    return best;
  }

  /**
   * 古い保存を消す。この人の分は、新しい DRAFT_KEEP 個を残し、読めない保存も消す。
   * 48時間を過ぎた保存は、どの人の分も消す。
   */
  function cleanUp(rev) {
    try {
      allKeys().forEach(function (key) {
        var mine = parseKey(key);
        var draft = read(key);
        var old = mine && (mine.rev <= rev - DRAFT_KEEP || !draft);
        if (old || (draft && expired(draft))) storage.removeItem(key);
      });
    } catch (err) {
      // 消せなくても、保存はできているので止めない
    }
  }

  return {
    /** いちばん新しい保存（filter があれば、それに合うものの中で。なければ null）。読むだけで、何も書かない。 */
    newest: function (filter) {
      try {
        return newestOrThrow(filter);
      } catch (err) {
        return null;
      }
    },

    /**
     * 入力の途中の全体を保存する（本人が答えを変えたとき、ログインし直す直前）。
     * @param {Object} content 画面に戻すのに要るもの
     * @param {string} reason 'input'（答えを変えた）か 'relogin'（ログインし直す直前）
     * @return {{ok: boolean, rev?: number, conflict?: Object|null, problem?: string}}
     *   conflict：別の画面が先に進んでいたので、書かなかった（その画面のいちばん新しい保存。登録して消したあとなら null）
     */
    save: function (content, reason) {
      if (!storage) return { ok: false, problem: '端末の記録（localStorage）が使えない' };
      if (stale) return { ok: false, problem: '別の画面で、もっと新しい保存がされた' };
      var latest;
      var last;
      try {
        latest = newestOrThrow();
        last = readLast();
      } catch (err) {
        return { ok: false, problem: draftErrorText(err) };
      }
      var newerDraft = latest && latest.rev > knownRev && latest.page !== pageCode;
      var newerMark = last && last.rev > knownRev && last.page !== pageCode;
      if (newerDraft || newerMark) {
        stale = true;
        return { ok: false, conflict: latest || null };
      }
      var rev = Math.max(knownRev, latest ? latest.rev : 0, last ? last.rev : 0) + 1;
      var record = JSON.stringify({ rev: rev, savedAt: now(), page: pageCode, reason: reason, content: content });
      var key = prefix + ('00000' + rev).slice(-6) + ':' + pageCode;
      try {
        storage.setItem(key, record);
        if (storage.getItem(key) !== record) return { ok: false, problem: '書いたあとに読み直すと、中身が違った' };
      } catch (err) {
        return { ok: false, problem: draftErrorText(err) };
      }
      knownRev = rev;
      try {
        storage.setItem(lastKey, JSON.stringify({ rev: rev, page: pageCode }));
      } catch (err) {
        // 印を書けなくても、保存はできているので止めない
      }
      cleanUp(rev);
      return { ok: true, rev: rev };
    },

    /** この人の保存をすべて消す（登録したとき、「新しく入力する」を選んだとき）。通し番号の印は残す。 */
    clear: function () {
      if (!storage) return { ok: false, problem: '端末の記録（localStorage）が使えない' };
      try {
        allKeys().forEach(function (key) {
          if (parseKey(key)) storage.removeItem(key);
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, problem: draftErrorText(err) };
      }
    },

    /** 別の画面のもっと新しい保存に気づいて、保存をやめたか。 */
    isStale: function () {
      return stale;
    },

    /**
     * 同じ端末の別の画面が端末の記録を書き換えたときの知らせ（window の storage）。
     * この人の、別の画面の、この画面が知っているより新しい保存なら、保存をやめて、いちばん新しい保存を返す。ほかは null。
     */
    onStorageEvent: function (event) {
      if (!event || ('newValue' in event && event.newValue === null)) return null; // 消した知らせは見ない
      var parsed = event.key === lastKey ? parseLast(event.newValue) : parseKey(event.key);
      if (!parsed || parsed.page === pageCode || !(parsed.rev > knownRev)) return null;
      stale = true;
      return this.newest();
    },

    /**
     * ログインし直す印を残す（期限切れで、ログアウトして読み込み直す直前）。
     * resume：読み込み直したあとに、聞かずに続きから出すか（この画面に入力の途中があるとき）
     */
    markRelogin: function (resume) {
      if (!storage) return { ok: false, problem: '端末の記録（localStorage）が使えない' };
      var value = JSON.stringify({ at: now(), resume: Boolean(resume) });
      try {
        storage.setItem(reloginKey, value);
        if (storage.getItem(reloginKey) !== value) return { ok: false, problem: '書いたあとに読み直すと、中身が違った' };
        return { ok: true };
      } catch (err) {
        return { ok: false, problem: draftErrorText(err) };
      }
    },

    /** ログインし直す印（{ at, resume }。なければ null）。読むだけ。 */
    reloginMark: function () {
      if (!storage) return null;
      try {
        var value = JSON.parse(storage.getItem(reloginKey));
        return value && typeof value.at === 'number' ? { at: value.at, resume: Boolean(value.resume) } : null;
      } catch (err) {
        return null;
      }
    },
  };
}

/**
 * 保存の名前に使う、人ごとの値。LINE のユーザーIDのハッシュ（SHA-256。元に戻せない）。
 * @param {string} userId IDトークンの中のユーザーID（端末の中だけで使う）
 * @return {Promise<string>} 64文字の16進数
 */
function draftOwnerKey(userId) {
  var bytes = new TextEncoder().encode('report-draft-owner:' + userId);
  return crypto.subtle.digest('SHA-256', bytes).then(function (buffer) {
    return Array.prototype.map
      .call(new Uint8Array(buffer), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      })
      .join('');
  });
}

function draftErrorText(err) {
  var name = (err && err.name) || 'Error';
  var message = (err && err.message) || String(err);
  return (name + '：' + message).slice(0, 80);
}

if (typeof module !== 'undefined') {
  module.exports = {
    createDraftStore: createDraftStore,
    draftOwnerKey: draftOwnerKey,
    DRAFT_MAX_AGE_MS: DRAFT_MAX_AGE_MS,
  };
}
