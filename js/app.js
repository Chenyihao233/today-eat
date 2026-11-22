/* 应用层：视图渲染 + 交互 + 本地存储 */
(function () {
  'use strict';

  var DATA = window.COOK_DATA;
  var C = window.CookCore;
  var DISHES = DATA.dishes;
  var CATS = DATA.categories;
  var byId = {};
  DISHES.forEach(function (d) { byId[d.id] = d; });

  var KEY = 'today-eat.v1';
  var SLOTS = ['早餐', '午餐', '晚餐', '宵夜'];
  var DAYS = ['今天', '明天', '后天'];

  /* ---------- 状态 ---------- */
  var state = load();
  var ui = {
    tab: 'draw',
    drawCat: '全部',
    drawDish: null,
    menuCat: '全部',
    menuQ: '',
    day: 0,
    slot: '晚餐',
    scroll: {}
  };

  function defaults() {
    return { cart: [], meal: null, checked: {}, history: [], recent: [] };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      var o = JSON.parse(raw);
      return Object.assign(defaults(), o || {});
    } catch (e) { return defaults(); }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式忽略 */ }
  }

  /* ---------- 同步：操作日志模型 ----------
   * 每条本地动作先变成一条 op：本地立刻应用（乐观更新），再发给房间；
   * 远端来的 op 按 opId 去重后在本地重放。所有人重放同一份日志 → 状态一致。
   */
  var CID = (function () {
    try {
      var v = localStorage.getItem('today-eat.cid');
      if (!v) {
        v = 'c' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('today-eat.cid', v);
      }
      return v;
    } catch (e) { return 'c' + Math.random().toString(36).slice(2, 8); }
  })();

  var room = null;          // 当前房间码
  var syncStatus = 'off';   // off | connecting | on | retry | error
  var opSeq = 0;
  var seenOp = {};
  var carryOver = null;     // 加入房间时把本地已点的菜带进去

  function uid() {
    return CID + '.' + (++opSeq) + '.' + Math.random().toString(36).slice(2, 6);
  }

  function applyOp(op) {
    if (!op || !op.t) return;
    var i, id;
    if (op.t === 'add') {
      id = op.id;
      var d = op.d || 1;
      var hit = null;
      for (i = 0; i < state.cart.length; i++) {
        if (state.cart[i].id === id) { hit = state.cart[i]; break; }
      }
      if (hit) {
        hit.qty = (hit.qty || 1) + d;
        if (hit.qty <= 0) state.cart = state.cart.filter(function (x) { return x.id !== id; });
      } else if (d > 0) {
        state.cart.push({ id: id, qty: d });
      }
      if (state.meal) state.meal = null;      // 又加菜了，回到「点菜中」
      state.recent.push(id);
      state.recent = state.recent.slice(-20);
    } else if (op.t === 'check') {
      if (op.v) state.checked[op.k] = true;
      else delete state.checked[op.k];
    } else if (op.t === 'lock') {
      state.history.unshift({ label: op.label, when: op.when, items: op.items || [] });
      state.history = state.history.slice(0, 30);
      state.meal = { label: op.label, items: op.items || [], at: op.at || Date.now() };
      state.cart = [];
      state.checked = {};
    } else if (op.t === 'clear') {
      state.meal = null;
    }
  }

  function dispatch(op) {
    op.cid = CID;
    op.opId = uid();
    op.ts = Date.now();
    seenOp[op.opId] = 1;
    applyOp(op);
    save();
    render();
    if (room) window.CookSync.send(op);
  }

  function onRemoteOps(ops, full) {
    if (full) {
      state = defaults();
      seenOp = {};
      (ops || []).forEach(function (op) {
        if (!op) return;
        if (op.opId) seenOp[op.opId] = 1;
        applyOp(op);
      });
      save();
      render();
      if (carryOver && carryOver.length) {
        var mine = carryOver;
        carryOver = null;
        mine.forEach(function (it) { dispatch({ t: 'add', id: it.id, d: it.qty || 1 }); });
      }
      return;
    }
    var changed = false;
    (ops || []).forEach(function (op) {
      if (!op || (op.opId && seenOp[op.opId])) return;
      if (op.opId) seenOp[op.opId] = 1;
      if (op.cid === CID) return;   // 自己发的已经乐观应用过
      applyOp(op);
      changed = true;
    });
    if (changed) { save(); render(); }
  }

  function onSyncStatus(s) {
    syncStatus = s;
    render();
  }

  function setRoom(code) {
    room = code || null;
    try { localStorage.setItem('today-eat.room', room || ''); } catch (e) { }
    if (room) window.CookSync.connect(room, { ops: onRemoteOps, status: onSyncStatus });
    else { window.CookSync.disconnect(); syncStatus = 'off'; }
  }

  function joinRoom(code, carry) {
    code = String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    if (code.length < 3) { toast('房间码至少 3 位'); return; }
    carryOver = carry ? state.cart.slice() : null;
    setRoom(code);
    closeSheet();
    toast('已加入房间 ' + code.toUpperCase());
    setTimeout(render, 60);
  }

  var SYNC_TEXT = { off: '未连接', connecting: '连接中…', on: '实时同步中', retry: '重连中…', error: '连接失败' };

  function syncButton() {
    if (!room) {
      return '<button class="sync-btn" data-act="open-room"><span class="dot off"></span>一起点菜</button>';
    }
    var cls = syncStatus === 'on' ? 'on' : (syncStatus === 'connecting' ? 'wait' : 'bad');
    return '<button class="sync-btn live" data-act="open-room"><span class="dot ' + cls + '"></span>' +
      esc(room.toUpperCase()) + '</button>';
  }

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function $(sel) { return document.querySelector(sel); }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) { }
  }

  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1600);
  }

  function poolFor(cat) {
    return cat === '全部' ? DISHES : DISHES.filter(function (d) { return d.cat === cat; });
  }

  function cartCount() {
    return state.cart.reduce(function (s, i) { return s + (i.qty || 1); }, 0);
  }

  function currentMealItems() {
    if (state.meal && state.meal.items && state.meal.items.length) return state.meal.items;
    return state.cart;
  }

  function nextDish(dir) {
    var pool = poolFor(ui.drawCat);
    var next = C.pickRandom(pool, state.recent, ui.drawDish ? ui.drawDish.id : null);
    if (!next) return;
    ui.drawDish = next;
    ui.dir = dir || 0;
    renderCard();
  }

  /* ---------- 视图 ---------- */
  function header(title, sub) {
    return '<header class="hd"><div class="hd-row"><h1>' + esc(title) + '</h1>' + syncButton() + '</div>' +
      '<p>' + esc(sub) + '</p></header>';
  }

  function chips(list, active, act) {
    return '<div class="chips">' + list.map(function (c) {
      var key = typeof c === 'string' ? c : c.key;
      var emoji = typeof c === 'string' ? '' : c.emoji + ' ';
      return '<button class="chip' + (key === active ? ' on' : '') + '" data-act="' + act + '" data-key="' + esc(key) + '">' +
        emoji + esc(key) + '</button>';
    }).join('') + '</div>';
  }

  /* 图片：大图 / 缩略图两档；加载失败就露出底下的 emoji，不会出现破图 */
  function photo(d, kind) {
    var src = kind === 'thumb'
      ? 'images/thumbs/' + d.id + '.webp'
      : 'images/dishes/' + d.id + '.webp';
    return '<img class="photo" src="' + src + '" alt="' + esc(d.name) + '" loading="lazy" ' +
      'onerror="this.classList.add(\'photo-broken\');this.removeAttribute(\'src\')">';
  }

  function fallbackEmoji(d, cls) {
    return '<i class="' + (cls || 'ph-emoji') + '">' + (d.e || '🍽️') + '</i>';
  }

  function cardHtml(d) {
    return '' +
      '<div class="card-top">' + fallbackEmoji(d, 'card-emoji') + photo(d, 'full') + '</div>' +
      '<div class="card-body">' +
      '<h2>' + esc(d.name) + '</h2>' +
      '<p class="card-desc">' + esc(d.desc) + '</p>' +
      '<div class="tags">' + (d.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
      (d.spicy ? '<span class="tag spicy">辣 ' + '🌶'.repeat(d.spicy) + '</span>' : '') + '</div>' +
      '<div class="card-ing">' + (d.ing || []).slice(0, 4).map(function (r) {
        return '<span>' + esc(r[1]) + ' <em>' + esc(r[2]) + '</em></span>';
      }).join('') + '</div>' +
      '</div>';
  }

  function viewDraw() {
    var d = ui.drawDish;
    if (!d) nextDish(0);
    d = ui.drawDish;
    return header('今天吃啥', '选不出来就抽一张，左右滑换一道') +
      chips(['全部'].concat(CATS.map(function (c) { return c; })), ui.drawCat, 'draw-cat') +
      '<div class="stage">' +
      '<div class="stack-ghost g2"></div><div class="stack-ghost g1"></div>' +
      '<div class="card" id="drawCard">' + (d ? cardHtml(d) : '') + '</div>' +
      '</div>' +
      '<p class="hint">← 左右拖动卡片换一道 →</p>' +
      '<div class="draw-actions">' +
      '<button class="btn ghost" data-act="next-draw">换一道</button>' +
      '<button class="btn primary" data-act="eat-this"' + (d ? '' : ' disabled') + '>就吃这个</button>' +
      '</div>';
  }

  function dishRow(d) {
    return '<button class="dish-row" data-act="open-dish" data-id="' + d.id + '">' +
      '<span class="thumb">' + fallbackEmoji(d) + photo(d, 'thumb') + '</span>' +
      '<span class="dish-main"><span class="dish-name">' + esc(d.name) + '</span>' +
      '<span class="dish-sub">' + esc(d.desc) + '</span></span>' +
      '<span class="plus">＋</span>' +
      '</button>';
  }

  function dishListHtml() {
    var list = C.search(DISHES, ui.menuQ);
    if (ui.menuCat !== '全部') list = list.filter(function (d) { return d.cat === ui.menuCat; });
    if (!list.length) return '<div class="empty">没找到，换个词试试（支持拼音首字母，比如 xcr）</div>';
    var groups = [];
    if (ui.menuCat === '全部') {
      CATS.forEach(function (c) {
        var items = list.filter(function (d) { return d.cat === c.key; });
        if (items.length) groups.push({ name: c.key, emoji: c.emoji, items: items });
      });
    } else {
      groups.push({ name: ui.menuCat, emoji: '', items: list });
    }
    return groups.map(function (g) {
      return '<section class="sec"><h3>' + (g.emoji ? g.emoji + ' ' : '') + esc(g.name) +
        '<span class="sec-n">' + g.items.length + '</span></h3>' +
        g.items.map(dishRow).join('') + '</section>';
    }).join('');
  }

  function viewMenu() {
    return header('菜谱', DISHES.length + ' 道家常菜 · 支持全拼 / 首字母 / 食材搜索') +
      '<div class="search"><input id="search" type="search" placeholder="搜菜名、拼音或食材，如 xcr / 番茄" value="' + esc(ui.menuQ) + '"></div>' +
      chips(['全部'].concat(CATS.map(function (c) { return c; })), ui.menuCat, 'menu-cat') +
      '<div id="dishList">' + dishListHtml() + '</div>';
  }

  function stepperRow(item) {
    var d = byId[item.id];
    if (!d) return '';
    return '<div class="row">' +
      '<span class="thumb">' + fallbackEmoji(d) + photo(d, 'thumb') + '</span>' +
      '<span class="row-main"><span class="row-name">' + esc(d.name) + '</span>' +
      '<span class="row-sub">' + esc(d.cat) + ' · ' + esc(d.desc) + '</span></span>' +
      '<span class="stepper">' +
      '<button data-act="qty-dec" data-id="' + d.id + '" aria-label="减一份">−</button>' +
      '<b>' + (item.qty || 1) + '</b>' +
      '<button data-act="qty-inc" data-id="' + d.id + '" aria-label="加一份">＋</button>' +
      '</span></div>';
  }

  function viewCart() {
    var n = cartCount();
    var body;
    if (!state.cart.length) {
      body = '<div class="empty big"><div class="empty-emoji">🍽️</div><p>点菜单还是空的</p>' +
        '<button class="btn primary" data-act="go-menu">去挑几道菜</button></div>';
    } else {
      body = '<section class="sec"><h3>这一餐<span class="sec-n">' + state.cart.length + ' 道</span></h3>' +
        state.cart.map(stepperRow).join('') + '</section>';
    }

    var hist = '';
    if (state.history.length) {
      hist = '<section class="sec"><h3>最近点单<span class="sec-n">' + state.history.length + '</span></h3>' +
        state.history.slice(0, 8).map(function (h) {
          var names = h.items.map(function (i) { return (byId[i.id] || {}).name || ''; }).filter(Boolean).join('、');
          return '<div class="hist"><div class="hist-top"><b>' + esc(h.label) + '</b><span>' + esc(h.when) + '</span></div>' +
            '<p class="hist-names">' + esc(names) + '</p></div>';
        }).join('') + '</section>';
    }

    var bar = state.cart.length
      ? '<div class="orderbar"><div class="ob-sum"><b>' + n + '</b> 份 · ' + state.cart.length + ' 道菜</div>' +
      '<button class="btn primary" data-act="open-order">锁定这一餐</button></div>'
      : '';

    return header('点菜', '加几道菜，锁单后自动生成买菜清单') + body + hist + bar;
  }

  function viewList() {
    var items = currentMealItems();
    if (!items.length) {
      return header('买菜清单', '把这一餐要买的东西一次列全') +
        '<div class="empty big"><div class="empty-emoji">🛒</div><p>还没有菜单，先去点菜</p>' +
        '<button class="btn primary" data-act="go-cart">去点菜</button></div>';
    }
    var m = C.mergeShopping(items, byId);
    var done = 0, total = m.count;
    m.groups.forEach(function (g) {
      g.items.forEach(function (it) {
        var k = g.key + '|' + it.name;
        if (state.checked[k]) done++;
      });
    });

    var html = header('买菜清单', (state.meal ? state.meal.label : '当前点菜单') + ' · 共 ' + total + ' 项');
    html += '<div class="progress"><div class="progress-bar" style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></div></div>' +
      '<p class="progress-txt">已买 <b>' + done + '</b> / ' + total + '</p>';

    html += m.groups.map(function (g) {
      return '<section class="sec"><h3>' + esc(g.key === '主' ? '主料' : g.key === '辅' ? '辅料' : '调料') +
        '<span class="sec-n">' + g.items.length + '</span></h3>' +
        g.items.map(function (it) {
          var k = g.key + '|' + it.name;
          var on = !!state.checked[k];
          return '<button class="shop' + (on ? ' done' : '') + '" data-act="toggle" data-key="' + esc(k) + '">' +
            '<span class="box">' + (on ? '✓' : '') + '</span>' +
            '<span class="shop-name">' + esc(it.name) + '</span>' +
            '<span class="shop-qty">' + esc(it.text.replace(it.name + ' ', '')) + '</span>' +
            '</button>';
        }).join('') + '</section>';
    }).join('');

    html += '<div class="list-actions">' +
      '<button class="btn ghost" data-act="copy">复制清单</button>' +
      (state.meal ? '<button class="btn ghost" data-act="new-meal">开新的一餐</button>' : '') +
      '</div>';
    return html;
  }

  var TABS = [
    { key: 'draw', label: '抽菜', icon: '<path d="M4 8l8-4 8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>' },
    { key: 'menu', label: '菜谱', icon: '<path d="M4 5h7v14H4z"/><path d="M13 5h7v14h-7z"/>' },
    { key: 'cart', label: '点菜', icon: '<path d="M3 5h2l2 10h11l2-7H6"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>' },
    { key: 'list', label: '清单', icon: '<path d="M5 4h14v16H5z"/><path d="M8 9l2 2 4-4"/><path d="M8 15h7"/>' }
  ];

  function tabbar() {
    var n = state.cart.length;
    return '<nav class="tabbar">' + TABS.map(function (t) {
      var badge = (t.key === 'cart' && n) ? '<i class="badge">' + n + '</i>' : '';
      return '<button class="tab' + (ui.tab === t.key ? ' on' : '') + '" data-act="tab" data-key="' + t.key + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">' + t.icon + '</svg>' +
        '<span>' + t.label + '</span>' + badge + '</button>';
    }).join('') + '</nav>';
  }

  function render() {
    var html = ui.tab === 'draw' ? viewDraw()
      : ui.tab === 'menu' ? viewMenu()
        : ui.tab === 'cart' ? viewCart()
          : viewList();
    $('#view').innerHTML = html;
    $('#tabbarHost').innerHTML = tabbar();
    $('#view').scrollTop = ui.scroll[ui.tab] || 0;
    if (ui.tab === 'draw') bindDrag();
    save();
  }

  /* 只重画抽菜卡片 */
  function renderCard() {
    var el = $('#drawCard');
    if (!el) { render(); return; }
    el.innerHTML = cardHtml(ui.drawDish);
    el.classList.remove('fly-left', 'fly-right');
    el.style.transform = '';
    el.classList.add('pop');
    setTimeout(function () { el.classList.remove('pop'); }, 220);
    save();
  }

  /* ---------- 弹层 ---------- */
  var sheet = $('#sheetHost');

  function openSheet(html) {
    sheet.innerHTML = '<div class="mask" data-act="close-sheet"></div><div class="sheet">' + html + '</div>';
    document.body.classList.add('lock');
    requestAnimationFrame(function () { sheet.classList.add('open'); });
  }

  function closeSheet() {
    sheet.classList.remove('open');
    document.body.classList.remove('lock');
    setTimeout(function () { sheet.innerHTML = ''; }, 240);
  }

  function openDish(id) {
    var d = byId[id];
    if (!d) return;
    var ingHtml = ['主', '辅', '调'].map(function (g) {
      var rows = (d.ing || []).filter(function (r) { return r[0] === g; });
      if (!rows.length) return '';
      return '<div class="ing-group"><h4>' + (g === '主' ? '主料' : g === '辅' ? '辅料' : '调料') + '</h4>' +
        rows.map(function (r) { return '<div class="ing"><span>' + esc(r[1]) + '</span><em>' + esc(r[2]) + '</em></div>'; }).join('') + '</div>';
    }).join('');

    var html = '<div class="sheet-cover">' + fallbackEmoji(d, 'cover-emoji') + photo(d, 'full') + '</div>' +
      '<div class="sheet-hd"><div><h2>' + esc(d.name) + '</h2><p>' + esc(d.desc) + '</p></div>' +
      '<button class="x" data-act="close-sheet">✕</button></div>' +
      '<div class="tags">' + (d.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
      (d.spicy ? '<span class="tag spicy">辣 ' + '🌶'.repeat(d.spicy) + '</span>' : '') + '</div>' +
      '<div class="sheet-sec">' + ingHtml + '</div>' +
      '<div class="sheet-sec"><h4>做法</h4><ol class="steps">' +
      (d.steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>' +
      '<div class="sheet-ft"><button class="btn primary wide" data-act="add-from-sheet" data-id="' + d.id + '">加入点菜</button></div>';
    openSheet(html);
  }

  function openOrder() {
    var html = '<h3 class="sheet-title">锁定这一餐</h3>' +
      '<p class="sheet-note">选好时间和餐别，锁单后会生成买菜清单</p>' +
      '<div class="pick"><span class="pick-label">日期</span><div class="picks">' +
      DAYS.map(function (t, i) {
        return '<button class="pick-btn' + (ui.day === i ? ' on' : '') + '" data-act="pick-day" data-key="' + i + '">' + t + '</button>';
      }).join('') + '</div></div>' +
      '<div class="pick"><span class="pick-label">餐别</span><div class="picks">' +
      SLOTS.map(function (s) {
        return '<button class="pick-btn' + (ui.slot === s ? ' on' : '') + '" data-act="pick-slot" data-key="' + s + '">' + s + '</button>';
      }).join('') + '</div></div>' +
      '<div class="sum-row"><span>共 ' + cartCount() + ' 份 / ' + state.cart.length + ' 道菜</span></div>' +
      '<button class="btn primary wide" data-act="confirm-lock">确认锁单</button>';
    openSheet(html);
  }

  function randomCode() {
    var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    var s = '';
    for (var i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }

  function inviteUrl() {
    return location.origin + location.pathname + '?room=' + encodeURIComponent(room || '');
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || '已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
  }

  function openRoom() {
    var html;
    if (!room) {
      html = '<h3 class="sheet-title">一起点菜</h3>' +
        '<p class="sheet-note">开一个房间，把房间码发给家人。两边点菜、增减份数、勾买菜清单都会实时同步。</p>' +
        '<button class="btn primary wide" data-act="create-room">创建房间</button>' +
        '<div class="join-row"><input id="roomInput" placeholder="或输入房间码加入" maxlength="8" autocomplete="off" autocapitalize="off">' +
        '<button class="btn ghost" data-act="join-room">加入</button></div>' +
        '<p class="hint">房间码是一串字母数字，自己定也行，比如 k3f9。</p>';
    } else {
      html = '<h3 class="sheet-title">房间 <span class="room-code">' + esc(room.toUpperCase()) + '</span></h3>' +
        '<p class="sheet-note">' + (SYNC_TEXT[syncStatus] || '') + ' · 同一房间的人看到同一份菜单</p>' +
        '<button class="btn primary wide" data-act="copy-invite">复制邀请链接</button>' +
        '<button class="btn ghost wide" data-act="leave-room">退出房间</button>' +
        '<p class="hint">退出后回到本机单独使用，房间里的内容不会消失。</p>';
    }
    openSheet(html);
  }

  function confirmLock() {
    if (!state.cart.length) return;
    var label = C.slotLabel(ui.day, ui.slot);
    var now = new Date();
    var when = ('0' + (now.getMonth() + 1)).slice(-2) + '/' + ('0' + now.getDate()).slice(-2) + ' ' +
      ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
    var items = state.cart.map(function (i) { return { id: i.id, qty: i.qty || 1 }; });
    closeSheet();
    ui.tab = 'list';
    dispatch({ t: 'lock', label: label, when: when, items: items, at: Date.now() });
    toast('已锁单，清单生成好了');
    vibrate(14);
  }

  function addToCart(id, qty) {
    var d = byId[id];
    if (!d) return;
    dispatch({ t: 'add', id: id, d: qty || 1 });
    toast('已加入 ' + d.name + (room ? '（已同步）' : ''));
    vibrate(8);
  }

  function copyList() {
    var m = C.mergeShopping(currentMealItems(), byId);
    var lines = ['🛒 买菜清单'];
    m.groups.forEach(function (g) {
      lines.push('');
      lines.push('【' + (g.key === '主' ? '主料' : g.key === '辅' ? '辅料' : '调料') + '】');
      g.items.forEach(function (it) { lines.push('· ' + it.text); });
    });
    var text = lines.join('\n');
    var done = function () { toast('清单已复制，去粘贴到微信吧'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();

    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择'); }
      document.body.removeChild(ta);
    }
  }

  /* ---------- 抽菜拖动 ---------- */
  function bindDrag() {
    var card = $('#drawCard');
    if (!card) return;
    var sx = 0, dx = 0, dragging = false;

    card.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      dragging = true;
      sx = e.clientX;
      card.setPointerCapture(e.pointerId);
      card.style.transition = 'none';
    });

    card.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dx = e.clientX - sx;
      var rot = dx / 18;
      card.style.transform = 'translateX(' + dx + 'px) rotate(' + rot + 'deg)';
    });

    function end() {
      if (!dragging) return;
      dragging = false;
      card.style.transition = '';
      if (Math.abs(dx) > 78) {
        var dir = dx > 0 ? 1 : -1;
        card.classList.add(dir > 0 ? 'fly-right' : 'fly-left');
        setTimeout(function () { nextDish(dir); }, 180);
        vibrate(10);
      } else {
        card.style.transform = '';
      }
      dx = 0;
    }
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    var key = el.getAttribute('data-key');

    switch (act) {
      case 'tab':
        if (ui.tab === key) return;
        ui.scroll[ui.tab] = $('#view').scrollTop;
        ui.tab = key;
        render();
        vibrate(6);
        break;
      case 'draw-cat':
        ui.drawCat = key;
        nextDish(0);
        render();
        break;
      case 'next-draw':
        nextDish(-1);
        break;
      case 'eat-this':
        if (ui.drawDish) addToCart(ui.drawDish.id, 1);
        break;
      case 'menu-cat':
        ui.menuCat = key;
        $('#dishList').innerHTML = dishListHtml();
        document.querySelectorAll('[data-act="menu-cat"]').forEach(function (b) {
          b.classList.toggle('on', b.getAttribute('data-key') === key);
        });
        break;
      case 'open-dish': openDish(Number(id)); break;
      case 'close-sheet': closeSheet(); break;
      case 'add-from-sheet': closeSheet(); setTimeout(function () { addToCart(Number(id), 1); }, 120); break;
      case 'qty-inc':
        if (state.cart.some(function (i) { return i.id === Number(id); })) {
          vibrate(6);
          dispatch({ t: 'add', id: Number(id), d: 1 });
        }
        break;
      case 'qty-dec':
        if (state.cart.some(function (i) { return i.id === Number(id); })) {
          vibrate(6);
          dispatch({ t: 'add', id: Number(id), d: -1 });
        }
        break;
      case 'open-order': openOrder(); break;
      case 'pick-day': ui.day = Number(key); openOrder(); break;
      case 'pick-slot': ui.slot = key; openOrder(); break;
      case 'confirm-lock': confirmLock(); break;
      case 'toggle':
        vibrate(5);
        dispatch({ t: 'check', k: key, v: !state.checked[key] });
        break;
      case 'copy': copyList(); break;
      case 'new-meal':
        dispatch({ t: 'clear' });
        toast('已开新的一餐');
        break;
      case 'go-menu': ui.tab = 'menu'; render(); break;
      case 'go-cart': ui.tab = 'cart'; render(); break;

      case 'open-room': openRoom(); break;
      case 'create-room': joinRoom(randomCode(), true); break;
      case 'join-room':
        var input = document.getElementById('roomInput');
        if (!input || !input.value.trim()) { toast('先输入房间码'); break; }
        joinRoom(input.value, true);
        break;
      case 'copy-invite': copyText(inviteUrl(), '邀请链接已复制，发到微信吧'); break;
      case 'leave-room':
        setRoom(null);
        closeSheet();
        render();
        toast('已退出房间');
        break;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id !== 'search') return;
    ui.menuQ = e.target.value;
    var pos = e.target.selectionStart;
    var box = $('#dishList');
    box.innerHTML = dishListHtml();
    // 不重建 input，焦点不丢；这里只保证光标位置正常
    e.target.setSelectionRange(pos, pos);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSheet();
  });

  /* ---------- 启动 ---------- */
  ui.drawDish = C.pickRandom(DISHES, state.recent, null);
  render();

  // 带 ?room=xxx 打开，或上次退出时还在房间里 → 自动重连
  (function autoJoin() {
    var m = /[?&]room=([a-z0-9]{3,8})/i.exec(location.search);
    var code = null;
    if (m) {
      code = m[1].toLowerCase();
      try { localStorage.setItem('today-eat.room', code); } catch (e) { }
    } else {
      try { code = localStorage.getItem('today-eat.room') || null; } catch (e) { }
    }
    if (code && window.CookSync) setRoom(code);
  })();

  window.__APP__ = {
    ui: ui,
    render: render,
    get state() { return state; },
    get room() { return room; },
    get sync() { return syncStatus; },
    setRoom: setRoom
  };
})();
