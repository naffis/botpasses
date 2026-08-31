export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { code?: unknown; message?: unknown };
  if (rec.code === "23505" || rec.code === "ERR_SQLITE_CONSTRAINT" || rec.code === 19) {
    return true;
  }
  return typeof rec.message === "string" && /unique/i.test(rec.message);
}
