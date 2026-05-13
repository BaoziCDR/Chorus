import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { extractSpecKitFeatureDir, extractSpecKitTaskId } from "@/lib/spec-kit";
import * as activityService from "@/services/activity.service";
import {
  adapterTarget,
  getSpecKitRepoAdapter,
  readSpecKitFile,
  upsertSpecKitFile,
  type SpecKitRepoAdapter,
  type SpecKitRepoWriteResult,
} from "@/services/spec-kit-repo.service";

export interface SpecKitCheckboxPatchResult {
  changed: boolean;
  found: boolean;
  alreadyComplete: boolean;
  content: string;
}

const syncLogger = logger.child({ module: "spec-kit-sync" });

export function patchSpecKitTaskCheckbox(markdown: string, taskId: string): SpecKitCheckboxPatchResult {
  const lines = markdown.split(/\r?\n/);
  let changed = false;
  let found = false;
  let alreadyComplete = false;
  const patchedLines = lines.map((line) => {
    const taskLine = line.match(/^(\s*-\s+\[\s*)([ xX])(\s*\]\s+)(T\d{3,}\b.*)$/);
    if (!taskLine || taskLine[4].split(/\s+/)[0] !== taskId) return line;
    found = true;
    if (taskLine[2].toUpperCase() === "X") {
      alreadyComplete = true;
      return line;
    }
    changed = true;
    return `${taskLine[1]}X${taskLine[3]}${taskLine[4]}`;
  });
  return { changed, found, alreadyComplete, content: patchedLines.join("\n") };
}

async function createSyncActivity(params: {
  companyUuid: string;
  projectUuid: string;
  taskUuid: string;
  action: string;
  value: unknown;
}) {
  await activityService.createActivity({
    companyUuid: params.companyUuid,
    projectUuid: params.projectUuid,
    targetType: "task",
    targetUuid: params.taskUuid,
    actorType: "system",
    actorUuid: "speckit-sync",
    action: params.action,
    value: params.value,
  });
}

async function syncTaskCheckbox(params: {
  adapter: SpecKitRepoAdapter;
  featureDir: string;
  taskId: string;
}): Promise<{
  status: "updated" | "already_complete" | "task_not_found";
  path: string;
  write?: SpecKitRepoWriteResult;
}> {
  const path = `${params.featureDir}/tasks.md`;
  const markdown = await readSpecKitFile(params.adapter, path);
  if (!markdown) {
    return { status: "task_not_found", path };
  }

  const patched = patchSpecKitTaskCheckbox(markdown, params.taskId);
  if (!patched.found) {
    return { status: "task_not_found", path };
  }
  if (!patched.changed) {
    return { status: "already_complete", path };
  }

  const write = await upsertSpecKitFile({
    adapter: params.adapter,
    path,
    content: patched.content,
    message: `chore(spec-kit): mark ${params.taskId} complete`,
  });

  return {
    status: "updated",
    path,
    write,
  };
}

export async function syncSpecKitTaskCheckboxForTask(companyUuid: string, taskUuid: string): Promise<void> {
  const task = await prisma.task.findFirst({
    where: { uuid: taskUuid, companyUuid },
    select: {
      uuid: true,
      title: true,
      description: true,
      companyUuid: true,
      projectUuid: true,
      proposalUuid: true,
    },
  });
  if (!task?.proposalUuid) return;

  const proposal = await prisma.proposal.findFirst({
    where: { uuid: task.proposalUuid, companyUuid },
    select: { uuid: true, inputType: true, description: true },
  });
  if (!proposal) return;

  const featureDir = extractSpecKitFeatureDir(proposal.description);
  const taskId = extractSpecKitTaskId(task.title, task.description);
  if (!featureDir || !taskId) {
    await createSyncActivity({
      companyUuid,
      projectUuid: task.projectUuid,
      taskUuid: task.uuid,
      action: "speckit_sync_skipped",
      value: { reason: !featureDir ? "missing_feature_dir" : "missing_task_id", proposalUuid: proposal.uuid },
    });
    return;
  }

  const adapter = getSpecKitRepoAdapter(task.projectUuid);
  if (!adapter) {
    await createSyncActivity({
      companyUuid,
      projectUuid: task.projectUuid,
      taskUuid: task.uuid,
      action: "speckit_sync_skipped",
      value: {
        reason: "missing_repo_adapter_config",
        featureDir,
        taskId,
      },
    });
    return;
  }

  try {
    const result = await syncTaskCheckbox({ adapter, featureDir, taskId });
    await createSyncActivity({
      companyUuid,
      projectUuid: task.projectUuid,
      taskUuid: task.uuid,
      action: result.status === "updated" ? "speckit_sync_completed" : "speckit_sync_skipped",
      value: {
        ...(result.status === "already_complete" ? { reason: "already_complete" } : {}),
        ...(result.status === "task_not_found" ? { reason: "task_not_found" } : {}),
        provider: adapter.provider,
        target: adapterTarget(adapter),
        path: result.path,
        taskId,
        ...(result.write?.absolutePath ? { absolutePath: result.write.absolutePath } : {}),
        ...(result.write?.repo ? { repo: result.write.repo } : {}),
        ...(result.write?.branch ? { branch: result.write.branch } : {}),
        ...(result.write?.commitSha ? { commitSha: result.write.commitSha } : {}),
        ...(result.write?.htmlUrl ? { htmlUrl: result.write.htmlUrl } : {}),
      },
    });
  } catch (error) {
    await createSyncActivity({
      companyUuid,
      projectUuid: task.projectUuid,
      taskUuid: task.uuid,
      action: "speckit_sync_failed",
      value: {
        provider: adapter.provider,
        target: adapterTarget(adapter),
        featureDir,
        taskId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
    throw error;
  }
}

export function scheduleSpecKitTaskCheckboxSync(companyUuid: string, taskUuid: string): void {
  void syncSpecKitTaskCheckboxForTask(companyUuid, taskUuid).catch((err) => {
    syncLogger.error({ err, taskUuid }, "Spec Kit task checkbox sync failed");
  });
}
