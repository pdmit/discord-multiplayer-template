export type ReplicatedPlayerState = {
  /** Player display name shown on the scoreboard. */
  name: string;
  /** Cosmetic skin identifier (mirrors the Colyseus schema). */
  skin: "yellow" | "blue" | "red";
  /** Vertical position within the world (authoritative on the server). */
  y: number;
  /** Current vertical velocity applied by the simulation. */
  velocity: number;
  /** Whether the player is still alive in the current round. */
  alive: boolean;
  /** Score accumulated by passing pipes. */
  score: number;
  /** Identifier of the most recent pipe successfully cleared. */
  lastPassedPipeId: number;
  /** Lobby ready state toggled by each player. */
  ready: boolean;
};

export type ReplicatedPipeState = {
  /** Unique identifier assigned by the server when spawning the pipe pair. */
  id: number;
  /** Horizontal position used for sprite placement and collision. */
  x: number;
  /** Vertical centre of the pipe gap. */
  gapY: number;
};

export type ReplicatedRoomState = {
  /** Map keyed by Colyseus session id with the authoritative player state. */
  players: Map<string, ReplicatedPlayerState> & {
    forEach: (callback: (player: ReplicatedPlayerState, sessionId: string) => void) => void;
    get: (sessionId: string) => ReplicatedPlayerState | undefined;
    delete: (sessionId: string) => boolean;
    size: number;
  };
  /** Ordered list of pipes currently active in the world. */
  pipes: Array<ReplicatedPipeState> & { length: number };
  /** Whether the simulation is actively running. */
  running: boolean;
  /** Session id of the winning player when a multiplayer round ends. */
  winnerId: string;
};

export type ReplicatedChange = {
  field: string;
  value?: unknown;
  previousValue?: unknown;
};
