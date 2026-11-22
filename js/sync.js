/* 多人同步：基于 ntfy.sh 的公开话题（append-only 操作日志）
 *
 * 为什么用 fetch 流而不是 EventSource：
 *   ntfy 的 /json 流返回 Content-Type: application/x-ndjson，
 *   EventSource 只接受 text/event-stream，会直接报错断开，所以自己读 chunk。
 *
 * 发布：POST https://ntfy.sh/<topic>   body 是一条 JSON 操作
 * 订阅：GET  https://ntfy.sh/<topic>/json?since=<id>  逐行推送
 * 免注册、CORS 放行(*)、消息保留 12 小时。
 * 话题是公开的：知道房间码的人都能读写，家庭内部够用，别放敏感信息。
 */
window.CookSync = (function () {
  'use strict';

  var BASE = 'https://ntfy.sh/';
  var topic = null;
  var status = 'off';
  var seen = {};
  var lastId = null;
  var onOps = null;
  var onStatus = null;
  var ctrl = null;
  var streamGen = 0;        // 用来淘汰过期的流
  var fails = 0;
  var reconnectTimer = null;
  var pollTimer = null;

  function setStatus(s) {
    if (status === s) return;
    status = s;
    if (onStatus) onStatus(s);
  }

  function handleLine(line) {
    if (!line || !line.trim()) return;
    var o = null;
    try { o = JSON.parse(line); } catch (e) { return; }
    if (o.id) lastId = o.id;
    if (o.event !== 'message' || !o.message) return;
    if (seen[o.id]) return;
    seen[o.id] = 1;
    var op = null;
    try { op = JSON.parse(o.message); } catch (e) { return; }
    if (onOps) onOps([op], false);
  }

  function stopStream() {
    streamGen++;
    if (ctrl) { try { ctrl.abort(); } catch (e) { } ctrl = null; }
  }

  function startStream(since) {
    stopStream();
    var gen = streamGen;
    ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var url = BASE + topic + '/json?since=' + encodeURIComponent(since || 'all');

    fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (res) {
        if (gen !== streamGen) return;
        if (!res.ok || !res.body) throw new Error('bad stream');
        setStatus('on');
        fails = 0;
        stopPolling();
        var reader = res.body.getReader();
        var dec = (typeof TextDecoder !== 'undefined') ? new TextDecoder() : null;
        var buf = '';

        function pump() {
          reader.read().then(function (r) {
            if (gen !== streamGen) return;
            if (r.done) { onStreamEnd(); return; }
            buf += dec ? dec.decode(r.value, { stream: true }) : String.fromCharCode.apply(null, r.value);
            var idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              handleLine(buf.slice(0, idx));
              buf = buf.slice(idx + 1);
            }
            pump();
          }).catch(function () { if (gen === streamGen) onStreamEnd(); });
        }
        pump();
      })
      .catch(function () {
        if (gen !== streamGen) return;
        onStreamEnd();
      });
  }

  function onStreamEnd() {
    if (!topic) return;
    setStatus('retry');
    fails++;
    if (fails >= 2) startPolling();          // 流不通就退回轮询
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () {
      if (topic) startStream(lastId || 'all');
    }, Math.min(1000 * fails, 8000));
  }

  function pollOnce() {
    if (!topic) return;
    fetch(BASE + topic + '/json?poll=1&since=' + encodeURIComponent(lastId || 'all'), { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        txt.split('\n').forEach(handleLine);
        if (status !== 'on') setStatus('on');
      })
      .catch(function () { setStatus('error'); });
  }

  function startPolling() {
    if (pollTimer) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, 6000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function connect(code, handlers) {
    disconnect();
    topic = 'todayeat-' + String(code).toLowerCase();
    seen = {};
    lastId = null;
    fails = 0;
    onOps = handlers.ops;
    onStatus = handlers.status;
    setStatus('connecting');

    // 先拉全量历史，重建状态；再从 all 开流（靠 id 去重）
    fetch(BASE + topic + '/json?poll=1&since=all', { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var ops = [];
        txt.split('\n').forEach(function (line) {
          if (!line.trim()) return;
          var o = null;
          try { o = JSON.parse(line); } catch (e) { return; }
          if (o.id) lastId = o.id;
          if (o.event !== 'message' || !o.message) return;
          seen[o.id] = 1;
          try { ops.push(JSON.parse(o.message)); } catch (e) { }
        });
        if (onOps) onOps(ops, true);
        startStream(lastId || 'all');
      })
      .catch(function () {
        setStatus('error');
        startPolling();
      });
  }

  function send(op) {
    if (!topic) return;
    fetch(BASE + topic, {
      method: 'POST',
      body: JSON.stringify(op),
      headers: { 'Content-Type': 'text/plain' },
      keepalive: true
    }).catch(function () { setStatus('error'); });
  }

  function disconnect() {
    stopStream();
    stopPolling();
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    topic = null;
    setStatus('off');
  }

  // 手机回到前台时，连接可能已经死了，主动重连一次
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && topic && status !== 'on') {
        startStream(lastId || 'all');
      }
    });
  }

  return {
    connect: connect,
    send: send,
    disconnect: disconnect,
    status: function () { return status; }
  };
})();
