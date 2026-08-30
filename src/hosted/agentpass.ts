import { generateKeyPairSync, randomUUID } from "node:crypto";
import { HttpError } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";

export type AgentPassStatus = "pending" | "approved" | "consumed" | "denied";

type Jwks = { keys: Record<string, unknown>[] };

export class AgentPassAuthority {
  readonly #kernel: HostedKernel;
  readonly #publicUrl: string;
  readonly #privatePem: string;
  readonly #jwks: Jwks;

  constructor(kernel: HostedKernel, publicUrl: string) {
    this.#kernel = kernel;
    this.#publicUrl = publicUrl;
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.#jwks = { keys: [{ ...jwk, kid: "agentpass-v1", use: "sig", alg: "ES256" }] };
    void this.#privatePem;
  }

  configuration(): unknown {
    return {
      issuer: this.#publicUrl,
      jwks_uri: `${this.#publicUrl}/agentpass/jwks`,
      issuance_endpoint: `${this.#publicUrl}/agentpass/requests`,
      validate_endpoint: `${this.#publicUrl}/agentpass/validate`,
      authorization_check_endpoint: `${this.#publicUrl}/agentpass/authorization-check`,
    };
  }

  jwks(): Jwks {
    return this.#jwks;
  }

  async createRequest(input: {
    orgId: string;
    holderCnf: string;
    scope: string[];
    taskId?: string;
  }): Promise<{ id: string; status: AgentPassStatus }> {
    if (!input.holderCnf) throw new HttpError(400, "holder_cnf is required");
    const id = `ap_${randomUUID()}`;
    await this.#kernel.store.insertAgentPass({
      id,
      orgId: input.orgId,
      status: "pending",
      holderCnf: input.holderCnf,
      scopeJson: JSON.stringify(input.scope),
      taskId: input.taskId ?? null,
      createdAt: new Date().toISOString(),
      consumedAt: null,
    });
    return { id, status: "pending" };
  }

  async getRequest(orgId: string, id: string) {
    const row = await this.#kernel.store.getAgentPass(id);
    if (!row || row.orgId !== orgId) throw new HttpError(404, "Unknown AgentPass request");
    return {
      id: row.id,
      status: row.status,
      task_id: row.taskId,
      scope: JSON.parse(row.scopeJson) as unknown,
    };
  }

  async approve(orgId: string, id: string): Promise<void> {
    const row = await this.#kernel.store.getAgentPass(id);
    if (!row || row.orgId !== orgId) throw new HttpError(404, "Unknown AgentPass request");
    if (row.status !== "pending") throw new HttpError(409, "Not pending");
    await this.#kernel.store.updateAgentPassStatus(id, "approved");
  }

  async validate(input: {
    id: string;
    holderProof: unknown;
  }): Promise<{ active: boolean; scope: unknown }> {
    if (!input.holderProof || typeof input.holderProof !== "object") {
      throw new HttpError(401, "holder_proof is required");
    }
    const proof = input.holderProof as { cnf?: unknown };
    const row = await this.#kernel.store.getAgentPass(input.id);
    if (!row) throw new HttpError(404, "Unknown pass");
    if (typeof proof.cnf !== "string" || proof.cnf !== row.holderCnf) {
      throw new HttpError(401, "holder_proof does not match");
    }
    const ok = await this.#kernel.store.consumeAgentPass(input.id, new Date().toISOString());
    if (!ok) throw new HttpError(409, "Pass already consumed or not approved");
    return { active: true, scope: JSON.parse(row.scopeJson) as unknown };
  }

  async authorizationCheck(input: { id: string; holderProof: unknown }): Promise<{ allowed: boolean }> {
    if (!input.holderProof) throw new HttpError(401, "holder_proof is required");
    const row = await this.#kernel.store.getAgentPass(input.id);
    if (!row) return { allowed: false };
    const proof = input.holderProof as { cnf?: unknown };
    if (typeof proof.cnf !== "string" || proof.cnf !== row.holderCnf) {
      throw new HttpError(401, "holder_proof does not match");
    }
    return { allowed: row.status === "approved" || row.status === "pending" };
  }
}

export function agentPassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VAULT_AGENTPASS === "1";
}
