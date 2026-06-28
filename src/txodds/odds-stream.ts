import { EventEmitter } from "events";
import { ENDPOINTS } from "./constants";
import { logger } from "../utils/logger";
import type { OddsUpdate, RawOddsPayload } from "./types";

function mapOddsPayload(raw: RawOddsPayload): OddsUpdate {
  return {
    fixtureId: raw.FixtureId,
    bookmakerId: raw.BookmakerId,
    bookmakerName: raw.Bookmaker,
    oddsType: raw.SuperOddsType,
    inRunning: raw.InRunning,
    priceNames: raw.PriceNames || [],
    prices: raw.Prices || [],
    ts: raw.Ts,
  };
}

export interface OddsStreamOptions {
  jwt: string;
  apiToken: string;
  fixtureId?: number;
}

export function createOddsStream(opts: OddsStreamOptions): EventEmitter {
  const emitter = new EventEmitter();
  let stopped = false;

  async function connect() {
    const url = opts.fixtureId
      ? `${ENDPOINTS.oddsStream}?fixtureId=${opts.fixtureId}`
      : ENDPOINTS.oddsStream;

    logger.info("odds-stream", `Connecting to ${url}`);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${opts.jwt}`,
        "X-Api-Token": opts.apiToken,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) throw new Error(`Odds stream failed: ${response.status}`);
    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) {
        logger.info("odds-stream", "Stream ended, reconnecting in 3s");
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
            const raw = JSON.parse(trimmed.slice(5).trim()) as RawOddsPayload;
            if (!raw.FixtureId) continue;
            emitter.emit("data", mapOddsPayload(raw));
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
      logger.error("odds-stream", `Error, reconnecting in 3s: ${err.message}`);
      if (!stopped) setTimeout(startWithReconnect, 3000);
    });
  }

  startWithReconnect();

  (emitter as any).stop = () => {
    stopped = true;
  };

  return emitter;
}
