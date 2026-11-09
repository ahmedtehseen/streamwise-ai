import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

function ownerTokenDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyMcpOwnerAccess(request: Request): boolean {
  const configuredToken = process.env.MCP_OWNER_TOKEN;
  if (
    !configuredToken ||
    configuredToken.length < 32 ||
    /\s/.test(configuredToken) ||
    configuredToken === process.env.ADMIN_SECRET
  ) return false;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) return false;

  return timingSafeEqual(ownerTokenDigest(match[1]), ownerTokenDigest(configuredToken));
}
