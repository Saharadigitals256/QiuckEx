import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { RateLimitGroupTag } from '../auth/decorators/rate-limit-group.decorator';
import { AssetListingService } from './asset-listing.service';

/**
 * Public asset listing policy surface (issue #306).
 *
 * Clients read the published policy (tiers, statuses, triggers, error codes) so
 * they can render labels and handle `ASSET_LISTING_*` errors without hardcoding
 * policy knowledge. No personal data, no secrets.
 */
@ApiTags('asset-listing')
@ApiHeader({
  name: 'X-API-Key',
  description: 'Optional API key for higher rate limits',
  required: false,
})
@UseGuards(ApiKeyGuard)
@RateLimitGroupTag('public')
@Controller('asset-listing')
export class AssetListingController {
  constructor(private readonly assetListingService: AssetListingService) {}

  @Get('policy')
  @ApiOperation({
    summary: 'Get the published asset listing policy',
    description:
      'Machine-readable view of docs/policies/ASSET-LISTING-POLICY.md: tiers, listing states, transitions, ' +
      'delisting triggers, evidence maximum ages, error codes and feature flags.',
  })
  @ApiResponse({ status: 200, description: 'Asset listing policy document' })
  getPolicy() {
    return this.assetListingService.getPolicy();
  }
}
