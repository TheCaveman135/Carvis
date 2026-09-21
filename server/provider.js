import { endpoint } from "./validation.js";

export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 4_000_000)
      throw Error("Model stream exceeded the buffer limit.");
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        yield { type: "done" };
        continue;
      }
      yield JSON.parse(data);
    }
  }
  if (buffer.trim()) {
    const data = buffer
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data && data !== "[DONE]") yield JSON.parse(data);
  }
}
export async function modelRound({
  config,
  system,
  messages,
  tools,
  onDelta = () => {},
  signal,
  fetcher = fetch,
}) {
  if (!config.model?.trim())
    throw Error("Choose your model in Settings before chatting.");
  if (config.provider === "openai" && !config.apiKey)
    throw Error("Add your API key in Settings before chatting.");
  const responses = config.provider === "openai";
  const body = responses
    ? {
        model: config.model,
        instructions: system,
        input: messages,
        store: false,
        include: ["reasoning.encrypted_content"],
        stream: true,
        max_output_tokens: 4096,
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: false,
        })),
      }
    : {
        model: config.model,
        messages: [{ role: "system", content: system }, ...messages],
        stream: true,
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
      };
  const response = await fetcher(
    `${endpoint(config.baseUrl)}/${responses ? "responses" : "chat/completions"}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
      redirect: "error",
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(
      response.status === 401
        ? "The model provider rejected your API key. Check Settings."
        : `The model provider returned HTTP ${response.status}. Check your endpoint and model settings.`,
    );
  }
  let text = "",
    completed = false,
    output = [],
    calls = new Map(),
    usage = null;
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    throw Error(
      "The model endpoint did not return a supported streaming response.",
    );
  for await (const event of sseEvents(response.body)) {
    if (responses) {
      if (event.type === "response.output_text.delta") {
        text += event.delta;
        onDelta(event.delta);
      }
      if (
        ["response.failed", "response.incomplete", "error"].includes(event.type)
      )
        throw Error(
          "The model could not finish this response. No incomplete tool calls were executed.",
        );
      if (event.type === "response.completed") {
        completed = true;
        output = event.response.output || [];
        usage = event.response.usage;
      }
    } else {
      if (event.error)
        throw Error("The model provider returned a stream error.");
      const choice = event.choices?.[0],
        delta = choice?.delta;
      if (delta?.content) {
        text += delta.content;
        onDelta(delta.content);
      }
      for (const call of delta?.tool_calls || []) {
        const old = calls.get(call.index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (call.id) old.id = call.id;
        if (call.function?.name) old.function.name += call.function.name;
        if (call.function?.arguments)
          old.function.arguments += call.function.arguments;
        calls.set(call.index, old);
      }
      if (
        choice?.finish_reason === "length" ||
        choice?.finish_reason === "content_filter"
      )
        throw Error(
          "The model response was cut short. No incomplete tool calls were executed.",
        );
      if (choice?.finish_reason) completed = true;
      usage = event.usage || usage;
    }
  }
  if (!completed)
    throw Error("Connection ended before the model completed its response.");
  const toolCalls = responses
    ? output
        .filter((i) => i.type === "function_call")
        .map((i) => ({ id: i.call_id, name: i.name, arguments: i.arguments }))
    : [...calls.values()].map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      }));
  return {
    text,
    toolCalls,
    usage,
    append: responses
      ? output
      : [
          {
            role: "assistant",
            content: text || null,
            ...(toolCalls.length ? { tool_calls: [...calls.values()] } : {}),
          },
        ],
  };
}
export function toolOutput(provider, id, result) {
  return provider === "openai"
    ? {
        type: "function_call_output",
        call_id: id,
        output: JSON.stringify(result),
      }
    : { role: "tool", tool_call_id: id, content: JSON.stringify(result) };
}
