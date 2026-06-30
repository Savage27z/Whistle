import { EventEmitter } from "events";
import { ENDPOINTS } from "./constants";
import { logger } from "../utils/logger";
import type { ScoreEvent, RawScorePayload, SoccerStatus, PossessionType, StoppableEmitter } from "./types";

const STATUS_MAP: Record<number, SoccerStatus> = {
  1: "H1", 2: "HT", 3: "H2", 4: "H2", 5: "F", 6: "ET1", 7: "ET2", 8: "PE",
};

// Fallback only — real payloads carry PossessionType directly (see below).
const POSSESSION_MAP: Record<string, PossessionType> = {
  safe_possession: "SafePossession",
  attack_possession: "AttackPossession",
  danger_possession: "DangerPossession",
  high_danger_possession: "HighDangerPossession",
};

function mapScorePayload(raw: RawScorePayload): ScoreEvent {
  const action = raw.Action || "";
  const minute = raw.Clock ? Math.floor(raw.Clock.Seconds / 60) : 0;
  const participant = raw.Participant ?? raw.Data?.Participant ?? 0;

  const isGoal = action === "goal";
  const isRedCard = action === "red_card";
  const isPenalty = action === "penalty";
  const isVAR = action === "var";
  const isYellowCard = action === "yellow_card";
  const isCorner = action === "corner";

  // TxODDS sends sparse deltas, not full snapshots — most messages omit
  // Score/StatusId entirely. Only pass these through when actually present;
  // the caller must preserve prior state rather than treating absence as 0/NS.
  const statusSoccerId = raw.StatusId !== undefined ? STATUS_MAP[raw.StatusId] : undefined;
  const scoreSoccer = raw.Score
    ? { Participant1: raw.Score.Participant1, Participant2: raw.Score.Participant2 }
    : undefined;

  const possessionType = raw.PossessionType || POSSESSION_MAP[action];

  return {
    fixtureId: raw.FixtureId,
    gameState: raw.GameState || action,
    statusSoccerId,
    scoreSoccer,
    minute,
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
      Minutes: minute,
      Participant: participant,
      PlayerId: raw.Data?.PlayerId || 0,
    } : undefined,
    possessionType,
    possession: possessionType ? (raw.Possession ?? participant) : undefined,
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

export function createScoresStream(opts: ScoresStreamOptions): StoppableEmitter {
  const emitter = new EventEmitter() as StoppableEmitter;
  let stopped = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let backoffMs = 3000;
  const MAX_BACKOFF = 60_000;

  emitter.stop = () => {
    stopped = true;
    activeReader?.cancel().catch(() => {});
  };

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
    activeReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    while (!stopped) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const readWithTimeout = Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("read timeout")), 90_000); }),
      ]).finally(() => clearTimeout(timer));
      const { value, done } = await readWithTimeout.catch((err) => {
        // Timeout fired while reader.read() was still pending — abandon
        // this connection rather than leaving it open in the background.
        reader.cancel().catch(() => {});
        throw err;
      });
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

  return emitter;
}
