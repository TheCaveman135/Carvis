import { validateConfig } from "./config.js";

export async function haRequest(ctx, path, body) {
  const config = validateConfig(ctx.config);
  let response;
  try {
    response = await ctx.fetch(`${config.baseUrl}${path}`, {
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
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    if (error?.name === "TimeoutError")
      throw Error("Home Assistant did not respond within 15 seconds. Check its address and connection.");
    throw Error("Could not reach Home Assistant. Check its address and connection.");
  }
  if (!response.ok)
    throw Error(
      `Home Assistant request failed (${response.status}).${response.status === 401 ? " Check the access token." : ""}`,
    );
  try {
    return await response.json();
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    throw Error("Home Assistant returned an unexpected response. Check that the address points to Home Assistant.");
  }
}
