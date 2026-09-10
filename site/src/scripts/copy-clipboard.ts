import { promptById, type BootstrapPromptId } from "../lib/bootstrap-prompts.ts";

const COPIED_MS = 2000;

function isPromptId(value: string): value is BootstrapPromptId {
  switch (value) {
    case "hosted":
    case "local":
    case "self-host":
    case "first-api":
    case "second-agent":
    case "staging":
    case "grok-redirect":
      return true;
    default:
      return false;
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function flashLabel(btn: HTMLButtonElement, idle: string, next: string): void {
  btn.textContent = next;
  window.setTimeout(() => {
    if (btn.isConnected) btn.textContent = idle;
  }, COPIED_MS);
}

async function copyAndLabel(btn: HTMLButtonElement, text: string, idle: string): Promise<void> {
  const ok = await writeClipboard(text);
  flashLabel(btn, idle, ok ? "Copied" : "Copy failed");
}

/** One-click copy for homepage and docs cards (`data-copy-prompt="<id>"`). */
export function bindCopyButtons(root: ParentNode = document): void {
  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-copy-prompt]")) {
    if (btn.dataset.copyBound === "1") continue;
    const id = btn.dataset.copyPrompt ?? "";
    if (!isPromptId(id)) continue;
    btn.dataset.copyBound = "1";
    const idle = btn.textContent?.trim() || "Copy prompt";
    btn.addEventListener("click", () => {
      void copyAndLabel(btn, promptById(id).text, idle);
    });
  }
}

/** Adds a Copy control to each `<pre>` so docs fences are one click. */
export function bindCopyPres(root: ParentNode = document): void {
  for (const pre of root.querySelectorAll<HTMLPreElement>("pre")) {
    if (pre.parentElement?.classList.contains("copy-pre")) continue;
    const parent = pre.parentNode;
    if (!parent) continue;
    const wrap = document.createElement("div");
    wrap.className = "copy-pre";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn copy-pre-btn";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code");
    parent.insertBefore(wrap, pre);
    wrap.append(pre, btn);
    btn.addEventListener("click", () => {
      void copyAndLabel(btn, pre.textContent ?? "", "Copy");
    });
  }
}

export function bindSiteCopy(root: ParentNode = document): void {
  bindCopyButtons(root);
  bindCopyPres(root);
}
