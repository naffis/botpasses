/**
 * Humanised activity rows. The audit log stores enum actions; operators read sentences.
 * Pure so node tests can cover every action the kernel writes.
 */

export type ActivityInput = {
  action: string;
  actor: string;
  itemName: string | null;
  clientId: string | null;
};

export type ActivityNames = {
  /** client id -> display name */
  clientName: (id: string | null) => string;
};

/** Sentence for one audit row. Unknown actions fall back to the raw enum, never blank. */
export function describeActivity(row: ActivityInput, names: ActivityNames): string {
  const agent = row.clientId ? names.clientName(row.clientId) : "";
  const cred = row.itemName ?? "";
  const who = agent || "An agent";
  switch (row.action) {
    case "store":
      return cred ? `Stored ${cred}` : "Stored a credential";
    case "rotate":
      return cred ? `Rotated ${cred}` : "Rotated a credential";
    case "delete":
      return cred ? `Deleted ${cred}` : "Deleted a credential";
    case "request_grant":
      return cred ? `${who} requested ${cred}` : `${who} requested a credential`;
    case "grant":
      return cred ? `Approved ${agent || "an agent"} for ${cred}` : `Approved ${agent || "an agent"}`;
    case "revoke":
      return cred ? `Revoked ${agent || "an agent"} for ${cred}` : `Revoked an approval${agent ? ` for ${agent}` : ""}`;
    case "inject":
      return cred ? `${who} used ${cred}` : `${who} used a credential`;
    case "notify_failed":
      return cred ? `Email notice failed for ${cred}` : "Email notice failed";
    case "need_created":
      return cred ? `${who} asked for ${cred} to be stored` : `${who} asked for a credential to be stored`;
    case "need_fulfilled":
      return cred ? `Stored ${cred} for ${agent || "an agent"}` : "Stored a requested credential";
    case "need_denied":
      return cred ? `Denied ${who}'s request for ${cred}` : `Denied ${who}'s request`;
    case "connect_requested":
      return cred ? `${who} asked for an account to be connected as ${cred}` : `${who} asked for an account to be connected`;
    case "provider_connected":
      return cred ? `Connected an account as ${cred}` : "Connected an account";
    case "token_issued":
      return agent ? `Token issued to ${agent}` : "Token issued";
    case "client_rotate":
      return agent ? `Token rotated for ${agent}` : "Token rotated";
    case "client_revoked":
      return agent ? `Access revoked for ${agent}` : "Agent access revoked";
    case "token_revoked":
      return agent ? `OAuth token revoked for ${agent}` : "OAuth token revoked";
    case "session_created":
      return "You signed in";
    default:
      return row.action.replace(/_/g, " ");
  }
}

export const ACTIVITY_PAGE_SIZE = 50;

/** Client-side paging over the 200-row server cap. */
export function pageOf<T>(rows: T[], page: number, size: number = ACTIVITY_PAGE_SIZE): { rows: T[]; hasMore: boolean } {
  const end = (page + 1) * size;
  return { rows: rows.slice(0, end), hasMore: rows.length > end };
}
