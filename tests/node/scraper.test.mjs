import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scrape } from "../../scripts/scrape.mjs";

test("Chromium waits for JS content, paginates, resolves links and saves evidence", async () => {
    let privateRequests = 0;
    const privateServer = http.createServer((request, response) => {
        privateRequests++;
        response.end("<article>Private resource</article>");
    });
    await new Promise((resolve) =>
        privateServer.listen(4180, "127.0.0.1", resolve),
    );
    const server = http.createServer((request, response) => {
        if (request.url === "/redirect") {
            response
                .writeHead(302, { Location: "http://127.0.0.1:4180/private" })
                .end();
            return;
        }
        if (request.url === "/missing") {
            response.writeHead(404).end();
            return;
        }
        const second = request.url === "/page/2";
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Fixture</title><main></main><script>
      setTimeout(() => document.querySelector('main').innerHTML = '<article><h2>${second ? "Segundo" : "Primero"}</h2><a href="/book"> Detalle </a></article>${second ? "" : '<a class="next" href="/page/2">Next</a>'}', 200);
    </script>`);
    });
    await new Promise((resolve) => server.listen(4179, "127.0.0.1", resolve));
    const output = await mkdtemp(path.join(os.tmpdir(), "scrapelab-test-"));
    const recipe = {
        url: "http://127.0.0.1:4179",
        item_selector: "article",
        next_selector: ".next",
        max_pages: 2,
        fields: [
            { name: "title", selector: "h2" },
            { name: "link", selector: "a", attribute: "href" },
            { name: "missing", selector: ".missing" },
        ],
    };
    try {
        const result = await scrape(recipe, output, { allowFixture: true });
        assert.deepEqual(
            result.records.map((record) => record.data.title),
            ["Primero", "Segundo"],
        );
        assert.equal(result.records[0].data.link, "http://127.0.0.1:4179/book");
        assert.equal(result.records[0].data.missing, null);
        assert.equal(result.pages.length, 2);
        assert.ok((await stat(path.join(output, "screenshot.png"))).size > 0);
        assert.ok((await stat(path.join(output, "trace.zip"))).size > 0);
        await assert.rejects(
            scrape({ ...recipe, url: `${recipe.url}/missing` }, output, {
                allowFixture: true,
            }),
            /HTTP 404/,
        );
        await assert.rejects(
            scrape({ ...recipe, url: `${recipe.url}/redirect` }, output, {
                allowFixture: true,
            }),
            /puertos públicos|red privada/,
        );
        assert.equal(
            privateRequests,
            0,
            "Redirect must be blocked before reaching a private server",
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => privateServer.close(resolve));
        await rm(output, { recursive: true, force: true });
    }
});
