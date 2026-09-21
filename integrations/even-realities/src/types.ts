export type Action = {
  slot: number;
  widgetId: string;
  value?: number;
  index?: number;
};
export type Control = {
  kind: "button" | "slider" | "dropdown";
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
  index: number;
  options: { label: string }[];
};
export type Widget = {
  id: string;
  slot: number;
  display: { title: string; value: string; blank: boolean };
  interaction: Control | null;
};
export type Hud = {
  revision: number;
  slots: (Widget | null)[];
  reply: string;
  replyExpires: number;
  voiceEnabled: boolean;
};
export type Confirmation = { id: string; summary: string; expiresAt?: number };
export type Result = {
  hud?: Hud;
  reply?: string;
  transcript?: string;
  conversationId?: string;
  error?: string;
  success?: boolean;
  requiresConfirmation?: boolean;
  confirmation?: Confirmation;
  confirmations?: Confirmation[];
  dryRun?: boolean;
};
