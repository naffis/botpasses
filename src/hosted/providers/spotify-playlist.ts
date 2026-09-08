/**
 * Spotify Feb 2026 playlist content rename: `/v1/playlists/{id}/tracks` → `/items`.
 * Applied only for `api.spotify.com` playlist-id content endpoints (GET/POST/PUT/DELETE).
 * Other `/tracks` paths (saved tracks, album tracks, catalog) are left alone.
 */

const SPOTIFY_API_HOST = "api.spotify.com";
const CONTENT_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
/** `/v1/playlists/{playlistId}/tracks` with an optional trailing slash. Query is stripped first. */
const PLAYLIST_TRACKS = /^\/v1\/playlists\/([^/]+)\/tracks\/?$/;

export type SpotifyPlaylistRewrite = {
  path: string;
  body: unknown;
  requested_path: string;
  rewritten_path: string;
  body_key_mapped: boolean;
};

function pathAndQuery(raw: string): { pathname: string; query: string } {
  const q = raw.indexOf("?");
  return q === -1 ? { pathname: raw, query: "" } : { pathname: raw.slice(0, q), query: raw.slice(q) };
}

function asJsonObject(body: unknown): Record<string, unknown> | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** DELETE body: Spotify renamed the `tracks` array key to `items`. Leave a body that already has `items`. */
function mapDeleteTracksKey(body: unknown): { body: unknown; mapped: boolean } {
  const rec = asJsonObject(body);
  if (!rec || rec.tracks === undefined) return { body, mapped: false };
  if (rec.items !== undefined) return { body, mapped: false };
  const { tracks, ...rest } = rec;
  return { body: { ...rest, items: tracks }, mapped: true };
}

/**
 * When `host`/`method`/`path` is a Spotify playlist content call on the legacy `/tracks`
 * segment, return the `/items` path (query preserved) and, on DELETE, a body with `items`
 * instead of `tracks`. Undefined means send the request as given.
 */
export function rewriteSpotifyPlaylistTracks(input: {
  host: string;
  method: string;
  path: string;
  body?: unknown;
}): SpotifyPlaylistRewrite | undefined {
  if (input.host.toLowerCase() !== SPOTIFY_API_HOST) return undefined;
  const method = input.method.toUpperCase();
  if (!CONTENT_METHODS.has(method)) return undefined;
  const { pathname, query } = pathAndQuery(input.path);
  const match = PLAYLIST_TRACKS.exec(pathname);
  if (!match) return undefined;
  const playlistId = match[1];
  if (!playlistId) return undefined;
  const rewrittenPath = `/v1/playlists/${playlistId}/items${query}`;
  const mapped = method === "DELETE" ? mapDeleteTracksKey(input.body) : { body: input.body, mapped: false };
  return {
    path: rewrittenPath,
    body: mapped.body,
    requested_path: `${pathname}${query}`,
    rewritten_path: rewrittenPath,
    body_key_mapped: mapped.mapped,
  };
}

/** Public result fields the model may see. No secrets. */
export type PlaylistRewritePublic = {
  path_rewritten: true;
  requested_path: string;
  rewritten_path: string;
  body_key_mapped?: "tracks->items";
};

export function playlistRewriteFields(rewrite: SpotifyPlaylistRewrite | undefined): PlaylistRewritePublic | undefined {
  if (!rewrite) return undefined;
  return {
    path_rewritten: true,
    requested_path: rewrite.requested_path,
    rewritten_path: rewrite.rewritten_path,
    ...(rewrite.body_key_mapped ? { body_key_mapped: "tracks->items" as const } : {}),
  };
}
