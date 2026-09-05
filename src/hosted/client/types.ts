/** JSON shapes the console reads. Snake_case mirrors the HTTP API; camelCase keys are legacy. */

export type ItemRow = {
  id: string;
  name: string;
  kind: string;
  last4: string;
  username: string | null;
  environment: string;
  inject: string;
  allowedHosts?: string[];
  allowed_hosts?: string[];
  created_at?: string;
  updated_at?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type InboxNeed = {
  id: string;
  /** `secret` (typed on the collect page) or `connect` (a provider account connected from the card). */
  kind?: string;
  suggested_name: string;
  host: string;
  client_id: string;
  client_name: string;
  task_description: string | null;
  collect_path: string | null;
  provider?: string | null;
  source_item_id?: string | null;
  source_item_name?: string | null;
  expires_at: string;
  created_at?: string;
};

export type InboxGrant = {
  id: string;
  status: string;
  policy: string;
  item_name: string | null;
  item_last4: string | null;
  client_name: string;
  task_description: string | null;
  created_at: string;
  approved_at: string | null;
  code_expires_at?: string;
};

export type AccessClient = {
  id: string;
  name: string;
  kind: string;
  environment: string;
  status: string;
  created_at: string | null;
  first_access_at: string | null;
  last_access_at: string | null;
  last_token_at: string | null;
  last_seen_at: string | null;
  fetched: string[];
  last4: string | null;
  consented_by_email: string | null;
};

export type AccessGrant = {
  id: string;
  item_name: string;
  client_id: string;
  client_name: string;
  status: string;
  created_at: string | null;
  first_access_at: string | null;
  last_access_at: string | null;
  approved_at: string | null;
  fetched: string[];
};

export type AccessSession = {
  id: string;
  created_at: string | null;
  first_access_at: string | null;
  last_access_at: string | null;
  last_seen_at: string | null;
  current: boolean;
};

export type AccessSnapshot = {
  clients: AccessClient[];
  grants: AccessGrant[];
  sessions: AccessSession[];
};

export type AuditRow = {
  id: string;
  action: string;
  actor: string;
  itemName: string | null;
  clientId: string | null;
  at: string;
};

export type AccountInfo = {
  email: string;
  totp_enabled: boolean;
  backup_codes_remaining: number;
  created_at: string;
};
