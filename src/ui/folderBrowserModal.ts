import { App, ButtonComponent, Modal, Setting, setIcon } from "obsidian";
import { DriveClient, DriveItem } from "../api/client";
import { withinMyDrive } from "../utils/paths";

export class FolderBrowserModal extends Modal {
  private currentPath: string;
  private listings: DriveItem[] = [];

  constructor(app: App, private client: DriveClient, startPath: string, private onSelect: (path: string) => void) {
    super(app);
    this.currentPath = withinMyDrive(startPath) ? startPath : "/mydrive";
  }

  async onOpen() {
    await this.loadAndRender();
  }

  private async loadAndRender() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Select remote folder" });
    contentEl.createEl("p", { text: `Browsing ${this.currentPath}` });

    await this.load();

    const list = contentEl.createDiv({ cls: "synodrive-folder-list" });

    if (this.currentPath !== "/mydrive") {
      const up = list.createDiv({ cls: "synodrive-folder-row" });
      const upBtn = new ButtonComponent(up).setButtonText("Up");
      setIcon(upBtn.buttonEl, "arrow-up");
      upBtn.onClick(() => {
        const parent = this.currentPath.split("/").slice(0, -1).join("/") || "/mydrive";
        this.currentPath = parent.startsWith("/mydrive") ? parent : "/mydrive";
        this.loadAndRender();
      });
    }

    for (const item of this.listings) {
      const row = list.createDiv({ cls: "synodrive-folder-row" });
      const button = new ButtonComponent(row).setButtonText(item.name).onClick(() => {
        this.currentPath = item.path;
        this.loadAndRender();
      });
      setIcon(button.buttonEl, "folder");
    }

    new Setting(contentEl)
      .setName("Create folder")
      .setDesc("Creates a folder in the current path")
      .addText((text) => text.setPlaceholder("notes").onChange((value) => (text.inputEl.dataset.folderName = value)))
      .addButton((btn) =>
        btn.setButtonText("Create").onClick(async () => {
          const name = (btn.buttonEl.parentElement?.querySelector("input") as HTMLInputElement | null)?.value?.trim();
          if (!name) return;
          const target = `${this.currentPath}/${name}`;
          await this.client.createFolder(target);
          await this.loadAndRender();
        }),
      );

    const footer = contentEl.createDiv({ cls: "synodrive-modal-actions" });
    new ButtonComponent(footer)
      .setButtonText("Use this folder")
      .setCta()
      .onClick(() => {
        this.onSelect(this.currentPath);
        this.close();
      });
    new ButtonComponent(footer).setButtonText("Cancel").onClick(() => this.close());
  }

  private async load() {
    this.listings = await this.client.list(this.currentPath, { includeFiles: false });
    this.listings = this.listings.filter((item) => item.type === "dir");
  }
}
