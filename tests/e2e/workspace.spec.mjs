import { test, expect } from "@playwright/test";

test("workspace loads and presets configure the recipe", async ({ page }) => {
    await page.goto("/");
    await expect(
        page.getByRole("heading", { name: "Datos web, sin copiar y pegar." }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Catálogo de libros/ }).click();
    await expect(page.locator("#url")).toHaveValue(
        "https://books.toscrape.com/",
    );
    await expect(page.locator("#item_selector")).toHaveValue(
        "article.product_pod",
    );
    const fields = JSON.parse(await page.locator("#fields").inputValue());
    expect(fields[0].attribute).toBe("title");
    await page.getByRole("button", { name: /Citas y autores/ }).click();
    await expect(page.locator("#url")).toHaveValue(
        "https://quotes.toscrape.com/js/",
    );
});

test("invalid JSON displays validation feedback", async ({ page }) => {
    await page.goto("/");
    await page.locator("#fields").fill("{ invalid");
    await page.getByRole("button", { name: /Iniciar extracción/ }).click();
    await expect(page.getByRole("alert")).toContainText(
        "Revisá la configuración",
    );
    await expect(page.locator("#submit-button")).toBeEnabled();
    await expect(page.locator("#fields")).toHaveValue("{ invalid");
});

test("mobile workspace has no horizontal page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(
        page.getByRole("button", { name: /Iniciar extracción/ }),
    ).toBeVisible();
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
    ).toBe(true);
});

test("live demo: UI → database queue → Chromium → exports", async ({
    page,
}) => {
    test.skip(
        process.env.SCRAPELAB_LIVE_TESTS !== "1",
        "Opt-in: requires access to quotes.toscrape.com.",
    );
    test.setTimeout(120000);
    await page.goto("/");
    await page.locator("#max_pages").selectOption("1");
    await page.getByRole("button", { name: /Iniciar extracción/ }).click();
    await expect(page).toHaveURL(/\/scrapes\/\d+$/);
    await expect(page.locator("#run-status")).toHaveText("Completado", {
        timeout: 90000,
    });
    await expect(page.locator(".results-table tbody tr")).toHaveCount(10);
    await expect(
        page.getByRole("link", { name: "↓ Captura PNG" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "↓ Traza ZIP" })).toBeVisible();
    const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("link", { name: "↓ JSON", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/scrapelab-\d+\.json/);
});
