import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  MenuContainerProperty,
  MenuItemProperty,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { Hud } from "./types";
import type { WidgetFocus } from "./focus";

export class Display {
  private started = false;
  private selection: number | null = null;
  private contents: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private timedOut = false;
  constructor(private bridge: EvenAppBridge) {}
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.timedOut)
      return Promise.reject(
        new Error(
          "Glasses connection timed out. Reopen the companion app to reconnect.",
        ),
      );
    // Serialize the bridge; a slow BLE call never overlaps a subsequent write.
    const work = this.chain.then(operation);
    this.chain = work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        this.timedOut = true;
        reject(
          new Error(
            "Glasses connection timed out. Reopen the companion app to reconnect.",
          ),
        );
      }, 8000);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }
  async render(hud: Hud, focus: WidgetFocus, caption: string) {
    focus.sync(hud);
    const contents = hud.slots.map((widget) =>
      !widget || widget.display.blank
        ? " "
        : [widget.display.title, focus.preview(widget) ?? widget.display.value]
            .filter(Boolean)
            .join("\n")
            .slice(0, 120),
    );
    contents.push(caption.slice(0, 180) || " ");
    const selected = focus.selected;
    await this.run(async () => {
      if (!this.started || selected !== this.selection) {
        const textObject = contents.map(
          (content, i) =>
            new TextContainerProperty({
              containerID: i + 1,
              containerName: `carvis${i + 1}`,
              xPosition: i === 4 ? 8 : Math.floor(i / 2) * 288,
              yPosition: i === 4 ? 204 : (i % 2) * 100,
              width: i === 4 ? 560 : 280,
              height: i === 4 ? 84 : 96,
              borderWidth: selected === i + 1 ? 2 : 0,
              borderColor: selected === i + 1 ? 15 : 0,
              paddingLength: 5,
              isEventCapture: i === 4 ? 1 : 0,
              content,
            }),
        );
        const menuObject = new MenuContainerProperty({
          menuItems: [
            new MenuItemProperty({ itemName: "Clear screen", itemID: 1 }),
          ],
        });
        const page = { containerTotalNum: 5, textObject, menuObject };
        if (!this.started) {
          const result = await this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer(page),
          );
          if (result !== 0)
            throw new Error(
              "Glasses display could not start. Reopen the companion app.",
            );
          this.started = true;
        } else if (
          !(await this.bridge.rebuildPageContainer(
            new RebuildPageContainer(page),
          ))
        )
          throw new Error("Glasses display did not update.");
      } else {
        for (let i = 0; i < contents.length; i++)
          if (contents[i] !== this.contents[i]) {
            const success = await this.bridge.textContainerUpgrade(
              new TextContainerUpgrade({
                containerID: i + 1,
                containerName: `carvis${i + 1}`,
                content: contents[i],
                contentOffset: 0,
                contentLength: 0,
              }),
            );
            if (!success) {
              this.selection = -1;
              throw new Error("Glasses display needs a refresh.");
            }
          }
      }
      this.contents = contents;
      this.selection = selected;
    });
  }
}
