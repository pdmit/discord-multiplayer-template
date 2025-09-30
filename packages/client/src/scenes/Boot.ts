import { Scene } from "phaser";

export class Boot extends Scene {
  constructor() {
    super("Boot");
  }

  preload() {
    //  The Boot Scene is typically used to load in any assets you require for your Preloader, such as a game logo or background.
    //  The smaller the file size of the assets, the better, as the Boot Scene itself has no preloader.

    this.load.setPath("/.proxy/assets/flappy-bird-assets/sprites");
    this.load.image("background-day", "background-day.png");
    this.load.image("base", "base.png");
  }

  create() {
    this.scene.start("Preloader");
  }
}
