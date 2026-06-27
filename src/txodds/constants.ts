export const TXODDS_BASE_URL = "https://txline-dev.txodds.com";

export const ENDPOINTS = {
  authGuestStart: `${TXODDS_BASE_URL}/auth/guest/start`,
  scoresStream: `${TXODDS_BASE_URL}/api/scores/stream`,
  oddsStream: `${TXODDS_BASE_URL}/api/odds/stream`,
  fixturesSnapshot: `${TXODDS_BASE_URL}/api/fixtures/snapshot`,
  oddsSnapshot: (fixtureId: number) => `${TXODDS_BASE_URL}/api/odds/snapshot/${fixtureId}`,
  scoresSnapshot: (fixtureId: number) => `${TXODDS_BASE_URL}/api/scores/snapshot/${fixtureId}`,
  scoresHistorical: (fixtureId: number) => `${TXODDS_BASE_URL}/api/scores/historical/${fixtureId}`,
};
