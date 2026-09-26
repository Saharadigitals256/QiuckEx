import { Module } from '@nestjs/common';

import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { AuditModule } from '../audit/audit.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { MetricsModule } from '../metrics/metrics.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { AssetListingAdminController } from './asset-listing-admin.controller';
import { AssetListingController } from './asset-listing.controller';
import { AssetListingService } from './asset-listing.service';
import { ASSET_LISTING_STORE, SupabaseAssetListingStore } from './asset-listing.store';

@Module({
  imports: [SupabaseModule, ApiKeysModule, AuditModule, FeatureFlagsModule, MetricsModule],
  controllers: [AssetListingController, AssetListingAdminController],
  providers: [
    AssetListingService,
    { provide: ASSET_LISTING_STORE, useClass: SupabaseAssetListingStore },
    ApiKeyGuard,
  ],
  exports: [AssetListingService, ASSET_LISTING_STORE],
})
export class AssetListingModule {}
