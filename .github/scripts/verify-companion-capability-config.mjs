import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const FLAGS = [
  "COMPANION_PET_V1_ENABLED",
  "COMPANION_DIALOGUE_V1_ENABLED",
  "COMPANION_VOICE_DIALOGUE_V1_ENABLED",
  "COMPANION_ACTION_BRIDGE_V1_ENABLED",
];

function loadCompose(file) {
  return yaml.load(readFileSync(file, "utf8"));
}

function environment(service, file) {
  const value = service?.environment;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: service environment is missing`);
  }
  return value;
}

function assertCompose(file, expectedDefault) {
  const document = loadCompose(file);
  const services = document?.services;
  const api = environment(services?.api, file);
  const worker = environment(services?.worker, file);
  for (const flag of FLAGS) {
    const expected = `\${${flag}:-${expectedDefault}}`;
    if (api[flag] !== expected) throw new Error(`${file}: api ${flag} must be ${expected}`);
    if (worker[flag] !== expected) throw new Error(`${file}: worker ${flag} must mirror api (${expected})`);
  }
}

assertCompose("docker-compose.dev.yml", "true");
assertCompose("docker-compose.yml", "false");
console.log("companion capability config OK (API/Worker parity; dev=true, production=false)");
