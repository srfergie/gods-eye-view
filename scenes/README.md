# Scene documents

Importable God's Eye View scene documents (v5 format, see
[docs/SCENE-DOCUMENT.md](../docs/SCENE-DOCUMENT.md)).

## Miami Air 293 - Runway Overrun (KNIP, 3 May 2019)

A cinematic reconstruction of the final approach and runway overrun of Miami
Air International flight 293 (Boeing 737-800, N732MA) at Jacksonville Naval Air
Station. All 143 occupants survived.

This ships as a **built-in scene** (recipe `miami-air-293` in
`src/scenes/recipes.js`): it appears in the SCENES dropdown automatically and
installs itself into existing saved projects. The scene document below is the
same choreography as a portable, importable copy.

- **Scene:** `miami-air-293.scene.json` - 11 shots from a wide approach view
  down to touchdown and the overrun into the St Johns River.
- **Data pack:** `public/scene-assets/miami-air-293/approach.geojson` - the
  flight ground track and labelled event markers.
- **Source:** NTSB performance study DCA19MA143 (ADS-B fused with flight data
  recorder attitude). US Government work, public domain.
- **Provenance:** `scripts/build-miami-air-293-track.py` derives the trajectory
  from the report's along-runway distances and KNIP runway geometry.

### How to use

1. Run the app (`npm run dev`) so `public/scene-assets/` is served.
2. Open the **SCENES** panel and click **IMPORT**.
3. Choose `scenes/miami-air-293.scene.json`.
4. Select the scene and press **START**, or use LOAD on an individual shot.

Importing replaces the current in-memory scene project; it does not overwrite
any saved work unless you save afterwards.
