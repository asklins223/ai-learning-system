import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canAdvanceSourceParse,
  createPinnedLookup,
  fetchUrlContent,
  type AddressResolver,
  type PinnedRequester,
} from "./parse-source.ts";

test("treats archived as a terminal source state", () => {
  assert.equal(canAdvanceSourceParse("draft"), true);
  assert.equal(canAdvanceSourceParse("processing"), true);
  assert.equal(canAdvanceSourceParse("ready"), true);
  assert.equal(canAdvanceSourceParse("failed"), true);
  assert.equal(canAdvanceSourceParse("archived"), false);
});

test("pins the validated IP and revalidates every redirect", async () => {
  const resolvedHosts: string[] = [];
  const requestedHops: Array<{ hostname: string; address: string }> = [];
  const testResolver: AddressResolver = async (hostname) => {
    resolvedHosts.push(hostname);
    return hostname === "origin.invalid"
      ? { address: "203.0.113.10", family: 4 }
      : { address: "203.0.113.11", family: 4 };
  };
  const testRequester: PinnedRequester = async (parsed, pinned) => {
    requestedHops.push({ hostname: parsed.hostname, address: pinned.address });
    if (parsed.hostname === "origin.invalid") {
      return {
        status: 302,
        statusText: "Found",
        location: "https://redirect.invalid/final",
        contentType: "",
        body: Buffer.alloc(0),
      };
    }
    return {
      status: 200,
      statusText: "OK",
      contentType: "text/html; charset=utf-8",
      body: Buffer.from("<h1>Pinned</h1><p>redirect ok</p>"),
    };
  };

  const content = await fetchUrlContent("https://origin.invalid/start", undefined, {
    resolveAddress: testResolver,
    request: testRequester,
  });

  assert.equal(content, "Pinned\n\nredirect ok");
  assert.deepEqual(resolvedHosts, ["origin.invalid", "redirect.invalid"]);
  assert.deepEqual(requestedHops, [
    { hostname: "origin.invalid", address: "203.0.113.10" },
    { hostname: "redirect.invalid", address: "203.0.113.11" },
  ]);
});

test("the socket lookup callback always returns the validated address", async () => {
  const lookup = createPinnedLookup({ address: "203.0.113.25", family: 4 });
  const result = await new Promise<{ address: string; family: number | undefined }>((resolve, reject) => {
    lookup("attacker-controlled.invalid", {}, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      assert.equal(typeof address, "string");
      resolve({ address: address as string, family });
    });
  });
  assert.deepEqual(result, { address: "203.0.113.25", family: 4 });
});

test("rejects private literal addresses before opening a socket", async () => {
  await assert.rejects(
    fetchUrlContent("http://127.0.0.1/metadata"),
    /blocked: private\/internal host/,
  );
  await assert.rejects(
    fetchUrlContent("http://[::1]/metadata"),
    /blocked: private\/internal host/,
  );
  await assert.rejects(
    fetchUrlContent("http://[::ffff:127.0.0.1]/metadata"),
    /blocked: private\/internal host/,
  );
  await assert.rejects(
    fetchUrlContent("http://[fe90::1]/metadata"),
    /blocked: private\/internal host/,
  );
  await assert.rejects(
    fetchUrlContent("http://[2001:db8::1]/metadata"),
    /blocked: private\/internal host/,
  );
  await assert.rejects(
    fetchUrlContent("http://[2002:7f00:1::]/metadata"),
    /blocked: private\/internal host/,
  );
});
