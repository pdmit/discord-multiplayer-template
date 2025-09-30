import { Scene } from "phaser";

export class Background extends Scene {
  constructor() {
    super("background");
  }

  create() {
    this.cameras.main.setBackgroundColor(0x70c5ce);
    this.scene.sendToBack();

    const { width, height } = this.cameras.main;
    this.add.tileSprite(0, 0, width * 1.5, height, "background-day").setOrigin(0, 0);
    this.add.tileSprite(0, height - 112, width * 1.5, 112, "base").setOrigin(0, 0);
  }
}
