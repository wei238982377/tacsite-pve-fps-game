/* ============================================================
   AI GAME · 沙漠对决 — 武器与伤害数据（参考 CS2 手感）
   伤害无护甲、无距离衰减；只有 AWM 可开镜。
   ============================================================ */
"use strict";
(function () {
  var G = window.GAME = window.GAME || {};

  var defs = {
    deagle: {
      id: 'deagle',
      name: '沙漠之鹰',
      enName: 'DESERT EAGLE',
      slot: 1,
      cls: 'pistol',
      damage: { body: 58, head: 155, legs: 43 },
      rpm: 240,
      auto: false,
      mag: 7,
      reserve: 42,
      reloadTime: 2.15,
      equipTime: 0.55,
      spreadDeg: { still: 0.18, move: 4.2, air: 9.0, crouch: 0.12, perShot: 1.9, max: 6.0, recover: 7.5 },
      recoil: { up: 1.6, side: 0.5, kick: 2.2, recover: 8.0 },
      range: 70,
      scope: false,
      boltTime: 0,
      pellets: 1,
      tracerColor: [1.0, 0.85, 0.45],
      crosshair: 'deagle',
      hipSpreadDeg: 0.18
    },
    awm: {
      id: 'awm',
      name: 'AWM',
      enName: 'AWM',
      slot: 2,
      cls: 'sniper',
      damage: { body: 112, head: 300, legs: 88 },
      rpm: 41,
      auto: false,
      mag: 5,
      reserve: 25,
      reloadTime: 3.5,
      equipTime: 0.9,
      spreadDeg: { still: 0.1, move: 12.0, air: 20.0, crouch: 0.08, perShot: 3.0, max: 12.0, recover: 6.0 },
      recoil: { up: 3.6, side: 0.8, kick: 5.0, recover: 5.5 },
      range: 120,
      scope: true,
      zoomFov: 26,
      boltTime: 1.45,
      scopedSpreadDeg: 0.02,
      pellets: 1,
      tracerColor: [0.85, 0.95, 1.0],
      crosshair: 'awm',
      hipSpreadDeg: 2.4
    },
    ak47: {
      id: 'ak47',
      name: 'AK-47',
      enName: 'AK-47',
      slot: 3,
      cls: 'rifle',
      damage: { body: 33, head: 110, legs: 26 },
      rpm: 600,
      auto: true,
      mag: 30,
      reserve: 120,
      reloadTime: 2.45,
      equipTime: 0.7,
      spreadDeg: { still: 0.3, move: 3.0, air: 8.0, crouch: 0.2, perShot: 0.75, max: 4.5, recover: 8.5 },
      recoil: { up: 0.85, side: 0.4, kick: 1.1, recover: 9.0 },
      range: 90,
      scope: false,
      boltTime: 0,
      pellets: 1,
      tracerColor: [1.0, 0.75, 0.35],
      crosshair: 'ak47',
      hipSpreadDeg: 0.3,
      // 连发弹道爬升（第 n 发的额外上抬，度）
      sprayPattern: [0, .5, .8, 1.0, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5, 1.55, 1.6, 1.65, 1.7, 1.7, 1.65, 1.6, 1.55, 1.5, 1.45, 1.4, 1.35, 1.3, 1.25, 1.2, 1.15, 1.1]
    }
  };

  var ORDER = ['deagle', 'awm', 'ak47'];

  /* 计算当前扩散（度） */
  function currentSpread(def, state) {
    var s = def.spreadDeg;
    var sp = s.still;
    if (state.crouch) sp = Math.min(sp, s.crouch);
    var speed = state.speed || 0;
    if (speed > 0.5) {
      var k = Math.min(1, speed / 5.7);
      sp += s.move * k;
    }
    if (state.air) sp += s.air * 0.55;
    sp += Math.min(s.max - sp, (state.shotSpread || 0));
    return Math.max(0, sp);
  }

  /* 随机方向偏移（度） */
  function applySpread(dir, spreadDeg) {
    if (spreadDeg <= 0.0001) return dir;
    var u = Math.random(), v = Math.random();
    var r = Math.sqrt(-2 * Math.log(Math.max(1e-6, u))) * Math.cos(2 * Math.PI * v);
    var theta = Math.random() * Math.PI * 2;
    var rad = Math.abs(r) * spreadDeg * Math.PI / 180 * 0.5;
    // 构造与 dir 垂直的两个轴
    var up = [0, 1, 0];
    if (Math.abs(dir[1]) > 0.98) up = [0, 0, 1];
    var right = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]];
    var rl = Math.sqrt(right[0] * right[0] + right[1] * right[1] + right[2] * right[2]) || 1;
    right = [right[0] / rl, right[1] / rl, right[2] / rl];
    var up2 = [right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]];
    var out = [
      dir[0] + right[0] * Math.cos(theta) * rad + up2[0] * Math.sin(theta) * rad,
      dir[1] + right[1] * Math.cos(theta) * rad + up2[1] * Math.sin(theta) * rad,
      dir[2] + right[2] * Math.cos(theta) * rad + up2[2] * Math.sin(theta) * rad
    ];
    var l = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }

  G.Weapons = {
    ORDER: ORDER,
    defs: defs,
    get: function (id) { return defs[id] || defs.ak47; },
    currentSpread: currentSpread,
    applySpread: applySpread
  };
})();
