// 段階2の疎通確認の画面（開発者だけが使う）。LINE ミニアプリの中で開き、次をボタンで1つずつ試す。
//   ・LINE の中で開けるか、IDトークン → GAS で確かめる → 名簿の結果（text/plain で送り、返事を読めるか）
//   ・送り先を選ぶ画面（シェアターゲットピッカー）で、自分に送れるか
//   ・1時間たった IDトークンの扱い（期限切れになるか、読み込み直し・開き直しで新しくなるか）
//   ・写真を撮る・アルバムから選ぶ・複数選ぶ、縮めて JPEG に作り直す（写真はどこにも送らない）
//   ・約1MBの送信が GAS に届くか（写真ではない作り物のデータ。GAS は大きさを返すだけ）
//   ・端末の中に残したものが、読み込み直し・ログアウトして読み込み直し・閉じて開き直しのあとも残るか
//     （本物の画面で、入力の途中を端末に残す計画のため。localStorage と IndexedDB の2か所で比べる）
// 結果は「結果のまとめ」に集め、コピーして伝える。LINE のユーザーIDや名前は、画面にもまとめにも出さない。
// 読み込み直しや開き直しをまたいで比べるため、記録は端末の中（localStorage）にだけ残す。
// 端末の中に書けなかった・読めなかったときは、理由を捨てずに画面とまとめに出す。
//
// ■ このファイルは公開される。秘密の情報や本物のデータは書かない（GAS の URL と LIFF ID は config.js に書く）。

var PROBE_PHOTO_LONG_SIDE = 2000; // 縮めたあとの長い辺（ピクセル）。入力画面の計画と同じ
var PROBE_PHOTO_QUALITY = 0.7; // JPEG の画質
var PROBE_ECHO_LENGTH = 1000000; // 送る量の確かめ（約1MB）
var PROBE_LOG_KEY = 'probe-log'; // これまでの記録（端末の中だけ）
var PROBE_LAST_TOKEN_KEY = 'probe-last-token'; // 前に開いたときの IDトークンの発行時刻
var PROBE_MARK_KEY = 'probe-mark'; // 「印を残す」で残した印
var PROBE_MARK_BEFORE_KEY = 'probe-mark-before'; // 読み込み直す・ログアウトして読み込み直すの直前に残した印
var PROBE_LOG_MAX = 300;
var PROBE_IDB_NAME = 'probe'; // IndexedDB（端末の中のもう1つの置き場所）
var PROBE_IDB_STORE = 'marks';
var PROBE_IDB_WAIT_MS = 3000; // IndexedDB の返事を待つ時間（返事がないまま止まることがあるため）
var PROBE_CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 番号に使う文字（見間違えやすい I・L・O・0・1 は使わない）

/**
 * 疎通確認の画面を始める。
 * @param {string} channel 'dev'（開発用）か 'pub'（公開用）
 */
function startProbe(channel) {
  var channelLabel = channel === 'pub' ? '公開用' : '開発用';
  var root = document.getElementById('app');
  var env = '（まだ）';
  var token = null; // { raw, aud, iat, exp }
  var tokenNote = '';
  var shownPhotoUrls = [];
  var pageCode = newCode(3, Math.random); // この回（画面を読み込むたび）の番号。記録の行の［］に付ける
  var writtenHere = []; // この回で、端末の記録に足した行
  var storageNotes = []; // この回で起きた、端末の記録の問題 { text, first, count }

  // ============================================================
  // 画面の部品
  // ============================================================

  var envResult = el('div', { className: 'result' });
  var tokenResult = el('div', { className: 'result' });
  var gasResult = el('div', { className: 'result' });
  var shareResult = el('div', { className: 'result' });
  var photoResult = el('div', { className: 'result' });
  var photoList = el('div', { className: 'photos' });
  var echoResult = el('div', { className: 'result' });
  var marksAtOpenResult = el('div', { className: 'result' });
  var markResult = el('div', { className: 'result' });
  var storageResult = el('div', { className: 'result' });
  var summaryText = el('textarea', { className: 'summary-text', readonly: true, 'aria-label': '結果のまとめ' });
  var copyResult = el('div', { className: 'result' });

  var pickInput = el('input', { type: 'file', accept: 'image/*', multiple: true, id: 'photo-pick', className: 'hidden-input' });
  var cameraInput = el('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    id: 'photo-camera',
    className: 'hidden-input',
  });
  pickInput.addEventListener('change', function () {
    handlePhotos(pickInput, '写真を選ぶ');
  });
  cameraInput.addEventListener('change', function () {
    handlePhotos(cameraInput, 'カメラで撮る');
  });

  // 写真の選ぶ画面に何が出たかは、画面からは分からないので、目で見てチェックしてもらう
  var chooserChecks = [
    ['camera', '「写真を選ぶ」で、写真を撮る（カメラ）が出た'],
    ['album', '「写真を選ぶ」で、アルバム（写真ライブラリ）が出た'],
    ['multiple', '「写真を選ぶ」で、2枚以上を一度に選べた'],
    ['cameraOnly', '「カメラで撮る」で、すぐにカメラが開いた'],
    ['upright', '縮めた写真の向きが正しい（横向き・逆さになっていない）'],
  ].map(function (item) {
    var box = el('input', { type: 'checkbox', id: 'check-' + item[0] });
    box.addEventListener('change', updateSummary);
    return { label: item[1], box: box };
  });

  root.appendChild(el('h1', { text: '疎通確認（' + channelLabel + '）' }));
  root.appendChild(
    card('1. 環境', '開いた場所（LINE の中か）と、OS・LINE のバージョンです。この回の番号は、記録の行の［］と同じです。', [envResult])
  );
  root.appendChild(
    card(
      '2. IDトークン',
      '本人の証明です。開いた時刻（発行）と期限（1時間後）が出ます。前に開いたときのトークンと比べて、新しくなったかも出ます。',
      [tokenResult]
    )
  );
  root.appendChild(
    card('3. GAS に送る', 'IDトークンを GAS に送り、LINE に確かめてもらって、名簿の結果を返してもらいます。', [
      button('GAS に送る（本人と名簿の確かめ）', 'primary', sendWhoami),
      gasResult,
    ])
  );
  root.appendChild(
    card(
      '4. 送り先を選ぶ画面',
      '送り先に自分（Keep メモなど）を選んで送ってください。トークに届いたかも見てください。やめたときの表示も確かめます。',
      [button('送り先を選んで、テストの文章を送る', 'primary', openShareTargetPicker), shareResult]
    )
  );
  root.appendChild(
    card(
      '5. 1時間たったトークン',
      '「2. IDトークン」の期限を過ぎてから（開いてから61分以上たってから）、「3. GAS に送る」を押してください。' +
        '期限切れと出たら、下の2つと、いったん閉じて開き直すことを1つずつ試し、そのたびに「3. GAS に送る」を押します。',
      [
        button('読み込み直す', 'secondary', function () {
          reloadAfterMark('読み込み直す', false);
        }),
        button('ログアウトして読み込み直す', 'secondary', function () {
          reloadAfterMark('ログアウトして読み込み直す', true);
        }),
      ]
    )
  );
  root.appendChild(
    card('6. 写真', '写真はこの端末の中で縮めるだけで、どこにも送りません。', [
      pickInput,
      cameraInput,
      el('label', { for: 'photo-pick', className: 'secondary', text: '写真を選ぶ（撮る・アルバム）' }),
      el('label', { for: 'photo-camera', className: 'secondary', text: 'カメラで撮る（カメラだけ）' }),
      photoResult,
      photoList,
      el(
        'div',
        { className: 'checks' },
        chooserChecks.map(function (check) {
          return el('label', null, [check.box, document.createTextNode(' ' + check.label)]);
        })
      ),
    ])
  );
  root.appendChild(
    card('7. 送る量（約1MB）', '写真ではない作り物のデータを送り、GAS が受け取った大きさを返してもらいます（どこにも残しません）。', [
      button('約1MBを GAS に送る', 'secondary', sendEcho),
      echoResult,
    ])
  );
  root.appendChild(
    card(
      '8. 端末に残したものが残るか',
      '「印を残す」を押すと、端末の中の2か所（localStorage と IndexedDB）に番号を残します。押してから、次の3つを1つずつ' +
        '試してください：「5」の「読み込み直す」、「5」の「ログアウトして読み込み直す」、右上の×で閉じてトークのリンクから' +
        '開き直す。開き直すと、下の「開いたときに読んだ印」に前の印が出ます。押したときと同じ番号なら、残っています。' +
        '「5」のボタンは、読み込み直す直前にも別の印（直前の印）を残します。',
      [
        el('h3', { text: '開いたときに読んだ印' }),
        marksAtOpenResult,
        button('印を残す', 'primary', function () {
          show(markResult, '印を残しています…', true);
          leaveMark(PROBE_MARK_KEY, '印を残す').then(function (left) {
            var text = '印 ' + left.mark.code + ' を残した（' + leftText(left) + '）';
            show(markResult, text, left.ls.ok && left.idb.ok);
            appendLog(text);
          });
        }),
        markResult,
        el('h3', { text: 'この回の、端末の記録の問題' }),
        storageResult,
      ]
    )
  );
  root.appendChild(
    card('9. 結果のまとめ', 'コピーして、開発者に送ってください（LINE のユーザーIDや名前は入っていません）。', [
      summaryText,
      button('結果をコピー', 'primary', copySummary),
      button('これまでの記録を消す', 'secondary', function () {
        save(PROBE_LOG_KEY, []);
        writtenHere = [];
        updateSummary();
      }),
      copyResult,
    ])
  );
  showStorageNotes();
  window.addEventListener('storage', function (event) {
    // 同じ端末で開いている別の画面が、端末の記録を書き換えたときだけ届く
    if (event.key === null || String(event.key).indexOf('probe-') === 0) {
      noteStorage((event.key || 'すべて') + '：ほかの画面（同じ端末で開いている別の疎通確認の画面）が書き換えた');
    }
  });
  readMarksAtOpen();

  // ============================================================
  // 1・2. LINE の中で開き、IDトークンを読む
  // ============================================================

  var liffId = window.PROBE_CONFIG && PROBE_CONFIG.liffIds[channel];
  if (!liffId || !PROBE_CONFIG.gasUrl) {
    env = 'config.js に、LIFF ID か GAS の URL がまだ入っていません。';
    showEnv(false);
    updateSummary();
    return;
  }
  if (typeof liff === 'undefined') {
    env = 'LIFF の部品（SDK）を読み込めませんでした。';
    showEnv(false);
    updateSummary();
    return;
  }

  liff
    .init({ liffId: liffId })
    .then(function () {
      var inClient = liff.isInClient();
      var context = liff.getContext() || {};
      env =
        channelLabel + '／LINE の中：' + (inClient ? 'はい' : 'いいえ') + '／' + liff.getOS() +
        '／LINE ' + (liff.getLineVersion() || '（不明）') + '／LIFF ' + liff.getVersion() +
        '／開いた場所：' + (context.type || '不明') +
        '／送り先を選ぶ画面：' + (liff.isApiAvailable('shareTargetPicker') ? '使える' : '使えない');
      showEnv(inClient);
      if (!inClient && !liff.isLoggedIn()) {
        show(tokenResult, 'LINE の外で開いています。LINE のトークからリンクを開いてください。', false);
        updateSummary();
        return;
      }
      readToken();
      setInterval(showToken, 15000); // 期限までの残りを出し直す
    })
    .catch(function (err) {
      env = channelLabel + '／LIFF を始められなかった：' + errorText(err);
      showEnv(false);
      updateSummary();
    });

  function showEnv(ok) {
    show(envResult, env + '\nこの回の番号：［' + pageCode + '］', ok);
  }

  function readToken() {
    var decoded = liff.getDecodedIDToken();
    var raw = liff.getIDToken();
    if (!raw || !decoded) {
      show(tokenResult, 'IDトークンを読めませんでした。', false);
      updateSummary();
      return;
    }
    token = { raw: raw, aud: decoded.aud, iat: decoded.iat, exp: decoded.exp };
    var last = load(PROBE_LAST_TOKEN_KEY);
    if (!last) tokenNote = '前に開いた記録なし';
    else if (last.iat === token.iat) tokenNote = '前に開いたとき（発行 ' + clock(last.iat) + '）と同じトークン';
    else tokenNote = '前に開いたとき（発行 ' + clock(last.iat) + '）から新しくなった';
    save(PROBE_LAST_TOKEN_KEY, { iat: token.iat, channel: channel });
    appendLog('開いた：トークンの発行 ' + clock(token.iat) + '・期限 ' + clock(token.exp) + '（' + tokenNote + '）');
    showToken();
  }

  function showToken() {
    if (!token) return;
    var left = Math.round((token.exp * 1000 - Date.now()) / 60000);
    show(
      tokenResult,
      'あて先のチャネル：' + token.aud + '\n発行：' + clock(token.iat) + '　期限：' + clock(token.exp) + '（' +
        (left > 0 ? 'あと約' + left + '分' : '期限切れ・' + -left + '分前') + '）\n' + tokenNote,
      left > 0
    );
    updateSummary();
  }

  // ============================================================
  // 3・7. GAS に送る（text/plain。GAS は事前の問い合わせ（OPTIONS）に答えられないため）
  // ============================================================

  function postToGas(body) {
    var started = Date.now();
    return fetch(PROBE_CONFIG.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.text().then(function (text) {
        var json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          json = null;
        }
        return {
          status: response.status,
          seconds: ((Date.now() - started) / 1000).toFixed(1),
          json: json,
          text: text,
        };
      });
    });
  }

  function sendWhoami() {
    if (!token) return show(gasResult, 'IDトークンがありません（上の「2」を見てください）。', false);
    var expiredAtSend = token.exp * 1000 <= Date.now();
    show(gasResult, '送っています…', true);
    postToGas({ action: 'whoami', idToken: token.raw })
      .then(function (r) {
        var line = 'HTTP ' + r.status + '・' + r.seconds + '秒・トークンは' + (expiredAtSend ? '期限切れ' : '期限内') + '・';
        if (!r.json) line += '返事を JSON として読めなかった（' + r.text.slice(0, 80) + '）';
        else if (r.json.ok) line += '名簿：' + rosterText(r.json.roster);
        else line += '断られた：' + r.json.error + '（' + r.json.message + '）';
        show(gasResult, line, Boolean(r.json && r.json.ok));
        appendLog('GAS：' + line);
      })
      .catch(function (err) {
        var line = '送れなかった、または返事を読めなかった（' + errorText(err) + '）';
        show(gasResult, line, false);
        appendLog('GAS：' + line);
      });
  }

  function rosterText(roster) {
    if (!roster || roster.length === 0) return '名簿にない';
    return roster
      .map(function (row) {
        return row.store + '・' + row.status;
      })
      .join('、');
  }

  function sendEcho() {
    if (!token) return show(echoResult, 'IDトークンがありません（上の「2」を見てください）。', false);
    show(echoResult, '送っています…', true);
    var data = new Array(PROBE_ECHO_LENGTH + 1).join('x');
    postToGas({ action: 'echoSize', idToken: token.raw, data: data })
      .then(function (r) {
        var ok = Boolean(r.json && r.json.ok && r.json.receivedLength === PROBE_ECHO_LENGTH);
        var line =
          'HTTP ' + r.status + '・' + r.seconds + '秒・' +
          (r.json && r.json.ok
            ? 'GAS が受け取った ' + r.json.receivedLength + ' 文字（送った ' + PROBE_ECHO_LENGTH + ' 文字）'
            : r.json
              ? '断られた：' + r.json.error + '（' + r.json.message + '）'
              : '返事を JSON として読めなかった');
        show(echoResult, line, ok);
        appendLog('送る量：' + line);
      })
      .catch(function (err) {
        var line = '送れなかった（' + errorText(err) + '）';
        show(echoResult, line, false);
        appendLog('送る量：' + line);
      });
  }

  // ============================================================
  // 4. 送り先を選ぶ画面（シェアターゲットピッカー）
  // ============================================================

  function openShareTargetPicker() {
    if (typeof liff === 'undefined' || !liff.isApiAvailable('shareTargetPicker')) {
      var unavailable = 'この LINE では使えない（isApiAvailable が false）';
      show(shareResult, unavailable, false);
      appendLog('送り先を選ぶ画面：' + unavailable);
      return;
    }
    var message = '疎通確認のテストです（送り先を選ぶ画面から送りました。' + clock(Date.now() / 1000) + '）';
    // 返事を受け取ったあとに alert() を使うと、端末によっては動かなくなるので使わない（LINE の説明による）
    liff
      .shareTargetPicker([{ type: 'text', text: message }], { isMultiple: false })
      .then(function (res) {
        var sent = Boolean(res && res.status === 'success');
        var line = sent ? '送った（status: success）' : '送らなかった（やめた）';
        show(shareResult, sent ? line + '。トークに届いたかも見てください。' : line, sent);
        appendLog('送り先を選ぶ画面：' + line);
      })
      .catch(function (err) {
        var line = 'エラー：' + errorText(err);
        show(shareResult, line, false);
        appendLog('送り先を選ぶ画面：' + line);
      });
  }

  // ============================================================
  // 6. 写真（縮めて JPEG に作り直すだけ。どこにも送らない）
  // ============================================================

  function handlePhotos(input, how) {
    var files = Array.prototype.slice.call(input.files || []);
    input.value = ''; // 同じ写真をもう一度選んでも、変わったことが分かるように
    shownPhotoUrls.forEach(function (url) {
      URL.revokeObjectURL(url);
    });
    shownPhotoUrls = [];
    photoList.textContent = '';
    if (files.length === 0) {
      show(photoResult, how + '：選ばなかった', false);
      return;
    }
    show(photoResult, how + '：' + files.length + '枚を縮めています…', true);
    var lines = [];
    files
      .reduce(function (previous, file, index) {
        return previous.then(function () {
          return shrinkPhoto(file).then(
            function (r) {
              var url = URL.createObjectURL(r.blob);
              shownPhotoUrls.push(url);
              photoList.appendChild(
                el('figure', null, [
                  el('img', { src: url, alt: index + 1 + '枚目（縮めたもの）' }),
                  el('figcaption', { text: r.outWidth + '×' + r.outHeight + '・' + kb(r.blob.size) }),
                ])
              );
              lines.push(
                index + 1 + '枚目：' + (file.type || '種類不明') + ' ' + kb(file.size) + '（' + r.inWidth + '×' + r.inHeight +
                  '）→ JPEG ' + kb(r.blob.size) + '（' + r.outWidth + '×' + r.outHeight + '）・' + r.ms + 'ミリ秒'
              );
            },
            function (err) {
              lines.push(index + 1 + '枚目：' + (file.type || '種類不明') + ' ' + kb(file.size) + '・縮められなかった（' + errorText(err) + '）');
            }
          );
        });
      }, Promise.resolve())
      .then(function () {
        var text = how + '：' + files.length + '枚\n' + lines.join('\n');
        show(photoResult, text, true);
        appendLog('写真：' + text.replace(/\n/g, ' ／ '));
      });
  }

  function shrinkPhoto(file) {
    var started = Date.now();
    return loadImage(file).then(function (img) {
      var width = img.naturalWidth;
      var height = img.naturalHeight;
      var scale = Math.min(1, PROBE_PHOTO_LONG_SIDE / Math.max(width, height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(
          function (blob) {
            if (!blob) return reject(new Error('JPEG に作り直せなかった'));
            resolve({
              blob: blob,
              inWidth: width,
              inHeight: height,
              outWidth: canvas.width,
              outHeight: canvas.height,
              ms: Date.now() - started,
            });
          },
          'image/jpeg',
          PROBE_PHOTO_QUALITY
        );
      });
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('読み込めない形式'));
      };
      img.src = url;
    });
  }

  // ============================================================
  // 8. 端末に残したものが残るか（印を残し、開き直したときに読む）
  // ============================================================

  /** 端末の記録（localStorage）から読む。読めなかったら、理由を「この回の問題」に残す。 */
  function load(key) {
    var result = readJson(localStore(), key);
    if (result.problem) noteStorage(key + '（localStorage）を読むとき：' + result.problem);
    return result.value;
  }

  /** 端末の記録（localStorage）に書き、読み直して確かめる。だめなら、理由を「この回の問題」に残す。 */
  function save(key, value) {
    var result = writeJson(localStore(), key, value);
    if (!result.ok) noteStorage(key + '（localStorage）に書くとき：' + result.problem);
    return result;
  }

  /** 端末の記録の問題を覚えておく（同じ問題は回数だけ数える）。まとめは、次に作り直すときに入る。 */
  function noteStorage(text) {
    var same = storageNotes.filter(function (note) {
      return note.text === text;
    })[0];
    if (same) same.count++;
    else storageNotes.push({ text: text, first: clock(Date.now() / 1000), count: 1 });
    showStorageNotes();
  }

  function storageNoteLines() {
    return storageNotes.map(function (note) {
      return note.first + ' ' + note.text + (note.count > 1 ? '（' + note.count + '回）' : '');
    });
  }

  function showStorageNotes() {
    var lines = storageNoteLines();
    show(storageResult, lines.length ? lines.join('\n') : 'なし', lines.length === 0);
  }

  /** 印を、localStorage と IndexedDB の両方に残す（どちらも、書いたあとに読み直して確かめる）。 */
  function leaveMark(key, how) {
    var mark = { code: newCode(4, Math.random), at: Math.floor(Date.now() / 1000), page: pageCode, how: how };
    var ls = save(key, mark);
    return idbWrite(key, mark).then(function (idb) {
      if (!idb.ok) noteStorage(key + '（IndexedDB）に書くとき：' + idb.problem);
      return { mark: mark, ls: ls, idb: idb };
    });
  }

  function leftText(left) {
    return (
      'localStorage：' + (left.ls.ok ? '書けた' : left.ls.problem) +
      '／IndexedDB：' + (left.idb.ok ? '書けた' : left.idb.problem)
    );
  }

  /** 直前の印を残してから、読み込み直す（logout なら、先にログアウトする）。label はボタンの名前。 */
  function reloadAfterMark(label, logout) {
    leaveMark(PROBE_MARK_BEFORE_KEY, label + 'の直前').then(function (left) {
      appendLog('「' + label + '」を押した（直前の印 ' + left.mark.code + '。' + leftText(left) + '）');
      if (logout) {
        try {
          liff.logout();
        } catch (err) {
          appendLog('ログアウトでエラー：' + errorText(err));
        }
      }
      window.location.reload();
    });
  }

  /** 開いたとき（LIFF を始める前）に、前に残した印を2か所から読んで出す。 */
  function readMarksAtOpen() {
    show(marksAtOpenResult, '読んでいます…', true);
    var keys = [
      [PROBE_MARK_KEY, '「印を残す」の印'],
      [PROBE_MARK_BEFORE_KEY, '直前の印'],
    ];
    Promise.all(
      keys.map(function (item) {
        var ls = load(item[0]);
        return idbRead(item[0]).then(function (idb) {
          if (idb.problem) noteStorage(item[0] + '（IndexedDB）を読むとき：' + idb.problem);
          var lsText = markText(ls);
          var idbText = idb.problem ? '読めなかった' : markText(idb.value);
          var same = lsText === idbText;
          return {
            ok: same,
            text: item[1] + '：localStorage ' + lsText + '／IndexedDB ' + (same ? 'も同じ' : idbText),
          };
        });
      })
    ).then(function (rows) {
      var text = rows
        .map(function (row) {
          return row.text;
        })
        .join('\n');
      show(
        marksAtOpenResult,
        text,
        rows.every(function (row) {
          return row.ok;
        })
      );
      appendLog('開いたときに読んだ印：' + text.replace(/\n/g, ' ／ '));
    });
  }

  // ============================================================
  // 9. 結果のまとめ（端末の中に残し、読み込み直し・開き直しをまたいで並べる）
  // ============================================================

  function appendLog(text) {
    var line = logLine(Date.now() / 1000, channelLabel, pageCode, text);
    var stored = load(PROBE_LOG_KEY);
    var log = Array.isArray(stored) ? stored : [];
    log.push(line);
    writtenHere.push(line);
    save(PROBE_LOG_KEY, log.slice(-PROBE_LOG_MAX));
    updateSummary();
  }

  function updateSummary() {
    var checks = chooserChecks.map(function (check) {
      return (check.box.checked ? '☑ ' : '☐ ') + check.label;
    });
    var stored = load(PROBE_LOG_KEY);
    var log = Array.isArray(stored) ? stored : [];
    var kept = missingLines(writtenHere, log, PROBE_LOG_MAX);
    var keptLines;
    if (!kept.checked) {
      keptLines = ['記録が上限（' + PROBE_LOG_MAX + '行）に達しているので、調べていない（「これまでの記録を消す」を押してから試してください）'];
    } else if (kept.missing.length === 0) {
      keptLines = ['この回で書いた ' + writtenHere.length + ' 行は、すべて端末の記録にあった'];
    } else {
      keptLines = ['この回で書いたのに、端末の記録にない行が ' + kept.missing.length + ' 行ある：'].concat(kept.missing);
    }
    var notes = storageNoteLines();
    summaryText.value = ['疎通確認のまとめ', '環境：' + env, 'この回の番号：［' + pageCode + '］']
      .concat(checks)
      .concat(['これまでの記録：'])
      .concat(log.length ? log : ['（なし）'])
      .concat(['この回で書いた行の確かめ：'])
      .concat(keptLines)
      .concat(['この回の、端末の記録の問題：'])
      .concat(notes.length ? notes : ['なし'])
      .join('\n');
  }

  function copySummary() {
    updateSummary();
    var done = function (ok) {
      show(copyResult, ok ? 'コピーしました。' : 'コピーできませんでした。上の枠を長押しして、すべて選択してコピーしてください。', ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(summaryText.value).then(
        function () {
          done(true);
        },
        function () {
          done(fallbackCopy());
        }
      );
    } else {
      done(fallbackCopy());
    }
  }

  function fallbackCopy() {
    summaryText.focus();
    summaryText.select();
    try {
      return document.execCommand('copy');
    } catch (err) {
      return false;
    }
  }

  updateSummary();
}

// ============================================================
// 小さな道具
// ============================================================

function card(title, help, children) {
  return el('section', { className: 'card' }, [el('h2', { text: title }), el('p', { className: 'help', text: help })].concat(children));
}

function button(text, className, onClick) {
  return el('button', { type: 'button', className: className, text: text, onclick: onClick });
}

/** 結果を出す。ok なら緑、そうでなければ赤。 */
function show(node, text, ok) {
  node.textContent = text;
  node.className = 'result ' + (ok ? 'ok' : 'ng');
}

function errorText(err) {
  if (!err) return '不明';
  return (err.code ? err.code + ' ' : '') + (err.message || String(err));
}

function kb(bytes) {
  return Math.round(bytes / 1024) + 'KB';
}

/** 秒の時刻を「13:05:10」にする（端末の時刻で）。 */
function clock(seconds) {
  var d = new Date(seconds * 1000);
  return d.getHours() + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function dateTime(seconds) {
  var d = new Date(seconds * 1000);
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + clock(seconds);
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// ============================================================
// 端末の中の記録（localStorage）。使えない環境でも画面は動くようにし、書けなかった・読めなかった理由は捨てずに返す
// ============================================================

/** 端末の記録。開くこと自体がエラーになる環境では、読み書きのたびに同じエラーを出すものを返す（理由を残すため）。 */
function localStore() {
  try {
    return window.localStorage;
  } catch (err) {
    var fail = function () {
      throw err;
    };
    return { getItem: fail, setItem: fail };
  }
}

/** 読む。{ value, problem }。まだ何もなければ、value は null で problem は空。 */
function readJson(storage, key) {
  if (!storage) return { value: null, problem: '端末の記録（localStorage）がない' };
  var text;
  try {
    text = storage.getItem(key);
  } catch (err) {
    return { value: null, problem: '読めなかった（' + storageErrorText(err) + '）' };
  }
  if (text === null || text === undefined) return { value: null, problem: '' };
  try {
    return { value: JSON.parse(text), problem: '' };
  } catch (err) {
    return { value: null, problem: '中身の形が壊れていた' };
  }
}

/** 書いて、読み直して同じか確かめる。{ ok, problem } */
function writeJson(storage, key, value) {
  if (!storage) return { ok: false, problem: '端末の記録（localStorage）がない' };
  var text = JSON.stringify(value);
  try {
    storage.setItem(key, text);
  } catch (err) {
    return { ok: false, problem: '書けなかった（' + storageErrorText(err) + '）' };
  }
  var back;
  try {
    back = storage.getItem(key);
  } catch (err) {
    return { ok: false, problem: '書いたあとに読み直せなかった（' + storageErrorText(err) + '）' };
  }
  if (back !== text) return { ok: false, problem: '書いたあとに読み直すと、中身が違った' + (back === null ? '（なかった）' : '') };
  return { ok: true, problem: '' };
}

/** エラーの名前（と短い説明）。 */
function storageErrorText(err) {
  if (!err) return '不明';
  var name = err.name || 'Error';
  return err.message ? name + '：' + String(err.message).slice(0, 80) : name;
}

/**
 * この回で書いた行（written）のうち、端末の記録（stored）にないものを、書いた順に返す。
 * 記録が上限の行数に達していたら、古い行を消しているので調べない（checked: false）。
 */
function missingLines(written, stored, max) {
  var kept = Array.isArray(stored) ? stored : [];
  if (kept.length >= max) return { checked: false, missing: [] };
  return {
    checked: true,
    missing: written.filter(function (line) {
      return kept.indexOf(line) === -1;
    }),
  };
}

/** 記録の1行。例：「10/7 18:55:30 開発用［Q2M］　開いた」（［］は、この回の番号） */
function logLine(seconds, channelLabel, pageCode, text) {
  return dateTime(seconds) + ' ' + channelLabel + '［' + pageCode + '］　' + text;
}

/** 番号を作る（random は 0 以上 1 未満を返す関数）。 */
function newCode(length, random) {
  var code = '';
  for (var i = 0; i < length; i++) {
    code += PROBE_CODE_LETTERS.charAt(Math.floor(random() * PROBE_CODE_LETTERS.length));
  }
  return code;
}

/** 印を文字にする。例：「K4P7（10/7 18:55:40・［Q2M］の回・印を残す）」。印でなければ「なし」。 */
function markText(mark) {
  if (!mark || typeof mark.code !== 'string') return 'なし';
  return mark.code + '（' + dateTime(mark.at) + '・［' + mark.page + '］の回' + (mark.how ? '・' + mark.how : '') + '）';
}

// ============================================================
// 端末の中のもう1つの置き場所（IndexedDB）。印だけを置き、localStorage と比べる。
// 失敗しても止まらず、理由を返す（{ ok, problem } や { value, problem }）
// ============================================================

function idbWrite(key, value) {
  return idbRun('readwrite', function (store) {
    store.put(value, key);
  }).then(function (done) {
    if (done.problem) return { ok: false, problem: '書けなかった（' + done.problem + '）' };
    return idbRead(key).then(function (back) {
      if (back.problem) return { ok: false, problem: '書いたあとに読み直せなかった（' + back.problem + '）' };
      if (JSON.stringify(back.value) !== JSON.stringify(value)) {
        return { ok: false, problem: '書いたあとに読み直すと、中身が違った' };
      }
      return { ok: true, problem: '' };
    });
  });
}

function idbRead(key) {
  var request = null;
  return idbRun('readonly', function (store) {
    request = store.get(key);
  }).then(function (done) {
    if (done.problem) return { value: null, problem: done.problem };
    return { value: request.result === undefined ? null : request.result, problem: '' };
  });
}

/** IndexedDB を開いて、1つの読み書きを行う。終わったら（失敗しても）閉じる。待っても返事がなければ、あきらめる。 */
function idbRun(mode, work) {
  return new Promise(function (resolve) {
    var finished = false;
    var db = null;
    var timer = null;
    var finish = function (problem) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      closeDb();
      resolve({ problem: problem });
    };
    var closeDb = function () {
      try {
        if (db) db.close();
      } catch (err) {
        // 閉じられなくても、結果は変わらない
      }
    };
    timer = setTimeout(function () {
      finish(PROBE_IDB_WAIT_MS / 1000 + '秒待っても返事がない');
    }, PROBE_IDB_WAIT_MS);
    try {
      var factory = window.indexedDB;
      if (!factory) return finish('IndexedDB がない');
      var open = factory.open(PROBE_IDB_NAME, 1);
      open.onupgradeneeded = function () {
        open.result.createObjectStore(PROBE_IDB_STORE);
      };
      open.onblocked = function () {
        finish('開けない（blocked）');
      };
      open.onerror = function () {
        finish('開けない（' + storageErrorText(open.error) + '）');
      };
      open.onsuccess = function () {
        db = open.result;
        if (finished) return closeDb(); // 待つのをあきらめたあとに開けた
        try {
          var tx = db.transaction(PROBE_IDB_STORE, mode);
          tx.oncomplete = function () {
            finish('');
          };
          tx.onerror = function () {
            finish(storageErrorText(tx.error));
          };
          tx.onabort = function () {
            finish(tx.error ? storageErrorText(tx.error) : '取り消された');
          };
          work(tx.objectStore(PROBE_IDB_STORE));
        } catch (err) {
          finish(storageErrorText(err));
        }
      };
    } catch (err) {
      finish(storageErrorText(err));
    }
  });
}

/** 部品を作る。文字は textContent で入れる（HTML として扱わない）。 */
function el(tag, props, children) {
  var node = document.createElement(tag);
  Object.keys(props || {}).forEach(function (key) {
    var v = props[key];
    if (v === null || v === undefined || v === false) return;
    if (key === 'text') node.textContent = v;
    else if (key === 'className') node.className = v;
    else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), v);
    else node.setAttribute(key, v === true ? '' : v);
  });
  (children || []).forEach(function (child) {
    if (child) node.appendChild(child);
  });
  return node;
}

// Node.js のテスト（test/probe.test.js）から、端末の記録を扱う部分を読めるようにする
if (typeof module !== 'undefined') {
  module.exports = {
    readJson: readJson,
    writeJson: writeJson,
    missingLines: missingLines,
    logLine: logLine,
    newCode: newCode,
    markText: markText,
  };
}
