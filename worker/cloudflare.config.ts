import { bindings, defineConfig, exports } from 'cf/config';

export default defineConfig({
    accountId: 'cfe4d5509587910a3d9569bd4e833c64',
    worker: {
        name: 'agentic',
        compatibilityDate: '2025-09-12',
        entrypoint: 'server/index.js',
        workersDev: false,
        observability: { enabled: true },
        assets: { notFoundHandling: 'single-page-application' },
        domains: ['agentic.yanglong.yun'],
        exports: {
            TerminalSessionManager: exports.durableObject({ storage: 'sqlite' }),
        },
        env: {
            DB: bindings.d1({ name: 'agentic', id: '3dda6815-1772-4bfd-b0c6-287e0134a6e3' }),
            TERMINAL_SESSION_MANAGER: bindings.durableObject({ worker: 'agentic', exportName: 'TerminalSessionManager' }),
            ASSETS: bindings.assets(),
            IMAGES: bindings.r2({ name: "agentic" }),
            SETTINGS_KEY: bindings.secret(),
            DEVICE_TOKEN: bindings.secret(),
            ACCESS_PASSWORD: bindings.secret(),
        },
    },
});
