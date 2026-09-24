import { el, icon, button, errorText, input, formNotice } from "./ui.js";
import { entityStateDisplay } from "./entity-state.js";

export function createEntitySelector({ api }) {
  function makeEntitySelector(
    config,
    allowedTypes = () => config.agent__allowedDomains || [],
  ) {
    const observed = new Set(config.observed || []),
      controlled = new Set(config.controlled || []),
      guards = { ...(config.guards || {}) },
      selected = new Set();
    const list = el("div", { class: "entity-table-scroll" }),
      rooms = el("div", {
        class: "entity-rooms",
        role: "group",
        "aria-label": "Filter by room",
      }),
      count = el("p", { class: "entity-count" }),
      heading = el("h3"),
      feedback = el("div");
    const search = input("entity-search", "", "search", {
      placeholder: "Search entities…",
      "aria-label": "Search entities",
    });
    const type = el(
      "select",
      { "aria-label": "Filter entity type" },
      el("option", { value: "" }, "All types"),
    );
    const only = input("entities-selected", "", "checkbox");
    const showOther = input("entities-other-types", "", "checkbox");
    const canControl = (id) => allowedTypes().includes(id.split(".")[0]);
    // Cameras are observation sources, not controllable device types. Keep them
    // discoverable, along with entities whose existing access can be revoked.
    const shownByDefault = (id) =>
      canControl(id) ||
      id.startsWith("camera.") ||
      observed.has(id) ||
      controlled.has(id);
    let entities = [],
      loaded = false,
      room = "*";
    const label = (value) =>
      String(value || "")
        .replaceAll("_", " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    const domainIcon = (domain) =>
      ({
        media_player: "tv",
        camera: "glasses",
        lock: "lock",
        switch: "plug",
        light: "spark",
        sensor: "info",
        binary_sensor: "info",
      })[domain] || "grid";
    const visible = () =>
      entities.filter(
        (e) =>
          (showOther.checked || shownByDefault(e.entity_id)) &&
          (room === "*" || (e.area_id || "") === room) &&
          (!type.value || e.domain === type.value) &&
          (!only.checked || observed.has(e.entity_id)) &&
          `${e.name} ${e.entity_id} ${e.area_name || ""}`
            .toLowerCase()
            .includes(search.value.toLowerCase()),
      );
    function setPermission(id, action) {
      if (action === "observe") observed.add(id);
      if (action === "control" && canControl(id)) {
        observed.add(id);
        controlled.add(id);
      }
      if (action === "hide") {
        observed.delete(id);
        controlled.delete(id);
        delete guards[id];
      }
      if (action === "stop-control") {
        controlled.delete(id);
        delete guards[id];
      }
      if (action === "protected" && controlled.has(id))
        guards[id] = "protected";
      if (action === "auto") delete guards[id];
    }
    const bulk = el(
      "select",
      { "aria-label": "Bulk permission action" },
      el("option", { value: "" }, "Bulk actions…"),
      ...[
        ["observe", "Allow observation"],
        ["control", "Allow interaction"],
        ["stop-control", "Remove interaction"],
        ["hide", "Hide from Carvis"],
        ["protected", "Require confirmation"],
        ["auto", "Use automatic guards"],
      ].map(([value, text]) => el("option", { value }, text)),
    );
    bulk.addEventListener("change", () => {
      if (!bulk.value) return;
      for (const e of visible())
        if (selected.has(e.entity_id)) setPermission(e.entity_id, bulk.value);
      bulk.value = "";
      render();
    });
    const selectAll = button(
      "Select all shown",
      () => {
        const rows = visible(),
          all = rows.length && rows.every((e) => selected.has(e.entity_id));
        for (const e of rows)
          all ? selected.delete(e.entity_id) : selected.add(e.entity_id);
        render();
      },
      "compact",
    );
    function render() {
      const typeValue = type.value;
      const types = [
        ...new Set(
          entities
            .filter((e) => showOther.checked || shownByDefault(e.entity_id))
            .map((e) => e.domain),
        ),
      ].sort();
      type.replaceChildren(
        el("option", { value: "" }, "All shown types"),
        ...types.map((value) => el("option", { value }, label(value))),
      );
      type.value = types.includes(typeValue) ? typeValue : "";
      const matches = visible();
      count.textContent = `${matches.length} entities · ${observed.size} observed · ${[...controlled].filter(canControl).length} interactive · ${matches.filter((e) => selected.has(e.entity_id)).length} marked for bulk edits`;
      heading.textContent =
        room === "*"
          ? "All rooms"
          : room === ""
            ? "Unassigned"
            : entities.find((e) => e.area_id === room)?.area_name || room;
      rooms.replaceChildren();
      const areas = new Map(
        entities
          .filter((e) => e.area_id)
          .map((e) => [e.area_id, e.area_name || e.area_id]),
      );
      for (const [id, name] of [
        ["*", "All rooms"],
        ...[...areas].sort((a, b) => a[1].localeCompare(b[1])),
        ...(entities.some((e) => !e.area_id) ? [["", "Unassigned"]] : []),
      ]) {
        const b = button(
          name,
          () => {
            room = id;
            render();
          },
          "entity-room",
        );
        b.prepend(icon(id === "*" ? "grid" : "home"));
        b.setAttribute("aria-pressed", String(room === id));
        rooms.append(b);
      }
      selectAll.textContent =
        matches.length && matches.every((e) => selected.has(e.entity_id))
          ? "Clear selection"
          : "Select all shown";
      selectAll.disabled = !matches.length;
      bulk.disabled = !matches.some((e) => selected.has(e.entity_id));
      list.replaceChildren();
      if (!matches.length) {
        list.append(
          el(
            "p",
            { class: "empty-card" },
            loaded
              ? "No entities match these filters."
              : "Save your connection to see entities automatically.",
          ),
        );
        return;
      }
      const table = el("table", { class: "entity-table" }),
        body = el("tbody");
      table.append(
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            ...[
              "Bulk edit",
              "Entity",
              "Type",
              "State",
              "Observe",
              "Interact",
              "Guard",
            ].map((s, i) =>
              el(
                "th",
                { scope: "col" },
                s,
                ...(i >= 4
                  ? [
                      el(
                        "small",
                        {},
                        [
                          "Can view state",
                          "Can control",
                          "Confirmation policy",
                        ][i - 4],
                      ),
                    ]
                  : []),
              ),
            ),
          ),
        ),
        body,
      );
      for (const e of matches) {
        const id = e.entity_id,
          name = e.name || id;
        const stateDisplay = entityStateDisplay(e);
        const mark = input(`mark-${id}`, "", "checkbox", {
          checked: selected.has(id),
          "aria-label": `Select ${name} for bulk edits`,
        });
        mark.addEventListener("change", () => {
          mark.checked ? selected.add(id) : selected.delete(id);
          render();
        });
        const see = input(`observe-${id}`, "", "checkbox", {
          checked: observed.has(id),
          "aria-label": `Let Carvis see ${name}`,
        });
        see.addEventListener("change", () => {
          setPermission(id, see.checked ? "observe" : "hide");
          render();
        });
        const control = input(`control-${id}`, "", "checkbox", {
          checked: controlled.has(id),
          "aria-label": `Let Carvis control ${name}`,
          disabled: !canControl(id),
          title: canControl(id)
            ? ""
            : "This device type is not allowed for control",
        });
        control.addEventListener("change", () => {
          setPermission(id, control.checked ? "control" : "stop-control");
          render();
        });
        const guard = el(
          "select",
          {
            "aria-label": `Confirmation for ${name}`,
            disabled: !controlled.has(id) || !canControl(id),
          },
          ...[
            [
              "",
              e.defaultGuard === "critical"
                ? "Auto – Critical"
                : e.defaultGuard === "standard"
                  ? "Auto – Standard"
                  : "Auto – Unavailable",
            ],
            ["standard", "Standard"],
            ["protected", "Require confirmation"],
          ].map(([value, text]) =>
            el(
              "option",
              { value, selected: (guards[id] || "") === value },
              text,
            ),
          ),
        );
        guard.addEventListener("change", () => {
          if (guard.value) guards[id] = guard.value;
          else delete guards[id];
        });
        body.append(
          el(
            "tr",
            { "data-selected": selected.has(id) ? "true" : "false" },
            el("td", {}, mark),
            el(
              "td",
              {},
              el(
                "div",
                { class: "entity-name-cell" },
                icon(domainIcon(e.domain)),
                el("div", {}, el("strong", {}, name), el("small", {}, id)),
              ),
            ),
            el("td", {}, label(e.domain)),
            el(
              "td",
              {},
              el(
                "span",
                {
                  class: `entity-state ${e.state === "on" ? "is-on" : ""}`,
                  title: stateDisplay.title || "",
                },
                e.state == null
                  ? "Unavailable"
                  : stateDisplay.title
                    ? stateDisplay.text
                  : `${label(e.state)}${e.unit ? " " + e.unit : ""}`,
              ),
            ),
            el("td", {}, see),
            el(
              "td",
              {},
              control,
              !canControl(id)
                ? el(
                    "small",
                    { class: "muted" },
                    e.domain === "camera" ? "Observe only" : "Type blocked",
                  )
                : null,
            ),
            el("td", {}, guard),
          ),
        );
      }
      list.append(table);
    }
    const load = button(
      "Refresh entities",
      async () => {
        load.disabled = true;
        feedback.replaceChildren();
        try {
          const result = await api("/api/home-assistant/entities");
          entities = (result.entities || []).map((e) => ({
            ...e,
            domain: e.domain || e.entity_id.split(".")[0],
          }));
          const known = new Set(entities.map((e) => e.entity_id));
          for (const id of observed)
            if (!known.has(id))
              entities.push({
                entity_id: id,
                name: id,
                domain: id.split(".")[0],
                state: "unavailable",
              });
          loaded = true;
          load.hidden = false;
          const current = type.value;
          type.replaceChildren(
            el("option", { value: "" }, "All types"),
            ...[...new Set(entities.map((e) => e.domain))]
              .sort()
              .map((value) => el("option", { value }, label(value))),
          );
          type.value = current;
          if (
            room !== "*" &&
            room !== "" &&
            !entities.some((e) => e.area_id === room)
          )
            room = "*";
          if (result.areaWarning) formNotice(feedback, result.areaWarning);
          load.textContent = "Refresh entities";
          render();
        } catch (error) {
          formNotice(feedback, errorText(error));
        } finally {
          load.disabled = false;
        }
      },
      "compact",
      "refresh",
    );
    load.hidden = true;
    search.addEventListener("input", render);
    type.addEventListener("change", render);
    only.addEventListener("change", render);
    showOther.addEventListener("change", render);
    render();
    if (config.baseUrl && (config.hasToken || config.token))
      queueMicrotask(() => load.click());
    return {
      node: el(
        "section",
        { class: "entity-section entity-manager" },
        el(
          "div",
          { class: "entity-manager-title" },
          icon("home"),
          el(
            "div",
            {},
            el("h3", {}, "Entity management"),
            el(
              "p",
              { class: "small muted" },
              "Choose what Carvis can see and control. Changes save automatically.",
            ),
          ),
          load,
        ),
        rooms,
        el(
          "div",
          { class: "entity-filterbar" },
          search,
          type,
          el("label", { class: "check-label" }, only, "Observed entities only"),
          el(
            "label",
            { class: "check-label" },
            showOther,
            "Show other types (observe only)",
          ),
        ),
        feedback,
        el(
          "div",
          { class: "entity-table-heading" },
          el("div", {}, heading, count),
          el("div", { class: "action-row" }, selectAll, bulk),
        ),
        list,
        el(
          "p",
          { class: "small muted" },
          "Rooms come from Home Assistant. State is a read-only snapshot. Unobserved entities remain hidden from Carvis. Guards keep the existing Auto, Standard, and Require confirmation behavior.",
        ),
      ),
      refresh: render,
      reload: () => load.click(),
      value: () => ({
        observed: [...observed],
        controlled: [...controlled],
        guards,
      }),
    };
  }

  return { makeEntitySelector };
}
