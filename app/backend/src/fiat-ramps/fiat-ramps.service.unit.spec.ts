jest.mock('@stellar/stellar-sdk', () => ({
  StellarTomlResolver: { resolve: jest.fn() },
}));

import { StellarTomlResolver } from '@stellar/stellar-sdk';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { FiatRampsService } from './fiat-ramps.service';

const domain = 'anchor.example.com';
const account = `G${'A'.repeat(55)}`;
const signedChallenge = 'signed-sep10-challenge';
const toml = {
  NAME: 'Example Anchor',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  WEB_AUTH_ENDPOINT: 'https://anchor.example.com/auth',
  TRANSFER_SERVER_SEP0024: 'https://anchor.example.com/sep24',
  KYC_SERVER: 'https://anchor.example.com/sep12',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function jwt(subject: string): string {
  const claims = Buffer.from(JSON.stringify({ sub: subject })).toString('base64url');
  return `header.${claims}.signature`;
}

describe('FiatRampsService', () => {
  let service: FiatRampsService;
  let fetchMock: jest.Mock;
  const resolver = StellarTomlResolver.resolve as jest.Mock;

  beforeEach(() => {
    service = new FiatRampsService();
    process.env.FIAT_RAMP_ALLOWED_ANCHOR_DOMAINS = domain;
    resolver.mockResolvedValue(toml);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete process.env.FIAT_RAMP_ALLOWED_ANCHOR_DOMAINS;
    delete process.env.FIAT_RAMP_ANCHOR_DOMAINS;
    jest.clearAllMocks();
  });

  it('discovers and normalizes SEP-24 assets, limits, fees, and country coverage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      deposit: {
        USDC: {
          enabled: true,
          authentication_required: true,
          min_amount: '10.0000001',
          max_amount: '1000',
          fee_fixed: '0.2500000',
          fee_percent: '1.5',
          country_codes: ['US'],
        },
        EURC: { enabled: true, country_codes: ['DE'] },
      },
      withdraw: { USDC: { enabled: true, fee_fixed: '2' } },
    }));

    const result = await service.getAvailableAnchors('USDC', 'US', domain);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: domain,
      name: 'Example Anchor',
      type: 'sep24',
      supportedAssets: ['USDC'],
      capabilities: {
        USDC: {
          deposit: {
            enabled: true,
            authenticationRequired: true,
            minAmount: '10.0000001',
            maxAmount: '1000',
            feeFixed: '0.2500000',
            feePercent: '1.5',
          },
          withdraw: { enabled: true, feeFixed: '2' },
        },
      },
    });
  });

  it('fetches and exchanges client-signed SEP-10 material before a SEP-24 deposit', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ deposit: { USDC: { min_amount: '0.0000001', max_amount: '25' } } }))
      .mockResolvedValueOnce(jsonResponse({ token: jwt(account) }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'anchor-transaction-1',
        type: 'interactive_customer_info_needed',
        url: 'https://anchor.example.com/interactive/1',
      }));

    const result = await service.initiateDeposit({
      assetCode: 'USDC',
      amount: '10.0000001',
      userAccount: account,
      anchorDomain: domain,
      signedChallenge,
    });

    expect(result).toEqual({
      status: 'success',
      transaction_id: 'anchor-transaction-1',
      type: 'interactive_customer_info_needed',
      url: 'https://anchor.example.com/interactive/1',
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      body: new URLSearchParams({ transaction: signedChallenge }),
    });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${jwt(account)}`);
    expect(String(fetchMock.mock.calls[2][1].body)).toContain('amount=10.0000001');
  });

  it('rejects an amount beyond the advertised maximum before authentication', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deposit: { USDC: { max_amount: '9.9999999' } } }));

    await expect(service.initiateDeposit({
      assetCode: 'USDC',
      amount: '10.0000000',
      userAccount: account,
      anchorDomain: domain,
      signedChallenge,
    })).rejects.toThrow(BadRequestException);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes SEP-12 customer status without exposing provider fields', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ deposit: {} }))
      .mockResolvedValueOnce(jsonResponse({ token: jwt(account) }))
      .mockResolvedValueOnce(jsonResponse({ id: 'customer-1', status: 'needs_more_info', private_field: 'omit' }));

    await expect(service.getKycStatus({
      anchorDomain: domain,
      userAccount: account,
      signedChallenge,
      customerId: 'customer-1',
    })).resolves.toEqual({
      status: 'success',
      customerId: 'customer-1',
      kycStatus: 'needs_info',
    });
  });

  it('does not accept callbacks without an authenticated protocol', async () => {
    await expect(service.handleKycCallback({ status: 'accepted' })).rejects.toThrow(ServiceUnavailableException);
    await expect(service.updateTransactionStatus({ status: 'completed' })).rejects.toThrow(ServiceUnavailableException);
  });

  it('rejects unconfigured anchor domains before discovery', async () => {
    await expect(service.getAvailableAnchors(undefined, undefined, 'other.example.com'))
      .rejects.toThrow(BadRequestException);
    expect(resolver).not.toHaveBeenCalled();
  });
});
