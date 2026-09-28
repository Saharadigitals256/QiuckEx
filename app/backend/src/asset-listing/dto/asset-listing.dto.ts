import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ASSET_LISTING_TRIGGERS } from '../asset-listing.policy';

const TRIGGER_IDS = ASSET_LISTING_TRIGGERS.map((trigger) => trigger.id);

export class AssetListingEvidenceDto {
  @ApiProperty({
    description: 'Evidence kind required by the listing tier',
    enum: ['toml_document', 'attestation_of_reserve', 'issuer_identity', 'sanctions_screen', 'security_review'],
  })
  @IsEnum(['toml_document', 'attestation_of_reserve', 'issuer_identity', 'sanctions_screen', 'security_review'])
  kind!: 'toml_document' | 'attestation_of_reserve' | 'issuer_identity' | 'sanctions_screen' | 'security_review';

  @ApiProperty({
    description: 'ISO-8601 timestamp when this evidence expires (inclusive)',
    example: '2027-01-01T00:00:00.000Z',
  })
  @IsISO8601()
  expiresAt!: string;
}

export class AssetListingDecisionDto {
  @ApiProperty({
    description: 'Governed action',
    enum: ['list', 'reject', 'suspend', 'delist'],
  })
  @IsEnum(['list', 'reject', 'suspend', 'delist'])
  action!: 'list' | 'reject' | 'suspend' | 'delist';

  @ApiProperty({ description: 'Asset code (max 12 characters)', example: 'USDC' })
  @IsString()
  @MaxLength(12)
  @Matches(/^[A-Za-z0-9]{1,12}$/)
  code!: string;

  @ApiPropertyOptional({
    description: 'Issuer public key; omit for the native asset (XLM)',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @IsOptional()
  @IsString()
  @Length(56, 56)
  issuer?: string | null;

  @ApiPropertyOptional({
    description: 'Delisting trigger that justifies the decision',
    enum: TRIGGER_IDS,
  })
  @IsOptional()
  @IsEnum(TRIGGER_IDS)
  trigger?: string;

  @ApiPropertyOptional({
    description: 'Reference to the evidence artefact (incident id, review record). No personal data.',
    example: 'INC-1234',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  evidenceRef?: string;

  @ApiPropertyOptional({
    description: 'Evidence set to record with the decision (required for list decisions)',
    type: [AssetListingEvidenceDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AssetListingEvidenceDto)
  evidence?: AssetListingEvidenceDto[];
}
