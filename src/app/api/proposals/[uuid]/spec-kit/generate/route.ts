// src/app/api/proposals/[uuid]/spec-kit/generate/route.ts
// Generate Spec Kit files from a Chorus Proposal and write them to the configured repo.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, hasPermission, isAgent, isUser } from "@/lib/auth";
import { getProposalByUuid } from "@/services/proposal.service";
import { generateSpecKitFeatureFromProposal } from "@/services/spec-kit-generate.service";

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
      return errors.forbidden("Only users or permitted agents can generate Spec Kit features");
    }

    const { uuid: proposalUuid } = await context.params;
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return errors.notFound("Proposal");
    }

    let body: { featureDir?: string | null } = {};
    const rawBody = await request.text();
    if (rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody) as { featureDir?: string | null };
      } catch {
        return errors.validationError({ body: "Invalid JSON body" });
      }
    }
    const result = await generateSpecKitFeatureFromProposal({
      companyUuid: auth.companyUuid,
      proposalUuid,
      featureDir: body.featureDir,
      actorType: isUser(auth) ? "user" : "agent",
      actorUuid: auth.actorUuid,
    });

    return success(result);
  }
);
