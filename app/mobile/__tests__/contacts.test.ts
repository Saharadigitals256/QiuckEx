import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deleteContact,
  getContacts,
  isValidContactAddress,
  saveContact,
  updateContact,
} from '../services/contacts';

const ADDRESS = 'GAMOSFOKEYHFDGMXIEFEYBUYK3ZMFYN3PFLOTBRXFGBFGRKBKLQSLGLP';
const OTHER_ADDRESS = 'GBDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ2';

jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (key: string) => store[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete store[key];
    }),
    clear: jest.fn(async () => {
      store = {};
    }),
  };
});

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'contact-1'),
}));

describe('device-local contacts', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('accepts Stellar public keys and rejects invalid addresses', () => {
    expect(isValidContactAddress(ADDRESS)).toBe(true);
    expect(isValidContactAddress('0x123')).toBe(false);
    expect(isValidContactAddress('')).toBe(false);
  });

  it('creates, updates, reads, and deletes contacts without a network call', async () => {
    const created = await saveContact({
      address: ADDRESS,
      nickname: 'Alice',
      tags: ['Friends'],
    });

    expect(await getContacts()).toEqual([created]);

    await updateContact({
      ...created,
      address: OTHER_ADDRESS,
      nickname: 'Alice Updated',
      tags: ['Favorites'],
    });
    expect(await getContacts()).toEqual([
      expect.objectContaining({
        id: 'contact-1',
        address: OTHER_ADDRESS,
        nickname: 'Alice Updated',
        tags: ['Favorites'],
      }),
    ]);

    await deleteContact(created.id);
    expect(await getContacts()).toEqual([]);
  });

  it('recovers from malformed local storage', async () => {
    await AsyncStorage.setItem('contacts', '{bad json');
    expect(await getContacts()).toEqual([]);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('contacts');
  });
});
