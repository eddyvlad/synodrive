import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import SynodrivePlugin from "../main";
import { DEFAULT_EXCLUSIONS, SyncMode } from "../settings";
import { ConnectModal } from "./connectModal";
import { FolderBrowserModal } from "./folderBrowserModal";

export class SynodriveSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SynodrivePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Synodrive" });

    this.renderConnection(containerEl);
    this.renderRemoteRoot(containerEl);
    this.renderSyncBehavior(containerEl);
    this.renderAdvanced(containerEl);
    this.renderDiagnostics(containerEl);
  }

  private renderConnection(containerEl: HTMLElement) {
    const status = this.plugin.client.isAuthenticated()
      ? `Connected as ${this.plugin.settings.username || "(unknown)"}`
      : "Not connected";

    new Setting(containerEl).setName("Connection status").setDesc(status);

    new Setting(containerEl)
      .setName(this.plugin.client.isAuthenticated() ? "Disconnect" : "Connect")
      .setDesc("Authenticate with your Synology Drive server")
      .addButton((btn) => {
        if (this.plugin.client.isAuthenticated()) {
          btn.setButtonText("Disconnect").onClick(async () => {
            await this.plugin.disconnect();
            new Notice("Disconnected from Synology Drive");
            this.display();
          });
        } else {
          btn
            .setButtonText("Connect")
            .setCta()
            .onClick(() =>
              new ConnectModal(this.app, async (payload) => {
                await this.plugin.connect(payload);
                this.display();
              }).open(),
            );
        }
      });
  }

  private renderRemoteRoot(containerEl: HTMLElement) {
    const remoteSection = containerEl.createDiv();
    remoteSection.createEl("h3", { text: "Remote root" });

    new Setting(remoteSection)
      .setName("Selected folder")
      .setDesc(this.plugin.settings.remoteRoot || "None")
      .addButton((btn) =>
        btn.setButtonText("Browse…").onClick(() => {
          if (!this.plugin.client.isAuthenticated()) {
            new Notice("Connect first");
            return;
          }
          new FolderBrowserModal(this.app, this.plugin.client, this.plugin.settings.remoteRoot, async (path) => {
            this.plugin.settings.remoteRoot = path;
            await this.plugin.saveSettings();
            this.display();
          }).open();
        }),
      );
  }

  private renderSyncBehavior(containerEl: HTMLElement) {
    const section = containerEl.createDiv();
    section.createEl("h3", { text: "Sync behavior" });

    new Setting(section)
      .setName("Mode")
      .setDesc("One-way uploads only or two-way sync")
      .addDropdown((dropdown) => {
        dropdown.addOption("one-way-up", "One-way up");
        dropdown.addOption("two-way", "Two-way");
        dropdown.setValue(this.plugin.settings.syncMode);
        dropdown.onChange(async (value) => {
          this.plugin.settings.syncMode = value as SyncMode;
          await this.plugin.saveSettings();
        });
      });

    new Setting(section)
      .setName("Exclusions")
      .setDesc("One glob pattern per line; dotfiles and system files are excluded by default")
      .addTextArea((area) => {
        area.inputEl.setAttr("rows", 5);
        area.setValue(this.plugin.settings.exclusions.join("\n"));
        area.onChange(async (value) => {
          const patterns = value
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean);
          this.plugin.settings.exclusions = patterns.length ? patterns : DEFAULT_EXCLUSIONS;
          await this.plugin.saveSettings();
        });
      });

    new Setting(section)
      .setName("Background sync interval (minutes)")
      .setDesc("0 disables background sync")
      .addText((text) => {
        text.setPlaceholder("15").setValue(String(this.plugin.settings.intervalMinutes));
        text.onChange(async (value) => {
          const minutes = Number(value) || 0;
          this.plugin.settings.intervalMinutes = minutes;
          this.plugin.settings.backgroundSync = minutes > 0;
          await this.plugin.saveSettings();
          this.plugin.configureBackgroundSync();
        });
      });

    new Setting(section)
      .setName("Conflict handling")
      .setDesc(
        "Conflicts create '<filename> (conflict YYYY-MM-DD-HHmmss).ext' copies and are logged. No prompts are shown.",
      );
  }

  private renderAdvanced(containerEl: HTMLElement) {
    const section = containerEl.createDiv();
    section.createEl("h3", { text: "Advanced" });

    new Setting(section)
      .setName("Max concurrent requests")
      .addText((text) => {
        text.setPlaceholder("4").setValue(String(this.plugin.settings.maxConcurrency));
        text.onChange(async (value) => {
          this.plugin.settings.maxConcurrency = Math.max(1, Number(value) || 4);
          await this.plugin.saveSettings();
        });
      });

    new Setting(section)
      .setName("Chunk upload size (MB)")
      .addText((text) => {
        text.setPlaceholder("8").setValue(String(this.plugin.settings.chunkMb));
        text.onChange(async (value) => {
          this.plugin.settings.chunkMb = Math.max(1, Number(value) || 8);
          await this.plugin.saveSettings();
        });
      });

    new Setting(section)
      .setName("Network timeout (seconds)")
      .addText((text) => {
        text.setPlaceholder("30").setValue(String(this.plugin.settings.timeoutSeconds));
        text.onChange(async (value) => {
          this.plugin.settings.timeoutSeconds = Math.max(5, Number(value) || 30);
          await this.plugin.saveSettings();
        });
      });
  }

  private renderDiagnostics(containerEl: HTMLElement) {
    const section = containerEl.createDiv();
    section.createEl("h3", { text: "Diagnostics" });

    const recent = this.plugin.logger.getRecent();
    const logContainer = section.createEl("pre", { cls: "synodrive-log" });
    logContainer.textContent = recent
      .map((entry) => `${new Date(entry.timestamp).toISOString()} [${entry.level}] ${entry.message}`)
      .join("\n");

    new Setting(section)
      .setName("Export logs")
      .setDesc("Exports the last 200 log lines to the plugin folder")
      .addButton((btn) => btn.setButtonText("Export").onClick(() => this.plugin.exportLogs()));

    new Setting(section)
      .setName("Last sync")
      .setDesc(
        this.plugin.settings.lastSyncReport
          ? `Ran ${new Date(this.plugin.settings.lastSyncReport.ranAt).toLocaleString()}`
          : "No syncs yet",
      )
      .addButton((btn) => btn.setButtonText("Show report").onClick(() => this.plugin.showLastSyncReport()));
  }
}
