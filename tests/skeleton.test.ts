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

test("Skill fixes model-side parallel dispatch to direct acknowledged set closure", async () => {
  const skill = await read(".agents/skills/startup-opportunity/SKILL.md");
  const laneCatalog = await read(".agents/skills/startup-opportunity/references/lane-catalog.md");

  for (const requiredInstruction of [
    "## Model Dispatch Protocol",
    "planned_unit_ids",
    "acknowledged_unit_ids",
    "missing_unit_ids",
    "直接调用当前协作层暴露的 `spawn_agent` 工具",
    "绝不从 `functions.exec`、`exec_command`、shell、脚本或其 `tools.*` 命名空间嵌套调用 `spawn_agent`",
    "在同一个 tool round 发出全部独立 Unit",
    "只有收到成功的 spawn acknowledgement",
    "不得重放整个 batch",
  ]) {
    assert.ok(
      skill.includes(requiredInstruction),
      `missing dispatch instruction: ${requiredInstruction}`,
    );
  }

  assert.ok(laneCatalog.includes("执行已发布 typed task `<exact-task-ref>`"));
  assert.ok(laneCatalog.includes("Task 发布、unit active 或调用已发出均不是启动回执"));
  assert.ok(laneCatalog.includes("部分失败只核对并补启动缺失 Unit，禁止整批重放"));
});

test("public Runtime surface exposes formal-stage materialization before generic compilation", async () => {
  const skill = await read(".agents/skills/startup-opportunity/SKILL.md");
  const discovery = await read(
    ".agents/skills/startup-opportunity/references/opportunity-discovery.md",
  );
  const artifactContracts = await read(
    ".agents/skills/startup-opportunity/references/artifact-contracts.md",
  );
  const readme = await read("README.md");
  const operations = await read("docs/operations.md");
  const help = spawnSync(process.execPath, ["--import", "tsx", "harness/src/cli.ts", "help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);

  for (const command of [
    "materialize-formal-stage",
    "materialize-lane-result",
    "scaffold-lane-submission",
  ]) {
    assert.ok(help.stdout.includes(command), `CLI help missing ${command}`);
    assert.ok(skill.includes(command), `Skill missing ${command}`);
    assert.ok(readme.includes(command), `README missing ${command}`);
  }

  for (const surface of [skill, discovery, artifactContracts, readme, operations]) {
    assert.ok(surface.includes("materialize-formal-stage"));
    assert.ok(surface.includes("validate_only"));
    assert.ok(surface.includes("publication_plan"));
  }
  for (const phase of ["G2.1 setup", "dispatch wave", "G2.2 fan-in", "G2.3 synthesis"]) {
    assert.ok(skill.includes(phase), `Skill missing formal-stage phase ${phase}`);
    assert.ok(discovery.includes(phase), `Discovery reference missing formal-stage phase ${phase}`);
  }

  assert.ok(operations.includes("does not choose research directions"));
  assert.ok(operations.includes("does not start a Lane Agent"));
  assert.ok(discovery.includes("不从文本推断关系或研究判断"));
  assert.ok(skill.includes("`compile-artifacts` 仅用于"));
  assert.equal(
    skill.includes("每个新 dispatch wave 必须把 execution overlay"),
    false,
    "Skill still points wave publication at generic compile-artifacts",
  );
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
