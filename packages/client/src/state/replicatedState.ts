import type { ArraySchema, MapSchema, Schema } from "@colyseus/schema";

/**
 * Mirrors the Colyseus schema used on the server. Keeping the replicated
 * fields grouped together makes it easier to reason about what data flows from
 * the authoritative simulation to the client.
 */
export interface ReplicatedPlayerState extends Schema {
  name: string;
  skin: "yellow" | "blue" | "red";
  y: number;
  velocity: number;
  alive: boolean;
  score: number;
  lastPassedPipeId: number;
  ready: boolean;
}

export interface ReplicatedPipeState extends Schema {
  id: number;
  x: number;
  gapY: number;
}

export interface ReplicatedGameState extends Schema {
  players: MapSchema<ReplicatedPlayerState>;
  pipes: ArraySchema<ReplicatedPipeState>;
  running: boolean;
  winnerId: string;
}
