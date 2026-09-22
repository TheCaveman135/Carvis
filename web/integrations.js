import {
  el,
  icon,
  button,
  toast,
  errorText,
  field,
  input,
  formNotice,
  pageHeading,
  paths,
} from "./ui.js";
import {
  createIntegrationMetadata,
  integrationPanelUrl,
  integrationMatchesSearch,
} from "./integration-metadata.js";
import { createIntegrationSettings } from "./integration-settings.js";

export function createIntegrationViews({
  state,
  api,
  act,
  navigate,
  refreshState,
  route,
}) {
  const {
    integrationDependencies,
    integrationStatus,
    integrationControlsMissing,
  } = createIntegrationMetadata({ getState: () => state.data });
  const { configureIntegration } = createIntegrationSettings({
    state,
    api,
    act,
    navigate,
    refreshState,
    integrationDependencies,
  });
  function integrationIcon(id) {
    return id.includes("home")
      ? "home"
      : id.includes("even") || id.includes("glass")
        ? "glasses"
        : id.includes("tv")
          ? "tv"
          : "plug";
  }

  function integrationCard(integration) {
    const status = integrationStatus(integration);
    return el(
      "article",
      { class: "integration-card", "data-integration": integration.id },
      el(
        "div",
        { class: "integration-top" },
        el(
          "div",
          { class: "integration-icon" },
          icon(
            paths[integration.icon]
              ? integration.icon
              : integrationIcon(integration.id),
          ),
        ),
        el(
          "div",
          { class: `integration-status ${status.tone}` },
          el("span", {
            class: `status-dot${status.tone === "off" ? " off" : status.tone === "attention" ? " attention" : ""}`,
          }),
          status.label,
        ),
      ),
      el("h3", {}, integration.name),
      el("p", {}, integration.description),

      el(
        "div",
        { class: "integration-footer" },
        el(
          "span",
          { class: "version" },
          integration.enabled ? "Ready to manage" : "Optional integration",
        ),
        button(
          integration.configured ? "Manage" : "Set up",
          () => navigate(`integrations/${integration.id}`),
          "compact",
          "arrow",
        ),
      ),
    );
  }

  function renderIntegrations(main) {
    const integrations = state.data.integrations || [],
      enabled = integrations.filter((item) => item.enabled).length;
    const needsAttention = integrations.filter(
      (item) => integrationStatus(item).tone === "attention",
    ).length;
    const search = input(
      "integration-search",
      state.integrationSearch || "",
      "search",
      {
        placeholder: "Find an integration or setting",
        "aria-label": "Search integrations and settings",
      },
    );
    const groups = el("div", { class: "integration-groups" }),
      resultCount = el("span", {
        class: "catalog-result-count",
        role: "status",
      });
    const filterButtons = [];
    const filterItems = [
      ["all", `All integrations · ${integrations.length}`],
      ["enabled", `Enabled · ${enabled}`],
      ["attention", `Needs attention · ${needsAttention}`],
    ];
    const renderGroups = () => {
      const query = search.value.trim().toLowerCase(),
        filter = state.integrationFilter || "all";
      const matches = integrations.filter((item) => {
        if (filter === "enabled" && !item.enabled) return false;
        if (
          filter === "attention" &&
          integrationStatus(item).tone !== "attention"
        )
          return false;
        return integrationMatchesSearch(item, query);
      });
      groups.replaceChildren();
      filterButtons.forEach(({ button: control, value }) => {
        control.classList.toggle("active", value === filter);
        control.setAttribute("aria-pressed", String(value === filter));
      });
      resultCount.textContent =
        query || filter !== "all"
          ? `${matches.length} ${matches.length === 1 ? "integration" : "integrations"}`
          : "";
      groups.append(
        el("div", { class: "integration-grid" }, matches.map(integrationCard)),
      );
      if (!matches.length)
        groups.append(
          el(
            "div",
            { class: "empty-card" },
            el(
              "h2",
              {},
              integrations.length
                ? "No matching integrations"
                : "A little room to grow",
            ),
            el(
              "p",
              {},
              integrations.length
                ? "Try another search or filter."
                : "Installed integrations will appear here, ready for you to configure.",
            ),
            integrations.length
              ? button(
                  "Reset filters",
                  () => {
                    search.value = "";
                    state.integrationSearch = "";
                    state.integrationFilter = "all";
                    renderGroups();
                  },
                  "quiet compact",
                )
              : null,
          ),
        );
    };
    const filters = el(
      "div",
      {
        class: "catalog-filters",
        role: "group",
        "aria-label": "Filter integrations",
      },
      filterItems.map(([value, label]) => {
        const control = button(
          label,
          () => {
            state.integrationFilter = value;
            renderGroups();
          },
          "catalog-filter",
        );
        filterButtons.push({ button: control, value });
        return control;
      }),
    );
    search.addEventListener("input", () => {
      state.integrationSearch = search.value;
      renderGroups();
    });
    main.replaceChildren(
      el(
        "section",
        { class: "page integrations-page" },
        pageHeading(
          "MAKE IT YOURS",
          "Integration center",
          "Expand your smart home controller with voice, visual control, memory, and more.",
        ),
        el(
          "div",
          { class: "integration-overview" },
          el(
            "div",
            {},
            el("span", { class: "overview-number" }, String(enabled)),
            el("span", { class: "overview-label" }, "integrations enabled"),
          ),
          el(
            "p",
            {},
            enabled
              ? "Your enabled integrations add tools and context to Carvis. Manage their setup, controls, and activity here."
              : "Your home is connected. Add the abilities you want to use.",
          ),
          el(
            "span",
            { class: "overview-total" },
            `${integrations.length} available`,
          ),
        ),
        el(
          "div",
          { class: "catalog-toolbar" },
          filters,
          el("div", { class: "catalog-search" }, icon("search"), search),
        ),
        resultCount,
        groups,
        el(
          "div",
          { class: "integration-banner" },
          icon("shield"),
          el(
            "div",
            {},
            el("h3", {}, "A capable assistant. Clear boundaries."),
            el(
              "p",
              {},
              "Integrations start disabled. You choose the connections, visible devices, and actions that need your confirmation.",
            ),
          ),
        ),
        el(
          "details",
          { class: "integration-help" },
          el("summary", {}, "How does Carvis grow?"),
          el(
            "p",
            {},
            "New abilities arrive through integrations. Each has its own setup, controls, and permissions. Your conversations, personality, and memory stay in one place.",
          ),
        ),
      ),
    );
    renderGroups();
  }

  async function renderIntegrationDetail(main, id, section, version) {
    const integration = state.data.integrations.find((item) => item.id === id);
    if (!integration) {
      navigate("integrations");
      return;
    }
    const controls = integration.controls;
    const labels = [
      ["overview", "Overview"],
      ["controls", "Controls"],
      ["settings", "Settings"],
      ["activity", "Activity"],
    ];
    if (!labels.some(([key]) => key === section)) section = "overview";
    let body = el("div", { class: "integration-detail-body" });
    const enabledToggle = input("integration-enabled", "", "checkbox", {
      checked: integration.enabled,
      "aria-label": `Enable ${integration.name}`,
    });
    const toggleFeedback = el("div");
    const toggleBar = el(
      "section",
      { class: "integration-quick-start" },
      el(
        "div",
        { class: "switch-row" },
        el(
          "div",
          {},
          el("strong", {}, "Enable integration"),
          el(
            "p",
            {},
            integration.enabled
              ? "Enabled — Carvis can use this integration."
              : "Disabled — finish setup below, then enable it.",
          ),
        ),
        el("label", { class: "switch" }, enabledToggle),
      ),
      toggleFeedback,
    );
    enabledToggle.addEventListener("change", async () => {
      enabledToggle.disabled = true;
      try {
        await api(`/api/integrations/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: { enabled: enabledToggle.checked },
        });
        await refreshState();
        await route();
        toast(
          `${integration.name} ${enabledToggle.checked ? "enabled" : "disabled"}.`,
        );
      } catch (error) {
        enabledToggle.checked = integration.enabled;
        formNotice(toggleFeedback, errorText(error));
      } finally {
        enabledToggle.disabled = false;
      }
    });
    main.replaceChildren(
      el(
        "section",
        { class: "page integration-detail" },
        button(
          "All integrations",
          () => navigate("integrations"),
          "quiet compact",
          "arrow",
        ),
        pageHeading("INTEGRATION", integration.name, integration.description),
        toggleBar,
        el(
          "nav",
          {
            class: "integration-detail-tabs",
            "aria-label": `${integration.name} sections`,
          },
          labels.map(([key, label]) =>
            el(
              "a",
              {
                href: `#integrations/${id}/${key}`,
                class: `button quiet${section === key ? " active" : ""}`,
                "aria-current": section === key ? "page" : null,
              },
              label,
            ),
          ),
        ),
        body,
      ),
    );
    if (section === "settings") {
      configureIntegration(integration, body);
      return;
    }
    if (section === "overview") {
      const dependencies = integrationDependencies(integration);
      const missingDependencies = dependencies.filter(
        (d) => !d.optional && !d.enabled,
      );
      if (missingDependencies.length)
        body.append(
          el(
            "section",
            { class: "control-card" },
            el("h2", {}, "Set up these first"),
            ...missingDependencies.map((d) =>
              el(
                "p",
                {},
                el(
                  "a",
                  {
                    href:
                      d.id === "home-assistant"
                        ? "#settings/home-assistant"
                        : `#integrations/${d.id}`,
                  },
                  d.name,
                ),
                " is required before you can enable this integration.",
              ),
            ),
          ),
        );
      const mainControls = el("section", {
        class: "integration-main-controls",
      });
      if (
        integration.enabled &&
        !integrationControlsMissing(integration).length &&
        controls?.module
      )
        body.append(el("h2", {}, "Quick controls"), mainControls);
      const setup = el("section", { class: "integration-inline-setup" });
      body.append(
        el(
          "h2",
          {},
          integration.enabled
            ? "Connection & preferences"
            : "Set up your integration",
        ),
        setup,
      );
      configureIntegration(integration, setup, { inline: true });
      body.append(
        el(
          "details",
          { class: "integration-help" },
          el("summary", {}, "Setup guide & requirements"),
          el("p", {}, "Home Assistant is configured centrally in Settings."),
          el(
            "ol",
            { class: "setup-steps" },
            (integration.setupSteps || []).map((step) => el("li", {}, step)),
          ),
        ),
      );
      if (
        !integration.enabled ||
        integrationControlsMissing(integration).length ||
        !controls?.module
      )
        return;
      body = mainControls;
      section = "controls";
    }
    const missing = integrationControlsMissing(integration);
    if (!integration.enabled || missing.length || !controls?.module) {
      body.append(
        el(
          "div",
          { class: "empty-card" },
          el(
            "h2",
            {},
            !integration.enabled
              ? "Set up this integration first"
              : "Controls are not available yet",
          ),
          el(
            "p",
            {},
            missing.length
              ? `Enable ${missing.map((item) => item.name).join(", ")} to use these controls.`
              : "Connection details and permissions are in Settings.",
          ),
          button(
            "Open settings",
            () => navigate(`integrations/${id}/settings`),
            "compact",
          ),
        ),
      );
      return;
    }
    const url = integrationPanelUrl(controls.module);
    if (!url || !url.endsWith(".js")) {
      body.append(
        el("p", {}, "This integration has an invalid controls module."),
      );
      return;
    }
    body.append(el("p", { class: "muted" }, "Loading…"));
    try {
      const module = await import(url);
      if (version !== state.navVersion) return;
      const abort = new AbortController();
      state.integrationCleanup = () => abort.abort();
      body.replaceChildren();
      const cleanup = await module.mount({
        root: body,
        integration,
        section,
        el,
        button,
        input,
        field,
        api,
        toast,
        signal: abort.signal,
        navigate,
        integrations: state.data.integrations,
      });
      if (version !== state.navVersion) {
        cleanup?.();
        return;
      }
      state.integrationCleanup = () => {
        abort.abort();
        cleanup?.();
      };
    } catch (error) {
      if (version === state.navVersion)
        body.replaceChildren(
          el("div", { class: "notice error" }, errorText(error)),
          button("Retry", () => route(), "compact"),
        );
    }
  }

  return { renderIntegrations, renderIntegrationDetail, configureIntegration };
}
