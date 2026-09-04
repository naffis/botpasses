/// <reference lib="dom" />
/**
 * Team panel (under Account): members with roles, invite form, pending invites with a copyable
 * accept link, and the rail org switcher shown when the user belongs to more than one org.
 */
import {
  api,
  arr,
  busy,
  byId,
  copyText,
  errorMessage,
  flash,
  handleUnauthorized,
  html,
  isJson,
  loadErrorText,
  render,
  setFormNotice,
  setHidden,
  showLoadError,
  str,
  text,
  timeHtml,
} from "./shared.ts";

export type TeamMemberRow = { user_id: string; email: string; role: string; joined_at: string | null };
export type TeamInviteRow = {
  id: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
  expired: boolean;
  invited_by_email: string | null;
};
export type OrgRow = { org_id: string; name: string; role: string; active: boolean };

export type TeamHandlers = {
  onRemoveMember: (member: TeamMemberRow, run: () => Promise<{ ok: boolean; message: string }>) => void;
  onCancelInvite: (invite: TeamInviteRow, run: () => Promise<{ ok: boolean; message: string }>) => void;
};

export const TEAM_COPY = {
  title: "Team",
  lede: "Who can sign in to this workspace. Owners manage members and credentials; operators approve requests.",
};

/** `#account/team` (with an optional query) selects the Team panel inside the Account route. */
export function isTeamRoute(hash: string): boolean {
  const bare = (hash || "").replace(/^#/, "");
  const path = bare.split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  return parts[0] === "account" && parts[1] === "team";
}

const isTeamMember = (v: unknown): v is TeamMemberRow => isJson(v) && typeof v.user_id === "string" && typeof v.role === "string";
const isTeamInvite = (v: unknown): v is TeamInviteRow => isJson(v) && typeof v.id === "string" && typeof v.email === "string";
const isOrgRow = (v: unknown): v is OrgRow => isJson(v) && typeof v.org_id === "string" && typeof v.name === "string";

type TeamState = { members: TeamMemberRow[]; invites: TeamInviteRow[]; role: string; userId: string };

const teamState: TeamState = { members: [], invites: [], role: "operator", userId: "" };
let teamHandlers: TeamHandlers | undefined;

function ownerCount(): number {
  return teamState.members.filter((m) => m.role === "owner").length;
}

function renderMembers(): void {
  const list = byId("members-list");
  if (!list) return;
  const owner = teamState.role === "owner";
  render(
    list,
    html`${teamState.members.map((m) => {
      const lastOwner = m.role === "owner" && ownerCount() <= 1;
      const you = m.user_id === teamState.userId;
      return html`<article class="access-row" data-member="${m.user_id}">
        <div class="access-main">
          <strong>${m.email || m.user_id}</strong>${you ? html` <span class="pill pill-muted">you</span>` : ""}
          <p class="meta">${m.joined_at ? html`Joined ${timeHtml(m.joined_at)}` : "Joined before join dates were recorded"}</p>
        </div>
        <div class="access-actions">
          ${owner
            ? html`<label class="visually-hidden" for="role-${m.user_id}">Role for ${m.email}</label>
                <select id="role-${m.user_id}" data-role-for="${m.user_id}" ${lastOwner ? "disabled" : ""} title="${lastOwner ? "An org needs at least one owner" : "Change role"}">
                  <option value="owner" ${m.role === "owner" ? "selected" : ""}>owner</option>
                  <option value="operator" ${m.role === "operator" ? "selected" : ""}>operator</option>
                </select>
                <button type="button" class="btn-danger" data-remove-member="${m.user_id}" ${lastOwner ? "disabled" : ""} title="${lastOwner ? "The last owner cannot be removed" : "Remove from workspace"}">Remove</button>`
            : html`<span class="pill">${m.role}</span>`}
        </div>
      </article>`;
    })}`,
  );
}

function renderInvites(): void {
  const list = byId("invites-list");
  if (!list) return;
  setHidden("invites-empty", teamState.invites.length > 0);
  const owner = teamState.role === "owner";
  render(
    list,
    html`${teamState.invites.map(
      (inv) => html`<article class="access-row" data-invite="${inv.id}">
        <div class="access-main">
          <strong>${inv.email}</strong> <span class="pill">${inv.role}</span>
          ${inv.expired ? html`<span class="pill pill-warn">expired</span>` : ""}
          <p class="meta">Invited ${timeHtml(inv.created_at)}${inv.invited_by_email ? html` by ${inv.invited_by_email}` : ""}${inv.expired ? "" : html`, expires ${timeHtml(inv.expires_at)}`}</p>
        </div>
        <div class="access-actions">
          ${owner ? html`<button type="button" class="btn-ghost" data-cancel-invite="${inv.id}">Cancel</button>` : ""}
        </div>
      </article>`,
    )}`,
  );
}

export async function loadTeam(): Promise<void> {
  if (!byId("members-list")) return;
  setHidden("team-error", true);
  try {
    const r = await api("/api/members");
    if (r.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!r.ok) throw new Error(errorMessage(r, "Could not load the team"));
    teamState.members = arr(r.body.members, isTeamMember);
    teamState.invites = arr(r.body.invites, isTeamInvite);
    teamState.role = str(r.body.role, "operator");
    teamState.userId = str(r.body.user_id);
    setHidden("team-invite-card", teamState.role !== "owner");
    renderMembers();
    renderInvites();
  } catch (err) {
    showLoadError("team-error", loadErrorText(err, "Could not load the team"), () => {
      void loadTeam();
    });
  }
}

async function changeRole(userId: string, role: string, select: HTMLSelectElement): Promise<void> {
  try {
    const r = await api(`/api/members/${encodeURIComponent(userId)}/role`, { method: "POST", body: JSON.stringify({ role }) });
    if (!r.ok) {
      flash(errorMessage(r, "Could not change the role"), false);
      const prior = teamState.members.find((m) => m.user_id === userId);
      if (prior) select.value = prior.role;
      return;
    }
    flash(`Role updated to ${role}`, true);
    await loadTeam();
  } catch (err) {
    flash(loadErrorText(err, "Could not change the role"), false);
  }
}

async function deleteAction(url: string, fallback: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await api(url, { method: "DELETE" });
    return { ok: r.ok, message: r.ok ? "" : errorMessage(r, fallback) };
  } catch (err) {
    return { ok: false, message: loadErrorText(err, fallback) };
  }
}

function showInviteLink(url: string, emailSent: boolean, email: string): void {
  const link = byId("invite-link");
  if (link) link.textContent = url;
  setHidden("invite-result", false);
  text(
    byId("invite-result-note"),
    emailSent
      ? `Invite emailed to ${email}. You can also send this link yourself.`
      : `Email is not configured on this server. Send this link to ${email} yourself.`,
  );
  const copy = byId<HTMLButtonElement>("invite-copy");
  if (copy) copy.onclick = () => copyText(url, "Invite link copied");
}

function bindInviteForm(): void {
  const form = byId<HTMLFormElement>("invite");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const emailEl = form.elements.namedItem("email");
    const roleEl = form.elements.namedItem("role");
    const email = emailEl instanceof HTMLInputElement ? emailEl.value.trim() : "";
    const role = roleEl instanceof HTMLSelectElement ? roleEl.value : "operator";
    if (!email) {
      setFormNotice("invite-error", "Enter an email address.", false);
      return;
    }
    setFormNotice("invite-error", "", true);
    void busy(form, async () => {
      try {
        const r = await api("/api/members/invite", { method: "POST", body: JSON.stringify({ email, role }) });
        if (!r.ok) {
          setFormNotice("invite-error", errorMessage(r, "Could not send the invite"), false);
          return;
        }
        const url = str(r.body.accept_url);
        showInviteLink(url, r.body.email_sent === true, email);
        if (emailEl instanceof HTMLInputElement) emailEl.value = "";
        flash(`Invited ${email} as ${role}`, true);
        await loadTeam();
      } catch (err) {
        setFormNotice("invite-error", loadErrorText(err, "Could not send the invite"), false);
      }
    });
  });
}

export function bindTeam(handlers: TeamHandlers): void {
  teamHandlers = handlers;
  bindInviteForm();
  byId("members-list")?.addEventListener("change", (e) => {
    const select = e.target instanceof HTMLSelectElement ? e.target : null;
    const userId = select?.dataset.roleFor;
    if (!select || !userId) return;
    void changeRole(userId, select.value, select);
  });
  byId("members-list")?.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("[data-remove-member]") : null;
    const userId = btn?.dataset.removeMember;
    if (!userId) return;
    const member = teamState.members.find((m) => m.user_id === userId);
    if (!member) return;
    teamHandlers?.onRemoveMember(member, () => deleteAction(`/api/members/${encodeURIComponent(userId)}`, "Could not remove the member"));
  });
  byId("invites-list")?.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("[data-cancel-invite]") : null;
    const id = btn?.dataset.cancelInvite;
    if (!id) return;
    const invite = teamState.invites.find((i) => i.id === id);
    if (!invite) return;
    teamHandlers?.onCancelInvite(invite, () => deleteAction(`/api/invites/${encodeURIComponent(id)}`, "Could not cancel the invite"));
  });
}

/* ---------- org switcher ---------- */

export async function loadOrgs(): Promise<void> {
  const select = byId<HTMLSelectElement>("org-switcher");
  if (!select) return;
  try {
    const r = await api("/api/orgs");
    if (!r.ok) return;
    const orgs = arr(r.body.orgs, isOrgRow);
    setHidden("org-switch", orgs.length < 2);
    if (orgs.length < 2) return;
    render(
      select,
      html`${orgs.map((o) => html`<option value="${o.org_id}" ${o.active ? "selected" : ""}>${o.name} (${o.role})</option>`)}`,
    );
  } catch {
    setHidden("org-switch", true);
  }
}

export function bindOrgSwitcher(): void {
  const select = byId<HTMLSelectElement>("org-switcher");
  select?.addEventListener("change", () => {
    const orgId = select.value;
    if (!orgId) return;
    select.disabled = true;
    void (async () => {
      try {
        const r = await api("/api/session/org", { method: "POST", body: JSON.stringify({ org_id: orgId }) });
        if (!r.ok) {
          flash(errorMessage(r, "Could not switch workspace"), false);
          select.disabled = false;
          return;
        }
        location.href = "/console";
      } catch (err) {
        flash(loadErrorText(err, "Could not switch workspace"), false);
        select.disabled = false;
      }
    })();
  });
}
