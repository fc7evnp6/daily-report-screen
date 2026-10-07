// 段階2の疎通確認の画面（開発者だけが使う）。LINE ミニアプリの中で開き、次をボタンで1つずつ試す。
//   ・LINE の中で開けるか、IDトークン → GAS で確かめる → 名簿の結果（text/plain で送り、返事を読めるか）
//   ・送り先を選ぶ画面（シェアターゲットピッカー）で、自分に送れるか
//   ・1時間たった IDトークンの扱い（期限切れになるか、読み込み直し・開き直しで新しくなるか）
//   ・写真を撮る・アルバムから選ぶ・複数選ぶ、縮めて JPEG に作り直す（写真はどこにも送らない）
//   ・約1MBの送信が GAS に届くか（写真ではない作り物のデータ。GAS は大きさを返すだけ）
// 結果は「結果のまとめ」に集め、コピーして伝える。LINE のユーザーIDや名前は、画面にもまとめにも出さない。
// 読み込み直しや開き直しをまたいで比べるため、記録は端末の中（localStorage）にだけ残す。
//
// ■ このファイルは公開される。秘密の情報や本物のデータは書かない（GAS の URL と LIFF ID は config.js に書く）。

var PROBE_PHOTO_LONG_SIDE = 2000; // 縮めたあとの長い辺（ピクセル）。入力画面の計画と同じ
var PROBE_PHOTO_QUALITY = 0.7; // JPEG の画質
var PROBE_ECHO_LENGTH = 1000000; // 送る量の確かめ（約1MB）
var PROBE_LOG_KEY = 'probe-log'; // これまでの記録（端末の中だけ）
var PROBE_LAST_TOKEN_KEY = 'probe-last-token'; // 前に開いたときの IDトークンの発行時刻
var PROBE_LOG_MAX = 80;

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
    card('1. 環境', '開いた場所（LINE の中か）と、OS・LINE のバージョンです。', [envResult])
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
          appendLog('読み込み直した');
          window.location.reload();
        }),
        button('ログアウトして読み込み直す', 'secondary', function () {
          appendLog('ログアウトして読み込み直した');
          try {
            liff.logout();
          } catch (err) {
            appendLog('ログアウトでエラー：' + errorText(err));
          }
          window.location.reload();
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
    card('8. 結果のまとめ', 'コピーして、開発者に送ってください（LINE のユーザーIDや名前は入っていません）。', [
      summaryText,
      button('結果をコピー', 'primary', copySummary),
      button('これまでの記録を消す', 'secondary', function () {
        saveLog([]);
        updateSummary();
      }),
      copyResult,
    ])
  );

  // ============================================================
  // 1・2. LINE の中で開き、IDトークンを読む
  // ============================================================

  var liffId = window.PROBE_CONFIG && PROBE_CONFIG.liffIds[channel];
  if (!liffId || !PROBE_CONFIG.gasUrl) {
    show(envResult, 'config.js に、LIFF ID か GAS の URL がまだ入っていません。', false);
    updateSummary();
    return;
  }
  if (typeof liff === 'undefined') {
    show(envResult, 'LIFF の部品（SDK）を読み込めませんでした。', false);
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
      show(envResult, env, inClient);
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
      show(envResult, env, false);
      updateSummary();
    });

  function readToken() {
    var decoded = liff.getDecodedIDToken();
    var raw = liff.getIDToken();
    if (!raw || !decoded) {
      show(tokenResult, 'IDトークンを読めませんでした。', false);
      updateSummary();
      return;
    }
    token = { raw: raw, aud: decoded.aud, iat: decoded.iat, exp: decoded.exp };
    var last = loadJson(PROBE_LAST_TOKEN_KEY);
    if (!last) tokenNote = '前に開いた記録なし';
    else if (last.iat === token.iat) tokenNote = '前に開いたとき（発行 ' + clock(last.iat) + '）と同じトークン';
    else tokenNote = '前に開いたとき（発行 ' + clock(last.iat) + '）から新しくなった';
    saveJson(PROBE_LAST_TOKEN_KEY, { iat: token.iat, channel: channel });
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
  // 8. 結果のまとめ（端末の中に残し、読み込み直し・開き直しをまたいで並べる）
  // ============================================================

  function appendLog(text) {
    var log = loadJson(PROBE_LOG_KEY) || [];
    log.push(dateTime(Date.now() / 1000) + ' ' + channelLabel + '　' + text);
    saveLog(log.slice(-PROBE_LOG_MAX));
    updateSummary();
  }

  function saveLog(log) {
    saveJson(PROBE_LOG_KEY, log);
  }

  function updateSummary() {
    var checks = chooserChecks.map(function (check) {
      return (check.box.checked ? '☑ ' : '☐ ') + check.label;
    });
    summaryText.value = ['疎通確認のまとめ', '環境：' + env]
      .concat(checks)
      .concat(['これまでの記録：'])
      .concat(loadJson(PROBE_LOG_KEY) || ['（なし）'])
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

// 端末の中の記録。使えない環境（読み込めない・書けない）でも、画面は動くようにする
function loadJson(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key));
  } catch (err) {
    return null;
  }
}

function saveJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // 残せなくても、この画面の中の確かめはできる
  }
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
