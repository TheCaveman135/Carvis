# Carvis for Even Realities G2

The default build contains the full Carvis glasses and phone interface. Configure **Assistant engine**, **Even Realities**, **Voice conversation** (for microphone input), and **Speech output** (for spoken replies) in your Carvis installation. The companion starts with blank connection settings and the microphone muted.

```sh
npm ci
CARVIS_PUBLIC_URL=https://your-carvis.example npm run pack
```

Upload `carvis.ehpk` to Even Hub. Enter your server address and pairing token on the phone. Never commit local package manifests or pairing credentials.

`npm run dev` serves the full companion. `npm run build:basic` and `npm run pack:basic` build the smaller core-only companion from `basic/`; it has its own package identifier and no phone speech output.

See [the integration guide](../../docs/integrations-even-realities.md) for setup, controls, dependencies, limitations, and validation.

## Companion 1.2 / Carvis 0.3

The phone interface uses the same dark and green theme as Carvis, with Overview,
History, and Settings pages. Widget gestures, blank idle HUD, microphone settings,
and phone audio controls are unchanged. Pairing uses an integration token, never
an account password or an AI provider API key.

### Your network, your server

Use any network that lets your phone reach Carvis: a local network with HTTPS,
a private VPN, Tailscale Serve, or a hosted reverse proxy. Add its exact hostname to
`CARVIS_ALLOWED_HOSTS` in the server environment. Use the resulting HTTPS URL in
`CARVIS_PUBLIC_URL` when packing and in the companion connection settings.
Do not use a localhost address on the phone: that refers to the phone itself.

Even Hub requires exact network origins and does not support wildcards. Each
self-hosted installation therefore needs its own package with its chosen server
origin in the allowlist. A generic public package cannot connect directly to
arbitrary server addresses. The source manifest remains an unconfigured example; the
pack script writes the installation-specific manifest locally, without tokens.
See https://hub.evenrealities.com/docs/build/networking.
