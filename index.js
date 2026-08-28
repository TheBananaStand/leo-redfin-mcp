#!/usr/bin/env node
//
// Leo real-estate package for Redfin, over MCP.
//
// The same Unofficial Redfin API integration as the compiled `leo-redfin`
// package, reachable as a package the hub installs at runtime instead of one it
// is rebuilt for. The upstream is a RapidAPI host, not Redfin's own, so the
// shapes are whatever it returns and they are forwarded unparsed — this server
// adds the key and the parameters and gets out of the way.
//
// As with `leo-zillow-mcp`, the compiled package's single `redfin` tool with an
// `action` enum becomes one tool per action: MCP names tools, so the schema can
// say `property_id` belongs to `walk_score` instead of prose having to.
//
// Plain JavaScript on purpose. This ships as a git tarball rather than an npm
// package, and npm does not reliably run build steps for a tarball URL.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const RAPIDAPI_HOST = "unofficial-redfin.p.rapidapi.com";

// Leo hands an entitled setting to the subprocess under its *settings key*,
// verbatim and lower-case — see `Entitlements::resolve_env_secrets`.
const SETTING_KEY = "redfin_rapidapi_key";

/**
 * Query values the upstream will accept, from what the model actually sends.
 * Absent stays absent — `URLSearchParams` renders `undefined` as the literal
 * text "undefined", which the host then honours as a filter.
 */
export function toQuery(pairs) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      params.set(key, String(value));
    } else if (typeof value === "string") {
      params.set(key, value);
    }
  }
  return params;
}

/**
 * An id that may arrive as a JSON number or a string.
 *
 * The upstream is inconsistent about this between endpoints — `propertyId` has
 * been seen both ways — and `String(undefined)` is `"undefined"`, which would
 * travel as a real-looking id and return somebody else's house.
 */
export function idText(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}

/**
 * Dig the region URL out of an `auto-complete` answer.
 *
 * `payload.sections[0].rows[0].url` — five hops into a third-party shape, any
 * of which can be absent for a location it simply doesn't know. Returning
 * `undefined` rather than throwing lets the caller say "could not resolve that
 * location", which is the true and useful message; a TypeError here would
 * surface as a crashed tool.
 */
export function regionUrlFrom(payload) {
  const rows = payload?.payload?.sections?.[0]?.rows;
  if (!Array.isArray(rows)) return undefined;
  const url = rows[0]?.url;
  return typeof url === "string" && url !== "" ? url : undefined;
}

/** `propertyId` / `listingId` out of a `properties/get-info` answer. */
export function idsFromInfo(payload) {
  return {
    propertyId: idText(payload?.payload?.propertyId),
    listingId: idText(payload?.payload?.listingId),
  };
}

function apiKey() {
  const key = process.env[SETTING_KEY] ?? "";
  if (!key) {
    throw new Error(
      `No ${SETTING_KEY} configured. Add it in Settings → Packages → Redfin.`,
    );
  }
  return key;
}

async function rapid(path, query) {
  const url = `https://${RAPIDAPI_HOST}/${path}?${query.toString()}`;
  const response = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": apiKey(),
      "X-RapidAPI-Host": RAPIDAPI_HOST,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Redfin API returned ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  return await response.text();
}

/** Same call, parsed — for the hops whose answer this server has to read. */
async function rapidJson(path, query) {
  const text = await rapid(path, query);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Redfin API did not return JSON for ${path}`);
  }
}

const TOOLS = {
  search: {
    description:
      "Search Redfin listings in an area, with optional price, bed and bath " +
      "filters. Resolves the location first, then queries listings.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City, ZIP code, or address." },
        price_min: { type: "string", description: "Minimum price." },
        price_max: { type: "string", description: "Maximum price." },
        beds_min: { type: "string", description: "Minimum bedrooms." },
        baths_min: { type: "string", description: "Minimum bathrooms." },
      },
      required: ["location"],
    },
    run: async (a) => {
      // Two hops, and the first is not optional: `properties/list` takes a
      // Redfin region URL, not a place name.
      const resolved = await rapidJson(
        "auto-complete",
        toQuery({ location: a.location }),
      );
      const url = regionUrlFrom(resolved);
      if (!url) {
        throw new Error(
          `Could not resolve "${a.location}" to a Redfin region.`,
        );
      }
      return await rapid(
        "properties/list",
        // The upstream's names, not ours: beds_min -> num_beds. A rename, so
        // getting it wrong returns unfiltered results rather than an error.
        toQuery({
          url,
          price_min: a.price_min,
          price_max: a.price_max,
          num_beds: a.beds_min,
          num_baths: a.baths_min,
        }),
      );
    },
  },

  details: {
    description:
      "Full detail for one property, by Redfin property id or by listing URL.",
    inputSchema: {
      type: "object",
      properties: {
        property_id: { type: "string", description: "Redfin property id." },
        url: {
          type: "string",
          description: "Redfin listing URL — an alternative to property_id.",
        },
      },
      // Neither alone is required; one of the two is. Enforced in `run`,
      // because JSON Schema `anyOf` is read unevenly by models and a wrong
      // refusal here is worse than a clear message.
      required: [],
    },
    run: async (a) => {
      let propertyId = idText(a.property_id);
      let listingId;

      if (!propertyId && typeof a.url === "string" && a.url !== "") {
        const info = await rapidJson("properties/get-info", toQuery({ url: a.url }));
        ({ propertyId, listingId } = idsFromInfo(info));
        if (!propertyId) {
          throw new Error("Could not read a propertyId from that URL.");
        }
      }
      if (!propertyId) {
        throw new Error("details requires property_id or url.");
      }
      return await rapid(
        "properties/get-info",
        toQuery({ propertyId, listingId }),
      );
    },
  },

  walk_score: {
    description: "Walk, transit and bike scores for a property.",
    inputSchema: {
      type: "object",
      properties: {
        property_id: { type: "string", description: "Redfin property id." },
      },
      required: ["property_id"],
    },
    run: (a) =>
      rapid(
        "properties/get-walk-score",
        toQuery({ propertyId: idText(a.property_id) }),
      ),
  },

  mortgage_rates: {
    description: "Current mortgage rates as Redfin reports them.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: () => rapid("mortgage/check-rates", toQuery({})),
  },

  agents: {
    description: "Real estate agents active in an area.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City, ZIP code, or address." },
      },
      required: ["location"],
    },
    run: (a) => rapid("agents/list", toQuery({ location: a.location })),
  },
};

export function missingRequired(name, args) {
  const required = TOOLS[name]?.inputSchema?.required ?? [];
  return required.filter((key) => {
    const v = args?.[key];
    return v === undefined || v === null || v === "";
  });
}

const server = new Server(
  { name: "leo-redfin-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS[name];
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  const missing = missingRequired(name, args);
  if (missing.length > 0) {
    return {
      isError: true,
      content: [{ type: "text", text: `${name} requires: ${missing.join(", ")}` }],
    };
  }
  try {
    return { content: [{ type: "text", text: await tool.run(args ?? {}) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: String(error?.message ?? error) }],
    };
  }
});

if (process.env.LEO_REDFIN_MCP_NO_SERVE !== "1") {
  await server.connect(new StdioServerTransport());
}
