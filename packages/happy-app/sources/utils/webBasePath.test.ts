import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from '@babel/core';

const appConfigPath = fileURLToPath(new URL('../../app.config.js', import.meta.url));
const skiaLoaderPath = fileURLToPath(new URL('./loadSkia.web.ts', import.meta.url));
const faviconPath = fileURLToPath(new URL('./web/faviconGenerator.ts', import.meta.url));
const requireFromApp = createRequire(appConfigPath);

afterEach(() => vi.unstubAllEnvs());

describe('web deployment base path', () => {
    it.each([
        [undefined, '/session/example', '/canvaskit.wasm'],
        ['/happy', '/happy/session/example', '/happy/canvaskit.wasm'],
    ])('loads public assets from the %s deployment root after Expo compilation', async (basePath, pagePath, assetPath) => {
        vi.stubEnv('HAPPY_WEB_BASE_PATH', basePath);
        vi.stubEnv('NODE_ENV', 'production');

        const configExports = {} as { default: { expo: { experiments: { baseUrl: string } } } };
        const configCode = transformSync(readFileSync(appConfigPath, 'utf8'), {
            filename: appConfigPath,
            configFile: false,
            babelrc: false,
            plugins: ['@babel/plugin-transform-modules-commonjs'],
        })!.code!;
        runInNewContext(configCode, { exports: configExports, require: requireFromApp, process });
        expect(configExports.default.expo.experiments.baseUrl).toBe(basePath ?? '');

        const caller = {
            name: 'metro',
            bundler: 'metro',
            platform: 'web',
            isDev: false,
            baseUrl: configExports.default.expo.experiments.baseUrl,
        };
        const loaderCode = transformSync(readFileSync(skiaLoaderPath, 'utf8'), {
            filename: skiaLoaderPath,
            configFile: false,
            babelrc: false,
            presets: ['babel-preset-expo'],
            caller,
        })!.code!;
        const loadSkia = vi.fn(async (_options: { locateFile: (file: string) => string }) => {});
        const loaderExports = {} as { loadSkia: () => Promise<void> };
        runInNewContext(loaderCode, {
            exports: loaderExports,
            require: (name: string) => name === '@shopify/react-native-skia/lib/module/web'
                ? { LoadSkia: loadSkia }
                : requireFromApp(name),
        });
        await loaderExports.loadSkia();

        expect(loadSkia).toHaveBeenCalledOnce();
        const { locateFile } = loadSkia.mock.calls[0][0];
        expect(new URL(locateFile('canvaskit.wasm'), `https://example.com${pagePath}`).pathname)
            .toBe(assetPath);

        const faviconCode = transformSync(readFileSync(faviconPath, 'utf8'), {
            filename: faviconPath,
            configFile: false,
            babelrc: false,
            presets: ['babel-preset-expo'],
            caller,
        })!.code!;
        const link = { href: '' };
        const faviconExports = {} as { resetFavicon: () => void; updateFaviconWithNotification: () => void };
        runInNewContext(faviconCode, {
            exports: faviconExports,
            document: { querySelector: () => link },
        });
        faviconExports.updateFaviconWithNotification();
        expect(new URL(link.href, `https://example.com${pagePath}`).pathname)
            .toBe(`${basePath ?? ''}/favicon-active.ico`);
        faviconExports.resetFavicon();
        expect(new URL(link.href, `https://example.com${pagePath}`).pathname)
            .toBe(`${basePath ?? ''}/favicon.ico`);
    });
});
