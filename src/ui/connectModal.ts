import { App, ButtonComponent, Modal, Setting, TextComponent } from "obsidian";

export interface ConnectPayload {
  serverBaseUrl: string;
  username: string;
  password: string;
  otp?: string;
}

export type ConnectHandler = (payload: ConnectPayload) => Promise<void>;

export class ConnectModal extends Modal {
  private values: ConnectPayload = { serverBaseUrl: "https://", username: "", password: "", otp: "" };

  constructor(app: App, private onSubmit: ConnectHandler) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Connect to Synology Drive" });

    new Setting(contentEl)
      .setName("Server URL")
      .setDesc("HTTPS URL to your DSM instance")
      .addText((text) =>
        text.setPlaceholder("https://nas.local:5001").setValue(this.values.serverBaseUrl).onChange((value) => {
          this.values.serverBaseUrl = value;
        }),
      );

    new Setting(contentEl)
      .setName("Username")
      .addText((text: TextComponent) =>
        text.setPlaceholder("admin").setValue(this.values.username).onChange((value) => {
          this.values.username = value;
        }),
      );

    new Setting(contentEl)
      .setName("Password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("••••••••").setValue(this.values.password).onChange((value) => {
          this.values.password = value;
        });
      });

    new Setting(contentEl)
      .setName("OTP (if enabled)")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.inputMode = "numeric";
        text.setPlaceholder("123456").setValue(this.values.otp ?? "").onChange((value) => {
          this.values.otp = value;
        });
      });

    const footer = contentEl.createDiv({ cls: "synodrive-modal-actions" });
    const connectButton = new ButtonComponent(footer)
      .setButtonText("Connect")
      .setCta()
      .onClick(async () => {
        connectButton.setDisabled(true);
        try {
          await this.onSubmit({ ...this.values });
          this.close();
        } catch (err) {
          const message = (err as Error).message || "Connection failed";
          // eslint-disable-next-line no-console
          console.error(message);
        } finally {
          connectButton.setDisabled(false);
        }
      });

    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });
  }
}
