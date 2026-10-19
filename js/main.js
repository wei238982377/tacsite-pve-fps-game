/* ============================================================
   AI GAME · 沙漠对决 — 启动与主循环
   ============================================================ */
"use strict";
(function () {
  var G = window.GAME = window.GAME || {};
  var started = false;

  function setLoadingProgress(pct, text) {
    var fill = document.getElementById('loading-fill');
    var txt = document.getElementById('loading-text');
    if (fill) fill.style.width = Math.round(pct) + '%';
    if (txt && text) txt.textContent = text;
  }

  function fatal(msg) {
    if (typeof G.showFatal === 'function') G.showFatal(msg);
  }

  function boot() {
    if (started) return;
    if (window.__UI_PREVIEW__) return;
    var canvas = document.getElementById('game-canvas');
    if (!canvas) return;
    setLoadingProgress(8, '正在检查浏览器环境…');

    // 模块完整性检查
    var missing = [];
    if (!G.M) missing.push('math.js');
    if (!G.Engine) missing.push('engine.js');
    if (!G.Map && !G.MAP) missing.push('map.js');
    if (!G.Weapons) missing.push('weapons.js');
    if (!G.Audio) missing.push('audio.js');
    if (!G.Physics) missing.push('engine.js(physics)');
    if (!G.Player) missing.push('player.js');
    if (!G.Bot) missing.push('bot.js');
    if (!G.Game) missing.push('game.js');
    if (missing.length) {
      fatal('以下游戏模块加载失败：\n' + missing.join('\n') + '\n\n请确认 js/ 目录下文件完整。');
      return;
    }
    if (!G.MAP) { fatal('地图数据缺失（map.js 未正确加载）。'); return; }

    canvas.addEventListener('webglcontextlost', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      fatal('WebGL 上下文丢失，可能是显卡驱动或内存问题。\n请刷新页面重试；若反复出现请降低渲染分辨率。');
    }, false);
    canvas.addEventListener('webglcontextrestored', function () {
      try { window.location.reload(); } catch (e) { /* ignore */ }
    }, false);

    setLoadingProgress(22, '正在初始化 WebGL 渲染器…');
    var initRes;
    try {
      initRes = G.Engine.init(canvas);
    } catch (e) {
      fatal('渲染器初始化异常：\n' + (e && e.stack ? e.stack : e));
      return;
    }
    if (!initRes || !initRes.ok) {
      fatal((initRes && initRes.error) || 'WebGL 初始化失败，请开启浏览器硬件加速。');
      return;
    }

    setLoadingProgress(48, '正在生成沙漠地图与程序化纹理…');
    try {
      G.Engine.buildMap(G.MAP);
    } catch (e) {
      fatal('地图构建失败：\n' + (e && e.stack ? e.stack : e));
      return;
    }

    setLoadingProgress(78, '正在准备武器与对手 AI…');
    try {
      G.Game.init();
    } catch (e) {
      fatal('游戏初始化失败：\n' + (e && e.stack ? e.stack : e));
      return;
    }

    setLoadingProgress(100, '准备就绪');
    started = true;

    var last = (window.performance && performance.now) ? performance.now() : Date.now();
    function frame(ts) {
      var t = (ts === undefined) ? last : ts;
      var dt = (t - last) / 1000;
      last = t;
      if (!isFinite(dt) || dt < 0) dt = 1 / 60;
      if (dt > 0.05) dt = 0.05;
      try {
        G.Game.frame(dt);
      } catch (e) {
        window.__GAME_ERROR__ = '主循环异常: ' + (e && e.message ? e.message : e);
        fatal('主循环异常：\n' + (e && e.stack ? e.stack : e));
        return;
      }
      window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
