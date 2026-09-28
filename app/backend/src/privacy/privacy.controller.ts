import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { ApiKeyGuard } from "../auth/guards/api-key.guard";
import { RequireScopes } from "../auth/decorators/require-scopes.decorator";
import { RateLimitGroupTag } from "../auth/decorators/rate-limit-group.decorator";
import { PrivacyService, StealthEnvelope } from "./privacy.service";
import { DeletionRequestService, DeletionSubjectKind } from "./deletion-requests/deletion-request.service";

class EncryptRecipientDto {
  recipientAddress!: string;
  recipientViewPublicKeyPem!: string;
}

class DeriveSecretDto {
  privateKeyPem!: string;
  publicKeyPem!: string;
}

class DecryptEnvelopeDto {
  envelope!: StealthEnvelope;
  recipientViewPrivateKeyPem!: string;
}

class DeletionChallengeDto {
  subject!: string;
  subjectKind?: DeletionSubjectKind;
}

class DeletionRequestDto {
  subject?: string;
  subjectKind?: DeletionSubjectKind;
  challengeId!: string;
  signature!: string;
}

type ApiKeyRequest = Request & { apiKey?: { id: string; scopes: string[] } };

function actorOf(request: ApiKeyRequest): string {
  const id = request.apiKey?.id;
  return id ? `api-key:${id}` : `anonymous:${request.ip ?? "unknown"}`;
}

@ApiTags("privacy")
@Controller("privacy")
export class PrivacyController {
  constructor(
    private readonly privacyService: PrivacyService,
    private readonly deletionRequestService: DeletionRequestService,
  ) {}

  @Post("encrypt-recipient")
  @ApiOperation({
    summary: "Encrypt recipient metadata using recipient view public key",
  })
  encryptRecipient(@Body() body: EncryptRecipientDto) {
    return this.privacyService.encryptRecipientForViewKey(
      body.recipientAddress,
      body.recipientViewPublicKeyPem,
    );
  }

  @Post("derive-shared-secret")
  @ApiOperation({
    summary: "Derive X25519 shared secret for non-custodial stealth flows",
  })
  deriveSharedSecret(@Body() body: DeriveSecretDto) {
    return {
      sharedSecretHex: this.privacyService.deriveSharedSecretHex(
        body.privateKeyPem,
        body.publicKeyPem,
      ),
    };
  }

  @Post("decrypt-recipient")
  @ApiOperation({
    summary: "Decrypt recipient metadata envelope (for local integration testing)",
  })
  decryptRecipient(@Body() body: DecryptEnvelopeDto) {
    return {
      recipientAddress: this.privacyService.decryptRecipientEnvelope(
        body.envelope,
        body.recipientViewPrivateKeyPem,
      ),
    };
  }

  // ── Retention & deletion (issue #307) ──────────────────────────────────

  @Get("retention-policy")
  @RateLimitGroupTag("public")
  @UseGuards(ApiKeyGuard)
  @ApiOperation({
    summary: "Get the published retention and deletion policy",
    description:
      "Machine-readable view of docs/policies/DATA-RETENTION-PRIVACY-POLICY.md: categories, retention windows, " +
      "deletion methods, holds, SLA and error codes. Contains no personal data.",
  })
  @ApiResponse({ status: 200, description: "Retention policy document" })
  getRetentionPolicy() {
    return this.deletionRequestService.getPolicy();
  }

  @Post("deletion-requests/challenge")
  @HttpCode(HttpStatus.OK)
  @RateLimitGroupTag("public")
  @UseGuards(ApiKeyGuard)
  @ApiOperation({
    summary: "Issue a single-use proof-of-control challenge",
    description:
      "Returns the canonical string the subject must sign with their Stellar key (self-custody: QuickEx never " +
      "holds keys). TTL is the policy challengeTtlSeconds (900s) and the challenge is single-use.",
  })
  @ApiResponse({ status: 200, description: "Challenge issued" })
  @ApiResponse({ status: 403, description: "DELETION_INTAKE_DISABLED" })
  @ApiResponse({ status: 404, description: "DELETION_SUBJECT_NOT_FOUND" })
  issueDeletionChallenge(@Body() body: DeletionChallengeDto) {
    return this.deletionRequestService.issueChallenge({
      subject: body.subject,
      subjectKind: body.subjectKind,
    });
  }

  @Post("deletion-requests")
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimitGroupTag("public")
  @UseGuards(ApiKeyGuard)
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description: "Replay-safe key; the same key + payload returns the original request.",
  })
  @ApiOperation({
    summary: "Request deletion of your data (202 Accepted)",
    description:
      "Verifies the signed challenge, then schedules deletion per the published retention schedule. Financial " +
      "records are pseudonymized under hold; on-chain data cannot be deleted. Only a salted subject hash is stored.",
  })
  @ApiResponse({ status: 202, description: "Request accepted with SLA dates and per-category outcomes" })
  @ApiResponse({ status: 401, description: "DELETION_SIGNATURE_INVALID" })
  @ApiResponse({ status: 409, description: "DELETION_REQUEST_DUPLICATE or DELETION_IDEMPOTENCY_CONFLICT" })
  @ApiResponse({ status: 410, description: "DELETION_CHALLENGE_EXPIRED" })
  createDeletionRequest(
    @Body() body: DeletionRequestDto,
    @Req() request: ApiKeyRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.deletionRequestService.createRequest({
      subject: body.subject,
      subjectKind: body.subjectKind,
      challengeId: body.challengeId,
      signature: body.signature,
      idempotencyKey: idempotencyKey ?? null,
      actor: actorOf(request),
      correlationId,
    });
  }

  @Post("deletion-requests/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @RateLimitGroupTag("public")
  @UseGuards(ApiKeyGuard)
  @ApiParam({ name: "id", description: "Deletion request id" })
  @ApiOperation({
    summary: "Cancel a pending deletion request during its cooling-off window",
    description:
      "Requires a fresh signed challenge for the same subject. After the cooling-off window or once execution " +
      "begins the request cannot be cancelled (DELETION_NOT_CANCELLABLE / DELETION_ALREADY_EXECUTED).",
  })
  @ApiResponse({ status: 200, description: "Request cancelled (idempotent when already cancelled)" })
  cancelDeletionRequest(
    @Param("id") id: string,
    @Body() body: DeletionRequestDto,
    @Req() request: ApiKeyRequest,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.deletionRequestService.cancelRequest({
      requestId: id,
      challengeId: body.challengeId,
      signature: body.signature,
      actor: actorOf(request),
      correlationId,
    });
  }

  @Get("deletion-requests/:id")
  @RequireScopes("admin")
  @RateLimitGroupTag("authenticated")
  @UseGuards(ApiKeyGuard)
  @ApiParam({ name: "id", description: "Deletion request id" })
  @ApiOperation({
    summary: "Read a deletion request (admin scoped)",
    description:
      "Returns status, SLA dates, per-category outcomes, any holds, and the salted subject hash (never the raw subject).",
  })
  @ApiResponse({ status: 200, description: "Deletion request record" })
  @ApiResponse({ status: 404, description: "Unknown request" })
  getDeletionRequest(@Param("id") id: string) {
    return this.deletionRequestService.getRequest(id);
  }
}
