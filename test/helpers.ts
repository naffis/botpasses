import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { Vault } from "../src/vault.ts";
import type { Io } from "../src/cli.ts";

export const CANARY = "sk_live_CANARY_do_not_leak_f47ac10b";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "agent-vault-"));
}

export function makeVault(home = tempHome()): { vault: Vault; home: string; keyHex: string } {
  const keyHex = generateMasterKey();
  const vault = new Vault({
    home,
    masterKey: parseMasterKey(keyHex),
    actor: "operator",
  });
  return { vault, home, keyHex };
}

export function captureIo(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    log: (...args) => stdout.push(args.map(String).join(" ")),
    error: (...args) => stderr.push(args.map(String).join(" ")),
    readStdin: async () => "",
  };
}

export function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

export class ChatTranscript {
  readonly events: { role: "operator" | "agent" | "runtime"; text: string }[] = [];

  add(role: "operator" | "agent" | "runtime", payload: unknown): void {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.events.push({ role, text });
  }

  serialize(): string {
    return this.events.map((e) => `[${e.role}] ${e.text}`).join("\n");
  }
}
