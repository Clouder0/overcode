import { describe, expect, test } from "bun:test"
import { createQueueItem, toPromptAsyncInput } from "../../src/cli/cmd/tui/component/prompt/queue-data"

describe("prompt queue helpers", () => {
  test("createQueueItem preserves service tier", () => {
    const item = createQueueItem({
      id: "queue_1",
      created: 123,
      sessionID: "ses_1",
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
      variant: "high",
      serviceTier: "priority",
      text: "hello",
      parts: [],
    })

    expect(item.serviceTier).toBe("priority")
    expect(item.prepared).toBeUndefined()
  })

  test("toPromptAsyncInput includes service tier", () => {
    const item = createQueueItem({
      id: "queue_1",
      created: 123,
      sessionID: "ses_1",
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
      variant: "high",
      serviceTier: "priority",
      text: "hello",
      parts: [],
      prepared: {
        messageID: "msg_1",
        partIDs: ["part_1"],
      },
    })

    expect(
      toPromptAsyncInput({
        item,
        parts: [{ id: "part_1", type: "text", text: "hello" }],
      }),
    ).toEqual({
      sessionID: "ses_1",
      messageID: "msg_1",
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
      variant: "high",
      serviceTier: "priority",
      parts: [{ id: "part_1", type: "text", text: "hello" }],
    })
  })
})
