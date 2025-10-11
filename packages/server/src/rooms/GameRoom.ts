import { Client, Room } from "colyseus";
import { GameState, PlayerState, PipeState, PlacedObstacleState } from "../schemas/GameState";
import logger from "../logger";

export class GameRoom extends Room<GameState> {
  maxClients = 25; // Current Discord limit is 25

  private gravity = 800; // Reduced gravity for testing
  private flapVelocity = -250;
  private readonly basePipeSpeed = 220;
  private pipeSpeed = this.basePipeSpeed;
  private pipeInterval = 1000; // How often pipes are spawned (ms)
  private floorHeight = 112;
  private birdX = 260;
  private birdHalfWidth = 17;
  private birdHalfHeight = 12;
  private readonly pipeHeight = 315;
  private pipeWidth = 52;
  private nextPipeId = 1;
  private nextPlacedObstacleId = 10001;
  private elapsedSincePipe = 0;
  private obstacleDebugAccumulator = 0; // seconds
  private skins: Array<PlayerState["skin"]> = ["yellow", "blue", "red", "green", "purple", "orange"];
  private worldWidth = 1280;
  private worldHeight = 720;
  private pipeNoiseAmplitude = 200; // px
  private readonly stageCount = 5;
  private readonly stageDurationSeconds = 20; // seconds per stage escalation
  private readonly stageSpeedIncrement = 0.2; // +20% pipe speed per stage

  // Debug: expose internal schema refId when logging
  private refIdOf(obj: any) {
    try {
      return (obj as any)?.$changes?.refId ?? "n/a";
    } catch {
      return "n/a";
    }
  }

  // Difficulty -> vertical gap scaling (harder means smaller gap)
  private maxPipeGap = 300;              // px at difficulty 0 (easiest)
  private minPipeGap = 60;              // px clamp (hardest)
  private pipeGapShrinkPerSec = 2.4;      // px per second reduction

  private getCurrentPipeGap(): number {
    return Math.max(this.minPipeGap, this.maxPipeGap - (this.state.difficulty * this.pipeGapShrinkPerSec));
  }

  private hasGameMaster(): boolean {
    if (this.state.gameMasterId) {
      // quick path if tracked
      return Array.from(this.state.players.keys()).includes(this.state.gameMasterId);
    }
    for (const [, p] of this.state.players) {
      if ((p as any).role === "gm") return true;
    }
    return false;
  }

  private getStageForDifficulty(elapsedSeconds: number): number {
    if (!this.state.running) {
      return 0;
    }

    const stageIndex = Math.floor(elapsedSeconds / this.stageDurationSeconds);
    return Math.min(this.stageCount, stageIndex + 1);
  }

  private applyStage(stage: number) {
    const clampedStage = Math.max(0, Math.min(this.stageCount, Math.floor(stage)));
    if (this.state.stage !== clampedStage) {
      this.state.stage = clampedStage;
      logger.info(`Stage set to ${clampedStage}`);
    }

    const multiplier = clampedStage <= 0 ? 1 : 1 + this.stageSpeedIncrement * (clampedStage - 1);
    this.pipeSpeed = this.basePipeSpeed * multiplier;
    logger.info(`Pipe speed adjusted to ${this.pipeSpeed.toFixed(2)} (stage ${clampedStage})`);
  }

  onCreate(): void {
    // Properly register the state with Colyseus (ensures correct change-tree + ref ordering)
    this.setState(new GameState());
    this.populateSkinOptions();
    this.setSimulationInterval((deltaTime) => this.update(deltaTime / 1000));
    logger.info("GameRoom created: state initialized", {
      running: this.state.running,
      stage: this.state.stage,
      players: this.state.players.size,
      pipes: this.state.pipes.length,
      placedObstacles: this.state.placedObstacles.length,
    });

    this.onMessage("flap", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) {
        return;
      }

      // Ignore flaps from spectators (Game Master)
      if ((player as any).role === "gm") {
        return;
      }

      if (!this.state.running || !player.alive) {
        return;
      }
      console.log("flap message received");
      player.velocity = this.flapVelocity;
    });

    this.onMessage("setReady", (client, message: { ready?: boolean }) => {
      logger.info(`Received setReady from ${client.sessionId}:`, message);
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.running) {
        logger.warn(`Rejected setReady - player exists: ${!!player}, running: ${this.state.running}`);
        return;
      }

      // Spectators cannot ready up
      if ((player as any).role === "gm") {
        logger.warn(`Rejected setReady - spectator (gm) ${client.sessionId}`);
        return;
      }

      const newReadyState = Boolean(message?.ready);
      logger.info(`Setting player ${client.sessionId} ready state to: ${newReadyState}`);
      player.ready = newReadyState;
      this.tryStartRound();
    });

    this.onMessage("selectSkin", (client, message: { skin?: PlayerState["skin"] }) => {
      const skin = message?.skin;
      const player = this.state.players.get(client.sessionId);

      if (!player) {
        logger.warn(`selectSkin rejected - player not found for ${client.sessionId}`);
        return;
      }

      // Spectators (GM) cannot select a skin
      if ((player as any).role === "gm") {
        logger.warn(`selectSkin rejected - spectator (gm) ${client.sessionId}`);
        return;
      }

      if (typeof skin !== "string") {
        logger.warn(`selectSkin rejected - invalid payload from ${client.sessionId}:`, message);
        return;
      }

      if (!this.skins.includes(skin)) {
        logger.warn(`selectSkin rejected - skin "${skin}" not in allowed list for ${client.sessionId}`);
        return;
      }

      if (this.state.running) {
        logger.warn(`selectSkin rejected - game running (player ${client.sessionId})`);
        return;
      }

      const ownerSessionId = this.findSkinOwner(skin);
      if (ownerSessionId && ownerSessionId !== client.sessionId) {
        logger.warn(
          `selectSkin rejected - skin "${skin}" already taken by ${ownerSessionId}, requested by ${client.sessionId}`,
        );
        return;
      }

      if (player.skin === skin) {
        return;
      }

      logger.info(`Player ${client.sessionId} selected skin "${skin}"`);
      player.skin = skin;
      player.ready = false;
    });
  }

  onJoin(client: Client, options?: any): void {
    logger.info(`Client joined: ${client.sessionId}`);

    const player = new PlayerState();
    player.name = options?.name || `Bird ${client.sessionId.slice(0, 4)}`;
    // Role requested by client; enforce single GM
    const requestedRole = options?.role === "gm" ? "gm" : "bird";
    const canBeGm = requestedRole === "gm" && !this.hasGameMaster();
    player.role = canBeGm ? "gm" : "bird";
    if (canBeGm) {
      this.state.gameMasterId = client.sessionId;
      logger.info(`Assigned Game Master role to ${client.sessionId}`);
    }
    // Only birds get a skin; GM does not reserve a skin
    if (player.role === "bird") {
      player.skin = this.assignSkin();
    } else {
      player.skin = "";
    }
    player.y = this.worldHeight / 2;
    player.velocity = 0;
    player.alive = true;
    player.score = 0;
    player.lastPassedPipeId = 0;
    player.ready = false;

    this.state.players.set(client.sessionId, player);
    this.onMessage("gmPlaceObstacle", (client, message: { kind?: string; x?: number; y?: number }) => {
      logger.debug("gmPlaceObstacle received", { client: client.sessionId, message });
      const player = this.state.players.get(client.sessionId) as any;
      if (!player || player.role !== "gm") {
        logger.warn(`gmPlaceObstacle rejected - not GM: ${client.sessionId}`);
        return;
      }

      if (!this.state.running) {
        logger.warn(`gmPlaceObstacle rejected - game not running`);
        return;
      }

      const kind = (message?.kind ?? "").toString();
      if (kind !== "top" && kind !== "bottom") {
        logger.warn(`gmPlaceObstacle rejected - invalid kind: ${kind}`);
        return;
      }

      const x = Number(message?.x);
      const y = Number(message?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        logger.warn(`gmPlaceObstacle rejected - invalid coords: x=${message?.x}, y=${message?.y}`);
        return;
      }

      // Placement constraints
      // 1) X only in right 1/3 of screen
      const rightThirdMinX = Math.floor(this.worldWidth * (2 / 3));
      const rightThirdMaxX = this.worldWidth;
      const clampedX = Math.max(rightThirdMinX, Math.min(rightThirdMaxX, x));

      // 2/3/4) Vertical ranges with modifier = getCurrentPipeGap()/2
      // Allow sprites to extend off-screen except:
      //  - bottom of TOP pipe cannot be above top of screen -> (topY + pipeHeight) >= 0
      //  - top of BOTTOM pipe cannot be below bottom of screen -> (topY) <= worldHeight
      const midY = this.worldHeight / 2;
      const halfGap = this.getCurrentPipeGap() / 2;

      let clampedY = y;
      if (kind === "bottom") {
        // Top of bottom pipe must be within [midY + halfGap, worldHeight]
        const topMin = midY + halfGap;
        const topMax = this.worldHeight;
        clampedY = Math.max(topMin, Math.min(topMax, y));
      } else {
        // Clamp bottom of TOP pipe to [0, midY - halfGap], then derive topY = bottom - pipeHeight
        const desiredBottom = y + this.pipeHeight;
        const bottomMin = 0;
        const bottomMax = Math.max(bottomMin, midY - halfGap);
        const clampedBottom = Math.max(bottomMin, Math.min(bottomMax, desiredBottom));
        clampedY = clampedBottom - this.pipeHeight;
      }

      const obs = new PlacedObstacleState();
      obs.id = this.nextPlacedObstacleId++;
      obs.x = clampedX;
      obs.y = clampedY;
      obs.kind = kind;
      this.state.placedObstacles.push(obs);
      logger.info(`GM placed obstacle: id=${obs.id}, kind=${kind}, x=${obs.x}, y=${obs.y}`);
      logger.debug("placedObstacles length after add", { count: this.state.placedObstacles.length });
    });
  }

  onLeave(client: Client): void {
    logger.info(`Client left: ${client.sessionId}`);
    const existing = this.state.players.get(client.sessionId) as any;
    this.state.players.delete(client.sessionId);

    if (existing?.role === "gm" && this.state.gameMasterId === client.sessionId) {
      this.state.gameMasterId = "";
      logger.info(`Cleared Game Master role after ${client.sessionId} left`);
    }

    if (this.state.players.size === 0) {
      this.state.running = false;
      this.state.winnerId = "";
      // Defer clearing to next tick to avoid delete+patch ordering issues
      this.deferClearLevel();
      return;
    }

    if (!this.state.running) {
      this.tryStartRound();
    }
  }

  private assignSkin(): PlayerState["skin"] {
    const takenSkins = new Set<PlayerState["skin"]>();
    for (const [, player] of this.state.players) {
      if (player.skin) {
        takenSkins.add(player.skin);
      }
    }

    for (const skin of this.skins) {
      if (!takenSkins.has(skin)) {
        return skin;
      }
    }

    const fallback = this.skins[0] ?? "yellow";
    logger.warn(`All preferred skins in use. Falling back to "${fallback}"`);
    return fallback;
  }

  private findSkinOwner(skin: PlayerState["skin"]): string | null {
    for (const [sessionId, player] of this.state.players) {
      if (player.skin === skin) {
        return sessionId;
      }
    }

    return null;
  }

  private populateSkinOptions() {
    while (this.state.skinOptions.length > 0) {
      this.state.skinOptions.pop();
    }

    for (const skin of this.skins) {
      this.state.skinOptions.push(skin);
    }
  }

  private clearLevel() {
    this.elapsedSincePipe = 0;
    this.nextPipeId = 1;
    const pipesBefore = this.state.pipes.length;
    const placedBefore = this.state.placedObstacles ? this.state.placedObstacles.length : 0;
    // Remove pipes individually to ensure onRemove events fire consistently
    while (this.state.pipes.length > 0) {
      this.state.pipes.shift();
    }
    // Remove placed obstacles individually to ensure onRemove events fire
    while (this.state.placedObstacles && this.state.placedObstacles.length > 0) {
      this.state.placedObstacles.shift();
    }
    logger.info("clearLevel completed", { pipesBefore, placedBefore, pipesAfter: this.state.pipes.length, placedAfter: this.state.placedObstacles.length });
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

    let hasActive = false;
    for (const [, player] of this.state.players) {
      if ((player as any).role === "gm") {
        continue; // spectators don't block start
      }
      hasActive = true;
      if (!player.ready) {
        return;
      }
    }

    if (!hasActive) {
      // no birds to play; don't start
      return;
    }

    this.startRound();
  }

  private startRound() {
    logger.info(`Starting round with ${this.state.players.size} players`, {
      placedBeforeStart: this.state.placedObstacles.length,
      pipesBeforeStart: this.state.pipes.length,
    });
    this.state.running = true;
    this.state.winnerId = "";
    this.clearLevel();
    this.state.difficulty = 0;
    this.applyStage(1);

    for (const [, player] of this.state.players) {
      if ((player as any).role === "gm") {
        // Spectators don't participate in physics
        player.alive = true;
        player.velocity = 0;
        continue;
      }
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
    logger.info("Round started successfully", {
      pipesAfterInit: this.state.pipes.length,
      placedAfterClear: this.state.placedObstacles.length,
      speed: this.pipeSpeed,
    });
  }

  private spawnPipePair(startX?: number) {
    const pipe = new PipeState();
    pipe.id = this.nextPipeId++;
    pipe.x = startX ?? this.worldWidth + 200;

    // Use difficulty-scaled vertical gap (smaller with higher difficulty)
    const gap = this.getCurrentPipeGap();

    // Choose a vertical center that ensures both pipes fit the screen and floor constraints
    const floorY = this.worldHeight - this.floorHeight;
    const topMargin = 60; // keep some sky margin
    const bottomMargin = 60; // keep some floor margin

    const minTopTopY = topMargin; // top pipe's top Y must be >= this
    const maxBottomTopY = floorY - this.pipeHeight - bottomMargin; // bottom pipe's top Y must be <= this

    // Given: Ytop = center - gap/2 - pipeHeight, Ybottom = center + gap/2
    // Constraints ->
    //   center >= minTopTopY + pipeHeight + gap/2
    //   center <= maxBottomTopY - gap/2
    const centerMin = minTopTopY + this.pipeHeight + gap / 2;
    const centerMax = maxBottomTopY - gap / 2;

    // Guard against impossible ranges by clamping and falling back to midpoint
    const usableMin = Math.min(centerMin, centerMax);
    const usableMax = Math.max(centerMin, centerMax);
    //const center = usableMin + Math.random() * Math.max(0, usableMax - usableMin);
    const center = this.worldHeight / 2; // for testing, keep pipes centered
    const pipeCenter = center + ((Math.random() - 0.5) * this.pipeNoiseAmplitude); // add some noise

    pipe.Ybottom = pipeCenter + gap / 2;                 // bottom pipe's top Y
    pipe.Ytop = pipeCenter - gap / 2 - this.pipeHeight;  // top pipe's top Y

    this.state.pipes.push(pipe);
    logger.info(
      `Pipe created: id=${pipe.id}, ref=${this.refIdOf(pipe)}, x=${pipe.x}, Ytop=${pipe.Ytop}, Ybottom=${pipe.Ybottom}, gap=${gap}, diff=${this.state.difficulty.toFixed(2)}, total pipes=${this.state.pipes.length}`
    );
  }

  private update(delta: number) {
    if (!this.state.running) {
      if (this.state.stage !== 0) {
        this.applyStage(0);
      }
      return;
    }

    this.state.difficulty += delta;
    const stageForDifficulty = this.getStageForDifficulty(this.state.difficulty);
    if (stageForDifficulty !== this.state.stage) {
      this.applyStage(stageForDifficulty);
    }

    this.elapsedSincePipe += delta * 1000;
    if (this.elapsedSincePipe >= this.pipeInterval) {
      this.elapsedSincePipe = 0;
      this.spawnPipePair();
    }

    const floorY = this.worldHeight - this.floorHeight;

    // Important: remove expired pipes BEFORE mutating remaining ones
    // (avoids sending property patches on a pipe in the same tick it is deleted)
    while (this.state.pipes.length > 0 && this.state.pipes[0].x < -this.pipeWidth) {
      const removed = this.state.pipes.shift();
      logger.info(`Pipe removed (pre-move): id=${removed?.id}, ref=${this.refIdOf(removed)}`);
    }

    // Remove placed obstacles that left the screen (unordered removals supported)
    for (let i = this.state.placedObstacles.length - 1; i >= 0; i -= 1) {
      const obs = this.state.placedObstacles[i];
      if (obs.x < -this.pipeWidth) {
        const removed = this.state.placedObstacles.splice(i, 1)[0];
        logger.info(`Placed obstacle removed (pre-move): id=${removed?.id}`);
      }
    }

    for (const [, player] of this.state.players) {
      if ((player as any).role === "gm") {
        continue; // spectators not updated
      }
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
        const gapTop = pipe.Ytop;
        const gapBottom = pipe.Ybottom;

        const birdLeft = this.birdX - this.birdHalfWidth;
        const birdRight = this.birdX + this.birdHalfWidth;
        const birdTop = player.y - this.birdHalfHeight;
        const birdBottom = player.y + this.birdHalfHeight;

        if (birdRight > pipeLeft && birdLeft < pipeRight) {
          if (birdTop < gapTop || birdBottom > gapBottom) {
            logger.warn(`Player hit pipe at x=${pipe.x}, player y=${player.y}, Ytop=${pipe.Ytop}, Ybottom=${pipe.Ybottom}`);
            player.alive = false;
            break;
          }
        }

        if (pipeRight < birdLeft && pipe.id > player.lastPassedPipeId) {
          player.lastPassedPipeId = pipe.id;
          player.score += 1;
        }
      }

      // Collide against GM-placed obstacles (simple AABB)
      for (const obs of this.state.placedObstacles) {
        const obsLeft = obs.x - this.pipeWidth / 2;
        const obsRight = obs.x + this.pipeWidth / 2;
        const obsTop = obs.y;
        const obsBottom = obs.y + this.pipeHeight;

        const birdLeft = this.birdX - this.birdHalfWidth;
        const birdRight = this.birdX + this.birdHalfWidth;
        const birdTop = player.y - this.birdHalfHeight;
        const birdBottom = player.y + this.birdHalfHeight;

        if (birdRight > obsLeft && birdLeft < obsRight && birdBottom > obsTop && birdTop < obsBottom) {
          logger.warn(`Player hit placed obstacle id=${obs.id} kind=${obs.kind} at x=${obs.x}, y=${obs.y}`);
          player.alive = false;
          break;
        }
      }
    }

    for (const pipe of this.state.pipes) {
      pipe.x -= this.pipeSpeed * delta;
      // if (pipe.id == 1) {
      //   console.log(pipe.x);
      // }
    }

    for (const obs of this.state.placedObstacles) {
      obs.x -= this.pipeSpeed * delta;
    }

    // Periodic debug summary for placed obstacles movement
    this.obstacleDebugAccumulator += delta;
    if (this.obstacleDebugAccumulator >= 0.5) {
      this.obstacleDebugAccumulator = 0;
      const snapshot = this.state.placedObstacles.slice(0, 3).map((o) => ({ id: o.id, x: Number(o.x.toFixed?.(1) ?? o.x), y: o.y, kind: o.kind }));
      logger.debug("Obstacles tick", {
        running: this.state.running,
        speed: this.pipeSpeed,
        count: this.state.placedObstacles.length,
        sample: snapshot,
      });
    }

    const alivePlayers = Array.from(this.state.players.values()).filter((player: any) => player.alive && player.role !== "gm");
    const activeParticipants = Array.from(this.state.players.values()).filter((player: any) => player.role !== "gm").length;
    //logger.debug(`Update: ${alivePlayers.length} alive players out of ${this.state.players.size} total`);

    if (alivePlayers.length === 0) {
      // All players died - game over
      logger.info("Game over - all players died");
      this.state.running = false;
      this.state.winnerId = "";
      this.applyStage(0);
      // Defer clearing to next tick to avoid delete+patch ordering issues
      this.deferClearLevel();
      this.setAllPlayersReady(false);
      for (const [, player] of this.state.players) {
        player.velocity = 0;
      }
    } else if (alivePlayers.length === 1 && activeParticipants > 1) {
      // Multiplayer mode - one player wins
      logger.info("Multiplayer game over - winner:", this.findPlayerId(alivePlayers[0]));
      this.state.running = false;
      this.state.winnerId = this.findPlayerId(alivePlayers[0]);
      this.applyStage(0);
      // Defer clearing to next tick to avoid delete+patch ordering issues
      this.deferClearLevel();
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

  private deferClearLevel() {
    this.clock.setTimeout(() => {
      this.clearLevel();
    }, 0);
  }
}
