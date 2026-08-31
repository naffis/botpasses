import type {
  ApprovalChallengeRecord,
  ClientRecord,
  EnvironmentRecord,
  FolderRecord,
  HostedAuditRecord,
  HostedGrantRecord,
  ItemRecord,
  MemberRecord,
  NeedItemRecord,
  OrgRecord,
  PersistFulfillInput,
  PolicyRecord,
  VaultRecord,
} from "../hosted-types.ts";

export type VaultStore = {
  ping(): Promise<void>;
  close(): Promise<void>;

  insertOrg(row: OrgRecord): Promise<void>;
  getOrg(id: string): Promise<OrgRecord | undefined>;
  deleteOrg(orgId: string): Promise<void>;

  insertMember(row: MemberRecord): Promise<void>;
  getMember(orgId: string, userId: string): Promise<MemberRecord | undefined>;

  insertVault(row: VaultRecord): Promise<void>;
  listVaults(orgId: string): Promise<VaultRecord[]>;

  insertEnvironment(row: EnvironmentRecord): Promise<void>;
  getEnvironment(id: string): Promise<EnvironmentRecord | undefined>;
  getEnvironmentByName(vaultId: string, name: string): Promise<EnvironmentRecord | undefined>;
  listEnvironments(vaultId: string): Promise<EnvironmentRecord[]>;

  insertFolder(row: FolderRecord): Promise<void>;
  getFolder(id: string): Promise<FolderRecord | undefined>;
  getFolderByName(environmentId: string, name: string): Promise<FolderRecord | undefined>;

  insertItem(row: ItemRecord): Promise<void>;
  updateItemEnvelope(
    id: string,
    patch: Pick<ItemRecord, "iv" | "ciphertext" | "tag" | "last4" | "updatedAt">,
  ): Promise<void>;
  deleteItem(id: string): Promise<void>;
  getItem(id: string): Promise<ItemRecord | undefined>;
  getItemByName(environmentId: string, name: string): Promise<ItemRecord | undefined>;
  listItems(environmentId: string): Promise<ItemRecord[]>;
  countProductionItems(orgId: string): Promise<number>;

  insertClient(row: ClientRecord): Promise<void>;
  getClient(id: string): Promise<ClientRecord | undefined>;
  getClientByHashedSecret(orgId: string, hashedSecret: string): Promise<ClientRecord | undefined>;
  findClientByHashedSecret(hashedSecret: string): Promise<ClientRecord | undefined>;
  listClients(orgId: string): Promise<ClientRecord[]>;

  insertPolicy(row: PolicyRecord): Promise<void>;
  deletePolicy(id: string): Promise<void>;
  findItemPolicy(orgId: string, clientId: string, itemId: string): Promise<PolicyRecord | undefined>;
  findFolderPolicy(
    orgId: string,
    clientId: string,
    folderId: string | null,
    environmentId: string,
  ): Promise<PolicyRecord | undefined>;
  listPoliciesForClient(orgId: string, clientId: string): Promise<PolicyRecord[]>;

  insertGrant(row: HostedGrantRecord): Promise<void>;
  getGrant(id: string): Promise<HostedGrantRecord | undefined>;
  listGrants(orgId: string): Promise<HostedGrantRecord[]>;
  listPendingGrants(orgId: string): Promise<HostedGrantRecord[]>;
  updateGrant(row: HostedGrantRecord): Promise<void>;
  consumeGrant(id: string, consumedAt: string): Promise<boolean>;

  insertChallenge(row: ApprovalChallengeRecord): Promise<void>;
  getChallenge(id: string): Promise<ApprovalChallengeRecord | undefined>;
  getChallengeByGrant(grantId: string): Promise<ApprovalChallengeRecord | undefined>;
  getChallengeByGrantKind(
    grantId: string,
    kind: ApprovalChallengeRecord["kind"],
  ): Promise<ApprovalChallengeRecord | undefined>;
  updateChallenge(row: ApprovalChallengeRecord): Promise<void>;
  deleteChallenge(id: string): Promise<void>;

  insertAudit(row: HostedAuditRecord): Promise<void>;
  listAudit(orgId: string, limit?: number): Promise<HostedAuditRecord[]>;

  insertPendingNeed(row: NeedItemRecord): Promise<NeedItemRecord>;
  getNeed(id: string): Promise<NeedItemRecord | undefined>;
  getPendingNeed(input: {
    orgId: string;
    clientId: string;
    environmentId: string;
    suggestedName: string;
    host: string;
  }): Promise<NeedItemRecord | undefined>;
  listPendingNeeds(orgId: string): Promise<NeedItemRecord[]>;
  cancelNeed(id: string): Promise<void>;
  refreshNeedExpires(id: string, expiresAt: string): Promise<void>;
  persistFulfill(input: PersistFulfillInput): Promise<void>;

  insertAgentPass(row: {
    id: string;
    orgId: string;
    status: string;
    holderCnf: string | null;
    scopeJson: string;
    taskId: string | null;
    createdAt: string;
    consumedAt: string | null;
  }): Promise<void>;
  getAgentPass(id: string): Promise<
    | {
        id: string;
        orgId: string;
        status: string;
        holderCnf: string | null;
        scopeJson: string;
        taskId: string | null;
        createdAt: string;
        consumedAt: string | null;
      }
    | undefined
  >;
  updateAgentPassStatus(id: string, status: string): Promise<void>;
  consumeAgentPass(id: string, consumedAt: string): Promise<boolean>;
  listAgentPasses(orgId: string): Promise<
    {
      id: string;
      orgId: string;
      status: string;
      holderCnf: string | null;
      scopeJson: string;
      taskId: string | null;
      createdAt: string;
      consumedAt: string | null;
    }[]
  >;
};
