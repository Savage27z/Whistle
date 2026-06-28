import { ENDPOINTS } from "./constants";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import type { Fixture, RawFixture } from "./types";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.txoddsJwt}`,
    "X-Api-Token": config.txoddsApiToken,
    Accept: "application/json",
  };
}

export async function fetchFixtures(): Promise<Fixture[]> {
  const res = await fetch(ENDPOINTS.fixturesSnapshot, { headers: headers() });
  if (!res.ok) {
    logger.error("txodds-client", "Failed to fetch fixtures", { status: res.status });
    return [];
  }
  const body = (await res.json()) as RawFixture[];
  const raw = Array.isArray(body) ? body : [];
  return raw.map((f) => ({
    fixtureId: f.FixtureId,
    team1: f.Participant1,
    team2: f.Participant2,
    startTime: f.StartTime,
    leagueId: f.CompetitionId,
    leagueName: f.Competition,
  }));
}

export async function fetchOddsSnapshot(fixtureId: number): Promise<unknown> {
  const res = await fetch(ENDPOINTS.oddsSnapshot(fixtureId), { headers: headers() });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchScoresSnapshot(fixtureId: number): Promise<unknown> {
  const res = await fetch(ENDPOINTS.scoresSnapshot(fixtureId), { headers: headers() });
  if (!res.ok) return null;
  return res.json();
}
