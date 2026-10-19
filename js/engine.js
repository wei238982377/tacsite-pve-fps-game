/* ============================================================
   AI GAME · 沙漠对决 — WebGL 渲染引擎 / 程序化纹理 / 物理 / 射线
   纯 WebGL1，无第三方库。坐标：Y 向上，yaw=0 面向 -Z，pos=脚底。
   ============================================================ */
"use strict";
(function () {
  var G = window.GAME = window.GAME || {};
  var M = G.M;
  if (!M) { throw new Error('engine.js 需要先加载 math.js'); }

  var gl = null;
  var canvas = null;
  var cssW = 1280, cssH = 720;
  var viewW = 1280, viewH = 720;
  var renderScale = 0.8;
  var inited = false;

  /* ---------------- 渲染状态 ---------------- */
  var cam = {
    eye: [0, 3, 0], yaw: 0, pitch: 0, fov: 90,
    right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
    proj: M.m4.create(), view: M.m4.create(), vp: M.m4.create(),
    vmProj: M.m4.create()
  };
  var env = {
    sunDir: [0.45, 0.85, 0.28], sunColor: [1.0, 0.94, 0.82], ambientColor: [0.52, 0.53, 0.58],
    skyTop: [0.28, 0.5, 0.86], skyHorizon: [0.84, 0.79, 0.66], fogColor: [0.82, 0.76, 0.63],
    fogNear: 24, fogFar: 95
  };
  var stats = { drawCalls: 0, triangles: 0 };
  var sunScreen = [-10, -10];

  /* ---------------- 网格数据 ---------------- */
  var mapSolids = [];          // {min,max,collision,mat}
  var mapGroups = [];          // {mat, tex, vbo, count}
  var flatMesh = null;         // 无纹理静态网格
  var whiteTex = null;
  var textures = {};
  var MATERIALS = {
    sand:     { tile: 2.6, tex: null },
    wall:     { tile: 2.4, tex: null },
    brick:    { tile: 1.8, tex: null },
    crate:    { tile: 1.1, tex: null },
    metal:    { tile: 1.6, tex: null },
    concrete: { tile: 2.2, tex: null },
    stone:    { tile: 1.9, tex: null },
    tarp:     { tile: 1.5, tex: null },
    wood:     { tile: 1.3, tex: null },
    roof:     { tile: 2.2, tex: null }
  };
  var MAT_NAMES = Object.keys(MATERIALS);

  /* ---------------- 着色器 ---------------- */
  var progWorld = null, progFlat = null, progSprite = null, progSky = null;
  var cube = null;      // unit cube：pos3 normal3
  var skyQuad = null;
  var dynBuf = null;    // 动态特效缓冲
  var dynCapacity = 0;
  var fxAlpha = null, fxAdd = null, fxShadow = null;   // FloatList

  /* ---------------- FloatList ---------------- */
  function FloatList(initial) {
    this.data = new Float32Array(initial || 4096);
    this.len = 0;
  }
  FloatList.prototype.ensure = function (n) {
    var need = this.len + n;
    if (need <= this.data.length) return;
    var cap = this.data.length;
    while (cap < need) cap *= 2;
    var nd = new Float32Array(cap);
    nd.set(this.data.subarray(0, this.len));
    this.data = nd;
  };
  FloatList.prototype.push3 = function (a, b, c) {
    this.ensure(3); var d = this.data, i = this.len;
    d[i] = a; d[i + 1] = b; d[i + 2] = c; this.len += 3;
  };
  FloatList.prototype.push4 = function (a, b, c, d0) {
    this.ensure(4); var d = this.data, i = this.len;
    d[i] = a; d[i + 1] = b; d[i + 2] = c; d[i + 3] = d0; this.len += 4;
  };

  /* ============================================================
     程序化纹理
     ============================================================ */
  function makeCanvas(size) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    return c;
  }
  function noiseRect(ctx, rng, size, count, colors, minS, maxS) {
    for (var i = 0; i < count; i++) {
      var x = rng() * size, y = rng() * size;
      var s = minS + rng() * (maxS - minS);
      ctx.fillStyle = colors[Math.floor(rng() * colors.length)];
      ctx.fillRect(x, y, s, s);
    }
  }

  function drawSand(ctx, size, rng) {
    ctx.fillStyle = '#c9ad78'; ctx.fillRect(0, 0, size, size);
    noiseRect(ctx, rng, size, 2600, ['#d6bd88', '#c0a06a', '#d0b27d', '#b99a66', '#e0c995'], 1, 3);
    // 细沙纹
    ctx.strokeStyle = 'rgba(120,95,58,0.10)';
    ctx.lineWidth = 1;
    for (var i = 0; i < 26; i++) {
      var y = rng() * size;
      ctx.beginPath();
      for (var x = 0; x <= size; x += 8) {
        var yy = y + Math.sin(x * 0.05 + i) * 3 + (rng() - 0.5) * 2;
        if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    noiseRect(ctx, rng, size, 90, ['rgba(90,70,44,0.35)', 'rgba(150,125,86,0.4)'], 1, 2);
  }

  function drawWall(ctx, size, rng) {
    ctx.fillStyle = '#cdbb97'; ctx.fillRect(0, 0, size, size);
    for (var i = 0; i < 80; i++) {
      ctx.fillStyle = 'rgba(' + Math.floor(140 + rng() * 55) + ',' + Math.floor(125 + rng() * 45) + ',' + Math.floor(95 + rng() * 40) + ',' + (0.05 + rng() * 0.10) + ')';
      var x = rng() * size, y = rng() * size, r = 8 + rng() * 44;
      ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.5 + rng() * 0.8), rng() * 3.14, 0, 6.283); ctx.fill();
    }
    // 裂纹
    ctx.strokeStyle = 'rgba(92,78,58,0.28)'; ctx.lineWidth = 1;
    for (var c = 0; c < 9; c++) {
      var x0 = rng() * size, y0 = rng() * size;
      ctx.beginPath(); ctx.moveTo(x0, y0);
      for (var s = 0; s < 5; s++) { x0 += (rng() - 0.5) * 26; y0 += rng() * 20; ctx.lineTo(x0, y0); }
      ctx.stroke();
    }
    noiseRect(ctx, rng, size, 1400, ['rgba(255,244,214,0.10)', 'rgba(120,103,76,0.08)'], 1, 3);
  }

  function drawBrick(ctx, size, rng) {
    ctx.fillStyle = '#d5c8a8'; ctx.fillRect(0, 0, size, size);
    var bh = size / 8, bw = size / 4;
    for (var row = 0; row < 8; row++) {
      var off = (row % 2) ? -bw / 2 : 0;
      for (var col = 0; col < 5; col++) {
        var x = col * bw + off + 2, y = row * bh + 2;
        var r = Math.floor(150 + rng() * 35), g = Math.floor(112 + rng() * 28), b = Math.floor(80 + rng() * 22);
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        ctx.fillRect(x, y, bw - 4, bh - 4);
        ctx.fillStyle = 'rgba(255,240,210,0.10)';
        ctx.fillRect(x, y, bw - 4, 2);
      }
    }
    noiseRect(ctx, rng, size, 900, ['rgba(80,60,40,0.12)', 'rgba(255,245,220,0.10)'], 1, 3);
  }

  function drawCrate(ctx, size, rng) {
    ctx.fillStyle = '#a9783f'; ctx.fillRect(0, 0, size, size);
    var plank = size / 5;
    for (var i = 0; i < 5; i++) {
      ctx.fillStyle = 'rgba(' + Math.floor(120 + rng() * 40) + ',' + Math.floor(80 + rng() * 30) + ',' + Math.floor(38 + rng() * 20) + ',0.8)';
      ctx.fillRect(0, i * plank + 1, size, plank - 2);
      ctx.fillStyle = 'rgba(60,40,20,0.5)';
      ctx.fillRect(0, i * plank, size, 2);
    }
    // 木纹
    ctx.strokeStyle = 'rgba(72,48,24,0.30)';
    for (var l = 0; l < 40; l++) {
      var y = rng() * size, x = rng() * size;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (var s = 0; s < 6; s++) { x += 10 + rng() * 20; y += (rng() - 0.5) * 3; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    // 金属包角
    ctx.fillStyle = '#5b5247';
    ctx.fillRect(0, 0, size, 8); ctx.fillRect(0, size - 8, size, 8);
    ctx.fillRect(0, 0, 8, size); ctx.fillRect(size - 8, 0, 8, size);
    ctx.fillStyle = '#8d8578';
    var bolts = [14, size - 14];
    for (var bx = 0; bx < 2; bx++) for (var by = 0; by < 2; by++) {
      ctx.beginPath(); ctx.arc(bolts[bx], bolts[by], 3, 0, 6.283); ctx.fill();
    }
    noiseRect(ctx, rng, size, 500, ['rgba(40,25,12,0.12)', 'rgba(255,220,160,0.06)'], 1, 2);
  }

  function drawMetal(ctx, size, rng) {
    ctx.fillStyle = '#7c8287'; ctx.fillRect(0, 0, size, size);
    for (var i = 0; i < 40; i++) {
      ctx.fillStyle = 'rgba(' + Math.floor(90 + rng() * 50) + ',' + Math.floor(95 + rng() * 50) + ',' + Math.floor(95 + rng() * 50) + ',0.25)';
      ctx.fillRect(0, rng() * size, size, 1 + rng() * 6);
    }
    // 划痕
    ctx.strokeStyle = 'rgba(215,220,225,0.22)'; ctx.lineWidth = 1;
    for (var s = 0; s < 60; s++) {
      var x = rng() * size, y = rng() * size, l = 4 + rng() * 26;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l, y + (rng() - 0.5) * 3); ctx.stroke();
    }
    // 铆钉
    for (var r = 0; r < 16; r++) {
      var rx = (r % 4) * (size / 4) + size / 8, ry = Math.floor(r / 4) * (size / 4) + size / 8;
      ctx.fillStyle = '#a9b0b4'; ctx.beginPath(); ctx.arc(rx, ry, 3, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(50,55,60,0.5)'; ctx.beginPath(); ctx.arc(rx + 1, ry + 1, 2, 0, 6.283); ctx.fill();
    }
    // 锈迹
    for (var u = 0; u < 10; u++) {
      ctx.fillStyle = 'rgba(120,72,38,' + (0.08 + rng() * 0.12) + ')';
      ctx.beginPath(); ctx.ellipse(rng() * size, rng() * size, 6 + rng() * 22, 4 + rng() * 14, rng() * 3, 0, 6.283); ctx.fill();
    }
  }

  function drawConcrete(ctx, size, rng) {
    ctx.fillStyle = '#9d9b93'; ctx.fillRect(0, 0, size, size);
    for (var i = 0; i < 100; i++) {
      ctx.fillStyle = 'rgba(' + Math.floor(140 + rng() * 40) + ',' + Math.floor(138 + rng() * 38) + ',' + Math.floor(130 + rng() * 35) + ',' + (0.06 + rng() * 0.12) + ')';
      ctx.beginPath(); ctx.ellipse(rng() * size, rng() * size, 4 + rng() * 30, 3 + rng() * 22, rng() * 3, 0, 6.283); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(60,58,52,0.30)';
    for (var c = 0; c < 7; c++) {
      var x = rng() * size, y = rng() * size;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (var s = 0; s < 4; s++) { x += (rng() - 0.5) * 30; y += rng() * 16; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    noiseRect(ctx, rng, size, 1000, ['rgba(40,40,38,0.12)', 'rgba(220,218,210,0.10)'], 1, 2);
  }

  function drawStone(ctx, size, rng) {
    ctx.fillStyle = '#b3a486'; ctx.fillRect(0, 0, size, size);
    var rows = 6, cols = 4, bh = size / rows, bw = size / cols;
    for (var r = 0; r < rows; r++) {
      var off = (r % 2) ? -bw / 2 : 0;
      for (var c = 0; c < cols + 1; c++) {
        var x = c * bw + off + 3, y = r * bh + 3;
        ctx.fillStyle = 'rgb(' + Math.floor(165 + rng() * 30) + ',' + Math.floor(152 + rng() * 26) + ',' + Math.floor(122 + rng() * 22) + ')';
        ctx.fillRect(x, y, bw - 6, bh - 6);
      }
    }
    noiseRect(ctx, rng, size, 900, ['rgba(90,80,60,0.15)', 'rgba(240,230,205,0.12)'], 1, 3);
  }

  function drawTarp(ctx, size, rng) {
    ctx.fillStyle = '#9e4138'; ctx.fillRect(0, 0, size, size);
    // 布褶
    for (var i = 0; i < 16; i++) {
      var x = rng() * size;
      ctx.fillStyle = 'rgba(' + Math.floor(130 + rng() * 60) + ',' + Math.floor(50 + rng() * 25) + ',' + Math.floor(42 + rng() * 20) + ',0.35)';
      ctx.fillRect(x, 0, 3 + rng() * 9, size);
    }
    ctx.strokeStyle = 'rgba(230,210,190,0.18)';
    for (var s = 0; s < 8; s++) {
      ctx.beginPath(); ctx.moveTo(0, rng() * size); ctx.lineTo(size, rng() * size); ctx.stroke();
    }
    noiseRect(ctx, rng, size, 400, ['rgba(40,15,12,0.12)', 'rgba(255,220,200,0.08)'], 1, 2);
  }

  function drawWood(ctx, size, rng) {
    ctx.fillStyle = '#8a5c34'; ctx.fillRect(0, 0, size, size);
    var plank = size / 6;
    for (var i = 0; i < 6; i++) {
      ctx.fillStyle = 'rgba(' + Math.floor(105 + rng() * 45) + ',' + Math.floor(66 + rng() * 30) + ',' + Math.floor(32 + rng() * 20) + ',0.85)';
      ctx.fillRect(0, i * plank + 1, size, plank - 3);
      ctx.fillStyle = 'rgba(45,28,14,0.5)';
      ctx.fillRect(0, i * plank, size, 2);
    }
    ctx.strokeStyle = 'rgba(52,32,16,0.35)';
    for (var l = 0; l < 36; l++) {
      var y = rng() * size, x = rng() * size;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (var s = 0; s < 6; s++) { x += 8 + rng() * 16; y += (rng() - 0.5) * 2; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    noiseRect(ctx, rng, size, 400, ['rgba(30,18,8,0.12)', 'rgba(255,220,170,0.06)'], 1, 2);
  }

  function drawRoof(ctx, size, rng) {
    ctx.fillStyle = '#5a4a3b'; ctx.fillRect(0, 0, size, size);
    var plank = size / 7;
    for (var i = 0; i < 7; i++) {
      ctx.fillStyle = 'rgba(' + Math.floor(74 + rng() * 26) + ',' + Math.floor(58 + rng() * 22) + ',' + Math.floor(42 + rng() * 18) + ',0.9)';
      ctx.fillRect(0, i * plank, size, plank - 2);
      ctx.fillStyle = 'rgba(25,18,12,0.45)';
      ctx.fillRect(0, i * plank + plank - 2, size, 2);
    }
    noiseRect(ctx, rng, size, 500, ['rgba(20,14,8,0.2)', 'rgba(140,120,95,0.08)'], 1, 3);
  }

  var TEX_DRAWERS = {
    sand: drawSand, wall: drawWall, brick: drawBrick, crate: drawCrate,
    metal: drawMetal, concrete: drawConcrete, stone: drawStone,
    tarp: drawTarp, wood: drawWood, roof: drawRoof
  };

  function createTexture(cv) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }

  function ensureTextures() {
    if (textures.__ready) return;
    for (var i = 0; i < MAT_NAMES.length; i++) {
      var name = MAT_NAMES[i];
      var cv = makeCanvas(256);
      var ctx = cv.getContext('2d');
      var rng = M.mulberry32(12345 + i * 977);
      TEX_DRAWERS[name](ctx, 256, rng);
      MATERIALS[name].tex = createTexture(cv);
      MATERIALS[name].debugCanvas = cv;
    }
    var wc = makeCanvas(2);
    var wctx = wc.getContext('2d');
    wctx.fillStyle = '#ffffff'; wctx.fillRect(0, 0, 2, 2);
    whiteTex = createTexture(wc);
    textures.__ready = true;
  }

  /* ============================================================
     着色器
     ============================================================ */
  function compileShader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(s) + '\n' + src);
    }
    return s;
  }

  function makeProgram(vsSrc, fsSrc, attrs, unis) {
    var p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
    }
    var o = { program: p, a: {}, u: {} };
    for (var i = 0; i < attrs.length; i++) o.a[attrs[i]] = gl.getAttribLocation(p, attrs[i]);
    for (var j = 0; j < unis.length; j++) o.u[unis[j]] = gl.getUniformLocation(p, unis[j]);
    return o;
  }

  var VS_WORLD = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'attribute vec3 aColor;',
    'attribute vec2 aUV;',
    'uniform mat4 uVP;',
    'varying vec3 vNormal;',
    'varying vec3 vColor;',
    'varying vec2 vUV;',
    'varying float vDepth;',
    'void main(){',
    '  vec4 cp = uVP * vec4(aPos, 1.0);',
    '  gl_Position = cp;',
    '  vNormal = aNormal;',
    '  vColor = aColor;',
    '  vUV = aUV;',
    '  vDepth = cp.w;',
    '}'
  ].join('\n');

  var FS_WORLD = [
    'precision highp float;',
    'varying vec3 vNormal;',
    'varying vec3 vColor;',
    'varying vec2 vUV;',
    'varying float vDepth;',
    'uniform sampler2D uTex;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunColor;',
    'uniform vec3 uAmbient;',
    'uniform vec3 uFogColor;',
    'uniform vec2 uFog;',
    'void main(){',
    '  vec3 n = normalize(vNormal);',
    '  float ndl = max(dot(n, uSunDir), 0.0);',
    '  float hemi = 0.5 + 0.5 * n.y;',
    '  vec3 light = uAmbient * (0.55 + 0.45 * hemi) + uSunColor * ndl;',
    '  vec4 tex = texture2D(uTex, vUV);',
    '  vec3 col = vColor * tex.rgb * light;',
    '  float fog = smoothstep(uFog.x, uFog.y, vDepth);',
    '  col = mix(col, uFogColor, fog * 0.92);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var VS_FLAT = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'uniform mat4 uVP;',
    'uniform mat4 uModel;',
    'varying vec3 vNormal;',
    'varying float vDepth;',
    'void main(){',
    '  vec4 wp = uModel * vec4(aPos, 1.0);',
    '  vec4 cp = uVP * wp;',
    '  gl_Position = cp;',
    '  vNormal = mat3(uModel) * aNormal;',
    '  vDepth = cp.w;',
    '}'
  ].join('\n');

  var FS_FLAT = [
    'precision highp float;',
    'varying vec3 vNormal;',
    'varying float vDepth;',
    'uniform vec3 uColor;',
    'uniform float uAlpha;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunColor;',
    'uniform vec3 uAmbient;',
    'uniform vec3 uFogColor;',
    'uniform vec2 uFog;',
    'void main(){',
    '  vec3 n = normalize(vNormal);',
    '  float ndl = max(dot(n, uSunDir), 0.0);',
    '  float hemi = 0.5 + 0.5 * n.y;',
    '  vec3 light = uAmbient * (0.55 + 0.45 * hemi) + uSunColor * ndl;',
    '  float fog = smoothstep(uFog.x, uFog.y, vDepth) * 0.92;',
    '  vec3 col = mix(uColor * light, uFogColor, fog);',
    '  gl_FragColor = vec4(col, uAlpha);',
    '}'
  ].join('\n');

  var VS_SPRITE = [
    'attribute vec3 aPos;',
    'attribute vec4 aColor;',
    'uniform mat4 uVP;',
    'varying vec4 vColor;',
    'void main(){ gl_Position = uVP * vec4(aPos, 1.0); vColor = aColor; }'
  ].join('\n');
  var FS_SPRITE = [
    'precision mediump float;',
    'varying vec4 vColor;',
    'void main(){ gl_FragColor = vColor; }'
  ].join('\n');

  var VS_SKY = [
    'attribute vec2 aPos;',
    'varying vec2 vUV;',
    'void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.999, 1.0); }'
  ].join('\n');
  var FS_SKY = [
    'precision mediump float;',
    'varying vec2 vUV;',
    'uniform vec3 uSkyTop;',
    'uniform vec3 uSkyHorizon;',
    'uniform vec3 uFogColor;',
    'uniform vec3 uSunColor;',
    'uniform float uHorizon;',
    'uniform vec2 uSunScreen;',
    'void main(){',
    '  float y = 1.0 - vUV.y;',
    '  float h = uHorizon;',
    '  vec3 col;',
    '  if (y < h) {',
    '    float t = clamp((h - y) / max(h, 0.001), 0.0, 1.0);',
    '    col = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 1.0, t));',
    '  } else {',
    '    float t = clamp((y - h) / max(1.0 - h, 0.001), 0.0, 1.0);',
    '    col = mix(uSkyHorizon, uFogColor * 0.86, smoothstep(0.0, 1.0, t));',
    '  }',
    '  vec2 d = vUV - uSunScreen;',
    '  col += uSunColor * 0.28 * exp(-dot(d, d) * 34.0);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ============================================================
     GL 资源初始化
     ============================================================ */
  function makeCube() {
    // 单位立方体 [-1,1]^3：pos3 + normal3
    var faces = [
      { n: [1, 0, 0], p: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
      { n: [-1, 0, 0], p: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
      { n: [0, 1, 0], p: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
      { n: [0, -1, 0], p: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
      { n: [0, 0, 1], p: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
      { n: [0, 0, -1], p: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }
    ];
    var verts = [];
    for (var f = 0; f < faces.length; f++) {
      var n = faces[f].n, p = faces[f].p;
      // quad -> 2 triangles: 0,1,2 / 0,2,3
      var idx = [0, 1, 2, 0, 2, 3];
      for (var i = 0; i < 6; i++) {
        var v = p[idx[i]];
        verts.push(v[0], v[1], v[2], n[0], n[1], n[2]);
      }
    }
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    return { vbo: vbo, count: verts.length / 6 };
  }

  function makeDynamicBuffer() {
    dynCapacity = 4096 * 7;
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, dynCapacity * 4, gl.DYNAMIC_DRAW);
    return buf;
  }
  function init(canvasEl) {
    if (inited) return { ok: true };
    canvas = canvasEl;
    var opts = { alpha: false, depth: true, stencil: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    try {
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch (e) { gl = null; }
    if (!gl) return { ok: false, error: '浏览器不支持 WebGL，请开启硬件加速或更换 Edge/Chrome。' };

    try {
      progWorld = makeProgram(VS_WORLD, FS_WORLD,
        ['aPos', 'aNormal', 'aColor', 'aUV'],
        ['uVP', 'uSunDir', 'uSunColor', 'uAmbient', 'uFogColor', 'uFog', 'uTex']);
      progFlat = makeProgram(VS_FLAT, FS_FLAT,
        ['aPos', 'aNormal'],
        ['uVP', 'uModel', 'uColor', 'uAlpha', 'uSunDir', 'uSunColor', 'uAmbient', 'uFogColor', 'uFog']);
      progSprite = makeProgram(VS_SPRITE, FS_SPRITE, ['aPos', 'aColor'], ['uVP']);
      progSky = makeProgram(VS_SKY, FS_SKY, ['aPos'], ['uSkyTop', 'uSkyHorizon', 'uFogColor', 'uSunColor', 'uHorizon', 'uSunScreen']);
    } catch (e) {
      return { ok: false, error: '着色器初始化失败: ' + (e && e.message ? e.message : e) };
    }

    cube = makeCube();
    ensureTextures();
    dynBuf = makeDynamicBuffer();
    fxAlpha = new FloatList(4096);
    fxAdd = new FloatList(4096);
    fxShadow = new FloatList(4096);
    skyQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, skyQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clearColor(env.fogColor[0], env.fogColor[1], env.fogColor[2], 1);
    inited = true;
    resize();
    return { ok: true };
  }

  function resize() {
    if (!gl) return;
    cssW = Math.max(320, window.innerWidth || 1280);
    cssH = Math.max(240, window.innerHeight || 720);
    viewW = Math.max(320, Math.round(cssW * renderScale));
    viewH = Math.max(180, Math.round(cssH * renderScale));
    if (canvas.width !== viewW) canvas.width = viewW;
    if (canvas.height !== viewH) canvas.height = viewH;
    gl.viewport(0, 0, viewW, viewH);
  }

  function setRenderScale(s) {
    renderScale = M.clamp(s, 0.4, 1.0);
    resize();
  }
  function getRenderScale() { return renderScale; }
  function getViewSize() { return [viewW, viewH]; }

  /* ============================================================
     环境 / 相机
     ============================================================ */
  function applyEnv(mapEnv) {
    if (!mapEnv) return;
    if (mapEnv.sunDir) {
      var d = M.v3.norm([0, 0, 0], mapEnv.sunDir);
      env.sunDir = d;
    }
    if (mapEnv.sunColor) env.sunColor = mapEnv.sunColor.slice();
    if (mapEnv.ambientColor) env.ambientColor = mapEnv.ambientColor.slice();
    if (mapEnv.skyTop) env.skyTop = mapEnv.skyTop.slice();
    if (mapEnv.skyHorizon) env.skyHorizon = mapEnv.skyHorizon.slice();
    if (mapEnv.fogColor) env.fogColor = mapEnv.fogColor.slice();
    if (typeof mapEnv.fogNear === 'number') env.fogNear = mapEnv.fogNear;
    if (typeof mapEnv.fogFar === 'number') env.fogFar = mapEnv.fogFar;
    if (gl) gl.clearColor(env.fogColor[0], env.fogColor[1], env.fogColor[2], 1);
  }

  function setCamera(eye, yaw, pitch, fov) {
    cam.eye[0] = eye[0]; cam.eye[1] = eye[1]; cam.eye[2] = eye[2];
    cam.yaw = yaw; cam.pitch = pitch;
    cam.fov = fov || 90;
    M.forwardFrom(yaw, pitch, cam.forward);
    M.rightFrom(yaw, cam.right);
    M.v3.cross(cam.up, cam.right, cam.forward);
    var aspect = viewW / viewH;
    M.m4.perspective(cam.proj, cam.fov * M.DEG, aspect, 0.05, 260);
    M.m4.view(cam.view, cam.eye, yaw, pitch);
    M.m4.multiply(cam.vp, cam.proj, cam.view);
    M.m4.perspective(cam.vmProj, 54 * M.DEG, aspect, 0.01, 8);
    updateHorizon();
  }

  var horizonY = 0.52;
  function updateHorizon() {
    var t = Math.tan(cam.pitch) / Math.tan(cam.fov * M.DEG / 2);
    horizonY = M.clamp(0.5 + t * 0.5, -0.5, 1.5);
  }
  function updateSunScreen() {
    var p = [cam.eye[0] + env.sunDir[0] * 120, cam.eye[1] + env.sunDir[1] * 120, cam.eye[2] + env.sunDir[2] * 120];
    var clip = [0, 0, 0];
    M.m4.transformPoint(clip, cam.vp, p);
    // transformPoint 已做透视除法；检查是否在相机前方
    var fwdDot = M.v3.dot(env.sunDir, cam.forward);
    if (fwdDot <= 0.01) { sunScreen = [-10, -10]; return; }
    sunScreen = [clip[0] * 0.5 + 0.5, 0.5 - clip[1] * 0.5];
  }
  // transformPoint 带透视除法，因此这里手动做一次投影
  function projectSun() {
    var m = cam.vp;
    var x = cam.eye[0] + env.sunDir[0] * 120;
    var y = cam.eye[1] + env.sunDir[1] * 120;
    var z = cam.eye[2] + env.sunDir[2] * 120;
    var cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    var cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    var cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    var fwdDot = M.v3.dot(env.sunDir, cam.forward);
    if (cw <= 0.001 || fwdDot <= 0.02) { sunScreen = [-10, -10]; return; }
    sunScreen = [(cx / cw) * 0.5 + 0.5, 0.5 - (cy / cw) * 0.5];
  }

  /* ============================================================
     静态网格构建
     ============================================================ */
  function faceShade(n) {
    if (n[1] > 0.5) return 1.04;
    if (n[1] < -0.5) return 0.72;
    return 0.92;
  }

  /* 盒子 6 个面：p0 为起点，e1/e2 为两条实际边长向量，cross(e1,e2)=法线（逆时针） */
  var BOX_FACES = [
    { n: [1, 0, 0], p: function (a, b) { return [b[0], a[1], b[2]]; }, e1: function (a, b) { return [0, 0, a[2] - b[2]]; }, e2: function (a, b) { return [0, b[1] - a[1], 0]; } },
    { n: [-1, 0, 0], p: function (a, b) { return [a[0], a[1], a[2]]; }, e1: function (a, b) { return [0, 0, b[2] - a[2]]; }, e2: function (a, b) { return [0, b[1] - a[1], 0]; } },
    { n: [0, 1, 0], p: function (a, b) { return [a[0], b[1], b[2]]; }, e1: function (a, b) { return [b[0] - a[0], 0, 0]; }, e2: function (a, b) { return [0, 0, a[2] - b[2]]; } },
    { n: [0, -1, 0], p: function (a, b) { return [a[0], a[1], a[2]]; }, e1: function (a, b) { return [b[0] - a[0], 0, 0]; }, e2: function (a, b) { return [0, 0, b[2] - a[2]]; } },
    { n: [0, 0, 1], p: function (a, b) { return [a[0], a[1], b[2]]; }, e1: function (a, b) { return [b[0] - a[0], 0, 0]; }, e2: function (a, b) { return [0, b[1] - a[1], 0]; } },
    { n: [0, 0, -1], p: function (a, b) { return [b[0], a[1], a[2]]; }, e1: function (a, b) { return [a[0] - b[0], 0, 0]; }, e2: function (a, b) { return [0, b[1] - a[1], 0]; } }
  ];
  function checkBoxFaces() {
    var a = [-1, -1, -1], b = [1, 1, 1];
    for (var i = 0; i < BOX_FACES.length; i++) {
      var f = BOX_FACES[i];
      var e1 = f.e1(a, b), e2 = f.e2(a, b);
      var c = M.v3.norm([0, 0, 0], M.v3.cross([0, 0, 0], e1, e2));
      if (Math.abs(c[0] - f.n[0]) + Math.abs(c[1] - f.n[1]) + Math.abs(c[2] - f.n[2]) > 0.01) {
        throw new Error('BOX_FACES 法线/绕序不匹配: ' + i);
      }
    }
  }
  checkBoxFaces();

  function builderFor(mat) {
    if (!builderMap[mat]) builderMap[mat] = new FloatList(8192);
    return builderMap[mat];
  }
  var builderMap = {};
  var flatBuilder = null;

  function addQuadTo(list, p0, p1, p2, p3, n, uvs, color) {
    var idx = [0, 1, 2, 0, 2, 3];
    var ps = [p0, p1, p2, p3];
    for (var i = 0; i < 6; i++) {
      var k = idx[i], p = ps[k], uv = uvs[k];
      list.push3(p[0], p[1], p[2]);
      list.push3(n[0], n[1], n[2]);
      list.push3(color, color, color);
      list.ensure(2); list.data[list.len++] = uv[0]; list.data[list.len++] = uv[1];
    }
  }

  // 向材质组添加轴对齐盒子（地图实体）
  function addTexturedBox(list, min, max, mat, shade) {
    var tile = (MATERIALS[mat] || MATERIALS.wall).tile;
    for (var i = 0; i < BOX_FACES.length; i++) {
      var f = BOX_FACES[i];
      if (f.n[1] < -0.5) continue; // 底面不画
      var p0 = f.p(min, max);
      var e1 = f.e1(min, max), e2 = f.e2(min, max), n = f.n;
      var p1 = [p0[0] + e1[0], p0[1] + e1[1], p0[2] + e1[2]];
      var p2 = [p1[0] + e2[0], p1[1] + e2[1], p1[2] + e2[2]];
      var p3 = [p0[0] + e2[0], p0[1] + e2[1], p0[2] + e2[2]];
      // 贴图坐标使用世界坐标投影（保证墙面纹理平铺一致）
      var uvs;
      if (Math.abs(n[0]) > 0.5) {
        uvs = [[p0[2] / tile, p0[1] / tile], [p1[2] / tile, p1[1] / tile], [p2[2] / tile, p2[1] / tile], [p3[2] / tile, p3[1] / tile]];
      } else if (Math.abs(n[2]) > 0.5) {
        uvs = [[p0[0] / tile, p0[1] / tile], [p1[0] / tile, p1[1] / tile], [p2[0] / tile, p2[1] / tile], [p3[0] / tile, p3[1] / tile]];
      } else {
        uvs = [[p0[0] / tile, p0[2] / tile], [p1[0] / tile, p1[2] / tile], [p2[0] / tile, p2[2] / tile], [p3[0] / tile, p3[2] / tile]];
      }
      var midY = (min[1] + max[1]) * 0.5;
      var ao = 0.80 + 0.20 * M.clamp(midY / 3.2, 0, 1);
      var jitter = 0.96 + 0.08 * M.hash2(min[0] + i * 1.7, min[2] + i * 2.3);
      var col = (shade === undefined ? 1 : shade) * faceShade(n) * ao * jitter;
      addQuadTo(list, p0, p1, p2, p3, n, uvs, col);
    }
  }

  // 任意朝向的盒子（装饰/视觉），写入材质组或 flat 组
  function addOrientedBox(center, size, yaw, material, shade, useFlat, flatColor) {
    var hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
    var cy = Math.cos(yaw || 0), sy = Math.sin(yaw || 0);
    var list = useFlat ? flatBuilder : builderFor(material);
    var tile = (MATERIALS[material] || MATERIALS.wall).tile;
    var lmin = [-hx, -hy, -hz], lmax = [hx, hy, hz];
    for (var i = 0; i < BOX_FACES.length; i++) {
      var f = BOX_FACES[i];
      if (f.n[1] < -0.5) continue; // 底面不画
      var n = [f.n[0] * cy + f.n[2] * sy, f.n[1], -f.n[0] * sy + f.n[2] * cy];
      var lp0 = f.p(lmin, lmax);
      var le1 = f.e1(lmin, lmax), le2 = f.e2(lmin, lmax);
      var lp1 = [lp0[0] + le1[0], lp0[1] + le1[1], lp0[2] + le1[2]];
      var lp2 = [lp1[0] + le2[0], lp1[1] + le2[1], lp1[2] + le2[2]];
      var lp3 = [lp0[0] + le2[0], lp0[1] + le2[1], lp0[2] + le2[2]];
      function toWorld(lp2) {
        return [center[0] + lp2[0] * cy + lp2[2] * sy, center[1] + lp2[1], center[2] - lp2[0] * sy + lp2[2] * cy];
      }
      var p0 = toWorld(lp0), p1 = toWorld(lp1), p2 = toWorld(lp2), p3 = toWorld(lp3);
      if (useFlat) {
        addQuadColorTo(list, p0, p1, p2, p3, n, flatColor);
      } else {
        var uvs;
        if (Math.abs(n[0]) > 0.5) {
          uvs = [[p0[2] / tile, p0[1] / tile], [p1[2] / tile, p1[1] / tile], [p2[2] / tile, p2[1] / tile], [p3[2] / tile, p3[1] / tile]];
        } else if (Math.abs(n[2]) > 0.5) {
          uvs = [[p0[0] / tile, p0[1] / tile], [p1[0] / tile, p1[1] / tile], [p2[0] / tile, p2[1] / tile], [p3[0] / tile, p3[1] / tile]];
        } else {
          uvs = [[p0[0] / tile, p0[2] / tile], [p1[0] / tile, p1[2] / tile], [p2[0] / tile, p2[2] / tile], [p3[0] / tile, p3[2] / tile]];
        }
        var col = (shade === undefined ? 1 : shade) * faceShade(n);
        addQuadTo(list, p0, p1, p2, p3, n, uvs, col);
      }
    }
  }

  // flat 网格：pos3 + normal3 + color3 + uv2（uv=0，使用白色贴图）
  function addQuadColorTo(list, p0, p1, p2, p3, n, color) {
    var idx = [0, 1, 2, 0, 2, 3];
    var ps = [p0, p1, p2, p3];
    for (var i = 0; i < 6; i++) {
      var p = ps[idx[i]];
      list.push3(p[0], p[1], p[2]);
      list.push3(n[0], n[1], n[2]);
      list.push3(color[0], color[1], color[2]);
      list.ensure(2); list.data[list.len++] = 0; list.data[list.len++] = 0;
    }
  }

  function addFlatBox(center, size, yaw, color, shade) {
    var c = [color[0] * (shade || 1), color[1] * (shade || 1), color[2] * (shade || 1)];
    addOrientedBox(center, size, yaw, null, undefined, true, c);
  }

  function addFlatCylinder(cx, cy, cz, radius, height, segments, color, capColor) {
    var y0 = cy, y1 = cy + height;
    var prev = null;
    for (var i = 0; i <= segments; i++) {
      var a = i / segments * Math.PI * 2;
      var x = cx + Math.cos(a) * radius, z = cz + Math.sin(a) * radius;
      var p = [x, y0, z];
      if (prev) {
        var n = [Math.cos(a - Math.PI / segments), 0, Math.sin(a - Math.PI / segments)];
        addQuadColorTo(flatBuilder,
          [prev.x, y1, prev.z], [x, y1, z], [x, y0, z], [prev.x, y0, prev.z], n, color);
      }
      prev = { x: x, z: z };
    }
    // 顶盖（三角扇，注意绕序保证正面朝上）
    for (var j = 0; j < segments; j++) {
      var aa = j / segments * Math.PI * 2, ab = (j + 1) / segments * Math.PI * 2;
      var ra = [cx + Math.cos(aa) * radius, y1, cz + Math.sin(aa) * radius];
      var rb = [cx + Math.cos(ab) * radius, y1, cz + Math.sin(ab) * radius];
      addQuadColorTo(flatBuilder, [cx, y1, cz], rb, ra, [cx, y1, cz], [0, 1, 0], capColor || color);
    }
  }

  /* ---------------- 装饰物 ---------------- */
  var PROP_COLORS = {
    barrelA: [0.38, 0.30, 0.22], barrelB: [0.25, 0.33, 0.30], barrelC: [0.42, 0.28, 0.24],
    sandbag: [0.56, 0.49, 0.34], lampPole: [0.25, 0.26, 0.28], lampHead: [0.55, 0.52, 0.42],
    leafA: [0.24, 0.38, 0.18], leafB: [0.32, 0.46, 0.22], pot: [0.45, 0.27, 0.16],
    signBoard: [0.55, 0.42, 0.22], tire: [0.12, 0.12, 0.13],
    tarpA: [0.62, 0.23, 0.18], tarpB: [0.23, 0.35, 0.25], woodDark: [0.36, 0.24, 0.13]
  };

  function buildDecor(d) {
    var p = d.pos || [0, 0, 0];
    var rot = d.rot || 0;
    var s = d.scale || 1;
    var x = p[0], y = p[1], z = p[2];
    switch (d.type) {
      case 'barrel': {
        var pal = [PROP_COLORS.barrelA, PROP_COLORS.barrelB, PROP_COLORS.barrelC][Math.floor(M.hash2(x, z) * 3) % 3];
        addFlatCylinder(x, y, z, 0.27 * s, 0.85 * s, 10, pal, [pal[0] * 0.72, pal[1] * 0.72, pal[2] * 0.72]);
        addFlatCylinder(x, y + 0.85 * s, z, 0.265 * s, 0.02, 10, [0.18, 0.18, 0.19], [0.18, 0.18, 0.19]);
        addFlatCylinder(x, y + 0.28 * s, z, 0.285 * s, 0.05, 10, [0.18, 0.18, 0.2], [0.18, 0.18, 0.2]);
        addFlatCylinder(x, y + 0.58 * s, z, 0.285 * s, 0.05, 10, [0.18, 0.18, 0.2], [0.18, 0.18, 0.2]);
        break;
      }
      case 'crate': {
        var cs = 0.7 * s;
        addOrientedBox([x, y + cs / 2, z], [cs, cs, cs], rot, 'crate', 1, false, null);
        break;
      }
      case 'cratepile': {
        var rng = M.mulberry32(Math.floor((x + 100) * 73 + (z + 100) * 131));
        var base = 0.68 * s;
        var n = 3 + Math.floor(rng() * 3);
        for (var i = 0; i < n; i++) {
          var layer = i < 2 ? 0 : (i < 4 ? 1 : 2);
          var ox = (rng() - 0.5) * 0.6 * s, oz = (rng() - 0.5) * 0.6 * s;
          var yy = y + base / 2 + layer * base * 0.98;
          addOrientedBox([x + ox, yy, z + oz], [base, base, base], rot + (rng() - 0.5) * 0.6, 'crate', 1, false, null);
        }
        break;
      }
      case 'sandbags': {
        for (var r = 0; r < 3; r++) {
          for (var c = 0; c < 3 - r; c++) {
            var bx = x + (c - (2 - r) / 2) * 0.56 * s * Math.cos(rot) + (r % 2) * 0.05;
            var bz = z - (c - (2 - r) / 2) * 0.56 * s * Math.sin(rot);
            addFlatBox([bx, y + 0.13 + r * 0.24, bz], [0.55 * s, 0.24, 0.34 * s], rot, PROP_COLORS.sandbag, 0.94 + r * 0.03);
          }
        }
        break;
      }
      case 'lamp': {
        addFlatBox([x, y + 1.6, z], [0.12, 3.2, 0.12], rot, PROP_COLORS.lampPole, 1);
        addFlatBox([x, y + 3.2, z], [0.42, 0.16, 0.42], rot, PROP_COLORS.lampPole, 0.8);
        addFlatBox([x, y + 3.1, z], [0.3, 0.08, 0.3], rot, [1.0, 0.88, 0.55], 1);
        break;
      }
      case 'plant': {
        addFlatCylinder(x, y, z, 0.28 * s, 0.42 * s, 8, PROP_COLORS.pot, [0.55, 0.33, 0.2]);
        var lr = M.mulberry32(Math.floor(x * 17 + z * 31) + 7);
        for (var l = 0; l < 5; l++) {
          var lx = x + (lr() - 0.5) * 0.5, lz = z + (lr() - 0.5) * 0.5;
          addFlatBox([lx, y + 0.55 + lr() * 0.3, lz], [0.12, 0.5 + lr() * 0.2, 0.12], lr() * 3, l % 2 ? PROP_COLORS.leafA : PROP_COLORS.leafB, 1);
        }
        break;
      }
      case 'sign': {
        addFlatBox([x, y + 1.35, z], [0.08, 2.7, 0.08], rot, PROP_COLORS.lampPole, 1);
        addFlatBox([x, y + 2.35, z], [1.5 * s, 0.75 * s, 0.08], rot, PROP_COLORS.signBoard, 1);
        break;
      }
      case 'rubble': {
        var rr = M.mulberry32(Math.floor(x * 13 + z * 19) + 3);
        for (var k = 0; k < 7; k++) {
          addFlatBox([x + (rr() - 0.5) * 1.4 * s, y + 0.06 + rr() * 0.12, z + (rr() - 0.5) * 1.4 * s],
            [0.18 + rr() * 0.3, 0.1 + rr() * 0.16, 0.18 + rr() * 0.3], rr() * 3, [0.5, 0.45, 0.35], 0.85 + rr() * 0.2);
        }
        break;
      }
      case 'tires': {
        for (var t = 0; t < 3; t++) {
          addFlatCylinder(x + (t % 2) * 0.05, y + t * 0.16, z, 0.36 * s, 0.15, 12, PROP_COLORS.tire, [0.08, 0.08, 0.09]);
        }
        break;
      }
      case 'awning': {
        // 布篷：倾斜薄板 + 两根支柱
        var wy = y;
        addFlatBox([x, wy - 0.12, z], [3.2 * s, 0.06, 2.0 * s], rot, [0.62, 0.24, 0.2], 1);
        var cx = Math.cos(rot), sx = Math.sin(rot);
        addFlatBox([x + cx * 1.4 * s, wy - 0.02, z - sx * 1.4 * s], [0.08, 0.1, 2.0 * s], rot, PROP_COLORS.woodDark, 1);
        addFlatBox([x - cx * 1.4 * s, wy - 0.02, z + sx * 1.4 * s], [0.08, 0.1, 2.0 * s], rot, PROP_COLORS.woodDark, 1);
        addFlatBox([x + cx * 2.2 * s, wy - 1.3, z - sx * 2.2 * s], [0.1, 2.6, 0.1], rot, PROP_COLORS.woodDark, 1);
        addFlatBox([x - cx * 2.2 * s, wy - 1.3, z + sx * 2.2 * s], [0.1, 2.6, 0.1], rot, PROP_COLORS.woodDark, 1);
        break;
      }
      case 'table': {
        addFlatBox([x, y + 0.72, z], [1.2 * s, 0.08, 0.7 * s], rot, PROP_COLORS.woodDark, 1.05);
        var tx = Math.cos(rot), tz = Math.sin(rot);
        var hx = 0.5 * s * tx, hz = -0.5 * s * tz;
        var dx = 0.28 * s * tz, dz = 0.28 * s * tx;
        addFlatBox([x + hx + dx, y + 0.36, z + hz + dz], [0.08, 0.72, 0.08], rot, PROP_COLORS.woodDark, 0.9);
        addFlatBox([x + hx - dx, y + 0.36, z + hz - dz], [0.08, 0.72, 0.08], rot, PROP_COLORS.woodDark, 0.9);
        addFlatBox([x - hx + dx, y + 0.36, z - hz + dz], [0.08, 0.72, 0.08], rot, PROP_COLORS.woodDark, 0.9);
        addFlatBox([x - hx - dx, y + 0.36, z - hz - dz], [0.08, 0.72, 0.08], rot, PROP_COLORS.woodDark, 0.9);
        break;
      }
      case 'fence': {
        var fx = Math.cos(rot), fz = Math.sin(rot);
        for (var post = -1; post <= 1; post++) {
          addFlatBox([x + fx * post * 1.1 * s, y + 0.55, z - fz * post * 1.1 * s], [0.1, 1.1, 0.1], rot, PROP_COLORS.woodDark, 1);
        }
        addFlatBox([x, y + 0.8, z], [2.4 * s, 0.1, 0.06], rot, PROP_COLORS.woodDark, 1.05);
        addFlatBox([x, y + 0.4, z], [2.4 * s, 0.1, 0.06], rot, PROP_COLORS.woodDark, 1.05);
        break;
      }
      default: {
        addFlatBox([x, y + 0.3 * s, z], [0.6 * s, 0.6 * s, 0.6 * s], rot, [0.45, 0.4, 0.3], 1);
      }
    }
  }

  function buildMap(map) {
    if (!gl || !map) return;
    ensureTextures();
    mapSolids = [];
    builderMap = {};
    flatBuilder = new FloatList(16384);
    checkBoxFaces();
    var solids = map.solids || [];
    for (var i = 0; i < solids.length; i++) {
      var s = solids[i];
      if (!s || !s.min || !s.max) continue;
      var min = [Math.min(s.min[0], s.max[0]), Math.min(s.min[1], s.max[1]), Math.min(s.min[2], s.max[2])];
      var max = [Math.max(s.min[0], s.max[0]), Math.max(s.min[1], s.max[1]), Math.max(s.min[2], s.max[2])];
      if (!isFinite(min[0]) || !isFinite(max[0])) continue;
      if (max[0] - min[0] < 0.02 || max[2] - min[2] < 0.02) continue;
      var mat = MATERIALS[s.mat] ? s.mat : 'wall';
      addTexturedBox(builderFor(mat), min, max, mat, typeof s.shade === 'number' ? s.shade : 1);
      if (s.collision !== false) {
        mapSolids.push({ min: min, max: max, mat: mat, solidRef: s });
      }
    }
    var decor = map.decor || [];
    for (var d = 0; d < decor.length; d++) buildDecor(decor[d]);

    // 生成 GPU buffer
    mapGroups = [];
    for (var m = 0; m < MAT_NAMES.length; m++) {
      var name = MAT_NAMES[m];
      var list = builderMap[name];
      if (!list || list.len === 0) continue;
      var vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, list.data.subarray(0, list.len), gl.STATIC_DRAW);
      mapGroups.push({ mat: name, tex: MATERIALS[name].tex, vbo: vbo, count: list.len / 11 });
    }
    flatMesh = null;
    if (flatBuilder.len > 0) {
      flatMesh = { vbo: gl.createBuffer(), count: flatBuilder.len / 11 };
      gl.bindBuffer(gl.ARRAY_BUFFER, flatMesh.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, flatBuilder.data.subarray(0, flatBuilder.len), gl.STATIC_DRAW);
    }
    builderMap = {};
    flatBuilder = null;
    applyEnv(map.ambient);
    gl.clearColor(env.fogColor[0], env.fogColor[1], env.fogColor[2], 1);
  }

  /* ============================================================
     帧渲染
     ============================================================ */
  function bindInterleavedWorld(buf) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(progWorld.a.aPos);
    gl.vertexAttribPointer(progWorld.a.aPos, 3, gl.FLOAT, false, 44, 0);
    gl.enableVertexAttribArray(progWorld.a.aNormal);
    gl.vertexAttribPointer(progWorld.a.aNormal, 3, gl.FLOAT, false, 44, 12);
    gl.enableVertexAttribArray(progWorld.a.aColor);
    gl.vertexAttribPointer(progWorld.a.aColor, 3, gl.FLOAT, false, 44, 24);
    gl.enableVertexAttribArray(progWorld.a.aUV);
    gl.vertexAttribPointer(progWorld.a.aUV, 2, gl.FLOAT, false, 44, 36);
  }

  function setWorldUniforms() {
    var u = progWorld.u;
    gl.uniformMatrix4fv(u.uVP, false, cam.vp);
    gl.uniform3fv(u.uSunDir, env.sunDir);
    gl.uniform3fv(u.uSunColor, env.sunColor);
    gl.uniform3fv(u.uAmbient, env.ambientColor);
    gl.uniform3fv(u.uFogColor, env.fogColor);
    gl.uniform2f(u.uFog, env.fogNear, env.fogFar);
    gl.uniform1i(u.uTex, 0);
  }

  function beginFrame() {
    stats.drawCalls = 0; stats.triangles = 0;
    projectSun();
    gl.viewport(0, 0, viewW, viewH);
    gl.clearColor(env.fogColor[0], env.fogColor[1], env.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(progSky.program);
    gl.uniform3fv(progSky.u.uSkyTop, env.skyTop);
    gl.uniform3fv(progSky.u.uSkyHorizon, env.skyHorizon);
    gl.uniform3fv(progSky.u.uFogColor, env.fogColor);
    gl.uniform3fv(progSky.u.uSunColor, env.sunColor);
    gl.uniform1f(progSky.u.uHorizon, horizonY);
    gl.uniform2f(progSky.u.uSunScreen, sunScreen[0], sunScreen[1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, skyQuad);
    gl.enableVertexAttribArray(progSky.a.aPos);
    gl.vertexAttribPointer(progSky.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    stats.drawCalls++;
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(progWorld.program);
    setWorldUniforms();
  }

  function drawMap() {
    gl.useProgram(progWorld.program);
    setWorldUniforms();
    gl.activeTexture(gl.TEXTURE0);
    for (var i = 0; i < mapGroups.length; i++) {
      var g = mapGroups[i];
      gl.bindTexture(gl.TEXTURE_2D, g.tex);
      bindInterleavedWorld(g.vbo);
      gl.drawArrays(gl.TRIANGLES, 0, g.count);
      stats.drawCalls++; stats.triangles += g.count / 3;
    }
    if (flatMesh) {
      gl.bindTexture(gl.TEXTURE_2D, whiteTex);
      bindInterleavedWorld(flatMesh.vbo);
      gl.drawArrays(gl.TRIANGLES, 0, flatMesh.count);
      stats.drawCalls++; stats.triangles += flatMesh.count / 3;
    }
  }

  /* ============================================================
     通用盒子绘制（角色 / 载具模型）
     ============================================================ */
  var tmpM = M.m4.create();
  var tmpM2 = M.m4.create();
  var tmpM3 = M.m4.create();

  function setFlatUniforms(camera, sunDir) {
    var u = progFlat.u;
    gl.uniformMatrix4fv(u.uVP, false, camera);
    gl.uniform3fv(u.uSunDir, sunDir);
    gl.uniform3fv(u.uSunColor, env.sunColor);
    gl.uniform3fv(u.uAmbient, env.ambientColor);
    gl.uniform3fv(u.uFogColor, env.fogColor);
    gl.uniform2f(u.uFog, env.fogNear, env.fogFar);
  }

  function bindFlat() {
    gl.useProgram(progFlat.program);
    setFlatUniforms(cam.vp, env.sunDir);
    gl.bindBuffer(gl.ARRAY_BUFFER, cube.vbo);
    gl.enableVertexAttribArray(progFlat.a.aPos);
    gl.vertexAttribPointer(progFlat.a.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(progFlat.a.aNormal);
    gl.vertexAttribPointer(progFlat.a.aNormal, 3, gl.FLOAT, false, 24, 12);
  }

  function drawBoxWorld(px, py, pz, sx, sy, sz, yaw, pitch, roll, color, alpha) {
    M.m4.compose(tmpM, px, py, pz, yaw || 0, pitch || 0, roll || 0, sx / 2, sy / 2, sz / 2);
    gl.uniformMatrix4fv(progFlat.u.uModel, false, tmpM);
    gl.uniform3fv(progFlat.u.uColor, color);
    gl.uniform1f(progFlat.u.uAlpha, alpha === undefined ? 1 : alpha);
    gl.drawArrays(gl.TRIANGLES, 0, cube.count);
    stats.drawCalls++; stats.triangles += cube.count / 3;
  }

  /* 由父矩阵 + 局部变换绘制一个盒子 */
  function drawBoxLocal(parent, lx, ly, lz, sx, sy, sz, lyaw, lpitch, lroll, color, alpha) {
    M.m4.compose(tmpM2, lx, ly, lz, lyaw || 0, lpitch || 0, lroll || 0, sx / 2, sy / 2, sz / 2);
    M.m4.multiply(tmpM3, parent, tmpM2);
    gl.uniformMatrix4fv(progFlat.u.uModel, false, tmpM3);
    gl.uniform3fv(progFlat.u.uColor, color);
    gl.uniform1f(progFlat.u.uAlpha, alpha === undefined ? 1 : alpha);
    gl.drawArrays(gl.TRIANGLES, 0, cube.count);
    stats.drawCalls++; stats.triangles += cube.count / 3;
  }

  var COLORS = {
    botPants: [0.38, 0.33, 0.24],
    botJacket: [0.54, 0.46, 0.32],
    botVest: [0.27, 0.29, 0.26],
    botSkin: [0.62, 0.48, 0.36],
    botMask: [0.17, 0.18, 0.17],
    gunmetal: [0.22, 0.23, 0.24],
    steel: [0.45, 0.47, 0.49],
    woodGun: [0.50, 0.31, 0.15],
    glove: [0.13, 0.13, 0.14],
    boot: [0.13, 0.12, 0.11]
  };

  function drawActorModel(a) {
    if (!a) return;
    gl.useProgram(progFlat.program);
    setFlatUniforms(cam.vp, env.sunDir);
    gl.bindBuffer(gl.ARRAY_BUFFER, cube.vbo);
    gl.enableVertexAttribArray(progFlat.a.aPos);
    gl.vertexAttribPointer(progFlat.a.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(progFlat.a.aNormal);
    gl.vertexAttribPointer(progFlat.a.aNormal, 3, gl.FLOAT, false, 24, 12);

    var pos = a.pos;
    var yaw = a.yaw || 0;
    var crouch = M.clamp(a.crouch || 0, 0, 1);
    var bodyY = 1.8 - (a.crouch || 0) * 0.62;
    var scaleY = bodyY / 1.8;
    var death = M.clamp(a.deathT || 0, 0, 1);
    var roll = death * 1.35;
    var body = tmpM; // 复用：注意 drawBoxLocal 内部使用 tmpM2/tmpM3
    M.m4.compose(body, pos[0], pos[1], pos[2], yaw, death * 1.2, roll, 1, 1, 1);

    var walk = a.movePhase || 0;
    var swing = Math.sin(walk) * (a.moving ? 0.55 : 0.0);
    var swing2 = Math.sin(walk + Math.PI) * (a.moving ? 0.55 : 0.0);

    if (death < 0.9) {
      // 腿
      drawBoxLocal(body, 0.13, 0.38 * scaleY, 0, 0.20, 0.74 * scaleY, 0.24, 0, -swing * 0.7, 0, COLORS.botPants, 1);
      drawBoxLocal(body, -0.13, 0.38 * scaleY, 0, 0.20, 0.74 * scaleY, 0.24, 0, -swing2 * 0.7, 0, COLORS.botPants, 1);
      // 靴子
      drawBoxLocal(body, 0.13, 0.08, 0, 0.22, 0.16, 0.3, 0, 0, 0, COLORS.boot, 1);
      drawBoxLocal(body, -0.13, 0.08, 0, 0.22, 0.16, 0.3, 0, 0, 0, COLORS.boot, 1);
      // 躯干
      drawBoxLocal(body, 0, (1.05 + crouch * 0.05) * scaleY, 0, 0.52, 0.62 * scaleY, 0.32, 0, 0, 0, COLORS.botJacket, 1);
      drawBoxLocal(body, 0, (1.12 + crouch * 0.04) * scaleY, -0.02, 0.56, 0.40 * scaleY, 0.30, 0, 0, 0, COLORS.botVest, 1);
      // 头 + 头盔 + 面罩
      var headY = (1.58 + crouch * 0.02) * scaleY + (1 - scaleY) * 0.1;
      drawBoxLocal(body, 0, headY, 0, 0.27, 0.29, 0.27, 0, 0, 0, COLORS.botSkin, 1);
      drawBoxLocal(body, 0, headY + 0.14, 0, 0.31, 0.11, 0.31, 0, 0, 0, COLORS.botJacket, 1);
      drawBoxLocal(body, 0, headY + 0.01, -0.09, 0.25, 0.19, 0.12, 0, 0, 0, COLORS.botMask, 1);
      drawBoxLocal(body, 0, headY + 0.02, 0.13, 0.23, 0.18, 0.06, 0, 0, 0, COLORS.botSkin, 1);
      // 肩部
      drawBoxLocal(body, 0.27, (1.37 + crouch * 0.04) * scaleY, 0, 0.19, 0.17, 0.28, 0, 0, 0, COLORS.botJacket, 1);
      drawBoxLocal(body, -0.27, (1.37 + crouch * 0.04) * scaleY, 0, 0.19, 0.17, 0.28, 0, 0, 0, COLORS.botJacket, 1);
      // 手臂 / 枪（朝瞄准方向）
      var pitch = M.clamp(a.pitch || 0, -1.2, 1.2);
      var armY = (1.30 + crouch * 0.05) * scaleY;
      var gunY = armY - 0.08 + Math.sin(pitch) * 0.16;
      var gunZ = -0.30 - Math.cos(pitch) * 0.10;
      // 上臂（肩→肘，斜向下前）
      drawBoxLocal(body, 0.28, armY - 0.10, -0.06, 0.13, 0.32, 0.15, 0, 0.45, 0.22, COLORS.botJacket, 1);
      drawBoxLocal(body, -0.26, armY - 0.10, -0.06, 0.13, 0.32, 0.15, 0, 0.45, -0.20, COLORS.botJacket, 1);
      // 前臂（肘→手，向前握枪）
      drawBoxLocal(body, 0.16, gunY + 0.03, gunZ + 0.02, 0.10, 0.10, 0.30, 0.22, 0.25, 0, COLORS.botJacket, 1);
      drawBoxLocal(body, -0.10, gunY - 0.01, gunZ - 0.10, 0.10, 0.10, 0.28, -0.15, 0.12, 0, COLORS.botJacket, 1);
      // 枪身（AK）
      drawBoxLocal(body, 0.04, gunY, gunZ - 0.10, 0.075, 0.10, 0.44, 0, pitch, 0, COLORS.gunmetal, 1);
      drawBoxLocal(body, 0.04, gunY + 0.01, gunZ - 0.37, 0.032, 0.032, 0.20, 0, pitch, 0, COLORS.steel, 1);
      drawBoxLocal(body, 0.04, gunY - 0.02, gunZ + 0.13, 0.055, 0.11, 0.18, 0, pitch + 0.15, 0, COLORS.woodGun, 1);
      drawBoxLocal(body, 0.04, gunY - 0.075, gunZ - 0.06, 0.05, 0.12, 0.075, 0, pitch + 0.28, 0, COLORS.gunmetal, 1);
      // 手
      drawBoxLocal(body, 0.09, gunY - 0.05, gunZ + 0.10, 0.09, 0.09, 0.12, 0, 0.3, 0, COLORS.glove, 1);
      drawBoxLocal(body, 0.01, gunY - 0.04, gunZ - 0.24, 0.09, 0.09, 0.12, 0, 0.1, 0, COLORS.glove, 1);
    } else {
      // 倒地
      drawBoxLocal(body, 0, 0.18, 0, 0.5, 0.3, 0.8, 0, 0, 0, COLORS.botVest, 1);
      drawBoxLocal(body, 0, 0.2, 0.45, 0.24, 0.24, 0.24, 0, 0, 0, COLORS.botMask, 1);
      drawBoxLocal(body, 0.18, 0.12, -0.4, 0.2, 0.2, 0.6, 0, 0, 0, COLORS.botPants, 1);
      drawBoxLocal(body, -0.18, 0.12, -0.35, 0.2, 0.2, 0.55, 0, 0, 0, COLORS.botPants, 1);
    }
  }

  /* ============================================================
     假阴影
     ============================================================ */
  function pushGroundQuad(list, x, y, z, r, rgba) {
    function v(px, py, pz) { list.push3(px, py, pz); list.push4(rgba[0], rgba[1], rgba[2], rgba[3]); }
    v(x - r, y, z + r); v(x + r, y, z + r); v(x + r, y, z - r);
    v(x - r, y, z + r); v(x + r, y, z - r); v(x - r, y, z - r);
  }
  function drawShadow(x, z, y, radius, alpha) {
    if (!fxShadow) return;
    pushGroundQuad(fxShadow, x, y + 0.015, z, radius * 1.5, [0.04, 0.04, 0.035, alpha * 0.12]);
    pushGroundQuad(fxShadow, x, y + 0.018, z, radius, [0.03, 0.03, 0.03, alpha * 0.30]);
  }

  /* ============================================================
     粒子特效
     ============================================================ */
  var effects = [];
  var vmFlash = null; // {t, dur, muzzle:[x,y,z], size}

  function spawnTracer(a, b, color) {
    effects.push({ type: 'tracer', a: [a[0], a[1], a[2]], b: [b[0], b[1], b[2]], color: color, t: 0, dur: 0.055, width: 0.018 });
  }
  function spawnMuzzleFlash(pos, color, size) {
    effects.push({ type: 'flash', pos: [pos[0], pos[1], pos[2]], color: color || [1, 0.82, 0.35], t: 0, dur: 0.07, size: size || 0.5 });
  }
  function spawnImpact(pos, normal, kind) {
    var n = normal || [0, 1, 0];
    var col = kind === 'metal' ? [1.0, 0.85, 0.45] : kind === 'wood' ? [0.75, 0.5, 0.25] : [0.7, 0.62, 0.45];
    effects.push({ type: 'dust', pos: [pos[0] + n[0] * 0.05, pos[1] + n[1] * 0.05, pos[2] + n[2] * 0.05], color: col, t: 0, dur: 0.36, size: 0.22, normal: n });
    for (var i = 0; i < 5; i++) {
      var v = [n[0] + (Math.random() - 0.5) * 1.4, n[1] + Math.random() * 1.2, n[2] + (Math.random() - 0.5) * 1.4];
      var l = M.v3.len(v) || 1;
      effects.push({
        type: 'spark', pos: [pos[0], pos[1], pos[2]], vel: [v[0] / l * 3.2, v[1] / l * 3.2, v[2] / l * 3.2],
        color: kind === 'metal' ? [1.0, 0.9, 0.6] : [0.9, 0.75, 0.45], t: 0, dur: 0.14 + Math.random() * 0.08, size: 0.045
      });
    }
  }
  function spawnBlood(pos, dir, headshot) {
    var col = headshot ? [0.65, 0.08, 0.05] : [0.55, 0.06, 0.04];
    for (var i = 0; i < 6; i++) {
      var v = [(dir ? dir[0] : 0) + (Math.random() - 0.5) * 2, (dir ? dir[1] : 0) + (Math.random() - 0.3) * 1.6, (dir ? dir[2] : 0) + (Math.random() - 0.5) * 2];
      effects.push({
        type: 'spark', pos: [pos[0], pos[1], pos[2]], vel: [v[0] * 2.2, v[1] * 2.2, v[2] * 2.2],
        color: col, t: 0, dur: 0.25 + Math.random() * 0.2, size: 0.07, blood: true
      });
    }
    effects.push({ type: 'dust', pos: [pos[0], pos[1], pos[2]], color: [0.5, 0.08, 0.06], t: 0, dur: 0.4, size: 0.3, normal: [0, 1, 0] });
  }
  function spawnDeathBurst(pos) {
    for (var i = 0; i < 10; i++) {
      var v = [(Math.random() - 0.5) * 3, Math.random() * 2.4, (Math.random() - 0.5) * 3];
      effects.push({
        type: 'spark', pos: [pos[0], pos[1] + 1.0, pos[2]], vel: v,
        color: [0.55, 0.07, 0.05], t: 0, dur: 0.4 + Math.random() * 0.35, size: 0.09, blood: true
      });
    }
  }

  function updateEffects(dt) {
    var i, e;
    for (i = effects.length - 1; i >= 0; i--) {
      e = effects[i];
      e.t += dt;
      if (e.t >= e.dur) { effects.splice(i, 1); continue; }
      if (e.type === 'spark') {
        e.pos[0] += e.vel[0] * dt;
        e.pos[1] += e.vel[1] * dt;
        e.pos[2] += e.vel[2] * dt;
        e.vel[1] -= 9 * dt;
      } else if (e.type === 'dust') {
        e.size += dt * 1.4;
      }
    }
  }

  function addBillboardQuad(list, center, right, up, size, color, r, rot) {
    // 可选旋转：在 right/up 平面旋转
    var cr = Math.cos(rot || 0), sr = Math.sin(rot || 0);
    var rx = (right[0] * cr + up[0] * sr) * size;
    var ry = (right[1] * cr + up[1] * sr) * size;
    var rz = (right[2] * cr + up[2] * sr) * size;
    var ux = (-right[0] * sr + up[0] * cr) * size;
    var uy = (-right[1] * sr + up[1] * cr) * size;
    var uz = (-right[2] * sr + up[2] * cr) * size;
    var x = center[0], y = center[1], z = center[2];
    list.push3(x - rx - ux, y - ry - uy, z - rz - uz); list.push4(color[0], color[1], color[2], color[3]);
    list.push3(x + rx - ux, y + ry - uy, z + rz - uz); list.push4(color[0], color[1], color[2], color[3]);
    list.push3(x + rx + ux, y + ry + uy, z + rz + uz); list.push4(color[0], color[1], color[2], color[3]);
    list.push3(x - rx - ux, y - ry - uy, z - rz - uz); list.push4(color[0], color[1], color[2], color[3]);
    list.push3(x + rx + ux, y + ry + uy, z + rz + uz); list.push4(color[0], color[1], color[2], color[3]);
    list.push3(x - rx + ux, y - ry + uy, z - rz + uz); list.push4(color[0], color[1], color[2], color[3]);
  }

  function addTracerQuad(list, a, b, color, width) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.001) return;
    dx /= len; dy /= len; dz /= len;
    // side = dir x view
    var sx = dy * cam.forward[2] - dz * cam.forward[1];
    var sy = dz * cam.forward[0] - dx * cam.forward[2];
    var sz = dx * cam.forward[1] - dy * cam.forward[0];
    var sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (sl < 0.001) { sx = cam.up[0]; sy = cam.up[1]; sz = cam.up[2]; sl = 1; }
    sx = sx / sl * width; sy = sy / sl * width; sz = sz / sl * width;
    var alpha = 0.85;
    list.push3(a[0] - sx, a[1] - sy, a[2] - sz); list.push4(color[0], color[1], color[2], alpha);
    list.push3(b[0] - sx, b[1] - sy, b[2] - sz); list.push4(color[0], color[1], color[2], alpha * 0.2);
    list.push3(b[0] + sx, b[1] + sy, b[2] + sz); list.push4(color[0], color[1], color[2], alpha * 0.2);
    list.push3(a[0] - sx, a[1] - sy, a[2] - sz); list.push4(color[0], color[1], color[2], alpha);
    list.push3(b[0] + sx, b[1] + sy, b[2] + sz); list.push4(color[0], color[1], color[2], alpha * 0.2);
    list.push3(a[0] + sx, a[1] + sy, a[2] + sz); list.push4(color[0], color[1], color[2], alpha);
  }

  function renderEffects() {
    fxAlpha.len = 0; fxAdd.len = 0;
    var right = cam.right, up = cam.up;
    for (var i = 0; i < effects.length; i++) {
      var e = effects[i];
      var k = e.t / e.dur;
      if (e.type === 'tracer') {
        addTracerQuad(fxAdd, e.a, e.b, [e.color[0], e.color[1], e.color[2], 1], e.width);
      } else if (e.type === 'flash') {
        var s = e.size * (1 - k) * (0.8 + Math.random() * 0.5);
        addBillboardQuad(fxAdd, e.pos, right, up, s, [e.color[0], e.color[1], e.color[2], 0.9], 0, Math.random() * 6.28);
        addBillboardQuad(fxAdd, e.pos, right, up, s * 1.8, [e.color[0] * 0.6, e.color[1] * 0.5, e.color[2] * 0.4, 0.35], 0, Math.random() * 6.28);
      } else if (e.type === 'spark') {
        var sz = e.size * (1 - k * 0.6);
        var col = [e.color[0], e.color[1], e.color[2], (1 - k) * (e.blood ? 0.85 : 1)];
        addBillboardQuad(fxAdd, e.pos, right, up, sz, col, 0, 0);
      } else if (e.type === 'dust') {
        var ds = e.size * (0.6 + k * 1.4);
        var dc = [e.color[0], e.color[1], e.color[2], (1 - k) * 0.4];
        addBillboardQuad(fxAlpha, e.pos, right, up, ds, dc, 0, 0);
      }
    }
    drawFxBatch(fxShadow, true);
    fxShadow.len = 0;
    drawFxBatch(fxAlpha, true);
    drawFxBatch(fxAdd, false);
  }

  function drawFxBatch(list, alphaBlend) {
    if (!list || list.len === 0) return;
    gl.useProgram(progSprite.program);
    gl.uniformMatrix4fv(progSprite.u.uVP, false, cam.vp);
    gl.bindBuffer(gl.ARRAY_BUFFER, dynBuf);
    var need = list.len;
    if (need > dynCapacity) {
      dynCapacity = Math.max(need, dynCapacity * 2);
      gl.bufferData(gl.ARRAY_BUFFER, dynCapacity * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, list.data.subarray(0, list.len));
    var stride = 7 * 4;
    gl.enableVertexAttribArray(progSprite.a.aPos);
    gl.vertexAttribPointer(progSprite.a.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(progSprite.a.aColor);
    gl.vertexAttribPointer(progSprite.a.aColor, 4, gl.FLOAT, false, stride, 12);
    gl.enable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    if (alphaBlend) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, list.len / 7);
    stats.drawCalls++;
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
  }

  /* ============================================================
     第一人称武器视图模型
     ============================================================ */
  var VM_COLORS = {
    gunmetal: [0.27, 0.28, 0.30], steel: [0.52, 0.54, 0.57], darkSteel: [0.16, 0.17, 0.18],
    wood: [0.50, 0.31, 0.15], wood2: [0.58, 0.37, 0.18], polymer: [0.19, 0.20, 0.21],
    glove: [0.13, 0.13, 0.14], glove2: [0.18, 0.17, 0.15], skin: [0.62, 0.48, 0.36],
    olive: [0.34, 0.39, 0.26], olive2: [0.40, 0.46, 0.30], silver: [0.64, 0.66, 0.69],
    orange: [0.72, 0.42, 0.18], scope: [0.12, 0.14, 0.16], lens: [0.30, 0.52, 0.62]
  };

  function weaponParts(id) {
    if (id === 'deagle') {
      return [
        { t: 'slide', x: 0, y: 0.035, z: -0.15, sx: 0.075, sy: 0.085, sz: 0.34, c: VM_COLORS.silver },
        { t: 'slide', x: 0, y: 0.035, z: -0.315, sx: 0.07, sy: 0.07, sz: 0.08, c: VM_COLORS.steel },
        { t: 'body', x: 0, y: -0.015, z: -0.06, sx: 0.065, sy: 0.08, sz: 0.2, c: VM_COLORS.gunmetal },
        { t: 'body', x: 0, y: -0.045, z: -0.155, sx: 0.055, sy: 0.05, sz: 0.15, c: VM_COLORS.darkSteel },
        { t: 'grip', x: 0, y: -0.14, z: 0.035, sx: 0.06, sy: 0.19, sz: 0.09, yaw: 0, pitch: -0.22, c: VM_COLORS.gunmetal },
        { t: 'trigger', x: 0, y: -0.06, z: -0.03, sx: 0.035, sy: 0.03, sz: 0.06, c: VM_COLORS.darkSteel },
        { t: 'sight', x: 0, y: 0.085, z: -0.29, sx: 0.012, sy: 0.03, sz: 0.02, c: VM_COLORS.darkSteel },
        { t: 'sight', x: 0, y: 0.085, z: 0.01, sx: 0.02, sy: 0.02, sz: 0.02, c: VM_COLORS.darkSteel },
        { t: 'handR', x: 0.015, y: -0.15, z: 0.02, sx: 0.085, sy: 0.11, sz: 0.13, pitch: -0.2, c: VM_COLORS.glove },
        { t: 'handL', x: -0.03, y: -0.115, z: -0.02, sx: 0.075, sy: 0.10, sz: 0.12, pitch: -0.15, c: VM_COLORS.glove2 },
        { t: 'armR', x: 0.09, y: -0.19, z: -0.03, sx: 0.085, sy: 0.085, sz: 0.24, pitch: 0.45, yaw: -0.12, c: VM_COLORS.glove2 },
        { t: 'armL', x: -0.075, y: -0.155, z: -0.10, sx: 0.08, sy: 0.08, sz: 0.21, pitch: 0.32, yaw: 0.2, c: VM_COLORS.glove2 }
      ];
    }
    if (id === 'awm') {
      return [
        { t: 'body', x: 0, y: -0.01, z: -0.08, sx: 0.09, sy: 0.11, sz: 0.5, c: VM_COLORS.olive },
        { t: 'body', x: 0, y: 0.03, z: -0.33, sx: 0.08, sy: 0.08, sz: 0.16, c: VM_COLORS.olive2 },
        { t: 'barrel', x: 0, y: 0.015, z: -0.49, sx: 0.035, sy: 0.035, sz: 0.42, c: VM_COLORS.steel },
        { t: 'muzzle', x: 0, y: 0.015, z: -0.70, sx: 0.05, sy: 0.05, sz: 0.09, c: VM_COLORS.darkSteel },
        { t: 'stock', x: 0, y: -0.035, z: 0.18, sx: 0.075, sy: 0.13, sz: 0.26, pitch: 0.06, c: VM_COLORS.olive },
        { t: 'cheek', x: 0, y: 0.06, z: 0.12, sx: 0.07, sy: 0.05, sz: 0.14, c: VM_COLORS.olive2 },
        { t: 'scope', x: 0, y: 0.105, z: -0.06, sx: 0.055, sy: 0.055, sz: 0.26, c: VM_COLORS.gunmetal },
        { t: 'scope', x: 0, y: 0.105, z: -0.19, sx: 0.06, sy: 0.06, sz: 0.03, c: VM_COLORS.scope },
        { t: 'scope', x: 0, y: 0.105, z: 0.07, sx: 0.06, sy: 0.06, sz: 0.03, c: VM_COLORS.scope },
        { t: 'scope', x: 0, y: 0.105, z: -0.21, sx: 0.048, sy: 0.048, sz: 0.02, c: VM_COLORS.lens },
        { t: 'scope', x: -0.04, y: 0.145, z: -0.02, sx: 0.02, sy: 0.03, sz: 0.04, c: VM_COLORS.darkSteel },
        { t: 'bolt', x: 0.075, y: 0.035, z: 0.0, sx: 0.03, sy: 0.03, sz: 0.035, c: VM_COLORS.steel },
        { t: 'bolt', x: 0.10, y: 0.03, z: 0.01, sx: 0.09, sy: 0.025, sz: 0.025, yaw: 0.35, c: VM_COLORS.steel },
        { t: 'mag', x: 0, y: -0.10, z: -0.11, sx: 0.06, sy: 0.10, sz: 0.11, c: VM_COLORS.darkSteel },
        { t: 'trigger', x: 0, y: -0.075, z: 0.015, sx: 0.03, sy: 0.04, sz: 0.06, c: VM_COLORS.darkSteel },
        { t: 'handR', x: 0.015, y: -0.13, z: 0.015, sx: 0.085, sy: 0.11, sz: 0.14, pitch: -0.2, c: VM_COLORS.glove },
        { t: 'handL', x: -0.02, y: -0.075, z: -0.30, sx: 0.08, sy: 0.10, sz: 0.14, pitch: -0.1, c: VM_COLORS.glove2 },
        { t: 'armR', x: 0.09, y: -0.19, z: -0.02, sx: 0.085, sy: 0.085, sz: 0.24, pitch: 0.45, yaw: -0.12, c: VM_COLORS.glove2 },
        { t: 'armL', x: -0.08, y: -0.14, z: -0.12, sx: 0.08, sy: 0.08, sz: 0.22, pitch: 0.35, yaw: 0.22, c: VM_COLORS.glove2 }
      ];
    }
    // ak47
    return [
      { t: 'receiver', x: 0, y: 0, z: -0.10, sx: 0.075, sy: 0.11, sz: 0.42, c: VM_COLORS.gunmetal },
      { t: 'receiver', x: 0, y: -0.006, z: 0.10, sx: 0.07, sy: 0.10, sz: 0.08, c: VM_COLORS.darkSteel },
      { t: 'barrel', x: 0, y: 0.02, z: -0.38, sx: 0.032, sy: 0.032, sz: 0.24, c: VM_COLORS.steel },
      { t: 'gas', x: 0, y: 0.05, z: -0.30, sx: 0.03, sy: 0.035, sz: 0.16, c: VM_COLORS.darkSteel },
      { t: 'guard', x: 0, y: -0.005, z: -0.28, sx: 0.07, sy: 0.075, sz: 0.16, c: VM_COLORS.wood },
      { t: 'stock', x: 0, y: -0.035, z: 0.16, sx: 0.065, sy: 0.10, sz: 0.26, pitch: 0.10, c: VM_COLORS.wood2 },
      { t: 'grip', x: 0, y: -0.11, z: 0.03, sx: 0.055, sy: 0.13, sz: 0.08, pitch: -0.35, c: VM_COLORS.polymer },
      { t: 'mag', x: 0, y: -0.13, z: -0.10, sx: 0.05, sy: 0.15, sz: 0.09, pitch: 0.28, c: VM_COLORS.orange },
      { t: 'sightF', x: 0, y: 0.06, z: -0.46, sx: 0.018, sy: 0.045, sz: 0.02, c: VM_COLORS.darkSteel },
      { t: 'sightR', x: 0, y: 0.065, z: -0.13, sx: 0.03, sy: 0.025, sz: 0.03, c: VM_COLORS.darkSteel },
      { t: 'muzzle', x: 0, y: 0.02, z: -0.505, sx: 0.042, sy: 0.042, sz: 0.04, c: VM_COLORS.darkSteel },
      { t: 'trigger', x: 0, y: -0.075, z: -0.02, sx: 0.025, sy: 0.03, sz: 0.05, c: VM_COLORS.darkSteel },
      { t: 'handR', x: 0.015, y: -0.115, z: 0.03, sx: 0.085, sy: 0.11, sz: 0.13, pitch: -0.25, c: VM_COLORS.glove },
      { t: 'handL', x: -0.02, y: -0.06, z: -0.28, sx: 0.08, sy: 0.10, sz: 0.13, pitch: -0.1, c: VM_COLORS.glove2 },
      { t: 'armR', x: 0.095, y: -0.19, z: -0.02, sx: 0.085, sy: 0.085, sz: 0.24, pitch: 0.45, yaw: -0.12, c: VM_COLORS.glove2 },
      { t: 'armL', x: -0.085, y: -0.15, z: -0.12, sx: 0.08, sy: 0.08, sz: 0.22, pitch: 0.35, yaw: 0.24, c: VM_COLORS.glove2 }
    ];
  }

  var vmModels = {};
  function getVmModel(id) { if (!vmModels[id]) vmModels[id] = weaponParts(id); return vmModels[id]; }

  var vmMuzzleLocal = { deagle: [0, 0.04, -0.37], awm: [0, 0.015, -0.74], ak47: [0, 0.02, -0.53] };

  // vm: {weaponId, scoped, reloadT(0..1, -1 none), equipT(0..1, 1=ready), kickPitch, kickYaw, kickBack, swayX, swayY, bobX, bobY, boltT, flashT}
  function renderViewmodel(vm, dt) {
    if (!vm || vm.scoped) { vmFlash = null; return; }
    var parts = getVmModel(vm.weaponId || 'ak47');
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(progFlat.program);
    // 相机空间的固定补光方向（让武器清晰可见）
    var sd = [0.42, 0.72, 0.52];
    var amb = [env.ambientColor[0] * 0.95 + 0.14, env.ambientColor[1] * 0.95 + 0.14, env.ambientColor[2] * 0.95 + 0.15];
    var sunVmc = [env.sunColor[0] * 0.92 + 0.06, env.sunColor[1] * 0.92 + 0.06, env.sunColor[2] * 0.92 + 0.06];
    gl.uniformMatrix4fv(progFlat.u.uVP, false, cam.vmProj);
    gl.uniform3fv(progFlat.u.uSunDir, M.v3.norm([0, 0, 0], sd));
    gl.uniform3fv(progFlat.u.uSunColor, sunVmc);
    gl.uniform3fv(progFlat.u.uAmbient, amb);
    gl.uniform3fv(progFlat.u.uFogColor, env.fogColor);
    gl.uniform2f(progFlat.u.uFog, 100, 200);
    gl.bindBuffer(gl.ARRAY_BUFFER, cube.vbo);
    gl.enableVertexAttribArray(progFlat.a.aPos);
    gl.vertexAttribPointer(progFlat.a.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(progFlat.a.aNormal);
    gl.vertexAttribPointer(progFlat.a.aNormal, 3, gl.FLOAT, false, 24, 12);

    var equip = vm.equipT === undefined ? 1 : M.clamp(vm.equipT, 0, 1);
    var reload = vm.reloadT === undefined || vm.reloadT < 0 ? 0 : vm.reloadT;
    var bobX = (vm.bobX || 0) * 0.012;
    var bobY = (vm.bobY || 0) * 0.012;
    var swayX = (vm.swayX || 0) * 0.006;
    var swayY = (vm.swayY || 0) * 0.006;
    var baseX = 0.185 + swayX + bobX;
    var baseY = -0.205 + swayY + bobY - (1 - equip) * 0.35 - Math.sin(reload * Math.PI) * 0.10;
    var baseZ = -0.46 + (vm.kickBack || 0) * 0.055 + (1 - equip) * 0.1;
    var baseYaw = 0.05 + (vm.kickYaw || 0) * 0.03 + Math.sin(reload * Math.PI) * 0.5;
    var basePitch = 0.02 + (vm.kickPitch || 0) * 0.06 - (1 - equip) * 0.7 - Math.sin(reload * Math.PI) * 0.55;
    var baseRoll = Math.sin(reload * Math.PI) * 0.35 + (vm.swayRoll || 0) * 0.1;
    var VM_SCALE = 0.52;

    M.m4.compose(tmpM, baseX, baseY, baseZ, baseYaw, basePitch, baseRoll, VM_SCALE, VM_SCALE, VM_SCALE);

    var magOff = 0, magOut = 0;
    if (reload > 0 && reload < 1) {
      var rp = reload;
      if (rp < 0.35) { magOut = rp / 0.35; }
      else if (rp < 0.7) { magOut = 1; magOff = (rp - 0.35) / 0.35; }
      else { magOut = 1 - (rp - 0.7) / 0.3; magOff = 1 - (rp - 0.7) / 0.3; }
      magOut = M.clamp(magOut, 0, 1);
      magOff = M.clamp(magOff, 0, 1);
    }
    var bolt = vm.boltT === undefined ? 0 : M.clamp(vm.boltT, 0, 1); // 0..1..0
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var px = p.x, py = p.y, pz = p.z;
      if (p.t === 'mag') {
        py -= magOut * 0.16;
        pz += magOut * 0.05;
        px += magOut * 0.03;
      }
      if (p.t === 'bolt') {
        px += Math.sin(bolt * Math.PI) * 0.10;
        pz += Math.sin(bolt * Math.PI) * 0.055;
      }
      drawBoxLocal(tmpM, px, py, pz, p.sx, p.sy, p.sz, p.yaw || 0, p.pitch || 0, p.roll || 0, p.c, 1);
    }

    // 枪口火光
    var f = vm.flashT || 0;
    if (f > 0) {
      var mz = vmMuzzleLocal[vm.weaponId || 'ak47'] || [0, 0, -0.5];
      var mp = [0, 0, 0];
      M.m4.transformPoint(mp, tmpM, mz);
      // 相机空间里画屏幕对齐的十字光斑
      var s = 0.040 + Math.random() * 0.018;
      var r = cam.right, u = cam.up;
      var add = fxAdd; add.len = 0;
      for (var k = 0; k < 2; k++) {
        var rot = k * Math.PI / 4 + Math.random() * 0.4;
        addBillboardQuad(add, mp, r, u, s, [1.0, 0.78, 0.32, 0.9], 1, rot);
      }
      if (add.len > 0) {
        gl.useProgram(progSprite.program);
        gl.uniformMatrix4fv(progSprite.u.uVP, false, cam.vmProj);
        gl.bindBuffer(gl.ARRAY_BUFFER, dynBuf);
        if (add.len > dynCapacity) {
          dynCapacity = Math.max(add.len, dynCapacity * 2);
          gl.bufferData(gl.ARRAY_BUFFER, dynCapacity * 4, gl.DYNAMIC_DRAW);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, add.data.subarray(0, add.len));
        var stride = 7 * 4;
        gl.enableVertexAttribArray(progSprite.a.aPos);
        gl.vertexAttribPointer(progSprite.a.aPos, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(progSprite.a.aColor);
        gl.vertexAttribPointer(progSprite.a.aColor, 4, gl.FLOAT, false, stride, 12);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES, 0, add.len / 7);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    }
  }

  /* ============================================================
     射线 / 物理
     ============================================================ */
  function worldRaycast(origin, dir, maxDist) {
    var best = null;
    for (var i = 0; i < mapSolids.length; i++) {
      var s = mapSolids[i];
      var hit = M.rayAABB(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], s.min, s.max, maxDist);
      if (hit && (!best || hit.t < best.dist)) {
        best = {
          hit: true, dist: hit.t,
          point: [origin[0] + dir[0] * hit.t, origin[1] + dir[1] * hit.t, origin[2] + dir[2] * hit.t],
          normal: hit.normal, material: s.mat, solid: s
        };
      }
    }
    return best || { hit: false };
  }

  function los(a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.001) return true;
    var hit = worldRaycast(a, [dx / len, dy / len, dz / len], len);
    return !(hit.hit && hit.dist < len - 0.12);
  }

  function groundHeightAt(x, z, maxY) {
    var origin = [x, maxY === undefined ? 60 : maxY, z];
    var hit = worldRaycast(origin, [0, -1, 0], 200);
    return hit.hit ? hit.point[1] : 0;
  }

  /* ---------------- Physics ---------------- */
  function createActor(pos, opts) {
    opts = opts || {};
    return {
      pos: [pos[0], pos[1], pos[2]],
      vel: [0, 0, 0],
      radius: opts.radius || 0.34,
      height: opts.height || 1.8,
      crouch: opts.crouch || 0,
      onGround: false,
      eyeHeight: 1.65,
      hitGround: false
    };
  }

  function actorBox(a, x, y, z, radius, height) {
    return {
      min: [x - radius, y + 0.02, z - radius],
      max: [x + radius, y + height, z + radius]
    };
  }

  function overlapsAny(box) {
    for (var i = 0; i < mapSolids.length; i++) {
      if (M.aabbOverlap(box.min, box.max, mapSolids[i].min, mapSolids[i].max)) return mapSolids[i];
    }
    return null;
  }

  function solidAt(x, y, z, radius, height) {
    return overlapsAny(actorBox(null, x, y, z, radius, height));
  }

  function moveActor(a, dt, wishDir, speed, opts) {
    opts = opts || {};
    if (dt <= 0) return;
    if (dt > 0.05) dt = 0.05;
    var radius = a.radius || 0.34;
    var wantCrouch = opts.crouch ? 1 : 0;
    // 平滑下蹲/站起；站起前检查头顶
    var targetCrouch = wantCrouch;
    if (a.crouch > 0.05 && targetCrouch < a.crouch) {
      var testH = 1.8;
      if (solidAt(a.pos[0], a.pos[1], a.pos[2], radius, testH)) targetCrouch = a.crouch;
    }
    a.crouch += (targetCrouch - a.crouch) * Math.min(1, dt * 10);
    var height = 1.8 - 0.62 * a.crouch;

    var wx = wishDir ? wishDir[0] : 0, wz = wishDir ? wishDir[2] : 0;
    var wl = Math.sqrt(wx * wx + wz * wz);
    if (wl > 0.001) { wx /= wl; wz /= wl; }

    // 摩擦 + 加速
    var onGround = !!a.onGround;
    if (onGround) {
      var sp = Math.sqrt(a.vel[0] * a.vel[0] + a.vel[2] * a.vel[2]);
      if (sp > 0.001) {
        var drop = Math.max(sp, 4.0) * 6.0 * dt;
        var ns = Math.max(0, sp - drop);
        a.vel[0] *= ns / sp;
        a.vel[2] *= ns / sp;
      }
      accelerateXZ(a.vel, wx, wz, speed, 60, dt);
      if (opts.jump) {
        a.vel[1] = 5.9;
        onGround = false;
      }
    } else {
      accelerateXZ(a.vel, wx, wz, speed * 0.9, 18, dt);
    }
    if (!onGround) {
      a.vel[1] -= 20 * dt;
      if (a.vel[1] < -55) a.vel[1] = -55;
    } else if (a.vel[1] < 0) {
      a.vel[1] = 0;
    }

    // 水平移动（分轴 + 自动上台阶）
    var dx = a.vel[0] * dt, dz = a.vel[2] * dt;
    moveHorizontal(a, dx, 0, radius, height, onGround);
    moveHorizontal(a, 0, dz, radius, height, onGround);
    // 竖直移动
    moveVertical(a, a.vel[1] * dt, radius, height);

    // 地面检测 / 吸附
    if (a.vel[1] <= 0.01) {
      var gy = findGround(a.pos[0], a.pos[1], a.pos[2], radius);
      if (gy !== null && a.pos[1] - gy <= 0.06) {
        a.pos[1] = gy;
        a.vel[1] = 0;
        a.onGround = true;
      } else {
        a.onGround = false;
      }
    } else {
      a.onGround = false;
    }
    if (a.onGround && opts.jump) a.onGround = false;
    a.height = height;
    a.eyeHeight = 1.65 - 0.5 * a.crouch;
  }

  function accelerateXZ(vel, wx, wz, wishSpeed, accel, dt) {
    if (wishSpeed <= 0) return;
    var current = vel[0] * wx + vel[2] * wz;
    var add = wishSpeed - current;
    if (add <= 0) return;
    var acc = Math.min(accel * wishSpeed * dt, add);
    vel[0] += wx * acc;
    vel[2] += wz * acc;
  }

  function findGround(x, y, z, radius) {
    // 在 y-0.08 高度向下 0.1 内寻找最高支撑面
    var best = null;
    for (var i = 0; i < mapSolids.length; i++) {
      var s = mapSolids[i];
      if (x + radius <= s.min[0] || x - radius >= s.max[0]) continue;
      if (z + radius <= s.min[2] || z - radius >= s.max[2]) continue;
      var top = s.max[1];
      if (top <= y + 0.02 && top >= y - 0.12) {
        if (best === null || top > best) best = top;
      }
    }
    return best;
  }

  function moveHorizontal(a, dx, dz, radius, height, onGround) {
    if (dx === 0 && dz === 0) return;
    var nx = a.pos[0] + dx, nz = a.pos[2] + dz;
    var box = actorBox(null, nx, a.pos[1], nz, radius, height);
    var s = overlapsAny(box);
    if (s) {
      // 自动上台阶
      var step = s.max[1] - a.pos[1];
      if (onGround && step > 0.02 && step <= 0.46) {
        var testBox = actorBox(null, nx, s.max[1] + 0.001, nz, radius, height);
        if (!overlapsAny(testBox)) {
          a.pos[0] = nx; a.pos[2] = nz; a.pos[1] = s.max[1] + 0.001;
          return;
        }
      }
      // 推离
      if (dx > 0) nx = s.min[0] - radius - 0.002;
      else if (dx < 0) nx = s.max[0] + radius + 0.002;
      if (dz > 0) nz = s.min[2] - radius - 0.002;
      else if (dz < 0) nz = s.max[2] + radius + 0.002;
      var box2 = actorBox(null, nx, a.pos[1], nz, radius, height);
      if (!overlapsAny(box2)) {
        a.pos[0] = nx; a.pos[2] = nz;
      }
      if (dx !== 0) a.vel[0] = 0;
      if (dz !== 0) a.vel[2] = 0;
      return;
    }
    a.pos[0] = nx; a.pos[2] = nz;
    // 防掉出地图
    if (a.pos[1] < (GAME.MAP && GAME.MAP.bounds ? GAME.MAP.bounds.min[1] - 4 : -10)) {
      a.pos[1] = -2; a.vel[1] = 0;
    }
  }

  function moveVertical(a, dy, radius, height) {
    if (dy === 0) return;
    var ny = a.pos[1] + dy;
    var box = actorBox(null, a.pos[0], ny, a.pos[2], radius, height);
    var s = overlapsAny(box);
    if (!s) { a.pos[1] = ny; return; }
    if (dy < 0) {
      // 落地
      var top = -Infinity;
      for (var i = 0; i < mapSolids.length; i++) {
        var sol = mapSolids[i];
        var b = actorBox(null, a.pos[0], ny, a.pos[2], radius, height);
        if (M.aabbOverlap(b.min, b.max, sol.min, sol.max)) top = Math.max(top, sol.max[1]);
      }
      if (top !== -Infinity) {
        a.pos[1] = top;
        a.vel[1] = 0;
        a.onGround = true;
      } else {
        a.pos[1] = ny;
      }
    } else {
      var bottom = Infinity;
      for (var j = 0; j < mapSolids.length; j++) {
        var sol2 = mapSolids[j];
        var b2 = actorBox(null, a.pos[0], ny, a.pos[2], radius, height);
        if (M.aabbOverlap(b2.min, b2.max, sol2.min, sol2.max)) bottom = Math.min(bottom, sol2.min[1]);
      }
      if (bottom !== Infinity) {
        a.pos[1] = bottom - height - 0.002;
        a.vel[1] = 0;
      } else {
        a.pos[1] = ny;
      }
    }
  }

  function teleportActor(a, pos) {
    a.pos[0] = pos[0]; a.pos[1] = pos[1]; a.pos[2] = pos[2];
    a.vel[0] = a.vel[1] = a.vel[2] = 0;
    a.onGround = false;
  }

  function segmentBlocked(a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.001) return false;
    var hit = worldRaycast(a, [dx / len, dy / len, dz / len], len);
    return hit.hit && hit.dist < len - 0.12;
  }

  /* ============================================================
     导出
     ============================================================ */
  G.Engine = {
    init: init,
    resize: resize,
    setRenderScale: setRenderScale,
    getRenderScale: getRenderScale,
    getViewSize: getViewSize,
    buildMap: buildMap,
    setCamera: setCamera,
    applyEnv: applyEnv,
    beginFrame: beginFrame,
    drawMap: drawMap,
    drawActor: drawActorModel,
    renderEffects: renderEffects,
    updateEffects: updateEffects,
    renderViewmodel: renderViewmodel,
    worldRaycast: worldRaycast,
    los: los,
    groundHeightAt: groundHeightAt,
    segmentBlocked: segmentBlocked,
    tracer: spawnTracer,
    muzzleFlash: spawnMuzzleFlash,
    impact: spawnImpact,
    blood: spawnBlood,
    deathBurst: spawnDeathBurst,
    drawShadow: drawShadow,
    camera: cam,
    env: env,
    materials: MATERIALS,
    stats: stats,
    getSolids: function () { return mapSolids; },
    GAC: (function () { return gl ? gl.getExtension('EXT_texture_filter_anisotropic') : null; })()
  };

  G.Physics = {
    createActor: createActor,
    moveActor: moveActor,
    teleport: teleportActor,
    groundHeightAt: groundHeightAt,
    segmentBlocked: segmentBlocked,
    solidAt: function (x, y, z, radius, height) { return solidAt(x, y, z, radius || 0.34, height || 1.8); }
  };
})();
