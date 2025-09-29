import { Scene } from "phaser";
import { authorizeDiscordUser } from "../utils/discordSDK";

export class MainMenu extends Scene {
  constructor() {
    super("MainMenu");
  }

  create() {
    const { width, height } = this.cameras.main;

    const bg = this.add
      .tileSprite(0, 0, width * 1.5, height, "background-day")
      .setOrigin(0, 0);
    this.add.tileSprite(0, height - 112, width * 1.5, 112, "base").setOrigin(0, 0);

    this.add
      .image(Number(this.game.config.width) * 0.5, Number(this.game.config.height) * 0.35, "message")
      .setScale(1.2);

    this.add
      .text(Number(this.game.config.width) * 0.5, Number(this.game.config.height) * 0.65, "Tap or press SPACE to join", {
        fontFamily: "Arial Black",
        fontSize: 32,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 8,
        align: "center",
      })
      .setOrigin(0.5);

    this.input.once("pointerdown", async () => {
      await authorizeDiscordUser();
      this.scene.start("Game");
    });

    this.input.keyboard?.once("keydown-SPACE", async () => {
      await authorizeDiscordUser();
      this.scene.start("Game");
    });
  }
}
