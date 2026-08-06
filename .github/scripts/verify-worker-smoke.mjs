#!/usr/bin/env node

const apiBaseUrl = (process.env.API_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const email = process.env.WORKER_SMOKE_EMAIL ?? "worker-smoke@example.invalid";
const password = process.env.WORKER_SMOKE_PASSWORD ?? "worker-smoke-password";
const timeoutMs = Number(process.env.WORKER_SMOKE_TIMEOUT_MS ?? 45_000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { token, method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  }
  return payload;
}

async function poll(description, read, accept) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${description} did not converge within ${timeoutMs}ms: ${JSON.stringify(value)}`);
}

async function main() {
  const login = await request("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert(login?.token, "login response did not include a token");
  const token = login.token;

  const created = await request("/notes", {
    token,
    method: "POST",
    body: {
      title: "Release worker smoke",
      blocks: [
        {
          type: "paragraph",
          content: "A release worker must claim one durable job, persist one learning card, and record an auditable mock provider call.",
        },
      ],
    },
  });
  const noteVersionId = created?.version?.id;
  assert(noteVersionId, "note creation did not return a version id");

  const firstGeneration = await request("/cards/generate", {
    token,
    method: "POST",
    body: { noteVersionId },
  });
  assert(firstGeneration?.runId, "generation request did not return a run id");
  const runId = firstGeneration.runId;

  // A repeated request must reuse the active run or return the card that the
  // first request already completed. It must never create a second run.
  const repeatedGeneration = await request("/cards/generate", {
    token,
    method: "POST",
    body: { noteVersionId },
  });
  assert(
    !repeatedGeneration?.runId || repeatedGeneration.runId === runId,
    `repeated generation created a different run: ${repeatedGeneration?.runId}`,
  );

  const run = await poll(
    `card generation run ${runId}`,
    async () => {
      const current = await request(`/card-generation-runs/${runId}`, { token });
      if (current?.status === "failed" || current?.status === "terminal_failed" || current?.status === "cancelled") {
        throw new Error(`card generation run reached ${current.status}`);
      }
      return current;
    },
    (current) => current?.status === "succeeded",
  );
  assert(run.runId === runId, "polling returned an unexpected run id");

  const generationState = await poll(
    `card state for note version ${noteVersionId}`,
    () => request(`/note-versions/${noteVersionId}/card-status`, { token }),
    (state) => state?.state === "generated" && Boolean(state.cardId),
  );
  assert(
    generationState.generatedVersionId === noteVersionId,
    "generated card points at a different note version",
  );

  const card = await request(`/cards/${generationState.cardId}`, { token });
  assert(card?.card?.id === generationState.cardId, "generated card detail was not readable");
  assert(Array.isArray(card?.keyPoints) && card.keyPoints.length > 0, "mock provider produced no key points");

  const jobs = await request("/jobs", { token });
  const agentJobs = jobs?.items?.filter((item) => item.type === "execute_card_agent_turn") ?? [];
  assert(agentJobs.length >= 1, `expected at least one execute_card_agent_turn job, found ${agentJobs.length}`);

  const audit = await request("/workspace/ai-audit-log?limit=100&offset=0", { token });
  const auditEntries = audit?.items?.filter((item) => item.operation === "execute_card_agent_turn") ?? [];
  assert(auditEntries.length >= 1, `expected at least one AI audit entry, found ${auditEntries.length}`);
  assert(auditEntries[0].provider === "mock", "worker smoke did not use the mock provider");
  assert(auditEntries[0].status === "success", "AI audit entry did not record success");

  console.log(
    `worker smoke OK: run=${runId} card=${generationState.cardId} keyPoints=${card.keyPoints.length}`,
  );
}

main().catch((error) => {
  console.error(`worker smoke failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
