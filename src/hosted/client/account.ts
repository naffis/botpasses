/// <reference lib="dom" />
/** Account panel: sign-in facts, authenticator re-enroll, backup codes, sign out. */
import type { AccountInfo } from "./types.ts";
import {
  api,
  busy,
  byId,
  closeDialog,
  copyText,
  downloadText,
  errorMessage,
  flash,
  formatWhen,
  handleUnauthorized,
  html,
  isJson,
  loadErrorText,
  openDialog,
  render,
  setFormNotice,
  setHidden,
  showLoadError,
  text,
  timeHtml,
} from "./shared.ts";

const NOT_AVAILABLE = "This server does not expose account details yet.";

function isAccount(v: unknown): v is AccountInfo {
  return isJson(v) && typeof v.email === "string";
}

const PLAN_KINDS = ["credentials", "agents", "members", "calls"] as const;

function planNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Plan card on the Account panel: "used of limit" per kind, from `GET /api/plan`. */
export async function loadPlan(): Promise<void> {
  if (!byId("plan-card")) return;
  try {
    const r = await api("/api/plan");
    if (r.status === 404) {
      for (const kind of PLAN_KINDS) text(byId(`plan-${kind}`), "Unknown");
      return;
    }
    if (!r.ok) throw new Error(errorMessage(r, "Could not load plan usage"));
    const limits = isJson(r.body.limits) ? r.body.limits : {};
    const usage = isJson(r.body.usage) ? r.body.usage : {};
    for (const kind of PLAN_KINDS) {
      const used = planNumber(usage[kind]);
      const limit = planNumber(limits[kind]);
      const el = byId(`plan-${kind}`);
      if (!el) continue;
      if (used === undefined || limit === undefined) {
        text(el, "Unknown");
        continue;
      }
      text(el, `${used} of ${limit}`);
      el.classList.toggle("is-err", used >= limit);
    }
    const period = typeof r.body.period_start === "string" ? r.body.period_start : "";
    text(byId("plan-period"), period ? `Calls reset on the first of each month (since ${formatWhen(period)}).` : "");
  } catch (err) {
    for (const kind of PLAN_KINDS) text(byId(`plan-${kind}`), loadErrorText(err, "Unavailable"));
  }
}

export async function loadAccount(): Promise<void> {
  const card = byId("account-card");
  if (!card) return;
  setHidden("account-error", true);
  try {
    const r = await api("/api/auth/me");
    if (r.status === 401) {
      handleUnauthorized();
      return;
    }
    if (r.status === 404) {
      text(byId("account-email"), NOT_AVAILABLE);
      text(byId("account-totp"), "Unknown");
      text(byId("account-backups"), "Unknown");
      text(byId("account-created"), "Unknown");
      return;
    }
    if (!r.ok || !isAccount(r.body)) throw new Error(errorMessage(r, "Could not load your account"));
    const me = r.body;
    text(byId("account-email"), me.email);
    text(byId("account-totp"), me.totp_enabled ? "Enrolled" : "Not enrolled");
    text(byId("account-backups"), String(me.backup_codes_remaining));
    render(byId("account-created"), html`${timeHtml(me.created_at)} (${formatWhen(me.created_at)})`);
    void loadPlan();
  } catch (err) {
    showLoadError("account-error", loadErrorText(err, "Could not load your account"), () => {
      void loadAccount();
    });
  }
}

export async function signOut(): Promise<void> {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch {
    /* even offline, leave the console */
  }
  try {
    sessionStorage.removeItem("vault_op_token");
  } catch {
    /* storage may be blocked */
  }
  location.href = "/sign-in";
}

/** Ask for the current authenticator code, then run `submit` with it. Errors stay in the dialog. */
export function askForCode(lede: string, submit: (code: string) => Promise<string>): void {
  const form = byId<HTMLFormElement>("code-dialog-form");
  const input = byId<HTMLInputElement>("code-dialog-input");
  if (!form || !input) return;
  text(byId("code-dialog-lede"), lede);
  setFormNotice("code-dialog-error", "", true);
  input.value = "";
  const handler = (e: Event): void => {
    e.preventDefault();
    void busy(form, async () => {
      const problem = await submit(input.value.trim());
      if (problem) setFormNotice("code-dialog-error", problem, false);
      else {
        form.removeEventListener("submit", handler);
        closeDialog("code-dialog");
      }
    });
  };
  form.addEventListener("submit", handler);
  byId<HTMLDialogElement>("code-dialog")?.addEventListener("close", () => form.removeEventListener("submit", handler), { once: true });
  openDialog("code-dialog");
  input.focus();
}

function showBackupCodes(codes: string[]): void {
  const pre = byId("backup-codes");
  if (pre) pre.textContent = codes.join("\n");
  text(byId("backup-live"), `${codes.length} new backup codes are shown. Copy or download them now.`);
  const copy = byId<HTMLButtonElement>("backup-copy");
  const download = byId<HTMLButtonElement>("backup-download");
  copy?.addEventListener("click", () => copyText(codes.join("\n"), "Backup codes copied"), { once: true });
  download?.addEventListener("click", () => downloadText("botpasses-backup-codes.txt", `${codes.join("\n")}\n`), { once: true });
  openDialog("backup-dialog");
}

async function regenerate(code: string): Promise<string> {
  try {
    const r = await api("/api/auth/backup-codes/regenerate", { method: "POST", body: JSON.stringify({ code }) });
    if (r.status === 404) return "This server cannot regenerate backup codes yet.";
    if (!r.ok) return errorMessage(r, "Could not regenerate backup codes");
    const codes = Array.isArray(r.body.backup_codes) ? r.body.backup_codes.filter((c): c is string => typeof c === "string") : [];
    if (!codes.length) return "The server returned no codes.";
    showBackupCodes(codes);
    void loadAccount();
    return "";
  } catch (err) {
    return loadErrorText(err, "Could not regenerate backup codes");
  }
}

async function reenroll(code: string): Promise<string> {
  try {
    const r = await api("/api/auth/totp/start", { method: "POST", body: JSON.stringify({ current_code: code }) });
    if (r.status === 404) return "This server cannot re-enroll an authenticator yet.";
    if (!r.ok) return errorMessage(r, "Could not start re-enrollment");
    location.href = "/enroll-totp";
    return "";
  } catch (err) {
    return loadErrorText(err, "Could not start re-enrollment");
  }
}

export function bindAccount(): void {
  byId("account-signout")?.addEventListener("click", () => void signOut());
  byId("sign-out")?.addEventListener("click", () => void signOut());
  byId("account-regen")?.addEventListener("click", () => {
    askForCode("Enter your current authenticator code to replace every backup code.", regenerate);
  });
  byId("account-reenroll")?.addEventListener("click", () => {
    askForCode("Enter your current authenticator code. You will then scan a new QR code.", reenroll);
  });
  byId("backup-dialog")?.addEventListener("close", () => {
    flash("Backup codes are no longer shown. Regenerate them if you did not save them.", true);
  });
}
