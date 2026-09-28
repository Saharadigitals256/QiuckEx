/**
 * UsernameReconciliationController — admin endpoints for on-chain username
 * claim reconciliation.
 *
 * Issue #193.
 *
 * All routes require an admin-scoped API key (`X-API-Key: <admin-key>`).
 *
 *  POST   /admin/username/reconciliation/run              — run a batch
 *  GET    /admin/username/reconciliation/status/:username — per-username status
 *  POST   /admin/username/reconciliation/unflag/:username — clear a flag
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { UsernameReconciliationService } from './username-reconciliation.service';

@ApiTags('username-reconciliation')
@Controller('admin/username/reconciliation')
@UseGuards(ApiKeyGuard)
@RequireScopes('admin')
export class UsernameReconciliationController {
  constructor(
    private readonly reconciliationService: UsernameReconciliationService,
  ) {}

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a batch on-chain username claim reconciliation',
    description:
      'Fetches up to `batchSize` claimed usernames and verifies each against Horizon. ' +
      'Accounts absent on-chain (404) are flagged (ownership_status=flagged). ' +
      'Transient Horizon errors are counted as skipped and are safely retryable. ' +
      'Gated by `username.claim_reconciliation` feature flag (dev/test only by default).',
  })
  @ApiQuery({ name: 'batchSize', required: false, type: 'number', example: 50 })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: 'string',
    description: 'ISO created_at timestamp for pagination across large datasets',
  })
  @ApiResponse({ status: 200, description: 'Reconciliation run report' })
  @ApiResponse({ status: 503, description: 'FEATURE_DISABLED — flag is off' })
  async runBatch(
    @Query('batchSize') batchSize?: string,
    @Query('cursor') cursor?: string,
  ) {
    const report = await this.reconciliationService.runBatchReconciliation(
      batchSize ? Number(batchSize) : 50,
      cursor,
    );
    return { ok: true, data: report };
  }

  @Get('status/:username')
  @ApiOperation({
    summary: 'Get on-chain reconciliation status for a username',
    description:
      'Returns the current `ownership_status` and `last_active_at` for a username. ' +
      'Does NOT make a live Horizon call; returns the last persisted state.',
  })
  @ApiParam({ name: 'username', type: 'string', example: 'alice' })
  @ApiResponse({ status: 200, description: 'Ownership status' })
  @ApiResponse({ status: 404, description: 'RECONCILE_USERNAME_NOT_FOUND' })
  async getStatus(@Param('username') username: string) {
    const data = await this.reconciliationService.getReconciliationStatus(username);
    return { ok: true, data };
  }

  @Post('unflag/:username')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear a squatting / review flag from a username',
    description:
      'Restores ownership_status to "claimed" after an admin manually verifies ' +
      'the username is not squatted. Gated by the reconciliation feature flag.',
  })
  @ApiParam({ name: 'username', type: 'string', example: 'alice' })
  @ApiResponse({ status: 200, description: 'Flag cleared' })
  @ApiResponse({ status: 404, description: 'RECONCILE_USERNAME_NOT_FOUND' })
  @ApiResponse({ status: 503, description: 'FEATURE_DISABLED' })
  async unflag(@Param('username') username: string) {
    await this.reconciliationService.unflagUsername(username);
    return { ok: true };
  }
}
