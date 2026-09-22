import { validateConfig } from "./config.js";

export async function haRequest(ctx, path, body) {
  const config = validateConfig(ctx.config);
  const response = await ctx.fetch(`${config.baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      `Home Assistant request failed (${response.status}).${response.status === 401 ? " Check the access token." : ""}`,
    );
  return response.json();
}
