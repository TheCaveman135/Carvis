import test from "node:test";
import assert from "node:assert/strict";
import { modelRound, sseEvents, toolOutput } from "../server/provider.js";
function response(events) {
  return new Response(
    events
      .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
test("Responses streams real text and preserves reasoning/function items for tool follow-up", async () => {
  const events = [
    { type: "response.output_text.delta", delta: "Hello" },
    {
      type: "response.completed",
      response: {
        output: [
          { type: "reasoning", encrypted_content: "fixture" },
          {
            type: "function_call",
            call_id: "c1",
            name: "test_read",
            arguments: "{}",
          },
        ],
      },
    },
  ];
  let sent,
    delta = "";
  const result = await modelRound({
    config: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "fixture",
      apiKey: "fixture",
    },
    system: "Test",
    messages: [],
    tools: [],
    onDelta: (s) => (delta += s),
    fetcher: async (_url, options) => {
      sent = JSON.parse(options.body);
      return response(events);
    },
  });
  assert.equal(sent.store, false);
  assert.equal(delta, "Hello");
  assert.equal(result.toolCalls[0].name, "test_read");
  assert.equal(result.append[0].encrypted_content, "fixture");
  assert.equal(
    toolOutput("openai", "c1", { success: true }).type,
    "function_call_output",
  );
});
test("compatible streams accumulate fragmented function arguments and reject incomplete responses", async () => {
  const config = {
    provider: "compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
  };
  const result = await modelRound({
    config,
    system: "Test",
    messages: [],
    tools: [],
    fetcher: async () =>
      response([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c1",
                    function: { name: "read", arguments: "{" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]",
      ]),
  });
  assert.equal(result.toolCalls[0].arguments, "{}");
  await assert.rejects(
    modelRound({
      config,
      system: "Test",
      messages: [],
      tools: [],
      fetcher: async () =>
        response([{ choices: [{ delta: { content: "partial" } }] }]),
    }),
    /before.*completed/,
  );
});
test("SSE parser handles multiline and chunk boundaries", async () => {
  const text = 'data: {"type":\r\ndata: "hello"}\r\n\r\n';
  async function* chunks() {
    for (const c of text) yield Buffer.from(c);
  }
  const events = [];
  for await (const e of sseEvents(chunks())) events.push(e);
  assert.deepEqual(events, [{ type: "hello" }]);
});
