import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertPublicUrl } from "./lib/network-policy.mjs";

export async function scrape(recipe, outputDir, { allowFixture = false } = {}) {
    const started = Date.now();
    const policy = (url) => assertPublicUrl(url, { allowFixture });
    await policy(recipe.url);
    if (
        !recipe.item_selector ||
        !Array.isArray(recipe.fields) ||
        !recipe.fields.length
    ) {
        throw new Error("La receta necesita un selector de filas y campos.");
    }
    const maxPages = Math.min(5, Math.max(1, Number(recipe.max_pages) || 1));
    await mkdir(outputDir, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
        userAgent: "ScrapeLab/1.0 (portfolio demo; public pages only)",
        serviceWorkers: "block",
        acceptDownloads: false,
    });
    let traceStarted = false;
    let navigationError = null;
    try {
        await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: false,
        });
        traceStarted = true;
        await context.route("**/*", async (route) => {
            let response;
            try {
                await policy(route.request().url());
                if (["media", "font"].includes(route.request().resourceType()))
                    return await route.abort();
                // Playwright routes only the first request in a redirect chain.
                // Fetch one response without following redirects, then fulfill it.
                response = await route.fetch({
                    maxRedirects: 0,
                    timeout: 25000,
                });
                const location = response.headers()["location"];
                if (
                    response.status() >= 300 &&
                    response.status() < 400 &&
                    location
                ) {
                    const destination = new URL(
                        location,
                        route.request().url(),
                    );
                    await policy(destination.href);
                    throw new Error(
                        `La URL redirige. Usá directamente la dirección final: ${destination.href}`,
                    );
                }
                await route.fulfill({ response });
            } catch (error) {
                if (
                    route.request().isNavigationRequest() &&
                    route.request().frame() ===
                        route.request().frame().page().mainFrame()
                ) {
                    navigationError = error;
                }
                await route.abort("blockedbyclient");
            } finally {
                await response?.dispose();
            }
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        page.setDefaultNavigationTimeout(25000);
        const records = [],
            pages = [],
            visited = new Set();
        let next = recipe.url;
        for (let index = 0; index < maxPages && next; index++) {
            await policy(next);
            if (visited.has(next)) break;
            visited.add(next);
            const response = await page.goto(next, {
                waitUntil: "domcontentloaded",
            });
            if (!response || response.status() >= 400)
                throw new Error(
                    `El sitio respondió HTTP ${response?.status() ?? "sin respuesta"}.`,
                );
            await page
                .locator(recipe.item_selector)
                .first()
                .waitFor({ state: "visible" });
            const count = await page.locator(recipe.item_selector).count();
            if (count > 100)
                throw new Error(
                    "El selector devolvió más de 100 filas por página. Usá uno más específico.",
                );
            const rows = await page
                .locator(recipe.item_selector)
                .evaluateAll((items, fields) => {
                    return items.map((item) =>
                        Object.fromEntries(
                            fields.map((field) => {
                                const element =
                                    field.selector === ":scope"
                                        ? item
                                        : item.querySelector(field.selector);
                                let value = element
                                    ? field.attribute
                                        ? element.getAttribute(field.attribute)
                                        : element.textContent
                                    : null;
                                if (
                                    value &&
                                    ["href", "src"].includes(field.attribute)
                                ) {
                                    try {
                                        value = new URL(value, document.baseURI)
                                            .href;
                                    } catch {
                                        /* preserve original */
                                    }
                                }
                                return [
                                    field.name,
                                    value === null
                                        ? null
                                        : value
                                              .replace(/\s+/g, " ")
                                              .trim()
                                              .slice(0, 5000),
                                ];
                            }),
                        ),
                    );
                }, recipe.fields);
            records.push(
                ...rows.map((data) => ({
                    data,
                    source_url: page.url(),
                    page_number: index + 1,
                })),
            );
            pages.push({
                url: page.url(),
                title: await page.title(),
                count: rows.length,
            });
            await page.screenshot({
                path: path.join(outputDir, "screenshot.png"),
                fullPage: false,
            });
            next = null;
            if (recipe.next_selector && index + 1 < maxPages) {
                const link = page.locator(recipe.next_selector).first();
                if (await link.count()) {
                    const href = await link.getAttribute("href");
                    if (href) {
                        const candidate = new URL(href, page.url());
                        if (candidate.origin !== new URL(recipe.url).origin)
                            throw new Error(
                                "La paginación debe permanecer en el mismo origen.",
                            );
                        next = candidate.href;
                        await page.waitForTimeout(700);
                    }
                }
            }
        }
        return { records, pages, duration_ms: Date.now() - started };
    } catch (error) {
        throw new Error(
            `No se pudo completar la extracción: ${(navigationError ?? error).message}`,
            { cause: error },
        );
    } finally {
        if (traceStarted)
            await context.tracing
                .stop({ path: path.join(outputDir, "trace.zip") })
                .catch(() => {});
        await browser.close();
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    try {
        let input = "";
        for await (const chunk of process.stdin) {
            input += chunk;
            if (input.length > 20000)
                throw new Error("Configuración demasiado grande.");
        }
        const result = await scrape(JSON.parse(input), process.argv[2]);
        process.stdout.write(JSON.stringify(result));
    } catch (error) {
        process.stderr.write(error.message.slice(0, 4000));
        process.exitCode = 1;
    }
}
