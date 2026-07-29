import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("M6 deployment defaults enable card generation v2 on every runtime surface", () => {
  const envExample = read("../../../../.env.example");
  const productionCompose = read("../../../../docker-compose.yml");
  const developmentCompose = read("../../../../docker-compose.dev.yml");
  const webDockerfile = read("../../Dockerfile");

  assert.match(envExample, /^CARD_GENERATION_V2_ENABLED=true$/m);
  assert.match(envExample, /^NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED=true$/m);

  for (const [name, compose] of [
    ["production compose", productionCompose],
    ["development compose", developmentCompose],
  ] as const) {
    const serverDefaults = compose.match(
      /CARD_GENERATION_V2_ENABLED: \$\{CARD_GENERATION_V2_ENABLED:-true\}/g,
    ) ?? [];
    assert.ok(
      serverDefaults.length >= 2,
      `${name} must default both API and Worker to generation v2`,
    );
    assert.match(
      compose,
      /NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED: \$\{NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED:-true\}/,
      `${name} must build/run the Web client with generation v2 enabled`,
    );
  }

  assert.match(
    webDockerfile,
    /^ARG NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED=true$/m,
    "standalone Web images must use the same M6 default as Compose",
  );
});
