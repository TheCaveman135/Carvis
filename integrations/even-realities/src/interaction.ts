import type { HudState, HudWidget } from "./client";
export type WidgetAction = {
  slot: number;
  widget_id: string;
  value?: number;
  index?: number;
};
export class WidgetFocus {
  selected: number | null = null;
  editing = false;
  value = 0;
  index = 0;
  private widgetId: string | undefined;
  clear() {
    this.selected = null;
    this.editing = false;
    this.widgetId = undefined;
  }
  sync(hud: HudState) {
    const w = this.selected ? hud.slots[this.selected - 1] : null;
    if (this.selected && (!w || w.widget_id !== this.widgetId)) this.clear();
  }
  swipe(direction: 1 | -1, hud: HudState) {
    this.sync(hud);
    const w = this.selected ? hud.slots[this.selected - 1] : null,
      c = w?.interaction;
    if (this.editing && c) {
      if (c.kind === "slider") {
        const n = (this.value - c.min) / c.step;
        this.value = Math.max(
          c.min,
          Math.min(
            c.max,
            Math.round(
              (c.min +
                (direction > 0
                  ? Math.floor(n + 0.00001) + 1
                  : Math.ceil(n - 0.00001) - 1) *
                  c.step) *
                10000,
            ) / 10000,
          ),
        );
      }
      if (c.kind === "dropdown")
        this.index =
          (this.index + direction + c.options.length) % c.options.length;
      return;
    }
    const slots = hud.slots.flatMap((w, i) => (w ? [i + 1] : []));
    if (!slots.length) {
      this.clear();
      return;
    }
    const at = this.selected ? slots.indexOf(this.selected) : -1;
    this.selected =
      at < 0
        ? direction > 0
          ? slots[0]
          : slots[slots.length - 1]
        : slots[(at + direction + slots.length) % slots.length];
    this.widgetId = hud.slots[this.selected! - 1]?.widget_id;
  }
  press(hud: HudState): WidgetAction | null {
    this.sync(hud);
    const w = this.selected ? hud.slots[this.selected - 1] : null,
      c = w?.interaction;
    if (!w || !c || !w.widget_id) return null;
    const action = { slot: w.slot, widget_id: w.widget_id };
    if (c.kind === "button") return action;
    if (!this.editing) {
      this.editing = true;
      if (c.kind === "slider") {
        const current = w.data.control_value ?? Number.parseFloat(w.data.value);
        this.value = Math.max(
          c.min,
          Math.min(
            c.max,
            Number.isFinite(current)
              ? Math.round((current - c.min) / c.step) * c.step + c.min
              : c.min,
          ),
        );
        this.value = Math.round(this.value * 10000) / 10000;
      }
      this.index = Math.max(
        0,
        w.data.control_index ??
          c.options?.findIndex((o) => o.label === w.data.value) ??
          0,
      );
      return null;
    }
    this.editing = false;
    return {
      ...action,
      ...(c.kind === "slider" ? { value: this.value } : { index: this.index }),
    };
  }
  preview(w: HudWidget | null): string | null {
    if (!this.editing || !w || w.slot !== this.selected) return null;
    return w.interaction?.kind === "slider"
      ? `${this.value}${w.interaction.field === "value" ? "" : "%"} · tap to set`
      : `${w.interaction?.options[this.index]?.label || ""} · tap to set`;
  }
}
