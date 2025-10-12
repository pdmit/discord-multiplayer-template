import { Scene } from "phaser";
import { authorizeDiscordUser } from "../utils/discordSDK";

export class MainMenu extends Scene {
  constructor() {
    super("MainMenu");
  }

  create() {
    const { width, height } = this.cameras.main;

    this.add.tileSprite(0, 0, width * 1.5, height, "background-day").setOrigin(0, 0);
    this.add.tileSprite(0, height - 112, width * 1.5, 112, "base").setOrigin(0, 0);

    this.add
      .image(Number(this.game.config.width) * 0.5, Number(this.game.config.height) * 0.3, "message")
      .setScale(1.2);

    this.add
      .text(Number(this.game.config.width) * 0.5, Number(this.game.config.height) * 0.5, "Choose Role", {
        fontFamily: "Arial Black",
        fontSize: 36,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 8,
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
      const bg = this.add
        .rectangle(centerX, y, buttonWidth, buttonHeight, color, 0.9)
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      const text = this.add.text(centerX, y, label, {
        fontFamily: "Arial Black",
        fontSize: 26,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 6,
        align: "center",
      }).setOrigin(0.5);

      bg.on("pointerdown", async () => { await authorizeDiscordUser(); onClick(); });
      bg.on("pointerover", () => bg.setFillStyle(Phaser.Display.Color.IntegerToColor(color).color, 0.95));
      bg.on("pointerout", () => bg.setFillStyle(color, 0.9));
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
}
