/* 纯逻辑层：不碰 DOM，方便单独测试
 * - 拼音索引（全拼 + 首字母）
 * - 搜索（菜名 / 全拼 / 首字母 / 食材）
 * - 抽菜去重
 * - 购物车 → 买菜清单合并（同名同单位累加，按份数倍乘）
 */
(function (root) {
  'use strict';

  var CN_NUM = { '半': 0.5, '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

  function pyInfo(dish) {
    if (!dish.__py) {
      var parts = String(dish.py || '').trim().split(/\s+/).filter(Boolean);
      var lower = parts.map(function (p) { return p.toLowerCase(); });
      dish.__py = {
        full: lower.join(''),
        initials: lower.map(function (p) { return p[0] || ''; }).join('')
      };
    }
    return dish.__py;
  }

  // "250g" -> {num:250, unit:"g"}; "半勺" -> {num:0.5, unit:"勺"}; "适量" -> null
  function parseAmount(qty) {
    var s = String(qty == null ? '' : qty).trim();
    if (!s) return null;
    var m = s.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
    if (m) return { num: parseFloat(m[1]), unit: m[2].trim() };
    var c = s.charAt(0);
    if (Object.prototype.hasOwnProperty.call(CN_NUM, c)) {
      return { num: CN_NUM[c], unit: s.slice(1).trim() };
    }
    return null;
  }

  function fmtNum(n) {
    var r = Math.round(n * 10) / 10;
    return String(r);
  }

  function search(dishes, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return dishes.slice();
    var hit = [];
    for (var i = 0; i < dishes.length; i++) {
      var d = dishes[i];
      var py = pyInfo(d);
      var ok =
        d.name.toLowerCase().indexOf(q) >= 0 ||
        py.full.indexOf(q) >= 0 ||
        py.initials.indexOf(q) === 0 ||
        (d.tags || []).some(function (t) { return t.indexOf(q) >= 0; }) ||
        (d.ing || []).some(function (row) { return String(row[1]).toLowerCase().indexOf(q) >= 0; });
      if (ok) hit.push(d);
    }
    return hit;
  }

  function pickRandom(pool, recentIds, lastId) {
    var avoid = {};
    (recentIds || []).slice(-6).forEach(function (id) { avoid[id] = true; });
    if (lastId != null) avoid[lastId] = true;
    var candidates = pool.filter(function (d) { return !avoid[d.id]; });
    if (!candidates.length) candidates = pool;
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  var GROUP_ORDER = ['主', '辅', '调'];

  function mergeShopping(cart, dishById) {
    var buckets = {};   // key -> {name, unit, num, times}
    var loose = {};     // 无数字用量的，按名字合并
    var order = [];

    (cart || []).forEach(function (item) {
      var dish = dishById[item.id];
      if (!dish) return;
      var times = Math.max(1, item.qty || 1);
      (dish.ing || []).forEach(function (row) {
        var group = row[0], name = row[1], qty = row[2];
        var amt = parseAmount(qty);
        var key;
        if (amt && amt.num > 0) {
          key = group + '|' + name + '|' + amt.unit;
          if (!buckets[key]) {
            buckets[key] = { group: group, name: name, unit: amt.unit, num: 0, times: 0 };
            order.push(key);
          }
          buckets[key].num += amt.num * times;
          buckets[key].times += 1;
        } else {
          key = group + '|' + name + '|?';
          if (!loose[key]) {
            loose[key] = { group: group, name: name, text: qty || '适量', times: 0 };
            order.push(key);
          }
          loose[key].times += 1;
        }
      });
    });

    var out = [];
    order.forEach(function (key) {
      if (buckets[key]) {
        var b = buckets[key];
        out.push({ group: b.group, name: b.name, text: b.name + ' ' + fmtNum(b.num) + b.unit, count: b.times });
      } else if (loose[key]) {
        var l = loose[key];
        out.push({ group: l.group, name: l.name, text: l.name + ' ' + l.text, count: l.times });
      }
    });

    var groups = GROUP_ORDER.map(function (g) {
      return { key: g, items: out.filter(function (x) { return x.group === g; }) };
    }).filter(function (g) { return g.items.length; });

    return { groups: groups, count: out.length };
  }

  function slotLabel(dayOffset, slot) {
    var d = new Date();
    d.setDate(d.getDate() + dayOffset);
    var dayNames = ['今天', '明天', '后天'];
    var mm = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    return (dayNames[dayOffset] || (mm + '/' + dd)) + ' · ' + slot;
  }

  var api = {
    pyInfo: pyInfo,
    parseAmount: parseAmount,
    search: search,
    pickRandom: pickRandom,
    mergeShopping: mergeShopping,
    slotLabel: slotLabel,
    GROUP_ORDER: GROUP_ORDER
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CookCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
