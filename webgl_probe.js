/* SunnySlopes experimental WebGL2 probe.
 * Loaded BEFORE Godot, but instrumentation is completely inactive unless
 * the page is opened with ?glprobe=1. No getError() calls: doing so would
 * consume Godot's errors and can cause GPU synchronization.
 */
(function () {
  "use strict";
  var enabled = new URLSearchParams(location.search).get("glprobe") === "1";
  var noop = { enabled: false, explain: "Reload with ?glprobe=1", report: function () { console.info("[WebGLProbe] Enable with ?glprobe=1"); } };
  if (!enabled) { window.SunnyWebGLProbe = noop; return; }

  var perContext = new WeakMap();
  var bufferKind = new WeakMap();
  var bufferId = new WeakMap();
  var nextId = 1;
  var contexts = 0;
  var renderer = "unknown";
  var eventSamples = [];
  var MAX_EVENTS = 24;
  var counts = {};
  var period = {};
  var intervalFrames = [];
  var previousRaf = 0;
  var segment = "startup";
  var modeLabels = ["normal", "troop_icons_off", "info_panels_off", "borders_off", "all_provinces_off"];
  var modeIndex = 0;
  var initTime = performance.now();

  function add(name) { counts[name] = (counts[name] || 0) + 1; period[name] = (period[name] || 0) + 1; }
  function id(buffer) {
    if (!buffer) return "null";
    if (!bufferId.has(buffer)) bufferId.set(buffer, nextId++);
    return bufferId.get(buffer);
  }
  function getState(gl) {
    if (!perContext.has(gl)) perContext.set(gl, { array: null, element: null, defaultElement: null, vao: null, vaos: new WeakMap() });
    return perContext.get(gl);
  }
  function note(category, details, sample) {
    add(category);
    if (sample && eventSamples.length < MAX_EVENTS) {
      var ev = Object.assign({ category: category, ms_since_load: Math.round(performance.now() - initTime), segment: segment }, details);
      ev.stack = new Error("WebGL operation site").stack;
      eventSamples.push(ev);
      console.warn("[WebGLProbeEvent]", JSON.stringify(ev));
    }
  }
  function targetName(t) {
    return ({34962:"ARRAY_BUFFER",34963:"ELEMENT_ARRAY_BUFFER",35345:"UNIFORM_BUFFER",36662:"COPY_READ_BUFFER",36663:"COPY_WRITE_BUFFER",35982:"TRANSFORM_FEEDBACK_BUFFER",35051:"PIXEL_PACK_BUFFER",35052:"PIXEL_UNPACK_BUFFER"})[t] || String(t);
  }
  function monitorProto(proto) {
    if (!proto || Object.prototype.hasOwnProperty.call(proto, "__sunnyPatched")) return;
    Object.defineProperty(proto, "__sunnyPatched", { value: true });
    function wrap(name, after) {
      if (!Object.prototype.hasOwnProperty.call(proto, name) || typeof proto[name] !== "function") return;
      var original = proto[name];
      proto[name] = function () {
        var result = original.apply(this, arguments);
        try { after.call(this, arguments, result); } catch (e) { console.warn("[WebGLProbe] instrumentation error", String(e)); }
        return result;
      };
    }
    wrap("createBuffer", function (args, result) { add("createBuffer"); if (result) id(result); });
    wrap("deleteBuffer", function (args) { add("deleteBuffer"); });
    // Detect illegal target reuse without calling gl.getError() or altering GL state.
    // On failure the binding is unchanged; that makes the later bufferSubData fail too.
    wrap("bindBuffer", function (args) {
      add("bindBuffer");
      var target = args[0], buf = args[1], state = getState(this);
      var type = target === 34963 ? "index" : "other";
      if (buf) {
        var prior = bufferKind.get(buf);
        if (prior && prior !== type) {
          note("illegalBindTarget", {buffer:id(buf), prior:prior, attempted:targetName(target)}, true);
          return;
        }
        if (!prior) bufferKind.set(buf, type);
      }
      if (target === 34962) state.array = buf || null;
      else if (target === 34963) {
        state.element = buf || null;
        if (state.vao) state.vaos.set(state.vao, state.element);
        else state.defaultElement = state.element;
      }
    });
    wrap("bindVertexArray", function (args) {
      var state = getState(this);
      state.vao = args[0] || null;
      state.element = state.vao ? (state.vaos.get(state.vao) || null) : state.defaultElement;
      add("bindVertexArray");
    });
    wrap("bufferSubData", function (args) {
      add("bufferSubData");
      var t = args[0], state = getState(this);
      if ((t === 34963 && !state.element) || (t === 34962 && !state.array)) {
        note("unboundBufferSubData", {target:targetName(t)}, true);
      }
      var data = args[2];
      if (data && typeof data.byteLength === "number") add("bufferSubDataDataCall");
    });
    wrap("drawArrays", function () { add("drawArrays"); });
    wrap("drawElements", function () { add("drawElements"); });
    wrap("drawArraysInstanced", function () { add("drawArraysInstanced"); });
    wrap("drawElementsInstanced", function () { add("drawElementsInstanced"); });
  }

  if (typeof WebGLRenderingContext !== "undefined") monitorProto(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== "undefined") monitorProto(WebGL2RenderingContext.prototype);

  var originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (name) {
    var result = originalGetContext.apply(this, arguments);
    if (result && /^(webgl|webgl2|experimental-webgl)$/i.test(name)) {
      if (!perContext.has(result)) {
        contexts++;
        getState(result);
        try {
          var ext = result.getExtension("WEBGL_debug_renderer_info");
          renderer = ext ? String(result.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "masked";
        } catch (e) { renderer = "unavailable"; }
        add("webglContexts");
        console.info("[WebGLProbe] context", name, "GPU:", renderer);
      }
    }
    return result;
  };

  function raf(t) {
    if (previousRaf > 0 && t - previousRaf < 5000) {
      intervalFrames.push(t - previousRaf);
      if (intervalFrames.length > 300) intervalFrames.shift();
    }
    previousRaf = t;
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  function timing() {
    if (!intervalFrames.length) return { samples:0 };
    var s = intervalFrames.slice().sort(function (a,b) { return a-b; });
    var total = intervalFrames.reduce(function(a,b){return a+b;},0);
    return { samples:s.length, mean_ms: +(total/s.length).toFixed(2), p95_ms:+s[Math.ceil(s.length*0.95)-1].toFixed(2) };
  }
  function report() {
    var snapshot = {
      source:"browser_WebGL2_JS", elapsed_s:Math.round((performance.now()-initTime)/1000),
      segment:segment, contexts:contexts, renderer:renderer, raf:timing(),
      period_ops:Object.assign({},period), total_ops:Object.assign({},counts),
      error_samples:eventSamples.length
    };
    console.info("[WebGLProbe]", JSON.stringify(snapshot));
    period = {};
    return snapshot;
  }
  window.addEventListener("keydown", function (event) {
    if (event.key === "F8" && !event.repeat) {
      modeIndex = (modeIndex+1) % modeLabels.length;
      segment = modeLabels[modeIndex];
      period = {};
      intervalFrames = [];
      console.info("[WebGLProbe] F8 test segment", segment);
    }
  }, true);
  window.addEventListener("webglcontextlost", function (e) { note("contextLost",{target:String(e.target && e.target.id)},true); }, true);
  window.addEventListener("webglcontextrestored", function (e) { add("contextRestored"); }, true);

  window.SunnyWebGLProbe = {
    enabled:true,
    mark:function(label) { segment=String(label); period={}; intervalFrames=[]; console.info("[WebGLProbe] MARK",segment); },
    reset:function() { counts={}; period={}; eventSamples=[]; intervalFrames=[]; initTime=performance.now(); console.info("[WebGLProbe] Reset"); },
    report:report,
    dump:function() { var full={latest:report(),events:eventSamples.slice()}; console.info("[WebGLProbeDump]",JSON.stringify(full)); return JSON.stringify(full,null,2); }
  };
  setInterval(report,7000);
  console.info("[WebGLProbe] ACTIVE (?glprobe=1). Use SunnyWebGLProbe.dump() in console; F8 aligns with Godot visibility A/B.");
})();