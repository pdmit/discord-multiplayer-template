import { Scene } from "phaser";

export class Preloader extends Scene {
  constructor() {
    super("Preloader");
  }

  init() {
    const bg = this.add
      .image(this.cameras.main.width / 2, this.cameras.main.height / 2, "background-night")
      .setOrigin(0.5, 0.5);
    const scale = Math.max(
      this.cameras.main.width / bg.width,
      this.cameras.main.height / bg.height
    );
    bg.setScale(scale).setScrollFactor(0);

    //  A simple progress bar. This is the outline of the bar.
    this.add
      .rectangle(
        Number(this.game.config.width) * 0.5,
        Number(this.game.config.height) * 0.5,
        468,
        32
      )
      .setStrokeStyle(1, 0xffffff);

    //  This is the progress bar itself. It will increase in size from the left based on the % of progress.
    const bar = this.add.rectangle(
      Number(this.game.config.width) * 0.5 - 230,
      Number(this.game.config.height) * 0.5,
      4,
      28,
      0xffffff
    );

    //  Use the 'progress' event emitted by the LoaderPlugin to update the loading bar
    this.load.on("progress", (progress) => {
      //  Update the progress bar (our bar is 464px wide, so 100% = 464px)
      bar.width = 4 + 460 * progress;
    });
  }

  preload() {
    //  Load the assets for the game - Replace with your own assets
    this.load.setPath("/.proxy/assets/flappy-bird-assets/sprites");

    this.load.image("background-day", "background-day.png");
    this.load.image("background-night", "background-night.png");
    this.load.image("pipe", "pipe-green.png");
    this.load.image("pipe-red", "pipe-red.png");
    this.load.image("base", "base.png");
    this.load.image("message", "message.png");
    this.load.image("gameover", "gameover.png");
    this.load.image("score-0", "0.png");
    this.load.image("score-1", "1.png");
    this.load.image("score-2", "2.png");
    this.load.image("score-3", "3.png");
    this.load.image("score-4", "4.png");
    this.load.image("score-5", "5.png");
    this.load.image("score-6", "6.png");
    this.load.image("score-7", "7.png");
    this.load.image("score-8", "8.png");
    this.load.image("score-9", "9.png");

    this.load.image("yellowbird-downflap", "yellowbird-downflap.png");
    this.load.image("yellowbird-midflap", "yellowbird-midflap.png");
    this.load.image("yellowbird-upflap", "yellowbird-upflap.png");
    this.load.image("bluebird-downflap", "bluebird-downflap.png");
    this.load.image("bluebird-midflap", "bluebird-midflap.png");
    this.load.image("bluebird-upflap", "bluebird-upflap.png");
    this.load.image("redbird-downflap", "redbird-downflap.png");
    this.load.image("redbird-midflap", "redbird-midflap.png");
    this.load.image("redbird-upflap", "redbird-upflap.png");
    this.load.image("greenbird-downflap", "greenbird-downflap.png");
    this.load.image("greenbird-midflap", "greenbird-midflap.png");
    this.load.image("greenbird-upflap", "greenbird-upflap.png");
    this.load.image("purplebird-downflap", "purplebird-downflap.png");
    this.load.image("purplebird-midflap", "purplebird-midflap.png");
    this.load.image("purplebird-upflap", "purplebird-upflap.png");
    this.load.image("orangebird-downflap", "orangebird-downflap.png");
    this.load.image("orangebird-midflap", "orangebird-midflap.png");
    this.load.image("orangebird-upflap", "orangebird-upflap.png");

    // Power-ups
    this.load.image("star", "star_32.png");
    this.load.image("hammer", "hammer_32.png");
    // Pig King avatar
    this.load.image("pig-king-cropped", "pig-king-cropped.png");

    this.load.setPath("/.proxy/assets/flappy-bird-assets/audio");
    this.load.audio("wing", ["wing.ogg", "wing.wav"]);
    this.load.audio("point", ["point.ogg", "point.wav"]);
    this.load.audio("hit", ["hit.ogg", "hit.wav"]);
    this.load.audio("die", ["die.ogg", "die.wav"]);
    this.load.audio("swoosh", ["swoosh.ogg", "swoosh.wav"]);
  }

  create() {
    this.anims.create({
      key: "yellow_fly",
      frames: [
        { key: "yellowbird-downflap" },
        { key: "yellowbird-midflap" },
        { key: "yellowbird-upflap" },
      ],
      frameRate: 12,
      repeat: -1,
    });

    this.anims.create({
      key: "blue_fly",
      frames: [
        { key: "bluebird-downflap" },
        { key: "bluebird-midflap" },
        { key: "bluebird-upflap" },
      ],
      frameRate: 12,
      repeat: -1,
    });

    this.anims.create({
      key: "red_fly",
      frames: [
        { key: "redbird-downflap" },
        { key: "redbird-midflap" },
        { key: "redbird-upflap" },
      ],
      frameRate: 12,
      repeat: -1,
    });

    this.anims.create({
      key: "green_fly",
      frames: [
        { key: "greenbird-downflap" },
        { key: "greenbird-midflap" },
        { key: "greenbird-upflap" },
      ],
      frameRate: 12,
      repeat: -1,
    });

    this.anims.create({
      key: "purple_fly",
      frames: [
        { key: "purplebird-downflap" },
        { key: "purplebird-midflap" },
        { key: "purplebird-upflap" },
      ],
      frameRate: 12,
      repeat: -1,
    });

    this.anims.create({
      key: "orange_fly",
      frames: [
        { key: "orangebird-downflap" },
        { key: "orangebird-midflap" },
        { key: "orangebird-upflap" },
      ],
      frameRate: 12,
      repeat: -1,
    });

    this.scene.start("MainMenu");
  }
}
