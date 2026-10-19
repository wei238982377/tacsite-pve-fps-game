"use strict";
/* ============================================================================
 * AI GAME · 沙漠对决 — 地图 de_dust_duel（1v1 对枪竞技场）
 * 纯数据文件：只定义 window.GAME.MAP，不调用 WebGL / DOM / 其它模块。
 * 世界约定：米；Y 向上；pos = [x, y, z]，y 为脚底高度。
 *
 * ───────────────────────── 俯视示意图（1 格 ≈ 2m）─────────────────────────
 *        x=-20      -14.4  -13.6       0       5.6  6.4  13.6 14.4      x=20
 *  z=-18 ╔════════════╦══════════╦═════════════╦═══════╦═══════════════════╗
 *        ║  NW ROOM   ║ CT SPAWN ║             ║ E-N   ║   FLANK NORTH     ║
 *        ║  tunnel    ║  (CT)    ║  [mid 北门] ║[货柜] ║      [B1 墙]       ║
 *        ╠════╦═╦═════╝ ╔════╗   ╚══════╦══════╬═══════╬═══════════════════╣
 *        ║    ║ ║       ║    ║          ║      ║       ║                   ║
 *        ║ L  ║ ║ 拱门  ║ 柱 ║  ［中庭］  ║ 集市 ║       ║   FLANK           ║
 *        ║ O  ║ ║       ║ 子 ║   MONUMENT ║ 摊位 ║ 短道  ║  [B2 墙][B3 墙]   ║
 *        ║ N  ║ ║【平台】║ 门 ║   ██ 2.6m  ║ [市场 ║       ║  [B4 墙]          ║
 *        ║ G  ║ ║ 台阶  ║    ║    ■■       ║  街]  ║       ║   (绕后连接路)     ║
 *        ║    ║ ║       ║    ║   [摊位]   ║[舞台] ║       ║                   ║
 *        ╠════╩═╩═════╗ ╚════╝   ╔══════╩══════╬═══════╬═══════════════════╣
 *        ║  SW ROOM   ║ T SPAWN ║             ║ E-S   ║   FLANK SOUTH     ║
 *        ║  tunnel    ║  (T)    ║ [mid 南门]  ║[仓储] ║                   ║
 *  z=+18 ╚════════════╩══════════╩═════════════╩═══════╩═══════════════════╝
 *
 *  路线：long = 西侧长枪线（约 33m 直线，AWM 架枪）
 *        mid  = 中央中庭 + 纪念碑/柱门 + 西平台（15~25m AK 对枪）
 *        short= 东侧集市街（市场建筑把通道切成近战拐角，5~12m 沙鹰）
 *        flank= 东侧绕后连接路（B1~B4 矮墙左右交替，S 形推进）
 *        tunnel = 西北/西南两个后室，连接 long 与 spawn 出生区
 *  T 出生：南侧中央大厅；CT 出生：北侧中央大厅；二者互不对称但出生对枪公平。
 *  主要掩体：长道两侧交错木箱/沙袋/水泥墩；中庭纪念碑+柱门+西平台；
 *            集市街摊位/货柜/舞台；绕后路 4 组矮墙 + 木箱；出生区箱堆。
 * ========================================================================== */
(function () {
  var G = window.GAME = window.GAME || {};

  /* ---------------------------------------------------------------- 基础工具 */
  var SOLIDS = [];
  var DECOR = [];
  var MATS = { sand: 1, wall: 1, brick: 1, crate: 1, metal: 1, concrete: 1, stone: 1, tarp: 1, wood: 1, roof: 1 };
  var DECOR_TYPES = {
    barrel: 1, crate: 1, cratepile: 1, sandbags: 1, lamp: 1, plant: 1, sign: 1,
    rubble: 1, tires: 1, awning: 1, table: 1, fence: 1
  };

  function r3(v) { return Math.round(v * 1000) / 1000; }

  // 轴对齐实体盒子。mat 见文档 5.1.1；shade 0.75~1.15；collision=false 仅渲染
  function S(x0, y0, z0, x1, y1, z1, mat, shade, collision) {
    var o = {
      min: [r3(x0), r3(y0), r3(z0)],
      max: [r3(x1), r3(y1), r3(z1)],
      mat: mat
    };
    if (typeof shade === 'number' && Math.abs(shade - 1) > 0.001) o.shade = r3(shade);
    if (collision === false) o.collision = false;
    SOLIDS.push(o);
    return o;
  }

  // 装饰道具（无碰撞）。type 见文档 5.1.2
  function D(type, x, y, z, rot, scale, text) {
    var o = { type: type, pos: [r3(x), r3(y), r3(z)] };
    if (typeof rot === 'number' && Math.abs(rot) > 0.0001) o.rot = r3(rot);
    if (typeof scale === 'number' && Math.abs(scale - 1) > 0.0001) o.scale = r3(scale);
    if (text) o.text = String(text).slice(0, 2);
    DECOR.push(o);
    return o;
  }

  // 竖直隔墙（沿 Z 走向）：z 段 + 门洞（门高 2.6m，上方石质过梁；洞宽须 >=1.2m）
  function wallAlongZ(x0, x1, z0, z1, h, mat, doorList) {
    var list = (doorList || []).slice().sort(function (a, b) { return a[0] - b[0]; });
    var cur = z0, i;
    for (i = 0; i < list.length; i++) {
      if (list[i][0] > cur + 1e-6) S(x0, 0, cur, x1, h, list[i][0], mat, 1);
      cur = list[i][1];
    }
    if (z1 > cur + 1e-6) S(x0, 0, cur, x1, h, z1, mat, 1);
    for (i = 0; i < list.length; i++) {
      S(x0, 2.6, list[i][0], x1, h, list[i][1], 'stone', 0.98); // 过梁
    }
  }

  // 水平隔墙（沿 X 走向）：x 段 + 门洞
  function wallAlongX(z0, z1, x0, x1, h, mat, doorList) {
    var list = (doorList || []).slice().sort(function (a, b) { return a[0] - b[0]; });
    var cur = x0, i;
    for (i = 0; i < list.length; i++) {
      if (list[i][0] > cur + 1e-6) S(cur, 0, z0, list[i][0], h, z1, mat, 1);
      cur = list[i][1];
    }
    if (x1 > cur + 1e-6) S(cur, 0, z0, x1, h, z1, mat, 1);
    for (i = 0; i < list.length; i++) {
      S(list[i][0], 2.6, z0, list[i][1], h, z1, 'stone', 0.98);
    }
  }

  /* ==========================================================================
   * 一、地面 + 外围封闭围墙（可玩区 x∈[-20,20], z∈[-18,18]，墙厚 1m、高 6.5m）
   * ======================================================================== */
  // 地板（顶面 y=0，延伸到外墙外侧，任何位置都不会掉出地图）
  S(-21, -1, -19, 21, 0, 19, 'sand', 1);

  // 外墙：下部 1.15m 砖砌基座 + 上部沙色墙体（每侧 4 段、明暗交替，避免单调）
  (function buildOuterWalls() {
    var i, segs, shade;
    // 西 / 东墙（沿 Z）
    for (i = 0; i < 4; i++) {
      segs = [[-19 + i * 9.5, -19 + (i + 1) * 9.5]];
      shade = (i % 2 === 0) ? 0.97 : 1.02;
      S(-21, 0, segs[0][0], -20, 1.15, segs[0][1], 'brick', 0.92);
      S(-21, 1.15, segs[0][0], -20, 6.5, segs[0][1], 'sand', shade);
      S(20, 0, segs[0][0], 21, 1.15, segs[0][1], 'brick', 0.92);
      S(20, 1.15, segs[0][0], 21, 6.5, segs[0][1], 'sand', shade);
    }
    // 北 / 南墙（沿 X）
    for (i = 0; i < 4; i++) {
      segs = [[-20 + i * 10, -20 + (i + 1) * 10]];
      shade = (i % 2 === 0) ? 1.02 : 0.97;
      S(segs[0][0], 0, -19, segs[0][1], 1.15, -18, 'brick', 0.92);
      S(segs[0][0], 1.15, -19, segs[0][1], 6.5, -18, 'sand', shade);
      S(segs[0][0], 0, 18, segs[0][1], 1.15, 19, 'brick', 0.92);
      S(segs[0][0], 1.15, 18, segs[0][1], 6.5, 19, 'sand', shade);
    }
    // 内侧壁柱（增加纵向层次，同时打破长墙的单调）
    var zc = [-14, -7, 0, 7, 14];
    for (i = 0; i < zc.length; i++) {
      S(-20, 0, zc[i] - 0.5, -19.6, 6.5, zc[i] + 0.5, 'sand', 1.05);
      S(19.6, 0, zc[i] - 0.5, 20, 6.5, zc[i] + 0.5, 'sand', 1.05);
    }
    var xc = [-17.5, -9.5, -1.5, 8.5, 17];
    for (i = 0; i < xc.length; i++) {
      S(xc[i] - 0.5, 0, -18, xc[i] + 0.5, 6.5, -17.6, 'sand', 1.05);
      S(xc[i] - 0.5, 0, 17.6, xc[i] + 0.5, 6.5, 18, 'sand', 1.05);
    }
  })();

  /* ==========================================================================
   * 二、竖向分区墙（把地图切成 4 条南北向通道 + 中庭）
   *   V1: x[-14.4,-13.6] 长道 / 中庭      V2: x[5.6,6.4] 中庭 / 集市街
   *   V3: x[13.6,14.4] 集市街 / 绕后路    （均为 4.2m 高灰泥墙 + 石过梁门洞）
   * ======================================================================== */
  wallAlongZ(-14.4, -13.6, -18, 18, 4.2, 'wall', [
    [-16.2, -13.6], [-8.0, -5.4], [5.4, 8.0], [13.6, 16.2]
  ]);
  wallAlongZ(5.6, 6.4, -18, 18, 4.2, 'wall', [
    [-16.2, -13.6], [-8.6, -6.0], [6.0, 8.6], [13.6, 16.2]
  ]);
  wallAlongZ(13.6, 14.4, -18, 18, 4.2, 'wall', [
    [-16.2, -13.6], [8.0, 10.6], [13.6, 16.2]
  ]);

  /* ==========================================================================
   * 三、横向分区墙 + 出生大厅（CT 北 / T 南，南北基本镜像）
   * ======================================================================== */
  // CT 出生大厅南墙（中间 4.8m 宽拱门通向中庭）
  wallAlongX(-12.8, -12, -6.0, 5.6, 3.6, 'wall', [[-2.4, 2.4]]);
  // T 出生大厅北墙
  wallAlongX(12.0, 12.8, -6.0, 5.6, 3.6, 'wall', [[-2.4, 2.4]]);
  // CT 大厅西墙（2.5m 门通向 NW 后室）
  wallAlongZ(-6.8, -6.0, -18, -12, 4.2, 'wall', [[-16.4, -13.9]]);
  // T 大厅西墙
  wallAlongZ(-6.8, -6.0, 12, 18, 4.2, 'wall', [[13.9, 16.4]]);
  // NW / SW 后室与中庭之间的墙（2.8m 门洞）
  wallAlongX(-12.8, -12, -13.6, -6.8, 3.6, 'wall', [[-11.6, -8.8]]);
  wallAlongX(12.0, 12.8, -13.6, -6.8, 3.6, 'wall', [[-11.6, -8.8]]);
  // 集市街北 / 南分隔墙（2.6m 门洞，形成近战卡点）
  wallAlongX(-12.6, -12, 6.4, 13.6, 3.6, 'wall', [[9.2, 11.8]]);
  wallAlongX(12.0, 12.6, 6.4, 13.6, 3.6, 'wall', [[9.2, 11.8]]);

  /* ==========================================================================
   * 四、西侧长枪线（long）：x[-20,-14.4]，中心线 x≈-17.2 有 33m 通视
   *      掩体左右交错、每 3~5m 一个，均贴墙放置，中心线保持通畅
   * ======================================================================== */
  S(-20.0, 0, -12.6, -18.8, 1.5, -11.4, 'crate', 1.0);      // 木箱堆（西墙）
  S(-15.6, 0, -10.6, -14.4, 1.0, -8.6, 'sand', 0.98);       // 沙袋（东墙）
  S(-20.0, 0, -5.2, -18.8, 0.9, -4.0, 'crate', 0.96);       // 低木箱（可跳上）
  S(-15.4, 0, -3.8, -14.4, 1.1, -2.2, 'concrete', 1.02);    // 水泥墩
  S(-20.0, 0, 1.2, -18.9, 1.4, 2.4, 'crate', 1.04);
  S(-15.6, 0, 3.0, -14.4, 1.0, 5.0, 'sand', 1.0);
  S(-20.0, 0, 8.4, -18.8, 1.2, 9.6, 'crate', 0.98);
  S(-15.5, 0, 11.0, -14.4, 1.3, 12.6, 'metal', 0.94);       // 金属板掩体
  S(-20.0, 0, 15.2, -18.8, 1.1, 16.4, 'sand', 1.0);         // 长道南端（P1 玩家侧掩体）
  S(-15.5, 0, -13.4, -14.4, 1.1, -12.2, 'concrete', 1.0);   // 长道北段掩体
  S(-15.5, 0, -17.4, -14.4, 1.1, -16.2, 'sand', 1.0);       // 长道北端（P1 BOT 侧掩体）

  /* ==========================================================================
   * 五、中央中庭（mid）：纪念碑 + 柱门 + 西侧高台 + 市集摊 + 箱堆
   * ======================================================================== */
  // 中央纪念碑（2.6m 高，挡住北/南出生大厅之间的直射）
  S(-1.8, 0, -1.8, 1.8, 2.6, 1.8, 'brick', 0.97);
  S(-2.0, 2.6, -2.0, 2.0, 2.85, 2.0, 'stone', 1.02);        // 石质压顶
  // 西侧高台（0.9m）+ 0.45m 台阶（可自动上台阶，也可跳上高台）
  S(-13.6, 0, -4.6, -10.0, 0.9, 4.6, 'stone', 1.0);
  S(-10.0, 0, -2.0, -8.9, 0.45, 2.0, 'stone', 0.97);
  // 高台上的掩体
  S(-13.6, 0.9, 2.8, -12.3, 2.1, 4.0, 'crate', 1.0);
  S(-12.0, 0.9, -4.5, -10.8, 1.9, -3.3, 'crate', 0.96);
  S(-13.6, 0.9, -2.2, -12.2, 1.5, -0.8, 'sand', 1.0);
  // 中庭东南市集摊（1.0m 木柜台 + 遮阳棚装饰）
  S(0.6, 0, 6.6, 3.8, 1.0, 8.2, 'wood', 1.0);
  // 中庭西南矮墙
  S(-9.6, 0, 8.0, -6.0, 1.1, 8.7, 'brick', 0.98);
  // 中庭北部箱堆
  S(-8.8, 0, -12.0, -7.6, 1.3, -10.8, 'crate', 1.02);       // P4 BOT 侧掩体
  S(-13.6, 0, -14.8, -12.4, 1.2, -13.6, 'crate', 0.98);
  S(-4.8, 0, 4.6, -3.6, 0.9, 5.8, 'crate', 0.94);
  S(2.8, 0, 3.0, 4.6, 1.0, 3.7, 'sand', 0.98);
  // 中央柱门（四根石柱框住中庭南北入口，同时挡住贴边直射线）
  S(1.8, 0, -10.8, 2.6, 4.4, -10.0, 'brick', 1.03);
  S(-2.6, 0, -10.8, -1.8, 4.4, -10.0, 'brick', 1.03);
  S(1.8, 0, 10.0, 2.6, 4.4, 10.8, 'brick', 1.03);
  S(-2.6, 0, 10.0, -1.8, 4.4, 10.8, 'brick', 1.03);
  // 中部掩体（P2 双方侧后掩体 + 通道箱）
  S(-13.6, 0, 9.2, -12.4, 1.2, 10.4, 'crate', 1.0);         // P2 玩家侧掩体
  S(4.4, 0, -10.4, 5.6, 1.2, -9.2, 'crate', 0.98);          // P2 BOT 侧掩体
  S(-13.6, 0, 11.4, -12.4, 1.0, 12.0, 'sand', 1.0);         // P4 玩家侧掩体
  S(-4.4, 0, -6.4, -3.2, 0.9, -5.2, 'crate', 0.96);
  S(1.6, 0, -4.6, 2.8, 1.2, -3.4, 'crate', 1.0);

  /* ==========================================================================
   * 六、东侧集市街（short）：货柜 + 市场建筑 + 摊位 + 舞台高台
   * ======================================================================== */
  S(6.4, 0, -12.0, 8.8, 2.6, -8.8, 'metal', 0.92);          // 海运货柜
  S(6.4, 0, -3.6, 10.4, 3.0, 3.6, 'wall', 0.95);            // 市场建筑（实心）
  S(6.4, 3.0, -3.8, 10.6, 3.2, 3.8, 'roof', 0.92);          // 市场屋顶挑檐（贴 V2、东/南挑出）
  S(8.6, 0, -8.8, 11.0, 1.0, -7.2, 'wood', 1.02);           // 北侧摊位柜台
  S(9.4, 0, -5.0, 11.4, 1.0, -3.6, 'wood', 1.0);            // 市场街木摊（贴建筑北面）
  S(6.4, 0, -18.0, 7.6, 1.2, -16.8, 'crate', 0.98);         // 集北木箱
  S(12.4, 0, -12.0, 13.6, 1.2, -10.8, 'crate', 1.0);        // P3 BOT 侧掩体（贴 V3）
  S(12.8, 0, -6.8, 13.6, 1.2, -5.6, 'crate', 0.96);         // 短道东侧箱
  S(9.6, 0, -18.0, 11.2, 1.0, -17.3, 'sand', 1.0);          // 集北沙袋
  S(6.4, 0, 10.8, 7.6, 1.2, 12.0, 'crate', 1.0);            // 集南木箱（贴 V2）
  S(6.4, 0, 9.0, 7.6, 1.0, 9.7, 'sand', 0.98);              // 集南沙袋
  S(11.9, 0, 11.4, 13.6, 1.0, 12.0, 'sand', 1.0);           // P3 玩家侧掩体（贴 H_E2 / V3）
  // 舞台高台（0.9m，贴 V3 墙）+ 台阶（0.45m），短道里的制高点，同时让出南北主通道
  S(10.8, 0, 5.2, 13.6, 0.9, 8.0, 'stone', 1.0);
  S(9.6, 0, 5.8, 10.8, 0.45, 7.4, 'stone', 0.97);
  S(10.9, 0.9, 7.1, 12.1, 1.4, 7.9, 'sand', 0.98);          // 台上沙袋（低，不挡 P3 对枪线）
  S(12.4, 0.9, 6.9, 13.6, 2.1, 7.9, 'crate', 1.0);          // 台上木箱（靠 V3）
  // 东侧房间箱子
  S(6.4, 0, 12.6, 7.6, 1.2, 13.4, 'crate', 0.98);           // 贴 H_E2 南面 / V2 墙
  S(12.4, 0, 16.8, 13.6, 1.2, 18.0, 'crate', 1.0);          // 贴 V3 / 南墙

  /* ==========================================================================
   * 七、东侧绕后连接路（flank）：x[14.4,20]，B1~B4 左右交替矮墙形成 S 形
   * ======================================================================== */
  S(14.4, 0, -10.0, 17.0, 2.6, -8.0, 'brick', 1.0);          // B1（贴 V3，西侧堵）
  S(17.3, 0, -4.0, 20.0, 2.6, -2.0, 'brick', 0.96);          // B2（贴东墙，东侧堵）
  S(14.4, 0, 2.0, 17.0, 2.6, 4.0, 'brick', 1.0);             // B3（贴 V3，西侧堵）
  S(17.4, 0, 9.0, 20.0, 2.6, 11.0, 'brick', 0.96);           // B4（贴东墙，东侧堵）
  S(18.8, 0, -9.6, 20.0, 1.2, -8.4, 'crate', 1.0);           // 东墙木箱
  S(14.4, 0, -13.4, 15.6, 1.2, -12.2, 'crate', 0.98);        // 贴 V3 木箱
  S(14.4, 0, -0.8, 15.6, 1.1, 0.4, 'crate', 1.04);           // 窄道箱
  S(18.6, 0, -5.6, 20.0, 1.0, -4.9, 'sand', 1.0);            // 沙袋（贴东墙）
  S(14.4, 0, 6.6, 15.6, 1.1, 7.8, 'crate', 0.96);            // 贴 V3 木箱
  S(18.4, 0, 14.5, 20.0, 1.2, 15.7, 'crate', 1.0);           // 贴东墙木箱
  S(17.6, 0, -17.2, 18.8, 1.2, -16.0, 'crate', 1.0);         // 北端独立箱
  // 金属门板（贴墙装饰性碰撞体，模拟铁门）
  S(14.4, 0, -17.8, 14.6, 2.4, -16.6, 'metal', 1.02);
  S(14.4, 0, 10.6, 14.6, 2.4, 11.8, 'metal', 0.96);
  S(14.4, 0, 16.2, 14.6, 2.4, 17.4, 'metal', 0.98);
  // 墙面管线（无碰撞装饰性实体，仅增加工业感；分段放在壁柱之间的空档）
  S(-20, 3.4, -13.5, -19.78, 3.7, -7.5, 'metal', 1.05, false);
  S(-20, 3.4, 0.5, -19.78, 3.7, 6.5, 'metal', 1.05, false);
  S(19.78, 2.6, -13.5, 20, 2.9, -7.5, 'metal', 0.9, false);
  S(19.78, 2.6, 0.5, 20, 2.9, 6.5, 'metal', 0.9, false);

  /* ==========================================================================
   * 八、后室 / 出生大厅杂物
   * ======================================================================== */
  // NW 后室
  S(-13.6, 0, -18.0, -12.4, 1.2, -16.8, 'crate', 1.0);
  S(-11.8, 0, -18.0, -10.2, 1.0, -17.3, 'sand', 0.98);
  // SW 后室
  S(-13.6, 0, 16.8, -12.4, 1.2, 18.0, 'crate', 1.0);
  S(-11.8, 0, 17.3, -10.2, 1.0, 18.0, 'sand', 0.98);
  // CT 出生大厅
  S(-5.2, 0, -18.0, -4.0, 1.2, -16.8, 'crate', 1.0);
  S(3.6, 0, -18.0, 4.8, 1.0, -16.8, 'crate', 0.96);
  S(0.0, 0, -18.0, 1.8, 1.0, -17.3, 'sand', 1.0);
  // T 出生大厅
  S(-5.2, 0, 16.8, -4.0, 1.2, 18.0, 'crate', 1.0);
  S(3.6, 0, 16.8, 4.8, 1.0, 18.0, 'crate', 0.96);
  S(0.0, 0, 17.3, 1.8, 1.0, 18.0, 'sand', 1.0);

  /* ==========================================================================
   * 九、装饰（无碰撞）：摊位遮阳棚 / 油桶 / 路灯 / 绿植 / 牌 / 轮胎 / 桌 / 栅栏
   * ======================================================================== */
  // —— 长道 ——
  D('barrel', -19.2, 0, -14.65);
  D('rubble', -18.6, 0, -7.9);
  D('barrel', -16.2, 0, -12.0);
  D('tires', -16.4, 0, -1.6);
  D('plant', -19.0, 0, 5.8);
  D('lamp', -18.9, 0, 6.0);
  D('cratepile', -19.2, 0, 5.4);
  D('rubble', -18.8, 0, 10.3);
  D('sign', -14.46, 0, -4.5, Math.PI / 2, 1, 'L');
  D('sign', -14.46, 0, 9.0, Math.PI / 2, 1, 'L');
  // —— 中庭 ——
  D('awning', 2.2, 2.65, 7.4, 0, 1.25);
  D('table', 1.4, 0, 9.3, 0.2);
  D('barrel', 4.9, 0, 4.6);
  D('barrel', 4.85, 0, 1.9);
  D('crate', 3.0, 0, -6.8, 0.4, 0.9);
  D('plant', -2.6, 0, -7.6);
  D('cratepile', -8.0, 0, -6.0);
  D('tires', 4.9, 0, -8.1);
  D('lamp', -5.6, 0, -9.6);
  D('rubble', -11.0, 0, 10.4);
  D('sign', -13.42, 0.9, 0.0, Math.PI / 2, 1, 'M');
  D('fence', -8.9, 0, 11.4, 0);
  D('plant', -4.6, 0, 11.6);
  // —— 东侧集市街 ——
  D('awning', 10.2, 2.65, -5.7, 0.06, 1.2);
  D('table', 10.2, 0, -5.7);
  D('barrel', 13.08, 0, -4.4);
  D('plant', 13.0, 0, -9.0);
  D('lamp', 12.2, 0, -8.4);
  D('tires', 11.9, 0, -7.6);
  D('crate', 13.0, 0, 2.0, 0.3, 0.9);
  D('sign', 6.46, 0, 4.6, Math.PI / 2, 1, 'S');
  D('cratepile', 10.6, 0, 14.6);
  D('barrel', 12.9, 0, 13.0);
  D('lamp', 8.8, 0, 15.6);
  D('fence', 8.9, 0, 16.2, Math.PI / 2);
  // —— 绕后连接路 ——
  D('barrel', 19.0, 0, -11.0);
  D('tires', 15.2, 0, -6.0);
  D('rubble', 19.2, 0, -1.0);
  D('crate', 14.9, 0, 5.8, 0.5, 0.9);
  D('plant', 19.2, 0, 7.6);
  D('lamp', 18.9, 0, 14.2);
  D('barrel', 19.1, 0, -15.0);
  D('sign', 14.46, 0, -6.0, Math.PI / 2, 1, 'F');
  // —— 出生大厅 / 后室 ——
  D('sign', 2.6, 0, -16.6, 0, 1, 'CT');
  D('awning', 0.2, 2.65, -16.4, 0, 1.15);
  D('table', -4.8, 0, -13.4, 0.15);
  D('barrel', 2.8, 0, -13.2);
  D('plant', 4.9, 0, -13.6);
  D('sign', -2.6, 0, 16.6, Math.PI, 1, 'T');
  D('awning', 0.2, 2.65, 16.4, Math.PI, 1.15);
  D('barrel', -2.0, 0, 13.2);
  D('plant', 4.6, 0, 13.2);
  D('barrel', -8.0, 0, -13.2);
  D('cratepile', -12.0, 0, -14.0);
  D('tires', -12.6, 0, -16.0);
  D('barrel', -8.0, 0, 13.2);
  D('rubble', -12.4, 0, 14.4);
  D('fence', -8.6, 0, 16.6, Math.PI / 2);
  // —— 补充点缀（长道 / 中庭 / 集市街 / 绕后路 / 出生区）——
  D('barrel', -19.1, 0, -8.0);
  D('tires', -16.4, 0, 6.2);
  D('rubble', -19.0, 0, 12.4);
  D('cratepile', -15.4, 0, -6.4);
  D('crate', 0.4, 0, -3.0, 0.5, 0.9);
  D('barrel', -3.9, 0, 1.6);
  D('plant', 4.9, 0, 10.2);
  D('tires', -7.8, 0, -9.0);
  D('rubble', 1.0, 0, -7.4);
  D('barrel', 12.2, 0, -13.0);
  D('cratepile', 12.9, 0, 9.0);
  D('tires', 8.0, 0, 4.15);
  D('plant', 13.0, 0, 10.2);
  D('barrel', 8.6, 0, 10.9);
  D('crate', 12.0, 0, -14.4, 0.3, 0.9);
  D('barrel', 19.2, 0, -12.5);
  D('tires', 15.0, 0, -4.6);
  D('rubble', 18.8, 0, 2.2);
  D('crate', 14.9, 0, 6.2, 0.2, 0.9);
  D('plant', 18.9, 0, 12.0);
  D('barrel', 4.9, 0, -15.2);
  D('crate', 1.2, 0, -13.5, 0.35, 0.9);
  D('barrel', 4.9, 0, 15.2);
  D('crate', 1.2, 0, 13.5, 0.35, 0.9);
  D('plant', -7.6, 0, -16.6);
  D('tires', -8.2, 0, 16.4);

  /* ==========================================================================
   * 十、1v1 出生点（4 组，互相面对、18~30m、两侧 1.2~1.5m 内有实体掩体）
   *    yaw = 0 面向 -Z；yaw 增大向左（逆时针）。
   * ======================================================================== */
  // 根据 from -> to 求朝向：forward = [-sin(yaw), -cos(yaw)]
  function yawTo(from, to) {
    var dx = to[0] - from[0], dz = to[2] - from[2];
    return r3(Math.atan2(-dx, -dz));
  }
  var DUEL = [];
  function duelPair(ax, az, bx, bz) {
    var A = [r3(ax), 0, r3(az)], B = [r3(bx), 0, r3(bz)];
    DUEL.push({
      player: { pos: A, yaw: yawTo(A, B) },
      bot: { pos: B, yaw: yawTo(B, A) }
    });
  }
  // P1：西侧长道对角（AWM 长枪线，约 28.7m）
  duelPair(-18.6, 14.0, -16.2, -14.6);
  // P2：中庭西南 ↔ 东北对角（AK，约 23.2m）
  duelPair(-12.4, 8.0, 4.4, -8.0);
  // P3：集市街南北短道（约 19.6m，掩体在两侧）
  duelPair(11.4, 10.0, 12.4, -9.6);
  // P4：中庭西侧南北（跨越 0.9m 高台，约 18.7m）
  duelPair(-11.2, 8.8, -9.6, -9.8);

  /* ==========================================================================
   * 十一、Bot 导航路点（自动生成 links / cover，最终全部为纯数据）
   *   p[1] = 该点地面/平台顶面高度；links 双向；lane 标注区域
   * ======================================================================== */
  var RAW_WPS = [
    // long 西侧长枪线（中心线）
    [-17.2, -16.0, 'long'], [-17.2, -12.0, 'long'], [-17.2, -8.0, 'long'],
    [-17.2, -4.0, 'long'], [-17.2, 0.0, 'long'], [-17.2, 4.0, 'long'],
    [-17.2, 8.0, 'long'], [-17.2, 12.0, 'long'], [-17.2, 16.0, 'long'],
    // mid 中庭
    [-12.6, -6.7, 'mid'], [-12.6, 6.7, 'mid'],
    [-10.2, -10.2, 'mid'], [-10.2, 10.2, 'mid'],
    [0.0, -9.8, 'mid'], [3.6, -7.0, 'mid'], [4.6, 7.4, 'mid'],
    [-3.2, -3.6, 'mid'], [2.8, 0.8, 'mid'], [-3.6, 9.6, 'mid'],
    [3.0, 4.4, 'mid'], [-8.0, 6.8, 'mid'], [-7.0, -6.2, 'mid'],
    [0.0, 5.6, 'mid'],
    // 西侧高台 + 台阶（y 为平台/台阶顶面）
    [-11.4, 0.4, 'mid', 0.9], [-9.45, 0.0, 'mid', 0.45],
    // tunnel 西北 / 西南后室
    [-9.2, -15.2, 'tunnel'], [-11.4, -14.9, 'tunnel'],
    [-9.2, 15.2, 'tunnel'], [-11.4, 14.9, 'tunnel'],
    // spawn CT / T 出生大厅
    [4.4, -14.9, 'spawn'], [0.0, -14.4, 'spawn'], [-3.8, -14.4, 'spawn'],
    [3.8, 14.4, 'spawn'], [0.0, 14.8, 'spawn'], [-3.8, 14.4, 'spawn'],
    // short 东侧集市街 + 舞台高台
    [7.6, -15.4, 'short'], [12.4, -15.6, 'short'], [8.0, -6.6, 'short'],
    [12.0, -10.2, 'short'], [12.0, -6.2, 'short'], [12.0, -1.6, 'short'],
    [12.0, 2.4, 'short'], [12.2, 4.4, 'short'], [10.2, 6.5, 'short', 0.45], [12.6, 6.0, 'short', 0.9],
    [7.8, 5.2, 'short'], [7.8, 7.6, 'short'],
    [10.4, 10.6, 'short'], [10.4, 13.6, 'short'], [8.8, 14.9, 'short'],
    // flank 东侧绕后连接路
    [16.4, -14.8, 'flank'], [17.8, -9.0, 'flank'], [18.4, -7.0, 'flank'],
    [16.0, -3.0, 'flank'], [16.6, 0.6, 'flank'], [18.6, 5.0, 'flank'],
    [16.0, 9.4, 'flank'], [16.0, 12.6, 'flank'],
    [16.4, 15.0, 'flank']
  ];

  // 用实体盒子求某 (x,z) 的地面顶面高度（俯视逻辑，maxY 以内的最高顶面）
  function groundAt(x, z, maxY) {
    var top = (maxY === undefined) ? 3.0 : maxY;
    var best = -Infinity, i, s;
    for (i = 0; i < SOLIDS.length; i++) {
      s = SOLIDS[i];
      if (s.collision === false) continue;
      if (s.max[1] > top + 1e-9) continue;
      if (x >= s.min[0] - 1e-9 && x <= s.max[0] + 1e-9 && z >= s.min[2] - 1e-9 && z <= s.max[2] + 1e-9) {
        if (s.max[1] > best) best = s.max[1];
      }
    }
    return best === -Infinity ? 0 : best;
  }

  // 胶囊近似：站在 (x,z,y) 时身体是否与实体相交（台阶 <=0.45m 视为可自动上步，忽略）
  function capsuleBlocked(x, z, y, radius) {
    var i, s, top;
    for (i = 0; i < SOLIDS.length; i++) {
      s = SOLIDS[i];
      if (s.collision === false) continue;
      top = s.max[1];
      if (top <= y + 0.46 + 1e-9) continue;          // 可跨越的台阶
      if (s.min[1] >= y + 1.62) continue;            // 高于头顶
      var dx = 0, dz = 0;
      if (x < s.min[0]) dx = s.min[0] - x; else if (x > s.max[0]) dx = x - s.max[0];
      if (z < s.min[2]) dz = s.min[2] - z; else if (z > s.max[2]) dz = z - s.max[2];
      if (dx * dx + dz * dz < radius * radius) return s;
    }
    return null;
  }

  // 到实体盒的 2D 水平距离（0 = 在盒内）
  function distToSolid(x, z, s) {
    var dx = 0, dz = 0;
    if (x < s.min[0]) dx = s.min[0] - x; else if (x > s.max[0]) dx = x - s.max[0];
    if (z < s.min[2]) dz = s.min[2] - z; else if (z > s.max[2]) dz = z - s.max[2];
    return Math.sqrt(dx * dx + dz * dz);
  }

  // 在 A->B 上按 0.25m 采样检查是否可走过去（不穿墙、台阶差 <=0.5m）
  function linkWalkable(ax, az, ay, bx, bz, by) {
    var dist = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
    if (dist < 0.3) return false;
    if (Math.abs(ay - by) > 0.5) return false;
    var maxY = Math.max(ay, by) + 0.55;
    var g0 = groundAt(ax, az, maxY);
    if (Math.abs(g0 - ay) > 0.06) return false;
    var prev = g0, n = Math.ceil(dist / 0.25), k, x, z, g;
    for (k = 1; k <= n; k++) {
      var t = k / n;
      x = ax + (bx - ax) * t;
      z = az + (bz - az) * t;
      g = groundAt(x, z, maxY);
      if (g < -100) return false;
      if (g - prev > 0.5 || prev - g > 0.5) return false;
      prev = g;
      if (capsuleBlocked(x, z, g, 0.34)) return false;
    }
    if (Math.abs(prev - by) > 0.06) return false;
    return true;
  }

  // 路点掩体评分：附近 2.6m 内遮挡胸/头高度的实体加权（0 空旷 ~ 1 极佳）
  function coverScore(x, z, y) {
    var total = 0, i, s, top, d, val;
    var list = [];
    for (i = 0; i < SOLIDS.length; i++) {
      s = SOLIDS[i];
      if (s.collision === false) continue;
      top = s.max[1] - y;
      if (top < 0.5) continue;
      d = distToSolid(x, z, s);
      if (d > 2.8) continue;
      val = Math.min(1, top / 1.45) * Math.max(0, 1 - Math.max(0, d - 0.5) / 2.3);
      list.push(val);
    }
    list.sort(function (a, b) { return b - a; });
    for (i = 0; i < list.length && i < 3; i++) total += list[i];
    return Math.min(1, total * 0.52);
  }

  // —— 生成最终 waypoints ——
  var WPS = [];
  (function buildWaypoints() {
    var i, j, raw, y, candidates = [];
    for (i = 0; i < RAW_WPS.length; i++) {
      raw = RAW_WPS[i];
      y = typeof raw[3] === 'number' ? raw[3] : groundAt(raw[0], raw[1], 2.5);
      WPS.push({
        id: i,
        p: [r3(raw[0]), r3(y), r3(raw[1])],
        links: [],
        cover: r3(coverScore(raw[0], raw[1], y)),
        lane: raw[2]
      });
    }
    // 候选边（对称、限长 7m、不穿墙、台阶连续）
    var pairs = [];
    for (i = 0; i < WPS.length; i++) {
      for (j = i + 1; j < WPS.length; j++) {
        var a = WPS[i], b = WPS[j];
        var dist = Math.sqrt((a.p[0] - b.p[0]) * (a.p[0] - b.p[0]) + (a.p[2] - b.p[2]) * (a.p[2] - b.p[2]));
        if (dist > 7.0) continue;
        if (Math.abs(a.p[1] - b.p[1]) > 0.5) continue;
        pairs.push([dist, i, j]);
      }
    }
    pairs.sort(function (p, q) { return p[0] - q[0]; });
    for (i = 0; i < pairs.length; i++) {
      var d = pairs[i][0], ia = pairs[i][1], ib = pairs[i][2];
      if (d < 0.3) continue;
      var A = WPS[ia], B = WPS[ib];
      if (A.links.length >= 5 || B.links.length >= 5) continue;
      if (!linkWalkable(A.p[0], A.p[2], A.p[1], B.p[0], B.p[2], B.p[1])) continue;
      A.links.push(ib);
      B.links.push(ia);
    }
    // 排序 links 便于人工阅读
    for (i = 0; i < WPS.length; i++) {
      WPS[i].links.sort(function (m, n) { return m - n; });
    }
  })();

  /* ==========================================================================
   * 十二、轻量自检（可选接口；完整检查见 dev/mapcheck.js）
   * ======================================================================== */
  function validate() {
    var errors = [];
    var i, j, s, w, m;
    var MIN = [-21, 0, -19], MAX = [21, 10, 19];
    if (SOLIDS.length === 0 || SOLIDS.length > 450) errors.push('solids 数量异常: ' + SOLIDS.length);
    if (DECOR.length > 120) errors.push('decor 数量超过 120: ' + DECOR.length);
    function finite(v) { return typeof v === 'number' && isFinite(v); }
    for (i = 0; i < SOLIDS.length; i++) {
      s = SOLIDS[i];
      if (!MATS[s.mat]) { errors.push('solids[' + i + '] 材质非法: ' + s.mat); break; }
      if (!s.min || !s.max || s.min.length !== 3 || s.max.length !== 3) { errors.push('solids[' + i + '] min/max 结构错误'); break; }
      for (j = 0; j < 3; j++) {
        if (!finite(s.min[j]) || !finite(s.max[j])) { errors.push('solids[' + i + '] 坐标非有限数'); break; }
        if (s.max[j] <= s.min[j]) { errors.push('solids[' + i + '] 盒子尺寸非法'); break; }
      }
      if (s.min[0] < MIN[0] - 1e-6 || s.max[0] > MAX[0] + 1e-6 || s.min[2] < MIN[2] - 1e-6 || s.max[2] > MAX[2] + 1e-6) {
        errors.push('solids[' + i + '] 超出 bounds');
      }
    }
    for (i = 0; i < DECOR.length; i++) {
      if (!DECOR_TYPES[DECOR[i].type]) { errors.push('decor[' + i + '] type 非法: ' + DECOR[i].type); break; }
      for (j = 0; j < 3; j++) if (!finite(DECOR[i].pos[j])) { errors.push('decor[' + i + '] 坐标非有限数'); break; }
    }
    if (DUEL.length < 4) errors.push('duelSpawns 少于 4 组');
    for (i = 0; i < DUEL.length; i++) {
      var a = DUEL[i].player.pos, b = DUEL[i].bot.pos;
      var dd = Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[2] - b[2]) * (a[2] - b[2]));
      if (!(dd >= 18 && dd <= 30)) errors.push('duelSpawns[' + i + '] 间距 ' + dd.toFixed(2) + ' 不在 18~30m');
    }
    if (WPS.length < 35 || WPS.length > 60) errors.push('waypoints 数量 ' + WPS.length + ' 不在 35~60');
    var seen = {};
    for (i = 0; i < WPS.length; i++) {
      w = WPS[i];
      if (w.id !== i) errors.push('waypoints[' + i + '] id 不连续');
      if (!finite(w.p[0]) || !finite(w.p[1]) || !finite(w.p[2])) errors.push('waypoints[' + i + '] 坐标非有限数');
      if (!(w.cover >= 0 && w.cover <= 1)) errors.push('waypoints[' + i + '] cover 越界');
      for (j = 0; j < w.links.length; j++) {
        m = w.links[j];
        if (!(m >= 0 && m < WPS.length)) { errors.push('waypoints[' + i + '] link 越界'); continue; }
        if (WPS[m].links.indexOf(i) < 0) errors.push('waypoints[' + i + '] link ' + m + ' 不对称');
        seen[i + '-' + m] = 1;
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------------------------------------------------------------- 导出数据 */
  G.MAP = {
    name: 'de_dust_duel',
    bounds: { min: [-21, 0, -19], max: [21, 10, 19] },
    ambient: {
      sunDir: [0.45, 0.85, 0.28],
      sunColor: [1.0, 0.93, 0.80],
      ambientColor: [0.55, 0.55, 0.60],
      skyTop: [0.30, 0.52, 0.86],
      skyHorizon: [0.86, 0.80, 0.66],
      fogColor: [0.82, 0.76, 0.62],
      fogNear: 22,
      fogFar: 90
    },
    solids: SOLIDS,
    decor: DECOR,
    duelSpawns: DUEL,
    waypoints: WPS,
    validate: validate
  };
})();
