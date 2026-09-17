"""Build the Miami Air 293 approach track + scene document from NTSB anchors.

Source: NTSB performance study DCA19MA143 (ADS-B + FDR). Distances are along
runway 10 measured from its displaced threshold; lateral offsets are feet right
of centreline (right = direction of travel). Runway geometry: OurAirports KNIP.
"""

import json
import math

FT = 0.3048
NM = 1852.0
GEOID_N = -30.5  # EGM96 geoid height near Jacksonville: h_ellipsoid = H_msl + N

# Runway 10/28 thresholds (OurAirports KNIP).
A = (30.23159981, -81.69300079)   # rwy 10 physical threshold
B = (30.23170090, -81.66439819)   # rwy 28 threshold
DISPLACED_FT = 1000.0             # rwy 10 displaced threshold distance
FIELD_MSL_FT = 20.0               # runway elevation near the touchdown zone

lat0 = math.radians(A[0])
m_per_deg_lat = 111132.0
m_per_deg_lon = 111320.0 * math.cos(lat0)


def to_en(lat, lon):
    return ((lon - A[1]) * m_per_deg_lon, (lat - A[0]) * m_per_deg_lat)


def to_ll(e, n):
    return (A[0] + n / m_per_deg_lat, A[1] + e / m_per_deg_lon)


# Along-track unit vector (runway 10 heading) and the "right" unit vector.
be, bn = to_en(*B)
blen = math.hypot(be, bn)
ue, un = be / blen, bn / blen           # along runway 10
re, rn = un, -ue                        # 90 deg right of travel
runway_bearing = (math.degrees(math.atan2(ue, un)) + 360) % 360

# Displaced threshold origin for the report's distances.
dte = ue * DISPLACED_FT * FT
dtn = un * DISPLACED_FT * FT


def point(dist_past_dt_ft, right_ft, msl_ft):
    """Position at a given distance past the displaced threshold + lateral offset."""
    d = dist_past_dt_ft * FT
    r = right_ft * FT
    e = dte + ue * d + re * r
    n = dtn + un * d + rn * r
    lat, lon = to_ll(e, n)
    return {"lat": round(lat, 7), "lon": round(lon, 7),
            "altEllipsoidM": round(msl_ft * FT + GEOID_N, 1),
            "mslFt": msl_ft}


# NTSB anchor points (time, dist past DT ft, right ft, MSL ft, roll deg, note).
# Negative distance = before the displaced threshold.
ANCHORS = [
    ("21:40:25", -3.5 * NM / FT, 100, 1400, 0, "3.5 nm final, ~1400 ft, above glidepath"),
    ("21:41:17", -1.0 * NM / FT, 150, 620, 12, "1 nm, roll 12 deg right"),
    ("21:41:28", -0.5 * NM / FT, 220, 360, 6, "0.5 nm, 220 ft right of centreline"),
    ("21:41:38", 0, 100, 140, -9, "crosses displaced threshold, 140 ft MSL, 170 kt"),
    ("21:41:43", 1580, 20, FIELD_MSL_FT, 0, "touchdown, track 87 deg"),
    ("21:41:50", 3650, 0, FIELD_MSL_FT, 0, "crosses centreline left to right"),
    ("21:42:01", 6300, 74, FIELD_MSL_FT, 0, "max 74 ft right of centreline"),
    ("21:42:10", 8006, 55, FIELD_MSL_FT, 0, "crosses end of runway 10"),
    ("21:42:19", 9170, 90, 8, "seawall impact into St Johns River"),
]

track = []
for a in ANCHORS:
    t, dist, right, msl = a[0], a[1], a[2], a[3]
    roll = a[4] if len(a) > 5 else 0
    note = a[-1]
    p = point(dist, right, msl)
    p.update({"time": t, "rollDeg": roll, "note": note})
    track.append(p)

# Pitch from geometry between successive points (descent angle).
for i, p in enumerate(track):
    if i + 1 < len(track):
        a, b = track[i], track[i + 1]
        de = (b["lon"] - a["lon"]) * m_per_deg_lon
        dn = (b["lat"] - a["lat"]) * m_per_deg_lat
        dh = (b["altEllipsoidM"] - a["altEllipsoidM"])
        horiz = math.hypot(de, dn)
        p["headingDeg"] = round((math.degrees(math.atan2(de, dn)) + 360) % 360, 1)
        p["pitchDeg"] = round(math.degrees(math.atan2(dh, horiz)), 1) if horiz else 0
    else:
        p["headingDeg"] = track[i - 1]["headingDeg"]
        p["pitchDeg"] = 0

print(f"runway 10 bearing (computed): {runway_bearing:.2f} deg (report: 89.65)")
for p in track:
    print(f'  {p["time"]}  {p["lat"]:.5f},{p["lon"]:.5f}  {p["mslFt"]:>5} ftMSL  '
          f'hdg {p["headingDeg"]:>5}  pitch {p["pitchDeg"]:>5}  roll {p["rollDeg"]:>4}  {p["note"]}')

# --- GeoJSON data pack: ground track line + labelled markers ---
line = {
    "type": "Feature",
    "id": "approach-track",
    "properties": {
        "name": "Miami Air 293 final approach and overrun",
        "flight": "N732MA / GL293",
        "date": "2019-05-03",
        "source": "NTSB performance study DCA19MA143 (ADS-B + FDR)",
    },
    "geometry": {"type": "LineString",
                 "coordinates": [[p["lon"], p["lat"], p["mslFt"] * FT] for p in track]},
}
markers = []
for i, p in enumerate(track):
    markers.append({
        "type": "Feature",
        "id": f"pt-{i:02d}",
        "properties": {"time": p["time"], "label": p["note"],
                       "altitudeFtMsl": p["mslFt"]},
        "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
    })
geojson = {"type": "FeatureCollection",
           "attribution": {
               "text": "NTSB source data (DCA19MA143 performance study)",
               "license": "US Government work, public domain",
           },
           "features": [line] + markers}

with open("approach.geojson", "w", encoding="utf-8", newline="\n") as f:
    json.dump(geojson, f, indent=2)
print("\nwrote approach.geojson")

# --- Scene document (v5) : cinematic approach ride-along ---
def hms(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)

shots = []
# Establishing shot: high, west of the field, looking east down the approach.
est = point(-4.2 * NM / FT, 0, 4200)
shots.append({
    "id": "establish", "title": "Approach into Jacksonville",
    "durationSec": 5, "holdSec": 1.5,
    "camera": {"lat": est["lat"], "lon": est["lon"],
               "alt": est["altEllipsoidM"], "heading": 90, "pitch": -8, "roll": 0},
    "visual": {"style": "normal"}, "dataPackIds": ["approach"],
})
prev_t = hms(track[0]["time"])
for i, p in enumerate(track):
    t = hms(p["time"])
    dur = max(2, min(8, t - prev_t)) if i else 4
    prev_t = t
    shots.append({
        "id": f"t{p['time'].replace(':','')}", "title": f'{p["time"]}  {p["note"]}',
        "durationSec": dur, "holdSec": 1.2 if i in (0, len(track) - 1) else 0.3,
        "camera": {"lat": p["lat"], "lon": p["lon"],
                   "alt": round(p["altEllipsoidM"] + 3, 1),
                   "heading": p["headingDeg"], "pitch": p["pitchDeg"],
                   "roll": p["rollDeg"]},
        "visual": {"style": "normal"}, "dataPackIds": ["approach"],
    })
# Final wide hold on the resting point in the river.
rest = track[-1]
shots.append({
    "id": "rest", "title": "Came to rest in the St Johns River",
    "durationSec": 5, "holdSec": 3,
    "camera": {"lat": rest["lat"] - 0.006, "lon": rest["lon"] + 0.004,
               "alt": 260, "heading": 300, "pitch": -30, "roll": 0},
    "visual": {"style": "normal"}, "dataPackIds": ["approach"],
})

scene_doc = {
    "version": 5,
    "scenes": [{
        "id": "miami-air-293",
        "title": "Miami Air 293 - Runway Overrun (KNIP, 3 May 2019)",
        "dataPacks": [{
            "id": "approach", "version": 1, "format": "geojson",
            "source": {"adapter": "assets", "path": "miami-air-293/approach.geojson"},
            "attribution": {
                "text": "NTSB performance study DCA19MA143 (ADS-B + FDR)",
                "license": "US Government work, public domain",
            },
            "placement": {"altitudeReference": "ellipsoid"},
        }],
        "shots": shots,
    }],
}
with open("miami-air-293.scene.json", "w", encoding="utf-8", newline="\n") as f:
    json.dump(scene_doc, f, indent=2)
print(f"wrote miami-air-293.scene.json  ({len(shots)} shots)")
