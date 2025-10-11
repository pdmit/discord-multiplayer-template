import { Scene } from "phaser";
import { Room, Client, getStateCallbacks } from "colyseus.js";
import { discordSdk, getUserName } from "../utils/discordSDK";

type PlayerState = {
  name: string;
  skin: string;
  y: number;
  velocity: number;
  alive: boolean;
  score: number;
  lastPassedPipeId: number;
  ready: boolean;
  role?: "bird" | "gm"; // optional for backward compat
};

type PipeState = {
  id: number;
  x: number;
  Ytop: number;
  Ybottom: number;
};

type SkinSlotElements = {
  container: Phaser.GameObjects.Container;
  background: Phaser.GameObjects.Rectangle;
  preview: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  ownerText: Phaser.GameObjects.Text;
};

export class Game extends Scene {
  private room?: Room<any>;
  private background!: Phaser.GameObjects.TileSprite;
  private ground!: Phaser.GameObjects.TileSprite;
  private playerSprites = new Map<string, Phaser.GameObjects.Sprite>();
  private pipeSprites = new Map<
    number,
    {
      top: Phaser.GameObjects.Image;
      bottom: Phaser.GameObjects.Image;
      targetX: number;
      targetTopY: number;
      targetBottomY: number;
    }
  >();
  private playerCache = new Map<string, { alive: boolean; score: number; ready: boolean; skin: string }>();
  private skinOptions: string[] = [];
  private skinSelectionContainer?: Phaser.GameObjects.Container;
  private skinSlotElements = new Map<string, SkinSlotElements>();
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
  private returnButton?: Phaser.GameObjects.Rectangle;
  private returnButtonLabel?: Phaser.GameObjects.Text;
  private localPlayerId = "";
  private localPlayerReady = false;
  private lastKnownRunning = false;
  private lastKnownStage = 0;
  private readonly pipeGap = 50;
  private readonly pipeHeight = 315;
  private readonly birdX = 260;
  private readonly baseScrollSpeed = 220;
  private currentScrollSpeed = this.baseScrollSpeed;
  private readonly stageSpeedIncrement = 0.2;
  private readonly maxStage = 5;
  private readonly stageDurationSeconds = 20;
  private readonly pipeLerpSpeed = 12;
  private updatingActivity = false;
  private pendingActivityUpdate = false;
  private roomStatusText?: Phaser.GameObjects.Text;
  private readonly showDebugInfo: boolean;
  private joinRole: "bird" | "gm" = "bird";
  private localPlayerIsGM: boolean = false;

  private stagePopup?: Phaser.GameObjects.Container;
  private volumeSlider?: Phaser.GameObjects.Rectangle;
  private volumeSliderHitArea?: Phaser.GameObjects.Zone;
  private volumeSliderKnob?: Phaser.GameObjects.Rectangle;
  private volumeText?: Phaser.GameObjects.Text;
  private currentVolume: number = 0.1;  // Default volume
  private isDraggingVolume: boolean = false;

  constructor() {
    super("Game");

    const params = new URLSearchParams(location.search);
    const envDebug = import.meta.env?.VITE_SHOW_DEBUG ?? "";
    const normalizedEnvDebug = envDebug.toString().toLowerCase();
    const queryDebug = (params.get("debug") ?? "").toLowerCase();

    this.showDebugInfo =
      normalizedEnvDebug === "1" ||
      normalizedEnvDebug === "true" ||
      queryDebug === "1" ||
      queryDebug === "true" ||
      params.has("debug");
  }

  init(data?: { role?: "bird" | "gm" }) {
    if (data?.role === "gm") {
      this.joinRole = "gm";
    } else {
      this.joinRole = "bird";
    }
  }

  async create() {

    this.setupWorld();
    this.setupUI();
    this.setupInput();

    await this.connect();
    this.room?.onStateChange.once(() => {
      this.registerStateListeners();
    });
    // Wait a moment for the room state to be fully initialized
    setTimeout(() => {
      this.updateReadyUI();
    }, 100);
  }

  update(_time: number, delta: number) {
    const stageValue = this.getCurrentStageValue();
    if (stageValue !== this.lastKnownStage) {
      this.lastKnownStage = stageValue;
      console.log("Detected stage change:", stageValue);
      this.refreshScoreboard();
      this.updateStatusMessage();
      if (stageValue > 1) {
        this.showStagePopup(stageValue);
      }
    }

    const clampedStage = Math.max(0, Math.min(this.maxStage, stageValue));
    const stageMultiplier = clampedStage <= 0 ? 1 : 1 + this.stageSpeedIncrement * (clampedStage - 1);
    const targetScrollSpeed = this.baseScrollSpeed * stageMultiplier;
    this.currentScrollSpeed = Phaser.Math.Linear(this.currentScrollSpeed, targetScrollSpeed, 0.1);

    const scroll = (this.currentScrollSpeed * delta) / 1000;
    this.background.tilePositionX += scroll;
    this.ground.tilePositionX += scroll;

    const interpolationAlpha = Phaser.Math.Clamp(
      1 - Math.exp((-this.pipeLerpSpeed * delta) / 1000),
      0,
      1,
    );
    this.pipeSprites.forEach((sprites) => {
      sprites.top.x = Phaser.Math.Linear(sprites.top.x, sprites.targetX, interpolationAlpha);
      sprites.bottom.x = Phaser.Math.Linear(sprites.bottom.x, sprites.targetX, interpolationAlpha);
      sprites.top.y = Phaser.Math.Linear(sprites.top.y, sprites.targetTopY, interpolationAlpha);
      sprites.bottom.y = Phaser.Math.Linear(sprites.bottom.y, sprites.targetBottomY, interpolationAlpha);
    });

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

      if (currentRunning && this.room.state.pipes) {
        this.room.state.pipes.forEach((pipe: PipeState) => {
          this.updatePipe(pipe);
        });
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

  private showStagePopup(stage: number) {
    // Clean up existing popup if it exists
    this.stagePopup?.destroy();

    const width = Number(this.game.config.width);
    const height = Number(this.game.config.height);

    // Create a new container for the popup near the top
    this.stagePopup = this.add.container(width / 2, 120).setDepth(100);

    // Add background with glow effect - more transparent and smaller
    const bg = this.add.rectangle(0, 0, 400, 80, 0x000000, 0.6)
      .setStrokeStyle(3, 0xff8c00ff);

    // Add chevrons for extra flair
    const leftChevrons = this.add.text(-180, 0, ">>", {
      fontFamily: "Arial Black",
      fontSize: 32,
      color: '#ff8c00ff',
      stroke: '#000000',
      strokeThickness: 4
    }).setOrigin(0.5);

    const rightChevrons = this.add.text(180, 0, "<<", {
      fontFamily: "Arial Black",
      fontSize: 32,
      color: '#ff8c00ff',
      stroke: '#000000',
      strokeThickness: 4
    }).setOrigin(0.5);

    // Add text with dynamic styling - smaller font
    const text = this.add.text(0, 0,
      `STAGE ${stage}! SPEED +${Math.round(stage * 20)}%`, {
      fontFamily: "Arial Black",
      fontSize: 32,
      color: '#ff8c00ff',
      align: 'center',
      stroke: '#000000',
      strokeThickness: 6
    }).setOrigin(0.5);

    // Add items to container
    this.stagePopup.add([bg, text, leftChevrons, rightChevrons]);

    // Play sound effect
    this.sound.play("swoosh", { volume: 0.4 });

    // Animate chevrons
    this.tweens.add({
      targets: [leftChevrons, rightChevrons],
      x: {
        getStart: (target: any) => target.x,
        getEnd: (target: any) => target.x + (target.x < 0 ? -20 : 20)
      },
      duration: 300,
      yoyo: true,
      repeat: 2
    });

    // Add scale animation
    this.stagePopup.setScale(0);
    this.tweens.add({
      targets: this.stagePopup,
      scaleX: 1,
      scaleY: 1,
      duration: 300,
      ease: 'Back.out',
      onComplete: () => {
        // Add flash effect
        this.tweens.add({
          targets: bg,
          strokeThickness: 6,
          duration: 100,
          yoyo: true,
          repeat: 2
        });
        // Remove popup after delay
        this.time.delayedCall(1200, () => {
          this.tweens.add({
            targets: this.stagePopup,
            scaleX: 0,
            scaleY: 0,
            duration: 200,
            ease: 'Back.in',
            onComplete: () => {
              this.stagePopup?.destroy();
            }
          });
        });
      }
    });
  }

  private setupUI() {
    const width = Number(this.game.config.width);
    const height = Number(this.game.config.height);

    // Create score text first so we can size the backdrop to match
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

    const padding = 40;  // Horizontal padding for the backdrop
    this.scoreBackdrop = this.add
      .rectangle(
        this.scoreText.x,
        this.scoreText.y,
        this.scoreText.width + padding,
        70,
        0x000000,
        0.35
      )
      .setOrigin(0.5)
      .setDepth(10);

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

    // Create volume control
    const sliderWidth = 100;
    const sliderHeight = 4;
    const knobSize = 15;
    const sliderY = height - 70;

    // Create slider background with larger hit area
    this.volumeSlider = this.add
      .rectangle(width - 80, sliderY, sliderWidth, sliderHeight, 0x666666)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(11);

    this.volumeSliderHitArea = this.add
      .zone(width - 80, sliderY, sliderWidth, 30)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true, cursor: "pointer" })
      .setDepth(12);

    this.volumeSliderHitArea
      .on("pointerdown", this.startVolumeChange, this)
      .on("pointermove", (pointer: Phaser.Input.Pointer) => {
        if (this.isDraggingVolume) {
          this.updateVolume(pointer);
        }
      })
      .on("pointerup", this.endVolumeChange, this)
      .on("pointerout", this.endVolumeChange, this);

    // Create slider knob
    this.volumeSliderKnob = this.add
      .rectangle(
        width - 80 + (sliderWidth * this.currentVolume) - (sliderWidth / 2),
        sliderY,
        knobSize,
        knobSize,
        0xffffff
      )
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(13)
      .setInteractive({ useHandCursor: true, cursor: "pointer" });

    this.volumeSliderKnob.on("pointerdown", this.startVolumeChange, this);
    this.input.setDraggable(this.volumeSliderKnob);

    this.input.on("dragstart", (pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.GameObject) => {
      if (gameObject === this.volumeSliderKnob) {
        this.startVolumeChange(pointer);
      }
    });

    this.input.on("drag", (pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.GameObject) => {
      if (gameObject === this.volumeSliderKnob) {
        this.applyVolumeFromPointer(pointer);
      }
    });

    this.input.on("dragend", (_pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.GameObject) => {
      if (gameObject === this.volumeSliderKnob) {
        this.endVolumeChange();
      }
    });

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (this.isDraggingVolume) {
        this.updateVolume(pointer);
      }
    });

    this.input.on("pointerup", this.endVolumeChange, this);

    // Add volume label
    this.volumeText = this.add
      .text(width - 80, sliderY - 20, `Volume ${Math.round(this.currentVolume * 100)}%`, {
        font: "16px Arial",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(11);

    // Only create debug room status text if debug is enabled
    if (this.showDebugInfo) {
      this.roomStatusText = this.add
        .text(100, 600, "Room Status", {
          fontFamily: "Arial Black",
          fontSize: 26,
          color: "#ff0000",
          stroke: "#000000",
          strokeThickness: 4,
        })
        .setDepth(100);
    }

    this.updateReadyUI();
    this.setupGameOverScreen();
  }

  private updateSkinOptionsFromState() {
    if (!this.room || !this.room.state) {
      return;
    }

    const stateOptions = (this.room.state as any).skinOptions as Array<string> | undefined;
    if (!stateOptions) {
      return;
    }

    const nextOptions = Array.from(stateOptions);
    if (!this.haveSkinOptionsChanged(nextOptions)) {
      return;
    }

    this.skinOptions = nextOptions;
    this.rebuildSkinSelection();
    this.updateSkinSlots();
  }

  private haveSkinOptionsChanged(next: string[]) {
    if (this.skinOptions.length !== next.length) {
      return true;
    }

    for (let i = 0; i < next.length; i += 1) {
      if (this.skinOptions[i] !== next[i]) {
        return true;
      }
    }

    return false;
  }

  private rebuildSkinSelection() {
    this.skinSelectionContainer?.destroy(true);
    this.skinSelectionContainer = undefined;
    this.skinSlotElements.clear();

    if (this.skinOptions.length === 0) {
      return;
    }

    const width = Number(this.game.config.width);
    const margin = 36;
    const columns = Math.min(4, this.skinOptions.length);
    const slotWidth = 88;
    const slotHeight = 104;
    const spacingX = 14;
    const spacingY = 20;
    const rows = Math.ceil(this.skinOptions.length / columns);
    const gridWidth = columns * slotWidth + (columns - 1) * spacingX;
    const gridHeight = rows * slotHeight + (rows - 1) * spacingY;
    const headerHeight = 80;
    const panelPadding = 24;
    const panelWidth = gridWidth + panelPadding * 2;
    const panelHeight = headerHeight + gridHeight + panelPadding;
    const containerX = width - panelWidth / 2 - margin;
    const containerY = 260;

    const container = this.add.container(containerX, containerY);
    container.setDepth(12);

    const background = this.add
      .rectangle(0, 0, panelWidth, panelHeight, 0x000000, 0.55)
      .setStrokeStyle(2, 0xffffff, 0.35)
      .setOrigin(0.5);
    container.add(background);

    const panelTop = -panelHeight / 2;
    const title = this.add
      .text(0, panelTop + 28, "Choose Your Bird", {
        fontFamily: "Arial Black",
        fontSize: 22,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 6,
        align: "center",
      })
      .setOrigin(0.5);
    container.add(title);

    const subtitle = this.add
      .text(0, panelTop + 56, "Each skin can only be used once", {
        fontFamily: "Arial",
        fontSize: 16,
        color: "#dddddd",
        stroke: "#000000",
        strokeThickness: 4,
        align: "center",
      })
      .setOrigin(0.5);
    container.add(subtitle);

    const gridStartY = panelTop + headerHeight + slotHeight / 2;
    const gridStartX = -gridWidth / 2 + slotWidth / 2;

    this.skinOptions.forEach((skin, index) => {
      const row = Math.floor(index / columns);
      const col = index % columns;
      const x = gridStartX + col * (slotWidth + spacingX);
      const y = gridStartY + row * (slotHeight + spacingY);

      const slotContainer = this.add.container(x, y);
      const backgroundRect = this.add
        .rectangle(0, 0, slotWidth, slotHeight, 0x1a1a1a, 0.62)
        .setOrigin(0.5)
        .setStrokeStyle(2, 0xffffff, 0.4)
        .setInteractive({ useHandCursor: true });
      backgroundRect.on("pointerdown", () => this.requestSkinSelection(skin));

      const preview = this.add.image(0, -18, this.getBirdTexture(skin)).setScale(0.9);

      const label = this.add
        .text(0, slotHeight / 2 - 32, this.formatSkinLabel(skin), {
          fontFamily: "Arial Black",
          fontSize: 16,
          color: "#ffffff",
          stroke: "#000000",
          strokeThickness: 4,
          align: "center",
        })
        .setOrigin(0.5);

      const ownerText = this.add
        .text(0, slotHeight / 2 - 10, "", {
          fontFamily: "Arial",
          fontSize: 15,
          color: "#c0ffc0",
          stroke: "#000000",
          strokeThickness: 4,
          align: "center",
        })
        .setOrigin(0.5);

      slotContainer.add([backgroundRect, preview, label, ownerText]);
      container.add(slotContainer);
      this.skinSlotElements.set(skin, {
        container: slotContainer,
        background: backgroundRect,
        preview,
        label,
        ownerText,
      });
    });

    this.skinSelectionContainer = container;
    const canShow = !this.room?.state?.running && this.getPlayerCount() > 0;
    this.setSkinSelectionVisible(canShow);
  }

  private setSkinSelectionVisible(visible: boolean) {
    if (!this.skinSelectionContainer) {
      return;
    }

    this.skinSelectionContainer.setVisible(visible);
    this.skinSlotElements.forEach((elements) => {
      if (visible) {
        elements.background.setInteractive({ useHandCursor: true });
      } else {
        elements.background.disableInteractive();
      }
    });

    if (visible) {
      this.updateSkinSlots();
    }
  }

  private updateSkinSlots() {
    if (!this.skinSelectionContainer) {
      return;
    }

    const isVisible = this.skinSelectionContainer.visible;
    const localId = this.localPlayerId;

    this.skinSlotElements.forEach((elements, skin) => {
      const owner = this.getSkinOwner(skin);
      const ownedByLocal = owner?.sessionId === localId;
      const takenByOther = !!owner && !ownedByLocal;

      const baseFill = takenByOther ? 0x3b1a1a : ownedByLocal ? 0x1f3f2b : 0x1a1a1a;
      const baseAlpha = takenByOther ? 0.85 : ownedByLocal ? 0.75 : 0.6;
      elements.background.setFillStyle(baseFill, baseAlpha);

      const strokeWidth = ownedByLocal ? 3 : 2;
      const strokeColor = takenByOther ? 0xff6b6b : ownedByLocal ? 0xffd369 : 0xffffff;
      const strokeAlpha = takenByOther ? 0.65 : ownedByLocal ? 0.9 : 0.4;
      elements.background.setStrokeStyle(strokeWidth, strokeColor, strokeAlpha);

      if (!owner) {
        elements.ownerText.setText("Available");
        elements.ownerText.setColor("#b8ffc2");
      } else if (ownedByLocal) {
        elements.ownerText.setText("You");
        elements.ownerText.setColor("#ffe7a6");
      } else {
        elements.ownerText.setText(this.formatOwnerName(owner.name));
        elements.ownerText.setColor("#ff9393");
      }

      if (isVisible && !takenByOther && !this.room?.state?.running) {
        elements.background.setInteractive({ useHandCursor: true });
      } else {
        elements.background.disableInteractive();
      }

      const previewTexture = this.getBirdTexture(skin);
      if (previewTexture && elements.preview.texture.key !== previewTexture) {
        elements.preview.setTexture(previewTexture);
      }
    });
  }

  private requestSkinSelection(skin: string) {
    if (!this.room || !this.room.sessionId) {
      return;
    }

    if (this.room.state?.running) {
      return;
    }

    const owner = this.getSkinOwner(skin);
    if (owner && owner.sessionId !== this.localPlayerId) {
      return;
    }

    const localPlayer = this.room.state.players
      ? (this.room.state.players.get(this.localPlayerId) as PlayerState | undefined)
      : undefined;
    if (localPlayer && localPlayer.skin === skin) {
      return;
    }

    this.room.send("selectSkin", { skin });
  }

  private getSkinOwner(skin: string): { sessionId: string; name: string } | undefined {
    if (!this.room || !this.room.state?.players) {
      return undefined;
    }

    let owner: { sessionId: string; name: string } | undefined;
    this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
      if (!owner && player.skin === skin) {
        owner = { sessionId, name: player.name };
      }
    });

    return owner;
  }

  private formatSkinLabel(skin: string) {
    const normalized = this.normalizeSkinKey(skin);
    if (!normalized) {
      return "Default";
    }
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  private formatOwnerName(name: string) {
    const trimmed = name.trim();
    if (trimmed.length <= 14) {
      return trimmed || "Taken";
    }
    return `${trimmed.slice(0, 13)}...`;
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
    overlay.setInteractive({ useHandCursor: false });
    overlay.on("pointerdown", (pointer) => {      // do nothing — this just blocks input below
    });

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
    const buttonWidth = 240;
    const buttonHeight = 60;
    const playAgainY = 80;

    this.restartButton = this.add.rectangle(0, playAgainY, buttonWidth, buttonHeight, 0x27ae60, 0.9);
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

    this.restartButtonLabel = this.add.text(0, playAgainY, "Play Again", {
      fontFamily: "Arial Black",
      fontSize: 24,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    });
    this.restartButtonLabel.setOrigin(0.5);
    this.gameOverScreen.add(this.restartButtonLabel);

    // Return to Menu button
    const returnY = playAgainY + 75;
    this.returnButton = this.add.rectangle(0, returnY, buttonWidth, buttonHeight, 0x8e44ad, 0.9);
    this.returnButton.setOrigin(0.5);
    this.returnButton.setInteractive({ useHandCursor: true });
    this.returnButton.on("pointerdown", () => this.returnToMenu());
    this.returnButton.on("pointerover", () => {
      this.returnButton?.setFillStyle(0x9b59b6, 0.95);
    });
    this.returnButton.on("pointerout", () => {
      this.returnButton?.setFillStyle(0x8e44ad, 0.9);
    });
    this.gameOverScreen.add(this.returnButton);

    this.returnButtonLabel = this.add.text(0, returnY, "Return to Menu", {
      fontFamily: "Arial Black",
      fontSize: 24,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    });
    this.returnButtonLabel.setOrigin(0.5);
    this.gameOverScreen.add(this.returnButtonLabel);
  }

  private setupInput() {
    console.log("setupInput() called");
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.handleFlap(pointer));
    this.input.keyboard?.on("keydown-SPACE", () => this.handleFlap());
    this.input.keyboard?.on("keydown-UP", () => this.handleFlap());
  }

  private handleFlap(pointer?: Phaser.Input.Pointer) {
    if (this.isDraggingVolume) {
      return;
    }

    if (pointer && this.isPointerOverVolumeUI(pointer)) {
      return;
    }

    // Spectators do not flap
    if (this.localPlayerIsGM) {
      return;
    }

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

  private getPointerPosition(pointer: Phaser.Input.Pointer) {
    const camera = this.cameras?.main;
    if (camera) {
      const out = new Phaser.Math.Vector2();
      pointer.positionToCamera(camera, out);
      return out;
    }
    return new Phaser.Math.Vector2(pointer.x, pointer.y);
  }

  private getVolumeTrackBounds() {
    if (!this.volumeSlider) {
      return undefined;
    }

    return this.volumeSlider.getBounds();
  }

  private getVolumeKnobBounds() {
    if (!this.volumeSliderKnob) {
      return undefined;
    }

    return this.volumeSliderKnob.getBounds();
  }

  private getVolumeHitBounds() {
    if (this.volumeSliderHitArea) {
      return this.volumeSliderHitArea.getBounds();
    }

    return this.getVolumeTrackBounds();
  }

  private isPointerOverVolumeUI(pointer: Phaser.Input.Pointer) {
    const pointerPosition = this.getPointerPosition(pointer);
    const pointerX = pointerPosition.x;
    const pointerY = pointerPosition.y;

    const hitBounds = this.getVolumeHitBounds();
    if (hitBounds && Phaser.Geom.Rectangle.Contains(hitBounds, pointerX, pointerY)) {
      return true;
    }

    const knobBounds = this.getVolumeKnobBounds();
    if (knobBounds && Phaser.Geom.Rectangle.Contains(knobBounds, pointerX, pointerY)) {
      return true;
    }

    return false;
  }

  private applyVolumeFromPointer(pointer: Phaser.Input.Pointer) {
    const trackBounds = this.getVolumeTrackBounds();
    if (!trackBounds || !this.volumeSliderKnob) {
      return;
    }

    const pointerPosition = this.getPointerPosition(pointer);
    const pointerX = pointerPosition.x;
    const clampedX = Phaser.Math.Clamp(pointerX, trackBounds.left, trackBounds.right);
    let volume = (clampedX - trackBounds.left) / trackBounds.width;
    volume = Phaser.Math.Clamp(Math.round(volume * 100) / 100, 0, 1);

    this.currentVolume = volume;
    this.volumeSliderKnob.x = clampedX;
    this.volumeSliderKnob.y = trackBounds.centerY;

    if (this.volumeText) {
      this.volumeText.setText(`Volume ${Math.round(volume * 100)}%`);
    }

    this.sound.setVolume(volume);
  }

  private startVolumeChange(pointer: Phaser.Input.Pointer) {
    if (!this.volumeSlider) return;

    pointer.event?.stopPropagation?.();
    pointer.event?.preventDefault?.();

    this.isDraggingVolume = true;
    this.applyVolumeFromPointer(pointer);
  }

  private updateVolume(pointer: Phaser.Input.Pointer) {
    if (!this.isDraggingVolume && !pointer.isDown) {
      return;
    }

    this.applyVolumeFromPointer(pointer);
  }

  private endVolumeChange(_pointer?: Phaser.Input.Pointer) {
    this.isDraggingVolume = false;
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
    // Do not show Ready UI for spectators (GM)
    const showLobbyUi = !running && playerCount > 0 && !this.localPlayerIsGM;

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
    this.setSkinSelectionVisible(showLobbyUi && !this.localPlayerIsGM);

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
        role: this.joinRole,
      });
      this.localPlayerId = this.room.sessionId;
      console.log("Connected to room, sessionId:", this.localPlayerId);
      void this.updateDiscordActivityPresence();
    } catch (e) {
      console.log(`Could not connect with the server: ${e}`);
      this.scoreText.setText("Connection failed");
    }
  }

  private async returnToMenu() {
    try {
      if (this.room) {
        await this.room.leave();
      }
    } catch (e) {
      console.warn("Error leaving room while returning to menu:", e);
    }

    // Clean up some UI elements explicitly
    this.gameOverScreen?.setVisible(false);

    // Transition back to main menu for role re-selection
    this.scene.start("MainMenu");
  }

  private registerStateListeners() {
    if (!this.room || !this.room.state) {
      console.log("No room or state, skipping state listeners");
      return;
    }

    if (!this.room.state.pipes) {
      console.log("No pipes when registering state listeners")
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

    this.updateSkinOptionsFromState();
    const skinOptionsState = (this.room.state as any).skinOptions;
    if (skinOptionsState) {
      const skinCallbacks = $(skinOptionsState);
      skinCallbacks.onAdd(() => this.updateSkinOptionsFromState());
      skinCallbacks.onRemove(() => this.updateSkinOptionsFromState());
      skinCallbacks.onChange(() => this.updateSkinOptionsFromState());
    }

    $(this.room.state.players).onAdd((player: PlayerState, sessionId: string) => {
      const sprite = this.playerSprites.get(sessionId);
      if (!sprite) {
        console.log("Player added to room via onAdd:", sessionId, player.name, "ready:", player.ready);
        this.addPlayer(sessionId, player);
      }
      // Note: Individual player onChange callbacks are not working properly
      // We'll use periodic sync instead
    });

    $(this.room.state.players).onRemove((_player: PlayerState, sessionId: string) => {
      this.removePlayer(sessionId);
    });

    // Hydrate existing pipes
    if (this.room.state.pipes instanceof Array) {
      (this.room.state.pipes as any[]).forEach((pipe: PipeState) => {
        console.log("Hydrate pipe:", pipe);
        this.addPipe(pipe);
      });
    }

    // Subscribe for additions of pipes
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
          if (change.field === "running" || change.field === "winnerId" || change.field === "stage") {
            console.log("Updating status message due to state change:", change.field);
            this.updateStatusMessage();
          }
          if (change.field === "stage") {
            console.log("Stage changed, refreshing scoreboard");
            this.refreshScoreboard();
          }
          if (change.field === "skinOptions") {
            this.updateSkinOptionsFromState();
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
    const isGM = (player.role as any) === "gm";
    if (!isGM) {
      const sprite = this.add.sprite(this.birdX, player.y, this.getBirdTexture(player.skin));
      sprite.setDepth(5);
      this.applySkinToSprite(sprite, player.skin);

      if (sessionId === this.localPlayerId) {
        sprite.setScale(1.05);
        sprite.setTint(0xffffaa);
      }

      this.playerSprites.set(sessionId, sprite);
    }

    this.playerCache.set(sessionId, { alive: player.alive, score: player.score, ready: player.ready, skin: player.skin });

    if (sessionId === this.localPlayerId) {
      this.localPlayerReady = player.ready;
      this.localPlayerIsGM = isGM;
      console.log("Set local player ready state to:", player.ready, "isGM:", isGM);
    }

    if (!isGM) {
      this.syncPlayer(sessionId, player, []);
    }
    this.refreshScoreboard();
    this.updateStatusMessage();
    this.updateReadyUI();
    this.updateSkinSlots();

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
    this.updateSkinSlots();
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
    const skinChanged = !cached || cached.skin !== player.skin;
    if (cached) {
      if (cached.alive && !player.alive && sessionId === this.localPlayerId) {
        this.sound.play("hit", { volume: 0.4 });
        this.sound.play("die", { volume: 0.4, delay: 0.1 });
      }
      if (player.score > cached.score && sessionId === this.localPlayerId) {
        this.sound.play("point", { volume: 0.5 });
      }
    }

    if (skinChanged) {
      this.applySkinToSprite(sprite, player.skin);
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

    this.playerCache.set(sessionId, { alive: player.alive, score: player.score, ready: player.ready, skin: player.skin });
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
    if (skinChanged) {
      this.updateSkinSlots();
    }
  }

  private applySkinToSprite(sprite: Phaser.GameObjects.Sprite, skin: string) {
    const textureKey = this.getBirdTexture(skin);
    if (textureKey && sprite.texture?.key !== textureKey) {
      sprite.setTexture(textureKey);
    }

    const animationKey = this.getBirdAnimation(skin);
    if (animationKey) {
      const currentAnimKey = sprite.anims?.currentAnim?.key;
      if (currentAnimKey !== animationKey) {
        sprite.play(animationKey, true);
      }
    } else if (sprite.anims?.isPlaying) {
      sprite.anims.stop();
    }
  }

  private getBirdTexture(skin: PlayerState["skin"]) {
    const normalized = this.normalizeSkinKey(skin);
    const candidate = normalized ? `${normalized}bird-midflap` : "";
    if (candidate && this.textures.exists(candidate)) {
      return candidate;
    }
    if (this.textures.exists("yellowbird-midflap")) {
      return "yellowbird-midflap";
    }

    const fallbackKeys = this.textures.getTextureKeys();
    return fallbackKeys.length > 0 ? fallbackKeys[0] : "";
  }

  private getBirdAnimation(skin: PlayerState["skin"]) {
    const normalized = this.normalizeSkinKey(skin);
    const candidate = normalized ? `${normalized}_fly` : "";
    if (candidate && this.anims.exists(candidate)) {
      return candidate;
    }
    return this.anims.exists("yellow_fly") ? "yellow_fly" : "";
  }

  private normalizeSkinKey(skin: string) {
    return (skin ?? "").toString().trim().toLowerCase();
  }

  private addPipe(pipe: PipeState) {
    console.log("Adding pipe:", pipe.id, "at x:", pipe.x, "Ytop:", pipe.Ytop);

    const top = this.add.image(pipe.x, pipe.Ytop, "pipe");
    top.setOrigin(0.5, 0);
    top.setFlipY(true);
    top.setDepth(3);
    console.log("Created top pipe at:", pipe.x, pipe.Ytop);

    const bottom = this.add.image(pipe.x, pipe.Ybottom, "pipe-red");
    bottom.setOrigin(0.5, 0);
    bottom.setFlipY(false);
    bottom.setDepth(4);
    console.log("Created bottom pipe at:", pipe.x, pipe.Ybottom);

    this.pipeSprites.set(pipe.id, {
      top,
      bottom,
      targetX: pipe.x,
      targetTopY: pipe.Ytop,
      targetBottomY: pipe.Ybottom,
    });
    this.updatePipe(pipe);
    console.log("Pipe added successfully, total pipes:", this.pipeSprites.size);
  }

  private updatePipe(pipe: PipeState) {
    const sprites = this.pipeSprites.get(pipe.id);
    if (!sprites) {
      return;
    }

    sprites.targetX = pipe.x;
    sprites.targetTopY = pipe.Ytop;
    sprites.targetBottomY = pipe.Ybottom;
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

  private getCurrentStageValue(): number {
    if (!this.room || !this.room.state) {
      return 0;
    }

    const running = Boolean(this.room.state.running);
    const difficultyValue = Number((this.room.state as any).difficulty ?? 0);
    const derivedStage = running
      ? Math.min(this.maxStage, Math.floor(difficultyValue / this.stageDurationSeconds) + 1)
      : 0;

    const rawStage = Number((this.room.state as any).stage);
    let stageValue = Number.isFinite(rawStage) ? rawStage : derivedStage;

    if (running && stageValue <= 0) {
      stageValue = derivedStage;
    }

    if (!running) {
      stageValue = 0;
    }

    return Math.max(0, Math.min(this.maxStage, Math.floor(stageValue)));
  }

  private refreshScoreboard() {
    if (!this.room) {
      return;
    }

    const players: Array<{ name: string; score: number; alive: boolean; ready: boolean; isLocal: boolean; role?: PlayerState["role"] }> = [];

    this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
      players.push({
        name: player.name,
        score: player.score,
        alive: player.alive,
        ready: player.ready,
        isLocal: sessionId === this.localPlayerId,
        role: player.role,
      });
    });

    players.sort((a, b) => {
      if (b.score === a.score) {
        return a.name.localeCompare(b.name);
      }
      return b.score - a.score;
    });

    const running = this.room.state.running as boolean;
    const stageValue = this.getCurrentStageValue();
    const clampedStage = Math.max(0, Math.min(this.maxStage, stageValue));

    if (players.length === 0) {
      this.scoreText.setText("Waiting for players...");
    } else {
      const headerLines: string[] = [];
      if (running) {
        headerLines.push(`Stage ${Math.max(1, clampedStage)}/${this.maxStage}`);
      }

      const lines = players.map((player) => {
        // Game Master spectates only
        if ((player as any).role === "gm") {
          return `${player.isLocal ? "* " : ""}${player.name} (GM) — Spectating`;
        }
        const prefix = player.isLocal ? "▶ " : "";
        if (running) {
          const status = player.alive ? "🟢" : "✖";
          return `${prefix}${player.name}: ${player.score} ${status}`;
        }

        const status = player.ready ? "✅ Ready" : "⌛ Waiting";
        return `${prefix}${player.name} ${status}`;
      });
      this.scoreText.setText([...headerLines, ...lines].join("\n"));
    }

    // Update backdrop size and ensure it stays centered
    const padding = 40;
    const verticalPadding = 30;
    this.scoreBackdrop.setSize(this.scoreText.width + padding, this.scoreText.height + verticalPadding);
    this.scoreBackdrop.setPosition(this.scoreText.x, this.scoreText.y);
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
    const stageValue = this.getCurrentStageValue();
    const stageLabel = stageValue > 0 ? `${stageValue}/${this.maxStage}` : "Lobby";
    const difficultyValue = Number((this.room.state as any).difficulty ?? 0);
    const difficultyText = difficultyValue.toFixed(1);

    // Update debug info if enabled
    if (this.showDebugInfo && this.roomStatusText) {
      this.roomStatusText.setText(
        `Running: ${running} Players: ${playerCount} Stage: ${stageLabel} Difficulty: ${difficultyText}`,
      );
    }

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
      const stagePrefix = stageValue > 0 ? `Stage ${stageValue}/${this.maxStage}\n` : "";
      if (playerCount === 1) {
        this.statusText.setText(`${stagePrefix}Flap to stay alive! Try to get a high score!`);
      } else {
        this.statusText.setText(`${stagePrefix}Flap to stay alive! Last bird standing wins.`);
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
    this.room.state.players.forEach((player: PlayerState) => {
      if ((player.role as any) !== "gm") {
        count += 1;
      }
    });
    return count;
  }

  private getReadyCount() {
    if (!this.room || !this.room.state || !this.room.state.players) {
      return 0;
    }
    let count = 0;
    this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
      if ((player.role as any) === "gm") {
        return;
      }
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
