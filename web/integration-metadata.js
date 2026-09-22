export function createIntegrationMetadata({ getState }) {
  function integrationDependencies(integration, key = "dependsOn") {
    return (Array.isArray(integration[key]) ? integration[key] : []).map(
      (value) => {
        const id = typeof value === "string" ? value : value?.id;
        const dependency = [
          ...(getState().integrations || []),
          ...(getState().homeAssistant ? [getState().homeAssistant] : []),
        ].find((item) => item.id === id);
        return {
          id,
          name: dependency?.name || value?.label || id || "Unknown integration",
          enabled: Boolean(dependency?.enabled),
          optional: Boolean(value?.optional),
          integration: dependency,
        };
      },
    );
  }

  function integrationStatus(integration) {
    if (!integration.enabled) return { label: "Disabled", tone: "off" };
    if (
      integrationDependencies(integration).some(
        (item) => !item.optional && !item.enabled,
      )
    )
      return { label: "Enabled · dependency needed", tone: "attention" };
    const status =
      typeof integration.status === "object"
        ? integration.status?.state || integration.status?.status
        : integration.status;
    if (["error", "failed", "unavailable", "needs attention"].includes(status))
      return { label: "Enabled · needs attention", tone: "attention" };
    if (integration.configured === false)
      return { label: "Enabled · setup needed", tone: "attention" };
    return { label: "Enabled", tone: "on" };
  }

  function integrationControlsMissing(integration) {
    return [
      ...new Map(
        [
          ...integrationDependencies(integration),
          ...integrationDependencies({
            dependsOn: integration.controls?.dependsOn || [],
          }),
        ]
          .filter((item) => !item.optional && !item.enabled)
          .map((item) => [item.id, item]),
      ).values(),
    ];
  }

  return {
    integrationDependencies,
    integrationStatus,
    integrationControlsMissing,
  };
}
export function integrationPanelUrl(value, origin = window.location.origin) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, origin);
    if (
      url.origin !== origin ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function integrationMatchesSearch(integration, query) {
  const fields = (integration.fields || []).flatMap((field) => [
    field.label,
    field.description,
    field.help,
    typeof field.group === "string" ? field.group : field.group?.label,
    String(field.key || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replaceAll("__", " "),
  ]);
  const text = [integration.name, integration.description, ...fields]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return String(query)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

export function integrationFieldGroup(integration, definition) {
  if (definition.key === "agent__allowedDomains")
    return {
      id: "devices",
      label: "Devices & permissions",
      description:
        "Choose what Carvis can see, what it can control, and when it needs to ask.",
    };
  if (
    [
      "voice__inputDevice",
      "voice__inputMuted",
      "speech__outputMode",
      "speech__localDevice",
      "speech__mediaPlayer",
    ].includes(definition.key)
  )
    return {
      id: "connection",
      label: "Audio devices",
      description:
        "Devices on the Carvis server, plus your enabled integrations.",
    };
  const supplied = definition.group;
  const groupId = (value) =>
    String(value)
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const names = {
    carvis: "Assistant behavior",
    tools: "Tool execution",
    ollama: "Local models",
    models: "Model roles",
    voice: "Conversation",
    stt: "Speech recognition",
    liveVoice: "Live voice",
    speech: "Speech & speakers",
    classifier: "Proactive decisions",
    sessions: "Activity sessions",
    memory: "Continuity Memory",
    search: "Search provider",
    atlas: "Project connection",
    mac: "Desktop connection",
    physicalCarvis: "Device connection",
    agent: "Device behavior",
    glasses: "Display & gestures",
  };
  if (supplied && typeof supplied === "object")
    return {
      id: groupId(supplied.id || supplied.label || "general"),
      label:
        supplied.label ||
        supplied.title ||
        names[supplied.id] ||
        supplied.id ||
        "General",
      description:
        supplied.description || supplied.help || definition.groupHelp || "",
    };
  if (typeof supplied === "string" && supplied.trim())
    return {
      id: groupId(supplied),
      label:
        names[supplied] ||
        supplied.replace(/^./, (letter) => letter.toUpperCase()),
      description: definition.groupHelp || "",
    };
  const key = definition.key;
  if (integration.id === "home-assistant")
    return ["dryRun", "observed", "controlled", "guards"].includes(key)
      ? {
          id: "devices",
          label: "Devices & permissions",
          description:
            "Choose what Carvis can see, what it can control, and when it needs to ask.",
        }
      : {
          id: "connection",
          label: "Connection",
          description: "Use your own Home Assistant address and access token.",
        };
  if (integration.id === "apple-tv") {
    if (["silentNavigation", "shortReplies"].includes(key))
      return {
        id: "behavior",
        label: "Response behavior",
        description: "Choose how much Carvis says while you control the TV.",
      };
    if (key === "context")
      return {
        id: "context",
        label: "Context",
        description: "Give the controller useful preferences and guidance.",
      };
    return {
      id: "controller",
      label: "Controller",
      description:
        "Connect your AI TV controller and the selected TV entities.",
    };
  }
  if (integration.id === "even-realities")
    return key.startsWith("speech") || key === "microphoneEnabled"
      ? {
          id: "voice",
          label: "Voice input",
          description:
            "Optional speech recognition, using the provider you choose.",
        }
      : {
          id: "connection",
          label: "Connection",
          description: "Pair the glasses companion with your Carvis server.",
        };
  if (key.includes("__")) {
    const id = key.split("__")[0];
    return {
      id,
      label: id
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[-_]/g, " ")
        .replace(/^./, (letter) => letter.toUpperCase()),
      description: "",
    };
  }
  return { id: "general", label: "General", description: "" };
}

export function integrationFieldValue(definition, control) {
  const value = control.value,
    label = definition.label || definition.key;
  if (definition.type === "room-notes") return control.notes();
  if (definition.type === "password" && !value) return undefined;
  if (definition.type === "boolean") return control.checked;
  if (definition.type === "number") {
    if (value.trim() === "") return undefined;
    const number = Number(value),
      min = definition.min ?? definition.minimum,
      max = definition.max ?? definition.maximum;
    if (
      !Number.isFinite(number) ||
      (min !== undefined && number < min) ||
      (max !== undefined && number > max)
    )
      throw new Error(
        `${label}: enter a number${min !== undefined && max !== undefined ? ` between ${min} and ${max}` : " in the allowed range"}.`,
      );
    return number;
  }
  if (definition.type === "json") {
    if (!value.trim()) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(
        `${label}: enter valid JSON. Use double quotes around property names and text.`,
      );
    }
  }
  if (["string-array", "string_array"].includes(definition.type))
    return [
      ...new Set(
        value
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  if (definition.type === "entities")
    return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  return value;
}
