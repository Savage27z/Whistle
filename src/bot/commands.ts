import { Bot, InlineKeyboard, InputFile } from "grammy";
import path from "path";
import { fetchFixtures } from "../txodds/client";
import {
  ensureUser,
  subscribeWatch,
  unsubscribeWatch,
  unsubscribeAll,
  getUserWatchList,
  getRecentAlerts,
  getUserSettings,
  updateUserSeverity,
} from "../db/queries";
import { formatMatchLine } from "./formatters";
import type { EventTracker } from "../engine/event-tracker";
import type { Severity, DivergenceDetector } from "../engine/divergence";
import type { OddsTracker } from "../engine/odds-tracker";
import { logger } from "../utils/logger";
import { escHtml, canCallOpenRouter, markOpenRouter429, markOpenRouterSuccess, OPENROUTER_URL } from "../engine/narrator";
import { config } from "../utils/config";

export function setupCommands(
  bot: Bot,
  eventTracker: EventTracker,
  onWatch: (fixtureId: number) => void,
  getStreamHealth: () => { active: number; globalConnected: boolean },
  divergenceDetector: DivergenceDetector,
  oddsTracker: OddsTracker,
): void {
  bot.api.setMyCommands([
    { command: "start", description: "Welcome message and overview" },
    { command: "watch", description: "Pick a live match to monitor" },
    { command: "watchall", description: "Watch all matches at once" },
    { command: "unwatch", description: "Stop watching a match" },
    { command: "unwatchall", description: "Stop watching all matches" },
    { command: "live", description: "View your watched matches" },
    { command: "alerts", description: "Recent divergence alerts" },
    { command: "settings", description: "Configure alert severity" },
    { command: "stats", description: "Alert statistics + edge accuracy" },
    { command: "status", description: "Bot connection status" },
    { command: "briefing", description: "Pre-match market overview" },
    { command: "predict", description: "AI match prediction" },
    { command: "history", description: "Alert history for a match" },
    { command: "help", description: "How Whistle works" },
  ]).catch(() => {});

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `📖 <b>How Whistle Works</b>\n\n` +
        `Whistle connects to TxODDS live data streams and cross-references odds movements with match events in real-time.\n\n` +
        `<b>Divergence patterns I detect:</b>\n\n` +
        `🔴 <b>Silent Odds Shift</b> — Multiple bookmakers move odds sharply with no visible match event. Could signal insider info, injury, or tactical change.\n\n` +
        `🔴 <b>Odds Collapse</b> — Odds crash from 1.50+ to below 1.20. Outcome is near-certain — check for unreported events.\n\n` +
        `🟠 <b>Delayed Market Reaction</b> — A goal, red card, or penalty happens but odds haven't adjusted within 10s. The market is slow.\n\n` +
        `🟡 <b>Momentum Mispricing</b> — Sustained attacking pressure (3+ danger possessions) but odds haven't shortened. Goal probability is underpriced.\n\n` +
        `🟡 <b>Goal Imminent</b> — TxODDS signals an imminent goal but Over/BTTS market hasn't tightened.\n\n` +
        `⚪ <b>Bookmaker Disagreement</b> — 20%+ spread across 3+ bookmakers on the same market. Someone knows something.\n\n` +
        `<b>Match events:</b> You'll also receive instant alerts for goals ⚽, red cards 🟥, penalties ⚠️, VAR reviews 📺, and match phases 🕐 (kickoff, half time, full time).\n\n` +
        `<b>Commands:</b>\n` +
        `/watch — Pick a match to monitor\n` +
        `/watchall — Watch all matches at once\n` +
        `/unwatch — Stop monitoring\n` +
        `/unwatchall — Stop all monitoring\n` +
        `/live — Your active matches\n` +
        `/alerts — Recent alerts\n` +
        `/briefing — Pre-match market overview\n` +
        `/predict — AI match prediction\n` +
        `/history — Alert timeline for a match\n` +
        `/settings — Set minimum severity\n` +
        `/stats — Alert breakdown + edge accuracy\n` +
        `/status — Connection health`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) ensureUser(userId, ctx.from?.username);

    const caption =
      `⚽ <b>Welcome to Whistle</b>\n\n` +
      `AI-powered trading intelligence for the World Cup. I watch live matches through TxODDS data feeds and alert you to opportunities in real-time.\n\n` +
      `<b>What I detect:</b>\n` +
      `🔴 Silent odds shifts — market moves with no visible event\n` +
      `🟠 Delayed reactions — big events the market hasn't priced\n` +
      `🟡 Momentum mispricing — sustained pressure not in the odds\n` +
      `⚪ Bookmaker disagreement — some books know more\n\n` +
      `<b>Every alert includes:</b>\n` +
      `🎯 Confidence score · 📊 Live odds snapshot\n\n` +
      `Plus instant match events: goals, red cards, penalties, VAR, kickoff/HT/FT.\n\n` +
      `🔗 Solana on-chain subscription (Token-2022, devnet)\n\n` +
      `<b>Quick start:</b>\n` +
      `/briefing — Today's matches + market overview\n` +
      `/watch — Pick a match to monitor\n` +
      `/predict — AI match prediction`;

    const bannerPath = path.resolve(__dirname, "../../assets/banner.png");
    try {
      await ctx.replyWithPhoto(new InputFile(bannerPath), {
        caption,
        parse_mode: "HTML",
      });
    } catch {
      await ctx.reply(caption, { parse_mode: "HTML" });
    }
  });

  bot.command("watch", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    ensureUser(userId, ctx.from?.username);

    const args = ctx.match?.trim();
    if (args) {
      const fixtureId = parseInt(args, 10);
      if (isNaN(fixtureId)) {
        return ctx.reply("Invalid fixture ID. Use /watch to see available matches.");
      }
      subscribeWatch(userId, fixtureId);
      await onWatch(fixtureId);
      const matchState = eventTracker.getMatchState(fixtureId);
      const label = matchState ? `${matchState.team1} vs ${matchState.team2}` : `fixture ${fixtureId}`;
      return ctx.reply(`✅ Now watching <b>${escHtml(label)}</b>. I'll alert you when I spot something.\n\nUse /unwatch to stop.`, { parse_mode: "HTML" });
    }

    try {
      const fixtures = await fetchFixtures();
      if (fixtures.length === 0) {
        return ctx.reply("No live World Cup matches right now. Check back during match time!\n\nYou can also use /watch <fixtureId> if you know the fixture ID.");
      }

      const keyboard = new InlineKeyboard();
      for (const f of fixtures) {
        const label = `${f.team1} vs ${f.team2}`;
        keyboard.text(label, `watch:${f.fixtureId}`).row();
      }

      await ctx.reply("<b>Select a match to watch:</b>", {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } catch (err) {
      logger.error("bot", `Failed to fetch fixtures: ${(err as Error).message}`);
      await ctx.reply("Couldn't fetch matches right now. You can use /watch <fixtureId> directly if you know the ID.");
    }
  });

  bot.callbackQuery(/^watch:(\d+)$/, async (ctx) => {
    const fixtureId = parseInt(ctx.match![1]);
    const userId = ctx.from.id;

    ensureUser(userId, ctx.from.username);
    subscribeWatch(userId, fixtureId);
    await onWatch(fixtureId);

    const matchState = eventTracker.getMatchState(fixtureId);
    const label = matchState ? `${matchState.team1} vs ${matchState.team2}` : `match ${fixtureId}`;

    await ctx.answerCallbackQuery({ text: "Watching! You'll get alerts." });
    await ctx.editMessageText(
      `✅ Now watching <b>${escHtml(label)}</b>. I'll alert you when I spot something.\n\nUse /unwatch to stop.`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("watchall", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    ensureUser(userId, ctx.from?.username);

    try {
      const fixtures = await fetchFixtures();
      if (fixtures.length === 0) {
        return ctx.reply("No World Cup matches available right now.");
      }

      let count = 0;
      for (const f of fixtures) {
        subscribeWatch(userId, f.fixtureId);
        await onWatch(f.fixtureId);
        count++;
      }

      const matchList = fixtures.slice(0, 5).map((f) => `  ⚽ ${escHtml(f.team1)} vs ${escHtml(f.team2)}`).join("\n");
      const more = fixtures.length > 5 ? `\n  ...and ${fixtures.length - 5} more` : "";

      await ctx.reply(
        `✅ Now watching <b>all ${count} matches</b>:\n\n${matchList}${more}\n\nI'll alert you when I spot opportunities. Use /unwatch to stop.`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      logger.error("bot", `Watchall failed: ${(err as Error).message}`);
      await ctx.reply("Couldn't fetch matches. Try again later.");
    }
  });

  bot.command("unwatch", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const args = ctx.match?.trim();
    if (args) {
      const fixtureId = parseInt(args, 10);
      if (isNaN(fixtureId)) {
        return ctx.reply("Invalid fixture ID.");
      }
      unsubscribeWatch(userId, fixtureId);
      return ctx.reply(`Stopped watching fixture ${fixtureId}.`, { parse_mode: "HTML" });
    }

    const watching = getUserWatchList(userId);
    if (watching.length === 0) {
      return ctx.reply("You're not watching any matches.");
    }

    const keyboard = new InlineKeyboard();
    for (const w of watching) {
      const state = eventTracker.getMatchState(w.fixture_id);
      const label = state ? `${state.team1} vs ${state.team2}` : `Fixture ${w.fixture_id}`;
      keyboard.text(`❌ ${label}`, `unwatch:${w.fixture_id}`).row();
    }

    await ctx.reply("<b>Tap a match to stop watching:</b>", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^unwatch:(\d+)$/, async (ctx) => {
    const fixtureId = parseInt(ctx.match![1]);
    const userId = ctx.from.id;

    unsubscribeWatch(userId, fixtureId);
    const state = eventTracker.getMatchState(fixtureId);
    const label = state ? `${state.team1} vs ${state.team2}` : `fixture ${fixtureId}`;

    await ctx.answerCallbackQuery({ text: "Stopped watching." });
    await ctx.editMessageText(`Stopped watching <b>${escHtml(label)}</b>.`, { parse_mode: "HTML" });
  });

  bot.command("unwatchall", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const count = unsubscribeAll(userId);
    if (count === 0) {
      return ctx.reply("You're not watching any matches.");
    }
    await ctx.reply(`✅ Stopped watching all ${count} match${count === 1 ? "" : "es"}.`);
  });

  bot.command("live", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const watching = getUserWatchList(userId);
    if (watching.length === 0) {
      return ctx.reply("You're not watching any matches. Use /watch to start.");
    }

    let msg = `<b>Your live matches:</b> (${watching.length})\n\n`;
    const shown = watching.slice(0, 10);
    for (const w of shown) {
      const state = eventTracker.getMatchState(w.fixture_id);
      if (state) {
        msg += formatMatchLine(state, w.alert_count) + "\n\n";
      } else {
        msg += `📋 Fixture ${w.fixture_id} — awaiting data\n   Alerts sent: ${w.alert_count}\n\n`;
      }
    }
    if (watching.length > 10) {
      msg += `...and ${watching.length - 10} more\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  bot.command("alerts", async (ctx) => {
    const alerts = getRecentAlerts(5);
    if (alerts.length === 0) {
      return ctx.reply("No alerts yet. Watch a match with /watch to start receiving alerts.");
    }

    let msg = "<b>Recent Alerts:</b>\n\n";
    for (const a of alerts) {
      const time = new Date(a.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
      const sevEmoji = a.severity === "critical" ? "🔴" : a.severity === "high" ? "🟠" : a.severity === "medium" ? "🟡" : "⚪";
      const state = eventTracker.getMatchState(a.fixture_id);
      const match = state ? `${escHtml(state.team1)} vs ${escHtml(state.team2)}` : `Fixture ${a.fixture_id}`;
      msg += `${sevEmoji} <b>${escHtml(a.title)}</b>\n${match} — ${escHtml(time)}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  bot.command("settings", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const args = ctx.match?.trim();
    if (args) {
      const validSeverities: Severity[] = ["low", "medium", "high", "critical"];
      if (validSeverities.includes(args as Severity)) {
        updateUserSeverity(userId, args as Severity);
        return ctx.reply(`✅ Minimum alert severity set to: ${args}`);
      }
      return ctx.reply("Invalid severity. Options: low, medium, high, critical");
    }

    const settings = getUserSettings(userId);
    const keyboard = new InlineKeyboard()
      .text("⚪ Low", "severity:low")
      .text("🟡 Medium", "severity:medium")
      .row()
      .text("🟠 High", "severity:high")
      .text("🔴 Critical", "severity:critical");

    await ctx.reply(
      `<b>Your Settings</b>\n\nMinimum alert severity: <b>${escHtml(settings.minSeverity)}</b>\n\nTap to change:`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^severity:(\w+)$/, async (ctx) => {
    const raw = ctx.match![1];
    const valid: Severity[] = ["low", "medium", "high", "critical"];
    if (!valid.includes(raw as Severity)) return ctx.answerCallbackQuery({ text: "Invalid severity" });
    const severity = raw as Severity;
    const userId = ctx.from.id;
    updateUserSeverity(userId, severity);
    await ctx.answerCallbackQuery({ text: `Severity set to ${severity}` });
    await ctx.editMessageText(`✅ Minimum alert severity set to: <b>${escHtml(severity)}</b>`, { parse_mode: "HTML" });
  });

  bot.command("stats", async (ctx) => {
    const alerts = getRecentAlerts(100);
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const a of alerts) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
    }

    const edge = divergenceDetector.getEdgeStats();

    let msg = `<b>Whistle Stats</b>\n\nRecent alerts (last 100): ${alerts.length}\n\n`;

    if (edge.total > 0) {
      msg += `<b>Edge tracker:</b>\n`;
      msg += `  Alerts fired: ${edge.total}\n`;
      msg += `  Confirmed edges: ${edge.confirmed}\n`;
      msg += `  Accuracy: ${edge.accuracy}%\n\n`;
    }

    const sevLabels: Record<string, string> = { critical: "🔴 Critical", high: "🟠 High", medium: "🟡 Medium", low: "⚪ Low" };
    if (Object.keys(bySeverity).length > 0) {
      msg += `<b>By severity:</b>\n`;
      for (const [sev, count] of Object.entries(bySeverity)) {
        msg += `  ${sevLabels[sev] || sev}: ${count}\n`;
      }
      msg += `\n`;
    }

    const typeLabels: Record<string, string> = {
      silent_odds_shift: "Silent Odds Shift / Collapse",
      delayed_market_reaction: "Delayed Market Reaction",
      momentum_mispricing: "Momentum Mispricing",
      value_spot: "Goal Imminent / Disagreement",
    };
    msg += `<b>By type:</b>\n`;
    for (const [type, count] of Object.entries(byType)) {
      msg += `  ${typeLabels[type] || type}: ${count}\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  bot.command("status", async (ctx) => {
    const health = getStreamHealth();
    const fixtureCount = health.active;
    const global = health.globalConnected ? "✅ Connected" : "❌ Disconnected";

    let msg = `<b>Whistle Status</b>\n\n`;
    msg += `TxODDS streams: ${global}\n`;
    msg += `Active fixtures: ${fixtureCount}\n`;

    msg += `🔗 Solana subscription: ${config.solanaPrivateKey ? "✅ Active (devnet)" : "❌ Not configured"}\n`;
    msg += `🤖 AI narration: ${config.openrouterApiKey ? (canCallOpenRouter() ? "✅ Ready" : "⏳ Rate-limited") : "❌ No API key"}\n`;

    const watching = getUserWatchList(ctx.from?.id || 0);
    msg += `Your watches: ${watching.length}\n`;

    for (const w of watching) {
      const state = eventTracker.getMatchState(w.fixture_id);
      if (state) {
        const ago = Math.round((Date.now() - state.lastEventTs) / 1000);
        msg += `  • ${escHtml(state.team1)} vs ${escHtml(state.team2)} — last data ${ago}s ago\n`;
      } else {
        msg += `  • Fixture ${w.fixture_id} — no data yet\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  bot.command("briefing", async (ctx) => {
    try {
      const fixtures = await fetchFixtures();
      if (fixtures.length === 0) {
        return ctx.reply("No live or upcoming World Cup matches right now.");
      }

      let msg = `📋 <b>Match Day Briefing</b> (${fixtures.length} matches)\n\n`;

      const shown = fixtures.slice(0, 8);
      for (const f of shown) {
        const state = eventTracker.getMatchState(f.fixtureId);
        const markets = oddsTracker.getMarketSummary(f.fixtureId);

        msg += `⚽ <b>${escHtml(f.team1)} vs ${escHtml(f.team2)}</b>\n`;

        if (state && state.phase !== "NS") {
          msg += `   ${state.score[0]}-${state.score[1]} | ${state.minute}'\n`;
        } else {
          const kickoff = new Date(f.startTime);
          msg += `   Kickoff: ${kickoff.toUTCString().slice(17, 22)} UTC\n`;
        }

        if (markets.length > 0) {
          const topMarkets = markets.slice(0, 3);
          for (const m of topMarkets) {
            const spreadPct = (m.spread * 100).toFixed(0);
            msg += `   📊 ${escHtml(m.market)}: ${m.consensus.toFixed(2)} (${m.bookmakerCount} books, ${spreadPct}% spread)\n`;
          }
        } else {
          msg += `   No odds data yet\n`;
        }
        msg += `\n`;
      }

      if (fixtures.length > 8) {
        msg += `...and ${fixtures.length - 8} more matches\n\n`;
      }
      msg += `Use /watch to start receiving alerts for any match.`;
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err) {
      logger.error("bot", `Briefing failed: ${(err as Error).message}`);
      await ctx.reply("Couldn't generate briefing right now. Try again later.");
    }
  });

  bot.command("predict", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const watching = getUserWatchList(userId);
    if (watching.length === 0) {
      return ctx.reply("Watch a match first with /watch, then use /predict to get an AI prediction.");
    }

    if (watching.length > 1) {
      const keyboard = new InlineKeyboard();
      for (const w of watching) {
        const state = eventTracker.getMatchState(w.fixture_id);
        const label = state ? `${state.team1} vs ${state.team2}` : `Fixture ${w.fixture_id}`;
        keyboard.text(label, `predict:${w.fixture_id}`).row();
      }
      return ctx.reply("<b>Select a match to predict:</b>", { reply_markup: keyboard, parse_mode: "HTML" });
    }

    await generatePrediction(ctx, watching[0].fixture_id);
  });

  bot.callbackQuery(/^predict:(\d+)$/, async (ctx) => {
    const fixtureId = parseInt(ctx.match![1]);
    await ctx.answerCallbackQuery();
    await generatePrediction(ctx, fixtureId);
  });

  async function generatePrediction(ctx: { reply: (text: string, opts?: any) => Promise<any> }, fixtureId: number): Promise<void> {
    const state = eventTracker.getMatchState(fixtureId);
    if (!state) {
      return ctx.reply("No match data available yet. Wait for the match to start.");
    }

    if (!config.openrouterApiKey) {
      return ctx.reply("AI predictions require OpenRouter API key.");
    }

    if (!canCallOpenRouter()) {
      return ctx.reply("AI is rate-limited right now. Try again in a minute.");
    }

    const markets = oddsTracker.getMarketSummary(fixtureId);
    const edge = divergenceDetector.getEdgeStats();

    const marketInfo = markets.slice(0, 5).map((m) =>
      `${m.market}: consensus ${m.consensus.toFixed(2)}, ${m.bookmakerCount} books, ${(m.spread * 100).toFixed(0)}% spread`
    ).join("\n");

    const dangerTeamName = state.dangerTeam
      ? (state.dangerTeam === 1 ? state.team1 : state.team2)
      : "none";

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.openrouterApiKey}`,
        },
        body: JSON.stringify({
          model: config.aiModel,
          messages: [{ role: "user", content: `You are Whistle, an AI sports trading analyst. Generate a brief match prediction based on live data (max 8 lines, plain text only, no formatting characters).

Match: ${state.team1} vs ${state.team2} | ${state.score[0]}-${state.score[1]} | ${state.minute}' | Phase: ${state.phase}
Danger sequences: ${state.dangerSequence} (${dangerTeamName})
Last goal: minute ${state.lastGoalMinute || "none"}

Current odds data:
${marketInfo || "No market data"}

Session edge accuracy: ${edge.accuracy}% (${edge.confirmed}/${edge.total} confirmed)

Rules:
- Line 1: Match summary with current momentum assessment
- Lines 2-4: Key market insights based on the odds data above
- Lines 5-6: Predicted outcome with reasoning
- Line 7-8: Top 1-2 trading opportunities right now
- Be specific with odds values. Name specific markets.
- Do NOT use any formatting characters like *, _, ~, \`, [ ]` }],
          max_tokens: 350,
          temperature: 0.7,
        }),
      });

      if (!res.ok) {
        if (res.status === 429) markOpenRouter429();
        return ctx.reply("AI prediction unavailable right now (rate limited). Try again in a few minutes.");
      }

      markOpenRouterSuccess();
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      const raw = data.choices?.[0]?.message?.content;
      if (!raw) return ctx.reply("Couldn't generate prediction. Try again.");

      const header = `🔮 <b>AI Prediction</b>\n${escHtml(state.team1)} ${state.score[0]}-${state.score[1]} ${escHtml(state.team2)} | ${state.minute}'\n\n`;
      await ctx.reply(header + escHtml(raw), { parse_mode: "HTML" });
    } catch (err) {
      logger.error("bot", `Predict failed: ${(err as Error).message}`);
      await ctx.reply("Prediction failed. Try again later.");
    }
  }

  bot.command("history", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const watching = getUserWatchList(userId);
    if (watching.length === 0) {
      return ctx.reply("You're not watching any matches. Use /watch first.");
    }

    if (watching.length === 1) {
      const fixtureId = watching[0].fixture_id;
      return sendHistory(ctx, fixtureId);
    }

    const keyboard = new InlineKeyboard();
    for (const w of watching) {
      const state = eventTracker.getMatchState(w.fixture_id);
      const label = state ? `${state.team1} vs ${state.team2}` : `Fixture ${w.fixture_id}`;
      keyboard.text(label, `history:${w.fixture_id}`).row();
    }

    await ctx.reply("<b>Select a match to view history:</b>", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^history:(\d+)$/, async (ctx) => {
    const fixtureId = parseInt(ctx.match![1]);
    await ctx.answerCallbackQuery();
    await sendHistory(ctx, fixtureId);
  });

  async function sendHistory(ctx: { reply: (text: string, opts?: any) => Promise<any> }, fixtureId: number): Promise<void> {
    const allAlerts = getRecentAlerts(500);
    const matchAlerts = allAlerts.filter((a) => a.fixture_id === fixtureId).slice(0, 15);

    const state = eventTracker.getMatchState(fixtureId);
    const label = state ? `${escHtml(state.team1)} vs ${escHtml(state.team2)}` : `Fixture ${fixtureId}`;

    if (matchAlerts.length === 0) {
      return ctx.reply(`No alerts yet for ${label}.`, { parse_mode: "HTML" });
    }

    let msg = `📜 <b>Alert History — ${label}</b>\n\n`;
    for (let i = 0; i < matchAlerts.length; i++) {
      const a = matchAlerts[i];
      const time = new Date(a.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" }) + " UTC";
      const sevEmoji = a.severity === "critical" ? "🔴" : a.severity === "high" ? "🟠" : a.severity === "medium" ? "🟡" : "⚪";
      const line = `${sevEmoji} <b>${escHtml(a.title)}</b> — ${escHtml(time)}\n`;
      if (msg.length + line.length > 4000) {
        msg += `\n...and ${matchAlerts.length - i} more`;
        break;
      }
      msg += line;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  }
}
