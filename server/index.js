import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp, VERSION } from "./app.js";

// Keep the public factory import compatible while separating startup from HTTP routing.
export { createApp } from "./app.js";

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { server, registry } = await createApp();
  const port = Number(process.env.PORT || 8788),
    host = process.env.HOST || "127.0.0.1";
  const addresses = [
    ...new Set(
      (process.env.CARVIS_LISTEN_HOSTS || host)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  let shuttingDown = false;
  const retryTimers = new Set();
  const servers = addresses.map((address, index) => {
    const listener = index
      ? http.createServer(server.listeners("request")[0])
      : server;
    const listen = () => {
      if (!shuttingDown) listener.listen(port, address);
    };
    listener.on("listening", () =>
      console.log(`Carvis ${VERSION} is ready at http://${address}:${port}`),
    );
    listener.on("error", (error) => {
      if (error.code === "EADDRNOTAVAIL" && !shuttingDown) {
        // A configured VPN interface can appear after the service starts.
        // Keep available interfaces serving while waiting for that address.
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          listen();
        }, 5000);
        retryTimers.add(timer);
        return;
      }
      console.error(
        `Carvis could not listen on ${address}:${port}: ${error.message}`,
      );
      process.exitCode = 1;
      process.emit("SIGTERM");
    });
    listen();
    return listener;
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const timer of retryTimers) clearTimeout(timer);
      const timeout = setTimeout(() => process.exit(0), 5000);
      timeout.unref();
      await registry.close();
      await Promise.all(
        servers.map(
          (listener) =>
            new Promise((resolve) => {
              listener.close(resolve);
              listener.closeAllConnections();
            }),
        ),
      );
      process.exit(process.exitCode || 0);
    });
}
