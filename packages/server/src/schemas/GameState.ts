import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("string")
  name = "";

  @type("string")
  skin: "yellow" | "blue" | "red" = "yellow";

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

export class GameState extends Schema {
  @type({ map: PlayerState })
  players = new MapSchema<PlayerState>();

  @type([PipeState])
  pipes = new ArraySchema<PipeState>();

  @type("boolean")
  running = false;

  @type("string")
  winnerId = "";
}
