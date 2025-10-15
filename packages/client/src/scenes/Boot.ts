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
    // Wait for fonts to load before proceeding
    this.loadWebFonts().then(() => {
      this.scene.start("Preloader");
    });
  }

  private async loadWebFonts(): Promise<void> {
    // Use the CSS Font Loading API to ensure fonts are ready
    if ('fonts' in document) {
      try {
        await Promise.all([
          document.fonts.load('16px "Jersey 10"'),
          document.fonts.load('16px "Nunito"')
        ]);
        console.log('Fonts loaded successfully');
      } catch (error) {
        console.warn('Font loading failed, using fallback:', error);
      }
    }
    // Small delay to ensure fonts are fully rendered
    return new Promise(resolve => setTimeout(resolve, 100));
  }
}
