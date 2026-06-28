import { EventEmitter } from "events";
import { ENDPOINTS } from "./constants";
import { logger } from "../utils/logger";
import type { ScoreEvent, RawScorePayload, SoccerStatus, PossessionType } from "./types";

const STATUS_MAP: Record<number, SoccerStatus> = {
  1: "H1", 2: "HT", 3: "H2", 4: "H2", 5: "F",
};

const POSSESSION_MAP: Record<string, PossessionType> = {
  safe_possession: "SafePossession",
  attack_possession: "AttackPossession",
  danger_possession: "DangerPossession",
  high_danger_possession: "HighDangerPossession",
};

function mapScorePayload(raw: RawScorePayload): ScoreEvent {
  const action = raw.Action || "";
  const minutes = raw.Clock ? Math.floor(raw.Clock.Seconds / 60) : 0;
  const participant = raw.Participant || (raw.Data as any)?.Participant || 0;

  const isGoal = action === "goal";
  const isRedCard = action === "red_card";
  const isPenalty = action === "penalty";
  const isVAR = action === "var";
  const isYellowCard = action === "yellow_card";
  const isCorner = action === "corner";

  function safeTeam(team?: { Total?: Partial<{ Goals: number; YellowCards: number; RedCards: number; Corners: number }> }) {
    return { Total: { Goals: team?.Total?.Goals ?? 0, YellowCards: team?.Total?.YellowCards ?? 0, RedCards: team?.Total?.RedCards ?? 0, Corners: team?.Total?.Corners ?? 0 } };
  }

  return {
    fixtureId: raw.FixtureId,
    gameState: raw.GameState || action,
    statusSoccerId: STATUS_MAP[raw.StatusId || 0] || "NS",
    scoreSoccer: {
      Participant1: safeTeam(raw.Score?.Participant1),
      Participant2: safeTeam(raw.Score?.Participant2),
    },
    dataSoccer: (isGoal || isRedCard || isPenalty || isVAR || isYellowCard || isCorner) ? {
      Goal: isGoal,
      GoalType: (raw.Data?.GoalType as any) || "Other",
      Corner: isCorner,
      YellowCard: isYellowCard,
      RedCard: isRedCard,
      Penalty: isPenalty,
      VAR: isVAR,
      FreeKickType: "Safe",
      ThrowInType: "Safe",
      Minutes: minutes,
      Participant: participant,
      PlayerId: raw.Data?.PlayerId || 0,
    } : undefined,
    possessionType: POSSESSION_MAP[action],
    possession: POSSESSION_MAP[action] ? participant : undefined,
    parti1StateSoccer: raw.Parti1State?.PossibleEvent ? { PossibleEvent: { Goal: !!raw.Parti1State.PossibleEvent.Goal, Penalty: !!raw.Parti1State.PossibleEvent.Penalty, Corner: !!raw.Parti1State.PossibleEvent.Corner } } : undefined,
    parti2StateSoccer: raw.Parti2State?.PossibleEvent ? { PossibleEvent: { Goal: !!raw.Parti2State.PossibleEvent.Goal, Penalty: !!raw.Parti2State.PossibleEvent.Penalty, Corner: !!raw.Parti2State.PossibleEvent.Corner } } : undefined,
    ts: raw.Ts,
    seq: raw.Seq || 0,
  };
}

export interface ScoresStreamOptions {
  jwt: string;
  apiToken: string;
  fixtureId?: number;
}

export function createScoresStream(opts: ScoresStreamOptions): EventEmitter {
  const emitter = new EventEmitter();
  let stopped = false;
  let backoffMs = 3000;
  const MAX_BACKOFF = 60_000;

  async function connect() {
    const url = opts.fixtureId
      ? `${ENDPOINTS.scoresStream}?fixtureId=${opts.fixtureId}`
      : ENDPOINTS.scoresStream;

    logger.info("scores-stream", `Connecting to ${url}`);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${opts.jwt}`,
        "X-Api-Token": opts.apiToken,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        logger.error("scores-stream", "JWT expired (401) — stopping reconnect. Re-run setup.");
        stopped = true;
        emitter.emit("error", new Error("JWT expired"));
        return;
      }
      throw new Error(`Scores stream failed: ${response.status}`);
    }
    if (!response.body) throw new Error("No response body");

    backoffMs = 3000;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!stopped) {
      let timer: ReturnType<typeof setTimeout>;
      const readWithTimeout = Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("read timeout")), 90_000); }),
      ]).finally(() => clearTimeout(timer!));
      const { value, done } = await readWithTimeout;
      if (done) {
        logger.info("scores-stream", "Stream ended, reconnecting in 3s");
        if (!stopped) setTimeout(startWithReconnect, 3000);
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed.startsWith("data:")) {
          try {
            const raw = JSON.parse(trimmed.slice(5).trim()) as RawScorePayload;
            if (!raw.FixtureId) continue;
            emitter.emit("data", mapScorePayload(raw));
          } catch {
            // malformed, skip
          }
        }
      }
    }
  }

  function startWithReconnect() {
    if (stopped) return;
    connect().catch((err) => {
      logger.error("scores-stream", `Error, reconnecting in ${Math.round(backoffMs / 1000)}s: ${err.message}`);
      if (!stopped) {
        setTimeout(startWithReconnect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
      }
    });
  }

  startWithReconnect();

  (emitter as any).stop = () => {
    stopped = true;
  };

  return emitter;
}
