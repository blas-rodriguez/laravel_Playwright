import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const directory = path.resolve("storage/framework/testing");
mkdirSync(directory, { recursive: true });
const database = path.join(directory, "e2e.sqlite");
writeFileSync(database, "");
const env = {
    ...process.env,
    APP_ENV: "testing",
    APP_DEBUG: "false",
    APP_KEY: "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    APP_URL: "http://127.0.0.1:8010",
    DB_CONNECTION: "sqlite",
    DB_DATABASE: database,
    DB_URL: "",
    CACHE_STORE: "file",
    SESSION_DRIVER: "file",
    QUEUE_CONNECTION: "database",
};
const migrated = spawnSync(
    "php",
    ["artisan", "migrate", "--force", "--no-interaction"],
    { env, stdio: "inherit" },
);
if (migrated.status !== 0) process.exit(migrated.status ?? 1);
const children = [
    spawn("php", ["artisan", "serve", "--host=127.0.0.1", "--port=8010"], {
        env,
        stdio: "inherit",
    }),
    spawn(
        "php",
        ["artisan", "queue:work", "--tries=1", "--timeout=210", "--sleep=1"],
        { env, stdio: "inherit" },
    ),
];
const stop = () => {
    for (const child of children) child.kill();
};
process.on("SIGINT", () => {
    stop();
    process.exit(0);
});
process.on("SIGTERM", () => {
    stop();
    process.exit(0);
});
process.on("exit", stop);
for (const child of children) {
    child.on("error", (error) => {
        console.error(error);
        stop();
        process.exit(1);
    });
    child.on("exit", (code) => {
        stop();
        process.exit(code ?? 0);
    });
}
