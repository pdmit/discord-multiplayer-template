import { Scene } from "phaser";
import { authorizeDiscordUser } from "../utils/discordSDK";

// Font constants for consistent styling across the game
const FONT_PRIMARY = '"Jersey 10", "Arial Black", sans-serif';  // For headers, buttons, important text
const FONT_SECONDARY = '"Nunito", "Arial", sans-serif';   // For body text, stats, secondary info

export class MainMenu extends Scene {
  constructor() {
    super("MainMenu");
  }

  create() {
    // Register lifecycle cleanup hooks to ensure UI and listeners are released
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.onDestroy, this);

    const { width, height } = this.cameras.main;

    this.add.tileSprite(0, 0, width * 1.5, height, "background-day").setOrigin(0, 0);
    this.add.tileSprite(0, height - 112, width * 1.5, 112, "base").setOrigin(0, 0);

    this.add
      .image(Number(this.game.config.width) * 0.5, Number(this.game.config.height) * 0.3, "message")
      .setScale(1.2);

    this.add
      .text(Number(this.game.config.width) * 0.5, Number(this.game.config.height) * 0.5, "Choose Role", {
        fontFamily: FONT_PRIMARY,
        fontSize: 36,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 6,
        align: "center",
      })
      .setOrigin(0.5);

    const buttonWidth = Math.min(320, Number(this.game.config.width) * 0.45);
    const buttonHeight = 70;
    const centerX = Number(this.game.config.width) * 0.5;
    const baseY = Number(this.game.config.height) * 0.65;
    const spacing = 90;

    const makeButton = (
      y: number,
      label: string,
      color: number,
      onClick: () => void,
    ) => {
      // Create 3D shadow layer (darker, offset down and right)
      const shadowColor = Phaser.Display.Color.IntegerToColor(color).darken(40).color;
      const shadow = this.add
        .rectangle(centerX + 4, y + 4, buttonWidth, buttonHeight, shadowColor, 0.6)
        .setOrigin(0.5);

      // Create main button with border for depth
      const bg = this.add
        .rectangle(centerX, y, buttonWidth, buttonHeight, color, 1)
        .setOrigin(0.5)
        .setStrokeStyle(4, 0xffffff, 0.3)
        .setInteractive({ useHandCursor: true });

      // Add inner border for more depth
      const innerBorder = this.add
        .rectangle(centerX, y - 2, buttonWidth - 8, buttonHeight - 8)
        .setOrigin(0.5)
        .setStrokeStyle(2, Phaser.Display.Color.IntegerToColor(color).lighten(20).color, 0.5)
        .setFillStyle(0x000000, 0); // Transparent fill

      const text = this.add.text(centerX, y, label, {
        fontFamily: FONT_PRIMARY,
        fontSize: 26,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
        align: "center",
      }).setOrigin(0.5);

      bg.on("pointerdown", async () => { 
        // Press effect: move down slightly
        bg.y += 3;
        shadow.y += 3;
        innerBorder.y += 3;
        text.y += 3;
        await authorizeDiscordUser(); 
        onClick(); 
      });
      bg.on("pointerover", () => {
        const lightColor = Phaser.Display.Color.IntegerToColor(color).lighten(15).color;
        bg.setFillStyle(lightColor, 1);
      });
      bg.on("pointerout", () => {
        bg.setFillStyle(color, 1);
        // Reset position in case it was pressed
        bg.y = y;
        shadow.y = y + 4;
        innerBorder.y = y - 2;
        text.y = y;
      });
    };

    // Play as Bird button
    makeButton(baseY, "Play as Bird", 0x3498db, () => {
      this.scene.start("Game", { role: "bird" });
    });

    // Spectate as Game Master button
    makeButton(baseY + spacing, "Play as Pig", 0x8e44ad, () => {
      this.scene.start("Game", { role: "gm" });
    });

    // Keyboard shortcuts for quick selection
    this.input.keyboard?.once("keydown-SPACE", async () => {
      await authorizeDiscordUser();
      this.scene.start("Game", { role: "bird" });
    });
  }

  // Scene lifecycle hooks
  private onShutdown() {
    this.cleanupMenuScene();
  }

  private onDestroy() {
    this.cleanupMenuScene();
    try { this.events.removeAllListeners(); } catch { /* noop */ }
  }

  private cleanupMenuScene() {
    // Stop input listeners
    try { this.input.removeAllListeners(); } catch { /* noop */ }
    try { this.input.keyboard?.removeAllListeners(); } catch { /* noop */ }
    // Kill tweens and timers in this scene
    try { this.tweens.killAll(); } catch { /* noop */ }
    try { this.time.removeAllEvents(); } catch { /* noop */ }
    // Stop any playing sounds from this scene
    try { this.sound.stopAll(); } catch { /* noop */ }
    // Destroy all display objects defensively
    try { this.children.removeAll(true); } catch { /* noop */ }
  }
}
