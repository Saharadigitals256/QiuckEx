import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { FiatRampsService } from './fiat-ramps.service';

@ApiTags('fiat-ramps')
@Controller('fiat-ramps')
export class FiatRampsController {
  constructor(private readonly fiatRampsService: FiatRampsService) {}

  @Get('anchors')
  @ApiOperation({ summary: 'Fetch available anchors based on user location/asset' })
  @ApiResponse({ status: 200, description: 'List of available anchors' })
  async getAvailableAnchors(
    @Query('assetCode') assetCode?: string,
    @Query('country') country?: string,
    @Query('anchorDomain') anchorDomain?: string,
  ) {
    return this.fiatRampsService.getAvailableAnchors(assetCode, country, anchorDomain);
  }

  @Get('sep10/challenge')
  @ApiOperation({ summary: 'Fetch a SEP-10 challenge for the client to sign' })
  async getSep10Challenge(
    @Query('anchorDomain') anchorDomain: string,
    @Query('userAccount') userAccount: string,
  ) {
    return this.fiatRampsService.getSep10Challenge(anchorDomain, userAccount);
  }

  @Post('deposit')
  @ApiOperation({ summary: 'Initiate SEP-24 hosted deposit flow' })
  @ApiResponse({ status: 201, description: 'Deposit flow initiated' })
  async initiateDeposit(@Body() depositDto: {
    assetCode: string;
    amount: number | string;
    userAccount: string;
    anchorDomain: string;
    signedChallenge: string;
    countryCode?: string;
    lang?: string;
  }) {
    return this.fiatRampsService.initiateDeposit(depositDto);
  }

  @Post('withdraw')
  @ApiOperation({ summary: 'Initiate SEP-24 hosted withdrawal flow' })
  @ApiResponse({ status: 201, description: 'Withdrawal flow initiated' })
  async initiateWithdrawal(@Body() withdrawalDto: {
    assetCode: string;
    amount: number | string;
    userAccount: string;
    anchorDomain: string;
    signedChallenge: string;
    countryCode?: string;
    lang?: string;
  }) {
    return this.fiatRampsService.initiateWithdrawal(withdrawalDto);
  }

  @Post('kyc/status')
  @ApiOperation({ summary: 'Fetch normalized customer KYC status from the SEP-12 server' })
  async getKycStatus(@Body() params: {
    anchorDomain: string;
    userAccount: string;
    signedChallenge: string;
    customerId?: string;
  }) {
    return this.fiatRampsService.getKycStatus(params);
  }

  @Post('kyc/callback')
  @ApiOperation({ summary: 'Handle KYC redirects and updates' })
  async handleKycCallback(@Body() callbackData: unknown) {
    return this.fiatRampsService.handleKycCallback(callbackData);
  }

  @Post('transaction/status')
  @ApiOperation({ summary: 'Securely handle transaction status updates' })
  async updateTransactionStatus(@Body() statusData: unknown) {
    return this.fiatRampsService.updateTransactionStatus(statusData);
  }
}
