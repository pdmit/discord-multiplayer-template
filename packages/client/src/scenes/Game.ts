import { Scene } from "phaser";
import { Room, Client, getStateCallbacks } from "colyseus.js";
import { getUserName } from "../utils/discordSDK";

type PlayerState = {
  name: string;
  skin: "yellow" | "blue" | "red";
  y: number;
  velocity: number;
  alive: boolean;
  score: number;
  lastPassedPipeId: number;
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
  private playerCache = new Map<string, { alive: boolean; score: number }>();
  private scoreText!: Phaser.GameObjects.Text;
  private scoreBackdrop!: Phaser.GameObjects.Rectangle;
  private statusText!: Phaser.GameObjects.Text;
  private localPlayerId = "";
  private readonly pipeGap = 230;
  private readonly birdX = 260;
  private readonly scrollSpeed = 220;

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

    this.add
      .text(width / 2, Number(this.game.config.height) - 30, `Connected as: ${getUserName()}`, {
        font: "18px Arial",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(11);
  }

  private setupInput() {
    this.input.on("pointerdown", () => this.handleFlap());
    this.input.keyboard?.on("keydown-SPACE", () => this.handleFlap());
    this.input.keyboard?.on("keydown-UP", () => this.handleFlap());
  }

  private handleFlap() {
    if (!this.room) {
      return;
    }

    this.room.send("flap");
    this.sound.play("wing", { volume: 0.4 });
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
    this.playerCache.set(sessionId, { alive: player.alive, score: player.score });
    this.syncPlayer(sessionId, player, []);
    this.refreshScoreboard();
    this.updateStatusMessage();
  }

  private removePlayer(sessionId: string) {
    const sprite = this.playerSprites.get(sessionId);
    if (sprite) {
      sprite.destroy();
    }
    this.playerSprites.delete(sessionId);
    this.playerCache.delete(sessionId);
    this.refreshScoreboard();
    this.updateStatusMessage();
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

    this.playerCache.set(sessionId, { alive: player.alive, score: player.score });

    const changeList = Array.isArray(changes) ? changes : [];
    const shouldRefresh = changeList.some((change: any) => change.field === "score" || change.field === "alive");
    if (shouldRefresh) {
      this.refreshScoreboard();
      this.updateStatusMessage();
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

    const players: Array<{ name: string; score: number; alive: boolean; isLocal: boolean }> = [];

    this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
      players.push({
        name: player.name,
        score: player.score,
        alive: player.alive,
        isLocal: sessionId === this.localPlayerId,
      });
    });

    players.sort((a, b) => {
      if (b.score === a.score) {
        return a.name.localeCompare(b.name);
      }
      return b.score - a.score;
    });

    if (players.length === 0) {
      this.scoreText.setText("Waiting for players...");
    } else {
      const lines = players.map((player) => {
        const prefix = player.isLocal ? "▶ " : "";
        const status = player.alive ? "🟢" : "✖";
        return `${prefix}${player.name}: ${player.score} ${status}`;
      });
      this.scoreText.setText(lines.join("\n"));
    }

    this.scoreBackdrop.width = this.scoreText.width + 40;
    this.scoreBackdrop.height = this.scoreText.height + 30;
  }

  private updateStatusMessage() {
    if (!this.room) {
      return;
    }

    const running = this.room.state.running;
    const winnerId = this.room.state.winnerId as string;

    if (!running) {
      const playerCount = this.getPlayerCount();
      if (winnerId) {
        const winner = this.room.state.players.get(winnerId) as PlayerState | undefined;
        const winnerName = winner ? winner.name : "Nobody";
        this.statusText.setText(`${winnerName} wins!\nNext round starting soon...\nTap or press SPACE to play`);
      } else if (playerCount > 0) {
        this.statusText.setText("Get ready! Tap or press SPACE to start flapping");
      } else {
        this.statusText.setText("Waiting for players to join...");
      }
    } else {
      this.statusText.setText("Flap to stay alive! Last bird standing wins.");
    }
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
}
