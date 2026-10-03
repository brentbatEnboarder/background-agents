import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("CS pilot workflows cannot run provider operations", () => {
  const terraformWorkflow = readFileSync(join(root, ".github/workflows/terraform.yml"), "utf8");

  assert.match(terraformWorkflow, /terraform init -backend=false/);
  assert.match(terraformWorkflow, /terraform validate/);
  assert.match(terraformWorkflow, /terraform test/);
  assert.doesNotMatch(terraformWorkflow, /\bterraform (?:plan|apply|state)\b/);
  assert.doesNotMatch(terraformWorkflow, /\b(?:wrangler|vercel|modal) deploy\b/);
  assert.doesNotMatch(terraformWorkflow, /\bsecrets\./);
  assert.equal(existsSync(join(root, ".github/workflows/deploy-web.yml")), false);
});

test("pilot defaults do not seed skills or MCP servers", () => {
  const migrationsDirectory = join(root, "terraform/d1/migrations");
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => readFileSync(join(migrationsDirectory, name), "utf8"))
    .join("\n");

  assert.doesNotMatch(migrations, /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:skills|mcp_servers)\b/i);
});

test("pilot bundles no runtime skills", () => {
  const skillsDirectory = join(root, "packages/sandbox-runtime/src/sandbox_runtime/skills");
  const bundledSkills = existsSync(skillsDirectory)
    ? readdirSync(skillsDirectory).filter((name) =>
        existsSync(join(skillsDirectory, name, "SKILL.md"))
      )
    : [];

  assert.deepEqual(bundledSkills, []);
});
