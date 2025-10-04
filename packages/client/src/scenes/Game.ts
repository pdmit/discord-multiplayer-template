import { Scene } from "phaser";
import { Room, Client, getStateCallbacks } from "colyseus.js";
import { discordSdk, getUserName } from "../utils/discordSDK";

type PlayerState = {
  name: string;
  skin: "yellow" | "blue" | "red";
  y: number;
  velocity: number;
  alive: boolean;
  score: number;
  lastPassedPipeId: number;
  ready: boolean;
};

type PipeState = {
  id: number;
  x: number;
  Ytop: number;
  Ybottom: number;
};

export class Game extends Scene {
  private room?: Room<any>;
  private background!: Phaser.GameObjects.TileSprite;
  private ground!: Phaser.GameObjects.TileSprite;
  private playerSprites = new Map<string, Phaser.GameObjects.Sprite>();
  private pipeSprites = new Map<number, { top: Phaser.GameObjects.Image; bottom: Phaser.GameObjects.Image }>();
  private playerCache = new Map<string, { alive: boolean; score: number; ready: boolean }>();
  private scoreText!: Phaser.GameObjects.Text;
  private scoreBackdrop!: Phaser.GameObjects.Rectangle;
  private statusText!: Phaser.GameObjects.Text;
  private readyCountText!: Phaser.GameObjects.Text;
  private readyButtonBackground?: Phaser.GameObjects.Rectangle;
  private readyButtonLabel?: Phaser.GameObjects.Text;
  private gameOverScreen?: Phaser.GameObjects.Container;
  private gameOverText?: Phaser.GameObjects.Text;
  private restartButton?: Phaser.GameObjects.Rectangle;
  private restartButtonLabel?: Phaser.GameObjects.Text;
  private localPlayerId = "";
  private localPlayerReady = false;
  private lastKnownRunning = false;
  private readonly pipeGap = 50;
  private readonly pipeHeight = 315;
  private readonly birdX = 260;
  private readonly scrollSpeed = 220;
  private updatingActivity = false;
  private pendingActivityUpdate = false;

  constructor() {
    super("Game");
  }

  async create() {
    
    // Add a visible debug indicator at the top
    this.add.text(50, 50, "GAME SCENE LOADED", {
      fontFamily: "Arial Black",
      fontSize: 24,
      color: "#ff0000",
      stroke: "#000000",
      strokeThickness: 4,
    }).setDepth(100);
    
    this.setupWorld();
    this.setupUI();
    this.setupInput();

    await this.connect();
    this.registerStateListeners();
    // Wait a moment for the room state to be fully initialized
    setTimeout(() => {
      this.updateReadyUI();
    }, 100);
    console.log("Game scene create() completed");
  }

  update(_time: number, delta: number) {
    const scroll = (this.scrollSpeed * delta) / 1000;
    this.background.tilePositionX += scroll;
    this.ground.tilePositionX += scroll;
    
    // Periodic sync for ready state changes and running state
    if (this.room && this.room.state && this.room.state.players) {
      let needsUIUpdate = false;
      
      // Check if running state changed
      const currentRunning = this.room.state.running as boolean;
      if (currentRunning !== this.lastKnownRunning) {
        console.log("Running state changed from", this.lastKnownRunning, "to", currentRunning);
        this.lastKnownRunning = currentRunning;
        needsUIUpdate = true;
        this.updateStatusMessage();
        
        // When game starts, check for existing pipes
        if (currentRunning && this.room.state.pipes) {
          console.log("Game started, checking for pipes:", this.room.state.pipes.length);
          this.room.state.pipes.forEach((pipe: PipeState) => {
            console.log("Pipe in room state:", pipe.id, "at x:", pipe.x, "Ytop:", pipe.Ytop);
            if (!this.pipeSprites.has(pipe.id)) {
              console.log("Adding missing pipe:", pipe.id);
              this.addPipe(pipe);
            } else {
              console.log("Pipe already exists:", pipe.id);
            }
          });
        }
      }
      
      this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
        const cached = this.playerCache.get(sessionId);
        if (cached && cached.ready !== player.ready) {
          console.log("Ready state changed for player:", sessionId, "from", cached.ready, "to", player.ready);
          this.syncPlayer(sessionId, player, []);
          needsUIUpdate = true;
        } else if (!cached) {
          // If player is not in cache, add them
          console.log("Player not in cache, adding:", sessionId);
          this.addPlayer(sessionId, player);
          needsUIUpdate = true;
        }
        // Debug: log current ready state
        // if (sessionId === this.localPlayerId) {
        //   console.log("Local player ready state - cached:", cached?.ready, "room:", player.ready);
        // }

        this.syncPlayer(sessionId, player, []);
      });
      
      // Force UI update if any state changed
      if (needsUIUpdate) {
        this.updateReadyUI();
      }

    }
  }

  private setupWorld() {
    const { width, height } = this.cameras.main;

    this.background = this.add.tileSprite(0, 0, width * 1.5, height, "background-day").setOrigin(0, 0);
    this.ground = this.add.tileSprite(0, height - 112, width * 1.5, 112, "base").setOrigin(0, 0);
  }

  private setupUI() {
    const width = Number(this.game.config.width);
    const height = Number(this.game.config.height);

    this.scoreBackdrop = this.add
      .rectangle(width / 2, 40, width * 0.6, 70, 0x000000, 0.35)
      .setOrigin(0.5)
      .setDepth(10);

    this.scoreText = this.add
      .text(width / 2, 40, "Connecting...", {
        fontFamily: "Arial Black",
        fontSize: 30,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 8,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(11);

    this.statusText = this.add
      .text(width / 2, 120, "Waiting for players...", {
        fontFamily: "Arial",
        fontSize: 26,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 6,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(11);

    this.readyCountText = this.add
      .text(width / 2, height - 250, "DEBUG: Ready count text created", {
        fontFamily: "Arial",
        fontSize: 22,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(11);

    const buttonY = height - 200; // Move button higher up
    const buttonWidth = Math.min(320, width * 0.5);
    const buttonHeight = 64;

    this.readyButtonBackground = this.add
      .rectangle(width / 2, buttonY, buttonWidth, buttonHeight, 0x3498db, 0.85)
      .setOrigin(0.5)
      .setDepth(10)
      .setVisible(true); // Temporarily make visible for debugging

    this.readyButtonLabel = this.add
      .text(width / 2, buttonY, "Ready Up", {
        fontFamily: "Arial Black",
        fontSize: 28,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 6,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(11)
      .setVisible(true); // Temporarily make visible for debugging

    console.log("Ready button elements created:", {
      background: !!this.readyButtonBackground,
      label: !!this.readyButtonLabel,
      countText: !!this.readyCountText
    });

    this.readyButtonBackground
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => {
        this.toggleReady();
      })
      .on("pointerover", () => {
        const button = this.readyButtonBackground;
        if (button?.visible) {
          button.setFillStyle(this.localPlayerReady ? 0x27ae60 : 0x2980b9, this.localPlayerReady ? 0.95 : 0.9);
        }
      })
      .on("pointerout", () => {
        if (this.readyButtonBackground?.visible) {
          this.updateReadyButtonStyle();
        }
      });

    this.add
      .text(width / 2, height - 30, `Connected as: ${getUserName()}`, {
        font: "18px Arial",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(11);

    this.updateReadyUI();
    this.setupGameOverScreen();
  }

  private setupGameOverScreen() {
    const width = Number(this.game.config.width);
    const height = Number(this.game.config.height);

    // Create container for game over screen
    this.gameOverScreen = this.add.container(width / 2, height / 2);
    this.gameOverScreen.setVisible(false);
    this.gameOverScreen.setDepth(20);

    // Semi-transparent background
    const overlay = this.add.rectangle(0, 0, width, height, 0x000000, 0.7);
    this.gameOverScreen.add(overlay);

    // Game over text
    this.gameOverText = this.add.text(0, -50, "GAME OVER", {
      fontFamily: "Arial Black",
      fontSize: 48,
      color: "#ff0000",
      stroke: "#000000",
      strokeThickness: 8,
      align: "center",
    });
    this.gameOverText.setOrigin(0.5);
    this.gameOverScreen.add(this.gameOverText);

    // Score display
    const scoreDisplay = this.add.text(0, 0, "Score: 0", {
      fontFamily: "Arial",
      fontSize: 32,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 6,
      align: "center",
    });
    scoreDisplay.setOrigin(0.5);
    this.gameOverScreen.add(scoreDisplay);

    // Restart button
    const buttonWidth = 200;
    const buttonHeight = 60;
    const buttonY = 80;

    this.restartButton = this.add.rectangle(0, buttonY, buttonWidth, buttonHeight, 0x27ae60, 0.9);
    this.restartButton.setOrigin(0.5);
    this.restartButton.setInteractive({ useHandCursor: true });
    this.restartButton.on("pointerdown", () => this.restartGame());
    this.restartButton.on("pointerover", () => {
      this.restartButton?.setFillStyle(0x2ecc71, 0.95);
    });
    this.restartButton.on("pointerout", () => {
      this.restartButton?.setFillStyle(0x27ae60, 0.9);
    });
    this.gameOverScreen.add(this.restartButton);

    this.restartButtonLabel = this.add.text(0, buttonY, "Play Again", {
      fontFamily: "Arial Black",
      fontSize: 24,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    });
    this.restartButtonLabel.setOrigin(0.5);
    this.gameOverScreen.add(this.restartButtonLabel);
  }

  private setupInput() {
    console.log("setupInput() called");
    this.input.on("pointerdown", () => this.handleFlap());
    this.input.keyboard?.on("keydown-SPACE", () => this.handleFlap());
    this.input.keyboard?.on("keydown-UP", () => this.handleFlap());
  }

  private handleFlap() {
    if (!this.room || !this.room.state.running) {
      console.log("handleFlap() called but room or running state is false");
      return;
    }

    console.log("handleFlap() called");
    this.room.send("flap");
    this.sound.play("wing", { volume: 0.4 });
  }

  private showGameOverScreen(won: boolean, score: number) {
    if (!this.gameOverScreen || !this.gameOverText) {
      return;
    }

    // Update game over text
    this.gameOverText.setText(won ? "YOU WIN!" : "GAME OVER");
    this.gameOverText.setColor(won ? "#00ff00" : "#ff0000");

    // Update score display
    const scoreDisplay = this.gameOverScreen.list[1] as Phaser.GameObjects.Text;
    if (scoreDisplay) {
      scoreDisplay.setText(`Score: ${score}`);
    }

    // Show the screen
    this.gameOverScreen.setVisible(true);
    
    console.log(`Game over screen shown - Won: ${won}, Score: ${score}`);
  }

  private restartGame() {
    if (!this.room) {
      return;
    }

    // Hide game over screen
    this.gameOverScreen?.setVisible(false);
    
    // Reset local ready state
    this.localPlayerReady = false;
    
    // Send ready up message to start new game
    this.room.send("setReady", { ready: true });
    
    console.log("Restarting game...");
  }

  private toggleReady() {
    if (!this.room || this.room.state.running) {
      return;
    }

    const nextReady = !this.localPlayerReady;
    this.localPlayerReady = nextReady;
    console.log("Toggling ready state to:", nextReady);
    
    // Update UI immediately for better responsiveness
    this.updateReadyUI();
    
    // Send to server
    this.room.send("setReady", { ready: nextReady });
    console.log("Sent setReady message to server");
    
    // Also update the server state immediately to avoid sync issues
    const player = this.room.state.players.get(this.localPlayerId);
    if (player) {
      player.ready = nextReady;
      console.log("Updated server state immediately for player:", this.localPlayerId, "to:", nextReady);
    }
  }

  private updateReadyButtonStyle() {
    if (!this.readyButtonBackground) {
      return;
    }

    const color = this.localPlayerReady ? 0x2ecc71 : 0x3498db;
    const alpha = this.localPlayerReady ? 0.95 : 0.85;
    this.readyButtonBackground.setFillStyle(color, alpha);
  }

  private updateReadyUI() {
    console.log("updateReadyUI called");
    
    if (!this.readyButtonBackground || !this.readyButtonLabel || !this.readyCountText) {
      console.log("Ready UI elements not initialized");
      return;
    }

    if (!this.room) {
      console.log("No room, hiding ready UI");
      this.readyButtonBackground.setVisible(false);
      this.readyButtonBackground.disableInteractive();
      this.readyButtonLabel.setVisible(false);
      this.readyCountText.setVisible(false);
      return;
    }

    const running = this.room.state.running as boolean;
    const playerCount = this.getPlayerCount();
    const readyCount = this.getReadyCount();
    const showLobbyUi = !running && playerCount > 0;
    
    console.log("Ready UI state:", { 
      running, 
      playerCount, 
      readyCount, 
      showLobbyUi, 
      localPlayerReady: this.localPlayerReady,
      localPlayerId: this.localPlayerId,
      pipesCount: this.room.state.pipes?.length || 0,
      playerSpritesCount: this.playerSprites.size
    });

    // Always update the ready count text when visible
    this.readyCountText.setVisible(showLobbyUi);
    if (showLobbyUi) {
      this.readyCountText.setText(`Ready players: ${readyCount} / ${playerCount}`);
      console.log("Updated ready count display:", `${readyCount} / ${playerCount}`);
    } else {
      this.readyCountText.setText("");
    }

    this.readyButtonBackground.setVisible(showLobbyUi);
    this.readyButtonLabel.setVisible(showLobbyUi);

    if (showLobbyUi) {
      this.readyButtonLabel.setText(this.localPlayerReady ? "Cancel Ready" : "Ready Up");
      this.updateReadyButtonStyle();
      this.readyButtonBackground.setInteractive({ useHandCursor: true });
      console.log("Updated ready button text to:", this.localPlayerReady ? "Cancel Ready" : "Ready Up");
    } else {
      this.readyButtonBackground.disableInteractive();
    }
  }

  private async connect() {
    const url =
      location.host === "localhost:3000"
        ? `ws://localhost:3001`
        : `wss://${location.host}/.proxy/api/colyseus`;

    const client = new Client(`${url}`);

    try {
      this.room = await client.joinOrCreate("game", {
        name: getUserName(),
      });
      this.localPlayerId = this.room.sessionId;
      console.log("Connected to room, sessionId:", this.localPlayerId);
      void this.updateDiscordActivityPresence();
    } catch (e) {
      console.log(`Could not connect with the server: ${e}`);
      this.scoreText.setText("Connection failed");
    }
  }

  private registerStateListeners() {
    if (!this.room || !this.room.state) {
      console.log("No room or state, skipping state listeners");
      return;
    }

    console.log("Registering state listeners");
    const $ = getStateCallbacks(this.room);

    // Handle existing players (in case they were added before listeners were registered)
    if (this.room.state.players) {
      console.log("Found", this.room.state.players.size, "existing players in room");
      this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
        console.log("Existing player in room:", sessionId, player.name, "ready:", player.ready);
        this.addPlayer(sessionId, player);
        
        // Note: Individual player onChange callbacks are not working properly
        // We'll use periodic sync instead
      });
    }

    // Handle existing pipes (in case they were added before listeners were registered)
    if (this.room.state.pipes) {
      console.log("Found", this.room.state.pipes.length, "existing pipes in room");
      this.room.state.pipes.forEach((pipe: PipeState) => {
        console.log("Existing pipe in room:", pipe.id, "at x:", pipe.x, "Ytop:", pipe.Ytop);
        this.addPipe(pipe);
      });
    }

    $(this.room.state.players).onAdd((player: PlayerState, sessionId: string) => {
      console.log("Player added to room via onAdd:", sessionId, player.name, "ready:", player.ready);
      this.addPlayer(sessionId, player);
      
      // Note: Individual player onChange callbacks are not working properly
      // We'll use periodic sync instead
    });

    $(this.room.state.players).onRemove((_player: PlayerState, sessionId: string) => {
      this.removePlayer(sessionId);
    });

    $(this.room.state.pipes).onAdd((pipe: PipeState) => {
      console.log("Pipe added to room state:", pipe);
      this.addPipe(pipe);
    });

    $(this.room.state.pipes).onRemove((pipe: PipeState) => {
      console.log("Pipe removed from room state:", pipe);
      this.removePipe(pipe.id);
    });

    $(this.room.state).onChange((changes: any[]) => {
      console.log("Room state changed:", changes);
      if (changes && Array.isArray(changes)) {
        changes.forEach((change) => {
          console.log("State change field:", change.field, "value:", change.value);
          if (change.field === "running" || change.field === "winnerId") {
            console.log("Updating status message due to running/winnerId change");
            this.updateStatusMessage();
          }
        });
      } else {
        console.log("State change callback received non-array data:", changes);
      }
    });

    this.updateStatusMessage();
  }

  private addPlayer(sessionId: string, player: PlayerState) {
    console.log("Adding player:", sessionId, "with ready state:", player.ready);
    
    const sprite = this.add.sprite(this.birdX, player.y, this.getBirdTexture(player.skin));
    sprite.setDepth(5);
    sprite.play(this.getBirdAnimation(player.skin));

    if (sessionId === this.localPlayerId) {
      sprite.setScale(1.05);
      sprite.setTint(0xffffaa);
    }

    this.playerSprites.set(sessionId, sprite);
    this.playerCache.set(sessionId, { alive: player.alive, score: player.score, ready: player.ready });
    
    if (sessionId === this.localPlayerId) {
      this.localPlayerReady = player.ready;
      console.log("Set local player ready state to:", player.ready);
    }
    
    this.syncPlayer(sessionId, player, []);
    this.refreshScoreboard();
    this.updateStatusMessage();
    this.updateReadyUI();
    
    console.log("Player added successfully. Cache now has:", this.playerCache.size, "players");
  }

  private removePlayer(sessionId: string) {
    const sprite = this.playerSprites.get(sessionId);
    if (sprite) {
      sprite.destroy();
    }
    this.playerSprites.delete(sessionId);
    this.playerCache.delete(sessionId);
    if (sessionId === this.localPlayerId) {
      this.localPlayerReady = false;
    }
    this.refreshScoreboard();
    this.updateStatusMessage();
    this.updateReadyUI();
  }

  private syncPlayer(sessionId: string, player: PlayerState, changes: any[]) {
    const sprite = this.playerSprites.get(sessionId);
    if (!sprite) {
      return;
    }

    sprite.y = player.y;
    //console.log("sprite.y set to:", player.y);
    const rotation = Phaser.Math.Clamp(player.velocity / 600, -0.6, 1.0);
    sprite.setRotation(rotation);

    const cached = this.playerCache.get(sessionId);
    const readyChanged = !cached || cached.ready !== player.ready;
    if (cached) {
      if (cached.alive && !player.alive && sessionId === this.localPlayerId) {
        this.sound.play("hit", { volume: 0.4 });
        this.sound.play("die", { volume: 0.4, delay: 0.1 });
      }
      if (player.score > cached.score && sessionId === this.localPlayerId) {
        this.sound.play("point", { volume: 0.5 });
      }
    }

    if (player.alive) {
      sprite.clearTint();
      if (sessionId === this.localPlayerId) {
        sprite.setTint(0xffffaa);
      }
      sprite.setAlpha(1);
    } else {
      sprite.setTint(0x555555);
      sprite.setAlpha(0.8);
    }

    this.playerCache.set(sessionId, { alive: player.alive, score: player.score, ready: player.ready });
    if (sessionId === this.localPlayerId) {
      this.localPlayerReady = player.ready;
      //console.log("Updated local player ready state to:", player.ready);
    }

    const changeList = Array.isArray(changes) ? changes : [];
    const shouldRefresh = changeList.some(
      (change: any) => change.field === "score" || change.field === "alive" || change.field === "ready",
    );
    if (shouldRefresh) {
      this.refreshScoreboard();
      this.updateStatusMessage();
    }
    if (readyChanged) {
      console.log("Ready state changed for player:", sessionId, "to:", player.ready);
      this.updateReadyUI();
    }
  }

  private getBirdTexture(skin: PlayerState["skin"]) {
    switch (skin) {
      case "blue":
        return "bluebird-midflap";
      case "red":
        return "redbird-midflap";
      default:
        return "yellowbird-midflap";
    }
  }

  private getBirdAnimation(skin: PlayerState["skin"]) {
    switch (skin) {
      case "blue":
        return "blue_fly";
      case "red":
        return "red_fly";
      default:
        return "yellow_fly";
    }
  }

  private addPipe(pipe: PipeState) {
    console.log("Adding pipe:", pipe.id, "at x:", pipe.x, "Ytop:", pipe.Ytop);
    
    // Check if pipe texture exists
    if (!this.textures.exists("pipe")) {
      console.error("Pipe texture not found! Available textures:", Object.keys(this.textures.list));
      console.log("Trying to use 'pipe-green' instead...");
      
      // Try using pipe-green texture instead
      if (!this.textures.exists("pipe-green")) {
        console.error("pipe-green texture also not found! Available textures:", Object.keys(this.textures.list));
        return;
      }
      
      // Use pipe-green texture
      const top = this.add.image(pipe.x, pipe.Ytop - this.pipeGap / 2, "pipe");
      top.setOrigin(0.5, 1);
      top.setFlipY(true);
      top.setDepth(3);
      console.log("Created top pipe (pipe-green) at:", pipe.x, pipe.Ytop - this.pipeGap / 2);

      const bottom = this.add.image(pipe.x, pipe.Ytop + this.pipeGap / 2, "pipe");
      bottom.setOrigin(0.5, 0);
      bottom.setDepth(3);
      console.log("Created bottom pipe (pipe-green) at:", pipe.x, pipe.Ytop + this.pipeGap / 2);
      
      this.pipeSprites.set(pipe.id, { top, bottom });
      this.updatePipe(pipe);
      console.log("Pipe added successfully with pipe-green texture, total pipes:", this.pipeSprites.size);
      return;
    }
    
    pipe.x = 1000;
    pipe.Ytop = 20;
    const top = this.add.image(pipe.x, 0, "pipe");
    top.setOrigin(0.5, 0);
    top.setFlipY(true);
    top.setDepth(3);
    console.log("Created top pipe at:", pipe.x, pipe.Ytop - this.pipeGap / 2);

    const bottom = this.add.image(pipe.x, this.pipeHeight, "pipe-red");
    bottom.setOrigin(0.5, 0);
    bottom.setFlipY(false);
    bottom.setDepth(4);
    console.log("Created bottom pipe at:", pipe.x, pipe.Ytop + this.pipeGap / 2);

    this.pipeSprites.set(pipe.id, { top, bottom });
    this.updatePipe(pipe);
    console.log("Pipe added successfully, total pipes:", this.pipeSprites.size);
  }

  private updatePipe(pipe: PipeState) {
    const sprites = this.pipeSprites.get(pipe.id);
    if (!sprites) {
      return;
    }

    sprites.top.x = pipe.x;
    sprites.bottom.x = pipe.x;
    sprites.top.y = 0;
    sprites.bottom.y = 0;
  }

  private removePipe(id: number) {
    const sprites = this.pipeSprites.get(id);
    if (!sprites) {
      return;
    }

    //sprites.top.destroy();
    //sprites.bottom.destroy();
    //this.pipeSprites.delete(id);
  }

  private refreshScoreboard() {
    if (!this.room) {
      return;
    }

    const players: Array<{ name: string; score: number; alive: boolean; ready: boolean; isLocal: boolean }> = [];

    this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
      players.push({
        name: player.name,
        score: player.score,
        alive: player.alive,
        ready: player.ready,
        isLocal: sessionId === this.localPlayerId,
      });
    });

    players.sort((a, b) => {
      if (b.score === a.score) {
        return a.name.localeCompare(b.name);
      }
      return b.score - a.score;
    });

    const running = this.room.state.running as boolean;

    if (players.length === 0) {
      this.scoreText.setText("Waiting for players...");
    } else {
      const lines = players.map((player) => {
        const prefix = player.isLocal ? "▶ " : "";
        if (running) {
          const status = player.alive ? "🟢" : "✖";
          return `${prefix}${player.name}: ${player.score} ${status}`;
        }

        const status = player.ready ? "✅ Ready" : "⌛ Waiting";
        return `${prefix}${player.name} ${status}`;
      });
      this.scoreText.setText(lines.join("\n"));
    }

    this.scoreBackdrop.width = this.scoreText.width + 40;
    this.scoreBackdrop.height = this.scoreText.height + 30;
    this.updateReadyUI();
    void this.updateDiscordActivityPresence();
  }

  private updateStatusMessage() {
    if (!this.room) {
      return;
    }

    const running = this.room.state.running;
    const winnerId = this.room.state.winnerId as string;
    const playerCount = this.getPlayerCount();

    if (!running) {
      const readyCount = this.getReadyCount();
      
      // Check if it's a single player game over (no winner, but game ended)
      if (!winnerId && playerCount === 1) {
        const localPlayer = this.room.state.players.get(this.localPlayerId);
        if (localPlayer && !localPlayer.alive) {
          // Single player died - show game over screen
          this.showGameOverScreen(false, localPlayer.score);
          return;
        }
      }
      
      if (winnerId) {
        const winner = this.room.state.players.get(winnerId) as PlayerState | undefined;
        const winnerName = winner ? winner.name : "Nobody";
        const isLocalWinner = winnerId === this.localPlayerId;
        this.statusText.setText(`${winnerName} wins!\nPress Ready to play again.`);
        
        // Show game over screen for local player
        if (isLocalWinner) {
          this.showGameOverScreen(true, winner?.score || 0);
        }
      } else if (playerCount > 0) {
        const everyoneReady = readyCount > 0 && readyCount === playerCount;
        if (everyoneReady) {
          this.statusText.setText("All players are ready! Starting the round...");
        } else {
          this.statusText.setText("Press Ready when you are set.\nThe round begins once everyone is ready.");
        }
      } else {
        this.statusText.setText("Waiting for players to join...");
      }
    } else {
      if (playerCount === 1) {
        this.statusText.setText("Flap to stay alive! Try to get a high score!");
      } else {
        this.statusText.setText("Flap to stay alive! Last bird standing wins.");
      }
    }
    this.updateReadyUI();
    void this.updateDiscordActivityPresence();
  }

  private getPlayerCount() {
    if (!this.room || !this.room.state || !this.room.state.players) {
      return 0;
    }

    let count = 0;
    this.room.state.players.forEach(() => {
      count += 1;
    });
    return count;
  }

  private getReadyCount() {
    if (!this.room || !this.room.state || !this.room.state.players) {
      return 0;
    }

    let count = 0;
    this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
      if (player.ready) {
        count += 1;
        console.log("Player", sessionId, "is ready");
      }
    });
    console.log("Total ready count:", count);
    return count;
  }

  private async updateDiscordActivityPresence() {
    if (!this.room || !this.room.state || !discordSdk) {
      return;
    }

    if (this.updatingActivity) {
      this.pendingActivityUpdate = true;
      return;
    }

    this.updatingActivity = true;

    const playerCount = this.getPlayerCount();
    const maxPlayers = 25; // Default max players
    const running = this.room.state.running as boolean;

    try {
      await discordSdk.commands.setActivity({
        activity: {
          type: 0,
          state: running ? "In Game" : "In Lobby",
          details: `${playerCount} player${playerCount === 1 ? "" : "s"} in room`,
          party: {
            size: [playerCount, maxPlayers],
          },
        },
      });
    } catch (error) {
      console.error("Failed to update Discord activity", error);
    } finally {
      this.updatingActivity = false;
      if (this.pendingActivityUpdate) {
        this.pendingActivityUpdate = false;
        void this.updateDiscordActivityPresence();
      }
    }
  }
}
