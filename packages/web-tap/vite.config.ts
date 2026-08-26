import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [react()],
    build: {
        outDir: "dist",
    },
    server: {
        host: "127.0.0.1",
        proxy: {
            "/api/events": "http://127.0.0.1:4319",
            "/api/events/stream": "http://127.0.0.1:4319",
        },
    },
    test: {
        environment: "jsdom",
        include: ["test/web/**/*.test.{ts,tsx}"],
        setupFiles: ["./test/web/setup.ts"],
    },
});
