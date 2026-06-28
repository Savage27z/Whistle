import { config } from "../utils/config";
import { logger } from "../utils/logger";
import type { DivergenceAlert } from "./divergence";
import type { MatchState } from "./event-tracker";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

let lastApiCall = 0;
const MIN_API_INTERVAL_MS = 5000;

export async function narrateAlert(alert: DivergenceAlert, matchState?: MatchState): Promise<string> {
  const now = Date.now();
  if (now - lastApiCall < MIN_API_INTERVAL_MS) {
    return formatFallback(alert, matchState);
  }
  if (!config.openrouterApiKey) return formatFallback(alert, matchState);

  const team1 = matchState?.team1 || "Home";
  const team2 = matchState?.team2 || "Away";
  const score = matchState ? `${matchState.score[0]}-${matchState.score[1]}` : "?-?";
  const minute = matchState?.minute || "?";
  const phase = matchState?.phase || "?";

  const prompt = `You are Whistle, an AI sports trading intelligence agent. Write a Telegram alert (max 5 lines, plain text only — no markdown).

Match: ${team1} vs ${team2} | ${score} | ${minute}' | ${phase}
Signal: ${alert.type} (${alert.severity})
Details: ${alert.description}

Rules:
- Line 1: emoji + bold headline (use 🔴/🟠/🟡/⚪ for critical/high/medium/low)
- Line 2: match context (teams, score, minute)
- Line 3-4: what happened and why it matters for trading
- Line 5: specific trading angle (e.g. "Look at Over 2.5 before it shortens" or "Back [team] at current price")
- Be specific with numbers. Say "odds moved 12% in 40s" not "odds shifted"
- Never use generic phrases like "keep an eye on" or "worth monitoring"`;

  try {
    lastApiCall = Date.now();
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openrouterApiKey}`,
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      logger.error("narrator", `OpenRouter error: ${res.status}`);
      return formatFallback(alert, matchState);
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content || formatFallback(alert, matchState);
  } catch (err) {
    logger.error("narrator", `AI narration failed: ${(err as Error).message}`);
    return formatFallback(alert, matchState);
  }
}

function severityEmoji(severity: string): string {
  switch (severity) {
    case "critical": return "🔴";
    case "high": return "🟠";
    case "medium": return "🟡";
    default: return "⚪";
  }
}

function formatFallback(alert: DivergenceAlert, matchState?: MatchState): string {
  const emoji = severityEmoji(alert.severity);
  const team1 = matchState?.team1 || "Home";
  const team2 = matchState?.team2 || "Away";
  const score = matchState ? `${matchState.score[0]}-${matchState.score[1]}` : "";
  const minute = matchState?.minute ? `${matchState.minute}'` : "";
  const header = [team1, "vs", team2, score, minute].filter(Boolean).join(" ");

  return `${emoji} *${alert.title.toUpperCase()}*\n${header}\n\n${alert.description}`;
}
