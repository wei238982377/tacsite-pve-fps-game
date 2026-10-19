/* ============================================================
   AI GAME · 沙漠对决 — 数学工具
   世界约定：Y 向上；yaw=0 面向 -Z；pos 一律为脚底坐标。
   ============================================================ */
"use strict";
(function () {
  var G = window.GAME = window.GAME || {};

  var DEG = Math.PI / 180;
  var EPS = 1e-6;

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function wrapAngle(a) {
    a = (a + Math.PI) % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    return a - Math.PI;
  }
  function angleLerp(a, b, t) { return a + wrapAngle(b - a) * t; }
  function sign(x) { return x < 0 ? -1 : (x > 0 ? 1 : 0); }

  /* 确定性伪随机（纹理/装饰用） */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
  function hash2(x, z) {
    var h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return h - Math.floor(h);
  }

  /* ---------------- 三维向量（数组形式，少量分配） ---------------- */
  var v3 = {
    create: function (x, y, z) { return [x || 0, y || 0, z || 0]; },
    clone: function (a) { return [a[0], a[1], a[2]]; },
    set: function (o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; },
    copy: function (o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
    add: function (o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
    sub: function (o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
    scale: function (o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
    addScaled: function (o, a, b, s) { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross: function (o, a, b) {
      var ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
      o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx;
      return o;
    },
    lenSq: function (a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; },
    len: function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
    distSq: function (a, b) {
      var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      return dx * dx + dy * dy + dz * dz;
    },
    dist: function (a, b) { return Math.sqrt(v3.distSq(a, b)); },
    norm: function (o, a) {
      var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
      if (l < EPS) { o[0] = 0; o[1] = 0; o[2] = 0; return o; }
      o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o;
    },
    lerp: function (o, a, b, t) {
      o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t;
      return o;
    }
  };

  /* ---------------- 4x4 矩阵（列主序，WebGL 直接可用） ---------------- */
  var m4 = {
    create: function () {
      var m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },
    identity: function (o) {
      o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
      o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
      o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
      o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
      return o;
    },
    copy: function (o, a) { for (var i = 0; i < 16; i++) o[i] = a[i]; return o; },
    /* out = a * b */
    multiply: function (out, a, b) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
      out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
      out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
      out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
      out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      return out;
    },
    perspective: function (o, fovy, aspect, near, far) {
      var f = 1 / Math.tan(fovy / 2);
      var nf = 1 / (near - far);
      o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0;
      o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
      o[8] = 0; o[9] = 0; o[10] = (far + near) * nf; o[11] = -1;
      o[12] = 0; o[13] = 0; o[14] = 2 * far * near * nf; o[15] = 0;
      return o;
    },
    /* 相机视图矩阵：eye + yaw/pitch（fps 相机） */
    view: function (o, eye, yaw, pitch) {
      var cy = Math.cos(yaw), sy = Math.sin(yaw);
      var cp = Math.cos(pitch), sp = Math.sin(pitch);
      // right / up / forward
      var rx = cy, ry = 0, rz = -sy;
      var fx = -sy * cp, fy = sp, fz = -cy * cp;
      var ux = ry * fz - rz * fy; // cross(right, forward)
      var uy = rz * fx - rx * fz;
      var uz = rx * fy - ry * fx;
      // 注意：cross(right, forward) 得到 up（pitch>0 时向后倾）
      var tx = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
      var ty = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
      // 第三行 = -forward，平移 = dot(forward, eye)
      var tz = fx * eye[0] + fy * eye[1] + fz * eye[2];
      // 第三行 = -forward，平移 = dot(forward, eye)
      o[0] = rx; o[1] = ux; o[2] = -fx; o[3] = 0;
      o[4] = ry; o[5] = uy; o[6] = -fy; o[7] = 0;
      o[8] = rz; o[9] = uz; o[10] = -fz; o[11] = 0;
      o[12] = tx; o[13] = ty; o[14] = tz; o[15] = 1;
      return o;
    },
    /* 由 yaw/pitch/roll 欧拉角 + 位置 + 缩放 组成模型矩阵：R = Ry * Rx * Rz，再缩放 */
    compose: function (o, px, py, pz, yaw, pitch, roll, sx, sy, sz) {
      var cy = Math.cos(yaw), sy2 = Math.sin(yaw);
      var cp = Math.cos(pitch), sp = Math.sin(pitch);
      var cr = Math.cos(roll), sr = Math.sin(roll);
      // Ry*Rx*Rz 矩阵元素
      var m00 = cy * cr + sy2 * sp * sr;
      var m01 = -cy * sr + sy2 * sp * cr;
      var m02 = sy2 * cp;
      var m10 = cp * sr;
      var m11 = cp * cr;
      var m12 = -sp;
      var m20 = -sy2 * cr + cy * sp * sr;
      var m21 = sy2 * sr + cy * sp * cr;
      var m22 = cy * cp;
      if (sx === undefined) { sx = sy = sz = 1; }
      o[0] = m00 * sx; o[1] = m10 * sx; o[2] = m20 * sx; o[3] = 0;
      o[4] = m01 * sy; o[5] = m11 * sy; o[6] = m21 * sy; o[7] = 0;
      o[8] = m02 * sz; o[9] = m12 * sz; o[10] = m22 * sz; o[11] = 0;
      o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
      return o;
    },
    transformPoint: function (o, m, v) {
      var x = v[0], y = v[1], z = v[2];
      var w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w === 0 || w === 1) w = 1; else w = 1 / w;
      o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
      o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
      o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
      return o;
    },
    transformDir: function (o, m, v) {
      var x = v[0], y = v[1], z = v[2];
      o[0] = m[0] * x + m[4] * y + m[8] * z;
      o[1] = m[1] * x + m[5] * y + m[9] * z;
      o[2] = m[2] * x + m[6] * y + m[10] * z;
      return o;
    }
  };

  /* ---------------- 朝向 / 方向工具 ---------------- */
  function forwardFrom(yaw, pitch, out) {
    out = out || [0, 0, 0];
    var cp = Math.cos(pitch || 0);
    out[0] = -Math.sin(yaw) * cp;
    out[1] = Math.sin(pitch || 0);
    out[2] = -Math.cos(yaw) * cp;
    return out;
  }
  function rightFrom(yaw, out) {
    out = out || [0, 0, 0];
    out[0] = Math.cos(yaw);
    out[1] = 0;
    out[2] = -Math.sin(yaw);
    return out;
  }
  function yawPitchToTarget(from, to) {
    var dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    var hl = Math.sqrt(dx * dx + dz * dz);
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, hl) };
  }

  /* ---------------- 射线与 AABB ---------------- */
  /* 返回 {hit, t, normal:[x,y,z]}；t 为 0..maxDist 内的距离 */
  function rayAABB(ox, oy, oz, dx, dy, dz, min, max, maxDist) {
    var tmin = 0, tmax = maxDist;
    var nAxis = -1, nSign = 0;
    var inv, t1, t2, axis, sign;
    // X
    if (Math.abs(dx) < EPS) {
      if (ox < min[0] || ox > max[0]) return null;
    } else {
      inv = 1 / dx;
      t1 = (min[0] - ox) * inv;
      t2 = (max[0] - ox) * inv;
      sign = -1;
      if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; sign = 1; }
      if (t1 > tmin) { tmin = t1; nAxis = 0; nSign = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    // Y
    if (Math.abs(dy) < EPS) {
      if (oy < min[1] || oy > max[1]) return null;
    } else {
      inv = 1 / dy;
      t1 = (min[1] - oy) * inv;
      t2 = (max[1] - oy) * inv;
      sign = -1;
      if (t1 > t2) { var tt2 = t1; t1 = t2; t2 = tt2; sign = 1; }
      if (t1 > tmin) { tmin = t1; nAxis = 1; nSign = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    // Z
    if (Math.abs(dz) < EPS) {
      if (oz < min[2] || oz > max[2]) return null;
    } else {
      inv = 1 / dz;
      t1 = (min[2] - oz) * inv;
      t2 = (max[2] - oz) * inv;
      sign = -1;
      if (t1 > t2) { var tt3 = t1; t1 = t2; t2 = tt3; sign = 1; }
      if (t1 > tmin) { tmin = t1; nAxis = 2; nSign = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (tmin < 0 || tmin > maxDist) return null;
    var n = [0, 0, 0];
    if (nAxis >= 0) n[nAxis] = nSign;
    return { hit: true, t: tmin, normal: n, axis: nAxis };
  }

  /* ---------------- AABB 重叠 ---------------- */
  function aabbOverlap(aMin, aMax, bMin, bMax) {
    return aMin[0] < bMax[0] && aMax[0] > bMin[0] &&
           aMin[1] < bMax[1] && aMax[1] > bMin[1] &&
           aMin[2] < bMax[2] && aMax[2] > bMin[2];
  }

  G.M = {
    DEG: DEG, EPS: EPS,
    clamp: clamp, lerp: lerp, smoothstep: smoothstep,
    wrapAngle: wrapAngle, angleLerp: angleLerp, sign: sign,
    rand: rand, randInt: randInt, mulberry32: mulberry32, hash2: hash2,
    v3: v3, m4: m4,
    forwardFrom: forwardFrom, rightFrom: rightFrom, yawPitchToTarget: yawPitchToTarget,
    rayAABB: rayAABB, aabbOverlap: aabbOverlap
  };
})();
