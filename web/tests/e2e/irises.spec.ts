import { expect, test, type Page } from "@playwright/test";

// The web app is now a thin client of the server-side Irises brain. These e2e
// stubs stand in for the brain's SSE contract: POST /api/web/message (202) and
// GET /api/web/stream (Server-Sent Events).

function streamBody(): string {
  const events = [
    { seq: 1, ts: 0, type: "hello" },
    { seq: 2, ts: 0, type: "typing", state: "start" },
    { seq: 3, ts: 0, type: "bubble", id: "b1", text: "streamed reply from the brain" },
    { seq: 4, ts: 0, type: "typing", state: "stop" }
  ];
  return (
    ": connected\n\n"
    + events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`).join("")
  );
}

async function mockBrain(page: Page) {
  await page.route("**/api/web/stream**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: streamBody()
    });
  });
  await page.route("**/api/web/message", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, chatId: "c1", messageId: "m1" })
    });
  });
  await page.route("**/api/web/cancel", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

test("streams an assistant reply after the user sends a message", async ({ page }) => {
  await mockBrain(page);
  await page.goto("/");

  await expect(page.getByPlaceholder("What's been on your mind lately?")).toBeVisible();

  await page.getByLabel("Message Irises").fill("hello brain");
  await page.getByLabel("Message Irises").press("Enter");

  await expect(page.getByText("hello brain")).toBeVisible();
  await expect(
    page.getByText("streamed reply from the brain")
  ).toBeVisible({ timeout: 15_000 });
});
