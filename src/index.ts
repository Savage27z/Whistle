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
import { getSubscribersForFixture, getUserSettings, incrementAlertCount, logAlert } from "./db/queries";
import { fetchFixtures } from "./txodds/client";
import { getDb } from "./db/schema";
import type { Bot } from "grammy";
import http from "http";

const oddsTracker = new OddsTracker();
const eventTracker = new EventTracker();
const divergenceDetector = new DivergenceDetector();
const activeStreams = new Set<number>();
let globalStreamsStarted = false;

let bot: Bot;

const MAJOR_EVENTS = new Set(["goal", "red_card", "penalty", "var_review"]);

async function deliverAlert(alert: DivergenceAlert): Promise<void> {
  const matchState = eventTracker.getMatchState(alert.fixtureId);
  const message = await narrateAlert(alert, matchState);

  const subscribers = getSubscribersForFixture(alert.fixtureId);

  for (const userId of subscribers) {
    const settings = getUserSettings(userId);
    if (severityRank(alert.severity) >= severityRank(settings.minSeverity)) {
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
        incrementAlertCount(userId, alert.fixtureId);
      } catch (err) {
        logger.error("delivery", `Failed to send to ${userId}: ${(err as Error).message}`);
      }
    }
  }

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
  });

  const subscribers = getSubscribersForFixture(signal.fixtureId);
  for (const userId of subscribers) {
    try {
      await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
    } catch (err) {
      logger.error("delivery", `Failed to send event to ${userId}: ${(err as Error).message}`);
    }
  }
}

function startStreamsForFixture(fixtureId: number): void {
  if (activeStreams.has(fixtureId)) return;
  if (globalStreamsStarted) {
    activeStreams.add(fixtureId);
    return;
  }
  if (!config.txoddsJwt || !config.txoddsApiToken) {
    logger.warn("streams", "No TxODDS credentials — streams won't connect.");
    return;
  }

  activeStreams.add(fixtureId);
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

  scoresStream.on("data", (scoreEvent) => {
    const eventSignals = eventTracker.processScoreUpdate(scoreEvent);
    for (const sig of eventSignals) {
      deliverMatchEvent(sig).catch((e) => logger.error("event-delivery", e.message));
    }
    if (eventSignals.length > 0) {
      const alerts = divergenceDetector.processEventSignals(eventSignals);
      for (const alert of alerts) {
        deliverAlert(alert).catch((e) => logger.error("alert-delivery", e.message));
      }
    }
  });

  oddsStream.on("data", (oddsUpdate) => {
    const oddsSignals = oddsTracker.processOddsUpdate(oddsUpdate);
    if (oddsSignals.length > 0) {
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
    server.close();
    process.exit(0);
  });

  if (config.txoddsJwt && config.txoddsApiToken) {
    globalStreamsStarted = true;
    logger.info("main", "Starting global TxODDS streams");

    const globalScores = createScoresStream({
      jwt: config.txoddsJwt,
      apiToken: config.txoddsApiToken,
    });

    const globalOdds = createOddsStream({
      jwt: config.txoddsJwt,
      apiToken: config.txoddsApiToken,
    });

    globalScores.on("data", (scoreEvent) => {
      const signals = eventTracker.processScoreUpdate(scoreEvent);
      for (const sig of signals) {
        deliverMatchEvent(sig).catch((e) => logger.error("event-delivery", e.message));
      }
      if (signals.length > 0) {
        const alerts = divergenceDetector.processEventSignals(signals);
        for (const alert of alerts) deliverAlert(alert).catch((e) => logger.error("alert-delivery", e.message));
      }
    });

    globalOdds.on("data", (oddsUpdate) => {
      const signals = oddsTracker.processOddsUpdate(oddsUpdate);
      if (signals.length > 0) {
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
