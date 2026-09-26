import { Injectable } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { SupabaseService, MarketplaceListing, MarketplaceBid } from '../supabase/supabase.service';
import { SupabaseUniqueConstraintError } from '../supabase/supabase.errors';
import { UsernamesService } from '../usernames/usernames.service';
import { AppConfigService } from '../config';
import { SupabaseError } from '../supabase/supabase.errors';
import { MarketplaceError, MarketplaceErrorCode } from './errors';
import {
  buildMarketplaceStateHints,
  buildBidSummary,
  resolveHighBidAmount,
  truncateStellarPublicKey,
} from './marketplace-listing-detail';
import { MarketplaceListingDetailDto } from './dto/marketplace-listing-detail.dto';

@Injectable()
export class MarketplaceService {
  private readonly maxActiveListingsPerSeller = 5;
  private readonly maxPendingBidsPerBidder = 5;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly usernames: UsernamesService,
    private readonly config: AppConfigService,
  ) {}

  async listUsername(
    username: string,
    sellerPublicKey: string,
    askingPrice: number,
  ): Promise<MarketplaceListing> {
    const normalized = username.trim().toLowerCase();

    if (this.config.marketplaceRestrictedUsernames.includes(normalized)) {
      throw new MarketplaceError(
        MarketplaceErrorCode.COMPLIANCE_RESTRICTED,
        'This username is restricted from marketplace listings',
      );
    }

    const owned = await this.usernames.listByPublicKey(sellerPublicKey);
    if (!owned.find((u) => u.username === normalized)) {
      throw new MarketplaceError(
        MarketplaceErrorCode.USERNAME_NOT_OWNED,
        'Username not found or does not belong to this wallet',
      );
    }

    const existing = await this.supabase.getActiveListingByUsername(normalized);
    if (existing) {
      throw new MarketplaceError(
        MarketplaceErrorCode.ALREADY_LISTED,
        'Username already has an active listing',
      );
    }

    if (await this.supabase.countActiveListingsBySeller(sellerPublicKey) >= this.maxActiveListingsPerSeller) {
      throw new MarketplaceError(
        MarketplaceErrorCode.LISTING_LIMIT_REACHED,
        `A wallet may have at most ${this.maxActiveListingsPerSeller} active listings`,
      );
    }

    try {
      return await this.supabase.createListing(normalized, sellerPublicKey, askingPrice);
    } catch (err) {
      if (err instanceof SupabaseError && err.message.includes('MARKETPLACE_ACTIVE_LISTING_LIMIT')) {
        throw new MarketplaceError(
          MarketplaceErrorCode.LISTING_LIMIT_REACHED,
          `A wallet may have at most ${this.maxActiveListingsPerSeller} active listings`,
        );
      }
      if (err instanceof SupabaseUniqueConstraintError) {
        throw new MarketplaceError(
          MarketplaceErrorCode.ALREADY_LISTED,
          'Username already has an active listing',
        );
      }
      throw err;
    }
  }

  async getActiveListings(
    limit: number = 20,
    cursor: string | null = null,
  ): Promise<{ listings: MarketplaceListing[]; total: number; next_cursor: string | null; has_more: boolean }> {
    return this.supabase.getActiveListings(limit, cursor);
  }

  async getListing(listingId: string): Promise<MarketplaceListing> {
    const listing = await this.supabase.getListingById(listingId);
    if (!listing) {
      throw new MarketplaceError(
        MarketplaceErrorCode.LISTING_NOT_FOUND,
        'Listing not found',
      );
    }
    return listing;
  }

  async getListingDetail(
    listingId: string,
    viewerPublicKey?: string | null,
  ): Promise<MarketplaceListingDetailDto> {
    const listing = await this.getListing(listingId);
    const bidPage = await this.supabase.getBidsByListingIdPaginated(
      listingId,
      50,
      null,
    );

    const highBidAmount = resolveHighBidAmount(
      Number(listing.asking_price),
      bidPage.bids,
    );

    return {
      listing,
      bids: bidPage.bids,
      bid_summary: buildBidSummary(bidPage.bids),
      seller: {
        public_key: listing.seller_public_key,
        display_key: truncateStellarPublicKey(listing.seller_public_key),
      },
      state_hints: buildMarketplaceStateHints(
        listing,
        highBidAmount,
        viewerPublicKey,
      ),
    };
  }

  async cancelListing(listingId: string, sellerPublicKey: string): Promise<void> {
    const listing = await this.getListing(listingId);

    if (listing.status === 'cancelled') {
      return;
    }

    if (listing.seller_public_key !== sellerPublicKey) {
      throw new MarketplaceError(
        MarketplaceErrorCode.UNAUTHORIZED,
        'Only the seller can cancel this listing',
      );
    }

    if (listing.status !== 'active') {
      throw new MarketplaceError(
        MarketplaceErrorCode.LISTING_NOT_ACTIVE,
        'Only active listings can be cancelled',
      );
    }

    await this.supabase.cancelListing(listingId);
  }

  async placeBid(
    listingId: string,
    bidderPublicKey: string,
    bidAmount: number,
    signature: string,
    signedAt: number,
  ): Promise<MarketplaceBid> {
    const listing = await this.getListing(listingId);

    if (listing.status !== 'active') {
      throw new MarketplaceError(
        MarketplaceErrorCode.LISTING_NOT_ACTIVE,
        'Listing is no longer active',
      );
    }

    if (listing.seller_public_key === bidderPublicKey) {
      throw new MarketplaceError(
        MarketplaceErrorCode.SELF_BID,
        'Seller cannot bid on their own listing',
      );
    }

    if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
      throw new MarketplaceError(
        MarketplaceErrorCode.INVALID_PRICE,
        'Bid amount must be a positive number',
      );
    }

    const minimumBid = Number(listing.asking_price) + 1;
    if (bidAmount < minimumBid) {
      throw new MarketplaceError(
        MarketplaceErrorCode.INVALID_PRICE,
        `Bid amount must be at least ${minimumBid}`,
      );
    }

    return this.supabase.placeBid(listingId, bidderPublicKey, bidAmount);
  }

  async getBids(listingId: string, limit: number = 20, cursor: string | null = null): Promise<{ bids: MarketplaceBid[]; next_cursor: string | null; has_more: boolean }> {
    await this.getListing(listingId);
    return this.supabase.getBidsByListingIdPaginated(listingId, limit, cursor);
  }

  async acceptBid(
    listingId: string,
    bidId: string,
    sellerPublicKey: string,
  ): Promise<void> {
    const listing = await this.getListing(listingId);

    if (listing.seller_public_key !== sellerPublicKey) {
      throw new MarketplaceError(
        MarketplaceErrorCode.UNAUTHORIZED,
        'Only the seller can accept a bid',
      );
    }

    if (listing.status !== 'active') {
      throw new MarketplaceError(
        MarketplaceErrorCode.LISTING_NOT_ACTIVE,
        'Listing is no longer active',
      );
    }

    const bid = await this.supabase.getBidById(bidId);
    if (!bid || bid.listing_id !== listingId) {
      throw new MarketplaceError(
        MarketplaceErrorCode.BID_NOT_FOUND,
        'Bid not found on this listing',
      );
    }

    if (bid.status !== 'pending') {
      throw new MarketplaceError(
        MarketplaceErrorCode.BID_NOT_PENDING,
        'Bid is no longer pending',
      );
    }

    await this.supabase.acceptBid(listingId, bidId, sellerPublicKey);
  }
}
