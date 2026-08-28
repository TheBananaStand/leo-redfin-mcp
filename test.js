// Smoke test for the parts of this server that fail quietly.
//
// The network is RapidAPI's to get right. Ours is the digging: a region URL
// five hops into a third-party shape, ids that arrive as numbers or strings,
// and a parameter rename. None of those throw when wrong — they return
// somebody else's house, or an unfiltered page that looks like a working
// search. So that is what is checked here.
//
//   node test.js

process.env.LEO_REDFIN_MCP_NO_SERVE = "1";

const { toQuery, idText, regionUrlFrom, idsFromInfo, missingRequired } =
  await import("./index.js");
const assert = await import("node:assert/strict");

// ── the region URL, five hops down ──────────────────────────────────────────
{
  const good = {
    payload: { sections: [{ rows: [{ url: "/city/30749/CA/San-Francisco" }] }] },
  };
  assert.equal(regionUrlFrom(good), "/city/30749/CA/San-Francisco");
}

// Every hop can be absent for a location the host doesn't know. Each must be
// `undefined` — not a throw, because the caller turns it into "could not
// resolve that location", which is the true and useful message.
for (const junk of [
  undefined,
  null,
  {},
  { payload: {} },
  { payload: { sections: [] } },
  { payload: { sections: [{}] } },
  { payload: { sections: [{ rows: [] }] } },
  { payload: { sections: [{ rows: [{}] }] } },
  { payload: { sections: [{ rows: [{ url: "" }] }] } },
  { payload: { sections: "nope" } },
]) {
  assert.equal(regionUrlFrom(junk), undefined, `should not resolve: ${JSON.stringify(junk)}`);
}

// ── ids that are numbers OR strings ─────────────────────────────────────────
{
  assert.equal(idText(12345), "12345");
  assert.equal(idText("12345"), "12345");
  // The whole point: String(undefined) is "undefined", which would travel as a
  // real-looking id and fetch the wrong property.
  assert.equal(idText(undefined), undefined);
  assert.equal(idText(null), undefined);
  assert.equal(idText(""), undefined);
  assert.equal(idText(Number.NaN), undefined);
  assert.equal(idText({}), undefined);
}

{
  const info = { payload: { propertyId: 987, listingId: "L-1" } };
  assert.deepEqual(idsFromInfo(info), { propertyId: "987", listingId: "L-1" });

  // A property with no listing is normal (sold, off-market): propertyId
  // survives, listingId is absent and must not become "undefined".
  const noListing = { payload: { propertyId: "77" } };
  assert.deepEqual(idsFromInfo(noListing), {
    propertyId: "77",
    listingId: undefined,
  });

  assert.deepEqual(idsFromInfo({}), {
    propertyId: undefined,
    listingId: undefined,
  });
}

// ── the rename, and absent-stays-absent ─────────────────────────────────────
{
  // beds_min -> num_beds is the upstream's spelling, not ours. Getting it wrong
  // returns an unfiltered page that reads as a working search.
  const q = toQuery({
    url: "/city/1",
    num_beds: "3",
    num_baths: undefined,
    price_max: 900000,
  });
  assert.equal(q.get("num_beds"), "3");
  assert.equal(q.get("price_max"), "900000");
  assert.equal(q.has("num_baths"), false, "absent must stay absent");
  assert.equal(q.has("beds_min"), false, "our name must never reach the wire");
}

// A listingId that is absent must not appear as the text "undefined".
{
  const q = toQuery({ propertyId: "77", listingId: undefined });
  assert.equal(q.toString(), "propertyId=77");
}

// ── per-tool required params ────────────────────────────────────────────────
{
  assert.deepEqual(missingRequired("search", {}), ["location"]);
  assert.deepEqual(missingRequired("walk_score", {}), ["property_id"]);
  assert.deepEqual(missingRequired("agents", { location: "" }), ["location"]);
  // mortgage_rates takes nothing at all.
  assert.deepEqual(missingRequired("mortgage_rates", {}), []);
  // `details` needs property_id OR url, which a required list cannot express —
  // it is enforced in run(), so the schema must ask for neither.
  assert.deepEqual(missingRequired("details", {}), []);
}

console.log("ok — digging, ids and the rename hold");
