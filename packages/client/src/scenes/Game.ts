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
  gapY: number;
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
  private localPlayerId = "";
  private localPlayerReady = false;
  private readonly pipeGap = 230;
  private readonly birdX = 260;
  private readonly scrollSpeed = 220;
  private updatingActivity = false;
  private pendingActivityUpdate = false;

  constructor() {
    super("Game");
  }

  async create() {
    this.setupWorld();
    this.setupUI();
    this.setupInput();

    await this.connect();
    this.registerStateListeners();
  }

  update(_time: number, delta: number) {
    const scroll = (this.scrollSpeed * delta) / 1000;
    this.background.tilePositionX += scroll;
    this.ground.tilePositionX += scroll;
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
      .text(width / 2, 170, "", {
        fontFamily: "Arial",
        fontSize: 22,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(11);

    const buttonY = height - 120;
    const buttonWidth = Math.min(320, width * 0.5);
    const buttonHeight = 64;

    this.readyButtonBackground = this.add
      .rectangle(width / 2, buttonY, buttonWidth, buttonHeight, 0x3498db, 0.85)
      .setOrigin(0.5)
      .setDepth(10)
      .setVisible(false);

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
      .setVisible(false);

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
  }

  private setupInput() {
    this.input.on("pointerdown", () => this.handleFlap());
    this.input.keyboard?.on("keydown-SPACE", () => this.handleFlap());
    this.input.keyboard?.on("keydown-UP", () => this.handleFlap());
  }

  private handleFlap() {
    if (!this.room || !this.room.state.running) {
      return;
    }

    this.room.send("flap");
    this.sound.play("wing", { volume: 0.4 });
  }

  private toggleReady() {
    if (!this.room || this.room.state.running) {
      return;
    }

    const nextReady = !this.localPlayerReady;
    this.localPlayerReady = nextReady;
    this.updateReadyUI();
    this.room.send("setReady", { ready: nextReady });
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
    if (!this.readyButtonBackground || !this.readyButtonLabel || !this.readyCountText) {
      return;
    }

    if (!this.room) {
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

    this.readyCountText.setVisible(showLobbyUi);
    if (showLobbyUi) {
      this.readyCountText.setText(`Ready players: ${readyCount} / ${playerCount}`);
    } else {
      this.readyCountText.setText("");
    }

    this.readyButtonBackground.setVisible(showLobbyUi);
    this.readyButtonLabel.setVisible(showLobbyUi);

    if (showLobbyUi) {
      this.readyButtonLabel.setText(this.localPlayerReady ? "Cancel Ready" : "Ready Up");
      this.updateReadyButtonStyle();
      this.readyButtonBackground.setInteractive({ useHandCursor: true });
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
      void this.updateDiscordActivityPresence();
    } catch (e) {
      console.log(`Could not connect with the server: ${e}`);
      this.scoreText.setText("Connection failed");
    }
  }

  private registerStateListeners() {
    if (!this.room) {
      return;
    }

    const $ = getStateCallbacks(this.room);

    $(this.room.state.players).onAdd((player: PlayerState, sessionId: string) => {
      this.addPlayer(sessionId, player);
      $(player).onChange((changes: any) => {
        this.syncPlayer(sessionId, player, changes);
      });
    });

    $(this.room.state.players).onRemove((_player: PlayerState, sessionId: string) => {
      this.removePlayer(sessionId);
    });

    $(this.room.state.pipes).onAdd((pipe: PipeState) => {
      this.addPipe(pipe);
      $(pipe).onChange(() => {
        this.updatePipe(pipe);
      });
    });

    $(this.room.state.pipes).onRemove((pipe: PipeState) => {
      this.removePipe(pipe.id);
    });

    $(this.room.state).onChange((changes: any[]) => {
      changes.forEach((change) => {
        if (change.field === "running" || change.field === "winnerId") {
          this.updateStatusMessage();
        }
      });
    });

    this.updateStatusMessage();
  }

  private addPlayer(sessionId: string, player: PlayerState) {
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
    }
    this.syncPlayer(sessionId, player, []);
    this.refreshScoreboard();
    this.updateStatusMessage();
    this.updateReadyUI();
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
    const top = this.add.image(pipe.x, pipe.gapY - this.pipeGap / 2, "pipe");
    top.setOrigin(0.5, 1);
    top.setFlipY(true);
    top.setDepth(3);

    const bottom = this.add.image(pipe.x, pipe.gapY + this.pipeGap / 2, "pipe");
    bottom.setOrigin(0.5, 0);
    bottom.setDepth(3);

    this.pipeSprites.set(pipe.id, { top, bottom });
    this.updatePipe(pipe);
  }

  private updatePipe(pipe: PipeState) {
    const sprites = this.pipeSprites.get(pipe.id);
    if (!sprites) {
      return;
    }

    sprites.top.x = pipe.x;
    sprites.bottom.x = pipe.x;
    sprites.top.y = pipe.gapY - this.pipeGap / 2;
    sprites.bottom.y = pipe.gapY + this.pipeGap / 2;
  }

  private removePipe(id: number) {
    const sprites = this.pipeSprites.get(id);
    if (!sprites) {
      return;
    }

    sprites.top.destroy();
    sprites.bottom.destroy();
    this.pipeSprites.delete(id);
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

    if (!running) {
      const playerCount = this.getPlayerCount();
      const readyCount = this.getReadyCount();
      if (winnerId) {
        const winner = this.room.state.players.get(winnerId) as PlayerState | undefined;
        const winnerName = winner ? winner.name : "Nobody";
        this.statusText.setText(`${winnerName} wins!\nPress Ready to play again.`);
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
      this.statusText.setText("Flap to stay alive! Last bird standing wins.");
    }
    this.updateReadyUI();
    void this.updateDiscordActivityPresence();
  }

  private getPlayerCount() {
    if (!this.room) {
      return 0;
    }

    let count = 0;
    this.room.state.players.forEach(() => {
      count += 1;
    });
    return count;
  }

  private getReadyCount() {
    if (!this.room) {
      return 0;
    }

    let count = 0;
    this.room.state.players.forEach((player: PlayerState) => {
      if (player.ready) {
        count += 1;
      }
    });
    return count;
  }

  private async updateDiscordActivityPresence() {
    if (!this.room || !discordSdk) {
      return;
    }

    if (this.updatingActivity) {
      this.pendingActivityUpdate = true;
      return;
    }

    this.updatingActivity = true;

    const playerCount = this.getPlayerCount();
    const maxPlayers = this.room.maxClients ?? 25;
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
