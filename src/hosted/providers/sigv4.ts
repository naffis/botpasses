/**
 * AWS Signature Version 4 (https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html).
 * Access key id is the item username, the secret access key is the item value. Region and
 * service are read from the host, never from the model.
 */
import { createHmac } from "node:crypto";
import { sha256Hex } from "../../ids.ts";
import { HttpError } from "../errors.ts";

export type AwsTarget = { service: string; region: string };

const AWS_SUFFIX = ".amazonaws.com";

/**
 * `<service>.<region>.amazonaws.com`, with any number of leading labels (a bucket or API id):
 * the two labels right before `amazonaws.com` are service and region. Global endpoints such as
 * `iam.amazonaws.com` are refused; the caller must use a regional host.
 */
export function parseAwsHost(host: string): AwsTarget | undefined {
  const h = host.toLowerCase();
  if (!h.endsWith(AWS_SUFFIX)) return undefined;
  const labels = h.slice(0, -AWS_SUFFIX.length).split(".");
  const region = labels[labels.length - 1];
  const service = labels[labels.length - 2];
  if (!region || !service) return undefined;
  return { service, region };
}

/** Code-point order, as SigV4 requires (localeCompare would apply locale rules). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 unreserved set only, as AWS requires (encodeURIComponent leaves !'()* alone). */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Query pairs decoded and re-encoded per RFC 3986, sorted by name then value. A parameter with
 * no `=` is sent as `name=`.
 */
export function canonicalQuery(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return "";
  const pairs = raw
    .split("&")
    .filter((p) => p.length > 0)
    .map((p) => {
      const eq = p.indexOf("=");
      const k = eq === -1 ? p : p.slice(0, eq);
      const v = eq === -1 ? "" : p.slice(eq + 1);
      return [awsUriEncode(safeDecode(k)), awsUriEncode(safeDecode(v))] as const;
    });
  pairs.sort((a, b) => (a[0] === b[0] ? byCodePoint(a[1], b[1]) : byCodePoint(a[0], b[0])));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Path part of the canonical request. The input is the path as it will be sent (already
 * URL-encoded). S3 signs it once (as-is); every other service signs each segment encoded again.
 */
export function canonicalUri(pathname: string, service: string): string {
  const path = pathname || "/";
  if (service === "s3") return path;
  return path.split("/").map(awsUriEncode).join("/");
}

/** Time in the `YYYYMMDD'T'HHMMSS'Z'` form SigV4 uses. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export type SignV4Input = {
  accessKeyId: string;
  secretAccessKey: string;
  method: string;
  /** Path plus optional query string, as it will be sent on the wire. */
  path: string;
  /** Headers to sign. Must include `host`; names are lowercased by the signer. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  amzDate: string;
};

/**
 * The Authorization header value for one request. Pure: every input is explicit so a test can
 * replay the published AWS test vectors.
 */
export function signV4(input: SignV4Input): { authorization: string; canonicalRequest: string; stringToSign: string } {
  const [pathname = "/", ...rest] = input.path.split("?");
  const search = rest.join("?");
  const entries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => byCodePoint(a[0], b[0]));
  const signedHeaders = entries.map(([k]) => k).join(";");
  const canonicalHeaders = entries.map(([k, v]) => `${k}:${v}\n`).join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(pathname, input.service),
    canonicalQuery(search),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalRequest,
    stringToSign,
  };
}

/**
 * Headers the connector adds for a `sigv4` item: `authorization`, `x-amz-date`, and
 * `x-amz-content-sha256` (required by S3, accepted everywhere). `content-type` is signed when
 * the request carries one. The Host header is signed as the hostname (fetchPinned sends it so).
 */
export function sigv4Headers(input: {
  accessKeyId: string;
  secretAccessKey: string;
  method: string;
  host: string;
  path: string;
  body?: string;
  contentType?: string;
  now: Date;
}): Record<string, string> {
  const target = parseAwsHost(input.host);
  if (!target) {
    throw new HttpError(400, `sigv4 needs a regional AWS host (<service>.<region>.amazonaws.com), got ${input.host}`, {
      status: "inject_denied",
    });
  }
  if (!input.accessKeyId) {
    throw new HttpError(400, "sigv4 items need the access key id in username", { status: "inject_denied" });
  }
  const date = amzDate(input.now);
  const payloadHash = sha256Hex(input.body ?? "");
  const toSign: Record<string, string> = {
    host: input.host.toLowerCase(),
    "x-amz-date": date,
    "x-amz-content-sha256": payloadHash,
  };
  if (input.contentType) toSign["content-type"] = input.contentType;
  const signed = signV4({
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    method: input.method,
    path: input.path,
    headers: toSign,
    payloadHash,
    region: target.region,
    service: target.service,
    amzDate: date,
  });
  return {
    authorization: signed.authorization,
    "x-amz-date": date,
    "x-amz-content-sha256": payloadHash,
  };
}
