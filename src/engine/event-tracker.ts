import type { ScoreEvent, SoccerStatus } from "../txodds/types";
import { logger } from "../utils/logger";

export interface EventSignal {
  type: "goal" | "red_card" | "penalty" | "var_review" | "phase_change" | "sustained_pressure" | "goal_imminent" | "yellow_card" | "corner";
  fixtureId: number;
  team?: number;
  minute?: number;
  goalType?: string;
  newScore?: [number, number];
  dangerCount?: number;
  from?: string;
  to?: string;
  ts: number;
}

export interface MatchState {
  fixtureId: number;
  team1: string;
  team2: string;
  score: [number, number];
  phase: SoccerStatus;
  minute: number;
  dangerSequence: number;
  dangerTeam: number | null;
  lastGoalMinute: number | null;
  lastEventTs: number;
  lastSeq: number;
}

export class EventTracker {
  private state: Map<number, MatchState> = new Map();

  setMatchInfo(fixtureId: number, team1: string, team2: string): void {
    const s = this.getOrCreate(fixtureId);
    s.team1 = team1;
    s.team2 = team2;
  }

  getMatchState(fixtureId: number): MatchState | undefined {
    return this.state.get(fixtureId);
  }

  processScoreUpdate(update: ScoreEvent): EventSignal[] {
    const signals: EventSignal[] = [];
    const state = this.getOrCreate(update.fixtureId);
    const now = update.ts || Date.now();

    // TxLINE seq numbers are monotonic per fixture within a connection. A
    // sharply lower seq than what we've already applied means this message
    // arrived out of order (reconnect replay, network reordering) — skip
    // state-affecting fields so stale data can't overwrite the current score,
    // but still let event signals (goal/card/etc) through below since those
    // matter more than perfect ordering.
    const isStale = update.seq > 0 && state.lastSeq > 0 && update.seq < state.lastSeq;
    if (update.seq > state.lastSeq) state.lastSeq = update.seq;

    if (update.scoreSoccer && !isStale) {
      state.score = [
        update.scoreSoccer.Participant1.Total.Goals,
        update.scoreSoccer.Participant2.Total.Goals,
      ];
    }

    if (update.minute) {
      state.minute = update.minute;
    }

    // Danger possession tracking
    if (update.possessionType === "DangerPossession" || update.possessionType === "HighDangerPossession") {
      const team = update.possession || 0;
      if (state.dangerTeam === team) {
        state.dangerSequence++;
      } else {
        state.dangerSequence = 1;
        state.dangerTeam = team;
      }

      if (state.dangerSequence >= 3) {
        signals.push({
          type: "sustained_pressure",
          fixtureId: update.fixtureId,
          team,
          dangerCount: state.dangerSequence,
          minute: state.minute,
          ts: now,
        });
      }
    } else if (update.possessionType) {
      if (state.dangerSequence > 0) state.dangerSequence--;
      if (state.dangerSequence === 0) state.dangerTeam = null;
    }

    // Goal imminent
    if (update.parti1StateSoccer?.PossibleEvent?.Goal || update.parti2StateSoccer?.PossibleEvent?.Goal) {
      const team = update.parti1StateSoccer?.PossibleEvent?.Goal ? 1 : 2;
      signals.push({
        type: "goal_imminent",
        fixtureId: update.fixtureId,
        team,
        minute: state.minute,
        ts: now,
      });
    }

    if (update.dataSoccer) {
      const d = update.dataSoccer;

      if (d.Goal) {
        state.lastGoalMinute = d.Minutes;
        signals.push({
          type: "goal",
          fixtureId: update.fixtureId,
          team: d.Participant,
          minute: d.Minutes,
          goalType: d.GoalType,
          newScore: [...state.score] as [number, number],
          ts: now,
        });
      }

      if (d.RedCard) {
        signals.push({
          type: "red_card",
          fixtureId: update.fixtureId,
          team: d.Participant,
          minute: d.Minutes,
          ts: now,
        });
      }

      if (d.Penalty) {
        signals.push({
          type: "penalty",
          fixtureId: update.fixtureId,
          team: d.Participant,
          minute: d.Minutes,
          ts: now,
        });
      }

      if (d.VAR) {
        signals.push({
          type: "var_review",
          fixtureId: update.fixtureId,
          minute: d.Minutes || state.minute,
          ts: now,
        });
      }

      if (d.YellowCard) {
        signals.push({
          type: "yellow_card",
          fixtureId: update.fixtureId,
          team: d.Participant,
          minute: d.Minutes,
          ts: now,
        });
      }

      if (d.Corner) {
        signals.push({
          type: "corner",
          fixtureId: update.fixtureId,
          team: d.Participant,
          minute: d.Minutes,
          ts: now,
        });
      }
    }

    // Phase change
    if (update.statusSoccerId && update.statusSoccerId !== state.phase) {
      signals.push({
        type: "phase_change",
        fixtureId: update.fixtureId,
        from: state.phase,
        to: update.statusSoccerId,
        ts: now,
      });
      state.phase = update.statusSoccerId;
    }

    state.lastEventTs = now;

    if (signals.length > 0) {
      logger.debug("event-tracker", `Generated ${signals.length} event signals for fixture ${update.fixtureId}`);
    }

    return signals;
  }

  cleanupFixture(fixtureId: number): void {
    this.state.delete(fixtureId);
  }

  private getOrCreate(fixtureId: number): MatchState {
    let s = this.state.get(fixtureId);
    if (!s) {
      s = {
        fixtureId,
        team1: "Team 1",
        team2: "Team 2",
        score: [0, 0],
        phase: "NS",
        minute: 0,
        dangerSequence: 0,
        dangerTeam: null,
        lastGoalMinute: null,
        lastEventTs: 0,
        lastSeq: 0,
      };
      this.state.set(fixtureId, s);
    }
    return s;
  }
}
