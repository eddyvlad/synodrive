import { Menu, Notice, Plugin, TAbstractFile } from "obsidian";
import { DriveClient } from 'api/client';
import { SecureSessionStore } from 'auth/sessionStore';
import { DiagnosticsLogger } from 'logger';
import { DEFAULT_SETTINGS, SynodriveSettings } from 'settings';
import { SynodriveSettingTab } from 'ui/settingsTab';
import { SyncEngine } from 'sync';
import { debounce } from 'utils/debounce';
import { ConnectPayload } from 'ui/connectModal';

export default class SynodrivePlugin extends Plugin {
  settings: SynodriveSettings = DEFAULT_SETTINGS;
  logger!: DiagnosticsLogger;
  client!: DriveClient;
  sessionStore!: SecureSessionStore;
  syncEngine!: SyncEngine;
  private changedPaths = new Set<string>();
  private debouncedEventSync: () => void = () => undefined;
  private backgroundIntervalId: number | null = null;

  async onload() {
    this.logger = new DiagnosticsLogger();
    this.client = new DriveClient(DEFAULT_SETTINGS.serverBaseUrl, this.logger, {
      timeoutSeconds: DEFAULT_SETTINGS.timeoutSeconds,
      chunkMb: DEFAULT_SETTINGS.chunkMb,
      debug: DEFAULT_SETTINGS.debug,
    });
    this.sessionStore = new SecureSessionStore(
      this,
      this.logger,
      () => this.settings,
      async (settings) => {
        this.settings = settings;
        await this.saveSettings();
      },
    );
    this.syncEngine = new SyncEngine(this.app, DEFAULT_SETTINGS, this.client, this.logger);
    this.debouncedEventSync = debounce(() => this.triggerSync("event"), 2000);

    await this.loadSettings();
    this.logger.info("Synodrive starting");
    try {
      this.client.setBaseUrl(this.settings.serverBaseUrl);
    } catch (err) {
      this.logger.warn(`Set a valid HTTPS server URL to sync: ${(err as Error).message}`);
    }
    this.syncEngine.updateSettings(this.settings);
    await this.restoreSession();

    this.addSettingTab(new SynodriveSettingTab(this.app, this));
    this.registerCommands();
    this.registerRibbon();
    this.registerEvents();
    this.configureBackgroundSync();
  }

  onunload() {
    if (this.backgroundIntervalId) {
      window.clearInterval(this.backgroundIntervalId);
      this.backgroundIntervalId = null;
    }
  }

  async connect(payload: ConnectPayload) {
    try {
      const sid = await this.client.login(payload);
      const encryptedSid = await this.sessionStore.encrypt(sid);
      this.settings.serverBaseUrl = payload.serverBaseUrl;
      this.settings.username = payload.username;
      this.settings.session = {
        encryptedSid,
        username: payload.username,
        serverBaseUrl: payload.serverBaseUrl,
        sidExpiresAt: null,
      };
      await this.saveSettings();
      new Notice("Connected to Synology Drive");
      await this.triggerSync("manual");
    } catch (err) {
      new Notice(`Connection failed: ${(err as Error).message}`);
      this.logger.error(`Login failed: ${(err as Error).message}`);
    }
  }

  async disconnect() {
    await this.client.logout();
    this.settings.session = undefined;
    await this.saveSettings();
  }

  async triggerSync(mode: "manual" | "background" | "event" = "manual") {
    const quickPaths = Array.from(this.changedPaths);
    this.changedPaths.clear();
    const result = await this.syncEngine.sync({ mode, quickPaths });
    if (result?.skippedDeletes) {
      const msg = "Delete limit hit (20); review before retrying.";
      new Notice(msg);
      this.logger.warn(msg);
    }
  }

  toggleBackgroundSync() {
    this.settings.backgroundSync = !this.settings.backgroundSync;
    if (!this.settings.backgroundSync) {
      this.settings.intervalMinutes = 0;
    } else if (this.settings.intervalMinutes === 0) {
      this.settings.intervalMinutes = DEFAULT_SETTINGS.intervalMinutes;
    }
    this.configureBackgroundSync();
    this.saveSettings();
    new Notice(`Background sync ${this.settings.backgroundSync ? "enabled" : "disabled"}`);
  }

  configureBackgroundSync() {
    if (this.backgroundIntervalId) {
      window.clearInterval(this.backgroundIntervalId);
      this.backgroundIntervalId = null;
    }
    if (this.settings.backgroundSync && this.settings.intervalMinutes > 0) {
      const intervalMs = this.settings.intervalMinutes * 60 * 1000;
      this.backgroundIntervalId = window.setInterval(() => this.triggerSync("background"), intervalMs);
      this.registerInterval(this.backgroundIntervalId);
    }
  }

  async exportLogs() {
    await this.logger.exportToFile(this);
    new Notice("Logs exported to plugin folder");
  }

  openSettings() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.app as any).setting?.open?.();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.app as any).setting?.openTabById?.(this.manifest.id);
  }

  async showLastSyncReport() {
    const report = this.settings.lastSyncReport;
    if (!report) {
      new Notice("No sync report yet");
      return;
    }
    const summary = Object.entries(report.summary)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");
    new Notice(`Last sync at ${new Date(report.ranAt).toLocaleString()} (${Math.round(report.durationMs)} ms): ${summary}`);
  }

  private registerRibbon() {
    const ribbon = this.addRibbonIcon("cloud", "Synodrive menu", (evt) => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("Sync now").setIcon("refresh-ccw").onClick(() => this.triggerSync("manual")));
      menu.addItem((item) =>
        item
          .setTitle(this.settings.backgroundSync ? "Disable background sync" : "Enable background sync")
          .setIcon("clock")
          .onClick(() => this.toggleBackgroundSync()),
      );
      menu.addItem((item) => item.setTitle("Open settings").setIcon("settings").onClick(() => this.openSettings()));
      menu.showAtMouseEvent(evt);
    });
    ribbon.addClass("synodrive-ribbon");
  }

  private registerCommands() {
    this.addCommand({
      id: "synodrive-connect",
      name: "Connect to Synology Drive",
      callback: () =>
        import("./ui/connectModal").then(({ ConnectModal }) => {
          new ConnectModal(this.app, async (payload) => {
            await this.connect(payload);
          }).open();
        }),
    });

    this.addCommand({
      id: "synodrive-disconnect",
      name: "Disconnect from Synology Drive",
      callback: () => this.disconnect(),
    });

    this.addCommand({
      id: "synodrive-sync-now",
      name: "Sync Now",
      callback: () => this.triggerSync("manual"),
    });

    this.addCommand({
      id: "synodrive-toggle-background",
      name: "Toggle Background Sync",
      callback: () => this.toggleBackgroundSync(),
    });

    this.addCommand({
      id: "synodrive-show-last-report",
      name: "Show Last Sync Report",
      callback: () => this.showLastSyncReport(),
    });
  }

  private registerEvents() {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.changedPaths.add(file.path);
        this.debouncedEventSync();
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.changedPaths.add(file.path);
        this.debouncedEventSync();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.changedPaths.add((file as TAbstractFile).path);
        this.debouncedEventSync();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.changedPaths.add(oldPath);
        this.changedPaths.add(file.path);
        this.debouncedEventSync();
      }),
    );
  }

  private async restoreSession() {
    if (!this.settings.session?.encryptedSid) return;
    const sid = await this.sessionStore.decrypt(this.settings.session.encryptedSid);
    if (sid) {
      this.client.setSid(sid);
      const valid = await this.client.validate();
      if (!valid) {
        this.logger.warn("Cached session expired");
        this.client.setSid(null);
      }
    }
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    if (!this.settings.exclusions || this.settings.exclusions.length === 0) {
      this.settings.exclusions = DEFAULT_SETTINGS.exclusions;
    }
    this.logger = this.logger ?? new DiagnosticsLogger();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.client) {
      try {
        this.client.setBaseUrl(this.settings.serverBaseUrl);
        this.client.setDebug(this.settings.debug);
      } catch (err) {
        this.logger.warn(`Could not apply server URL: ${(err as Error).message}`);
      }
    }
    if (this.syncEngine) {
      this.syncEngine.updateSettings(this.settings);
    }
  }
}
