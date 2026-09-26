import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { RateLimitGroupTag } from '../auth/decorators/rate-limit-group.decorator';
import { AssetListingService } from './asset-listing.service';
import { AssetListingDecisionDto } from './dto/asset-listing.dto';

type ApiKeyRequest = Request & { apiKey?: { id: string; scopes: string[] } };

function actorOf(request: ApiKeyRequest): string {
  const id = request.apiKey?.id;
  return id ? `api-key:${id}` : 'api-key:unidentified';
}

/**
 * Admin asset listing surface (issue #306).
 *
 * Reads are safe to call anywhere; mutations require the `admin` scope and are
 * additionally gated by the `assets.listing_decisions` feature flag (disabled by
 * default on production/mainnet until the policy review sign-off).
 */
@ApiTags('asset-listing-admin')
@ApiHeader({
  name: 'X-API-Key',
  description: 'Admin-scoped API key',
  required: true,
})
@UseGuards(ApiKeyGuard)
@RequireScopes('admin')
@RateLimitGroupTag('authenticated')
@Controller('admin/asset-listing')
export class AssetListingAdminController {
  constructor(private readonly assetListingService: AssetListingService) {}

  @Get('registry')
  @ApiOperation({
    summary: 'List the asset registry with effective policy status',
    description:
      'Returns every registry record plus its evaluated status, tier, served flag and the reasons behind it.',
  })
  @ApiResponse({ status: 200, description: 'Asset registry with policy evaluation' })
  async listRegistry() {
    return { assets: await this.assetListingService.listRegistry() };
  }

  @Get('decisions')
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum decisions to return (1-200)' })
  @ApiOperation({
    summary: 'List recent asset listing decisions',
    description: 'Append-only decision trail: action, from/to status, trigger, evidence reference, actor.',
  })
  async listDecisions(@Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '50', 10);
    const bounded = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    return { decisions: await this.assetListingService.listDecisions(bounded) };
  }

  @Post('decisions')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiHeader({
    name: 'Idempotency-Key',
    description:
      'Replay-safe key. Replying with the same key and payload returns the original decision; a different payload fails with ASSET_LISTING_IDEMPOTENCY_CONFLICT.',
    required: false,
  })
  @ApiOperation({
    summary: 'Apply a governed listing decision (list, reject, suspend, delist)',
    description:
      'Enforces the published policy: valid transitions, required evidence, cooling-off before re-listing, ' +
      'and records an audited decision. Returns a stable ASSET_LISTING_* error code on rejection.',
  })
  @ApiResponse({ status: 200, description: 'Decision applied (or replayed when idempotent)' })
  @ApiResponse({ status: 403, description: 'ASSET_LISTING_DECISIONS_DISABLED or missing admin scope' })
  @ApiResponse({ status: 409, description: 'ASSET_LISTING_COOLING_OFF_ACTIVE or ASSET_LISTING_IDEMPOTENCY_CONFLICT' })
  @ApiResponse({ status: 422, description: 'ASSET_LISTING_EVIDENCE_* or ASSET_LISTING_INVALID_TRANSITION' })
  async decide(
    @Body() dto: AssetListingDecisionDto,
    @Req() request: ApiKeyRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.assetListingService.decide({
      action: dto.action,
      code: dto.code,
      issuer: dto.issuer ?? null,
      trigger: dto.trigger ?? null,
      evidenceRef: dto.evidenceRef ?? null,
      evidence: dto.evidence,
      idempotencyKey: idempotencyKey ?? null,
      actor: actorOf(request),
      correlationId,
    });
  }
}
