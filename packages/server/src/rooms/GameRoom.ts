import { Client, Room } from "colyseus";
import { GameState, PlayerState, PipeState } from "../schemas/GameState";
import logger from "../logger";

export class GameRoom extends Room<GameState> {
  state = new GameState();
  maxClients = 25; // Current Discord limit is 25

  private gravity = 400; // Reduced gravity for testing
  private flapVelocity = -550;
  private pipeSpeed = 220;
  private pipeInterval = 1800;
  private pipeGap = 230;
  private floorHeight = 112;
  private birdX = 260;
  private birdHalfWidth = 17;
  private birdHalfHeight = 12;
  private pipeWidth = 52;
  private nextPipeId = 1;
  private elapsedSincePipe = 0;
  private skins: Array<PlayerState["skin"]> = ["yellow", "blue", "red"];

  private worldWidth = 1280;
  private worldHeight = 720;

  onCreate(): void {
    this.setSimulationInterval((deltaTime) => this.update(deltaTime / 1000));

    this.onMessage("flap", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) {
        return;
      }

      if (!this.state.running || !player.alive) {
        return;
      }

      player.velocity = this.flapVelocity;
    });

    this.onMessage("setReady", (client, message: { ready?: boolean }) => {
      logger.info(`Received setReady from ${client.sessionId}:`, message);
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.running) {
        logger.warn(`Rejected setReady - player exists: ${!!player}, running: ${this.state.running}`);
        return;
      }

      const newReadyState = Boolean(message?.ready);
      logger.info(`Setting player ${client.sessionId} ready state to: ${newReadyState}`);
      player.ready = newReadyState;
      this.tryStartRound();
    });
  }

  onJoin(client: Client, options?: any): void {
    logger.info(`Client joined: ${client.sessionId}`);

    const player = new PlayerState();
    player.name = options?.name || `Bird ${client.sessionId.slice(0, 4)}`;
    player.skin = this.assignSkin();
    player.y = this.worldHeight / 2;
    player.velocity = 0;
    player.alive = true;
    player.score = 0;
    player.lastPassedPipeId = 0;
    player.ready = false;

    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client): void {
    logger.info(`Client left: ${client.sessionId}`);
    this.state.players.delete(client.sessionId);

    if (this.state.players.size === 0) {
      this.state.running = false;
      this.state.winnerId = "";
      this.clearLevel();
      return;
    }

    if (!this.state.running) {
      this.tryStartRound();
    }
  }

  private assignSkin(): PlayerState["skin"] {
    const activeSkins = new Map<PlayerState["skin"], number>();
    for (const [, player] of this.state.players) {
      activeSkins.set(player.skin, (activeSkins.get(player.skin) || 0) + 1);
    }

    let selected: PlayerState["skin"] = this.skins[0];
    let minCount = Number.MAX_SAFE_INTEGER;
    this.skins.forEach((skin) => {
      const count = activeSkins.get(skin) || 0;
      if (count < minCount) {
        minCount = count;
        selected = skin;
      }
    });

    return selected;
  }

  private clearLevel() {
    this.elapsedSincePipe = 0;
    this.nextPipeId = 1;
    this.state.pipes.splice(0, this.state.pipes.length);
  }

  private setAllPlayersReady(value: boolean) {
    logger.info(`Setting all players ready to: ${value}`);
    for (const [, player] of this.state.players) {
      player.ready = value;
    }
  }

  private tryStartRound() {
    if (this.state.running || this.state.players.size === 0) {
      return;
    }

    for (const [, player] of this.state.players) {
      if (!player.ready) {
        return;
      }
    }

    this.startRound();
  }

  private startRound() {
    logger.info(`Starting round with ${this.state.players.size} players`);
    this.state.running = true;
    this.state.winnerId = "";
    this.clearLevel();

    for (const [, player] of this.state.players) {
      player.alive = true;
      player.y = this.worldHeight / 2;
      player.velocity = -300; // Give initial upward velocity to prevent immediate death
      player.score = 0;
      player.lastPassedPipeId = 0;
      logger.info(`Player initialized: y=${player.y}, velocity=${player.velocity}, alive=${player.alive}, worldHeight=${this.worldHeight}`);
    }

    const initialSpacing = 280;
    for (let i = 0; i < 3; i += 1) {
      this.spawnPipePair(this.worldWidth + 200 + i * initialSpacing);
    }
    logger.info("Round started successfully");
  }

  private spawnPipePair(startX?: number) {
    const pipe = new PipeState();
    pipe.id = this.nextPipeId++;
    pipe.x = startX ?? this.worldWidth + 200;

    const minY = 180;
    const maxY = this.worldHeight - this.floorHeight - 180;
    pipe.gapY = minY + Math.random() * Math.max(0, maxY - minY);

    this.state.pipes.push(pipe);
    logger.info(`Pipe created: id=${pipe.id}, x=${pipe.x}, gapY=${pipe.gapY}, total pipes=${this.state.pipes.length}`);
  }

  private update(delta: number) {
    if (!this.state.running) {
      return;
    }

    this.elapsedSincePipe += delta * 1000;
    if (this.elapsedSincePipe >= this.pipeInterval) {
      this.elapsedSincePipe = 0;
      this.spawnPipePair();
    }

    const floorY = this.worldHeight - this.floorHeight;

    for (const [, player] of this.state.players) {
      if (!player.alive) {
        continue;
      }

      player.velocity += this.gravity * delta;
      player.y += player.velocity * delta;

      if (player.y < this.birdHalfHeight) {
        player.y = this.birdHalfHeight;
      }

      if (player.y + this.birdHalfHeight >= floorY) {
        logger.warn(`Player hit floor at y=${player.y}, floorY=${floorY}`);
        player.y = floorY - this.birdHalfHeight;
        player.alive = false;
        continue;
      }

      for (const pipe of this.state.pipes) {
        const pipeLeft = pipe.x - this.pipeWidth / 2;
        const pipeRight = pipe.x + this.pipeWidth / 2;
        const gapTop = pipe.gapY - this.pipeGap / 2;
        const gapBottom = pipe.gapY + this.pipeGap / 2;

        const birdLeft = this.birdX - this.birdHalfWidth;
        const birdRight = this.birdX + this.birdHalfWidth;
        const birdTop = player.y - this.birdHalfHeight;
        const birdBottom = player.y + this.birdHalfHeight;

        if (birdRight > pipeLeft && birdLeft < pipeRight) {
          if (birdTop < gapTop || birdBottom > gapBottom) {
            logger.warn(`Player hit pipe at x=${pipe.x}, player y=${player.y}, gapY=${pipe.gapY}`);
            player.alive = false;
            break;
          }
        }

        if (pipeRight < birdLeft && pipe.id > player.lastPassedPipeId) {
          player.lastPassedPipeId = pipe.id;
          player.score += 1;
        }
      }
    }

    for (const pipe of this.state.pipes) {
      pipe.x -= this.pipeSpeed * delta;
    }

    while (this.state.pipes.length > 0 && this.state.pipes[0].x < -this.pipeWidth) {
      this.state.pipes.shift();
    }

    const alivePlayers = Array.from(this.state.players.values()).filter((player) => player.alive);
    logger.debug(`Update: ${alivePlayers.length} alive players out of ${this.state.players.size} total`);
    
    if (alivePlayers.length === 0) {
      // All players died - game over
      logger.info("Game over - all players died");
      this.state.running = false;
      this.state.winnerId = "";
      this.clearLevel();
      this.setAllPlayersReady(false);
      for (const [, player] of this.state.players) {
        player.velocity = 0;
      }
    } else if (alivePlayers.length === 1 && this.state.players.size > 1) {
      // Multiplayer mode - one player wins
      logger.info("Multiplayer game over - winner:", this.findPlayerId(alivePlayers[0]));
      this.state.running = false;
      this.state.winnerId = this.findPlayerId(alivePlayers[0]);
      this.clearLevel();
      this.setAllPlayersReady(false);
      for (const [, player] of this.state.players) {
        player.velocity = 0;
      }
    }
    // Single player mode - let them play until they die (no auto-win)
  }

  private findPlayerId(target: PlayerState | null): string {
    if (!target) {
      return "";
    }

    for (const [sessionId, player] of this.state.players) {
      if (player === target) {
        return sessionId;
      }
    }

    return "";
  }
}
