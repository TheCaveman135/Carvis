/** Generic runtime defaults. No services are enabled until configured by their integration. */
export const DEFAULTS = {
  "server": {
    "host": "127.0.0.1",
    "port": 0
  },
  "auth": {
    "username": "",
    "passwordHash": "",
    "sessionSecret": ""
  },
  "ha": {
    "url": "",
    "token": "",
    "allowInsecureTls": false
  },
  "ollama": {
    "url": "",
    "model": "",
    "temperature": 0.2,
    "numCtx": 8192,
    "timeoutSec": 120,
    "keepAlive": "30m",
    "think": false
  },
  "models": {
    "providers": [
      {
        "id": "ollama",
        "kind": "ollama",
        "label": "Ollama (local)",
        "baseUrl": "",
        "apiKeyEnv": "",
        "local": true
      },
      {
        "id": "openai",
        "kind": "openai",
        "label": "OpenAI",
        "baseUrl": "",
        "apiKeyEnv": "OPENAI_API_KEY"
      },
      {
        "id": "anthropic",
        "kind": "anthropic",
        "label": "Claude",
        "baseUrl": "",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      },
      {
        "id": "lmstudio",
        "kind": "openai",
        "label": "LM Studio",
        "baseUrl": "",
        "apiKeyEnv": "",
        "local": true
      }
    ],
    "pricing": {},
    "roles": {
      "triage": {
        "provider": "ollama",
        "model": "",
        "temperature": 0,
        "effort": "low",
        "maxTokens": 512
      },
      "carvis": {
        "provider": "openai",
        "model": "",
        "maxTokens": 4096
      },
      "vision": {
        "provider": "openai",
        "model": "",
        "effort": "low",
        "maxTokens": 1800,
        "timeoutSec": 35
      },
      "escalation": {
        "provider": "openai",
        "model": "",
        "maxTokens": 8192
      },
      "chat": {
        "provider": "openai",
        "model": "",
        "maxTokens": 8192
      },
      "rule": {
        "provider": "ollama",
        "model": "",
        "temperature": 0.1,
        "maxTokens": 512
      }
    }
  },
  "carvis": {
    "maxToolRounds": 10,
    "promptVersion": "carvis-v2",
    "personality": "Warm, concise, resourceful, and lightly witty. Be clear about uncertainty and never claim an action succeeded without evidence.",
    "escalate": false
  },
  "memory": {
    "maxItems": 500,
    "maxFactsPerTurn": 8,
    "maxChars": 240,
    "nearDuplicate": 0.8
  },
  "classifier": {
    "enabled": false,
    "proactivity": 0,
    "debounceSec": 20,
    "minImportance": 0.6,
    "minGapSec": 600
  },
  "tools": {
    "maxRisk": 2,
    "maxRiskByTrigger": {
      "user_voice": 3,
      "user_text": 3,
      "automation": 2,
      "home_event": 1,
      "system_event": 1
    }
  },
  "voice": {
    "enabled": false,
    "requireWakeWord": false,
    "wakeWords": [
      "carvis",
      "carvus",
      "carvas",
      "karvis",
      "jarvis"
    ],
    "historyTurns": 8,
    "minChars": 3,
    "dedupeWindowSec": 8,
    "confirmWithoutWakeWord": true,
    "confirmationTimeoutSec": 10,
    "coherenceCheck": true,
    "quietHoursConfirm": true,
    "quietHours": {
      "start": 23,
      "end": 7
    },
    "implicitIntents": false
  },
  "sessions": {
    "enabled": false,
    "idleMinutes": 20,
    "minMinutes": 5
  },
  "atlas": {
    "enabled": false,
    "endpoints": [],
    "baseUrl": "",
    "keychainService": "",
    "token": "",
    "captureOverheard": false,
    "completeTasks": false,
    "contextRefreshSec": 300
  },
  "mac": {
    "enabled": false,
    "deliver": "queue",
    "pushUrl": "",
    "pushToken": "",
    "queueMax": 50
  },
  "glasses": {
    "enabled": false,
    "token": "",
    "feedSize": 60,
    "proactive": false,
    "proactiveMinGapSec": 90
  },
  "stt": {
    "enabled": false,
    "engine": "",
    "model": "",
    "deepgramKey": "",
    "assemblyaiKey": "",
    "minMs": 400,
    "keyterms": []
  },
  "search": {
    "enabled": false,
    "model": "",
    "geminiKey": ""
  },
  "agent": {
    "dryRun": true,
    "cooldownSec": 180,
    "vacancyMinutes": 10,
    "respectManualOverrideSec": 900,
    "enforceOccupancyEnvelope": true,
    "allowedDomains": [
      "light",
      "switch",
      "fan",
      "input_boolean",
      "media_player",
      "scene",
      "script",
      "automation",
      "button",
      "input_button",
      "humidifier",
      "climate",
      "number",
      "input_number",
      "select",
      "input_select",
      "vacuum",
      "remote",
      "cover",
      "lock",
      "alarm_control_panel",
      "siren",
      "valve",
      "water_heater"
    ]
  },
  "speech": {
    "mediaPlayer": "",
    "ttsEntity": "",
    "autoReplies": false,
    "outputMode": "physical_then_ha"
  },
  "physicalCarvis": {
    "deviceToken": "",
    "staleAfterSec": 20
  },
  "entities": {
    "observed": [],
    "controlled": [],
    "guards": {}
  },
  "areaNotes": {},
  "integrations": {
    "assistant-engine": false,
    "voice": false,
    "speech": false,
    "protocols": false,
    "proactivity": false,
    "learned-memory": false,
    "cameras": false,
    "home-assistant": false,
    "apple-tv": false,
    "even-realities": false,
    "web-search": false,
    "atlas": false,
    "desktop": false,
    "physical-carvis": false
  },
  "appleTv": {
    "mediaPlayer": "",
    "remoteEntity": "",
    "addonSlug": "",
    "baseUrl": "",
    "token": "",
    "silentNavigation": true,
    "shortReplies": true
  },
  "liveVoice": {
    "baseUrl": "",
    "model": "",
    "voice": ""
  }
};
export const CONFIG_SECTIONS = Object.freeze(Object.keys(DEFAULTS).filter(key => !["server", "auth", "integrations"].includes(key)));
