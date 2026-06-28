import type { MatchState } from "../engine/event-tracker";
import { escHtml } from "../engine/narrator";

export function formatMatchLine(state: MatchState, alertCount: number): string {
  const phaseLabel = formatPhase(state.phase);
  return (
    `⚽ <b>${escHtml(state.team1)}</b> ${state.score[0]}-${state.score[1]} <b>${escHtml(state.team2)}</b>` +
    ` | ${state.minute}' ${escHtml(phaseLabel)}\n` +
    `   Alerts sent: ${alertCount}`
  );
}

export function formatPhase(phase: string): string {
  switch (phase) {
    case "NS": return "Not Started";
    case "H1": return "1st Half";
    case "HT": return "Half Time";
    case "H2": return "2nd Half";
    case "F": return "Full Time";
    case "ET1": return "Extra Time 1";
    case "ET2": return "Extra Time 2";
    case "PE": return "Penalties";
    default: return phase;
  }
}
