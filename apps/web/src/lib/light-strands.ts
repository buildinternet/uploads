// Stream geometry and pulse rendering from the uploads.sh Flow lab.
// https://uploads-flow-lab.zachdunn.chatgpt.site — screenshot configuration.
const cfg = {
  count: 16,
  spread: 0.45,
  drift: 0.3,
  speed: 0.7,
  glow: 1.45,
  width: 1.7,
  length: 0.15,
  depth: 0.45,
  pointer: true,
  reverse: false,
  colors: ["#ff737b", "#ffac5e", "#ffdd8a", "#e579c8", "#cc88ff", "#fa9853"],
};

export function mountLightStrands(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  const ctx = context;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let paused = reducedMotion.matches;
  let t = 0,
    pulseTime = 0,
    last = 0,
    w = 1,
    h = 1,
    mx = 0,
    my = 0,
    px = 0,
    py = 0,
    raf = 0;
  function point(u: number, i: number): [number, number, number] {
    const n = i / (cfg.count - 1) - 0.5,
      phase = i * 2.39996,
      z = Math.sin(phase) * cfg.depth;
    let x, y;
    const wave =
      Math.sin(u * 6 + phase + t * 0.26) * 0.018 + Math.sin(u * 3.5 - phase + t * 0.17) * 0.014;
    const sway = Math.sin(t * 0.22 + phase) * 0.016;
    x = -0.35 + 1.7 * u;
    y =
      0.82 -
      0.86 * Math.pow(u, 3) +
      n * 0.22 * cfg.spread +
      Math.sin(u * 6 + phase * 0.14) * 0.09 * cfg.spread +
      wave +
      sway;
    x += (cfg.pointer ? px : 0) * z * 0.025;
    y += z * 0.035 + (cfg.pointer ? py : 0) * z * 0.04;
    return [x * w, y * h, 1 + z * 0.3];
  }
  function trace(points: [number, number, number][], start = 0, end = points.length - 1) {
    ctx.beginPath();
    ctx.moveTo(points[start][0], points[start][1]);
    for (let k = start + 1; k <= end; k++) ctx.lineTo(points[k][0], points[k][1]);
  }
  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 0.05) || 0;
    last = now;
    if (!paused) {
      t += dt * cfg.drift;
      pulseTime += dt * cfg.speed * (cfg.reverse ? -1 : 1);
    }
    px += (mx - px) * 0.045;
    py += (my - py) * 0.045;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < cfg.count; i++) {
      const color = cfg.colors[i % cfg.colors.length],
        points: [number, number, number][] = [];
      for (let k = 0; k <= 150; k++) points.push(point(k / 150, i));
      const weight = cfg.width * points[75][2];
      ctx.strokeStyle = color;
      ctx.shadowBlur = 0;
      if (cfg.glow > 0) {
        ctx.globalAlpha = 0.028 * cfg.glow;
        ctx.lineWidth = weight + 10 * cfg.glow;
        trace(points);
        ctx.stroke();
        ctx.globalAlpha = 0.065 * cfg.glow;
        ctx.lineWidth = weight + 3.5 * cfg.glow;
        ctx.stroke();
      }
      ctx.globalAlpha = 0.38;
      ctx.lineWidth = weight;
      trace(points);
      ctx.stroke();
      for (let p = 0; p < 2; p++) {
        let pos = (((pulseTime * (0.07 + (i % 5) * 0.008) + i * 0.618 + p * 0.5) % 1) + 1) % 1;
        const a = Math.max(0, Math.floor((pos - cfg.length) * 150)),
          b = Math.min(150, Math.ceil((pos + cfg.length * 0.45) * 150));
        if (b <= a) continue;
        const before = point(pos - cfg.length, i),
          after = point(pos + cfg.length * 0.45, i);
        let gradient = ctx.createLinearGradient(before[0], before[1], after[0], after[1]);
        gradient.addColorStop(0, "transparent");
        gradient.addColorStop(0.64, color);
        gradient.addColorStop(0.77, "#ffffff");
        gradient.addColorStop(1, "transparent");
        ctx.strokeStyle = gradient;
        trace(points, a, b);
        if (cfg.glow > 0) {
          ctx.globalAlpha = 0.15 * cfg.glow;
          ctx.lineWidth = weight + 12 * cfg.glow;
          ctx.stroke();
          ctx.globalAlpha = 0.25 * cfg.glow;
          ctx.lineWidth = weight + 4 * cfg.glow;
          ctx.stroke();
        }
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = weight * 1.35;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (!paused && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function restart() {
    cancelAnimationFrame(raf);
    last = performance.now();
    if (!document.hidden) frame(last);
  }
  const resize = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    restart();
  });
  function pointerMove(event: PointerEvent) {
    if (paused || event.pointerType === "touch") return;
    const rect = canvas.getBoundingClientRect();
    mx = (event.clientX - rect.left) / w - 0.5;
    my = (event.clientY - rect.top) / h - 0.5;
  }
  function pointerLeave() {
    mx = 0;
    my = 0;
  }
  function motionChange() {
    paused = reducedMotion.matches;
    if (paused) {
      mx = 0;
      my = 0;
      px = 0;
      py = 0;
    }
    restart();
  }
  resize.observe(canvas);
  window.addEventListener("pointermove", pointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", pointerLeave);
  document.addEventListener("visibilitychange", restart);
  reducedMotion.addEventListener("change", motionChange);
  return () => {
    cancelAnimationFrame(raf);
    resize.disconnect();
    window.removeEventListener("pointermove", pointerMove);
    document.documentElement.removeEventListener("pointerleave", pointerLeave);
    document.removeEventListener("visibilitychange", restart);
    reducedMotion.removeEventListener("change", motionChange);
  };
}
