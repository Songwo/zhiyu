import { useEffect, useRef, useState } from "react";

/** Read live so a mid-session OS toggle takes effect without a reload. */
export function reduceMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keep an overlay mounted through its exit transition.
 *
 * `mounted` gates rendering; `shown` drives the `data-shown` attribute the
 * `.anim-*` classes key off. Two frames pass between mount and `shown` so the
 * browser paints the closed state first — one frame is not always enough once
 * the panel also has to lay out.
 */
export function usePresence(open: boolean, exitMs = 170) {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (reduceMotion()) {
        setShown(true);
        return;
      }
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), reduceMotion() ? 0 : exitMs);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);

  return { mounted, shown };
}

/**
 * Ease a number toward `value`. Starts at zero on mount so headline figures
 * count up on first paint; server and first client render both emit 0, so
 * hydration still matches.
 */
export function useCountUp(value: number, ms = 800): number {
  const [n, setN] = useState(0);
  const from = useRef(0);

  useEffect(() => {
    if (reduceMotion()) {
      from.current = value;
      setN(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = requestAnimationFrame(function step(now: number) {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = a + (value - a) * eased;
      setN(next);
      from.current = next;
      if (p < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);

  return n;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * FLIP a panel between the rectangle a card occupies on screen and the
 * rectangle the panel lays out into.
 *
 * The scale is uniform (width ratio) rather than per-axis: a non-uniform scale
 * squashes the text inside, and the opacity ramp hides the small aspect
 * difference anyway. Returns the closed-state transform so the exit can reuse
 * it against a freshly measured card.
 */
export function flipTransform(from: Rect, to: DOMRect): string {
  const scale = Math.min(1, Math.max(0.15, from.w / Math.max(1, to.width)));
  const dx = from.x + from.w / 2 - (to.left + to.width / 2);
  const dy = from.y + from.h / 2 - (to.top + to.height / 2);
  return `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
}

/** The live rectangle of the card an expanded panel came from, if still on screen. */
export function cardRect(id: string): Rect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(`[data-asset-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * 景深卡片：指针在宿主区域内移动时，按位置给元素写入轻微的三维倾角与高光坐标。
 * 只写 CSS 变量，由样式里的 transform 消费；减少动态效果时不做任何事。
 */
export function useTilt(ref: { current: HTMLElement | null }, maxDeg = 4) {
  useEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host || reduceMotion()) return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = host.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width - 0.5;
        const y = (event.clientY - box.top) / box.height - 0.5;
        el.style.setProperty("--tilt-x", `${(-y * maxDeg).toFixed(2)}deg`);
        el.style.setProperty("--tilt-y", `${(x * maxDeg).toFixed(2)}deg`);
        el.style.setProperty("--glare-x", `${((x + 0.5) * 100).toFixed(1)}%`);
        el.style.setProperty("--glare-y", `${((y + 0.5) * 100).toFixed(1)}%`);
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      el.style.setProperty("--tilt-x", "0deg");
      el.style.setProperty("--tilt-y", "0deg");
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, [ref, maxDeg]);
}
