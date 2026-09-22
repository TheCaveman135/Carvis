const OUTCOME_FIELDS = [
  "success",
  "accepted",
  "verified",
  "dryRun",
  "declined",
  "requiresConfirmation",
  "error",
  "message",
  "id",
  "status",
];

// Work backward so a long conversation does not allocate and filter its entire
// history on each model round. Return messages in their original order.
export function recentMessages(conversation) {
  const history = [];
  for (
    let i = conversation.messages.length - 1;
    i >= 0 && history.length < 24;
    i--
  ) {
    const message = conversation.messages[i];
    if (message.role === "user" || message.role === "assistant")
      history.push(message);
  }
  return history.reverse();
}

function executionRecord(message) {
  const event = message.event;
  return {
    type: "confirmation_result",
    source: "carvis_registry",
    recordedAt: message.createdAt,
    tool: String(event.tool || "").slice(0, 80),
    confirmationId: String(event.confirmationId || "").slice(0, 100),
    decision: String(event.decision || "").slice(0, 30),
    summary: String(event.summary || "").slice(0, 1000),
    outcome: Object.fromEntries(
      OUTCOME_FIELDS.flatMap((key) => {
        const value = event.outcome?.[key];
        return ["string", "boolean", "number"].includes(typeof value)
          ? [[key, typeof value === "string" ? value.slice(0, 2000) : value]]
          : [];
      }),
    ),
  };
}

export function executionRecords(conversation) {
  const records = [];
  let length = 2; // The serialized array's brackets.
  for (
    let i = conversation.messages.length - 1;
    i >= 0 && records.length < 16;
    i--
  ) {
    const message = conversation.messages[i];
    if (
      message.role !== "event" ||
      message.event?.type !== "confirmation_result" ||
      message.event?.source !== "carvis_registry"
    )
      continue;
    const record = executionRecord(message);
    length += JSON.stringify(record).length + (records.length ? 1 : 0);
    if (length > 16000) break;
    records.push(record);
  }
  return records.reverse();
}
