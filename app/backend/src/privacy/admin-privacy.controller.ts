import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request } from "express";

import { ApiKeyGuard } from "../auth/guards/api-key.guard";
import { RequireScopes } from "../auth/decorators/require-scopes.decorator";
import { RateLimitGroupTag } from "../auth/decorators/rate-limit-group.decorator";
import { RetentionService } from "./retention/retention.service";

class RetentionSweepDto {
  apply?: boolean;
  batchSize?: number;
}

type ApiKeyRequest = Request & { apiKey?: { id: string; scopes: string[] } };

function actorOf(request: ApiKeyRequest): string {
  const id = request.apiKey?.id;
  return id ? `api-key:${id}` : "api-key:unidentified";
}

/**
 * Admin retention surface (issue #307).
 *
 * Dry-run is the default; applying deletions requires the `admin` scope and the
 * `privacy.retention_sweep` flag (disabled on mainnet by default).
 */
@ApiTags("privacy-admin")
@ApiHeader({ name: "X-API-Key", description: "Admin-scoped API key", required: true })
@UseGuards(ApiKeyGuard)
@RequireScopes("admin")
@RateLimitGroupTag("authenticated")
@Controller("admin/privacy")
export class AdminPrivacyController {
  constructor(private readonly retentionService: RetentionService) {}

  @Post("retention/sweep")
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description: "Replay-safe key; a replay returns the original run result.",
  })
  @ApiOperation({
    summary: "Plan or execute a retention sweep",
    description:
      "Dry-run by default (`apply: false`) — reports records past their retention window per category. " +
      "`apply: true` executes deletions idempotently per record and stops the run if a dependency fails, " +
      "so a partial run is never reported as completed.",
  })
  @ApiResponse({ status: 200, description: "Sweep run result (planned, failed, completed)" })
  @ApiResponse({ status: 403, description: "RETENTION_SWEEP_DISABLED or missing admin scope" })
  async sweep(
    @Body() body: RetentionSweepDto,
    @Req() request: ApiKeyRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.retentionService.sweep({
      apply: body.apply === true,
      actor: actorOf(request),
      idempotencyKey: idempotencyKey ?? null,
      correlationId,
      batchSize: body.batchSize,
    });
  }
}
