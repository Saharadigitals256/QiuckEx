/**
 * UsernameExpiryController — HTTP endpoints for username reservation expiry
 * and anti-squatting safeguards.
 *
 * Issue #194.
 *
 * Public routes (throttled, feature-gated):
 *  POST   /username/reserve                  — reserve a username
 *  DELETE /username/reserve/:reservationId   — release a reservation
 *  GET    /username/reserve/:reservationId   — check reservation status
 *
 * Admin routes (require ApiKeyGuard + 'admin' scope):
 *  POST   /admin/username/expiry/sweep       — trigger expiry sweep
 *  POST   /admin/username/squatting/sweep    — trigger anti-squatting sweep
 *  POST   /admin/username/squatting/clear/:username — clear a flag
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { UsernameExpiryService } from './username-expiry.service';

// ---------------------------------------------------------------------------
// Public controller
// ---------------------------------------------------------------------------

@ApiTags('username-reservation')
@Controller('username/reserve')
export class UsernameReservationController {
  constructor(private readonly expiryService: UsernameExpiryService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reserve a username for a wallet',
    description:
      'Reserves a username for up to 15 minutes (configurable). ' +
      'Supply an idempotency key as `reservationId` (UUID) to safely retry. ' +
      'Throws 409 if the username is already reserved by another wallet. ' +
      'Throws 410 if the username is permanently claimed.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['username', 'publicKey'],
      properties: {
        username: { type: 'string', example: 'alice' },
        publicKey: { type: 'string', example: 'GBXGQ55JMQ4...' },
        reservationId: {
          type: 'string',
          format: 'uuid',
          description: 'Optional client-supplied idempotency key (UUID)',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Reservation created' })
  @ApiResponse({ status: 409, description: 'RESERVATION_CONFLICT — already reserved by another wallet' })
  @ApiResponse({ status: 410, description: 'USERNAME_ALREADY_CLAIMED — username is permanently owned' })
  @ApiResponse({ status: 503, description: 'FEATURE_DISABLED — feature flag is off' })
  async reserve(
    @Body() body: { username: string; publicKey: string; reservationId?: string },
  ) {
    const result = await this.expiryService.reserveUsername(
      body.username,
      body.publicKey,
      body.reservationId,
    );
    return { ok: true, data: result };
  }

  @Delete(':reservationId')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release / cancel an active reservation' })
  @ApiParam({ name: 'reservationId', type: 'string', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['publicKey'],
      properties: {
        publicKey: { type: 'string', example: 'GBXGQ55JMQ4...' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Reservation released' })
  @ApiResponse({ status: 404, description: 'RESERVATION_NOT_FOUND' })
  @ApiResponse({ status: 503, description: 'FEATURE_DISABLED' })
  async release(
    @Param('reservationId') reservationId: string,
    @Body() body: { publicKey: string },
  ) {
    await this.expiryService.releaseReservation(reservationId, body.publicKey);
    return { ok: true };
  }

  @Get(':reservationId')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Check the status of a reservation' })
  @ApiParam({ name: 'reservationId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Reservation status' })
  @ApiResponse({ status: 404, description: 'RESERVATION_NOT_FOUND' })
  async status(@Param('reservationId') reservationId: string) {
    const data = await this.expiryService.getReservationStatus(reservationId);
    return { ok: true, data };
  }
}

// ---------------------------------------------------------------------------
// Admin controller
// ---------------------------------------------------------------------------

@ApiTags('username-expiry-admin')
@Controller('admin/username')
@UseGuards(ApiKeyGuard)
@RequireScopes('admin')
export class UsernameExpiryAdminController {
  constructor(private readonly expiryService: UsernameExpiryService) {}

  @Post('expiry/sweep')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger the reservation expiry sweep',
    description:
      'Expires all reservations whose window has lapsed. ' +
      'Sets ownership_status=expired and clears reserved_* columns. ' +
      'Idempotent and safe to call at any time.',
  })
  @ApiResponse({ status: 200, description: 'Sweep complete' })
  async expirySweep() {
    const result = await this.expiryService.sweepExpiredReservations();
    return { ok: true, data: result };
  }

  @Post('squatting/sweep')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger the anti-squatting inactivity sweep',
    description:
      'Flags claimed usernames that have been inactive for longer than the configured ' +
      'threshold (default 180 days). Processing is batched to avoid long-running queries.',
  })
  @ApiQuery({
    name: 'inactivityDays',
    required: false,
    type: 'number',
    description: 'Override default inactivity threshold (must be 1–3650)',
  })
  @ApiResponse({ status: 200, description: 'Sweep complete' })
  @ApiResponse({ status: 503, description: 'FEATURE_DISABLED' })
  async squattingSweep(@Query('inactivityDays') inactivityDays?: string) {
    const days = inactivityDays != null ? Number(inactivityDays) : undefined;
    const result = await this.expiryService.sweepInactiveUsernames(days);
    return { ok: true, data: result };
  }

  @Post('squatting/clear/:username')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear a squatting flag after manual admin review',
    description: 'Clears squatting_flagged_at and restores ownership_status to claimed.',
  })
  @ApiParam({ name: 'username', type: 'string' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['publicKey'],
      properties: {
        publicKey: { type: 'string', description: 'Owner public key for ownership verification' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Flag cleared' })
  @ApiResponse({ status: 503, description: 'FEATURE_DISABLED' })
  async clearFlag(
    @Param('username') username: string,
    @Body() body: { publicKey: string },
  ) {
    await this.expiryService.clearSquattingFlag(username, body.publicKey);
    return { ok: true };
  }
}
