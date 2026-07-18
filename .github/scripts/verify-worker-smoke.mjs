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

  const emptyModelConfig = await request("/auth/ai-model-config", { token });
  assert(emptyModelConfig?.configured === false, "new owner unexpectedly has a personal model config");
  assert(emptyModelConfig?.encryptionReady === true, "personal credential encryption is not ready");

  const externalModelConfig = await request("/auth/ai-model-config", {
    token,
    method: "PUT",
    body: {
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      model: "ci-compatible-model",
      apiKey: "sk-ci-personal-secret",
    },
  });
  assert(externalModelConfig?.provider === "openai_compatible", "external personal provider was not saved");
  assert(externalModelConfig?.apiKeyHint === "••••cret", "external personal key hint was not returned");
  assert(!("apiKey" in externalModelConfig), "personal model config exposed an API key");
  assert(!("apiKeyEncrypted" in externalModelConfig), "personal model config exposed encrypted key material");

  const externalModelConfigRead = await request("/auth/ai-model-config", { token });
  assert(externalModelConfigRead?.apiKeyHint === "••••cret", "saved personal key hint was not readable");
  assert(!("apiKey" in externalModelConfigRead), "personal model GET exposed an API key");

  const personalModelConfig = await request("/auth/ai-model-config", {
    token,
    method: "PUT",
    body: { provider: "mock" },
  });
  assert(personalModelConfig?.configured === true, "personal model config was not saved");
  assert(personalModelConfig?.provider === "mock", "personal mock provider was not selected");
  assert(personalModelConfig?.apiKeyHint === null, "switching to mock did not clear the key hint");
  assert(!("apiKey" in personalModelConfig), "personal model config exposed an API key");
  assert(!("apiKeyEncrypted" in personalModelConfig), "personal model config exposed encrypted key material");

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
  assert(firstGeneration?.state === "generating", "first generation request was not queued");
  assert(firstGeneration?.jobId, "first generation request did not return a job id");
  const jobId = firstGeneration.jobId;

  // A repeated request must reuse the active job or return the card that the
  // first request already completed. It must never create a second job.
  const repeatedGeneration = await request("/cards/generate", {
    token,
    method: "POST",
    body: { noteVersionId },
  });
  assert(
    repeatedGeneration?.jobId === null || repeatedGeneration?.jobId === jobId,
    `repeated generation created a different job: ${repeatedGeneration?.jobId}`,
  );

  const job = await poll(
    `generate_card job ${jobId}`,
    async () => {
      const current = await request(`/jobs/${jobId}`, { token });
      if (current?.status === "failed" || current?.status === "dead") {
        throw new Error(`generate_card job reached ${current.status}`);
      }
      return current;
    },
    (current) => current?.status === "succeeded",
  );
  assert(job.attempts === 0, `generate_card job unexpectedly retried ${job.attempts} time(s)`);
  assert(job.startedAt && job.finishedAt, "completed job is missing execution timestamps");

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
  const generateJobs = jobs?.items?.filter((item) => item.type === "generate_card") ?? [];
  assert(generateJobs.length === 1, `expected one generate_card job, found ${generateJobs.length}`);
  assert(generateJobs[0].id === jobId, "job list returned an unexpected generate_card job");

  const audit = await request("/workspace/ai-audit-log?limit=100&offset=0", { token });
  const auditEntries = audit?.items?.filter((item) => item.jobId === jobId) ?? [];
  assert(auditEntries.length === 1, `expected one AI audit entry, found ${auditEntries.length}`);
  assert(auditEntries[0].provider === "mock", "worker smoke did not use the mock provider");
  assert(auditEntries[0].operation === "generate_card", "AI audit entry has the wrong operation");
  assert(auditEntries[0].status === "success", "AI audit entry did not record success");

  console.log(
    `worker smoke OK: job=${jobId} card=${generationState.cardId} keyPoints=${card.keyPoints.length}`,
  );
}

main().catch((error) => {
  console.error(`worker smoke failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
