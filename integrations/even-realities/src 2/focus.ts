import type { Action, Hud, Widget } from "./types";

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
  sync(hud: Hud) {
    const widget = this.selected ? hud.slots[this.selected - 1] : null;
    if (this.selected && (!widget || widget.id !== this.widgetId)) this.clear();
  }
  swipe(direction: 1 | -1, hud: Hud) {
    this.sync(hud);
    const widget = this.selected ? hud.slots[this.selected - 1] : null,
      control = widget?.interaction;
    if (this.editing && control) {
      if (control.kind === "slider")
        this.value =
          Math.round(
            Math.max(
              control.min,
              Math.min(control.max, this.value + direction * control.step),
            ) * 10000,
          ) / 10000;
      if (control.kind === "dropdown")
        this.index =
          (this.index + direction + control.options.length) %
          control.options.length;
      return;
    }
    const slots = hud.slots.flatMap((widget, i) => (widget ? [i + 1] : []));
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
    this.widgetId = hud.slots[this.selected! - 1]?.id;
  }
  press(hud: Hud): Action | null {
    this.sync(hud);
    const widget = this.selected ? hud.slots[this.selected - 1] : null,
      control = widget?.interaction;
    if (!widget || !control) return null;
    const action = { slot: widget.slot, widgetId: widget.id };
    if (control.kind === "button") return action;
    if (!this.editing) {
      this.editing = true;
      this.value = Math.max(
        control.min,
        Math.min(
          control.max,
          Math.round((control.value - control.min) / control.step) *
            control.step +
            control.min,
        ),
      );
      this.index = control.index ?? 0;
      return null;
    }
    this.editing = false;
    return {
      ...action,
      ...(control.kind === "slider"
        ? { value: this.value }
        : { index: this.index }),
    };
  }
  preview(widget: Widget | null) {
    if (!this.editing || !widget || widget.slot !== this.selected) return null;
    return widget.interaction?.kind === "slider"
      ? `${this.value}${widget.interaction.unit} · tap to set`
      : `${widget.interaction?.options[this.index]?.label ?? ""} · tap to set`;
  }
}
