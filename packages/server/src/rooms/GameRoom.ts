import { Client, Room } from "colyseus";
import { GameState, PlayerState, PipeState, PlacedObstacleState, PowerUpState } from "../schemas/GameState";
import logger from "../logger";

class PowerUpDef {
  constructor(
    public type: string,
    public name: string,
    public sprite: string,
    public intervalSec: number = 15,
  ) { }

  spawn(id: number, x: number, y: number): PowerUpState {
    const pu = new PowerUpState();
    pu.id = id;
    pu.type = this.type;
    pu.name = this.name;
    pu.sprite = this.sprite;
    pu.x = x;
    pu.y = y;
    return pu;
  }
}

export class GameRoom extends Room<GameState> {
  maxClients = 25; // Current Discord limit is 25

  private gravity = 800; // Reduced gravity for testing
  private flapVelocity = -250;
  private readonly basePipeSpeed = 220;
  private pipeSpeed = this.basePipeSpeed;
  // Pipe spawn intervals (ms)
  private readonly pvePipeIntervalMs = 1000; // PvE (no GM)
  private readonly pvpPipeIntervalMs = 3000; // PvP (GM present)
  private pipeInterval = this.pvePipeIntervalMs; // active interval
  private floorHeight = 112;
  private birdX = 260;
  private birdHalfWidth = 17;
  private birdHalfHeight = 12;
  private readonly pipeHeight = 315;
  private pipeWidth = 52;
  private nextPipeId = 1;
  private nextPlacedObstacleId = 10001;
  private nextPowerUpId = 50001;
  private elapsedSincePipe = 0;
  private powerUpElapsed = 0; // seconds
  private obstacleDebugAccumulator = 0; // seconds
  private gmCharges = new Map<string, { charges: number; lastRechargeAt: number }>();
  private numObstacleCharges = 3;
  private obstacleRechargeSeconds = 2;
  private readonly powerUpPickupRadius = 28; // px
  private skins: Array<PlayerState["skin"]> = ["yellow", "blue", "red", "green", "purple", "orange"];
  private worldWidth = 1280;
  private worldHeight = 720;
  private pipeNoiseAmplitude = 200; // px
  private readonly stageCount = 5;
  private readonly stageDurationSeconds = 20; // seconds per stage escalation
  private readonly stageSpeedIncrement = 0.2; // +20% pipe speed per stage
  private readonly powerUpIntervalSec = 3; // fallback interval if def not sampled
  private powerUpDefs: PowerUpDef[] = [
    new PowerUpDef("coin", "+2 Points!", "coin", 3),
    new PowerUpDef("hammer", "Hammer Time!", "hammer", 3),
    new PowerUpDef("star", "Shield!", "star", 3),
  ];
  private currentPowerUpIntervalSec = this.powerUpIntervalSec;

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

  private sendGMChargeUpdate(sessionId: string) {
    const client = this.clients.find(c => c.sessionId === sessionId);
    if (!client) return;

    const now = Date.now();
    let entry = this.gmCharges.get(sessionId);
    if (!entry) {
      entry = { charges: this.numObstacleCharges, lastRechargeAt: now };
      this.gmCharges.set(sessionId, entry);
    }

    const nextInMs = entry.charges >= this.numObstacleCharges
      ? 0
      : (this.obstacleRechargeSeconds * 1000 - ((now - entry.lastRechargeAt) % (this.obstacleRechargeSeconds * 1000)));

    client.send("gmChargeUpdate", {
      charges: entry.charges,
      max: this.numObstacleCharges,
      nextInMs
    });
    logger.debug(`Sent gmChargeUpdate to ${sessionId}:`, { charges: entry.charges, max: this.numObstacleCharges, nextInMs });
  }

  onCreate(): void {
    // Properly register the state with Colyseus (ensures correct change-tree + ref ordering)
    this.setState(new GameState());
    // Initialize Pig King defaults on room creation (will also be reset each round)
    this.resetPigKingHealth(5);
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

      // Ignore flaps from non-playing roles (GM or spectator)
      if ((player as any).role === "gm" || (player as any).role === "spectator") {
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

      // Non-playing roles cannot ready up
      if ((player as any).role === "gm" || (player as any).role === "spectator") {
        logger.warn(`Rejected setReady - non-player (${(player as any).role}) ${client.sessionId}`);
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

      // Non-playing roles cannot select a skin
      if ((player as any).role === "gm" || (player as any).role === "spectator") {
        logger.warn(`selectSkin rejected - non-player (${(player as any).role}) ${client.sessionId}`);
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

    // Note: No client message is exposed to damage Pig King.
    // Damage must be triggered by server-side game logic only.
  }

  onJoin(client: Client, options?: any): void {
    logger.info(`Client joined: ${client.sessionId}`);

    const player = new PlayerState();
    player.name = options?.name || `Bird ${client.sessionId.slice(0, 4)}`;
    // Role requested by client; assign spectator if a round is running
    const requestedRole = options?.role === "gm" ? "gm" : "bird";
    let assignedRole: PlayerState["role"] = "bird";
    if (this.state.running) {
      assignedRole = "spectator";
    } else if (requestedRole === "gm" && !this.hasGameMaster()) {
      assignedRole = "gm";
    } else {
      assignedRole = "bird";
    }
    player.role = assignedRole;
    if (assignedRole === "gm") {
      this.state.gameMasterId = client.sessionId;
      logger.info(`Assigned Game Master role to ${client.sessionId}`);
      // Initialize GM charges (2 max, 5s recharge)
      const now = Date.now();
      this.gmCharges.set(client.sessionId, { charges: this.numObstacleCharges, lastRechargeAt: now });
      this.sendGMChargeUpdate(client.sessionId);
    }
    // Only birds get a skin; GM and spectators do not reserve a skin
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

      // Charge gating
      const now = Date.now();
      let entry = this.gmCharges.get(client.sessionId);
      if (!entry) {
        entry = { charges: 3, lastRechargeAt: now };
        this.gmCharges.set(client.sessionId, entry);
      }

      if (entry.charges <= 0) {
        logger.warn(`gmPlaceObstacle rejected - no charges`);
        this.sendGMChargeUpdate(client.sessionId);
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
      //const halfGap = this.getCurrentPipeGap() / 2;
      const halfGap = 0;

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

      // Spend charge and reset recharge timer
      entry.charges = Math.max(0, entry.charges - 1);
      entry.lastRechargeAt = now; // Reset timer when spending a charge
      this.sendGMChargeUpdate(client.sessionId);
    });

    // GM cursor position update
    this.onMessage("gmCursorMove", (client, message: { x?: number; y?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.role !== "gm") {
        return; // Only GM can update cursor
      }

      // Validate coordinates
      if (typeof message?.x === "number" && typeof message?.y === "number") {
        this.state.gmCursorX = message.x;
        this.state.gmCursorY = message.y;
      }
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
    this.gmCharges.delete(client.sessionId);

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
    this.powerUpElapsed = 0;
    this.nextPipeId = 1;
    const pipesBefore = this.state.pipes.length;
    const placedBefore = this.state.placedObstacles ? this.state.placedObstacles.length : 0;
    const powerUpsBefore = this.state.powerUps ? this.state.powerUps.length : 0;
    // Remove pipes individually to ensure onRemove events fire consistently
    while (this.state.pipes.length > 0) {
      this.state.pipes.shift();
    }
    // Remove placed obstacles individually to ensure onRemove events fire
    while (this.state.placedObstacles && this.state.placedObstacles.length > 0) {
      this.state.placedObstacles.shift();
    }
    while ((this.state as any).powerUps && this.state.powerUps.length > 0) {
      this.state.powerUps.shift();
    }
    logger.info("clearLevel completed", { pipesBefore, placedBefore, powerUpsBefore, pipesAfter: this.state.pipes.length, placedAfter: this.state.placedObstacles.length, powerUpsAfter: this.state.powerUps.length });
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
      if ((player as any).role === "gm" || (player as any).role === "spectator") {
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

    // Reset Pig King at the start of each round
    this.resetPigKingHealth(5);

    for (const [, player] of this.state.players) {
      if ((player as any).role === "gm" || (player as any).role === "spectator") {
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
      // Clear any lingering power-ups
      (player as any).shield = false;
      (player as any).shieldUntil = 0;
      (player as any).shieldExpiring = false;
      (player as any).shieldGraceUntil = 0;
      logger.info(`Player initialized: y=${player.y}, velocity=${player.velocity}, alive=${player.alive}, worldHeight=${this.worldHeight}`);
    }

    const initialSpacing = 280;
    for (let i = 0; i < 1; i += 1) {
      this.spawnPipePair(this.worldWidth + 200 + i * initialSpacing);
    }
    // Reset power-up spawn timer
    this.powerUpElapsed = 0;
    logger.info("Round started successfully", {
      pipesAfterInit: this.state.pipes.length,
      placedAfterClear: this.state.placedObstacles.length,
      powerUpsAfterClear: this.state.powerUps.length,
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

  private killPlayer(player: PlayerState, reason: string) {
    //return; // DEBUG: disable death
    player.alive = false;
    // Update personal bird high score on death
    try {
      const current = Math.max(0, Math.floor(player.score ?? 0));
      const prevBest = Math.max(0, Math.floor((player as any).birdHighScore ?? 0));
      if (current > prevBest) {
        (player as any).birdHighScore = current;
      }
    } catch { /* no-op */ }
    logger.info(`Player ${this.findPlayerId(player) ?? "<unknown>"} died: ${reason}`);
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

    // Adjust pipe spawn rate based on GM presence
    const hasGM = this.hasGameMaster();
    const desiredInterval = hasGM ? this.pvpPipeIntervalMs : this.pvePipeIntervalMs;
    if (desiredInterval !== this.pipeInterval) {
      this.pipeInterval = desiredInterval;
      logger.info(`Pipe interval set to ${this.pipeInterval}ms (${hasGM ? "PvP (GM present)" : "PvE"})`);
    }

    // Accumulate spawn timer in milliseconds (delta is seconds)
    this.elapsedSincePipe += delta * 1000;

    // Spawn power-ups at fixed interval (in seconds) while running
    this.powerUpElapsed += delta;
    if (this.powerUpElapsed >= this.currentPowerUpIntervalSec) {
      this.powerUpElapsed = 0;
      this.spawnPowerUp();
    }

    const floorY = this.worldHeight - this.floorHeight;

    // Important: remove expired pipes BEFORE mutating remaining ones
    // (avoids sending property patches on a pipe in the same tick it is deleted)
    //while (this.state.pipes.length > 0 && this.state.pipes[0].x < -this.pipeWidth) {
    //const removed = this.state.pipes.shift();
    //logger.info(`Pipe removed (pre-move): id=${removed?.id}, ref=${this.refIdOf(removed)}`);
    //}

    // Remove placed pipes that left the screen (unordered removals supported)
    for (let i = this.state.pipes.length - 1; i >= 0; i -= 1) {
      const obs = this.state.pipes[i];
      if (obs.x < -this.pipeWidth) {
        const removed = this.state.pipes.splice(i, 1)[0];
        logger.info(`Pipe removed (pre-move): id=${removed?.id}`);
      }
    }

    // Remove placed obstacles that left the screen (unordered removals supported)
    for (let i = this.state.placedObstacles.length - 1; i >= 0; i -= 1) {
      const obs = this.state.placedObstacles[i];
      if (obs.x < -this.pipeWidth) {
        const removed = this.state.placedObstacles.splice(i, 1)[0];
        logger.info(`Placed obstacle removed (pre-move): id=${removed?.id}`);
      }
    }

    // Remove off-screen power-ups (unordered removals supported)
    for (let i = this.state.powerUps.length - 1; i >= 0; i -= 1) {
      const pu = this.state.powerUps[i];
      if (pu.x < -this.pipeWidth) {
        const removed = this.state.powerUps.splice(i, 1)[0];
        logger.info(`PowerUp removed (off-screen): id=${removed?.id}, type=${(removed as any)?.type}`);
      }
    }

    // Player collision and movement update, GM recharge logic
    const nowMs = Date.now();
    for (const [, player] of this.state.players) {
      if ((player as any).role === "spectator") {
        continue;
      }

      if ((player as any).role === "gm") {
        const clientSessionId = this.findPlayerId(player);
        if (!clientSessionId) continue;

        let entry = this.gmCharges.get(clientSessionId);
        if (!entry) {
          // Initialize GM charges if not present
          entry = { charges: this.numObstacleCharges, lastRechargeAt: nowMs };
          this.gmCharges.set(clientSessionId, entry);
        }

        // Only process recharge if below max charges
        if (entry.charges < this.numObstacleCharges) {
          const elapsed = nowMs - entry.lastRechargeAt;
          const rechargeIntervalMs = this.obstacleRechargeSeconds * 1000;

          if (elapsed >= rechargeIntervalMs) {
            const gained = Math.floor(elapsed / rechargeIntervalMs);
            const oldCharges = entry.charges;
            entry.charges = Math.min(this.numObstacleCharges, entry.charges + gained);
            entry.lastRechargeAt += gained * rechargeIntervalMs;

            // Only notify client if charges actually increased
            if (entry.charges > oldCharges) {
              this.sendGMChargeUpdate(clientSessionId);
              logger.debug(`GM ${clientSessionId} recharged: ${oldCharges} -> ${entry.charges}`);
            }
          }
        }
      }

      if (!player.alive) {
        continue;
      }

      // Snapshot shield state at start of tick (base duration or grace timer)
      const baseShieldActive = ((player as any).shield === true) && (Number((player as any).shieldUntil || 0) > nowMs);
      const graceShieldActive = ((player as any).shieldExpiring === true) && (Number((player as any).shieldGraceUntil || 0) > nowMs);
      let shieldActiveThisTick = baseShieldActive || graceShieldActive;

      player.velocity += this.gravity * delta;
      player.y += player.velocity * delta;

      if (player.y < this.birdHalfHeight) {
        player.y = this.birdHalfHeight;
      }

      if (player.y + this.birdHalfHeight >= floorY) {
        //logger.warn(`Player hit floor at y=${player.y}, floorY=${floorY}`);
        player.y = floorY - this.birdHalfHeight;
        if (!shieldActiveThisTick) {
          this.killPlayer(player, "floor collision");
          continue;
        } else {
          // Start 1s grace timer if not already expiring
          if (!(player as any).shieldExpiring) {
            (player as any).shieldExpiring = true;
            (player as any).shieldGraceUntil = nowMs + 1000;
            logger.info(`Shield entering grace (floor) for player ${this.findPlayerId(player) ?? "<unknown>"}`);
          }
          // Keep invulnerable for rest of this tick
          shieldActiveThisTick = true;
        }
      }

      for (const pipe of this.state.pipes) {
        const pipeLeft = pipe.x - this.pipeWidth / 2;
        const pipeRight = pipe.x + this.pipeWidth / 2;
        const gapTop = pipe.Ytop + this.pipeHeight; // Bottom of top pipe (start of gap)
        const gapBottom = pipe.Ybottom; // Top of bottom pipe (end of gap)

        const birdLeft = this.birdX - this.birdHalfWidth;
        const birdRight = this.birdX + this.birdHalfWidth;
        const birdTop = player.y - this.birdHalfHeight;
        const birdBottom = player.y + this.birdHalfHeight;

        if (birdRight > pipeLeft && birdLeft < pipeRight) {
          if (birdTop < gapTop || birdBottom > gapBottom) {
            logger.warn(`Player hit pipe at x=${pipe.x}, player y=${player.y}, Ytop=${pipe.Ytop}, Ybottom=${pipe.Ybottom}${shieldActiveThisTick ? " [shielded]" : ""}`);
            if (!shieldActiveThisTick) {
              this.killPlayer(player, `pipe collision (id=${pipe.id})`);
              break;
            } else {
              // Start 1s grace timer if not already expiring
              if (!(player as any).shieldExpiring) {
                (player as any).shieldExpiring = true;
                (player as any).shieldGraceUntil = nowMs + 1000;
                logger.info(`Shield entering grace (pipe) for player ${this.findPlayerId(player) ?? "<unknown>"}`);
              }
              // Remain invulnerable for rest of this tick only
              shieldActiveThisTick = true;
              // Do not break; allow continued update
            }
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
          logger.warn(`Player hit placed obstacle id=${obs.id} kind=${obs.kind} at x=${obs.x}, y=${obs.y}${shieldActiveThisTick ? " [shielded]" : ""}`);
          if (!shieldActiveThisTick) {
            this.killPlayer(player, `placed obstacle collision (id=${obs.id}, kind=${obs.kind})`);
            break;
          } else {
            // Start 1s grace timer if not already expiring
            if (!(player as any).shieldExpiring) {
              (player as any).shieldExpiring = true;
              (player as any).shieldGraceUntil = nowMs + 1000;
              logger.info(`Shield entering grace (obstacle) for player ${this.findPlayerId(player) ?? "<unknown>"}`);
            }
            // Remain invulnerable for rest of this tick only
            shieldActiveThisTick = true;
            // Do not break; allow continued update
          }
        }
      }

      // Power-up pickup (circle collision around power-up center)
      for (let i = this.state.powerUps.length - 1; i >= 0; i -= 1) {
        const pu = this.state.powerUps[i];
        const dx = this.birdX - pu.x;
        const dy = player.y - pu.y;
        if (dx * dx + dy * dy <= this.powerUpPickupRadius * this.powerUpPickupRadius) {
          // Apply effect and remove
          this.applyPowerUpEffect(player, pu);
          const removed = this.state.powerUps.splice(i, 1)[0];
          const pid = this.findPlayerId(player);
          logger.info(`PowerUp picked: player=${pid}, id=${removed?.id}, type=${removed?.type}`);
          // Notify clients for FX/UI
          if (pid) {
            this.broadcast("powerUpPicked", { playerId: pid, type: pu.type, name: pu.name, x: pu.x, y: pu.y });
          }
          break; // one power-up per player per tick
        }
      }

      // Handle natural expiry -> enter grace if not already
      if ((player as any).shield === true && Number((player as any).shieldUntil || 0) > 0 && nowMs >= Number((player as any).shieldUntil)) {
        if (!(player as any).shieldExpiring) {
          (player as any).shieldExpiring = true;
          (player as any).shieldGraceUntil = nowMs + 1000;
          const pid = this.findPlayerId(player);
          logger.info(`Shield entering grace (natural expiry) for player ${pid ?? "<unknown>"}`);
        }
      }

      // Finalize grace expiry -> remove shield fully
      if ((player as any).shieldExpiring === true && Number((player as any).shieldGraceUntil || 0) > 0 && nowMs >= Number((player as any).shieldGraceUntil)) {
        (player as any).shield = false;
        (player as any).shieldUntil = 0;
        (player as any).shieldExpiring = false;
        (player as any).shieldGraceUntil = 0;
        const pid = this.findPlayerId(player);
        logger.info(`Shield expired (grace complete) for player ${pid ?? "<unknown>"}`);
      }
    }

    for (const pipe of this.state.pipes) {
      pipe.x -= this.pipeSpeed * delta;
    }

    for (const obs of this.state.placedObstacles) {
      obs.x -= this.pipeSpeed * delta;
    }

    // Move power-ups with the world
    for (let i = this.state.powerUps.length - 1; i >= 0; i -= 1) {
      const pu = this.state.powerUps[i];
      pu.x = pu.x - (this.pipeSpeed * delta);
    }

    // Spawn new pipes AFTER removals and movements to avoid
    // delete+patch ordering issues on the same tick.
    if (this.elapsedSincePipe >= this.pipeInterval) {
      this.elapsedSincePipe = 0;
      this.spawnPipePair();
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

    const alivePlayers = Array.from(this.state.players.values()).filter((player: any) => player.alive && player.role === "bird");
    const activeParticipants = Array.from(this.state.players.values()).filter((player: any) => player.role === "bird").length;
    //logger.debug(`Update: ${alivePlayers.length} alive players out of ${this.state.players.size} total`);

    if (alivePlayers.length === 0) {
      // Pig King wins if all birds die
      logger.info("Round over - Pig King wins (all birds died)");
      this.state.running = false;
      // Prefer GM sessionId; fallback to special token
      this.state.winnerId = this.state.gameMasterId || "__PIG__";
      // Increment team win counter
      try { this.state.pigWins = Math.max(0, Math.floor((this.state.pigWins ?? 0))) + 1; } catch { }
      // Update GM personal best time (lower is better) when a GM exists
      try {
        const gmId = this.state.gameMasterId;
        if (gmId) {
          const gm = this.state.players.get(gmId);
          if (gm) {
            const t = Number(this.state.difficulty ?? 0);
            const prev = Number((gm as any).pigBestTime ?? 0);
            if (prev <= 0 || (Number.isFinite(t) && t > 0 && t < prev)) {
              (gm as any).pigBestTime = t;
            }
          }
        }
      } catch { /* no-op */ }
      this.applyStage(0);
      // Defer clearing to next tick to avoid delete+patch ordering issues
      this.deferClearLevel();
      this.setAllPlayersReady(false);
      for (const [, player] of this.state.players) {
        player.velocity = 0;
      }
    }

    // If no players remain, stop the game
    if (this.state.players.size === 0) {
      this.state.running = false;
      this.applyStage(0);
      // Defer clearing to next tick to avoid delete+patch ordering issues
      this.deferClearLevel();
      this.setAllPlayersReady(false);
      logger.warn("No players remaining; stopping game");
      return;
    }
    // Otherwise, keep playing until birds or pig king win
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

  // -- Pig King (GM) Health Management -------------------------------------
  private resetPigKingHealth(max: number) {
    const m = Math.max(0, Math.floor(max));
    this.state.pigKing.maxHealth = m;
    this.state.pigKing.health = m;
  }

  private damagePigKing(amount: number = 1) {
    const a = Math.max(0, Math.floor(amount));
    if (a <= 0) return;
    const prev = this.state.pigKing.health;
    const next = Math.max(0, prev - a);
    if (next === prev) return;
    this.state.pigKing.health = next;
    logger.info(`Pig King took ${a} damage (${prev} -> ${next})`);
    if (this.state.pigKing.health <= 0 && this.state.running) {
      // Birds win when Pig King health reaches 0
      logger.info("Round over - Birds defeated Pig King");
      this.state.running = false;
      this.state.winnerId = "__BIRDS__";
      // Increment team win counter
      try { this.state.birdWins = Math.max(0, Math.floor((this.state.birdWins ?? 0))) + 1; } catch { }
      // Update bird personal bests for all participants based on their final score
      try {
        for (const [, p] of this.state.players) {
          const role = (p as any).role;
          if (role === "gm" || role === "spectator") continue;
          const current = Math.max(0, Math.floor(p.score ?? 0));
          const prevBest = Math.max(0, Math.floor((p as any).birdHighScore ?? 0));
          if (current > prevBest) {
            (p as any).birdHighScore = current;
          }
        }
      } catch { /* no-op */ }
      this.applyStage(0);
      this.deferClearLevel();
      this.setAllPlayersReady(false);
      for (const [, player] of this.state.players) {
        player.velocity = 0;
      }
    }
  }

  // -- Power-Ups ------------------------------------------------------------
  // Compute blocked vertical ranges at a given X due to pipes/obstacles.
  // Returns a list of [startY, endY] intervals (inclusive of a small margin)
  // Only check pipes that are close enough in X to potentially collide with the power-up.
  // Since both move at the same speed, we only care about their INITIAL relative X distance.
  private getBlockedYRangesAtX(x: number, minY: number, maxY: number): Array<[number, number]> {
    const halfW = this.pipeWidth / 2;
    const safety = 8; // Small buffer to avoid edge clipping

    // Only check pipes within this X distance (they'll collide if closer than pipeWidth + powerup size)
    // Add extra margin for pickup radius and some safety
    const maxDeltaX = this.pipeWidth + this.powerUpPickupRadius * 2 + 20;

    const ranges: Array<[number, number]> = [];

    // Only check pipes that are horizontally close enough to matter
    for (const pipe of this.state.pipes) {
      const deltaX = Math.abs(x - pipe.x);

      // Skip pipes that are too far away horizontally - they'll never collide with this power-up
      if (deltaX > maxDeltaX) {
        continue;
      }

      // top pipe: [Ytop, Ytop + pipeHeight]
      const topStart = Math.max(minY, pipe.Ytop - safety);
      const topEnd = Math.min(maxY, pipe.Ytop + this.pipeHeight + safety);
      if (topStart < topEnd) {
        ranges.push([topStart, topEnd]);
        //logger.debug(`Blocked range (top pipe): id=${pipe.id}, pipeX=${pipe.x.toFixed(1)}, deltaX=${deltaX.toFixed(1)}, Y=[${topStart.toFixed(1)}, ${topEnd.toFixed(1)}]`);
      }
      // bottom pipe: [Ybottom, Ybottom + pipeHeight]
      const botStart = Math.max(minY, pipe.Ybottom - safety);
      const botEnd = Math.min(maxY, pipe.Ybottom + this.pipeHeight + safety);
      if (botStart < botEnd) {
        ranges.push([botStart, botEnd]);
        //logger.debug(`Blocked range (bottom pipe): id=${pipe.id}, pipeX=${pipe.x.toFixed(1)}, deltaX=${deltaX.toFixed(1)}, Y=[${botStart.toFixed(1)}, ${botEnd.toFixed(1)}]`);
      }
    }

    // GM-placed obstacles - only check nearby ones
    for (const obs of this.state.placedObstacles) {
      const deltaX = Math.abs(x - obs.x);

      if (deltaX > maxDeltaX) {
        continue;
      }

      const start = Math.max(minY, obs.y - safety);
      const end = Math.min(maxY, obs.y + this.pipeHeight + safety);
      if (start < end) {
        ranges.push([start, end]);
        logger.debug(`Blocked range (obstacle): id=${obs.id}, obsX=${obs.x.toFixed(1)}, deltaX=${deltaX.toFixed(1)}, Y=[${start.toFixed(1)}, ${end.toFixed(1)}]`);
      }
    }

    // Merge overlapping ranges
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (!last || r[0] > last[1]) {
        merged.push([r[0], r[1]]);
      } else {
        last[1] = Math.max(last[1], r[1]);
      }
    }
    return merged;
  }

  // Given blocked ranges, compute allowed segments within [minY, maxY] and pick a safe Y.
  private pickSafePowerUpYAtX(x: number, minY: number, maxY: number): number | null {
    if (!(maxY > minY)) return null;
    const blocked = this.getBlockedYRangesAtX(x, minY, maxY);

    logger.debug(`pickSafePowerUpYAtX: x=${x.toFixed(1)}, blocked ranges:`, blocked.map(r => `[${r[0].toFixed(1)}, ${r[1].toFixed(1)}]`));

    // Build allowed ranges by subtracting blocked from [minY, maxY]
    const allowed: Array<[number, number]> = [];
    let cursor = minY;
    for (const [bStart, bEnd] of blocked) {
      if (bStart > cursor) {
        allowed.push([cursor, Math.min(bStart, maxY)]);
      }
      cursor = Math.max(cursor, bEnd);
      if (cursor >= maxY) break;
    }
    if (cursor < maxY) {
      allowed.push([cursor, maxY]);
    }

    logger.debug(`pickSafePowerUpYAtX: allowed ranges:`, allowed.map(r => `[${r[0].toFixed(1)}, ${r[1].toFixed(1)}]`));

    // Require a minimal span so pickup circle fits comfortably
    // Use just the pickup radius (not diameter) to allow tighter placement
    const minSpan = this.powerUpPickupRadius + 10; // Just enough room for the sprite center + small buffer
    const viable = allowed.filter(([a, b]) => b - a >= minSpan);
    if (viable.length === 0) {
      logger.warn(`pickSafePowerUpYAtX: No viable ranges (minSpan=${minSpan})`);
      return null;
    }

    // Prefer the largest allowed range to reduce edge clipping, then pick uniformly within it
    let best: [number, number] = viable[0];
    let bestLen = best[1] - best[0];
    for (const seg of viable) {
      const len = seg[1] - seg[0];
      if (len > bestLen) {
        best = seg;
        bestLen = len;
      }
    }
    const y = best[0] + Math.random() * (best[1] - best[0]);
    logger.debug(`pickSafePowerUpYAtX: picked Y=${y.toFixed(1)} from range [${best[0].toFixed(1)}, ${best[1].toFixed(1)}]`);
    return y;
  }

  private spawnPowerUp() {
    const def = this.powerUpDefs[Math.floor(Math.random() * this.powerUpDefs.length)] || this.powerUpDefs[0];
    const id = this.nextPowerUpId++;
    const x = this.worldWidth + 200; // spawn to the right of the screen

    // Y anywhere visible between sky and just above the floor
    const topMargin = 40;
    const floorY = this.worldHeight - this.floorHeight;
    const bottomMargin = 80;
    const minY = topMargin;
    const maxY = Math.max(minY, floorY - bottomMargin);

    // Log current pipes for debugging
    logger.debug(`PowerUp spawn attempt: x=${x.toFixed(1)}, pipes in world:`, this.state.pipes.map(p => ({ id: p.id, x: p.x.toFixed(1), Ytop: p.Ytop.toFixed(1), Ybottom: p.Ybottom.toFixed(1) })));

    // Pick a safe Y that avoids overlapping pipes/obstacles at this X
    const picked = this.pickSafePowerUpYAtX(x, minY, maxY);
    if (picked == null) {
      logger.warn(`PowerUp spawn skipped: no safe Y at x=${x.toFixed(1)} within [${minY}, ${maxY}]`);
      // If no viable slot, try again sooner next tick by slightly biasing the timer
      this.powerUpElapsed = Math.max(0, this.powerUpElapsed - 0.5);
      return;
    }
    const y = picked;
    const pu = def.spawn(id, x, y);
    this.state.powerUps.push(pu);
    this.currentPowerUpIntervalSec = def.intervalSec || this.powerUpIntervalSec;
    logger.info(`PowerUp spawned: id=${pu.id}, type=${pu.type}, x=${x.toFixed(1)}, y=${y.toFixed(1)}`);
  }

  private applyPowerUpEffect(player: PlayerState, pu: PowerUpState) {
    switch (pu.type) {
      case "coin":
        // Award points; treat as passing two pipes
        player.score += 2;
        break;
      case "hammer":
        // Deal damage to Pig King
        this.damagePigKing(1);
        break;
      case "star":
        // Temporary invulnerability (shield) for 10 seconds
        try {
          const now = Date.now();
          (player as any).shield = true;
          (player as any).shieldUntil = now + 10_000; // 10s
          const pid = this.findPlayerId(player);
          logger.info(`Shield granted to player ${pid ?? "<unknown>"} until ${new Date((player as any).shieldUntil).toISOString()}`);
        } catch { /* no-op */ }
        break;
      default:
        // No-op placeholder
        break;
    }
  }
}
