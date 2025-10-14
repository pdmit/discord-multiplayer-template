import { Scene } from "phaser";
import { Room, Client, getStateCallbacks } from "colyseus.js";
import { discordSdk, getUserName } from "../utils/discordSDK";

type PlayerState = {
  name: string;
  skin: string;
  y: number;
  velocity: number;
  alive: boolean;
  shield?: boolean;
  shieldUntil?: number;
  shieldExpiring?: boolean;
  shieldGraceUntil?: number;
  score: number;
  lastPassedPipeId: number;
  ready: boolean;
  role?: "bird" | "gm" | "spectator"; // optional for backward compat
  birdHighScore?: number; // personal best as bird (pipes)
  pigBestTime?: number;   // personal best as GM (seconds, lower is better)
};

type PipeState = {
  id: number;
  x: number;
  Ytop: number;
  Ybottom: number;
};

type PlacedObstacleState = {
  id: number;
  x: number;
  y: number; // top Y of the sprite
  kind: "top" | "bottom";
};

type PigKingState = {
  health: number;
  maxHealth: number;
};

type PowerUpState = {
  id: number;
  x: number;
  y: number;
  type: string;
  name: string;
  sprite: string;
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
  private shieldAuras = new Map<string, Phaser.GameObjects.Ellipse>();
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
  private placedObstacleSprites = new Map<number, { img: Phaser.GameObjects.Image; targetX: number; targetY: number }>();
  private playerCache = new Map<string, { alive: boolean; score: number; ready: boolean; skin: string }>();
  private skinOptions: string[] = [];
  private skinSelectionContainer?: Phaser.GameObjects.Container;
  private skinSlotElements = new Map<string, SkinSlotElements>();
  private scoreText!: Phaser.GameObjects.Text;
  private scoreBackdrop!: Phaser.GameObjects.Rectangle;
  private statusText!: Phaser.GameObjects.Text;
  private scorePulseTween?: Phaser.Tweens.Tween;
  private readyCountText!: Phaser.GameObjects.Text;
  private readyButtonBackground?: Phaser.GameObjects.Rectangle;
  private readyButtonLabel?: Phaser.GameObjects.Text;
  private gameOverScreen?: Phaser.GameObjects.Container;
  private gameOverText?: Phaser.GameObjects.Text;
  private gameOverScoreText?: Phaser.GameObjects.Text;
  private gameOverHighText?: Phaser.GameObjects.Text;
  private gameOverTeamsText?: Phaser.GameObjects.Text;
  private gameOverPanel?: Phaser.GameObjects.Container;
  private gameOverPanelBg?: Phaser.GameObjects.Graphics;
  private gameOverPanelShadow?: Phaser.GameObjects.Graphics;
  private gameOverShowTween?: Phaser.Tweens.Tween;
  private gameOverFadeTween?: Phaser.Tweens.Tween;
  // Tweens/timer used to animate the status text at round start
  private statusIntroTween?: Phaser.Tweens.Tween;
  private statusIntroHold?: Phaser.Time.TimerEvent;
  private isStatusIntroActive: boolean = false;
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
  private localPlayerRole: "bird" | "gm" | "spectator" = "bird";

  private stagePopup?: Phaser.GameObjects.Container;
  private volumeSlider?: Phaser.GameObjects.Rectangle;
  private volumeSliderHitArea?: Phaser.GameObjects.Zone;
  private volumeSliderKnob?: Phaser.GameObjects.Rectangle;
  private volumeText?: Phaser.GameObjects.Text;
  private currentVolume: number = 0.1;  // Default volume
  private isDraggingVolume: boolean = false;

  // GM tools and preview
  private gmToolbar?: Phaser.GameObjects.Container;
  private gmToolSelected: ("top" | "bottom") | null = null;
  private gmPreviewSprite?: Phaser.GameObjects.Image;
  private gmToolButtons: Map<"top" | "bottom", { bg: Phaser.GameObjects.Rectangle; txt: Phaser.GameObjects.Text }> = new Map();
  private gmCharges: number = 2;
  private gmMaxCharges: number = 2;
  private gmNextReadyAt: number = 0;
  private gmChargeText?: Phaser.GameObjects.Text;
  // GM cursor (visible to all players)
  private gmCursor?: Phaser.GameObjects.Container;
  private gmCursorSprite?: Phaser.GameObjects.Image;
  private gmCursorCloseTimer?: Phaser.Time.TimerEvent;

  // Mirror server gap logic for client-side preview (constants must match server)
  private readonly previewMaxPipeGap = 300;
  private readonly previewMinPipeGap = 60;
  private readonly previewGapShrinkPerSec = 2.4;

  // GM gap guide lines (center +/- gap/2), drawn as dashed Graphics
  private gmGapGfxTop?: Phaser.GameObjects.Graphics;
  private gmGapGfxBottom?: Phaser.GameObjects.Graphics;
  private gmXClampTint?: Phaser.GameObjects.Rectangle;

  // Pig King health UI
  private pigBarContainer?: Phaser.GameObjects.Container;
  private pigBarBg?: Phaser.GameObjects.Rectangle;
  private pigBarFill?: Phaser.GameObjects.Rectangle;
  private pigBarText?: Phaser.GameObjects.Text;
  private pigAvatar?: Phaser.GameObjects.Image;
  private pigFlashTween?: Phaser.Tweens.Tween;
  private lastPigHealth: number = -1;
  private readonly pigBarWidth: number = 200;
  private readonly pigBarHeight: number = 18;
  private readonly pigAvatarSize: number = 40;
  // Delay UI health update to sync with thrown-hammer arrival
  private pigImpactHoldUntil: number = 0; // game clock ms when UI can apply next health change
  private pigPendingUI?: { health: number; max: number };
  private pigUIApplyTimer?: Phaser.Time.TimerEvent;

  // Win banner
  private winBanner?: Phaser.GameObjects.Container;
  private winBannerTimeout?: Phaser.Time.TimerEvent;
  private lastWinBannerKind?: "birds" | "pig";

  // Power-ups
  private powerUpSprites = new Map<number, { img: Phaser.GameObjects.Image; targetX: number; targetY: number }>();

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

    // Register lifecycle cleanup hooks to ensure UI and listeners are released
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.onDestroy, this);

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

    // Smoothly interpolate placed obstacles towards server targets
    this.placedObstacleSprites.forEach((entry) => {
      entry.img.x = Phaser.Math.Linear(entry.img.x, entry.targetX, interpolationAlpha);
      entry.img.y = Phaser.Math.Linear(entry.img.y, entry.targetY, interpolationAlpha);
    });
    // Smoothly interpolate power-ups towards server targets
    this.powerUpSprites.forEach((entry) => {
      entry.img.x = Phaser.Math.Linear(entry.img.x, entry.targetX, interpolationAlpha);
      entry.img.y = Phaser.Math.Linear(entry.img.y, entry.targetY, interpolationAlpha);
      //console.log("Power-up sprite position:", entry.img.x, entry.img.y);
    });
    // Update GM gap guide lines (center +/- gap/2)
    this.updateGmGapGuides();
    // Update GM X-clamp tint overlay (right third)
    this.updateGmXClampTint();
    // Update GM charge UI
    this.updateGmChargeUi();
    // Update GM cursor position
    this.updateGmCursor();

    // Periodic sync for ready state changes and running state
    if (this.room && this.room.state && this.room.state.players) {
      let needsUIUpdate = false;

      // Check if running state changed
      const currentRunning = this.room.state.running as boolean;
      if (currentRunning !== this.lastKnownRunning) {
        const prevRunning = this.lastKnownRunning;
        console.log("Running state changed from", prevRunning, "to", currentRunning);
        this.lastKnownRunning = currentRunning;
        needsUIUpdate = true;
        if (currentRunning && !prevRunning) {
          this.playRoundStartStatusAnimation();
        }
        this.updateStatusMessage();
        // Hide skin selection immediately on game start
        if (currentRunning) {
          this.setSkinSelectionVisible(false);
          // Hard-destroy the panel to prevent any stray visibility or input
          try { this.skinSelectionContainer?.destroy(true); } catch { /* noop */ }
          this.skinSelectionContainer = undefined;
          this.skinSlotElements.clear();
        }

        // When game starts, ensure lobby skin selection is hidden immediately
        if (currentRunning) {
          this.setSkinSelectionVisible(false);
        }

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

      // Update placed obstacles positions from state (ArraySchema supports forEach)
      const placed = (this.room.state as any).placedObstacles as any;
      if (currentRunning && placed && typeof placed.forEach === "function") {
        placed.forEach((obs: PlacedObstacleState) => this.updatePlacedObstacle(obs));
      }

      // Update power-ups positions from state each frame (mirrors pipe/obstacle pattern)
      const powerUps = (this.room.state as any).powerUps as any;
      if (currentRunning && powerUps && typeof powerUps.forEach === "function") {
        powerUps.forEach((pu: PowerUpState) => this.updatePowerUp(pu));
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
        console.log("needsUIUpdate is true");
        this.updateReadyUI();
      }

    }
  }

  /**
   * Plays a short intro animation for the statusText at the start of a round,
   * then fades it out and keeps it hidden while the round is running.
   */
  private playRoundStartStatusAnimation() {
    if (!this.statusText) return;

    // Kill any previous animation to avoid overlap
    try { this.statusIntroTween?.stop(); } catch { /* noop */ }
    this.statusIntroTween = undefined;
    if (this.statusIntroHold) {
      try { this.statusIntroHold.remove(false); } catch { /* noop */ }
      this.statusIntroHold = undefined;
    }

    // Ensure visible and at a base state before animating
    this.statusText.setVisible(true);
    this.statusText.setAlpha(1);
    this.statusText.setScale(1);
    this.isStatusIntroActive = true;

    // Use whatever text is currently there (e.g., "Starting the round...")
    // and give it a quick pop + fade out using chained tweens.
    this.statusIntroTween = this.tweens.add({
      targets: this.statusText,
      scale: 1.15,
      duration: 220,
      ease: "Back.Out",
      onComplete: () => {
        this.statusIntroTween = this.tweens.add({
          targets: this.statusText,
          scale: 1.0,
          duration: 140,
          ease: "Sine.Out",
          onComplete: () => {
            // Hold for 600ms before fading out
            this.statusIntroHold = this.time.delayedCall(1200, () => {
              this.statusIntroTween = this.tweens.add({
                targets: this.statusText,
                alpha: 0,
                duration: 380,
                ease: "Quad.In",
                onComplete: () => {
                  try { this.statusText.setVisible(false); } catch { /* noop */ }
                  this.isStatusIntroActive = false;
                },
              });
            });
          },
        });
      },
    });
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
    this.sound.play("swoosh", { volume: 0.1 });

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

    // Create GM toolbar (hidden until we know local is GM)
    this.createGmToolbar();
    this.updateGmUiVisibility();
    this.ensureGmGapGuides();
    this.updateGmGapGuides();
    this.ensureGmXClampTint();
    this.updateGmXClampTint();

    // Create GM cursor (visible to all players when GM is present)
    this.createGmCursor();

    // Create Pig King health bar (top-right)
    this.createPigHealthUI();
  }

  private updateSkinOptionsFromState() {
    if (!this.room || !this.room.state) {
      return;
    }
    // Never show or rebuild selection UI for non-playing roles; keep options cached only
    if (this.localPlayerIsGM === true || this.localPlayerRole === "spectator") {
      const stateOptionsGM = (this.room.state as any).skinOptions as Array<string> | undefined;
      if (stateOptionsGM) {
        this.skinOptions = Array.from(stateOptionsGM);
      }
      try { this.skinSelectionContainer?.destroy(true); } catch { /* noop */ }
      this.skinSelectionContainer = undefined;
      this.skinSlotElements.clear();
      this.setSkinSelectionVisible(false);
      return;
    }
    // Do not rebuild selection UI while a round is running; we will rebuild as we re-enter lobby
    if ((this.room.state as any)?.running) {
      // Keep options list up to date silently
      const stateOptions = (this.room.state as any).skinOptions as Array<string> | undefined;
      if (stateOptions) {
        const nextOptions = Array.from(stateOptions);
        this.skinOptions = nextOptions;
      }
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
    // Do not build the selection UI for non-playing roles
    if (this.localPlayerIsGM === true || this.localPlayerRole === "spectator") {
      this.setSkinSelectionVisible(false);
      return;
    }
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
    // Keep logic consistent with lobby UI: never show during a running round or for GM
    const canShow = !this.room?.state?.running && this.getPlayerCount() > 0 && this.localPlayerRole === "bird";
    this.setSkinSelectionVisible(canShow);
  }

  private setSkinSelectionVisible(visible: boolean) {
    if (!this.scene) {
      console.warn("setSkinSelectionVisible() Scene is not initialized or has been destroyed.");
      return;
    }
    if (!this.skinSelectionContainer) {
      return;
    }
    // Force-hide for GM, spectators, or while running
    if (this.localPlayerIsGM === true || this.localPlayerRole === "spectator" || (this.room?.state as any)?.running) {
      visible = false;
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
    overlay.on("pointerdown", (pointer: Phaser.Input.Pointer) => {      // do nothing — this just blocks input below
    });

    // Inner panel to avoid overlap and keep consistent spacing
    this.gameOverPanel = this.add.container(0, 0);
    this.gameOverScreen.add(this.gameOverPanel);
    // start slightly scaled; will animate to 1.0 when showing
    this.gameOverPanel.setScale(1);

    // Game over text
    this.gameOverText = this.add.text(0, -100, "GAME OVER", {
      fontFamily: "Arial Black",
      fontSize: 48,
      color: "#ff0000",
      stroke: "#000000",
      strokeThickness: 8,
      align: "center",
    });
    this.gameOverText.setOrigin(0.5);
    this.gameOverPanel.add(this.gameOverText);

    // Score and summary displays
    this.gameOverScoreText = this.add.text(0, -40, "Score: 0", {
      fontFamily: "Arial",
      fontSize: 30,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 6,
      align: "center",
    }).setOrigin(0.5);
    this.gameOverPanel.add(this.gameOverScoreText);

    this.gameOverHighText = this.add.text(0, -4, "High: 0", {
      fontFamily: "Arial",
      fontSize: 24,
      color: "#ffffcc",
      stroke: "#000000",
      strokeThickness: 5,
      align: "center",
    }).setOrigin(0.5);
    this.gameOverPanel.add(this.gameOverHighText);

    this.gameOverTeamsText = this.add.text(0, 28, "Bird wins: 0 | Pig wins: 0", {
      fontFamily: "Arial",
      fontSize: 22,
      color: "#cfe9ff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    }).setOrigin(0.5);
    this.gameOverPanel.add(this.gameOverTeamsText);

    // Restart button
    const buttonWidth = 240;
    const buttonHeight = 60;
    const playAgainY = 100;

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
    this.gameOverPanel.add(this.restartButton);

    this.restartButtonLabel = this.add.text(0, playAgainY, "Play Again", {
      fontFamily: "Arial Black",
      fontSize: 24,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    });
    this.restartButtonLabel.setOrigin(0.5);
    this.gameOverPanel.add(this.restartButtonLabel);

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
    this.gameOverPanel.add(this.returnButton);

    this.returnButtonLabel = this.add.text(0, returnY, "Return to Menu", {
      fontFamily: "Arial Black",
      fontSize: 24,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    });
    this.returnButtonLabel.setOrigin(0.5);
    this.gameOverPanel.add(this.returnButtonLabel);

    // Draw panel background behind content to avoid overlap and improve readability
    this.updateGameOverPanelBackground();
  }

  private updateGameOverPanelBackground() {
    if (!this.gameOverPanel) return;

    const exclude = new Set<any>();
    if (this.gameOverPanelBg) exclude.add(this.gameOverPanelBg);
    if (this.gameOverPanelShadow) exclude.add(this.gameOverPanelShadow);

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    // Compute bounds from children in panel-local coordinates
    this.gameOverPanel.iterate((child: any) => {
      if (!child || exclude.has(child)) return;
      // Prefer displayWidth/displayHeight for scale-aware size
      const w = Number.isFinite(child.displayWidth) ? child.displayWidth : (Number(child.width) || 0);
      const h = Number.isFinite(child.displayHeight) ? child.displayHeight : (Number(child.height) || 0);
      const ox = (typeof child.originX === "number") ? child.originX : 0.5;
      const oy = (typeof child.originY === "number") ? child.originY : 0.5;
      const left = Number(child.x) - w * ox;
      const right = Number(child.x) + w * (1 - ox);
      const top = Number(child.y) - h * oy;
      const bottom = Number(child.y) + h * (1 - oy);
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, right);
      maxY = Math.max(maxY, bottom);
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      // Fallback default panel size if content not ready yet
      minX = -260; maxX = 260; minY = -130; maxY = 190;
    }

    const contentW = Math.max(0, maxX - minX);
    const contentH = Math.max(0, maxY - minY);
    const padX = 30;
    const padY = 24;
    const width = Math.max(360, contentW + padX * 2);
    const height = Math.max(220, contentH + padY * 2);
    const cx = (minX + maxX) / 2; // panel-local center
    const cy = (minY + maxY) / 2;

    // Create graphics if missing and add behind all children
    if (!this.gameOverPanelShadow) {
      this.gameOverPanelShadow = this.add.graphics();
      this.gameOverPanel.addAt(this.gameOverPanelShadow, 0);
    }
    if (!this.gameOverPanelBg) {
      this.gameOverPanelBg = this.add.graphics();
      this.gameOverPanel.addAt(this.gameOverPanelBg, 1);
    }

    // Position backgrounds at the content center
    this.gameOverPanelShadow.setPosition(cx + 6, cy + 8);
    this.gameOverPanelBg.setPosition(cx, cy);

    const radius = 16;
    // Redraw shadow
    this.gameOverPanelShadow.clear();
    this.gameOverPanelShadow.fillStyle(0x000000, 0.35);
    // @ts-ignore Phaser API
    (this.gameOverPanelShadow as any).fillRoundedRect(-width / 2, -height / 2, width, height, radius);

    // Redraw panel
    this.gameOverPanelBg.clear();
    this.gameOverPanelBg.fillStyle(0x000000, 0.6);
    this.gameOverPanelBg.lineStyle(2, 0xffffff, 0.35);
    // @ts-ignore Phaser API
    (this.gameOverPanelBg as any).fillRoundedRect(-width / 2, -height / 2, width, height, radius);
    // @ts-ignore Phaser API
    (this.gameOverPanelBg as any).strokeRoundedRect(-width / 2, -height / 2, width, height, radius);
  }

  private setupInput() {
    console.log("setupInput() called");
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Right-click cancels GM placement selection
      if (this.localPlayerIsGM && this.gmToolSelected && (pointer.rightButtonDown?.() || pointer.button === 2)) {
        this.cancelGmSelection();
        return;
      }
      if (this.localPlayerIsGM && this.gmToolSelected) {
        // block placement clicks over GM UI/volume UI
        if (!this.isPointerOverVolumeUI(pointer) && !this.isPointerOverGmUi(pointer)) {
          this.placeGmObstacleAtPointer(pointer);
          return;
        }
      }
      this.handleFlap(pointer);
    });
    this.input.keyboard?.on("keydown-SPACE", () => this.handleFlap());
    this.input.keyboard?.on("keydown-UP", () => this.handleFlap());
    this.input.keyboard?.on("keydown-ESC", () => this.cancelGmSelection());
    this.input.keyboard?.on("keydown-ESCAPE", () => this.cancelGmSelection());

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      this.updateGmPreviewPosition(pointer);
      // Send cursor position to server if local player is GM
      if (this.localPlayerIsGM && this.room) {
        this.room.send("gmCursorMove", { x: pointer.worldX, y: pointer.worldY });
      }
    });
  }

  private handleFlap(pointer?: Phaser.Input.Pointer) {
    if (this.isDraggingVolume) {
      return;
    }

    if (pointer && this.isPointerOverVolumeUI(pointer)) {
      return;
    }

    // Non-playing roles do not flap
    if (this.localPlayerRole !== "bird") {
      return;
    }

    if (!this.room || !this.room.state.running) {
      console.log("handleFlap() called but room or running state is false");
      return;
    }

    //console.log("handleFlap() called");
    this.room.send("flap");
    this.sound.play("wing", { volume: 0.1 });
  }

  private showGameOverScreen(won: boolean, roundScoreHint?: number) {
    if (!this.gameOverScreen || !this.gameOverText) {
      return;
    }

    const state: any = this.room?.state as any;
    const local = state?.players?.get?.(this.localPlayerId) as PlayerState | undefined;
    const localRole = (local?.role as any) || this.localPlayerRole;
    const isGM = this.localPlayerIsGM === true || localRole === "gm";
    const isSpectator = localRole === "spectator";

    // Update header text
    if (isSpectator) {
      this.gameOverText.setText("ROUND ENDED");
      this.gameOverText.setColor("#ffffff");
    } else {
      this.gameOverText.setText(won ? "YOU WIN!" : "GAME OVER");
      this.gameOverText.setColor(won ? "#00ff00" : "#ff0000");
    }

    // Round score: birds -> pipes passed; GM -> time to end in seconds
    let roundScoreText = "Score: 0";
    if (isGM) {
      const tSec = Number(state?.difficulty ?? 0);
      const t = Math.max(0, Math.round(tSec * 10) / 10);
      roundScoreText = `Time: ${t}s`;
    } else if (!isSpectator) {
      const s = typeof roundScoreHint === "number" ? roundScoreHint : Number(local?.score ?? 0);
      roundScoreText = `Score: ${Math.max(0, Math.floor(s))}`;
    } else {
      roundScoreText = "Spectating";
    }
    this.gameOverScoreText?.setText(roundScoreText);

    // Personal high
    let highText = isGM
      ? `Best GM time: -`
      : isSpectator
        ? `You were spectating`
        : `High: ${Math.max(0, Math.floor(Number((local as any)?.birdHighScore ?? 0)))}`;
    if (isGM) {
      const best = Number((local as any)?.pigBestTime ?? 0);
      highText = best > 0 ? `Best GM time: ${Math.round(best * 10) / 10}s` : `Best GM time: -`;
    }
    this.gameOverHighText?.setText(highText);

    // Team scores
    const birdWins = Math.max(0, Math.floor(Number(state?.birdWins ?? state?.birdsWins ?? 0)));
    const pigWins = Math.max(0, Math.floor(Number(state?.pigWins ?? 0)));
    this.gameOverTeamsText?.setText(`Bird wins: ${birdWins} | Pig wins: ${pigWins}`);

    // Show the overlay
    this.gameOverScreen.setVisible(true);
    // Update background sizing after latest text updates
    this.updateGameOverPanelBackground();

    // Animate in: fade overlay and scale panel
    try { this.gameOverFadeTween?.stop(); } catch { /* noop */ }
    try { this.gameOverShowTween?.stop(); } catch { /* noop */ }
    if (this.gameOverScreen) {
      this.gameOverScreen.setAlpha(0);
      this.gameOverFadeTween = this.tweens.add({
        targets: this.gameOverScreen,
        alpha: { from: 0, to: 1 },
        duration: 180,
        ease: 'Quad.easeOut',
      });
    }
    if (this.gameOverPanel) {
      this.gameOverPanel.setScale(0.85);
      this.gameOverShowTween = this.tweens.add({
        targets: this.gameOverPanel,
        scaleX: 1,
        scaleY: 1,
        duration: 260,
        ease: 'Back.out',
      });
    }

    // Button visibility/content adjustments
    if (isSpectator) {
      try { this.restartButton?.setVisible(false); } catch { /* noop */ }
      try { this.restartButtonLabel?.setVisible(false); } catch { /* noop */ }
      try { this.returnButtonLabel?.setText("Return to Menu to Play"); } catch { /* noop */ }
    } else {
      try { this.restartButton?.setVisible(true); } catch { /* noop */ }
      try { this.restartButtonLabel?.setVisible(true); } catch { /* noop */ }
      try { this.returnButtonLabel?.setText("Return to Menu"); } catch { /* noop */ }
    }

    console.log(`Game over screen shown - Won: ${won}, Role: ${isSpectator ? "Spectator" : (isGM ? "GM" : "Bird")}`);
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

  // GM UI
  private createGmToolbar() {
    const width = Number(this.game.config.width);
    const margin = 20;
    const panelWidth = 160;
    const panelHeight = 200;
    const x = width - panelWidth / 2 - margin;
    const y = 360;

    const container = this.add.container(x, y);
    container.setDepth(50);

    const bg = this.add
      .rectangle(0, 0, panelWidth, panelHeight, 0x000000, 0.55)
      .setStrokeStyle(2, 0xffffff, 0.35)
      .setOrigin(0.5);
    container.add(bg);

    const title = this.add.text(0, -panelHeight / 2 + 18, "GM Tools", {
      fontFamily: "Arial Black",
      fontSize: 18,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    }).setOrigin(0.5);
    container.add(title);

    const makeBtn = (by: number, label: string, color: number, kind: "top" | "bottom") => {
      const btn = this.add.rectangle(0, by, panelWidth - 20, 44, color, 0.9).setOrigin(0.5).setInteractive({ useHandCursor: true });
      const txt = this.add.text(0, by, label, {
        fontFamily: "Arial Black",
        fontSize: 18,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
        align: "center",
      }).setOrigin(0.5);
      btn.on("pointerdown", () => this.selectGmTool(kind));
      btn.on("pointerover", () => btn.setFillStyle(color, 0.95));
      btn.on("pointerout", () => btn.setFillStyle(color, 0.9));
      container.add(btn);
      container.add(txt);
      this.gmToolButtons.set(kind, { bg: btn, txt });
    };

    makeBtn(-20, "Top Pipe", 0x34495e, "top");
    makeBtn(30, "Bottom Pipe", 0x2c3e50, "bottom");

    // Charges / cooldown label
    this.gmChargeText = this.add.text(0, 80, "Charges: 2/2 • Ready", {
      fontFamily: "Arial Black",
      fontSize: 16,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    }).setOrigin(0.5);
    container.add(this.gmChargeText);

    this.gmToolbar = container;
    container.setVisible(false);
  }

  private createGmCursor() {
    // Create a hand cursor sprite that will be visible to all players
    // showing where the GM's cursor is positioned
    const container = this.add.container(0, 0);
    container.setDepth(100); // High depth to be above most elements

    // Create hand sprite - starts with pointing hand
    const handSprite = this.add.image(0, 0, "hand_pointing");
    handSprite.setOrigin(0.2, 0.1); // Position the origin at the finger tip
    handSprite.setScale(1.2); // Scale down if needed
    handSprite.setTint(0xce4c8d);

    // Store reference to the sprite for later access
    this.gmCursorSprite = handSprite;

    container.add([handSprite]);

    // Initially hidden until we get GM cursor data
    container.setVisible(false);
    this.gmCursor = container;
  }

  private updateGmCursor() {
    if (!this.gmCursor || !this.room?.state) {
      return;
    }

    const state = this.room.state as any;

    // Check if there's a GM in the game
    const hasGM = state.gameMasterId && state.gameMasterId !== "";

    // Hide cursor if no GM or if local player is the GM (they see their own cursor)
    if (!hasGM) {
      this.gmCursor.setVisible(false);
      return;
    }

    if (this.localPlayerIsGM) {
      this.input.setDefaultCursor("none");
    }

    // Show and update GM cursor position
    const gmX = state.gmCursorX ?? 0;
    const gmY = state.gmCursorY ?? 0;

    // Smoothly interpolate cursor position for smooth movement
    const currentX = this.gmCursor.x;
    const currentY = this.gmCursor.y;
    const lerpFactor = 0.3; // Smooth follow

    this.gmCursor.x = Phaser.Math.Linear(currentX, gmX, lerpFactor);
    this.gmCursor.y = Phaser.Math.Linear(currentY, gmY, lerpFactor);
    this.gmCursor.setVisible(true);
  }

  private triggerGmCursorFeedback() {
    // Change cursor to closed hand for 250ms when placing obstacle
    if (!this.gmCursorSprite) return;

    // Clear any existing timer
    if (this.gmCursorCloseTimer) {
      this.gmCursorCloseTimer.destroy();
      this.gmCursorCloseTimer = undefined;
    }

    // Change to closed hand
    this.gmCursorSprite.setTexture("hand_closed");

    // Set timer to revert back to pointing hand after 250ms
    this.gmCursorCloseTimer = this.time.delayedCall(250, () => {
      if (this.gmCursorSprite) {
        this.gmCursorSprite.setTexture("hand_pointing");
      }
      this.gmCursorCloseTimer = undefined;
    });
  }

  private updateGmUiVisibility() {
    if (!this.gmToolbar) return;
    this.gmToolbar.setVisible(this.localPlayerIsGM === true);
    if (!this.localPlayerIsGM) {
      this.selectGmTool(null);
    }
    // Toggle gap guide visibility with GM mode
    this.gmGapGfxTop?.setVisible(this.localPlayerIsGM === true);
    this.gmGapGfxBottom?.setVisible(this.localPlayerIsGM === true);
    this.gmXClampTint?.setVisible(this.localPlayerIsGM === true);
  }

  private selectGmTool(kind: ("top" | "bottom") | null) {
    this.gmToolSelected = kind;
    if (!kind) {
      this.gmPreviewSprite?.destroy();
      this.gmPreviewSprite = undefined;
      this.updateGmToolSelectionHighlight();
      return;
    }
    const key = kind === "top" ? "pipe" : "pipe-red";
    if (!this.gmPreviewSprite) {
      this.gmPreviewSprite = this.add.image(0, 0, key).setDepth(49).setAlpha(0.5);
    } else {
      this.gmPreviewSprite.setTexture(key);
      this.gmPreviewSprite.setVisible(true);
    }
    this.gmPreviewSprite.setFlipY(kind === "top");
    this.gmPreviewSprite.setOrigin(0.5, kind === "top" ? 1 : 0);
    this.updateGmToolSelectionHighlight();
  }

  private updateGmToolSelectionHighlight() {
    // Highlight selected tool button by stroke + brighter fill
    const topBtn = this.gmToolButtons.get("top");
    const bottomBtn = this.gmToolButtons.get("bottom");
    const apply = (entry: { bg: Phaser.GameObjects.Rectangle; txt: Phaser.GameObjects.Text } | undefined, selected: boolean, baseColor: number) => {
      if (!entry) return;
      entry.bg.setStrokeStyle(selected ? 3 : 1, 0xffd369, selected ? 0.9 : 0.4);
      entry.bg.setFillStyle(baseColor, selected ? 1.0 : 0.9);
      entry.txt.setColor(selected ? "#ffe7a6" : "#ffffff");
    };
    apply(topBtn, this.gmToolSelected === "top", 0x34495e);
    apply(bottomBtn, this.gmToolSelected === "bottom", 0x2c3e50);
  }

  private cancelGmSelection() {
    if (!this.localPlayerIsGM) return;
    if (!this.gmToolSelected && !this.gmPreviewSprite) return;
    this.selectGmTool(null);
  }

  private isPointerOverGmUi(pointer: Phaser.Input.Pointer) {
    if (!this.gmToolbar || !this.gmToolbar.visible) return false;
    // container bounds approximation using its first child (bg rect)
    const bg = this.gmToolbar.list.find((o) => (o as any).getBounds) as any;
    if (!bg) return false;
    const bounds = bg.getBounds();
    const p = this.getPointerPosition(pointer);
    return Phaser.Geom.Rectangle.Contains(bounds, p.x, p.y);
  }

  private updateGmPreviewPosition(pointer: Phaser.Input.Pointer) {
    if (!this.localPlayerIsGM || !this.gmToolSelected || !this.gmPreviewSprite) return;
    const p = this.getPointerPosition(pointer);
    const yInput = this.gmToolSelected === "top" ? p.y - this.pipeHeight : p.y;
    const { x, y } = this.getClampedGmPlacement(p.x, yInput, this.gmToolSelected);
    if (this.gmToolSelected === "top") {
      // Ensure bottom of the flipped top pipe follows the cursor
      this.gmPreviewSprite.setFlipY(true);
      this.gmPreviewSprite.setOrigin(0.5, 1);
      this.gmPreviewSprite.setPosition(x, y + this.pipeHeight);
    } else {
      // Bottom pipe uses top-of-sprite anchor
      this.gmPreviewSprite.setFlipY(false);
      this.gmPreviewSprite.setOrigin(0.5, 0);
      this.gmPreviewSprite.setPosition(x, y);
    }
  }

  private placeGmObstacleAtPointer(pointer: Phaser.Input.Pointer) {
    if (!this.room || !this.gmToolSelected) return;
    if (!(this.room.state as any)?.running) {
      return; // only place during active rounds so server will accept and move them
    }
    // Client-side gate to avoid spamming when out of charges
    if (this.localPlayerIsGM && this.gmCharges <= 0) {
      // Optionally flash the charge text
      console.log("Out of GM charges, cannot place obstacle");
      try { this.sound.play("swoosh", { volume: 0.05 }); } catch { }
      return;
    }
    const p = this.getPointerPosition(pointer);
    const yInput = this.gmToolSelected === "top" ? p.y - this.pipeHeight : p.y;
    const { x, y } = this.getClampedGmPlacement(p.x, yInput, this.gmToolSelected);
    this.room.send("gmPlaceObstacle", { kind: this.gmToolSelected, x, y });

    // Trigger hand closing animation for GM cursor
    this.triggerGmCursorFeedback();
  }

  private getClampedGmPlacement(rawX: number, rawY: number, kind: "top" | "bottom") {
    const width = Number(this.game.config.width);
    const height = Number(this.game.config.height);
    const midY = height / 2;
    const gap = this.getCurrentPipeGapClient();
    const halfGap = gap / 2;

    // X only in right third of screen
    const minX = (2 / 3) * width;
    const maxX = width;
    const x = Phaser.Math.Clamp(rawX, minX, maxX);

    if (kind === "bottom") {
      // Top of bottom pipe in [midY + halfGap, screen bottom]
      const yMin = midY + halfGap;
      const yMax = height; // allow to go off-screen visually
      const y = Phaser.Math.Clamp(rawY, yMin, yMax);
      return { x, y };
    } else {
      // Clamp bottom of TOP pipe to [0, midY - halfGap], derive topY = bottom - pipeHeight
      const desiredBottom = rawY + this.pipeHeight;
      const bottomMin = 0;
      const bottomMax = Math.max(bottomMin, midY - halfGap);
      const clampedBottom = Phaser.Math.Clamp(desiredBottom, bottomMin, bottomMax);
      const y = clampedBottom - this.pipeHeight;
      return { x, y };
    }
  }

  private getCurrentPipeGapClient() {
    const difficulty = Number((this.room?.state as any)?.difficulty ?? 0);
    const gap = Math.max(this.previewMinPipeGap, this.previewMaxPipeGap - (difficulty * this.previewGapShrinkPerSec));
    //return gap;
    return 0; // disable gap guides for now
  }

  // Create (if missing) the dashed horizontal guide lines at center +/- gap/2 (only within X preview region)
  private ensureGmGapGuides() {
    if (!this.gmGapGfxTop) {
      this.gmGapGfxTop = this.add.graphics().setDepth(48).setScrollFactor(0);
    }
    if (!this.gmGapGfxBottom) {
      this.gmGapGfxBottom = this.add.graphics().setDepth(48).setScrollFactor(0);
    }
    const visible = this.localPlayerIsGM === true;
    this.gmGapGfxTop.setVisible(visible);
    this.gmGapGfxBottom.setVisible(visible);
  }

  // Position and redraw dashed guide lines based on current difficulty (gap), only inside right-third X region
  private updateGmGapGuides() {
    if (!this.gmGapGfxTop || !this.gmGapGfxBottom) return;
    const visible = this.localPlayerIsGM === true;
    this.gmGapGfxTop.setVisible(visible);
    this.gmGapGfxBottom.setVisible(visible);
    if (!visible) return;

    const width = Number(this.game.config.width);
    const height = Number(this.game.config.height);
    const startX = (2 / 3) * width;
    const endX = width;
    const midY = height / 2;
    const halfGap = this.getCurrentPipeGapClient() / 2;
    const yTop = Phaser.Math.Clamp(midY - halfGap, 0, height);
    const yBottom = Phaser.Math.Clamp(midY + halfGap, 0, height);

    // Clear and redraw dashed segments
    this.gmGapGfxTop.clear();
    this.gmGapGfxBottom.clear();
    this.drawDashedHLine(this.gmGapGfxTop, startX, endX, yTop, 0xffffff, 0.6, 2, 12, 8);
    this.drawDashedHLine(this.gmGapGfxBottom, startX, endX, yBottom, 0xffffff, 0.6, 2, 12, 8);
  }

  // Helper to draw a dashed horizontal line using Graphics
  private drawDashedHLine(
    gfx: Phaser.GameObjects.Graphics,
    x1: number,
    x2: number,
    y: number,
    color = 0xffffff,
    alpha = 0.6,
    thickness = 2,
    dash = 12,
    gap = 8,
  ) {
    const start = Math.min(x1, x2);
    const end = Math.max(x1, x2);
    gfx.lineStyle(thickness, color, alpha);
    let x = start;
    while (x < end) {
      const segEnd = Math.min(x + dash, end);
      gfx.beginPath();
      gfx.moveTo(x, y);
      gfx.lineTo(segEnd, y);
      gfx.strokePath();
      x = segEnd + gap;
    }
  }

  // Create/update the transparent blue tint over the right third (X clamp area)
  private ensureGmXClampTint() {
    if (this.gmXClampTint) return;
    const width = Number(this.game.config.width);
    const height = Number(this.game.config.height);
    const rectWidth = width / 3;
    const x = (2 / 3) * width + rectWidth / 2; // center of right third
    const y = height / 2;
    this.gmXClampTint = this.add
      .rectangle(x, y, rectWidth, height, 0x3498db, 0.15)
      .setOrigin(0.5)
      .setDepth(47)
      .setScrollFactor(0);
    this.gmXClampTint.setVisible(this.localPlayerIsGM === true);
  }

  private updateGmXClampTint() {
    if (!this.gmXClampTint) return;
    const width = Number(this.game.config.width);
    const height = Number(this.game.config.height);
    const rectWidth = width / 3;
    const x = (2 / 3) * width + rectWidth / 2;
    const y = height / 2;
    this.gmXClampTint.setPosition(x, y);
    this.gmXClampTint.setSize(rectWidth, height);
    this.gmXClampTint.setVisible(this.localPlayerIsGM === true);
  }

  private updateGmChargeUi() {
    if (!this.gmChargeText) return;
    const visible = this.localPlayerIsGM === true;
    this.gmChargeText.setVisible(visible);
    if (!visible) return;

    const now = Date.now();
    let remaining = Math.max(0, this.gmNextReadyAt - now);
    if (this.gmCharges >= this.gmMaxCharges) remaining = 0;
    const seconds = Math.ceil(remaining / 1000);
    const label = remaining > 0 ? `Next in ${seconds}s` : `Ready`;
    this.gmChargeText.setText(`Charges: ${this.gmCharges}/${this.gmMaxCharges} • ${label}`);
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
      // Ensure skin selection is hidden if we cannot fully update lobby UI
      this.setSkinSelectionVisible(false);
      return;
    }

    if (!this.room) {
      console.log("No room, hiding ready UI");
      this.readyButtonBackground.setVisible(false);
      this.readyButtonBackground.disableInteractive();
      this.readyButtonLabel.setVisible(false);
      this.readyCountText.setVisible(false);
      // Hide skin selection when room is unavailable
      this.setSkinSelectionVisible(false);
      return;
    }

    const running = this.room.state.running as boolean;
    const playerCount = this.getPlayerCount();
    const readyCount = this.getReadyCount();
    // Do not show Ready UI for non-playing roles (GM or spectator)
    const showLobbyUi = !running && playerCount > 0 && this.localPlayerRole === "bird";

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
    // If entering lobby and the panel doesn't exist yet, (re)build it from cached options
    if (showLobbyUi && !this.skinSelectionContainer && this.skinOptions.length > 0) {
      this.rebuildSkinSelection();
      this.setSkinSelectionVisible(true);
    }

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

      // Handle disconnection and attempt to reconnect
      this.room.onLeave((code) => {
        console.log(`Disconnected from server with code: ${code}`);
        this.handleDisconnect(code);
      });

      this.room.onError((code, message) => {
        console.error(`Room error (${code}): ${message}`);
        this.scoreText.setText(`Error: ${message}`);
      });
    } catch (e) {
      console.log(`Could not connect with the server: ${e}`);
      this.scoreText.setText("Connection failed");
      // Attempt to reconnect after a delay
      this.time.delayedCall(3000, () => {
        console.log("Attempting to reconnect...");
        this.scene.restart();
      });
    }
  }

  private handleDisconnect(code: number) {
    // Colyseus disconnect codes:
    // 1000 = normal closure
    // 1001-1015 = various WebSocket close codes
    // 4000+ = custom application codes

    console.log("Connection lost. Attempting to reconnect...");
    this.scoreText.setText("Connection lost. Reconnecting...");

    // Clean up current room reference
    this.room = undefined;

    // Wait a bit before restarting to avoid hammering the server
    this.time.delayedCall(2000, () => {
      console.log("Restarting scene to reconnect...");
      this.scene.restart();
    });
  }

  private async returnToMenu() {
    try {
      if (this.room) {
        await this.room.leave();
      }
    } catch (e) {
      console.warn("Error leaving room while returning to menu:", e);
    }

    // Hide the game over screen immediately; full cleanup runs on shutdown
    this.gameOverScreen?.setVisible(false);

    // Transition back to main menu for role re-selection
    this.scene.start("MainMenu");
  }

  // Scene lifecycle hooks
  private onShutdown() {
    this.cleanupScene();
  }

  private onDestroy() {
    this.cleanupScene();
    try { this.events.removeAllListeners(); } catch { /* noop */ }
  }

  // Centralized cleanup for UI, listeners, timers, tweens, and network
  private cleanupScene() {
    // Stop input listeners
    try { this.input.removeAllListeners(); } catch { /* noop */ }
    try { this.input.keyboard?.removeAllListeners(); } catch { /* noop */ }

    // Kill tweens and timers in this scene
    try { this.tweens.killAll(); } catch { /* noop */ }
    try { this.time.removeAllEvents(); } catch { /* noop */ }
    if (this.statusIntroTween) {
      try { this.statusIntroTween.stop(); } catch { /* noop */ }
      this.statusIntroTween = undefined;
    }
    if (this.statusIntroHold) {
      try { this.statusIntroHold.remove(false); } catch { /* noop */ }
      this.statusIntroHold = undefined;
    }

    // Stop any playing sounds from this scene
    try { this.sound.stopAll(); } catch { /* noop */ }

    // Clear win banner/timers
    if (this.winBannerTimeout) {
      try { this.winBannerTimeout.remove(false); } catch { /* noop */ }
      this.winBannerTimeout = undefined;
    }
    if (this.pigFlashTween) {
      try { this.pigFlashTween.stop(); } catch { /* noop */ }
      this.pigFlashTween = undefined;
    }

    // Destroy UI elements and containers
    try { this.stagePopup?.destroy(true); } catch { /* noop */ } this.stagePopup = undefined;
    try { this.roomStatusText?.destroy(); } catch { /* noop */ } this.roomStatusText = undefined;
    try { this.scoreText?.destroy(); } catch { /* noop */ } this.scoreText = undefined as any;
    try { this.scoreBackdrop?.destroy(); } catch { /* noop */ } this.scoreBackdrop = undefined as any;
    try { this.statusText?.destroy(); } catch { /* noop */ } this.statusText = undefined as any;
    try { this.readyCountText?.destroy(); } catch { /* noop */ } this.readyCountText = undefined as any;
    try { this.readyButtonLabel?.destroy(); } catch { /* noop */ } this.readyButtonLabel = undefined;
    try { this.readyButtonBackground?.destroy(); } catch { /* noop */ } this.readyButtonBackground = undefined;
    try { this.gameOverText?.destroy(); } catch { /* noop */ } this.gameOverText = undefined;
    try { this.restartButtonLabel?.destroy(); } catch { /* noop */ } this.restartButtonLabel = undefined;
    try { this.restartButton?.destroy(); } catch { /* noop */ } this.restartButton = undefined;
    try { this.returnButtonLabel?.destroy(); } catch { /* noop */ } this.returnButtonLabel = undefined;
    try { this.returnButton?.destroy(); } catch { /* noop */ } this.returnButton = undefined;
    try { this.gameOverScreen?.destroy(true); } catch { /* noop */ } this.gameOverScreen = undefined;

    // Volume UI
    try { this.volumeSliderKnob?.destroy(); } catch { /* noop */ } this.volumeSliderKnob = undefined;
    try { this.volumeSliderHitArea?.destroy(); } catch { /* noop */ } this.volumeSliderHitArea = undefined as any;
    try { this.volumeSlider?.destroy(); } catch { /* noop */ } this.volumeSlider = undefined;
    try { this.volumeText?.destroy(); } catch { /* noop */ } this.volumeText = undefined;
    this.isDraggingVolume = false;

    // GM UI and guides
    try { this.gmPreviewSprite?.destroy(); } catch { /* noop */ } this.gmPreviewSprite = undefined;
    try { this.gmChargeText?.destroy(); } catch { /* noop */ } this.gmChargeText = undefined;
    try { this.gmToolbar?.destroy(true); } catch { /* noop */ } this.gmToolbar = undefined;
    this.gmToolButtons.clear();
    try { this.gmGapGfxTop?.destroy(); } catch { /* noop */ } this.gmGapGfxTop = undefined;
    try { this.gmGapGfxBottom?.destroy(); } catch { /* noop */ } this.gmGapGfxBottom = undefined;
    try { this.gmXClampTint?.destroy(); } catch { /* noop */ } this.gmXClampTint = undefined;

    // Pig King UI
    try { this.pigAvatar?.destroy(); } catch { /* noop */ } this.pigAvatar = undefined;
    try { this.pigBarText?.destroy(); } catch { /* noop */ } this.pigBarText = undefined;
    try { this.pigBarFill?.destroy(); } catch { /* noop */ } this.pigBarFill = undefined;
    try { this.pigBarBg?.destroy(); } catch { /* noop */ } this.pigBarBg = undefined;
    try { this.pigBarContainer?.destroy(true); } catch { /* noop */ } this.pigBarContainer = undefined;

    // Skin selection UI
    try { this.skinSelectionContainer?.destroy(true); } catch { /* noop */ } this.skinSelectionContainer = undefined;
    this.skinSlotElements.clear();
    this.skinOptions = [];

    // Background and ground
    try { this.background?.destroy(); } catch { /* noop */ }
    try { this.ground?.destroy(); } catch { /* noop */ }

    // Destroy all sprites and clear maps
    try {
      this.playerSprites.forEach((s) => { try { s.destroy(); } catch { /* noop */ } });
      this.playerSprites.clear();
    } catch { /* noop */ }
    try {
      this.pipeSprites.forEach(({ top, bottom }) => { try { top.destroy(); } catch { } try { bottom.destroy(); } catch { } });
      this.pipeSprites.clear();
    } catch { /* noop */ }
    try {
      this.placedObstacleSprites.forEach(({ img }) => { try { img.destroy(); } catch { /* noop */ } });
      this.placedObstacleSprites.clear();
    } catch { /* noop */ }
    try {
      this.powerUpSprites.forEach(({ img }) => { try { img.destroy(); } catch { /* noop */ } });
      this.powerUpSprites.clear();
    } catch { /* noop */ }

    // Remove any remaining display items defensively
    try { this.children.removeAll(true); } catch { /* noop */ }

    // Unsubscribe room listeners and close connection
    if (this.room) {
      try { (this.room as any)?.removeAllListeners?.(); } catch { /* noop */ }
      try { void this.room.leave(true); } catch { /* noop */ }
      this.room = undefined;
    }

    // Reset local flags/state
    this.localPlayerId = "";
    this.localPlayerReady = false;
    this.lastKnownRunning = false;
    this.lastKnownStage = 0;
    this.joinRole = "bird";
    this.localPlayerIsGM = false;
    this.gmToolSelected = null;
    this.gmCharges = 2;
    this.gmMaxCharges = 2;
    this.gmNextReadyAt = 0;
    this.currentScrollSpeed = this.baseScrollSpeed;
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

    // Hydrate GM placed obstacles (if any)
    const placed = (this.room.state as any).placedObstacles as any;
    if (placed && typeof placed.forEach === "function") {
      placed.forEach((obs: PlacedObstacleState) => this.addPlacedObstacle(obs));
    }
    // Hydrate power-ups (if any)
    const powerUpsState = (this.room.state as any).powerUps as any;
    if (powerUpsState && typeof powerUpsState.forEach === "function") {
      const powerUpsArray = powerUpsState as PowerUpState[];
      powerUpsArray.forEach((pu: PowerUpState) => {
        this.addPowerUp(pu);
      });
    }

    // Subscribe for additions of pipes
    $(this.room.state.pipes).onAdd((pipe: PipeState) => {
      //console.log("Pipe added to room state:", pipe);
      if (!pipe) return;
      this.addPipe(pipe);
    });

    $(this.room.state.pipes).onRemove((pipe: PipeState) => {
      //console.log("Pipe removed from room state:", pipe);
      if (!pipe) return;
      this.removePipe(pipe.id);
    });

    // Subscribe for GM placed obstacles
    const po = (this.room.state as any).placedObstacles;
    if (po) {
      const po$ = $(po);
      po$.onAdd((obs: PlacedObstacleState) => {
        if (!obs) return;
        this.addPlacedObstacle(obs);
      });
      po$.onRemove((obs: PlacedObstacleState | undefined) => {
        if (!obs || typeof (obs as any).id !== "number") return;
        this.removePlacedObstacle((obs as any).id);
      });
      po$.onChange((obs: PlacedObstacleState | undefined, index?: number) => {
        if (!obs) return;
        this.updatePlacedObstacle(obs);
      });
    }
    // Subscribe for power-ups
    const pu = (this.room.state).powerUps;
    if (pu) {
      const pu$ = $(pu);
      pu$.onAdd((p: PowerUpState) => {
        if (!p) return;
        this.addPowerUp(p);
        console.log("Power-up added:", p);
      });
      pu$.onRemove((p: PowerUpState | undefined) => {
        if (!p || typeof (p as any).id !== "number") return;
        this.removePowerUp((p as any).id);
        console.log("Power-up removed:", p);
      });
      // Array-level onChange not needed for per-item movement; polling handles it.
      pu$.onChange((_p: PowerUpState | undefined) => {
        // no-op
      });
    }

    // Power-up pickup FX (broadcast from server)
    this.room.onMessage("powerUpPicked", (payload: { playerId: string; type: string; name: string; x: number; y: number }) => {
      const isLocal = payload?.playerId === this.localPlayerId;
      const px = payload?.x ?? 0;
      const py = payload?.y ?? 0;
      const ptype = (payload?.type ?? "").toLowerCase();

      this.showPowerUpPickup(px, py, payload?.name ?? "", isLocal);

      // Special case: hammer pickup triggers a thrown hammer animation towards the Pig King avatar
      if (ptype === "hammer") {
        this.throwHammerToPig(px, py);
      }

      try {
        this.sound.play(isLocal ? "point" : "swoosh", { volume: isLocal ? 0.06 : 0.03 });
      } catch { }
    });

    // GM charge updates
    this.room.onMessage("gmChargeUpdate", (payload: { charges?: number; max?: number; nextInMs?: number }) => {
      try {
        if (typeof payload?.charges === "number") this.gmCharges = payload.charges;
        if (typeof payload?.max === "number") this.gmMaxCharges = payload.max;
        const nextMs = Math.max(0, Number(payload?.nextInMs ?? 0));
        this.gmNextReadyAt = Date.now() + nextMs;
        this.updateGmChargeUi();
        console.log("GM charge update:", this.gmCharges, "/", this.gmMaxCharges, "next in", nextMs, "ms");
      } catch { /* ignore */ }
    });

    $(this.room.state).onChange((changes: any[]) => {
      // console.log("Room state changed:", changes);
      if (changes && Array.isArray(changes)) {
        changes.forEach((change) => {
          console.log("State change field:", change.field, "value:", change.value);
          if (change.field === "running" || change.field === "winnerId" || change.field === "stage") {
            console.log("Updating status message due to state change:", change.field);
            this.updateStatusMessage();
          }
          if (change.field === "running" && !!change.value === true) {
            // Redundantly ensure selection UI is hidden the moment the round starts
            this.setSkinSelectionVisible(false);
          }
          if (change.field === "stage") {
            console.log("Stage changed, refreshing scoreboard");
            this.refreshScoreboard();
          }
          if (change.field === "skinOptions") {
            this.updateSkinOptionsFromState();
          }
          if (change.field === "pigKing") {
            const pk = (this.room!.state as any).pigKing as PigKingState | undefined;
            if (pk) this.schedulePigHealthUI(pk.health, pk.maxHealth);
          }
        });
      } else {
        console.log("State change callback received non-array data:", changes);
      }
    });

    // Pig King health updates
    const pig = (this.room.state as any).pigKing as PigKingState | undefined;
    if (pig) {
      // Initial render
      this.updatePigHealthUI(pig.health, pig.maxHealth);
      const pig$ = $((this.room.state as any).pigKing);
      pig$.onChange((_changes: any[]) => {
        const latest = (this.room!.state as any).pigKing as PigKingState | undefined;
        if (!latest) return;
        this.schedulePigHealthUI(latest.health, latest.maxHealth);
      });
    }

    this.updateStatusMessage();
  }

  private createPigHealthUI() {
    const width = Number(this.game.config.width);
    const margin = 18;
    const padLeft = 6;   // bring avatar closer to the left edge
    const padRight = 12; // keep a little breathing room on the right
    const spacing = 0;   // gap between avatar, bar, and text
    const extraTextSpace = 15; // ensure emoji + numbers never clip

    const container = this.add
      .container(width - margin, margin)
      .setDepth(120)
      .setScrollFactor(0);

    // Compute background width so avatar hugs the bar, with room for the HP text
    const bgWidth = padLeft + padRight + this.pigAvatarSize + spacing + this.pigBarWidth + spacing + extraTextSpace;
    const bgHeight = 52;

    // Soft drop shadow for a fun, layered look
    const shadow = this.add
      .rectangle(2, 2, bgWidth, bgHeight, 0x000000, 0.28)
      .setOrigin(1, 0)
      .setScrollFactor(0);

    const bg = this.add
      .rectangle(0, 0, bgWidth, bgHeight, 0x000000, 0.48)
      .setOrigin(1, 0)
      .setStrokeStyle(2, 0xffffff, 0.35);

    // Layout anchors (container-local coordinates, right-aligned)
    const panelRightX = 0; // bg origin (1,0) places right edge at x=0
    const avatarLeftX = -bgWidth + padLeft;
    const avatarCenterX = avatarLeftX + this.pigAvatarSize / 2;
    const contentTopY = 6;
    const barY = 40; // push bar slightly lower to avoid any label overlap
    const barRightX = panelRightX - padRight; // bar ends padding away from the right edge
    const barLeftX = barRightX - this.pigBarWidth;

    // Avatar sits left and vertically aligned with the content block
    const avatar = this.add
      .image(avatarCenterX, contentTopY, "pig-king-cropped")
      .setOrigin(0.5, 0)
      .setDisplaySize(this.pigAvatarSize, this.pigAvatarSize)
      .setDepth(121);

    // Label above bar, aligned with bar left
    const label = this.add
      .text(barLeftX, contentTopY + 2, "Pig King 👑", {
        fontFamily: "Arial Black",
        fontSize: 16,
        color: "#ffd369",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0, 0)
      .setDepth(121);

    // Health bar background and fill
    const barBg = this.add
      .rectangle(barRightX, barY, this.pigBarWidth, this.pigBarHeight, 0x3a3a3a, 0.9)
      .setOrigin(1, 0.5)
      .setDepth(121);

    const barFill = this.add
      .rectangle(barLeftX, barY, this.pigBarWidth, this.pigBarHeight, 0xe74c3c, 0.95)
      .setOrigin(0, 0.5)
      .setDepth(122);

    // HP text now sits to the right of the bar to avoid overlapping
    const text = this.add
      .text(panelRightX - padRight, barY, "--/--", {
        fontFamily: "Arial Black",
        fontSize: 14,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
        align: "right",
      })
      .setOrigin(1, 0.5)
      .setDepth(123);

    container.add([shadow, bg, avatar, label, barBg, barFill, text]);

    this.pigBarContainer = container;
    this.pigBarBg = barBg;
    this.pigBarFill = barFill;
    this.pigBarText = text;
    this.pigAvatar = avatar;
  }

  private updatePigHealthUI(health: number, max: number) {
    if (!this.pigBarContainer || !this.pigBarFill || !this.pigBarText) return;
    const h = Math.max(0, Math.floor(health ?? 0));
    const m = Math.max(0, Math.floor(max ?? 0));
    const pct = m > 0 ? Phaser.Math.Clamp(h / m, 0, 1) : 0;
    const fillW = this.pigBarWidth * pct;

    // Move/resize the fill rect by changing its x and width (left-aligned to bar background)
    // Recompute based on current barBg position so layout stays consistent if resolution changes
    if (this.pigBarBg) {
      const barRightX = (this.pigBarBg.x as number);
      const barLeftX = barRightX - this.pigBarWidth;
      this.pigBarFill.x = barLeftX;
    }
    this.pigBarFill.width = fillW;
    // Gradient color: 0 -> red, 0.5 -> yellow, 1 -> green
    const color = this.getHealthBarColor(pct);
    this.pigBarFill.setFillStyle(color, this.pigFlashTween ? this.pigBarFill.alpha : 0.95);
    this.pigBarText.setText(`❤️ ${h}/${m}`);
    this.pigBarContainer.setVisible(m > 0);

    // Flash the bar briefly if damage occurred
    if (this.lastPigHealth >= 0 && h < this.lastPigHealth) {
      this.flashPigHealthBar();
    }
    this.lastPigHealth = h;
  }

  // Schedule the UI health update so it lands when the thrown hammer hits
  private schedulePigHealthUI(health: number, max: number) {
    const now = this.time.now;
    const applyAt = Math.max(now, this.pigImpactHoldUntil);
    // If there's effectively no hold, apply immediately
    if (applyAt <= now + 5) {
      this.updatePigHealthUI(health, max);
      return;
    }
    // Otherwise, store as pending and schedule once
    this.pigPendingUI = { health, max };
    try { this.pigUIApplyTimer?.remove(false); } catch { /* noop */ }
    const delay = Math.max(0, applyAt - now);
    this.pigUIApplyTimer = this.time.delayedCall(delay, () => {
      const pending = this.pigPendingUI;
      this.pigPendingUI = undefined;
      if (pending) {
        this.updatePigHealthUI(pending.health, pending.max);
      }
    });
  }

  private flashPigHealthBar() {
    if (!this.pigBarFill || !this.pigBarBg) return;
    if (this.pigFlashTween) {
      try { this.pigFlashTween.stop(); } catch { }
      this.pigBarFill.setAlpha(1);
      this.pigBarBg.setAlpha(0.9);
    }
    const targets: any[] = [];
    if (this.pigBarFill) targets.push(this.pigBarFill);
    if (this.pigBarBg) targets.push(this.pigBarBg);
    this.pigFlashTween = this.tweens.add({
      targets,
      alpha: { from: 1, to: 0.3 },
      duration: 90,
      yoyo: true,
      repeat: 2,
      onComplete: () => {
        this.pigBarFill?.setAlpha(1);
        this.pigBarBg?.setAlpha(0.9);
        this.pigFlashTween = undefined;
      },
    });
  }

  // Map health percent to a smooth color between red -> yellow -> green
  private getHealthBarColor(pct: number): number {
    const clamp = Phaser.Math.Clamp(pct, 0, 1);
    const RED = 0xe74c3c;    // low
    const YELLOW = 0xf1c40f; // mid
    const GREEN = 0x2ecc71;  // high
    if (clamp <= 0.5) {
      const t = clamp / 0.5; // 0..1 from red to yellow
      return this.lerpColor(RED, YELLOW, t);
    } else {
      const t = (clamp - 0.5) / 0.5; // 0..1 from yellow to green
      return this.lerpColor(YELLOW, GREEN, t);
    }
  }

  private lerpColor(c1: number, c2: number, t: number): number {
    const tt = Phaser.Math.Clamp(t, 0, 1);
    const r1 = (c1 >> 16) & 0xff; const g1 = (c1 >> 8) & 0xff; const b1 = c1 & 0xff;
    const r2 = (c2 >> 16) & 0xff; const g2 = (c2 >> 8) & 0xff; const b2 = c2 & 0xff;
    const r = Math.round(r1 + (r2 - r1) * tt);
    const g = Math.round(g1 + (g2 - g1) * tt);
    const b = Math.round(b1 + (b2 - b1) * tt);
    return (r << 16) | (g << 8) | b;
  }

  private addPlayer(sessionId: string, player: PlayerState) {
    console.log("Adding player:", sessionId, "with ready state:", player.ready);
    const role = (player.role as any);
    const isGM = role === "gm";
    const isSpectator = role === "spectator";
    if (!isGM && !isSpectator) {
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

    // If player joins already shielded, render aura immediately
    if (!this.localPlayerIsGM) {
      this.updateShieldVisual(sessionId, player);
    }

    if (sessionId === this.localPlayerId) {
      this.localPlayerReady = player.ready;
      this.localPlayerIsGM = isGM === true; // GM toolbar only for true GM
      this.localPlayerRole = isGM ? "gm" : (isSpectator ? "spectator" : "bird");
      console.log("Set local player ready state to:", player.ready, "role:", this.localPlayerRole);
      this.updateGmUiVisibility();
      // Ensure GM never sees skin selection UI
      if (this.localPlayerIsGM || this.localPlayerRole === "spectator") {
        this.setSkinSelectionVisible(false);
        try { this.skinSelectionContainer?.destroy(true); } catch { /* noop */ }
        this.skinSelectionContainer = undefined;
        this.skinSlotElements.clear();
      }
    }

    if (!isGM && !isSpectator) {
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
    const aura = this.shieldAuras.get(sessionId);
    if (aura) {
      try { aura.destroy(); } catch { /* noop */ }
      this.shieldAuras.delete(sessionId);
    }
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
    const scoreChanged = !cached || cached.score !== player.score;
    if (cached) {
      if (cached.alive && !player.alive && sessionId === this.localPlayerId) {
        this.sound.play("hit", { volume: 0.05 });
        this.sound.play("die", { volume: 0.1, delay: 0.1 });
        // Show summary when local player dies mid-round
        this.showGameOverScreen(false, player.score);
      }
      if (player.score > cached.score && sessionId === this.localPlayerId) {
        const diff = Math.max(1, Math.floor(player.score - cached.score));
        this.sound.play("point", { volume: 0.04 });
        this.animateLocalScoreIncrease(diff, player.score);
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

    // Maintain shield aura based on state, and follow sprite
    this.updateShieldVisual(sessionId, player);
    const aura = this.shieldAuras.get(sessionId);
    if (aura) {
      aura.x = sprite.x;
      aura.y = sprite.y;
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
    if (shouldRefresh || scoreChanged) {
      this.refreshScoreboard();
      //this.updateStatusMessage();
    }
    if (readyChanged) {
      console.log("Ready state changed for player:", sessionId, "to:", player.ready);
      this.updateReadyUI();
    }
    if (skinChanged) {
      this.updateSkinSlots();
    }
  }

  private updateShieldVisual(sessionId: string, player: PlayerState) {
    const sprite = this.playerSprites.get(sessionId);
    if (!sprite) return;
    const active = !!(player as any)?.shield;
    const expiring = !!(player as any)?.shieldExpiring;
    const existing = this.shieldAuras.get(sessionId);
    if (active) {
      if (!existing) {
        // Create a light-blue glow ellipse behind the sprite
        const radius = 28; // slightly larger than bird sprite
        const aura = this.add.ellipse(sprite.x, sprite.y, radius * 2, radius * 2, 0x66ccff, 0.18)
          .setDepth(4)
          .setBlendMode(Phaser.BlendModes.ADD);
        // Add a subtle rim
        aura.setStrokeStyle(2, 0x99ddff, 0.85);
        this.shieldAuras.set(sessionId, aura);
        // Gentle pulse by default
        this.tweens.add({
          targets: aura,
          scaleX: { from: 0.95, to: 1.08 },
          scaleY: { from: 0.95, to: 1.08 },
          alpha: { from: 0.16, to: 0.24 },
          yoyo: true,
          repeat: -1,
          duration: 700,
          ease: "Sine.easeInOut",
        });
        (aura as any).__mode = "normal";
      } else {
        // Update flashing mode based on expiring state
        const aura = existing;
        const currentMode = (aura as any).__mode || "normal";
        const desiredMode = expiring ? "expiring" : "normal";
        if (currentMode !== desiredMode) {
          this.tweens.killTweensOf(aura);
          if (expiring) {
            // Faster flashing and brighter rim during grace timer
            aura.setStrokeStyle(2, 0xffffff, 0.95);
            this.tweens.add({
              targets: aura,
              alpha: { from: 0.15, to: 0.55 },
              scaleX: { from: 0.92, to: 1.10 },
              scaleY: { from: 0.92, to: 1.10 },
              yoyo: true,
              repeat: -1,
              duration: 120,
              ease: "Sine.easeInOut",
            });
          } else {
            // Return to gentle pulse
            aura.setStrokeStyle(2, 0x99ddff, 0.85);
            this.tweens.add({
              targets: aura,
              scaleX: { from: 0.95, to: 1.08 },
              scaleY: { from: 0.95, to: 1.08 },
              alpha: { from: 0.16, to: 0.24 },
              yoyo: true,
              repeat: -1,
              duration: 700,
              ease: "Sine.easeInOut",
            });
          }
          (aura as any).__mode = desiredMode;
        }
      }
    } else if (existing) {
      try { existing.destroy(); } catch { /* noop */ }
      this.shieldAuras.delete(sessionId);
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
    //console.log("Adding pipe:", pipe.id, "at x:", pipe.x, "Ytop:", pipe.Ytop);

    const top = this.add.image(pipe.x, pipe.Ytop, "pipe");
    top.setOrigin(0.5, 0);
    top.setFlipY(true);
    top.setDepth(3);
    //console.log("Created top pipe at:", pipe.x, pipe.Ytop);

    const bottom = this.add.image(pipe.x, pipe.Ybottom, "pipe-red");
    bottom.setOrigin(0.5, 0);
    bottom.setFlipY(false);
    bottom.setDepth(4);
    //console.log("Created bottom pipe at:", pipe.x, pipe.Ybottom);

    this.pipeSprites.set(pipe.id, {
      top,
      bottom,
      targetX: pipe.x,
      targetTopY: pipe.Ytop,
      targetBottomY: pipe.Ybottom,
    });
    this.updatePipe(pipe);
    //console.log("Pipe added successfully, total pipes:", this.pipeSprites.size);
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
        // Non-playing roles
        const role = (player as any).role;
        if (role === "gm") {
          return `${player.isLocal ? "* " : ""}${player.name} (Pig King)`;
        }
        if (role === "spectator") {
          return `${player.isLocal ? "* " : ""}${player.name} (Spectator)`;
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
    //this.updateReadyUI();
    //void this.updateDiscordActivityPresence();
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
      // Ensure status text is visible again in lobby/end screens
      try { this.statusText.setVisible(true).setAlpha(1); } catch { /* noop */ }
      const readyCount = this.getReadyCount();

      // Team win handling
      if (winnerId === "__BIRDS__") {
        this.showWinBanner("birds");
        this.statusText.setText(this.localPlayerRole === "spectator" ? "Birds win!\nReturn to Menu to play next round." : "Birds win!\nPress Ready to play again.");
        // Show summary: birds show their round score; GM shows loss/time summary; spectators get neutral panel
        const isLocalBird = this.localPlayerRole === "bird";
        const localPlayer = this.room.state.players.get(this.localPlayerId) as PlayerState | undefined;
        if (isLocalBird) {
          this.showGameOverScreen(true, localPlayer?.score ?? 0);
        } else {
          this.showGameOverScreen(false);
        }
        return;
      }

      // Pig King wins if winnerId equals GM id or special token
      const gmId = (this.room.state as any).gameMasterId as string;
      if (winnerId && (winnerId === gmId || winnerId === "__PIG__")) {
        this.showWinBanner("pig");
        this.statusText.setText(this.localPlayerRole === "spectator" ? "Pig King wins!\nReturn to Menu to play next round." : "Pig King wins!\nPress Ready to play again.");
        if (this.localPlayerRole === "gm") {
          // GM wins -> show time summary
          this.showGameOverScreen(true);
        } else {
          // Birds lose -> show round score summary
          const localPlayer = this.room.state.players.get(this.localPlayerId) as PlayerState | undefined;
          this.showGameOverScreen(false, localPlayer?.score ?? 0);
        }
        return;
      }

      // Lobby messaging
      this.clearWinBanner();
      if (playerCount > 0) {
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
      // In-game: show a spectating hint for non-playing users, otherwise hide
      if (this.localPlayerRole === "spectator") {
        try { this.statusText.setVisible(true).setAlpha(1); } catch { /* noop */ }
        this.statusText.setText("Game in progress. You are spectating.");
      } else if (!this.isStatusIntroActive) {
        try { this.statusText.setVisible(false); } catch { /* noop */ }
      }
      // Ensure lobby-only UI is hidden while in-game
      this.clearWinBanner();
      this.setSkinSelectionVisible(false);
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
      if ((player.role as any) === "bird") {
        count += 1;
      }
    });
    return count;
  }

  private addPlacedObstacle(obs: PlacedObstacleState) {
    const key = obs.kind === "top" ? "pipe" : "pipe-red";
    const img = this.add.image(obs.x, obs.y, key);
    img.setOrigin(0.5, 0);
    img.setFlipY(obs.kind === "top");
    img.setDepth(4);
    this.placedObstacleSprites.set(obs.id, { img, targetX: obs.x, targetY: obs.y });
  }

  private updatePlacedObstacle(obs: PlacedObstacleState | undefined) {
    if (!obs) return;
    const entry = this.placedObstacleSprites.get(obs.id);
    if (!entry) return;
    entry.targetX = obs.x;
    entry.targetY = obs.y;
  }

  private removePlacedObstacle(id: number) {
    const entry = this.placedObstacleSprites.get(id);
    if (entry) entry.img.destroy();
    this.placedObstacleSprites.delete(id);
  }

  private showWinBanner(kind: "birds" | "pig") {
    if (this.lastWinBannerKind === kind && this.winBanner && this.winBanner.active) {
      return;
    }
    this.clearWinBanner();

    const width = Number(this.game.config.width);
    const container = this.add.container(width / 2, 120).setDepth(200).setScrollFactor(0);
    const isBirds = kind === "birds";

    const accent = isBirds ? 0x2ecc71 : 0x9b59b6;
    const titleText = isBirds ? "BIRDS WIN" : "PIG KING WINS";

    const bg = this.add.rectangle(0, 0, 480, 88, 0x000000, 0.6).setOrigin(0.5).setStrokeStyle(3, accent, 0.95);
    const title = this.add.text(0, 0, titleText, {
      fontFamily: "Arial Black",
      fontSize: 34,
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 6,
      align: "center",
    }).setOrigin(0.5);

    container.add([bg, title]);
    container.setScale(0.85);
    this.tweens.add({ targets: container, scaleX: 1, scaleY: 1, duration: 220, ease: 'Back.out' });

    // auto-hide after 3 seconds
    this.winBannerTimeout = this.time.delayedCall(3000, () => this.clearWinBanner());
    this.winBanner = container;
    this.lastWinBannerKind = kind;
  }

  private clearWinBanner() {
    if (this.winBannerTimeout) {
      try { this.winBannerTimeout.remove(false); } catch { }
      this.winBannerTimeout = undefined;
    }
    if (this.winBanner) {
      this.winBanner.destroy(true);
      this.winBanner = undefined;
    }
    this.lastWinBannerKind = undefined;
  }

  // Power-ups
  private addPowerUp(pu: PowerUpState) {
    const key = pu.sprite && this.textures.exists(pu.sprite) ? pu.sprite : "star";
    const img = this.add.image(pu.x, pu.y, key).setDepth(60);
    img.setOrigin(0.5, 0.5);
    img.setScale(0.8);
    this.powerUpSprites.set(pu.id, { img, targetX: pu.x, targetY: pu.y });
  }

  private updatePowerUp(pu: PowerUpState) {
    const entry = this.powerUpSprites.get(pu.id);
    if (!entry) return;
    entry.targetX = pu.x;
    entry.targetY = pu.y;
  }

  private removePowerUp(id: number) {
    const entry = this.powerUpSprites.get(id);
    if (entry) entry.img.destroy();
    this.powerUpSprites.delete(id);
  }

  private showPowerUpPickup(x: number, y: number, label: string, isLocal: boolean) {
    // Text popup
    const txt = this.add.text(x, y - 24, label || "Power Up!", {
      fontFamily: "Arial Black",
      fontSize: 18,
      color: isLocal ? "#ffe7a6" : "#d2e0ff",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    }).setOrigin(0.5).setDepth(80);

    this.tweens.add({
      targets: txt,
      y: y - 64,
      alpha: 0,
      duration: 700,
      ease: 'Quad.out',
      onComplete: () => txt.destroy(),
    });

    // Visual FX at pickup point (shared for all players via server broadcast)
    try {
      const hasAnim = this.anims.exists("pickup_fx");
      if (hasAnim) {
        const fx = this.add.sprite(x, y, "pickup_anim").setDepth(79).setScale(1.5);
        fx.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => fx.destroy());
        fx.play("pickup_fx");
      } else if (this.textures.exists("pickup_anim")) {
        // Fallback: pulse the static image if no multi-frame sheet is available
        const img = this.add.image(x, y, "pickup_anim").setDepth(79).setScale(0.9).setAlpha(0.95);
        this.tweens.add({
          targets: img,
          scale: 2.1,
          alpha: 0,
          duration: 450,
          ease: 'Cubic.out',
          onComplete: () => img.destroy(),
        });
      } else if (this.textures.exists("star")) {
        // Last-resort fallback to star icon
        const img = this.add.image(x, y, "star").setDepth(79).setScale(0.9);
        this.tweens.add({
          targets: img,
          scale: 2.1,
          alpha: 0,
          duration: 450,
          ease: 'Cubic.out',
          onComplete: () => img.destroy(),
        });
      }
    } catch { /* no-op */ }
  }

  private animateLocalScoreIncrease(diff: number, _newScore: number) {
    // Pulse the scoreboard text (and backdrop) and spawn a floating +N indicator
    try { this.scorePulseTween?.stop(); } catch { /* noop */ }
    const pulseTargets: any[] = [];
    if (this.scoreText) pulseTargets.push(this.scoreText);
    if (this.scoreBackdrop) pulseTargets.push(this.scoreBackdrop);
    if (pulseTargets.length > 0) {
      // Reset scale to baseline before pulsing
      pulseTargets.forEach((t) => { try { t.setScale?.(1); } catch { /* noop */ } });
      this.scorePulseTween = this.tweens.add({
        targets: pulseTargets,
        scaleX: { from: 1, to: 1.15 },
        scaleY: { from: 1, to: 1.15 },
        duration: 100,
        yoyo: true,
        ease: 'Back.out',
      });
    }

    // Floating +N text near the scoreboard
    const x = this.scoreText?.x ?? (Number(this.game.config.width) / 2);
    const y = (this.scoreText?.y ?? 40) - 10;
    const pop = this.add.text(x, y, `+${diff}`, {
      fontFamily: 'Arial Black',
      fontSize: 24,
      color: '#ffd369',
      stroke: '#000000',
      strokeThickness: 6,
      align: 'center',
    }).setOrigin(0.5).setDepth(12);
    pop.setScale(0.8);
    pop.setAlpha(0.0);
    this.tweens.add({
      targets: pop,
      y: y - 24,
      alpha: { from: 0, to: 1 },
      scale: { from: 0.8, to: 1.0 },
      duration: 180,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: pop,
          y: y - 40,
          alpha: { from: 1, to: 0 },
          duration: 220,
          ease: 'Quad.easeIn',
          onComplete: () => { try { pop.destroy(); } catch { /* noop */ } },
        });
      },
    });
  }

  // Visual: throw a rotating hammer from pickup point towards the Pig King avatar in the UI.
  private throwHammerToPig(startX: number, startY: number) {
    try {
      // Determine target position (Pig King avatar) in WORLD coordinates.
      // Children inside a Container use local coordinates; convert via getBounds().
      let targetX = Number(this.game.config.width) - 60;
      let targetY = 46;
      if (this.pigAvatar) {
        try {
          const b = this.pigAvatar.getBounds();
          targetX = (b as any).centerX ?? b.x + b.width / 2;
          targetY = (b as any).centerY ?? b.y + b.height / 2;
        } catch {
          // Fallback: approximate using container position if available
          const pc = (this.pigBarContainer as any);
          targetX = (pc?.x ?? targetX) + (this.pigAvatar.x as number);
          targetY = (pc?.y ?? targetY) + (this.pigAvatar.y as number);
        }
      }

      // If hammer texture not available, skip gracefully
      if (!this.textures.exists("hammer")) {
        return;
      }

      const hammer = this.add.image(startX, startY, "hammer").setDepth(200);
      hammer.setOrigin(0.5, 0.5);
      hammer.setScale(0.9);

      // Compute travel duration based on distance for a consistent feel
      const dx = targetX - startX;
      const dy = targetY - startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const duration = Phaser.Math.Clamp(300 + dist * 0.6, 450, 1200); // ms
      // Hold back the health bar update until expected impact time (+small buffer)
      const impactAt = this.time.now + duration + 100;
      this.pigImpactHoldUntil = Math.max(this.pigImpactHoldUntil, impactAt);
      // If we already queued a UI update, reschedule it to the later impact
      if (this.pigPendingUI) {
        try { this.pigUIApplyTimer?.remove(false); } catch { /* noop */ }
        const delay = Math.max(0, this.pigImpactHoldUntil - this.time.now);
        this.pigUIApplyTimer = this.time.delayedCall(delay, () => {
          const pending = this.pigPendingUI!;
          this.pigPendingUI = undefined;
          this.updatePigHealthUI(pending.health, pending.max);
        });
      }

      // Add slight arc by tweening y in two stages
      const midX = startX + dx * 0.5;
      const midY = startY + dy * 0.5 - Math.min(80, Math.max(20, dist * 0.1)); // arc peak

      // First leg to midpoint with spin
      this.tweens.add({
        targets: hammer,
        x: midX,
        y: midY,
        angle: 360,
        duration: duration * 0.5,
        ease: "Quad.out",
        onComplete: () => {
          // Second leg to target with additional spin
          this.tweens.add({
            targets: hammer,
            x: targetX,
            y: targetY,
            angle: 720,
            duration: duration * 0.5,
            ease: "Quad.in",
            onComplete: () => {
              // Small impact pulse at the Pig King avatar
              const impactScale = 1.2;
              if (this.pigAvatar) {
                this.tweens.add({
                  targets: this.pigAvatar,
                  scaleX: this.pigAvatar.scaleX * impactScale,
                  scaleY: this.pigAvatar.scaleY * impactScale,
                  yoyo: true,
                  duration: 100,
                  ease: "Sine.inOut",
                });
              }
              hammer.destroy();
            },
          });
        },
      });
    } catch {
      // no-op
    }
  }

  private getReadyCount() {
    if (!this.room || !this.room.state || !this.room.state.players) {
      return 0;
    }
    let count = 0;
    this.room.state.players.forEach((player: PlayerState, sessionId: string) => {
      if ((player.role as any) !== "bird") {
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
