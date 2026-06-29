import { config, validateConfig } from "./utils/config";
import { logger } from "./utils/logger";
import { createBot } from "./bot/bot";
import { OddsTracker } from "./engine/odds-tracker";
import { EventTracker } from "./engine/event-tracker";
import { DivergenceDetector, severityRank } from "./engine/divergence";
import type { DivergenceAlert } from "./engine/divergence";
import { narrateAlert, formatMatchEvent } from "./engine/narrator";
import { createScoresStream } from "./txodds/scores-stream";
import { createOddsStream } from "./txodds/odds-stream";
import type { StoppableEmitter } from "./txodds/types";
import { getSubscribersForFixture, getUserSettings, incrementAlertCount, logAlert, unsubscribeWatch, unsubscribeFixture } from "./db/queries";
import { fetchFixtures } from "./txodds/client";
import { getDb } from "./db/schema";
import type { Bot } from "grammy";
import http from "http";

const oddsTracker = new OddsTracker();
const eventTracker = new EventTracker();
const divergenceDetector = new DivergenceDetector();
divergenceDetector.setMatchStateResolver((id) => eventTracker.getMatchState(id));
const activeStreams = new Map<number, { scores: StoppableEmitter; odds: StoppableEmitter } | null>();
let globalStreamsStarted = false;
let globalScoresStream: StoppableEmitter | null = null;
let globalOddsStream: StoppableEmitter | null = null;

let bot: Bot;

const MAJOR_EVENTS = new Set(["goal", "red_card", "penalty", "var_review", "phase_change"]);

async function deliverAlert(alert: DivergenceAlert): Promise<void> {
  const matchState = eventTracker.getMatchState(alert.fixtureId);
  const market = (alert.data as any)?.market as string | undefined;
  let oddsSnapshot: { name: string; value: number; direction: "up" | "down" | "stable" }[] | undefined;
  if (market) {
    const [oddsType, ...outcomeparts] = market.split(":");
    const outcomeName = outcomeparts.join(":");
    if (oddsType && outcomeName) {
      oddsSnapshot = oddsTracker.getBookmakerSnapshot(alert.fixtureId, oddsType, outcomeName);
    }
  }
  const message = await narrateAlert(alert, matchState, oddsSnapshot);

  const subscribers = getSubscribersForFixture(alert.fixtureId);

  const sends = subscribers
    .filter((userId) => {
      const settings = getUserSettings(userId);
      return severityRank(alert.severity) >= severityRank(settings.minSeverity);
    })
    .map(async (userId) => {
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
        incrementAlertCount(userId, alert.fixtureId);
      } catch (err: any) {
        if (err?.error_code === 403) {
          logger.warn("delivery", `User ${userId} blocked bot — removing watch for fixture ${alert.fixtureId}`);
          unsubscribeWatch(userId, alert.fixtureId);
        } else {
          logger.error("delivery", `Failed to send to ${userId}: ${(err as Error).message}`);
        }
      }
    });
  await Promise.allSettled(sends);

  logAlert(alert.fixtureId, alert.type, alert.severity, alert.title, message, alert.data);
}

async function deliverMatchEvent(signal: import("./engine/event-tracker").EventSignal): Promise<void> {
  if (!MAJOR_EVENTS.has(signal.type)) return;
  const matchState = eventTracker.getMatchState(signal.fixtureId);
  if (!matchState) return;

  const message = formatMatchEvent(signal.type, matchState, {
    team: signal.team,
    minute: signal.minute,
    goalType: signal.goalType,
    newScore: signal.newScore,
    from: signal.from,
    to: signal.to,
  });

  const subscribers = getSubscribersForFixture(signal.fixtureId);
  await Promise.allSettled(subscribers.map(async (userId) => {
    try {
      await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
    } catch (err: any) {
      if (err?.error_code === 403) {
        logger.warn("delivery", `User ${userId} blocked bot — removing watch for fixture ${signal.fixtureId}`);
        unsubscribeWatch(userId, signal.fixtureId);
      } else {
        logger.error("delivery", `Failed to send event to ${userId}: ${(err as Error).message}`);
      }
    }
  }));
}

function stopStreamsForFixture(fixtureId: number): void {
  const streams = activeStreams.get(fixtureId);
  if (streams?.scores) {
    streams.scores.stop();
    streams.odds.stop();
  }
  if (activeStreams.has(fixtureId)) {
    activeStreams.delete(fixtureId);
    logger.info("streams", `Stopped streams for fixture ${fixtureId}`);
  }
}

function cleanupFinishedFixture(fixtureId: number): void {
  setTimeout(() => {
    eventTracker.cleanupFixture(fixtureId);
    oddsTracker.cleanupFixture(fixtureId);
    logger.info("cleanup", `Cleaned up tracker state for fixture ${fixtureId}`);
  }, 60_000);
}

function startStreamsForFixture(fixtureId: number): void {
  if (activeStreams.has(fixtureId)) return;
  if (globalStreamsStarted) {
    activeStreams.set(fixtureId, null);
    return;
  }
  if (!config.txoddsJwt || !config.txoddsApiToken) {
    logger.warn("streams", "No TxODDS credentials — streams won't connect.");
    return;
  }

  logger.info("streams", `Starting streams for fixture ${fixtureId}`);

  const scoresStream = createScoresStream({
    jwt: config.txoddsJwt,
    apiToken: config.txoddsApiToken,
    fixtureId,
  });

  const oddsStream = createOddsStream({
    jwt: config.txoddsJwt,
    apiToken: config.txoddsApiToken,
    fixtureId,
  });

  activeStreams.set(fixtureId, { scores: scoresStream, odds: oddsStream });

  scoresStream.on("data", (scoreEvent) => {
    const eventSignals = eventTracker.processScoreUpdate(scoreEvent);
    for (const sig of eventSignals) {
      deliverMatchEvent(sig).catch((e) => logger.error("event-delivery", e.message));
      if (sig.type === "phase_change" && sig.to === "F") {
        stopStreamsForFixture(fixtureId);
        const removed = unsubscribeFixture(fixtureId);
        if (removed > 0) logger.info("cleanup", `Auto-unwatched ${removed} user(s) from finished fixture ${fixtureId}`);
        cleanupFinishedFixture(fixtureId);
      }
    }
    if (eventSignals.length > 0) {
      divergenceDetector.verifyEdgesFromEvents(eventSignals);
      const alerts = divergenceDetector.processEventSignals(eventSignals);
      for (const alert of alerts) {
        deliverAlert(alert).catch((e) => logger.error("alert-delivery", e.message));
      }
    }
  });

  oddsStream.on("data", (oddsUpdate) => {
    const oddsSignals = oddsTracker.processOddsUpdate(oddsUpdate);
    if (oddsSignals.length > 0) {
      divergenceDetector.verifyEdges(oddsSignals);
      const alerts = divergenceDetector.processOddsSignals(oddsSignals);
      for (const alert of alerts) {
        deliverAlert(alert).catch((e) => logger.error("alert-delivery", e.message));
      }
    }
  });

  scoresStream.on("error", (err: Error) => logger.error("scores-stream", err.message));
  oddsStream.on("error", (err: Error) => logger.error("odds-stream", err.message));
}

async function main(): Promise<void> {
  validateConfig();
  getDb();

  bot = createBot(
    eventTracker,
    async (fixtureId) => {
      try {
        const fixtures = await fetchFixtures();
        const f = fixtures.find((fx) => fx.fixtureId === fixtureId);
        if (f) eventTracker.setMatchInfo(fixtureId, f.team1, f.team2);
      } catch {}
      startStreamsForFixture(fixtureId);
    },
    () => ({ active: activeStreams.size, globalConnected: globalStreamsStarted }),
    divergenceDetector,
    oddsTracker,
  );

  bot.start({
    drop_pending_updates: true,
    onStart: () => {
      logger.info("main", "Whistle is live. Watching for opportunities...");
    },
  });

  const port = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeStreams: activeStreams.size }));
    } else if (req.url === "/api/alerts") {
      const token = req.headers["x-api-token"];
      if (config.txoddsApiToken && token !== config.txoddsApiToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const db = getDb();
      const alerts = (db.alerts || []).slice(-50).reverse();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(alerts));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => logger.info("main", `Health server on port ${port}`));

  process.on("SIGTERM", () => {
    logger.info("main", "SIGTERM received, shutting down");
    bot.stop();
    globalScoresStream?.stop();
    globalOddsStream?.stop();
    for (const [, streams] of activeStreams) {
      streams?.scores.stop();
      streams?.odds.stop();
    }
    server.close();
    process.exit(0);
  });

  process.on("uncaughtException", (err: any) => {
    if (err?.error_code === 409) {
      logger.warn("main", "Bot polling conflict (409) — old instance still running, restarting...");
      process.exit(1);
    }
    logger.error("main", `Uncaught exception: ${err.message}`);
    process.exit(1);
  });

  if (config.txoddsJwt && config.txoddsApiToken) {
    globalStreamsStarted = true;
    logger.info("main", "Starting global TxODDS streams");

    globalScoresStream = createScoresStream({
      jwt: config.txoddsJwt,
      apiToken: config.txoddsApiToken,
    });

    globalOddsStream = createOddsStream({
      jwt: config.txoddsJwt,
      apiToken: config.txoddsApiToken,
    });

    const globalScores = globalScoresStream;
    const globalOdds = globalOddsStream;

    fetchFixtures().then((fixtures) => {
      for (const f of fixtures) {
        eventTracker.setMatchInfo(f.fixtureId, f.team1, f.team2);
      }
      logger.info("main", `Pre-loaded ${fixtures.length} fixture names`);
    }).catch(() => {});

    globalScores.on("data", (scoreEvent) => {
      const signals = eventTracker.processScoreUpdate(scoreEvent);
      for (const sig of signals) {
        deliverMatchEvent(sig).catch((e) => logger.error("event-delivery", e.message));
        if (sig.type === "phase_change" && sig.to === "F") {
          const removed = unsubscribeFixture(sig.fixtureId);
          if (removed > 0) logger.info("cleanup", `Auto-unwatched ${removed} user(s) from finished fixture ${sig.fixtureId}`);
          cleanupFinishedFixture(sig.fixtureId);
        }
      }
      if (signals.length > 0) {
        divergenceDetector.verifyEdgesFromEvents(signals);
        const alerts = divergenceDetector.processEventSignals(signals);
        for (const alert of alerts) deliverAlert(alert).catch((e) => logger.error("alert-delivery", e.message));
      }
    });

    globalOdds.on("data", (oddsUpdate) => {
      const signals = oddsTracker.processOddsUpdate(oddsUpdate);
      if (signals.length > 0) {
        divergenceDetector.verifyEdges(signals);
        const alerts = divergenceDetector.processOddsSignals(signals);
        for (const alert of alerts) deliverAlert(alert).catch((e) => logger.error("alert-delivery", e.message));
      }
    });

    globalScores.on("error", (err: Error) => logger.error("global-scores", err.message));
    globalOdds.on("error", (err: Error) => logger.error("global-odds", err.message));
  }
}

main().catch((err) => {
  logger.error("main", `Fatal error: ${err.message}`);
  process.exit(1);
});
