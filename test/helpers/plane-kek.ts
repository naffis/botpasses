import { generateMasterKey, parseMasterKey } from "../../src/crypto.ts";

/** One KEK per test process. Postgres identity fixtures each own an isolated schema. */
export const TEST_PLANE_KEK = parseMasterKey(generateMasterKey());
