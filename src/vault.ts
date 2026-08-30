import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_HOME_DIRNAME } from "./brand.ts";
import { decrypt, encrypt, generateMasterKey, keyFingerprint, parseMasterKey } from "./crypto.ts";
import {
  findOpenGrant,
  getGrant,
  getMeta,
  getSecretEnvelope,
  insertAudit,
  insertGrant,
  listAudit,
  listGrants,
  listSecretMeta,
  nowIso,
  openDb,
  setMeta,
  updateGrant,
  upsertSecret,
} from "./db.ts";
import { last4, normalizeActorId, normalizeSecretName, parseTtlSeconds } from "./ids.ts";
import { assertSafePublicObject } from "./redact.ts";
import type {
  AuditRecord,
  GrantRecord,
  GrantScope,
  RunResult,
  SecretBinding,
  SecretMeta,
} from "./types.ts";
import type { DatabaseSync } from "node:sqlite";

const DEFAULT_SESSION_TTL = 8 * 3600;
const MAX_SECRET_BYTES = 64 * 1024;

export type VaultOptions = {
  home: string;
  masterKey: Buffer;
  actor?: string;
};

export class Vault {
  readonly home: string;
  readonly actor: string;
  readonly fingerprint: string;
  #db: DatabaseSync;
  #key: Buffer;

  constructor(opts: VaultOptions) {
    this.home = opts.home;
    this.actor = opts.actor ?? defaultActor();
    this.#key = opts.masterKey;
    this.fingerprint = keyFingerprint(opts.masterKey);
    this.#db = openDb(opts.home);
    const stored = getMeta(this.#db, "key_fingerprint");
    if (!stored) {
      setMeta(this.#db, "key_fingerprint", this.fingerprint);
    } else if (stored !== this.fingerprint) {
      throw new Error(
        "Master key fingerprint does not match this vault. Check VAULT_MASTER_KEY.",
      );
    }
  }

  close(): void {
    this.#db.close();
  }

  setSecret(name: string, value: string): SecretMeta {
    const secretName = normalizeSecretName(name);
    if (value.length === 0) throw new Error("Secret value must not be empty");
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw new Error("Secret value exceeds 64KiB");
    }
    const envelope = encrypt(value, this.#key);
    const meta = upsertSecret(this.#db, {
      name: secretName,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      tag: envelope.tag,
      last4: last4(value),
      at: nowIso(),
    });
    this.#audit("store", { secretName });
    const publicMeta = { ...meta };
    assertSafePublicObject("setSecret", publicMeta);
    return publicMeta;
  }

  listSecrets(): SecretMeta[] {
    const rows = listSecretMeta(this.#db);
    assertSafePublicObject("listSecrets", rows);
    return rows;
  }

  requestGrant(input: {
    secretName: string;
    agentId: string;
    toolId: string;
    scope?: GrantScope;
    ttl?: string;
    actor?: string;
  }): GrantRecord {
    const secretName = normalizeSecretName(input.secretName);
    const agentId = normalizeActorId(input.agentId, "agent");
    const toolId = normalizeActorId(input.toolId, "tool");
    this.#requireSecret(secretName);
    const existing = this.#refresh(findOpenGrant(this.#db, secretName, agentId, toolId));
    if (existing) {
      this.#audit("request_grant", { secretName, agentId, toolId, actor: input.actor });
      return existing;
    }
    const scope = input.scope ?? "once";
    const at = nowIso();
    const grant: GrantRecord = {
      id: `grt_${randomUUID()}`,
      secretName,
      agentId,
      toolId,
      scope,
      status: "pending",
      expiresAt: scope === "session" ? expiryIso(input.ttl) : null,
      createdAt: at,
      approvedAt: null,
      revokedAt: null,
    };
    insertGrant(this.#db, grant);
    this.#audit("request_grant", { secretName, agentId, toolId, actor: input.actor });
    assertSafePublicObject("requestGrant", grant);
    return grant;
  }

  approveGrant(input: {
    grantId?: string;
    secretName?: string;
    agentId: string;
    toolId: string;
    scope?: GrantScope;
    ttl?: string;
    actor?: string;
  }): GrantRecord {
    const agentId = normalizeActorId(input.agentId, "agent");
    const toolId = normalizeActorId(input.toolId, "tool");
    const scope = input.scope ?? "once";
    let grant: GrantRecord | undefined;
    if (input.grantId) {
      grant = this.#refresh(getGrant(this.#db, input.grantId));
      if (!grant) throw new Error(`Unknown grant ${input.grantId}`);
    } else if (input.secretName) {
      const secretName = normalizeSecretName(input.secretName);
      this.#requireSecret(secretName);
      grant = this.#refresh(findOpenGrant(this.#db, secretName, agentId, toolId));
      if (!grant) {
        const at = nowIso();
        grant = {
          id: `grt_${randomUUID()}`,
          secretName,
          agentId,
          toolId,
          scope,
          status: "pending",
          expiresAt: scope === "session" ? expiryIso(input.ttl) : null,
          createdAt: at,
          approvedAt: null,
          revokedAt: null,
        };
        insertGrant(this.#db, grant);
      }
    } else {
      throw new Error("approveGrant requires grantId or secretName");
    }

    if (grant.status === "active") return grant;
    if (grant.status !== "pending") {
      throw new Error(`Grant ${grant.id} cannot be approved from status ${grant.status}`);
    }
    if (grant.agentId !== agentId || grant.toolId !== toolId) {
      throw new Error("Grant agent/tool does not match approval");
    }

    const at = nowIso();
    const expiresAt = scope === "session" ? expiryIso(input.ttl) : null;
    updateGrant(this.#db, grant.id, {
      status: "active",
      scope,
      expiresAt,
      approvedAt: at,
    });
    this.#audit("grant", {
      secretName: grant.secretName,
      agentId,
      toolId,
      actor: input.actor,
    });
    const approved = getGrant(this.#db, grant.id)!;
    assertSafePublicObject("approveGrant", approved);
    return approved;
  }

  revokeGrant(input: {
    grantId?: string;
    secretName?: string;
    agentId?: string;
    toolId?: string;
    actor?: string;
  }): GrantRecord[] {
    const targets: GrantRecord[] = [];
    if (input.grantId) {
      const grant = this.#refresh(getGrant(this.#db, input.grantId));
      if (!grant) throw new Error(`Unknown grant ${input.grantId}`);
      targets.push(grant);
    } else if (input.secretName && input.agentId && input.toolId) {
      const open = this.#refresh(
        findOpenGrant(
          this.#db,
          normalizeSecretName(input.secretName),
          normalizeActorId(input.agentId, "agent"),
          normalizeActorId(input.toolId, "tool"),
        ),
      );
      if (open) targets.push(open);
    } else {
      throw new Error("revokeGrant requires grantId or secretName+agentId+toolId");
    }

    const at = nowIso();
    const revoked: GrantRecord[] = [];
    for (const grant of targets) {
      if (grant.status === "revoked" || grant.status === "consumed" || grant.status === "expired") {
        revoked.push(grant);
        continue;
      }
      updateGrant(this.#db, grant.id, { status: "revoked", revokedAt: at });
      this.#audit("revoke", {
        secretName: grant.secretName,
        agentId: grant.agentId,
        toolId: grant.toolId,
        actor: input.actor,
      });
      revoked.push(getGrant(this.#db, grant.id)!);
    }
    assertSafePublicObject("revokeGrant", revoked);
    return revoked;
  }

  listGrants(): GrantRecord[] {
    const rows = listGrants(this.#db).map((g) => this.#refresh(g) ?? g);
    assertSafePublicObject("listGrants", rows);
    return rows;
  }

  listAudit(limit = 200): AuditRecord[] {
    const rows = listAudit(this.#db, limit);
    assertSafePublicObject("listAudit", rows);
    return rows;
  }

  /**
   * Decrypts granted secrets in-process and sets them on a child env.
   * The only API that ever holds plaintext after store. Does not print values.
   */
  async runWithSecrets(input: {
    bindings: SecretBinding[];
    agentId: string;
    toolId: string;
    command: string[];
    cwd?: string;
    inheritStdio?: boolean;
  }): Promise<RunResult> {
    if (input.command.length === 0) throw new Error("run requires a command after --");
    const agentId = normalizeActorId(input.agentId, "agent");
    const toolId = normalizeActorId(input.toolId, "tool");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.VAULT_MASTER_KEY;

    const plains: string[] = [];
    try {
      for (const binding of input.bindings) {
        const secretName = normalizeSecretName(binding.secretName);
        const grant = this.#refresh(findOpenGrant(this.#db, secretName, agentId, toolId));
        if (!grant || grant.status !== "active") {
          this.#audit("inject_denied", { secretName, agentId, toolId });
          throw new Error(
            `No active grant for secret ${secretName} to tool ${toolId} (agent ${agentId})`,
          );
        }
        const value = this.#decryptSecret(secretName);
        plains.push(value);
        env[binding.envName ?? secretName] = value;
        this.#audit("inject", { secretName, agentId, toolId, actor: agentId });
        if (grant.scope === "once") {
          updateGrant(this.#db, grant.id, { status: "consumed", revokedAt: nowIso() });
        }
      }

      return await spawnChild(input.command, {
        env,
        cwd: input.cwd,
        inheritStdio: input.inheritStdio ?? false,
      });
    } finally {
      plains.length = 0;
      for (const binding of input.bindings) {
        const key = binding.envName ?? normalizeSecretName(binding.secretName);
        if (env[key]) env[key] = "";
      }
    }
  }

  #decryptSecret(name: string): string {
    const row = getSecretEnvelope(this.#db, name);
    if (!row) throw new Error(`Unknown secret ${name}`);
    try {
      return decrypt(
        { iv: row.iv, ciphertext: row.ciphertext, tag: row.tag },
        this.#key,
      );
    } catch {
      throw new Error(`Failed to decrypt secret ${name}. Check VAULT_MASTER_KEY.`);
    }
  }

  #requireSecret(name: string): void {
    if (!getSecretEnvelope(this.#db, name)) {
      throw new Error(`Unknown secret ${name}`);
    }
  }

  #refresh(grant: GrantRecord | undefined): GrantRecord | undefined {
    if (!grant) return undefined;
    if (grant.status === "active" && grant.expiresAt && grant.expiresAt <= nowIso()) {
      updateGrant(this.#db, grant.id, { status: "expired" });
      return getGrant(this.#db, grant.id);
    }
    return grant;
  }

  #audit(
    action: AuditRecord["action"],
    parts: {
      secretName?: string;
      agentId?: string;
      toolId?: string;
      actor?: string;
    },
  ): void {
    insertAudit(this.#db, {
      id: `aud_${randomUUID()}`,
      action,
      actor: parts.actor ?? this.actor,
      secretName: parts.secretName ?? null,
      agentId: parts.agentId ?? null,
      toolId: parts.toolId ?? null,
      at: nowIso(),
    });
  }
}

export function defaultActor(): string {
  return process.env.VAULT_ACTOR || process.env.USER || process.env.LOGNAME || "operator";
}

export function defaultHome(): string {
  return process.env.VAULT_HOME || join(process.env.HOME || process.cwd(), DEFAULT_HOME_DIRNAME);
}

export function loadMasterKey(home: string): { key: Buffer; source: string } {
  if (process.env.VAULT_MASTER_KEY) {
    return { key: parseMasterKey(process.env.VAULT_MASTER_KEY), source: "env" };
  }
  const keyPath = join(home, "master.key");
  if (existsSync(keyPath)) {
    return { key: parseMasterKey(readFileSync(keyPath, "utf8")), source: "file" };
  }
  throw new Error(
    "No master key. Set VAULT_MASTER_KEY or run `vault init` to write master.key under VAULT_HOME.",
  );
}

export function initVaultHome(home: string): {
  home: string;
  keySource: string;
  fingerprint: string;
  generatedKey?: string;
} {
  const keyPath = join(home, "master.key");
  let key: Buffer;
  let keySource: string;
  let generatedKey: string | undefined;
  if (process.env.VAULT_MASTER_KEY) {
    key = parseMasterKey(process.env.VAULT_MASTER_KEY);
    keySource = "env";
  } else if (existsSync(keyPath)) {
    key = parseMasterKey(readFileSync(keyPath, "utf8"));
    keySource = "file";
  } else {
    generatedKey = generateMasterKey();
    writeFileSync(keyPath, `${generatedKey}\n`, { mode: 0o600 });
    key = parseMasterKey(generatedKey);
    keySource = "generated";
  }
  const vault = new Vault({ home, masterKey: key });
  const fingerprint = vault.fingerprint;
  vault.close();
  return { home, keySource, fingerprint, generatedKey };
}

export function openVaultFromEnv(home = defaultHome()): Vault {
  const { key } = loadMasterKey(home);
  return new Vault({ home, masterKey: key });
}

function expiryIso(ttl: string | undefined): string {
  const seconds = parseTtlSeconds(ttl, DEFAULT_SESSION_TTL);
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function spawnChild(
  command: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; inheritStdio: boolean },
): Promise<RunResult> {
  const [bin, ...args] = command;
  if (!bin) throw new Error("run requires a command after --");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: opts.inheritStdio ? "inherit" : "pipe",
    });
    let stdout = "";
    let stderr = "";
    if (!opts.inheritStdio) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
