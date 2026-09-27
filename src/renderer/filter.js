// Optional image filters for big screens, drawn with WebGL over the game
// canvas.
//
// The game canvas itself is untouched: the cores still draw into it at the
// console's own resolution, it still receives the mouse (the DS touch
// screen maps clicks against it), and "pixel" mode is still just the browser
// stretching it. The filters read that canvas as a texture and draw it at
// the window's real resolution into a second canvas on top, which ignores
// the mouse so clicks fall through.
//
// Why bother: a GBA screen is 240x160, and full screen on a 1080p monitor
// that is a 6.75x stretch. Nearest-neighbour can't do three quarters of a
// pixel, so some columns come out 6 screen pixels wide and others 7 -- a
// visible shimmer whenever the picture scrolls. Both filters fix that; the
// second also rounds off the staircase on diagonal edges.

const IMAGE_FILTERS = ['pixel', 'sharp', 'smooth'];

const gameCanvas = document.getElementById('screen');
const filterCanvas = document.getElementById('screen-gl');
const gl = filterCanvas.getContext('webgl2', { alpha: false, antialias: false });

let imageFilter = 'pixel';

const VERTEX_SHADER = `#version 300 es
out vec2 uv;
void main() {
  // One triangle that covers the viewport, no vertex buffer needed.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D source;
uniform vec2 sourceSize;  // the whole game canvas
uniform vec2 cellSize;    // one console screen: the DS canvas holds two
uniform float scale;      // screen pixels per console pixel
uniform int mode;         // 1 = sharp, 2 = smooth
in vec2 uv;
out vec4 color;

ivec2 cellMin;
ivec2 cellMax;

// Clamped to the console screen this fragment belongs to, so neither filter
// blends the bottom row of the DS's top screen into the bottom screen.
vec3 at(ivec2 texel) {
  return texelFetch(source, clamp(texel, cellMin, cellMax), 0).rgb;
}

// Sharp bilinear: every console pixel stays a solid square, and only the
// one screen pixel where a boundary falls between whole pixels is blended.
vec3 sharp(vec2 p) {
  float prescale = max(floor(scale), 1.0);
  vec2 offset = fract(p) - 0.5;
  vec2 region = vec2(0.5 - 0.5 / prescale);
  // Where to sample bilinearly, measured from texel centres.
  vec2 q = floor(p) + (offset - clamp(offset, -region, region)) * prescale;
  ivec2 i = ivec2(floor(q));
  vec2 t = q - floor(q);
  return mix(mix(at(i), at(i + ivec2(1, 0)), t.x),
             mix(at(i + ivec2(0, 1)), at(i + ivec2(1, 1)), t.x), t.y);
}

// Colour distance weighted the way the eye weighs it: brightness counts far
// more than hue.
float dist(vec3 a, vec3 b) {
  vec3 d = a - b;
  float y = dot(d, vec3(0.299, 0.587, 0.114));
  float u = dot(d, vec3(-0.169, -0.331, 0.5));
  float v = dot(d, vec3(0.5, -0.419, -0.081));
  return 48.0 * abs(y) + 7.0 * abs(u) + 6.0 * abs(v);
}

// The 5x5 neighbourhood, fetched once and shared by all four corners.
vec3 n[25];
vec3 near(ivec2 offset) { return n[(offset.y + 2) * 5 + offset.x + 2]; }

// How much of this screen pixel lies past an edge line, with a one-pixel
// soft border so the edge itself doesn't turn into a new staircase.
float past(vec2 local, vec2 normal) {
  float w = 0.5 * length(normal) / scale;
  return smoothstep(0.5 - w, 0.5 + w, dot(local, normal));
}

// xBR, level 2 (after Hyllian's algorithm): for each corner of the console
// pixel, decide from the surrounding pixels whether an edge runs across it
// -- at 45 degrees, or at the shallow and steep 2:1 slopes -- and if so,
// paint the part of the pixel beyond that edge in the neighbour's colour.
vec3 smoothed(vec2 p) {
  ivec2 center = ivec2(floor(p));
  for (int y = -2; y <= 2; y++)
    for (int x = -2; x <= 2; x++)
      n[(y + 2) * 5 + x + 2] = at(center + ivec2(x, y));

  vec2 offset = fract(p) - 0.5;
  vec3 e = near(ivec2(0, 0));
  vec3 result = e;

  for (int corner = 0; corner < 4; corner++) {
    // The rule is written for the bottom-right corner; the other three are
    // the same rule mirrored.
    ivec2 dir = ivec2((corner & 1) == 0 ? 1 : -1, (corner & 2) == 0 ? 1 : -1);
    vec2 local = offset * vec2(dir);

    vec3 f = near(ivec2(1, 0) * dir), h = near(ivec2(0, 1) * dir);
    vec3 i = near(ivec2(1, 1) * dir), b = near(ivec2(0, -1) * dir);
    vec3 d = near(ivec2(-1, 0) * dir), c = near(ivec2(1, -1) * dir);
    vec3 g = near(ivec2(-1, 1) * dir);
    vec3 f4 = near(ivec2(2, 0) * dir), h5 = near(ivec2(0, 2) * dir);
    vec3 i4 = near(ivec2(2, 1) * dir), i5 = near(ivec2(1, 2) * dir);

    // An edge runs between f and h when colours match better along it
    // than across it.
    float along = dist(e, c) + dist(e, g) + dist(i, h5) + dist(i, f4) + 4.0 * dist(h, f);
    float across = dist(h, d) + dist(h, i5) + dist(f, i4) + dist(f, b) + 4.0 * dist(e, i);
    bool edge = along < across && e != f && e != h
      // Keeps single-pixel details (a dot, the corner of a checkerboard)
      // from being rounded away.
      && (!(f == b && h == d) || (e == i && f != i4 && h != i5) || e == g || e == c);
    if (!edge) continue;

    float coverage = past(local, vec2(1.0, 1.0));
    if (2.0 * dist(f, g) <= dist(h, c) && e != g && d != g) {
      coverage = max(coverage, past(local, vec2(1.0, 2.0)));  // shallow
    }
    if (dist(f, g) >= 2.0 * dist(h, c) && e != c && b != c) {
      coverage = max(coverage, past(local, vec2(2.0, 1.0)));  // steep
    }
    vec3 neighbour = dist(e, f) <= dist(e, h) ? f : h;
    result = mix(result, neighbour, coverage);
  }
  return result;
}

void main() {
  vec2 p = uv * sourceSize;
  ivec2 cell = ivec2(floor(p / cellSize));
  cellMin = cell * ivec2(cellSize);
  cellMax = cellMin + ivec2(cellSize) - 1;
  color = vec4(mode == 2 ? smoothed(p) : sharp(p), 1.0);
}`;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

let uniforms = null;

if (gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  uniforms = Object.fromEntries(
    ['source', 'sourceSize', 'cellSize', 'scale', 'mode'].map((name) => [
      name,
      gl.getUniformLocation(program, name),
    ]),
  );
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  // Read with texelFetch, so filtering never applies; set anyway so the
  // texture counts as complete without mipmaps.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.useProgram(program);
  gl.uniform1i(uniforms.source, 0);
  // The page's own background, so the letterbox bars look the same as
  // without a filter.
  gl.clearColor(16 / 255, 16 / 255, 16 / 255, 1);
}

// Called after every frame is drawn, and whenever anything that affects the
// picture changes: the filter, the window size, a game starting or stopping.
function presentFrame() {
  const active = Boolean(gl) && imageFilter !== 'pixel' && !gameCanvas.hidden && Boolean(layout);
  filterCanvas.hidden = !active;
  if (!active) return;

  // The window's real pixels, not CSS pixels: on a 150% display there are
  // half as many again, and that resolution is the whole point.
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(filterCanvas.clientWidth * ratio);
  const height = Math.round(filterCanvas.clientHeight * ratio);
  if (filterCanvas.width !== width || filterCanvas.height !== height) {
    filterCanvas.width = width;
    filterCanvas.height = height;
  }

  // Letterboxed the way object-fit: contain does it for the game canvas
  // underneath, so a click lands where the picture shows it.
  const scale = Math.min(width / gameCanvas.width, height / gameCanvas.height);
  const drawnWidth = Math.round(gameCanvas.width * scale);
  const drawnHeight = Math.round(gameCanvas.height * scale);
  gl.viewport(0, 0, width, height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.viewport((width - drawnWidth) >> 1, (height - drawnHeight) >> 1, drawnWidth, drawnHeight);

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gameCanvas);
  gl.uniform2f(uniforms.sourceSize, gameCanvas.width, gameCanvas.height);
  gl.uniform2f(uniforms.cellSize, layout.screenWidth, layout.screenHeight);
  gl.uniform1f(uniforms.scale, scale);
  gl.uniform1i(uniforms.mode, imageFilter === 'smooth' ? 2 : 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Without WebGL2 (an old GPU, or a blocklisted driver) every filter falls
// back to plain pixels rather than failing.
function setImageFilter(name) {
  imageFilter = IMAGE_FILTERS.includes(name) ? name : 'pixel';
  presentFrame();
}

// Also redraws a paused game, which isn't producing frames of its own.
new ResizeObserver(() => presentFrame()).observe(filterCanvas);
