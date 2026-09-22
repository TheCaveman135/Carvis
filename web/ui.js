export const $ = (selector, root = document) => root.querySelector(selector);
export const sourceUrl = "https://github.com/TheCaveman135/Carvis";
export const paths = {
  search: "M21 21l-6-6M17 10a7 7 0 1 0-14 0 7 7 0 0 0 14 0Z",
  plus: "M12 5v14M5 12h14",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3ZM15.5 12a3.5 3.5 0 1 0-7 0 3.5 3.5 0 0 0 7 0Z",
  arrow: "M7 17 17 7M7 7h10v10",
  send: "M12 19V5M5 12l7-7 7 7",
  close: "m6 6 12 12M6 18 18 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  edit: "m16 3 5 5-12 12-6 1 1-6L16 3ZM14 5l5 5",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  lock: "M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
  check: "m5 12 4 4L19 6",
  book: "M12 5v16M3 3c4 0 6 0 9 2 3-2 5-2 9-2v16c-4 0-6 0-9 2-3-2-5-2-9-2V3Z",
  plan: "M8 3v4M16 3v4M3 10h18M3 5h18v16H3V5ZM7 14h3M14 14h3M7 18h3",
  home: "m3 10 9-7 9 7v11h-7v-7h-4v7H3V10Z",
  glasses: "M2 8h8v8H2zM14 8h8v8h-8zM10 11h4M2 8l2-4M22 8l-2-4",
  tv: "M3 5h18v13H3zM8 22h8M12 18v4",
  plug: "M8 3v5M16 3v5M5 8h14v4a7 7 0 0 1-14 0V8ZM12 19v3",
  exit: "M9 3H3v18h6M9 12h12m-5-5 5 5-5 5",
  stop: "M6 6h12v12H6z",
  info: "M12 17v-5M12 7v.01M22 12a10 10 0 1 0-20 0 10 10 0 0 0 20 0Z",
  copy: "M9 9h12v12H9zM15 9V3H3v12h6",
  refresh:
    "M20 4v6h-6M4 20v-6h6M5 9a8 8 0 0 1 13-5l2 6M4 14l2 6a8 8 0 0 0 13-5",
};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (
      ["checked", "disabled", "required", "selected", "hidden"].includes(key)
    )
      node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity))
    if (child != null)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  return node;
}

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name] || paths.plug);
  svg.append(path);
  return svg;
}

export function button(label, action, style = "", symbol) {
  return el(
    "button",
    { type: "button", class: `button ${style}`, onclick: action },
    symbol ? icon(symbol) : null,
    label,
  );
}

export function iconButton(label, symbol, action) {
  return el(
    "button",
    {
      type: "button",
      class: "icon-button",
      "aria-label": label,
      title: label,
      onclick: action,
    },
    icon(symbol),
  );
}

export function brand() {
  return el(
    "a",
    { href: "#home", class: "brand", "aria-label": "Carvis home" },
    el("span", { class: "brand-mark", "aria-hidden": true }, "c"),
    el("span", { class: "brand-name" }, "carvis"),
    el("span", { class: "brand-tag" }, "YOUR HOME"),
  );
}

export function toast(message, error = false) {
  const region = $("#toast-region");
  region.replaceChildren(
    el("div", { class: `toast${error ? " error" : ""}` }, message),
  );
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => region.replaceChildren(), error ? 9000 : 5000);
}

export function errorText(error) {
  return error?.message || "Something went wrong. Please try again.";
}

export function timeLabel(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function field(label, input, description) {
  return el(
    "label",
    { class: "field" },
    el("span", { class: "field-label" }, label),
    input,
    description ? el("p", { class: "field-description" }, description) : null,
  );
}

export function input(name, value = "", type = "text", attrs = {}) {
  return el("input", { name, type, value: value ?? "", ...attrs });
}

export function formNotice(container, message, success = false) {
  container.replaceChildren(
    el(
      "div",
      {
        class: success ? "form-success" : "form-error",
        role: success ? "status" : "alert",
      },
      message,
    ),
  );
}

export function pageHeading(eyebrow, title, description) {
  return el(
    "header",
    { class: "page-heading" },
    el(
      "div",
      {},
      el("div", { class: "eyebrow" }, eyebrow),
      el("h1", {}, title),
      el("p", {}, description),
    ),
  );
}

export function formattedText(text) {
  const container = el("div", { class: "message-content" });
  // Text is always constructed as text nodes. Model content never becomes HTML.
  const parts = String(text || "").split(/```(?:[^\n`]*)\n([\s\S]*?)```/g);
  parts.forEach((part, index) => {
    if (index % 2)
      container.append(el("pre", {}, el("code", {}, part.replace(/\n$/, ""))));
    else
      part
        .split(/(`[^`\n]+`)/g)
        .forEach((piece) =>
          container.append(
            piece.startsWith("`") && piece.endsWith("`")
              ? el("code", { class: "inline-code" }, piece.slice(1, -1))
              : document.createTextNode(piece),
          ),
        );
  });
  return container;
}
