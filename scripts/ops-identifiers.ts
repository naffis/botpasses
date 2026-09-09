/**
 * Shapes that must not appear in the public tree. Operator-only names live in
 * gitignored `.env.ops`. Patterns are structural so this file never names a
 * real project slug, Linear workspace, or home directory.
 */
export type OpsIdentifierKind = "home_path" | "linear_workspace_url" | "neon_project_slug";

export type OpsIdentifierHit = {
  kind: OpsIdentifierKind;
  match: string;
};

const HOME_PATH =
  /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//g;
const WINDOWS_HOME = /\\Users\\[A-Za-z0-9._-]+\\/g;
const LINEAR_WORKSPACE = /linear\.app\/[a-z0-9-]+\//gi;
// Neon console slugs are adjective-noun plus eight digits. Skip 20YYMMDD
// suffixes so restore-drill dates and dump stamps stay legal.
const NEON_PROJECT_SLUG = /\b[a-z]{3,}-[a-z]{3,}-(?!20\d{6}\b)\d{8}\b/g;

function collect(kind: OpsIdentifierKind, pattern: RegExp, text: string): OpsIdentifierHit[] {
  return [...text.matchAll(pattern)].map((row) => ({ kind, match: row[0] ?? "" }));
}

export function findOpsIdentifierHits(text: string): OpsIdentifierHit[] {
  return [
    ...collect("home_path", HOME_PATH, text),
    ...collect("home_path", WINDOWS_HOME, text),
    ...collect("linear_workspace_url", LINEAR_WORKSPACE, text),
    ...collect("neon_project_slug", NEON_PROJECT_SLUG, text),
  ];
}
