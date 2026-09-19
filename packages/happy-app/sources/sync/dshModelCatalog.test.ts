import { describe, expect, it } from 'vitest';
import type { Machine, MachineMetadata } from './storageTypes';
import { MachineMetadataSchema } from './storageTypes';
import {
    collectDshModelCatalog,
    getDshModelCatalogDefaultName,
    getMachineDshModelCatalog,
} from './dshModelCatalog';

function makeMachine(overrides: Partial<Machine> & { metadata?: MachineMetadata | null }): Machine {
    return {
        id: 'machine-1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 100,
        metadata: null,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        ...overrides,
    };
}

const CATALOG = {
    options: [
        { code: '["deepseek-official","deepseek-v4-flash"]', value: 'deepseek-v4-flash' },
        { code: '["deepseek-official","deepseek-v4-pro"]', value: 'DeepSeek-V4-Pro' },
    ],
    currentCode: '["deepseek-official","deepseek-v4-flash"]',
    detectedAt: 1234,
};

describe('dsh model catalog from machine metadata', () => {
    it('reads a published catalog', () => {
        const metadata = MachineMetadataSchema.parse({
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            happyHomeDir: '~/.happy',
            homeDir: '~',
            dshModels: CATALOG,
        });

        expect(getMachineDshModelCatalog(metadata)).toEqual({
            options: CATALOG.options,
            currentCode: '["deepseek-official","deepseek-v4-flash"]',
        });
    });

    it('treats a missing or empty catalog as none, not as a broken machine', () => {
        expect(getMachineDshModelCatalog(null)).toBeNull();
        expect(getMachineDshModelCatalog(undefined)).toBeNull();
        // A malformed catalog must not fail the machine metadata parse —
        // that would strip host and cliAvailability for every screen.
        const parsed = MachineMetadataSchema.parse({
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            happyHomeDir: '~/.happy',
            homeDir: '~',
            dshModels: { options: 'not-an-array', currentCode: 7 },
        });
        expect(parsed.host).toBe('localhost');
        expect(getMachineDshModelCatalog(parsed)).toBeNull();
        expect(getMachineDshModelCatalog(MachineMetadataSchema.parse({
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            happyHomeDir: '~/.happy',
            homeDir: '~',
            dshModels: { options: [], currentCode: null, detectedAt: 1 },
        }))).toBeNull();
    });

    it('collects from the liveliest machine that has a catalog', () => {
        const offline = makeMachine({
            id: 'offline',
            active: false,
            activeAt: 50,
            metadata: MachineMetadataSchema.parse({
                host: 'a', platform: 'darwin', happyCliVersion: 'test',
                happyHomeDir: '~/.happy', homeDir: '~', dshModels: CATALOG,
            }),
        });
        const online = makeMachine({
            id: 'online',
            active: true,
            activeAt: 10,
            metadata: MachineMetadataSchema.parse({
                host: 'b', platform: 'darwin', happyCliVersion: 'test',
                happyHomeDir: '~/.happy', homeDir: '~',
                dshModels: {
                    options: [{ code: '["p","m"]', value: 'Model One' }],
                    currentCode: '["p","m"]',
                },
            }),
        });
        const bare = makeMachine({ id: 'bare', active: true, activeAt: 900 });

        // Online wins over the more recently active offline machine.
        expect(collectDshModelCatalog([bare, offline, online])?.options[0].value).toBe('Model One');
        // With no online catalog, the offline one still serves.
        expect(collectDshModelCatalog([bare, offline])?.options).toEqual(CATALOG.options);
        expect(collectDshModelCatalog([bare])).toBeNull();
        expect(collectDshModelCatalog([])).toBeNull();
    });

    it('names the ambient default after the current model, or plainly without one', () => {
        expect(getDshModelCatalogDefaultName({
            options: [{ code: '["p","m"]', value: 'Model One' }],
            currentCode: '["p","m"]',
        })).toBe('Model One');
        expect(getDshModelCatalogDefaultName({
            options: [{ code: '["p","m"]', value: 'Model One' }],
            currentCode: '["p","gone"]',
        })).toBe('Default model');
        expect(getDshModelCatalogDefaultName(null)).toBe('Default model');
    });
});
