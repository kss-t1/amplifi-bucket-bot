import { test, expect, afterEach } from "bun:test";
import { fetchWithTimeout } from "./http.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("aborts a hung request once the timeout elapses", async () => {
  // A fetch that never settles on its own — it only rejects when its signal
  // aborts. This is the wedge the helper exists to break: without a timeout the
  // await would hang forever; with one, AbortSignal.timeout fires and rejects.
  globalThis.fetch = ((_input: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
      );
    })) as unknown as typeof fetch;

  const start = Date.now();
  let rejected = false;
  try {
    await fetchWithTimeout("https://example.invalid/hang", {}, 50);
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
  expect(Date.now() - start).toBeLessThan(2000); // didn't hang
});

test("passes a fast response straight through", async () => {
  globalThis.fetch = (async () =>
    new Response("ok")) as unknown as typeof fetch;
  const res = await fetchWithTimeout("https://example.invalid/ok", {}, 1000);
  expect(await res.text()).toBe("ok");
});
