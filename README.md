# leo-redfin-mcp

Redfin real estate as a Leo package, over MCP — listings, property details,
walk scores, mortgage rates and local agents, from the Unofficial Redfin API on
RapidAPI.

The same integration as the compiled `leo-redfin` package, reachable as a
package the hub **installs at runtime** rather than one it has to be rebuilt
for.

## Tools

| Tool | Requires | Upstream |
|---|---|---|
| `search` | `location` | `auto-complete` then `properties/list` |
| `details` | `property_id` **or** `url` | `properties/get-info` |
| `walk_score` | `property_id` | `properties/get-walk-score` |
| `mortgage_rates` | — | `mortgage/check-rates` |
| `agents` | `location` | `agents/list` |

`search` is two hops on purpose: `properties/list` takes a Redfin *region URL*,
not a place name, so `auto-complete` resolves it first. If that returns nothing
usable you get "could not resolve that location", which is the true message —
not a crash five levels into a third-party shape.

`details` takes either an id or a listing URL; with a URL it reads the
`propertyId` (and `listingId`, when there is one) out of `get-info` first. Those
arrive as JSON numbers or strings depending on the endpoint, so both are
accepted — and neither is ever `String(undefined)`, which would travel as a
real-looking id and fetch the wrong house.

Responses are forwarded as the upstream JSON text, **unparsed**.

## Configuration

One setting, `redfin_rapidapi_key` — a [RapidAPI](https://rapidapi.com) key
subscribed to *Unofficial Redfin*. Leo hands it to this process under that key
**verbatim and lower-case**, so the descriptor's `settings_read` and
`process.env.redfin_rapidapi_key` have to agree or the credential silently
never arrives.

Without it the server still starts and lists its tools; every call answers with
the setting named and where to enter it.

## Development

```bash
npm install
node test.js        # no network needed
```

The test covers what fails *quietly*: digging a region URL five hops into a
third-party shape (every hop can be absent), ids that are numbers or strings,
and the `beds_min` -> `num_beds` rename — which, got wrong, returns an
unfiltered page that reads as a working search.

## Publishing

```bash
./store/publish.sh          # live
./store/publish.sh draft    # stage for review at admin.leoconnect.io
```

Needs a Cloudflare login with `D1:Edit` on the `leo-store` database. The script
refuses unless the pinned commit is both real and pushed — a SHA that resolves
nowhere installs cleanly and then fails on every hub at first launch.
