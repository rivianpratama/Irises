import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancel, openStream, sendMessage, type WebEvent } from "@/lib/server-client";

class FakeEventSource {
  static last: FakeEventSource | undefined;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  close = vi.fn();
}

describe("server-client", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 202 })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts messages to the brain endpoint", async () => {
    await sendMessage("hey");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/api/web/message");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "hey" });
  });

  it("includes clientId when provided", async () => {
    await sendMessage("hey", "client-1");
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "hey",
      clientId: "client-1"
    });
  });

  it("throws when the server rejects a message", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("no", { status: 500 }));
    await expect(sendMessage("boom")).rejects.toThrow(/500/);
  });

  it("opens an SSE stream and parses JSON frames", () => {
    const received: WebEvent[] = [];
    const source = openStream((event) => received.push(event));
    expect(source).toBe(FakeEventSource.last as unknown as EventSource);
    expect(FakeEventSource.last?.url).toContain("/api/web/stream");

    FakeEventSource.last?.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ seq: 1, ts: 0, type: "bubble", id: "b1", text: "hi" })
      })
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "bubble", id: "b1", text: "hi" });
  });

  it("ignores malformed SSE frames without throwing", () => {
    const received: WebEvent[] = [];
    openStream((event) => received.push(event));
    expect(() =>
      FakeEventSource.last?.onmessage?.(
        new MessageEvent("message", { data: "not-json" })
      )
    ).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it("appends clientId to the stream URL when provided", () => {
    openStream(() => {}, "client-9");
    expect(FakeEventSource.last?.url).toContain("clientId=client-9");
  });

  it("posts to the cancel endpoint", async () => {
    await cancel();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/api/web/cancel");
    expect(init?.method).toBe("POST");
  });
});
