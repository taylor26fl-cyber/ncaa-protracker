export type GameStatus = "SCHEDULED" | "LIVE" | "FINAL";
export type Sportsbook = "HARDROCK";

export type Team = {
  id: string;
  name: string;
  shortName: string;
  conference?: string | null;
};

export type Game = {
  id: string;
  season: number;
  status: GameStatus;
  startTime: string;
  homeTeamId: string;
  awayTeamId: string;
  projSpreadHome: number | null;
  projTotal: number | null;
  projWinProbHome: number | null;
  finalHome?: number | null;
  finalAway?: number | null;
};

export type LineSnapshot = {
  id: string;
  gameId: string;
  sportsbook: Sportsbook;
  createdAt: string;
  spreadHome: number | null;
  total: number | null;
  mlHome: number | null;
  mlAway: number | null;
};

export type BetType = "SPREAD" | "TOTAL" | "MONEYLINE";
export type BetSide = "HOME" | "AWAY" | "OVER" | "UNDER";
export type BetResult = "PENDING" | "WIN" | "LOSS" | "PUSH";

export type Bet = {
  id: string;
  createdAt: string;
  gameId: string;
  betType: BetType;
  side: BetSide;
  line: number | null;
  price: number | null;
  stake: number;
  result: BetResult;
  payout: number | null;
  note?: string | null;
};

export type DB = {
  teams: Team[];
  games: Game[];
  lines: LineSnapshot[];
  bets: Bet[];
};
