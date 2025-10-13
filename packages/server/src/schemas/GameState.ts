import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("string")
  name = "";

  @type("string")
  skin = "yellow";

  // spectator role support: "bird" (default) or "gm" (spectator)
  @type("string")
  role: "bird" | "gm" = "bird";

  @type("number")
  y = 0;

  @type("number")
  velocity = 0;

  @type("boolean")
  alive = true;

  @type("number")
  score = 0;

  @type("number")
  lastPassedPipeId = 0;

  @type("boolean")
  ready = false;

  // Personal bests
  @type("number")
  birdHighScore = 0; // most pipes passed as a bird

  @type("number")
  pigBestTime = 0; // best (lowest) win time in seconds as GM; 0 means none yet

  // Temporary shield power-up state
  @type("boolean")
  shield = false;

  // Epoch timestamp (ms) when shield expires; 0 if inactive
  @type("number")
  shieldUntil = 0;

  // When true, shield is in 1s grace flashing state before removal
  @type("boolean")
  shieldExpiring = false;

  // Epoch timestamp (ms) when grace ends and shield is removed
  @type("number")
  shieldGraceUntil = 0;
}

export class PipeState extends Schema {
  @type("number")
  id = 0;

  @type("number")
  x = 0;

  @type("number")
  Ytop = 0;

  @type("number")
  Ybottom = 0;
}

export class PlacedObstacleState extends Schema {
  @type("number")
  id = 0;

  @type("number")
  x = 0;

  @type("number")
  y = 0; // top Y of the sprite

  // e.g. "top" | "bottom"
  @type("string")
  kind = "top";
}

export class PigKingState extends Schema {
  @type("number")
  health = 0;

  @type("number")
  maxHealth = 0;
}

export class PowerUpState extends Schema {
  @type("number")
  id = 0;

  @type("number")
  x = 0;

  @type("number")
  y = 0;

  // e.g. internal type id: "star", "shield", etc.
  @type("string")
  type = "";

  // Display name shown in UI/logs
  @type("string")
  name = "";

  // Phaser texture key for client sprite
  @type("string")
  sprite = "";
}

export class GameState extends Schema {
  @type({ map: PlayerState })
  players = new MapSchema<PlayerState>();

  @type([PipeState])
  pipes = new ArraySchema<PipeState>();

  // GM-placed obstacles (move with the world, collide with birds)
  @type([PlacedObstacleState])
  placedObstacles = new ArraySchema<PlacedObstacleState>();

  // Power-ups moving with the world
  @type([PowerUpState])
  powerUps = new ArraySchema<PowerUpState>();

  @type(["string"])
  skinOptions = new ArraySchema<string>();

  @type("boolean")
  running = false;

  @type("string")
  winnerId = "";

  @type("number")
  difficulty = 0;

  @type("number")
  stage = 0;

  // Optional convenience field to track who is GM (empty if none)
  @type("string")
  gameMasterId: string = "";

  // Global Game Master (Pig King) health shared with all clients
  @type(PigKingState)
  pigKing: PigKingState = new PigKingState();

  // Team win counters (persist across rounds for room lifetime)
  @type("number")
  birdWins: number = 0; // times birds (players) defeated Pig King

  @type("number")
  pigWins: number = 0; // times Pig King (GM) won by eliminating birds
}
