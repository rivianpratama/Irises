import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebEvent } from "@/lib/server-client";

// Drive the thin client by stubbing its only transport (server-client). The
// component owns no turn logic, so a mock stream + captured onEvent is enough.
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  close: vi.fn(),
  emit: { current: (_event: WebEvent) => {} }
}));

vi.mock("@/lib/server-client", () => ({
  sendMessage: mocks.sendMessage,
  cancel: mocks.cancel,
  openStream: (onEvent: (event: WebEvent) => void) => {
    mocks.emit.current = onEvent;
    return { close: mocks.close } as unknown as EventSource;
  }
}));

import { IrisesApp } from "@/components/IrisesApp";

function emit(event: WebEvent) {
  act(() => {
    mocks.emit.current(event);
  });
}

function bubble(id: string, text: string): WebEvent {
  return { seq: 1, ts: Date.now(), type: "bubble", id, text };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Irises thin client", () => {
  it("renders the composer and opens the stream on mount", () => {
    render(<IrisesApp />);
    expect(
      screen.getByPlaceholderText("What's been on your mind lately?")
    ).toBeInTheDocument();
    // openStream captured our handler.
    expect(typeof mocks.emit.current).toBe("function");
  });

  it("optimistically appends the user bubble and posts the message", async () => {
    const user = userEvent.setup();
    render(<IrisesApp />);

    await user.type(screen.getByLabelText("Message Irises"), "hello irises");
    await user.click(screen.getByLabelText("Send message"));

    expect(screen.getByText("hello irises")).toBeInTheDocument();
    expect(mocks.sendMessage).toHaveBeenCalledWith("hello irises");
    // Optimistic typing indicator + Stop button appear while awaiting a reply.
    expect(screen.getByLabelText("Irises is typing")).toBeInTheDocument();
    expect(screen.getByLabelText("Stop response")).toBeInTheDocument();
  });

  it("renders assistant bubbles from stream events and hides typing", async () => {
    const user = userEvent.setup();
    render(<IrisesApp />);
    await user.type(screen.getByLabelText("Message Irises"), "ping");
    await user.click(screen.getByLabelText("Send message"));

    emit({ seq: 2, ts: Date.now(), type: "typing", state: "start" });
    emit(bubble("b1", "first reply"));
    emit(bubble("b2", "second reply"));

    expect(screen.getByText("first reply")).toBeInTheDocument();
    expect(screen.getByText("second reply")).toBeInTheDocument();
    expect(screen.queryByLabelText("Irises is typing")).not.toBeInTheDocument();
    // Send button returns once typing stops.
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });

  it("de-dupes replayed bubbles by id", () => {
    render(<IrisesApp />);
    emit(bubble("dup", "only once"));
    emit(bubble("dup", "only once"));
    expect(screen.getAllByText("only once")).toHaveLength(1);
  });

  it("attaches reactions to the bubble they target", () => {
    render(<IrisesApp />);
    emit(bubble("b1", "reactable"));
    emit({
      seq: 3,
      ts: Date.now(),
      type: "reaction",
      messageId: "b1",
      reaction: { type: "emoji", emoji: "🔥" }
    });
    expect(screen.getByText("🔥")).toBeInTheDocument();
  });

  it("cancels in-flight work with the Stop button", async () => {
    const user = userEvent.setup();
    render(<IrisesApp />);
    await user.type(screen.getByLabelText("Message Irises"), "stop me");
    await user.click(screen.getByLabelText("Send message"));

    await user.click(screen.getByLabelText("Stop response"));
    expect(mocks.cancel).toHaveBeenCalled();
    expect(screen.queryByLabelText("Irises is typing")).not.toBeInTheDocument();
  });
});
