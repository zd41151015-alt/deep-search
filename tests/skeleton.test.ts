import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import {
  CUSTOM_AGENT_PATHS,
  inspectRepository,
  REQUIRED_REPOSITORY_PATHS,
  SKILL_REFERENCE_PATHS,
} from "../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function makeContractCopy(): Promise<string> {
  const copyRoot = await mkdtemp(path.join(tmpdir(), "startup-opportunity-skeleton-"));
  await Promise.all(
    REQUIRED_REPOSITORY_PATHS.map(async (relativePath) => {
      const target = path.join(copyRoot, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(repositoryRoot, relativePath), target);
    }),
  );
  return copyRoot;
}

test("repository doctor accepts the committed foundation contract", async () => {
  const report = await inspectRepository(repositoryRoot);
  assert.equal(
    report.ok,
    true,
    JSON.stringify(report.checks.filter((check) => check.status === "fail")),
  );
  assert.equal(report.skeletonVersion, "g4.3");
  assert.equal(report.stack.runtime, "Node.js 24.18.x LTS");
  assert.ok(report.checks.length > REQUIRED_REPOSITORY_PATHS.length);
});

test("Skill metadata and progressive references are structurally valid", async () => {
  const skill = await read(".agents/skills/startup-opportunity/SKILL.md");
  const frontmatterMatch = skill.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(frontmatterMatch, "SKILL.md must start with YAML frontmatter");
  const metadata = parseYaml(frontmatterMatch[1] ?? "") as Record<string, unknown>;

  assert.equal(metadata.name, "startup-opportunity");
  assert.equal(typeof metadata.description, "string");
  assert.ok((metadata.description as string).includes("Startup Opportunity"));
  for (const referencePath of SKILL_REFERENCE_PATHS) {
    assert.ok(skill.includes(`references/${path.basename(referencePath)}`));
    assert.ok((await read(referencePath)).trim().length > 100);
  }
});

test("all three custom agents use the official standalone TOML fields", async () => {
  const expectedNames = new Set(["lane-researcher", "evidence-auditor", "adversarial-reviewer"]);

  for (const agentPath of CUSTOM_AGENT_PATHS) {
    const agent = parseToml(await read(agentPath)) as Record<string, unknown>;
    assert.equal(typeof agent.name, "string");
    assert.equal(typeof agent.description, "string");
    assert.equal(typeof agent.developer_instructions, "string");
    assert.ok((agent.description as string).length > 30);
    assert.ok((agent.developer_instructions as string).length > 300);
    assert.ok(
      expectedNames.delete(agent.name as string),
      `unexpected or duplicate agent ${agent.name}`,
    );
  }

  assert.deepEqual([...expectedNames], []);
});

test("Skill doctor script is runnable and reports the skeleton contract", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", ".agents/skills/startup-opportunity/scripts/doctor.ts", "--json"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { ok?: boolean; skeletonVersion?: string };
  assert.equal(report.ok, true);
  assert.equal(report.skeletonVersion, "g4.3");
});

test("doctor rejects a missing required entry", async (context) => {
  const copyRoot = await makeContractCopy();
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  await rm(path.join(copyRoot, ".agents/skills/startup-opportunity/SKILL.md"));

  const report = await inspectRepository(copyRoot);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id.endsWith("SKILL.md"))?.status, "fail");
});

test("doctor rejects package metadata drift", async (context) => {
  const copyRoot = await makeContractCopy();
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  const packageJson = JSON.parse(await readFile(path.join(copyRoot, "package.json"), "utf8")) as {
    packageManager: string;
  };
  packageJson.packageManager = "pnpm@10.0.0";
  await writeFile(path.join(copyRoot, "package.json"), `${JSON.stringify(packageJson)}\n`);

  const report = await inspectRepository(copyRoot);
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((check) => check.id === "toolchain:package-metadata")?.status,
    "fail",
  );
});

test("doctor rejects a second implementation lockfile", async (context) => {
  const copyRoot = await makeContractCopy();
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  await writeFile(path.join(copyRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const report = await inspectRepository(copyRoot);
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((check) => check.id === "single-lockfile:pnpm-lock.yaml")?.status,
    "fail",
  );
});

test("package lock and runtime metadata are frozen to one npm stack", async () => {
  const packageJson = JSON.parse(await read("package.json")) as {
    engines?: Record<string, string>;
    devEngines?: Record<string, Record<string, string>>;
    packageManager?: string;
  };
  const packageLock = JSON.parse(await read("package-lock.json")) as {
    lockfileVersion?: number;
  };

  assert.deepEqual(packageJson.engines, { node: "24.18.x", npm: "11.16.x" });
  assert.deepEqual(packageJson.devEngines, {
    runtime: { name: "node", version: "24.18.x", onFail: "error" },
    packageManager: { name: "npm", version: "11.16.x", onFail: "error" },
  });
  assert.equal(packageJson.packageManager, "npm@11.16.0");
  assert.equal(packageLock.lockfileVersion, 3);
});
