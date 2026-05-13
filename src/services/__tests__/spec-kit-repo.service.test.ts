import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSpecKitRepoAdapter,
  readSpecKitFile,
  upsertSpecKitFile,
} from "@/services/spec-kit-repo.service";

const PROJECT_UUID = "project-0000-0000-0000-000000000001";
let tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chorus-speckit-"));
  tempDirs.push(dir);
  return dir;
}

describe("spec-kit-repo.service", () => {
  it("uses the process cwd as the default local adapter root", () => {
    const adapter = getSpecKitRepoAdapter(PROJECT_UUID);

    expect(adapter).toEqual({ provider: "local", root: process.cwd() });
  });

  it("writes and reads Spec Kit files through the local adapter", async () => {
    const root = await tempRepo();
    vi.stubEnv("CHORUS_SPECKIT_LOCAL_REPO", root);
    const adapter = getSpecKitRepoAdapter(PROJECT_UUID);
    expect(adapter?.provider).toBe("local");

    const result = await upsertSpecKitFile({
      adapter: adapter!,
      path: "specs/001-auth/tasks.md",
      content: "- [ ] T001 Implement login\n",
      message: "test",
    });

    expect(result).toMatchObject({
      provider: "local",
      path: "specs/001-auth/tasks.md",
      status: "created",
      absolutePath: path.join(root, "specs/001-auth/tasks.md"),
    });
    await expect(readFile(path.join(root, "specs/001-auth/tasks.md"), "utf8")).resolves.toBe("- [ ] T001 Implement login\n");
    await expect(readSpecKitFile(adapter!, "specs/001-auth/tasks.md")).resolves.toBe("- [ ] T001 Implement login\n");
  });

  it("rejects local paths that escape the repo root", async () => {
    const root = await tempRepo();
    vi.stubEnv("CHORUS_SPECKIT_LOCAL_REPO", root);
    const adapter = getSpecKitRepoAdapter(PROJECT_UUID);

    await expect(upsertSpecKitFile({
      adapter: adapter!,
      path: "../tasks.md",
      content: "bad",
      message: "test",
    })).rejects.toThrow("Unsafe Spec Kit path");
  });
});
