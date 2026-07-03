/**
 * Web Search Extension
 *
 * Provides a web_search tool that queries the Brave Search API.
 *
 * Usage: Call the `web_search` tool with a query string.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";

interface BraveWebResult {
  title: string;
  description: string;
  url: string;
  page_rank: string;
  extra_snippets?: string[];
}

interface BraveNewsResult {
  title: string;
  url: string;
  description: string;
  age: string;
  extras?: Array<{ type: string; content: string }>;
}

function formatWebResults(results: BraveWebResult[]): string {
  if (results.length === 0) return "No results found.";

  const formatted = results.map((r, i) => {
    const snippet = r.extra_snippets?.[0] ?? r.description;
    return [
      `${i + 1}. ${r.title}`,
      `   URL: ${r.url}`,
      `   ${snippet}`,
      `   Rank: ${r.page_rank}`,
      "",
    ].join("\n");
  });

  return formatted.join("\n");
}

function formatNewsResults(results: BraveNewsResult[]): string {
  if (results.length === 0) return "No news results found.";

  const formatted = results.map((r, i) => {
    const extraText = r.extras
      ?.map((e) => `${e.type}: ${e.content}`)
      .join(", ");
    return [
      `${i + 1}. ${r.title}`,
      `   URL: ${r.url}`,
      `   ${r.description}`,
      `   Published: ${r.age}`,
      extraText ? `   ${extraText}` : "",
      "",
    ].join("\n");
  });

  return formatted.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Without an API key the tools can only ever return errors; registering them
  // just pollutes the tool list and tempts the model into dead-end calls.
  if (!BRAVE_API_KEY) return;

  // Web search tool
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Brave Search. Returns title, URL, description, and snippets for each result.",
    parameters: Type.Object({
      query: Type.String({
        description: "The search query. Be specific and concise.",
      }),
      count: Type.Optional(
        Type.Number({
          description:
            "Number of results to return (1-20, default: 10).",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const count = params.count ?? 10;

      if (!BRAVE_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Error: BRAVE_API_KEY environment variable is not set.",
            },
          ],
          isError: true,
        };
      }

      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(count));

      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": BRAVE_API_KEY,
        },
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [
            {
              type: "text",
              text: `Brave Search API error (${response.status}): ${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as {
        web?: {
          results: BraveWebResult[];
          total?: number;
        };
      };

      const results = data.web?.results ?? [];
      const total = data.web?.total;

      return {
        content: [
          {
            type: "text",
            text: `Found ${total ?? results.length} results for "${params.query}":\n\n${formatWebResults(results)}`,
          },
        ],
        details: {
          total: total ?? results.length,
          query: params.query,
        },
      };
    },
  });

  // News search tool
  pi.registerTool({
    name: "web_search_news",
    label: "News Search",
    description:
      "Search for recent news using Brave News Search API. Returns title, URL, description, and publication time.",
    parameters: Type.Object({
      query: Type.String({
        description: "The news search query.",
      }),
      count: Type.Optional(
        Type.Number({
          description:
            "Number of results to return (1-20, default: 10).",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const count = params.count ?? 10;

      if (!BRAVE_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Error: BRAVE_API_KEY environment variable is not set.",
            },
          ],
          isError: true,
        };
      }

      const url = new URL("https://api.search.brave.com/res/v1/news/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(count));

      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": BRAVE_API_KEY,
        },
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [
            {
              type: "text",
              text: `Brave News Search API error (${response.status}): ${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as {
        news?: {
          results: BraveNewsResult[];
          total?: number;
        };
      };

      const results = data.news?.results ?? [];
      const total = data.news?.total;

      return {
        content: [
          {
            type: "text",
            text: `Found ${total ?? results.length} news results for "${params.query}":\n\n${formatNewsResults(results)}`,
          },
        ],
        details: {
          total: total ?? results.length,
          query: params.query,
        },
      };
    },
  });
}
