import { ENDPOINTS, TXODDS_BASE_URL } from "./constants";
import { logger } from "../utils/logger";

export interface AuthTokens {
  jwt: string;
  apiToken: string;
}

export async function getGuestJwt(): Promise<string> {
  const res = await fetch(ENDPOINTS.authGuestStart, { method: "POST", headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`Guest auth failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { token: string };
  logger.info("auth", "Obtained guest JWT");
  return body.token;
}

export async function activateToken(
  jwt: string,
  txSignature: string,
  walletSignature: string,
  leagues: number[]
): Promise<string> {
  const res = await fetch(`${TXODDS_BASE_URL}/api/token/activate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ txSig: txSignature, walletSignature, leagues }),
  });
  if (!res.ok) throw new Error(`Token activation failed: ${res.status}`);
  const body = (await res.json()) as { apiToken: string };
  logger.info("auth", "API token activated");
  return body.apiToken;
}
