import { Client, Room } from "colyseus";
import { GameState, PlayerState, PipeState } from "../schemas/GameState";
import logger from "../logger";

export class GameRoom extends Room<GameState> {
  // Colyseus replicated state
  state = new GameState();
  maxClients = 25; // Current Discord limit is 25

  // Simulation configuration (not replicated)
  private readonly physics = {
    gravity: 400, // Reduced gravity for testing
    flapVelocity: -550,
  };

  private readonly pipesConfig = {
    speed: 220,
    intervalMs: 1800,
    gap: 230,
    width: 52,
  };

  private readonly world = {
    width: 1280,
    height: 720,
    floorHeight: 112,
  };

  private readonly bird = {
    x: 260,
    halfWidth: 17,
    halfHeight: 12,
  };

  private readonly roundConfig = {
    initialLaunchVelocity: -300,
    initialPipeSpacing: 280,
    initialPipeCount: 3,
  };

  private nextPipeId = 1;
  private elapsedSincePipe = 0;
  private readonly availableSkins: Array<PlayerState["skin"]> = ["yellow", "blue", "red"];

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

      player.velocity = this.physics.flapVelocity;
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
    player.y = this.world.height / 2;
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

    let selected: PlayerState["skin"] = this.availableSkins[0];
    let minCount = Number.MAX_SAFE_INTEGER;
    this.availableSkins.forEach((skin) => {
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
      player.y = this.world.height / 2;
      player.velocity = this.roundConfig.initialLaunchVelocity; // Give initial upward velocity to prevent immediate death
      player.score = 0;
      player.lastPassedPipeId = 0;
      logger.info(
        `Player initialized: y=${player.y}, velocity=${player.velocity}, alive=${player.alive}, worldHeight=${this.world.height}`,
      );
    }

    for (let i = 0; i < this.roundConfig.initialPipeCount; i += 1) {
      const offset = this.world.width + 200 + i * this.roundConfig.initialPipeSpacing;
      this.spawnPipePair(offset);
    }
    logger.info("Round started successfully");
  }

  private spawnPipePair(startX?: number) {
    const pipe = new PipeState();
    pipe.id = this.nextPipeId++;
    pipe.x = startX ?? this.world.width + 200;

    const minY = 180;
    const maxY = this.world.height - this.world.floorHeight - 180;
    pipe.gapY = minY + Math.random() * Math.max(0, maxY - minY);

    this.state.pipes.push(pipe);
    logger.info(`Pipe created: id=${pipe.id}, x=${pipe.x}, gapY=${pipe.gapY}, total pipes=${this.state.pipes.length}`);
  }

  private update(delta: number) {
    if (!this.state.running) {
      return;
    }

    this.elapsedSincePipe += delta * 1000;
    if (this.elapsedSincePipe >= this.pipesConfig.intervalMs) {
      this.elapsedSincePipe = 0;
      this.spawnPipePair();
    }

    const floorY = this.world.height - this.world.floorHeight;

    for (const [, player] of this.state.players) {
      if (!player.alive) {
        continue;
      }

      player.velocity += this.physics.gravity * delta;
      player.y += player.velocity * delta;

      if (player.y < this.bird.halfHeight) {
        player.y = this.bird.halfHeight;
      }

      if (player.y + this.bird.halfHeight >= floorY) {
        logger.warn(`Player hit floor at y=${player.y}, floorY=${floorY}`);
        player.y = floorY - this.bird.halfHeight;
        player.alive = false;
        continue;
      }

      for (const pipe of this.state.pipes) {
        const pipeLeft = pipe.x - this.pipesConfig.width / 2;
        const pipeRight = pipe.x + this.pipesConfig.width / 2;
        const gapTop = pipe.gapY - this.pipesConfig.gap / 2;
        const gapBottom = pipe.gapY + this.pipesConfig.gap / 2;

        const birdLeft = this.bird.x - this.bird.halfWidth;
        const birdRight = this.bird.x + this.bird.halfWidth;
        const birdTop = player.y - this.bird.halfHeight;
        const birdBottom = player.y + this.bird.halfHeight;

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
      pipe.x -= this.pipesConfig.speed * delta;
    }

    while (this.state.pipes.length > 0 && this.state.pipes[0].x < -this.pipesConfig.width) {
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
