import { describe, expect, it } from "vitest";
import { renderPage } from "../src/web/page.ts";

describe("status page", () => {
  const html = renderPage({ token: 'to"ken</script>', nonce: "n0nce" });

  it("never inserts data as HTML", () => {
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("embeds the token as a JSON string and tags inline code with the nonce", () => {
    expect(html).toContain('var TOKEN = "to\\"ken\\u003c/script>";');
    expect(html.match(/<\/script>/g)).toHaveLength(1); // only the real closing tag
    expect(html).toContain('<script nonce="n0nce">');
    expect(html).toContain('<style nonce="n0nce">');
  });

  it("sends the token on every button call", () => {
    expect(html).toContain('headers: { "X-Proxy-Token": TOKEN }');
  });
});
