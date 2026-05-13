// src/app/api/projects/[uuid]/spec-kit/import/route.ts
// Native Spec Kit import endpoint. The server receives Spec Kit artifacts,
// parses tasks.md, and creates a Chorus Proposal with document/task drafts.

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, hasPermission, isAgent, isUser } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
import { importSpecKitFeature, type SpecKitDocumentsInput } from "@/services/spec-kit.service";

type RouteContext = { params: Promise<{ uuid: string }> };

export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    if (isAgent(auth)) {
      if (!hasPermission(auth, "proposal:write")) {
        return errors.forbidden("Missing permission: proposal:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can import Spec Kit features");
    }

    const { uuid: projectUuid } = await context.params;
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    const body = await parseBody<{
      title: string;
      description?: string;
      featureDir: string;
      documents: SpecKitDocumentsInput;
      tasksMarkdown: string;
    }>(request);

    if (!body.title || body.title.trim() === "") {
      return errors.validationError({ title: "Title is required" });
    }
    if (!body.featureDir || body.featureDir.trim() === "") {
      return errors.validationError({ featureDir: "Feature directory is required" });
    }
    if (!body.documents || typeof body.documents !== "object") {
      return errors.validationError({ documents: "Spec Kit documents are required" });
    }
    if (!body.tasksMarkdown || body.tasksMarkdown.trim() === "") {
      return errors.validationError({ tasksMarkdown: "tasks.md content is required" });
    }

    const result = await importSpecKitFeature({
      companyUuid: auth.companyUuid,
      projectUuid,
      title: body.title,
      description: body.description,
      featureDir: body.featureDir,
      documents: body.documents,
      tasksMarkdown: body.tasksMarkdown,
      createdByUuid: auth.actorUuid,
      createdByType: isUser(auth) ? "user" : "agent",
    });

    return success(result);
  }
);
