import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  kickoffUtc,
  outlookAtPoint,
  parseCpcOutlookKml,
  pointInPolygon,
  summarizeMetCompact,
  summarizeNwsHourly,
  validateVenueClimate,
} from "../scripts/lib/environment.mjs";

test("venue climate seed contains every 2026 venue with bounded normals", async () => {
  const payload = JSON.parse(await fs.readFile(new URL("../docs/venue-climate.json", import.meta.url), "utf8"));
  assert.equal(validateVenueClimate(payload).venues.length, 38);
});

test("CPC KML remains a categorical outlook with a valid polygon lookup", () => {
  const kml = `
    <kml><Document><name>8-14 Day Temperature Outlook - Created: 08/26/2026 - Valid: 09/03/2026 - 09/09/2026</name>
      <Placemark><name>50% Chance of Above Normal Temperature</name><description><![CDATA[
        <table><tr><td>Probability</td><td>50</td></tr><tr><td>Category</td><td>Above</td></tr></table>
      ]]></description><Polygon><outerBoundaryIs><LinearRing><coordinates>-125,24,0 -66,24,0 -66,50,0 -125,50,0 -125,24,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>`;
  const outlook = parseCpcOutlookKml(kml, { id: "test-cpc", horizon: "8-14 day", dimension: "temperature" });
  assert.equal(outlook.issuedDate, "2026-08-26");
  assert.deepEqual(outlookAtPoint(outlook, 41.8, -87.6), { category: "above-normal", probability: 50 });
  assert.equal(pointInPolygon(-87.6, 41.8, outlook.features[0].polygons[0]), true);
});

test("future schedule kickoff times convert from published Eastern time across DST", () => {
  assert.equal(kickoffUtc("2026-09-09", "20:20"), "2026-09-10T00:20:00.000Z");
  assert.equal(kickoffUtc("2026-11-08", "20:20"), "2026-11-09T01:20:00.000Z");
});

test("NWS and MET adapters summarize only the bounded game window", () => {
  const nws = summarizeNwsHourly({ properties: { updateTime: "2026-09-09T12:00:00Z", periods: [
    { startTime: "2026-09-10T00:00:00Z", endTime: "2026-09-10T01:00:00Z", temperature: 60, temperatureUnit: "F", windSpeed: "8 to 12 mph", probabilityOfPrecipitation: { value: 30 }, shortForecast: "Chance Rain" },
    { startTime: "2026-09-10T01:00:00Z", endTime: "2026-09-10T02:00:00Z", temperature: 58, temperatureUnit: "F", windSpeed: "10 mph", probabilityOfPrecipitation: { value: 40 }, shortForecast: "Rain" },
  ] } }, { gameId: "game", kickoff: "2026-09-10T00:20:00Z" });
  assert.equal(nws.temperatureF, 59);
  assert.equal(nws.windMph, 12);
  assert.equal(nws.precipitationProbability, 40);

  const met = summarizeMetCompact({ properties: { meta: { updated_at: "2026-09-09T12:00:00Z" }, timeseries: [
    { time: "2026-09-10T00:00:00Z", data: { instant: { details: { air_temperature: 10, wind_speed: 5 } }, next_1_hours: { details: { precipitation_amount: 1.2, probability_of_precipitation: 60 }, summary: { symbol_code: "rain" } } } },
  ] } }, { gameId: "game", kickoff: "2026-09-10T00:20:00Z" });
  assert.equal(met.temperatureF, 50);
  assert.equal(met.precipitationMm, 1.2);
  assert.equal(met.precipitationProbability, 60);
});
