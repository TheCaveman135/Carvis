# Carvis for Even Realities G2

The default build contains the full Carvis glasses and phone interface. Configure **Assistant engine**, **Even Realities**, **Voice conversation** (for microphone input), and **Speech output** (for spoken replies) in your Carvis installation. The companion starts with blank connection settings and the microphone muted.

```sh
npm ci
CARVIS_PUBLIC_URL=https://your-carvis.example npm run pack
```

Upload `carvis.ehpk` to Even Hub. Enter your server address and pairing token on the phone. Never commit local package manifests or pairing credentials.

`npm run dev` serves the full companion. `npm run build:basic` and `npm run pack:basic` build the smaller core-only companion from `basic/`; it has its own package identifier and no phone speech output.

See [the integration guide](../../docs/integrations-even-realities.md) for setup, controls, dependencies, limitations, and validation.
