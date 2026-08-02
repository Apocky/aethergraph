'use strict';
/*
 * Aethergraph — a relational view for Obsidian notes.
 *
 * SPACE. Three axes, orbited freely, and optionally tiered into strata you can look between.
 * A flat graph forces every relation to compete for two degrees of freedom; with a third,
 * standing can be height while domain stays planar, and a link that climbs between tiers
 * becomes visible AS a climb.
 *
 * NODES carry nine channels: radius=standing, shape=role family, hue=facet wedges,
 * size=mass+load, saturation=corroboration, opacity=age, core=authority, ring=privacy,
 * bloom=contested, outer arc=hybridity.
 *
 * EDGES carry a typed relation, weight, the facet the two notes share, reach (distance in
 * standing), span (distance in time), and a facet-gap attribute. V3 adds builder-owned
 * relevance, reason, signals and presentation tier. The renderer never promotes a relation
 * because of a facet gap: it is a muted descriptor, not evidence of meaning.
 *
 * RENDERING is WebGL2 (see gl.js), for two reasons that are really one reason. The canvas-2D
 * path issued a draw call per primitive — 21,000 per frame at full density — and sorted them
 * all by depth on the CPU, which is both expensive and *approximate*: a per-object sort
 * cannot resolve a curve passing through a cluster. Instancing collapses the draw calls to
 * two, and the hardware depth buffer resolves occlusion per fragment, so the sort disappears
 * rather than being improved. Node positions live in a texture that edges sample by index, so
 * per-frame upload is 91 KB and does not grow with edge count.
 *
 * A HYBRID, deliberately: GL for the graph, a 2D overlay for text, tier rings, ghosts and
 * severed pairs. Glyph rendering in GL means atlases and looks worse than the browser's own.
 * Both surfaces are driven by the SAME camera matrix, so a label lands exactly on its mark.
 *
 * The canvas-2D renderer is retained in full and takes over automatically if WebGL2 is
 * unavailable or a shader fails to compile.
 *
 * Standing is NOT certainty. See README.
 *
 * No build step or bundled third-party dependency. An optional enhanced v3 payload can add
 * qualified semantic relations; without one, Aethergraph builds a local authored-link graph
 * from Obsidian's metadata cache.
 */

const { Plugin, ItemView, Notice, PluginSettingTab, Setting, Menu } = require('obsidian');

/* ==================================================================================
 * RENDERER — WebGL2. Inlined deliberately.
 *
 * This lived in a separate gl.js and `require('./gl.js')` looked reasonable. It is not:
 * Obsidian evaluates a plugin's main.js through its own wrapper, and a relative require
 * does NOT resolve against the plugin folder. The renderer silently failed to load, the
 * camera matrix came back null, and every frame threw behind a blank canvas while the
 * chrome and status line — plain DOM — kept rendering as if all were well.
 *
 * "No build step" is only true for a plugin that is ONE file. That is the constraint, so
 * this is one file. Nothing below is loaded, resolved, or bundled at runtime.
 * ================================================================================== */

/*
 * WebGL2 renderer for Aethergraph.
 *
 * WHY. The canvas-2D path issued one draw call per primitive. At "Everything" that is thousands
 * of nodes plus every edge — tens of thousands of JS→native crossings per frame — and JS was
 * also depth-sorting all of it on the CPU with a painter's algorithm that is *approximate*
 * even when it succeeds. Two problems, one root cause: immediate-mode drawing cannot batch,
 * and per-object sorting cannot resolve a curve that passes through a cluster.
 *
 * Both dissolve on the GPU:
 *
 *   INSTANCING — every node is one instanced quad, every edge one instanced ribbon. Two draw
 *   calls total instead of twenty-one thousand.
 *
 *   THE DEPTH BUFFER — occlusion is resolved per fragment by hardware. Nothing is sorted, and
 *   an edge passing behind a node is hidden correctly. The bug is not fixed so much as made
 *   unrepresentable.
 *
 *   POSITIONS IN A TEXTURE — the simulation writes one RGBA32F texture per frame (x, y, z,
 *   dim). Edges store node *indices* and fetch both endpoints in the vertex shader, so edge
 *   geometry is uploaded once and never again. Per-frame bandwidth is 91 KB at full density
 *   instead of 455 KB, and it does not grow with edge count at all.
 *
 *   MOTION IN THE SHADER — Bézier evaluation, ribbon extrusion and the travelling flow
 *   highlight are all computed from a time uniform on the GPU. They cost the CPU nothing
 *   regardless of how many edges are lit.
 *
 *   ID-BUFFER PICKING — hover reads a single pixel from an ID target instead of testing the
 *   cursor against every node in JS. O(1) rather than O(n), and pixel-exact against the same
 *   shapes that were actually drawn.
 *
 * No build step and no dependencies: raw WebGL2 is plain JavaScript and Obsidian runs on
 * Electron/Chromium, where it is available natively. Only a *library* would need bundling.
 *
 * Text is deliberately not drawn here — glyphs in GL mean atlases and look worse than the
 * browser's own rasteriser. Labels go on a 2D overlay canvas driven by the same matrix, which
 * is the standard hybrid. If context creation or shader compilation fails, main.js falls back
 * to the canvas-2D renderer, which is retained in full.
 */

const TEXW = 1024;              /* position texture is TEXW wide; height grows with node count */

/* Shared shader prelude. hsl→rgb on the GPU so the CPU never builds a colour string, and a
   signed-distance function for a regular n-gon so role-family shape stays crisp at any zoom
   without any per-shape geometry. */
const COMMON = `
vec3 hsl2rgb(float h, float s, float l) {
  h = mod(h, 360.0) / 60.0;
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float x = c * (1.0 - abs(mod(h, 2.0) - 1.0));
  vec3 r = h < 1.0 ? vec3(c, x, 0.0) : h < 2.0 ? vec3(x, c, 0.0) : h < 3.0 ? vec3(0.0, c, x)
         : h < 4.0 ? vec3(0.0, x, c) : h < 5.0 ? vec3(x, 0.0, c) : vec3(c, 0.0, x);
  return r + (l - c * 0.5);
}
float sdNgon(vec2 p, float n) {
  float r = length(p);
  if (n < 2.5) return r;
  float a = atan(p.x, p.y) + 3.14159265;
  float seg = 6.28318531 / n;
  return cos(floor(0.5 + a / seg) * seg - a) * r / cos(seg * 0.5);
}`;

const FETCH = `
uniform highp sampler2D u_pos;
vec4 fetchNode(float idx) {
  int i = int(idx + 0.5);
  return texelFetch(u_pos, ivec2(i % ${TEXW}, i / ${TEXW}), 0);
}`;

const NODE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;      /* unit quad, -1..1 */
layout(location=1) in float i_index;      /* row in the position texture */
layout(location=2) in float i_size;       /* base radius, world units */
layout(location=3) in vec4 i_hue;         /* up to four facet hues in degrees; -1 = unused */
layout(location=4) in vec4 i_style;       /* sides, saturation, lightness, base alpha */
layout(location=5) in vec4 i_flags;       /* authority rank, privacy code, contested, hybridity */
${FETCH}
uniform mat4 u_vp;
uniform vec2 u_halfPx;                    /* half viewport in device pixels */
uniform float u_pxPerUnit;                /* pixels per world unit at unit depth */
uniform vec2 u_pxClamp;                   /* min/max on-screen radius */
uniform float u_grow;                     /* extra margin for blooms and rings */
uniform vec2 u_fog;                       /* near, range — depth haze, computed on the GPU */
out vec2 v_local;
out vec4 v_hue;
out vec4 v_style;
out vec4 v_flags;
out float v_index;
out float v_dim;
out float v_fog;
void main() {
  vec4 nd = fetchNode(i_index);
  vec4 clip = u_vp * vec4(nd.xyz, 1.0);
  /* Pixel-exact sizing with clamping: divide by clip.w for perspective, then multiply the
     NDC offset back by clip.w so the hardware divide restores exactly what we asked for. */
  float px = clamp(i_size * u_pxPerUnit / max(clip.w, 0.001), u_pxClamp.x, u_pxClamp.y) * u_grow;
  vec2 ndc = (a_corner * px) / u_halfPx;
  gl_Position = vec4(clip.xy + ndc * clip.w, clip.zw);
  v_local = a_corner * u_grow;
  v_hue = i_hue; v_style = i_style; v_flags = i_flags;
  v_index = i_index;
  v_dim = nd.w;
  v_fog = clamp(1.0 - (clip.w - u_fog.x) / max(u_fog.y, 1.0), 0.10, 1.0);
}`;

const NODE_FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec4 v_hue;
in vec4 v_style;
in vec4 v_flags;
in float v_index;
in float v_dim;
in float v_fog;
uniform int u_idPass;
out vec4 outColor;
${COMMON}
void main() {
  float sides = v_style.x;
  float d = sdNgon(v_local, sides);

  if (u_idPass == 1) {                     /* pick target: instance id encoded as colour */
    if (d > 1.0) discard;
    float id = v_index + 1.0;
    outColor = vec4(mod(id, 256.0) / 255.0,
                    mod(floor(id / 256.0), 256.0) / 255.0,
                    mod(floor(id / 65536.0), 256.0) / 255.0, 1.0);
    return;
  }

  /* dim carries focus state: >1.5 means this node is the focus or under the cursor */
  float hi = v_dim > 1.5 ? 1.0 : 0.0;
  float dim = v_dim > 1.5 ? v_dim - 2.0 : v_dim;
  if (dim < 0.02) discard;

  /* facet wedges: hue chosen by angle, so one mark shows every domain it belongs to */
  int n = 0;
  for (int i = 0; i < 4; i++) { if (v_hue[i] >= 0.0) n++; }
  n = max(n, 1);
  float ang = atan(v_local.x, -v_local.y);
  if (ang < 0.0) ang += 6.28318531;
  int idx = clamp(int(floor(ang / (6.28318531 / float(n)))), 0, n - 1);
  float hue = v_hue[idx] < 0.0 ? v_hue[0] : v_hue[idx];

  vec3 col = hsl2rgb(hue, v_style.y, v_style.z);
  float a = v_style.w * dim * v_fog;
  float body = 1.0 - smoothstep(0.94, 1.02, d);

  float ar = v_flags.x;                    /* authority: a bright core, radius by rank */
  if (ar > 0.0) {
    float core = 1.0 - smoothstep(0.0, 0.14 + ar * 0.10, d);
    col = mix(col, vec3(1.0, 0.99, 0.92), core * (0.18 + ar * 0.19));
  }
  if (v_flags.w > 0.24) {                  /* hybridity: violet ring where domains overlap */
    float ring = smoothstep(1.06, 1.12, d) * (1.0 - smoothstep(1.18, 1.26, d));
    col = mix(col, vec3(0.78, 0.55, 0.96), ring * v_flags.w);
    body = max(body, ring * v_flags.w * 0.85);
  }
  float pv = v_flags.y;                    /* privacy: dashed ring, pattern set by lane */
  if (pv > 0.5) {
    float ring = smoothstep(1.28, 1.34, d) * (1.0 - smoothstep(1.42, 1.50, d));
    float dash = step(0.0, sin(ang * (pv < 1.5 ? 26.0 : pv < 2.5 ? 44.0 : 13.0)));
    vec3 pc = pv < 1.5 ? vec3(0.94, 0.70, 0.35)
            : pv < 2.5 ? vec3(0.95, 0.45, 0.55) : vec3(1.0, 0.35, 0.43);
    col = mix(col, pc, ring * dash);
    body = max(body, ring * dash * 0.9);
  }
  if (v_flags.z > 0.5) {                   /* contested: soft red bloom outside the silhouette */
    float outside = smoothstep(1.00, 1.06, d);
    col = mix(col, vec3(0.95, 0.43, 0.51), outside * 0.85 + 0.12);
    body = max(body, smoothstep(1.75, 1.02, d) * outside * 0.30);
  }
  if (hi > 0.5) {                          /* hover / focus halo */
    float ring = smoothstep(1.50, 1.58, d) * (1.0 - smoothstep(1.68, 1.76, d));
    col = mix(col, vec3(1.0), ring);
    body = max(body, ring);
  }
  if (body <= 0.002) discard;
  outColor = vec4(col, a * body);
}`;

const EDGE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 i_ends;        /* node indices, a and b */
layout(location=1) in vec4 i_meta;        /* weight, shared-facet hue (-1 none), facet gap, reach */
layout(location=2) in vec2 i_extra;       /* span, kind (0 explicit, 1 latent) */
${FETCH}
uniform mat4 u_vp;
uniform vec2 u_halfPx;
uniform int u_segments;
uniform vec4 u_show;                      /* explicit, latent, unused, unused */
uniform vec2 u_fog;
uniform vec2 u_width;                     /* ribbon width: base px, px per unit of weight */
out vec4 v_meta;
out vec2 v_extra;
out float v_t;
out float v_dim;
out float v_fog;

/* Quadratic Bezier bowed by reach and lifted off-plane by span: the arc itself carries two
   dimensions a straight line could not. */
vec3 bez(vec3 a, vec3 b, float reach, float span, float t) {
  vec3 mid = (a + b) * 0.5;
  vec3 dir = b - a;
  vec3 nd = normalize(dir + vec3(1e-5));
  vec3 up = abs(nd.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 perp = normalize(cross(dir, up) + vec3(1e-5));
  vec3 ctrl = mid + perp * (reach * 96.0 + 18.0) + vec3(0.0, 0.0, span * 62.0);
  float it = 1.0 - t;
  return it * it * a + 2.0 * it * t * ctrl + t * t * b;
}

void main() {
  float show = i_extra.y > 0.5 ? u_show.y : u_show.x;
  vec4 na = fetchNode(i_ends.x), nb = fetchNode(i_ends.y);
  float da = na.w > 1.5 ? na.w - 2.0 : na.w;
  float db = nb.w > 1.5 ? nb.w - 2.0 : nb.w;
  v_dim = min(da, db) * show;
  v_meta = i_meta; v_extra = i_extra; v_t = 0.0; v_fog = 1.0;
  if (v_dim < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }  /* cull off-clip */

  /* TRIANGLE_STRIP ribbon: vertex id splits into segment and side, so thickness is real
     geometry rather than gl.lineWidth, which most drivers clamp to a single pixel. */
  int vid = gl_VertexID;
  float seg = float(vid / 2);
  float side = (vid % 2 == 0) ? -1.0 : 1.0;
  float t = seg / float(u_segments);
  float t2 = min(t + 1.0 / float(u_segments), 1.0);
  if (t2 == t) { t = 1.0 - 1.0 / float(u_segments); t2 = 1.0; }

  vec3 p0 = bez(na.xyz, nb.xyz, i_meta.w, i_extra.x, seg / float(u_segments));
  vec3 p1 = bez(na.xyz, nb.xyz, i_meta.w, i_extra.x, t2);
  vec4 c0 = u_vp * vec4(p0, 1.0), c1 = u_vp * vec4(p1, 1.0);
  vec2 s0 = c0.xy / max(abs(c0.w), 0.001) * u_halfPx;
  vec2 s1 = c1.xy / max(abs(c1.w), 0.001) * u_halfPx;
  vec2 dirS = s1 - s0;
  vec2 nrm = normalize(vec2(-dirS.y, dirS.x) + vec2(1e-5));
  /* A GL ribbon covers its pixels fully; the canvas hairline it replaces was antialiased to
     a fraction of one. Matching the old *numbers* here produced sheets of colour instead of
     a graph, so width and alpha are uniforms, tuned against a full production payload. */
  float gapScale = i_meta.z > 0.5 ? 0.62 : (i_meta.z < -0.5 ? 0.74 : 1.0);
  float wpx = clamp((u_width.x + i_meta.x * u_width.y) * gapScale, 0.25, 3.0) * 0.5;
  vec2 ndc = (nrm * side * wpx) / u_halfPx;
  gl_Position = vec4(c0.xy + ndc * c0.w, c0.zw);
  v_t = seg / float(u_segments);
  v_fog = clamp(1.0 - (c0.w - u_fog.x) / max(u_fog.y, 1.0), 0.10, 1.0);
}`;

const EDGE_FS = `#version 300 es
precision highp float;
in vec4 v_meta;
in vec2 v_extra;
in float v_t;
in float v_dim;
in float v_fog;
uniform float u_time;
uniform float u_flow;
uniform vec3 u_alpha;                     /* explicit, latent base, latent per unit weight */
out vec4 outColor;
${COMMON}
void main() {
  float facetGap = v_meta.z;
  float untypedFacet = facetGap < -0.5 ? 1.0 : 0.0;
  float mutedFacet = abs(facetGap) > 0.5 ? 1.0 : 0.0;
  float hue = mutedFacet > 0.5 ? 215.0 : (v_meta.y >= 0.0 ? v_meta.y : 210.0);
  float sat = mutedFacet > 0.5 ? (untypedFacet > 0.5 ? 0.06 : 0.12) : (v_meta.y >= 0.0 ? 0.62 : 0.24);
  vec3 col = hsl2rgb(hue, sat, mutedFacet > 0.5 ? 0.64 : 0.72);
  float a = (v_extra.y > 0.5 ? u_alpha.y + v_meta.x * u_alpha.z : u_alpha.x) * v_dim * v_fog;
  if (u_flow > 0.5) {
    /* Travelling highlight, phase from time. Free: no CPU particle bookkeeping at any count. */
    float speed = 0.16 + v_meta.x * 0.5;
    float ph = fract(v_t - u_time * speed);
    float pulse = smoothstep(0.07, 0.0, ph);
    col += pulse * 0.55;
    a += pulse * 0.40 * v_dim;
  }
  if (facetGap > 0.5) a *= 0.46;
  else if (untypedFacet > 0.5) a *= 0.32;
  if (a < 0.004) discard;
  outColor = vec4(col, a);
}`;

function compile(gl, type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(name + ': ' + log);
  }
  return sh;
}
function program(gl, vs, fs, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, name + '.vert'));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, name + '.frag'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ' link: ' + gl.getProgramInfoLog(p));
  return p;
}
function uniforms(gl, p, names) {
  const o = {};
  for (const n of names) o[n] = gl.getUniformLocation(p, n);
  return o;
}

class GLRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: true, alpha: true, premultipliedAlpha: false, depth: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.canvas = canvas;
    this.SEG = 12;

    this.nodeProg = program(gl, NODE_VS, NODE_FS, 'node');
    this.edgeProg = program(gl, EDGE_VS, EDGE_FS, 'edge');
    this.nu = uniforms(gl, this.nodeProg,
      ['u_vp', 'u_pos', 'u_halfPx', 'u_pxPerUnit', 'u_pxClamp', 'u_grow', 'u_idPass', 'u_fog']);
    this.eu = uniforms(gl, this.edgeProg,
      ['u_vp', 'u_pos', 'u_halfPx', 'u_segments', 'u_show', 'u_time', 'u_flow', 'u_fog',
        'u_width', 'u_alpha']);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.nBuf = { index: gl.createBuffer(), size: gl.createBuffer(), hue: gl.createBuffer(),
      style: gl.createBuffer(), flags: gl.createBuffer() };
    this.eBuf = { ends: gl.createBuffer(), meta: gl.createBuffer(), extra: gl.createBuffer() };
    this.nodeVao = gl.createVertexArray();
    this.edgeVao = gl.createVertexArray();
    this._wireVaos();

    this.posTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.posTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texH = 0;
    this.posBuf = new Float32Array(TEXW * 4);

    this.pickFbo = gl.createFramebuffer();
    this.pickTex = gl.createTexture();
    this.pickDepth = gl.createRenderbuffer();
    this.pickSize = [0, 0];
    this.counts = { nodes: 0, edges: 0 };
  }

  _wireVaos() {
    const gl = this.gl;
    const inst = (loc, buf, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
    };
    gl.bindVertexArray(this.nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    inst(1, this.nBuf.index, 1); inst(2, this.nBuf.size, 1); inst(3, this.nBuf.hue, 4);
    inst(4, this.nBuf.style, 4); inst(5, this.nBuf.flags, 4);

    gl.bindVertexArray(this.edgeVao);
    inst(0, this.eBuf.ends, 2); inst(1, this.eBuf.meta, 4); inst(2, this.eBuf.extra, 2);
    gl.bindVertexArray(null);
  }

  /* Static per-relayout upload. Nothing here is touched again while the camera moves. */
  setNodes(a, count) {
    const gl = this.gl;
    const put = (b, d) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW); };
    put(this.nBuf.index, a.index); put(this.nBuf.size, a.size); put(this.nBuf.hue, a.hue);
    put(this.nBuf.style, a.style); put(this.nBuf.flags, a.flags);
    this.counts.nodes = count;
    const h = Math.max(1, Math.ceil(Math.max(count, 1) / TEXW));
    if (h !== this.texH) {
      gl.bindTexture(gl.TEXTURE_2D, this.posTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXW, h, 0, gl.RGBA, gl.FLOAT, null);
      this.texH = h;
      this.posBuf = new Float32Array(TEXW * h * 4);
    }
  }
  setEdges(a, count) {
    const gl = this.gl;
    const put = (b, d) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW); };
    put(this.eBuf.ends, a.ends); put(this.eBuf.meta, a.meta); put(this.eBuf.extra, a.extra);
    this.counts.edges = count;
  }

  /* The only per-frame upload: one texture of (x, y, z, dim). 91 KB at full density, and it
     does not grow with edge count, because edges fetch their endpoints from here. */
  uploadPositions() {
    if (!this.texH) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.posTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXW, this.texH, gl.RGBA, gl.FLOAT, this.posBuf);
  }

  resize(w, h, dpr) {
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
      this.pickSize = [0, 0];
    }
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  _bindPos(loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.posTex);
    gl.uniform1i(loc, 0);
  }

  draw(vp, o) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    /* Edges: depth-TESTED so nodes occlude them correctly, depth-WRITE off so translucent
       arcs do not mask each other. This pair is what replaces the CPU sort entirely. */
    if (this.counts.edges) {
      gl.useProgram(this.edgeProg);
      gl.depthMask(false);
      gl.bindVertexArray(this.edgeVao);
      this._bindPos(this.eu.u_pos);
      gl.uniformMatrix4fv(this.eu.u_vp, false, vp);
      gl.uniform2f(this.eu.u_halfPx, W / 2, H / 2);
      gl.uniform1i(this.eu.u_segments, this.SEG);
      gl.uniform4f(this.eu.u_show, o.showExplicit ? 1 : 0, o.showLatent ? 1 : 0, 1, 1);
      gl.uniform2f(this.eu.u_fog, o.fogNear, o.fogRange);
      gl.uniform2f(this.eu.u_width, o.widthBase, o.widthScale);
      gl.uniform3f(this.eu.u_alpha, o.alphaExplicit, o.alphaLatent, o.alphaLatentScale);
      gl.uniform1f(this.eu.u_time, o.time);
      gl.uniform1f(this.eu.u_flow, o.flow ? 1 : 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (this.SEG + 1) * 2, this.counts.edges);
    }
    /* Nodes: depth write on. Hardware resolves occlusion per fragment; nothing is sorted. */
    if (this.counts.nodes) {
      gl.useProgram(this.nodeProg);
      gl.depthMask(true);
      gl.bindVertexArray(this.nodeVao);
      this._bindPos(this.nu.u_pos);
      gl.uniformMatrix4fv(this.nu.u_vp, false, vp);
      gl.uniform2f(this.nu.u_halfPx, W / 2, H / 2);
      gl.uniform1f(this.nu.u_pxPerUnit, o.pxPerUnit);
      gl.uniform2f(this.nu.u_pxClamp, 1.2 * o.dpr, 34 * o.dpr);
      gl.uniform1f(this.nu.u_grow, 1.8);
      gl.uniform2f(this.nu.u_fog, o.fogNear, o.fogRange);
      gl.uniform1i(this.nu.u_idPass, 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.counts.nodes);
    }
    gl.bindVertexArray(null);
  }

  /* One pixel read instead of a distance test against every node, and it hits the real
     silhouette rather than a bounding circle. */
  pick(vp, x, y, o) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    if (!this.counts.nodes) return -1;
    if (this.pickSize[0] !== W || this.pickSize[1] !== H) {
      gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.pickSize = [W, H];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.useProgram(this.nodeProg);
    gl.bindVertexArray(this.nodeVao);
    this._bindPos(this.nu.u_pos);
    gl.uniformMatrix4fv(this.nu.u_vp, false, vp);
    gl.uniform2f(this.nu.u_halfPx, W / 2, H / 2);
    gl.uniform1f(this.nu.u_pxPerUnit, o.pxPerUnit);
    /* a floor of a few pixels so distant marks stay reachable by the cursor */
    gl.uniform2f(this.nu.u_pxClamp, 4.5 * o.dpr, 34 * o.dpr);
    gl.uniform1f(this.nu.u_grow, 1.0);
    gl.uniform2f(this.nu.u_fog, 1e9, 1e9);   /* no haze in the pick pass — ids must be exact */
    gl.uniform1i(this.nu.u_idPass, 1);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.counts.nodes);
    const px = new Uint8Array(4);
    const gx = Math.round(x * o.dpr), gy = Math.round(H - y * o.dpr);
    if (gx >= 0 && gy >= 0 && gx < W && gy < H) {
      gl.readPixels(gx, gy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    const id = px[0] + px[1] * 256 + px[2] * 65536;
    return id > 0 ? id - 1 : -1;
  }

  dispose() {
    const gl = this.gl;
    for (const b of [...Object.values(this.nBuf), ...Object.values(this.eBuf), this.quad]) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.nodeVao); gl.deleteVertexArray(this.edgeVao);
    gl.deleteProgram(this.nodeProg); gl.deleteProgram(this.edgeProg);
    gl.deleteTexture(this.posTex); gl.deleteTexture(this.pickTex);
    gl.deleteFramebuffer(this.pickFbo); gl.deleteRenderbuffer(this.pickDepth);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }
}

/* Column-major 4x4 helpers. The entire camera, with no matrix library. */
function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                   + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
/* Orbit around the origin: yaw about Z, pitch about X, then push back along -Z.
 *
 * The pitch rows are negated relative to the obvious form, and that is deliberate. GL view
 * space has +y up and looks down -z; the canvas-2D renderer this replaces worked in +y down
 * with depth increasing away. Writing pitch the obvious way inverted BOTH — the vault would
 * have rendered upside down with near and far swapped, which reads as a plausible picture and
 * is wrong. Negating both rows reproduces the original convention exactly: at pitch 0 the view
 * is top-down onto the tier planes with world +z receding, and at pitch π/2 tier height is
 * screen-up. The matrix stays a proper rotation — rows orthonormal, determinant +1.
 */
function orbitView(yaw, pitch, dist, ox, oy) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const rotZ = new Float32Array([cy, sy, 0, 0, -sy, cy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const rotX = new Float32Array([1, 0, 0, 0, 0, -cp, -sp, 0, 0, sp, -cp, 0, 0, 0, 0, 1]);
  const trans = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ox, oy, -dist, 1]);
  return mat4Mul(trans, mat4Mul(rotX, rotZ));
}
/* Project a world point with the same matrix the GPU uses, so overlay text lands exactly on
   the mark it names. Returns CSS pixels plus depth for fog.
 *
 * `out` lets the caller pass a scratch object to write into. The label pass runs over every
 * node every frame; allocating a result object per node was ~5,700 short-lived objects per
 * frame at full density, which is pure garbage-collector churn for a value read once. */
function projectWith(vp, p, W, H, out) {
  const x = vp[0] * p.x + vp[4] * p.y + vp[8] * p.z + vp[12];
  const y = vp[1] * p.x + vp[5] * p.y + vp[9] * p.z + vp[13];
  const z = vp[2] * p.x + vp[6] * p.y + vp[10] * p.z + vp[14];
  const w = vp[3] * p.x + vp[7] * p.y + vp[11] * p.z + vp[15];
  const behind = w <= 0.01;
  const iw = 1 / (behind ? 0.01 : w);
  const o = out || {};
  o.x = (x * iw * 0.5 + 0.5) * W;
  o.y = (0.5 - y * iw * 0.5) * H;
  o.w = iw; o.depth = z * iw; o.clipW = w; o.behind = behind;
  return o;
}

const GL = { GLRenderer, mat4Mul, perspective, orbitView, projectWith, TEXW };

/* ==================================================================================
 * TELEMETRY
 *
 * Written because this plugin has already shipped three defects that were invisible from
 * the inside: a sign-flipped camera that rendered a plausible but wrong picture, edge widths
 * that piled into sheets of colour, and a renderer that failed to load behind a perfectly
 * healthy toolbar. Every one was found by instrumenting, never by looking. So: measure the
 * frame, name the phase that costs, keep the slow ones, and record what actually happened.
 *
 * PRIVACY. A vault may contain `private-local` material. Diagnostics that record what
 * you hover and open necessarily records note identity, so it honours the lanes the vault
 * already defines rather than inventing a second policy: known lanes are represented only by
 * a salted local pseudonym plus the lane name; anything
 * explicitly marked `withhold_from_telemetry` is not recorded at all, in any form. The salt
 * persists in plugin data and never
 * appears in a log. This is pseudonymisation, not encryption — a hash is only as private as
 * the salt, and anyone holding both the log and the vault could confirm a guess. It exists so
 * the log does not *contain* private strings, which is the property that matters when a file
 * gets copied somewhere it shouldn't be.
 *
 * COST. The whole apparatus must not become the thing it measures. Recording a frame is six
 * writes into preallocated Float64Arrays. Percentiles are computed only when the panel is
 * visible, at 4 Hz, over a copy. Nothing allocates per frame. The event stream touches disk
 * only when the file sink is switched on, and then only in batches.
 * ================================================================================== */

const TEL = {
  SCHEMA: 'aethergraph.telemetry.v1',
  FRAMES: 900,          /* ~15 s at 60 fps — long enough for p99 to mean something */
  EVENTS: 600,
  SLOW: 60,
  ERRORS: 40,
  FLUSH_MS: 2000,
  FLUSH_LINES: 128,
  MAX_BYTES: 4 * 1024 * 1024,
  KEEP_FILES: 8,
  DIR: '.aethergraph/diagnostics',
  HOVER_DWELL_MS: 400,  /* below this it is the cursor crossing the graph, not attention */
};
const CONSOLE_LEVELS = { off: 'Console · silent', warn: 'Console · warnings', info: 'Console · info', debug: 'Console · everything' };
const LEVEL_RANK = { off: 0, warn: 1, info: 2, debug: 3 };

/* Fixed-capacity history. A growing array would make the telemetry the memory leak. */
class Ring {
  constructor(n) { this.cap = n; this.buf = new Array(n); this.i = 0; this.len = 0; }
  push(v) { this.buf[this.i] = v; this.i = (this.i + 1) % this.cap; if (this.len < this.cap) this.len++; return v; }
  toArray() {
    const out = [];
    for (let k = 0; k < this.len; k++) out.push(this.buf[(this.i - this.len + k + this.cap) % this.cap]);
    return out;
  }
  last(n) { const a = this.toArray(); return a.slice(Math.max(0, a.length - n)); }
  clear() { this.i = 0; this.len = 0; this.buf = new Array(this.cap); }
}

/* One numeric channel. Push is two stores and an add — cheap enough to sit in the frame loop.
   Percentiles sort a copy, and only when something is actually looking. */
class Chan {
  constructor(n) { this.cap = n; this.buf = new Float64Array(n); this.i = 0; this.len = 0; this.sum = 0; this.max = 0; this.n = 0; }
  push(v) {
    this.buf[this.i] = v; this.i = (this.i + 1) % this.cap;
    if (this.len < this.cap) this.len++;
    this.sum += v; this.n++;
    if (v > this.max) this.max = v;
  }
  stats() {
    if (!this.len) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, recentMean: 0 };
    const a = Array.prototype.slice.call(this.buf, 0, this.len).sort((x, y) => x - y);
    const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    let s = 0; for (let k = 0; k < a.length; k++) s += a[k];
    return { n: this.n, mean: this.sum / this.n, recentMean: s / a.length,
      p50: q(0.5), p95: q(0.95), p99: q(0.99), max: this.max };
  }
  clear() { this.i = 0; this.len = 0; this.sum = 0; this.max = 0; this.n = 0; }
}

/* FNV-1a over (salt + value), widened to 64 bits by running two independent offsets. Not a
   cryptographic hash and not claimed to be — see the privacy note above. */
function pseudonym(value, salt) {
  /* NUL separator: it cannot occur in a path, so `a`+`bc` and `ab`+`c` cannot collide.
     Written as an ESCAPE rather than a literal NUL byte. A raw one makes grep, ripgrep
     and every other text tool treat this entire file as binary and refuse to search it,
     which actively obstructs anyone reading the plugin later. */
  const s = String(salt || '') + '\u0000' + String(value || '');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0; h2 = Math.imul(h2, 0x85ebca6b) >>> 0; h2 ^= h2 >>> 13;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
function randomSalt() {
  const a = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

class Telemetry {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.session = pseudonym(String(Date.now()) + Math.random(), 'session').slice(0, 10);
    this.started = Date.now();
    /* Keep the first-run salt ephemeral. It is persisted only after the user explicitly enables
       diagnostics, so merely installing or loading the plugin creates no diagnostic state. */
    this.salt = plugin.settings.telemetrySalt || randomSalt();
    this.frame = {
      total: new Chan(TEL.FRAMES), sim: new Chan(TEL.FRAMES), upload: new Chan(TEL.FRAMES),
      draw: new Chan(TEL.FRAMES), overlay: new Chan(TEL.FRAMES), pick: new Chan(TEL.FRAMES),
    };
    this.events = new Ring(TEL.EVENTS);
    this.slow = new Ring(TEL.SLOW);
    this.errors = new Map();          /* keyed, so a repeating fault is one row with a count */
    this.counters = Object.create(null);
    this.env = {};
    this.health = [];
    this.pending = [];
    this.filePath = null;
    this.fileBytes = 0;
    this.fileErr = null;
    this.lastFlush = Date.now();
    this.longFrames = 0;
  }

  get level() { return LEVEL_RANK[this.plugin.settings.telemetryConsole] || 0; }
  get slowMs() { return this.plugin.settings.slowFrameMs || 24; }
  get enabled() {
    return !!(this.plugin.settings.telemetry || this.plugin.settings.telemetryFile);
  }

  count(k, n) {
    if (!this.enabled) return;
    this.counters[k] = (this.counters[k] || 0) + (n === undefined ? 1 : n);
  }

  /* Privacy-aware identity. This is the single choke point — nothing else in the plugin may
     put a note into telemetry, so the policy cannot be bypassed by forgetting it somewhere. */
  ref(d) {
    if (!d || !this.enabled) return null;
    const lane = typeof d.privacy === 'string' && d.privacy ? d.privacy : 'unknown';
    const known = lane === 'agent-safe' || lane === 'private-local'
      || lane === 'restricted-pointer' || lane === 'quarantined';
    if (!known || d.withhold_from_telemetry === true) return { lane, ref: 'withheld:policy' };
    const identity = d.path || d.id || d.title || '';
    return { lane, ref: 'h:' + pseudonym(identity, this.salt) };
  }

  mark(kind, data) {
    if (!this.enabled) return null;
    const e = { t: Date.now() - this.started, kind };
    if (data) e.d = data;
    this.events.push(e);
    this.count('event.' + kind.split('.')[0]);
    if (this.level >= 3 || (this.level >= 2 && !/^frame|^hover/.test(kind))) {
      console.debug('[aethergraph]', kind, data === undefined ? '' : data);
    }
    this.line({ v: 'e', ...e });
    return e;
  }

  err(where, e) {
    if (!this.enabled) {
      if (this.level >= 1) console.error('[aethergraph] ' + where, e);
      return null;
    }
    const msg = (e && e.message) ? e.message : String(e);
    const key = where + '|' + msg;
    const prev = this.errors.get(key);
    if (prev) { prev.n++; prev.last = Date.now() - this.started; }
    else {
      this.errors.set(key, { where, msg, n: 1,
        first: Date.now() - this.started, last: Date.now() - this.started,
        stack: (e && e.stack) ? String(e.stack).split('\n').slice(0, 8).join('\n') : null });
      if (this.errors.size > TEL.ERRORS) this.errors.delete(this.errors.keys().next().value);
    }
    this.count('error');
    if (this.level >= 1) console.error('[aethergraph] ' + where, e);
    this.line({ v: 'x', t: Date.now() - this.started, where, msg });
    this.flush(true);            /* an error is exactly what you want on disk before a crash */
  }

  /* Called once per frame. Six array writes; no allocation unless the frame was slow. */
  tick(p, ctx) {
    if (!this.enabled) return;
    this.frame.total.push(p.total);
    this.frame.sim.push(p.sim);
    this.frame.upload.push(p.upload);
    this.frame.draw.push(p.draw);
    this.frame.overlay.push(p.overlay);
    this.frame.pick.push(p.pick);
    this.count('frames');
    if (p.total >= this.slowMs) {
      this.longFrames++;
      this.count('frames.long');
      /* Keep WHY it was slow, not just that it was. A frame-time series with no phase
         attribution tells you there is a problem and nothing about where. */
      let worst = 'total', wv = 0;
      for (const k of ['sim', 'upload', 'draw', 'overlay', 'pick']) if (p[k] > wv) { wv = p[k]; worst = k; }
      this.slow.push({ t: Date.now() - this.started, ms: +p.total.toFixed(2), worst,
        phase: { sim: +p.sim.toFixed(2), upload: +p.upload.toFixed(2), draw: +p.draw.toFixed(2),
          overlay: +p.overlay.toFixed(2), pick: +p.pick.toFixed(2) },
        ctx: ctx || null });
    }
  }

  /* ---- file sink ------------------------------------------------------------------
     Off by default. When on, lines are buffered and appended in batches: a per-event write
     would fire Obsidian's file-change machinery hundreds of times a second, so the telemetry
     would degrade the thing it exists to measure. */
  line(obj) {
    if (!this.plugin.settings.telemetryFile) return;
    this.pending.push(JSON.stringify(obj));
    if (this.pending.length >= TEL.FLUSH_LINES) this.flush();
  }

  async ensureFile() {
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(TEL.DIR))) await ad.mkdir(TEL.DIR);
    if (!this.filePath) {
      const d = new Date();
      const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0')
        + String(d.getDate()).padStart(2, '0') + '-'
        + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')
        + String(d.getSeconds()).padStart(2, '0');
      this.filePath = `${TEL.DIR}/aethergraph-${stamp}-${this.session}.jsonl`;
      this.fileBytes = 0;
      const head = JSON.stringify({ v: 'h', schema: TEL.SCHEMA, session: this.session,
        started: new Date(this.started).toISOString(), env: this.env,
        privacy: 'known lanes salted-hash; missing, unknown and policy-marked notes withheld' }) + '\n';
      await ad.write(this.filePath, head);
      this.fileBytes = head.length;
      await this.prune();
    }
  }

  async prune() {
    try {
      const ad = this.app.vault.adapter;
      const listing = await ad.list(TEL.DIR);
      const mine = (listing.files || []).filter(f => /aethergraph-.*\.jsonl$/.test(f)).sort();
      for (const f of mine.slice(0, Math.max(0, mine.length - TEL.KEEP_FILES))) await ad.remove(f);
    } catch (e) { /* pruning is housekeeping; never let it break logging */ }
  }

  async flush(force) {
    if (!this.plugin.settings.telemetryFile || !this.pending.length) return;
    if (!force && Date.now() - this.lastFlush < TEL.FLUSH_MS && this.pending.length < TEL.FLUSH_LINES) return;
    const batch = this.pending; this.pending = [];
    this.lastFlush = Date.now();
    try {
      await this.ensureFile();
      const text = batch.join('\n') + '\n';
      await this.app.vault.adapter.append(this.filePath, text);
      this.fileBytes += text.length;
      this.fileErr = null;
      if (this.fileBytes > TEL.MAX_BYTES) { this.filePath = null; }   /* rotate */
    } catch (e) {
      this.fileErr = (e && e.message) ? e.message : String(e);
      if (this.level >= 1) console.warn('[aethergraph] telemetry file write failed —', this.fileErr);
    }
  }

  snapshot() {
    const f = {};
    for (const k of Object.keys(this.frame)) f[k] = this.frame[k].stats();
    const total = this.counters.frames || 0;
    return {
      schema: TEL.SCHEMA, session: this.session,
      uptimeMs: Date.now() - this.started,
      env: this.env, health: this.health,
      frame: f,
      fps: f.total.p50 > 0 ? 1000 / f.total.p50 : 0,
      longFrames: this.longFrames,
      longPct: total ? (100 * this.longFrames / total) : 0,
      counters: Object.assign({}, this.counters),
      slow: this.slow.last(12),
      errors: Array.from(this.errors.values()),
      events: this.events.last(24),
      file: { on: !!this.plugin.settings.telemetryFile, path: this.filePath, bytes: this.fileBytes, error: this.fileErr },
    };
  }

  report() {
    const s = this.snapshot();
    const ms = (v) => (v === undefined ? '—' : v.toFixed(2) + ' ms');
    const L = [];
    L.push('# Aethergraph local diagnostics');
    L.push('');
    L.push(`Session \`${s.session}\` · ${(s.uptimeMs / 1000).toFixed(0)} s · generated ${new Date().toISOString()}`);
    L.push('');
    L.push('> Known privacy lanes appear only as salted hashes; missing, unknown and policy-marked');
    L.push('> notes are withheld entirely.');
    L.push('');
    L.push('## Environment');
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(s.env)) L.push(`| ${k} | ${String(v)} |`);
    L.push('');
    if (s.health.length) {
      L.push('## Health');
      L.push('');
      for (const h of s.health) L.push(`- **${h.level}** — ${h.msg}`);
      L.push('');
    }
    L.push('## Frame budget');
    L.push('');
    L.push(`${s.fps.toFixed(0)} fps median · ${s.longFrames.toLocaleString()} long frames of `
      + `${(s.counters.frames || 0).toLocaleString()} (${s.longPct.toFixed(1)}%)`);
    L.push('');
    L.push('| phase | p50 | p95 | p99 | max | mean |');
    L.push('|---|---|---|---|---|---|');
    for (const k of ['total', 'sim', 'upload', 'draw', 'overlay', 'pick']) {
      const c = s.frame[k];
      L.push(`| ${k} | ${ms(c.p50)} | ${ms(c.p95)} | ${ms(c.p99)} | ${ms(c.max)} | ${ms(c.mean)} |`);
    }
    L.push('');
    L.push('## Counters');
    L.push('');
    L.push('| counter | value |');
    L.push('|---|---|');
    for (const k of Object.keys(s.counters).sort()) L.push(`| ${k} | ${s.counters[k].toLocaleString()} |`);
    L.push('');
    if (s.slow.length) {
      L.push('## Slowest frames retained');
      L.push('');
      L.push('| at | total | dominant | sim | upload | draw | overlay | pick | context |');
      L.push('|---|---|---|---|---|---|---|---|---|');
      for (const r of s.slow.slice().sort((a, b) => b.ms - a.ms)) {
        const p = r.phase;
        L.push(`| ${(r.t / 1000).toFixed(1)} s | ${r.ms} ms | **${r.worst}** | ${p.sim} | ${p.upload} `
          + `| ${p.draw} | ${p.overlay} | ${p.pick} | ${r.ctx ? Object.entries(r.ctx).map(([a, b]) => a + '=' + b).join(' ') : '—'} |`);
      }
      L.push('');
    }
    if (s.errors.length) {
      L.push('## Errors');
      L.push('');
      for (const e of s.errors) {
        L.push(`### ${e.where} — ${e.n}×`);
        L.push('');
        L.push('```');
        L.push(e.msg);
        if (e.stack) L.push(e.stack);
        L.push('```');
        L.push('');
      }
    } else {
      L.push('## Errors');
      L.push('');
      L.push('None recorded this session.');
      L.push('');
    }
    L.push('## Recent events');
    L.push('');
    L.push('```');
    for (const e of s.events) L.push(`${(e.t / 1000).toFixed(1).padStart(7)}s  ${e.kind}  ${e.d ? JSON.stringify(e.d) : ''}`);
    L.push('```');
    L.push('');
    L.push('---');
    L.push('*There was no hurt nor harm in the making of this, to anyone, anything, or anybody.*');
    return L.join('\n');
  }

  reset() {
    for (const k of Object.keys(this.frame)) this.frame[k].clear();
    this.events.clear(); this.slow.clear(); this.errors.clear();
    this.counters = Object.create(null);
    this.longFrames = 0;
  }
}


const VIEW_TYPE = 'aethergraph-view';
const PAYLOADS = ['.aethergraph/aethergraph.json'];
const PAYLOAD_LIMITS = { bytes: 128 * 1024 * 1024, nodes: 100000, edges: 1000000, text: 4096 };
const V4_EDGE_FIELDS = ['a', 'b', 'weight', 'facet', 'reach', 'span', 'facet_gap',
  'relevance', 'reason', 'signals', 'presentation'];
const PRESENTATIONS = ['primary', 'context', 'archive'];
const PRIVACY_LANES = ['agent-safe', 'private-local', 'restricted-pointer', 'quarantined'];
const NODE_EVIDENCE = ['verified-runtime', 'verified-source', 'inferred', 'reported', 'proposed',
  'unknown', 'refuted'];
const SYNTHESIS_EVIDENCE = ['observed', 'verified-source', 'inferred', 'reported', 'proposed',
  'unknown', 'refuted', 'residual'];
const SAFE_REF = /^(?:[a-z0-9][a-z0-9._:@-]{0,127}|sha256:[0-9a-f]{64})$/i;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function boundedString(value, label, opts) {
  const o = opts || {};
  if (typeof value !== 'string' || value.length > (o.max || PAYLOAD_LIMITS.text)
      || (o.nonempty && !value.length)) throw new Error(`${label} must be a bounded string`);
  if (o.safe && !SAFE_REF.test(value)) throw new Error(`${label} must be a safe slug or hash`);
  return value;
}

function boundedNumber(value, label, min, max, integer) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
      || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be ${integer ? 'an integer' : 'a finite number'} in ${min}..${max}`);
  }
  return value;
}

function boundedStringArray(value, label, opts) {
  const o = opts || {};
  if (!Array.isArray(value) || value.length > (o.maxItems || 256)) {
    throw new Error(`${label} must be a bounded array`);
  }
  const seen = new Set();
  for (let i = 0; i < value.length; i++) {
    const s = boundedString(value[i], `${label}[${i}]`, { nonempty: true, safe: !!o.safe,
      max: o.maxText || PAYLOAD_LIMITS.text });
    if (o.unique && seen.has(s)) throw new Error(`${label} must contain unique values`);
    seen.add(s);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function boundedJson(value, label, depth) {
  const d = depth || 0;
  if (d > 4) throw new Error(`${label} exceeds bounded JSON depth`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { boundedString(value, label); return; }
  if (typeof value === 'number') { boundedNumber(value, label, -1000000000, 1000000000, false); return; }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} exceeds bounded JSON array limit`);
    for (let i = 0; i < value.length; i++) boundedJson(value[i], `${label}[${i}]`, d + 1);
    return;
  }
  if (!plainObject(value) || Object.keys(value).length > 64) {
    throw new Error(`${label} must be bounded JSON data`);
  }
  for (const key of Object.keys(value)) {
    if (!/^-?[a-z0-9_]+$/i.test(key)) throw new Error(`${label} has an unsafe field`);
    boundedJson(value[key], `${label}.${key}`, d + 1);
  }
}

function validateScoreParts(value, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length > 32) throw new Error(`${label} has too many parts`);
  for (const key of keys) {
    boundedString(key, `${label} key`, { nonempty: true, safe: true, max: 128 });
    boundedNumber(value[key], `${label}.${key}`, 0, 1, false);
  }
}

function validateScoredTerms(value, label) {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} must be a bounded array`);
  const seen = new Set();
  for (let i = 0; i < value.length; i++) {
    const pair = value[i];
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`${label}[${i}] must be [slug, score]`);
    const slug = boundedString(pair[0], `${label}[${i}][0]`, { nonempty: true, safe: true, max: 128 });
    boundedNumber(pair[1], `${label}[${i}][1]`, 0, 1, false);
    if (seen.has(slug)) throw new Error(`${label} contains duplicate slug ${slug}`);
    seen.add(slug);
  }
}

function validateNodeSynthesis(value, label) {
  exactKeys(value, ['subjects', 'contexts', 'importance', 'utility', 'activation', 'confidence',
    'support', 'region_attribution', 'residuals'], label);
  validateScoredTerms(value.subjects, `${label}.subjects`);
  validateScoredTerms(value.contexts, `${label}.contexts`);
  validateScoredTerms(value.region_attribution, `${label}.region_attribution`);
  exactKeys(value.importance, ['score', 'parts'], `${label}.importance`);
  boundedNumber(value.importance.score, `${label}.importance.score`, 0, 1, false);
  exactKeys(value.importance.parts, ['standing', 'load', 'authority', 'support'],
    `${label}.importance.parts`);
  validateScoreParts(value.importance.parts, `${label}.importance.parts`);
  exactKeys(value.utility, ['score', 'frame_ref', 'parts'], `${label}.utility`);
  boundedNumber(value.utility.score, `${label}.utility.score`, 0, 1, false);
  boundedString(value.utility.frame_ref, `${label}.utility.frame_ref`, { nonempty: true, safe: true, max: 128 });
  exactKeys(value.utility.parts, ['direct', 'neighbour', 'goal'], `${label}.utility.parts`);
  validateScoreParts(value.utility.parts, `${label}.utility.parts`);
  exactKeys(value.activation, ['score', 'direct', 'propagated', 'inhibited'], `${label}.activation`);
  for (const key of ['score', 'direct', 'propagated', 'inhibited']) {
    boundedNumber(value.activation[key], `${label}.activation.${key}`, 0, 1, false);
  }
  exactKeys(value.confidence, ['score', 'parts'], `${label}.confidence`);
  boundedNumber(value.confidence.score, `${label}.confidence.score`, 0, 1, false);
  exactKeys(value.confidence.parts, ['evidence', 'independence', 'freshness', 'coverage', 'residual'],
    `${label}.confidence.parts`);
  validateScoreParts(value.confidence.parts, `${label}.confidence.parts`);
  exactKeys(value.support, ['regions', 'independent', 'lineages'], `${label}.support`);
  for (const key of ['regions', 'independent', 'lineages']) {
    boundedNumber(value.support[key], `${label}.support.${key}`, 0, 1000000, true);
  }
  if (value.support.regions !== value.region_attribution.length) {
    throw new Error(`${label}.support.regions must match region_attribution`);
  }
  boundedStringArray(value.residuals, `${label}.residuals`, { safe: true, unique: true,
    maxItems: 64, maxText: 128 });
}

function validateV4Region(value, label) {
  exactKeys(value, ['id', 'status', 'activation', 'inhibition', 'gain', 'confidence',
    'contributions', 'omissions', 'derivation_family', 'observed_at',
    'source_snapshot_sha256'], label);
  boundedString(value.id, `${label}.id`, { nonempty: true, safe: true, max: 128 });
  boundedString(value.derivation_family, `${label}.derivation_family`, {
    nonempty: true, safe: true, max: 128 });
  boundedString(value.observed_at, `${label}.observed_at`, { nonempty: true, max: 64 });
  if (!ISO_DATETIME.test(value.observed_at) || !Number.isFinite(Date.parse(value.observed_at))) {
    throw new Error(`${label}.observed_at must be an ISO date-time`);
  }
  boundedString(value.source_snapshot_sha256, `${label}.source_snapshot_sha256`, {
    nonempty: true, max: 64 });
  if (!/^[0-9a-f]{64}$/i.test(value.source_snapshot_sha256)) {
    throw new Error(`${label}.source_snapshot_sha256 must be a sha256 hash`);
  }
  if (!['active', 'degraded', 'inactive'].includes(value.status)) {
    throw new Error(`${label}.status has an unsupported value`);
  }
  for (const key of ['activation', 'inhibition', 'gain', 'confidence']) {
    boundedNumber(value[key], `${label}.${key}`, 0, 1, false);
  }
  boundedNumber(value.contributions, `${label}.contributions`, 0, 1000000, true);
  boundedStringArray(value.omissions, `${label}.omissions`, { safe: true, unique: true,
    maxItems: 256, maxText: 128 });
}

function validateTopSynthesis(value, nodeIds, nodes) {
  const label = 'synthesis';
  exactKeys(value, ['schema', 'frame_ref', 'mode', 'authority', 'base', 'algorithm', 'regions',
    'budget', 'working_set', 'residuals'], label);
  if (value.schema !== 'aethergraph.synthesis.v1') throw new Error('unsupported synthesis schema');
  boundedString(value.frame_ref, `${label}.frame_ref`, { nonempty: true, safe: true, max: 128 });
  if (!['resting', 'active'].includes(value.mode)) throw new Error(`${label}.mode must be resting or active`);
  if (value.authority !== 'none') throw new Error(`${label}.authority must be none`);
  exactKeys(value.base, ['agent_index_sha256', 'graph_sha256'], `${label}.base`);
  if (value.base.agent_index_sha256 !== null
      && !/^[0-9a-f]{64}$/i.test(value.base.agent_index_sha256)) {
    throw new Error(`${label}.base.agent_index_sha256 must be null or a sha256 hash`);
  }
  boundedString(value.base.graph_sha256, `${label}.base.graph_sha256`, { nonempty: true });
  if (!/^[0-9a-f]{64}$/i.test(value.base.graph_sha256)) {
    throw new Error(`${label}.base.graph_sha256 must be a sha256 hash`);
  }
  if (value.algorithm !== 'holistic-modulator-v1') throw new Error(`${label}.algorithm is unsupported`);
  if (!Array.isArray(value.regions) || value.regions.length > 64) {
    throw new Error(`${label}.regions must be a bounded array`);
  }
  const regionIds = new Set();
  for (let i = 0; i < value.regions.length; i++) {
    validateV4Region(value.regions[i], `${label}.regions[${i}]`);
    const id = value.regions[i].id;
    if (regionIds.has(id)) throw new Error(`${label}.regions must have unique ids`);
    regionIds.add(id);
  }
  exactKeys(value.budget, ['node_limit', 'edge_limit', 'token_estimate_limit', 'selected_nodes',
    'selected_edges'], `${label}.budget`);
  for (const key of ['node_limit', 'selected_nodes']) {
    boundedNumber(value.budget[key], `${label}.budget.${key}`, 0, PAYLOAD_LIMITS.nodes, true);
  }
  for (const key of ['edge_limit', 'selected_edges']) {
    boundedNumber(value.budget[key], `${label}.budget.${key}`, 0, PAYLOAD_LIMITS.edges, true);
  }
  boundedNumber(value.budget.token_estimate_limit, `${label}.budget.token_estimate_limit`,
    0, 1000000000, true);
  if (value.budget.selected_nodes > value.budget.node_limit
      || value.budget.selected_edges > value.budget.edge_limit) {
    throw new Error(`${label}.budget selected values exceed limits`);
  }
  boundedStringArray(value.working_set, `${label}.working_set`, { unique: true,
    maxItems: PAYLOAD_LIMITS.nodes });
  for (const id of value.working_set) {
    if (!nodeIds.has(id)) throw new Error(`${label}.working_set contains an unknown node id`);
  }
  for (let i = 0; i < nodes.length; i++) {
    for (const pair of nodes[i].synthesis.region_attribution) {
      if (!regionIds.has(pair[0])) {
        throw new Error(`node ${i}.synthesis.region_attribution contains an unknown region id`);
      }
    }
  }
  if (value.working_set.length !== value.budget.selected_nodes) {
    throw new Error(`${label}.working_set length must equal selected_nodes`);
  }
  if (!Array.isArray(value.residuals) || value.residuals.length > 4096) {
    throw new Error(`${label}.residuals must be a bounded array`);
  }
  for (let i = 0; i < value.residuals.length; i++) {
    const residual = value.residuals[i], rlabel = `${label}.residuals[${i}]`;
    exactKeys(residual, ['code', 'severity', 'nodes', 'evidence'], rlabel);
    boundedString(residual.code, `${rlabel}.code`, { nonempty: true, safe: true, max: 128 });
    boundedNumber(residual.severity, `${rlabel}.severity`, 0, 1, false);
    if (!SYNTHESIS_EVIDENCE.includes(residual.evidence)) {
      throw new Error(`${rlabel}.evidence has an unsupported value`);
    }
    boundedStringArray(residual.nodes, `${rlabel}.nodes`, { unique: true,
      maxItems: PAYLOAD_LIMITS.nodes });
    for (const id of residual.nodes) {
      if (!nodeIds.has(id)) throw new Error(`${rlabel}.nodes contains an unknown node id`);
    }
  }
}

function validateV4Node(n, i) {
  const label = `node ${i}`;
  exactKeys(n, ['id', 'title', 'display_title', 'description', 'display_title_source',
    'label_source', 'topics', 'display_tags', 'path', 'type', 'project', 'area', 'label_area',
    'role', 'facets', 'tags', 'aliases', 'evidence', 'privacy', 'withhold_from_telemetry',
    'authority', 'source_path', 'source_sha256', 'source_commit', 'source_tree_dirty',
    'hand_authored', 'view_scope', 'standing', 'standing_parts', 'corroboration', 'load',
    'contested', 'authority_rank', 'hybridity', 'family', 'mass', 'age', 'synthesis'], label);
  for (const key of ['id', 'path', 'title', 'display_title', 'description']) {
    boundedString(n[key], `${label}.${key}`, { nonempty: key !== 'description' });
  }
  for (const key of ['display_title_source', 'label_source', 'type', 'project', 'area', 'label_area',
    'role', 'authority', 'source_path', 'source_sha256', 'source_commit', 'family']) {
    if (n[key] !== null && n[key] !== undefined) boundedString(n[key], `${label}.${key}`);
  }
  for (const key of ['topics', 'display_tags', 'facets', 'tags', 'aliases']) {
    boundedStringArray(n[key], `${label}.${key}`, { maxItems: 256 });
  }
  if (!NODE_EVIDENCE.includes(n.evidence)) throw new Error(`${label}.evidence has an unsupported value`);
  if (!PRIVACY_LANES.includes(n.privacy)) throw new Error(`${label}.privacy has an unsupported value`);
  if (!['core', 'corpus', 'all'].includes(n.view_scope)) throw new Error(`${label}.view_scope has an unsupported value`);
  for (const key of ['withhold_from_telemetry', 'hand_authored', 'contested']) {
    if (typeof n[key] !== 'boolean') throw new Error(`${label}.${key} must be boolean`);
  }
  if (n.source_tree_dirty !== null && typeof n.source_tree_dirty !== 'boolean') {
    throw new Error(`${label}.source_tree_dirty must be boolean or null`);
  }
  if (n.source_sha256 !== null && !/^[0-9a-f]{64}$/i.test(n.source_sha256)) {
    throw new Error(`${label}.source_sha256 must be null or a sha256 hash`);
  }
  if (n.source_commit !== null && !/^(?:[0-9a-f]{7,64}|unavailable-not-a-git-repository)$/i.test(n.source_commit)) {
    throw new Error(`${label}.source_commit must be null, a commit hash, or the unavailable sentinel`);
  }
  for (const key of ['standing', 'hybridity', 'age']) boundedNumber(n[key], `${label}.${key}`, 0, 1, false);
  for (const key of ['corroboration', 'load', 'mass']) boundedNumber(n[key], `${label}.${key}`, 0, 1000000000000, false);
  boundedNumber(n.authority_rank, `${label}.authority_rank`, 0, 4, true);
  exactKeys(n.standing_parts, ['provenance', 'corroboration', 'load', 'contested'],
    `${label}.standing_parts`);
  boundedNumber(n.standing_parts.provenance, `${label}.standing_parts.provenance`, 0, 1, false);
  boundedNumber(n.standing_parts.corroboration, `${label}.standing_parts.corroboration`,
    0, 1000000, false);
  boundedNumber(n.standing_parts.load, `${label}.standing_parts.load`, 0, 1000000000000, false);
  if (typeof n.standing_parts.contested !== 'boolean') {
    throw new Error(`${label}.standing_parts.contested must be boolean`);
  }
  validateNodeSynthesis(n.synthesis, `${label}.synthesis`);
}

function validateV4Envelope(d) {
  exactKeys(d, ['schema', 'observed_at', 'counts', 'legend', 'nodes', 'edge_fields',
    'facet_vocab', 'reason_vocab', 'presentation_vocab', 'explicit', 'latent', 'ghosts',
    'severed', 'synthesis'], 'payload');
  boundedString(d.observed_at, 'observed_at', { nonempty: true, max: 64 });
  if (!Number.isFinite(Date.parse(d.observed_at))) throw new Error('observed_at must be an ISO date-time');
  if (!plainObject(d.counts) || Object.keys(d.counts).length > 64) {
    throw new Error('counts must be a bounded object');
  }
  for (const key of ['nodes', 'explicit', 'latent', 'ghosts', 'severed']) {
    if (!Object.prototype.hasOwnProperty.call(d.counts, key)) throw new Error(`counts.${key} is required`);
  }
  for (const [key, value] of Object.entries(d.counts)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) throw new Error('counts has an unsafe field');
    boundedNumber(value, `counts.${key}`, 0, 1000000000, true);
  }
  if (!plainObject(d.legend)) throw new Error('legend must be an object');
  boundedJson(d.legend, 'legend', 0);
  if (!Array.isArray(d.ghosts) || d.ghosts.length > PAYLOAD_LIMITS.nodes) {
    throw new Error('ghosts must be a bounded array');
  }
  for (let i = 0; i < d.ghosts.length; i++) {
    const ghost = d.ghosts[i], label = `ghosts[${i}]`;
    exactKeys(ghost, ['name', 'docs', 'anchors'], label);
    boundedString(ghost.name, `${label}.name`, { nonempty: true });
    boundedNumber(ghost.docs, `${label}.docs`, 0, 1000000000, true);
    if (!Array.isArray(ghost.anchors) || ghost.anchors.length > 256) {
      throw new Error(`${label}.anchors must be a bounded array`);
    }
    for (let j = 0; j < ghost.anchors.length; j++) {
      const anchor = ghost.anchors[j], alabel = `${label}.anchors[${j}]`;
      exactKeys(anchor, ['n', 'w'], alabel);
      boundedNumber(anchor.n, `${alabel}.n`, 0, d.nodes.length - 1, true);
      boundedNumber(anchor.w, `${alabel}.w`, 0, 1000000000, false);
    }
  }
  if (!Array.isArray(d.severed) || d.severed.length > PAYLOAD_LIMITS.edges) {
    throw new Error('severed must be a bounded array');
  }
  for (let i = 0; i < d.severed.length; i++) {
    const item = d.severed[i], label = `severed[${i}]`;
    exactKeys(item, ['pair', 'shared_areas', 'curated'], label);
    boundedStringArray(item.pair, `${label}.pair`, { maxItems: 2 });
    if (item.pair.length !== 2) throw new Error(`${label}.pair must contain two values`);
    boundedNumber(item.shared_areas, `${label}.shared_areas`, 0, 1000000000, true);
    if (!Array.isArray(item.curated) || item.curated.length !== 2) {
      throw new Error(`${label}.curated must contain two values`);
    }
    for (let j = 0; j < 2; j++) {
      if (item.curated[j] !== null) boundedString(item.curated[j], `${label}.curated[${j}]`);
    }
  }
}

function validateV4Vocab(d) {
  for (const key of ['facet_vocab', 'reason_vocab', 'presentation_vocab']) {
    if (!Array.isArray(d[key]) || d[key].length > 65536) throw new Error(`${key} must be a bounded array`);
    const seen = new Set();
    for (let i = 0; i < d[key].length; i++) {
      const item = d[key][i];
      let identity;
      if (typeof item === 'string') identity = boundedString(item, `${key}[${i}]`, { nonempty: true });
      else if (key === 'reason_vocab' && plainObject(item)) {
        exactKeys(item, ['label', 'basis', 'evidence'], `${key}[${i}]`);
        boundedString(item.label, `${key}[${i}].label`, { nonempty: true });
        boundedStringArray(item.basis, `${key}[${i}].basis`, {
          unique: true, maxItems: 32, maxText: 128,
        });
        boundedString(item.evidence, `${key}[${i}].evidence`, { nonempty: true });
        if (!SYNTHESIS_EVIDENCE.includes(item.evidence)) {
          throw new Error(`${key}[${i}].evidence has an unsupported value`);
        }
        identity = JSON.stringify(item);
      } else throw new Error(`${key}[${i}] has an unsupported value`);
      if (seen.has(identity)) throw new Error(`${key} must contain unique values`);
      seen.add(identity);
    }
  }
  if (d.presentation_vocab.length !== PRESENTATIONS.length
      || d.presentation_vocab.some((item, i) => item !== PRESENTATIONS[i])) {
    throw new Error('presentation_vocab must be primary, context, archive');
  }
}

function validateV4Edges(d) {
  if (!Array.isArray(d.edge_fields) || d.edge_fields.length !== V4_EDGE_FIELDS.length
      || d.edge_fields.some((field, i) => field !== V4_EDGE_FIELDS[i])) {
    throw new Error('edge_fields must match the canonical v4 edge contract');
  }
  let count = 0;
  for (const family of ['explicit', 'latent']) {
    const rows = d[family];
    if (!Array.isArray(rows)) throw new Error(`${family} must be an array`);
    count += rows.length;
    if (count > PAYLOAD_LIMITS.edges) throw new Error(`edge limit exceeded (${count})`);
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i], label = `${family}[${i}]`;
      if (!Array.isArray(e) || e.length !== V4_EDGE_FIELDS.length) throw new Error(`${label} is malformed`);
      for (const endpoint of [EDGE.A, EDGE.B]) {
        boundedNumber(e[endpoint], `${label}.${V4_EDGE_FIELDS[endpoint]}`, 0, d.nodes.length - 1, true);
      }
      if (e[EDGE.A] === e[EDGE.B]) throw new Error(`${label} has invalid endpoints`);
      for (const field of [EDGE.WEIGHT, EDGE.REACH, EDGE.SPAN, EDGE.RELEVANCE]) {
        boundedNumber(e[field], `${label}.${V4_EDGE_FIELDS[field]}`, 0, 1, false);
      }
      boundedNumber(e[EDGE.FACET], `${label}.facet`, -1, d.facet_vocab.length - 1, true);
      if (![-1, 0, 1].includes(e[EDGE.FACET_GAP])) throw new Error(`${label}.facet_gap has an unsupported value`);
      boundedNumber(e[EDGE.REASON], `${label}.reason`, 0, d.reason_vocab.length - 1, true);
      boundedNumber(e[EDGE.SIGNALS], `${label}.signals`, 0, 2147483647, true);
      if (!PRESENTATIONS.includes(e[EDGE.PRESENTATION])) {
        throw new Error(`${label}.presentation has an unsupported value`);
      }
    }
  }
}

function validatePayload(d) {
  if (!plainObject(d)) throw new Error('payload must be an object');
  if (d.schema !== 'aethergraph.v2' && d.schema !== 'aethergraph.v3' && d.schema !== 'aethergraph.v4') {
    throw new Error(`unsupported schema ${JSON.stringify(d.schema)}`);
  }
  if (!Array.isArray(d.nodes)) throw new Error('nodes must be an array');
  if (d.nodes.length > PAYLOAD_LIMITS.nodes) throw new Error(`node limit exceeded (${d.nodes.length})`);
  for (let i = 0; i < d.nodes.length; i++) {
    const n = d.nodes[i];
    if (!plainObject(n)) throw new Error(`node ${i} must be an object`);
    for (const k of ['id', 'path', 'title', 'display_title']) {
      if (n[k] !== undefined && (typeof n[k] !== 'string' || n[k].length > PAYLOAD_LIMITS.text)) {
        throw new Error(`node ${i}.${k} must be a bounded string`);
      }
    }
  }
  if (d.schema === 'aethergraph.v4') {
    validateV4Envelope(d);
    const ids = new Set();
    for (let i = 0; i < d.nodes.length; i++) {
      validateV4Node(d.nodes[i], i);
      if (ids.has(d.nodes[i].id)) throw new Error(`node ${i}.id must be unique`);
      ids.add(d.nodes[i].id);
    }
    validateV4Vocab(d);
    validateV4Edges(d);
    validateTopSynthesis(d.synthesis, ids, d.nodes);
    for (const [key, actual] of [['nodes', d.nodes.length], ['explicit', d.explicit.length],
      ['latent', d.latent.length], ['ghosts', d.ghosts.length], ['severed', d.severed.length]]) {
      if (d.counts[key] !== actual) throw new Error(`counts.${key} does not match payload`);
    }
    return d;
  }
  let edgeCount = 0;
  for (const family of ['explicit', 'latent']) {
    const rows = d[family] === undefined ? [] : d[family];
    if (!Array.isArray(rows)) throw new Error(`${family} must be an array`);
    edgeCount += rows.length;
    if (edgeCount > PAYLOAD_LIMITS.edges) throw new Error(`edge limit exceeded (${edgeCount})`);
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      if (!Array.isArray(e) || e.length < 7) throw new Error(`${family}[${i}] is malformed`);
      if (!Number.isInteger(e[0]) || !Number.isInteger(e[1])
          || e[0] < 0 || e[1] < 0 || e[0] >= d.nodes.length || e[1] >= d.nodes.length
          || e[0] === e[1]) throw new Error(`${family}[${i}] has invalid endpoints`);
    }
  }
  for (const k of ['ghosts', 'severed', 'facet_vocab', 'reason_vocab', 'presentation_vocab']) {
    if (d[k] !== undefined && !Array.isArray(d[k])) throw new Error(`${k} must be an array`);
  }
  return d;
}

async function readEnhancedPayload(app) {
  const failures = [];
  for (const path of PAYLOADS) {
    let raw;
    try { raw = await app.vault.adapter.read(path); }
    catch (e) { failures.push(`${path}: ${e && e.message ? e.message : 'not found'}`); continue; }
    try {
      if (raw.length > PAYLOAD_LIMITS.bytes) throw new Error(`larger than ${PAYLOAD_LIMITS.bytes} bytes`);
      return { data: validatePayload(JSON.parse(raw)), raw, path, failures };
    } catch (e) { failures.push(`${path}: ${e.message}`); }
  }
  return { data: null, raw: null, path: null, failures };
}

function listValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',');
  return [];
}

function buildBaselinePayload(app) {
  const files = app.vault.getMarkdownFiles().slice(0, PAYLOAD_LIMITS.nodes);
  const cache = app.metadataCache;
  const byPath = new Map(files.map((file, i) => [file.path, i]));
  const byStem = new Map();
  for (let i = 0; i < files.length; i++) {
    const key = String(files[i].basename || '').toLowerCase();
    if (key && !byStem.has(key)) byStem.set(key, i);
  }
  const mtimes = files.map(f => f.stat && Number.isFinite(f.stat.mtime) ? f.stat.mtime : Date.now());
  const newest = mtimes.length ? Math.max(...mtimes) : Date.now();
  const oldest = mtimes.length ? Math.min(...mtimes) : newest;
  const span = Math.max(1, newest - oldest);
  const nodes = files.map((file, i) => {
    const c = cache.getFileCache(file) || {};
    const fm = c.frontmatter || {};
    const h1 = (c.headings || []).find(h => h && h.level === 1 && typeof h.heading === 'string');
    const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim()
      : h1 && h1.heading.trim() ? h1.heading.trim() : file.basename;
    const tags = [];
    for (const raw of listValue(fm.tags).concat((c.tags || []).map(t => t && t.tag))) {
      const tag = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : '';
      if (tag && tag.length <= 120 && !tags.includes(tag)) tags.push(tag);
    }
    const aliases = listValue(fm.aliases === undefined ? fm.alias : fm.aliases)
      .filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()).slice(0, 20);
    const area = file.parent && file.parent.path && file.parent.path !== '/' ? file.parent.path : '';
    return {
      id: file.path, title, display_title: title, display_title_source: h1 ? 'heading' : 'source-title',
      label_source: tags.length ? 'frontmatter-tags' : 'none', topics: [], display_tags: tags.slice(0, 3),
      path: file.path, type: 'note', project: file.path.split('/')[0] || '', area, label_area: '',
      role: '', facets: [], tags, aliases, evidence: 'verified-source', privacy: 'private-local',
      withhold_from_telemetry: false, authority: 'projection', source_path: null, source_sha256: null,
      source_commit: null, source_tree_dirty: null, hand_authored: true, standing: 0.28,
      standing_parts: {}, corroboration: 1, load: 0, contested: false, authority_rank: 2,
      hybridity: 0, family: 'surface', view_scope: 'core',
      mass: Math.max(256, file.stat && file.stat.size || 256),
      age: (newest - mtimes[i]) / span,
    };
  });
  const edges = [], seen = new Set(), degree = new Uint32Array(nodes.length);
  for (let a = 0; a < files.length; a++) {
    const c = cache.getFileCache(files[a]) || {};
    for (const ref of c.links || []) {
      if (!ref || typeof ref.link !== 'string') continue;
      let b = -1;
      if (cache.getFirstLinkpathDest) {
        const dest = cache.getFirstLinkpathDest(ref.link, files[a].path);
        if (dest && byPath.has(dest.path)) b = byPath.get(dest.path);
      }
      if (b < 0) {
        const stem = ref.link.split('#')[0].split('|')[0].split('/').pop().replace(/\.md$/i, '').toLowerCase();
        if (byStem.has(stem)) b = byStem.get(stem);
      }
      if (b < 0 || b === a) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b), key = `${lo}:${hi}`;
      if (seen.has(key)) continue;
      seen.add(key); degree[lo]++; degree[hi]++;
      edges.push([lo, hi, 1, -1, 0, 0, -1, 1, 0, 1, 0]);
      if (edges.length >= PAYLOAD_LIMITS.edges) break;
    }
    if (edges.length >= PAYLOAD_LIMITS.edges) break;
  }
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].load = degree[i];
    nodes[i].standing = clamp(0.28 + Math.log2(degree[i] + 1) * 0.06, 0.28, 0.58);
  }
  return validatePayload({
    schema: 'aethergraph.v3', observed_at: new Date().toISOString(),
    counts: { nodes: nodes.length, explicit: edges.length, latent: 0, ghosts: 0, severed: 0,
      primary: edges.length, context: 0, archive: 0, facet_gap_known_disjoint: 0,
      facet_gap_unknown: edges.length },
    legend: { evidence: LANES.map(l => l.key), privacy: ['private-local'],
      facet_gap: { '-1': 'unknown: one or both endpoints lack controlled facets',
        '0': 'shared controlled facet', '1': 'known-disjoint controlled facets' } },
    nodes, edge_fields: ['a', 'b', 'weight', 'facet', 'reach', 'span', 'facet_gap',
      'relevance', 'reason', 'signals', 'presentation'],
    facet_vocab: [], reason_vocab: ['authored wikilink'],
    presentation_vocab: ['primary', 'context', 'archive'], explicit: edges, latent: [], ghosts: [], severed: [],
  });
}

/* Provenance CLASS — a colour only. How a note entered the vault, not how far it can be
   trusted. The radial axis is `standing`. */
const LANES = [
  { key: 'verified-runtime', label: 'verified · runtime', color: '#7ef0c0' },
  { key: 'verified-source', label: 'verified · source', color: '#5ad9b4' },
  { key: 'inferred', label: 'inferred', color: '#7fb6f5' },
  { key: 'reported', label: 'reported', color: '#c79bf0' },
  { key: 'proposed', label: 'proposed', color: '#f0c27e' },
  { key: 'unknown', label: 'unknown', color: '#8b93a7' },
  { key: 'refuted', label: 'refuted', color: '#f2748c' },
];
const LANE_INDEX = Object.fromEntries(LANES.map((l, i) => [l.key, i]));

const BANDS = [
  { min: 0.60, label: 'load-bearing' },
  { min: 0.45, label: 'well-attested' },
  { min: 0.32, label: 'attested' },
  { min: 0.20, label: 'thin' },
  { min: -1, label: 'unsupported' },
];
const bandOf = (v) => BANDS.findIndex(b => v >= b.min);

const FACET_HUE = {
  metaphysics: 288, mythology: 268, theology: 305, divination: 322, cosmology: 250,
  mathematics: 196, physics: 178, cognition: 158, memory: 142,
  'language-design': 44, 'game-design': 26, narrative: 12, graphics: 350,
  security: 8, infrastructure: 210, evaluation: 96, 'rights-and-consent': 62,
};
function hueFor(s) {
  if (!s) return 210;
  if (FACET_HUE[s] !== undefined) return FACET_HUE[s];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

const FAMILY_SHAPE = {
  canon: 6, being: 8, instrument: 3, substrate: 4,
  practice: 5, dialogue: 0, surface: 4, noise: 0,
};
const FAMILY_ROT = { surface: Math.PI / 4 };
const FAMILY_ORDER = ['canon', 'being', 'instrument', 'substrate', 'practice', 'surface', 'dialogue', 'noise'];

const PRIVACY_RING = {
  'agent-safe': null,
  'private-local': { dash: [2, 3], color: 'rgba(240,180,90,0.85)', w: 1.3 },
  'restricted-pointer': { dash: [1, 4], color: 'rgba(242,116,140,0.85)', w: 1.5 },
  quarantined: { dash: [6, 3], color: 'rgba(255,90,110,0.95)', w: 2 },
};
const PRIVACY_CODE = { 'agent-safe': 0, 'private-local': 1, 'restricted-pointer': 2, quarantined: 3 };

const LAYOUTS = {
  strata: 'Space · strata — tiered planes',
  helix: 'Space · helix — time as depth',
  torus: 'Space · torus — a true 3D ring',
  force: 'Space · force — free in all three axes',
};
const TIERS = {
  standing: 'Tier · standing', age: 'Tier · time', authority: 'Tier · authority',
  family: 'Tier · role family', privacy: 'Tier · privacy', flat: 'Tier · none',
};
const ANGLE_MODES = {
  facet: 'Angle · facet', time: 'Angle · time',
  family: 'Angle · role family', project: 'Angle · project',
};
const CONNECTION_MODES = {
  focused: 'Focused — primary relations',
  context: 'Context — + supporting',
  all: 'All typed connections',
};
const DENSITY = {
  core: { label: 'Core — curated only', test: (n) => viewScope(n) === 'core' },
  corpus: { label: 'Corpus — + supporting material', test: (n) => viewScope(n) !== 'all' },
  all: { label: 'Everything', test: () => true },
};
function viewScope(n) {
  if (n && (n.view_scope === 'core' || n.view_scope === 'corpus' || n.view_scope === 'all')) {
    return n.view_scope;
  }
  const type = String(n && n.type || '').toLowerCase();
  if (['index', 'generated-index', 'agent-session', 'ai-conversation', 'raw-note'].includes(type)) return 'all';
  if (['transcript', 'transcript-pointer', 'dial', 'mirror', 'source-mirror'].includes(type)) return 'corpus';
  return 'core';
}

const GAP = 190, RAD = 430, FOV = 0.9;

const EDGE = { A: 0, B: 1, WEIGHT: 2, FACET: 3, REACH: 4, SPAN: 5, FACET_GAP: 6,
  RELEVANCE: 7, REASON: 8, SIGNALS: 9, PRESENTATION: 10 };

function vocabLabel(vocab, value, fallback) {
  const entry = typeof value === 'number' ? (vocab || [])[value] : value;
  if (typeof entry === 'string' && entry.trim()) return entry.trim();
  if (entry && typeof entry === 'object') {
    const label = entry.label || entry.name || entry.key;
    if (typeof label === 'string' && label.trim()) return label.trim();
  }
  return fallback;
}

function edgePresentation(edge, kind, vocab) {
  const fallback = kind === 'explicit' ? 'primary' : 'archive';
  const value = vocabLabel(vocab, edge && edge[EDGE.PRESENTATION], fallback).toLowerCase();
  return value === 'primary' || value === 'context' || value === 'archive' ? value : fallback;
}

/* One predicate owns relation visibility. Facet gap is deliberately absent: it describes an
   edge but never promotes, suppresses or re-types it. V2 has no presentation field, so direct
   links fall back to primary and latent affinity remains inspectable in All mode. */
function edgeVisible(edge, kind, settings, presentationVocab) {
  if (kind === 'explicit' ? !settings.showExplicit : !settings.showLatent) return false;
  const tier = edgePresentation(edge, kind, presentationVocab);
  if (settings.connectionMode === 'all') return true;
  if (settings.connectionMode === 'context') return tier === 'primary' || tier === 'context';
  return tier === 'primary';
}

function displayTitle(d) {
  const value = d && (d.display_title || d.title || d.path);
  return typeof value === 'string' && value.trim() ? value.trim() : 'Untitled note';
}

function termNames(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry
      : entry && typeof entry === 'object' ? (entry.label || entry.name || entry.topic) : null;
    if (typeof name === 'string' && name.trim() && !out.includes(name.trim())) out.push(name.trim());
  }
  return out;
}

function nodeTopics(d) { return termNames(d && d.topics); }
function nodeDisplayTags(d) { return termNames(d && d.display_tags); }
function scoredTermNames(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const name = Array.isArray(entry) ? entry[0]
      : entry && typeof entry === 'object' ? (entry.slug || entry.label || entry.name) : null;
    if (typeof name === 'string' && name.trim() && !out.includes(name.trim())) out.push(name.trim());
  }
  return out;
}
function nodeSubjects(d) { return scoredTermNames(d && d.synthesis && d.synthesis.subjects); }
function nodeContexts(d) { return scoredTermNames(d && d.synthesis && d.synthesis.contexts); }

function recallTokens(value) {
  const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase();
  const matches = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  return Array.from(new Set(matches.filter(token => token.length > 1))).sort();
}

function scoredTerms(value) {
  if (!Array.isArray(value)) return [];
  return value.map(entry => Array.isArray(entry) && typeof entry[0] === 'string'
    && typeof entry[1] === 'number' ? [entry[0], clamp(entry[1], 0, 1)] : null).filter(Boolean);
}

function directRecallFit(d, tokens) {
  if (!tokens.length) return 0;
  const fields = [
    [[displayTitle(d), d && d.title], 1],
    [d && d.aliases, 0.82],
    [nodeTopics(d), 0.94],
    [nodeDisplayTags(d), 0.88],
    [d && d.facets, 0.74],
    [d && d.tags, 0.68],
    [scoredTerms(d && d.synthesis && d.synthesis.subjects), 1],
    [scoredTerms(d && d.synthesis && d.synthesis.contexts), 0.90],
  ];
  const best = new Float64Array(tokens.length);
  for (const [rawValues, fieldWeight] of fields) {
    for (const raw of rawValues || []) {
      const pair = Array.isArray(raw) ? raw : [raw, 1];
      if (typeof pair[0] !== 'string') continue;
      const weight = fieldWeight * (typeof pair[1] === 'number' ? clamp(pair[1], 0, 1) : 1);
      const text = pair[0].normalize('NFKC').toLocaleLowerCase();
      const fieldTokens = new Set(recallTokens(text));
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        let fit = 0;
        if (fieldTokens.has(token)) fit = weight;
        else if (token.length >= 3 && Array.from(fieldTokens).some(part => part.startsWith(token)
            || token.startsWith(part))) fit = weight * 0.78;
        else if (token.length >= 3 && text.includes(token)) fit = weight * 0.62;
        if (fit > best[i]) best[i] = fit;
      }
    }
  }
  let total = 0;
  for (const value of best) total += value;
  return clamp(total / tokens.length, 0, 1);
}

/* Pure, local recall modulation. The query exists only for the duration of this call. Returned
   state contains counts and scores, never the query or its tokens, so neither plugin state nor
   diagnostics can accidentally retain what the user asked about. */
function modulateRecall(payload, query, options) {
  const opts = options || {}, nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : [];
  const tokens = recallTokens(query);
  if (!tokens.length || !nodes.length) {
    return { active: false, tokenCount: tokens.length, budget: 0, workingSet: [], scores: [] };
  }
  const eligible = Array.isArray(opts.eligible) && opts.eligible.length === nodes.length
    ? opts.eligible.map(Boolean) : nodes.map(() => true);
  const direct = nodes.map((node, i) => eligible[i] ? directRecallFit(node, tokens) : 0);
  const primary = new Float64Array(nodes.length), context = new Float64Array(nodes.length);
  const archive = new Float64Array(nodes.length);
  const accumulate = (target, contribution) => {
    if (contribution <= 0) return;
    target.value = 1 - (1 - target.value) * (1 - clamp(contribution, 0, 1));
  };
  const propagate = (rows, kind) => {
    for (const edge of rows || []) {
      const a = edge[EDGE.A], b = edge[EDGE.B];
      if (!Number.isInteger(a) || !Number.isInteger(b) || !eligible[a] || !eligible[b]) continue;
      const tier = edgePresentation(edge, kind, payload.presentation_vocab || []);
      const strengthRaw = Number(edge[EDGE.RELEVANCE]);
      const strength = Number.isFinite(strengthRaw) ? clamp(strengthRaw, 0, 1)
        : clamp(Number(edge[EDGE.WEIGHT]) || 0, 0, 1);
      const target = tier === 'primary' ? primary : tier === 'context' ? context : archive;
      const av = { value: target[a] }, bv = { value: target[b] };
      accumulate(av, direct[b] * strength); accumulate(bv, direct[a] * strength);
      target[a] = av.value; target[b] = bv.value;
    }
  };
  propagate(payload.explicit, 'explicit');
  propagate(payload.latent, 'latent');
  const ranked = [];
  const scores = nodes.map((node, i) => {
    const propagated = clamp(0.25 * primary[i] + 0.12 * context[i] + 0.03 * archive[i], 0, 1);
    const rawActivation = clamp(0.60 * direct[i] + propagated, 0, 1);
    const utility = clamp(0.75 * direct[i] + 0.25 * Math.max(primary[i], context[i], archive[i]), 0, 1);
    const score = { direct: direct[i], propagated, primary: primary[i], context: context[i],
      archive: archive[i], utility, rawActivation, activation: 0, inhibited: 0, selected: false };
    if (eligible[i] && rawActivation >= 0.01) ranked.push(i);
    return score;
  });
  ranked.sort((a, b) => scores[b].rawActivation - scores[a].rawActivation
    || scores[b].direct - scores[a].direct
    || Number(nodes[b].synthesis && nodes[b].synthesis.importance
      && nodes[b].synthesis.importance.score || 0)
      - Number(nodes[a].synthesis && nodes[a].synthesis.importance
        && nodes[a].synthesis.importance.score || 0)
    || String(nodes[a].id || '').localeCompare(String(nodes[b].id || '')));
  const declared = payload.synthesis && payload.synthesis.budget
    && Number(payload.synthesis.budget.node_limit);
  const fallback = Math.max(8, Math.min(64, Math.ceil(Math.sqrt(nodes.length) * 4)));
  const requested = Number.isInteger(opts.limit) ? opts.limit
    : Number.isInteger(declared) && declared > 0 ? Math.min(declared, fallback) : fallback;
  const budget = clamp(requested, 1, nodes.length);
  const selected = new Set(ranked.slice(0, budget));
  for (const i of ranked) {
    if (selected.has(i)) {
      scores[i].selected = true;
      scores[i].activation = scores[i].rawActivation;
    } else scores[i].inhibited = 1;
  }
  return { active: true, tokenCount: tokens.length, budget,
    workingSet: ranked.slice(0, budget).map(i => nodes[i].id), scores };
}

/* Regional recruitment is derived only from explicit node→region attribution. Support counts
   alone cannot establish which region contributed to which node, so an absent attribution
   yields no recruitment instead of a plausible-looking invention. Like node modulation, this
   receipt is transient and contains no query text or tokens. */
function modulateRegions(payload, recallFrame) {
  const nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : [];
  const declared = payload && payload.synthesis && Array.isArray(payload.synthesis.regions)
    ? payload.synthesis.regions : [];
  if (!recallFrame || !recallFrame.active || !declared.length) {
    return { active: false, total: declared.length, recruited: 0, regions: [] };
  }
  const byId = new Map();
  for (const region of declared) {
    byId.set(region.id, { id: region.id, status: region.status, excitation: 0,
      gain: region.gain, inhibition: region.inhibition, confidence: region.confidence,
      derivationFamily: region.derivation_family, observedAt: region.observed_at,
      contributions: 0, recruitment: 0 });
  }
  for (let i = 0; i < nodes.length; i++) {
    const score = recallFrame.scores[i];
    if (!score || !score.selected || score.activation <= 0) continue;
    const attribution = nodes[i].synthesis && nodes[i].synthesis.region_attribution;
    for (const pair of attribution || []) {
      const region = byId.get(pair[0]);
      if (!region) continue;
      const contribution = clamp(score.activation * pair[1], 0, 1);
      if (contribution <= 0) continue;
      region.excitation = 1 - (1 - region.excitation) * (1 - contribution);
      region.contributions++;
    }
  }
  const regions = Array.from(byId.values());
  for (const region of regions) {
    region.recruitment = region.status === 'inactive' ? 0
      : clamp(region.excitation * region.gain, 0, 1);
  }
  regions.sort((a, b) => b.recruitment - a.recruitment || a.id.localeCompare(b.id));
  return { active: true, total: regions.length,
    recruited: regions.filter(region => region.recruitment > 0).length, regions };
}

function regionSummary(synthesis) {
  const regions = synthesis && Array.isArray(synthesis.regions) ? synthesis.regions : [];
  const counts = { active: 0, degraded: 0, inactive: 0 };
  const degraded = [];
  for (const region of regions) {
    if (!region || !Object.prototype.hasOwnProperty.call(counts, region.status)) continue;
    counts[region.status]++;
    if (region.status !== 'active') degraded.push(`${region.id}:${region.status}`);
  }
  return { total: regions.length, counts, degraded,
    label: regions.length ? `${counts.active} active · ${counts.degraded} degraded · ${counts.inactive} inactive`
      : 'no regional receipts' };
}
function clipLabel(value, max) {
  const s = String(value || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(1, max - 1)).replace(/\s+\S*$/, '').trimEnd();
  return (cut || s.slice(0, max - 1)) + '…';
}

const DEFAULTS = {
  layout: 'strata', tierBy: 'standing', angleBy: 'facet', density: 'core', connectionMode: 'focused',
  showExplicit: true, showLatent: true, showGhosts: false,
  showSevered: false, showPrivate: false, showFlow: false, labels: true, orbit: false,
  perf: false, telemetry: false,
  telemetryFile: false, telemetryConsole: 'warn', slowFrameMs: 24, telemetrySalt: '',
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* Saved settings outlive the options they name. `layout: "facet"` survived in data.json from
   before the spaces were renamed; nothing checked it, so place() fell through to strata while
   the dropdown showed strata *selected by accident* — the stored value and the displayed one
   had quietly diverged. Anything enum-valued is validated against its current table on load
   and reset if it no longer exists. */
const ENUMS = { layout: LAYOUTS, tierBy: TIERS, angleBy: ANGLE_MODES, density: DENSITY,
  connectionMode: CONNECTION_MODES, telemetryConsole: CONSOLE_LEVELS };
function sanitize(s) {
  const out = Object.assign({}, DEFAULTS, s || {});
  const dropped = [];
  /* Removed semantics must not survive the next save merely because an older data.json
     still carries their keys. The source file remains untouched until Obsidian saves. */
  if (Object.prototype.hasOwnProperty.call(out, 'showCross')) {
    delete out.showCross;
    dropped.push('showCross');
  }
  for (const [key, table] of Object.entries(ENUMS)) {
    if (!Object.prototype.hasOwnProperty.call(table, out[key])) {
      dropped.push(`${key}="${out[key]}"`);
      out[key] = DEFAULTS[key];
    }
  }
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[k] === 'boolean' && typeof out[k] !== 'boolean') out[k] = DEFAULTS[k];
  }
  /* a nonsense threshold would either silence the slow-frame log or record every frame */
  if (!(typeof out.slowFrameMs === 'number') || !isFinite(out.slowFrameMs)
      || out.slowFrameMs < 4 || out.slowFrameMs > 2000) {
    if (out.slowFrameMs !== DEFAULTS.slowFrameMs) dropped.push(`slowFrameMs=${out.slowFrameMs}`);
    out.slowFrameMs = DEFAULTS.slowFrameMs;
  }
  if (typeof out.telemetrySalt !== 'string') out.telemetrySalt = '';
  if (dropped.length) {
    console.info('Aethergraph: reset stale settings from an older version —', dropped.join(', '));
  }
  return out;
}

/* ------------------------------------------------------------------ geometry (2D fallback) */
function poly(ctx, x, y, r, sides, rot) {
  ctx.beginPath();
  if (!sides) { ctx.arc(x, y, r, 0, 6.2832); return; }
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2 - Math.PI / 2;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}
function wedge(ctx, x, y, r, a0, a1, sides, rot) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  if (!sides) { ctx.arc(x, y, r, a0, a1); ctx.closePath(); return; }
  const k = Math.PI / sides;
  const steps = Math.max(2, Math.ceil((a1 - a0) / (2 * k)) + 1);
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    const local = ((a - rot + Math.PI / 2) % (2 * k) + 2 * k) % (2 * k) - k;
    const rr = r * Math.cos(k) / Math.cos(local);
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

/* 3D relaxation over a spatial hash. Z is released only in `force`; elsewhere the tier holds
   height while x/y keep breathing, so strata stay readable and the picture is never static.
   This is the one genuinely O(n) piece of per-frame CPU work left, and it is throttled
   adaptively rather than allowed to eat the frame budget. */
class Sim3 {
  /* Measured in the running plugin: at full density this cost 15.4 ms of a 16.0 ms frame —
     96% — while the GPU drew the whole graph in 0.03 ms. The renderer was never the problem
     once it moved to WebGL2; this was.
   *
   * The old version keyed a Map by the string `${cx},${cy},${cz}`. At full density that is one
   * string built per node to insert and 27 more per node to query — about 159,000 string
   * constructions and hashes every tick, purely to name a bucket. Replacing them with a flat
   * typed-array bucket grid and an intrusive linked list through node indices measured 1.75x
   * faster (24.05 -> 13.76 ms) with no change to the physics.
   *
   * State lives in parallel Float64Arrays rather than objects: contiguous, no property
   * lookups, no allocation per tick. Positions are written back onto the node objects at the
   * end of each tick because everything else — rendering, ghosts, labels, picking — reads
   * n.x/n.y/n.z, and changing all of those in the same breath would be a second, unmeasured
   * change riding on this one. */
  constructor(nodes, edges, freeZ) {
    this.n = nodes; this.e = edges; this.freeZ = freeZ; this.alpha = 1; this.cell = 70;
    const N = nodes.length;
    /* power-of-two bucket count sized to the population, so the mask is a cheap AND */
    let b = 1024; while (b < N * 2 && b < (1 << 16)) b <<= 1;
    this.B = b; this.mask = b - 1;
    this.head = new Int32Array(b);
    this.next = new Int32Array(N);
    /* Hashing cell coordinates into a masked bucket means two DIFFERENT cells can share a
       bucket. Candidates from the wrong cell are harmless — the distance test rejects them —
       but if two of a node's 27 neighbour cells collide, that bucket is walked twice and every
       pair in it gets its repulsion applied TWICE. Caught by diffing against the old sim:
       7% mean and 70% worst-case divergence, far too much for float noise. A per-node visit
       stamp makes each bucket count exactly once. */
    this.stamp = new Int32Array(b);
    this.epoch = 0;
    this.px = new Float64Array(N); this.py = new Float64Array(N); this.pz = new Float64Array(N);
    this.vx = new Float64Array(N); this.vy = new Float64Array(N); this.vz = new Float64Array(N);
    this.hx = new Float64Array(N); this.hy = new Float64Array(N); this.hz = new Float64Array(N);
    this.ea = new Int32Array(edges.length); this.eb = new Int32Array(edges.length);
    this.ew = new Float64Array(edges.length);
    for (let k = 0; k < edges.length; k++) {
      this.ea[k] = edges[k][0]; this.eb[k] = edges[k][1]; this.ew[k] = edges[k][2] || 1;
    }
    this.resync();
  }

  /* place() moves the anchors and the nodes; pull the new values in rather than drifting. */
  resync() {
    const n = this.n;
    for (let i = 0; i < n.length; i++) {
      const p = n[i];
      this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z;
      this.vx[i] = p.vx || 0; this.vy[i] = p.vy || 0; this.vz[i] = p.vz || 0;
      this.hx[i] = p.hx; this.hy[i] = p.hy; this.hz[i] = p.hz;
    }
  }

  tick() {
    const N = this.px.length, cell = this.cell, mask = this.mask;
    const head = this.head, next = this.next;
    const px = this.px, py = this.py, pz = this.pz;
    const vx = this.vx, vy = this.vy, vz = this.vz;
    const a = this.alpha, freeZ = this.freeZ;

    /* bucket every node — one integer hash each, no strings, no per-bucket array */
    head.fill(-1);
    for (let i = 0; i < N; i++) {
      const h = ((((px[i] / cell) | 0) * 73856093) ^ (((py[i] / cell) | 0) * 19349663)
        ^ (((pz[i] / cell) | 0) * 83492791)) & mask;
      next[i] = head[h]; head[h] = i;
    }

    const stamp = this.stamp;
    if (this.epoch > 2147000000) { stamp.fill(0); this.epoch = 0; }   /* wrap safely */
    for (let i = 0; i < N; i++) {
      const cx = (px[i] / cell) | 0, cy = (py[i] / cell) | 0, cz = (pz[i] / cell) | 0;
      const xi = px[i], yi = py[i], zi = pz[i];
      const ep = ++this.epoch;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const h = (((cx + dx) * 73856093) ^ ((cy + dy) * 19349663) ^ ((cz + dz) * 83492791)) & mask;
            if (stamp[h] === ep) continue;      /* this bucket already counted for node i */
            stamp[h] = ep;
            for (let j = head[h]; j !== -1; j = next[j]) {
              if (j <= i) continue;
              const ax = xi - px[j], ay = yi - py[j], az = zi - pz[j];
              const d2 = ax * ax + ay * ay + az * az;
              if (d2 > 8100 || d2 === 0) continue;
              const d = Math.sqrt(d2), f = (1100 / d2) * a;
              const fx = (ax / d) * f, fy = (ay / d) * f;
              vx[i] += fx; vy[i] += fy; vx[j] -= fx; vy[j] -= fy;
              if (freeZ) { const fz = (az / d) * f; vz[i] += fz; vz[j] -= fz; }
            }
          }
        }
      }
    }

    const ea = this.ea, eb = this.eb, ew = this.ew;
    for (let k = 0; k < ea.length; k++) {
      const p = ea[k], q = eb[k];
      const dx = px[q] - px[p], dy = py[q] - py[p], dz = pz[q] - pz[p];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const f = (d - 110) * 0.005 * ew[k] * a;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      vx[p] += fx; vy[p] += fy; vx[q] -= fx; vy[q] -= fy;
      if (freeZ) { const fz = (dz / d) * f; vz[p] += fz; vz[q] -= fz; }
    }

    const hx = this.hx, hy = this.hy, hz = this.hz, n = this.n;
    for (let i = 0; i < N; i++) {
      vx[i] += (hx[i] - px[i]) * 0.010; vy[i] += (hy[i] - py[i]) * 0.010;
      if (freeZ) vz[i] += (hz[i] - pz[i]) * 0.004; else pz[i] += (hz[i] - pz[i]) * 0.12;
      vx[i] *= 0.87; vy[i] *= 0.87; vz[i] *= 0.87;
      px[i] += clamp(vx[i], -12, 12); py[i] += clamp(vy[i], -12, 12);
      if (freeZ) pz[i] += clamp(vz[i], -12, 12);
      const p = n[i];
      p.x = px[i]; p.y = py[i]; p.z = pz[i];
    }
    this.alpha = Math.max(0.22, this.alpha * 0.992);
  }
}

/* ------------------------------------------------------------------ the view */
class AetherView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.s = sanitize(plugin.settings);
    this.cam = { yaw: 0.6, pitch: 0.42, dist: 1250, ox: 0, oy: 0 };
    this.hover = null; this.focus = null; this.query = ''; this.t = 0; this.raf = null;
    this.W = 900; this.H = 600;
    this.frameMs = 16; this.simMs = 0; this.simSkip = 0; this.simPhase = 0; this._dwell = 0;
    this.pickAt = null; this.lastPick = -2;
    this.cardShowAll = false;
    this.reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Aethergraph'; }
  getIcon() { return 'git-fork'; }

  async onOpen() {
    try { await this.build(); } catch (e) { this.fail('startup', e); }
  }

  async build() {
    this.dead = false;
    this.tel = this.plugin.tel;
    this.tel.mark('view.open');
    const root = this.contentEl;
    root.empty(); root.addClass('aethergraph-root');
    this.buildChrome(root);
    /* Two stacked surfaces. GL underneath for the graph, 2D on top for anything with glyphs
       or dash patterns. The overlay never takes pointer events. */
    this.stack = root.createDiv({ cls: 'aethergraph-stack' });
    this.stack.setAttr('tabindex', '0');
    this.stack.setAttr('role', 'region');
    this.stack.setAttr('aria-label', 'Aethergraph interactive relationship map. Use the filter and connection controls, then select a node for an accessible connection list.');
    this.glCanvas = this.stack.createEl('canvas', { cls: 'aethergraph-canvas ag-gl' });
    this.canvas = this.stack.createEl('canvas', { cls: 'aethergraph-canvas ag-2d' });
    this.glCanvas.setAttr('aria-hidden', 'true');
    this.canvas.setAttr('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d');
    this.bindContextRecovery();
    this.initRenderer();
    this.bindEvents();
    await this.load();
    this.resize();
    this.registerEvent(this.app.workspace.on('resize', () => this.resize()));
    this.buildPanel(root);
    this.loop();
  }

  /* A lost GPU context used to be terminal: fall back to canvas 2D and stay there. Chromium
     drops contexts on driver resets, sleep/wake and tab eviction, none of which are faults,
     so recovering is the difference between a hiccup and "the graph broke". Listeners are
     bound ONCE here — putting them in initRenderer() would stack a new pair on every retry. */
  bindContextRecovery() {
    this.glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.gl = null;
      this.tel.count('gl.contextLost');
      this.tel.mark('gl.context-lost');
      new Notice('Aethergraph: GPU context lost — attempting to restore.', 4000);
    });
    this.glCanvas.addEventListener('webglcontextrestored', () => {
      this.tel.mark('gl.context-restored');
      this.tel.count('gl.contextRestored');
      try {
        this.initRenderer();
        if (this.gl) { this.buildBuffers(); this.resize(); }
        new Notice('Aethergraph: GPU context restored.', 3000);
      } catch (err) { this.tel.err('context restore', err); }
    });
  }
  async onClose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this._panelTimer) clearInterval(this._panelTimer);
    if (this.tel) {
      this.tel.mark('view.close', { frames: this.tel.counters.frames || 0,
        longPct: +(this.tel.snapshot().longPct).toFixed(1) });
      await this.tel.flush(true);        /* never lose the tail of a session on close */
    }
    if (this.gl) { try { this.gl.dispose(); } catch (e) { /* context already gone */ } }
  }

  /* WebGL2 where possible; the canvas-2D renderer is kept whole as the fallback, so a driver
     problem degrades the picture rather than removing it. */
  initRenderer() {
    this.gl = null;
    const t0 = performance.now();
    try {
      this.gl = new GL.GLRenderer(this.glCanvas);
      this.glCanvas.style.display = '';
      /* Capture what we are actually running on. Nearly every rendering defect is conditional
         on the driver, and "it is slow for me" is unanswerable without this. */
      const g = this.gl.gl;
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      this.tel.env = Object.assign(this.tel.env, {
        renderer: 'WebGL2',
        gpu: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
        glVersion: g.getParameter(g.VERSION),
        glsl: g.getParameter(g.SHADING_LANGUAGE_VERSION),
        maxTexture: g.getParameter(g.MAX_TEXTURE_SIZE),
        maxVaryings: g.getParameter(g.MAX_VARYING_VECTORS),
        antialias: !!g.getContextAttributes().antialias,
        /* Chromium zeroes timer queries for privacy; recording that it is unavailable stops a
           future session concluding the GPU costs nothing. */
        gpuTimerQuery: !!g.getExtension('EXT_disjoint_timer_query_webgl2'),
        devicePixelRatio: window.devicePixelRatio || 1,
        initMs: +(performance.now() - t0).toFixed(1),
      });
      this.tel.mark('renderer.init', { gpu: this.tel.env.gpu, ms: this.tel.env.initMs });
    } catch (e) {
      this.gl = null;
      this.glCanvas.style.display = 'none';
      /* Say so, out loud. The previous version degraded silently, and when the renderer failed
         to load at all the view showed a blank canvas under a perfectly healthy toolbar and
         status line — which reads as "the data is wrong" rather than "the renderer is gone".
         A fallback that cannot be observed is indistinguishable from a fault. */
      console.warn('Aethergraph: WebGL2 unavailable, using canvas 2D —', e && e.message, e);
      new Notice('Aethergraph: WebGL2 unavailable — using the slower canvas renderer.\n'
        + (e && e.message ? e.message : ''), 8000);
      this.tel.env.renderer = 'canvas2d';
      this.tel.err('renderer init', e);
      this.tel.health.push({ level: 'degraded', msg: 'WebGL2 unavailable — canvas 2D fallback, ~25x slower' });
    }
  }

  /* ---------------------------------------------------------------- telemetry panel */
  buildPanel(root) {
    this.panel = root.createDiv({ cls: 'ag-panel' });
    this.syncPanel();
  }

  syncPanel() {
    if (!this.panel) return;
    const on = !!this.s.telemetry;
    this.panel.style.display = on ? '' : 'none';
    if (this._panelTimer) { clearInterval(this._panelTimer); this._panelTimer = null; }
    /* 4 Hz. Percentiles sort a 900-element copy; doing that per frame would make the telemetry
       a measurable share of the thing it measures. */
    if (on) { this.renderPanel(); this._panelTimer = window.setInterval(() => this.renderPanel(), 250); }
  }

  renderPanel() {
    if (!this.panel || !this.s.telemetry || !this.tel) return;
    const s = this.tel.snapshot();
    const p = this.panel;
    p.empty();

    const head = p.createDiv({ cls: 'ag-p-head' });
    head.createSpan({ cls: 'ag-p-title', text: 'local diagnostics' });
    head.createSpan({ cls: 'ag-p-dim', text: `${s.session} · ${(s.uptimeMs / 1000).toFixed(0)}s` });
    const close = head.createEl('button', { cls: 'ag-p-x', text: '×' });
    close.onclick = async () => {
      this.s.telemetry = false;
      await this.plugin.save(this.s);
      if (!this.tel.enabled) this.tel.reset();
      this.syncPanel(); this.rebuildToggles();
    };

    /* headline: the number you actually watch */
    const hero = p.createDiv({ cls: 'ag-p-hero' });
    const fps = s.fps;
    hero.createSpan({ cls: 'ag-p-fps' + (fps >= 55 ? ' good' : fps >= 30 ? ' ok' : ' bad'),
      text: fps.toFixed(0) });
    hero.createSpan({ cls: 'ag-p-dim', text: 'fps · p50 ' + s.frame.total.p50.toFixed(1)
      + ' / p95 ' + s.frame.total.p95.toFixed(1) + ' / p99 ' + s.frame.total.p99.toFixed(1) + ' ms' });

    /* phase attribution — a stacked bar of where the frame actually went */
    const budget = p.createDiv({ cls: 'ag-p-sec' });
    budget.createDiv({ cls: 'ag-p-h', text: 'frame budget (p50)' });
    const bar = budget.createDiv({ cls: 'ag-p-bar' });
    const phases = [['sim', '#f0c27e'], ['upload', '#7fb6f5'], ['draw', '#7ef0c0'],
      ['overlay', '#c79bf0'], ['pick', '#f2748c']];
    const budgetMs = Math.max(16.67, s.frame.total.p50);
    for (const [k, col] of phases) {
      const v = s.frame[k].p50;
      if (v <= 0.001) continue;
      const seg = bar.createDiv({ cls: 'ag-p-seg' });
      seg.style.width = (100 * v / budgetMs) + '%';
      seg.style.background = col;
      seg.setAttr('title', `${k}  ${v.toFixed(2)} ms`);
    }
    const legend = budget.createDiv({ cls: 'ag-p-legend' });
    for (const [k, col] of phases) {
      const row = legend.createSpan({ cls: 'ag-p-key' });
      const dot = row.createSpan({ cls: 'ag-p-dot' }); dot.style.background = col;
      row.createSpan({ text: `${k} ${s.frame[k].p50.toFixed(2)}` });
    }
    budget.createDiv({ cls: 'ag-p-dim',
      text: `${s.longFrames.toLocaleString()} long frames (>${this.tel.slowMs} ms) of `
        + `${(s.counters.frames || 0).toLocaleString()} — ${s.longPct.toFixed(1)}%` });

    /* health first: a warning here explains most "it looks wrong" reports */
    if (s.health.length) {
      const h = p.createDiv({ cls: 'ag-p-sec' });
      h.createDiv({ cls: 'ag-p-h', text: 'health' });
      for (const item of s.health) {
        if (item.level === 'ok') continue;
        h.createDiv({ cls: 'ag-p-warn ag-p-' + item.level, text: item.msg });
      }
      if (!s.health.some(i => i.level !== 'ok')) h.createDiv({ cls: 'ag-p-dim', text: 'all checks pass' });
    }

    const env = p.createDiv({ cls: 'ag-p-sec' });
    env.createDiv({ cls: 'ag-p-h', text: 'environment' });
    const et = env.createDiv({ cls: 'ag-p-kv' });
    for (const k of ['renderer', 'gpu', 'devicePixelRatio', 'gpuTimerQuery', 'payloadAgeDays', 'nodes', 'lanes']) {
      if (s.env[k] === undefined) continue;
      et.createSpan({ cls: 'ag-p-k', text: k });
      et.createSpan({ cls: 'ag-p-v', text: String(s.env[k]) });
    }

    if (s.slow.length) {
      const sl = p.createDiv({ cls: 'ag-p-sec' });
      sl.createDiv({ cls: 'ag-p-h', text: 'slowest frames' });
      for (const r of s.slow.slice().sort((a, b) => b.ms - a.ms).slice(0, 6)) {
        sl.createDiv({ cls: 'ag-p-row',
          text: `${r.ms.toFixed(1)} ms · ${r.worst} · ${r.ctx ? r.ctx.nodes + 'n/' + r.ctx.edges + 'e' : ''}` });
      }
    }

    if (s.errors.length) {
      const er = p.createDiv({ cls: 'ag-p-sec' });
      er.createDiv({ cls: 'ag-p-h ag-p-err', text: `errors (${s.errors.length})` });
      for (const e of s.errors) {
        er.createDiv({ cls: 'ag-p-warn ag-p-fatal', text: `${e.n}× ${e.where}: ${e.msg}` });
      }
    }

    const ct = p.createDiv({ cls: 'ag-p-sec' });
    ct.createDiv({ cls: 'ag-p-h', text: 'counters' });
    const cg = ct.createDiv({ cls: 'ag-p-kv' });
    for (const k of Object.keys(s.counters).sort()) {
      cg.createSpan({ cls: 'ag-p-k', text: k });
      cg.createSpan({ cls: 'ag-p-v', text: s.counters[k].toLocaleString() });
    }

    const ev = p.createDiv({ cls: 'ag-p-sec' });
    ev.createDiv({ cls: 'ag-p-h', text: 'recent events' });
    for (const e of s.events.slice(-8).reverse()) {
      ev.createDiv({ cls: 'ag-p-row',
        text: `${(e.t / 1000).toFixed(1)}s  ${e.kind}${e.d ? '  ' + JSON.stringify(e.d).slice(0, 90) : ''}` });
    }

    const foot = p.createDiv({ cls: 'ag-p-foot' });
    foot.createSpan({ cls: 'ag-p-dim', text: s.file.on
      ? `logging → ${s.file.path || '(opening)'}${s.file.error ? ' — ' + s.file.error : ''}`
      : 'file logging off · lanes honoured · policy-marked notes withheld' });
    const rep = foot.createEl('button', { cls: 'ag-p-btn', text: 'report' });
    rep.onclick = () => this.plugin.writeReport();
    const rst = foot.createEl('button', { cls: 'ag-p-btn', text: 'reset' });
    rst.onclick = () => { this.tel.reset(); this.tel.mark('telemetry.reset'); };
  }

  /* the toolbar pills are built once; the panel's own close button has to re-sync them */
  rebuildToggles() {
    const btns = this.contentEl.querySelectorAll('.ag-tog');
    const keys = ['showExplicit', 'showLatent', 'showGhosts', 'showSevered',
      'showFlow', 'showPrivate', 'labels', 'orbit', 'perf', 'telemetry'];
    btns.forEach((b, i) => {
      if (!keys[i]) return;
      b.toggleClass('is-on', !!this.s[keys[i]]);
      b.setAttr('aria-pressed', this.s[keys[i]] ? 'true' : 'false');
    });
  }

  /* Anything thrown inside requestAnimationFrame is invisible unless someone has the console
     open. One report, then the loop stops rather than throwing sixty times a second. */
  fail(where, e) {
    if (this.dead) return;
    this.dead = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.tel) this.tel.err(where, e);
    console.error('Aethergraph: stopped in ' + where, e);
    new Notice('Aethergraph stopped: ' + where + ' — ' + (e && e.message ? e.message : e)
      + '\nSee the developer console (Ctrl+Shift+I) for the stack.', 0);
    if (this.info) this.info.setText('Aethergraph stopped in ' + where + ' — ' + (e && e.message ? e.message : e));
  }

  buildChrome(root) {
    const bar = this.bar = root.createDiv({ cls: 'aethergraph-bar' });
    const mk = (label, opts, cur, on) => {
      const w = bar.createDiv({ cls: 'ag-ctl' });
      w.createSpan({ cls: 'ag-lbl', text: label });
      const sel = w.createEl('select');
      sel.setAttr('aria-label', label);
      for (const [v, t] of opts) {
        const o = sel.createEl('option', { text: t }); o.value = v;
        if (v === cur) o.selected = true;
      }
      sel.onchange = () => {
        on(sel.value);
        this.tel.mark('control.' + label.toLowerCase(), { value: sel.value });
        this.plugin.save(this.s); this.relayout();
      };
    };
    mk('Space', Object.entries(LAYOUTS), this.s.layout, v => (this.s.layout = v));
    mk('Tier', Object.entries(TIERS), this.s.tierBy, v => (this.s.tierBy = v));
    mk('Angle', Object.entries(ANGLE_MODES), this.s.angleBy, v => (this.s.angleBy = v));
    mk('Density', Object.entries(DENSITY).map(([k, v]) => [k, v.label]), this.s.density, v => (this.s.density = v));
    mk('Connections', Object.entries(CONNECTION_MODES), this.s.connectionMode, v => (this.s.connectionMode = v));

    const tw = bar.createDiv({ cls: 'ag-ctl ag-toggles' });
    const toggles = [['showExplicit', 'direct'], ['showLatent', 'latent'],
      ['showGhosts', 'ghosts'], ['showSevered', 'severed'], ['showFlow', 'flow'],
      ['showPrivate', 'private'], ['labels', 'labels'], ['orbit', 'orbit'], ['perf', 'perf'],
      ['telemetry', 'diagnostics']];
    for (const [key, name] of toggles) {
      const b = tw.createEl('button', { text: name, cls: 'ag-tog' });
      b.setAttr('type', 'button');
      b.setAttr('aria-label', `Toggle ${name}`);
      const sync = () => {
        b.toggleClass('is-on', !!this.s[key]);
        b.setAttr('aria-pressed', this.s[key] ? 'true' : 'false');
      };
      sync();
      b.onclick = async () => {
        this.s[key] = !this.s[key]; sync();
        if (key === 'telemetry' && this.s[key]) await this.plugin.ensureDiagnosticSalt();
        await this.plugin.save(this.s);
        this.tel.mark('toggle', { key, on: !!this.s[key] });
        if (key === 'showPrivate' || key === 'showExplicit' || key === 'showLatent') this.relayout();
        else if (key === 'telemetry') {
          if (!this.tel.enabled) this.tel.reset();
          this.syncPanel();
        }
        else this.updateInfo();
      };
    }
    const inp = this.filterInput = bar.createDiv({ cls: 'ag-ctl' }).createEl('input', { cls: 'ag-search', type: 'text' });
    inp.placeholder = 'recall…';
    inp.setAttr('aria-label', 'Task-conditioned recall');
    inp.oninput = () => {
      this.query = inp.value.toLowerCase();
      this.relayout();
      /* length and hit count only — the query itself is something you typed and may name
         private material, so it is not the sort of thing a log should hold */
      this.tel.mark('filter', { len: this.query.length, hits: this.nodes ? this.nodes.length : 0 });
    };

    this.info = root.createDiv({ cls: 'aethergraph-info' });
    this.info.setAttr('role', 'status');
    this.info.setAttr('aria-live', 'polite');
    this.tip = root.createDiv({ cls: 'aethergraph-tip' });
    this.tip.setAttr('role', 'tooltip');
    this.tip.style.display = 'none';
  }

  async load() {
    const t0 = performance.now();
    const enhanced = await readEnhancedPayload(this.app);
    this.localBaseline = !enhanced.data;
    this.data = enhanced.data || buildBaselinePayload(this.app);
    this.payloadSource = enhanced.path || 'metadata-cache baseline';
    const bytes = enhanced.raw ? enhanced.raw.length : 0;
    this.tel.mark(enhanced.data ? 'payload.load' : 'payload.baseline', {
      bytes, nodes: this.data.nodes.length, ms: +(performance.now() - t0).toFixed(1),
    });
    this.checkHealth(bytes);
    this.tel.env.payloadSource = this.payloadSource;
    if (this.localBaseline) {
      this.tel.health.push({ level: 'warn', msg: 'using the local authored-link baseline; no enhanced payload loaded' });
      const why = enhanced.failures.length ? ` (${enhanced.failures[0]})` : '';
      new Notice(`Aethergraph: using authored note links${why}`, 6000);
    }
    this.relayout();
  }

  /* The picture is only as good as the data behind it, and a stale or half-built payload looks
     exactly like a working one. Ask the questions up front and record the answers, so "it looks
     wrong" has somewhere to start. */
  checkHealth(bytes) {
    const d = this.data;
    /* Health is a statement about the CURRENT payload, not a log. It used to append to a
       plugin-lifetime array, so every reopen duplicated the whole list — the first telemetry
       dump came back with four findings listed twice. */
    const h = this.tel.health = [];
    const add = (level, msg) => { h.push({ level, msg }); if (level !== 'ok') this.tel.mark('health.' + level, { msg }); };

    if (d.schema !== 'aethergraph.v2' && d.schema !== 'aethergraph.v3' && d.schema !== 'aethergraph.v4') {
      add('warn', `payload schema is "${d.schema}", this build expects v2, v3 or v4 — `
        + 'channels may be missing or misread');
    } else add('ok', `payload schema ${d.schema}`);

    if (d.observed_at) {
      const ageDays = (Date.now() - Date.parse(d.observed_at)) / 86400000;
      this.tel.env.payloadObserved = d.observed_at;
      this.tel.env.payloadAgeDays = +ageDays.toFixed(1);
      if (ageDays > 14) add('warn', `payload is ${ageDays.toFixed(0)} days old — rebuild or replace the enhanced payload`);
      else add('ok', `payload ${ageDays.toFixed(1)} days old`);
    } else add('warn', 'payload has no observed_at — cannot tell how stale it is');

    if (!d.facet_vocab || !d.facet_vocab.length) {
      add('warn', 'no facet_vocab — edge hue will fall back to a single colour');
    }
    if (!d.edge_fields || d.edge_fields.length < 7) {
      add('warn', 'edges carry fewer than 7 fields — reach, span or facet-gap state will be unavailable');
    }
    if (d.schema === 'aethergraph.v3' || d.schema === 'aethergraph.v4') {
      if (!Array.isArray(d.presentation_vocab) || !d.presentation_vocab.length) {
        add('warn', 'v3 payload has no presentation_vocab — latent connections fall back to archive');
      }
      if (!Array.isArray(d.reason_vocab) || !d.reason_vocab.length) {
        add('warn', 'v3 payload has no reason_vocab — connection cards use generic reasons');
      }
    } else add('warn', 'v2 payload has no semantic presentation tiers — Focused mode shows direct links only');
    if (d.schema === 'aethergraph.v4') {
      const regions = regionSummary(d.synthesis);
      if (regions.counts.degraded || regions.counts.inactive) {
        add('degraded', `memory synthesis regions — ${regions.label}`);
      } else add('ok', `memory synthesis regions — ${regions.label}`);
      this.tel.env.synthesisMode = d.synthesis.mode;
      this.tel.env.synthesisRegions = regions.label;
    }
    const coreN = d.nodes.filter(DENSITY.core.test).length;
    const corpusN = d.nodes.filter(DENSITY.corpus.test).length;
    if (coreN === corpusN) add('warn', 'Core and Corpus currently contain the same notes — transcript/dial material may be absent');

    const lanes = {};
    for (const n of d.nodes) lanes[n.privacy || 'agent-safe'] = (lanes[n.privacy || 'agent-safe'] || 0) + 1;
    /* `family` is what drives node SHAPE and tier-by-family, not `role`. The first version of
       this check tested `role` and reported "every note has no role — shape is a
       guess", which was alarming and wrong: role is empty for every node, but family is
       populated for every node. A health check that cries wolf is worse than none. */
    const unlabelled = d.nodes.filter(n => !n.family).length;
    const roleless = d.nodes.filter(n => !n.role).length;
    Object.assign(this.tel.env, {
      payloadBytes: bytes, nodes: d.nodes.length,
      explicit: (d.explicit || []).length, latent: (d.latent || []).length,
      ghosts: (d.ghosts || []).length, severed: (d.severed || []).length,
      lanes: JSON.stringify(lanes),
    });
    if (unlabelled) {
      add('warn', `${unlabelled.toLocaleString()} of ${d.nodes.length.toLocaleString()} notes have no role `
        + 'family — shape and tier-by-family are guesses for those');
    } else add('ok', 'every note has a role family — shape is meaningful');
    if (roleless === d.nodes.length) {
      /* Quieter, and true: family still carries shape through the type fallback. */
      add('warn', 'the `role` field is empty for every note; family is carrying shape via the type fallback');
    }
  }

  tierOf(d) {
    switch (this.s.tierBy) {
      case 'standing': { const k = bandOf(d.standing || 0); return { k, n: BANDS.length, label: BANDS[k].label }; }
      case 'age': { const k = clamp(Math.floor((d.age || 0) * 5), 0, 4); return { k, n: 5, label: ['newest', 'recent', 'mid', 'older', 'oldest'][k] }; }
      case 'authority': { const k = 4 - clamp(d.authority_rank === undefined ? 2 : d.authority_rank, 0, 4); return { k, n: 5, label: 'authority ' + (4 - k) }; }
      case 'family': { const k = Math.max(0, FAMILY_ORDER.indexOf(d.family || 'surface')); return { k, n: FAMILY_ORDER.length, label: d.family || 'surface' }; }
      case 'privacy': { const o = ['agent-safe', 'private-local', 'restricted-pointer', 'quarantined']; const k = Math.max(0, o.indexOf(d.privacy)); return { k, n: 4, label: d.privacy }; }
      default: return { k: 0, n: 1, label: '' };
    }
  }
  angleKey(n) {
    const d = n.d;
    switch (this.s.angleBy) {
      case 'time': return (d.age === undefined ? 0.5 : d.age) * 1000;
      case 'family': return Math.max(0, FAMILY_ORDER.indexOf(d.family || 'surface')) * 100 + hueFor((d.facets || [])[0]) / 10;
      case 'project': { const p = d.project || ''; let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) % 997; return h; }
      default: return hueFor((d.facets || [])[0]);
    }
  }

  relayout() {
    if (!this.data) return;
    const t0 = performance.now();
    const test = DENSITY[this.s.density].test, q = this.query;
    const keep = [];
    const eligible = this.data.nodes.map(n => test(n)
      && (this.localBaseline || this.s.showPrivate || n.privacy === 'agent-safe'));
    this.recallFrame = q ? modulateRecall(this.data, q, { eligible }) : null;
    this.regionRecall = q ? modulateRegions(this.data, this.recallFrame) : null;
    this.map = new Int32Array(this.data.nodes.length).fill(-1);
    this.data.nodes.forEach((n, i) => {
      if (!eligible[i]) return;
      /* A first-run baseline is entirely local and is the only dataset available. Enhanced
         payload privacy lanes retain their normal default-deny visibility. */
      const recall = this.recallFrame && this.recallFrame.scores[i];
      if (q && !(recall && recall.selected)) return;
      this.map[i] = keep.length;
      keep.push({
        src: i, d: n, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, hx: 0, hy: 0, hz: 0, deg: 0,
        recall,
        lane: LANE_INDEX[n.evidence] === undefined ? LANE_INDEX.unknown : LANE_INDEX[n.evidence],
      });
    });
    this.nodes = keep;
    const remap = (list) => {
      const out = [];
      for (const e of list) {
        const a = this.map[e[0]], b = this.map[e[1]];
        if (a >= 0 && b >= 0) out.push([a, b, ...e.slice(2)]);
      }
      return out;
    };
    this.presentationVocab = this.data.presentation_vocab || [];
    this.reasonVocab = this.data.reason_vocab || [];
    this.explicitAll = remap(this.data.explicit || []);
    this.latentAll = remap(this.data.latent || []);
    this.explicit = this.explicitAll.filter(e => edgeVisible(e, 'explicit', this.s, this.presentationVocab));
    this.latent = this.latentAll.filter(e => edgeVisible(e, 'latent', this.s, this.presentationVocab));
    for (const e of this.explicit) { keep[e[0]].deg++; keep[e[1]].deg++; }
    for (const e of this.latent) { keep[e[0]].deg++; keep[e[1]].deg++; }
    this.visibleEdgeCount = this.explicit.length + this.latent.length;
    this.allEdgeCount = this.explicitAll.length + this.latentAll.length;
    this.facetGapDistinct = 0; this.facetGapUnknown = 0;
    for (const e of this.explicit.concat(this.latent)) {
      if (e[EDGE.FACET_GAP] === 1) this.facetGapDistinct++;
      else if (e[EDGE.FACET_GAP] === -1) this.facetGapUnknown++;
    }
    this.ghosts = [];
    for (const g of this.data.ghosts || []) {
      const anch = (g.anchors || []).map(a => ({ i: this.map[a.n], w: a.w })).filter(a => a.i >= 0);
      if (anch.length >= 2) this.ghosts.push({ name: g.name, docs: g.docs, anch, x: 0, y: 0, z: 0 });
    }
    this._tc = null;
    this.focus = null; this.hover = null; this._near = null; this._hoverSince = 0;
    this.pinned = null;
    this.cardShowAll = false;
    if (this.card) { this.card.remove(); this.card = null; }
    const tp = performance.now();
    this.place();
    const placeMs = performance.now() - tp;
    this.sim = new Sim3(this.nodes, this.explicit.concat(this.latent), this.s.layout === 'force');
    this.simSkip = 0; this.simPhase = 0; this._dwell = 0;
    const tb = performance.now();
    this.buildBuffers();
    const bufMs = performance.now() - tb;
    this.updateInfo();
    this.tel.count('relayout');
    this.tel.mark('relayout', {
      ms: +(performance.now() - t0).toFixed(1),
      place: +placeMs.toFixed(1), buffers: +bufMs.toFixed(1),
      nodes: this.nodes.length, edgesShown: this.visibleEdgeCount, edgesAll: this.allEdgeCount,
      explicitShown: this.explicit.length, latentShown: this.latent.length,
      facetGapDistinct: this.facetGapDistinct, facetGapUnknown: this.facetGapUnknown,
      ghosts: this.ghosts.length, mode: this.s.connectionMode,
      density: this.s.density, space: this.s.layout, tier: this.s.tierBy, angle: this.s.angleBy,
      filtered: this.query ? 1 : 0, recallTokens: this.recallFrame ? this.recallFrame.tokenCount : 0,
      recallBudget: this.recallFrame ? this.recallFrame.budget : 0,
    });
  }

  /* Everything static about a node or edge is packed once, here, into typed arrays the GPU
     keeps. While the camera moves nothing in this function runs again. */
  buildBuffers() {
    const N = this.nodes;
    const recallPeak = N.reduce((peak, n) => n.recall ? Math.max(peak, n.recall.activation) : peak, 0);
    this.radius = new Float32Array(N.length);
    for (let i = 0; i < N.length; i++) {
      const d = N[i].d;
      const mass = Math.log2((d.mass || 1024) / 1024 + 1);
      const recallScale = N[i].recall && recallPeak > 0
        ? 0.86 + 0.44 * clamp(N[i].recall.activation / recallPeak, 0, 1) : 1;
      this.radius[i] = clamp((2.6 + mass * 1.05 + Math.sqrt(N[i].deg) * 0.95) * recallScale, 2.6, 19);
    }
    if (!this.gl) return;

    const a = {
      index: new Float32Array(N.length), size: new Float32Array(N.length),
      hue: new Float32Array(N.length * 4), style: new Float32Array(N.length * 4),
      flags: new Float32Array(N.length * 4),
    };
    for (let i = 0; i < N.length; i++) {
      const d = N[i].d;
      a.index[i] = i;
      a.size[i] = this.radius[i];
      const facets = (d.facets && d.facets.length) ? d.facets.slice(0, 4) : [d.project || d.type || '·'];
      for (let f = 0; f < 4; f++) a.hue[i * 4 + f] = f < facets.length ? hueFor(facets[f]) : -1;
      const sides = FAMILY_SHAPE[d.family] === undefined ? 0 : FAMILY_SHAPE[d.family];
      a.style[i * 4 + 0] = sides;
      a.style[i * 4 + 1] = clamp(0.46 + (d.corroboration || 1) * 0.13, 0.40, 0.92);
      a.style[i * 4 + 2] = (60 - (d.standing || 0) * 12) / 100;
      /* base alpha folds in the age fade, so opacity stays a real channel with zero cost */
      const recallAlpha = N[i].recall && recallPeak > 0
        ? 0.35 + 0.65 * clamp(N[i].recall.activation / recallPeak, 0, 1) : 1;
      a.style[i * 4 + 3] = clamp(0.30 + (d.standing || 0) * 0.9, 0.22, 0.95)
                         * (1 - (d.age === undefined ? 0.4 : d.age) * 0.5) * recallAlpha;
      a.flags[i * 4 + 0] = d.authority_rank === undefined ? 2 : d.authority_rank;
      a.flags[i * 4 + 1] = PRIVACY_CODE[d.privacy] === undefined ? 0 : PRIVACY_CODE[d.privacy];
      a.flags[i * 4 + 2] = d.contested ? 1 : 0;
      a.flags[i * 4 + 3] = d.hybridity || 0;
    }
    this.gl.setNodes(a, N.length);

    /* Explicit and latent share one buffer: one draw call for every displayed edge. */
    const vocab = this.data.facet_vocab || [];
    const all = this.explicit.length + this.latent.length;
    const e = {
      ends: new Float32Array(all * 2), meta: new Float32Array(all * 4),
      extra: new Float32Array(all * 2),
    };
    let k = 0;
    const push = (list, kind) => {
      for (const ed of list) {
        e.ends[k * 2] = ed[0]; e.ends[k * 2 + 1] = ed[1];
        e.meta[k * 4 + 0] = kind ? ed[EDGE.WEIGHT] : 1.0;
        e.meta[k * 4 + 1] = ed[EDGE.FACET] >= 0 ? hueFor(vocab[ed[EDGE.FACET]]) : -1;
        e.meta[k * 4 + 2] = ed[EDGE.FACET_GAP] === 1 ? 1 : ed[EDGE.FACET_GAP] === -1 ? -1 : 0;
        e.meta[k * 4 + 3] = ed[EDGE.REACH] || 0;
        e.extra[k * 2] = ed[EDGE.SPAN] || 0;
        e.extra[k * 2 + 1] = kind;
        k++;
      }
    };
    push(this.latent, 1);
    push(this.explicit, 0);
    this.gl.setEdges(e, all);
  }

  place() {
    const N = this.nodes, mode = this.s.layout;
    const tiers = new Map();
    N.forEach(n => {
      const t = this.tierOf(n.d); n.tier = t;
      if (!tiers.has(t.k)) tiers.set(t.k, []);
      tiers.get(t.k).push(n);
    });
    this.nT = N.length ? N[0].tier.n : 1;
    this.tierList = [...tiers.keys()].sort((a, b) => a - b)
      .map(k => ({ k, label: tiers.get(k)[0].tier.label, count: tiers.get(k).length }));

    if (mode === 'helix') {
      /* Time as depth: a spiral you look along, so the vault's growth is a shape. */
      const sorted = N.slice().sort((a, b) => (a.d.age === undefined ? 0.5 : a.d.age) - (b.d.age === undefined ? 0.5 : b.d.age));
      sorted.forEach((n, i) => {
        const t = sorted.length > 1 ? i / (sorted.length - 1) : 0;
        const a = t * Math.PI * 2 * 3.2;
        const rr = RAD * (0.30 + 0.70 * (1 - (n.d.standing || 0)));
        n.hx = Math.cos(a) * rr; n.hy = Math.sin(a) * rr; n.hz = (t - 0.5) * GAP * this.nT;
      });
    } else if (mode === 'torus') {
      const groups = {};
      N.forEach(n => { const k = n.d.project || n.d.area || '·'; (groups[k] = groups[k] || []).push(n); });
      const keys = Object.keys(groups).sort();
      const Rmaj = RAD * 0.78, Rmin = RAD * 0.34;
      keys.forEach((k, gi) => {
        const u = (gi / keys.length) * Math.PI * 2;
        groups[k].forEach((n, i) => {
          const v = (i / groups[k].length) * Math.PI * 2 + (n.d.standing || 0) * 3;
          const rr = Rmin * (0.45 + 0.55 * (1 - (n.d.standing || 0)));
          n.hx = (Rmaj + rr * Math.cos(v)) * Math.cos(u);
          n.hy = (Rmaj + rr * Math.cos(v)) * Math.sin(u);
          n.hz = rr * Math.sin(v);
        });
      });
    } else if (mode === 'force') {
      N.forEach((n, i) => {
        const a = i * 2.399, rr = 9 * Math.sqrt(i);
        n.hx = Math.cos(a) * rr; n.hy = Math.sin(a) * rr;
        n.hz = ((n.d.standing || 0) - 0.4) * GAP * 3;
      });
    } else {
      /* strata: one plane per tier. Inside a plane it reads like the flat view — but now the
         links that climb between planes are visible as climbs. */
      for (const [k, arr] of tiers) {
        arr.sort((a, b) => this.angleKey(a) - this.angleKey(b));
        const z = (k - (this.nT - 1) / 2) * GAP;
        const turns = clamp(Math.ceil(arr.length / 320), 1, 4);
        arr.forEach((n, i) => {
          const frac = arr.length > 1 ? i / (arr.length - 1) : 0.5;
          const a = frac * Math.PI * 2 * turns + k * 0.6;
          const rr = RAD * (0.22 + 0.78 * (1 - clamp(n.d.standing || 0, 0, 1)));
          n.hx = Math.cos(a) * rr; n.hy = Math.sin(a) * rr; n.hz = z;
        });
      }
    }
    N.forEach(n => { n.x = n.hx; n.y = n.hy; n.z = n.hz; n.vx = n.vy = n.vz = 0; });
  }

  updateInfo() {
    if (!this.info || !this.nodes) return;
    let s = `${this.nodes.length.toLocaleString()} notes · ${this.visibleEdgeCount.toLocaleString()} of `
      + `${this.allEdgeCount.toLocaleString()} connections shown · ${this.explicit.length.toLocaleString()} direct · `
      + `${this.latent.length.toLocaleString()} contextual · ${this.ghosts.length} ghosts`;
    if (this.recallFrame && this.recallFrame.active) {
      s += ` · recall working set ${this.recallFrame.workingSet.length}/${this.recallFrame.budget}`;
      if (this.regionRecall && this.regionRecall.active) {
        s += ` · regions ${this.regionRecall.recruited}/${this.regionRecall.total} recruited`;
      }
    }
    if (this.s.perf) {
      const fps = this.frameMs > 0 ? (1000 / this.frameMs) : 0;
      const drawCalls = this.gl ? 2 : (this.nodes.length + this.explicit.length + this.latent.length);
      s += `   ▏ ${this.gl ? 'WebGL2' : 'canvas2d'} · ${fps.toFixed(0)} fps · ${this.frameMs.toFixed(1)} ms`
         + ` · sim ${this.simMs.toFixed(1)} ms${this.simSkip ? '/' + (this.simSkip + 1) : ''}`
         + ` · ${drawCalls.toLocaleString()} draw calls`;
    }
    this.info.setText(s);
  }

  /* One matrix, used by the GPU and by every overlay measurement, so they cannot drift. */
  updateCamera() {
    const aspect = this.W / Math.max(1, this.H);
    const proj = GL.perspective(FOV, aspect, 1, 40000);
    this.vp = GL.mat4Mul(proj, GL.orbitView(this.cam.yaw, this.cam.pitch, this.cam.dist, this.cam.ox, this.cam.oy));
  }
  project(p, out) {
    const s = GL.projectWith(this.vp, p, this.W, this.H, out);
    s.k = this.cam.dist * s.w;          /* ≈1 at the focal plane; scales marks with distance */
    return s;
  }

  bindEvents() {
    const c = this.stack;
    let drag = null;
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.cam.dist = clamp(this.cam.dist * (e.deltaY > 0 ? 1.12 : 1 / 1.12), 220, 9000);
    }, { passive: false });
    c.addEventListener('mousedown', e => {
      drag = { x: e.clientX, y: e.clientY, yaw: this.cam.yaw, pitch: this.cam.pitch,
        ox: this.cam.ox, oy: this.cam.oy, pan: e.shiftKey || e.button === 1, moved: false };
    });
    /* A `click` is delivered AFTER `mouseup`, so nulling drag here left the click handler's
       `drag && drag.moved` guard reading null every time — dead code. The consequence was that
       releasing an orbit drag also counted as a click on whatever happened to be under the
       cursor, so selection fired at random. Remember whether the gesture moved, and let the
       click read that. */
    this._dragMoved = false;
    window.addEventListener('mouseup', () => {
      this._dragMoved = !!(drag && drag.moved);
      drag = null;
    });
    c.addEventListener('mousemove', e => {
      const r = c.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.pickAt = this.mouse;       /* pick only when the cursor actually moves */
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.pan) { this.cam.ox = drag.ox + dx; this.cam.oy = drag.oy + dy; }
      else { this.cam.yaw = drag.yaw + dx * 0.006; this.cam.pitch = clamp(drag.pitch + dy * 0.006, -1.45, 1.45); }
    });
    c.addEventListener('mouseleave', () => { this.mouse = null; this.hover = null; this.pickAt = null; });
    c.addEventListener('click', e => {
      if (this._dragMoved) { this._dragMoved = false; this.tel.count('camera.drag'); return; }
      if (!this.hover) { this.clearSelection(); return; }
      if (e.ctrlKey || e.metaKey) { this.openNote(this.hover, false); return; }
      this.select(this.hover);
    });
    /* Right-click is where the actions live. Obsidian's own Menu is used rather than a bespoke
       one so it looks and behaves like the rest of the app — keyboard nav, theming, dismissal. */
    c.addEventListener('contextmenu', e => {
      e.preventDefault();
      const n = this.hover;
      const menu = new Menu();
      if (n) this.nodeMenu(menu, n); else this.viewMenu(menu);
      menu.showAtMouseEvent(e);
      this.tel.mark('menu.open', n ? this.tel.ref(n.d) : { target: 'background' });
      this.tel.count('menu.open');
    });
    /* Escape lets go of everything without hunting for empty space to click. */
    this.scope = this.app.scope;
    c.addEventListener('keydown', e => { if (e.key === 'Escape') this.clearSelection(); });
  }

  /* ---------------------------------------------------------------- selection */
  select(n) {
    const same = this.pinned === n;
    if (same) { this.clearSelection(); return; }
    this.pinned = n;
    this.focus = n;
    this.cardShowAll = false;
    this._near = this.neighbourhood(n);
    this.showCard(n);
    this.tel.mark('select', Object.assign({ neighbours: this._near.size - 1 }, this.tel.ref(n.d)));
    this.tel.count('select');
  }
  clearSelection() {
    if (this.pinned || this.focus) this.tel.mark('select.clear');
    this.pinned = null; this.focus = null; this._near = null;
    if (this.card) { this.card.remove(); this.card = null; }
  }
  openNote(n, split) {
    this.tel.mark('note.open', Object.assign({ split: !!split }, this.tel.ref(n.d)));
    this.tel.count('note.open');
    if (split) this.app.workspace.getLeaf('split').openFile(
      this.app.vault.getAbstractFileByPath(n.d.path));
    else this.app.workspace.openLinkText(n.d.path, '', false);
  }

  /* Counts are disjoint by kind. Facet state is a descriptor on those relations, never a third
     relation kind. Visible counts use the same arrays as drawing, simulation and focus. */
  relations(n) {
    const i = this.nodes.indexOf(n);
    const count = (explicit, latent) => {
      let direct = 0, contextual = 0, distinct = 0, unknown = 0;
      const scan = (list, kind) => {
        for (const e of list) if (e[EDGE.A] === i || e[EDGE.B] === i) {
          if (kind === 'explicit') direct++; else contextual++;
          if (e[EDGE.FACET_GAP] === 1) distinct++;
          else if (e[EDGE.FACET_GAP] === -1) unknown++;
        }
      };
      scan(explicit, 'explicit'); scan(latent, 'latent');
      return { direct, contextual, distinct, unknown, total: direct + contextual };
    };
    return {
      visible: count(this.explicit, this.latent),
      all: count(this.explicitAll || this.explicit, this.latentAll || this.latent),
    };
  }

  edgeReason(edge, kind) {
    return vocabLabel(this.reasonVocab, edge[EDGE.REASON], kind === 'explicit' ? 'direct link' : 'latent affinity');
  }

  facetStateLabel(edge) {
    if (edge[EDGE.FACET_GAP] === -1) return 'facet unknown';
    if (edge[EDGE.FACET_GAP] !== 1) return '';
    return this.data && (this.data.schema === 'aethergraph.v3' || this.data.schema === 'aethergraph.v4')
      ? 'distinct controlled facets' : 'no shared facet/tag';
  }

  connectionItems(n, includeAll) {
    const i = this.nodes.indexOf(n), out = [];
    const add = (list, kind) => {
      for (const edge of list) {
        if (edge[EDGE.A] !== i && edge[EDGE.B] !== i) continue;
        const j = edge[EDGE.A] === i ? edge[EDGE.B] : edge[EDGE.A];
        const node = this.nodes[j];
        if (!node) continue;
        const raw = Number(edge[EDGE.RELEVANCE]);
        const relevance = Number.isFinite(raw) ? clamp(raw, 0, 1)
          : kind === 'explicit' ? 1 : clamp(Number(edge[EDGE.WEIGHT]) || 0, 0, 1);
        out.push({ edge, kind, node, relevance, reason: this.edgeReason(edge, kind),
          facetState: this.facetStateLabel(edge) });
      }
    };
    add(includeAll ? (this.explicitAll || this.explicit) : this.explicit, 'explicit');
    add(includeAll ? (this.latentAll || this.latent) : this.latent, 'latent');
    out.sort((a, b) => b.relevance - a.relevance
      || (a.kind === b.kind ? 0 : a.kind === 'explicit' ? -1 : 1)
      || displayTitle(a.node.d).localeCompare(displayTitle(b.node.d)));
    return out;
  }

  nodeMenu(menu, n) {
    const d = n.d;
    const item = (title, icon, fn) => menu.addItem(mi => { mi.setTitle(title); mi.setIcon(icon); mi.onClick(fn); });
    item('Open note', 'file-text', () => this.openNote(n, false));
    item('Open to the side', 'separator-vertical', () => this.openNote(n, true));
    menu.addSeparator();
    item(this.focus === n ? 'Clear focus' : 'Focus its neighbourhood', 'crosshair',
      () => (this.focus === n ? this.clearSelection() : this.select(n)));
    item('Show details', 'info', () => { this.pinned = n; this.showCard(n); });
    const facet = (nodeSubjects(d)[0] || nodeTopics(d)[0] || nodeContexts(d)[0]
      || nodeDisplayTags(d)[0] || (d.facets || [])[0]);
    if (facet) item(`Filter to “${facet}”`, 'filter', () => this.applyFilter(facet));
    if (d.project) item(`Filter to “${d.project}”`, 'folder', () => this.applyFilter(d.project));
    menu.addSeparator();
    item('Copy wikilink', 'link', async () => {
      await navigator.clipboard.writeText(`[[${d.path.replace(/\.md$/, '')}|${displayTitle(d)}]]`);
      new Notice('Copied wikilink');
      this.tel.mark('copy.wikilink', this.tel.ref(d));
    });
    item('Copy path', 'clipboard-copy', async () => {
      await navigator.clipboard.writeText(d.path);
      new Notice('Copied path');
      this.tel.mark('copy.path', this.tel.ref(d));
    });
    const r = this.relations(n);
    menu.addSeparator();
    menu.addItem(mi => { mi.setTitle(`${r.visible.total} of ${r.all.total} connections shown · `
        + `${r.visible.direct} direct · ${r.visible.contextual} contextual`);
      mi.setIcon('git-fork'); mi.setDisabled(true); });
  }

  viewMenu(menu) {
    const item = (title, icon, fn) => menu.addItem(mi => { mi.setTitle(title); mi.setIcon(icon); mi.onClick(fn); });
    item('Clear focus and filter', 'x', () => { this.applyFilter(''); this.clearSelection(); });
    item(this.s.telemetry ? 'Hide diagnostics panel' : 'Show diagnostics panel', 'activity', async () => {
      this.s.telemetry = !this.s.telemetry;
      if (this.s.telemetry) await this.plugin.ensureDiagnosticSalt();
      await this.plugin.save(this.s);
      if (!this.tel.enabled) this.tel.reset();
      this.syncPanel(); this.rebuildToggles();
    });
    menu.addSeparator();
    item('Run diagnostics', 'stethoscope', () => this.plugin.diagnose());
    item('Write diagnostics report', 'file-output', () => this.plugin.writeReport());
    menu.addSeparator();
    item('Reset view to defaults', 'rotate-ccw', () => {
      this.app.commands ? this.app.commands.executeCommandById('aethergraph:reset-aethergraph')
        : null;
    });
  }

  applyFilter(q) {
    this.query = String(q || '').toLowerCase();
    if (this.filterInput) this.filterInput.value = q || '';
    this.relayout();
    this.tel.mark('filter.menu', { len: this.query.length, hits: this.nodes.length });
  }

  resize() {
    if (!this.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.W = this.contentEl.clientWidth;
    const chromeH = this.bar ? (this.bar.offsetHeight || 40) : 40;
    this.H = Math.max(120, this.contentEl.clientHeight - chromeH);
    this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = this.W + 'px'; this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.gl) this.gl.resize(this.W, this.H, dpr);
    if (this.tel && (this._lastW !== this.W || this._lastH !== this.H)) {
      this._lastW = this.W; this._lastH = this.H;
      this.tel.mark('resize', { w: this.W, h: this.H, dpr, px: Math.round(this.W * this.H * dpr * dpr) });
    }
  }

  loop() {
    if (this.dead) return;
    this.raf = requestAnimationFrame(() => this.loop());
    try { this.frame(); } catch (e) { this.fail('the frame loop', e); }
  }

  frame() {
    const t0 = performance.now();
    this.t += 0.016;
    if (!this.data || !this.nodes) return;
    if (this.s.orbit && !this.reducedMotion) this.cam.yaw += 0.0016;

    /* Phase attribution. A frame-time series alone says a frame was slow; it cannot say which
       of five things made it slow, which is the only question worth asking. Each phase is
       timed into a preallocated object so the frame loop still allocates nothing. */
    const p = this._phase || (this._phase = { total: 0, sim: 0, upload: 0, draw: 0, overlay: 0, pick: 0 });
    p.sim = p.upload = p.draw = p.overlay = p.pick = 0;

    /* Adaptive: if the frame is running long the simulation — the only O(n) CPU work left —
       gives up cycles before the picture does. Layout keeps breathing, just less often. */
    if (this.sim) {
      if (this.simPhase-- <= 0) {
        const s0 = performance.now();
        this.sim.tick();
        p.sim = performance.now() - s0;
        this.simMs = this.simMs * 0.8 + p.sim * 0.2;
        /* The first version compared frameMs against single thresholds, so the controller
           oscillated: skipping a tick made the frame fast, which un-skipped it, which made the
           frame slow. Telemetry counted 1,223 of these flips in one session — the throttle
           spent its time hunting rather than throttling.
           Two fixes: separate raise/lower thresholds (hysteresis), and a minimum dwell before
           it may change its mind again. */
        const up = [0, 21, 30], down = [0, 15, 23];
        let skip = this.simSkip;
        if (this._dwell-- <= 0) {
          if (skip < 2 && this.frameMs > up[skip + 1]) skip++;
          else if (skip > 0 && this.frameMs < down[skip]) skip--;
          if (skip !== this.simSkip) {
            this.simSkip = skip;
            this._dwell = 30;                    /* ~half a second before it may move again */
            this.tel.mark('sim.throttle', { skip, frameMs: +this.frameMs.toFixed(1) });
          }
        }
        this.simPhase = this.simSkip;
        this.tel.count('sim.ticks');
      } else this.tel.count('sim.skipped');
    }

    this.updateCamera();
    if (this.gl) this.drawGL(p); else this.draw2D(p);

    p.total = performance.now() - t0;
    this.frameMs = this.frameMs * 0.88 + p.total * 0.12;
    this.tel.tick(p, p.total >= this.tel.slowMs ? this.slowContext() : null);
    if (this.s.perf && (this.t * 62 | 0) % 20 === 0) this.updateInfo();
  }

  /* Only built when a frame was actually slow, so it costs nothing in the common case. */
  slowContext() {
    return {
      renderer: this.gl ? 'gl' : '2d',
      nodes: this.nodes.length,
      edges: this.visibleEdgeCount, edgesAll: this.allEdgeCount,
      density: this.s.density, space: this.s.layout, tier: this.s.tierBy, mode: this.s.connectionMode,
      flow: this.s.showFlow && !this.reducedMotion ? 1 : 0, labels: this.s.labels ? 1 : 0,
      focus: this._near ? 1 : 0, simSkip: this.simSkip,
      dist: Math.round(this.cam.dist),
    };
  }

  /* dim doubles as the focus channel: 0..1 is opacity, +2 marks hover/focus for the halo. */
  writePositions() {
    const buf = this.gl.posBuf, N = this.nodes, near = this._near;
    for (let i = 0; i < N.length; i++) {
      const n = N[i], o = i * 4;
      buf[o] = n.x; buf[o + 1] = n.y; buf[o + 2] = n.z;
      let dim = near ? (near.has(i) ? 1 : 0.06) : 1;
      if (n === this.focus || n === this.hover || n === this.pinned) dim += 2;
      buf[o + 3] = dim;
    }
    this.gl.uploadPositions();
  }

  drawGL(p) {
    const tu = performance.now();
    this.writePositions();
    p.upload = performance.now() - tu;
    const opts = {
      time: this.t, dpr: this.dpr, pxPerUnit: this.cam.dist * this.dpr,
      flow: this.s.showFlow && !this.reducedMotion, showExplicit: this.s.showExplicit,
      showLatent: this.s.showLatent,
      fogNear: this.cam.dist * 0.55, fogRange: this.cam.dist * 2.4,
      /* EDGE_WEIGHT — measured, not guessed. A GL ribbon covers its pixels fully where the
         canvas hairline it replaces was antialiased down to a fraction of one, so carrying
         the old numbers across drew every edge as a solid ribbon, piling into flat sheets of
         colour with the graph buried underneath. These values were swept against the real
         payload until frame coverage stopped collapsing (19.1% → 9.2%) and the strata read
         again; 0.34/0.85 with alpha 0.085 is the knee, where edges are still plainly there. */
      widthBase: 0.34, widthScale: 0.85,
      alphaExplicit: 0.085, alphaLatent: 0.018, alphaLatentScale: 0.13,
    };
    const td = performance.now();
    this.gl.draw(this.vp, opts);
    p.draw = performance.now() - td;
    this.tel.count('gl.drawCalls', 2);

    /* Picking runs only when the cursor moved. It is a one-pixel readback, but a readback all
       the same, so it does not belong in an idle frame. */
    if (this.pickAt) {
      const tp = performance.now();
      const id = this.gl.pick(this.vp, this.pickAt.x, this.pickAt.y, opts);
      p.pick = performance.now() - tp;
      this.tel.count('pick');
      this.noteHover(id >= 0 && id < this.nodes.length ? this.nodes[id] : null);
      this.pickAt = null;
    }
    const to = performance.now();
    this.drawOverlay();
    this.showTip();
    p.overlay = performance.now() - to;
  }

  /* Hover is recorded only once it becomes attention. Logging every crossing of the cursor
     would produce thousands of events a minute and bury the ones that mean something. */
  noteHover(n) {
    if (n === this.hover) return;
    const prev = this.hover, since = this._hoverSince || 0;
    if (prev && since) {
      const dwell = Date.now() - since;
      if (dwell >= TEL.HOVER_DWELL_MS) {
        this.tel.mark('hover', Object.assign({ ms: dwell }, this.tel.ref(prev.d)));
        this.tel.count('hover.dwelt');
      }
    }
    this.hover = n;
    this._hoverSince = n ? Date.now() : 0;
  }

  /* 2D pass: tier rings, ghosts, severed pairs, labels, legend. Same matrix as the GPU. */
  drawOverlay() {
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    if (!this.nodes.length) return;
    /* no cached projection table in GL mode — the GPU holds the positions, and the handful of
       overlay marks project on demand rather than paying for every node */
    this.proj = null;
    const near = this._near, dim = near ? 0.06 : 1;
    const fog = (p) => clamp(1 - (p.clipW - this.cam.dist * 0.55) / (this.cam.dist * 2.4), 0.12, 1);
    if (this.s.layout === 'strata' && this.s.tierBy !== 'flat') this.drawPlanes(ctx);

    if (this.s.showSevered && this.data.severed) this.drawSevered(ctx);
    if (this.s.showGhosts) this.drawGhosts(ctx, fog);

    if (this.s.labels) this.drawLabels(ctx, near, dim, fog);
    this.drawLegend(ctx, H);
  }

  /* A click used to toggle a dim and nothing else. At full density that dim is invisible, so
     from the outside clicking did nothing at all. Now it pins a card: the same facts the hover
     tooltip shows, but persistent, and with the actions attached so the graph is somewhere you
     can act from rather than only look at. */
  showCard(n) {
    if (this.card) this.card.remove();
    const d = n.d, sp = d.standing_parts || {}, r = this.relations(n);
    const card = this.card = this.contentEl.createDiv({ cls: 'ag-card' });
    card.setAttr('role', 'region');
    card.setAttr('aria-label', `Details and connections for ${displayTitle(d)}`);

    const head = card.createDiv({ cls: 'ag-card-head' });
    head.createDiv({ cls: 'ag-card-title', text: displayTitle(d) });
    const x = head.createEl('button', { cls: 'ag-p-x', text: '×' });
    x.setAttr('type', 'button'); x.setAttr('aria-label', 'Close note details');
    x.onclick = () => this.clearSelection();

    card.createDiv({ cls: 'ag-card-sub',
      text: `${d.type || 'note'}${d.project ? ' · ' + d.project : ''}${d.family ? ' · ' + d.family : ''}` });
    if (typeof d.description === 'string' && d.description.trim()) {
      card.createDiv({ cls: 'ag-card-description', text: d.description.trim() });
    }

    const synthesis = d.synthesis;
    if (synthesis) {
      const dynamic = n.recall || null;
      const frame = this.data.synthesis || {};
      const regions = regionSummary(frame);
      const box = card.createDiv({ cls: 'ag-synthesis' });
      box.createDiv({ cls: 'ag-card-section-title', text: 'memory synthesis · estimate, not truth' });
      const metrics = box.createDiv({ cls: 'ag-synthesis-metrics' });
      const metric = (label, score) => {
        const cell = metrics.createDiv({ cls: 'ag-synthesis-metric' });
        cell.createDiv({ cls: 'ag-synthesis-score', text: `${Math.round(clamp(score || 0, 0, 1) * 100)}%` });
        cell.createDiv({ cls: 'ag-card-l', text: label });
      };
      metric('importance', synthesis.importance.score);
      metric(dynamic ? 'task utility' : 'frame utility', dynamic ? dynamic.utility : synthesis.utility.score);
      metric(dynamic ? 'task activation' : 'rest activation',
        dynamic ? dynamic.activation : synthesis.activation.score);
      metric('confidence', synthesis.confidence.score);
      const detail = box.createDiv({ cls: 'ag-synthesis-detail' });
      const activation = dynamic || synthesis.activation;
      detail.createDiv({ text: `activation: direct ${Math.round(activation.direct * 100)}% · propagated `
        + `${Math.round(activation.propagated * 100)}% · inhibited ${Math.round(activation.inhibited * 100)}%` });
      detail.createDiv({ text: `support: ${synthesis.support.regions} regions · `
        + `${synthesis.support.independent} independent · ${synthesis.support.lineages} lineages` });
      detail.createDiv({ text: `residuals: ${synthesis.residuals.length} · frame ${frame.mode || 'unknown'} · authority ${frame.authority || 'none'}` });
      box.createDiv({ cls: 'ag-region-status' + (regions.counts.degraded || regions.counts.inactive ? ' is-degraded' : ''),
        text: `region receipts: ${regions.label}` });
      if (regions.degraded.length) {
        box.createDiv({ cls: 'ag-region-degraded', text: regions.degraded.join(' · ') });
      }
      if (this.regionRecall && this.regionRecall.active) {
        const recruited = this.regionRecall.regions.filter(region => region.recruitment > 0).slice(0, 6);
        box.createDiv({ cls: 'ag-card-term-label ag-region-recruitment-title',
          text: `task regional recruitment · ${this.regionRecall.recruited}/${this.regionRecall.total}` });
        if (recruited.length) {
          const list = box.createDiv({ cls: 'ag-region-recruitment' });
          for (const region of recruited) {
            const item = list.createDiv({ cls: 'ag-region-recruitment-item'
              + (region.status === 'degraded' ? ' is-degraded' : '') });
            item.createSpan({ text: `${region.id} · ${region.derivationFamily}` });
            item.createSpan({ text: `${Math.round(region.recruitment * 100)}% · ${region.status}` });
          }
        } else box.createDiv({ cls: 'ag-region-degraded', text: 'no region met the task frame' });
      }
    }

    const rel = card.createDiv({ cls: 'ag-card-rel' });
    const stat = (v, label) => {
      const b = rel.createDiv({ cls: 'ag-card-stat' });
      b.createDiv({ cls: 'ag-card-n', text: String(v) });
      b.createDiv({ cls: 'ag-card-l', text: label });
    };
    stat(`${r.visible.total}/${r.all.total}`, 'shown / typed');
    stat(r.visible.direct, 'direct');
    stat(r.visible.contextual, 'contextual');

    const connectionItems = this.connectionItems(n, this.cardShowAll);
    const shownItems = connectionItems.slice(0, 8);
    const connectionSection = card.createDiv({ cls: 'ag-card-connection-section' });
    connectionSection.createDiv({ cls: 'ag-card-section-title', text: this.cardShowAll
      ? `Top typed connections (${connectionItems.length})`
      : `Top shown connections (${connectionItems.length})` });
    if (shownItems.length) {
      const list = connectionSection.createEl('ul', { cls: 'ag-card-connections' });
      for (const item of shownItems) {
        const li = list.createEl('li', { cls: 'ag-connection' });
        const destination = li.createEl('button', { cls: 'ag-connection-title', text: displayTitle(item.node.d) });
        destination.setAttr('type', 'button');
        destination.setAttr('aria-label', `Select ${displayTitle(item.node.d)}`);
        destination.onclick = () => this.select(item.node);
        const meta = li.createDiv({ cls: 'ag-connection-meta' });
        meta.createSpan({ text: item.kind === 'explicit' ? 'direct' : edgePresentation(item.edge, item.kind, this.presentationVocab) });
        meta.createSpan({ text: item.reason });
        meta.createSpan({ text: `${Math.round(item.relevance * 100)}% relevance` });
        if (item.facetState) meta.createSpan({ cls: 'ag-facet-state', text: item.facetState });
      }
    } else connectionSection.createDiv({ cls: 'ag-card-empty', text: 'No connections in this view.' });
    if (r.all.total !== r.visible.total) {
      const swap = connectionSection.createEl('button', { cls: 'ag-card-more', text: this.cardShowAll
        ? `Show current view (${r.visible.total})` : `Show all typed (${r.all.total})` });
      swap.setAttr('type', 'button');
      swap.setAttr('aria-pressed', this.cardShowAll ? 'true' : 'false');
      swap.onclick = () => { this.cardShowAll = !this.cardShowAll; this.showCard(n); };
    }

    const kv = card.createDiv({ cls: 'ag-p-kv' });
    const row = (k, v) => { kv.createSpan({ cls: 'ag-p-k', text: k }); kv.createSpan({ cls: 'ag-p-v', text: String(v) }); };
    row('standing', (d.standing === undefined ? 0 : d.standing).toFixed(2)
      + ` (${n.tier ? n.tier.label : '—'})`);
    row('provenance', sp.provenance === undefined ? '—' : sp.provenance);
    row('corroboration', sp.corroboration === undefined ? '—' : sp.corroboration + ' roots');
    row('load', sp.load === undefined ? '—' : sp.load + ' dependents');
    if (sp.contested) row('contested', 'yes — the corpus disagrees');
    row('mass', d.mass ? (d.mass / 1024).toFixed(0) + ' KB' : '—');
    row('entered as', d.evidence || 'unknown');

    /* Cards are summaries, not concordances. Subjects answer what the document is about;
       contexts answer when or where it matters. They stay separate so a contextual frame is
       never mistaken for a document claim. */
    const chips = (label, terms) => {
      if (!terms.length) return;
      const block = label ? card.createDiv({ cls: 'ag-card-term-block' }) : card;
      if (label) block.createDiv({ cls: 'ag-card-term-label', text: label });
      const f = block.createDiv({ cls: 'ag-card-facets' + (label ? '' : ' is-legacy') });
      for (const name of terms) {
        const chip = f.createEl('button', { cls: 'ag-chip', text: name });
        chip.setAttr('type', 'button');
        chip.setAttr('aria-label', `Filter to ${name}`);
        chip.style.borderColor = `hsla(${hueFor(name)},60%,65%,0.55)`;
        chip.style.color = `hsl(${hueFor(name)},60%,78%)`;
        chip.onclick = () => this.applyFilter(name);
      }
    };
    if (synthesis) {
      chips('subjects', nodeSubjects(d).slice(0, 4));
      chips('contexts', nodeContexts(d).slice(0, 4));
    }
    const terms = nodeDisplayTags(d).length ? nodeDisplayTags(d).slice(0, 3)
      : nodeTopics(d).length ? nodeTopics(d).slice(0, 3) : (d.facets || []).slice(0, 3);
    chips(synthesis ? 'document labels' : null, terms);
    if (d.privacy && d.privacy !== 'agent-safe') {
      card.createDiv({ cls: 'ag-tip-priv', text: d.privacy });
    }
    card.createDiv({ cls: 'ag-card-path', text: d.path });

    const acts = card.createDiv({ cls: 'ag-card-acts' });
    const btn = (label, fn, primary) => {
      const b = acts.createEl('button', { cls: 'ag-p-btn' + (primary ? ' is-primary' : ''), text: label });
      b.setAttr('type', 'button');
      b.onclick = fn;
      return b;
    };
    btn('Open', () => this.openNote(n, false), true);
    btn('Side', () => this.openNote(n, true));
    btn('Actions', (ev) => {
      const menu = new Menu();
      this.nodeMenu(menu, n);
      menu.showAtMouseEvent(ev);
      this.tel.mark('menu.open', this.tel.ref(d));
    });
  }

  showTip() {
    const best = this.hover;
    /* the pinned card supersedes the hover tooltip — two overlapping panels reading the same
       fields is noise, and the card is the one you asked for */
    if (this.pinned) { if (this.tip) this.tip.style.display = 'none'; return; }
    if (!best || !this.mouse) { if (this.tip) this.tip.style.display = 'none'; return; }
    const d = best.d, sp = d.standing_parts || {};
    this.tip.style.display = '';
    this.tip.style.left = (this.mouse.x + 16) + 'px';
    this.tip.style.top = (this.mouse.y + 12) + 'px';
    this.tip.empty();
    this.tip.createDiv({ cls: 'ag-tip-title', text: displayTitle(d) });
    this.tip.createDiv({ cls: 'ag-tip-meta', text: `${d.type || 'note'}${d.project ? ' · ' + d.project : ''}` });
    if (typeof d.description === 'string' && d.description.trim()) {
      this.tip.createDiv({ cls: 'ag-tip-description', text: clipLabel(d.description.trim(), 150) });
    }
    const st = this.tip.createDiv({ cls: 'ag-tip-lane' });
    st.setText(`standing ${(d.standing === undefined ? 0 : d.standing).toFixed(2)} — prov ${sp.provenance || 0} · corrob ${sp.corroboration || 1} · load ${sp.load || 0}${sp.contested ? ' · CONTESTED' : ''}`);
    st.style.color = LANES[best.lane].color;
    this.tip.createDiv({ cls: 'ag-tip-meta',
      text: `tier: ${best.tier ? best.tier.label : '—'} · ${d.family || '—'} · ${d.mass ? (d.mass / 1024).toFixed(0) + ' KB' : '—'}` });
    if (d.privacy !== 'agent-safe') this.tip.createDiv({ cls: 'ag-tip-priv', text: d.privacy });
    const subjects = nodeSubjects(d).slice(0, 3), contexts = nodeContexts(d).slice(0, 3);
    if (subjects.length) this.tip.createDiv({ cls: 'ag-tip-facets', text: `subjects: ${subjects.join(' · ')}` });
    if (contexts.length) this.tip.createDiv({ cls: 'ag-tip-contexts', text: `contexts: ${contexts.join(' · ')}` });
    const terms = nodeDisplayTags(d).length ? nodeDisplayTags(d).slice(0, 3)
      : nodeTopics(d).length ? nodeTopics(d).slice(0, 3) : (d.facets || []).slice(0, 3);
    if (terms.length) this.tip.createDiv({ cls: 'ag-tip-facets', text: terms.join(' · ') });
    if (d.synthesis) {
      const sy = d.synthesis, dynamic = best.recall || null, regions = regionSummary(this.data.synthesis);
      this.tip.createDiv({ cls: 'ag-tip-synthesis', text: `synthesis estimate — importance `
        + `${Math.round(sy.importance.score * 100)}% · task utility `
        + `${Math.round((dynamic ? dynamic.utility : sy.utility.score) * 100)}% · activation `
        + `${Math.round((dynamic ? dynamic.activation : sy.activation.score) * 100)}% · confidence `
        + `${Math.round(sy.confidence.score * 100)}%` });
      this.tip.createDiv({ cls: 'ag-tip-meta', text: `support ${sy.support.regions} regions / `
        + `${sy.support.independent} independent · ${sy.residuals.length} residuals` });
      this.tip.createDiv({ cls: 'ag-region-status' + (regions.counts.degraded || regions.counts.inactive ? ' is-degraded' : ''),
        text: `region receipts: ${regions.label}` });
      if (this.regionRecall && this.regionRecall.active) {
        const recruited = this.regionRecall.regions.filter(region => region.recruitment > 0).slice(0, 3);
        this.tip.createDiv({ cls: 'ag-tip-meta', text: recruited.length
          ? `task regions: ${recruited.map(region => `${region.id}/${region.derivationFamily} `
            + `${Math.round(region.recruitment * 100)}%`).join(' · ')}`
          : 'task regions: none recruited' });
      }
    }
    this.tip.createDiv({ cls: 'ag-tip-meta', text: 'entered as: ' + d.evidence + '  (how it was imported, not how true it is)' });
    this.tip.createDiv({ cls: 'ag-tip-path', text: d.path });
  }

  neighbourhood(n) {
    const i = this.nodes.indexOf(n), set = new Set([i]);
    for (const e of this.explicit) { if (e[0] === i) set.add(e[1]); else if (e[1] === i) set.add(e[0]); }
    for (const e of this.latent) { if (e[0] === i) set.add(e[1]); else if (e[1] === i) set.add(e[0]); }
    return set;
  }

  /* ---------------------------------------------------------------- canvas-2D fallback */
  pickHover2D() {
    if (!this.mouse || !this.proj) { this.noteHover(null); return; }
    let best = null, bd = 20 * 20;
    for (let i = 0; i < this.nodes.length; i++) {
      const s = this.proj[i]; if (!s || s.behind) continue;
      const dx = s.x - this.mouse.x, dy = s.y - this.mouse.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = this.nodes[i]; }
    }
    this.noteHover(best);
  }

  draw2D(p) {
    const t2 = performance.now();
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    if (!this.nodes.length) { if (p) p.draw = performance.now() - t2; return; }
    if (p) this._t2 = t2;
    const near = this._near;
    const dim = near ? 0.06 : 1;
    const vocab = this.data.facet_vocab || [];
    const recallPeak = this.nodes.reduce((peak, n) => n.recall ? Math.max(peak, n.recall.activation) : peak, 0);
    this.proj = this.nodes.map(n => this.project(n));
    const fog = (p) => clamp(1 - (p.clipW - this.cam.dist * 0.55) / (this.cam.dist * 2.4), 0.12, 1);
    this.pickHover2D();

    if (this.s.layout === 'strata' && this.s.tierBy !== 'flat') this.drawPlanes(ctx);

    const drawEdges = (list, isLatent) => {
      const heavy = list.length > 2600;
      for (const e of list) {
        const facetState = e[EDGE.FACET_GAP] === 1 ? 1 : e[EDGE.FACET_GAP] === -1 ? -1 : 0;
        const p = this.proj[e[0]], q = this.proj[e[1]];
        if (!p || !q || p.behind || q.behind) continue;
        const vis = !near || (near.has(e[0]) && near.has(e[1]));
        const muted = facetState !== 0;
        const facetAlpha = facetState === 1 ? 0.46 : facetState === -1 ? 0.32 : 1;
        const a = (isLatent ? 0.06 + e[2] * 0.34 : 0.30) * (vis ? 1 : dim) * fog(p) * facetAlpha;
        if (a < 0.015) continue;
        const hue = muted ? 215 : (e[3] >= 0 ? hueFor(vocab[e[3]]) : 210);
        const sat = muted ? (facetState === -1 ? 6 : 12) : (e[3] >= 0 ? 62 : 24);
        ctx.strokeStyle = `hsla(${hue},${sat}%,${muted ? 64 : 72}%,${a})`;
        const facetWidth = facetState === 1 ? 0.62 : facetState === -1 ? 0.74 : 1;
        ctx.lineWidth = clamp((isLatent ? e[2] * 1.6 : 1.0) * facetWidth * ((p.k + q.k) / 2), 0.35, 3);
        const bow = e[4] * 90 + (isLatent ? 26 : 8);
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        const nx = -(q.y - p.y), ny = (q.x - p.x), L = Math.hypot(nx, ny) || 1;
        const cxp = mx + (nx / L) * bow, cyp = my + (ny / L) * bow - e[5] * 30;
        ctx.beginPath(); ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(cxp, cyp, q.x, q.y); ctx.stroke();

        if (this.s.showFlow && !this.reducedMotion && !heavy && vis && e[2] > 0.45) {
          const speed = 0.16 + e[2] * 0.5;
          const t2 = (this.t * speed + (e[0] * 0.137 + e[1] * 0.071)) % 1, it = 1 - t2;
          const fx = it * it * p.x + 2 * it * t2 * cxp + t2 * t2 * q.x;
          const fy = it * it * p.y + 2 * it * t2 * cyp + t2 * t2 * q.y;
          ctx.fillStyle = `hsla(${hue},${sat}%,84%,${clamp(a * 2.4, 0, 0.9)})`;
          ctx.beginPath(); ctx.arc(fx, fy, clamp(1.5 * ((p.k + q.k) / 2), 0.7, 2.6), 0, 6.2832); ctx.fill();
        }
      }
    };
    drawEdges(this.latent, true);
    drawEdges(this.explicit, false);

    if (this.s.showSevered && this.data.severed) this.drawSevered(ctx);
    if (this.s.showGhosts) this.drawGhosts(ctx, fog);

    const order = this.nodes.map((_, i) => i)
      .filter(i => !this.proj[i].behind)
      .sort((a, b) => this.proj[b].depth - this.proj[a].depth);
    for (const i of order) {
      const n = this.nodes[i], d = n.d, s = this.proj[i];
      if (s.x < -80 || s.y < -80 || s.x > W + 80 || s.y > H + 80) continue;
      const vis = !near || near.has(i);
      const recallAlpha = n.recall && recallPeak > 0
        ? 0.35 + 0.65 * clamp(n.recall.activation / recallPeak, 0, 1) : 1;
      const alpha = (vis ? 1 : dim) * (1 - (d.age === undefined ? 0.4 : d.age) * 0.5)
        * fog(s) * recallAlpha;
      if (alpha < 0.02) continue;
      const r = clamp(this.radius[i] * s.k, 1.2, 34);
      const sides = FAMILY_SHAPE[d.family] === undefined ? 0 : FAMILY_SHAPE[d.family];
      const rot = FAMILY_ROT[d.family] || 0;
      const sat = clamp(46 + (d.corroboration || 1) * 13, 40, 92);
      const solid = clamp(0.30 + (d.standing || 0) * 0.9, 0.22, 0.95);
      const facets = (d.facets && d.facets.length) ? d.facets.slice(0, 5) : [d.project || d.type || '·'];
      const step = (Math.PI * 2) / facets.length;
      for (let f = 0; f < facets.length; f++) {
        wedge(ctx, s.x, s.y, r, -Math.PI / 2 + f * step, -Math.PI / 2 + (f + 1) * step, sides, rot);
        ctx.fillStyle = `hsla(${hueFor(facets[f])},${sat}%,${60 - (d.standing || 0) * 12}%,${solid * alpha})`;
        ctx.fill();
      }
      ctx.lineWidth = clamp(s.k, 0.4, 1.4);
      ctx.strokeStyle = LANES[n.lane].color + Math.round(alpha * 190).toString(16).padStart(2, '0');
      poly(ctx, s.x, s.y, r, sides, rot); ctx.stroke();
      const ar = d.authority_rank === undefined ? 2 : d.authority_rank;
      if (ar > 0) {
        ctx.beginPath(); ctx.arc(s.x, s.y, clamp(r * 0.16 * ar, 0.7, r * 0.55), 0, 6.2832);
        ctx.fillStyle = `rgba(255,252,235,${(0.18 + ar * 0.19) * alpha})`; ctx.fill();
      }
      if (d.hybridity > 0.24) {
        ctx.save(); ctx.setLineDash([1.5, 3]); ctx.lineWidth = 0.9;
        ctx.strokeStyle = `hsla(285,80%,74%,${0.30 * d.hybridity * alpha})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, r + 2.4, 0, 6.2832); ctx.stroke(); ctx.restore();
      }
      if (d.contested) {
        const g = ctx.createRadialGradient(s.x, s.y, r, s.x, s.y, r + 9);
        g.addColorStop(0, `rgba(242,110,130,${0.22 * alpha})`); g.addColorStop(1, 'rgba(242,110,130,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.x, s.y, r + 9, 0, 6.2832); ctx.fill();
      }
      const pr = PRIVACY_RING[d.privacy];
      if (pr) {
        ctx.save(); ctx.setLineDash(pr.dash); ctx.strokeStyle = pr.color; ctx.lineWidth = pr.w;
        poly(ctx, s.x, s.y, r + 3.4, sides, rot); ctx.stroke(); ctx.restore();
      }
      if (this.focus === n || this.hover === n) {
        ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 2;
        poly(ctx, s.x, s.y, r + 5.5, sides, rot); ctx.stroke();
      }
    }
    /* same merging rule as the GL path — one implementation, so the two renderers cannot
       disagree about what the picture says */
    if (this.s.labels) this.drawLabels(ctx, near, dim, fog);
    this.drawLegend(ctx, H);
    this.showTip();
    /* the 2D path has no phase separation to offer — it is one long immediate-mode pass, which
       is precisely the property that made it slow */
    if (p) { p.draw = performance.now() - this._t2; this.tel.count('canvas2d.frames'); }
  }

  /* ---------------------------------------------------------------- semantic-zoom labels
   *
   * At full density with every title drawn, thousands of labels overdrew into solid white
   * bands that erased the graph. Gating on degree does not fix that — it just picks a
   * different few thousand.
   *
   * So labels MERGE. The screen is binned into label-sized cells; every node that lands in a
   * cell joins that cell's cluster, and each cell emits exactly ONE label. What that label
   * says depends on what the cluster has in common:
   *
   *   one note              -> its title
   *   a few, sharing a facet-> the facet, and how many
   *   many, sharing nothing -> the coarsest thing they do share: project, then area
   *
   * Zoom does the rest by itself, which is the point of doing it in screen space. Far away,
   * hundreds of nodes fall into one cell and you read "metaphysics · 240" — the high concept.
   * Zoom in and they spread across many cells, the clusters shrink, the shared term becomes
   * more specific, and eventually each cell holds one note and you read its title. No zoom
   * thresholds to tune: the projection already knows how far away you are.
   */
  drawLabels(ctx, near, dim, fog) {
    const W = this.W, H = this.H;
    const CW = 168, CH = 26;                       /* a label's footprint, in pixels */
    const cols = Math.ceil(W / CW) + 1;
    const cells = this._cells || (this._cells = new Map());
    const pool = this._pool || (this._pool = []);
    cells.clear();
    let used = 0;
    const s = this._scratch || (this._scratch = {});

    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i], d = n.d;
      const vis = !near || near.has(i);
      if (!vis && this.focus !== n) continue;
      this.project(n, s);
      if (s.behind || s.x < -CW || s.y < -CH || s.x > W + CW || s.y > H + CH) continue;
      const key = ((s.y / CH) | 0) * cols + ((s.x / CW) | 0);
      let c = cells.get(key);
      if (c === undefined) {
        c = pool[used] || (pool[used] = { n: 0, x: 0, y: 0, w: 0, best: null, bestW: -1,
          subjects: new Map(), topics: new Map(), contexts: new Map(), facets: new Map(),
          projects: new Map(), areas: new Map() });
        used++;
        c.n = 0; c.x = 0; c.y = 0; c.w = 0; c.best = null; c.bestW = -1;
        c.subjects.clear(); c.topics.clear(); c.contexts.clear(); c.facets.clear();
        c.projects.clear(); c.areas.clear();
        cells.set(key, c);
      }
      /* weight decides which single note speaks for a singleton cluster, and which clusters
         survive the budget: load-bearing, well-connected, near the camera */
      const w = (1 + n.deg) * (0.4 + (d.standing || 0)) * (s.k > 0 ? s.k : 0.01);
      c.n++; c.x += s.x; c.y += s.y; c.w += w;
      if (w > c.bestW) { c.bestW = w; c.best = n; c.bestY = s.y + this.radius[i] * s.k + 11; c.bestX = s.x; }
      const subjects = nodeSubjects(d);
      for (const subject of subjects) c.subjects.set(subject, (c.subjects.get(subject) || 0) + 1);
      const topics = nodeTopics(d);
      for (const topic of topics) c.topics.set(topic, (c.topics.get(topic) || 0) + 1);
      const contexts = nodeContexts(d);
      for (const context of contexts) c.contexts.set(context, (c.contexts.get(context) || 0) + 1);
      const fs = termNames(d.facets);
      for (const facet of fs) c.facets.set(facet, (c.facets.get(facet) || 0) + 1);
      if (d.project) c.projects.set(d.project, (c.projects.get(d.project) || 0) + 1);
      if (d.area) c.areas.set(d.area, (c.areas.get(d.area) || 0) + 1);
    }

    /* the cluster the cursor or focus is in always speaks, and always in full detail */
    const list = [];
    for (const c of cells.values()) list.push(c);
    list.sort((a, b) => b.w - a.w);
    const budget = Math.min(list.length, 150);
    const sources = { title: 0, subject: 0, topic: 0, context: 0, facet: 0,
      project: 0, area: 0, neutral: 0 };

    ctx.textAlign = 'center';
    for (let k = 0; k < budget; k++) {
      const c = list[k];
      const merged = c.n > 1;
      let text, weight;
      if (!merged) {
        text = clipLabel(displayTitle(c.best.d), 30);
        weight = 0;
        sources.title++;
      } else {
        /* the most specific term the cluster actually shares, then how many it speaks for */
        const top = (m) => {
          let bk = null, bv = 0;
          for (const [kk, vv] of m) {
            if (vv > bv || (vv === bv && (bk === null || String(kk).localeCompare(String(bk)) < 0))) {
              bv = vv; bk = kk;
            }
          }
          return [bk, bv];
        };
        const [subject, sn] = top(c.subjects);
        const [topic, tn] = top(c.topics);
        const [context, cn] = top(c.contexts);
        const [f, fn] = top(c.facets);
        const [p, pn] = top(c.projects);
        const [ar, an] = top(c.areas);
        const threshold = c.n * 0.6;
        if (subject && sn >= threshold) { text = subject; weight = 2; sources.subject++; }
        else if (topic && tn >= threshold) { text = topic; weight = 2; sources.topic++; }
        else if (context && cn >= threshold) { text = context; weight = 2; sources.context++; }
        else if (f && fn >= threshold) { text = f; weight = 2; sources.facet++; }
        else if (p && pn >= threshold) { text = p; weight = 1; sources.project++; }
        else if (ar && an >= threshold) { text = String(ar).replace(/^\d+\s+/, ''); weight = 1; sources.area++; }
        else { text = `${c.n} notes`; weight = 0; sources.neutral++; }
        if (weight > 0) text = text + ' · ' + c.n;
      }
      const x = merged ? c.x / c.n : c.bestX;
      const y = merged ? c.y / c.n : c.bestY;
      const a = clamp(0.35 + c.w / (list[0].w || 1) * 0.65, 0.3, 1) * (near ? 1 : 1);
      if (merged) {
        /* the high-concept labels read as a different kind of thing to a note title */
        ctx.font = `${weight === 2 ? 11.5 : 10.5}px var(--font-interface)`;
        ctx.fillStyle = weight === 2
          ? `hsla(${hueFor(text.split(' · ')[0])},62%,78%,${a})`
          : `rgba(210,222,242,${a * 0.85})`;
      } else {
        ctx.font = '10px var(--font-interface)';
        ctx.fillStyle = `rgba(226,232,245,${a * 0.8})`;
      }
      ctx.fillText(text, x, y);
    }
    this.tel.count('labels.drawn', budget);
    this.tel.count('labels.clusters', list.length);
    for (const [source, count] of Object.entries(sources)) if (count) this.tel.count('labels.source.' + source, count);
  }

  /* ---------------------------------------------------------------- shared overlay pieces */
  drawPlanes(ctx) {
    if (!this.tierList) return;
    ctx.save();
    ctx.font = '10px var(--font-interface)'; ctx.textAlign = 'left';
    for (const t of this.tierList) {
      const z = (t.k - (this.nT - 1) / 2) * GAP;
      ctx.strokeStyle = 'rgba(150,180,225,0.09)'; ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const p = this.project({ x: Math.cos(a) * RAD * 1.06, y: Math.sin(a) * RAD * 1.06, z });
        if (p.behind) { started = false; continue; }
        started ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
        started = true;
      }
      ctx.stroke();
      const lp = this.project({ x: RAD * 1.1, y: 0, z });
      if (!lp.behind) {
        ctx.fillStyle = 'rgba(170,195,235,0.42)';
        ctx.fillText(`${t.label}  (${t.count})`, lp.x + 6, lp.y);
      }
    }
    ctx.restore();
  }

  drawSevered(ctx) {
    ctx.save(); ctx.setLineDash([6, 7]); ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(242,116,140,0.5)';
    const at = (n) => (this.proj ? this.proj[this.nodes.indexOf(n)] : this.project(n));
    for (const sp of this.data.severed) {
      const A = this.findByTerm(sp.pair[0]), B = this.findByTerm(sp.pair[1]);
      if (!A || !B) continue;
      const p = at(A), q = at(B);
      if (!p || !q || p.behind || q.behind) continue;
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const nx = -(q.y - p.y), ny = (q.x - p.x), L = Math.hypot(nx, ny) || 1;
      const gx = mx + (nx / L) * 40, gy = my + (ny / L) * 40;
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(gx, gy, lerp(p.x, q.x, 0.40), lerp(p.y, q.y, 0.40)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lerp(p.x, q.x, 0.60), lerp(p.y, q.y, 0.60));
      ctx.quadraticCurveTo(gx, gy, q.x, q.y); ctx.stroke();
    }
    ctx.restore();
  }

  drawGhosts(ctx, fog) {
    const pulse = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.t * 1.6);
    for (const g of this.ghosts) {
      let sx = 0, sy = 0, sz = 0, sw = 0;
      for (const a of g.anch) { const n = this.nodes[a.i]; if (!n) continue; sx += n.x * a.w; sy += n.y * a.w; sz += n.z * a.w; sw += a.w; }
      if (!sw) continue;
      g.x = sx / sw; g.y = sy / sw; g.z = sz / sw;
      const s = this.project(g);
      if (s.behind) continue;
      const f = fog(s);
      const rad = (10 + Math.min(16, Math.log2(g.docs + 1) * 2)) * s.k;
      ctx.save(); ctx.setLineDash([3, 5]); ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(255,235,190,${(0.26 + pulse * 0.3) * f})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, rad, 0, 6.2832); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(255,235,190,${(0.045 + pulse * 0.05) * f})`;
      for (const a of g.anch.slice(0, 8)) {
        const n = this.nodes[a.i]; if (!n) continue;
        const p = this.proj ? this.proj[a.i] : this.project(n);
        if (!p || p.behind) continue;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      if (s.k > 0.55) {
        ctx.fillStyle = `rgba(255,240,205,${(0.5 + pulse * 0.3) * f})`;
        ctx.font = '11px var(--font-interface)'; ctx.textAlign = 'center';
        ctx.fillText(g.name, s.x, s.y - rad - 5);
      }
      ctx.restore();
    }
  }

  findByTerm(term) {
    if (!this._tc) this._tc = new Map();
    if (this._tc.has(term)) return this._tc.get(term);
    const t = term.toLowerCase();
    let best = null;
    for (const n of this.nodes) {
      const d = n.d;
      const searchable = [displayTitle(d), d.title, ...(d.aliases || []), ...nodeTopics(d),
        ...nodeDisplayTags(d), ...nodeSubjects(d), ...nodeContexts(d), ...(d.facets || []),
        ...(d.tags || [])]
        .filter(v => typeof v === 'string').join(' ').toLowerCase();
      if (searchable.includes(t)) { best = n; break; }
    }
    this._tc.set(term, best);
    return best;
  }

  drawLegend(ctx, H) {
    const x = 12, y = H - 74;
    ctx.save();
    ctx.font = '10px var(--font-interface)'; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(200,210,230,0.5)';
    [
      'radius = standing (not certainty) · height = tier',
      'shape = role · size = mass · fade = age · core = authority',
      'edge hue = shared facet · muted grey = distinct/unknown facet state',
      'bow = reach in standing · flow speed = strength',
      `${this.s.connectionMode} connections · select a note for reasons`,
    ].forEach((t, i) => ctx.fillText(t, x, y + i * 13));
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ plugin */
module.exports = class Aethergraph extends Plugin {
  async onload() {
    this.settings = sanitize(await this.loadData());
    this.tel = new Telemetry(this);
    this.tel.env.obsidian = (this.app && this.app.vault && this.app.vault.adapter
      && this.app.vault.adapter.constructor && this.app.vault.adapter.constructor.name) || 'unknown';
    this.tel.env.platform = navigator.platform;
    this.tel.env.cores = navigator.hardwareConcurrency || 'unknown';
    if (navigator.deviceMemory) this.tel.env.memoryGB = navigator.deviceMemory;
    this.tel.mark('plugin.load');
    /* a periodic flush so a hard crash costs at most FLUSH_MS of history */
    this.registerInterval(window.setInterval(() => this.tel.flush(), TEL.FLUSH_MS));

    this.registerView(VIEW_TYPE, leaf => new AetherView(leaf, this));
    this.addRibbonIcon('git-fork', 'Aethergraph', () => this.open());
    this.addCommand({ id: 'open', name: 'Open Aethergraph', callback: () => this.open() });
    /* Every toggle is sticky, which is right until a session leaves the view in a state that
       reads as broken — all edges off at full density is a cloud of dots. One command back. */
    this.addCommand({
      id: 'reset-view',
      name: 'Reset Aethergraph view to defaults',
      callback: async () => {
        this.settings = Object.assign({}, DEFAULTS);
        await this.saveData(this.settings);
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
          const v = leaf.view;
          if (!v || !v.relayout) continue;
          v.s = Object.assign({}, DEFAULTS);
          v.contentEl.empty();
          await v.onOpen();
        }
        new Notice('Aethergraph: view reset — Core density, Focused connections, motion layers off.');
      },
    });
    this.addCommand({
      id: 'diagnostics-report',
      name: 'Write diagnostics report',
      callback: () => this.writeReport(),
    });
    this.addCommand({
      id: 'copy-diagnostics',
      name: 'Copy diagnostics JSON to clipboard',
      callback: async () => {
        await navigator.clipboard.writeText(JSON.stringify(this.tel.snapshot(), null, 2));
        new Notice('Aethergraph: diagnostics snapshot copied.');
      },
    });
    this.addCommand({
      id: 'toggle-diagnostics-file',
      name: 'Toggle diagnostics file logging',
      callback: async () => {
        const next = !this.settings.telemetryFile;
        if (next) await this.ensureDiagnosticSalt();
        this.settings.telemetryFile = next;
        await this.saveData(this.settings);
        this.tel.mark('telemetry.file', { on: this.settings.telemetryFile });
        if (!this.settings.telemetryFile) {
          await this.tel.flush(true);
          if (!this.tel.enabled) this.tel.reset();
        }
        new Notice('Aethergraph: diagnostics file logging '
          + (this.settings.telemetryFile ? 'ON → ' + TEL.DIR : 'off'));
      },
    });
    this.addCommand({
      id: 'run-diagnostics',
      name: 'Run diagnostics',
      callback: () => this.diagnose(),
    });
    this.addSettingTab(new AetherSettings(this.app, this));
  }

  /* A deliberate, on-demand check of everything that has ever gone wrong here, so the answer
     to "it's not working" is a list of facts rather than a round of guessing. */
  async diagnose() {
    const out = [];
    const add = (ok, msg) => out.push((ok === null ? '·' : ok ? '✓' : '✗') + ' ' + msg);
    let gl = null;
    try {
      const c = document.createElement('canvas');
      gl = c.getContext('webgl2');
      add(!!gl, gl ? 'WebGL2 available' : 'WebGL2 NOT available — canvas 2D fallback, ~25x slower');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        add(null, 'GPU: ' + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'masked'));
      }
    } catch (e) { add(false, 'WebGL2 probe threw: ' + e.message); }

    try {
      const enhanced = await readEnhancedPayload(this.app);
      const d = enhanced.data || buildBaselinePayload(this.app);
      if (enhanced.data) add(true, `enhanced payload present at ${enhanced.path} — `
        + `${(enhanced.raw.length / 1048576).toFixed(2)} MB, schema ${d.schema}`);
      else add(null, 'no enhanced payload; authored-link metadata-cache baseline is available');
      add(true, 'schema and resource bounds validated');
      add(true, `${d.nodes.length.toLocaleString()} nodes · ${(d.explicit || []).length.toLocaleString()} direct `
        + `· ${(d.latent || []).length.toLocaleString()} latent · ${(d.ghosts || []).length} ghosts`);
      if (d.observed_at) {
        const age = (Date.now() - Date.parse(d.observed_at)) / 86400000;
        add(age <= 14, `payload is ${age.toFixed(1)} days old`);
      }
      const coreN = d.nodes.filter(DENSITY.core.test).length;
      const corpusN = d.nodes.filter(DENSITY.corpus.test).length;
      add(coreN !== corpusN, `${coreN.toLocaleString()} Core · ${corpusN.toLocaleString()} Corpus notes`);
    } catch (e) { add(false, 'graph data unavailable: ' + e.message); }

    const views = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    add(views.length > 0, views.length ? `${views.length} view(s) open` : 'no view open');
    for (const leaf of views) {
      const v = leaf.view;
      if (!v || !v.tel) continue;
      add(!v.dead, v.dead ? 'view has STOPPED — see errors below' : 'view running');
      add(!!v.gl, v.gl ? 'renderer: WebGL2' : 'renderer: canvas 2D fallback');
      const s = v.tel.snapshot();
      add(null, `${s.fps.toFixed(0)} fps median, ${s.longPct.toFixed(1)}% long frames`);
      for (const err of s.errors) add(false, `${err.n}× ${err.where}: ${err.msg}`);
      for (const hh of s.health) if (hh.level !== 'ok') add(false, hh.msg);
    }
    add(null, 'file logging ' + (this.settings.telemetryFile ? 'ON → ' + TEL.DIR : 'off'));

    const text = out.join('\n');
    console.log('%c[aethergraph] diagnostics\n' + text, 'font-weight:bold');
    this.tel.mark('diagnose', { lines: out.length });
    new Notice('Aethergraph diagnostics\n\n' + text, 0);
    return text;
  }

  async writeReport() {
    try {
      const ad = this.app.vault.adapter;
      if (!(await ad.exists(TEL.DIR))) await ad.mkdir(TEL.DIR);
      const d = new Date();
      const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0')
        + String(d.getDate()).padStart(2, '0') + '-'
        + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
      const path = `${TEL.DIR}/report-${stamp}-${this.tel.session}.md`;
      await ad.write(path, this.tel.report());
      this.tel.mark('report.write', { path });
      new Notice('Aethergraph: telemetry report written to ' + path, 6000);
      await this.app.workspace.openLinkText(path, '', false);
    } catch (e) {
      this.tel.err('report write', e);
      new Notice('Aethergraph: could not write the report — ' + e.message, 8000);
    }
  }
  async open() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    workspace.revealLeaf(leaf);
  }
  async save(s) { this.settings = Object.assign(this.settings, s); await this.saveData(this.settings); }
  async ensureDiagnosticSalt() {
    if (!this.settings.telemetrySalt) {
      this.settings.telemetrySalt = (this.tel && this.tel.salt) || randomSalt();
      await this.saveData(this.settings);
    }
    if (this.tel) this.tel.salt = this.settings.telemetrySalt;
  }
  onunload() {
    if (this.tel) { this.tel.mark('plugin.unload'); this.tel.flush(true); }
  }
};

class AetherSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'Aethergraph' });
    containerEl.createEl('p', { text: 'Authored note links work immediately. An optional validated v3 payload at '
      + `${PAYLOADS[0]} adds qualified semantic relations.` });
    const drop = (name, table, key) => new Setting(containerEl).setName(name).addDropdown(d => {
      Object.entries(table).forEach(([k, v]) => d.addOption(k, v));
      d.setValue(this.plugin.settings[key]);
      d.onChange(async v => { this.plugin.settings[key] = v; await this.plugin.saveData(this.plugin.settings); });
    });
    drop('Space', LAYOUTS, 'layout');
    drop('Tier by', TIERS, 'tierBy');
    drop('Angle by', ANGLE_MODES, 'angleBy');
    drop('Density', Object.fromEntries(Object.entries(DENSITY).map(([k, v]) => [k, v.label])), 'density');
    drop('Connections', CONNECTION_MODES, 'connectionMode');
    new Setting(containerEl).setName('Show enhanced private-local material')
      .setDesc('Applies to optional enhanced payload lanes; first-run authored-link data always stays local.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.showPrivate);
        t.onChange(async v => { this.plugin.settings.showPrivate = v; await this.plugin.saveData(this.plugin.settings); });
      });
    new Setting(containerEl).setName('Performance readout')
      .setDesc('Renderer, frame time, simulation cost and draw-call count in the status line.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.perf);
        t.onChange(async v => { this.plugin.settings.perf = v; await this.plugin.saveData(this.plugin.settings); });
      });

    containerEl.createEl('h3', { text: 'Local diagnostics' });
    const note = containerEl.createEl('p', { cls: 'setting-item-description' });
    note.appendText('Diagnostics are disabled by default and stay on this machine. Nothing is sent anywhere. ');
    note.appendText('Known privacy lanes use salted local pseudonyms; paths and titles are not recorded. ');
    note.appendText('Missing, unknown, and policy-marked notes are withheld entirely. Your filter text is never recorded — only '
      + 'its length and the number of hits.');

    new Setting(containerEl).setName('Write a log file')
      .setDesc(`Append JSONL to ${TEL.DIR}/ so evidence survives a crash. Rotates at 4 MB, `
        + `keeps the last ${TEL.KEEP_FILES} files. Off by default; nothing touches disk until you turn this on.`)
      .addToggle(t => {
        t.setValue(this.plugin.settings.telemetryFile);
        t.onChange(async v => {
          if (v) await this.plugin.ensureDiagnosticSalt();
          this.plugin.settings.telemetryFile = v;
          await this.plugin.saveData(this.plugin.settings);
          if (!v && this.plugin.tel) {
            await this.plugin.tel.flush(true);
            if (!this.plugin.tel.enabled) this.plugin.tel.reset();
          }
        });
      });

    new Setting(containerEl).setName('Console output')
      .setDesc('How much reaches the developer console. "Warnings" keeps errors visible without noise.')
      .addDropdown(d => {
        Object.entries(CONSOLE_LEVELS).forEach(([k, v]) => d.addOption(k, v));
        d.setValue(this.plugin.settings.telemetryConsole);
        d.onChange(async v => { this.plugin.settings.telemetryConsole = v; await this.plugin.saveData(this.plugin.settings); });
      });

    new Setting(containerEl).setName('Slow-frame threshold')
      .setDesc('A frame over this many milliseconds is captured with its full phase breakdown. '
        + '24 ms is about one and a half frames at 60 Hz.')
      .addSlider(sl => {
        sl.setLimits(8, 100, 2).setValue(this.plugin.settings.slowFrameMs).setDynamicTooltip();
        sl.onChange(async v => { this.plugin.settings.slowFrameMs = v; await this.plugin.saveData(this.plugin.settings); });
      });

    new Setting(containerEl).setName('Reset pseudonym salt')
      .setDesc('Breaks the link between hashed identities in old logs and new ones. '
        + 'Do this if a log ever leaves this machine.')
      .addButton(b => {
        b.setButtonText('Reset salt').setWarning();
        b.onClick(async () => {
          this.plugin.settings.telemetrySalt = randomSalt();
          await this.plugin.saveData(this.plugin.settings);
          if (this.plugin.tel) this.plugin.tel.salt = this.plugin.settings.telemetrySalt;
          new Notice('Aethergraph: salt reset — hashes in existing logs no longer correspond.');
        });
      });

    new Setting(containerEl).setName('Diagnostics')
      .setDesc('Check WebGL2, the payload, its age and schema, and the running view in one pass.')
      .addButton(b => { b.setButtonText('Run diagnostics'); b.onClick(() => this.plugin.diagnose()); });
  }
}

/* test surface: the harness drives these directly. Not used by Obsidian. */
module.exports.__gl = GL;
module.exports.__sanitize = sanitize;
module.exports.__defaults = DEFAULTS;
module.exports.__tables = { LAYOUTS, TIERS, ANGLE_MODES, DENSITY, CONNECTION_MODES, CONSOLE_LEVELS };
module.exports.__telemetry = { TEL, Ring, Chan, Telemetry, pseudonym, randomSalt };
module.exports.__relations = { EDGE, edgePresentation, edgeVisible, displayTitle, termNames, nodeTopics,
  nodeDisplayTags, nodeSubjects, nodeContexts, clipLabel, vocabLabel };
module.exports.__synthesis = { recallTokens, directRecallFit, modulateRecall, modulateRegions, regionSummary,
  validateNodeSynthesis, validateTopSynthesis };
module.exports.__payload = { PAYLOADS, PAYLOAD_LIMITS, validatePayload, readEnhancedPayload,
  buildBaselinePayload };
