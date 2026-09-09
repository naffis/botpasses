import { nextHeroIndex, parseHeroServices } from "../lib/hero-services.ts";

const HOLD_MS = 2400;
const FADE_MS = 220;

export function startHeroRotate(root: ParentNode = document): () => void {
  const el = root.querySelector<HTMLElement>("[data-hero-rotate]");
  const word = el?.querySelector<HTMLElement>(".hero-rotate-word");
  if (!el || !word) return () => {};

  const names = parseHeroServices(el.dataset.heroRotate ?? "");
  if (names.length < 2) return () => {};
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};

  let index = Math.max(0, names.indexOf(word.textContent?.trim() ?? ""));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fading = false;
  let paused = false;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const showNext = (): void => {
    fading = false;
    el.classList.remove("is-leaving");
    index = nextHeroIndex(index, names.length);
    word.textContent = names[index] ?? names[0] ?? "";
    schedule();
  };

  const tick = (): void => {
    if (paused || document.hidden) {
      schedule();
      return;
    }
    fading = true;
    el.classList.add("is-leaving");
    timer = setTimeout(showNext, FADE_MS);
  };

  const schedule = (): void => {
    clearTimer();
    timer = setTimeout(tick, HOLD_MS);
  };

  const onVisibility = (): void => {
    if (document.hidden) {
      clearTimer();
      if (fading) showNext();
      return;
    }
    schedule();
  };

  const onEnter = (): void => {
    paused = true;
  };
  const onLeave = (): void => {
    paused = false;
  };

  el.addEventListener("mouseenter", onEnter);
  el.addEventListener("mouseleave", onLeave);
  document.addEventListener("visibilitychange", onVisibility);
  schedule();

  return () => {
    clearTimer();
    el.removeEventListener("mouseenter", onEnter);
    el.removeEventListener("mouseleave", onLeave);
    document.removeEventListener("visibilitychange", onVisibility);
    el.classList.remove("is-leaving");
  };
}
