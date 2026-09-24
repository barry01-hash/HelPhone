/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { visualizer } from "rollup-plugin-visualizer";
import { envFirewallVitePlugin } from "./scripts/security/env_firewall.js";
import deadcodePruner from "./plugins/vite-plugin-deadcode-pruner.js";

export default defineConfig(({ mode }) => ({
  css: {
    modules: {
      generateScopedName: mode === "production"
        ? "[name]__[local]___[hash:base64:5]"
        : "[name]__[local]",
    },
  },
  plugins: [
    react(),
    // #626: fails the build if static output contains leaked secrets.
    envFirewallVitePlugin(),
    deadcodePruner(),
    visualizer({
      open: false,
      filename: 'dist/stats.html',
      template: 'sunburst',
    }),
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "service-worker.js",
      injectManifest: {
        // Raise limit to 10MB to accommodate Barretenberg WASM/JS bundles
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      manifest: {
        name: "HelPhone - Emergency Response Network",
        short_name: "HelPhone",
        description:
          "Decentralized emergency response network powered by Stellar blockchain",
        theme_color: "#234B4E",
        background_color: "#ECE0CC",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/assets/helphone-icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/assets/helphone-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
        screenshots: [
          {
            src: "/assets/screenshot-1.png",
            sizes: "540x720",
            type: "image/png",
            form_factor: "narrow",
          },
          {
            src: "/assets/screenshot-2.png",
            sizes: "1280x720",
            type: "image/png",
            form_factor: "wide",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wav,mp4,wasm,json}"],
        globIgnores: ["**/node_modules/**/*", "dist/stats.html", "**/security-surface-report.json"],
        // Raise limit to 10MB to accommodate Barretenberg WASM/JS bundles
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "mapbox-api-cache",
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /^https:\/\/tiles\.mapbox\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "mapbox-tiles-cache",
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /.*\.(wasm|json)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "wasm-json-cache",
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
        ],
      },
    }),
  ],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.js"],
    include: ["test/**/*.test.js", "test/**/*.test.jsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.{js,jsx}"],
      exclude: [
        "node_modules/",
        "test/",
        "tests/",
        "dist/",
        "**/*.config.js",
        "**/*.config.mjs",
        "**/setup.js",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          // WASM binaries - isolate for lazy loading
          if (id.includes(".wasm") || id.includes("barretenberg") || id.includes("acvm"))
            return "zk-wasm";

          // ZK/Noir libraries - heavy, lazy-loaded
          if (id.includes("@noir-lang") || id.includes("@aztec/bb.js"))
            return "zk";

          // Mapbox GL - heavy map rendering
          if (id.includes("mapbox-gl") || id.includes("react-map-gl"))
            return "mapbox";

          // Stellar SDK - blockchain interactions
          if (
            id.includes("@stellar/stellar-sdk") ||
            id.includes("stellar-wallets-kit") ||
            id.includes("soroban-client")
          )
            return "stellar";

          // React core - critical path
          if (
            id.includes("react-dom") ||
            id.includes("react-router") ||
            id.includes("scheduler")
          )
            return "react-core";

          // i18n - can be deferred
          if (id.includes("react-i18next") || id.includes("i18next"))
            return "i18n";

          // Supabase - backend client
          if (id.includes("@supabase"))
            return "supabase";

          // Buffer polyfill
          if (id.includes("buffer"))
            return "buffer";

          // Everything else
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: {
      "/zk": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  optimizeDeps: {
    exclude: [
      "@noir-lang/noir_js",
      "@noir-lang/backend_barretenberg",
      "@noir-lang/acvm_js",
      "@noir-lang/noirc_abi",
      "@aztec/bb.js",
    ],
    include: ["buffer", "fuse.js"],
  },
  worker: {
    format: "es",
  },
  define: {
    "import.meta.env.VITE_WASM_MAX_MEMORY_MB": JSON.stringify(512),
  },
}));
