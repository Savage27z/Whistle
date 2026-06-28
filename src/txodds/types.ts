export interface RawOddsPayload {
  FixtureId: number;
  MessageId: string;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  InRunning: boolean;
  GameState?: string;
  MarketParameters?: string;
  MarketPeriod?: string;
  PriceNames?: string[];
  Prices?: number[];
  Pct?: string[];
}

export interface OddsUpdate {
  fixtureId: number;
  bookmakerId: number;
  bookmakerName: string;
  oddsType: string;
  inRunning: boolean;
  priceNames: string[];
  prices: number[];
  ts: number;
}

export interface ScoreSoccerTeam {
  Total: {
    Goals: number;
    YellowCards: number;
    RedCards: number;
    Corners: number;
  };
}

export interface DataSoccer {
  Goal: boolean;
  GoalType: "Head" | "Shot" | "OwnGoal" | "Other";
  Corner: boolean;
  YellowCard: boolean;
  RedCard: boolean;
  Penalty: boolean;
  VAR: boolean;
  FreeKickType: "Safe" | "Attack" | "Danger" | "HighDanger" | "Offside";
  ThrowInType: "Safe" | "Attack" | "Danger";
  Minutes: number;
  Participant: number;
  PlayerId: number;
}

export interface PossibleEvent {
  Goal: boolean;
  Penalty: boolean;
  Corner: boolean;
}

export type SoccerStatus = "NS" | "H1" | "HT" | "H2" | "F" | "ET1" | "ET2" | "PE";
export type PossessionType = "SafePossession" | "AttackPossession" | "DangerPossession" | "HighDangerPossession";

export interface ScoreEvent {
  fixtureId: number;
  gameState: string;
  statusSoccerId: SoccerStatus;
  scoreSoccer: {
    Participant1: ScoreSoccerTeam;
    Participant2: ScoreSoccerTeam;
  };
  dataSoccer?: DataSoccer;
  possessionType?: PossessionType;
  possession?: number;
  parti1StateSoccer?: { PossibleEvent: PossibleEvent };
  parti2StateSoccer?: { PossibleEvent: PossibleEvent };
  possibleEventSoccer?: { RedCard: boolean; YellowCard: boolean; VAR: boolean };
  ts: number;
  seq: number;
}

export interface RawFixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Participant1Id: number;
  Participant2Id: number;
  StartTime: number;
  CompetitionId: number;
  Competition: string;
  FixtureGroupId: number;
  Participant1IsHome: boolean;
  Ts: number;
}

export interface Fixture {
  fixtureId: number;
  team1: string;
  team2: string;
  startTime: number;
  leagueId: number;
  leagueName: string;
}
